const { BaseTask, TASK_STATE } = require('./base-task')

class PrepareCombatTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'prepare_combat' })
    this.started = false
    this.weapon = null
    this.armor = null
    this.food = null
    this.missing = []
    this.combatReadyState = null
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

    const equipment = ctx.equipmentSystem
    if (!equipment) return this.fail(ctx, 'equipment_system_missing')

    const weapon = await ensureCombatWeapon(ctx, this.params || {})
    const armor = await equipment.equipBestArmor?.(ctx, { reason: 'prepare_combat' })
    const food = equipment.selectBestFood?.(ctx, { reason: 'prepare_combat' })

    this.weapon = weapon || null
    this.armor = armor || null
    this.food = food || null
    this.missing = [
      weapon?.ok === false || weapon?.success === false ? 'weapon' : null,
      armor?.success === false ? 'armor' : null,
      food?.success === false ? 'food' : null
    ].filter(Boolean)

    const armorState = equipment.getArmorStatus?.(ctx) || null
    this.combatReadyState = {
      hasWeapon: weapon?.fallbackUsed !== true && (weapon?.ok === true || weapon?.success === true),
      selectedWeapon: weapon?.itemName || null,
      weaponFallback: weapon?.fallback || null,
      hasArmor: Boolean((armorState?.armorLevel || 0) > 0 || (armor?.equippedCount || 0) > 0),
      armorEquipped: armor?.equippedCount || 0,
      hasFood: food?.success === true,
      missing: this.missing,
      readiness: weapon?.ok === true || weapon?.success === true ? 'ready' : 'not_ready',
      lastPrepareCombatError: weapon?.ok === false || weapon?.success === false ? weapon.reason : null,
      craftAttempt: false,
      craftTarget: null,
      craftResult: null
    }

    log(ctx, `[equipment] request=prepare_combat selected=${JSON.stringify({ weapon: weapon?.itemName || null, food: food?.itemName || null })} reason=player_command fallback=${weapon?.fallback || 'none'} error=${weapon?.ok === false || weapon?.success === false ? weapon.reason : 'none'}`)
    log(ctx, `[armor] current=${JSON.stringify(armorState)} available=${JSON.stringify(armorState?.bestAvailableArmor || {})} selected=${JSON.stringify(armor?.results || [])} equipped=${armor?.equippedCount || 0} reason=prepare_combat`)
    log(ctx, `[crafting] input=prepare_combat targetItem=null skipped=true reason=combat_preparation_not_crafting`)

    if (weapon?.ok === false || weapon?.success === false) {
      const fallback = enqueueWeaponFallback(ctx, this.priority)
      this.combatReadyState.craftAttempt = fallback.action === 'craft_weapon'
      this.combatReadyState.craftTarget = fallback.craftTarget || null
      this.combatReadyState.craftResult = fallback.result
      log(ctx, `[prepare-combat] hasWeapon=false selectedWeapon=none craftAttempt=${this.combatReadyState.craftAttempt} craftTarget=${this.combatReadyState.craftTarget || 'none'} craftResult=${fallback.result}`)
      return this.fail(ctx, weapon.reason || 'missing_weapon')
    }

    return this.complete(ctx, {
      weapon,
      armor,
      food,
      missing: this.missing,
      ready: this.missing.length === 0,
      combatReadyState: this.combatReadyState
    })
  }

  toJSON() {
    return {
      ...super.toJSON(),
      weapon: this.weapon,
      armor: this.armor,
      food: this.food,
      missing: this.missing,
      combatReadyState: this.combatReadyState
    }
  }
}

async function ensureCombatWeapon(ctx, params = {}) {
  if (ctx.autoPreparationSystem?.ensureCombatWeapon) {
    return ctx.autoPreparationSystem.ensureCombatWeapon(ctx, params)
  }

  const result = await ctx.equipmentSystem?.equipBestWeapon?.(ctx, params)
  if (!result || ['missing_weapon', 'no_inventory'].includes(result.reason)) {
    return {
      ok: true,
      success: true,
      reason: 'bare_hand_fallback',
      itemName: 'hand',
      fallbackUsed: true,
      fallback: 'bare_hand',
      allowHand: true,
      canExecuteBareHand: true,
      selection: result || null
    }
  }
  return result.success === false ? { ok: false, ...result } : { ok: true, ...result }
}

function enqueueWeaponFallback(ctx, priority = 8) {
  const taskManager = ctx.taskManager
  if (!taskManager?.enqueue) return { action: 'none', result: 'missing_task_manager' }

  const craftTarget = chooseCraftableWeaponTarget(ctx)
  if (craftTarget) {
    taskManager.enqueue('craft_item', {
      itemName: craftTarget,
      count: 1,
      craftMode: 'specified',
      equipAfter: true
    }, priority, 'prepare_combat_fallback')
    log(ctx, `[combat] target=none distance=unknown selectedWeapon=none action=craft_weapon result=queued reason=missing_weapon craftTarget=${craftTarget}`)
    return { action: 'craft_weapon', result: 'queued', craftTarget }
  }

  const knownChestCount = ctx.memory?.summary?.().world?.chestLocations || 0
  if (knownChestCount > 0) {
    taskManager.enqueue('storage', {
      mode: 'TAKE_ITEMS',
      category: 'weapon',
      itemCategory: 'weapon',
      count: 1
    }, priority + 1, 'prepare_combat_fallback')
    log(ctx, '[combat] target=none distance=unknown selectedWeapon=none action=fetch_weapon result=queued reason=missing_weapon')
    return { action: 'fetch_weapon', result: 'queued' }
  }

  log(ctx, '[combat] target=none distance=unknown selectedWeapon=none action=craft_weapon result=missing_materials reason=missing_weapon')
  return { action: 'craft_weapon', result: 'missing_materials' }
}

function chooseCraftableWeaponTarget(ctx) {
  const counts = getInventoryCounts(ctx)
  const planks = countAny(counts, ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
    'crimson_planks', 'warped_planks'])
  const logs = countAny(counts, ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo_block', 'crimson_stem', 'warped_stem'])
  const sticks = counts.stick || 0
  const canMakeStick = sticks >= 1 || planks >= 2 || logs >= 1

  if ((counts.iron_ingot || 0) >= 2 && canMakeStick) return 'iron_sword'
  if ((counts.cobblestone || 0) >= 2 && canMakeStick) return 'stone_sword'
  if ((planks >= 2 || logs >= 1) && canMakeStick) return 'wooden_sword'
  return null
}

function getInventoryCounts(ctx) {
  const blackboardCounts = ctx.blackboard?.get?.('inventory.counts')
  if (blackboardCounts) return { ...blackboardCounts }
  const counts = {}
  for (const item of ctx.bot?.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return counts
}

function countAny(counts, names) {
  return names.reduce((sum, name) => sum + (counts[name] || 0), 0)
}

function log(ctx, message) {
  if (ctx.logger?.log) ctx.logger.log(message)
  else if (ctx.debug) ctx.debug(message)
}

module.exports = { PrepareCombatTask }
