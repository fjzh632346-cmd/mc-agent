const assert = require('assert')
const os = require('os')
const path = require('path')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { WorldMemory } = require('../memory/world-memory')
const { StorageSystem } = require('../systems/storage-system')
const { StorageTask } = require('../tasks/storage-task')
const { TaskManager } = require('../tasks/task-manager')
const { parseIntent } = require('../ai/intent-parser')
const { routePlayerCommand } = require('../ai/command-router')
const { ACTION_KEYS } = require('../ai/action-keys')

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

function createChestWindow(items = [], calls = {}) {
  return {
    closed: false,
    containerItems: () => items,
    async deposit(type, metadata, count) {
      calls.deposits = calls.deposits || []
      calls.deposits.push({ type, metadata, count })
    },
    async withdraw(type, metadata, count) {
      calls.withdrawals = calls.withdrawals || []
      calls.withdrawals.push({ type, metadata, count })
    },
    close() {
      this.closed = true
      calls.closed = true
    }
  }
}

function createMutableChestWindow(items = [], calls = {}, label = 'chest', inventoryItems = null, capacity = Infinity) {
  return {
    closed: false,
    containerItems: () => items.filter(item => item.count > 0),
    async deposit(type, metadata, count) {
      calls.deposits = calls.deposits || []
      calls.deposits.push({ label, type, metadata, count })
      const name = itemNameFromType(type)
      const existing = items.find(item => item.name === name)
      if (!existing && items.filter(item => item.count > 0).length >= capacity) {
        throw new Error('Chest is full')
      }
      if (Array.isArray(inventoryItems)) removeMutableItems(inventoryItems, name, count)
      if (existing) existing.count += count
      else items.push({ name, count, type, metadata })
    },
    async withdraw(type, metadata, count) {
      calls.withdrawals = calls.withdrawals || []
      calls.withdrawals.push({ label, type, metadata, count })
      const name = itemNameFromType(type)
      let remaining = count
      for (const item of items.filter(item => item.name === name)) {
        if (remaining <= 0) break
        const moved = Math.min(item.count, remaining)
        item.count -= moved
        remaining -= moved
        addMutableItem(inventoryItems, { name, count: moved, type, metadata })
      }
    },
    close() {
      this.closed = true
      calls.closed = true
    }
  }
}

function addMutableItem(items, item) {
  if (!Array.isArray(items) || !item?.name || item.count <= 0) return
  const existing = items.find(candidate => candidate.name === item.name)
  if (existing) existing.count += item.count
  else items.push({ ...item })
}

function removeMutableItems(items, name, count) {
  if (!Array.isArray(items) || !name || count <= 0) return 0
  let remaining = count
  let removed = 0
  for (const item of items.filter(candidate => candidate.name === name)) {
    if (remaining <= 0) break
    const amount = Math.min(item.count, remaining)
    item.count -= amount
    remaining -= amount
    removed += amount
  }
  return removed
}

function itemNameFromType(type) {
  if (typeof type === 'string') return type
  if (type?.name) return type.name
  if (type === 1) return 'cobblestone'
  if (type === 2) return 'dirt'
  if (type === 5) return 'oak_log'
  if (type === 6) return 'oak_planks'
  return String(type)
}

function createContext(options = {}) {
  const calls = {}
  const inventoryItems = options.inventoryItems || [
    { name: 'cobblestone', count: 64, type: 1 },
    { name: 'dirt', count: 40, type: 2 },
    { name: 'iron_pickaxe', count: 1, type: 3 },
    { name: 'bread', count: 3, type: 4 }
  ]
  const chestPosition = options.chestPosition || vec(2, 64, 0)
  const chestWindow = createChestWindow(options.chestItems || [{ name: 'oak_log', count: 12, type: 5 }], calls)
  const bot = {
    entity: { position: vec(0, 64, 0) },
    registry: {
      blocksByName: {
        chest: { id: 54 },
        trapped_chest: { id: 146 }
      },
      foodsByName: {
        bread: { name: 'bread' },
        apple: { name: 'apple' },
        cooked_beef: { name: 'cooked_beef' },
        golden_apple: { name: 'golden_apple' },
        rotten_flesh: { name: 'rotten_flesh' },
        spider_eye: { name: 'spider_eye' },
        pufferfish: { name: 'pufferfish' }
      }
    },
    inventory: {
      items: () => inventoryItems,
      slots: Array.from({ length: 45 }, () => null)
    },
    pathfinder: {
      setMovements() {},
      setGoal() {},
      stop() {}
    },
    blockAt(position) {
      if (!options.noChest && position.x === chestPosition.x && position.y === chestPosition.y && position.z === chestPosition.z) {
        return { name: 'chest', position: chestPosition, liveBlock: true }
      }
      return { name: 'air', position }
    },
    findBlocks() {
      return options.noChest ? [] : [chestPosition]
    },
    async openChest(block) {
      assert.strictEqual(block.liveBlock, true)
      calls.opened = block.position
      calls.openedBlock = block
      return chestWindow
    }
  }
  const memoryPath = path.join(os.tmpdir(), `mc-storage-memory-${Date.now()}-${Math.random()}.json`)
  const memory = { world: new WorldMemory(memoryPath, { autosave: true }) }
  if (options.rememberChest !== false && !options.noChest) memory.world.addChestLocation(chestPosition, { source: 'test' })

  return {
    bot,
    calls,
    chestWindow,
    actionLock: new ActionLock(),
    blackboard: new Blackboard({
      bot: { position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } },
      inventory: {
        counts: Object.fromEntries(inventoryItems.map(item => [item.name, item.count])),
        emptySlots: options.emptySlots ?? 10
      },
      mobs: { dangerLevel: options.dangerLevel || 'none' },
      tasks: { currentTask: null }
    }),
    memory,
    logger: { log() {}, error() {} },
    debug() {}
  }
}

async function runTask(task, ctx) {
  await task.start(ctx)
  await task.update(ctx)
}

async function testRememberChestAndDedupe() {
  const ctx = createContext({ rememberChest: false })
  const system = new StorageSystem()
  let result = system.rememberChest(ctx)
  assert.strictEqual(result.ok, true)
  result = system.rememberChest(ctx)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.memory.world.summary().chestLocations, 1)
}

async function testFindBestChestAndMissingChest() {
  let ctx = createContext()
  let system = new StorageSystem()
  let result = system.findBestChest(ctx)
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.chest.position, { x: 2, y: 64, z: 0 })

  ctx = createContext({ noChest: true, rememberChest: false })
  system = new StorageSystem()
  result = system.findBestChest(ctx)
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'chest_not_found')
}

async function testTransientChestOpenFailureRetainsLiveCandidate() {
  const ctx = createContext()
  const system = new StorageSystem()
  const position = vec(2, 64, 0)
  ctx.bot.openChest = async () => {
    throw new Error('Event windowOpen did not fire within timeout of 20000ms')
  }

  let opened = await system.openCandidateChest(ctx, { position }, { owner: 'test' })
  assert.strictEqual(opened.ok, false)
  assert.strictEqual(system.invalidChestPositions.has('2,64,0'), false)
  assert.ok(system.buildChestCandidates(ctx).some(candidate => candidate.position.x === 2))

  ctx.bot.openChest = async () => ctx.chestWindow
  opened = await system.openCandidateChest(ctx, { position }, { owner: 'test' })
  assert.strictEqual(opened.ok, true)
  ctx.chestWindow.close()
  ctx.actionLock.releaseAll('test')

  ctx.bot.blockAt = queried => ({ name: 'air', position: queried })
  opened = await system.openCandidateChest(ctx, { position }, { owner: 'test' })
  assert.strictEqual(opened.ok, false)
  assert.strictEqual(system.invalidChestPositions.has('2,64,0'), true)
}

async function testStoreAndTakeItemsCallActions() {
  let ctx = createContext()
  let system = new StorageSystem()
  let result = await system.storeItems(ctx, { owner: 'test', itemName: 'cobblestone', count: 10, mode: 'specific' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.calls.deposits[0].count, 10)
  assert.strictEqual(ctx.calls.closed, true)

  ctx = createContext({ chestItems: [{ name: 'oak_log', count: 12, type: 5 }] })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'oak_log', count: 4 })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.calls.withdrawals[0].count, 4)
}

async function testTakeItemsPrioritizesBuildStorageAnchor() {
  const ctx = createContext({ rememberChest: false })
  const emptyChest = vec(1, 64, 0)
  const storageChest = vec(10, 64, 0)
  const opened = []
  const withdrawalCalls = {}

  ctx.bot.findBlocks = () => [emptyChest, storageChest]
  ctx.bot.blockAt = position => {
    if (position.x === emptyChest.x && position.y === emptyChest.y && position.z === emptyChest.z) {
      return { name: 'chest', type: 54, id: 54, position: emptyChest, liveBlock: true }
    }
    if (position.x === storageChest.x && position.y === storageChest.y && position.z === storageChest.z) {
      return { name: 'chest', type: 54, id: 54, position: storageChest, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    opened.push(block.position)
    if (block.position.x === storageChest.x) {
      return createChestWindow([{ name: 'oak_log', count: 4, type: 5 }], withdrawalCalls)
    }
    return createChestWindow([], withdrawalCalls)
  }

  const system = new StorageSystem()
  const result = await system.takeItems(ctx, {
    owner: 'test',
    itemName: 'oak_log',
    count: 1,
    scanCenters: [{ source: 'build_storage_1', position: storageChest }]
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(opened[0].x, storageChest.x)
  assert.strictEqual(withdrawalCalls.withdrawals[0].count, 1)
}

async function testStagingInventoryUsesExactScanCenters() {
  const primaryChest = vec(0, 64, 0)
  const nearbyChest = vec(1, 64, 0)
  const ctx = createContext({ rememberChest: false, chestPosition: primaryChest })
  const opened = []
  const primaryWindow = createChestWindow([{ name: 'dirt', count: 3, type: 2 }])
  const nearbyWindow = createChestWindow([{ name: 'oak_planks', count: 12, type: 6 }])
  ctx.bot.findBlocks = () => [primaryChest, nearbyChest]
  ctx.bot.blockAt = position => {
    if (position.x === primaryChest.x && position.y === primaryChest.y && position.z === primaryChest.z) {
      return { name: 'chest', type: 54, id: 54, position: primaryChest, liveBlock: true }
    }
    if (position.x === nearbyChest.x && position.y === nearbyChest.y && position.z === nearbyChest.z) {
      return { name: 'chest', type: 54, id: 54, position: nearbyChest, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    opened.push(`${block.position.x},${block.position.y},${block.position.z}`)
    return block.position.x === primaryChest.x ? primaryWindow : nearbyWindow
  }

  const system = new StorageSystem()
  const result = await system.getStagingInventory(ctx, {
    owner: 'test',
    scanCenters: [{ position: primaryChest, source: 'primary_staging' }]
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.counts.dirt, 3)
  assert.strictEqual(result.counts.oak_planks, undefined)
  assert.deepStrictEqual(opened, ['0,64,0'])
}

async function testLooseSeedWithdrawCounts() {
  let parsed = parseIntent('\u4ece\u7bb1\u5b50\u91cc\u62ff\u70b9\u79cd\u5b50')
  assert.strictEqual(parsed.actionKey, ACTION_KEYS.TAKE_ITEMS)
  assert.strictEqual(parsed.params.itemName, 'wheat_seeds')
  assert.strictEqual(parsed.params.count, null)

  let ctx = createContext({ chestItems: [{ name: 'wheat_seeds', count: 16, type: 201 }] })
  let system = new StorageSystem()
  let result = await system.takeItems(ctx, { owner: 'test', itemName: 'wheat_seeds', count: parsed.params.count, query: parsed.rawText })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].count, 8)
  assert.strictEqual(ctx.calls.withdrawals[0].count, 8)

  ctx = createContext({ chestItems: [{ name: 'wheat_seeds', count: 3, type: 201 }] })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'wheat_seeds', count: null, query: '\u4ece\u7bb1\u5b50\u91cc\u62ff\u70b9\u79cd\u5b50' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].count, 3)
  assert.strictEqual(ctx.calls.withdrawals[0].count, 3)

  parsed = parseIntent('\u628a\u7bb1\u5b50\u91cc\u7684\u6240\u6709\u79cd\u5b50\u62ff\u51fa\u6765')
  assert.strictEqual(parsed.params.itemName, 'wheat_seeds')
  assert.strictEqual(parsed.params.count, 'all')
  ctx = createContext({ chestItems: [{ name: 'wheat_seeds', count: 11, type: 201 }] })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'wheat_seeds', count: 'all', query: parsed.rawText })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].count, 11)
}

async function testWoodCategoryDepositFullChain() {
  const parsed = parseIntent('\u628a\u6728\u5934\u653e\u7bb1\u5b50\u91cc')
  assert.strictEqual(parsed.actionKey, ACTION_KEYS.STORE_ITEMS)
  assert.strictEqual(parsed.params.category, 'wood')
  assert.strictEqual(parsed.params.itemName, null)

  const routeCtx = createContext()
  routeCtx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    }
  }
  const routed = await routePlayerCommand('\u628a\u6728\u5934\u653e\u7bb1\u5b50\u91cc', routeCtx)
  assert.strictEqual(routed.whetherExecuted, true)
  assert.strictEqual(routeCtx.taskManager.enqueued[0].type, 'storage')
  assert.strictEqual(routeCtx.taskManager.enqueued[0].params.category, 'wood')
  assert.strictEqual(routeCtx.taskManager.enqueued[0].params.itemName, null)

  const ctx = createContext({
    inventoryItems: [
      { name: 'oak_log', count: 4, type: 101 },
      { name: 'birch_log', count: 5, type: 102 },
      { name: 'spruce_planks', count: 6, type: 103 },
      { name: 'cobblestone', count: 7, type: 104 }
    ]
  })
  const system = new StorageSystem()
  const result = await system.storeItems(ctx, { owner: 'test', category: 'wood', mode: 'category', count: 'all' })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.storedItems.map(item => item.itemName), ['oak_log', 'birch_log', 'spruce_planks'])
}

async function testWoodCategoryWithdrawUsesLooseCount() {
  const ctx = createContext({
    chestItems: [
      { name: 'oak_log', count: 2, type: 101 },
      { name: 'birch_log', count: 2, type: 102 },
      { name: 'spruce_log', count: 2, type: 103 },
      { name: 'oak_planks', count: 2, type: 104 },
      { name: 'birch_planks', count: 2, type: 105 },
      { name: 'spruce_planks', count: 2, type: 106 }
    ]
  })
  const system = new StorageSystem()
  const result = await system.takeItems(ctx, { owner: 'test', category: 'wood', count: null, query: '\u4ece\u7bb1\u5b50\u91cc\u62ff\u70b9\u6728\u5934' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems.reduce((sum, item) => sum + item.count, 0), 8)
  assert.strictEqual(ctx.calls.withdrawals.reduce((sum, item) => sum + item.count, 0), 8)
}

async function testWoodCategoryDepositSkipsStaleMissingItems() {
  const inventoryItems = [
    { name: 'oak_log', count: 4, type: 101 },
    { name: 'birch_log', count: 5, type: 102 },
    { name: 'spruce_planks', count: 6, type: 103 }
  ]
  const ctx = createContext({ inventoryItems })
  inventoryItems.splice(1, 1)

  const system = new StorageSystem()
  const result = await system.storeItems(ctx, { owner: 'test', category: 'wood', mode: 'category', count: 'all' })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.storedItems.map(item => item.itemName), ['oak_log', 'spruce_planks'])
  assert.deepStrictEqual(result.missingItems, [{ itemName: 'birch_log', count: 5, category: 'wood' }])
  assert.strictEqual(ctx.calls.deposits.length, 2)
}

async function testWoodSubcategoryDeposits() {
  let ctx = createContext({
    inventoryItems: [
      { name: 'oak_log', count: 4, type: 101 },
      { name: 'birch_log', count: 5, type: 102 },
      { name: 'spruce_planks', count: 6, type: 103 }
    ]
  })
  let parsed = parseIntent('\u628a\u539f\u6728\u653e\u7bb1\u5b50\u91cc')
  assert.strictEqual(parsed.params.category, 'logs')
  let system = new StorageSystem()
  let result = await system.storeItems(ctx, { owner: 'test', category: 'logs', mode: 'category', count: 'all' })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.storedItems.map(item => item.itemName), ['oak_log', 'birch_log'])

  ctx = createContext({
    inventoryItems: [
      { name: 'oak_log', count: 4, type: 101 },
      { name: 'oak_planks', count: 3, type: 102 },
      { name: 'spruce_planks', count: 6, type: 103 }
    ]
  })
  parsed = parseIntent('\u628a\u6728\u677f\u653e\u7bb1\u5b50\u91cc')
  assert.strictEqual(parsed.params.category, 'planks')
  system = new StorageSystem()
  result = await system.storeItems(ctx, { owner: 'test', category: 'planks', mode: 'category', count: 'all' })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.storedItems.map(item => item.itemName), ['oak_planks', 'spruce_planks'])
}

async function testExplicitOakDepositOnlyOakFamily() {
  const parsed = parseIntent('\u628a\u6a61\u6728\u653e\u7bb1\u5b50\u91cc')
  assert.strictEqual(parsed.actionKey, ACTION_KEYS.STORE_ITEMS)
  assert.strictEqual(parsed.params.category, 'oak_wood')

  const ctx = createContext({
    inventoryItems: [
      { name: 'oak_log', count: 4, type: 101 },
      { name: 'oak_planks', count: 3, type: 102 },
      { name: 'stripped_oak_log', count: 2, type: 103 },
      { name: 'birch_log', count: 5, type: 104 }
    ]
  })
  const system = new StorageSystem()
  const result = await system.storeItems(ctx, { owner: 'test', category: 'oak_wood', mode: 'category', count: 'all' })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.storedItems.map(item => item.itemName), ['oak_log', 'oak_planks', 'stripped_oak_log'])
}

async function testFoodWithdrawPriorityAndGuards() {
  let ctx = createContext({
    chestItems: [{ name: 'bread', count: 20, type: 13 }]
  })
  let system = new StorageSystem()
  let result = await system.takeItems(ctx, { owner: 'test', itemName: 'food' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].itemName, 'bread')
  assert.strictEqual(ctx.calls.withdrawals[0].count, 8)

  ctx = createContext({
    chestItems: [
      { name: 'golden_apple', count: 1, type: 10 },
      { name: 'cooked_beef', count: 2, type: 11 },
      { name: 'apple', count: 3, type: 12 },
      { name: 'bread', count: 4, type: 13 }
    ]
  })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'food', count: 1 })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].itemName, 'bread')

  ctx = createContext({ chestItems: [{ name: 'golden_apple', count: 1, type: 10 }] })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'food', count: 1 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'food_requires_confirmation:precious')
  assert.strictEqual(ctx.calls.withdrawals, undefined)

  ctx = createContext({ chestItems: [{ name: 'golden_apple', count: 1, type: 10 }] })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'golden_apple', count: 1 })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].itemName, 'golden_apple')

  ctx = createContext({ chestItems: [{ name: 'rotten_flesh', count: 3, type: 14 }] })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: 'food', count: 1 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'food_requires_confirmation:risky')
  assert.strictEqual(ctx.calls.withdrawals, undefined)
}

async function testCategoryArmorWithdrawAndEquip() {
  const ctx = createContext({
    chestItems: [
      { name: 'leather_helmet', count: 1, type: 21 },
      { name: 'iron_helmet', count: 1, type: 22 },
      { name: 'iron_chestplate', count: 1, type: 23 },
      { name: 'iron_leggings', count: 1, type: 24 },
      { name: 'iron_boots', count: 1, type: 25 }
    ]
  })
  let equipped = false
  ctx.equipmentSystem = {
    async equipBestArmor() {
      equipped = true
      return { success: true, equippedCount: 4, results: [] }
    },
    getArmorStatus() {
      return { bestAvailableArmor: {}, missingArmorSlots: [] }
    }
  }
  const system = new StorageSystem()
  const result = await system.takeItems(ctx, { owner: 'test', category: 'armor', equipAfter: true, query: '从箱子里拿装备穿上' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(equipped, true)
  assert.deepStrictEqual(result.withdrawnItems.map(item => item.itemName), [
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots'
  ])
}

async function testAllSteakAliasWithdraw() {
  const parsed = parseIntent('从箱子里拿出所有牛排')
  assert.strictEqual(parsed.actionKey, ACTION_KEYS.TAKE_ITEMS)
  assert.strictEqual(parsed.params.itemName, 'cooked_beef')
  assert.strictEqual(parsed.params.count, 'all')

  const ctx = createContext({ chestItems: [{ name: 'cooked_beef', count: 10, type: 11 }] })
  const system = new StorageSystem()
  const result = await system.takeItems(ctx, { owner: 'test', itemName: 'cooked_beef', count: 'all', query: '从箱子里拿出所有牛排' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].itemName, 'cooked_beef')
  assert.strictEqual(ctx.calls.withdrawals[0].count, 10)
}

async function testAllPorkchopAliasWithdraw() {
  const parsed = parseIntent('把箱子里的所有猪排拿出来')
  assert.strictEqual(parsed.actionKey, ACTION_KEYS.TAKE_ITEMS)
  assert.strictEqual(parsed.params.itemName, 'cooked_porkchop')
  assert.strictEqual(parsed.params.count, 'all')

  const ctx = createContext({
    chestItems: [
      { name: 'cooked_porkchop', count: 64, type: 12, slot: 0 },
      { name: 'cooked_porkchop', count: 16, type: 12, slot: 1 }
    ]
  })
  const system = new StorageSystem()
  const result = await system.takeItems(ctx, { owner: 'test', itemName: 'cooked_porkchop', count: 'all', query: '把箱子里的所有猪排拿出来' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].itemName, 'cooked_porkchop')
  assert.strictEqual(result.withdrawnItems[0].count, 80)
  assert.deepStrictEqual(ctx.calls.withdrawals.map(call => call.count), [64, 16])
}

async function testFoodAliasCoverage() {
  const cases = [
    ['把所有面包拿出来', 'bread'],
    ['把所有苹果拿出来', 'apple'],
    ['把所有牛排拿出来', 'cooked_beef'],
    ['把所有猪排拿出来', 'cooked_porkchop'],
    ['把所有熟猪排拿出来', 'cooked_porkchop'],
    ['把所有生猪肉拿出来', 'porkchop'],
    ['把所有熟鸡肉拿出来', 'cooked_chicken'],
    ['把所有生鸡肉拿出来', 'chicken'],
    ['把所有熟羊肉拿出来', 'cooked_mutton'],
    ['把所有生羊肉拿出来', 'mutton'],
    ['把所有熟兔肉拿出来', 'cooked_rabbit'],
    ['把所有生兔肉拿出来', 'rabbit'],
    ['把所有熟鳕鱼拿出来', 'cooked_cod'],
    ['把所有生鳕鱼拿出来', 'cod'],
    ['把所有熟鲑鱼拿出来', 'cooked_salmon'],
    ['把所有生三文鱼拿出来', 'salmon'],
    ['把所有金苹果拿出来', 'golden_apple'],
    ['把所有附魔金苹果拿出来', 'enchanted_golden_apple'],
    ['把所有胡萝卜拿出来', 'carrot'],
    ['把所有金胡萝卜拿出来', 'golden_carrot'],
    ['把所有土豆拿出来', 'potato'],
    ['把所有烤土豆拿出来', 'baked_potato'],
    ['把所有毒土豆拿出来', 'poisonous_potato'],
    ['把所有甜菜根拿出来', 'beetroot'],
    ['把所有甜菜汤拿出来', 'beetroot_soup'],
    ['把所有蘑菇汤拿出来', 'mushroom_stew'],
    ['把所有兔肉汤拿出来', 'rabbit_stew'],
    ['把所有南瓜派拿出来', 'pumpkin_pie'],
    ['把所有饼干拿出来', 'cookie'],
    ['把所有西瓜片拿出来', 'melon_slice'],
    ['把所有干海带拿出来', 'dried_kelp'],
    ['把所有腐肉拿出来', 'rotten_flesh'],
    ['把所有蜘蛛眼拿出来', 'spider_eye'],
    ['把所有河豚拿出来', 'pufferfish']
  ]

  for (const [text, itemName] of cases) {
    const parsed = parseIntent(text)
    assert.strictEqual(parsed.actionKey, ACTION_KEYS.TAKE_ITEMS, text)
    assert.strictEqual(parsed.params.itemName, itemName, text)
    assert.strictEqual(parsed.params.count, 'all', text)
  }
}

async function testStorageItemNameResolutionGuards() {
  const cases = [
    ['\u4ece\u7bb1\u5b50\u91cc\u62ff\u7ea2\u8272\u67d3\u6599', ACTION_KEYS.TAKE_ITEMS, 'red_dye'],
    ['\u4ece\u7bb1\u5b50\u91cc\u62ff\u9644\u9b54\u4e66', ACTION_KEYS.TAKE_ITEMS, 'enchanted_book'],
    ['\u4ece\u7bb1\u5b50\u91cc\u62ff\u7c97\u94c1', ACTION_KEYS.TAKE_ITEMS, 'raw_iron'],
    ['\u4ece\u7bb1\u5b50\u91cc\u62ff raw_iron', ACTION_KEYS.TAKE_ITEMS, 'raw_iron'],
    ['\u628a red_dye \u653e\u8fdb\u7bb1\u5b50', ACTION_KEYS.STORE_ITEMS, 'red_dye'],
    ['\u5b58\u725b\u6392', ACTION_KEYS.STORE_ITEMS, 'cooked_beef'],
    ['\u53d6\u706b\u628a', ACTION_KEYS.TAKE_ITEMS, 'torch'],
    ['\u628a\u94c1\u952d\u653e\u8fdb\u7bb1\u5b50', ACTION_KEYS.STORE_ITEMS, 'iron_ingot']
  ]

  for (const [text, actionKey, itemName] of cases) {
    const parsed = parseIntent(text)
    assert.strictEqual(parsed.actionKey, actionKey, text)
    assert.strictEqual(parsed.params.itemName, itemName, text)
    assert.notStrictEqual(parsed.params.itemName, 'chest', text)
  }
}

async function testWithdrawAllAcrossStacks() {
  let ctx = createContext({
    chestItems: [
      { name: 'golden_apple', count: 64, type: 10, slot: 0 },
      { name: 'golden_apple', count: 32, type: 10, slot: 1 }
    ]
  })
  let system = new StorageSystem()
  let result = await system.takeItems(ctx, { owner: 'test', itemName: 'golden_apple', count: 'all', query: '把箱子里的所有金苹果拿出来' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.withdrawnItems[0].count, 96)
  assert.strictEqual(ctx.calls.withdrawals.length, 2)
  assert.deepStrictEqual(ctx.calls.withdrawals.map(call => call.count), [64, 32])

  ctx = createContext({
    chestItems: [
      { name: 'golden_apple', count: 2, type: 10, slot: 0 },
      { name: 'golden_apple', count: 3, type: 10, slot: 1 }
    ]
  })
  system = new StorageSystem()
  result = await system.takeItems(ctx, { owner: 'test', itemName: null, count: 'all', query: '全部拿出来' })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'item_name_unrecognized')
  assert.strictEqual(ctx.calls.withdrawals, undefined)
}

async function testMissingSpecificItemDoesNotSucceed() {
  const ctx = createContext({ chestItems: [{ name: 'bread', count: 8, type: 13 }] })
  const system = new StorageSystem()
  const result = await system.takeItems(ctx, { owner: 'test', itemName: 'cooked_porkchop', count: 'all', query: '把箱子里的所有猪排拿出来' })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'chest_item_not_found:cooked_porkchop')
  assert.strictEqual(ctx.calls.withdrawals, undefined)
}

async function testWithdrawUsesAnchorScanCentersWhenBotIsFarFromChest() {
  const chestPosition = vec(0, 64, 0)
  const ctx = createContext({
    chestPosition,
    chestItems: [{ name: 'dirt', count: 64, type: 2 }],
    rememberChest: false
  })
  const originalBlockAt = ctx.bot.blockAt.bind(ctx.bot)
  ctx.bot.entity.position = vec(100, 64, 0)
  ctx.bot.findBlocks = () => []
  ctx.bot.blockAt = position => {
    if (position.x === chestPosition.x && position.y === chestPosition.y && position.z === chestPosition.z) {
      return { name: 'chest', type: 54, id: 54, position: chestPosition, liveBlock: true }
    }
    return originalBlockAt(position)
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.takeItems(ctx, {
    owner: 'test',
    itemName: 'dirt',
    count: 4,
    scanCenters: [{ source: 'build_origin', position: chestPosition }]
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.calls.withdrawals[0].count, 4)
  assert.deepStrictEqual(ctx.calls.opened, chestPosition)
}

async function testWithdrawCanIgnoreStaleMemoryForBuildStorage() {
  const staleChest = vec(1, 64, 0)
  const storageChest = vec(20, 64, 0)
  const ctx = createContext({ rememberChest: false })
  const opened = []
  const calls = {}

  ctx.memory.world.addChestLocation(staleChest, { source: 'old_storage' })
  ctx.bot.findBlocks = () => [staleChest]
  ctx.bot.blockAt = position => {
    if (position.x === staleChest.x && position.y === staleChest.y && position.z === staleChest.z) {
      return { name: 'chest', type: 54, id: 54, position: staleChest, liveBlock: true }
    }
    if (position.x === storageChest.x && position.y === storageChest.y && position.z === storageChest.z) {
      return { name: 'chest', type: 54, id: 54, position: storageChest, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    opened.push(block.position)
    return createChestWindow([{ name: 'dirt', count: 8, type: 2 }], calls)
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.takeItems(ctx, {
    owner: 'test',
    itemName: 'dirt',
    count: 4,
    scanCenters: [{ source: 'build_storage_1', position: storageChest, radius: 4 }],
    scanOnlyProvidedCenters: true,
    skipMemorySearch: true,
    skipUtilitySearch: true
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(opened[0].x, storageChest.x)
  assert.strictEqual(calls.withdrawals[0].count, 4)
}

async function testEnsureStagingMaterialsMovesInventoryIntoExactStagingChest() {
  const stagingChest = vec(6, 64, 0)
  const stagingItems = []
  const calls = {}
  const ctx = createContext({
    chestPosition: stagingChest,
    inventoryItems: [{ name: 'oak_planks', count: 4, type: 6, stackSize: 64 }],
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.openChest = async block => createMutableChestWindow(stagingItems, calls, 'staging', ctx.bot.inventory.items())

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { oak_planks: 2 },
    scanCenters: [{ source: 'staging_target', position: stagingChest }]
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(stagingItems.find(item => item.name === 'oak_planks').count, 2)
  assert.strictEqual(calls.deposits[0].label, 'staging')
  assert.strictEqual(result.moved[0].source, 'inventory')
}

async function testEnsureStagingMaterialsVerifiesOnceAfterBatchMove() {
  const stagingChest = vec(6, 64, 0)
  const stagingItems = []
  const calls = {}
  let opened = 0
  const ctx = createContext({
    chestPosition: stagingChest,
    inventoryItems: [
      { name: 'oak_planks', count: 2, type: 6, stackSize: 64 },
      { name: 'spruce_log', count: 2, type: 'spruce_log', stackSize: 64 }
    ],
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.openChest = async block => {
    opened += 1
    return createMutableChestWindow(stagingItems, calls, 'staging', ctx.bot.inventory.items())
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { oak_planks: 1, spruce_log: 1 },
    scanCenters: [{ source: 'staging_target', position: stagingChest }]
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(opened, 4)
  assert.strictEqual(calls.deposits.length, 2)
  assert.strictEqual(result.inventory.oak_planks, 1)
  assert.strictEqual(result.inventory.spruce_log, 1)
}

async function testEnsureStagingMaterialsUsesNextStagingChestWhenFirstIsFull() {
  const fullChest = vec(6, 64, 0)
  const emptyChest = vec(8, 64, 0)
  const fullItems = Array.from({ length: 27 }, (_, index) => ({ name: `filler_${index}`, count: 1, type: 1000 + index }))
  const emptyItems = []
  const calls = {}
  const ctx = createContext({
    inventoryItems: [{ name: 'spruce_log', count: 12, type: 'spruce_log', stackSize: 64 }],
    chestPosition: fullChest,
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.findBlocks = ({ point, maxDistance }) => {
    return [fullChest, emptyChest].filter(position => position.distanceTo(point) <= maxDistance)
  }
  ctx.bot.blockAt = position => {
    if (position.x === fullChest.x && position.y === fullChest.y && position.z === fullChest.z) {
      return { name: 'chest', type: 54, id: 54, position: fullChest, liveBlock: true }
    }
    if (position.x === emptyChest.x && position.y === emptyChest.y && position.z === emptyChest.z) {
      return { name: 'chest', type: 54, id: 54, position: emptyChest, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    if (block.position.x === fullChest.x) {
      return createMutableChestWindow(fullItems, calls, 'full_staging', ctx.bot.inventory.items(), 27)
    }
    return createMutableChestWindow(emptyItems, calls, 'empty_staging', ctx.bot.inventory.items(), 27)
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { spruce_log: 8 },
    scanCenters: [
      { source: 'staging_full', position: fullChest, radius: 1 },
      { source: 'staging_empty', position: emptyChest, radius: 1 }
    ]
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(emptyItems.find(item => item.name === 'spruce_log').count, 8)
  assert.strictEqual(calls.deposits[0].label, 'full_staging')
  assert.strictEqual(calls.deposits[1].label, 'empty_staging')
  assert.strictEqual(result.inventory.spruce_log, 8)
}

async function testEnsureStagingMaterialsPrefersSuccessfulChestForBatch() {
  const fullChest = vec(6, 64, 0)
  const emptyChest = vec(8, 64, 0)
  const fullItems = Array.from({ length: 27 }, (_, index) => ({ name: `filler_${index}`, count: 1, type: 1000 + index }))
  const emptyItems = []
  const calls = {}
  const ctx = createContext({
    inventoryItems: [
      { name: 'spruce_log', count: 4, type: 'spruce_log', stackSize: 64 },
      { name: 'oak_planks', count: 4, type: 6, stackSize: 64 }
    ],
    chestPosition: fullChest,
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.findBlocks = ({ point, maxDistance }) => {
    return [fullChest, emptyChest].filter(position => position.distanceTo(point) <= maxDistance)
  }
  ctx.bot.blockAt = position => {
    if (position.x === fullChest.x && position.y === fullChest.y && position.z === fullChest.z) {
      return { name: 'chest', type: 54, id: 54, position: fullChest, liveBlock: true }
    }
    if (position.x === emptyChest.x && position.y === emptyChest.y && position.z === emptyChest.z) {
      return { name: 'chest', type: 54, id: 54, position: emptyChest, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    if (block.position.x === fullChest.x) {
      return createMutableChestWindow(fullItems, calls, 'full_staging', ctx.bot.inventory.items(), 27)
    }
    return createMutableChestWindow(emptyItems, calls, 'empty_staging', ctx.bot.inventory.items(), 27)
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { spruce_log: 1, oak_planks: 1 },
    scanCenters: [
      { source: 'staging_full', position: fullChest, radius: 1 },
      { source: 'staging_empty', position: emptyChest, radius: 1 }
    ]
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(calls.deposits.map(call => call.label), ['full_staging', 'empty_staging', 'empty_staging'])
  assert.strictEqual(result.inventory.spruce_log, 1)
  assert.strictEqual(result.inventory.oak_planks, 1)
}

async function testEnsureStagingMaterialsMovesSourceChestIntoExactStagingChest() {
  const sourceChest = vec(0, 64, 0)
  const stagingChest = vec(8, 64, 0)
  const sourceItems = [{ name: 'oak_planks', count: 5, type: 6 }]
  const stagingItems = []
  const calls = {}
  const ctx = createContext({
    inventoryItems: [],
    chestPosition: stagingChest,
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.findBlocks = ({ point, maxDistance }) => {
    return [sourceChest, stagingChest].filter(position => position.distanceTo(point) <= maxDistance)
  }
  ctx.bot.blockAt = position => {
    if (position.x === sourceChest.x && position.y === sourceChest.y && position.z === sourceChest.z) {
      return { name: 'chest', type: 54, id: 54, position: sourceChest, liveBlock: true }
    }
    if (position.x === stagingChest.x && position.y === stagingChest.y && position.z === stagingChest.z) {
      return { name: 'chest', type: 54, id: 54, position: stagingChest, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    if (block.position.x === sourceChest.x) return createMutableChestWindow(sourceItems, calls, 'source', ctx.bot.inventory.items())
    return createMutableChestWindow(stagingItems, calls, 'staging', ctx.bot.inventory.items())
  }

  const system = new StorageSystem({ chestSearchRadius: 12 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { oak_planks: 3 },
    scanCenters: [{ source: 'staging_target', position: stagingChest }],
    sourceScanCenters: [{ source: 'main_storage', position: sourceChest, radius: 1 }]
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(sourceItems[0].count, 2)
  assert.strictEqual(stagingItems.find(item => item.name === 'oak_planks').count, 3)
  assert.strictEqual(calls.withdrawals[0].label, 'source')
  assert.strictEqual(calls.deposits[0].label, 'staging')
  assert.strictEqual(result.moved[0].source, 'storage')
}

async function testEnsureStagingMaterialsCraftsMissingMaterialIntoStaging() {
  const stagingChest = vec(8, 64, 0)
  const stagingItems = [{ name: 'dark_oak_planks', count: 20, type: 'dark_oak_planks', stackSize: 64 }]
  const calls = {}
  const ctx = createContext({
    inventoryItems: [],
    chestPosition: stagingChest,
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.openChest = async () => createMutableChestWindow(stagingItems, calls, 'staging', ctx.bot.inventory.items())
  const prepared = []
  ctx.autoPreparationSystem = {
    async ensureItem(context, itemName, count, options) {
      prepared.push({ itemName, count, options, storageCounts: context.blackboard.get('storage.counts') })
      assert.strictEqual(itemName, 'dark_oak_fence_gate')
      assert.strictEqual(count, 5)
      assert.strictEqual(options.allowStorage, true)
      assert.strictEqual(context.blackboard.get('storage.counts').dark_oak_planks, 20)
      addMutableItem(context.bot.inventory.items(), {
        name: itemName,
        count,
        type: itemName,
        stackSize: 64
      })
      return { ok: true, reason: 'crafted', itemName, count }
    }
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { dark_oak_fence_gate: 5 },
    scanCenters: [{ source: 'staging_target', position: stagingChest }]
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(prepared.length, 1)
  assert.strictEqual(stagingItems.find(item => item.name === 'dark_oak_fence_gate').count, 5)
  assert.strictEqual(result.moved[0].source, 'crafted')
  assert.strictEqual(result.inventory.dark_oak_fence_gate, 5)
}

async function testEnsureStagingMaterialsDepositsPartialCraftBeforeShortage() {
  const stagingChest = vec(8, 64, 0)
  const stagingItems = [{ name: 'dark_oak_planks', count: 20, type: 'dark_oak_planks', stackSize: 64 }]
  const calls = {}
  const ctx = createContext({
    inventoryItems: [],
    chestPosition: stagingChest,
    chestItems: [],
    rememberChest: false
  })
  ctx.bot.openChest = async () => createMutableChestWindow(stagingItems, calls, 'staging', ctx.bot.inventory.items())
  const prepared = []
  ctx.autoPreparationSystem = {
    async ensureItem(context, itemName, count) {
      prepared.push({ itemName, count })
      assert.strictEqual(itemName, 'dark_oak_fence_gate')
      if (prepared.length === 1) {
        addMutableItem(context.bot.inventory.items(), {
          name: itemName,
          count: 2,
          type: itemName,
          stackSize: 64
        })
        return { ok: false, reason: 'crafted_item_not_available:2/5', itemName, count, finalCount: 2 }
      }
      return { ok: false, reason: 'crafted_item_not_available:0/3', itemName, count, finalCount: 0 }
    }
  }

  const system = new StorageSystem({ chestSearchRadius: 8 })
  const result = await system.ensureStagingMaterials(ctx, {
    owner: 'test',
    required: { dark_oak_fence_gate: 5 },
    scanCenters: [{ source: 'staging_target', position: stagingChest }],
    maxStagingCraftAttempts: 2
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'BLOCKED_MATERIAL_SHORTAGE:dark_oak_fence_gate:3')
  assert.deepStrictEqual(prepared.map(entry => entry.count), [5, 3])
  assert.strictEqual(stagingItems.find(item => item.name === 'dark_oak_fence_gate').count, 2)
  assert.strictEqual(result.moved[0].source, 'crafted')
  assert.strictEqual(result.moved[0].count, 2)
  assert.strictEqual(result.moved[0].partial, true)
  assert.strictEqual(result.missing[0].missing, 3)
}

async function testMissingItemsAndDanger() {
  let ctx = createContext()
  let task = new StorageTask({ id: 1, params: { mode: 'TAKE_ITEMS', itemName: 'diamond', count: 1 } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.error.includes('chest_item_not_found'))
  assert.deepStrictEqual(task.missingItems, [{ itemName: 'diamond', count: 1 }])

  ctx = createContext({ dangerLevel: 'high' })
  task = new StorageTask({ id: 2, params: { mode: 'STORE_ITEMS' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'danger_too_high')
}

async function testTakeItemsStopsBeforeChestWhenInterrupted() {
  const ctx = createContext()
  const system = new StorageSystem()
  const result = await system.takeItems(ctx, {
    owner: 'interrupted_build',
    itemName: 'oak_log',
    count: 1,
    shouldContinue: () => false
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'task_interrupted')
  assert.strictEqual(ctx.calls.opened, undefined)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testPauseResumeInterrupt() {
  let ctx = createContext()
  let task = new StorageTask({ id: 3, params: { mode: 'STORE_ITEMS', itemName: 'cobblestone', count: 1 } })
  await task.start(ctx)
  await task.pause(ctx, 'test_pause')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.opened, undefined)
  await task.resume(ctx)
  await task.update(ctx)
  assert.ok(ctx.calls.opened)

  ctx = createContext()
  task = new StorageTask({ id: 4, params: { mode: 'STORE_ITEMS', itemName: 'cobblestone', count: 1 } })
  await task.start(ctx)
  await task.interrupt(ctx, 'test_interrupt')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.opened, undefined)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testStorageIntentThreeLayers() {
  assert.strictEqual(parseIntent('找点吃的').actionKey, ACTION_KEYS.TAKE_ITEMS)
  assert.strictEqual(parseIntent('拿食物').params.itemName, 'food')
  assert.strictEqual(parseIntent('把东西存起来').actionKey, ACTION_KEYS.STORE_ITEMS)
  assert.strictEqual(parseIntent('我背包满了，帮我收一下').actionKey, ACTION_KEYS.STORE_ITEMS)
  assert.strictEqual(parseIntent('把没用的东西放仓库').actionKey, ACTION_KEYS.STORE_ITEMS)
  assert.strictEqual(parseIntent('记住这个箱子').actionKey, ACTION_KEYS.REMEMBER_CHEST)
  assert.strictEqual(parseIntent('以后东西放这里').actionKey, ACTION_KEYS.REMEMBER_CHEST)
  assert.strictEqual(parseIntent('帮我拿点木头').actionKey, ACTION_KEYS.TAKE_ITEMS)
  assert.strictEqual(parseIntent('仓库里有没有铁').actionKey, ACTION_KEYS.CHECK_STORAGE)
  assert.strictEqual(parseIntent('你喜欢开箱子吗？').actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(parseIntent('以后可以做自动仓库吗？').actionKey, ACTION_KEYS.CHAT)
  const unclear = parseIntent('箱子那边处理一下')
  assert.strictEqual(unclear.actionKey, ACTION_KEYS.STORE_ITEMS)
  assert.strictEqual(unclear.params.needConfirm, true)

  const transfer = parseIntent('把大箱子的牛排放到小箱子里')
  assert.strictEqual(transfer.actionKey, ACTION_KEYS.TRANSFER_ITEMS)
  assert.strictEqual(transfer.params.itemName, 'cooked_beef')
  assert.strictEqual(transfer.params.count, 'all')
  assert.strictEqual(transfer.params.sourceContainerPreference, 'double')
  assert.strictEqual(transfer.params.targetContainerPreference, 'single')
}

async function testRouterSafetyAndLlmPath() {
  let ctx = createContext()
  ctx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    }
  }
  let result = await routePlayerCommand('箱子那边处理一下', ctx)
  assert.strictEqual(result.shouldConfirm, true)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)

  ctx = createContext()
  ctx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    }
  }
  result = await routePlayerCommand('随便处理一下那边', {
    ...ctx,
    llmClassifier: async () => ({
      actionKey: ACTION_KEYS.STORE_ITEMS,
      confidence: 0.86,
      params: { mode: 'nonEssential' }
    })
  })
  assert.strictEqual(result.whetherExecuted, true)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'storage')
}

async function testTaskManagerStatusAndGoal() {
  let ctx = createContext()
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    debug: false,
    enableTaskFeedback: false
  })
  manager.enqueue('storage', { mode: 'STORE_ITEMS', itemName: 'cobblestone', count: 1 }, 5, 'test')
  await manager.tick(ctx)
  const status = manager.status()
  assert.strictEqual(status.currentStorageTask?.mode || status.recentCompleted?.at(-1)?.mode, 'STORE_ITEMS')
  assert.ok(status.knownChestCount >= 1)
}

async function run() {
  await testRememberChestAndDedupe()
  await testFindBestChestAndMissingChest()
  await testTransientChestOpenFailureRetainsLiveCandidate()
  await testStoreAndTakeItemsCallActions()
  await testTakeItemsPrioritizesBuildStorageAnchor()
  await testStagingInventoryUsesExactScanCenters()
  await testLooseSeedWithdrawCounts()
  await testWoodCategoryDepositFullChain()
  await testWoodCategoryWithdrawUsesLooseCount()
  await testWoodCategoryDepositSkipsStaleMissingItems()
  await testWoodSubcategoryDeposits()
  await testExplicitOakDepositOnlyOakFamily()
  await testFoodWithdrawPriorityAndGuards()
  await testCategoryArmorWithdrawAndEquip()
  await testAllSteakAliasWithdraw()
  await testAllPorkchopAliasWithdraw()
  await testFoodAliasCoverage()
  await testStorageItemNameResolutionGuards()
  await testWithdrawAllAcrossStacks()
  await testMissingSpecificItemDoesNotSucceed()
  await testWithdrawUsesAnchorScanCentersWhenBotIsFarFromChest()
  await testWithdrawCanIgnoreStaleMemoryForBuildStorage()
  await testEnsureStagingMaterialsMovesInventoryIntoExactStagingChest()
  await testEnsureStagingMaterialsVerifiesOnceAfterBatchMove()
  await testEnsureStagingMaterialsUsesNextStagingChestWhenFirstIsFull()
  await testEnsureStagingMaterialsPrefersSuccessfulChestForBatch()
  await testEnsureStagingMaterialsMovesSourceChestIntoExactStagingChest()
  await testEnsureStagingMaterialsCraftsMissingMaterialIntoStaging()
  await testEnsureStagingMaterialsDepositsPartialCraftBeforeShortage()
  await testMissingItemsAndDanger()
  await testTakeItemsStopsBeforeChestWhenInterrupted()
  await testPauseResumeInterrupt()
  await testStorageIntentThreeLayers()
  await testRouterSafetyAndLlmPath()
  await testTaskManagerStatusAndGoal()
  console.log('storage-system tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
