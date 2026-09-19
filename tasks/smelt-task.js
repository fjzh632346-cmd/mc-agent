const { BaseTask } = require('./base-task')
const { SmeltingSystem } = require('../systems/SmeltingSystem')

class SmeltTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'smelt_item' })
    this.started = false
    this.smeltingSystem = options.smeltingSystem || new SmeltingSystem()
    this.smeltingState = null
  }

  get requiredLocks() {
    return ['inventory', 'crafting', 'movement']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    const smeltingSystem = ctx.smeltingSystem || this.smeltingSystem
    log(ctx, `[smelting] input=${this.params.rawText || this.params.inputName || 'auto'} actionKey=${this.params.actionKey || 'SMELT_ITEM'}`)
    const plan = smeltingSystem.plan(ctx, this.params)
    this.smeltingState = plan.smeltingState || smeltingSystem.getStatus(ctx)
    if (!plan.ok) {
      log(ctx, `[smelting] result=fail smeltedCount=0 failReason=${plan.reason || plan.error}`)
      await this.fail(ctx, compatSmeltReason(plan.reason || plan.error || 'smelt_failed_unknown'))
      return
    }

    log(ctx, `[smelting] targetInput=${plan.targetInput} targetOutput=${plan.targetOutput} count=${plan.plannedCount}`)
    log(ctx, `[smelting] furnaceType=${plan.furnaceType} selectedFurnace=${formatPos(plan.selectedFurnace)}`)
    log(ctx, `[smelting] selectedFuel=${plan.selectedFuel} fuelCount=${plan.fuelCount}`)
    log(ctx, `[smelting] storageInput=false storageFuel=false`)

    const result = await smeltingSystem.execute(ctx, { ...plan, owner: this.id })
    this.smeltingState = result.smeltingState || smeltingSystem.getStatus(ctx)
    if (result.ok) await this.complete(ctx, result)
    else await this.fail(ctx, compatSmeltReason(result.reason || result.error || 'smelt_failed_unknown'))
  }

  toJSON() {
    return {
      ...super.toJSON(),
      smeltingState: this.smeltingState
    }
  }
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function log(ctx, message) {
  if (ctx.logger?.log) ctx.logger.log(message)
  else if (ctx.debug) ctx.debug(message)
}

function compatSmeltReason(reason) {
  if (reason === 'smelt_failed_no_furnace') return 'smelt_failed_no_furnace:furnace_not_found'
  if (reason === 'smelt_failed_no_fuel') return 'smelt_failed_no_fuel:fuel_not_found'
  if (reason === 'smelt_failed_no_input') return 'smelt_failed_no_input:smelt_input_not_found'
  if (reason === 'smelt_failed_insufficient_input') return 'smelt_failed_insufficient_input:smelt_input_not_enough'
  if (reason === 'smelt_failed_insufficient_fuel') return 'smelt_failed_insufficient_fuel:fuel_not_enough'
  return reason
}

module.exports = { SmeltTask }
