// 后勤 20 / 老板决策 #89-C：开工前背包不够就先放临时箱子中转。
//
// 现场（建造 25 真机）：她背包被上一阶段的红石/活塞/漏斗占满，清地皮捡到草皮后
// 空位 <= 1 -> 生存系统按设计把建造 PAUSE、改派 INVENTORY_FULL_STORE ->
// 方圆 32 格没箱子 -> chest_not_found -> 每 30 秒重来一次，建造永远起不来。
//
// 这一份钉两侧：
//   派单侧（survival-system）：荒地上没箱子时派不派、派出去带什么参数；
//   落地侧（storage-system）：就地放一只箱子、登记、存掉非材料物品，
//                             以及三条回落（有箱子 / 没料 / 只有图纸格可放）。
const assert = require('assert')
const { Blackboard } = require('../core/blackboard')
const { ActionLock } = require('../core/action-lock')
const { WorldMemory } = require('../memory/world-memory')
const { SurvivalSystem, SURVIVAL_PRIORITIES } = require('../systems/survival-system')
const { WorksiteAnchor } = require('../systems/worksite-anchor')
const { StorageSystem, canDeployTemporaryChest } = require('../systems/storage-system')
const os = require('os')
const path = require('path')

const CHEST_ID = 54
const WORKSITE = { x: 600, y: 67, z: -19 }
const OLD_BASE = { x: 11, y: 106, z: 8 }

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function key(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function captureLogs(run) {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.map(String).join(' '))
    if (process.env.TEMP_CHEST_DEBUG) original(...args)
  }
  return Promise.resolve()
    .then(run)
    .then(
      result => {
        console.log = original
        return { result, lines }
      },
      err => {
        console.log = original
        throw err
      }
    )
}

// ---------------------------------------------------------------------------
// 一、派单侧：生存系统在荒地上决定派不派这一趟
// ---------------------------------------------------------------------------

function createSurvivalContext(options = {}) {
  const position = options.position || WORKSITE
  const chests = options.chests || []
  const chestKeys = new Set(chests.map(key))

  const blackboard = new Blackboard({
    bot: { health: 20, food: 20, position, onGround: true },
    mobs: { dangerLevel: 'none', nearestHostileMob: null, hostileMobs: [], nearbyHostileCount: 0 },
    inventory: { emptySlots: options.emptySlots ?? 0, foodCount: 0, counts: options.counts || {} },
    world: { isDay: true, weather: null },
    player: { ownerPosition: position },
    tasks: { currentTask: options.currentTask || null, queue: [], pausedStack: [] }
  })

  const memory = {
    summary() {
      return {
        world: { hasBaseLocation: true, chestLocations: options.rememberedChests?.length || 0, farmLocations: 0 },
        task: { total: 0 }
      }
    },
    world: {
      baseLocation: { position: OLD_BASE },
      chestLocations: () => (options.rememberedChests || []).map(pos => ({ position: pos }))
    }
  }

  const bot = {
    entity: { position: vec(position.x, position.y, position.z) },
    health: 20,
    food: 20,
    oxygen: 20,
    players: {},
    registry: { blocksByName: { chest: { id: CHEST_ID }, trapped_chest: { id: 55 }, barrel: { id: 56 } } },
    inventory: { items: () => options.inventoryItems || [] },
    pathfinder: { stop() {}, setMovements() {}, setGoal() {} },
    findBlocks(query = {}) {
      if (!Array.isArray(query.matching) || !query.matching.includes(CHEST_ID)) return []
      const from = query.point || bot.entity.position
      const max = query.maxDistance ?? 32
      return chests
        .filter(chest => Math.sqrt((chest.x - from.x) ** 2 + (chest.y - from.y) ** 2 + (chest.z - from.z) ** 2) <= max)
        .map(chest => vec(chest.x, chest.y, chest.z))
    },
    blockAt(pos) {
      if (!pos) return null
      if (chestKeys.has(key(pos))) return { name: 'chest', type: CHEST_ID, id: CHEST_ID, position: vec(pos.x, pos.y, pos.z) }
      return { name: 'air', type: 0, id: 0, position: vec(pos.x, pos.y, pos.z) }
    }
  }

  const taskManager = {
    enqueued: [],
    paused: null,
    interrupted: null,
    currentTask: options.currentTask || null,
    queue: [],
    pausedStack: [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 100, type, params, priority, source }
      this.enqueued.push(task)
      return task
    },
    async pauseCurrent(reason) {
      this.paused = reason
      return true
    },
    async interruptCurrent(reason) {
      this.interrupted = reason
      return true
    },
    async resumePaused() {
      return true
    }
  }

  const logs = []
  return {
    blackboard,
    bot,
    memory,
    taskManager,
    logs,
    logger: { log: message => logs.push(String(message)), warn() {}, error() {} },
    reminderOutput() {}
  }
}

function createSurvivalSystem() {
  const anchor = new WorksiteAnchor({ now: () => 1000 })
  return new SurvivalSystem({ cooldownMs: 1, worksiteAnchor: anchor, now: () => 1000 })
}

function buildTask(overrides = {}) {
  return { id: 1, type: 'build_blueprint', state: 'RUNNING', priority: 5, source: 'player_command', ...overrides }
}

// 1-A 荒地无箱子 + 身上有箱子 → 派一趟卸货，带「就地放临时箱」授权，半径照旧锁死
async function testWildernessWithChestItemDispatchesTemporaryChestUnload() {
  const system = createSurvivalSystem()
  const ctx = createSurvivalContext({
    currentTask: buildTask(),
    chests: [],
    counts: { chest: 1, redstone: 64, piston: 12 }
  })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(state.worksite.atWorksite, true)
  assert.strictEqual(decision.action, 'STORE_INVENTORY')

  const applied = await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(applied.type, 'TASK')
  assert.strictEqual(ctx.taskManager.enqueued.length, 1)
  const enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.type, 'storage')
  assert.strictEqual(enqueued.params.mode, 'INVENTORY_FULL_STORE')
  assert.strictEqual(enqueued.params.placeTemporaryChest, true)
  assert.strictEqual(enqueued.params.worksiteUnload, true)
  // 半径照旧锁死在工地范围内：绝不为了卸货跑去几百格外那只
  assert.strictEqual(enqueued.params.maxDistance, 32)
  assert.strictEqual(enqueued.params.radius, 32)
  // 建造是被暂停（可恢复），不是被 interrupt 掉；全程没有任何「回基地」
  assert.strictEqual(ctx.taskManager.paused, 'survival_inventory_full')
  assert.strictEqual(ctx.taskManager.interrupted, null)
  assert.ok(!ctx.taskManager.enqueued.some(item => item.type.startsWith('return_to')))
  assert.ok(ctx.logs.some(line => line.includes('[WORKSITE_UNLOAD_NO_CHEST]')))
}

// 1-B 荒地无箱子 + 没箱子但有 8 块同种木板 → 照样派
async function testWildernessWithPlanksDispatchesTemporaryChestUnload() {
  const system = createSurvivalSystem()
  const ctx = createSurvivalContext({
    currentTask: buildTask(),
    chests: [],
    counts: { oak_planks: 12, redstone: 64 }
  })

  const decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(decision.action, 'STORE_INVENTORY')
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.enqueued[0].params.placeTemporaryChest, true)
}

// 1-C 32 格内本来就有箱子 → 老路径一字不变，不带授权
async function testNearbyChestKeepsOldWorksiteUnloadPath() {
  const system = createSurvivalSystem()
  const siteChest = { x: 596, y: 67, z: -23 }
  const ctx = createSurvivalContext({
    currentTask: buildTask(),
    chests: [siteChest],
    counts: { chest: 1, redstone: 64 }
  })

  const decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(decision.action, 'STORE_INVENTORY')
  await system.applySurvivalDecision(ctx, decision)
  const enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.params.placeTemporaryChest, undefined)
  assert.strictEqual(enqueued.params.worksiteUnload, true)
  assert.deepStrictEqual(enqueued.params.scanCenters.map(key), [key(siteChest)])
  assert.ok(ctx.logs.some(line => line.includes('[WORKSITE_UNLOAD] source=')))
  assert.ok(!ctx.logs.some(line => line.includes('[WORKSITE_UNLOAD_NO_CHEST]')))
}

// 1-D 荒地无箱子 + 既没箱子也没够木板 → 照旧原地站着（行为与改前逐字相同）
async function testWildernessWithoutChestOrPlanksStaysPut() {
  const system = createSurvivalSystem()
  const ctx = createSurvivalContext({
    currentTask: buildTask(),
    chests: [],
    counts: { redstone: 64, oak_planks: 4 }
  })

  const state = system.evaluateSurvivalState(ctx)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(system.actionForPriority(SURVIVAL_PRIORITIES.INVENTORY_FULL, ctx), 'STAY_PUT')
  // STAY_PUT 不算「就近卸货」，所以照旧让位给「施工中先别管生存」那道闸 → REMIND。
  // 这一整条是改前的行为，本轮一个字没动。
  const decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(decision.action, 'REMIND')
  assert.strictEqual(decision.deferredForTask, 'build_blueprint')
  const applied = await system.applySurvivalDecision(ctx, decision)
  assert.notStrictEqual(applied.type, 'TASK')
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
}

// 1-E 不在工地上 → 老路径一字不变（不带半径、不带授权）
async function testAwayFromWorksiteKeepsPlainStorageDispatch() {
  const system = createSurvivalSystem()
  const ctx = createSurvivalContext({
    chests: [],
    rememberedChests: [OLD_BASE],
    counts: { chest: 1, redstone: 64 }
  })

  const decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(decision.action, 'STORE_INVENTORY')
  await system.applySurvivalDecision(ctx, decision)
  const enqueued = ctx.taskManager.enqueued.find(task => task.type === 'storage')
  assert.deepStrictEqual(enqueued.params, { mode: 'INVENTORY_FULL_STORE' })
}

// 1-F 判据本身：8 块同种木板才算够，凑不出一种不算
function testCanDeployTemporaryChestNeedsEightOfOneSpecies() {
  assert.strictEqual(canDeployTemporaryChest({ chest: 1 }), true)
  assert.strictEqual(canDeployTemporaryChest({ oak_planks: 8 }), true)
  assert.strictEqual(canDeployTemporaryChest({ spruce_planks: 64 }), true)
  assert.strictEqual(canDeployTemporaryChest({ oak_planks: 7 }), false)
  // 两种各 4 块拼不出一只箱子：配方要 8 块同种
  assert.strictEqual(canDeployTemporaryChest({ oak_planks: 4, spruce_planks: 4 }), false)
  assert.strictEqual(canDeployTemporaryChest({ oak_log: 64 }), false)
  assert.strictEqual(canDeployTemporaryChest({}), false)
}

// ---------------------------------------------------------------------------
// 二、落地侧：离线假世界
//
// 地形：y=63 一层 grass_block 铺满，其余是空气；她站在 (0,64,0)。
// 施工单：x 0..5 / y 64..70 / z 0..5，其中 (1,64,1) 是图纸声明的 air 格
//        （楼梯井就是这么来的）——它照样算包围盒内，不许往里放箱子。
// 所以站位周围第一格合规的是 (-1,64,0)。
// ---------------------------------------------------------------------------

const BUILD_MATERIALS = ['spruce_planks', 'stone_bricks']

function createWorldContext(options = {}) {
  const blocks = new Map()
  const setBlock = (position, name) => blocks.set(key(position), name)
  const groundY = 63

  const blockNameAt = position => {
    const explicit = blocks.get(key(position))
    if (explicit) return explicit
    if (Math.floor(position.y) === groundY) return 'grass_block'
    if (Math.floor(position.y) < groundY) return 'stone'
    return 'air'
  }

  for (const [position, name] of options.blocks || []) setBlock(position, name)

  const inventoryItems = (options.inventoryItems || []).map(item => ({ ...item }))
  const chestContents = []
  const placed = []
  const crafted = []
  const opened = []

  const bot = {
    // 真机里她站在方块中心（x.5 / z.5）。钉在整数边界上会让她的碰撞箱
    // 同时压住两列方块，隔壁那格当场被判成 placement_target_occupied。
    entity: { position: vec(0.5, 64, 0.5) },
    health: 20,
    food: 20,
    heldItem: null,
    registry: {
      blocksByName: { chest: { id: CHEST_ID }, trapped_chest: { id: 55 }, barrel: { id: 56 }, crafting_table: { id: 58 } },
      itemsByName: { chest: { id: 130, name: 'chest' } },
      foodsByName: {}
    },
    inventory: {
      items: () => inventoryItems.filter(item => item.count > 0),
      slots: Array.from({ length: 45 }, () => null)
    },
    pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
    blockAt(position) {
      if (!position) return null
      const name = blockNameAt(position)
      return { name, type: name === 'chest' ? CHEST_ID : 1, position: vec(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)) }
    },
    findBlock(query = {}) {
      const tableId = bot.registry.blocksByName.crafting_table.id
      if (query.matching !== tableId || !options.craftingTable) return null
      return { name: 'crafting_table', position: vec(options.craftingTable.x, options.craftingTable.y, options.craftingTable.z) }
    },
    findBlocks(query = {}) {
      const matching = Array.isArray(query.matching) ? query.matching : [query.matching]
      if (!matching.includes(CHEST_ID)) return []
      const from = query.point || bot.entity.position
      const max = query.maxDistance ?? 32
      return [...blocks.entries()]
        .filter(([, name]) => name === 'chest')
        .map(([entry]) => {
          const [x, y, z] = entry.split(',').map(Number)
          return vec(x, y, z)
        })
        .filter(position => position.distanceTo(from) <= max)
    },
    async equip(item) {
      bot.heldItem = item
    },
    async placeBlock(reference, faceVector) {
      const target = {
        x: reference.position.x + faceVector.x,
        y: reference.position.y + faceVector.y,
        z: reference.position.z + faceVector.z
      }
      const name = bot.heldItem?.name || 'chest'
      // 真机放一块就少一件：不扣的话「放完重算要存什么」那一步就试不出来
      const source = inventoryItems.find(item => item.name === name)
      if (!source || source.count <= 0) throw new Error(`no ${name} to place`)
      source.count -= 1
      setBlock(target, name)
      placed.push({ position: target, name })
    },
    recipesFor(itemId, metadata, count, craftingTable) {
      // 箱子是 3x3 配方：没有工作台就没有配方（真规律）
      if (!craftingTable) return []
      return [{ result: { id: itemId, count: 1 }, requiresTable: true }]
    },
    async craft(recipe, count) {
      crafted.push({ recipe, count })
      const plank = inventoryItems.find(item => item.name.endsWith('_planks') && item.count >= 8)
      if (!plank) throw new Error('not enough planks')
      plank.count -= 8
      const existing = inventoryItems.find(item => item.name === 'chest')
      if (existing) existing.count += 1
      else inventoryItems.push({ name: 'chest', count: 1, type: 130 })
    },
    async openChest(block) {
      opened.push({ x: block.position.x, y: block.position.y, z: block.position.z })
      return {
        closed: false,
        containerItems: () => chestContents,
        async deposit(type, metadata, count) {
          // 真链路递的是物品数字 id（actions/storage.js 从 registry 取的），不是名字
          const name = typeof type === 'string'
            ? type
            : (type?.name || inventoryItems.find(item => item.type === type)?.name || String(type))
          const source = inventoryItems.find(item => item.name === name)
          if (!source || source.count <= 0) throw new Error(`no ${name} in inventory`)
          const moved = Math.min(source.count, count)
          source.count -= moved
          const existing = chestContents.find(item => item.name === name)
          if (existing) existing.count += moved
          else chestContents.push({ name, count: moved })
        },
        async withdraw() {},
        close() {
          this.closed = true
        }
      }
    }
  }

  const memoryPath = path.join(os.tmpdir(), `mc-temp-chest-${Date.now()}-${Math.random()}.json`)
  const memory = { world: new WorldMemory(memoryPath, { autosave: false }) }
  for (const chest of options.rememberedChests || []) memory.world.addChestLocation(chest, { source: 'test' })

  const buildSession = options.buildBox
    ? { worldBlocks: boxBlocks(options.buildBox), reservedBounds: null }
    : null

  const taskManager = buildSession
    ? { currentTask: { id: 7, type: 'build_blueprint', state: 'PAUSED', system: { session: buildSession } }, queue: [], pausedStack: [] }
    : { currentTask: null, queue: [], pausedStack: [] }

  return {
    bot,
    memory,
    taskManager,
    actionLock: new ActionLock(),
    blackboard: new Blackboard({
      bot: { position: { x: 0.5, y: 64, z: 0.5 } },
      inventory: {
        counts: Object.fromEntries(inventoryItems.map(item => [item.name, item.count])),
        emptySlots: 0
      },
      mobs: { dangerLevel: 'none' },
      tasks: { currentTask: null }
    }),
    logger: { log() {}, error() {} },
    debug() {},
    // 供断言用
    world: { blocks, placed, crafted, opened, chestContents, inventoryItems, blockNameAt }
  }
}

// 图纸包围盒里的每一格都摊成一块，其中 (1,64,1) 声明成 air——
// 楼梯井那种「图纸上就是空的、但绝不许占用」的格子。
function boxBlocks(box) {
  const out = []
  for (let x = box.minX; x <= box.maxX; x++) {
    for (let y = box.minY; y <= box.maxY; y++) {
      for (let z = box.minZ; z <= box.maxZ; z++) {
        const isWell = x === 1 && y === 64 && z === 1
        out.push({ position: { x, y, z }, type: isWell ? 'air' : 'stone_bricks' })
      }
    }
  }
  return out
}

const JUNK_INVENTORY = [
  { name: 'redstone', count: 64, type: 11 },
  { name: 'piston', count: 12, type: 12 },
  { name: 'hopper', count: 5, type: 13 },
  { name: 'observer', count: 8, type: 14 }
]

const STANDARD_BUILD_BOX = { minX: 0, maxX: 5, minY: 64, maxY: 70, minZ: 0, maxZ: 5 }

function storeOptions(overrides = {}) {
  return {
    owner: 'storage-task-1',
    mode: 'nonEssential',
    radius: 32,
    maxDistance: 32,
    keepItems: BUILD_MATERIALS,
    placeTemporaryChest: true,
    ...overrides
  }
}

// 2-A 荒地无箱子 + 背包有 chest → 就地放箱 → 登记 → 存掉非材料物品
async function testScenarioAPlacesChestFromInventory() {
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    inventoryItems: [
      ...JUNK_INVENTORY,
      { name: 'chest', count: 1, type: 130 },
      { name: 'spruce_planks', count: 40, type: 20 }
    ]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  const { result, lines } = await captureLogs(() => system.storeNonEssentialItems(ctx, storeOptions()))

  assert.strictEqual(result.ok, true, `expected ok, got ${result.error}`)
  // 放在站位旁第一格合规的位置：(1,64,0) 在包围盒内被否掉
  assert.strictEqual(ctx.world.placed.length, 1)
  assert.deepStrictEqual(ctx.world.placed[0].position, { x: -1, y: 64, z: 0 })
  assert.strictEqual(ctx.world.crafted.length, 0)
  // 登记成她自己的箱子
  assert.strictEqual(ctx.memory.world.chestLocations().length, 1)
  const registered = ctx.memory.world.chestLocations()[0]
  assert.deepStrictEqual(registered.position, { x: -1, y: 64, z: 0 })
  assert.ok(registered.tags.includes('temporary'))
  // 存的是门楼旧料那类非材料物品；这一栋的材料留在身上
  const storedNames = ctx.world.chestContents.map(item => item.name).sort()
  assert.deepStrictEqual(storedNames, ['hopper', 'observer', 'piston', 'redstone'])
  assert.strictEqual(ctx.world.chestContents.some(item => item.name === 'spruce_planks'), false)
  assert.strictEqual(ctx.world.inventoryItems.find(item => item.name === 'spruce_planks').count, 40)
  // 记账
  assert.ok(lines.some(line => line.includes('[TEMP_CHEST_PLACED] pos=-1,64,0 source=inventory registered=true')))
  assert.ok(lines.some(line => line.includes('[TEMP_CHEST_STORED] pos=-1,64,0')))
}

// 2-B 荒地无箱子 + 没 chest 但有木板 → 先合成一只再放
async function testScenarioBCraftsChestFromPlanks() {
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    craftingTable: { x: 0, y: 64, z: -2 },
    blocks: [[{ x: 0, y: 64, z: -2 }, 'crafting_table']],
    inventoryItems: [
      ...JUNK_INVENTORY,
      { name: 'oak_planks', count: 20, type: 21 }
    ]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  const { result, lines } = await captureLogs(() => system.storeNonEssentialItems(ctx, storeOptions()))

  assert.strictEqual(result.ok, true, `expected ok, got ${result.error}`)
  assert.strictEqual(ctx.world.crafted.length, 1)
  assert.strictEqual(ctx.world.placed.length, 1)
  assert.deepStrictEqual(ctx.world.placed[0].position, { x: -1, y: 64, z: 0 })
  assert.strictEqual(ctx.memory.world.chestLocations().length, 1)
  assert.ok(lines.some(line => line.includes('[TEMP_CHEST_CRAFTED] planks=oak_planks cost=8')))
  assert.ok(lines.some(line => line.includes('source=crafted:oak_planks')))
  // 合成花掉 8 块，剩下 12 块；storableCount 给木板留 16，所以一块都没倒进去
  assert.strictEqual(ctx.world.inventoryItems.find(item => item.name === 'oak_planks').count, 12)
  assert.strictEqual(ctx.world.chestContents.some(item => item.name === 'oak_planks'), false)
}

// 2-C 32 格内本来就有箱子 → 老路径一字不变：不放、不合成，直接用它
async function testScenarioCExistingChestKeepsOldPath() {
  const existing = { x: 3, y: 64, z: -6 }
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    blocks: [[existing, 'chest']],
    rememberedChests: [existing],
    inventoryItems: [...JUNK_INVENTORY, { name: 'chest', count: 2, type: 130 }]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  const { result, lines } = await captureLogs(() => system.storeNonEssentialItems(ctx, storeOptions()))

  assert.strictEqual(result.ok, true, `expected ok, got ${result.error}`)
  assert.strictEqual(ctx.world.placed.length, 0)
  assert.strictEqual(ctx.world.crafted.length, 0)
  assert.deepStrictEqual(ctx.world.opened, [existing])
  assert.strictEqual(ctx.memory.world.chestLocations().length, 1)
  assert.ok(!lines.some(line => line.includes('[TEMP_CHEST_PLACED]')))
}

// 2-D 两样都没有 → 回落老路径，报的错与改前逐字相同
async function testScenarioDFallsBackToChestNotFound() {
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    inventoryItems: [...JUNK_INVENTORY, { name: 'oak_planks', count: 4, type: 21 }]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  const { result, lines } = await captureLogs(() => system.storeNonEssentialItems(ctx, storeOptions()))

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'chest_not_found')
  assert.strictEqual(ctx.world.placed.length, 0)
  assert.strictEqual(ctx.world.crafted.length, 0)
  assert.ok(lines.some(line => line.includes('[TEMP_CHEST_SKIPPED]') && line.includes('no_chest_and_no_planks')))
  assert.ok(lines.some(line => line.includes('[STORAGE_TASK_FAILED] reason=chest_not_found')))
}

// 2-D' 不带授权时（其余所有调用方）连查都不查：行为与改前逐字相同
async function testWithoutOptInNothingChanges() {
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    inventoryItems: [...JUNK_INVENTORY, { name: 'chest', count: 1, type: 130 }]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  const { result, lines } = await captureLogs(() =>
    system.storeNonEssentialItems(ctx, storeOptions({ placeTemporaryChest: false })))

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'chest_not_found')
  assert.strictEqual(ctx.world.placed.length, 0)
  assert.ok(!lines.some(line => line.includes('[TEMP_CHEST_')))
}

// 2-E 反证：站位周围只剩图纸包围盒里的格子（含那格 air 楼梯井）→ 不放、回落
async function testOnlyInBoundsSpotsMeansNoChest() {
  const ctx = createWorldContext({
    // 包围盒把她整个圈住：12 个候选位一个都不在盒外
    buildBox: { minX: -4, maxX: 4, minY: 60, maxY: 75, minZ: -4, maxZ: 4 },
    inventoryItems: [...JUNK_INVENTORY, { name: 'chest', count: 3, type: 130 }]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  const { result, lines } = await captureLogs(() => system.storeNonEssentialItems(ctx, storeOptions()))

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'chest_not_found')
  assert.strictEqual(ctx.world.placed.length, 0)
  const none = lines.find(line => line.includes('[TEMP_CHEST_SPOT_NONE]'))
  assert.ok(none, 'expected a [TEMP_CHEST_SPOT_NONE] line')
  assert.ok(none.includes('inside_build_bounds'))
  // 那格图纸声明的 air 也被算成包围盒内，不是因为「那里有块砖」
  assert.strictEqual(ctx.world.blockNameAt({ x: 1, y: 64, z: 1 }), 'air')
}

// 2-F 锁：借 placeBlock 之后，储物任务自己的 movement / inventory 必须还回来
async function testTaskLocksSurviveTheBorrowedPlaceBlock() {
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    inventoryItems: [...JUNK_INVENTORY, { name: 'chest', count: 1, type: 130 }]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })

  // 直接盯这一步：storeItems 跑完时锁本来就该被 closeChest 收走（老行为），
  // 要钉的是「借完 placeBlock 之后、往下走之前」锁还在不在。
  const { result, lines } = await captureLogs(() => system.ensureTemporaryChest(ctx, storeOptions()))

  assert.strictEqual(result.ok, true, `ensureTemporaryChest failed: ${result.error}`)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), 'storage-task-1')
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), 'storage-task-1')
  assert.ok(lines.some(line => line.includes('[TEMP_CHEST_LOCKS]') && line.includes('restored=true')))
}

// 2-G 任务已经走到终态（锁被封死）→ 借完还不回来，当兜底失败回落，不硬闯
async function testTerminatedOwnerAbortsTheFallback() {
  const ctx = createWorldContext({
    buildBox: STANDARD_BUILD_BOX,
    inventoryItems: [...JUNK_INVENTORY, { name: 'chest', count: 1, type: 130 }]
  })
  const system = new StorageSystem()
  ctx.actionLock.acquireMany(['movement', 'inventory'], 'storage-task-1', { reason: 'storage:RUNNING' })
  const original = ctx.bot.placeBlock
  ctx.bot.placeBlock = async (reference, faceVector) => {
    // 放置进行中任务被判终态：修缮 15 那个坑的形状
    ctx.actionLock.markOwnerTerminated('storage-task-1', 'task_terminal')
    return original(reference, faceVector)
  }

  const { result, lines } = await captureLogs(() => system.storeNonEssentialItems(ctx, storeOptions()))

  assert.strictEqual(result.ok, false)
  assert.ok(lines.some(line => line.includes('[TEMP_CHEST_LOCKS]') && line.includes('restored=false')))
  assert.ok(lines.some(line => line.includes('action_locks_not_restored')))
}

async function run() {
  await testWildernessWithChestItemDispatchesTemporaryChestUnload()
  await testWildernessWithPlanksDispatchesTemporaryChestUnload()
  await testNearbyChestKeepsOldWorksiteUnloadPath()
  await testWildernessWithoutChestOrPlanksStaysPut()
  await testAwayFromWorksiteKeepsPlainStorageDispatch()
  testCanDeployTemporaryChestNeedsEightOfOneSpecies()
  await testScenarioAPlacesChestFromInventory()
  await testScenarioBCraftsChestFromPlanks()
  await testScenarioCExistingChestKeepsOldPath()
  await testScenarioDFallsBackToChestNotFound()
  await testWithoutOptInNothingChanges()
  await testOnlyInBoundsSpotsMeansNoChest()
  await testTaskLocksSurviveTheBorrowedPlaceBlock()
  await testTerminatedOwnerAbortsTheFallback()
  console.log('temporary worksite chest tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
