const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  loadLegacyLanTransitionEvidence,
  verifyConstructionResumeEvidence
} = require('../scripts/verify-construction-resume-evidence')
const { constructionRunCheckpointEvidence } = require('../systems/construction-run-store')

function event(sequence, percent, overrides = {}) {
  const total = 1000
  const verified = Math.round(total * percent / 100)
  return {
    eventId: `construction_resume_${sequence}`,
    sequence,
    at: `2026-08-01T0${sequence}:00:00.000Z`,
    outcome: 'prepared',
    reason: 'resume_only_request',
    resumeOnly: true,
    runtime: { processSessionId: `process-${sequence}`, pid: 100 + sequence, lanPort: 50000 + sequence },
    previousRuntime: { processSessionId: `process-${sequence - 1}`, pid: 99 + sequence, lanPort: 49999 + sequence },
    processRestarted: false,
    lanPortChanged: false,
    checkpointBefore: { total, verified, pending: total - verified, currentPhase: 'frame' },
    checkpointAfter: { total, verified, pending: total - verified, currentPhase: 'frame' },
    invariants: invariantFixture(),
    ...overrides
  }
}

function invariantFixture() {
  return {
    runId: 'construction_run_verified',
    blueprintId: 'survival_castle',
    blueprintHash: 'castle_hash',
    planId: 'castle_plan',
    placementContext: { origin: { x: 100, y: 64, z: -20 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld', worldId: 'building-A:test-world', identitySource: 'MC_WORLD_ID' }
  }
}

function completedRun() {
  const invariants = invariantFixture()
  return {
    ...invariants,
    status: 'COMPLETED',
    terminalState: 'COMPLETED',
    resumeHistory: [
      event(1, 15, { processRestarted: true }),
      event(2, 42, { lanPortChanged: true }),
      event(3, 78)
    ]
  }
}

function criteria() {
  return {
    runId: 'construction_run_verified',
    blueprintId: 'survival_castle',
    blueprintHash: 'castle_hash',
    planId: 'castle_plan',
    origin: { x: 100, y: 64, z: -20 },
    dimension: 'overworld',
    worldId: 'building-A:test-world',
    minResumes: 3,
    lateMin: 70,
    lateMax: 90,
    requireCompleted: true
  }
}

function testCompleteEvidencePasses() {
  const report = verifyConstructionResumeEvidence(completedRun(), criteria())
  assert.strictEqual(report.ok, true, JSON.stringify(report.failures))
  assert.strictEqual(report.formalResumeCount, 3)
  assert.strictEqual(report.evidence.processRestartSequence, 1)
  assert.strictEqual(report.evidence.lanPortChangeSequence, 2)
  assert.strictEqual(report.evidence.lateResumeSequence, 3)
  assert.strictEqual(report.evidence.lateResumePercent, 78)
  assert.strictEqual(report.evidence.completed, true)
}

function testMissingRequiredEventFails() {
  const run = completedRun()
  run.resumeHistory = run.resumeHistory.map(entry => ({ ...entry, lanPortChanged: false }))
  const report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, false)
  assert.ok(report.failures.includes('lan_port_change_resume_missing'))
}

function testInvariantDriftFails() {
  const run = completedRun()
  run.resumeHistory[2] = {
    ...run.resumeHistory[2],
    invariants: {
      ...run.resumeHistory[2].invariants,
      blueprintHash: 'drifted_hash'
    }
  }
  const report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, false)
  assert.ok(report.failures.includes('resume_invariants_mismatch:3'))
}

function testNonFormalEventsDoNotSatisfyMinimum() {
  const run = completedRun()
  run.resumeHistory[1] = { ...run.resumeHistory[1], resumeOnly: false }
  const report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, false)
  assert.ok(report.failures.includes('formal_resume_count_below_min:2/3'))
}

function testSitePrepareExpansionWithRepairRedistributionIsAcceptedAndReported() {
  const run = completedRun()
  run.resumeHistory[0] = event(1, 15, {
    processRestarted: true,
    checkpointBefore: {
      total: 1000,
      verified: 150,
      pending: 499,
      executing: 1,
      repair: 350,
      currentPhase: 'site_prepare'
    },
    checkpointAfter: {
      total: 1015,
      verified: 166,
      pending: 787,
      repair: 62,
      currentPhase: 'site_prepare'
    }
  })
  const report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, true, JSON.stringify(report.failures))
  assert.deepStrictEqual(report.evidence.reconciledWorkSetSequences, [1])
}

function testUnexplainedWorkSetChangeStillFails() {
  for (const checkpointAfter of [
    { total: 1200, verified: 150, pending: 800, repair: 250, currentPhase: 'frame' },
    { total: 900, verified: 150, pending: 500, repair: 250, currentPhase: 'site_prepare' }
  ]) {
    const run = completedRun()
    run.resumeHistory[0] = event(1, 15, { processRestarted: true, checkpointAfter })
    const report = verifyConstructionResumeEvidence(run, criteria())
    assert.strictEqual(report.ok, false)
    assert.ok(report.failures.includes('checkpoint_total_changed:1'))
  }
}

function testCheckpointStatusCountsMustMatchTotal() {
  const run = completedRun()
  run.resumeHistory[0] = event(1, 15, {
    processRestarted: true,
    checkpointAfter: { total: 1000, verified: 150, pending: 849, currentPhase: 'frame' }
  })
  const report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, false)
  assert.ok(report.failures.includes('checkpoint_count_mismatch_after:1'))
}

function testFailureCheckpointSupportsExplicitAndLegacyRetryableCounts() {
  const run = completedRun()
  run.resumeHistory[0] = event(1, 15, {
    processRestarted: true,
    checkpointBefore: {
      total: 1000,
      verified: 150,
      pending: 849,
      retryableFailed: 1,
      currentPhase: 'frame',
      checkpoint: { reason: 'step_failure' }
    }
  })
  let report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, true, JSON.stringify(report.failures))

  delete run.resumeHistory[0].checkpointBefore.retryableFailed
  report = verifyConstructionResumeEvidence(run, criteria())
  assert.strictEqual(report.ok, true, JSON.stringify(report.failures))
}

function testCheckpointEvidenceSerializesEveryStepState() {
  const statuses = [
    'pending',
    'ready',
    'executing',
    'placed',
    'verified',
    'retryable_failed',
    'terminal_failed',
    'repair',
    'state_repair',
    'cleanup'
  ]
  const checkpoint = constructionRunCheckpointEvidence({
    steps: Object.fromEntries(statuses.map((status, index) => [`step-${index}`, { status }]))
  })
  assert.strictEqual(checkpoint.total, statuses.length)
  assert.strictEqual(checkpoint.ready, 1)
  assert.strictEqual(checkpoint.placed, 1)
  assert.strictEqual(checkpoint.retryableFailed, 1)
  assert.strictEqual(checkpoint.terminalFailed, 1)
}

function testLegacyArtifactChainSatisfiesRealLanTransitionWithoutInventingHistory() {
  const run = completedRun()
  run.resumeHistory = run.resumeHistory.map(entry => ({ ...entry, lanPortChanged: false }))
  const linkedAt = '2026-08-01T00:00:30.000Z'
  run.resumeHistory[0] = {
    ...run.resumeHistory[0],
    checkpointBefore: { ...run.resumeHistory[0].checkpointBefore, updatedAt: linkedAt }
  }
  const steps = {}
  for (let index = 0; index < 1000; index++) {
    steps[`step-${index}`] = { status: index < 150 ? 'verified' : 'pending' }
  }
  const beforeRun = {
    ...invariantFixture(),
    world: { dimension: 'overworld' },
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'frame',
    steps,
    updatedAt: linkedAt
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'construction-resume-verifier-'))
  try {
    const beforeLogPath = path.join(temp, 'before.log')
    const beforeLedgerPath = path.join(temp, 'before-ledger.json')
    fs.writeFileSync(beforeLogPath, [
      '✅ 找到 MC 服务器：端口 49810',
      '[BUILD_CONSTRUCTION_RUN] mode=resume runId=construction_run_verified verified=150 pending=850 repair=0 stateRepair=0'
    ].join('\n'))
    fs.writeFileSync(beforeLedgerPath, JSON.stringify({ runs: [beforeRun] }))
    const legacyLanTransition = loadLegacyLanTransitionEvidence(run, { beforeLogPath, beforeLedgerPath })
    assert.strictEqual(legacyLanTransition.valid, true, JSON.stringify(legacyLanTransition.failures))
    assert.strictEqual(legacyLanTransition.beforePort, 49810)
    assert.strictEqual(legacyLanTransition.afterPort, 50001)
    assert.strictEqual(legacyLanTransition.eventSequence, 1)
    assert.match(legacyLanTransition.beforeLogSha256, /^[A-F0-9]{64}$/)

    const report = verifyConstructionResumeEvidence(run, {
      ...criteria(),
      legacyLanTransition
    })
    assert.strictEqual(report.ok, true, JSON.stringify(report.failures))
    assert.strictEqual(report.evidence.lanPortChangeSource, 'legacy_artifact_chain')
    assert.strictEqual(report.evidence.lanPortChangeSequence, 1)
    assert.strictEqual(report.evidence.lanPortBefore, 49810)
    assert.strictEqual(report.evidence.lanPortAfter, 50001)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function testInvalidLegacyArtifactChainCannotSatisfyLanTransition() {
  const run = completedRun()
  run.resumeHistory = run.resumeHistory.map(entry => ({ ...entry, lanPortChanged: false }))
  const report = verifyConstructionResumeEvidence(run, {
    ...criteria(),
    legacyLanTransition: {
      attempted: true,
      valid: false,
      failures: ['checkpoint_linked_transition_event_missing']
    }
  })
  assert.strictEqual(report.ok, false)
  assert.ok(report.failures.includes('legacy_lan_transition_invalid:checkpoint_linked_transition_event_missing'))
  assert.ok(report.failures.includes('lan_port_change_resume_missing'))
}

function run() {
  testCompleteEvidencePasses()
  testMissingRequiredEventFails()
  testInvariantDriftFails()
  testNonFormalEventsDoNotSatisfyMinimum()
  testSitePrepareExpansionWithRepairRedistributionIsAcceptedAndReported()
  testUnexplainedWorkSetChangeStillFails()
  testCheckpointStatusCountsMustMatchTotal()
  testFailureCheckpointSupportsExplicitAndLegacyRetryableCounts()
  testCheckpointEvidenceSerializesEveryStepState()
  testLegacyArtifactChainSatisfiesRealLanTransitionWithoutInventingHistory()
  testInvalidLegacyArtifactChainCannotSatisfyLanTransition()
  console.log('construction resume verifier tests passed')
}

run()
