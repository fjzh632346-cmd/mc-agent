const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const reportsDir = path.join(rootDir, 'workflow', 'reports')

function rel(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/')
}

function abs(relativePath) {
  return path.join(rootDir, relativePath)
}

function exists(relativePath) {
  return fs.existsSync(abs(relativePath))
}

function readText(relativePath) {
  const filePath = abs(relativePath)
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, 'utf8')
}

function readJson(relativePath) {
  const text = readText(relativePath)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (err) {
    return { __parseError: err.message }
  }
}

function writeReport(relativePath, text) {
  const filePath = abs(relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${text.replace(/\s+$/u, '')}\n`, 'utf8')
  return filePath
}

function appendReport(relativePath, text) {
  const filePath = abs(relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${text.replace(/\s+$/u, '')}\n`, 'utf8')
  return filePath
}

function fileList(items) {
  return items.filter(Boolean).map(item => `- ${item}`).join('\n') || '- None'
}

function fieldList(object) {
  return Object.entries(object)
    .map(([key, value]) => `- ${key}: ${value == null || value === '' ? 'None' : value}`)
    .join('\n')
}

function acceptanceReport() {
  return readJson('acceptance/reports/latest-report.json')
}

function acceptanceSummary(acceptance = acceptanceReport()) {
  if (!acceptance || acceptance.__parseError) return 'No completed acceptance run.'
  return `${acceptance.passCount || 0} PASS / ${acceptance.failCount || 0} FAIL / ${acceptance.blockedCount || 0} BLOCKED / ${acceptance.errorCount || 0} ERROR`
}

function caseSummary(result) {
  const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'none'
  const level = result.verificationLevel || 'unknown'
  return `${result.featureName}/${result.testName}: ${result.judgment}, verificationLevel=${level}, reason=${reason}`
}

function currentBlockers(acceptance = acceptanceReport()) {
  if (!acceptance || acceptance.__parseError || !Array.isArray(acceptance.results)) return ['No readable acceptance result.']
  const blockers = acceptance.results
    .filter(result => result.judgment === 'BLOCKED')
    .map(caseSummary)
  return blockers.length ? blockers : ['No acceptance blockers recorded.']
}

function modifiedFilesGuess() {
  return [
    'package.json',
    'workflow/README.md',
    'workflow/rules.md',
    'workflow/common.js',
    'workflow/context-check.js',
    'workflow/checkpoint.js',
    'workflow/handoff.js',
    'workflow/continue.js',
    'workflow/role-report.js',
    'workflow/workflow-report.js',
    'workflow/templates/acceptance-report.template.md',
    'workflow/templates/regression-checklist.template.md',
    'workflow/reports/context-check.md',
    'workflow/reports/progress-log.md',
    'workflow/reports/handoff-summary.md',
    'workflow/reports/continue-plan.md',
    'workflow/reports/role-review-report.md',
    'acceptance/acceptance-runner.js'
  ]
}

module.exports = {
  rootDir,
  reportsDir,
  rel,
  abs,
  exists,
  readText,
  readJson,
  writeReport,
  appendReport,
  fileList,
  fieldList,
  acceptanceReport,
  acceptanceSummary,
  caseSummary,
  currentBlockers,
  modifiedFilesGuess
}
