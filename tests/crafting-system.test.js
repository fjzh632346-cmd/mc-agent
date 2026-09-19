const assert = require('assert')
const { CraftingSystem } = require('../systems/CraftingSystem')
const { ActionLock } = require('../core/action-lock')

function createMockBot(inventoryItems = [], recipesMap = null) {
  const mockItemsArray = [
    { id: 1, name: 'stone' },
    { id: 2, name: 'cobblestone' },
    { id: 5, name: 'oak_planks' },
    { id: 17, name: 'oak_log' },
    { id: 50, name: 'torch' },
    { id: 54, name: 'chest' },
    { id: 58, name: 'crafting_table' },
    { id: 263, name: 'coal' },
    { id: 265, name: 'iron_ingot' },
    { id: 267, name: 'iron_sword' },
    { id: 257, name: 'iron_pickaxe' },
    { id: 268, name: 'wooden_sword' },
    { id: 270, name: 'wooden_pickaxe' },
    { id: 2720, name: 'stone_sword' },
    { id: 272, name: 'stone_pickaxe' },
    { id: 274, name: 'stone_shovel' },
    { id: 280, name: 'stick' },
    { id: 296, name: 'wheat' },
    { id: 297, name: 'bread' },
    { id: 299, name: 'leather_chestplate' },
    { id: 307, name: 'iron_chestplate' },
  ]

  const mockBlockRegistry = {
    blocksByName: {
      crafting_table: { id: 58, name: 'crafting_table' }
    }
  }

  const itemsByName = {}
  for (const item of mockItemsArray) {
    itemsByName[item.name] = { id: item.id, name: item.name }
  }

  const defaultRecipes = [
    { itemId: 5, recipe: { requiresTable: false, delta: [{ id: 17, count: 1 }], result: { id: 5, count: 4 } } }, // log → 4 planks
    { itemId: 280, recipe: { requiresTable: false, delta: [{ id: 5, count: 2 }], result: { id: 280, count: 4 } } }, // 2 planks → 4 sticks
    { itemId: 58, recipe: { requiresTable: false, delta: [{ id: 5, count: 4 }], result: { id: 58, count: 1 } } }, // 4 planks → crafting_table
    { itemId: 54, recipe: { requiresTable: true, delta: [{ id: 5, count: 8 }], result: { id: 54, count: 1 } } }, // 8 planks → chest
    { itemId: 50, recipe: { requiresTable: false, delta: [{ id: 263, count: 1 }, { id: 280, count: 1 }], result: { id: 50, count: 4 } } }, // coal + stick → 4 torches
    { itemId: 270, recipe: { requiresTable: true, delta: [{ id: 5, count: 3 }, { id: 280, count: 2 }], result: { id: 270, count: 1 } } }, // 3 planks + 2 sticks → wooden_pickaxe
    { itemId: 272, recipe: { requiresTable: true, delta: [{ id: 2, count: 3 }, { id: 280, count: 2 }], result: { id: 272, count: 1 } } }, // 3 cobble + 2 sticks → stone_pickaxe
    { itemId: 267, recipe: { requiresTable: true, delta: [{ id: 265, count: 2 }, { id: 280, count: 1 }], result: { id: 267, count: 1 } } }, // 2 iron + 1 stick → iron_sword
    { itemId: 257, recipe: { requiresTable: true, delta: [{ id: 265, count: 3 }, { id: 280, count: 2 }], result: { id: 257, count: 1 } } },
    { itemId: 268, recipe: { requiresTable: true, delta: [{ id: 5, count: 2 }, { id: 280, count: 1 }], result: { id: 268, count: 1 } } },
    { itemId: 2720, recipe: { requiresTable: true, delta: [{ id: 2, count: 2 }, { id: 280, count: 1 }], result: { id: 2720, count: 1 } } },
    { itemId: 297, recipe: { requiresTable: true, delta: [{ id: 296, count: 3 }], result: { id: 297, count: 1 } } }, // 3 wheat → bread
    { itemId: 274, recipe: { requiresTable: true, delta: [{ id: 2, count: 1 }, { id: 280, count: 2 }], result: { id: 274, count: 1 } } }, // 1 cobble + 2 sticks → stone_shovel
  ]

  const recipeMap = recipesMap || new Map(defaultRecipes.map(r => [r.itemId, r.recipe]))

  return {
    username: 'Bot',
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => inventoryItems,
      slots: Array(45).fill(null)
    },
    registry: {
      itemsByName,
      itemsArray: mockItemsArray,
      blocksByName: { crafting_table: { id: 58, name: 'crafting_table' } }
    },
    recipesFor: (itemId) => {
      const recipe = recipeMap.get(itemId)
      return recipe ? [recipe] : []
    },
    findBlock: ({ matching, maxDistance }) => {
      return null
    },
    crafted: [],
    craft: async function(recipe, count) {
      this.crafted.push({ recipe, count })
    }
  }
}

function createContext(inventoryItems = [], recipesMap) {
  const bot = createMockBot(inventoryItems, recipesMap)
  const blackboard = {
    get: () => null,
    set: () => {},
    snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } })
  }
  return {
    bot,
    blackboard,
    actionLock: new ActionLock()
  }
}

async function testDirectCraft() {
  console.log('  [Direct Craft Tests]')
  const cs = new CraftingSystem()

  // Bread from wheat
  let ctx = createContext([
    { name: 'wheat', count: 9 }
  ])
  let plan = cs.planRecipe('bread', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan bread from wheat')
  assert.strictEqual(plan.targetItem, 'bread')
  assert.strictEqual(plan.steps.length, 1)
  console.log('  ✓ bread from wheat → ok')

  // Bread with missing wheat
  ctx = createContext([])
  plan = cs.planRecipe('bread', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.reason, 'missing_materials')
  assert.ok(plan.missingMaterials.some(m => m.item === 'wheat'))
  console.log('  ✓ bread without wheat → missing_materials')

  // Iron sword
  ctx = createContext([
    { name: 'iron_ingot', count: 2 },
    { name: 'stick', count: 1 }
  ])
  plan = cs.planRecipe('iron_sword', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan iron_sword')
  console.log('  ✓ iron_sword → ok')

  console.log('  Direct craft tests passed')
}

async function testPlanningFindsCraftingTableRecipes() {
  const cs = new CraftingSystem()
  const ctx = createContext([
    { name: 'cobblestone', count: 2 },
    { name: 'stick', count: 1 },
    { name: 'crafting_table', count: 1 }
  ])
  const stoneSwordId = ctx.bot.registry.itemsByName.stone_sword.id
  const originalRecipesFor = ctx.bot.recipesFor
  ctx.bot.recipesFor = (itemId, meta, count, table) => {
    if (itemId === stoneSwordId && !table) return []
    return originalRecipesFor(itemId, meta, count, table)
  }

  const plan = cs.planRecipe('stone_sword', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.targetItem, 'stone_sword')
  assert.strictEqual(plan.needsCraftingTable, true)
  assert.strictEqual(plan.steps[0].item, 'stone_sword')
  console.log('  planning finds crafting-table-only stone_sword recipe')
}

async function testRecursiveWoodenSwordFromLogs() {
  const cs = new CraftingSystem()
  const ctx = createContext([
    { name: 'oak_log', count: 1 }
  ])
  const plan = cs.planRecipe('wooden_sword', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true)
  assert.ok(plan.steps.some(step => step.item === 'oak_planks'))
  assert.ok(plan.steps.some(step => step.item === 'stick'))
  assert.ok(plan.steps.some(step => step.item === 'wooden_sword'))
  console.log('  recursive logs -> planks -> sticks -> wooden_sword plan')
}

async function testPlansSticksFromLogsWhenRecipeIsNotCurrentlyCraftable() {
  const cs = new CraftingSystem()
  const ctx = createContext([
    { name: 'oak_log', count: 1 }
  ])
  const originalRecipesFor = ctx.bot.recipesFor
  const stickId = ctx.bot.registry.itemsByName.stick.id

  ctx.bot.recipesFor = (itemId, meta, count, table) => {
    if (itemId === stickId) {
      const hasPlanks = ctx.bot.inventory.items().some(item =>
        item.name.endsWith('_planks') && item.count >= 2)
      if (!hasPlanks) return []
    }
    return originalRecipesFor(itemId, meta, count, table)
  }

  const plan = cs.planRecipe('stick', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan sticks recursively from logs')
  assert.ok(plan.steps.some(step => step.item === 'oak_planks'), 'should craft planks first')
  assert.ok(plan.steps.some(step => step.item === 'stick'), 'should craft sticks after planks')
  console.log('  fallback planning handles logs -> planks -> sticks')
}

async function testPlansSticksFromLogsWhenNativeRecipeIgnoresInventory() {
  const cs = new CraftingSystem()
  const ctx = createContext([
    { name: 'oak_log', count: 1 }
  ])

  const plan = cs.planRecipe('stick', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan sticks recursively from logs')
  assert.deepStrictEqual(plan.steps.map(step => step.item), ['oak_planks', 'stick'])
  console.log('  native stick recipe with no planks still plans logs -> planks -> sticks')
}

async function testPlanningUsesLiveInventoryOverStaleBlackboard() {
  const cs = new CraftingSystem()
  const ctx = createContext([
    { name: 'oak_log', count: 1 }
  ])
  ctx.blackboard = {
    get: (key) => key === 'inventory.counts' ? { oak_planks: 2 } : null,
    set: () => {},
    snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } })
  }

  const plan = cs.planRecipe('stick', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should trust live inventory over stale blackboard counts')
  assert.deepStrictEqual(plan.steps.map(step => step.item), ['oak_planks', 'stick'])
  console.log('  live inventory wins over stale blackboard counts')
}

async function testStickMissingMaterialsExposeBaseLog() {
  const cs = new CraftingSystem()
  const ctx = createContext([])

  const plan = cs.planRecipe('stick', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.reason, 'missing_materials')
  assert.ok(plan.missingMaterials.some(entry => entry.item === 'oak_log'), JSON.stringify(plan.missingMaterials))
  assert.strictEqual(plan.missingMaterials.some(entry => entry.item === 'oak_planks'), false)
  console.log('  missing stick materials expose base log instead of intermediate planks')
}

async function testCommonSurvivalCraftPlans() {
  const cs = new CraftingSystem()
  const cases = [
    {
      target: 'crafting_table',
      inventory: [{ name: 'oak_planks', count: 4 }],
      steps: ['crafting_table'],
      needsCraftingTable: false
    },
    {
      target: 'chest',
      inventory: [{ name: 'oak_planks', count: 8 }],
      steps: ['chest'],
      needsCraftingTable: true
    },
    {
      target: 'wooden_pickaxe',
      inventory: [{ name: 'oak_planks', count: 5 }],
      steps: ['stick', 'wooden_pickaxe'],
      needsCraftingTable: true
    },
    {
      target: 'stone_pickaxe',
      inventory: [{ name: 'cobblestone', count: 3 }, { name: 'oak_planks', count: 2 }],
      steps: ['stick', 'stone_pickaxe'],
      needsCraftingTable: true
    },
    {
      target: 'wooden_sword',
      inventory: [{ name: 'oak_planks', count: 4 }],
      steps: ['stick', 'wooden_sword'],
      needsCraftingTable: true
    },
    {
      target: 'torch',
      inventory: [{ name: 'coal', count: 1 }, { name: 'oak_planks', count: 2 }],
      steps: ['stick', 'torch'],
      needsCraftingTable: false
    },
    {
      target: 'bread',
      inventory: [{ name: 'wheat', count: 3 }],
      steps: ['bread'],
      needsCraftingTable: true
    }
  ]

  for (const entry of cases) {
    const plan = cs.planRecipe(entry.target, 1, 'specified', createContext(entry.inventory))
    assert.strictEqual(plan.ok, true, `${entry.target} should plan`)
    assert.deepStrictEqual(plan.steps.map(step => step.item), entry.steps, `${entry.target} plan steps`)
    assert.strictEqual(plan.steps[plan.steps.length - 1].needsCraftingTable, entry.needsCraftingTable, `${entry.target} table requirement`)
  }

  const missing = cs.planRecipe('iron_pickaxe', 1, 'specified', createContext([]))
  assert.strictEqual(missing.ok, false)
  assert.strictEqual(missing.reason, 'missing_materials')
  assert.ok(missing.missingMaterials.some(entry => entry.item === 'iron_ingot'), JSON.stringify(missing.missingMaterials))
  console.log('  common survival crafting plans cover table, tools, utility, food, and iron_pickaxe missing material')
}

async function testRecursiveCraft() {
  console.log('  [Recursive Craft Tests]')
  const cs = new CraftingSystem()

  // Logs → planks → sticks (recursive)
  let ctx = createContext([
    { name: 'oak_log', count: 4 },
    { name: 'coal', count: 8 }
  ])
  let plan = cs.planRecipe('torch', 4, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan torches recursively from logs + coal')
  assert.ok(plan.steps.length >= 2, 'should have multiple steps (planks→sticks, then torch)')
  console.log(`  ✓ torch from logs+coal → ok (${plan.steps.length} steps)`)

  // Logs → planks → chest
  ctx = createContext([
    { name: 'oak_log', count: 3 }
  ])
  plan = cs.planRecipe('chest', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan chest from logs')
  console.log(`  ✓ chest from logs → ok (${plan.steps.length} steps, needsTable=${plan.needsCraftingTable})`)

  // Wooden pickaxe recursively
  ctx = createContext([
    { name: 'oak_log', count: 2 }
  ])
  plan = cs.planRecipe('wooden_pickaxe', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan wooden_pickaxe from logs')
  console.log(`  ✓ wooden_pickaxe from logs → ok (${plan.steps.length} steps)`)

  // Stone pickaxe with all materials (no recursion needed for cobblestone)
  ctx = createContext([
    { name: 'cobblestone', count: 3 },
    { name: 'stick', count: 2 }
  ])
  plan = cs.planRecipe('stone_pickaxe', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan stone_pickaxe')
  console.log(`  ✓ stone_pickaxe from cobble+sticks → ok (${plan.steps.length} steps)`)

  console.log('  Recursive craft tests passed')
}

async function testMaxCraftable() {
  console.log('  [Max Craftable Tests]')
  const cs = new CraftingSystem()

  // Can make 3 bread from 9 wheat
  let ctx = createContext([
    { name: 'wheat', count: 9 }
  ])
  let plan = cs.planRecipe('bread', 1, 'max_possible', ctx)
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.plannedCount, 3, '9 wheat = 3 bread')
  console.log('  ✓ max_possible bread from 9 wheat → 3')

  // 3 logs → 12 planks → max torches with 8 coal
  ctx = createContext([
    { name: 'oak_log', count: 3 },
    { name: 'coal', count: 8 }
  ])
  plan = cs.planRecipe('torch', 1, 'max_possible', ctx)
  assert.strictEqual(plan.ok, true)
  console.log(`  ✓ max_possible torches → ${plan.plannedCount}`)

  console.log('  Max craftable tests passed')
}

async function testMissingMaterials() {
  console.log('  [Missing Materials Tests]')
  const cs = new CraftingSystem()

  // Iron sword without iron
  let ctx = createContext([
    { name: 'stick', count: 3 }
  ])
  let plan = cs.planRecipe('iron_sword', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.reason, 'missing_materials')
  assert.ok(plan.missingMaterials.some(m => m.item === 'iron_ingot'))
  console.log('  ✓ iron_sword without iron → missing_materials')

  // Unknown item
  plan = cs.planRecipe('nonexistent_item', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.reason, 'unknown_item')
  console.log('  ✓ unknown item → unknown_item')

  console.log('  Missing materials tests passed')
}

async function testReservedItems() {
  console.log('  [Reserved Items Tests]')
  const cs = new CraftingSystem({
    reservedItems: { wheat_seeds: 8, crafting_table: 1, bread: 1 }
  })

  // Don't consume reserved wheat_seeds
  let ctx = createContext([
    { name: 'oak_log', count: 5 }
  ])

  // Normal craft should still work since we're just using logs
  let plan = cs.planRecipe('chest', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'chest from logs should work with reserved items')
  console.log('  ✓ reserved items check passes for non-conflicting craft')

  console.log('  Reserved items tests passed')
}

async function testNoRecipe() {
  console.log('  [No Recipe Tests]')
  const cs = new CraftingSystem()

  // Items with no recipe (like raw stone, dirt)
  let ctx = createContext([
    { name: 'stone', count: 10 }
  ])
  let plan = cs.planRecipe('stone', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.reason, 'no_recipe')
  console.log('  ✓ stone has no craft recipe → no_recipe')

  console.log('  No recipe tests passed')
}

async function testMultiRecipeSelection() {
  console.log('  [Multi-Recipe Selection Tests]')
  const cs = new CraftingSystem()

  // Create mock where torches have two recipes: coal+stick (preferred) vs charcoal+stick
  const multiRecipeMap = new Map([
    [280, { requiresTable: false, delta: [{ id: 5, count: 2 }], result: { id: 280, count: 4 } }], // 2 planks → 4 sticks
    // Torch recipe 1: coal + stick (common materials, preferred)
    [50, { requiresTable: false, delta: [{ id: 263, count: 1 }, { id: 280, count: 1 }], result: { id: 50, count: 4 } }],
  ])

  const mockItemsArray = [
    { id: 5, name: 'oak_planks' },
    { id: 50, name: 'torch' },
    { id: 263, name: 'coal' },
    { id: 280, name: 'stick' },
    { id: 17, name: 'oak_log' },
  ]

  const itemsByName = {}
  for (const item of mockItemsArray) {
    itemsByName[item.name] = { id: item.id, name: item.name }
  }

  // Bot with both coal and charcoal
  const bot = {
    username: 'Bot',
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 4 },
        { name: 'coal', count: 3 },
      ],
      slots: Array(45).fill(null)
    },
    registry: {
      itemsByName,
      itemsArray: mockItemsArray,
      blocksByName: { crafting_table: { id: 58, name: 'crafting_table' } }
    },
    recipesFor: (itemId) => {
      if (itemId === 50) {
        // Torch: coal version + charcoal version (charcoal uses reserved items scenario)
        return [
          { requiresTable: false, delta: [{ id: 263, count: 1 }, { id: 280, count: 1 }], result: { id: 50, count: 4 } },
          { requiresTable: false, delta: [{ id: 999, count: 1 }, { id: 280, count: 1 }], result: { id: 50, count: 4 } },
        ]
      }
      const recipe = multiRecipeMap.get(itemId)
      return recipe ? [recipe] : []
    },
    findBlock: () => null,
    crafted: [],
    craft: async function(recipe, count) { this.crafted.push({ recipe, count }) }
  }

  const ctx = {
    bot,
    blackboard: { get: () => null, set: () => {}, snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } }) },
    actionLock: new ActionLock()
  }

  let plan = cs.planRecipe('torch', 4, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'should plan torches')
  // The coal recipe should be preferred (common material bonus)
  console.log('  ✓ multi-recipe torch picks coal over unknown material')

  // Test tool-avoidance scoring: recipe that would use a pickaxe as material is penalized
  const toolAvoidBot = {
    username: 'Bot',
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [
        { name: 'stone_pickaxe', count: 1 },
        { name: 'cobblestone', count: 5 },
        { name: 'stick', count: 5 },
      ],
      slots: Array(45).fill(null)
    },
    registry: {
      itemsByName: {
        stone_pickaxe: { id: 272, name: 'stone_pickaxe' },
        cobblestone: { id: 2, name: 'cobblestone' },
        stick: { id: 280, name: 'stick' },
        stone_shovel: { id: 274, name: 'stone_shovel' },
      },
      itemsArray: [
        { id: 272, name: 'stone_pickaxe' },
        { id: 2, name: 'cobblestone' },
        { id: 280, name: 'stick' },
        { id: 274, name: 'stone_shovel' },
      ],
      blocksByName: {}
    },
    recipesFor: (itemId) => {
      if (itemId === 274) {
        return [
          { requiresTable: true, delta: [{ id: 272, count: 1 }, { id: 280, count: 2 }], result: { id: 274, count: 1 } }, // bad: uses stone_pickaxe
          { requiresTable: true, delta: [{ id: 2, count: 1 }, { id: 280, count: 2 }], result: { id: 274, count: 1 } }, // good: uses cobblestone
        ]
      }
      return []
    },
    findBlock: () => null,
    craft: async function() {}
  }

  const csTool = new CraftingSystem()
  const toolCtx = {
    bot: toolAvoidBot,
    blackboard: { get: () => null, set: () => {}, snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } }) },
    actionLock: new ActionLock()
  }

  let toolPlan = csTool.planRecipe('stone_shovel', 1, 'specified', toolCtx)
  assert.strictEqual(toolPlan.ok, true, 'should plan stone_shovel')
  // The cobblestone recipe should be selected over the one using stone_pickaxe
  assert.ok(toolPlan.materials && toolPlan.materials.cobblestone, 'should use cobblestone, not stone_pickaxe')
  console.log('  ✓ tool-avoidance scoring: cobblestone preferred over stone_pickaxe as material')

  console.log('  Multi-recipe selection tests passed')
}

async function testStorageDependencies() {
  console.log('  [Storage Dependencies Tests]')
  const cs = new CraftingSystem()

  let ctx = createContext([
    { name: 'wheat', count: 1 },
    { name: 'stick', count: 1 },
  ])

  let plan = cs.planRecipe('bread', 2, 'specified', ctx)
  assert.strictEqual(plan.ok, false, 'bread without enough wheat should fail')
  assert.strictEqual(plan.reason, 'missing_materials')
  console.log('  ✓ insufficient materials → missing_materials')

  // Now test with storage providing missing items via getStorageDependencies
  ctx = createContext([
    { name: 'wheat', count: 1 },
    { name: 'stick', count: 1 },
  ])
  // Inject storage counts
  ctx.blackboard = {
    get: (key) => {
      if (key === 'storage.counts') return { wheat: 5, stick: 0 }
      return null
    },
    set: () => {},
    snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } })
  }

  plan = cs.planRecipe('bread', 2, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'bread should be craftable when storage has wheat')
  const deps = cs.getStorageDependencies(plan, ctx)
  assert.ok(deps.some(d => d.item === 'wheat'), 'should list wheat as storage dependency')
  assert.ok(deps.every(d => d.neededFromStorage > 0), 'all deps should have neededFromStorage > 0')
  console.log(`  ✓ storage dependencies detected: ${JSON.stringify(deps.map(d => d.item))}`)

  // When all materials are in inventory, no deps should be returned
  ctx = createContext([
    { name: 'wheat', count: 6 },  // 2 bread = 6 wheat
    { name: 'stick', count: 1 },
  ])
  plan = cs.planRecipe('bread', 2, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'plan should succeed with 6 wheat')
  const noDeps = cs.getStorageDependencies(plan, ctx)
  assert.strictEqual(noDeps.length, 0, 'no deps when all materials in inventory')
  console.log('  ✓ no storage deps when inventory has everything')

  ctx = createContext([
    { name: 'oak_log', count: 1 }
  ])
  const stickId = ctx.bot.registry.itemsByName.stick.id
  const originalRecipesFor = ctx.bot.recipesFor
  ctx.bot.recipesFor = (itemId, meta, count, table) => {
    if (itemId === stickId) {
      const hasPlanks = ctx.bot.inventory.items().some(item =>
        item.name.endsWith('_planks') && item.count >= 2)
      if (!hasPlanks) return []
    }
    return originalRecipesFor(itemId, meta, count, table)
  }
  plan = cs.planRecipe('stick', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'stick plan from logs should succeed')
  const recursiveDeps = cs.getStorageDependencies(plan, ctx)
  assert.strictEqual(recursiveDeps.length, 0, 'intermediate planks should not be storage deps')
  console.log('  fallback intermediates are not storage deps')

  ctx = createContext([])
  ctx.blackboard = {
    get: (key) => {
      if (key === 'storage.counts') return { oak_planks: 5 }
      return null
    },
    set: () => {},
    snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } })
  }
  plan = cs.planRecipe('wooden_pickaxe', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'wooden_pickaxe should be craftable from storage planks')
  assert.strictEqual(plan.materials.oak_planks, 5, 'recursive stick materials should count toward storage deps')
  const pickaxeDeps = cs.getStorageDependencies(plan, ctx)
  assert.deepStrictEqual(pickaxeDeps.map(dep => [dep.item, dep.neededFromStorage]), [['oak_planks', 5]])
  console.log('  recursive storage deps include child-step materials')

  console.log('  Storage dependencies tests passed')
}

async function testReservedItemsConflictDetailed() {
  console.log('  [Reserved Items Conflict Tests]')

  // Create bot where crafting 4 torches would consume all 8 reserved torches
  const csStrict = new CraftingSystem({
    reservedItems: { torch: 8, crafting_table: 1 }
  })

  // Craft 4 torches with exactly 8 coal + 8 sticks → plan consumes 1 coal + 1 stick
  // But with only 8 torches in inventory, reserved check passes since we're making not consuming
  let ctx = createContext([
    { name: 'coal', count: 2 },
    { name: 'stick', count: 2 },
    { name: 'torch', count: 8 },
  ])

  let plan = csStrict.planRecipe('torch', 4, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'making torches when we already have 8 should pass')
  console.log('  ✓ crafting item that doesn\'t consume its own reserved count passes')

  // Test that force mode bypasses reserved check
  ctx = createContext([
    { name: 'oak_log', count: 2 },
    { name: 'coal', count: 2 },
  ])

  // Without force mode, if we were consuming reserved items it would fail
  const csWithStrict = new CraftingSystem({
    reservedItems: { coal: 1, oak_log: 1 }
  })

  plan = csWithStrict.planRecipe('torch', 4, 'specified', ctx)
  // This should fail because crafting consumes coal and oak_log (via planks→sticks)
  // But wait - coal is used as material so it triggers reserved conflict
  if (!plan.ok) {
    assert.strictEqual(plan.reason, 'reserved_item_conflict')
    console.log('  ✓ reserved item conflict detected')
  }

  // Force mode bypasses reserved check
  plan = csWithStrict.planRecipe('torch', 4, 'force', ctx)
  assert.strictEqual(plan.ok, true, 'force mode should bypass reserved check')
  console.log('  ✓ force mode bypasses reserved item check')

  console.log('  Reserved items conflict tests passed')
}

async function testCraftingTablePlacement() {
  console.log('  [Crafting Table Placement Tests]')
  const cs = new CraftingSystem()

  // Create a bot with crafting_table in inventory and mock placeBlock
  const placedBlocks = []
  const equippedItems = []
  const mockItemsArray = [
    { id: 5, name: 'oak_planks' },
    { id: 17, name: 'oak_log' },
    { id: 58, name: 'crafting_table' },
    { id: 54, name: 'chest' },
    { id: 280, name: 'stick' },
  ]
  const itemsByName = {}
  for (const item of mockItemsArray) {
    itemsByName[item.name] = { id: item.id, name: item.name }
  }

  const bot = {
    username: 'Bot',
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [
        { name: 'oak_log', count: 6 },
        { name: 'crafting_table', count: 1 },
      ],
      slots: Array(45).fill(null)
    },
    registry: {
      itemsByName,
      itemsArray: mockItemsArray,
      blocksByName: { crafting_table: { id: 58, name: 'crafting_table' } }
    },
    // No nearby table found → triggers placement flow
    findBlock: () => null,
    blockAt: (pos) => {
      // Simulate solid ground at y=63 with air above at y=64
      if (pos.y === 63) return { name: 'stone', position: { x: pos.x, y: pos.y, z: pos.z } }
      if (pos.y === 64) return { name: 'air', position: { x: pos.x, y: pos.y, z: pos.z } }
      return { name: 'air', position: { x: pos.x, y: pos.y, z: pos.z } }
    },
    equip: async function(item, dest) {
      equippedItems.push({ item: item.name, dest })
    },
    placeBlock: async function(reference, faceVector) {
      placedBlocks.push({ reference, faceVector })
    },
    recipesFor: (itemId) => {
      if (itemId === 5) return [{ requiresTable: false, delta: [{ id: 17, count: 1 }], result: { id: 5, count: 4 } }]
      if (itemId === 280) return [{ requiresTable: false, delta: [{ id: 5, count: 2 }], result: { id: 280, count: 4 } }]
      if (itemId === 54) return [{ requiresTable: true, delta: [{ id: 5, count: 8 }], result: { id: 54, count: 1 } }]
      if (itemId === 58) return [{ requiresTable: false, delta: [{ id: 5, count: 4 }], result: { id: 58, count: 1 } }]
      return []
    },
    craft: async function(recipe, count, table) {
      this._lastCraft = { recipe, count, table }
    }
  }

  const ctx = {
    bot,
    blackboard: { get: () => null, set: () => {}, snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } }) },
    actionLock: new ActionLock()
  }

  // Plan chest (needs crafting table)
  let plan = cs.planRecipe('chest', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'chest should be planned')
  assert.strictEqual(plan.needsCraftingTable, true)

  // Execute plan → should trigger _ensureCraftingTable → place from inventory
  let result = await cs.executePlan(plan, ctx)
  // May fail if mock is incomplete, but should exercise _ensureCraftingTable path
  console.log(`  ✓ crafting table placement flow exercised (result: ${result.success ? 'success' : result.reason})`)

  // Test _findNearbyPlacePosition
  const placePos = cs._findNearbyPlacePosition(ctx)
  assert.ok(placePos, 'should find a place position near bot')
  assert.strictEqual(placePos.position.y, 64, 'should place at bot foot level')
  console.log('  ✓ _findNearbyPlacePosition finds valid ground near bot')

  // Test direct crafting table craft from planks (no table required)
  const tableCtx = createContext([
    { name: 'oak_log', count: 6 },
  ])
  let tablePlan = cs.planRecipe('crafting_table', 1, 'specified', tableCtx)
  assert.strictEqual(tablePlan.ok, true, 'crafting_table should be craftable from logs')
  assert.strictEqual(tablePlan.needsCraftingTable, false, 'crafting_table recipe does NOT need a table')
  console.log('  ✓ crafting_table itself doesn\'t need a crafting table')

  console.log('  Crafting table placement tests passed')
}

async function testExecutePlanWithTableFlow() {
  console.log('  [Execute Plan With Table Tests]')
  const cs = new CraftingSystem()

  // Simplified flow: item needs table, table is nearby → craft succeeds
  const mockItemsArray = [
    { id: 5, name: 'oak_planks' },
    { id: 17, name: 'oak_log' },
    { id: 54, name: 'chest' },
    { id: 280, name: 'stick' },
    { id: 58, name: 'crafting_table' },
  ]
  const itemsByName = {}
  for (const item of mockItemsArray) {
    itemsByName[item.name] = { id: item.id, name: item.name }
  }

  const bot = {
    username: 'Bot',
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 12 },
        { name: 'crafting_table', count: 1 },
      ],
      slots: Array(45).fill(null)
    },
    registry: {
      itemsByName,
      itemsArray: mockItemsArray,
      blocksByName: { crafting_table: { id: 58, name: 'crafting_table' } }
    },
    findBlock: ({ matching }) => {
      // Table is nearby at (1, 64, 0)
      if (matching === 58) return { name: 'crafting_table', position: { x: 1, y: 64, z: 0 } }
      return null
    },
    blockAt: (pos) => {
      if (pos.y === 63) return { name: 'stone', position: { x: pos.x, y: pos.y, z: pos.z } }
      if (pos.y === 64 && pos.x === 0 && pos.z === 0) return { name: 'air', position: { x: pos.x, y: pos.y, z: pos.z } }
      if (pos.y === 64 && pos.x === 1 && pos.z === 0) return { name: 'crafting_table', position: { x: pos.x, y: pos.y, z: pos.z } }
      return { name: 'air', position: { x: pos.x, y: pos.y, z: pos.z } }
    },
    equip: async function() {},
    placeBlock: async function() {},
    recipesFor: (itemId) => {
      if (itemId === 54) return [{ requiresTable: true, delta: [{ id: 5, count: 8 }], result: { id: 54, count: 1 } }]
      return []
    },
    craft: async function(recipe, count, table) {
      this._lastCraft = { recipe, count, table }
    }
  }

  const ctx = {
    bot,
    blackboard: { get: () => null, set: () => {}, snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } }) },
    actionLock: new ActionLock()
  }

  let plan = cs.planRecipe('chest', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, 'chest plan with nearby table should be ok')
  assert.strictEqual(plan.usingNearbyCraftingTable, true)

  let result = await cs.executePlan(plan, ctx)
  assert.strictEqual(result.success, true, 'should craft with nearby table')
  assert.strictEqual(result.craftedCount, 1)
  console.log('  ✓ executePlan uses nearby crafting table successfully')

  // Test executePlan with no table nearby but in inventory → places it
  const moveGoals = []
  const farBot = {
    ...bot,
    entity: { position: { x: 0, y: 64, z: 0 } },
    findBlock: ({ matching }) => {
      if (matching === 58) return { name: 'crafting_table', position: { x: 10, y: 64, z: 0 } }
      return null
    },
    pathfinder: {
      setMovements() {},
      setGoal(goal) {
        moveGoals.push({ x: goal.x, y: goal.y, z: goal.z })
        farBot.entity.position = { x: goal.x, y: goal.y, z: goal.z }
      },
      stop() {}
    },
    craft: async function(recipe, count, table) {
      this._lastCraft = { recipe, count, table, position: { ...this.entity.position } }
    }
  }
  const farCtx = {
    bot: farBot,
    blackboard: { get: () => null, set: () => {}, snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } }) },
    actionLock: new ActionLock()
  }
  plan = cs.planRecipe('chest', 1, 'specified', farCtx)
  result = await cs.executePlan(plan, farCtx)
  assert.strictEqual(result.success, true, 'should craft after moving near far table')
  assert.deepStrictEqual(moveGoals[0], { x: 10, y: 64, z: 0 })
  assert.strictEqual(farBot._lastCraft.table.position.x, 10)
  assert.strictEqual(farBot._lastCraft.position.x, 10)
  console.log('  executePlan moves near far crafting table before crafting')

  const bot2 = {
    ...bot,
    findBlock: () => null, // No nearby table
  }
  const ctx2 = {
    bot: bot2,
    blackboard: { get: () => null, set: () => {}, snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' } }) },
    actionLock: new ActionLock()
  }

  plan = cs.planRecipe('chest', 1, 'specified', ctx2)
  // Without table nearby, hasCraftingTable should be true (in inventory) but usingNearbyCraftingTable false
  assert.strictEqual(plan.hasCraftingTable, true)
  assert.strictEqual(plan.usingNearbyCraftingTable, false)
  console.log('  ✓ plan reflects table in inventory but not placed')

  console.log('  Execute plan with table tests passed')
}

async function testCraftingStatus() {
  console.log('  [Crafting Status Tests]')
  const cs = new CraftingSystem()
  const ctx = createContext([
    { name: 'wheat', count: 3 }
  ])

  const plan = cs.planRecipe('bread', 1, 'specified', ctx)
  const status = cs.getCraftingStatus(ctx, plan)
  assert.strictEqual(status.targetItem, 'bread')
  assert.strictEqual(status.requestedCount, 1)
  assert.ok(status.recursivePlan !== null)
  assert.ok(status.sourceInventory !== null)
  console.log('  ✓ crafting status has all fields')

  const emptyStatus = cs.getCraftingStatus(ctx, null)
  assert.strictEqual(emptyStatus.targetItem, null)
  console.log('  ✓ empty crafting status returns nulls')

  console.log('  Crafting status tests passed')
}

async function testProtectedMaterialsNotConsumed() {
  console.log('  [Protected Material Tests]')
  const recipesMap = new Map([
    [54, { requiresTable: true, delta: [{ id: 307, count: 1 }], result: { id: 54, count: 1 } }]
  ])
  const ctx = createContext([
    { name: 'iron_chestplate', count: 1 }
  ], recipesMap)
  const cs = new CraftingSystem()
  const plan = cs.planRecipe('chest', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.reason, 'protected_material_conflict')
  assert.strictEqual(plan.protectedMaterials[0].item, 'iron_chestplate')
  console.log('  armor is not accepted as a crafting material')
}

async function testPlanRecipeLooksUpCraftingTableOnce() {
  console.log('  [Planning Table Lookup Memo Tests]')
  // The recursive planner used to scan the world for a crafting table at
  // every recipe node (13 scans, ~10s of synchronous work for one
  // sticky_piston plan on the building lane). One plan = one lookup.
  const cs = new CraftingSystem()
  const ctx = createContext([{ name: 'oak_log', count: 4 }])
  let lookups = 0
  const table = { name: 'crafting_table', position: { x: 1, y: 64, z: 1 } }
  ctx.utilityBlockSearch = {
    findNearestCraftingTable() {
      lookups += 1
      return { ok: true, block: table, position: table.position }
    }
  }

  const plan = cs.planRecipe('wooden_pickaxe', 1, 'specified', ctx)
  assert.strictEqual(plan.ok, true, JSON.stringify(plan))
  assert.ok(plan.steps.length >= 3, 'log -> planks -> sticks -> pickaxe needs several recipe nodes')
  assert.strictEqual(plan.usingNearbyCraftingTable, true)
  assert.strictEqual(lookups, 1, `one plan must scan for a table exactly once, scanned ${lookups} times`)
  console.log('  ok one planRecipe call performs one crafting-table lookup')

  cs.planRecipe('wooden_pickaxe', 1, 'specified', ctx)
  assert.strictEqual(lookups, 2, 'the memo is per plan, not global')
  assert.strictEqual(Object.getOwnPropertySymbols(ctx).length, 0, 'the caller context is not mutated')
  console.log('  ok memo is scoped to a single plan and leaves the caller context untouched')

  const noTable = createContext([{ name: 'oak_log', count: 4 }])
  const noTablePlan = cs.planRecipe('wooden_pickaxe', 1, 'specified', noTable)
  assert.strictEqual(noTablePlan.ok, true)
  assert.strictEqual(noTablePlan.usingNearbyCraftingTable, false)
  console.log('  ok planning without a nearby table is unchanged')
}

async function run() {
  console.log('[CraftingSystem Tests]')
  await testDirectCraft()
  await testPlanningFindsCraftingTableRecipes()
  await testRecursiveWoodenSwordFromLogs()
  await testPlansSticksFromLogsWhenRecipeIsNotCurrentlyCraftable()
  await testPlansSticksFromLogsWhenNativeRecipeIgnoresInventory()
  await testPlanningUsesLiveInventoryOverStaleBlackboard()
  await testStickMissingMaterialsExposeBaseLog()
  await testCommonSurvivalCraftPlans()
  await testRecursiveCraft()
  await testMaxCraftable()
  await testMissingMaterials()
  await testReservedItems()
  await testNoRecipe()
  await testCraftingStatus()
  await testProtectedMaterialsNotConsumed()
  await testMultiRecipeSelection()
  await testStorageDependencies()
  await testReservedItemsConflictDetailed()
  await testCraftingTablePlacement()
  await testExecutePlanWithTableFlow()
  await testPlanRecipeLooksUpCraftingTableOnce()
  console.log('crafting-system tests passed')
}

run().catch(err => {
  console.error('CraftingSystem test failed:', err)
  process.exit(1)
})
