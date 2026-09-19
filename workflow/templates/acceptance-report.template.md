# Acceptance Report

## Standard Fields

- `projectName`
- `featureName`
- `testName`
- `commandOrInput`
- `preState`
- `postState`
- `observedBehavior`
- `expectedBehavior`
- `actualResult`
- `passOrFail`
- `verificationLevel`: `code_only`, `simulated`, `game_blocked`, `game_observed`, or `game_passed`
- `failureReason`
- `evidence`
- `relatedLogs`
- `regressionRisk`
- `nextSuggestion`

## Verification Level Rule

For Minecraft, a feature can be marked `PASS` only when `verificationLevel` is `game_passed`.
Code tests, successful script execution, chat replies, or task-completed logs alone are not sufficient.
