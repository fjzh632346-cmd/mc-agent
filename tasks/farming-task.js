const { BaseTask, TASK_STATE } = require('./base-task')
const { stopMoving } = require('../actions/move')
const { FarmingSystem } = require('../systems/farming-system')

const FARMING_MODES = Object.freeze({
  REMEMBER_FARM: 'REMEMBER_FARM',
  HARVEST_FARM: 'HARVEST_FARM',
  PLANT_WHEAT: 'PLANT_WHEAT',
  FARM_CYCLE: 'FARM_CYCLE',
  MAKE_BREAD: 'MAKE_BREAD',
  EAT_FOOD: 'EAT_FOOD',
  CHECK_FOOD: 'CHECK_FOOD'
})

class FarmingTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'farming' })
    this.system = new FarmingSystem(options.params?.farmingOptions || {})
    this.started = false
    this.mode = options.params?.mode || FARMING_MODES.FARM_CYCLE
    this.targetFarm = null
    this.matureWheatCount = 0
    this.harvestedItems = []
    this.plantedCount = 0
    this.madeBreadCount = 0
    this.eatenFood = null
    this.missingSeeds = false
    this.missingWheat = false
    this.failedReason = null
    this.farmingStatus = 'IDLE'
    this.preparation = null
  }

  get requiredLocks() {
    if (this.mode === FARMING_MODES.REMEMBER_FARM || this.mode === FARMING_MODES.CHECK_FOOD) return []
    if (this.mode === FARMING_MODES.MAKE_BREAD) return ['movement', 'crafting']
    if (this.mode === FARMING_MODES.EAT_FOOD) return ['movement', 'inventory', 'crafting']
    if (this.mode === FARMING_MODES.PLANT_WHEAT) return ['movement', 'inventory']
    if (this.mode === FARMING_MODES.HARVEST_FARM) return ['movement', 'digging']
    return ['movement', 'digging', 'inventory', 'crafting']
  }

  async start(ctx) {
    await super.start(ctx)
  }

  async update(ctx) {
    if (this.state !== TASK_STATE.RUNNING) return
    await super.update(ctx)
    const logPrefix = taskLogPrefix(this.mode)
    console.log(`[${logPrefix}_TASK_START] mode=${this.mode} taskId=${this.id}`)
    if (isDangerHigh(ctx) && ![FARMING_MODES.EAT_FOOD, FARMING_MODES.CHECK_FOOD].includes(this.mode)) {
      console.log(`[${logPrefix}_TASK_FAILED] mode=${this.mode} reason=danger_too_high actionCount=0`)
      await this.fail(ctx, 'danger_too_high')
      return
    }

    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    const result = await this.runFarmingAction(ctx)
    if (this.state !== TASK_STATE.RUNNING) return
    this.syncFarmingState()
    if (result.ok) {
      console.log(`[${logPrefix}_TASK_SUCCESS] mode=${this.mode} actionCount=${taskActionCount(this, result)} movedCount=${taskMovedCount(result)} reason=${result.reason || 'ok'}`)
      await this.complete(ctx, this.farmingResult(result))
    } else {
      console.log(`[${logPrefix}_TASK_FAILED] mode=${this.mode} reason=${result.error || 'farming_failed'} actionCount=${taskActionCount(this, result)}`)
      await this.fail(ctx, result.error || 'farming_failed')
    }
  }

  async runFarmingAction(ctx) {
    const options = {
      owner: this.id,
      position: this.params.position || null,
      radius: this.params.radius || null,
      count: this.params.count || null,
      foodName: this.params.foodName || this.params.itemName || null,
      mode: this.mode,
      shouldContinue: () => this.state === TASK_STATE.RUNNING
    }

    const prepared = await this.prepareFarmingItems(ctx, options)
    this.preparation = prepared
    if (!prepared.ok) {
      return this.system.fail(prepared.reason || prepared.error || 'farming_preparation_failed', {
        preparation: prepared,
        missingSeeds: prepared.reason === 'missing_seeds' || prepared.missingSeeds > 0,
        actionCount: 0
      })
    }

    if (this.mode === FARMING_MODES.REMEMBER_FARM) return this.system.rememberFarm(ctx, options.position, options)
    if (this.mode === FARMING_MODES.HARVEST_FARM) return this.system.harvestMatureWheat(ctx, options)
    if (this.mode === FARMING_MODES.PLANT_WHEAT) return this.system.replantWheat(ctx, options)
    if (this.mode === FARMING_MODES.MAKE_BREAD) return this.system.makeBreadIfPossible(ctx, options)
    if (this.mode === FARMING_MODES.EAT_FOOD) return this.system.ensureFood(ctx, options)
    if (this.mode === FARMING_MODES.CHECK_FOOD) return this.system.checkFoodStatus(ctx, options)
    return this.system.farmCycle(ctx, options)
  }

  async prepareFarmingItems(ctx, options = {}) {
    if (![FARMING_MODES.HARVEST_FARM, FARMING_MODES.PLANT_WHEAT, FARMING_MODES.FARM_CYCLE].includes(this.mode)) {
      return { ok: true, reason: 'preparation_not_required', mode: this.mode }
    }

    if (this.mode === FARMING_MODES.HARVEST_FARM) {
      if (ctx.autoPreparationSystem?.ensureFarmingItems) {
        return ctx.autoPreparationSystem.ensureFarmingItems(ctx, {
          mode: this.mode,
          owner: this.id,
          taskId: this.id,
          requiresSeeds: false
        })
      }
      return {
        ok: true,
        reason: 'harvest_requires_no_tool',
        mode: this.mode,
        itemName: 'hand',
        allowHand: true,
        canExecuteBareHand: true
      }
    }

    const plan = this.system.getPreparationPlan(ctx, options)
    if (!plan.ok) return { ok: false, reason: plan.error || 'farming_preparation_plan_failed', mode: this.mode, plan }
    if (!plan.requiresSeeds) return { ok: true, reason: 'no_seed_work_required', mode: this.mode, plan }

    if (!ctx.autoPreparationSystem?.ensureFarmingItems) {
      if (plan.seedCount >= plan.requiredSeeds) {
        return { ok: true, reason: 'seeds_available', mode: this.mode, plan }
      }
      return {
        ok: false,
        reason: 'missing_seeds',
        mode: this.mode,
        itemName: 'wheat_seeds',
        requiredSeeds: plan.requiredSeeds,
        currentSeeds: plan.seedCount,
        missingSeeds: plan.requiredSeeds - plan.seedCount,
        plan
      }
    }

    const prepared = await ctx.autoPreparationSystem.ensureFarmingItems(ctx, {
      mode: this.mode,
      owner: this.id,
      taskId: this.id,
      requiredSeeds: plan.requiredSeeds,
      allowStorage: this.params.allowStorageFallback !== false,
      requiresSeeds: true
    })
    return {
      ...prepared,
      plan
    }
  }

  syncFarmingState() {
    const status = this.system.getStatus()
    this.targetFarm = status.targetFarm || this.targetFarm
    this.matureWheatCount = status.matureWheatCount ?? this.matureWheatCount
    this.harvestedItems = status.harvestedItems || this.harvestedItems
    this.plantedCount = status.plantedCount ?? this.plantedCount
    this.madeBreadCount = status.madeBreadCount ?? this.madeBreadCount
    this.eatenFood = status.eatenFood || this.eatenFood
    this.missingSeeds = Boolean(status.missingSeeds)
    this.missingWheat = Boolean(status.missingWheat)
    this.failedReason = status.lastFarmingError || this.failedReason
    this.farmingStatus = status.farmingStatus || this.farmingStatus
  }

  async pause(ctx, reason) {
    stopMoving(ctx, { owner: this.id })
    this.started = false
    await super.pause(ctx, reason)
  }

  async resume(ctx) {
    await super.resume(ctx)
  }

  async interrupt(ctx, reason) {
    stopMoving(ctx, { owner: this.id })
    await super.interrupt(ctx, reason)
  }

  async fail(ctx, error) {
    this.failedReason = error instanceof Error ? error.message : String(error)
    this.farmingStatus = 'FAILED'
    await super.fail(ctx, error)
  }

  farmingResult(result) {
    return {
      ...result,
      mode: this.mode,
      targetFarm: this.targetFarm,
      matureWheatCount: this.matureWheatCount,
      harvestedItems: this.harvestedItems,
      plantedCount: this.plantedCount,
      madeBreadCount: this.madeBreadCount,
      eatenFood: this.eatenFood,
      missingSeeds: this.missingSeeds,
      missingWheat: this.missingWheat,
      farmingStatus: this.farmingStatus
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mode: this.mode,
      targetFarm: this.targetFarm,
      matureWheatCount: this.matureWheatCount,
      harvestedItems: this.harvestedItems,
      plantedCount: this.plantedCount,
      madeBreadCount: this.madeBreadCount,
      eatenFood: this.eatenFood,
      missingSeeds: this.missingSeeds,
      missingWheat: this.missingWheat,
      failedReason: this.failedReason,
      farmingStatus: this.farmingStatus,
      preparation: this.preparation,
      lastFarmingError: this.failedReason
    }
  }
}

function isDangerHigh(context) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return dangerLevel === 'high' || dangerLevel === 'critical'
}

function taskLogPrefix(mode) {
  if (mode === FARMING_MODES.MAKE_BREAD) return 'CRAFT_BREAD'
  if ([FARMING_MODES.EAT_FOOD, FARMING_MODES.CHECK_FOOD].includes(mode)) return 'FOOD'
  return 'FARMING'
}

function taskActionCount(task, result = {}) {
  if (Number.isFinite(result.actionCount)) return result.actionCount
  return (task.harvestedItems?.length || 0) + (task.plantedCount || 0) + (task.madeBreadCount || 0) + (task.eatenFood ? 1 : 0)
}

function taskMovedCount(result = {}) {
  return Number.isFinite(result.movedCount) ? result.movedCount : 0
}

module.exports = {
  FARMING_MODES,
  FarmingTask
}
