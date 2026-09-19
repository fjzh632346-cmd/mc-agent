const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { ACTION_KEYS } = require('../ai/action-keys')
const { intentToTask } = require('../ai/intent-to-task')
const { BaseTask, TASK_STATE } = require('../tasks/base-task')
const { TaskManager, TASK_TYPES } = require('../tasks/task-manager')
const {
  ARBITRATION_STATES,
  DECISIONS,
  MovementLock,
  PRIORITY_LEVELS,
  TaskArbiter,
  TaskConflictResolver,
  TaskPriorityManager,
  TaskStateMachine
} = require('../systems/task-arbitration')

class StubTask extends BaseTask {
  constructor(options) {
    super(options)
    this.required = options.requiredLocks || []
    this.checkpoint = options.checkpoint || null
  }

  get requiredLocks() {
    return this.required
  }
}

class HoldTask extends StubTask {
  constructor(options) {
    super({ ...options, type: options.type || 'hold_task', requiredLocks: options.requiredLocks || ['movement'] })
    this.updates = 0
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    this.updates += 1
  }
}

class CompleteTask extends StubTask {
  constructor(options) {
    super({ ...options, type: options.type || 'complete_task', requiredLocks: options.requiredLocks || [] })
  }

  async update(ctx) {
    await super.update(ctx)
    await this.complete(ctx, { ok: true })
  }
}

function task(type, options = {}) {
  return new StubTask({
    id: options.id || type,
    type,
    priority: options.priority ?? 5,
    source: options.source || 'test',
    params: options.params || {},
    requiredLocks: options.requiredLocks || locksForType(type),
    resumable: options.resumable ?? true,
    checkpoint: options.checkpoint || null
  })
}

function locksForType(type) {
  if (type === 'build_blueprint') return ['building']
  if (type === 'mining' || type === 'mine_nearby_block') return ['movement', 'digging', 'inventory']
  if (type === 'storage') return ['movement', 'inventory']
  if (type === 'return_to_base' || type === 'return_to_player' || type === 'exploration') return ['movement']
  if (type === 'guard_player' || type === 'fight_nearby_mob') return ['movement', 'combat']
  if (type === 'craft_item' || type === 'smelt_item') return ['inventory', 'crafting']
  return []
}

function createBot() {
  return {
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    inventory: { items: () => [] },
    players: {},
    entities: {},
    pathfinder: { setGoal() {}, setMovements() {}, stop() {} },
    pvp: { stop() {} }
  }
}

function createIntentContextForBuild(logs = []) {
  return {
    playerName: 'accept_tester',
    memory: {
      summary() {
        return { world: { hasBaseLocation: true } }
      },
      world: {
        baseLocation: { position: { x: 0, y: 64, z: 0 } }
      }
    },
    taskManager: {
      currentTask: {
        id: 42,
        type: 'build_blueprint',
        state: 'RUNNING',
        priority: 11,
        source: 'player_command'
      },
      enqueued: [],
      interrupted: [],
      enqueue(type, params, priority, source) {
        const task = { id: this.enqueued.length + 1, type, params, priority, source, state: 'IDLE' }
        this.enqueued.push(task)
        return task
      },
      async interruptCurrent(reason) {
        this.interrupted.push(reason)
        return true
      }
    },
    logger: {
      log(message) {
        logs.push(message)
      }
    }
  }
}

async function testPriorityPreemption() {
  const resolver = new TaskConflictResolver()

  let current = task('exploration')
  let incoming = task('build_blueprint')
  let result = resolver.resolveConflict(current, incoming)
  assert.strictEqual(result.action, DECISIONS.PAUSE_CURRENT)

  current = task('build_blueprint')
  incoming = task('prepare_combat')
  result = resolver.resolveConflict(current, incoming)
  assert.strictEqual(result.action, DECISIONS.PAUSE_CURRENT)

  current = task('build_blueprint')
  incoming = task('guard_player')
  result = resolver.resolveConflict(current, incoming)
  assert.strictEqual(result.action, DECISIONS.FORCE_PREEMPT)
}

async function testConflictResolution() {
  const resolver = new TaskConflictResolver()

  let result = resolver.resolveConflict(task('mining'), task('build_blueprint'))
  assert.strictEqual(result.action, DECISIONS.QUEUE)
  assert.strictEqual(result.reason, 'incoming_priority_not_higher')

  result = resolver.resolveConflict(task('build_blueprint'), task('storage'))
  assert.strictEqual(result.action, DECISIONS.QUEUE)

  result = resolver.resolveConflict(task('storage'), task('return_to_player'))
  assert.strictEqual(result.action, DECISIONS.QUEUE)
  assert.strictEqual(result.lockConflict, true)

  result = resolver.resolveConflict(task('build_blueprint'), task('return_to_base', {
    source: 'survival_system',
    priority: 8
  }))
  assert.strictEqual(result.action, DECISIONS.QUEUE)
  assert.strictEqual(result.reason, 'return_to_base_deferred_for_building')
}

async function testReturnToBaseCommandUsesArbiterDuringBuild() {
  const logs = []
  const ctx = createIntentContextForBuild(logs)
  const result = await intentToTask({
    actionKey: ACTION_KEYS.RETURN_TO_BASE,
    intent: 'return_to_base',
    shouldExecute: true,
    params: {}
  }, ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.action, 'enqueue_task')
  assert.strictEqual(ctx.taskManager.interrupted.length, 0)
  assert.strictEqual(ctx.taskManager.enqueued.length, 1)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'return_to_base')
  assert.strictEqual(ctx.taskManager.enqueued[0].params.arbitrationPriority, 'LOW')
  assert.strictEqual(logs.some(line => line.includes('[TASK_INTERRUPT_FOR_PLAYER_MOVEMENT]')), false)
  assert.strictEqual(logs.some(line => line.includes('[RETURN_COMMAND_ARBITRATED]') && line.includes('current=build_blueprint')), true)
}

async function testTaskManagerLogsReturnToBaseArbiterQueue() {
  const logs = []
  const manager = new TaskManager(createBot(), {
    debug: true,
    enableTaskFeedback: false,
    logger: { log: message => logs.push(message) }
  })
  manager.debug = message => logs.push(message)
  manager.currentTask = task('build_blueprint', {
    id: 99,
    priority: 11,
    source: 'player_command'
  })

  const enqueued = manager.enqueue('return_to_base', { arbitrationPriority: 'LOW' }, 8, 'player_command')

  assert.strictEqual(enqueued.type, 'return_to_base')
  assert.strictEqual(manager.currentTask.type, 'build_blueprint')
  assert.strictEqual(manager.queue.length, 1)
  assert.strictEqual(manager.queue[0].type, 'return_to_base')
  assert.strictEqual(logs.some(line => line.includes('[TaskArbiter] request task=return_to_base') && line.includes('action=QUEUE')), true)
  assert.strictEqual(logs.some(line => line.includes('[TASK_ARBITRATION_QUEUE] current=build_blueprint incoming=return_to_base')), true)
}

async function testFollowCommandStillInterruptsActiveBuild() {
  const logs = []
  const ctx = createIntentContextForBuild(logs)
  const result = await intentToTask({
    actionKey: ACTION_KEYS.FOLLOW_PLAYER,
    intent: 'follow_player',
    shouldExecute: true,
    params: {}
  }, ctx)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx.taskManager.interrupted[0], 'follow_player_command')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'follow_player')
  assert.strictEqual(logs.some(line => line.includes('[TASK_INTERRUPT_FOR_PLAYER_MOVEMENT] from=build_blueprint reason=follow_player_command')), true)
}

async function testMovementLock() {
  let now = 1000
  const actionLock = new ActionLock({ now: () => now })
  const movementLock = new MovementLock({
    actionLock,
    now: () => now,
    staleMs: 50
  })

  assert.strictEqual(movementLock.lock('task-a').ok, true)
  const doubleLock = movementLock.lock('task-b')
  assert.strictEqual(doubleLock.ok, false)
  assert.strictEqual(doubleLock.reason, 'movement_lock_held')
  assert.strictEqual(movementLock.unlock('task-b').ok, false)
  assert.strictEqual(movementLock.unlock('task-a').released, true)

  assert.strictEqual(movementLock.lock('task-a').ok, true)
  const transfer = movementLock.transfer('critical-task', 'critical_preempt')
  assert.strictEqual(transfer.ok, true)
  assert.strictEqual(actionLock.getOwner('movement'), 'critical-task')

  now = 2000
  assert.strictEqual(movementLock.lock('task-c').ok, true)
  assert.strictEqual(actionLock.getOwner('movement'), 'task-c')
}

async function testStateMachine() {
  const machine = new TaskStateMachine()
  let record = machine.create(task('build_blueprint'))
  assert.strictEqual(record.state, ARBITRATION_STATES.PENDING)

  record = machine.activate(record)
  assert.strictEqual(record.state, ARBITRATION_STATES.ACTIVE)
  record = machine.complete(record)
  assert.strictEqual(record.state, ARBITRATION_STATES.COMPLETED)

  record = machine.activate(machine.create(task('build_blueprint')))
  record = machine.checkpoint(record, { currentStepIndex: 12 }, { placedBlocks: 12 })
  record = machine.pause(record, 'test_pause')
  assert.strictEqual(record.state, ARBITRATION_STATES.PAUSED)
  assert.strictEqual(record.checkpoint.currentStepIndex, 12)
  record = machine.resume(record)
  assert.strictEqual(record.state, ARBITRATION_STATES.ACTIVE)
  assert.strictEqual(record.checkpoint.currentStepIndex, 12)

  record = machine.activate(machine.create(task('storage')))
  record = machine.block(record, 'chest_not_found')
  assert.strictEqual(record.state, ARBITRATION_STATES.BLOCKED)
  assert.strictEqual(record.blockedReason, 'chest_not_found')

  record = machine.activate(machine.create(task('mining')))
  record = machine.fail(record, 'path_unreachable')
  assert.strictEqual(record.state, ARBITRATION_STATES.FAILED)
  assert.strictEqual(record.failureReason, 'path_unreachable')
}

async function testBuildingCheckpointResume() {
  const arbiter = new TaskArbiter()
  const build = task('build_blueprint', {
    id: 1,
    checkpoint: { currentStepIndex: 20, placedBlocks: 20 }
  })
  arbiter.prepareTask(build)
  let record = arbiter.markActive(build)
  record = arbiter.checkpoint(build, { currentStepIndex: 20, placedBlocks: 20 })
  record = arbiter.markPaused(build, 'critical_preempt', { currentStepIndex: 20, placedBlocks: 20 })
  assert.strictEqual(record.state, ARBITRATION_STATES.PAUSED)
  assert.strictEqual(record.checkpoint.currentStepIndex, 20)
  record = arbiter.markActive(build)
  assert.strictEqual(record.checkpoint.currentStepIndex, 20)
}

async function testResumeRejectionKeepsPausedTask() {
  const manager = new TaskManager(createBot(), { debug: false })
  const paused = task('build_blueprint', {
    id: 41,
    checkpoint: { currentStepIndex: 441 }
  })
  paused.state = 'PAUSED'
  paused.manualPause = true
  paused.currentStepIndex = 441
  manager.pausedStack.push(paused)
  manager.currentTask = task('guard_player', { id: 42 })

  const rejected = await manager.resumePaused('survival_recovered', { taskId: paused.id })
  assert.strictEqual(rejected, false)
  assert.strictEqual(manager.pausedStack.length, 1)
  assert.strictEqual(manager.pausedStack[0], paused)

  manager.currentTask = null
  const resumed = await manager.resumePaused('survival_recovered', { taskId: paused.id })
  assert.strictEqual(resumed, true)
  assert.strictEqual(manager.currentTask, paused)
  assert.strictEqual(manager.currentTask.currentStepIndex, 441)
  assert.strictEqual(manager.pausedStack.length, 0)
}

async function testReturnToBaseGate() {
  const priority = new TaskPriorityManager()
  const returnTask = task('return_to_base', {
    source: 'survival_system',
    priority: 8,
    params: { reason: 'inventory_full' }
  })
  // 非紧急的 survival 撤退现在落 HIGH（原为 LOW）：离家太远/背包满该压过挖矿，
  // 但仍压不过战斗（CRITICAL）。旧断言写于 isHighSurvivalTask 排除 return_* 的年代。
  assert.strictEqual(priority.priorityForTask(returnTask).name, 'HIGH')
  // 非 survival 来源的 return_to_base 仍然是 LOW，玩家指令路径不受影响。
  assert.strictEqual(priority.priorityForTask(task('return_to_base', { source: 'player_command', priority: 8 })).name, 'LOW')

  const resolver = new TaskConflictResolver({ priorityManager: priority })
  const result = resolver.resolveConflict(task('build_blueprint'), returnTask)
  assert.strictEqual(result.action, DECISIONS.QUEUE)

  TASK_TYPES.hold_build = class HoldBuildTask extends HoldTask {
    constructor(options) {
      super({ ...options, type: 'hold_build', requiredLocks: ['building'] })
    }
  }
  TASK_TYPES.return_marker = class ReturnMarkerTask extends CompleteTask {
    constructor(options) {
      super({ ...options, type: 'return_marker', requiredLocks: ['movement'] })
    }
  }

  const manager = new TaskManager(createBot(), { debug: false })
  manager.enqueue('hold_build', {}, 5, 'player_command')
  await manager.tick()
  assert.strictEqual(manager.currentTask.type, 'hold_build')

  manager.enqueue('return_marker', { arbitrationPriority: 'LOW' }, 8, 'survival_system')
  await manager.tick()
  assert.strictEqual(manager.currentTask.type, 'hold_build')
  assert.strictEqual(manager.queue[0].type, 'return_marker')

  await manager.currentTask.complete(manager.createContext(), { ok: true })
  await manager.tick()
  await manager.tick()
  assert.strictEqual(manager.completed.some(entry => entry.type === 'return_marker'), true)
}

// 改动前这个用例的两半都是 QUEUE（复现"打架时撤退会被排队"）。
// 改动后只有"params 为空"的那半保持 QUEUE —— survival-system 现在不会再发空 params。
async function testEmergencyRetreatPreemptsCombat() {
  const resolver = new TaskConflictResolver()
  const combat = () => task('guard_player', { id: 1, source: 'survival_system', priority: 9 })

  const emptyParams = resolver.resolveConflict(combat(), task('return_to_base', {
    id: 2,
    source: 'survival_system',
    priority: 8,
    params: {}
  }))
  assert.strictEqual(emptyParams.action, DECISIONS.QUEUE)
  assert.strictEqual(emptyParams.reason, 'incoming_priority_not_higher')

  const emergency = resolver.resolveConflict(combat(), task('return_to_base', {
    id: 3,
    source: 'survival_system',
    priority: 8,
    params: { reason: 'CRITICAL_HEALTH', critical: true }
  }))
  assert.strictEqual(emergency.action, DECISIONS.FORCE_PREEMPT)
  assert.strictEqual(emergency.force, true)
  assert.strictEqual(emergency.incomingPriority.name, 'EMERGENCY')
  assert.strictEqual(emergency.currentPriority.name, 'CRITICAL')
}

async function testEmergencyEatPreemptsCombat() {
  const resolver = new TaskConflictResolver()
  const result = resolver.resolveConflict(
    task('fight_nearby_mob', { id: 1, source: 'survival_system', priority: 9 }),
    task('eat_food', { id: 2, source: 'survival_system', priority: 10, params: { reason: 'LOW_FOOD_CRITICAL', critical: true } })
  )
  assert.strictEqual(result.action, DECISIONS.FORCE_PREEMPT)
  assert.strictEqual(result.incomingPriority.name, 'EMERGENCY')

  // 非紧急的进食（食物只是偏低）仍然是 HIGH，压不过战斗。
  const warning = resolver.resolveConflict(
    task('fight_nearby_mob', { id: 3, source: 'survival_system', priority: 9 }),
    task('eat_food', { id: 4, source: 'survival_system', priority: 10, params: { reason: 'LOW_FOOD_WARNING' } })
  )
  assert.strictEqual(warning.action, DECISIONS.QUEUE)
  assert.strictEqual(warning.incomingPriority.name, 'HIGH')
}

async function testNonUrgentRetreatStillQueuesDuringCombat() {
  const resolver = new TaskConflictResolver()
  const result = resolver.resolveConflict(
    task('guard_player', { id: 1, source: 'survival_system', priority: 9 }),
    task('return_to_base', { id: 2, source: 'survival_system', priority: 8, params: { reason: 'TOO_FAR_FROM_BASE' } })
  )
  assert.strictEqual(result.action, DECISIONS.QUEUE)
  assert.strictEqual(result.incomingPriority.name, 'HIGH')
  assert.strictEqual(result.currentPriority.name, 'CRITICAL')
}

async function testNonUrgentRetreatPausesMining() {
  const resolver = new TaskConflictResolver()
  const result = resolver.resolveConflict(
    task('mining', { id: 1, source: 'ai', priority: 5 }),
    task('return_to_base', { id: 2, source: 'survival_system', priority: 8, params: { reason: 'TOO_FAR_FROM_BASE' } })
  )
  assert.strictEqual(result.action, DECISIONS.PAUSE_CURRENT)
  assert.strictEqual(result.incomingPriority.name, 'HIGH')
  assert.strictEqual(result.currentPriority.name, 'MEDIUM')
  assert.strictEqual(result.lockConflict, true)
}

async function testSleepIsIdleTier() {
  const priority = new TaskPriorityManager()
  assert.strictEqual(priority.priorityForTask(task('sleep')).name, 'LOW')

  const resolver = new TaskConflictResolver({ priorityManager: priority })
  const miningWins = resolver.resolveConflict(task('sleep', { id: 1 }), task('mining', { id: 2 }))
  assert.strictEqual(miningWins.action, DECISIONS.PAUSE_CURRENT)

  const sleepLoses = resolver.resolveConflict(task('mining', { id: 3 }), task('sleep', { id: 4 }))
  assert.strictEqual(sleepLoses.action, DECISIONS.QUEUE)
}

// 给CC.md 4.1：isReturnToBaseBlockedByActiveBuild 是故意设计，不改。
// 这里只证明它确实会拦住紧急撤退，以及它自带的逃生口（params.critical）能放行 ——
// 后者正是 survival-system 现在为 CRITICAL_HEALTH / LOW_FOOD_CRITICAL 带上的标记。
async function testActiveBuildStillDefersRetreatUnlessCriticalFlagged() {
  const resolver = new TaskConflictResolver()
  const build = () => task('build_blueprint', { id: 1, source: 'player_command', priority: 11 })

  const reasonOnly = resolver.resolveConflict(build(), task('return_to_base', {
    id: 2,
    source: 'survival_system',
    priority: 8,
    params: { reason: 'CRITICAL_HEALTH' }
  }))
  assert.strictEqual(reasonOnly.action, DECISIONS.QUEUE)
  assert.strictEqual(reasonOnly.reason, 'return_to_base_deferred_for_building')

  const flagged = resolver.resolveConflict(build(), task('return_to_base', {
    id: 3,
    source: 'survival_system',
    priority: 8,
    params: { reason: 'CRITICAL_HEALTH', critical: true }
  }))
  assert.strictEqual(flagged.action, DECISIONS.FORCE_PREEMPT)
  assert.strictEqual(flagged.incomingPriority.name, 'EMERGENCY')
}

async function testEmergencyTierOrdering() {
  const priority = new TaskPriorityManager()
  assert.strictEqual(PRIORITY_LEVELS.EMERGENCY > PRIORITY_LEVELS.CRITICAL, true)
  // priorityFromNumeric 的 EMERGENCY 分支必须排在 CRITICAL 之前，否则 >=12 会被吞成 CRITICAL
  assert.strictEqual(priority.priorityForTask(task('unmapped_type', { priority: 12 })).name, 'EMERGENCY')
  assert.strictEqual(priority.priorityForTask(task('unmapped_type', { priority: 10 })).name, 'CRITICAL')
  // isCritical 改成 value >= CRITICAL 后，EMERGENCY 仍算 critical
  assert.strictEqual(priority.isCritical(task('guard_player')), true)
  assert.strictEqual(priority.isCritical(task('eat_food', {
    source: 'survival_system',
    priority: 10,
    params: { reason: 'CRITICAL_HEALTH' }
  })), true)
  assert.strictEqual(priority.isCritical(task('mining')), false)

  const sorted = priority.sortTasks([
    task('mining', { id: 1 }),
    task('return_to_base', { id: 2, source: 'survival_system', priority: 8, params: { reason: 'CRITICAL_HEALTH' } }),
    task('guard_player', { id: 3 })
  ])
  assert.deepStrictEqual(sorted.map(entry => entry.type), ['return_to_base', 'guard_player', 'mining'])
}

async function testTaskManagerUsesArbiterForPriority() {
  TASK_TYPES.hold_low = class HoldLowTask extends HoldTask {
    constructor(options) {
      super({ ...options, type: 'hold_low', requiredLocks: ['movement'] })
    }
  }
  TASK_TYPES.complete_medium = class CompleteMediumTask extends CompleteTask {
    constructor(options) {
      super({ ...options, type: 'complete_medium', requiredLocks: ['movement'] })
    }
  }

  const manager = new TaskManager(createBot(), { debug: false })
  manager.enqueue('hold_low', { arbitrationPriority: 'LOW' }, 1, 'test')
  await manager.tick()
  assert.strictEqual(manager.currentTask.type, 'hold_low')
  assert.strictEqual(manager.actionLock.getOwner('movement'), 1)

  manager.enqueue('complete_medium', { arbitrationPriority: 'MEDIUM' }, 5, 'test')
  await manager.tick()
  assert.strictEqual(manager.currentTask, null)
  assert.strictEqual(manager.pausedStack.length, 1)
  assert.strictEqual(manager.completed.at(-1).type, 'complete_medium')
  assert.strictEqual(manager.actionLock.getOwner('movement'), null)

  await manager.tick()
  assert.strictEqual(manager.currentTask.type, 'hold_low')
  assert.strictEqual(manager.actionLock.getOwner('movement'), 1)
}

// 挂起栈与队列必须用同一把尺子。真机第 16 轮：施工（入队序号 11、档位 MEDIUM）在跑，
// 玩家喊「守着我」（入队序号 8、档位 CRITICAL）——maybePreempt 按档位把施工挂起，
// selectNextTask 却按序号把施工又挑回来，80 秒里来回 38 次，守护一次都没轮上。
// Decision #102 (repair 17): a work command that displaced 跟着我 does not
// bring it back by itself (kept on purpose), but says so once it is done.
async function followOfferScenario(nextType, nextPriority) {
  const said = []
  const manager = new TaskManager(createBot(), {
    debug: false,
    enableTaskFeedback: false,
    reminderOutput: text => said.push(text)
  })
  const follow = new HoldTask({ id: 1, type: 'follow_player', priority: 3, source: 'player_command', requiredLocks: ['movement'] })
  manager.queue.push(follow)
  await manager.tick()
  assert.strictEqual(manager.currentTask, follow)

  const next = new CompleteTask({ id: 2, type: nextType, priority: nextPriority, source: 'player_command', requiredLocks: locksForType(nextType) })
  manager.queue.push(next)
  for (let i = 0; i < 4; i++) await manager.tick()
  return { manager, follow, next, said }
}

async function testWorkCommandFinishingOffersToResumeFollow() {
  const { manager, follow, next, said } = await followOfferScenario('mining', 4)
  assert.strictEqual(next.state, TASK_STATE.COMPLETED)
  assert.strictEqual(follow.state, TASK_STATE.PAUSED, 'the follow stays parked (no auto-resume)')
  assert.strictEqual(follow.manualPause, true)
  assert.ok(manager.pausedStack.includes(follow))
  assert.deepStrictEqual(said, ['挖矿干完了，要我继续跟着你吗'])
}

async function testGuardFinishingDoesNotOfferToResumeFollow() {
  const { follow, next, said } = await followOfferScenario('guard_player', 8)
  assert.strictEqual(next.state, TASK_STATE.COMPLETED)
  assert.strictEqual(follow.state, TASK_STATE.PAUSED)
  assert.deepStrictEqual(said, [], 'after 守着我 the line is not said (task-book rule)')
}

async function testFightFinishingResumesFollowWithoutOffer() {
  const { manager, follow, next, said } = await followOfferScenario('fight_nearby_mob', 8)
  assert.strictEqual(next.state, TASK_STATE.COMPLETED)
  assert.strictEqual(manager.currentTask, follow, 'a critical preempt hands the follow back by itself')
  assert.strictEqual(follow.state, TASK_STATE.RUNNING)
  assert.deepStrictEqual(said, [])
}

async function testCriticalQueuedTaskBeatsHigherNumberedPausedTask() {
  TASK_TYPES.hold_medium_high_number = class HoldMediumHighNumberTask extends HoldTask {
    constructor(options) {
      super({ ...options, type: 'hold_medium_high_number', requiredLocks: ['movement'] })
    }
  }
  TASK_TYPES.hold_critical_low_number = class HoldCriticalLowNumberTask extends HoldTask {
    constructor(options) {
      super({ ...options, type: 'hold_critical_low_number', requiredLocks: ['movement'] })
    }
  }

  const logs = []
  const manager = new TaskManager(createBot(), { debug: false, enableTaskFeedback: false })
  manager.debug = message => logs.push(message)

  manager.enqueue('hold_medium_high_number', { arbitrationPriority: 'MEDIUM' }, 11, 'player_command')
  await manager.tick()
  assert.strictEqual(manager.currentTask.type, 'hold_medium_high_number')

  manager.enqueue('hold_critical_low_number', { arbitrationPriority: 'CRITICAL' }, 8, 'player_command')
  await manager.tick()

  assert.strictEqual(manager.currentTask.type, 'hold_critical_low_number')
  assert.strictEqual(manager.pausedStack.length, 1)
  assert.strictEqual(manager.pausedStack[0].type, 'hold_medium_high_number')

  // 再跑几拍：档位一致之后就不该再有第二次抢占。
  const preemptsAfterHandover = () => logs.filter(line => line.includes('[TASK_PREEMPT]')).length
  const preemptsSoFar = preemptsAfterHandover()
  for (let i = 0; i < 4; i++) await manager.tick()
  assert.strictEqual(manager.currentTask.type, 'hold_critical_low_number')
  assert.strictEqual(preemptsAfterHandover(), preemptsSoFar)

  delete TASK_TYPES.hold_medium_high_number
  delete TASK_TYPES.hold_critical_low_number
}

// 同一根因的另一面（看板疑点：RETURN_TO_BASE 档位 LOW、入队序号却给到 8）：
// 一条 LOW 的回家不该插到挂起栈上那条 MEDIUM 的常规活前面。
async function testLowLadderReturnDoesNotJumpPausedMediumTask() {
  const manager = new TaskManager(createBot(), { debug: false, enableTaskFeedback: false })
  const farming = task('farming', { id: 50, priority: 5, source: 'player_command' })
  farming.state = 'PAUSED'
  manager.pausedStack.push(farming)
  manager.taskArbiter.prepareTask(farming)

  manager.enqueue('return_to_base', { range: 2 }, 8, 'player_command')
  assert.strictEqual(manager.queue.length, 1)
  assert.strictEqual(manager.queue[0].type, 'return_to_base')

  const next = manager.selectNextTask()
  assert.strictEqual(next.type, 'farming')
  assert.strictEqual(manager.queue.length, 1)
}
async function run() {
  await testPriorityPreemption()
  await testConflictResolution()
  await testReturnToBaseCommandUsesArbiterDuringBuild()
  await testTaskManagerLogsReturnToBaseArbiterQueue()
  await testFollowCommandStillInterruptsActiveBuild()
  await testMovementLock()
  await testStateMachine()
  await testBuildingCheckpointResume()
  await testResumeRejectionKeepsPausedTask()
  await testReturnToBaseGate()
  await testEmergencyRetreatPreemptsCombat()
  await testEmergencyEatPreemptsCombat()
  await testNonUrgentRetreatStillQueuesDuringCombat()
  await testNonUrgentRetreatPausesMining()
  await testSleepIsIdleTier()
  await testActiveBuildStillDefersRetreatUnlessCriticalFlagged()
  await testEmergencyTierOrdering()
  await testTaskManagerUsesArbiterForPriority()
  await testCriticalQueuedTaskBeatsHigherNumberedPausedTask()
  await testLowLadderReturnDoesNotJumpPausedMediumTask()
  await testWorkCommandFinishingOffersToResumeFollow()
  await testGuardFinishingDoesNotOfferToResumeFollow()
  await testFightFinishingResumesFollowWithoutOffer()
  console.log('task arbitration tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
