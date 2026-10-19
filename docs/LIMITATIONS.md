# Limitations

Read this before relying on GCM for cost savings.

## Platform limits (Cursor Grok Bot)

1. **GCM cannot compact, prune, read or reset a Grok Bot conversation.** No official API exists. GCM manages its own
   copy and prepares handoffs; every platform step is yours.
2. **No fresh 1:1 chat with an existing bot.** The recommended route is a new _group chat_ that includes the bot
   (needs at least one other bot). Whether it excludes the old transcript is reported by Cursor staff but not
   documented; bot memory still applies by design.
3. **Reset chat** is destructive, undocumented, and was missing on at least one Windows build (0.47.0).
4. **No usage telemetry.** GCM cannot see per-bot tokens or billing. Savings must be measured by you
   (`gcm usage record`). A verified continuation is not evidence that platform context shrank.
5. **Connectors need a public HTTPS endpoint** (or the experimental stdio-on-cloud-computer route). Your PC's
   localhost is unreachable from Grok Bot.
6. **Skill format is undocumented.** GCM ships Markdown instructions you ask the bot to save as a skill.

## What GCM can only know from you

- Bot identity (role, rules, routines) — entered by you, never read from Grok Bot.
- Conversation content — only what you import or a bot passes to a tool. Coverage is labelled `unknown`/`partial`
  unless you assert `complete`.

## Engine limits

- **Rule-based, English-centric.** Classification uses English patterns; other languages fall back mostly to
  “historical” (kept in the archive, not in the handoff). Review the preview.
- **Heuristic supersession and conflicts.** Only explicit markers or high-overlap evidence supersede; everything else
  is kept, and similar statements with different values are flagged — expect occasional false conflicts rather than
  silent data loss.
- **Unlabelled requests that were handled in chat are not tasks.** Without “todo/next step/still need” language or a
  checkbox, a request the bot answered is treated as historical. Use labels (`TODO:`) for important open work.
- **Token numbers are estimates.** Default heuristic ≈ 4 characters/token; the o200k option is a reference tokenizer,
  not Grok's.
- **Prompt-injection detection is heuristic.** It catches common override phrasing; it is a second line of defence
  behind “imported text is data”.
- **Secret redaction is pattern-based** and can miss unusual formats.

## Product limits in v0.1.0

- No built-in encryption at rest (use disk encryption).
- No multi-user accounts; the dashboard is single-user and local.
- No automatic background checkpointing (by design, to avoid cost) — run it on demand.
- Docker deployment is provided but not hardened for multi-tenant hosting.
- No official Grok Bot transcript export exists, so imports depend on copy/paste quality.

## Roadmap (if Cursor exposes official APIs)

- **Conversation API** → import directly instead of copy/paste, with true `complete` coverage.
- **Official compact/new-session endpoint** → a verified workflow state (e.g. `PLATFORM_RESET_VERIFIED`) and an
  automated, still user-approved, handoff.
- **Usage API** → per-bot measured before/after reports instead of user-entered figures.
- **Per-bot connector scoping** → bind a token to the calling bot automatically.
- **Documented skill format** → installable skill package instead of copy/paste.
- Non-English classification lexicons and an optional embedding-free semantic dedupe.
