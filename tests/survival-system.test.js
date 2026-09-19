const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { SurvivalSystem, SURVIVAL_PRIORITIES } = require('../systems/survival-system')
const { TaskManager } = require('../tasks/task-manager')
const { ExplorationSystem } = require('../systems/exploration-system')
const { parseIntent } = require('../ai/intent-parser')
const { routePlayerCommand } = require('../ai/command-router')
const { intentToTask } = require('../ai/intent-to-task')
const { PlanningSystem } = require('../ai/planning-system')
const { GoalSystem } = require('../ai/goal-system')
const { ACTION_KEYS } = require('../ai/action-keys')
const {
  claimLegacyEscapeMovement,
  releaseLegacyEscapeMovement
} = require('../utils/legacy-movement-guard')

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

function createContext(state = {}, options = {}) {
  const blackboard = new Blackboard({
    bot: {
      health: options.health ?? 20,
      food: options.food ?? 20,
      position: options.position || { x: 0, y: 64, z: 0 },
      onGround: options.onGround ?? true
    },
    mobs: {
      dangerLevel: options.dangerLevel || 'none',
      nearestHostileMob: options.hostile || null,
      hostileMobs: options.hostile ? [options.hostile] : (options.hostileMobs || []),
      nearbyHostileCount: options.nearbyHostileCount ?? (options.hostile ? 1 : (options.hostileMobs?.length || 0))
    },
    inventory: {
      emptySlots: options.emptySlots ?? 10,
      foodCount: options.foodCount ?? 0,
      counts: options.counts || {}
    },
    world: {
      isDay: options.isDay ?? true,
      weather: null
    },
    player: {
      ownerPosition: options.playerPosition || { x: 0, y: 64, z: 0 }
    },
    tasks: {
      currentTask: options.currentTask || null
    },
    ...state
  })

  const memory = {
    summary() {
      return {
        world: {
          hasBaseLocation: Boolean(options.hasBaseLocation),
          chestLocations: options.chestLocations || 0,
          farmLocations: options.farmLocations || 0
        },
        task: { total: 0 }
      }
    },
    world: {
      baseLocation: options.hasBaseLocation ? { position: options.basePosition || { x: 0, y: 64, z: 0 } } : null
    }
  }

  const bot = {
    entity: { position: vec(options.position?.x ?? 0, options.position?.y ?? 64, options.position?.z ?? 0) },
    health: options.health ?? 20,
    food: options.food ?? 20,
    oxygen: options.oxygen ?? 20,
    registry: {
      blocksByName: {
        white_bed: { id: 26 },
        red_bed: { id: 27 }
      }
    },
    inventory: { items: () => options.inventoryItems || [] },
    pathfinder: { stop() {}, setMovements() {}, setGoal() {} },
    findBlocks(query = {}) {
      if (options.bedPosition && Array.isArray(query.matching) && query.matching.includes(26)) return [options.bedPosition]
      return []
    },
    blockAt(position) {
      if (options.bedPosition && position.x === options.bedPosition.x && position.y === options.bedPosition.y && position.z === options.bedPosition.z) {
        return { name: 'white_bed', position }
      }
      return { name: 'air', position }
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
    async resumePaused(reason) {
      this.resumed = reason
      return true
    }
  }

  return {
    actionLock: new ActionLock(),
    blackboard,
    bot,
    memory,
    taskManager,
    logger: { log() {}, warn() {}, error() {} },
    reminderOutput() {}
  }
}

async function testPrioritySelection() {
  let system = new SurvivalSystem()
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, { health: 4 })).survivalPriority, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, { dangerLevel: 'high' })).survivalPriority, SURVIVAL_PRIORITIES.DANGER_NEARBY)
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, { food: 3 })).survivalPriority, SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL)
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, { emptySlots: 0 })).survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)

  system = new SurvivalSystem()
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, {
    isDay: false,
    hasBaseLocation: true,
    position: { x: 40, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 }
  })).survivalPriority, SURVIVAL_PRIORITIES.NIGHT_UNSAFE)

  system = new SurvivalSystem({ farFromBaseDistance: 32 })
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, {
    hasBaseLocation: true,
    position: { x: 64, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 }
  })).survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)

  system = new SurvivalSystem()
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, {
    health: 4,
    food: 3,
    dangerLevel: 'high',
    emptySlots: 0
  })).survivalPriority, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)

  system = new SurvivalSystem({ hostileInterruptDistance: 6 })
  assert.strictEqual(system.evaluateSurvivalState(createContext({}, {
    dangerLevel: 'none',
    hostile: { id: 9, name: 'zombie', distance: 4, position: { x: 4, y: 64, z: 0 } },
    currentTask: { id: 5, type: 'mining', state: 'RUNNING', priority: 5 }
  })).survivalPriority, SURVIVAL_PRIORITIES.DANGER_NEARBY)
}

async function testInterruptDecisionAndCooldown() {
  const system = new SurvivalSystem({ cooldownMs: 60000 })
  let ctx = createContext({}, {
    dangerLevel: 'high',
    currentTask: { id: 1, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  let state = system.evaluateSurvivalState(ctx)
  let decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(decision.shouldInterrupt, true)
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.paused, 'survival_danger_nearby')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'guard_player')

  const repeat = await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(repeat.type, 'COOLDOWN')

  ctx = createContext({}, { currentTask: { id: 2, type: 'exploration', state: 'RUNNING', priority: 3 }, food: 3, foodCount: 1 })
  state = system.evaluateSurvivalState(ctx)
  decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(decision.shouldInterrupt, true)
}

// 改动 B 的病根：入队时 params 是空的，仲裁读不到"为什么要撤"。
async function testSurvivalEnqueuesCarryReason() {
  let system = new SurvivalSystem({ cooldownMs: 1 })
  let ctx = createContext({}, {
    health: 4,
    foodCount: 1,
    currentTask: { id: 1, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  await system.applySurvivalDecision(ctx, system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx)))
  let enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.type, 'eat_food')
  assert.strictEqual(enqueued.params.reason, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)
  assert.strictEqual(enqueued.params.critical, true)

  // 没吃的 → 撤退，同样要带上理由
  system = new SurvivalSystem({ cooldownMs: 1 })
  ctx = createContext({}, {
    health: 4,
    foodCount: 0,
    hasBaseLocation: true,
    currentTask: { id: 1, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  await system.applySurvivalDecision(ctx, system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx)))
  enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.type, 'return_to_base')
  assert.strictEqual(enqueued.params.reason, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)
  assert.strictEqual(enqueued.params.critical, true)

  // 非紧急撤退带 reason 但不带 critical：升到 HIGH，但不越过盖房那道闸
  system = new SurvivalSystem({ cooldownMs: 1, farFromBaseDistance: 32 })
  ctx = createContext({}, {
    hasBaseLocation: true,
    position: { x: 80, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 },
    currentTask: { id: 1, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  await system.applySurvivalDecision(ctx, system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx)))
  enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.type, 'return_to_base')
  assert.strictEqual(enqueued.params.reason, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
  assert.strictEqual(enqueued.params.critical, undefined)
}

// 改动 C 的第三道闸：战斗中生存系统过去连打断请求都不发。
async function testCombatIsInterruptibleOnlyByLifeSavingPriorities() {
  for (const combatType of ['guard_player', 'fight_nearby_mob']) {
    const system = new SurvivalSystem({ cooldownMs: 1 })
    const ctx = createContext({}, {
      health: 4,
      foodCount: 1,
      currentTask: { id: 1, type: combatType, state: 'RUNNING', priority: 9 }
    })
    const decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
    assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)
    assert.strictEqual(decision.shouldInterrupt, true, `${combatType} 应可被 CRITICAL_HEALTH 打断`)
  }

  // 饿到掉血同理
  let system = new SurvivalSystem({ cooldownMs: 1 })
  let ctx = createContext({}, {
    food: 3,
    foodCount: 1,
    currentTask: { id: 1, type: 'guard_player', state: 'RUNNING', priority: 9 }
  })
  let decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL)
  assert.strictEqual(decision.shouldInterrupt, true)

  // 离家太远不该打断战斗
  system = new SurvivalSystem({ cooldownMs: 1, farFromBaseDistance: 32 })
  ctx = createContext({}, {
    hasBaseLocation: true,
    position: { x: 80, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 },
    currentTask: { id: 1, type: 'guard_player', state: 'RUNNING', priority: 9 }
  })
  decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
  assert.strictEqual(decision.shouldInterrupt, false)

  // DANGER_NEARBY 的处置本身就是战斗，不许它打断战斗（否则原地反复切换）
  system = new SurvivalSystem({ cooldownMs: 1 })
  ctx = createContext({}, {
    dangerLevel: 'high',
    currentTask: { id: 1, type: 'fight_nearby_mob', state: 'RUNNING', priority: 9 }
  })
  decision = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.DANGER_NEARBY)
  assert.strictEqual(decision.shouldInterrupt, false)
}

// 防抖：打断战斗去保命之后，冷却期内不许再打断一次。
async function testCombatInterruptRespectsCooldown() {
  const system = new SurvivalSystem({ cooldownMs: 60000 })
  const ctx = createContext({}, {
    health: 4,
    foodCount: 1,
    currentTask: { id: 1, type: 'guard_player', state: 'RUNNING', priority: 9 }
  })
  const first = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(first.shouldInterrupt, true)
  const applied = await system.applySurvivalDecision(ctx, first)
  assert.strictEqual(applied.type, 'TASK')
  assert.strictEqual(ctx.taskManager.paused, 'survival_critical_health')

  // 同一档的后续决策被 survival_<priority> 冷却挡住，不会二次入队
  const repeat = await system.applySurvivalDecision(ctx, system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx)))
  assert.strictEqual(repeat.type, 'COOLDOWN')
  assert.strictEqual(ctx.taskManager.enqueued.length, 1)

  // interrupt_<priority> 冷却也生效：shouldInterrupt 自己先降下来
  const afterInterrupt = system.createSurvivalPlan(ctx, system.evaluateSurvivalState(ctx))
  assert.strictEqual(afterInterrupt.shouldInterrupt, false)
}

// 安全模式的封锁清单不能被战斗任务污染：safe mode 恰恰是高危时自动打开的，
// 那时候玩家喊"打它"必须还能下得去。
async function testSafeModeStillAllowsCombatTasks() {
  const system = new SurvivalSystem()
  const ctx = createContext({}, { hasBaseLocation: false })
  system.setSafeMode(ctx, true)

  assert.strictEqual(system.shouldBlockNewTask('mining', {}, 'player_command').ok, false)
  assert.strictEqual(system.shouldBlockNewTask('guard_player', {}, 'player_command').ok, true)
  assert.strictEqual(system.shouldBlockNewTask('fight_nearby_mob', {}, 'ai').ok, true)
}

async function testBuildCommandPriorityBeatsReturnSafe() {
  const decision = parseIntent('林夏，在这里建一个简单双层木屋')
  decision.shouldExecute = true
  const ctx = createContext()

  const result = await intentToTask(decision, ctx)

  assert.strictEqual(result.action, 'enqueue_task')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'build_blueprint')
  assert.strictEqual(ctx.taskManager.enqueued[0].priority > 8, true)
  assert.strictEqual(ctx.taskManager.enqueued[0].params.complexityTier, 'L3')
}

async function testPlayerBuildDefersReturnSafeDistanceInterrupt() {
  const system = new SurvivalSystem({ cooldownMs: 1, farFromBaseDistance: 32 })
  const ctx = createContext({}, {
    hasBaseLocation: true,
    position: { x: 80, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 },
    currentTask: {
      id: 9,
      type: 'build_blueprint',
      state: 'RUNNING',
      priority: 5,
      source: 'player_command'
    }
  })
  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  // 第 8 轮起「离基地太远」在工地上根本不再成为候选（工地就是家），
  // 而不是像以前那样先成为候选、再在动作层被施工挡回 REMIND。
  // 对外可见的结果不变：不打断施工、不入队回家；额外的好处是不再每隔一会儿念一次。
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.NORMAL)
  assert.strictEqual(state.worksite.atWorksite, true)
  assert.strictEqual(state.isFarFromBase, true)
  assert.strictEqual(decision.shouldInterrupt, false)

  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(ctx.taskManager.paused, null)
  assert.strictEqual(ctx.taskManager.interrupted, null)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
}

async function testPlayerBuildDefersInventoryFullInterrupt() {
  const system = new SurvivalSystem({ cooldownMs: 1 })
  const ctx = createContext({}, {
    emptySlots: 0,
    chestLocations: 1,
    currentTask: {
      id: 10,
      type: 'build_blueprint',
      state: 'RUNNING',
      priority: 5,
      source: 'player_command'
    }
  })
  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(decision.action, 'REMIND')
  assert.strictEqual(decision.shouldInterrupt, false)
  assert.strictEqual(decision.deferredForTask, 'build_blueprint')

  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(ctx.taskManager.paused, null)
  assert.strictEqual(ctx.taskManager.interrupted, null)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
}

async function testQueuedPlayerBuildDefersInventoryFullReturnSafe() {
  const system = new SurvivalSystem({ cooldownMs: 1 })
  const queuedBuild = {
    id: 12,
    type: 'build_blueprint',
    state: 'IDLE',
    priority: 11,
    source: 'player_command'
  }
  const ctx = createContext({
    tasks: {
      currentTask: null,
      queue: [queuedBuild],
      pausedStack: []
    }
  }, {
    emptySlots: 0,
    hasBaseLocation: true
  })
  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(decision.action, 'REMIND')
  assert.strictEqual(decision.shouldInterrupt, false)
  assert.strictEqual(decision.deferredForTask, 'build_blueprint')
  assert.strictEqual(decision.deferredReason, 'construction_active_or_queued')

  const applied = await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(applied.type, 'DEFERRED')
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
}

async function testPlayerBuildDefersStuckOrFallRiskInterrupt() {
  const system = new SurvivalSystem({ cooldownMs: 1 })
  const ctx = createContext({}, {
    onGround: false,
    currentTask: {
      id: 11,
      type: 'build_blueprint',
      state: 'RUNNING',
      priority: 5,
      source: 'player_command'
    }
  })
  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.STUCK_OR_FALL_RISK)
  assert.strictEqual(decision.action, 'REMIND')
  assert.strictEqual(decision.shouldInterrupt, false)
  assert.strictEqual(decision.deferredForTask, 'build_blueprint')

  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(ctx.taskManager.paused, null)
  assert.strictEqual(ctx.taskManager.interrupted, null)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
}

async function testNormalDoesNotInterruptAndDangerPausesBuild() {
  const system = new SurvivalSystem()
  const ctx = createContext({}, { currentTask: { id: 1, type: 'exploration', state: 'RUNNING', priority: 3 } })
  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.NORMAL)
  assert.strictEqual(decision.shouldInterrupt, false)

  const managerCtx = createContext({}, { dangerLevel: 'high', currentTask: { id: 1, type: 'build_blueprint', state: 'RUNNING', priority: 5 } })
  const manager = new TaskManager(managerCtx.bot, {
    actionLock: managerCtx.actionLock,
    blackboard: managerCtx.blackboard,
    memory: managerCtx.memory,
    debug: false,
    enableTaskFeedback: false
  })
  const buildTask = manager.createTask('build_blueprint', { blueprintName: 'small_house' }, 5, 'test')
  manager.currentTask = buildTask
  managerCtx.taskManager = manager
  const decision2 = system.createSurvivalPlan(managerCtx, system.evaluateSurvivalState(managerCtx))
  await system.applySurvivalDecision(managerCtx, decision2)
  assert.strictEqual(manager.currentTask, null)
  assert.strictEqual(manager.pausedStack.length, 1)
  assert.strictEqual(manager.pausedStack[0].type, 'build_blueprint')
  assert.strictEqual(manager.interrupted.length, 0)
  assert.strictEqual(manager.queue.length, 1)
  assert.strictEqual(manager.queue[0].type, 'guard_player')
}

async function testSafeModeAndNoBaseLimits() {
  const system = new SurvivalSystem()
  const ctx = createContext({}, { hasBaseLocation: false })
  system.setSafeMode(ctx, true)
  const exploration = new ExplorationSystem()
  assert.strictEqual(exploration.resolveRadius(ctx, { radius: 64 }), 16)
}

async function testSurvivalIntentAndRouting() {
  assert.strictEqual(parseIntent('你现在安全吗？').actionKey, ACTION_KEYS.CHECK_SURVIVAL_STATUS)
  assert.strictEqual(parseIntent('危险就回来').actionKey, ACTION_KEYS.ENABLE_SAFE_MODE)
  assert.strictEqual(parseIntent('你喜欢冒险吗？').actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(parseIntent('安全模式是什么意思？').actionKey, ACTION_KEYS.CHAT)

  const ctx = createContext()
  ctx.survivalSystem = new SurvivalSystem()
  let result = await routePlayerCommand('开启安全模式', ctx)
  assert.strictEqual(result.action.action, 'safe_mode')
  assert.strictEqual(ctx.blackboard.get('survival.safeModeEnabled'), true)

  result = await routePlayerCommand('你现在安全吗？', ctx)
  assert.strictEqual(result.action.action, 'survival_status')
}

async function testPlanningAndStatus() {
  const ctx = createContext({}, { food: 3, foodCount: 1, counts: { bread: 1 } })
  ctx.taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source, state: 'COMPLETED', result: { ok: true } }
      this.enqueued.push(task)
      return task
    },
    status() {
      return { currentTask: null, queue: [], pausedStack: [], recentCompleted: this.enqueued, recentFailed: [], recentInterrupted: [] }
    }
  }
  const planning = new PlanningSystem()
  const result = await planning.createAndSubmitPlan('survival_low_food', ctx)
  assert.strictEqual(result.ok, true)
  await planning.update(ctx)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'eat_food')

  const survivalSystem = new SurvivalSystem()
  survivalSystem.evaluateSurvivalState(ctx)
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    survivalSystem,
    equipmentSystem: {
      getToolStatus: () => ({ hasPickaxe: true }),
      getArmorStatus: () => ({ helmet: null, chestplate: null, leggings: null, boots: null, armorLevel: 0 })
    },
    debug: false,
    enableTaskFeedback: false
  })
  const status = manager.status()
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'survivalStatus'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'survivalCooldowns'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'equipmentState'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'armorState'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'sleepState'))
  assert.ok(Object.prototype.hasOwnProperty.call(status.sleepState, 'canSleepNow'))
}

async function testAdvancedSurvivalActions() {
  let system = new SurvivalSystem({ cooldownMs: 1 })
  let ctx = createContext({}, {
    health: 4,
    currentTask: { id: 1, type: 'exploration', state: 'RUNNING', priority: 5 },
    hasBaseLocation: true
  })
  let state = system.evaluateSurvivalState(ctx)
  let decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.interrupted, 'survival_critical_health')

  system = new SurvivalSystem({ cooldownMs: 1 })
  ctx = createContext({}, {
    food: 3,
    foodCount: 1,
    currentTask: { id: 2, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  state = system.evaluateSurvivalState(ctx)
  decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.paused, 'survival_low_food_critical')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'eat_food')

  system = new SurvivalSystem({ cooldownMs: 1 })
  ctx = createContext({}, {
    isDay: false,
    hasBaseLocation: true,
    position: { x: 40, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 },
    currentTask: { id: 3, type: 'exploration', state: 'RUNNING', priority: 5 }
  })
  state = system.evaluateSurvivalState(ctx)
  decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'return_to_base')

  system = new SurvivalSystem({ cooldownMs: 1 })
  ctx = createContext({}, {
    emptySlots: 0,
    chestLocations: 1,
    currentTask: { id: 4, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  state = system.evaluateSurvivalState(ctx)
  decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.paused, 'survival_inventory_full')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'storage')
}

async function testNightSleepSurvivalActionAndMonsterGuardPriority() {
  let system = new SurvivalSystem({ cooldownMs: 1 })
  let ctx = createContext({}, {
    isDay: false,
    bedPosition: { x: 3, y: 64, z: 0 },
    currentTask: { id: 7, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  let state = system.evaluateSurvivalState(ctx)
  let decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.SLEEP_NIGHT)
  assert.strictEqual(decision.action, 'REMIND')
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.paused, null)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
  assert.strictEqual(system.status(ctx).sleepState.canSleepNow, true)

  system = new SurvivalSystem({ cooldownMs: 1 })
  ctx = createContext({}, {
    isDay: false,
    bedPosition: { x: 3, y: 64, z: 0 },
    hostile: { id: 9, name: 'zombie', distance: 4, position: { x: 4, y: 64, z: 0 } },
    currentTask: { id: 8, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  state = system.evaluateSurvivalState(ctx)
  decision = system.createSurvivalPlan(ctx, state)
  assert.strictEqual(decision.priority, SURVIVAL_PRIORITIES.DANGER_NEARBY)
  await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'guard_player')
}

async function testSafeModeBlocksLowPriorityAndCanResume() {
  const system = new SurvivalSystem({ safeModeEnabled: true, safeModeExitCooldownMs: 0 })
  let blocked = system.shouldBlockNewTask('exploration', {}, 'player_command')
  assert.strictEqual(blocked.ok, false)
  blocked = system.shouldBlockNewTask('return_to_player', {}, 'player_command')
  assert.strictEqual(blocked.ok, true)

  const ctx = createContext()
  const pausedTask = { id: 9, type: 'exploration', state: 'PAUSED', manualPause: true }
  system.pausedTaskDueToSurvival = pausedTask
  ctx.taskManager.pausedStack = [pausedTask]
  system.setSafeMode(ctx, false)
  const resumed = await system.resumeIfSafe(ctx)
  assert.strictEqual(resumed.ok, true)
  assert.strictEqual(ctx.taskManager.resumed, 'survival_recovered')
}

async function testSafeModeRecoveryAllowsNonCriticalMediumState() {
  const logs = []
  const system = new SurvivalSystem({
    safeModeEnabled: true,
    safeModeExitCooldownMs: 0,
    farFromBaseDistance: 32
  })
  const ctx = createContext({}, {
    food: 20,
    health: 20,
    hasBaseLocation: true,
    position: { x: 64, y: 64, z: 0 },
    basePosition: { x: 0, y: 64, z: 0 }
  })
  ctx.logger = { log: message => logs.push(message), warn() {}, error() {} }
  // 这条用例要的是「非危急的 MEDIUM 状态也能退出安全模式并恢复任务」，
  // 挂起的任务是什么类型无所谓。挂 build_blueprint 会激活工地锚点、
  // 把 TOO_FAR_FROM_BASE 压掉（第 8 轮新行为，另有专门用例覆盖），
  // 那样就测不到本用例想测的 MEDIUM 档了，所以这里换成勘探。
  const pausedTask = { id: 10, type: 'exploration', state: 'PAUSED', manualPause: true }
  ctx.taskManager.pausedStack = [pausedTask]
  system.pausedTaskDueToSurvival = pausedTask

  const state = system.evaluateSurvivalState(ctx)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
  assert.strictEqual(state.overallRiskLevel, 'medium')
  assert.strictEqual(system.isSafeModeEnabled(ctx), false)

  const resumed = await system.resumeIfSafe(ctx, state)
  assert.strictEqual(resumed.ok, true)
  assert.strictEqual(ctx.taskManager.resumed, 'survival_recovered')
  assert.ok(logs.some(line => line.includes('[SURVIVAL_SAFE_MODE_EXIT]')))
}

async function testGoalSystemContinuesPendingRecoveryWithoutGoals() {
  const calls = { evaluate: 0, resume: 0 }
  const survivalSystem = {
    hasPendingRecovery: () => true,
    evaluateSurvivalState() {
      calls.evaluate += 1
      return {
        survivalPriority: SURVIVAL_PRIORITIES.NORMAL,
        overallRiskLevel: 'low',
        dangerLevel: 'none'
      }
    },
    createSurvivalPlan() {
      return { priority: SURVIVAL_PRIORITIES.NORMAL }
    },
    async resumeIfSafe() {
      calls.resume += 1
      return { ok: true }
    }
  }
  const goalSystem = new GoalSystem({ survivalSystem })
  await goalSystem.update(createContext())
  assert.strictEqual(calls.evaluate, 1)
  assert.strictEqual(calls.resume, 1)
}

async function testLowFoodBuildRecoveryKeepsTaskRunAndCheckpoint() {
  const recoveryLogs = []
  const system = new SurvivalSystem({
    cooldownMs: 1,
    safeModeExitCooldownMs: 0,
    recoveryFoodThreshold: 12
  })
  const ctx = createContext({}, {
    food: 4,
    foodCount: 1,
    counts: { cooked_beef: 1 },
    inventoryItems: [{ name: 'cooked_beef', count: 1 }]
  })
  ctx.logger = { log: message => recoveryLogs.push(message), warn() {}, error() {} }
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    debug: false,
    enableTaskFeedback: false
  })
  ctx.taskManager = manager

  const buildTask = manager.createTask('build_blueprint', { blueprintName: 'small_house' }, 11, 'player_command')
  buildTask.state = 'RUNNING'
  buildTask.started = true
  buildTask.currentStepIndex = 441
  buildTask.currentIndex = 441
  buildTask.system.session = { constructionRunId: 'construction_run_recovery_test' }
  let resumeCount = 0
  const originalResume = buildTask.resume.bind(buildTask)
  buildTask.resume = async resumeContext => {
    resumeCount += 1
    return originalResume(resumeContext)
  }
  buildTask.update = async updateContext => {
    buildTask.acquireLocks(updateContext)
  }
  manager.currentTask = buildTask
  ctx.blackboard.set('tasks.currentTask', buildTask.toJSON())

  const lowFoodState = system.evaluateSurvivalState(ctx)
  await system.applySurvivalDecision(ctx, system.createSurvivalPlan(ctx, lowFoodState))
  assert.strictEqual(manager.currentTask, null)
  assert.strictEqual(manager.pausedStack.length, 1)
  assert.strictEqual(manager.pausedStack[0], buildTask)
  assert.strictEqual(buildTask.state, 'PAUSED')
  assert.strictEqual(system.pausedTaskDueToSurvival.id, buildTask.id)
  assert.strictEqual(system.pausedTaskDueToSurvival.type, buildTask.type)
  assert.strictEqual(buildTask.currentStepIndex, 441)
  assert.strictEqual(manager.queue[0].type, 'eat_food')

  manager.completed.push({ ...manager.queue[0].toJSON(), state: 'COMPLETED' })
  manager.queue = []
  ctx.bot.food = 20
  ctx.blackboard.set('bot.food', 20)
  ctx.blackboard.set('tasks.currentTask', null)
  const goalSystem = new GoalSystem({ survivalSystem: system })
  assert.strictEqual(goalSystem.survivalSystem, system)
  assert.strictEqual(system.hasPendingRecovery(), true)
  const recoveryStatus = await goalSystem.update(ctx)

  assert.strictEqual(manager.currentTask, buildTask, `${JSON.stringify(recoveryStatus)}\n${recoveryLogs.slice(-8).join('\n')}`)
  assert.strictEqual(manager.currentTask.id, buildTask.id)
  assert.strictEqual(manager.currentTask.state, 'RUNNING')
  assert.strictEqual(manager.currentTask.currentStepIndex, 441)
  assert.strictEqual(manager.currentTask.system.session.constructionRunId, 'construction_run_recovery_test')
  assert.strictEqual(manager.pausedStack.length, 0)
  assert.strictEqual(resumeCount, 1)
  assert.strictEqual(system.isSafeModeEnabled(ctx), false)

  await manager.tick()
  assert.strictEqual(manager.actionLock.getOwner('building'), buildTask.id)
  await goalSystem.update(ctx)
  assert.strictEqual(resumeCount, 1)
  assert.ok(recoveryLogs.some(line => line.includes('[SURVIVAL_RECOVERY_EVAL]') && line.includes('"canResume":true')))
}

async function testRecoveryRejectsUnsafeFoodAndDanger() {
  const cases = [
    {
      options: { food: 8 },
      expectedReason: 'food_below_recovery_threshold'
    },
    {
      options: { food: 20, dangerLevel: 'critical' },
      expectedReason: 'immediate_danger'
    }
  ]

  for (const entry of cases) {
    const system = new SurvivalSystem({ safeModeExitCooldownMs: 0, recoveryFoodThreshold: 12 })
    const ctx = createContext({}, entry.options)
    const manager = new TaskManager(ctx.bot, {
      actionLock: ctx.actionLock,
      blackboard: ctx.blackboard,
      debug: false,
      enableTaskFeedback: false
    })
    ctx.taskManager = manager
    const buildTask = manager.createTask('build_blueprint', { blueprintName: 'small_house' }, 11, 'test')
    buildTask.state = 'PAUSED'
    buildTask.manualPause = true
    manager.pausedStack.push(buildTask)
    system.pausedTaskDueToSurvival = { id: buildTask.id, type: buildTask.type }
    system.setSafeMode(ctx, false)

    const result = await system.resumeIfSafe(ctx)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.reason, entry.expectedReason)
    assert.strictEqual(manager.currentTask, null)
    assert.strictEqual(manager.pausedStack[0], buildTask)
    assert.strictEqual(buildTask.state, 'PAUSED')
  }
}

async function testRecoveryReportsMissingPausedTask() {
  const system = new SurvivalSystem({ safeModeExitCooldownMs: 0 })
  const ctx = createContext()
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    debug: false,
    enableTaskFeedback: false
  })
  ctx.taskManager = manager
  system.pausedTaskDueToSurvival = { id: 404, type: 'build_blueprint' }
  system.setSafeMode(ctx, false)

  const result = await system.resumeIfSafe(ctx)
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.reason, 'missing_paused_task')
  assert.strictEqual(manager.currentTask, null)
}

async function testSurvivalRecoveryPreservesAndRepairsPausedBuildTarget() {
  const system = new SurvivalSystem({ safeModeExitCooldownMs: 0 })
  const ctx = createContext()
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    debug: false,
    enableTaskFeedback: false
  })
  ctx.taskManager = manager

  const buildTask = manager.createTask('build_blueprint', { blueprintName: 'small_house' }, 11, 'player_command')
  buildTask.state = 'PAUSED'
  buildTask.manualPause = true
  buildTask.pauseReason = 'survival_danger_nearby'
  manager.pausedStack.push(buildTask)

  const guardTask = manager.createTask('guard_player', {}, 9, 'survival_system')
  guardTask.state = 'RUNNING'
  manager.currentTask = guardTask
  ctx.blackboard.set('tasks.currentTask', guardTask.toJSON())
  system.pausedTaskDueToSurvival = guardTask

  const guarded = system.evaluateRecoverySafety(ctx, {
    food: 20,
    health: 20,
    oxygen: 20,
    dangerLevel: 'high',
    nearestHostileDistance: 3,
    survivalPriority: SURVIVAL_PRIORITIES.DANGER_NEARBY
  })
  assert.strictEqual(guarded.canResume, false)
  assert.strictEqual(guarded.rejectionReason, 'immediate_danger')
  assert.strictEqual(system.pausedTaskDueToSurvival.id, buildTask.id)
  assert.strictEqual(system.pausedTaskDueToSurvival.type, buildTask.type)
  assert.strictEqual(manager.pausedStack.includes(buildTask), true)

  manager.currentTask = null
  ctx.blackboard.set('tasks.currentTask', null)
  system.setSafeMode(ctx, false)
  const recovered = await system.resumeIfSafe(ctx, {
    food: 20,
    health: 20,
    oxygen: 20,
    dangerLevel: 'none',
    nearestHostileDistance: Infinity,
    survivalPriority: SURVIVAL_PRIORITIES.NORMAL
  })

  assert.strictEqual(recovered.ok, true)
  assert.strictEqual(manager.currentTask, buildTask)
  assert.strictEqual(buildTask.state, 'RUNNING')
  assert.strictEqual(system.pausedTaskDueToSurvival, null)
}

async function testSurvivalStatusFieldsAndCooldown() {
  const system = new SurvivalSystem({ cooldownMs: 60000 })
  const ctx = createContext({}, {
    food: 3,
    foodCount: 0,
    currentTask: { id: 1, type: 'exploration', state: 'RUNNING', priority: 5 }
  })
  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)
  const repeat = await system.applySurvivalDecision(ctx, decision)
  assert.strictEqual(repeat.type, 'COOLDOWN')

  const status = system.status(ctx)
  for (const field of ['survivalState', 'safeMode', 'survivalPriority', 'survivalReason', 'interruptedTask', 'pausedTask', 'queuedSurvivalTask', 'lastSurvivalAction', 'canResumePreviousTask', 'foodStatus', 'healthStatus', 'nightStatus', 'inventoryStatus']) {
    assert.ok(Object.prototype.hasOwnProperty.call(status, field), field)
  }
}

async function testAutoCraftMissingTools() {
  console.log('  [Auto-Craft Missing Tools Tests]')
  const system = new SurvivalSystem({ cooldownMs: 60000 })

  // Test _bestCraftableTool with cobblestone available
  let counts = { cobblestone: 5, stick: 4, iron_ingot: 0, oak_planks: 0 }
  let tool = system._bestCraftableTool('pickaxe', counts)
  assert.strictEqual(tool, 'stone_pickaxe', 'should craft stone pickaxe when cobblestone available')
  console.log('  ✓ stone pickaxe preferred when cobblestone available')

  // Test with iron available → should still prefer stone (stone > iron in tier priority)
  counts = { cobblestone: 5, iron_ingot: 5, stick: 4, oak_planks: 3 }
  tool = system._bestCraftableTool('pickaxe', counts)
  assert.strictEqual(tool, 'stone_pickaxe', 'stone preferred over iron for efficiency')
  console.log('  ✓ stone_ still preferred when both available')

  // Test with only wood planks available
  counts = { cobblestone: 0, iron_ingot: 0, stick: 4, oak_planks: 5 }
  tool = system._bestCraftableTool('axe', counts)
  assert.strictEqual(tool, 'wooden_axe', 'should craft wooden axe when only planks available')
  console.log('  ✓ falls back to wooden when stone/iron unavailable')

  // Test with insufficient sticks
  counts = { cobblestone: 10, stick: 1 }
  tool = system._bestCraftableTool('sword', counts)
  assert.strictEqual(tool, null, 'should return null when sticks insufficient')
  console.log('  ✓ returns null when materials insufficient')

  // Test each tool type
  for (const toolType of ['pickaxe', 'axe', 'sword']) {
    counts = { cobblestone: 5, stick: 4 }
    tool = system._bestCraftableTool(toolType, counts)
    assert.strictEqual(tool, `stone_${toolType}`, `should craft stone_${toolType}`)
  }
  console.log('  ✓ all three tool types craft correctly')

  // Full integration: craftMissingBasicTools with equipment system mock
  const ctx = createContext({}, {
    counts: { cobblestone: 5, stick: 4, iron_ingot: 2, oak_planks: 3 }
  })
  // Inject equipment system that reports missing tools
  ctx.equipmentSystem = {
    getToolStatus: () => ({
      hasPickaxe: false,
      hasAxe: false,
      hasSword: true,
      hasShovel: false,
      heldItem: null
    }),
    hasWeapon: () => ({ ok: true }),
    hasFood: () => ({ ok: true })
  }

  const result = system.craftMissingBasicTools(ctx)
  assert.strictEqual(result.ok, true, 'should detect missing tools and enqueue craft tasks')
  assert.ok(result.crafted.includes('stone_pickaxe'), 'should craft pickaxe')
  assert.ok(result.crafted.includes('stone_axe'), 'should craft axe')
  assert.ok(!result.crafted.includes('stone_sword'), 'should not craft sword (already has one)')
  console.log(`  ✓ auto-craft enqueues for missing tools: ${result.crafted.join(', ')}`)

  // When all tools present, should skip (use fresh system without cooldown)
  const system2 = new SurvivalSystem({ cooldownMs: 1 })
  ctx.equipmentSystem.getToolStatus = () => ({
    hasPickaxe: true,
    hasAxe: true,
    hasSword: true,
    hasShovel: false,
    heldItem: null
  })
  const skipResult = system2.craftMissingBasicTools(ctx)
  assert.strictEqual(skipResult.reason, 'all_tools_present', 'should skip when all tools present')
  console.log('  ✓ skips auto-craft when all tools present')

  // Cooldown check on the original system
  const cooldownResult = system.craftMissingBasicTools(ctx)
  assert.strictEqual(cooldownResult.reason, 'cooldown', 'should respect cooldown')
  console.log('  ✓ respects cooldown after crafting')

  console.log('  Auto-craft missing tools tests passed')
}

async function testRiskTriggersArmorCheck() {
  console.log('  [Armor Risk Tests]')
  const system = new SurvivalSystem({ cooldownMs: 1 })
  const ctx = createContext({}, {
    dangerLevel: 'high',
    currentTask: { id: 1, type: 'mining', state: 'RUNNING', priority: 5 }
  })
  let called = 0
  ctx.equipmentSystem = {
    hasWeapon: () => ({ ok: true }),
    hasFood: () => ({ ok: true }),
    equipBestArmor: async () => {
      called += 1
      return { success: true, equippedCount: 1 }
    }
  }
  const state = system.evaluateSurvivalState(ctx)
  const result = await system.ensureArmorForRisk(ctx, state)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(called, 1)
  console.log('  danger/mining triggers equipBestArmor')
}

async function testLegacyEscapeRespectsManagedMovementOwnership() {
  const activeTaskLock = new ActionLock()
  let claim = claimLegacyEscapeMovement({
    currentTask: { id: 41, type: 'build_blueprint', state: 'RUNNING' }
  }, activeTaskLock)
  assert.strictEqual(claim.ok, false)
  assert.strictEqual(claim.reason, 'managed_task_active')
  assert.strictEqual(activeTaskLock.getOwner('movement'), null)

  const buildingLock = new ActionLock()
  buildingLock.acquire('building', 42)
  claim = claimLegacyEscapeMovement({ currentTask: null }, buildingLock)
  assert.strictEqual(claim.ok, false)
  assert.strictEqual(claim.reason, 'building_lock_active')
  assert.strictEqual(claim.buildingOwner, 42)

  const movementLock = new ActionLock()
  movementLock.acquire('movement', 43)
  claim = claimLegacyEscapeMovement({ currentTask: null }, movementLock)
  assert.strictEqual(claim.ok, false)
  assert.strictEqual(claim.reason, 'lock_already_held')
  assert.strictEqual(claim.movementOwner, 43)

  const idleLock = new ActionLock()
  claim = claimLegacyEscapeMovement({ currentTask: null }, idleLock)
  assert.strictEqual(claim.ok, true)
  assert.strictEqual(idleLock.getOwner('movement'), 'legacy_escape')
  const released = releaseLegacyEscapeMovement(idleLock, claim)
  assert.strictEqual(released.ok, true)
  assert.strictEqual(released.released, true)
  assert.strictEqual(idleLock.getOwner('movement'), null)
}

async function run() {
  await testPrioritySelection()
  await testInterruptDecisionAndCooldown()
  await testSurvivalEnqueuesCarryReason()
  await testCombatIsInterruptibleOnlyByLifeSavingPriorities()
  await testCombatInterruptRespectsCooldown()
  await testSafeModeStillAllowsCombatTasks()
  await testBuildCommandPriorityBeatsReturnSafe()
  await testPlayerBuildDefersReturnSafeDistanceInterrupt()
  await testPlayerBuildDefersInventoryFullInterrupt()
  await testQueuedPlayerBuildDefersInventoryFullReturnSafe()
  await testPlayerBuildDefersStuckOrFallRiskInterrupt()
  await testNormalDoesNotInterruptAndDangerPausesBuild()
  await testSafeModeAndNoBaseLimits()
  await testSurvivalIntentAndRouting()
  await testPlanningAndStatus()
  await testAdvancedSurvivalActions()
  await testNightSleepSurvivalActionAndMonsterGuardPriority()
  await testSafeModeBlocksLowPriorityAndCanResume()
  await testSafeModeRecoveryAllowsNonCriticalMediumState()
  await testGoalSystemContinuesPendingRecoveryWithoutGoals()
  await testLowFoodBuildRecoveryKeepsTaskRunAndCheckpoint()
  await testRecoveryRejectsUnsafeFoodAndDanger()
  await testRecoveryReportsMissingPausedTask()
  await testSurvivalRecoveryPreservesAndRepairsPausedBuildTarget()
  await testSurvivalStatusFieldsAndCooldown()
  await testAutoCraftMissingTools()
  await testRiskTriggersArmorCheck()
  await testLegacyEscapeRespectsManagedMovementOwnership()
  console.log('survival-system tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
