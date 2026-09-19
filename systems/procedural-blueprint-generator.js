const { canonicalBlueprintName } = require('../utils/blueprint-ranking')

const BED_FURNITURE_BLOCK = 'white_wool'

class ProceduralBlueprintGenerator {
  supports(name) {
    return Boolean(GENERATORS[canonicalBlueprintName(name)])
  }

  generate(name, options = {}) {
    const key = canonicalBlueprintName(name)
    const fn = GENERATORS[key]
    if (!fn) return { ok: false, error: `unknown_procedural_blueprint:${name}` }
    const blueprint = fn(options)
    return { ok: true, blueprint }
  }
}

class BlockBuilder {
  constructor(name, description, metadata = {}) {
    this.name = name
    this.description = description
    this.metadata = { skipScaffolding: true, ...metadata }
    this.map = new Map()
  }

  set(x, y, z, type, extra = {}) {
    this.map.set(key(x, y, z), { x, y, z, type, ...extra })
  }

  fill(minX, minY, minZ, maxX, maxY, maxZ, type, extra = {}) {
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) this.set(x, y, z, type, extra)
      }
    }
  }

  blueprint() {
    return {
      name: this.name,
      description: this.description,
      origin: { x: 0, y: 0, z: 0 },
      metadata: this.metadata,
      blocks: [...this.map.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z))
    }
  }
}

function twoStoryWoodHouse() {
  const b = new BlockBuilder('two_story_wood_house', 'Compact two-story survival wood house with basic interior', {
    style: 'survival',
    buildingType: 'two_story_wood_house',
    interiorProfile: 'basic_house',
    rooms: [
      room('ground_main', 'living_room', 1, 1, 1, 2, 1, 3),
      room('upper_sleeping', 'bedroom', 1, 4, 1, 2, 4, 3)
    ],
    walkways: [rect(1, 1, 0, 2, 1, 0)],
    doorways: [pos(1, 1, 0), pos(2, 1, 0), pos(1, 2, 0), pos(2, 2, 0)],
    interiorAnchors: [
      anchor('bed', BED_FURNITURE_BLOCK, 1, 1, 2, 'ground_main', 'bedroom'),
      anchor('crafting_table', 'crafting_table', 2, 1, 3, 'ground_main', 'work'),
      anchor('furnace', 'furnace', 1, 1, 3, 'ground_main', 'work'),
      anchor('chest', 'chest', 2, 1, 1, 'ground_main', 'storage'),
      anchor('table', 'oak_planks', 1, 1, 1, 'ground_main', 'living_room')
    ]
  })
  hollowBox(b, 0, 0, 0, 3, 5, 4, {
    floor: 'oak_planks',
    wall: 'oak_planks',
    roof: 'oak_planks',
    pillar: 'oak_log',
    window: 'glass'
  })
  b.fill(0, 3, 0, 3, 3, 4, 'oak_planks', { phase: 'second_floor' })
  b.set(1, 3, 1, 'air', { role: 'stairwell', phase: 'path' })
  for (const p of b.metadata.doorways) b.set(p.x, p.y, p.z, 'air', { role: 'doorway', phase: 'path' })
  b.set(0, 2, 2, 'glass', { role: 'window', phase: 'window' })
  b.set(3, 2, 2, 'glass', { role: 'window', phase: 'window' })
  return b.blueprint()
}

function simpleTwoStoryCabin() {
  const b = new BlockBuilder('simple_two_story_cabin', 'Simple L3 two-story wood cabin with basic survival interior', {
    style: 'wood',
    buildingType: 'two_story_wood_house',
    complexityTier: 'L3',
    floors: 2,
    interiorProfile: 'simple_two_story_cabin',
    roofType: 'simple_gabled',
    rooms: [
      room('ground_main', 'living_room', 1, 1, 1, 7, 1, 5),
      room('upper_sleeping', 'bedroom', 1, 5, 1, 7, 5, 5)
    ],
    stairs: [rect(2, 1, 4, 5, 4, 4)],
    doorways: [pos(4, 1, 0), pos(4, 2, 0)],
    interiorAnchors: [
      anchor('bed', 'white_bed', 2, 5, 1, 'upper_sleeping', 'bedroom'),
      anchor('chest', 'chest', 6, 1, 1, 'ground_main', 'storage'),
      anchor('crafting_table', 'crafting_table', 6, 1, 2, 'ground_main', 'work'),
      anchor('furnace', 'furnace', 6, 1, 3, 'ground_main', 'work')
    ]
  })

  b.fill(0, 0, 0, 8, 0, 6, 'cobblestone', { phase: 'foundation', role: 'foundation' })
  b.fill(1, 0, 1, 7, 0, 5, 'oak_planks', { phase: 'floor', role: 'floor' })
  simpleCabinWalls(b, 0, 1, 0, 8, 3, 6)
  b.fill(0, 4, 0, 8, 4, 6, 'oak_planks', { phase: 'floor', role: 'second_floor' })
  // Stairwell opening above the stair run (2,1,4)..(5,4,4). A real player is
  // 0.6 wide: every rise transition straddles two columns, so BOTH columns
  // need headroom at the arrival height. Live failure: the old run started at
  // x=1 against the west wall with (1,4,4) solid — climbing S1->S2 bonked the
  // head into the slab and the user could not ascend without breaking blocks.
  b.set(2, 4, 4, 'air', { phase: 'stairs', role: 'stairwell' })
  b.set(3, 4, 4, 'air', { phase: 'stairs', role: 'stairwell' })
  b.set(4, 4, 4, 'air', { phase: 'stairs', role: 'stairwell' })
  simpleCabinWalls(b, 0, 5, 0, 8, 7, 6, { cornerPhase: 'wall' })
  simpleGabledStairRoof(b, 0, 8, -1, 8, 7)

  b.set(4, 1, 0, 'oak_door', { phase: 'doors_windows', role: 'door', states: { half: 'lower', facing: 'south' } })
  b.set(4, 2, 0, 'oak_door', { phase: 'doors_windows', role: 'door', states: { half: 'upper', facing: 'south' } })
  for (const p of [
    pos(2, 2, 0), pos(6, 2, 0), pos(0, 2, 3), pos(8, 2, 3),
    pos(2, 6, 0), pos(6, 6, 0), pos(0, 6, 3), pos(8, 6, 3)
  ]) {
    b.set(p.x, p.y, p.z, 'glass', { phase: 'doors_windows', role: 'window' })
  }
  // Run starts one cell east of the west wall so the first step is mounted
  // head-on from the open walkway at (1,*,4) instead of a sideways squeeze.
  for (const stair of [
    { x: 2, y: 1, z: 4 },
    { x: 3, y: 2, z: 4 },
    { x: 4, y: 3, z: 4 },
    { x: 5, y: 4, z: 4 }
  ]) {
    b.set(stair.x, stair.y, stair.z, 'oak_stairs', {
      phase: 'stairs',
      role: 'simple_stair',
      states: { facing: 'east', half: 'bottom', shape: 'straight' }
    })
  }
  // Bed sits against the north wall so both halves rest on second-floor
  // planks; the old anchor (2,5,4) hung over the stairwell opening (2,4,4).
  placeBedPair(b, 2, 5, 1, 'south')
  b.set(6, 1, 1, 'chest', { phase: 'functional_blocks', role: 'chest' })
  b.set(6, 1, 2, 'crafting_table', { phase: 'functional_blocks', role: 'crafting_table' })
  b.set(6, 1, 3, 'furnace', { phase: 'functional_blocks', role: 'furnace' })
  // One floor torch per corner per story, directly on floor/second-floor planks.
  placeFloorTorch(b, 1, 1, 1)
  placeFloorTorch(b, 7, 1, 5)
  placeFloorTorch(b, 1, 5, 1)
  placeFloorTorch(b, 7, 5, 5)
  return b.blueprint()
}

function simpleWoodCabin() {
  const b = new BlockBuilder('simple_wood_cabin', 'Simple L2 single-story wood cabin with basic utilities', {
    style: 'wood',
    buildingType: 'simple_wood_cabin',
    complexityTier: 'L2',
    floors: 1,
    interiorProfile: 'simple_wood_cabin',
    roofType: 'simple_gabled',
    rooms: [room('main', 'living_room', 1, 1, 1, 5, 1, 3)],
    doorways: [pos(3, 1, 0), pos(3, 2, 0)],
    interiorAnchors: [
      anchor('bed', 'white_bed', 1, 1, 2, 'main', 'bedroom'),
      anchor('chest', 'chest', 5, 1, 1, 'main', 'storage'),
      anchor('crafting_table', 'crafting_table', 5, 1, 2, 'main', 'work'),
      anchor('furnace', 'furnace', 5, 1, 3, 'main', 'work')
    ]
  })
  b.fill(0, 0, 0, 6, 0, 4, 'cobblestone', { phase: 'foundation', role: 'foundation' })
  b.fill(1, 0, 1, 5, 0, 3, 'oak_planks', { phase: 'floor', role: 'floor' })
  simpleCabinWalls(b, 0, 1, 0, 6, 3, 4)
  simpleGabledPlankRoof(b, 0, 4, -1, 6, 5)
  b.set(3, 1, 0, 'oak_door', { phase: 'doors_windows', role: 'door', states: { half: 'lower', facing: 'south' } })
  b.set(3, 2, 0, 'oak_door', { phase: 'doors_windows', role: 'door', states: { half: 'upper', facing: 'south' } })
  for (const p of [pos(1, 2, 0), pos(5, 2, 0), pos(0, 2, 2), pos(6, 2, 2)]) {
    b.set(p.x, p.y, p.z, 'glass', { phase: 'doors_windows', role: 'window' })
  }
  placeBedPair(b, 1, 1, 2, 'south')
  b.set(5, 1, 1, 'chest', { phase: 'functional_blocks', role: 'chest' })
  b.set(5, 1, 2, 'crafting_table', { phase: 'functional_blocks', role: 'crafting_table' })
  b.set(5, 1, 3, 'furnace', { phase: 'functional_blocks', role: 'furnace' })
  // Floor corner and furnace top provide the solid support faces.
  placeFloorTorch(b, 1, 1, 1)
  placeFloorTorch(b, 5, 2, 3)
  return b.blueprint()
}

function starterShelter() {
  const b = new BlockBuilder('starter_shelter', 'Small starter shelter with essential utility blocks', {
    style: 'starter',
    buildingType: 'starter_shelter',
    interiorProfile: 'basic_house',
    rooms: [room('main', 'shelter', 1, 1, 1, 2, 1, 2)],
    walkways: [rect(1, 1, 0, 2, 1, 0)],
    doorways: [pos(1, 1, 0), pos(1, 2, 0)],
    interiorAnchors: [
      anchor('bed', BED_FURNITURE_BLOCK, 1, 1, 2, 'main', 'sleeping'),
      anchor('crafting_table', 'crafting_table', 2, 1, 2, 'main', 'work'),
      anchor('furnace', 'furnace', 2, 1, 1, 'main', 'work'),
      anchor('chest', 'chest', 1, 1, 1, 'main', 'storage')
    ]
  })
  hollowBox(b, 0, 0, 0, 3, 3, 3, {
    floor: 'oak_planks',
    wall: 'oak_planks',
    roof: 'oak_planks',
    pillar: 'oak_log',
    window: 'glass'
  })
  for (const p of b.metadata.doorways) b.set(p.x, p.y, p.z, 'air', { role: 'doorway', phase: 'path' })
  return b.blueprint()
}

function simpleFarmhouse() {
  const b = new BlockBuilder('simple_farmhouse', 'Simple farmhouse with fenced garden plot and basic interior', {
    style: 'farmhouse',
    buildingType: 'simple_farmhouse',
    interiorProfile: 'basic_house',
    rooms: [room('main', 'farmhouse', 1, 1, 1, 3, 1, 2)],
    walkways: [rect(2, 1, 0, 2, 1, 1)],
    doorways: [pos(1, 1, 0), pos(1, 2, 0)],
    interiorAnchors: [
      anchor('bed', BED_FURNITURE_BLOCK, 1, 1, 2, 'main', 'sleeping'),
      anchor('crafting_table', 'crafting_table', 3, 1, 2, 'main', 'work'),
      anchor('furnace', 'furnace', 3, 1, 1, 'main', 'kitchen'),
      anchor('chest', 'chest', 1, 1, 1, 'main', 'storage')
    ]
  })
  hollowBox(b, 0, 0, 0, 4, 3, 3, {
    floor: 'oak_planks',
    wall: 'oak_planks',
    roof: 'oak_planks',
    pillar: 'oak_log',
    window: 'glass'
  })
  for (const p of b.metadata.doorways) b.set(p.x, p.y, p.z, 'air', { role: 'doorway', phase: 'path' })
  fenceRect(b, -1, 0, 4, 5, 0, 6, 'oak_fence', { phase: 'garden' })
  b.fill(0, 0, 5, 4, 0, 5, 'dirt', { phase: 'garden' })
  b.set(0, 1, 5, 'green_wool', { phase: 'garden' })
  b.set(4, 1, 5, 'green_wool', { phase: 'garden' })
  return b.blueprint()
}

function modernVilla() {
  const b = new BlockBuilder('modern_villa', 'Compact modern villa with bedroom, kitchen, and living room zones', {
    style: 'modern',
    buildingType: 'modern_villa',
    interiorProfile: 'modern_villa',
    rooms: [
      room('living_room', 'living_room', 1, 1, 1, 2, 1, 2),
      room('kitchen', 'kitchen', 3, 1, 1, 3, 1, 2),
      room('bedroom', 'bedroom', 1, 1, 3, 3, 1, 3)
    ],
    walkways: [rect(2, 1, 0, 2, 1, 1)],
    doorways: [pos(2, 1, 0), pos(2, 2, 0)],
    interiorAnchors: [
      anchor('bed', BED_FURNITURE_BLOCK, 1, 1, 3, 'bedroom', 'bedroom'),
      anchor('crafting_table', 'crafting_table', 3, 1, 3, 'bedroom', 'utility'),
      anchor('furnace', 'furnace', 3, 1, 1, 'kitchen', 'kitchen'),
      anchor('chest', 'chest', 3, 1, 2, 'kitchen', 'kitchen'),
      anchor('sofa', 'oak_planks', 1, 1, 1, 'living_room', 'living_room'),
      anchor('table', 'glass', 1, 1, 2, 'living_room', 'living_room')
    ]
  })
  hollowBox(b, 0, 0, 0, 4, 3, 4, {
    floor: 'oak_planks',
    wall: 'white_concrete',
    roof: 'white_concrete',
    pillar: 'white_concrete',
    window: 'glass'
  })
  b.fill(2, 1, 2, 2, 2, 4, 'white_concrete', { role: 'partition', phase: 'wall' })
  b.set(2, 1, 2, 'air', { role: 'room_passage', phase: 'path' })
  b.set(2, 2, 2, 'air', { role: 'room_passage', phase: 'path' })
  for (const p of b.metadata.doorways) b.set(p.x, p.y, p.z, 'air', { role: 'doorway', phase: 'path' })
  b.set(0, 2, 2, 'glass', { role: 'window', phase: 'window' })
  b.set(4, 2, 2, 'glass', { role: 'window', phase: 'window' })
  return b.blueprint()
}

function castleGarden() {
  const b = new BlockBuilder('castle_garden', 'Mini stone castle with hall, room partition, and garden frontage', {
    style: 'castle',
    buildingType: 'castle_garden',
    interiorProfile: 'castle',
    rooms: [
      room('hall', 'hall', 1, 1, 1, 2, 1, 1),
      room('room', 'room', 1, 1, 2, 2, 1, 2)
    ],
    walkways: [rect(1, 1, 0, 2, 1, 0)],
    doorways: [pos(1, 1, 0), pos(2, 1, 0), pos(1, 2, 0), pos(2, 2, 0)],
    interiorAnchors: [
      anchor('bed', BED_FURNITURE_BLOCK, 1, 1, 2, 'room', 'room'),
      anchor('crafting_table', 'crafting_table', 2, 1, 2, 'room', 'work'),
      anchor('furnace', 'furnace', 1, 1, 1, 'hall', 'hall'),
      anchor('chest', 'chest', 2, 1, 1, 'hall', 'storage')
    ]
  })
  hollowBox(b, 0, 0, 0, 3, 3, 3, {
    floor: 'cobblestone',
    wall: 'stone_bricks',
    roof: 'stone_bricks',
    pillar: 'stone_bricks',
    window: 'glass'
  })
  b.fill(0, 4, 0, 3, 4, 3, 'stone_bricks', { phase: 'battlement' })
  b.set(1, 4, 1, 'air', { phase: 'roof_walkway' })
  b.set(2, 4, 1, 'air', { phase: 'roof_walkway' })
  b.fill(0, 0, 0, 0, 5, 0, 'stone_bricks', { phase: 'tower' })
  b.fill(3, 0, 0, 3, 5, 0, 'stone_bricks', { phase: 'tower' })
  b.fill(0, 0, 3, 0, 5, 3, 'stone_bricks', { phase: 'tower' })
  b.fill(3, 0, 3, 3, 5, 3, 'stone_bricks', { phase: 'tower' })
  for (const p of b.metadata.doorways) b.set(p.x, p.y, p.z, 'air', { role: 'gate', phase: 'path' })
  fenceRect(b, -1, 0, 4, 4, 0, 6, 'oak_fence', { phase: 'garden' })
  b.fill(0, 0, 5, 3, 0, 5, 'dirt', { phase: 'garden' })
  b.set(0, 1, 5, 'green_wool', { phase: 'garden' })
  b.set(3, 1, 5, 'green_wool', { phase: 'garden' })
  return b.blueprint()
}

function gardenManor() {
  const b = simpleFarmhouse()
  b.name = 'garden_manor'
  b.description = 'Garden manor with basic interior and garden structure'
  b.metadata = {
    ...b.metadata,
    style: 'manor',
    buildingType: 'garden_manor'
  }
  return b
}

function statue() {
  const b = new BlockBuilder('statue', 'Compact decorative statue', {
    style: 'art',
    buildingType: 'statue',
    interiorProfile: 'decorative',
    precisionMarkers: [pos(0, 0, 0), pos(0, 5, 0)]
  })
  b.fill(-1, 0, -1, 1, 0, 1, 'stone_bricks', { phase: 'base' })
  b.set(0, 1, 0, 'white_wool', { phase: 'body' })
  b.set(0, 2, 0, 'white_wool', { phase: 'body' })
  b.set(0, 3, 0, 'white_wool', { phase: 'body' })
  b.set(0, 4, 0, 'white_wool', { phase: 'head' })
  b.set(-1, 3, 0, 'white_wool', { phase: 'arm' })
  b.set(1, 3, 0, 'white_wool', { phase: 'arm' })
  b.set(0, 2, -1, 'white_wool', { phase: 'detail' })
  return b.blueprint()
}

function fountain() {
  const b = new BlockBuilder('fountain', 'Compact decorative fountain using solid blue blocks for safe water representation', {
    style: 'art',
    buildingType: 'fountain',
    interiorProfile: 'decorative',
    precisionMarkers: [pos(0, 0, 0), pos(2, 2, 2)]
  })
  fenceRect(b, 0, 0, 0, 4, 0, 4, 'stone_bricks', { phase: 'basin' })
  b.fill(1, 0, 1, 3, 0, 3, 'blue_wool', { phase: 'basin_water' })
  b.set(2, 1, 2, 'cobblestone', { phase: 'pillar' })
  b.set(2, 2, 2, 'blue_wool', { phase: 'water_feature' })
  b.set(1, 1, 2, 'blue_wool', { phase: 'water_feature' })
  b.set(3, 1, 2, 'blue_wool', { phase: 'water_feature' })
  b.set(2, 1, 1, 'blue_wool', { phase: 'water_feature' })
  b.set(2, 1, 3, 'blue_wool', { phase: 'water_feature' })
  return b.blueprint()
}

// Vanilla bed convention: facing points foot -> head, so head = foot + facing.
// One white_bed item places both halves; material accounting treats the head
// half as part-exempt (see utils/building-material-map.js isBedHeadBlockState).
const BED_HEAD_OFFSETS = Object.freeze({
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 },
  east: { x: 1, z: 0 }
})

function placeBedPair(b, x, y, z, facing, extra = {}) {
  const offset = BED_HEAD_OFFSETS[facing]
  if (!offset) throw new Error(`invalid_bed_facing:${facing}`)
  b.set(x, y, z, 'white_bed', { phase: 'functional_blocks', role: 'bed', ...extra, states: { facing, part: 'foot' } })
  b.set(x + offset.x, y, z + offset.z, 'white_bed', { phase: 'functional_blocks', role: 'bed', ...extra, states: { facing, part: 'head' } })
}

// Blocks a standing torch cannot rest on: a floating torch can only exist
// in-game as wall_torch (or fail to place) and strict-diffs as wrong.
const TORCH_NON_SUPPORT_TYPES = new Set([
  'air', 'torch', 'chest', 'oak_door', 'white_bed', 'oak_stairs', 'glass', 'oak_fence'
])

function placeFloorTorch(b, x, y, z, extra = {}) {
  const below = b.map.get(key(x, y - 1, z))
  if (!below || TORCH_NON_SUPPORT_TYPES.has(below.type)) {
    throw new Error(`floating_torch_needs_solid_support:${x},${y},${z}:below=${below ? below.type : 'unset'}`)
  }
  b.set(x, y, z, 'torch', { phase: 'functional_blocks', role: 'torch', ...extra })
}

function hollowBox(b, minX, minY, minZ, maxX, maxY, maxZ, materials) {
  b.fill(minX, minY, minZ, maxX, minY, maxZ, materials.floor, { phase: 'floor' })
  for (let y = minY + 1; y < maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const perimeter = x === minX || x === maxX || z === minZ || z === maxZ
        if (!perimeter) continue
        const corner = (x === minX || x === maxX) && (z === minZ || z === maxZ)
        b.set(x, y, z, corner ? materials.pillar : materials.wall, { phase: 'wall' })
      }
    }
  }
  b.fill(minX, maxY, minZ, maxX, maxY, maxZ, materials.roof, { phase: 'roof' })
  const midZ = Math.floor((minZ + maxZ) / 2)
  b.set(minX, minY + 2, midZ, materials.window, { role: 'window', phase: 'window' })
  b.set(maxX, minY + 2, midZ, materials.window, { role: 'window', phase: 'window' })
}

// Corner posts default to the 'frame' phase. Upper stories MUST override
// cornerPhase to 'wall': the runtime executes canonical phases with a hard
// barrier (frame -> floor -> wall -> ...), so a story-2 corner tagged 'frame'
// is scheduled before the second-floor slab exists and can only be reached by
// a fragile 7-high temporary column (live failure in run
// construction_run_37f0041d208e745e: place_failed:unstable:dirt at rel 0,7,0).
function simpleCabinWalls(b, minX, minY, minZ, maxX, maxY, maxZ, options = {}) {
  const cornerPhase = options.cornerPhase || 'frame'
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const perimeter = x === minX || x === maxX || z === minZ || z === maxZ
        if (!perimeter) continue
        const corner = (x === minX || x === maxX) && (z === minZ || z === maxZ)
        b.set(x, y, z, corner ? 'oak_log' : 'oak_planks', {
          phase: corner ? cornerPhase : 'wall',
          role: corner ? 'corner_post' : 'wall'
        })
      }
    }
  }
}

// Real gabled roof out of stair blocks: two slopes of oak_stairs rising from
// the front/back eaves to an oak_log ridge beam, with plank-filled gable-end
// triangles. Replaces the stepped plank mesa the user rejected as ugly.
// Span minZ..maxZ must be odd-width so the ridge is a single centre row.
function simpleGabledStairRoof(b, minX, baseY, minZ, maxX, maxZ) {
  const ridgeZ = (minZ + maxZ) / 2
  // attic floor / ceiling over the interior (walls sit at minZ+1 and maxZ-1)
  b.fill(minX, baseY, minZ + 1, maxX, baseY, maxZ - 1, 'oak_planks', { phase: 'roof', role: 'roof_ceiling' })
  for (let k = 0; minZ + k < ridgeZ; k++) {
    const y = baseY + k
    for (let x = minX; x <= maxX; x++) {
      b.set(x, y, minZ + k, 'oak_stairs', {
        phase: 'roof',
        role: 'roof_slope',
        states: { facing: 'south', half: 'bottom', shape: 'straight' }
      })
      b.set(x, y, maxZ - k, 'oak_stairs', {
        phase: 'roof',
        role: 'roof_slope',
        states: { facing: 'north', half: 'bottom', shape: 'straight' }
      })
    }
  }
  const ridgeY = baseY + (ridgeZ - minZ)
  for (let x = minX; x <= maxX; x++) {
    b.set(x, ridgeY, ridgeZ, 'oak_log', { phase: 'roof', role: 'roof_ridge', states: { axis: 'x' } })
  }
  // gable-end triangles under the slopes
  for (let k = 1; minZ + k < ridgeZ; k++) {
    const y = baseY + k
    for (let z = minZ + k + 1; z <= maxZ - k - 1; z++) {
      b.set(minX, y, z, 'oak_planks', { phase: 'roof', role: 'gable_end' })
      b.set(maxX, y, z, 'oak_planks', { phase: 'roof', role: 'gable_end' })
    }
  }
}

function simpleGabledPlankRoof(b, minX, baseY, minZ, maxX, maxZ) {
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      b.set(x, baseY, z, 'oak_planks', { phase: 'roof', role: 'simple_roof_eave' })
    }
  }
  for (let x = minX + 1; x <= maxX - 1; x++) {
    for (let z = minZ + 1; z <= maxZ - 1; z++) {
      b.set(x, baseY + 1, z, 'oak_planks', { phase: 'roof', role: 'simple_roof_slope' })
    }
  }
  const midZ = Math.floor((minZ + maxZ) / 2)
  for (let x = minX; x <= maxX; x++) {
    b.set(x, baseY + 2, midZ, 'oak_log', { phase: 'roof', role: 'simple_roof_ridge' })
  }
}

function fenceRect(b, minX, minY, minZ, maxX, maxY, maxZ, type, extra = {}) {
  for (let x = minX; x <= maxX; x++) {
    b.set(x, maxY, minZ, type, extra)
    b.set(x, maxY, maxZ, type, extra)
  }
  for (let z = minZ; z <= maxZ; z++) {
    b.set(minX, maxY, z, type, extra)
    b.set(maxX, maxY, z, type, extra)
  }
}

function room(id, zone, minX, minY, minZ, maxX, maxY, maxZ) {
  return { id, zone, bounds: { minX, minY, minZ, maxX, maxY, maxZ } }
}

function anchor(role, type, x, y, z, roomId, zone) {
  return { role, type, x, y, z, roomId, zone }
}

function rect(minX, minY, minZ, maxX, maxY, maxZ) {
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

function pos(x, y, z) {
  return { x, y, z }
}

function key(x, y, z) {
  return `${x},${y},${z}`
}

const GENERATORS = Object.freeze({
  two_story_wood_house: twoStoryWoodHouse,
  simple_two_story_cabin: simpleTwoStoryCabin,
  simple_wood_cabin: simpleWoodCabin,
  starter_shelter: starterShelter,
  simple_farmhouse: simpleFarmhouse,
  modern_villa: modernVilla,
  castle_garden: castleGarden,
  garden_manor: gardenManor,
  statue,
  fountain
})

module.exports = {
  ProceduralBlueprintGenerator,
  GENERATED_BLUEPRINT_NAMES: Object.keys(GENERATORS)
}
