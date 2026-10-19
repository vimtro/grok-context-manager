/** Terminal output helpers: human-readable by default, structured JSON with --json. Respects NO_COLOR. */
import { EXIT_CODES, isGcmError } from '@gcm/core';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
};

export interface OutputMode {
  json: boolean;
  quiet: boolean;
}

export const mode: OutputMode = { json: false, quiet: false };

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function info(line: string): void {
  if (!mode.quiet && !mode.json) process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
  process.stderr.write(`${c.yellow('warning')} ${line}\n`);
}

/** Prints `data` as JSON in --json mode, otherwise calls `human()`. */
export function emit(data: unknown, human: () => void): void {
  if (mode.json) out(JSON.stringify(data, null, 2));
  else human();
}

export function table(rows: (string | number | null | undefined)[][], header?: string[]): void {
  const all = header ? [header, ...rows] : rows;
  const cells = all.map((r) => r.map((x) => (x === null || x === undefined ? '—' : String(x))));
  const widths =
    cells[0]?.map((_, i) => Math.min(60, Math.max(...cells.map((r) => (r[i] ?? '').length)))) ?? [];
  cells.forEach((r, idx) => {
    const line = r
      .map((x, i) => (x.length > 60 ? `${x.slice(0, 57)}...` : x).padEnd(widths[i] ?? 0))
      .join('  ');
    out(idx === 0 && header ? c.bold(line) : line);
  });
}

export function reportError(e: unknown): number {
  if (isGcmError(e)) {
    if (mode.json)
      process.stderr.write(
        `${JSON.stringify({ error: { code: e.code, message: e.message, hint: e.hint ?? null } })}\n`,
      );
    else {
      process.stderr.write(`${c.red('error')} ${e.message}\n`);
      if (e.hint) process.stderr.write(`${c.dim('hint:')} ${e.hint}\n`);
    }
    return EXIT_CODES[e.code];
  }
  const message = e instanceof Error ? e.message : String(e);
  if (mode.json)
    process.stderr.write(`${JSON.stringify({ error: { code: 'INTERNAL', message } })}\n`);
  else process.stderr.write(`${c.red('error')} ${message}\n`);
  return 1;
}

export function stateColor(state: string): string {
  if (state === 'CONTINUATION_VERIFIED' || state === 'reviewed' || state === 'VERIFIED_SUPPORTED')
    return c.green(state);
  if (state.includes('FAILED') || state === 'VERIFIED_UNSUPPORTED') return c.red(state);
  return c.yellow(state);
}
