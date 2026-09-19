const { BaseTask, TASK_STATE } = require('./base-task')

class EquipArmorTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'equip_armor' })
    this.started = false
    this.armorState = null
    this.equipResult = null
  }

  get requiredLocks() {
    return ['inventory']
  }

  async update(ctx) {
    if (this.state !== TASK_STATE.RUNNING) return
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    const equipment = ctx.equipmentSystem || ctx.taskManager?.options?.equipmentSystem || null
    if (!equipment?.equipBestArmor) {
      log(ctx, '[armor] current=null available={} selected=[] equipped=0 reason=equipment_system_missing')
      return this.fail(ctx, 'equipment_system_missing')
    }

    const before = equipment.getArmorStatus?.(ctx) || null
    const result = await equipment.equipBestArmor(ctx, { reason: this.params?.reason || 'player_command' })
    const after = equipment.getArmorStatus?.(ctx) || before

    this.equipResult = result
    this.armorState = after

    log(ctx, `[armor] current=${JSON.stringify(summarizeArmor(after))} available=${JSON.stringify(after?.bestAvailableArmor || {})} selected=${JSON.stringify(result?.results || [])} equipped=${result?.equippedCount || 0} reason=${result?.reason || 'equip_armor_task'}`)

    if (result?.success === false) return this.fail(ctx, result.reason || 'equip_armor_failed')
    return this.complete(ctx, { equipResult: result, armorState: after })
  }

  toJSON() {
    return {
      ...super.toJSON(),
      armorState: this.armorState,
      equipResult: this.equipResult
    }
  }
}

function summarizeArmor(armorState) {
  if (!armorState) return null
  return {
    helmet: armorState.helmet?.name || null,
    chestplate: armorState.chestplate?.name || null,
    leggings: armorState.leggings?.name || null,
    boots: armorState.boots?.name || null
  }
}

function log(ctx, message) {
  if (ctx.logger?.log) ctx.logger.log(message)
  else if (ctx.debug) ctx.debug(message)
}

module.exports = { EquipArmorTask }
