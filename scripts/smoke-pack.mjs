#!/usr/bin/env node
/**
 * Clean-install smoke test: packs the CLI into an npm tarball, installs it into an empty folder exactly as a
 * user would (`npm install grok-context-manager-<v>.tgz`), and runs the core workflow with the installed copy.
 * Usage: pnpm build && pnpm smoke
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = path.join(root, 'apps', 'cli');
const isWin = process.platform === 'win32';
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: isWin, ...opts });

if (!existsSync(path.join(cliDir, 'dist', 'gcm.mjs'))) {
  console.error('Build first: pnpm build');
  process.exit(1);
}
const work = mkdtempSync(path.join(tmpdir(), 'gcm-smoke-'));
const step = (name) => console.log(`\n▶ ${name}`);
try {
  step('pack');
  sh('pnpm', ['pack', '--pack-destination', work], { cwd: cliDir });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('no tarball produced');
  console.log(tgz);

  step('install into an empty project (npm install <tarball>)');
  const app = path.join(work, 'app');
  sh('npm', ['init', '-y'], { cwd: work, stdio: 'ignore' });
  sh('npm', ['install', '--no-audit', '--no-fund', '--prefix', app, path.join(work, tgz)], {
    cwd: work,
    stdio: 'inherit',
  });
  const pkgDir = path.join(app, 'node_modules', 'grok-context-manager');
  const bin = path.join(app, 'node_modules', '.bin', isWin ? 'gcm.cmd' : 'gcm');
  if (!existsSync(bin)) throw new Error(`bin shim missing: ${bin}`);
  if (!existsSync(path.join(pkgDir, 'dist', 'dashboard', 'index.html')))
    throw new Error('dashboard assets missing from package');

  const home = path.join(work, 'home');
  const gcm = (...args) => {
    const r = spawnSync(
      process.execPath,
      [path.join(pkgDir, 'dist', 'gcm.mjs'), '--home', home, ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`gcm ${args.join(' ')} → exit ${r.status}\n${r.stderr}`);
    return r.stdout;
  };
  step('run installed CLI');
  console.log(gcm('--version').trim());
  gcm('init');
  gcm('bots', 'add', 'sales', '--name', 'Sales Bot');
  console.log(
    gcm(
      'import',
      path.join(root, 'examples', 'conversations', 'chief-of-staff-long.md'),
      '--bot',
      'sales',
    ).trim(),
  );
  const ck = JSON.parse(gcm('--json', 'checkpoint', 'create', '--bot', 'sales', '--approve'));
  const ho = JSON.parse(gcm('--json', 'handoff', 'prepare', '--bot', 'sales'));
  const doctor = JSON.parse(gcm('--json', 'doctor'));
  const shim = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: isWin });
  if (shim.status !== 0) throw new Error('bin shim failed');
  console.log(
    `checkpoint v${ck.checkpoint.version}: source ~${ck.checkpoint.content.stats.sourceTokensEstimate} tokens → handoff ~${ho.tokenEstimate.tokens} tokens (estimated)`,
  );
  console.log(`doctor: ${doctor.checks.map((c) => `${c.name}=${c.status}`).join(', ')}`);
  if (doctor.checks.some((c) => c.status === 'fail')) throw new Error('doctor reported failures');
  console.log('\n✓ clean-install smoke test passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
