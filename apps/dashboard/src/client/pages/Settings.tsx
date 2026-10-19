import { useState } from 'react';
import { api, type Capability, type Settings } from '../api';
import { Badge, Card, ErrorNote, Field, fmt, Loading, Note, useAction, useAsync } from '../ui';

interface Health {
  ok: boolean;
  appVersion: string;
  schemaVersion: number;
  storage: { path: string; sizeBytes: number; ftsEnabled: boolean; integrity: string[] };
}
interface TokenRow {
  id: string;
  name: string;
  bots: '*' | string[];
  canWrite: boolean;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const isLocal = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
};

export function SettingsPage() {
  const s = useAsync(() => api.get<{ settings: Settings; dataPath: string }>('/api/settings'), []);
  const health = useAsync(() => api.get<Health>('/api/health'), []);
  const caps = useAsync(() => api.get<Capability[]>('/api/capabilities'), []);
  const mcp = useAsync(() => api.get<{ tokens: TokenRow[] }>('/api/mcp'), []);
  if (!s.data) return s.error ? <ErrorNote error={s.error} /> : <Loading />;
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <SettingsForm
        key={JSON.stringify(s.data.settings)}
        initial={s.data.settings}
        onSaved={s.reload}
      />
      <Card title="Local data">
        {health.data && (
          <ul className="list">
            <li>
              Database: <span className="mono">{health.data.storage.path}</span>
            </li>
            <li>
              Size: {(health.data.storage.sizeBytes / 1024).toFixed(0)} KB · schema v
              {health.data.schemaVersion} · integrity{' '}
              <Badge tone={health.data.ok ? 'ok' : 'bad'}>
                {health.data.storage.integrity.join(', ')}
              </Badge>{' '}
              · archive search {health.data.storage.ftsEnabled ? 'available' : 'unavailable'}
            </li>
            <li className="muted">
              Encryption at rest: not built in. The database sits in your user profile folder
              (protected by your Windows account); use BitLocker for disk encryption. Back up or
              delete GCM data with <code>gcm data backup</code> /{' '}
              <code>gcm data delete --bot &lt;id&gt; --yes</code> — this never touches Grok Bot.
            </li>
          </ul>
        )}
      </Card>
      <Card title="Privacy">
        <ul className="list">
          <li>
            Telemetry: <Badge tone="ok">none</Badge> GCM never sends usage data anywhere.
          </li>
          <li>
            Summarization: deterministic and offline by default. The optional Ollama provider only
            receives already-extracted checkpoint notes, never the raw archive.
          </li>
          <li>Exports redact secret-like values unless you explicitly include them (CLI only).</li>
          <li>
            Imported conversation text is treated as data. Instruction-like passages are quarantined
            from handoffs and shown to you for review.
          </li>
        </ul>
      </Card>
      <Card title="MCP connectivity">
        <p>
          Grok Bot runs in Cursor’s cloud and cannot reach this computer. To use GCM tools from a
          bot, run the MCP server behind a public HTTPS URL (see docs/MCP-SETUP.md) and ask the bot:
          “Add a custom MCP server called gcm at https://…/mcp with header Authorization: Bearer
          &lt;token&gt;”.
        </p>
        <p className="muted">
          Tokens are created in the terminal so they are never shown in a browser:{' '}
          <code>gcm mcp token create --name sales-bot --bots sales --write</code>
        </p>
        {mcp.data && mcp.data.tokens.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Bots</th>
                  <th>Access</th>
                  <th>Last used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mcp.data.tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="mono">{t.bots === '*' ? 'all bots' : t.bots.join(', ')}</td>
                    <td>{t.canWrite ? 'read + write' : 'read-only'}</td>
                    <td>{fmt.date(t.lastUsedAt)}</td>
                    <td>
                      <Badge tone={t.revokedAt ? 'neutral' : 'ok'}>
                        {t.revokedAt ? 'revoked' : 'active'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Grok Bot capability matrix">
        {caps.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Status</th>
                  <th>What GCM does</th>
                </tr>
              </thead>
              <tbody>
                {caps.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.question}</td>
                    <td>
                      <Badge>{c.status}</Badge>
                    </td>
                    <td>
                      {c.approach}
                      <div className="tiny">{c.evidence}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const [remoteOk, setRemoteOk] = useState(false);
  const [status, setStatus] = useState<{
    label: string;
    status: { ok: boolean; detail: string };
  } | null>(null);
  const save = useAction();
  const check = useAction();
  const remote = form.summarizer === 'ollama' && !isLocal(form.ollamaUrl);
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });
  return (
    <Card title="Processing">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(async () => {
            await api.put('/api/settings', { ...form, allowRemote: remoteOk });
            onSaved();
          });
        }}
      >
        <div className="form-row">
          <Field label="Summarization provider">
            <select
              value={form.summarizer}
              onChange={(e) => upd('summarizer', e.target.value as Settings['summarizer'])}
            >
              <option value="deterministic">Deterministic (offline, no model)</option>
              <option value="ollama">Deterministic + local Ollama narrative</option>
            </select>
          </Field>
          <Field label="Token estimation">
            <select
              value={form.tokenMethod}
              onChange={(e) => upd('tokenMethod', e.target.value as Settings['tokenMethod'])}
            >
              <option value="heuristic">Character heuristic (fast)</option>
              <option value="o200k">o200k reference tokenizer (closer, not Grok’s)</option>
            </select>
          </Field>
          <Field label="Default profile">
            <select
              value={form.defaultProfile}
              onChange={(e) => upd('defaultProfile', e.target.value as Settings['defaultProfile'])}
            >
              <option value="compact">Compact</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
            </select>
          </Field>
        </div>
        {form.summarizer === 'ollama' && (
          <div className="form-row">
            <Field label="Ollama URL">
              <input value={form.ollamaUrl} onChange={(e) => upd('ollamaUrl', e.target.value)} />
            </Field>
            <Field
              label="Model"
              hint="Must already be installed (ollama list). GCM never downloads models."
            >
              <input
                value={form.ollamaModel ?? ''}
                onChange={(e) => upd('ollamaModel', e.target.value || null)}
              />
            </Field>
            <Field label="Timeout (ms)">
              <input
                type="number"
                min={1000}
                max={600000}
                value={form.ollamaTimeoutMs}
                onChange={(e) => upd('ollamaTimeoutMs', Number(e.target.value))}
              />
            </Field>
          </div>
        )}
        {remote && (
          <Note tone="warn">
            This Ollama URL is not on this computer: checkpoint notes would be sent to it.
            <label className="check">
              <input
                type="checkbox"
                checked={remoteOk}
                onChange={(e) => setRemoteOk(e.target.checked)}
              />{' '}
              I understand and want to use a remote endpoint
            </label>
          </Note>
        )}
        <fieldset>
          <legend>Handoff budgets (estimated tokens)</legend>
          <div className="form-row">
            {(['compact', 'balanced', 'detailed'] as const).map((p) => (
              <Field key={p} label={p}>
                <input
                  type="number"
                  min={200}
                  max={100000}
                  value={form.budgets[p]}
                  onChange={(e) => upd('budgets', { ...form.budgets, [p]: Number(e.target.value) })}
                />
              </Field>
            ))}
            <Field label="Max MCP response" hint="Caps what GCM returns into a bot’s context">
              <input
                type="number"
                min={500}
                max={50000}
                value={form.mcpMaxResponseTokens}
                onChange={(e) => upd('mcpMaxResponseTokens', Number(e.target.value))}
              />
            </Field>
          </div>
        </fieldset>
        <ErrorNote error={save.error ?? check.error} />
        <div className="actions">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={save.busy || (remote && !remoteOk)}
          >
            Save settings
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void check.run(async () => setStatus(await api.get('/api/provider-status')))
            }
          >
            Check provider (saved settings)
          </button>
        </div>
        {status && (
          <Note
            tone={status.status.ok ? 'ok' : 'warn'}
          >{`${status.label}: ${status.status.detail}`}</Note>
        )}
      </form>
    </Card>
  );
}
