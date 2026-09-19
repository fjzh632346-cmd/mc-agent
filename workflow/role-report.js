const { readJson, writeReport } = require('./common')
const { renderRoleReviewReport } = require('./workflow-report')

function main() {
  const acceptance = readJson('acceptance/reports/latest-report.json')
  const output = writeReport('workflow/reports/role-review-report.md', renderRoleReviewReport(acceptance?.__parseError ? null : acceptance))
  console.log(`[workflow] wrote ${output}`)
}

if (require.main === module) main()
