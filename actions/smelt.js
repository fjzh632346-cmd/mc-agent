const {
  acquireActionLocks,
  fail,
  ok,
  releaseActionLocks
} = require('./action-utils')

const SMELT_INPUTS = {
  raw_iron: 'iron_ingot',
  iron_ore: 'iron_ingot',
  sand: 'glass',
  red_sand: 'glass'
}

const FUEL_ITEMS = new Set(['coal', 'charcoal'])

async function smeltItem(context, inputName, count = 1, options = {}) {
  const lock = acquireActionLocks(context, ['inventory', 'crafting'], 'smeltItem', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    const bot = context?.bot
    if (!bot?.inventory?.items) return fail('missing_inventory')
    if (!SMELT_INPUTS[inputName]) return fail('unsupported_smelt_input')

    const input = findInventoryItem(bot, [inputName])
    if (!input || input.count < count) return fail(`smelt_input_not_found:${inputName}`)

    const fuel = findInventoryItem(bot, [...FUEL_ITEMS])
    if (!fuel) return fail('fuel_not_found:coal_or_charcoal')

    const furnaceBlock = findNearbyFurnace(bot, options.maxDistance || 32)
    if (!furnaceBlock) return fail('furnace_not_found')
    if (typeof bot.openFurnace !== 'function') return fail('missing_open_furnace')

    const furnace = await bot.openFurnace(furnaceBlock)
    try {
      await furnace.putFuel(fuel.type ?? fuel, null, 1)
      await furnace.putInput(input.type ?? input, null, count)
      const output = await furnace.takeOutput()
      return ok('item_smelted', {
        inputName,
        outputName: SMELT_INPUTS[inputName],
        count,
        furnacePosition: furnaceBlock.position,
        outputNameActual: output?.name || null
      })
    } finally {
      furnace.close?.()
    }
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, lock.owner)
  }
}

function findInventoryItem(bot, names) {
  return (bot.inventory.items() || []).find(item => names.includes(item.name)) || null
}

function findNearbyFurnace(bot, maxDistance) {
  const furnaceId = bot.registry?.blocksByName?.furnace?.id
  if (furnaceId == null || typeof bot.findBlock !== 'function') return null
  return bot.findBlock({ matching: furnaceId, maxDistance }) || null
}

module.exports = {
  FUEL_ITEMS,
  SMELT_INPUTS,
  smeltItem
}
