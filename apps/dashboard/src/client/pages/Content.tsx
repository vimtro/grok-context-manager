/** Shared rendering of checkpoint content (used by analysis preview, checkpoint view and the wizard). */
import type { CheckpointRecord } from '../api';
import { Badge, Card, Empty, Note } from '../ui';

type Content = CheckpointRecord['content'];
type Item = Content['decisions'][number];

const FLAG_LABEL: Partial<Record<Item['flags'][number], string>> = {
  negative_instruction: 'negative',
  security: 'security',
  deadline: 'deadline',
  conflict: 'conflict',
  secret_redacted: 'secret redacted',
  approved_proposal: 'approved',
  truncated: 'shortened',
  carried_forward: 'carried forward',
};

export function ItemList({ items, empty = 'None' }: { items: Item[]; empty?: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="items">
      {items.map((i) => (
        <li
          key={i.id}
          title={`${i.category}/${i.kind} · ${i.reason} · confidence ${Math.round(i.confidence * 100)}%`}
        >
          <span>{i.text}</span>
          {i.deadline && <Badge tone="warn">{`due ${i.deadline}`}</Badge>}
          {i.flags.map(
            (f) =>
              FLAG_LABEL[f] && (
                <Badge
                  key={f}
                  tone={f === 'conflict' ? 'bad' : f === 'security' ? 'warn' : 'neutral'}
                >
                  {FLAG_LABEL[f]}
                </Badge>
              ),
          )}
          {i.protected && <span className="sr-only">(protected)</span>}
          <span className="refs">{i.sourceRefs.map((r) => `#${r.seq}`).join(' ')}</span>
        </li>
      ))}
    </ul>
  );
}

export function ContentView({ content }: { content: Content }) {
  const c = content;
  return (
    <>
      <Card title="Objective">
        {c.objective ? (
          <p>
            {c.objective.text}{' '}
            <Badge tone={c.objective.basis === 'inferred_latest_request' ? 'warn' : 'neutral'}>
              {c.objective.basis.replace(/_/g, ' ')}
            </Badge>
          </p>
        ) : (
          <Empty>Not stated in the supplied material.</Empty>
        )}
        {c.narrative && (
          <Note>
            <strong>Local model summary (unverified wording):</strong> {c.narrative}
          </Note>
        )}
      </Card>
      {c.conflicts.length > 0 && (
        <Card title={`Needs your confirmation (${c.conflicts.length})`}>
          <Note tone="bad">
            These statements disagree and neither was explicitly marked as replacing the other. Both
            are kept; confirm which applies.
          </Note>
          <ul className="list">
            {c.conflicts.map((cf) => (
              <li key={cf.id}>
                “{cf.texts[0]}” <strong>vs</strong> “{cf.texts[1]}”
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid-2">
        <Card
          title={`Must follow (${c.constraints.length + (c.identity.standingRules?.length ?? 0)})`}
        >
          {(c.identity.standingRules?.length ?? 0) > 0 && (
            <ul className="items">
              {c.identity.standingRules.map((r, i) => (
                <li key={i}>
                  {r} <Badge tone="neutral">bot profile</Badge>
                </li>
              ))}
            </ul>
          )}
          <ItemList items={c.constraints} empty={c.identity.standingRules?.length ? '' : 'None'} />
        </Card>
        <Card title={`Decisions (${c.decisions.length})`}>
          <ItemList items={c.decisions} />
        </Card>
        <Card title={`Pending tasks (${c.pendingTasks.length})`}>
          <ItemList items={c.pendingTasks} />
        </Card>
        <Card title={`Open questions & blockers (${c.openQuestions.length})`}>
          <ItemList items={c.openQuestions} />
        </Card>
        <Card title={`Recent progress (${c.progress.length})`}>
          <ItemList items={c.progress} />
        </Card>
        <Card title={`Key knowledge (${c.knowledge.length})`}>
          <ItemList items={c.knowledge} />
        </Card>
      </div>
      {c.resources.length > 0 && (
        <Card title="Resources">
          <p className="chips">
            {c.resources.map((r) => (
              <code key={r.value} title={r.type}>
                {r.value}
              </code>
            ))}
          </p>
        </Card>
      )}
      {c.uncertainties.length > 0 && (
        <Card title="Caveats">
          <ul className="bullets">
            {c.uncertainties.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </Card>
      )}
      <p className="tiny">
        Excluded from working context (kept in the archive): temporary {c.excluded.temporary} ·
        obsolete/superseded {c.excluded.obsolete} · historical {c.excluded.historical} · quarantined{' '}
        {c.excluded.quarantined} · over budget {c.excluded.overBudget}
      </p>
    </>
  );
}
