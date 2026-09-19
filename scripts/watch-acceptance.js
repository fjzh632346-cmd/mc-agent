const fs = require('fs')
const path = require('path')

const RULE_MODULES = [
  require('../rules/core'),
  require('../rules/follow'),
  require('../rules/storage'),
  require('../rules/farming'),
  require('../rules/food'),
  require('../rules/exploration'),
  require('../rules/survival')
]

const rootDir = path.resolve(__dirname, '..')
const logsDir = path.join(rootDir, 'logs')
const logPath = process.argv[2] || path.join(logsDir, 'bot-current.log')
const reportPath = path.join(logsDir, 'acceptance-report.md')

fs.mkdirSync(logsDir, { recursive: true })

const startedAt = new Date()
const issues = []
const issueKeys = new Set()
const recentLines = []
const rules = RULE_MODULES.flatMap(moduleRule => moduleRule.createRules())

const context = {
  addIssue(issue) {
    const key = issue.key || `${issue.module}:${issue.title}:${issue.evidence?.join('|')}`
    if (issueKeys.has(key)) return
    issueKeys.add(key)
    const normalized = {
      module: issue.module,
      title: issue.title,
      time: issue.time || new Date().toISOString(),
      evidence: issue.evidence || recentLines.slice(-5),
      likelyCause: issue.likelyCause || 'Unknown from current log pattern.',
      suggestedFix: issue.suggestedFix || 'Inspect the related module and add a targeted fix.',
      key
    }
    issues.push(normalized)
    console.log(`[ACCEPTANCE_ISSUE] module=${normalized.module} title=${normalized.title}`)
    writeReport()
  },
  recentLines(count = 5) {
    return recentLines.slice(-count)
  }
}

let position = 0
let partial = ''

console.log(`[AcceptanceWatch] watching ${logPath}`)
console.log(`[AcceptanceWatch] report ${reportPath}`)
writeReport()

function poll() {
  if (!fs.existsSync(logPath)) return

  const stat = fs.statSync(logPath)
  if (stat.size < position) {
    position = 0
    partial = ''
  }
  if (stat.size === position) return

  const stream = fs.createReadStream(logPath, {
    encoding: 'utf8',
    start: position,
    end: stat.size - 1
  })
  position = stat.size

  stream.on('data', chunk => {
    const combined = partial + chunk
    const lines = combined.split(/\r?\n/)
    partial = lines.pop() || ''
    for (const line of lines) processLine(line)
  })
}

function processLine(line) {
  if (!line) return
  recentLines.push(line)
  if (recentLines.length > 200) recentLines.shift()

  for (const rule of rules) {
    try {
      rule.onLine(line, context)
    } catch (err) {
      context.addIssue({
        module: rule.module || 'core',
        title: `Acceptance rule failed: ${rule.id}`,
        evidence: [line, err.stack || err.message],
        likelyCause: 'The watcher rule threw while analyzing logs.',
        suggestedFix: 'Fix the watcher rule implementation; do not change bot behavior based on this alone.',
        key: `watcher-rule-failed:${rule.id}:${err.message}`
      })
    }
  }
}

function writeReport() {
  const moduleCounts = countByModule()
  const lines = [
    '# Acceptance Watch Report',
    '',
    '## Summary',
    `- Test started: ${startedAt.toISOString()}`,
    `- Last updated: ${new Date().toISOString()}`,
    `- Issues detected: ${issues.length}`,
    `- Modules: ${formatModuleCounts(moduleCounts)}`,
    '',
    '## Detected Issues',
    ''
  ]

  if (!issues.length) {
    lines.push('No known issue detected by log patterns.', '')
  } else {
    issues.forEach((issue, index) => {
      lines.push(`### ${index + 1}. ${issue.title}`)
      lines.push(`- module=${issue.module}`)
      lines.push(`- Time: ${issue.time}`)
      lines.push('- Evidence:')
      for (const evidence of issue.evidence) lines.push(`  - ${escapeMarkdown(evidence)}`)
      lines.push(`- Likely cause: ${issue.likelyCause}`)
      lines.push(`- Suggested fix: ${issue.suggestedFix}`)
      lines.push('')
    })
  }

  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8')
}

function countByModule() {
  return issues.reduce((counts, issue) => {
    counts[issue.module] = (counts[issue.module] || 0) + 1
    return counts
  }, {})
}

function formatModuleCounts(counts) {
  const modules = ['core', 'follow', 'storage', 'farming', 'food', 'exploration', 'survival']
  const parts = modules.map(module => `${module}=${counts[module] || 0}`)
  return parts.join(', ')
}

function escapeMarkdown(text) {
  return String(text).replace(/\|/g, '\\|')
}

const timer = setInterval(poll, 500)
const reportTimer = setInterval(writeReport, 5000)
poll()

function shutdown() {
  clearInterval(timer)
  clearInterval(reportTimer)
  writeReport()
  console.log(`[AcceptanceWatch] final report written to ${reportPath}`)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
