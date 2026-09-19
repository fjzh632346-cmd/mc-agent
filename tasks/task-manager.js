const { ActionLock } = require('../core/action-lock')
const { observe } = require('../perception/world-state')
const { FollowTask } = require('./follow-task')
const { MineNearbyBlockTask } = require('./mine-nearby-block-task')
const { FightNearbyMobTask } = require('./fight-nearby-mob-task')
const { MiningTask } = require('./mining-task')
const { GuardPlayerTask } = require('./guard-player-task')
const { ReturnToPlayerTask } = require('./return-to-player-task')
const { ReturnToBaseTask } = require('./return-to-base-task')
const { SleepTask } = require('./sleep-task')
const { CraftTask } = require('./craft-task')
const { EatTask } = require('./eat-task')
const { SmeltTask } = require('./smelt-task')
const { BuildTask } = require('./build-task')
const { ExplorationTask } = require('./exploration-task')
const { FarmingTask } = require('./farming-task')
const { StorageTask } = require('./storage-task')
const { PrepareCombatTask } = require('./prepare-combat-task')
const { EquipArmorTask } = require('./equip-armor-task')
const { PickupItemTask } = require('./pickup-item-task')
const { TASK_STATE } = require('./base-task')
const { createTaskReminderEvent, defaultReminderText, friendlyTaskName, generateReminderMessage } = require('../ai/message-generator')
const { stopMovement } = require('../actions/move')
const { getInventorySummary } = require('../actions/inventory')
const { buildSleepState } = require('../utils/sleep')
const { getChineseItemName } = require('../utils/item-names')
const { UtilityBlockSearch } = require('../systems/UtilityBlockSearch')
const { TaskArbiter } = require('../systems/task-arbitration')

const TASK_TYPES = {
  follow_player: FollowTask,
  mine_nearby_block: MineNearbyBlockTask,
  fight_nearby_mob: FightNearbyMobTask,
  mining: MiningTask,
  guard_player: GuardPlayerTask,
  return_to_player: ReturnToPlayerTask,
  return_to_base: ReturnToBaseTask,
  sleep: SleepTask,
  craft_item: CraftTask,
  eat_food: EatTask,
  smelt_item: SmeltTask,
  build_blueprint: BuildTask,
  exploration: ExplorationTask,
  farming: FarmingTask,
  storage: StorageTask,
  prepare_combat: PrepareCombatTask,
  equip_armor: EquipArmorTask,
  pickup_item: PickupItemTask
}

const FOLLOW_PREEMPTING_PLAYER_TASKS = new Set([
  'farming',
  'storage',
  'exploration',
  'sleep',
  'mining',
  'mine_nearby_block',
  'craft_item',
  'smelt_item',
  'pickup_item',
  'build_blueprint',
  'return_to_player',
  'return_to_base',
  'guard_player',
  'eat_food',
  'prepare_combat',
  'equip_armor'
])

// 干完这些不问「要不要继续跟」：任务书口径是「守着我」那种不问（见 offerFollowResume）。
const FOLLOW_RESUME_OFFER_EXCLUDED = new Set(['guard_player', 'fight_nearby_mob'])

class TaskManager {
  constructor(bot, options = {}) {
    this.bot = bot
    this.options = {
      enabled: process.env.TASKS_ENABLED !== 'false',
      tickMs: Number(process.env.TASKS_TICK_MS || 1000),
      debug: process.env.TASKS_DEBUG !== 'false',
      ...options
    }
    this.actionLock = options.actionLock || new ActionLock()
    this.taskArbiter = options.taskArbiter || new TaskArbiter({
      actionLock: this.actionLock,
      logger: options.logger || null
    })
    this.taskArbiter.setActionLock(this.actionLock)
    this.taskMemory = options.taskMemory || null
    this.queue = []
    this.currentTask = null
    this.pausedStack = []
    this.completed = []
    this.failed = []
    this.blocked = []
    this.interrupted = []
    this.utilityBlockSearch = options.utilityBlockSearch || new UtilityBlockSearch(options.utilitySearchConfig || {})
    this.timer = null
    this.nextId = 1
    this.isTicking = false
  }

  get current() {
    return this.currentTask
  }

  set current(task) {
    this.currentTask = task
  }

  start() {
    if (!this.options.enabled || this.timer) return
    this.timer = setInterval(() => this.tick().catch(err => this.debug(`[TaskManager] tick error: ${err.message}`)), this.options.tickMs)
    this.debug('[TaskManager] started')
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.currentTask) {
      this.currentTask.interrupt(this.createContext(), 'manager_stop').catch(() => {})
      this.currentTask = null
    }
    this.pausedStack = []
    stopMovement(this.bot, 'manager_stop', null)
    this.actionLock = new ActionLock()
    this.taskArbiter.setActionLock(this.actionLock)
    this.debug('[TaskManager] stopped')
  }

  debug(message) {
    if (this.options.debug) console.log(message)
  }

  createContext(externalContext = {}) {
    const blackboard = externalContext.blackboard || this.options.blackboard || null
    const worldState = blackboard?.snapshot?.() || (this.bot.entity ? observe(this.bot) : null)
    return {
      bot: this.bot,
      taskManager: this,
      actionLock: this.actionLock,
      taskArbiter: this.taskArbiter,
      worldState,
      world: worldState,
      blackboard,
      equipmentSystem: externalContext.equipmentSystem || this.options.equipmentSystem || null,
      autoPreparationSystem: externalContext.autoPreparationSystem || this.options.autoPreparationSystem || null,
      craftingSystem: externalContext.craftingSystem || this.options.craftingSystem || null,
      smeltingSystem: externalContext.smeltingSystem || this.options.smeltingSystem || null,
      storageSystem: externalContext.storageSystem || this.options.storageSystem || null,
      utilityBlockSearch: externalContext.utilityBlockSearch || this.options.utilityBlockSearch || this.utilityBlockSearch,
      feedbackCooldown: externalContext.feedbackCooldown || this.options.feedbackCooldown || null,
      messageGenerator: externalContext.messageGenerator || this.options.messageGenerator || null,
      reminderOutput: externalContext.reminderOutput || this.options.reminderOutput || null,
      persona: externalContext.persona || this.options.persona || null,
      memory: externalContext.memory || this.options.memory || null,
      logger: externalContext.logger || this.options.logger || console,
      debug: message => this.debug(message)
    }
  }

  createTask(type, params = {}, priority = 5, source = 'ai') {
    this.debug(`[TASK_CREATE_ATTEMPT] ${JSON.stringify({ type, params, priority, source })}`)
    const TaskClass = TASK_TYPES[type]
    if (!TaskClass) throw new Error(`unknown task type: ${type}`)
    const task = new TaskClass({
      id: this.nextId++,
      type,
      params,
      priority,
      source
    })
    this.taskArbiter.prepareTask(task)
    this.debug(`[TASK_CREATED] ${JSON.stringify(task.toJSON())}`)
    return task
  }

  enqueue(type, params = {}, priority = 5, source = 'ai') {
    const survivalGate = this.options.survivalSystem?.shouldBlockNewTask?.(type, params, source)
    if (survivalGate && !survivalGate.ok) {
      const blocked = {
        id: null,
        type,
        params,
        priority,
        source,
        state: 'BLOCKED',
        blocked: true,
        error: survivalGate.reason
      }
      this.debug(`[TASK_BLOCKED_BY_SURVIVAL] ${JSON.stringify(blocked)}`)
      return blocked
    }
    const task = this.createTask(type, params, priority, source)
    const arbitration = this.taskArbiter.requestExecution(task, {
      currentTask: this.currentTask,
      queue: this.queue,
      pausedStack: this.pausedStack,
      source
    })
    if (!arbitration.ok) {
      const blocked = {
        ...task.toJSON(),
        state: TASK_STATE.BLOCKED,
        blocked: true,
        error: arbitration.reason
      }
      this.blocked.push(blocked)
      this.debug(`[TASK_BLOCKED_BY_ARBITER] ${JSON.stringify(blocked)}`)
      return blocked
    }
    if (this.currentTask && arbitration.shouldQueue) {
      this.debug(`[TASK_ARBITRATION_QUEUE] current=${this.currentTask.type} incoming=${task.type} reason=${arbitration.reason}`)
    }
    this.queue.push(task)
    this.sortQueue()
    this.debug(`[TASK_ENQUEUED] ${JSON.stringify(task.toJSON())}`)
    this.debug(`[task-manager] enqueue task=${type} id=${task.id} reason=${source} params=${JSON.stringify(params)}`)
    this.debug(`[TaskManager] queued #${task.id} ${task.type} priority=${task.priority}`)
    return task.toJSON()
  }

  sortQueue() {
    this.queue.sort((a, b) => this.taskArbiter.compareTasks(a, b))
  }

  async maybePreempt(ctx) {
    if (!this.currentTask || this.queue.length === 0) return
    this.sortQueue()
    const next = this.queue[0]
    const arbitration = this.taskArbiter.resolveConflict(this.currentTask, next)
    if (!arbitration.preempt) {
      if (arbitration.lockConflict) {
        this.debug(`[TASK_ARBITRATION_QUEUE] current=${this.currentTask.type} incoming=${next.type} reason=${arbitration.reason}`)
      }
      return
    }

    const paused = this.currentTask
    const preemptReason = arbitration.reason || `preempted_by:${next.type}#${next.id}`
    const logTarget = next.type
    this.debug(`[TASK_PREEMPT] from=${paused.type} to=${logTarget} reason=${next.source || 'priority'}`)
    await paused.pause(ctx, preemptReason)
    stopMovement(this.bot, preemptReason, paused.id)
    this.taskArbiter.markPaused(paused, preemptReason, taskCheckpoint(paused))
    if (paused.type === 'follow_player' && FOLLOW_PREEMPTING_PLAYER_TASKS.has(next.type)) {
      paused.manualPause = true
    }
    if (paused.resumable) {
      this.pausedStack.push(paused)
      this.debug(`[TASK_PAUSED] taskId=${paused.id}`)
    } else {
      this.interrupted.push(paused.toJSON())
    }
    this.debug(`[TaskManager] preempted #${paused.id} ${paused.type} for #${next.id} ${next.type}`)
    this.currentTask = null
  }

  async startNext(ctx) {
    if (this.currentTask) return
    this.sortQueue()
    const task = this.selectNextTask()
    if (!task) return
    const survivalGate = this.options.survivalSystem?.canStartTask?.(task)
    if (survivalGate && !survivalGate.ok) {
      this.blocked.push({ ...task.toJSON(), state: TASK_STATE.BLOCKED, error: survivalGate.reason, blockedReason: survivalGate.reason })
      this.taskArbiter.markBlocked(task, survivalGate.reason)
      this.debug(`[TASK_START_BLOCKED_BY_SURVIVAL] taskId=${task.id} type=${task.type} reason=${survivalGate.reason}`)
      return
    }
    const arbitration = this.taskArbiter.requestExecution(task, {
      currentTask: null,
      queue: this.queue,
      pausedStack: this.pausedStack
    })
    if (!arbitration.ok) {
      this.blocked.push({ ...task.toJSON(), state: TASK_STATE.BLOCKED, error: arbitration.reason, blockedReason: arbitration.reason })
      this.taskArbiter.markBlocked(task, arbitration.reason)
      this.debug(`[TASK_START_BLOCKED_BY_ARBITER] taskId=${task.id} type=${task.type} reason=${arbitration.reason}`)
      return
    }
    this.currentTask = task

    if ([TASK_STATE.PAUSED, TASK_STATE.INTERRUPTED].includes(task.state)) {
      task.manualPause = false
      await task.resume(ctx)
      this.taskArbiter.markActive(task)
      this.debug(`[TASK_RESUMED] taskId=${task.id}`)
    } else {
      await task.start(ctx)
      this.taskArbiter.markActive(task)
    }
    this.debug(`[TASK_STARTED] ${JSON.stringify(task.toJSON())}`)
    this.debug(`[task-manager] start task=${task.type} id=${task.id} reason=${task.source || 'queue'}`)
  }

  selectNextTask() {
    const queued = this.queue[0] || null
    const paused = findLastResumablePaused(this.pausedStack)

    // 按仲裁档位比，不要按入队序号比。maybePreempt 是按档位把当前任务挂起的，
    // 这里再按序号挑，两边对同一对任务会给出相反的答案，于是每一 tick 挂起一次、
    // 恢复一次，谁也干不成：真机上「守着我」（CRITICAL、序号 8）遇上在跑的施工
    // （MEDIUM、序号 11），80 秒里来回 38 次，守护一次都没轮上。
    if (queued && (!paused || this.taskArbiter.compareTasks(queued, paused) < 0)) {
      return this.queue.shift()
    }
    if (paused) return removePausedTask(this.pausedStack, paused)
    if (queued) return this.queue.shift()
    return null
  }

  async update(context = {}) {
    return this.tick(context)
  }

  async tick(context = {}) {
    if (this.isTicking || !this.bot.entity) return
    this.isTicking = true
      const ctx = this.createContext(context)

    try {
      await this.processSurvival(ctx)
      await this.maybePreempt(ctx)
      await this.startNext(ctx)
      if (!this.currentTask) return

      const activeTask = this.currentTask
      this.debug(`[TASK_TICK] ${JSON.stringify(activeTask.toJSON())}`)
      await activeTask.update(ctx)
      if (this.currentTask !== activeTask) return

      if (this.currentTask.state === TASK_STATE.COMPLETED) {
        const finishedTask = this.currentTask
        this.completed.push(finishedTask.toJSON())
        this.taskArbiter.markCompleted(finishedTask, { result: finishedTask.result })
        this.recordTaskMemory(finishedTask, 'completed')
        this.debug(`[task-manager] complete task=${finishedTask.type} id=${finishedTask.id} reason=ok`)
        this.debug(`[TaskManager] completed #${finishedTask.id} ${finishedTask.type}`)
        this.currentTask = null
        ctx.blackboard?.update?.({ tasks: this.getTaskSnapshot() })
        this.emitTaskFeedback(ctx, finishedTask, 'completed')
        this.offerFollowResume(ctx, finishedTask)
      } else if (this.currentTask.state === TASK_STATE.FAILED) {
        const finishedTask = this.currentTask
        this.failed.push(finishedTask.toJSON())
        this.taskArbiter.markFailed(finishedTask, finishedTask.error || 'failed')
        this.recordTaskMemory(finishedTask, 'failed')
        this.debug(`[task-manager] fail task=${finishedTask.type} id=${finishedTask.id} reason=${finishedTask.error || 'failed'}`)
        this.debug(`[TaskManager] failed #${finishedTask.id} ${finishedTask.type}`)
        this.currentTask = null
        ctx.blackboard?.update?.({ tasks: this.getTaskSnapshot() })
        this.emitTaskFeedback(ctx, finishedTask, 'failed')
      } else if (this.currentTask.state === TASK_STATE.BLOCKED) {
        const blockedTask = this.currentTask
        this.blocked.push(blockedTask.toJSON())
        this.taskArbiter.markBlocked(blockedTask, blockedTask.blockedReason || blockedTask.error || 'blocked')
        this.debug(`[TaskManager] blocked #${blockedTask.id} ${blockedTask.type}`)
        this.currentTask = null
      } else if (this.currentTask.state === TASK_STATE.INTERRUPTED) {
        const interrupted = this.currentTask
        if (interrupted.resumable) {
          this.pausedStack.push(interrupted)
          this.debug(`[TaskManager] parked interrupted #${interrupted.id} ${interrupted.type}`)
        } else {
          this.interrupted.push(interrupted.toJSON())
          this.recordTaskMemory(interrupted, 'interrupted')
          await this.emitTaskFeedback(ctx, interrupted, 'interrupted')
          this.debug(`[TaskManager] interrupted #${interrupted.id} ${interrupted.type}`)
        }
        this.currentTask = null
      }
    } finally {
      ctx.blackboard?.update?.({ tasks: this.getTaskSnapshot() })
      this.isTicking = false
    }
  }

  async processSurvival(ctx) {
    const survivalSystem = this.options.survivalSystem
    if (!survivalSystem || this.options.enableSurvivalSystem === false) return
    try {
      ctx.blackboard?.set?.('tasks.currentTask', this.currentTask ? this.currentTask.toJSON() : null)
      const state = survivalSystem.evaluateSurvivalState(ctx)
      await survivalSystem.ensureArmorForRisk?.(ctx, state)
      await survivalSystem.releaseObsoleteReturn?.(ctx, state)
      const decision = survivalSystem.createSurvivalPlan(ctx, state)
      if (decision.priority && decision.priority !== 'NORMAL') {
        await survivalSystem.applySurvivalDecision(ctx, decision)
      } else {
        await survivalSystem.resumeIfSafe?.(ctx)
        await survivalSystem.craftMissingBasicTools?.(ctx)
      }
    } catch (err) {
      this.debug(`[SURVIVAL_PROCESS_ERROR] ${err.message}`)
    }
  }

  async interruptCurrent(reason = 'manual_interrupt') {
    const task = this.currentTask || removeLastPausedTask(this.pausedStack)
    this.debug(`[TASK_INTERRUPT_ATTEMPT] taskId=${task?.id ?? 'none'}`)
    if (!task) return false
    task.resumable = false
    await task.interrupt(this.createContext(), reason)
    stopMovement(this.bot, reason, task.id)
    this.interrupted.push(task.toJSON())
    this.recordTaskMemory(task, 'interrupted')
    await this.emitTaskFeedback(this.createContext(), task, 'interrupted')
    if (this.currentTask === task) this.currentTask = null
    this.debug(`[TASK_INTERRUPTED] taskId=${task.id}`)
    return true
  }

  async interruptTaskByType(type, reason = 'manual_interrupt') {
    const task = this.currentTask?.type === type
      ? this.currentTask
      : (removeLastPausedTaskByType(this.pausedStack, type) || removeLastQueuedTaskByType(this.queue, type))
    this.debug(`[TASK_INTERRUPT_ATTEMPT] taskId=${task?.id ?? 'none'} type=${type}`)
    if (!task) return false
    task.resumable = false
    await task.interrupt(this.createContext(), reason)
    stopMovement(this.bot, reason, task.id)
    this.interrupted.push(task.toJSON())
    this.recordTaskMemory(task, 'interrupted')
    await this.emitTaskFeedback(this.createContext(), task, 'interrupted')
    if (this.currentTask === task) this.currentTask = null
    this.debug(`[TASK_INTERRUPTED] taskId=${task.id}`)
    return true
  }

  // 外因终止（修缮 17）：她死了，手上的和挂起栈上的任务全部作废，每条都走
  // BaseTask.interrupt 那条终态路（放锁 + 封 owner，修缮 15 的口径）。
  // 不给每条任务单独说一句——复活那句话统一交代。队列里还没开始的不动：
  // 那是玩家排下的话，她复活后照排。
  async abortAllForDeath(reason = 'bot_died') {
    const ctx = this.createContext()
    const tasks = [this.currentTask, ...this.pausedStack].filter(Boolean)
    this.currentTask = null
    this.pausedStack = []
    const dropped = []
    for (const task of tasks) {
      task.resumable = false
      task.manualPause = false
      try {
        await task.interrupt(ctx, reason)
      } catch (err) {
        // 子类的收尾抛了也要把锁封死，否则又是第 15 轮那种占死。
        this.debug(`[TaskManager] interrupt on death failed task=${task.type}#${task.id} error=${err.message}`)
        task.state = TASK_STATE.INTERRUPTED
        task.interruptReason = reason
        this.actionLock.releaseAll?.(task.id)
        this.actionLock.markOwnerTerminated?.(task.id, `interrupted:${reason}`)
      }
      this.interrupted.push(task.toJSON())
      this.recordTaskMemory(task, 'interrupted')
      dropped.push(task)
      this.debug(`[TASK_INTERRUPTED] taskId=${task.id} type=${task.type} reason=${reason}`)
    }
    stopMovement(this.bot, reason, null)
    ctx.blackboard?.update?.({ tasks: this.getTaskSnapshot() })
    return dropped
  }

  async pauseCurrent(reason = 'manual_pause') {
    this.debug(`[TASK_PAUSE_ATTEMPT] taskId=${this.currentTask?.id ?? 'none'}`)
    if (!this.currentTask) return false
    await this.currentTask.pause(this.createContext(), reason)
    stopMovement(this.bot, reason, this.currentTask.id)
    this.currentTask.manualPause = true
    this.pausedStack.push(this.currentTask)
    this.taskArbiter.markPaused(this.currentTask, reason, taskCheckpoint(this.currentTask))
    this.debug(`[TASK_PAUSED] taskId=${this.currentTask.id}`)
    this.currentTask = null
    return true
  }

  async resumePaused(reason = 'manual_resume', options = {}) {
    const task = options.taskId != null
      ? findManualPausedTaskById(this.pausedStack, options.taskId)
      : findLastManualPausedTask(this.pausedStack)
    const checkpoint = taskCheckpoint(task)
    const attempt = {
      taskId: task?.id ?? options.taskId ?? null,
      taskType: task?.type ?? options.taskType ?? null,
      previousPauseReason: task?.pauseReason || null,
      checkpoint
    }
    this.debug(`[TASK_RESUME_ATTEMPT] ${JSON.stringify(attempt)}`)

    if (!task) {
      this.debug(`[TASK_RESUME_RESULT] ${JSON.stringify({ ...attempt, status: 'missing_task', reason: 'missing_paused_task' })}`)
      return false
    }
    if (this.currentTask) {
      this.debug(`[TASK_RESUME_RESULT] ${JSON.stringify({
        ...attempt,
        status: 'rejected',
        reason: 'current_task_active',
        currentTaskId: this.currentTask.id,
        currentTaskType: this.currentTask.type
      })}`)
      return false
    }
    if (![TASK_STATE.PAUSED, TASK_STATE.INTERRUPTED].includes(task.state)) {
      this.debug(`[TASK_RESUME_RESULT] ${JSON.stringify({
        ...attempt,
        status: 'rejected',
        reason: `invalid_paused_task_state:${task.state}`
      })}`)
      return false
    }

    removePausedTask(this.pausedStack, task)
    task.manualPause = false
    this.currentTask = task
    const ctx = this.createContext({ resumeReason: reason })
    try {
      await task.resume(ctx)
      this.taskArbiter.markActive(task)
    } catch (err) {
      task.manualPause = true
      task.state = TASK_STATE.PAUSED
      task.pauseReason = attempt.previousPauseReason || reason
      this.currentTask = null
      this.pausedStack.push(task)
      this.taskArbiter.markPaused(task, task.pauseReason, checkpoint)
      this.debug(`[TASK_RESUME_RESULT] ${JSON.stringify({
        ...attempt,
        status: 'rejected',
        reason: `resume_failed:${err.message}`
      })}`)
      return false
    }

    this.debug(`[TASK_RESUMED] taskId=${task.id}`)
    this.debug(`[TASK_RESUME_RESULT] ${JSON.stringify({
      ...attempt,
      status: 'resumed',
      reason,
      checkpointAfterResume: taskCheckpoint(task)
    })}`)
    return true
  }

  getTaskSnapshot() {
    return {
      currentTask: this.currentTask ? this.currentTask.toJSON() : null,
      queue: this.queue.map(task => task.toJSON()),
      pausedStack: this.pausedStack.map(task => task.toJSON()),
      blocked: this.blocked.slice(-10),
      locks: this.actionLock.getStatus()
    }
  }

  recordTaskMemory(task, status) {
    if (!this.taskMemory) return
    try {
      if (status === 'completed') this.taskMemory.recordCompleted(task)
      else if (status === 'failed') this.taskMemory.recordFailed(task)
      else if (status === 'interrupted') this.taskMemory.recordInterrupted(task)
    } catch (err) {
      this.debug(`[TaskManager] task memory write failed: ${err.message}`)
    }
  }

  emitTaskFeedback(ctx, task, status) {
    if (this.options.enableTaskFeedback === false) return
    const cooldown = ctx.feedbackCooldown || this.options.feedbackCooldown
    const key = `task_${task.type}_${status}`
    if (cooldown && !cooldown.canEmit(key)) return
    const directText = directTaskFeedback(task, status)
    if (directText) {
      if (ctx.reminderOutput) ctx.reminderOutput(directText)
      else if (this.options.enableChatFeedback && ctx.bot?.chat) ctx.bot.chat(directText)
      return
    }
    const event = createTaskReminderEvent(task, status, { logger: ctx.logger, position: ctx.bot?.entity?.position || null })
    const generated = {
      ok: true,
      text: defaultReminderText(event, ctx.persona),
      source: 'fallback',
      event
    }
    const text = generated.text || event.fallbackText || event.meaning
    const payload = { event, generated: { ...generated, text } }

    try {
      ctx.blackboard?.set?.('messages.lastTaskFeedback', payload)
    } catch {}

    try {
      if (ctx.reminderOutput) {
        ctx.reminderOutput(text, event, generated)
      } else if (this.options.enableChatFeedback && ctx.bot?.chat) {
        ctx.bot.chat(text)
      }
    } catch (err) {
      this.debug(`[TaskManager] task feedback output failed: ${err.message}`)
    }

    this.generateTaskFeedbackInBackground(ctx, event, task, status)
  }

  // 决策 #102（修缮 17）：工作命令把「跟着我」顶下去之后不自动接回（取舍保留），
  // 但干完要说一句。只在那条跟随还以 manualPause 挂着、且干完的是工作命令
  // （不是守护/战斗）时说；只说一句话，不动挂起/恢复逻辑。
  offerFollowResume(ctx, finishedTask) {
    if (!finishedTask || !FOLLOW_PREEMPTING_PLAYER_TASKS.has(finishedTask.type)) return null
    if (FOLLOW_RESUME_OFFER_EXCLUDED.has(finishedTask.type)) return null
    const follow = this.pausedStack.find(task => task?.type === 'follow_player' && task.manualPause === true)
    if (!follow) return null
    const text = `${friendlyTaskName(finishedTask.type)}干完了，要我继续跟着你吗`
    this.debug(`[FOLLOW_RESUME_OFFER] followTaskId=${follow.id} finished=${finishedTask.type}#${finishedTask.id}`)
    try {
      if (ctx.reminderOutput) ctx.reminderOutput(text)
      else if (this.options.enableChatFeedback && ctx.bot?.chat) ctx.bot.chat(text)
    } catch (err) {
      this.debug(`[TaskManager] follow resume offer output failed: ${err.message}`)
    }
    return text
  }

  generateTaskFeedbackInBackground(ctx, event, task, status) {
    Promise.resolve()
      .then(() => generateReminderMessage(event, ctx))
      .then(generated => {
        const text = generated?.text
        if (!text) return
        ctx.blackboard?.set?.('messages.lastTaskFeedback.llm', {
          event,
          generated: { ...generated, text },
          task: task.toJSON?.() || task,
          status
        })
      })
      .catch(err => {
        this.debug(`[TaskManager] async task feedback skipped: ${err.code || 'LLM_ERROR'} ${err.message}`)
      })
  }

  status(options = {}) {
    const lightweight = Boolean(options.lightweight || options.acceptance)
    const blackboardSnapshot = this.options.blackboard?.snapshot?.() || null
    const world = blackboardSnapshot || (this.bot.entity ? observe(this.bot) : null)
    const mobs = blackboardSnapshot?.mobs || {}
    const inventory = blackboardSnapshot?.inventory || {}
    const goals = blackboardSnapshot?.goals || null
    const tasks = this.getTaskSnapshot()
    const lastError = findLastError(this.failed, this.interrupted)
    const recentCompleted = this.completed.slice(-5)
    const recentFailed = this.failed.slice(-5)
    const recentBlocked = this.blocked.slice(-5)
    const recentInterrupted = this.interrupted.slice(-5)
    const currentBuildTask = findBuildTask({
      ...tasks,
      recentCompleted,
      recentFailed
    })
    const currentStorageTask = findStorageTask({
      ...tasks,
      recentCompleted,
      recentFailed
    })
    const currentFarmingTask = findFarmingTask({
      ...tasks,
      recentCompleted,
      recentFailed
    })
    const currentExplorationTask = findExplorationTask({
      ...tasks,
      recentCompleted,
      recentFailed
    })
    const currentMovementTask = findMovementTask({
      ...tasks,
      recentCompleted,
      recentFailed
    })
    const foodSummary = summarizeFood(this.bot, blackboardSnapshot)
    const inventoryState = summarizeInventoryState(this.createContext(), inventory)

    if (lightweight) {
      return {
        enabled: this.options.enabled,
        currentTask: tasks.currentTask,
        current: tasks.currentTask,
        queue: tasks.queue,
        pausedStack: tasks.pausedStack,
        locks: tasks.locks,
        activeLocks: tasks.locks,
        recentCompleted,
        recentFailed,
        recentBlocked,
        recentInterrupted,
        lastError,
        dangerLevel: mobs.dangerLevel ?? null,
        nearestHostileMob: mobs.nearestHostileMob ?? null,
        inventoryEmptySlots: inventory.emptySlots ?? null,
        inventoryState,
        goals,
        goalStatus: goals,
        planning: blackboardSnapshot?.planning || null,
        planStatus: blackboardSnapshot?.planning || null,
        currentBuildTask,
        blueprintName: currentBuildTask?.blueprintName || null,
        placedBlocks: currentBuildTask?.placedBlocks ?? null,
        totalBlocks: currentBuildTask?.totalBlocks ?? null,
        buildStatus: currentBuildTask?.buildStatus || null,
        lastBuildError: currentBuildTask?.lastBuildError || null,
        currentStorageTask,
        currentFarmingTask,
        plantedCount: currentFarmingTask?.plantedCount ?? null,
        harvestedItems: currentFarmingTask?.harvestedItems || [],
        madeBreadCount: currentFarmingTask?.madeBreadCount ?? null,
        eatenFood: currentFarmingTask?.eatenFood || null,
        currentMovementTask,
        targetPlayer: currentMovementTask?.targetPlayer || null,
        distanceToPlayer: currentMovementTask?.distanceToPlayer ?? currentExplorationTask?.distanceFromPlayer ?? null,
        pathStatus: currentMovementTask?.pathStatus || null,
        isStuck: currentMovementTask?.isStuck === true,
        currentExplorationTask,
        foodSummary,
        world
      }
    }

    const planning = this.options.planningSystem?.status?.() || blackboardSnapshot?.planning || null
    const memorySummary = this.options.memory?.summary?.() || null
    const goalStatus = goals
    const planStatus = planning
    const knownChestCount = this.options.memory?.world?.summary?.().chestLocations ?? null
    const knownFarmCount = this.options.memory?.world?.summary?.().farmLocations ?? null
    const knownExploredAreaCount = this.options.memory?.world?.summary?.().exploredAreas ?? null
    const knownDiscoveredPlaceCount = this.options.memory?.world?.summary?.().discoveredPlaces ?? this.options.memory?.world?.summary?.().importantPlaces ?? null
    const survival = this.options.survivalSystem?.status?.(this.createContext()) || blackboardSnapshot?.survival || null
    const equipmentSystem = this.options.equipmentSystem
    const equipmentState = equipmentSystem?.getToolStatus?.(this.createContext()) || null
    const armorState = equipmentSystem?.getArmorStatus?.(this.createContext()) || null
    const craftingSystem = this.options.craftingSystem
    const craftingState = craftingSystem?.getCraftingStatus?.(this.createContext(),
      this.currentTask?.type === 'craft_item' && this.currentTask?.plan ? this.currentTask.plan : null
    ) || null
    const utilityState = (this.options.utilityBlockSearch || this.utilityBlockSearch)?.getStatus?.(this.createContext()) || null
    const smeltingSystem = this.options.smeltingSystem
    const smeltingState = smeltingSystem?.getStatus?.(this.createContext(),
      this.currentTask?.type === 'smelt_item' && this.currentTask?.smeltingState ? this.currentTask.smeltingState : null
    ) || (this.currentTask?.type === 'smelt_item' ? this.currentTask.smeltingState : null)
    const sleepState = findSleepState({
      ...tasks,
      recentCompleted: this.completed.slice(-5),
      recentFailed: this.failed.slice(-5)
    }, this.createContext(), survival)

    return {
      enabled: this.options.enabled,
      currentTask: tasks.currentTask,
      current: tasks.currentTask,
      queue: tasks.queue,
      pausedStack: tasks.pausedStack,
      locks: tasks.locks,
      activeLocks: tasks.locks,
      recentCompleted: this.completed.slice(-5),
      recentFailed: this.failed.slice(-5),
      recentBlocked,
      recentInterrupted,
      lastError,
      dangerLevel: mobs.dangerLevel ?? null,
      nearestHostileMob: mobs.nearestHostileMob ?? null,
      inventoryEmptySlots: inventory.emptySlots ?? null,
      inventoryState,
      goals,
      goalStatus,
      planning,
      planStatus,
      currentBuildTask,
      blueprintName: currentBuildTask?.blueprintName || null,
      placedBlocks: currentBuildTask?.placedBlocks ?? null,
      totalBlocks: currentBuildTask?.totalBlocks ?? null,
      clearedBlocks: currentBuildTask?.clearedBlocks ?? null,
      foundationBlocks: currentBuildTask?.foundationBlocks ?? null,
      scaffoldBlocks: currentBuildTask?.scaffoldBlocks ?? null,
      removedScaffoldBlocks: currentBuildTask?.removedScaffoldBlocks ?? null,
      currentBuildStep: currentBuildTask?.currentStepIndex ?? null,
      totalBuildSteps: currentBuildTask?.totalSteps ?? null,
      missingMaterials: currentBuildTask?.missingMaterials || [],
      buildingSitePlan: currentBuildTask?.sitePlan || null,
      buildingMaterialPlan: currentBuildTask?.materialPlan || null,
      buildingOrderPlan: currentBuildTask?.orderPlan || null,
      buildStatus: currentBuildTask?.buildStatus || null,
      lastBuildError: currentBuildTask?.lastBuildError || null,
      currentStorageTask,
      storageMode: currentStorageTask?.mode || null,
      targetChest: currentStorageTask?.targetChest || null,
      itemName: currentStorageTask?.itemName || null,
      storedItems: currentStorageTask?.storedItems || [],
      withdrawnItems: currentStorageTask?.withdrawnItems || [],
      missingItems: currentStorageTask?.missingItems || [],
      storageStatus: currentStorageTask?.storageStatus || null,
      lastStorageError: currentStorageTask?.lastStorageError || null,
      knownChestCount,
      currentFarmingTask,
      farmingMode: currentFarmingTask?.mode || null,
      targetFarm: currentFarmingTask?.targetFarm || null,
      matureWheatCount: currentFarmingTask?.matureWheatCount ?? null,
      plantedCount: currentFarmingTask?.plantedCount ?? null,
      harvestedItems: currentFarmingTask?.harvestedItems || [],
      madeBreadCount: currentFarmingTask?.madeBreadCount ?? null,
      eatenFood: currentFarmingTask?.eatenFood || null,
      missingSeeds: currentFarmingTask?.missingSeeds || false,
      missingWheat: currentFarmingTask?.missingWheat || false,
      farmingStatus: currentFarmingTask?.farmingStatus || null,
      lastFarmingError: currentFarmingTask?.lastFarmingError || null,
      knownFarmCount,
      foodSummary,
      currentMovementTask,
      targetPlayer: currentMovementTask?.targetPlayer || null,
      distanceToPlayer: currentMovementTask?.distanceToPlayer ?? currentExplorationTask?.distanceFromPlayer ?? null,
      pathStatus: currentMovementTask?.pathStatus || null,
      isStuck: currentMovementTask?.isStuck === true,
      isInHole: currentMovementTask?.isInHole === true,
      stuckReason: currentMovementTask?.stuckReason || null,
      recoveryAttempts: currentMovementTask?.recoveryAttempts ?? 0,
      lastRecoveryAction: currentMovementTask?.lastRecoveryAction || null,
      currentExplorationTask,
      explorationMode: currentExplorationTask?.explorationMode || currentExplorationTask?.mode || null,
      centerPosition: currentExplorationTask?.centerPosition || currentExplorationTask?.origin || null,
      ringIndex: currentExplorationTask?.ringIndex ?? null,
      currentSector: currentExplorationTask?.currentSector ?? null,
      directionVector: currentExplorationTask?.directionVector || null,
      checkpointIndex: currentExplorationTask?.checkpointIndex ?? null,
      maxDirectionalDistance: currentExplorationTask?.maxDirectionalDistance ?? null,
      exploredAreasCount: knownExploredAreaCount,
      discoveredPlacesCount: knownDiscoveredPlaceCount,
      recentDiscoveredPlaces: currentExplorationTask?.recentDiscoveredPlaces || currentExplorationTask?.discoveredPlaces?.slice?.(-5) || [],
      origin: currentExplorationTask?.origin || null,
      radius: currentExplorationTask?.radius ?? null,
      currentExploreRadius: currentExplorationTask?.currentExploreRadius ?? null,
      currentTarget: currentExplorationTask?.currentTarget || null,
      targetPosition: currentExplorationTask?.targetPosition || currentExplorationTask?.currentTarget || null,
      targetDistance: currentExplorationTask?.targetDistance ?? null,
      exploredPoints: currentExplorationTask?.exploredPoints || [],
      discoveredPlaces: currentExplorationTask?.discoveredPlaces || [],
      dangerZones: currentExplorationTask?.dangerZones || [],
      distanceFromBase: currentExplorationTask?.distanceFromBase ?? null,
      distanceFromPlayer: currentExplorationTask?.distanceFromPlayer ?? null,
      failedTargetCount: currentExplorationTask?.failedTargetCount ?? null,
      lastFailureReason: currentMovementTask?.lastFailureReason || currentExplorationTask?.lastFailureReason || currentExplorationTask?.lastExplorationError || null,
      safetyState: currentExplorationTask?.safetyState || null,
      explorationStatus: currentExplorationTask?.explorationStatus || null,
      lastExplorationError: currentExplorationTask?.lastExplorationError || null,
      knownExploredAreaCount,
      knownDiscoveredPlaceCount,
      equipmentState,
      armorState,
      craftingState,
      utilityState,
      smeltingState,
      sleepState,
      survivalState: survival?.survivalState || survival?.state || null,
      survivalStatus: survival?.survivalStatus || survival?.state?.survivalPriority || null,
      overallRiskLevel: survival?.overallRiskLevel || survival?.state?.overallRiskLevel || null,
      survivalPriority: survival?.survivalPriority || survival?.state?.survivalPriority || null,
      survivalReason: survival?.survivalReason || survival?.lastSurvivalReason || survival?.state?.reason || null,
      recommendedAction: survival?.recommendedAction || survival?.state?.recommendedAction || null,
      safeModeEnabled: survival?.safeModeEnabled || false,
      safeMode: survival?.safeMode || survival?.safeModeEnabled || false,
      lastSurvivalDecision: survival?.lastSurvivalDecision || null,
      lastSurvivalReason: survival?.lastSurvivalReason || survival?.state?.reason || null,
      interruptedTask: survival?.interruptedTask || null,
      pausedTask: survival?.pausedTask || survival?.pausedTaskDueToSurvival || null,
      queuedSurvivalTask: survival?.queuedSurvivalTask || null,
      lastSurvivalAction: survival?.lastSurvivalAction || null,
      canResumePreviousTask: survival?.canResumePreviousTask || false,
      foodStatus: survival?.foodStatus || survival?.state?.foodStatus || null,
      healthStatus: survival?.healthStatus || survival?.state?.healthStatus || null,
      nightStatus: survival?.nightStatus || survival?.state?.nightStatus || survival?.state?.timeStatus || null,
      inventoryStatus: survival?.inventoryStatus || survival?.state?.inventoryStatus || null,
      pausedTaskDueToSurvival: survival?.pausedTaskDueToSurvival || null,
      survivalCooldowns: survival?.survivalCooldowns || {},
      memory: memorySummary,
      memorySummary,
      world
    }
  }
}

function directTaskFeedback(task, status) {
  if (status !== 'completed') return null
  if (task?.type === 'storage' && task?.mode === 'CHECK_STORAGE') {
    const counts = task.result?.summary?.counts || {}
    const entries = Object.entries(counts)
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 12)
    if (!entries.length) return '这个箱子是空的。'
    const text = entries.map(([name, count]) => `${getChineseItemName(name)} x${count}`).join('、')
    const more = Object.keys(counts).length > entries.length ? `，另外还有 ${Object.keys(counts).length - entries.length} 种` : ''
    return `箱子里有：${text}${more}。`
  }
  return null
}

function findBuildTask(tasks) {
  const all = [
    tasks.currentTask,
    ...(tasks.queue || []),
    ...(tasks.pausedStack || [])
  ].filter(Boolean)
  return all.find(task => task.type === 'build_blueprint') || null
}

function findStorageTask(tasks) {
  const all = [
    tasks.currentTask,
    ...(tasks.queue || []),
    ...(tasks.pausedStack || []),
    ...(tasks.recentFailed || []),
    ...(tasks.recentCompleted || [])
  ].filter(Boolean)
  return all.find(task => task.type === 'storage') || null
}

function findFarmingTask(tasks) {
  const all = [
    tasks.currentTask,
    ...(tasks.queue || []),
    ...(tasks.pausedStack || []),
    ...(tasks.recentFailed || []),
    ...(tasks.recentCompleted || [])
  ].filter(Boolean)
  return all.find(task => task.type === 'farming') || null
}

function findExplorationTask(tasks) {
  const all = [
    tasks.currentTask,
    ...(tasks.queue || []),
    ...(tasks.pausedStack || []),
    ...(tasks.recentFailed || []),
    ...(tasks.recentCompleted || [])
  ].filter(Boolean)
  return all.find(task => task.type === 'exploration') || null
}

function findMovementTask(tasks) {
  const all = [
    tasks.currentTask,
    ...(tasks.queue || []),
    ...(tasks.pausedStack || [])
  ].filter(Boolean)
  return all.find(task => ['return_to_player', 'follow_player', 'return_to_base', 'exploration'].includes(task.type)) || null
}

function findSleepState(tasks, ctx, survival) {
  const all = [
    tasks.currentTask,
    ...(tasks.queue || []),
    ...(tasks.pausedStack || []),
    ...(tasks.recentFailed || []),
    ...(tasks.recentCompleted || [])
  ].filter(Boolean)
  const sleepTask = all.find(task => task.type === 'sleep')
  return sleepTask?.sleepState || survival?.sleepState || buildSleepState(ctx, survival?.sleepState || {})
}

function summarizeFood(bot, blackboardSnapshot) {
  const counts = blackboardSnapshot?.inventory?.counts || {}
  const items = bot?.inventory?.items?.() || []
  const foodNames = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot', 'baked_potato']
  const merged = { ...counts }
  for (const item of items) merged[item.name] = (merged[item.name] || 0) + item.count
  const foods = {}
  for (const name of foodNames) if (merged[name]) foods[name] = merged[name]
  return {
    foods,
    breadCount: merged.bread || 0,
    wheatCount: merged.wheat || 0,
    seedCount: merged.wheat_seeds || 0,
    totalFood: Object.values(foods).reduce((sum, count) => sum + count, 0)
  }
}

function summarizeInventoryState(ctx, snapshotInventory = {}) {
  const summary = getInventorySummary(ctx, { owner: 'task_manager_status_inventory' })
  if (summary.ok) {
    return {
      emptySlots: summary.data.emptySlots,
      usedSlots: summary.data.usedSlots,
      items: summary.data.items,
      tools: summary.data.tools,
      weapons: summary.data.weapons,
      armor: summary.data.armor,
      food: summary.data.food,
      blocks: summary.data.blocks,
      heldItem: summary.data.heldItem
    }
  }
  const counts = snapshotInventory.counts || {}
  const items = Object.entries(counts).map(([name, count]) => ({ name, displayName: getChineseItemName(name), count }))
  return {
    emptySlots: snapshotInventory.emptySlots ?? null,
    usedSlots: snapshotInventory.emptySlots == null ? null : Math.max(0, 36 - snapshotInventory.emptySlots),
    items,
    tools: [],
    weapons: [],
    armor: [],
    food: [],
    blocks: [],
    heldItem: null
  }
}

function findLastError(failed, interrupted) {
  const candidates = [
    ...(failed || []).map(task => ({ ...task, status: 'FAILED' })),
    ...(interrupted || []).map(task => ({ ...task, status: 'INTERRUPTED' }))
  ].filter(Boolean)
  const last = candidates[candidates.length - 1]
  if (!last) return null
  return {
    taskId: last.id,
    taskType: last.type,
    status: last.status,
    error: last.error || last.failedReason || last.interruptReason || null
  }
}

function findLastResumablePaused(pausedStack) {
  for (let index = pausedStack.length - 1; index >= 0; index--) {
    const task = pausedStack[index]
    if (task && task.manualPause !== true) return task
  }
  return null
}

function removePausedTask(pausedStack, task) {
  const index = pausedStack.lastIndexOf(task)
  if (index < 0) return null
  return pausedStack.splice(index, 1)[0] || null
}

function removeLastPausedTask(pausedStack) {
  return pausedStack.pop() || null
}

function removeLastPausedTaskByType(pausedStack, type) {
  for (let index = pausedStack.length - 1; index >= 0; index--) {
    const task = pausedStack[index]
    if (task?.type === type) return pausedStack.splice(index, 1)[0] || null
  }
  return null
}

function removeLastQueuedTaskByType(queue, type) {
  for (let index = queue.length - 1; index >= 0; index--) {
    const task = queue[index]
    if (task?.type === type) return queue.splice(index, 1)[0] || null
  }
  return null
}

function findLastManualPausedTask(pausedStack) {
  for (let index = pausedStack.length - 1; index >= 0; index--) {
    const task = pausedStack[index]
    if (task?.manualPause === true) return task
  }
  return null
}

function findManualPausedTaskById(pausedStack, taskId) {
  for (let index = pausedStack.length - 1; index >= 0; index--) {
    const task = pausedStack[index]
    if (task?.manualPause === true && String(task.id) === String(taskId)) return task
  }
  return null
}

function taskCheckpoint(task) {
  if (!task) return null
  if (task.type === 'build_blueprint') {
    return {
      blueprintName: task.blueprintName || null,
      origin: task.origin || null,
      placedBlocks: task.placedBlocks || 0,
      currentIndex: task.currentIndex || 0,
      currentStepIndex: task.currentStepIndex || 0,
      totalSteps: task.totalSteps || 0,
      constructionRunId: task.system?.session?.constructionRunId || null
    }
  }
  if (task.type === 'exploration') {
    return { checkpointIndex: task.checkpointIndex || 0 }
  }
  return task.toJSON?.() || null
}

function createTaskManager(bot, options) {
  return new TaskManager(bot, options)
}

module.exports = { TaskManager, createTaskManager, TASK_TYPES }
