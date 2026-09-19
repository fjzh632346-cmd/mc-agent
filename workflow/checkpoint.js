const {
  appendReport,
  acceptanceSummary,
  currentBlockers,
  modifiedFilesGuess,
  fileList
} = require('./common')

function main() {
  const entry = [
    '',
    '---',
    '',
    `## Checkpoint ${new Date().toISOString()}`,
    '',
    '### 当前阶段',
    'Workflow Context Manager V1 and real-game verification discipline.',
    '',
    '### 已完成事项',
    fileList([
      'Updated workflow command surface.',
      'Generated or refreshed context, handoff, continue, role, and workflow reports when commands are run.',
      'Kept Minecraft behavior scope unchanged.'
    ]),
    '',
    '### 修改文件',
    fileList(modifiedFilesGuess()),
    '',
    '### 运行过的命令',
    fileList([
      'Commands are appended by the human/Codex final summary; this checkpoint records the current workflow command state.',
      'Recommended: npm run workflow:context-check, npm run workflow:handoff, npm run workflow:continue, npm run workflow:role-report, npm run workflow:report, npm test.'
    ]),
    '',
    '### 当前测试结果',
    `- Latest acceptance: ${acceptanceSummary()}`,
    '',
    '### 当前阻塞',
    fileList(currentBlockers()),
    '',
    '### 下一步',
    '- Run the required workflow commands and npm test, then inspect generated reports.'
  ].join('\n')

  const output = appendReport('workflow/reports/progress-log.md', entry)
  console.log(`[workflow] appended ${output}`)
}

if (require.main === module) main()
