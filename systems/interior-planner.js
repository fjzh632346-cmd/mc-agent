const REQUIRED_BASIC_FURNITURE = Object.freeze(['bed', 'crafting_table', 'furnace', 'chest'])
const BED_FURNITURE_BLOCK = 'white_wool'

class InteriorPlanner {
  constructor(options = {}) {
    this.options = {
      enabled: options.enabled !== false,
      ...options
    }
  }

  plan(blueprint, request = {}) {
    if (!this.options.enabled) return disabledPlan(blueprint)
    if (!blueprint || !Array.isArray(blueprint.blocks)) return { ok: false, error: 'invalid_blueprint_for_interior' }

    const profile = blueprint.metadata?.interiorProfile || 'none'
    if (profile === 'none') return disabledPlan(blueprint)

    const rooms = detectRooms(blueprint)
    const avoid = avoidanceSet(blueprint)
    const occupied = occupiedSet(blueprint.blocks)
    const placements = []
    const skipped = []
    const taken = new Set()
    const anchors = Array.isArray(blueprint.metadata?.interiorAnchors) ? blueprint.metadata.interiorAnchors : []

    for (const spec of furnitureSpecs(profile, request)) {
      const anchor = anchors.find(candidate => candidate.role === spec.role || candidate.type === spec.type)
      const placed = anchor
        ? placeFromAnchor(anchor, spec, occupied, avoid, taken)
        : placeFromRoom(rooms, spec, occupied, avoid, taken)
      if (placed) placements.push(placed)
      else skipped.push({ role: spec.role, type: spec.type, reason: 'no_safe_position' })
    }

    const blockMap = new Map(blueprint.blocks.map(block => [posKey(block), { ...block }]))
    for (const placement of placements) {
      blockMap.set(posKey(placement), {
        x: placement.x,
        y: placement.y,
        z: placement.z,
        type: placement.type,
        role: placement.role,
        roomId: placement.roomId || null,
        zone: placement.zone || null,
        phase: 'interior',
        interior: true
      })
    }

    const planned = {
      enabled: true,
      profile,
      rooms,
      placements,
      skipped,
      requiredFurniture: REQUIRED_BASIC_FURNITURE,
      presentFurniture: placements.map(placement => placement.role),
      complete: requiredFurnitureForProfile(profile).every(role => placements.some(placement => placement.role === role)),
      pathPreserved: placements.every(placement => !avoid.has(posKey(placement))),
      source: anchors.length ? 'metadata_anchors' : 'room_inference'
    }

    return {
      ok: true,
      blueprint: {
        ...blueprint,
        metadata: {
          ...(blueprint.metadata || {}),
          interiorPlanned: true,
          interiorProfile: profile,
          interiorRooms: rooms.map(room => ({ id: room.id, zone: room.zone, bounds: room.bounds }))
        },
        blocks: [...blockMap.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z))
      },
      plan: planned
    }
  }
}

function detectRooms(blueprint) {
  const metadataRooms = blueprint.metadata?.rooms
  if (Array.isArray(metadataRooms) && metadataRooms.length) {
    return metadataRooms
      .filter(room => room?.outdoor !== true)
      .map((room, index) => ({
        id: room.id || `room_${index + 1}`,
        zone: room.zone || 'room',
        bounds: normalizeBounds(room.bounds)
      }))
      .filter(room => room.bounds)
  }

  const nonAir = blueprint.blocks.filter(block => !isAir(block.type))
  if (!nonAir.length) return []
  const xs = nonAir.map(block => block.x)
  const zs = nonAir.map(block => block.z)
  const minY = Math.min(...nonAir.map(block => block.y)) + 1
  return [{
    id: 'main',
    zone: blueprint.metadata?.buildingType || 'room',
    bounds: {
      minX: Math.min(...xs) + 1,
      maxX: Math.max(...xs) - 1,
      minY,
      maxY: minY,
      minZ: Math.min(...zs) + 1,
      maxZ: Math.max(...zs) - 1
    }
  }]
}

function furnitureSpecs(profile) {
  if (profile === 'decorative') return []
  if (profile === 'modern_villa') {
    return [
      { role: 'bed', type: BED_FURNITURE_BLOCK, preferredZone: 'bedroom' },
      { role: 'furnace', type: 'furnace', preferredZone: 'kitchen' },
      { role: 'chest', type: 'chest', preferredZone: 'kitchen' },
      { role: 'crafting_table', type: 'crafting_table', preferredZone: 'utility' },
      { role: 'sofa', type: 'oak_planks', preferredZone: 'living_room' },
      { role: 'table', type: 'glass', preferredZone: 'living_room' }
    ]
  }
  if (profile === 'castle') {
    return [
      { role: 'bed', type: BED_FURNITURE_BLOCK, preferredZone: 'room' },
      { role: 'crafting_table', type: 'crafting_table', preferredZone: 'work' },
      { role: 'furnace', type: 'furnace', preferredZone: 'hall' },
      { role: 'chest', type: 'chest', preferredZone: 'storage' }
    ]
  }
  return [
    { role: 'bed', type: BED_FURNITURE_BLOCK, preferredZone: 'bedroom' },
    { role: 'crafting_table', type: 'crafting_table', preferredZone: 'work' },
    { role: 'furnace', type: 'furnace', preferredZone: 'work' },
    { role: 'chest', type: 'chest', preferredZone: 'storage' },
    { role: 'table', type: 'oak_planks', preferredZone: 'living_room' }
  ]
}

function requiredFurnitureForProfile(profile) {
  if (profile === 'decorative') return []
  return REQUIRED_BASIC_FURNITURE
}

function placeFromAnchor(anchor, spec, occupied, avoid, taken) {
  const placement = {
    x: Number(anchor.x),
    y: Number(anchor.y),
    z: Number(anchor.z),
    type: anchor.type || spec.type,
    role: anchor.role || spec.role,
    roomId: anchor.roomId || null,
    zone: anchor.zone || spec.preferredZone || null
  }
  if (![placement.x, placement.y, placement.z].every(Number.isFinite)) return null
  const key = posKey(placement)
  if (occupied.has(key) || avoid.has(key) || taken.has(key)) return null
  taken.add(key)
  return placement
}

function placeFromRoom(rooms, spec, occupied, avoid, taken) {
  const sorted = [...rooms].sort((a, b) => roomScore(b, spec) - roomScore(a, spec))
  for (const room of sorted) {
    for (const position of roomPositions(room)) {
      const key = posKey(position)
      if (occupied.has(key) || avoid.has(key) || taken.has(key)) continue
      taken.add(key)
      return {
        ...position,
        type: spec.type,
        role: spec.role,
        roomId: room.id,
        zone: room.zone
      }
    }
  }
  return null
}

function roomScore(room, spec) {
  if (!spec.preferredZone) return 0
  if (room.zone === spec.preferredZone) return 3
  if (String(room.zone || '').includes(spec.preferredZone)) return 2
  if (String(spec.preferredZone).includes(room.zone)) return 1
  return 0
}

function roomPositions(room) {
  const bounds = room.bounds
  const positions = []
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) positions.push({ x, y, z })
    }
  }
  return positions
}

function avoidanceSet(blueprint) {
  const avoid = new Set()
  const metadata = blueprint.metadata || {}
  for (const listName of ['doorways', 'windows', 'avoidInterior']) {
    for (const position of metadata[listName] || []) avoid.add(posKey(position))
  }
  for (const area of metadata.walkways || []) {
    const bounds = normalizeBounds(area)
    if (!bounds) continue
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z++) avoid.add(`${x},${y},${z}`)
      }
    }
  }
  for (const block of blueprint.blocks || []) {
    if (block.role === 'doorway' || block.role === 'window' || block.phase === 'path') avoid.add(posKey(block))
  }
  return avoid
}

function occupiedSet(blocks = []) {
  const occupied = new Set()
  for (const block of blocks) {
    if (!block || isAir(block.type)) continue
    occupied.add(posKey(block))
  }
  return occupied
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

function disabledPlan(blueprint) {
  return {
    ok: true,
    blueprint,
    plan: {
      enabled: false,
      profile: 'none',
      rooms: [],
      placements: [],
      skipped: [],
      complete: true,
      pathPreserved: true,
      source: 'disabled'
    }
  }
}

function posKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function isAir(type) {
  return ['air', 'cave_air', 'void_air'].includes(type)
}

module.exports = {
  InteriorPlanner,
  BED_FURNITURE_BLOCK,
  REQUIRED_BASIC_FURNITURE,
  detectRooms
}
