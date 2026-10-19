/**
 * Tests the BUILT CLI bundle (apps/cli/dist/gcm.mjs) as a real process — run `pnpm build` first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../helpers';

const CLI = path.join(ROOT, 'apps', 'cli', 'dist', 'gcm.mjs');
const FIXTURE = path.join(ROOT, 'examples', 'conversations', 'sales-bot.txt');
let home: string;
let work: string;

function gcm(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, '--home', home, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
const json = (args: string[], input?: string) => {
  const r = gcm(['--json', ...args], input);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  return JSON.parse(r.out);
};

beforeAll(() => {
  if (!existsSync(CLI))
    throw new Error('Packaged CLI not found. Run `pnpm build` before the test suite.');
  home = mkdtempSync(path.join(tmpdir(), 'gcm-cli-'));
  work = mkdtempSync(path.join(tmpdir(), 'gcm-cli-out-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('packaged CLI', () => {
  it('prints help, version and a doctor report', () => {
    expect(gcm(['--help']).out).toMatch(/Grok Context Manager/);
    expect(gcm(['--version']).out.trim()).toBe('0.1.0');
    const doc = json(['doctor']);
    expect(doc.checks.find((c: { name: string }) => c.name === 'Database').status).toBe('ok');
    expect(doc.platformLimitations.join(' ')).toMatch(/no official API/);
  });

  it('runs the bot → import → checkpoint → handoff flow with JSON output', () => {
    expect(json(['init']).schemaVersion).toBe(1);
    expect(
      json([
        'bots',
        'add',
        'sales',
        '--name',
        'Sales Bot',
        '--boundary',
        'Never share customer data',
      ]).created,
    ).toBe(true);
    // Native absolute path (backslashes on Windows).
    const imp = json([
      'import',
      path.normalize(FIXTURE),
      '--bot',
      'sales',
      '--session',
      'acme',
    ]);
    expect(imp.added).toBe(30);
    const ck = json(['checkpoint', 'create', '--bot', 'sales', '--approve']);
    expect(ck.checkpoint.version).toBe(1);
    expect(ck.checkpoint.reviewStatus).toBe('reviewed');
    expect(gcm(['checkpoint', 'verify', 'latest', '--bot', 'sales']).code).toBe(0);
    const ho = json(['handoff', 'prepare', '--bot', 'sales']);
    expect(ho.state).toBe('HANDOFF_READY');
    const text = gcm(['handoff', 'show', 'latest', '--bot', 'sales', '--text-only']).out;
    expect(text).toContain(ho.verificationCode);
    expect(text).toContain('Never share customer data');
  });

  it('accepts stdin imports and supports --dry-run without saving', () => {
    json(['bots', 'add', 'ops', '--name', 'Ops']);
    const dry = json(
      ['import', '-', '--bot', 'ops', '--dry-run'],
      'User: TODO: renew the domain\nAssistant: ok',
    );
    expect(dry.added).toBe(2);
    expect(dry.import).toBeNull();
    expect(json(['archive', 'list', '--bot', 'ops']).total).toBe(0);
    expect(
      json(['import', '-', '--bot', 'ops'], 'User: TODO: renew the domain\nAssistant: ok').added,
    ).toBe(2);
  });

  it('uses meaningful exit codes and never performs destructive steps implicitly', () => {
    expect(gcm(['bots', 'show', 'Not Valid']).code).toBe(3); // not found (invalid id never matches)
    expect(gcm(['checkpoint', 'list', '--bot', 'BAD ID']).code).toBe(2); // validation
    expect(gcm(['checkpoint', 'show', 'ck_missing']).code).toBe(3);
    const ho = json(['handoff', 'show', 'latest', '--bot', 'sales']);
    const reset = gcm(['handoff', 'action', ho.id, 'reset_chat']);
    expect(reset.code).toBe(5);
    expect(reset.err).toMatch(/permanently clears the Grok Bot transcript/);
    expect(gcm(['data', 'delete', '--bot', 'ops']).code).toBe(5);
    expect(gcm(['fleet', 'checkpoint', '--all']).code).toBe(5);
    expect(json(['bots', 'list']).map((b: { id: string }) => b.id)).toEqual(['ops', 'sales']);
  });

  it('guards file writes: no overwrite without --force, no writes into the data folder, no device names', () => {
    const target = path.join(work, 'ck.json');
    expect(gcm(['checkpoint', 'export', 'latest', '--bot', 'sales', '--out', target]).code).toBe(0);
    expect(JSON.parse(readFileSync(target, 'utf8')).format).toBe('gcm-checkpoint');
    expect(gcm(['checkpoint', 'export', 'latest', '--bot', 'sales', '--out', target]).code).toBe(5);
    expect(
      gcm(['checkpoint', 'export', 'latest', '--bot', 'sales', '--out', target, '--force']).code,
    ).toBe(0);
    expect(
      gcm([
        'checkpoint',
        'export',
        'latest',
        '--bot',
        'sales',
        '--out',
        path.join(home, 'evil.json'),
      ]).code,
    ).toBe(2);
    expect(
      gcm(['checkpoint', 'export', 'latest', '--bot', 'sales', '--out', path.join(work, 'NUL')])
        .code,
    ).toBe(2);
    expect(gcm(['import', path.join(work, 'missing.txt'), '--bot', 'sales']).code).toBe(3);
  });

  it('restores an exported checkpoint and rejects a tampered one', () => {
    const file = path.join(work, 'ck.json');
    expect(json(['checkpoint', 'import', file]).version).toBe(2);
    writeFileSync(
      path.join(work, 'bad.json'),
      readFileSync(file, 'utf8').replace('Never send pricing', 'Always send pricing'),
    );
    expect(gcm(['checkpoint', 'import', path.join(work, 'bad.json')]).code).toBe(4);
  });

  it('creates scoped MCP tokens and reports usage with separated metrics', () => {
    const tok = json(['mcp', 'token', 'create', '--name', 'sales-bot', '--bots', 'sales']);
    expect(tok.token).toMatch(/^gcm_tok_/);
    expect(tok.canWrite).toBe(false);
    const list = json(['mcp', 'token', 'list']);
    expect(JSON.stringify(list)).not.toContain(tok.token);
    const rep = json(['usage', 'report', '--bot', 'sales'])[0];
    expect(rep.estimates.kind).toBe('estimated');
    expect(rep.platformComparison.status).toBe('not_measured');
  });

  it('serves MCP over stdio from the packaged CLI (read-only, scoped)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, '--home', home, 'mcp', 'serve', '--bots', 'sales', '--read-only'],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toHaveLength(10);
      expect(tools).not.toContain('gcm_import_context');
      const r = (await client.callTool({ name: 'gcm_list_bots', arguments: {} })) as {
        content: { text: string }[];
      };
      expect(JSON.parse(r.content[0]!.text).map((b: { bot_id: string }) => b.bot_id)).toEqual([
        'sales',
      ]);
      // A second process can use the same database concurrently (WAL).
      expect(json(['bots', 'list']).length).toBe(2);
    } finally {
      await client.close();
    }
  });

  it('refuses a remote Ollama URL without explicit consent', () => {
    expect(gcm(['settings', 'set', 'ollamaUrl', 'https://llm.example.com']).code).toBe(5);
    expect(gcm(['settings', 'set', 'ollamaUrl', 'http://127.0.0.1:11434']).code).toBe(0);
  });
});
