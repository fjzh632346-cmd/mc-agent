const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const DEFAULT_CONFIG = path.join(rootDir, 'workflow', 'config', 'acceptance.config.json')
const STANDARD_FIELDS = [
  'projectName',
  'featureName',
  'testName',
  'commandOrInput',
  'preState',
  'postState',
  'observedBehavior',
  'expectedBehavior',
  'actualResult',
  'passOrFail',
  'verificationLevel',
  'setupStatus',
  'setupFailureReason',
  'startupConfig',
  'configuredAiUsername',
  'configuredTestUsername',
  'acceptancePlayerUsername',
  'onlinePlayers',
  'acceptancePlayerPosition',
  'companionPosition',
  'companionPositionSource',
  'companionPositionFromDebug',
  'configuredAiOnline',
  'configuredAiVisible',
  'distancePlayerToAi',
  'recommendedTeleportCommand',
  'companionLookup',
  'debugStatusAvailable',
  'debugStatusPossibleReason',
  'nearbyBlocksSummary',
  'nearbyEntitiesSummary',
  'fixtureStatus',
  'judgment',
  'failureReason',
  'evidence',
  'relatedLogs',
  'regressionRisk',
  'nextSuggestion'
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = path.resolve(rootDir, args.config || DEFAULT_CONFIG)
  const config = readJson(configPath)
  const projectName = args.project || config.defaultProject
  const project = config.projects?.[projectName]
  if (!project) throw new Error(`Unknown acceptance project: ${projectName}`)

  const adapterPath = path.resolve(rootDir, project.adapter)
  const Adapter = require(adapterPath)
  const adapter = new Adapter({
    rootDir,
    projectName,
    projectConfig: project,
    runnerConfig: config,
    args
  })

  const startedAt = new Date()
  const results = []
  let setupOk = false

  try {
    await adapter.setup()
    setupOk = true

    const selectedCases = selectCases(project.cases || [], args.cases)
    for (const casePath of selectedCases) {
      const absolute = path.resolve(rootDir, casePath)
      const acceptanceCase = require(absolute)
      const caseResults = await runCase(acceptanceCase, adapter, project, config)
      results.push(...caseResults)
    }
  } catch (err) {
    results.push(createRecord({
      projectName,
      featureName: setupOk ? 'acceptance' : 'environment',
      testName: setupOk ? 'acceptance-runner' : 'adapter-setup',
      commandOrInput: args.cases || 'all configured cases',
      preState: null,
      postState: null,
      observedBehavior: setupOk ? 'Acceptance runner failed while executing cases.' : 'Adapter setup failed before cases could run.',
      expectedBehavior: 'The adapter should connect to the real test environment and execute configured cases.',
      actualResult: 'not_executed',
      passOrFail: setupOk ? 'ERROR' : 'BLOCKED',
      judgment: setupOk ? 'ERROR' : 'BLOCKED',
      setupStatus: setupOk ? 'ERROR' : 'BLOCKED',
      setupFailureReason: err.message,
      failureReason: err.stack || err.message,
      evidence: { setupOk },
      relatedLogs: [],
      regressionRisk: 'Acceptance cannot protect behavior until the real environment is available.',
      nextSuggestion: 'Prepare the required server/configuration and rerun the acceptance command.'
    }))
  } finally {
    await holdForManualFollowingSetup(results, config, args).catch(err => {
      console.warn(`[acceptance] hold skipped: ${err.message}`)
    })
    await adapter.teardown().catch(() => {})
  }

  const report = {
    projectName,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passCount: results.filter(result => result.judgment === 'PASS').length,
    failCount: results.filter(result => result.judgment === 'FAIL').length,
    blockedCount: results.filter(result => result.judgment === 'BLOCKED').length,
    errorCount: results.filter(result => result.judgment === 'ERROR').length,
    results
  }

  const reportPaths = writeReports(report, config, args)
  const failed = report.failCount > 0 || report.errorCount > 0 || report.blockedCount > 0
  console.log(`[acceptance] wrote ${reportPaths.mdPath}`)
  console.log(`[acceptance] summary ${report.passCount} PASS / ${report.failCount} FAIL / ${report.blockedCount} BLOCKED / ${report.errorCount} ERROR`)
  for (const result of report.results) {
    const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'none'
    console.log(`[acceptance] ${result.featureName}: ${result.judgment} reason=${reason} distance=${result.distancePlayerToAi ?? 'unknown'} source=${result.companionPositionSource || 'none'}`)
  }
  process.exit(failed ? 1 : 0)
}

async function holdForManualFollowingSetup(results = [], config = {}, args = {}) {
  const hold = findManualHoldRequest(results, config, args)
  if (!hold) return

  console.log(`[acceptance] following setup is BLOCKED: ${hold.reason}`)
  console.log(`[acceptance] recommendedTeleportCommand: ${hold.recommendedTeleportCommand}`)
  console.log(`[acceptance] holding acceptance player online for ${hold.seconds}s before teardown`)
  await sleep(hold.seconds * 1000)
}

function findManualHoldRequest(results = [], config = {}, args = {}) {
  const result = results.find(result => {
    const reason = result.setupFailureReason || result.failureReason || result.actualResult
    return result.featureName === 'following' &&
      result.judgment === 'BLOCKED' &&
      ['configured_ai_online_but_not_visible', 'ai_too_far_for_following_test'].includes(reason)
  })
  if (!result) return null

  const seconds = holdOpenSeconds(config, args)
  if (seconds <= 0) return null

  return {
    seconds,
    reason: result.setupFailureReason || result.failureReason || result.actualResult,
    recommendedTeleportCommand: result.recommendedTeleportCommand ||
      result.fixtureStatus?.recommendedTeleportCommand ||
      result.companionLookup?.recommendedTeleportCommand ||
      '/tp <AI_USERNAME> <ACCEPTANCE_TEST_USERNAME>'
  }
}

function holdOpenSeconds(config = {}, args = {}) {
  const value = args.holdOpenSeconds ??
    process.env.ACCEPTANCE_HOLD_OPEN_SECONDS ??
    config.holdOpenSeconds ??
    25
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return 25
  return Math.min(Math.floor(seconds), 300)
}

async function runCase(acceptanceCase, adapter, project, config) {
  try {
    if (acceptanceCase.setup || acceptanceCase.execute || acceptanceCase.assert || acceptanceCase.report) {
      const ctx = {
        adapter,
        projectConfig: project,
        acceptanceConfig: config,
        createRecord,
        setupData: null,
        executionData: null,
        assertionData: null
      }
      ctx.setupData = acceptanceCase.setup ? await acceptanceCase.setup(ctx) : {}
      ctx.executionData = acceptanceCase.execute ? await acceptanceCase.execute(ctx) : {}
      ctx.assertionData = acceptanceCase.assert ? await acceptanceCase.assert(ctx) : {}
      const output = acceptanceCase.report ? await acceptanceCase.report(ctx) : ctx.assertionData
      return Array.isArray(output) ? output.map(createRecord) : [createRecord(output)]
    }

    const output = await acceptanceCase.run({
      adapter,
      projectConfig: project,
      acceptanceConfig: config,
      createRecord
    })
    return Array.isArray(output) ? output.map(createRecord) : [createRecord(output)]
  } catch (err) {
    return [createRecord({
      projectName: adapter.displayProjectName(),
      featureName: acceptanceCase.featureName || 'unknown',
      testName: acceptanceCase.testName || acceptanceCase.name || 'unnamed acceptance case',
      commandOrInput: acceptanceCase.commandOrInput || '',
      preState: null,
      postState: null,
      observedBehavior: 'Acceptance case threw an exception.',
      expectedBehavior: 'Acceptance case should complete and return normalized evidence.',
      actualResult: 'case_exception',
      passOrFail: 'ERROR',
      judgment: 'ERROR',
      setupStatus: 'ERROR',
      failureReason: err.stack || err.message,
      evidence: {},
      relatedLogs: [],
      regressionRisk: 'The feature is not protected by this case until the exception is fixed.',
      nextSuggestion: 'Fix the acceptance case or adapter method that threw.'
    })]
  }
}

function createRecord(input = {}) {
  const record = {}
  for (const field of STANDARD_FIELDS) record[field] = input[field] ?? defaultValue(field)
  record.judgment = normalizeJudgment(input.judgment || input.passOrFail)
  record.passOrFail = record.judgment
  record.verificationLevel = normalizeVerificationLevel(input.verificationLevel || inferVerificationLevel(record))
  return record
}

function defaultValue(field) {
  if (['preState', 'postState', 'evidence'].includes(field)) return {}
  if (field === 'relatedLogs') return []
  if (field === 'failureReason') return null
  if (field === 'setupFailureReason') return null
  if (['acceptancePlayerPosition', 'companionPosition', 'distancePlayerToAi', 'recommendedTeleportCommand', 'companionLookup'].includes(field)) return null
  if (field === 'companionPositionSource') return 'none'
  if (field === 'companionPositionFromDebug') return false
  if (field === 'onlinePlayers') return []
  if (field === 'debugStatusPossibleReason') return []
  if (['startupConfig', 'nearbyBlocksSummary', 'fixtureStatus'].includes(field)) return {}
  if (['configuredAiOnline', 'configuredAiVisible', 'debugStatusAvailable'].includes(field)) return false
  if (field === 'verificationLevel') return 'code_only'
  if (field === 'judgment' || field === 'passOrFail') return 'ERROR'
  return ''
}

function normalizeJudgment(value) {
  const text = String(value || '').toUpperCase()
  if (['PASS', 'FAIL', 'BLOCKED', 'ERROR'].includes(text)) return text
  return 'ERROR'
}

function inferVerificationLevel(record) {
  if (record.judgment === 'PASS') return 'game_passed'
  if (record.judgment === 'FAIL') return 'game_observed'
  if (record.judgment === 'BLOCKED') return 'game_blocked'
  return 'code_only'
}

function normalizeVerificationLevel(value) {
  const text = String(value || '').toLowerCase()
  if (['code_only', 'simulated', 'game_blocked', 'game_observed', 'game_passed'].includes(text)) return text
  return 'code_only'
}

function writeReports(report, config, args = {}) {
  const mdPath = path.resolve(rootDir, args.reportPath || config.reportPath || 'acceptance/reports/latest-report.md')
  const jsonPath = path.resolve(rootDir, args.jsonReportPath || config.jsonReportPath || 'acceptance/reports/latest-report.json')
  const summaryPath = path.resolve(rootDir, args.summaryReportPath || config.summaryReportPath || 'acceptance/reports/latest-summary.md')
  const legacyMdPath = legacyReportPath(config, args)
  fs.mkdirSync(path.dirname(mdPath), { recursive: true })
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(jsonPath, `${stringifyJsonReport(report)}\n`, 'utf8')
  const markdown = renderMarkdown(report)
  const summary = renderSummary(report)
  fs.writeFileSync(mdPath, markdown, 'utf8')
  fs.writeFileSync(summaryPath, summary, 'utf8')
  if (legacyMdPath) {
    fs.mkdirSync(path.dirname(legacyMdPath), { recursive: true })
    fs.writeFileSync(legacyMdPath, markdown, 'utf8')
  }
  return { mdPath, jsonPath, summaryPath, legacyMdPath }
}

function legacyReportPath(config = {}, args = {}) {
  const value = args.legacyReportPath ?? config.legacyReportPath
  if (!value || value === 'none' || value === 'false') return null
  return path.resolve(rootDir, value)
}

function renderMarkdown(report) {
  const lines = [
    '# Acceptance Report',
    '',
    '## Summary',
    '',
    `- projectName: ${report.projectName}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    `- passCount: ${report.passCount}`,
    `- failCount: ${report.failCount}`,
    `- blockedCount: ${report.blockedCount}`,
    `- errorCount: ${report.errorCount}`,
    ''
  ]

  report.results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${escapeMd(result.featureName)} / ${escapeMd(result.testName)}`)
    for (const field of STANDARD_FIELDS) {
      lines.push(`### ${field}`)
      lines.push(formatValue(result[field]))
      lines.push('')
    }
  })

  return `${lines.join('\n')}\n`
}

function renderSummary(report) {
  const lines = [
    '# Acceptance Summary',
    '',
    `- projectName: ${report.projectName}`,
    `- result: ${report.passCount} PASS / ${report.failCount} FAIL / ${report.blockedCount} BLOCKED / ${report.errorCount} ERROR`,
    `- finishedAt: ${report.finishedAt}`,
    '',
    '## Cases'
  ]

  for (const result of report.results || []) {
    lines.push('')
    lines.push(`### ${escapeMd(result.featureName)} / ${escapeMd(result.testName)}`)
    lines.push(`- judgment: ${result.judgment}`)
    lines.push(`- reason: ${escapeMd(result.setupFailureReason || result.failureReason || result.actualResult || 'none')}`)
    lines.push(`- acceptancePlayerPosition: ${formatInline(result.acceptancePlayerPosition || null)}`)
    lines.push(`- companionPosition: ${formatInline(result.companionPosition || null)}`)
    lines.push(`- companionPositionSource: ${result.companionPositionSource || 'none'}`)
    lines.push(`- companionPositionFromDebug: ${Boolean(result.companionPositionFromDebug)}`)
    lines.push(`- distancePlayerToAi: ${result.distancePlayerToAi ?? 'None'}`)
    lines.push(`- recommendedTeleportCommand: ${result.recommendedTeleportCommand || 'None'}`)
  }

  return `${lines.join('\n')}\n`
}

function formatValue(value) {
  if (value == null || value === '') return '_None_'
  if (Array.isArray(value)) {
    if (!value.length) return '_None_'
    return value.map(item => `- ${escapeMd(formatInline(item))}`).join('\n')
  }
  if (typeof value === 'object') return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
  return escapeMd(String(value))
}

function formatInline(value) {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function stringifyJsonReport(report) {
  return JSON.stringify(report, null, 2).replace(/[^\x00-\x7F]/g, char => {
    const code = char.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${code}`
  })
}

function selectCases(cases, caseArg) {
  if (!caseArg) return cases
  const wanted = new Set(String(caseArg).split(',').map(item => item.trim()).filter(Boolean))
  return cases.filter(casePath => wanted.has(path.basename(casePath).replace('.acceptance.js', '')) || wanted.has(path.basename(casePath)))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function parseArgs(argv) {
  const args = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const [key, ...rest] = arg.slice(2).split('=')
    args[key] = rest.length ? rest.join('=') : true
  }
  return args
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function escapeMd(text) {
  return String(text).replace(/\|/g, '\\|')
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = {
  createRecord,
  findManualHoldRequest,
  renderMarkdown,
  renderSummary,
  stringifyJsonReport
}
