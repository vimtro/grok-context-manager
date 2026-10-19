# Grok Context Manager

**Keep your bots. Keep their knowledge. Lose the unnecessary context.**

[![CI](https://github.com/vimtro/grok-context-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/vimtro/grok-context-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: beta](https://img.shields.io/badge/status-beta-orange)
![Node.js](https://img.shields.io/badge/node-22%20%7C%2024-green)

**GCM** is a local-first, open-source toolkit for organizing long-running AI agent conversations.
It turns conversation text you supply into reviewable checkpoints, searchable archives, and
compact handoffs, helping your existing **Cursor Grok Bot** teammates carry essential context
into a new conversation.

GCM includes a Windows-friendly CLI, a local web dashboard, an optional MCP server, and
a reusable Grok Bot skill. Basic context processing runs offline without a paid model API.

> [!IMPORTANT]
> **GCM does not compact, prune, read, or reset a Cursor Grok Bot's native conversation.**
> There is no verified public API for those operations. GCM only manages information
> that you import or explicitly pass to its tools. You complete any new-chat or reset
> action in Grok Bot yourself. **Smaller handoffs are not proof of lower Cursor usage
> or bills.** See [limitations](docs/LIMITATIONS.md).

## Why this exists

Long-running agent conversations accumulate decisions, repeated explanations, tool
outputs, and completed tasks. Starting a fresh conversation is awkward if the bot
still needs your working rules, open tasks, and important decisions.

GCM helps you:

- **Preserve context:** Review and version important instructions, decisions, deadlines,
  and open work before changing conversations.
- **Prepare a handoff:** Produce a shorter, task-relevant brief to paste into a fresh
  conversation with the same bot, where the platform supports that workflow.
- **Search history:** Keep your imported archive outside the active conversation.
- **Manage multiple bots:** Isolate profiles, checkpoints, archives, and MCP permissions
  for a fleet of specialist agents.
- **Check estimates:** Compare the size of imported text and handoffs without confusing
  those estimates with provider billing.

## Quick start: Windows PowerShell

**Requirements:** Node.js **22 or 24**, Git, and pnpm (via Corepack).
This is currently a **build-from-source** installation; the repository is not
advertising an npm release or packaged installer.

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# Reopen PowerShell after installing Node.js or Git.
corepack enable

git clone https://github.com/vimtro/grok-context-manager.git
cd grok-context-manager
pnpm install --frozen-lockfile
pnpm build
pnpm install:global
grokcm doctor
grokcm dashboard
```

> [!TIP]
> Use `grokcm` in PowerShell. `gcm` is already a built-in PowerShell alias
> for `Get-Command`.

### Your first checkpoint

```powershell
grokcm bots quick-add Sales
# Copy a conversation from Grok Bot to the clipboard.
Get-Clipboard -Raw | grokcm import - --bot sales --session main

grokcm analyze --bot sales --show-items
grokcm checkpoint create --bot sales --approve
grokcm handoff prepare --bot sales
grokcm handoff show latest --bot sales --text-only | Set-Clipboard
```

Review the checkpoint before approving it. Then follow GCM's instructions to
start a supported new conversation and paste the handoff. Keep the original
conversation as a reference. **Never use "Delete Bot" as a reset workaround.**

For a guided walkthrough, read the [user guide](docs/USER-GUIDE.md) or
[installation guide](docs/INSTALLATION.md).

## What is included in the current GitHub version?

| Component | What it provides |
| --- | --- |
| **CLI + dashboard** | Bot profiles, import, analysis, checkpoints, handoffs, and archives |
| **Local compaction engine** | Rule-based classification, deduplication, conflicts, and review |
| **Versioned storage** | Local SQLite checkpoints and searchable imported messages |
| **Grok Bot skill** | Reusable instructions for checkpoint and handoff workflows |
| **MCP server** | 16 tools with authenticated HTTP or local stdio transports |
| **Multi-bot workflows** | Scoped access, per-bot archives, and bulk operations |
| **Optional Ollama** | Local narrative summaries; not required for basic processing |

This table describes the checked-in **v0.1.0** code on `main`. Later local
development work should not be considered released until it is pushed and verified.

### Example: shorter text, not proven billing savings

The repository contains **synthetic** demonstration conversations:

- A 193-message Chief of Staff example goes from about **16,255 estimated text
  tokens** to a **594-token handoff** (approximately 96% less supplied text).
- A short Sales example produces a handoff **larger** than the original text;
  GCM warns when a handoff is not worthwhile.

These are local text estimates. They do **not** establish Grok Bot token,
subscription, or billing reductions. See [examples](examples/README.md).

## Privacy and platform limitations

- **Local-first:** Conversation data is stored in a SQLite database under your
  user profile. No telemetry or cloud summarization is enabled by default.
- **User-controlled imports:** GCM cannot automatically retrieve a Cursor Grok
  Bot's private transcript, settings, or billing data.
- **Optional remote MCP:** Remote Grok Bot access requires your own authenticated
  HTTPS deployment. Do not expose the dashboard publicly.
- **Data protection:** GCM's local database is not encrypted by the application;
  use OS-level disk encryption and protect exported files.
- **Best-effort checks:** Classification, redaction, and prompt-injection
  detection are heuristic. Review checkpoints before reuse.
- **No guaranteed savings:** Whether a fresh conversation reduces the provider's
  hidden context or charges must be measured separately.

Read [security](SECURITY.md), [technical security notes](docs/SECURITY.md),
and [known limitations](docs/LIMITATIONS.md) before handling sensitive transcripts.

## Documentation

- [Installation](docs/INSTALLATION.md) — Windows first, plus macOS/Linux notes
- [User guide](docs/USER-GUIDE.md) — import, checkpoint, handoff, and comparison
- [Grok Bot setup](docs/GROK-BOT-SETUP.md) — skill and connector options
- [MCP setup](docs/MCP-SETUP.md) — tools, authorization, and deployment
- [Architecture](docs/ARCHITECTURE.md) — main components and data flow
- [Capability matrix](docs/CAPABILITY-MATRIX.md) — supported vs. blocked operations
- [FAQ](docs/FAQ.md) — common questions and troubleshooting pointers
- [Roadmap](docs/ROADMAP.md) — verified features and areas for contribution
- [Testing](docs/TESTING.md) — reproducible build and test commands
- [Public-release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md) — security and launch gates

## Development

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm smoke
```

Test status should be verified using the [GitHub Actions runs](https://github.com/vimtro/grok-context-manager/actions);
a status badge reflects CI, not independent security certification.

## Contributing

Bug reports, documentation fixes, Windows testing, and evidence-backed
integration proposals are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md)
and the [roadmap](docs/ROADMAP.md). **Never upload real bot conversations,
tokens, or customer data to public issues.**

Security issues should be reported privately following [SECURITY.md](SECURITY.md).

## License and independence

GCM is distributed under the [MIT License](LICENSE). It is an independent
community project, **not affiliated with or endorsed by Cursor or xAI**.

**Project status:** v0.1.0 on the GitHub `main` branch; early-stage beta.
