/**
 * Secret detection and redaction.
 * Imported transcripts may contain credentials. They stay in the local archive (it is the user's data),
 * but are redacted from checkpoints, handoffs, MCP responses, and never written to logs.
 */

interface SecretPattern {
  type: string;
  re: RegExp;
  /** Index of the capture group holding the secret value (0 = whole match). */
  group?: number;
}

const PATTERNS: SecretPattern[] = [
  {
    type: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { type: 'openai-key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'xai-key', re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { type: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { type: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'gcm-token', re: /\bgcm_(?:tok|pat)_[A-Za-z0-9]{20,}\b/g },
  { type: 'bearer', re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g, group: 2 },
  {
    type: 'credential-assignment',
    re: /\b((?:password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*)(["']?)(?!\[REDACTED)([^\s"',;]{6,})\2/gi,
    group: 3,
  },
  {
    type: 'connection-string',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)(?!\[REDACTED)([^\s@/]{3,})(@)/gi,
    group: 2,
  },
];

export interface RedactionResult {
  text: string;
  found: string[];
}

export function redactSecrets(text: string): RedactionResult {
  const found: string[] = [];
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (...args: unknown[]) => {
      const match = args[0] as string;
      found.push(p.type);
      if (!p.group) return `[REDACTED:${p.type}]`;
      const groups = args.slice(1, -2) as (string | undefined)[];
      const secret = groups[p.group - 1] ?? '';
      return match.replace(secret, `[REDACTED:${p.type}]`);
    });
  }
  return { text: out, found };
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text).found.length > 0;
}

/**
 * Log-safe description of a value: never the value itself.
 * Use for any log line that would otherwise include user content.
 */
export function describeForLog(text: string): string {
  return `<${text.length} chars>`;
}
