const fs = require('fs')
const path = require('path')
const { renderSummary } = require('./acceptance-runner')

const rootDir = path.resolve(__dirname, '..')
const reportPath = path.join(rootDir, 'acceptance', 'reports', 'latest-report.json')
const summaryPath = path.join(rootDir, 'acceptance', 'reports', 'latest-summary.md')

function main() {
  if (!fs.existsSync(reportPath)) {
    console.log('[acceptance] no latest-report.json found')
    process.exit(1)
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const summary = renderSummary(report)
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, summary, 'utf8')

  console.log(`[acceptance] wrote ${summaryPath}`)
  console.log(`[acceptance] summary ${report.passCount || 0} PASS / ${report.failCount || 0} FAIL / ${report.blockedCount || 0} BLOCKED / ${report.errorCount || 0} ERROR`)
  for (const result of report.results || []) {
    const reason = result.setupFailureReason || result.failureReason || result.actualResult || 'none'
    console.log(`[acceptance] ${result.featureName}: ${result.judgment} reason=${reason} distance=${result.distancePlayerToAi ?? 'unknown'} source=${result.companionPositionSource || 'none'}`)
  }
}

if (require.main === module) main()
