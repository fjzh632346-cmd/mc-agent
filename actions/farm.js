const { moveTo } = require('./move')
const { checkProtectedBuildingDig } = require('../systems/protected-buildings')
const { craftItem } = require('./craft')
const { eatFood: eatInventoryFood } = require('./inventory')
const { toBlockVec3 } = require('../utils/position')
const {
  acquireActionLocks,
  distance,
  fail,
  normalizePosition,
  ok,
  releaseActionLocks
} = require('./action-utils')

const CROP_BLOCKS = ['wheat']
const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'apple', 'golden_apple',
  'carrot', 'baked_potato', 'pumpkin_pie', 'melon_slice'
])
const SEED_ITEMS = new Set(['wheat_seeds'])

function findNearbyCrops(context, maxDistance = 16) {
  return findMatureWheat(context, { radius: maxDistance }, { includeUnripe: true })
}

function findNearbyFarmland(context, radius = 16) {
  const bot = context?.bot
  if (!bot?.registry?.blocksByName) return fail('missing_block_registry')
  if (typeof bot.findBlocks !== 'function' && typeof bot.findBlock !== 'function') return fail('missing_findBlock')

  const farmlandId = bot.registry.blocksByName.farmland?.id
  if (farmlandId == null) return fail('missing_farmland_block_id')

  try {
    let positions = []
    if (typeof bot.findBlocks === 'function') {
      positions = bot.findBlocks({ matching: farmlandId, maxDistance: radius, count: 128 }) || []
    } else {
      const block = bot.findBlock({ matching: farmlandId, maxDistance: radius })
      if (block?.position) positions = [block.position]
    }

    const blocks = positions
      .map(position => bot.blockAt?.(toBlockVec3(position)) || { name: 'farmland', position })
      .filter(block => block?.position && block.name === 'farmland')
      .sort((a, b) => distance(bot.entity?.position, a.position) - distance(bot.entity?.position, b.position))

    return ok('farmland_found', { farmland: blocks })
  } catch (err) {
    return fail(err.message)
  }
}

function findMatureWheat(context, farmArea = {}, options = {}) {
  const found = findWheatBlocks(context, farmArea, options)
  if (!found.ok) return found
  return ok('mature_wheat_found', {
    crops: found.data.crops.filter(item => item.mature),
    allCrops: found.data.crops
  })
}

function findEmptyFarmland(context, farmArea = {}) {
  const farmland = findFarmlandInArea(context, farmArea)
  if (!farmland.ok) return farmland

  const empty = farmland.data.farmland.filter(block => {
    const above = context.bot?.blockAt?.(toBlockVec3({
      x: block.position.x,
      y: block.position.y + 1,
      z: block.position.z
    }))
    return !above || above.name === 'air'
  })

  return ok('empty_farmland_found', { farmland: empty })
}

async function harvestCrop(context, cropOrPosition, options = {}) {
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')

  const cropBlock = cropOrPosition?.position && cropOrPosition?.name
    ? cropOrPosition
    : bot.blockAt?.(toBlockVec3(normalizePosition(cropOrPosition)))

  if (!cropBlock?.position) return fail('missing_crop_block')
  if (!CROP_BLOCKS.includes(cropBlock.name)) return fail('not_wheat_block')
  if (!isMatureCrop(cropBlock) && options.harvestUnripe !== true) return fail('wheat_not_mature')
  if (typeof bot.dig !== 'function') return fail('missing_dig')

  const lock = acquireActionLocks(context, ['movement', 'digging'], 'harvestCrop', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    if (distance(bot.entity.position, cropBlock.position) > (options.harvestDistance ?? 4.5)) {
      const moved = await moveTo(context, cropBlock.position, {
        owner: lock.owner,
        range: 1,
        timeoutMs: options.timeoutMs ?? 15000,
        holdLock: true,
        shouldContinue: options.shouldContinue
      })
      if (!moved.ok) return moved
    }

    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    {
      const buildingGuard = checkProtectedBuildingDig(context, cropBlock.position, { source: options.owner || 'farm.harvestCrop' })
      if (!buildingGuard.allowed) return fail(`protected_building_dig_blocked:${buildingGuard.region.runId}`)
    }
    await bot.dig(cropBlock)
    await sleep(options.pickupDelayMs ?? 250)
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    return ok('crop_harvested', { crop: cropBlock.name, position: cropBlock.position })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, lock.owner)
  }
}

async function plantSeed(context, position, seedName = 'wheat_seeds', options = {}) {
  const bot = context?.bot
  const target = normalizePosition(position)
  if (!bot?.entity) return fail('missing_bot')
  if (!target) return fail('missing_position')
  if (seedName !== 'wheat_seeds') return fail('unsupported_seed')
  if (typeof bot.placeBlock !== 'function') return fail('missing_placeBlock')

  const lock = acquireActionLocks(context, ['movement', 'inventory'], 'plantSeed', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    const seed = bot.inventory?.items?.().find(item => item.name === seedName)
    if (!seed) return fail('missingSeeds')

    const soil = bot.blockAt?.(toBlockVec3({ x: target.x, y: target.y - 1, z: target.z }))
    if (!soil || soil.name !== 'farmland') return fail('not_farmland')

    const current = bot.blockAt?.(toBlockVec3(target))
    if (current && current.name !== 'air') return fail('target_not_empty')

    if (distance(bot.entity.position, target) > (options.placeDistance ?? 4.5)) {
      const moved = await moveTo(context, target, {
        owner: lock.owner,
        range: 2,
        timeoutMs: options.timeoutMs ?? 15000,
        holdLock: true,
        shouldContinue: options.shouldContinue
      })
      if (!moved.ok) return moved
    }

    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    if (typeof bot.equip === 'function') await bot.equip(seed, 'hand')
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return fail('task_interrupted')
    await bot.placeBlock(soil, { x: 0, y: 1, z: 0 })
    return ok('seed_planted', { seedName, position: target })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, lock.owner)
  }
}

function moveNearFarmPosition(context, position, options = {}) {
  const target = normalizePosition(position)
  if (!target) return Promise.resolve(fail('missing_position'))
  return moveTo(context, target, {
    owner: options.owner,
    range: options.range ?? 3,
    timeoutMs: options.timeoutMs ?? 15000,
    holdLock: options.holdLock,
    shouldContinue: options.shouldContinue
  })
}

async function craftBread(context, count = 1, options = {}) {
  return craftItem(context, 'bread', count, options)
}

async function eatFood(context, foodName = null, options = {}) {
  return eatInventoryFood(context, { ...options, itemName: foodName || options.itemName })
}

function getFoodSummary(context) {
  const counts = getCounts(context)
  const foods = {}
  for (const [itemName, count] of Object.entries(counts)) {
    if (FOOD_ITEMS.has(itemName)) foods[itemName] = count
  }
  return ok('food_summary', {
    foods,
    total: Object.values(foods).reduce((sum, count) => sum + count, 0),
    breadCount: foods.bread || 0
  })
}

function getSeedSummary(context) {
  const counts = getCounts(context)
  const seeds = {}
  for (const [itemName, count] of Object.entries(counts)) {
    if (SEED_ITEMS.has(itemName)) seeds[itemName] = count
  }
  return ok('seed_summary', {
    seeds,
    total: Object.values(seeds).reduce((sum, count) => sum + count, 0),
    wheatSeedCount: seeds.wheat_seeds || 0
  })
}

function findWheatBlocks(context, farmArea = {}, options = {}) {
  const bot = context?.bot
  if (!bot?.registry?.blocksByName) return fail('missing_block_registry')
  if (typeof bot.findBlocks !== 'function' && typeof bot.findBlock !== 'function') return fail('missing_findBlock')

  const wheatId = bot.registry.blocksByName.wheat?.id
  if (wheatId == null) return fail('missing_wheat_block_id')

  try {
    const radius = farmArea.radius || options.radius || 16
    let positions = []
    if (typeof bot.findBlocks === 'function') {
      positions = bot.findBlocks({ matching: wheatId, maxDistance: radius, count: options.count || 128 }) || []
    } else {
      const block = bot.findBlock({ matching: wheatId, maxDistance: radius })
      if (block?.position) positions = [block.position]
    }

    const center = farmArea.position || farmArea.origin || null
    const crops = positions
      .map(position => bot.blockAt?.(toBlockVec3(position)) || { name: 'wheat', position })
      .filter(block => block?.position && block.name === 'wheat')
      .filter(block => !center || distance(center, block.position) <= radius)
      .map(block => ({ block, mature: isMatureCrop(block), position: block.position }))
      .sort((a, b) => distance(bot.entity?.position, a.position) - distance(bot.entity?.position, b.position))

    return ok('wheat_found', { crops })
  } catch (err) {
    return fail(err.message)
  }
}

function findFarmlandInArea(context, farmArea = {}) {
  const bot = context?.bot
  const radius = farmArea.radius || 16
  const center = farmArea.position || farmArea.origin || null
  const found = findNearbyFarmland(context, radius)
  if (!found.ok) return found
  const farmland = center
    ? found.data.farmland.filter(block => distance(center, block.position) <= radius)
    : found.data.farmland
  return ok('farmland_found', { farmland })
}

function isMatureCrop(block) {
  const age = getCropAge(block)
  if (age == null) return false
  return block?.name === 'wheat' && Number(age) >= 7
}

function getCropAge(block) {
  return block?.metadata ?? block?.properties?.age
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getCounts(context) {
  const blackboardCounts = context?.blackboard?.get?.('inventory.counts')
  if (blackboardCounts) return { ...blackboardCounts }
  const counts = {}
  for (const item of context?.bot?.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return counts
}

module.exports = {
  CROP_BLOCKS,
  findNearbyCrops,
  findNearbyFarmland,
  findMatureWheat,
  findEmptyFarmland,
  harvestCrop,
  plantSeed,
  moveNearFarmPosition,
  craftBread,
  eatFood,
  getFoodSummary,
  getSeedSummary,
  getCropAge,
  isMatureCrop
}
