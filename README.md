# Grok Context Manager (GCM)

**Keep your bots. Keep their knowledge. Lose the unnecessary context.**

GCM is a free, open-source, local-first tool for teams that run several long-lived **Cursor Grok Bot** teammates
(Chief of Staff, Sales, Research, Development, QA, Marketing, Operations…). It turns long conversations into small,
reviewed **checkpoints** and copy-paste **handoffs**, so you can keep working with the _same_ bot in a fresh
conversation without dragging its whole history along.

> [!IMPORTANT]
> **What GCM cannot do.** Grok Bot has no official API to compact, prune, read or reset a bot's conversation.
> GCM never pretends otherwise: it manages **its own copy** of the context you import, and it walks you through the
> step you take yourself in the Grok Bot app (a new group chat with the bot, or Reset chat where your build has it).
> A clean handoff is **not** proof that Grok Bot's hidden context shrank — measure usage before and after to know.
> See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) and [docs/CAPABILITY-MATRIX.md](docs/CAPABILITY-MATRIX.md).

## Why

Long Grok Bot conversations are re-processed on every turn. Users report coordinator bots sending 200k+ input tokens
per reply, which eats the weekly allowance and slows responses. Starting over loses rules, decisions and open tasks.
GCM keeps those safe and hands only what matters to the next conversation.

In the bundled example, a 22-day synthetic Chief of Staff conversation (~16,000 estimated tokens) becomes a
~600-token handoff that still carries every rule, live decision, deadline, blocker and open question
(see [Demonstration](#demonstration)). For short conversations GCM tells you a handoff would _not_ save anything.

## What you get

|                                          |                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Standalone manager (CLI + dashboard)** | Bot profiles, conversation import (text, Markdown, JSON, JSONL), analysis preview, versioned checkpoints, diff, restore, export, archive search, compact handoffs, token estimates. Works fully offline on Windows.                                                                                                                                                            |
| **Smart compaction engine**              | Deterministic, no AI model needed. Classifies material into permanent knowledge, active work, decisions, open questions, temporary, obsolete and historical; dedupes; applies explicit updates ("switch from X to Y instead"); flags conflicts instead of guessing; never drops rules, decisions, open tasks or deadlines; redacts secrets; quarantines prompt-injection text. |
| **Guided handoff workflow**              | Analyze → Checkpoint → Verify → Handoff → _your_ step in Grok Bot → verify the bot's first reply. Honest states (`EXTERNAL_RESET_UNVERIFIED`, `CONTINUATION_VERIFIED`, …). Destructive options need explicit acknowledgement.                                                                                                                                                  |
| **Grok Bot skill**                       | [`skills/grok-context-manager/SKILL.md`](skills/grok-context-manager/SKILL.md) — ask a bot to "checkpoint this conversation" or "prepare a handoff". Works with or without the connector.                                                                                                                                                                                      |
| **MCP server**                           | 16 tools (10 read-only), stdio and authenticated streamable HTTP, per-bot token scopes, response-size caps, rate limits, fails closed. Docker + Caddy files for an HTTPS endpoint.                                                                                                                                                                                             |
| **Fleet support**                        | Per-bot archives, policies, budgets and reports; bulk analysis/checkpoints/handoffs (explicit `--yes`); no cross-bot leakage.                                                                                                                                                                                                                                                  |
| **Privacy**                              | Local SQLite in your user profile, no telemetry, no cloud calls by default, optional local Ollama narrative that is validated against the source.                                                                                                                                                                                                                              |

## Quick start (Windows PowerShell)

Requires **Node.js 22 or 24 LTS** and Git. Full guide: [docs/INSTALLATION.md](docs/INSTALLATION.md).

```powershell
winget install OpenJS.NodeJS.LTS          # if you don't have Node 22+ yet (reopen PowerShell afterwards)
corepack enable                            # provides pnpm
git clone https://github.com/vimtro/grok-context-manager.git
cd grok-context-manager
pnpm install
pnpm build
pnpm install:global                        # packs the CLI and installs `grokcm` globally with npm (in PowerShell use `grokcm`, not `gcm`)
grokcm doctor
```

Then, for each bot:

```powershell
grokcm bots add sales --name "Sales" --role "Account executive" --boundary "Never share customer data outside the CRM"
# Copy the Grok Bot conversation (Ctrl+A, Ctrl+C in the chat), then:
Get-Clipboard -Raw | grokcm import - --bot sales --session main
grokcm analyze --bot sales                 # preview: what is kept, what is dropped, conflicts
grokcm checkpoint create --bot sales --approve
grokcm handoff prepare --bot sales         # prints the handoff
grokcm handoff show latest --bot sales --text-only | Set-Clipboard
grokcm handoff action <handoff-id> new_group_chat   # shows the exact steps to do in Grok Bot
grokcm dashboard                           # or do all of this in the browser
```

## Demonstration

From [`examples/`](examples) (regenerate with `node scripts/generate-examples.mjs`):

| Conversation                                                                                    | Imported text  | Handoff                                                              | Estimated reduction of supplied text                          |
| ----------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Chief of Staff, 22 days, 193 messages ([source](examples/conversations/chief-of-staff-long.md)) | ~16,255 tokens | ~594 tokens ([handoff](examples/handoffs/chief-of-staff-handoff.md)) | ~96.3%                                                        |
| Sales, 30 short messages ([source](examples/conversations/sales-bot.txt))                       | ~504 tokens    | ~744 tokens                                                          | none — GCM warns that a fresh conversation would not help yet |

Estimates use GCM's local character heuristic (the o200k reference tokenizer gives ~14,150 → ~549). These are text sizes,
not Grok Bot billing; Grok Bot usage depends on what the platform actually loads.

## Documentation

- [Installation (Windows first)](docs/INSTALLATION.md)
- [User guide](docs/USER-GUIDE.md) — daily workflow for a multi-bot agency
- [Grok Bot setup](docs/GROK-BOT-SETUP.md) — skill and connector options with exact prompts
- [MCP setup](docs/MCP-SETUP.md) — local and remote deployment, all tools documented
- [Capability matrix](docs/CAPABILITY-MATRIX.md) — what Grok Bot supports, with sources
- [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Limitations](docs/LIMITATIONS.md) · [Testing](docs/TESTING.md)

## Project status

v0.1.0. Implemented and tested: see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and [docs/TESTING.md](docs/TESTING.md).
Design decisions: [DECISIONS.md](DECISIONS.md).

## License

[MIT](LICENSE). GCM is an independent project and is not affiliated with Cursor or xAI.
