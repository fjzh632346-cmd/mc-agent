class TickLoop {
  constructor(options = {}) {
    this.options = {
      intervalMs: Number(process.env.AI_TICK_MS || 500),
      debug: process.env.AI_TICK_DEBUG === 'true',
      logger: console,
      errorThrottleMs: 5000,
      ...options
    }
    this.timer = null
    this.ticking = false
    this.errorLogState = new Map()
  }

  start() {
    if (this.timer) return false

    this.timer = setInterval(() => {
      this.updateOnce().catch(err => this.logError(err))
    }, this.options.intervalMs)

    this.debug('[TickLoop] started')
    return true
  }

  stop() {
    if (!this.timer) return false
    clearInterval(this.timer)
    this.timer = null
    this.debug('[TickLoop] stopped')
    return true
  }

  isRunning() {
    return Boolean(this.timer)
  }

  async updateOnce() {
    if (this.ticking) return false
    this.ticking = true

    try {
      const context = this.createContext()
      await this.options.worldState?.update?.(context)
      await this.options.goalSystem?.update?.(context)
      await this.options.planningSystem?.update?.(context)
      await this.options.taskManager?.update?.(context)

      if (this.options.debug) {
        const danger = context.blackboard?.get?.('mobs.dangerLevel')
        const task = context.blackboard?.get?.('tasks.currentTask.type')
        this.debug(`[TickLoop] danger=${danger || 'unknown'} task=${task || 'none'}`)
      }

      return true
    } catch (err) {
      this.logError(err)
      return false
    } finally {
      this.ticking = false
    }
  }

  createContext() {
    return {
      bot: this.options.bot,
      actionLock: this.options.actionLock,
      blackboard: this.options.blackboard,
      worldState: this.options.worldState,
      goalSystem: this.options.goalSystem,
      planningSystem: this.options.planningSystem,
      taskManager: this.options.taskManager,
      memory: this.options.memory,
      equipmentSystem: this.options.equipmentSystem,
      messageGenerator: this.options.messageGenerator,
      reminderOutput: this.options.reminderOutput,
      persona: this.options.persona,
      logger: this.options.logger,
      debug: message => this.debug(message)
    }
  }

  debug(message) {
    this.options.logger?.log?.(message)
  }

  logError(err) {
    const message = err?.message || String(err)
    const signature = `${err?.name || 'Error'}:${message}`
    const now = Date.now()
    const state = this.errorLogState.get(signature) || {
      lastPrintedAt: 0,
      suppressed: 0,
      printedStack: false
    }

    if (state.lastPrintedAt && now - state.lastPrintedAt < this.options.errorThrottleMs) {
      state.suppressed += 1
      this.errorLogState.set(signature, state)
      return
    }

    const suffix = state.suppressed > 0
      ? ` (suppressed ${state.suppressed} repeats in the last ${Math.round(this.options.errorThrottleMs / 1000)}s)`
      : ''

    if (!state.printedStack) {
      this.options.logger?.error?.('[TickLoop] update failed:', err)
      if (err?.stack) this.options.logger?.error?.(err.stack)
      state.printedStack = true
    } else {
      this.options.logger?.error?.(`[TickLoop] update failed: ${message}${suffix}`)
    }

    state.lastPrintedAt = now
    state.suppressed = 0
    this.errorLogState.set(signature, state)
  }
}

function createTickLoop(options) {
  return new TickLoop(options)
}

module.exports = {
  TickLoop,
  createTickLoop
}
