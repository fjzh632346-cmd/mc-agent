const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const acceptanceJsonPath = path.join(rootDir, 'acceptance', 'reports', 'latest-report.json')
const outputPath = path.join(rootDir, 'workflow', 'reports', 'latest-workflow-report.md')
const roleReviewOutputPath = path.join(rootDir, 'workflow', 'reports', 'role-review-report.md')

function main() {
  const acceptance = readAcceptanceReport()
  const modifiedFiles = [
    'workflow/config/project.config.json',
    'workflow/config/acceptance.config.json',
    'workflow/README.md',
    'workflow/roles/*.md',
    'workflow/templates/*.md',
    'workflow/workflow-report.js',
    'acceptance/acceptance-runner.js',
    'acceptance/scenario-builder.js',
    'acceptance/adapters/minecraft.adapter.js',
    'acceptance/cases/minecraft-case-utils.js',
    'acceptance/cases/*.acceptance.js',
    'acceptance/reports/latest-report.md',
    'logs/acceptance-report.md',
    'workflow/reports/role-review-report.md',
    'bot.js',
    'package.json'
  ]

  const failures = acceptance?.results?.filter(result => result.judgment !== 'PASS') || []
  const passCount = acceptance?.passCount ?? 0
  const failCount = acceptance?.failCount ?? 0
  const blockedCount = acceptance?.blockedCount ?? 0
  const errorCount = acceptance?.errorCount ?? 0
  const acceptanceText = acceptance
    ? `Latest acceptance: ${passCount} pass, ${failCount} fail, ${blockedCount} blocked, ${errorCount} error.`
    : 'No completed acceptance run yet.'
  const verificationText = acceptance ? verificationSummary(acceptance) : 'No verification levels recorded.'
  const caseStatusText = acceptance ? caseStatusSummary(acceptance) : '- None recorded.'

  const lines = [
    '# Latest Workflow Report',
    '',
    '## Round Goal',
    '',
    'Establish a reusable one-person-company AI development workflow framework and land the first Minecraft acceptance adapter without making the framework Minecraft-only.',
    '',
    '## Modified Files',
    '',
    ...modifiedFiles.map(file => `- ${file}`),
    '',
    '## Completed',
    '',
    '- Added/updated reusable workflow roles, templates, config, and README.',
    '- Added a generic acceptance runner with setup, execute, assert, and report lifecycle support.',
    '- Added BLOCKED and ERROR judgments in addition to PASS and FAIL.',
    '- Added a Minecraft adapter that uses Mineflayer to connect as a real test player and collect environment evidence.',
    '- Added Minecraft fixture setup checks and optional command-based fixture creation.',
    '- Added bot debug_status observability logs.',
    '',
    '## Not Completed',
    '',
    '- Command-based fixture creation requires an op-enabled test server and ACCEPTANCE_ALLOW_COMMAND_FIXTURES=true.',
    '- AI inventory changes are still inferred from storage/farming logs and chest deltas unless debug_status exposes enough summary data.',
    '- Multi-chest and inaccessible-chest fixtures are not automated yet.',
    '',
    '## Acceptance Result',
    '',
    acceptanceText,
    '',
    '## Status Correction',
    '',
    'Reports are regenerated from acceptance/reports/latest-report.json and acceptance/reports/latest-summary.md. A previous handoff-summary.md still showed 0 PASS / 0 FAIL / 3 BLOCKED; that stale state is superseded by the latest acceptance state.',
    '',
    '## Case Status',
    '',
    caseStatusText,
    '',
    '## Verification Levels',
    '',
    verificationText,
    '',
    '## Failure Reasons',
    '',
    ...(failures.length ? failures.map(result => {
      const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'No reason recorded.'
      return `- ${result.featureName}/${result.testName}: ${reason}`
    }) : ['- None recorded.']),
    '',
    '## New Risks',
    '',
    '- Acceptance depends on a real Minecraft LAN/server being open and the AI companion bot already running or configured to start.',
    '- The acceptance player username must be accepted by bot.js; use ACCEPTANCE_TEST_USERNAME or one of the configured defaults.',
    '- Command fixture creation can fail silently when the acceptance player lacks permission, so reports must keep BLOCKED distinct from FAIL.',
    '',
    '## Next Codex Suggestions',
    '',
    '- Run `npm run acceptance:minecraft` with ACCEPTANCE_AI_USERNAME set to the real bot name.',
    '- If the server allows commands, set ACCEPTANCE_ALLOW_COMMAND_FIXTURES=true to let the fixture builder try to prepare wheat and chest state.',
    '- Use BLOCKED reports to prepare the world, then use FAIL reports to prioritize real product fixes.',
    '',
    '## Compressed Context For New Conversation',
    '',
    compressedContext(acceptance)
  ]

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
  fs.writeFileSync(roleReviewOutputPath, renderRoleReviewReport(acceptance), 'utf8')
  console.log(`[workflow] wrote ${outputPath}`)
  console.log(`[workflow] wrote ${roleReviewOutputPath}`)
}

function readAcceptanceReport() {
  if (!fs.existsSync(acceptanceJsonPath)) return null
  return JSON.parse(fs.readFileSync(acceptanceJsonPath, 'utf8'))
}

function compressedContext(acceptance) {
  const resultSummary = acceptance
    ? `Latest acceptance result: ${acceptance.passCount} pass, ${acceptance.failCount} fail, ${acceptance.blockedCount || 0} blocked, ${acceptance.errorCount || 0} error.`
    : 'Acceptance has not been run yet.'
  return [
    'We are building a reusable one-person-company AI development workflow. Minecraft is only the first adapter.',
    'The workflow loop is requirement clarification, scope control, architecture design, generalization review, implementation, acceptance testing, log analysis, regression testing, context summary, and next plan.',
    'Generic workflow files live under workflow/. Real acceptance lives under acceptance/. The runner is generic; Minecraft behavior is in acceptance/adapters/minecraft.adapter.js and acceptance/cases/*.acceptance.js.',
    resultSummary,
    'Next work should run the Minecraft acceptance suite on a prepared server, then improve observability and fix the first failing behavior without bypassing natural language -> actionKey -> intent-to-task -> TaskManager -> Action Lock -> System/Action.'
  ].join(' ')
}

function verificationSummary(acceptance) {
  const counts = {}
  for (const result of acceptance?.results || []) {
    const level = result.verificationLevel || 'missing'
    counts[level] = (counts[level] || 0) + 1
  }
  const entries = Object.entries(counts)
  if (!entries.length) return '- None recorded.'
  return entries.map(([level, count]) => `- ${level}: ${count}`).join('\n')
}

function caseStatusSummary(acceptance) {
  const cases = acceptance?.results || []
  if (!cases.length) return '- None recorded.'
  return cases.map(result => {
    const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'none'
    return `- ${result.featureName}/${result.testName}: ${result.judgment}, verificationLevel=${result.verificationLevel || 'unknown'}, reason=${reason}`
  }).join('\n')
}

function renderRoleReviewReport(acceptance) {
  const summary = acceptanceSummary(acceptance)
  const cases = acceptance?.results || []
  const blocked = cases.filter(result => result.judgment === 'BLOCKED')
  const failed = cases.filter(result => result.judgment === 'FAIL')
  const errors = cases.filter(result => result.judgment === 'ERROR')
  const following = cases.find(result => result.featureName === 'following')

  return [
    '# Role Review Report',
    '',
    `- generatedAt: ${new Date().toISOString()}`,
    '- source: acceptance/reports/latest-report.json',
    `- acceptanceSummary: ${summary}`,
    '',
    roleSection('需求澄清员', [
      conclusion(acceptance
        ? `本轮需求应围绕最新验收状态推进：${summary}。`
        : '本轮缺少最新验收输入，需求澄清只能停留在报告框架层。'),
      evidence([
        acceptance ? `最新验收项目：${acceptance.projectName}。` : '未找到 acceptance/reports/latest-report.json。',
        following ? `following 当前 judgment=${following.judgment}，setupFailureReason=${following.setupFailureReason || 'none'}。` : '未找到 following case 结果。',
        following?.configuredAiUsername ? `configuredAiUsername=${following.configuredAiUsername}。` : null
      ]),
      nextSteps([
        following?.judgment === 'BLOCKED' ? '先补齐 following 的真实测试环境，再进入功能 PASS/FAIL 判断。' : null,
        '下一轮开始前明确本轮只解决一个最小可验收目标。'
      ])
    ]),
    roleSection('范围控制员', [
      conclusion('本轮范围应保持小步闭环：只处理报告和验收可观测性相关事项，不扩展新的业务能力。'),
      evidence([
        `BLOCKED=${blocked.length}，FAIL=${failed.length}，ERROR=${errors.length}。`,
        blocked.length ? `仍被环境阻塞的 case：${blocked.map(result => result.featureName).join(', ')}。` : '当前没有环境阻塞 case。',
        failed.length ? `真实功能失败 case：${failed.map(result => result.featureName).join(', ')}。` : '当前没有真实功能 FAIL。'
      ]),
      nextSteps([
        '若核心 case 仍 BLOCKED，不应继续扩大无关业务修复范围。',
        '只有当环境 READY 后，才把 FAIL 作为业务修复输入。'
      ])
    ]),
    roleSection('架构师', [
      conclusion('通用 runner 与项目 adapter 的分层仍然成立；角色报告属于 workflow 层产物，不进入 Minecraft adapter。'),
      evidence([
        '验收报告由 acceptance runner 标准化 judgment、证据和环境字段。',
        '项目细节仍在 adapter/cases/scenario-builder 内部。',
        'role-review-report.md 由 workflow:report 从标准 acceptance JSON 派生。'
      ]),
      nextSteps([
        '后续新增 Web/desktop adapter 时继续复用同一份角色报告生成逻辑。',
        '如需更精确的回归结论，可增加 machine-readable test report 输入。'
      ])
    ]),
    roleSection('通用化审查员', [
      conclusion('本轮报告逻辑应避免写死 Minecraft 单点结论，优先读取通用 judgment/setup/evidence 字段。'),
      evidence([
        'PASS/FAIL/BLOCKED/ERROR 是跨项目通用状态。',
        'setupFailureReason、evidence、nextSuggestion 可作为跨项目审查输入。',
        following?.companionLookup?.suggestion ? `项目适配层建议：${following.companionLookup.suggestion}` : null
      ]),
      nextSteps([
        '遇到具体 case 阻塞时，继续区分环境问题、配置问题、runner 异常和真实功能失败。',
        '遇到 count/batch 类问题时，必须审查同类任务是否存在同类缺陷。'
      ])
    ]),
    roleSection('程序员/Codex', [
      conclusion('本轮实现集中在 workflow 自动上下文管理和报告 schema，不扩展 Minecraft 业务功能。'),
      evidence([
        '实际改动应集中在 workflow/*.js、workflow 文档/模板、package.json 和 acceptance 报告字段。',
        'Minecraft adapter/cases 只应作为验收证据来源，不应绕过原始任务链路。'
      ]),
      nextSteps([
        '继续用小步提交方式维护 workflow 命令。',
        '若要改 acceptance 行为，先确认是否只是报告 schema，而不是业务动作逻辑。'
      ])
    ]),
    roleSection('测试员', [
      conclusion(acceptance ? `最新真实验收结果：${summary}。` : '尚无可用验收结果，无法形成测试结论。'),
      evidence(cases.length ? cases.map(result => {
        const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'none'
        return `${result.featureName}/${result.testName}: ${result.judgment}, verificationLevel=${result.verificationLevel || 'unknown'}, reason=${reason}`
      }) : ['未找到 case 结果。']),
      nextSteps([
        blocked.length ? '优先根据 BLOCKED 的 manualPreparation/setupFailureReason 准备环境后重跑验收。' : null,
        failed.length ? '对 FAIL case 进入日志分析和最小业务修复。' : null,
        errors.length ? '先修 runner/case 异常，再谈功能质量。' : null
      ])
    ]),
    roleSection('回归测试员', [
      conclusion('回归关注点是：workflow 报告生成不能破坏 acceptance 报告，也不能改变真实验收链路。'),
      evidence([
        acceptance ? 'latest-report.json 可读取，workflow:report 具备生成上下文报告的输入。' : '缺少 latest-report.json，workflow:report 应仍能输出“无验收输入”的结论。',
        'role-review-report.md 只读取报告数据，不触发项目行为。',
        '当前脚本未内置 npm test 结果解析，因此回归结论以验收报告和人工记录为准。'
      ]),
      nextSteps([
        '每轮修改 workflow 脚本后至少运行 npm run workflow:report。',
        '涉及 runner/adapter/case 时继续运行 npm run acceptance:minecraft 和 npm test。'
      ])
    ]),
    roleSection('日志分析员', [
      conclusion('日志和报告当前说明：验收阻塞来自真实游戏环境准备不足，不应被包装成 PASS。'),
      evidence([
        following ? `following setupFailureReason=${following.setupFailureReason || 'none'}。` : '未找到 following 结果。',
        following?.debugStatusAvailable === false ? 'debug_status 未观测到可用状态回复。' : null,
        following?.onlinePlayers ? `onlinePlayers=${formatPlayerNames(following.onlinePlayers)}。` : null
      ]),
      nextSteps([
        '下一轮真实验收前先确认 AI bot 在线、用户名精确匹配、与测试玩家同维度且可见。',
        '若日志出现真实 FAIL，再从 relatedLogs 和 evidence 中定位业务链路。'
      ])
    ]),
    roleSection('上下文管理员', [
      conclusion('本轮上下文应压缩为：通用工作流已具备角色化报告，最新阻塞仍来自真实环境而非业务 FAIL。'),
      evidence([
        acceptance ? compressedContext(acceptance) : '无验收上下文可压缩。',
        following ? `following: configuredAiUsername=${following.configuredAiUsername || 'unknown'}，onlinePlayers=${formatPlayerNames(following.onlinePlayers)}。` : null
      ]),
      nextSteps([
        '下一轮新对话可直接读取 workflow/reports/latest-workflow-report.md 与 workflow/reports/role-review-report.md。',
        '继续把“本轮目标、已改文件、验收结果、未完成事项、下一步建议”写入 workflow reports。'
      ])
    ])
  ].join('\n')
}

function roleSection(roleName, blocks) {
  return [`## ${roleName}`, '', ...blocks, ''].join('\n')
}

function conclusion(text) {
  return ['### 本轮结论', text || '暂无结论。', ''].join('\n')
}

function evidence(items) {
  const clean = items.filter(Boolean)
  return [
    '### 证据',
    ...(clean.length ? clean.map(item => `- ${item}`) : ['- 暂无证据。']),
    ''
  ].join('\n')
}

function nextSteps(items) {
  const clean = items.filter(Boolean)
  return [
    '### 下一步',
    ...(clean.length ? clean.map(item => `- ${item}`) : ['- 暂无下一步。']),
    ''
  ].join('\n')
}

function acceptanceSummary(acceptance) {
  if (!acceptance) return 'No completed acceptance run yet.'
  return `${acceptance.passCount || 0} PASS / ${acceptance.failCount || 0} FAIL / ${acceptance.blockedCount || 0} BLOCKED / ${acceptance.errorCount || 0} ERROR`
}

function formatPlayerNames(players = []) {
  if (!players.length) return 'none'
  return players.map(player => player.username).join(', ')
}

if (require.main === module) main()

module.exports = {
  renderRoleReviewReport,
  acceptanceSummary
}
