# Main branch: pull requests only

**This document is a configuration guide, not an active branch rule.**
GitHub rules must be enabled in **repository settings**. Committing a file
alone cannot stop direct pushes.

The repository was **private** at the time this guide was added. Its rulesets
API returned HTTP 403: "Upgrade to GitHub Pro or make this repository public
to enable this feature." If GitHub still reports that restriction, use a
GitHub Team/Enterprise plan to enforce rules while private, or finish the
security gate before publishing and then enable the ruleset on a public repo.

## Recommended strict repository ruleset

Open [Settings → Rules → Rulesets](https://github.com/vimtro/grok-context-manager/settings/rules).
Choose **New ruleset → New branch ruleset**.

- **Name:** `Protect main - PR only`
- **Enforcement:** Active (not Evaluate)
- **Target:** `main` under the default-branch selector or include
  `refs/heads/main` explicitly.
- **Bypass list:** **Empty**. Do not add admin, owner, or automation bypasses.
- Enable **Require a pull request before merging**.
- Enable **Require status checks to pass**, including the CI jobs and
  `secret-scan` from the secret-scanning workflow, once those jobs appear
  in check selection.
- Enable **Block force pushes**, **Restrict deletions**.
- Consider **Require conversation resolution**.
- **Approvals:** set 0 if working alone, or 1+ if another trusted maintainer
  can approve. Requiring 1 approval when you are the sole maintainer may
  block every PR.

**Do not enable "Restrict updates" with an empty bypass list.** It can
block GitHub's PR merge operations as well as direct pushes. The
pull-request and required-check rules already enforce the desired workflow.

Once saved, inspect the ruleset in GitHub and confirm it is **Active** and
that there are **no bypass actors**.

## Optional CLI setup after rulesets become available

The repository includes `scripts/configure-main-ruleset.ps1` to create this
ruleset with GitHub CLI on an account that has admin rights. It performs no
visibility change and refuses to overwrite an existing ruleset.

```powershell
winget install GitHub.cli
gh auth login
.\scripts\configure-main-ruleset.ps1
```

If the ruleset cannot be enabled on a private repository using the current
organization plan, do not make the repository public until
[PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md) is complete.

## Verify enforcement

After applying the ruleset:

1. Confirm GitHub Settings shows it as **Active**.
2. Test a direct push to `main` from a disposable local commit. It must be
   rejected. Do not force push and do not test with unreviewed sensitive data.
3. Open a PR from a separate branch. The PR should be mergeable only after
   required checks pass.
4. Verify that admins are not on an exception/bypass list.
5. Confirm branch deletion and force pushes are blocked.

GitHub documentation:
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
