const {
  acquireActionLocks,
  fail,
  ok,
  releaseActionLocks
} = require('./action-utils')

const CRAFTING_TABLE_REACH = 4

function canCraft(context, itemName, count = 1, options = {}) {
  const bot = context?.bot
  if (!bot?.registry?.itemsByName) return fail('missing_item_registry')
  if (!itemName) return fail('missing_item_name')

  const lock = acquireActionLocks(context, ['crafting'], 'canCraft', options)
  if (!lock.ok) return fail(lock.error, lock)

  const item = bot.registry.itemsByName[itemName]
  if (!item) {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
    return fail('unknown_item')
  }
  if (typeof bot.recipesFor !== 'function') {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
    return fail('missing_recipesFor')
  }

  try {
    // options.craftingTable === null is an EXPLICIT "no table" request and
    // must not fall through to auto-discovery (live failure: procurement
    // passed null, canCraft re-bound an unreachable base table 30 blocks
    // away and bot.craft died on windowOpen timeout).
    const craftingTable = options.craftingTable !== undefined
      ? options.craftingTable
      : findNearbyCraftingTable(bot, options.maxDistance || 32)
    const selected = selectCraftingRecipe(bot, item.id, count, craftingTable)
    if (!selected) return ok('craft_check', { canCraft: false, reason: 'recipe_not_found', itemName, count })
    return ok('craft_check', { canCraft: true, itemName, count, recipe: selected.recipe, craftingTable: selected.craftingTable })
  } catch (err) {
    return fail(err.message)
  } finally {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
  }
}

async function craftItem(context, itemName, count = 1, options = {}) {
  if (!itemName) return fail('missing_item_name')

  const lock = acquireActionLocks(context, ['crafting'], 'craftItem', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    const bot = context?.bot
    if (!bot?.registry?.itemsByName) return fail('missing_item_registry')
    if (typeof bot.craft !== 'function') return fail('missing_craft')

    const craftingTable = options.craftingTable !== undefined
      ? options.craftingTable
      : findNearbyCraftingTable(bot, options.maxDistance || 32)
    const check = canCraft(context, itemName, count, { owner: lock.owner, holdLock: true, craftingTable })
    if (!check.ok) return check
    if (!check.data.canCraft) return fail(check.data.reason)

    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    // A table recipe opens the REAL table window: walk into interaction
    // range first (live failure: bot.craft against a table 30 blocks away
    // never opens the window -> windowOpen timeout after 20s).
    const table = check.data.craftingTable
    if (table?.position && bot.entity?.position &&
        bot.entity.position.distanceTo(table.position) > CRAFTING_TABLE_REACH) {
      const { moveTo } = require('./move')
      const moved = await moveTo(context, table.position, {
        owner: lock.owner,
        range: 2,
        timeoutMs: options.tableMoveTimeoutMs ?? 20000,
        canDig: false,
        holdLock: true
      })
      if (!moved.ok) return fail(`crafting_table_unreachable:${moved.error || 'move_failed'}`)
    }
    await bot.craft(check.data.recipe, count, table || null)
    return ok('item_crafted', { itemName, count })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, lock.owner)
  }
}

function findRecipe(bot, itemId, count, craftingTable = null) {
  const recipes = bot.recipesFor(itemId, null, count, craftingTable) || []
  return recipes[0] || null
}

// Prefer a tableless (2x2 player-grid) recipe when one is craftable: it needs
// no window at all, so distance/reachability cannot fail the craft. Fall back
// to the table recipe only when the item genuinely needs the 3x3 grid.
function selectCraftingRecipe(bot, itemId, count, craftingTable) {
  const tableless = findRecipe(bot, itemId, count, null)
  if (tableless) return { recipe: tableless, craftingTable: null }
  if (craftingTable) {
    const withTable = findRecipe(bot, itemId, count, craftingTable)
    if (withTable) return { recipe: withTable, craftingTable }
  }
  return null
}

function findNearbyCraftingTable(bot, maxDistance) {
  const tableId = bot.registry?.blocksByName?.crafting_table?.id
  if (tableId == null || typeof bot.findBlock !== 'function') return null
  return bot.findBlock({ matching: tableId, maxDistance }) || null
}

module.exports = {
  canCraft,
  craftItem,
  findNearbyCraftingTable
}
