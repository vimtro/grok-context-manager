# Frequently asked questions

## Does GCM erase or compact my existing Grok Bot conversation?

**No.** GCM cannot access or modify Cursor Grok Bot's private conversation
history through a supported API. It creates a compact handoff from the
conversation text that you explicitly provide. Any chat transition happens
in the Grok Bot application.

## Will it reduce what I pay for Grok Bot?

**That has not been established.** GCM can reduce the size of the text
you paste into a new conversation. Whether Cursor includes old hidden
context or bills differently is outside GCM's control. Record actual
before/after usage for comparable tasks; do not treat a text-compression
percentage as monetary savings.

## Can it keep the same bot?

GCM stores your existing bot's reference, identity notes, and decisions.
A new group conversation may allow you to continue using the same bot,
but the exact transition depends on the Grok Bot version and available UI.
The tool cannot guarantee the platform discarded earlier context.

## Does GCM automatically import all my chats?

Not in the **v0.1.0 code on GitHub main**. Import text or files explicitly,
or pass data to its MCP tools with appropriate permissions. GCM does not
access private Cursor storage or authenticated endpoints.

## Is it free? Do I need an API key?

GCM's core processing works locally without a paid inference API. You
still pay for any model services, remote hosting, or Grok Bot subscription
you choose to use. The optional local Ollama integration is not required.

## Where is my data saved?

A local SQLite database in your user profile. See
[installation](INSTALLATION.md) for platform-specific locations.
It is **not encrypted by GCM**. Use disk encryption, protect backup files,
and do not share exported archives casually.

## Do checkpoints always preserve everything important?

No automated extractor can promise that. GCM flags conflicts and suspicious
content, but its classification and redaction rules can miss unusual text.
Review and approve every important checkpoint, especially security rules,
deadlines, identifiers, and incomplete tasks.

## Does the MCP server work from my laptop inside Grok Bot?

A Grok Bot cloud environment generally cannot reach a service bound only
to `127.0.0.1` on your Windows laptop. See
[MCP setup](MCP-SETUP.md) for authenticated HTTPS deployment options.
Do not expose the dashboard or unauthenticated MCP endpoints publicly.

## Is this a Cursor or xAI product?

No. GCM is an independent MIT-licensed community project and is not
affiliated with or endorsed by Cursor or xAI.

## Why use `grokcm` instead of `gcm` in PowerShell?

PowerShell already uses `gcm` as an alias for `Get-Command`.
Use `grokcm` when following the [Windows installation guide](INSTALLATION.md).

## Where do I report bugs or request features?

Open a GitHub issue with synthetic test data only. For vulnerabilities,
follow the private reporting instructions in [SECURITY.md](../SECURITY.md).
For project priorities, see the [roadmap](ROADMAP.md).
