const {
  writeReport,
  acceptanceReport,
  acceptanceSummary,
  currentBlockers,
  modifiedFilesGuess,
  fileList
} = require('./common')

function main() {
  const acceptance = acceptanceReport()
  const cases = acceptance?.results || []
  const latestAcceptanceResult = acceptanceSummary(acceptance)
  const importantFacts = [
    'This repo is building a reusable one-person-company AI development workflow.',
    'Minecraft is the first project adapter, not the whole framework.',
    'Minecraft PASS requires verificationLevel=game_passed and real game behavior evidence.',
    'The next round must still run workflow:context-check before acting.'
  ]

  const report = [
    '# Handoff Summary',
    '',
    '## projectName',
    acceptance?.projectName || 'minecraft',
    '',
    '## currentGoal',
    'Implement Workflow Context Manager V1 and enforce real-game verification-level reporting without adding Minecraft business features.',
    '',
    '## latestAcceptanceResult',
    latestAcceptanceResult,
    '',
    '## statusCorrection',
    'This handoff was regenerated from acceptance/reports/latest-report.json and acceptance/reports/latest-summary.md. A previous handoff-summary.md still showed 0 PASS / 0 FAIL / 3 BLOCKED; that stale state is superseded here.',
    '',
    '## latestCaseStatus',
    fileList(cases.map(result => {
      const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'none'
      return `${result.featureName}/${result.testName}: ${result.judgment}, verificationLevel=${result.verificationLevel || 'unknown'}, reason=${reason}`
    })),
    '',
    '## latestTestResult',
    'npm test result is not machine-read from this file. Run npm test in the next active turn if code changed.',
    '',
    '## importantFacts',
    fileList(importantFacts),
    '',
    '## currentBlockers',
    fileList(currentBlockers(acceptance)),
    '',
    '## completedWork',
    fileList([
      'Workflow command surface planned and generated through scripts.',
      'Role reports and handoff reports are workflow-level artifacts.',
      'Acceptance reports include verificationLevel after rerun.'
    ]),
    '',
    '## modifiedFiles',
    fileList(modifiedFilesGuess()),
    '',
    '## pendingWork',
    fileList([
      'Rerun acceptance:minecraft when a real Minecraft server and LinXia bot are available.',
      'Keep farming/storage blocked until fixtures exist.',
      'Consider machine-readable npm test output in V2.'
    ]),
    '',
    '## nextRecommendedCommand',
    'npm run workflow:context-check',
    '',
    '## nextCodexPrompt',
    'Read workflow/reports/handoff-summary.md, run npm run workflow:context-check and npm run workflow:continue, then choose the next smallest verifiable step.',
    '',
    '## filesNextSessionMustRead',
    fileList([
      'workflow/reports/handoff-summary.md',
      'workflow/reports/context-check.md',
      'workflow/reports/latest-workflow-report.md',
      'workflow/reports/role-review-report.md',
      'acceptance/reports/latest-report.json',
      'logs/acceptance-report.md',
      'package.json'
    ]),
    '',
    '## doNotForget',
    fileList([
      'Handoff summary does not replace real code or acceptance reports.',
      'Next round still needs workflow:context-check.',
      'Do not treat code-only tests as Minecraft feature PASS.'
    ]),
    '',
    '## doNotModify',
    fileList([
      'Do not add Minecraft business features for this workflow-only round.',
      'Do not refactor TaskManager.',
      'Do not lower acceptance standards.'
    ]),
    '',
    '## evidenceLinksOrPaths',
    fileList([
      'workflow/reports/latest-workflow-report.md',
      'workflow/reports/role-review-report.md',
      'acceptance/reports/latest-report.md',
      'acceptance/reports/latest-report.json',
      'logs/acceptance-report.md',
      ...cases.map(result => `acceptance case: ${result.featureName} -> ${result.judgment} / ${result.verificationLevel || 'unknown'}`)
    ])
  ].join('\n')

  const output = writeReport('workflow/reports/handoff-summary.md', report)
  console.log(`[workflow] wrote ${output}`)
}

if (require.main === module) main()
