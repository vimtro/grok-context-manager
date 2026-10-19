import { useEffect, useState } from 'react';
import { api, ApiError, type QuickAddResult } from '../api';
import { Card, ErrorNote, Field, Note, useAction } from '../ui';

const names = (xs: { name: string }[]) => xs.map((b) => b.name).join(', ');

/** Add several bots by name: type them or paste the bot list from the Grok Bot sidebar. */
export function QuickAddBots({ onAdded }: { onAdded?: (ids: string[]) => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<QuickAddResult | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<QuickAddResult | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .post<QuickAddResult>('/api/bots/quick-add', { text, dryRun: true })
        .then((r) => alive && (setPreview(r), setPreviewError(null)))
        .catch(
          (e: unknown) =>
            alive &&
            setPreviewError(e instanceof ApiError ? e : new ApiError('INTERNAL', String(e))),
        );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text]);

  const chosen = preview?.created.filter((b) => !skipped.has(b.id)) ?? [];
  const toggle = (id: string) => {
    const next = new Set(skipped);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSkipped(next);
  };
  const add = () =>
    action.run(async () => {
      const r = await api.post<QuickAddResult>('/api/bots/quick-add', {
        text: chosen.map((b) => b.name).join('\n'),
      });
      setDone(r);
      setText('');
      setSkipped(new Set());
      onAdded?.(r.created.map((b) => b.id));
    });

  return (
    <Card title="Add your bots" id="quick-add">
      <p className="muted">
        Type your Grok Bot names, one per line or separated by commas, or paste the bot list from
        the Grok Bot sidebar (times and message previews are ignored). Only the name is needed; you
        can add details later with “Edit profile”.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen.length) void add();
        }}
      >
        <Field label="Bot names">
          <textarea
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDone(null);
            }}
            placeholder={'Sales\nResearch\nChief of Staff'}
          />
        </Field>
        <ErrorNote error={previewError} />
        {preview && (
          <div className="quick-preview" aria-live="polite">
            {preview.created.length > 0 && (
              <fieldset>
                <legend>Will be added</legend>
                {preview.created.map((b) => (
                  <label key={b.id} className="check">
                    <input
                      type="checkbox"
                      checked={!skipped.has(b.id)}
                      onChange={() => toggle(b.id)}
                    />{' '}
                    {b.name} <span className="muted mono">{b.id}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {preview.existing.length > 0 && (
              <p className="muted">Already added: {names(preview.existing)}</p>
            )}
            {preview.ignored.length > 0 && (
              <p className="muted">Ignored (not bot names): {preview.ignored.join(', ')}</p>
            )}
            {preview.created.length === 0 && preview.existing.length === 0 && (
              <p className="muted">No bot names found yet.</p>
            )}
          </div>
        )}
        <ErrorNote error={action.error} />
        <div className="actions">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={chosen.length === 0 || action.busy}
          >
            {action.busy
              ? 'Adding…'
              : chosen.length
                ? `Add ${chosen.length} bot${chosen.length === 1 ? '' : 's'}`
                : 'Add bots'}
          </button>
          <a className="btn" href="#/bots/new">
            Add one with full profile
          </a>
        </div>
        {done && done.created.length > 0 && (
          <Note tone="ok">
            Added {names(done.created)}. Next: <a href="#/analyze">import a conversation</a>.
          </Note>
        )}
      </form>
    </Card>
  );
}

/** Inline "new bot" form for pickers: one name field, then jumps to the given page for the new bot. */
export function NewBotInline({ base, onCancel }: { base: string; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const action = useAction();
  const create = () =>
    action.run(async () => {
      const r = await api.post<QuickAddResult>('/api/bots/quick-add', { text: name });
      const bot = r.created[0] ?? r.existing[0];
      if (!bot)
        throw new ApiError(
          'VALIDATION',
          'That does not look like a bot name.',
          'Try e.g. “Sales”.',
        );
      window.location.hash = `#/${base}/${bot.id}`;
    });
  return (
    <form
      className="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void create();
      }}
    >
      <Field label="New bot name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sales"
          autoFocus
        />
      </Field>
      <button className="btn btn-primary" type="submit" disabled={!name.trim() || action.busy}>
        {action.busy ? 'Adding…' : 'Add bot'}
      </button>
      {onCancel && (
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
      <ErrorNote error={action.error} />
    </form>
  );
}
