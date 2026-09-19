const assert = require('assert')
const {
  MAX_RESUME_HISTORY,
  STEP_STATE,
  constructionRunCompatibility,
  recordConstructionRunSession
} = require('../systems/construction-run-store')

function runFixture(overrides = {}) {
  return {
    runId: 'construction_run_resume_evidence',
    blueprintId: 'formal_castle',
    blueprintHash: 'blueprint_hash',
    planId: 'construction_plan',
    placementContext: {
      origin: { x: 100, y: 64, z: -20 },
      rotationY: 0,
      mirror: { x: false, z: false }
    },
    world: { dimension: 'overworld' },
    currentPhase: 'frame',
    steps: {
      a: { id: 'a', status: STEP_STATE.VERIFIED },
      b: { id: 'b', status: STEP_STATE.PENDING },
      c: { id: 'c', status: STEP_STATE.EXECUTING }
    },
    checkpoint: {
      reason: 'task_pause',
      flushedAt: '2026-08-01T00:00:00.000Z',
      writeCount: 4
    },
    ...overrides
  }
}

function testFreshSessionSeedsRuntimeWithoutResumeEvent() {
  const recorded = recordConstructionRunSession(runFixture(), {
    resumed: false,
    processSessionId: 'process-a',
    pid: 101,
    lanPort: 49810,
    dimension: 'overworld',
    worldId: 'building-A:test-world',
    observedAt: '2026-08-01T00:01:00.000Z'
  })

  assert.strictEqual(recorded.runtimeEvidence.processSessionId, 'process-a')
  assert.strictEqual(recorded.runtimeEvidence.lanPort, 49810)
  assert.strictEqual(recorded.runtimeEvidence.worldId, 'building-A:test-world')
  assert.deepStrictEqual(recorded.resumeHistory, [])
}

function testLegacyWorldIdentityUpgradesOnceThenBecomesMandatory() {
  const legacy = runFixture()
  const upgradedWorld = {
    dimension: 'overworld',
    worldId: 'building-A:test-world',
    identitySource: 'MC_WORLD_ID'
  }
  const legacyCompatibility = constructionRunCompatibility(legacy, {
    blueprintId: legacy.blueprintId,
    blueprintHash: legacy.blueprintHash,
    placementContext: legacy.placementContext,
    world: upgradedWorld
  })
  assert.strictEqual(legacyCompatibility.ok, true)
  assert.deepStrictEqual(legacyCompatibility.worldIdentityUpgrade, {
    from: null,
    to: 'building-A:test-world',
    source: 'MC_WORLD_ID'
  })

  const upgraded = { ...legacy, world: upgradedWorld }
  const missingIdentity = constructionRunCompatibility(upgraded, {
    blueprintId: upgraded.blueprintId,
    blueprintHash: upgraded.blueprintHash,
    placementContext: upgraded.placementContext,
    world: { dimension: 'overworld' }
  })
  assert.strictEqual(missingIdentity.ok, false)
  assert.strictEqual(missingIdentity.reason, 'world_identity_unverified')

  const wrongWorld = constructionRunCompatibility(upgraded, {
    blueprintId: upgraded.blueprintId,
    blueprintHash: upgraded.blueprintHash,
    placementContext: upgraded.placementContext,
    world: { dimension: 'overworld', worldId: 'building-A:other-world' }
  })
  assert.strictEqual(wrongWorld.ok, false)
  assert.strictEqual(wrongWorld.reason, 'world_id_changed')
}

function testResumeAppendsIdentityAndCheckpointEvidence() {
  const previous = recordConstructionRunSession(runFixture(), {
    resumed: false,
    processSessionId: 'process-a',
    pid: 101,
    lanPort: 49810,
    observedAt: '2026-08-01T00:01:00.000Z'
  })
  const resumedState = runFixture({
    runtimeEvidence: previous.runtimeEvidence,
    resumeHistory: previous.resumeHistory,
    steps: {
      a: { id: 'a', status: STEP_STATE.VERIFIED },
      b: { id: 'b', status: STEP_STATE.VERIFIED },
      c: { id: 'c', status: STEP_STATE.PENDING }
    }
  })
  const recorded = recordConstructionRunSession(resumedState, {
    resumed: true,
    previousRun: previous,
    resumeOnly: true,
    reason: 'resume_only_request',
    processSessionId: 'process-b',
    pid: 202,
    lanPort: 51234,
    dimension: 'overworld',
    observedAt: '2026-08-01T00:02:00.000Z'
  })

  assert.strictEqual(recorded.resumeHistory.length, 1)
  const event = recorded.resumeHistory[0]
  assert.strictEqual(event.sequence, 1)
  assert.strictEqual(event.outcome, 'prepared')
  assert.strictEqual(event.resumeOnly, true)
  assert.strictEqual(event.processRestarted, true)
  assert.strictEqual(event.lanPortChanged, true)
  assert.strictEqual(event.checkpointBefore.verified, 1)
  assert.strictEqual(event.checkpointBefore.executing, 1)
  assert.strictEqual(event.checkpointAfter.verified, 2)
  assert.strictEqual(event.checkpointAfter.pending, 1)
  assert.strictEqual(event.invariants.runId, previous.runId)
  assert.strictEqual(event.invariants.blueprintId, previous.blueprintId)
  assert.strictEqual(event.invariants.blueprintHash, previous.blueprintHash)
  assert.deepStrictEqual(event.invariants.placementContext, previous.placementContext)
  assert.ok(event.eventId.startsWith('construction_resume_'))
}

function testUnknownPreviousRuntimeDoesNotInventChangeEvidence() {
  const recorded = recordConstructionRunSession(runFixture(), {
    resumed: true,
    previousRun: runFixture(),
    processSessionId: 'process-first-recorded',
    pid: 303,
    lanPort: 52345,
    observedAt: '2026-08-01T00:03:00.000Z'
  })

  assert.strictEqual(recorded.resumeHistory[0].processRestarted, null)
  assert.strictEqual(recorded.resumeHistory[0].lanPortChanged, null)
}

function testResumeHistoryIsBoundedAndSequenceRemainsMonotonic() {
  let run = recordConstructionRunSession(runFixture(), {
    resumed: false,
    processSessionId: 'process-seed',
    pid: 1,
    lanPort: 50000,
    observedAt: '2026-08-01T00:00:00.000Z'
  })
  for (let index = 0; index < MAX_RESUME_HISTORY + 3; index++) {
    const previous = run
    run = recordConstructionRunSession(run, {
      resumed: true,
      previousRun: previous,
      processSessionId: `process-${index}`,
      pid: index + 2,
      lanPort: 50001 + index,
      observedAt: `2026-08-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`
    })
  }

  assert.strictEqual(run.resumeHistory.length, MAX_RESUME_HISTORY)
  const sequences = run.resumeHistory.map(event => event.sequence)
  assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]))
  assert.strictEqual(sequences[sequences.length - 1], MAX_RESUME_HISTORY + 3)
  assert.strictEqual(new Set(run.resumeHistory.map(event => event.eventId)).size, MAX_RESUME_HISTORY)
}

function run() {
  testFreshSessionSeedsRuntimeWithoutResumeEvent()
  testLegacyWorldIdentityUpgradesOnceThenBecomesMandatory()
  testResumeAppendsIdentityAndCheckpointEvidence()
  testUnknownPreviousRuntimeDoesNotInventChangeEvidence()
  testResumeHistoryIsBoundedAndSequenceRemainsMonotonic()
  console.log('construction resume evidence tests passed')
}

run()
