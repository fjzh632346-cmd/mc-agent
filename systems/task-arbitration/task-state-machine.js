const ARBITRATION_STATES = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
})

const TASK_STATE_TO_ARBITRATION = Object.freeze({
  IDLE: ARBITRATION_STATES.PENDING,
  RUNNING: ARBITRATION_STATES.ACTIVE,
  PAUSED: ARBITRATION_STATES.PAUSED,
  BLOCKED: ARBITRATION_STATES.BLOCKED,
  COMPLETED: ARBITRATION_STATES.COMPLETED,
  FAILED: ARBITRATION_STATES.FAILED,
  INTERRUPTED: ARBITRATION_STATES.PAUSED
})

const ALLOWED_TRANSITIONS = Object.freeze({
  [ARBITRATION_STATES.PENDING]: new Set([
    ARBITRATION_STATES.ACTIVE,
    ARBITRATION_STATES.BLOCKED,
    ARBITRATION_STATES.FAILED
  ]),
  [ARBITRATION_STATES.ACTIVE]: new Set([
    ARBITRATION_STATES.PAUSED,
    ARBITRATION_STATES.BLOCKED,
    ARBITRATION_STATES.COMPLETED,
    ARBITRATION_STATES.FAILED
  ]),
  [ARBITRATION_STATES.PAUSED]: new Set([
    ARBITRATION_STATES.ACTIVE,
    ARBITRATION_STATES.BLOCKED,
    ARBITRATION_STATES.FAILED
  ]),
  [ARBITRATION_STATES.BLOCKED]: new Set([
    ARBITRATION_STATES.PENDING,
    ARBITRATION_STATES.ACTIVE,
    ARBITRATION_STATES.FAILED
  ]),
  [ARBITRATION_STATES.COMPLETED]: new Set([]),
  [ARBITRATION_STATES.FAILED]: new Set([])
})

class TaskStateMachine {
  create(task = {}, options = {}) {
    return {
      taskId: task.id ?? null,
      taskType: task.type ?? null,
      state: options.state || taskToArbitrationState(task),
      checkpoint: clone(options.checkpoint || task.checkpoint || task.constructionCheckpoint || null),
      partialProgress: clone(options.partialProgress || null),
      failureReason: null,
      blockedReason: null,
      retryPolicy: clone(options.retryPolicy || { maxRetries: 0, attempts: 0 }),
      updatedAt: Date.now()
    }
  }

  transition(record, nextState, details = {}) {
    if (!record) throw new Error('missing_state_record')
    if (!Object.values(ARBITRATION_STATES).includes(nextState)) {
      throw new Error(`unsupported_task_state:${nextState}`)
    }
    const allowed = ALLOWED_TRANSITIONS[record.state]
    if (!allowed?.has(nextState) && record.state !== nextState) {
      throw new Error(`invalid_task_state_transition:${record.state}->${nextState}`)
    }

    const next = {
      ...record,
      state: nextState,
      updatedAt: Date.now()
    }
    if (details.checkpoint !== undefined) next.checkpoint = clone(details.checkpoint)
    if (details.partialProgress !== undefined) next.partialProgress = clone(details.partialProgress)
    if (details.failureReason !== undefined) next.failureReason = details.failureReason
    if (details.blockedReason !== undefined) next.blockedReason = details.blockedReason
    if (details.retryPolicy !== undefined) next.retryPolicy = clone(details.retryPolicy)
    return next
  }

  activate(record, details = {}) {
    return this.transition(record, ARBITRATION_STATES.ACTIVE, details)
  }

  pause(record, reason = 'paused', checkpoint = undefined) {
    return this.transition(record, ARBITRATION_STATES.PAUSED, {
      blockedReason: null,
      partialProgress: record.partialProgress,
      checkpoint: checkpoint === undefined ? record.checkpoint : checkpoint,
      pauseReason: reason
    })
  }

  resume(record) {
    return this.transition(record, ARBITRATION_STATES.ACTIVE, {
      checkpoint: record.checkpoint,
      partialProgress: record.partialProgress
    })
  }

  checkpoint(record, checkpoint, partialProgress = undefined) {
    return {
      ...record,
      checkpoint: clone(checkpoint),
      partialProgress: partialProgress === undefined ? record.partialProgress : clone(partialProgress),
      updatedAt: Date.now()
    }
  }

  block(record, reason, details = {}) {
    return this.transition(record, ARBITRATION_STATES.BLOCKED, {
      ...details,
      blockedReason: reason
    })
  }

  complete(record, details = {}) {
    return this.transition(record, ARBITRATION_STATES.COMPLETED, details)
  }

  fail(record, reason, details = {}) {
    return this.transition(record, ARBITRATION_STATES.FAILED, {
      ...details,
      failureReason: reason
    })
  }
}

function taskToArbitrationState(task = {}) {
  return TASK_STATE_TO_ARBITRATION[task.state] || ARBITRATION_STATES.PENDING
}

function clone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

module.exports = {
  ARBITRATION_STATES,
  TASK_STATE_TO_ARBITRATION,
  TaskStateMachine,
  taskToArbitrationState
}
