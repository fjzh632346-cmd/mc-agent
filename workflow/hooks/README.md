# Workflow Hooks V1 Placeholder

This folder reserves examples for future Codex hook integration. The current V1 workflow does not assume hooks are available or configured.

## Intended V2 Behavior

- PreCompact hook: run `npm run workflow:handoff` before context compaction.
- Stop hook: run `npm run workflow:handoff` and `npm run workflow:role-report` when a task turn ends.

Actual Codex hook configuration is left for V2.
