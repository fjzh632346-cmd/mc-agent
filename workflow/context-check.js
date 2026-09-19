const {
  exists,
  readText,
  readJson,
  writeReport,
  fileList,
  acceptanceReport,
  acceptanceSummary,
  caseSummary
} = require('./common')

const REQUIRED_CONTEXT = [
  'workflow/README.md',
  'workflow/rules.md',
  'workflow/config/project.config.json',
  'workflow/config/acceptance.config.json',
  'workflow/reports/latest-workflow-report.md',
  'workflow/reports/handoff-summary.md',
  'logs/acceptance-report.md',
  'acceptance/reports/latest-report.md',
  'package.json'
]

const TASK_RELATED_SOURCE = [
  'workflow/workflow-report.js',
  'acceptance/acceptance-runner.js',
  'acceptance/adapters/minecraft.adapter.js',
  'acceptance/cases/following.acceptance.js',
  'acceptance/cases/farming.acceptance.js',
  'acceptance/cases/storage.acceptance.js'
]

function main() {
  const filesRead = []
  const missingFiles = []
  const texts = {}

  for (const file of [...REQUIRED_CONTEXT, ...TASK_RELATED_SOURCE]) {
    if (!exists(file)) {
      missingFiles.push(file)
      continue
    }
    texts[file] = readText(file)
    filesRead.push(file)
  }

  const pkg = readJson('package.json')
  const acceptance = acceptanceReport()
  const config = readJson('workflow/config/acceptance.config.json')
  const confirmedFacts = []
  const uncertainItems = []
  const contradictions = []
  const currentBlockers = []
  const scripts = pkg?.scripts || {}

  if (scripts['workflow:report']) confirmedFacts.push('package.json exposes workflow:report.')
  if (scripts['acceptance:minecraft']) confirmedFacts.push('package.json exposes acceptance:minecraft.')
  for (const script of ['workflow:context-check', 'workflow:checkpoint', 'workflow:handoff', 'workflow:continue', 'workflow:role-report']) {
    if (scripts[script]) confirmedFacts.push(`package.json exposes ${script}.`)
    else contradictions.push(`package.json is missing ${script}.`)
  }

  if (config?.projects?.minecraft?.adapter) {
    confirmedFacts.push(`Minecraft acceptance adapter is configured as ${config.projects.minecraft.adapter}.`)
  } else {
    uncertainItems.push('Could not verify Minecraft adapter from workflow/config/acceptance.config.json.')
  }

  if (acceptance && !acceptance.__parseError) {
    confirmedFacts.push(`Latest acceptance summary: ${acceptanceSummary(acceptance)}.`)
    for (const result of acceptance.results || []) {
      confirmedFacts.push(caseSummary(result))
      if (result.judgment === 'BLOCKED') currentBlockers.push(caseSummary(result))
      if (result.judgment === 'PASS' && result.verificationLevel !== 'game_passed') {
        contradictions.push(`${result.featureName} is PASS but verificationLevel is ${result.verificationLevel || 'missing'}.`)
      }
    }
  } else {
    uncertainItems.push('No readable acceptance/reports/latest-report.json was found.')
  }

  if (texts['logs/acceptance-report.md'] && texts['acceptance/reports/latest-report.md']) {
    const legacyHasLevel = texts['logs/acceptance-report.md'].includes('verificationLevel')
    const latestHasLevel = texts['acceptance/reports/latest-report.md'].includes('verificationLevel')
    if (legacyHasLevel && latestHasLevel) confirmedFacts.push('Both acceptance markdown reports include verificationLevel.')
    else uncertainItems.push('Acceptance markdown reports do not both show verificationLevel yet; rerun acceptance if this field was just added.')
  }

  if (missingFiles.length) uncertainItems.push(`Missing optional or not-yet-created files: ${missingFiles.join(', ')}.`)
  if (!texts['workflow/reports/handoff-summary.md']) uncertainItems.push('handoff-summary.md is not yet available; run workflow:handoff before compact or new conversation.')
  if (!currentBlockers.length) currentBlockers.push('No active BLOCKED case found in latest acceptance report.')

  const report = [
    '# Context Check',
    '',
    `- generatedAt: ${new Date().toISOString()}`,
    '',
    '## confirmedFacts',
    fileList(confirmedFacts),
    '',
    '## uncertainItems',
    fileList(uncertainItems),
    '',
    '## contradictions',
    fileList(contradictions.length ? contradictions : ['No direct contradictions found.']),
    '',
    '## currentBlockers',
    fileList(currentBlockers),
    '',
    '## suggestedNextGoal',
    '- Keep the current round focused on workflow context management and verification-level reporting.',
    '',
    '## doNotModifyScope',
    fileList([
      'Do not add new Minecraft business features this round.',
      'Do not refactor TaskManager this round.',
      'Do not lower Minecraft real-game acceptance standards.'
    ]),
    '',
    '## filesRead',
    fileList(filesRead),
    '',
    '## filesNeedReview',
    fileList([
      'workflow/context-check.js',
      'workflow/handoff.js',
      'workflow/continue.js',
      'workflow/role-report.js',
      'acceptance/acceptance-runner.js',
      'acceptance/reports/latest-report.json'
    ])
  ].join('\n')

  const output = writeReport('workflow/reports/context-check.md', report)
  console.log(`[workflow] wrote ${output}`)
}

if (require.main === module) main()
