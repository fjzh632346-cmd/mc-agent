const assert = require('assert')
const path = require('path')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')
const { itemRequirementsForBlock } = require('../utils/building-material-map')
const {
  orderDeferredAxisSteps,
  planBuildOrder,
  posKey,
  scheduleAxisReferenceSteps,
  isRedstonePowerSourceBlockName
} = require('../utils/site-planner')

// Pins the round-6 logistics-lane fix for the "placement order deadlock"
// (building lane round 11, a gatehouse build): axis blocks
// (logs/stems, states.axis) take their axis from the clicked face, so they
// need a reference ON that axis. The planner used to be axis-agnostic
// (any neighbour counted as support; blueprint IR carries no axis
// dependencies), so a y=72 beam grid was scheduled bottom-up/nearest-first
// with its only same-axis neighbours later in the sequence — every such step
// died with stateful_axis_no_*_reference and the task restarted on the same
// block. The fix lives in planBuildOrder: a stable pass holds an axis step
// until a same-axis reference is scheduled and defers the rest to the tail.

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
  return { plan, keys: plan.steps.filter(step => step.kind === 'place').map(step => posKey(step.position)) }
}

const log = (x, y, z, axis, type = 'oak_log') => ({ type, position: { x, y, z }, states: { axis }, phase: 'frame' })
const solid = (x, y, z, type = 'stone_bricks') => ({ type, position: { x, y, z }, phase: 'wall' })

// ---------------------------------------------------------------------------
// 正向：参照物排在依赖者之后 → 修后参照物在前，梁沿锚点方向依次接上
function testAnchorScheduledLaterIsPulledAhead () {
  // Beam y=65 floating one block above ground: logs axis=x at x=0..2, the only
  // x-face reference is a stone block at x=3 (farther from the origin, so the
  // distance sort used to put it last).
  const world = [log(0, 65, 0, 'x'), log(1, 65, 0, 'x'), log(2, 65, 0, 'x'), solid(3, 65, 0)]
  const { plan, keys } = placeOrder(world)
  assert.deepStrictEqual(keys, ['3,65,0', '2,65,0', '1,65,0', '0,65,0'], JSON.stringify(keys))
  assert.strictEqual(plan.summary.axisReferenceDeferred, 0)
  assert.ok(plan.steps.every(step => step.deferredReason === undefined))
}

// 正向：y 轴柱子靠上方的砖头当参照（门楼 603,72,-3 的形态）
function testColumnAnchoredAboveWaitsForTheBrick () {
  // Floating column: the wall at x=1 stands on terrain (y=64), the log at
  // (0,65,0) has air below and its only y-face reference is the brick above.
  const world = [solid(1, 64, 0), solid(1, 65, 0), solid(1, 66, 0), log(0, 65, 0, 'y'), solid(0, 66, 0, 'chiseled_stone_bricks')]
  const { plan, keys } = placeOrder(world)
  assert.ok(keys.indexOf('0,66,0') < keys.indexOf('0,65,0'), JSON.stringify(keys))
  assert.strictEqual(keys.indexOf('0,65,0'), keys.indexOf('0,66,0') + 1, JSON.stringify(keys))
  assert.strictEqual(plan.summary.axisReferenceDeferred, 0)
}

// 反向：无轴向块的序列，顺序零变化
function testSequenceWithoutAxisBlocksIsUntouched () {
  const steps = [
    { kind: 'place', position: { x: 0, y: 64, z: 0 }, blockName: 'stone_bricks' },
    { kind: 'place', position: { x: 1, y: 64, z: 0 }, blockName: 'oak_planks' },
    { kind: 'place', position: { x: 1, y: 65, z: 0 }, blockName: 'oak_door', states: { half: 'lower' } },
    { kind: 'place', position: { x: 0, y: 65, z: 0 }, blockName: 'glass' }
  ]
  const result = scheduleAxisReferenceSteps(steps, new Map())
  assert.deepStrictEqual(result.scheduled, steps)
  assert.deepStrictEqual(result.deferred, [])

  const world = [solid(0, 64, 0), solid(1, 64, 0), solid(0, 65, 0, 'glass'), solid(1, 65, 0, 'oak_planks')]
  const { plan, keys } = placeOrder(world)
  assert.deepStrictEqual(keys, ['0,64,0', '1,64,0', '0,65,0', '1,65,0'])
  assert.strictEqual(plan.summary.axisReferenceDeferred, 0)
}

// 反向：轴向块本来就有同轴参照（地形/已放方块）→ 顺序零变化
function testAxisBlockWithReferenceAlreadyPresentKeepsItsSlot () {
  const world = [log(0, 64, 0, 'y'), solid(1, 64, 0), log(2, 64, 0, 'y')]
  const { plan, keys } = placeOrder(world)
  assert.deepStrictEqual(keys, ['0,64,0', '1,64,0', '2,64,0'])
  assert.strictEqual(plan.summary.axisReferenceDeferred, 0)
}

// 兜底：依赖环 / 无锚点 → 推迟到序列末尾、打标、链序有效、不死循环
function testUnanchoredRunIsDeferredToTheTailInChainOrder () {
  // z-beam at y=66 with nothing on the z axis at either end; a wall next to it
  // keeps the rest of the sequence non-trivial.
  const world = [
    solid(0, 64, 0), solid(0, 65, 0), solid(0, 66, 0),
    log(2, 66, 0, 'z'), log(2, 66, 1, 'z'), log(2, 66, 2, 'z'),
    solid(4, 64, 0), solid(4, 65, 0)
  ]
  const { plan, keys } = placeOrder(world)
  const deferred = plan.steps.filter(step => step.deferredReason === 'axis_reference_unresolved')
  assert.strictEqual(deferred.length, 3, JSON.stringify(keys))
  assert.strictEqual(plan.summary.axisReferenceDeferred, 3)
  assert.strictEqual(plan.summary.axisReferenceRoots, 1)
  assert.strictEqual(deferred[0].axisReferenceRoot, true)
  assert.strictEqual(deferred[1].axisReferenceRoot, false)
  // tail sits after every other placement and before validate
  const lastNonDeferred = Math.max(...plan.steps.map((step, index) => step.kind === 'place' && !step.deferredReason ? index : -1))
  const firstDeferred = plan.steps.findIndex(step => step.deferredReason)
  assert.ok(firstDeferred > lastNonDeferred)
  assert.strictEqual(plan.steps[plan.steps.length - 1].kind, 'validate')
  // chain order: each non-root leans on the previously emitted neighbour
  const tail = deferred.map(step => posKey(step.position))
  assert.deepStrictEqual(tail.slice().sort(), ['2,66,0', '2,66,1', '2,66,2'])
  for (let index = 1; index < deferred.length; index++) {
    const prev = deferred.slice(0, index).map(step => posKey(step.position))
    const { x, y, z } = deferred[index].position
    assert.ok(prev.includes(posKey({ x, y, z: z - 1 })) || prev.includes(posKey({ x, y, z: z + 1 })), tail.join(' > '))
  }
  // the non-axis steps keep their relative order exactly
  const others = keys.filter(key => !tail.includes(key))
  assert.deepStrictEqual(others, ['0,64,0', '4,64,0', '0,65,0', '4,65,0', '0,66,0'])
  // stable step ids survive the deferral flag (resume keys stay valid)
  assert.ok(deferred.every(step => step.position && step.blockName))
}

// 兜底：根节点挑「物理上悬空」的那块，让「梁搭在柱上」先立柱再架梁
function testRootPrefersPhysicallyFloatingStep () {
  const steps = [
    { kind: 'place', position: { x: 0, y: 70, z: 0 }, blockName: 'dark_oak_log', states: { axis: 'x' } },
    { kind: 'place', position: { x: 1, y: 70, z: 0 }, blockName: 'dark_oak_log', states: { axis: 'y' } }
  ]
  const ordered = orderDeferredAxisSteps(steps, new Map())
  assert.strictEqual(posKey(ordered[0].position), '1,70,0')
  assert.strictEqual(ordered[0].axisReferenceRoot, true)
  assert.strictEqual(ordered[1].axisReferenceRoot, false)
}

// ---------------------------------------------------------------------------
// 自制门楼固定件（tests/fixtures/gatehouse-axis.json）— 用生产链编出序列，按序模拟，错序违例必须为 0
function inventoryFor (blueprint) {
  const inv = { dirt: 5000, cobblestone: 5000, stone: 5000 }
  for (const block of blueprint.blocks) {
    if (!block.type || /air$/.test(block.type)) continue
    for (const [item, count] of Object.entries(itemRequirementsForBlock(block.type, block.states || {}))) inv[item] = (inv[item] || 0) + count * 2
    inv[block.type] = (inv[block.type] || 0) + 4
  }
  return inv
}

function compileLegacy (legacy, origin) {
  const adapted = new LegacyBlueprintAdapter().fromLegacyBlueprint(legacy)
  assert.strictEqual(adapted.ok, true, adapted.error)
  const validation = new BlueprintValidator().validate(adapted.blueprint)
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics.slice(0, 3)))
  const inv = inventoryFor(legacy)
  const compiled = new ConstructionCompiler().compile({
    blueprint: validation.blueprint,
    placementContext: { origin, rotationY: 0 },
    siteSnapshot: { blocks: [], inventoryCounts: inv },
    inventoryPolicy: { counts: inv },
    compilerOptions: { includeWalkabilityGate: true }
  })
  assert.strictEqual(compiled.ok, true, compiled.error)
  return compiled
}

const AXIS_RE = /(_log|_wood|_stem|_hyphae)$/
const NON_REF = [/_door$/, /trapdoor$/, /ladder$/, /torch$/, /button$/, /pressure_plate$/, /carpet$/, /_bed$/, /^bed$/, /sign$/, /banner$/, /flower$/, /^lantern$/, /^flower_pot$/, /^(short_)?grass$/, /^potted_/, /sapling$/, /water$/, /lava$/, /air$/]
const isRef = name => name === '__terrain__' || (Boolean(name) && !NON_REF.some(re => re.test(name)))
const axisOffsets = axis => axis === 'x'
  ? [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }]
  : axis === 'z' ? [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }] : [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }]

// Replays the sequence: an axis step is an ordering violation when no
// same-axis reference has been scheduled before it and the planner did not
// flag it as deferred (deferred roots lean on the runtime temp reference).
function replay (compiled) {
  const steps = compiled.legacy.orderPlan.steps
  const world = compiled.legacy.worldBlocks
  const minY = Math.min(...world.map(b => b.position.y))
  const placed = new Map()
  for (const block of world) placed.set(`${block.position.x},${minY - 1},${block.position.z}`, '__terrain__')
  const violations = []
  const deferred = []
  let axisSteps = 0
  for (const step of steps) {
    if (step.kind === 'scaffold_remove') { placed.delete(posKey(step.position)); continue }
    if (!['place', 'foundation_fill', 'scaffold_place'].includes(step.kind) || !step.position) continue
    const axis = String((step.states || step.orientation || {}).axis || '').toLowerCase()
    if (step.kind === 'place' && AXIS_RE.test(step.blockName) && axis) {
      axisSteps++
      const hasRef = axisOffsets(axis).some(o => isRef(placed.get(`${step.position.x + o.x},${step.position.y + o.y},${step.position.z + o.z}`)))
      if (step.deferredReason === 'axis_reference_unresolved') deferred.push(step)
      else if (!hasRef) violations.push(posKey(step.position))
    }
    placed.set(posKey(step.position), step.blockName)
  }
  return { axisSteps, violations, deferred }
}

function testGatehouseSequenceHasNoOrderingViolations () {
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const result = replay(compiled)
  assert.strictEqual(result.axisSteps, 34)
  assert.deepStrictEqual(result.violations, [], `ordering violations: ${result.violations.join(' ')}`)
  assert.ok(result.deferred.length > 0)
  assert.strictEqual(compiled.legacy.orderPlan.summary.axisReferenceDeferred, result.deferred.length)
  const roots = result.deferred.filter(step => step.axisReferenceRoot)
  assert.ok(roots.length > 0 && roots.length <= 14, `roots=${roots.length}`)
  // the floating beam on posts is no longer scheduled ahead of its reference
  const deferredKeys = new Set(result.deferred.map(step => posKey(step.position)))
  for (const key of ['2,71,2', '2,71,6', '5,71,4']) {
    assert.ok(deferredKeys.has(key) || !result.violations.includes(key), key)
  }
  // Deferred steps sit behind the regular placements. The only regular steps
  // allowed after them are the ones the compiler's stable topological order
  // delays because they depend on a deferred step — round 7 added a second
  // deferred tail (clickable_reference_unresolved) and a wall torch hanging on a
  // deferred block follows its block there.
  const steps = compiled.legacy.orderPlan.steps
  const firstDeferred = steps.findIndex(step => step.deferredReason)
  assert.ok(firstDeferred > 0)
  const deferredIds = new Set(steps.filter(step => step.deferredReason).map(step => step.id))
  for (const step of steps.slice(firstDeferred)) {
    if (step.kind !== 'place' || step.deferredReason) continue
    // Round 14 (#64) adds one deliberate exception: blocks that switch a
    // circuit on go in after everything else, deferred tail included, so the
    // building is never energised while blocks are still arriving. They are
    // last by design, not because they lost a reference.
    if (isRedstonePowerSourceBlockName(step.blockName)) continue
    assert.ok((step.dependencies || []).some(id => deferredIds.has(id)),
      `regular step ${posKey(step.position)} must not sit behind the deferred tail`)
  }
  assert.ok(steps.slice(0, firstDeferred).filter(step => step.kind === 'place').length > 350)
}

// 编译器侧：依赖排序只推迟依赖者、不再把依赖项提前。门楼钉子——望柱
// 9,71..75,7 必须自下而上（先 70 的砖，再逐节柱子），挂在柱子上的梯子
// 9,75,8 跟在它依赖的那节原木后面，而不是把原木拽到自己前面
function testGatehouseColumnIsBuiltBottomUpAndLadderFollowsItsLog () {
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const steps = compiled.plan.steps
  const indexAt = (x, y, z) => steps.findIndex(step => step.target && step.target.x === x && step.target.y === y && step.target.z === z)
  const brick = indexAt(9, 70, 7)
  const column = [71, 72, 73, 74, 75].map(y => indexAt(9, y, 7))
  assert.ok(brick >= 0 && column.every(index => index >= 0))
  assert.ok(brick < column[0], `brick ${brick} column ${column.join(',')}`)
  for (let index = 1; index < column.length; index++) assert.ok(column[index - 1] < column[index], column.join(','))
  const ladder = indexAt(9, 75, 8)
  assert.ok(ladder > column[4], `ladder ${ladder} log ${column[4]}`)
  const ladderStep = steps[ladder]
  assert.ok(ladderStep.dependencies.includes(steps[column[4]].id))
}

// 本地小屋：屋脊 9 根 x 轴原木没有任何同轴锚点 → 整条推迟到末尾，不再错序
function testCabinRidgeIsDeferredNotMisordered () {
  const generated = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin')
  assert.strictEqual(generated.ok, true)
  const compiled = compileLegacy(generated.blueprint, { x: 0, y: 64, z: 0 })
  const result = replay(compiled)
  assert.strictEqual(result.axisSteps, 9)
  assert.deepStrictEqual(result.violations, [])
  assert.strictEqual(result.deferred.length, 9)
  assert.strictEqual(result.deferred.filter(step => step.axisReferenceRoot).length, 1)
}

function run () {
  testAnchorScheduledLaterIsPulledAhead()
  testColumnAnchoredAboveWaitsForTheBrick()
  testSequenceWithoutAxisBlocksIsUntouched()
  testAxisBlockWithReferenceAlreadyPresentKeepsItsSlot()
  testUnanchoredRunIsDeferredToTheTailInChainOrder()
  testRootPrefersPhysicallyFloatingStep()
  testGatehouseSequenceHasNoOrderingViolations()
  testGatehouseColumnIsBuiltBottomUpAndLadderFollowsItsLog()
  testCabinRidgeIsDeferredNotMisordered()
  console.log('axis reference order tests passed')
}

run()
