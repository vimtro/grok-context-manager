import { createHash, randomBytes } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted, `undefined` dropped.
 * Used for content hashes so that a checkpoint's hash does not depend on key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Time-sortable unique id with a short type prefix, e.g. `ck_mf3k2a9f-3c9e1a7b`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${time}${randomBytes(5).toString('hex')}`;
}

/** Short human-friendly code derived from a hash, e.g. `GCM-7F3A-91C2`. */
export function shortCode(hash: string): string {
  const h = hash.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return `GCM-${h.slice(0, 4)}-${h.slice(4, 8)}`;
}
