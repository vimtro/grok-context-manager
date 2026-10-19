/** All `gcm` commands. Every command maps onto GcmService; nothing here touches Grok Bot. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import {
  APP_VERSION,
  BotIdSchema,
  CAPABILITIES_CHECKED_AT,
  GcmError,
  isLoopbackUrl,
  LOCAL_ACCESS,
  loadTokenizer,
  renderHandoff,
  STATE_DESCRIPTIONS,
  type BotPatch,
  type CheckpointRecord,
  type GcmService,
  type HandoffRecord,
  type PlatformAction,
  type ProfileName,
  type TokenMethod,
} from '@gcm/core';
import { startDashboard } from '@gcm/dashboard/server';
import { createApiToken, serveHttp, serveStdio } from '@gcm/mcp-server';
import {
  defaultDataDir,
  openService,
  safeInputPath,
  safeOutputPath,
  type SqliteStore,
} from '@gcm/storage';
import { c, emit, info, mode, out, table, warn, stateColor } from './output';

// ------------------------------------------------------------------------------------------------ context

let opened: { service: GcmService; store: SqliteStore } | null = null;
let homeOverride: string | undefined;

export function setHome(dir: string | undefined): void {
  homeOverride = dir ? path.resolve(dir) : undefined;
}
export function dataDir(): string {
  return homeOverride ?? defaultDataDir();
}
function svc(): GcmService {
  if (!opened) opened = openService(dataDir());
  return opened.service;
}
function store(): SqliteStore {
  svc();
  return opened!.store;
}
/** Loads the o200k tables only when the user configured that method (keeps startup fast otherwise). */
export async function preloadTokenizer(): Promise<void> {
  await loadTokenizer(svc().settings().tokenMethod);
}

export function closeAll(): void {
  opened?.store.close();
  opened = null;
}

export function dashboardAssetsDir(): string {
  // In the bundled CLI the client lives next to gcm.mjs (dist/dashboard).
  return (
    process.env.GCM_DASHBOARD_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard')
  );
}

const ctx = LOCAL_ACCESS;
const collect = (v: string, prev: string[]) => [...prev, v];
const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const int = (name: string) => (v: string) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || String(n) !== v.trim())
    throw new GcmError('VALIDATION', `${name} must be a whole number.`);
  return n;
};
const profileOpt = (v: string): ProfileName => {
  if (!['compact', 'balanced', 'detailed'].includes(v))
    throw new GcmError('VALIDATION', 'Profile must be compact, balanced or detailed.');
  return v as ProfileName;
};
function requireBot(id: string | undefined): string {
  if (!id)
    throw new GcmError(
      'VALIDATION',
      'Missing --bot <id>.',
      'Run `grokcm bots list` to see bot IDs.',
    );
  if (!BotIdSchema.safeParse(id).success)
    throw new GcmError('VALIDATION', `Invalid bot ID "${id}".`);
  return id;
}

async function readInput(file: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
  }
  return readFileSync(safeInputPath(file), 'utf8').replace(/^\uFEFF/, '');
}

function writeOutput(file: string, content: string, force: boolean): string {
  const target = safeOutputPath(file, { force, dataDir: dataDir() });
  writeFileSync(target, content, 'utf8');
  return target;
}

function resolveCheckpoint(ref: string, bot?: string): CheckpointRecord {
  if (ref === 'latest') return svc().latestCheckpoint(requireBot(bot), ctx);
  return svc().getCheckpoint(ref, ctx);
}
function resolveHandoff(ref: string, bot?: string): HandoffRecord {
  if (ref === 'latest') return svc().latestHandoff(requireBot(bot), ctx);
  return svc().getHandoff(ref, ctx);
}

function printCheckpointSummary(ck: CheckpointRecord): void {
  const cnt = ck.content;
  out(`${c.bold(`Checkpoint v${ck.version}`)} ${c.dim(ck.id)} for ${c.cyan(ck.botId)}`);
  out(
    `  created ${ck.createdAt} · review ${stateColor(ck.reviewStatus)} · coverage ${ck.source.completeness} · ~${ck.tokenEstimate.tokens} tokens (estimated)`,
  );
  if (ck.restoredFromId) out(`  restored from ${ck.restoredFromId}`);
  out(
    `  objective: ${cnt.objective ? `${cnt.objective.text} ${c.dim(`(${cnt.objective.basis})`)}` : c.dim('not stated')}`,
  );
  out(
    `  constraints ${cnt.constraints.length} · decisions ${cnt.decisions.length} · pending tasks ${cnt.pendingTasks.length} · open questions ${cnt.openQuestions.length} · conflicts ${cnt.conflicts.length}`,
  );
  out(
    `  excluded: temporary ${cnt.excluded.temporary}, obsolete ${cnt.excluded.obsolete}, historical ${cnt.excluded.historical}, quarantined ${cnt.excluded.quarantined}, over budget ${cnt.excluded.overBudget}`,
  );
  for (const w of ck.warnings) warn(w);
}

function openBrowser(url: string): void {
  try {
    const p =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', url], {
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
            detached: true,
            stdio: 'ignore',
          });
    p.on('error', () => info(`Open ${url} in your browser.`));
    p.unref();
  } catch {
    info(`Open ${url} in your browser.`);
  }
}

function waitForever(onStop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      void onStop().finally(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

// ------------------------------------------------------------------------------------------------ commands

export function registerCommands(program: Command): void {
  // ---------------------------------------------------------------------------- init / doctor
  program
    .command('init')
    .description('Create the local GCM data store and show where it lives')
    .action(() => {
      const s = svc();
      const info_ = s.store.info();
      emit(
        {
          dataDir: dataDir(),
          database: info_.path,
          schemaVersion: info_.schemaVersion,
          bots: s.listBots(ctx).length,
        },
        () => {
          out(`${c.green('✓')} GCM data store ready`);
          out(`  data folder: ${dataDir()}`);
          out(`  database:    ${info_.path} (schema v${info_.schemaVersion})`);
          out('');
          out('Next steps:');
          out('  grokcm bots add sales --name "Sales" --role "Account executive"');
          out('  grokcm import .\\sales-chat.txt --bot sales');
          out('  grokcm checkpoint create --bot sales');
        },
      );
    });

  program
    .command('doctor')
    .description('Check installation, storage integrity, providers and platform limitations')
    .option('--check-ollama', 'also probe the local Ollama endpoint')
    .action(async (o: { checkOllama?: boolean }) => {
      const checks: { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
      const major = Number(process.versions.node.split('.')[0]);
      checks.push({
        name: 'Node.js',
        status: major >= 22 ? 'ok' : major >= 20 ? 'warn' : 'fail',
        detail: `v${process.versions.node}${major < 22 ? ' — Node 22 or 24 LTS recommended (Node 20 is end-of-life and needs C++ build tools for SQLite on Windows)' : ''}`,
      });
      try {
        const s = svc();
        const h = s.health();
        checks.push({ name: 'Data folder', status: 'ok', detail: dataDir() });
        checks.push({
          name: 'Database',
          status: h.ok ? 'ok' : 'fail',
          detail: `${h.storage.path} · schema v${h.schemaVersion} · integrity ${h.storage.integrity.join(', ')}`,
        });
        checks.push({
          name: 'Archive search (FTS5)',
          status: h.storage.ftsEnabled ? 'ok' : 'fail',
          detail: h.storage.ftsEnabled ? 'available' : 'unavailable',
        });
        const p =
          s.settings().summarizer === 'ollama' || o.checkOllama ? await s.providerStatus() : null;
        checks.push({
          name: 'Summarizer',
          status: p && !p.status.ok ? 'warn' : 'ok',
          detail: p
            ? `${p.label}: ${p.status.detail}${p.status.ok ? '' : ' (deterministic engine will be used)'}`
            : 'deterministic offline engine (no model calls)',
        });
        const tokens = store()
          .listApiTokens()
          .filter((t) => !t.revokedAt).length;
        checks.push({ name: 'MCP API tokens', status: 'ok', detail: `${tokens} active` });
      } catch (e) {
        checks.push({ name: 'Database', status: 'fail', detail: (e as Error).message });
      }
      const assets = dashboardAssetsDir();
      checks.push({
        name: 'Dashboard assets',
        status: existsSync(path.join(assets, 'index.html')) ? 'ok' : 'warn',
        detail: assets,
      });
      checks.push({ name: 'Telemetry', status: 'ok', detail: 'none (GCM never sends usage data)' });
      const platform = [
        'Grok Bot has no official API to compact, prune or reset a conversation — GCM never claims to do this.',
        'Reset chat is destructive and unconfirmed on some Windows builds; the default route is a new group chat with the bot.',
        'A remote MCP connector must be a public HTTPS URL; the cloud bot cannot reach your localhost.',
      ];
      emit(
        {
          version: APP_VERSION,
          checks,
          platformLimitations: platform,
          capabilitiesCheckedAt: CAPABILITIES_CHECKED_AT,
        },
        () => {
          out(c.bold(`GCM ${APP_VERSION} doctor`));
          for (const ch of checks) {
            const icon =
              ch.status === 'ok' ? c.green('✓') : ch.status === 'warn' ? c.yellow('!') : c.red('✗');
            out(`${icon} ${ch.name.padEnd(22)} ${ch.detail}`);
          }
          out('');
          out(c.bold(`Platform limitations (checked ${CAPABILITIES_CHECKED_AT}):`));
          for (const l of platform) out(`  - ${l}`);
        },
      );
      if (checks.some((ch) => ch.status === 'fail')) process.exitCode = 1;
    });

  // ---------------------------------------------------------------------------- bots
  const bots = program
    .command('bots')
    .description('Manage GCM bot profiles (identity is always user-provided)');
  bots
    .command('list')
    .description('List bot profiles with archive and checkpoint status')
    .action(() => {
      const list = svc().listBots(ctx);
      emit(list, () => {
        if (!list.length) return out('No bots yet. Add one: grokcm bots add sales --name "Sales"');
        table(
          list.map((b) => [
            b.id,
            b.name,
            b.messages,
            `~${b.archiveTokensEstimate}`,
            b.headCheckpoint
              ? `v${b.headCheckpoint.version} (${b.headCheckpoint.reviewStatus})`
              : '—',
            b.uncheckpointedImports,
            b.activeHandoffs,
          ]),
          [
            'ID',
            'NAME',
            'MESSAGES',
            'ARCHIVE TOKENS*',
            'LATEST CHECKPOINT',
            'NEW IMPORTS',
            'ACTIVE HANDOFFS',
          ],
        );
        out(c.dim('* locally estimated text size, not Grok Bot usage'));
        for (const b of list) for (const w of b.warnings) warn(`${b.id}: ${w}`);
      });
    });

  const botOptions = (cmd: Command) =>
    cmd
      .option('--name <name>', 'display name')
      .option('--role <role>', 'role / job description')
      .option('--responsibility <text>', 'responsibility (repeatable)', collect, [])
      .option('--instruction <text>', 'operating instruction (repeatable)', collect, [])
      .option('--preference <text>', 'working preference (repeatable)', collect, [])
      .option('--boundary <text>', 'security boundary (repeatable)', collect, [])
      .option('--decision <text>', 'long-term decision (repeatable)', collect, [])
      .option('--skill <name>', 'skill name (repeatable)', collect, [])
      .option('--plugin <name>', 'plugin/connector requirement (repeatable)', collect, [])
      .option('--routine <text>', 'routine description (repeatable)', collect, [])
      .option('--project <text>', 'project responsibility (repeatable)', collect, [])
      .option('--memory-ref <text>', 'long-term memory reference (repeatable)', collect, [])
      .option('--notes <text>', 'free-form notes')
      .option(
        '--profile <profile>',
        'default checkpoint profile: compact|balanced|detailed',
        profileOpt,
      )
      .option('--budget <tokens>', 'handoff token budget for this bot', int('--budget'))
      .option(
        '--warn-threshold <tokens>',
        'warn when this many estimated tokens are imported since the last checkpoint',
        int('--warn-threshold'),
      )
      .option(
        '--share-with <ids>',
        'comma-separated bot IDs allowed to READ this bot’s GCM data',
        csv,
      )
      .option('--hide-from-mcp', 'hide this bot from every MCP client')
      .option('--show-to-mcp', 'make this bot visible to MCP clients')
      .option('--from-file <file>', 'JSON file with profile fields (merged with flags)')
      .option('--dry-run', 'validate and show the result without saving');

  const toPatch = async (id: string, o: Record<string, unknown>): Promise<BotPatch> => {
    const fromFile = o.fromFile
      ? (JSON.parse(await readInput(String(o.fromFile))) as Record<string, unknown>)
      : {};
    const list = (k: string) =>
      (o[k] as string[] | undefined)?.length ? (o[k] as string[]) : undefined;
    const policy: Record<string, unknown> = {
      ...((fromFile.policy as Record<string, unknown>) ?? {}),
    };
    if (o.profile) policy.profile = o.profile;
    if (o.budget !== undefined) policy.handoffBudgetTokens = o.budget;
    if (o.warnThreshold !== undefined) policy.warnThresholdTokens = o.warnThreshold;
    if (o.shareWith) policy.shareWith = o.shareWith;
    if (o.hideFromMcp) policy.mcpExposed = false;
    if (o.showToMcp) policy.mcpExposed = true;
    const patch: Record<string, unknown> = {
      ...fromFile,
      id,
      name: o.name ?? fromFile.name,
      role: o.role ?? fromFile.role,
      responsibilities: list('responsibility') ?? fromFile.responsibilities,
      instructions: list('instruction') ?? fromFile.instructions,
      preferences: list('preference') ?? fromFile.preferences,
      securityBoundaries: list('boundary') ?? fromFile.securityBoundaries,
      longTermDecisions: list('decision') ?? fromFile.longTermDecisions,
      skills: list('skill') ?? fromFile.skills,
      plugins: list('plugin') ?? fromFile.plugins,
      routines: list('routine') ?? fromFile.routines,
      projects: list('project') ?? fromFile.projects,
      memoryReferences: list('memoryRef') ?? fromFile.memoryReferences,
      notes: o.notes ?? fromFile.notes,
      policy: Object.keys(policy).length ? policy : undefined,
    };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    return patch as BotPatch;
  };

  botOptions(
    bots
      .command('add <id>')
      .description('Register a bot profile (e.g. grokcm bots add sales --name "Sales")'),
  ).action(async (id: string, o: Record<string, unknown>) => {
    if (svc().store.getBot(id))
      throw new GcmError(
        'CONFLICT',
        `Bot "${id}" already exists.`,
        `Use \`grokcm bots update ${id}\`.`,
      );
    const r = svc().upsertBot(await toPatch(id, o), ctx, { dryRun: Boolean(o.dryRun) });
    emit(r, () =>
      out(
        `${o.dryRun ? c.yellow('[dry run] would create') : c.green('✓ created')} bot ${c.cyan(r.bot.id)} (${r.bot.name})`,
      ),
    );
  });
  bots
    .command('quick-add <names...>')
    .description(
      'Register several bots from their names only (e.g. grokcm bots quick-add Sales Research "Chief of Staff"; ' +
        'use "-" to read one name per line from stdin: Get-Clipboard | grokcm bots quick-add -)',
    )
    .option('--dry-run', 'show what would be added without saving')
    .action(async (names: string[], o: { dryRun?: boolean }) => {
      const text = names.length === 1 && names[0] === '-' ? await readInput('-') : names.join('\n');
      const r = svc().quickAddBots(text, ctx, { dryRun: Boolean(o.dryRun) });
      emit(r, () => {
        const list = (xs: { id: string; name: string }[]) =>
          xs.map((b) => `${c.cyan(b.id)} (${b.name})`).join(', ');
        if (r.created.length)
          out(
            `${o.dryRun ? c.yellow('[dry run] would add') : c.green('✓ added')} ${r.created.length} bot(s): ${list(r.created)}`,
          );
        if (r.existing.length) out(c.dim(`already registered: ${list(r.existing)}`));
        if (r.ignored.length) out(c.dim(`ignored (not bot names): ${r.ignored.join(', ')}`));
        if (!r.created.length && !r.existing.length) warn('No bot names found.');
      });
    });
  botOptions(
    bots
      .command('update <id>')
      .description('Update a bot profile (list flags replace the stored list)'),
  ).action(async (id: string, o: Record<string, unknown>) => {
    svc().getBot(id, ctx);
    const r = svc().upsertBot(await toPatch(id, o), ctx, { dryRun: Boolean(o.dryRun) });
    emit(r, () =>
      out(
        `${o.dryRun ? c.yellow('[dry run] would update') : c.green('✓ updated')} bot ${c.cyan(r.bot.id)}`,
      ),
    );
  });
  bots
    .command('show <id>')
    .description('Show a bot profile')
    .action((id: string) => {
      const bot = svc().getBot(id, ctx);
      emit(bot, () => {
        out(`${c.bold(bot.name)} ${c.dim(`(${bot.id})`)} — ${bot.role || c.dim('no role set')}`);
        const show = (label: string, xs: string[]) =>
          xs.length && out(`  ${label}:\n${xs.map((x) => `    - ${x}`).join('\n')}`);
        show('Responsibilities', bot.responsibilities);
        show('Instructions', bot.instructions);
        show('Preferences', bot.preferences);
        show('Security boundaries', bot.securityBoundaries);
        show('Long-term decisions', bot.longTermDecisions);
        show('Skills', bot.skills);
        show('Plugins', bot.plugins);
        show('Routines', bot.routines);
        show('Projects', bot.projects);
        show('Memory references', bot.memoryReferences);
        out(
          `  policy: profile ${bot.policy.profile}, budget ${bot.policy.handoffBudgetTokens ?? 'profile default'}, shares with [${bot.policy.shareWith.join(', ')}], MCP ${bot.policy.mcpExposed ? 'visible' : 'hidden'}`,
        );
        out(c.dim('  Identity is user-provided; GCM does not read Grok Bot settings.'));
      });
    });

  // ---------------------------------------------------------------------------- import / analyze
  program
    .command('import <file>')
    .description(
      'Import conversation text (file path, or "-" for stdin) into a bot’s local archive',
    )
    .requiredOption('--bot <id>', 'bot ID')
    .option('--format <format>', 'auto|text|markdown|json|jsonl', 'auto')
    .option(
      '--session <ref>',
      'session label (re-imports of the same session only add new messages)',
    )
    .option(
      '--complete',
      'assert this is the COMPLETE conversation (otherwise coverage is "unknown")',
    )
    .option('--partial', 'mark as a partial excerpt')
    .option('--note <text>', 'coverage note, e.g. "copied last 2 weeks only"')
    .option(
      '--assistant-name <name>',
      'speaker name that is the bot (repeatable; bot name/id are automatic)',
      collect,
      [],
    )
    .option('--user-name <name>', 'speaker name that is the human user (repeatable)', collect, [])
    .option('--dry-run', 'parse and report without saving')
    .action(async (file: string, o: Record<string, unknown>) => {
      const bot = requireBot(o.bot as string);
      const text = await readInput(file);
      const r = svc().importContext(
        {
          botId: bot,
          text,
          format: o.format as never,
          sessionRef: (o.session as string) ?? null,
          sourceName: file === '-' ? 'stdin' : path.basename(file),
          completeness: o.complete ? 'complete' : o.partial ? 'partial' : 'unknown',
          completenessNote: (o.note as string) ?? null,
          assistantNames: o.assistantName as string[],
          userNames: o.userName as string[],
        },
        ctx,
        { dryRun: Boolean(o.dryRun) },
      );
      emit(r, () => {
        out(
          `${o.dryRun ? c.yellow('[dry run]') : c.green('✓')} ${r.added} new message(s) ${o.dryRun ? 'would be imported' : 'imported'} for ${c.cyan(bot)} (format ${r.format}, ${r.duplicatesSkipped} duplicate(s) skipped)`,
        );
        if (r.import)
          out(
            `  import ${r.import.id} · ~${r.import.tokenEstimate} tokens (estimated) · coverage ${r.import.completeness}`,
          );
        for (const w of r.warnings) warn(w);
      });
    });

  const analysisOptions = (cmd: Command) =>
    cmd
      .requiredOption('--bot <id>', 'bot ID')
      .option('--profile <profile>', 'compact|balanced|detailed', profileOpt)
      .option('--budget <tokens>', 'handoff token budget', int('--budget'))
      .option('--objective <text>', 'state the current objective explicitly')
      .option('--workstream <name>', 'project / workstream label')
      .option('--import <id>', 'only use these import IDs (repeatable)', collect, [])
      .option('--rebuild', 'ignore the previous checkpoint and rebuild from all imports');

  const runAnalyze = (o: Record<string, unknown>) =>
    svc().analyze(
      {
        botId: requireBot(o.bot as string),
        profile: o.profile as ProfileName | undefined,
        budgetTokens: o.budget as number | undefined,
        objective: (o.objective as string) ?? null,
        workstream: (o.workstream as string) ?? null,
        importIds: (o.import as string[]).length ? (o.import as string[]) : undefined,
        rebuild: Boolean(o.rebuild),
      },
      ctx,
    );

  const printAnalysis = (o: Record<string, unknown>) => {
    const p = runAnalyze(o);
    const cnt = p.result.content;
    emit(o.showItems ? p : { ...p, result: { ...p.result, items: undefined } }, () => {
      out(
        c.bold(`Analysis preview for ${p.botId}`) +
          c.dim(` (nothing saved${p.cacheHit ? ', cached result' : ''})`),
      );
      out(
        `  sources: ${p.importIds.length} new import(s)${p.previousCheckpointId ? ` + previous checkpoint ${p.previousCheckpointId}` : ''} · coverage ${p.result.completeness}`,
      );
      out(
        `  source size ~${cnt.stats.sourceTokensEstimate} tokens → handoff ~${p.result.handoffPreviewTokens} tokens (estimated, budget ${p.budgetTokens})`,
      );
      table(
        [
          ['constraints', cnt.constraints.length],
          ['decisions', cnt.decisions.length],
          ['pending tasks', cnt.pendingTasks.length],
          ['open questions', cnt.openQuestions.length],
          ['progress', cnt.progress.length],
          ['knowledge', cnt.knowledge.length],
          ['conflicts (need review)', cnt.conflicts.length],
          [
            'excluded temporary/obsolete/historical',
            `${cnt.excluded.temporary}/${cnt.excluded.obsolete}/${cnt.excluded.historical}`,
          ],
          ['quarantined (instruction-like)', cnt.excluded.quarantined],
        ],
        ['RETAINED', 'COUNT'],
      );
      for (const cf of cnt.conflicts) warn(`conflict: “${cf.texts[0]}” vs “${cf.texts[1]}”`);
      for (const u of cnt.uncertainties) out(`  ${c.yellow('?')} ${u}`);
      for (const w of p.result.warnings) warn(w);
      if (!p.validation.ok) for (const e of p.validation.errors) out(`  ${c.red('✗')} ${e}`);
      if (o.showItems)
        for (const i of p.result.items)
          out(
            `  [${i.category}/${i.kind}${i.protected ? '*' : ''}] ${i.text.slice(0, 100)} ${c.dim(`— ${i.reason}`)}`,
          );
      if (o.showHandoff) out(`\n${p.handoffPreview}`);
      out(
        c.dim(
          `\nSave it with: grokcm checkpoint create --bot ${p.botId}${o.profile ? ` --profile ${String(o.profile)}` : ''}`,
        ),
      );
    });
  };

  analysisOptions(
    program
      .command('analyze')
      .description('Preview what a checkpoint would retain (saves nothing)'),
  )
    .option('--show-items', 'list every classified item with its reason')
    .option('--show-handoff', 'print the handoff preview')
    .action((o: Record<string, unknown>) => printAnalysis(o));

  analysisOptions(
    program
      .command('compact')
      .description('Analyze and, with --save, create a checkpoint in one step'),
  )
    .option('--save', 'save the result as a new checkpoint version')
    .option('--approve', 'with --save: mark the checkpoint reviewed')
    .option('--show-handoff', 'print the handoff preview')
    .action(async (o: Record<string, unknown>) => {
      printAnalysis(o);
      if (o.save) await createCheckpointCmd(o);
    });

  // ---------------------------------------------------------------------------- checkpoints
  const ck = program
    .command('checkpoint')
    .description('Versioned checkpoints of GCM-managed context');

  const createCheckpointCmd = async (o: Record<string, unknown>) => {
    const r = await svc().createCheckpoint(
      {
        botId: requireBot(o.bot as string),
        profile: o.profile as ProfileName | undefined,
        budgetTokens: o.budget as number | undefined,
        objective: (o.objective as string) ?? null,
        workstream: (o.workstream as string) ?? null,
        importIds: (o.import as string[] | undefined)?.length ? (o.import as string[]) : undefined,
        rebuild: Boolean(o.rebuild),
        approve: Boolean(o.approve),
        reviewNote: (o.note as string) ?? null,
        narrative: o.narrative === false ? false : undefined,
      },
      ctx,
      { dryRun: Boolean(o.dryRun) },
    );
    emit(r, () => {
      out(
        r.saved
          ? `${c.green('✓')} saved checkpoint v${r.checkpoint.version} (${r.checkpoint.id})`
          : c.yellow('[dry run] checkpoint not saved'),
      );
      printCheckpointSummary(r.checkpoint);
      if (r.checkpoint.reviewStatus !== 'reviewed') {
        out(
          c.dim(
            `Review it (grokcm checkpoint show ${r.checkpoint.id} --format markdown), then approve: grokcm checkpoint review ${r.checkpoint.id}`,
          ),
        );
      }
    });
  };

  analysisOptions(
    ck
      .command('create')
      .description('Create a new checkpoint version (never overwrites earlier ones)'),
  )
    .option('--approve', 'mark reviewed now (you have checked the preview)')
    .option('--note <text>', 'review note')
    .option('--no-narrative', 'skip the optional local-model narrative')
    .option('--dry-run', 'build and validate without saving')
    .action((o: Record<string, unknown>) => createCheckpointCmd(o));

  ck.command('list')
    .description('List checkpoint versions for a bot')
    .requiredOption('--bot <id>', 'bot ID')
    .option('--limit <n>', 'page size', int('--limit'), 20)
    .option('--offset <n>', 'offset', int('--offset'), 0)
    .action((o: { bot: string; limit: number; offset: number }) => {
      const page = svc().listCheckpoints(requireBot(o.bot), ctx, {
        limit: o.limit,
        offset: o.offset,
      });
      emit(page, () => {
        if (!page.items.length) return out('No checkpoints yet.');
        table(
          page.items.map((x) => [
            `v${x.version}`,
            x.id,
            x.createdAt.slice(0, 19),
            x.reviewStatus,
            `~${x.tokenEstimate.tokens}`,
            x.content.pendingTasks.length,
            x.content.conflicts.length,
            x.restoredFromId ? 'restored' : '',
          ]),
          ['VER', 'ID', 'CREATED', 'REVIEW', 'TOKENS*', 'TASKS', 'CONFLICTS', ''],
        );
        out(c.dim(`${page.offset + page.items.length} of ${page.total} · * estimated`));
      });
    });

  ck.command('show <id>')
    .description('Show a checkpoint ("latest" with --bot)')
    .option('--bot <id>', 'bot ID (with "latest")')
    .option('--format <format>', 'summary|markdown|handoff|json', 'summary')
    .action((id: string, o: { bot?: string; format: string }) => {
      const x = resolveCheckpoint(id, o.bot);
      if (o.format === 'json' || mode.json) return out(svc().exportCheckpoint(x.id, 'json', ctx));
      if (o.format === 'markdown') return out(svc().exportCheckpoint(x.id, 'markdown', ctx));
      if (o.format === 'handoff') {
        return out(
          renderHandoff(x.content, {
            verificationCode: `v${x.version}`,
            version: x.version,
            createdAt: x.createdAt,
            completeness: x.source.completeness,
            archive: { imports: x.source.importIds.length, messages: x.source.messageCount },
          }),
        );
      }
      printCheckpointSummary(x);
    });

  ck.command('diff <from> <to>')
    .description('Compare two checkpoints of the same bot')
    .action((from: string, to: string) => {
      const d = svc().diff(from, to, ctx);
      emit(d, () => {
        out(c.bold(`v${d.from.version} → v${d.to.version}: ${d.summary}`));
        if (d.objective.changed)
          out(`  objective: ${d.objective.before ?? '—'}\n          → ${d.objective.after ?? '—'}`);
        for (const [name, s] of Object.entries(d.sections)) {
          for (const a of s.added) out(`  ${c.green('+')} [${name}] ${a}`);
          for (const r of s.removed) out(`  ${c.red('-')} [${name}] ${r}`);
          for (const ch of s.changed)
            out(`  ${c.yellow('~')} [${name}] ${ch.before} → ${ch.after}`);
        }
        out(
          c.dim(
            `  tokens (estimated): ${d.tokens.before} → ${d.tokens.after}; conflicts ${d.conflicts.before} → ${d.conflicts.after}`,
          ),
        );
      });
    });

  ck.command('verify <id>')
    .description('Verify a checkpoint’s content hash and the integrity of its source archive')
    .option('--bot <id>', 'bot ID (with "latest")')
    .action((id: string, o: { bot?: string }) => {
      const x = resolveCheckpoint(id, o.bot);
      const r = svc().verifyCheckpoint(x.id, ctx);
      emit(r, () => {
        out(
          `${r.checkpointOk && r.archiveOk ? c.green('✓ verified') : c.red('✗ verification failed')} ${x.id}`,
        );
        for (const d of r.details) out(`  ${d}`);
      });
      if (!r.checkpointOk || !r.archiveOk) process.exitCode = 4;
    });

  ck.command('review <id>')
    .description('Mark a checkpoint reviewed (approve it for handoffs)')
    .option('--bot <id>', 'bot ID (with "latest")')
    .option('--note <text>', 'review note')
    .option('--unapprove', 'set back to unreviewed')
    .action((id: string, o: { bot?: string; note?: string; unapprove?: boolean }) => {
      const x = resolveCheckpoint(id, o.bot);
      const r = svc().reviewCheckpoint(x.id, ctx, {
        note: o.note ?? null,
        status: o.unapprove ? 'unreviewed' : 'reviewed',
      });
      emit(r, () =>
        out(`${c.green('✓')} checkpoint v${r.version} is now ${stateColor(r.reviewStatus)}`),
      );
    });

  ck.command('restore <id>')
    .description('Restore an earlier checkpoint as a NEW head version (history is kept)')
    .option('--dry-run', 'show what would happen')
    .action((id: string, o: { dryRun?: boolean }) => {
      const r = svc().restoreCheckpoint(id, ctx, { dryRun: Boolean(o.dryRun) });
      emit(r, () =>
        out(
          `${o.dryRun ? c.yellow('[dry run] would create') : c.green('✓ created')} v${r.version} restored from ${id}. GCM-managed context only; Grok Bot is not changed.`,
        ),
      );
    });

  ck.command('export <id>')
    .description('Export a checkpoint as JSON (re-importable) or Markdown')
    .option('--bot <id>', 'bot ID (with "latest")')
    .option('--format <format>', 'json|markdown', 'json')
    .option('--out <file>', 'write to a file instead of stdout')
    .option('--force', 'overwrite an existing file')
    .action((id: string, o: { bot?: string; format: string; out?: string; force?: boolean }) => {
      const x = resolveCheckpoint(id, o.bot);
      const content = svc().exportCheckpoint(
        x.id,
        o.format === 'markdown' ? 'markdown' : 'json',
        ctx,
      );
      if (!o.out) return out(content);
      const target = writeOutput(o.out, content, Boolean(o.force));
      info(`${c.green('✓')} wrote ${target}`);
    });

  ck.command('import <file>')
    .description(
      'Restore a checkpoint from an exported JSON file (integrity-checked) as a new version',
    )
    .option('--as-bot <id>', 'import into a different bot (explicit cross-bot import)')
    .option('--dry-run', 'validate without saving')
    .action(async (file: string, o: { asBot?: string; dryRun?: boolean }) => {
      const r = svc().importCheckpointFile(await readInput(file), ctx, {
        asBot: o.asBot,
        dryRun: Boolean(o.dryRun),
      });
      emit(r, () => {
        out(
          `${o.dryRun ? c.yellow('[dry run] valid;') : c.green('✓')} checkpoint v${r.version} for ${r.botId} (from ${r.restoredFromId})`,
        );
        for (const w of r.warnings) warn(w);
      });
    });

  // ---------------------------------------------------------------------------- handoffs
  const ho = program
    .command('handoff')
    .description('Compact handoffs and the guided fresh-conversation workflow');

  ho.command('prepare')
    .description('Generate a compact handoff prompt from the latest (or given) reviewed checkpoint')
    .requiredOption('--bot <id>', 'bot ID')
    .option('--checkpoint <id>', 'checkpoint ID (default: latest)')
    .option('--profile <profile>', 'compact|balanced|detailed', profileOpt)
    .option('--budget <tokens>', 'token budget', int('--budget'))
    .option('--allow-unreviewed', 'allow an unreviewed checkpoint')
    .option('--out <file>', 'also write the handoff text to a file')
    .option('--force', 'overwrite --out file')
    .action((o: Record<string, unknown>) => {
      const h = svc().prepareHandoff(
        {
          botId: requireBot(o.bot as string),
          checkpointId: o.checkpoint as string | undefined,
          profile: o.profile as ProfileName | undefined,
          budgetTokens: o.budget as number | undefined,
          allowUnreviewed: Boolean(o.allowUnreviewed),
        },
        ctx,
      );
      if (o.out)
        info(`${c.green('✓')} wrote ${writeOutput(String(o.out), h.text, Boolean(o.force))}`);
      emit(h, () => {
        out(
          `${c.green('✓')} handoff ${h.id} ready · ~${h.tokenEstimate.tokens} tokens (estimated) · code ${c.bold(h.verificationCode)}`,
        );
        out(c.dim('──────── copy everything between the lines into the new conversation ────────'));
        out(h.text);
        out(
          c.dim('──────────────────────────────────────────────────────────────────────────────'),
        );
        out(`Next: choose how to continue → grokcm handoff action ${h.id} new_group_chat`);
        out(
          c.dim(
            'Tip (PowerShell): grokcm handoff show latest --bot ' +
              h.botId +
              ' --text-only | Set-Clipboard',
          ),
        );
      });
    });

  ho.command('show <id>')
    .description('Show a handoff ("latest" with --bot)')
    .option('--bot <id>', 'bot ID (with "latest")')
    .option('--text-only', 'print only the handoff text (for piping to the clipboard)')
    .action((id: string, o: { bot?: string; textOnly?: boolean }) => {
      const h = resolveHandoff(id, o.bot);
      if (o.textOnly) return out(h.text);
      emit(h, () => {
        out(
          `${c.bold(`Handoff ${h.id}`)} for ${c.cyan(h.botId)} · ${stateColor(h.state)} · code ${h.verificationCode} · ~${h.tokenEstimate.tokens} tokens (estimated)`,
        );
        out(`  ${STATE_DESCRIPTIONS[h.state]}`);
        for (const e of h.events) out(`  ${c.dim(e.at.slice(0, 19))} ${e.state}: ${e.note}`);
        out('');
        out(h.text);
      });
    });

  ho.command('list')
    .description('List handoffs')
    .option('--bot <id>', 'bot ID')
    .option('--limit <n>', 'page size', int('--limit'), 20)
    .action((o: { bot?: string; limit: number }) => {
      const page = svc().listHandoffs(o.bot ?? null, ctx, { limit: o.limit, offset: 0 });
      emit(page, () => {
        if (!page.items.length) return out('No handoffs yet.');
        table(
          page.items.map((h) => [
            h.id,
            h.botId,
            h.createdAt.slice(0, 19),
            h.state,
            h.platformAction ?? '—',
            `~${h.tokenEstimate.tokens}`,
          ]),
          ['ID', 'BOT', 'CREATED', 'STATE', 'ACTION', 'TOKENS*'],
        );
      });
    });

  ho.command('action <id> <action>')
    .description(
      'Choose the platform step: new_group_chat (recommended) | reset_chat (destructive) | continue_in_place',
    )
    .option(
      '--i-understand-transcript-loss',
      'required for reset_chat: the Grok Bot transcript will be permanently cleared',
    )
    .action((id: string, action: string, o: { iUnderstandTranscriptLoss?: boolean }) => {
      if (!['new_group_chat', 'reset_chat', 'continue_in_place'].includes(action)) {
        throw new GcmError(
          'VALIDATION',
          'Action must be new_group_chat, reset_chat or continue_in_place.',
        );
      }
      const r = svc().chooseAction(id, action as PlatformAction, ctx, {
        acknowledgeDestructive: Boolean(o.iUnderstandTranscriptLoss),
      });
      emit(r, () => {
        out(c.bold(r.guide.title));
        r.guide.steps.forEach((s, i) => out(`  ${i + 1}. ${s}`));
        for (const cv of r.guide.caveats) out(`  ${c.yellow('!')} ${cv}`);
        out(
          c.dim(`GCM does not perform this step. When you have done it: grokcm handoff done ${id}`),
        );
      });
    });

  ho.command('done <id>')
    .description(
      'Record that you performed the platform step (state becomes EXTERNAL_RESET_UNVERIFIED)',
    )
    .option('--note <text>', 'optional note')
    .action((id: string, o: { note?: string }) => {
      const h = svc().reportActionDone(id, ctx, o.note);
      emit(h, () => {
        out(`${stateColor(h.state)} — ${STATE_DESCRIPTIONS[h.state]}`);
        out(
          c.dim(
            `Paste the bot's first reply to verify: grokcm handoff verify ${id} --reply-file reply.txt`,
          ),
        );
      });
    });

  ho.command('verify <id>')
    .description('Verify the bot’s first reply in the new conversation')
    .option('--reply <text>', 'the reply text')
    .option('--reply-file <file>', 'file containing the reply ("-" for stdin)')
    .action(async (id: string, o: { reply?: string; replyFile?: string }) => {
      const reply = o.replyFile ? await readInput(o.replyFile) : (o.reply ?? '');
      const r = svc().verifyContinuationReply(id, reply, ctx);
      emit(r, () => {
        out(`${stateColor(r.handoff.state)} — ${STATE_DESCRIPTIONS[r.handoff.state]}`);
        for (const ch of r.result.checks)
          out(`  ${ch.passed ? c.green('✓') : c.red('✗')} ${ch.name}: ${ch.detail}`);
      });
      if (!r.result.passed) process.exitCode = 1;
    });

  ho.command('retry <id>')
    .description('Return a failed handoff to HANDOFF_READY')
    .action((id: string) => {
      const h = svc().retryHandoff(id, ctx);
      emit(h, () => out(`${stateColor(h.state)} — ${STATE_DESCRIPTIONS[h.state]}`));
    });

  // ---------------------------------------------------------------------------- archive
  const ar = program
    .command('archive')
    .description('Local archive of imported conversation material');
  ar.command('list')
    .description('List imports for a bot')
    .requiredOption('--bot <id>', 'bot ID')
    .action((o: { bot: string }) => {
      const page = svc().listImports(requireBot(o.bot), ctx, { limit: 1000, offset: 0 });
      emit(page, () =>
        table(
          page.items.map((i) => [
            i.id,
            i.importedAt.slice(0, 19),
            i.sessionRef ?? '—',
            i.sourceName ?? '—',
            i.messageCount,
            `~${i.tokenEstimate}`,
            i.completeness,
          ]),
          ['IMPORT', 'IMPORTED', 'SESSION', 'SOURCE', 'MESSAGES', 'TOKENS*', 'COVERAGE'],
        ),
      );
    });
  ar.command('search <query...>')
    .description('Keyword search in a bot’s archive (snippets, secrets redacted)')
    .requiredOption('--bot <id>', 'bot ID')
    .option('--limit <n>', 'page size', int('--limit'), 10)
    .option('--offset <n>', 'offset', int('--offset'), 0)
    .action((query: string[], o: { bot: string; limit: number; offset: number }) => {
      const r = svc().searchArchive(requireBot(o.bot), query.join(' '), ctx, {
        limit: o.limit,
        offset: o.offset,
      });
      emit(r, () => {
        out(c.dim(`${r.total} match(es)`));
        for (const h of r.items)
          out(
            `  ${c.cyan(`${h.importId}#${h.seq}`)} ${c.dim(h.role)} ${h.snippet.replace(/\s+/g, ' ')}`,
          );
      });
    });
  ar.command('import <file>')
    .description('Restore imports from a `grokcm archive export --format json` file')
    .option('--as-bot <id>', 'restore into a different bot (explicit cross-bot restore)')
    .option('--dry-run', 'validate and count without saving')
    .action(async (file: string, o: { asBot?: string; dryRun?: boolean }) => {
      const r = svc().importArchiveExport(await readInput(file), ctx, {
        asBot: o.asBot,
        dryRun: Boolean(o.dryRun),
      });
      emit(r, () => {
        out(
          `${o.dryRun ? c.yellow('[dry run]') : c.green('✓')} ${r.added} message(s) in ${r.imports} import(s) restored for ${c.cyan(r.botId)} (${r.duplicatesSkipped} already present)`,
        );
        for (const w of r.warnings) warn(w);
      });
    });
  ar.command('export')
    .description('Export a bot’s archive (secrets redacted unless --include-secrets)')
    .requiredOption('--bot <id>', 'bot ID')
    .option('--import <id>', 'only this import')
    .option('--format <format>', 'markdown|json', 'markdown')
    .requiredOption('--out <file>', 'output file')
    .option('--include-secrets', 'do not redact secret-like values')
    .option('--force', 'overwrite an existing file')
    .action(
      (o: {
        bot: string;
        import?: string;
        format: string;
        out: string;
        includeSecrets?: boolean;
        force?: boolean;
      }) => {
        const content = svc().exportArchive(requireBot(o.bot), ctx, {
          importId: o.import,
          format: o.format === 'json' ? 'json' : 'markdown',
          includeSecrets: Boolean(o.includeSecrets),
        });
        const target = writeOutput(o.out, content, Boolean(o.force));
        emit({ file: target }, () =>
          out(
            `${c.green('✓')} wrote ${target}${o.includeSecrets ? c.yellow(' (secrets INCLUDED)') : ''}`,
          ),
        );
      },
    );

  // ---------------------------------------------------------------------------- usage & estimates
  const us = program
    .command('usage')
    .description('Token estimates and user-recorded usage measurements');
  us.command('report')
    .description('Per-bot size report (estimates kept separate from measurements)')
    .option('--bot <id>', 'bot ID (default: all bots)')
    .action((o: { bot?: string }) => {
      const ids = o.bot
        ? [requireBot(o.bot)]
        : svc()
            .listBots(ctx)
            .map((b) => b.id);
      const reports = ids.map((id) => svc().usageReport(id, ctx));
      emit(reports, () => {
        for (const r of reports) {
          const e = r.estimates;
          out(c.bold(`${r.botId}`));
          out(
            `  1. Locally estimated tokens (${e.method}): imported ~${e.importedTokens} · checkpoint ~${e.checkpointTokens ?? '—'} · handoff ~${e.handoffTokens ?? '—'}`,
          );
          out(
            `  2. Estimated reduction of supplied text: ${e.estimatedTextReductionPercent === null ? '—' : `${e.estimatedTextReductionPercent}%`}${r.partial ? c.yellow(' (partial coverage)') : ''}`,
          );
          out(
            `  3. Provider-measured records: ${r.measured.length} · 4. Billing/quota records: ${r.billing.length}`,
          );
          const pc = r.platformComparison;
          out(
            `  5. Platform context reduction: ${pc.status === 'not_measured' ? c.yellow('not measured') : `${pc.inputTokenChangePercent}% fewer input tokens (user-measured, unverified by GCM)`}`,
          );
          out(
            c.dim(
              `  GCM overhead: ${r.gcmOverhead.operations} ops, ${r.gcmOverhead.durationMs} ms, local model tokens ${r.gcmOverhead.localModelTokens}, MCP response tokens ~${r.gcmOverhead.mcpResponseTokensEstimated}`,
            ),
          );
          for (const l of r.limitations) out(c.dim(`  - ${l}`));
        }
      });
    });
  us.command('record')
    .description(
      'Record a usage figure you obtained yourself (e.g. from Grok Bot or billing pages)',
    )
    .requiredOption('--bot <id>', 'bot ID')
    .requiredOption('--label <label>', 'e.g. before_handoff, after_handoff, week-42')
    .option('--kind <kind>', 'provider_measured|billing', 'provider_measured')
    .option('--input-tokens <n>', 'input tokens', int('--input-tokens'))
    .option('--output-tokens <n>', 'output tokens', int('--output-tokens'))
    .option('--amount <n>', 'billing/quota amount', (v: string) => Number(v))
    .option('--unit <unit>', 'unit for --amount, e.g. "% weekly allowance"')
    .option('--source <text>', 'where the number came from', 'user-supplied')
    .option('--note <text>', 'note')
    .action((o: Record<string, unknown>) => {
      const r = svc().recordUsage(
        {
          botId: requireBot(o.bot as string),
          kind: o.kind as 'provider_measured' | 'billing',
          label: String(o.label),
          inputTokens: (o.inputTokens as number) ?? null,
          outputTokens: (o.outputTokens as number) ?? null,
          amount: (o.amount as number) ?? null,
          unit: (o.unit as string) ?? null,
          source: String(o.source),
          note: (o.note as string) ?? null,
        },
        ctx,
      );
      emit(r, () => out(`${c.green('✓')} recorded ${r.kind} "${r.label}" for ${r.botId}`));
    });

  program
    .command('estimate <file>')
    .description('Estimate tokens of a file or stdin ("-") locally (no model call)')
    .option('--method <method>', 'heuristic|o200k')
    .action(async (file: string, o: { method?: TokenMethod }) => {
      if (o.method) await loadTokenizer(o.method);
      const r = svc().estimate(await readInput(file), o.method);
      emit(r, () => out(`~${r.tokens} tokens (${r.method}, estimated) for ${r.chars} characters`));
    });

  // ---------------------------------------------------------------------------- fleet
  const fl = program
    .command('fleet')
    .description('Multi-bot operations (explicit, never destructive)');
  const fleetIds = (o: { bots?: string[]; all?: boolean }) => {
    if (o.all)
      return svc()
        .listBots(ctx)
        .map((b) => b.id);
    if (!o.bots?.length) throw new GcmError('VALIDATION', 'Pass --bots a,b or --all.');
    return o.bots.map((b) => requireBot(b));
  };
  fl.command('analyze')
    .description('Analyze every (or selected) bot without saving')
    .option('--bots <ids>', 'comma-separated bot IDs', csv)
    .option('--all', 'all bots')
    .action((o: { bots?: string[]; all?: boolean }) => {
      const rows = fleetIds({ ...o, all: o.all ?? !o.bots }).map((id) => {
        const p = svc().analyze({ botId: id }, ctx);
        return {
          botId: id,
          newImports: p.importIds.length,
          sourceTokens: p.result.content.stats.sourceTokensEstimate,
          handoffTokens: p.result.handoffPreviewTokens,
          conflicts: p.result.content.conflicts.length,
          valid: p.validation.ok,
        };
      });
      emit(rows, () =>
        table(
          rows.map((r) => [
            r.botId,
            r.newImports,
            `~${r.sourceTokens}`,
            `~${r.handoffTokens}`,
            r.conflicts,
            r.valid ? 'ok' : 'INVALID',
          ]),
          ['BOT', 'NEW IMPORTS', 'NEW SOURCE*', 'HANDOFF*', 'CONFLICTS', 'VALIDATION'],
        ),
      );
    });
  fl.command('checkpoint')
    .description('Create checkpoints for several bots (requires --yes)')
    .option('--bots <ids>', 'comma-separated bot IDs', csv)
    .option('--all', 'all bots')
    .option('--approve', 'mark them reviewed')
    .option('--yes', 'confirm the bulk operation')
    .action(async (o: { bots?: string[]; all?: boolean; approve?: boolean; yes?: boolean }) => {
      const ids = fleetIds(o);
      if (!o.yes)
        throw new GcmError(
          'APPROVAL_REQUIRED',
          `This creates checkpoints for ${ids.length} bot(s): ${ids.join(', ')}.`,
          'Re-run with --yes.',
        );
      const results: { botId: string; result: string }[] = [];
      for (const id of ids) {
        try {
          const r = await svc().createCheckpoint({ botId: id, approve: Boolean(o.approve) }, ctx);
          results.push({
            botId: id,
            result: `v${r.checkpoint.version} (${r.checkpoint.reviewStatus})`,
          });
        } catch (e) {
          results.push({
            botId: id,
            result: e instanceof GcmError ? `skipped: ${e.message}` : 'failed',
          });
        }
      }
      emit(results, () =>
        table(
          results.map((r) => [r.botId, r.result]),
          ['BOT', 'RESULT'],
        ),
      );
    });
  fl.command('handoff')
    .description('Prepare handoffs for several bots (requires --yes)')
    .option('--bots <ids>', 'comma-separated bot IDs', csv)
    .option('--all', 'all bots')
    .option('--allow-unreviewed', 'allow unreviewed checkpoints')
    .option('--yes', 'confirm the bulk operation')
    .action((o: { bots?: string[]; all?: boolean; allowUnreviewed?: boolean; yes?: boolean }) => {
      const ids = fleetIds(o);
      if (!o.yes)
        throw new GcmError(
          'APPROVAL_REQUIRED',
          `This prepares handoffs for ${ids.length} bot(s): ${ids.join(', ')}.`,
          'Re-run with --yes.',
        );
      const results = ids.map((id) => {
        try {
          const h = svc().prepareHandoff(
            { botId: id, allowUnreviewed: Boolean(o.allowUnreviewed) },
            ctx,
          );
          return { botId: id, handoffId: h.id, tokens: h.tokenEstimate.tokens, result: 'ready' };
        } catch (e) {
          return {
            botId: id,
            handoffId: null,
            tokens: null,
            result: e instanceof GcmError ? `skipped: ${e.message}` : 'failed',
          };
        }
      });
      emit(results, () =>
        table(
          results.map((r) => [
            r.botId,
            r.handoffId,
            r.tokens === null ? '—' : `~${r.tokens}`,
            r.result,
          ]),
          ['BOT', 'HANDOFF', 'TOKENS*', 'RESULT'],
        ),
      );
    });

  // ---------------------------------------------------------------------------- settings
  const st = program.command('settings').description('Local GCM settings');
  st.command('show')
    .description('Show settings')
    .action(() => {
      const s = svc().settings();
      emit(s, () => {
        for (const [k, v] of Object.entries(s)) out(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
        out(c.dim(`  data folder: ${dataDir()}`));
      });
    });
  st.command('set <key> <value>')
    .description(
      'Change a setting, e.g. summarizer ollama · ollamaModel llama3.2 · budgets.compact 800',
    )
    .option(
      '--allow-remote',
      'allow a non-local Ollama URL (checkpoint notes would leave this machine)',
    )
    .action((key: string, raw: string, o: { allowRemote?: boolean }) => {
      let value: unknown = raw;
      if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
      else if (raw === 'true' || raw === 'false') value = raw === 'true';
      else if (raw === 'null') value = null;
      if (key === 'ollamaUrl' && !isLoopbackUrl(String(value)) && !o.allowRemote) {
        throw new GcmError(
          'APPROVAL_REQUIRED',
          `${String(value)} is not a local address: checkpoint notes would be sent to that server.`,
          'Re-run with --allow-remote if that is intended.',
        );
      }
      const patch: Record<string, unknown> = {};
      if (key.startsWith('budgets.'))
        patch.budgets = { ...svc().settings().budgets, [key.slice(8)]: value };
      else patch[key] = value;
      const s = svc().updateSettings(patch, ctx);
      emit(s, () =>
        out(
          `${c.green('✓')} ${key} = ${JSON.stringify(key.startsWith('budgets.') ? s.budgets : (s as Record<string, unknown>)[key])}`,
        ),
      );
    });

  // ---------------------------------------------------------------------------- dashboard
  program
    .command('dashboard')
    .description('Start the local web dashboard (127.0.0.1 only)')
    .option('--port <port>', 'port', int('--port'), 4747)
    .option('--no-open', 'do not open a browser')
    .action(async (o: { port: number; open: boolean }) => {
      const d = await startDashboard(svc(), {
        port: o.port,
        staticDir: dashboardAssetsDir(),
        log: (l) => process.stderr.write(`${l}\n`),
      });
      out(
        `${c.green('✓')} GCM dashboard running at ${c.bold(d.url)} (local only). Press Ctrl+C to stop.`,
      );
      if (o.open) openBrowser(d.url);
      await waitForever(d.close);
    });

  // ---------------------------------------------------------------------------- MCP
  const mcp = program.command('mcp').description('Model Context Protocol server and API tokens');
  mcp
    .command('serve')
    .description(
      'Run the GCM MCP server (stdio by default; --http for the authenticated streamable-HTTP endpoint)',
    )
    .option('--http', 'serve streamable HTTP instead of stdio')
    .option('--host <host>', 'HTTP bind address', '127.0.0.1')
    .option('--port <port>', 'HTTP port', int('--port'), 8787)
    .option('--tls-cert <file>', 'TLS certificate (PEM) for native HTTPS')
    .option('--tls-key <file>', 'TLS private key (PEM)')
    .option(
      '--behind-tls-proxy',
      'confirm an HTTPS reverse proxy/tunnel terminates TLS in front of this server',
    )
    .option('--bots <ids>', 'stdio only: bot IDs this server may access (default all)', csv)
    .option('--read-only', 'stdio only: expose read-only tools')
    .action(async (o: Record<string, unknown>) => {
      mode.quiet = true;
      if (!o.http) {
        await serveStdio(svc(), {
          bots: (o.bots as string[] | undefined) ?? '*',
          readOnly: Boolean(o.readOnly),
        });
        process.stderr.write('[gcm-mcp] stdio server ready\n');
        await waitForever(async () => closeAll());
        return;
      }
      const tls =
        o.tlsCert && o.tlsKey
          ? { certPath: safeInputPath(String(o.tlsCert)), keyPath: safeInputPath(String(o.tlsKey)) }
          : undefined;
      const srv = await serveHttp(svc(), {
        host: String(o.host),
        port: o.port as number,
        tls,
        behindTlsProxy: Boolean(o.behindTlsProxy),
      });
      process.stderr.write(
        `[gcm-mcp] HTTP MCP endpoint listening: ${srv.url}${o.behindTlsProxy ? ' (behind TLS proxy)' : ''}\n`,
      );
      await waitForever(srv.close);
    });

  const tok = mcp.command('token').description('API tokens for the HTTP MCP endpoint');
  tok
    .command('create')
    .description('Create an API token (shown once). One token per bot is recommended.')
    .requiredOption('--name <name>', 'label, e.g. sales-bot')
    .requiredOption('--bots <ids>', 'comma-separated bot IDs, or "*" for all bots (fleet token)')
    .option('--write', 'allow write tools (import, checkpoint, handoff); default read-only')
    .action((o: { name: string; bots: string; write?: boolean }) => {
      const botsList = o.bots.trim() === '*' ? '*' : csv(o.bots);
      const { record, token } = createApiToken(store(), {
        name: o.name,
        bots: botsList,
        canWrite: Boolean(o.write),
      });
      emit(
        { id: record.id, name: record.name, bots: record.bots, canWrite: record.canWrite, token },
        () => {
          out(
            `${c.green('✓')} token ${record.id} (${record.name}) · bots ${JSON.stringify(record.bots)} · ${record.canWrite ? 'read+write' : 'read-only'}`,
          );
          out(`  ${c.bold(token)}`);
          out(c.yellow('  Store it now — it is not shown again. Treat it like a password.'));
        },
      );
    });
  tok
    .command('list')
    .description('List API tokens (hashes only are stored)')
    .action(() => {
      const list = store().listApiTokens();
      emit(
        list.map(({ tokenHash: _h, ...t }) => t),
        () =>
          table(
            list.map((t) => [
              t.id,
              t.name,
              JSON.stringify(t.bots),
              t.canWrite ? 'rw' : 'ro',
              t.createdAt.slice(0, 19),
              t.lastUsedAt?.slice(0, 19),
              t.revokedAt ? 'revoked' : 'active',
            ]),
            ['ID', 'NAME', 'BOTS', 'MODE', 'CREATED', 'LAST USED', 'STATUS'],
          ),
      );
    });
  tok
    .command('revoke <id>')
    .description('Revoke an API token')
    .action((id: string) => {
      const ok = store().revokeApiToken(id, new Date().toISOString());
      if (!ok) throw new GcmError('NOT_FOUND', `Active token "${id}" not found.`);
      emit({ revoked: id }, () => out(`${c.green('✓')} revoked ${id}`));
    });

  // ---------------------------------------------------------------------------- data management (GCM data only)
  const data = program
    .command('data')
    .description('Backup or delete GCM’s OWN stored data (never touches Grok Bot)');
  const backupPath = () =>
    path.join(dataDir(), 'backups', `gcm-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  data
    .command('backup')
    .description('Write a consistent backup copy of the GCM database')
    .option('--out <file>', 'backup file (default: <data folder>/backups/...)')
    .option('--force', 'overwrite')
    .action(async (o: { out?: string; force?: boolean }) => {
      const target = o.out
        ? safeOutputPath(o.out, { force: Boolean(o.force), dataDir: dataDir() })
        : backupPath();
      await store().backup(target);
      emit({ backup: target }, () => out(`${c.green('✓')} backup written to ${target}`));
    });
  data
    .command('delete')
    .description('Delete GCM’s stored data for one bot (automatic backup first)')
    .requiredOption('--bot <id>', 'bot ID')
    .option('--yes', 'confirm permanent deletion of GCM data for this bot')
    .action(async (o: { bot: string; yes?: boolean }) => {
      const target = backupPath();
      const counts = await svc().deleteBotData(requireBot(o.bot), ctx, {
        confirm: Boolean(o.yes),
        backupPath: o.yes ? target : undefined,
      });
      emit({ deleted: counts, backup: target }, () =>
        out(
          `${c.green('✓')} deleted GCM data for ${o.bot}: ${JSON.stringify(counts)}. Backup: ${target}. Grok Bot was not touched.`,
        ),
      );
    });
  data
    .command('purge')
    .description('Delete ALL GCM stored data (automatic backup first)')
    .option('--yes', 'confirm')
    .action(async (o: { yes?: boolean }) => {
      const target = backupPath();
      const counts = await svc().deleteAllData(ctx, {
        confirm: Boolean(o.yes),
        backupPath: o.yes ? target : undefined,
      });
      emit({ deleted: counts, backup: target }, () =>
        out(
          `${c.green('✓')} deleted all GCM data: ${JSON.stringify(counts)}. Backup: ${target}. Grok Bot was not touched.`,
        ),
      );
    });

  program
    .command('capabilities')
    .description('Show what is verified, experimental or unsupported in Grok Bot integration')
    .action(() => {
      const caps = svc().capabilities();
      emit(caps, () => {
        for (const cap of caps)
          out(
            `${stateColor(cap.status).padEnd(30)} ${cap.question}\n${c.dim(`    → ${cap.approach}`)}`,
          );
        out(c.dim(`Checked ${CAPABILITIES_CHECKED_AT}. Sources: docs/CAPABILITY-MATRIX.md`));
      });
    });
}
