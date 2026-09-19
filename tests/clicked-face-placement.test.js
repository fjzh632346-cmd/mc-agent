const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const build = require('../actions/build')
const { _test: buildingSystemTest } = require('../systems/building-system')

// Pins 后勤 16 (决策 #78): the three executor-side gaps that kept the sequence
// layer's answer from ever being heard.
//
// A hopper takes its facing from the block that was clicked, so the blueprint's
// facing names exactly one neighbour cell. 后勤 15 wrote that cell onto the
// order-plan step (`clickedFaceReference`), plus, for the head of a cycle, a
// `temporaryReference` saying "put a block there first". Nothing read either:
//   1. building-system built placeOptions field by field and dropped them
//   2. the reference picker sorts by "which one is easy to click" and pushes a
//      hopper (a right-click opens its GUI) to the very end
//   3. the temporary-brick chain only starts for slab/trapdoor/axis blocks with
//      no reference at all, and cannot be told which cell to fill
//
// Live case: fort-wall-gate 603,74,-2 facing=east and 604,74,-2 facing=west.

const key = position => `${position.x},${position.y},${position.z}`

function vec (x, y, z) {
  return {
    x,
    y,
    z,
    clone () { return vec(x, y, z) },
    offset (dx, dy, dz) { return vec(x + dx, y + dy, z + dz) },
    distanceTo (other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

// A world just big enough to place a block against a neighbour and read back
// what landed. Hopper facing follows the real rule: the output points AT the
// block that was clicked, and "up" is impossible so it becomes "down".
function fakeWorld (initial = {}, options = {}) {
  const blocks = new Map(Object.entries(initial))
  const events = []
  const logs = []
  const stand = options.stand || vec(602, 74, -2)

  const blockAt = position => {
    const name = blocks.get(key(position)) || 'air'
    const states = (options.states || {})[key(position)] || {}
    return {
      name,
      position: vec(position.x, position.y, position.z),
      getProperties: () => ({ ...states })
    }
  }

  const bot = {
    username: 'LinXia',
    entity: { position: stand, onGround: true },
    entities: {},
    heldItem: null,
    inventory: {
      items: () => (options.items || [
        { name: 'hopper', count: 8 },
        { name: 'dirt', count: 64 },
        { name: 'cobblestone', count: 64 },
        { name: 'piston', count: 8 }
      ]),
      slots: []
    },
    pathfinder: { setMovements () {}, setGoal () {}, stop () {} },
    blockAt,
    canDigBlock: () => true,
    async equip (item) { this.heldItem = item },
    async dig (block) {
      events.push({ action: 'dig', position: key(block.position) })
      blocks.delete(key(block.position))
    },
    async lookAt () {},
    async placeBlock (reference, faceVector) {
      const target = {
        x: reference.position.x + faceVector.x,
        y: reference.position.y + faceVector.y,
        z: reference.position.z + faceVector.z
      }
      const blockName = bot.heldItem?.name
      // hopper: facing points back at the clicked block; "up" is not a thing
      let facing = null
      if (blockName === 'hopper') {
        if (faceVector.y === 1) facing = 'down'
        else if (faceVector.y === -1) facing = 'down'
        else if (faceVector.x === 1) facing = 'west'
        else if (faceVector.x === -1) facing = 'east'
        else if (faceVector.z === 1) facing = 'north'
        else facing = 'south'
      }
      events.push({
        action: 'place',
        block: blockName,
        target: key(target),
        reference: key(reference.position),
        face: build.faceNameForVector(faceVector),
        facing
      })
      blocks.set(key(target), blockName)
      if (facing) (options.states || (options.states = {}))[key(target)] = { facing }
    },
    setControlState () {}
  }

  const context = {
    bot,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard: new Blackboard({}),
    logger: { log: line => logs.push(String(line)) }
  }
  if (!options.states) options.states = {}
  return { blocks, bot, context, events, logs, options }
}

// ---------------------------------------------------------------------------
// 笔 1 · 透传：有声明就带上，没声明一个字段都不多
function testDeclarationPassthrough () {
  const { clickedFacePlacementOptions } = buildingSystemTest
  assert.deepStrictEqual(clickedFacePlacementOptions({}), {})
  assert.deepStrictEqual(clickedFacePlacementOptions({ blockName: 'hopper' }), {})
  assert.deepStrictEqual(clickedFacePlacementOptions(null), {})
  // 半截声明（缺 position）也不算数
  assert.deepStrictEqual(clickedFacePlacementOptions({ clickedFaceReference: { face: 'west' } }), {})

  const step = {
    blockName: 'hopper',
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west', facing: 'east' },
    temporaryReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' }
  }
  assert.deepStrictEqual(clickedFacePlacementOptions(step), {
    clickedFaceReference: step.clickedFaceReference,
    temporaryReference: step.temporaryReference
  })
  // 展开进 options 后正好多这两个键，别的一个不动
  const before = { owner: 'x', blockStates: { facing: 'east' } }
  assert.deepStrictEqual(Object.keys({ ...before, ...clickedFacePlacementOptions({}) }), Object.keys(before))
}

// ---------------------------------------------------------------------------
// 笔 1 · 续建取回存档状态时声明不会丢（这一条决定门楼那两格重放能不能吃到声明）
function testDeclarationSurvivesResume () {
  const { mergeRuntimeAndStoredSteps } = buildingSystemTest
  const runtimeStep = {
    id: 'step_c2d775981b9da42e',
    kind: 'place',
    action: 'place_block',
    position: { x: 603, y: 74, z: -2 },
    blockName: 'hopper',
    states: { facing: 'east' },
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west', facing: 'east' },
    temporaryReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' },
    deferredReason: 'clicked_face_reference_unresolved',
    clickedFaceReferenceRoot: true
  }
  const storedStep = {
    id: 'step_c2d775981b9da42e',
    action: 'place_block',
    legacyKind: 'place',
    status: 'state_repair',
    target: { x: 603, y: 74, z: -2 },
    block: { id: 'hopper', states: { facing: 'east' } },
    retry: { count: 0, lastError: null }
  }
  const merged = mergeRuntimeAndStoredSteps([runtimeStep], { [storedStep.id]: storedStep })
  assert.strictEqual(merged.length, 1)
  assert.deepStrictEqual(merged[0].clickedFaceReference, runtimeStep.clickedFaceReference)
  assert.deepStrictEqual(merged[0].temporaryReference, runtimeStep.temporaryReference)
  assert.strictEqual(merged[0].clickedFaceReferenceRoot, true)

  // 反向：没有 runtime 对应步的纯存档步本来就不带声明（也不该凭空长出来）
  const orphan = mergeRuntimeAndStoredSteps([], { [storedStep.id]: storedStep })
  assert.strictEqual(orphan[0].clickedFaceReference, undefined)
  assert.strictEqual(orphan[0].temporaryReference, undefined)
}

// ---------------------------------------------------------------------------
// 笔 2 · 声明解析
function testClickedFaceRequestParsing () {
  assert.strictEqual(build.clickedFacePlacementRequest({}), null)
  assert.strictEqual(build.clickedFacePlacementRequest({ temporaryReference: { position: { x: 1, y: 2, z: 3 } } }), null)

  const withoutBrick = build.clickedFacePlacementRequest({
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' }
  })
  assert.deepStrictEqual(withoutBrick.position, { x: 604, y: 74, z: -2 })
  assert.strictEqual(withoutBrick.face, 'west')
  assert.strictEqual(withoutBrick.temporaryPosition, null)

  const withBrick = build.clickedFacePlacementRequest({
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' },
    temporaryReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' }
  })
  assert.deepStrictEqual(withBrick.temporaryPosition, { x: 604, y: 74, z: -2 })

  // 垫砖声明指向别处时不认（只垫在要点的那一格）
  const mismatched = build.clickedFacePlacementRequest({
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' },
    temporaryReference: { position: { x: 999, y: 74, z: -2 }, face: 'west' }
  })
  assert.strictEqual(mismatched.temporaryPosition, null)
}

// ---------------------------------------------------------------------------
// 笔 2 · 置顶：点名的那一格排到第一个；不在场就原样回退并留一行日志
function testReferenceOrdering () {
  const logs = []
  const context = { logger: { log: line => logs.push(String(line)) } }
  const references = [
    { name: 'chiseled_stone_bricks', position: { x: 603, y: 73, z: -2 } },
    { name: 'chiseled_stone_bricks', position: { x: 603, y: 75, z: -2 } },
    { name: 'hopper', position: { x: 604, y: 74, z: -2 } }
  ]
  const request = build.clickedFacePlacementRequest({
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' }
  })
  const ordered = build.orderReferencesForClickedFace(context, references, request, { x: 603, y: 74, z: -2 })
  assert.deepStrictEqual(ordered.map(entry => key(entry.position)),
    ['604,74,-2', '603,73,-2', '603,75,-2'])
  // 点它的哪一面是现算的，正好是 west
  assert.strictEqual(build.faceNameForVector({ x: -1, y: 0, z: 0 }), 'west')
  assert.strictEqual(logs.length, 0)

  // 没有声明 → 恒等（同一个数组对象，一个字节不动）
  assert.strictEqual(build.orderReferencesForClickedFace(context, references, null, {}), references)

  // 点名的那一格不在候选里 → 原样返回 + 一行日志
  const missingRequest = build.clickedFacePlacementRequest({
    clickedFaceReference: { position: { x: 900, y: 74, z: -2 }, face: 'west' }
  })
  const fallback = build.orderReferencesForClickedFace(context, references, missingRequest, { x: 603, y: 74, z: -2 })
  assert.deepStrictEqual(fallback.map(entry => key(entry.position)), references.map(entry => key(entry.position)))
  assert.strictEqual(logs.length, 1)
  assert.ok(logs[0].startsWith('[BUILD_CLICKED_FACE_REFERENCE_MISSING]'), logs[0])
  assert.ok(logs[0].includes('reference=900,74,-2'), logs[0])
}

// ---------------------------------------------------------------------------
// 笔 2 · 反向：没有声明时挑参照那一步逐字不变（冻结函数一个字都没动）
async function testDefaultReferenceOrderIsUntouched () {
  // 同一个邻居布局，三族方块各放一次：不带声明时点的必须还是「正下方」那一块，
  // 顺序、日志、结果一律和今天一样。
  for (const [blockName, states] of [
    ['cobblestone', null],
    ['piston', { facing: 'east' }],
    ['hopper', { facing: 'down' }]
  ]) {
    const world = fakeWorld({
      '10,64,10': 'stone_bricks',   // 下
      '10,66,10': 'stone_bricks',   // 上
      '11,65,10': 'oak_planks',     // 东
      '9,65,10': 'hopper'           // 西（交互块，本来就压在最后）
    }, { stand: vec(9, 65, 11) })
    const result = await build.placeBlock(world.context, { x: 10, y: 65, z: 10 }, blockName, {
      owner: 'test',
      blockStates: states,
      // 假世界只模拟漏斗那条「点面定朝向」的规律，活塞的朝向由视线决定、这里不建模，
      // 所以只对漏斗开状态闸门；本组要钉的是「先点哪一块」，不是朝向本身。
      requireStateConfirmation: blockName === 'hopper'
    })
    assert.strictEqual(result.ok, true, `${blockName}: ${result.error}`)
    const places = world.events.filter(event => event.action === 'place')
    assert.strictEqual(places.length, 1, blockName)
    assert.strictEqual(places[0].reference, '10,64,10', `${blockName} 默认仍先点正下方`)
    assert.strictEqual(world.logs.filter(line => line.includes('CLICKED_FACE')).length, 0,
      `${blockName} 没有声明就不该出现这一族的任何日志`)
  }
}

// ---------------------------------------------------------------------------
// 笔 2 · 点名的那一格已经站着方块 → 直接点它，不垫砖
async function testStandingReferenceNeedsNoBrick () {
  const world = fakeWorld({
    '603,73,-2': 'chiseled_stone_bricks',
    '604,74,-2': 'hopper' // 另一只（朝向还错着）已经立在那儿
  })
  const target = { x: 603, y: 74, z: -2 }
  const result = await build.placeBlock(world.context, target, 'hopper', {
    owner: 'test',
    blockStates: { facing: 'east' },
    requireStateConfirmation: true,
    clickedFaceReference: { position: { x: 604, y: 74, z: -2 }, face: 'west', facing: 'east' },
    temporaryReference: { position: { x: 604, y: 74, z: -2 }, face: 'west' }
  })
  assert.strictEqual(result.ok, true, result.error)
  const places = world.events.filter(event => event.action === 'place')
  assert.strictEqual(places.length, 1, JSON.stringify(world.events))
  assert.strictEqual(places[0].reference, '604,74,-2')
  assert.strictEqual(places[0].face, 'west')
  assert.strictEqual(places[0].facing, 'east', '朝向必须落在图纸要的那一边')
  assert.strictEqual(world.events.filter(event => event.action === 'dig').length, 0, '没垫砖就没得拆')
  const placeLog = world.logs.filter(line => line.includes('[BUILD_CLICKED_FACE_PLACE]'))
  assert.strictEqual(placeLog.length, 1)
  assert.ok(placeLog[0].includes('reference=604,74,-2'), placeLog[0])
  assert.ok(placeLog[0].includes('face=west'), placeLog[0])
  assert.ok(placeLog[0].includes('temporary=false'), placeLog[0])
}

// ---------------------------------------------------------------------------
// 笔 3 · 端到端：空地上的一对互指漏斗，整条链跑通
//   垫临时砖 → 点它的西面放下第一只(facing=east) → 拆临时砖 → 第二只点第一只的东面(facing=west)
async function testMutualHopperPairEndToEnd () {
  const world = fakeWorld({
    '603,73,-2': 'chiseled_stone_bricks',
    '604,73,-2': 'chiseled_stone_bricks'
  })
  const first = { x: 603, y: 74, z: -2 }
  const second = { x: 604, y: 74, z: -2 }

  // 头一只：604 还空着，声明里带垫砖
  const firstResult = await build.placeBlock(world.context, first, 'hopper', {
    owner: 'test',
    blockStates: { facing: 'east' },
    requireStateConfirmation: true,
    clickedFaceReference: { position: second, face: 'west', facing: 'east' },
    temporaryReference: { position: second, face: 'west' },
    // 604 是图纸格，落在保留集里；被点名的那一格要能破例
    reservedPositions: new Set(['603,74,-2', '604,74,-2'])
  })
  assert.strictEqual(firstResult.ok, true, firstResult.error)

  // 第二只：这时 603 已经立着，照常参照它
  const secondResult = await build.placeBlock(world.context, second, 'hopper', {
    owner: 'test',
    blockStates: { facing: 'west' },
    requireStateConfirmation: true,
    clickedFaceReference: { position: first, face: 'east', facing: 'west' },
    reservedPositions: new Set(['603,74,-2', '604,74,-2'])
  })
  assert.strictEqual(secondResult.ok, true, secondResult.error)

  // 整条动作序列
  const sequence = world.events.map(event => event.action === 'dig'
    ? `dig ${event.position}`
    : `place ${event.block}@${event.target} ref=${event.reference} face=${event.face} facing=${event.facing || '-'}`)
  assert.deepStrictEqual(sequence, [
    'place dirt@604,74,-2 ref=604,73,-2 face=up facing=-',
    'place hopper@603,74,-2 ref=604,74,-2 face=west facing=east',
    'dig 604,74,-2',
    'place hopper@604,74,-2 ref=603,74,-2 face=east facing=west'
  ], sequence.join(' | '))

  // 世界的最终朝向：一个 east、一个 west
  assert.strictEqual(world.options.states['603,74,-2'].facing, 'east')
  assert.strictEqual(world.options.states['604,74,-2'].facing, 'west')

  const placeLogs = world.logs.filter(line => line.includes('[BUILD_CLICKED_FACE_PLACE]'))
  assert.strictEqual(placeLogs.length, 2, placeLogs.join('\n'))
  assert.ok(placeLogs[0].includes('temporary=true'), placeLogs[0])
  assert.ok(placeLogs[1].includes('temporary=false'), placeLogs[1])
  assert.strictEqual(world.logs.filter(line => line.includes('CLICKED_FACE_REFERENCE_MISSING')).length, 0)
}

// ---------------------------------------------------------------------------
// 笔 3 · 反证：去掉声明 → 头一只照旧点正下方，落成 facing=down
async function testWithoutTheDeclarationTheFirstHopperStillFacesDown () {
  const world = fakeWorld({
    '603,73,-2': 'chiseled_stone_bricks',
    '604,73,-2': 'chiseled_stone_bricks'
  })
  const first = { x: 603, y: 74, z: -2 }
  const result = await build.placeBlock(world.context, first, 'hopper', {
    owner: 'test',
    blockStates: { facing: 'east' },
    requireStateConfirmation: true,
    reservedPositions: new Set(['603,74,-2', '604,74,-2'])
  })
  // 放是放上了，但朝向是错的——正是今天真机上的样子
  assert.strictEqual(result.ok, false, '朝向对不上，放置这一步不该报成功')
  const places = world.events.filter(event => event.action === 'place')
  assert.strictEqual(places[0].reference, '603,73,-2')
  assert.strictEqual(places[0].facing, 'down')
  assert.strictEqual(world.logs.filter(line => line.includes('CLICKED_FACE')).length, 0)
}

async function main () {
  testDeclarationPassthrough()
  testDeclarationSurvivesResume()
  testClickedFaceRequestParsing()
  testReferenceOrdering()
  await testDefaultReferenceOrderIsUntouched()
  await testStandingReferenceNeedsNoBrick()
  await testMutualHopperPairEndToEnd()
  await testWithoutTheDeclarationTheFirstHopperStillFacesDown()
  console.log('clicked face placement tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
