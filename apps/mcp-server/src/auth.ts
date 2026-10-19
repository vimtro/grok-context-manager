/**
 * API tokens for the remote MCP endpoint. Tokens are shown once at creation; only their SHA-256 hash is stored.
 * Each token is scoped to explicit bot IDs (or '*' when the user deliberately creates a fleet token) and is
 * read-only unless created with write access.
 */
import { randomBytes } from 'node:crypto';
import {
  BotIdSchema,
  GcmError,
  newId,
  sha256,
  type AccessContext,
  type ApiTokenRecord,
  type Store,
} from '@gcm/core';

export const TOKEN_PREFIX = 'gcm_tok_';

export function createApiToken(
  store: Store,
  opts: { name: string; bots: '*' | string[]; canWrite: boolean },
): { record: ApiTokenRecord; token: string } {
  const name = opts.name.trim();
  if (!name || name.length > 80)
    throw new GcmError('VALIDATION', 'Token name must be 1–80 characters.');
  if (opts.bots !== '*') {
    if (opts.bots.length === 0)
      throw new GcmError('VALIDATION', 'Give at least one bot ID (or "*" for every bot).');
    for (const b of opts.bots) {
      if (!BotIdSchema.safeParse(b).success)
        throw new GcmError('VALIDATION', `Invalid bot ID "${b}".`);
    }
  }
  const token = `${TOKEN_PREFIX}${randomBytes(24)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '')}`;
  const record: ApiTokenRecord = {
    id: newId('tok'),
    name,
    tokenHash: sha256(token),
    bots: opts.bots,
    canWrite: opts.canWrite,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastUsedAt: null,
  };
  store.insertApiToken(record);
  return { record, token };
}

/** Extracts a token from `Authorization: Bearer …` or `X-GCM-Token: …`. */
export function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const auth = headers.authorization;
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (authValue?.startsWith('Bearer ')) return authValue.slice(7).trim() || null;
  const custom = headers['x-gcm-token'];
  const customValue = Array.isArray(custom) ? custom[0] : custom;
  return customValue?.trim() || null;
}

export function authenticate(
  store: Store,
  token: string | null,
): { record: ApiTokenRecord; ctx: AccessContext } | null {
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const record = store.findApiTokenByHash(sha256(token));
  if (!record || record.revokedAt) return null;
  store.touchApiToken(record.id, new Date().toISOString());
  const ctx: AccessContext = {
    bots: record.bots,
    canWrite: record.canWrite,
    channel: 'mcp',
  };
  if (record.bots !== '*' && record.bots.length === 1) ctx.actorBotId = record.bots[0];
  return { record, ctx };
}

export function activeTokenCount(store: Store): number {
  return store.listApiTokens().filter((t) => !t.revokedAt).length;
}
