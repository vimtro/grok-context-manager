# User guide

This guide is for someone running several Grok Bot teammates (for example Chief of Staff, Sales, Research,
Development, QA, Marketing and Operations) who wants to keep them — and what they know — while cutting the cost of
ever-growing conversations.

## The idea in one minute

1. **Identity** — who the bot is (role, rules, boundaries). You enter it once per bot in GCM. GCM never reads it from Grok Bot.
2. **Working context** — what the bot needs _now_: objective, rules, decisions, open tasks, blockers. GCM extracts it into a **checkpoint**.
3. **Archive** — everything else you imported. Kept locally and searchable, never pasted wholesale into a bot.

When a conversation gets long you create a checkpoint, review it, and paste the compact **handoff** into a fresh
conversation with the same bot (usually a new group chat that includes it). The old conversation stays as history.

## When is it worth it?

- `gcm bots list` and the dashboard warn when a bot has a lot of imported text since its last checkpoint
  (default threshold ~100k estimated tokens, configurable per bot with `--warn-threshold`).
- GCM warns when a handoff would be about as large as the conversation itself — then it is not worth switching yet.
- The only proof of savings is measurement: note the usage before and after (see “Measuring” below).

## Daily workflow

### 1. Register your bots (once)

```powershell
gcm bots add chief-of-staff --name "Chief of Staff" --role "Agency coordinator" `
  --boundary "Do not forward client contracts outside the agency" --profile compact
gcm bots add sales --name "Sales" --role "Account executive" --boundary "Never share customer data outside the CRM"
gcm bots add research --name "Research" --share-with chief-of-staff
```

Profiles can also be loaded from JSON: `gcm bots add sales --from-file examples\bot-profiles\sales.json`.
Security boundaries and operating instructions from the profile are included in every handoff under “Must follow”.

### 2. Import the conversation

In Grok Bot, open the bot's conversation, select the text (Ctrl+A in the message list, Ctrl+C) and:

```powershell
Get-Clipboard -Raw | gcm import - --bot sales --session main
```

or save it to a file and `gcm import .\sales-2026-10-19.txt --bot sales --session main`. Re-importing the same
conversation later with new messages appended only adds the new part. If speakers have custom names that GCM does not
recognise, add `--assistant-name "Sales Bot" --user-name "Mo"`.

Coverage: GCM marks imports as `unknown` unless you pass `--complete` (only if this really is the whole conversation)
or `--partial`. Checkpoints carry that label so nobody mistakes a partial copy for the full story.

### 3. Preview

```powershell
gcm analyze --bot sales               # counts, conflicts, caveats
gcm analyze --bot sales --show-items  # every item with the reason it was kept or dropped
gcm analyze --bot sales --show-handoff
```

Look especially at **conflicts** (two statements that disagree) and **quarantined** passages (text that looked like an
attempt to override instructions). Both are kept out of silent decisions and shown to you.

### 4. Save and approve a checkpoint

```powershell
gcm checkpoint create --bot sales             # saved as "unreviewed"
gcm checkpoint show latest --bot sales --format markdown
gcm checkpoint review latest --bot sales      # approve
```

Or `gcm checkpoint create --bot sales --approve` when you already checked the preview. Every checkpoint is a new
version; nothing is overwritten. Next time, only material imported since the last checkpoint is processed and the
previous checkpoint is carried forward (tasks closed by later “done” messages drop out, changed decisions are updated).

Useful options: `--objective "…"` to state the goal explicitly, `--workstream "Acme renewal"`, `--profile compact|balanced|detailed`, `--budget 1500`.

### 5. Prepare the handoff and continue in Grok Bot

```powershell
gcm handoff prepare --bot sales
gcm handoff show latest --bot sales --text-only | Set-Clipboard
gcm handoff action <handoff-id> new_group_chat
```

Then in the Grok Bot app:

1. Choose **New chat** (the + button), select the bot **and** one other bot (group chats need 2–6 bots).
2. Mention the bot (`@Sales`) and paste the handoff.
3. Keep the old one-to-one chat. **Never use Delete Bot.**

`reset_chat` is available only if your build shows “Reset chat” for the bot; it permanently clears the transcript and
requires `--i-understand-transcript-loss`. `continue_in_place` refocuses the bot without reducing what it reprocesses.

### 6. Confirm it worked

```powershell
gcm handoff done <handoff-id>
# Copy the bot's first reply, then:
Get-Clipboard -Raw | gcm handoff verify <handoff-id> --reply-file -
```

`CONTINUATION_VERIFIED` means the bot's reply contained the checkpoint code, the objective and the top tasks. It does
not prove Grok Bot's hidden context shrank.

## The dashboard

`gcm dashboard` opens a local page (only reachable from this computer):

- **Overview** — bots, recent checkpoints, active handoffs, warnings.
- **Bots** — identity, current checkpoint, history, archive search, usage report and a form to record measurements.
- **Context analysis** — paste/upload a conversation, analyze, review every retained and excluded item, save.
- **Checkpoints** — version history, verify, mark reviewed, restore as a new version, export, compare, restore from a file.
- **Handoff wizard** — the full guided flow with copy button, step-by-step platform instructions and reply verification.
- **Settings** — summarizer, token method, budgets, privacy, MCP tokens, capability matrix.

## Using several bots

```powershell
gcm fleet analyze                      # preview every bot, no writes
gcm fleet checkpoint --all --yes       # checkpoint every bot with new material
gcm fleet handoff --bots sales,research --yes
gcm usage report                       # per-bot sizes
```

Bulk commands never delete, clone or reset bots. Each bot's archive is separate; a bot only sees another bot's data
if that bot explicitly lists it in `--share-with` (read-only).

## Measuring real usage

GCM can't see Grok Bot billing. If you can read a usage figure (for example tokens per reply or the weekly allowance
percentage), record it before and after switching:

```powershell
gcm usage record --bot sales --label before_handoff --input-tokens 210000 --source "Grok Bot usage page"
gcm usage record --bot sales --label after_handoff --input-tokens 18000 --source "Grok Bot usage page"
gcm usage report --bot sales
```

The report keeps five numbers apart: local estimates, provider measurements you recorded, billing/quota records,
estimated reduction of supplied text, and the before/after platform comparison (marked “user-measured, unverified”).

## Optional: local AI narrative

GCM works without any AI model. If you already run [Ollama](https://ollama.com) locally:

```powershell
ollama list
gcm settings set summarizer ollama
gcm settings set ollamaModel llama3.2
gcm doctor --check-ollama
```

The model only sees the already-extracted notes, writes a short summary paragraph, and its output is rejected if it
mentions numbers or identifiers that are not in the notes. GCM never downloads models.

## Backups and deleting GCM data

```powershell
gcm data backup                        # consistent copy in %LOCALAPPDATA%\GrokContextManager\backups
gcm data delete --bot sales --yes      # GCM's data for one bot (automatic backup first)
gcm data purge --yes                   # all GCM data (automatic backup first)
gcm archive export --bot sales --format json --out sales-archive.json   # portable archive copy
gcm archive import sales-archive.json            # restore it (already-present messages are skipped)
```

These commands only affect GCM's own database — never Grok Bot.
