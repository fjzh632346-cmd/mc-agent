const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const { itemRequirementsForBlock } = require('../utils/building-material-map')
const {
  ConstructionRunStore,
  constructionRunCompatibility,
  createConstructionRun
} = require('../systems/construction-run-store')

// Building lane round 13 (logistics round 6 handover UNKNOWN #1): the
// axis-reference ordering fix changed a live gatehouse build's planId while
// its construction run still recorded the pre-fix plan (pinned here on the
// hand-made tests/fixtures/gatehouse-axis.json). Resume must keep hitting that run:
// run matching keys on blueprintId + blueprintHash + placementContext +
// world, never on planId, and stable step ids do not encode the sequence
// position, so verified steps keep resolving after the reorder.

const ORIGIN = { x: 0, y: 64, z: 0 }
const WORLD = { dimension: 'overworld', worldId: 'building-A:new-world', identitySource: 'MC_WORLD_ID' }
const OLD_PLAN_ID = 'construction_plan_82c288475728'

function inventoryFor (blueprint) {
  const inv = { dirt: 5000, cobblestone: 5000, stone: 5000 }
  for (const block of blueprint.blocks) {
    if (!block.type || /air$/.test(block.type)) continue
    for (const [item, count] of Object.entries(itemRequirementsForBlock(block.type, block.states || {}))) inv[item] = (inv[item] || 0) + count * 2
    inv[block.type] = (inv[block.type] || 0) + 4
  }
  return inv
}

function compileGatehouse () {
  const legacy = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const adapted = new LegacyBlueprintAdapter().fromLegacyBlueprint(legacy)
  assert.strictEqual(adapted.ok, true, adapted.error)
  const validation = new BlueprintValidator().validate(adapted.blueprint)
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics.slice(0, 3)))
  const inv = inventoryFor(legacy)
  const compiled = new ConstructionCompiler().compile({
    blueprint: validation.blueprint,
    placementContext: { origin: ORIGIN, rotationY: 0 },
    siteSnapshot: { blocks: [], inventoryCounts: inv },
    inventoryPolicy: { counts: inv },
    compilerOptions: { includeWalkabilityGate: true }
  })
  assert.strictEqual(compiled.ok, true, compiled.error)
  return compiled
}

function criteriaFor (plan) {
  return {
    blueprintId: plan.blueprintId,
    blueprintRevision: plan.blueprintRevision,
    blueprintHash: plan.blueprintHash,
    planId: plan.planId,
    placementContext: plan.placement,
    world: WORLD
  }
}

function withStore (fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'construction-resume-plan-id-'))
  try {
    fn(new ConstructionRunStore({ filePath: path.join(dir, 'construction-runs.json') }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// A run recorded under the pre-fix sequence: same blueprint, same origin,
// different planId, steps stored in a different order (order is irrelevant
// to the keyed step map, so reversing stands in for the old sequence).
function storedRunFor (compiled, overrides = {}) {
  const plan = compiled.plan
  const steps = compiled.legacy.orderPlan.steps.slice().reverse()
  const run = createConstructionRun({
    blueprintId: plan.blueprintId,
    blueprintRevision: plan.blueprintRevision,
    blueprintHash: plan.blueprintHash,
    planId: OLD_PLAN_ID,
    placementContext: plan.placement,
    world: WORLD,
    steps
  })
  return { ...run, status: 'BLOCKED_MATERIAL_SHORTAGE', terminalState: null, ...overrides }
}

function testReorderedPlanStillResumesTheStoredRun () {
  const compiled = compileGatehouse()
  const plan = compiled.plan
  assert.notStrictEqual(plan.planId, OLD_PLAN_ID)
  assert.ok(compiled.legacy.orderPlan.summary.axisReferenceDeferred > 0, 'fixture must exercise the deferral path')

  withStore(store => {
    const stored = storedRunFor(compiled)
    store.upsertRun(stored)
    const criteria = criteriaFor(plan)

    const compatibility = constructionRunCompatibility(store.getRun(stored.runId), criteria)
    assert.deepStrictEqual(compatibility, { ok: true, worldIdentityUpgrade: null })

    const hit = store.findActiveCompatible(criteria)
    assert.ok(hit, 'active run must be found despite the planId change')
    assert.strictEqual(hit.runId, stored.runId)
    assert.strictEqual(hit.planId, OLD_PLAN_ID)
  })
}

function testStableStepIdsSurviveTheReorder () {
  const compiled = compileGatehouse()
  const stored = storedRunFor(compiled)
  const placeSteps = compiled.legacy.orderPlan.steps.filter(step => step.kind === 'place')
  assert.strictEqual(placeSteps.length, 394)
  for (const step of placeSteps) {
    assert.ok(stored.steps[step.id], `place step ${step.id} @${step.position.x},${step.position.y},${step.position.z} missing from stored run`)
  }
  const deferred = compiled.legacy.orderPlan.steps.filter(step => step.deferredReason === 'axis_reference_unresolved')
  assert.ok(deferred.length > 0)
  for (const step of deferred) assert.ok(stored.steps[step.id], 'deferred tail keeps its pre-fix step id')
}

function testMatchingKeysOnHashPlacementAndWorldNotPlanId () {
  const compiled = compileGatehouse()
  const plan = compiled.plan
  withStore(store => {
    const stored = storedRunFor(compiled)
    store.upsertRun(stored)
    const criteria = criteriaFor(plan)

    // planId alone never decides
    assert.strictEqual(constructionRunCompatibility(stored, { ...criteria, planId: 'construction_plan_000000000000' }).ok, true)

    const hashChanged = constructionRunCompatibility(stored, { ...criteria, blueprintHash: 'deadbeef' })
    assert.strictEqual(hashChanged.ok, false)
    assert.strictEqual(hashChanged.reason, 'blueprintHash_changed')

    const moved = constructionRunCompatibility(stored, {
      ...criteria,
      placementContext: { ...plan.placement, origin: { x: ORIGIN.x + 1, y: ORIGIN.y, z: ORIGIN.z } }
    })
    assert.strictEqual(moved.ok, false)
    assert.strictEqual(moved.reason, 'placementContext_changed')

    // MC_WORLD_ID unset -> the stored run is treated as unverified, not resumed
    const noWorld = constructionRunCompatibility(stored, { ...criteria, world: { dimension: 'overworld', worldId: null } })
    assert.strictEqual(noWorld.ok, false)
    assert.strictEqual(noWorld.reason, 'world_identity_unverified')
    assert.strictEqual(store.findActiveCompatible({ ...criteria, world: { dimension: 'overworld', worldId: null } }), null)
  })
}

testReorderedPlanStillResumesTheStoredRun()
testStableStepIdsSurviveTheReorder()
testMatchingKeysOnHashPlacementAndWorldNotPlanId()
console.log('construction-resume-plan-id tests passed')
