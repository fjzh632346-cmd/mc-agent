# Workflow Rules

## Required Commands

- New task start: `npm run workflow:context-check`
- After a small completed stage: `npm run workflow:checkpoint`
- Before ending a task: `npm run workflow:handoff`, `npm run workflow:role-report`, and `npm run workflow:report`
- Before compact or a new conversation: `npm run workflow:handoff`

## Real Game Acceptance

Minecraft acceptance must verify real game behavior. A passing report needs `verificationLevel=game_passed`.

The following are not enough for Minecraft feature PASS:

- `npm test` passed
- `npm run workflow:report` completed
- `npm run acceptance:minecraft` completed
- no syntax errors
- an AI chat reply says the task is done
- logs say a task completed

The acceptance path must remain:

```text
natural language
-> actionKey
-> intent-to-task
-> TaskManager
-> Action Lock
-> System/Action
```

Do not lower the standard by converting real failures to BLOCKED, relying only on chat replies, bypassing TaskManager, deleting failed cases, loosening quantity requirements, or treating an action success as full task completion.

## BLOCKED vs FAIL

Use `BLOCKED` when the environment cannot support a real judgment: server unavailable, AI offline, username mismatch, missing fixture, insufficient permissions, dimension mismatch, or invisible entities.

Use `FAIL` when the environment is ready, the command was sent, observation time was sufficient, and the AI behavior did not match expectations.
