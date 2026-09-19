const { moveTo } = require('./move')
const { checkProtectedBuildingDig } = require('../systems/protected-buildings')
const { confirmPickupForBlockDrop, inventoryCounts, resolveBlockDropItemNames } = require('./pickup')
const { toBlockVec3 } = require('../utils/position')
const {
  acquireActionLocks,
  distance,
  fail,
  ok,
  releaseActionLocks
} = require('./action-utils')
const { nearestHostile } = require('../perception/world-state')

const ORE_BLOCKS = {
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore']
}

const PROTECTED_BLOCKS = new Set([
  'crafting_table',
  'chest',
  'trapped_chest',
  'furnace',
  'blast_furnace',
  'smoker',
  'bed',
  'white_bed',
  'orange_bed',
  'magenta_bed',
  'light_blue_bed',
  'yellow_bed',
  'lime_bed',
  'pink_bed',
  'gray_bed',
  'light_gray_bed',
  'cyan_bed',
  'purple_bed',
  'blue_bed',
  'brown_bed',
  'green_bed',
  'red_bed',
  'black_bed',
  'farmland',
  'barrel',
  'hopper',
  'anvil',
  'chipped_anvil',
  'damaged_anvil'
])

function findNearbyBlocks(context, blockNames, maxDistance = 16, count = null) {
  const bot = context?.bot
  const names = normalizeNames(blockNames)
  if (!bot?.findBlock) return fail('missing_bot_findBlock')
  if (!bot.registry?.blocksByName) return fail('missing_block_registry')
  if (!names.length) return fail('missing_block_names')

  const ids = names
    .map(name => bot.registry.blocksByName[name])
    .filter(Boolean)
    .map(block => block.id)

  if (!ids.length) return fail('unknown_block_names', { names })

  try {
    const blocks = bot.findBlocks
      ? bot.findBlocks({ matching: ids, maxDistance, count: count || context.count || 16 })
      .map(pos => bot.blockAt(toBlockVec3(pos)))
        .filter(Boolean)
      : [bot.findBlock({ matching: ids, maxDistance })].filter(Boolean)

    const filtered = blocks.filter(block => !isProtectedBlock(context, block))
    return ok('blocks_found', { blocks: filtered, protectedSkipped: blocks.length - filtered.length })
  } catch (err) {
    return fail(err.message)
  }
}

async function mineBlock(context, block, options = {}) {
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')
  if (!block?.position || block.name === 'air') return fail('missing_block')
  if (!canContinue(options)) return fail('task_interrupted')

  const lock = acquireActionLocks(context, ['movement', 'digging'], 'mineBlock', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    if (!canContinue(options)) return fail('task_interrupted')
    const hostile = nearestHostile(bot, options.dangerRadius ?? 8)
    if (hostile && options.ignoreDanger !== true) {
      return fail(`danger:${hostile.name}`)
    }

    const digDistance = options.digDistance ?? 4.5
    if (distance(bot.entity.position, block.position) > digDistance) {
      const moved = await moveTo(context, block.position, {
        owner: lock.owner,
        range: options.moveRange ?? 1,
        timeoutMs: options.timeoutMs ?? 15000,
        shouldContinue: options.shouldContinue,
        holdLock: true
      })
      if (!moved.ok) return moved
    }

    if (!canContinue(options)) return fail('task_interrupted')
    let fresh = bot.blockAt?.(toBlockVec3(block.position)) || block
    if (!fresh || fresh.name === 'air') return fail('block_gone')
    if (isProtectedBlock(context, fresh)) {
      context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || fresh.name} resolvedTarget=${options.targetBlock || fresh.name} selectedBlock=${fresh.name} protected=true result=protected_block`)
      return fail(`protected_block:${fresh.name}`)
    }
    const buildingGuard = checkProtectedBuildingDig(context, fresh.position, {
      source: options.owner || 'mine.mineBlock',
      exemptRunId: options.protectionExemptRunId
    })
    if (!buildingGuard.allowed) {
      return fail(`protected_building_dig_blocked:${buildingGuard.region.runId}`)
    }
    context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || fresh.name} resolvedTarget=${options.targetBlock || fresh.name} selectedBlock=${fresh.name} protected=false result=selected`)

    let toolSelection = null
    let prepResult = null
    if (options.autoPrepareTool !== false && context.autoPreparationSystem && typeof context.autoPreparationSystem.ensureToolForBlock === 'function') {
      prepResult = await context.autoPreparationSystem.ensureToolForBlock(context, fresh.name, {
        allowStorage: options.allowStorageAutoPreparation === true,
        owner: options.owner || options.taskId || 'mineBlock',
        taskId: options.taskId
      })
      if (!prepResult.ok) {
        const missing = formatMissingMaterials(prepResult.missingMaterials)
        const reason = normalizeAutoPreparationFailure(prepResult, missing)
        context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || fresh.name} resolvedTarget=${options.targetBlock || fresh.name} selectedBlock=${fresh.name} requiredTool=${prepResult.selection?.requiredTool || 'unknown'} selectedTool=none allowHand=false minedCount=0 errorSource=auto_preparation result=${reason}`)
        return fail(reason)
      }
      toolSelection = prepResult.selection || {
        success: true,
        itemName: prepResult.itemName,
        preferredTool: prepResult.preferredTool,
        requiredTool: prepResult.requiredTool,
        allowHand: prepResult.allowHand === true,
        reason: prepResult.reason
      }
    }

    const equipmentSystem = context.equipmentSystem || context.autoPreparationSystem?.equipmentSystem
    if (equipmentSystem && typeof equipmentSystem.equipBestToolForBlock === 'function') {
      const equipResult = await equipmentSystem.equipBestToolForBlock(fresh.name, context)
      toolSelection = equipResult
      context.logger?.log?.(`[equipment] block=${fresh.name} preferredTool=${equipResult.preferredTool || options.preferredTool || 'none'} requiredTool=${equipResult.requiredTool || options.requiredTool || 'none'} selectedTool=${equipResult.itemName || 'none'} allowHand=${equipResult.allowHand === true} reason=${equipResult.reason || 'unknown'} error=${equipResult.success ? 'none' : equipResult.reason}`)
      if (!equipResult.success && equipResult.reason === 'missing_required_tool') {
        context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || fresh.name} resolvedTarget=${options.targetBlock || fresh.name} selectedBlock=${fresh.name} requiredTool=${equipResult.requiredTool || 'unknown'} selectedTool=none allowHand=false minedCount=0 errorSource=equipment result=missing_required_tool`)
        return fail(`missing_required_tool:${equipResult.requiredTool || 'unknown'}`)
      }
    }

    if (!canContinue(options)) return fail('task_interrupted')
    const canDigByBot = typeof bot.canDigBlock !== 'function' || bot.canDigBlock(fresh)
    const toolSelectionAllowsDig = toolSelection?.success === true && fresh.diggable !== false
    if (!canDigByBot && !toolSelectionAllowsDig) {
      const held = bot.heldItem?.name || bot.inventory?.slots?.find?.(item => item?.name)?.name || 'unknown'
      context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || fresh.name} resolvedTarget=${options.targetBlock || fresh.name} selectedBlock=${fresh.name} requiredTool=${toolSelection?.requiredTool || options.requiredTool || 'unknown'} selectedTool=${held} allowHand=${toolSelection?.allowHand === true} minedCount=0 errorSource=equipment result=wrong_tool_type`)
      return fail('wrong_tool_type')
    }
    if (typeof bot.dig !== 'function') return fail('missing_dig')

    const selectedTool = toolSelection?.itemName === 'hand' ? 'hand' : (bot.heldItem?.name || toolSelection?.itemName || 'unknown')
    const targetPosition = fresh.position
    const targetBlockName = fresh.name
    const expectedDrops = resolveBlockDropItemNames(context, targetBlockName, options)
    const inventoryBeforeDig = inventoryCounts(context)
    context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || targetBlockName} resolvedTarget=${options.targetBlock || targetBlockName} selectedBlock=${targetBlockName} targetPos=${formatPos(targetPosition)} expectedDropId=${expectedDrops[0] || targetBlockName} action=dig result=start`)
    await bot.dig(fresh)

    const pickupResult = await confirmPickupForBlockDrop(context, targetBlockName, targetPosition, {
      owner: lock.owner,
      holdLock: true,
      shouldContinue: options.shouldContinue,
      minedCountBefore: options.minedCountBefore ?? 0,
      pickupTimeoutMs: options.pickupTimeoutMs,
      pickupPollIntervalMs: options.pickupPollIntervalMs,
      dropSearchRadius: options.dropSearchRadius,
      moveTimeoutMs: options.pickupMoveTimeoutMs || options.timeoutMs,
      inventoryBeforeCounts: inventoryBeforeDig
    })
    if (!pickupResult.ok) {
      context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || targetBlockName} resolvedTarget=${options.targetBlock || targetBlockName} selectedBlock=${targetBlockName} targetPos=${formatPos(targetPosition)} expectedDropId=${expectedDrops[0] || targetBlockName} selectedTool=${selectedTool} minedCountBefore=${options.minedCountBefore ?? 0} minedCountAfter=${options.minedCountBefore ?? 0} errorSource=pickup result=pickup_failed reason=${pickupResult.error}`)
      return fail(`pickup_failed:${pickupResult.error}`, { data: pickupResult })
    }

    context.logger?.log?.(`[mining] inputTarget=${options.inputTarget || options.targetBlock || fresh.name} resolvedTarget=${options.targetBlock || fresh.name} selectedBlock=${fresh.name} requiredTool=${toolSelection?.requiredTool || options.requiredTool || 'none'} selectedTool=${selectedTool} allowHand=${toolSelection?.allowHand === true} minedCount=1 errorSource=none result=ok`)
    if (fresh.name.includes('_log') || fresh.name.includes('_wood') || fresh.name.includes('_stem')) {
      context.logger?.log?.(`[tree] targetLog=${fresh.name} selectedTool=${selectedTool} allowHand=${toolSelection?.allowHand === true} result=ok`)
    }
    return ok('block_mined', {
      block: fresh.name,
      position: fresh.position,
      selectedTool,
      allowHand: toolSelection?.allowHand === true,
      requiredTool: toolSelection?.requiredTool || null,
      preferredTool: toolSelection?.preferredTool || options.preferredTool || null,
      pickup: pickupResult.data
    })
  } catch (err) {
    return fail(err.message)
  } finally {
    releaseActionLocks(context, lock.owner)
  }
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

async function mineNearestBlock(context, blockNames, options = {}) {
  if (!canContinue(options)) return fail('task_interrupted')
  const found = findNearbyBlocks(context, blockNames, options.maxDistance ?? 16, options.scanCount)
  if (!found.ok) return found

  const block = found.data.blocks[0]
  if (!block) return fail(found.data.protectedSkipped > 0 ? 'nearby_target_block_protected' : 'block_not_found')
  return mineBlock(context, block, options)
}

function findNearestOre(bot, ore = 'iron', maxDistance = 64) {
  const names = ORE_BLOCKS[ore] || ORE_BLOCKS.iron
  const ids = names
    .map(name => bot.registry.blocksByName[name])
    .filter(Boolean)
    .map(block => block.id)

  if (ids.length === 0) return null
  return bot.findBlock({ matching: ids, maxDistance })
}

function formatMissingMaterials(missingMaterials = []) {
  if (!Array.isArray(missingMaterials) || missingMaterials.length === 0) return ''
  return missingMaterials
    .map(item => `${item.itemName || item.item || item.name || 'unknown'}=${item.missing ?? item.needed ?? item.count ?? 'unknown'}`)
    .join(',')
}

function normalizeAutoPreparationFailure(prepResult = {}, missing = '') {
  const rawReason = prepResult.reason || 'unknown'
  const requiredTool = prepResult.selection?.requiredTool || prepResult.requiredTool || null
  if (String(rawReason).startsWith('unsupported_min_tier') && requiredTool) {
    return `missing_required_tool:${requiredTool}`
  }
  return `auto_preparation_failed:${rawReason}${missing ? `:${missing}` : ''}`
}

async function digBlock(bot, block, context = {}) {
  const result = await mineBlock({ ...context, bot }, block, context)
  if (result.ok) return { ok: true, ...result.data }
  return { ok: false, reason: result.error, error: result.error }
}

async function mineOre(bot, { ore = 'iron', count = 3 } = {}, context = {}) {
  const mined = []
  const names = ORE_BLOCKS[ore] || ORE_BLOCKS.iron

  for (let i = 0; i < count; i++) {
    const result = await mineNearestBlock({ ...context, bot }, names, {
      maxDistance: 64,
      ...context
    })
    if (!result.ok) return { ok: mined.length > 0, mined, reason: result.error, error: result.error }
    mined.push(result.data)
    context.debug?.(`[Action:mine] mined ${result.data.block} at ${result.data.position}`)
  }

  return { ok: mined.length > 0, mined, ore }
}

function normalizeNames(blockNames) {
  if (!blockNames) return []
  if (Array.isArray(blockNames)) return blockNames.filter(Boolean)
  return [blockNames]
}

function canContinue(options = {}) {
  return typeof options.shouldContinue !== 'function' || options.shouldContinue() !== false
}

function isProtectedBlock(context, block) {
  if (!block?.name) return false
  if (PROTECTED_BLOCKS.has(block.name)) return true
  const builtStructures = context?.memory?.world?.list?.().builtStructures || []
  return builtStructures.some(record => positionMatches(record?.origin || record?.position, block.position))
}

function positionMatches(a, b) {
  if (!a || !b) return false
  return Math.floor(a.x) === Math.floor(b.x) &&
    Math.floor(a.y) === Math.floor(b.y) &&
    Math.floor(a.z) === Math.floor(b.z)
}

module.exports = {
  ORE_BLOCKS,
  digBlock,
  findNearbyBlocks,
  findNearestOre,
  mineBlock,
  mineNearestBlock,
  mineOre,
  PROTECTED_BLOCKS
}
