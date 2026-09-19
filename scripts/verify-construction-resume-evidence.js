const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { ConstructionRunStore, stableStringify } = require('../systems/construction-run-store')

function verifyConstructionResumeEvidence(run, criteria = {}) {
  const failures = []
  if (!run) {
    return {
      ok: false,
      failures: ['run_not_found'],
      resumeCount: 0,
      formalResumeCount: 0,
      evidence: {}
    }
  }

  compareExpected(failures, 'run_id', run.runId, criteria.runId)
  compareExpected(failures, 'blueprint_id', run.blueprintId, criteria.blueprintId)
  compareExpected(failures, 'blueprint_hash', run.blueprintHash, criteria.blueprintHash)
  compareExpected(failures, 'plan_id', run.planId, criteria.planId)
  compareExpected(failures, 'dimension', run.world?.dimension, criteria.dimension)
  compareExpected(failures, 'world_id', run.world?.worldId, criteria.worldId)
  if (criteria.origin) compareExpected(failures, 'origin', run.placementContext?.origin, criteria.origin)

  const history = Array.isArray(run.resumeHistory) ? run.resumeHistory : []
  const formal = history.filter(event => event?.outcome === 'prepared' && event.resumeOnly === true)
  const minResumes = positiveInteger(criteria.minResumes, 3)
  if (formal.length < minResumes) {
    failures.push(`formal_resume_count_below_min:${formal.length}/${minResumes}`)
  }

  const eventIds = new Set()
  let previousSequence = 0
  const reconciledWorkSetSequences = []
  for (const event of formal) {
    if (!event.eventId || eventIds.has(event.eventId)) failures.push(`duplicate_or_missing_event_id:${event.sequence || 'unknown'}`)
    if (event.eventId) eventIds.add(event.eventId)
    if (!Number.isInteger(event.sequence) || event.sequence <= previousSequence) {
      failures.push(`resume_sequence_not_strictly_increasing:${event.sequence || 'unknown'}`)
    }
    previousSequence = Number(event.sequence) || previousSequence
    verifyEventInvariants(failures, run, event)
    if (verifyCheckpointShape(failures, event)) {
      reconciledWorkSetSequences.push(event.sequence)
    }
  }

  const processRestart = formal.find(event => event.processRestarted === true) || null
  const lanPortChange = formal.find(event => event.lanPortChanged === true) || null
  const legacyLanTransition = criteria.legacyLanTransition || null
  if (legacyLanTransition?.attempted === true && legacyLanTransition.valid !== true) {
    for (const failure of legacyLanTransition.failures || ['unknown']) {
      failures.push(`legacy_lan_transition_invalid:${failure}`)
    }
  }
  const lateMin = finiteNumber(criteria.lateMin, 70)
  const lateMax = finiteNumber(criteria.lateMax, 90)
  const lateResume = formal.find(event => checkpointPercent(event.checkpointBefore) >= lateMin && checkpointPercent(event.checkpointBefore) <= lateMax) || null

  if (criteria.requireProcessRestart !== false && !processRestart) failures.push('process_restart_resume_missing')
  if (criteria.requireLanPortChange !== false && !lanPortChange && legacyLanTransition?.valid !== true) {
    failures.push('lan_port_change_resume_missing')
  }
  if (criteria.requireLateResume !== false && !lateResume) failures.push(`late_resume_missing:${lateMin}-${lateMax}`)

  const completed = run.status === 'COMPLETED' || run.terminalState === 'COMPLETED'
  if (criteria.requireCompleted === true && !completed) failures.push('completed_terminal_state_missing')

  return {
    ok: failures.length === 0,
    runId: run.runId || null,
    blueprintId: run.blueprintId || null,
    blueprintHash: run.blueprintHash || null,
    planId: run.planId || null,
    status: run.status || null,
    terminalState: run.terminalState || null,
    resumeCount: history.length,
    formalResumeCount: formal.length,
    criteria: {
      minResumes,
      lateMin,
      lateMax,
      requireProcessRestart: criteria.requireProcessRestart !== false,
      requireLanPortChange: criteria.requireLanPortChange !== false,
      requireLateResume: criteria.requireLateResume !== false,
      requireCompleted: criteria.requireCompleted === true
    },
    evidence: {
      processRestartSequence: processRestart?.sequence || null,
      lanPortChangeSequence: lanPortChange?.sequence || legacyLanTransition?.eventSequence || null,
      lanPortChangeSource: lanPortChange ? 'resume_history' : (legacyLanTransition?.valid ? 'legacy_artifact_chain' : null),
      lanPortBefore: lanPortChange?.previousRuntime?.lanPort ?? legacyLanTransition?.beforePort ?? null,
      lanPortAfter: lanPortChange?.runtime?.lanPort ?? legacyLanTransition?.afterPort ?? null,
      legacyLanArtifacts: legacyLanTransition?.valid
        ? {
            beforeLogSha256: legacyLanTransition.beforeLogSha256,
            beforeLedgerSha256: legacyLanTransition.beforeLedgerSha256
          }
        : null,
      lateResumeSequence: lateResume?.sequence || null,
      lateResumePercent: lateResume ? checkpointPercent(lateResume.checkpointBefore) : null,
      reconciledWorkSetSequences,
      completed
    },
    failures
  }
}

function verifyEventInvariants(failures, run, event) {
  const expected = {
    runId: run.runId || null,
    blueprintId: run.blueprintId || null,
    blueprintHash: run.blueprintHash || null,
    planId: run.planId || null,
    placementContext: run.placementContext || null,
    world: run.world || null
  }
  if (stableStringify(event.invariants || null) !== stableStringify(expected)) {
    failures.push(`resume_invariants_mismatch:${event.sequence || 'unknown'}`)
  }
}

function verifyCheckpointShape(failures, event) {
  let valid = true
  for (const [label, checkpoint] of [['before', event.checkpointBefore], ['after', event.checkpointAfter]]) {
    if (!checkpoint || !Number.isInteger(checkpoint.total) || checkpoint.total <= 0 ||
        !Number.isInteger(checkpoint.verified) || checkpoint.verified < 0 || checkpoint.verified > checkpoint.total) {
      failures.push(`invalid_${label}_checkpoint:${event.sequence || 'unknown'}`)
      valid = false
      continue
    }
    const counted = [
      'verified',
      'pending',
      'ready',
      'executing',
      'placed',
      'retryableFailed',
      'terminalFailed',
      'repair',
      'stateRepair',
      'cleanup'
    ]
      .reduce((sum, key) => sum + nonNegativeInteger(checkpoint[key]), 0)
    const legacyFailureCheckpoint =
      counted < checkpoint.total &&
      checkpoint.checkpoint?.reason === 'step_failure' &&
      !Object.prototype.hasOwnProperty.call(checkpoint, 'retryableFailed') &&
      !Object.prototype.hasOwnProperty.call(checkpoint, 'terminalFailed')
    if (counted !== checkpoint.total && !legacyFailureCheckpoint) {
      failures.push(`checkpoint_count_mismatch_${label}:${event.sequence || 'unknown'}`)
      valid = false
    }
  }
  if (!valid || event.checkpointBefore.total === event.checkpointAfter.total) return false

  const reconciledExpansion = event.resumeOnly === true &&
    event.reason === 'resume_only_request' &&
    event.checkpointAfter.currentPhase === 'site_prepare' &&
    event.checkpointAfter.total > event.checkpointBefore.total
  if (!reconciledExpansion) {
    failures.push(`checkpoint_total_changed:${event.sequence || 'unknown'}`)
    return false
  }
  return true
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function checkpointPercent(checkpoint = {}) {
  const total = Number(checkpoint.total || 0)
  if (!total) return 0
  return Number(((Number(checkpoint.verified || 0) / total) * 100).toFixed(2))
}

function compareExpected(failures, label, actual, expected) {
  if (expected == null) return
  if (stableStringify(actual) !== stableStringify(expected)) failures.push(`${label}_mismatch`)
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function parseArgs(argv = []) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const equal = token.indexOf('=')
    if (equal >= 0) {
      values[token.slice(2, equal)] = token.slice(equal + 1)
    } else {
      const next = argv[index + 1]
      values[token.slice(2)] = next && !next.startsWith('--') ? argv[++index] : true
    }
  }
  return values
}

function parseOrigin(value) {
  if (!value) return null
  const parts = String(value).split(',').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null
  return { x: parts[0], y: parts[1], z: parts[2] }
}

function loadLegacyLanTransitionEvidence(run, input = {}) {
  const beforeLogPath = input.beforeLogPath ? path.resolve(input.beforeLogPath) : null
  const beforeLedgerPath = input.beforeLedgerPath ? path.resolve(input.beforeLedgerPath) : null
  if (!beforeLogPath && !beforeLedgerPath) return null

  const result = {
    attempted: true,
    valid: false,
    failures: [],
    eventSequence: null,
    beforePort: null,
    afterPort: null,
    beforeLogSha256: null,
    beforeLedgerSha256: null
  }
  if (!beforeLogPath || !beforeLedgerPath) {
    result.failures.push('artifact_pair_required')
    return result
  }
  try {
    const logBuffer = fs.readFileSync(beforeLogPath)
    const ledgerBuffer = fs.readFileSync(beforeLedgerPath)
    result.beforeLogSha256 = sha256(logBuffer)
    result.beforeLedgerSha256 = sha256(ledgerBuffer)
    const log = logBuffer.toString('utf8')
    const document = JSON.parse(ledgerBuffer.toString('utf8'))
    const beforeStore = new ConstructionRunStore({ filePath: beforeLedgerPath, archiveTerminalRuns: false })
    const beforeRaw = (Array.isArray(document) ? document : (document.runs || []))
      .find(entry => entry.runId === run?.runId) || null
    const beforeRun = beforeRaw ? beforeStore.hydrateRun(beforeRaw) : null

    if (!beforeRun) result.failures.push('before_run_not_found')
    const ports = connectedLanPorts(log)
    if (ports.length !== 1) result.failures.push(`before_log_port_count:${ports.length}`)
    result.beforePort = ports.length === 1 ? ports[0] : null
    if (!log.includes(`runId=${run?.runId}`) || !log.includes('[BUILD_CONSTRUCTION_RUN] mode=resume')) {
      result.failures.push('before_log_same_run_resume_marker_missing')
    }
    if (beforeRun) {
      for (const [label, actual, expected] of [
        ['blueprint_id', beforeRun.blueprintId, run.blueprintId],
        ['blueprint_hash', beforeRun.blueprintHash, run.blueprintHash],
        ['plan_id', beforeRun.planId, run.planId],
        ['origin', beforeRun.placementContext?.origin, run.placementContext?.origin],
        ['dimension', beforeRun.world?.dimension, run.world?.dimension]
      ]) {
        if (stableStringify(actual) !== stableStringify(expected)) result.failures.push(`before_${label}_mismatch`)
      }
      if (beforeRun.status !== 'ACTIVE' || beforeRun.terminalState != null) {
        result.failures.push('before_run_not_active_nonterminal')
      }
      const beforeCheckpoint = checkpointEvidenceFromRun(beforeRun)
      const formal = (run.resumeHistory || []).filter(event => event?.outcome === 'prepared' && event.resumeOnly === true)
      const event = formal.find(candidate =>
        candidate.runtime?.lanPort != null &&
        result.beforePort != null &&
        Number(candidate.runtime.lanPort) !== Number(result.beforePort) &&
        sameCheckpointState(candidate.checkpointBefore, beforeCheckpoint) &&
        (!beforeRun.updatedAt || !candidate.checkpointBefore?.updatedAt || beforeRun.updatedAt === candidate.checkpointBefore.updatedAt)
      ) || null
      if (!event) {
        result.failures.push('checkpoint_linked_transition_event_missing')
      } else {
        result.eventSequence = event.sequence
        result.afterPort = Number(event.runtime.lanPort)
      }
    }
  } catch (error) {
    result.failures.push(`artifact_read_failed:${error.code || error.name || 'error'}`)
  }
  result.valid = result.failures.length === 0
  return result
}

function connectedLanPorts(log = '') {
  const matches = [
    ...log.matchAll(/找到 MC 服务器[：:]\s*端口\s*(\d+)/g),
    ...log.matchAll(/\[端口\].*?指定端口[：:]\s*(\d+)/g)
  ]
  return [...new Set(matches.map(match => Number(match[1])).filter(Number.isInteger))]
}

function checkpointEvidenceFromRun(run = {}) {
  const counts = {}
  for (const step of Object.values(run.steps || {})) {
    const status = String(step?.status || 'pending')
    counts[status] = (counts[status] || 0) + 1
  }
  return {
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    verified: counts.verified || 0,
    pending: counts.pending || 0,
    ready: counts.ready || 0,
    executing: counts.executing || 0,
    placed: counts.placed || 0,
    retryableFailed: counts.retryable_failed || 0,
    terminalFailed: counts.terminal_failed || 0,
    repair: counts.repair || 0,
    stateRepair: counts.state_repair || 0,
    cleanup: counts.cleanup || 0,
    currentPhase: run.currentPhase || null
  }
}

function sameCheckpointState(actual = {}, expected = {}) {
  const keys = ['total', 'verified', 'pending', 'executing', 'repair', 'stateRepair', 'cleanup', 'currentPhase']
  return keys.every(key => (actual[key] ?? (typeof expected[key] === 'number' ? 0 : null)) === expected[key])
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase()
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const ledgerPath = path.resolve(args.ledger || path.join(process.cwd(), 'data', 'memory', 'construction-runs.json'))
  // Terminal runs keep their step map in a sidecar (schemaVersion 2), so read
  // through the store: it merges the sidecar back before the checkpoint counts
  // are taken. Passing archiveTerminalRuns:false keeps this read-only — the
  // verifier must never migrate the ledger it is auditing.
  const store = new ConstructionRunStore({ filePath: ledgerPath, archiveTerminalRuns: false })
  const document = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  const rawRun = (document.runs || []).find(entry => entry.runId === args['run-id']) || null
  const run = rawRun ? store.hydrateRun(rawRun) : null
  const legacyLanTransition = loadLegacyLanTransitionEvidence(run, {
    beforeLogPath: args['legacy-lan-before-log'],
    beforeLedgerPath: args['legacy-lan-before-ledger']
  })
  const report = verifyConstructionResumeEvidence(run, {
    runId: args['run-id'],
    blueprintId: args['blueprint-id'],
    blueprintHash: args['blueprint-hash'],
    planId: args['plan-id'],
    origin: parseOrigin(args.origin),
    dimension: args.dimension,
    worldId: args['world-id'],
    minResumes: args['min-resumes'],
    lateMin: args['late-min'],
    lateMax: args['late-max'],
    requireProcessRestart: args['allow-no-process-restart'] !== true,
    requireLanPortChange: args['allow-no-lan-change'] !== true,
    legacyLanTransition,
    requireLateResume: args['allow-no-late-resume'] !== true,
    requireCompleted: args['require-completed'] === true
  })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
  return report
}

if (require.main === module) runCli()

module.exports = {
  checkpointPercent,
  loadLegacyLanTransitionEvidence,
  parseArgs,
  parseOrigin,
  runCli,
  verifyConstructionResumeEvidence
}
