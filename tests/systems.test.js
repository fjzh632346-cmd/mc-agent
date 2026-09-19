const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { MiningSystem, CombatSystem, InventorySystem, SmeltingSystem, UtilityBlockSearch, EquipmentSystem, AutoPreparationSystem } = require('../systems')

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    floored() {
      return vec(Math.floor(x), Math.floor(y), Math.floor(z))
    },
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function createContext(overrides = {}) {
  const block = { name: 'stone', position: vec(2, 64, 0) }
  const items = overrides.items || [
    { name: 'bread', count: 4 },
    { name: 'stone_pickaxe', count: 1 }
  ]
  const bot = {
    username: 'Bot',
    health: overrides.health ?? 20,
    entity: { position: vec(0, 64, 0), onGround: true },
    entities: {
      1: { id: 1, name: 'zombie', type: 'mob', position: vec(3, 64, 0) },
      2: { id: 2, username: 'Alex', type: 'player', position: vec(2, 64, 0) }
    },
    registry: {
      blocksByName: { stone: { id: 1 } },
      itemsByName: {
        cobblestone: { id: 22, name: 'cobblestone' },
        raw_iron: { id: 769, name: 'raw_iron' },
        oak_log: { id: 17, name: 'oak_log' }
      },
      itemsById: {
        22: { id: 22, name: 'cobblestone' },
        769: { id: 769, name: 'raw_iron' },
        17: { id: 17, name: 'oak_log' }
      },
      itemsArray: [
        { id: 22, name: 'cobblestone' },
        { id: 769, name: 'raw_iron' },
        { id: 17, name: 'oak_log' }
      ]
    },
    inventory: {
      items: () => items,
      slots: overrides.slots || Array.from({ length: 45 }, (_, index) => (index >= 9 && index < 12 ? { name: 'occupied' } : null))
    },
    pathfinder: {
      setMovements() {},
      setGoal() {},
      stop() {}
    },
    pvp: {
      attacked: null,
      attack(entity) {
        this.attacked = entity
      },
      stop() {
        this.attacked = null
      }
    },
    blockAt(position) {
      if (position.x === 2 && position.y === 64 && position.z === 0) return block
      return { name: 'air', position }
    },
    findBlock() {
      return block
    },
    canDigBlock() {
      return true
    },
    async dig(blockToDig) {
      this.dug = true
      simulateBlockDrop(this, blockToDig)
    },
    async equip(item) {
      this.heldItem = item
    }
  }

  const blackboard = new Blackboard({
    mobs: {
      dangerLevel: overrides.dangerLevel || 'none',
      hostileMobs: [
        { id: 1, name: 'zombie', distance: 3, position: { x: 3, y: 64, z: 0 } }
      ]
    },
    player: {
      ownerPosition: { x: 2, y: 64, z: 0 }
    }
  })

  return {
    bot,
    blackboard,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json'
  }
}

function simulateBlockDrop(bot, block) {
  const dropName = {
    stone: 'cobblestone',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
    oak_log: 'oak_log'
  }[block?.name] || block?.name
  if (!dropName) return
  const item = bot.registry.itemsByName[dropName] || { id: 999, name: dropName }
  const id = 1000 + Object.keys(bot.entities || {}).length
  bot.entity.position = block.position
  bot.entities[id] = {
    id,
    name: 'item',
    type: 'object',
    displayName: 'Item',
    metadata: { itemId: item.id },
    position: block.position
  }
  const existing = bot.inventory.items().find(candidate => candidate.name === dropName)
  if (existing) existing.count += 1
  else bot.inventory.items().push({ name: dropName, count: 1 })
}

async function testMiningSystem() {
  let context = createContext()
  context.bot.entities = {}
  const mining = new MiningSystem({ defaultBlocks: ['stone'], maxBlocks: 1 })
  const result = await mining.run({ type: 'mine_nearby_block', params: { blockName: 'stone' } }, context)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(context.bot.dug, true)
  assert.strictEqual(context.actionLock.getOwner('digging'), null)

  context = createContext({ items: [] })
  context.bot.entities = {}
  context.equipmentSystem = new EquipmentSystem()
  let autoPrepCalled = false
  context.autoPreparationSystem = {
    async ensureToolForBlock(ctx, blockName) {
      autoPrepCalled = true
      assert.strictEqual(blockName, 'stone')
      ctx.bot.inventory.items().push({ name: 'wooden_pickaxe', count: 1 })
      return { ok: true, itemName: 'wooden_pickaxe', reason: 'prepared' }
    }
  }
  const autoPrepared = await mining.run({ type: 'mine_nearby_block', params: { blockName: 'stone' } }, context)
  assert.strictEqual(autoPrepared.ok, true)
  assert.strictEqual(autoPrepCalled, true)
  assert.strictEqual(context.bot.heldItem?.name, 'wooden_pickaxe')
  assert.strictEqual(context.bot.dug, true)

  context = createContext({ dangerLevel: 'high' })
  context.bot.entities = {}
  const danger = await mining.run({ type: 'mine_nearby_block', params: { blockName: 'stone' } }, context)
  assert.strictEqual(danger.ok, false)
  assert.strictEqual(danger.error, 'danger_too_high')

  context = createContext({
    slots: Array.from({ length: 45 }, (_, index) => (index >= 9 ? { name: 'occupied' } : null))
  })
  context.bot.entities = {}
  const full = await mining.run({ type: 'mine_nearby_block', params: { blockName: 'stone' } }, context)
  assert.strictEqual(full.ok, false)
  assert.strictEqual(full.error, 'inventory_full')

  context = createContext()
  context.bot.entities = {}
  context.bot.dugCount = 0
  let findBlocksCalls = 0
  const blocks = [
    { name: 'iron_ore', position: vec(2, 64, 0) },
    { name: 'deepslate_iron_ore', position: vec(3, 64, 0) },
    { name: 'iron_ore', position: vec(4, 64, 0) }
  ]
  context.bot.registry.blocksByName.iron_ore = { id: 2 }
  context.bot.registry.blocksByName.deepslate_iron_ore = { id: 3 }
  context.bot.findBlocks = () => {
    findBlocksCalls += 1
    return blocks.slice(context.bot.dugCount).map(block => block.position)
  }
  context.bot.blockAt = position => blocks.find(block =>
    block.position.x === position.x && block.position.y === position.y && block.position.z === position.z
  ) || { name: 'air', position }
  context.bot.dig = async block => {
    context.bot.dugCount += 1
    simulateBlockDrop(context.bot, block)
  }
  const loop = await new MiningSystem({ defaultBlocks: ['stone'], maxBlocks: 8 })
    .run({ type: 'mine_nearby_block', params: { blockNames: ['iron_ore', 'deepslate_iron_ore'], count: 3 } }, context)
  assert.strictEqual(loop.ok, true)
  assert.strictEqual(context.bot.dugCount, 3)
  assert.ok(findBlocksCalls >= 3)
  assert.strictEqual(loop.data.finishReason, 'target_count_reached')

  context = createContext()
  context.bot.entities = {}
  context.bot.dugCount = 0
  const twoOreBlocks = [
    { name: 'iron_ore', position: vec(2, 64, 0) },
    { name: 'iron_ore', position: vec(3, 64, 0) }
  ]
  const liveTwoOreBlocks = new Map(twoOreBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.registry.blocksByName.iron_ore = { id: 2 }
  context.bot.findBlocks = () => Array.from(liveTwoOreBlocks.values()).map(block => block.position)
  context.bot.blockAt = position => liveTwoOreBlocks.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.bot.dig = async block => {
    context.bot.dugCount += 1
    simulateBlockDrop(context.bot, block)
    liveTwoOreBlocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const partialCount = await new MiningSystem({ maxBlocks: 8 })
    .run({ type: 'mine_nearby_block', params: { blockNames: ['iron_ore'], count: 3 } }, context)
  assert.strictEqual(partialCount.ok, false)
  assert.strictEqual(context.bot.dugCount, 2)
  assert.strictEqual(partialCount.data.finishReason, 'partial_insufficient_targets')
  assert.strictEqual(partialCount.data.requestedCount, 3)
  assert.strictEqual(partialCount.data.minedCount, 2)

  context = createContext()
  context.bot.entities = {}
  context.bot.dugCount = 0
  const exhaustedOreBlocks = [
    { name: 'iron_ore', position: vec(2, 64, 0) },
    { name: 'iron_ore', position: vec(3, 64, 0) },
    { name: 'iron_ore', position: vec(4, 64, 0) },
    { name: 'iron_ore', position: vec(0, 64, 4) }
  ]
  const liveExhaustedOreBlocks = new Map(exhaustedOreBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.registry.blocksByName.iron_ore = { id: 2 }
  context.bot.findBlocks = () => Array.from(liveExhaustedOreBlocks.values()).map(block => block.position)
  context.bot.blockAt = position => liveExhaustedOreBlocks.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.bot.dig = async block => {
    context.bot.dugCount += 1
    simulateBlockDrop(context.bot, block)
    liveExhaustedOreBlocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const exhausted = await new MiningSystem({ maxBlocks: 8 })
    .run({ type: 'mine_nearby_block', params: { blockNames: ['iron_ore'], count: 8, mineUntilExhausted: true } }, context)
  assert.strictEqual(exhausted.ok, true)
  assert.strictEqual(context.bot.dugCount, 4)
  assert.strictEqual(exhausted.data.finishReason, 'complete_with_no_more_targets')
  assert.strictEqual(exhausted.data.remainingNearbyTargets, 0)

  context = createContext()
  context.bot.entities = {}
  context.bot.dugCount = 0
  context.bot.once = () => {}
  context.bot.removeListener = () => {}
  const unreachableOreBlocks = [
    { name: 'iron_ore', position: vec(2, 64, 0) },
    { name: 'iron_ore', position: vec(3, 64, 0) },
    { name: 'iron_ore', position: vec(4, 64, 0) },
    { name: 'iron_ore', position: vec(4, 64, 4) },
    { name: 'iron_ore', position: vec(20, 64, 0) }
  ]
  const liveUnreachableOreBlocks = new Map(unreachableOreBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.registry.blocksByName.iron_ore = { id: 2 }
  context.bot.findBlocks = () => Array.from(liveUnreachableOreBlocks.values()).map(block => block.position)
  context.bot.blockAt = position => liveUnreachableOreBlocks.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.bot.dig = async block => {
    context.bot.dugCount += 1
    simulateBlockDrop(context.bot, block)
    liveUnreachableOreBlocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const partialUnreachable = await new MiningSystem({ maxBlocks: 8 })
    .run({ type: 'mine_nearby_block', params: { blockNames: ['iron_ore'], count: 8, mineUntilExhausted: true, moveTimeoutMs: 1 } }, context)
  assert.strictEqual(partialUnreachable.ok, false)
  assert.strictEqual(context.bot.dugCount, 4)
  assert.strictEqual(partialUnreachable.data.finishReason, 'partial_move_timeout')
  assert.strictEqual(partialUnreachable.data.remainingNearbyTargets, 1)

  context = createContext()
  context.bot.entities = {}
  context.bot.dugCount = 0
  context.task = { id: 99, state: 'RUNNING' }
  const interruptBlock = { name: 'stone', position: vec(2, 64, 0) }
  context.bot.findBlocks = () => [interruptBlock.position]
  context.bot.blockAt = position => {
    if (position.x === 2 && position.y === 64 && position.z === 0) return interruptBlock
    return { name: 'air', position }
  }
  context.bot.dig = async block => {
    context.bot.dugCount += 1
    simulateBlockDrop(context.bot, block)
    context.task.state = 'INTERRUPTED'
  }
  const interrupted = await new MiningSystem({ defaultBlocks: ['stone'], maxBlocks: 8 })
    .run({ type: 'mine_nearby_block', params: { blockName: 'stone', count: 3 } }, context)
  assert.strictEqual(interrupted.ok, true)
  assert.strictEqual(context.bot.dugCount, 1)
  assert.strictEqual(interrupted.data.finishReason, 'task_interrupted')
  assert.strictEqual(context.actionLock.getOwner('digging'), null)

  context = createContext()
  context.bot.entities = {}
  context.bot.registry.blocksByName.oak_log = { id: 17 }
  context.bot.registry.blocksByName.birch_log = { id: 18 }
  context.bot.findBlocks = () => []
  context.bot.dug = false
  context.bot.dig = async () => {
    context.bot.dug = true
  }
  const noTree = await new MiningSystem({ maxBlocks: 8 })
    .run({
      type: 'mine_nearby_block',
      params: {
        blockName: 'oak_log',
        targetBlock: 'oak_log',
        blockNames: ['oak_log', 'birch_log'],
        count: 8,
        maxDistance: 24
      }
    }, context)
  assert.strictEqual(noTree.ok, false)
  assert.strictEqual(noTree.error, 'nearby_tree_not_found')
  assert.strictEqual(context.bot.dug, false)

  context = createContext({ items: [] })
  context.bot.entities = {}
  context.bot.registry.blocksByName.oak_log = { id: 17 }
  const treeBlocks = [
    { name: 'oak_log', position: vec(2, 64, 0) },
    { name: 'oak_log', position: vec(2, 65, 0) },
    { name: 'oak_log', position: vec(2, 66, 0) }
  ]
  const liveLogs = new Map(treeBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.findBlocks = () => Array.from(liveLogs.values()).map(block => block.position)
  context.bot.blockAt = position => liveLogs.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.equipmentSystem = {
    async equipBestToolForBlock() {
      return { success: true, itemName: 'hand', allowHand: true, preferredTool: 'axe', reason: 'no_required_tool_allow_hand' }
    }
  }
  context.bot.dig = async block => {
    simulateBlockDrop(context.bot, block)
    liveLogs.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const wholeTree = await new MiningSystem({ maxBlocks: 16 })
    .run({
      type: 'mine_nearby_block',
      params: {
        blockName: 'oak_log',
        targetBlock: 'oak_log',
        blockNames: ['oak_log'],
        treeMode: 'tree_count',
        targetTreeCount: 1,
        maxDistance: 24
      }
    }, context)
  assert.strictEqual(wholeTree.ok, true)
  assert.strictEqual(wholeTree.data.treeState.completedTreeCount, 1)
  assert.strictEqual(wholeTree.data.treeState.choppedLogCount, 3)
  assert.strictEqual(wholeTree.data.treeState.finishReason, 'target_count_reached')
  assert.strictEqual(liveLogs.size, 0)

  context = createContext({ items: [] })
  context.bot.entities = {}
  context.bot.registry.blocksByName.oak_log = { id: 17 }
  const onlyOneTreeBlocks = [
    { name: 'oak_log', position: vec(2, 64, 0) },
    { name: 'oak_log', position: vec(2, 65, 0) }
  ]
  const liveOneTree = new Map(onlyOneTreeBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.findBlocks = () => Array.from(liveOneTree.values()).map(block => block.position)
  context.bot.blockAt = position => liveOneTree.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.equipmentSystem = {
    async equipBestToolForBlock() {
      return { success: true, itemName: 'hand', allowHand: true, preferredTool: 'axe', reason: 'no_required_tool_allow_hand' }
    }
  }
  context.bot.dig = async block => {
    simulateBlockDrop(context.bot, block)
    liveOneTree.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const partialTrees = await new MiningSystem({ maxBlocks: 16 })
    .run({
      type: 'mine_nearby_block',
      params: {
        blockName: 'oak_log',
        targetBlock: 'oak_log',
        blockNames: ['oak_log'],
        treeMode: 'tree_count',
        targetTreeCount: 3,
        maxDistance: 24
      }
    }, context)
  assert.strictEqual(partialTrees.ok, false)
  assert.strictEqual(partialTrees.error, 'partial_completed_no_more_trees')
  assert.strictEqual(partialTrees.data.treeState.completedTreeCount, 1)
  assert.strictEqual(partialTrees.data.treeState.targetTreeCount, 3)
  assert.strictEqual(partialTrees.data.treeState.finishReason, 'partial_completed_no_more_trees')
  assert.strictEqual(partialTrees.data.missingTreeCount, 2)

  context = createContext()
  context.bot.entities = {}
  context.bot.registry.blocksByName.oak_log = { id: 17 }
  const logBlocks = Array.from({ length: 5 }, (_, index) => ({ name: 'oak_log', position: vec(2 + index, 64, 0) }))
  const liveLogCount = new Map(logBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.findBlocks = () => Array.from(liveLogCount.values()).map(block => block.position)
  context.bot.blockAt = position => liveLogCount.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.bot.dig = async block => {
    simulateBlockDrop(context.bot, block)
    liveLogCount.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const twoLogs = await new MiningSystem({ maxBlocks: 16 })
    .run({
      type: 'mine_nearby_block',
      params: {
        blockName: 'oak_log',
        targetBlock: 'oak_log',
        blockNames: ['oak_log'],
        treeMode: 'log_count',
        targetLogCount: 2,
        count: 2,
        maxDistance: 24
      }
    }, context)
  assert.strictEqual(twoLogs.ok, true)
  assert.strictEqual(twoLogs.data.treeState.choppedLogCount, 2)
  assert.strictEqual(liveLogCount.size, 3)

  context = createContext()
  context.bot.entities = {}
  context.bot.registry.blocksByName.oak_log = { id: 17 }
  const scarceLogBlocks = Array.from({ length: 5 }, (_, index) => ({ name: 'oak_log', position: vec(2 + index, 64, 0) }))
  const scarceLogs = new Map(scarceLogBlocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  context.bot.findBlocks = () => Array.from(scarceLogs.values()).map(block => block.position)
  context.bot.blockAt = position => scarceLogs.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
  context.bot.dig = async block => {
    simulateBlockDrop(context.bot, block)
    scarceLogs.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  const partialLogs = await new MiningSystem({ maxBlocks: 16 })
    .run({
      type: 'mine_nearby_block',
      params: {
        blockName: 'oak_log',
        targetBlock: 'oak_log',
        blockNames: ['oak_log'],
        treeMode: 'log_count',
        targetLogCount: 10,
        count: 10,
        maxDistance: 24
      }
    }, context)
  assert.strictEqual(partialLogs.ok, false)
  assert.strictEqual(partialLogs.error, 'partial_completed_no_more_trees')
  assert.strictEqual(partialLogs.data.treeState.choppedLogCount, 5)
  assert.strictEqual(partialLogs.data.treeState.targetLogCount, 10)
  assert.strictEqual(partialLogs.data.missingLogCount, 5)
}

async function testCombatSystem() {
  let context = createContext({ items: [{ name: 'iron_sword', count: 1 }] })
  context.equipmentSystem = new EquipmentSystem()
  context.autoPreparationSystem = new AutoPreparationSystem({ equipmentSystem: context.equipmentSystem })
  const combat = new CombatSystem({ minHealthToFight: 8 })
  const result = await combat.run({ type: 'protect_player', params: { holdLock: false } }, context)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.protectingPlayer, true)
  assert.strictEqual(context.bot.pvp.attacked.name, 'zombie')
  assert.strictEqual(context.bot.heldItem.name, 'iron_sword')
  assert.strictEqual(context.actionLock.getOwner('combat'), null)

  context = createContext({ items: [] })
  context.equipmentSystem = new EquipmentSystem()
  context.autoPreparationSystem = new AutoPreparationSystem({ equipmentSystem: context.equipmentSystem })
  const bareHand = await combat.run({ type: 'protect_player', params: { holdLock: false } }, context)
  assert.strictEqual(bareHand.ok, true)
  assert.strictEqual(context.bot.pvp.attacked.name, 'zombie')

  context = createContext({ health: 4 })
  const lowHealth = await combat.run({ type: 'fight_nearby_mob', params: {} }, context)
  assert.strictEqual(lowHealth.ok, false)
  assert.strictEqual(lowHealth.error, 'health_too_low')
}

async function testInventorySystem() {
  const context = createContext()
  const inventory = new InventorySystem({ minFoodCount: 3 })
  const result = await inventory.run({ type: 'inventory_check', params: {} }, context)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.full, false)
  assert.strictEqual(result.data.missingFood, false)
  assert.strictEqual(result.data.missingTool, false)
}

async function testUtilityBlockSearch() {
  const blocks = [
    { name: 'white_bed', position: vec(30, 64, 0) },
    { name: 'crafting_table', position: vec(5, 64, 0) },
    { name: 'chest', position: vec(8, 64, 0) },
    { name: 'furnace', position: vec(10, 65, 0) },
    { name: 'furnace', position: vec(12, 65, 0) }
  ]
  let blockAtSawFloored = false
  const context = createContext()
  context.bot.registry.blocksByName = {
    white_bed: { id: 26 },
    chest: { id: 54 },
    trapped_chest: { id: 146 },
    barrel: { id: 200 },
    crafting_table: { id: 58 },
    furnace: { id: 61 },
    blast_furnace: { id: 62 },
    smoker: { id: 63 }
  }
  context.bot.findBlocks = ({ matching, maxDistance }) => blocks
    .filter(block => matching.includes(context.bot.registry.blocksByName[block.name]?.id))
    .filter(block => distance(context.bot.entity.position, block.position) <= maxDistance)
    .map(block => block.position)
  context.bot.blockAt = position => {
    if (typeof position?.floored !== 'function') throw new Error('blockAt_position_missing_floored')
    blockAtSawFloored = true
    const floored = position.floored()
    return blocks.find(block =>
      block.position.x === floored.x && block.position.y === floored.y && block.position.z === floored.z
    ) || { name: 'air', position: floored }
  }
  context.memory = {
    world: {
      baseLocation: { position: { x: 0, y: 64, z: 0 } },
      chestLocations: () => [],
      list: () => ({ builtStructures: [] })
    }
  }

  const search = new UtilityBlockSearch()
  let found = search.findNearestBed(context)
  assert.strictEqual(found.ok, true)
  assert.strictEqual(found.position.x, 30)

  found = search.findNearestCraftingTable(context)
  assert.strictEqual(found.ok, true)
  assert.strictEqual(found.position.x, 5)

  found = search.findNearestChest(context)
  assert.strictEqual(found.ok, true)
  assert.strictEqual(found.position.x, 8)

  found = search.findNearestFurnace(context)
  assert.strictEqual(found.ok, true)
  assert.strictEqual(found.position.y, 65)
  assert.strictEqual(found.candidates.length, 2)
  assert.deepStrictEqual(found.candidates.map(candidate => candidate.position.x), [10, 12])
  assert.strictEqual(blockAtSawFloored, true)

  search.rememberUtilityBlock(context, 'bed', { x: 40, y: 64, z: 0 })
  const invalidated = search.findNearestBed(context)
  assert.strictEqual(invalidated.ok, true)
  assert.strictEqual(invalidated.position.x, 30)
}

function createSmeltingContext(items, furnaceName = 'furnace') {
  const furnaceBlock = { name: furnaceName, position: vec(3, 64, 0) }
  const context = createContext({ items })
  context.bot.registry.blocksByName = {
    furnace: { id: 61 },
    blast_furnace: { id: 62 },
    smoker: { id: 63 }
  }
  context.bot.findBlock = ({ matching }) => matching === context.bot.registry.blocksByName[furnaceName]?.id ? furnaceBlock : null
  context.bot.blockAt = position => position.x === 3 ? furnaceBlock : { name: 'air', position }
  context.utilityBlockSearch = new UtilityBlockSearch()
  return context
}

function createParallelSmeltingContext(items, furnaces) {
  const context = createContext({ items })
  context.bot.registry.blocksByName = {
    furnace: { id: 61 },
    blast_furnace: { id: 62 },
    smoker: { id: 63 }
  }
  context.bot.findBlock = ({ matching }) => {
    const block = furnaces.find(furnace => context.bot.registry.blocksByName[furnace.name]?.id === matching)
    return block || null
  }
  context.bot.findBlocks = ({ matching, maxDistance, count }) => furnaces
    .filter(furnace => matching.includes(context.bot.registry.blocksByName[furnace.name]?.id))
    .filter(furnace => distance(context.bot.entity.position, furnace.position) <= maxDistance)
    .slice(0, count)
    .map(furnace => furnace.position)
  context.bot.blockAt = position => furnaces.find(furnace =>
    furnace.position.x === position.x && furnace.position.y === position.y && furnace.position.z === position.z
  ) || { name: 'air', position }
  context.utilityBlockSearch = new UtilityBlockSearch()
  return context
}

async function testSmeltingSystem() {
  const furnaceBlock = { name: 'blast_furnace', position: vec(3, 64, 0) }
  const context = createContext({
    items: [
      { name: 'raw_iron', count: 3, type: 100 },
      { name: 'coal', count: 1, type: 101 }
    ]
  })
  context.bot.registry.itemsByName = {
    raw_iron: { id: 100, name: 'raw_iron' },
    coal: { id: 101, name: 'coal' }
  }
  context.bot.registry.blocksByName = {
    furnace: { id: 61 },
    blast_furnace: { id: 62 },
    smoker: { id: 63 }
  }
  context.bot.findBlock = ({ matching }) => matching === 62 ? furnaceBlock : null
  context.bot.blockAt = position => position.x === 3 ? furnaceBlock : { name: 'air', position }
  context.bot.openFurnace = async block => {
    assert.strictEqual(block.name, 'blast_furnace')
    return {
      async putInput() {},
      async putFuel() {},
      outputItem() {
        return { name: 'iron_ingot', count: 3 }
      },
      async takeOutput() {
        return { name: 'iron_ingot', count: 3 }
      },
      close() {}
    }
  }

  const smelting = new SmeltingSystem()
  context.utilityBlockSearch = new UtilityBlockSearch()
  const plan = smelting.plan(context, { inputName: 'raw_iron', count: 3, preferredFurnace: 'blast_furnace' })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.targetOutput, 'iron_ingot')
  assert.strictEqual(plan.furnaceType, 'blast_furnace')
  assert.strictEqual(plan.requestedCount, 3)
  assert.strictEqual(plan.plannedCount, 3)
  assert.strictEqual(plan.strictQuantity, true)
  assert.strictEqual(plan.fuelItem, 'coal')
  assert.strictEqual(plan.furnaceBatches, null)
  assert.strictEqual(plan.parallelPlan, null)
  const result = await smelting.execute(context, plan)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.smeltedCount, 3)
  assert.strictEqual(result.parallel, undefined)

  const delayedContext = createSmeltingContext([
    { name: 'raw_iron', count: 2, type: 100 },
    { name: 'coal', count: 1, type: 101 }
  ])
  let outputReady = false
  let takeOutputCalls = 0
  delayedContext.bot.openFurnace = async () => ({
    async putInput() {},
    async putFuel() {},
    outputItem() {
      return outputReady ? { name: 'iron_ingot', count: 2 } : null
    },
    async takeOutput() {
      takeOutputCalls += 1
      return { name: 'iron_ingot', count: 2 }
    },
    close() {}
  })
  const delayedSmelting = new SmeltingSystem({
    outputPollIntervalMs: 5,
    outputLogIntervalMs: 5,
    outputTimeoutBaseMs: 200,
    outputTimeoutPerItemMs: 0
  })
  const delayedPlan = delayedSmelting.plan(delayedContext, { inputName: 'raw_iron', count: 2 })
  assert.strictEqual(delayedPlan.ok, true)
  const delayedPromise = delayedSmelting.execute(delayedContext, delayedPlan)
  await wait(25)
  assert.strictEqual(takeOutputCalls, 0)
  outputReady = true
  const delayedResult = await delayedPromise
  assert.strictEqual(delayedResult.ok, true)
  assert.strictEqual(takeOutputCalls, 1)
  assert.strictEqual(delayedResult.smeltedCount, 2)

  const timeoutContext = createSmeltingContext([
    { name: 'raw_iron', count: 1, type: 100 },
    { name: 'coal', count: 1, type: 101 }
  ])
  let timeoutTakeOutputCalls = 0
  timeoutContext.bot.openFurnace = async () => ({
    async putInput() {},
    async putFuel() {},
    outputItem() {
      return null
    },
    async takeOutput() {
      timeoutTakeOutputCalls += 1
      return null
    },
    close() {}
  })
  const timeoutSmelting = new SmeltingSystem({
    outputPollIntervalMs: 5,
    outputLogIntervalMs: 5,
    outputTimeoutBaseMs: 20,
    outputTimeoutPerItemMs: 0
  })
  const timeoutPlan = timeoutSmelting.plan(timeoutContext, { inputName: 'raw_iron', count: 1 })
  assert.strictEqual(timeoutPlan.ok, true)
  const timeoutResult = await timeoutSmelting.execute(timeoutContext, timeoutPlan)
  assert.strictEqual(timeoutResult.ok, false)
  assert.strictEqual(timeoutResult.reason, 'smelt_failed_output_timeout')
  assert.strictEqual(timeoutTakeOutputCalls, 0)

  const noFuel = new SmeltingSystem().plan(createContext({ items: [{ name: 'raw_iron', count: 1 }] }), { inputName: 'raw_iron' })
  assert.strictEqual(noFuel.ok, false)
  assert.strictEqual(noFuel.reason, 'smelt_failed_no_fuel')

  const poisonedFail = new SmeltingSystem().fail('smelt_failed_unknown', { ok: true, success: true, detail: 'poisoned_extra' })
  assert.strictEqual(poisonedFail.ok, false)
  assert.strictEqual(poisonedFail.success, undefined)
  assert.strictEqual(poisonedFail.detail, 'poisoned_extra')
  assert.strictEqual(poisonedFail.smeltingState.success, undefined)

  const insufficientInput = new SmeltingSystem().plan(createSmeltingContext([
    { name: 'raw_iron', count: 4 },
    { name: 'coal', count: 2 }
  ]), { inputName: 'raw_iron', count: 5 })
  assert.strictEqual(insufficientInput.ok, false)
  assert.strictEqual(insufficientInput.reason, 'smelt_failed_insufficient_input')
  assert.strictEqual(insufficientInput.requestedCount, 5)
  assert.strictEqual(insufficientInput.availableCount, 4)
  assert.strictEqual(insufficientInput.missingCount, 1)

  const insufficientFuel = new SmeltingSystem().plan(createSmeltingContext([
    { name: 'raw_iron', count: 10 },
    { name: 'coal', count: 1 }
  ]), { inputName: 'raw_iron', count: 10 })
  assert.strictEqual(insufficientFuel.ok, false)
  assert.strictEqual(insufficientFuel.reason, 'smelt_failed_insufficient_fuel')
  assert.strictEqual(insufficientFuel.requestedCount, 10)
  assert.strictEqual(insufficientFuel.fuelCapacity, 8)
  assert.strictEqual(insufficientFuel.missingFuelCapacity, 2)

  const allInsufficientFuel = new SmeltingSystem().plan(createSmeltingContext([
    { name: 'raw_iron', count: 10 },
    { name: 'coal', count: 1 }
  ]), { inputName: 'raw_iron', smeltMode: 'all' })
  assert.strictEqual(allInsufficientFuel.ok, false)
  assert.strictEqual(allInsufficientFuel.reason, 'smelt_failed_insufficient_fuel')
  assert.strictEqual(allInsufficientFuel.requestedCount, 10)
  assert.strictEqual(allInsufficientFuel.maxSmeltableCount, 8)

  const defaultPartialFuel = new SmeltingSystem().plan(createSmeltingContext([
    { name: 'raw_iron', count: 10 },
    { name: 'coal', count: 1 }
  ]), { inputName: 'raw_iron' })
  assert.strictEqual(defaultPartialFuel.ok, true)
  assert.strictEqual(defaultPartialFuel.strictQuantity, false)
  assert.strictEqual(defaultPartialFuel.requestedCount, 10)
  assert.strictEqual(defaultPartialFuel.plannedCount, 8)

  const twoFurnaces = [
    { name: 'furnace', position: vec(3, 64, 0) },
    { name: 'furnace', position: vec(5, 64, 0) }
  ]
  const defaultSingleFurnace = new SmeltingSystem().plan(createParallelSmeltingContext([
    { name: 'raw_iron', count: 10 },
    { name: 'coal', count: 2 }
  ], twoFurnaces), { inputName: 'raw_iron', count: 10 })
  assert.strictEqual(defaultSingleFurnace.ok, true)
  assert.strictEqual(defaultSingleFurnace.plannedCount, 10)
  assert.strictEqual(defaultSingleFurnace.selectedFuel, 'coal')
  assert.strictEqual(defaultSingleFurnace.fuelItem, 'coal')
  assert.ok(defaultSingleFurnace.selectedFurnace)
  assert.strictEqual(defaultSingleFurnace.furnaceBatches, null)
  assert.strictEqual(defaultSingleFurnace.parallelPlan, null)

  const parallelPlan = new SmeltingSystem().plan(createParallelSmeltingContext([
    { name: 'raw_iron', count: 10 },
    { name: 'coal', count: 2 }
  ], twoFurnaces), { inputName: 'raw_iron', count: 10, parallelFurnaces: true })
  assert.strictEqual(parallelPlan.ok, true)
  assert.strictEqual(parallelPlan.plannedCount, 10)
  assert.strictEqual(parallelPlan.furnaceBatches.length, 2)
  assert.strictEqual(parallelPlan.parallelPlan.enabled, true)
  assert.strictEqual(parallelPlan.parallelPlan.batchCount, 2)
  assert.strictEqual(parallelPlan.furnaceBatches.reduce((sum, batch) => sum + batch.inputCount, 0), 10)
  assert.strictEqual(parallelPlan.furnaceBatches.reduce((sum, batch) => sum + batch.fuelCount, 0), 2)
  assert.deepStrictEqual(parallelPlan.furnaceBatches.map(batch => batch.inputCount), [5, 5])
  assert.deepStrictEqual(parallelPlan.furnaceBatches.map(batch => batch.fuelItem), ['coal', 'coal'])
  assert.deepStrictEqual(parallelPlan.furnaceBatches.map(batch => batch.outputItem), ['iron_ingot', 'iron_ingot'])

  const parallelExecuteContext = createParallelSmeltingContext([
    { name: 'raw_iron', count: 10, type: 100 },
    { name: 'coal', count: 2, type: 101 }
  ], twoFurnaces)
  const parallelExecuteSmelting = new SmeltingSystem({
    outputPollIntervalMs: 5,
    outputLogIntervalMs: 5,
    outputTimeoutBaseMs: 100,
    outputTimeoutPerItemMs: 0
  })
  const parallelExecutePlan = parallelExecuteSmelting.plan(parallelExecuteContext, { inputName: 'raw_iron', count: 10, parallelFurnaces: true })
  assert.strictEqual(parallelExecutePlan.ok, true)
  assert.strictEqual(parallelExecutePlan.parallelPlan.enabled, true)
  assert.strictEqual(parallelExecutePlan.furnaceBatches.length, 2)
  assert.strictEqual(parallelExecuteSmelting.hasParallelBatches(parallelExecutePlan), true)
  const parallelEvents = []
  parallelExecuteContext.bot.openFurnace = async block => ({
    async putInput(item, meta, count) {
      parallelEvents.push({ type: 'putInput', furnaceX: block.position.x, count })
    },
    async putFuel(item, meta, count) {
      parallelEvents.push({ type: 'putFuel', furnaceX: block.position.x, count })
    },
    outputItem() {
      return { name: 'iron_ingot', count: block.position.x === 3 ? 5 : 5 }
    },
    async takeOutput() {
      parallelEvents.push({ type: 'takeOutput', furnaceX: block.position.x })
      return { name: 'iron_ingot', count: block.position.x === 3 ? 5 : 5 }
    },
    close() {
      parallelEvents.push({ type: 'close', furnaceX: block.position.x })
    }
  })
  const parallelExecuteResult = await parallelExecuteSmelting.execute(parallelExecuteContext, { ...parallelExecutePlan, openDistance: 99 })
  assert.strictEqual(parallelExecuteResult.ok, true)
  assert.strictEqual(parallelExecuteResult.success, true)
  assert.strictEqual(parallelExecuteResult.parallel, true)
  assert.strictEqual(parallelExecuteResult.smeltedCount, parallelExecutePlan.plannedCount)
  assert.strictEqual(parallelExecuteResult.batchResults.length, 2)
  assert.strictEqual(parallelEvents.filter(event => event.type === 'putInput').length, 2)
  assert.strictEqual(parallelEvents.filter(event => event.type === 'putFuel').length, 2)
  const firstTakeIndex = parallelEvents.findIndex(event => event.type === 'takeOutput')
  const lastPutFuelIndex = parallelEvents.reduce((last, event, index) => event.type === 'putFuel' ? index : last, -1)
  assert.ok(firstTakeIndex > lastPutFuelIndex)

  const partialTimeoutContext = createParallelSmeltingContext([
    { name: 'raw_iron', count: 10, type: 100 },
    { name: 'coal', count: 2, type: 101 }
  ], twoFurnaces)
  const partialTimeoutSmelting = new SmeltingSystem({
    outputPollIntervalMs: 5,
    outputLogIntervalMs: 5,
    outputTimeoutBaseMs: 20,
    outputTimeoutPerItemMs: 0
  })
  const partialTimeoutPlan = partialTimeoutSmelting.plan(partialTimeoutContext, { inputName: 'raw_iron', count: 10, parallelFurnaces: true })
  assert.strictEqual(partialTimeoutPlan.ok, true)
  partialTimeoutContext.bot.openFurnace = async block => ({
    async putInput() {},
    async putFuel() {},
    outputItem() {
      return block.position.x === 3 ? { name: 'iron_ingot', count: 5 } : null
    },
    async takeOutput() {
      return { name: 'iron_ingot', count: 5 }
    },
    close() {}
  })
  const partialTimeoutResult = await partialTimeoutSmelting.execute(partialTimeoutContext, { ...partialTimeoutPlan, openDistance: 99 })
  assert.strictEqual(partialTimeoutResult.ok, false)
  assert.strictEqual(partialTimeoutResult.reason, 'smelt_failed_output_timeout')
  assert.strictEqual(partialTimeoutResult.success, undefined)
  assert.strictEqual(partialTimeoutResult.parallel, true)
  assert.strictEqual(partialTimeoutResult.partialSmeltedCount, 5)
  assert.strictEqual(partialTimeoutResult.smeltedCount, 5)

  const totalOverrunContext = createParallelSmeltingContext([
    { name: 'raw_iron', count: 10, type: 100 },
    { name: 'coal', count: 2, type: 101 }
  ], twoFurnaces)
  const totalOverrunSmelting = new SmeltingSystem({
    outputPollIntervalMs: 5,
    outputLogIntervalMs: 5,
    outputTimeoutBaseMs: 100,
    outputTimeoutPerItemMs: 0
  })
  const totalOverrunPlan = totalOverrunSmelting.plan(totalOverrunContext, { inputName: 'raw_iron', count: 10, parallelFurnaces: true })
  assert.strictEqual(totalOverrunPlan.ok, true)
  totalOverrunPlan.furnaceBatches[0] = {
    ...totalOverrunPlan.furnaceBatches[0],
    expectedOutputCount: 6
  }
  totalOverrunContext.bot.openFurnace = async block => ({
    async putInput() {},
    async putFuel() {},
    outputItem() {
      return { name: 'iron_ingot', count: block.position.x === 3 ? 6 : 5 }
    },
    async takeOutput() {
      return { name: 'iron_ingot', count: block.position.x === 3 ? 6 : 5 }
    },
    close() {}
  })
  const totalOverrunResult = await totalOverrunSmelting.execute(totalOverrunContext, { ...totalOverrunPlan, openDistance: 99 })
  assert.strictEqual(totalOverrunResult.ok, false)
  assert.strictEqual(totalOverrunResult.reason, 'smelt_failed_output_overrun')
  assert.strictEqual(totalOverrunResult.success, undefined)
  assert.strictEqual(totalOverrunResult.parallel, true)
  assert.strictEqual(totalOverrunResult.partialSmeltedCount, 11)
  assert.strictEqual(totalOverrunResult.actualCount, 11)
  assert.strictEqual(totalOverrunResult.plannedCount, 10)

  const batchOverrunContext = createParallelSmeltingContext([
    { name: 'raw_iron', count: 10, type: 100 },
    { name: 'coal', count: 2, type: 101 }
  ], twoFurnaces)
  const batchOverrunSmelting = new SmeltingSystem({
    outputPollIntervalMs: 5,
    outputLogIntervalMs: 5,
    outputTimeoutBaseMs: 100,
    outputTimeoutPerItemMs: 0
  })
  const batchOverrunPlan = batchOverrunSmelting.plan(batchOverrunContext, { inputName: 'raw_iron', count: 10, parallelFurnaces: true })
  assert.strictEqual(batchOverrunPlan.ok, true)
  batchOverrunContext.bot.openFurnace = async block => ({
    async putInput() {},
    async putFuel() {},
    outputItem() {
      return { name: 'iron_ingot', count: block.position.x === 3 ? 6 : 5 }
    },
    async takeOutput() {
      return { name: 'iron_ingot', count: block.position.x === 3 ? 6 : 5 }
    },
    close() {}
  })
  const batchOverrunResult = await batchOverrunSmelting.execute(batchOverrunContext, { ...batchOverrunPlan, openDistance: 99 })
  assert.strictEqual(batchOverrunResult.ok, false)
  assert.strictEqual(batchOverrunResult.reason, 'smelt_failed_output_overrun')
  assert.strictEqual(batchOverrunResult.success, undefined)
  assert.strictEqual(batchOverrunResult.batchResults[0].expectedOutputCount, 5)
  assert.strictEqual(batchOverrunResult.batchResults[0].actualOutputCount, 6)
  assert.strictEqual(batchOverrunResult.actualOutputCount, 6)

  const parallelInsufficientFuel = new SmeltingSystem().plan(createParallelSmeltingContext([
    { name: 'raw_iron', count: 10 },
    { name: 'coal', count: 1 }
  ], twoFurnaces), { inputName: 'raw_iron', count: 10, parallelFurnaces: true })
  assert.strictEqual(parallelInsufficientFuel.ok, false)
  assert.strictEqual(parallelInsufficientFuel.reason, 'smelt_failed_insufficient_fuel')
  assert.strictEqual(parallelInsufficientFuel.furnaceBatches, undefined)

  const oneFurnaceParallel = new SmeltingSystem().plan(createParallelSmeltingContext([
    { name: 'raw_iron', count: 6 },
    { name: 'coal', count: 1 }
  ], [{ name: 'furnace', position: vec(3, 64, 0) }]), { inputName: 'raw_iron', count: 6, parallelFurnaces: true })
  assert.strictEqual(oneFurnaceParallel.ok, true)
  assert.strictEqual(oneFurnaceParallel.furnaceBatches.length, 1)
  assert.strictEqual(oneFurnaceParallel.furnaceBatches[0].inputCount, 6)
  assert.strictEqual(oneFurnaceParallel.furnaceBatches[0].fuelCount, 1)
  assert.strictEqual(oneFurnaceParallel.selectedFurnace.x, 3)
}

async function run() {
  await testMiningSystem()
  await testCombatSystem()
  await testInventorySystem()
  await testUtilityBlockSearch()
  await testSmeltingSystem()
  console.log('systems tests passed')
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
