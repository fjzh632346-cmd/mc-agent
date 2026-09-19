const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { CraftTask } = require('../tasks/craft-task')
const { EatTask } = require('../tasks/eat-task')
const { FollowTask } = require('../tasks/follow-task')
const { GuardPlayerTask } = require('../tasks/guard-player-task')
const { MiningTask } = require('../tasks/mining-task')
const { ReturnToBaseTask } = require('../tasks/return-to-base-task')
const { ReturnToPlayerTask } = require('../tasks/return-to-player-task')
const { SleepTask } = require('../tasks/sleep-task')
const { SmeltTask } = require('../tasks/smelt-task')
const { TaskManager } = require('../tasks/task-manager')
const { createRecoveryState, updateStuckTracking } = require('../tasks/stuck-recovery')

function vec(x, y, z) {
  return { x, y, z }
}

function createContext(items = [], options = {}) {
  const controls = []
  const chats = []
  const pathfinder = createPathfinder(options)
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    username: 'Bot',
    players: options.players || {
      Alex: {
        username: 'Alex',
        entity: { position: options.playerPosition || { x: 8, y: 64, z: 0 } }
      }
    },
    registry: {
      itemsByName: {
        stick: { id: 1, name: 'stick' },
        torch: { id: 2, name: 'torch' },
        stone_pickaxe: { id: 3, name: 'stone_pickaxe' },
        iron_pickaxe: { id: 4, name: 'iron_pickaxe' },
        coal: { id: 5, name: 'coal' },
        oak_log: { id: 6, name: 'oak_log' },
        oak_planks: { id: 7, name: 'oak_planks' },
        chest: { id: 8, name: 'chest' },
        crafting_table: { id: 9, name: 'crafting_table' }
      },
      itemsById: {
        1: { id: 1, name: 'stick' },
        2: { id: 2, name: 'torch' },
        3: { id: 3, name: 'stone_pickaxe' },
        4: { id: 4, name: 'iron_pickaxe' },
        5: { id: 5, name: 'coal' },
        6: { id: 6, name: 'oak_log' },
        7: { id: 7, name: 'oak_planks' },
        8: { id: 8, name: 'chest' },
        9: { id: 9, name: 'crafting_table' }
      },
      itemsArray: [
        { id: 1, name: 'stick' },
        { id: 2, name: 'torch' },
        { id: 3, name: 'stone_pickaxe' },
        { id: 4, name: 'iron_pickaxe' },
        { id: 5, name: 'coal' },
        { id: 6, name: 'oak_log' },
        { id: 7, name: 'oak_planks' },
        { id: 8, name: 'chest' },
        { id: 9, name: 'crafting_table' }
      ],
      blocksByName: {
        furnace: { id: 10 },
        crafting_table: { id: 9, name: 'crafting_table' },
        white_bed: { id: 26, name: 'white_bed' },
        red_bed: { id: 27, name: 'red_bed' }
      }
    },
    inventory: {
      items: () => items,
      slots: Array.from({ length: 45 }, () => null)
    },
    pathfinder,
    once(event, callback) {
      return pathfinder.once(event, callback)
    },
    removeListener(event, callback) {
      return pathfinder.removeListener(event, callback)
    },
    setControlState(name, value) {
      controls.push({ name, value })
    },
    clearControlStates() {
      controls.push({ clear: true })
    },
    chat(message) {
      chats.push(message)
    },
    recipesFor(itemId) {
      if (itemId === 2) {
        return [
          { requiresTable: false, delta: [{ id: 5, count: 1 }, { id: 1, count: 1 }], result: { id: 2, count: 4 } }
        ]
      }
      if (itemId === 8) {
        return [
          { requiresTable: true, delta: [{ id: 7, count: 8 }], result: { id: 8, count: 1 } }
        ]
      }
      return []
    },
    async craft(recipe, count) {
      this.crafted = { recipe, count }
    },
    async equip(item) {
      this.equipped = item
    },
    async consume() {
      this.consumed = true
    },
    async sleep(block) {
      if (options.sleepThrows) throw new Error(options.sleepThrows)
      this.sleptIn = block
      this.isSleeping = true
    },
    findBlocks(query = {}) {
      if (options.bedPosition && Array.isArray(query.matching) && query.matching.includes(26)) return [options.bedPosition]
      return []
    },
    findBlock(query = {}) {
      if (options.hasCraftingTable && query.matching === 9) {
        return { name: 'crafting_table', position: { x: 1, y: 64, z: 0 } }
      }
      return options.hasFurnace ? { name: 'furnace', position: { x: 1, y: 64, z: 1 } } : null
    },
    blockAt(position) {
      if (typeof options.blockAt === 'function') return options.blockAt(position)
      if (options.bedPosition && position.x === options.bedPosition.x && position.y === options.bedPosition.y && position.z === options.bedPosition.z) {
        return { name: 'white_bed', position }
      }
      if (options.noBlockScan) return null
      if (position.y === 63) return { name: 'dirt', position }
      return { name: 'air', position }
    }
  }
  bot.controls = controls
  bot.chats = chats

  return {
    bot,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard: new Blackboard({
      inventory: {
        counts: Object.fromEntries(items.map(item => [item.name, item.count]))
      },
      mobs: {
        dangerLevel: options.dangerLevel || 'none',
        hostileMobs: options.hostileMobs || [],
        nearestHostileMob: options.nearestHostileMob || null
      },
      world: { isDay: options.isDay ?? true }
    }),
    memory: options.memory || null,
    debug() {}
  }
}

function simulateBlockDrop(bot, block) {
  const dropName = { oak_log: 'oak_log' }[block?.name] || block?.name
  if (!dropName) return
  const item = bot.registry.itemsByName[dropName] || { id: 999, name: dropName }
  const id = 1000 + Object.keys(bot.entities || {}).length
  bot.entity.position = block.position
  bot.entities[id] = {
    id,
    name: 'item',
    type: 'object',
    displayName: 'Item',
    metadata: { itemId: item.id },
    position: block.position
  }
  const existing = bot.inventory.items().find(candidate => candidate.name === dropName)
  if (existing) existing.count += 1
  else bot.inventory.items().push({ name: dropName, count: 1 })
}

function createPathfinder(options = {}) {
  let goalCount = 0
  return {
    goal: null,
    setMovements() {},
    setGoal(goal) {
      this.goal = goal
      goalCount += goal ? 1 : 0
    },
    stop() {},
    get goalCount() {
      return goalCount
    },
    once(event, callback) {
      if (options.pathAlwaysTimeout) return
      if (options.pathTimeoutOnce && goalCount <= 1) return
      callback()
    },
    removeListener() {}
  }
}

async function runTask(task, context) {
  if (task.state === 'IDLE' && typeof task.start === 'function') await task.start(context)
  await task.update(context)
  return task
}

async function testCraftMissingMaterials() {
  const task = new CraftTask({ id: 1, params: { itemName: 'torch', count: 4 } })
  await runTask(task, createContext([{ name: 'coal', count: 1 }]))
  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.error.includes('missing_materials'))
  assert.ok(task.error.includes('oak_log'))
  assert.strictEqual(task.error.includes('oak_planks'), false)
}

async function testCraftQueuesStorageForMissingMaterials() {
  const ctx = createContext([{ name: 'coal', count: 1 }])
  const enqueued = []
  ctx.taskManager = {
    enqueue(type, params, priority) {
      enqueued.push({ type, params, priority })
    }
  }

  const task = new CraftTask({ id: 101, params: { itemName: 'torch', count: 4 } })
  await runTask(task, ctx)

  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.error.includes('storage_fetch_needed'))
  assert.ok(task.error.includes('oak_log'))
  assert.ok(enqueued.some(entry =>
    entry.type === 'storage' &&
    entry.params.mode === 'TAKE_ITEMS' &&
    entry.params.itemName === 'oak_log' &&
    entry.params.count > 0))
  assert.ok(enqueued.some(entry =>
    entry.type === 'craft_item' &&
    entry.params.itemName === 'torch' &&
    entry.params.storageFetched === true))
}

async function testCraftCallsAction() {
  const ctx = createContext([{ name: 'coal', count: 1 }, { name: 'stick', count: 1 }])
  const task = new CraftTask({ id: 2, params: { itemName: 'torch', count: 4 } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED', `${task.error} ${JSON.stringify(task.recovery)}`)
  assert.strictEqual(ctx.bot.crafted.count, 1)
}

async function testCraftUsesCraftingTableRecipe() {
  const ctx = createContext([{ name: 'oak_planks', count: 8 }], { hasCraftingTable: true })
  const task = new CraftTask({ id: 22, params: { itemName: 'chest', count: 1 } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED', `${task.error} ${JSON.stringify(task.plan)}`)
  assert.strictEqual(ctx.bot.crafted.recipe.requiresTable, true)
  assert.strictEqual(task.result.targetItem, 'chest')
}

async function testEatChoosesSafeFood() {
  const ctx = createContext([
    { name: 'rotten_flesh', count: 1 },
    { name: 'bread', count: 1 },
    { name: 'cooked_beef', count: 1 }
  ])
  const task = new EatTask({ id: 3, params: {} })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED')
  assert.strictEqual(ctx.bot.equipped.name, 'cooked_beef')
  assert.strictEqual(ctx.bot.consumed, true)
}

async function testEatFallsBackToStorageFood() {
  const items = []
  const ctx = createContext(items)
  ctx.storageSystem = {
    async takeItems() {
      items.push({ name: 'bread', count: 1 })
      return { ok: true, withdrawnItems: [{ itemName: 'bread', count: 1 }] }
    }
  }
  const task = new EatTask({ id: 31, params: { input: '吃东西' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED', task.error)
  assert.strictEqual(ctx.bot.equipped.name, 'bread')
  assert.strictEqual(task.foodState.checkedStorage, true)
}

async function testEatNoFoodAvailableDoesNotMentionFarm() {
  const ctx = createContext([])
  ctx.storageSystem = {
    async takeItems() {
      return { ok: false, error: 'chest_item_not_found:food' }
    }
  }
  const task = new EatTask({ id: 32, params: { input: '吃点食物' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'no_food_available')
  assert.strictEqual(String(task.error).includes('farm'), false)
  assert.strictEqual(String(task.error).includes('农场'), false)
}

async function testReturnToBaseMissingBase() {
  const task = new ReturnToBaseTask({ id: 4, params: {} })
  await runTask(task, createContext([]))
  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.error.includes('base_location_missing'))
}

async function testReturnToBaseMoves() {
  const ctx = createContext([], {
    memory: {
      world: {
        baseLocation: { position: { x: 10, y: 64, z: 10 } }
      }
    }
  })
  const task = new ReturnToBaseTask({ id: 5, params: {} })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED')
  assert.ok(ctx.bot.pathfinder.goal)
}

async function testReturnToPlayerPathFailureUsesRecovery() {
  const ctx = createContext([], {
    pathTimeoutOnce: true,
    playerPosition: { x: 8, y: 64, z: 0 }
  })
  const task = new ReturnToPlayerTask({
    id: 7,
    params: { username: 'Alex', timeoutMs: 1, recoveryTimeoutMs: 20, jumpMs: 1 }
  })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'COMPLETED', `${task.error} ${JSON.stringify(task.recovery)}`)
  assert.strictEqual(task.recovery.recoveryAttempts, 0)
  assert.strictEqual(task.recovery.pathStatus, 'arrived')
}

// Round 10 (repair lane): "停止任务" landing while the walk home is in flight
// must end the task right there. Before: the failed move was treated as a
// path failure, the escape ladder ran (ESCAPE_RUNG / ESCAPE_PILLAR), she
// walked again (RETURN_PATH_RETRY) and the INTERRUPTED state was overwritten
// with FAILED on move_timeout (building lane round 14, task #1).
async function interruptMidWalk(task, ctx) {
  const lines = []
  ctx.logger = { log: line => lines.push(String(line)) }
  await task.start(ctx)
  const running = task.update(ctx)
  await new Promise(resolve => setTimeout(resolve, 10))
  await task.interrupt(ctx, 'player_stop')
  await running
  return lines
}

function assertChainStopped(task, ctx, lines) {
  assert.strictEqual(task.state, 'INTERRUPTED', `state=${task.state} error=${task.error}`)
  assert.strictEqual(ctx.bot.pathfinder.goalCount, 1, 'no second walk after the interrupt')
  assert.strictEqual(task.recovery.recoveryAttempts || 0, 0, 'escape ladder not climbed')
  for (const tag of ['[RETURN_PATH_RETRY]', '[STUCK_DETECTED]', '[ESCAPE_', '[RETURN_FAILED]']) {
    assert.ok(!lines.some(line => line.includes(tag)), `${tag} must not appear after the interrupt: ${lines.join(' | ')}`)
  }
  assert.ok(lines.some(line => line.includes('[RETURN_ABANDONED]')), 'abandonment is logged')
}

async function testReturnToBaseInterruptStopsEscapeChain() {
  const ctx = createContext([], {
    pathAlwaysTimeout: true,
    memory: { world: { baseLocation: { position: { x: 10, y: 64, z: 10 } } } }
  })
  const task = new ReturnToBaseTask({ id: 41, params: { timeoutMs: 60, recoveryTimeoutMs: 20, jumpMs: 1 } })
  const lines = await interruptMidWalk(task, ctx)
  assertChainStopped(task, ctx, lines)
}

async function testReturnToPlayerInterruptStopsEscapeChain() {
  const ctx = createContext([], {
    pathAlwaysTimeout: true,
    playerPosition: { x: 8, y: 64, z: 0 }
  })
  const task = new ReturnToPlayerTask({ id: 42, params: { username: 'Alex', timeoutMs: 60, recoveryTimeoutMs: 20, jumpMs: 1 } })
  const lines = await interruptMidWalk(task, ctx)
  assertChainStopped(task, ctx, lines)
}

async function testNoProgressTriggersStuckDetection() {
  const ctx = createContext([], {
    playerPosition: { x: 12, y: 64, z: 0 }
  })
  ctx.bot.pathfinder.goal = { active: true }
  const state = createRecoveryState()
  updateStuckTracking(ctx, state, { x: 12, y: 64, z: 0 }, { stuckTickThreshold: 2 })
  updateStuckTracking(ctx, state, { x: 12, y: 64, z: 0 }, { stuckTickThreshold: 2 })
  updateStuckTracking(ctx, state, { x: 12, y: 64, z: 0 }, { stuckTickThreshold: 2 })
  assert.strictEqual(state.isStuck, true)
  assert.strictEqual(state.stuckReason, 'no_movement_or_no_distance_progress')
}

async function testReturnRecoveryFailureReportsClearly() {
  const ctx = createContext([], {
    pathAlwaysTimeout: true,
    playerPosition: { x: 8, y: 64, z: 0 }
  })
  const task = new ReturnToPlayerTask({
    id: 8,
    params: { username: 'Alex', timeoutMs: 1, recoveryTimeoutMs: 1, jumpMs: 1 }
  })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.recovery.recoveryAttempts >= 1)
  assert.ok(task.recovery.lastFailureReason)
  assert.ok(ctx.bot.chats.some(message => message.includes('困') || message.includes('出口')))
}

async function testFollowTaskRecoversFromHoleAndContinues() {
  const ctx = createContext([], {
    playerPosition: { x: 8, y: 64, z: 0 }
  })
  ctx.bot.entity.position = { x: 0, y: 60, z: 0 }
  const task = new FollowTask({
    id: 9,
    params: { username: 'Alex', stuckTickThreshold: 1, recoveryTimeoutMs: 20, jumpMs: 1 }
  })
  await task.start(ctx)
  await task.update(ctx)
  assert.strictEqual(task.state, 'RUNNING')
  assert.ok(task.recovery.recoveryAttempts >= 1)
  assert.strictEqual(task.followStarted, false)
}

async function testTaskStatusIncludesRecoveryFields() {
  const ctx = createContext([{ name: 'bread', count: 3 }, { name: 'stone_pickaxe', count: 1 }], {
    playerPosition: { x: 10, y: 64, z: 0 }
  })
  const manager = new TaskManager(ctx.bot, {
    enabled: false,
    debug: false,
    blackboard: {
      snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' }, inventory: {}, world: {}, tasks: {} }),
      get: () => null
    }
  })
  const task = new FollowTask({ id: 10, params: { username: 'Alex' } })
  task.recovery.isStuck = true
  task.recovery.isInHole = true
  task.recovery.stuckReason = 'in_hole_or_low_ground'
  task.recovery.recoveryAttempts = 2
  task.recovery.lastRecoveryAction = 'scan_nearby_exit'
  task.recovery.lastFailureReason = 'move_timeout'
  task.recovery.pathStatus = 'recovering'
  task.recovery.targetPlayer = 'Alex'
  task.recovery.distanceToPlayer = 9
  manager.currentTask = task

  const status = manager.status()
  assert.strictEqual(status.currentTask.type, 'follow_player')
  assert.strictEqual(status.targetPlayer, 'Alex')
  assert.strictEqual(status.distanceToPlayer, 9)
  assert.strictEqual(status.pathStatus, 'recovering')
  assert.strictEqual(status.isStuck, true)
  assert.strictEqual(status.isInHole, true)
  assert.strictEqual(status.stuckReason, 'in_hole_or_low_ground')
  assert.strictEqual(status.recoveryAttempts, 2)
  assert.strictEqual(status.lastRecoveryAction, 'scan_nearby_exit')
  assert.strictEqual(status.lastFailureReason, 'move_timeout')
  assert.strictEqual(status.inventoryState.items.find(item => item.name === 'bread').count, 3)
  assert.strictEqual(status.inventoryState.food.find(item => item.name === 'bread').count, 3)
  assert.strictEqual(status.inventoryState.tools.find(item => item.name === 'stone_pickaxe').count, 1)
}

async function testTaskStatusDoesNotTreatHistoryAsActiveFollow() {
  const ctx = createContext([], {
    playerPosition: { x: 10, y: 64, z: 0 }
  })
  const manager = new TaskManager(ctx.bot, {
    enabled: false,
    debug: false,
    blackboard: {
      snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' }, inventory: {}, world: {}, tasks: {} }),
      get: () => null
    }
  })

  manager.completed.push({
    id: 10,
    type: 'follow_player',
    state: 'COMPLETED',
    targetPlayer: 'Alex',
    distanceToPlayer: 1
  })
  manager.interrupted.push({
    id: 11,
    type: 'follow_player',
    state: 'INTERRUPTED',
    targetPlayer: 'Alex',
    distanceToPlayer: 1
  })

  const status = manager.status()
  assert.strictEqual(status.currentTask, null)
  assert.strictEqual(status.currentMovementTask, null)
  assert.strictEqual(status.targetPlayer, null)
  assert.strictEqual(status.distanceToPlayer, null)
}

async function testSmeltNoFurnaceFailsClearly() {
  const task = new SmeltTask({ id: 6, params: { inputName: 'raw_iron', count: 1 } })
  await runTask(task, createContext([{ name: 'raw_iron', count: 1 }, { name: 'coal', count: 1 }]))
  assert.strictEqual(task.state, 'FAILED')
  assert.ok(task.error.includes('furnace_not_found'))
}

async function testMiningTaskWoodcuttingTreeCountCompletesMultipleTrees() {
  const ctx = createContext([])
  ctx.bot.entities = {}
  ctx.bot.registry.blocksByName.oak_log = { id: 17, name: 'oak_log' }
  ctx.bot.dugCount = 0
  const logs = [
    { name: 'oak_log', position: vec(2, 64, 0) },
    { name: 'oak_log', position: vec(2, 65, 0) },
    { name: 'oak_log', position: vec(8, 64, 0) },
    { name: 'oak_log', position: vec(8, 65, 0) }
  ]
  const liveLogs = new Map(logs.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  ctx.bot.findBlocks = () => Array.from(liveLogs.values()).map(block => block.position)
  ctx.bot.blockAt = position => liveLogs.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  ctx.bot.dig = async block => {
    ctx.bot.dugCount += 1
    simulateBlockDrop(ctx.bot, block)
    liveLogs.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }

  const task = new MiningTask({
    id: 90,
    params: {
      blockName: 'oak_log',
      targetBlock: 'oak_log',
      blockNames: ['oak_log'],
      treeMode: 'tree_count',
      targetTreeCount: 2,
      count: 2,
      maxDistance: 24
    }
  })
  await runTask(task, ctx)

  assert.strictEqual(task.state, 'COMPLETED', task.error)
  assert.strictEqual(ctx.bot.dugCount, 4)
  assert.strictEqual(task.miningState.minedCount, 4)
  assert.strictEqual(task.miningState.treeState.completedTreeCount, 2)
  assert.strictEqual(task.miningState.treeState.finishReason, 'target_count_reached')
}

async function testMiningTaskWoodcuttingInsufficientTreesFailsPartial() {
  const ctx = createContext([])
  ctx.bot.entities = {}
  ctx.bot.registry.blocksByName.oak_log = { id: 17, name: 'oak_log' }
  const logs = [
    { name: 'oak_log', position: vec(2, 64, 0) },
    { name: 'oak_log', position: vec(2, 65, 0) }
  ]
  const liveLogs = new Map(logs.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  ctx.bot.findBlocks = () => Array.from(liveLogs.values()).map(block => block.position)
  ctx.bot.blockAt = position => liveLogs.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  ctx.bot.dig = async block => {
    simulateBlockDrop(ctx.bot, block)
    liveLogs.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }

  const task = new MiningTask({
    id: 91,
    params: {
      blockName: 'oak_log',
      targetBlock: 'oak_log',
      blockNames: ['oak_log'],
      treeMode: 'tree_count',
      targetTreeCount: 2,
      count: 2,
      maxDistance: 24
    }
  })
  await runTask(task, ctx)

  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'partial_completed_no_more_trees')
  assert.strictEqual(task.miningState.minedCount, 2)
  assert.strictEqual(task.miningState.treeState.completedTreeCount, 1)
  assert.strictEqual(task.miningState.treeState.targetTreeCount, 2)
  assert.strictEqual(task.miningState.treeState.finishReason, 'partial_completed_no_more_trees')
}

async function testGuardCompletesAfterHostileClears() {
  const ctx = createContext([{ name: 'iron_sword', count: 1 }])
  const calls = []
  const zombie = { id: 70, name: 'zombie', type: 'mob', position: { x: 2, y: 64, z: 0 } }
  ctx.bot.entities = { 70: zombie }
  ctx.bot.pvp = {
    attacked: null,
    stopped: false,
    attack(entity) {
      calls.push('attack')
      this.attacked = entity
    },
    stop() {
      this.stopped = true
      this.attacked = null
    }
  }
  ctx.autoPreparationSystem = {
    async ensureCombatWeapon() {
      calls.push('auto-prep')
      ctx.bot.equipped = { name: 'iron_sword' }
      return { ok: true, itemName: 'iron_sword', reason: 'equipped' }
    }
  }
  ctx.blackboard.set('mobs.hostileMobs', [{ id: 70, name: 'zombie', distance: 2, position: zombie.position }])
  ctx.blackboard.set('player.ownerPosition', { x: 0, y: 64, z: 0 })

  const task = new GuardPlayerTask({ id: 70, params: { durationMs: 15000, radius: 8 } })
  await task.start(ctx)
  await task.update(ctx)
  assert.strictEqual(ctx.bot.pvp.attacked, zombie)
  assert.deepStrictEqual(calls.slice(0, 2), ['auto-prep', 'attack'])
  assert.strictEqual(ctx.bot.equipped.name, 'iron_sword')

  ctx.bot.entities = {}
  ctx.blackboard.set('mobs.hostileMobs', [])
  await task.update(ctx)
  await task.update(ctx)
  assert.strictEqual(task.state, 'COMPLETED')
  assert.strictEqual(task.result.finishReason, 'no_hostile_remaining')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('combat'), null)
}

async function testGuardUsesBareHandFallbackWithoutWeapon() {
  const ctx = createContext([])
  const zombie = { id: 71, name: 'zombie', type: 'mob', position: { x: 2, y: 64, z: 0 } }
  ctx.bot.entities = { 71: zombie }
  ctx.bot.pvp = {
    attacked: null,
    attack(entity) {
      this.attacked = entity
    },
    stop() {}
  }
  ctx.autoPreparationSystem = {
    async ensureCombatWeapon() {
      return { ok: true, itemName: 'hand', reason: 'bare_hand_fallback', fallback: 'bare_hand', fallbackUsed: true }
    }
  }
  ctx.blackboard.set('mobs.hostileMobs', [{ id: 71, name: 'zombie', distance: 2, position: zombie.position }])
  ctx.blackboard.set('player.ownerPosition', { x: 0, y: 64, z: 0 })

  const task = new GuardPlayerTask({ id: 71, params: { durationMs: 15000, radius: 8 } })
  await task.start(ctx)
  await task.update(ctx)
  assert.strictEqual(ctx.bot.pvp.attacked, zombie)
  assert.strictEqual(task.state, 'RUNNING')
  assert.notStrictEqual(task.error, 'missing_tool')
  assert.notStrictEqual(task.error, 'wrong_tool_type')
  assert.notStrictEqual(task.error, 'missing_weapon')
}

async function testSleepTaskSleepsAtNightWithNearbyBed() {
  const ctx = createContext([], { isDay: false, bedPosition: { x: 2, y: 64, z: 0 } })
  const task = new SleepTask({ id: 80, params: { input: '去睡觉' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'RUNNING', task.error)
  assert.strictEqual(ctx.bot.sleptIn.name, 'white_bed')
  assert.strictEqual(task.sleepState.sleepPhase, 'waiting_for_others')
  assert.strictEqual(task.sleepState.sleepReason, 'sleep_waiting_for_others')
  assert.strictEqual(task.sleepState.nearestBedPosition.x, 2)
  assert.strictEqual(task.sleepState.lastSleepError, null)
  assert.ok(ctx.bot.chats.some(message => message.includes('躺好') || message.includes('来睡')))
}

async function testSleepTaskFailsDuringDay() {
  const ctx = createContext([], { isDay: true, bedPosition: { x: 2, y: 64, z: 0 } })
  const task = new SleepTask({ id: 81, params: { input: '去睡觉' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'sleep_failed_not_night')
  assert.strictEqual(ctx.bot.sleptIn, undefined)
}

async function testSleepTaskFailsWithoutBed() {
  const ctx = createContext([], { isDay: false })
  const task = new SleepTask({ id: 82, params: { input: '找床睡觉' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'sleep_failed_no_bed_found')
}

async function testSleepTaskFailsWhenBedUnreachable() {
  const ctx = createContext([], {
    isDay: false,
    bedPosition: { x: 6, y: 64, z: 0 },
    pathAlwaysTimeout: true
  })
  const task = new SleepTask({ id: 83, params: { input: '上床睡觉', timeoutMs: 10 } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'sleep_failed_bed_unreachable')
}

async function testSleepTaskFailsWithNearbyMonster() {
  const ctx = createContext([], {
    isDay: false,
    bedPosition: { x: 2, y: 64, z: 0 },
    hostileMobs: [{ id: 1, name: 'zombie', distance: 4, position: { x: 4, y: 64, z: 0 } }]
  })
  const task = new SleepTask({ id: 84, params: { input: '晚上了先睡觉' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'sleep_failed_monsters_nearby')
  assert.strictEqual(ctx.bot.sleptIn, undefined)
}

async function testSleepWaitingFeedbackCooldownAndProgression() {
  const ctx = createContext([], { isDay: false, bedPosition: { x: 2, y: 64, z: 0 } })
  const task = new SleepTask({ id: 85, params: { input: '鍘荤潯瑙?', sleepFeedbackCooldownMs: 30000 } })
  await runTask(task, ctx)
  assert.strictEqual(task.sleepState.sleepPhase, 'waiting_for_others')
  assert.strictEqual(ctx.bot.chats.length, 1)

  await task.update(ctx)
  assert.strictEqual(ctx.bot.chats.length, 1)

  task.sleepState.waitingSince = Date.now() - 40000
  task.lastFeedbackAt = Date.now() - 31000
  await task.update(ctx)
  assert.strictEqual(ctx.bot.chats.length, 2)
  assert.ok(ctx.bot.chats[1].includes('还在床上等你'))

  task.sleepState.waitingSince = Date.now() - 95000
  task.lastFeedbackAt = Date.now() - 31000
  await task.update(ctx)
  assert.strictEqual(ctx.bot.chats.length, 3)
  assert.ok(ctx.bot.chats[2].includes('不急'))
}

async function testSleepAlreadySleepingExceptionIsWaitingNotFailure() {
  const ctx = createContext([], {
    isDay: false,
    bedPosition: { x: 2, y: 64, z: 0 },
    sleepThrows: 'already sleeping'
  })
  const task = new SleepTask({ id: 86, params: { input: '鍘荤潯瑙?' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'RUNNING')
  assert.strictEqual(task.sleepState.sleepPhase, 'waiting_for_others')
  assert.strictEqual(task.sleepState.lastSleepError, null)
  assert.strictEqual(task.error, null)
}

async function testSleepThrowsClassifiedErrors() {
  let ctx = createContext([], {
    isDay: false,
    bedPosition: { x: 2, y: 64, z: 0 },
    sleepThrows: 'You may not rest now, there are monsters nearby'
  })
  let task = new SleepTask({ id: 87, params: { input: '鍘荤潯瑙?' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'sleep_failed_monsters_nearby')

  ctx = createContext([], {
    isDay: false,
    bedPosition: { x: 2, y: 64, z: 0 },
    sleepThrows: 'not night'
  })
  task = new SleepTask({ id: 88, params: { input: '鍘荤潯瑙?' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'sleep_failed_not_night')
}

async function testSleepCompletesWhenMorningArrives() {
  const ctx = createContext([], { isDay: false, bedPosition: { x: 2, y: 64, z: 0 } })
  const task = new SleepTask({ id: 89, params: { input: '鍘荤潯瑙?' } })
  await runTask(task, ctx)
  assert.strictEqual(task.state, 'RUNNING')
  ctx.blackboard.set('world.isDay', true)
  ctx.bot.isSleeping = false
  await task.update(ctx)
  assert.strictEqual(task.state, 'COMPLETED', task.error)
  assert.strictEqual(task.sleepState.sleepPhase, 'woke_up')
  assert.ok(ctx.bot.chats.some(message => message.includes('天亮')))
}

async function run() {
  await testCraftMissingMaterials()
  await testCraftQueuesStorageForMissingMaterials()
  await testCraftCallsAction()
  await testCraftUsesCraftingTableRecipe()
  await testEatChoosesSafeFood()
  await testEatFallsBackToStorageFood()
  await testEatNoFoodAvailableDoesNotMentionFarm()
  await testReturnToBaseMissingBase()
  await testReturnToBaseMoves()
  await testReturnToPlayerPathFailureUsesRecovery()
  await testReturnToBaseInterruptStopsEscapeChain()
  await testReturnToPlayerInterruptStopsEscapeChain()
  await testNoProgressTriggersStuckDetection()
  await testReturnRecoveryFailureReportsClearly()
  await testFollowTaskRecoversFromHoleAndContinues()
  await testTaskStatusIncludesRecoveryFields()
  await testTaskStatusDoesNotTreatHistoryAsActiveFollow()
  await testSmeltNoFurnaceFailsClearly()
  await testMiningTaskWoodcuttingTreeCountCompletesMultipleTrees()
  await testMiningTaskWoodcuttingInsufficientTreesFailsPartial()
  await testGuardCompletesAfterHostileClears()
  await testGuardUsesBareHandFallbackWithoutWeapon()
  await testSleepTaskSleepsAtNightWithNearbyBed()
  await testSleepTaskFailsDuringDay()
  await testSleepTaskFailsWithoutBed()
  await testSleepTaskFailsWhenBedUnreachable()
  await testSleepTaskFailsWithNearbyMonster()
  await testSleepWaitingFeedbackCooldownAndProgression()
  await testSleepAlreadySleepingExceptionIsWaitingNotFailure()
  await testSleepThrowsClassifiedErrors()
  await testSleepCompletesWhenMorningArrives()
  console.log('execution task tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
