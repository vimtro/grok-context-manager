# Grok Bot setup

There are three ways to use GCM with Grok Bot. Start with **Option 1** — it needs no server and already gives you
checkpoints and handoffs. Add a connector only if you want bots to save and fetch checkpoints themselves.

| Option                                 | What you get                                                      | Setup                                   | Data location                    |
| -------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| 1. Skill only                          | Bot drafts checkpoints/handoffs in chat; you import them into GCM | 2 minutes                               | Your PC (GCM)                    |
| 2. Remote connector                    | Bot calls `gcm_*` tools directly                                  | HTTPS endpoint (tunnel, VPS or Docker)  | Your PC or your server           |
| 3. Cloud-computer stdio (experimental) | Bot calls `gcm_*` tools without a public endpoint                 | Install GCM on the bot's cloud computer | Grok Bot's shared cloud computer |

Grok Bot's cloud computer **cannot reach `localhost` on your Windows PC**, so a connector must be either a public
HTTPS URL (Option 2) or a command that runs on the cloud computer (Option 3).

## Option 1 — Install the skill

Grok Bot creates skills when you ask for them in chat (the file format is not documented, so GCM ships plain
Markdown instructions). In a conversation with the bot:

> Please save the following as a reusable skill named **grok-context-manager** and make it available to all my bots.
> Use it whenever I ask to checkpoint a conversation, prepare a handoff or start fresh without losing context.
>
> _(paste the full contents of [`skills/grok-context-manager/SKILL.md`](../skills/grok-context-manager/SKILL.md))_

Check it worked: type `/` in the composer and look for the skill, or ask “Which skills do you have?”. If it is a
private skill, enable it under **Connect apps → Private skills** for each bot that should use it.

Typical use:

1. “Checkpoint this conversation.” → the bot drafts notes with fixed headings and asks for approval.
2. Copy the approved notes and import them: `Get-Clipboard -Raw | grokcm import - --bot sales --partial`
   (GCM recognises the headings), then `grokcm checkpoint create --bot sales --approve`.
3. “Prepare a fresh-conversation handoff.” → or use `grokcm handoff prepare --bot sales` for the GCM version with a
   verification code.

## Option 2 — Remote MCP connector (HTTPS)

### a) Run the server

**Quick (your PC + a tunnel).** Keep the server bound to localhost and expose it through an HTTPS tunnel such as
Cloudflare Tunnel or ngrok:

```powershell
grokcm mcp token create --name sales-bot --bots sales --write  # copy the printed token
grokcm mcp serve --http --port 8787                             # stays on 127.0.0.1
cloudflared tunnel --url http://127.0.0.1:8787                  # prints https://<random>.trycloudflare.com
```

Your PC must stay on while bots use the connector. Anyone with the URL **and** a token can call the tools, so keep
tokens secret and revoke unused ones (`grokcm mcp token revoke <id>`).

**Always-on (small server with Docker).** See [MCP-SETUP.md](MCP-SETUP.md#docker-deployment) — Caddy obtains the
HTTPS certificate automatically.

### b) Add it to Grok Bot

In a chat with the bot (connectors have no settings form — the bot sets them up):

> Add a **custom MCP server** called **gcm** at `https://<your-host>/mcp`.
> It uses an API key header: header name `Authorization`, value `Bearer gcm_tok_…`.

Include the words “custom MCP server”, otherwise the bot may look for a marketplace plugin. Confirm the name and URL
when the bot asks. Then make sure the server is enabled under **Settings → Plugins → Yours**. New tools are available
from your next message.

Recommended: **one token per bot**, each scoped to that bot (`--bots sales`). Connectors are account-wide in Grok Bot,
so GCM enforces the boundary itself: a token for `sales` cannot read or write Research's data. Use `--write` only for
bots that should save checkpoints; read-only tokens see only the 10 read tools.

### c) Test it

Ask the bot: “Use gcm_describe_capabilities and tell me what GCM can and cannot do.” Then “Use gcm_list_bots.” You
should see only the bots the token allows.

## Option 3 — Stdio on the cloud computer (experimental)

A third-party guide reports that Grok Bot can run a stdio MCP server as a command on its cloud computer. This is not in
the official docs. Data then lives on the cloud computer, which **all your bots share** — it is not a per-bot boundary.

1. Copy the package tarball to the cloud computer (for example ask the bot to download it from your release page,
   or build it there with `git clone … && pnpm install && pnpm build`).
2. Ask the bot:
   > Add a custom MCP server called **gcm** that runs:
   > `npx -y --package /workspace/gcm/grok-context-manager-0.1.0.tgz grokcm mcp serve --home /workspace/.gcm-data --bots sales`
3. Test as in Option 2c.

## What bots must never claim

The skill and the MCP server instructions tell bots: GCM cannot delete, prune, compact or reset Grok Bot's history.
If a bot says it “cleared its context”, it is wrong — only the steps you take in the Grok Bot app change the
conversation, and their effect on hidden context is unverified.
