const assert = require('assert')
const path = require('path')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')
const { itemRequirementsForBlock } = require('../utils/building-material-map')
const {
  isRedstonePowerSourceBlockName,
  planBuildOrder,
  posKey,
  requiredFaceAttachmentOffsets
} = require('../utils/site-planner')
const { _test: { stepStateMatches, isComparablePlacementStateKey } } = require('../systems/building-system')
const { _test: { isComparableStateKey } } = require('../systems/faithful-community-validator')
const {
  placementLookDirection,
  lookTowardDirection,
  expectedPlacementStateKeys,
  expectedPlacementStateMismatch,
  statefulPlacementProfile,
  postPlaceTunedStateKeys,
  alignPostPlaceTunedStates,
  orientedPlacementLookDirection,
  placeBlockAgainstReference,
  placementLookAngles,
  ORIENTED_PLACEMENT_FACING_RULES
} = require('../actions/build')

// Logistics lane round 9, the "state mismatch" family on oriented blocks.
// Two layers, both first measured on a real gatehouse build (now pinned on the
// hand-made tests/fixtures/gatehouse-axis.json):
//
//  (a) planner — a button or lever has exactly ONE neighbour that can be
//      clicked (face says floor/ceiling/wall; for a wall, facing says which
//      side). The planner used to schedule 7 of the gate's buttons before that
//      neighbour, so the executor had to click something else and the state
//      gate failed the step (live: facing:west!=east in round 14 task #4,
//      face:wall!=ceiling in round 11).
//
//  (c) reconciliation — stepStateMatches() compared states that placing a
//      block item cannot produce (redstone-wire connections, stair shape,
//      powered/power/extended/triggered/enabled/locked, signal-driven lit).
//      Every resume marked those already-correct blocks state_repair, broke
//      them and placed them again with the identical result. 143 such steps on
//      the gate before, 5 after (the repeater delays, which a post-place
//      right-click could reach — that gap is the placement layer's).

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
// 1 必需挂靠面的方向表（墙按钮 facing 反过来指向支撑块）
function testRequiredFaceAttachmentOffsets () {
  const button = (states) => ({ kind: 'place', blockName: 'dark_oak_button', position: { x: 0, y: 0, z: 0 }, states })
  assert.deepStrictEqual(requiredFaceAttachmentOffsets(button({ face: 'ceiling' })), [{ x: 0, y: 1, z: 0 }])
  assert.deepStrictEqual(requiredFaceAttachmentOffsets(button({ face: 'floor' })), [{ x: 0, y: -1, z: 0 }])
  assert.deepStrictEqual(requiredFaceAttachmentOffsets(button({ face: 'wall', facing: 'east' })), [{ x: -1, y: 0, z: 0 }])
  assert.deepStrictEqual(requiredFaceAttachmentOffsets(button({ face: 'wall', facing: 'west' })), [{ x: 1, y: 0, z: 0 }])
  assert.deepStrictEqual(requiredFaceAttachmentOffsets(button({ face: 'wall', facing: 'north' })), [{ x: 0, y: 0, z: 1 }])
  assert.deepStrictEqual(requiredFaceAttachmentOffsets(button({ face: 'wall', facing: 'south' })), [{ x: 0, y: 0, z: -1 }])
  assert.deepStrictEqual(requiredFaceAttachmentOffsets({ ...button({ face: 'wall', facing: 'east' }), blockName: 'lever' }), [{ x: -1, y: 0, z: 0 }])
  // not a face-attached block, or no usable state -> no requirement
  assert.strictEqual(requiredFaceAttachmentOffsets(button({})), null)
  assert.strictEqual(requiredFaceAttachmentOffsets(button({ face: 'wall' })), null)
  assert.strictEqual(requiredFaceAttachmentOffsets({ kind: 'place', blockName: 'stone_bricks', position: { x: 0, y: 0, z: 0 } }), null)
}

// ---------------------------------------------------------------------------
// 2 正向：天花按钮的支撑在上方，原本排在它后面 → 修后支撑先到位
function testCeilingButtonWaitsForTheBlockAboveIt () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'stone_bricks'),
    // the button sits under a block that the default order schedules later
    at(0, 67, 0, 'dark_oak_button', { face: 'ceiling', facing: 'east' }),
    at(0, 68, 0, 'chiseled_deepslate')
  ]
  const { keys } = placeOrder(blocks)
  assert.ok(keys.indexOf('0,68,0') < keys.indexOf('0,67,0'),
    `the ceiling support must be scheduled first: ${keys.join(' | ')}`)
}

// ---------------------------------------------------------------------------
// 3 正向：墙按钮只认 facing 指定的那一侧，别的邻居先到位也不算
function testWallButtonWaitsForTheSideItsFacingNames () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'dark_oak_button', { face: 'wall', facing: 'east' }),
    at(-1, 66, 0, 'stone_bricks'),   // required (facing east -> support west)
    at(1, 66, 0, 'stone_bricks')     // a decoy on the other side
  ]
  const { keys } = placeOrder(blocks)
  assert.ok(keys.indexOf('-1,66,0') < keys.indexOf('0,66,0'),
    `the west support must come first: ${keys.join(' | ')}`)
}

// ---------------------------------------------------------------------------
// 4 反向：支撑本来就先到位 → 槽位不变，这一趟是恒等映射
function testNoReorderWhenTheSupportIsAlreadyFirst () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'stone_bricks'),
    at(1, 66, 0, 'dark_oak_button', { face: 'wall', facing: 'east' })
  ]
  const { plan, keys } = placeOrder(blocks)
  assert.deepStrictEqual(keys, ['0,65,0', '0,66,0', '1,66,0'])
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
}

// ---------------------------------------------------------------------------
// 5 反向：没有 face/facing 的按钮不被这条约束抓住
function testButtonWithoutFaceStatesIsUntouched () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'dark_oak_button'),
    at(1, 66, 0, 'stone_bricks')
  ]
  const { plan, keys } = placeOrder(blocks)
  // 第 14 轮（#64）起按钮属于「能通电的」，整栋最后放——所以它现在排在两块砖
  // 后面。这一组要钉的仍是「没有 face/facing 的按钮不会被参照约束推迟」，
  // 也就是下面那个 0。
  assert.deepStrictEqual(keys, ['0,65,0', '1,66,0', '0,66,0'])
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 0)
}

// ---------------------------------------------------------------------------
// 6 兜底：图纸里根本没有那个支撑 → 推迟到末尾并打标，而不是半路失败
function testButtonWithNoSupportInTheBlueprintIsDeferred () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'stone_bricks'),
    // ceiling button with nothing above it anywhere in the blueprint
    at(3, 66, 0, 'dark_oak_button', { face: 'ceiling', facing: 'east' }),
    at(3, 65, 0, 'stone_bricks')
  ]
  const { plan } = placeOrder(blocks)
  const deferred = plan.steps.filter(step => step.deferredReason === 'clickable_reference_unresolved')
  assert.strictEqual(deferred.length, 1)
  assert.strictEqual(posKey(deferred[0].position), '3,66,0')
  assert.strictEqual(plan.summary.clickableReferenceDeferred, 1)
  const lastRegular = Math.max(...plan.steps.map((step, index) => step.kind === 'place' && !step.deferredReason ? index : -1))
  assert.ok(plan.steps.findIndex(step => step.deferredReason) > lastRegular)
}

// ---------------------------------------------------------------------------
// 对账比对：放置产生不了的状态不再参与
const stepFor = (blockName, states) => ({ kind: 'place', blockName, position: { x: 0, y: 0, z: 0 }, states })

function testUnreachableStatesAreNoLongerCompared () {
  // live signal values
  assert.strictEqual(stepStateMatches({ powered: 'false' }, stepFor('comparator', { powered: 'true' })), true)
  assert.strictEqual(stepStateMatches({ power: '0' }, stepFor('redstone_wire', { power: '15' })), true)
  assert.strictEqual(stepStateMatches({ extended: 'false' }, stepFor('sticky_piston', { extended: 'true' })), true)
  assert.strictEqual(stepStateMatches({ triggered: 'false' }, stepFor('dropper', { triggered: 'true' })), true)
  assert.strictEqual(stepStateMatches({ enabled: 'true' }, stepFor('hopper', { enabled: 'false' })), true)
  assert.strictEqual(stepStateMatches({ locked: 'false' }, stepFor('repeater', { locked: 'true' })), true)
  assert.strictEqual(stepStateMatches({ lit: 'true' }, stepFor('redstone_torch', { lit: 'false' })), true)
  // neighbour-derived shapes
  assert.strictEqual(stepStateMatches({ north: 'none', south: 'none' }, stepFor('redstone_wire', { north: 'side', south: 'up' })), true)
  assert.strictEqual(stepStateMatches({ shape: 'straight' }, stepFor('tuff_brick_stairs', { shape: 'inner_left' })), true)
}

function testReachableStatesAreStillCompared () {
  // the clicked face and the look direction stay enforced
  assert.strictEqual(stepStateMatches({ face: 'wall' }, stepFor('dark_oak_button', { face: 'ceiling' })), false)
  assert.strictEqual(stepStateMatches({ facing: 'west' }, stepFor('dark_oak_button', { facing: 'east' })), false)
  assert.strictEqual(stepStateMatches({ facing: 'west' }, stepFor('repeater', { facing: 'east' })), false)
  assert.strictEqual(stepStateMatches({ axis: 'x' }, stepFor('dark_oak_log', { axis: 'y' })), false)
  assert.strictEqual(stepStateMatches({ half: 'bottom' }, stepFor('tuff_brick_stairs', { half: 'top' })), false)
  assert.strictEqual(stepStateMatches({ type: 'bottom' }, stepFor('stone_brick_slab', { type: 'top' })), false)
  // `open` has a post-place toggle, so it must keep being checked
  assert.strictEqual(stepStateMatches({ open: 'false' }, stepFor('dark_oak_trapdoor', { open: 'true' })), false)
  assert.strictEqual(stepStateMatches({ open: 'false' }, stepFor('birch_door', { open: 'true' })), false)
  // a repeater delay is reachable with one extra right-click: still compared,
  // so the gap stays visible instead of being silently accepted
  assert.strictEqual(stepStateMatches({ delay: '1' }, stepFor('repeater', { delay: '2' })), false)
  assert.strictEqual(stepStateMatches({ mode: 'compare' }, stepFor('comparator', { mode: 'subtract' })), false)
  // and the pre-existing exclusions are untouched
  assert.strictEqual(stepStateMatches({ waterlogged: 'false' }, stepFor('tuff_brick_stairs', { waterlogged: 'true' })), true)
  assert.strictEqual(stepStateMatches({ north: 'false' }, stepFor('tuff_brick_wall', { north: 'low' })), true)
  assert.strictEqual(stepStateMatches({ hinge: 'left' }, stepFor('birch_door', { hinge: 'right' })), true)
}

// ---------------------------------------------------------------------------
// 自制门楼夹具：两层各自的数字
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

// Replays the sequence and asks: when this face-attached step comes up, has the
// one neighbour it may click been scheduled?
function replayFaceAttachment (compiled) {
  const steps = compiled.legacy.orderPlan.steps
  const world = compiled.legacy.worldBlocks
  const minY = Math.min(...world.map(b => b.position.y))
  const placed = new Set()
  for (const block of world) placed.add(`${block.position.x},${minY - 1},${block.position.z}`)
  const violations = []
  let faceAttached = 0
  for (const step of steps) {
    if (step.kind === 'scaffold_remove') { placed.delete(posKey(step.position)); continue }
    if (!['place', 'foundation_fill', 'scaffold_place'].includes(step.kind) || !step.position) continue
    const offsets = step.kind === 'place' ? requiredFaceAttachmentOffsets(step) : null
    if (offsets) {
      faceAttached++
      const ok = offsets.some(offset =>
        placed.has(`${step.position.x + offset.x},${step.position.y + offset.y},${step.position.z + offset.z}`))
      if (!ok && step.deferredReason !== 'clickable_reference_unresolved') violations.push(posKey(step.position))
    }
    placed.add(posKey(step.position))
  }
  return { faceAttached, violations }
}

function testGatehouseButtonsGetTheirSupportFirst () {
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const result = replayFaceAttachment(compiled)
  assert.strictEqual(result.faceAttached, 8, `face-attached steps=${result.faceAttached}`)
  assert.deepStrictEqual(result.violations, [],
    `buttons still scheduled before their support: ${result.violations.join(' ')}`)
}

// The gate's reconciliation load: only the repeater delays may remain
function testGatehouseHasNoUnreachableStateComparisonsLeft () {
  const fort = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const stuck = []
  for (const step of compiled.legacy.orderPlan.steps) {
    if (step.kind !== 'place') continue
    const states = step.states || step.orientation || {}
    for (const [key, value] of Object.entries(states)) {
      if (value == null) continue
      if (!['powered', 'power', 'extended', 'triggered', 'enabled', 'locked', 'shape'].includes(key)) continue
      const other = String(value) === 'true' ? 'false' : `${value}__alt`
      // every other state as placed, only this one differs
      if (stepStateMatches({ ...states, [key]: other }, step) === false) stuck.push(`${posKey(step.position)}:${step.blockName}:${key}`)
    }
  }
  assert.deepStrictEqual(stuck, [], `still compared: ${stuck.slice(0, 8).join(' ')}`)
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 后勤 14 · 能通电的方块整栋最后放（#64）
//
// 建造 20 真机：她按图纸顺序放了屋顶那根红石火把，电路当场通电，旁边的
// 活塞伸出，活塞头占住了隔壁一格 —— 而图纸还要往那一格放东西。续建把活塞头
// 当成障碍要清，同一格三次失败后停手。所以能主动供电的（红石火把、红石线、
// 拉杆、按钮、红石块、阳光探测器、压力板、标靶）等整栋盖完再放；不供电的红石件
// （活塞、中继器、比较器、侦测器、漏斗、投掷器、发射器）留在原处，它们还要当邻居的参照。
function testPowerSourceTableIsData () {
  for (const name of ['redstone_torch', 'redstone_wall_torch', 'redstone_block',
    'lever', 'daylight_detector', 'target', 'stone_button', 'dark_oak_button',
    'oak_pressure_plate', 'stone_pressure_plate']) {
    assert.strictEqual(isRedstonePowerSourceBlockName(name), true, `${name} 应算能通电的`)
  }
  // 反向一：通电了才动的那批不许被挪走，它们是邻居的参照
  for (const name of ['piston', 'sticky_piston', 'repeater', 'comparator', 'observer',
    'hopper', 'dropper', 'dispenser', 'stone', 'oak_planks']) {
    assert.strictEqual(isRedstonePowerSourceBlockName(name), false, `${name} 不该被挪到最后`)
  }
  // 反向二：红石线**故意**不在名单里。决策 #64 点名了它，但真机门楼有横梁
  // 的同轴参照就是红石线，挪走它们就没砖可点（tests/axis-reference-order 会变红）；
  // 而红石线自己不带电，没有火把/拉杆驱动时先铺好点不亮任何东西。
  assert.strictEqual(isRedstonePowerSourceBlockName('redstone_wire'), false)
}

function testPowerSourcesGoInLast () {
  const blocks = [
    at(0, 65, 0, 'stone_bricks'),
    at(0, 66, 0, 'redstone_torch'),
    at(1, 65, 0, 'stone_bricks'),
    at(1, 66, 0, 'piston', { facing: 'up' }),
    at(2, 65, 0, 'lever', { face: 'floor', facing: 'north' }),
    at(2, 66, 0, 'stone_bricks')
  ]
  const { plan, keys } = placeOrder(blocks)
  const placeSteps = plan.steps.filter(step => step.kind === 'place')
  const lastInert = placeSteps.reduce((last, step, index) =>
    isRedstonePowerSourceBlockName(step.blockName) ? last : index, -1)
  const firstPower = placeSteps.findIndex(step => isRedstonePowerSourceBlockName(step.blockName))
  assert.ok(firstPower > lastInert, `供电源没有全排在最后: ${placeSteps.map(s => s.blockName).join(' → ')}`)
  // 活塞是不供电的那一批，必须留在中间，别跟着走
  const pistonIndex = placeSteps.findIndex(step => step.blockName === 'piston')
  assert.ok(pistonIndex < firstPower, '活塞被当成供电源挪走了')

  // 变的只是顺序：位置+方块的多重集一个不多一个不少
  assert.deepStrictEqual(
    placeSteps.map(step => `${posKey(step.position)}|${step.blockName}`).sort(),
    blocks.map(block => `${posKey(block.position)}|${block.type}`).sort()
  )
  assert.strictEqual(keys.length, blocks.length)
}

function testGatehousePowerSourcesGoInLast () {
  // 自制门楼：11 步供电源（按钮 / 拉杆 / 红石火把 / 墙上火把）
  const fort = require(path.resolve(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const compiled = compileLegacy(fort, { x: 0, y: 64, z: 0 })
  const placeSteps = compiled.legacy.orderPlan.steps.filter(step => step.kind === 'place')
  const powerIndexes = []
  const inertIndexes = []
  placeSteps.forEach((step, index) => {
    if (isRedstonePowerSourceBlockName(step.blockName)) powerIndexes.push(index)
    else inertIndexes.push(index)
  })
  assert.ok(powerIndexes.length > 0, '门楼固定件里应该有供电源')
  assert.ok(
    powerIndexes[0] > inertIndexes[inertIndexes.length - 1],
    '门楼的供电源没有全排在最后'
  )
  // 多重集不变：块没多也没少
  const fromBlueprint = compiled.legacy.worldBlocks
    .filter(block => !/air$/.test(block.type))
    .map(block => `${posKey(block.position)}|${block.type}`)
    .sort()
  assert.deepStrictEqual(
    placeSteps.map(step => `${posKey(step.position)}|${step.blockName}`).sort(),
    fromBlueprint
  )
}

// 回归护栏：金值。
// 第 14 轮（#64）把「能通电的」方块挪到整栋最后放，所以**含这类方块的图纸**
// 编号会变。小屋一个都没有，编号必须一个字不变。
// 「变的只是顺序」由 testPowerSourcesGoInLast 的多重集断言负责证明。
function testGoldenPlanIdsUnchanged () {
  const generated = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin')
  assert.strictEqual(generated.ok, true, generated.error)
  assert.strictEqual(compileLegacy(generated.blueprint, { x: 0, y: 64, z: 0 }).plan.planId, 'construction_plan_126d9aa6f555')
}

testRequiredFaceAttachmentOffsets()
testCeilingButtonWaitsForTheBlockAboveIt()
testWallButtonWaitsForTheSideItsFacingNames()
testNoReorderWhenTheSupportIsAlreadyFirst()
testButtonWithoutFaceStatesIsUntouched()
testButtonWithNoSupportInTheBlueprintIsDeferred()
testUnreachableStatesAreNoLongerCompared()
testReachableStatesAreStillCompared()
testGatehouseButtonsGetTheirSupportFirst()
testGatehouseHasNoUnreachableStateComparisonsLeft()
// ---------------------------------------------------------------------------
// 后勤 11 · (b) 类「放得上但朝向随机」：放置前转身名单补全 + 俯仰 + 当场闸门
//
// 语义表来自修缮 10 的真机探测（创造模式固定视角放置，execute if block 读回）：
//   看东放 中继器/比较器/发射器/投掷器/活塞 → facing=west （朝向玩家）
//   看东放 侦测器                          → facing=east （背向玩家）
//   看东放 地板/天花按钮、拉杆              → facing=east （与视线同向）
//   看东放 漏斗                            → facing=down （只看点的那个面）
//   低头放 活塞/投掷器/发射器               → facing=up   （朝向玩家）
//   低头放 侦测器                          → facing=down （背向玩家）
//
// 每族都配反向断言：符号写反的症状是整族 180°，只有反向断言能钉住它。

const lookFor = (blockName, states) => placementLookDirection(blockName, states)

function testTowardPlayerFamilyHorizontal () {
  const cases = [
    ['repeater', 'west', { x: 1, z: 0 }],
    ['repeater', 'east', { x: -1, z: 0 }],
    ['comparator', 'south', { x: 0, z: -1 }],
    ['comparator', 'north', { x: 0, z: 1 }],
    ['dispenser', 'east', { x: -1, z: 0 }],
    ['dispenser', 'west', { x: 1, z: 0 }],
    ['dropper', 'north', { x: 0, z: 1 }],
    ['dropper', 'south', { x: 0, z: -1 }],
    ['piston', 'east', { x: -1, z: 0 }],
    ['sticky_piston', 'west', { x: 1, z: 0 }]
  ]
  for (const [blockName, facing, expected] of cases) {
    const look = lookFor(blockName, { facing })
    assert.ok(look, `${blockName} facing=${facing} 应该有转身方向了`)
    assert.strictEqual(look.x, expected.x, `${blockName} facing=${facing} look.x`)
    assert.strictEqual(look.z, expected.z, `${blockName} facing=${facing} look.z`)
    assert.strictEqual(look.y, 0, `${blockName} facing=${facing} 水平朝向不该带俯仰`)
    assert.strictEqual(look.facing, facing)
  }
}

function testObserverFacesAwayFromPlayer () {
  const north = lookFor('observer', { facing: 'north' })
  assert.deepStrictEqual({ x: north.x, y: north.y, z: north.z }, { x: 0, y: 0, z: -1 })
  const east = lookFor('observer', { facing: 'east' })
  assert.deepStrictEqual({ x: east.x, y: east.y, z: east.z }, { x: 1, y: 0, z: 0 })
  // 反向：同一个 facing，「朝向玩家」那一族必须是相反的看法
  assert.strictEqual(lookFor('repeater', { facing: 'north' }).z, -north.z)
  assert.strictEqual(lookFor('dispenser', { facing: 'east' }).x, -east.x)
}

function testVerticalFacingUsesPitch () {
  for (const blockName of ['piston', 'sticky_piston', 'dropper', 'dispenser']) {
    const up = lookFor(blockName, { facing: 'up' })
    assert.ok(up, `${blockName} facing=up 应该有转身方向`)
    assert.strictEqual(up.y, -1, `${blockName} facing=up 必须低头`)
    assert.strictEqual(up.x, 0)
    assert.strictEqual(up.z, 0)
    assert.strictEqual(lookFor(blockName, { facing: 'down' }).y, 1, `${blockName} facing=down 必须抬头`)
  }
  // 侦测器相反
  assert.strictEqual(lookFor('observer', { facing: 'up' }).y, 1)
  assert.strictEqual(lookFor('observer', { facing: 'down' }).y, -1)
}

function testHorizontalOnlyFamiliesRejectVerticalFacing () {
  // 中继器/比较器没有 up/down 档，给了也不能瞎转
  assert.strictEqual(lookFor('repeater', { facing: 'up' }), null)
  assert.strictEqual(lookFor('comparator', { facing: 'down' }), null)
}

function testHopperIsNotSolvableByLooking () {
  // 漏斗的 facing 是「点了哪个面」，转身解决不了 —— 表里把这件事写成数据
  assert.strictEqual(lookFor('hopper', { facing: 'east' }), null)
  assert.strictEqual(lookFor('hopper', { facing: 'down' }), null)
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.hopper.clickedFace, true)
}

function testFloorAndCeilingButtonsFollowTheLook () {
  const ceilingEast = lookFor('dark_oak_button', { face: 'ceiling', facing: 'east' })
  assert.deepStrictEqual({ x: ceilingEast.x, y: ceilingEast.y, z: ceilingEast.z }, { x: 1, y: 0, z: 0 })
  assert.strictEqual(lookFor('dark_oak_button', { face: 'ceiling', facing: 'west' }).x, -1)
  const floorNorth = lookFor('stone_button', { face: 'floor', facing: 'north' })
  assert.deepStrictEqual({ x: floorNorth.x, y: floorNorth.y, z: floorNorth.z }, { x: 0, y: 0, z: -1 })
  assert.strictEqual(lookFor('lever', { face: 'floor', facing: 'south' }).z, 1)
  // 反向：按钮与「朝向玩家」的一族符号相反
  assert.strictEqual(ceilingEast.x, -lookFor('repeater', { facing: 'east' }).x)
}

function testWallButtonsStillLetTheWallDecide () {
  assert.strictEqual(lookFor('dark_oak_button', { face: 'wall', facing: 'east' }), null)
  assert.strictEqual(lookFor('lever', { face: 'wall', facing: 'north' }), null)
}

function testUntouchedFamiliesKeepTheirDirection () {
  const furnace = lookFor('furnace', { facing: 'east' })
  // 熔炉族那条老写法会算出 -0，本轮没碰它，所以用 === 比（-0 === 0 为真）
  assert.strictEqual(furnace.x, -1)
  assert.ok(furnace.z === 0)
  assert.strictEqual(furnace.source, 'furnace_facing')
  const stairs = lookFor('oak_stairs', { facing: 'east', half: 'bottom' })
  assert.strictEqual(stairs.x, 1)
  assert.ok(stairs.z === 0)
  assert.strictEqual(lookFor('chest', { facing: 'north' }).z, 1)
  assert.strictEqual(lookFor('stone', {}), null)
  assert.strictEqual(lookFor('piston', {}), null)
}

function fakeLookContext () {
  const calls = []
  return {
    calls,
    context: {
      bot: {
        entity: { position: { x: 10.5, y: 64, z: 20.5 } },
        lookAt: async (target, force) => { calls.push({ target, force }) }
      },
      logger: { log: () => {} }
    }
  }
}

const LOOK_TARGET = { x: 10, y: 65, z: 20 }
const EYE_Y = 64 + 1.62

async function testLookTargetPitchSign () {
  const upCase = fakeLookContext()
  await lookTowardDirection(upCase.context, LOOK_TARGET, 'piston', lookFor('piston', { facing: 'up' }))
  const upLook = upCase.calls[0].target
  assert.ok(upLook.y < EYE_Y, 'facing=up 的视线目标必须在眼睛下方（低头）')
  assert.strictEqual(upLook.x, 10.5, '俯仰不许把左右转带歪')
  assert.strictEqual(upLook.z, 20.5)

  const downCase = fakeLookContext()
  await lookTowardDirection(downCase.context, LOOK_TARGET, 'piston', lookFor('piston', { facing: 'down' }))
  assert.ok(downCase.calls[0].target.y > EYE_Y, 'facing=down 的视线目标必须在眼睛上方（抬头）')

  const observerUp = fakeLookContext()
  await lookTowardDirection(observerUp.context, LOOK_TARGET, 'observer', lookFor('observer', { facing: 'up' }))
  assert.ok(observerUp.calls[0].target.y > EYE_Y, '侦测器 facing=up 要抬头，与活塞相反')
}

async function testHorizontalLookTargetUnchanged () {
  // 回归：水平朝向仍然是眼高、只左右转（第 9 轮之前就有的行为）
  const horizontal = fakeLookContext()
  await lookTowardDirection(horizontal.context, LOOK_TARGET, 'repeater', lookFor('repeater', { facing: 'west' }))
  assert.strictEqual(horizontal.calls[0].target.y, EYE_Y)
  assert.strictEqual(horizontal.calls[0].target.x, 10.5 + 4)
  assert.strictEqual(horizontal.calls[0].target.z, 20.5)

  const furnace = fakeLookContext()
  await lookTowardDirection(furnace.context, LOOK_TARGET, 'furnace', lookFor('furnace', { facing: 'east' }))
  assert.strictEqual(furnace.calls[0].target.y, EYE_Y)
  assert.strictEqual(furnace.calls[0].target.x, 10.5 - 4)
}

function testGateNowWatchesFacing () {
  for (const blockName of [
    'repeater', 'comparator', 'observer', 'piston', 'sticky_piston',
    'dropper', 'dispenser', 'hopper'
  ]) {
    assert.deepStrictEqual(
      expectedPlacementStateKeys(blockName, { facing: 'east' }),
      ['facing'],
      `${blockName} 的 facing 必须在放置当场就比`
    )
  }
  assert.deepStrictEqual(expectedPlacementStateKeys('lever', { face: 'floor', facing: 'east' }), ['face', 'facing'])
  assert.deepStrictEqual(expectedPlacementStateKeys('dark_oak_button', { face: 'ceiling', facing: 'east' }), ['face', 'facing'])
  // 运行时派生的状态不许混进闸门：放置动作产生不了它们，比了就是自找失败
  assert.deepStrictEqual(
    expectedPlacementStateKeys('piston', { facing: 'up', extended: 'false' }),
    ['facing']
  )
  assert.deepStrictEqual(
    expectedPlacementStateKeys('repeater', { facing: 'west', delay: '2', powered: 'false', locked: 'false' }),
    ['facing']
  )
  // 回归：名单外的方块仍然不比状态
  assert.deepStrictEqual(expectedPlacementStateKeys('stone', { facing: 'east' }), [])
  assert.deepStrictEqual(expectedPlacementStateKeys('oak_stairs', { half: 'top', facing: 'east' }), ['half', 'facing'])
}

const placedBlock = properties => ({ getProperties: () => properties })

function testGateReportsFacingMismatch () {
  const options = { requireStateConfirmation: true, blockStates: { facing: 'west' } }
  assert.strictEqual(
    expectedPlacementStateMismatch(placedBlock({ facing: 'north' }), 'repeater', options),
    'facing:north!=west'
  )
  assert.strictEqual(expectedPlacementStateMismatch(placedBlock({ facing: 'west' }), 'repeater', options), null)

  const pistonOptions = { requireStateConfirmation: true, blockStates: { facing: 'up' } }
  assert.strictEqual(
    expectedPlacementStateMismatch(placedBlock({ facing: 'north', extended: 'false' }), 'piston', pistonOptions),
    'facing:north!=up'
  )
  assert.strictEqual(
    expectedPlacementStateMismatch(placedBlock({ facing: 'up', extended: 'false' }), 'piston', pistonOptions),
    null
  )
  // 反向：不要求确认时闸门保持沉默（未改这条路径的回归）
  assert.strictEqual(
    expectedPlacementStateMismatch(placedBlock({ facing: 'north' }), 'repeater', { blockStates: { facing: 'west' } }),
    null
  )
}

const refAt = (x, y, z) => ({ position: { x, y, z }, name: 'stone' })
const BUTTON_TARGET = { x: 5, y: 70, z: -3 }

function testCeilingButtonPicksTheBlockAbove () {
  const profile = statefulPlacementProfile(
    'dark_oak_button',
    { face: 'ceiling', facing: 'east' },
    [refAt(5, 70, -4), refAt(5, 71, -3), refAt(5, 69, -3), refAt(6, 70, -3)],
    BUTTON_TARGET
  )
  assert.ok(profile, '天花按钮现在应该有自己的放置档')
  assert.strictEqual(profile.references.length, 1)
  assert.deepStrictEqual(profile.references[0].position, { x: 5, y: 71, z: -3 })
  assert.strictEqual(profile.orientBeforePlace, true)
  assert.strictEqual(profile.placeOptions.forceLook, 'ignore', '放置时必须保住转好的视线')
  assert.strictEqual(profile.label, 'button_ceiling_east')
}

function testFloorButtonPicksTheBlockBelow () {
  const profile = statefulPlacementProfile(
    'stone_button',
    { face: 'floor', facing: 'north' },
    [refAt(5, 71, -3), refAt(5, 69, -3)],
    BUTTON_TARGET
  )
  assert.strictEqual(profile.references.length, 1)
  assert.deepStrictEqual(profile.references[0].position, { x: 5, y: 69, z: -3 })
  assert.strictEqual(profile.noReferenceError, 'stateful_button_no_floor_reference')
}

function testWallButtonProfileUnchanged () {
  const profile = statefulPlacementProfile(
    'dark_oak_button',
    { face: 'wall', facing: 'west' },
    [refAt(6, 70, -3), refAt(5, 71, -3)],
    BUTTON_TARGET
  )
  assert.strictEqual(profile.label, 'button_wall_west')
  assert.strictEqual(profile.references.length, 1)
  assert.deepStrictEqual(profile.references[0].position, { x: 6, y: 70, z: -3 })
  assert.strictEqual(profile.placeOptions.forceLook, false)
}

function testCeilingButtonWithNoBlockAboveReportsIt () {
  const profile = statefulPlacementProfile(
    'dark_oak_button',
    { face: 'ceiling', facing: 'east' },
    [refAt(5, 69, -3)],
    BUTTON_TARGET
  )
  assert.strictEqual(profile.references.length, 0)
  assert.strictEqual(profile.noReferenceError, 'stateful_button_no_ceiling_reference')
}

function testTableStaysData () {
  // 符号留在表里，真机若发现整族反了只改这张表
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.repeater.sign, -1)
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.observer.sign, 1)
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.piston.vertical, true)
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.repeater.vertical, false)
  assert.strictEqual(ORIENTED_PLACEMENT_FACING_RULES.stone, undefined)
}

testGoldenPlanIdsUnchanged()
testPowerSourceTableIsData()
testPowerSourcesGoInLast()
testGatehousePowerSourcesGoInLast()
testTowardPlayerFamilyHorizontal()
testObserverFacesAwayFromPlayer()
testVerticalFacingUsesPitch()
testHorizontalOnlyFamiliesRejectVerticalFacing()
testHopperIsNotSolvableByLooking()
testFloorAndCeilingButtonsFollowTheLook()
testWallButtonsStillLetTheWallDecide()
testUntouchedFamiliesKeepTheirDirection()
testGateNowWatchesFacing()
testGateReportsFacingMismatch()
testCeilingButtonPicksTheBlockAbove()
testFloorButtonPicksTheBlockBelow()
testWallButtonProfileUnchanged()
testCeilingButtonWithNoBlockAboveReportsIt()
testTableStaysData()

// ---------------------------------------------------------------------------
// 后勤 11 · (c) 类剩下的 5 处：转发器 delay / 比较器 mode 放完右键调
//
// 这两个状态没有任何放法能带出来 —— 放下去永远是 delay=1 / mode=compare，
// 只能放完再点几下。一次右键把转发器 delay 走 1→2→3→4→1，把比较器
// compare↔subtract 翻一次。第 10 轮把这 5 处故意留在报告上，就是等这一单。

function tuningBot (blockName, properties) {
  const state = { ...properties }
  const clicks = []
  const block = { name: blockName, position: { x: 0, y: 64, z: 0 }, getProperties: () => ({ ...state }) }
  return {
    clicks,
    state,
    context: {
      bot: {
        blockAt: () => block,
        activateBlock: async b => {
          clicks.push(b?.name)
          if (blockName === 'repeater') state.delay = String((Number(state.delay) % 4) + 1)
          if (blockName === 'comparator') state.mode = state.mode === 'compare' ? 'subtract' : 'compare'
        }
      },
      logger: { log: () => {} }
    }
  }
}

const TUNE_TARGET = { x: 0, y: 64, z: 0 }

async function testRepeaterDelayIsClickedIntoPlace () {
  const one = tuningBot('repeater', { delay: '1', facing: 'west' })
  const r1 = await alignPostPlaceTunedStates(one.context, TUNE_TARGET, 'repeater', { delay: '2', facing: 'west' })
  assert.strictEqual(r1.ok, true, r1.error)
  assert.strictEqual(one.clicks.length, 1, '1→2 只需一次右键')
  assert.strictEqual(one.state.delay, '2')

  const three = tuningBot('repeater', { delay: '1' })
  const r3 = await alignPostPlaceTunedStates(three.context, TUNE_TARGET, 'repeater', { delay: '4' })
  assert.strictEqual(r3.ok, true, r3.error)
  assert.strictEqual(three.clicks.length, 3, '1→4 要三次')

  // 绕圈：4→1 只要一次，不是三次
  const wrap = tuningBot('repeater', { delay: '4' })
  const rw = await alignPostPlaceTunedStates(wrap.context, TUNE_TARGET, 'repeater', { delay: '1' })
  assert.strictEqual(rw.ok, true, rw.error)
  assert.strictEqual(wrap.clicks.length, 1)
}

async function testAlreadyTunedBlocksAreNotClicked () {
  const same = tuningBot('repeater', { delay: '3' })
  const r = await alignPostPlaceTunedStates(same.context, TUNE_TARGET, 'repeater', { delay: '3' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(same.clicks.length, 0, '已经对了就不要乱点')

  const noState = tuningBot('repeater', { delay: '1' })
  assert.strictEqual((await alignPostPlaceTunedStates(noState.context, TUNE_TARGET, 'repeater', { facing: 'west' })).ok, true)
  assert.strictEqual(noState.clicks.length, 0)

  // 反向：别的方块一次也不许点
  const stone = tuningBot('stone', {})
  assert.strictEqual((await alignPostPlaceTunedStates(stone.context, TUNE_TARGET, 'stone', { delay: '2' })).ok, true)
  assert.strictEqual(stone.clicks.length, 0)
}

async function testComparatorModeIsFlippedOnce () {
  const sub = tuningBot('comparator', { mode: 'compare', facing: 'north' })
  const r = await alignPostPlaceTunedStates(sub.context, TUNE_TARGET, 'comparator', { mode: 'subtract', facing: 'north' })
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(sub.clicks.length, 1)
  assert.strictEqual(sub.state.mode, 'subtract')

  const already = tuningBot('comparator', { mode: 'compare' })
  assert.strictEqual((await alignPostPlaceTunedStates(already.context, TUNE_TARGET, 'comparator', { mode: 'compare' })).ok, true)
  assert.strictEqual(already.clicks.length, 0)
}

async function testTuningFailureIsReportedAsStateMismatch () {
  // 点了但服务器没跟上：必须报成放置状态不符，而不是假装成功
  const stuck = tuningBot('repeater', { delay: '1' })
  stuck.context.bot.activateBlock = async () => { stuck.clicks.push('repeater') }
  const r = await alignPostPlaceTunedStates(stuck.context, TUNE_TARGET, 'repeater', { delay: '2' })
  assert.strictEqual(r.ok, false)
  assert.ok(String(r.error).startsWith('place_failed:state_mismatch:delay:'), r.error)

  // 右键功能都没有：如实说不可用
  const noActivate = tuningBot('comparator', { mode: 'compare' })
  delete noActivate.context.bot.activateBlock
  const r2 = await alignPostPlaceTunedStates(noActivate.context, TUNE_TARGET, 'comparator', { mode: 'subtract' })
  assert.strictEqual(r2.ok, false)
  assert.strictEqual(r2.error, 'comparator_mode_activation_unavailable')
}

function testTunedStateKeysAreDeclared () {
  assert.deepStrictEqual(postPlaceTunedStateKeys('repeater'), ['delay'])
  assert.deepStrictEqual(postPlaceTunedStateKeys('comparator'), ['mode'])
  assert.deepStrictEqual(postPlaceTunedStateKeys('piston'), [])
  // 这两个键不许混进放置当场的闸门：放下去那一刻它们必然还不对
  assert.deepStrictEqual(expectedPlacementStateKeys('repeater', { facing: 'west', delay: '2' }), ['facing'])
  assert.deepStrictEqual(expectedPlacementStateKeys('comparator', { facing: 'north', mode: 'subtract' }), ['facing'])
}

// ---------------------------------------------------------------------------
// 后勤 12 · 放置那一下不许再重看砖缝（决策 #58）
//
// 第 11 轮把她转对了方向，可 bot.placeBlock 在发包前会再 lookAt 一次砖缝
// （mineflayer generic_place.js:36 默认 forceLook），把刚转好的 yaw/pitch 覆盖掉——
// 床和站立旗帜/头颅早就为此单独开过口子。这里给「朝向由视线决定」的那一族开同样的口子。
// 反向断言同样重要：漏斗和普通方块**必须**继续走原来的 bot.placeBlock（它们本来就该看砖缝），
// 而修缮 9 的潜行不能因为换了放法就丢——对着漏斗/箱子不潜行右键会打开容器而不是放砖。

function placementProbeContext (options = {}) {
  const target = { x: 1, y: 64, z: 2 }
  const reference = { position: { x: 1, y: 63, z: 2 }, name: options.referenceName || 'stone' }
  const calls = { generic: [], place: [], sneak: [], logs: [] }
  let landed = options.landed === false ? null : null
  const bot = {
    heldItem: { name: options.blockName },
    blockAt: () => ({ name: landed || 'air' }),
    _genericPlace: async (ref, face, opts) => {
      calls.generic.push({ ref: ref?.position, face, opts })
      if (options.landed !== false) landed = options.blockName
    },
    placeBlock: async (ref, face) => {
      calls.place.push({ ref: ref?.position, face })
      if (options.landed !== false) landed = options.blockName
    },
    setControlState: (key, value) => calls.sneak.push(`${key}=${value}`)
  }
  const context = { bot, logger: { log: line => calls.logs.push(String(line)) } }
  return { calls, context, reference, target }
}

async function placeOnce (blockName, states, options = {}) {
  const probe = placementProbeContext({ blockName, ...options })
  await placeBlockAgainstReference(probe.context, probe.reference, probe.target, blockName, {
    blockStates: states,
    orientedPlaceConfirmMs: options.landed === false ? 0 : 1200
  })
  return probe.calls
}

async function testOrientedFamiliesKeepTheYaw () {
  const cases = [
    ['repeater', { facing: 'west', delay: '2' }],
    ['comparator', { facing: 'north' }],
    ['piston', { facing: 'up' }],
    ['sticky_piston', { facing: 'down' }],
    ['dropper', { facing: 'up' }],
    ['dispenser', { facing: 'east' }],
    ['observer', { facing: 'north' }]
  ]
  for (const [blockName, states] of cases) {
    const calls = await placeOnce(blockName, states)
    assert.strictEqual(calls.generic.length, 1, `${blockName} 应该走保住视线那条口子`)
    assert.strictEqual(calls.generic[0].opts.forceLook, 'ignore', `${blockName} 必须传 forceLook:'ignore'`)
    assert.strictEqual(calls.generic[0].opts.swingArm, 'right')
    assert.strictEqual(calls.place.length, 0, `${blockName} 不许再走会重看砖缝的老尾巴`)
    const keepYawLogs = calls.logs.filter(line => line.includes('[BUILD_ORIENTED_PLACE_KEEP_YAW]'))
    assert.strictEqual(keepYawLogs.length, 1, `${blockName} 应该正好留一行日志`)
    assert.ok(keepYawLogs[0].includes(`block=${blockName}`), keepYawLogs[0])
    assert.ok(keepYawLogs[0].includes(`facing=${states.facing}`), keepYawLogs[0])
  }
}

async function testHopperAndPlainBlocksStillUseThePlainPlace () {
  // 漏斗的 facing 就是「点了哪个面」，它**需要**那一眼；普通方块本来就无所谓
  for (const [blockName, states] of [['hopper', { facing: 'east' }], ['stone', {}], ['oak_planks', null]]) {
    const calls = await placeOnce(blockName, states)
    assert.strictEqual(calls.place.length, 1, `${blockName} 应该继续走原来的放法`)
    assert.strictEqual(calls.generic.length, 0, `${blockName} 不该走保视线口子`)
    assert.strictEqual(calls.logs.filter(l => l.includes('KEEP_YAW')).length, 0)
  }
  // 墙按钮同理：它的 facing 由墙面决定，视线不该插手
  const wallButton = await placeOnce('dark_oak_button', { face: 'wall', facing: 'east' })
  assert.strictEqual(wallButton.place.length, 1)
  assert.strictEqual(wallButton.generic.length, 0)
}

async function testSneakSurvivesTheNewPath () {
  // 修缮 9：参照是右键会打开东西的方块时必须先潜行
  const sneaky = await placeOnce('repeater', { facing: 'west' }, { referenceName: 'hopper' })
  assert.strictEqual(sneaky.generic.length, 1)
  assert.deepStrictEqual(sneaky.sneak, ['sneak=true', 'sneak=false'], '潜行要开、也要关')
  assert.ok(sneaky.logs.some(l => l.includes('KEEP_YAW') && l.includes('sneak=true')))

  // 参照是普通石头就不该潜行
  const plain = await placeOnce('repeater', { facing: 'west' }, { referenceName: 'stone' })
  assert.deepStrictEqual(plain.sneak, [])

  // 反向：老尾巴上的潜行行为没被我改坏
  const plainSneaky = await placeOnce('stone', {}, { referenceName: 'chest' })
  assert.strictEqual(plainSneaky.place.length, 1)
  assert.deepStrictEqual(plainSneaky.sneak, ['sneak=true', 'sneak=false'])
}

async function testFailedOrientedPlaceAddsNoNewFailureString () {
  // 放没放上由调用方看方块决定；这条口子自己不抛新错误串，
  // 所以调用方仍然只会看到它认识的 place_failed:not_changed 那一套
  const calls = await placeOnce('piston', { facing: 'up' }, { landed: false })
  assert.strictEqual(calls.generic.length, 1)
  assert.strictEqual(calls.place.length, 0)
}

function testWhoGoesThroughTheKeepYawDoor () {
  // 名单本身也钉一遍：只有语义表里 sign 有值的那一族 + face≠wall 的按钮/拉杆
  for (const [blockName, states] of [
    ['repeater', { facing: 'west' }], ['comparator', { facing: 'north' }],
    ['piston', { facing: 'up' }], ['sticky_piston', { facing: 'west' }],
    ['dropper', { facing: 'down' }], ['dispenser', { facing: 'east' }],
    ['observer', { facing: 'north' }]
  ]) {
    assert.ok(orientedPlacementLookDirection(blockName, states), `${blockName} 应在名单内`)
  }
  assert.strictEqual(orientedPlacementLookDirection('hopper', { facing: 'east' }), null)
  assert.strictEqual(orientedPlacementLookDirection('stone', { facing: 'east' }), null)
  assert.strictEqual(orientedPlacementLookDirection('furnace', { facing: 'east' }), null)
  assert.strictEqual(orientedPlacementLookDirection('dark_oak_button', { face: 'wall', facing: 'east' }), null)
}

// ---------------------------------------------------------------------------
// 后勤 14 · 「抬头了，但服务器不知道」（建造 20 真机：4 个屋顶活塞 2 对 2 错）
//
// 错的两个都是走位超时后**原地**放的。读码查明：mineflayer-pathfinder 的
// stop() 只置一个标志，那个标志要等机器人「走到下一个路径点」才被消费；走位
// 超时时她根本走不到，于是旧路径还在，monitorMovement 每个物理刻都在调
// bot.look(yaw, 0) —— 把刚抬起的头按回水平，包括我们那 80 ms 的稳定等待期间。
//
// 所以不去抢最后一刻，而是把角度**排在放置包前面**：两个包在同一个同步块里写出，
// 服务器按顺序读，放置就按我们要的角度结算。
//
// 下面这组是反证：把「有别的东西在掰视线」这件事做进假客户端，
// 断言放置包之前最后一个视角包必须是抬头的。补丁前红、补丁后绿。

// mineflayer lib/conversions.js：服务器口径的俯仰 = 度(-pitch)，抬头为负
const toNotchianPitch = pitch => (180 / Math.PI) * -pitch

function steeringPlacementProbe (options = {}) {
  const writes = []
  const logs = []
  const target = { x: 604, y: 79, z: -10 }
  const reference = { position: { x: 603, y: 79, z: -10 }, name: 'stone' }
  let landed = null
  const bot = {
    heldItem: { name: 'piston' },
    entity: { position: { x: 604.5, y: 78, z: -9.5 }, yaw: 0, pitch: 0, onGround: true, eyeHeight: 1.62 },
    blockAt: () => ({ name: landed || 'air' }),
    // 记录的一律是「服务器口径」：notchian 度数（抬头为负），与生产写的包一致
    _client: { write: (name, data) => writes.push({ name, pitch: data?.pitch, yaw: data?.yaw, from: 'packet' }) },
    // 假 lookAt：照 mineflayer 的算法改 entity 角度，并像物理刻那样发一个视角包
    lookAt: async point => {
      const dx = point.x - bot.entity.position.x
      const dy = point.y - (bot.entity.position.y + bot.entity.eyeHeight)
      const dz = point.z - bot.entity.position.z
      bot.entity.yaw = Math.atan2(-dx, -dz)
      bot.entity.pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))
      writes.push({ name: 'look', pitch: toNotchianPitch(bot.entity.pitch), yaw: bot.entity.yaw, from: 'physics_tick' })
    },
    _genericPlace: async (ref, face, opts) => {
      // mineflayer：forceLook 不是 'ignore' 就会先看一眼砖缝
      if (opts?.forceLook !== 'ignore') {
        bot.entity.pitch = 0
        writes.push({ name: 'look', pitch: 0, from: 'generic_place' })
      }
      writes.push({ name: 'block_place', pitch: toNotchianPitch(bot.entity.pitch) })
      landed = 'piston'
    },
    placeBlock: async () => { writes.push({ name: 'block_place', pitch: toNotchianPitch(bot.entity.pitch) }); landed = 'piston' },
    setControlState: () => {}
  }
  // 「别的东西在掰视线」：寻路每个物理刻把俯仰按回水平
  const steer = () => {
    bot.entity.pitch = 0
    writes.push({ name: 'look', pitch: 0, from: 'pathfinder_tick' })
  }
  const context = { bot, logger: { log: line => logs.push(String(line)) } }
  return { writes, logs, bot, context, target, reference, steer, ...options }
}

function lastLookBeforePlace (writes) {
  const placeIndex = writes.findIndex(entry => entry.name === 'block_place')
  assert.ok(placeIndex >= 0, '根本没有放置包')
  const looks = writes.slice(0, placeIndex).filter(entry => /look/.test(entry.name))
  assert.ok(looks.length > 0, '放置包之前一个视角包都没有')
  return looks[looks.length - 1]
}

async function testLookReachesTheServerBeforeThePlacement () {
  const probe = steeringPlacementProbe()
  const direction = lookFor('piston', { facing: 'down' })
  assert.strictEqual(direction.y, 1, 'facing=down 该抬头')

  await lookTowardDirection(probe.context, probe.target, 'piston', direction)
  assert.ok(probe.bot.entity.pitch > 1, '转身这一步本来就抬头了')

  // 走位超时后寻路还在掰视线：稳定等待期间把俯仰按回水平
  probe.steer()
  assert.strictEqual(probe.bot.entity.pitch, 0)

  await placeBlockAgainstReference(probe.context, probe.reference, probe.target, 'piston', {
    blockStates: { facing: 'down' },
    orientedPlaceConfirmMs: 0
  })

  const look = lastLookBeforePlace(probe.writes)
  assert.ok(
    look.pitch < -45,
    `放置包之前最后一个视角包还是水平的（服务器口径 pitch=${look.pitch}, from=${look.from || 'packet'}）——服务器会按水平结算`
  )
  assert.ok(probe.logs.some(line => line.includes('[BUILD_PLACE_LOOK_SYNCED]') && line.includes('sent=true')))
}

async function testLookSyncSurvivesRepeatedSteering () {
  // 连着掰三次也没用：包的顺序说了算
  const probe = steeringPlacementProbe()
  const direction = lookFor('sticky_piston', { facing: 'up' })
  await lookTowardDirection(probe.context, probe.target, 'sticky_piston', direction)
  probe.steer(); probe.steer(); probe.steer()
  await placeBlockAgainstReference(probe.context, probe.reference, probe.target, 'sticky_piston', {
    blockStates: { facing: 'up' },
    orientedPlaceConfirmMs: 0
  })
  const look = lastLookBeforePlace(probe.writes)
  assert.ok(look.pitch > 45, `facing=up 要低头，实际服务器口径 pitch=${look.pitch}`)
}

async function testPlainBlocksDoNotGetAnExtraLookPacket () {
  // 反向：不吃视线的方块不该被这条新逻辑碰到（老路径一字不变）
  const probe = steeringPlacementProbe()
  await placeBlockAgainstReference(probe.context, probe.reference, probe.target, 'stone', {
    blockStates: {},
    orientedPlaceConfirmMs: 0
  })
  assert.strictEqual(probe.logs.filter(l => l.includes('BUILD_PLACE_LOOK_SYNCED')).length, 0)
  assert.strictEqual(probe.writes.filter(w => w.name === 'block_place').length, 1)
}

function testBothRulersStillCompareOrientation () {
  // 建造 20 存档里 604,79,-10 记成 verified，世界里却是 facing=north。第一嫌疑是
  // 第 10 轮（#51）把「机器人放不出来的状态」一起放宽时把朝向也放宽了——查下来
  // **不是**：两把尺子都还在比 piston 的 facing，放宽的只有通电/伸缩那一批。
  // 这组断言把这件事钉住，免得以后谁顺手把朝向也塞进放宽名单。
  for (const blockName of ['piston', 'sticky_piston', 'observer', 'dropper', 'dispenser', 'repeater', 'comparator', 'hopper']) {
    assert.strictEqual(isComparablePlacementStateKey(blockName, 'facing', 'down'), true, `续建对账不再比 ${blockName} 的朝向`)
    assert.strictEqual(isComparableStateKey(blockName, 'facing', 'down'), true, `终验尺子不再比 ${blockName} 的朝向`)
  }
  // 放宽的那批仍然放宽（回归）
  assert.strictEqual(isComparablePlacementStateKey('piston', 'extended', 'false'), false)
  assert.strictEqual(isComparablePlacementStateKey('observer', 'powered', 'false'), false)
  // 真的比出来了：朝向不同就是不同
  const step = { kind: 'place', blockName: 'piston', position: { x: 604, y: 79, z: -10 }, states: { facing: 'down' } }
  assert.strictEqual(stepStateMatches({ facing: 'north', extended: 'false' }, step), false)
  assert.strictEqual(stepStateMatches({ facing: 'down', extended: 'true' }, step), true)
}

function testPlacementLookAnglesMatchLookAt () {
  // 角度算法必须和 bot.lookAt 一致，否则「重述」会重述错
  const bot = { entity: { position: { x: 10.5, y: 64, z: 20.5 }, eyeHeight: 1.62 } }
  const down = placementLookAngles(bot, lookFor('piston', { facing: 'down' }))
  assert.ok(down.pitch > 1.5, `facing=down 应抬头，实际 ${down.pitch}`)
  const up = placementLookAngles(bot, lookFor('piston', { facing: 'up' }))
  assert.ok(up.pitch < -1.5, `facing=up 应低头，实际 ${up.pitch}`)
  const west = placementLookAngles(bot, lookFor('repeater', { facing: 'west' }))
  assert.ok(Math.abs(west.pitch) < 0.01, '水平朝向不该带俯仰')
  // 潜行时眼睛低一点，俯仰跟着变，但方向不变（回归）
  const sneaking = placementLookAngles({ entity: { position: bot.entity.position, eyeHeight: 1.27 } }, lookFor('piston', { facing: 'down' }))
  assert.ok(sneaking.pitch > 1.5)
}

async function runAsyncOrientationTests () {
  await testLookTargetPitchSign()
  await testHorizontalLookTargetUnchanged()
  await testOrientedFamiliesKeepTheYaw()
  await testLookReachesTheServerBeforeThePlacement()
  await testLookSyncSurvivesRepeatedSteering()
  await testPlainBlocksDoNotGetAnExtraLookPacket()
  testPlacementLookAnglesMatchLookAt()
  testBothRulersStillCompareOrientation()
  await testHopperAndPlainBlocksStillUseThePlainPlace()
  await testSneakSurvivesTheNewPath()
  await testFailedOrientedPlaceAddsNoNewFailureString()
  testWhoGoesThroughTheKeepYawDoor()
  await testRepeaterDelayIsClickedIntoPlace()
  await testAlreadyTunedBlocksAreNotClicked()
  await testComparatorModeIsFlippedOnce()
  await testTuningFailureIsReportedAsStateMismatch()
  testTunedStateKeysAreDeclared()
  console.log('oriented placement state tests passed')
}

runAsyncOrientationTests().catch(err => {
  console.error(err)
  process.exit(1)
})
