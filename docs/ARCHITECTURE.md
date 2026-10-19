# Architecture

## Components

```
apps/cli  (gcm)  ──┐                        ┌── apps/mcp-server  (stdio | streamable HTTP + tokens)
apps/dashboard ────┼──► packages/core ◄─────┤
  (React + local   │     GcmService          └── skills/grok-context-manager (instructions for Grok Bot)
   Fastify API)    │     ├─ import/parse        (text, Markdown, JSON, JSONL → messages)
                   │     ├─ engine/classify     (segmentation + rule-based classification)
                   │     ├─ engine/compact      (dedupe, supersession, conflicts, budget fitting)
                   │     ├─ engine/validate     (protected items kept, no secrets, no injection)
                   │     ├─ checkpoint/render   (handoff prompt, Markdown export)
                   │     ├─ checkpoint/diff
                   │     ├─ summarization       (deterministic | Ollama narrative | registry)
                   │     ├─ tokens/estimate     (heuristic | o200k reference)
                   │     ├─ security            (secret redaction, injection heuristics)
                   │     └─ workflow            (handoff state machine, platform guides)
                   └──► packages/storage  (SQLite via better-sqlite3: WAL, migrations, FTS5, backups)
```

- **One service, three front ends.** CLI, MCP server and dashboard all call `GcmService`; access control, validation
  and logging live there, not in the front ends.
- **Ports and adapters.** `packages/core` defines a `Store` interface; `packages/storage` implements it. The core has
  no native dependencies.
- **Distribution.** Workspace packages export TypeScript sources; the CLI (with MCP + dashboard server embedded) is
  bundled by esbuild into `apps/cli/dist/gcm.mjs`. The only runtime dependency is `better-sqlite3`. The React client
  is built by Vite into `apps/cli/dist/dashboard`.

## Data model

| Concept                    | Stored as                              | Notes                                                                                                                  |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Identity** (bot profile) | `bots`                                 | Always `identitySource: user_provided`. Policy: profile, budget, warn threshold, `shareWith`, `mcpExposed`.            |
| **Archive**                | `imports`, `messages`, `messages_fts`  | Immutable messages (trigger), per-import SHA-256 integrity hash, coverage label, session key for incremental imports.  |
| **Working context**        | `checkpoints` (+ `checkpoint_imports`) | Immutable (trigger), versioned per bot with compare-and-insert, content hash, review status (the only mutable fields). |
| **Handoffs**               | `handoffs`                             | Text, verification code, state + event history. Bot replies used for verification are not stored.                      |
| Usage                      | `usage_records`                        | User-supplied measurements only (`provider_measured`, `billing`).                                                      |
| Operations log             | `operations`                           | Op name, duration, ok/code, local-model tokens, MCP response tokens — never content.                                   |
| API tokens                 | `api_tokens`                           | SHA-256 hashes, bot scopes, read/write.                                                                                |
| Cache                      | `cache`                                | Analysis/narrative results keyed by content hashes (bounded to 500 entries).                                           |

## Compaction pipeline

1. **Parse** (at import): detect format, map speakers (bot profile name/ID → assistant; two-party inference), flag truncation.
2. **Normalise**: NFC, strip zero-width/control characters, collapse whitespace.
3. **Segment**: bullets, checkboxes, sentences, code fences, tables; headings and inline labels (`Decision:`, `TODO:`) become section hints.
4. **Classify** into permanent / active_work / decision / open_question / temporary / obsolete / historical with a
   reason string. Order of precedence: explicit structure → chatter → constraints (negative/security) → completion →
   decisions (assistant prose must use first/second-person decision language) → blockers/questions → objective →
   tasks → durable facts. Long assistant outputs (>120 words) are deliverables, kept as historical evidence.
5. **Redact** secrets; extract exact identifiers (paths, URLs, tickets, env vars, versions, amounts, dates).
6. **Approved proposals**: “Yes, go with option A” turns the assistant's option-A sentence into a decision with both source references.
7. **Carry forward** the previous checkpoint's retained items (incremental mode).
8. **Deduplicate**: exact (normalised key) and near-duplicates (Jaccard ≥ 0.8, same kind, no differing values).
9. **Supersede only with evidence**: later completion closes a matching task; strong markers (“instead of”, “switch
   from”, “no longer”) or weak markers with high overlap (“update: … is now …”) supersede earlier decisions/facts.
10. **Conflicts**: similar statements with different values or opposite polarity and no marker are both kept, flagged and protected.
11. **Select within budget**: protected items (constraints, decisions, open tasks, open questions, deadlines,
    conflicts) are never dropped; resources → oldest progress → lowest-priority knowledge are trimmed first.
12. **Validate**: no protected item dropped, no quarantined text in working context, no secrets in the rendered handoff.
13. **Save** as a new version after the user's approval (or as `unreviewed`), then read back and re-verify the hash.

## Handoff workflow

```
CHECKPOINT_READY → ARCHIVE_VERIFIED → HANDOFF_READY → USER_ACTION_REQUIRED → EXTERNAL_RESET_UNVERIFIED → CONTINUATION_VERIFIED
                         any step ──► FAILED_RECOVERABLE ──► retry (HANDOFF_READY / USER_ACTION_REQUIRED / …)
```

`USER_ACTION_REQUIRED` carries the chosen platform step (`new_group_chat`, `reset_chat` with explicit
acknowledgement, or `continue_in_place`). GCM never performs it. `CONTINUATION_VERIFIED` requires the bot's first
reply to contain the checkpoint code, ≥30% of the objective's terms and at least two of the top three tasks.

## Cost controls

- No LLM calls for estimates, listings, diffs or analysis. Deterministic engine by default.
- Analysis cached by (engine version, profile hash, import hashes, previous checkpoint hash, options).
- Incremental imports (leading overlap skipped) and incremental checkpoints (only uncovered imports processed).
- “Nothing new since vN” refuses to create redundant checkpoints.
- MCP responses capped and measured; handoffs never include the archive.
- No background jobs.

## Extending

- **Summarization providers**: implement `SummarizerProvider` and `registerProvider()`; never selected automatically.
- **Tokenizers**: add a `TokenizerAdapter` in `tokens/estimate.ts`.
- **Platform adapters**: if Cursor ships an official conversation API, add an adapter that maps a verified reset to a
  new workflow state and update `capabilities.ts` — the workflow already separates “user performed” from “verified”.
