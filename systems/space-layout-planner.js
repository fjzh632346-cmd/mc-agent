const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])

class SpaceLayoutPlanner {
  constructor(options = {}) {
    this.options = {
      enabled: options.enabled !== false,
      minMainPathWidth: options.minMainPathWidth || 2,
      ...options
    }
  }

  plan(blueprint, request = {}) {
    if (!this.options.enabled) return disabledPlan(blueprint)
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return { ok: false, error: 'invalid_blueprint_for_space_layout' }
    }

    const style = normalizeStyle(
      request.style ||
      blueprint.metadata?.design?.style ||
      blueprint.metadata?.style ||
      blueprint.metadata?.buildingType ||
      blueprint.name
    )
    const rooms = normalizeRooms(blueprint.metadata?.rooms)
    const profile = blueprint.metadata?.interiorProfile || (rooms.length ? 'basic_house' : 'none')
    const functional = profile !== 'none' || rooms.length > 0 || Array.isArray(blueprint.metadata?.interiorAnchors)
    if (!functional) return disabledPlan(blueprint)

    const blockMap = createBlockMap(blueprint.blocks)
    const plan = createPlan({ style, profile, rooms, minMainPathWidth: this.options.minMainPathWidth })

    if (style === 'modern') applyModernLayout(blockMap, plan)
    else if (style === 'castle') applyCastleLayout(blockMap, plan)
    else applyWoodLayout(blockMap, plan, request)
    reserveInteriorAnchors(blockMap, plan)

    const validation = validateLayout(plan, blockMap)
    if (!validation.ok) {
      return {
        ok: false,
        error: `space_layout_failed:${validation.failures[0] || 'unknown'}`,
        plan
      }
    }

    const updatedMetadata = {
      ...(blueprint.metadata || {}),
      rooms: plan.rooms.map(room => ({
        id: room.id,
        zone: room.zone,
        bounds: room.bounds,
        entrance: room.entrance || null,
        outdoor: room.outdoor === true,
        required: room.required === false ? false : true
      })),
      walkways: plan.walkways,
      doorways: plan.doorways,
      avoidInterior: uniquePositions([
        ...(blueprint.metadata?.avoidInterior || []),
        ...plan.pathCells,
        ...plan.stairCells
      ]),
      interiorAnchors: plan.interiorAnchors,
      functionalLayout: summarizeLayout(plan)
    }

    return {
      ok: true,
      blueprint: {
        ...blueprint,
        metadata: updatedMetadata,
        blocks: [...blockMap.values()].sort(sortBlocks)
      },
      plan: summarizeLayout(plan)
    }
  }
}

function createPlan({ style, profile, rooms, minMainPathWidth }) {
  return {
    enabled: true,
    style: style || 'wood',
    profile,
    minMainPathWidth,
    rooms: rooms.length ? rooms : defaultRooms(style),
    doorways: [],
    entrances: [],
    walkways: [],
    pathCells: [],
    stairCells: [],
    stairs: [],
    functionalTargets: [],
    interiorAnchors: [],
    failures: []
  }
}

function applyWoodLayout(blockMap, plan, request = {}) {
  const twoStory = /two[_\s-]*story|2[_\s-]*story/.test(String(request.blueprintName || request.type || '').toLowerCase())
  plan.rooms = [
    room('living_room', 'living_room', 1, 1, 1, 4, 1, 3, { x: 2, y: 1, z: 1 }),
    room('workshop', 'work', 4, 1, 3, 4, 1, 4, { x: 3, y: 1, z: 3 }),
    ...(twoStory ? [room('upper_landing', 'bedroom', 6, 4, 2, 7, 4, 3, { x: 6, y: 4, z: 2 })] : [])
  ]

  addDoor(plan, blockMap, [{ x: 2, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }], 'front_door')
  addPathRect(plan, blockMap, 2, 1, 1, 3, 1, 3, 'main_path')
  addPathRect(plan, blockMap, 4, 1, 1, 4, 1, 3, 'stair_link')
  addWallColumn(blockMap, 5, 1, 1, 2, 'oak_planks', 'side_wing_shell')
  addWallColumn(blockMap, 5, 1, 2, 2, 'oak_planks', 'side_wing_shell')
  addFloorRect(blockMap, 2, 0, -1, 3, 0, 0, 'oak_planks', 'entry_deck')
  addFloorRect(blockMap, 4, 0, 1, 7, 0, 1, 'oak_planks', 'stair_base')
  addFloorRect(blockMap, 6, 0, 2, 7, 0, 2, 'oak_planks', 'stair_base')
  addFloorRect(blockMap, 6, 0, 3, 7, 0, 3, 'oak_planks', 'stair_base')
  setBlock(blockMap, { x: 5, y: 0, z: 2 }, 'oak_planks', { phase: 'path', role: 'stair_wall_support' })
  if (twoStory) addFloorRect(blockMap, 5, 3, 1, 8, 3, 4, 'oak_planks', 'upper_floor')
  if (twoStory) {
    addFloorRect(blockMap, 5, 0, 0, 5, 0, 0, 'oak_planks', 'side_entry_deck')
    addDoor(plan, blockMap, [{ x: 5, y: 1, z: 0 }], 'side_stair_door')
    addPathRect(plan, blockMap, 5, 1, 1, 7, 1, 1, 'ladder_lower_link')
    addPathRect(plan, blockMap, 6, 1, 2, 7, 1, 2, 'ladder_lower_link')
    addPathRect(plan, blockMap, 6, 1, 3, 7, 1, 3, 'ladder_lower_link')
    addDoor(plan, blockMap, [{ x: 5, y: 1, z: 1 }], 'stair_partition_door')
    addPathRect(plan, blockMap, 6, 4, 2, 7, 4, 3, 'upper_landing')
    addLadderAccess(plan, blockMap, {
      id: 'wood_upper_access',
      x: 7,
      z: 2,
      minY: 1,
      maxY: 4,
      backingX: 8,
      backingZ: 2,
      material: 'ladder',
      backingMaterial: 'oak_planks'
    })
  } else {
    addWallColumn(blockMap, 5, 1, 0, 2, 'oak_planks', 'stair_shell_closure')
  }

  plan.interiorAnchors = [
    anchor('bed', 'white_wool', 1, 1, 2, 'living_room', 'bedroom'),
    anchor('chest', 'chest', 1, 1, 1, 'living_room', 'storage'),
    anchor('crafting_table', 'crafting_table', 1, 1, 3, 'living_room', 'work'),
    anchor('furnace', 'furnace', 4, 1, 4, 'workshop', 'work'),
    anchor('table', 'oak_planks', 4, 1, 1, 'living_room', 'living_room')
  ]
}

function applyModernLayout(blockMap, plan) {
  plan.rooms = [
    room('living_room', 'living_room', 1, 1, 1, 2, 1, 2, { x: 2, y: 1, z: 1 }),
    room('kitchen', 'kitchen', 3, 1, 1, 5, 1, 2, { x: 3, y: 1, z: 2 }),
    room('bedroom', 'bedroom', 4, 1, 3, 5, 1, 3, { x: 4, y: 1, z: 3 })
  ]

  addDoor(plan, blockMap, [{ x: 2, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }], 'front_door')
  addPathRect(plan, blockMap, 2, 1, 0, 3, 1, 3, 'main_path')
  addPathRect(plan, blockMap, 4, 1, 2, 5, 1, 3, 'bedroom_kitchen_link')
  addFloorRect(blockMap, 6, 0, 2, 8, 0, 3, 'gray_concrete', 'stair_base')
  addStairFlight(plan, blockMap, {
    id: 'villa_roof_access',
    material: 'oak_stairs',
    supportMaterial: 'gray_concrete',
    lanes: [
      [{ x: 6, y: 1, z: 2 }, { x: 7, y: 2, z: 2 }, { x: 8, y: 3, z: 2 }],
      [{ x: 6, y: 1, z: 3 }, { x: 7, y: 2, z: 3 }, { x: 8, y: 3, z: 3 }]
    ],
    landingMaterial: 'gray_concrete'
  })
  addPathRect(plan, blockMap, 7, 3, 2, 8, 3, 3, 'roof_landing')

  plan.interiorAnchors = [
    anchor('bed', 'white_wool', 6, 1, 4, 'bedroom', 'bedroom'),
    anchor('furnace', 'furnace', 6, 1, 1, 'kitchen', 'kitchen'),
    anchor('chest', 'chest', 4, 1, 1, 'kitchen', 'kitchen'),
    anchor('crafting_table', 'crafting_table', 1, 1, 1, 'living_room', 'utility'),
    anchor('sofa', 'oak_planks', 1, 1, 2, 'living_room', 'living_room'),
    anchor('table', 'glass', 1, 1, 3, 'living_room', 'living_room')
  ]
}

function applyCastleLayout(blockMap, plan) {
  plan.rooms = [
    room('hall', 'hall', 2, 1, 1, 4, 1, 2, { x: 3, y: 1, z: 1 }),
    room('room', 'room', 2, 1, 3, 4, 1, 3, { x: 3, y: 1, z: 3 }),
    room('front_tower', 'tower', 1, 1, 1, 1, 1, 1, { x: 2, y: 1, z: 1 }),
    room('garden', 'garden', 2, 1, 6, 4, 1, 6, { x: 3, y: 1, z: 5 }, { outdoor: true, required: false })
  ]

  addDoor(plan, blockMap, [{ x: 3, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }], 'front_gate')
  clearGateArch(blockMap, [{ x: 3, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }])
  addFloorRect(blockMap, 3, 0, 0, 4, 0, 0, 'cobblestone', 'gate_floor')
  addPathRect(plan, blockMap, 3, 1, 0, 4, 1, 6, 'main_path')
  addPathRect(plan, blockMap, 2, 1, 1, 3, 1, 1, 'hall_west_link')
  addPathRect(plan, blockMap, 1, 1, 1, 2, 1, 1, 'tower_access')
  addPathRect(plan, blockMap, 3, 1, 6, 4, 1, 6, 'garden_access')
  addFloorRect(blockMap, 3, 0, 5, 4, 0, 6, 'dirt', 'garden_path')
  for (const niche of [
    { x: 1, y: 1, z: 2 },
    { x: 1, y: 1, z: 3 },
    { x: 5, y: 1, z: 2 },
    { x: 5, y: 1, z: 3 }
  ]) {
    clearInteriorSlot(blockMap, niche)
  }

  plan.functionalTargets.push(
    target('hall', 'room', [{ x: 3, y: 1, z: 1 }, { x: 4, y: 1, z: 1 }]),
    target('tower', 'tower', [{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }]),
    target('garden', 'garden', [{ x: 3, y: 1, z: 6 }, { x: 4, y: 1, z: 6 }])
  )
  plan.interiorAnchors = [
    anchor('bed', 'white_wool', 1, 1, 3, 'room', 'room'),
    anchor('crafting_table', 'crafting_table', 1, 1, 2, 'hall', 'work'),
    anchor('furnace', 'furnace', 5, 1, 3, 'hall', 'hall'),
    anchor('chest', 'chest', 5, 1, 2, 'hall', 'storage')
  ]
}

function addDoor(plan, blockMap, cells, id) {
  for (const cell of cells) {
    setBlock(blockMap, cell, 'oak_door', {
      phase: 'path',
      role: 'door',
      states: { half: 'lower', facing: 'south', hinge: 'left', open: 'false' },
      orientation: { half: 'lower', facing: 'south', hinge: 'left', open: 'false' }
    })
    setBlock(blockMap, { x: cell.x, y: cell.y + 1, z: cell.z }, 'oak_door', {
      phase: 'path',
      role: 'door',
      states: { half: 'upper', facing: 'south', hinge: 'left', open: 'false' },
      orientation: { half: 'upper', facing: 'south', hinge: 'left', open: 'false' }
    })
    plan.doorways.push({ ...cell })
    plan.doorways.push({ x: cell.x, y: cell.y + 1, z: cell.z })
    addPathCell(plan, cell, id, true)
  }
  plan.entrances.push({ id, cells: cells.map(cell => ({ ...cell })) })
}

function addPathRect(plan, blockMap, minX, minY, minZ, maxX, maxY, maxZ, role) {
  const bounds = normalizeBounds({ minX, minY, minZ, maxX, maxY, maxZ })
  if (!bounds) return
  plan.walkways.push(bounds)
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const cell = { x, y, z }
        clearStandCell(blockMap, cell, role)
        addPathCell(plan, cell, role, true)
      }
    }
  }
}

function addFloorRect(blockMap, minX, minY, minZ, maxX, maxY, maxZ, type, role) {
  const bounds = normalizeBounds({ minX, minY, minZ, maxX, maxY, maxZ })
  if (!bounds) return
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        setBlock(blockMap, { x, y, z }, type, { phase: 'path', role })
      }
    }
  }
}

function addWallColumn(blockMap, x, minY, z, height, type, role) {
  for (let y = minY; y < minY + height; y++) {
    setBlock(blockMap, { x, y, z }, type, { phase: 'wall', role })
  }
}

function addStairFlight(plan, blockMap, flight) {
  const allCells = []
  for (const lane of flight.lanes || []) {
    for (let index = 0; index < lane.length; index++) {
      const cell = lane[index]
      allCells.push({ ...cell })
      clearStandCell(blockMap, cell, 'stairs')
      addPathCell(plan, cell, 'stairs', true)
      plan.stairCells.push({ ...cell })
      const support = { x: cell.x, y: cell.y - 1, z: cell.z }
      const isLanding = index === lane.length - 1
      setBlock(blockMap, support, isLanding ? flight.landingMaterial : flight.material, {
        phase: isLanding ? 'path' : 'stairs',
        role: isLanding ? 'stair_landing' : 'stair'
      })
      addSupportColumn(blockMap, plan, support, flight.supportMaterial || flight.landingMaterial || flight.material, 'stair_structural_support')
    }
  }
  plan.stairs.push({
    id: flight.id,
    type: 'stairs',
    lowerCells: (flight.lanes || []).map(lane => lane[0]).filter(Boolean).map(copyPos),
    upperCells: (flight.lanes || []).map(lane => lane[lane.length - 1]).filter(Boolean).map(copyPos),
    cells: allCells,
    width: (flight.lanes || []).length
  })
  plan.functionalTargets.push(target('stairs', 'stairs', allCells))
}

function addLadderAccess(plan, blockMap, access) {
  const cells = []
  for (let y = access.minY; y <= access.maxY; y++) {
    const cell = { x: access.x, y, z: access.z }
    const backing = { x: access.backingX, y, z: access.backingZ }
    setBlock(blockMap, backing, access.backingMaterial || 'oak_planks', {
      phase: 'stairs',
      role: 'ladder_backing'
    })
    setBlock(blockMap, cell, access.material || 'ladder', {
      phase: 'stairs',
      role: 'ladder',
      states: { facing: access.facing || 'west' },
      orientation: { facing: access.facing || 'west' }
    })
    addPathCell(plan, cell, 'stairs', true)
    plan.stairCells.push({ ...cell })
    cells.push({ ...cell })
  }
  plan.stairs.push({
    id: access.id,
    type: 'stairs',
    lowerCells: cells.slice(0, 1).map(copyPos),
    upperCells: cells.slice(-1).map(copyPos),
    cells,
    width: 1
  })
  plan.functionalTargets.push(target('stairs', 'stairs', cells))
}

function clearStandCell(blockMap, cell, role) {
  if (isDoorName(blockMap.get(posKey(cell))?.type)) return
  setBlock(blockMap, cell, 'air', { phase: 'path', role })
  setBlock(blockMap, { x: cell.x, y: cell.y + 1, z: cell.z }, 'air', { phase: 'path', role: `${role}_headroom` })
}

function clearGateArch(blockMap, cells) {
  for (const cell of cells) {
    setBlock(blockMap, { x: cell.x, y: cell.y + 2, z: cell.z }, 'air', {
      phase: 'path',
      role: 'gate_arch_clearance'
    })
  }
}

function addSupportColumn(blockMap, plan, support, material, role) {
  if (!support || support.y <= 0 || !material) return
  const reserved = new Set([
    ...(plan.pathCells || []).map(posKey),
    ...(plan.stairCells || []).map(posKey),
    ...(plan.doorways || []).map(posKey)
  ])
  for (let y = 0; y < support.y; y++) {
    const position = { x: support.x, y, z: support.z }
    if (reserved.has(posKey(position))) continue
    setBlock(blockMap, position, material, { phase: 'support', role })
  }
}

function clearInteriorSlot(blockMap, cell) {
  setBlock(blockMap, cell, 'air', { phase: 'interior_clearance', role: 'interior_niche' })
  setBlock(blockMap, { x: cell.x, y: cell.y + 1, z: cell.z }, 'air', { phase: 'interior_clearance', role: 'interior_headroom' })
}

function reserveInteriorAnchors(blockMap, plan) {
  const blocked = new Set([
    ...(plan.pathCells || []).map(posKey),
    ...(plan.stairCells || []).map(posKey),
    ...(plan.doorways || []).map(posKey)
  ])
  for (const anchorPoint of plan.interiorAnchors || []) {
    if (blocked.has(posKey(anchorPoint))) continue
    clearInteriorSlot(blockMap, anchorPoint)
  }
}

function addPathCell(plan, cell, role, critical) {
  const entry = { ...cell, role, critical: critical === true }
  if (!plan.pathCells.some(existing => posKey(existing) === posKey(entry))) plan.pathCells.push(entry)
}

function validateLayout(plan, blockMap) {
  const failures = []
  if (!plan.rooms.length) failures.push('rooms_missing')
  if (!plan.entrances.length) failures.push('entry_missing')
  for (const room of plan.rooms) {
    if (!room.entrance) failures.push(`room_entry_missing:${room.id}`)
  }
  if (plan.minMainPathWidth < 2) failures.push('main_path_width_below_2')
  for (const cell of plan.pathCells) {
    if (!isPassablePathBlock(blockMap.get(posKey(cell))?.type)) failures.push(`path_not_air:${posKey(cell)}`)
    const head = { x: cell.x, y: cell.y + 1, z: cell.z }
    if (!isPassablePathBlock(blockMap.get(posKey(head))?.type)) failures.push(`path_headroom_blocked:${posKey(head)}`)
  }
  return { ok: failures.length === 0, failures }
}

function summarizeLayout(plan) {
  return {
    enabled: plan.enabled,
    style: plan.style,
    profile: plan.profile,
    minMainPathWidth: plan.minMainPathWidth,
    rooms: plan.rooms.map(room => ({
      id: room.id,
      zone: room.zone,
      bounds: room.bounds,
      entrance: room.entrance || null,
      outdoor: room.outdoor === true,
      required: room.required === false ? false : true
    })),
    entrances: plan.entrances,
    doorways: plan.doorways,
    walkways: plan.walkways,
    pathCells: plan.pathCells,
    stairCells: plan.stairCells,
    stairs: plan.stairs,
    functionalTargets: plan.functionalTargets,
    interiorAnchors: plan.interiorAnchors,
    complete: true
  }
}

function defaultRooms(style) {
  if (style === 'modern') {
    return [
      room('living_room', 'living_room', 1, 1, 1, 2, 1, 2, { x: 2, y: 1, z: 1 }),
      room('kitchen', 'kitchen', 3, 1, 1, 4, 1, 2, { x: 3, y: 1, z: 2 }),
      room('bedroom', 'bedroom', 4, 1, 3, 5, 1, 3, { x: 4, y: 1, z: 3 })
    ]
  }
  if (style === 'castle') {
    return [
      room('hall', 'hall', 2, 1, 1, 4, 1, 2, { x: 3, y: 1, z: 1 }),
      room('room', 'room', 2, 1, 3, 4, 1, 3, { x: 3, y: 1, z: 3 })
    ]
  }
  return [
    room('living_room', 'living_room', 1, 1, 1, 4, 1, 3, { x: 2, y: 1, z: 1 }),
    room('workshop', 'work', 4, 1, 3, 4, 1, 4, { x: 3, y: 1, z: 3 })
  ]
}

function normalizeRooms(rooms = []) {
  if (!Array.isArray(rooms)) return []
  return rooms
    .map((roomEntry, index) => {
      const bounds = normalizeBounds(roomEntry.bounds)
      if (!bounds) return null
      return {
        id: roomEntry.id || `room_${index + 1}`,
        zone: roomEntry.zone || 'room',
        bounds,
        entrance: roomEntry.entrance || centerOf(bounds),
        outdoor: roomEntry.outdoor === true,
        required: roomEntry.required === false ? false : true
      }
    })
    .filter(Boolean)
}

function room(id, zone, minX, minY, minZ, maxX, maxY, maxZ, entrance, options = {}) {
  return {
    id,
    zone,
    bounds: normalizeBounds({ minX, minY, minZ, maxX, maxY, maxZ }),
    entrance,
    outdoor: options.outdoor === true,
    required: options.required === false ? false : true
  }
}

function anchor(role, type, x, y, z, roomId, zone) {
  return { role, type, x, y, z, roomId, zone }
}

function target(role, type, accessCells) {
  return { role, type, accessCells: accessCells.map(copyPos) }
}

function createBlockMap(blocks = []) {
  const map = new Map()
  for (const block of blocks) map.set(posKey(block), { ...block })
  return map
}

function setBlock(blockMap, position, type, extra = {}) {
  blockMap.set(posKey(position), {
    x: position.x,
    y: position.y,
    z: position.z,
    type,
    ...extra
  })
}

function uniquePositions(positions = []) {
  const seen = new Set()
  const unique = []
  for (const position of positions) {
    if (!position) continue
    const key = posKey(position)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ x: position.x, y: position.y, z: position.z })
  }
  return unique
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

function centerOf(bounds) {
  return {
    x: Math.floor((bounds.minX + bounds.maxX) / 2),
    y: bounds.minY,
    z: Math.floor((bounds.minZ + bounds.maxZ) / 2)
  }
}

function normalizeStyle(value) {
  const key = String(value || '').toLowerCase()
  if (key.includes('castle')) return 'castle'
  if (key.includes('modern') || key.includes('villa')) return 'modern'
  return 'wood'
}

function disabledPlan(blueprint) {
  return {
    ok: true,
    blueprint,
    plan: {
      enabled: false,
      rooms: [],
      entrances: [],
      pathCells: [],
      stairs: [],
      functionalTargets: [],
      complete: true
    }
  }
}

function copyPos(position) {
  return { x: position.x, y: position.y, z: position.z }
}

function isAirName(name) {
  return AIR_BLOCKS.has(name)
}

function isPassablePathBlock(name) {
  return isAirName(name) || isDoorName(name) || name === 'ladder' || name === 'vine'
}

function isDoorName(name) {
  const value = String(name || '')
  return /(^|_)door$/.test(value) && !/trapdoor$/.test(value)
}

function posKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function sortBlocks(a, b) {
  return (a.y - b.y) || (a.x - b.x) || (a.z - b.z)
}

module.exports = {
  SpaceLayoutPlanner,
  normalizeRooms
}
