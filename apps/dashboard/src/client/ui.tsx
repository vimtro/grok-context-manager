/** Small, accessible UI primitives. */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ApiError } from './api';

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: ApiError | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch(
        (e: unknown) =>
          alive && setError(e instanceof ApiError ? e : new ApiError('INTERNAL', String(e))),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Runs an action with busy/error state; returns a wrapped runner. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('INTERNAL', String(e)));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

export function Card({
  title,
  actions,
  children,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2 id={id}>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

const TONE: Record<string, string> = {
  reviewed: 'ok',
  CONTINUATION_VERIFIED: 'ok',
  VERIFIED_SUPPORTED: 'ok',
  ok: 'ok',
  unreviewed: 'warn',
  HANDOFF_READY: 'info',
  CHECKPOINT_READY: 'info',
  ARCHIVE_VERIFIED: 'info',
  USER_ACTION_REQUIRED: 'warn',
  EXTERNAL_RESET_UNVERIFIED: 'warn',
  EXPERIMENTAL: 'warn',
  UNKNOWN: 'neutral',
  FAILED_RECOVERABLE: 'bad',
  VERIFIED_UNSUPPORTED: 'bad',
  conflict: 'bad',
};

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
}) {
  const t = tone ?? (typeof children === 'string' ? (TONE[children] ?? 'neutral') : 'neutral');
  return <span className={`badge badge-${t}`}>{children}</span>;
}

export function ErrorNote({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="note note-bad" role="alert">
      <strong>{error.code.replace(/_/g, ' ').toLowerCase()}:</strong> {error.message}
      {error.hint && <div className="hint">{error.hint}</div>}
    </div>
  );
}

export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'bad' | 'ok';
  children: ReactNode;
}) {
  return <div className={`note note-${tone}`}>{children}</div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

/** Label + control + hint. The hint is exposed as the control's description, not part of its name. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {isValidElement(children)
        ? cloneElement(children, { id, 'aria-describedby': hint ? hintId : undefined })
        : children}
      {hint && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

export const fmt = {
  date: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—'),
  tokens: (n: number | null | undefined) =>
    n === null || n === undefined ? '—' : `~${n.toLocaleString()}`,
};

export function link(path: string) {
  return `#${path}`;
}
