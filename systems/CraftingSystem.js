const { Vec3 } = require('vec3')
const { moveTo } = require('../actions/move')

const PLANK_TYPES = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'bamboo_planks', 'crimson_planks', 'warped_planks']

const LOG_TO_PLANK = {
  oak_log: 'oak_planks', spruce_log: 'spruce_planks', birch_log: 'birch_planks',
  jungle_log: 'jungle_planks', acacia_log: 'acacia_planks', dark_oak_log: 'dark_oak_planks',
  mangrove_log: 'mangrove_planks', cherry_log: 'cherry_planks',
  bamboo_block: 'bamboo_planks', crimson_stem: 'crimson_planks', warped_stem: 'warped_planks'
}

const TOOL_NAME_PATTERN = /_(pickaxe|axe|shovel|hoe|sword)$/
const PROTECTED_MATERIAL_PATTERN = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(bow|crossbow|trident|shield)$/

const COMMON_MATERIALS = new Set([
  'cobblestone', 'dirt', 'stone', 'sand', 'gravel', 'oak_planks', 'spruce_planks',
  'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'stick', 'coal'
])

const BASE_MATERIALS = new Set([
  'iron_ingot', 'gold_ingot', 'copper_ingot', 'diamond', 'emerald', 'coal', 'charcoal',
  'redstone', 'lapis_lazuli', 'quartz', 'cobblestone', 'wheat'
])

const DEFAULT_RESERVED_ITEMS = {
  crafting_table: 1,
  wheat_seeds: 8,
  bread: 1,
  torch: 8,
  iron_pickaxe: 1,
  stone_pickaxe: 1
}

const DEFAULT_CRAFT_MULTIPLIERS = {
  stick: 8,
  torch: 8,
  bread: 3,
  ladder: 8,
  fence: 4,
  fence_gate: 1,
  sign: 3,
  arrow: 8,
  paper: 3,
  book: 1,
  bookshelf: 1
}

const ABSTRACT_TOOL_TARGETS = {
  pickaxe: ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'],
  axe: ['iron_axe', 'stone_axe', 'wooden_axe'],
  hoe: ['iron_hoe', 'stone_hoe', 'wooden_hoe'],
  shovel: ['iron_shovel', 'stone_shovel', 'wooden_shovel'],
  sword: ['iron_sword', 'stone_sword', 'wooden_sword']
}

const TOOL_MATERIAL_NEEDS = {
  pickaxe: 3,
  axe: 3,
  hoe: 2,
  shovel: 1,
  sword: 2
}

const COMMON_SURVIVAL_RECIPES = {
  wooden_pickaxe: {
    requiresTable: true,
    materialVariants: PLANK_TYPES,
    shape: [
      ['material', 'material', 'material'],
      [null, 'stick', null],
      [null, 'stick', null]
    ]
  },
  stone_pickaxe: {
    requiresTable: true,
    materialVariants: ['cobblestone'],
    shape: [
      ['material', 'material', 'material'],
      [null, 'stick', null],
      [null, 'stick', null]
    ]
  },
  iron_pickaxe: {
    requiresTable: true,
    materialVariants: ['iron_ingot'],
    shape: [
      ['material', 'material', 'material'],
      [null, 'stick', null],
      [null, 'stick', null]
    ]
  },
  wooden_sword: {
    requiresTable: true,
    materialVariants: PLANK_TYPES,
    shape: [
      ['material'],
      ['material'],
      ['stick']
    ]
  },
  torch: {
    requiresTable: false,
    materialVariants: ['coal', 'charcoal'],
    resultCount: 4,
    shape: [
      ['material'],
      ['stick']
    ]
  }
}

const PLANNING_CRAFTING_TABLE_MEMO = Symbol('planningCraftingTableMemo')

function withPlanningCraftingTableMemo(context) {
  if (!context || typeof context !== 'object' || context[PLANNING_CRAFTING_TABLE_MEMO]) return context
  return { ...context, [PLANNING_CRAFTING_TABLE_MEMO]: { table: undefined } }
}

class CraftingSystem {
  constructor(options = {}) {
    this.options = {
      maxRecursionDepth: 5,
      reservedItems: { ...DEFAULT_RESERVED_ITEMS, ...(options.reservedItems || {}) },
      ...options
    }
  }

  planRecipe(itemName, requestedCount = 1, craftMode = 'specified', context = {}) {
    if (ABSTRACT_TOOL_TARGETS[itemName]) {
      return this._planAbstractTool(itemName, requestedCount, craftMode, context)
    }

    const bot = context.bot
    if (!bot?.registry?.itemsByName) return this._fail('missing_item_registry')
    if (!itemName) return this._fail('missing_item_name')
    if (typeof bot.recipesFor !== 'function') return this._fail('missing_recipesFor')

    const item = bot.registry.itemsByName[itemName]
    if (!item) return this._fail('unknown_item', { itemName })

    // One crafting-table lookup per plan. The recursive planner used to run a
    // fresh radius-32 + radius-64 world scan at every recipe node (13 scans,
    // ~10s of synchronous work for one sticky_piston plan on the building
    // lane), long enough to starve the socket and get the client kicked.
    context = withPlanningCraftingTableMemo(context)

    const inventoryCounts = this._getInventoryCounts(context)
    const storageCounts = this._getStorageCounts(context) || {}

    if (craftMode === 'max_possible') {
      const maxPossible = this._calculateMaxCraftable(item, inventoryCounts, storageCounts, context)
      requestedCount = maxPossible
    } else if (requestedCount <= 0) {
      requestedCount = DEFAULT_CRAFT_MULTIPLIERS[itemName] || 1
    }

    const plan = this._planRecursive(item, requestedCount, inventoryCounts, storageCounts, 0, context)
    if (!plan.ok) return plan

    const reservedConflicts = this._checkReservedConflicts(plan, inventoryCounts)
    if (reservedConflicts.length > 0 && craftMode !== 'max_possible' && craftMode !== 'force') {
      return this._fail('reserved_item_conflict', { targetItem: itemName, reservedConflicts })
    }

    return plan
  }

  async executePlan(plan, context = {}) {
    if (!plan.ok) return plan
    if (!plan.steps || plan.steps.length === 0) {
      return { success: true, targetItem: plan.targetItem, craftedCount: 0, steps: [] }
    }

    const bot = context.bot
    if (typeof bot.craft !== 'function') return this._fail('missing_craft_api')

    let craftedCount = 0
    const executedSteps = []

    for (const step of plan.steps) {
      const craftingTable = step.needsCraftingTable
        ? (plan.craftingTableBlock || this._findNearbyCraftingTable(context))
        : null

      if (step.needsCraftingTable && !craftingTable) {
        const tableCheck = await this._ensureCraftingTable(context)
        if (!tableCheck.ok) {
          return { ...plan, success: false, reason: 'missing_crafting_table',
            craftedCount, executedSteps, lastError: tableCheck.reason }
        }
        plan.craftingTableBlock = tableCheck.block
      }

      const currentCraftingTable = step.needsCraftingTable
        ? (plan.craftingTableBlock || craftingTable)
        : null
      if (currentCraftingTable) {
        const reachable = await this._moveNearCraftingTable(context, currentCraftingTable)
        if (!reachable.ok) {
          return { ...plan, success: false, reason: 'crafting_table_unreachable',
            itemName: step.item, craftedCount, executedSteps, lastError: reachable.reason }
        }
      }

      const item = bot.registry.itemsByName[step.item]
      if (!item) {
        return { ...plan, success: false, reason: 'unknown_step_item',
          itemName: step.item, craftedCount, executedSteps }
      }

      const recipes = this._recipesForExecution(context, item.id, step.count, currentCraftingTable)
      if (!recipes || recipes.length === 0) {
        const missing = this._getMissingMaterials(step, context)
        return { ...plan, success: false, reason: 'no_recipe_available',
          itemName: step.item, craftedCount, executedSteps, missingMaterials: missing }
      }

      const recipe = this._selectBestRecipe(recipes, context)
      if (!recipe) {
        const missing = this._getMissingMaterials(step, context)
        return { ...plan, success: false, reason: 'no_recipe_available',
          itemName: step.item, craftedCount, executedSteps, missingMaterials: missing }
      }

      try {
        await bot.craft(recipe, step.count, currentCraftingTable)
        craftedCount += step.count
        executedSteps.push({ ...step, success: true })
        await sleep(250)

        if (step.item === plan.targetItem) {
          plan.craftedCount = craftedCount
        }
      } catch (err) {
        return { ...plan, success: false, reason: 'craft_failed',
          itemName: step.item, error: err.message, craftedCount, executedSteps }
      }
    }

    return {
      ...plan,
      success: true,
      craftedCount,
      executedSteps,
      targetItem: plan.targetItem,
      requestedCount: plan.requestedCount
    }
  }

  _selectBestRecipe(recipes, context) {
    if (!recipes || recipes.length <= 1) return recipes?.[0] || null
    const counts = this._getInventoryCounts(context)
    const storageCounts = this._getStorageCounts(context) || {}
    const reserved = this.options.reservedItems
    let bestRecipe = null
    let bestScore = -Infinity
    for (const recipe of recipes) {
      let score = 100
      if (recipe.requiresTable) score -= 5
      const inputItems = this._recipeInputItems(recipe, context.bot)
      if (inputItems.length) {
        for (const deltaItem of inputItems) {
          const name = this._itemNameById(context.bot, deltaItem.id)
          if (!name) continue
          const available = (counts[name] || 0) + (storageCounts[name] || 0)
          if (TOOL_NAME_PATTERN.test(name)) score -= 30
          if (PROTECTED_MATERIAL_PATTERN.test(name)) score -= 50
          if (reserved[name]) score -= 20
          if (available >= deltaItem.count * 2) score += 4
          if (COMMON_MATERIALS.has(name)) score += 3
        }
      }
      if (recipe.result?.count > 1) score += Math.min(recipe.result.count, 8)
      if (score > bestScore) {
        bestScore = score
        bestRecipe = recipe
      }
    }
    return bestRecipe
  }

  _planRecursive(item, count, inventory, storage, depth, context) {
    if (depth > this.options.maxRecursionDepth) {
      return this._fail('recursion_depth_exceeded', { item: item.name, depth })
    }

    const bot = context.bot
    const itemId = item.id
    const recipes = this._recipesForPlanning(context, itemId, 1)
    if (!recipes || recipes.length === 0) {
      return this._fail('no_recipe', { itemName: item.name })
    }

    const recipe = this._selectBestRecipe(recipes, context)
    const needsCraftingTable = recipe.requiresTable === true
    const outputPerCraft = recipe.result?.count || 1
    const craftRuns = Math.max(1, Math.ceil(count / outputPerCraft))
    const protectedMaterials = this._getProtectedMaterialUse(recipe, craftRuns, bot, context)
    if (protectedMaterials.length > 0) {
      return this._fail('protected_material_conflict', {
        targetItem: item.name,
        protectedMaterials
      })
    }

    const allMaterials = {}
    const steps = []
    const missingMaterials = []

    const recipeInputs = this._recipeInputItems(recipe, bot)
    if (recipeInputs.length) {
      for (const deltaItem of recipeInputs) {
        const deltaName = this._itemNameById(bot, deltaItem.id)
        if (!deltaName) continue

        const needed = deltaItem.count * craftRuns
        allMaterials[deltaName] = (allMaterials[deltaName] || 0) + needed

        let available = availableCount(inventory, storage, deltaName)
        let shortfall = Math.max(0, needed - available)
        if (shortfall > 0) {
          if (BASE_MATERIALS.has(deltaName)) {
            missingMaterials.push({ item: deltaName, needed: shortfall, available,
              canCraft: false })
            continue
          }
          const subItem = bot.registry.itemsByName[deltaName]
          if (subItem && this._recipesForPlanning(context, subItem.id, 1).length > 0) {
            const subPlan = this._planRecursive(subItem, shortfall, inventory, storage, depth + 1, context)
            if (subPlan.ok) {
              for (const step of subPlan.steps) {
                steps.push(step)
              }
              mergeMaterialCounts(allMaterials, subPlan.materials)
              available = availableCount(inventory, storage, deltaName)
              shortfall = Math.max(0, needed - available)
              if (shortfall > 0) {
                missingMaterials.push({ item: deltaName, needed: shortfall, available,
                  canCraft: true })
              }
            } else if (subPlan.reason === 'missing_materials' && Array.isArray(subPlan.missingMaterials) && subPlan.missingMaterials.length > 0) {
              missingMaterials.push(...subPlan.missingMaterials)
            } else {
              missingMaterials.push({ item: deltaName, needed: shortfall, available,
                canCraft: subPlan.reason !== 'no_recipe' })
            }
          } else {
            missingMaterials.push({ item: deltaName, needed: shortfall, available,
              canCraft: false })
          }
        }
      }
    }

    if (missingMaterials.length > 0) {
      return { ok: false, reason: 'missing_materials', targetItem: item.name,
        requestedCount: count, needsCraftingTable, missingMaterials, materials: allMaterials }
    }

    const recipeMaterials = {}
    if (recipeInputs.length) {
      for (const deltaItem of recipeInputs) {
        const deltaName = this._itemNameById(bot, deltaItem.id)
        if (deltaName) recipeMaterials[deltaName] = deltaItem.count * craftRuns
      }
    }

    for (const [matName, matCount] of Object.entries(recipeMaterials)) {
      consumeAvailable(inventory, storage, matName, matCount)
    }
    inventory[item.name] = (inventory[item.name] || 0) + (craftRuns * outputPerCraft)

    steps.push({
      step: steps.length + 1,
      item: item.name,
      count: craftRuns,
      needsCraftingTable,
      materials: recipeMaterials,
      depth
    })

    return {
      ok: true,
      targetItem: item.name,
      abstractTarget: null,
      selectedFromAbstract: null,
      requestedCount: count,
      plannedCount: craftRuns * outputPerCraft,
      needsCraftingTable,
      craftMode: 'specified',
      steps,
      materials: allMaterials,
      missingMaterials: [],
      hasCraftingTable: needsCraftingTable ? this._hasCraftingTable(context) : true,
      usingNearbyCraftingTable: needsCraftingTable ? Boolean(this._planningCraftingTable(context)) : false
    }
  }

  _calculateMaxCraftable(item, inventory, storage, context) {
    const recipes = this._recipesForPlanning(context, item.id, 1)
    if (!recipes || recipes.length === 0) return 0

    const recipe = this._selectBestRecipe(recipes, context)
    const recipeInputs = this._recipeInputItems(recipe, context.bot)
    if (!recipeInputs.length) return 0
    const outputPerCraft = recipe.result?.count || 1

    let max = Infinity

    for (const deltaItem of recipeInputs) {
      const deltaName = this._itemNameById(context.bot, deltaItem.id)
      if (!deltaName) continue

      const available = (inventory[deltaName] || 0) + (storage[deltaName] || 0)
      const subItem = context.bot.registry.itemsByName[deltaName]
      const canCraftSub = subItem ? (this._recipesForPlanning(context, subItem.id, 1).length > 0) : false

      if (available < deltaItem.count && canCraftSub) {
        const subMax = this._calculateMaxCraftable(subItem, inventory, storage, context)
        const totalAvailable = available + subMax
        max = Math.min(max, Math.floor(totalAvailable / deltaItem.count))
      } else {
        max = Math.min(max, Math.floor(available / deltaItem.count))
      }
    }

    return max === Infinity ? 0 : Math.max(0, max * outputPerCraft)
  }

  async _ensureCraftingTable(context) {
    const nearby = this._findNearbyCraftingTable(context)
    if (nearby) return { ok: true, block: nearby, source: 'nearby' }

    if (this._hasCraftingTable(context)) {
      const placed = await this._placeCraftingTable(context)
      if (placed.ok) return { ok: true, block: placed.block, source: 'placed' }
      return { ok: false, reason: placed.reason }
    }

    const counts = this._getInventoryCounts(context)
    const plankType = PLANK_TYPES.find(name => (counts[name] || 0) >= 4)
    if (plankType) {
      const crafted = await this._craftItemDirectly(context, 'crafting_table', 1)
      if (crafted.success) {
        const placed = await this._placeCraftingTable(context)
        if (placed.ok) return { ok: true, block: placed.block, source: 'crafted_and_placed' }
        return { ok: false, reason: 'crafted_but_place_failed', lastError: placed.reason }
      }
      return { ok: false, reason: 'craft_table_from_planks_failed', lastError: crafted.reason }
    }

    const logEntry = Object.entries(LOG_TO_PLANK).find(([logName]) => (counts[logName] || 0) >= 1)
    if (logEntry) {
      const [logName, targetPlank] = logEntry
      const planksMade = await this._craftItemDirectly(context, targetPlank, 4)
      if (!planksMade.success) {
        return { ok: false, reason: 'craft_planks_from_log_failed', lastError: planksMade.reason }
      }
      const tableMade = await this._craftItemDirectly(context, 'crafting_table', 1)
      if (!tableMade.success) {
        return { ok: false, reason: 'craft_table_from_planks_failed', lastError: tableMade.reason }
      }
      const placed = await this._placeCraftingTable(context)
      if (placed.ok) return { ok: true, block: placed.block, source: 'log_to_table' }
      return { ok: false, reason: 'log_to_table_place_failed', lastError: placed.reason }
    }

    return { ok: false, reason: 'missing_crafting_table_materials' }
  }

  async _moveNearCraftingTable(context, craftingTable) {
    const bot = context.bot
    if (!craftingTable?.position || !bot?.entity?.position) return { ok: true, reason: 'crafting_table_position_unknown' }
    const range = Number(this.options.craftingTableReachRange ?? 3)
    if (positionDistance(bot.entity.position, craftingTable.position) <= range) {
      return { ok: true, reason: 'crafting_table_already_reachable' }
    }
    if (!bot.pathfinder || !context.actionLock) {
      return { ok: false, reason: 'crafting_table_movement_unavailable' }
    }

    this._log(context, `[crafting] moving to crafting_table at ${formatPos(craftingTable.position)}`)
    const moved = await moveTo(context, craftingTable.position, {
      owner: context.task?.id || context.owner || 'crafting_table_reach',
      range,
      timeoutMs: Number(this.options.craftingTableMoveTimeoutMs ?? 20000),
      canDig: false,
      allowScaffolding: false
    })
    if (!moved.ok) return { ok: false, reason: moved.error || moved.reason || 'move_failed' }
    return { ok: true, reason: moved.message || 'crafting_table_reached' }
  }

  async _placeCraftingTable(context) {
    const bot = context.bot
    const placePos = this._findNearbyPlacePosition(context)
    if (!placePos) return { ok: false, reason: 'no_suitable_place_position' }

    const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table')
    if (!tableItem) return { ok: false, reason: 'crafting_table_not_in_inventory' }

    const lock = this._acquirePlacementLock(context)
    if (!lock.ok) return { ok: false, reason: lock.reason || 'building_lock_unavailable' }

    try {
      this._log(context, `[crafting] placing crafting_table at ${formatPos(placePos.position)}`)
      await bot.equip(tableItem, 'hand')
      await bot.placeBlock(placePos.below, new Vec3(0, 1, 0))
      const block = await this._waitForPlacedCraftingTable(context, placePos.position)
      if (!block) return { ok: false, reason: 'placed_table_not_observed' }
      context.utilityBlockSearch?.rememberUtilityBlock?.(context, 'crafting_table', block.position, {
        source: 'crafted_by_bot',
        blockName: 'crafting_table'
      })
      return { ok: true, block, source: 'placed' }
    } catch (err) {
      return { ok: false, reason: 'place_failed', error: err.message }
    } finally {
      this._releasePlacementLock(context, lock)
    }
  }

  async _craftItemDirectly(context, itemName, count) {
    const bot = context.bot
    const item = bot.registry.itemsByName[itemName]
    if (!item) return { success: false, reason: 'unknown_item', itemName }

    const recipes = bot.recipesFor(item.id, null, count, null)
    if (!recipes || recipes.length === 0) {
      return { success: false, reason: 'no_recipe', itemName }
    }

    try {
      await bot.craft(this._selectBestRecipe(recipes, context), count, null)
      return { success: true, itemName, count }
    } catch (err) {
      return { success: false, reason: 'craft_failed', itemName, error: err.message }
    }
  }

  _findNearbyPlacePosition(context) {
    const bot = context.bot
    if (!bot?.entity?.position || typeof bot.blockAt !== 'function') return null

    const pos = bot.entity.position
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
          for (let dy = -1; dy <= 0; dy++) {
            const bx = Math.floor(pos.x) + dx
            const by = Math.floor(pos.y) + dy
            const bz = Math.floor(pos.z) + dz

            const below = bot.blockAt(new Vec3(bx, by - 1, bz))
            if (!below || below.name === 'air') continue

            const block = bot.blockAt(new Vec3(bx, by, bz))
            if (!block || block.name !== 'air') continue
            if (this._isPlacementObstructedByEntity(context, { x: bx, y: by, z: bz })) continue

            const dist = Math.sqrt((pos.x - (bx + 0.5)) ** 2 +
              (pos.y - (by + 0.5)) ** 2 + (pos.z - (bz + 0.5)) ** 2)
            if (dist >= 1.25 && dist <= 4.5) {
              return { position: { x: bx, y: by, z: bz }, below }
            }
          }
        }
      }
    }
    return null
  }

  _isPlacementObstructedByEntity(context, position) {
    const entities = context.bot?.entities || {}
    for (const entity of Object.values(entities)) {
      const entityPos = entity?.position
      if (!entityPos) continue
      const dx = Math.abs(entityPos.x - (position.x + 0.5))
      const dz = Math.abs(entityPos.z - (position.z + 0.5))
      const dy = entityPos.y - position.y
      if (dx < 0.85 && dz < 0.85 && dy > -0.2 && dy < 1.9) return true
    }
    return false
  }

  async _waitForPlacedCraftingTable(context, position) {
    const bot = context.bot
    const target = new Vec3(position.x, position.y, position.z)
    for (let attempt = 0; attempt < 12; attempt++) {
      const block = bot.blockAt(target)
      if (block?.name === 'crafting_table') return block
      await sleep(150)
    }
    return null
  }

  _acquirePlacementLock(context) {
    if (!context.actionLock?.acquireMany) return { ok: true, owner: null }
    const owner = context.taskManager?.currentTask?.id ||
      context.currentTask?.id ||
      context.task?.id ||
      'crafting_table_placement'
    const result = context.actionLock.acquireMany(['building'], owner, {
      reason: 'crafting:place_crafting_table'
    })
    if (!result.ok) return { ok: false, reason: result.reason, owner, currentOwner: result.currentOwner }
    this._log(context, `[ACTION_LOCK_ACQUIRE] lock=building taskId=${owner}`)
    return { ok: true, owner }
  }

  _releasePlacementLock(context, lock) {
    if (!lock?.ok || lock.owner == null || !context.actionLock?.release) return
    const result = context.actionLock.release('building', lock.owner)
    if (result?.ok) this._log(context, `[ACTION_LOCK_RELEASE] lock=building taskId=${lock.owner}`)
  }

  _findNearbyCraftingTable(context) {
    const bot = context.bot
    const utility = context.utilityBlockSearch
    if (utility?.findNearestCraftingTable) {
      const found = utility.findNearestCraftingTable(context, { nearbyRadius: 32, baseRadius: 64 })
      if (found.ok) return found.block || { name: 'crafting_table', position: found.position }
    }

    const tableId = bot.registry?.blocksByName?.crafting_table?.id
    if (tableId == null || typeof bot.findBlock !== 'function') return null
    return bot.findBlock({ matching: tableId, maxDistance: 32 }) || null
  }

  // Planning-time table lookup: memoized on the planning context (see
  // planRecipe). Outside a plan it is a plain lookup.
  _planningCraftingTable(context) {
    const memo = context?.[PLANNING_CRAFTING_TABLE_MEMO]
    if (!memo) return this._findNearbyCraftingTable(context)
    if (memo.table === undefined) memo.table = this._findNearbyCraftingTable(context)
    return memo.table
  }

  _recipesForPlanning(context, itemId, count = 1) {
    const bot = context.bot
    if (typeof bot?.recipesFor !== 'function') return []
    const itemName = this._itemNameById(bot, itemId)

    if (itemName === 'stick' && !this._hasAvailablePlanks(context)) {
      return this._fallbackPlanningRecipes(context, itemId)
    }

    const nearbyTable = this._planningCraftingTable(context)
    const candidates = [
      nearbyTable,
      null,
      { name: 'crafting_table', position: null }
    ]

    for (const table of candidates) {
      const recipes = bot.recipesFor(itemId, null, count, table) || []
      if (recipes.length > 0) return recipes
    }
    const allRecipes = this._recipesAllForItem(context, itemId, nearbyTable)
    if (allRecipes.length > 0) return allRecipes
    return this._fallbackPlanningRecipes(context, itemId)
  }

  _recipesForExecution(context, itemId, count = 1, craftingTable = null) {
    const bot = context.bot
    if (typeof bot?.recipesFor !== 'function') return []
    const recipes = bot.recipesFor(itemId, null, count, craftingTable) || []
    if (recipes.length > 0) return recipes
    const allRecipes = this._recipesAllForItem(context, itemId, craftingTable)
    if (allRecipes.length > 0) return allRecipes
    return this._fallbackPlanningRecipes(context, itemId)
      .filter(recipe => !recipe.requiresTable || craftingTable)
  }

  _recipesAllForItem(context, itemId, craftingTable = null) {
    const bot = context.bot
    if (typeof bot?.recipesAll !== 'function') return []
    const candidates = [
      craftingTable,
      null,
      { name: 'crafting_table', position: null }
    ]
    for (const table of candidates) {
      const recipes = bot.recipesAll(itemId, null, table) || []
      if (recipes.length > 0) return recipes
    }
    return []
  }

  _hasAvailablePlanks(context) {
    const inventoryCounts = this._getInventoryCounts(context)
    const storageCounts = this._getStorageCounts(context) || {}
    return PLANK_TYPES.some(name => ((inventoryCounts[name] || 0) + (storageCounts[name] || 0)) >= 2)
  }

  _fallbackPlanningRecipes(context, itemId) {
    const bot = context.bot
    const itemName = this._itemNameById(bot, itemId)
    const item = itemName ? bot.registry?.itemsByName?.[itemName] : null
    if (!item) return []

    if (itemName === 'stick') {
      const counts = this._getInventoryCounts(context)
      const plankRecipes = PLANK_TYPES
        .map(plankName => {
          const plankItem = bot.registry?.itemsByName?.[plankName]
          if (!plankItem) return null
          const logEntry = Object.entries(LOG_TO_PLANK)
            .find(([, targetPlank]) => targetPlank === plankName)
          const logPotential = logEntry ? (counts[logEntry[0]] || 0) * 4 : 0
          const available = (counts[plankName] || 0) + logPotential
          return {
            recipe: {
              requiresTable: false,
              delta: [{ id: plankItem.id, count: 2 }],
              result: { id: item.id, count: 4 }
            },
            available
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.available - a.available)
      return plankRecipes.map(entry => entry.recipe)
    }

    const logEntry = Object.entries(LOG_TO_PLANK)
      .find(([, plankName]) => plankName === itemName)
    if (logEntry) {
      const logItem = bot.registry?.itemsByName?.[logEntry[0]]
      if (!logItem) return []
      return [{
        requiresTable: false,
        delta: [{ id: logItem.id, count: 1 }],
        result: { id: item.id, count: 4 }
      }]
    }

    const commonRecipe = COMMON_SURVIVAL_RECIPES[itemName]
    if (commonRecipe) return this._commonSurvivalRecipes(context, item, commonRecipe)

    return []
  }

  _commonSurvivalRecipes(context, targetItem, recipeSpec) {
    const bot = context.bot
    const counts = this._getInventoryCounts(context)
    const storageCounts = this._getStorageCounts(context) || {}

    return recipeSpec.materialVariants
      .map(materialName => {
        const materialItem = bot.registry?.itemsByName?.[materialName]
        if (!materialItem) return null
        const available = (counts[materialName] || 0) + (storageCounts[materialName] || 0)
        const inShape = recipeSpec.shape.map(row => row.map(cell => {
          if (cell === 'material') return { id: materialItem.id, count: 1 }
          if (typeof cell === 'string') {
            const item = bot.registry?.itemsByName?.[cell]
            return item ? { id: item.id, count: 1 } : null
          }
          return { id: -1, count: 1 }
        }))
        if (inShape.some(row => row.some(cell => cell == null))) return null
        return {
          requiresTable: Boolean(recipeSpec.requiresTable),
          inShape,
          result: { id: targetItem.id, count: recipeSpec.resultCount || 1 },
          available
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.available - a.available)
  }

  _hasCraftingTable(context) {
    const counts = this._getInventoryCounts(context)
    return (counts.crafting_table || 0) > 0
  }

  _checkReservedConflicts(plan, inventoryCounts) {
    const conflicts = []
    const reserved = this.options.reservedItems

    for (const [itemName, reservedCount] of Object.entries(reserved)) {
      if (!plan.materials || !plan.materials[itemName]) continue
      const needed = plan.materials[itemName]
      const available = inventoryCounts[itemName] || 0
      const afterCraft = available - needed
      if (afterCraft < reservedCount) {
        conflicts.push({ item: itemName, reserved: reservedCount, needed, available, afterCraft })
      }
    }

    return conflicts
  }

  _getProtectedMaterialUse(recipe, craftRuns, bot, context) {
    const protectedMaterials = []
    const equippedArmorNames = new Set()
    const armorSlots = [5, 6, 7, 8]
    for (const index of armorSlots) {
      const item = context.bot?.inventory?.slots?.[index]
      if (item?.name) equippedArmorNames.add(item.name)
    }

    for (const deltaItem of this._recipeInputItems(recipe, bot)) {
      const name = this._itemNameById(bot, deltaItem.id)
      if (!name) continue
      if (!PROTECTED_MATERIAL_PATTERN.test(name) && !equippedArmorNames.has(name)) continue
      protectedMaterials.push({
        item: name,
        needed: deltaItem.count * craftRuns,
        equipped: equippedArmorNames.has(name)
      })
    }
    return protectedMaterials
  }


  _getMissingMaterials(step, context) {
    const counts = this._getInventoryCounts(context)
    const missing = []

    for (const [matName, matCount] of Object.entries(step.materials || {})) {
      const available = counts[matName] || 0
      if (available < matCount) {
        missing.push({ item: matName, needed: matCount, available })
      }
    }

    return missing
  }

  _getInventoryCounts(context = {}) {
    const items = context.bot?.inventory?.items?.() || []
    const counts = {}
    for (const item of items) {
      counts[item.name] = (counts[item.name] || 0) + item.count
    }
    if (Object.keys(counts).length > 0) return counts

    const blackboardCounts = context.blackboard?.get?.('inventory.counts')
    if (blackboardCounts) return { ...blackboardCounts }
    return counts
  }

  _getStorageCounts(context = {}) {
    try {
      return context.memory?.world?.chestSummary?.() ||
        context.blackboard?.get?.('storage.counts') ||
        null
    } catch {
      return null
    }
  }

  _itemNameById(bot, itemId) {
    if (!bot?.registry?.itemsArray) return null
    const found = bot.registry.itemsArray.find(i => i.id === itemId)
    return found?.name || null
  }

  _recipeInputItems(recipe, bot) {
    if (!recipe) return []
    const fromIngredients = []
    for (const item of recipe.ingredients || []) {
      const id = item?.id ?? item
      const count = Math.abs(Number(item?.count ?? 1))
      if (id != null && count > 0) fromIngredients.push({ id, count })
    }
    if (fromIngredients.length) return mergeRecipeItems(fromIngredients)

    const shaped = []
    for (const row of recipe.inShape || []) {
      const cells = Array.isArray(row) ? row : [row]
      for (const item of cells) {
        if (!item) continue
        const id = item?.id ?? item
        const count = Math.abs(Number(item?.count ?? 1))
        if (id != null && count > 0) shaped.push({ id, count })
      }
    }
    if (shaped.length) return mergeRecipeItems(shaped)

    const delta = recipe.delta || []
    const negativeInputs = delta
      .filter(item => Number(item.count) < 0)
      .map(item => ({ id: item.id, count: Math.abs(Number(item.count)) }))
    if (negativeInputs.length) return mergeRecipeItems(negativeInputs)

    const resultId = recipe.result?.id
    const positiveInputs = delta
      .filter(item => item.id != null && Number(item.count) > 0 && item.id !== resultId)
      .map(item => ({ id: item.id, count: Number(item.count) }))
    if (positiveInputs.length) return mergeRecipeItems(positiveInputs)

    if (resultId == null && delta.length) {
      return mergeRecipeItems(delta
        .filter(item => item.id != null && Number(item.count) > 0)
        .map(item => ({ id: item.id, count: Number(item.count) })))
    }
    return []
  }

  getStorageDependencies(plan, context) {
    if (!plan || !plan.materials) return []
    const inventoryCounts = this._getInventoryCounts(context)
    const producedByPlan = new Set((plan.steps || []).map(step => step.item).filter(Boolean))
    const deps = []
    for (const [matName, matCount] of Object.entries(plan.materials)) {
      if (producedByPlan.has(matName)) continue
      const inInventory = inventoryCounts[matName] || 0
      if (inInventory >= matCount) continue
      const shortfall = matCount - inInventory
      if (shortfall > 0) {
        deps.push({ item: matName, neededFromStorage: shortfall, availableInInventory: inInventory })
      }
    }
    return deps
  }

  getCraftingStatus(context = {}, lastPlan = null) {
    const craftingTableNearby = Boolean(this._findNearbyCraftingTable(context))
    const hasTableInInventory = this._hasCraftingTable(context)

    return {
      targetItem: lastPlan?.targetItem || null,
      requestedCount: lastPlan?.requestedCount || null,
      craftMode: lastPlan?.craftMode || null,
      plannedCount: lastPlan?.plannedCount || lastPlan?.requestedCount || null,
      craftedCount: lastPlan?.craftedCount || 0,
      needsCraftingTable: lastPlan?.needsCraftingTable || false,
      hasCraftingTable: hasTableInInventory,
      usingNearbyCraftingTable: craftingTableNearby,
      recursivePlan: lastPlan?.steps?.map(s => ({
        step: s.step, item: s.item, count: s.count, needsCraftingTable: s.needsCraftingTable
      })) || null,
      missingMaterials: lastPlan?.missingMaterials || [],
      currentStep: lastPlan?.steps?.length ? lastPlan.steps[0].item : null,
      lastCraftError: null,
      sourceInventory: this._getInventoryCounts(context),
      sourceStorage: this._getStorageCounts(context)
    }
  }

  _fail(reason, extra = {}) {
    return { success: false, ok: false, reason, ...extra }
  }

  _log(context, message) {
    if (context?.logger?.log) context.logger.log(message)
    else context?.debug?.(message)
  }

  _planAbstractTool(toolType, requestedCount, craftMode, context) {
    const candidates = ABSTRACT_TOOL_TARGETS[toolType] || []
    const availableCandidates = candidates.filter(itemName => context.bot?.registry?.itemsByName?.[itemName])
    if (!availableCandidates.length) return this._fail('unknown_item', { itemName: toolType })

    const failedPlans = []
    for (const candidate of availableCandidates) {
      const plan = this.planRecipe(candidate, requestedCount, craftMode, context)
      if (plan.ok) {
        return {
          ...plan,
          abstractTarget: toolType,
          selectedFromAbstract: candidate
        }
      }
      failedPlans.push({ itemName: candidate, plan })
    }

    const selected = this._selectBestFailedToolPlan(toolType, failedPlans, context)
    return {
      ...selected.plan,
      abstractTarget: toolType,
      selectedFromAbstract: selected.itemName,
      targetItem: selected.plan.targetItem || selected.itemName
    }
  }

  _selectBestFailedToolPlan(toolType, failedPlans, context) {
    const counts = this._getInventoryCounts(context)
    const scored = failedPlans.map((entry, index) => ({
      ...entry,
      score: this._toolMaterialScore(toolType, entry.itemName, counts) * 100 - index
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored[0] || failedPlans[0]
  }

  _toolMaterialScore(toolType, itemName, counts) {
    const materialNeed = TOOL_MATERIAL_NEEDS[toolType] || 1
    if (itemName.startsWith('iron_')) return Math.min(counts.iron_ingot || 0, materialNeed)
    if (itemName.startsWith('stone_')) return Math.min(counts.cobblestone || 0, materialNeed)
    if (itemName.startsWith('wooden_')) {
      const plankCount = PLANK_TYPES.reduce((sum, name) => sum + (counts[name] || 0), 0)
      const logPlankPotential = Object.keys(LOG_TO_PLANK).reduce((sum, name) => sum + (counts[name] || 0) * 4, 0)
      return Math.min(plankCount + logPlankPotential, materialNeed)
    }
    return 0
  }
}

function mergeRecipeItems(items) {
  const byId = new Map()
  for (const item of items) {
    if (item.id == null) continue
    byId.set(item.id, (byId.get(item.id) || 0) + Math.abs(Number(item.count) || 0))
  }
  return [...byId.entries()]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, count }))
}

function availableCount(inventory = {}, storage = {}, itemName) {
  return (Number(inventory[itemName]) || 0) + (Number(storage[itemName]) || 0)
}

function consumeAvailable(inventory = {}, storage = {}, itemName, count) {
  let remaining = Math.max(0, Number(count) || 0)
  if (remaining <= 0 || !itemName) return 0

  const fromInventory = Math.min(Number(inventory[itemName]) || 0, remaining)
  if (fromInventory > 0) {
    inventory[itemName] = Math.max(0, (Number(inventory[itemName]) || 0) - fromInventory)
    remaining -= fromInventory
  }

  const fromStorage = Math.min(Number(storage[itemName]) || 0, remaining)
  if (fromStorage > 0) {
    storage[itemName] = Math.max(0, (Number(storage[itemName]) || 0) - fromStorage)
    remaining -= fromStorage
  }

  return count - remaining
}

function mergeMaterialCounts(target = {}, source = {}) {
  for (const [itemName, count] of Object.entries(source || {})) {
    target[itemName] = (Number(target[itemName]) || 0) + (Number(count) || 0)
  }
  return target
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function positionDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  const dz = Number(a.z) - Number(b.z)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

module.exports = { CraftingSystem, DEFAULT_RESERVED_ITEMS, DEFAULT_CRAFT_MULTIPLIERS }
