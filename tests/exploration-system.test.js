const assert = require('assert')
const os = require('os')
const path = require('path')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { WorldMemory } = require('../memory/world-memory')
const { ExplorationSystem } = require('../systems/exploration-system')
const { ExplorationTask } = require('../tasks/exploration-task')
const { TaskManager } = require('../tasks/task-manager')
const { parseIntent } = require('../ai/intent-parser')
const { routePlayerCommand } = require('../ai/command-router')
const { ACTION_KEYS } = require('../ai/action-keys')
const { PlanningSystem } = require('../ai/planning-system')

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
  const calls = { goals: [], stopped: 0 }
  const resources = options.resources || [vec(6, 64, 0)]
  const lava = options.lava || []
  const water = options.water || []
  const structures = options.structures || [vec(4, 64, 4)]
  const landmarkBlocks = options.landmarkBlocks || []
  const unsafeAll = Boolean(options.unsafeAll)
  const bot = {
    username: 'Bot',
    food: options.food ?? 20,
    entity: { position: vec(0, 64, 0) },
    registry: {
      blocksByName: {
        coal_ore: { id: 16 },
        lava: { id: 10 },
        water: { id: 9 },
        chest: { id: 54 },
        farmland: { id: 60 },
        sandstone: { id: 1001 },
        smooth_sandstone: { id: 1002 },
        cut_sandstone: { id: 1003 },
        orange_terracotta: { id: 1004 },
        blue_terracotta: { id: 1005 }
      }
    },
    inventory: {
      items: () => options.inventoryItems || [],
      slots: Array.from({ length: 45 }, () => null)
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
      if (lava.some(p => samePos(p, position))) return { name: 'lava', position }
      if (water.some(p => samePos(p, position))) return { name: 'water', position }
      if (resources.some(p => samePos(p, position))) return { name: 'coal_ore', position }
      if (structures.some(p => samePos(p, position))) return { name: 'chest', position }
      const landmark = landmarkBlocks.find(item => samePos(item.position, position))
      if (landmark) return { name: landmark.name, position }
      if (position.y === 63) return { name: unsafeAll ? 'air' : 'grass_block', position }
      return { name: 'air', position }
    },
    findBlocks({ matching }) {
      const ids = Array.isArray(matching) ? matching : [matching]
      const positions = []
      if (ids.includes(16)) positions.push(...resources)
      if (ids.includes(10)) positions.push(...lava)
      if (ids.includes(9)) positions.push(...water)
      if (ids.includes(54) || ids.includes(60)) positions.push(...structures)
      for (const block of landmarkBlocks) {
        const blockId = bot.registry.blocksByName[block.name]?.id
        if (ids.includes(blockId)) positions.push(block.position)
      }
      return positions
    },
    entities: options.hostile
      ? { 1: { id: 1, name: 'zombie', type: 'mob', position: vec(3, 64, 0) } }
      : {},
    players: {
      Alex: { username: 'Alex', entity: { position: vec(2, 64, 0) } }
    }
  }

  const memoryPath = path.join(os.tmpdir(), `mc-exploration-memory-${Date.now()}-${Math.random()}.json`)
  const world = new WorldMemory(memoryPath, { logger: { warn() {} } })
  if (options.hasBase !== false) world.setBaseLocation(vec(0, 64, 0), { source: 'test' })
  const memory = {
    world,
    summary() {
      return {
        world: this.world.summary(),
        task: { total: 0 }
      }
    }
  }

  const taskManager = {
    enqueued: [],
    interrupted: null,
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source }
      this.enqueued.push(task)
      return task
    },
    async interruptCurrent(reason) {
      this.interrupted = reason
      return true
    }
  }

  return {
    bot,
    calls,
    actionLock: new ActionLock(),
    blackboard: new Blackboard({
      bot: { health: 20, food: options.food ?? 20, position: { x: 0, y: 64, z: 0 } },
      mobs: { dangerLevel: options.dangerLevel || 'none' },
      inventory: { emptySlots: options.emptySlots ?? 10, counts: {} },
      world: { isDay: options.isDay ?? true, currentBiome: options.currentBiome || null },
      player: { ownerPosition: { x: 2, y: 64, z: 0 } },
      tasks: { currentTask: options.currentTask || null }
    }),
    memory,
    taskManager,
    logger: { log() {}, error() {}, warn() {} },
    debug() {}
  }
}

async function runTask(task, ctx) {
  await task.start(ctx)
  await task.update(ctx)
  return task
}

async function testCreateAndRadiusLimit() {
  const ctx = createContext({ hasBase: false })
  const task = new ExplorationTask({ id: 1, params: { mode: 'EXPLORE_NEARBY', radius: 64 } })
  assert.strictEqual(task.type, 'exploration')

  const system = new ExplorationSystem()
  const state = system.inspectExplorationState(ctx, { radius: 64 })
  assert.strictEqual(state.canExplore, true)
  assert.strictEqual(state.radius, 32)
}

async function testSafetyStops() {
  let ctx = createContext({ dangerLevel: 'high' })
  let task = new ExplorationTask({ id: 2, params: { mode: 'EXPLORE_NEARBY' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'danger_too_high')

  ctx = createContext({ food: 6 })
  task = new ExplorationTask({ id: 3, params: { mode: 'EXPLORE_NEARBY' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'food_low')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'farming')

  ctx = createContext({ emptySlots: 0 })
  task = new ExplorationTask({ id: 4, params: { mode: 'EXPLORE_NEARBY' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'inventory_full')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'storage')
}

async function testTargetsAndRecording() {
  let ctx = createContext()
  let system = new ExplorationSystem()
  let target = system.findNextExploreTarget(ctx, { radius: 16 })
  assert.strictEqual(target.ok, true)
  assert.ok(target.target)

  ctx = createContext({ unsafeAll: true })
  system = new ExplorationSystem()
  target = system.findNextExploreTarget(ctx, { radius: 16 })
  assert.strictEqual(target.ok, false)
  assert.strictEqual(target.error, 'safe_explore_point_not_found')

  ctx = createContext({ lava: [vec(5, 64, 0)] })
  system = new ExplorationSystem()
  const scan = system.scanAndRecord(ctx, { scanRadius: 16 })
  assert.strictEqual(scan.ok, true)
  assert.ok(ctx.memory.world.summary().importantPlaces >= 1)
  assert.ok(ctx.memory.world.summary().discoveredPlaces >= 1)
  assert.ok(ctx.memory.world.summary().dangerZones >= 1)
  assert.ok(ctx.memory.world.summary().mineLocations >= 1)

  system.recordExploredArea(ctx, vec(0, 64, 0), 16, { discoveredPlaces: [], dangerZones: [] })
  system.recordExploredArea(ctx, vec(2, 64, 2), 16, { discoveredPlaces: [], dangerZones: [] })
  assert.strictEqual(ctx.memory.world.summary().exploredAreas, 1)

  ctx.memory.world.addImportantPlace(vec(6, 64, 0), { type: 'resource_area' })
  ctx.memory.world.addImportantPlace(vec(7, 64, 0), { type: 'resource_area' })
  assert.strictEqual(ctx.memory.world.summary().importantPlaces, 1)
}

async function testRadiusExpandsAfterSuccessfulExploration() {
  const ctx = createContext()
  const system = new ExplorationSystem({
    explorationRadius: 32,
    maxExploreDistance: 80,
    radiusStep: 16
  })

  const first = await system.exploreOnce(ctx, { radius: 48 })
  assert.strictEqual(first.ok, true)
  assert.strictEqual(system.getStatus().currentExploreRadius, 48)

  const second = await system.exploreOnce(ctx, { radius: 64 })
  assert.strictEqual(second.ok, true)
  assert.strictEqual(system.getStatus().currentExploreRadius, 64)
}

async function testFailuresShrinkExploreRadius() {
  const ctx = createContext({ unsafeAll: true })
  const system = new ExplorationSystem({
    explorationRadius: 48,
    minExploreDistance: 24,
    radiusStep: 16,
    maxFailedTargetsBeforeShrink: 1
  })

  const target = system.findNextExploreTarget(ctx, { radius: 48 })
  assert.strictEqual(target.ok, false)
  assert.strictEqual(system.getStatus().currentExploreRadius, 32)
  assert.strictEqual(system.getStatus().lastFailureReason, 'safe_explore_point_not_found')
}

async function testVisitedTargetsAvoidImmediateRepeat() {
  const ctx = createContext()
  const system = new ExplorationSystem({
    explorationRadius: 48,
    directionSectors: 8,
    targetCooldownMs: 60 * 1000
  })

  const first = system.findNextExploreTarget(ctx, { radius: 48 })
  assert.strictEqual(first.ok, true)
  system.status.visitedTargets = [{
    position: first.target,
    visitedAtMs: Date.now(),
    visitedAt: new Date().toISOString()
  }]
  const second = system.findNextExploreTarget(ctx, { radius: 48 })
  assert.strictEqual(second.ok, true)
  assert.ok(!samePos(first.target, second.target))
}

async function testRingSectorsRotateTargets() {
  const ctx = createContext()
  const system = new ExplorationSystem({
    explorationMode: 'ring',
    ringStartRadius: 32,
    ringRadiusStep: 16,
    sectorCount: 8
  })
  const targets = []
  for (let i = 0; i < 4; i += 1) {
    const target = system.findNextExploreTarget(ctx, { explorationMode: 'ring', radius: 64 })
    assert.strictEqual(target.ok, true)
    targets.push({ ...target.target })
    system.noteExploreSuccess(ctx)
  }
  const uniqueDirections = new Set(targets.map(pos => `${Math.sign(pos.x)},${Math.sign(pos.z)}`))
  assert.ok(uniqueDirections.size > 1)
  assert.ok(system.getStatus().ringIndex >= 1)
}

async function testDirectionalExplorationUsesCheckpoints() {
  const ctx = createContext()
  const system = new ExplorationSystem({
    explorationMode: 'directional',
    directionalStepDistance: 16,
    maxDirectionalDistance: 64,
    maxRingRadius: 48
  })
  const result = await system.exploreOnce(ctx, {
    explorationMode: 'directional',
    directionVector: { x: 1, z: 0 },
    directionalStepDistance: 16,
    maxDirectionalDistance: 64,
    radius: 48
  })
  assert.strictEqual(result.ok, true, result.error || JSON.stringify(system.getStatus()))
  assert.strictEqual(result.checkpoints, 4)
  assert.strictEqual(system.getStatus().checkpointIndex, 4)
  assert.ok(system.getStatus().maxDirectionalDistance > system.options.maxRingRadius)
}

async function testDirectionalStopsOnDanger() {
  const ctx = createContext({ dangerLevel: 'high' })
  const system = new ExplorationSystem({ explorationMode: 'directional' })
  const result = await system.exploreOnce(ctx, {
    explorationMode: 'directional',
    directionVector: { x: 1, z: 0 },
    maxDirectionalDistance: 96
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'danger_too_high')
  assert.strictEqual(system.getStatus().checkpointIndex, 0)
}

async function testGeneratedStructureDetectionWritesMemory() {
  const ctx = createContext({
    currentBiome: 'desert',
    resources: [],
    structures: [],
    landmarkBlocks: [
      { name: 'sandstone', position: vec(5, 64, 0) },
      { name: 'smooth_sandstone', position: vec(6, 64, 0) },
      { name: 'orange_terracotta', position: vec(5, 65, 0) }
    ]
  })
  const system = new ExplorationSystem()
  const scan = system.scanAndRecord(ctx, { scanRadius: 12 })
  assert.strictEqual(scan.ok, true)
  assert.ok(scan.discoveredPlaces.some(place => place.type === 'probable_desert_temple'))
  assert.ok(ctx.memory.world.discoveredPlaces().some(place => place.type === 'probable_desert_temple'))
}

async function testDangerDoesNotExpandExploreRadius() {
  const ctx = createContext({ dangerLevel: 'high' })
  const task = new ExplorationTask({
    id: 7,
    params: {
      mode: 'SAFE_EXPLORE',
      explorationRadius: 48,
      radiusStep: 16
    }
  })

  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.currentExploreRadius <= 48)
  assert.notStrictEqual(task.safetyState, 'safe')
}

async function testPauseResumeInterrupt() {
  let ctx = createContext()
  let task = new ExplorationTask({ id: 5, params: { mode: 'EXPLORE_NEARBY' } })
  await task.start(ctx)
  await task.pause(ctx, 'test_pause')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.goals.length, 0)
  await task.resume(ctx)
  await task.update(ctx)
  assert.ok(ctx.calls.goals.length > 0)

  ctx = createContext()
  task = new ExplorationTask({ id: 6, params: { mode: 'EXPLORE_NEARBY' } })
  await task.start(ctx)
  await task.interrupt(ctx, 'test_interrupt')
  await task.update(ctx)
  assert.strictEqual(ctx.calls.goals.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
}

async function testIntentAndRouting() {
  assert.strictEqual(parseIntent('附近探索一下').actionKey, ACTION_KEYS.EXPLORE_NEARBY)
  assert.strictEqual(parseIntent('在附近安全探索一下，不要跑太远').actionKey, ACTION_KEYS.SAFE_EXPLORE)
  assert.strictEqual(parseIntent('附近看看，危险就回来').actionKey, ACTION_KEYS.SAFE_EXPLORE)
  assert.strictEqual(parseIntent('在附近转一圈').actionKey, ACTION_KEYS.EXPLORE_NEARBY)
  assert.strictEqual(parseIntent('找个能挖矿的地方').actionKey, ACTION_KEYS.FIND_PLACE_OR_RESOURCE)
  assert.strictEqual(parseIntent('找找附近有没有山洞').actionKey, ACTION_KEYS.FIND_PLACE_OR_RESOURCE)
  assert.strictEqual(parseIntent('你探索过哪些地方').actionKey, ACTION_KEYS.CHECK_EXPLORED_AREAS)
  assert.strictEqual(parseIntent('你喜欢探索吗？').actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(parseIntent('以后能不能自动跑图？').actionKey, ACTION_KEYS.CHAT)
  const unclear = parseIntent('附近处理一下')
  assert.strictEqual(unclear.actionKey, ACTION_KEYS.EXPLORE_NEARBY)
  assert.strictEqual(unclear.params.needConfirm, true)

  const ctx = createContext()
  const result = await routePlayerCommand('附近处理一下', ctx)
  assert.strictEqual(result.shouldConfirm, true)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
}

async function testTaskManagerStatus() {
  const ctx = createContext()
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    debug: false,
    enableTaskFeedback: false
  })
  manager.enqueue('exploration', { mode: 'CHECK_EXPLORED_AREAS' }, 3, 'test')
  await manager.tick(ctx)
  const status = manager.status()
  assert.ok(status.currentExplorationTask || status.recentCompleted.at(-1).type === 'exploration')
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'knownExploredAreaCount'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'lastExplorationError'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'currentExploreRadius'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'explorationMode'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'centerPosition'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'ringIndex'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'currentSector'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'directionVector'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'checkpointIndex'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'maxDirectionalDistance'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'exploredAreasCount'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'discoveredPlacesCount'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'recentDiscoveredPlaces'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'targetDistance'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'targetPosition'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'failedTargetCount'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'lastFailureReason'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'safetyState'))
}

async function testPlanningCreatesExplorationTask() {
  const ctx = createContext()
  const taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source, state: 'COMPLETED', result: { ok: true } }
      this.enqueued.push(task)
      return task
    },
    status() {
      return {
        currentTask: null,
        queue: [],
        pausedStack: [],
        recentCompleted: this.enqueued,
        recentFailed: [],
        recentInterrupted: []
      }
    }
  }
  ctx.taskManager = taskManager
  const planningSystem = new PlanningSystem()
  const created = await planningSystem.createAndSubmitPlan('explore_nearby', ctx)
  assert.strictEqual(created.ok, true)
  await planningSystem.update(ctx)
  assert.strictEqual(taskManager.enqueued[0].type, 'exploration')
  assert.strictEqual(taskManager.enqueued[0].params.mode, 'EXPLORE_NEARBY')
}

async function run() {
  await testCreateAndRadiusLimit()
  await testSafetyStops()
  await testTargetsAndRecording()
  await testRadiusExpandsAfterSuccessfulExploration()
  await testFailuresShrinkExploreRadius()
  await testVisitedTargetsAvoidImmediateRepeat()
  await testRingSectorsRotateTargets()
  await testDirectionalExplorationUsesCheckpoints()
  await testDirectionalStopsOnDanger()
  await testGeneratedStructureDetectionWritesMemory()
  await testDangerDoesNotExpandExploreRadius()
  await testPauseResumeInterrupt()
  await testIntentAndRouting()
  await testTaskManagerStatus()
  await testPlanningCreatesExplorationTask()
  console.log('exploration-system tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
