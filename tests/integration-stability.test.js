const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { GoalSystem } = require('../ai/goal-system')
const { parseIntent } = require('../ai/intent-parser')
const { ACTION_KEYS } = require('../ai/action-keys')
const { TaskManager } = require('../tasks/task-manager')
const { ExplorationTask } = require('../tasks/exploration-task')
const { FollowTask } = require('../tasks/follow-task')
const { ExplorationSystem } = require('../systems/exploration-system')
const { StorageSystem } = require('../systems/storage-system')
const { FarmingSystem } = require('../systems/farming-system')
const { SurvivalSystem, SURVIVAL_PRIORITIES } = require('../systems/survival-system')

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

function createContext(options = {}) {
  const calls = { goals: [], stopped: 0, reminders: [] }
  const bot = {
    entity: { position: vec(options.x ?? 0, 64, 0) },
    food: options.food ?? 20,
    inventory: {
      items: () => options.inventoryItems || [],
      slots: Array.from({ length: 45 }, () => null)
    },
    registry: {
      blocksByName: {
        chest: { id: 54 },
        trapped_chest: { id: 146 },
        farmland: { id: 60 },
        wheat: { id: 59 },
        coal_ore: { id: 16 },
        lava: { id: 10 },
        water: { id: 9 }
      }
    },
    pathfinder: {
      setMovements() {},
      setGoal(goal) {
        if (goal == null) {
          calls.clearedGoals = (calls.clearedGoals || 0) + 1
          return
        }
        calls.goals.push(goal)
      },
      stop() {
        calls.stopped += 1
      }
    },
    clearControlStates() {
      calls.clearedControls = (calls.clearedControls || 0) + 1
    },
    blockAt(position) {
      if (!position) return null
      if (options.hasGround !== false && position.y === 63) return { name: 'grass_block', position }
      return { name: 'air', position }
    },
    findBlocks() {
      return []
    },
    entities: {}
  }

  const blackboard = new Blackboard({
    bot: {
      health: options.health ?? 20,
      food: options.food ?? 20,
      position: { x: options.x ?? 0, y: 64, z: 0 },
      onGround: options.onGround ?? true
    },
    mobs: {
      dangerLevel: options.dangerLevel || 'none',
      nearestHostileMob: options.hostile || null
    },
    inventory: {
      emptySlots: options.emptySlots ?? 10,
      foodCount: options.foodCount ?? 0,
      counts: options.counts || {}
    },
    storage: options.storage || {},
    world: { isDay: options.isDay ?? true },
    player: { ownerPosition: options.playerPosition || { x: 0, y: 64, z: 0 } },
    tasks: { currentTask: options.currentTask || null }
  })

  const memory = {
    world: {
      baseLocation: options.hasBase ? { position: options.basePosition || { x: 0, y: 64, z: 0 } } : null,
      nearestChest: () => null,
      nearestFarm: () => null,
      baseFarm: () => null,
      list: () => ({ builtStructures: [], exploredAreas: [], importantPlaces: [], dangerZones: [], mineLocations: [] }),
      summary: () => ({
        hasBaseLocation: Boolean(options.hasBase),
        mineLocations: 0,
        dangerZones: 0,
        chestLocations: options.chestLocations || 0,
        farmLocations: options.farmLocations || 0,
        exploredAreas: options.exploredAreas || 0,
        builtStructures: options.builtStructures || 0,
        importantPlaces: options.importantPlaces || 0
      })
    },
    summary() {
      return { world: this.world.summary(), task: { total: 0 } }
    }
  }

  const taskManager = {
    enqueued: [],
    paused: null,
    interrupted: null,
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source }
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
    status() {
      return { currentTask: null, queue: this.enqueued, pausedStack: [], recentCompleted: [], recentFailed: [], recentInterrupted: [] }
    }
  }

  return {
    bot,
    calls,
    actionLock: new ActionLock(),
    blackboard,
    memory,
    taskManager,
    logger: { log() {}, warn() {}, error() {} },
    reminderOutput(text) {
      calls.reminders.push(text)
    },
    debug() {}
  }
}

async function testSurvivalPausesLowPriorityTasks() {
  let ctx = createContext({
    dangerLevel: 'high',
    currentTask: { id: 10, type: 'build_blueprint', state: 'RUNNING', priority: 5 }
  })
  let goalSystem = new GoalSystem({ cooldownMs: 1000 })
  await goalSystem.update(ctx)
  assert.strictEqual(ctx.taskManager.paused, 'survival_danger_nearby')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'guard_player')

  ctx = createContext({
    food: 3,
    foodCount: 1,
    counts: { bread: 1 },
    currentTask: { id: 11, type: 'exploration', state: 'RUNNING', priority: 3 }
  })
  goalSystem = new GoalSystem({ cooldownMs: 1000 })
  await goalSystem.update(ctx)
  assert.strictEqual(ctx.taskManager.paused, 'survival_low_food_critical')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'eat_food')
}

async function testInventoryFullTriggersStorage() {
  for (const taskType of ['farming', 'mining', 'exploration']) {
    const ctx = createContext({
      emptySlots: 0,
      chestLocations: 1,
      currentTask: { id: 20, type: taskType, state: 'RUNNING', priority: 3 }
    })
    const goalSystem = new GoalSystem({ cooldownMs: 1000 })
    await goalSystem.update(ctx)
    assert.strictEqual(ctx.taskManager.paused, 'survival_inventory_full')
    assert.strictEqual(ctx.taskManager.enqueued[0].type, 'storage')
  }
}

async function testCombatDangerCanRetriggerDuringCooldown() {
  const ctx = createContext({
    hostile: { id: 1, name: 'zombie', distance: 4, position: { x: 4, y: 64, z: 0 } }
  })
  const goalSystem = new GoalSystem({ cooldownMs: 60000 })
  await goalSystem.update(ctx)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'guard_player')

  ctx.blackboard.set('mobs.nearestHostileMob', { id: 2, name: 'zombie', distance: 3, position: { x: 3, y: 64, z: 0 } })
  await goalSystem.update(ctx)
  assert.strictEqual(ctx.taskManager.enqueued[1].type, 'guard_player')
}

async function testNightReturnAndPriorityOrdering() {
  let ctx = createContext({
    hasBase: true,
    isDay: false,
    x: 80,
    playerPosition: { x: 80, y: 64, z: 0 }
  })
  let goalSystem = new GoalSystem({ cooldownMs: 1000 })
  await goalSystem.update(ctx)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'return_to_base')

  ctx = createContext({
    health: 4,
    dangerLevel: 'high',
    food: 3,
    emptySlots: 0,
    foodCount: 1,
    currentTask: { id: 30, type: 'exploration', state: 'RUNNING', priority: 3 }
  })
  const survival = new SurvivalSystem()
  const state = survival.evaluateSurvivalState(ctx)
  const decision = survival.createSurvivalPlan(ctx, state)
  await survival.applySurvivalDecision(ctx, decision)
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)
  assert.strictEqual(ctx.taskManager.enqueued.length, 1)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'eat_food')
}

async function testLocksPauseResumeAndInterruptCleanly() {
  const ctx = createContext()
  const task = new ExplorationTask({ id: 40, params: { mode: 'EXPLORE_NEARBY' } })
  await task.start(ctx)
  await task.pause(ctx, 'integration_pause')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.goals.length, 0)
  await task.resume(ctx)
  await task.update(ctx)
  assert.ok(ctx.calls.goals.length > 0)

  const managerCtx = createContext({ counts: { wheat_seeds: 4 } })
  const manager = new TaskManager(managerCtx.bot, {
    actionLock: managerCtx.actionLock,
    blackboard: managerCtx.blackboard,
    memory: managerCtx.memory,
    debug: false,
    enableTaskFeedback: false
  })
  const farming = manager.createTask('farming', { mode: 'PLANT_WHEAT' }, 5, 'test')
  await farming.start(manager.createContext())
  manager.currentTask = farming
  manager.actionLock.acquireMany(['movement', 'inventory'], farming.id)
  await manager.interruptCurrent('integration_interrupt')
  assert.strictEqual(manager.actionLock.getOwner('movement'), null)
  assert.strictEqual(manager.actionLock.getOwner('inventory'), null)
}

async function testFollowFallsBackToNearestPlayer() {
  const ctx = createContext()
  ctx.bot.players = {
    Steve: { username: 'Steve', entity: { position: vec(3, 64, 0) } }
  }
  const task = new FollowTask({ id: 45, params: { username: 'action', durationMs: 1000 } })
  await task.start(ctx)
  await task.update(ctx)
  assert.strictEqual(task.state, 'RUNNING')
  assert.strictEqual(ctx.calls.goals.length, 1)
}

async function testMissingResourcesAndRadiusLimits() {
  let ctx = createContext({ hasBase: false })
  let exploration = new ExplorationSystem()
  assert.strictEqual(exploration.resolveRadius(ctx, { radius: 64 }), 32)

  ctx = createContext()
  const storage = new StorageSystem()
  assert.strictEqual(storage.findBestChest(ctx).error, 'chest_not_found')

  const farming = new FarmingSystem()
  assert.strictEqual(farming.findBestFarm(ctx).error, 'farm_not_found')
}

async function testNaturalLanguageGuardsAndStatusShape() {
  const chatSamples = [
    '你喜欢建房子吗？',
    '箱子系统难不难？',
    '你喜欢种田吗？',
    '以后能不能自动跑图？',
    '安全模式是什么意思？'
  ]
  for (const sample of chatSamples) {
    assert.strictEqual(parseIntent(sample).actionKey, ACTION_KEYS.CHAT)
  }

  const ctx = createContext({ hasBase: true, chestLocations: 1, farmLocations: 1, exploredAreas: 1 })
  const survivalSystem = new SurvivalSystem()
  survivalSystem.evaluateSurvivalState(ctx)
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    survivalSystem,
    debug: false,
    enableTaskFeedback: false
  })
  const status = manager.status()
  for (const key of [
    'currentTask',
    'currentBuildTask',
    'currentStorageTask',
    'currentFarmingTask',
    'currentExplorationTask',
    'survivalStatus',
    'activeLocks',
    'goalStatus',
    'planStatus',
    'memorySummary',
    'lastError'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(status, key), `missing status key: ${key}`)
  }
}

async function run() {
  await testSurvivalPausesLowPriorityTasks()
  await testInventoryFullTriggersStorage()
  await testCombatDangerCanRetriggerDuringCooldown()
  await testNightReturnAndPriorityOrdering()
  await testLocksPauseResumeAndInterruptCleanly()
  await testFollowFallsBackToNearestPlayer()
  await testMissingResourcesAndRadiusLimits()
  await testNaturalLanguageGuardsAndStatusShape()
  console.log('integration-stability tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
