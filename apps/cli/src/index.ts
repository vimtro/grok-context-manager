/**
 * gcm — Grok Context Manager CLI.
 * Keep your bots. Keep their knowledge. Lose the unnecessary context.
 */
import { Command } from 'commander';
import { APP_VERSION } from '@gcm/core';
import { closeAll, preloadTokenizer, registerCommands, setHome } from './commands';
import { mode, reportError } from './output';

const program = new Command();
program
  .name('gcm')
  .description(
    'Grok Context Manager: local checkpoints, archives and compact handoffs for Cursor Grok Bot teammates.\n' +
      'GCM manages its own stored copy of context; it never reads, prunes or resets Grok Bot’s transcript.',
  )
  .version(APP_VERSION, '-v, --version')
  .option(
    '--home <dir>',
    'GCM data folder (default: %LOCALAPPDATA%\\GrokContextManager, or GCM_HOME)',
  )
  .option('--json', 'machine-readable JSON output')
  .option('-q, --quiet', 'less output')
  .showHelpAfterError('(run with --help for usage)')
  .hook('preAction', async (_this, action) => {
    const g = action.optsWithGlobals<{ home?: string; json?: boolean; quiet?: boolean }>();
    mode.json = Boolean(g.json);
    mode.quiet = Boolean(g.quiet);
    setHome(g.home);
    await preloadTokenizer();
  });

registerCommands(program);

program.addHelpText(
  'after',
  `
Examples (PowerShell):
  gcm init
  gcm bots add sales --name "Sales" --role "Account executive"
  Get-Clipboard | gcm import - --bot sales --session 2026-10-sales
  gcm analyze --bot sales
  gcm checkpoint create --bot sales --approve
  gcm handoff prepare --bot sales
  gcm handoff show latest --bot sales --text-only | Set-Clipboard
  gcm dashboard
`,
);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    process.exitCode = reportError(e);
  } finally {
    // Long-running commands (dashboard, mcp serve) close their own resources.
    const cmd = process.argv[2];
    if (cmd !== 'dashboard' && cmd !== 'mcp') closeAll();
  }
}

void main();
