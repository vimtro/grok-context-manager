# GCM public-release safety gate.
# Execute inside a local clone with Git, pnpm, and a locally installed Gitleaks.
# Does not change remote settings or publish anything.
[CmdletBinding()]
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name. Install it first and rerun this preflight."
  }
}

function Run-Checked([string]$Name, [string[]]$Arguments) {
  Write-Host ">> $Name $($Arguments -join ' ')"
  & $Name @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Preflight failed: $Name exited with code $LASTEXITCODE."
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  Require-Command git
  Require-Command gitleaks
  Run-Checked git @('rev-parse', '--show-toplevel')
  Write-Host 'Checking tracked files for sensitive file types...'
  $tracked = @(git ls-files)
  if ($LASTEXITCODE -ne 0) { throw 'Could not list tracked files.' }
  $suspicious = @($tracked | Where-Object {
    $_ -match '(?i)(^|/)(\.env($|\.)|id_rsa$|id_ed25519$|credentials?\.json$|store\.db$)' -or
    $_ -match '(?i)\.(sqlite|sqlite3|db|p12|pfx|pem|key)$'
  })
  if ($suspicious.Count -gt 0) {
    Write-Host ($suspicious -join [Environment]::NewLine)
    throw 'Potentially sensitive tracked files found. Review them before release.'
  }
  Write-Host 'Scanning full Git history using Gitleaks...'
  Run-Checked gitleaks @('git', '--redact', '.')
  Write-Host 'Scanning current working directory using Gitleaks...'
  Run-Checked gitleaks @('dir', '--redact', '.')
  Write-Host 'Review author emails manually: git log --all --format="%an <%ae>"'
  Write-Host 'Manually review examples and docs: scanners cannot detect every privacy risk.'

  if (-not $SkipTests) {
    Require-Command pnpm
    Run-Checked pnpm @('install', '--frozen-lockfile')
    foreach ($step in @('typecheck', 'lint', 'format:check', 'build', 'test', 'test:e2e', 'smoke')) {
      Run-Checked pnpm @($step)
    }
    Run-Checked pnpm @('audit', '--prod', '--audit-level', 'high')
    Write-Host 'Docker smoke test must also pass in GitHub CI.'
  } else {
    Write-Warning 'Tests skipped; this preflight alone is insufficient for publication.'
  }

  Write-Host 'Preflight checks passed. Manual privacy review and public-release approval are STILL required.'
}
finally {
  Pop-Location
}
