# Protecting the main branch

This is a setup guide, not an active rule. **Committing this file does not protect main.**

GitHub returned HTTP 403 for rulesets while the repository was private:
"Upgrade to GitHub Pro or make this repository public to enable this feature."

Complete the [public-release checklist](PUBLIC_RELEASE_CHECKLIST.md) before making the repository public.

## Recommended GitHub ruleset

Open [Repository rules](https://github.com/vimtro/grok-context-manager/settings/rules).

1. Select **New ruleset** and then **New branch ruleset**.
2. Name it `Protect main - PR only`.
3. Set enforcement to **Active**.
4. Target `refs/heads/main`.
5. Leave the bypass list **empty**, including administrators.
6. Enable **Require a pull request before merging**.
7. Require status checks from the CI matrix and `secret-scan`.
8. Enable **Block force pushes** and **Restrict deletions**.
9. Consider requiring conversation resolution.
10. Save and confirm that the ruleset is **Active**.

Use zero required approvals for a solo maintainer, or one approval if a second trusted maintainer can review PRs.

**Do not enable Restrict updates with an empty bypass list.** That can prevent PR merges too.

## Apply through GitHub CLI

A maintainer can run the bundled script with a GitHub CLI session that has repository administration access.

```powershell
winget install GitHub.cli
gh auth login
.\scripts\configure-main-ruleset.ps1
```

The script checks repository access, asks for confirmation, and never changes visibility.

## Test protection

After activating the ruleset:

- Confirm a direct push to `main` is rejected.
- Open a PR and confirm passing status checks are required.
- Confirm the bypass list has no administrators, users, or apps.
- Confirm force pushes and branch deletion are rejected.

Do not run destructive force-push tests against production branches.

## GitHub documentation

- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
