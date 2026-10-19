/**
 * GcmService — the single application API used by the CLI, the MCP server and the dashboard.
 *
 * Responsibilities: validation, access control (per-bot scopes), orchestration of import → analyze →
 * checkpoint → handoff, integrity verification, caching (no repeated work for unchanged input), and an
 * operations log that records GCM's own overhead without storing conversation content.
 */
import { CAPABILITIES } from './capabilities';
import { diffCheckpoints, type CheckpointDiff } from './checkpoint/diff';
import { renderCheckpointMarkdown, renderHandoff, type HandoffMeta } from './checkpoint/render';
import {
  botProfileHash,
  combineCompleteness,
  compact,
  fitToBudget,
  type CompactResult,
} from './engine/compact';
import { validateCheckpoint, type ValidationReport } from './engine/validate';
import { GcmError } from './errors';
import { parseConversation } from './import/parse';
import {
  APP_VERSION,
  BotPatchSchema,
  BotPolicySchema,
  CheckpointExportSchema,
  ENGINE_VERSION,
  ImportInputSchema,
  SCHEMA_VERSION,
  SettingsSchema,
  UsageInputSchema,
  type AccessContext,
  type BotPatch,
  type BotProfile,
  type CheckpointContent,
  type CheckpointRecord,
  type Completeness,
  type HandoffRecord,
  type HandoffState,
  type ImportInput,
  type ImportRecord,
  type PlatformAction,
  type ProfileName,
  type Settings,
  type StoredMessage,
  type UsageInput,
  type UsageRecord,
} from './schemas';
import { containsSecret, redactSecrets } from './security/redact';
import type { ArchiveHit, OperationRecord, Page, Paged, Store } from './store';
import {
  deterministicProvider,
  OllamaProvider,
  type ProviderStatus,
  type SummarizerProvider,
} from './summarization/providers';
import {
  countTokens,
  effectiveMethod,
  reductionPercent,
  type TokenMethod,
} from './tokens/estimate';
import { hashObject, newId, sha256, shortCode } from './util/hash';
import {
  canTransition,
  platformGuide,
  STATE_DESCRIPTIONS,
  verifyContinuation,
  type ContinuationResult,
  type PlatformActionGuide,
} from './workflow';

export interface ServiceOptions {
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface CheckpointParams {
  botId: string;
  /** Explicit import IDs. Default: imports not yet covered by any checkpoint of this bot. */
  importIds?: string[];
  /** Ignore the previous checkpoint and rebuild from every import of this bot. */
  rebuild?: boolean;
  profile?: ProfileName;
  budgetTokens?: number;
  objective?: string | null;
  workstream?: string | null;
  sessionRef?: string | null;
}

export interface AnalysisPreview {
  botId: string;
  previousCheckpointId: string | null;
  importIds: string[];
  result: CompactResult;
  validation: ValidationReport;
  handoffPreview: string;
  cacheHit: boolean;
  profile: ProfileName;
  budgetTokens: number;
}

export interface IntegrityReport {
  checkpointId: string;
  checkpointOk: boolean;
  archiveOk: boolean;
  missingImports: string[];
  corruptedImports: string[];
  details: string[];
}

export interface BotSummary {
  id: string;
  name: string;
  role: string;
  imports: number;
  messages: number;
  archiveTokensEstimate: number;
  uncheckpointedImports: number;
  headCheckpoint: {
    id: string;
    version: number;
    reviewStatus: string;
    tokens: number;
    createdAt: string;
  } | null;
  activeHandoffs: number;
  warnings: string[];
}

export interface UsageReport {
  botId: string;
  estimates: {
    kind: 'estimated';
    method: TokenMethod;
    importedChars: number;
    importedTokens: number;
    checkpointTokens: number | null;
    handoffTokens: number | null;
    estimatedTextReductionPercent: number | null;
  };
  coverage: Completeness;
  partial: boolean;
  measured: UsageRecord[];
  billing: UsageRecord[];
  platformComparison: {
    status: 'not_measured' | 'user_measured_unverified';
    before: UsageRecord | null;
    after: UsageRecord | null;
    inputTokenChangePercent: number | null;
  };
  gcmOverhead: {
    operations: number;
    durationMs: number;
    localModelTokens: number;
    mcpResponseTokensEstimated: number;
  };
  limitations: string[];
}

const ACTIVE_STATES: HandoffState[] = [
  'HANDOFF_READY',
  'USER_ACTION_REQUIRED',
  'EXTERNAL_RESET_UNVERIFIED',
  'FAILED_RECOVERABLE',
];

export class GcmService {
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly store: Store,
    opts: ServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  settings(): Settings {
    const parsed = SettingsSchema.safeParse(this.store.getSettings());
    return parsed.success ? parsed.data : SettingsSchema.parse({});
  }

  updateSettings(patch: Record<string, unknown>, ctx: AccessContext): Settings {
    this.requireLocal(ctx, 'change settings');
    const next = SettingsSchema.safeParse({ ...this.settings(), ...patch });
    if (!next.success)
      throw new GcmError(
        'VALIDATION',
        `Invalid setting: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    for (const [k, v] of Object.entries(next.data)) this.store.setSetting(k, v);
    return next.data;
  }

  provider(): SummarizerProvider {
    const s = this.settings();
    if (s.summarizer === 'ollama')
      return new OllamaProvider(s.ollamaUrl, s.ollamaModel, s.ollamaTimeoutMs, this.fetchImpl);
    return deterministicProvider;
  }

  async providerStatus(): Promise<{
    id: string;
    label: string;
    local: boolean;
    status: ProviderStatus;
  }> {
    const p = this.provider();
    return { id: p.id, label: p.label, local: p.local, status: await p.status() };
  }

  // -------------------------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------------------------

  canRead(ctx: AccessContext, bot: BotProfile): boolean {
    if (ctx.channel === 'mcp' && !bot.policy.mcpExposed) return false;
    if (ctx.bots === '*' || ctx.bots.includes(bot.id)) return true;
    return Boolean(ctx.actorBotId && bot.policy.shareWith.includes(ctx.actorBotId));
  }

  private readableBot(botId: string, ctx: AccessContext): BotProfile {
    const bot = this.store.getBot(botId);
    if (!bot || !this.canRead(ctx, bot)) {
      throw new GcmError(
        'NOT_FOUND',
        `Bot "${botId}" not found or not accessible.`,
        'Run `grokcm bots list` to see registered bots.',
      );
    }
    return bot;
  }

  private writableBot(botId: string, ctx: AccessContext): BotProfile {
    const bot = this.readableBot(botId, ctx);
    if (!ctx.canWrite) throw new GcmError('FORBIDDEN', 'This access token is read-only.');
    if (ctx.bots !== '*' && !ctx.bots.includes(botId)) {
      throw new GcmError(
        'FORBIDDEN',
        `Write access to bot "${botId}" is not granted (shared access is read-only).`,
      );
    }
    return bot;
  }

  private requireLocal(ctx: AccessContext, what: string): void {
    if (ctx.channel === 'mcp')
      throw new GcmError(
        'FORBIDDEN',
        `MCP clients cannot ${what}; use the local CLI or dashboard.`,
      );
  }

  private log(op: Omit<OperationRecord, 'id' | 'at'>): void {
    try {
      this.store.logOperation({ ...op, id: newId('op'), at: this.iso() });
    } catch {
      /* the operations log must never break a user operation */
    }
  }

  private async timed<T>(
    op: string,
    ctx: AccessContext,
    botId: string | null,
    fn: () => Promise<T> | T,
    modelTokens = () => 0,
  ): Promise<T> {
    const start = performance.now();
    try {
      const value = await fn();
      this.log({
        op,
        channel: ctx.channel,
        botId,
        durationMs: Math.round(performance.now() - start),
        ok: true,
        detail: '',
        modelTokens: modelTokens(),
        responseTokens: 0,
      });
      return value;
    } catch (e) {
      const code = e instanceof GcmError ? e.code : 'INTERNAL';
      this.log({
        op,
        channel: ctx.channel,
        botId,
        durationMs: Math.round(performance.now() - start),
        ok: false,
        detail: code,
        modelTokens: 0,
        responseTokens: 0,
      });
      throw e;
    }
  }

  /** Called by the MCP layer: records how many (estimated) tokens a tool response put into the client's context. */
  recordResponseSize(op: string, botId: string | null, responseTokens: number): void {
    this.log({
      op: `mcp:${op}`,
      channel: 'mcp',
      botId,
      durationMs: 0,
      ok: true,
      detail: 'response-size',
      modelTokens: 0,
      responseTokens,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------------------------

  listBots(ctx: AccessContext): BotSummary[] {
    return this.store
      .listBots()
      .filter((b) => this.canRead(ctx, b))
      .map((b) => this.summarizeBot(b));
  }

  private summarizeBot(b: BotProfile): BotSummary {
    const stats = this.store.archiveStats(b.id);
    const head = this.store.headCheckpoint(b.id);
    const covered = this.store.coveredImportIds(b.id);
    const imports = this.store.listImports(b.id, { limit: 10_000, offset: 0 }).items;
    const uncovered = imports.filter((i) => !covered.has(i.id));
    const uncoveredTokens = uncovered.reduce((n, i) => n + i.tokenEstimate, 0);
    const handoffs = this.store.listHandoffs(b.id, { limit: 200, offset: 0 }).items;
    const warnings: string[] = [];
    if (uncoveredTokens > b.policy.warnThresholdTokens) {
      warnings.push(
        `~${uncoveredTokens} estimated tokens imported since the last checkpoint (threshold ${b.policy.warnThresholdTokens}).`,
      );
    }
    if (head && head.reviewStatus !== 'reviewed')
      warnings.push(`Latest checkpoint v${head.version} is not reviewed.`);
    if (head && head.content.conflicts.length)
      warnings.push(
        `Latest checkpoint has ${head.content.conflicts.length} conflict(s) to confirm.`,
      );
    return {
      id: b.id,
      name: b.name,
      role: b.role,
      imports: stats.imports,
      messages: stats.messages,
      archiveTokensEstimate: stats.tokens,
      uncheckpointedImports: uncovered.length,
      headCheckpoint: head
        ? {
            id: head.id,
            version: head.version,
            reviewStatus: head.reviewStatus,
            tokens: head.tokenEstimate.tokens,
            createdAt: head.createdAt,
          }
        : null,
      activeHandoffs: handoffs.filter((h) => ACTIVE_STATES.includes(h.state)).length,
      warnings,
    };
  }

  getBot(botId: string, ctx: AccessContext): BotProfile {
    return this.readableBot(botId, ctx);
  }

  upsertBot(
    input: BotPatch,
    ctx: AccessContext,
    opts: { dryRun?: boolean } = {},
  ): { bot: BotProfile; created: boolean } {
    const parsed = BotPatchSchema.safeParse(input);
    if (!parsed.success) throw new GcmError('VALIDATION', formatZod(parsed.error));
    const patch = parsed.data;
    if (!ctx.canWrite) throw new GcmError('FORBIDDEN', 'This access token is read-only.');
    const existing = this.store.getBot(patch.id);
    if (existing && !this.canRead(ctx, existing))
      throw new GcmError('NOT_FOUND', `Bot "${patch.id}" not found or not accessible.`);
    if (existing) this.writableBot(patch.id, ctx);
    else if (ctx.bots !== '*' && !ctx.bots.includes(patch.id)) {
      throw new GcmError('FORBIDDEN', `This token may not create bot "${patch.id}".`);
    }
    const now = this.iso();
    const { policy: policyPatch, ...fields } = patch;
    const base: BotProfile = existing ?? {
      id: patch.id,
      name: patch.name ?? patch.id,
      role: '',
      responsibilities: [],
      instructions: [],
      preferences: [],
      securityBoundaries: [],
      longTermDecisions: [],
      skills: [],
      plugins: [],
      routines: [],
      projects: [],
      memoryReferences: [],
      notes: '',
      identitySource: 'user_provided',
      policy: BotPolicySchema.parse({}),
      createdAt: now,
      updatedAt: now,
    };
    const definedFields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );
    const bot: BotProfile = {
      ...base,
      ...definedFields,
      policy: BotPolicySchema.parse({ ...base.policy, ...(policyPatch ?? {}) }),
      updatedAt: now,
    };
    if (bot.policy.shareWith.includes(bot.id))
      bot.policy.shareWith = bot.policy.shareWith.filter((x) => x !== bot.id);
    if (!opts.dryRun) this.store.saveBot(bot);
    this.log({
      op: existing ? 'bot.update' : 'bot.create',
      channel: ctx.channel,
      botId: bot.id,
      durationMs: 0,
      ok: true,
      detail: opts.dryRun ? 'dry-run' : '',
      modelTokens: 0,
      responseTokens: 0,
    });
    return { bot, created: !existing };
  }

  // -------------------------------------------------------------------------------------------
  // Import (archive)
  // -------------------------------------------------------------------------------------------

  importContext(
    input: ImportInput,
    ctx: AccessContext,
    opts: { dryRun?: boolean } = {},
  ): {
    import: ImportRecord | null;
    format: string;
    parsedMessages: number;
    added: number;
    duplicatesSkipped: number;
    warnings: string[];
  } {
    const parsed = ImportInputSchema.safeParse(input);
    if (!parsed.success) throw new GcmError('VALIDATION', formatZod(parsed.error));
    const data = parsed.data;
    const bot = this.writableBot(data.botId, ctx);
    const start = performance.now();

    let result;
    try {
      result = parseConversation(data.text, data.format, {
        assistantNames: [bot.name, bot.id, ...data.assistantNames],
        userNames: data.userNames,
      });
    } catch (e) {
      throw new GcmError('VALIDATION', (e as Error).message);
    }
    const warnings = [...result.warnings];
    let completeness = data.completeness;
    if (completeness === 'complete' && result.truncationSuspected) {
      completeness = 'partial';
      warnings.push(
        'Marked as partial: the material shows signs of truncation, so it cannot be labelled complete.',
      );
    }

    // Incremental import: skip the leading run of messages already stored for this session (re-pasting a
    // conversation with new messages appended). Everything after the overlap is kept, including repeats.
    const remaining = this.store.messageHashCounts(data.botId, data.sessionRef);
    const importId = newId('imp');
    const messages: StoredMessage[] = [];
    let duplicatesSkipped = 0;
    let inOverlap = true;
    for (const m of result.messages) {
      const contentHash = sha256(`${m.role}\n${m.content}`);
      const left = remaining.get(contentHash) ?? 0;
      if (inOverlap && left > 0) {
        remaining.set(contentHash, left - 1);
        duplicatesSkipped++;
        continue;
      }
      inOverlap = false;
      messages.push({
        ...m,
        id: newId('msg'),
        importId,
        botId: data.botId,
        seq: messages.length + 1,
        contentHash,
      });
    }
    if (duplicatesSkipped) {
      warnings.push(
        `${duplicatesSkipped} leading message(s) already in the archive for this session were skipped (incremental import).`,
      );
    }

    if (messages.length === 0) {
      this.log({
        op: 'import',
        channel: ctx.channel,
        botId: data.botId,
        durationMs: Math.round(performance.now() - start),
        ok: true,
        detail: 'nothing-new',
        modelTokens: 0,
        responseTokens: 0,
      });
      return {
        import: null,
        format: result.format,
        parsedMessages: result.messages.length,
        added: 0,
        duplicatesSkipped,
        warnings: [...warnings, 'Nothing new to import.'],
      };
    }

    const method = effectiveMethod(this.settings().tokenMethod);
    const record: ImportRecord = {
      id: importId,
      botId: data.botId,
      sessionRef: data.sessionRef,
      sourceFormat: result.format,
      sourceName: data.sourceName,
      importedAt: this.iso(),
      completeness,
      completenessNote: data.completenessNote,
      messageCount: messages.length,
      charCount: messages.reduce((n, m) => n + m.content.length, 0),
      tokenEstimate: messages.reduce((n, m) => n + countTokens(m.content, method), 0),
      contentHash: importHash(messages),
      duplicatesSkipped,
      warnings,
    };
    if (!opts.dryRun) this.store.insertImport(record, messages);
    this.log({
      op: 'import',
      channel: ctx.channel,
      botId: data.botId,
      durationMs: Math.round(performance.now() - start),
      ok: true,
      detail: `${messages.length} messages${opts.dryRun ? ' (dry-run)' : ''}`,
      modelTokens: 0,
      responseTokens: 0,
    });
    return {
      import: opts.dryRun ? null : record,
      format: result.format,
      parsedMessages: result.messages.length,
      added: messages.length,
      duplicatesSkipped,
      warnings,
    };
  }

  listImports(botId: string, ctx: AccessContext, page: Page): Paged<ImportRecord> {
    this.readableBot(botId, ctx);
    return this.store.listImports(botId, page);
  }

  // -------------------------------------------------------------------------------------------
  // Analyze & checkpoint
  // -------------------------------------------------------------------------------------------

  private resolveSources(params: CheckpointParams): {
    previous: CheckpointRecord | null;
    imports: ImportRecord[];
  } {
    const previous = params.rebuild ? null : this.store.headCheckpoint(params.botId);
    let imports: ImportRecord[];
    if (params.importIds?.length) {
      imports = params.importIds.map((id) => {
        const rec = this.store.getImport(id);
        // Cross-bot isolation: an import ID from another bot is reported as not found.
        if (!rec || rec.botId !== params.botId)
          throw new GcmError('NOT_FOUND', `Import "${id}" not found for bot "${params.botId}".`);
        return rec;
      });
    } else {
      const all = this.store.listImports(params.botId, { limit: 100_000, offset: 0 }).items;
      const covered = params.rebuild
        ? new Set<string>()
        : this.store.coveredImportIds(params.botId);
      imports = all.filter((i) => !covered.has(i.id));
    }
    imports.sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id));
    return { previous, imports };
  }

  private budgetFor(bot: BotProfile, profile: ProfileName, explicit?: number): number {
    if (explicit) return explicit;
    if (bot.policy.handoffBudgetTokens && profile === bot.policy.profile)
      return bot.policy.handoffBudgetTokens;
    return this.settings().budgets[profile];
  }

  analyze(params: CheckpointParams, ctx: AccessContext): AnalysisPreview {
    const bot = this.readableBot(params.botId, ctx);
    const settings = this.settings();
    const profile = params.profile ?? bot.policy.profile ?? settings.defaultProfile;
    const budgetTokens = this.budgetFor(bot, profile, params.budgetTokens);
    const { previous, imports } = this.resolveSources(params);
    const start = performance.now();

    const cacheKey = `analysis:${hashObject({
      engine: ENGINE_VERSION,
      profileHash: botProfileHash(bot),
      imports: imports.map((i) => [i.id, i.contentHash, i.completeness]),
      previous: previous?.contentHash ?? null,
      profile,
      budgetTokens,
      objective: params.objective ?? null,
      workstream: params.workstream ?? null,
      method: effectiveMethod(settings.tokenMethod),
    })}`;
    let result: CompactResult | null = null;
    const cached = this.store.cacheGet(cacheKey);
    if (cached) {
      try {
        result = JSON.parse(cached) as CompactResult;
      } catch {
        result = null;
      }
    }
    const cacheHit = Boolean(result);
    if (!result) {
      const messages = this.store.getMessages(imports.map((i) => i.id));
      result = compact({
        bot,
        messages,
        imports,
        previous,
        profile,
        budgetTokens,
        tokenMethod: effectiveMethod(settings.tokenMethod),
        workstream: params.workstream ?? null,
        objective: params.objective ?? null,
      });
      this.store.cachePut(cacheKey, JSON.stringify(result));
    }
    const handoffPreview = renderHandoff(
      result.content,
      this.handoffMeta(
        'GCM-PREVIEW',
        (previous?.version ?? 0) + 1,
        this.iso(),
        result.completeness,
        params.botId,
      ),
    );
    const validation = validateCheckpoint(result.content, result.items, handoffPreview);
    // Cost advice: a handoff only helps once the conversation is clearly larger than the handoff itself.
    const importedTokens = this.store.archiveStats(bot.id).tokens;
    if (
      importedTokens > 0 &&
      result.handoffPreviewTokens >= importedTokens * 0.8 &&
      !result.warnings.some((w) => w.startsWith('The handoff'))
    ) {
      result = {
        ...result,
        warnings: [
          ...result.warnings,
          `The handoff (~${result.handoffPreviewTokens} tokens) is not much smaller than the imported text (~${importedTokens} tokens). Starting a fresh conversation now is unlikely to reduce usage; checkpoint when the conversation has grown.`,
        ],
      };
    }
    this.log({
      op: 'analyze',
      channel: ctx.channel,
      botId: bot.id,
      durationMs: Math.round(performance.now() - start),
      ok: true,
      detail: cacheHit ? 'cache-hit' : `${imports.length} imports`,
      modelTokens: 0,
      responseTokens: 0,
    });
    return {
      botId: bot.id,
      previousCheckpointId: previous?.id ?? null,
      importIds: imports.map((i) => i.id),
      result,
      validation,
      handoffPreview,
      cacheHit,
      profile,
      budgetTokens,
    };
  }

  private handoffMeta(
    code: string,
    version: number,
    createdAt: string,
    completeness: Completeness,
    botId: string,
  ): HandoffMeta {
    const stats = this.store.archiveStats(botId);
    return {
      verificationCode: code,
      version,
      createdAt,
      completeness,
      archive: { imports: stats.imports, messages: stats.messages },
    };
  }

  async createCheckpoint(
    params: CheckpointParams & {
      approve?: boolean;
      reviewNote?: string | null;
      narrative?: boolean;
    },
    ctx: AccessContext,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ checkpoint: CheckpointRecord; validation: ValidationReport; saved: boolean }> {
    this.writableBot(params.botId, ctx);
    let modelTokens = 0;
    return this.timed(
      'checkpoint.create',
      ctx,
      params.botId,
      async () => {
        const preview = this.analyze(params, ctx);
        const head = this.store.headCheckpoint(params.botId);
        const nothingNew =
          head &&
          !params.rebuild &&
          preview.importIds.length === 0 &&
          !params.objective &&
          !params.workstream &&
          !params.profile &&
          !params.budgetTokens;
        if (nothingNew) {
          throw new GcmError(
            'VALIDATION',
            `No new material since checkpoint v${head.version}. Nothing was created (avoids redundant work).`,
            'Import new conversation text first, pass --objective/--workstream to change focus, or use --rebuild.',
          );
        }
        if (!preview.validation.ok) {
          throw new GcmError(
            'INTEGRITY',
            `Checkpoint failed validation: ${preview.validation.errors.join(' | ')}`,
          );
        }
        const content: CheckpointContent = structuredClone(preview.result.content);
        const warnings = [...preview.result.warnings, ...preview.validation.warnings];

        // Optional local narrative (cached by content hash; deterministic fallback on any failure).
        const provider = this.provider();
        if ((params.narrative ?? provider.id !== 'deterministic') && provider.narrate) {
          const nkey = `narrative:${provider.id}:${hashObject({ c: content.constraints, d: content.decisions, t: content.pendingTasks, q: content.openQuestions, p: content.progress, o: content.objective })}`;
          const cachedNarrative = this.store.cacheGet(nkey);
          if (cachedNarrative) content.narrative = cachedNarrative;
          else {
            const status = await provider.status();
            if (!status.ok)
              warnings.push(
                `Narrative skipped; used the deterministic engine only. ${status.detail}`,
              );
            else {
              try {
                const n = await provider.narrate(content);
                content.narrative = n.text;
                modelTokens = n.modelTokens;
                this.store.cachePut(nkey, n.text);
                if (!provider.local)
                  warnings.push(
                    `Narrative generated by a NON-LOCAL endpoint (${provider.label}); checkpoint notes left this machine.`,
                  );
              } catch (e) {
                warnings.push(
                  `Narrative discarded; deterministic output kept. ${(e as Error).message}`,
                );
              }
            }
          }
        }

        const createdAt = this.iso();
        const version = (head?.version ?? 0) + 1;
        const base = {
          id: newId('ck'),
          botId: params.botId,
          version,
          parentId: head?.id ?? null,
          restoredFromId: null,
          schemaVersion: SCHEMA_VERSION,
          createdAt,
          sessionRef: params.sessionRef ?? null,
          source: {
            importIds: preview.importIds,
            completeness: preview.result.completeness,
            messageCount: content.stats.sourceMessages,
            provider: content.narrative ? `deterministic+${provider.id}` : 'deterministic',
            profile: preview.profile,
            engineVersion: ENGINE_VERSION,
            basedOnCheckpointId: params.rebuild ? null : (head?.id ?? null),
          },
          content,
        };
        const rendered = renderHandoff(
          content,
          this.handoffMeta(
            'GCM-0000-0000',
            version,
            createdAt,
            preview.result.completeness,
            params.botId,
          ),
        );
        const checkpoint: CheckpointRecord = {
          ...base,
          contentHash: checkpointHash(base),
          tokenEstimate: {
            tokens: countTokens(rendered, effectiveMethod(this.settings().tokenMethod)),
            method: effectiveMethod(this.settings().tokenMethod),
            kind: 'estimated',
          },
          reviewStatus: params.approve ? 'reviewed' : 'unreviewed',
          reviewedAt: params.approve ? createdAt : null,
          reviewNote: params.approve ? (params.reviewNote ?? 'Approved at creation') : null,
          warnings,
        };
        if (!opts.dryRun) {
          this.store.insertCheckpoint(checkpoint);
          // Read-back verification: an unreadable or altered checkpoint is a hard failure.
          const back = this.store.getCheckpoint(checkpoint.id);
          if (!back || checkpointHash(back) !== checkpoint.contentHash) {
            throw new GcmError('INTEGRITY', 'Checkpoint read-back verification failed.');
          }
        }
        return { checkpoint, validation: preview.validation, saved: !opts.dryRun };
      },
      () => modelTokens,
    );
  }

  listCheckpoints(botId: string, ctx: AccessContext, page: Page): Paged<CheckpointRecord> {
    this.readableBot(botId, ctx);
    return this.store.listCheckpoints(botId, page);
  }

  getCheckpoint(id: string, ctx: AccessContext): CheckpointRecord {
    const ck = this.store.getCheckpoint(id);
    if (!ck) throw new GcmError('NOT_FOUND', `Checkpoint "${id}" not found.`);
    this.readableBot(ck.botId, ctx);
    return ck;
  }

  latestCheckpoint(botId: string, ctx: AccessContext): CheckpointRecord {
    this.readableBot(botId, ctx);
    const head = this.store.headCheckpoint(botId);
    if (!head)
      throw new GcmError(
        'NOT_FOUND',
        `Bot "${botId}" has no checkpoints yet.`,
        'Create one with `grokcm checkpoint create`.',
      );
    return head;
  }

  verifyCheckpoint(id: string, ctx: AccessContext): IntegrityReport {
    const ck = this.getCheckpoint(id, ctx);
    const details: string[] = [];
    const checkpointOk = checkpointHash(ck) === ck.contentHash;
    details.push(
      checkpointOk
        ? 'Checkpoint content hash matches.'
        : 'Checkpoint content hash MISMATCH — content was altered.',
    );
    const ids = new Set<string>(ck.source.importIds);
    for (const section of [
      ck.content.constraints,
      ck.content.decisions,
      ck.content.pendingTasks,
      ck.content.openQuestions,
      ck.content.knowledge,
      ck.content.progress,
    ]) {
      for (const item of section) for (const r of item.sourceRefs) ids.add(r.importId);
    }
    const missingImports: string[] = [];
    const corruptedImports: string[] = [];
    for (const importId of ids) {
      const rec = this.store.getImport(importId);
      if (!rec || rec.botId !== ck.botId) {
        missingImports.push(importId);
        continue;
      }
      if (importHash(this.store.getMessages([importId])) !== rec.contentHash)
        corruptedImports.push(importId);
    }
    if (missingImports.length)
      details.push(
        `${missingImports.length} referenced import(s) are not in this archive (e.g. checkpoint restored from an external file).`,
      );
    if (corruptedImports.length)
      details.push(`${corruptedImports.length} import(s) FAILED their integrity hash.`);
    if (!missingImports.length && !corruptedImports.length)
      details.push(`All ${ids.size} referenced import(s) present and intact.`);
    return {
      checkpointId: ck.id,
      checkpointOk,
      archiveOk: corruptedImports.length === 0,
      missingImports,
      corruptedImports,
      details,
    };
  }

  reviewCheckpoint(
    id: string,
    ctx: AccessContext,
    opts: { note?: string | null; status?: 'reviewed' | 'unreviewed' } = {},
  ): CheckpointRecord {
    const ck = this.getCheckpoint(id, ctx);
    this.writableBot(ck.botId, ctx);
    const status = opts.status ?? 'reviewed';
    const at = status === 'reviewed' ? this.iso() : null;
    this.store.setCheckpointReview(id, status, at, opts.note ?? null);
    this.log({
      op: 'checkpoint.review',
      channel: ctx.channel,
      botId: ck.botId,
      durationMs: 0,
      ok: true,
      detail: status,
      modelTokens: 0,
      responseTokens: 0,
    });
    return { ...ck, reviewStatus: status, reviewedAt: at, reviewNote: opts.note ?? null };
  }

  diff(fromId: string, toId: string, ctx: AccessContext): CheckpointDiff {
    const a = this.getCheckpoint(fromId, ctx);
    const b = this.getCheckpoint(toId, ctx);
    if (a.botId !== b.botId)
      throw new GcmError(
        'VALIDATION',
        'Checkpoints belong to different bots; cross-bot comparison is not allowed.',
      );
    return diffCheckpoints(a, b);
  }

  /** Restores GCM-managed context by creating a NEW head version with an old checkpoint's content. Nothing is overwritten. */
  restoreCheckpoint(
    id: string,
    ctx: AccessContext,
    opts: { dryRun?: boolean } = {},
  ): CheckpointRecord {
    const source = this.getCheckpoint(id, ctx);
    this.writableBot(source.botId, ctx);
    if (checkpointHash(source) !== source.contentHash)
      throw new GcmError(
        'INTEGRITY',
        `Checkpoint ${id} failed its integrity check; refusing to restore it.`,
      );
    const head = this.store.headCheckpoint(source.botId);
    const record = this.cloneAsNewVersion(
      source,
      head,
      source.id,
      `Restored from v${source.version} (${source.id}).`,
    );
    if (!opts.dryRun) this.store.insertCheckpoint(record);
    this.log({
      op: 'checkpoint.restore',
      channel: ctx.channel,
      botId: source.botId,
      durationMs: 0,
      ok: true,
      detail: opts.dryRun ? 'dry-run' : `v${record.version}`,
      modelTokens: 0,
      responseTokens: 0,
    });
    return record;
  }

  private cloneAsNewVersion(
    source: CheckpointRecord,
    head: CheckpointRecord | null,
    restoredFromId: string,
    note: string,
  ): CheckpointRecord {
    const createdAt = this.iso();
    const base = {
      id: newId('ck'),
      botId: source.botId,
      version: (head?.version ?? 0) + 1,
      parentId: head?.id ?? null,
      restoredFromId,
      schemaVersion: SCHEMA_VERSION,
      createdAt,
      sessionRef: source.sessionRef,
      source: { ...source.source, basedOnCheckpointId: restoredFromId },
      content: structuredClone(source.content),
    };
    return {
      ...base,
      contentHash: checkpointHash(base),
      tokenEstimate: source.tokenEstimate,
      reviewStatus: source.reviewStatus,
      reviewedAt: source.reviewStatus === 'reviewed' ? createdAt : null,
      reviewNote: note,
      warnings: [note],
    };
  }

  exportCheckpoint(id: string, format: 'json' | 'markdown', ctx: AccessContext): string {
    const ck = this.getCheckpoint(id, ctx);
    if (format === 'markdown') return renderCheckpointMarkdown(ck);
    return JSON.stringify(
      {
        format: 'gcm-checkpoint',
        formatVersion: 1,
        exportedAt: this.iso(),
        appVersion: APP_VERSION,
        checkpoint: ck,
      },
      null,
      2,
    );
  }

  /** Restores an externally stored checkpoint export as a new version (integrity-checked; cross-bot only when explicit). */
  importCheckpointFile(
    json: string,
    ctx: AccessContext,
    opts: { asBot?: string; dryRun?: boolean } = {},
  ): CheckpointRecord {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw new GcmError('VALIDATION', `Not valid JSON: ${(e as Error).message}`);
    }
    const parsed = CheckpointExportSchema.safeParse(data);
    if (!parsed.success)
      throw new GcmError('VALIDATION', `Not a GCM checkpoint export: ${formatZod(parsed.error)}`);
    const external = parsed.data.checkpoint;
    if (checkpointHash(external) !== external.contentHash) {
      throw new GcmError(
        'INTEGRITY',
        'The checkpoint file was modified after export (content hash mismatch). Refusing to import it.',
      );
    }
    const target = opts.asBot ?? external.botId;
    if (target !== external.botId && !opts.asBot) throw new GcmError('VALIDATION', 'Bot mismatch.');
    this.writableBot(target, ctx);
    const head = this.store.headCheckpoint(target);
    const record = this.cloneAsNewVersion(
      { ...external, botId: target },
      head,
      external.id,
      `Imported from external checkpoint file (original ${external.botId} v${external.version}).`,
    );
    if (target !== external.botId)
      record.warnings.push(
        `Cross-bot import explicitly requested: content originated from bot "${external.botId}".`,
      );
    if (!opts.dryRun) this.store.insertCheckpoint(record);
    return record;
  }

  // -------------------------------------------------------------------------------------------
  // Handoffs & guided workflow
  // -------------------------------------------------------------------------------------------

  prepareHandoff(
    params: {
      botId: string;
      checkpointId?: string;
      profile?: ProfileName;
      budgetTokens?: number;
      allowUnreviewed?: boolean;
    },
    ctx: AccessContext,
  ): HandoffRecord {
    const bot = this.writableBot(params.botId, ctx);
    const ck = params.checkpointId
      ? this.getCheckpoint(params.checkpointId, ctx)
      : this.latestCheckpoint(params.botId, ctx);
    if (ck.botId !== bot.id)
      throw new GcmError('VALIDATION', 'Checkpoint belongs to a different bot.');
    const events: HandoffRecord['events'] = [];
    const at = this.iso();

    const integrity = this.verifyCheckpoint(ck.id, ctx);
    if (!integrity.checkpointOk)
      throw new GcmError(
        'INTEGRITY',
        `Checkpoint v${ck.version} failed verification; no handoff created.`,
      );
    events.push({
      state: 'CHECKPOINT_READY',
      at,
      note: `Checkpoint v${ck.version} hash verified.`,
    });
    if (ck.reviewStatus !== 'reviewed' && !params.allowUnreviewed) {
      throw new GcmError(
        'APPROVAL_REQUIRED',
        `Checkpoint v${ck.version} has not been reviewed.`,
        `Review it (grokcm checkpoint show ${ck.id}) and approve with \`grokcm checkpoint review ${ck.id}\`, or pass --allow-unreviewed.`,
      );
    }
    if (!integrity.archiveOk)
      throw new GcmError(
        'INTEGRITY',
        `Archive verification failed: ${integrity.details.join(' ')}`,
      );
    events.push({ state: 'ARCHIVE_VERIFIED', at, note: integrity.details.join(' ') });

    const profile = params.profile ?? ck.source.profile;
    const budget = this.budgetFor(bot, profile, params.budgetTokens);
    const id = newId('ho');
    const code = shortCode(sha256(`${ck.contentHash}:${id}`));
    const meta = this.handoffMeta(code, ck.version, ck.createdAt, ck.source.completeness, bot.id);
    const fitted = fitToBudget(
      ck.content,
      budget,
      meta,
      effectiveMethod(this.settings().tokenMethod),
    );
    const text = renderHandoff(fitted.content, meta);
    if (containsSecret(text))
      throw new GcmError(
        'INTEGRITY',
        'Refusing to create a handoff containing a secret-like value.',
      );
    events.push({
      state: 'HANDOFF_READY',
      at,
      note: `Handoff ~${fitted.tokens} tokens (budget ${budget}).${fitted.warnings.length ? ` ${fitted.warnings.join(' ')}` : ''}`,
    });

    const handoff: HandoffRecord = {
      id,
      botId: bot.id,
      checkpointId: ck.id,
      createdAt: at,
      profile,
      budgetTokens: budget,
      text,
      tokenEstimate: {
        tokens: fitted.tokens,
        method: effectiveMethod(this.settings().tokenMethod),
        kind: 'estimated',
      },
      verificationCode: code,
      state: 'HANDOFF_READY',
      platformAction: null,
      events,
    };
    this.store.insertHandoff(handoff);
    this.log({
      op: 'handoff.prepare',
      channel: ctx.channel,
      botId: bot.id,
      durationMs: 0,
      ok: true,
      detail: `~${fitted.tokens} tokens`,
      modelTokens: 0,
      responseTokens: 0,
    });
    return handoff;
  }

  getHandoff(id: string, ctx: AccessContext): HandoffRecord {
    const h = this.store.getHandoff(id);
    if (!h) throw new GcmError('NOT_FOUND', `Handoff "${id}" not found.`);
    this.readableBot(h.botId, ctx);
    return h;
  }

  latestHandoff(botId: string, ctx: AccessContext): HandoffRecord {
    this.readableBot(botId, ctx);
    const h = this.store.listHandoffs(botId, { limit: 1, offset: 0 }).items[0];
    if (!h)
      throw new GcmError(
        'NOT_FOUND',
        `Bot "${botId}" has no handoffs yet.`,
        'Prepare one with `grokcm handoff prepare`.',
      );
    return h;
  }

  listHandoffs(botId: string | null, ctx: AccessContext, page: Page): Paged<HandoffRecord> {
    if (botId) {
      this.readableBot(botId, ctx);
      return this.store.listHandoffs(botId, page);
    }
    const all = this.store.listHandoffs(null, { limit: 10_000, offset: 0 }).items.filter((h) => {
      const b = this.store.getBot(h.botId);
      return b ? this.canRead(ctx, b) : false;
    });
    return {
      items: all.slice(page.offset, page.offset + page.limit),
      total: all.length,
      limit: page.limit,
      offset: page.offset,
    };
  }

  private transition(h: HandoffRecord, to: HandoffState, note: string): HandoffRecord {
    if (!canTransition(h.state, to)) {
      throw new GcmError(
        'INVALID_STATE',
        `Cannot move handoff from ${h.state} to ${to}.`,
        STATE_DESCRIPTIONS[h.state],
      );
    }
    const next: HandoffRecord = {
      ...h,
      state: to,
      events: [...h.events, { state: to, at: this.iso(), note }],
    };
    this.store.updateHandoff(next);
    return next;
  }

  chooseAction(
    handoffId: string,
    action: PlatformAction,
    ctx: AccessContext,
    opts: { acknowledgeDestructive?: boolean } = {},
  ): { handoff: HandoffRecord; guide: PlatformActionGuide } {
    const h = this.getHandoff(handoffId, ctx);
    const bot = this.writableBot(h.botId, ctx);
    const guide = platformGuide(action, bot.name);
    if (guide.destructive && !opts.acknowledgeDestructive) {
      throw new GcmError(
        'APPROVAL_REQUIRED',
        'Reset chat permanently clears the Grok Bot transcript for this bot. Explicit acknowledgement is required.',
        'Re-run with --i-understand-transcript-loss (CLI) or tick the acknowledgement (dashboard). Consider new_group_chat instead.',
      );
    }
    const note = `User chose "${action}". ${guide.destructive ? 'Destructive action acknowledged by the user. ' : ''}GCM will not perform this step; it happens in the Grok Bot app.`;
    const next = this.transition({ ...h, platformAction: action }, 'USER_ACTION_REQUIRED', note);
    return { handoff: next, guide };
  }

  reportActionDone(handoffId: string, ctx: AccessContext, note?: string): HandoffRecord {
    const h = this.getHandoff(handoffId, ctx);
    this.writableBot(h.botId, ctx);
    return this.transition(
      h,
      'EXTERNAL_RESET_UNVERIFIED',
      `User reported completing "${h.platformAction ?? 'unknown'}" in Grok Bot. GCM cannot observe the platform, so the effect on Grok Bot's context is unverified.${note ? ` Note: ${redactSecrets(note).text.slice(0, 300)}` : ''}`,
    );
  }

  verifyContinuationReply(
    handoffId: string,
    reply: string,
    ctx: AccessContext,
  ): { handoff: HandoffRecord; result: ContinuationResult } {
    if (!reply.trim()) throw new GcmError('VALIDATION', 'Paste the bot’s reply to the handoff.');
    if (reply.length > 50_000)
      throw new GcmError('LIMIT_EXCEEDED', 'Reply too long (max 50,000 characters).');
    const h = this.getHandoff(handoffId, ctx);
    this.writableBot(h.botId, ctx);
    if (h.state !== 'EXTERNAL_RESET_UNVERIFIED' && h.state !== 'FAILED_RECOVERABLE') {
      throw new GcmError(
        'INVALID_STATE',
        `Verification needs state EXTERNAL_RESET_UNVERIFIED (current: ${h.state}).`,
        'Report the platform step first.',
      );
    }
    const ck = this.store.getCheckpoint(h.checkpointId);
    if (!ck) throw new GcmError('NOT_FOUND', 'The handoff’s checkpoint is missing.');
    const result = verifyContinuation(h, ck.content, reply);
    const summary = result.checks
      .map((c) => `${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`)
      .join(' ');
    // The reply itself is not stored (privacy); only the check results are.
    if (result.passed)
      return { handoff: this.transition(h, 'CONTINUATION_VERIFIED', summary), result };
    const failed =
      h.state === 'FAILED_RECOVERABLE'
        ? { ...h, events: [...h.events, { state: h.state, at: this.iso(), note: summary }] }
        : this.transition(h, 'FAILED_RECOVERABLE', summary);
    if (h.state === 'FAILED_RECOVERABLE') this.store.updateHandoff(failed);
    return { handoff: failed, result };
  }

  markHandoffFailed(handoffId: string, reason: string, ctx: AccessContext): HandoffRecord {
    const h = this.getHandoff(handoffId, ctx);
    this.writableBot(h.botId, ctx);
    return this.transition(h, 'FAILED_RECOVERABLE', redactSecrets(reason).text.slice(0, 500));
  }

  retryHandoff(handoffId: string, ctx: AccessContext): HandoffRecord {
    const h = this.getHandoff(handoffId, ctx);
    this.writableBot(h.botId, ctx);
    return this.transition(h, 'HANDOFF_READY', 'Retry requested; handoff text unchanged.');
  }

  // -------------------------------------------------------------------------------------------
  // Archive
  // -------------------------------------------------------------------------------------------

  searchArchive(botId: string, query: string, ctx: AccessContext, page: Page): Paged<ArchiveHit> {
    this.readableBot(botId, ctx);
    const q = query.trim();
    if (!q) throw new GcmError('VALIDATION', 'Search query is empty.');
    if (q.length > 500)
      throw new GcmError('LIMIT_EXCEEDED', 'Search query too long (max 500 characters).');
    const res = this.store.searchArchive(botId, q, page);
    return {
      ...res,
      items: res.items.map((h) => ({ ...h, snippet: redactSecrets(h.snippet).text })),
    };
  }

  exportArchive(
    botId: string,
    ctx: AccessContext,
    opts: { importId?: string; format: 'json' | 'markdown'; includeSecrets?: boolean },
  ): string {
    this.requireLocal(ctx, 'export archives');
    this.readableBot(botId, ctx);
    const imports = opts.importId
      ? [this.store.getImport(opts.importId)].filter((i): i is ImportRecord =>
          Boolean(i && i.botId === botId),
        )
      : this.store.listImports(botId, { limit: 100_000, offset: 0 }).items;
    if (opts.importId && imports.length === 0)
      throw new GcmError('NOT_FOUND', `Import "${opts.importId}" not found for bot "${botId}".`);
    const clean = (s: string) => (opts.includeSecrets ? s : redactSecrets(s).text);
    const data = imports.map((rec) => ({
      record: rec,
      messages: this.store.getMessages([rec.id]),
    }));
    this.log({
      op: 'archive.export',
      channel: ctx.channel,
      botId,
      durationMs: 0,
      ok: true,
      detail: `${imports.length} imports ${opts.format}`,
      modelTokens: 0,
      responseTokens: 0,
    });
    if (opts.format === 'json') {
      return JSON.stringify(
        {
          format: 'gcm-archive',
          formatVersion: 1,
          exportedAt: this.iso(),
          botId,
          secretsRedacted: !opts.includeSecrets,
          imports: data.map((d) => ({
            ...d.record,
            messages: d.messages.map((m) => ({
              seq: m.seq,
              role: m.role,
              author: m.author,
              timestamp: m.timestamp,
              content: clean(m.content),
            })),
          })),
        },
        null,
        2,
      );
    }
    const out = [
      `# GCM archive export — ${botId}`,
      '',
      `Exported ${this.iso()} · ${imports.length} import(s) · secrets ${opts.includeSecrets ? 'INCLUDED' : 'redacted'}`,
    ];
    for (const d of data) {
      out.push(
        '',
        `## Import ${d.record.id}`,
        `- Imported: ${d.record.importedAt}`,
        `- Session: ${d.record.sessionRef ?? '—'} · Source: ${d.record.sourceName ?? '—'} · Coverage: ${d.record.completeness}`,
        `- Integrity hash: \`${d.record.contentHash}\``,
        '',
      );
      for (const m of d.messages)
        out.push(
          `**${m.author ?? m.role}**${m.timestamp ? ` (${m.timestamp})` : ''} · #${m.seq}`,
          '',
          clean(m.content),
          '',
        );
    }
    return out.join('\n');
  }

  /**
   * Restores imports from a `grokcm archive export --format json` file. Each exported import becomes a new import
   * (same session labels, coverage and message order); messages already present are skipped as usual.
   */
  importArchiveExport(
    json: string,
    ctx: AccessContext,
    opts: { asBot?: string; dryRun?: boolean } = {},
  ): {
    botId: string;
    imports: number;
    added: number;
    duplicatesSkipped: number;
    warnings: string[];
  } {
    this.requireLocal(ctx, 'restore archives');
    let data: {
      format?: unknown;
      botId?: unknown;
      imports?: {
        sessionRef?: string | null;
        sourceName?: string | null;
        completeness?: Completeness;
        completenessNote?: string | null;
        messages?: { role: string; author?: string; timestamp?: string; content: string }[];
      }[];
    };
    try {
      data = JSON.parse(json) as typeof data;
    } catch (e) {
      throw new GcmError('VALIDATION', `Not valid JSON: ${(e as Error).message}`);
    }
    if (data.format !== 'gcm-archive' || !Array.isArray(data.imports)) {
      throw new GcmError('VALIDATION', 'Not a GCM archive export (expected format "gcm-archive").');
    }
    const botId = opts.asBot ?? String(data.botId ?? '');
    this.writableBot(botId, ctx);
    const warnings: string[] = [];
    if (opts.asBot && opts.asBot !== data.botId) {
      warnings.push(
        `Cross-bot restore explicitly requested: archive belongs to "${String(data.botId)}".`,
      );
    }
    let added = 0;
    let duplicatesSkipped = 0;
    let imports = 0;
    for (const imp of data.imports) {
      const messages = (imp.messages ?? []).filter(
        (m) => typeof m.content === 'string' && m.content.trim(),
      );
      if (messages.length === 0) continue;
      const r = this.importContext(
        {
          botId,
          text: JSON.stringify({ messages }),
          format: 'json',
          sessionRef: imp.sessionRef ?? null,
          sourceName: `restored: ${imp.sourceName ?? 'archive'}`.slice(0, 300),
          completeness: imp.completeness ?? 'unknown',
          completenessNote: imp.completenessNote ?? null,
        },
        ctx,
        { dryRun: opts.dryRun },
      );
      if (r.added > 0) imports++;
      added += r.added;
      duplicatesSkipped += r.duplicatesSkipped;
    }
    return { botId, imports, added, duplicatesSkipped, warnings };
  }

  // -------------------------------------------------------------------------------------------
  // Usage & reports
  // -------------------------------------------------------------------------------------------

  recordUsage(input: UsageInput, ctx: AccessContext): UsageRecord {
    const parsed = UsageInputSchema.safeParse(input);
    if (!parsed.success) throw new GcmError('VALIDATION', formatZod(parsed.error));
    this.writableBot(parsed.data.botId, ctx);
    const rec: UsageRecord = { ...parsed.data, id: newId('use'), recordedAt: this.iso() };
    this.store.insertUsage(rec);
    return rec;
  }

  usageReport(botId: string, ctx: AccessContext): UsageReport {
    this.readableBot(botId, ctx);
    const method = effectiveMethod(this.settings().tokenMethod);
    const imports = this.store.listImports(botId, { limit: 100_000, offset: 0 }).items;
    const head = this.store.headCheckpoint(botId);
    const handoff = this.store.listHandoffs(botId, { limit: 1, offset: 0 }).items[0] ?? null;
    const importedTokens = imports.reduce((n, i) => n + i.tokenEstimate, 0);
    const usage = this.store.listUsage(botId);
    const measured = usage.filter((u) => u.kind === 'provider_measured');
    const latest = (re: RegExp) =>
      [...measured].reverse().find((u) => re.test(u.label) && u.inputTokens !== null) ?? null;
    const before = latest(/before/i);
    const after = latest(/after/i);
    const totals = this.store.operationTotals(botId);
    const coverage = combineCompleteness(imports.map((i) => i.completeness));
    const limitations = [
      'All token figures except user-recorded measurements are local estimates of text size, not Grok Bot billing.',
      'Estimated text reduction compares GCM-held text only; it says nothing about what Grok Bot actually reprocesses.',
    ];
    if (coverage !== 'complete')
      limitations.push(`Imported material coverage is ${coverage}; totals are partial.`);
    if (!before || !after)
      limitations.push(
        'No before/after platform measurements recorded, so no platform-level saving can be stated.',
      );
    else
      limitations.push(
        'Before/after figures are user-recorded and not verified by GCM; other factors (task mix, model, routines) also affect usage.',
      );
    return {
      botId,
      estimates: {
        kind: 'estimated',
        method,
        importedChars: imports.reduce((n, i) => n + i.charCount, 0),
        importedTokens,
        checkpointTokens: head?.tokenEstimate.tokens ?? null,
        handoffTokens: handoff?.tokenEstimate.tokens ?? null,
        estimatedTextReductionPercent: handoff
          ? reductionPercent(importedTokens, handoff.tokenEstimate.tokens)
          : head
            ? reductionPercent(importedTokens, head.tokenEstimate.tokens)
            : null,
      },
      coverage,
      partial: coverage !== 'complete',
      measured,
      billing: usage.filter((u) => u.kind === 'billing'),
      platformComparison: {
        status: before && after ? 'user_measured_unverified' : 'not_measured',
        before,
        after,
        inputTokenChangePercent:
          before && after
            ? reductionPercent(before.inputTokens ?? 0, after.inputTokens ?? 0)
            : null,
      },
      gcmOverhead: {
        operations: totals.count,
        durationMs: totals.durationMs,
        localModelTokens: totals.modelTokens,
        mcpResponseTokensEstimated: totals.responseTokens,
      },
      limitations,
    };
  }

  estimate(
    text: string,
    method?: TokenMethod,
  ): { tokens: number; method: TokenMethod; kind: 'estimated'; chars: number } {
    if (text.length > 5_000_000)
      throw new GcmError(
        'LIMIT_EXCEEDED',
        'Text too large to estimate (max 5,000,000 characters).',
      );
    const m = effectiveMethod(method ?? this.settings().tokenMethod);
    return { tokens: countTokens(text, m), method: m, kind: 'estimated', chars: text.length };
  }

  // -------------------------------------------------------------------------------------------
  // Data deletion (GCM data only — never Cursor/Grok Bot data)
  // -------------------------------------------------------------------------------------------

  async deleteBotData(
    botId: string,
    ctx: AccessContext,
    opts: { confirm: boolean; backupPath?: string },
  ) {
    this.requireLocal(ctx, 'delete data');
    this.writableBot(botId, ctx);
    if (!opts.confirm) {
      throw new GcmError(
        'APPROVAL_REQUIRED',
        `This permanently deletes GCM's stored data for "${botId}" (profile, archive, checkpoints, handoffs). It does not touch Grok Bot.`,
        'Re-run with --yes to confirm.',
      );
    }
    if (opts.backupPath) await this.store.backup(opts.backupPath);
    const counts = this.store.deleteBotData(botId);
    this.log({
      op: 'data.delete-bot',
      channel: ctx.channel,
      botId,
      durationMs: 0,
      ok: true,
      detail: JSON.stringify(counts),
      modelTokens: 0,
      responseTokens: 0,
    });
    return counts;
  }

  async deleteAllData(ctx: AccessContext, opts: { confirm: boolean; backupPath?: string }) {
    this.requireLocal(ctx, 'delete data');
    if (!opts.confirm)
      throw new GcmError(
        'APPROVAL_REQUIRED',
        "This permanently deletes ALL of GCM's stored data. It does not touch Grok Bot.",
        'Re-run with --yes to confirm.',
      );
    if (opts.backupPath) await this.store.backup(opts.backupPath);
    return this.store.deleteAllData();
  }

  // -------------------------------------------------------------------------------------------
  // Health & capabilities
  // -------------------------------------------------------------------------------------------

  health() {
    const info = this.store.info();
    const integrity = this.store.integrityCheck();
    return {
      ok: integrity.length === 0,
      appVersion: APP_VERSION,
      schemaVersion: info.schemaVersion,
      engineVersion: ENGINE_VERSION,
      storage: {
        path: info.path,
        sizeBytes: info.sizeBytes,
        ftsEnabled: info.ftsEnabled,
        integrity: integrity.length ? integrity : ['ok'],
      },
      bots: this.store.listBots().length,
      summarizer: this.settings().summarizer,
      telemetry: false as const,
    };
  }

  capabilities() {
    return CAPABILITIES;
  }
}

// ---------------------------------------------------------------------------------------------
// Hash helpers (exported for tests and storage verification)
// ---------------------------------------------------------------------------------------------

export function importHash(messages: Pick<StoredMessage, 'seq' | 'role' | 'content'>[]): string {
  return hashObject(messages.map((m) => [m.seq, m.role, m.content]));
}

export function checkpointHash(
  ck: Pick<
    CheckpointRecord,
    | 'botId'
    | 'version'
    | 'parentId'
    | 'restoredFromId'
    | 'schemaVersion'
    | 'createdAt'
    | 'sessionRef'
    | 'source'
    | 'content'
  >,
): string {
  return hashObject({
    botId: ck.botId,
    version: ck.version,
    parentId: ck.parentId,
    restoredFromId: ck.restoredFromId,
    schemaVersion: ck.schemaVersion,
    createdAt: ck.createdAt,
    sessionRef: ck.sessionRef,
    source: ck.source,
    content: ck.content,
  });
}

function formatZod(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
    .join('; ');
}
