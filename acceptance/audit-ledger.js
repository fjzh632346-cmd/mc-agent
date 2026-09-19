const fs = require('fs')
const path = require('path')

const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT_DIR, 'workflow/config/acceptance.config.json')
const LATEST_REPORT_PATH = path.join(ROOT_DIR, 'acceptance/reports/latest-report.json')
const LEDGER_JSON_PATH = path.join(ROOT_DIR, 'acceptance/reports/latest-audit-ledger.json')
const LEDGER_MD_PATH = path.join(ROOT_DIR, 'acceptance/reports/latest-audit-ledger.md')

const VALID_LATEST_JUDGMENTS = new Set(['PASS', 'FAIL', 'BLOCKED', 'ERROR'])

function main() {
  const config = readJson(CONFIG_PATH)
  const projectName = config.defaultProject || 'minecraft'
  const project = config.projects?.[projectName]
  if (!project) throw new Error(`Project not found in acceptance config: ${projectName}`)

  const latestReport = readJson(LATEST_REPORT_PATH)
  const universe = buildUniverse(project.cases || [])
  const latestByKey = latestResultMap(latestReport.results || [])
  const entries = universe.map(entry => mergeLatestResult(entry, latestByKey.get(entry.ledgerKey)))

  const ledger = {
    generatedAt: new Date().toISOString(),
    projectName,
    sources: {
      configPath: relativePath(CONFIG_PATH),
      caseDefinitionPaths: (project.cases || []).map(normalizePath),
      latestReportPath: relativePath(LATEST_REPORT_PATH)
    },
    latestExecutedSummary: summarizeLatestExecuted(latestReport),
    caseUniverseSummary: summarizeUniverse(universe),
    auditLedgerSummary: summarizeLedger(entries),
    entries
  }

  fs.writeFileSync(LEDGER_JSON_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  fs.writeFileSync(LEDGER_MD_PATH, renderMarkdown(ledger), 'utf8')

  console.log(`[acceptance:audit] universe=${ledger.caseUniverseSummary.total}`)
  console.log(`[acceptance:audit] latestExecuted=${ledger.latestExecutedSummary.total}`)
  console.log(`[acceptance:audit] finalLedgerStatus=${formatCounts(ledger.auditLedgerSummary.finalLedgerStatusCounts)}`)
  console.log(`[acceptance:audit] latestExecutionStatus=${formatCounts(ledger.auditLedgerSummary.latestExecutionStatusCounts)}`)
  console.log(`[acceptance:audit] wrote ${relativePath(LEDGER_JSON_PATH)}`)
  console.log(`[acceptance:audit] wrote ${relativePath(LEDGER_MD_PATH)}`)
}

function buildUniverse(casePaths) {
  return casePaths.flatMap(casePath => {
    const absolutePath = path.resolve(ROOT_DIR, casePath)
    const source = fs.readFileSync(absolutePath, 'utf8')
    const featureName = extractFeatureName(source, casePath)
    const scenarios = extractScenarioEntries(source)
    const entries = scenarios.length > 0
      ? scenarios
      : [extractSingleCaseEntry(source, casePath)]

    return entries.map((entry, index) => ({
      ledgerIndex: null,
      projectCasePath: normalizePath(casePath),
      featureName,
      scenarioId: entry.scenarioId || null,
      testName: entry.testName,
      universeSource: scenarios.length > 0 ? 'scenario_definition' : 'case_definition',
      universeOrder: index + 1,
      ledgerCaseId: ledgerKey(featureName, entry.testName),
      ledgerKey: ledgerKey(featureName, entry.testName)
    }))
  }).map((entry, index) => ({
    ...entry,
    ledgerIndex: index + 1
  }))
}

function extractFeatureName(source, casePath) {
  const constFeature = source.match(/\bconst\s+FEATURE\s*=\s*'([^']+)'/)
  if (constFeature) return constFeature[1]

  const directFeature = source.match(/featureName\s*:\s*'([^']+)'/)
  if (directFeature) return directFeature[1]

  throw new Error(`Unable to extract featureName from ${casePath}`)
}

function extractScenarioEntries(source) {
  const beforeExports = source.split('module.exports')[0] || source
  const entries = []
  const scenarioRegex = /{\s*id\s*:\s*'([^']+)'[\s\S]*?testName\s*:\s*'([^']+)'/g
  let match

  while ((match = scenarioRegex.exec(beforeExports)) !== null) {
    entries.push({
      scenarioId: decodeJsSingleQuoted(match[1]),
      testName: decodeJsSingleQuoted(match[2])
    })
  }

  return entries
}

function extractSingleCaseEntry(source, casePath) {
  const afterExports = source.slice(source.indexOf('module.exports'))
  const testName = afterExports.match(/testName\s*:\s*'([^']+)'/)
  if (!testName) throw new Error(`Unable to extract top-level testName from ${casePath}`)
  return {
    scenarioId: null,
    testName: decodeJsSingleQuoted(testName[1])
  }
}

function latestResultMap(results) {
  const map = new Map()
  for (const result of results) {
    const key = ledgerKey(result.featureName, result.testName)
    if (!map.has(key)) map.set(key, result)
  }
  return map
}

function mergeLatestResult(entry, latestResult) {
  const latestJudgment = normalizeJudgment(latestResult?.judgment || latestResult?.passOrFail)
  if (latestResult && VALID_LATEST_JUDGMENTS.has(latestJudgment)) {
    return {
      ...entry,
      latestExecutionStatus: 'REPORTED',
      latestJudgment,
      finalLedgerStatus: latestJudgment,
      reason: latestReason(latestResult),
      verificationLevel: latestResult.verificationLevel || null,
      latestActualResult: latestResult.actualResult || null,
      latestSetupStatus: latestResult.setupStatus || null,
      latestSetupFailureReason: latestResult.setupFailureReason || null
    }
  }

  return {
    ...entry,
    latestExecutionStatus: 'NOT_REPORTED',
    latestJudgment: null,
    finalLedgerStatus: 'UNVERIFIED',
    reason: 'not_reported_in_latest_report',
    verificationLevel: null,
    latestActualResult: null,
    latestSetupStatus: null,
    latestSetupFailureReason: null
  }
}

function latestReason(result) {
  return result.failureReason
    || result.actualResult
    || result.setupFailureReason
    || result.observedBehavior
    || 'reported_in_latest_report'
}

function summarizeLatestExecuted(report) {
  const results = report.results || []
  return {
    total: results.length,
    passCount: Number(report.passCount || 0),
    failCount: Number(report.failCount || 0),
    blockedCount: Number(report.blockedCount || 0),
    errorCount: Number(report.errorCount || 0),
    startedAt: report.startedAt || null,
    finishedAt: report.finishedAt || null,
    statusCounts: countBy(results, result => normalizeJudgment(result.judgment || result.passOrFail) || 'UNKNOWN'),
    featureCounts: countBy(results, result => result.featureName || 'unknown')
  }
}

function summarizeUniverse(universe) {
  return {
    total: universe.length,
    featureCounts: countBy(universe, entry => entry.featureName)
  }
}

function summarizeLedger(entries) {
  return {
    total: entries.length,
    finalLedgerStatusCounts: countBy(entries, entry => entry.finalLedgerStatus),
    latestExecutionStatusCounts: countBy(entries, entry => entry.latestExecutionStatus),
    featureStatusCounts: featureStatusCounts(entries)
  }
}

function featureStatusCounts(entries) {
  const summary = {}
  for (const entry of entries) {
    if (!summary[entry.featureName]) {
      summary[entry.featureName] = {
        total: 0,
        finalLedgerStatusCounts: {},
        latestExecutionStatusCounts: {}
      }
    }
    const feature = summary[entry.featureName]
    feature.total += 1
    feature.finalLedgerStatusCounts[entry.finalLedgerStatus] = (feature.finalLedgerStatusCounts[entry.finalLedgerStatus] || 0) + 1
    feature.latestExecutionStatusCounts[entry.latestExecutionStatus] = (feature.latestExecutionStatusCounts[entry.latestExecutionStatus] || 0) + 1
  }
  return summary
}

function renderMarkdown(ledger) {
  const lines = [
    '# Latest Acceptance Audit Ledger',
    '',
    `- generatedAt: ${ledger.generatedAt}`,
    `- projectName: ${ledger.projectName}`,
    '',
    '## latest executed summary',
    '',
    `- total: ${ledger.latestExecutedSummary.total}`,
    `- result: ${ledger.latestExecutedSummary.passCount} PASS / ${ledger.latestExecutedSummary.failCount} FAIL / ${ledger.latestExecutedSummary.blockedCount} BLOCKED / ${ledger.latestExecutedSummary.errorCount} ERROR`,
    `- startedAt: ${ledger.latestExecutedSummary.startedAt || 'UNKNOWN'}`,
    `- finishedAt: ${ledger.latestExecutedSummary.finishedAt || 'UNKNOWN'}`,
    `- statusCounts: ${formatCounts(ledger.latestExecutedSummary.statusCounts)}`,
    `- featureCounts: ${formatCounts(ledger.latestExecutedSummary.featureCounts)}`,
    '',
    '## case universe summary',
    '',
    `- total: ${ledger.caseUniverseSummary.total}`,
    `- featureCounts: ${formatCounts(ledger.caseUniverseSummary.featureCounts)}`,
    '',
    '## audit ledger summary',
    '',
    `- total: ${ledger.auditLedgerSummary.total}`,
    `- finalLedgerStatusCounts: ${formatCounts(ledger.auditLedgerSummary.finalLedgerStatusCounts)}`,
    `- latestExecutionStatusCounts: ${formatCounts(ledger.auditLedgerSummary.latestExecutionStatusCounts)}`,
    '',
    '### Feature Ledger Summary',
    '',
    '| feature | universe | finalLedgerStatusCounts | latestExecutionStatusCounts |',
    '| --- | ---: | --- | --- |'
  ]

  for (const featureName of Object.keys(ledger.auditLedgerSummary.featureStatusCounts).sort()) {
    const summary = ledger.auditLedgerSummary.featureStatusCounts[featureName]
    lines.push(`| ${featureName} | ${summary.total} | ${formatCounts(summary.finalLedgerStatusCounts)} | ${formatCounts(summary.latestExecutionStatusCounts)} |`)
  }

  lines.push(
    '',
    '## Ledger Entries',
    '',
    '| # | feature | testName | latestExecutionStatus | latestJudgment | finalLedgerStatus | reason |',
    '| ---: | --- | --- | --- | --- | --- | --- |'
  )

  for (const entry of ledger.entries) {
    lines.push(`| ${entry.ledgerIndex} | ${entry.featureName} | ${escapeMarkdownCell(entry.testName)} | ${entry.latestExecutionStatus} | ${entry.latestJudgment || ''} | ${entry.finalLedgerStatus} | ${escapeMarkdownCell(entry.reason)} |`)
  }

  lines.push('')
  return lines.join('\n')
}

function countBy(items, getKey) {
  const counts = {}
  for (const item of items) {
    const key = getKey(item)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function formatCounts(counts) {
  const keys = Object.keys(counts || {}).sort()
  if (keys.length === 0) return 'none'
  return keys.map(key => `${key}=${counts[key]}`).join(', ')
}

function ledgerKey(featureName, testName) {
  return `${String(featureName || '').trim()}::${String(testName || '').trim()}`
}

function normalizeJudgment(value) {
  return value == null ? null : String(value).toUpperCase()
}

function decodeJsSingleQuoted(value) {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function escapeMarkdownCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/')
}

function relativePath(filePath) {
  return normalizePath(path.relative(ROOT_DIR, filePath))
}

if (require.main === module) {
  main()
}

module.exports = {
  buildUniverse,
  extractScenarioEntries,
  summarizeLedger
}
