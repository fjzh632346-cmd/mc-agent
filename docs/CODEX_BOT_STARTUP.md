# Codex Bot Startup Runbook

Last updated: 2026-06-27

## Directory

Use the current worktree:

```powershell
Set-Location 'D:\code\MC-blueprint-ir-v1'
```

## Minecraft Server

No repository script was found that starts a Minecraft server for this worktree. The user must manually confirm the Minecraft LAN/server is already running and reachable from localhost.

The bot can auto-detect the port through `port-finder`, or you can set `MC_PORT` explicitly.

## Start LinXia Bot

Default persona is now LinXia:

```powershell
$env:PERSONA = 'linxia'
$env:VOLC_TTS_ENABLED = 'false'
node bot.js
```

`PERSONA=linxia` is optional after this handoff because `bot.js` defaults to `linxia`, but setting it explicitly is useful while verifying identity.

Important runtime note:

- `node bot.js` constructs the DeepSeek/OpenAI client at startup.
- If no API key is configured, startup can fail with missing credentials.
- A dummy key can let local routing/acceptance exercise fallback paths, but logs will contain LLM 401 warnings. Do not confuse those warnings with the building placement failure.

Known acceptance-friendly startup pattern:

```powershell
taskkill /F /IM node.exe
$env:PERSONA = 'linxia'
$env:ACCEPTANCE_AI_USERNAME = 'LinXia'
$env:ACCEPTANCE_TEST_USERNAME = 'accept_tester'
$env:VOLC_TTS_ENABLED = 'false'
$env:DEEPSEEK_API_KEY = '<real-or-local-test-key>'
node bot.js
```

Use `taskkill /F /IM node.exe` only when the running Node processes are local LinXia/acceptance processes for this repo.

### Long-lived processes from a Claude Code session (round 15)

Every process started from a Claude Code tool shell — `Start-Process`, `Start-Job`, `cmd /c start` — is placed in the Windows Job Object that Claude Code keeps its own process tree in (`IsProcessInJob` reports `IN_JOB` for the tool shell, its `claude.exe` ancestors, and all of their children), and is killed when the app exits. Round 14 lost the dedicated server (hard-killed, no `Stopping server`) and the bot that way.

`scripts\start-detached.ps1` launches through WMI (`Win32_Process.Create`): the child is spawned by `WmiPrvSE.exe`, is `NOT_IN_JOB`, and keeps running after the session ends. Named environment variables are copied from the current session (WMI children inherit the provider host's environment, not yours), and the command runs inside a `powershell -NoProfile -EncodedCommand` wrapper so Unicode values survive. Launch `node -e` directly through WMI without the wrapper and it exits within seconds (no usable stdio handles is the likely cause) — always go through the script.

```powershell
$env:MC_SERVER_JAVA = 'C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot\bin\java.exe'
$env:MC_WORLD_ID = 'building-A:新的世界'; $env:MC_PORT = '25565'; $env:MC_VERSION = '1.21.8'
scripts\start-detached.ps1 -Command 'scripts\mc-server.ps1 start' -Env MC_SERVER_JAVA -LogFile '.tmp\server-start.log'
scripts\start-detached.ps1 -Command 'node bot.js' -Env MC_WORLD_ID,MC_PORT,MC_VERSION -LogFile '.tmp\bot-stdout.log'
```

The script prints the wrapper PID; find the worker by command line (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`). Stop the bot with `Stop-Process -Id <pid>` and the server with `scripts\mc-server.ps1 stop` (RCON, graceful) — detached processes are not cleaned up for you.

## ONLINE-GATE

Before running real Minecraft acceptance, confirm fresh `logs/bot-current.log` entries show:

```text
找到 MC 服务器
[TickLoop] started
[Bot] 上线成功
[DEBUG_STATUS] {"botUsername":"LinXia", ...}
```

After this handoff, any fresh run that still reports `botUsername":"Andy"` means the new code was not loaded or `PERSONA=andy` was set.

## Building Acceptance

Confirmed script from `package.json`:

```powershell
npm.cmd run acceptance:minecraft -- --cases=building
```

This handoff also adds a narrow alias:

```powershell
npm.cmd run acceptance:building
```

P0 incident caution:

- Do not run a fresh building acceptance while rescuing a real half-built structure.
- First use logs/reports and `RESCUE_EXISTING_BUILD` style reconciliation to confirm whether an active ConstructionRun can be resumed.
- A fresh/rebuild path must not overwrite existing bounds unless the caller explicitly opts into `allowOverwriteExistingStructure:true`.

Recommended one-case run:

```powershell
$env:ACCEPTANCE_AI_USERNAME = 'LinXia'
$env:ACCEPTANCE_TEST_USERNAME = 'accept_tester'
$env:ACCEPTANCE_BUILDING_SCENARIOS = 'case1_two_story_house'
npm.cmd run acceptance:building
```

If the port is known:

```powershell
$env:MC_PORT = '<detected-port>'
```

Do not report PASS unless `acceptance/reports/latest-summary.md` or `acceptance/reports/latest-report.json` records PASS.

## Latest Failure Evidence

First evidence files to read:

- `acceptance/reports/latest-summary.md`
- `acceptance/reports/latest-report.md`
- `acceptance/reports/latest-report.json`
- `logs/bot-current.log`
- `workflow/reports/latest-workflow-report.md`
- `workflow/reports/handoff-summary.md`
- `workflow/reports/role-review-report.md`
- `docs/CODEX_BUILDING_HANDOFF.md`

Current latest building acceptance evidence at handoff time:

```text
0 PASS / 1 FAIL / 0 BLOCKED / 0 ERROR
building / case1 P9R faithful community two-story wood house import
reason: build_task_failed:place_failed:unstable_air
finishedAt: 2026-06-27T10:01:38.331Z
recommendedTeleportCommand: /tp LinXia accept_tester
```

The latest acceptance report includes `fixtureMode: FRESH_FIXTURE_BUILD`; do not use that case as proof that resume failed.

## New Codex First Reads

At the start of the next conversation, read in this order:

```text
AGENTS.md
docs/CODEX_BUILDING_HANDOFF.md
docs/CODEX_BOT_STARTUP.md
acceptance/reports/latest-summary.md
acceptance/reports/latest-report.md
acceptance/reports/latest-report.json
logs/bot-current.log
```

Then run:

```powershell
git status --short
git log --oneline -10
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --cached --stat
```
