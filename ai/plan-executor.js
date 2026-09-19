const { PLAN_STATUS, STEP_STATUS } = require('./planning-status')

class PlanExecutor {
  constructor(planningSystem, options = {}) {
    this.planningSystem = planningSystem
    this.options = options
  }

  async update(context = {}) {
    const plan = this.planningSystem.currentPlan
    if (!plan || isTerminalPlan(plan)) return this.planningSystem.status()

    if (plan.status === PLAN_STATUS.PENDING) {
      plan.status = PLAN_STATUS.RUNNING
      plan.updatedAt = new Date().toISOString()
    }

    const activeTaskResult = this.checkActiveTask(plan, context)
    if (activeTaskResult === 'waiting') {
      this.planningSystem.writeStatus(context)
      return this.planningSystem.status()
    }
    if (activeTaskResult === 'failed') {
      this.planningSystem.writeStatus(context)
      return this.planningSystem.status()
    }

    if (shouldStopForDanger(plan, context)) {
      this.failPlan(plan, 'danger_too_high_for_low_priority_plan')
      this.planningSystem.writeStatus(context)
      return this.planningSystem.status()
    }

    while (!isTerminalPlan(plan)) {
      const step = nextRunnableStep(plan)
      if (!step) {
        this.completePlan(plan)
        break
      }

      if (step.status === STEP_STATUS.RUNNING) break
      await this.startStep(plan, step, context)
      if (step.status === STEP_STATUS.RUNNING || step.status === STEP_STATUS.FAILED) break
    }

    this.planningSystem.writeStatus(context)
    return this.planningSystem.status()
  }

  async startStep(plan, step, context) {
    step.status = STEP_STATUS.RUNNING
    step.startedAt = new Date().toISOString()
    step.updatedAt = step.startedAt

    const result = await this.executeStep(step, context)
    step.result = result
    step.updatedAt = new Date().toISOString()

    if (result.waitForTask) {
      step.taskId = result.task?.id ?? null
      step.status = step.taskId ? STEP_STATUS.RUNNING : STEP_STATUS.COMPLETED
      return
    }

    if (result.ok) {
      step.status = STEP_STATUS.COMPLETED
      return
    }

    step.status = STEP_STATUS.FAILED
    this.failPlan(plan, result.error || 'step_failed', step)
  }

  executeStep(step, context = {}) {
    switch (step.type) {
      case 'CHECK_ITEM':
        return {
          ok: true,
          message: 'checked',
          itemName: step.target,
          count: this.planningSystem.countInventoryItem(context, step.target)
        }
      case 'CHECK_ANY_ITEM':
        return {
          ok: true,
          message: 'checked_any',
          targets: step.targets || [],
          found: (step.targets || []).some(target => this.planningSystem.countInventoryItem(context, target) > 0)
        }
      case 'CRAFT_ITEM':
        return this.enqueueTask(context, 'craft_item', { itemName: step.target, count: step.count || 1 }, step.priority || 5)
      case 'SMELT_ITEM':
        return this.enqueueTask(context, 'smelt_item', {
          inputName: step.inputName,
          outputName: step.target,
          count: step.count || 1
        }, step.priority || 5)
      case 'MINE_BLOCKS':
        return this.enqueueTask(context, 'mining', {
          blockName: step.blockName,
          ore: step.ore,
          count: step.count || 1,
          maxDistance: step.maxDistance || 24
        }, step.priority || 5)
      case 'EAT_FOOD':
        return this.enqueueTask(context, 'eat_food', {}, step.priority || 7)
      case 'RETURN_TO_PLAYER':
        return this.enqueueTask(context, 'return_to_player', {}, step.priority || 7)
      case 'RETURN_TO_BASE':
        return this.enqueueTask(context, 'return_to_base', {}, step.priority || 7)
      case 'GUARD_PLAYER':
        return this.enqueueTask(context, 'guard_player', {
          durationMs: step.durationMs || 15000,
          radius: step.radius || 8
        }, step.priority || 9)
      case 'BUILD_BLUEPRINT':
        return this.enqueueTask(context, 'build_blueprint', {
          blueprintName: step.blueprintName || step.target,
          origin: step.origin || null
        }, step.priority || 5)
      case 'STORAGE_TASK':
        return this.enqueueTask(context, 'storage', {
          mode: step.mode,
          itemName: step.itemName || null,
          count: step.count || null
        }, step.priority || 5)
      case 'FARMING_TASK':
        return this.enqueueTask(context, 'farming', {
          mode: step.mode,
          itemName: step.itemName || null,
          count: step.count || null
        }, step.priority || 5)
      case 'EXPLORATION_TASK':
        return this.enqueueTask(context, 'exploration', {
          mode: step.mode,
          radius: step.radius || null,
          target: step.target || null
        }, step.priority || 3)
      case 'TODO':
        this.planningSystem.writeDecisionNeeded?.(step.message || step.target)
        return { ok: false, error: `todo:${step.target || step.message}` }
      default:
        return { ok: false, error: `unknown_step_type:${step.type}` }
    }
  }

  enqueueTask(context, type, params, priority) {
    if (!context.taskManager?.enqueue) return { ok: false, error: 'task_manager_missing' }
    const task = context.taskManager.enqueue(type, params, priority, 'planning_system')
    return { ok: true, message: 'task_enqueued', task, waitForTask: true }
  }

  checkActiveTask(plan, context = {}) {
    const step = plan.steps.find(candidate => candidate.status === STEP_STATUS.RUNNING && candidate.taskId)
    if (!step) return 'none'

    const status = context.taskManager?.status?.() || {}
    const task = findTaskById(status, step.taskId)
    if (!task) return 'waiting'

    if (task.state === 'COMPLETED') {
      step.status = STEP_STATUS.COMPLETED
      step.result = task.result || task
      step.completedAt = new Date().toISOString()
      step.updatedAt = step.completedAt
      return 'completed'
    }

    if (task.state === 'FAILED' || task.state === 'INTERRUPTED') {
      step.status = STEP_STATUS.FAILED
      step.result = task
      step.updatedAt = new Date().toISOString()
      this.failPlan(plan, task.error || task.interruptReason || 'task_failed', step)
      return 'failed'
    }

    return 'waiting'
  }

  completePlan(plan) {
    plan.status = PLAN_STATUS.COMPLETED
    plan.updatedAt = new Date().toISOString()
    this.planningSystem.completedPlans.push(plan)
    this.planningSystem.completedPlans = this.planningSystem.completedPlans.slice(-this.planningSystem.options.maxCompletedPlans)
    this.planningSystem.currentPlan = null
  }

  failPlan(plan, reason, step = null) {
    plan.status = PLAN_STATUS.FAILED
    plan.failureReason = reason
    plan.failedStepId = step?.id || plan.failedStepId || null
    plan.updatedAt = new Date().toISOString()
    if (!this.planningSystem.failedPlans.includes(plan)) this.planningSystem.failedPlans.push(plan)
  }
}

function findTaskById(status, id) {
  const candidates = [
    status.currentTask,
    ...(status.queue || []),
    ...(status.pausedStack || []),
    ...(status.recentCompleted || []),
    ...(status.recentFailed || []),
    ...(status.recentInterrupted || [])
  ].filter(Boolean)
  return candidates.find(task => task.id === id) || null
}

function nextRunnableStep(plan) {
  return plan.steps.find(step => [STEP_STATUS.PENDING, STEP_STATUS.RUNNING].includes(step.status)) || null
}

function isTerminalPlan(plan) {
  return [PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED].includes(plan.status)
}

function shouldStopForDanger(plan, context = {}) {
  if (plan.goalType === 'return_safe') return false
  const danger = context.blackboard?.get?.('mobs.dangerLevel')
  return danger === 'high' || danger === 'critical'
}

module.exports = { PlanExecutor }
