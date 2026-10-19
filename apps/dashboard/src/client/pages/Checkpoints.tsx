import { useState } from 'react';
import {
  api,
  type CheckpointDiff,
  type CheckpointRecord,
  type IntegrityReport,
  type Paged,
} from '../api';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Field,
  fmt,
  Loading,
  Note,
  useAction,
  useAsync,
} from '../ui';
import { BotPicker } from './Analyze';
import { ContentView } from './Content';

export function Checkpoints({ botId, checkpointId }: { botId?: string; checkpointId?: string }) {
  return (
    <>
      <div className="page-head">
        <h1>Checkpoints</h1>
      </div>
      <Card>
        <BotPicker botId={botId} base="checkpoints" />
      </Card>
      {botId && <History key={botId} botId={botId} selected={checkpointId} />}
      <ImportExternal />
    </>
  );
}

function History({ botId, selected }: { botId: string; selected?: string }) {
  const list = useAsync(
    () => api.get<Paged<CheckpointRecord>>(`/api/bots/${botId}/checkpoints?limit=100`),
    [botId],
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const d = useAction();
  if (list.error) return <ErrorNote error={list.error} />;
  if (!list.data) return <Loading />;
  const items = list.data.items;
  const current = items.find((c) => c.id === selected) ?? items[0];
  return (
    <>
      <Card title={`Version history (${list.data.total})`}>
        {items.length === 0 ? (
          <Empty>
            No checkpoints yet. <a href={`#/analyze/${botId}`}>Create one</a>.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Created</th>
                  <th>Review</th>
                  <th>Coverage</th>
                  <th>Size (est.)</th>
                  <th>Tasks</th>
                  <th>Conflicts</th>
                  <th>Origin</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={c.id === current?.id ? 'selected' : ''}>
                    <td>
                      <a
                        href={`#/checkpoints/${botId}/${c.id}`}
                        aria-current={c.id === current?.id ? 'true' : undefined}
                      >
                        v{c.version}
                      </a>
                    </td>
                    <td>{fmt.date(c.createdAt)}</td>
                    <td>
                      <Badge>{c.reviewStatus}</Badge>
                    </td>
                    <td>{c.source.completeness}</td>
                    <td>{fmt.tokens(c.tokenEstimate.tokens)}</td>
                    <td>{c.content.pendingTasks.length}</td>
                    <td>
                      {c.content.conflicts.length ? (
                        <Badge tone="bad">{String(c.content.conflicts.length)}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td>
                      {c.restoredFromId
                        ? `restored from ${items.find((x) => x.id === c.restoredFromId)?.version ? `v${items.find((x) => x.id === c.restoredFromId)?.version}` : 'external file'}`
                        : c.parentId
                          ? 'incremental'
                          : 'first'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {items.length > 1 && (
        <Card title="Compare versions">
          <form
            className="form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void d.run(async () =>
                setDiff(
                  await api.get<CheckpointDiff>(`/api/checkpoints/diff?from=${from}&to=${to}`),
                ),
              );
            }}
          >
            <Field label="From">
              <select value={from} onChange={(e) => setFrom(e.target.value)} required>
                <option value="">Choose…</option>
                {items.map((c) => (
                  <option key={c.id} value={c.id}>
                    v{c.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                <option value="">Choose…</option>
                {items.map((c) => (
                  <option key={c.id} value={c.id}>
                    v{c.version}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn" type="submit" disabled={!from || !to || d.busy}>
              Compare
            </button>
          </form>
          <ErrorNote error={d.error} />
          {diff && <DiffView diff={diff} />}
        </Card>
      )}
      {current && <CheckpointDetail key={current.id} ck={current} onChange={list.reload} />}
    </>
  );
}

function DiffView({ diff }: { diff: CheckpointDiff }) {
  return (
    <div className="diff">
      <p>
        <strong>
          v{diff.from.version} → v{diff.to.version}:
        </strong>{' '}
        {diff.summary}
      </p>
      {diff.objective.changed && (
        <p>
          Objective: <del>{diff.objective.before ?? '—'}</del> →{' '}
          <ins>{diff.objective.after ?? '—'}</ins>
        </p>
      )}
      {Object.entries(diff.sections).map(([name, s]) =>
        s.added.length + s.removed.length + s.changed.length === 0 ? null : (
          <div key={name}>
            <h3>{name}</h3>
            <ul className="items">
              {s.added.map((x, i) => (
                <li key={`a${i}`}>
                  <ins>+ {x}</ins>
                </li>
              ))}
              {s.removed.map((x, i) => (
                <li key={`r${i}`}>
                  <del>− {x}</del>
                </li>
              ))}
              {s.changed.map((x, i) => (
                <li key={`c${i}`}>
                  ~ {x.before} → {x.after}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      <p className="tiny">
        Estimated size {diff.tokens.before} → {diff.tokens.after} tokens · conflicts{' '}
        {diff.conflicts.before} → {diff.conflicts.after}
      </p>
    </div>
  );
}

function CheckpointDetail({ ck, onChange }: { ck: CheckpointRecord; onChange: () => void }) {
  const a = useAction();
  const [verify, setVerify] = useState<IntegrityReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <Card
        title={
          <>
            Checkpoint v{ck.version} <Badge>{ck.reviewStatus}</Badge>
          </>
        }
        actions={
          <>
            <button
              className="btn"
              onClick={() =>
                void a.run(async () =>
                  setVerify(await api.get<IntegrityReport>(`/api/checkpoints/${ck.id}/verify`)),
                )
              }
            >
              Verify integrity
            </button>
            {ck.reviewStatus !== 'reviewed' ? (
              <button
                className="btn btn-primary"
                onClick={() =>
                  void a.run(
                    async () => (
                      await api.post(`/api/checkpoints/${ck.id}/review`, {}),
                      onChange()
                    ),
                  )
                }
              >
                Mark reviewed
              </button>
            ) : (
              <button
                className="btn"
                onClick={() =>
                  void a.run(
                    async () => (
                      await api.post(`/api/checkpoints/${ck.id}/review`, { status: 'unreviewed' }),
                      onChange()
                    ),
                  )
                }
              >
                Mark unreviewed
              </button>
            )}
            <button
              className="btn"
              onClick={() =>
                void a.run(async () => {
                  const r = await api.post<CheckpointRecord>(`/api/checkpoints/${ck.id}/restore`);
                  setMessage(
                    `Created v${r.version} with the content of v${ck.version}. Earlier versions are unchanged. Grok Bot is not modified.`,
                  );
                  onChange();
                })
              }
            >
              Restore as new version
            </button>
            <button
              className="btn"
              onClick={() =>
                void a.run(() =>
                  api.download(
                    `/api/checkpoints/${ck.id}/export?format=json`,
                    `gcm-${ck.botId}-v${ck.version}.json`,
                  ),
                )
              }
            >
              Export JSON
            </button>
            <button
              className="btn"
              onClick={() =>
                void a.run(() =>
                  api.download(
                    `/api/checkpoints/${ck.id}/export?format=markdown`,
                    `gcm-${ck.botId}-v${ck.version}.md`,
                  ),
                )
              }
            >
              Export Markdown
            </button>
            <a className="btn" href={`#/wizard/${ck.botId}`}>
              Handoff…
            </a>
          </>
        }
      >
        <p className="muted">
          <span className="mono">{ck.id}</span> · {fmt.date(ck.createdAt)} · coverage{' '}
          {ck.source.completeness} · {ck.source.provider} / {ck.source.profile} ·{' '}
          {fmt.tokens(ck.tokenEstimate.tokens)} tokens (estimated)
          {ck.restoredFromId && <> · restored from {ck.restoredFromId}</>}
        </p>
        <p className="tiny mono">hash {ck.contentHash}</p>
        <ErrorNote error={a.error} />
        {message && <Note tone="ok">{message}</Note>}
        {verify && (
          <Note tone={verify.checkpointOk && verify.archiveOk ? 'ok' : 'bad'}>
            {verify.checkpointOk && verify.archiveOk ? 'Verified.' : 'Verification failed.'}{' '}
            {verify.details.join(' ')}
          </Note>
        )}
        {ck.warnings.map((w, i) => (
          <Note key={i} tone="warn">
            {w}
          </Note>
        ))}
      </Card>
      <ContentView content={ck.content} />
    </>
  );
}

function ImportExternal() {
  const [json, setJson] = useState('');
  const [asBot, setAsBot] = useState('');
  const [result, setResult] = useState<CheckpointRecord | null>(null);
  const a = useAction();
  return (
    <Card title="Restore an externally stored checkpoint">
      <p className="muted">
        Upload a checkpoint previously exported as JSON. Its integrity hash is checked; a modified
        file is rejected. It becomes a new version — nothing is overwritten.
      </p>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () =>
            setResult(
              await api.post<CheckpointRecord>('/api/checkpoints/import', {
                json,
                asBot: asBot || undefined,
              }),
            ),
          );
        }}
      >
        <Field label="Checkpoint file (.json)">
          <input
            type="file"
            accept=".json,application/json"
            onChange={async (e) => setJson((await e.target.files?.[0]?.text()) ?? '')}
            required
          />
        </Field>
        <Field label="Import into a different bot" hint="Optional, explicit cross-bot import">
          <input value={asBot} onChange={(e) => setAsBot(e.target.value)} />
        </Field>
        <button className="btn" type="submit" disabled={!json || a.busy}>
          Restore
        </button>
      </form>
      <ErrorNote error={a.error} />
      {result && (
        <Note tone="ok">
          Restored as {result.botId} v{result.version}.{' '}
          <a href={`#/checkpoints/${result.botId}/${result.id}`}>Open</a>
        </Note>
      )}
    </Card>
  );
}
