const { moveTo } = require('./move')
const { distance, fail, ok, sleep } = require('./action-utils')

const FALLBACK_BLOCK_DROPS = {
  iron_ore: ['raw_iron'],
  deepslate_iron_ore: ['raw_iron'],
  gold_ore: ['raw_gold'],
  deepslate_gold_ore: ['raw_gold'],
  copper_ore: ['raw_copper'],
  deepslate_copper_ore: ['raw_copper'],
  coal_ore: ['coal'],
  deepslate_coal_ore: ['coal'],
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  stone: ['cobblestone'],
  deepslate: ['cobbled_deepslate'],
  grass_block: ['dirt']
}

function findNearestDroppedItem(context = {}, radius = 16) {
  const bot = context.bot
  if (!bot?.entity?.position) return fail('missing_bot')

  const item = Object.values(bot.entities || {})
    .filter(entity => isDroppedItemEntity(entity))
    .map(entity => ({
      entity,
      distance: distance(bot.entity.position, entity.position)
    }))
    .filter(candidate => candidate.distance <= radius)
    .sort((a, b) => a.distance - b.distance)[0]

  if (!item) return fail('item_not_found')
  return ok('item_found', { item: item.entity, distance: item.distance })
}

function findDroppedItemNear(context = {}, position, options = {}) {
  const bot = context.bot
  if (!bot?.entity?.position || !position) return fail('missing_bot_or_position')
  const radius = options.radius ?? 3
  const acceptable = new Set((options.acceptableItemNames || []).filter(Boolean))

  const item = Object.values(bot.entities || {})
    .filter(entity => isDroppedItemEntity(entity))
    .map(entity => ({
      entity,
      distanceToBlock: distance(entity.position, position),
      distanceToBot: distance(bot.entity.position, entity.position),
      itemName: droppedItemName(context, entity)
    }))
    .filter(candidate => candidate.distanceToBlock <= radius)
    .filter(candidate => acceptable.size === 0 || acceptable.has(candidate.itemName))
    .sort((a, b) => a.distanceToBlock - b.distanceToBlock || a.distanceToBot - b.distanceToBot)[0]

  if (!item) return fail('drop_not_found', { acceptableItemNames: Array.from(acceptable), radius })
  return ok('drop_found', item)
}

async function confirmPickupForBlockDrop(context = {}, blockName, blockPosition, options = {}) {
  const acceptableItemNames = resolveBlockDropItemNames(context, blockName, options)
  const expectedDropId = acceptableItemNames[0] || blockName || 'unknown'
  const beforeCounts = options.inventoryBeforeCounts || inventoryCounts(context)
  const beforeExpected = countAny(beforeCounts, acceptableItemNames)
  const minedCountBefore = options.minedCountBefore ?? 'unknown'
  const timeoutMs = options.pickupTimeoutMs ?? 9000
  const pollIntervalMs = options.pickupPollIntervalMs ?? 150
  const startedAt = Date.now()

  log(context, `[pickup-confirm] layer=mining targetBlock=${blockName || 'unknown'} targetPos=${formatPos(blockPosition)} expectedDropId=${expectedDropId} acceptableDrops=${acceptableItemNames.join('|') || 'unknown'} minedCountBefore=${minedCountBefore} action=start inventoryBefore=${formatCounts(beforeCounts, acceptableItemNames)}`)

  let found = findDroppedItemNear(context, blockPosition, {
    radius: options.dropSearchRadius ?? 3,
    acceptableItemNames
  })

  while (!found.ok && Date.now() - startedAt < Math.min(timeoutMs, options.dropSearchTimeoutMs ?? 1200)) {
    await sleep(pollIntervalMs)
    found = findDroppedItemNear(context, blockPosition, {
      radius: options.dropSearchRadius ?? 3,
      acceptableItemNames
    })
  }

  if (!found.ok) {
    const afterCounts = inventoryCounts(context)
    const delta = countAny(afterCounts, acceptableItemNames) - beforeExpected
    log(context, `[pickup-confirm] layer=mining targetBlock=${blockName || 'unknown'} targetPos=${formatPos(blockPosition)} expectedDropId=${expectedDropId} dropEntity=none inventoryAfter=${formatCounts(afterCounts, acceptableItemNames)} inventoryDelta=${delta} minedCountBefore=${minedCountBefore} minedCountAfter=${minedCountBefore} result=pickup_failed reason=${found.error}`)
    return fail(found.error, { blockName, blockPosition, expectedDropId, acceptableItemNames, inventoryBefore: beforeCounts, inventoryAfter: afterCounts, inventoryDelta: delta, minedCountBefore })
  }

  const item = found.data.entity
  const itemName = found.data.itemName || expectedDropId
  log(context, `[pickup-confirm] layer=mining targetBlock=${blockName || 'unknown'} targetPos=${formatPos(blockPosition)} expectedDropId=${expectedDropId} dropEntity=${item.id ?? 'unknown'} dropItem=${itemName} dropPos=${formatPos(item.position)} action=move_to_drop result=start`)

  const pickupRange = options.pickupRange ?? 1.0
  const maxAttempts = Math.max(1, options.pickupMaxAttempts ?? 3)
  const perAttemptMoveTimeoutMs = options.pickupAttemptMoveTimeoutMs ?? Math.min(4000, options.moveTimeoutMs ?? 4000)
  const pollWindowMs = options.pickupPollWindowMs ?? 1500

  let target = item
  let afterCounts = inventoryCounts(context)
  let delta = countAny(afterCounts, acceptableItemNames) - beforeExpected
  let entityGone = !context.bot?.entities?.[target.id]
  let moveFailed = false
  let lastMoveError = null

  // Approach-and-collect with retries. A single pathfinder move to the exact drop
  // can time out on awkward terrain even when the item is reachable, and a scattered
  // drop may land just out of auto-collect range. Re-find the nearest acceptable drop
  // each attempt (it may have settled, or another copy of the same drop may now be
  // closer/reachable) and keep trying until the inventory delta confirms collection
  // or the overall pickup budget is exhausted. The inventory delta is the source of
  // truth — a move_timeout with a positive delta is still a successful pickup.
  for (let attempt = 1; attempt <= maxAttempts && delta <= 0 && Date.now() - startedAt < timeoutMs; attempt++) {
    if (typeof options.shouldContinue === 'function' && options.shouldContinue() === false) break
    const refind = findDroppedItemNear(context, blockPosition, {
      radius: options.dropSearchRadius ?? 3,
      acceptableItemNames
    })
    if (refind.ok) target = refind.data.entity
    const targetPos = target.position
    const inRange = distance(context.bot?.entity?.position, targetPos) <= pickupRange
    const moved = inRange
      ? ok('already_in_pickup_range', { position: targetPos, range: pickupRange })
      : await moveTo(context, targetPos, {
        owner: options.owner,
        range: pickupRange,
        timeoutMs: perAttemptMoveTimeoutMs,
        shouldContinue: options.shouldContinue,
        holdLock: options.holdLock === true
      })
    moveFailed = !moved.ok
    if (moveFailed) lastMoveError = moved.error

    // Poll for mineflayer auto-collect to register an inventory delta.
    const pollDeadline = Math.min(startedAt + timeoutMs, Date.now() + pollWindowMs)
    afterCounts = inventoryCounts(context)
    delta = countAny(afterCounts, acceptableItemNames) - beforeExpected
    entityGone = entityGone || !context.bot?.entities?.[target.id]
    while (delta <= 0 && Date.now() < pollDeadline) {
      await sleep(pollIntervalMs)
      afterCounts = inventoryCounts(context)
      delta = countAny(afterCounts, acceptableItemNames) - beforeExpected
      entityGone = entityGone || !context.bot?.entities?.[target.id]
    }
  }

  const success = delta > 0
  const failureReason = moveFailed ? `pickup_move_failed:${lastMoveError}` : 'pickup_inventory_delta_missing'
  const resultLabel = success ? 'pickup_success' : (moveFailed ? 'pickup_move_failed' : 'pickup_timeout')
  log(context, `[pickup-confirm] layer=mining targetBlock=${blockName || 'unknown'} targetPos=${formatPos(blockPosition)} expectedDropId=${expectedDropId} dropEntity=${target.id ?? 'unknown'} dropPos=${formatPos(target.position)} inventoryBefore=${formatCounts(beforeCounts, acceptableItemNames)} inventoryAfter=${formatCounts(afterCounts, acceptableItemNames)} inventoryDelta=${delta} entityGone=${entityGone} moveOk=${!moveFailed} minedCountBefore=${minedCountBefore} minedCountAfter=${success ? (numberOrUnknown(minedCountBefore) + 1) : minedCountBefore} result=${resultLabel} reason=${success ? 'inventory_delta_confirmed' : failureReason}`)

  if (!success) {
    return fail(failureReason, { blockName, blockPosition, expectedDropId, acceptableItemNames, inventoryBefore: beforeCounts, inventoryAfter: afterCounts, inventoryDelta: delta, entityId: target.id ?? null, entityGone, minedCountBefore, moveFailed })
  }

  return ok('pickup_confirmed', { blockName, blockPosition, expectedDropId, acceptableItemNames, inventoryBefore: beforeCounts, inventoryAfter: afterCounts, inventoryDelta: delta, entityId: target.id ?? null, entityGone, minedCountBefore, minedCountAfter: numberOrUnknown(minedCountBefore) + 1 })
}

async function pickupNearestItem(context = {}, options = {}) {
  const found = findNearestDroppedItem(context, options.radius || 16)
  if (!found.ok) {
    log(context, `[pickup] item=none distance=unknown action=scan result=${found.error}`)
    return found
  }

  const item = found.data.item
  const itemName = item.metadata?.itemId || item.displayName || item.name || 'item'
  log(context, `[danger] entity=${item.id ?? 'unknown'} type=item hostile=false ignored=true`)
  log(context, `[avoidance] entity=${item.id ?? 'unknown'} type=item avoided=false reason=item_not_danger`)
  log(context, `[pickup] item=${itemName} distance=${round(found.data.distance)} action=move_to_item result=start`)

  const moved = await moveTo(context, item.position, {
    owner: options.owner,
    range: options.range ?? 1,
    timeoutMs: options.timeoutMs ?? 5000
  })
  if (!moved.ok) {
    log(context, `[pickup] item=${itemName} distance=${round(found.data.distance)} action=move_to_item result=${moved.error}`)
    return moved
  }

  log(context, `[pickup] item=${itemName} distance=0 action=wait_collect result=ok`)
  return ok('pickup_done', { item: itemName, entityId: item.id ?? null })
}

function isDroppedItemEntity(entity) {
  return Boolean(entity?.position) && (
    entity.name === 'item' ||
    (entity.type === 'object' && entity.displayName === 'Item') ||
    (entity.kind === 'object' && entity.displayName === 'Item')
  )
}

function resolveBlockDropItemNames(context = {}, blockName, options = {}) {
  if (Array.isArray(options.acceptableItemNames) && options.acceptableItemNames.length) {
    return [...new Set(options.acceptableItemNames.filter(Boolean))]
  }

  const registry = context.bot?.registry
  const block = blockName ? registry?.blocksByName?.[blockName] : null
  const itemsArray = registry?.itemsArray || []
  const itemsById = registry?.itemsById || Object.fromEntries(itemsArray.map(item => [item.id, item]))
  const itemNames = []

  for (const dropId of block?.drops || []) {
    const item = itemsById[dropId] || itemsArray.find(candidate => candidate.id === dropId)
    if (item?.name) itemNames.push(item.name)
  }

  if (itemNames.length === 0 && blockName && FALLBACK_BLOCK_DROPS[blockName]) {
    itemNames.push(...FALLBACK_BLOCK_DROPS[blockName])
  }
  if (itemNames.length === 0 && blockName && registry?.itemsByName?.[blockName]) {
    itemNames.push(blockName)
  }

  return [...new Set(itemNames)]
}

function droppedItemName(context = {}, entity = {}) {
  const itemId = entity.metadata?.itemId ?? entity.metadata?.[8]?.itemId ?? entity.metadata?.[8]?.item?.itemId
  const byId = context.bot?.registry?.itemsById?.[itemId] || context.bot?.registry?.itemsArray?.find(item => item.id === itemId)
  return byId?.name || entity.item?.name || entity.metadata?.itemName || entity.name || entity.displayName || 'item'
}

function inventoryCounts(context = {}) {
  const counts = {}
  for (const item of context.bot?.inventory?.items?.() || []) {
    if (!item?.name) continue
    counts[item.name] = (counts[item.name] || 0) + (item.count || 0)
  }
  return counts
}

function countAny(counts = {}, names = []) {
  return names.reduce((sum, name) => sum + (counts[name] || 0), 0)
}

function log(context, message) {
  if (context.logger?.log) context.logger.log(message)
  else if (context.debug) context.debug(message)
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 'unknown'
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function formatCounts(counts = {}, names = []) {
  if (!names.length) return '{}'
  return JSON.stringify(Object.fromEntries(names.map(name => [name, counts[name] || 0])))
}

function numberOrUnknown(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 'unknown'
}

module.exports = {
  confirmPickupForBlockDrop,
  findNearestDroppedItem,
  findDroppedItemNear,
  inventoryCounts,
  isDroppedItemEntity,
  pickupNearestItem,
  resolveBlockDropItemNames
}
