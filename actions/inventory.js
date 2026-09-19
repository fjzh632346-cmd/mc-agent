const {
  acquireActionLocks,
  fail,
  ok,
  releaseActionLocks
} = require('./action-utils')
const { getChineseItemName } = require('../utils/item-names')

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'apple', 'golden_apple',
  'carrot', 'baked_potato', 'pumpkin_pie', 'melon_slice'
])

const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword']
const WEAPON_SUFFIXES = ['_sword', '_axe', 'bow', 'crossbow', 'trident']
const ARMOR_SUFFIXES = ['_helmet', '_chestplate', '_leggings', '_boots']
const BLOCK_HINTS = ['_log', '_planks', 'stone', 'dirt', 'sand', 'cobblestone', 'deepslate', 'block']
const LOG_HINTS = ['_log', '_stem']
const PLANK_HINTS = ['_planks']
const ORE_HINTS = ['_ore', 'raw_iron', 'raw_gold', 'raw_copper']
const MATERIAL_HINTS = ['ingot', 'coal', 'charcoal', 'stick', 'string', 'bone', 'gunpowder', 'sand']

function getInventorySummary(context, options = {}) {
  const locked = acquireActionLocks(context, ['inventory'], 'getInventorySummary', options)
  if (!locked.ok) return fail(locked.error, locked)

  try {
    const bot = context?.bot
    if (!bot?.inventory?.items) return fail('missing_inventory')

    const items = bot.inventory.items()
    const counts = {}
    for (const item of items) counts[item.name] = (counts[item.name] || 0) + item.count
    const itemList = Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => {
        const displayName = displayNameForItem(name)
        return { name, displayName, displayNameZh: displayName, count }
      })

    const emptySlots = getEmptySlotCountValue(bot, items)
    const usedSlots = Math.max(0, 36 - emptySlots)
    const foodCount = items
      .filter(item => FOOD_ITEMS.has(item.name))
      .reduce((sum, item) => sum + item.count, 0)
    const toolCount = items
      .filter(item => TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix)))
      .reduce((sum, item) => sum + item.count, 0)

    return ok('inventory_summary', {
      nearFull: emptySlots <= 3,
      emptySlots,
      usedSlots,
      heldItem: bot.heldItem ? {
        name: bot.heldItem.name,
        displayName: displayNameForItem(bot.heldItem.name),
        displayNameZh: displayNameForItem(bot.heldItem.name),
        count: bot.heldItem.count
      } : null,
      foodCount,
      toolCount,
      counts,
      items: itemList,
      tools: itemList.filter(item => TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix))),
      weapons: itemList.filter(item => WEAPON_SUFFIXES.some(suffix => item.name.endsWith(suffix) || item.name === suffix)),
      armor: itemList.filter(item => ARMOR_SUFFIXES.some(suffix => item.name.endsWith(suffix))),
      food: itemList.filter(item => FOOD_ITEMS.has(item.name)),
      blocks: itemList.filter(item => BLOCK_HINTS.some(hint => item.name.includes(hint))),
      categories: buildCategories(itemList)
    })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, locked.owner)
  }
}

function buildCategories(itemList) {
  return {
    food: itemList.filter(item => FOOD_ITEMS.has(item.name)),
    tools: itemList.filter(item => TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix))),
    weapons: itemList.filter(item => WEAPON_SUFFIXES.some(suffix => item.name.endsWith(suffix) || item.name === suffix)),
    armor: itemList.filter(item => ARMOR_SUFFIXES.some(suffix => item.name.endsWith(suffix))),
    wood: itemList.filter(item => LOG_HINTS.some(hint => item.name.includes(hint)) || PLANK_HINTS.some(hint => item.name.includes(hint)) || item.name.includes('_wood')),
    logs: itemList.filter(item => LOG_HINTS.some(hint => item.name.includes(hint)) || item.name.includes('_wood')),
    planks: itemList.filter(item => PLANK_HINTS.some(hint => item.name.includes(hint))),
    ores: itemList.filter(item => ORE_HINTS.some(hint => item.name.includes(hint))),
    materials: itemList.filter(item => MATERIAL_HINTS.some(hint => item.name.includes(hint)))
  }
}

function countItem(context, itemName) {
  if (!itemName) return fail('missing_item_name')
  const summary = getInventorySummary(context)
  if (!summary.ok) return summary
  return ok('item_counted', { itemName, count: summary.data.counts[itemName] || 0 })
}

function hasItem(context, itemName, count = 1) {
  if (!itemName) return fail('missing_item_name')
  const counted = countItem(context, itemName)
  if (!counted.ok) return counted
  return ok('item_checked', {
    itemName,
    required: count,
    count: counted.data.count,
    hasItem: counted.data.count >= count
  })
}

function getEmptySlotCount(context) {
  const summary = getInventorySummary(context)
  if (!summary.ok) return summary
  return ok('empty_slots_counted', { emptySlots: summary.data.emptySlots })
}

function isInventoryFull(context) {
  const summary = getInventorySummary(context)
  if (!summary.ok) return summary
  return ok('inventory_full_checked', { full: summary.data.emptySlots === 0, nearFull: summary.data.nearFull })
}

async function equipItem(context, itemName, destination = 'hand', options = {}) {
  if (!itemName) return fail('missing_item_name')

  const locked = acquireActionLocks(context, ['inventory'], 'equipItem', options)
  if (!locked.ok) return fail(locked.error, locked)

  try {
    const bot = context?.bot
    if (!bot?.inventory?.items || typeof bot.equip !== 'function') return fail('missing_inventory')

    const item = bot.inventory.items().find(candidate => candidate.name === itemName)
    if (!item) return fail('item_not_found')

    await bot.equip(item, destination)
    return ok('item_equipped', { itemName, destination })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, locked.owner)
  }
}

async function eatFood(context, options = {}) {
  const locked = acquireActionLocks(context, ['inventory'], 'eatFood', options)
  if (!locked.ok) return fail(locked.error, locked)

  try {
    const bot = context?.bot
    if (!bot?.inventory?.items || typeof bot.equip !== 'function' || typeof bot.consume !== 'function') {
      return fail('missing_eat_support')
    }

    const food = options.itemName
      ? bot.inventory.items().find(item => item.name === options.itemName && FOOD_ITEMS.has(item.name))
      : bot.inventory.items().find(item => FOOD_ITEMS.has(item.name))
    if (!food) return fail('food_not_found')

    console.log(`[EAT_ATTEMPT] item=${food.name}`)
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    await bot.equip(food, 'hand')
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    await bot.consume()
    console.log(`[EAT_SUCCESS] item=${food.name}`)
    return ok('food_eaten', { itemName: food.name })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, locked.owner)
  }
}

function getEmptySlotCountValue(bot, items) {
  const slots = bot.inventory?.slots || []
  if (slots.length > 0) return slots.slice(9, 45).filter(slot => !slot).length
  return Math.max(0, 36 - items.length)
}

function displayNameForItem(name) {
  return getChineseItemName(name)
}

module.exports = {
  countItem,
  displayNameForItem,
  eatFood,
  equipItem,
  getEmptySlotCount,
  getInventorySummary,
  hasItem,
  isInventoryFull
}
