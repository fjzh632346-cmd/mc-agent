const { attackMob, findNearbyHostileMob, stopCombat } = require('../actions/fight')

class CombatSystem {
  constructor(options = {}) {
    this.options = {
      maxDistance: 10,
      protectPlayerRadius: 8,
      minHealthToFight: 8,
      ...options
    }
  }

  canHandle(task) {
    return ['fight_nearby_mob', 'protect_player', 'combat'].includes(task?.type)
  }

  async run(task = {}, context = {}) {
    const bot = context.bot
    if (!bot?.entity) return { ok: false, error: 'missing_bot' }

    if ((bot.health ?? 20) < (task.params?.minHealthToFight || this.options.minHealthToFight)) {
      stopCombat(context)
      return { ok: false, error: 'health_too_low', data: { health: bot.health } }
    }

    const target = this.pickTarget(context, task)
    if (!target.ok) return target

    const distanceToTarget = distance(bot.entity.position, target.data.mob.position)
    if (context.equipmentSystem?.equipBestArmor) {
      await context.equipmentSystem.equipBestArmor(context, { reason: 'combat' })
    }

    const result = await attackMob(context, target.data.mob, {
      maxDistance: task.params?.maxDistance || this.options.maxDistance,
      owner: task.params?.owner,
      holdLock: task.params?.holdLock ?? true
    })

    if (!result.ok) {
      const action = result.error?.startsWith('missing_weapon') ? enqueueWeaponFallback(context, task) : 'attack'
      log(context, `[combat] target=${target.data.mob.name || 'unknown'} distance=${round(distanceToTarget)} selectedWeapon=${result.weaponResult?.itemName || 'none'} action=${action} result=${result.error}`)
      return result
    }
    log(context, `[combat] target=${target.data.mob.name || 'unknown'} distance=${round(distanceToTarget)} selectedWeapon=${result.data?.selectedWeapon || 'unknown'} action=attack result=ok`)
    return {
      ok: true,
      message: 'combat_started',
      data: {
        target: {
          id: target.data.mob.id ?? null,
          name: target.data.mob.name
        },
        protectingPlayer: target.data.protectingPlayer || false
      }
    }
  }

  pickTarget(context, task = {}) {
    const protectTarget = this.pickThreatNearPlayer(context, task)
    if (protectTarget) {
      return { ok: true, message: 'protect_target_found', data: { mob: protectTarget, protectingPlayer: true } }
    }

    const found = findNearbyHostileMob(context, task.params?.maxDistance || this.options.maxDistance)
    if (!found.ok) return found
    return { ok: true, message: 'hostile_target_found', data: { mob: found.data.mob, protectingPlayer: false } }
  }

  pickThreatNearPlayer(context, task = {}) {
    const bot = context.bot
    const hostileMobs = context.blackboard?.get?.('mobs.hostileMobs', []) || []
    const ownerPosition = context.blackboard?.get?.('player.ownerPosition')
    if (!ownerPosition || !hostileMobs.length) return null

    const protectRadius = task.params?.protectPlayerRadius || this.options.protectPlayerRadius
    const threat = hostileMobs
      .filter(mob => mob.position && distance(mob.position, ownerPosition) <= protectRadius)
      .sort((a, b) => distance(a.position, ownerPosition) - distance(b.position, ownerPosition))[0]

    if (!threat) return null
    const entity = bot.entities?.[threat.id]
    if (!entity || entity.username || entity.type === 'player') return null
    return entity
  }
}

function enqueueWeaponFallback(context, task = {}) {
  const taskManager = context.taskManager
  if (!taskManager?.enqueue) return 'flee'

  const craftTarget = chooseCraftableWeaponTarget(context)
  if (craftTarget) {
    taskManager.enqueue('craft_item', {
      itemName: craftTarget,
      count: 1,
      craftMode: 'specified',
      equipAfter: true
    }, task.priority || 8, 'combat_fallback')
    return 'craft_weapon'
  }

  const knownChestCount = context.memory?.summary?.().world?.chestLocations || 0
  if (knownChestCount > 0) {
    taskManager.enqueue('storage', {
      mode: 'TAKE_ITEMS',
      category: 'weapon',
      itemCategory: 'weapon',
      count: 1
    }, 9, 'combat_fallback')
    return 'fetch_weapon'
  }

  taskManager.enqueue('craft_item', {
    itemName: 'stone_sword',
    count: 1,
    craftMode: 'specified',
    equipAfter: true
  }, task.priority || 8, 'combat_fallback')
  return 'craft_weapon'
}

function chooseCraftableWeaponTarget(context) {
  const counts = {}
  for (const item of context.bot?.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  const planks = countAny(counts, ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
    'crimson_planks', 'warped_planks'])
  const logs = countAny(counts, ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo_block', 'crimson_stem', 'warped_stem'])
  const canMakeStick = (counts.stick || 0) >= 1 || planks >= 2 || logs >= 1
  if ((counts.iron_ingot || 0) >= 2 && canMakeStick) return 'iron_sword'
  if ((counts.cobblestone || 0) >= 2 && canMakeStick) return 'stone_sword'
  if ((planks >= 2 || logs >= 1) && canMakeStick) return 'wooden_sword'
  return null
}

function countAny(counts, names) {
  return names.reduce((sum, name) => sum + (counts[name] || 0), 0)
}

function log(context, message) {
  if (context.logger?.log) context.logger.log(message)
  else if (context.debug) context.debug(message)
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 'unknown'
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

module.exports = { CombatSystem }
