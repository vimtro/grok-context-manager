# Security and privacy

## Principles

- **Local first.** Data stays in a SQLite file in your user profile. No telemetry. No cloud calls by default.
- **Imported content is data, never instructions.** Nothing in a transcript is executed or obeyed.
- **No platform internals.** GCM never reads Grok Bot session secrets, private endpoints, app databases or browser credentials.
- **Explicit approval for anything destructive or outward-facing.**

## Threat model and controls

| Threat                                                                                      | Control                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection inside an imported transcript reaching a fresh bot session via the handoff | Injection heuristics quarantine matching passages (kept in archive, excluded from checkpoints/handoffs, reported to the user); validator blocks instruction-override text in working context; handoff header tells the bot the notes are background, not instructions.                                                                                                                                  |
| Secrets in transcripts leaking into checkpoints, handoffs, MCP responses or logs            | Pattern-based redaction (API keys, GitHub/Slack/AWS/Google/Stripe tokens, JWTs, bearer tokens, `password=…`, connection-string passwords, private keys) in checkpoint items, handoffs, archive search snippets and exports (unless `--include-secrets`). The operations log never stores content. Handoff creation fails if a secret-like value remains.                                                |
| Cross-bot leakage (a Sales bot seeing Research data)                                        | Every query is scoped by explicit bot ID; import IDs from another bot are rejected; MCP tokens carry explicit bot lists; `shareWith` grants are opt-in and read-only; `mcpExposed: false` hides a bot; MCP clients cannot change sharing policy. Note: all Grok Bots of one user share one cloud computer and connectors are account-wide — GCM's server-side scopes are the boundary, not directories. |
| Unauthorised remote access                                                                  | HTTP server refuses to start without tokens; bearer tokens hashed with SHA-256; revocation; per-token and failed-auth rate limits; plain-HTTP non-loopback binds refused; Caddy config exposes only `/mcp` and `/healthz`.                                                                                                                                                                              |
| Other local web pages or DNS rebinding calling the dashboard/MCP server                     | Loopback-only bind; Host header allow-list; dashboard requires a per-launch session token embedded in the page; cross-origin requests rejected; strict CSP, `X-Frame-Options: DENY`, `no-store`.                                                                                                                                                                                                        |
| Path traversal / overwrites via CLI file options                                            | Absolute-path resolution, NUL and device-namespace rejection, Windows reserved names (CON, NUL, COM1…) rejected, no writes into the data folder, no overwrite without `--force`, 20 MB input limit. MCP tools never accept file paths.                                                                                                                                                                  |
| Data corruption on crash                                                                    | SQLite WAL + `synchronous=FULL`, transactions for every multi-row write, immutable checkpoints/messages (triggers), compare-and-insert versioning, read-back hash verification, backup before migrations and deletions.                                                                                                                                                                                 |
| Oversized inputs / resource exhaustion                                                      | Zod limits on every input (5 M chars per import, 200 k per MCP import, 100 k messages), 2 MB HTTP body limit, response-size budget, bounded caches and logs.                                                                                                                                                                                                                                            |
| Remote summarization exfiltrating data                                                      | Deterministic by default; Ollama must be configured explicitly; non-loopback Ollama URLs require `--allow-remote` / an acknowledgement checkbox and produce a warning on every checkpoint; the model only receives extracted notes.                                                                                                                                                                     |
| Accidental destructive platform actions                                                     | GCM has no tool that resets or deletes anything in Grok Bot; Reset chat must be acknowledged and performed by the user; Delete Bot is never suggested; bulk operations require `--yes` and exclude deletion.                                                                                                                                                                                            |

## Encryption at rest

GCM does not encrypt the database itself. On Windows the data folder (`%LOCALAPPDATA%\GrokContextManager`) inherits
your user-profile ACL (you, SYSTEM, Administrators). On macOS/Linux GCM creates it with `0700`/`0600` permissions.
For disk-level protection use BitLocker / FileVault / LUKS. Backups created by GCM have the same protections.

## Deleting data

`gcm data delete --bot <id> --yes` and `gcm data purge --yes` delete GCM's own data (after an automatic backup;
`secure_delete` overwrites freed pages). They never touch Cursor or Grok Bot data. Delete the backups folder too if
you need the data gone everywhere.

## Dependencies

Runtime: `better-sqlite3`, plus bundled `@modelcontextprotocol/sdk`, `fastify`, `zod`, `commander`, `gpt-tokenizer`,
`react`. Run `pnpm audit` regularly; CI runs it on every push.

## Reporting a vulnerability

Please open a private security advisory on the repository (or email the maintainers) rather than a public issue.
