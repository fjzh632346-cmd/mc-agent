const fs = require('fs')
const path = require('path')
const { PlanExecutor } = require('./plan-executor')
const { PLAN_STATUS, STEP_STATUS } = require('./planning-status')

const SUPPORTED_PLAN_GOALS = new Set([
  'make_torch',
  'make_stone_pickaxe',
  'make_iron_pickaxe',
  'get_food',
  'remember_farm',
  'harvest_farm',
  'plant_wheat',
  'farm_cycle',
  'make_bread',
  'ensure_food',
  'return_safe',
  'build_small_house',
  'build_two_story_wood_house',
  'build_starter_shelter',
  'build_simple_farmhouse',
  'build_modern_villa',
  'build_castle_garden',
  'build_garden_manor',
  'build_statue',
  'build_fountain',
  'build_fence_area',
  'build_chest_area',
  'build_farm_plot',
  'store_inventory',
  'remember_chest',
  'take_item_from_chest',
  'check_storage',
  'explore_nearby',
  'scout_area',
  'find_resource_area',
  'check_explored_areas',
  'return_if_unsafe',
  'survival_critical_health',
  'survival_danger_nearby',
  'survival_low_food',
  'survival_inventory_full',
  'survival_night_unsafe',
  'survival_too_far_from_base',
  'survival_return_safe'
])

class PlanningSystem {
  constructor(options = {}) {
    this.options = {
      maxCompletedPlans: 25,
      ...options
    }
    this.currentPlan = null
    this.completedPlans = []
    this.failedPlans = []
    this.executor = options.executor || new PlanExecutor(this)
  }

  createPlan(goalType, context = {}, options = {}) {
    const normalizedGoal = normalizeGoal(goalType, options.target)
    if (!SUPPORTED_PLAN_GOALS.has(normalizedGoal)) {
      return { ok: false, error: 'unsupported_plan_goal', goalType }
    }

    const inventory = getInventoryCounts(context)
    const now = new Date().toISOString()
    const plan = {
      id: `plan_${normalizedGoal}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      goalType: normalizedGoal,
      target: options.target || targetForGoal(normalizedGoal),
      status: PLAN_STATUS.PENDING,
      steps: buildSteps(normalizedGoal, inventory, context),
      createdAt: now,
      updatedAt: now,
      failureReason: null
    }

    return { ok: true, plan }
  }

  async createAndSubmitPlan(goalType, context = {}, options = {}) {
    try {
      const created = this.createPlan(goalType, context, options)
      if (!created.ok) return created
      const submitted = await this.submitPlan(created.plan, context)
      return { ok: submitted.ok, plan: submitted.plan, error: submitted.error }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  async submitPlan(plan, context = {}) {
    if (!plan) return { ok: false, error: 'missing_plan' }
    if (this.currentPlan && ![PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED].includes(this.currentPlan.status)) {
      return { ok: false, error: 'plan_already_running', plan: this.currentPlan }
    }
    this.currentPlan = plan
    plan.status = PLAN_STATUS.RUNNING
    plan.updatedAt = new Date().toISOString()
    this.writeStatus(context)
    return { ok: true, plan }
  }

  async update(context = {}) {
    try {
      return await this.executor.update(context)
    } catch (err) {
      if (this.currentPlan) {
        this.currentPlan.status = PLAN_STATUS.FAILED
        this.currentPlan.failureReason = err.message
        this.currentPlan.updatedAt = new Date().toISOString()
        this.failedPlans.push(this.currentPlan)
      }
      this.writeStatus(context)
      return this.status()
    }
  }

  countInventoryItem(context, itemName) {
    return countItem(getInventoryCounts(context), itemName)
  }

  cancelCurrentPlan(reason = 'cancelled') {
    if (!this.currentPlan) return false
    this.currentPlan.status = PLAN_STATUS.CANCELLED
    this.currentPlan.failureReason = reason
    this.currentPlan.updatedAt = new Date().toISOString()
    this.failedPlans.push(this.currentPlan)
    this.currentPlan = null
    return true
  }

  status() {
    const visiblePlan = this.currentPlan || this.failedPlans.at(-1) || null
    const currentPlan = this.currentPlan ? summarizePlan(this.currentPlan) : null
    const currentStep = this.currentPlan?.steps.find(step => step.status === STEP_STATUS.RUNNING || step.status === STEP_STATUS.PENDING) || null
    const failedStep = visiblePlan?.steps.find(step => step.status === STEP_STATUS.FAILED) || null
    const planProgress = visiblePlan ? summarizeProgress(visiblePlan) : null

    return {
      currentPlan,
      planStatus: this.currentPlan?.status || null,
      currentStep: currentStep ? summarizeStep(currentStep) : null,
      planProgress,
      completedSteps: this.currentPlan?.steps.filter(step => step.status === STEP_STATUS.COMPLETED).map(summarizeStep) || [],
      failedStep: failedStep ? summarizeStep(failedStep) : null,
      failureReason: visiblePlan?.failureReason || failedStep?.result?.error || null,
      planFailureReason: visiblePlan?.failureReason || failedStep?.result?.error || null,
      executableSteps: visiblePlan?.steps.filter(isExecutableStep).map(summarizeStep) || [],
      todoSteps: visiblePlan?.steps.filter(step => step.type === 'TODO').map(summarizeStep) || [],
      recentCompletedPlans: this.completedPlans.slice(-5).map(summarizePlan),
      recentFailedPlans: this.failedPlans.slice(-5).map(summarizePlan)
    }
  }

  writeStatus(context) {
    try {
      context.blackboard?.update?.({ planning: this.status() })
    } catch {}
  }

  writeDecisionNeeded(message) {
    const filePath = path.join(process.cwd(), 'docs', 'decision-needed.md')
    const line = `- ${new Date().toISOString()} PlanningSystem: ${message}\n`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '# Decisions Needed\n\n', 'utf8')
      const current = fs.readFileSync(filePath, 'utf8')
      if (!current.includes(message)) fs.appendFileSync(filePath, line, 'utf8')
    } catch {}
  }
}

function buildSteps(goalType, inventory, context) {
  if (goalType === 'make_torch') {
    const steps = [
      step('CHECK_ANY_ITEM', 'fuel', { targets: ['coal', 'charcoal'] }),
      step('CHECK_ITEM', 'stick')
    ]
    if (!hasAny(inventory, ['coal', 'charcoal'])) steps.push(step('MINE_BLOCKS', 'coal', { ore: 'coal', blockName: 'coal_ore', count: 1 }))
    if (!hasItem(inventory, 'stick', 1)) steps.push(step('CRAFT_ITEM', 'stick', { count: 1 }))
    steps.push(step('CRAFT_ITEM', 'torch', { count: 4 }))
    return steps
  }

  if (goalType === 'make_stone_pickaxe') {
    const steps = [step('CHECK_ITEM', 'stick'), step('CHECK_ITEM', 'cobblestone')]
    if (!hasItem(inventory, 'stick', 2)) steps.push(step('CRAFT_ITEM', 'stick', { count: 1 }))
    if (!hasItem(inventory, 'cobblestone', 3)) steps.push(step('MINE_BLOCKS', 'cobblestone', { blockName: 'stone', count: 3 }))
    steps.push(step('CRAFT_ITEM', 'stone_pickaxe', { count: 1 }))
    return steps
  }

  if (goalType === 'make_iron_pickaxe') {
    const steps = [step('CHECK_ITEM', 'stick'), step('CHECK_ITEM', 'iron_ingot')]
    if (!hasItem(inventory, 'stick', 2)) steps.push(step('CRAFT_ITEM', 'stick', { count: 1 }))
    if (!hasItem(inventory, 'iron_ingot', 3)) {
      steps.push(step('CHECK_ANY_ITEM', 'raw_iron_or_iron_ore', { targets: ['raw_iron', 'iron_ore'] }))
      if (!hasAny(inventory, ['raw_iron', 'iron_ore'])) steps.push(step('MINE_BLOCKS', 'iron', { ore: 'iron', blockName: 'iron_ore', count: 3 }))
      steps.push(step('SMELT_ITEM', 'iron_ingot', {
        inputName: hasItem(inventory, 'raw_iron', 1) ? 'raw_iron' : (hasItem(inventory, 'iron_ore', 1) ? 'iron_ore' : null),
        count: 3
      }))
    }
    steps.push(step('CRAFT_ITEM', 'iron_pickaxe', { count: 1 }))
    return steps
  }

  if (goalType === 'get_food') {
    const steps = [step('CHECK_ANY_ITEM', 'food', { targets: ['bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'carrot', 'baked_potato'] })]
    if (getFoodCount(inventory) > 0) steps.push(step('EAT_FOOD', 'food'))
    else if (hasItem(inventory, 'wheat', 3)) steps.push(step('FARMING_TASK', 'make_bread', { mode: 'MAKE_BREAD', priority: 8 }))
    else if (context.memory?.summary?.().world?.farmLocations > 0) steps.push(step('FARMING_TASK', 'farm_cycle', { mode: 'FARM_CYCLE', priority: 6 }))
    else if (context.memory?.summary?.().world?.chestLocations > 0) steps.push(step('STORAGE_TASK', 'take_food_from_chest', { mode: 'TAKE_ITEMS', itemName: 'bread', count: 1, priority: 8 }))
    else steps.push(step('FARMING_TASK', 'ensure_food', { mode: 'EAT_FOOD', priority: 8 }))
    return steps
  }

  if (goalType === 'remember_farm') return [step('FARMING_TASK', 'remember_farm', { mode: 'REMEMBER_FARM' })]
  if (goalType === 'harvest_farm') return [step('FARMING_TASK', 'harvest_farm', { mode: 'HARVEST_FARM' })]
  if (goalType === 'plant_wheat') return [step('FARMING_TASK', 'plant_wheat', { mode: 'PLANT_WHEAT' })]
  if (goalType === 'farm_cycle') return [step('FARMING_TASK', 'farm_cycle', { mode: 'FARM_CYCLE' })]
  if (goalType === 'make_bread') {
    if (!hasItem(inventory, 'wheat', 3)) return [step('FARMING_TASK', 'make_bread', { mode: 'MAKE_BREAD' })]
    return [step('FARMING_TASK', 'make_bread', { mode: 'MAKE_BREAD' })]
  }
  if (goalType === 'ensure_food') return [step('FARMING_TASK', 'ensure_food', { mode: 'EAT_FOOD', priority: 8 })]

  if (goalType === 'return_safe') {
    const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
    if (hasBase) return [step('RETURN_TO_BASE', 'base')]
    return [step('RETURN_TO_PLAYER', 'player')]
  }

  if (goalType.startsWith('build_')) {
    const blueprintName = goalType.replace(/^build_/, '')
    return [step('BUILD_BLUEPRINT', blueprintName, { blueprintName })]
  }

  if (goalType === 'store_inventory') return [step('STORAGE_TASK', 'store_inventory', { mode: 'STORE_ITEMS' })]
  if (goalType === 'remember_chest') return [step('STORAGE_TASK', 'remember_chest', { mode: 'REMEMBER_CHEST' })]
  if (goalType === 'take_item_from_chest') return [step('STORAGE_TASK', 'take_item_from_chest', { mode: 'TAKE_ITEMS', itemName: context.itemName || null })]
  if (goalType === 'check_storage') return [step('STORAGE_TASK', 'check_storage', { mode: 'CHECK_STORAGE' })]

  if (goalType === 'explore_nearby') return buildExplorationSteps(context, 'EXPLORE_NEARBY', { radius: 16 })
  if (goalType === 'scout_area') return buildExplorationSteps(context, 'SCOUT_AREA', { radius: 24 })
  if (goalType === 'find_resource_area') return buildExplorationSteps(context, 'FIND_RESOURCE_AREA', { radius: 32 })
  if (goalType === 'check_explored_areas') return [step('EXPLORATION_TASK', 'check_explored_areas', { mode: 'CHECK_EXPLORED_AREAS' })]
  if (goalType === 'return_if_unsafe') return [step('EXPLORATION_TASK', 'return_if_unsafe', { mode: 'RETURN_IF_UNSAFE', priority: 7 })]

  if (goalType === 'survival_critical_health') {
    if (getFoodCount(inventory) > 0) return [step('EAT_FOOD', 'food', { priority: 10 })]
    return buildReturnSafeSteps(context)
  }
  if (goalType === 'survival_danger_nearby') return [step('GUARD_PLAYER', 'danger', { priority: 9 })]
  if (goalType === 'survival_low_food') {
    if (getFoodCount(inventory) > 0) return [step('EAT_FOOD', 'food', { priority: 9 })]
    if (context.memory?.summary?.().world?.chestLocations > 0) return [step('STORAGE_TASK', 'take_food_from_chest', { mode: 'TAKE_ITEMS', itemName: 'bread', count: 1, priority: 8 })]
    if (hasItem(inventory, 'wheat', 3)) return [step('FARMING_TASK', 'make_bread', { mode: 'MAKE_BREAD', priority: 8 })]
    if (context.memory?.summary?.().world?.farmLocations > 0) return [step('FARMING_TASK', 'farm_cycle', { mode: 'FARM_CYCLE', priority: 6 })]
    return [step('FARMING_TASK', 'ensure_food', { mode: 'EAT_FOOD', priority: 8 })]
  }
  if (goalType === 'survival_inventory_full') {
    if (context.memory?.summary?.().world?.chestLocations > 0) return [step('STORAGE_TASK', 'store_inventory', { mode: 'INVENTORY_FULL_STORE', priority: 6 })]
    return buildReturnSafeSteps(context)
  }
  if (goalType === 'survival_night_unsafe') return buildReturnSafeSteps(context)
  if (goalType === 'survival_too_far_from_base') return buildReturnSafeSteps(context)
  if (goalType === 'survival_return_safe') return buildReturnSafeSteps(context)

  return []
}

function buildReturnSafeSteps(context) {
  const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
  return hasBase ? [step('RETURN_TO_BASE', 'base', { priority: 8 })] : [step('RETURN_TO_PLAYER', 'player', { priority: 8 })]
}

function buildExplorationSteps(context, mode, options = {}) {
  const danger = context.blackboard?.get?.('mobs.dangerLevel')
  if (danger === 'high' || danger === 'critical') {
    return [step('EXPLORATION_TASK', mode.toLowerCase(), { mode, radius: options.radius, priority: 3 })]
  }
  const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
  const radius = hasBase ? options.radius : Math.min(options.radius || 16, 16)
  return [step('EXPLORATION_TASK', mode.toLowerCase(), { mode, radius, priority: 3 })]
}

function step(type, target, extra = {}) {
  return {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    target,
    status: STEP_STATUS.PENDING,
    ...extra
  }
}

function getInventoryCounts(context) {
  const counts = context.blackboard?.get?.('inventory.counts')
  if (counts) return counts
  const result = {}
  for (const item of context.bot?.inventory?.items?.() || []) {
    result[item.name] = (result[item.name] || 0) + item.count
  }
  return result
}

function countItem(inventory, itemName) {
  return inventory[itemName] || 0
}

function hasItem(inventory, itemName, count) {
  return countItem(inventory, itemName) >= count
}

function hasAny(inventory, itemNames) {
  return itemNames.some(itemName => countItem(inventory, itemName) > 0)
}

function getFoodCount(inventory) {
  return ['bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'carrot', 'baked_potato']
    .reduce((sum, itemName) => sum + countItem(inventory, itemName), 0)
}

function normalizeGoal(goalType, target) {
  if (goalType) return goalType
  const targets = {
    torch: 'make_torch',
    stone_pickaxe: 'make_stone_pickaxe',
    iron_pickaxe: 'make_iron_pickaxe',
    food: 'get_food',
    safe: 'return_safe',
    small_house: 'build_small_house',
    house: 'build_two_story_wood_house',
    two_story_wood_house: 'build_two_story_wood_house',
    starter_shelter: 'build_starter_shelter',
    simple_farmhouse: 'build_simple_farmhouse',
    modern_villa: 'build_modern_villa',
    castle_garden: 'build_castle_garden',
    garden_manor: 'build_garden_manor',
    statue: 'build_statue',
    fountain: 'build_fountain',
    fence_area: 'build_fence_area',
    chest_area: 'build_chest_area',
    farm_plot: 'build_farm_plot'
  }
  return targets[target] || target
}

function targetForGoal(goalType) {
  return goalType.replace(/^make_/, '')
}

function summarizePlan(plan) {
  return {
    id: plan.id,
    goalType: plan.goalType,
    target: plan.target,
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    failureReason: plan.failureReason
  }
}

function summarizeStep(step) {
  return {
    id: step.id,
    type: step.type,
    target: step.target,
    status: step.status,
    taskId: step.taskId || null,
    error: step.result?.error || null
  }
}

function summarizeProgress(plan) {
  const total = plan.steps.length
  const completed = plan.steps.filter(step => step.status === STEP_STATUS.COMPLETED).length
  const failed = plan.steps.filter(step => step.status === STEP_STATUS.FAILED).length
  const skipped = plan.steps.filter(step => step.status === STEP_STATUS.SKIPPED).length
  return {
    total,
    completed,
    failed,
    skipped,
    pending: plan.steps.filter(step => step.status === STEP_STATUS.PENDING).length,
    running: plan.steps.filter(step => step.status === STEP_STATUS.RUNNING).length,
    percent: total === 0 ? 100 : Math.round((completed / total) * 100)
  }
}

function isExecutableStep(step) {
  return ['CRAFT_ITEM', 'SMELT_ITEM', 'MINE_BLOCKS', 'EAT_FOOD', 'RETURN_TO_PLAYER', 'RETURN_TO_BASE', 'BUILD_BLUEPRINT', 'STORAGE_TASK', 'FARMING_TASK', 'EXPLORATION_TASK', 'GUARD_PLAYER'].includes(step.type)
}

module.exports = {
  PLAN_STATUS,
  STEP_STATUS,
  SUPPORTED_PLAN_GOALS,
  PlanningSystem
}
