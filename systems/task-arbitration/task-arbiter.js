const { ActionLock } = require('../../core/action-lock')
const { TaskConflictResolver } = require('./task-conflict-resolver')
const { MovementLock } = require('./movement-lock')
const { TaskPriorityManager } = require('./task-priority-manager')
const {
  ARBITRATION_STATES,
  TaskStateMachine,
  taskToArbitrationState
} = require('./task-state-machine')

class TaskArbiter {
  constructor(options = {}) {
    this.actionLock = options.actionLock || new ActionLock()
    this.logger = options.logger || null
    this.priorityManager = options.priorityManager || new TaskPriorityManager(options.priority || {})
    this.conflictResolver = options.conflictResolver || new TaskConflictResolver({
      priorityManager: this.priorityManager
    })
    this.stateMachine = options.stateMachine || new TaskStateMachine()
    this.movementLock = options.movementLock || new MovementLock({
      actionLock: this.actionLock,
      staleMs: options.movementLockStaleMs,
      logger: this.logger
    })
    this.records = new Map()
  }

  setActionLock(actionLock) {
    this.actionLock = actionLock
    this.movementLock.setActionLock(actionLock)
  }

  prepareTask(task) {
    if (!task) return null
    const priority = this.priorityManager.priorityForTask(task)
    task.arbitrationPriority = priority.name
    this.records.set(task.id, this.stateMachine.create(task))
    return task
  }

  requestExecution(task, context = {}) {
    if (!task) return { ok: false, action: 'REJECT', reason: 'missing_task' }
    if (!this.records.has(task.id)) this.prepareTask(task)
    const currentTask = context.currentTask || null
    const resolution = this.conflictResolver.resolveConflict(currentTask, task)
    const priority = this.priorityManager.priorityForTask(task)
    this.log(`[TaskArbiter] request task=${task.type} id=${task.id ?? 'none'} priority=${priority.name} action=${resolution.action} reason=${resolution.reason}`)
    return {
      ...resolution,
      priority,
      task
    }
  }

  resolveConflict(currentTask, incomingTask) {
    return this.conflictResolver.resolveConflict(currentTask, incomingTask)
  }

  sortQueue(queue = []) {
    return this.priorityManager.sortTasks(queue)
  }

  compareTasks(a, b) {
    const priorityDelta = this.priorityManager.priorityForTask(b).value - this.priorityManager.priorityForTask(a).value
    if (priorityDelta !== 0) return priorityDelta
    return Number(a.createdAt || 0) - Number(b.createdAt || 0) || Number(a.id || 0) - Number(b.id || 0)
  }

  markActive(task, details = {}) {
    return this.transition(task, record => this.stateMachine.activate(record, details))
  }

  markPaused(task, reason = 'paused', checkpoint = undefined) {
    return this.transition(task, record => this.stateMachine.pause(record, reason, checkpoint))
  }

  markCompleted(task, details = {}) {
    return this.transition(task, record => this.stateMachine.complete(record, details))
  }

  markFailed(task, reason, details = {}) {
    return this.transition(task, record => this.stateMachine.fail(record, reason, details))
  }

  markBlocked(task, reason, details = {}) {
    return this.transition(task, record => this.stateMachine.block(record, reason, details))
  }

  checkpoint(task, checkpoint, partialProgress = undefined) {
    return this.transition(task, record => this.stateMachine.checkpoint(record, checkpoint, partialProgress))
  }

  getRecord(taskOrId) {
    const id = typeof taskOrId === 'object' ? taskOrId.id : taskOrId
    return this.records.get(id) || null
  }

  acquireTaskLocks(task, ctx = {}, options = {}) {
    const requiredLocks = task?.requiredLocks || []
    if (!requiredLocks.length) return { ok: true, owner: task?.id, types: [] }

    const acquired = []
    const owner = task.id
    if (requiredLocks.includes('movement')) {
      const movement = this.movementLock.lock(owner, {
        reason: `${task.type}:${task.state}`,
        ...options
      })
      if (!movement.ok) return movement
      acquired.push('movement')
    }

    const nonMovementLocks = requiredLocks.filter(lock => lock !== 'movement')
    for (const lock of nonMovementLocks) {
      const result = this.actionLock.acquire(lock, owner, {
        reason: `${task.type}:${task.state}`,
        ...options
      })
      if (!result.ok) {
        for (const acquiredType of acquired) this.actionLock.release(acquiredType, owner)
        this.log(`[TaskArbiter] lock task=${task.type} id=${owner} result=${result.reason} type=${result.type}`)
        return { ...result, acquired }
      }
      acquired.push(lock)
    }

    this.log(`[TaskArbiter] lock task=${task.type} id=${owner} result=ok types=${acquired.join(',')}`)
    return { ok: true, owner, types: acquired }
  }

  releaseTaskLocks(taskOrOwner, ctx = {}) {
    const owner = typeof taskOrOwner === 'object' ? taskOrOwner.id : taskOrOwner
    const result = this.actionLock.releaseAll(owner)
    this.log(`[TaskArbiter] release owner=${owner} result=${result.ok ? 'ok' : result.reason} types=${(result.released || []).join(',') || 'none'}`)
    return result
  }

  transition(task, updater) {
    if (!task) return null
    const current = this.syncTaskRecord(task)
    const next = updater(current)
    this.records.set(task.id, next)
    return next
  }

  syncTaskRecord(task) {
    const current = this.records.get(task.id)
    if (!current) return this.stateMachine.create(task)

    const liveState = taskToArbitrationState(task)
    if (current.state === ARBITRATION_STATES.PENDING && liveState === ARBITRATION_STATES.ACTIVE) {
      const next = this.stateMachine.activate(current)
      this.records.set(task.id, next)
      return next
    }
    if (current.state === ARBITRATION_STATES.PENDING && liveState === ARBITRATION_STATES.PAUSED) {
      const next = this.stateMachine.activate(current)
      const paused = this.stateMachine.pause(next)
      this.records.set(task.id, paused)
      return paused
    }
    return current
  }

  log(message) {
    if (this.logger?.log) this.logger.log(message)
  }
}

module.exports = {
  TaskArbiter
}
