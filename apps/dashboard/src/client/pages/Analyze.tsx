import { useState } from 'react';
import { api, type AnalysisPreview, type BotSummary, type CheckpointRecord } from '../api';
import {
  Badge,
  Card,
  ErrorNote,
  Field,
  fmt,
  Loading,
  Note,
  Stat,
  useAction,
  useAsync,
} from '../ui';
import { ContentView, ItemList } from './Content';
import { NewBotInline } from './QuickAdd';

const NEW_BOT = '__new__';

export function BotPicker({ botId, base }: { botId?: string; base: string }) {
  const bots = useAsync(() => api.get<BotSummary[]>('/api/bots'), []);
  const [adding, setAdding] = useState(false);
  if (!bots.data) return <Loading />;
  if (bots.data.length === 0 || adding)
    return (
      <NewBotInline base={base} onCancel={bots.data.length ? () => setAdding(false) : undefined} />
    );
  return (
    <Field label="Bot">
      <select
        value={botId ?? ''}
        onChange={(e) =>
          e.target.value === NEW_BOT
            ? setAdding(true)
            : (window.location.hash = `#/${base}/${e.target.value}`)
        }
      >
        <option value="" disabled>
          Choose a bot…
        </option>
        {bots.data.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} ({b.id})
          </option>
        ))}
        <option value={NEW_BOT}>+ New bot…</option>
      </select>
    </Field>
  );
}

export function ImportPanel({ botId, onImported }: { botId: string; onImported: () => void }) {
  const [text, setText] = useState('');
  const [session, setSession] = useState('');
  const [coverage, setCoverage] = useState('unknown');
  const [format, setFormat] = useState('auto');
  const [assistant, setAssistant] = useState('');
  const [result, setResult] = useState<{
    added: number;
    duplicatesSkipped: number;
    warnings: string[];
    format: string;
  } | null>(null);
  const a = useAction();
  return (
    <Card title="1 · Import conversation material">
      <p className="muted">
        Paste text copied from the Grok Bot conversation (or upload a .txt / .md / .json export).
        Already-imported messages are skipped automatically.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api.post<{
              added: number;
              duplicatesSkipped: number;
              warnings: string[];
              format: string;
            }>(`/api/bots/${botId}/import`, {
              text,
              sessionRef: session || undefined,
              completeness: coverage,
              format,
              assistantNames: assistant ? assistant.split(',').map((s) => s.trim()) : [],
            });
            setResult(r);
            if (r.added > 0) setText('');
            onImported();
          });
        }}
      >
        <Field label="Conversation text">
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'User: …\nSales Bot: …'}
            required
          />
        </Field>
        <div className="form-row">
          <Field label="Or upload a file">
            <input
              type="file"
              accept=".txt,.md,.markdown,.json,.jsonl,text/plain,application/json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
              }}
            />
          </Field>
          <Field
            label="Session label"
            hint="Optional; re-imports of the same session add only new messages"
          >
            <input value={session} onChange={(e) => setSession(e.target.value)} />
          </Field>
          <Field label="Coverage" hint="Choose “complete” only if this is the whole conversation">
            <select value={coverage} onChange={(e) => setCoverage(e.target.value)}>
              <option value="unknown">Unknown</option>
              <option value="partial">Partial excerpt</option>
              <option value="complete">Complete conversation</option>
            </select>
          </Field>
          <Field label="Format">
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="auto">Detect automatically</option>
              <option value="text">Plain text</option>
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
              <option value="jsonl">JSON lines</option>
            </select>
          </Field>
          <Field
            label="Bot speaker names"
            hint="Optional, comma-separated (the bot’s name is detected automatically)"
          >
            <input value={assistant} onChange={(e) => setAssistant(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={a.error} />
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={a.busy || !text.trim()}>
            {a.busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
      {result && (
        <Note tone={result.added ? 'ok' : 'info'}>
          {result.added} new message(s) imported ({result.format}), {result.duplicatesSkipped}{' '}
          already in the archive.
          {result.warnings.map((w, i) => (
            <div key={i} className="hint">
              {w}
            </div>
          ))}
        </Note>
      )}
    </Card>
  );
}

export function AnalysisPanel({
  botId,
  onSaved,
}: {
  botId: string;
  onSaved?: (ck: CheckpointRecord) => void;
}) {
  const [profile, setProfile] = useState('');
  const [budget, setBudget] = useState('');
  const [objective, setObjective] = useState('');
  const [workstream, setWorkstream] = useState('');
  const [rebuild, setRebuild] = useState(false);
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<CheckpointRecord | null>(null);
  const analyze = useAction();
  const save = useAction();
  const params = () => ({
    profile: profile || undefined,
    budgetTokens: budget ? Number(budget) : undefined,
    objective: objective || undefined,
    workstream: workstream || undefined,
    rebuild,
  });

  const r = preview?.result;
  const excluded = r
    ? r.items.filter((i) => ['temporary', 'obsolete', 'historical'].includes(i.category))
    : [];
  return (
    <>
      <Card title="2 · Analyze (preview — nothing is saved)">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(null);
            void analyze.run(async () =>
              setPreview(await api.post<AnalysisPreview>(`/api/bots/${botId}/analyze`, params())),
            );
          }}
        >
          <div className="form-row">
            <Field label="Profile">
              <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="">Bot default</option>
                <option value="compact">Compact (~900 tokens)</option>
                <option value="balanced">Balanced (~2,000 tokens)</option>
                <option value="detailed">Detailed (~5,000 tokens)</option>
              </select>
            </Field>
            <Field label="Token budget" hint="Optional override">
              <input
                type="number"
                min={200}
                max={50000}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <Field label="Current objective" hint="Optional; otherwise taken from the conversation">
              <input value={objective} onChange={(e) => setObjective(e.target.value)} />
            </Field>
            <Field label="Workstream">
              <input value={workstream} onChange={(e) => setWorkstream(e.target.value)} />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={rebuild}
              onChange={(e) => setRebuild(e.target.checked)}
            />{' '}
            Rebuild from all imports (ignore the previous checkpoint)
          </label>
          <ErrorNote error={analyze.error} />
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={analyze.busy}>
              {analyze.busy ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
        </form>
      </Card>

      {r && preview && (
        <>
          <div className="stats">
            <Stat
              label="Source text"
              value={fmt.tokens(r.content.stats.sourceTokensEstimate)}
              note={`${r.content.stats.sourceMessages} new message(s), estimated`}
            />
            <Stat
              label="Handoff size"
              value={fmt.tokens(r.handoffPreviewTokens)}
              note={`budget ${preview.budgetTokens}, estimated`}
            />
            <Stat
              label="Coverage"
              value={
                <Badge tone={r.completeness === 'complete' ? 'ok' : 'warn'}>{r.completeness}</Badge>
              }
            />
            <Stat
              label="Validation"
              value={
                <Badge tone={preview.validation.ok ? 'ok' : 'bad'}>
                  {preview.validation.ok ? 'passed' : 'failed'}
                </Badge>
              }
            />
          </div>
          {preview.previousCheckpointId && (
            <Note>
              Builds on the previous checkpoint: its retained items are carried forward and updated
              with {preview.importIds.length} new import(s).
            </Note>
          )}
          {r.warnings.map((w, i) => (
            <Note key={i} tone="warn">
              {w}
            </Note>
          ))}
          {preview.validation.errors.map((e, i) => (
            <Note key={i} tone="bad">
              {e}
            </Note>
          ))}
          <ContentView content={r.content} />
          <Card title={`Excluded from working context (${excluded.length})`}>
            <details>
              <summary>Show excluded items (they stay in the archive)</summary>
              <ItemList items={excluded} />
            </details>
          </Card>
          <Card title="3 · Review and save">
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(async () => {
                  const res = await api.post<{ checkpoint: CheckpointRecord }>(
                    `/api/bots/${botId}/checkpoints`,
                    { ...params(), approve: reviewed, note: note || undefined },
                  );
                  setSaved(res.checkpoint);
                  onSaved?.(res.checkpoint);
                });
              }}
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                I reviewed the retained information above (marks the checkpoint as reviewed)
              </label>
              <Field label="Review note (optional)">
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <ErrorNote error={save.error} />
              <div className="actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={save.busy || !preview.validation.ok}
                >
                  {save.busy ? 'Saving…' : 'Save checkpoint'}
                </button>
              </div>
            </form>
            {saved && (
              <Note tone="ok">
                Saved checkpoint v{saved.version} ({saved.reviewStatus}).{' '}
                <a href={`#/checkpoints/${botId}/${saved.id}`}>Open it</a> or{' '}
                <a href={`#/wizard/${botId}`}>continue to the handoff wizard</a>.
              </Note>
            )}
          </Card>
        </>
      )}
    </>
  );
}

export function Analyze({ botId }: { botId?: string }) {
  const [tick, setTick] = useState(0);
  return (
    <>
      <div className="page-head">
        <h1>Context analysis</h1>
      </div>
      <Card>
        <BotPicker botId={botId} base="analyze" />
      </Card>
      {botId && (
        <>
          <ImportPanel botId={botId} onImported={() => setTick(tick + 1)} />
          <AnalysisPanel key={`${botId}-${tick}`} botId={botId} />
        </>
      )}
    </>
  );
}
