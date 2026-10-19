import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AccessContext } from '@gcm/core';
import { buildServer, createApiToken, READ_ONLY_TOOLS, serveHttp } from '@gcm/mcp-server';
import { fixture, makeEnv, seedBot, type TestEnv } from '../helpers';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

async function connect(ctx: AccessContext, maxResponseTokens?: number) {
  const { server } = buildServer(env.service, { ctx, maxResponseTokens });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as TextResult;
  return { text: r.content.map((c) => c.text).join(''), isError: Boolean(r.isError) };
};
const json = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(r.text);
  return JSON.parse(r.text);
};

const full: AccessContext = { bots: '*', canWrite: true, channel: 'mcp' };

describe('MCP tools', () => {
  it('discovers tools; read-only connections only see read tools; no fake reset tool exists', async () => {
    const all = (await (await connect(full)).listTools()).tools.map((t) => t.name);
    expect(all).toHaveLength(16);
    expect(all.some((n) => /reset|prune|delete/i.test(n))).toBe(false);
    const ro = (await (await connect({ ...full, canWrite: false })).listTools()).tools;
    expect(ro.map((t) => t.name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
    expect(ro.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('runs the checkpoint → review → handoff → workflow cycle', async () => {
    const c = await connect(full);
    await json(c, 'gcm_upsert_bot', {
      bot_id: 'sales',
      name: 'Sales Bot',
      role: 'Account executive',
    });
    const imp = await json(c, 'gcm_import_context', {
      bot_id: 'sales',
      text: fixture('sales-bot.txt'),
    });
    expect(imp.added).toBeGreaterThan(20);
    const preview = await json(c, 'gcm_analyze_context', { bot_id: 'sales' });
    expect(preview.retained.constraints).toBeGreaterThan(2);
    expect(preview.validation_ok).toBe(true);

    const ck = await json(c, 'gcm_create_checkpoint', { bot_id: 'sales' });
    expect(ck.review_status).toBe('unreviewed');
    const view = await call(c, 'gcm_get_checkpoint', { bot_id: 'sales' });
    expect(view.text).toMatch(/Never send pricing/);

    const blocked = await call(c, 'gcm_prepare_handoff', { bot_id: 'sales' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/APPROVAL_REQUIRED/);

    await json(c, 'gcm_review_checkpoint', {
      checkpoint_id: ck.checkpoint_id,
      user_confirmed: true,
    });
    const ho = await json(c, 'gcm_prepare_handoff', { bot_id: 'sales' });
    expect(ho.state).toBe('HANDOFF_READY');
    expect(ho.text).toContain(ho.verification_code);

    const chosen = await json(c, 'gcm_update_handoff_state', {
      handoff_id: ho.handoff_id,
      action: 'choose_new_group_chat',
    });
    expect(chosen.state).toBe('USER_ACTION_REQUIRED');
    const done = await json(c, 'gcm_update_handoff_state', {
      handoff_id: ho.handoff_id,
      action: 'report_done',
    });
    expect(done.state).toBe('EXTERNAL_RESET_UNVERIFIED');
    const verified = await json(c, 'gcm_update_handoff_state', {
      handoff_id: ho.handoff_id,
      action: 'verify_reply',
      reply_text: 'hello',
    });
    expect(verified.state).toBe('FAILED_RECOVERABLE');
  });

  it('validates input schemas and refuses "complete" coverage claims from a bot', async () => {
    const c = await connect(full);
    const bad = await call(c, 'gcm_list_checkpoints', { bot_id: 'Not A Valid ID' });
    expect(bad.isError).toBe(true);
    await json(c, 'gcm_upsert_bot', { bot_id: 'qa' });
    const complete = await call(c, 'gcm_import_context', {
      bot_id: 'qa',
      text: 'User: hi',
      coverage: 'complete',
    });
    expect(complete.isError).toBe(true);
  });

  it('enforces bot scopes per connection', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    seedBot(env, 'research', 'research-bot.json');
    const c = await connect({
      bots: ['sales'],
      canWrite: true,
      channel: 'mcp',
      actorBotId: 'sales',
    });
    const bots = await json(c, 'gcm_list_bots');
    expect(bots.map((b: { bot_id: string }) => b.bot_id)).toEqual(['sales']);
    const denied = await call(c, 'gcm_search_archive', { bot_id: 'research', query: 'Copilot' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/NOT_FOUND/);
    const create = await call(c, 'gcm_upsert_bot', { bot_id: 'marketing' });
    expect(create.text).toMatch(/FORBIDDEN/);
  });

  it('caps response size and paginates archive search', async () => {
    seedBot(env, 'cos', 'chief-of-staff-long.md');
    await env.service.createCheckpoint({ botId: 'cos' }, env.ctx);
    const c = await connect(full, 600);
    const big = await call(c, 'gcm_get_checkpoint', { bot_id: 'cos', format: 'json' });
    expect(big.text).toMatch(/response truncated to the 600-token MCP budget/);
    const page = await json(c, 'gcm_search_archive', {
      bot_id: 'cos',
      query: 'Northwind',
      limit: 2,
    });
    expect(page.hits).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
    const sizes = env.store.listOperations({ limit: 50 }).filter((o) => o.op.startsWith('mcp:'));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((o) => o.responseTokens <= 700)).toBe(true);
  });
});

describe('MCP over HTTP', () => {
  it('fails closed without tokens and refuses plain-HTTP remote exposure', async () => {
    await expect(
      serveHttp(env.service, { host: '127.0.0.1', port: 0, log: () => {} }),
    ).rejects.toThrow(/no active API tokens/);
    createApiToken(env.store, { name: 't', bots: '*', canWrite: false });
    await expect(
      serveHttp(env.service, { host: '0.0.0.0', port: 0, log: () => {} }),
    ).rejects.toThrow(/plain HTTP/);
  });

  it('authenticates requests, scopes tools by token, and rejects bad hosts', async () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const writer = createApiToken(env.store, {
      name: 'sales-bot',
      bots: ['sales'],
      canWrite: true,
    });
    const reader = createApiToken(env.store, { name: 'viewer', bots: ['sales'], canWrite: false });
    const srv = await serveHttp(env.service, { host: '127.0.0.1', port: 0, log: () => {} });
    try {
      const health = await fetch(srv.url.replace('/mcp', '/healthz'));
      expect(health.status).toBe(200);

      const unauth = await fetch(srv.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauth.status).toBe(401);

      // fetch() cannot override Host, so use node:http to simulate a DNS-rebinding request.
      const badHostStatus = await new Promise<number>((resolve, reject) => {
        const u = new URL(srv.url);
        const req = request(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: {
              host: 'evil.example',
              authorization: `Bearer ${writer.token}`,
              'content-type': 'application/json',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(badHostStatus).toBe(403);

      const clientFor = async (token: string) => {
        const client = new Client({ name: 'http-test', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(srv.url), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        return client;
      };
      const w = await clientFor(writer.token);
      expect((await w.listTools()).tools).toHaveLength(16);
      const listed = await json(w, 'gcm_list_bots');
      expect(listed[0].bot_id).toBe('sales');
      await w.close();

      const r = await clientFor(reader.token);
      const tools = (await r.listTools()).tools.map((t) => t.name);
      expect(tools).not.toContain('gcm_import_context');
      await r.close();

      env.store.revokeApiToken(reader.record.id, new Date().toISOString());
      await expect(clientFor(reader.token)).rejects.toThrow();
    } finally {
      await srv.close();
    }
  });
});
