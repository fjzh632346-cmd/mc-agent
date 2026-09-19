const assert = require('assert')
const path = require('path')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')
const { itemRequirementsForBlock } = require('../utils/building-material-map')
const {
  clickedFaceReferenceRequirement,
  isClickedFaceFacingBlockName,
  orderDeferredClickedFaceSteps,
  planBuildOrder,
  posKey,
  scheduleClickedFaceReferenceSteps
} = require('../utils/site-planner')
const { ORIENTED_PLACEMENT_FACING_RULES } = require('../actions/build')

// Pins the 后勤 15 fix for the mutually-pointing hoppers (决策 #76).
//
// A hopper is the one family in the orientation table whose facing the look
// cannot steer: its output points AT the block that was clicked
// (ORIENTED_PLACEMENT_FACING_RULES.hopper.clickedFace === true, 修缮 10 真机).
// So the blueprint's facing names exactly one neighbour cell, and when two
// adjacent hoppers point at each other neither can be placed first (the live
// case was a gatehouse pair facing=east / facing=west, 后勤 11 记账不修;
// tests/fixtures/gatehouse-axis.json reproduces it at 4,70,7 / 5,70,7).
//
// The fix is in the sequence layer only: hold such a step until the cell it
// must click is scheduled, and when a cycle leaves nobody able to start, hand
// the root a `temporaryReference` declaration — "put a block at (x,y,z), click
// its <face>". One temporary block breaks a cycle of any length.

const ctx = {
  bot: { entity: { position: { x: 0, y: 64, z: 0 } } },
  blackboard: { get: () => null }
}
const ORIGIN = { x: 0, y: 64, z: 0 }
const MATERIALS = { foundationMaterial: null, scaffoldMaterial: null }

function sitePlanFor (worldBlocks) {
  const xs = worldBlocks.map(b => b.position.x)
  const ys = worldBlocks.map(b => b.position.y)
  const zs = worldBlocks.map(b => b.position.z)
  return {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minY: Math.min(...ys), maxY: Math.max(...ys),
      minZ: Math.min(...zs), maxZ: Math.max(...zs)
    }
  }
}

function placeOrder (worldBlocks, options = {}) {
  const plan = planBuildOrder(worldBlocks, sitePlanFor(worldBlocks), MATERIALS, ctx, { origin: ORIGIN, ...options })
  const placeSteps = plan.steps.filter(step => step.kind === 'place')
  return {
    plan,
    placeSteps,
    keys: placeSteps.map(step => posKey(step.position)),
    byKey: new Map(placeSteps.map(step => [posKey(step.position), step]))
  }
}

const at = (x, y, z, type, states = null, phase = 'wall') => ({ type, position: { x, y, z }, states, phase })

function inventoryFor (blueprint) {
  const inv = { dirt: 5000, cobblestone: 5000, stone: 5000 }
  for (const block of blueprint.blocks) {
    const id = block.type || block.block?.id
    if (!id || /air$/.test(id)) continue
    const requirements = itemRequirementsForBlock(id, block.states || block.block?.states || {})
    for (const [item, count] of Object.entries(requirements)) inv[item] = (inv[item] || 0) + count * 2
    inv[id] = (inv[id] || 0) + 4
  }
  return inv
}

function compileLegacy (legacy, origin) {
  const adapted = new LegacyBlueprintAdapter().fromLegacyBlueprint(legacy)
  assert.strictEqual(adapted.ok, true, adapted.error)
  const validation = new BlueprintValidator().validate(adapted.blueprint)
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics?.slice(0, 2)))
  const inventoryCounts = inventoryFor(legacy)
  const compiled = new ConstructionCompiler().compile({
    blueprint: validation.blueprint,
    placementContext: { origin, rotationY: 0 },
    siteSnapshot: { blocks: [], inventoryCounts },
    inventoryPolicy: { counts: inventoryCounts },
    compilerOptions: { includeWalkabilityGate: true }
  })
  assert.strictEqual(compiled.ok, true, compiled.error)
  return compiled
}

// ---------------------------------------------------------------------------
// 1 语义：这一族与朝向表同源，需求格与需点的面都从 facing 直接推出来
function testRequirementFollowsTheOrientationTable () {
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.hopper.clickedFace, true,
    'the orientation table is the source for this family')
  assert.strictEqual(isClickedFaceFacingBlockName('hopper'), true)
  for (const name of ['piston', 'repeater', 'observer', 'stone', 'oak_planks', 'dropper']) {
    assert.strictEqual(isClickedFaceFacingBlockName(name), false, name)
  }

  const east = clickedFaceReferenceRequirement(
    { kind: 'place', blockName: 'hopper', position: { x: 3, y: 4, z: 5 }, states: { facing: 'east' } })
  assert.deepStrictEqual(east, { position: { x: 4, y: 4, z: 5 }, face: 'west', facing: 'east' })

  const down = clickedFaceReferenceRequirement(
    { kind: 'place', blockName: 'hopper', position: { x: 3, y: 4, z: 5 }, states: { facing: 'down' } })
  assert.deepStrictEqual(down, { position: { x: 3, y: 3, z: 5 }, face: 'up', facing: 'down' })

  // Anything the look can steer, and anything without a producible facing,
  // stays out of the pass entirely.
  assert.strictEqual(clickedFaceReferenceRequirement(
    { kind: 'place', blockName: 'piston', position: { x: 0, y: 0, z: 0 }, states: { facing: 'east' } }), null)
  assert.strictEqual(clickedFaceReferenceRequirement(
    { kind: 'place', blockName: 'hopper', position: { x: 0, y: 0, z: 0 }, states: { facing: 'up' } }), null)
  assert.strictEqual(clickedFaceReferenceRequirement(
    { kind: 'place', blockName: 'hopper', position: { x: 0, y: 0, z: 0 }, states: {} }), null)
}

// ---------------------------------------------------------------------------
// 2 主案：一对互指漏斗 → 序列可放。第一只带临时参照声明，第二只参照第一只
function testMutualHopperPairGetsAPlaceableOrder () {
  const blocks = [
    at(0, 64, 0, 'stone_bricks'),
    at(1, 64, 0, 'stone_bricks'),
    at(0, 65, 0, 'hopper', { facing: 'east' }),
    at(1, 65, 0, 'hopper', { facing: 'west' })
  ]
  const { plan, keys, byKey } = placeOrder(blocks)

  const first = byKey.get('0,65,0')
  const second = byKey.get('1,65,0')
  assert.ok(keys.indexOf('0,65,0') < keys.indexOf('1,65,0'),
    `the root must go first: ${keys.join(' | ')}`)

  // 根：点 1,65,0 的西面，那一格此刻还没有块 → 声明垫一块临时砖
  assert.deepStrictEqual(first.clickedFaceReference,
    { position: { x: 1, y: 65, z: 0 }, face: 'west', facing: 'east' })
  assert.deepStrictEqual(first.temporaryReference,
    { position: { x: 1, y: 65, z: 0 }, face: 'west' })
  assert.strictEqual(first.clickedFaceReferenceRoot, true)
  assert.strictEqual(first.deferredReason, 'clicked_face_reference_unresolved')

  // 另一只：照常参照前者，不需要临时砖
  assert.deepStrictEqual(second.clickedFaceReference,
    { position: { x: 0, y: 65, z: 0 }, face: 'east', facing: 'west' })
  assert.strictEqual(second.temporaryReference, undefined)
  assert.strictEqual(second.clickedFaceReferenceRoot, false)

  assert.strictEqual(plan.summary.clickedFaceReferenceDeferred, 2)
  assert.strictEqual(plan.summary.clickedFaceReferenceRoots, 1)
  assert.strictEqual(plan.summary.clickedFaceTemporaryReferences, 1)
}

// ---------------------------------------------------------------------------
// 3 三只环形互指 → 仍然给得出一条可放顺序，且只欠一块临时砖
function testThreeHopperCycleStillGetsOnePlaceableOrder () {
  // 0,65,0 →east→ 1,65,0 →south→ 1,65,1 →... 让第三只指回第一只需要共面，
  // 用一条 L 形：A(0,65,0) 朝东指 B(1,65,0)，B 朝南指 C(1,65,1)，
  // C 朝西指 D(0,65,1)，D 朝北指回 A —— 四只环，同一条规则。
  const blocks = [
    at(0, 64, 0, 'stone_bricks'),
    at(1, 64, 0, 'stone_bricks'),
    at(0, 64, 1, 'stone_bricks'),
    at(1, 64, 1, 'stone_bricks'),
    at(0, 65, 0, 'hopper', { facing: 'east' }),
    at(1, 65, 0, 'hopper', { facing: 'south' }),
    at(1, 65, 1, 'hopper', { facing: 'west' }),
    at(0, 65, 1, 'hopper', { facing: 'north' })
  ]
  const { plan, keys, byKey } = placeOrder(blocks)
  const cycle = ['0,65,0', '1,65,0', '1,65,1', '0,65,1']

  // 恰好一只需要垫临时砖，环上其余的都在自己的参照之后
  const roots = cycle.filter(key => byKey.get(key).temporaryReference)
  assert.deepStrictEqual(roots.length, 1, `exactly one temporary block: ${roots.join(',')}`)
  assert.strictEqual(plan.summary.clickedFaceTemporaryReferences, 1)
  assert.strictEqual(plan.summary.clickedFaceReferenceRoots, 1)

  // 「可放」的定义：每一只要么参照格已经排在它前面，要么它是带临时砖的那只
  for (const key of cycle) {
    const step = byKey.get(key)
    assert.ok(step.clickedFaceReference, `${key} must carry a declaration`)
    if (step.temporaryReference) continue
    const referenceKey = posKey(step.clickedFaceReference.position)
    assert.ok(keys.indexOf(referenceKey) >= 0 && keys.indexOf(referenceKey) < keys.indexOf(key),
      `${key} must come after its reference ${referenceKey}: ${keys.join(' | ')}`)
  }
}

// ---------------------------------------------------------------------------
// 4 非互指、参照更晚：只要推迟就够了，不欠临时砖
function testHopperPointingAtALaterPlainBlockIsJustDelayed () {
  const blocks = [
    at(0, 64, 0, 'stone_bricks'),
    at(0, 65, 0, 'hopper', { facing: 'east' }),
    // 参照块比漏斗高一层，普通排序会把它排在漏斗后面
    at(1, 65, 0, 'stone_bricks')
  ]
  const { plan, keys, byKey } = placeOrder(blocks)
  assert.ok(keys.indexOf('1,65,0') < keys.indexOf('0,65,0'),
    `the hopper must wait for the cell it clicks: ${keys.join(' | ')}`)
  const hopper = byKey.get('0,65,0')
  assert.deepStrictEqual(hopper.clickedFaceReference,
    { position: { x: 1, y: 65, z: 0 }, face: 'west', facing: 'east' })
  assert.strictEqual(hopper.temporaryReference, undefined, 'a delay is enough, no temporary block')
  assert.strictEqual(plan.summary.clickedFaceTemporaryReferences, 0)
}

// ---------------------------------------------------------------------------
// 5 非互指漏斗（指向已经在前面的普通块）→ 行为不变：不推迟、只多一句声明
function testOrdinaryHopperKeepsItsSlot () {
  const blocks = [
    at(0, 64, 0, 'stone_bricks'),
    at(1, 64, 0, 'stone_bricks'),
    at(1, 65, 0, 'stone_bricks'),
    at(0, 65, 0, 'hopper', { facing: 'down' })
  ]
  const { plan, keys, byKey } = placeOrder(blocks)
  const hopper = byKey.get('0,65,0')
  assert.deepStrictEqual(hopper.clickedFaceReference,
    { position: { x: 0, y: 64, z: 0 }, face: 'up', facing: 'down' })
  assert.strictEqual(hopper.temporaryReference, undefined)
  assert.strictEqual(hopper.deferredReason, undefined, 'a satisfied hopper is not deferred')
  assert.strictEqual(plan.summary.clickedFaceReferenceDeferred, 0)
  assert.ok(keys.indexOf('0,64,0') < keys.indexOf('0,65,0'), keys.join(' | '))
}

// ---------------------------------------------------------------------------
// 6 反向：没有这一族方块时，这一趟是恒等映射（别的块一个字段都不多）
function testPassIsIdentityWithoutClickedFaceBlocks () {
  const blocks = [
    at(0, 64, 0, 'stone_bricks'),
    at(0, 65, 0, 'piston', { facing: 'east' }),
    at(1, 65, 0, 'oak_planks'),
    at(1, 64, 0, 'stone_bricks')
  ]
  const { plan, placeSteps } = placeOrder(blocks)
  assert.strictEqual(plan.summary.clickedFaceReferenceDeferred, 0)
  assert.strictEqual(plan.summary.clickedFaceReferenceRoots, 0)
  assert.strictEqual(plan.summary.clickedFaceTemporaryReferences, 0)
  for (const step of placeSteps) {
    assert.strictEqual(step.clickedFaceReference, undefined, posKey(step.position))
    assert.strictEqual(step.temporaryReference, undefined, posKey(step.position))
  }
}

// ---------------------------------------------------------------------------
// 7 单元层：调度与尾巴排序两个函数各自的契约
function testSchedulerAndTailContracts () {
  const a = { kind: 'place', blockName: 'hopper', position: { x: 0, y: 65, z: 0 }, states: { facing: 'east' } }
  const b = { kind: 'place', blockName: 'hopper', position: { x: 1, y: 65, z: 0 }, states: { facing: 'west' } }
  const placed = new Map()
  const scheduled = scheduleClickedFaceReferenceSteps([a, b], placed)
  assert.strictEqual(scheduled.scheduled.length, 0, 'neither can start')
  assert.strictEqual(scheduled.deferred.length, 2)

  const ordered = orderDeferredClickedFaceSteps(scheduled.deferred, placed)
  assert.strictEqual(ordered.length, 2)
  assert.strictEqual(ordered[0].clickedFaceReferenceRoot, true)
  assert.deepStrictEqual(ordered[0].temporaryReference, { position: { x: 1, y: 65, z: 0 }, face: 'west' })
  assert.strictEqual(ordered[1].clickedFaceReferenceRoot, false)
  assert.strictEqual(ordered[1].temporaryReference, undefined)
  // 尾巴排完后两只都在 placed 里，链条自洽
  assert.strictEqual(placed.get('0,65,0'), 'hopper')
  assert.strictEqual(placed.get('1,65,0'), 'hopper')

  // 一只普通漏斗（参照已在场）走的是「保留原位」那条路
  const solo = { kind: 'place', blockName: 'hopper', position: { x: 5, y: 65, z: 5 }, states: { facing: 'down' } }
  const soloPlaced = new Map([['5,64,5', 'stone_bricks']])
  const soloResult = scheduleClickedFaceReferenceSteps([solo], soloPlaced)
  assert.strictEqual(soloResult.deferred.length, 0)
  assert.deepStrictEqual(soloResult.scheduled[0].clickedFaceReference,
    { position: { x: 5, y: 64, z: 5 }, face: 'up', facing: 'down' })
}

// ---------------------------------------------------------------------------
// 8 门楼：#76 那种互指漏斗对，改后 0 处「没人告诉她点哪儿」
function testGatehouseHoppersAreAnswered () {
  // 与 clickable-reference-order 同一份自制夹具（门楼 394 块）
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const steps = compiled.legacy.orderPlan.steps.filter(step => step.kind === 'place')
  const hoppers = steps.filter(step => step.blockName === 'hopper')
  assert.strictEqual(hoppers.length, 2)

  const index = new Map(steps.map((step, position) => [posKey(step.position), position]))
  const unanswered = []
  for (const hopper of hoppers) {
    const reference = hopper.clickedFaceReference
    if (!reference) { unanswered.push(posKey(hopper.position)); continue }
    const referenceKey = posKey(reference.position)
    const inPlaceBefore = index.has(referenceKey) && index.get(referenceKey) < index.get(posKey(hopper.position))
    if (!inPlaceBefore && !hopper.temporaryReference) unanswered.push(posKey(hopper.position))
  }
  assert.deepStrictEqual(unanswered, [], `fort hoppers still unanswered: ${unanswered.join(' ')}`)

  const west = hoppers.find(step => posKey(step.position) === '4,70,7')
  const east = hoppers.find(step => posKey(step.position) === '5,70,7')
  assert.ok(west && east)
  assert.deepStrictEqual(west.clickedFaceReference,
    { position: { x: 5, y: 70, z: 7 }, face: 'west', facing: 'east' })
  assert.deepStrictEqual(west.temporaryReference, { position: { x: 5, y: 70, z: 7 }, face: 'west' })
  assert.deepStrictEqual(east.clickedFaceReference,
    { position: { x: 4, y: 70, z: 7 }, face: 'east', facing: 'west' })
  assert.strictEqual(east.temporaryReference, undefined)
  assert.ok(index.get('4,70,7') < index.get('5,70,7'))
  assert.strictEqual(compiled.legacy.orderPlan.summary.clickedFaceTemporaryReferences, 1)
  // 金值：自制门楼夹具在当前序列下的 planId（换夹具时重算，见发布反馈）
  assert.strictEqual(compiled.plan.planId, 'construction_plan_7909a3fae1cc')
}

// ---------------------------------------------------------------------------
// 9 回归护栏：没有漏斗的图纸，序列一个字节都不变
function testBlueprintsWithoutHoppersAreUntouched () {
  const generated = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin')
  assert.strictEqual(generated.ok, true, generated.error)
  const cabinPlan = compileLegacy(generated.blueprint, { x: 0, y: 64, z: 0 })
  assert.strictEqual(cabinPlan.plan.planId, 'construction_plan_126d9aa6f555')
  assert.strictEqual(cabinPlan.legacy.orderPlan.summary.clickedFaceReferenceDeferred, 0)
}

testRequirementFollowsTheOrientationTable()
testMutualHopperPairGetsAPlaceableOrder()
testThreeHopperCycleStillGetsOnePlaceableOrder()
testHopperPointingAtALaterPlainBlockIsJustDelayed()
testOrdinaryHopperKeepsItsSlot()
testPassIsIdentityWithoutClickedFaceBlocks()
testSchedulerAndTailContracts()
testGatehouseHoppersAreAnswered()
testBlueprintsWithoutHoppersAreUntouched()

console.log('clicked face reference order tests passed')
