const {
  acquireActionLocks,
  distance,
  fail,
  ok,
  releaseActionLocks
} = require('./action-utils')
const { HOSTILE_MOBS, nearestHostile } = require('../perception/world-state')

function findNearbyHostileMob(context, maxDistance = 8) {
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')

  const fromBlackboard = context.blackboard?.get?.('mobs.hostileMobs', [])
    .filter(mob => mob.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)[0]

  if (fromBlackboard) {
    const entity = bot.entities?.[fromBlackboard.id]
    if (entity && isHostileMob(entity)) {
      return ok('hostile_found', { mob: entity, summary: fromBlackboard })
    }
  }

  const mob = nearestHostile(bot, maxDistance)
  if (!mob) return fail('hostile_not_found')
  return ok('hostile_found', { mob })
}

async function attackMob(context, mob, options = {}) {
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')
  if (!bot.pvp?.attack && typeof bot.attack !== 'function') return fail('missing_pvp')
  if (!mob?.position) return fail('missing_mob')
  if (mob.username || mob.type === 'player') return fail('refuse_attack_player')
  if (!isHostileMob(mob)) return fail('refuse_attack_non_hostile')

  const maxDistance = options.maxDistance ?? 8
  if (distance(bot.entity.position, mob.position) > maxDistance) return fail('mob_too_far')

  const lock = acquireActionLocks(context, ['movement', 'combat'], 'attackMob', {
    lockTimeoutMs: options.lockTimeoutMs ?? 15000,
    ...options
  })
  if (!lock.ok) return fail(lock.error, lock)

  try {
    let weaponResult = null
    if (context.autoPreparationSystem && typeof context.autoPreparationSystem.ensureCombatWeapon === 'function') {
      weaponResult = await context.autoPreparationSystem.ensureCombatWeapon(context, {
        preferredWeaponType: options.preferredWeaponType,
        preferredWeaponName: options.preferredWeaponName,
        weaponType: options.weaponType,
        weaponName: options.weaponName,
        owner: options.owner || 'attackMob'
      })
      context.logger?.log?.(`[equipment] request=combat selected=${weaponResult.itemName || 'none'} reason=${weaponResult.reason || 'unknown'} fallback=${weaponResult.fallback || 'none'} error=${weaponResult.ok ? 'none' : weaponResult.reason}`)
      if (!weaponResult.ok) return fail(`weapon_preparation_failed:${weaponResult.reason || 'unknown'}`, { weaponResult })
    } else if (context.equipmentSystem && typeof context.equipmentSystem.equipBestWeapon === 'function') {
      weaponResult = await context.equipmentSystem.equipBestWeapon(context, options)
      if (!weaponResult.success && ['missing_weapon', 'no_inventory'].includes(weaponResult.reason)) {
        weaponResult = {
          success: true,
          ok: true,
          reason: 'bare_hand_fallback',
          itemName: 'hand',
          fallbackUsed: true,
          fallback: 'bare_hand'
        }
      }
      context.logger?.log?.(`[equipment] request=combat selected=${weaponResult.itemName || 'none'} reason=${weaponResult.reason || 'unknown'} fallback=${weaponResult.fallback || 'none'} error=${weaponResult.success || weaponResult.ok ? 'none' : weaponResult.reason}`)
      if (!(weaponResult.success || weaponResult.ok)) return fail(`weapon_preparation_failed:${weaponResult.reason || 'unknown'}`, { weaponResult })
    }

    if (bot.pvp?.attack) bot.pvp.attack(mob)
    else if (typeof bot.attack === 'function') bot.attack(mob)
    return ok('attacking', { mobId: mob.id ?? null, name: mob.name, selectedWeapon: weaponResult?.itemName || null })
  } catch (err) {
    releaseActionLocks(context, lock.owner)
    return fail(err.message)
  } finally {
    if (options.holdLock === false) releaseActionLocks(context, lock.owner)
  }
}

function stopCombat(context, options = {}) {
  const bot = context?.bot
  if (options.owner) releaseActionLocks(context, options.owner)
  if (!bot?.pvp?.stop) return fail('missing_pvp')

  try {
    bot.pvp.stop()
    return ok('combat_stopped')
  } catch (err) {
    return fail(err.message)
  }
}

function findNearbyMob(bot, mobName, radius = 8) {
  if (mobName) {
    const pos = bot.entity.position
    return Object.values(bot.entities || {})
      .filter(entity => entity.name === mobName && entity.position && pos.distanceTo(entity.position) <= radius)
      .sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position))[0] || null
  }
  return nearestHostile(bot, radius)
}

function startAttack(bot, entity) {
  bot.pvp.attack(entity)
}

function stopAttack(bot) {
  bot.pvp.stop()
}

function isHostileMob(entity) {
  return Boolean(entity?.name && HOSTILE_MOBS.has(entity.name))
}

module.exports = {
  attackMob,
  findNearbyHostileMob,
  findNearbyMob,
  isHostileMob,
  startAttack,
  stopAttack,
  stopCombat
}
