const { distance } = require('../actions/action-utils')

const BED_BLOCK_NAMES = [
  'white_bed',
  'orange_bed',
  'magenta_bed',
  'light_blue_bed',
  'yellow_bed',
  'lime_bed',
  'pink_bed',
  'gray_bed',
  'light_gray_bed',
  'cyan_bed',
  'purple_bed',
  'blue_bed',
  'brown_bed',
  'green_bed',
  'red_bed',
  'black_bed'
]

const BED_BLOCK_NAME_SET = new Set(BED_BLOCK_NAMES)

function isNight(context = {}) {
  const snapshot = context.blackboard?.snapshot?.() || {}
  const world = snapshot.world || context.worldState?.world || context.world || {}
  if (world.isDay === false) return true
  if (world.isNight === true) return true
  const time = Number(context.bot?.time?.timeOfDay ?? world.timeOfDay ?? world.time)
  if (Number.isFinite(time)) return time >= 12542 && time <= 23458
  return false
}

function findNearestBed(context = {}, options = {}) {
  const utility = context.utilityBlockSearch
  if (utility?.findNearestBed) {
    const found = utility.findNearestBed(context, options)
    if (found.ok) {
      return {
        ok: true,
        bed: found.block,
        position: found.position,
        source: found.source,
        distance: found.distance
      }
    }
  }

  const bot = context.bot
  const currentPosition = bot?.entity?.position || context.blackboard?.get?.('bot.position') || null
  const remembered = normalizePosition(
    context.blackboard?.get?.('sleep.knownBedPosition') ||
    context.memory?.world?.baseBed?.position ||
    context.memory?.world?.homeBed?.position ||
    context.memory?.world?.bedLocation?.position ||
    context.memory?.world?.bedLocation ||
    null
  )

  const candidates = []
  if (remembered) {
    const block = blockAt(bot, remembered)
    if (!block || isBedBlock(block)) candidates.push({ block: block || { name: 'remembered_bed', position: remembered }, position: remembered, source: 'memory' })
  }

  const visible = findVisibleBeds(context, options)
  for (const bed of visible) candidates.push({ block: bed, position: bed.position, source: 'nearby' })

  const unique = uniquePositions(candidates)
  unique.sort((a, b) => distance(currentPosition, a.position) - distance(currentPosition, b.position))
  const selected = unique[0] || null
  if (!selected) return { ok: false, error: 'sleep_failed_no_bed_found', bed: null }

  return {
    ok: true,
    bed: selected.block,
    position: selected.position,
    source: selected.source,
    distance: currentPosition ? distance(currentPosition, selected.position) : null
  }
}

function findVisibleBeds(context = {}, options = {}) {
  const bot = context.bot
  if (!bot) return []
  const radius = options.radius || 16
  const matching = bedBlockIds(bot)
  const positions = []

  try {
    if (typeof bot.findBlocks === 'function' && matching.length) {
      positions.push(...(bot.findBlocks({ matching, maxDistance: radius, count: options.count || 16 }) || []))
    } else if (typeof bot.findBlock === 'function' && matching.length) {
      const block = bot.findBlock({ matching, maxDistance: radius })
      if (block?.position) positions.push(block.position)
    }
  } catch {}

  const beds = []
  for (const position of positions) {
    const block = blockAt(bot, position)
    if (isBedBlock(block)) beds.push(block)
  }
  return beds
}

function bedBlockIds(bot) {
  const registry = bot?.registry?.blocksByName
  if (!registry) return []
  return BED_BLOCK_NAMES.map(name => registry[name]?.id).filter(id => id != null)
}

function isBedBlock(block) {
  return Boolean(block && BED_BLOCK_NAME_SET.has(block.name))
}

function buildSleepState(context = {}, last = {}) {
  const nearest = findNearestBed(context, { radius: 32 })
  const night = isNight(context)
  const sleeping = Boolean(context.bot?.isSleeping || context.blackboard?.get?.('sleep.isSleeping'))
  return {
    isNight: night,
    isSleeping: sleeping,
    sleepPhase: last.sleepPhase || context.blackboard?.get?.('sleep.sleepPhase') || (sleeping ? 'waiting_for_others' : 'idle'),
    knownBedPosition: normalizePosition(context.blackboard?.get?.('sleep.knownBedPosition') || context.memory?.world?.bedLocation?.position || null),
    nearestBedPosition: nearest.ok ? normalizePosition(nearest.position) : null,
    distanceToBed: nearest.ok ? roundDistance(nearest.distance) : null,
    lastSleepAction: last.lastSleepAction || context.blackboard?.get?.('sleep.lastSleepAction') || null,
    lastSleepError: last.lastSleepError || context.blackboard?.get?.('sleep.lastSleepError') || null,
    canSleepNow: night && nearest.ok,
    sleepReason: last.sleepReason || context.blackboard?.get?.('sleep.sleepReason') || (nearest.ok ? (night ? 'night_and_bed_available' : 'bed_available_but_not_night') : 'sleep_failed_no_bed_found'),
    waitingSince: last.waitingSince || context.blackboard?.get?.('sleep.waitingSince') || null,
    waitingForPlayers: Boolean(last.waitingForPlayers || context.blackboard?.get?.('sleep.waitingForPlayers') || (sleeping && night))
  }
}

function normalizePosition(position) {
  if (!position) return null
  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z))
  }
}

function blockAt(bot, position) {
  try {
    return bot?.blockAt?.(position) || null
  } catch {
    return null
  }
}

function uniquePositions(candidates) {
  const byKey = new Map()
  for (const candidate of candidates) {
    if (!candidate?.position) continue
    const p = normalizePosition(candidate.position)
    const key = `${p.x},${p.y},${p.z}`
    if (!byKey.has(key)) byKey.set(key, { ...candidate, position: p })
  }
  return [...byKey.values()]
}

function roundDistance(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

module.exports = {
  BED_BLOCK_NAMES,
  BED_BLOCK_NAME_SET,
  buildSleepState,
  findNearestBed,
  isBedBlock,
  isNight
}
