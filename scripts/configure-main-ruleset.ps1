# Creates a strict GitHub main-branch ruleset using the user's own gh login.
# No changes to repository visibility. Requires repository administration access.
[CmdletBinding()]
param([string]$Repository = 'vimtro/grok-context-manager')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh) is required. Install it and run gh auth login.'
}

gh auth status
if ($LASTEXITCODE -ne 0) { throw 'Authenticate first with: gh auth login' }

$repoInfo = gh api "repos/$Repository" --jq '{visibility: .visibility, default_branch: .default_branch}'
if ($LASTEXITCODE -ne 0) { throw 'Cannot access repository with your current GitHub login.' }
$metadata = $repoInfo | ConvertFrom-Json
if ($metadata.default_branch -ne 'main') {
  throw 'Expected main as the default branch; refusing to target a different branch.'
}

$existingJson = gh api "repos/$Repository/rulesets"
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub rulesets are unavailable for this repository/plan. No changes made.'
}
$existing = @($existingJson | ConvertFrom-Json)
if (@($existing | Where-Object { $_.name -eq 'Protect main - PR only' }).Count -gt 0) {
  throw 'The Protect main - PR only ruleset already exists. Review it in GitHub Settings; no changes made.'
}

$requiredChecks = @(
  'audit',
  'docker',
  'secret-scan',
  'ubuntu-latest · Node 22',
  'ubuntu-latest · Node 24',
  'windows-latest · Node 22',
  'windows-latest · Node 24'
)
$payload = @{
  name = 'Protect main - PR only'
  target = 'branch'
  enforcement = 'active'
  bypass_actors = @()
  conditions = @{ ref_name = @{ include = @('refs/heads/main'); exclude = @() } }
  rules = @(
    @{ type = 'deletion' },
    @{ type = 'non_fast_forward' },
    @{
      type = 'pull_request'
      parameters = @{
        dismiss_stale_reviews_on_push = $false
        require_code_owner_review = $false
        require_last_push_approval = $false
        required_approving_review_count = 0
        required_review_thread_resolution = $true
      }
    },
    @{
      type = 'required_status_checks'
      parameters = @{
        strict_required_status_checks_policy = $true
        required_status_checks = @($requiredChecks | ForEach-Object { @{ context = $_ } })
      }
    }
  )
}
$file = [System.IO.Path]::GetTempFileName()
try {
  ($payload | ConvertTo-Json -Depth 12) | Set-Content -Path $file -Encoding utf8
  Write-Host "Will create an ACTIVE main-branch ruleset for $Repository."
  Write-Host 'Require PR; enforce CI + secret scan; block force pushes and deletions; NO BYPASS actors.'
  Write-Host "Plan visibility: $($metadata.visibility)."
  $yes = Read-Host 'Type APPLY to create the ruleset'
  if ($yes -cne 'APPLY') { Write-Host 'Cancelled; no changes made.'; exit 0 }
  gh api "repos/$Repository/rulesets" -X POST --input $file
  if ($LASTEXITCODE -ne 0) { throw 'GitHub rejected the ruleset. Inspect errors and your organization plan.' }
  Write-Host "Ruleset submitted. Verify it is active in https://github.com/$Repository/settings/rules"
}
finally {
  Remove-Item $file -ErrorAction SilentlyContinue
}
