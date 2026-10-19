#!/usr/bin/env node
/**
 * Regenerates examples/checkpoints and examples/handoffs from the example conversations using the BUILT CLI,
 * in a throwaway data folder. Usage: pnpm build && pnpm examples
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'apps', 'cli', 'dist', 'gcm.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'gcm-examples-'));
const ex = (...p) => path.join(root, 'examples', ...p);
const gcm = (...args) => {
  const r = spawnSync(process.execPath, [cli, '--home', home, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (r.status !== 0) throw new Error(`gcm ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
try {
  gcm('bots', 'add', 'sales', '--from-file', ex('bot-profiles', 'sales.json'));
  gcm('bots', 'add', 'chief-of-staff', '--from-file', ex('bot-profiles', 'chief-of-staff.json'));
  gcm('import', ex('conversations', 'sales-bot.txt'), '--bot', 'sales');
  gcm('import', ex('conversations', 'chief-of-staff-long.md'), '--bot', 'chief-of-staff');
  gcm('checkpoint', 'create', '--bot', 'sales', '--approve', '--note', 'Reviewed example');
  gcm('checkpoint', 'create', '--bot', 'chief-of-staff', '--approve', '--note', 'Reviewed example');
  for (const [bot, name] of [
    ['sales', 'sales-bot'],
    ['chief-of-staff', 'chief-of-staff'],
  ]) {
    gcm(
      'checkpoint',
      'export',
      'latest',
      '--bot',
      bot,
      '--format',
      'markdown',
      '--out',
      ex('checkpoints', `${name}-checkpoint-v1.md`),
      '--force',
    );
    gcm(
      'checkpoint',
      'export',
      'latest',
      '--bot',
      bot,
      '--format',
      'json',
      '--out',
      ex('checkpoints', `${name}-checkpoint-v1.json`),
      '--force',
    );
    gcm(
      'handoff',
      'prepare',
      '--bot',
      bot,
      '--out',
      ex('handoffs', `${name}-handoff.md`),
      '--force',
    );
  }
  console.log(gcm('usage', 'report'));
} finally {
  rmSync(home, { recursive: true, force: true });
}
