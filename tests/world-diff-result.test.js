const assert = require('assert')
const {
  mergeWorldDiffResults,
  worldDiffFromFaithfulComparison,
  worldDiffFromValidateBuild,
  worldDiffFromWalkability
} = require('../systems/world-diff-result')

function testValidateBuildDiffCategories() {
  const diff = worldDiffFromValidateBuild({
    ok: false,
    failures: [
      { position: { x: 0, y: 64, z: 0 }, expected: 'oak_planks', actual: 'air' },
      { position: { x: 1, y: 64, z: 0 }, expected: 'oak_planks', actual: 'stone' },
      { position: { x: 2, y: 64, z: 0 }, expected: 'air', actual: 'dirt' },
      { position: { x: 3, y: 64, z: 0 }, expected: 'air', actual: 'dirt', temporary: true }
    ]
  })

  assert.strictEqual(diff.missingBlocks.length, 1)
  assert.strictEqual(diff.wrongBlocks.length, 1)
  assert.strictEqual(diff.extraBlocks.length, 1)
  assert.strictEqual(diff.scaffoldResidue.length, 1)
}

function testMaterialResolutionRewritesWorldDiffExpected() {
  const diff = worldDiffFromValidateBuild({
    ok: false,
    failures: [
      {
        position: { x: 0, y: 64, z: 0 },
        expected: 'grass_block',
        actual: 'grass_block',
        materialResolution: {
          originalBlock: 'grass_block',
          resolvedBlock: 'dirt',
          affectsWorldDiff: true
        }
      }
    ]
  })

  assert.strictEqual(diff.wrongBlocks.length, 1)
  assert.strictEqual(diff.wrongBlocks[0].expected, 'dirt')
  assert.strictEqual(diff.wrongBlocks[0].actual, 'grass_block')
}

function testNonTerrainWorldDiffStaysStrict() {
  const diff = worldDiffFromValidateBuild({
    ok: false,
    failures: [
      { position: { x: 0, y: 64, z: 0 }, expected: 'oak_planks', actual: 'dirt' }
    ]
  })

  assert.strictEqual(diff.wrongBlocks.length, 1)
  assert.strictEqual(diff.wrongBlocks[0].expected, 'oak_planks')
}

function testFaithfulDiffSeparatesWrongState() {
  const diff = worldDiffFromFaithfulComparison({
    ok: false,
    failures: ['block_state_fidelity_below_threshold', 'extra_block_ratio_above_threshold'],
    metrics: {
      sampleMismatches: [
        {
          position: { x: 0, y: 64, z: 0 },
          expected: 'oak_stairs',
          actual: 'oak_stairs',
          expectedStates: { facing: 'east' },
          actualStates: { facing: 'west' }
        }
      ],
      sampleExtras: [
        { position: { x: 9, y: 64, z: 9 }, type: 'scaffolding' }
      ]
    }
  })

  assert.strictEqual(diff.wrongStates.length, 1)
  assert.strictEqual(diff.scaffoldResidue.length, 1)
}

function testWalkabilityDiffRecordsUnreachableTargets() {
  const diff = worldDiffFromWalkability({
    ok: false,
    failures: ['unreachable:chest'],
    unreachableTargets: [
      { role: 'chest', type: 'furniture', accessCells: [{ x: 1, y: 64, z: 1 }] }
    ]
  })

  assert.strictEqual(diff.unreachableFunctionalPoints.length, 1)
  assert.strictEqual(diff.unreachableFunctionalPoints[0].role, 'chest')
}

function testMergeWorldDiffResults() {
  const a = worldDiffFromValidateBuild({
    ok: false,
    failures: [{ position: { x: 0, y: 64, z: 0 }, expected: 'oak_planks', actual: 'air' }]
  })
  const b = worldDiffFromWalkability({
    ok: false,
    failures: ['unreachable:furnace'],
    unreachableTargets: []
  })
  const merged = mergeWorldDiffResults(a, b)
  assert.strictEqual(merged.missingBlocks.length, 1)
  assert.strictEqual(merged.unreachableFunctionalPoints.length, 1)
}

function testPendingRestoreKeepsWorldDiffFailing() {
  const diff = worldDiffFromValidateBuild({
    ok: true,
    failures: [],
    pendingRestores: [{
      stepId: 'step_restore_final',
      restoreForStepId: 'step_clear_final',
      target: { x: 0, y: 64, z: 0 },
      expected: 'oak_planks'
    }]
  })

  assert.strictEqual(diff.missingBlocks.length, 1)
  assert.strictEqual(diff.missingBlocks[0].restoreStepId, 'step_restore_final')
  assert.strictEqual(diff.diagnostics.some(entry => entry.code === 'pending_restore_step' && entry.severity === 'error'), true)
}

function run() {
  testValidateBuildDiffCategories()
  testMaterialResolutionRewritesWorldDiffExpected()
  testNonTerrainWorldDiffStaysStrict()
  testFaithfulDiffSeparatesWrongState()
  testWalkabilityDiffRecordsUnreachableTargets()
  testMergeWorldDiffResults()
  testPendingRestoreKeepsWorldDiffFailing()
  console.log('world diff result tests passed')
}

run()
