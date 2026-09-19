const assert = require('assert')
const path = require('path')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')
const { itemRequirementsForBlock } = require('../utils/building-material-map')
const { findReferenceBlockForPlacement } = require('../actions/build')
const {
  orderDeferredClickableSteps,
  planBuildOrder,
  posKey,
  scheduleClickableReferenceSteps,
  isRedstonePowerSourceBlockName
} = require('../utils/site-planner')

// Pins the round-7 logistics-lane fix for "悬空放置" (place_failed:unstable_air,
// building lane round 11, a gatehouse build). unstable_air is not a
// pre-placement check: actions/build.js places, re-reads the target and reports
// unstable_air when it is still air. That happens when every reference the
// executor can pick eats the right-click (hopper / repeater / comparator — they
// open a GUI or toggle, and shouldSneakForPlacementReference() does not sneak
// for them) or has no clickable face (redstone wire, rails). The live failures
// were exactly those: a sticky_piston next to a repeater, a brick on a hopper,
// a brick next to a redstone wire. tests/fixtures/gatehouse-axis.json (hand-made)
// carries the same shapes. The fix lives in planBuildOrder, beside the round-6
// axis pass: hold such a step until a clickable reference is scheduled, defer
// the ones the blueprint never provides to the tail.

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

const at = (x, y, z, type, states = null, phase = 'wall') => ({ type, position: { x, y, z }, states, phase })

// ---------------------------------------------------------------------------
// 1 正向：唯一先排的邻居是漏斗（右键会开界面，放不上）→ 修后先排一个能点的邻居
function testHopperOnlyReferenceWaitsForAClickableNeighbour () {
  const blocks = [
    at(0, 65, 0, 'hopper', { facing: 'down' }),
    at(0, 66, 0, 'stone_bricks'),
    at(1, 66, 0, 'stone_bricks')
  ]
  const { plan, keys } = placeOrder(blocks)
  assert.ok(keys.indexOf('1,66,0') < keys.indexOf('0,66,0'),
    `clickable neighbour must be scheduled first: ${keys.join(' | ')}`)
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
  assert.ok(plan.steps.every(step => step.deferredReason !== 'clickable_reference_unresolved'))
}

// ---------------------------------------------------------------------------
// 2 正向：唯一先排的邻居是红石线（没有可点的整面）→ 同样压后
function testRedstoneWireOnlyReferenceWaitsForAClickableNeighbour () {
  const blocks = [
    at(0, 65, 0, 'redstone_wire', { power: '0' }),
    at(0, 66, 0, 'stone_bricks'),
    at(1, 66, 0, 'stone_bricks')
  ]
  const { keys } = placeOrder(blocks)
  assert.ok(keys.indexOf('1,66,0') < keys.indexOf('0,66,0'),
    `clickable neighbour must be scheduled first: ${keys.join(' | ')}`)
}

// ---------------------------------------------------------------------------
// 3 反向：序列里没有「点不动」的方块 → 这一趟是恒等映射
function testPassIsIdentityWithoutUnclickableBlocks () {
  const steps = [
    { kind: 'place', position: { x: 0, y: 65, z: 0 }, blockName: 'stone_bricks' },
    { kind: 'place', position: { x: 0, y: 66, z: 0 }, blockName: 'stone_bricks' },
    { kind: 'place', position: { x: 1, y: 66, z: 0 }, blockName: 'oak_planks' }
  ]
  const placed = new Map([['0,64,0', '__terrain__']])
  const result = scheduleClickableReferenceSteps(steps, placed)
  assert.deepStrictEqual(result.scheduled, steps)
  assert.deepStrictEqual(result.deferred, [])

  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'stone_bricks'),
    at(1, 66, 0, 'oak_planks')
  ]
  const { plan, keys } = placeOrder(blocks)
  assert.deepStrictEqual(keys, ['0,65,0', '0,66,0', '1,66,0'])
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
  assert.strictEqual(plan.summary.clickableReferenceRoots, 0)
}

// ---------------------------------------------------------------------------
// 4 反向：本来就有能点的邻居 → 槽位不变（漏斗只是众多邻居之一）
function testStepKeepsItsSlotWhenAClickableNeighbourIsAlreadyThere () {
  const blocks = [
    at(0, 65, 0, 'hopper', { facing: 'down' }),
    at(1, 65, 0, 'stone_bricks'),
    at(1, 66, 0, 'stone_bricks'),
    at(0, 66, 0, 'stone_bricks')
  ]
  const { plan, keys } = placeOrder(blocks)
  assert.ok(keys.indexOf('1,66,0') < keys.indexOf('0,66,0'), keys.join(' | '))
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
  // 0,66,0 leans on 1,66,0, which is clickable: no step is flagged
  assert.ok(plan.steps.every(step => step.deferredReason !== 'clickable_reference_unresolved'))
}

// ---------------------------------------------------------------------------
// 5 反向：一个参照都没有的步不归这趟管（运行时会立临时参照柱）——错手抓了它
//   就会改动本来好好的序列
function testStepWithNoReferenceAtAllIsNotHeld () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(5, 68, 5, 'stone_bricks')
  ]
  const { plan, keys } = placeOrder(blocks)
  assert.deepStrictEqual(keys, ['0,65,0', '5,68,5'])
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
}

// ---------------------------------------------------------------------------
// 6 反向：侧挂块按侧挂口径判（梯子挂活板门是既有语义，不能被这趟改掉）
function testSideAttachedStepUsesSideAttachmentCaliber () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 1, 'dark_oak_trapdoor', { half: 'bottom', facing: 'south' }),
    at(0, 66, 0, 'ladder', { facing: 'north' })
  ]
  const { plan } = placeOrder(blocks)
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
  const ladder = plan.steps.find(step => step.blockName === 'ladder')
  assert.ok(ladder)
  assert.strictEqual(ladder.deferredReason, undefined)
}

// ---------------------------------------------------------------------------
// 7 兜底：图纸里唯一的邻居就是点不动的 → 推迟到末尾、打标、标根，其余步顺序不变
function testUnreachableStepIsDeferredToTheTail () {
  // isolate the target: its only neighbour ever is the hopper below it
  const isolated = [
    at(0, 65, 0, 'hopper', { facing: 'down' }),
    at(0, 66, 0, 'stone_bricks'),
    at(3, 65, 0, 'stone_bricks'),
    at(3, 66, 0, 'stone_bricks')
  ]
  // same blueprint with a clickable block under the target
  const control = isolated.map(block => block.type === 'hopper' ? at(0, 65, 0, 'stone_bricks') : block)
  const { plan, keys } = placeOrder(isolated)
  const deferred = plan.steps.filter(step => step.deferredReason === 'clickable_reference_unresolved')
  assert.strictEqual(deferred.length, 1, keys.join(' | '))
  assert.strictEqual(posKey(deferred[0].position), '0,66,0')
  assert.strictEqual(deferred[0].clickableReferenceRoot, true)
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 1)
  assert.strictEqual(plan.summary.clickableReferenceRoots, 1)
  // tail: after every regular placement, before validate
  const steps = plan.steps
  const lastRegular = Math.max(...steps.map((step, index) => step.kind === 'place' && !step.deferredReason ? index : -1))
  const firstDeferred = steps.findIndex(step => step.deferredReason)
  assert.ok(firstDeferred > lastRegular, `${firstDeferred} <= ${lastRegular}`)
  assert.strictEqual(steps[steps.length - 1].kind, 'validate')
  // everything else keeps its relative order
  const others = keys.filter(key => key !== '0,66,0')
  assert.deepStrictEqual(others, placeOrder(control).keys.filter(key => key !== '0,66,0'))
  assert.ok(others.length > 0)
}

// ---------------------------------------------------------------------------
// 8 兜底排序：链序有效（先能点的那个，再靠它的那个），根节点排最前
function testDeferredTailKeepsChainsValid () {
  // both steps only touch a hopper, so neither can start; the lower one is the
  // root (it stands on the temporary reference) and the upper one follows it
  const steps = [
    { kind: 'place', position: { x: 0, y: 67, z: 0 }, blockName: 'stone_bricks' },
    { kind: 'place', position: { x: 0, y: 66, z: 0 }, blockName: 'stone_bricks' }
  ]
  const placed = new Map([['0,65,0', 'hopper'], ['1,67,0', 'hopper']])
  const ordered = orderDeferredClickableSteps(steps, placed)
  assert.strictEqual(ordered.length, 2)
  assert.strictEqual(posKey(ordered[0].position), '0,66,0')
  assert.strictEqual(ordered[0].clickableReferenceRoot, true)
  assert.strictEqual(ordered[1].clickableReferenceRoot, false)
  assert.ok(ordered.every(step => step.deferredReason === 'clickable_reference_unresolved'))
}

// ---------------------------------------------------------------------------
// 自制门楼固定件（tests/fixtures/gatehouse-axis.json）
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

// Same caliber as the executor: right-click eaten by the block's own
// interaction (and shouldSneakForPlacementReference() does not sneak for it),
// or no clickable face at all.
const INTERACT_NO_SNEAK = new Set([
  'beacon', 'bell', 'cake', 'chiseled_bookshelf', 'comparator', 'crafter',
  'daylight_detector', 'decorated_pot', 'dispenser', 'dropper', 'hopper',
  'repeater', 'respawn_anchor'
])
const FLAT_NO_FACE = [/shulker_box$/, /^redstone_wire$/, /rail$/, /^tripwire$/, /^lily_pad$/, /^snow$/]
const unusable = name => INTERACT_NO_SNEAK.has(String(name || '')) || FLAT_NO_FACE.some(re => re.test(String(name || '')))

// Replays the sequence and asks the executor's own reference picker
// (findReferenceBlockForPlacement) what it would click at each step. All
// candidates unusable => the executor would report place_failed:unstable_air.
function replayUnstableAir (compiled) {
  const steps = compiled.legacy.orderPlan.steps
  const world = compiled.legacy.worldBlocks
  const minY = Math.min(...world.map(b => b.position.y))
  const placed = new Map()
  for (const block of world) placed.set(`${block.position.x},${minY - 1},${block.position.z}`, 'stone')
  const masked = new Set()
  const context = {
    bot: {
      blockAt (vec3) {
        if (!vec3) return null
        const key = `${vec3.x},${vec3.y},${vec3.z}`
        const name = masked.has(key) ? 'air' : (placed.get(key) || 'air')
        return { name, position: { x: vec3.x, y: vec3.y, z: vec3.z } }
      }
    }
  }
  const candidatesFor = (step) => {
    const out = []
    for (let i = 0; i < 6; i++) {
      const ref = findReferenceBlockForPlacement(context, step.position, step.blockName, step.states || step.orientation || {})
      if (!ref) break
      const key = posKey(ref.position)
      if (masked.has(key)) break
      out.push(ref.name)
      masked.add(key)
    }
    for (const _ of out) { /* keep parity with the loop below */ }
    masked.clear()
    return out
  }
  const hits = []
  for (const step of steps) {
    if (step.kind === 'scaffold_remove') { placed.delete(posKey(step.position)); continue }
    if (!['place', 'foundation_fill', 'scaffold_place'].includes(step.kind) || !step.position) continue
    if (step.kind === 'place') {
      const candidates = candidatesFor(step)
      if (candidates.length && candidates.every(unusable)) {
        hits.push({ key: posKey(step.position), blockName: step.blockName, deferredReason: step.deferredReason || null, candidates })
      }
    }
    placed.set(posKey(step.position), step.blockName)
  }
  return hits
}

// 9 门楼：会被判 unstable_air 的只剩图纸物理形态那一处（唯一邻居是中继器的
//    砖），且已被推迟到末尾并打标
function testGatehouseUnstableAirPointsAreScheduledOrDeferred () {
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const hits = replayUnstableAir(compiled)
  const keys = hits.map(hit => hit.key).sort()
  assert.deepStrictEqual(keys, ['6,71,1'],
    `unexpected unstable_air points: ${hits.map(h => `${h.key}(${h.candidates.join('/')})`).join(' ')}`)
  // a blueprint-form case (no clickable neighbour anywhere), pushed to the
  // tail with a reason instead of failing mid-build
  for (const hit of hits) assert.strictEqual(hit.deferredReason, 'clickable_reference_unresolved', hit.key)
  const summary = compiled.legacy.orderPlan.summary
  assert.strictEqual(summary.clickableReferenceDeferred, 1)
  assert.strictEqual(summary.clickableReferenceRoots, 1)
  // the sticky piston whose only early neighbour is a repeater is not one of them
  assert.ok(!keys.includes('6,66,3'))
  const steps = compiled.legacy.orderPlan.steps
  const lastRegular = Math.max(...steps.map((step, index) => step.kind === 'place' && !step.deferredReason ? index : -1))
  const firstClickableDeferred = steps.findIndex(step => step.deferredReason === 'clickable_reference_unresolved')
  const firstAxisDeferred = steps.findIndex(step => step.deferredReason === 'axis_reference_unresolved')
  assert.ok(firstAxisDeferred >= 0 && firstAxisDeferred < firstClickableDeferred,
    `axis tail ${firstAxisDeferred} must stay ahead of the clickable tail ${firstClickableDeferred}`)
  // Before round 14 the only regular step after the tail was a wall torch the
  // compiler pushed behind the block it depends on (here 4,71,7). Since #64 the
  // whole power-source group sits there on purpose — and that torch is one of
  // them, so what follows the tail is exactly that group and nothing else.
  assert.ok(lastRegular > firstClickableDeferred)
  const afterTail = steps.slice(firstClickableDeferred)
    .filter(step => step.kind === 'place' && !step.deferredReason)
  assert.deepStrictEqual(
    afterTail.filter(step => !isRedstonePowerSourceBlockName(step.blockName)).map(step => posKey(step.position)),
    [],
    'a step that is not a power source ended up behind the deferred tail'
  )
  assert.ok(afterTail.some(step => posKey(step.position) === '4,71,7'))
  assert.ok(isRedstonePowerSourceBlockName(steps[lastRegular].blockName))
}

// 10 门楼轴向不回退：第 6 轮那趟的保证（每个轴向步都跟在同轴参照之后）仍然成立
const AXIS_RE = /(_log|_wood|_stem|_hyphae)$/
const NON_REF = [/_door$/, /trapdoor$/, /ladder$/, /torch$/, /button$/, /pressure_plate$/, /carpet$/, /_bed$/, /^bed$/, /sign$/, /banner$/, /flower$/, /^lantern$/, /^flower_pot$/, /^(short_)?grass$/, /^potted_/, /sapling$/, /water$/, /lava$/, /air$/]
const isRef = name => name === '__terrain__' || (Boolean(name) && !NON_REF.some(re => re.test(name)))
const axisOffsets = axis => axis === 'x'
  ? [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }]
  : axis === 'z' ? [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }] : [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }]

function testGatehouseAxisGuaranteeStillHolds () {
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const steps = compiled.legacy.orderPlan.steps
  const world = compiled.legacy.worldBlocks
  const minY = Math.min(...world.map(b => b.position.y))
  const placed = new Map()
  for (const block of world) placed.set(`${block.position.x},${minY - 1},${block.position.z}`, '__terrain__')
  const violations = []
  let axisSteps = 0
  for (const step of steps) {
    if (step.kind === 'scaffold_remove') { placed.delete(posKey(step.position)); continue }
    if (!['place', 'foundation_fill', 'scaffold_place'].includes(step.kind) || !step.position) continue
    const axis = String((step.states || step.orientation || {}).axis || '').toLowerCase()
    if (step.kind === 'place' && AXIS_RE.test(step.blockName) && axis) {
      axisSteps++
      const hasRef = axisOffsets(axis).some(o => isRef(placed.get(`${step.position.x + o.x},${step.position.y + o.y},${step.position.z + o.z}`)))
      if (!hasRef && step.deferredReason !== 'axis_reference_unresolved') violations.push(posKey(step.position))
    }
    placed.set(posKey(step.position), step.blockName)
  }
  assert.strictEqual(axisSteps, 34)
  assert.deepStrictEqual(violations, [], `axis ordering regressed: ${violations.join(' ')}`)
  assert.strictEqual(compiled.legacy.orderPlan.summary.axisReferenceDeferred, 5)
}

// 12 本地图纸回归：小屋序列也不变（第 6 轮记下的金值）
function testLocalCabinPlanIsUnchanged () {
  const generated = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin')
  assert.strictEqual(generated.ok, true, generated.error)
  const compiled = compileLegacy(generated.blueprint, { x: 0, y: 64, z: 0 })
  assert.strictEqual(compiled.plan.planId, 'construction_plan_126d9aa6f555')
  assert.strictEqual(compiled.legacy.orderPlan.summary.clickableReferenceDeferred, 0)
  assert.strictEqual(replayUnstableAir(compiled).length, 0)
}

testHopperOnlyReferenceWaitsForAClickableNeighbour()
testRedstoneWireOnlyReferenceWaitsForAClickableNeighbour()
testPassIsIdentityWithoutUnclickableBlocks()
testStepKeepsItsSlotWhenAClickableNeighbourIsAlreadyThere()
testStepWithNoReferenceAtAllIsNotHeld()
testSideAttachedStepUsesSideAttachmentCaliber()
testUnreachableStepIsDeferredToTheTail()
testDeferredTailKeepsChainsValid()
testGatehouseUnstableAirPointsAreScheduledOrDeferred()
testGatehouseAxisGuaranteeStillHolds()
testLocalCabinPlanIsUnchanged()

console.log('clickable reference order tests passed')
