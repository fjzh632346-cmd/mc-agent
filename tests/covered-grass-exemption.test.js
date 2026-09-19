const assert = require('assert')
const { FaithfulCommunityValidator } = require('../systems/faithful-community-validator')
const { createSitePlan, validateBuild, isCoveredGrassDecayEquivalent, isGrassSmotheringCover, coverLookupFromTargets, posKey } = require('../utils/site-planner')
const { _test: buildingTest } = require('../systems/building-system')

// Pins the covered-grass decay exemption (round-9 boss ruling, same class as
// the door-hinge concession): grass_block that the BLUEPRINT ITSELF covers
// with a non-air block at (x, y+1, z) inevitably decays to dirt under vanilla
// rules, so expected grass_block with actual dirt counts as a match there.
// Exactly ONE exemption, one-way only. Every positive test has reverse twins
// proving nothing else was loosened:
//   - uncovered grass -> dirt is still a mismatch
//   - covered grass -> any other block is still a mismatch
//   - expected dirt -> grass_block (the reverse direction) is untouched
//   - the pre-existing origin-Y two-way terrain equivalence is unchanged

// ── Fixture ──────────────────────────────────────────────────────────────────
// A 3-column strip at y=66 (NOT the origin/base layer, so the pre-existing
// origin-Y equivalence cannot mask the new predicate):
//   (0,66,0) grass_block covered by stone at (0,67,0)   <- exempt candidate
//   (2,66,0) grass_block, nothing above                 <- must stay enforced
//   (4,66,0) dirt covered by stone at (4,67,0)          <- reverse direction

function expectedBlocks() {
  return [
    { x: 0, y: 66, z: 0, type: 'grass_block' },
    { x: 0, y: 67, z: 0, type: 'stone' },
    { x: 2, y: 66, z: 0, type: 'grass_block' },
    { x: 4, y: 66, z: 0, type: 'dirt' },
    { x: 4, y: 67, z: 0, type: 'stone' }
  ]
}

function actualWith(overrides = {}) {
  return expectedBlocks().map(block => {
    const key = `${block.x},${block.y},${block.z}`
    return key in overrides ? { ...block, type: overrides[key] } : block
  })
}

function compare(actualBlocks) {
  const validator = new FaithfulCommunityValidator()
  return validator.compareExpectedActual(
    { name: 'covered_grass_probe', blocks: expectedBlocks() },
    { name: 'covered_grass_probe_actual', blocks: actualBlocks },
    {},
    {}
  )
}

// ── Validator side ───────────────────────────────────────────────────────────

function testCoveredGrassDecayIsExemptInValidator() {
  const result = compare(actualWith({ '0,66,0': 'dirt' }))
  assert.strictEqual(result.metrics.fidelityRatio, 1,
    `covered grass->dirt must count as match, mismatches: ${JSON.stringify(result.metrics.sampleMismatches)}`)
  assert.strictEqual(result.metrics.sampleMismatches.length, 0, 'covered grass->dirt recorded a mismatch')
  assert.ok(!result.failures.includes('fidelity_ratio_below_threshold'), 'fidelity failure flagged')
}

function testCoveredGrassWithStatesSkipsStateComparison() {
  // Dirt cannot carry grass states; the exemption must swallow the state
  // comparison as well, not trade a type mismatch for a state mismatch.
  const expected = expectedBlocks()
  expected[0] = { ...expected[0], states: { snowy: 'false' } }
  const validator = new FaithfulCommunityValidator()
  const result = validator.compareExpectedActual(
    { name: 'covered_grass_states_probe', blocks: expected },
    { name: 'covered_grass_states_probe_actual', blocks: actualWith({ '0,66,0': 'dirt' }) },
    {},
    {}
  )
  assert.strictEqual(result.metrics.fidelityRatio, 1, 'stateful covered grass->dirt not exempt')
  assert.strictEqual(result.metrics.blockStateFidelityRatio, 1,
    'exempted position leaked into the state-fidelity comparison')
  assert.strictEqual(result.metrics.sampleMismatches.length, 0, 'stateful covered grass->dirt mismatch recorded')
}

function testUncoveredGrassToDirtStillCaught() {
  const result = compare(actualWith({ '2,66,0': 'dirt' }))
  assert.ok(result.metrics.fidelityRatio < 1, 'uncovered grass->dirt was NOT caught')
  assert.strictEqual(result.metrics.sampleMismatches.length, 1, 'expected exactly the uncovered-grass mismatch')
  assert.deepStrictEqual(result.metrics.sampleMismatches[0].position, { x: 2, y: 66, z: 0 })
}

function testCoveredGrassToOtherBlockStillCaught() {
  const result = compare(actualWith({ '0,66,0': 'stone' }))
  assert.ok(result.metrics.fidelityRatio < 1, 'covered grass->stone was NOT caught')
  assert.strictEqual(result.metrics.sampleMismatches[0].actual, 'stone')
}

function testDirtToGrassReverseDirectionStillCaught() {
  const result = compare(actualWith({ '4,66,0': 'grass_block' }))
  assert.ok(result.metrics.fidelityRatio < 1, 'expected dirt -> actual grass_block was NOT caught (exemption must stay one-way)')
  assert.deepStrictEqual(result.metrics.sampleMismatches[0].position, { x: 4, y: 66, z: 0 })
}

// ── Site-planner side (scan/plan: correct vs obstruction) ────────────────────

function contextFor(actualBlocks) {
  const world = new Map(actualBlocks.map(block => [`${block.x},${block.y},${block.z}`, block.type]))
  return {
    bot: {
      blockAt: vec => ({ name: world.get(`${vec.x},${vec.y},${vec.z}`) || 'air' })
    }
  }
}

function worldBlocksFixture() {
  return expectedBlocks().map(block => ({
    type: block.type,
    position: { x: block.x, y: block.y, z: block.z }
  }))
}

function testSitePlanCountsCoveredGrassDecayAsCorrect() {
  const context = contextFor(actualWith({ '0,66,0': 'dirt' }))
  const plan = createSitePlan(context, worldBlocksFixture(), { origin: { x: 0, y: 60, z: 0 } })
  assert.strictEqual(plan.summary.correct, 5, `covered grass->dirt not correct: ${JSON.stringify(plan.summary)}`)
  assert.strictEqual(plan.summary.placements, 0, 'covered grass->dirt still scheduled for placement')
  assert.strictEqual(plan.summary.obstructions, 0, 'covered grass->dirt still scheduled for clearing')
}

function testSitePlanStillClearsUncoveredGrassDirt() {
  const context = contextFor(actualWith({ '2,66,0': 'dirt' }))
  const plan = createSitePlan(context, worldBlocksFixture(), { origin: { x: 0, y: 60, z: 0 } })
  assert.strictEqual(plan.summary.correct, 4, 'uncovered grass->dirt miscounted as correct')
  assert.strictEqual(plan.summary.obstructions, 1, 'uncovered grass->dirt must stay an obstruction')
}

function testValidateBuildAcceptsCoveredGrassDecayOnly() {
  const worldBlocks = worldBlocksFixture()
  const covered = validateBuild(contextFor(actualWith({ '0,66,0': 'dirt' })), worldBlocks, [], { origin: { x: 0, y: 60, z: 0 } })
  assert.strictEqual(covered.ok, true, `covered grass->dirt failed validateBuild: ${JSON.stringify(covered.failures)}`)
  const uncovered = validateBuild(contextFor(actualWith({ '2,66,0': 'dirt' })), worldBlocks, [], { origin: { x: 0, y: 60, z: 0 } })
  assert.strictEqual(uncovered.ok, false, 'uncovered grass->dirt passed validateBuild')
}

function testOriginLayerTwoWayEquivalenceUnchanged() {
  // Regression pin: the pre-existing origin-Y terrain equivalence is separate
  // and still two-way — including grass_block appearing where dirt is planned.
  const worldBlocks = [
    { type: 'dirt', position: { x: 0, y: 64, z: 0 } },
    { type: 'grass_block', position: { x: 1, y: 64, z: 0 } }
  ]
  const context = contextFor([
    { x: 0, y: 64, z: 0, type: 'grass_block' },
    { x: 1, y: 64, z: 0, type: 'dirt' }
  ])
  const result = validateBuild(context, worldBlocks, [], { origin: { x: 0, y: 64, z: 0 } })
  assert.strictEqual(result.ok, true, `origin-layer two-way equivalence regressed: ${JSON.stringify(result.failures)}`)
}

// ── Predicate unit behaviour ─────────────────────────────────────────────────

function testPredicateRequiresLookupAndExactTypes() {
  const targetByKey = new Map([[posKey({ x: 0, y: 67, z: 0 }), { type: 'stone' }]])
  const lookup = coverLookupFromTargets(targetByKey)
  assert.strictEqual(isCoveredGrassDecayEquivalent('dirt', 'grass_block', { x: 0, y: 66, z: 0 }, lookup), true)
  assert.strictEqual(isCoveredGrassDecayEquivalent('dirt', 'grass_block', { x: 5, y: 66, z: 0 }, lookup), false, 'no cover above')
  assert.strictEqual(isCoveredGrassDecayEquivalent('grass_block', 'dirt', { x: 0, y: 66, z: 0 }, lookup), false, 'reverse direction exempted')
  assert.strictEqual(isCoveredGrassDecayEquivalent('coarse_dirt', 'grass_block', { x: 0, y: 66, z: 0 }, lookup), false, 'only plain dirt is the decay product')
  assert.strictEqual(isCoveredGrassDecayEquivalent('dirt', 'grass_block', { x: 0, y: 66, z: 0 }, null), false, 'missing lookup must fail closed')
}

function testAirAboveInBlueprintIsNotCover() {
  const targetByKey = new Map([[posKey({ x: 0, y: 67, z: 0 }), { type: 'air' }]])
  const lookup = coverLookupFromTargets(targetByKey)
  assert.strictEqual(isCoveredGrassDecayEquivalent('dirt', 'grass_block', { x: 0, y: 66, z: 0 }, lookup), false,
    'blueprint air above counted as cover')
}

function testLightPassingCoversAreNotSmothering() {
  // Vanilla keeps grass alive under snow layers, glass, and leaves — those
  // cells stay enforced. Live proof on the villa blueprint: exactly one of
  // its 83 grass cells sits under a snow layer and must NOT be exempted
  // (predicate hits 70, not 71).
  for (const cover of ['snow', 'glass', 'white_stained_glass', 'glass_pane', 'oak_leaves']) {
    assert.strictEqual(isGrassSmotheringCover(cover), false, `${cover} wrongly counted as smothering`)
  }
  for (const cover of ['quartz_stairs', 'stone', 'oak_planks', 'tinted_glass']) {
    assert.strictEqual(isGrassSmotheringCover(cover), true, `${cover} must smother grass`)
  }
  const targetByKey = new Map([[posKey({ x: 0, y: 67, z: 0 }), { type: 'snow' }]])
  const lookup = coverLookupFromTargets(targetByKey)
  assert.strictEqual(isCoveredGrassDecayEquivalent('dirt', 'grass_block', { x: 0, y: 66, z: 0 }, lookup), false,
    'snow-covered grass cell exempted')
}

function testSnowCoveredGrassStaysEnforcedInValidator() {
  const expected = [
    { x: 0, y: 66, z: 0, type: 'grass_block' },
    { x: 0, y: 67, z: 0, type: 'snow' }
  ]
  const actual = [
    { x: 0, y: 66, z: 0, type: 'dirt' },
    { x: 0, y: 67, z: 0, type: 'snow' }
  ]
  const validator = new FaithfulCommunityValidator()
  const result = validator.compareExpectedActual(
    { name: 'snow_cover_probe', blocks: expected },
    { name: 'snow_cover_probe_actual', blocks: actual },
    {},
    {}
  )
  assert.ok(result.metrics.fidelityRatio < 1, 'snow-covered grass->dirt was NOT caught by the validator')
}

// ── Executor reconciliation side (building-system) ───────────────────────────

function testReconciliationVerifiesCoveredGrassDecay() {
  const grassStep = { id: 'p1', kind: 'place', blockName: 'grass_block', position: { x: 0, y: 66, z: 0 } }
  const coverStep = { id: 'p2', kind: 'place', blockName: 'stone', position: { x: 0, y: 67, z: 0 } }
  const context = contextFor([{ x: 0, y: 66, z: 0, type: 'dirt' }])
  const status = buildingTest.reconciledStepStatus(context, grassStep, {}, {
    steps: [grassStep, coverStep],
    runSteps: {},
    origin: { x: 0, y: 60, z: 0 }
  })
  assert.strictEqual(status, 'verified', `covered grass->dirt not VERIFIED on resume: ${status}`)
}

function testReconciliationStillRepairsUncoveredGrassDirt() {
  const grassStep = { id: 'p1', kind: 'place', blockName: 'grass_block', position: { x: 2, y: 66, z: 0 } }
  const context = contextFor([{ x: 2, y: 66, z: 0, type: 'dirt' }])
  const status = buildingTest.reconciledStepStatus(context, grassStep, {}, {
    steps: [grassStep],
    runSteps: {},
    origin: { x: 0, y: 60, z: 0 }
  })
  assert.strictEqual(status, 'repair', `uncovered grass->dirt must stay REPAIR on resume: ${status}`)
}

function testScaffoldAboveIsNotBlueprintCover() {
  // Temporary scaffold steps are not part of the blueprint; a scaffold column
  // above a grass cell must not smuggle the cell into the exemption.
  const grassStep = { id: 'p1', kind: 'place', blockName: 'grass_block', position: { x: 2, y: 66, z: 0 } }
  const scaffoldStep = { id: 's1', kind: 'scaffold_place', blockName: 'dirt', position: { x: 2, y: 67, z: 0 } }
  const context = contextFor([{ x: 2, y: 66, z: 0, type: 'dirt' }])
  const status = buildingTest.reconciledStepStatus(context, grassStep, {}, {
    steps: [grassStep, scaffoldStep],
    runSteps: {},
    origin: { x: 0, y: 60, z: 0 }
  })
  assert.strictEqual(status, 'repair', `scaffold cover must not exempt: ${status}`)
}

function testWorldBlocksSourceDrivesAlreadyCorrect() {
  const worldBlocks = worldBlocksFixture()
  assert.strictEqual(
    buildingTest.coveredGrassDecaySatisfied('dirt', 'grass_block', { x: 0, y: 66, z: 0 }, worldBlocks),
    true,
    'worldBlocks-sourced cover lookup failed'
  )
  assert.strictEqual(
    buildingTest.coveredGrassDecaySatisfied('dirt', 'grass_block', { x: 2, y: 66, z: 0 }, worldBlocks),
    false,
    'uncovered cell exempted via worldBlocks source'
  )
}

function run() {
  testCoveredGrassDecayIsExemptInValidator()
  testCoveredGrassWithStatesSkipsStateComparison()
  testUncoveredGrassToDirtStillCaught()
  testCoveredGrassToOtherBlockStillCaught()
  testDirtToGrassReverseDirectionStillCaught()
  testSitePlanCountsCoveredGrassDecayAsCorrect()
  testSitePlanStillClearsUncoveredGrassDirt()
  testValidateBuildAcceptsCoveredGrassDecayOnly()
  testOriginLayerTwoWayEquivalenceUnchanged()
  testPredicateRequiresLookupAndExactTypes()
  testAirAboveInBlueprintIsNotCover()
  testLightPassingCoversAreNotSmothering()
  testSnowCoveredGrassStaysEnforcedInValidator()
  testReconciliationVerifiesCoveredGrassDecay()
  testReconciliationStillRepairsUncoveredGrassDirt()
  testScaffoldAboveIsNotBlueprintCover()
  testWorldBlocksSourceDrivesAlreadyCorrect()
  console.log('covered-grass exemption tests passed')
}

run()
