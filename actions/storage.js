const { moveTo } = require('./move')
const { toBlockPos, toBlockVec3 } = require('../utils/position')
const {
  descendingEscapeWaypoints,
  distanceScaledMoveTimeout,
  localEscapeWaypoints,
  safeDropDownForHealth
} = require('../utils/movement-timeout')
const {
  acquireActionLocks,
  distance,
  fail,
  normalizePosition,
  ok,
  releaseActionLocks
} = require('./action-utils')
const { getInventorySummary } = require('./inventory')

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
const CONTAINER_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel'])

function findNearbyChests(context, radius = 8, options = {}) {
  const bot = context?.bot
  console.log(`[CHEST_SCAN_START] centers=${scanCenterLabels(context, options).join('/')} radius=${radius}`)
  console.log(`[CHEST_SEARCH_START] nearbyRadius=${radius}`)
  if (!bot?.registry?.blocksByName) return fail('missing_block_registry')
  if (typeof bot.findBlocks !== 'function' && typeof bot.findBlock !== 'function') return fail('missing_findBlock')

  const containerIds = [...CONTAINER_BLOCKS]
    .map(name => bot.registry.blocksByName[name]?.id)
    .filter(id => id != null)
  if (!containerIds.length) return fail('missing_container_block_ids')

  try {
    const invalidPositions = options.invalidPositions || new Set()
    const candidates = collectContainerCandidates(context, radius, containerIds, options)
      .filter(candidate => !invalidPositions.has(posKey(candidate.position)))
      .map(candidate => annotateChest(context, candidate))
      .sort((a, b) => scoreChestCandidate(a) - scoreChestCandidate(b))

    if (!candidates.length) console.log(`[CHEST_NOT_FOUND] radius=${radius}`)
    for (const chest of candidates) {
      console.log(`[CHEST_FOUND] pos=${formatPos(chest.position)} type=${chest.chestType || chest.name || 'unknown'}`)
    }

    return ok('nearby_chests_found', { chests: candidates })
  } catch (err) {
    return fail(err.message)
  }
}

async function moveToChest(context, chestPosition, options = {}) {
  const position = normalizePosition(chestPosition)
  if (!position) return fail('missing_chest_position')
  const moved = await moveTo(context, position, {
    owner: options.owner,
    range: options.range ?? 2,
    timeoutMs: options.timeoutMs ?? 15000,
    canDig: options.canDig === true,
    shouldContinue: options.shouldContinue,
    holdLock: options.holdLock
  })
  if (
    moved.ok ||
    moved.error !== 'move_timeout' ||
    options.allowEscapeRecovery === false ||
    options.canDig === true ||
    !chestPathShouldContinue(options)
  ) return moved

  return recoverChestPathAfterTimeout(context, position, options, moved)
}

async function recoverChestPathAfterTimeout(context, position, options, originalResult) {
  const bot = context?.bot
  const start = bot?.entity?.position
  // Upstream maxDropDown (4) is feet-to-landing-block-top, i.e. a fall of 3.
  const maxDropDown = Math.max(1, Math.floor(Number(options.escapeMaxDropDown ?? 4)))
  const maxFall = maxDropDown - 1
  const drop = Number.isFinite(start?.y) ? Math.floor(start.y) - Math.floor(position.y) : 0
  // Round 11, live: she stood on a tower top six blocks above the chest. The
  // walk refuses falls over maxFall, and the same-level waypoints below only
  // ever moved her sideways, so the chain was structurally unable to help.
  // When the chest is that far down, look for ledges first (legs of at most
  // maxFall each); if there is no ledge and the whole drop is one she can
  // afford, retry the walk allowing that drop instead.
  const descending = drop > maxFall
  const candidates = (descending
    ? descendingEscapeWaypoints(start, position, {
        offset: options.escapeWaypointOffset ?? 4,
        maxFall
      }).filter(candidate => isStandableChestEscape(bot, candidate))
      .slice(0, Math.max(1, Number(options.escapeDescentAttempts ?? 3)))
    : localEscapeWaypoints(start, position, {
        offset: options.escapeWaypointOffset ?? 4
      }).filter(candidate => isStandableChestEscape(bot, candidate)))
  if (!candidates.length) {
    if (!descending) return originalResult
    return retryChestWalkWithAffordableDrop(context, position, options, originalResult, { drop, maxFall })
  }

  for (const candidate of candidates) {
    if (!chestPathShouldContinue(options)) return fail('task_interrupted')
    console.log(
      `[CHEST_PATH_ESCAPE_ATTEMPT] target=${formatPos(position)} ` +
      `waypoint=${formatPos(candidate)} reason=direct_move_timeout`
    )
    const escaped = await moveTo(context, candidate, {
      owner: options.owner,
      range: options.escapeWaypointRange ?? 0.5,
      timeoutMs: options.escapeWaypointTimeoutMs ?? 10000,
      canDig: false,
      shouldContinue: options.shouldContinue,
      holdLock: options.holdLock
    })
    if (!escaped.ok) continue

    console.log(
      `[CHEST_PATH_ESCAPE_REACHED] target=${formatPos(position)} waypoint=${formatPos(candidate)}`
    )
    const retryTimeoutMs = options.retryTimeoutMs ?? distanceScaledMoveTimeout(
      bot?.entity?.position,
      position
    )
    const retried = await moveTo(context, position, {
      owner: options.owner,
      range: options.range ?? 2,
      timeoutMs: retryTimeoutMs,
      canDig: false,
      shouldContinue: options.shouldContinue,
      holdLock: options.holdLock
    })
    console.log(
      `[CHEST_PATH_ESCAPE_${retried.ok ? 'RECOVERED' : 'RETRY_FAILED'}] ` +
      `target=${formatPos(position)} waypoint=${formatPos(candidate)} timeoutMs=${retryTimeoutMs} ` +
      `result=${retried.ok ? retried.message : sanitizeReason(retried.error)}`
    )
    return retried
  }
  return originalResult
}

async function retryChestWalkWithAffordableDrop(context, position, options, originalResult, params = {}) {
  const bot = context?.bot
  const { drop, maxFall } = params
  const affordable = safeDropDownForHealth(bot?.health, {
    defaultDrop: maxFall,
    maximumDrop: options.escapeMaxAffordableDrop ?? 8
  })
  if (drop > affordable) {
    console.log(
      `[CHEST_PATH_ESCAPE_DROP_REFUSED] target=${formatPos(position)} drop=${drop} ` +
      `affordable=${affordable} health=${bot?.health ?? 'unknown'} reason=no_ledge_and_drop_unaffordable`
    )
    return originalResult
  }
  if (!chestPathShouldContinue(options)) return fail('task_interrupted')
  console.log(
    `[CHEST_PATH_ESCAPE_DROP] target=${formatPos(position)} drop=${drop} ` +
    `affordable=${affordable} health=${bot?.health ?? 'unknown'} reason=no_ledge_within_${maxFall}`
  )
  const retryTimeoutMs = options.retryTimeoutMs ?? distanceScaledMoveTimeout(bot?.entity?.position, position)
  const retried = await moveTo(context, position, {
    owner: options.owner,
    range: options.range ?? 2,
    timeoutMs: retryTimeoutMs,
    canDig: false,
    // feet-to-landing-block-top: one more than the fall itself
    maxDropDown: drop + 1,
    shouldContinue: options.shouldContinue,
    holdLock: options.holdLock
  })
  console.log(
    `[CHEST_PATH_ESCAPE_${retried.ok ? 'RECOVERED' : 'RETRY_FAILED'}] ` +
    `target=${formatPos(position)} waypoint=drop:${drop} timeoutMs=${retryTimeoutMs} ` +
    `result=${retried.ok ? retried.message : sanitizeReason(retried.error)}`
  )
  return retried
}

function isStandableChestEscape(bot, position) {
  if (!bot || !position) return false
  const feet = bot.blockAt?.(toBlockVec3(position), false)
  const head = bot.blockAt?.(toBlockVec3({ ...position, y: position.y + 1 }), false)
  const below = bot.blockAt?.(toBlockVec3({ ...position, y: position.y - 1 }), false)
  return Boolean(
    feet && AIR_BLOCKS.has(feet.name) &&
    head && AIR_BLOCKS.has(head.name) &&
    below && !AIR_BLOCKS.has(below.name) &&
    Array.isArray(below.shapes) && below.shapes.length > 0
  )
}

function chestPathShouldContinue(options = {}) {
  if (typeof options.shouldContinue !== 'function') return true
  try {
    return options.shouldContinue() !== false
  } catch {
    return false
  }
}

async function openChest(context, chestPosition, options = {}) {
  const bot = context?.bot
  const position = normalizePosition(chestPosition)
  if (!bot?.entity) return fail('missing_bot')
  if (!position) return fail('missing_chest_position')
  if (!storageActionShouldContinue(options)) return fail('task_interrupted')
  if (typeof bot.openChest !== 'function' && typeof bot.openContainer !== 'function') {
    return fail('missing_open_chest_api')
  }

  const lock = acquireActionLocks(context, ['movement', 'inventory'], 'openChest', options)
  if (!lock.ok) return fail(lock.error, lock)

  let chestWindow = null
  try {
    if (!storageActionShouldContinue(options)) return fail('task_interrupted')
    if (isDangerHigh(context)) return fail('danger_too_high')
    const openDistance = options.openDistance ?? 4.5
    if (distance(bot.entity.position, position) > openDistance) {
      const moved = await moveToChest(context, position, {
        owner: lock.owner,
        timeoutMs: options.timeoutMs,
        shouldContinue: options.shouldContinue,
        holdLock: true
      })
      if (!storageActionShouldContinue(options)) return fail('task_interrupted')
      if (!moved.ok) {
        const currentDistance = distance(bot.entity.position, position)
        if (currentDistance > openDistance) {
          console.log(`[CHEST_PATH_UNREACHABLE] pos=${formatPos(position)}`)
          return fail('chest_path_unreachable')
        }
        console.log(`[CHEST_PATH_RECOVERED_NEAR] pos=${formatPos(position)} distance=${currentDistance.toFixed(2)} moveError=${sanitizeReason(moved.error)}`)
      }
    }

    const lookup = lookupLiveContainerBlock(bot, position, { log: true })
    if (!storageActionShouldContinue(options)) return fail('task_interrupted')
    if (!lookup.block) {
      console.log(`[CHEST_OPEN_FAILED] pos=${formatPos(position)} reason=container_block_changed actual=${lookup.name || 'null'}`)
      return fail('container_block_changed', { actualName: lookup.name || null })
    }

    const block = lookup.block
    const metadata = getChestMetadata(context, block)
    const blocked = getBlockedReason(context, block)
    if (blocked) {
      console.log(`[CHEST_BLOCKED] pos=${formatPos(position)} reason=block_above block=${blocked}`)
      console.log(`[CHEST_OPEN_FAILED] pos=${formatPos(position)} reason=chest_blocked_above:${blocked}`)
      return fail(`chest_blocked_above:${blocked}`)
    }

    const openContainer = block.name === 'barrel'
      ? (bot.openContainer || bot.openChest)
      : (bot.openChest || bot.openContainer)
    if (typeof openContainer !== 'function') return fail('missing_open_chest_api')

    console.log(`[CHEST_OPEN_ATTEMPT] pos=${formatPos(block.position)} blockName=${block.name} blockType=${lookup.constructorName}`)
    chestWindow = await openContainer.call(bot, block)
    if (!storageActionShouldContinue(options)) {
      try { chestWindow?.close?.() } catch {}
      chestWindow = null
      return fail('task_interrupted')
    }
    const slots = getChestSlotCount(chestWindow)
    console.log(`[CHEST_OPENED] pos=${formatPos(block.position)} windowType=${chestWindow?.type || chestWindow?.windowType || chestWindow?.title || 'unknown'} slots=${slots}`)
    console.log(`[CHEST_SIZE] slots=${slots}`)
    console.log(`[CHEST_CONTENTS] pos=${formatPos(block.position)} items=${JSON.stringify(summarizeItems(getChestItems(chestWindow)))}`)
    const data = {
      chestWindow,
      chestPosition: block.position,
      chestType: metadata.chestType || block.name || 'unknown'
    }
    return { ...ok('chest_opened', data), ...data }
  } catch (err) {
    console.log(`[CHEST_OPEN_FAILED] pos=${formatPos(position)} reason=${sanitizeReason(err.message)} stack=${firstStackLines(err)}`)
    return fail(err.message)
  } finally {
    if (!options.holdLock || !chestWindow) releaseActionLocks(context, lock.owner)
  }
}

function storageActionShouldContinue(options = {}) {
  if (typeof options.shouldContinue !== 'function') return true
  try {
    return options.shouldContinue() !== false
  } catch {
    return false
  }
}

function closeChest(context, chestWindow, options = {}) {
  try {
    chestWindow?.close?.()
    console.log('[CHEST_CLOSE]')
    if (options.owner) releaseActionLocks(context, options.owner)
    return ok('chest_closed')
  } catch (err) {
    return fail(err.message)
  }
}

async function depositItem(context, chestWindow, itemName, count = null, options = {}) {
  if (!chestWindow) return fail('missing_chest_window')
  if (!itemName) return fail('missing_item_name')

  const lock = acquireActionLocks(context, ['inventory'], 'depositItem', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    const matching = context.bot?.inventory?.items?.().filter(candidate => candidate.name === itemName) || []
    const totalAvailable = matching.reduce((sum, item) => sum + (item.count || 0), 0)
    if (!matching.length || totalAvailable <= 0) return fail(`inventory_item_not_found:${itemName}`)
    const stackSize = itemStackSize(context, itemName, matching[0])
    const request = resolveMoveRequest(count, totalAvailable, stackSize)
    const amount = request.amount
    if (amount <= 0) return fail(`inventory_item_not_found:${itemName}`)
    if (typeof chestWindow.deposit !== 'function') return fail('missing_deposit')

    if (request.requested > totalAvailable) {
      console.log(`[DEPOSIT_PARTIAL_REQUEST] item=${itemName} requested=${request.requested} available=${totalAvailable} moving=${amount}`)
    }
    console.log(`[CHEST_DEPOSIT_ATTEMPT] item=${itemName} count=${amount}`)
    let remaining = amount
    let moved = 0
    for (const item of matching) {
      if (remaining <= 0) break
      const stackAmount = Math.min(item.count || 0, remaining)
      if (stackAmount <= 0) continue
      await chestWindow.deposit(item.type ?? item.id ?? item, item.metadata ?? null, stackAmount)
      moved += stackAmount
      remaining -= stackAmount
    }
    if (moved <= 0) return fail(`deposit_moved_zero:${itemName}`)
    if (moved < amount) {
      console.log(`[DEPOSIT_PARTIAL] item=${itemName} moved=${moved} remaining=${amount - moved} reason=deposit_incomplete`)
    }
    console.log(`[CHEST_DEPOSIT_SUCCESS] item=${itemName} count=${moved}`)
    return ok('item_deposited', { itemName, count: moved })
  } catch (err) {
    return fail(err.message)
  } finally {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
  }
}

async function withdrawItem(context, chestWindow, itemName, count = 1, options = {}) {
  if (!chestWindow) return fail('missing_chest_window')
  if (!itemName) return fail('missing_item_name')

  const lock = acquireActionLocks(context, ['inventory'], 'withdrawItem', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    const items = getChestItems(chestWindow)
    const matching = items.filter(candidate => candidate.name === itemName)
    const totalAvailable = matching.reduce((sum, item) => sum + (item.count || 0), 0)
    const item = matching[0]
    console.log(`[ITEM_MATCH_RESULT] query=${options.query || itemName} matched=${item?.name || 'none'} count=${totalAvailable}`)
    if (!item || totalAvailable <= 0) return fail(`chest_item_not_found:${itemName}`)
    if (typeof chestWindow.withdraw !== 'function') return fail('missing_withdraw')

    const stackSize = itemStackSize(context, itemName, item)
    const request = resolveMoveRequest(count, totalAvailable, stackSize)

    if (request.mode === 'all') {
      console.log(`[WITHDRAW_ALL_PLAN] item=${itemName} stacks=${matching.length} totalCount=${totalAvailable}`)
      let moved = 0
      for (const stack of matching) {
        const stackCount = stack.count || 0
        if (stackCount <= 0) continue
        console.log(`[WITHDRAW_STACK_ATTEMPT] item=${itemName} count=${stackCount} slot=${stack.slot ?? 'unknown'}`)
        await chestWindow.withdraw(stack.type ?? stack.id ?? stack, stack.metadata ?? null, stackCount)
        moved += stackCount
        console.log(`[WITHDRAW_STACK_SUCCESS] item=${itemName} count=${stackCount}`)
      }
      if (moved <= 0) return fail(`chest_item_not_found:${itemName}`)
      console.log(`[WITHDRAW_ALL_SUCCESS] item=${itemName} total=${moved}`)
      console.log(`[CHEST_WITHDRAW_SUCCESS] item=${itemName} count=${moved}`)
      return ok('item_withdrawn', { itemName, count: moved })
    }

    const requested = request.amount
    if (request.requested > totalAvailable) {
      console.log(`[WITHDRAW_PARTIAL_REQUEST] item=${itemName} requested=${request.requested} available=${totalAvailable} moving=${requested}`)
    }
    let remaining = requested
    let moved = 0
    console.log(`[CHEST_WITHDRAW_ATTEMPT] item=${itemName} count=${requested}`)
    for (const stack of matching) {
      if (remaining <= 0) break
      const amount = Math.min(stack.count || 0, remaining)
      if (amount <= 0) continue
      await chestWindow.withdraw(stack.type ?? stack.id ?? stack, stack.metadata ?? null, amount)
      moved += amount
      remaining -= amount
    }
    if (moved < requested) {
      console.log(`[WITHDRAW_PARTIAL] item=${itemName} moved=${moved} remaining=${requested - moved} reason=withdraw_incomplete`)
    }
    if (moved <= 0) return fail(`withdraw_moved_zero:${itemName}`)
    console.log(`[CHEST_WITHDRAW_SUCCESS] item=${itemName} count=${moved}`)
    return ok('item_withdrawn', { itemName, count: moved })
  } catch (err) {
    return fail(err.message)
  } finally {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
  }
}

function getChestSummary(context, chestWindow) {
  if (!chestWindow) return fail('missing_chest_window')
  const counts = {}
  for (const item of getChestItems(chestWindow)) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return ok('chest_summary', { counts, totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0) })
}

function getChestItems(chestWindow) {
  if (!chestWindow) return []
  if (typeof chestWindow.containerItems === 'function') return chestWindow.containerItems() || []
  if (typeof chestWindow.items === 'function') return chestWindow.items() || []
  if (Array.isArray(chestWindow.slots)) {
    const end = Number.isInteger(chestWindow.inventoryStart)
      ? chestWindow.inventoryStart
      : chestWindow.slots.length
    return chestWindow.slots.slice(0, end).filter(Boolean)
  }
  return chestWindow.items || []
}

function lookupLiveContainerBlock(bot, pos, options = {}) {
  const vec = toBlockVec3(pos)
  let block = null
  if (vec && typeof bot?.blockAt === 'function') {
    try {
      block = bot.blockAt(vec)
    } catch {}
  }

  const name = block?.name || null
  const constructorName = block?.constructor?.name || 'null'
  const isContainer = Boolean(block && CONTAINER_BLOCKS.has(name))
  if (options.log) {
    console.log(`[CHEST_LIVE_BLOCK_LOOKUP] pos=${formatPos(pos)} found=${isContainer} name=${name || 'null'} constructor=${constructorName}`)
  }
  return {
    block: isContainer ? block : null,
    name,
    constructorName
  }
}

function getLiveContainerBlock(bot, pos) {
  return lookupLiveContainerBlock(bot, pos).block
}

function collectContainerCandidates(context, radius, containerIds, options) {
  const bot = context?.bot
  const seen = new Map()
  for (const center of getScanCenters(context, options)) {
    const scanRadius = center.radius || radius
    const positions = options.exactScanCenters === true
      ? [center.position]
      : center.source === 'bot'
      ? findFromBot(bot, containerIds, scanRadius, center.position)
      : scanAround(bot, containerIds, scanRadius, center.position)
    for (const position of positions) {
      const block = bot.blockAt?.(toBlockVec3(position))
      if (!block?.position || !CONTAINER_BLOCKS.has(block.name)) continue
      const key = posKey(block.position)
      const candidate = {
        name: block.name,
        type: block.type ?? block.id,
        id: block.id,
        position: block.position,
        source: center.source,
        distance: distance(center.position, block.position),
        botDistance: distance(bot.entity?.position, block.position)
      }
      console.log(`[CHEST_CANDIDATE] pos=${formatPos(block.position)} type=${block.name} source=${center.source} distance=${candidate.distance.toFixed(1)}`)
      const existing = seen.get(key)
      if (!existing || scoreChestCandidate(candidate) < scoreChestCandidate(existing)) seen.set(key, candidate)
    }
  }
  return [...seen.values()]
}

function getScanCenters(context, options = {}) {
  const bot = context?.bot
  const centers = []
  const extraCenters = normalizeExtraScanCenters(options.scanCenters || options.storageScanCenters || options.anchorPositions)
  const onlyProvidedCenters = options.scanOnlyProvidedCenters === true && extraCenters.length > 0
  if (!onlyProvidedCenters && bot?.entity?.position) centers.push({ source: 'bot', position: bot.entity.position })

  if (!onlyProvidedCenters) {
    const player = findPlayerEntity(context, options)
    if (player?.position) centers.push({ source: 'player', position: player.position })
  }

  for (const center of extraCenters) {
    centers.push(center)
  }

  if (!onlyProvidedCenters) {
    const looked = getLookedContainer(bot)
    if (looked?.position) centers.push({ source: 'look', position: looked.position, block: looked })
  }
  return centers
}

function normalizeExtraScanCenters(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : [])
  const centers = []
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index]
    const position = entry?.position || entry
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y)) || !Number.isFinite(Number(position.z))) continue
    centers.push({
      source: entry?.source || `anchor_${index + 1}`,
      position: {
        x: Math.round(Number(position.x)),
        y: Math.round(Number(position.y)),
        z: Math.round(Number(position.z))
      },
      radius: positiveNumber(entry?.radius)
    })
  }
  return centers
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function scanCenterLabels(context, options = {}) {
  return getScanCenters(context, options).map(center => center.source)
}

function findFromBot(bot, containerIds, radius, point) {
  if (typeof bot.findBlocks === 'function') {
    return bot.findBlocks({ matching: containerIds, maxDistance: radius, count: 64, point }) || []
  }
  const block = bot.findBlock?.({ matching: containerIds, maxDistance: radius, point })
  return block?.position ? [block.position] : []
}

function scanAround(bot, containerIds, radius, center) {
  const base = toBlockPos(center)
  if (!base) return []
  const ids = new Set(containerIds)
  const positions = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -Math.min(radius, 4); dy <= Math.min(radius, 4); dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue
        const pos = toBlockVec3({ x: base.x + dx, y: base.y + dy, z: base.z + dz })
        const block = bot.blockAt?.(pos)
        if (block && ids.has(block.type ?? block.id)) positions.push(block.position)
      }
    }
  }
  return positions
}

function getLookedContainer(bot) {
  try {
    const block = bot?.blockAtCursor?.(8)
    return block && CONTAINER_BLOCKS.has(block.name) ? block : null
  } catch {
    return null
  }
}

function findPlayerEntity(context, options = {}) {
  const bot = context?.bot
  const name = options.playerName || context?.playerName || context?.blackboard?.get?.('config.ownerName')
  if (name && bot?.players?.[name]?.entity) return bot.players[name].entity
  return Object.values(bot?.players || {})
    .map(player => player.entity)
    .filter(entity => entity && entity !== bot.entity)
    .sort((a, b) => distance(bot.entity?.position, a.position) - distance(bot.entity?.position, b.position))[0] || null
}

function annotateChest(context, block) {
  if (!block?.position) return block
  const metadata = getChestMetadata(context, block)
  return { ...block, ...metadata }
}

function getChestMetadata(context, block) {
  if (!block?.position) return {}
  if (!['chest', 'trapped_chest'].includes(block.name)) return { chestType: block.name }
  const partner = findAdjacentChest(context, block)
  if (!partner) return { chestType: 'single' }
  const first = comparePositions(block.position, partner.position) <= 0 ? block : partner
  const second = first === block ? partner : block
  console.log(`[DOUBLE_CHEST_DETECTED] posA=${formatPos(first.position)} posB=${formatPos(second.position)}`)
  return { chestType: 'double', doubleChestPartner: partner.position }
}

function findAdjacentChest(context, block) {
  const bot = context?.bot
  const p = block.position
  const offsets = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 }
  ]
  for (const offset of offsets) {
    const other = bot?.blockAt?.(toBlockVec3({
      x: p.x + offset.x,
      y: p.y + offset.y,
      z: p.z + offset.z
    }))
    if (other?.name === block.name) return other
  }
  return null
}

function getBlockedReason(context, block) {
  if (!['chest', 'trapped_chest'].includes(block.name)) return null
  const above = context?.bot?.blockAt?.(toBlockVec3({
    x: block.position.x,
    y: block.position.y + 1,
    z: block.position.z
  }))
  if (!above || AIR_BLOCKS.has(above.name)) return null
  return above.name || 'unknown'
}

function getChestSlotCount(chestWindow) {
  if (typeof chestWindow.containerItems === 'function' && Number.isInteger(chestWindow.inventoryStart)) {
    return chestWindow.inventoryStart
  }
  if (Number.isInteger(chestWindow.inventoryStart)) return chestWindow.inventoryStart
  if (Array.isArray(chestWindow.slots)) return chestWindow.slots.length
  return getChestItems(chestWindow).length
}

function summarizeItems(items) {
  return items.map(item => ({
    name: item.name,
    count: item.count
  }))
}

function scoreChestCandidate(candidate) {
  const sourceScore = storageSourcePreferenceScore(candidate.source)
  const doubleScore = candidate.chestType === 'double' ? -50 : 0
  return sourceScore + doubleScore + chestCandidateDistanceForScore(candidate)
}

function storageSourcePreferenceScore(source) {
  const value = String(source || '')
  if (value === 'look') return -1000
  if (/^build_storage_/.test(value)) return -650
  if (value === 'build_origin' || /^storage_anchor_/.test(value) || /^anchor_/.test(value)) return -200
  return 0
}

function chestCandidateDistanceForScore(candidate) {
  const source = String(candidate?.source || '')
  if (source === 'look' || /^build_storage_/.test(source) || source === 'build_origin' || /^storage_anchor_/.test(source) || /^anchor_/.test(source)) {
    return candidate.distance ?? candidate.botDistance ?? 0
  }
  return candidate.botDistance ?? candidate.distance ?? 0
}

function posKey(position) {
  return `${position.x},${position.y},${position.z}`
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function comparePositions(a, b) {
  return (a.x - b.x) || (a.y - b.y) || (a.z - b.z)
}

function sanitizeReason(reason) {
  return String(reason || 'unknown').replace(/\s+/g, '_')
}

function resolveMoveRequest(requested, available, stackSize = 64) {
  if (requested == null || requested === '') return {
    mode: 'default',
    requested: available,
    amount: available
  }

  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return {
      mode: 'count',
      requested,
      amount: Math.min(requested, available)
    }
  }

  const text = String(requested).trim().toLowerCase()
  if (['all', '全部', '所有', '全拿', '全放'].includes(text)) {
    return {
      mode: 'all',
      requested: available,
      amount: available
    }
  }
  if (['stack', '一组', '1组', '一组物品'].includes(text)) {
    const requestedCount = Math.max(1, Number(stackSize) || 64)
    return {
      mode: 'stack',
      requested: requestedCount,
      amount: Math.min(requestedCount, available)
    }
  }

  const numeric = parseCountText(text)
  if (Number.isFinite(numeric) && numeric > 0) {
    return {
      mode: 'count',
      requested: numeric,
      amount: Math.min(numeric, available)
    }
  }

  return {
    mode: 'default',
    requested: available,
    amount: available
  }
}

function parseCountText(text) {
  const digit = String(text || '').match(/\d+/)
  if (digit) return Number(digit[0])
  const chineseDigits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  }
  if (Object.prototype.hasOwnProperty.call(chineseDigits, text)) return chineseDigits[text]
  if (text.startsWith('十')) return 10 + (chineseDigits[text.slice(1)] || 0)
  if (text.includes('十')) {
    const [tens, ones] = text.split('十')
    return (chineseDigits[tens] || 1) * 10 + (chineseDigits[ones] || 0)
  }
  const compact = text.replace(/[个顆颗件组\s]/g, '')
  if (Object.prototype.hasOwnProperty.call(chineseDigits, compact)) return chineseDigits[compact]
  return NaN
}

function itemStackSize(context, itemName, item = null) {
  return item?.stackSize || context?.bot?.registry?.itemsByName?.[itemName]?.stackSize || 64
}

function firstStackLines(err) {
  return String(err?.stack || err?.message || 'unknown')
    .split('\n')
    .slice(0, 3)
    .map(line => line.trim())
    .join(' | ')
}

function isDangerHigh(context) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return dangerLevel === 'high' || dangerLevel === 'critical'
}

module.exports = {
  closeChest,
  depositItem,
  findNearbyChests,
  getChestSummary,
  getChestItems,
  getInventorySummary,
  getLiveContainerBlock,
  lookupLiveContainerBlock,
  moveToChest,
  openChest,
  withdrawItem
}
