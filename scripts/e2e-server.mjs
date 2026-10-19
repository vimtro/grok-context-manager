#!/usr/bin/env node
/**
 * Starts the BUILT CLI's dashboard against a fresh temporary GCM data folder for Playwright.
 * Seeds one bot through the real CLI so the UI tests exercise the packaged code path.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'apps', 'cli', 'dist', 'gcm.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'gcm-e2e-'));
const port = process.env.GCM_E2E_PORT ?? '4800';

const gcm = (...args) => {
  const r = spawnSync(process.execPath, [cli, '--home', home, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gcm ${args.join(' ')} failed: ${r.stderr}`);
};
gcm(
  'bots',
  'add',
  'sales',
  '--name',
  'Sales Bot',
  '--role',
  'Account executive',
  '--boundary',
  'Never share customer data outside the CRM',
);
gcm('bots', 'add', 'research', '--name', 'Research', '--role', 'Market research');

const child = spawn(
  process.execPath,
  [cli, '--home', home, 'dashboard', '--no-open', '--port', port],
  { stdio: 'inherit' },
);
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
