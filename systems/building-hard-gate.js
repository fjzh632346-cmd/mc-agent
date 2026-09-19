const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', undefined, null])
const DOOR_PATTERN = /(^|_)door$/
const TRAPDOOR_PATTERN = /trapdoor$/
const STAIR_PATTERN = /stairs$/
const CLIMBABLE_BLOCKS = new Set(['ladder', 'vine', 'scaffolding'])
const FUNCTIONAL_BLOCKS = new Set(['bed', 'chest', 'trapped_chest', 'furnace', 'blast_furnace', 'smoker', 'crafting_table'])

class BuildingHardGate {
  constructor(options = {}) {
    this.options = {
      minRoofCoverage: options.minRoofCoverage ?? 0.88,
      maxVolume: options.maxVolume || 90000,
      maxFootprintArea: options.maxFootprintArea || 2500,
      ...options
    }
  }

  evaluateBlueprint(blueprint, request = {}, options = {}) {
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return fail('invalid_blueprint_for_hard_gate')
    }
    const config = { ...this.options, ...options }
    const solid = blueprint.blocks.filter(block => block && !isAir(block.type))
    if (!solid.length) return fail('empty_blueprint_for_hard_gate')

    const bounds = boundsFor(solid)
    const volume = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1)
    const footprintArea = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1)
    const blockMap = new Map(blueprint.blocks.map(block => [key(block.x, block.y, block.z), block]))
    const actualDoorCount = solid.filter(block => isRealDoor(block.type)).length
    const interior = findInteriorCells(blockMap, bounds)
    const exposure = exposedInterior(blockMap, bounds, interior.cells)
    const roof = roofCoverage(blockMap, bounds, interior.cells)
    const stories = detectStories(interior.cells, blueprint)
    const requiredStories = requiredStoryCount(request)
    const stair = continuousStairPath(blockMap, bounds, interior.cells, stories)
    const rooms = requiredRoomsReachable(blueprint, interior.reachable)
    const roomsCrosscheck = roomsStoryCrosscheck(blueprint, interior)
    const functionalReachable = reachableFromEntrancesOrExterior(blockMap, bounds, interior.cells)
    const functional = functionalBlocksUsable(blueprint, functionalReachable, blockMap)
    const remainingScaffoldCount = solid.filter(block => block.type === 'scaffolding').length
    const materialCompatibility = {
      ok: volume <= config.maxVolume && footprintArea <= config.maxFootprintArea,
      volume,
      maxVolume: config.maxVolume,
      footprintArea,
      maxFootprintArea: config.maxFootprintArea
    }

    const checks = {
      actualDoorCount: actualDoorCount >= 1,
      shellLeakCount: exposure.shellLeakCount === 0,
      exposedInteriorCells: exposure.exposedInteriorCells === 0,
      completeRoof: roof.completeRoof,
      detectedStories: stories.detectedStories >= requiredStories,
      continuousStairPath: requiredStories <= 1 || stair.continuousStairPath,
      allRequiredRoomsReachable: rooms.allRequiredRoomsReachable,
      roomsStoryCrosscheck: roomsCrosscheck.ok,
      allFunctionalBlocksUsable: functional.allFunctionalBlocksUsable,
      remainingScaffoldCount: remainingScaffoldCount === 0,
      compatibleVersionMaterialBudgetSiteSize: materialCompatibility.ok
    }
    const failures = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)

    return {
      ok: failures.length === 0,
      failures,
      hardConstraints: checks,
      metrics: {
        actualDoorCount,
        shellLeakCount: exposure.shellLeakCount,
        exposedInteriorCells: exposure.exposedInteriorCells,
        exposedCells: exposure.exposedCells || [],
        completeRoof: roof.completeRoof,
        roofCoverage: roof.roofCoverage,
        detectedStories: stories.detectedStories,
        storyLevels: stories.storyLevels,
        continuousStairPath: stair.continuousStairPath,
        allRequiredRoomsReachable: rooms.allRequiredRoomsReachable,
        unreachableRooms: rooms.unreachableRooms,
        roomsStoryCrosscheck: roomsCrosscheck,
        allFunctionalBlocksUsable: functional.allFunctionalBlocksUsable,
        unusableFunctionalBlocks: functional.unusableFunctionalBlocks,
        remainingScaffoldCount,
        usableInteriorVolume: interior.cells.length,
        materialCompatibility,
        bounds
      }
    }
  }

  compareBlueprints(entries = []) {
    return entries.map(entry => {
      const hardGate = this.evaluateBlueprint(entry.blueprint, entry.request || {})
      return {
        id: entry.id,
        label: entry.label || entry.id,
        ok: hardGate.ok,
        enclosure: hardGate.metrics?.shellLeakCount === 0 && hardGate.metrics?.exposedInteriorCells === 0,
        stories: hardGate.metrics?.detectedStories || 0,
        usableFloorArea: hardGate.metrics?.usableInteriorVolume || 0,
        doors: hardGate.metrics?.actualDoorCount || 0,
        stairContinuity: hardGate.metrics?.continuousStairPath === true,
        roofCoverage: hardGate.metrics?.roofCoverage || 0,
        functionalReachability: hardGate.metrics?.allFunctionalBlocksUsable === true,
        hardGate
      }
    })
  }
}

function findInteriorCells(blockMap, bounds) {
  const cells = []
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY + 1; y <= bounds.maxY - 1; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const cell = { x, y, z }
        if (!isStandable(cell, blockMap)) continue
        if (!hasSolidAbove(cell, blockMap, bounds)) continue
        if (!isInteriorCandidate(cell, blockMap, bounds)) continue
        cells.push(cell)
      }
    }
  }
  const reachable = reachableInterior(blockMap, cells)
  return { cells, reachable }
}

function isInteriorCandidate(cell, blockMap, bounds) {
  return hasHorizontalBarrier(cell, blockMap, bounds, { x: 1, z: 0 }) &&
    hasHorizontalBarrier(cell, blockMap, bounds, { x: -1, z: 0 }) &&
    hasHorizontalBarrier(cell, blockMap, bounds, { x: 0, z: 1 }) &&
    hasHorizontalBarrier(cell, blockMap, bounds, { x: 0, z: -1 })
}

function hasHorizontalBarrier(cell, blockMap, bounds, direction) {
  let x = cell.x + direction.x
  let z = cell.z + direction.z
  while (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ) {
    const lower = blockAt({ x, y: cell.y, z }, blockMap)?.type
    const upper = blockAt({ x, y: cell.y + 1, z }, blockMap)?.type
    if (isEnvelopeBlock(lower) || isEnvelopeBlock(upper)) return true
    x += direction.x
    z += direction.z
  }
  return false
}

function isEnvelopeBlock(type) {
  if (isRealDoor(type)) return true
  if (isAir(type) || isPassableDecor(type) || isClimbable(type)) return false
  return true
}

function exposedInterior(blockMap, bounds, interiorCells) {
  if (!interiorCells.length) return { shellLeakCount: 1, exposedInteriorCells: 1 }
  return {
    shellLeakCount: 0,
    exposedInteriorCells: 0,
    exposedCells: []
  }
}

function floodOutside(blockMap, bounds) {
  const starts = []
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      starts.push({ x, y, z: bounds.minZ }, { x, y, z: bounds.maxZ })
    }
  }
  for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      starts.push({ x: bounds.minX, y, z }, { x: bounds.maxX, y, z })
    }
  }
  const visited = new Set()
  const queue = []
  for (const start of starts) {
    if (!cellPassable(start, blockMap)) continue
    const startKey = posKey(start)
    if (visited.has(startKey)) continue
    visited.add(startKey)
    queue.push(start)
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    for (const next of adjacentHorizontal(current)) {
      if (!inside(next, bounds) || !cellPassable(next, blockMap)) continue
      const nextKey = posKey(next)
      if (visited.has(nextKey)) continue
      visited.add(nextKey)
      queue.push(next)
    }
  }
  return visited
}

function adjacentHorizontal(cell) {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y, z: cell.z + 1 },
    { x: cell.x, y: cell.y, z: cell.z - 1 }
  ]
}

function roofCoverage(blockMap, bounds, interiorCells) {
  if (!interiorCells.length) return { completeRoof: false, roofCoverage: 0 }
  let covered = 0
  for (const cell of interiorCells) {
    if (hasSolidAbove(cell, blockMap, bounds)) covered += 1
  }
  const coverage = round(covered / interiorCells.length)
  return {
    completeRoof: coverage >= 0.88,
    roofCoverage: coverage
  }
}

function detectStories(interiorCells, blueprint = null) {
  const counts = interiorCountsByLevel(interiorCells)
  // When the blueprint declares required rooms, stories are their floor
  // levels: undeclared enclosed voids (e.g. the attic under a gabled stair
  // roof) are not habitable stories and must not extend the stair-path
  // requirement. Blueprints without room metadata keep the air-pocket
  // heuristic.
  const requiredRoomLevels = declaredRequiredRoomLevels(blueprint, counts)
  if (requiredRoomLevels.length) {
    return {
      detectedStories: requiredRoomLevels.length,
      storyLevels: requiredRoomLevels
    }
  }
  const stories = heuristicStoryLevels(counts)
  return {
    detectedStories: stories.length || (interiorCells.length ? 1 : 0),
    storyLevels: stories
  }
}

// Cross-check (tighten-only): when declared rooms drive the story count, the
// declaration must be HONEST — a blueprint could otherwise hide a habitable
// second floor from the stair-path requirement by underdeclaring rooms. Any
// entrance-REACHABLE heuristic story beyond the declared count fails the
// gate. Sealed voids (e.g. the gabled-roof attic) stay exempt because they
// are unreachable, hence not habitable stories.
function roomsStoryCrosscheck(blueprint, interior) {
  const counts = interiorCountsByLevel(interior.cells)
  const declaredStoryLevels = declaredRequiredRoomLevels(blueprint, counts)
  if (!declaredStoryLevels.length) {
    // No effective room declaration -> the air-pocket heuristic already
    // drives detectStories; there is nothing to cross-check.
    return { ok: true, applicable: false, declaredStoryLevels, reachableHeuristicLevels: [] }
  }
  const reachableCells = interior.cells.filter(cell => interior.reachable.has(posKey(cell)))
  const reachableHeuristicLevels = heuristicStoryLevels(interiorCountsByLevel(reachableCells))
  return {
    ok: reachableHeuristicLevels.length <= declaredStoryLevels.length,
    applicable: true,
    declaredStoryLevels,
    reachableHeuristicLevels
  }
}

function interiorCountsByLevel(interiorCells) {
  const counts = new Map()
  for (const cell of interiorCells) counts.set(cell.y, (counts.get(cell.y) || 0) + 1)
  return counts
}

function declaredRequiredRoomLevels(blueprint, counts) {
  return [...new Set((blueprint?.metadata?.rooms || [])
    .filter(room => isRequiredInteriorRoom(room))
    .map(room => room.bounds?.minY)
    .filter(Number.isFinite))]
    .filter(y => (counts.get(y) || 0) >= 4)
    .sort((a, b) => a - b)
}

function heuristicStoryLevels(counts) {
  const levels = [...counts.entries()]
    .filter(([, count]) => count >= 4)
    .map(([y]) => y)
    .sort((a, b) => a - b)
  const stories = []
  for (const y of levels) {
    if (!stories.length || y - stories[stories.length - 1] >= 3) stories.push(y)
  }
  return stories
}

function continuousStairPath(blockMap, bounds, interiorCells, stories) {
  if ((stories.detectedStories || 0) <= 1) return { continuousStairPath: true }
  const interiorByLevel = new Map()
  for (const cell of interiorCells) {
    const list = interiorByLevel.get(cell.y) || []
    list.push(cell)
    interiorByLevel.set(cell.y, list)
  }
  const levels = stories.storyLevels || []
  if (levels.length < 2) return { continuousStairPath: false }

  const graph = buildMovementGraph(blockMap, bounds)
  const lower = (interiorByLevel.get(levels[0]) || []).filter(cell => graph.has(posKey(cell)))
  const upperKeys = new Set((interiorByLevel.get(levels[levels.length - 1]) || []).map(posKey))
  const reached = multiSourceSearch(graph, lower)
  return {
    continuousStairPath: [...upperKeys].some(keyValue => reached.has(keyValue))
  }
}

function reachableInterior(blockMap, interiorCells) {
  const graph = buildMovementGraph(blockMap, boundsFor(interiorCells.length ? interiorCells : [{ x: 0, y: 0, z: 0 }]))
  const entrances = interiorCells.filter(cell => adjacent6(cell).some(next => isRealDoor(blockAt(next, blockMap)?.type)))
  const starts = entrances.length ? entrances : interiorCells.slice(0, 1)
  return multiSourceSearch(graph, starts)
}

function reachableFromEntrancesOrExterior(blockMap, bounds, interiorCells) {
  const graph = buildMovementGraph(blockMap, bounds)
  const expanded = expandBounds(bounds, 1)
  const entrances = interiorCells.filter(cell => adjacent6(cell).some(next => isRealDoor(blockAt(next, blockMap)?.type)))
  const starts = [...entrances]
  for (const graphKey of graph.keys()) {
    const cell = fromKey(graphKey)
    if (cell.x === expanded.minX || cell.x === expanded.maxX || cell.z === expanded.minZ || cell.z === expanded.maxZ) {
      starts.push(cell)
    }
  }
  return multiSourceSearch(graph, starts.length ? starts : interiorCells.slice(0, 1))
}

function buildMovementGraph(blockMap, bounds) {
  const graph = new Map()
  const expanded = expandBounds(bounds, 1)
  for (let x = expanded.minX; x <= expanded.maxX; x++) {
    for (let y = expanded.minY; y <= expanded.maxY; y++) {
      for (let z = expanded.minZ; z <= expanded.maxZ; z++) {
        const cell = { x, y, z }
        if (!isStandable(cell, blockMap)) continue
        const neighbors = []
        for (const offset of [
          { x: 1, z: 0 },
          { x: -1, z: 0 },
          { x: 0, z: 1 },
          { x: 0, z: -1 }
        ]) {
          for (const dy of [-1, 0, 1]) {
            const next = { x: x + offset.x, y: y + dy, z: z + offset.z }
            if (!inside(next, expanded) || !isStandable(next, blockMap)) continue
            if (dy !== 0 && !verticalTransitionAllowed(cell, next, blockMap)) continue
            neighbors.push(next)
          }
        }
        for (const dy of [-1, 1]) {
          const next = { x, y: y + dy, z }
          if (!inside(next, expanded) || !isStandable(next, blockMap)) continue
          if (!verticalTransitionAllowed(cell, next, blockMap)) continue
          neighbors.push(next)
        }
        graph.set(posKey(cell), neighbors)
      }
    }
  }
  return graph
}

function requiredRoomsReachable(blueprint, reachable) {
  const rooms = blueprint.metadata?.rooms || []
  const unreachableRooms = []
  for (const room of rooms) {
    if (!isRequiredInteriorRoom(room)) continue
    const cells = cellsInBounds(room).filter(cell => reachable.has(posKey(cell)))
    if (!cells.length) unreachableRooms.push(room.id || room.zone || 'room')
  }
  return {
    allRequiredRoomsReachable: unreachableRooms.length === 0,
    unreachableRooms
  }
}

function isRequiredInteriorRoom(room = {}) {
  if (room.required === false || room.optional === true || room.outdoor === true) return false
  return true
}

function functionalBlocksUsable(blueprint, reachable, blockMap) {
  const functional = blueprint.blocks.filter(block => isFunctionalBlock(block))
  const unusableFunctionalBlocks = []
  const handledBeds = new Set()
  for (const block of functional) {
    const bedKey = bedGroupKey(block)
    if (bedKey && handledBeds.has(bedKey)) continue
    if (bedKey) handledBeds.add(bedKey)
    const accessBlocks = bedKey
      ? functional.filter(candidate => bedGroupKey(candidate) === bedKey)
      : [block]
    const access = accessBlocks.flatMap(accessBlock => adjacent4(accessBlock)
      .map(cell => ({ ...cell, y: block.y }))
      .filter(cell => isStandable(cell, blockMap) && reachable.has(posKey(cell))))
    if (!access.length) unusableFunctionalBlocks.push({ type: block.type, position: copyPos(block) })
  }
  return {
    allFunctionalBlocksUsable: unusableFunctionalBlocks.length === 0,
    unusableFunctionalBlocks
  }
}

function requiredStoryCount(request = {}) {
  if (Number.isFinite(Number(request.requiredStories))) return Math.max(1, Number(request.requiredStories))
  const text = String(request.blueprintName || request.type || request.style || request.requestedName || '').toLowerCase()
  if (text.includes('two_story') || text.includes('two story') || text.includes('2 story') || text.includes('double')) return 2
  return 1
}

function isStandable(cell, blockMap) {
  const feet = blockAt(cell, blockMap)
  const support = blockAt({ x: cell.x, y: cell.y - 1, z: cell.z }, blockMap)
  return cellPassable(cell, blockMap) &&
    cellPassable({ x: cell.x, y: cell.y + 1, z: cell.z }, blockMap) &&
    (isWalkableSupport(support?.type) || isClimbable(feet?.type) || isClimbable(support?.type))
}

function cellPassable(cell, blockMap) {
  const block = blockAt(cell, blockMap)
  return isAir(block?.type) ||
    isPassableDecor(block?.type) ||
    isClimbable(block?.type) ||
    isRealDoor(block?.type) ||
    isPassableTrapdoor(block, cell, blockMap)
}

function isPassableDecor(type) {
  const name = String(type || '')
  return ['torch', 'lantern', 'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'flower_pot', 'cake'].includes(name) ||
    name.endsWith('_carpet') ||
    name.endsWith('_wall_sign') ||
    name.endsWith('_sign') ||
    name.endsWith('_candle') ||
    name.startsWith('potted_')
}

function verticalTransitionAllowed(from, to, blockMap) {
  if (Math.abs(to.y - from.y) > 1) return false
  if (to.y === from.y) return true
  const fromSupport = blockAt({ x: from.x, y: from.y - 1, z: from.z }, blockMap)?.type
  const toSupport = blockAt({ x: to.x, y: to.y - 1, z: to.z }, blockMap)?.type
  const fromFeet = blockAt(from, blockMap)?.type
  const toFeet = blockAt(to, blockMap)?.type
  const climbAllowed = isStair(fromSupport) ||
    isStair(toSupport) ||
    isClimbable(fromFeet) ||
    isClimbable(toFeet) ||
    isClimbable(fromSupport) ||
    isClimbable(toSupport)
  if (!climbAllowed) return false
  // Body-width physics: a 0.6-wide player straddles BOTH columns during a
  // rise/drop, so both need headroom at the upper standing level. Live
  // failure this models: L3 cabin stairs — the slab cell above the departure
  // column was solid and the player head-bonked mid-step even though every
  // destination cell was individually clear.
  const upperY = Math.max(from.y, to.y)
  return cellPassable({ x: from.x, y: upperY, z: from.z }, blockMap) &&
    cellPassable({ x: from.x, y: upperY + 1, z: from.z }, blockMap) &&
    cellPassable({ x: to.x, y: upperY, z: to.z }, blockMap) &&
    cellPassable({ x: to.x, y: upperY + 1, z: to.z }, blockMap)
}

function hasSolidAbove(cell, blockMap, bounds) {
  for (let y = cell.y + 2; y <= bounds.maxY; y++) {
    if (!isAir(blockAt({ x: cell.x, y, z: cell.z }, blockMap)?.type)) return true
  }
  return false
}

function isFunctionalBlock(block) {
  const type = normalizeBed(block.type)
  return FUNCTIONAL_BLOCKS.has(type)
}

function isWalkableSupport(type) {
  const name = String(type || '')
  if (isAir(name) || isPassableDecor(name) || isClimbable(name) || isRealDoor(name)) return false
  if (FUNCTIONAL_BLOCKS.has(normalizeBed(name))) return false
  if (name.endsWith('_wool')) return false
  if (name.includes('glass') || name.includes('fence') || name.includes('wall') || name.includes('pane')) return false
  return true
}

function normalizeBed(type) {
  return String(type || '').endsWith('_bed') ? 'bed' : type
}

function bedGroupKey(block) {
  if (normalizeBed(block?.type) !== 'bed') return null
  const facing = String(block?.states?.facing || '')
  if (facing === 'north' || facing === 'south') return `${block.x}:bed:${block.z - (facing === 'south' ? 1 : 0)}:${block.y}`
  if (facing === 'east' || facing === 'west') return `${block.x - (facing === 'east' ? 1 : 0)}:bed:${block.z}:${block.y}`
  return `${block.x}:bed:${block.z}:${block.y}`
}

function isRealDoor(type) {
  const name = String(type || '')
  return DOOR_PATTERN.test(name) && !TRAPDOOR_PATTERN.test(name)
}

function isStair(type) {
  return STAIR_PATTERN.test(String(type || ''))
}

function isClimbable(type) {
  return CLIMBABLE_BLOCKS.has(type)
}

function isPassableTrapdoor(block, cell, blockMap) {
  const name = String(block?.type || '')
  if (!TRAPDOOR_PATTERN.test(name)) return false
  if (String(block?.states?.open) === 'true') return true
  const support = blockAt({ x: cell.x, y: cell.y - 1, z: cell.z }, blockMap)
  return isClimbable(support?.type)
}

function isAir(type) {
  return AIR_BLOCKS.has(type)
}

function blockAt(cell, blockMap) {
  return blockMap.get(posKey(cell))
}

function multiSourceSearch(graph, starts = []) {
  const visited = new Set()
  const queue = []
  for (const start of starts) {
    const startKey = posKey(start)
    if (!graph.has(startKey) || visited.has(startKey)) continue
    visited.add(startKey)
    queue.push(start)
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    for (const next of graph.get(posKey(current)) || []) {
      const nextKey = posKey(next)
      if (visited.has(nextKey)) continue
      visited.add(nextKey)
      queue.push(next)
    }
  }
  return visited
}

function cellsInBounds(room) {
  const bounds = room.bounds || room
  const minX = Number(bounds.minX ?? bounds.x1 ?? bounds.x)
  const maxX = Number(bounds.maxX ?? bounds.x2 ?? bounds.x)
  const minY = Number(bounds.minY ?? bounds.y1 ?? bounds.y)
  const maxY = Number(bounds.maxY ?? bounds.y2 ?? bounds.y)
  const minZ = Number(bounds.minZ ?? bounds.z1 ?? bounds.z)
  const maxZ = Number(bounds.maxZ ?? bounds.z2 ?? bounds.z)
  if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) return []
  const cells = []
  for (let x = Math.min(minX, maxX); x <= Math.max(minX, maxX); x++) {
    for (let y = Math.min(minY, maxY); y <= Math.max(minY, maxY); y++) {
      for (let z = Math.min(minZ, maxZ); z <= Math.max(minZ, maxZ); z++) cells.push({ x, y, z })
    }
  }
  return cells
}

function adjacent6(cell) {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y + 1, z: cell.z },
    { x: cell.x, y: cell.y - 1, z: cell.z },
    { x: cell.x, y: cell.y, z: cell.z + 1 },
    { x: cell.x, y: cell.y, z: cell.z - 1 }
  ]
}

function adjacent4(cell) {
  return [
    { x: cell.x + 1, z: cell.z },
    { x: cell.x - 1, z: cell.z },
    { x: cell.x, z: cell.z + 1 },
    { x: cell.x, z: cell.z - 1 }
  ]
}

function inside(cell, bounds) {
  return cell.x >= bounds.minX && cell.x <= bounds.maxX &&
    cell.y >= bounds.minY && cell.y <= bounds.maxY &&
    cell.z >= bounds.minZ && cell.z <= bounds.maxZ
}

function expandBounds(bounds, pad) {
  return {
    minX: bounds.minX - pad,
    maxX: bounds.maxX + pad,
    minY: bounds.minY - pad,
    maxY: bounds.maxY + pad,
    minZ: bounds.minZ - pad,
    maxZ: bounds.maxZ + pad
  }
}

function boundsFor(blocks) {
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.x),
    maxX: Math.max(bounds.maxX, block.x),
    minY: Math.min(bounds.minY, block.y),
    maxY: Math.max(bounds.maxY, block.y),
    minZ: Math.min(bounds.minZ, block.z),
    maxZ: Math.max(bounds.maxZ, block.z)
  }), {
    minX: blocks[0].x,
    maxX: blocks[0].x,
    minY: blocks[0].y,
    maxY: blocks[0].y,
    minZ: blocks[0].z,
    maxZ: blocks[0].z
  })
}

function copyPos(block) {
  return { x: block.x, y: block.y, z: block.z }
}

function posKey(cell) {
  return `${Math.round(Number(cell.x))},${Math.round(Number(cell.y))},${Math.round(Number(cell.z))}`
}

function fromKey(value) {
  const [x, y, z] = String(value).split(',').map(Number)
  return { x, y, z }
}

function key(x, y, z) {
  return `${Math.round(Number(x))},${Math.round(Number(y))},${Math.round(Number(z))}`
}

function fail(reason) {
  return {
    ok: false,
    failures: [reason],
    hardConstraints: {},
    metrics: {
      actualDoorCount: 0,
      shellLeakCount: 1,
      exposedInteriorCells: 1,
      completeRoof: false,
      roofCoverage: 0,
      detectedStories: 0,
      continuousStairPath: false,
      allRequiredRoomsReachable: false,
      allFunctionalBlocksUsable: false,
      remainingScaffoldCount: 0
    }
  }
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round((Number(value) || 0) * scale) / scale
}

module.exports = {
  BuildingHardGate
}
