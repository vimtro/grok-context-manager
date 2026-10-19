/**
 * Handoff wizard: Select bot → Context → Analyze → Review & save → Verify → Handoff → Choose step → Do it in
 * Grok Bot → Verify continuation. GCM never performs the platform step itself.
 */
import { useState } from 'react';
import {
  api,
  STATE_TEXT,
  type BotSummary,
  type CheckpointRecord,
  type ContinuationResult,
  type HandoffRecord,
  type HandoffState,
  type IntegrityReport,
  type Paged,
  type PlatformActionGuide,
} from '../api';
import {
  Badge,
  Card,
  CopyButton,
  Empty,
  ErrorNote,
  Field,
  fmt,
  Loading,
  Note,
  useAction,
  useAsync,
} from '../ui';
import { AnalysisPanel, BotPicker, ImportPanel } from './Analyze';

const STEPS: { state: HandoffState; label: string }[] = [
  { state: 'CHECKPOINT_READY', label: 'Checkpoint' },
  { state: 'ARCHIVE_VERIFIED', label: 'Archive verified' },
  { state: 'HANDOFF_READY', label: 'Handoff ready' },
  { state: 'USER_ACTION_REQUIRED', label: 'Your step in Grok Bot' },
  { state: 'EXTERNAL_RESET_UNVERIFIED', label: 'Done (unverified)' },
  { state: 'CONTINUATION_VERIFIED', label: 'Continuation verified' },
];

function Stepper({ handoff }: { handoff: HandoffRecord | null }) {
  const reached = new Set(handoff?.events.map((e) => e.state) ?? []);
  return (
    <ol className="stepper" aria-label="Workflow progress">
      {STEPS.map((s) => (
        <li
          key={s.state}
          className={handoff?.state === s.state ? 'current' : reached.has(s.state) ? 'done' : ''}
          aria-current={handoff?.state === s.state ? 'step' : undefined}
        >
          {s.label}
        </li>
      ))}
      {handoff?.state === 'FAILED_RECOVERABLE' && (
        <li className="failed current">Failed — recoverable</li>
      )}
    </ol>
  );
}

export function Wizard({ botId, handoffId }: { botId?: string; handoffId?: string }) {
  return (
    <>
      <div className="page-head">
        <h1>Handoff wizard</h1>
      </div>
      <Note>
        Use this when a bot’s conversation has grown long. You keep the same bot; GCM prepares a
        compact handoff and guides you through starting a fresh conversation in the Grok Bot app.
        GCM cannot reset or shrink Grok Bot’s context itself, and never deletes a bot.
      </Note>
      <Card title="Select bot">
        <BotPicker botId={botId} base="wizard" />
      </Card>
      {botId &&
        (handoffId ? (
          <HandoffFlow key={handoffId} handoffId={handoffId} />
        ) : (
          <Prepare key={botId} botId={botId} />
        ))}
    </>
  );
}

function Prepare({ botId }: { botId: string }) {
  const bot = useAsync(
    () => api.get<{ summary: BotSummary | null }>(`/api/bots/${botId}`),
    [botId],
  );
  const cks = useAsync(
    () => api.get<Paged<CheckpointRecord>>(`/api/bots/${botId}/checkpoints?limit=1`),
    [botId],
  );
  const handoffs = useAsync(
    () => api.get<Paged<HandoffRecord>>(`/api/bots/${botId}/handoffs?limit=5`),
    [botId],
  );
  const [verify, setVerify] = useState<IntegrityReport | null>(null);
  const [profile, setProfile] = useState('');
  const [budget, setBudget] = useState('');
  const [tick, setTick] = useState(0);
  const a = useAction();
  if (!bot.data || !cks.data) return <Loading />;
  const head = cks.data.items[0];
  const summary = bot.data.summary;
  const open = handoffs.data?.items.filter((h) => h.state !== 'CONTINUATION_VERIFIED') ?? [];

  return (
    <>
      {open.length > 0 && (
        <Card title="Handoffs in progress">
          <ul className="list">
            {open.map((h) => (
              <li key={h.id}>
                <a href={`#/wizard/${botId}/${h.id}`}>Resume {fmt.date(h.createdAt)}</a>{' '}
                <Badge>{h.state}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Step 1 · Available conversation data">
        <p>
          {summary?.messages ?? 0} archived message(s) in {summary?.imports ?? 0} import(s);{' '}
          {summary?.uncheckpointedImports ?? 0} import(s) not yet in a checkpoint.
        </p>
        <p className="muted">
          GCM only knows what you import. Copy the recent part of the Grok Bot conversation (at
          least everything since the last checkpoint) and import it below.
        </p>
      </Card>
      <ImportPanel botId={botId} onImported={() => (setTick(tick + 1), bot.reload())} />
      <AnalysisPanel key={tick} botId={botId} onSaved={() => (cks.reload(), setVerify(null))} />

      <Card title="Step 4 · Verify and generate the handoff">
        {!head ? (
          <Empty>Save a checkpoint first (step 3).</Empty>
        ) : (
          <>
            <p>
              Latest checkpoint: v{head.version} <Badge>{head.reviewStatus}</Badge> ·{' '}
              {fmt.tokens(head.tokenEstimate.tokens)} tokens (estimated) ·{' '}
              {fmt.date(head.createdAt)}
            </p>
            {head.reviewStatus !== 'reviewed' && (
              <Note tone="warn">
                This checkpoint has not been reviewed. Check its content, then mark it reviewed:{' '}
                <button
                  className="btn"
                  onClick={() =>
                    void a.run(
                      async () => (
                        await api.post(`/api/checkpoints/${head.id}/review`, {}),
                        cks.reload()
                      ),
                    )
                  }
                >
                  Mark reviewed
                </button>
              </Note>
            )}
            <div className="actions">
              <button
                className="btn"
                onClick={() =>
                  void a.run(async () =>
                    setVerify(await api.get<IntegrityReport>(`/api/checkpoints/${head.id}/verify`)),
                  )
                }
              >
                Verify checkpoint &amp; archive
              </button>
            </div>
            {verify && (
              <Note tone={verify.checkpointOk && verify.archiveOk ? 'ok' : 'bad'}>
                {verify.details.join(' ')}
              </Note>
            )}
            <div className="form-row">
              <Field label="Handoff profile">
                <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                  <option value="">Same as checkpoint</option>
                  <option value="compact">Compact</option>
                  <option value="balanced">Balanced</option>
                  <option value="detailed">Detailed</option>
                </select>
              </Field>
              <Field label="Token budget" hint="Optional">
                <input
                  type="number"
                  min={200}
                  max={50000}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </Field>
            </div>
            <ErrorNote error={a.error} />
            <div className="actions">
              <button
                className="btn btn-primary"
                disabled={a.busy || head.reviewStatus !== 'reviewed'}
                onClick={() =>
                  void a.run(async () => {
                    const h = await api.post<HandoffRecord>(`/api/bots/${botId}/handoffs`, {
                      checkpointId: head.id,
                      profile: profile || undefined,
                      budgetTokens: budget ? Number(budget) : undefined,
                    });
                    window.location.hash = `#/wizard/${botId}/${h.id}`;
                  })
                }
              >
                Generate handoff
              </button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

const ACTIONS: {
  action: 'new_group_chat' | 'reset_chat' | 'continue_in_place';
  title: string;
  text: string;
}[] = [
  {
    action: 'new_group_chat',
    title: 'New group chat with this bot (recommended)',
    text: 'Non-destructive. Your old conversation stays as history.',
  },
  {
    action: 'reset_chat',
    title: 'Reset chat (destructive)',
    text: 'Only if your Grok Bot build shows “Reset chat”. Permanently clears the transcript.',
  },
  {
    action: 'continue_in_place',
    title: 'Paste into the current conversation',
    text: 'Refocuses the bot but does not reduce what Grok Bot reprocesses.',
  },
];

function HandoffFlow({ handoffId }: { handoffId: string }) {
  const h = useAsync(() => api.get<HandoffRecord>(`/api/handoffs/${handoffId}`), [handoffId]);
  const [guide, setGuide] = useState<PlatformActionGuide | null>(null);
  const [ack, setAck] = useState(false);
  const [reply, setReply] = useState('');
  const [result, setResult] = useState<ContinuationResult | null>(null);
  const a = useAction();
  if (h.error) return <ErrorNote error={h.error} />;
  if (!h.data) return <Loading />;
  const ho = h.data;
  const set = (x: HandoffRecord) => (h.reload(), x);

  return (
    <>
      <Stepper handoff={ho} />
      <Note
        tone={
          ho.state === 'CONTINUATION_VERIFIED'
            ? 'ok'
            : ho.state === 'FAILED_RECOVERABLE'
              ? 'bad'
              : 'info'
        }
      >
        <Badge>{ho.state}</Badge> {STATE_TEXT[ho.state]}
      </Note>
      <Card
        title={`Handoff prompt · ${fmt.tokens(ho.tokenEstimate.tokens)} tokens (estimated)`}
        actions={<CopyButton text={ho.text} label="Copy handoff" />}
      >
        <pre className="handoff" tabIndex={0}>
          {ho.text}
        </pre>
        <p className="tiny">
          Verification code <strong>{ho.verificationCode}</strong>. The handoff contains no archive
          dump; older detail stays in your local archive.
        </p>
      </Card>

      {(ho.state === 'HANDOFF_READY' ||
        ho.state === 'USER_ACTION_REQUIRED' ||
        ho.state === 'FAILED_RECOVERABLE') && (
        <Card title="Step 5 · Choose how to continue in Grok Bot">
          <div className="choices">
            {ACTIONS.map((x) => (
              <div
                key={x.action}
                className={`choice ${x.action === 'reset_chat' ? 'choice-danger' : ''} ${ho.platformAction === x.action ? 'chosen' : ''}`}
              >
                <h3>{x.title}</h3>
                <p className="muted">{x.text}</p>
                {x.action === 'reset_chat' && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />{' '}
                    I understand the Grok Bot transcript will be permanently cleared. I will use
                    Reset chat, not Delete Bot.
                  </label>
                )}
                <button
                  className={`btn ${x.action === 'reset_chat' ? 'btn-danger' : 'btn-primary'}`}
                  disabled={
                    a.busy ||
                    (x.action === 'reset_chat' && !ack) ||
                    (ho.state !== 'HANDOFF_READY' && ho.state !== 'USER_ACTION_REQUIRED')
                  }
                  onClick={() =>
                    void a.run(async () => {
                      const r = await api.post<{
                        handoff: HandoffRecord;
                        guide: PlatformActionGuide;
                      }>(`/api/handoffs/${ho.id}/action`, {
                        action: x.action,
                        acknowledgeDestructive: x.action === 'reset_chat' && ack,
                      });
                      setGuide(r.guide);
                      set(r.handoff);
                    })
                  }
                >
                  Choose
                </button>
              </div>
            ))}
          </div>
          {ho.state === 'FAILED_RECOVERABLE' && (
            <div className="actions">
              <button
                className="btn"
                onClick={() =>
                  void a.run(async () =>
                    set(await api.post<HandoffRecord>(`/api/handoffs/${ho.id}/retry`)),
                  )
                }
              >
                Start over from the handoff
              </button>
            </div>
          )}
        </Card>
      )}

      {ho.state === 'USER_ACTION_REQUIRED' && (
        <Card title="Step 6 · Do this in the Grok Bot app">
          {guide ? (
            <>
              <h3>{guide.title}</h3>
              <ol>
                {guide.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              {guide.caveats.map((c, i) => (
                <Note key={i} tone="warn">
                  {c}
                </Note>
              ))}
            </>
          ) : (
            <p>
              You chose <strong>{ho.platformAction}</strong>. Follow the steps for that option,
              paste the handoff as the first message, then come back here.
            </p>
          )}
          <div className="actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                void a.run(async () =>
                  set(await api.post<HandoffRecord>(`/api/handoffs/${ho.id}/done`)),
                )
              }
            >
              I’ve done this
            </button>
          </div>
        </Card>
      )}

      {(ho.state === 'EXTERNAL_RESET_UNVERIFIED' || ho.state === 'FAILED_RECOVERABLE') &&
        ho.platformAction && (
          <Card title="Step 7 · Verify the continuation">
            <p>
              Paste the bot’s first reply. GCM checks it for the code {ho.verificationCode}, the
              objective and the top pending tasks. The reply is not stored.
            </p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  const r = await api.post<{ handoff: HandoffRecord; result: ContinuationResult }>(
                    `/api/handoffs/${ho.id}/verify`,
                    { reply },
                  );
                  setResult(r.result);
                  set(r.handoff);
                });
              }}
            >
              <Field label="Bot reply">
                <textarea
                  rows={5}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  required
                />
              </Field>
              <div className="actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={a.busy || !reply.trim()}
                >
                  Verify
                </button>
              </div>
            </form>
          </Card>
        )}
      {result && (
        <Card title="Verification result">
          <ul className="list">
            {result.checks.map((c) => (
              <li key={c.name}>
                <Badge tone={c.passed ? 'ok' : 'bad'}>{c.passed ? 'pass' : 'fail'}</Badge> {c.name}:{' '}
                {c.detail}
              </li>
            ))}
          </ul>
          {result.passed && (
            <Note tone="ok">
              The bot loaded the handoff. To check whether usage actually dropped, record
              before/after measurements on the bot page.
            </Note>
          )}
        </Card>
      )}
      <ErrorNote error={a.error} />
      <Card title="History">
        <ul className="list">
          {ho.events.map((e, i) => (
            <li key={i}>
              <Badge>{e.state}</Badge> <span className="muted">{fmt.date(e.at)}</span> — {e.note}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
