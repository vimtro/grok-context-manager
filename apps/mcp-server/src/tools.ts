/**
 * GCM MCP tools. Design rules:
 * - Every tool takes an explicit bot_id / record id; nothing returns data from several bots at once
 *   except gcm_list_bots (metadata only).
 * - Responses are compact Markdown/JSON and capped by a token budget; archives are never returned wholesale.
 * - Write tools only touch GCM-managed storage. There is no tool that resets, prunes or reads Grok Bot's
 *   own transcript, because no supported API exists.
 * - Destructive platform actions (Reset chat) cannot be chosen over MCP.
 * Full per-tool documentation: docs/MCP-SETUP.md.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BotIdSchema,
  countTokens,
  GcmError,
  loadTokenizer,
  renderHandoff,
  STATE_DESCRIPTIONS,
  type AccessContext,
  type CheckpointRecord,
  type GcmService,
} from '@gcm/core';

export interface ToolOptions {
  ctx: AccessContext;
  maxResponseTokens: number;
  /** Max characters accepted by gcm_import_context in a single call. */
  maxImportChars: number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const botId = BotIdSchema.describe('GCM bot ID, e.g. "sales"');
const limit = (max: number) => z.number().int().min(1).max(max).optional();
const offset = z.number().int().min(0).max(100_000).optional();
const profile = z.enum(['compact', 'balanced', 'detailed']).optional();
const budget = z.number().int().min(200).max(50_000).optional();

export const READ_ONLY_TOOLS = [
  'gcm_describe_capabilities',
  'gcm_health',
  'gcm_list_bots',
  'gcm_analyze_context',
  'gcm_estimate_tokens',
  'gcm_list_checkpoints',
  'gcm_get_checkpoint',
  'gcm_compare_checkpoints',
  'gcm_get_handoff',
  'gcm_search_archive',
] as const;

export function registerTools(server: McpServer, service: GcmService, opts: ToolOptions): string[] {
  const { ctx } = opts;
  const registered: string[] = [];

  const respond = (tool: string, botIdForLog: string | null, body: unknown): ToolResult => {
    let text = typeof body === 'string' ? body : JSON.stringify(body);
    let tokens = countTokens(text);
    if (tokens > opts.maxResponseTokens) {
      const keep = Math.floor(text.length * (opts.maxResponseTokens / tokens) * 0.95);
      text = `${text.slice(0, keep)}\n\n[GCM: response truncated to the ${opts.maxResponseTokens}-token MCP budget. Use pagination (limit/offset), a narrower query, or format "handoff".]`;
      tokens = countTokens(text);
    }
    service.recordResponseSize(tool, botIdForLog, tokens);
    return { content: [{ type: 'text', text }] };
  };

  const guard =
    <A>(tool: string, fn: (args: A) => Promise<ToolResult> | ToolResult) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (e) {
        const msg =
          e instanceof GcmError
            ? `ERROR ${e.code}: ${e.message}${e.hint ? ` Hint: ${e.hint}` : ''}`
            : 'ERROR INTERNAL: the operation failed; no data was changed.';
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
    };

  const add = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; write?: boolean },
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult> | ToolResult,
  ) => {
    if (config.write && !ctx.canWrite) return; // read-only connections never see write tools
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: {
          readOnlyHint: !config.write,
          destructiveHint: false,
          idempotentHint: !config.write,
          openWorldHint: false,
        },
      },
      // The SDK validates input against inputSchema before calling us.
      guard(name, fn as (args: unknown) => Promise<ToolResult> | ToolResult) as never,
    );
    registered.push(name);
  };

  const ckSummary = (c: CheckpointRecord) => ({
    checkpoint_id: c.id,
    bot_id: c.botId,
    version: c.version,
    created_at: c.createdAt,
    review_status: c.reviewStatus,
    coverage: c.source.completeness,
    estimated_tokens: c.tokenEstimate.tokens,
    pending_tasks: c.content.pendingTasks.length,
    decisions: c.content.decisions.length,
    conflicts: c.content.conflicts.length,
    restored_from: c.restoredFromId,
  });

  // ------------------------------------------------------------------------------------------- read tools

  add(
    'gcm_describe_capabilities',
    {
      title: 'Describe GCM capabilities',
      description:
        'What GCM can and cannot do with Grok Bot (verified capability matrix). Call this before promising the user any reset/compaction behaviour.',
      inputSchema: {},
    },
    () =>
      respond('gcm_describe_capabilities', null, {
        summary:
          'GCM stores user-supplied conversation material, builds versioned checkpoints and compact handoffs. It cannot read, prune, compact or reset Grok Bot’s own transcript; platform steps are done by the user in the Grok Bot app.',
        capabilities: service
          .capabilities()
          .map((c) => ({ id: c.id, status: c.status, approach: c.approach })),
      }),
  );

  add(
    'gcm_health',
    {
      title: 'GCM health',
      description: 'Operational status of the GCM server (storage integrity, versions).',
      inputSchema: {},
    },
    () => {
      const h = service.health();
      return respond('gcm_health', null, {
        ok: h.ok,
        appVersion: h.appVersion,
        schemaVersion: h.schemaVersion,
        bots: h.bots,
        summarizer: h.summarizer,
        telemetry: false,
      });
    },
  );

  add(
    'gcm_list_bots',
    {
      title: 'List bot profiles',
      description:
        'Bot profiles this connection may access, with latest checkpoint info. Metadata only.',
      inputSchema: {},
    },
    () =>
      respond(
        'gcm_list_bots',
        null,
        service.listBots(ctx).map((b) => ({
          bot_id: b.id,
          name: b.name,
          role: b.role,
          latest_checkpoint: b.headCheckpoint
            ? {
                id: b.headCheckpoint.id,
                version: b.headCheckpoint.version,
                review_status: b.headCheckpoint.reviewStatus,
              }
            : null,
          uncheckpointed_imports: b.uncheckpointedImports,
          warnings: b.warnings,
        })),
      ),
  );

  add(
    'gcm_analyze_context',
    {
      title: 'Analyze stored context (preview)',
      description:
        'Preview what a new checkpoint would retain from material already imported for this bot. Saves nothing. Returns counts, conflicts and uncertainties — not the archive.',
      inputSchema: {
        bot_id: botId,
        profile,
        budget_tokens: budget,
        objective: z.string().max(600).optional(),
      },
    },
    (a) => {
      const p = service.analyze(
        {
          botId: a.bot_id,
          profile: a.profile,
          budgetTokens: a.budget_tokens,
          objective: a.objective ?? null,
        },
        ctx,
      );
      const c = p.result.content;
      return respond('gcm_analyze_context', a.bot_id, {
        bot_id: a.bot_id,
        new_imports: p.importIds.length,
        based_on_checkpoint: p.previousCheckpointId,
        objective: c.objective,
        retained: {
          constraints: c.constraints.length,
          decisions: c.decisions.length,
          pending_tasks: c.pendingTasks.length,
          open_questions: c.openQuestions.length,
          progress: c.progress.length,
          knowledge: c.knowledge.length,
        },
        excluded: {
          temporary: c.excluded.temporary,
          obsolete: c.excluded.obsolete,
          historical: c.excluded.historical,
          quarantined: c.excluded.quarantined,
          over_budget: c.excluded.overBudget,
        },
        conflicts: c.conflicts.map((x) => x.texts),
        uncertainties: c.uncertainties,
        warnings: p.result.warnings,
        estimated_handoff_tokens: p.result.handoffPreviewTokens,
        estimated_source_tokens: c.stats.sourceTokensEstimate,
        validation_ok: p.validation.ok,
      });
    },
  );

  add(
    'gcm_estimate_tokens',
    {
      title: 'Estimate tokens',
      description:
        'Local token estimate for a text (no model call). Estimates text size only — not Grok Bot billing.',
      inputSchema: {
        text: z.string().max(1_000_000),
        method: z.enum(['heuristic', 'o200k']).optional(),
      },
    },
    async (a) => {
      await loadTokenizer(a.method ?? service.settings().tokenMethod);
      return respond('gcm_estimate_tokens', null, service.estimate(a.text, a.method));
    },
  );

  add(
    'gcm_list_checkpoints',
    {
      title: 'List checkpoints',
      description: 'Checkpoint versions for one bot, newest first (paginated).',
      inputSchema: { bot_id: botId, limit: limit(50), offset },
    },
    (a) => {
      const page = service.listCheckpoints(a.bot_id, ctx, {
        limit: a.limit ?? 10,
        offset: a.offset ?? 0,
      });
      return respond('gcm_list_checkpoints', a.bot_id, {
        total: page.total,
        offset: page.offset,
        items: page.items.map(ckSummary),
      });
    },
  );

  add(
    'gcm_get_checkpoint',
    {
      title: 'Read checkpoint',
      description:
        'Read one checkpoint (by id, or the latest for bot_id). format "handoff" (default) is the compact working-context view; "summary" is metadata; "json" is the full record (may be truncated).',
      inputSchema: {
        checkpoint_id: z.string().max(100).optional(),
        bot_id: botId.optional(),
        format: z.enum(['handoff', 'summary', 'json']).optional(),
      },
    },
    (a) => {
      if (!a.checkpoint_id && !a.bot_id)
        throw new GcmError('VALIDATION', 'Give checkpoint_id or bot_id.');
      const ck = a.checkpoint_id
        ? service.getCheckpoint(a.checkpoint_id, ctx)
        : service.latestCheckpoint(a.bot_id!, ctx);
      const format = a.format ?? 'handoff';
      if (format === 'summary')
        return respond('gcm_get_checkpoint', ck.botId, {
          ...ckSummary(ck),
          warnings: ck.warnings,
          uncertainties: ck.content.uncertainties,
        });
      if (format === 'json') return respond('gcm_get_checkpoint', ck.botId, ck);
      const text = renderHandoff(ck.content, {
        verificationCode: `v${ck.version}`,
        version: ck.version,
        createdAt: ck.createdAt,
        completeness: ck.source.completeness,
        archive: { imports: ck.source.importIds.length, messages: ck.source.messageCount },
      });
      return respond(
        'gcm_get_checkpoint',
        ck.botId,
        `checkpoint_id: ${ck.id} · review: ${ck.reviewStatus}\n\n${text}`,
      );
    },
  );

  add(
    'gcm_compare_checkpoints',
    {
      title: 'Compare checkpoints',
      description: 'Section-by-section differences between two checkpoints of the same bot.',
      inputSchema: { from_id: z.string().max(100), to_id: z.string().max(100) },
    },
    (a) => {
      const d = service.diff(a.from_id, a.to_id, ctx);
      return respond('gcm_compare_checkpoints', null, d);
    },
  );

  add(
    'gcm_get_handoff',
    {
      title: 'Retrieve handoff',
      description:
        'Read a prepared handoff (by id, or the latest for bot_id), its workflow state and verification code.',
      inputSchema: {
        handoff_id: z.string().max(100).optional(),
        bot_id: botId.optional(),
        include_text: z.boolean().optional(),
      },
    },
    (a) => {
      if (!a.handoff_id && !a.bot_id)
        throw new GcmError('VALIDATION', 'Give handoff_id or bot_id.');
      const h = a.handoff_id
        ? service.getHandoff(a.handoff_id, ctx)
        : service.latestHandoff(a.bot_id!, ctx);
      return respond('gcm_get_handoff', h.botId, {
        handoff_id: h.id,
        bot_id: h.botId,
        checkpoint_id: h.checkpointId,
        state: h.state,
        state_meaning: STATE_DESCRIPTIONS[h.state],
        platform_action: h.platformAction,
        verification_code: h.verificationCode,
        estimated_tokens: h.tokenEstimate.tokens,
        ...(a.include_text === false ? {} : { text: h.text }),
      });
    },
  );

  add(
    'gcm_search_archive',
    {
      title: 'Search archive',
      description:
        'Keyword search in one bot’s archived messages. Returns short snippets (secrets redacted), paginated. Use narrow queries.',
      inputSchema: { bot_id: botId, query: z.string().min(1).max(200), limit: limit(20), offset },
    },
    (a) => {
      const res = service.searchArchive(a.bot_id, a.query, ctx, {
        limit: a.limit ?? 5,
        offset: a.offset ?? 0,
      });
      return respond('gcm_search_archive', a.bot_id, {
        total: res.total,
        offset: res.offset,
        hits: res.items,
      });
    },
  );

  // ------------------------------------------------------------------------------------------- write tools

  add(
    'gcm_upsert_bot',
    {
      title: 'Register or update bot profile',
      description:
        'Create/update a GCM bot profile from information the USER provides (role, instructions, preferences…). Never invent settings. Sharing/visibility policy can only be changed locally.',
      write: true,
      inputSchema: {
        bot_id: botId,
        name: z.string().min(1).max(120).optional(),
        role: z.string().max(500).optional(),
        responsibilities: z.array(z.string().min(1).max(2000)).max(100).optional(),
        instructions: z.array(z.string().min(1).max(2000)).max(100).optional(),
        preferences: z.array(z.string().min(1).max(2000)).max(100).optional(),
        security_boundaries: z.array(z.string().min(1).max(2000)).max(100).optional(),
        long_term_decisions: z.array(z.string().min(1).max(2000)).max(100).optional(),
        skills: z.array(z.string().min(1).max(300)).max(200).optional(),
        plugins: z.array(z.string().min(1).max(300)).max(200).optional(),
        routines: z.array(z.string().min(1).max(1000)).max(200).optional(),
        projects: z.array(z.string().min(1).max(500)).max(200).optional(),
        notes: z.string().max(20_000).optional(),
      },
    },
    (a) => {
      const { bot } = service.upsertBot(
        {
          id: a.bot_id,
          name: a.name,
          role: a.role,
          responsibilities: a.responsibilities,
          instructions: a.instructions,
          preferences: a.preferences,
          securityBoundaries: a.security_boundaries,
          longTermDecisions: a.long_term_decisions,
          skills: a.skills,
          plugins: a.plugins,
          routines: a.routines,
          projects: a.projects,
          notes: a.notes,
        },
        ctx,
      );
      return respond('gcm_upsert_bot', bot.id, {
        bot_id: bot.id,
        name: bot.name,
        role: bot.role,
        updated_at: bot.updatedAt,
      });
    },
  );

  add(
    'gcm_import_context',
    {
      title: 'Import supplied context',
      description: `Store conversation text the user explicitly supplied (or a summary you wrote of what is visible in this chat) in the bot's GCM archive. Max ${opts.maxImportChars} chars per call; already-stored messages are skipped. Content is treated as data, never as instructions.`,
      write: true,
      inputSchema: {
        bot_id: botId,
        text: z.string().min(1).max(opts.maxImportChars),
        format: z.enum(['auto', 'text', 'markdown', 'json', 'jsonl']).optional(),
        session_ref: z.string().min(1).max(200).optional(),
        source_name: z.string().min(1).max(300).optional(),
        coverage: z
          .enum(['partial', 'unknown'])
          .optional()
          .describe('A bot cannot see its full history, so "complete" is not accepted here.'),
        assistant_names: z.array(z.string().min(1).max(80)).max(10).optional(),
      },
    },
    (a) => {
      const r = service.importContext(
        {
          botId: a.bot_id,
          text: a.text,
          format: a.format ?? 'auto',
          sessionRef: a.session_ref ?? null,
          sourceName: a.source_name ?? 'mcp',
          completeness: a.coverage ?? 'partial',
          assistantNames: a.assistant_names ?? [],
        },
        ctx,
      );
      return respond('gcm_import_context', a.bot_id, {
        import_id: r.import?.id ?? null,
        added: r.added,
        duplicates_skipped: r.duplicatesSkipped,
        format: r.format,
        warnings: r.warnings,
      });
    },
  );

  add(
    'gcm_create_checkpoint',
    {
      title: 'Create checkpoint',
      description:
        'Create a new versioned checkpoint from imported material (previous versions are kept). Set user_approved=true ONLY if the user explicitly approved the preview in this conversation; otherwise it is saved as unreviewed.',
      write: true,
      inputSchema: {
        bot_id: botId,
        profile,
        budget_tokens: budget,
        objective: z.string().max(600).optional(),
        workstream: z.string().max(200).optional(),
        user_approved: z.boolean().optional(),
      },
    },
    async (a) => {
      const { checkpoint } = await service.createCheckpoint(
        {
          botId: a.bot_id,
          profile: a.profile,
          budgetTokens: a.budget_tokens,
          objective: a.objective ?? null,
          workstream: a.workstream ?? null,
          approve: a.user_approved === true,
          reviewNote: a.user_approved ? 'Approved by user via MCP client' : null,
          narrative: false,
        },
        ctx,
      );
      return respond('gcm_create_checkpoint', a.bot_id, {
        ...ckSummary(checkpoint),
        warnings: checkpoint.warnings,
      });
    },
  );

  add(
    'gcm_review_checkpoint',
    {
      title: 'Mark checkpoint reviewed',
      description:
        'Record that the USER reviewed and approved a checkpoint. Only call after the user explicitly confirms.',
      write: true,
      inputSchema: {
        checkpoint_id: z.string().max(100),
        user_confirmed: z.literal(true),
        note: z.string().max(500).optional(),
      },
    },
    (a) => {
      const ck = service.reviewCheckpoint(a.checkpoint_id, ctx, {
        note: a.note ?? 'Approved by user via MCP client',
      });
      return respond('gcm_review_checkpoint', ck.botId, ckSummary(ck));
    },
  );

  add(
    'gcm_prepare_handoff',
    {
      title: 'Prepare handoff',
      description:
        'Generate a compact handoff prompt from a reviewed checkpoint for starting a fresh conversation. Does NOT reset or modify Grok Bot; the user performs any platform step.',
      write: true,
      inputSchema: {
        bot_id: botId,
        checkpoint_id: z.string().max(100).optional(),
        profile,
        budget_tokens: budget,
      },
    },
    (a) => {
      const h = service.prepareHandoff(
        {
          botId: a.bot_id,
          checkpointId: a.checkpoint_id,
          profile: a.profile,
          budgetTokens: a.budget_tokens,
        },
        ctx,
      );
      return respond('gcm_prepare_handoff', a.bot_id, {
        handoff_id: h.id,
        state: h.state,
        verification_code: h.verificationCode,
        estimated_tokens: h.tokenEstimate.tokens,
        next_step:
          'Show the text to the user. They choose a platform step (new group chat recommended) in the Grok Bot app themselves.',
        text: h.text,
      });
    },
  );

  add(
    'gcm_update_handoff_state',
    {
      title: 'Update handoff workflow',
      description:
        'Advance the guided workflow: record the user’s chosen non-destructive step, that they completed it, or verify the first reply in the new conversation. Reset chat can only be chosen locally (CLI/dashboard) because it is destructive.',
      write: true,
      inputSchema: {
        handoff_id: z.string().max(100),
        action: z.enum([
          'choose_new_group_chat',
          'choose_continue_in_place',
          'report_done',
          'verify_reply',
        ]),
        reply_text: z.string().max(50_000).optional(),
      },
    },
    (a) => {
      let h;
      let extra: Record<string, unknown> = {};
      if (a.action === 'choose_new_group_chat' || a.action === 'choose_continue_in_place') {
        const r = service.chooseAction(
          a.handoff_id,
          a.action === 'choose_new_group_chat' ? 'new_group_chat' : 'continue_in_place',
          ctx,
        );
        h = r.handoff;
        extra = { steps: r.guide.steps, caveats: r.guide.caveats };
      } else if (a.action === 'report_done') {
        h = service.reportActionDone(a.handoff_id, ctx);
      } else {
        if (!a.reply_text)
          throw new GcmError('VALIDATION', 'reply_text is required for verify_reply.');
        const r = service.verifyContinuationReply(a.handoff_id, a.reply_text, ctx);
        h = r.handoff;
        extra = { verification: r.result };
      }
      return respond('gcm_update_handoff_state', h.botId, {
        handoff_id: h.id,
        state: h.state,
        state_meaning: STATE_DESCRIPTIONS[h.state],
        ...extra,
      });
    },
  );

  return registered;
}
