const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'magma_cube', 'enderman', 'silverfish',
  'vindicator', 'evoker', 'vex', 'pillager', 'ravager', 'phantom',
  'drowned', 'husk', 'stray', 'wither_skeleton', 'zombified_piglin'
])

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'apple', 'golden_apple',
  'enchanted_golden_apple', 'carrot', 'baked_potato', 'pumpkin_pie',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'melon_slice',
  'sweet_berries', 'glow_berries', 'dried_kelp', 'cookie'
])

const TOOL_SUFFIXES = [
  '_pickaxe',
  '_axe',
  '_shovel',
  '_hoe',
  '_sword'
]

const { toBlockPos, toBlockVec3 } = require('../utils/position')

class WorldState {
  constructor(options = {}) {
    this.options = {
      entityScanRadius: 24,
      blockScanRadius: 3,
      maxDroppedItems: 20,
      ...options
    }
    this.lastSnapshot = null
  }

  update(context = {}) {
    const bot = context.bot
    if (!bot?.entity) return null

    const snapshot = createWorldSnapshot(bot, {
      ...this.options,
      ownerName: context.ownerName || context.blackboard?.get?.('config.ownerName')
    })

    const taskStatus = context.taskManager?.getTaskSnapshot?.() || context.taskManager?.status?.()
    if (taskStatus) {
      snapshot.tasks = {
        currentTask: taskStatus.currentTask,
        queue: taskStatus.queue,
        pausedStack: taskStatus.pausedStack,
        locks: taskStatus.locks
      }
    }

    context.blackboard?.update?.(snapshot)
    this.lastSnapshot = snapshot
    return snapshot
  }

  getSnapshot() {
    return this.lastSnapshot
  }
}

function createWorldSnapshot(bot, options = {}) {
  const entityScanRadius = options.entityScanRadius || 24
  const blockScanRadius = options.blockScanRadius ?? 3
  const botPosition = toPosition(bot.entity?.position)
  const timeOfDay = bot.time?.timeOfDay ?? null
  const players = scanPlayers(bot, entityScanRadius, options.ownerName)
  const entities = scanEntities(bot, entityScanRadius)
  const inventory = inventorySummary(bot)

  return {
    bot: {
      position: botPosition,
      health: bot.health ?? null,
      food: bot.food ?? null,
      onGround: bot.entity?.onGround ?? null,
      dimension: bot.game?.dimension || bot.dimension || null
    },
    player: {
      nearestPlayer: players.nearestPlayer,
      owner: players.owner,
      ownerPosition: players.owner?.position || null,
      ownerDistance: players.owner?.distance ?? null,
      canSeeOwner: players.ownerRawEntity ? canSeeEntity(bot, players.ownerRawEntity) : false
    },
    world: {
      time: timeOfDay,
      isDay: timeOfDay == null ? null : timeOfDay < 13000 || timeOfDay > 23000,
      weather: weatherSummary(bot),
      nearbyBlocks: scanNearbyBlocks(bot, blockScanRadius),
      droppedItems: entities.droppedItems.slice(0, options.maxDroppedItems || 20)
    },
    mobs: {
      nearbyMobs: entities.nearbyMobs,
      hostileMobs: entities.hostileMobs,
      passiveMobs: entities.passiveMobs,
      nearestHostileMob: entities.nearestHostileMob,
      dangerLevel: calculateDangerLevel(bot, entities.nearestHostileMob)
    },
    inventory
  }
}

function scanPlayers(bot, radius, ownerName) {
  const botPos = bot.entity.position
  const candidates = Object.values(bot.players || {})
    .filter(player => player?.entity && player.username !== bot.username)
    .map(player => ({
      ...serializeEntity(player.entity, botPos, { username: player.username }),
      rawEntity: player.entity
    }))
    .filter(player => player.distance <= radius)
    .sort((a, b) => a.distance - b.distance)

  const owner = ownerName
    ? candidates.find(player => player.username === ownerName) || null
    : candidates[0] || null

  return {
    nearestPlayer: stripRawEntity(candidates[0] || null),
    owner: stripRawEntity(owner),
    ownerRawEntity: owner?.rawEntity || null
  }
}

function scanEntities(bot, radius) {
  const botPos = bot.entity.position
  const nearbyMobs = []
  const hostileMobs = []
  const passiveMobs = []
  const droppedItems = []

  for (const entity of Object.values(bot.entities || {})) {
    if (!entity?.position || entity === bot.entity) continue

    const distance = botPos.distanceTo(entity.position)
    if (distance > radius) continue

    if (isDroppedItemEntity(entity)) {
      droppedItems.push(serializeEntity(entity, botPos))
      continue
    }

    if (!isMobEntity(entity)) continue

    const serialized = serializeEntity(entity, botPos)
    nearbyMobs.push(serialized)
    if (HOSTILE_MOBS.has(entity.name)) hostileMobs.push(serialized)
    else passiveMobs.push(serialized)
  }

  hostileMobs.sort((a, b) => a.distance - b.distance)
  passiveMobs.sort((a, b) => a.distance - b.distance)
  nearbyMobs.sort((a, b) => a.distance - b.distance)
  droppedItems.sort((a, b) => a.distance - b.distance)

  return {
    nearbyMobs,
    hostileMobs,
    passiveMobs,
    nearestHostileMob: hostileMobs[0] || null,
    droppedItems
  }
}

function isMobEntity(entity) {
  if (entity.type === 'mob' || entity.kind === 'mob') return true
  return Boolean(entity.name && entity.username == null && entity.name !== 'item')
}

function isDroppedItemEntity(entity) {
  return entity.name === 'item' ||
    entity.type === 'object' && entity.displayName === 'Item' ||
    entity.kind === 'object' && entity.displayName === 'Item'
}

function serializeEntity(entity, botPos, extra = {}) {
  return {
    id: entity.id ?? null,
    name: entity.name || entity.username || entity.displayName || 'unknown',
    username: extra.username || entity.username || null,
    type: entity.type || entity.kind || null,
    position: toPosition(entity.position),
    distance: roundDistance(botPos.distanceTo(entity.position))
  }
}

function stripRawEntity(entity) {
  if (!entity) return null
  const { rawEntity, ...safeEntity } = entity
  return safeEntity
}

function calculateDangerLevel(bot, nearestHostileMob) {
  if ((bot.health ?? 20) <= 6) return 'critical'
  if (!nearestHostileMob) return 'none'
  if (nearestHostileMob.distance <= 4) return 'high'
  if (nearestHostileMob.distance <= 10) return 'medium'
  return 'low'
}

function inventorySummary(bot) {
  const items = bot.inventory?.items?.() || []
  const counts = inventoryCounts(bot)
  const emptySlots = countEmptyInventorySlots(bot, items)
  const heldItem = bot.heldItem ? serializeItem(bot.heldItem) : null
  const foodCount = items
    .filter(item => FOOD_ITEMS.has(item.name))
    .reduce((sum, item) => sum + item.count, 0)
  const toolCount = items
    .filter(item => TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix)))
    .reduce((sum, item) => sum + item.count, 0)

  return {
    nearFull: emptySlots <= 3,
    emptySlots,
    heldItem,
    foodCount,
    toolCount,
    counts
  }
}

function inventoryCounts(bot) {
  const counts = {}
  for (const item of bot.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return counts
}

function countEmptyInventorySlots(bot, items) {
  const slots = bot.inventory?.slots || []
  if (slots.length > 0) {
    return slots.slice(9, 45).filter(slot => !slot).length
  }
  return Math.max(0, 36 - items.length)
}

function scanNearbyBlocks(bot, radius) {
  if (!bot.blockAt || !bot.entity?.position || radius <= 0) return {}

  const counts = {}
  const base = bot.entity.position
  const center = toBlockPos(base)
  if (!center) return counts

  for (let x = center.x - radius; x <= center.x + radius; x++) {
    for (let y = center.y - 1; y <= center.y + 2; y++) {
      for (let z = center.z - radius; z <= center.z + radius; z++) {
        const block = bot.blockAt(toBlockVec3({ x, y, z }))
        if (!block?.name || block.name === 'air') continue
        counts[block.name] = (counts[block.name] || 0) + 1
      }
    }
  }

  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
  )
}

function weatherSummary(bot) {
  if (bot.isRaining == null && bot.thunderState == null) return null
  if (bot.thunderState > 0) return 'thunder'
  if (bot.isRaining) return 'rain'
  return 'clear'
}

function canSeeEntity(bot, entity) {
  if (!entity) return false
  if (typeof bot.canSeeEntity === 'function') return bot.canSeeEntity(entity)
  return true
}

function nearestHostile(bot, radius = 10) {
  if (!bot.entity) return null
  const pos = bot.entity.position
  return Object.values(bot.entities || {})
    .filter(entity => HOSTILE_MOBS.has(entity.name) && entity.position && pos.distanceTo(entity.position) <= radius)
    .sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position))[0] || null
}

function observe(bot) {
  const snapshot = createWorldSnapshot(bot, {
    entityScanRadius: 12,
    blockScanRadius: 0
  })

  return {
    health: snapshot.bot.health,
    food: snapshot.bot.food,
    position: bot.entity?.position,
    timeOfDay: snapshot.world.time,
    isNight: snapshot.world.time == null ? null : snapshot.world.time >= 13000 && snapshot.world.time <= 23000,
    nearestHostile: snapshot.mobs.nearestHostileMob,
    dangerLevel: snapshot.mobs.dangerLevel,
    inventory: snapshot.inventory.counts,
    emptySlots: snapshot.inventory.emptySlots
  }
}

function toPosition(position) {
  if (!position) return null
  return {
    x: roundDistance(position.x),
    y: roundDistance(position.y),
    z: roundDistance(position.z)
  }
}

function serializeItem(item) {
  return {
    name: item.name,
    count: item.count,
    type: item.type ?? null
  }
}

function roundDistance(value) {
  return Math.round(value * 100) / 100
}

function update(context) {
  const worldState = context.worldState instanceof WorldState
    ? context.worldState
    : new WorldState(context.options)
  return worldState.update(context)
}

module.exports = {
  WorldState,
  HOSTILE_MOBS,
  FOOD_ITEMS,
  inventoryCounts,
  nearestHostile,
  observe,
  update,
  createWorldSnapshot
}
