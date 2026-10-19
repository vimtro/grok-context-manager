# Roadmap

This roadmap records opportunities for contributors. It is **not** a promise
of implementation dates or access to Cursor's internal APIs.

## Current GitHub baseline: v0.1.0

Already represented in `main`:

- Standalone Windows-friendly CLI and local dashboard
- User-provided conversation import and analysis
- Checkpoints, archives, diffs, handoffs, and local token estimates
- Rule-based processing with human review
- Authenticated MCP server and Markdown Grok Bot skill
- Per-bot storage and multi-bot workflows
- Automated CI, Docker build, and synthetic demonstrations

See [README](../README.md) and [implementation status](../IMPLEMENTATION_STATUS.md)
for the checked-in code, not features implemented only on a local branch.

## Priority: trustworthy public beta

- Complete full-history secret/privacy scan and release sign-off
- Validate the installation and quick-start workflow on a clean Windows machine
- Get all CI checks passing across Windows/Linux, Node 22/24, and Docker
- Run an authorized live Grok Bot MCP/skill integration test
- Improve documentation where real users get stuck

## Candidate improvements (not released)

- Safe, supported incremental imports where transcript exports are available
- Improved handling of non-English conversations
- Stronger meaningful handoff validation rather than checking an identifier
- Better usage measurement and billing reconciliation from user-supplied records
- More useful diagnostics when the source transcript is partial
- Optional bounded retrieval for large archives
- Community-contributed integration adapters for platforms with documented APIs

## Blocked by external platform capabilities

- Directly reading Grok Bot conversations without user-supplied data
- Pruning or compacting Grok Bot's own hidden working context
- Resetting a Grok Bot conversation via an official external API
- Automatically measuring per-bot Cursor charges without an available usage feed

These should only be marked supported when official or otherwise authorized,
verifiable integration interfaces exist.

## Contributing

Good first contributions include Windows documentation, synthetic regression
tests, example import formats, accessibility improvements, and verified
capability research. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first.

**Evidence standard:** Identify which behavior is implemented locally,
which was observed in a live integration, and which remains unverified.
Do not turn speculative savings into release claims.
