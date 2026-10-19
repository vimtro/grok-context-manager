#!/usr/bin/env node
/**
 * Bundles the CLI (and the MCP server + dashboard server it embeds) into dist/gcm.mjs.
 * The only runtime dependency left external is better-sqlite3 (native module).
 * The built dashboard client is copied to dist/dashboard.
 */
import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const root = path.resolve(here, '..', '..');

rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [path.join(here, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(dist, 'gcm.mjs'),
  external: ['better-sqlite3'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __gcmCreateRequire } from 'node:module';",
      'const require = __gcmCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  legalComments: 'linked',
  logLevel: 'warning',
});

const client = path.join(root, 'apps', 'dashboard', 'dist');
if (existsSync(path.join(client, 'index.html'))) {
  cpSync(client, path.join(dist, 'dashboard'), { recursive: true });
} else {
  console.warn(
    'warning: dashboard client not built (run `pnpm --filter @gcm/dashboard build`); `gcm dashboard` will show a notice.',
  );
}
for (const f of ['README.md', 'LICENSE']) {
  if (existsSync(path.join(root, f))) copyFileSync(path.join(root, f), path.join(here, f));
}
console.log(`built ${path.relative(root, path.join(dist, 'gcm.mjs'))}`);
