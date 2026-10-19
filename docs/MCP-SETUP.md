# MCP server setup

GCM includes a Model Context Protocol server built on the official TypeScript SDK. The same tools are served over:

- **stdio** — for local MCP clients (Cursor IDE and other agents) or a command on Grok Bot's cloud computer.
- **streamable HTTP** (stateless, JSON responses) — for a remote Grok Bot connector behind HTTPS.

Both use the same core (`GcmService`) and the same SQLite data.

## Local clients (stdio)

```json
{
  "mcpServers": {
    "gcm": {
      "command": "gcm",
      "args": ["mcp", "serve", "--bots", "sales,research"]
    }
  }
}
```

Cursor IDE: `%USERPROFILE%\.cursor\mcp.json` (all projects) or `.cursor\mcp.json` (one project).
Options: `--bots a,b` (default: all bots), `--read-only` (only the 10 read tools), `--home <dir>`.
Stdout carries the protocol; logs go to stderr.

## Remote endpoint (HTTP)

```powershell
grokcm mcp token create --name sales-bot --bots sales --write   # shown once; only its SHA-256 hash is stored
grokcm mcp serve --http --host 127.0.0.1 --port 8787
```

Safety rules (fail closed):

- The HTTP server **refuses to start without at least one active token**.
- Binding to a non-loopback address requires `--tls-cert/--tls-key` (native HTTPS) or `--behind-tls-proxy`
  (you confirm a TLS-terminating proxy or tunnel is in front). Plain-HTTP remote exposure is refused.
- Every `/mcp` request needs `Authorization: Bearer <token>` (or `X-GCM-Token: <token>`). Revoked tokens fail.
- Per-token rate limit (120 requests/min) and failed-auth limit (20/min per IP); 2 MB body limit; 200,000-character
  import limit per call; responses capped at `mcpMaxResponseTokens` (default 4,000 estimated tokens).
- On loopback binds, requests with a foreign `Host` header or any `Origin` header are rejected (DNS-rebinding protection).
- Logs contain method, path, status and duration only — never request bodies or tokens.
- `GET /healthz` (no auth) returns `{ ok, service, version }` only.

Token management: `grokcm mcp token list`, `grokcm mcp token revoke <id>`. A token created with `--bots "*"` can access every
bot (fleet coordinator) — create it deliberately.

## Docker deployment

Files in [`docker/`](../docker): a multi-stage `Dockerfile` (Node 22, non-root user, data volume) and a
`docker-compose.yml` that puts **Caddy** in front for automatic HTTPS.

```bash
cp .env.example docker/.env     # set GCM_DOMAIN (DNS A/AAAA record must point to the server)
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml run --rm gcm bots add sales --name "Sales"
docker compose -f docker/docker-compose.yml run --rm gcm mcp token create --name sales-bot --bots sales --write
docker compose -f docker/docker-compose.yml up -d
curl https://$GCM_DOMAIN/healthz
```

The GCM container is not published directly; only Caddy listens on 80/443. Data lives in the `gcm-data` volume —
back it up with `docker compose run --rm gcm data backup --out /data/backups/manual.sqlite`.

Importing conversations on a remote host: copy the file in and run `docker compose run --rm -v ${PWD}:/in grokcm import /in/chat.txt --bot sales`, or let bots import via `gcm_import_context`.

## Connecting Grok Bot

See [GROK-BOT-SETUP.md](GROK-BOT-SETUP.md#option-2--remote-mcp-connector-https). In short, ask the bot:
“Add a custom MCP server called gcm at https://<host>/mcp with header Authorization: Bearer <token>”.

## Tools

All tools take explicit IDs, return compact text/JSON and are capped by the response budget. Read-only connections
(read-only token or `--read-only`) only see tools marked _read_. No tool resets, prunes or reads Grok Bot's own
conversation. Errors are returned as `ERROR <CODE>: <message> Hint: …` with `isError: true`; codes: `VALIDATION`,
`NOT_FOUND` (also used for bots the token may not access), `FORBIDDEN`, `APPROVAL_REQUIRED`, `INVALID_STATE`,
`CONFLICT`, `INTEGRITY`, `LIMIT_EXCEEDED`, `INTERNAL`.

| Tool                        | Access | Purpose                                            | Inputs                                                                                                       | Output                                             | Privacy / context-expansion risk                                |
| --------------------------- | ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------- |
| `gcm_describe_capabilities` | read   | What GCM can/cannot do with Grok Bot               | —                                                                                                            | Summary + capability statuses                      | None; ~600 tokens                                               |
| `gcm_health`                | read   | Server/storage status                              | —                                                                                                            | ok, versions, bot count                            | None; tiny                                                      |
| `gcm_list_bots`             | read   | Bots this connection may access                    | —                                                                                                            | id, name, role, latest checkpoint, warnings        | Metadata only                                                   |
| `gcm_analyze_context`       | read   | Preview what a checkpoint would retain             | bot_id, profile?, budget_tokens?, objective?                                                                 | Counts, conflicts, caveats, size estimates         | Conflict texts are returned; no archive content otherwise       |
| `gcm_estimate_tokens`       | read   | Local token estimate (no model call)               | text (≤1M chars), method?                                                                                    | tokens, method, kind=estimated                     | Echoes nothing back                                             |
| `gcm_list_checkpoints`      | read   | Version list                                       | bot_id, limit≤50, offset                                                                                     | Paginated summaries                                | Small                                                           |
| `gcm_get_checkpoint`        | read   | Read a checkpoint                                  | checkpoint_id or bot_id, format handoff/summary/json                                                         | Handoff-style view (default), summary or full JSON | `json` can be large → truncated at the budget; prefer `handoff` |
| `gcm_compare_checkpoints`   | read   | Diff two versions of one bot                       | from_id, to_id                                                                                               | Section diff                                       | Contains item texts                                             |
| `gcm_get_handoff`           | read   | Read a handoff and its state                       | handoff_id or bot_id, include_text?                                                                          | State, code, text                                  | Text ≈ handoff size; `include_text:false` for state only        |
| `gcm_search_archive`        | read   | Keyword search in one bot's archive                | bot_id, query≤200, limit≤20, offset                                                                          | Snippets (secrets redacted)                        | Keep queries narrow; default limit 5                            |
| `gcm_upsert_bot`            | write  | Register/update a profile from user-supplied facts | bot_id, name?, role?, lists…                                                                                 | Profile summary                                    | Cannot change sharing/visibility policy (local only)            |
| `gcm_import_context`        | write  | Store explicitly supplied text in the archive      | bot_id, text≤200k, format?, session_ref?, coverage partial/unknown                                           | import id, added, duplicates, warnings             | Treated as data; `complete` coverage not accepted from bots     |
| `gcm_create_checkpoint`     | write  | New checkpoint version                             | bot_id, profile?, budget_tokens?, objective?, workstream?, user_approved?                                    | Version summary + warnings                         | `user_approved` only after explicit user approval               |
| `gcm_review_checkpoint`     | write  | Record user approval                               | checkpoint_id, user_confirmed=true, note?                                                                    | Summary                                            | Requires literal `true`                                         |
| `gcm_prepare_handoff`       | write  | Compact handoff from a reviewed checkpoint         | bot_id, checkpoint_id?, profile?, budget_tokens?                                                             | id, code, size, text                               | Does not touch Grok Bot                                         |
| `gcm_update_handoff_state`  | write  | Advance the workflow                               | handoff_id, action (choose_new_group_chat, choose_continue_in_place, report_done, verify_reply), reply_text? | New state + guidance                               | Reset chat cannot be chosen over MCP; replies are not stored    |

## Overhead

GCM records the estimated size of every MCP response (`grokcm usage report` → “MCP response tokens”) so you can see what
the connector itself adds to a bot's context.
