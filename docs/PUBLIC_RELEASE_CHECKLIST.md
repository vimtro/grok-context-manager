# Public release gate

**Status: NOT APPROVED FOR PUBLIC VISIBILITY until every blocking item is verified.**

The GitHub `main` branch was inspected on 2026-10-19 and reports **v0.1.0**. A newer local `gcm-v0.2.0` branch was discussed but was **not present on this GitHub remote** at inspection time. Do not announce v0.2.x or publish the repository based only on local implementation reports.

## 1. Select the exact release commit

- [ ] Push the intended, reviewed release branch (if releasing a newer local version).
- [ ] Record the exact commit SHA and version.
- [ ] Verify source and lockfile agree on runtime requirements.
- [ ] Confirm license and ownership of all dependencies and copied content.

## 2. Block publication until sensitive history is cleared

- [ ] Run a secret scanner across **all Git history and working files**, not only the current tree. See `scripts/release-preflight.ps1`.
- [ ] Review committed examples, tests, screenshots, and docs to ensure all data is synthetic. Unusual keys can evade regex scanners.
- [ ] Inspect tracked binary files, logs, archives, SQLite databases, `.env` files, credential files, and exported chats.
- [ ] Review `git log --all --format="%an <%ae>"` for author email addresses that would become public.
- [ ] If a real secret was ever committed, rotate/revoke it. Rewriting Git history does not make previously copied secrets safe.
- [ ] Confirm private vulnerability reporting is enabled or provide an alternative private contact.

## 3. Verify the shipped software

- [ ] Run frozen install, typecheck, lint, format checks, build, unit/integration tests, browser tests, and packaging smoke tests.
- [ ] Rebuild and smoke-test Docker, including unauthorized MCP requests.
- [ ] Run dependency audit and investigate all high/critical findings.
- [ ] Run Windows installation and actual CLI/dashboard workflow.
- [ ] Confirm remote MCP defaults require authentication and HTTPS.
- [ ] Verify that imports, checkpoints, and exports preserve isolation and redact secrets.
- [ ] Confirm no unsupported Cursor private APIs, cookies, or secret stores are accessed.

## 4. Check product messaging

- [ ] README and version accurately describe **the checked-in code**, not features only present locally.
- [ ] Explicitly state GCM cannot shrink Cursor Grok Bot's native context.
- [ ] Distinguish estimated handoff text reduction from actual token/billing savings.
- [ ] Label MCP and skill live-integration status honestly.
- [ ] Verify links, setup commands, and Windows support.
- [ ] Mark beta limitations and data handling transparently.

## 5. Prepare community settings

- [ ] Review `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, templates, and MIT license.
- [ ] Set repository description and topics; optionally enable GitHub Discussions.
- [ ] Enable Dependabot/automated security alerts and private vulnerability reporting if supported.
- [ ] Require PR reviews and passing CI checks before merging into `main`.
- [ ] Review whether GitHub Actions secrets, environments, or protected branch settings could be exposed by visibility changes.
- [ ] Draft a GitHub release with verified installation steps and a clear beta designation.

## 6. Final owner sign-off

Only after the above are complete:

- [ ] Maintainer explicitly approves publication of the exact audited commit/history.
- [ ] Change repository visibility to Public in GitHub Settings.
- [ ] Verify a logged-out visitor can read only intended public files.
- [ ] Publish release notes clearly describing limitations.

**Important:** A passing CI run does not scan every historical commit for secrets, and a security scan is not a guarantee of safety.
