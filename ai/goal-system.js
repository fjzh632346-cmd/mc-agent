const fs = require('fs')
const path = require('path')
const { eatFood } = require('../actions/inventory')
const { createReminderEvent, defaultReminderText, generateReminderMessage, REMINDER_TYPES } = require('./message-generator')
const { SurvivalSystem, SURVIVAL_PRIORITIES } = require('../systems/survival-system')

const GOAL_TYPES = Object.freeze({
  LOW_HEALTH: 'LOW_HEALTH',
  LOW_FOOD: 'LOW_FOOD',
  DANGER_NEARBY: 'DANGER_NEARBY',
  INVENTORY_FULL: 'INVENTORY_FULL',
  NIGHT_WARNING: 'NIGHT_WARNING',
  RETURN_TO_BASE_SUGGESTION: 'RETURN_TO_BASE_SUGGESTION'
})

const GOAL_PRIORITIES = Object.freeze({
  [GOAL_TYPES.LOW_HEALTH]: 100,
  [GOAL_TYPES.DANGER_NEARBY]: 90,
  [GOAL_TYPES.LOW_FOOD]: 70,
  [GOAL_TYPES.INVENTORY_FULL]: 60,
  [GOAL_TYPES.RETURN_TO_BASE_SUGGESTION]: 50,
  [GOAL_TYPES.NIGHT_WARNING]: 40
})

const COLLECT_TASKS = new Set(['mining', 'mine_nearby_block', 'farming', 'farm', 'exploration'])
const COMBAT_TASKS = new Set(['guard_player', 'fight_nearby_mob'])

class GoalSystem {
  constructor(options = {}) {
    this.options = {
      cooldownMs: Number(process.env.GOAL_COOLDOWN_MS || 30000),
      lowHealthThreshold: 10,
      lowFoodThreshold: 8,
      dangerDistance: 6,
      inventoryEmptySlotThreshold: 2,
      maxCompletedGoals: 50,
      enableChat: false,
      ...options
    }
    this.activeGoals = []
    this.completedGoals = []
    this.cooldowns = new Map()
    this.lastTriggeredGoal = null
    this.lastAction = null
    this.survivalSystem = options.survivalSystem || new SurvivalSystem({ cooldownMs: this.options.cooldownMs })
  }

  async update(context = {}) {
    try {
      const candidates = this.detectGoals(context)
      if (this.options.enableSurvivalSystem !== false) {
        // 工地锚点一激活，之前为了旧基地排下的那趟「回家」就作废——
        // 这一步与目标候选无关，所以放在候选判断之前。
        await this.survivalSystem.releaseObsoleteReturn?.(context)
        const recoveryPending = this.survivalSystem.hasPendingRecovery?.() === true
        if (candidates.length > 0 || recoveryPending) {
          const state = this.survivalSystem.evaluateSurvivalState(context)
          const decision = this.survivalSystem.createSurvivalPlan(context, state)
          if (candidates.length > 0) {
            const goal = goalForSurvivalPriority(decision.priority, candidates) || candidates[0]
            const urgentCombat = decision.priority === SURVIVAL_PRIORITIES.DANGER_NEARBY &&
              decision.action === 'GUARD_PLAYER' &&
              Number(decision.nearbyHostiles || 0) > 0
            if (urgentCombat || (!this.isCoolingDown(goal.type) && !this.survivalSystem.isCoolingDown(decision.cooldownKey))) {
              this.activeGoals.push(goal)
              this.lastTriggeredGoal = goal
              if (!urgentCombat) this.setCooldown(goal.type)
              const action = await this.survivalSystem.applySurvivalDecision(context, decision)
              this.completeGoal(goal, action)
            }
          }
          // 生存状态已经回到 NORMAL，就该把为生存挂起的任务接回来。
          // 以前只有「一个目标候选都不剩」才走得到这一步：背包腾空了但天还黑着，
          // 夜间提醒会一直占着候选位，挂起的施工任务就再也没人叫醒。
          // TaskManager.processSurvival 里本来就是按 NORMAL 判的，这里对齐它。
          if (candidates.length === 0 || decision.priority === SURVIVAL_PRIORITIES.NORMAL) {
            await this.survivalSystem.resumeIfSafe?.(context, state)
          }
        }
        this.writeStatus(context)
        return this.status()
      }

      for (const goal of candidates) {
        if (this.isCoolingDown(goal.type)) continue
        this.activeGoals.push(goal)
        this.lastTriggeredGoal = goal
        this.setCooldown(goal.type)

        const action = await this.handleGoal(goal, context)
        this.completeGoal(goal, action)
      }
      this.writeStatus(context)
      return this.status()
    } catch (err) {
      context.logger?.error?.(`[GoalSystem] update failed: ${err.message}`)
      this.lastAction = { ok: false, type: 'ERROR', message: err.message }
      this.writeStatus(context)
      return this.status()
    }
  }

  detectGoals(context = {}) {
    const snapshot = context.blackboard?.snapshot?.() || context.blackboard?.list?.() || {}
    const bot = snapshot.bot || {}
    const mobs = snapshot.mobs || {}
    const inventory = snapshot.inventory || {}
    const world = snapshot.world || {}
    const goals = []

    if (Number(bot.health) <= this.options.lowHealthThreshold) {
      goals.push(createGoal(GOAL_TYPES.LOW_HEALTH, `bot health is low (${bot.health})`))
    }

    if (Number(bot.food) <= this.options.lowFoodThreshold) {
      goals.push(createGoal(GOAL_TYPES.LOW_FOOD, `bot food is low (${bot.food})`))
    }

    const hostile = mobs.nearestHostileMob
    const dangerHigh = ['high', 'critical'].includes(mobs.dangerLevel)
    if (dangerHigh || (hostile && hostile.distance <= this.options.dangerDistance)) {
      goals.push(createGoal(GOAL_TYPES.DANGER_NEARBY, 'nearby danger detected'))
    }

    if (inventory.emptySlots != null && inventory.emptySlots <= this.options.inventoryEmptySlotThreshold) {
      goals.push(createGoal(GOAL_TYPES.INVENTORY_FULL, `inventory empty slots low (${inventory.emptySlots})`))
    }

    if (world.isDay === false) {
      goals.push(createGoal(GOAL_TYPES.NIGHT_WARNING, 'night has started'))
    }

    if (this.shouldSuggestReturnToBase(context, goals)) {
      goals.push(createGoal(GOAL_TYPES.RETURN_TO_BASE_SUGGESTION, 'base location available and return conditions are present'))
    }

    return goals.sort((a, b) => b.priority - a.priority)
  }

  async handleGoal(goal, context) {
    switch (goal.type) {
      case GOAL_TYPES.LOW_HEALTH:
        return this.handleLowHealth(goal, context)
      case GOAL_TYPES.LOW_FOOD:
        return this.handleLowFood(goal, context)
      case GOAL_TYPES.DANGER_NEARBY:
        return this.handleDangerNearby(goal, context)
      case GOAL_TYPES.INVENTORY_FULL:
        return this.handleInventoryFull(goal, context)
      case GOAL_TYPES.NIGHT_WARNING:
        return this.remind(context, buildGoalReminderEvent(goal, context))
      case GOAL_TYPES.RETURN_TO_BASE_SUGGESTION:
        return this.remind(context, buildGoalReminderEvent(goal, context))
      default:
        return { ok: false, type: 'NOOP', message: 'unknown goal type' }
    }
  }

  async handleLowHealth(goal, context) {
    if (context.planningSystem) {
      const plan = await context.planningSystem.createAndSubmitPlan('return_safe', context)
      if (plan.ok) return { ok: true, type: 'PLAN', message: 'created return_safe plan for low health', plan: plan.plan }
    }

    const foodCount = context.blackboard?.get?.('inventory.foodCount', 0) || 0
    const danger = context.blackboard?.get?.('mobs.dangerLevel')
    const currentTask = context.blackboard?.get?.('tasks.currentTask')

    if (foodCount > 0) {
      const eaten = await eatFood(context)
      if (eaten.ok) return { ok: true, type: 'EAT', message: 'ate food because health is low', data: eaten.data }
    }

    if (['high', 'critical'].includes(danger) && currentTask && COLLECT_TASKS.has(currentTask.type)) {
      await context.taskManager?.interruptCurrent?.('low_health_near_danger')
      return this.remind(context, buildGoalReminderEvent(goal, context, {
        suggestion: '建议先停止危险任务，后退或回到安全位置'
      }))
    }

    this.writeDecisionNeeded('EscapeTask is not implemented yet. LOW_HEALTH should eventually create EscapeTask or ReturnToSafePlaceTask.')
    return this.remind(context, buildGoalReminderEvent(goal, context))
  }

  async handleLowFood(goal, context) {
    const currentTask = context.blackboard?.get?.('tasks.currentTask')
    if (currentTask?.type === 'exploration') {
      await context.taskManager?.interruptCurrent?.('low_food')
    }

    if (context.planningSystem) {
      const plan = await context.planningSystem.createAndSubmitPlan('get_food', context)
      if (plan.ok) return { ok: true, type: 'PLAN', message: 'created get_food plan for low food', plan: plan.plan }
    }

    const foodCount = context.blackboard?.get?.('inventory.foodCount', 0) || 0
    if (foodCount > 0) {
      const eaten = await eatFood(context)
      if (eaten.ok) return { ok: true, type: 'EAT', message: 'ate food because food is low', data: eaten.data }
      return this.remind(context, buildGoalReminderEvent(goal, context, {
        suggestion: '背包里有食物，但这次吃东西失败了，需要稍后再试'
      }))
    }

    const danger = context.blackboard?.get?.('mobs.dangerLevel')
    if (['high', 'critical'].includes(danger)) {
      return this.remind(context, buildGoalReminderEvent(goal, context, {
        suggestion: 'danger is high, skip farming and chest access until safe'
      }))
    }

    if (hasStoredFood(context)) {
      const task = context.taskManager?.enqueue?.('storage', { mode: 'TAKE_ITEMS', itemName: 'bread', count: 1 }, 8, 'goal_system')
      if (task) return { ok: true, type: 'TASK', message: 'created storage task to take food', task }
    }

    const wheatCount = context.blackboard?.get?.('inventory.counts.wheat') || 0
    if (wheatCount >= 3) {
      const task = context.taskManager?.enqueue?.('farming', { mode: 'MAKE_BREAD' }, 8, 'goal_system')
      if (task) return { ok: true, type: 'TASK', message: 'created make bread task for low food', task }
    }

    const farmCount = context.memory?.summary?.().world?.farmLocations || 0
    if (farmCount > 0) {
      const task = context.taskManager?.enqueue?.('farming', { mode: 'FARM_CYCLE' }, 6, 'goal_system')
      if (task) return { ok: true, type: 'TASK', message: 'created farm cycle task for low food', task }
    }

    return this.remind(context, buildGoalReminderEvent(goal, context))
  }

  async handleDangerNearby(goal, context) {
    const health = Number(context.blackboard?.get?.('bot.health', 20))
    const currentTask = context.blackboard?.get?.('tasks.currentTask')
    if (health <= this.options.lowHealthThreshold) {
      return this.remind(context, buildGoalReminderEvent(goal, context, {
        suggestion: '血量低，不适合硬打，建议后退或回到安全位置'
      }))
    }
    if (currentTask && COMBAT_TASKS.has(currentTask.type)) {
      return { ok: true, type: 'NOOP', message: 'already handling combat' }
    }
    if (currentTask?.type === 'exploration') {
      await context.taskManager?.interruptCurrent?.('danger_nearby')
    }
    const task = context.taskManager?.enqueue?.('guard_player', { durationMs: 15000, radius: 8 }, 9, 'goal_system')
    return { ok: Boolean(task), type: 'TASK', message: 'created guard_player task for nearby danger', task }
  }

  async handleInventoryFull(goal, context) {
    if (context.planningSystem && context.memory?.summary?.().world?.hasBaseLocation) {
      const plan = await context.planningSystem.createAndSubmitPlan('return_safe', context)
      if (plan.ok) return { ok: true, type: 'PLAN', message: 'created return_safe plan for full inventory', plan: plan.plan }
    }

    const currentTask = context.blackboard?.get?.('tasks.currentTask')
    if (currentTask && COLLECT_TASKS.has(currentTask.type)) {
      await context.taskManager?.interruptCurrent?.('inventory_full')
    }

    const memory = context.memory?.summary?.()
    const danger = context.blackboard?.get?.('mobs.dangerLevel')
    if (!['high', 'critical'].includes(danger) && memory?.world?.chestLocations > 0) {
      const task = context.taskManager?.enqueue?.('storage', { mode: 'INVENTORY_FULL_STORE' }, 6, 'goal_system')
      if (task) return { ok: true, type: 'TASK', message: 'created storage task for full inventory', task }
    }

    const suggestion = memory?.world?.hasBaseLocation || memory?.world?.chestLocations > 0
      ? '建议先回基地或箱子区存东西'
      : '建议先清理背包或找箱子'
    return this.remind(context, buildGoalReminderEvent(goal, context, { suggestion }))
  }

  shouldSuggestReturnToBase(context, goals) {
    const worldMemory = context.memory?.summary?.().world
    if (!worldMemory?.hasBaseLocation) return false
    return goals.some(goal => [
      GOAL_TYPES.INVENTORY_FULL,
      GOAL_TYPES.NIGHT_WARNING,
      GOAL_TYPES.DANGER_NEARBY
    ].includes(goal.type))
  }

  async remind(context, eventInput) {
    const event = createReminderEvent(eventInput)
    const generated = {
      ok: true,
      text: defaultReminderText(event, context.persona),
      source: 'fallback',
      event
    }

    const text = generated.text || event.fallbackText || event.meaning
    const payload = { event, generated: { ...generated, text } }

    try {
      context.blackboard?.set?.('messages.lastReminder', payload)
    } catch {}

    if (context.reminderOutput) {
      try { context.reminderOutput(text, event, generated) } catch {}
    } else if (this.options.enableChat && context.bot?.chat) {
      try { context.bot.chat(text) } catch {}
    }

    this.generateReminderInBackground(context, event)
    return { ok: true, type: 'REMINDER', message: text, event, generated }
  }

  generateReminderInBackground(context, event) {
    Promise.resolve()
      .then(() => generateReminderMessage(event, context))
      .then(generated => {
        const text = generated?.text
        if (!text) return
        context.blackboard?.set?.('messages.lastReminder.llm', { event, generated: { ...generated, text } })
      })
      .catch(err => {
        context.logger?.warn?.(`[GoalSystem] async reminder generation skipped: ${err.code || 'LLM_ERROR'} ${err.message}`)
      })
  }

  completeGoal(goal, action) {
    goal.status = 'COMPLETED'
    goal.completedAt = new Date().toISOString()
    goal.action = action
    this.lastAction = action
    this.activeGoals = this.activeGoals.filter(active => active.id !== goal.id)
    this.completedGoals.push(goal)
    this.completedGoals = this.completedGoals.slice(-this.options.maxCompletedGoals)
  }

  // 她死了（修缮 17）：目标冷却和正在追的目标一起清掉，再把生存系统复位——
  // 真机上工地锚点就住在它里面。
  resetAfterDeath(reason = 'bot_died') {
    this.cooldowns.clear()
    this.activeGoals = []
    this.lastTriggeredGoal = null
    const survival = this.survivalSystem?.resetAfterDeath?.(reason) || null
    return { ok: true, reason: String(reason), survival }
  }

  isCoolingDown(type) {
    return (this.cooldowns.get(type) || 0) > Date.now()
  }

  setCooldown(type) {
    this.cooldowns.set(type, Date.now() + this.options.cooldownMs)
  }

  writeStatus(context) {
    try {
      context.blackboard?.update?.({ goals: this.status() })
    } catch (err) {
      context.logger?.error?.(`[GoalSystem] status write failed: ${err.message}`)
    }
  }

  status() {
    return {
      activeGoals: this.activeGoals.map(summarizeGoal),
      completedGoals: this.completedGoals.slice(-10).map(summarizeGoal),
      lastTriggeredGoal: this.lastTriggeredGoal ? summarizeGoal(this.lastTriggeredGoal) : null,
      lastAction: this.lastAction,
      goalCooldowns: Object.fromEntries(
        [...this.cooldowns.entries()].map(([type, until]) => [type, Math.max(0, until - Date.now())])
      )
    }
  }

  writeDecisionNeeded(message) {
    const filePath = path.join(process.cwd(), 'docs', 'decision-needed.md')
    const line = `- ${new Date().toISOString()} GoalSystem: ${message}\n`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '# Decisions Needed\n\n', 'utf8')
      const current = fs.readFileSync(filePath, 'utf8')
      if (!current.includes(message)) fs.appendFileSync(filePath, line, 'utf8')
    } catch {}
  }
}

function buildGoalReminderEvent(goal, context = {}, overrides = {}) {
  const snapshot = context.blackboard?.snapshot?.() || {}
  const bot = snapshot.bot || {}
  const mobs = snapshot.mobs || {}
  const inventory = snapshot.inventory || {}
  const world = snapshot.world || {}
  const memory = context.memory?.summary?.() || {}

  const base = {
    type: goal.type,
    severity: severityForGoal(goal.type),
    facts: {
      health: bot.health,
      food: bot.food,
      dangerLevel: mobs.dangerLevel,
      mob: mobs.nearestHostileMob?.name,
      distance: mobs.nearestHostileMob?.distance,
      emptySlots: inventory.emptySlots,
      isDay: world.isDay,
      hasBaseLocation: Boolean(memory.world?.hasBaseLocation),
      chestLocations: memory.world?.chestLocations || 0
    },
    ...overrides
  }

  if (goal.type === GOAL_TYPES.INVENTORY_FULL) {
    base.type = REMINDER_TYPES.INVENTORY_FULL
    base.meaning = '背包满了，需要提醒玩家先整理或回基地'
  } else if (goal.type === GOAL_TYPES.DANGER_NEARBY) {
    base.type = REMINDER_TYPES.DANGER_NEARBY
    base.meaning = '附近有危险生物，需要提醒玩家'
  } else if (goal.type === GOAL_TYPES.LOW_HEALTH) {
    base.type = REMINDER_TYPES.LOW_HEALTH
    base.meaning = '血量低，需要停止危险行动'
  } else if (goal.type === GOAL_TYPES.LOW_FOOD) {
    base.type = REMINDER_TYPES.LOW_FOOD
    base.meaning = '饥饿值低，需要补充食物'
  } else if (goal.type === GOAL_TYPES.NIGHT_WARNING) {
    base.type = REMINDER_TYPES.NIGHT_WARNING
    base.meaning = '世界进入夜晚，危险会上升'
  } else if (goal.type === GOAL_TYPES.RETURN_TO_BASE_SUGGESTION) {
    base.type = REMINDER_TYPES.RETURN_TO_BASE_SUGGESTION
    base.meaning = '当前状态适合返回基地'
  }

  return createReminderEvent(base)
}

function severityForGoal(type) {
  if ([GOAL_TYPES.LOW_HEALTH, GOAL_TYPES.DANGER_NEARBY].includes(type)) return 'high'
  if ([GOAL_TYPES.LOW_FOOD, GOAL_TYPES.INVENTORY_FULL, GOAL_TYPES.RETURN_TO_BASE_SUGGESTION].includes(type)) return 'medium'
  return 'low'
}

function createGoal(type, reason) {
  const now = new Date().toISOString()
  return {
    id: `goal_${type.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    priority: GOAL_PRIORITIES[type],
    reason,
    createdAt: now,
    status: 'PENDING'
  }
}

function summarizeGoal(goal) {
  return {
    id: goal.id,
    type: goal.type,
    priority: goal.priority,
    reason: goal.reason,
    createdAt: goal.createdAt,
    status: goal.status
  }
}

function goalForSurvivalPriority(priority, goals) {
  const map = {
    [SURVIVAL_PRIORITIES.CRITICAL_HEALTH]: GOAL_TYPES.LOW_HEALTH,
    [SURVIVAL_PRIORITIES.DANGER_NEARBY]: GOAL_TYPES.DANGER_NEARBY,
    [SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL]: GOAL_TYPES.LOW_FOOD,
    [SURVIVAL_PRIORITIES.INVENTORY_FULL]: GOAL_TYPES.INVENTORY_FULL,
    [SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE]: GOAL_TYPES.RETURN_TO_BASE_SUGGESTION,
    [SURVIVAL_PRIORITIES.NIGHT_UNSAFE]: GOAL_TYPES.NIGHT_WARNING,
    [SURVIVAL_PRIORITIES.LOW_FOOD_WARNING]: GOAL_TYPES.LOW_FOOD
  }
  const type = map[priority]
  return goals.find(goal => goal.type === type) || null
}

function hasStoredFood(context) {
  const storageCounts = context.blackboard?.get?.('storage.counts') || context.blackboard?.get?.('storage.foodCounts') || {}
  return ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot', 'baked_potato']
    .some(itemName => (storageCounts[itemName] || 0) > 0)
}

module.exports = {
  GOAL_PRIORITIES,
  GOAL_TYPES,
  GoalSystem,
  buildGoalReminderEvent
}
