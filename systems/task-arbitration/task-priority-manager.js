const PRIORITY_LEVELS = Object.freeze({
  LOW: 1,
  MEDIUM: 5,
  HIGH: 8,
  CRITICAL: 10,
  EMERGENCY: 12
})

const PRIORITY_NAMES = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
  EMERGENCY: 'EMERGENCY'
})

const COMBAT_TASKS = new Set([
  'combat',
  'fight_nearby_mob',
  'guard_player'
])

const HIGH_TASKS = new Set([
  'eat_food',
  'prepare_combat',
  'equip_armor'
])

const MEDIUM_TASKS = new Set([
  'build_blueprint',
  'craft_item',
  'smelt_item',
  'mining',
  'mine_nearby_block',
  'storage',
  'farming',
  'pickup_item'
])

const LOW_TASKS = new Set([
  'exploration',
  'follow_player',
  'return_to_player',
  'return_to_base',
  'sleep',
  'idle'
])

class TaskPriorityManager {
  constructor(options = {}) {
    this.typePriorityOverrides = new Map(Object.entries(options.typePriorityOverrides || {}))
  }

  priorityForTask(task = {}) {
    const explicit = normalizePriorityName(task.params?.arbitrationPriority || task.arbitrationPriority)
    if (explicit) return priorityRecord(explicit)

    const override = normalizePriorityName(this.typePriorityOverrides.get(task.type))
    if (override) return priorityRecord(override)

    if (COMBAT_TASKS.has(task.type)) return priorityRecord(PRIORITY_NAMES.CRITICAL)
    if (isCriticalSurvivalTask(task)) return priorityRecord(PRIORITY_NAMES.EMERGENCY)
    if (isHighSurvivalTask(task)) return priorityRecord(PRIORITY_NAMES.HIGH)
    if (HIGH_TASKS.has(task.type)) return priorityRecord(PRIORITY_NAMES.HIGH)
    if (MEDIUM_TASKS.has(task.type)) return priorityRecord(PRIORITY_NAMES.MEDIUM)
    if (LOW_TASKS.has(task.type)) return priorityRecord(PRIORITY_NAMES.LOW)

    return priorityFromNumeric(task.priority)
  }

  compare(a, b) {
    return this.priorityForTask(a).value - this.priorityForTask(b).value
  }

  isHigherPriority(incoming, current) {
    return this.compare(incoming, current) > 0
  }

  isCritical(task) {
    return this.priorityForTask(task).value >= PRIORITY_LEVELS.CRITICAL
  }

  sortTasks(tasks = []) {
    return tasks.sort((a, b) =>
      this.priorityForTask(b).value - this.priorityForTask(a).value ||
      Number(a.createdAt || 0) - Number(b.createdAt || 0) ||
      Number(a.id || 0) - Number(b.id || 0)
    )
  }
}

function priorityRecord(name) {
  return {
    name,
    value: PRIORITY_LEVELS[name]
  }
}

function priorityFromNumeric(priority) {
  const value = Number(priority)
  if (value >= PRIORITY_LEVELS.EMERGENCY) return priorityRecord(PRIORITY_NAMES.EMERGENCY)
  if (value >= PRIORITY_LEVELS.CRITICAL) return priorityRecord(PRIORITY_NAMES.CRITICAL)
  if (value >= PRIORITY_LEVELS.HIGH) return priorityRecord(PRIORITY_NAMES.HIGH)
  if (value >= PRIORITY_LEVELS.MEDIUM) return priorityRecord(PRIORITY_NAMES.MEDIUM)
  return priorityRecord(PRIORITY_NAMES.LOW)
}

function normalizePriorityName(value) {
  if (!value) return null
  const normalized = String(value).trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(PRIORITY_LEVELS, normalized) ? normalized : null
}

function isCriticalSurvivalTask(task = {}) {
  if (task.params?.critical === true || task.params?.survivalCritical === true) return true
  if (task.params?.dangerLevel === 'critical' || task.params?.dangerLevel === 'high') return true
  const reason = String(task.params?.reason || task.params?.survivalReason || '')
  return /drowning|burning|critical_health|danger_nearby|immediate_threat|low_food_critical/i.test(reason)
}

function isHighSurvivalTask(task = {}) {
  if (task.source !== 'survival_system') return false
  return Number(task.priority || 0) >= PRIORITY_LEVELS.HIGH
}

module.exports = {
  COMBAT_TASKS,
  HIGH_TASKS,
  LOW_TASKS,
  MEDIUM_TASKS,
  PRIORITY_LEVELS,
  PRIORITY_NAMES,
  TaskPriorityManager
}
