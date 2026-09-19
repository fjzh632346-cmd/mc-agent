const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { BlueprintLoader } = require('../systems/blueprint-loader')
const { BlueprintSelector } = require('../systems/blueprint-selector')
const { CommunityBlueprintIndex } = require('../systems/community-blueprint-index')
const { AestheticModel } = require('../systems/aesthetic-model')
const { AestheticRefiner } = require('../systems/aesthetic-refiner')
const {
  adaptBuildIntentToDesignSpec,
  blueprintSatisfiesDesignSpec,
  createConstructionEstimate,
  estimateBlueprintComplexity,
  shouldPreserveNamedBlueprintScale
} = require('../systems/building-complexity')
const { BuildingDesigner, analyzeBlueprint, validateFacade, validateStyleGrammar } = require('../systems/building-designer')
const { BuildingHardGate } = require('../systems/building-hard-gate')
const { BuildingSystem, _test: buildingSystemTest } = require('../systems/building-system')
const { REQUIRED_DESIGN_SPEC_FIELDS } = require('../systems/building-design-spec')
const { CommunityBuildCollector } = require('../systems/community-build-collector')
const { EquipmentSystem } = require('../systems/EquipmentSystem')
const { InteriorPlanner } = require('../systems/interior-planner')
const { InteriorUsabilityValidator } = require('../systems/interior-usability-validator')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')
const { SpaceLayoutPlanner } = require('../systems/space-layout-planner')
const { StructureEncoder } = require('../systems/structure-encoder')
const { WalkabilityChecker } = require('../systems/walkability-checker')
const { BuildTask } = require('../tasks/build-task')
const { TaskManager } = require('../tasks/task-manager')
const { WorldMemory } = require('../memory/world-memory')
const { parseIntent } = require('../ai/intent-parser')
const { intentToTask } = require('../ai/intent-to-task')
const { ACTION_KEYS } = require('../ai/action-keys')
const { PlanningSystem } = require('../ai/planning-system')
const { materializeBlueprintBlocks } = require('../systems/construction-compiler')
const { resolveMaterialSteps } = require('../systems/material-resolution')
const { createSitePlan, planBuildOrder, planMaterials, validateBuild } = require('../utils/site-planner')
const { clearBlockForBuilding } = require('../actions/build')
const { rankBlueprintCandidate } = require('../utils/blueprint-ranking')

function createSyntheticCollector(options = {}) {
  return new CommunityBuildCollector({
    allowSyntheticSamples: true,
    requireRealCommunity: false,
    ...options
  })
}

function createSyntheticBuildingSystem(options = {}) {
  return new BuildingSystem({
    communityCollector: createSyntheticCollector(),
    constructionRunStore: false,
    ...options
  })
}

function createSyntheticBuildTask(id, params) {
  return new BuildTask({
    id,
    params: {
      ...params,
      buildingSystem: createSyntheticBuildingSystem(params.buildingOptions || params.options || {})
    }
  })
}

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function createContext(items = [], options = {}) {
  const placed = []
  const cleared = []
  const equippedItems = []
  const occupied = new Map()
  const airBlocks = new Set(options.airBlocks || [])
  for (const entry of options.occupied || []) {
    if (typeof entry === 'string') occupied.set(entry, 'stone')
    else occupied.set(`${entry.x},${entry.y},${entry.z}`, entry.name || entry.type || 'stone')
  }

  const registryBlocks = {
    grass_block: { id: 1, name: 'grass_block' },
    oak_planks: { id: 2, name: 'oak_planks' },
    dirt: { id: 3, name: 'dirt' },
    stone: { id: 4, name: 'stone' },
    chest: { id: 5, name: 'chest' },
    oak_log: { id: 6, name: 'oak_log' },
    cobblestone: { id: 7, name: 'cobblestone' },
    oak_stairs: { id: 8, name: 'oak_stairs' },
    ladder: { id: 9, name: 'ladder' }
  }

  const bot = {
    entity: { position: vec(0, 64, 0) },
    heldItem: null,
    registry: {
      blocksByName: registryBlocks,
      itemsByName: {
        oak_planks: { id: 20, name: 'oak_planks' },
        dirt: { id: 21, name: 'dirt' },
        cobblestone: { id: 22, name: 'cobblestone' },
        stone_pickaxe: { id: 23, name: 'stone_pickaxe' },
        iron_axe: { id: 24, name: 'iron_axe' },
        iron_shovel: { id: 25, name: 'iron_shovel' },
        oak_stairs: { id: 26, name: 'oak_stairs' },
        oak_door: { id: 27, name: 'oak_door' },
        spruce_door: { id: 28, name: 'spruce_door' },
        ladder: { id: 29, name: 'ladder' }
      },
      itemsArray: []
    },
    inventory: {
      items: () => items,
      slots: Array.from({ length: 45 }, () => null)
    },
    pathfinder: {
      setMovements() {},
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = vec(goal.x, goal.y, goal.z)
        }
      },
      stop() {}
    },
    blockAt(position) {
      const key = `${position.x},${position.y},${position.z}`
      if (occupied.has(key)) return { name: occupied.get(key), position }
      if (airBlocks.has(key)) return { name: 'air', position }
      if (position.y === 63) return { name: 'grass_block', position }
      return { name: 'air', position }
    },
    async equip(item) {
      this.equipped = item
      this.heldItem = item
      equippedItems.push(item.name)
    },
    async placeBlock(reference, faceVector) {
      const position = {
        x: reference.position.x + faceVector.x,
        y: reference.position.y + faceVector.y,
        z: reference.position.z + faceVector.z
      }
      const blockName = this.heldItem?.name || options.defaultPlacedBlock || 'oak_planks'
      occupied.set(`${position.x},${position.y},${position.z}`, blockName)
      placed.push({
        reference,
        faceVector,
        position,
        blockName
      })
    },
    canDigBlock() {
      return options.canDigBlock !== false
    },
    async dig(block) {
      occupied.delete(`${block.position.x},${block.position.y},${block.position.z}`)
      cleared.push({ name: block.name, position: block.position })
    }
  }

  const memoryPath = path.join(os.tmpdir(), `mc-world-memory-${Date.now()}-${Math.random()}.json`)
  return {
    bot,
    placed,
    cleared,
    equippedItems,
    occupied,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard: new Blackboard({
      bot: { position: { x: 0, y: 64, z: 0 } },
      inventory: { counts: Object.fromEntries(items.map(item => [item.name, item.count])) },
      mobs: { dangerLevel: options.dangerLevel || 'none' }
    }),
    memory: {
      world: options.worldMemory || new WorldMemory(memoryPath, { autosave: true })
    },
    equipmentSystem: options.equipmentSystem || null,
    storageSystem: options.storageSystem || null,
    logger: { log() {} },
    debug() {}
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function nextTick() {
  return new Promise(resolve => setImmediate(resolve))
}

async function runTaskUpdate(task, ctx) {
  await task.start(ctx)
  await task.update(ctx)
}

function createBlueprintDir(blueprints) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-blueprints-'))
  for (const blueprint of blueprints) {
    fs.writeFileSync(path.join(dir, `${blueprint.name}.json`), JSON.stringify(blueprint), 'utf8')
  }
  return dir
}

function createCommunityCache(samples) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-community-cache-'))
  const blueprintDir = path.join(root, 'blueprints')
  fs.mkdirSync(blueprintDir, { recursive: true })
  const index = {
    version: 1,
    samples: samples.map(sample => {
      const fileName = `${sample.id}.json`
      const localBlueprintPath = path.join(blueprintDir, fileName)
      fs.writeFileSync(localBlueprintPath, JSON.stringify(sample.blueprint), 'utf8')
      return {
        id: sample.id,
        importStatus: 'verified',
        sourceMode: 'faithful-community-import',
        buildTitle: sample.title || sample.id,
        category: sample.category || sample.buildingType,
        style: sample.style,
        buildingType: sample.buildingType,
        requiredStories: sample.requiredStories,
        localBlueprintPath,
        localRawPath: path.join(root, 'raw', `${sample.id}.schem`),
        structureFileFormat: 'schem',
        cacheHash: sample.id,
        hardGate: { ok: true },
        encodingSummary: { blockCount: sample.blueprint.blocks.length }
      }
    })
  }
  const indexPath = path.join(root, 'index.json')
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8')
  return { root, indexPath }
}

function communityVillaBlueprint(overrides = {}) {
  const width = overrides.width || 18
  const depth = overrides.depth || 14
  const roofY = overrides.roofY ?? 9
  const secondFloorY = overrides.secondFloorY ?? 4
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ x, y: 0, z, type: 'oak_planks' })
      blocks.push({ x, y: secondFloorY, z, type: 'oak_planks' })
      blocks.push({ x, y: roofY, z, type: 'white_concrete' })
    }
  }
  for (const y of [1, 2, 3, 5, 6, 7, 8]) {
    for (let x = 0; x < width; x++) {
      for (const z of [0, depth - 1]) {
        if (z === 0 && x === Math.floor(width / 2) && (y === 1 || y === 2)) continue
        blocks.push({ x, y, z, type: y === 2 && x % 4 < 2 ? 'glass_pane' : 'white_concrete' })
      }
    }
    for (let z = 1; z < depth - 1; z++) {
      for (const x of [0, width - 1]) {
        blocks.push({ x, y, z, type: y === 2 && z % 4 < 2 ? 'glass_pane' : 'white_concrete' })
      }
    }
  }
  blocks.push({ x: Math.floor(width / 2), y: 1, z: 0, type: 'oak_door', states: { half: 'lower', facing: 'south' } })
  blocks.push({ x: Math.floor(width / 2), y: 2, z: 0, type: 'oak_door', states: { half: 'upper', facing: 'south' } })
  for (let i = 0; i < 4; i++) {
    blocks.push({ x: 2 + i, y: 1 + i, z: 2, type: 'oak_stairs', states: { facing: 'east' } })
  }
  blocks.push({ x: 3, y: 1, z: 3, type: 'chest' })

  const uniqueBlocks = [...new Map(blocks.map(block => [`${block.x},${block.y},${block.z}`, block])).values()]
  return {
    name: overrides.name || 'faithful_modern_villa_fixture',
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      buildingType: 'modern_villa',
      style: 'modern'
    },
    blocks: uniqueBlocks
  }
}

function faithfulTwoStoryWoodHousePreviewBlueprint(overrides = {}) {
  const width = overrides.width || 14
  const depth = overrides.depth || 12
  const secondFloorY = overrides.secondFloorY ?? 4
  const roofY = overrides.roofY ?? 8
  const blocks = []
  const put = (x, y, z, type, extra = {}) => blocks.push({ x, y, z, type, ...extra })

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      put(x, 0, z, 'spruce_planks')
      put(x, secondFloorY, z, 'spruce_planks')
      put(x, roofY, z, 'spruce_planks')
    }
  }
  for (const y of [1, 2, 3, 5, 6, 7]) {
    for (let x = 0; x < width; x++) {
      for (const z of [0, depth - 1]) {
        if (z === 0 && x === Math.floor(width / 2) && (y === 1 || y === 2)) continue
        put(x, y, z, 'spruce_planks')
      }
    }
    for (let z = 1; z < depth - 1; z++) {
      for (const x of [0, width - 1]) put(x, y, z, 'spruce_planks')
    }
  }
  put(Math.floor(width / 2), 1, 0, 'spruce_door', { states: { half: 'lower', facing: 'south' } })
  put(Math.floor(width / 2), 2, 0, 'spruce_door', { states: { half: 'upper', facing: 'south' } })
  for (let i = 0; i < 4; i++) put(2 + i, 1 + i, 2, 'oak_stairs', { states: { facing: 'east' } })
  put(3, 1, 3, 'chest')
  put(4, 1, 3, 'crafting_table')
  put(5, 1, 3, 'furnace')

  const uniqueBlocks = [...new Map(blocks.map(block => [`${block.x},${block.y},${block.z}`, block])).values()]
  return {
    name: overrides.name || 'faithful_two_story_wood_house_preview',
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      buildingType: 'two_story_wood_house',
      style: 'wood'
    },
    blocks: uniqueBlocks
  }
}

function complexTwoStoryWoodHouseBlueprint(overrides = {}) {
  const width = overrides.width || 14
  const depth = overrides.depth || 12
  const blocks = []
  const put = (x, y, z, type, extra = {}) => blocks.push({ x, y, z, type, ...extra })
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      put(x, 0, z, 'spruce_planks')
      put(x, 5, z, 'spruce_planks')
      put(x, 10, z, 'dark_oak_stairs', { states: { facing: x < width / 2 ? 'east' : 'west', shape: x % 3 === 0 ? 'inner_left' : 'straight' } })
    }
  }
  for (const y of [1, 2, 3, 6, 7, 8]) {
    for (let x = 0; x < width; x++) {
      for (const z of [0, depth - 1]) put(x, y, z, x % 4 === 0 ? 'glass' : 'spruce_planks')
    }
    for (let z = 1; z < depth - 1; z++) {
      for (const x of [0, width - 1]) put(x, y, z, z % 4 === 0 ? 'glass' : 'spruce_planks')
    }
  }
  for (let x = 0; x < width; x += 3) {
    put(x, 4, 0, 'lantern', { states: { hanging: 'true' } })
    put(x, 9, depth - 1, 'lantern', { states: { hanging: 'true' } })
  }
  for (let i = 0; i < 30; i++) put(i % width, 4 + (i % 2), 1 + (i % (depth - 2)), 'spruce_trapdoor')
  for (let i = 0; i < 6; i++) put(1 + i, 1, depth - 2, 'flower_pot')
  put(2, 1, 2, 'cake')
  put(3, 1, 2, 'ender_chest')
  put(4, 1, 2, 'brewing_stand')
  put(5, 1, 2, 'creeper_wall_head')
  put(6, 1, 2, 'zombie_wall_head')
  put(Math.floor(width / 2), 1, 0, 'spruce_door', { states: { half: 'lower', facing: 'south' } })
  put(Math.floor(width / 2), 2, 0, 'spruce_door', { states: { half: 'upper', facing: 'south' } })
  put(3, 1, 3, 'chest')
  put(4, 1, 3, 'crafting_table')
  put(5, 1, 3, 'furnace')

  const uniqueBlocks = [...new Map(blocks.map(block => [`${block.x},${block.y},${block.z}`, block])).values()]
  return {
    name: overrides.name || 'p9r_like_two_story_wood_house',
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      buildingType: 'two_story_wood_house',
      style: 'wood'
    },
    blocks: uniqueBlocks
  }
}

function richBuildItems(count = 240) {
  return [
    'oak_planks',
    'oak_log',
    'spruce_planks',
    'spruce_log',
    'dark_oak_stairs',
    'spruce_trapdoor',
    'dirt',
    'glass',
    'white_concrete',
    'gray_concrete',
    'stone_bricks',
    'cobblestone',
    'oak_fence',
    'green_wool',
    'blue_wool',
    'white_wool',
    'white_bed',
    'crafting_table',
    'furnace',
      'chest',
      'oak_stairs',
      'torch',
      'lantern',
      'flower_pot',
      'cake',
      'ender_chest',
      'brewing_stand',
      'creeper_head',
      'zombie_head',
      'ladder',
      'oak_door',
      'spruce_door'
  ].map(name => ({ name, count }))
}

async function testLoadBlueprint() {
  const loader = new BlueprintLoader()
  const loaded = loader.loadBlueprint('small_house')
  assert.strictEqual(loaded.ok, true)
  assert.strictEqual(loaded.blueprint.name, 'small_house')
}

async function testInvalidBlueprintDoesNotCrash() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-blueprints-'))
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ name: 'bad', blocks: [{ x: 0, y: 0 }] }), 'utf8')
  const loader = new BlueprintLoader({ blueprintDir: dir })
  const loaded = loader.loadBlueprint('bad')
  assert.strictEqual(loaded.ok, false)
  assert.ok(loaded.error.startsWith('invalid_blueprint'))
}

async function testMissingBlueprintAndBadJson() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-blueprints-'))
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8')
  const loader = new BlueprintLoader({ blueprintDir: dir })

  const missing = loader.loadBlueprint('missing')
  assert.strictEqual(missing.ok, false)
  assert.strictEqual(missing.error, 'blueprint_not_found:missing')

  const broken = loader.loadBlueprint('broken')
  assert.strictEqual(broken.ok, false)
  assert.ok(broken.error.startsWith('blueprint_parse_failed'))
}

async function testDangerousAndBadTypeBlueprintsRejected() {
  const loader = new BlueprintLoader()
  let validation = loader.validateBlueprint({
    name: 'bad',
    blocks: [{ x: 0, y: 0, z: 0, type: 'tnt' }]
  })
  assert.strictEqual(validation.ok, false)
  assert.ok(validation.error.includes('dangerous_block'))

  validation = loader.validateBlueprint({
    name: 'bad',
    blocks: [{ x: 0, y: 0, z: 0, type: 'oak planks' }]
  })
  assert.strictEqual(validation.ok, false)
  assert.ok(validation.error.includes('bad_type'))
}

async function testMaterialCounting() {
  const loader = new BlueprintLoader()
  const loaded = loader.loadBlueprint('chest_area')
  const materials = loader.getRequiredMaterials(loaded.blueprint)
  assert.strictEqual(materials.ok, true)
  assert.strictEqual(materials.materials.chest, 2)
  assert.strictEqual(materials.materials.oak_planks, 4)

  const pottedMaterials = loader.getRequiredMaterials({
    name: 'potted_test',
    blocks: [
      { x: 0, y: 0, z: 0, type: 'potted_cornflower' },
      { x: 1, y: 0, z: 0, type: 'potted_flowering_azalea_bush' }
    ]
  })
  assert.strictEqual(pottedMaterials.ok, true)
  assert.strictEqual(pottedMaterials.materials.flower_pot, 2)
  assert.strictEqual(pottedMaterials.materials.cornflower, 1)
  assert.strictEqual(pottedMaterials.materials.flowering_azalea, 1)

  const sanitizedCampfireMaterials = loader.getRequiredMaterials({
    name: 'sanitized_campfire_test',
    blocks: [
      { x: 0, y: 0, z: 0, type: 'lantern', states: { signal_fire: 'false', lit: 'false', facing: 'north' } },
      { x: 1, y: 0, z: 0, type: 'lantern', states: { hanging: 'false' } }
    ]
  })
  assert.strictEqual(sanitizedCampfireMaterials.ok, true)
  assert.strictEqual(sanitizedCampfireMaterials.materials.stone, 1)
  assert.strictEqual(sanitizedCampfireMaterials.materials.lantern, 1)

  const singleCandleMaterials = loader.getRequiredMaterials({
    name: 'single_candle_stack_test',
    blocks: [
      { x: 0, y: 0, z: 0, type: 'white_candle', states: { candles: '3', lit: 'false', waterlogged: 'false' } }
    ]
  })
  assert.strictEqual(singleCandleMaterials.ok, true)
  assert.strictEqual(singleCandleMaterials.materials.white_candle, 3)

  const twoCandleMaterials = loader.getRequiredMaterials({
    name: 'two_candle_stacks_test',
    blocks: [
      { x: 0, y: 0, z: 0, type: 'white_candle', states: { candles: '3' } },
      { x: 1, y: 0, z: 0, type: 'white_candle', states: { candles: '3' } }
    ]
  })
  assert.strictEqual(twoCandleMaterials.ok, true)
  assert.strictEqual(twoCandleMaterials.materials.white_candle, 6)

  const normalBlockMaterials = loader.getRequiredMaterials({
    name: 'normal_block_material_test',
    blocks: [{ x: 0, y: 0, z: 0, type: 'stone' }]
  })
  assert.strictEqual(normalBlockMaterials.ok, true)
  assert.strictEqual(normalBlockMaterials.materials.stone, 1)

  const otherStatefulMaterials = loader.getRequiredMaterials({
    name: 'other_stateful_materials_test',
    blocks: [
      { x: 0, y: 0, z: 0, type: 'spruce_slab', states: { type: 'double' } },
      { x: 1, y: 0, z: 0, type: 'sea_pickle', states: { pickles: '4' } },
      { x: 2, y: 0, z: 0, type: 'turtle_egg', states: { eggs: '3' } },
      { x: 3, y: 0, z: 0, type: 'pink_petals', states: { flower_amount: '2' } },
      { x: 4, y: 0, z: 0, type: 'snow', states: { layers: '5' } },
      { x: 5, y: 0, z: 0, type: 'red_bed', states: { part: 'foot' } },
      { x: 6, y: 0, z: 0, type: 'red_bed', states: { part: 'head' } },
      { x: 7, y: 0, z: 0, type: 'spruce_door', states: { half: 'lower' } },
      { x: 7, y: 1, z: 0, type: 'spruce_door', states: { half: 'upper' } },
      { x: 8, y: 0, z: 0, type: 'sunflower', states: { half: 'lower' } },
      { x: 8, y: 1, z: 0, type: 'sunflower', states: { half: 'upper' } }
    ]
  })
  assert.strictEqual(otherStatefulMaterials.ok, true)
  assert.strictEqual(otherStatefulMaterials.materials.spruce_slab, 2)
  assert.strictEqual(otherStatefulMaterials.materials.sea_pickle, 4)
  assert.strictEqual(otherStatefulMaterials.materials.turtle_egg, 3)
  assert.strictEqual(otherStatefulMaterials.materials.pink_petals, 2)
  assert.strictEqual(otherStatefulMaterials.materials.snow, 5)
  assert.strictEqual(otherStatefulMaterials.materials.red_bed, 1)
  assert.strictEqual(otherStatefulMaterials.materials.spruce_door, 1)
  assert.strictEqual(otherStatefulMaterials.materials.sunflower, 1)
}

async function testBlueprintRankingPrefersCommunityPopularity() {
  const request = { blueprintName: 'modern_villa', style: 'modern' }
  const popular = rankBlueprintCandidate({
    id: 'popular',
    blueprintName: 'modern_villa',
    sourceKind: 'community_index',
    style: 'modern',
    rating: 4.9,
    likes: 5000,
    downloads: 25000,
    quality: 'high',
    versionRange: { min: '1.20.0', max: '1.20.6' }
  }, request)
  const weak = rankBlueprintCandidate({
    id: 'weak',
    blueprintName: 'modern_villa',
    sourceKind: 'local_library',
    style: 'modern',
    rating: 2.5,
    likes: 2,
    downloads: 3,
    quality: 'low',
    versionRange: { min: '1.20.0', max: '1.20.6' }
  }, request)

  assert.ok(popular.score > weak.score)
  assert.ok(popular.rank.reasons.includes('popular'))
}

async function testBlueprintSelectorChoosesCommunityCandidate() {
  const generated = new ProceduralBlueprintGenerator().generate('modern_villa')
  assert.strictEqual(generated.ok, true)
  const cache = createCommunityCache([{
    id: 'test-modern-villa',
    blueprint: {
      ...generated.blueprint,
      metadata: {
        ...(generated.blueprint.metadata || {}),
        sourceKind: 'real_community_import',
        sourceMode: 'faithful-community-import',
        buildingType: 'modern_villa',
        style: 'modern'
      }
    },
    style: 'modern',
    buildingType: 'modern_villa',
    requiredStories: 1
  }])
  const selector = new BlueprintSelector({
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  })
  const selected = selector.selectBlueprint({ blueprintName: 'modern_villa', style: 'modern' })
  assert.strictEqual(selected.ok, true)
  assert.strictEqual(selected.selected.sourceKind, 'real_community_import')
  assert.strictEqual(selected.selected.sourceMode, 'faithful-community-import')
  assert.ok(selected.selected.localBlueprintPath)
  assert.strictEqual(selected.blueprint.metadata.sourceMode, 'faithful-community-import')
  assert.strictEqual(selected.blueprint.metadata.sourceKind, 'real_community_import')
  assert.ok(selected.candidates.length >= 1)
}

async function testBlueprintSelectorProceduralFallback() {
  const selector = new BlueprintSelector({ allowCommunity: false })
  const selected = selector.selectBlueprint({ blueprintName: 'fountain' })
  assert.strictEqual(selected.ok, true)
  assert.strictEqual(selected.selected.sourceKind, 'procedural_fallback')
  assert.strictEqual(selected.blueprint.name, 'fountain')
  assert.ok(Math.max(...selected.blueprint.blocks.map(block => block.y)) <= 2)
}

async function testBuildingComplexityIntentMapping() {
  const simpleSmall = adaptBuildIntentToDesignSpec({
    rawText: '\u7b80\u5355\u5c0f\u6728\u5c4b',
    blueprintName: 'simple_wood_cabin'
  })
  assert.strictEqual(simpleSmall.complexityTier, 'L2')

  const simpleTwoStory = parseIntent('\u6797\u590f\uff0c\u5efa\u4e00\u4e2a\u7b80\u5355\u7684\u53cc\u5c42\u6728\u5c4b')
  assert.strictEqual(simpleTwoStory.actionKey, ACTION_KEYS.BUILD)
  assert.strictEqual(simpleTwoStory.params.blueprintName, 'two_story_wood_house')
  assert.strictEqual(simpleTwoStory.params.complexityTier, 'L3')
  assert.strictEqual(simpleTwoStory.params.designSpec.maxBlockBudget, 500)

  // 第 14 轮（#66）起 two_story_wood_house 在「按图纸原样盖、不按档位裁」名单里：
  // 不带大小词地点名它，就不再套任何档位预算——这正是「原样盖」的意思，也是它
  // 终于能被盖出来的原因（以前套 L3 会被换成 465 块的 simple_two_story_cabin）。
  // 上面带「简单」的那句仍然是 L3，下面带 detailed / showcase 的仍然升档。
  const ordinaryTwoStory = parseIntent('build two story wood house')
  assert.strictEqual(ordinaryTwoStory.params.blueprintName, 'two_story_wood_house')
  assert.strictEqual(ordinaryTwoStory.params.complexityTier ?? null, null)

  const detailedTwoStory = parseIntent('build detailed two story wood house')
  assert.strictEqual(detailedTwoStory.params.complexityTier, 'L4')

  const showcase = parseIntent('build showcase wood house')
  assert.strictEqual(showcase.params.complexityTier, 'L5')
  assert.strictEqual(showcase.params.requiresConfirmation, true)
}

async function testNamedVillaAndCastlePreserveFormalScaleWithoutImplicitL2() {
  for (const rawText of [
    'build modern villa',
    '\u5efa\u9020\u73b0\u4ee3\u522b\u5885',
    'build castle',
    '\u5efa\u9020\u57ce\u5821'
  ]) {
    const intent = parseIntent(rawText)
    assert.strictEqual(intent.actionKey, ACTION_KEYS.BUILD, rawText)
    assert.strictEqual(intent.params.complexityTier, undefined, rawText)
    assert.strictEqual(intent.params.designSpec, undefined, rawText)
  }

  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'modern_house_on_a_hilltop_site_fit'
  }), true)
  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'survival_castle'
  }), true)

  const reduced = parseIntent('build small modern villa')
  assert.strictEqual(reduced.params.blueprintName, 'modern_villa')
  assert.strictEqual(reduced.params.complexityTier, 'L2')

  const cache = createCommunityCache([{
    id: 'formal-modern-villa-scale-fixture',
    title: 'Formal modern villa scale fixture',
    blueprint: communityVillaBlueprint({ name: 'formal_modern_villa_scale_fixture' }),
    style: 'modern',
    buildingType: 'modern_villa',
    requiredStories: 2
  }])
  const villa = new BlueprintSelector({
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  }).selectBlueprint({
    blueprintName: 'modern_villa',
    rawText: 'build modern villa'
  })
  assert.strictEqual(villa.ok, true, villa.error)
  assert.strictEqual(villa.selected.sourceKind, 'real_community_import')
  assert.strictEqual(villa.selected.sourceMode, 'faithful-community-import')
  assert.ok(villa.blueprint.blocks.length > 1000)

  const capturedInputs = []
  const system = createSyntheticBuildingSystem({
    selector: {
      selectBlueprint(input) {
        capturedInputs.push(input)
        return { ok: false, error: 'named_scale_probe_stop' }
      }
    }
  })
  const preview = system.previewBlueprint(
    createContext([]),
    'modern_villa',
    null,
    { rawText: 'build modern villa' }
  )
  assert.strictEqual(preview.ok, false)
  assert.strictEqual(preview.error, 'named_scale_probe_stop')
  assert.strictEqual(capturedInputs.length, 1)
  assert.strictEqual(capturedInputs[0].designSpec, null)
}

async function testResumeBuildIntentPreservesFaithfulBlueprintAndForbidsFreshRun() {
  for (const rawText of [
    'continue building two story wood house',
    'resume two story wood house',
    '\u7eed\u5efa\u53cc\u5c42\u6728\u5c4b'
  ]) {
    const intent = parseIntent(rawText)
    assert.strictEqual(intent.actionKey, ACTION_KEYS.BUILD, rawText)
    assert.strictEqual(intent.params.blueprintName, 'two_story_wood_house', rawText)
    assert.strictEqual(intent.params.resumeOnly, true, rawText)
    assert.notStrictEqual(intent.params.forceRebuild, true, rawText)
    assert.strictEqual(intent.params.complexityTier, undefined, rawText)
    assert.strictEqual(intent.params.designSpec, undefined, rawText)
  }

  let enqueued = null
  const resumeDecision = parseIntent('continue building two story wood house')
  resumeDecision.shouldExecute = true
  const routed = await intentToTask(resumeDecision, {
    taskManager: {
      enqueue(type, params, priority, source) {
        enqueued = { type, params, priority, source }
        return enqueued
      }
    }
  })
  assert.strictEqual(routed.ok, true)
  assert.strictEqual(enqueued.type, 'build_blueprint')
  assert.strictEqual(enqueued.params.resumeOnly, true)
  assert.strictEqual(enqueued.params.complexityTier, null)
  assert.strictEqual(enqueued.params.designSpec, null)
  assert.notStrictEqual(enqueued.params.forceRebuild, true)

  const cache = createCommunityCache([{
    id: 'formal-resume-house-fixture',
    title: 'Formal resume house fixture',
    blueprint: faithfulTwoStoryWoodHousePreviewBlueprint({ name: 'formal_resume_house_fixture' }),
    style: 'wood',
    buildingType: 'two_story_wood_house',
    requiredStories: 2
  }])
  const selected = new BlueprintSelector({
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  }).selectBlueprint({
    blueprintName: 'two_story_wood_house',
    rawText: 'continue building two story wood house',
    resumeOnly: true
  })
  assert.strictEqual(selected.ok, true, selected.error)
  assert.strictEqual(selected.selected.sourceKind, 'real_community_import')
  assert.strictEqual(selected.selected.sourceMode, 'faithful-community-import')

  const capturedInputs = []
  const system = createSyntheticBuildingSystem({
    selector: {
      selectBlueprint(input) {
        capturedInputs.push(input)
        return { ok: false, error: 'selection_probe_stop' }
      }
    }
  })
  const preview = system.previewBlueprint(
    createContext([]),
    'two_story_wood_house',
    null,
    { rawText: 'continue building two story wood house', resumeOnly: true }
  )
  assert.strictEqual(preview.ok, false)
  assert.strictEqual(preview.error, 'selection_probe_stop')
  assert.strictEqual(capturedInputs.length, 1)
  assert.strictEqual(capturedInputs[0].resumeOnly, true)
  assert.strictEqual(capturedInputs[0].designSpec, null)
  assert.strictEqual(capturedInputs[0].complexityTier, undefined)
  assert.notStrictEqual(capturedInputs[0].forceRebuild, true)
}

async function testShowcaseBuildRequiresConfirmationBeforeTask() {
  const decision = parseIntent('build showcase wood house')
  decision.shouldExecute = true
  const result = await intentToTask(decision, {
    taskManager: {
      enqueue() {
        throw new Error('showcase build should not enqueue before confirmation')
      }
    }
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.action, 'confirm')
  assert.strictEqual(result.reason, 'complexity_l5_requires_explicit_confirmation')
}

async function testBlueprintSelectorFiltersByComplexityBudget() {
  const p9r = complexTwoStoryWoodHouseBlueprint()
  const cache = createCommunityCache([{
    id: 'p9r-complex-two-story-wood-house',
    title: 'P9R complex two story wood house',
    blueprint: p9r,
    style: 'wood',
    buildingType: 'two_story_wood_house',
    requiredStories: 2
  }])
  const selector = new BlueprintSelector({
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  })
  const selected = selector.selectBlueprint({
    blueprintName: 'two_story_wood_house',
    rawText: 'build simple two story wood house',
    complexityTier: 'L3'
  })

  assert.strictEqual(selected.ok, true)
  assert.strictEqual(selected.selected.sourceKind, 'procedural_fallback')
  assert.strictEqual(selected.selected.generatorKey, 'simple_two_story_cabin')
  assert.strictEqual(selected.blueprint.name, 'simple_two_story_cabin')
  assert.notStrictEqual(selected.selected.id, 'p9r-complex-two-story-wood-house')

  const rejectedCommunity = selected.attempted.find(entry => entry.id === 'p9r-complex-two-story-wood-house')
  assert.ok(rejectedCommunity, 'community candidate should be attempted')
  assert.strictEqual(rejectedCommunity.ok, false)
  assert.ok(rejectedCommunity.error.startsWith('complexity_budget_rejected'), rejectedCommunity.error)

  const simpleMetrics = estimateBlueprintComplexity(selected.blueprint)
  const p9rMetrics = estimateBlueprintComplexity(p9r)
  assert.ok(simpleMetrics.blockCount < p9rMetrics.blockCount)
  assert.ok(simpleMetrics.blockCount <= selected.selected.budget.maxBlockBudget)
}

async function testL3BudgetRejectsP9RDecorations() {
  const spec = adaptBuildIntentToDesignSpec({
    rawText: 'simple two story wood house',
    blueprintName: 'two_story_wood_house'
  })
  const p9r = complexTwoStoryWoodHouseBlueprint()
  const p9rBudget = blueprintSatisfiesDesignSpec(p9r, spec)
  assert.strictEqual(p9rBudget.ok, false)
  assert.ok(p9rBudget.failures.some(reason => reason.startsWith('block_budget_exceeded')))
  assert.ok(p9rBudget.failures.some(reason => reason.startsWith('hanging_lanterns_not_allowed')))
  assert.ok(p9rBudget.failures.some(reason => reason.startsWith('cake_not_allowed')))
  assert.ok(p9rBudget.failures.some(reason => reason.startsWith('flower_pots_not_allowed')))

  const simple = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin').blueprint
  const simpleBudget = blueprintSatisfiesDesignSpec(simple, spec)
  assert.strictEqual(simpleBudget.ok, true, simpleBudget.failures.join(','))
  assert.strictEqual(simpleBudget.metrics.cakeCount, 0)
  assert.strictEqual(simpleBudget.metrics.lanternCount, 0)
  assert.strictEqual(simpleBudget.metrics.flowerPotCount, 0)
  assert.strictEqual(simpleBudget.metrics.complexStairStateCount, 0)
}

async function testConstructionEstimateReportsBudgetAndTime() {
  const spec = adaptBuildIntentToDesignSpec({
    rawText: 'build simple two story wood house',
    blueprintName: 'two_story_wood_house'
  })
  const blueprint = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin').blueprint
  const estimate = createConstructionEstimate({
    blueprint,
    orderPlan: { summary: { totalSteps: 460 } },
    designSpec: spec
  })
  assert.strictEqual(estimate.complexityTier, 'L3')
  assert.ok(estimate.blockCount >= 250)
  assert.ok(estimate.blockCount <= 500)
  assert.strictEqual(estimate.expectedSteps, 460)
  assert.ok(estimate.estimatedMinutesLow > 0)
  assert.ok(estimate.estimatedMinutesHigh >= estimate.estimatedMinutesLow)
}

async function testBudgetedSimpleTwoStoryPreviewUsesProceduralTemplate() {
  const ctx = createContext(richBuildItems(2000))
  const p9r = complexTwoStoryWoodHouseBlueprint()
  const cache = createCommunityCache([{
    id: 'p9r-complex-two-story-wood-house-preview',
    title: 'P9R complex two story wood house preview',
    blueprint: p9r,
    style: 'wood',
    buildingType: 'two_story_wood_house',
    requiredStories: 2
  }])
  const system = createSyntheticBuildingSystem({
    selector: new BlueprintSelector({
      index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
    })
  })
  const preview = system.previewBlueprint(ctx, 'two_story_wood_house', { x: 0, y: 64, z: 0 }, {
    rawText: 'build simple two story wood house',
    complexityTier: 'L3',
    explicitOrigin: true
  })
  assert.strictEqual(preview.ok, true, preview.error)
  assert.strictEqual(preview.designSpec.complexityTier, 'L3')
  assert.strictEqual(preview.blueprint.name, 'simple_two_story_cabin')
  assert.strictEqual(preview.selectedBlueprint.sourceKind, 'procedural_fallback')
  assert.strictEqual(preview.designPlan.layer, 'complexity_budget_preserved')
  assert.strictEqual(preview.aestheticPlan.skipped, true)
  assert.ok(preview.constructionEstimate.expectedSteps > 0)
  assert.ok(preview.orderPlan.summary.totalSteps < p9r.blocks.length)
}

async function testRebuildTwoStoryPreviewPreservesFaithfulCommunityImport() {
  const capturedInputs = []
  const system = createSyntheticBuildingSystem({
    selector: {
      selectBlueprint(input) {
        capturedInputs.push(input)
        return { ok: false, error: 'selection_probe_stop' }
      }
    }
  })

  const preview = system.previewBlueprint(createContext([]), 'two_story_wood_house', { x: 0, y: 64, z: 0 }, {
    rawText: 'rebuild two story wood house',
    forceRebuild: true,
    explicitOrigin: true
  })

  assert.strictEqual(preview.ok, false)
  assert.strictEqual(preview.error, 'selection_probe_stop')
  assert.strictEqual(capturedInputs.length, 1)
  assert.strictEqual(capturedInputs[0].blueprintName, 'two_story_wood_house')
  assert.strictEqual(capturedInputs[0].rawText, 'rebuild two story wood house')
  assert.strictEqual(capturedInputs[0].complexityTier, undefined)
  assert.strictEqual(capturedInputs[0].designSpec, null)
  assert.strictEqual(capturedInputs[0].forceRebuild, true)

  const p9r = complexTwoStoryWoodHouseBlueprint()
  const cache = createCommunityCache([{
    id: 'p9r-rebuild-two-story-wood-house-preview',
    title: 'P9R rebuild two story wood house preview',
    blueprint: p9r,
    style: 'wood',
    buildingType: 'two_story_wood_house',
    requiredStories: 2
  }])
  const selected = new BlueprintSelector({
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  }).selectBlueprint({
    blueprintName: 'two_story_wood_house',
    rawText: 'rebuild two story wood house',
    forceRebuild: true
  })

  assert.strictEqual(selected.ok, true, selected.error)
  assert.strictEqual(selected.selected.sourceKind, 'real_community_import')
  assert.strictEqual(selected.selected.sourceMode, 'faithful-community-import')
  assert.strictEqual(selected.blueprint.name, 'p9r_like_two_story_wood_house')

  const fullPreviewSystem = createSyntheticBuildingSystem({
    selector: new BlueprintSelector({
      index: new CommunityBlueprintIndex({
        cacheIndexPath: createCommunityCache([{
          id: 'faithful-rebuild-two-story-wood-house-preview',
          title: 'Faithful rebuild two story wood house preview',
          blueprint: faithfulTwoStoryWoodHousePreviewBlueprint(),
          style: 'wood',
          buildingType: 'two_story_wood_house',
          requiredStories: 2
        }]).indexPath,
        candidates: []
      })
    })
  })
  const fullPreview = fullPreviewSystem.previewBlueprint(
    createContext(richBuildItems(3000)),
    'two_story_wood_house',
    { x: 0, y: 64, z: 0 },
    {
      rawText: 'rebuild two story wood house',
      forceRebuild: true,
      explicitOrigin: true
    }
  )
  assert.strictEqual(fullPreview.ok, true, fullPreview.error)
  assert.strictEqual(fullPreview.selectedBlueprint.sourceKind, 'real_community_import')
  assert.strictEqual(fullPreview.selectedBlueprint.sourceMode, 'faithful-community-import')
  assert.strictEqual(fullPreview.blueprint.name, 'faithful_two_story_wood_house_preview')
  assert.notStrictEqual(fullPreview.selectedBlueprint.sourceKind, 'procedural_fallback')
}

async function testSmallerDesignSpecReducesConstructionPlanSteps() {
  const ctx = createContext(richBuildItems(3000))
  const system = createSyntheticBuildingSystem()
  const loader = new BlueprintLoader()
  const simple = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin').blueprint
  const p9r = complexTwoStoryWoodHouseBlueprint()
  const origin = { x: 0, y: 64, z: 0 }
  const simpleCompiled = system.compileConstructionPlan(ctx, simple, origin, loader.getRequiredMaterials(simple), {
    explicitOrigin: true,
    skipScaffolding: true
  })
  const p9rCompiled = system.compileConstructionPlan(ctx, p9r, origin, loader.getRequiredMaterials(p9r), {
    explicitOrigin: true,
    skipScaffolding: true
  })
  assert.strictEqual(simpleCompiled.ok, true, simpleCompiled.error)
  assert.strictEqual(p9rCompiled.ok, true, p9rCompiled.error)
  assert.ok(simpleCompiled.orderPlan.summary.totalSteps < p9rCompiled.orderPlan.summary.totalSteps)
}

async function testProceduralBlueprintGeneratorSupportsRequiredTypes() {
  const generator = new ProceduralBlueprintGenerator()
  for (const name of [
    'two_story_wood_house',
    'simple_two_story_cabin',
    'simple_wood_cabin',
    'starter_shelter',
    'simple_farmhouse',
    'modern_villa',
    'castle_garden',
    'garden_manor',
    'statue',
    'fountain'
  ]) {
    const generated = generator.generate(name)
    assert.strictEqual(generated.ok, true, name)
    assert.strictEqual(generated.blueprint.name, name)
    assert.ok(generated.blueprint.blocks.length > 0)
  }
}

async function testBuildingDesignerTransformsBoxyBlueprintsIntoArchitecture() {
  const generator = new ProceduralBlueprintGenerator()
  const designer = new BuildingDesigner()
  for (const [name, style] of [
    ['two_story_wood_house', 'wood'],
    ['modern_villa', 'modern'],
    ['castle_garden', 'castle']
  ]) {
    const generated = generator.generate(name)
    const before = analyzeBlueprint(generated.blueprint)
    const designed = designer.transformBlueprint(generated.blueprint, { blueprintName: name })
    assert.strictEqual(designed.ok, true, name)
    assert.strictEqual(designed.design.style, style)
    assert.strictEqual(designed.design.transformed, true)

    const after = analyzeBlueprint(designed.blueprint)
    const styleValidation = validateStyleGrammar(designed.blueprint, style, designed.design)
    const facadeValidation = validateFacade(designed.blueprint)
    assert.strictEqual(after.isPureBox, false, name)
    assert.ok(after.uniqueColumnHeights.length >= 2, name)
    assert.ok(after.windowGroups >= 2, name)
    assert.strictEqual(styleValidation.ok, true, `${name}:${styleValidation.violations.join(',')}`)
    assert.strictEqual(facadeValidation.ok, true, `${name}:${facadeValidation.violations.join(',')}`)
    if (before.isPureBox) assert.ok(after.footprintFill < before.footprintFill, name)
  }
}

async function testBuildingDesignerOutputsDesignSchema() {
  const designer = new BuildingDesigner()
  const result = designer.design({ type: 'wood house', blueprintName: 'wood_house' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.design.layer, 'design')
  assert.ok(result.design.silhouette)
  assert.ok(Array.isArray(result.design.volumeSegmentation))
  assert.ok(result.design.volumeSegmentation.length >= 3)
  assert.ok(result.design.roofType)
  assert.ok(result.design.symmetryRules)
  assert.ok(result.design.facadeLayout)
}

async function testCommunityCollectorLoadsEncodedAestheticSamples() {
  const collector = createSyntheticCollector()
  const result = collector.loadSamples({ blueprintName: 'modern_villa', style: 'modern' })
  assert.strictEqual(result.ok, true)
  assert.ok(result.samples.length >= 1)
  const sample = result.samples[0]
  assert.ok(sample.blockDistribution)
  assert.ok(sample.shape)
  assert.ok(Array.isArray(sample.heightMap))
  assert.strictEqual(typeof sample.symmetryScore, 'number')
  assert.ok(Array.isArray(sample.densityMap))
  assert.strictEqual(sample.encoding.ok, true)
  assert.ok(sample.encoding.graph.nodes.length >= 1)
  assert.ok(sample.encoding.vector.length > 0)
}

async function testStructureEncoderProducesSimilarityReadyGraph() {
  const generator = new ProceduralBlueprintGenerator()
  const designer = new BuildingDesigner()
  const encoder = new StructureEncoder()
  const raw = generator.generate('two_story_wood_house').blueprint
  const designed = designer.transformBlueprint(raw, { blueprintName: 'two_story_wood_house', forceDesignVariation: true })
  const encoded = encoder.encode(designed.blueprint)
  assert.strictEqual(encoded.ok, true)
  assert.strictEqual(encoded.similarityReady, true)
  assert.ok(encoded.graph.nodes.length >= 3)
  assert.ok(encoded.features.heightVariance > 0)
  assert.ok(encoded.features.facadeComplexity >= 0.4)
  assert.strictEqual(encoder.similarity(encoded, encoded), 1)
}

async function testAestheticModelPenalizesBoxAndScoresRefinedBuild() {
  const generator = new ProceduralBlueprintGenerator()
  const collector = createSyntheticCollector()
  const model = new AestheticModel()
  const samples = collector.loadSamples({ blueprintName: 'two_story_wood_house' }).samples
  const raw = generator.generate('two_story_wood_house').blueprint
  const rawScore = model.score(raw, samples)
  assert.strictEqual(rawScore.ok, true)
  assert.strictEqual(rawScore.accepted, false)
  assert.ok(rawScore.penalties.some(penalty => penalty.code === 'box_like_structure' || penalty.code === 'flat_structure'))

  const refined = new BuildingDesigner().transformBlueprint(raw, { blueprintName: 'two_story_wood_house', forceDesignVariation: true })
  const refinedScore = model.score(refined.blueprint, samples)
  assert.strictEqual(refinedScore.ok, true)
  assert.strictEqual(refinedScore.accepted, true, JSON.stringify(refinedScore))
  assert.ok(refinedScore.aesthetic_score > rawScore.aesthetic_score)
  assert.ok(refinedScore.similarity_to_good_builds >= refinedScore.similarityThreshold)
}

async function testAestheticRefinerImprovesLowScoreBlueprint() {
  const generator = new ProceduralBlueprintGenerator()
  const collector = createSyntheticCollector()
  const samples = collector.loadSamples({ blueprintName: 'castle_garden' }).samples
  const raw = generator.generate('castle_garden').blueprint
  const refiner = new AestheticRefiner()
  const result = refiner.refineBlueprint(raw, { blueprintName: 'castle_garden' }, samples)
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.initial.accepted, false)
  assert.strictEqual(result.final.accepted, true)
  assert.ok(result.iterations >= 1)
  assert.ok(result.operations.some(entry => entry.operations.includes('facade_reconstruction')))
  assert.ok(result.final.aesthetic_score >= result.final.threshold)
}

async function testInteriorPlannerAddsRequiredFurnitureAndAvoidsPaths() {
  const generator = new ProceduralBlueprintGenerator()
  const generated = generator.generate('modern_villa')
  const planner = new InteriorPlanner()
  const planned = planner.plan(generated.blueprint)
  assert.strictEqual(planned.ok, true)
  assert.strictEqual(planned.plan.complete, true)
  assert.strictEqual(planned.plan.pathPreserved, true)
  assert.ok(planned.blueprint.blocks.some(block => block.role === 'bed' && block.type === 'white_wool' && block.phase === 'interior'))
  for (const type of ['crafting_table', 'furnace', 'chest']) {
    assert.ok(planned.blueprint.blocks.some(block => block.type === type && block.phase === 'interior'), type)
  }
  assert.ok(planned.plan.rooms.some(room => room.zone === 'kitchen'))
  assert.ok(planned.plan.rooms.some(room => room.zone === 'bedroom'))
  assert.ok(planned.plan.rooms.some(room => room.zone === 'living_room'))
}

async function testFunctionalLayoutAndWalkabilityForP8Cases() {
  const selector = new BlueprintSelector()
  const designer = new BuildingDesigner()
  const layoutPlanner = new SpaceLayoutPlanner()
  const interiorPlanner = new InteriorPlanner()
  const interiorValidator = new InteriorUsabilityValidator()
  const walkability = new WalkabilityChecker()
  const hardGate = new BuildingHardGate()

  for (const [name, expectedStyle] of [
    ['two_story_wood_house', 'wood'],
    ['modern_villa', 'modern'],
    ['castle_garden', 'castle']
  ]) {
    const selected = selector.selectBlueprint({ blueprintName: name })
    assert.strictEqual(selected.ok, true, name)
    const designed = designer.transformBlueprint(selected.blueprint, { blueprintName: name, selected: selected.selected })
    assert.strictEqual(designed.ok, true, name)
    const layout = layoutPlanner.plan(designed.blueprint, { blueprintName: name, design: designed.design })
    assert.strictEqual(layout.ok, true, name)
    assert.strictEqual(layout.plan.style, expectedStyle)
    assert.ok(layout.plan.rooms.length >= 3, name)
    assert.ok(layout.plan.entrances.length >= 1, name)
    assert.ok(layout.plan.pathCells.length > 0, name)
    assert.ok(layout.plan.minMainPathWidth >= 2, name)
    const layoutBlocks = new Map(layout.blueprint.blocks.map(block => [`${block.x},${block.y},${block.z}`, block]))
    if (name !== 'castle_garden') {
      assert.ok(layout.plan.stairs.length >= 1, name)
      for (const stair of layout.plan.stairs) {
        for (const cell of stair.upperCells || []) {
          const landing = layoutBlocks.get(`${cell.x},${cell.y - 1},${cell.z}`)
          const support = layoutBlocks.get(`${cell.x},${cell.y - 2},${cell.z}`)
          assert.ok(landing && landing.type !== 'air', `${name}:upper_landing_missing_support_block`)
          assert.ok(support && support.type !== 'air', `${name}:upper_landing_missing_place_reference`)
        }
      }
    } else {
      assert.strictEqual(layoutBlocks.get('3,3,0')?.type, 'air')
      assert.strictEqual(layoutBlocks.get('4,3,0')?.type, 'air')
    }

    const interior = interiorPlanner.plan(layout.blueprint, { blueprintName: name, layout: layout.plan, design: designed.design })
    assert.strictEqual(interior.ok, true, name)
    assert.strictEqual(interior.plan.complete, true, name)

    const usability = interiorValidator.validate(interior.blueprint, { layoutPlan: layout.plan, interiorPlan: interior.plan })
    assert.strictEqual(usability.ok, true, `${name}:${usability.failures.join(',')}`)

    const walkable = walkability.checkBlueprint(interior.blueprint, { layoutPlan: layout.plan, interiorPlan: interior.plan })
    assert.strictEqual(walkable.ok, true, `${name}:${walkable.failures.join(',')}`)
    assert.ok(walkable.reachableTargets.some(target => target.role === 'bed'), name)
    assert.ok(walkable.reachableTargets.some(target => target.role === 'chest'), name)

    const gate = hardGate.evaluateBlueprint(interior.blueprint, { blueprintName: name })
    assert.strictEqual(gate.ok, true, `${name}:${gate.failures.join(',')}`)
  }
}

async function testInteriorUsabilityRejectsFurnitureBlockingMainPath() {
  const validator = new InteriorUsabilityValidator()
  const blueprint = {
    name: 'blocked_path_room',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 1, y: 0, z: 0, type: 'oak_planks' },
      { x: 2, y: 0, z: 0, type: 'oak_planks' },
      { x: 1, y: 1, z: 0, type: 'chest', phase: 'interior', role: 'chest', interior: true }
    ]
  }
  const layoutPlan = {
    enabled: true,
    minMainPathWidth: 2,
    pathCells: [{ x: 1, y: 1, z: 0 }],
    stairCells: [],
    stairs: []
  }
  const interiorPlan = {
    enabled: true,
    placements: [{ x: 1, y: 1, z: 0, type: 'chest', role: 'chest' }]
  }

  const result = validator.validate(blueprint, { layoutPlan, interiorPlan })
  assert.strictEqual(result.ok, false)
  assert.ok(result.failures.some(failure => failure.startsWith('furniture_blocks_path:chest')))
}

async function testWalkabilityRejectsJumpDependentPath() {
  const checker = new WalkabilityChecker()
  const blueprint = {
    name: 'jump_only',
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      functionalLayout: {
        enabled: true,
        minMainPathWidth: 2,
        rooms: [{ id: 'upper', zone: 'bedroom', bounds: { minX: 1, minY: 2, minZ: 0, maxX: 1, maxY: 2, maxZ: 0 }, entrance: { x: 1, y: 2, z: 0 } }],
        entrances: [{ id: 'front', cells: [{ x: 0, y: 1, z: 0 }] }]
      }
    },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 1, y: 1, z: 0, type: 'oak_planks' }
    ]
  }
  const layoutPlan = blueprint.metadata.functionalLayout
  const result = checker.checkBlueprint(blueprint, { layoutPlan, interiorPlan: { placements: [] } })
  assert.strictEqual(result.ok, false)
  assert.ok(result.failures.includes('jump_required:room:bedroom'))
}

async function testBuildTaskMissingMaterials() {
  const ctx = createContext([{ name: 'oak_planks', count: 1 }])
  const task = createSyntheticBuildTask(1, { blueprintName: 'small_house', origin: { x: 0, y: 64, z: 0 } })
  await runTaskUpdate(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'missing_materials')
  assert.ok(task.missingMaterials.some(item => item.item === 'oak_planks'))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testBuildTaskPlacesBlock() {
  const ctx = createContext(richBuildItems())
  const task = createSyntheticBuildTask(2, { blueprintName: 'small_house', origin: { x: 0, y: 64, z: 0 } })
  await runTaskUpdate(task, ctx)
  assert.strictEqual(task.state, 'RUNNING')
  assert.ok(ctx.placed.length > 0)
  assert.ok(ctx.placed.length <= 3)
  assert.strictEqual(task.scaffoldBlocks, 0)
  assert.strictEqual(ctx.placed.length, task.placedBlocks + task.foundationBlocks + task.scaffoldBlocks)
  assert.strictEqual(task.designPlan.transformed, true)
  assert.strictEqual(task.designPlan.metrics.pureBox, false)
  assert.strictEqual(task.aestheticPlan.accepted, true)
  assert.ok(task.aestheticPlan.final.aesthetic_score >= task.aestheticPlan.threshold)
}

async function testBuildTaskWaitsForAsyncSessionBeforePlacing() {
  const ctx = createContext(richBuildItems())
  const buildReady = createDeferred()
  const origin = { x: 0, y: 64, z: 0 }
  let buildCalls = 0
  let placeCalls = 0
  let placeOptions = null
  const status = {
    blueprintName: 'async_house',
    origin,
    totalBlocks: 1,
    placedBlocks: 0,
    clearedBlocks: 0,
    foundationBlocks: 0,
    scaffoldBlocks: 0,
    removedScaffoldBlocks: 0,
    currentIndex: 0,
    currentStepIndex: 0,
    totalSteps: 1,
    missingMaterials: []
  }
  const fakeSystem = {
    session: null,
    async buildBlueprint() {
      buildCalls++
      await buildReady.promise
      this.session = { ok: true }
      return { ok: true }
    },
    getStatus() {
      return this.session ? status : null
    },
    async placeNextBlock(context, options) {
      placeCalls++
      placeOptions = options
      if (!this.session) return { ok: false, error: 'build_session_missing' }
      return { ok: true, completed: false, build: status }
    }
  }
  const task = new BuildTask({
    id: 12,
    params: {
      blueprintName: 'async_house',
      origin,
      buildingSystem: fakeSystem
    }
  })

  const startPromise = task.start(ctx)
  await nextTick()
  assert.strictEqual(buildCalls, 1)
  assert.strictEqual(task.state, 'RUNNING')
  assert.strictEqual(task.started, false)

  const updatePromise = task.update(ctx)
  await nextTick()
  assert.strictEqual(placeCalls, 0)
  assert.strictEqual(task.state, 'RUNNING')

  buildReady.resolve()
  await startPromise
  await updatePromise

  assert.strictEqual(task.started, true)
  assert.strictEqual(task.state, 'RUNNING')
  assert.strictEqual(placeCalls, 1)
  assert.strictEqual(typeof placeOptions.shouldContinue, 'function')
  assert.strictEqual(placeOptions.shouldContinue(), true)
  assert.strictEqual(task.failedReason, null)
}

async function testBuildTaskPassesExplicitRebuildOption() {
  const ctx = createContext(richBuildItems())
  const calls = []
  const fakeSystem = {
    async buildBlueprint(context, blueprintName, origin, options) {
      calls.push({ blueprintName, origin, options })
      return { ok: true }
    },
    getStatus() {
      return {
        blueprintName: 'small_house',
        origin: { x: 0, y: 64, z: 0 },
        totalBlocks: 0,
        placedBlocks: 0,
        clearedBlocks: 0,
        foundationBlocks: 0,
        scaffoldBlocks: 0,
        removedScaffoldBlocks: 0,
        currentIndex: 0,
        currentStepIndex: 0,
        totalSteps: 0,
        missingMaterials: []
      }
    },
    async placeNextBlock() {
      return { ok: true, completed: true }
    }
  }
  const task = new BuildTask({
    id: 14,
    params: {
      blueprintName: 'small_house',
      origin: { x: 0, y: 64, z: 0 },
      forceRebuild: true,
      rebuildReason: 'explicit_rebuild_requested',
      buildingSystem: fakeSystem
    }
  })

  await task.start(ctx)

  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].options.forceRebuild, true)
  assert.strictEqual(calls[0].options.rebuild, true)
  assert.strictEqual(calls[0].options.rebuildReason, 'explicit_rebuild_requested')
  assert.strictEqual(task.toJSON().forceRebuild, true)
  assert.strictEqual(task.toJSON().rebuildReason, 'explicit_rebuild_requested')
}

async function testBuildTaskPassesResumeOnlyGuard() {
  const ctx = createContext(richBuildItems())
  const calls = []
  const fakeSystem = {
    async buildBlueprint(context, blueprintName, origin, options) {
      calls.push({ blueprintName, origin, options })
      return { ok: true }
    },
    getStatus() {
      return {
        blueprintName: 'two_story_wood_house',
        origin: { x: 0, y: 64, z: 0 },
        totalBlocks: 0,
        placedBlocks: 0,
        clearedBlocks: 0,
        foundationBlocks: 0,
        scaffoldBlocks: 0,
        removedScaffoldBlocks: 0,
        currentIndex: 0,
        currentStepIndex: 0,
        totalSteps: 0,
        missingMaterials: []
      }
    },
    async placeNextBlock() {
      return { ok: true, completed: true }
    }
  }
  const task = new BuildTask({
    id: 15,
    params: {
      blueprintName: 'two_story_wood_house',
      rawText: 'continue building two story wood house',
      resumeOnly: true,
      buildingSystem: fakeSystem
    }
  })

  await task.start(ctx)

  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].options.resumeOnly, true)
  assert.strictEqual(calls[0].options.allowFreshBuild, false)
  assert.notStrictEqual(calls[0].options.forceRebuild, true)
  assert.strictEqual(task.toJSON().resumeOnly, true)
}

function testDistantOriginIsAllowedOnlyForStoredResumePlacement() {
  const storedOrigin = { x: 80, y: 70, z: -40 }
  const constructionRunStore = {
    findActiveForBlueprint(blueprintId) {
      if (blueprintId !== 'resume_house') return null
      return {
        runId: 'construction_run_stored_origin',
        status: 'ACTIVE',
        placementContext: { origin: storedOrigin }
      }
    }
  }
  const system = createSyntheticBuildingSystem({ constructionRunStore })
  const selected = { blueprint: { name: 'resume_house' } }

  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin(selected, storedOrigin, { resumeOnly: true, allowFreshBuild: false }),
    true
  )
  assert.strictEqual(system.allowsDistantStoredResumeOrigin(selected, storedOrigin, {}), false)
  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin(selected, storedOrigin, { resumeOnly: true, explicitOrigin: true }),
    false
  )
  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin(selected, storedOrigin, { resumeOnly: true, forceRebuild: true }),
    false
  )
  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin(selected, { ...storedOrigin, x: storedOrigin.x + 1 }, { resumeOnly: true }),
    false
  )
  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin({ blueprint: { name: 'fresh_house' } }, storedOrigin, { resumeOnly: true }),
    false
  )
}

function testTerrainAlternativesReserveInventoryForOriginalSteps() {
  const steps = [
    { id: 'dirt-1', kind: 'place', blockName: 'dirt', role: 'terrain', position: { x: 0, y: 64, z: 0 } },
    { id: 'dirt-2', kind: 'place', blockName: 'dirt', role: 'terrain', position: { x: 1, y: 64, z: 0 } },
    { id: 'grass-1', kind: 'place', blockName: 'grass_block', role: 'terrain', position: { x: 2, y: 64, z: 0 } },
    { id: 'grass-2', kind: 'place', blockName: 'grass_block', role: 'terrain', position: { x: 3, y: 64, z: 0 } }
  ]

  const scarce = resolveMaterialSteps(steps, { dirt: 1, grass_block: 2 }, { skipVerified: false })
  assert.deepStrictEqual(scarce.resolvedRequired, { dirt: 2, grass_block: 2 })
  assert.strictEqual(scarce.steps[1].materialResolution.reason, 'no_available_terrain_alternative')
  assert.strictEqual(scarce.steps[2].resolvedBlockName, 'grass_block')
  assert.strictEqual(scarce.steps[3].resolvedBlockName, 'grass_block')

  const surplus = resolveMaterialSteps(steps, { dirt: 1, grass_block: 3 }, { skipVerified: false })
  assert.deepStrictEqual(surplus.resolvedRequired, { dirt: 1, grass_block: 3 })
  assert.strictEqual(surplus.steps[1].resolvedBlockName, 'grass_block')
  assert.strictEqual(surplus.steps[1].materialResolution.reason, 'terrain_alternative_available')
}

async function testBuildTaskStartExceptionFailsCleanly() {
  const ctx = createContext(richBuildItems())
  const task = new BuildTask({
    id: 13,
    params: {
      blueprintName: 'broken_start',
      origin: { x: 0, y: 64, z: 0 },
      buildingSystem: {
        async buildBlueprint() {
          throw new Error('staging_inventory_read_failed')
        },
        getStatus() {
          return null
        },
        async placeNextBlock() {
          throw new Error('placeNextBlock should not be called')
        }
      }
    }
  })

  await task.start(ctx)

  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.started, false)
  assert.strictEqual(task.error, 'staging_inventory_read_failed')
  assert.strictEqual(task.failedReason, 'staging_inventory_read_failed')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testOccupiedPositionClearsThenBuilds() {
  const ctx = createContext(richBuildItems(), { occupied: ['0,64,0'] })
  const task = createSyntheticBuildTask(3, { blueprintName: 'small_house', origin: { x: 0, y: 64, z: 0 } })
  await runTaskUpdate(task, ctx)
  await task.update(ctx)
  assert.strictEqual(task.state, 'RUNNING')
  assert.strictEqual(task.clearedBlocks, 1)
  assert.strictEqual(ctx.cleared[0].name, 'stone')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'oak_planks')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testDangerHighRefusesBuild() {
  const ctx = createContext(richBuildItems(), { dangerLevel: 'high' })
  const task = createSyntheticBuildTask(4, { blueprintName: 'small_house', origin: { x: 0, y: 64, z: 0 } })
  await runTaskUpdate(task, ctx)
  assert.strictEqual(task.state, 'FAILED')
  assert.strictEqual(task.error, 'danger_too_high')
}

async function testBuildIntentRules() {
  const build = parseIntent('建个小屋')
  assert.strictEqual(build.actionKey, ACTION_KEYS.BUILD)
  assert.strictEqual(build.params.blueprintName, 'small_house')

  for (const text of ['你喜欢建房子吗？', '你会不会建房子？', '建房子难吗？']) {
    const chat = parseIntent(text)
    assert.notStrictEqual(chat.actionKey, ACTION_KEYS.BUILD, text)
  }

  assert.strictEqual(parseIntent('建个围墙').params.blueprintName, 'fence_area')
  assert.strictEqual(parseIntent('围一块地').params.blueprintName, 'fence_area')
  assert.strictEqual(parseIntent('搭个箱子区').params.blueprintName, 'chest_area')
  assert.strictEqual(parseIntent('做个农田').params.blueprintName, 'farm_plot')
  assert.strictEqual(parseIntent('build modern villa').params.blueprintName, 'modern_villa')
  assert.strictEqual(parseIntent('build castle garden').params.blueprintName, 'castle_garden')
  assert.strictEqual(parseIntent('build fountain').params.blueprintName, 'fountain')
  assert.strictEqual(parseIntent('construct two story wood house').params.blueprintName, 'two_story_wood_house')
  const ordinaryBuild = parseIntent('build two story wood house')
  assert.strictEqual(ordinaryBuild.params.blueprintName, 'two_story_wood_house')
  assert.notStrictEqual(ordinaryBuild.params.forceRebuild, true)
  const explicitRebuild = parseIntent('rebuild two story wood house')
  assert.strictEqual(explicitRebuild.params.blueprintName, 'two_story_wood_house')
  assert.strictEqual(explicitRebuild.params.forceRebuild, true)
  assert.strictEqual(explicitRebuild.params.rebuildReason, 'explicit_rebuild_requested')
  assert.strictEqual(explicitRebuild.params.complexityTier, undefined)
  assert.strictEqual(explicitRebuild.params.designSpec, undefined)
}

async function testMemoryWriteOnComplete() {
  const blueprint = {
    name: 'one_block',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'oak_planks' }]
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-blueprints-'))
  fs.writeFileSync(path.join(dir, 'one_block.json'), JSON.stringify(blueprint), 'utf8')
  const ctx = createContext([{ name: 'oak_planks', count: 1 }])
  const task = createSyntheticBuildTask(5, {
    blueprintName: 'one_block',
    origin: { x: 0, y: 64, z: 0 },
    buildingOptions: { blueprintDir: dir }
  })

  await runTaskUpdate(task, ctx)
  await task.update(ctx)
  assert.strictEqual(task.state, 'COMPLETED')
  assert.strictEqual(ctx.memory.world.summary().builtStructures, 1)
}

async function testPreviewBlueprint() {
  const ctx = createContext(richBuildItems())
  const system = createSyntheticBuildingSystem()
  const preview = system.previewBlueprint(ctx, 'small_house', { x: 0, y: 64, z: 0 })
  assert.strictEqual(preview.ok, true)
  assert.strictEqual(preview.canBuild, true)
  assert.strictEqual(preview.reason, null)
  assert.ok(preview.totalBlocks > 26)
  assert.strictEqual(preview.designPlan.transformed, true)
  assert.strictEqual(preview.designPlan.style, 'wood')
  assert.strictEqual(preview.designPlan.metrics.pureBox, false)
  assert.ok(preview.designPlan.metrics.roofLevels.length >= 2)
  assert.strictEqual(preview.designSpec.frozen, true)
  for (const field of REQUIRED_DESIGN_SPEC_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(preview.designSpec, field), `missing DesignSpec field ${field}`)
  }
  assert.ok(preview.designSpec.buildingType.includes('house'), preview.designSpec.buildingType)
  assert.strictEqual(preview.designSpec.style, 'wood')
  assert.ok(preview.designSpec.width > 0)
  assert.ok(preview.designSpec.depth > 0)
  assert.ok(preview.designSpec.height > 0)
  assert.ok(preview.designSpec.revision.startsWith('design_rev_'))
  assert.strictEqual(preview.blueprintFreeze.frozen, true)
  assert.strictEqual(preview.blueprintFreeze.designSpecRevision, preview.designSpec.revision)
  assert.strictEqual(preview.blueprintIR.metadata.frozen, true)
  assert.strictEqual(preview.blueprintIR.metadata.blueprintFreeze.designSpecHash, preview.designSpec.hash)
  assert.strictEqual(preview.aestheticPlan.accepted, true)
  assert.ok(preview.aestheticPlan.initial.aesthetic_score < preview.aestheticPlan.final.aesthetic_score)
  assert.ok(preview.aestheticPlan.final.aesthetic_score >= preview.aestheticPlan.threshold)
  assert.ok(preview.aestheticPlan.final.similarity_to_good_builds >= preview.aestheticPlan.similarityThreshold)
  assert.ok(preview.aestheticPlan.refinement.iterations >= 1)
  assert.ok(preview.aestheticPlan.contrast)
  assert.ok(preview.aestheticPlan.contrast.oldProceduralOutput)
  assert.ok(preview.aestheticPlan.contrast.importedCommunitySample)
  assert.ok(preview.aestheticPlan.contrast.communityGuidedAdaptedOutput)
  assert.strictEqual(preview.aestheticPlan.contrast.oldProceduralOutput.aestheticScore, preview.aestheticPlan.initial.aesthetic_score)
  assert.strictEqual(preview.aestheticPlan.contrast.communityGuidedAdaptedOutput.aestheticScore, preview.aestheticPlan.final.aesthetic_score)
  for (const entry of [
    preview.aestheticPlan.contrast.oldProceduralOutput,
    preview.aestheticPlan.contrast.importedCommunitySample,
    preview.aestheticPlan.contrast.communityGuidedAdaptedOutput
  ]) {
    assert.ok(entry.enclosure)
    assert.ok(entry.materialCoherence)
    assert.ok(entry.structuralComplexity)
    assert.ok(Object.prototype.hasOwnProperty.call(entry, 'usableFloorArea'))
    assert.ok(Object.prototype.hasOwnProperty.call(entry, 'roofCoverage'))
  }
}

async function testPreviewIgnoresBuilderEntityInFootprint() {
  const ctx = createContext(richBuildItems())
  ctx.bot.username = 'LinXia'
  ctx.bot.entity.id = 42
  ctx.bot.entity.username = 'LinXia'
  ctx.bot.entities = {
    42: {
      id: 42,
      username: 'LinXia',
      type: 'player',
      width: 0.6,
      height: 1.8,
      position: vec(0.5, 64, 0.5)
    }
  }

  const system = createSyntheticBuildingSystem()
  const preview = system.previewBlueprint(ctx, 'small_house', { x: 0, y: 64, z: 0 })

  assert.strictEqual(preview.ok, true)
  assert.strictEqual(preview.canBuild, true)
  assert.deepStrictEqual(preview.sitePlan.entityObstructions, [])
  assert.ok(!preview.blockedReasons.some(reason => reason.startsWith('entity_obstruction:LinXia')))
}

async function testPreviewCommunityBlueprintWithInterior() {
  const ctx = createContext(richBuildItems())
  const cache = createCommunityCache([{
    id: 'test-preview-modern-villa',
    blueprint: communityVillaBlueprint(),
    style: 'modern',
    buildingType: 'modern_villa',
    requiredStories: 2
  }])
  const system = createSyntheticBuildingSystem({
    selector: new BlueprintSelector({
      index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
    })
  })
  const preview = system.previewBlueprint(ctx, 'modern_villa', { x: 0, y: 64, z: 0 })
  assert.strictEqual(preview.ok, true)
  assert.strictEqual(preview.selectedBlueprint.sourceKind, 'real_community_import')
  assert.strictEqual(preview.selectedBlueprint.sourceMode, 'faithful-community-import')
  assert.strictEqual(preview.designPlan.transformed, false)
  assert.strictEqual(preview.designPlan.layer, 'faithful_community_import')
  assert.strictEqual(preview.layoutPlan.enabled, false)
  assert.strictEqual(preview.interiorPlan.enabled, false)
  assert.strictEqual(preview.aestheticPlan.accepted, true)
  assert.strictEqual(preview.aestheticPlan.skipped, true)
  assert.strictEqual(preview.faithfulValidation.ok, true)
  assert.ok(preview.totalBlocks > 1000)
  assert.ok(preview.orderPlan.summary.totalSteps > 0)
}

async function testSiteScanPlansObstructionsAndSkipsCorrectBlocks() {
  const ctx = createContext(
    [{ name: 'oak_planks', count: 4 }, { name: 'stone_pickaxe', count: 1 }],
    {
      equipmentSystem: new EquipmentSystem(),
      occupied: [
        { x: 0, y: 64, z: 0, name: 'oak_planks' },
        { x: 1, y: 64, z: 0, name: 'stone' }
      ]
    }
  )
  const worldBlocks = [
    { type: 'oak_planks', position: { x: 0, y: 64, z: 0 } },
    { type: 'oak_planks', position: { x: 1, y: 64, z: 0 } },
    { type: 'oak_planks', position: { x: 2, y: 64, z: 0 } }
  ]
  const sitePlan = createSitePlan(ctx, worldBlocks)
  const materialPlan = planMaterials(ctx, { oak_planks: 3 }, sitePlan)
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })

  assert.strictEqual(sitePlan.correct.length, 1)
  assert.strictEqual(sitePlan.obstructions.length, 1)
  assert.strictEqual(sitePlan.placements.length, 2)
  assert.strictEqual(orderPlan.summary.clear, 1)
  assert.strictEqual(orderPlan.summary.place, 2)
}

function testSurfaceDirtAndGrassAreStableEquivalentOnlyAtBuildOrigin() {
  const origin = { x: 0, y: 64, z: 0 }
  const target = { x: 0, y: 64, z: 0 }
  const ctx = createContext([], {
    occupied: [{ ...target, name: 'grass_block' }]
  })
  const worldBlocks = [{ type: 'dirt', position: target }]

  const exactWithoutOrigin = createSitePlan(ctx, worldBlocks)
  assert.strictEqual(exactWithoutOrigin.correct.length, 0)
  assert.strictEqual(exactWithoutOrigin.obstructions.length, 1)

  const stableSurface = createSitePlan(ctx, worldBlocks, { origin })
  assert.strictEqual(stableSurface.correct.length, 0)
  assert.strictEqual(stableSurface.placements.length, 1)
  assert.strictEqual(stableSurface.obstructions.length, 1)
  assert.strictEqual(validateBuild(ctx, worldBlocks, [], { origin }).ok, true)

  const reconciled = buildingSystemTest.reconciledStepStatus(ctx, {
    id: 'surface-dirt',
    kind: 'place',
    position: target,
    blockName: 'dirt'
  }, {}, { origin, steps: [], runSteps: {} })
  assert.strictEqual(reconciled, 'verified')

  const dirtCtx = createContext([], {
    occupied: [{ ...target, name: 'dirt' }]
  })
  const grassWorldBlocks = [{ type: 'grass_block', position: target }]
  const stableDirtSurface = createSitePlan(dirtCtx, grassWorldBlocks, { origin })
  assert.strictEqual(stableDirtSurface.correct.length, 0)
  assert.strictEqual(stableDirtSurface.placements.length, 1)
  assert.strictEqual(stableDirtSurface.obstructions.length, 1)
  assert.strictEqual(validateBuild(dirtCtx, grassWorldBlocks, [], { origin }).ok, true)
  assert.strictEqual(buildingSystemTest.reconciledStepStatus(dirtCtx, {
    id: 'surface-grass',
    kind: 'place',
    position: target,
    blockName: 'grass_block'
  }, {}, { origin, steps: [], runSteps: {} }), 'verified')

  const elevatedTarget = { x: 0, y: 65, z: 0 }
  const elevatedCtx = createContext([], {
    occupied: [{ ...elevatedTarget, name: 'grass_block' }]
  })
  const elevated = buildingSystemTest.reconciledStepStatus(elevatedCtx, {
    id: 'structural-dirt',
    kind: 'place',
    position: elevatedTarget,
    blockName: 'dirt'
  }, {}, { origin, steps: [], runSteps: {} })
  assert.strictEqual(elevated, 'repair')

  const elevatedDirtCtx = createContext([], {
    occupied: [{ ...elevatedTarget, name: 'dirt' }]
  })
  assert.strictEqual(buildingSystemTest.reconciledStepStatus(elevatedDirtCtx, {
    id: 'structural-grass',
    kind: 'place',
    position: elevatedTarget,
    blockName: 'grass_block'
  }, {}, { origin, steps: [], runSteps: {} }), 'repair')
}

function testSitePlanAndFinalValidationAcceptLegacyWallSkullVariant() {
  const target = { x: 4, y: 70, z: -2 }
  const ctx = createContext([], {
    occupied: [{ ...target, name: 'skeleton_wall_skull' }]
  })
  const worldBlocks = [{
    type: 'skeleton_skull',
    position: target,
    states: { legacyId: '144', legacyData: '4' }
  }]
  const sitePlan = createSitePlan(ctx, worldBlocks)
  assert.strictEqual(sitePlan.correct.length, 1)
  assert.strictEqual(sitePlan.placements.length, 0)
  assert.strictEqual(sitePlan.obstructions.length, 0)
  assert.strictEqual(validateBuild(ctx, worldBlocks, []).ok, true)
}

function testResumeReconciliationIgnoresClassicSchematicProvenanceStates() {
  const origin = { x: 0, y: 64, z: 0 }
  const target = { x: 0, y: 64, z: 0 }
  const ctx = createContext([], {
    occupied: [{ ...target, name: 'dirt', states: {} }]
  })
  const status = buildingSystemTest.reconciledStepStatus(ctx, {
    id: 'legacy-dirt-provenance',
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dirt',
    states: { legacyId: '3', legacyData: '0' },
    orientation: { legacyId: '3', legacyData: '0' }
  }, {}, { origin, steps: [], runSteps: {} })
  assert.strictEqual(status, 'verified')
}

async function testBuildOrderClearsObstructionColumnsTopDown() {
  const ctx = createContext([])
  const sitePlan = {
    placements: [],
    obstructions: [
      { position: { x: 4, y: 64, z: -1 }, current: 'grass_block', type: 'oak_planks' },
      { position: { x: 2, y: 73, z: -1 }, current: 'dirt', type: 'spruce_trapdoor' },
      { position: { x: 2, y: 77, z: -1 }, current: 'dirt', type: 'dark_oak_trapdoor' },
      { position: { x: 2, y: 74, z: -1 }, current: 'dirt', type: 'spruce_wall_sign' }
    ],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: 2, maxX: 4, minY: 64, maxY: 77, minZ: -1, maxZ: -1 }
  }
  const orderPlan = planBuildOrder([], sitePlan, { foundationMaterial: null, scaffoldMaterial: null }, ctx, {
    origin: { x: 0, y: 64, z: 0 }
  })
  const columnClears = orderPlan.steps
    .filter(step => step.kind === 'clear' && step.position.x === 2 && step.position.z === -1)
    .map(step => step.position.y)

  assert.deepStrictEqual(columnClears, [77, 74, 73])
}

async function testSiteScanTreatsWaterAsReplaceableForSolidTargets() {
  const ctx = createContext([{ name: 'oak_planks', count: 1 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'water' }]
  })
  const worldBlocks = [
    { type: 'oak_planks', position: { x: 0, y: 64, z: 0 } }
  ]
  const sitePlan = createSitePlan(ctx, worldBlocks)
  const materialPlan = planMaterials(ctx, { oak_planks: 1 }, sitePlan)
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })

  assert.strictEqual(sitePlan.blockedReasons.length, 0)
  assert.strictEqual(sitePlan.hazards.length, 0)
  assert.strictEqual(sitePlan.obstructions.length, 0)
  assert.strictEqual(sitePlan.placements.length, 1)
  assert.strictEqual(orderPlan.summary.clear, 0)
  assert.strictEqual(orderPlan.summary.place, 1)
}

async function testSiteMaterialPlanCountsPottedPlantItems() {
  const ctx = createContext([])
  const worldBlocks = [
    { type: 'potted_cornflower', position: { x: 0, y: 64, z: 0 } },
    { type: 'potted_flowering_azalea_bush', position: { x: 1, y: 64, z: 0 } }
  ]
  const sitePlan = createSitePlan(ctx, worldBlocks)
  const materialPlan = planMaterials(ctx, {}, sitePlan)

  assert.strictEqual(materialPlan.formalRequiredMaterials.flower_pot, 2)
  assert.strictEqual(materialPlan.formalRequiredMaterials.cornflower, 1)
  assert.strictEqual(materialPlan.formalRequiredMaterials.flowering_azalea, 1)
  assert.ok(materialPlan.missingMaterials.some(item => item.item === 'cornflower'))
}

async function testFoundationFillPlanForAirUnderBlueprint() {
  const ctx = createContext([{ name: 'dirt', count: 2 }, { name: 'oak_planks', count: 1 }], {
    airBlocks: ['0,63,0']
  })
  const worldBlocks = [{ type: 'oak_planks', position: { x: 0, y: 64, z: 0 } }]
  const sitePlan = createSitePlan(ctx, worldBlocks)
  const materialPlan = planMaterials(ctx, { oak_planks: 1 }, sitePlan)
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })

  assert.strictEqual(sitePlan.foundationFills.length, 1)
  assert.strictEqual(materialPlan.foundationMaterial, 'dirt')
  assert.strictEqual(orderPlan.summary.foundation, 1)
}

async function testBuildOrderDelaysTemporarilyUnsupportedBlocks() {
  const ctx = createContext([{ name: 'oak_planks', count: 3 }])
  const worldBlocks = [
    { type: 'oak_planks', position: { x: 1, y: 64, z: 0 } },
    { type: 'oak_planks', position: { x: 0, y: 65, z: 0 }, phase: 'roof_low' },
    { type: 'oak_planks', position: { x: 1, y: 65, z: 0 }, phase: 'roof_support' }
  ]
  const sitePlan = {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: 0, maxX: 1, minY: 64, maxY: 65, minZ: 0, maxZ: 0 }
  }
  const materialPlan = { foundationMaterial: null, scaffoldMaterial: null }
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })
  const placeSteps = orderPlan.steps.filter(step => step.kind === 'place')
  const lowRoofIndex = placeSteps.findIndex(step => step.position.x === 0 && step.position.y === 65)
  const supportIndex = placeSteps.findIndex(step => step.position.x === 1 && step.position.y === 65)

  assert.ok(supportIndex >= 0)
  assert.ok(lowRoofIndex >= 0)
  assert.ok(supportIndex < lowRoofIndex)

  const footprintWorldBlocks = [
    { type: 'oak_planks', position: { x: 0, y: 64, z: 0 } },
    { type: 'oak_planks', position: { x: 1, y: 64, z: 0 } }
  ]
  const footprintSitePlan = {
    placements: footprintWorldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: 0, maxX: 1, minY: 64, maxY: 64, minZ: 0, maxZ: 0 }
  }
  const footprintOrder = planBuildOrder(footprintWorldBlocks, footprintSitePlan, materialPlan, ctx, {
    origin: { x: 0, y: 64, z: 0 },
    avoidInitialFootprint: true
  })
  const firstPlace = footprintOrder.steps.find(step => step.kind === 'place')
  assert.deepStrictEqual(firstPlace.position, { x: 1, y: 64, z: 0 })

  const doorwayRoofBlocks = [
    { type: 'oak_planks', position: { x: 0, y: 65, z: 0 }, phase: 'wall' },
    { type: 'oak_door', position: { x: 1, y: 65, z: 0 }, phase: 'path' },
    { type: 'oak_planks', position: { x: 0, y: 66, z: 0 }, phase: 'roof_high' },
    { type: 'oak_planks', position: { x: 1, y: 66, z: 0 }, phase: 'roof_high' }
  ]
  const doorwayRoofPlan = planBuildOrder(doorwayRoofBlocks, {
    placements: doorwayRoofBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: 0, maxX: 1, minY: 65, maxY: 66, minZ: 0, maxZ: 0 }
  }, materialPlan, ctx, { origin: { x: 1, y: 64, z: 0 } })
  const doorwayRoofSteps = doorwayRoofPlan.steps.filter(step => step.kind === 'place')
  const solidRoofIndex = doorwayRoofSteps.findIndex(step => step.position.x === 0 && step.position.y === 66)
  const overDoorRoofIndex = doorwayRoofSteps.findIndex(step => step.position.x === 1 && step.position.y === 66)
  assert.ok(solidRoofIndex >= 0)
  assert.ok(overDoorRoofIndex >= 0)
  assert.ok(solidRoofIndex < overDoorRoofIndex)
}

function testStatefulSlabWaitsForPlannedPermanentReference() {
  const support = {
    id: 'planned-wall-support',
    kind: 'place',
    phase: 'wall',
    position: { x: 4, y: 70, z: 2 },
    blockName: 'andesite_wall',
    states: { up: 'true' },
    dependencies: []
  }
  const slab = {
    id: 'planned-bottom-slab',
    kind: 'place',
    phase: 'frame',
    position: { x: 4, y: 71, z: 2 },
    blockName: 'cobblestone_slab',
    states: { type: 'bottom', waterlogged: 'false' },
    dependencies: []
  }
  const patched = buildingSystemTest.applyPhysicalSupportDependencies({
    orderPlan: { steps: [support, slab] }
  })
  const [patchedSupport, patchedSlab] = patched.orderPlan.steps

  assert.deepStrictEqual(patchedSlab.dependencies, [patchedSupport.id])
  assert.strictEqual(patchedSlab.phase, 'wall')

  const runSteps = {
    [patchedSupport.id]: { id: patchedSupport.id, status: 'pending', dependencies: [] },
    [patchedSlab.id]: {
      id: patchedSlab.id,
      status: 'pending',
      dependencies: [...patchedSlab.dependencies]
    }
  }
  const session = {
    steps: patched.orderPlan.steps,
    constructionRun: { steps: runSteps }
  }
  const executionOrder = []
  for (let attempt = 0; attempt < patched.orderPlan.steps.length; attempt++) {
    const index = buildingSystemTest.nextExecutableStepIndex(session)
    const selected = session.steps[index]
    executionOrder.push(selected.id)
    runSteps[selected.id].status = 'verified'
  }

  assert.deepStrictEqual(executionOrder, [patchedSupport.id, patchedSlab.id])
  assert.strictEqual(
    buildingSystemTest.nextExecutableStepIndex(session),
    patched.orderPlan.steps.length,
    'verified support must unblock the slab without a defer loop'
  )
}

function testStatefulSlabDependencyKeepsTopPathAndHandlesDoubleSlab() {
  const topSupport = {
    id: 'top-slab-below',
    kind: 'place',
    phase: 'wall',
    position: { x: 8, y: 70, z: 2 },
    blockName: 'stone',
    dependencies: []
  }
  const topSlab = {
    id: 'top-slab',
    kind: 'place',
    phase: 'frame',
    position: { x: 8, y: 71, z: 2 },
    blockName: 'stone_slab',
    states: { type: 'top' },
    dependencies: []
  }
  const doubleSupport = {
    id: 'double-slab-below',
    kind: 'place',
    phase: 'wall',
    position: { x: 9, y: 70, z: 2 },
    blockName: 'stone',
    dependencies: []
  }
  const doubleSlab = {
    id: 'double-slab',
    kind: 'place',
    phase: 'frame',
    position: { x: 9, y: 71, z: 2 },
    blockName: 'stone_slab',
    states: { type: 'double' },
    dependencies: []
  }
  const patched = buildingSystemTest.applyPhysicalSupportDependencies({
    orderPlan: { steps: [topSupport, topSlab, doubleSupport, doubleSlab] }
  })
  const patchedTop = patched.orderPlan.steps.find(step => step.id === topSlab.id)
  const patchedDouble = patched.orderPlan.steps.find(step => step.id === doubleSlab.id)

  assert.deepStrictEqual(patchedTop.dependencies, [], 'top slabs retain the side-reference placement path')
  assert.strictEqual(patchedTop.phase, 'frame')
  assert.deepStrictEqual(patchedDouble.dependencies, [doubleSupport.id])
  assert.strictEqual(patchedDouble.phase, 'wall')
}

function testHangingLanternDependencyWinsOverInvalidReverseSlabDependency() {
  const topSupport = {
    id: 'planned-bottom-slab-top-support',
    kind: 'place',
    phase: 'frame',
    position: { x: 4, y: 71, z: 2 },
    blockName: 'spruce_slab',
    states: { type: 'bottom', waterlogged: 'false' },
    // This is the obsolete edge persisted by the failing construction run.
    dependencies: ['planned-hanging-lantern']
  }
  const hangingLantern = {
    id: 'planned-hanging-lantern',
    kind: 'place',
    phase: 'frame',
    position: { x: 4, y: 70, z: 2 },
    blockName: 'lantern',
    states: { hanging: 'true', waterlogged: 'false' },
    dependencies: []
  }
  const patched = buildingSystemTest.applyPhysicalSupportDependencies({
    // The real faithful plan has the top slab earlier than the lantern.
    orderPlan: { steps: [topSupport, hangingLantern] }
  })
  const patchedSupport = patched.orderPlan.steps.find(step => step.id === topSupport.id)
  const patchedLantern = patched.orderPlan.steps.find(step => step.id === hangingLantern.id)

  assert.deepStrictEqual(
    patchedSupport.dependencies,
    [],
    'a hanging lantern cannot be the permanent below-reference for its own top support'
  )
  assert.deepStrictEqual(patchedLantern.dependencies, [patchedSupport.id])

  const runSteps = {
    [patchedSupport.id]: { id: patchedSupport.id, status: 'pending', dependencies: [] },
    [patchedLantern.id]: {
      id: patchedLantern.id,
      status: 'pending',
      dependencies: [...patchedLantern.dependencies]
    }
  }
  const session = {
    steps: patched.orderPlan.steps,
    constructionRun: { steps: runSteps }
  }
  const supportIndex = buildingSystemTest.nextExecutableStepIndex(session)
  assert.strictEqual(session.steps[supportIndex].id, patchedSupport.id)
  runSteps[patchedSupport.id].status = 'verified'
  const lanternIndex = buildingSystemTest.nextExecutableStepIndex(session)
  assert.strictEqual(session.steps[lanternIndex].id, patchedLantern.id)
}

function testLanternPhysicalDependencyProfilesRemainDistinct() {
  const belowSupport = {
    id: 'standing-lantern-below-support',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 69, z: 0 },
    blockName: 'stone',
    dependencies: []
  }
  const standingLantern = {
    id: 'standing-lantern',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 70, z: 0 },
    blockName: 'lantern',
    states: { hanging: 'false', waterlogged: 'false' },
    dependencies: []
  }
  const unrelatedTopBlock = {
    id: 'standing-lantern-top-block',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 71, z: 0 },
    blockName: 'stone',
    dependencies: []
  }
  const bottomTrapdoor = {
    id: 'hanging-lantern-bottom-trapdoor',
    kind: 'place',
    phase: 'frame',
    position: { x: 2, y: 71, z: 0 },
    blockName: 'dark_oak_trapdoor',
    states: { half: 'bottom', open: 'false' },
    dependencies: []
  }
  const hangingLantern = {
    id: 'hanging-lantern-below-trapdoor',
    kind: 'place',
    phase: 'frame',
    position: { x: 2, y: 70, z: 0 },
    blockName: 'lantern',
    states: { hanging: 'true', waterlogged: 'false' },
    dependencies: []
  }
  const missingSupportLantern = {
    id: 'hanging-lantern-without-planned-support',
    kind: 'place',
    phase: 'frame',
    position: { x: 4, y: 70, z: 0 },
    blockName: 'lantern',
    states: { hanging: 'true', waterlogged: 'false' },
    dependencies: []
  }
  const patched = buildingSystemTest.applyPhysicalSupportDependencies({
    orderPlan: {
      steps: [
        belowSupport,
        standingLantern,
        unrelatedTopBlock,
        bottomTrapdoor,
        hangingLantern,
        missingSupportLantern
      ]
    }
  })
  const byId = new Map(patched.orderPlan.steps.map(step => [step.id, step]))

  assert.deepStrictEqual(byId.get(standingLantern.id).dependencies, [belowSupport.id])
  assert.deepStrictEqual(byId.get(hangingLantern.id).dependencies, [bottomTrapdoor.id])
  assert.deepStrictEqual(byId.get(missingSupportLantern.id).dependencies, [])
}

function testHangingLanternTransformKeepsTopSupportAligned() {
  const blueprint = {
    blocks: [
      {
        key: 'lantern',
        position: { x: 1, y: 3, z: 4 },
        block: {
          id: 'lantern',
          states: { hanging: 'true', waterlogged: 'false' }
        },
        phase: 'frame'
      },
      {
        key: 'top-support',
        position: { x: 1, y: 4, z: 4 },
        block: {
          id: 'spruce_slab',
          states: { type: 'bottom', waterlogged: 'false' }
        },
        phase: 'frame'
      }
    ]
  }
  for (const placement of [
    { origin: { x: 100, y: 64, z: 200 }, rotationY: 90, mirror: { x: false, z: false } },
    { origin: { x: 100, y: 64, z: 200 }, rotationY: 0, mirror: { x: true, z: true } }
  ]) {
    const blocks = materializeBlueprintBlocks(blueprint, placement)
    const lantern = blocks.find(block => block.key === 'lantern')
    const topSupport = blocks.find(block => block.key === 'top-support')

    assert.deepStrictEqual(
      topSupport.position,
      { x: lantern.position.x, y: lantern.position.y + 1, z: lantern.position.z }
    )
    assert.strictEqual(lantern.states.hanging, 'true')
    assert.strictEqual(lantern.states.waterlogged, 'false')
    assert.strictEqual(topSupport.states.type, 'bottom')
  }
}

async function testBuildOrderDefersFluidsUntilAfterSolidPlacements() {
  const ctx = createContext([{ name: 'water_bucket', count: 1 }, { name: 'grass_block', count: 1 }, { name: 'oak_planks', count: 1 }])
  const worldBlocks = [
    { type: 'water', position: { x: 0, y: 64, z: 0 }, phase: 'frame' },
    { type: 'grass_block', position: { x: 4, y: 64, z: 0 }, phase: 'frame' },
    { type: 'oak_planks', position: { x: 1, y: 65, z: 0 }, phase: 'wall' }
  ]
  const sitePlan = {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: {
      place: [],
      remove: [{ position: { x: 2, y: 64, z: 0 } }]
    },
    correct: [],
    bounds: { minX: 0, maxX: 4, minY: 64, maxY: 65, minZ: 0, maxZ: 0 }
  }
  const materialPlan = { foundationMaterial: null, scaffoldMaterial: 'dirt' }
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })
  const waterIndex = orderPlan.steps.findIndex(step => step.kind === 'place' && step.blockName === 'water')
  const validateIndex = orderPlan.steps.findIndex(step => step.kind === 'validate')
  const scaffoldRemoveIndex = orderPlan.steps.findIndex(step => step.kind === 'scaffold_remove')
  const solidPlaceIndexes = orderPlan.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.kind === 'place' && step.blockName !== 'water')
    .map(({ index }) => index)

  assert.strictEqual(orderPlan.summary.fluidPlace, 1)
  assert.ok(waterIndex >= 0)
  assert.ok(solidPlaceIndexes.length > 0)
  assert.ok(solidPlaceIndexes.every(index => index < waterIndex))
  assert.ok(scaffoldRemoveIndex < waterIndex)
  assert.ok(waterIndex < validateIndex)
}

async function testBuildOrderPlacesEnclosedFluidBeforeDirectTopOccluder() {
  const ctx = createContext([{ name: 'water_bucket', count: 1 }, { name: 'oak_planks', count: 5 }, { name: 'spruce_slab', count: 1 }])
  const target = { x: 0, y: 64, z: 0 }
  const sidePositions = [
    { x: -1, y: 64, z: 0 },
    { x: 1, y: 64, z: 0 },
    { x: 0, y: 64, z: -1 },
    { x: 0, y: 64, z: 1 }
  ]
  const top = { x: 0, y: 65, z: 0 }
  const worldBlocks = [
    { type: 'water', position: target, phase: 'frame' },
    ...sidePositions.map(position => ({ type: 'oak_planks', position, phase: 'frame' })),
    {
      type: 'spruce_slab',
      position: top,
      phase: 'frame',
      states: { type: 'top', waterlogged: 'false' }
    }
  ]
  const sitePlan = {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: -1, maxX: 1, minY: 64, maxY: 65, minZ: -1, maxZ: 1 }
  }
  const orderPlan = planBuildOrder(
    worldBlocks,
    sitePlan,
    { foundationMaterial: null, scaffoldMaterial: null },
    ctx,
    { origin: { x: -3, y: 64, z: 0 } }
  )
  const placeSteps = orderPlan.steps.filter(step => step.kind === 'place')
  const waterIndex = placeSteps.findIndex(step =>
    step.blockName === 'water' &&
    step.position.x === target.x &&
    step.position.y === target.y &&
    step.position.z === target.z)
  const topIndex = placeSteps.findIndex(step =>
    step.position.x === top.x &&
    step.position.y === top.y &&
    step.position.z === top.z)
  const sideIndexes = sidePositions.map(position => placeSteps.findIndex(step =>
    step.position.x === position.x &&
    step.position.y === position.y &&
    step.position.z === position.z))

  assert.ok(waterIndex >= 0)
  assert.ok(topIndex >= 0)
  assert.ok(sideIndexes.every(index => index >= 0 && index < waterIndex))
  assert.ok(waterIndex < topIndex)
}

async function testBuildOrderDelaysWallSignUntilFacingSupportExists() {
  const ctx = createContext([{ name: 'dark_oak_sign', count: 1 }, { name: 'spruce_stairs', count: 1 }])
  const worldBlocks = [
    {
      type: 'dark_oak_wall_sign',
      position: { x: 0, y: 64, z: 0 },
      states: { facing: 'north' }
    },
    {
      type: 'spruce_stairs',
      position: { x: 0, y: 64, z: 1 },
      states: { facing: 'east' }
    }
  ]
  const sitePlan = {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: 0, maxX: 0, minY: 64, maxY: 64, minZ: 0, maxZ: 1 }
  }
  const materialPlan = { foundationMaterial: null, scaffoldMaterial: null }
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })
  const placeSteps = orderPlan.steps.filter(step => step.kind === 'place')
  const signIndex = placeSteps.findIndex(step => step.blockName === 'dark_oak_wall_sign')
  const supportIndex = placeSteps.findIndex(step => step.blockName === 'spruce_stairs')

  assert.ok(signIndex >= 0)
  assert.ok(supportIndex >= 0)
  assert.ok(supportIndex < signIndex)
}

async function testBuildOrderDelaysHangingLanternUntilTopSupportExists() {
  const ctx = createContext([{ name: 'lantern', count: 1 }, { name: 'stone', count: 1 }])
  const worldBlocks = [
    {
      type: 'lantern',
      position: { x: 0, y: 64, z: 0 },
      states: { hanging: 'true' }
    },
    {
      type: 'stone',
      position: { x: 0, y: 65, z: 0 }
    }
  ]
  const sitePlan = {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [{ position: { x: 1, y: 65, z: 0 }, type: 'stone' }],
    bounds: { minX: 0, maxX: 1, minY: 64, maxY: 65, minZ: 0, maxZ: 0 }
  }
  const materialPlan = { foundationMaterial: null, scaffoldMaterial: null }
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })
  const placeSteps = orderPlan.steps.filter(step => step.kind === 'place')
  const lanternIndex = placeSteps.findIndex(step => step.blockName === 'lantern')
  const supportIndex = placeSteps.findIndex(step => step.blockName === 'stone' && step.position.y === 65)

  assert.ok(lanternIndex >= 0)
  assert.ok(supportIndex >= 0)
  assert.ok(supportIndex < lanternIndex)
}

async function testBuildOrderAllowsTripwireHookFallbackSideSupport() {
  const ctx = createContext([{ name: 'tripwire_hook', count: 1 }, { name: 'dark_oak_trapdoor', count: 1 }])
  const worldBlocks = [
    {
      type: 'tripwire_hook',
      position: { x: 1, y: 64, z: 0 },
      states: { facing: 'west' }
    },
    {
      type: 'dark_oak_trapdoor',
      position: { x: 0, y: 64, z: 0 },
      states: { facing: 'east', open: 'true', half: 'bottom' }
    }
  ]
  const sitePlan = {
    placements: worldBlocks.map(block => ({ position: block.position, type: block.type })),
    obstructions: [],
    foundationFills: [],
    scaffold: { place: [], remove: [] },
    correct: [],
    bounds: { minX: 0, maxX: 1, minY: 64, maxY: 64, minZ: 0, maxZ: 0 }
  }
  const materialPlan = { foundationMaterial: null, scaffoldMaterial: null }
  const orderPlan = planBuildOrder(worldBlocks, sitePlan, materialPlan, ctx, { origin: { x: 0, y: 64, z: 0 } })
  const placeSteps = orderPlan.steps.filter(step => step.kind === 'place')
  const hookIndex = placeSteps.findIndex(step => step.blockName === 'tripwire_hook')
  const supportIndex = placeSteps.findIndex(step => step.blockName === 'dark_oak_trapdoor')

  assert.ok(hookIndex >= 0)
  assert.ok(supportIndex >= 0)
  assert.ok(supportIndex < hookIndex)
}

async function testBuildTaskFillsFoundationBeforePlacement() {
  const blueprint = {
    name: 'one_block',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'oak_planks' }]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([{ name: 'dirt', count: 1 }, { name: 'oak_planks', count: 1 }], {
    airBlocks: ['0,63,0']
  })
  const task = createSyntheticBuildTask(8, {
    blueprintName: 'one_block',
    origin: { x: 0, y: 64, z: 0 },
    buildingOptions: { blueprintDir: dir }
  })

  await runTaskUpdate(task, ctx)
  if (task.state === 'RUNNING') await task.update(ctx)
  assert.strictEqual(task.state, 'COMPLETED')
  assert.strictEqual(task.foundationBlocks, 1)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 63, 0)).name, 'dirt')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'oak_planks')
}

async function testMaterialRefillRequestsFullGapFromStorage() {
  const blueprint = {
    name: 'two_blocks',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 1, y: 0, z: 0, type: 'oak_planks' }
    ]
  }
  const dir = createBlueprintDir([blueprint])
  const items = [{ name: 'oak_planks', count: 1 }]
  const calls = []
  const storageSystem = {
    async takeItems(context, options) {
      calls.push(options)
      const existing = items.find(item => item.name === options.itemName)
      if (existing) existing.count += options.count
      else items.push({ name: options.itemName, count: options.count })
      return { ok: true, withdrawnItems: [{ itemName: options.itemName, count: options.count }] }
    }
  }
  const ctx = createContext(items, { storageSystem })
  const task = createSyntheticBuildTask(9, {
    blueprintName: 'two_blocks',
    origin: { x: 0, y: 64, z: 0 },
    buildingOptions: { blueprintDir: dir }
  })

  await runTaskUpdate(task, ctx)
  if (task.state === 'RUNNING') await task.update(ctx)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].itemName, 'oak_planks')
  assert.strictEqual(calls[0].count, 1)
  assert.strictEqual(calls[0].radius, 80)
  assert.strictEqual(calls[0].skipUtilitySearch, true)
  assert.strictEqual(calls[0].skipMemorySearch, true)
  assert.strictEqual(calls[0].scanOnlyProvidedCenters, true)
  assert.ok(calls[0].scanCenters.some(center => center.source === 'build_origin'))
  assert.ok(calls[0].scanCenters.some(center => center.source === 'build_storage_1'))
  assert.ok(calls[0].scanCenters.every(center => center.radius === 32))
  assert.strictEqual(task.state, 'COMPLETED')
}

async function testMaterialRefillCanAggregateMultipleChestSources() {
  const blueprint = {
    name: 'six_blocks',
    origin: { x: 0, y: 0, z: 0 },
    blocks: Array.from({ length: 6 }, (_, x) => ({ x, y: 0, z: 0, type: 'oak_planks' }))
  }
  const dir = createBlueprintDir([blueprint])
  const items = [{ name: 'oak_planks', count: 1 }]
  const chests = [{ oak_planks: 2 }, { oak_planks: 3 }]
  const calls = []
  const storageSystem = {
    async takeItems(context, options) {
      calls.push(options)
      const source = chests.find(candidate => (candidate[options.itemName] || 0) > 0)
      if (!source) return { ok: false, error: `chest_item_not_found:${options.itemName}` }
      for (const candidate of chests) {
        if ((candidate[options.itemName] || 0) <= 0) continue
        const available = candidate[options.itemName] || 0
        const take = Math.min(available, options.count)
        candidate[options.itemName] = available - take
        items[0].count += take
        context.bot.entity.position = vec(10 + calls.length, 64, 0)
        return { ok: true, withdrawnItems: [{ itemName: options.itemName, count: take }] }
      }
      return { ok: false, error: `chest_item_not_found:${options.itemName}` }
    }
  }
  const ctx = createContext(items, { storageSystem })
  const task = createSyntheticBuildTask(10, {
    blueprintName: 'six_blocks',
    origin: { x: 0, y: 64, z: 0 },
    buildingOptions: { blueprintDir: dir }
  })

  await runTaskUpdate(task, ctx)
  assert.strictEqual(calls.length, 2)
  assert.ok(calls.every(call => call.radius === 80))
  assert.ok(calls.every(call => call.skipUtilitySearch === true))
  assert.ok(calls.every(call => call.skipMemorySearch === true))
  assert.ok(calls.every(call => call.scanOnlyProvidedCenters === true))
  assert.ok(calls.every(call => call.scanCenters.some(center => center.source === 'build_storage_1')))
  assert.strictEqual(task.state, 'RUNNING')
  assert.strictEqual(items[0].count, 6)
  assert.deepStrictEqual(task.origin, { x: 0, y: 64, z: 0 })
  assert.strictEqual(chests[0].oak_planks, 0)
  assert.strictEqual(chests[1].oak_planks, 0)
}

async function testStagedMaterialRefillReleasesInventorySlotWhenFull() {
  const items = [
    { name: 'iron_pickaxe', count: 1 },
    { name: 'iron_axe', count: 1 },
    { name: 'iron_shovel', count: 1 },
    { name: 'dirt', count: 64 },
    ...Array.from({ length: 32 }, (_, index) => ({ name: `fixture_material_${index}`, count: 1 }))
  ]
  const storeCalls = []
  const takeCalls = []
  const storageSystem = {
    async storeItems(context, options) {
      storeCalls.push(options)
      const stored = items.find(item => item.name === options.itemName)
      assert.ok(stored, options.itemName)
      stored.count = Math.max(0, stored.count - options.count)
      const slot = context.bot.inventory.slots.findIndex((entry, index) => index >= 9 && entry?.name === options.itemName)
      if (slot >= 0) context.bot.inventory.slots[slot] = null
      return { ok: true, storedItems: [{ itemName: options.itemName, count: options.count }] }
    },
    async takeItems(context, options) {
      takeCalls.push(options)
      assert.strictEqual(storeCalls.length, 1)
      assert.strictEqual(options.itemName, 'dandelion')
      items.push({ name: 'dandelion', count: options.count })
      const emptySlot = context.bot.inventory.slots.findIndex((entry, index) => index >= 9 && !entry)
      assert.ok(emptySlot >= 9)
      context.bot.inventory.slots[emptySlot] = { name: 'dandelion', count: options.count }
      return { ok: true, withdrawnItems: [{ itemName: 'dandelion', count: options.count }] }
    }
  }
  const ctx = createContext(items, { storageSystem })
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.inventory.slots = Array.from({ length: 45 }, (_, index) => {
    if (index < 9) return null
    const item = items[index - 9]
    return item ? { name: item.name, count: item.count } : null
  })

  const system = createSyntheticBuildingSystem()
  system.session = {
    currentStepIndex: 0,
    steps: [
      { kind: 'place', phase: 'frame', position: { x: 0, y: 64, z: 0 }, blockName: 'dandelion' }
    ],
    origin: { x: 0, y: 64, z: 0 },
    reservedBounds: { minX: 0, maxX: 3, minZ: 0, maxZ: 3 },
    materialStorageAnchorRadius: 32
  }

  const result = await system.ensureMaterialItem(ctx, 'dandelion', { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storeCalls.length, 1)
  assert.strictEqual(storeCalls[0].itemName, 'dirt')
  assert.strictEqual(storeCalls[0].reason, 'building_staged_material_slot_release')
  assert.strictEqual(storeCalls[0].scanOnlyProvidedCenters, true)
  assert.strictEqual(storeCalls[0].skipUtilitySearch, true)
  assert.strictEqual(storeCalls[0].skipMemorySearch, true)
  assert.strictEqual(takeCalls.length, 1)
  assert.strictEqual(takeCalls[0].reason, 'building_staged_material_refill_primary')
  assert.strictEqual(ctx.bot.inventory.items().some(item => item.name === 'dandelion'), true)
}

function setupInventoryBatchSession(system, steps, options = {}) {
  const primaryStagingChests = options.primaryStagingChests || [{
    source: 'primary_near_site_staging_1',
    position: { x: 6, y: 64, z: 0 },
    primary: true
  }]
  const secondaryStagingChests = options.secondaryStagingChests || [{
    source: 'build_storage_1',
    position: { x: 20, y: 64, z: 0 },
    secondary: true,
    primary: false
  }]
  system.session = {
    currentStepIndex: 0,
    steps,
    origin: { x: 0, y: 64, z: 0 },
    reservedBounds: { minX: 0, maxX: 4, minZ: 0, maxZ: 4 },
    constructionRunId: 'construction_run_batch_test',
    constructionRun: {
      runId: 'construction_run_batch_test',
      steps: Object.fromEntries(steps.map(step => [step.id, { id: step.id, status: 'pending' }])),
      primaryStagingChests,
      secondaryStagingChests,
      stagingChests: [...primaryStagingChests, ...secondaryStagingChests],
      currentPhase: 'frame',
      status: 'ACTIVE'
    }
  }
}

function createBatchStorageMock(items, primaryCounts = {}, secondaryCounts = {}) {
  const calls = []
  const storageSystem = {
    calls,
    async takeItems(context, options) {
      calls.push(options)
      const isSecondary = (options.scanCenters || []).some(center => center.secondary === true || center.source === 'build_storage_1')
      const source = isSecondary ? secondaryCounts : primaryCounts
      const available = Number(source[options.itemName]) || 0
      const openedChests = (options.scanCenters || []).map(center => center.position)
      if (available <= 0) {
        return {
          ok: false,
          error: `chest_item_not_found:${options.itemName}`,
          openSummary: { openedChests, openCount: openedChests.length }
        }
      }
      const moved = Math.min(available, options.count)
      source[options.itemName] = available - moved
      const existing = items.find(item => item.name === options.itemName)
      if (existing) existing.count += moved
      else items.push({ name: options.itemName, count: moved })
      return {
        ok: true,
        withdrawnItems: [{ itemName: options.itemName, count: moved }],
        targetChest: { position: openedChests[0] },
        openSummary: { openedChests: openedChests.slice(0, 1), openCount: 1 }
      }
    }
  }
  return storageSystem
}

function oakPlankSteps(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `batch_oak_${index}`,
    kind: 'place',
    phase: 'frame',
    position: { x: index, y: 64, z: 0 },
    blockName: 'oak_planks',
    dependencies: []
  }))
}

async function testInventoryBatchUsesOnlyPrimaryWhenPrimaryEnough() {
  const items = []
  const storageSystem = createBatchStorageMock(items, { oak_planks: 5 }, { oak_planks: 5 })
  const ctx = createContext(items, { storageSystem })
  const system = createSyntheticBuildingSystem()
  const steps = oakPlankSteps(3)
  setupInventoryBatchSession(system, steps)

  const result = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageSystem.calls.length, 1)
  assert.strictEqual(storageSystem.calls[0].reason, 'building_inventory_batch_primary')
  assert.strictEqual(storageSystem.calls[0].scanCenters.length, 1)
  assert.strictEqual(storageSystem.calls[0].scanCenters[0].source, 'primary_near_site_staging_1')
  assert.strictEqual(items.find(item => item.name === 'oak_planks').count, 3)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.plannedSteps.length, 3)
}

async function testInventoryBatchFallsBackToSecondaryOnlyOnPrimaryShortage() {
  const items = []
  const storageSystem = createBatchStorageMock(items, { oak_planks: 0 }, { oak_planks: 4 })
  const ctx = createContext(items, { storageSystem })
  const system = createSyntheticBuildingSystem()
  const steps = oakPlankSteps(2)
  setupInventoryBatchSession(system, steps)

  const result = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageSystem.calls.length, 2)
  assert.strictEqual(storageSystem.calls[0].reason, 'building_inventory_batch_primary')
  assert.strictEqual(storageSystem.calls[0].scanCenters[0].source, 'primary_near_site_staging_1')
  assert.strictEqual(storageSystem.calls[1].reason, 'building_inventory_batch_secondary_shortage')
  assert.strictEqual(storageSystem.calls[1].scanCenters[0].source, 'build_storage_1')
  assert.strictEqual(items.find(item => item.name === 'oak_planks').count, 2)
}

async function testInventoryBatchReservesOneRetryItemForRepairPlacements() {
  const items = []
  const storageSystem = createBatchStorageMock(items, { dark_oak_slab: 3 }, {})
  const ctx = createContext(items, { storageSystem })
  const system = createSyntheticBuildingSystem()
  const steps = [
    { id: 'repair_slab_a', kind: 'place', phase: 'frame', position: { x: 0, y: 64, z: 0 }, blockName: 'dark_oak_slab', dependencies: [] },
    { id: 'repair_slab_b', kind: 'place', phase: 'frame', position: { x: 1, y: 64, z: 0 }, blockName: 'dark_oak_slab', dependencies: [] }
  ]
  setupInventoryBatchSession(system, steps)
  system.session.constructionRun.steps.repair_slab_a.status = 'state_repair'
  system.session.constructionRun.steps.repair_slab_b.status = 'state_repair'

  const result = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageSystem.calls.length, 1)
  assert.strictEqual(storageSystem.calls[0].count, 3)
  assert.strictEqual(items.find(item => item.name === 'dark_oak_slab').count, 3)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.requiredMaterials.dark_oak_slab, 3)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.repairRetryReserve.dark_oak_slab, 1)
}

async function testInventoryBatchSkipsChestWhenInventorySatisfiesPlan() {
  const items = [{ name: 'oak_planks', count: 3 }]
  const storageSystem = createBatchStorageMock(items, { oak_planks: 10 }, { oak_planks: 10 })
  const ctx = createContext(items, { storageSystem })
  const system = createSyntheticBuildingSystem()
  const steps = oakPlankSteps(3)
  setupInventoryBatchSession(system, steps)

  const result = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageSystem.calls.length, 0)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.materialsNeeded.oak_planks, undefined)
}

async function testInventoryBatchDoesNotReopenWithinSameBatch() {
  const items = []
  const storageSystem = createBatchStorageMock(items, { oak_planks: 5 }, { oak_planks: 5 })
  const ctx = createContext(items, { storageSystem })
  const system = createSyntheticBuildingSystem()
  const steps = oakPlankSteps(4)
  setupInventoryBatchSession(system, steps)

  const first = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })
  system.session.currentStepIndex = 1
  const second = await system.ensureInventoryBatchReady(ctx, steps[1], { owner: 'test' })

  assert.strictEqual(first.ok, true, first.error)
  assert.strictEqual(second.ok, true, second.error)
  assert.strictEqual(second.cached, true)
  assert.strictEqual(storageSystem.calls.length, 1)
}

async function testInventoryBatchMergesNextHundredStepsAndPreservesEmptySlots() {
  const items = []
  const storageSystem = createBatchStorageMock(items, { oak_planks: 200 }, {})
  const ctx = createContext(items, { storageSystem })
  ctx.bot.inventory.slots = Array.from({ length: 45 }, (_, index) => {
    if (index < 9) return null
    return index < 12 ? null : { name: `filler_${index}`, count: 1 }
  })
  const system = createSyntheticBuildingSystem()
  const steps = oakPlankSteps(120)
  setupInventoryBatchSession(system, steps)

  const result = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageSystem.calls.length, 1)
  assert.strictEqual(storageSystem.calls[0].count, 64)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.requiredMaterials.oak_planks, 100)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.reservedSlots.empty, 2)
  assert.strictEqual(system.session.constructionRun.batchMaterialPlan.withdrawals[0].count, 64)
}

async function testInventoryBatchPrioritizesCurrentStepMaterialWhenSlotsLimited() {
  const items = []
  const primaryCounts = {
    furnace: 1,
    chest: 5,
    barrel: 4,
    blast_furnace: 1,
    brewing_stand: 1,
    cake: 1,
    ender_chest: 1
  }
  const storageSystem = createBatchStorageMock(items, primaryCounts, {})
  const ctx = createContext(items, { storageSystem })
  ctx.bot.inventory.slots = Array.from({ length: 45 }, (_, index) => {
    if (index < 9) return null
    return index < 11 ? null : { name: `filler_${index}`, count: 1 }
  })
  const system = createSyntheticBuildingSystem()
  const steps = [
    { id: 'functional_furnace', kind: 'place', phase: 'functional_blocks', position: { x: 0, y: 64, z: 0 }, blockName: 'furnace', dependencies: [] },
    { id: 'functional_chest', kind: 'place', phase: 'functional_blocks', position: { x: 1, y: 64, z: 0 }, blockName: 'chest', dependencies: [] },
    { id: 'functional_barrel', kind: 'place', phase: 'functional_blocks', position: { x: 2, y: 64, z: 0 }, blockName: 'barrel', dependencies: [] },
    { id: 'functional_blast_furnace', kind: 'place', phase: 'functional_blocks', position: { x: 3, y: 64, z: 0 }, blockName: 'blast_furnace', dependencies: [] },
    { id: 'functional_brewing_stand', kind: 'place', phase: 'functional_blocks', position: { x: 4, y: 64, z: 0 }, blockName: 'brewing_stand', dependencies: [] },
    { id: 'functional_cake', kind: 'place', phase: 'functional_blocks', position: { x: 5, y: 64, z: 0 }, blockName: 'cake', dependencies: [] },
    { id: 'functional_ender_chest', kind: 'place', phase: 'functional_blocks', position: { x: 6, y: 64, z: 0 }, blockName: 'ender_chest', dependencies: [] }
  ]
  setupInventoryBatchSession(system, steps)

  const result = await system.ensureInventoryBatchReady(ctx, steps[0], { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.plan.withdrawals[0].item, 'furnace')
  assert.strictEqual(storageSystem.calls[0].itemName, 'furnace')
  assert.strictEqual(items.some(item => item.name === 'furnace' && item.count === 1), true)
}

async function testEnsureMaterialItemUsesBatchBeforeLegacyRefill() {
  const items = []
  const storageSystem = createBatchStorageMock(items, { oak_planks: 2 }, { oak_planks: 2 })
  const ctx = createContext(items, { storageSystem })
  const system = createSyntheticBuildingSystem()
  const steps = oakPlankSteps(1)
  setupInventoryBatchSession(system, steps)

  const result = await system.ensureMaterialItem(ctx, 'oak_planks', { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageSystem.calls.length, 1)
  assert.strictEqual(storageSystem.calls[0].reason, 'building_inventory_batch_primary')
  assert.strictEqual(storageSystem.calls[0].scanCenters[0].source, 'primary_near_site_staging_1')
}

async function testEnsureMaterialUsesHeldItemWhenInventoryListOmitsIt() {
  const ctx = createContext([])
  let storageCalled = false

  ctx.bot.heldItem = { name: 'water_bucket', count: 1 }
  ctx.bot.inventory.items = () => []
  ctx.storageSystem = {
    async takeItems() {
      storageCalled = true
      return { ok: false, error: 'unexpected_storage_call' }
    }
  }

  const system = createSyntheticBuildingSystem()
  system.session = {
    currentStepIndex: 0,
    steps: [
      { kind: 'place', phase: 'frame', position: { x: 0, y: 64, z: 0 }, blockName: 'water' }
    ],
    origin: { x: 0, y: 64, z: 0 },
    reservedBounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
    materialStorageAnchorRadius: 32
  }

  const result = await system.ensureMaterialItem(ctx, 'water_bucket', { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(storageCalled, false)
}

function configureBuildingWaterPlacementFixture(ctx, items, target, options = {}) {
  let waterLevel = null
  let activationCount = 0
  const originalBlockAt = ctx.bot.blockAt.bind(ctx.bot)
  const keyFor = position => `${position.x},${position.y},${position.z}`
  const targetKey = keyFor(target)
  const below = { x: target.x, y: target.y - 1, z: target.z }
  const belowKey = keyFor(below)
  const topKey = keyFor({ x: target.x, y: target.y + 1, z: target.z })
  const sideKeys = new Set([
    `${target.x + 1},${target.y},${target.z}`,
    `${target.x - 1},${target.y},${target.z}`,
    `${target.x},${target.y},${target.z + 1}`,
    `${target.x},${target.y},${target.z - 1}`
  ])

  ctx.bot.entity.position = vec(target.x + 0.5, target.y + 1, target.z - 0.5)
  ctx.bot.entity.onGround = true
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.blockAt = position => {
    const key = keyFor(position)
    if (key === targetKey) {
      if (waterLevel == null) return { name: 'air', position }
      return {
        name: 'water',
        position,
        getProperties: () => ({ level: waterLevel })
      }
    }
    if (key === belowKey) return { name: 'stone', position }
    if (key === topKey) return { name: 'spruce_slab', position }
    if (sideKeys.has(key)) return { name: 'stone', position }
    return originalBlockAt(position)
  }
  ctx.bot.world = {
    raycast() {
      return { position: vec(below.x, below.y, below.z) }
    }
  }
  ctx.bot.lookAt = async (position, force) => {
    assert.strictEqual(force, false)
  }
  ctx.bot.clearControlStates = () => {}
  ctx.bot.activateItem = async () => {
    activationCount += 1
    const bucket = items.find(item => item.name === 'water_bucket' && item.count > 0)
    assert.ok(bucket, 'activation must hold a staged water bucket')
    bucket.count -= 1
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
    if (activationCount > Number(options.failedActivations || 0)) waterLevel = 0
  }

  return {
    activationCount: () => activationCount,
    waterLevel: () => waterLevel
  }
}

async function testWaterPlacementConsumedBucketCanRefillAndRetry() {
  const items = [{ name: 'water_bucket', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 64, z: 0 }
  const fixture = configureBuildingWaterPlacementFixture(ctx, items, target, {
    failedActivations: 1
  })
  let storageCalls = 0
  ctx.storageSystem = {
    async takeItems(context, options) {
      storageCalls += 1
      assert.strictEqual(options.itemName, 'water_bucket')
      items[0].count += 1
      return { ok: true, withdrawnItems: [{ itemName: 'water_bucket', count: 1 }] }
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'interior',
    position: target,
    blockName: 'water',
    states: { level: '0' }
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    consumedItemRefillRetries: 2
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(fixture.activationCount(), 2)
  assert.strictEqual(storageCalls, 1)
  assert.strictEqual(fixture.waterLevel(), 0)
  assert.strictEqual(ctx.bot.heldItem.name, 'bucket')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testWaterPlacementNoStockReportsStagingShortageWithoutActivation() {
  const items = []
  const ctx = createContext(items)
  const target = { x: 0, y: 64, z: 0 }
  const fixture = configureBuildingWaterPlacementFixture(ctx, items, target)
  let storageCalls = 0
  ctx.storageSystem = {
    async takeItems(context, options) {
      storageCalls += 1
      assert.strictEqual(options.itemName, 'water_bucket')
      return { ok: false, error: 'chest_item_not_found:water_bucket' }
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'interior',
    position: target,
    blockName: 'water',
    states: { level: '0' }
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'staged_material_missing:water_bucket:chest_item_not_found:water_bucket')
  assert.strictEqual(fixture.activationCount(), 0)
  assert.strictEqual(storageCalls, 1)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testPlacementConsumedItemCanRefillAndRetry() {
  const items = [{ name: 'red_bed', count: 1 }]
  const ctx = createContext(items)
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  let placeAttempts = 0
  let storageCalls = 0
  ctx.bot.placeBlock = async (reference, faceVector) => {
    placeAttempts += 1
    if (placeAttempts === 1) {
      items[0].count -= 1
      ctx.bot.heldItem = null
      return
    }
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    ctx.occupied.set(`${position.x},${position.y},${position.z}`, 'red_bed')
  }
  ctx.storageSystem = {
    async takeItems(context, options) {
      storageCalls += 1
      assert.strictEqual(options.itemName, 'red_bed')
      items[0].count += 1
      return { ok: true, withdrawnItems: [{ itemName: 'red_bed', count: 1 }] }
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'interior', position: { x: 0, y: 64, z: 0 }, blockName: 'red_bed' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placeAttempts, 2)
  assert.strictEqual(storageCalls, 1)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'red_bed')
}

async function testPlacementConsumedItemReportsStagingShortage() {
  const items = [{ name: 'oak_planks', count: 1 }]
  const ctx = createContext(items)
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  let placeAttempts = 0
  let storageCalls = 0
  ctx.bot.placeBlock = async () => {
    placeAttempts += 1
    items[0].count -= 1
    ctx.bot.heldItem = null
  }
  ctx.storageSystem = {
    async takeItems(context, options) {
      storageCalls += 1
      return { ok: false, error: `chest_item_not_found:${options.itemName}` }
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'frame', position: { x: 0, y: 64, z: 0 }, blockName: 'oak_planks' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    consumedItemRefillRetries: 2
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'staged_material_missing:oak_planks:chest_item_not_found:oak_planks')
  assert.strictEqual(result.recoveryError, 'block_item_not_found')
  assert.strictEqual(placeAttempts, 1)
  assert.strictEqual(storageCalls, 1)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'air')
}

async function testPlacementConsumedItemRefillRetryCap() {
  const items = [{ name: 'oak_planks', count: 1 }]
  const ctx = createContext(items)
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  let placeAttempts = 0
  let storageCalls = 0
  ctx.bot.placeBlock = async () => {
    placeAttempts += 1
    items[0].count -= 1
    ctx.bot.heldItem = null
  }
  ctx.storageSystem = {
    async takeItems(context, options) {
      storageCalls += 1
      items[0].count += 1
      return { ok: true, withdrawnItems: [{ itemName: options.itemName, count: 1 }] }
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'frame', position: { x: 0, y: 64, z: 0 }, blockName: 'oak_planks' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    consumedItemRefillRetries: 2
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(
    result.error,
    'placement_material_refill_retry_limit:oak_planks:block_item_not_found'
  )
  assert.strictEqual(result.lastPlacementError, 'block_item_not_found')
  assert.strictEqual(result.consumedItemRefillRetries, 2)
  assert.strictEqual(placeAttempts, 3)
  assert.strictEqual(storageCalls, 2)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'air')
}

async function testLargeVerticalTravelUsesAdaptiveMoveTimeout() {
  const items = [{ name: 'grass_block', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 64, z: 0 }
  let lastGoal = null
  let goalReachedDelayMs = 15
  ctx.bot.entity.position = vec(0, 80, 0)
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.setGoal = goal => {
    lastGoal = goal
  }
  ctx.bot.once = (event, callback) => {
    if (event !== 'goal_reached') return
    setTimeout(() => {
      if (lastGoal) ctx.bot.entity.position = vec(lastGoal.x, lastGoal.y, lastGoal.z)
      callback()
    }, goalReachedDelayMs)
  }
  ctx.bot.removeListener = () => {}

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'frame', position: target, blockName: 'grass_block' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    timeoutMs: 1,
    verticalMoveTimeoutPerBlockMs: 4,
    maxAdaptiveMoveTimeoutMs: 100
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'grass_block')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testLargeVerticalTerrainPlacementUsesSafeDescentOptions() {
  const items = [{ name: 'dirt', count: 2 }]
  const ctx = createContext(items)
  const target = { x: 10, y: 64, z: 0 }
  const goals = []
  const movementSnapshots = []

  ctx.bot.entity.position = vec(0, 80, 0)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.setMovements = movements => {
    movementSnapshots.push({
      canDig: movements.canDig,
      allow1by1towers: movements.allow1by1towers
    })
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dirt',
    role: 'terrain_fill'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goals.length > 0)
  assert.notDeepStrictEqual(
    { x: goals[0].x, y: goals[0].y, z: goals[0].z },
    target
  )
  assert.strictEqual(movementSnapshots.some(snapshot => snapshot.canDig === true), true)
  assert.strictEqual(movementSnapshots.some(snapshot => snapshot.allow1by1towers === true), true)
  assert.strictEqual(ctx.bot.blockAt(vec(10, 64, 0)).name, 'dirt')
}

async function testBelowFloorTerrainPlacementClimbsViaReservedAirStand() {
  const items = [{ name: 'dirt', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 64, z: 0 }
  const goals = []
  const movementSnapshots = []
  let placed = false

  ctx.bot.entity.position = vec(0.5, 61, 0.5)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.setMovements = movements => {
    movementSnapshots.push({
      canDig: movements.canDig,
      allow1by1towers: movements.allow1by1towers
    })
  }
  ctx.bot.pathfinder.getPathTo = (movements, goal) => ({
    status: 'success',
    cost: 1,
    path: [{ x: goal.x, y: goal.y, z: goal.z, toPlace: [], toBreak: [] }]
  })
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    if (position.x === -1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    return { name: 'air', position, shapes: [] }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dirt',
    role: 'terrain_fill'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(['-1,65,0']),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.some(goal => goal.x === -1 && goal.y === 65 && goal.z === 0))
  assert.strictEqual(movementSnapshots.some(snapshot => snapshot.allow1by1towers === true), true)
  assert.strictEqual(movementSnapshots.some(snapshot => snapshot.canDig === true), false)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testBaseLayerTerrainPlacementKeepsSurfaceViaReservedAirStand() {
  const items = [{ name: 'dirt', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 64, z: 0 }
  const reservedSurfaceStand = { x: 3, y: 64, z: 0 }
  const goals = []
  const movementSnapshots = []
  let placed = false

  ctx.bot.entity.position = vec(6.5, 64, 0.5)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.setMovements = movements => {
    movementSnapshots.push({
      canDig: movements.canDig,
      allow1by1towers: movements.allow1by1towers
    })
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position, shapes: [] }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    if (position.x === reservedSurfaceStand.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    // Without the surface-height guard these otherwise valid lower stands are
    // preferred after the reserved surface cell is filtered out.
    if (position.y === 60) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    return { name: 'air', position, shapes: [] }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dirt',
    role: 'terrain_fill'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(['3,64,0']),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.some(goal => goal.x === 3 && goal.y === 64 && goal.z === 0))
  assert.ok(goals.every(goal => goal.y >= target.y), JSON.stringify(goals))
  assert.ok(ctx.bot.entity.position.y >= target.y)
  assert.strictEqual(movementSnapshots.some(snapshot => snapshot.canDig === true), false)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testGroundPlantPlacementKeepsSurfaceViaReservedAirStand() {
  const items = [{ name: 'grass', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 65, z: 0 }
  const reservedSurfaceStand = { x: 3, y: 65, z: 0 }
  const goals = []
  const movementSnapshots = []
  let placed = false

  ctx.bot.entity.position = vec(6.5, 64, 0.5)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.setMovements = movements => {
    movementSnapshots.push({
      canDig: movements.canDig,
      allow1by1towers: movements.allow1by1towers
    })
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'grass' : 'air', position, shapes: [] }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'grass_block', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    if (position.x === reservedSurfaceStand.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'grass_block', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    // These lower stands model the fixture floor outside the completed
    // one-block terrain platform and must not be selected for the plant.
    if (position.y === 61) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    return { name: 'air', position, shapes: [] }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'grass'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(['3,65,0']),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.some(goal => goal.x === 3 && goal.y === 65 && goal.z === 0), JSON.stringify(goals))
  assert.ok(goals.every(goal => goal.y >= target.y), JSON.stringify(goals))
  assert.ok(ctx.bot.entity.position.y >= target.y)
  assert.strictEqual(movementSnapshots.some(snapshot => snapshot.canDig === true), false)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testHighPlacementClimbsViaReservedAirStand() {
  const items = [{ name: 'spruce_slab', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 68, z: 0 }
  const reservedHighStand = { x: 3, y: 68, z: 0 }
  const goals = []
  let placed = false

  ctx.bot.entity.position = vec(8.5, 64, 0.5)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.getPathTo = (movements, goal) => ({
    status: 'success',
    cost: 1,
    path: [{ x: goal.x, y: goal.y, z: goal.z, toPlace: [], toBreak: [] }]
  })
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'spruce_slab' : 'air', position, shapes: [] }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'spruce_planks', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    if (position.x === reservedHighStand.x && position.y === reservedHighStand.y - 1 && position.z === reservedHighStand.z) {
      return { name: 'spruce_planks', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    // Model the fixture floor that caused the live Y=110 placement to try
    // only distant Y=106 stands before reserved high air was admitted.
    if (position.y === 63) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    return { name: 'air', position, shapes: [] }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'floor',
    position: target,
    blockName: 'spruce_slab'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(['3,68,0']),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.some(goal => goal.x === 3 && goal.y === 68 && goal.z === 0), JSON.stringify(goals))
  assert.ok(goals.every(goal => goal.y >= target.y - 2), JSON.stringify(goals))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testBaseLayerRepairWithoutTerrainRoleKeepsCompletedSurface() {
  const items = [{ name: 'dirt', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 64, z: 0 }
  const reservedSurfaceStand = { x: 3, y: 65, z: 0 }
  const goals = []
  let placed = false

  ctx.bot.entity.position = vec(6.5, 64, 0.5)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.getPathTo = (movements, goal) => ({
    status: 'success',
    cost: 1,
    path: [{ x: goal.x, y: goal.y, z: goal.z, toPlace: [], toBreak: [] }]
  })
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position, shapes: [] }
    }
    if (position.x === reservedSurfaceStand.x && position.y === target.y && position.z === target.z) {
      return { name: 'grass_block', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    // The fixture floor offers many tempting Y=64 stands outside the filled
    // surface. A resumed base repair must remain at Y=65 instead.
    if (position.y === target.y - 1) {
      return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    return { name: 'air', position, shapes: [] }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dirt',
    runStatus: 'pending'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(['3,64,0', '3,65,0']),
    reservedBounds: null,
    resumedConstructionRun: true
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.some(goal => goal.x === 3 && goal.y === 65 && goal.z === 0), JSON.stringify(goals))
  assert.ok(goals.every(goal => goal.y >= 65), JSON.stringify(goals))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testLargeVerticalClearUsesAdaptiveMoveTimeout() {
  const ctx = createContext([])
  const target = { x: 0, y: 74, z: 0 }
  let occupied = true
  let lastGoal = null
  ctx.bot.entity.position = vec(0, 64, 0)
  ctx.bot.pathfinder.setGoal = goal => {
    lastGoal = goal
  }
  ctx.bot.once = (event, callback) => {
    if (event !== 'goal_reached') return
    setTimeout(() => {
      if (lastGoal) ctx.bot.entity.position = vec(lastGoal.x, lastGoal.y, lastGoal.z)
      callback()
    }, 15)
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'dirt' : 'air', position }
    }
    if (position.y === 71 || position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async () => {
    occupied = false
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'clear', phase: 'clear_obstruction', position: target, current: 'dirt' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    timeoutMs: 1,
    verticalMoveTimeoutPerBlockMs: 4,
    maxAdaptiveMoveTimeoutMs: 100
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 74, 0)).name, 'air')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testHighStateRepairClearUsesAdaptiveMoveTimeout() {
  const items = [{ name: 'dark_oak_trapdoor', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 0, y: 74, z: 0 }
  let occupied = true
  let placed = false
  let lastGoal = null
  ctx.bot.entity.position = vec(0, 64, 0)
  ctx.bot.registry.blocksByName.dark_oak_trapdoor = { id: 30, name: 'dark_oak_trapdoor' }
  ctx.bot.registry.itemsByName.dark_oak_trapdoor = { id: 31, name: 'dark_oak_trapdoor' }
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.pathfinder.setGoal = goal => {
    lastGoal = goal
  }
  ctx.bot.once = (event, callback) => {
    if (event !== 'goal_reached') return
    setTimeout(() => {
      if (lastGoal) ctx.bot.entity.position = vec(lastGoal.x, lastGoal.y, lastGoal.z)
      callback()
    }, 15)
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      if (placed) {
        return {
          name: 'dark_oak_trapdoor',
          position,
          getProperties: () => ({ half: 'bottom', facing: 'east', open: false, powered: false, waterlogged: false })
        }
      }
      return {
        name: occupied ? 'dark_oak_trapdoor' : 'air',
        position,
        getProperties: () => ({ half: 'bottom', facing: 'north', open: false, powered: false, waterlogged: false })
      }
    }
    if (position.y === 63 || position.y === 73 || position.y === 74) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.dig = async () => {
    occupied = false
  }
  ctx.bot._placeBlockWithOptions = async () => {
    placed = true
  }

  const system = createSyntheticBuildingSystem()
  const step = {
    id: 'high-trapdoor-state-repair',
    kind: 'place',
    phase: 'doors_windows',
    position: target,
    blockName: 'dark_oak_trapdoor',
    states: { half: 'bottom', facing: 'east', open: 'false', powered: 'false', waterlogged: 'false' },
    role: 'trapdoor',
    runStatus: 'state_repair'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        [step.id]: { id: step.id, status: 'state_repair', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'doors_windows'
    }
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    timeoutMs: 1,
    verticalMoveTimeoutPerBlockMs: 4,
    maxAdaptiveMoveTimeoutMs: 100,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(occupied, false)
  assert.strictEqual(placed, true)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPottedStepRefillsPlantItemBeforePlacement() {
  const items = [{ name: 'flower_pot', count: 1 }]
  const target = { x: 0, y: 64, z: 0 }
  const ctx = createContext(items)
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'flower_pot')
    assert.strictEqual(ctx.bot.heldItem.name, 'cornflower')
    ctx.occupied.set(`${target.x},${target.y},${target.z}`, 'potted_cornflower')
  }
  const storageCalls = []
  ctx.storageSystem = {
    async takeItems(context, options) {
      storageCalls.push(options)
      assert.strictEqual(options.itemName, 'cornflower')
      items.push({ name: 'cornflower', count: options.count })
      return { ok: true, withdrawnItems: [{ itemName: 'cornflower', count: options.count }] }
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'frame', position: target, blockName: 'potted_cornflower' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(storageCalls.length, 1)
  assert.strictEqual(storageCalls[0].itemName, 'cornflower')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'potted_cornflower')
}

async function testPottedSaplingDoesNotUseGroundSupportRepair() {
  const items = [
    { name: 'flower_pot', count: 1 },
    { name: 'spruce_sapling', count: 1 }
  ]
  const target = { x: 0, y: 65, z: 0 }
  const ctx = createContext(items, {
    occupied: [{ x: 0, y: 64, z: 0, name: 'bookshelf' }]
  })
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'flower_pot')
    assert.strictEqual(ctx.bot.heldItem.name, 'spruce_sapling')
    ctx.occupied.set(`${target.x},${target.y},${target.z}`, 'potted_spruce_sapling')
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'frame', position: target, blockName: 'potted_spruce_sapling' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 65, 0)).name, 'potted_spruce_sapling')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'bookshelf')
}

async function testGroundPlantStepRepairsMissingVerifiedSupport() {
  const items = [
    { name: 'grass_block', count: 1 },
    { name: 'azalea', count: 1 }
  ]
  const ctx = createContext(items)
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)

  const system = createSyntheticBuildingSystem()
  const supportStep = {
    id: 'support-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 64, z: 0 },
    blockName: 'grass_block'
  }
  const plantStep = {
    id: 'plant-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 65, z: 0 },
    blockName: 'azalea'
  }
  system.session = {
    currentStepIndex: 1,
    steps: [supportStep, plantStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'support-step': { id: 'support-step', status: 'verified', retry: { count: 0, lastError: null } },
        'plant-step': { id: 'plant-step', status: 'executing', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.executeStep(ctx, plantStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'grass_block')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 65, 0)).name, 'azalea')
  assert.strictEqual(system.session.constructionRun.steps['support-step'].status, 'verified')
}

async function testUpperHalfGroundPlantUsesLowerHalfAsSupport() {
  const ctx = createContext([], {
    occupied: [{ x: 0, y: 65, z: 0, name: 'tall_grass' }]
  })

  const system = createSyntheticBuildingSystem()
  const lowerStep = {
    id: 'lower-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 65, z: 0 },
    blockName: 'tall_grass',
    states: { half: 'lower' }
  }
  const upperStep = {
    id: 'upper-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 66, z: 0 },
    blockName: 'tall_grass',
    states: { half: 'upper' }
  }
  system.session = {
    currentStepIndex: 1,
    steps: [lowerStep, upperStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'lower-step': { id: 'lower-step', status: 'pending', retry: { count: 0, lastError: null } },
        'upper-step': { id: 'upper-step', status: 'executing', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.ensureGroundSupportForStep(ctx, upperStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.reason, 'ground_support_upper_half_double_plant')
  assert.strictEqual(system.session.constructionRun.steps['lower-step'].status, 'pending')
}

async function testNoSupportStepRepairsPlannedReferenceFirst() {
  const items = [{ name: 'oak_planks', count: 2 }]
  const ctx = createContext(items, {
    occupied: [{ x: 1, y: 64, z: 0, name: 'grass_block' }]
  })
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)

  const system = createSyntheticBuildingSystem()
  const targetStep = {
    id: 'target-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 65, z: 0 },
    blockName: 'oak_planks'
  }
  const referenceStep = {
    id: 'reference-step',
    kind: 'place',
    phase: 'stairs',
    position: { x: 1, y: 65, z: 0 },
    blockName: 'oak_planks'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [targetStep, referenceStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set([
      '0,64,0',
      '1,65,0',
      '-1,65,0',
      '0,65,1',
      '0,65,-1'
    ]),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'target-step': { id: 'target-step', status: 'executing', retry: { count: 0, lastError: null } },
        'reference-step': { id: 'reference-step', status: 'pending', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.executeStep(ctx, targetStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(1, 65, 0)).name, 'oak_planks')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 65, 0)).name, 'oak_planks')
  assert.strictEqual(system.session.constructionRun.steps['reference-step'].status, 'verified')
}

async function testUnstableAirStepRepairsPlannedReferenceFirst() {
  const items = [
    { name: 'oak_stairs', count: 1 },
    { name: 'oak_planks', count: 1 }
  ]
  const ctx = createContext(items, {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'grass_block' },
      { x: 1, y: 64, z: 0, name: 'grass_block' }
    ]
  })
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)

  const originalPlaceBlock = ctx.bot.placeBlock.bind(ctx.bot)
  let targetAttempts = 0
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    if (position.x === 0 && position.y === 65 && position.z === 0) {
      targetAttempts += 1
      if (!ctx.occupied.has('1,65,0')) return
    }
    return originalPlaceBlock(reference, faceVector)
  }

  const system = createSyntheticBuildingSystem()
  const targetStep = {
    id: 'target-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 65, z: 0 },
    blockName: 'oak_stairs'
  }
  const referenceStep = {
    id: 'reference-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 1, y: 65, z: 0 },
    blockName: 'oak_planks'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [targetStep, referenceStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'target-step': { id: 'target-step', status: 'executing', retry: { count: 0, lastError: null } },
        'reference-step': { id: 'reference-step', status: 'pending', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.executeStep(ctx, targetStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(targetAttempts > 1)
  assert.strictEqual(ctx.bot.blockAt(vec(1, 65, 0)).name, 'oak_planks')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 65, 0)).name, 'oak_stairs')
  assert.strictEqual(system.session.constructionRun.steps['reference-step'].status, 'verified')
}

async function testNoSupportRepairSkipsNonReferencePlannedBlocks() {
  const items = [
    { name: 'oak_planks', count: 2 },
    { name: 'ladder', count: 1 }
  ]
  const ctx = createContext(items, {
    occupied: [
      { x: 0, y: 64, z: 1, name: 'grass_block' },
      { x: 2, y: 65, z: 0, name: 'stone' }
    ]
  })
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)

  const system = createSyntheticBuildingSystem()
  const targetStep = {
    id: 'target-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 65, z: 0 },
    blockName: 'oak_planks'
  }
  const ladderStep = {
    id: 'ladder-step',
    kind: 'place',
    phase: 'stairs',
    position: { x: 1, y: 65, z: 0 },
    blockName: 'ladder',
    states: { facing: 'west' }
  }
  const solidReferenceStep = {
    id: 'solid-reference-step',
    kind: 'place',
    phase: 'stairs',
    position: { x: 0, y: 65, z: 1 },
    blockName: 'oak_planks'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [targetStep, ladderStep, solidReferenceStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set([
      '0,64,0',
      '1,65,0',
      '-1,65,0',
      '0,65,1',
      '0,65,-1'
    ]),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'target-step': { id: 'target-step', status: 'executing', retry: { count: 0, lastError: null } },
        'ladder-step': { id: 'ladder-step', status: 'pending', retry: { count: 0, lastError: null } },
        'solid-reference-step': { id: 'solid-reference-step', status: 'pending', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.executeStep(ctx, targetStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(1, 65, 0)).name, 'air')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 65, 1)).name, 'oak_planks')
  assert.strictEqual(ctx.bot.blockAt(vec(0, 65, 0)).name, 'oak_planks')
  assert.strictEqual(system.session.constructionRun.steps['ladder-step'].status, 'pending')
  assert.strictEqual(system.session.constructionRun.steps['solid-reference-step'].status, 'verified')
}

async function testTemporaryReferenceFailureRepairsPlannedReference() {
  const items = [{ name: 'oak_planks', count: 2 }]
  const ctx = createContext(items, {
    occupied: [{ x: 11, y: 74, z: 0, name: 'grass_block' }]
  })
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.entity.position = vec(10, 74, 3)
  ctx.bot.pathfinder.setGoal = () => {}

  const system = createSyntheticBuildingSystem()
  const targetStep = {
    id: 'target-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 10, y: 75, z: 0 },
    blockName: 'oak_planks'
  }
  const referenceStep = {
    id: 'reference-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 11, y: 75, z: 0 },
    blockName: 'oak_planks'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [targetStep, referenceStep],
    origin: { x: 10, y: 64, z: 0 },
    reservedPositions: new Set(['11,75,0']),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'target-step': { id: 'target-step', status: 'executing', retry: { count: 0, lastError: null } },
        'reference-step': { id: 'reference-step', status: 'pending', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.executeStep(ctx, targetStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(11, 75, 0)).name, 'oak_planks')
  assert.strictEqual(ctx.bot.blockAt(vec(10, 75, 0)).name, 'oak_planks')
  assert.strictEqual(system.session.constructionRun.steps['reference-step'].status, 'verified')
}

async function testFenceGateOpenStateDoesNotForceStateRepair() {
  const ctx = createContext([])
  const target = { x: 2, y: 65, z: 0 }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: 'dark_oak_fence_gate',
        position,
        getProperties: () => ({ facing: 'west', open: false, powered: false, in_wall: false })
      }
    }
    return { name: 'air', position }
  }

  const system = createSyntheticBuildingSystem()
  const gateStep = {
    id: 'gate-step',
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dark_oak_fence_gate',
    states: { facing: 'west', open: 'true', powered: 'false', in_wall: 'false' }
  }
  system.session = {
    currentStepIndex: 0,
    steps: [gateStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'gate-step': { id: 'gate-step', status: 'state_repair', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'frame'
    }
  }

  const result = await system.executeStep(ctx, gateStep, { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.reason, 'already_correct')
}

async function testUpperDoorStateRepairUsesLowerDoorPlacement() {
  const items = [{ name: 'spruce_door', count: 2 }]
  const ctx = createContext(items)
  ctx.bot.registry.blocksByName.spruce_door = { id: 28, name: 'spruce_door' }
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  const lower = { x: 2, y: 64, z: 0 }
  const upper = { x: 2, y: 65, z: 0 }
  const blocks = new Map()
  const digCalls = []
  const placeCalls = []
  const activateCalls = []
  const blockKey = position => `${position.x},${position.y},${position.z}`
  const setDoorPair = open => {
    blocks.set(blockKey(lower), {
      name: 'spruce_door',
      states: { half: 'lower', facing: 'south', hinge: 'left', open }
    })
    blocks.set(blockKey(upper), {
      name: 'spruce_door',
      states: { half: 'upper', facing: 'south', hinge: 'left', open }
    })
  }
  setDoorPair(false)
  ctx.bot.blockAt = position => {
    const block = blocks.get(blockKey(position))
    if (block) {
      return {
        name: block.name,
        position,
        getProperties: () => ({ ...block.states })
      }
    }
    if (position.x === lower.x && position.y === lower.y - 1 && position.z === lower.z) {
      return { name: 'grass_block', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.canDigBlock = block => block?.name === 'spruce_door'
  ctx.bot.dig = async block => {
    digCalls.push(block.position)
    blocks.delete(blockKey(lower))
    blocks.delete(blockKey(upper))
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    placeCalls.push(position)
    assert.deepStrictEqual(position, lower)
    setDoorPair(false)
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector) => {
    await ctx.bot.placeBlock(reference, faceVector)
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.activateBlock = async block => {
    activateCalls.push(block.position)
    setDoorPair(true)
  }

  const lowerStep = {
    id: 'lower-door-step',
    kind: 'place',
    phase: 'doors_windows',
    position: lower,
    blockName: 'spruce_door',
    states: { half: 'lower', facing: 'south', hinge: 'left', open: 'true' }
  }
  const upperStep = {
    id: 'upper-door-step',
    kind: 'place',
    phase: 'doors_windows',
    position: upper,
    blockName: 'spruce_door',
    states: { half: 'upper', facing: 'south', hinge: 'left', open: 'true' }
  }
  const system = createSyntheticBuildingSystem()
  system.session = {
    currentStepIndex: 0,
    steps: [lowerStep, upperStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'lower-door-step': { id: 'lower-door-step', status: 'state_repair', retry: { count: 0, lastError: null } },
        'upper-door-step': { id: 'upper-door-step', status: 'executing', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'doors_windows'
    }
  }

  const result = await system.executeStep(ctx, upperStep, {
    owner: 'test',
    stableConfirmDelayMs: 1,
    timeoutMs: 10
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.reason, 'upper_door_repaired_via_lower')
  assert.strictEqual(ctx.bot.blockAt(vec(lower.x, lower.y, lower.z)).getProperties().open, true)
  assert.strictEqual(ctx.bot.blockAt(vec(upper.x, upper.y, upper.z)).getProperties().open, true)
  assert.strictEqual(digCalls.length, 1)
  assert.strictEqual(digCalls[0].y, upper.y)
  assert.strictEqual(placeCalls.length, 1)
  assert.strictEqual(activateCalls.length, 1)
  assert.strictEqual(system.session.constructionRun.steps['lower-door-step'].status, 'verified')
}

async function testLowerDoorStateRepairClearsUpperBeforePlacement() {
  const items = [{ name: 'spruce_door', count: 2 }]
  const ctx = createContext(items)
  ctx.bot.registry.blocksByName.spruce_door = { id: 28, name: 'spruce_door' }
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  const lower = { x: 2, y: 64, z: 0 }
  const upper = { x: 2, y: 65, z: 0 }
  const blocks = new Map()
  const digCalls = []
  const placeCalls = []
  const blockKey = position => `${position.x},${position.y},${position.z}`
  const setDoorPair = (facing, hinge = 'left') => {
    blocks.set(blockKey(lower), {
      name: 'spruce_door',
      states: { half: 'lower', facing, hinge, open: false, powered: false }
    })
    blocks.set(blockKey(upper), {
      name: 'spruce_door',
      states: { half: 'upper', facing, hinge, open: false, powered: false }
    })
  }
  setDoorPair('north')
  ctx.bot.blockAt = position => {
    const block = blocks.get(blockKey(position))
    if (block) {
      return {
        name: block.name,
        position,
        getProperties: () => ({ ...block.states })
      }
    }
    if (position.x === lower.x && position.y === lower.y - 1 && position.z === lower.z) {
      return { name: 'grass_block', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.canDigBlock = block => block?.name === 'spruce_door'
  ctx.bot.dig = async block => {
    digCalls.push(block.position)
    blocks.delete(blockKey(block.position))
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    placeCalls.push(position)
    assert.deepStrictEqual(position, lower)
    assert.strictEqual(blocks.has(blockKey(upper)), false)
    setDoorPair('west', 'right')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, placeOptions = {}) => {
    assert.strictEqual(placeOptions.forceLook, 'ignore')
    await ctx.bot.placeBlock(reference, faceVector)
  }
  ctx.bot.lookAt = async () => {}

  const lowerStep = {
    id: 'lower-door-step',
    kind: 'place',
    phase: 'doors_windows',
    position: lower,
    blockName: 'spruce_door',
    states: { half: 'lower', facing: 'west', hinge: 'left', open: 'false', powered: 'false' }
  }
  const upperStep = {
    id: 'upper-door-step',
    kind: 'place',
    phase: 'doors_windows',
    position: upper,
    blockName: 'spruce_door',
    states: { half: 'upper', facing: 'west', hinge: 'left', open: 'false', powered: 'false' }
  }
  const system = createSyntheticBuildingSystem()
  system.session = {
    currentStepIndex: 0,
    steps: [lowerStep, upperStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'lower-door-step': { id: 'lower-door-step', status: 'state_repair', retry: { count: 0, lastError: null } },
        'upper-door-step': { id: 'upper-door-step', status: 'state_repair', retry: { count: 0, lastError: null } }
      },
      lifecycle: {},
      currentPhase: 'doors_windows'
    }
  }

  const result = await system.executeStep(ctx, lowerStep, {
    owner: 'test',
    stableConfirmDelayMs: 1,
    timeoutMs: 10
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(lower.x, lower.y, lower.z)).getProperties().facing, 'west')
  assert.strictEqual(ctx.bot.blockAt(vec(lower.x, lower.y, lower.z)).getProperties().hinge, 'right')
  assert.strictEqual(ctx.bot.blockAt(vec(upper.x, upper.y, upper.z)).getProperties().facing, 'west')
  assert.strictEqual(digCalls.length, 2)
  assert.strictEqual(digCalls[0].y, upper.y)
  assert.strictEqual(digCalls[1].y, lower.y)
  assert.strictEqual(placeCalls.length, 1)
  assert.strictEqual(system.session.constructionRun.steps['upper-door-step'].status, 'verified')
}

async function testScaffoldExecutionPrefersReachableLowStand() {
  const ctx = createContext([{ name: 'dirt', count: 8 }])
  const goals = []
  const target = { x: 0, y: 70, z: 0 }
  ctx.bot.entity.position = vec(6, 64, 0)
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  const originalBlockAt = ctx.bot.blockAt.bind(ctx.bot)
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'dirt', position }
    }
    return originalBlockAt(position)
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'scaffold_place', phase: 'scaffold', position: target, blockName: 'dirt' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.ok(goals.length > 0)
  assert.strictEqual(goals[0].y, 64)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 70, 0)).name, 'dirt')
}

async function testScaffoldExecutionRecoversFromTimeoutWithReachableReference() {
  const ctx = createContext([{ name: 'dirt', count: 8 }])
  const goals = []
  const target = { x: 4, y: 75, z: 0 }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(target.x - 3.5, target.y - 4.5, target.z + 0.5)
    }
  }
  const originalBlockAt = ctx.bot.blockAt.bind(ctx.bot)
  ctx.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (ctx.occupied.has(key)) return { name: ctx.occupied.get(key), position }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 68) return { name: 'stone', position }
    return originalBlockAt(position)
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'scaffold_place', phase: 'scaffold', position: target, blockName: 'dirt' }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.executeStep(ctx, step, {
    owner: 'test',
    timeoutMs: 1,
    verticalMoveTimeoutPerBlockMs: 0
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goals.length >= 1)
  assert.strictEqual(ctx.bot.blockAt(vec(target.x, target.y, target.z)).name, 'dirt')
}

async function testRepeatedOptionalScaffoldMoveTimeoutIsSkipped() {
  const ctx = createContext([{ name: 'dirt', count: 8 }], {
    occupied: [{ x: 4, y: 74, z: 0, name: 'dirt' }]
  })
  let placeCalls = 0
  ctx.bot.placeBlock = async () => {
    placeCalls += 1
  }
  const system = createSyntheticBuildingSystem()
  const step = {
    id: 'optional-scaffold',
    kind: 'scaffold_place',
    phase: 'scaffold',
    position: { x: 4, y: 75, z: 0 },
    blockName: 'dirt'
  }
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'optional-scaffold': {
          id: 'optional-scaffold',
          status: 'retryable_failed',
          retry: { count: 2, lastError: 'move_timeout' },
          target: step.position,
          block: { id: 'dirt', states: {} }
        }
      },
      lifecycle: {},
      currentPhase: 'site_prepare'
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  const runStep = system.session.constructionRun.steps['optional-scaffold']

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.result.skipped, true)
  assert.strictEqual(runStep.status, 'verified')
  assert.strictEqual(runStep.skipped, true)
  assert.strictEqual(runStep.skipReason, 'optional_scaffold_move_timeout')
  assert.strictEqual(placeCalls, 0)
}

async function testPlacementTargetOccupiedIsRetryableConstructionFailure() {
  const ctx = createContext([{ name: 'dark_oak_stairs', count: 1 }])
  const step = {
    id: 'stair-occupied',
    kind: 'place',
    phase: 'stairs',
    position: { x: 4, y: 67, z: 0 },
    blockName: 'dark_oak_stairs',
    states: { half: 'bottom', facing: 'north' },
    role: 'stairs'
  }
  const system = createSyntheticBuildingSystem({
    executor: {
      executeStep: async () => ({ ok: false, error: 'placement_target_occupied' })
    }
  })
  system.session = {
    currentStepIndex: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'stair-occupied': {
          id: 'stair-occupied',
          status: 'pending',
          target: step.position,
          block: { id: 'dark_oak_stairs', states: step.states },
          role: 'stairs'
        }
      },
      lifecycle: {},
      currentPhase: 'stairs'
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  const runStep = system.session.constructionRun.steps['stair-occupied']

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'placement_target_occupied')
  assert.strictEqual(runStep.status, 'retryable_failed')
  assert.strictEqual(runStep.retry.lastError, 'placement_target_occupied')
}

async function testResumeHydratesStoredStatesBeforeExecutingStep() {
  const ctx = createContext([{ name: 'spruce_trapdoor', count: 1 }])
  const expectedStates = {
    half: 'top',
    facing: 'south',
    open: 'false',
    powered: 'false',
    waterlogged: 'false'
  }
  let executedStep = null
  const runtimeStep = {
    id: 'trapdoor-resume',
    kind: 'place',
    action: 'place_block',
    phase: 'doors_windows',
    position: { x: 10, y: 67, z: -5 },
    blockName: 'spruce_trapdoor',
    states: {},
    orientation: {},
    role: 'trapdoor'
  }
  const system = createSyntheticBuildingSystem({
    executor: {
      executeStep: async (_context, step) => {
        executedStep = step
        return { ok: true }
      }
    }
  })
  system.session = {
    currentStepIndex: 0,
    currentIndex: 0,
    placedBlocks: 0,
    clearedBlocks: 0,
    foundationBlocks: 0,
    scaffoldBlocks: 0,
    removedScaffoldBlocks: 0,
    steps: [runtimeStep],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        'trapdoor-resume': {
          id: 'trapdoor-resume',
          status: 'retryable_failed',
          retry: { count: 1, lastError: 'move_timeout' },
          target: runtimeStep.position,
          block: {
            id: 'spruce_trapdoor',
            states: expectedStates
          },
          resolvedBlock: {
            id: 'spruce_trapdoor'
          },
          role: 'trapdoor',
          dependencies: []
        }
      },
      lifecycle: {},
      currentPhase: 'doors_windows'
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  const runStep = system.session.constructionRun.steps['trapdoor-resume']

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(executedStep.states, expectedStates)
  assert.deepStrictEqual(executedStep.orientation, expectedStates)
  assert.deepStrictEqual(executedStep.block.states, expectedStates)
  assert.strictEqual(runStep.status, 'verified')
}

async function testStateRepairStatusSurvivesExecutingTransitionForProtectedFurnace() {
  const items = [{ name: 'furnace', count: 1 }]
  const ctx = createContext(items)
  const target = { x: 2, y: 64, z: 0 }
  let occupied = true
  let placed = false
  let digAttempts = 0
  let placeAttempts = 0

  ctx.bot.registry.blocksByName.furnace = { id: 30, name: 'furnace' }
  ctx.bot.registry.itemsByName.furnace = { id: 31, name: 'furnace' }
  ctx.bot.inventory.items = () => items.filter(item => item.count > 0)
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      if (placed) {
        return {
          name: 'furnace',
          position,
          getProperties: () => ({ lit: false, facing: 'east' })
        }
      }
      if (occupied) {
        return {
          name: 'furnace',
          position,
          getProperties: () => ({ lit: false, facing: 'west' })
        }
      }
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.y === 63) return { name: 'stone', position, getProperties: () => ({}) }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.dig = async block => {
    assert.strictEqual(block.name, 'furnace')
    occupied = false
    digAttempts += 1
  }
  ctx.bot.placeBlock = async () => {
    placed = true
    placeAttempts += 1
  }
  ctx.bot._placeBlockWithOptions = async () => ctx.bot.placeBlock()

  const step = {
    id: 'furnace-state-repair',
    kind: 'place',
    action: 'place_block',
    phase: 'functional_blocks',
    position: target,
    blockName: 'furnace',
    states: { lit: 'false', facing: 'east' },
    orientation: { lit: 'false', facing: 'east' },
    role: 'furnace',
    exactRequired: true
  }
  const system = createSyntheticBuildingSystem()
  system.session = {
    currentStepIndex: 0,
    currentIndex: 0,
    placedBlocks: 0,
    clearedBlocks: 0,
    foundationBlocks: 0,
    scaffoldBlocks: 0,
    removedScaffoldBlocks: 0,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    constructionRun: {
      runId: 'test-run',
      steps: {
        [step.id]: {
          id: step.id,
          status: 'state_repair',
          retry: { count: 0, lastError: null },
          target,
          block: { id: 'furnace', states: step.states },
          resolvedBlock: { id: 'furnace', states: step.states },
          role: 'furnace'
        }
      },
      lifecycle: {},
      currentPhase: 'functional_blocks'
    }
  }

  const result = await system.placeNextBlock(ctx, {
    owner: 'test',
    maxBlocksPerUpdate: 1,
    stableConfirmDelayMs: 1
  })
  const runStep = system.session.constructionRun.steps[step.id]

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(digAttempts, 1)
  assert.strictEqual(placeAttempts, 1)
  assert.strictEqual(runStep.status, 'verified')
  assert.deepStrictEqual(ctx.bot.blockAt(target).getProperties(), { lit: false, facing: 'east' })
}

async function testFirstPostScaffoldPlacementAllowsTemporaryDescentDig() {
  const ctx = createContext([{ name: 'grass_block', count: 1 }])
  let capturedCanDig = null
  ctx.bot.entity.position = vec(0, 81, 0)
  ctx.bot.registry = require('minecraft-data')('1.20.4')
  ctx.bot.pathfinder.setMovements = movements => {
    capturedCanDig = movements.canDig
  }
  ctx.bot.pathfinder.setGoal = goal => {
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }

  const system = createSyntheticBuildingSystem()
  const step = { kind: 'place', phase: 'frame', position: { x: 10, y: 64, z: 0 }, blockName: 'grass_block' }
  system.session = {
    currentStepIndex: 21,
    steps: [step],
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    scaffoldBlocks: 21,
    placedBlocks: 0
  }

  const result = await system.executeStep(ctx, step, { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(capturedCanDig, true)
}

async function testClearBlockUsesAppropriateTool() {
  const ctx = createContext([{ name: 'iron_axe', count: 1 }], {
    equipmentSystem: new EquipmentSystem(),
    occupied: [{ x: 0, y: 64, z: 0, name: 'oak_log' }]
  })
  const result = await clearBlockForBuilding(ctx, { x: 0, y: 64, z: 0 }, { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.ok(ctx.equippedItems.includes('iron_axe'))
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'air')
}

async function testScaffoldBackBridgeBuildsFromSideConnector() {
  const ctx = createContext([{ name: 'dirt', count: 128 }, { name: 'oak_planks', count: 800 }])
  const worldBlocks = [{ type: 'oak_planks', position: { x: 0, y: 64, z: 0 } }]
  for (let x = 0; x <= 22; x++) {
    for (let z = 0; z <= 27; z++) {
      worldBlocks.push({ type: 'oak_planks', position: { x, y: 75, z } })
    }
  }

  const sitePlan = createSitePlan(ctx, worldBlocks)
  const scaffold = sitePlan.scaffold.place.map(step => step.position)
  const key = position => `${position.x},${position.y},${position.z}`
  const indexOf = target => scaffold.findIndex(position => key(position) === key(target))

  const sideConnectorIndex = indexOf({ x: 25, y: 71, z: 30 })
  const bridgeNearSideIndex = indexOf({ x: 24, y: 71, z: 30 })
  const bridgeNearRoofIndex = indexOf({ x: 23, y: 71, z: 30 })
  const sideColumnBaseIndex = indexOf({ x: 25, y: 64, z: -3 })
  const sideColumnTopIndex = indexOf({ x: 25, y: 70, z: -3 })
  const leftConnectorIndex = indexOf({ x: -3, y: 71, z: -3 })
  const leftColumnBaseIndex = indexOf({ x: -3, y: 64, z: -3 })
  const leftColumnTopIndex = indexOf({ x: -3, y: 70, z: -3 })
  const leftSideMidIndex = indexOf({ x: -3, y: 71, z: 10 })
  const leftBackBridgeNearSideIndex = indexOf({ x: -2, y: 71, z: 30 })
  const leftBackBridgeNearRoofIndex = indexOf({ x: -1, y: 71, z: 30 })

  assert.ok(sideColumnBaseIndex >= 0)
  assert.ok(sideColumnTopIndex >= 0)
  assert.ok(sideConnectorIndex >= 0)
  assert.ok(bridgeNearSideIndex >= 0)
  assert.ok(bridgeNearRoofIndex >= 0)
  assert.ok(sideColumnBaseIndex < sideColumnTopIndex)
  assert.ok(sideColumnTopIndex < sideConnectorIndex)
  assert.ok(sideConnectorIndex < bridgeNearSideIndex)
  assert.ok(bridgeNearSideIndex < bridgeNearRoofIndex)
  assert.ok(leftColumnBaseIndex >= 0)
  assert.ok(leftColumnTopIndex >= 0)
  assert.ok(leftConnectorIndex >= 0)
  assert.ok(leftSideMidIndex >= 0)
  assert.ok(leftBackBridgeNearSideIndex >= 0)
  assert.ok(leftBackBridgeNearRoofIndex >= 0)
  assert.ok(leftColumnBaseIndex < leftColumnTopIndex)
  assert.ok(leftColumnTopIndex < leftConnectorIndex)
  assert.ok(leftConnectorIndex < leftSideMidIndex)
  assert.ok(leftSideMidIndex < leftBackBridgeNearSideIndex)
  assert.ok(leftBackBridgeNearSideIndex < leftBackBridgeNearRoofIndex)
}

function testBuildingAcceptanceFixtureOriginsKeepCommunitySitesSeparate() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const wood = communityVillaBlueprint({ name: 'wood_site_fixture', width: 13, depth: 11, roofY: 8 })
  const modern = communityVillaBlueprint({ name: 'modern_site_fixture', width: 18, depth: 14, roofY: 9 })
  const snapshot = {
    acceptancePlayerPosition: { x: 539.5, y: 69, z: -54.5 }
  }

  const woodOrigin = buildingAcceptance._test.fixtureOrigin(snapshot, 0, wood)
  const modernOrigin = buildingAcceptance._test.fixtureOrigin(snapshot, 1, modern)
  const woodBounds = buildingAcceptance._test.blueprintBounds(wood, woodOrigin)
  const modernBounds = buildingAcceptance._test.blueprintBounds(modern, modernOrigin)

  assert.ok(woodBounds.maxX < modernBounds.minX)
  assert.ok(modernBounds.minX <= modernOrigin.x - 7)
  assert.ok(modernBounds.minZ <= modernOrigin.z - 4)
  assert.ok(modernOrigin.x - woodOrigin.x >= buildingAcceptance._test.fixtureSiteStrideX(modern))
}

function testBuildingAcceptanceFixtureFillCommandsStayBelowLimit() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const commands = buildingAcceptance._test.fillCommands(
    { x: 597, y: 69, z: -62 },
    { x: 651, y: 106, z: -7 },
    'minecraft:air'
  )

  assert.ok(commands.length > 1)
  for (const command of commands) {
    const match = command.match(/^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:air$/)
    assert.ok(match, command)
    const [, x1, y1, z1, x2, y2, z2] = match.map(Number)
    const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1)
    assert.ok(volume <= 30000, `${command} volume=${volume}`)
  }
}

function testBuildingAcceptanceFixtureDirtReserveCoversTallScaffold() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const blocks = []
  for (let x = 0; x < 35; x++) {
    for (let z = 0; z < 36; z++) {
      blocks.push({ x, y: 0, z, type: 'stone' })
      blocks.push({ x, y: 35, z, type: 'stone' })
    }
  }
  const blueprint = { name: 'tall_fixture', origin: { x: 0, y: 0, z: 0 }, blocks }
  const origin = { x: 607, y: 69, z: -52 }
  const scaffoldBlocks = buildingAcceptance._test.estimateFixtureScaffoldBlocks(blueprint, origin)
  const reserve = buildingAcceptance._test.fixtureDirtReserveForBlueprint(blueprint, origin)
  const directDirt = buildingAcceptance._test.fixtureDirectDirtForReserve(reserve)

  assert.ok(scaffoldBlocks > 256)
  assert.ok(reserve >= scaffoldBlocks)
  assert.ok(reserve > 256)
  assert.strictEqual(directDirt, 256)
}

function testBuildingAcceptanceFixtureRuntimeMaterialReserveCoversStone() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const reserve = buildingAcceptance._test.fixtureRuntimeMaterialReserve({ stone: 66, oak_planks: 20 })
  const noStoneReserve = buildingAcceptance._test.fixtureRuntimeMaterialReserve({ oak_planks: 20 })

  assert.ok(reserve.stone >= 82)
  assert.deepStrictEqual(noStoneReserve, {})
}

function testBuildingAcceptanceFixtureFoodReserveScalesForLongBuilds() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const small = {
    name: 'small_fixture',
    blocks: Array.from({ length: 8 }, (_, index) => ({ x: index, y: 0, z: 0, type: 'stone' }))
  }
  const large = {
    name: 'large_fixture',
    blocks: Array.from({ length: 996 }, (_, index) => ({
      x: index % 14,
      y: Math.floor(index / (14 * 12)),
      z: Math.floor(index / 14) % 12,
      type: 'stone'
    }))
  }

  const smallReserve = buildingAcceptance._test.fixtureFoodReserveForBlueprint(small)
  const largeReserve = buildingAcceptance._test.fixtureFoodReserveForBlueprint(large)

  assert.deepStrictEqual(smallReserve, { item: 'cooked_beef', count: 8 })
  assert.deepStrictEqual(largeReserve, { item: 'cooked_beef', count: 32 })
}

function testBuildingAcceptanceFixtureFoodReserveCommandsRestoreHunger() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const commands = buildingAcceptance._test.fixtureFoodReserveCommands('LinXia', {
    item: 'cooked_beef',
    count: 32
  })

  assert.deepStrictEqual(commands, [
    'give LinXia minecraft:cooked_beef 32',
    'effect give LinXia minecraft:saturation 5 10 true'
  ])
}

function testBuildingAcceptanceClearsFixtureStorageLane() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const commands = buildingAcceptance._test.fixtureStorageClearCommands({
    minX: 548,
    maxX: 561,
    minZ: -62,
    maxZ: -51
  }, { x: 548, y: 69, z: -54 })

  assert.ok(commands.length >= 1)
  assert.ok(commands.every(command => command.includes(' minecraft:air')))
  assert.ok(commands.some(command => command.includes('524 65 -78')))
}

function testBuildingAcceptanceStorageChestsAlignWithRuntimeAnchors() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const blueprint = {
    name: 'storage_anchor_fixture',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'stone' },
      { x: 13, y: 20, z: 11, type: 'stone' }
    ]
  }
  const origin = { x: 659, y: 90, z: 41 }
  const buildBounds = buildingAcceptance._test.blueprintBuildBounds(blueprint, origin)
  const fixtureBounds = buildingAcceptance._test.blueprintBounds(blueprint, origin)
  const positions = buildingAcceptance._test.storagePositionsForMaterials(buildBounds, origin, {
    chest: 5,
    lantern: 23
  })

  assert.deepStrictEqual(positions[0], { x: 656, y: 90, z: 37 })
  assert.strictEqual(positions[0].x, buildBounds.minX - 3)
  assert.strictEqual(positions[0].z, buildBounds.minZ - 4)
  assert.notStrictEqual(positions[0].x, fixtureBounds.minX - 3)
  assert.notStrictEqual(positions[0].z, fixtureBounds.minZ - 4)
}

function testResumeScenarioJudgement() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const { judgeResumeScenario, summarizeResumeProgress } = buildingAcceptance._test
  const activeRuns = [{
    runId: 'run_a',
    blueprintId: 'villa_bp',
    status: 'ACTIVE',
    placementContext: { origin: { x: 580, y: 65, z: -104 } }
  }]
  const decisionLine = '[BUILDING_RUN_DECISION] {"runId":"run_a","resumeOrFresh":"resume","reason":"ACTIVE_RUN_COMPATIBLE"}'
  const placementLine = '[BUILD_CONSTRUCTION_RUN_RESUME_PLACEMENT] runId=run_a blueprint=villa_bp origin=580,65,-104'
  const steps = Array.from({ length: 12 }, (_, i) => `[BUILD_STEP] index=${i} kind=place phase=frame pos=0,0,0 block=stone`)

  // Healthy resume: stored run adopted at stored origin, enough progress.
  const pass = judgeResumeScenario({
    activeRuns,
    summary: summarizeResumeProgress([decisionLine, placementLine, ...steps]),
    minSteps: 10
  })
  assert.strictEqual(pass.judgment, 'PASS')
  assert.strictEqual(pass.matchedRun.runId, 'run_a')

  // Adopting any origin other than the stored one is a machinery failure.
  const mismatch = judgeResumeScenario({
    activeRuns,
    summary: summarizeResumeProgress([
      decisionLine,
      '[BUILD_CONSTRUCTION_RUN_RESUME_PLACEMENT] runId=run_a blueprint=villa_bp origin=647,65,-104',
      ...steps
    ]),
    minSteps: 10
  })
  assert.strictEqual(mismatch.judgment, 'FAIL')
  assert.strictEqual(mismatch.failureReason, 'resume_origin_mismatch')

  // A material shortage is an environment problem, not a machinery verdict.
  const shortage = judgeResumeScenario({
    activeRuns,
    summary: summarizeResumeProgress([
      placementLine,
      '[task-manager] fail task=build_blueprint id=3 reason=BLOCKED_MATERIAL_SHORTAGE:quartz_block:75'
    ]),
    minSteps: 10
  })
  assert.strictEqual(shortage.judgment, 'BLOCKED')

  // Never adopting the stored run at all fails immediately.
  const notEngaged = judgeResumeScenario({
    activeRuns,
    summary: summarizeResumeProgress([...steps]),
    minSteps: 10
  })
  assert.strictEqual(notEngaged.judgment, 'FAIL')
  assert.strictEqual(notEngaged.failureReason, 'resume_placement_not_engaged')

  // Stalling below the progress floor is a failure, not a silent pass.
  const stalled = judgeResumeScenario({
    activeRuns,
    summary: summarizeResumeProgress([decisionLine, placementLine, steps[0]]),
    minSteps: 10
  })
  assert.strictEqual(stalled.judgment, 'FAIL')
  assert.ok(stalled.failureReason.startsWith('resume_insufficient_progress'))

  // A terminal failure inside the window fails even with enough steps.
  const terminal = judgeResumeScenario({
    activeRuns,
    summary: summarizeResumeProgress([
      decisionLine,
      placementLine,
      ...steps,
      '[task-manager] fail task=build_blueprint id=4 reason=fluid_activation_reference_unreachable'
    ]),
    minSteps: 10
  })
  assert.strictEqual(terminal.judgment, 'FAIL')
  assert.strictEqual(terminal.failureReason, 'resume_terminal_failed:fluid_activation_reference_unreachable')
}

function testResumeScenarioSelectableAndNonDestructive() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const selected = buildingAcceptance._test.selectedBuildingScenarios(undefined, 'case3_resume_active_run')
  assert.strictEqual(selected.length, 1)
  assert.strictEqual(selected[0].scenario.resumeExisting, true)
  assert.strictEqual(selected[0].scenario.id, 'case3_resume_active_run')
}

function testBuildingAcceptanceScenarioFilterSelectsFocusedCases() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const cases = [
    { id: 'case1_two_story_house', testName: 'case1 house', blueprintName: 'two_story_wood_house' },
    { id: 'case2_modern_villa', testName: 'case2 modern', blueprintName: 'modern_villa' }
  ]

  let selected = buildingAcceptance._test.selectedBuildingScenarios(cases, 'case1_two_story_house')
  assert.strictEqual(selected.length, 1)
  assert.strictEqual(selected[0].scenario.blueprintName, 'two_story_wood_house')
  assert.strictEqual(selected[0].index, 0)

  selected = buildingAcceptance._test.selectedBuildingScenarios(cases, 'case2,modern_villa')
  assert.strictEqual(selected.length, 1)
  assert.strictEqual(selected[0].scenario.id, 'case2_modern_villa')
  assert.strictEqual(selected[0].index, 1)

  selected = buildingAcceptance._test.selectedBuildingScenarios(cases, '')
  assert.strictEqual(selected.length, 2)
}

function testBuildingAcceptanceMergesEarlyAndTailLogs() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const logs = buildingAcceptance._test.mergeLogLines(
    ['[ROUTER] actionKey=BUILD', '[BUILD_SITE_SCAN] blueprint=house'],
    ['[TaskManager] completed #1 build_blueprint'],
    ['[BUILD_SITE_SCAN] blueprint=house', '[BUILD_VALIDATION] ok=true']
  )

  assert.deepStrictEqual(logs, [
    '[ROUTER] actionKey=BUILD',
    '[BUILD_SITE_SCAN] blueprint=house',
    '[TaskManager] completed #1 build_blueprint',
    '[BUILD_VALIDATION] ok=true'
  ])
}

function testBuildingAcceptanceReportsPauseBeforeTerminalTimeout() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const reason = buildingAcceptance._test.failureReason({
    intentObserved: true,
    taskStarted: true,
    terminalObserved: false,
    taskPauseReason: 'survival_low_food_critical'
  })

  assert.strictEqual(
    buildingAcceptance._test.latestBuildTaskPauseReason([
      '[Task:build_blueprint#1] pause: survival_low_food_critical',
      '[survival] health=20 food=2 owner=bot action=REMIND dangerLevel=none'
    ]),
    'survival_low_food_critical'
  )
  assert.strictEqual(reason, 'build_task_paused:survival_low_food_critical')
}

function testBuildingAcceptanceFaithfulTimeoutCoversLongCommunityBuilds() {
  const buildingAcceptance = require('../acceptance/cases/building.acceptance')
  const timeout = buildingAcceptance._test.resolveScenarioTimeoutMs(
    { timeoutMs: 180000 },
    {},
    { summary: { sourceMode: 'faithful-community-import', nonAirCount: 996 } }
  )
  const nonFaithfulTimeout = buildingAcceptance._test.resolveScenarioTimeoutMs(
    { timeoutMs: 180000 },
    {},
    { summary: { sourceMode: 'procedural', nonAirCount: 996 } }
  )

  assert.ok(timeout >= 50 * 60 * 1000, `timeout=${timeout}`)
  assert.ok(timeout <= 90 * 60 * 1000, `timeout=${timeout}`)
  assert.strictEqual(nonFaithfulTimeout, 180000)
}

async function testScaffoldPlanBuildsAndRemovesTemporaryBlocks() {
  const blueprint = {
    name: 'high_block',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 0, y: 4, z: 0, type: 'oak_planks' }
    ]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([
    { name: 'oak_planks', count: 2 },
    { name: 'dirt', count: 5 }
  ])
  const task = createSyntheticBuildTask(11, {
    blueprintName: 'high_block',
    origin: { x: 0, y: 64, z: 0 },
    buildingOptions: { blueprintDir: dir }
  })

  await task.start(ctx)
  for (let i = 0; i < 5 && task.state === 'RUNNING'; i++) await task.update(ctx)

  assert.strictEqual(task.state, 'COMPLETED')
  assert.ok(task.scaffoldBlocks > 0)
  assert.strictEqual(task.scaffoldBlocks, task.removedScaffoldBlocks)
  assert.strictEqual(ctx.bot.blockAt(vec(0, 68, 0)).name, 'oak_planks')
  assert.strictEqual(ctx.bot.blockAt(vec(-1, 68, 0)).name, 'air')
}

async function testProtectedObstructionBlocksBuild() {
  const ctx = createContext([{ name: 'oak_planks', count: 2 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'chest' }]
  })
  const system = createSyntheticBuildingSystem()
  const preview = system.previewBlueprint(ctx, 'small_house', { x: 0, y: 64, z: 0 })
  assert.strictEqual(preview.canBuild, false)
  assert.ok(preview.blockedReasons[0].startsWith('protected_obstruction:chest'))
}

function createCountingConstructionRunStore() {
  const writes = []
  return {
    writes,
    upsertRun(run) {
      const saved = JSON.parse(JSON.stringify(run))
      writes.push(saved)
      return saved
    }
  }
}

function createCheckpointTestSystem(store) {
  const system = new BuildingSystem({
    communityCollector: createSyntheticCollector(),
    constructionRunStore: store,
    constructionCheckpointStepInterval: 3,
    constructionCheckpointMaxIntervalMs: 60000
  })
  system.session = {
    constructionRunId: 'construction_run_checkpoint_test',
    constructionRun: {
      runId: 'construction_run_checkpoint_test',
      status: 'ACTIVE',
      currentPhase: 'wall',
      lifecycle: {},
      steps: {}
    }
  }
  return system
}

function checkpointStep(index) {
  return {
    id: `checkpoint-step-${index}`,
    kind: 'place',
    phase: 'wall',
    blockName: 'oak_planks',
    position: { x: index, y: 64, z: 0 }
  }
}

function verifyCheckpointStep(system, step) {
  system.updateConstructionStep(step, 'ready')
  system.updateConstructionStep(step, 'executing')
  system.updateConstructionStep(step, 'placed')
  system.updateConstructionStep(step, 'verified')
}

function testBuildingBatchesConstructionCheckpointPersistence() {
  const store = createCountingConstructionRunStore()
  const system = createCheckpointTestSystem(store)

  verifyCheckpointStep(system, checkpointStep(1))
  verifyCheckpointStep(system, checkpointStep(2))
  assert.strictEqual(store.writes.length, 0, 'transient and sub-batch states must stay in memory')

  verifyCheckpointStep(system, checkpointStep(3))
  assert.strictEqual(store.writes.length, 1)
  assert.strictEqual(store.writes[0].checkpoint.reason, 'verified_step_batch')
  assert.strictEqual(store.writes[0].checkpoint.verifiedSincePrevious, 3)
  assert.strictEqual(
    Object.values(store.writes[0].steps).filter(step => step.status === 'verified').length,
    3
  )

  verifyCheckpointStep(system, checkpointStep(4))
  assert.strictEqual(store.writes.length, 1)
  const pauseCheckpoint = system.checkpointConstructionRun('task_pause')
  assert.strictEqual(pauseCheckpoint.flushed, true)
  assert.strictEqual(store.writes.length, 2)
  assert.strictEqual(store.writes[1].checkpoint.reason, 'task_pause')
  assert.strictEqual(store.writes[1].steps['checkpoint-step-4'].status, 'verified')

  const resumed = createCheckpointTestSystem(store)
  resumed.session.constructionRun = JSON.parse(JSON.stringify(store.writes[1]))
  resumed.session.constructionRunId = resumed.session.constructionRun.runId
  assert.strictEqual(
    Object.values(resumed.session.constructionRun.steps).filter(step => step.status === 'verified').length,
    4,
    'a new BuildingSystem must be able to resume from the latest flushed checkpoint'
  )

  const failedStep = checkpointStep(5)
  resumed.updateConstructionStep(failedStep, 'ready')
  resumed.updateConstructionStep(failedStep, 'executing')
  resumed.updateConstructionStep(failedStep, 'terminal_failed', { retryError: 'place_failed' })
  assert.strictEqual(store.writes.length, 3, 'terminal failure must flush immediately')
  assert.strictEqual(store.writes[2].checkpoint.reason, 'step_failure')
  assert.strictEqual(store.writes[2].steps[failedStep.id].status, 'terminal_failed')
}

async function testBuildTaskFlushesCheckpointAtLifecycleBoundaries() {
  const reasons = []
  const system = {
    checkpointConstructionRun(reason) {
      reasons.push(reason)
      return { flushed: true }
    },
    getStatus() {
      return null
    }
  }
  const ctx = createContext([])

  let task = new BuildTask({ id: 81, params: { buildingSystem: system } })
  task.state = 'RUNNING'
  await task.pause(ctx, 'test_pause')

  task = new BuildTask({ id: 82, params: { buildingSystem: system } })
  task.state = 'RUNNING'
  await task.fail(ctx, 'test_failure')

  task = new BuildTask({ id: 83, params: { buildingSystem: system } })
  task.state = 'RUNNING'
  await task.interrupt(ctx, 'test_interrupt')

  task = new BuildTask({ id: 84, params: { buildingSystem: system } })
  task.state = 'RUNNING'
  await task.complete(ctx, { ok: true })

  assert.deepStrictEqual(reasons, [
    'task_pause',
    'task_fail',
    'task_interrupt',
    'task_complete'
  ])
}

async function testPauseResumeInterruptLifecycle() {
  let ctx = createContext(richBuildItems())
  let task = createSyntheticBuildTask(6, { blueprintName: 'small_house', origin: { x: 0, y: 64, z: 0 } })
  await task.start(ctx)
  await task.update(ctx)
  assert.strictEqual(ctx.placed.length, 3)
  await task.pause(ctx, 'test_pause')
  await task.update(ctx)
  assert.strictEqual(ctx.placed.length, 3)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)

  await task.resume(ctx)
  await task.update(ctx)
  assert.strictEqual(ctx.placed.length, 6)

  ctx = createContext(richBuildItems())
  task = createSyntheticBuildTask(7, { blueprintName: 'small_house', origin: { x: 0, y: 64, z: 0 } })
  await task.start(ctx)
  await task.update(ctx)
  assert.strictEqual(ctx.placed.length, 3)
  await task.interrupt(ctx, 'test_interrupt')
  await task.update(ctx)
  assert.strictEqual(ctx.placed.length, 3)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testTaskManagerBuildStatus() {
  const ctx = createContext(richBuildItems())
  const manager = new TaskManager(ctx.bot, {
    actionLock: ctx.actionLock,
    blackboard: ctx.blackboard,
    memory: ctx.memory,
    debug: false,
    enableTaskFeedback: false
  })

  manager.enqueue('build_blueprint', {
    blueprintName: 'small_house',
    origin: { x: 0, y: 64, z: 0 },
    buildingOptions: { allowSyntheticSamples: true, requireRealCommunity: false, constructionRunStore: false }
  }, 5, 'test')
  await manager.tick(ctx)

  const status = manager.status()
  assert.strictEqual(status.currentBuildTask.blueprintName, 'small_house')
  assert.strictEqual(status.blueprintName, 'small_house')
  assert.ok(status.placedBlocks > 0)
  assert.ok(status.placedBlocks <= 3)
  assert.strictEqual(status.currentBuildTask.scaffoldBlocks, 0)
  assert.ok(status.totalBlocks > 26)
  assert.strictEqual(status.currentBuildTask.designPlan.transformed, true)
  assert.strictEqual(status.currentBuildTask.designPlan.metrics.pureBox, false)
  assert.strictEqual(status.currentBuildTask.aestheticPlan.accepted, true)
  assert.ok(status.currentBuildTask.aestheticPlan.final.similarity_to_good_builds >= status.currentBuildTask.aestheticPlan.similarityThreshold)
  assert.strictEqual(status.buildStatus, 'RUNNING')
  assert.ok(status.buildingSitePlan)
  assert.ok(status.totalBuildSteps > 0)
}

async function testPlanningBuildPlanCreatesBuildTask() {
  const taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source, state: 'COMPLETED', result: { ok: true } }
      this.enqueued.push(task)
      return task
    },
    status() {
      return {
        currentTask: null,
        queue: [],
        pausedStack: [],
        recentCompleted: this.enqueued,
        recentFailed: [],
        recentInterrupted: []
      }
    }
  }
  const context = { ...createContext([{ name: 'oak_planks', count: 30 }]), taskManager }
  const planningSystem = new PlanningSystem()
  const submitted = await planningSystem.createAndSubmitPlan('build_small_house', context)
  await planningSystem.update(context)

  assert.strictEqual(submitted.ok, true)
  assert.strictEqual(taskManager.enqueued[0].type, 'build_blueprint')
  assert.strictEqual(taskManager.enqueued[0].params.blueprintName, 'small_house')

  const modernPlanningSystem = new PlanningSystem()
  const modernSubmitted = await modernPlanningSystem.createAndSubmitPlan('build_modern_villa', context)
  await modernPlanningSystem.update(context)
  assert.strictEqual(modernSubmitted.ok, true)
  assert.strictEqual(taskManager.enqueued[1].type, 'build_blueprint')
  assert.strictEqual(taskManager.enqueued[1].params.blueprintName, 'modern_villa')
}

function testSimpleWoodCabinHasRealUsableBed() {
  const blueprint = new ProceduralBlueprintGenerator().generate('simple_wood_cabin').blueprint
  const beds = blueprint.blocks.filter(block => block.type === 'white_bed')
  assert.strictEqual(beds.length, 2)
  const foot = beds.find(block => block.states?.part === 'foot')
  const head = beds.find(block => block.states?.part === 'head')
  assert.ok(foot && head, 'bed must have explicit foot and head halves')
  assert.strictEqual(foot.states.facing, head.states.facing)
  // Vanilla convention: head = foot + facing (south -> +z).
  assert.strictEqual(head.x, foot.x)
  assert.strictEqual(head.z, foot.z + 1)
  assert.ok(!blueprint.blocks.some(block => block.type === 'white_wool'), 'wool bed placeholder must be gone')
  // Torches must sit on solid support so in-game placement stays 'torch'.
  for (const torch of blueprint.blocks.filter(block => block.type === 'torch')) {
    const below = blueprint.blocks.find(block => block.x === torch.x && block.y === torch.y - 1 && block.z === torch.z)
    assert.ok(below && below.type !== 'air', `torch at ${torch.x},${torch.y},${torch.z} needs support`)
  }
  const gate = new BuildingHardGate().evaluateBlueprint(blueprint, { blueprintName: 'simple_wood_cabin' })
  assert.strictEqual(gate.ok, true, JSON.stringify(gate.failures))
  // With a real bed both halves join the functional-block usability check.
  assert.deepStrictEqual(gate.metrics.unusableFunctionalBlocks, [])
}

function testSimpleTwoStoryCabinHasRealBedAndSupportedTorches() {
  const blueprint = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin').blueprint
  const beds = blueprint.blocks.filter(block => block.type === 'white_bed')
  assert.strictEqual(beds.length, 2)
  const foot = beds.find(block => block.states?.part === 'foot')
  const head = beds.find(block => block.states?.part === 'head')
  assert.ok(foot && head, 'bed must have explicit foot and head halves')
  assert.strictEqual(foot.states.facing, head.states.facing)
  // Vanilla convention: head = foot + facing (south -> +z).
  assert.strictEqual(head.x, foot.x)
  assert.strictEqual(head.z, foot.z + 1)
  assert.ok(!blueprint.blocks.some(block => block.type === 'white_wool'), 'wool bed placeholder must be gone')
  // Both halves must rest on second-floor planks, not over the stairwell opening.
  for (const half of beds) {
    const below = blueprint.blocks.find(block => block.x === half.x && block.y === half.y - 1 && block.z === half.z)
    assert.ok(below && below.type === 'oak_planks', `bed half at ${half.x},${half.y},${half.z} needs solid support`)
  }
  for (const torch of blueprint.blocks.filter(block => block.type === 'torch')) {
    const below = blueprint.blocks.find(block => block.x === torch.x && block.y === torch.y - 1 && block.z === torch.z)
    assert.ok(below && below.type !== 'air', `torch at ${torch.x},${torch.y},${torch.z} needs support`)
  }
  const gate = new BuildingHardGate().evaluateBlueprint(blueprint, { blueprintName: 'simple_two_story_cabin' })
  assert.strictEqual(gate.ok, true, JSON.stringify(gate.failures))
  assert.deepStrictEqual(gate.metrics.unusableFunctionalBlocks, [])
  assert.strictEqual(gate.metrics.detectedStories, 2)
  assert.strictEqual(gate.metrics.continuousStairPath, true)
  // The runtime executes canonical phases with a hard barrier
  // (frame -> floor -> wall). Story-2 corner posts tagged 'frame' would be
  // scheduled before the second-floor slab exists (live failure in
  // construction_run_37f0041d208e745e), so they must ride the wall phase.
  for (const block of blueprint.blocks.filter(entry => entry.role === 'corner_post' && entry.y >= 5)) {
    assert.strictEqual(block.phase, 'wall', `story-2 corner post at ${block.x},${block.y},${block.z} must use wall phase`)
  }
}

function testTightenedStairGateRejectsBodyWidthHeadBonk() {
  // Regression fixture: the ORIGINAL L3 stair geometry (run x=1..4 starting at
  // the west wall, slab cell (1,4,4) solid). A real player head-bonks the slab
  // while stepping S1->S2 because their 0.6-wide body still straddles column
  // x=1 as their head rises past y=4 (live user report: could not climb
  // without breaking blocks). The tightened body-width continuousStairPath
  // must now REJECT this geometry.
  const blueprint = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin').blueprint
  const keyOf = block => `${block.x},${block.y},${block.z}`
  const blocks = blueprint.blocks
    .filter(block => block.role !== 'simple_stair')
    .filter(block => !(block.role === 'stairwell' && block.x === 4 && block.y === 4 && block.z === 4))
  const byKey = new Map(blocks.map(block => [keyOf(block), block]))
  // restore slab where the new top stair sits, place the old-style stair run
  byKey.set('5,4,4', { x: 5, y: 4, z: 4, type: 'oak_planks', phase: 'floor', role: 'second_floor' })
  for (const [x, y, z] of [[1, 1, 4], [2, 2, 4], [3, 3, 4], [4, 4, 4]]) {
    byKey.set(`${x},${y},${z}`, {
      x, y, z,
      type: 'oak_stairs', phase: 'stairs', role: 'simple_stair',
      states: { facing: 'east', half: 'bottom', shape: 'straight' }
    })
  }
  const oldGeometry = { ...blueprint, blocks: [...byKey.values()] }
  const gate = new BuildingHardGate().evaluateBlueprint(oldGeometry, { blueprintName: 'simple_two_story_cabin_old_stairs' })
  assert.strictEqual(gate.metrics.continuousStairPath, false,
    'old head-bonk stair geometry must fail the tightened body-width gate')
  assert.strictEqual(gate.ok, false)

  // and the CURRENT generator geometry passes the tightened gate
  const current = new BuildingHardGate().evaluateBlueprint(blueprint, { blueprintName: 'simple_two_story_cabin' })
  assert.strictEqual(current.metrics.continuousStairPath, true, JSON.stringify(current.failures))
  assert.strictEqual(current.ok, true, JSON.stringify(current.failures))
}

function testRoomsCrosscheckFailsUnderdeclaredTwoStory() {
  // Loophole fixture: a genuine two-story building whose rooms metadata only
  // declares the ground floor. Declared rooms drive detectStories, so without
  // the cross-check detectedStories=1 makes the stair-path requirement
  // vacuous — underdeclaring rooms could smuggle an unclimbable second floor
  // past the gate. The reachable-story cross-check must FAIL it.
  const blueprint = new ProceduralBlueprintGenerator().generate('simple_two_story_cabin').blueprint
  const underdeclared = {
    ...blueprint,
    metadata: {
      ...blueprint.metadata,
      rooms: (blueprint.metadata.rooms || []).filter(room => (room.bounds?.minY ?? Infinity) <= 1)
    }
  }
  assert.ok(underdeclared.metadata.rooms.length > 0, 'fixture must keep its ground-floor rooms declared')
  // Neutral name: requiredStories=1, so every OTHER check passes and the
  // failure is pinned to the cross-check alone.
  const gate = new BuildingHardGate().evaluateBlueprint(underdeclared, { blueprintName: 'cozy_cabin' })
  assert.strictEqual(gate.ok, false, 'underdeclared two-story must fail the gate')
  assert.deepStrictEqual(gate.failures, ['roomsStoryCrosscheck'],
    `cross-check must be the exact failure: ${JSON.stringify(gate.failures)}`)
  assert.deepStrictEqual(gate.metrics.roomsStoryCrosscheck.reachableHeuristicLevels, [1, 5])
  assert.deepStrictEqual(gate.metrics.roomsStoryCrosscheck.declaredStoryLevels, [1])

  // The honest declaration passes, and the SEALED attic void under the gabled
  // roof stays exempt: the raw heuristic sees 3 levels [1,5,9], but y=9 is
  // unreachable, so the cross-check compares [1,5] vs declared [1,5].
  const honest = new BuildingHardGate().evaluateBlueprint(blueprint, { blueprintName: 'simple_two_story_cabin' })
  assert.strictEqual(honest.ok, true, JSON.stringify(honest.failures))
  assert.deepStrictEqual(honest.metrics.roomsStoryCrosscheck.reachableHeuristicLevels, [1, 5])
  assert.deepStrictEqual(honest.metrics.roomsStoryCrosscheck.declaredStoryLevels, [1, 5])
  const strippedRooms = { ...blueprint, metadata: { ...blueprint.metadata, rooms: [] } }
  const heuristicOnly = new BuildingHardGate().evaluateBlueprint(strippedRooms, { blueprintName: 'cozy_cabin' })
  assert.deepStrictEqual(heuristicOnly.metrics.storyLevels, [1, 5, 9],
    'raw heuristic must still see the attic; reachability is what exempts it')
  assert.strictEqual(heuristicOnly.metrics.roomsStoryCrosscheck.applicable, false,
    'cross-check only applies when a rooms declaration drives the story count')
}

async function run() {
  testSimpleWoodCabinHasRealUsableBed()
  testSimpleTwoStoryCabinHasRealBedAndSupportedTorches()
  testTightenedStairGateRejectsBodyWidthHeadBonk()
  testRoomsCrosscheckFailsUnderdeclaredTwoStory()
  await testLoadBlueprint()
  await testInvalidBlueprintDoesNotCrash()
  await testMissingBlueprintAndBadJson()
  await testDangerousAndBadTypeBlueprintsRejected()
  await testMaterialCounting()
  await testBlueprintRankingPrefersCommunityPopularity()
  await testBlueprintSelectorChoosesCommunityCandidate()
  await testBlueprintSelectorProceduralFallback()
  await testBuildingComplexityIntentMapping()
  await testNamedVillaAndCastlePreserveFormalScaleWithoutImplicitL2()
  await testResumeBuildIntentPreservesFaithfulBlueprintAndForbidsFreshRun()
  await testShowcaseBuildRequiresConfirmationBeforeTask()
  await testBlueprintSelectorFiltersByComplexityBudget()
  await testL3BudgetRejectsP9RDecorations()
  await testConstructionEstimateReportsBudgetAndTime()
  await testBudgetedSimpleTwoStoryPreviewUsesProceduralTemplate()
  await testRebuildTwoStoryPreviewPreservesFaithfulCommunityImport()
  await testSmallerDesignSpecReducesConstructionPlanSteps()
  await testProceduralBlueprintGeneratorSupportsRequiredTypes()
  await testBuildingDesignerTransformsBoxyBlueprintsIntoArchitecture()
  await testBuildingDesignerOutputsDesignSchema()
  await testCommunityCollectorLoadsEncodedAestheticSamples()
  await testStructureEncoderProducesSimilarityReadyGraph()
  await testAestheticModelPenalizesBoxAndScoresRefinedBuild()
  await testAestheticRefinerImprovesLowScoreBlueprint()
  await testInteriorPlannerAddsRequiredFurnitureAndAvoidsPaths()
  await testFunctionalLayoutAndWalkabilityForP8Cases()
  await testInteriorUsabilityRejectsFurnitureBlockingMainPath()
  await testWalkabilityRejectsJumpDependentPath()
  await testBuildTaskMissingMaterials()
  await testBuildTaskPlacesBlock()
  await testBuildTaskWaitsForAsyncSessionBeforePlacing()
  await testBuildTaskPassesExplicitRebuildOption()
  await testBuildTaskPassesResumeOnlyGuard()
  testDistantOriginIsAllowedOnlyForStoredResumePlacement()
  testTerrainAlternativesReserveInventoryForOriginalSteps()
  await testBuildTaskStartExceptionFailsCleanly()
  await testOccupiedPositionClearsThenBuilds()
  await testDangerHighRefusesBuild()
  await testBuildIntentRules()
  await testMemoryWriteOnComplete()
  await testPreviewBlueprint()
  await testPreviewIgnoresBuilderEntityInFootprint()
  await testPreviewCommunityBlueprintWithInterior()
  await testSiteScanPlansObstructionsAndSkipsCorrectBlocks()
  testSurfaceDirtAndGrassAreStableEquivalentOnlyAtBuildOrigin()
  testSitePlanAndFinalValidationAcceptLegacyWallSkullVariant()
  testResumeReconciliationIgnoresClassicSchematicProvenanceStates()
  await testBuildOrderClearsObstructionColumnsTopDown()
  await testSiteScanTreatsWaterAsReplaceableForSolidTargets()
  await testSiteMaterialPlanCountsPottedPlantItems()
  await testFoundationFillPlanForAirUnderBlueprint()
  await testBuildOrderDelaysTemporarilyUnsupportedBlocks()
  testStatefulSlabWaitsForPlannedPermanentReference()
  testStatefulSlabDependencyKeepsTopPathAndHandlesDoubleSlab()
  testHangingLanternDependencyWinsOverInvalidReverseSlabDependency()
  testLanternPhysicalDependencyProfilesRemainDistinct()
  testHangingLanternTransformKeepsTopSupportAligned()
  await testBuildOrderDefersFluidsUntilAfterSolidPlacements()
  await testBuildOrderPlacesEnclosedFluidBeforeDirectTopOccluder()
  await testBuildOrderDelaysWallSignUntilFacingSupportExists()
  await testBuildOrderDelaysHangingLanternUntilTopSupportExists()
  await testBuildOrderAllowsTripwireHookFallbackSideSupport()
  await testBuildTaskFillsFoundationBeforePlacement()
  await testMaterialRefillRequestsFullGapFromStorage()
  await testMaterialRefillCanAggregateMultipleChestSources()
  await testStagedMaterialRefillReleasesInventorySlotWhenFull()
  await testInventoryBatchUsesOnlyPrimaryWhenPrimaryEnough()
  await testInventoryBatchFallsBackToSecondaryOnlyOnPrimaryShortage()
  await testInventoryBatchReservesOneRetryItemForRepairPlacements()
  await testInventoryBatchSkipsChestWhenInventorySatisfiesPlan()
  await testInventoryBatchDoesNotReopenWithinSameBatch()
  await testInventoryBatchMergesNextHundredStepsAndPreservesEmptySlots()
  await testInventoryBatchPrioritizesCurrentStepMaterialWhenSlotsLimited()
  await testEnsureMaterialItemUsesBatchBeforeLegacyRefill()
  await testEnsureMaterialUsesHeldItemWhenInventoryListOmitsIt()
  await testWaterPlacementConsumedBucketCanRefillAndRetry()
  await testWaterPlacementNoStockReportsStagingShortageWithoutActivation()
  await testPlacementConsumedItemCanRefillAndRetry()
  await testPlacementConsumedItemReportsStagingShortage()
  await testPlacementConsumedItemRefillRetryCap()
  await testLargeVerticalTravelUsesAdaptiveMoveTimeout()
  await testLargeVerticalTerrainPlacementUsesSafeDescentOptions()
  await testBaseLayerTerrainPlacementKeepsSurfaceViaReservedAirStand()
  await testBaseLayerRepairWithoutTerrainRoleKeepsCompletedSurface()
  await testGroundPlantPlacementKeepsSurfaceViaReservedAirStand()
  await testHighPlacementClimbsViaReservedAirStand()
  await testBelowFloorTerrainPlacementClimbsViaReservedAirStand()
  await testLargeVerticalClearUsesAdaptiveMoveTimeout()
  await testHighStateRepairClearUsesAdaptiveMoveTimeout()
  await testPottedStepRefillsPlantItemBeforePlacement()
  await testPottedSaplingDoesNotUseGroundSupportRepair()
  await testGroundPlantStepRepairsMissingVerifiedSupport()
  await testUpperHalfGroundPlantUsesLowerHalfAsSupport()
  await testNoSupportStepRepairsPlannedReferenceFirst()
  await testUnstableAirStepRepairsPlannedReferenceFirst()
  await testNoSupportRepairSkipsNonReferencePlannedBlocks()
  await testTemporaryReferenceFailureRepairsPlannedReference()
  await testFenceGateOpenStateDoesNotForceStateRepair()
  await testUpperDoorStateRepairUsesLowerDoorPlacement()
  await testLowerDoorStateRepairClearsUpperBeforePlacement()
  await testScaffoldExecutionPrefersReachableLowStand()
  await testScaffoldExecutionRecoversFromTimeoutWithReachableReference()
  await testRepeatedOptionalScaffoldMoveTimeoutIsSkipped()
  await testPlacementTargetOccupiedIsRetryableConstructionFailure()
  await testResumeHydratesStoredStatesBeforeExecutingStep()
  await testStateRepairStatusSurvivesExecutingTransitionForProtectedFurnace()
  await testFirstPostScaffoldPlacementAllowsTemporaryDescentDig()
  await testClearBlockUsesAppropriateTool()
  await testScaffoldBackBridgeBuildsFromSideConnector()
  testBuildingAcceptanceFixtureOriginsKeepCommunitySitesSeparate()
  testBuildingAcceptanceFixtureFillCommandsStayBelowLimit()
  testBuildingAcceptanceFixtureDirtReserveCoversTallScaffold()
  testBuildingAcceptanceFixtureRuntimeMaterialReserveCoversStone()
  testBuildingAcceptanceFixtureFoodReserveScalesForLongBuilds()
  testBuildingAcceptanceFixtureFoodReserveCommandsRestoreHunger()
  testBuildingAcceptanceClearsFixtureStorageLane()
  testBuildingAcceptanceStorageChestsAlignWithRuntimeAnchors()
  testBuildingAcceptanceScenarioFilterSelectsFocusedCases()
  testResumeScenarioJudgement()
  testResumeScenarioSelectableAndNonDestructive()
  testBuildingAcceptanceMergesEarlyAndTailLogs()
  testBuildingAcceptanceReportsPauseBeforeTerminalTimeout()
  testBuildingAcceptanceFaithfulTimeoutCoversLongCommunityBuilds()
  await testScaffoldPlanBuildsAndRemovesTemporaryBlocks()
  await testProtectedObstructionBlocksBuild()
  testBuildingBatchesConstructionCheckpointPersistence()
  await testBuildTaskFlushesCheckpointAtLifecycleBoundaries()
  await testPauseResumeInterruptLifecycle()
  await testTaskManagerBuildStatus()
  await testPlanningBuildPlanCreatesBuildTask()
  console.log('blueprint/building tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
