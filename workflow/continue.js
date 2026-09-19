const {
  exists,
  readText,
  writeReport,
  acceptanceSummary,
  currentBlockers,
  fileList
} = require('./common')

function main() {
  const sources = [
    'workflow/reports/handoff-summary.md',
    'workflow/reports/latest-workflow-report.md',
    'logs/acceptance-report.md',
    'acceptance/reports/latest-report.md'
  ]
  const read = sources.filter(exists)
  for (const file of read) readText(file)

  const report = [
    '# Continue Plan',
    '',
    `- generatedAt: ${new Date().toISOString()}`,
    `- sourcesRead: ${read.join(', ') || 'none'}`,
    '',
    '## 本轮应该先做什么',
    '- Run `npm run workflow:context-check` first, then inspect the generated context facts before editing.',
    '',
    '## 为什么',
    '- The workflow should not rely on the user to restate project context each round.',
    `- Latest acceptance state: ${acceptanceSummary()}.`,
    '',
    '## 需要先验证什么',
    fileList([
      'package.json contains required workflow scripts.',
      'acceptance reports include verificationLevel.',
      'latest blockers are environment BLOCKED rather than hidden FAIL.',
      'Generated handoff summary is present before compact or a new conversation.'
    ]),
    '',
    '## 推荐运行哪些命令',
    fileList([
      'npm run workflow:context-check',
      'npm run workflow:checkpoint',
      'npm run workflow:handoff',
      'npm run workflow:continue',
      'npm run workflow:role-report',
      'npm run workflow:report',
      'npm test',
      'npm run acceptance:minecraft only when the real Minecraft server is available'
    ]),
    '',
    '## 推荐修改哪些文件',
    fileList([
      'workflow/*.js',
      'workflow/README.md',
      'workflow/rules.md',
      'workflow/templates/*.md',
      'acceptance/acceptance-runner.js only for report schema changes'
    ]),
    '',
    '## 不应该修改哪些文件',
    fileList([
      'TaskManager internals for this workflow-only round.',
      'Minecraft business feature implementations.',
      'Acceptance cases in a way that lowers real-game standards.'
    ]),
    '',
    '## 当前阻塞',
    fileList(currentBlockers())
  ].join('\n')

  const output = writeReport('workflow/reports/continue-plan.md', report)
  console.log(`[workflow] wrote ${output}`)
}

if (require.main === module) main()
