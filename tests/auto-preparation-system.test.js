const assert = require('assert')
const { AutoPreparationSystem } = require('../systems/AutoPreparationSystem')
const { CraftingSystem } = require('../systems/CraftingSystem')
const { EquipmentSystem } = require('../systems/EquipmentSystem')

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) {
      return vec(x + dx, y + dy, z + dz)
    },
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

const ITEMS = [
  { id: 1, name: 'stone' },
  { id: 2, name: 'cobblestone' },
  { id: 5, name: 'oak_planks' },
  { id: 17, name: 'oak_log' },
  { id: 58, name: 'crafting_table' },
  { id: 270, name: 'wooden_pickaxe' },
  { id: 272, name: 'stone_pickaxe' },
  { id: 275, name: 'stone_axe' },
  { id: 267, name: 'iron_sword' },
  { id: 279, name: 'iron_axe' },
  { id: 280, name: 'stick' },
  { id: 295, name: 'wheat_seeds' },
  { id: 296, name: 'wheat' },
  { id: 297, name: 'bread' }
]

const RECIPES = [
  { itemId: 5, recipe: { requiresTable: false, delta: [{ id: 17, count: 1 }], result: { id: 5, count: 4 } } },
  { itemId: 280, recipe: { requiresTable: false, delta: [{ id: 5, count: 2 }], result: { id: 280, count: 4 } } },
  { itemId: 58, recipe: { requiresTable: false, delta: [{ id: 5, count: 4 }], result: { id: 58, count: 1 } } },
  { itemId: 270, recipe: { requiresTable: true, delta: [{ id: 5, count: 3 }, { id: 280, count: 2 }], result: { id: 270, count: 1 } } },
  { itemId: 272, recipe: { requiresTable: true, delta: [{ id: 2, count: 3 }, { id: 280, count: 2 }], result: { id: 272, count: 1 } } },
  { itemId: 297, recipe: { requiresTable: true, delta: [{ id: 296, count: 3 }], result: { id: 297, count: 1 } } }
]

function createBot(initialItems) {
  const items = initialItems.map(item => ({ ...item }))
  const itemsByName = Object.fromEntries(ITEMS.map(item => [item.name, item]))
  const itemsById = Object.fromEntries(ITEMS.map(item => [item.id, item]))
  const recipeMap = new Map(RECIPES.map(entry => [entry.itemId, entry.recipe]))
  const tableBlock = { name: 'crafting_table', position: vec(1, 64, 0) }

  return {
    username: 'Bot',
    entity: { position: vec(0, 64, 0) },
    inventory: {
      items: () => items,
      slots: Array(45).fill(null)
    },
    registry: {
      itemsByName,
      itemsArray: ITEMS,
      blocksByName: {
        crafting_table: { id: 58, name: 'crafting_table' },
        stone: { id: 1, name: 'stone' },
        cobblestone: { id: 2, name: 'cobblestone' },
        oak_log: { id: 17, name: 'oak_log' },
        iron_ore: { id: 15, name: 'iron_ore' }
      }
    },
    recipesFor(itemId) {
      const recipe = recipeMap.get(itemId)
      return recipe ? [recipe] : []
    },
    findBlock({ matching }) {
      const ids = Array.isArray(matching) ? matching : [matching]
      return ids.includes(58) ? tableBlock : null
    },
    blockAt(position) {
      if (position.x === 1 && position.y === 64 && position.z === 0) return tableBlock
      return { name: 'air', position }
    },
    async craft(recipe, count) {
      for (const material of recipe.delta || []) {
        const materialName = itemsById[material.id]?.name
        const stack = items.find(item => item.name === materialName)
        assert.ok(stack && stack.count >= material.count * count, `missing ${materialName}`)
        stack.count -= material.count * count
      }
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].count <= 0) items.splice(i, 1)
      }
      const resultName = itemsById[recipe.result.id]?.name
      const existing = items.find(item => item.name === resultName)
      if (existing) existing.count += recipe.result.count * count
      else items.push({ name: resultName, count: recipe.result.count * count })
    },
    async equip(item) {
      this.heldItem = item
    }
  }
}

function createContext(initialItems) {
  const bot = createBot(initialItems)
  const logs = []
  const equipmentSystem = new EquipmentSystem()
  const craftingSystem = new CraftingSystem()
  const autoPreparationSystem = new AutoPreparationSystem({
    equipmentSystem,
    craftingSystem,
    logger: { log: message => logs.push(message) }
  })
  return {
    bot,
    logs,
    equipmentSystem,
    craftingSystem,
    autoPreparationSystem,
    logger: { log: message => logs.push(message) }
  }
}

async function testExistingPickaxe() {
  const ctx = createContext([{ name: 'stone_pickaxe', count: 1 }])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'stone')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'already_available')
  assert.strictEqual(result.itemName, 'stone_pickaxe')
}

async function testCraftWoodenPickaxe() {
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'stone')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.craftedItemName, 'wooden_pickaxe')
  assert.ok(ctx.bot.inventory.items().some(item => item.name === 'wooden_pickaxe'))
}

async function testCraftStonePickaxe() {
  const ctx = createContext([
    { name: 'cobblestone', count: 3 },
    { name: 'oak_planks', count: 2 }
  ])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'iron_ore')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.craftedItemName, 'stone_pickaxe')
  assert.ok(ctx.bot.inventory.items().some(item => item.name === 'stone_pickaxe'))
}

async function testMissingBaseMaterial() {
  const ctx = createContext([{ name: 'oak_planks', count: 2 }])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'iron_ore')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.reason, 'missing_materials')
  assert.ok(result.missingMaterials.some(item => item.item === 'cobblestone'))
  assert.strictEqual(result.canExecuteBareHand, false)
}

async function testExistingAxeForLog() {
  const ctx = createContext([{ name: 'iron_axe', count: 1 }])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'oak_log')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'already_available')
  assert.strictEqual(result.itemName, 'iron_axe')
  assert.strictEqual(result.preferredTool, 'axe')
  assert.strictEqual(result.canExecuteBareHand, true)
  assert.strictEqual(result.fallbackUsed, false)
}

async function testBareHandFallbackForLog() {
  const ctx = createContext([])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'oak_log')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'bare_hand_fallback')
  assert.strictEqual(result.itemName, 'hand')
  assert.strictEqual(result.preferredTool, 'axe')
  assert.strictEqual(result.allowHand, true)
  assert.strictEqual(result.canExecuteBareHand, true)
  assert.strictEqual(result.fallbackUsed, true)
}

async function testMiningDoesNotUseLogFallback() {
  const ctx = createContext([])
  const result = await ctx.autoPreparationSystem.ensureToolForBlock(ctx, 'iron_ore')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.canExecuteBareHand, false)
  assert.notStrictEqual(result.reason, 'bare_hand_fallback')
}

async function testCombatWeaponSelection() {
  const ctx = createContext([{ name: 'iron_sword', count: 1 }])
  const result = await ctx.autoPreparationSystem.ensureCombatWeapon(ctx)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.itemName, 'iron_sword')
  assert.strictEqual(ctx.bot.heldItem.name, 'iron_sword')
  assert.strictEqual(result.fallbackUsed, false)
}

async function testCombatBestWeaponByDamage() {
  const ctx = createContext([
    { name: 'iron_sword', count: 1 },
    { name: 'stone_axe', count: 1 }
  ])
  const result = await ctx.autoPreparationSystem.ensureCombatWeapon(ctx)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.itemName, 'stone_axe')
  assert.strictEqual(result.weaponType, 'axe')
  assert.strictEqual(ctx.bot.heldItem.name, 'stone_axe')
}

async function testCombatBareHandFallback() {
  const ctx = createContext([{ name: 'oak_planks', count: 2 }])
  const result = await ctx.autoPreparationSystem.ensureCombatWeapon(ctx)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'bare_hand_fallback')
  assert.strictEqual(result.itemName, 'hand')
  assert.strictEqual(result.fallbackUsed, true)
  assert.strictEqual(result.canExecuteBareHand, true)
}

async function testHarvestWheatNeedsNoTool() {
  const ctx = createContext([])
  const result = await ctx.autoPreparationSystem.ensureFarmingItems(ctx, { mode: 'HARVEST_FARM' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'harvest_requires_no_tool')
  assert.strictEqual(result.itemName, 'hand')
  assert.strictEqual(result.canExecuteBareHand, true)
}

async function testReplantWheatRequiresSeeds() {
  const ctx = createContext([])
  const result = await ctx.autoPreparationSystem.ensureFarmingItems(ctx, {
    mode: 'PLANT_WHEAT',
    requiredSeeds: 2,
    allowStorage: false
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.reason, 'missing_seeds')
  assert.strictEqual(result.itemName, 'wheat_seeds')
  assert.strictEqual(result.missingSeeds, 2)
}

async function testFarmingPreparationSucceedsWithSeeds() {
  const ctx = createContext([{ name: 'wheat_seeds', count: 4 }])
  const result = await ctx.autoPreparationSystem.ensureFarmingItems(ctx, {
    mode: 'FARM_CYCLE',
    requiredSeeds: 3
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'seeds_available')
  assert.strictEqual(result.currentSeeds, 4)
}

async function testFarmingPreparationMissingSeedsWithStorageUnavailable() {
  const ctx = createContext([])
  const result = await ctx.autoPreparationSystem.ensureFarmingItems(ctx, {
    mode: 'FARM_CYCLE',
    requiredSeeds: 1,
    allowStorage: true
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.reason, 'storage_unavailable')
  assert.strictEqual(result.missingSeeds, 1)
}

async function testCraftingFetchesStorageDepsThenCrafts() {
  const ctx = createContext([{ name: 'wheat', count: 1 }])
  const fetched = []
  ctx.blackboard = {
    get: key => key === 'storage.counts' ? { wheat: 2 } : null,
    set: () => {},
    snapshot: () => ({})
  }
  ctx.storageSystem = {
    async takeItems(context, options) {
      fetched.push(options)
      assert.strictEqual(options.itemName, 'wheat')
      assert.strictEqual(options.count, 2)
      const stack = context.bot.inventory.items().find(item => item.name === 'wheat')
      if (stack) stack.count += options.count
      else context.bot.inventory.items().push({ name: options.itemName, count: options.count })
      return { ok: true, withdrawnItems: [{ itemName: options.itemName, count: options.count }] }
    }
  }
  ctx.autoPreparationSystem.storageSystem = ctx.storageSystem

  const result = await ctx.autoPreparationSystem.ensureItem(ctx, 'bread', 1, {
    allowStorage: true,
    owner: 'test-auto-prep'
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'crafted')
  assert.strictEqual(fetched.length, 1)
  assert.ok(ctx.bot.inventory.items().some(item => item.name === 'bread' && item.count === 1))
  assert.ok(ctx.logs.some(line => line.includes('target=storage result=ok deps=wheat:2')))
}

async function testCraftingWaitsForDelayedInventoryConfirmation() {
  const ctx = createContext([{ name: 'wheat', count: 3 }])
  let craftCalls = 0
  ctx.bot.craft = async () => {
    craftCalls += 1
    setTimeout(() => {
      ctx.bot.inventory.items().push({ name: 'bread', count: 1 })
    }, 600)
  }

  const result = await ctx.autoPreparationSystem.ensureItem(ctx, 'bread', 1, {
    craftInventoryConfirmTimeoutMs: 1200,
    craftInventoryConfirmIntervalMs: 25
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.reason, 'crafted')
  assert.strictEqual(craftCalls, 1)
  assert.strictEqual(result.finalCount, 1)
  assert.ok(ctx.bot.inventory.items().some(item => item.name === 'bread' && item.count === 1))
}

async function run() {
  console.log('AutoPreparationSystem tests')
  await testExistingPickaxe()
  await testCraftWoodenPickaxe()
  await testCraftStonePickaxe()
  await testMissingBaseMaterial()
  await testExistingAxeForLog()
  await testBareHandFallbackForLog()
  await testMiningDoesNotUseLogFallback()
  await testCombatWeaponSelection()
  await testCombatBestWeaponByDamage()
  await testCombatBareHandFallback()
  await testHarvestWheatNeedsNoTool()
  await testReplantWheatRequiresSeeds()
  await testFarmingPreparationSucceedsWithSeeds()
  await testFarmingPreparationMissingSeedsWithStorageUnavailable()
  await testCraftingFetchesStorageDepsThenCrafts()
  await testCraftingWaitsForDelayedInventoryConfirmation()
  console.log('AutoPreparationSystem tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
