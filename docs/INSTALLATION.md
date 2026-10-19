# Installation (Windows first)

GCM runs entirely on your computer. You need **Node.js 22 or 24 LTS**, **Git**, and about 300 MB of disk space for
dependencies. No admin rights are needed except to install Node/Git.

## 1. Install Node.js and Git

Open **PowerShell** and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and reopen PowerShell, then check:

```powershell
node --version    # v22.x or v24.x
git --version
corepack enable   # makes pnpm available
pnpm --version
```

> **Why Node 22/24?** GCM stores data in SQLite via `better-sqlite3`, which ships ready-made Windows binaries for
> Node 22 and newer. Node 20 is end-of-life; it still works but needs Visual Studio C++ Build Tools to compile SQLite.

If `corepack enable` fails with a permissions error, run PowerShell as Administrator once for that command, or use
`npm install -g pnpm`.

## 2. Get GCM and build it

```powershell
cd $HOME\Documents
git clone https://github.com/vimtro/grok-context-manager.git
cd grok-context-manager
pnpm install
pnpm build
```

## 3. Put `gcm` on your PATH

```powershell
pnpm install:global     # packs the CLI and runs: npm install -g grok-context-manager-0.1.0.tgz
```

Open a new PowerShell window and check:

```powershell
gcm --version
gcm doctor
```

Prefer not to install globally? Run it from the repo: `pnpm gcm doctor` or `node apps\cli\dist\gcm.mjs doctor`.

## 4. First use

```powershell
gcm init                    # creates %LOCALAPPDATA%\GrokContextManager\gcm.sqlite
gcm bots add sales --name "Sales" --role "Account executive"
gcm dashboard               # opens http://127.0.0.1:4747 in your browser
```

Use a different data folder with `--home D:\GCM` or the `GCM_HOME` environment variable.

## Updating

```powershell
cd $HOME\Documents\grok-context-manager
git pull
pnpm install
pnpm build
pnpm install:global
```

Your data is not touched by updates. Schema upgrades back up the database to `backups\` first.

## Uninstalling

```powershell
npm uninstall -g grok-context-manager
# Optional — delete GCM's own data (never touches Grok Bot):
gcm data purge --yes          # run before uninstalling, or delete %LOCALAPPDATA%\GrokContextManager
```

## macOS / Linux

The same commands work (`brew install node@22 git` or your distribution's packages). Data lives in
`~/Library/Application Support/GrokContextManager` (macOS) or `~/.local/share/grok-context-manager` (Linux) and is
created with owner-only permissions.

## Troubleshooting

| Symptom                                                          | Fix                                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `gyp ERR!` / `better-sqlite3` build errors during `pnpm install` | You are on an older Node. Install Node 22 or 24 LTS and run `pnpm install` again.                                            |
| `pnpm : The term 'pnpm' is not recognized`                       | Run `corepack enable` (or `npm install -g pnpm`) and open a new terminal.                                                    |
| `running scripts is disabled on this system`                     | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`                                                                        |
| `gcm` not found after `pnpm install:global`                      | Open a new terminal; check `npm prefix -g` is on PATH.                                                                       |
| Dashboard says "assets not built"                                | Run `pnpm build` (it builds the dashboard before the CLI) and `pnpm install:global` again.                                   |
| Port 4747 in use                                                 | `gcm dashboard --port 4800`                                                                                                  |
| `gcm doctor` shows a database failure                            | Restore the newest file from `%LOCALAPPDATA%\GrokContextManager\backups\` by copying it over `gcm.sqlite` (close GCM first). |
