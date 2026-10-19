/**
 * Data-directory resolution and safe file-path handling (Windows first, macOS/Linux compatible).
 */
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { GcmError } from '@gcm/core';

export const DB_FILENAME = 'gcm.sqlite';

/** Default: %LOCALAPPDATA%\GrokContextManager on Windows; overridable with GCM_HOME or --home. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GCM_HOME?.trim()) return path.resolve(env.GCM_HOME.trim());
  const os = platform();
  if (os === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'GrokContextManager');
  }
  if (os === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', 'GrokContextManager');
  return path.join(
    env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
    'grok-context-manager',
  );
}

/** Creates the data directory with owner-only permissions where the OS supports POSIX modes. */
export function ensureDataDir(dir: string): string {
  const abs = path.resolve(dir);
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(abs, 'backups'), { recursive: true, mode: 0o700 });
  restrictPermissions(abs, 0o700);
  return abs;
}

/**
 * POSIX: chmod to owner-only. Windows: files under %LOCALAPPDATA% inherit the user-profile ACL, which
 * already restricts access to the user, SYSTEM and Administrators; chmod is a no-op there.
 */
export function restrictPermissions(p: string, mode: number): void {
  if (platform() === 'win32') return;
  try {
    chmodSync(p, mode);
  } catch {
    /* best effort */
  }
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

function basicChecks(p: string): string {
  if (!p || typeof p !== 'string') throw new GcmError('VALIDATION', 'A file path is required.');
  if (p.includes('\0')) throw new GcmError('VALIDATION', 'File path contains a NUL byte.');
  if (/^\\\\[?.]\\/.test(p) || /^\/\/[?.]\//.test(p)) {
    throw new GcmError(
      'VALIDATION',
      'Device-namespace paths (\\\\?\\ or \\\\.\\) are not allowed.',
    );
  }
  const abs = path.resolve(p);
  if (WINDOWS_RESERVED.test(path.basename(abs))) {
    throw new GcmError('VALIDATION', `"${path.basename(abs)}" is a reserved Windows device name.`);
  }
  return abs;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Validates a path GCM is about to write (exports, backups). */
export function safeOutputPath(
  p: string,
  opts: { force?: boolean; dataDir?: string; allowInDataDir?: boolean } = {},
): string {
  const abs = basicChecks(p);
  if (opts.dataDir && !opts.allowInDataDir && isInside(abs, path.resolve(opts.dataDir))) {
    throw new GcmError(
      'VALIDATION',
      'Refusing to write inside the GCM data directory (protects the database).',
    );
  }
  const parent = path.dirname(abs);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new GcmError('VALIDATION', `Folder does not exist: ${parent}`);
  }
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory())
      throw new GcmError('VALIDATION', `${abs} is a folder, not a file.`);
    if (!opts.force)
      throw new GcmError(
        'APPROVAL_REQUIRED',
        `${abs} already exists.`,
        'Pass --force to overwrite it.',
      );
  }
  return abs;
}

/** Max bytes GCM will read from an input file (transcripts, checkpoint exports). */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Validates a path GCM is about to read. */
export function safeInputPath(p: string): string {
  const abs = basicChecks(p);
  if (!existsSync(abs)) throw new GcmError('NOT_FOUND', `File not found: ${abs}`);
  const st = statSync(abs);
  if (!st.isFile()) throw new GcmError('VALIDATION', `${abs} is not a regular file.`);
  if (st.size > MAX_INPUT_BYTES) {
    throw new GcmError(
      'LIMIT_EXCEEDED',
      `${abs} is ${(st.size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB. Split the export into parts.`,
    );
  }
  return abs;
}
