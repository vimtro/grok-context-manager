#!/usr/bin/env node
/**
 * Packs the built CLI and installs it globally with npm, so `gcm` is on your PATH.
 * Usage (after `pnpm build`): pnpm install:global
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = path.join(root, 'apps', 'cli');
const shell = process.platform === 'win32';
if (!existsSync(path.join(cliDir, 'dist', 'gcm.mjs'))) {
  console.error('Build first: pnpm build');
  process.exit(1);
}
const out = mkdtempSync(path.join(tmpdir(), 'gcm-pack-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', out], {
    cwd: cliDir,
    stdio: 'inherit',
    shell,
  });
  const tgz = readdirSync(out).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('pack failed');
  execFileSync('npm', ['install', '-g', '--no-audit', '--no-fund', path.join(out, tgz)], {
    stdio: 'inherit',
    shell,
  });
  console.log('\n✓ installed. Open a new terminal and run: grokcm doctor');
} finally {
  rmSync(out, { recursive: true, force: true });
}
