# Security Policy

Grok Context Manager (GCM) stores potentially sensitive conversation archives, checkpoints, usage records and MCP credentials. Please do **not** disclose vulnerabilities or real conversation data in public issues.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/vimtro/grok-context-manager/security/advisories/new) **if enabled**. If private reporting is unavailable, contact the repository maintainers through a private channel before disclosing technical details; never publish exploit steps or credentials in an issue.

Include the affected release/commit, impact, minimal reproduction using synthetic data, and suggested mitigation if known. Do not test against other people's bots, tokens, computers, or accounts.

We will triage reports as resources allow. No response-time or bounty guarantee is implied.

## Supported releases

Security fixes are targeted to the latest maintained release. Older versions may not receive backports. The project is currently an early-stage beta and is not independently security certified.

## Security boundaries

- GCM does **not** compact, delete, or reset a Cursor Grok Bot's internal chat.
- Local database storage is not encrypted by GCM; protect the device, backups, and exported transcripts.
- Do not expose a local dashboard directly on the public internet.
- Remote MCP deployments require HTTPS, authentication, and per-bot access controls.
- Treat imported conversation content as untrusted; secret redaction and injection detection are best-effort.

For details, see [Security and privacy](docs/SECURITY.md) and [Limitations](docs/LIMITATIONS.md).
