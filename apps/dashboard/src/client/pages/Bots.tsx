import { useState } from 'react';
import {
  api,
  type ArchiveHit,
  type BotProfile,
  type BotSummary,
  type CheckpointRecord,
  type ImportRecord,
  type Paged,
  type UsageReport,
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
  Stat,
  useAction,
  useAsync,
} from '../ui';
import { QuickAddBots } from './QuickAdd';

export function BotsList() {
  const { data, error, loading, reload } = useAsync(() => api.get<BotSummary[]>('/api/bots'), []);
  return (
    <>
      <div className="page-head">
        <h1>Bots</h1>
        <a className="btn" href="#/bots/new">
          Add bot with full profile
        </a>
      </div>
      <QuickAddBots onAdded={reload} />
      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : data && data.length === 0 ? (
        <Empty>No bots yet. Add their names above.</Empty>
      ) : (
        <div className="cards">
          {data?.map((b) => (
            <a key={b.id} className="bot-card" href={`#/bots/${b.id}`}>
              <div className="bot-card-name">{b.name}</div>
              <div className="muted mono">{b.id}</div>
              <div className="bot-card-role">
                {b.role || <span className="muted">No role set</span>}
              </div>
              <div className="bot-card-meta">
                {b.headCheckpoint ? (
                  <>
                    Checkpoint v{b.headCheckpoint.version}{' '}
                    <Badge>{b.headCheckpoint.reviewStatus}</Badge>
                  </>
                ) : (
                  <Badge tone="neutral">no checkpoint</Badge>
                )}
                {b.warnings.length > 0 && (
                  <Badge tone="warn">{`${b.warnings.length} warning(s)`}</Badge>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

const LIST_FIELDS: [keyof BotProfile, string, string][] = [
  ['responsibilities', 'Responsibilities', 'One per line'],
  ['instructions', 'Operating instructions', 'Included in every handoff under “Must follow”'],
  ['securityBoundaries', 'Security boundaries', 'Included in every handoff under “Must follow”'],
  ['preferences', 'Working preferences', 'One per line'],
  ['longTermDecisions', 'Long-term decisions', 'One per line'],
  ['skills', 'Skills', 'Skill names used by this bot'],
  ['plugins', 'Plugins / connectors', 'Required apps or connectors'],
  ['routines', 'Routines', 'Descriptions of scheduled routines'],
  ['projects', 'Projects', 'Project responsibilities'],
  ['memoryReferences', 'Memory references', 'Pointers to long-term memory or documents'],
];

export function BotEditor({ botId }: { botId?: string }) {
  const existing = useAsync(
    () => (botId ? api.get<{ bot: BotProfile }>(`/api/bots/${botId}`) : Promise.resolve(null)),
    [botId],
  );
  const bot = existing.data?.bot;
  if (botId && existing.loading && !bot) return <Loading />;
  return <BotForm key={bot?.updatedAt ?? 'new'} bot={bot} />;
}

function BotForm({ bot }: { bot?: BotProfile }) {
  const [id, setId] = useState(bot?.id ?? '');
  const [name, setName] = useState(bot?.name ?? '');
  const [role, setRole] = useState(bot?.role ?? '');
  const [notes, setNotes] = useState(bot?.notes ?? '');
  const [lists, setLists] = useState<Record<string, string>>(
    Object.fromEntries(
      LIST_FIELDS.map(([k]) => [k, ((bot?.[k] as string[] | undefined) ?? []).join('\n')]),
    ),
  );
  const [profile, setProfile] = useState(bot?.policy.profile ?? 'balanced');
  const [budget, setBudget] = useState(bot?.policy.handoffBudgetTokens?.toString() ?? '');
  const [shareWith, setShareWith] = useState(bot?.policy.shareWith.join(', ') ?? '');
  const [mcpExposed, setMcpExposed] = useState(bot?.policy.mcpExposed ?? true);
  const action = useAction();

  const save = () =>
    action.run(async () => {
      const toList = (s: string) =>
        s
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
      const body = {
        id: id.trim(),
        createOnly: !bot,
        name: name.trim() || undefined,
        role,
        notes,
        ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, toList(lists[k] ?? '')])),
        policy: {
          profile,
          handoffBudgetTokens: budget.trim() ? Number(budget) : null,
          shareWith: shareWith
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          mcpExposed,
        },
      };
      const r = await api.post<{ bot: BotProfile }>('/api/bots', body);
      window.location.hash = `#/bots/${r.bot.id}`;
    });

  return (
    <>
      <div className="page-head">
        <h1>{bot ? `Edit ${bot.name}` : 'Add bot'}</h1>
      </div>
      <Note>
        Identity is what you tell GCM about this bot. GCM never reads Grok Bot’s private settings,
        so only enter what you know.
      </Note>
      <Card>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="form-row">
            <Field
              label="Bot ID"
              hint="Lowercase letters, digits, - or _ (e.g. sales, chief-of-staff)"
            >
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                disabled={Boolean(bot)}
                required
                pattern="[a-z0-9][a-z0-9_-]{0,63}"
              />
            </Field>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales" />
            </Field>
          </div>
          <Field label="Role">
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Account executive for enterprise renewals"
            />
          </Field>
          <div className="form-grid">
            {LIST_FIELDS.map(([k, label, hint]) => (
              <Field key={k} label={label} hint={hint}>
                <textarea
                  rows={3}
                  value={lists[k]}
                  onChange={(e) => setLists({ ...lists, [k]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          <Field label="Notes">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <fieldset>
            <legend>Policy</legend>
            <div className="form-row">
              <Field label="Default profile">
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value as typeof profile)}
                >
                  <option value="compact">Compact</option>
                  <option value="balanced">Balanced</option>
                  <option value="detailed">Detailed</option>
                </select>
              </Field>
              <Field label="Handoff budget (tokens)" hint="Empty = profile default">
                <input
                  type="number"
                  min={200}
                  max={100000}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </Field>
              <Field label="Share read access with" hint="Bot IDs, comma-separated (default: none)">
                <input value={shareWith} onChange={(e) => setShareWith(e.target.value)} />
              </Field>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={mcpExposed}
                onChange={(e) => setMcpExposed(e.target.checked)}
              />{' '}
              Visible to MCP clients
            </label>
          </fieldset>
          <ErrorNote error={action.error} />
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={action.busy}>
              {action.busy ? 'Saving…' : 'Save bot'}
            </button>
            <a className="btn" href={bot ? `#/bots/${bot.id}` : '#/bots'}>
              Cancel
            </a>
          </div>
        </form>
      </Card>
    </>
  );
}

export function BotDetail({ botId }: { botId: string }) {
  const bot = useAsync(
    () => api.get<{ bot: BotProfile; summary: BotSummary | null }>(`/api/bots/${botId}`),
    [botId],
  );
  const cks = useAsync(
    () => api.get<Paged<CheckpointRecord>>(`/api/bots/${botId}/checkpoints?limit=10`),
    [botId],
  );
  const imports = useAsync(
    () => api.get<Paged<ImportRecord>>(`/api/bots/${botId}/imports?limit=100`),
    [botId],
  );
  const usage = useAsync(() => api.get<UsageReport>(`/api/bots/${botId}/usage`), [botId]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Paged<ArchiveHit> | null>(null);
  const search = useAction();

  if (bot.error) return <ErrorNote error={bot.error} />;
  if (!bot.data) return <Loading />;
  const b = bot.data.bot;
  const head = cks.data?.items[0];
  const u = usage.data;

  const listBlock = (label: string, xs: string[]) =>
    xs.length > 0 && (
      <div>
        <h3>{label}</h3>
        <ul className="bullets">
          {xs.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{b.name}</h1>
          <div className="muted">
            <span className="mono">{b.id}</span> · {b.role || 'no role set'}
          </div>
        </div>
        <div className="actions">
          <a className="btn" href={`#/bots/${b.id}/edit`}>
            Edit profile
          </a>
          <a className="btn" href={`#/analyze/${b.id}`}>
            Import &amp; analyze
          </a>
          <a className="btn btn-primary" href={`#/wizard/${b.id}`}>
            Start handoff
          </a>
        </div>
      </div>
      {bot.data.summary?.warnings.map((w, i) => (
        <Note key={i} tone="warn">
          {w}
        </Note>
      ))}
      {u && (
        <div className="stats">
          <Stat
            label="Imported text"
            value={fmt.tokens(u.estimates.importedTokens)}
            note="estimated tokens"
          />
          <Stat
            label="Latest checkpoint"
            value={fmt.tokens(u.estimates.checkpointTokens)}
            note="estimated tokens"
          />
          <Stat
            label="Latest handoff"
            value={fmt.tokens(u.estimates.handoffTokens)}
            note="estimated tokens"
          />
          <Stat
            label="Text reduction"
            value={
              u.estimates.estimatedTextReductionPercent === null
                ? '—'
                : `${u.estimates.estimatedTextReductionPercent}%`
            }
            note={u.partial ? 'of supplied text · partial coverage' : 'of supplied text'}
          />
        </div>
      )}
      <div className="grid-2">
        <Card title="Identity (user-provided)">
          {listBlock('Security boundaries', b.securityBoundaries)}
          {listBlock('Operating instructions', b.instructions)}
          {listBlock('Responsibilities', b.responsibilities)}
          {listBlock('Preferences', b.preferences)}
          {listBlock('Long-term decisions', b.longTermDecisions)}
          {listBlock('Skills', b.skills)}
          {listBlock('Routines', b.routines)}
          {listBlock('Projects', b.projects)}
          <p className="tiny">
            Policy: {b.policy.profile} profile · budget {b.policy.handoffBudgetTokens ?? 'default'}{' '}
            · shares with [{b.policy.shareWith.join(', ') || 'nobody'}] · MCP{' '}
            {b.policy.mcpExposed ? 'visible' : 'hidden'}
          </p>
        </Card>
        <Card
          title="Current checkpoint"
          actions={head && <a href={`#/checkpoints/${b.id}/${head.id}`}>Open</a>}
        >
          {!head ? (
            <Empty>
              No checkpoint yet. <a href={`#/analyze/${b.id}`}>Import and analyze</a> a
              conversation.
            </Empty>
          ) : (
            <>
              <p>
                v{head.version} <Badge>{head.reviewStatus}</Badge> · {fmt.date(head.createdAt)}
              </p>
              <h3>Objective</h3>
              <p>{head.content.objective?.text ?? <span className="muted">Not stated</span>}</p>
              <h3>Pending tasks ({head.content.pendingTasks.length})</h3>
              <ul className="bullets">
                {head.content.pendingTasks.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    {t.text} {t.deadline && <Badge tone="warn">{`due ${t.deadline}`}</Badge>}
                  </li>
                ))}
              </ul>
              <h3>Decisions ({head.content.decisions.length})</h3>
              <ul className="bullets">
                {head.content.decisions.slice(0, 6).map((t) => (
                  <li key={t.id}>{t.text}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
      <Card title="Checkpoint history">
        {cks.data && cks.data.items.length > 0 ? (
          <ul className="list">
            {cks.data.items.map((c) => (
              <li key={c.id}>
                <a href={`#/checkpoints/${b.id}/${c.id}`}>v{c.version}</a>{' '}
                <Badge>{c.reviewStatus}</Badge>
                <span className="muted">
                  {' '}
                  · {fmt.date(c.createdAt)} · {fmt.tokens(c.tokenEstimate.tokens)}{' '}
                  {c.restoredFromId ? '· restored' : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No versions yet.</Empty>
        )}
      </Card>
      <Card title="Archive">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void search.run(async () =>
              setHits(
                await api.get<Paged<ArchiveHit>>(
                  `/api/bots/${b.id}/archive/search?q=${encodeURIComponent(q)}&limit=20`,
                ),
              ),
            );
          }}
        >
          <input
            aria-label="Search archive"
            placeholder="Search this bot’s archive…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!q.trim() || search.busy}>
            Search
          </button>
        </form>
        <ErrorNote error={search.error} />
        {hits && (
          <ul className="list">
            <li className="muted">{hits.total} match(es)</li>
            {hits.items.map((h) => (
              <li key={h.messageId}>
                <span className="mono muted">
                  {h.importId}#{h.seq} {h.role}
                </span>{' '}
                {h.snippet}
              </li>
            ))}
          </ul>
        )}
        <h3>Imports</h3>
        {imports.data && imports.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Import</th>
                  <th>When</th>
                  <th>Session</th>
                  <th>Messages</th>
                  <th>Size (est.)</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {imports.data.items.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td>{fmt.date(i.importedAt)}</td>
                    <td>{i.sessionRef ?? '—'}</td>
                    <td>{i.messageCount}</td>
                    <td>{fmt.tokens(i.tokenEstimate)}</td>
                    <td>
                      <Badge tone={i.completeness === 'complete' ? 'ok' : 'warn'}>
                        {i.completeness}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing imported yet.</Empty>
        )}
      </Card>
      {u && (
        <Card title="Usage report">
          <ol className="metrics">
            <li>
              <strong>Locally estimated tokens</strong> ({u.estimates.method}): imported{' '}
              {fmt.tokens(u.estimates.importedTokens)}, checkpoint{' '}
              {fmt.tokens(u.estimates.checkpointTokens)}, handoff{' '}
              {fmt.tokens(u.estimates.handoffTokens)}
            </li>
            <li>
              <strong>Provider-measured records</strong> (entered by you): {u.measured.length}
            </li>
            <li>
              <strong>Billing / quota records</strong> (entered by you): {u.billing.length}
            </li>
            <li>
              <strong>Estimated text reduction</strong>:{' '}
              {u.estimates.estimatedTextReductionPercent === null
                ? '—'
                : `${u.estimates.estimatedTextReductionPercent}% of supplied text`}
            </li>
            <li>
              <strong>Confirmed platform-context reduction</strong>:{' '}
              {u.platformComparison.status === 'not_measured' ? (
                <Badge tone="warn">not measured</Badge>
              ) : (
                `${u.platformComparison.inputTokenChangePercent}% fewer input tokens (your measurements; not verified by GCM)`
              )}
            </li>
          </ol>
          <UsageRecorder botId={b.id} onSaved={usage.reload} />
          <ul className="tiny">
            {u.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="tiny">
            GCM’s own overhead: {u.gcmOverhead.operations} operations, {u.gcmOverhead.durationMs}{' '}
            ms, {u.gcmOverhead.localModelTokens} local-model tokens, ~
            {u.gcmOverhead.mcpResponseTokensEstimated} tokens returned to MCP clients.
          </p>
        </Card>
      )}
    </>
  );
}

function UsageRecorder({ botId, onSaved }: { botId: string; onSaved: () => void }) {
  const [label, setLabel] = useState('before_handoff');
  const [input, setInput] = useState('');
  const [source, setSource] = useState('');
  const a = useAction();
  return (
    <details>
      <summary>Record a measurement you obtained yourself</summary>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api.post(`/api/bots/${botId}/usage`, {
              kind: 'provider_measured',
              label,
              inputTokens: Number(input),
              source: source || 'user-supplied',
            });
            setInput('');
            onSaved();
          });
        }}
      >
        <Field label="Label" hint="Use before_handoff / after_handoff for comparisons">
          <input value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
        <Field label="Input tokens">
          <input
            type="number"
            min={0}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            required
          />
        </Field>
        <Field label="Source">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Where did this number come from?"
          />
        </Field>
        <button className="btn" type="submit" disabled={a.busy}>
          Record
        </button>
      </form>
      <ErrorNote error={a.error} />
    </details>
  );
}
