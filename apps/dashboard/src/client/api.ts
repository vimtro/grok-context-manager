/** Typed client for the local dashboard API. Only type imports from @gcm/core (no Node code in the browser). */
import type {
  BotProfile,
  BotSummary,
  Capability,
  CheckpointDiff,
  CheckpointRecord,
  ContinuationResult,
  HandoffRecord,
  HandoffState,
  ImportRecord,
  IntegrityReport,
  Paged,
  PlatformActionGuide,
  Settings,
  UsageReport,
  AnalysisPreview,
  ArchiveHit,
} from '@gcm/core';

export type {
  BotProfile,
  BotSummary,
  Capability,
  CheckpointDiff,
  CheckpointRecord,
  ContinuationResult,
  HandoffRecord,
  HandoffState,
  ImportRecord,
  IntegrityReport,
  Paged,
  PlatformActionGuide,
  Settings,
  UsageReport,
  AnalysisPreview,
  ArchiveHit,
};

const session = document.querySelector<HTMLMetaElement>('meta[name="gcm-session"]')?.content ?? '';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      'x-gcm-session': session,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data: unknown = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })()
    : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; hint?: string } } | null)
      ?.error;
    throw new ApiError(
      err?.code ?? 'INTERNAL',
      err?.message ?? `Request failed (${res.status})`,
      err?.hint,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  /** Downloads a server response as a file (export endpoints need the session header, so no plain links). */
  async download(url: string, filename: string) {
    const res = await fetch(url, { headers: { 'x-gcm-session': session } });
    if (!res.ok) throw new ApiError('INTERNAL', `Download failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};

export interface QuickAddResult {
  created: { id: string; name: string }[];
  existing: { id: string; name: string }[];
  ignored: string[];
}

export interface Overview {
  bots: BotSummary[];
  recentCheckpoints: {
    id: string;
    botId: string;
    version: number;
    createdAt: string;
    reviewStatus: string;
    tokens: number;
    conflicts: number;
  }[];
  activeHandoffs: {
    id: string;
    botId: string;
    state: HandoffState;
    createdAt: string;
    tokens: number;
  }[];
  failures: { at: string; op: string; botId: string | null; code: string }[];
}

export const STATE_TEXT: Record<HandoffState, string> = {
  CHECKPOINT_READY: 'Checkpoint saved and verified.',
  ARCHIVE_VERIFIED: 'Source archive verified.',
  HANDOFF_READY: 'Handoff ready to copy.',
  USER_ACTION_REQUIRED: 'Waiting for you to do the step in Grok Bot.',
  EXTERNAL_RESET_UNVERIFIED:
    'You did the platform step. Its effect on Grok Bot’s context cannot be verified by GCM.',
  CONTINUATION_VERIFIED:
    'The bot confirmed it loaded the handoff. (Not proof that platform context shrank.)',
  FAILED_RECOVERABLE: 'A step failed. Nothing was deleted — you can retry.',
};
