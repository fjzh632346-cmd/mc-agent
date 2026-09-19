const { toBlockVec3 } = require('../utils/position')

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', null, undefined])
const STAIR_BLOCKS = new Set([
  'oak_stairs',
  'spruce_stairs',
  'birch_stairs',
  'jungle_stairs',
  'acacia_stairs',
  'dark_oak_stairs',
  'mangrove_stairs',
  'cherry_stairs',
  'bamboo_stairs',
  'stone_stairs',
  'cobblestone_stairs',
  'stone_brick_stairs',
  'brick_stairs',
  'nether_brick_stairs',
  'quartz_stairs'
])
const CLIMBABLE_BLOCKS = new Set(['ladder', 'vine', 'scaffolding'])
const DOOR_PATTERN = /(^|_)door$/
const TRAPDOOR_PATTERN = /trapdoor$/
const REQUIRED_FURNITURE = new Set(['bed', 'chest', 'furnace', 'crafting_table'])

class WalkabilityChecker {
  constructor(options = {}) {
    this.options = {
      maxNodes: options.maxNodes || 6000,
      minMainPathWidth: options.minMainPathWidth || 2,
      ...options
    }
  }

  checkBlueprint(blueprint, options = {}) {
    return this.check({
      blueprint,
      layoutPlan: options.layoutPlan,
      interiorPlan: options.interiorPlan,
      mode: 'blueprint'
    })
  }

  checkWorld(context, blueprint, options = {}) {
    return this.check({
      blueprint,
      context,
      origin: options.origin,
      layoutPlan: options.layoutPlan,
      interiorPlan: options.interiorPlan,
      mode: 'world'
    })
  }

  check(input = {}) {
    const blueprint = input.blueprint
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return fail(['invalid_blueprint_for_walkability'])
    }

    const layoutPlan = input.layoutPlan || blueprint.metadata?.functionalLayout || {}
    const interiorPlan = input.interiorPlan || blueprint.metadata?.interiorPlan || {}
    if (layoutPlan.enabled === false) {
      return {
        ok: true,
        enabled: false,
        failures: [],
        targets: [],
        reachableTargets: []
      }
    }

    const origin = normalizeOrigin(input.origin || { x: 0, y: 0, z: 0 })
    const blueprintOrigin = normalizeOrigin(blueprint.origin || { x: 0, y: 0, z: 0 })
    const expectedBlocks = new Map(blueprint.blocks.map(block => [posKey(block), block.type]))
    const bounds = expandedBounds(blueprint.blocks, 2)
    const blockNameAt = makeBlockReader({ context: input.context, expectedBlocks, origin, blueprintOrigin, mode: input.mode })
    const standable = new Map()

    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY + 2; y++) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
          const cell = { x, y, z }
          if (isStandable(cell, blockNameAt)) standable.set(posKey(cell), cell)
          if (standable.size > this.options.maxNodes) return fail(['walkability_node_limit'])
        }
      }
    }

    const entrances = entranceCells(layoutPlan, blueprint).filter(cell => standable.has(posKey(cell)))
    if (!entrances.length) return fail(['reachable_entry_missing'])

    const targets = collectTargets({ layoutPlan, interiorPlan, blueprint, standable, blockNameAt })
    const graph = buildGraph({ standable, blockNameAt, allowJump: false })
    const reachable = multiSourceSearch(graph, entrances)
    const jumpGraph = buildGraph({ standable, blockNameAt, allowJump: true })
    const jumpReachable = multiSourceSearch(jumpGraph, entrances)

    const failures = []
    const reachableTargets = []
    const unreachableTargets = []
    for (const target of targets) {
      const access = (target.accessCells || []).filter(cell => standable.has(posKey(cell)))
      if (!access.length) {
        failures.push(`target_access_cell_missing:${target.role}`)
        unreachableTargets.push(target)
        continue
      }
      const hit = access.find(cell => reachable.visited.has(posKey(cell)))
      if (hit) {
        reachableTargets.push({ ...target, reachedAt: hit })
        const path = reconstructPath(reachable.previous, hit)
        const chokepoint = firstChokepoint(path, standable, blockNameAt, layoutPlan)
        if (chokepoint) failures.push(`one_block_chokepoint:${target.role}:${posKey(chokepoint)}`)
        continue
      }

      const jumpHit = access.find(cell => jumpReachable.visited.has(posKey(cell)))
      if (jumpHit) failures.push(`jump_required:${target.role}`)
      else failures.push(`unreachable:${target.role}`)
      unreachableTargets.push(target)
    }

    if ((layoutPlan.minMainPathWidth || this.options.minMainPathWidth) < 2) {
      failures.push('main_path_width_below_2')
    }

    return {
      ok: failures.length === 0,
      enabled: true,
      failures,
      entrances,
      standableCount: standable.size,
      targets,
      reachableTargets,
      unreachableTargets,
      summary: {
        entrances: entrances.length,
        standable: standable.size,
        targets: targets.length,
        reachableTargets: reachableTargets.length,
        failures: failures.length
      }
    }
  }
}

function collectTargets({ layoutPlan, interiorPlan, blueprint, standable, blockNameAt }) {
  const targets = []
  const seen = new Set()
  const addTarget = target => {
    if (!target?.role) return
    const key = `${target.role}:${target.type || 'target'}`
    if (seen.has(key)) return
    seen.add(key)
    targets.push(target)
  }

  for (const room of layoutPlan.rooms || []) {
    const accessCells = [
      room.entrance,
      ...standableCellsInBounds(room.bounds, standable)
    ].filter(Boolean)
    addTarget({ role: `room:${room.zone || room.id}`, type: 'room', accessCells })
  }

  for (const target of layoutPlan.functionalTargets || []) {
    addTarget({
      role: target.role || target.type,
      type: target.type || 'functional',
      accessCells: target.accessCells || target.cells || []
    })
  }

  for (const stair of layoutPlan.stairs || []) {
    addTarget({ role: `stairs:${stair.id}:lower`, type: 'stairs', accessCells: stair.lowerCells || stair.cells || [] })
    addTarget({ role: `stairs:${stair.id}:upper`, type: 'stairs', accessCells: stair.upperCells || stair.cells || [] })
  }

  for (const placement of interiorPlan.placements || []) {
    const role = normalizeFurnitureRole(placement.role, placement.type)
    if (!REQUIRED_FURNITURE.has(role)) continue
    const accessCells = adjacentUseCells(placement, standable, blockNameAt)
    addTarget({ role, type: 'furniture', placement, accessCells })
  }

  if (!targets.length) {
    for (const doorway of blueprint.metadata?.doorways || []) {
      addTarget({ role: 'door', type: 'door', accessCells: [doorway] })
    }
  }
  return targets
}

function entranceCells(layoutPlan, blueprint) {
  const cells = []
  for (const entrance of layoutPlan.entrances || []) {
    cells.push(...(entrance.cells || []))
  }
  for (const doorway of blueprint.metadata?.doorways || []) {
    if (Number.isFinite(Number(doorway?.x)) && Number.isFinite(Number(doorway?.y)) && Number.isFinite(Number(doorway?.z))) {
      cells.push({ x: Number(doorway.x), y: Number(doorway.y), z: Number(doorway.z) })
    }
  }
  return uniquePositions(cells)
}

function buildGraph({ standable, blockNameAt, allowJump }) {
  const graph = new Map()
  for (const cell of standable.values()) {
    const neighbors = []
    for (const offset of [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 }
    ]) {
      for (const dy of [-1, 0, 1]) {
        const next = { x: cell.x + offset.x, y: cell.y + dy, z: cell.z + offset.z }
        if (!standable.has(posKey(next))) continue
        if (dy !== 0 && !allowJump && !verticalTransitionAllowed(cell, next, blockNameAt)) continue
        if (dy !== 0 && allowJump && !verticalTransitionAllowed(cell, next, blockNameAt) && Math.abs(dy) > 1) continue
        neighbors.push(next)
      }
    }
    for (const dy of [-1, 1]) {
      const next = { x: cell.x, y: cell.y + dy, z: cell.z }
      if (!standable.has(posKey(next))) continue
      if (!verticalTransitionAllowed(cell, next, blockNameAt)) continue
      neighbors.push(next)
    }
    graph.set(posKey(cell), neighbors)
  }
  return graph
}

function multiSourceSearch(graph, sources = []) {
  const visited = new Set()
  const previous = new Map()
  const queue = []
  for (const source of sources) {
    const key = posKey(source)
    if (!graph.has(key) || visited.has(key)) continue
    visited.add(key)
    queue.push(source)
  }

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    for (const next of graph.get(posKey(current)) || []) {
      const nextKey = posKey(next)
      if (visited.has(nextKey)) continue
      visited.add(nextKey)
      previous.set(nextKey, posKey(current))
      queue.push(next)
    }
  }
  return { visited, previous }
}

function reconstructPath(previous, target) {
  const path = []
  let key = posKey(target)
  while (key) {
    const [x, y, z] = key.split(',').map(Number)
    path.push({ x, y, z })
    key = previous.get(key)
  }
  return path.reverse()
}

function firstChokepoint(path, standable, blockNameAt, layoutPlan) {
  if ((layoutPlan.minMainPathWidth || 2) < 2) return path[0] || null
  if (!Array.isArray(path) || path.length < 3) return null

  for (let index = 1; index < path.length - 1; index++) {
    const prev = path[index - 1]
    const cell = path[index]
    const next = path[index + 1]
    if (isStairSupport(cell, blockNameAt)) continue
    if (prev.y !== cell.y || next.y !== cell.y) continue
    const axis = Math.abs(next.x - prev.x) >= Math.abs(next.z - prev.z) ? 'x' : 'z'
    const sideA = axis === 'x'
      ? { x: cell.x, y: cell.y, z: cell.z + 1 }
      : { x: cell.x + 1, y: cell.y, z: cell.z }
    const sideB = axis === 'x'
      ? { x: cell.x, y: cell.y, z: cell.z - 1 }
      : { x: cell.x - 1, y: cell.y, z: cell.z }
    const width = 1 + (standable.has(posKey(sideA)) ? 1 : 0) + (standable.has(posKey(sideB)) ? 1 : 0)
    if (width < 2) return cell
  }
  return null
}

function adjacentUseCells(placement, standable) {
  const base = normalizePoint(placement)
  if (!base) return []
  return [
    { x: base.x + 1, y: base.y, z: base.z },
    { x: base.x - 1, y: base.y, z: base.z },
    { x: base.x, y: base.y, z: base.z + 1 },
    { x: base.x, y: base.y, z: base.z - 1 }
  ].filter(cell => standable.has(posKey(cell)))
}

function standableCellsInBounds(bounds, standable) {
  const normalized = normalizeBounds(bounds)
  if (!normalized) return []
  const cells = []
  for (let x = normalized.minX; x <= normalized.maxX; x++) {
    for (let y = normalized.minY; y <= normalized.maxY; y++) {
      for (let z = normalized.minZ; z <= normalized.maxZ; z++) {
        const cell = { x, y, z }
        if (standable.has(posKey(cell))) cells.push(cell)
      }
    }
  }
  return cells
}

function isStandable(cell, blockNameAt) {
  const feet = blockNameAt(cell)
  const head = blockNameAt({ x: cell.x, y: cell.y + 1, z: cell.z })
  const support = blockNameAt({ x: cell.x, y: cell.y - 1, z: cell.z })
  return isPassableName(feet) && isPassableName(head) && isWalkableSupport(support)
}

function verticalTransitionAllowed(from, to, blockNameAt) {
  if (Math.abs(to.y - from.y) > 1) return false
  if (to.y === from.y) return true
  return isStairSupport(from, blockNameAt) ||
    isStairSupport(to, blockNameAt) ||
    isClimbableName(blockNameAt(from)) ||
    isClimbableName(blockNameAt(to))
}

function isStairSupport(cell, blockNameAt) {
  return isStairName(blockNameAt({ x: cell.x, y: cell.y - 1, z: cell.z }))
}

function isWalkableSupport(name) {
  return !isAirName(name)
}

function isStairName(name) {
  return STAIR_BLOCKS.has(name)
}

function isClimbableName(name) {
  return CLIMBABLE_BLOCKS.has(name)
}

function makeBlockReader({ context, expectedBlocks, origin, blueprintOrigin, mode }) {
  if (mode === 'world' && context?.bot?.blockAt) {
    return point => {
      const world = {
        x: origin.x + point.x - blueprintOrigin.x,
        y: origin.y + point.y - blueprintOrigin.y,
        z: origin.z + point.z - blueprintOrigin.z
      }
      try {
        return context.bot.blockAt(toBlockVec3(world))?.name || 'air'
      } catch {
        return 'air'
      }
    }
  }
  return point => expectedBlocks.get(posKey(point)) || 'air'
}

function expandedBounds(blocks, pad) {
  const raw = blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.x),
    maxX: Math.max(bounds.maxX, block.x),
    minY: Math.min(bounds.minY, block.y),
    maxY: Math.max(bounds.maxY, block.y),
    minZ: Math.min(bounds.minZ, block.z),
    maxZ: Math.max(bounds.maxZ, block.z)
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  })
  return {
    minX: raw.minX - pad,
    maxX: raw.maxX + pad,
    minY: raw.minY,
    maxY: raw.maxY + 1,
    minZ: raw.minZ - pad,
    maxZ: raw.maxZ + pad
  }
}

function normalizeFurnitureRole(role, type) {
  if (role === 'bed' || type === 'white_bed' || type === 'bed' || type === 'white_wool') return 'bed'
  if (role === 'chest' || type === 'chest' || type === 'trapped_chest') return 'chest'
  if (role === 'furnace' || type === 'furnace' || type === 'blast_furnace' || type === 'smoker') return 'furnace'
  if (role === 'crafting_table' || type === 'crafting_table') return 'crafting_table'
  return role || type
}

function normalizePoint(point) {
  if (!point) return null
  const x = Number(point.x)
  const y = Number(point.y)
  const z = Number(point.z)
  if (![x, y, z].every(Number.isFinite)) return null
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z) }
}

function normalizeOrigin(origin) {
  return normalizePoint(origin) || { x: 0, y: 0, z: 0 }
}

function normalizeBounds(bounds) {
  if (!bounds) return null
  const minX = Number(bounds.minX)
  const maxX = Number(bounds.maxX)
  const minY = Number(bounds.minY)
  const maxY = Number(bounds.maxY)
  const minZ = Number(bounds.minZ)
  const maxZ = Number(bounds.maxZ)
  if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) return null
  return {
    minX: Math.min(minX, maxX),
    maxX: Math.max(minX, maxX),
    minY: Math.min(minY, maxY),
    maxY: Math.max(minY, maxY),
    minZ: Math.min(minZ, maxZ),
    maxZ: Math.max(minZ, maxZ)
  }
}

function uniquePositions(positions) {
  const seen = new Set()
  const output = []
  for (const raw of positions || []) {
    const position = normalizePoint(raw)
    if (!position) continue
    const key = posKey(position)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(position)
  }
  return output
}

function fail(failures) {
  return {
    ok: false,
    enabled: true,
    failures,
    targets: [],
    reachableTargets: [],
    unreachableTargets: []
  }
}

function isAirName(name) {
  return AIR_BLOCKS.has(name)
}

function isPassableName(name) {
  return isAirName(name) || isDoorName(name) || isClimbableName(name)
}

function isDoorName(name) {
  const value = String(name || '')
  return DOOR_PATTERN.test(value) && !TRAPDOOR_PATTERN.test(value)
}

function posKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

module.exports = {
  WalkabilityChecker,
  AIR_BLOCKS,
  STAIR_BLOCKS
}
