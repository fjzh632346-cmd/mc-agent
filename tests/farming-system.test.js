const assert = require('assert')
const os = require('os')
const path = require('path')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { WorldMemory } = require('../memory/world-memory')
const { AutoPreparationSystem } = require('../systems/AutoPreparationSystem')
const { DEFAULT_FARM_SCAN_RADIUS, FarmingSystem } = require('../systems/farming-system')
const { FarmingTask } = require('../tasks/farming-task')
const { TaskManager } = require('../tasks/task-manager')
const { GoalSystem, GOAL_TYPES } = require('../ai/goal-system')
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

function samePos(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z
}

function createContext(options = {}) {
  const calls = { digs: [], plants: [], crafts: [], consumes: [] }
  let matureWheat = options.matureWheat === false
    ? []
    : (options.matureWheatPositions || [vec(2, 64, 0)])
  const unripeWheat = options.unripeWheat ? (options.unripeWheatPositions || [vec(3, 64, 0)]) : []
  const farmland = options.noFarm ? [] : (options.farmlandPositions || [vec(2, 63, 0), vec(3, 63, 0), vec(4, 63, 0)])
  const inventoryItems = options.inventoryItems || [
    { name: 'wheat_seeds', count: 5, type: 10 },
    { name: 'wheat', count: 3, type: 11 },
    { name: 'bread', count: 1, type: 12 }
  ]
  const counts = options.counts || Object.fromEntries(inventoryItems.map(item => [item.name, item.count]))
  const bot = {
    entity: { position: vec(0, 64, 0) },
    registry: {
      blocksByName: {
        farmland: { id: 60 },
        wheat: { id: 59 },
        crafting_table: { id: 58 },
        chest: { id: 54 },
        trapped_chest: { id: 146 }
      },
      itemsByName: {
        bread: { id: 200 }
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
      if (!position) return null
      if (matureWheat.some(p => samePos(p, position))) return { name: 'wheat', metadata: 7, position }
      if (unripeWheat.some(p => samePos(p, position))) return { name: 'wheat', metadata: 2, position }
      if (farmland.some(p => samePos(p, position))) return { name: 'farmland', position }
      return { name: 'air', position }
    },
    findBlocks({ matching, maxDistance }) {
      const withinRange = position => !Number.isFinite(maxDistance) || bot.entity.position.distanceTo(position) <= maxDistance
      if (matching === 60) return farmland.filter(withinRange)
      if (matching === 59) return [...matureWheat, ...unripeWheat].filter(withinRange)
      if (Array.isArray(matching) && matching.includes(59)) return [...matureWheat, ...unripeWheat].filter(withinRange)
      return []
    },
    findBlock({ matching }) {
      if (matching === 58 && !options.noCraftingTable) return { name: 'crafting_table', position: vec(1, 64, 0) }
      return null
    },
    async dig(block) {
      calls.digs.push(block.position)
      matureWheat = matureWheat.filter(position => !samePos(position, block.position))
    },
    async equip(item) {
      calls.equipped = item
    },
    async placeBlock(block) {
      calls.plants.push(block.position)
    },
    recipesFor() {
      return [{ result: { id: 200 } }]
    },
    async craft(recipe, count) {
      calls.crafts.push({ recipe, count })
    },
    async consume() {
      calls.consumes.push(true)
    }
  }

  const memoryPath = path.join(os.tmpdir(), `mc-farming-memory-${Date.now()}-${Math.random()}.json`)
  const memory = {
    world: new WorldMemory(memoryPath, { logger: { warn() {} } }),
    summary() {
      return {
        world: this.world.summary(),
        task: { total: 0 }
      }
    }
  }
  if (options.rememberFarm) {
    memory.world.addFarmLocation(vec(2, 63, 0), { radius: 6, tags: ['base', 'food'] })
  }
  if (options.chestLocations) {
    memory.world.addChestLocation(vec(1, 64, 1), { tags: ['storage'] })
  }

  return {
    bot,
    calls,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard: new Blackboard({
      bot: { health: 20, food: options.food ?? 20, position: { x: 0, y: 64, z: 0 } },
      mobs: { dangerLevel: options.dangerLevel || 'none' },
      inventory: {
        counts,
        emptySlots: options.emptySlots ?? 10,
        foodCount: options.foodCount ?? (counts.bread || 0)
      },
      storage: options.storage || {},
      tasks: { currentTask: null },
      world: { isDay: true }
    }),
    memory,
    taskManager: {
      enqueued: [],
      enqueue(type, params, priority, source) {
        const task = { id: this.enqueued.length + 1, type, params, priority, source }
        this.enqueued.push(task)
        return task
      }
    },
    logger: { log() {}, error() {}, warn() {} },
    autoPreparationSystem: new AutoPreparationSystem({ logger: { log() {} } }),
    debug() {}
  }
}

async function runTask(task, ctx) {
  await task.start(ctx)
  await task.update(ctx)
  return task
}

async function testFarmMemory() {
  const ctx = createContext()
  const system = new FarmingSystem()
  let result = system.rememberFarm(ctx, vec(2, 63, 0), { radius: 6 })
  assert.strictEqual(result.ok, true)
  result = system.rememberFarm(ctx, vec(3, 63, 0), { radius: 6 })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.memory.world.summary().farmLocations, 1)

  ctx.memory.world.addFarmLocation(vec(30, 63, 0), { radius: 4 })
  const nearest = ctx.memory.world.nearestFarm(vec(1, 63, 0))
  assert.strictEqual(nearest.position.x, 2)
}

async function testFindFarmErrorsAndInspection() {
  let ctx = createContext({ noFarm: true, matureWheat: false })
  let system = new FarmingSystem({ farmSearchRadius: 4 })
  let result = system.findBestFarm(ctx)
  assert.strictEqual(result.ok, false)
  assert.ok(result.error)

  ctx = createContext({ rememberFarm: true, unripeWheat: true })
  system = new FarmingSystem()
  result = system.inspectFarm(ctx)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.matureWheatCount, 1)
  assert.ok(result.emptyFarmlandCount >= 1)
}

async function testHarvestAndUnripeSafety() {
  let ctx = createContext({ rememberFarm: true })
  let system = new FarmingSystem()
  let result = await system.harvestMatureWheat(ctx, { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.calls.digs.length, 1)

  ctx = createContext({ rememberFarm: true, matureWheat: false, unripeWheat: true })
  system = new FarmingSystem()
  result = await system.harvestMatureWheat(ctx, { owner: 'test' })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(ctx.calls.digs.length, 0)
  assert.strictEqual(result.error, 'no_mature_wheat')
}

async function testDefaultFarmingRangeHandlesCropsOutsideOldRadius() {
  const ctx = createContext({
    matureWheatPositions: [vec(10, 64, 0), vec(11, 64, 0)],
    farmlandPositions: [vec(10, 63, 0), vec(11, 63, 0)]
  })
  const system = new FarmingSystem()
  const result = await system.farmCycle(ctx, { owner: 'test' })
  assert.strictEqual(system.options.farmSearchRadius, DEFAULT_FARM_SCAN_RADIUS)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.calls.digs.length, 2)
  assert.strictEqual(ctx.calls.plants.length, 2)
  assert.deepStrictEqual(ctx.calls.digs.map(position => position.x), [10, 11])

  const rememberedCtx = createContext({
    rememberFarm: true,
    matureWheatPositions: [vec(10, 64, 0), vec(11, 64, 0)],
    farmlandPositions: [vec(10, 63, 0), vec(11, 63, 0)]
  })
  const rememberedSystem = new FarmingSystem()
  const rememberedResult = await rememberedSystem.farmCycle(rememberedCtx, { owner: 'test' })
  assert.strictEqual(rememberedResult.ok, true)
  assert.strictEqual(rememberedCtx.calls.digs.length, 2)
  assert.strictEqual(rememberedCtx.calls.plants.length, 2)
}

async function testPlantingAndMissingSeeds() {
  let ctx = createContext({ rememberFarm: true, matureWheat: false })
  let system = new FarmingSystem({ reserveSeeds: 2 })
  let result = await system.replantWheat(ctx, { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.ok(ctx.calls.plants.length > 0)

  ctx = createContext({
    rememberFarm: true,
    matureWheat: false,
    inventoryItems: [{ name: 'wheat_seeds', count: 1, type: 10 }],
    counts: { wheat_seeds: 1 }
  })
  system = new FarmingSystem({ reserveSeeds: 2 })
  result = await system.replantWheat(ctx, { owner: 'test', tryStorage: false })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'partial_replant_insufficient_seeds')
  assert.strictEqual(ctx.calls.plants.length, 1)
}

async function testFarmingTaskHarvestsMultipleMatureWheat() {
  const ctx = createContext({
    rememberFarm: true,
    matureWheatPositions: [vec(2, 64, 0), vec(3, 64, 0), vec(4, 64, 0)],
    farmlandPositions: [vec(2, 63, 0), vec(3, 63, 0), vec(4, 63, 0)]
  })
  const task = new FarmingTask({ id: 20, params: { mode: 'HARVEST_FARM' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED', task.error)
  assert.strictEqual(ctx.calls.digs.length, 3)
  assert.strictEqual(task.harvestedItems.length, 3)
}

async function testFarmingTaskHarvestThenReplants() {
  const ctx = createContext({
    rememberFarm: true,
    matureWheatPositions: [vec(2, 64, 0), vec(3, 64, 0)],
    farmlandPositions: [vec(2, 63, 0), vec(3, 63, 0), vec(4, 63, 0)]
  })
  const task = new FarmingTask({ id: 21, params: { mode: 'FARM_CYCLE' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED', task.error)
  assert.strictEqual(ctx.calls.digs.length, 2)
  assert.strictEqual(ctx.calls.plants.length, 2)
  assert.strictEqual(task.plantedCount, 2)
}

async function testFarmingTaskMissingSeedsFailsClearly() {
  const ctx = createContext({
    rememberFarm: true,
    matureWheatPositions: [vec(2, 64, 0), vec(3, 64, 0)],
    farmlandPositions: [vec(2, 63, 0), vec(3, 63, 0)],
    inventoryItems: [{ name: 'wheat_seeds', count: 1, type: 10 }],
    counts: { wheat_seeds: 1 }
  })
  const task = new FarmingTask({
    id: 22,
    params: { mode: 'FARM_CYCLE', allowStorageFallback: false }
  })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'missing_seeds')
  assert.strictEqual(ctx.calls.digs.length, 0)
  assert.strictEqual(ctx.calls.plants.length, 0)
  assert.strictEqual(String(task.error).includes('combat'), false)
  assert.strictEqual(String(task.error).includes('mining'), false)
  assert.strictEqual(String(task.error).includes('storage'), false)
}

async function testBreadAndFood() {
  let ctx = createContext({ counts: { wheat: 6 }, inventoryItems: [{ name: 'wheat', count: 6, type: 11 }] })
  let system = new FarmingSystem()
  let result = await system.makeBreadIfPossible(ctx, { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.calls.crafts[0].count, 2)

  ctx = createContext({ counts: { wheat: 2 }, inventoryItems: [{ name: 'wheat', count: 2, type: 11 }] })
  system = new FarmingSystem()
  result = await system.makeBreadIfPossible(ctx, { owner: 'test' })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'not_enough_wheat')
}

async function testGoalLowFood() {
  let ctx = createContext({ food: 6, foodCount: 1, inventoryItems: [{ name: 'bread', count: 1 }] })
  let goalSystem = new GoalSystem({ cooldownMs: 1000 })
  await goalSystem.update(ctx)
  assert.strictEqual(goalSystem.lastTriggeredGoal.type, GOAL_TYPES.LOW_FOOD)
  assert.strictEqual(goalSystem.lastAction.type, 'TASK')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'eat_food')

  ctx = createContext({ food: 3, foodCount: 0, storage: { counts: { bread: 2 } }, chestLocations: 1 })
  ctx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    }
  }
  goalSystem = new GoalSystem({ cooldownMs: 1000 })
  await goalSystem.update(ctx)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'storage')
  assert.strictEqual(ctx.taskManager.enqueued[0].params.itemName, 'bread')
}

async function testTaskLifecycleAndDanger() {
  let ctx = createContext({ rememberFarm: true, dangerLevel: 'high' })
  let task = new FarmingTask({ id: 1, params: { mode: 'FARM_CYCLE' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'danger_too_high')

  ctx = createContext({ rememberFarm: true })
  task = new FarmingTask({ id: 2, params: { mode: 'PLANT_WHEAT' } })
  await task.start(ctx)
  await task.pause(ctx, 'test_pause')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.plants.length, 0)
  await task.resume(ctx)
  await task.update(ctx)
  assert.ok(ctx.calls.plants.length > 0)

  ctx = createContext({ rememberFarm: true })
  task = new FarmingTask({ id: 3, params: { mode: 'PLANT_WHEAT' } })
  await task.start(ctx)
  await task.interrupt(ctx, 'test_interrupt')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.plants.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testFarmingIntentAndRouting() {
  assert.strictEqual(parseIntent('记住这里是农田').actionKey, ACTION_KEYS.REMEMBER_FARM)
  assert.strictEqual(parseIntent('整理一下农田').actionKey, ACTION_KEYS.FARM_CYCLE)
  assert.strictEqual(parseIntent('把小麦收了再补种').actionKey, ACTION_KEYS.FARM_CYCLE)
  const harvestAndReplantCommands = [
    '\u5e2e\u6211\u6536\u4e00\u4e0b\u6210\u719f\u7684\u5c0f\u9ea6\uff0c\u6536\u5b8c\u8865\u79cd',
    '\u6536\u5272\u5e76\u8865\u79cd\u5c0f\u9ea6',
    '\u628a\u80fd\u6536\u7684\u4f5c\u7269\u6536\u4e86\u518d\u79cd\u56de\u53bb',
    '\u6210\u719f\u7684\u5c0f\u9ea6\u5272\u5b8c\u91cd\u65b0\u79cd\u4e0a'
  ]
  for (const command of harvestAndReplantCommands) {
    const parsed = parseIntent(command)
    assert.strictEqual(parsed.actionKey, ACTION_KEYS.FARM_CYCLE, command)
    assert.strictEqual(parsed.params.mode, 'FARM_CYCLE', command)
  }
  assert.strictEqual(parseIntent('\u5e2e\u6211\u6536\u4e00\u4e0b\u6210\u719f\u7684\u5c0f\u9ea6').actionKey, ACTION_KEYS.HARVEST_FARM)
  const countedHarvest = parseIntent('\u5e2e\u6211\u6536\u4e00\u4e0b\u6210\u719f\u7684\u5c0f\u9ea63\u4e2a')
  assert.strictEqual(countedHarvest.actionKey, ACTION_KEYS.HARVEST_FARM)
  assert.strictEqual(countedHarvest.params.count, 3)
  assert.strictEqual(parseIntent('做点面包').actionKey, ACTION_KEYS.MAKE_BREAD)
  assert.strictEqual(parseIntent('你喜欢种田吗？').actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(parseIntent('自动农场难不难做？').actionKey, ACTION_KEYS.CHAT)
  const unclear = parseIntent('农田那边处理一下')
  assert.strictEqual(unclear.actionKey, ACTION_KEYS.FARM_CYCLE)
  assert.strictEqual(unclear.params.needConfirm, true)

  const ctx = createContext()
  ctx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    }
  }
  const result = await routePlayerCommand('农田那边处理一下', ctx)
  assert.strictEqual(result.shouldConfirm, true)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)

  const executionCtx = createContext()
  executionCtx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    }
  }
  const routed = await routePlayerCommand('\u5e2e\u6211\u6536\u4e00\u4e0b\u6210\u719f\u7684\u5c0f\u9ea6\uff0c\u6536\u5b8c\u8865\u79cd', executionCtx)
  assert.strictEqual(routed.actionKey, ACTION_KEYS.FARM_CYCLE)
  assert.strictEqual(routed.whetherExecuted, true)
  assert.strictEqual(executionCtx.taskManager.enqueued[0].type, 'farming')
  assert.strictEqual(executionCtx.taskManager.enqueued[0].params.mode, 'FARM_CYCLE')
}

async function testTaskStatusFarmingFields() {
  const ctx = createContext()
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    debug: false,
    enableTaskFeedback: false
  })
  manager.enqueue('farming', { mode: 'REMEMBER_FARM' }, 5, 'test')
  await manager.tick(ctx)
  const status = manager.status()
  assert.ok(status.currentFarmingTask || status.recentCompleted.at(-1).type === 'farming')
  assert.strictEqual(status.knownFarmCount, 1)
  assert.ok(status.foodSummary)
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'lastFarmingError'))
}

async function run() {
  await testFarmMemory()
  await testFindFarmErrorsAndInspection()
  await testHarvestAndUnripeSafety()
  await testDefaultFarmingRangeHandlesCropsOutsideOldRadius()
  await testPlantingAndMissingSeeds()
  await testFarmingTaskHarvestsMultipleMatureWheat()
  await testFarmingTaskHarvestThenReplants()
  await testFarmingTaskMissingSeedsFailsClearly()
  await testBreadAndFood()
  await testGoalLowFood()
  await testTaskLifecycleAndDanger()
  await testFarmingIntentAndRouting()
  await testTaskStatusFarmingFields()
  console.log('farming-system tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
