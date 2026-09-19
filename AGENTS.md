# AGENTS.md

# Minecraft AI Companion / LinXia Project Instructions

This repository is the Minecraft AI companion project, also called the LinXia project.

The goal is to build an AI companion that behaves like a real Minecraft player:

* understands natural-language commands,
* talks through personality/voice systems,
* uses TaskManager and ActionLock to act safely,
* can follow, fight, farm, mine, store items, build, explore, survive, and eventually make autonomous plans.

Do not treat this as a simple command bot. The project is an agent system with body/action systems, task lifecycle, memory, acceptance tests, and real Minecraft behavior.

---

## 0. 协作协议（最高优先级，先于本文件其余部分执行）

本仓库的三方协作（老板 / 开发 / 施工）走固定文件通道，**不走聊天窗口**：

- 会话开场先读 `docs/协作/给CC.md` —— 本轮要你做什么，以及老板已拍板的决策
- 收尾把结果写进 `docs/协作/CC反馈.md` —— 每轮覆盖重写，旧的先挪进 `docs/协作/历史/`
- 完整规则、反馈文件的固定格式、常驻红线：`docs/协作/说明.md`

**不要发链接。不要只在聊天里回复。不要新建别的报告文件。**
老板看不到聊天窗口，开发只读 `CC反馈.md`。写进文件才算交付。

---

## 1. Absolute first steps in every session

At the start of every new Codex session in this repository:

1. Run:

```powershell
git status
git log --oneline -5
```

2. Read the latest state from real files, not from memory:

```text
acceptance/reports/latest-summary.md
acceptance/reports/latest-report.md
acceptance/reports/latest-report.json
workflow/reports/latest-workflow-report.md
workflow/reports/handoff-summary.md
workflow/reports/role-review-report.md
```

3. If runtime behavior is relevant, read:

```text
logs/bot-current.log
```

4. Report the current verified state before modifying code.

Do not rely only on chat history, old handoff notes, or remembered project state.

---

## 2. Anti-hallucination rules

Every important claim must be grounded in evidence.

Use these categories when reporting:

* Confirmed facts: directly supported by current files, logs, or command output.
* Reasonable inference: based on evidence, but not directly proven.
* Next-step recommendation: what should be done next.

Rules:

1. Do not claim a task passed unless latest reports or logs prove it.
2. Do not claim code was changed unless the diff or git status proves it.
3. If evidence is missing, say UNKNOWN.
4. Old reports and old handoff summaries are background only.
5. `latest-summary.md`, `latest-report.json`, current logs, and `git status` are stronger than old summaries.
6. If a report says stale state was corrected, do not revive the stale state.
7. Before modifying code, summarize the current evidence and the intended minimal change.
8. Do not use phrases like "probably fixed" or "should be done" as substitutes for evidence.

---

## 3. Current known project baseline

The repository has Git initialized.

Known initial backup commit:

```text
577b89f backup: initial minecraft ai companion project state
```

Current important acceptance context:

* `following` has already reached valid PASS in the latest known acceptance state.
* A stale old state once showed:

  * `following = BLOCKED / configured_ai_not_online`
* That stale following BLOCKED state must not override latest reports.
* Always re-check the current files before assuming this is still true.

Known recent judgment pattern:

```text
following = PASS / game_passed / followed_and_stopped
farming = under active investigation
storage = often BLOCKED by fixture/environment setup
```

Do not rework following unless the current latest reports prove it has regressed.

---

## 4. Architecture rules

Do not bypass the architecture.

Natural-language command flow must remain:

```text
natural language
-> command-router / intent-parser
-> actionKey
-> intent-to-task
-> TaskManager
-> Task / System
-> Actions
-> ActionLock
-> Mineflayer bot operation
```

Never "fix" a task by directly operating the bot from the router or acceptance script.

TaskManager owns task lifecycle:

```text
IDLE / RUNNING / PAUSED / FAILED / COMPLETED / INTERRUPTED
```

ActionLock owns safe access to shared capabilities:

```text
movement
combat
inventory
digging
building
crafting
```

Do not bypass ActionLock to make tests pass.

---

## 5. Natural-language understanding rules

For any new command area or intent recognition feature, use a three-layer fallback architecture:

1. Clear rule layer:

   * high-confidence explicit commands.
2. Semantic / LLM intent layer:

   * meaning-similar expressions.
3. Fallback confirmation / chat layer:

   * ambiguous, low-confidence, discussion, or casual-chat inputs.

Natural-language examples are examples, not mandatory exact phrases.

Do not make the system only react to fixed hard-coded sentences.

---

## 6. Acceptance and testing principles

This project is real Minecraft behavior. Acceptance results matter more than code appearance.

Before running long tests, prefer short bounded runs.

After any code change, restart the LinXia bot and confirm it has reconnected to the Minecraft LAN/server before running acceptance or manual behavior verification.

For `acceptance:minecraft`:

* Use 120-180 second timeout when possible.
* Do not allow infinite waits.
* If timeout happens, preserve logs and report where it hung.
* Do not overwrite a valid latest summary with a bad or partial result unless the acceptance system intentionally records that state.

Generated files often become dirty after test runs:

```text
acceptance/reports/latest-report.json
acceptance/reports/latest-report.md
acceptance/reports/latest-summary.md
data/memory/task-memory.json
```

Do not commit generated reports or runtime memory unless the user explicitly agrees.

---

## LinXia Bot Startup / Restart

The current real bot entry point is `bot.js`. `README.md` documents starting it with:

```powershell
node bot.js
```

`scripts/dev-acceptance.js` also starts the bot by spawning `bot.js`, then starts the acceptance watcher.

Recommended Windows / PowerShell restart flow:

```powershell
taskkill /F /IM node.exe
node bot.js
```

Use `taskkill /F /IM node.exe` only when the running Node processes are the local LinXia/acceptance processes for this repo. It stops the old LinXia bot so new code is actually loaded.

To keep the bot running while acceptance executes in the same PowerShell session, use a bounded job and clean it up after the run:

```powershell
$botJob = Start-Job -ScriptBlock { Set-Location 'D:\code\MC'; node bot.js }
Start-Sleep -Seconds 18
npm.cmd run acceptance:minecraft
Stop-Job $botJob
Remove-Job $botJob -Force
```

Confirm the bot connected before behavior verification by checking `logs/bot-current.log` for all of these runtime signals:

```text
找到 MC 服务器
[TickLoop] started
[Bot] 上线成功
[DEBUG_STATUS] {"botUsername":"LinXia", ...}
```

If the bot does not connect, is not visible online, or `DEBUG_STATUS` cannot prove `LinXia` is present, the acceptance/manual verification state is BLOCKED. Do not report PASS or FAIL for the behavior under test until the bot is reconnected and the real behavior has run.

### Real Minecraft Acceptance Startup Flow for LinXia

Real Minecraft acceptance must not reuse an old Node process or an old LinXia session. Before running acceptance, stop any local LinXia/acceptance Node processes for this repo, then start a fresh bot from `D:\code\MC`.

The currently verified Codex/PowerShell flow is:

```powershell
taskkill /F /IM node.exe
$botJob = Start-Job -ScriptBlock { Set-Location 'D:\code\MC'; node bot.js }

# Wait for ONLINE-GATE before running acceptance.
npm.cmd run acceptance:minecraft -- --cases=crafting

Stop-Job $botJob
Remove-Job $botJob -Force
```

`taskkill /F /IM node.exe` is only appropriate when the running Node processes are the local LinXia/acceptance processes for this repo. If no `node.exe` process exists, that is acceptable; continue with a fresh `Start-Job`.

ONLINE-GATE must pass before the acceptance command starts. Confirm fresh entries in `logs/bot-current.log` for all of these signals:

```text
找到 MC 服务器
[TickLoop] started
[Bot] 上线成功
[DEBUG_STATUS] {"botUsername":"LinXia", ...}
```

The verified crafting run on HEAD `aa4e1438279104f4727b054ecb0f7e4c4cccac39` used this flow and reached:

```text
16 PASS / 0 FAIL / 0 BLOCKED / 0 ERROR
```

If startup or ONLINE-GATE fails, do read-only diagnosis from logs and reports, then report the relevant acceptance/manual verification state as BLOCKED. Do not fix business code, acceptance cases, runner logic, or assertions as a side effect of startup or ONLINE-GATE failure.

---

## 7. Farming current investigation rules

Farming recently had a critical acceptance diagnosis:

A previous farming FAIL was caused by the acceptance case judging too early, not by FarmingTask failing to run.

Observed chain:

```text
accept_tester sent: 帮我收一下成熟的小麦，收完补种
command-router: actionKey=HARVEST_FARM
intent parser: intent=harvest_farm
intent-to-task: task=farming
TaskManager queued and started farming
ActionLock acquired movement / digging
multiple CROP_FOUND and CROP_HARVEST_SUCCESS logs appeared
later logs showed FARMING_TASK_SUCCESS
TaskManager completed farming
```

Important rule:

```text
[CROP_HARVEST_SUCCESS]
```

is process evidence only. It is not a farming case terminal state.

The farming acceptance case must wait for one of these terminal states:

```text
[FARMING_TASK_SUCCESS]
[FARMING_TASK_FAILED]
TaskManager completed farming
TaskManager failed farming
explicit timeout
```

Only after terminal state should the case snapshot status and judge the result.

Do not lower the acceptance standard.

The command includes "收完补种", so `plantedCount` still matters. If farming completes but `plantedCount=0`, report it as a possible real behavior issue or missing replant behavior. Do not delete the planted check just to make PASS.

Do not modify FarmingTask business logic until the acceptance waiting logic is confirmed correct.

---

## 8. Storage current investigation rules

Storage has recently been BLOCKED mostly by fixture/environment setup, not proven business failure.

Known fixture issue:

```text
fixture_target_has_no_support:chest@{"x":550,"y":89,"z":16}
```

Meaning:

```text
creative fixture tried to place a chest where the target block had no support below it.
```

Do not rewrite storage business logic while storage is still fixture BLOCKED.

First confirm that a reachable, openable chest exists and contains `wheat_seeds`.

Storage should only enter real behavior debugging after fixture/environment is READY.

---

## 9. Generalization rule: do not patch only one symptom

When fixing a bug, look for the same class of bug in related systems.

Example:

If harvesting wheat only handles one item, also consider whether these count/batch tasks have the same flaw:

* chopping trees,
* mining blocks,
* taking items from chests,
* storing items into chests,
* crafting bread,
* crafting tools,
* smelting items,
* eating food,
* collecting dropped items.

Prefer reusable fixes:

```text
shared count handling
batch execution
max-available logic
consistent completion criteria
clear partial-success reporting
```

Avoid one-off if-statements that only make a single acceptance case pass.

---

## 10. Do not do broad feature work unless explicitly asked

Do not casually start any of these unless the user clearly asks:

* full crafting system,
* all workbench recipes,
* all furnace recipes,
* advanced tool selection,
* batch quantity framework,
* storage architecture rewrite,
* exploration rewrite,
* survival priority rewrite,
* personality rewrite,
* voice/ASR/TTS rewrite.

When the current task is a bug or acceptance failure, keep the patch minimal and targeted.

---

## 11. Reporting format

At the end of each task, report:

1. Files read.
2. Files changed.
3. Commands run.
4. Test results.
5. Current latest judgment.
6. Whether generated reports or memory became dirty.
7. Whether a commit is recommended.
8. Remaining risk.

For debugging tasks, also report:

* root cause,
* evidence,
* whether the issue is acceptance-script, fixture/environment, business logic, logging, pathing, lock conflict, or stale report pollution.

---

## 12. Git rules

Before changes:

```powershell
git status
```

After successful code changes:

```powershell
git status
git diff --stat
```

Do not commit unless the user asks or the task explicitly includes committing.

Do not include generated reports or `data/memory/task-memory.json` in commits unless the user explicitly agrees.

Use clear commit messages:

```text
fix: correct farming acceptance terminal wait
test: record minecraft acceptance result
chore: harden minecraft acceptance fixture setup
backup: stable state before next stage
```

---

## 13. Safety rules for this project

Do not delete existing project files unless explicitly instructed.

Do not rewrite large modules when a small fix is enough.

Do not lower acceptance standards.

Do not turn FAIL into PASS by changing the report only.

Do not hide BLOCKED states.

Do not bypass the real Minecraft behavior check.

Do not claim the bot behaves correctly unless the logs or acceptance evidence prove it.

---

## 14. Preferred next-step logic

When starting from an unknown state:

1. Read git status.
2. Read latest reports.
3. Read latest logs.
4. Determine:

   * following PASS/FAIL/BLOCKED,
   * farming PASS/FAIL/BLOCKED,
   * storage PASS/FAIL/BLOCKED.
5. If following is PASS, do not rework it.
6. If farming is failing, determine whether it is:

   * acceptance waiting problem,
   * no command received,
   * intent routing problem,
   * task creation problem,
   * ActionLock conflict,
   * pathing failure,
   * crop detection failure,
   * harvest problem,
   * replant problem,
   * completion/logging problem.
7. If storage is BLOCKED, determine whether it is:

   * missing chest,
   * chest unreachable,
   * chest has no support,
   * chest cannot open,
   * chest missing `wheat_seeds`,
   * business logic failure after fixture READY.
8. Only then propose a minimal fix.
