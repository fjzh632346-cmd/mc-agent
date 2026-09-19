// In-process memory of terrain that has already trapped the bot, plus the
// pathfinder wiring that keeps her from routing back over it.
//
// Why this exists: round 2 gave her a working self-rescue ladder, and the real
// machine proved it — she pillared out of a four-block pit in four lifts. What
// the same run also proved is that the way home led straight back across the
// open mouth of that pit: mineflayer-pathfinder rates a sprint-jump over a
// four-wide gap as ordinary terrain, so the cheapest route from the rim was a
// jump over the hole rather than four steps around it. Nail the jump and
// nothing happens; miss it and she is back on the pit floor starting the whole
// rescue over (round 2 feedback, 10:14:53).
//
// So the missing piece is not another rescue rung, it is memory: "this spot
// already held me, plan around it". That is deliberately NOT "avoid all low
// ground" — she still has to mine, and still has to stand in a foundation pit
// to build. A hazard is only recorded where the escape ladder actually had to
// escalate, it covers only the columns that really are a hole, and it is
// ignored outright for the hole she is standing in or the hole she has been
// sent to.
//
// Lifecycle is deliberately short and self-clearing:
//   * lives on the blackboard, so it dies with the process (after a restart
//     the world may well have changed, and a stale no-go zone is worse than
//     re-learning the pit)
//   * expires after DEFAULT_TTL_MS, refreshed each time the spot traps her
//     again
//   * dropped as soon as the hole is gone: if every sampled column has been
//     filled back up to the rim, the memory is deleted rather than kept
//   * capped at DEFAULT_MAX_HAZARDS spots, oldest evicted first

const { toBlockVec3 } = require('../utils/position')

const HAZARD_PATH = 'recovery.terrainHazards'
const CONTEXT_FALLBACK = Symbol.for('linxia.terrainHazards')

// How long a remembered pit keeps steering the pathfinder. Long enough to
// cover a retreat and the walk home that follows it, short enough that a pit
// somebody filled in stops mattering on its own even if we never look at it.
const DEFAULT_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_HAZARDS = 8

// A hole has to be at least this deep to be worth routing around; a one-block
// step down is not what trapped her.
const DEFAULT_MIN_DEPTH = 2
// How far up we look for a rim. Past this the shape stops being a pit she
// walked into and starts being a canyon.
const DEFAULT_MAX_PROBE_DEPTH = 8
// How far above the rim the exclusion reaches. The killer move is the
// sprint-jump ACROSS the mouth, and that flight path is one to two blocks over
// the rim, so the cells above the hole have to be part of the hazard or the
// jump stays free.
const DEFAULT_HEADROOM = 2

// Flood-fill bounds. A hazard describes one pit, not a valley.
const DEFAULT_MAX_RADIUS = 6
const DEFAULT_MAX_COLUMNS = 121

// Re-checking whether a pit has been filled in costs a blockAt per column, so
// do it at most this often per hazard rather than on every pathfinder setup.
const DEFAULT_REFILL_CHECK_MS = 5000
const REFILL_SAMPLE_COLUMNS = 12

const PASSABLE_BLOCK_NAMES = new Set([
  'air', 'cave_air', 'void_air',
  'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'snow', 'vine', 'water', 'lava',
  'torch', 'wall_torch', 'ladder'
])

function hazardStore(ctx) {
  const blackboard = ctx?.blackboard
  if (blackboard?.get && blackboard?.set) {
    const existing = blackboard.get(HAZARD_PATH)
    if (existing && typeof existing === 'object') return existing
    const created = {}
    blackboard.set(HAZARD_PATH, created)
    // Some blackboards clone on set; read back so we mutate the stored object.
    return blackboard.get(HAZARD_PATH) || created
  }
  if (!ctx) return {}
  if (!ctx[CONTEXT_FALLBACK]) ctx[CONTEXT_FALLBACK] = {}
  return ctx[CONTEXT_FALLBACK]
}

function saveStore(ctx, store) {
  const blackboard = ctx?.blackboard
  if (blackboard?.set) blackboard.set(HAZARD_PATH, store)
  return store
}

function hazardKey(anchor) {
  return `${Math.floor(anchor.x)},${Math.floor(anchor.y)},${Math.floor(anchor.z)}`
}

function columnKey(x, z) {
  return `${Math.floor(x)},${Math.floor(z)}`
}

function isSolidBlock(block) {
  if (!block) return false
  if (block.boundingBox) return block.boundingBox === 'block'
  return !PASSABLE_BLOCK_NAMES.has(String(block.name || ''))
}

// Highest solid block top in this column at or below `topY`. Returns a value
// below `floorY` when the column is open all the way down, which is what makes
// "is this column part of the hole" a single comparison.
function columnSurfaceY(bot, x, z, topY, bottomY) {
  for (let y = topY; y >= bottomY; y -= 1) {
    const block = bot?.blockAt?.(toBlockVec3({ x, y, z }))
    if (isSolidBlock(block)) return y
  }
  return bottomY - 1
}

// The columns that are genuinely part of this hole at rim height `rimY`:
// reachable from the anchor and standing lower than the rim. Solid ground
// around the pit fails the test, so walking the rim is never penalised — only
// dropping in or jumping across.
//
// `bounded` is the important half of the answer. A pit closes: the fill runs
// out of low columns on its own. Open low ground does not, and the fill walks
// straight into the radius or column cap. That difference is what separates
// "a hole that held her" from "she happens to be standing downhill", and the
// real machine needed it — a `move_timeout` on an ordinary slope otherwise
// recorded a 64-column no-go zone that then blocked the route home.
function floodHoleColumns(bot, anchor, rimY, options = {}) {
  const maxRadius = Number(options.maxRadius ?? DEFAULT_MAX_RADIUS)
  const maxColumns = Number(options.maxColumns ?? DEFAULT_MAX_COLUMNS)
  const surfaceAt = options.surfaceAt ||
    ((x, z) => columnSurfaceY(bot, x, z, rimY, Math.floor(anchor.y) - 2))
  const originX = Math.floor(anchor.x)
  const originZ = Math.floor(anchor.z)

  const columns = new Map()
  const visited = new Set()
  let bounded = true
  // Seed with the anchor column AND its neighbours: by the time we record a
  // hazard the bot may have plugged her own column with the escape pillar, and
  // a solid seed must not stop the fill before it starts.
  const queue = [
    [originX, originZ],
    [originX + 1, originZ], [originX - 1, originZ],
    [originX, originZ + 1], [originX, originZ - 1]
  ]

  while (queue.length) {
    const [x, z] = queue.shift()
    const key = columnKey(x, z)
    if (visited.has(key)) continue
    visited.add(key)

    if (surfaceAt(x, z) >= rimY) continue
    if (Math.abs(x - originX) > maxRadius || Math.abs(z - originZ) > maxRadius) {
      // Low ground carries on past our window: this is not an enclosed pit.
      bounded = false
      continue
    }

    columns.set(key, { x, z })
    if (columns.size > maxColumns) {
      bounded = false
      break
    }
    queue.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1])
  }

  return { columns: [...columns.values()], bounded }
}

// Find the rim by asking the terrain instead of guessing at a depth.
//
// "The hole at height h" is every low column reachable from the anchor with a
// surface below h. Raise h one block at a time: while the shape stays enclosed
// it is still a pit, and the moment it spills into the surrounding ground the
// previous h was the lip. That last enclosed height IS the rim, which is also
// the topmost cell still inside the hole.
function measureHole(bot, anchor, options = {}) {
  const floorY = Math.floor(anchor.y)
  const minDepth = Number(options.minDepth ?? DEFAULT_MIN_DEPTH)
  const maxProbeDepth = Number(options.maxProbeDepth ?? DEFAULT_MAX_PROBE_DEPTH)
  const bottomY = floorY - 2
  const topY = floorY + maxProbeDepth

  const cache = new Map()
  const surfaceAt = (x, z) => {
    const key = columnKey(x, z)
    if (!cache.has(key)) cache.set(key, columnSurfaceY(bot, x, z, topY, bottomY))
    return cache.get(key)
  }

  let best = null
  for (let rimY = floorY + minDepth - 1; rimY <= topY; rimY += 1) {
    const fill = floodHoleColumns(bot, anchor, rimY, { ...options, surfaceAt })
    if (!fill.bounded || !fill.columns.length) break
    best = { rimY, columns: fill.columns }
  }
  return best
}

function boundsOf(columns) {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const column of columns) {
    minX = Math.min(minX, column.x)
    maxX = Math.max(maxX, column.x)
    minZ = Math.min(minZ, column.z)
    maxZ = Math.max(maxZ, column.z)
  }
  return { minX, maxX, minZ, maxZ }
}

// Record the spot the escape ladder had to fight its way out of.
//
// The shape of the ground decides, not the escape: a hazard is only written
// where the terrain around the anchor really does close over her head. Open
// ground, a slope, the lip of a valley — all of those measure as "not a pit"
// and are dropped here rather than turned into a no-go zone she has to path
// around for the next quarter of an hour.
function rememberTerrainHazard(ctx, options = {}) {
  const anchor = normalizeBlockPoint(options.position)
  if (!anchor) return null
  const bot = options.bot || ctx?.bot
  const now = Number(options.now ?? Date.now())

  const hole = measureHole(bot, anchor, options)
  if (!hole) return null
  const { rimY, columns } = hole
  const floorY = anchor.y

  const store = hazardStore(ctx)
  const key = hazardKey(anchor)
  const previous = store[key]
  const hazard = {
    key,
    anchor,
    floorY,
    rimY,
    headroom: Number(options.headroom ?? DEFAULT_HEADROOM),
    columns: columns.map(column => columnKey(column.x, column.z)),
    bounds: boundsOf(columns),
    reason: options.reason || 'escape_ladder',
    rungs: Array.isArray(options.rungs) ? [...options.rungs] : [],
    escapeKey: options.escapeKey || null,
    trappedCount: (previous?.trappedCount || 0) + 1,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    expiresAt: now + Number(options.ttlMs ?? DEFAULT_TTL_MS),
    lastRefillCheckAt: now
  }

  store[key] = hazard
  evictOldest(store, Number(options.maxHazards ?? DEFAULT_MAX_HAZARDS))
  saveStore(ctx, store)
  return hazard
}

function evictOldest(store, maxHazards) {
  const keys = Object.keys(store)
  if (keys.length <= maxHazards) return store
  keys
    .sort((a, b) => (store[a].lastSeenAt || 0) - (store[b].lastSeenAt || 0))
    .slice(0, keys.length - maxHazards)
    .forEach(key => { delete store[key] })
  return store
}

// Has somebody filled this pit back in? Sampled and throttled, because the
// alternative is a blockAt storm on every single pathfinder setup.
function hazardIsFilledIn(hazard, bot, now, options = {}) {
  if (!bot?.blockAt) return false
  const interval = Number(options.refillCheckMs ?? DEFAULT_REFILL_CHECK_MS)
  if (now - (hazard.lastRefillCheckAt || 0) < interval) return false
  hazard.lastRefillCheckAt = now

  const step = Math.max(1, Math.ceil(hazard.columns.length / REFILL_SAMPLE_COLUMNS))
  for (let index = 0; index < hazard.columns.length; index += step) {
    const [x, z] = hazard.columns[index].split(',').map(Number)
    const surfaceY = columnSurfaceY(bot, x, z, hazard.rimY, hazard.floorY - 2)
    if (surfaceY < hazard.rimY) return false
  }
  return true
}

// Every hazard we still believe in, with the dead ones deleted on the way out.
function listTerrainHazards(ctx, options = {}) {
  const store = hazardStore(ctx)
  const now = Number(options.now ?? Date.now())
  const bot = options.bot || ctx?.bot
  const live = []
  let changed = false

  for (const key of Object.keys(store)) {
    const hazard = store[key]
    if (!hazard || now > hazard.expiresAt) {
      delete store[key]
      changed = true
      continue
    }
    if (options.checkRefill !== false && hazardIsFilledIn(hazard, bot, now, options)) {
      delete store[key]
      changed = true
      continue
    }
    live.push(hazard)
  }

  if (changed) saveStore(ctx, store)
  return live
}

function forgetTerrainHazard(ctx, key) {
  const store = hazardStore(ctx)
  delete store[key]
  return saveStore(ctx, store)
}

function clearTerrainHazards(ctx) {
  const store = hazardStore(ctx)
  for (const key of Object.keys(store)) delete store[key]
  return saveStore(ctx, store)
}

function getTerrainHazardSnapshot(ctx, options = {}) {
  return listTerrainHazards(ctx, { ...options, checkRefill: false }).map(hazard => ({
    key: hazard.key,
    anchor: { ...hazard.anchor },
    floorY: hazard.floorY,
    rimY: hazard.rimY,
    columns: hazard.columns.length,
    reason: hazard.reason,
    rungs: [...hazard.rungs],
    trappedCount: hazard.trappedCount,
    expiresAt: hazard.expiresAt
  }))
}

// Is this exact cell inside the hole (or in the flight path just above it)?
function hazardContainsCell(hazard, columnSet, position) {
  if (!position) return false
  const y = Math.floor(Number(position.y))
  if (y < hazard.floorY || y > hazard.rimY + hazard.headroom) return false
  return columnSet.has(columnKey(position.x, position.z))
}

// Looser test for "is this point down in the hole": used to decide whether a
// hazard applies at all, so it works on the bounding box and forgives a block
// of slack around the edge.
//
// The ceiling is the rim, not the headroom above it. Standing on top of her
// own escape pillar puts her at rim+1 INSIDE the footprint, and counting that
// as "she is in this hole" would switch the avoidance off at exactly the
// moment it has to work.
function hazardContainsPoint(hazard, point, margin = 0) {
  if (!point) return false
  const x = Math.floor(Number(point.x))
  const y = Math.floor(Number(point.y))
  const z = Math.floor(Number(point.z))
  if (y < hazard.floorY - 2 || y > hazard.rimY) return false
  const { minX, maxX, minZ, maxZ } = hazard.bounds
  return x >= minX - margin && x <= maxX + margin && z >= minZ - margin && z <= maxZ + margin
}

// The hazards that should steer THIS route. Two situations disqualify a
// hazard outright, and both matter more than the avoidance itself:
//   * she is standing in it — you cannot path around the hole you are in, and
//     excluding it would leave the rescue ladder with no legal move at all
//   * she was sent into it — mining trips and foundation work have every right
//     to end up at the bottom of a hole
function activeTerrainHazards(ctx, options = {}) {
  const hazards = listTerrainHazards(ctx, options)
  if (!hazards.length) return []
  const botPosition = options.botPosition || ctx?.bot?.entity?.position || null
  const destination = options.destination || null
  const destinationMargin = Number(options.destinationMargin ?? 1)
  return hazards.filter(hazard => {
    if (hazardContainsPoint(hazard, botPosition, 0)) return false
    if (hazardContainsPoint(hazard, destination, destinationMargin)) return false
    return true
  })
}

// A predicate over block positions, or null when nothing applies. Callers use
// it to mark those cells unwalkable for one pathfinder setup.
function terrainHazardCellFilter(ctx, options = {}) {
  const hazards = activeTerrainHazards(ctx, options)
  if (!hazards.length) return null
  const prepared = hazards.map(hazard => ({ hazard, columnSet: new Set(hazard.columns) }))
  const filter = position => prepared.some(item => hazardContainsCell(item.hazard, item.columnSet, position))
  filter.hazards = hazards
  return filter
}

// Does any applied hazard actually sit between here and there? Used to decide
// whether a failed route is worth re-planning without the avoidance, so that a
// goal which was unreachable anyway does not pay for a second attempt.
function hazardsBlockCorridor(hazards, from, to, padding = 8) {
  if (!hazards?.length || !from || !to) return false
  const minX = Math.min(from.x, to.x) - padding
  const maxX = Math.max(from.x, to.x) + padding
  const minZ = Math.min(from.z, to.z) - padding
  const maxZ = Math.max(from.z, to.z) + padding
  return hazards.some(hazard => {
    const bounds = hazard.bounds
    return bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxZ >= minZ && bounds.minZ <= maxZ
  })
}

function normalizeBlockPoint(position) {
  if (!position) return null
  const x = Number(position.x)
  const y = Number(position.y)
  const z = Number(position.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

module.exports = {
  DEFAULT_HEADROOM,
  DEFAULT_MAX_HAZARDS,
  DEFAULT_MIN_DEPTH,
  DEFAULT_TTL_MS,
  activeTerrainHazards,
  clearTerrainHazards,
  floodHoleColumns,
  forgetTerrainHazard,
  measureHole,
  getTerrainHazardSnapshot,
  hazardContainsPoint,
  hazardsBlockCorridor,
  listTerrainHazards,
  rememberTerrainHazard,
  terrainHazardCellFilter
}
