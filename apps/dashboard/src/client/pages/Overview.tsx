import { api, type Overview as OverviewData } from '../api';
import { Badge, Card, Empty, ErrorNote, fmt, Loading, Note, Stat, useAsync } from '../ui';

export function Overview() {
  const { data, error, loading } = useAsync(() => api.get<OverviewData>('/api/overview'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const archive = data.bots.reduce((n, b) => n + b.archiveTokensEstimate, 0);
  const warnings = data.bots.flatMap((b) => b.warnings.map((w) => ({ bot: b.id, w })));

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <a className="btn btn-primary" href="#/bots/new">
          Add bot
        </a>
      </div>
      <Note>
        GCM keeps checkpoints and compact handoffs of the context <em>you import</em>. It cannot
        read, compact or reset Grok Bot’s own conversations — when it is time for a fresh
        conversation, the Handoff wizard walks you through the step in the Grok Bot app.
      </Note>
      <div className="stats">
        <Stat label="Registered bots" value={data.bots.length} />
        <Stat label="Recent checkpoints" value={data.recentCheckpoints.length} />
        <Stat label="Active handoffs" value={data.activeHandoffs.length} />
        <Stat
          label="Archived text"
          value={fmt.tokens(archive)}
          note="estimated tokens of imported material"
        />
      </div>

      <Card title="Bots">
        {data.bots.length === 0 ? (
          <Empty>
            No bots yet. <a href="#/bots/new">Add your first bot</a>, then import a conversation.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bot</th>
                  <th>Messages</th>
                  <th>Archive (est.)</th>
                  <th>Latest checkpoint</th>
                  <th>New imports</th>
                  <th>Handoff size (est.)</th>
                </tr>
              </thead>
              <tbody>
                {data.bots.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <a href={`#/bots/${b.id}`}>{b.name}</a>{' '}
                      <span className="muted mono">{b.id}</span>
                      {b.warnings.length > 0 && (
                        <Badge tone="warn">{`${b.warnings.length} warning${b.warnings.length > 1 ? 's' : ''}`}</Badge>
                      )}
                    </td>
                    <td>{b.messages}</td>
                    <td>{fmt.tokens(b.archiveTokensEstimate)}</td>
                    <td>
                      {b.headCheckpoint ? (
                        <>
                          v{b.headCheckpoint.version} <Badge>{b.headCheckpoint.reviewStatus}</Badge>
                        </>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td>{b.uncheckpointedImports}</td>
                    <td>{b.headCheckpoint ? fmt.tokens(b.headCheckpoint.tokens) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Recent checkpoints">
          {data.recentCheckpoints.length === 0 ? (
            <Empty>No checkpoints yet.</Empty>
          ) : (
            <ul className="list">
              {data.recentCheckpoints.map((c) => (
                <li key={c.id}>
                  <a href={`#/checkpoints/${c.botId}/${c.id}`}>
                    {c.botId} v{c.version}
                  </a>{' '}
                  <Badge>{c.reviewStatus}</Badge>{' '}
                  {c.conflicts > 0 && <Badge tone="bad">{`${c.conflicts} conflict(s)`}</Badge>}
                  <span className="muted">
                    {' '}
                    · {fmt.tokens(c.tokens)} · {fmt.date(c.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Active handoffs">
          {data.activeHandoffs.length === 0 ? (
            <Empty>No handoffs in progress.</Empty>
          ) : (
            <ul className="list">
              {data.activeHandoffs.map((h) => (
                <li key={h.id}>
                  <a href={`#/wizard/${h.botId}/${h.id}`}>{h.botId}</a> <Badge>{h.state}</Badge>
                  <span className="muted">
                    {' '}
                    · {fmt.tokens(h.tokens)} · {fmt.date(h.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {(warnings.length > 0 || data.failures.length > 0) && (
        <Card title="Warnings and recent failures">
          <ul className="list">
            {warnings.map((w, i) => (
              <li key={`w${i}`}>
                <Badge tone="warn">warning</Badge> <a href={`#/bots/${w.bot}`}>{w.bot}</a>: {w.w}
              </li>
            ))}
            {data.failures.map((f, i) => (
              <li key={`f${i}`}>
                <Badge tone="bad">failed</Badge> {f.op}{' '}
                {f.botId && <span className="mono">{f.botId}</span>}{' '}
                <span className="muted">
                  ({f.code}) {fmt.date(f.at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
