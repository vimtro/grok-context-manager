import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpointHash, GcmError, type AccessContext } from '@gcm/core';
import { SqliteStore } from '@gcm/storage';
import { fixture, makeEnv, seedBot, type TestEnv } from '../helpers';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof GcmError ? e.code : `non-gcm:${(e as Error).message}`;
  }
  return 'no-error';
};
const acode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof GcmError ? e.code : `non-gcm:${(e as Error).message}`;
  }
  return 'no-error';
};

describe('end-to-end checkpoint and handoff workflow', () => {
  it('runs Analyze → Checkpoint → Verify → Handoff → approved action → validate', async () => {
    seedBot(env, 'sales', 'sales-bot.txt', 'Sales Bot');
    const { checkpoint } = await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.reviewStatus).toBe('unreviewed');

    // Reopen and verify.
    const verify = env.service.verifyCheckpoint(checkpoint.id, env.ctx);
    expect(verify.checkpointOk && verify.archiveOk).toBe(true);

    // Handoff requires review unless explicitly overridden.
    expect(code(() => env.service.prepareHandoff({ botId: 'sales' }, env.ctx))).toBe(
      'APPROVAL_REQUIRED',
    );
    env.service.reviewCheckpoint(checkpoint.id, env.ctx, { note: 'looks right' });
    const handoff = env.service.prepareHandoff({ botId: 'sales' }, env.ctx);
    expect(handoff.state).toBe('HANDOFF_READY');
    expect(handoff.events.map((e) => e.state)).toEqual([
      'CHECKPOINT_READY',
      'ARCHIVE_VERIFIED',
      'HANDOFF_READY',
    ]);
    expect(handoff.text).toContain(handoff.verificationCode);

    // Destructive platform action needs explicit acknowledgement.
    expect(code(() => env.service.chooseAction(handoff.id, 'reset_chat', env.ctx))).toBe(
      'APPROVAL_REQUIRED',
    );
    const chosen = env.service.chooseAction(handoff.id, 'new_group_chat', env.ctx);
    expect(chosen.handoff.state).toBe('USER_ACTION_REQUIRED');
    expect(chosen.guide.destructive).toBe(false);

    // Reported platform action is never reported as a verified reset.
    const done = env.service.reportActionDone(handoff.id, env.ctx);
    expect(done.state).toBe('EXTERNAL_RESET_UNVERIFIED');
    expect(done.events.at(-1)!.note).toMatch(/unverified/);

    // A wrong reply fails recoverably; a correct one verifies continuation.
    const bad = env.service.verifyContinuationReply(handoff.id, 'Hello! How can I help?', env.ctx);
    expect(bad.result.passed).toBe(false);
    expect(bad.handoff.state).toBe('FAILED_RECOVERABLE');
    const ck = env.service.getCheckpoint(checkpoint.id, env.ctx);
    const reply = `Loaded ${handoff.verificationCode}. Objective: ${ck.content.objective!.text} Top tasks: ${ck.content.pendingTasks
      .slice(0, 3)
      .map((t) => t.text)
      .join('; ')}`;
    const good = env.service.verifyContinuationReply(handoff.id, reply, env.ctx);
    expect(good.result.passed).toBe(true);
    expect(good.handoff.state).toBe('CONTINUATION_VERIFIED');
    // The reply itself is not stored.
    expect(JSON.stringify(env.service.getHandoff(handoff.id, env.ctx))).not.toContain(
      'Hello! How can I help?',
    );
  });

  it('builds a handoff that is smaller than the imported long conversation', async () => {
    seedBot(env, 'cos', 'chief-of-staff-long.md', 'Chief of Staff');
    await env.service.createCheckpoint({ botId: 'cos', approve: true }, env.ctx);
    const h = env.service.prepareHandoff({ botId: 'cos' }, env.ctx);
    const report = env.service.usageReport('cos', env.ctx);
    expect(report.estimates.handoffTokens).toBe(h.tokenEstimate.tokens);
    expect(report.estimates.estimatedTextReductionPercent!).toBeGreaterThan(90);
    expect(report.platformComparison.status).toBe('not_measured');
    expect(report.limitations.join(' ')).toMatch(/not Grok Bot billing/);
  });
});

describe('versioning, incremental processing and recovery', () => {
  it('imports incrementally and carries forward the previous checkpoint', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const again = env.service.importContext(
      { botId: 'sales', text: fixture('sales-bot.txt') },
      env.ctx,
    );
    expect(again.added).toBe(0);
    expect(again.import).toBeNull();

    const v1 = (await env.service.createCheckpoint({ botId: 'sales', approve: true }, env.ctx))
      .checkpoint;
    expect(await acode(() => env.service.createCheckpoint({ botId: 'sales' }, env.ctx))).toBe(
      'VALIDATION',
    );

    const extended = `${fixture('sales-bot.txt')}\nUser: Done: scheduled the call with Dana for next Tuesday.\nUser: TODO: send the signed order form to finance by 2026-10-30.`;
    const inc = env.service.importContext({ botId: 'sales', text: extended }, env.ctx);
    expect(inc.added).toBe(2);
    expect(inc.duplicatesSkipped).toBeGreaterThan(20);

    const v2 = (await env.service.createCheckpoint({ botId: 'sales' }, env.ctx)).checkpoint;
    expect(v2.version).toBe(2);
    expect(v2.parentId).toBe(v1.id);
    expect(v2.source.importIds).toEqual([inc.import!.id]);
    const tasks = v2.content.pendingTasks.map((t) => t.text).join('\n');
    expect(tasks).toMatch(/signed order form/);
    expect(tasks).not.toMatch(/schedule a call with Dana/i); // closed by the new "Done:" statement
    expect(v2.content.constraints.map((c) => c.text).join('\n')).toMatch(/Never send pricing/); // carried forward

    // Predecessor is untouched and still verifies.
    expect(env.service.verifyCheckpoint(v1.id, env.ctx).checkpointOk).toBe(true);
    const diff = env.service.diff(v1.id, v2.id, env.ctx);
    expect(diff.sections.pendingTasks.added.join(' ')).toMatch(/signed order form/);
  });

  it('restores an old checkpoint as a new version without overwriting history', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const v1 = (await env.service.createCheckpoint({ botId: 'sales', approve: true }, env.ctx))
      .checkpoint;
    env.service.importContext(
      { botId: 'sales', text: 'User: Decision: pause all outreach to Acme until November.' },
      env.ctx,
    );
    await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    const v3 = env.service.restoreCheckpoint(v1.id, env.ctx);
    expect(v3.version).toBe(3);
    expect(v3.restoredFromId).toBe(v1.id);
    expect(v3.content).toEqual(v1.content);
    expect(env.service.listCheckpoints('sales', env.ctx, { limit: 10, offset: 0 }).total).toBe(3);
  });

  it('enforces checkpoint immutability and detects tampering', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const { checkpoint } = await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    expect(() =>
      env.store.db.prepare("UPDATE checkpoints SET data = '{}' WHERE id = ?").run(checkpoint.id),
    ).toThrow(/immutable/);
    expect(() => env.store.db.prepare("UPDATE messages SET content = 'x'").run()).toThrow(
      /immutable/,
    );

    // Simulate disk-level corruption of the archive (bypassing the trigger) and confirm detection.
    env.store.db.exec('DROP TRIGGER messages_immutable');
    env.store.db.prepare("UPDATE messages SET content = 'tampered' WHERE seq = 3").run();
    const report = env.service.verifyCheckpoint(checkpoint.id, env.ctx);
    expect(report.archiveOk).toBe(false);
    expect(report.corruptedImports).toHaveLength(1);
    env.service.reviewCheckpoint(checkpoint.id, env.ctx);
    expect(code(() => env.service.prepareHandoff({ botId: 'sales' }, env.ctx))).toBe('INTEGRITY');
  });

  it('rejects a concurrent writer with a stale parent', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const { checkpoint } = await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    const stale = { ...checkpoint, id: 'ck_stale', version: 1 };
    expect(code(() => env.store.insertCheckpoint(stale))).toBe('CONFLICT');
  });

  it('leaves no partial data when a write fails mid-transaction', () => {
    env.service.upsertBot({ id: 'qa', name: 'QA' }, env.ctx);
    const record = {
      id: 'imp_x',
      botId: 'qa',
      sessionRef: null,
      sourceFormat: 'text' as const,
      sourceName: null,
      importedAt: new Date().toISOString(),
      completeness: 'unknown' as const,
      completenessNote: null,
      messageCount: 2,
      charCount: 2,
      tokenEstimate: 1,
      contentHash: 'h',
      duplicatesSkipped: 0,
      warnings: [],
    };
    const good = {
      id: 'm1',
      importId: 'imp_x',
      botId: 'qa',
      seq: 1,
      role: 'user' as const,
      content: 'a',
      contentHash: 'a',
    };
    const bad = { ...good, id: 'm2', seq: 2, botId: 'other' };
    expect(() => env.store.insertImport(record, [good, bad])).toThrow();
    expect(env.store.getImport('imp_x')).toBeNull();
    expect(env.store.archiveStats('qa').messages).toBe(0);
  });

  it('exports and re-imports checkpoints, refusing modified files', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const { checkpoint } = await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    const json = env.service.exportCheckpoint(checkpoint.id, 'json', env.ctx);
    const restored = env.service.importCheckpointFile(json, env.ctx);
    expect(restored.version).toBe(2);
    expect(restored.restoredFromId).toBe(checkpoint.id);
    const tampered = json.replace('Never send pricing', 'Always send pricing');
    expect(code(() => env.service.importCheckpointFile(tampered, env.ctx))).toBe('INTEGRITY');
    expect(env.service.exportCheckpoint(checkpoint.id, 'markdown', env.ctx)).toMatch(
      /# GCM checkpoint v1/,
    );
  });

  it('refuses to open a database from a newer GCM version', () => {
    env.store.db.pragma('user_version = 99');
    env.store.close();
    expect(() => SqliteStore.open({ dataDir: env.dir })).toThrow(/newer than this GCM build/);
  });
});

describe('isolation and access control', () => {
  it('prevents cross-bot leakage', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const research = seedBot(env, 'research', 'research-bot.json');
    // Another bot's import ID cannot be pulled into a Sales checkpoint.
    expect(
      code(() => env.service.analyze({ botId: 'sales', importIds: [research.id] }, env.ctx)),
    ).toBe('NOT_FOUND');
    const { checkpoint } = await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    expect(JSON.stringify(checkpoint.content)).not.toMatch(/note-taking|Copilot/);
    // Archive search is per bot.
    expect(
      env.service.searchArchive('sales', 'Copilot', env.ctx, { limit: 10, offset: 0 }).total,
    ).toBe(0);
    expect(
      env.service.searchArchive('research', 'Copilot', env.ctx, { limit: 10, offset: 0 }).total,
    ).toBe(1);
  });

  it('scopes MCP-style access contexts and keeps shared access read-only', () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    seedBot(env, 'research', 'research-bot.json');
    const salesOnly: AccessContext = {
      bots: ['sales'],
      canWrite: true,
      channel: 'mcp',
      actorBotId: 'sales',
    };
    expect(env.service.listBots(salesOnly).map((b) => b.id)).toEqual(['sales']);
    expect(code(() => env.service.getBot('research', salesOnly))).toBe('NOT_FOUND');

    env.service.upsertBot({ id: 'research', policy: { shareWith: ['sales'] } }, env.ctx);
    expect(env.service.getBot('research', salesOnly).id).toBe('research');
    expect(
      code(() => env.service.importContext({ botId: 'research', text: 'User: hi' }, salesOnly)),
    ).toBe('FORBIDDEN');

    const readOnly: AccessContext = { bots: ['sales'], canWrite: false, channel: 'mcp' };
    expect(
      code(() => env.service.importContext({ botId: 'sales', text: 'User: hi' }, readOnly)),
    ).toBe('FORBIDDEN');
    env.service.upsertBot({ id: 'sales', policy: { mcpExposed: false } }, env.ctx);
    // Hidden from MCP; the research bot is still visible because it explicitly shares with sales.
    expect(env.service.listBots(salesOnly).map((b) => b.id)).toEqual(['research']);
    expect(code(() => env.service.updateSettings({ summarizer: 'ollama' }, salesOnly))).toBe(
      'FORBIDDEN',
    );
    expect(code(() => env.service.exportArchive('sales', salesOnly, { format: 'json' }))).toBe(
      'FORBIDDEN',
    );
  });

  it('never labels a partial import complete', () => {
    env.service.upsertBot({ id: 'qa', name: 'QA' }, env.ctx);
    const r = env.service.importContext(
      { botId: 'qa', text: 'User: hi\n[truncated]\nAssistant: ok', completeness: 'complete' },
      env.ctx,
    );
    expect(r.import!.completeness).toBe('partial');
  });
});

describe('providers, privacy and reports', () => {
  it('falls back safely when Ollama is unavailable', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const e2 = makeEnv({ fetchImpl: failing });
    try {
      seedBot(e2, 'sales', 'sales-bot.txt');
      e2.service.updateSettings({ summarizer: 'ollama', ollamaModel: 'llama3.2' }, e2.ctx);
      const { checkpoint } = await e2.service.createCheckpoint({ botId: 'sales' }, e2.ctx);
      expect(checkpoint.content.narrative).toBeNull();
      expect(checkpoint.source.provider).toBe('deterministic');
      expect(checkpoint.warnings.join(' ')).toMatch(/Narrative skipped/);
    } finally {
      e2.cleanup();
    }
  });

  it('uses a validated local narrative when Ollama answers, and caches it', async () => {
    let chatCalls = 0;
    const fake = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags'))
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }));
      chatCalls++;
      return new Response(
        JSON.stringify({
          message: { content: 'Work focuses on the Acme Corp renewal with Dana.' },
          prompt_eval_count: 300,
          eval_count: 20,
        }),
      );
    }) as unknown as typeof fetch;
    const e2 = makeEnv({ fetchImpl: fake });
    try {
      seedBot(e2, 'sales', 'sales-bot.txt');
      e2.service.updateSettings({ summarizer: 'ollama', ollamaModel: 'llama3.2' }, e2.ctx);
      const { checkpoint } = await e2.service.createCheckpoint({ botId: 'sales' }, e2.ctx);
      expect(checkpoint.content.narrative).toMatch(/Acme Corp renewal/);
      expect(checkpoint.source.provider).toBe('deterministic+ollama:llama3.2');
      expect(e2.service.usageReport('sales', e2.ctx).gcmOverhead.localModelTokens).toBe(320);
      await e2.service.createCheckpoint({ botId: 'sales', rebuild: true }, e2.ctx);
      expect(chatCalls).toBe(1);
    } finally {
      e2.cleanup();
    }
  });

  it('does not write conversation content or secrets to the operations log', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    const ops = JSON.stringify(env.store.listOperations({ limit: 100 }));
    expect(ops).not.toMatch(/sk-proj|Acme|pricing/);
    const hits = env.service.searchArchive('sales', 'api key', env.ctx, { limit: 5, offset: 0 });
    expect(hits.items[0]!.snippet).not.toMatch(/sk-proj-ABCD/);
  });

  it('paginates archive search and treats query syntax as plain text', () => {
    seedBot(env, 'cos', 'chief-of-staff-long.md');
    const p1 = env.service.searchArchive('cos', 'Northwind', env.ctx, { limit: 3, offset: 0 });
    const p2 = env.service.searchArchive('cos', 'Northwind', env.ctx, { limit: 3, offset: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.total).toBeGreaterThan(3);
    expect(p2.items[0]!.messageId).not.toBe(p1.items[0]!.messageId);
    expect(() =>
      env.service.searchArchive('cos', 'NEAR( " OR * ^', env.ctx, { limit: 3, offset: 0 }),
    ).not.toThrow();
  });

  it('keeps user-measured usage separate from estimates', () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    env.service.recordUsage(
      { botId: 'sales', kind: 'provider_measured', label: 'before_handoff', inputTokens: 200_000 },
      env.ctx,
    );
    env.service.recordUsage(
      { botId: 'sales', kind: 'provider_measured', label: 'after_handoff', inputTokens: 20_000 },
      env.ctx,
    );
    const r = env.service.usageReport('sales', env.ctx);
    expect(r.platformComparison.status).toBe('user_measured_unverified');
    expect(r.platformComparison.inputTokenChangePercent).toBe(90);
    expect(r.estimates.kind).toBe('estimated');
  });

  it('requires explicit confirmation to delete GCM data and backs up first', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    expect(await acode(() => env.service.deleteBotData('sales', env.ctx, { confirm: false }))).toBe(
      'APPROVAL_REQUIRED',
    );
    const counts = await env.service.deleteBotData('sales', env.ctx, {
      confirm: true,
      backupPath: `${env.dir}/backups/pre-delete.sqlite`,
    });
    expect(counts.messages).toBeGreaterThan(0);
    expect(env.store.getBot('sales')).toBeNull();
    const backup = SqliteStore.open({ dataDir: `${env.dir}/restore-test`, readonly: false });
    backup.close();
  });

  it('reports health and capabilities without claiming unsupported features', () => {
    const h = env.service.health();
    expect(h.ok).toBe(true);
    expect(h.telemetry).toBe(false);
    const caps = env.service.capabilities();
    expect(caps.find((c) => c.id === 'mcp-compact-transcript')?.status).toBe(
      'VERIFIED_UNSUPPORTED',
    );
    expect(caps.find((c) => c.id === 'reset-chat')?.status).not.toBe('VERIFIED_SUPPORTED');
  });

  it('computes checkpoint hashes deterministically', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const { checkpoint } = await env.service.createCheckpoint({ botId: 'sales' }, env.ctx);
    const reloaded = env.store.getCheckpoint(checkpoint.id)!;
    expect(checkpointHash(reloaded)).toBe(checkpoint.contentHash);
  });
});

describe('archive recovery', () => {
  it('restores a bot archive from a JSON export after deletion', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const exported = env.service.exportArchive('sales', env.ctx, { format: 'json' });
    const before = env.store.archiveStats('sales');
    await env.service.deleteBotData('sales', env.ctx, { confirm: true });
    env.service.upsertBot({ id: 'sales', name: 'Sales' }, env.ctx);
    const r = env.service.importArchiveExport(exported, env.ctx);
    expect(r.added).toBe(before.messages);
    expect(env.store.archiveStats('sales').messages).toBe(before.messages);
    // Restoring again adds nothing (overlap detection).
    expect(env.service.importArchiveExport(exported, env.ctx).added).toBe(0);
    expect(
      env.service.searchArchive('sales', 'PandaDoc', env.ctx, { limit: 5, offset: 0 }).total,
    ).toBeGreaterThan(0);
  });
});

describe('quick-add bots by name', () => {
  it('creates bots from names, reports existing ones and never modifies them', () => {
    seedBot(env, 'sales', 'sales-bot.txt', 'Sales Bot');
    const dry = env.service.quickAddBots('Research\nSales', env.ctx, { dryRun: true });
    expect(dry.created.map((b) => b.id)).toEqual(['research']);
    expect(env.service.store.getBot('research')).toBeNull();

    const r = env.service.quickAddBots('Research\nSales\n2h\nChief of Staff', env.ctx);
    expect(r.created).toEqual([
      { id: 'research', name: 'Research' },
      { id: 'chief-of-staff', name: 'Chief of Staff' },
    ]);
    expect(r.existing).toEqual([{ id: 'sales', name: 'Sales Bot' }]);
    expect(r.ignored).toEqual(['2h']);
    expect(env.service.getBot('chief-of-staff', env.ctx).identitySource).toBe('user_provided');
    expect(env.service.store.getBot('sales')?.name).toBe('Sales Bot');
  });

  it('refuses read-only access and out-of-scope bots without partial writes', () => {
    const readOnly: AccessContext = { ...env.ctx, canWrite: false };
    expect(code(() => env.service.quickAddBots('Research', readOnly))).toBe('FORBIDDEN');
    const scoped: AccessContext = { ...env.ctx, bots: ['research'] };
    expect(code(() => env.service.quickAddBots('Research\nSupport', scoped))).toBe('FORBIDDEN');
    expect(env.service.store.getBot('research')).toBeNull();
  });
});
