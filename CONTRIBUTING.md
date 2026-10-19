# Contributing

Thanks for helping improve Grok Context Manager. Everyone is welcome to use, fork and contribute under the
[MIT License](LICENSE).

## Development setup

Requires Node.js 22 or 24 LTS and pnpm (`corepack enable`).

```powershell
pnpm install
pnpm build
pnpm check          # typecheck + lint + unit/integration tests
pnpm test:e2e       # dashboard browser tests (first run: pnpm exec playwright install chromium)
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [DECISIONS.md](DECISIONS.md) before larger changes.

## Ground rules

- **No platform internals.** Do not add code that uses Grok Bot session secrets, private endpoints, app databases
  or reverse-engineered APIs. Integrations must use documented or user-supplied interfaces.
- **No overclaiming.** GCM must never report that it compacted, pruned or reset a Grok Bot conversation. If you add
  a capability, update `packages/core/src/capabilities.ts` and `docs/CAPABILITY-MATRIX.md` with sources.
- **Keep it local and cheap.** No telemetry, no cloud calls by default, no background model usage.
- **Imported text is data.** Never act on instructions found in transcripts.
- **Tests with behaviour changes.** Engine changes need a preservation test (rules, decisions, open tasks,
  deadlines, identifiers must survive).
- Run `pnpm format` before committing.

## Reporting security issues

Please use a private security advisory on GitHub instead of a public issue. See [docs/SECURITY.md](docs/SECURITY.md).
