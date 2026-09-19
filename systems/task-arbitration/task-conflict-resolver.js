const { PRIORITY_LEVELS, TaskPriorityManager } = require('./task-priority-manager')

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

const DECISIONS = Object.freeze({
  START: 'START',
  QUEUE: 'QUEUE',
  PAUSE_CURRENT: 'PAUSE_CURRENT',
  FORCE_PREEMPT: 'FORCE_PREEMPT',
  WAIT_SAFE_POINT: 'WAIT_SAFE_POINT',
  REJECT: 'REJECT'
})

class TaskConflictResolver {
  constructor(options = {}) {
    this.priorityManager = options.priorityManager || new TaskPriorityManager()
  }

  resolveConflict(currentTask, incomingTask) {
    if (!incomingTask) {
      return decision(DECISIONS.REJECT, 'missing_incoming_task', { ok: false })
    }
    if (!currentTask || isTerminal(currentTask)) {
      return decision(DECISIONS.START, 'no_active_conflict')
    }

    if (shouldPreemptFollowForPlayerTask(currentTask, incomingTask)) {
      return decision(DECISIONS.PAUSE_CURRENT, `preempted_by:${incomingTask.type}`, {
        conflict: 'follow_player_work_request',
        lockConflict: hasLockConflict(currentTask, incomingTask)
      })
    }

    if (isReturnToBaseBlockedByActiveBuild(currentTask, incomingTask)) {
      return decision(DECISIONS.QUEUE, 'return_to_base_deferred_for_building', {
        conflict: 'return_to_base_vs_building',
        lockConflict: hasLockConflict(currentTask, incomingTask)
      })
    }

    const incomingPriority = this.priorityManager.priorityForTask(incomingTask)
    const currentPriority = this.priorityManager.priorityForTask(currentTask)
    const lockConflict = hasLockConflict(currentTask, incomingTask)
    const sharedLocks = sharedLockTypes(currentTask, incomingTask)

    if (incomingPriority.value <= currentPriority.value) {
      return decision(DECISIONS.QUEUE, 'incoming_priority_not_higher', {
        incomingPriority,
        currentPriority,
        lockConflict,
        sharedLocks
      })
    }

    if (incomingPriority.value >= PRIORITY_LEVELS.CRITICAL) {
      return decision(DECISIONS.FORCE_PREEMPT, `critical_preempt:${incomingTask.type}`, {
        incomingPriority,
        currentPriority,
        lockConflict,
        sharedLocks
      })
    }

    if (currentTask.resumable === false) {
      return decision(DECISIONS.WAIT_SAFE_POINT, 'current_task_not_pauseable', {
        incomingPriority,
        currentPriority,
        lockConflict,
        sharedLocks
      })
    }

    return decision(DECISIONS.PAUSE_CURRENT, `preempted_by:${incomingTask.type}#${incomingTask.id}`, {
      incomingPriority,
      currentPriority,
      lockConflict,
      sharedLocks
    })
  }
}

function decision(action, reason, extra = {}) {
  return {
    ok: extra.ok !== false,
    action,
    reason,
    preempt: action === DECISIONS.PAUSE_CURRENT || action === DECISIONS.FORCE_PREEMPT,
    shouldQueue: action === DECISIONS.QUEUE || action === DECISIONS.WAIT_SAFE_POINT,
    force: action === DECISIONS.FORCE_PREEMPT,
    ...extra
  }
}

function isTerminal(task = {}) {
  return ['COMPLETED', 'FAILED', 'BLOCKED', 'INTERRUPTED'].includes(task.state)
}

function shouldPreemptFollowForPlayerTask(currentTask = {}, incomingTask = {}) {
  return currentTask.type === 'follow_player' &&
    FOLLOW_PREEMPTING_PLAYER_TASKS.has(incomingTask.type) &&
    incomingTask.source === 'player_command'
}

function isReturnToBaseBlockedByActiveBuild(currentTask = {}, incomingTask = {}) {
  return currentTask.type === 'build_blueprint' &&
    incomingTask.type === 'return_to_base' &&
    incomingTask.params?.critical !== true &&
    incomingTask.params?.survivalCritical !== true
}

function hasLockConflict(currentTask = {}, incomingTask = {}) {
  return sharedLockTypes(currentTask, incomingTask).length > 0
}

function sharedLockTypes(currentTask = {}, incomingTask = {}) {
  const current = new Set(currentTask.requiredLocks || [])
  return (incomingTask.requiredLocks || []).filter(lock => current.has(lock))
}

module.exports = {
  DECISIONS,
  FOLLOW_PREEMPTING_PLAYER_TASKS,
  TaskConflictResolver,
  sharedLockTypes
}
