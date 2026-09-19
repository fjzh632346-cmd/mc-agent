# One-Person Company AI Development Workflow

This workflow is a reusable operating system for one-person AI-assisted development. The current landing project is the Minecraft AI companion, but the workflow must remain project-neutral.

## Fixed Loop

1. `requirement-clarification`: clarify the real user need, success criteria, constraints, and unknowns.
2. `scope-control`: keep the current round small enough to finish and verify.
3. `architecture-design`: choose boundaries, interfaces, data flow, and observability.
4. `generalization-review`: check whether the issue belongs to a wider class of similar problems.
5. `implementation`: Codex reads the project, edits code, and runs scripts.
6. `acceptance-testing`: run real tests against the actual product behavior.
7. `log-analysis`: inspect evidence, logs, failures, and missing observability.
8. `regression-testing`: run focused regression checks for related behavior.
9. `context-summary`: compress the round into a handoff-ready summary.
10. `next-plan`: choose the next small round.

## Separation

The framework layer owns the loop, role prompts, templates, normalized report fields, and acceptance runner.

The project adapter owns startup, connection, commands, observation, and project-specific evidence. For this project, `acceptance/adapters/minecraft.adapter.js` uses Mineflayer to join the test server as a player and observe real Minecraft behavior.

To reuse this workflow for another project:

1. Add a project entry in `workflow/config/project.config.json`.
2. Add an adapter entry in `workflow/config/acceptance.config.json`.
3. Implement a new adapter, for example `acceptance/adapters/web.adapter.js`.
4. Add project acceptance cases, for example `acceptance/cases/login.acceptance.js`.
5. Keep reports in the same normalized schema.

## Commands

- `npm run acceptance:minecraft`: run the Minecraft real acceptance suite.
- `npm run workflow:context-check`: read key context and write `workflow/reports/context-check.md`.
- `npm run workflow:checkpoint`: append progress to `workflow/reports/progress-log.md`.
- `npm run workflow:handoff`: write `workflow/reports/handoff-summary.md` for compact or a new conversation.
- `npm run workflow:continue`: read handoff and reports, then write `workflow/reports/continue-plan.md`.
- `npm run workflow:role-report`: write `workflow/reports/role-review-report.md`.
- `npm run workflow:report`: write the latest workflow context summary from the latest acceptance report.

## Real Acceptance Rule

Acceptance must exercise the product through its public or user-facing path. For Minecraft, commands must go through:

`natural language -> actionKey -> intent-to-task -> TaskManager -> Action Lock -> System / Action`

The acceptance adapter may observe logs, world state, chat, entities, containers, and blocks, but it must not directly call internal action functions to complete the task.

Minecraft feature `PASS` requires `verificationLevel=game_passed`. Script completion, unit tests, syntax checks, chat replies, and task-completed logs are useful evidence, but they are not enough to prove real game behavior.

## Codex Discipline V1

At the start of each new task, Codex must run:

```bash
npm run workflow:context-check
```

After each completed small stage, Codex must run:

```bash
npm run workflow:checkpoint
```

Before ending a task, Codex must run:

```bash
npm run workflow:handoff
npm run workflow:role-report
npm run workflow:report
```

Before context compaction or moving to a new conversation, Codex must run:

```bash
npm run workflow:handoff
```

The user should not need to remind Codex which files to read. The workflow commands own that context loading and fact-checking.

## Conversation Handoff V1

Do not pretend that the project can reliably open a new visible UI conversation when context crosses a threshold. V1 uses these rules:

- Codex may compact context.
- The project hands off through `workflow/reports/handoff-summary.md`.
- A new conversation should first run `npm run workflow:context-check` and `npm run workflow:continue`.
- V2 may explore Codex hooks such as PreCompact and Stop hooks to run handoff commands automatically.
