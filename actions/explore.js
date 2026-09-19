const { moveTo } = require('./move')
const { distance, fail, normalizePosition, ok } = require('./action-utils')
const { toBlockVec3 } = require('../utils/position')

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned',
  'husk', 'stray', 'pillager', 'slime'
])
const RESOURCE_BLOCKS = new Set([
  'coal_ore', 'iron_ore', 'copper_ore', 'deepslate_coal_ore', 'deepslate_iron_ore',
  'deepslate_copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore',
  'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore'
])
const DANGER_BLOCKS = new Set(['lava', 'fire', 'cactus', 'magma_block'])
const WATER_BLOCKS = new Set(['water'])
const STRUCTURE_BLOCKS = new Set(['chest', 'crafting_table', 'furnace', 'farmland', 'hay_block', 'bell', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'])
const LANDMARK_BLOCKS = new Set([
  'sandstone', 'smooth_sandstone', 'cut_sandstone', 'chiseled_sandstone', 'orange_terracotta', 'blue_terracotta',
  'bed', 'white_bed', 'yellow_bed', 'red_bed', 'composter', 'cartography_table', 'smithing_table', 'fletching_table', 'grindstone', 'dirt_path',
  'obsidian', 'crying_obsidian', 'netherrack', 'gold_block',
  'rail', 'oak_planks', 'oak_fence', 'cobweb',
  'jungle_planks', 'jungle_log', 'mossy_cobblestone', 'tripwire_hook',
  'dark_oak_planks', 'spruce_planks'
])

function getRandomNearbyPosition(context, radius = 8) {
  const bot = context?.bot
  if (!bot?.entity?.position) return fail('missing_bot_position')
  if (isDangerHigh(context)) return fail('danger_too_high')

  const safeRadius = Math.min(Math.max(Number(radius) || 8, 1), 16)
  const angle = Math.random() * Math.PI * 2
  const targetDistance = Math.max(2, Math.random() * safeRadius)
  const base = bot.entity.position
  const position = {
    x: Math.round(base.x + Math.cos(angle) * targetDistance),
    y: Math.round(base.y),
    z: Math.round(base.z + Math.sin(angle) * targetDistance)
  }

  return ok('random_position', { position, radius: safeRadius })
}

async function moveRandomlyNearby(context, radius = 8, options = {}) {
  const target = getRandomNearbyPosition(context, radius)
  if (!target.ok) return target
  return moveTo(context, target.data.position, {
    range: options.range ?? 2,
    timeoutMs: options.timeoutMs ?? 10000,
    ...options
  })
}

function scanNearbyBlocks(context, radius = 16) {
  const bot = context?.bot
  if (!bot?.entity?.position) return fail('missing_bot_position')
  if (typeof bot.findBlocks !== 'function' || !bot.registry?.blocksByName) return fail('missing_block_scan_support')

  const blockIds = Object.entries(bot.registry.blocksByName || {})
    .filter(([name]) => RESOURCE_BLOCKS.has(name) || DANGER_BLOCKS.has(name) || WATER_BLOCKS.has(name) || STRUCTURE_BLOCKS.has(name) || LANDMARK_BLOCKS.has(name))
    .map(([, block]) => block.id)

  if (!blockIds.length) return ok('nearby_blocks_scanned', { blocks: [] })

  try {
    const blocks = (bot.findBlocks({ matching: blockIds, maxDistance: radius, count: 128 }) || [])
      .map(position => bot.blockAt?.(toBlockVec3(position)) || null)
      .filter(Boolean)
      .map(block => ({
        name: block.name,
        position: block.position,
        category: classifyBlock(block.name)
      }))
    return ok('nearby_blocks_scanned', { blocks })
  } catch (err) {
    return fail(err.message)
  }
}

function scanNearbyEntities(context, radius = 16) {
  const bot = context?.bot
  if (!bot?.entity?.position) return fail('missing_bot_position')
  const entities = Object.values(bot.entities || {})
    .filter(entity => entity?.position && entity !== bot.entity)
    .map(entity => ({
      id: entity.id,
      name: entity.name || entity.username || entity.type || 'unknown',
      type: entity.type || null,
      position: entity.position,
      distance: distance(bot.entity.position, entity.position),
      hostile: isHostile(entity)
    }))
    .filter(entity => entity.distance <= radius)
    .sort((a, b) => a.distance - b.distance)

  return ok('nearby_entities_scanned', {
    entities,
    nearbyHostiles: entities.filter(entity => entity.hostile)
  })
}

function findSafeExplorePoint(context, options = {}) {
  const bot = context?.bot
  if (!bot?.entity?.position) return fail('missing_bot_position')
  if (isDangerHigh(context)) return fail('danger_too_high')

  const origin = normalizePosition(options.origin || bot.entity.position)
  const radius = clampRadius(context, options.radius)
  const minExploreDistance = Math.max(2, Number(options.minExploreDistance) || Math.min(24, radius))
  const targetDistance = Math.max(minExploreDistance, Number(options.targetDistance || options.maxExploreDistance || radius) || radius)
  const maxDistanceFromOrigin = options.maxDistanceFromOrigin || Math.max(radius, targetDistance)
  const attempts = options.attempts || Math.max(16, Number(options.directionSectors || 8) * 3)
  const hostileScan = scanNearbyEntities(context, options.hostileRadius || 10)
  if (hostileScan.ok && hostileScan.data.nearbyHostiles.length > 0) return fail('hostile_nearby')

  for (let i = 0; i < attempts; i += 1) {
    const sector = nextSector(options.directionIndex || 0, i, options.directionSectors || 8)
    const angle = (Math.PI * 2 * sector) / (options.directionSectors || 8)
    const ringOffset = Math.floor(i / (options.directionSectors || 8))
    const step = clampNumber(
      targetDistance - ringOffset * (Number(options.radiusStep) || 8),
      minExploreDistance,
      Math.max(minExploreDistance, targetDistance)
    )
    const candidate = {
      x: Math.round(origin.x + Math.cos(angle) * step),
      y: Math.round(origin.y),
      z: Math.round(origin.z + Math.sin(angle) * step)
    }

    logEvent(context, `[EXPLORE_CANDIDATE] pos=${formatPos(candidate)} score=${scoreCandidate(origin, candidate, targetDistance)} reason=sector_${directionLabel(sector)}`)

    if (distance(origin, candidate) > maxDistanceFromOrigin) {
      logEvent(context, `[EXPLORE_CANDIDATE_REJECT] pos=${formatPos(candidate)} reason=unreachable`)
      continue
    }
    if (!withinBaseOrPlayerLimit(context, candidate, options)) {
      logEvent(context, `[EXPLORE_CANDIDATE_REJECT] pos=${formatPos(candidate)} reason=unreachable`)
      continue
    }
    const safety = assessPointSafety(context, candidate, options)
    if (!safety.safe) {
      logEvent(context, `[EXPLORE_CANDIDATE_REJECT] pos=${formatPos(candidate)} reason=${safety.reason}`)
      continue
    }
    if (isVisitedRecently(options.visitedTargets, candidate, options)) {
      logEvent(context, `[EXPLORE_CANDIDATE_REJECT] pos=${formatPos(candidate)} reason=visited_cooldown`)
      continue
    }
    if (isAlreadyExplored(context, candidate, options)) {
      logEvent(context, `[EXPLORE_CANDIDATE_REJECT] pos=${formatPos(candidate)} reason=already_explored`)
      continue
    }

    logEvent(context, `[SAFE_POINT_SELECTED] pos=${formatPos(candidate)} score=${scoreCandidate(origin, candidate, targetDistance)}`)
    return ok('safe_explore_point_found', {
      position: candidate,
      radius,
      targetDistance: Math.round(distance(origin, candidate) * 100) / 100,
      directionIndex: sector,
      directionLabel: directionLabel(sector),
      reason: 'unexplored_sector'
    })
  }

  for (let i = 0; i < attempts; i += 1) {
    const sector = nextSector(options.directionIndex || 0, i, options.directionSectors || 8)
    const angle = (Math.PI * 2 * sector) / (options.directionSectors || 8)
    const fallbackDistance = clampNumber(targetDistance / 2, minExploreDistance / 2, targetDistance)
    const candidate = {
      x: Math.round(origin.x + Math.cos(angle) * fallbackDistance),
      y: Math.round(origin.y),
      z: Math.round(origin.z + Math.sin(angle) * fallbackDistance)
    }
    logEvent(context, `[EXPLORE_CANDIDATE] pos=${formatPos(candidate)} score=${scoreCandidate(origin, candidate, fallbackDistance)} reason=fallback_${directionLabel(sector)}`)
    const safety = assessPointSafety(context, candidate, options)
    if (withinBaseOrPlayerLimit(context, candidate, options) && safety.safe && !isVisitedRecently(options.visitedTargets, candidate, options)) {
      logEvent(context, `[SAFE_POINT_SELECTED] pos=${formatPos(candidate)} score=${scoreCandidate(origin, candidate, fallbackDistance)}`)
      return ok('safe_explore_point_found', {
        position: candidate,
        radius,
        targetDistance: Math.round(distance(origin, candidate) * 100) / 100,
        directionIndex: sector,
        directionLabel: directionLabel(sector),
        reason: 'fallback_safe_sector'
      })
    }
    logEvent(context, `[EXPLORE_CANDIDATE_REJECT] pos=${formatPos(candidate)} reason=${safety.reason || 'unreachable'}`)
  }

  return fail('safe_explore_point_not_found')
}

async function moveToExplorePoint(context, position, options = {}) {
  const target = normalizePosition(position)
  if (!target) return fail('missing_position')
  const safety = assessPointSafety(context, target, options)
  if (!safety.safe) return fail(`unsafe_explore_point:${safety.reason}`)
  return moveTo(context, target, {
    owner: options.owner,
    range: options.range ?? 2,
    timeoutMs: options.timeoutMs ?? 15000,
    holdLock: options.holdLock
  })
}

function estimateDistanceFromBase(context) {
  const current = currentPosition(context)
  const base = context.memory?.world?.baseLocation?.position || context.memory?.world?.baseLocation
  if (!current || !base) return ok('distance_from_base_unknown', { distanceFromBase: null })
  return ok('distance_from_base_estimated', { distanceFromBase: Math.round(distance(current, base) * 100) / 100 })
}

function estimateDistanceFromPlayer(context) {
  const current = currentPosition(context)
  const player = context.blackboard?.get?.('player.ownerPosition') ||
    context.blackboard?.get?.('player.nearestPlayer.position') ||
    nearestPlayerPosition(context)
  if (!current || !player) return ok('distance_from_player_unknown', { distanceFromPlayer: null })
  return ok('distance_from_player_estimated', { distanceFromPlayer: Math.round(distance(current, player) * 100) / 100 })
}

function detectExplorationRisks(context, options = {}) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel || 'none'
  const food = Number(context.blackboard?.get?.('bot.food') ?? context.bot?.food ?? 20)
  const emptySlots = context.blackboard?.get?.('inventory.emptySlots')
  const isDay = context.blackboard?.get?.('world.isDay')
  const entities = scanNearbyEntities(context, options.radius || 12)
  const blocks = scanNearbyBlocks(context, options.radius || 8)
  const risks = []

  if (['high', 'critical'].includes(dangerLevel)) risks.push('danger_too_high')
  if (food <= (options.lowFoodThreshold || 8)) risks.push('food_low')
  if (emptySlots != null && emptySlots <= (options.inventoryEmptySlotThreshold || 1)) risks.push('inventory_full')
  if (isDay === false && options.allowNight !== true) risks.push('night_without_strategy')
  if (entities.ok && entities.data.nearbyHostiles.length > 0) risks.push('hostile_nearby')
  if (blocks.ok && blocks.data.blocks.some(block => block.category === 'danger')) risks.push('danger_block_nearby')

  return ok('exploration_risks_detected', {
    risks,
    dangerLevel,
    food,
    emptySlots,
    nearbyHostiles: entities.ok ? entities.data.nearbyHostiles : []
  })
}

function recordDiscoveredPlace(context, place) {
  if (!place?.position) return fail('missing_place_position')
  const payload = {
    type: place.type || 'interesting_place',
    name: place.name || place.type || 'interesting_place',
    description: place.description || '',
    tags: place.tags || ['exploration'],
    notes: place.notes || [],
    source: 'exploration_system'
  }
  const record = context.memory?.world?.addDiscoveredPlace?.(place.position, payload) ||
    context.memory?.world?.addImportantPlace?.(place.position, payload)
  if (!record) return fail('memory_write_failed')
  logEvent(context, `[PLACE_DISCOVERED] type=${record.type || payload.type} pos=${formatPos(record.position || place.position)} confidence=${place.confidence || 0.8}`)
  logEvent(context, `[MEMORY_WRITE] key=discoveredPlaces value=${safeJson(record)}`)
  return ok('discovered_place_recorded', { record })
}

function recordDangerZone(context, danger) {
  if (!danger?.position) return fail('missing_danger_position')
  const payload = {
    type: danger.type || 'unknown_danger',
    name: danger.name || danger.type || 'unknown_danger',
    description: danger.description || '',
    tags: danger.tags || ['exploration', 'danger'],
    source: 'exploration_system'
  }
  const record = context.memory?.world?.addDangerZone?.(danger.position, payload)
  if (!record) return fail('memory_write_failed')
  logEvent(context, `[DANGER_ZONE_RECORDED] type=${record.type || payload.type} pos=${formatPos(record.position || danger.position)}`)
  logEvent(context, `[MEMORY_WRITE] key=dangerZones value=${safeJson(record)}`)
  return ok('danger_zone_recorded', { record })
}

async function returnToPlayer(context, options = {}) {
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')

  const ownerPosition = context.blackboard?.get?.('player.ownerPosition') ||
    context.blackboard?.get?.('player.nearestPlayer.position')
  if (ownerPosition) {
    return moveTo(context, ownerPosition, {
      range: options.range ?? 2,
      timeoutMs: options.timeoutMs ?? 15000,
      ...options
    })
  }

  const player = Object.values(bot.players || {})
    .filter(candidate => candidate?.entity && candidate.username !== bot.username)
    .sort((a, b) => distance(bot.entity.position, a.entity.position) - distance(bot.entity.position, b.entity.position))[0]

  if (!player?.entity?.position) return fail('player_not_found')
  return moveTo(context, player.entity.position, {
    range: options.range ?? 2,
    timeoutMs: options.timeoutMs ?? 15000,
    ...options
  })
}

function isSafePoint(context, position, options = {}) {
  return assessPointSafety(context, position, options).safe
}

function assessPointSafety(context, position, options = {}) {
  const bot = context?.bot
  if (!bot?.blockAt) return { safe: true }
  const target = normalizePosition(position)
  if (!target) return { safe: false, reason: 'unreachable' }

  const feet = bot.blockAt(toBlockVec3(target))
  const below = bot.blockAt(toBlockVec3({ x: target.x, y: target.y - 1, z: target.z }))
  const above = bot.blockAt(toBlockVec3({ x: target.x, y: target.y + 1, z: target.z }))
  if (feet && !['air', 'cave_air', 'grass', 'tall_grass', 'short_grass'].includes(feet.name)) return { safe: false, reason: blockReason(feet.name) }
  if (!below || ['air', 'cave_air', 'void_air'].includes(below.name)) return { safe: false, reason: 'cliff' }
  if (DANGER_BLOCKS.has(below.name) || DANGER_BLOCKS.has(feet?.name) || DANGER_BLOCKS.has(above?.name)) return { safe: false, reason: 'lava' }
  if (WATER_BLOCKS.has(feet?.name) || WATER_BLOCKS.has(below.name)) return { safe: false, reason: 'water' }

  const nearbyDanger = scanLocalBlocks(context, target, options.localSafetyRadius || 2)
  const danger = nearbyDanger.find(block => DANGER_BLOCKS.has(block.name))
  if (danger) return { safe: false, reason: 'lava' }
  const water = nearbyDanger.find(block => WATER_BLOCKS.has(block.name))
  if (water && options.allowWater !== true) return { safe: false, reason: 'water' }
  if (hasNearbyDrop(context, target, options.maxDrop || 3)) return { safe: false, reason: 'cliff' }

  const isDay = context.blackboard?.get?.('world.isDay')
  const origin = normalizePosition(options.origin || currentPosition(context))
  if (isDay === false && origin && distance(origin, target) > (options.nightSafeRadius || 16)) {
    return { safe: false, reason: 'night' }
  }

  const entities = scanNearbyEntities(context, options.hostileRadius || 8)
  if (entities.ok && entities.data.nearbyHostiles.some(entity => distance(entity.position, target) <= (options.minHostileDistance || 8))) {
    return { safe: false, reason: 'mob' }
  }
  return { safe: true, reason: 'safe' }
}

function classifyBlock(name) {
  if (RESOURCE_BLOCKS.has(name)) return 'resource'
  if (DANGER_BLOCKS.has(name)) return 'danger'
  if (WATER_BLOCKS.has(name)) return 'water'
  if (STRUCTURE_BLOCKS.has(name)) return 'structure'
  if (LANDMARK_BLOCKS.has(name)) return 'landmark'
  return 'other'
}

function blockReason(name) {
  if (DANGER_BLOCKS.has(name)) return 'lava'
  if (WATER_BLOCKS.has(name)) return 'water'
  return 'unreachable'
}

function scanLocalBlocks(context, target, radius) {
  const bot = context?.bot
  if (!bot?.blockAt || !target) return []
  const blocks = []
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const pos = { x: target.x + dx, y: target.y + dy, z: target.z + dz }
        const block = bot.blockAt(toBlockVec3(pos))
        if (block) blocks.push(block)
      }
    }
  }
  return blocks
}

function hasNearbyDrop(context, target, maxDrop) {
  const bot = context?.bot
  if (!bot?.blockAt || !target) return false
  const checks = [
    { x: target.x + 1, y: target.y, z: target.z },
    { x: target.x - 1, y: target.y, z: target.z },
    { x: target.x, y: target.y, z: target.z + 1 },
    { x: target.x, y: target.y, z: target.z - 1 }
  ]
  return checks.some(pos => {
    for (let drop = 1; drop <= maxDrop; drop += 1) {
      const below = bot.blockAt(toBlockVec3({ x: pos.x, y: pos.y - drop, z: pos.z }))
      if (below && !['air', 'cave_air', 'void_air'].includes(below.name)) return false
    }
    return true
  })
}

function scoreCandidate(origin, candidate, radius) {
  const d = distance(origin, candidate)
  const target = Math.max(8, radius * 0.65)
  return Math.max(1, Math.round(100 - Math.abs(d - target) * 4))
}

function nextSector(start, offset, sectors) {
  const normalizedSectors = Math.max(1, Number(sectors) || 8)
  const ring = Math.floor(offset / normalizedSectors)
  const step = offset % normalizedSectors
  return (Number(start || 0) + step + ring) % normalizedSectors
}

function directionLabel(sector) {
  const labels = ['east', 'north_east', 'north', 'north_west', 'west', 'south_west', 'south', 'south_east']
  return labels[sector % labels.length] || `sector_${sector}`
}

function isVisitedRecently(visitedTargets, position, options = {}) {
  if (!Array.isArray(visitedTargets) || !position) return false
  const cooldownMs = Number(options.targetCooldownMs) || 10 * 60 * 1000
  const now = Date.now()
  const minDistance = Number(options.visitedMinDistance) || Math.max(8, (Number(options.minExploreDistance) || 24) / 2)
  return visitedTargets.some(item => {
    if (now - Number(item.visitedAtMs || 0) > cooldownMs) return false
    return distance(item.position, position) <= minDistance
  })
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function isHostile(entity) {
  const name = entity?.name || ''
  return entity?.hostile === true || entity?.type === 'mob' && HOSTILE_NAMES.has(name)
}

function isDangerHigh(context) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return dangerLevel === 'high' || dangerLevel === 'critical'
}

function currentPosition(context) {
  return context.blackboard?.get?.('bot.position') || context.bot?.entity?.position || context.worldState?.bot?.position || null
}

function nearestPlayerPosition(context) {
  const bot = context?.bot
  if (!bot?.entity) return null
  const player = Object.values(bot.players || {})
    .filter(candidate => candidate?.entity && candidate.username !== bot.username)
    .sort((a, b) => distance(bot.entity.position, a.entity.position) - distance(bot.entity.position, b.entity.position))[0]
  return player?.entity?.position || null
}

function clampRadius(context, radius) {
  const requested = Number(radius) || 32
  const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
  const max = hasBase ? 48 : 32
  return Math.max(4, Math.min(requested, max))
}

function withinBaseOrPlayerLimit(context, position, options = {}) {
  const base = context.memory?.world?.baseLocation?.position || context.memory?.world?.baseLocation
  const player = context.blackboard?.get?.('player.ownerPosition') || nearestPlayerPosition(context)
  const maxBase = options.maxDistanceFromBase || (base ? 64 : 16)
  const maxPlayer = options.maxDistanceFromPlayer || 64
  if (base && distance(base, position) > maxBase) return false
  if (player && distance(player, position) > maxPlayer) return false
  return true
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

function isAlreadyExplored(context, position, options = {}) {
  const areas = context.memory?.world?.exploredAreas?.() || context.memory?.world?.list?.().exploredAreas || []
  const minDistance = options.minUnexploredDistance || 8
  return areas.some(area => distance(area.center, position) <= Math.min(area.radius || 32, minDistance))
}

module.exports = {
  detectExplorationRisks,
  estimateDistanceFromBase,
  estimateDistanceFromPlayer,
  findSafeExplorePoint,
  getRandomNearbyPosition,
  moveRandomlyNearby,
  moveToExplorePoint,
  recordDangerZone,
  recordDiscoveredPlace,
  returnToPlayer,
  scanNearbyBlocks,
  scanNearbyEntities
}
