const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { configureMovements, moveTo, stopMovement } = require('./move')
const { checkProtectedBuildingDig } = require('../systems/protected-buildings')
const { DEFAULT_MIN_DEPTH: HAZARD_MIN_DEPTH } = require('../systems/terrain-hazards')
const { toBlockVec3 } = require('../utils/position')
const { yieldToEventLoop } = require('../utils/event-loop')
const {
  isPottedBlockName,
  itemNameForBlock,
  plantItemNameForPottedBlock
} = require('../utils/building-material-map')
const {
  legacyBlockNameMatches,
  legacyBlockStateMismatch,
  legacySkullPlacement,
  modernizeLegacyBlock
} = require('../utils/legacy-block-compat')
const {
  acquireActionLocks,
  distance,
  fail,
  normalizePosition,
  ok,
  releaseActionLocks
} = require('./action-utils')

const UNSAFE_BUILD_BLOCKS = new Set([
  'tnt', 'lava', 'lava_bucket', 'fire', 'campfire', 'soul_campfire',
  'magma_block', 'respawn_anchor'
])

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
// Deepest scaffold pillar worth calling a stand "reachable by pillaring".
// Live vertical access has never planned more than 11 (round 12, gate-height
// fixture tower); 16 leaves headroom without scanning the whole column.
const VERTICAL_ACCESS_STAND_COLUMN_MAX_DEPTH = 16
// mineflayer will happily send a dig packet for a block on the other side of
// the site and then set the block to air in its OWN world on a timer
// (digging.js finishDigging -> _updateBlockState), which resolves the dig
// promise and makes bot.blockAt agree. Live probe on the repair server:
// digging 674,100,275 from 14.05 blocks resolved in 771 ms, the client said
// air for the next 6 s, no item dropped, the server sent no block_change and
// RCON still read dirt. The only bound anyone checks is mineflayer's own
// canDigBlock (digging.js:224, eye +1.65, limit 5.1) - so ask it BEFORE
// digging instead of believing the world afterwards.
const TEMPORARY_REFERENCE_CLEAR_REACH = 5.1
const DEFAULT_DIRT_PATH_STORAGE_MISS_TTL_MS = 5 * 60 * 1000
const dirtPathStorageMissesByContext = new WeakMap()
const BOT_HALF_WIDTH = 0.35
// How far down clearFallDepth bothers to look. Past this the answer stops
// changing anything: it is already a fall she must not take.
const DEFAULT_CLEAR_FALL_PROBE = 8
const BOT_HEIGHT = 1.8
const DEFAULT_SAFE_MOVE_RANGE = 0.25
const INTERACTIVE_REFERENCE_BLOCKS = new Set([
  'anvil',
  'brewing_stand',
  'cartography_table',
  'chipped_anvil',
  'composter',
  'damaged_anvil',
  'enchanting_table',
  'fletching_table',
  'grindstone',
  'jukebox',
  'lectern',
  'loom',
  'note_block',
  'smithing_table',
  'smoker',
  'stonecutter'
])
// 拿这些方块当放置参照时，右键会先被它们自己的交互吃掉（开界面、改档位、取东西），
// 方块根本没放上去，放置后确认才报 place_failed:unstable_air —— 第 11 轮门楼炸掉的
// 中继器、漏斗、红石线就是这一族。按住潜行右键才不会触发交互。
//
// 名单以第 9 轮真机逐个验证为准（改前放不上、改后放得上才进来）。
// 同一批里 bell / chiseled_bookshelf / respawn_anchor / cake / rail / snow
// 改前就放得上，所以**不在**名单里——不需要潜行就别多按一次键。
const SNEAK_ONLY_REFERENCE_BLOCKS = new Set([
  'beacon',
  'comparator',
  'crafter',
  'daylight_detector',
  'decorated_pot',
  'dispenser',
  'dropper',
  'hopper',
  'redstone_wire',
  'repeater'
])
const SNEAK_ONLY_REFERENCE_PATTERNS = [
  /shulker_box$/
]
const NON_REFERENCE_BLOCK_PATTERNS = [
  /_door$/,
  /trapdoor$/,
  /ladder$/,
  /torch$/,
  /button$/,
  /pressure_plate$/,
  /carpet$/,
  /_bed$/,
  /^bed$/,
  /sign$/,
  /banner$/,
  /flower$/,
  /^lantern$/,
  /^flower_pot$/,
  /^(short_)?grass$/,
  /^potted_/,
  /sapling$/,
  /water$/,
  /lava$/
]

const PROTECTED_CLEAR_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'crafting_table',
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
  'hopper',
  'anvil',
  'chipped_anvil',
  'damaged_anvil'
])

const TEMPORARY_REFERENCE_MATERIALS = [
  'dirt',
  'cobblestone',
  'stone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks',
  'scaffolding'
]
const DIRT_PATH_BASE_BLOCKS = new Set([
  'dirt',
  'grass_block',
  'coarse_dirt',
  'podzol',
  'mycelium',
  'rooted_dirt'
])
const SHOVEL_TOOL_ORDER = [
  'netherite_shovel',
  'diamond_shovel',
  'iron_shovel',
  'stone_shovel',
  'golden_shovel',
  'wooden_shovel'
]
const DIRT_PATH_SHOVEL_CRAFT_ORDER = [
  'wooden_shovel',
  'stone_shovel',
  'iron_shovel'
]

function canPlaceBlock(context, position, options = {}) {
  const bot = context?.bot
  const target = normalizePosition(position)
  if (!bot?.blockAt) return fail('missing_bot_blockAt')
  if (!target) return fail('missing_position')

  const lock = acquireActionLocks(context, ['building'], 'canPlaceBlock', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    const current = bot.blockAt(toBlockVec3(target))
    const canDecorateExistingPot = isPottedBlockName(options.blockName) && current?.name === 'flower_pot'
    const canReplaceCurrent = isReplaceablePlacementTarget(current?.name, options.blockName)
    const canExtendExistingCandle = isCandleStackExtensionTarget(
      current,
      options.blockName,
      placementStates(options)
    )
    const legacyVariantAlreadyCorrect = legacyBlockNameMatches(
      current?.name,
      options.blockName,
      placementStates(options)
    ) && !legacyBlockStateMismatch(
      blockProperties(current),
      options.blockName,
      placementStates(options)
    )
    if (legacyVariantAlreadyCorrect) {
      return ok('place_check', {
        alreadyCorrect: true,
        canPlace: true,
        currentBlockName: current.name,
        referencePosition: current.position || target
      })
    }
    if (current && !AIR_BLOCKS.has(current.name) && !canDecorateExistingPot && !canReplaceCurrent && !canExtendExistingCandle) {
      return ok('place_check', { canPlace: false, reason: `target_not_empty:${current.name}` })
    }

    const reference = findReferenceBlockForPlacement(context, target, options.blockName, options.blockStates || options.states || options.orientation)
    if (!reference) return ok('place_check', { canPlace: false, reason: 'no_support_block' })

    return ok('place_check', { canPlace: true, referencePosition: reference.position })
  } finally {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
  }
}

async function clearBlockForBuilding(context, position, options = {}) {
  options = { ...options, standTimeoutMemo: options.standTimeoutMemo || new Set() }
  const bot = context?.bot
  const target = normalizePosition(position)
  if (!bot?.entity) return fail('missing_bot')
  if (!target) return fail('missing_position')
  if (typeof bot.dig !== 'function') return fail('missing_dig')

  const lock = acquireActionLocks(context, ['movement', 'digging', 'building'], 'clearBlockForBuilding', options)
  if (!lock.ok) return fail(lock.error, lock)

  try {
    let block = bot.blockAt?.(toBlockVec3(target))
    if (!block || AIR_BLOCKS.has(block.name)) {
      return ok('block_already_clear', { position: target })
    }
    if (PROTECTED_CLEAR_BLOCKS.has(block.name) && options.allowProtectedClearing !== true) {
      return fail(`protected_block:${block.name}`)
    }

    const digDistance = options.digDistance ?? 4.5
    const thinInteractiveBlock = isThinInteractiveClearBlockName(block.name)
    const baseDigReachable = isDigReachable(bot, target, digDistance)
    const thinDigDistance = Math.max(digDistance, Number(options.thinBlockDigDistance ?? 5))
    const extendedThinDigReachable =
      !baseDigReachable &&
      thinInteractiveBlock &&
      isDigReachable(bot, target, thinDigDistance)
    const exactDigReachable = baseDigReachable || extendedThinDigReachable
    const thinBlockCanDigByBot =
      !exactDigReachable &&
      thinInteractiveBlock &&
      canDigCurrentBlock(bot, block)
    const digReachable = exactDigReachable || thinBlockCanDigByBot
    const intersectsTarget = botIntersectsBlock(bot, target)
    if (extendedThinDigReachable) {
      context.logger?.log?.(`[BUILD_CLEAR_THIN_EXTENDED_REACHABLE] target=${formatPos(target)} block=${block.name} distance=${thinDigDistance}`)
    }
    if (thinBlockCanDigByBot) {
      context.logger?.log?.(`[BUILD_CLEAR_THIN_CAN_DIG_REACHABLE] target=${formatPos(target)} block=${block.name}`)
    }
    const canClearThinIntersection =
      digReachable &&
      intersectsTarget &&
      isThinInteractiveClearBlockName(block.name)
    if (canClearThinIntersection) {
      context.logger?.log?.(`[BUILD_CLEAR_THIN_INTERSECTION_REACHABLE] target=${formatPos(target)} block=${block.name}`)
    }
    if (!digReachable || (intersectsTarget && !canClearThinIntersection)) {
      const clearMoveOptions = {
        ...options,
        safeMoveRange: Number.isFinite(options.clearStandMoveRange)
          ? Number(options.clearStandMoveRange)
          : options.safeMoveRange
      }
      const safeApproachCandidates = findSafePlacementStandPositions(context, target, digDistance, {
        reservedPositions: options.reservedPositions,
        reservedBounds: options.reservedBounds,
        preferOutsideReservedBounds: options.preferOutsideReservedBounds === true,
        preferHighStand: options.preferHighStand === true,
        safeMoveRange: clearMoveOptions.safeMoveRange
      })
      const safeApproach = safeApproachCandidates[0] || null
      if (!safeApproach) {
        // The fallback below walks straight at the obstacle with no safety
        // screen at all. It is kept — round 5's live run showed it still
        // clears the block from the rim via the partial-move recovery below —
        // but on 2026-08-01 it was also the branch that lost her, and it left
        // no trace: the absence of a [BUILD_STANCE_CANDIDATES] line was the
        // only clue. Say so out loud instead.
        context.logger?.log?.(`[BUILD_CLEAR_NO_SAFE_STAND] target=${formatPos(target)} block=${block.name} reason=walking_at_obstacle`)
      }
      const moveTarget = safeApproach || target
      const moved = safeApproach
        ? await moveToFirstReachablePlacementStand(context, target, safeApproachCandidates, {
          owner: lock.owner,
          options: clearMoveOptions,
          placeDistance: digDistance,
          reason: 'avoid_clear_target_collision'
        })
        : await moveTo(context, moveTarget, {
          owner: lock.owner,
          range: options.moveRange ?? 1,
          timeoutMs: placementMoveTimeoutMs(bot, moveTarget, options),
          canDig: options.canDig ?? false,
          allowScaffolding: options.allowScaffolding === true,
          ...movementScaffoldExclusions(options, target),
          shouldContinue: options.shouldContinue,
          holdLock: true
        })
      if (!moved.ok) {
        block = bot.blockAt?.(toBlockVec3(target))
        if (
          moved.error === 'move_timeout' &&
          block &&
          !AIR_BLOCKS.has(block.name) &&
          canRecoverClearAfterPartialMove(bot, target, block, digDistance)
        ) {
          context.logger?.log?.(`[BUILD_CLEAR_MOVE_TIMEOUT_REACH_RECOVERED] target=${formatPos(target)} block=${block.name} reason=partial_move_dig_reachable`)
        } else {
          return moved
        }
      }
    }

    block = bot.blockAt?.(toBlockVec3(target))
    if (!block || AIR_BLOCKS.has(block.name)) {
      return ok('block_already_clear', { position: target })
    }
    if (PROTECTED_CLEAR_BLOCKS.has(block.name) && options.allowProtectedClearing !== true) {
      return fail(`protected_block:${block.name}`)
    }

    const footing = await stepOffTargetBeforeClearing(context, target, block, {
      ...options,
      digDistance,
      owner: lock.owner
    })
    if (!footing.ok) return footing

    const equipment = context.equipmentSystem || context.autoPreparationSystem?.equipmentSystem
    let toolSelection = null
    if (equipment && typeof equipment.equipBestToolForBlock === 'function') {
      toolSelection = await equipment.equipBestToolForBlock(block.name, context)
      if (!toolSelection.success && toolSelection.reason === 'inventory_lock_busy') {
        const inventoryOwner = context.actionLock?.getOwner?.('inventory')
        const canUseExistingOwnerLock = options.owner &&
          inventoryOwner === options.owner &&
          toolSelection.itemName
        if (canUseExistingOwnerLock) {
          const item = bot.inventory?.items?.().find(candidate => candidate.name === toolSelection.itemName)
          if (!item) return fail(`tool_selection_failed:item_not_found:${toolSelection.itemName}`)
          const equipped = await equipPlacementItemWithRetry(context, toolSelection.itemName, item)
          if (!equipped.ok) return fail(`tool_selection_failed:${equipped.error || 'equip_failed'}`)
          context.logger?.log?.(`[BUILD_CLEAR_EQUIP_OWNER_LOCK_FALLBACK] block=${block.name} item=${toolSelection.itemName} owner=${options.owner}`)
          toolSelection = {
            ...toolSelection,
            success: true,
            reason: 'owner_lock_fallback',
            equipped: true
          }
        }
      }
      context.logger?.log?.(`[building-clear] block=${block.name} preferredTool=${toolSelection.preferredTool || 'none'} requiredTool=${toolSelection.requiredTool || 'none'} selectedTool=${toolSelection.itemName || 'none'} allowHand=${toolSelection.allowHand === true} reason=${toolSelection.reason || 'unknown'} error=${toolSelection.success ? 'none' : toolSelection.reason}`)
      if (!toolSelection.success && toolSelection.reason === 'missing_required_tool') {
        return fail(`missing_required_tool:${toolSelection.requiredTool || 'unknown'}`)
      }
      if (!toolSelection.success) return fail(`tool_selection_failed:${toolSelection.reason || 'unknown'}`)
    }

    const canDigByBot = typeof bot.canDigBlock !== 'function' || bot.canDigBlock(block)
    const toolAllowsDig = toolSelection?.success === true && block.diggable !== false
    if (!canDigByBot && !toolAllowsDig) return fail('wrong_tool_type')

    const maxClearAttempts = Math.max(1, Number(options.clearAttempts || 3))
    let lastClearError = null
    for (let attempt = 1; attempt <= maxClearAttempts; attempt++) {
      block = bot.blockAt?.(toBlockVec3(target))
      if (!block || AIR_BLOCKS.has(block.name)) {
        return ok('block_already_clear', { position: target, attempts: attempt })
      }
      if (PROTECTED_CLEAR_BLOCKS.has(block.name) && options.allowProtectedClearing !== true) {
        return fail(`protected_block:${block.name}`)
      }
      {
        // A construction run may clear blocks of its OWN completed building
        // during reconciliation/repair (exemption by matching runId only).
        const buildingGuard = checkProtectedBuildingDig(context, target, {
          source: options.owner || 'build.clearBlockForBuilding',
          exemptRunId: options.protectionExemptRunId
        })
        if (!buildingGuard.allowed) {
          return fail(`protected_building_dig_blocked:${buildingGuard.region.runId}`)
        }
      }
      try {
        await digBlockWithTimeout(bot, block, clearDigTimeoutMs(options))
      } catch (err) {
        const afterAbort = bot.blockAt?.(toBlockVec3(target))
        if (!afterAbort || AIR_BLOCKS.has(afterAbort.name)) {
          return ok('block_cleared_after_dig_abort', {
            position: target,
            blockName: block.name,
            selectedTool: toolSelection?.itemName || bot.heldItem?.name || 'unknown',
            temporary: options.temporary === true,
            attempts: attempt,
            recoveredFrom: err.message
          })
        }
        if (isBuildingDigTimeout(err)) {
          context.logger?.log?.(`[BUILD_CLEAR_DIG_TIMEOUT] target=${formatPos(target)} block=${block.name} reason=${err.message}`)
          return fail(err.message, {
            position: target,
            blockName: block.name,
            attempts: attempt,
            timedOut: true
          })
        }
        lastClearError = err
        if (attempt < maxClearAttempts && isRetryableClearError(err)) {
          context.logger?.log?.(`[BUILD_CLEAR_RETRY] target=${formatPos(target)} block=${afterAbort.name} attempt=${attempt + 1} reason=${err.message}`)
          await sleep(options.clearRetryDelayMs ?? 250)
          continue
        }
        throw err
      }

      const after = bot.blockAt?.(toBlockVec3(target))
      if (!after || AIR_BLOCKS.has(after.name)) {
        return ok('block_cleared', {
          position: target,
          blockName: block.name,
          selectedTool: toolSelection?.itemName || bot.heldItem?.name || 'unknown',
          temporary: options.temporary === true,
          attempts: attempt
        })
      }
      lastClearError = new Error(`clear_failed:not_empty:${after.name}`)
      if (attempt < maxClearAttempts && isRetryableClearError(lastClearError)) {
        context.logger?.log?.(`[BUILD_CLEAR_RETRY] target=${formatPos(target)} block=${after.name} attempt=${attempt + 1} reason=${lastClearError.message}`)
        await sleep(options.clearRetryDelayMs ?? 250)
        continue
      }
      break
    }
    return fail(lastClearError?.message || 'clear_failed')
  } catch (err) {
    return fail(err.message)
  } finally {
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
  }
}

function isTargetNotEmptyPlacementCheck(check) {
  return check?.ok === true &&
    check.data?.canPlace === false &&
    /^target_not_empty:/.test(String(check.data?.reason || ''))
}

function canRepairObstructedTarget(options = {}) {
  return options.repairObstructedTarget === true || options.clearObstructedTarget === true
}

async function repairObstructedTargetForPlacement(context, target, blockName, params = {}) {
  const { lockOwner, options = {}, stage = 'pre_place' } = params
  const bot = context?.bot
  const current = bot?.blockAt?.(toBlockVec3(target))
  const canDecorateExistingPot = isPottedBlockName(blockName) && current?.name === 'flower_pot'
  if (!current || AIR_BLOCKS.has(current.name) || canDecorateExistingPot) {
    return ok('placement_target_ready', { position: target, stage })
  }
  if (isReplaceablePlacementTarget(current.name, blockName)) {
    return ok('placement_target_replaceable', {
      blockName,
      current: current.name,
      position: target,
      stage
    })
  }
  if (placementBlockNameMatches(current.name, blockName, placementStates(options))) {
    if (isCandleStackExtensionTarget(current, blockName, placementStates(options))) {
      return ok('placement_target_ready', {
        blockName,
        candleStackExtension: true,
        position: target,
        stage
      })
    }
    const stateMismatch = expectedPlacementStateMismatch(current, blockName, options)
    if (!stateMismatch) {
      return ok('placement_target_already_correct', {
        alreadyCorrect: true,
        blockName,
        position: target,
        stage
      })
    }
  }
  if (!canRepairObstructedTarget(options)) return fail(`target_not_empty:${current.name}`)

  context.logger?.log?.(`[BUILD_PLACE_TARGET_REPAIR] target=${formatPos(target)} expected=${blockName} found=${current.name} stage=${stage}`)
  const cleared = await clearBlockForBuilding(context, target, {
    owner: lockOwner,
    holdLock: true,
    timeoutMs: options.timeoutMs ?? 15000,
    allowProtectedClearing: options.allowProtectedTargetRepair === true,
    reservedPositions: options.reservedPositions,
    reservedBounds: options.reservedBounds,
    preferOutsideReservedBounds: options.preferOutsideReservedBounds === true,
    temporary: isTemporaryReferenceName(current.name)
  })
  if (!cleared.ok) return fail(`target_repair_failed:${cleared.error || current.name}`)
  return ok('placement_target_repaired', {
    blockName,
    clearedBlock: current.name,
    position: target,
    stage
  })
}

async function placeBlock(context, position, blockName, options = {}) {
  const bot = context?.bot
  const target = normalizePosition(position)
  if (!bot?.entity) return fail('missing_bot')
  if (!target) return fail('missing_position')
  if (!blockName) return fail('missing_block_name')
  if (UNSAFE_BUILD_BLOCKS.has(blockName)) return fail(`unsafe_block:${blockName}`)
  if (typeof bot.placeBlock !== 'function') return fail('missing_placeBlock')

  // Stands that already move_timed-out within THIS call get their retry
  // moves capped instead of re-burning the full adaptive timeout: the L3
  // renovation log showed the same unreachable roof stand walked up to 5x
  // at full timeout per placement (~200s steps) before XZ-reach recovered.
  options = { ...options, standTimeoutMemo: options.standTimeoutMemo || new Set() }

  const lock = acquireActionLocks(context, ['movement', 'inventory', 'building'], 'placeBlock', options)
  if (!lock.ok) return fail(lock.error, lock)

  const verticalAccessScaffoldPositions = []
  const verticalAccessScaffoldKeys = new Set()
  let verticalAccessCleanupFailure = null
  try {
    if (blockName === 'dirt_path') {
      return await placeDirtPathBlock(context, target, {
        lockOwner: lock.owner,
        options
      })
    }

    const requestedStates = options.blockStates || options.states || options.orientation
    let check = canPlaceBlock(context, target, {
      owner: lock.owner,
      holdLock: true,
      blockName,
      blockStates: requestedStates
    })
    if (isTargetNotEmptyPlacementCheck(check) && canRepairObstructedTarget(options)) {
      const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
        lockOwner: lock.owner,
        options,
        stage: 'initial_check'
      })
      if (!repaired.ok) return repaired
      check = canPlaceBlock(context, target, {
        owner: lock.owner,
        holdLock: true,
        blockName,
        blockStates: requestedStates
      })
    }
    if (!check.ok) return check
    if (check.data?.alreadyCorrect === true) {
      return ok('block_already_placed', {
        alreadyCorrect: true,
        blockName,
        actualBlockName: check.data.currentBlockName || blockName,
        position: target
      })
    }
    const missingInitialReference = check.data?.reason === 'no_support_block'
    if (!check.data.canPlace && !missingInitialReference) return fail(check.data.reason)
    const deferInitialMoveForTemporaryReference =
      missingInitialReference &&
      canUseTemporaryPlacementReference(blockName, requestedStates, options)
    const deferInitialMoveForStatefulReference =
      !missingInitialReference &&
      canDeferInitialMoveForStatefulReference(context, target, blockName, requestedStates, options)

    const placeDistance = options.placeDistance ?? 4.5
    const fluidPlacement = isFluidBlockName(blockName)
    // A successful placement ultimately clicks a reference block, not the
    // empty target cell. Preserve the reference that made the initial check
    // succeed so controlled access can rank stands by real interaction
    // margin. This matters near the edge of reach: GoalNear may legally stop
    // short of the nominal stand, leaving a target-center-reachable route
    // unable to click its actual reference.
    const strictPlacementReferencePosition = check.data?.referencePosition || null
    let safeApproachCandidates = findSafePlacementStandPositions(context, target, placeDistance, {
      reservedPositions: options.reservedPositions,
      reservedBounds: options.reservedBounds,
      preferOutsideReservedBounds: options.preferOutsideReservedBounds === true,
      preferHighStand: options.preferHighStand === true,
      allowReservedAirStand: options.allowReservedAirStand === true,
      minimumPlacementStandY: options.minimumPlacementStandY,
      minHorizontalDistance: options.minHorizontalDistance
    })
    if (strictPlacementReferencePosition) {
      safeApproachCandidates = safeApproachCandidates.filter(stand =>
        isStrictReferenceReachableFromStand(stand, strictPlacementReferencePosition, placeDistance)
      )
    }
    const currentReachCanPlaceHighTarget =
      (options.preferHighStand !== true && isPlacementReachable(bot, target, placeDistance)) ||
      canUseCurrentReachForHighTarget(bot, target, placeDistance, options) ||
      canUseCurrentReferenceForHighTarget(context, target, blockName, placeDistance, options) ||
      canUseCurrentReferenceForStatefulTarget(context, target, blockName, placeDistance, options)
    const shouldPlanExistingStandRecovery =
      options.planExistingPlacementStandAccess === true &&
      safeApproachCandidates.length > 0 &&
      currentReachCanPlaceHighTarget !== true
    if (shouldPlanExistingStandRecovery || shouldPlanControlledVerticalAccess(context, target, safeApproachCandidates, currentReachCanPlaceHighTarget, options, {
      deferInitialMoveForStatefulReference,
      deferInitialMoveForTemporaryReference
    })) {
      const plannedAccess = await planControlledVerticalAccess(context, target, placeDistance, {
        ...options,
        strictPlacementReferencePosition,
        verticalAccessGeneratedCandidateFallback: shouldPlanExistingStandRecovery,
        verticalAccessCandidateStands: shouldPlanExistingStandRecovery
          ? safeApproachCandidates
          : undefined
      })
      if (!plannedAccess.ok) return plannedAccess
      safeApproachCandidates = plannedAccess.data.stands
      options = {
        ...options,
        controlledVerticalAccessPlans: new Map(plannedAccess.data.plans.map(plan => [
          formatPos(plan.stand),
          plan.scaffoldPositions
        ])),
        requireReachablePlacementAfterStandMove: true,
        requireStrictPlacementReferenceReachAfterStandMove: true
      }
    }
    if (options.trackVerticalAccessScaffolds === true || options.controlledVerticalAccessPlans instanceof Map) {
      const existingScaffoldCallback = options.onScaffoldPlaced
      const existingScaffoldCleanupCallback = options.onControlledVerticalAccessScaffoldsCleaned
      options = {
        ...options,
        onScaffoldPlaced(position, placedName) {
          existingScaffoldCallback?.(position, placedName)
          const key = formatPos(position)
          if (verticalAccessScaffoldKeys.has(key)) return
          verticalAccessScaffoldKeys.add(key)
          verticalAccessScaffoldPositions.push(position)
          context.logger?.log?.(
            `[BUILD_VERTICAL_ACCESS_SCAFFOLD_PLACED] target=${formatPos(target)} ` +
            `position=${key} block=${placedName || 'unknown'}`
          )
        },
        onControlledVerticalAccessScaffoldsCleaned(positions) {
          existingScaffoldCleanupCallback?.(positions)
          const cleanedKeys = new Set((positions || []).map(formatPos))
          for (const key of cleanedKeys) verticalAccessScaffoldKeys.delete(key)
          for (let index = verticalAccessScaffoldPositions.length - 1; index >= 0; index--) {
            if (cleanedKeys.has(formatPos(verticalAccessScaffoldPositions[index]))) {
              verticalAccessScaffoldPositions.splice(index, 1)
            }
          }
        }
      }
    }
    let safeApproach = safeApproachCandidates[0] || null
    const shouldUseSafeApproach = !fluidPlacement && safeApproach && (
      options.forceSafeApproach === true
        ? !currentReachCanPlaceHighTarget
        : shouldAvoidTargetColumn(bot, target)
    )
    let moveTarget = shouldUseSafeApproach ? safeApproach : target
    if (fluidPlacement) {
      context.logger?.log?.(`[BUILD_INITIAL_MOVE_DEFERRED_FOR_FLUID_STANCE] target=${formatPos(target)} block=${blockName}`)
    } else if (deferInitialMoveForTemporaryReference) {
      context.logger?.log?.(`[BUILD_INITIAL_MOVE_DEFERRED_FOR_TEMP_REFERENCE] target=${formatPos(target)} block=${blockName}`)
    } else if (deferInitialMoveForStatefulReference) {
      context.logger?.log?.(`[BUILD_INITIAL_MOVE_DEFERRED_FOR_STATEFUL_REFERENCE] target=${formatPos(target)} block=${blockName}`)
    } else if (shouldUseSafeApproach || (!currentReachCanPlaceHighTarget && distance(bot.entity.position, target) > placeDistance) || botIntersectsBlock(bot, target)) {
      const moved = shouldUseSafeApproach
        ? await moveToFirstReachablePlacementStand(context, target, safeApproachCandidates, {
          owner: lock.owner,
          options,
          placeDistance,
          blockName,
          referencePosition: strictPlacementReferencePosition,
          reason: 'avoid_target_collision'
        })
        : await moveTo(context, moveTarget, {
          owner: lock.owner,
          range: options.moveRange ?? 2,
          timeoutMs: placementMoveTimeoutMs(bot, moveTarget, options),
          canDig: options.canDig ?? false,
          allowScaffolding: options.allowScaffolding === true,
          ...movementScaffoldExclusions(options, target),
          holdLock: true
        })
      if (!moved.ok) {
        const recoveredReach = recoverPlacementReachAfterMoveFailure(context, target, blockName, placeDistance, options, moved)
        if (!recoveredReach.ok) return moved
        context.logger?.log?.(`[BUILD_MOVE_TIMEOUT_REACH_RECOVERED] target=${formatPos(target)} reason=${recoveredReach.reason}`)
      }
      if (shouldUseSafeApproach && moved.data?.standPosition) {
        safeApproach = moved.data.standPosition
        moveTarget = safeApproach
      }
    }

    if (botIntersectsBlock(bot, target)) {
      const reservedEscapeApproach = findSafePlacementStandPosition(context, target, placeDistance, {
        reservedPositions: options.reservedPositions,
        reservedBounds: options.reservedBounds,
        preferOutsideReservedBounds: options.preferOutsideReservedBounds === true,
        minHorizontalDistance: 2
      })
      const footprintEscapeApproach = reservedEscapeApproach ? null : findSafePlacementStandPosition(context, target, placeDistance, {
        minHorizontalDistance: 2
      })
      const escapeApproach = reservedEscapeApproach || footprintEscapeApproach || safeApproach
      if (!escapeApproach) return fail('placement_target_occupied')
      const escapeReason = footprintEscapeApproach ? 'target_occupied_footprint_escape' : 'target_occupied'
      context.logger?.log?.(`[BUILD_PLACE_REPOSITION] target=${formatPos(target)} stand=${formatPos(escapeApproach)} reason=${escapeReason}`)
      const moved = await moveTo(context, escapeApproach, {
        owner: lock.owner,
        range: Math.min(safeMoveRangeForStand(escapeApproach, target, options), options.escapeMoveRange ?? 0.2),
        timeoutMs: placementMoveTimeoutMs(bot, escapeApproach, options),
        canDig: options.canDig ?? false,
        allowScaffolding: options.allowScaffolding === true,
        ...movementScaffoldExclusions(options, target),
        holdLock: true
      })
      if (!moved.ok) return moved
      if (botIntersectsBlock(bot, target)) return fail('placement_target_occupied')
    }

    const targetReady = await repairObstructedTargetForPlacement(context, target, blockName, {
      lockOwner: lock.owner,
      options,
      stage: 'post_move'
    })
    if (!targetReady.ok) return targetReady
    if (targetReady.data?.alreadyCorrect) {
      return ok('block_already_placed', {
        blockName,
        position: target,
        referencePosition: null,
        attempts: 0
      })
    }

    const equipped = await equipBlockForPlacement(context, blockName, options)
    if (!equipped.ok) return equipped

    if (fluidPlacement) {
      const targetCellPlacement = await placeFluidFromTargetCell(context, target, blockName, {
        lockOwner: lock.owner,
        options
      })
      if (targetCellPlacement.ok) return targetCellPlacement
      if (targetCellPlacement.error !== 'fluid_target_cell_not_applicable') {
        return targetCellPlacement
      }
    }

    let references = findReferenceBlocksForPlacement(context, target, blockName, options.blockStates || options.states || options.orientation)
    let temporaryReference = null

    if (isPottedBlockName(blockName)) {
      return placePottedBlock(context, {
        blockName,
        lockOwner: lock.owner,
        options,
        references,
        target
      })
    }

    const candleStack = await tryPlaceCandleStack(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      references,
      target
    })
    if (candleStack.ok) return candleStack
    if (candleStack.error !== 'candle_stack_not_applicable') return candleStack

    const hangingLantern = await tryPlaceHangingLantern(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      references,
      target
    })
    if (hangingLantern.ok) return hangingLantern
    if (hangingLantern.error !== 'hanging_lantern_not_applicable') return hangingLantern

    const topHalfStair = await tryPlaceTopHalfStair(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      placeDistance,
      references,
      target
    })
    if (topHalfStair.ok) return topHalfStair
    if (topHalfStair.error !== 'top_half_stair_not_applicable') return topHalfStair

    const doubleSlab = await tryPlaceDoubleSlab(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      references,
      target
    })
    if (doubleSlab.ok) return doubleSlab
    if (doubleSlab.error !== 'double_slab_not_applicable') return doubleSlab

    const fenceGate = await tryPlaceFenceGateWithFacing(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      placeDistance,
      references,
      target
    })
    if (fenceGate.ok) return fenceGate
    if (fenceGate.error !== 'fence_gate_not_applicable') return fenceGate

    const door = await tryPlaceDoorWithFacing(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      placeDistance,
      references,
      target
    })
    if (door.ok) return door
    if (door.error !== 'door_not_applicable') return door

    const furnaceLike = await tryPlaceFurnaceLikeWithFacing(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      placeDistance,
      references,
      target
    })
    if (furnaceLike.ok) return furnaceLike
    if (furnaceLike.error !== 'furnace_like_not_applicable') return furnaceLike

    let statefulBlock = await tryPlaceStatefulBlock(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      placeDistance,
      references,
      target
    })
    if (statefulBlock.ok) return statefulBlock
    if (canRetryStatefulWithTemporaryReference(blockName, statefulBlock.error)) {
      const ensuredReference = await ensureTemporaryPlacementReference(context, {
        blockName,
        lockOwner: lock.owner,
        options,
        target
      })
      if (!ensuredReference.ok) {
        // Diagnostics only (building lane round 13): the failure reason used to
        // live solely in data.temporaryReferenceError, so live logs showed just
        // stateful_axis_no_*_reference with no trace of the temp column attempt.
        const failedStates = placementStates(options)
        const failedCandidates = temporaryPlacementReferenceCandidates(target, {
          ...options,
          blockName,
          blockStates: failedStates
        })
        context.logger?.log?.(`[BUILD_TEMP_REFERENCE_FAILED] target=${formatPos(target)} block=${blockName} axis=${failedStates?.axis ?? 'none'} error=${statefulBlock.error} reason=${ensuredReference.error || 'unknown'} candidates=${failedCandidates.map(formatPos).join(';') || 'none'}`)
        // axis blocks keep the original stateful error (callers and tests
        // key on stateful_axis_no_*_reference; the temp attempt is best-effort)
        if (isAxisBlockName(blockName)) {
          return {
            ...statefulBlock,
            data: { ...(statefulBlock.data || {}), temporaryReferenceError: ensuredReference.error || null }
          }
        }
        return ensuredReference
      }
      temporaryReference = ensuredReference.data || null
      references = findReferenceBlocksForPlacement(context, target, blockName, options.blockStates || options.states || options.orientation)
      if (!references.length && temporaryReference?.reference) references = [temporaryReference.reference]
      statefulBlock = await tryPlaceStatefulBlock(context, {
        blockName,
        lockOwner: lock.owner,
        options,
        placeDistance,
        references,
        target
      })
      const cleanup = await clearTemporaryPlacementReference(context, temporaryReference, {
        lockOwner: lock.owner,
        options
      })
      if (!cleanup.ok) return cleanup
      if (statefulBlock.ok) {
        return {
          ...statefulBlock,
          data: {
            ...(statefulBlock.data || {}),
            temporaryReference: temporaryReference?.positions || []
          }
        }
      }
    }
    if (statefulBlock.error !== 'stateful_block_not_applicable') return statefulBlock

    if (!references.length) {
      if (requiresGroundSupportPlacement(blockName)) return fail('no_support_block')
      const ensuredReference = await ensureTemporaryPlacementReference(context, {
        blockName,
        lockOwner: lock.owner,
        options,
        target
      })
      if (!ensuredReference.ok) return fail(ensuredReference.error || 'no_support_block')
      temporaryReference = ensuredReference.data || null
      references = findReferenceBlocksForPlacement(context, target, blockName, options.blockStates || options.states || options.orientation)
      if (!references.length && temporaryReference?.reference) references = [temporaryReference.reference]
      if (!references.length) return fail('no_support_block')
    }

    // 后勤 16（决策 #78）：施工单点名了「必须点哪一格」就照办。
    // 那一格空着且声明要求垫砖时，先走现成的临时参照链垫一块（拆由现成的
    // clearTemporaryPlacementReference 负责，本轮未动清除侧）。
    const clickedFace = clickedFacePlacementRequest(options)
    if (clickedFace) {
      if (
        clickedFace.temporaryPosition &&
        !temporaryReference &&
        !clickedFaceReferenceStanding(context, clickedFace, blockName, requestedStates)
      ) {
        const ensuredClickedFace = await ensureTemporaryPlacementReference(context, {
          blockName,
          lockOwner: lock.owner,
          options,
          target,
          requiredPosition: clickedFace.temporaryPosition
        })
        if (ensuredClickedFace.ok) {
          temporaryReference = ensuredClickedFace.data || null
          references = findReferenceBlocksForPlacement(context, target, blockName, requestedStates)
          if (!references.length && temporaryReference?.reference) references = [temporaryReference.reference]
        } else {
          context.logger?.log?.(
            `[BUILD_CLICKED_FACE_TEMP_REFERENCE_FAILED] target=${formatPos(target)} ` +
            `reference=${formatPos(clickedFace.temporaryPosition)} reason=${ensuredClickedFace.error || 'unknown'}`
          )
        }
      }
      references = orderReferencesForClickedFace(context, references, clickedFace, target)
    }

    let lastError = null
    const maxAttemptsPerReference = placementAttemptsForBlock(blockName, options)
    for (const reference of references) {
      for (let attempt = 1; attempt <= maxAttemptsPerReference; attempt++) {
        if (attempt > 1) {
          const ready = await ensurePlacementReach(context, {
            lockOwner: lock.owner,
            moveTarget,
            safeApproach,
            safeApproachCandidates,
            shouldUseSafeApproach,
            target,
            placeDistance,
            options,
            forceReposition: isPlacementRetryableError(lastError)
          })
          if (!ready.ok) {
            lastError = new Error(ready.error || 'placement_reposition_failed')
            break
          }
        }

        try {
          const held = await equipBlockForPlacement(context, blockName, options)
          if (!held.ok) {
            lastError = new Error(held.error || 'block_equip_failed')
            break
          }
          const oriented = await orientBotForPlacement(context, target, blockName, options.blockStates || options.states || options.orientation)
          if (!oriented.ok) {
            lastError = new Error(oriented.error || 'placement_orientation_failed')
            break
          }
          if (clickedFace) {
            const faceVector = getFaceVector(reference.position, target)
            context.logger?.log?.(
              `[BUILD_CLICKED_FACE_PLACE] target=${formatPos(target)} ` +
              `reference=${formatPos(reference.position)} face=${faceNameForVector(faceVector)} ` +
              `wanted=${clickedFace.face || 'unknown'} ` +
              `temporary=${(temporaryReference?.positions || []).some(position => sameBlockPos(position, clickedFace.position))}`
            )
          }
          await placeBlockAgainstReference(context, reference, target, blockName, options)
          const after = bot.blockAt?.(toBlockVec3(target))
          if (placementBlockNameMatches(after?.name, blockName, requestedStates) || shouldWaitForServerPlacement(blockName, options)) {
            const stable = await confirmPlacedBlock(context, target, blockName, options)
            if (!stable.ok) {
              lastError = new Error(stable.error || 'place_failed:not_stable')
              if (attempt < maxAttemptsPerReference && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
                const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
                  lockOwner: lock.owner,
                  options,
                  stage: 'retry_unstable_wrong_block'
                })
                if (!repaired.ok) return repaired
                context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
                await sleep(options.retryDelayMs ?? 250)
                continue
              }
              if (attempt < maxAttemptsPerReference) {
                context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
                await sleep(options.retryDelayMs ?? 250)
                continue
              }
              break
            }
            const cleanup = await clearTemporaryPlacementReference(context, temporaryReference, {
              lockOwner: lock.owner,
              options
            })
            if (!cleanup.ok) return cleanup
            return ok(attempt > 1 ? 'block_placed_after_retry' : 'block_placed', {
              blockName,
              position: target,
              referencePosition: reference.position,
              attempts: attempt,
              temporaryReference: temporaryReference?.positions || []
            })
          }
          lastError = new Error(after && !AIR_BLOCKS.has(after.name)
            ? `placed_wrong_block:${after.name}`
            : 'place_failed:not_changed')
          if (attempt < maxAttemptsPerReference && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
            const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
              lockOwner: lock.owner,
              options,
              stage: 'retry_wrong_block'
            })
            if (!repaired.ok) return repaired
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          if (attempt < maxAttemptsPerReference && isPlacementRetryableError(lastError)) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        } catch (err) {
          const stableAfterTimeout = await confirmPlacedBlock(context, target, blockName, options)
          if (stableAfterTimeout.ok) {
            const cleanup = await clearTemporaryPlacementReference(context, temporaryReference, {
              lockOwner: lock.owner,
              options
            })
            if (!cleanup.ok) return cleanup
            return ok('block_placed_after_timeout', {
              blockName,
              position: target,
              referencePosition: reference.position,
              recoveredFrom: err.message,
              attempts: attempt,
              temporaryReference: temporaryReference?.positions || []
            })
          }
          lastError = new Error(stableAfterTimeout.error || err.message || String(err))
          if (attempt < maxAttemptsPerReference && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
            const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
              lockOwner: lock.owner,
              options,
              stage: 'retry_unstable_wrong_block'
            })
            if (!repaired.ok) return repaired
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          if (attempt < maxAttemptsPerReference && isHeldItemPlacementError(err)) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${err.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          if (attempt < maxAttemptsPerReference && isPlacementRetryableError(lastError)) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
      }
    }
    const bedFallback = await tryPlaceBedPairFallback(context, {
      blockName,
      lockOwner: lock.owner,
      options,
      placeDistance,
      states: options.blockStates || options.states || options.orientation,
      target
    })
    if (bedFallback.ok) return bedFallback
    const cleanup = await clearTemporaryPlacementReference(context, temporaryReference, {
      lockOwner: lock.owner,
      options
    })
    if (!cleanup.ok) return cleanup
    return fail(lastError?.message || 'place_failed')
  } catch (err) {
    return fail(err.message)
  } finally {
    if (verticalAccessScaffoldPositions.length > 0) {
      try {
        const cleanup = await clearTemporaryPlacementReference(context, {
          positions: verticalAccessScaffoldPositions
        }, {
          lockOwner: lock.owner,
          options,
          settleAfterSupportClear: true,
          stopMovementBeforeClear: true,
          movementStopReason: 'vertical_access_cleanup'
        })
        if (!cleanup.ok) {
          verticalAccessCleanupFailure = cleanup
        } else {
          context.logger?.log?.(
            `[BUILD_VERTICAL_ACCESS_CLEANUP] target=${formatPos(target)} ` +
            `positions=${verticalAccessScaffoldPositions.map(formatPos).join('|')}`
          )
        }
      } catch (err) {
        verticalAccessCleanupFailure = fail(err?.message || String(err))
      }
    }
    releaseActionLocks(context, lock.owner)
    if (verticalAccessCleanupFailure) {
      return fail(`vertical_access_cleanup_failed:${verticalAccessCleanupFailure.error || 'unknown'}`, {
        positions: verticalAccessScaffoldPositions
      })
    }
  }
}

async function placeDirtPathBlock(context, target, params = {}) {
  const { lockOwner, options = {} } = params
  const bot = context?.bot
  const canActivateBase = typeof bot?.activateBlock === 'function'
  if (!buildActionShouldContinue(options)) return fail('task_interrupted')

  let current = bot.blockAt?.(toBlockVec3(target))
  if (current?.name === 'dirt_path') {
    return ok('dirt_path_already_placed', { blockName: 'dirt_path', position: target })
  }

  if (!current || AIR_BLOCKS.has(current.name)) {
    const direct = await tryPlaceDirectDirtPathItem(context, target, {
      lockOwner,
      options
    })
    if (direct.ok) return direct
    if (direct.error === 'task_interrupted' || !buildActionShouldContinue(options)) return fail('task_interrupted')
    context.logger?.log?.(`[BUILD_DIRT_PATH_ITEM_FALLBACK] target=${formatPos(target)} reason=${direct.error || 'unavailable'}`)
    if (!canActivateBase) return fail('missing_activateBlock')
    const base = await placeDirtPathBaseBlock(context, target, {
      lockOwner,
      options
    })
    if (!buildActionShouldContinue(options)) return fail('task_interrupted')
    if (!base.ok) return base
    current = bot.blockAt?.(toBlockVec3(target))
  } else if (!DIRT_PATH_BASE_BLOCKS.has(current.name)) {
    if (!canRepairObstructedTarget(options)) return fail(`dirt_path_target_not_convertible:${current.name}`)
    const repaired = await repairObstructedTargetForPlacement(context, target, 'dirt', {
      lockOwner,
      options,
      stage: 'dirt_path_base_repair'
    })
    if (!repaired.ok) return repaired
    const base = await placeDirtPathBaseBlock(context, target, {
      lockOwner,
      options
    })
    if (!base.ok) return base
    current = bot.blockAt?.(toBlockVec3(target))
  }

  const maxAttempts = Math.max(1, Number(options.dirtPathActivationAttempts ?? 2))
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!buildActionShouldContinue(options)) return fail('task_interrupted')
    current = bot.blockAt?.(toBlockVec3(target))
    if (current?.name === 'dirt_path') {
      return ok('dirt_path_already_placed', { blockName: 'dirt_path', position: target, attempts: attempt })
    }
    if (!current || AIR_BLOCKS.has(current.name)) {
      const direct = await tryPlaceDirectDirtPathItem(context, target, {
        lockOwner,
        options
      })
      if (direct.ok) return direct
      if (direct.error === 'task_interrupted' || !buildActionShouldContinue(options)) return fail('task_interrupted')
      context.logger?.log?.(`[BUILD_DIRT_PATH_ITEM_FALLBACK] target=${formatPos(target)} reason=${direct.error || 'unavailable'}`)
      if (!canActivateBase) return fail('missing_activateBlock')
      const base = await placeDirtPathBaseBlock(context, target, {
        lockOwner,
        options
      })
      if (!buildActionShouldContinue(options)) return fail('task_interrupted')
      if (!base.ok) return base
      current = bot.blockAt?.(toBlockVec3(target))
    }
    if (!DIRT_PATH_BASE_BLOCKS.has(current?.name)) {
      return fail(`dirt_path_base_not_ready:${current?.name || 'air'}`)
    }

    const topClear = await ensureDirtPathTopClear(context, target, {
      lockOwner,
      options
    })
    if (!buildActionShouldContinue(options)) return fail('task_interrupted')
    if (!topClear.ok) return topClear

    const placeDistance = options.placeDistance ?? 4.5
    if (!isPlacementReachable(bot, target, placeDistance) || botIntersectsBlock(bot, target)) {
      const stands = findSafePlacementStandPositions(context, target, placeDistance, {
        reservedPositions: options.reservedPositions,
        reservedBounds: options.reservedBounds,
        preferOutsideReservedBounds: options.preferOutsideReservedBounds === true
      })
      const moved = await moveToFirstReachablePlacementStand(context, target, stands, {
        owner: lockOwner,
        options,
        placeDistance,
        reason: 'dirt_path_shovel'
      })
      if (!moved.ok) return moved
      if (!buildActionShouldContinue(options)) return fail('task_interrupted')
    }

    const equipped = await equipShovelForDirtPath(context, { owner: lockOwner })
    if (!equipped.ok) return equipped
    if (!buildActionShouldContinue(options)) return fail('task_interrupted')

    current = bot.blockAt?.(toBlockVec3(target))
    if (!DIRT_PATH_BASE_BLOCKS.has(current?.name)) {
      lastError = `dirt_path_base_not_ready:${current?.name || 'air'}`
    } else {
      context.logger?.log?.(`[BUILD_DIRT_PATH_CREATE] target=${formatPos(target)} base=${current.name} tool=${bot.heldItem?.name || 'unknown'} attempt=${attempt}`)
      const activated = await activateDirtPathBase(context, current, target, options)
      const stable = activated.ok
        ? await confirmPlacedBlock(context, target, 'dirt_path', {
            ...options,
            requireServerConfirmation: true,
            stableConfirmDelayMs: options.dirtPathConfirmDelayMs ?? options.stableConfirmDelayMs ?? 220
          })
        : activated
      if (stable.ok) {
        return ok(attempt > 1 ? 'dirt_path_created_after_retry' : 'dirt_path_created', {
          blockName: 'dirt_path',
          position: target,
          baseBlock: current.name,
          tool: bot.heldItem?.name || equipped.data?.itemName || 'unknown',
          attempts: attempt
        })
      }
      lastError = stable.error || 'dirt_path_not_stable'
    }

    if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
      context.logger?.log?.(`[BUILD_DIRT_PATH_RETRY] target=${formatPos(target)} attempt=${attempt + 1} reason=${lastError}`)
      await sleep(options.retryDelayMs ?? 250)
      continue
    }
    break
  }

  return fail(lastError || 'dirt_path_not_stable')
}

async function tryPlaceDirectDirtPathItem(context, target, params = {}) {
  const { lockOwner, options = {} } = params
  const bot = context?.bot
  if (options.disableDirectDirtPathItemPlacement === true) return fail('dirt_path_item_disabled')
  if (!bot?.inventory?.items || typeof bot?.placeBlock !== 'function') return fail('dirt_path_item_unavailable')

  let current = bot.blockAt?.(toBlockVec3(target))
  if (current?.name === 'dirt_path') {
    return ok('dirt_path_already_placed', { blockName: 'dirt_path', position: target })
  }
  if (current && !AIR_BLOCKS.has(current.name)) return fail(`dirt_path_item_target_occupied:${current.name}`)

  const itemReady = await ensureDirectDirtPathItem(context, {
    owner: lockOwner || options.owner || options.taskId || 'dirt_path_item',
    options
  })
  if (!itemReady.ok) return itemReady

  const equipped = await equipPlacementItemWithRetry(context, 'dirt_path', itemReady.data?.item)
  if (!equipped.ok) return fail(`dirt_path_item_equip_failed:${equipped.error || 'unknown'}`, equipped)

  const topClear = await ensureDirtPathTopClear(context, target, {
    lockOwner,
    options
  })
  if (!topClear.ok) return topClear

  const placeDistance = options.placeDistance ?? 4.5
  if (!isPlacementReachable(bot, target, placeDistance) || botIntersectsBlock(bot, target)) {
    const stands = findSafePlacementStandPositions(context, target, placeDistance, {
      reservedPositions: options.reservedPositions,
      reservedBounds: options.reservedBounds,
      preferOutsideReservedBounds: options.preferOutsideReservedBounds === true
    })
    const moved = await moveToFirstReachablePlacementStand(context, target, stands, {
      owner: lockOwner,
      options,
      placeDistance,
      reason: 'dirt_path_item'
    })
    if (!moved.ok) return moved
  }

  const references = findReferenceBlocksForPlacement(context, target, 'dirt_path', null)
  if (!references.length) return fail('dirt_path_item_no_support')

  let lastError = null
  const maxAttempts = Math.max(1, Number(options.dirtPathItemPlacementAttempts ?? options.placementAttempts ?? 2))
  for (const reference of references) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await placeBlockAgainstReference(context, reference, target, 'dirt_path')
      } catch (err) {
        lastError = err
      }

      const stable = await confirmPlacedBlock(context, target, 'dirt_path', {
        ...options,
        requireServerConfirmation: true,
        stableConfirmDelayMs: options.dirtPathConfirmDelayMs ?? options.stableConfirmDelayMs ?? 220
      })
      if (stable.ok) {
        context.logger?.log?.(`[BUILD_DIRT_PATH_ITEM_PLACED] target=${formatPos(target)} source=${itemReady.data?.source || 'inventory'} attempt=${attempt}`)
        return ok('dirt_path_item_placed', {
          blockName: 'dirt_path',
          position: target,
          source: itemReady.data?.source || 'inventory',
          attempts: attempt
        })
      }

      lastError = new Error(stable.error || `dirt_path_item_not_stable:${bot.blockAt?.(toBlockVec3(target))?.name || 'air'}`)
      if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
        context.logger?.log?.(`[BUILD_DIRT_PATH_ITEM_RETRY] target=${formatPos(target)} attempt=${attempt + 1} reason=${lastError.message}`)
        await sleep(options.retryDelayMs ?? 250)
        continue
      }
      break
    }
  }

  return fail(lastError?.message || 'dirt_path_item_place_failed')
}

async function ensureDirectDirtPathItem(context, params = {}) {
  const bot = context?.bot
  const owner = params.owner || 'dirt_path_item'
  let item = bot?.inventory?.items?.().find(candidate => candidate?.name === 'dirt_path')
  if (item) return ok('dirt_path_item_available', { item, source: 'inventory' })

  // dirt_path has no normal survival item source. Keep direct placement for
  // explicitly supplied/creative inventory, but do not walk every storage
  // container looking for an unobtainable item before using dirt + shovel.
  if (params.options?.allowDirtPathItemStorageLookup !== true) {
    return fail('dirt_path_item_storage_lookup_disabled')
  }

  if (typeof params.options?.shouldContinue === 'function' && !params.options.shouldContinue()) {
    return fail('task_interrupted')
  }

  const storageSystem = context?.storageSystem || context?.autoPreparationSystem?.storageSystem
  if (!storageSystem || typeof storageSystem.takeItems !== 'function') {
    return fail('dirt_path_item_unavailable')
  }

  const missTtlMs = Math.max(0, Number(
    params.options?.dirtPathStorageMissTtlMs ?? DEFAULT_DIRT_PATH_STORAGE_MISS_TTL_MS
  ) || 0)
  const missKey = String(owner)
  let storageMisses = dirtPathStorageMissesByContext.get(context)
  if (!storageMisses) {
    storageMisses = new Map()
    dirtPathStorageMissesByContext.set(context, storageMisses)
  }
  const lastMissAt = storageMisses.get(missKey)
  if (missTtlMs > 0 && Number.isFinite(lastMissAt) && Date.now() - lastMissAt < missTtlMs) {
    const ageMs = Date.now() - lastMissAt
    context.logger?.log?.(
      `[BUILD_DIRT_PATH_ITEM_STORAGE_MISS_CACHED] owner=${missKey} ageMs=${ageMs} ttlMs=${missTtlMs}`
    )
    return fail('dirt_path_item_storage_miss_cached', { ageMs, missTtlMs })
  }

  const result = await storageSystem.takeItems(context, {
    itemName: 'dirt_path',
    count: 1,
    owner,
    shouldContinue: params.options?.shouldContinue
  })
  if (typeof params.options?.shouldContinue === 'function' && !params.options.shouldContinue()) {
    return fail('task_interrupted')
  }
  if (!result?.ok) {
    const reason = result?.reason || result?.error || 'unknown'
    if (/chest_item_not_found:dirt_path|dirt_path.*item_not_found/i.test(String(reason))) {
      storageMisses.set(missKey, Date.now())
    }
    return fail(`dirt_path_item_storage_failed:${reason}`, { result })
  }

  const count = await waitForInventoryItemCount(bot, 'dirt_path', 1, {
    timeoutMs: params.options?.dirtPathItemInventoryConfirmTimeoutMs ?? 1200,
    intervalMs: params.options?.dirtPathItemInventoryConfirmIntervalMs ?? 80
  })
  item = bot.inventory.items().find(candidate => candidate?.name === 'dirt_path')
  if (!item || count < 1) return fail(`dirt_path_item_storage_unconfirmed:${count}/1`, { result })
  storageMisses.delete(missKey)
  return ok('dirt_path_item_fetched', { item, source: 'storage', result })
}

async function waitForInventoryItemCount(bot, itemName, requiredCount, options = {}) {
  const required = Math.max(1, Number(requiredCount) || 1)
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 1200) || 0)
  const intervalMs = Math.max(25, Number(options.intervalMs ?? 80) || 80)
  const startedAt = Date.now()

  let count = inventoryItemCount(bot, itemName)
  while (count < required && Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs)
    count = inventoryItemCount(bot, itemName)
  }
  return count
}

function inventoryItemCount(bot, itemName) {
  return (bot?.inventory?.items?.() || [])
    .filter(item => item?.name === itemName)
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0)
}

async function activateDirtPathBase(context, baseBlock, target, options = {}) {
  const bot = context?.bot
  const topFace = new Vec3(0, 1, 0)
  const topCursor = new Vec3(0.5, 1, 0.5)
  let activateBlockError = null
  try {
    await bot.activateBlock(baseBlock, topFace, topCursor)
  } catch (err) {
    if (bot.blockAt?.(toBlockVec3(target))?.name === 'dirt_path') {
      context.logger?.log?.(`[BUILD_DIRT_PATH_BLOCKUPDATE_RECOVERED] target=${formatPos(target)} method=activateBlock`)
      return ok('dirt_path_blockupdate_recovered')
    }
    if (!isPlacementRetryableError(err)) return fail(err.message || String(err))
    activateBlockError = err
    context.logger?.log?.(`[BUILD_DIRT_PATH_ACTIVATE_BLOCK_RETRY] target=${formatPos(target)} reason=${err.message || err}`)
  }
  if (bot.blockAt?.(toBlockVec3(target))?.name === 'dirt_path') return ok('dirt_path_activate_block')

  await sleep(options.dirtPathActivationDelayMs ?? 120)
  if (bot.blockAt?.(toBlockVec3(target))?.name === 'dirt_path') return ok('dirt_path_activate_block_delayed')

  if (typeof bot.activateItem === 'function' && typeof bot.lookAt === 'function') {
    const lookTarget = new Vec3(target.x + 0.5, target.y + 1, target.z + 0.5)
    context.logger?.log?.(`[BUILD_DIRT_PATH_ACTIVATE_ITEM] target=${formatPos(target)} base=${baseBlock.name}`)
    await bot.lookAt(lookTarget, true)
    await bot.activateItem()
    await sleep(options.dirtPathFallbackDelayMs ?? 220)
    if (bot.blockAt?.(toBlockVec3(target))?.name === 'dirt_path') return ok('dirt_path_activate_item')
  }
  if (activateBlockError) return fail(activateBlockError.message || String(activateBlockError))
  return fail('dirt_path_activation_not_changed')
}

async function ensureDirtPathTopClear(context, target, params = {}) {
  const { lockOwner, options = {} } = params
  const bot = context?.bot
  const aboveTarget = { x: target.x, y: target.y + 1, z: target.z }
  let above = bot?.blockAt?.(toBlockVec3(aboveTarget))
  if (!above || AIR_BLOCKS.has(above.name)) {
    return ok('dirt_path_top_clear', { position: aboveTarget })
  }
  if (!canRepairObstructedTarget(options)) {
    return fail(`dirt_path_blocked_above:${above.name}`)
  }

  context.logger?.log?.(`[BUILD_DIRT_PATH_CLEAR_ABOVE] target=${formatPos(target)} above=${formatPos(aboveTarget)} block=${above.name}`)
  const cleared = await clearBlockForBuilding(context, aboveTarget, {
    ...options,
    owner: lockOwner,
    holdLock: true,
    allowProtectedClearing: false,
    temporary: true
  })
  if (!cleared.ok) return fail(`dirt_path_clear_above_failed:${cleared.error || 'unknown'}`)

  above = bot?.blockAt?.(toBlockVec3(aboveTarget))
  if (above && !AIR_BLOCKS.has(above.name)) {
    return fail(`dirt_path_blocked_above:${above.name}`)
  }
  return ok('dirt_path_top_cleared', { position: aboveTarget })
}

async function placeDirtPathBaseBlock(context, target, params = {}) {
  const { lockOwner, options = {} } = params
  const bot = context?.bot
  const current = bot?.blockAt?.(toBlockVec3(target))
  if (DIRT_PATH_BASE_BLOCKS.has(current?.name)) {
    return ok('dirt_path_base_already_ready', {
      position: target,
      blockName: current.name
    })
  }

  const equipped = await equipItemForPlacement(context, 'dirt', {
    blockName: 'dirt',
    owner: lockOwner,
    useEquipmentSystem: true
  })
  if (!equipped.ok) return fail(`dirt_path_base_item:${equipped.error || 'missing_dirt'}`)

  const placeDistance = options.placeDistance ?? 4.5
  if (!isPlacementReachable(bot, target, placeDistance) || botIntersectsBlock(bot, target)) {
    const stands = findSafePlacementStandPositions(context, target, placeDistance, {
      reservedPositions: options.reservedPositions,
      reservedBounds: options.reservedBounds,
      preferOutsideReservedBounds: options.preferOutsideReservedBounds === true
    })
    const moved = await moveToFirstReachablePlacementStand(context, target, stands, {
      owner: lockOwner,
      options,
      placeDistance,
      reason: 'dirt_path_base'
    })
    if (!moved.ok) return moved
  }

  const references = findReferenceBlocksForPlacement(context, target, 'dirt', null)
  if (!references.length) return fail('dirt_path_base_no_support')

  let lastError = null
  const maxAttempts = Math.max(1, Number(options.dirtPathBasePlacementAttempts ?? options.placementAttempts ?? 3))
  for (const reference of references) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await placeBlockAgainstReference(context, reference, target, 'dirt')
      } catch (err) {
        lastError = err
      }
      const after = bot.blockAt?.(toBlockVec3(target))
      if (DIRT_PATH_BASE_BLOCKS.has(after?.name)) {
        return ok('dirt_path_base_placed', {
          position: target,
          blockName: after.name,
          referencePosition: reference.position,
          attempts: attempt
        })
      }
      const stable = await confirmPlacedBlock(context, target, 'dirt', {
        ...options,
        requireServerConfirmation: true
      })
      if (stable.ok) {
        return ok('dirt_path_base_placed', {
          position: target,
          blockName: 'dirt',
          referencePosition: reference.position,
          attempts: attempt
        })
      }
      const delayed = await waitForBlockNameInSet(context, target, DIRT_PATH_BASE_BLOCKS, {
        timeoutMs: options.dirtPathBaseConfirmTimeoutMs ?? options.placementConfirmTimeoutMs ?? 1600,
        intervalMs: options.dirtPathBaseConfirmIntervalMs ?? options.placementConfirmIntervalMs ?? 80
      })
      if (delayed) {
        context.logger?.log?.(`[BUILD_DIRT_PATH_BASE_DELAYED] target=${formatPos(target)} block=${delayed.name} attempt=${attempt}`)
        return ok('dirt_path_base_placed_after_delay', {
          position: target,
          blockName: delayed.name,
          referencePosition: reference.position,
          attempts: attempt
        })
      }
      lastError = new Error(stable.error || `dirt_path_base_unstable:${after?.name || 'air'}`)
      if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
        context.logger?.log?.(`[BUILD_DIRT_PATH_BASE_RETRY] target=${formatPos(target)} attempt=${attempt + 1} reason=${lastError.message || lastError}`)
        await sleep(options.retryDelayMs ?? 250)
        continue
      }
      break
    }
  }

  return fail(lastError?.message || 'dirt_path_base_place_failed')
}

async function equipShovelForDirtPath(context, options = {}) {
  const bot = context?.bot
  if (!bot?.inventory?.items) return fail('missing_inventory')
  let shovel = findInventoryShovel(bot)
  if (!shovel) {
    const prepared = await prepareDirtPathShovel(context, options)
    if (!prepared.ok) return prepared
    shovel = findInventoryShovel(bot)
    if (!shovel) return fail(`path_shovel_prepare_unconfirmed:${prepared.data?.itemName || 'unknown'}`, prepared)
  }
  if (!shovel) return fail('missing_path_shovel')
  if (bot.heldItem?.name === shovel.name) {
    return ok('path_shovel_equipped', { itemName: shovel.name })
  }
  if (typeof bot.equip !== 'function') return fail(`path_shovel_not_held:${bot.heldItem?.name || 'empty'}:${shovel.name}`)
  const equipped = await equipPlacementItemWithRetry(context, shovel.name, shovel)
  if (!equipped.ok) return equipped
  return ok('path_shovel_equipped', { itemName: shovel.name })
}

function findInventoryShovel(bot) {
  const items = bot?.inventory?.items?.() || []
  return SHOVEL_TOOL_ORDER
    .map(name => items.find(item => item.name === name))
    .find(Boolean) ||
    items.find(item => /_shovel$/.test(String(item?.name || '')))
}

async function prepareDirtPathShovel(context, options = {}) {
  const autoPreparationSystem = context?.autoPreparationSystem
  if (typeof autoPreparationSystem?.ensureItem !== 'function') return fail('missing_path_shovel')

  let lastFailure = null
  for (const itemName of DIRT_PATH_SHOVEL_CRAFT_ORDER) {
    const result = await autoPreparationSystem.ensureItem(context, itemName, 1, {
      allowStorage: options.allowStorage !== false,
      owner: options.owner || options.taskId || 'dirt_path_shovel',
      purpose: 'dirt_path_shovel'
    })
    if (result?.ok) {
      context.logger?.log?.(`[BUILD_DIRT_PATH_SHOVEL_PREPARED] item=${itemName} reason=${result.reason || result.message || 'prepared'}`)
      return ok('path_shovel_prepared', { itemName, result })
    }
    const reason = result?.reason || result?.error || 'unknown'
    context.logger?.log?.(`[BUILD_DIRT_PATH_SHOVEL_PREPARE_FAILED] item=${itemName} reason=${reason}`)
    lastFailure = { itemName, result, reason }
  }

  return fail(`missing_path_shovel:${lastFailure?.itemName || 'none'}:${lastFailure?.reason || 'unprepared'}`, {
    lastFailure
  })
}

async function placePottedBlock(context, params = {}) {
  const { blockName, references = [], target, options = {} } = params
  const bot = context?.bot
  const plantItemName = plantItemNameForPottedBlock(blockName)
  if (!plantItemName) return fail(`unsupported_potted_block:${blockName}`)

  let potBlock = bot?.blockAt?.(toBlockVec3(target))
  let lastError = null
  if (potBlock?.name !== 'flower_pot' && potBlock?.name !== blockName) {
    const equippedPot = await equipBlockForPlacement(context, 'flower_pot', options)
    if (!equippedPot.ok) return equippedPot
    const maxAttempts = placementAttemptsForBlock('flower_pot', options)
    for (const reference of references) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const heldPot = await equipBlockForPlacement(context, 'flower_pot', options)
          if (!heldPot.ok) {
            lastError = new Error(heldPot.error || 'flower_pot_equip_failed')
            break
          }
          await placeBlockAgainstReference(context, reference, target, 'flower_pot')
          const stablePot = await confirmPlacedBlock(context, target, 'flower_pot', {
            ...options,
            requireServerConfirmation: true
          })
          if (stablePot.ok) {
            potBlock = bot.blockAt?.(toBlockVec3(target))
            break
          }
          lastError = new Error(stablePot.error || 'flower_pot_not_stable')
          if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=flower_pot attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        } catch (err) {
          lastError = err
          if (attempt < maxAttempts && (isHeldItemPlacementError(err) || isPlacementRetryableError(err))) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=flower_pot attempt=${attempt + 1} reason=${err.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
      }
      if (potBlock?.name === 'flower_pot') break
    }
  }

  if (potBlock?.name === blockName) {
    return ok('potted_block_already_placed', { blockName, position: target })
  }
  if (potBlock?.name !== 'flower_pot') {
    return fail(lastError?.message || `flower_pot_place_failed:${potBlock?.name || 'air'}`)
  }

  const equippedPlant = await equipItemForPlacement(context, plantItemName, {
    blockName,
    useEquipmentSystem: false
  })
  if (!equippedPlant.ok) return equippedPlant
  if (typeof bot.activateBlock !== 'function') return fail('missing_activateBlock')

  context.logger?.log?.(`[BUILD_POTTED_PLANT_ACTIVATE] target=${formatPos(target)} block=${blockName} plant=${plantItemName}`)
  await bot.activateBlock(potBlock)
  const stable = await confirmPlacedBlock(context, target, blockName, {
    ...options,
    requireServerConfirmation: true,
    stableConfirmDelayMs: options.pottedConfirmDelayMs ?? options.stableConfirmDelayMs ?? 220
  })
  if (!stable.ok) return fail(stable.error || 'potted_plant_not_stable')

  return ok('potted_block_placed', {
    blockName,
    itemName: plantItemName,
    position: target
  })
}

async function tryPlaceCandleStack(context, params = {}) {
  const { blockName, options = {}, references = [], target } = params
  const states = placementStates(options)
  const desiredCount = desiredCandleCount(states)
  if (!isCandleBlockName(blockName) || desiredCount == null || desiredCount <= 1) {
    return fail('candle_stack_not_applicable')
  }

  const bot = context?.bot
  if (!bot?.blockAt) return fail('missing_bot_blockAt')

  let current = bot.blockAt(toBlockVec3(target))
  let currentCount = current?.name === blockName ? candleCountFromBlock(current) : 0
  let referencePosition = null

  if (current?.name === blockName) {
    const nonStackMismatch = candleNonStackStateMismatch(current, states)
    if (nonStackMismatch) return fail(`place_failed:state_mismatch:${nonStackMismatch}`)
    if (currentCount > desiredCount) {
      return fail(`place_failed:state_mismatch:candles:${currentCount}!=${desiredCount}`)
    }
  }

  if (currentCount <= 0) {
    if (!references.length) return fail('no_support_block')
    let lastError = null
    const maxAttempts = placementAttemptsForBlock(blockName, options)

    for (const reference of references) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const held = await equipBlockForPlacement(context, blockName, options)
          if (!held.ok) return held
          context.logger?.log?.(`[BUILD_CANDLE_STACK_PLACE] target=${formatPos(target)} block=${blockName} desired=${desiredCount} reference=${formatPos(reference.position)}`)
          await placeBlockAgainstReference(context, reference, target, blockName, {
            ...options,
            requireStateConfirmation: false
          })
          const stable = await confirmPlacedBlock(context, target, blockName, {
            ...options,
            requireServerConfirmation: true,
            requireStateConfirmation: false
          })
          if (stable.ok) {
            current = bot.blockAt(toBlockVec3(target))
            currentCount = candleCountFromBlock(current)
            referencePosition = reference.position
            break
          }
          lastError = new Error(stable.error || 'candle_stack_first_place_unstable')
        } catch (err) {
          lastError = err
        }

        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
      if (currentCount > 0) break
    }

    if (currentCount <= 0) return fail(lastError?.message || 'candle_stack_first_place_failed')
  }

  if (currentCount === desiredCount) {
    const stable = await confirmPlacedBlock(context, target, blockName, {
      ...options,
      requireServerConfirmation: true,
      requireStateConfirmation: true
    })
    if (!stable.ok) return fail(stable.error || 'candle_stack_not_stable')
    return ok('candle_stack_already_placed', {
      blockName,
      candles: desiredCount,
      position: target,
      referencePosition
    })
  }

  if (typeof bot.activateBlock !== 'function') return fail('missing_activateBlock')

  while (currentCount < desiredCount) {
    const held = await equipBlockForPlacement(context, blockName, options)
    if (!held.ok) return held

    const beforeCount = currentCount
    context.logger?.log?.(`[BUILD_CANDLE_STACK_ADD] target=${formatPos(target)} block=${blockName} before=${beforeCount} desired=${desiredCount}`)
    try {
      await bot.activateBlock(current)
    } catch (err) {
      return fail(isHeldItemPlacementError(err) ? 'block_item_not_found' : (err.message || 'candle_stack_activate_failed'))
    }
    if (shouldWaitForServerPlacement(blockName, options)) {
      await sleep(options.candleStackConfirmDelayMs ?? options.stableConfirmDelayMs ?? 180)
    }

    current = bot.blockAt(toBlockVec3(target))
    if (current?.name !== blockName) {
      return fail(current && !AIR_BLOCKS.has(current.name)
        ? `place_failed:unstable:${current.name}`
        : 'place_failed:unstable_air')
    }
    currentCount = candleCountFromBlock(current)
    if (currentCount <= beforeCount) {
      return fail(`place_failed:state_mismatch:candles:${currentCount}!=${desiredCount}`)
    }
  }

  const stable = await confirmPlacedBlock(context, target, blockName, {
    ...options,
    requireServerConfirmation: true,
    requireStateConfirmation: true
  })
  if (!stable.ok) return fail(stable.error || 'candle_stack_not_stable')

  return ok('candle_stack_placed', {
    blockName,
    candles: desiredCount,
    position: target,
    referencePosition
  })
}

async function tryPlaceHangingLantern(context, params = {}) {
  const { blockName, lockOwner, options = {}, references = [], target } = params
  const states = placementStates(options)
  if (blockName !== 'lantern' || String(states?.hanging || '').toLowerCase() !== 'true') {
    return fail('hanging_lantern_not_applicable')
  }

  const bot = context?.bot
  if (typeof bot?.placeBlock !== 'function') {
    return fail('hanging_lantern_place_unavailable')
  }

  let topReference = references.find(reference => getFaceVector(reference.position, target).y === -1)
  if (!topReference) {
    const above = bot.blockAt?.(toBlockVec3({ x: target.x, y: target.y + 1, z: target.z }))
    if (isHangingLanternTopSupportBlock(above)) topReference = above
  }
  if (!topReference) return fail('hanging_lantern_no_top_support')

  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const liveReference = bot.blockAt?.(toBlockVec3(topReference.position)) || topReference
    if (!isHangingLanternTopSupportBlock(liveReference)) {
      return fail(`hanging_lantern_top_support_unavailable:${liveReference?.name || 'air'}`)
    }

    const held = await equipBlockForPlacement(context, blockName, options)
    if (!held.ok) return held

    context.logger?.log?.(`[BUILD_LANTERN_STATE_PLACE] target=${formatPos(target)} block=${blockName} hanging=true reference=${formatPos(liveReference.position)}`)
    try {
      await placeBlockAgainstReference(context, liveReference, target, blockName, options)
    } catch (err) {
      lastError = err
    }

    const stable = await confirmPlacedBlock(context, target, blockName, {
      ...options,
      requireServerConfirmation: true,
      requireStateConfirmation: true
    })
    if (stable.ok) {
      return ok(attempt > 1 ? 'hanging_lantern_placed_after_retry' : 'hanging_lantern_placed', {
        blockName,
        position: target,
        referencePosition: liveReference.position,
        attempts: attempt
      })
    }

    lastError = new Error(stable.error || lastError?.message || 'hanging_lantern_not_stable')
    if (isPlacementStateMismatchError(lastError)) {
      const cleared = await clearWrongStatePlacement(context, target, blockName, {
        lockOwner,
        options,
        reason: lastError.message
      })
      if (!cleared.ok) return cleared
      if (attempt < maxAttempts) {
        context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
        await sleep(options.retryDelayMs ?? 250)
        continue
      }
      break
    }
    if (isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
      const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
        lockOwner,
        options,
        stage: 'hanging_lantern_wrong_block'
      })
      if (!repaired.ok) return repaired
      if (attempt < maxAttempts) {
        context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
        await sleep(options.retryDelayMs ?? 250)
        continue
      }
      break
    }
    if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
      context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
      await sleep(options.retryDelayMs ?? 250)
      continue
    }
    break
  }

  return fail(lastError?.message || 'hanging_lantern_place_failed')
}

function isHangingLanternTopSupportBlock(block) {
  if (isPlacementReferenceBlock(block)) return true
  if (!block || AIR_BLOCKS.has(block.name)) return false
  if (!/trapdoor$/.test(String(block.name || ''))) return false
  const half = String(blockProperties(block).half || '').toLowerCase()
  return half === 'bottom'
}

async function tryPlaceTopHalfStair(context, params = {}) {
  const { blockName, lockOwner, options = {}, placeDistance = 4.5, references = [], target } = params
  const states = placementStates(options)
  if (!isStairBlockName(blockName) || (!states?.half && !states?.facing)) {
    return fail('top_half_stair_not_applicable')
  }
  const half = String(states?.half || 'bottom').toLowerCase()
  if (!['top', 'bottom'].includes(half)) {
    return fail('top_half_stair_not_applicable')
  }

  const bot = context?.bot
  if (typeof bot?._placeBlockWithOptions !== 'function') {
    return fail('stateful_stair_place_unavailable')
  }

  const sideReferences = references.filter(reference => getFaceVector(reference.position, target).y === 0)

  const facing = String(states.facing || '').toLowerCase()
  const facingOffset = horizontalOffsetForFacing(facing)
  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)

  let stairFacingStandFallback = null
  if (facingOffset) {
    const standReady = await moveToStairFacingStand(context, {
      facing,
      facingOffset,
      lockOwner,
      options,
      placeDistance,
      target
    })
    if (!standReady.ok) {
      const standError = String(standReady.error || '')
      const canUseReachFallback = standError.startsWith('stair_facing_stand_unavailable:') ||
        standError === 'move_timeout'
      if (!canUseReachFallback) return standReady
      stairFacingStandFallback = standReady
      context.logger?.log?.(`[BUILD_STAIR_FACING_STAND_FALLBACK] target=${formatPos(target)} facing=${facing || 'unknown'} reason=${standReady.error || 'unavailable'}`)
    }
  }

  const preferredReference = facingOffset
    ? await ensurePreferredStairReference(context, {
      facing,
      facingOffset,
      lockOwner,
      options,
      target
    })
    : null
  if (preferredReference && !preferredReference.ok) return preferredReference

  const orderedReferences = preferredReference?.reference
    ? [
      preferredReference.reference,
      ...sideReferences.filter(reference => !sameBlockPos(reference.position, preferredReference.reference.position))
    ]
    : sideReferences
  if (!orderedReferences.length) return fail('stateful_stair_no_side_reference')

  for (const reference of orderedReferences) {
    const liveReference = bot.blockAt?.(toBlockVec3(reference.position)) || reference
    if (!isPlacementReferenceBlock(liveReference)) {
      lastError = new Error(`stateful_stair_reference_unavailable:${liveReference?.name || 'air'}`)
      continue
    }
    if (stairFacingStandFallback) {
      const reached = await ensureStatefulReferenceReach(context, {
        lockOwner,
        options,
        placeDistance,
        reference: liveReference,
        target
      })
      if (!reached.ok) {
        lastError = new Error(reached.error || 'stateful_stair_reference_unreachable')
        continue
      }
    }
    const faceVector = getFaceVector(liveReference.position, target)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        const oriented = await orientBotForPlacement(context, target, blockName, states)
        if (!oriented.ok) {
          lastError = new Error(oriented.error || 'placement_orientation_failed')
          break
        }

        context.logger?.log?.(`[BUILD_STAIR_STATE_PLACE] target=${formatPos(target)} block=${blockName} half=${half} facing=${facing || 'unknown'} reference=${formatPos(liveReference.position)}`)
        await bot._placeBlockWithOptions(liveReference, faceVector, {
          swingArm: 'right',
          half,
          // Preserve the yaw set by orientBotForPlacement; generic placement
          // would otherwise look at the reference face and change stair facing.
          forceLook: 'ignore'
        })

        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          if (preferredReference?.temporary) {
            const cleared = await clearPreferredStairReference(context, preferredReference, {
              lockOwner,
              options
            })
            if (!cleared.ok) return cleared
          }
          return ok(attempt > 1 ? 'stateful_stair_placed_after_retry' : 'stateful_stair_placed', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || 'stateful_stair_not_stable')
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'stateful_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      } catch (err) {
        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          if (preferredReference?.temporary) {
            const cleared = await clearPreferredStairReference(context, preferredReference, {
              lockOwner,
              options
            })
            if (!cleared.ok) return cleared
          }
          return ok('stateful_stair_placed_after_timeout', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            recoveredFrom: err.message,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || err.message || String(err))
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'stateful_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
    }
  }

  if (preferredReference?.temporary) {
    await clearPreferredStairReference(context, preferredReference, {
      lockOwner,
      options
    })
  }
  return fail(lastError?.message || 'stateful_stair_place_failed')
}

async function tryPlaceStatefulBlock(context, params = {}) {
  const { blockName, lockOwner, options = {}, placeDistance = options.placeDistance ?? 4.5, references = [], target } = params
  const states = placementStates(options)
  const profile = statefulPlacementProfile(blockName, states, references, target)
  if (!profile) return fail('stateful_block_not_applicable')

  const bot = context?.bot
  if (typeof bot?._placeBlockWithOptions !== 'function') {
    return fail('stateful_block_place_unavailable')
  }
  if (!profile.references.length) return fail(profile.noReferenceError)

  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)
  for (const reference of profile.references) {
    const liveReference = bot.blockAt?.(toBlockVec3(reference.position)) || reference
    if (!isPlacementReferenceBlockForTarget(liveReference, blockName)) {
      lastError = new Error(`stateful_reference_unavailable:${liveReference?.name || 'air'}`)
      continue
    }
    const reached = await ensureStatefulReferenceReach(context, {
      lockOwner,
      options,
      placeDistance,
      reference: liveReference,
      target
    })
    if (!reached.ok) {
      lastError = new Error(reached.error || 'stateful_reference_unreachable')
      continue
    }
    const faceVector = getFaceVector(liveReference.position, target)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        if (profile.orientBeforePlace) {
          const oriented = await orientBotForPlacement(context, target, blockName, states)
          if (!oriented.ok) {
            lastError = new Error(oriented.error || 'placement_orientation_failed')
            break
          }
        }

        context.logger?.log?.(`[BUILD_STATEFUL_PLACE] target=${formatPos(target)} block=${blockName} state=${profile.label} reference=${formatPos(liveReference.position)}`)
        await placeBlockWithOptionsAgainstReference(context, liveReference, target, profile.placeOptions)

        const stable = await confirmStatefulPlacedBlock(context, target, blockName, states, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok(attempt > 1 ? 'stateful_block_placed_after_retry' : 'stateful_block_placed', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || 'stateful_block_not_stable')
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'stateful_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      } catch (err) {
        const stable = await confirmStatefulPlacedBlock(context, target, blockName, states, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok('stateful_block_placed_after_timeout', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            recoveredFrom: err.message,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || err.message || String(err))
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'stateful_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
    }
  }

  return fail(lastError?.message || 'stateful_block_place_failed')
}

async function tryPlaceDoubleSlab(context, params = {}) {
  const { blockName, options = {}, references = [], target } = params
  const states = placementStates(options)
  if (!isSlabBlockName(blockName) || String(states?.type || '').toLowerCase() !== 'double') {
    return fail('double_slab_not_applicable')
  }

  const bot = context?.bot
  if (typeof bot?._placeBlockWithOptions !== 'function') {
    return fail('double_slab_place_unavailable')
  }

  const statefulReferences = references
    .filter(reference => getFaceVector(reference.position, target).y >= 0)
    .sort((a, b) => Math.abs(getFaceVector(b.position, target).y) - Math.abs(getFaceVector(a.position, target).y))
  if (!statefulReferences.length) return fail('double_slab_no_reference')

  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)
  for (const reference of statefulReferences) {
    const faceVector = getFaceVector(reference.position, target)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        let held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        context.logger?.log?.(`[BUILD_STATEFUL_PLACE] target=${formatPos(target)} block=${blockName} state=slab_double_first reference=${formatPos(reference.position)}`)
        await bot._placeBlockWithOptions(reference, faceVector, {
          swingArm: 'right',
          half: 'bottom',
          forceLook: false
        })

        await sleep(options.stableConfirmDelayMs ?? 180)
        const first = bot.blockAt?.(toBlockVec3(target))
        if (first?.name !== blockName) {
          lastError = new Error(first && !AIR_BLOCKS.has(first.name)
            ? `place_failed:unstable:${first.name}`
            : 'place_failed:unstable_air')
          if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }

        let actualType = slabTypeOf(first)
        if (actualType === 'double') {
          return ok(attempt > 1 ? 'double_slab_placed_after_retry' : 'double_slab_placed', {
            blockName,
            position: target,
            referencePosition: reference.position,
            attempts: attempt
          })
        }

        held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        const mergeFace = actualType === 'top' ? new Vec3(0, -1, 0) : new Vec3(0, 1, 0)
        context.logger?.log?.(`[BUILD_STATEFUL_PLACE] target=${formatPos(target)} block=${blockName} state=slab_double_merge reference=${formatPos(first.position || target)}`)
        await bot._placeBlockWithOptions(first, mergeFace, {
          swingArm: 'right',
          forceLook: false
        })

        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok(attempt > 1 ? 'double_slab_placed_after_retry' : 'double_slab_placed', {
            blockName,
            position: target,
            referencePosition: reference.position,
            attempts: attempt
          })
        }

        lastError = new Error(stable.error || 'double_slab_not_stable')
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      } catch (err) {
        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok('double_slab_placed_after_timeout', {
            blockName,
            position: target,
            referencePosition: reference.position,
            recoveredFrom: err.message,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || err.message || String(err))
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
    }
  }

  return fail(lastError?.message || 'double_slab_place_failed')
}

async function tryPlaceFenceGateWithFacing(context, params = {}) {
  const { blockName, lockOwner, options = {}, placeDistance = options.placeDistance ?? 4.5, references = [], target } = params
  const states = placementStates(options)
  if (!isFenceGateBlockName(blockName) || states?.facing == null) {
    return fail('fence_gate_not_applicable')
  }

  const bot = context?.bot
  if (typeof bot?._placeBlockWithOptions !== 'function') {
    return fail('fence_gate_place_unavailable')
  }

  const direction = placementLookDirection(blockName, states)
  if (!direction) return fail('fence_gate_facing_unknown')

  const gateReferences = references.length
    ? references
    : findReferenceBlocksForPlacement(context, target, blockName, states)
  if (!gateReferences.length) return fail('fence_gate_no_reference')

  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)
  for (const reference of gateReferences) {
    const liveReference = bot.blockAt?.(toBlockVec3(reference.position)) || reference
    if (!isPlacementReferenceBlock(liveReference)) {
      lastError = new Error(`fence_gate_reference_unavailable:${liveReference?.name || 'air'}`)
      continue
    }

    const reached = await ensureStatefulReferenceReach(context, {
      lockOwner,
      options,
      placeDistance,
      reference: liveReference,
      target
    })
    if (!reached.ok) {
      lastError = new Error(reached.error || 'fence_gate_reference_unreachable')
      continue
    }

    const faceVector = getFaceVector(liveReference.position, target)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        context.logger?.log?.(`[BUILD_FENCE_GATE_STATE_PLACE] target=${formatPos(target)} block=${blockName} facing=${direction.facing} reference=${formatPos(liveReference.position)}`)
        await placeFenceGateWithOptions(context, liveReference, target, {
          swingArm: 'right',
          forceLook: 'ignore'
        }, {
          blockName,
          direction
        })

        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok(attempt > 1 ? 'fence_gate_placed_after_retry' : 'fence_gate_placed', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            attempts: attempt
          })
        }

        lastError = new Error(stable.error || 'fence_gate_not_stable')
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          const materialRefill = placementMaterialRefillResult(context, blockName, lastError.message)
          if (materialRefill) return materialRefill
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'fence_gate_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      } catch (err) {
        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok('fence_gate_placed_after_timeout', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            recoveredFrom: err.message,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || err.message || String(err))
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          const materialRefill = placementMaterialRefillResult(context, blockName, lastError.message)
          if (materialRefill) return materialRefill
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'fence_gate_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
    }
  }

  return fail(lastError?.message || 'fence_gate_place_failed')
}

async function tryPlaceDoorWithFacing(context, params = {}) {
  const { blockName, lockOwner, options = {}, placeDistance = options.placeDistance ?? 4.5, references = [], target } = params
  const states = placementStates(options)
  const half = String(states?.half || 'lower').toLowerCase()
  if (!isDoorBlockName(blockName) || states?.facing == null || half === 'upper') {
    return fail('door_not_applicable')
  }

  const bot = context?.bot
  if (typeof bot?._placeBlockWithOptions !== 'function') {
    return fail('door_place_unavailable')
  }

  const direction = placementLookDirection(blockName, states)
  if (!direction) return fail('door_facing_unknown')
  const facingOffset = horizontalOffsetForFacing(direction.facing)

  let standFallback = null
  if (facingOffset) {
    const standReady = await moveToDoorFacingStand(context, {
      facing: direction.facing,
      facingOffset,
      lockOwner,
      options,
      placeDistance,
      target
    })
    if (!standReady.ok) {
      const standError = String(standReady.error || '')
      const canUseReachFallback = standError.startsWith('door_facing_stand_unavailable:') ||
        standError === 'move_timeout' ||
        standError === 'door_facing_stand_still_unaligned'
      if (!canUseReachFallback) return standReady
      standFallback = standReady
      context.logger?.log?.(`[BUILD_DOOR_FACING_STAND_FALLBACK] target=${formatPos(target)} facing=${direction.facing || 'unknown'} reason=${standReady.error || 'unavailable'}`)
    }
  }

  const doorReferences = doorPlacementReferences(context, target, blockName, states, references)
  if (!doorReferences.length) return fail('door_no_reference')

  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)
  for (const reference of doorReferences) {
    const liveReference = bot.blockAt?.(toBlockVec3(reference.position)) || reference
    if (!isPlacementReferenceBlock(liveReference)) {
      lastError = new Error(`door_reference_unavailable:${liveReference?.name || 'air'}`)
      continue
    }

    if (standFallback) {
      const reached = await ensureStatefulReferenceReach(context, {
        lockOwner,
        options,
        placeDistance,
        reference: liveReference,
        target
      })
      if (!reached.ok) {
        lastError = new Error(reached.error || 'door_reference_unreachable')
        continue
      }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        settleMovementForFinalOrientation(context, target, 'DOOR')
        const oriented = await lookTowardDirection(context, target, blockName, direction)
        if (!oriented.ok) {
          lastError = new Error(oriented.error || 'door_orientation_failed')
          break
        }

        context.logger?.log?.(`[BUILD_DOOR_STATE_PLACE] target=${formatPos(target)} block=${blockName} facing=${direction.facing} reference=${formatPos(liveReference.position)}`)
        await placeBlockWithOptionsAgainstReference(context, liveReference, target, {
          swingArm: 'right',
          forceLook: 'ignore'
        })

        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok(attempt > 1 ? 'door_placed_after_retry' : 'door_placed', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            attempts: attempt
          })
        }

        lastError = new Error(stable.error || 'door_not_stable')
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'door_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      } catch (err) {
        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok('door_placed_after_timeout', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            recoveredFrom: err.message,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || err.message || String(err))
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'door_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
    }
  }

  return fail(lastError?.message || 'door_place_failed')
}

async function tryPlaceFurnaceLikeWithFacing(context, params = {}) {
  const { blockName, lockOwner, options = {}, placeDistance = options.placeDistance ?? 4.5, references = [], target } = params
  const states = placementStates(options)
  if (!isFurnaceLikeBlockName(blockName) || states?.facing == null) {
    return fail('furnace_like_not_applicable')
  }

  const bot = context?.bot
  if (typeof bot?._placeBlockWithOptions !== 'function') {
    return fail('furnace_like_place_unavailable')
  }

  const direction = placementLookDirection(blockName, states)
  if (!direction) return fail('furnace_like_facing_unknown')

  const furnaceReferences = furnaceLikePlacementReferences(context, target, blockName, states, references)
  if (!furnaceReferences.length) return fail('furnace_like_no_reference')

  let lastError = null
  const maxAttempts = placementAttemptsForBlock(blockName, options)
  for (const reference of furnaceReferences) {
    const liveReference = bot.blockAt?.(toBlockVec3(reference.position)) || reference
    if (!isPlacementReferenceBlock(liveReference)) {
      lastError = new Error(`furnace_like_reference_unavailable:${liveReference?.name || 'air'}`)
      continue
    }

    const reached = await ensureStatefulReferenceReach(context, {
      lockOwner,
      options,
      placeDistance,
      reference: liveReference,
      target
    })
    if (!reached.ok) {
      lastError = new Error(reached.error || 'furnace_like_reference_unreachable')
      continue
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const held = await equipBlockForPlacement(context, blockName, options)
        if (!held.ok) {
          lastError = new Error(held.error || 'block_equip_failed')
          break
        }

        const oriented = await lookTowardDirection(context, target, blockName, direction)
        if (!oriented.ok) {
          lastError = new Error(oriented.error || 'furnace_like_orientation_failed')
          break
        }

        context.logger?.log?.(`[BUILD_FURNACE_STATE_PLACE] target=${formatPos(target)} block=${blockName} facing=${direction.facing} reference=${formatPos(liveReference.position)}`)
        await placeBlockWithOptionsAgainstReference(context, liveReference, target, {
          swingArm: 'right',
          forceLook: 'ignore'
        })

        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok(attempt > 1 ? 'furnace_like_placed_after_retry' : 'furnace_like_placed', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            attempts: attempt
          })
        }

        lastError = new Error(stable.error || 'furnace_like_not_stable')
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'furnace_like_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      } catch (err) {
        const stable = await confirmPlacedBlock(context, target, blockName, {
          ...options,
          requireServerConfirmation: true,
          requireStateConfirmation: true
        })
        if (stable.ok) {
          return ok('furnace_like_placed_after_timeout', {
            blockName,
            position: target,
            referencePosition: liveReference.position,
            recoveredFrom: err.message,
            attempts: attempt
          })
        }
        lastError = new Error(stable.error || err.message || String(err))
        if (isPlacementStateMismatchError(lastError)) {
          const cleared = await clearWrongStatePlacement(context, target, blockName, {
            lockOwner,
            options,
            reason: lastError.message
          })
          if (!cleared.ok) return cleared
          if (attempt < maxAttempts) {
            context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
            await sleep(options.retryDelayMs ?? 250)
            continue
          }
          break
        }
        if (attempt < maxAttempts && isWrongBlockPlacementError(lastError) && canRepairObstructedTarget(options)) {
          const repaired = await repairObstructedTargetForPlacement(context, target, blockName, {
            lockOwner,
            options,
            stage: 'furnace_like_retry_wrong_block'
          })
          if (!repaired.ok) return repaired
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        if (attempt < maxAttempts && isPlacementRetryableError(lastError)) {
          context.logger?.log?.(`[BUILD_PLACE_RETRY] target=${formatPos(target)} block=${blockName} attempt=${attempt + 1} reason=${lastError.message}`)
          await sleep(options.retryDelayMs ?? 250)
          continue
        }
        break
      }
    }
  }

  return fail(lastError?.message || 'furnace_like_place_failed')
}

function furnaceLikePlacementReferences(context, target, blockName, states = null, references = []) {
  const candidates = references.length
    ? references
    : findReferenceBlocksForPlacement(context, target, blockName, states)
  const below = []
  const side = []
  const other = []
  for (const reference of candidates) {
    const face = getFaceVector(reference.position, target)
    if (face.y > 0) below.push(reference)
    else if (face.y === 0) side.push(reference)
    else other.push(reference)
  }
  return [...below, ...side, ...other]
}

function doorPlacementReferences(context, target, blockName, states = null, references = []) {
  const candidates = references.length
    ? references
    : findReferenceBlocksForPlacement(context, target, blockName, states)
  const below = []
  const side = []
  const other = []
  for (const reference of candidates) {
    const face = getFaceVector(reference.position, target)
    if (face.y > 0) below.push(reference)
    else if (face.y === 0) side.push(reference)
    else other.push(reference)
  }
  return [...below, ...side, ...other]
}

async function moveToDoorFacingStand(context, params = {}) {
  const { facing, facingOffset, lockOwner, options = {}, placeDistance = 4.5, target } = params
  const bot = context?.bot
  if (!facingOffset || !target) return ok('door_facing_stand_not_required')
  if (isBotOnDoorPlacementSide(bot, target, facingOffset)) {
    return ok('door_facing_stand_already_aligned')
  }

  const stands = doorFacingStandPositions(context, target, facingOffset, placeDistance, options)
  if (!stands.length) {
    context.logger?.log?.(`[BUILD_DOOR_FACING_STAND_UNAVAILABLE] target=${formatPos(target)} facing=${facing || 'unknown'} reason=no_safe_aligned_stand`)
    return fail(`door_facing_stand_unavailable:${facing || 'unknown'}`, {
      facing,
      target,
      reason: 'no_safe_aligned_stand'
    })
  }

  const maxAttempts = Math.max(1, Number(options.standMoveAttempts || 4))
  const attempts = placementStandAttempts(stands, target, maxAttempts, options)
  let lastResult = null
  for (let index = 0; index < attempts.length; index++) {
    const stand = attempts[index]
    const reason = index === 0 ? 'door_facing_stand' : 'door_facing_stand_retry'
    context.logger?.log?.(`[BUILD_PLACE_REPOSITION] target=${formatPos(target)} stand=${formatPos(stand)} reason=${reason}`)
    const moved = await moveTo(context, stand, {
      owner: lockOwner,
      range: safeMoveRangeForStand(stand, target, options),
      timeoutMs: placementMoveTimeoutMs(bot, stand, options),
      canDig: options.canDig ?? false,
      allowScaffolding: options.allowScaffolding === true,
      ...movementScaffoldExclusions(options, target),
      holdLock: true
    })

    if (isBotOnDoorPlacementSide(bot, target, facingOffset)) {
      return ok(moved.ok ? 'door_facing_stand_reached' : 'door_facing_stand_reached_after_partial_move', {
        standPosition: stand,
        attempts: index + 1
      })
    }
    if (moved.ok) {
      context.logger?.log?.(`[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} reason=door_facing_stand_unaligned_after_move`)
      lastResult = fail('door_facing_stand_still_unaligned')
      continue
    }
    lastResult = moved
    if (moved.error !== 'move_timeout') return moved
  }

  return lastResult || fail('move_timeout')
}

function doorFacingStandPositions(context, target, facingOffset, placeDistance = 4.5, options = {}) {
  return stairFacingStandPositions(context, target, facingOffset, placeDistance, options)
}

function isBotOnDoorPlacementSide(bot, target, facingOffset) {
  return isBotOnStairPlacementSide(bot, target, facingOffset)
}

async function placeFenceGateWithOptions(context, reference, target, placeOptions, orientation = {}) {
  const bot = context?.bot
  const faceVector = getFaceVector(reference.position, target)
  settleMovementForFinalOrientation(context, target, 'FENCE_GATE')
  const place = async () => {
    const oriented = await lookTowardDirection(context, target, orientation.blockName, {
      ...(orientation.direction || {}),
      forceLook: false,
      settleDelayMs: 120,
      source: 'fence_gate_facing_final'
    })
    if (!oriented.ok) throw new Error(oriented.error || 'fence_gate_orientation_failed')
    const expectedYaw = Math.atan2(-orientation.direction.x, -orientation.direction.z)
    context.logger?.log?.(`[BUILD_FENCE_GATE_FINAL_YAW] target=${formatPos(target)} facing=${orientation.direction.facing} expected=${expectedYaw.toFixed(4)} actual=${Number(bot.entity?.yaw).toFixed(4)}`)
    return bot._placeBlockWithOptions(reference, faceVector, placeOptions)
  }

  if (!shouldSneakForPlacementReference(reference) || typeof bot?.setControlState !== 'function') {
    return place()
  }

  context.logger?.log?.(`[BUILD_PLACE_SNEAK] target=${formatPos(target)} reference=${formatPos(reference.position)} referenceBlock=${reference.name}`)
  bot.setControlState('sneak', true)
  await sleep(80)
  try {
    return await place()
  } finally {
    bot.setControlState('sneak', false)
  }
}

function settleMovementForFinalOrientation(context, target, label) {
  const bot = context?.bot
  let settled = false
  try {
    if (typeof bot?.pathfinder?.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
      settled = true
    }
  } catch {}
  try {
    if (typeof bot?.pathfinder?.stop === 'function') {
      bot.pathfinder.stop()
      settled = true
    }
  } catch {}
  try {
    bot?.clearControlStates?.()
  } catch {}
  if (settled) {
    context.logger?.log?.(`[BUILD_${label}_MOVEMENT_SETTLED] target=${formatPos(target)} reason=final_orientation`)
  }
}

async function placeBlockWithOptionsAgainstReference(context, reference, target, placeOptions) {
  const bot = context?.bot
  const faceVector = getFaceVector(reference.position, target)
  if (!shouldSneakForPlacementReference(reference) || typeof bot?.setControlState !== 'function') {
    return bot._placeBlockWithOptions(reference, faceVector, placeOptions)
  }

  context.logger?.log?.(`[BUILD_PLACE_SNEAK] target=${formatPos(target)} reference=${formatPos(reference.position)} referenceBlock=${reference.name}`)
  bot.setControlState('sneak', true)
  await sleep(80)
  try {
    return await bot._placeBlockWithOptions(reference, faceVector, placeOptions)
  } finally {
    bot.setControlState('sneak', false)
  }
}

function statefulPlacementProfile(blockName, states = null, references = [], target = null) {
  if (!states) return null
  if (isSlabBlockName(blockName) && String(states.type || '').toLowerCase() === 'top') {
    const statefulReferences = references.filter(reference => getFaceVector(reference.position, target).y <= 0)
    return {
      label: 'slab_top',
      references: statefulReferences,
      noReferenceError: 'stateful_slab_no_side_or_top_reference',
      placeOptions: {
        swingArm: 'right',
        half: 'top',
        forceLook: false
      }
    }
  }
  if (isSlabBlockName(blockName) && String(states.type || '').toLowerCase() === 'bottom') {
    const statefulReferences = references.filter(reference => getFaceVector(reference.position, target).y >= 0)
    return {
      label: 'slab_bottom',
      references: statefulReferences,
      noReferenceError: 'stateful_slab_no_side_or_bottom_reference',
      placeOptions: {
        swingArm: 'right',
        half: 'bottom',
        forceLook: false
      }
    }
  }
  if (isButtonBlockName(blockName) && String(states.face || '').toLowerCase() === 'wall') {
    const preferredOffsets = requiredWallAttachmentOffsets(states)
    const statefulReferences = preferredOffsets
      .map(offset => {
        if (!target) return null
        return references.find(reference =>
          reference.position.x === target.x + offset.x &&
          reference.position.y === target.y + offset.y &&
          reference.position.z === target.z + offset.z
        )
      })
      .filter(Boolean)
    return {
      label: `button_wall_${String(states.facing || 'unknown').toLowerCase()}`,
      references: statefulReferences,
      noReferenceError: 'stateful_button_no_wall_reference',
      placeOptions: {
        swingArm: 'right',
        forceLook: false
      }
    }
  }
  if (isButtonBlockName(blockName) && ['floor', 'ceiling'].includes(String(states.face || '').toLowerCase())) {
    // face=floor/ceiling comes from the clicked face (the block below or
    // above), while facing comes from the look — so this profile needs both a
    // fixed reference and the yaw kept through the place (修缮 10 真机).
    const buttonFace = String(states.face).toLowerCase()
    const buttonOffset = buttonFace === 'floor' ? { x: 0, y: -1, z: 0 } : { x: 0, y: 1, z: 0 }
    const statefulReferences = target
      ? references.filter(reference =>
        reference.position.x === target.x + buttonOffset.x &&
        reference.position.y === target.y + buttonOffset.y &&
        reference.position.z === target.z + buttonOffset.z)
      : []
    return {
      label: `button_${buttonFace}_${String(states.facing || 'unknown').toLowerCase()}`,
      references: statefulReferences,
      noReferenceError: `stateful_button_no_${buttonFace}_reference`,
      orientBeforePlace: states.facing != null,
      placeOptions: {
        swingArm: 'right',
        forceLook: states.facing != null ? 'ignore' : false
      }
    }
  }
  if (isTrapdoorBlockName(blockName) && (states.half != null || states.facing != null || states.open != null)) {
    const half = String(states.half || '').toLowerCase()
    const facing = String(states.facing || '').toLowerCase()
    const statefulReferences = trapdoorStatefulReferences(references, target, half, facing)
    return {
      label: `trapdoor_${half || 'any'}_${facing || 'any'}`,
      references: statefulReferences,
      noReferenceError: 'stateful_trapdoor_no_reference',
      orientBeforePlace: states.facing != null,
      placeOptions: {
        swingArm: 'right',
        ...(half === 'top' || half === 'bottom' ? { half } : {}),
        forceLook: states.facing != null ? 'ignore' : false
      }
    }
  }
  if (isAxisBlockName(blockName) && states.axis != null) {
    const axis = String(states.axis || '').toLowerCase()
    const statefulReferences = references.filter(reference =>
      axisForPlacementFace(getFaceVector(reference.position, target)) === axis
    )
    return {
      label: `axis_${axis || 'unknown'}`,
      references: statefulReferences,
      noReferenceError: `stateful_axis_no_${axis || 'matching'}_reference`,
      placeOptions: {
        swingArm: 'right',
        forceLook: false
      }
    }
  }
  return null
}

function trapdoorStatefulReferences(references = [], target = null, half = '', facing = '') {
  if (!target) return references
  const normalizedHalf = String(half || '').toLowerCase()
  const facingOffset = horizontalOffsetForFacing(String(facing || '').toLowerCase())
  const candidates = references
    .map((reference, index) => {
      const face = getFaceVector(reference.position, target)
      const horizontalMatchesFacing = Boolean(facingOffset) &&
        face.y === 0 &&
        face.x === facingOffset.x &&
        face.z === facingOffset.z
      const verticalHalfReference =
        (normalizedHalf === 'top' && face.y < 0) ||
        (normalizedHalf === 'bottom' && face.y > 0)
      return { reference, index, face, horizontalMatchesFacing, verticalHalfReference }
    })
    .filter(candidate => {
      if (normalizedHalf === 'top' && candidate.face.y > 0) return false
      if (normalizedHalf === 'bottom' && candidate.face.y < 0) return false
      if (candidate.face.y === 0 && facingOffset) return candidate.horizontalMatchesFacing
      return true
    })

  candidates.sort((a, b) => {
    const aRank = a.verticalHalfReference ? 0 : a.horizontalMatchesFacing ? 1 : 2
    const bRank = b.verticalHalfReference ? 0 : b.horizontalMatchesFacing ? 1 : 2
    if (aRank !== bRank) return aRank - bRank
    return a.index - b.index
  })

  const ordered = candidates.map(candidate => candidate.reference)
  if (normalizedHalf === 'top') {
    return ordered
  }
  if (normalizedHalf === 'bottom') {
    return ordered
  }
  return ordered
}

function canRetryStatefulWithTemporaryReference(blockName, error) {
  const value = String(error || '')
  return (isSlabBlockName(blockName) && /^stateful_slab_no_/.test(value)) ||
    (isTrapdoorBlockName(blockName) && /^stateful_trapdoor_no_/.test(value)) ||
    // Axis logs (e.g. the gabled-roof ridge) need a reference on the required
    // axis; when none exists a temporary block on that axis provides the
    // face (live failure: 9 ridge oak_log axis=x steps terminal_failed with
    // stateful_axis_no_x_reference during the L3 renovation).
    (isAxisBlockName(blockName) && /^stateful_axis_no_/.test(value))
}

function slabTypeOf(block) {
  if (typeof block?.getProperties !== 'function') return null
  return String(block.getProperties()?.type || '').toLowerCase()
}

async function equipBlockForPlacement(context, blockName, options = {}) {
  return equipItemForPlacement(context, itemNameForBlock(blockName), {
    ...options,
    blockName,
    useEquipmentSystem: true
  })
}

async function moveToStairFacingStand(context, params = {}) {
  const { facing, facingOffset, lockOwner, options = {}, placeDistance = 4.5, target } = params
  if (!facingOffset || !target) return ok('stair_facing_stand_not_required')
  const bot = context?.bot
  if (isBotOnStairPlacementSide(bot, target, facingOffset)) {
    return ok('stair_facing_stand_already_aligned')
  }

  const stands = stairFacingStandPositions(context, target, facingOffset, placeDistance, options)

  if (!stands.length) {
    context.logger?.log?.(`[BUILD_STAIR_FACING_STAND_UNAVAILABLE] target=${formatPos(target)} facing=${facing || 'unknown'} reason=no_safe_aligned_stand`)
    return fail(`stair_facing_stand_unavailable:${facing || 'unknown'}`, {
      facing,
      target,
      reason: 'no_safe_aligned_stand'
    })
  }
  return moveToFirstReachablePlacementStand(context, target, stands, {
    owner: lockOwner,
    options: preciseStairStandMoveOptions(options),
    placeDistance,
    reason: 'stair_facing_stand'
  })
}

function preciseStairStandMoveOptions(options = {}) {
  const requested = Number(options.stairFacingStandMoveRange ?? options.safeMoveRange)
  const safeMoveRange = Number.isFinite(requested)
    ? Math.min(requested, 0.35)
    : 0.35
  return {
    ...options,
    safeMoveRange
  }
}

function stairFacingStandPositions(context, target, facingOffset, placeDistance = 4.5, options = {}) {
  const bot = context?.bot
  if (!bot?.blockAt || !bot.entity?.position || !target || !facingOffset) return []
  const footY = Math.floor(bot.entity.position.y)
  const yCandidates = uniqueNumbers([
    footY,
    target.y + 2,
    target.y,
    target.y - 1,
    target.y + 1,
    footY - 1,
    footY - 2,
    target.y - 2,
    target.y - 3,
    target.y - 4
  ])
  const lateralOffsets = facingOffset.x !== 0
    ? [
        { x: -facingOffset.x, z: 0 },
        { x: -facingOffset.x * 2, z: 0 },
        { x: -facingOffset.x * 3, z: 0 },
        { x: -facingOffset.x, z: 1 },
        { x: -facingOffset.x, z: -1 },
        { x: -facingOffset.x * 2, z: 1 },
        { x: -facingOffset.x * 2, z: -1 },
        { x: -facingOffset.x * 2, z: 2 },
        { x: -facingOffset.x * 2, z: -2 },
        { x: -facingOffset.x * 3, z: 1 },
        { x: -facingOffset.x * 3, z: -1 }
      ]
    : [
        { x: 0, z: -facingOffset.z },
        { x: 0, z: -facingOffset.z * 2 },
        { x: 0, z: -facingOffset.z * 3 },
        { x: 1, z: -facingOffset.z },
        { x: -1, z: -facingOffset.z },
        { x: 1, z: -facingOffset.z * 2 },
        { x: -1, z: -facingOffset.z * 2 },
        { x: 2, z: -facingOffset.z * 2 },
        { x: -2, z: -facingOffset.z * 2 },
        { x: 1, z: -facingOffset.z * 3 },
        { x: -1, z: -facingOffset.z * 3 }
      ]

  const stands = []
  const standSafetyOptions = {
    ...options,
    ignoreReservedPositions: true
  }
  for (const y of yCandidates) {
    for (const offset of lateralOffsets) {
      const stand = { x: target.x + offset.x, y, z: target.z + offset.z }
      if (standIntersectsBlock(stand, target)) continue
      if (!isSafeStandPosition(context, stand, standSafetyOptions)) continue
      if (!isAlignedStairPlacementSide(stand, target, facingOffset)) continue
      if (placementReachDistance(stand, target) > placeDistance + 0.6) continue
      stands.push(stand)
    }
  }
  return stands
}

async function ensurePreferredStairReference(context, params = {}) {
  const { facing, facingOffset, lockOwner, options = {}, target } = params
  const bot = context?.bot
  if (!bot?.blockAt || !target || !facingOffset) return fail(`stair_preferred_reference_unavailable:${facing || 'unknown'}`)
  const supportBlockName = selectTemporaryReferenceMaterial(context, options)
  const candidates = preferredStairReferenceCandidates(target, facingOffset)
  let lastError = null

  for (const position of candidates) {
    const current = bot.blockAt(toBlockVec3(position))
    if (isPlacementReferenceBlock(current)) {
      return { ok: true, message: 'stair_preferred_reference_ready', reference: current, position, temporary: false }
    }
    if (current && !AIR_BLOCKS.has(current.name)) {
      lastError = new Error(`stair_preferred_reference_blocked:${current.name}`)
      continue
    }

    const column = temporaryReferenceColumnPositions(context, position, options)
    if (!column.ok) {
      lastError = new Error(column.error || 'stair_temporary_reference_no_support')
      continue
    }
    const columnData = column.data || {}
    const columnPositions = columnData.positions || []
    if (!columnPositions.length && columnData.reference) {
      return { ok: true, message: 'stair_preferred_reference_ready', reference: columnData.reference, position, temporary: false }
    }

    const placed = await placeTemporaryReferenceColumn(context, columnPositions, supportBlockName, {
      lockOwner,
      options
    })
    if (!placed.ok) {
      lastError = new Error(placed.error || 'stair_temporary_reference_place_failed')
      continue
    }
    const reference = bot.blockAt(toBlockVec3(position))
    const placedData = placed.data || {}
    if (!isPlacementReferenceBlock(reference)) {
      await clearTemporaryPlacementReference(context, placedData, { lockOwner, options })
      lastError = new Error(`stair_preferred_reference_not_stable:${reference?.name || 'air'}`)
      continue
    }
    context.logger?.log?.(`[BUILD_STAIR_TEMP_REFERENCE_COLUMN] target=${formatPos(target)} reference=${formatPos(position)} material=${supportBlockName} blocks=${(placedData.positions || []).length}`)
    return {
      ok: true,
      message: 'stair_temporary_reference_ready',
      reference,
      position,
      positions: placedData.positions || columnPositions,
      temporary: true
    }
  }

  return fail(lastError?.message || `stair_preferred_reference_unavailable:${facing || 'unknown'}`)
}

function preferredStairReferenceCandidates(target, facingOffset) {
  const offsets = [
    facingOffset,
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 }
  ]
  const candidates = []
  const seen = new Set()
  for (const offset of offsets) {
    if (!offset) continue
    const position = {
      x: target.x + (Number(offset.x) || 0),
      y: target.y + (Number(offset.y) || 0),
      z: target.z + (Number(offset.z) || 0)
    }
    if (sameBlockPos(position, target)) continue
    const key = formatPos(position)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(position)
  }
  return candidates
}

async function clearPreferredStairReference(context, preferredReference, params = {}) {
  if (!preferredReference?.temporary) return ok('stair_temporary_reference_cleanup_not_required')
  const positions = preferredReference.positions || []
  if (positions.length) {
    return clearTemporaryPlacementReference(context, { positions }, params)
  }
  return clearTemporaryReferenceBlock(context, preferredReference.position, params)
}

async function ensureTemporaryPlacementReference(context, params = {}) {
  const { blockName, lockOwner, options = {}, target } = params
  const states = placementStates(options)
  if (!canUseTemporaryPlacementReference(blockName, states, options)) {
    return fail('temporary_reference_not_applicable')
  }

  // 后勤 16（决策 #78）：第三种启动方式——序列层点名「就垫这一格」。
  // 那一格通常是另一块图纸砖的位置（门楼互指的两只漏斗就是），它落在保留集里，
  // 而 building-system 那张白名单只放行 pending/ready/executing 的步；被点名的
  // 这一格因此要在这里自己进白名单，否则 temporary_reference_reserved 拦下。
  const requiredPosition = normalizePosition(params.requiredPosition)
  const effectiveOptions = requiredPosition
    ? {
        ...options,
        temporaryReferenceAllowedPositions: withAllowedTemporaryReferencePosition(
          options.temporaryReferenceAllowedPositions,
          requiredPosition
        )
      }
    : options

  const material = selectTemporaryReferenceMaterial(context, effectiveOptions)
  const candidates = requiredPosition
    ? [requiredPosition]
    : temporaryPlacementReferenceCandidates(target, {
      ...effectiveOptions,
      blockName,
      blockStates: states
    })
  let lastError = null
  for (const candidate of candidates) {
    const column = temporaryReferenceColumnPositions(context, candidate, {
      ...effectiveOptions,
      blockName,
      blockStates: states
    })
    if (!column.ok) {
      lastError = new Error(column.error || 'temporary_reference_column_unavailable')
      continue
    }
    const columnData = column.data || {}
    const columnPositions = columnData.positions || []
    if (!columnPositions.length && columnData.reference) {
      return ok('temporary_reference_existing', {
        reference: columnData.reference,
        positions: []
      })
    }

    const placed = await placeTemporaryReferenceColumn(context, columnPositions, material, {
      lockOwner,
      options: effectiveOptions
    })
    if (!placed.ok) {
      lastError = new Error(placed.error || 'temporary_reference_column_failed')
      continue
    }
    const placedData = placed.data || {}
    const reference = context?.bot?.blockAt?.(toBlockVec3(candidate))
    if (!isPlacementReferenceBlockForTarget(reference, blockName)) {
      await clearTemporaryPlacementReference(context, placedData, { lockOwner, options: effectiveOptions })
      lastError = new Error(`temporary_reference_not_stable:${reference?.name || 'air'}`)
      continue
    }
    context.logger?.log?.(`[BUILD_TEMP_REFERENCE_READY] target=${formatPos(target)} reference=${formatPos(candidate)} material=${material} blocks=${(placedData.positions || []).length}`)
    return ok('temporary_reference_ready', {
      reference,
      positions: placedData.positions || [],
      blockName: material
    })
  }

  return fail(lastError?.message || 'no_support_block')
}

function canUseTemporaryPlacementReference(blockName, states = null, options = {}) {
  if (options.allowTemporaryReference === false) return false
  if (isSideAttachedBlockName(blockName)) return false
  if (requiresTopPlacementReference(blockName, states)) return false
  if (isStairBlockName(blockName) && String(states?.half || '').toLowerCase() === 'top') return false
  if (isTrapdoorBlockName(blockName)) return true
  if (isFluidBlockName(blockName)) return false
  return isPlacementReferenceName(blockName)
}

function canDeferInitialMoveForStatefulReference(context, target, blockName, states = null, options = {}) {
  if (options.deferInitialMoveForStatefulReference === false) return false
  if (!isTrapdoorBlockName(blockName)) return false
  const profile = statefulPlacementProfile(
    blockName,
    states || {},
    findReferenceBlocksForPlacement(context, target, blockName, states),
    target
  )
  if (!profile) return false
  return profile.references.length > 0 || canUseTemporaryPlacementReference(blockName, states, options)
}

function selectTemporaryReferenceMaterial(context, options = {}) {
  if (options.temporaryReferenceMaterial) return options.temporaryReferenceMaterial
  if (options.scaffoldMaterial) return options.scaffoldMaterial
  const counts = {}
  for (const item of context?.bot?.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + (item.count || 0)
  }
  return TEMPORARY_REFERENCE_MATERIALS.find(name => (counts[name] || 0) > 0) || TEMPORARY_REFERENCE_MATERIALS[0]
}

function temporaryPlacementReferenceCandidates(target, options = {}) {
  if (!target) return []
  const offsets = temporaryPlacementReferenceOffsets(options.blockName, placementStates(options))
  return offsets
    .map(offset => ({
      x: target.x + offset.x,
      y: target.y + offset.y,
      z: target.z + offset.z
    }))
    .filter(position => !sameBlockPos(position, target))
    .filter(position => !isReservedPosition(position, options.reservedPositions) ||
      isAllowedTemporaryReferencePosition(position, options))
}

function temporaryPlacementReferenceOffsets(blockName, states = null) {
  const defaultOffsets = [
    { x: 0, y: -1, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 }
  ]
  // Axis blocks take the axis of the clicked face: the temporary reference
  // must sit on the required axis or the placement confirms the wrong state.
  if (isAxisBlockName(blockName) && states?.axis != null) {
    const axis = String(states.axis).toLowerCase()
    if (axis === 'x') return [{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
    if (axis === 'z') return [{ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }]
    if (axis === 'y') return [{ x: 0, y: -1, z: 0 }]
  }
  if (isSlabBlockName(blockName)) {
    const type = String(states?.type || '').toLowerCase()
    if (type === 'top') {
      return [
        { x: -1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 0, z: 1 }
      ]
    }
    if (type === 'bottom') return defaultOffsets
  }
  if (!isTrapdoorBlockName(blockName)) return defaultOffsets

  const half = String(states?.half || '').toLowerCase()
  const facingOffset = horizontalOffsetForFacing(String(states?.facing || '').toLowerCase())
  const offsets = []
  if (half === 'bottom') offsets.push({ x: 0, y: -1, z: 0 })
  if (facingOffset) offsets.push({ x: -facingOffset.x, y: 0, z: -facingOffset.z })
  if (!offsets.length) return defaultOffsets

  const seen = new Set()
  return offsets.filter(offset => {
    const key = `${offset.x},${offset.y},${offset.z}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function temporaryReferenceColumnPositions(context, candidate, options = {}) {
  const bot = context?.bot
  if (!bot?.blockAt || !candidate) return fail('temporary_reference_missing_bot')
  const current = bot.blockAt(toBlockVec3(candidate))
  if (isPlacementReferenceBlockForTarget(current, options.blockName)) {
    return ok('temporary_reference_candidate_already_stable', {
      reference: current,
      positions: []
    })
  }
  if (current && !AIR_BLOCKS.has(current.name)) return fail(`temporary_reference_candidate_blocked:${current.name}`)

  const maxDepth = Math.max(1, Number(options.temporaryReferenceMaxDepth ?? 8))
  const columnFrom = startY => {
    const positions = []
    for (let buildY = startY; buildY <= candidate.y; buildY++) {
      const next = { x: candidate.x, y: buildY, z: candidate.z }
      if (isReservedPosition(next, options.reservedPositions) && !isAllowedTemporaryReferencePosition(next, options)) {
        return fail(`temporary_reference_reserved:${formatPos(next)}`)
      }
      positions.push(next)
    }
    return ok('temporary_reference_column_ready', { positions })
  }
  const hasSideAttachBase = position => [
    { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }
  ].some(offset => isPlacementReferenceBlock(
    bot.blockAt(toBlockVec3({ x: position.x + offset.x, y: position.y, z: position.z + offset.z }))
  ))
  for (let y = candidate.y - 1; y >= candidate.y - maxDepth; y--) {
    const position = { x: candidate.x, y, z: candidate.z }
    const block = bot.blockAt(toBlockVec3(position))
    if (isPlacementReferenceBlock(block)) {
      return columnFrom(y + 1)
    }
    if (block && !AIR_BLOCKS.has(block.name)) {
      return fail(`temporary_reference_column_blocked:${block.name}`)
    }
    if (isReservedPosition(position, options.reservedPositions) && !isAllowedTemporaryReferencePosition(position, options)) {
      return fail(`temporary_reference_reserved:${formatPos(position)}`)
    }
    // No solid ground yet, but this air cell can side-attach to the existing
    // structure: start the column here (e.g. a roof-ridge reference beside a
    // gable wall, 12 blocks above ground).
    if (hasSideAttachBase(position)) {
      return columnFrom(y)
    }
  }

  return fail('temporary_reference_no_base')
}

// 把被点名的那一格并进白名单（原白名单可能是 Set / 数组 / 空）。
function withAllowedTemporaryReferencePosition(allowed, position) {
  const keys = new Set()
  if (allowed && typeof allowed.forEach === 'function' && typeof allowed.has === 'function') {
    for (const entry of allowed) keys.add(typeof entry === 'string' ? entry : formatPos(entry))
  } else if (Array.isArray(allowed)) {
    for (const entry of allowed) keys.add(typeof entry === 'string' ? entry : formatPos(entry))
  }
  keys.add(formatPos(position))
  return keys
}

function isAllowedTemporaryReferencePosition(position, options = {}) {
  const allowed = options.temporaryReferenceAllowedPositions
  if (!position || !allowed) return false
  const key = formatPos(position)
  if (typeof allowed.has === 'function') return allowed.has(key)
  if (Array.isArray(allowed)) {
    return allowed.some(entry => {
      if (typeof entry === 'string') return entry === key
      return sameBlockPos(entry, position)
    })
  }
  return false
}

async function placeTemporaryReferenceColumn(context, positions = [], blockName, params = {}) {
  const { lockOwner, options = {} } = params
  const placed = []
  for (const position of positions) {
    const current = context?.bot?.blockAt?.(toBlockVec3(position))
    if (isPlacementReferenceBlock(current)) continue
    if (current && !AIR_BLOCKS.has(current.name)) {
      await clearTemporaryPlacementReference(context, { positions: placed }, { lockOwner, options })
      return fail(`temporary_reference_blocked:${current.name}`)
    }
    const reachable = await ensureTemporaryReferencePlacementReach(context, position, {
      lockOwner,
      options
    })
    if (!reachable.ok) {
      await clearTemporaryPlacementReference(context, { positions: placed }, { lockOwner, options })
      return reachable
    }
    const result = await placeTemporaryReferenceBlock(context, position, blockName, options)
    if (!result.ok) {
      await clearTemporaryPlacementReference(context, { positions: placed }, { lockOwner, options })
      return result
    }
    placed.push(position)
  }
  return ok('temporary_reference_column_placed', { positions: placed })
}

async function ensureTemporaryReferencePlacementReach(context, position, params = {}) {
  const { lockOwner, options = {} } = params
  const bot = context?.bot
  const placeDistance = options.placeDistance ?? 4.5
  if (isPlacementReachable(bot, position, placeDistance)) {
    return ok('temporary_reference_reachable')
  }

  const preferHighStand = shouldPreferHighTemporaryReferenceStand(bot, position, options)
  const moveOptions = {
    ...options,
    preferHighStand,
    adaptiveMoveTimeout: options.adaptiveMoveTimeout === true || preferHighStand,
    allowScaffolding: options.allowScaffolding === true || preferHighStand
  }
  const stands = findSafePlacementStandPositions(context, position, placeDistance, {
    ...moveOptions
  })
  if (!stands.length) return fail('temporary_reference_unreachable')

  const moved = await moveToFirstReachablePlacementStand(context, position, stands, {
    owner: lockOwner,
    options: moveOptions,
    placeDistance,
    reason: 'temporary_reference_reach'
  })
  if (!moved.ok) return moved
  return ok('temporary_reference_repositioned', moved.data)
}

function shouldPreferHighTemporaryReferenceStand(bot, position, options = {}) {
  if (options.preferHighStand === true) return true
  const currentY = Number(bot?.entity?.position?.y)
  if (!Number.isFinite(currentY) || !Number.isFinite(position?.y)) return false
  return position.y >= Math.floor(currentY) + 3
}

async function clearTemporaryPlacementReference(context, temporaryReference, params = {}) {
  const positions = temporaryReference?.positions || []
  if (!positions.length) return ok('temporary_reference_cleanup_not_required')
  if (params.stopMovementBeforeClear === true) {
    stopMovement(
      context?.bot,
      params.movementStopReason || 'temporary_reference_cleanup',
      params.lockOwner || null
    )
    const requestedQuiesceMs = Number(
      params.options?.temporaryReferenceMovementQuiesceMs ?? 100
    )
    const quiesceMs = Number.isFinite(requestedQuiesceMs)
      ? Math.max(0, requestedQuiesceMs)
      : 100
    if (quiesceMs > 0) await sleep(quiesceMs)
  }
  // An out-of-reach cell is left behind, not treated as a hard failure: the
  // caller would turn that into vertical_access_cleanup_failed and lose a
  // brick that actually went up. What must not happen is claiming it was
  // cleared, so it goes in the ledger and in a log line of its own.
  const unreachable = []
  for (const position of [...positions].reverse()) {
    const clearingBotSupport =
      params.settleAfterSupportClear === true &&
      isBotSupportedByTemporaryPosition(context?.bot, position)
    const cleared = await clearTemporaryReferenceBlock(context, position, params)
    if (!cleared.ok) {
      if (cleared.unreachable !== true) return cleared
      unreachable.push({ position, distance: cleared.distance })
      continue
    }
    if (clearingBotSupport) {
      const settled = await waitForBotAfterTemporarySupportClear(
        context?.bot,
        position,
        params.options || {}
      )
      if (!settled.ok) return settled
    }
  }
  if (unreachable.length > 0) {
    context.logger?.log?.(
      `[BUILD_TEMP_REFERENCE_RESIDUE] left=${unreachable.length}/${positions.length} ` +
      `positions=${unreachable.map(entry => formatPos(entry.position)).join('|')} ` +
      `maxDistance=${Math.max(...unreachable.map(entry => entry.distance)).toFixed(2)} ` +
      'reason=out_of_reach'
    )
    return ok('temporary_reference_cleanup_left_residue', { unreachable })
  }
  return ok('temporary_reference_cleanup_done')
}

async function placeTemporaryReferenceBlock(context, position, blockName, options = {}) {
  const references = findReferenceBlocksForPlacement(context, position, blockName, null)
  if (!references.length) return fail('stair_temporary_reference_no_support')
  const held = await equipBlockForPlacement(context, blockName, options)
  if (!held.ok) return fail(`stair_temporary_reference_item:${held.error || 'missing'}`)
  let lastError = null
  for (const reference of references) {
    try {
      await placeBlockAgainstReference(context, reference, position, blockName)
      const stable = await confirmPlacedBlock(context, position, blockName, {
        ...options,
        requireServerConfirmation: true
      })
      if (stable.ok) {
        context.logger?.log?.(`[BUILD_STAIR_TEMP_REFERENCE] pos=${formatPos(position)} block=${blockName}`)
        return ok('stair_temporary_reference_placed', { position, blockName })
      }
      lastError = new Error(stable.error || 'temporary_reference_not_stable')
    } catch (err) {
      const stable = await confirmPlacedBlock(context, position, blockName, {
        ...options,
        requireServerConfirmation: true
      })
      if (stable.ok) {
        context.logger?.log?.(`[BUILD_STAIR_TEMP_REFERENCE_TIMEOUT_RECOVERED] pos=${formatPos(position)} block=${blockName} reason=${err?.message || String(err)}`)
        return ok('stair_temporary_reference_placed_after_timeout', {
          position,
          blockName,
          recoveredFrom: err?.message || String(err)
        })
      }
      lastError = new Error(stable.error || err?.message || String(err))
    }
  }
  return fail(lastError?.message || 'stair_temporary_reference_failed')
}

// How far the block is from the eye, by the same measure mineflayer uses to
// decide whether a dig can possibly land.
function temporaryReferenceClearReach(bot, position, block = null) {
  const current = bot?.entity?.position
  if (!current || !position) return { distance: Infinity, withinReach: false }
  const distance = Math.sqrt(
    (position.x + 0.5 - current.x) ** 2 +
    (position.y + 0.5 - (current.y + 1.65)) ** 2 +
    (position.z + 0.5 - current.z) ** 2
  )
  // Both, not either: the distance is the bound the server enforces, and
  // canDigBlock adds mineflayer's own conditions (diggable at all) on top. A
  // wrapper that answers true to everything must not be able to put the lie
  // back.
  if (distance > TEMPORARY_REFERENCE_CLEAR_REACH) return { distance, withinReach: false }
  if (block && typeof bot?.canDigBlock === 'function') {
    try {
      return { distance, withinReach: bot.canDigBlock(block) === true }
    } catch {
      return { distance, withinReach: true }
    }
  }
  return { distance, withinReach: true }
}

// Cells we could not verify. The client world is not evidence for these -
// a dig we could not reach leaves bot.blockAt reading air forever (until the
// chunk reloads), so a later pass would otherwise call the same cell
// "already clear". Build-18/20 cleared 598,69,-18 five times that way.
const temporaryReferenceResidueByBot = new WeakMap()

function temporaryReferenceResidueLedger(context, create = false) {
  const key = context?.bot || context
  if (!key || typeof key !== 'object') return null
  let ledger = temporaryReferenceResidueByBot.get(key)
  if (!ledger && create) {
    ledger = new Map()
    temporaryReferenceResidueByBot.set(key, ledger)
  }
  return ledger || null
}

function recordTemporaryReferenceResidue(context, position, blockName, distance) {
  const ledger = temporaryReferenceResidueLedger(context, true)
  if (!ledger) return
  ledger.set(formatPos(position), {
    position: { x: position.x, y: position.y, z: position.z },
    blockName: blockName || 'unknown',
    distance,
    at: Date.now()
  })
}

function forgetTemporaryReferenceResidue(context, position) {
  temporaryReferenceResidueLedger(context)?.delete(formatPos(position))
}

function isUnverifiedTemporaryReferenceCell(context, position) {
  return temporaryReferenceResidueLedger(context)?.has(formatPos(position)) === true
}

async function clearTemporaryReferenceBlock(context, position, params = {}) {
  const { lockOwner, options = {} } = params
  const bot = context?.bot
  let block = bot?.blockAt?.(toBlockVec3(position))

  const lock = context?.actionLock?.acquireMany
    ? context.actionLock.acquireMany(['digging'], lockOwner || 'stair_temporary_reference', {
      reason: 'stair_temporary_reference_cleanup',
      timeoutMs: options.lockTimeoutMs
    })
    : { ok: true }
  if (!lock.ok) return fail(lock.reason || 'stair_temporary_reference_dig_lock_failed')

  try {
    if (typeof bot?.dig !== 'function') return fail('missing_dig')
    const maxAttempts = Math.max(1, Number(options.temporaryReferenceClearAttempts ?? 3))
    let approachAttempted = false
    let lastError = null
    let clearedBlockName = block?.name || 'air'
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      block = bot?.blockAt?.(toBlockVec3(position))
      const solid = Boolean(block) && !AIR_BLOCKS.has(block.name)
      // A cell we already failed to verify reads as air here even though the
      // server still has the block: never take that as "already clear".
      const unverified = !solid && isUnverifiedTemporaryReferenceCell(context, position)
      if (solid || unverified) {
        if (solid) clearedBlockName = block.name
        let reach = temporaryReferenceClearReach(bot, position, solid ? block : null)
        // Out of reach is not the same as impossible: walking to the column
        // costs one bounded move and turns a cell that would be left behind
        // into one that really goes away. No scaffolding and no digging on
        // the way - a cleanup that builds its own residue helps nobody.
        if (!reach.withinReach && !approachAttempted && options.walkIntoReachBeforeClear !== false) {
          approachAttempted = true
          const approach = await moveTo(context, position, {
            owner: lockOwner,
            range: Math.max(1, Number(options.temporaryReferenceClearApproachRange ?? 3)),
            timeoutMs: Math.max(1000, Number(options.temporaryReferenceClearApproachTimeoutMs ?? 8000)),
            canDig: false,
            allowScaffolding: false,
            holdLock: true
          })
          block = bot?.blockAt?.(toBlockVec3(position))
          const stillSolid = Boolean(block) && !AIR_BLOCKS.has(block.name)
          if (stillSolid) clearedBlockName = block.name
          reach = temporaryReferenceClearReach(bot, position, stillSolid ? block : null)
          context.logger?.log?.(
            `[BUILD_TEMP_REFERENCE_CLEAR_APPROACH] pos=${formatPos(position)} ` +
            `result=${approach.ok ? 'moved' : (approach.error || 'failed')} ` +
            `distance=${reach.distance.toFixed(2)} inReach=${reach.withinReach}`
          )
        }
        if (!reach.withinReach) {
          context.logger?.log?.(
            `[BUILD_TEMP_REFERENCE_CLEAR_UNREACHABLE] pos=${formatPos(position)} ` +
            `block=${clearedBlockName} distance=${reach.distance.toFixed(2)} ` +
            `reach=${TEMPORARY_REFERENCE_CLEAR_REACH} ` +
            `clientSays=${block?.name || 'air'} reason=${unverified ? 'unverified_client_air' : 'out_of_reach'}`
          )
          recordTemporaryReferenceResidue(context, position, clearedBlockName, reach.distance)
          return fail(`temporary_reference_clear_unreachable:${clearedBlockName}`, {
            position,
            distance: reach.distance,
            unreachable: true
          })
        }
      }
      if (solid) {
        const buildingGuard = checkProtectedBuildingDig(context, position, {
          source: 'build.stairTemporaryReferenceClear',
          exemptRunId: options.protectionExemptRunId
        })
        if (!buildingGuard.allowed) return fail(`protected_building_dig_blocked:${buildingGuard.region.runId}`)
        try {
          await bot.dig(block)
        } catch (err) {
          lastError = err
        }
      }

      const stable = await confirmTemporaryReferenceClear(context, position, options)
      if (stable.ok) {
        forgetTemporaryReferenceResidue(context, position)
        context.logger?.log?.(
          `[BUILD_STAIR_TEMP_REFERENCE_CLEAR] pos=${formatPos(position)} ` +
          `block=${clearedBlockName} attempts=${attempt} stableMs=${stable.data?.stableMs ?? 0}`
        )
        return ok(
          block && !AIR_BLOCKS.has(block.name)
            ? 'stair_temporary_reference_cleared'
            : 'stair_temporary_reference_already_clear',
          { attempts: attempt, stableMs: stable.data?.stableMs ?? 0 }
        )
      }

      lastError = new Error(stable.error || lastError?.message || 'temporary_reference_clear_not_stable')
      if (attempt < maxAttempts) {
        context.logger?.log?.(
          `[BUILD_STAIR_TEMP_REFERENCE_CLEAR_RETRY] pos=${formatPos(position)} ` +
          `attempt=${attempt + 1} reason=${lastError.message}`
        )
        await sleep(options.temporaryReferenceClearRetryDelayMs ?? 120)
      }
    }
    const after = bot?.blockAt?.(toBlockVec3(position))
    return fail(
      `stair_temporary_reference_clear_failed:${after?.name || lastError?.message || 'unstable'}`
    )
  } finally {
    if (context?.actionLock?.release && lockOwner) {
      context.actionLock.release('digging', lockOwner)
    }
  }
}

async function confirmTemporaryReferenceClear(context, position, options = {}) {
  const requiredStableMs = Math.max(0, Number(options.temporaryReferenceClearStableMs ?? 350))
  const pollMs = Math.max(1, Number(options.temporaryReferenceClearPollMs ?? 50))
  const timeoutMs = Math.max(
    requiredStableMs,
    Number(options.temporaryReferenceClearConfirmTimeoutMs ?? 1200)
  )
  const deadline = Date.now() + timeoutMs
  let clearSince = null
  let lastBlockName = null
  while (Date.now() <= deadline) {
    const block = context?.bot?.blockAt?.(toBlockVec3(position))
    if (!block || AIR_BLOCKS.has(block.name)) {
      if (clearSince == null) clearSince = Date.now()
      const stableMs = Date.now() - clearSince
      if (stableMs >= requiredStableMs) {
        return ok('temporary_reference_clear_stable', { stableMs })
      }
    } else {
      lastBlockName = block.name
      clearSince = null
    }
    await sleep(pollMs)
  }
  return fail(`temporary_reference_clear_not_stable:${lastBlockName || 'air_reappeared'}`)
}

function isPlacementStateMismatchError(err) {
  return /place_failed:state_mismatch:/i.test(String(err?.message || err || ''))
}

function placementMaterialRefillResult(context, blockName, reason) {
  const itemName = itemNameForBlock(blockName)
  const available = (context?.bot?.inventory?.items?.() || [])
    .filter(item => item?.name === itemName)
    .reduce((sum, item) => sum + Math.max(0, Number(item.count) || 0), 0)
  if (available > 0) return null
  return fail(`placement_retry_requires_material_refill:${itemName}`, {
    recoverable: true,
    recoveryType: 'material_refill',
    itemName,
    consumedBy: 'wrong_state_cleanup',
    placementError: reason || null
  })
}

async function clearWrongStatePlacement(context, target, blockName, params = {}) {
  const { lockOwner, options = {}, reason = 'state_mismatch' } = params
  const bot = context?.bot
  const block = bot?.blockAt?.(toBlockVec3(target))
  if (!block || block.name !== blockName) return ok('stateful_stair_wrong_state_already_clear')

  const owner = lockOwner || 'stateful_stair_retry_clear'
  const lock = context?.actionLock?.acquireMany
    ? context.actionLock.acquireMany(['digging'], owner, {
      reason: 'stateful_stair_retry_clear',
      timeoutMs: options.lockTimeoutMs
    })
    : { ok: true, owner }
  if (!lock.ok) return fail(lock.reason || 'stateful_stair_retry_clear_lock_failed')

  try {
    if (typeof bot?.dig !== 'function') return fail('missing_dig')
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
      return fail(`stateful_stair_retry_clear_not_diggable:${block.name}`)
    }
    {
      const buildingGuard = checkProtectedBuildingDig(context, target, {
        source: 'build.statefulStairRetryClear',
        exemptRunId: options.protectionExemptRunId
      })
      if (!buildingGuard.allowed) return fail(`protected_building_dig_blocked:${buildingGuard.region.runId}`)
    }
    await bot.dig(block)
    const after = bot.blockAt?.(toBlockVec3(target))
    if (after?.name === blockName) return fail(`stateful_stair_retry_clear_failed:${after.name}`)
    context.logger?.log?.(`[BUILD_STAIR_STATE_RETRY_CLEAR] target=${formatPos(target)} block=${blockName} reason=${reason}`)
    return ok('stateful_stair_wrong_state_cleared')
  } finally {
    if (context?.actionLock?.release) {
      context.actionLock.release('digging', owner)
    }
  }
}

async function equipItemForPlacement(context, itemName, options = {}) {
  const bot = context?.bot
  const blockName = options.blockName || itemName
  if (!bot?.inventory?.items) return fail('missing_inventory')
  if (bot.heldItem?.name === itemName) {
    return ok('block_already_equipped', { blockName, itemName, heldAlready: true })
  }
  let item = bot.inventory.items().find(candidate => candidate.name === itemName)
  if (!item) return fail('block_item_not_found')

  const equipmentSystem = context.equipmentSystem || context.autoPreparationSystem?.equipmentSystem
  const hasStrictEquipmentSystem = equipmentSystem && typeof equipmentSystem.equipBlockForBuilding === 'function'
  if (hasStrictEquipmentSystem && options.useEquipmentSystem !== false) {
    const equipResult = await equipmentSystem.equipBlockForBuilding(blockName, context)
    const inventoryOwner = context.actionLock?.getOwner?.('inventory')
    const canUseExistingOwnerLock = equipResult.reason === 'inventory_lock_busy' &&
      options.owner &&
      inventoryOwner === options.owner
    if (!equipResult.success && !canUseExistingOwnerLock) return fail('cannot_equip_block', equipResult)
    if (!equipResult.success && canUseExistingOwnerLock) {
      context.logger?.log?.(`[BUILD_EQUIP_OWNER_LOCK_FALLBACK] block=${blockName} item=${itemName} owner=${options.owner}`)
    }
  }

  if (bot.heldItem?.name !== itemName) {
    if (typeof bot.equip !== 'function') return fail(`block_not_held:${bot.heldItem?.name || 'empty'}:${itemName}`)
    item = bot.inventory.items().find(candidate => candidate.name === itemName)
    if (!item) return fail('block_item_not_found')
    const equipped = await equipPlacementItemWithRetry(context, itemName, item)
    if (!equipped.ok) return equipped
  }

  if (bot.heldItem?.name !== itemName) {
    context.logger?.log?.(`[BUILD_EQUIP_UNCONFIRMED] block=${blockName} item=${itemName} held=${bot.heldItem?.name || 'empty'}`)
  }
  return ok('block_equipped', { blockName, itemName })
}

async function equipPlacementItemWithRetry(context, itemName, item) {
  const bot = context?.bot
  const maxAttempts = 3
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.equip(item, 'hand')
      if (bot.heldItem?.name === itemName) {
        return ok(attempt > 1 ? 'block_equipped_after_retry' : 'block_equipped', { itemName, attempts: attempt })
      }
      lastError = new Error(`block_equip_unconfirmed:${bot.heldItem?.name || 'empty'}:${itemName}`)
    } catch (err) {
      if (bot.heldItem?.name === itemName) {
        return ok('block_equipped_after_timeout', { itemName, attempts: attempt, recoveredFrom: err.message })
      }
      lastError = err
    }
    if (!isTransientEquipError(lastError) && !String(lastError?.message || '').startsWith('block_equip_unconfirmed')) break
    if (attempt >= maxAttempts) break
    context.logger?.log?.(`[BUILD_EQUIP_RETRY] item=${itemName} attempt=${attempt + 1} reason=${lastError.message}`)
    await sleep(250)
    item = bot.inventory.items().find(candidate => candidate.name === itemName)
    if (!item) return fail('block_item_not_found')
  }
  return fail(lastError?.message || 'block_equip_failed')
}

function isTransientEquipError(err) {
  return /updateSlot|did not fire within timeout|window.*timeout|inventory.*timeout/i.test(String(err?.message || err || ''))
}

async function ensurePlacementReach(context, params) {
  const {
    lockOwner,
    moveTarget,
    safeApproach,
    safeApproachCandidates,
    shouldUseSafeApproach,
    target,
    placeDistance,
    options,
    forceReposition
  } = params
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')
  const retryReposition = forceReposition === true && safeApproach
  if (isPlacementReachable(bot, target, placeDistance) && !retryReposition) {
    return ok('placement_reachable')
  }

  const destination = retryReposition ? safeApproach : (shouldUseSafeApproach ? safeApproach : moveTarget)
  if (!destination) return fail('placement_target_occupied')
  if (retryReposition && Array.isArray(safeApproachCandidates) && safeApproachCandidates.length > 0) {
    return moveToFirstReachablePlacementStand(context, target, safeApproachCandidates, {
      owner: lockOwner,
      options,
      placeDistance,
      reason: 'placement_retry_reposition'
    })
  }
  if (shouldUseSafeApproach || retryReposition) {
    context.logger?.log?.(`[BUILD_PLACE_REPOSITION] target=${formatPos(target)} stand=${formatPos(destination)} reason=${retryReposition ? 'placement_retry_reposition' : 'placement_retry_or_drift'}`)
  }
  const moved = await moveTo(context, destination, {
    owner: lockOwner,
    range: (shouldUseSafeApproach || retryReposition) ? safeMoveRangeForStand(destination, target, options) : (options.moveRange ?? 2),
    timeoutMs: standMoveTimeoutWithMemo(context, destination, options),
    canDig: options.canDig ?? false,
    allowScaffolding: options.allowScaffolding === true,
    ...movementScaffoldExclusions(options, target),
    holdLock: true
  })
  if (!moved.ok && moved.error === 'move_timeout') rememberStandTimeout(options, destination)
  return moved
}

function isPlacementRetryableError(err) {
  const message = String(err?.message || err || '')
  return /blockUpdate|timeout|not_changed|unstable_air|not_stable|No block has been placed/i.test(message)
}

function isRetryableClearError(err) {
  const message = String(err?.message || err || '')
  return /Digging aborted|digging aborted|aborted|interrupted|timeout|blockUpdate|not_empty/i.test(message)
}

async function digBlockWithTimeout(bot, block, timeoutMs) {
  let timeoutHandle = null
  try {
    await Promise.race([
      Promise.resolve().then(() => bot.dig(block)),
      new Promise((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          try {
            bot.stopDigging?.()
          } catch {}
          reject(new Error(`dig_timeout:${block?.name || 'unknown'}:${timeoutMs}`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function clearDigTimeoutMs(options = {}) {
  const explicit = Number(options.digTimeoutMs)
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, explicit)
  const actionTimeout = Number(options.timeoutMs)
  if (Number.isFinite(actionTimeout) && actionTimeout > 0) return Math.max(1000, actionTimeout)
  return 15000
}

function isBuildingDigTimeout(err) {
  return /^dig_timeout:/.test(String(err?.message || err || ''))
}

function isWrongBlockPlacementError(err) {
  return /placed_wrong_block:|place_failed:unstable:(?!air\b)/i.test(String(err?.message || err || ''))
}

function recoverPlacementReachAfterMoveFailure(context, target, blockName, placeDistance, options = {}, moved = {}) {
  if (moved.error !== 'move_timeout') return { ok: false, reason: 'not_move_timeout' }
  return currentPlacementReachability(context, target, blockName, placeDistance, options)
}

function currentPlacementReachability(context, target, blockName, placeDistance, options = {}, referencePosition = null) {
  if (referencePosition && isReferenceReachableFromCurrentPosition(context?.bot, referencePosition, placeDistance)) {
    return { ok: true, reason: 'partial_move_reference_reachable' }
  }
  if (isPlacementReachable(context?.bot, target, placeDistance)) {
    return { ok: true, reason: 'current_placement_reach' }
  }
  if (canUseCurrentReachForHighTarget(context?.bot, target, placeDistance, options)) {
    return { ok: true, reason: 'current_high_target_reach' }
  }
  if (blockName && canUseCurrentReferenceForHighTarget(context, target, blockName, placeDistance, options)) {
    return { ok: true, reason: 'current_high_reference_reach' }
  }
  if (blockName && canUseCurrentReferenceForStatefulTarget(context, target, blockName, placeDistance, options)) {
    return { ok: true, reason: 'current_stateful_reference_reach' }
  }
  return { ok: false, reason: 'placement_still_unreachable' }
}

function isHeldItemPlacementError(err) {
  return /must be holding an item|held item|not holding/i.test(String(err?.message || err || ''))
}

function placementAttemptsForBlock(blockName, options = {}) {
  if (options.placementAttempts != null) {
    return Math.max(1, Number(options.placementAttempts))
  }
  return needsStableConfirmation(blockName) ? 3 : 2
}

async function confirmPlacedBlock(context, target, blockName, options = {}) {
  if (shouldWaitForServerPlacement(blockName, options)) {
    await sleep(options.stableConfirmDelayMs ?? 180)
  }
  let after = context?.bot?.blockAt?.(toBlockVec3(target))
  if (placementBlockNameMatches(after?.name, blockName, placementStates(options))) {
    const states = placementStates(options)
    const doorAligned = await alignDoorOpenState(context, target, blockName, states, options)
    if (!doorAligned.ok) return doorAligned
    const fenceGateAligned = await alignFenceGateOpenState(context, target, blockName, states, options)
    if (!fenceGateAligned.ok) return fenceGateAligned
    after = context?.bot?.blockAt?.(toBlockVec3(target))
    const stateMismatch = expectedPlacementStateMismatch(after, blockName, options)
    if (stateMismatch) return fail(`place_failed:state_mismatch:${stateMismatch}`)
    // Tune AFTER the placement gate, not before: a block that landed facing the
    // wrong way is about to be dug and placed again, so clicking its delay now
    // would just burn right-clicks on a block that will not survive.
    const tuned = await alignPostPlaceTunedStates(context, target, blockName, states, options)
    if (!tuned.ok) return tuned
    if (after?.name !== blockName && legacyBlockNameMatches(after?.name, blockName, states)) {
      context.logger?.log?.(
        `[BUILD_LEGACY_BLOCK_VARIANT_VERIFIED] target=${formatPos(target)} expected=${blockName} actual=${after.name} legacyId=${states.legacyId ?? 'unknown'} legacyData=${states.legacyData ?? 'unknown'}`
      )
    }
    return ok('block_stable')
  }
  return fail(after && !AIR_BLOCKS.has(after.name)
    ? `place_failed:unstable:${after.name}`
    : 'place_failed:unstable_air')
}

async function confirmStatefulPlacedBlock(context, target, blockName, states = null, options = {}) {
  const aligned = await alignTrapdoorOpenState(context, target, blockName, states, options)
  if (!aligned.ok) return aligned
  return confirmPlacedBlock(context, target, blockName, options)
}

async function alignTrapdoorOpenState(context, target, blockName, states = null, options = {}) {
  if (!isTrapdoorBlockName(blockName) || states?.open == null) {
    return ok('trapdoor_open_state_not_required')
  }
  const bot = context?.bot
  let current = bot?.blockAt?.(toBlockVec3(target))
  if (current?.name !== blockName) return ok('trapdoor_not_placed_yet')
  const expectedOpen = String(states.open).toLowerCase()
  let actualOpen = String(blockProperties(current).open).toLowerCase()
  if (actualOpen === expectedOpen) return ok('trapdoor_open_state_already_aligned')
  if (typeof bot?.activateBlock !== 'function') return fail('trapdoor_open_activation_unavailable')

  context.logger?.log?.(`[BUILD_TRAPDOOR_OPEN_STATE_TOGGLE] target=${formatPos(target)} block=${blockName} open=${expectedOpen}`)
  try {
    await bot.activateBlock(current)
  } catch (err) {
    return fail(err?.message || 'trapdoor_open_activation_failed')
  }
  await sleep(options.stableConfirmDelayMs ?? 180)
  current = bot.blockAt?.(toBlockVec3(target))
  actualOpen = String(blockProperties(current).open).toLowerCase()
  if (current?.name !== blockName || actualOpen !== expectedOpen) {
    return fail(`place_failed:state_mismatch:open:${actualOpen || 'unknown'}!=${expectedOpen}`)
  }
  return ok('trapdoor_open_state_aligned')
}

// Repeater delay and comparator mode are set by right-clicking the block
// AFTER it is down — no placement can carry them. They are the last two
// states on the fort that both rulers still call a real gap (round 10 left
// them comparing on purpose). One activateBlock steps a repeater delay
// 1→2→3→4→1 and flips a comparator compare↔subtract.
const REPEATER_DELAY_CYCLE = 4

function postPlaceTunedStateKeys(blockName) {
  if (String(blockName) === 'repeater') return ['delay']
  if (String(blockName) === 'comparator') return ['mode']
  return []
}

async function alignRepeaterDelayState(context, target, blockName, states = null, options = {}) {
  if (String(blockName) !== 'repeater' || states?.delay == null) {
    return ok('repeater_delay_not_required')
  }
  const bot = context?.bot
  let current = bot?.blockAt?.(toBlockVec3(target))
  if (current?.name !== blockName) return ok('repeater_not_placed_yet')
  const expected = Number(states.delay)
  let actual = Number(blockProperties(current).delay)
  if (!Number.isFinite(expected) || expected < 1 || expected > REPEATER_DELAY_CYCLE) {
    return ok('repeater_delay_unknown_target')
  }
  if (!Number.isFinite(actual)) return ok('repeater_delay_unreadable')
  if (actual === expected) return ok('repeater_delay_already_aligned')
  if (typeof bot?.activateBlock !== 'function') return fail('repeater_delay_activation_unavailable')

  const clicks = ((expected - actual) % REPEATER_DELAY_CYCLE + REPEATER_DELAY_CYCLE) % REPEATER_DELAY_CYCLE
  context.logger?.log?.(`[BUILD_REPEATER_DELAY_TUNE] target=${formatPos(target)} block=${blockName} delay=${actual}->${expected} clicks=${clicks}`)
  for (let click = 0; click < clicks; click++) {
    try {
      await bot.activateBlock(current)
    } catch (err) {
      return fail(err?.message || 'repeater_delay_activation_failed')
    }
    await sleep(options.tuneClickDelayMs ?? 120)
    current = bot.blockAt?.(toBlockVec3(target))
    if (current?.name !== blockName) return fail('repeater_delay_block_vanished')
  }
  actual = Number(blockProperties(current).delay)
  if (actual !== expected) {
    return fail(`place_failed:state_mismatch:delay:${Number.isFinite(actual) ? actual : 'unknown'}!=${expected}`)
  }
  return ok('repeater_delay_aligned')
}

async function alignComparatorModeState(context, target, blockName, states = null, options = {}) {
  if (String(blockName) !== 'comparator' || states?.mode == null) {
    return ok('comparator_mode_not_required')
  }
  const bot = context?.bot
  let current = bot?.blockAt?.(toBlockVec3(target))
  if (current?.name !== blockName) return ok('comparator_not_placed_yet')
  const expected = String(states.mode).toLowerCase()
  let actual = String(blockProperties(current).mode).toLowerCase()
  if (!['compare', 'subtract'].includes(expected)) return ok('comparator_mode_unknown_target')
  if (actual === expected) return ok('comparator_mode_already_aligned')
  if (typeof bot?.activateBlock !== 'function') return fail('comparator_mode_activation_unavailable')

  context.logger?.log?.(`[BUILD_COMPARATOR_MODE_TUNE] target=${formatPos(target)} block=${blockName} mode=${actual}->${expected}`)
  try {
    await bot.activateBlock(current)
  } catch (err) {
    return fail(err?.message || 'comparator_mode_activation_failed')
  }
  await sleep(options.tuneClickDelayMs ?? 120)
  current = bot.blockAt?.(toBlockVec3(target))
  actual = String(blockProperties(current).mode).toLowerCase()
  if (current?.name !== blockName || actual !== expected) {
    return fail(`place_failed:state_mismatch:mode:${actual || 'unknown'}!=${expected}`)
  }
  return ok('comparator_mode_aligned')
}

async function alignPostPlaceTunedStates(context, target, blockName, states = null, options = {}) {
  const delayAligned = await alignRepeaterDelayState(context, target, blockName, states, options)
  if (!delayAligned.ok) return delayAligned
  return alignComparatorModeState(context, target, blockName, states, options)
}

async function alignDoorOpenState(context, target, blockName, states = null, options = {}) {
  if (!isDoorBlockName(blockName) || states?.open == null) {
    return ok('door_open_state_not_required')
  }
  const bot = context?.bot
  let current = bot?.blockAt?.(toBlockVec3(target))
  if (current?.name !== blockName) return ok('door_not_placed_yet')
  const expectedOpen = String(states.open).toLowerCase()
  let actualOpen = String(blockProperties(current).open).toLowerCase()
  if (actualOpen === expectedOpen) return ok('door_open_state_already_aligned')
  if (typeof bot?.activateBlock !== 'function') return fail('door_open_activation_unavailable')

  context.logger?.log?.(`[BUILD_DOOR_OPEN_STATE_TOGGLE] target=${formatPos(target)} block=${blockName} open=${expectedOpen}`)
  try {
    await bot.activateBlock(current)
  } catch (err) {
    return fail(err?.message || 'door_open_activation_failed')
  }
  await sleep(options.stableConfirmDelayMs ?? 180)
  current = bot.blockAt?.(toBlockVec3(target))
  actualOpen = String(blockProperties(current).open).toLowerCase()
  if (current?.name !== blockName || actualOpen !== expectedOpen) {
    return fail(`place_failed:state_mismatch:open:${actualOpen || 'unknown'}!=${expectedOpen}`)
  }
  return ok('door_open_state_aligned')
}

async function alignFenceGateOpenState(context, target, blockName, states = null, options = {}) {
  if (!isFenceGateBlockName(blockName) || states?.open == null) {
    return ok('fence_gate_open_state_not_required')
  }
  const bot = context?.bot
  let current = bot?.blockAt?.(toBlockVec3(target))
  if (current?.name !== blockName) return ok('fence_gate_not_placed_yet')
  const expectedOpen = String(states.open).toLowerCase()
  let actualOpen = String(blockProperties(current).open).toLowerCase()
  if (actualOpen === expectedOpen) return ok('fence_gate_open_state_already_aligned')
  if (typeof bot?.activateBlock !== 'function' && typeof bot?._client?.write !== 'function') {
    return fail('fence_gate_open_activation_unavailable')
  }

  const expectedFacing = String(states.facing || '').toLowerCase()
  const facingOffset = horizontalOffsetForFacing(expectedFacing)
  if (expectedOpen === 'true' && facingOffset) {
    const oriented = await lookTowardDirection(context, target, blockName, {
      x: facingOffset.x,
      z: facingOffset.z,
      facing: expectedFacing,
      forceLook: false,
      settleDelayMs: 120,
      source: 'fence_gate_open_preserve_facing'
    })
    if (!oriented.ok) return oriented
  }

  context.logger?.log?.(`[BUILD_FENCE_GATE_OPEN_STATE_TOGGLE] target=${formatPos(target)} block=${blockName} open=${expectedOpen}`)
  try {
    const activated = await activateFenceGateWithoutReorienting(bot, current)
    if (!activated.ok) return activated
  } catch (err) {
    return fail(err?.message || 'fence_gate_open_activation_failed')
  }
  await sleep(options.stableConfirmDelayMs ?? 180)
  current = bot.blockAt?.(toBlockVec3(target))
  const actualProperties = blockProperties(current)
  actualOpen = String(actualProperties.open).toLowerCase()
  if (current?.name !== blockName || actualOpen !== expectedOpen) {
    return fail(`place_failed:state_mismatch:open:${actualOpen || 'unknown'}!=${expectedOpen}`)
  }
  const actualFacing = String(actualProperties.facing || '').toLowerCase()
  if (expectedFacing && actualFacing !== expectedFacing) {
    return fail(`place_failed:state_mismatch:facing:${actualFacing || 'unknown'}!=${expectedFacing}`)
  }
  return ok('fence_gate_open_state_aligned')
}

async function activateFenceGateWithoutReorienting(bot, block) {
  const pos = block?.position
  if (!pos) return fail('fence_gate_open_activation_missing_position')
  if (typeof bot?.supportFeature === 'function' && typeof bot?._client?.write === 'function') {
    const packet = {
      location: pos,
      direction: 1,
      hand: 0,
      cursorX: 0.5,
      cursorY: 0.5,
      cursorZ: 0.5
    }
    if (bot.supportFeature('blockPlaceHasHandAndIntCursor')) {
      packet.cursorX = 8
      packet.cursorY = 8
      packet.cursorZ = 8
    } else if (bot.supportFeature('blockPlaceHasHandAndFloatCursor')) {
      // The base packet already has the float cursor fields for this protocol.
    } else if (bot.supportFeature('blockPlaceHasInsideBlock')) {
      packet.insideBlock = false
      packet.sequence = 0
      packet.worldBorderHit = false
    } else {
      return fail('fence_gate_open_activation_protocol_unsupported')
    }
    bot._client.write('block_place', packet)
    bot.swingArm?.()
    return ok('fence_gate_open_activation_sent_without_reorient')
  }
  if (typeof bot?.activateBlock !== 'function') return fail('fence_gate_open_activation_unavailable')
  await bot.activateBlock(block)
  return ok('fence_gate_open_activation_sent')
}

function blockProperties(block) {
  if (typeof block?.getProperties !== 'function') return {}
  try {
    return block.getProperties() || {}
  } catch {
    return {}
  }
}

function needsStableConfirmation(blockName) {
  const value = String(blockName || '')
  return /_stairs$/.test(value) ||
    /_slab$/.test(value) ||
    value === 'ladder' ||
    isFluidBlockName(value) ||
    isCandleBlockName(value)
}

function shouldWaitForServerPlacement(blockName, options = {}) {
  return needsStableConfirmation(blockName) ||
    options.forceSafeApproach === true ||
    options.requireServerConfirmation === true
}

async function waitForPlacedBlock(context, target, blockName, timeoutMs = 800, intervalMs = 80) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    if (context?.bot?.blockAt?.(toBlockVec3(target))?.name === blockName) return true
    await sleep(intervalMs)
  }
  return context?.bot?.blockAt?.(toBlockVec3(target))?.name === blockName
}

async function waitForBlockNameInSet(context, target, blockNames, options = {}) {
  const names = blockNames instanceof Set ? blockNames : new Set(blockNames || [])
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 800))
  const intervalMs = Math.max(1, Number(options.intervalMs ?? 80))
  const deadline = Date.now() + timeoutMs
  let block = context?.bot?.blockAt?.(toBlockVec3(target))
  while (Date.now() <= deadline) {
    if (names.has(block?.name)) return block
    await sleep(intervalMs)
    block = context?.bot?.blockAt?.(toBlockVec3(target))
  }
  return names.has(block?.name) ? block : null
}

async function placeBlockAgainstReference(context, reference, target, blockName = null, options = {}) {
  const bot = context?.bot
  const faceVector = getFaceVector(reference.position, target)
  if (isFluidBlockName(blockName) && typeof bot?.activateBlock === 'function') {
    const faceCursor = cursorPositionForFace(faceVector)
    const bucketItem = itemNameForBlock(blockName)
    if (
      options.allowFluidActivateItemFallback !== false &&
      typeof bot.activateItem === 'function' &&
      typeof bot.lookAt === 'function'
    ) {
      const activationCursor = safeFluidActivationCursor(faceVector)
      if (!activationCursor) {
        context.logger?.log?.(
          `[BUILD_BUCKET_ACTIVATE_ITEM_SKIPPED] target=${formatPos(target)} ` +
          `reference=${formatPos(reference.position)} block=${blockName} ` +
          'reason=non_horizontal_reference hit=none'
        )
      } else {
        const visibleReference = visibleFluidActivationReference(bot, reference, activationCursor)
        if (visibleReference.ok) {
          const lookTarget = reference.position.offset(
            activationCursor.x,
            activationCursor.y,
            activationCursor.z
          )
          context.logger?.log?.(`[BUILD_BUCKET_ACTIVATE_ITEM] target=${formatPos(target)} reference=${formatPos(reference.position)} block=${blockName}`)
          await bot.lookAt(lookTarget, false)
          await bot.activateItem()
          await waitForPlacedBlock(
            context,
            target,
            blockName,
            options.fluidActivationConfirmMs ?? 900,
            options.fluidActivationPollMs ?? 80
          )
          return
        }
        context.logger?.log?.(
          `[BUILD_BUCKET_ACTIVATE_ITEM_SKIPPED] target=${formatPos(target)} ` +
          `reference=${formatPos(reference.position)} block=${blockName} ` +
          `reason=${visibleReference.reason} hit=${visibleReference.hit || 'none'}`
        )
      }
    }
    context.logger?.log?.(`[BUILD_BUCKET_PLACE] target=${formatPos(target)} reference=${formatPos(reference.position)} block=${blockName}`)
    await bot.activateBlock(reference, faceVector, faceCursor)
    if (await waitForPlacedBlock(
      context,
      target,
      blockName,
      options.fluidActivationConfirmMs ?? 900,
      options.fluidActivationPollMs ?? 80
    )) return
    const heldName = bot.heldItem?.name
    if (heldName && heldName !== bucketItem) {
      context.logger?.log?.(`[BUILD_BUCKET_CONSUMED_UNCONFIRMED] target=${formatPos(target)} block=${blockName} held=${heldName}`)
    }
    return
  }
  if (isBedBlockName(blockName) && typeof bot?._genericPlace === 'function') {
    // Bed facing derives from player yaw at placement time. bot.placeBlock
    // re-looks at the click face and overrides the south/north/east/west yaw
    // set by orientBotForPlacement (live: L3 bed landed facing=east), so
    // place without changing the look and confirm the block appeared.
    context.logger?.log?.(`[BUILD_BED_PLACE_KEEP_YAW] target=${formatPos(target)} reference=${formatPos(reference.position)}`)
    await bot._genericPlace(reference, faceVector, { forceLook: 'ignore', swingArm: 'right' })
    if (await waitForPlacedBlock(context, target, blockName, options.bedPlaceConfirmMs ?? 1200, 80)) return
    return
  }
  const modernForRotation = modernizeLegacyBlock(blockName, options.blockStates || options.states || options.orientation)
  const expectedRotation = Number(modernForRotation.states?.rotation)
  if (Number.isFinite(expectedRotation) &&
    isRotationPlacedBlockName(modernForRotation.blockName) &&
    typeof bot?._genericPlace === 'function') {
    // Standing skulls/heads/banners/signs take their 16-direction rotation
    // from player yaw at placement, same class as the bed branch above: keep
    // the yaw set by orientBotForPlacement instead of re-looking at the face
    // (live round 7: skull landed rotation=4 where the blueprint wanted 15).
    context.logger?.log?.(`[BUILD_ROTATION_PLACE_KEEP_YAW] target=${formatPos(target)} reference=${formatPos(reference.position)} block=${blockName} rotation=${expectedRotation}`)
    await bot._genericPlace(reference, faceVector, { forceLook: 'ignore', swingArm: 'right' })
    if (await waitForPlacedBlock(context, target, blockName, options.rotationPlaceConfirmMs ?? 1200, 80)) return
    return
  }
  const orientedLook = orientedPlacementLookDirection(blockName, placementStates(options))
  const shouldSneak = shouldSneakForPlacementReference(reference) &&
    typeof bot?.setControlState === 'function'

  if (orientedLook && typeof bot?._genericPlace === 'function') {
    // Repeaters, comparators, pistons, droppers, dispensers and observers take
    // their facing from the player's look at the moment of the click, and
    // orientBotForPlacement has just turned her the right way. bot.placeBlock
    // would look at the click face first and throw that away — the same trap
    // the bed and standing-rotation branches above already step around (boss
    // decision #58: round 11 turned her, this is what makes the turn count).
    // The sneak from round 9 has to survive it: without it a right-click
    // against a hopper or a chest opens the container instead of placing.
    context.logger?.log?.(`[BUILD_ORIENTED_PLACE_KEEP_YAW] target=${formatPos(target)} reference=${formatPos(reference.position)} block=${blockName} facing=${orientedLook.facing} source=${orientedLook.source} sneak=${shouldSneak}`)
    if (shouldSneak) {
      bot.setControlState('sneak', true)
      await sleep(80)
    }
    try {
      // Last thing before the placement packet, and in the same synchronous
      // block: anything that steered the look meanwhile is overruled.
      const looked = sendPlacementLookPacket(context, orientedLook)
      context.logger?.log?.(`[BUILD_PLACE_LOOK_SYNCED] target=${formatPos(target)} block=${blockName} facing=${orientedLook.facing} sent=${looked.sent} pitch=${looked.pitch === undefined ? 'none' : looked.pitch.toFixed(3)} yaw=${looked.yaw === undefined ? 'none' : looked.yaw.toFixed(3)}${looked.sent ? '' : ` reason=${looked.reason}`}`)
      await bot._genericPlace(reference, faceVector, { forceLook: 'ignore', swingArm: 'right' })
    } finally {
      if (shouldSneak) bot.setControlState('sneak', false)
    }
    // Same shape as the bed branch: a placement that did not land leaves the
    // caller to see an unchanged target and report place_failed:not_changed,
    // which the retry already knows — no new failure string for this family.
    await waitForPlacedBlock(context, target, blockName, options.orientedPlaceConfirmMs ?? 1200, 80)
    return
  }

  if (!shouldSneak) {
    return bot.placeBlock(reference, faceVector)
  }

  context.logger?.log?.(`[BUILD_PLACE_SNEAK] target=${formatPos(target)} reference=${formatPos(reference.position)} referenceBlock=${reference.name}`)
  bot.setControlState('sneak', true)
  await sleep(80)
  try {
    return await bot.placeBlock(reference, faceVector)
  } finally {
    bot.setControlState('sneak', false)
  }
}

async function placeFluidFromTargetCell(context, target, blockName, params = {}) {
  const bot = context?.bot
  const options = params.options || {}
  const lockOwner = params.lockOwner
  if (
    options.allowFluidTargetCellPlacement === false ||
    !isFluidBlockName(blockName) ||
    !bot?.entity?.position ||
    typeof bot?.activateItem !== 'function' ||
    typeof bot?.lookAt !== 'function'
  ) {
    return fail('fluid_target_cell_not_applicable')
  }

  const current = bot.blockAt?.(toBlockVec3(target))
  const belowPosition = { x: target.x, y: target.y - 1, z: target.z }
  const below = bot.blockAt?.(toBlockVec3(belowPosition))
  if (
    !current ||
    !AIR_BLOCKS.has(current.name) ||
    !isPlacementReferenceBlock(below)
  ) {
    return fail('fluid_target_cell_not_applicable')
  }

  const topCursor = new Vec3(0.5, 1, 0.5)
  const placeDistance = Number(options.placeDistance ?? 4.5)
  const currentRay = visibleFluidActivationReference(bot, below, topCursor, placeDistance)
  logFluidActivationRay(context, target, belowPosition, 'current', currentRay)
  if (currentRay.ok) {
    return activateFluidFromVisibleReference(context, target, below, blockName, {
      activationStage: 'current',
      faceCursor: topCursor,
      options
    })
  }

  const maxStands = Math.max(1, Math.min(4, Number(options.fluidStandAttempts ?? 4) || 4))
  const requestedStandDistance = Number(options.fluidStandMaxHorizontalDistance ?? 2)
  const maxStandDistance = Number.isFinite(requestedStandDistance)
    ? Math.max(1, Math.min(3, requestedStandDistance))
    : 2
  let adjacentStands = findSafePlacementStandPositions(context, target, placeDistance, {
    reservedPositions: options.reservedPositions,
    reservedBounds: options.reservedBounds,
    excludedStandPositions: options.excludedStandPositions,
    preferOutsideReservedBounds: false,
    preferHighStand: true,
    preferCloseStand: true,
    minHorizontalDistance: 1
  })
    .filter(stand => isCardinalFluidUpperStand(stand, target, maxStandDistance))
    .slice(0, maxStands)
  context.logger?.log?.(
    `[BUILD_FLUID_STANCE_CANDIDATES] target=${formatPos(target)} ` +
    `total=${adjacentStands.length} attempts=${adjacentStands.map(formatPos).join('|') || 'none'}`
  )
  if (!adjacentStands.length) {
    const relaxed = relaxedFluidStanceCandidates(context, target, placeDistance, {
      ...options,
      fluidStandMaxHorizontalDistance: maxStandDistance
    })
    if (relaxed.stands.length) {
      adjacentStands = relaxed.stands.slice(0, maxStands)
      context.logger?.log?.(
        `[BUILD_FLUID_STANCE_RELAX] target=${formatPos(target)} level=${relaxed.level} ` +
        `total=${adjacentStands.length} attempts=${adjacentStands.map(formatPos).join('|')}`
      )
    }
  }

  let lastMoveError = null
  let lastRay = currentRay
  const requestedStandTimeoutMs = Number(options.fluidStandMoveTimeoutMs ?? 15000)
  const standMoveTimeoutMs = Number.isFinite(requestedStandTimeoutMs)
    ? Math.max(500, Math.min(15000, requestedStandTimeoutMs))
    : 15000
  for (const [index, stand] of adjacentStands.entries()) {
    context.logger?.log?.(
      `[BUILD_FLUID_STANCE_MOVE] target=${formatPos(target)} stand=${formatPos(stand)} ` +
      `attempt=${index + 1}/${adjacentStands.length} timeoutMs=${standMoveTimeoutMs}`
    )
    const baseStandRange = safeMoveRangeForStand(stand, target, {
      ...options,
      preferCloseStand: true
    })
    const moved = await moveTo(context, stand, {
      owner: lockOwner,
      // Rim stands sit inside a partial-support cell (feet at ~y+0.5), and
      // pathfinder may register the arrival node one block above the cell,
      // so give the goal enough radius to accept either interpretation.
      range: stand.rimStand === true ? Math.max(baseStandRange, 1.45) : baseStandRange,
      timeoutMs: standMoveTimeoutMs,
      canDig: false,
      allowScaffolding: false,
      ...movementScaffoldExclusions(options, target),
      holdLock: true
    })
    if (!moved.ok) {
      lastMoveError = moved.error || 'move_failed'
      context.logger?.log?.(
        `[BUILD_FLUID_STANCE_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} ` +
        `reason=${lastMoveError}`
      )
      if (lastMoveError === 'task_interrupted') return moved
      continue
    }

    stopMovement(bot, 'fluid_activation_stance_reached', lockOwner)
    const refreshedBelow = bot.blockAt?.(toBlockVec3(belowPosition))
    if (!isPlacementReferenceBlock(refreshedBelow)) {
      lastRay = { ok: false, reason: 'reference_changed', hit: refreshedBelow?.name || null }
      logFluidActivationRay(context, target, belowPosition, `stand_${index + 1}`, lastRay)
      continue
    }
    lastRay = visibleFluidActivationReference(bot, refreshedBelow, topCursor, placeDistance)
    logFluidActivationRay(context, target, belowPosition, `stand_${index + 1}`, lastRay)
    if (!lastRay.ok) continue
    return activateFluidFromVisibleReference(context, target, refreshedBelow, blockName, {
      activationStage: 'adjacent_stance',
      faceCursor: topCursor,
      options,
      stand
    })
  }

  if (!isOpenFluidTargetCellEntry(bot, target)) {
    return fail('fluid_activation_reference_unreachable', {
      candidateCount: adjacentStands.length,
      lastMoveError,
      lastRayReason: lastRay?.reason || null,
      referencePosition: belowPosition,
      target
    })
  }

  context.logger?.log?.(
    `[BUILD_BUCKET_TARGET_CELL_MOVE] target=${formatPos(target)} ` +
    `reference=${formatPos(belowPosition)} block=${blockName}`
  )
  const requestedMoveRange = Number(options.fluidTargetCellMoveRange ?? 0.15)
  const moved = await moveTo(context, target, {
    owner: lockOwner,
    range: Number.isFinite(requestedMoveRange) ? Math.max(0.05, requestedMoveRange) : 0.15,
    timeoutMs: placementMoveTimeoutMs(bot, target, options),
    canDig: false,
    allowScaffolding: false,
    ...movementScaffoldExclusions(options, target),
    holdLock: true
  })
  if (!moved.ok) return moved

  const settled = await waitForFluidTargetStand(bot, target, options)
  stopMovement(bot, 'fluid_target_cell_settled', lockOwner)
  if (!settled) {
    return fail('fluid_target_cell_not_settled', {
      position: bot.entity?.position || null,
      target
    })
  }

  const refreshedBelow = bot.blockAt?.(toBlockVec3(belowPosition))
  const visibleReference = visibleFluidActivationReference(bot, refreshedBelow, topCursor, placeDistance)
  logFluidActivationRay(context, target, belowPosition, 'target_cell', visibleReference)
  if (!visibleReference.ok) {
    return fail(`fluid_target_cell_reference_not_visible:${visibleReference.reason}`, {
      hit: visibleReference.hit,
      referencePosition: belowPosition,
      target
    })
  }

  return activateFluidFromVisibleReference(context, target, refreshedBelow, blockName, {
    activationStage: 'target_cell',
    faceCursor: topCursor,
    options
  })
}

function isCardinalFluidUpperStand(stand, target, maxDistance = 2) {
  if (stand?.y !== target?.y + 1) return false
  const dx = Math.abs(Number(stand.x) - Number(target.x))
  const dz = Math.abs(Number(stand.z) - Number(target.z))
  return ((dx === 0 && dz >= 1) || (dz === 0 && dx >= 1)) &&
    Math.max(dx, dz) <= maxDistance
}

// Staged fallback for the zero-candidate fluid stance blind spot. Live case
// (round 3, water at 611,68,-94): the rooftop fountain's every strict upper
// stand died on bottom-slab support (non-integer surface), enclosure
// reservations, or missing support — total=0 and the task terminal-failed
// without trying anything. The relaxation is attempted only when the strict
// grid is empty, and the activation raycast performed on arrival remains the
// hard gate for actually pouring, so no placement fidelity is given up.
// Reserved (formal future block) cells stay untouchable at every level —
// the committed fluid tests pin that contract.
//   Level rim_partial_stand: stand IN a cell holding a walkable partial
//     support (the basin's bottom-slab rim; feet rest at ~y+0.5) at the
//     target's own level, cardinal or diagonal.
function relaxedFluidStanceCandidates(context, target, placeDistance = 4.5, options = {}) {
  const requested = Number(options.fluidStandMaxHorizontalDistance ?? 2)
  const maxDistance = Number.isFinite(requested) ? Math.max(1, Math.min(3, requested)) : 2

  const rimStands = fluidRimPartialStands(context, target, placeDistance, options, maxDistance)
  if (rimStands.length) return { level: 'rim_partial_stand', stands: rimStands }
  return { level: 'none', stands: [] }
}

function fluidRimPartialStands(context, target, placeDistance, options = {}, maxDistance = 2) {
  const bot = context?.bot
  if (!bot?.blockAt || !target) return []
  const stands = []
  for (let dx = -maxDistance; dx <= maxDistance; dx++) {
    for (let dz = -maxDistance; dz <= maxDistance; dz++) {
      if (dx === 0 && dz === 0) continue
      const cell = { x: target.x + dx, y: target.y, z: target.z + dz }
      if (isReservedPosition(cell, options.excludedStandPositions)) continue
      // The stand cell itself holds a formal block (the rim we stand on);
      // the headroom cells must stay unreserved.
      if (isReservedPosition({ x: cell.x, y: cell.y + 1, z: cell.z }, options.reservedPositions)) continue
      if (isReservedPosition({ x: cell.x, y: cell.y + 2, z: cell.z }, options.reservedPositions)) continue
      const feet = bot.blockAt(toBlockVec3(cell))
      const supportTop = walkablePartialSupportTop(feet)
      if (supportTop === null) continue
      const head1 = bot.blockAt(toBlockVec3({ x: cell.x, y: cell.y + 1, z: cell.z }))
      const head2 = bot.blockAt(toBlockVec3({ x: cell.x, y: cell.y + 2, z: cell.z }))
      if (head1 && !AIR_BLOCKS.has(head1.name)) continue
      if (head2 && !AIR_BLOCKS.has(head2.name)) continue
      const eye = { x: cell.x + 0.5, y: cell.y + supportTop + 1.6, z: cell.z + 0.5 }
      const referenceTopFace = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
      if (distance(eye, referenceTopFace) > placeDistance + 0.6) continue
      stands.push({ ...cell, rimStand: true })
    }
  }
  stands.sort((a, b) => horizontalDistance(a, target) - horizontalDistance(b, target))
  return stands
}

// A partial support the bot can stand inside the cell of (bottom slab, low
// stairs): collision top strictly between 0.4 and 0.99 — full blocks belong
// to the strict integer-stand path, and carpets/buttons are too thin to keep
// the eye above the basin rim.
function walkablePartialSupportTop(block) {
  if (!block || AIR_BLOCKS.has(block.name)) return null
  if (!Array.isArray(block.shapes) || !block.shapes.length) return null
  const tops = block.shapes
    .filter(shape => Array.isArray(shape) && shape.length >= 6)
    .map(shape => Number(shape[4]))
    .filter(Number.isFinite)
  if (!tops.length) return null
  const top = Math.max(...tops)
  return top >= 0.4 && top <= 0.99 ? top : null
}

async function activateFluidFromVisibleReference(context, target, reference, blockName, params = {}) {
  const bot = context?.bot
  const options = params.options || {}
  const faceCursor = params.faceCursor || new Vec3(0.5, 1, 0.5)
  const referencePosition = reference?.position
  const bucketItem = itemNameForBlock(blockName)
  const heldBefore = bot?.heldItem?.name || null
  const lookTarget = toBlockVec3(referencePosition).offset(faceCursor.x, faceCursor.y, faceCursor.z)
  context.logger?.log?.(
    `[BUILD_BUCKET_VISIBLE_REFERENCE_ACTIVATE] target=${formatPos(target)} ` +
    `reference=${formatPos(referencePosition)} block=${blockName} stage=${params.activationStage || 'unknown'}`
  )
  try {
    await bot.lookAt(lookTarget, false)
    await bot.activateItem()
  } catch (error) {
    return fluidActivationFailureAfterUse(bot, bucketItem, heldBefore, error?.message || 'fluid_activation_failed')
  }
  await waitForPlacedBlock(
    context,
    target,
    blockName,
    options.fluidActivationConfirmMs ?? 900,
    options.fluidActivationPollMs ?? 80
  )
  const stable = await confirmPlacedBlock(context, target, blockName, options)
  if (!stable.ok) {
    return fluidActivationFailureAfterUse(bot, bucketItem, heldBefore, stable.error || 'fluid_not_stable')
  }
  return ok('fluid_placed_from_visible_reference', {
    activationStage: params.activationStage || null,
    blockName,
    position: target,
    referencePosition,
    standPosition: params.stand || null
  })
}

function fluidActivationFailureAfterUse(bot, bucketItem, heldBefore, placementError) {
  const heldAfter = bot?.heldItem?.name || null
  if (heldBefore === bucketItem && heldAfter !== bucketItem) {
    return fail(`placement_retry_requires_material_refill:${bucketItem}`, {
      recoverable: true,
      recoveryType: 'material_refill',
      consumedBy: 'fluid_activation_unconfirmed',
      heldBefore,
      heldAfter,
      placementError
    })
  }
  return fail(placementError)
}

function logFluidActivationRay(context, target, referencePosition, stage, result) {
  context.logger?.log?.(
    `[BUILD_FLUID_RAYCAST] target=${formatPos(target)} reference=${formatPos(referencePosition)} ` +
    `stage=${stage} ok=${result?.ok === true} reason=${result?.reason || 'unknown'} hit=${result?.hit || 'none'}`
  )
}

function isOpenFluidTargetCellEntry(bot, target) {
  const targetAbove = bot?.blockAt?.(toBlockVec3({ x: target.x, y: target.y + 1, z: target.z }))
  if (!targetAbove || !AIR_BLOCKS.has(targetAbove.name)) return false
  const offsets = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 }
  ]
  return offsets.some(offset => {
    const feet = bot.blockAt?.(toBlockVec3({
      x: target.x + offset.x,
      y: target.y,
      z: target.z + offset.z
    }))
    const head = bot.blockAt?.(toBlockVec3({
      x: target.x + offset.x,
      y: target.y + 1,
      z: target.z + offset.z
    }))
    const support = bot.blockAt?.(toBlockVec3({
      x: target.x + offset.x,
      y: target.y - 1,
      z: target.z + offset.z
    }))
    return feet && AIR_BLOCKS.has(feet.name) &&
      head && AIR_BLOCKS.has(head.name) &&
      hasIntegerStandSurface(support)
  })
}

async function waitForFluidTargetStand(bot, target, options = {}) {
  const timeoutMs = Math.max(100, Number(options.fluidTargetCellSettleTimeoutMs ?? 4000))
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const position = bot?.entity?.position
    if (
      position &&
      bot.entity.onGround === true &&
      Math.floor(position.x) === target.x &&
      Math.floor(position.z) === target.z &&
      Math.abs(position.y - target.y) <= 0.05
    ) {
      return true
    }
    await sleep(50)
  }
  return false
}

function visibleFluidActivationReference(bot, reference, faceCursor, maxDistance = 4.5) {
  const botPosition = bot?.entity?.position
  const referencePosition = reference?.position
  if (!botPosition || !referencePosition || typeof bot?.world?.raycast !== 'function') {
    return { ok: false, reason: 'raycast_unavailable', hit: null }
  }
  const eye = new Vec3(botPosition.x, botPosition.y + 1.62, botPosition.z)
  const clickPoint = toBlockVec3(referencePosition).offset(
    faceCursor.x,
    faceCursor.y,
    faceCursor.z
  )
  const delta = clickPoint.minus(eye)
  const distanceToFace = delta.norm()
  if (!Number.isFinite(distanceToFace) || distanceToFace <= 0.001) {
    return { ok: false, reason: 'invalid_reference_ray', hit: null }
  }
  if (Number.isFinite(maxDistance) && distanceToFace > maxDistance) {
    return {
      ok: false,
      reason: 'reference_out_of_reach',
      hit: null,
      distance: distanceToFace
    }
  }
  const hit = bot.world.raycast(
    eye,
    delta.scaled(1 / distanceToFace),
    distanceToFace + 0.2
  )
  const hitPosition = hit?.position
  if (!hitPosition || !sameBlockPos(hitPosition, referencePosition)) {
    return {
      ok: false,
      reason: 'reference_not_visible',
      hit: hitPosition ? formatPos(hitPosition) : null
    }
  }
  return { ok: true, reason: 'reference_visible', hit: formatPos(hitPosition) }
}

function safeFluidActivationCursor(faceVector) {
  const x = Number(faceVector?.x || 0)
  const y = Number(faceVector?.y || 0)
  const z = Number(faceVector?.z || 0)
  if (y !== 0 || Math.abs(x) + Math.abs(z) !== 1) return null
  const inset = 0.001
  return new Vec3(
    x < 0 ? inset : (x > 0 ? 1 - inset : 0.5),
    0.4,
    z < 0 ? inset : (z > 0 ? 1 - inset : 0.5)
  )
}

function shouldSneakForPlacementReference(reference) {
  const name = String(reference?.name || '')
  return /trapdoor$/.test(name) ||
    /_door$/.test(name) ||
    /fence_gate$/.test(name) ||
    /button$/.test(name) ||
    /lever$/.test(name) ||
    /chest$/.test(name) ||
    INTERACTIVE_REFERENCE_BLOCKS.has(name) ||
    SNEAK_ONLY_REFERENCE_BLOCKS.has(name) ||
    SNEAK_ONLY_REFERENCE_PATTERNS.some(pattern => pattern.test(name)) ||
    /anvil$/.test(name) ||
    name === 'barrel' ||
    name === 'crafting_table' ||
    /furnace$/.test(name) ||
    /_bed$/.test(name) ||
    name === 'bed'
}

async function orientBotForPlacement(context, target, blockName, states = null) {
  const direction = placementLookDirection(blockName, states)
  if (!direction) return ok('placement_orientation_not_required')
  return lookTowardDirection(context, target, blockName, direction)
}

// Where should she be looking to place this block, in the server's own terms?
// Same arithmetic bot.lookAt does (mineflayer lib/plugins/physics.js), kept
// here so the placement can restate the angle without going through the
// physics loop.
function placementLookAngles(bot, direction) {
  const pos = bot?.entity?.position
  if (!pos || !direction) return null
  const eyeHeight = Number.isFinite(bot.entity.eyeHeight) ? bot.entity.eyeHeight : 1.62
  const dx = direction.x * 4
  const dy = 1.62 + (direction.y || 0) * 4 - eyeHeight
  const dz = direction.z * 4
  const groundDistance = Math.sqrt(dx * dx + dz * dz)
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, groundDistance)
  }
}

// Restate the look in the packet stream itself, immediately before the place.
//
// Building round 20, live: four roof pistons wanted facing=down, two landed
// right and two landed facing=north. The two that failed were placed standing
// still after a move timed out; ten seconds later the server still reported the
// bot looking level. bot.pathfinder.stop() only sets a flag that is consumed
// when the bot next arrives at a path node (mineflayer-pathfinder index.js),
// so a timed-out move leaves the old path in place and monitorMovement keeps
// calling bot.look(yaw, 0) every physics tick — flattening the pitch that
// orientBotForPlacement had just set, including during the settle delay.
//
// Nothing here can stop another plugin from steering, so instead of fighting
// for the last tick we put the angle in front of the placement packet: both
// writes leave in the same synchronous block, the server reads them in order,
// and the placement is resolved with the angle we meant. If the write is not
// possible (no client, unknown packet shape on this protocol) we say so in the
// log and fall through to exactly the old behaviour.
function sendPlacementLookPacket(context, direction) {
  const bot = context?.bot
  const angles = placementLookAngles(bot, direction)
  if (!angles) return { sent: false, reason: 'no_look_angles' }
  bot.entity.yaw = angles.yaw
  bot.entity.pitch = angles.pitch
  if (typeof bot?._client?.write !== 'function') {
    return { sent: false, reason: 'no_client', ...angles }
  }
  // mineflayer lib/conversions.js: notchian yaw = deg(PI - yaw), pitch = deg(-pitch)
  const toDegrees = 180 / Math.PI
  const onGround = bot.entity.onGround !== false
  try {
    bot._client.write('look', {
      yaw: toDegrees * (Math.PI - angles.yaw),
      pitch: toDegrees * -angles.pitch,
      onGround,
      flags: { onGround, hasHorizontalCollision: false }
    })
  } catch (err) {
    return { sent: false, reason: err?.message || 'look_write_failed', ...angles }
  }
  return { sent: true, ...angles }
}

async function lookTowardDirection(context, target, blockName, direction) {
  const bot = context?.bot
  if (!bot?.entity?.position || typeof bot.lookAt !== 'function') return ok('placement_orientation_skipped')

  const pos = bot.entity.position
  // The look target sits at eye height for a horizontal facing; a direction
  // carrying `y` (piston/dropper/observer facing up or down) moves it above
  // or below the eyes, which is the only way to get the pitch the server
  // reads off the placement.
  const lookPitchOffset = (direction.y || 0) * 4
  const lookTarget = new Vec3(
    pos.x + direction.x * 4,
    pos.y + 1.62 + lookPitchOffset,
    pos.z + direction.z * 4
  )
  await bot.lookAt(lookTarget, direction.forceLook !== false)
  if (direction.settleDelayMs) await sleep(direction.settleDelayMs)
  context.logger?.log?.(`[BUILD_PLACE_ORIENT] target=${formatPos(target)} block=${blockName} facing=${direction.facing} source=${direction.source} look=${direction.x},${direction.z} pitch=${direction.y || 0}`)
  return ok('placement_oriented', direction)
}

async function tryPlaceBedPairFallback(context, params) {
  const { blockName, lockOwner, options = {}, placeDistance = 4.5, states = null, target } = params
  const bot = context?.bot
  if (!isBedBlockName(blockName)) return fail('bed_pair_fallback_not_applicable')
  if (states && states.part && states.part !== 'foot') return fail('bed_pair_fallback_not_applicable')
  const facing = String(states?.facing || '').toLowerCase()
  const importedFacing = horizontalOffsetForFacing(facing)
  if (!bot?.entity || !target || !importedFacing) return fail('bed_pair_fallback_not_applicable')

  // Vanilla bed facing points foot -> head, so the head partner cell sits at
  // target + facing. Placing from the partner cell puts the foot there and the
  // head back on target: both blueprint cells are filled, parts swapped, as a
  // last resort when the foot cell itself cannot be placed against.
  const partner = {
    x: target.x + importedFacing.x,
    y: target.y,
    z: target.z + importedFacing.z
  }
  if (bedPairPlaced(context, target, partner, blockName)) {
    return ok('bed_pair_already_placed', { blockName, position: target, partnerPosition: partner })
  }

  const partnerBlock = bot.blockAt?.(toBlockVec3(partner))
  if (partnerBlock && !AIR_BLOCKS.has(partnerBlock.name) && partnerBlock.name !== blockName) {
    return fail(`bed_pair_partner_occupied:${partnerBlock.name}`)
  }

  if (!isPlacementReachable(bot, partner, placeDistance) || botIntersectsBlock(bot, partner)) {
    const stands = findSafePlacementStandPositions(context, partner, placeDistance, {
      reservedPositions: options.reservedPositions,
      reservedBounds: options.reservedBounds,
      preferOutsideReservedBounds: options.preferOutsideReservedBounds === true,
      excludedStandPositions: [target]
    })
    const moved = await moveToFirstReachablePlacementStand(context, partner, stands, {
      owner: lockOwner,
      options,
      reason: 'bed_pair_partner_fallback'
    })
    if (!moved.ok) return moved
  }

  const references = findReferenceBlocksForPlacement(context, partner, blockName, null)
  if (!references.length) return fail('bed_pair_partner_no_support')

  const held = await equipBlockForPlacement(context, blockName, options)
  if (!held.ok) return held
  const oriented = await lookTowardDirection(context, partner, blockName, {
    x: -importedFacing.x,
    z: -importedFacing.z,
    facing,
    source: 'bed_pair_partner_reverse'
  })
  if (!oriented.ok) return oriented

  let lastError = null
  for (const reference of references) {
    try {
      context.logger?.log?.(`[BUILD_BED_PAIR_FALLBACK] target=${formatPos(target)} partner=${formatPos(partner)} reference=${formatPos(reference.position)} facing=${facing}`)
      await placeBlockAgainstReference(context, reference, partner, blockName, options)
      if (bedPairPlaced(context, target, partner, blockName)) {
        return ok('bed_pair_placed_from_partner', {
          blockName,
          position: target,
          partnerPosition: partner,
          referencePosition: reference.position
        })
      }
      lastError = new Error('bed_pair_fallback_not_changed')
    } catch (err) {
      if (bedPairPlaced(context, target, partner, blockName)) {
        return ok('bed_pair_placed_from_partner_after_timeout', {
          blockName,
          position: target,
          partnerPosition: partner,
          referencePosition: reference.position,
          recoveredFrom: err.message
        })
      }
      lastError = err
    }
  }

  return fail(lastError?.message || 'bed_pair_fallback_failed')
}

function bedPairPlaced(context, target, partner, blockName) {
  const first = context?.bot?.blockAt?.(toBlockVec3(target))
  const second = context?.bot?.blockAt?.(toBlockVec3(partner))
  return first?.name === blockName && second?.name === blockName
}

function placementLookDirection(blockName, states = null) {
  if (isStairBlockName(blockName)) {
    const facing = String(states?.facing || '').toLowerCase()
    const offset = horizontalOffsetForFacing(facing)
    if (!offset) return null
    return {
      x: offset.x,
      z: offset.z,
      facing,
      source: 'stair_facing',
      forceLook: false,
      settleDelayMs: 80
    }
  }

  if (isFenceGateBlockName(blockName)) {
    const facing = String(states?.facing || '').toLowerCase()
    const offset = horizontalOffsetForFacing(facing)
    if (!offset) return null
    return {
      x: offset.x,
      z: offset.z,
      facing,
      source: 'fence_gate_facing',
      forceLook: false,
      settleDelayMs: 80
    }
  }

  if (isDoorBlockName(blockName)) {
    const facing = String(states?.facing || '').toLowerCase()
    const offset = horizontalOffsetForFacing(facing)
    if (!offset) return null
    return {
      x: offset.x,
      z: offset.z,
      facing,
      source: 'door_facing',
      forceLook: false,
      settleDelayMs: 80
    }
  }

  if (isTrapdoorBlockName(blockName)) {
    const facing = String(states?.facing || '').toLowerCase()
    const offset = horizontalOffsetForFacing(facing)
    if (!offset) return null
    return {
      x: -offset.x,
      z: -offset.z,
      facing,
      source: 'trapdoor_facing',
      forceLook: false,
      settleDelayMs: 80
    }
  }

  if (isFurnaceLikeBlockName(blockName)) {
    const facing = String(states?.facing || '').toLowerCase()
    const offset = horizontalOffsetForFacing(facing)
    if (!offset) return null
    return {
      x: -offset.x,
      z: -offset.z,
      facing,
      source: 'furnace_facing',
      forceLook: false,
      settleDelayMs: 80
    }
  }

  const oriented = orientedPlacementLookDirection(blockName, states)
  if (oriented) return oriented

  const modernRotation = modernizeLegacyBlock(blockName, states)
  if (isRotationPlacedBlockName(modernRotation.blockName)) {
    // Legacy skulls carry legacyId/legacyData; the expected rotation only
    // exists after modernization (live round 9: the villa skull is legacy —
    // the raw states have no `rotation` key, so read the modernized ones).
    const rotation = Number(modernRotation.states?.rotation)
    if (!Number.isFinite(rotation)) return null
    // Vanilla is asymmetric here: signs/banners take rotation from
    // (180 + playerYaw), skulls/heads from playerYaw directly (live round 9:
    // facing east placed skull rotation 12, not 4 — no 180 offset). Solve the
    // placer yaw accordingly; the server's &15 makes negative yaw congruent.
    const skullFamily = /_skull$/.test(modernRotation.blockName) || /_head$/.test(modernRotation.blockName)
    const yawRadians = (rotation * 22.5 - (skullFamily ? 0 : 180)) * Math.PI / 180
    return {
      x: -Math.sin(yawRadians),
      z: Math.cos(yawRadians),
      facing: `rotation_${rotation}`,
      source: 'rotation_state',
      settleDelayMs: 80
    }
  }

  if (!isBedBlockName(blockName)) return null
  if (states && states.part && states.part !== 'foot') return null
  const facing = String(states?.facing || '').toLowerCase()
  const importedFacing = horizontalOffsetForFacing(facing)
  if (!importedFacing) return null

  // Vanilla convention: bed facing points foot -> head, and the head extends
  // in the direction the player is looking when placing the foot.
  return {
    x: importedFacing.x,
    z: importedFacing.z,
    facing,
    source: 'bed_foot_facing_head'
  }
}

function isBedBlockName(blockName) {
  return /_bed$/.test(String(blockName || '')) || blockName === 'bed'
}

function isRotationPlacedBlockName(blockName) {
  // Standing (floor) variants carrying the 16-direction `rotation` state.
  // Wall variants use `facing` and piston_head is a technical block — both
  // excluded.
  const name = String(blockName || '')
  if (!name || name.includes('wall_')) return false
  if (name === 'piston_head') return false
  return /_skull$/.test(name) || /_head$/.test(name) || /_banner$/.test(name) || /_sign$/.test(name)
}

function isFenceGateBlockName(blockName) {
  return /_fence_gate$/.test(String(blockName || ''))
}

function isDoorBlockName(blockName) {
  return /_door$/.test(String(blockName || ''))
}

function isTrapdoorBlockName(blockName) {
  return /_trapdoor$/.test(String(blockName || ''))
}

function isStairBlockName(blockName) {
  return /_stairs$/.test(String(blockName || ''))
}

function isFurnaceLikeBlockName(blockName) {
  // These blocks face opposite the player's horizontal look direction when
  // placed. Reuse the same orientation-preserving placement path for storage
  // containers; generic placement made chest facing depend on the incidental
  // approach stand and repeatedly consumed repair items.
  return [
    'furnace',
    'smoker',
    'blast_furnace',
    'chest',
    'trapped_chest',
    'ender_chest'
  ].includes(String(blockName || ''))
}

// Which way the bot must look so a placement lands the blueprint's `facing`.
// `sign: -1` means the block ends up facing the player (look opposite to the
// wanted facing, same convention as the furnace family above); `sign: 1` means
// it faces away (look along the wanted facing). `vertical: true` means the
// family also accepts facing=up/down, which needs pitch, not just yaw.
//
// Source for every row: 修缮 10 real-server probe (creative accept_tester,
// fixed look angle, `execute if block … [facing=…]` read back), handed over in
// the 后勤 11 task sheet. Rows are data on purpose: if a family ever comes out
// 180° reversed on a real server, flip its sign here and nothing else changes.
const ORIENTED_PLACEMENT_FACING_RULES = {
  repeater: { sign: -1, vertical: false, source: 'repeater_facing' },
  comparator: { sign: -1, vertical: false, source: 'comparator_facing' },
  piston: { sign: -1, vertical: true, source: 'piston_facing' },
  sticky_piston: { sign: -1, vertical: true, source: 'piston_facing' },
  dispenser: { sign: -1, vertical: true, source: 'dispenser_facing' },
  dropper: { sign: -1, vertical: true, source: 'dropper_facing' },
  // Observer is the odd one out: its detecting face points AWAY from the
  // player, so looking east lands facing=east (修缮 10 真机).
  observer: { sign: 1, vertical: true, source: 'observer_facing' },
  // Hopper ignores the look entirely — its facing is the face that was
  // clicked, so only the reference choice can control it. Kept in the table
  // (rather than left out) so "the look cannot fix this" is data too.
  hopper: { clickedFace: true, source: 'hopper_clicked_face' }
}

// Levers and buttons take facing from the look direction and `face`
// (floor/wall/ceiling) from the clicked face (修缮 10 真机). Wall variants get
// their facing from the wall they attach to, so the look must not be used.
function isLeverOrButtonBlockName(blockName) {
  return isButtonBlockName(blockName) || String(blockName || '') === 'lever'
}

function orientedPlacementFacingRule(blockName) {
  return Object.prototype.hasOwnProperty.call(ORIENTED_PLACEMENT_FACING_RULES, String(blockName || ''))
    ? ORIENTED_PLACEMENT_FACING_RULES[String(blockName)]
    : null
}

function facingOffsetWithVertical(facing) {
  if (facing === 'up') return { x: 0, y: 1, z: 0 }
  if (facing === 'down') return { x: 0, y: -1, z: 0 }
  const horizontal = horizontalOffsetForFacing(facing)
  return horizontal ? { x: horizontal.x, y: 0, z: horizontal.z } : null
}

function orientedPlacementLookDirection(blockName, states = null) {
  const facing = String(states?.facing || '').toLowerCase()
  if (!facing) return null

  if (isLeverOrButtonBlockName(blockName)) {
    // face=wall is decided by the wall the button attaches to, not the look.
    if (String(states?.face || '').toLowerCase() === 'wall') return null
    const offset = horizontalOffsetForFacing(facing)
    if (!offset) return null
    return {
      x: offset.x,
      y: 0,
      z: offset.z,
      facing,
      source: 'button_lever_facing',
      forceLook: false,
      settleDelayMs: 80
    }
  }

  const rule = orientedPlacementFacingRule(blockName)
  if (!rule || rule.clickedFace) return null
  const offset = facingOffsetWithVertical(facing)
  if (!offset) return null
  if (offset.y !== 0 && !rule.vertical) return null
  // `sign * 0` would be -0, which reads as a different value to strict
  // comparisons downstream; keep the untouched axes at plain 0.
  const signed = value => (value === 0 ? 0 : rule.sign * value)
  return {
    x: signed(offset.x),
    y: signed(offset.y),
    z: signed(offset.z),
    facing,
    source: rule.source,
    forceLook: false,
    settleDelayMs: 80
  }
}

function isSlabBlockName(blockName) {
  return /_slab$/.test(String(blockName || ''))
}

function isButtonBlockName(blockName) {
  return /_button$/.test(String(blockName || ''))
}

function isCandleBlockName(blockName) {
  const value = String(blockName || '')
  return value === 'candle' || /_candle$/.test(value)
}

function desiredCandleCount(states = null) {
  if (!states || states.candles == null) return null
  const count = Number(states.candles)
  if (!Number.isFinite(count)) return null
  return Math.max(1, Math.min(4, Math.trunc(count)))
}

function candleCountFromBlock(block) {
  if (typeof block?.getProperties !== 'function') return 1
  const count = Number(block.getProperties()?.candles)
  if (!Number.isFinite(count)) return 1
  return Math.max(1, Math.min(4, Math.trunc(count)))
}

function candleNonStackStateMismatch(block, states = null) {
  if (!states || typeof block?.getProperties !== 'function') return null
  const actual = block.getProperties() || {}
  for (const key of ['lit', 'waterlogged']) {
    if (states[key] != null && String(actual[key]) !== String(states[key])) {
      return `${key}:${actual[key] ?? 'unknown'}!=${states[key]}`
    }
  }
  return null
}

function isCandleStackExtensionTarget(block, blockName, states = null) {
  if (!isCandleBlockName(blockName) || block?.name !== blockName) return false
  if (candleNonStackStateMismatch(block, states)) return false
  const desired = desiredCandleCount(states)
  if (desired == null || desired <= 1) return false
  const current = candleCountFromBlock(block)
  return current > 0 && current < desired
}

function isAxisBlockName(blockName) {
  const value = String(blockName || '')
  return /_log$/.test(value) || /_wood$/.test(value) || /_stem$/.test(value) || /_hyphae$/.test(value)
}

function axisForPlacementFace(faceVector) {
  if (!faceVector) return null
  if (faceVector.y !== 0) return 'y'
  if (faceVector.x !== 0) return 'x'
  if (faceVector.z !== 0) return 'z'
  return null
}

function isFluidBlockName(blockName) {
  return blockName === 'water' || blockName === 'lava'
}

function isReplaceablePlacementTarget(currentName, blockName) {
  return currentName === 'water' && blockName && !isFluidBlockName(blockName) && !AIR_BLOCKS.has(blockName)
}

function horizontalOffsetForFacing(facing) {
  if (facing === 'east') return { x: 1, z: 0 }
  if (facing === 'west') return { x: -1, z: 0 }
  if (facing === 'south') return { x: 0, z: 1 }
  if (facing === 'north') return { x: 0, z: -1 }
  return null
}

function placementStates(options = {}) {
  return options.blockStates || options.states || options.orientation || null
}

function isBotOnStairPlacementSide(bot, target, facingOffset) {
  const pos = bot?.entity?.position
  if (!pos || !target || !facingOffset) return false
  return isAlignedStairPlacementSide(pos, target, facingOffset)
}

function stairPlacementSideScore(stand, target, facingOffset) {
  return stairPlacementSideMetrics(stand, target, facingOffset).along
}

function isAlignedStairPlacementSide(stand, target, facingOffset) {
  const metrics = stairPlacementSideMetrics(stand, target, facingOffset)
  return metrics.along > 0.75 && metrics.perpendicular <= Math.max(0.75, metrics.along * 1.25)
}

function stairPlacementSideMetrics(stand, target, facingOffset) {
  if (!stand || !target || !facingOffset) return { along: 0, perpendicular: Infinity }
  const targetCenter = { x: target.x + 0.5, z: target.z + 0.5 }
  const standCenter = {
    x: Number.isInteger(stand.x) ? stand.x + 0.5 : stand.x,
    z: Number.isInteger(stand.z) ? stand.z + 0.5 : stand.z
  }
  return {
    along: (targetCenter.x - standCenter.x) * facingOffset.x +
      (targetCenter.z - standCenter.z) * facingOffset.z,
    perpendicular: facingOffset.x !== 0
      ? Math.abs(targetCenter.z - standCenter.z)
      : Math.abs(targetCenter.x - standCenter.x)
  }
}

function expectedPlacementStateMismatch(block, blockName, options = {}) {
  if (options.requireStateConfirmation !== true) return null
  const expected = placementStates(options)
  const legacyMismatch = legacyBlockStateMismatch(blockProperties(block), blockName, expected)
  if (legacySkullPlacement(blockName, expected)) return legacyMismatch
  const keys = expectedPlacementStateKeys(blockName, expected)
  if (!keys.length) return null
  const actual = typeof block?.getProperties === 'function' ? block.getProperties() : {}
  for (const key of keys) {
    if (String(actual?.[key]) !== String(expected[key])) {
      return `${key}:${actual?.[key] ?? 'unknown'}!=${expected[key]}`
    }
  }
  return null
}

function expectedPlacementStateKeys(blockName, states = null) {
  if (!states) return []
  if (isStairBlockName(blockName)) return ['half', 'facing'].filter(key => states[key] != null)
  if (isSlabBlockName(blockName)) return ['type'].filter(key => states[key] != null)
  if (isButtonBlockName(blockName)) return ['face', 'facing'].filter(key => states[key] != null)
  if (isFenceGateBlockName(blockName)) return ['facing', 'open'].filter(key => states[key] != null)
  if (isDoorBlockName(blockName)) return ['half', 'facing', 'open'].filter(key => states[key] != null)
  if (isTrapdoorBlockName(blockName)) return ['half', 'facing', 'open'].filter(key => states[key] != null)
  if (isFurnaceLikeBlockName(blockName)) return ['facing'].filter(key => states[key] != null)
  if (blockName === 'lever') return ['face', 'facing'].filter(key => states[key] != null)
  // Orientation families (ORIENTED_PLACEMENT_FACING_RULES): facing is decided
  // at placement time, so a wrong one is a placement defect and has to surface
  // here instead of waiting for resume reconciliation to find it.
  if (orientedPlacementFacingRule(blockName)) return ['facing'].filter(key => states[key] != null)
  if (isAxisBlockName(blockName)) return ['axis'].filter(key => states[key] != null)
  if (isCandleBlockName(blockName)) return ['candles', 'lit', 'waterlogged'].filter(key => states[key] != null)
  if (blockName === 'lantern') return ['hanging'].filter(key => states[key] != null)
  if (isFluidBlockName(blockName)) return ['level'].filter(key => states[key] != null)
  return []
}

function isSideAttachedBlockName(blockName) {
  const value = String(blockName || '')
  return value === 'ladder' ||
    value === 'tripwire_hook' ||
    value.endsWith('_wall_sign') ||
    value.endsWith('_wall_banner') ||
    value.endsWith('_wall_head') ||
    value.endsWith('_wall_skull') ||
    value.endsWith('_wall_torch')
}

function isStandingTorchBlockName(blockName) {
  const value = String(blockName || '')
  return value === 'torch' || value === 'soul_torch' || value === 'redstone_torch'
}

function isStandingSkullOrHeadBlockName(blockName) {
  const value = String(blockName || '')
  return (value.endsWith('_skull') && !value.endsWith('_wall_skull')) ||
    (value.endsWith('_head') && !value.endsWith('_wall_head'))
}

function requiredSideAttachmentOffsets(blockName, states = null) {
  if (!isSideAttachedBlockName(blockName)) return null
  const facing = String(states?.facing || '').toLowerCase()
  return requiredWallAttachmentOffsets({ facing })
}

function requiredWallAttachmentOffsets(states = null) {
  const facing = String(states?.facing || '').toLowerCase()
  if (facing === 'west') return [{ x: 1, y: 0, z: 0 }]
  if (facing === 'east') return [{ x: -1, y: 0, z: 0 }]
  if (facing === 'north') return [{ x: 0, y: 0, z: 1 }]
  if (facing === 'south') return [{ x: 0, y: 0, z: -1 }]
  return []
}

function sideAttachmentOffsets(blockName, states = null, sideOffsets = []) {
  if (!isSideAttachedBlockName(blockName)) return null
  const preferred = requiredSideAttachmentOffsets(blockName, states) || []
  const offsets = [...preferred]
  for (const offset of sideOffsets) {
    if (!offsets.some(candidate => candidate.x === offset.x && candidate.y === offset.y && candidate.z === offset.z)) {
      offsets.push(offset)
    }
  }
  return offsets
}

function isPlacementReachable(bot, target, placeDistance) {
  return distance(bot?.entity?.position, target) <= placeDistance && !botIntersectsBlock(bot, target)
}

function canUseCurrentReachForHighTarget(bot, target, placeDistance, options = {}) {
  if (options.allowCurrentReachForHighTargets !== true) return false
  const footY = Math.floor(bot?.entity?.position?.y ?? Number.NEGATIVE_INFINITY)
  return Number.isFinite(footY) &&
    target.y >= footY + 2 &&
    isPlacementReachable(bot, target, placeDistance)
}

function canUseCurrentReferenceForHighTarget(context, target, blockName, placeDistance, options = {}) {
  if (options.allowCurrentReferenceReachForHighTargets !== true) return false
  const bot = context?.bot
  const footY = Math.floor(bot?.entity?.position?.y ?? Number.NEGATIVE_INFINITY)
  if (!Number.isFinite(footY) || !target || target.y < footY + 2 || botIntersectsBlock(bot, target)) return false
  const below = bot.blockAt?.(toBlockVec3({ x: target.x, y: target.y - 1, z: target.z }))
  if (isPlacementReferenceBlock(below) && isReferenceReachableFromCurrentPosition(bot, below.position, placeDistance)) {
    context.logger?.log?.(`[BUILD_CURRENT_REFERENCE_REACH] target=${formatPos(target)} reference=${formatPos(below.position)} reason=below_reference`)
    return true
  }
  const states = options.blockStates || options.states || options.orientation
  const references = findReferenceBlocksForPlacement(context, target, blockName, states)
  const reachReferences = referencesForCurrentReach(blockName, states, references, target)
  const reachable = reachReferences.find(reference => isReferenceReachableFromCurrentPosition(bot, reference.position, placeDistance))
  if (reachable) {
    context.logger?.log?.(`[BUILD_CURRENT_REFERENCE_REACH] target=${formatPos(target)} reference=${formatPos(reachable.position)} reason=placement_reference`)
    return true
  }
  return false
}

function canUseCurrentReferenceForStatefulTarget(context, target, blockName, placeDistance, options = {}) {
  const bot = context?.bot
  if (!target || botIntersectsBlock(bot, target)) return false
  const states = options.blockStates || options.states || options.orientation
  const references = findReferenceBlocksForPlacement(context, target, blockName, states)
  const profile = statefulPlacementProfile(blockName, states || {}, references, target)
  if (!profile || !profile.references.length) return false
  const reachable = profile.references.find(reference => isReferenceReachableFromCurrentPosition(bot, reference.position, placeDistance))
  if (!reachable) return false
  context.logger?.log?.(`[BUILD_CURRENT_REFERENCE_REACH] target=${formatPos(target)} reference=${formatPos(reachable.position)} reason=stateful_placement_reference`)
  return true
}

function referencesForCurrentReach(blockName, states, references, target) {
  const profile = statefulPlacementProfile(blockName, states || {}, references, target)
  return profile ? profile.references : references
}

async function ensureStatefulReferenceReach(context, params = {}) {
  const { lockOwner, options = {}, placeDistance = 4.5, reference, target } = params
  const bot = context?.bot
  if (!reference?.position) return fail('stateful_reference_missing')
  if (isReferenceReachableFromCurrentPosition(bot, reference.position, placeDistance)) {
    return ok('stateful_reference_reachable')
  }

  const stands = findSafePlacementStandPositions(context, target, placeDistance, {
    ...options,
    excludedStandPositions: [
      ...(Array.isArray(options.excludedStandPositions) ? options.excludedStandPositions : [])
    ]
  }).filter(stand => isReferenceReachableFromStand(stand, reference.position, placeDistance))
  if (!stands.length) return fail('stateful_reference_unreachable')

  const maxAttempts = Math.max(1, Number(options.standMoveAttempts || 4))
  const attempts = placementStandAttempts(stands, target, maxAttempts, options)
  let lastResult = null

  for (let index = 0; index < attempts.length; index++) {
    const stand = attempts[index]
    const moved = await moveToFirstReachablePlacementStand(context, target, [stand], {
      owner: lockOwner,
      options,
      placeDistance,
      referencePosition: reference.position,
      reason: index === 0 ? 'stateful_reference_reach' : 'stateful_reference_reach_retry'
    })
    if (!moved.ok) {
      lastResult = moved
      if (moved.error !== 'move_timeout') return moved
      continue
    }
    if (isReferenceReachableFromCurrentPosition(bot, reference.position, placeDistance)) {
      return moved
    }
    context.logger?.log?.(`[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} reason=stateful_reference_unreachable_after_move`)
    lastResult = fail('stateful_reference_still_unreachable')
  }

  return lastResult || fail('stateful_reference_still_unreachable')
}

function isReferenceReachableFromCurrentPosition(bot, referencePosition, placeDistance) {
  const pos = bot?.entity?.position
  if (!pos || !referencePosition) return false
  const eye = { x: pos.x, y: pos.y + 1.62, z: pos.z }
  const blockCenter = {
    x: referencePosition.x + 0.5,
    y: referencePosition.y + 0.5,
    z: referencePosition.z + 0.5
  }
  return distance(eye, blockCenter) <= placeDistance + 1.1
}

function isReferenceReachableFromStand(stand, referencePosition, placeDistance) {
  if (!stand || !referencePosition) return false
  const eye = { x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }
  const blockCenter = {
    x: referencePosition.x + 0.5,
    y: referencePosition.y + 0.5,
    z: referencePosition.z + 0.5
  }
  return distance(eye, blockCenter) <= placeDistance + 1.1
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findReferenceBlockForPlacement(context, position, blockName = null, states = null) {
  return findReferenceBlocksForPlacement(context, position, blockName, states)[0] || null
}

function findReferenceBlocksForPlacement(context, position, blockName = null, states = null) {
  const bot = context?.bot
  const target = normalizePosition(position)
  if (!bot?.blockAt || !target) return []

  const sideOffsets = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 }
  ]
  const verticalOffsets = [
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 }
  ]
  const below = bot.blockAt(toBlockVec3({ x: target.x, y: target.y - 1, z: target.z }))
  const legacyPlacement = legacySkullPlacement(blockName, states)
  const runtimeBlockName = legacyPlacement?.blockName || blockName
  const runtimeStates = legacyPlacement
    ? { ...(states || {}), ...legacyPlacement.states }
    : states
  const sideAttached = isSideAttachedBlockName(runtimeBlockName)
  const topAttached = requiresTopPlacementReference(blockName, states)
  // Standing torches convert to wall_torch when placed against a side face
  // (live: simple_two_story_cabin corner torch at rel 1,1,1 kept landing as
  // wall_torch off the adjacent wall), so they may only use the block below.
  const groundSupported = requiresGroundSupportPlacement(blockName) ||
    isStandingTorchBlockName(blockName) ||
    isStandingSkullOrHeadBlockName(runtimeBlockName)
  const hasStableBelowSupport = isPlacementReferenceBlock(below)
  if (isFenceGateBlockName(blockName) && states?.facing != null && hasStableBelowSupport) {
    return [below]
  }
  const offsets = isFluidBlockName(blockName)
    ? [...sideOffsets, ...verticalOffsets]
    : topAttached
    ? [{ x: 0, y: 1, z: 0 }]
    : groundSupported
    ? [{ x: 0, y: -1, z: 0 }]
    : sideAttached
    ? sideAttachmentOffsets(runtimeBlockName, runtimeStates, sideOffsets)
    : !hasStableBelowSupport && shouldPreferSideReference(context, target)
      ? [...sideOffsets, ...verticalOffsets]
      : [...verticalOffsets, ...sideOffsets]

  const usable = offsets
    .map(offset => {
      const pos = {
        x: target.x + offset.x,
        y: target.y + offset.y,
        z: target.z + offset.z
      }
      return bot.blockAt(toBlockVec3(pos))
    })
    .filter(block => sideAttached
      ? isSideAttachmentReferenceBlock(block)
      : isPlacementReferenceBlockForTarget(block, runtimeBlockName, runtimeStates))

  return preferNonInteractiveReferences(usable)
}

// 后勤 16（决策 #78）：序列层点名的「必须点哪一格的哪一面」。
// 漏斗的 facing 只由被点的那一格决定（朝向表 hopper.clickedFace），而挑参照那一步
// 按「哪块好点」排序，还把漏斗这种一点就开界面的方块压到最后——正确的那一格反而
// 排在最末。这里只在 findReferenceBlocksForPlacement() 返回之后按声明置顶，
// **不动那个冻结函数**：没有声明时这条路一个字节都不走。
// 面向量（参照 → 目标）转成图纸口径的面名，只用于日志与单测断言。
function faceNameForVector(vector) {
  if (!vector) return 'unknown'
  if (vector.y === 1) return 'up'
  if (vector.y === -1) return 'down'
  if (vector.x === 1) return 'east'
  if (vector.x === -1) return 'west'
  if (vector.z === 1) return 'south'
  if (vector.z === -1) return 'north'
  return 'unknown'
}

function clickedFacePlacementRequest(options = {}) {
  const reference = options?.clickedFaceReference
  const position = normalizePosition(reference?.position)
  if (!position) return null
  const temporary = normalizePosition(options?.temporaryReference?.position)
  return {
    position,
    face: reference?.face || null,
    // 只有声明说「这一格要先垫一块」且指的就是同一格时才垫
    temporaryPosition: temporary && sameBlockPos(temporary, position) ? temporary : null
  }
}

// 点名的那一格已经站着一块能当参照的方块了吗？站着就不用垫临时砖
// （门楼续建就是这种：另一只朝向放错的漏斗还立在那儿，潜行右键点得动）。
function clickedFaceReferenceStanding(context, request, blockName = null, states = null) {
  if (!request) return null
  const block = context?.bot?.blockAt?.(toBlockVec3(request.position))
  if (!block || AIR_BLOCKS.has(block.name)) return null
  return isPlacementReferenceBlockForTarget(block, blockName, states) ? block : null
}

// 把点名的那一格提到 references 最前面。不在场就原样返回并留一行日志——
// 回退到今天的顺序，不制造新失败。
function orderReferencesForClickedFace(context, references = [], request = null, target = null) {
  if (!request || !references.length) return references
  const index = references.findIndex(reference => sameBlockPos(reference?.position, request.position))
  if (index < 0) {
    context?.logger?.log?.(
      `[BUILD_CLICKED_FACE_REFERENCE_MISSING] target=${formatPos(target)} ` +
      `reference=${formatPos(request.position)} face=${request.face || 'unknown'} ` +
      `available=${references.map(entry => formatPos(entry.position)).join(';') || 'none'}`
    )
    return references
  }
  if (index === 0) return references
  const ordered = [...references]
  const [preferred] = ordered.splice(index, 1)
  return [preferred, ...ordered]
}

// 要潜行才点得动的参照排到最后。潜行现在能救回它们，但一块普通建材当参照
// 永远更省事：少按一次键、少一次「右键被交互吃掉」的机会。
// 稳定分区，不改同类之间原有的先后（那个顺序编码了轴向/朝向的偏好）。
function preferNonInteractiveReferences(blocks) {
  if (blocks.length < 2) return blocks
  const plain = []
  const interactive = []
  for (const block of blocks) {
    if (shouldSneakForPlacementReference(block)) interactive.push(block)
    else plain.push(block)
  }
  return interactive.length === 0 ? plain : [...plain, ...interactive]
}

function placementBlockNameMatches(actualName, expectedName, expectedStates = null) {
  return actualName === expectedName || legacyBlockNameMatches(actualName, expectedName, expectedStates)
}

function isPlacementReferenceBlock(block) {
  if (!block || AIR_BLOCKS.has(block.name)) return false
  return !NON_REFERENCE_BLOCK_PATTERNS.some(pattern => pattern.test(String(block.name || '')))
}

function isPlacementReferenceBlockForTarget(block, blockName = null, states = null) {
  if (requiresTopPlacementReference(blockName, states) && isHangingLanternTopSupportBlock(block)) {
    return true
  }
  return isPlacementReferenceBlock(block) || isTrapdoorPlacementReferenceBlock(block, blockName)
}

function isTrapdoorPlacementReferenceBlock(block, blockName = null) {
  return isTrapdoorBlockName(blockName) && isTrapdoorBlockName(block?.name)
}

function isPlacementReferenceName(blockName) {
  return isPlacementReferenceBlock({ name: blockName })
}

function isTemporaryReferenceName(blockName) {
  return TEMPORARY_REFERENCE_MATERIALS.includes(String(blockName || ''))
}

function requiresTopPlacementReference(blockName, states = null) {
  return blockName === 'lantern' && String(states?.hanging || '').toLowerCase() === 'true'
}

function requiresGroundSupportPlacement(blockName) {
  return isGroundSupportedPlantBlockName(blockName)
}

function isGroundSupportedPlantBlockName(blockName) {
  const name = String(blockName || '')
  if (name.startsWith('potted_')) return false
  return name === 'azalea' ||
    name === 'flowering_azalea' ||
    name === 'grass' ||
    name === 'short_grass' ||
    name === 'tall_grass' ||
    name === 'fern' ||
    name === 'large_fern' ||
    name === 'dead_bush' ||
    /_sapling$/.test(name) ||
    /_tulip$/.test(name) ||
    [
      'dandelion',
      'poppy',
      'blue_orchid',
      'allium',
      'azure_bluet',
      'oxeye_daisy',
      'cornflower',
      'lily_of_the_valley',
      'wither_rose',
      'sunflower',
      'lilac',
      'rose_bush',
      'peony'
    ].includes(name)
}

function isSideAttachmentReferenceBlock(block) {
  if (!block || AIR_BLOCKS.has(block.name)) return false
  const name = String(block.name || '')
  return ![
    /water$/,
    /lava$/,
    /fire$/,
    /carpet$/,
    /_bed$/,
    /^bed$/,
    /sign$/,
    /banner$/,
    /flower$/,
    /^(short_)?grass$/,
    /sapling$/
  ].some(pattern => pattern.test(name))
}

function shouldAvoidTargetColumn(bot, target) {
  const botY = Math.floor(bot?.entity?.position?.y ?? 0)
  return botIntersectsBlock(bot, target) || target.y >= botY + 2
}

function botIntersectsBlock(bot, target) {
  const pos = bot?.entity?.position
  if (!pos || !target) return false
  const minX = Math.floor(pos.x - BOT_HALF_WIDTH)
  const maxX = Math.floor(pos.x + BOT_HALF_WIDTH)
  const minY = Math.floor(pos.y)
  const maxY = Math.floor(pos.y + BOT_HEIGHT)
  const minZ = Math.floor(pos.z - BOT_HALF_WIDTH)
  const maxZ = Math.floor(pos.z + BOT_HALF_WIDTH)
  return target.x >= minX && target.x <= maxX &&
    target.y >= minY && target.y <= maxY &&
    target.z >= minZ && target.z <= maxZ
}

// How far she would fall the instant `target` stops holding her up. Only blocks
// we can actually see count: an unloaded or unmodelled column reads as null
// here, and refusing to dig on the strength of a block nobody looked at would
// strand her far more often than the bug this guards against.
function clearFallDepth(bot, target, maxProbe = DEFAULT_CLEAR_FALL_PROBE) {
  for (let depth = 1; depth <= maxProbe; depth += 1) {
    const block = bot?.blockAt?.(toBlockVec3({ x: target.x, y: target.y - depth, z: target.z }))
    if (!block) return { depth: depth - 1, known: false }
    if (!AIR_BLOCKS.has(block.name)) return { depth: depth - 1, known: true }
  }
  return { depth: maxProbe, known: true }
}

// Would digging `target` take away the last thing holding her up?
//
// botIntersectsBlock deliberately starts its box at floor(pos.y), so the block
// under her feet sits one row BELOW everything that function considers — which
// is why clearBlockForBuilding never noticed it was about to dig its own
// footing away. Same footprint, one row lower.
//
// "Sole" matters: her hitbox is 0.7 wide and straddles two columns for most of
// the positions the pathfinder actually stops in. A block she overlaps by four
// centimetres is not what is holding her up, and treating it as such would
// refuse half the ordinary clears on a building site.
function targetIsSoleFooting(bot, target) {
  const pos = bot?.entity?.position
  if (!pos || !target) return false
  const supportY = Math.floor(pos.y) - 1
  if (Math.floor(target.y) !== supportY) return false
  const minX = Math.floor(pos.x - BOT_HALF_WIDTH)
  const maxX = Math.floor(pos.x + BOT_HALF_WIDTH)
  const minZ = Math.floor(pos.z - BOT_HALF_WIDTH)
  const maxZ = Math.floor(pos.z + BOT_HALF_WIDTH)
  if (target.x < minX || target.x > maxX || target.z < minZ || target.z > maxZ) return false

  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      if (x === target.x && z === target.z) continue
      const block = bot.blockAt?.(toBlockVec3({ x, y: supportY, z }))
      if (block && !AIR_BLOCKS.has(block.name) && block.boundingBox !== 'empty') return false
    }
  }
  return true
}

// Round 5's root cause, in one guard.
//
// Clearing asked "can I reach that block" and never "where do I land once it
// is gone". Live repro on the repair server: standing on the rim block of a
// four-deep pit and told to clear it, she dug it, the action returned
// block_cleared, and the very next move came back move_timeout with her on the
// pit floor — the same terminal error 2026-08-01 died on.
//
// A single block of honest ground is not what hurt her, so this only trips on
// a drop the project already calls a hole (terrain-hazards' DEFAULT_MIN_DEPTH).
// When it does trip, the answer is the reposition machinery that already
// exists: findSafePlacementStandPositions never proposes the cell above the
// target, so any candidate it returns is by construction somewhere the dig
// cannot pull out from under her. If there is nowhere safe to stand, refuse —
// a failed clear is recoverable, a stranded bot is not.
async function stepOffTargetBeforeClearing(context, target, block, options = {}) {
  const bot = context?.bot
  if (options.allowClearingOwnFooting === true) return ok('footing_guard_disabled')
  if (!targetIsSoleFooting(bot, target)) return ok('not_own_footing')

  const minDepth = Number(options.unsafeClearFallDepth ?? HAZARD_MIN_DEPTH)
  const fall = clearFallDepth(bot, target, Number(options.clearFallProbe ?? DEFAULT_CLEAR_FALL_PROBE))
  if (!fall.known || fall.depth < minDepth) return ok('footing_drop_harmless', { fallDepth: fall.depth })

  const digDistance = options.digDistance ?? 4.5
  const stepOffOptions = {
    ...options,
    // Stepping off must not be its own way down: the pit floor below her is a
    // perfectly "safe" stand by the usual test (solid under the feet, air at
    // the head) and it is exactly where we are trying not to end up. One block
    // down is an ordinary step and stays allowed.
    minimumPlacementStandY: Math.floor(bot.entity.position.y) - 1,
    // "Near enough to reach the stand" is not good enough here: an adjacent
    // stand sits 0.71 away, inside the usual arrival slack, so the move would
    // report success without her ever leaving the block being dug. She has to
    // actually be ON it.
    safeMoveRange: Number.isFinite(options.footingStepOffRange)
      ? options.footingStepOffRange
      : DEFAULT_SAFE_MOVE_RANGE
  }
  const stands = findSafePlacementStandPositions(context, target, digDistance, stepOffOptions)
  context.logger?.log?.(
    `[BUILD_CLEAR_FOOTING_RISK] target=${formatPos(target)} block=${block?.name || 'unknown'} ` +
    `fallDepth=${fall.depth} stands=${stands.length}`
  )
  if (!stands.length) {
    return fail(`unsafe_clear_own_footing:${fall.depth}`, {
      position: target,
      blockName: block?.name,
      fallDepth: fall.depth
    })
  }

  const moved = await moveToFirstReachablePlacementStand(context, target, stands, {
    owner: options.owner,
    options: stepOffOptions,
    placeDistance: digDistance,
    reason: 'avoid_clear_footing_collapse'
  })
  // A move that "succeeded" is not the same as a move that got her off.
  // moveToFirstReachablePlacementStand is allowed to call a timed-out move good
  // when the target is still within reach from where she stopped
  // (BUILD_MOVE_TIMEOUT_REACH_RECOVERED) — sound for placing, useless here,
  // because reach was never the problem. Her feet are.
  const stepOffFailure = !moved.ok
    ? (moved.error || 'step_off_failed')
    : targetIsSoleFooting(bot, target) ? 'still_standing_on_target' : null
  if (stepOffFailure) {
    context.logger?.log?.(
      `[BUILD_CLEAR_FOOTING_STEP_OFF_FAILED] target=${formatPos(target)} ` +
      `fallDepth=${fall.depth} reason=${stepOffFailure}`
    )
    return fail(`unsafe_clear_own_footing:${stepOffFailure}`, {
      position: target,
      blockName: block?.name,
      fallDepth: fall.depth
    })
  }
  context.logger?.log?.(
    `[BUILD_CLEAR_FOOTING_STEPPED_OFF] target=${formatPos(target)} ` +
    `stand=${formatPos(normalizePosition(bot.entity.position))} fallDepth=${fall.depth}`
  )
  return ok('stepped_off_target', { fallDepth: fall.depth })
}

function findSafePlacementStandPosition(context, target, placeDistance = 4.5, options = {}) {
  return findSafePlacementStandPositions(context, target, placeDistance, options)[0] || null
}

function findSafePlacementStandPositions(context, target, placeDistance = 4.5, options = {}) {
  const bot = context?.bot
  if (!bot?.blockAt || !bot.entity?.position || !target) return []

  const footY = Math.floor(bot.entity.position.y)
  const yCandidates = uniqueNumbers([
    footY,
    footY + 1,
    target.y + 1,
    target.y,
    target.y - 2,
    target.y - 1,
    footY - 1,
    target.y - 3
  ])
  const closeOffsets = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
    { x: 1, z: 1 },
    { x: 1, z: -1 },
    { x: -1, z: 1 },
    { x: -1, z: -1 },
    { x: 2, z: 0 },
    { x: -2, z: 0 },
    { x: 0, z: 2 },
    { x: 0, z: -2 }
  ]
  const offsets = [
    ...closeOffsets,
    { x: 3, z: 0 },
    { x: -3, z: 0 },
    { x: 0, z: 3 },
    { x: 0, z: -3 },
    { x: 3, z: 1 },
    { x: 3, z: -1 },
    { x: -3, z: 1 },
    { x: -3, z: -1 },
    { x: 1, z: 3 },
    { x: -1, z: 3 },
    { x: 1, z: -3 },
    { x: -1, z: -3 }
  ]

  const candidates = []
  for (const y of yCandidates) {
    for (const offset of offsets) {
      const stand = { x: target.x + offset.x, y, z: target.z + offset.z }
      if (standIntersectsBlock(stand, target)) continue
      if (isReservedPosition(stand, options.excludedStandPositions)) continue
      if (!isSafeStandPosition(context, stand, options)) continue
      if (Number.isFinite(options.minimumPlacementStandY) && stand.y < options.minimumPlacementStandY) continue
      if (Number.isFinite(options.minHorizontalDistance) && horizontalDistance(stand, target) < options.minHorizontalDistance) continue
      if (placementReachDistance(stand, target) > placeDistance + 0.6) continue
      candidates.push(stand)
    }
  }

  candidates.sort((a, b) => {
    if (options.preferHighStand === true) {
      const aTop = a.y >= target.y ? 0 : 1
      const bTop = b.y >= target.y ? 0 : 1
      if (aTop !== bTop) return aTop - bTop
      if (aTop === 0) {
        const preferredY = target.y <= footY ? footY + 1 : target.y + 1
        const aDelta = Math.abs(a.y - preferredY)
        const bDelta = Math.abs(b.y - preferredY)
        if (aDelta !== bDelta) return aDelta - bDelta
      }
    }
    if (options.preferCloseStand === true) {
      const aHorizontal = horizontalDistance(a, target)
      const bHorizontal = horizontalDistance(b, target)
      if (aHorizontal !== bHorizontal) return aHorizontal - bHorizontal
    }
    if (options.preferOutsideReservedBounds === true) {
      const aInside = isInsideReservedBounds(a, options.reservedBounds)
      const bInside = isInsideReservedBounds(b, options.reservedBounds)
      if (aInside !== bInside) return aInside ? 1 : -1
    }
    if (options.preferHighStand !== true) {
      const aLevelDelta = Math.abs(a.y - footY)
      const bLevelDelta = Math.abs(b.y - footY)
      if (aLevelDelta !== bLevelDelta) return aLevelDelta - bLevelDelta
    }
    return distance(bot.entity.position, a) - distance(bot.entity.position, b)
  })
  return candidates
}

function shouldPlanControlledVerticalAccess(context, target, existingStands, currentReachCanPlace, options = {}, deferred = {}) {
  const currentY = Number(context?.bot?.entity?.position?.y)
  return options.allowScaffolding === true &&
    options.preferHighStand === true &&
    options.forceSafeApproach === true &&
    Array.isArray(existingStands) &&
    existingStands.length === 0 &&
    currentReachCanPlace !== true &&
    Number.isFinite(currentY) &&
    target?.y >= Math.floor(currentY) + 3 &&
    deferred.deferInitialMoveForStatefulReference !== true &&
    deferred.deferInitialMoveForTemporaryReference !== true
}

async function planControlledVerticalAccess(context, target, placeDistance = 4.5, options = {}) {
  const bot = context?.bot
  if (typeof bot?.pathfinder?.getPathTo !== 'function') {
    return fail('vertical_access_path_preview_unavailable')
  }

  const candidates = Array.isArray(options.verticalAccessCandidateStands)
    ? options.verticalAccessCandidateStands
    : controlledVerticalAccessStandCandidates(context, target, placeDistance, options)
  const maxPreviews = Math.max(1, Number(options.verticalAccessPreviewAttempts ?? 48))
  const maxPlans = Math.max(1, Number(options.verticalAccessPlanAlternatives ?? 4))
  const previewTimeoutMs = Math.max(50, Number(options.verticalAccessPreviewTimeoutMs ?? 1000))
  const extendedPreviewLimit = controlledVerticalAccessExtendedPreviewLimit(options)
  const extendedPreviewTimeoutMs = Math.max(
    previewTimeoutMs,
    Number(options.verticalAccessExtendedPreviewTimeoutMs ?? 4000) || 0
  )
  const movementOptions = {
    ...options,
    canDig: false,
    allowScaffolding: true,
    ...movementScaffoldExclusions(options, target)
  }
  const movements = configureMovements(bot, movementOptions, context)
  if (!movements) return fail('vertical_access_movements_unavailable')

  const excludedScaffoldPositions = controlledVerticalAccessExclusions(options, target)
  const plans = []
  const candidateSummaries = []
  const rejected = {
    noPath: 0,
    formalConflict: 0,
    digRequired: 0,
    previewError: 0
  }

  // The first pass previews every candidate on a slice budget derived from
  // the straight-line distance (controlledVerticalAccessPreviewSliceBudget).
  // That budget was sized for walking; a route that has to pillar 8-11
  // scaffolds up to a roof needs 2-4x more search, so on a tall target the
  // budget cuts EVERY candidate off while it is still `partial` and the step
  // fails with no_reachable_build_stance_after_vertical_access_candidates
  // although a route exists (build-18 lantern 604,77,-2: 34 candidates, 34
  // truncated at 10-12 slices; offline the same routes finish in 6-37 slices).
  // Rather than inflate the first pass for all 15-48 candidates, keep it cheap
  // and, only when it produced no plan at all, re-preview the few truncated
  // candidates whose search got closest to their stand with a real budget,
  // handing the loop back between slices so the extra time cannot starve it.
  const previewQueue = candidates.slice(0, maxPreviews)
    .map((stand, candidateIndex) => ({ stand, candidateIndex, extended: false }))
  const truncatedPreviews = []
  let extendedPreviews = 0

  for (let cursor = 0; cursor < previewQueue.length; cursor++) {
    const { stand, candidateIndex, extended } = previewQueue[cursor]
    const idSuffix = extended ? '_extended' : ''
    // Each preview is a synchronous A* slice (~0.3s live). 41 of them back to
    // back once starved the loop for 12.6s and the server kicked the client
    // for an unanswered keep-alive; hand the loop back before every candidate.
    await yieldToEventLoop()
    let preview
    let goal
    try {
      const range = safeMoveRangeForStand(stand, target, options)
      goal = new goals.GoalNear(stand.x, stand.y, stand.z, range)
      preview = await previewControlledVerticalAccessPath(
        bot,
        movements,
        goal,
        extended ? extendedPreviewTimeoutMs : previewTimeoutMs,
        extended
          ? extendedControlledVerticalAccessPreviewOptions(options, extendedPreviewTimeoutMs)
          : options
      )
      if (extended) extendedPreviews += 1
    } catch (err) {
      rejected.previewError += 1
      const summary = verticalAccessCandidateSummary(candidateIndex, stand, {
        idSuffix,
        previewResult: 'preview_error',
        rejectionReason: err?.message || 'preview_error'
      })
      candidateSummaries.push(summary)
      logVerticalAccessCandidate(context, target, summary)
      continue
    }

    const path = Array.isArray(preview.path) ? preview.path : []
    const toBreak = path.flatMap(node => Array.isArray(node?.toBreak) ? node.toBreak : [])
    const scaffoldPositions = scaffoldPositionsFromPath(path)
    const formalConflicts = scaffoldPositions
      .filter(position => excludedScaffoldPositions.has(formatPos(position)))
    const endpointNode = verticalAccessPathEndpointNode(path)
    const endpoint = endpointNode
      ? {
          x: Math.floor(endpointNode.x),
          y: Math.floor(endpointNode.y),
          z: Math.floor(endpointNode.z)
        }
      : null
    const endpointReachedGoal = Boolean(
      endpointNode &&
      typeof goal?.isEnd === 'function' &&
      goal.isEnd(endpointNode)
    )
    const partialEndpointUsable = preview?.status === 'partial' &&
      !endpointReachedGoal &&
      isUsablePartialVerticalAccessEndpoint(context, endpoint, target, placeDistance, options)
    const previewResult = preview?.status === 'partial'
      ? (endpointReachedGoal
          ? 'partial_goal_reached'
          : (partialEndpointUsable ? 'partial_reachable_endpoint' : 'partial'))
      : (preview?.status || 'missing')
    const baseSummary = {
      previewResult,
      previewSlices: preview?.previewSlices || 1,
      endpoint,
      pathNodes: path.length,
      routeLength: Number(preview?.cost) || path.length,
      scaffoldPositions,
      formalConflicts,
      toBreakCount: toBreak.length
    }
    let rejectionReason = null
    if (preview?.status !== 'success' && !endpointReachedGoal && !partialEndpointUsable) {
      rejected.noPath += 1
      rejectionReason = `preview_${preview?.status || 'missing'}`
      if (!extended && preview?.truncated === true) {
        truncatedPreviews.push({
          stand,
          candidateIndex,
          endpoint,
          scaffoldColumnClear: hasClearScaffoldColumnBelow(context, stand)
        })
      }
    } else if (toBreak.length > 0) {
      rejected.digRequired += 1
      rejectionReason = 'dig_required'
    } else if (formalConflicts.length > 0) {
      rejected.formalConflict += 1
      rejectionReason = 'formal_target_conflict'
    } else {
      const plannedStand = partialEndpointUsable ? endpoint : stand
      if (!plans.some(plan => sameBlockPos(plan.stand, plannedStand))) {
        plans.push({
          stand: plannedStand,
          requestedStand: partialEndpointUsable ? stand : null,
          pathNodes: path.length,
          pathCost: Number(preview.cost) || 0,
          scaffoldPositions
        })
      }
    }

    const summary = verticalAccessCandidateSummary(candidateIndex, stand, {
      ...baseSummary,
      idSuffix,
      rejectionReason
    })
    candidateSummaries.push(summary)
    logVerticalAccessCandidate(context, target, summary)

    // One legal plan is enough to start moving; a failed execution replans.
    if (extended && plans.length > 0) break
    if (
      !extended &&
      cursor === previewQueue.length - 1 &&
      plans.length === 0 &&
      truncatedPreviews.length > 0 &&
      extendedPreviewLimit > 0
    ) {
      const selected = selectTruncatedVerticalAccessPreviews(truncatedPreviews, extendedPreviewLimit)
      context.logger?.log?.(
        `[BUILD_VERTICAL_ACCESS_PREVIEW_EXTENDED] target=${formatPos(target)} ` +
        `truncated=${truncatedPreviews.length} extended=${selected.length} ` +
        `clearColumn=${truncatedPreviews.filter(entry => entry.scaffoldColumnClear === true).length} ` +
        `budgetMs=${extendedPreviewTimeoutMs} ` +
        `order=${selected.map(entry =>
          `vertical_${entry.candidateIndex}${entry.scaffoldColumnClear === true ? '(clear)' : '(blocked)'}`
        ).join('|')}`
      )
      previewQueue.push(...selected.map(entry => ({ ...entry, extended: true })))
    }
  }

  context.logger?.log?.(
    `[BUILD_VERTICAL_ACCESS_CANDIDATES] target=${formatPos(target)} total=${candidates.length} ` +
    `previewed=${Math.min(candidates.length, maxPreviews)} extended=${extendedPreviews} legal=${plans.length} ` +
    `noPath=${rejected.noPath} formalConflict=${rejected.formalConflict} ` +
    `digRequired=${rejected.digRequired} previewError=${rejected.previewError}`
  )
  if (plans.length === 0) {
    if (
      Array.isArray(options.verticalAccessCandidateStands) &&
      options.verticalAccessGeneratedCandidateFallback === true
    ) {
      context.logger?.log?.(
        `[BUILD_VERTICAL_ACCESS_CANDIDATE_FALLBACK] target=${formatPos(target)} ` +
        `restricted=${candidates.length} reason=restricted_candidates_exhausted`
      )
      const fallback = await planControlledVerticalAccess(context, target, placeDistance, {
        ...options,
        verticalAccessCandidateStands: undefined,
        verticalAccessGeneratedCandidateFallback: false,
        verticalAccessPreviewAttempts: Math.max(
          maxPreviews,
          Math.max(1, Number(options.verticalAccessGeneratedFallbackPreviewAttempts ?? 96))
        )
      })
      if (fallback.ok) {
        return ok('controlled_vertical_access_planned_after_generated_fallback', {
          ...fallback.data,
          fallbackFromRestrictedCandidates: true,
          restrictedCandidateSummaries: candidateSummaries
        })
      }
      return {
        ...fallback,
        restrictedCandidateSummaries: candidateSummaries
      }
    }
    return fail('no_reachable_build_stance_after_vertical_access_candidates', {
      target,
      candidateCount: candidates.length,
      previewedCandidateCount: Math.min(candidates.length, maxPreviews),
      rejected,
      candidateSummaries
    })
  }

  const selectedPlans = [...plans]
    .sort((a, b) => {
      const terminalPillarDelta = verticalAccessTerminalPillarRisk(a) - verticalAccessTerminalPillarRisk(b)
      if (terminalPillarDelta !== 0) return terminalPillarDelta
      if (options.strictPlacementReferencePosition) {
        const referenceReachDelta = placementReferenceReachDistance(
          a.stand,
          options.strictPlacementReferencePosition
        ) - placementReferenceReachDistance(
          b.stand,
          options.strictPlacementReferencePosition
        )
        if (Math.abs(referenceReachDelta) > 0.001) return referenceReachDelta
      }
      const pathCostDelta = a.pathCost - b.pathCost
      if (Math.abs(pathCostDelta) > 0.001) return pathCostDelta
      return a.pathNodes - b.pathNodes
    })
    .slice(0, maxPlans)
  const selected = selectedPlans[0]
  context.logger?.log?.(
    `[BUILD_VERTICAL_ACCESS_PLAN] target=${formatPos(target)} stand=${formatPos(selected.stand)} ` +
    `pathNodes=${selected.pathNodes} scaffoldCount=${selected.scaffoldPositions.length} ` +
    `scaffolds=${selected.scaffoldPositions.map(formatPos).join('|') || 'none'} ` +
    `alternatives=${selectedPlans.map(plan => formatPos(plan.stand)).join('|')}`
  )
  return ok('controlled_vertical_access_planned', {
    stands: selectedPlans.map(plan => plan.stand),
    plans: selectedPlans,
    candidateSummaries
  })
}

async function previewControlledVerticalAccessPath(bot, movements, goal, timeoutMs, options = {}) {
  const pathfinder = bot?.pathfinder
  const fallback = () => ({
    ...pathfinder.getPathTo(movements, goal, timeoutMs),
    previewSlices: 1
  })
  if (typeof pathfinder?.getPathFromTo !== 'function') return fallback()

  const maxSlices = controlledVerticalAccessPreviewSliceBudget(bot, goal, options)
  const tickTimeoutMs = controlledVerticalAccessPreviewTickTimeoutMs(timeoutMs, options)
  // A* charges `timeout` against the wall clock from the moment the search is
  // created. The default pass runs its slices back to back, so wall time and
  // compute time agree. A pass that hands the loop back between slices must
  // not be billed for the packets it lets through, so it gets wall slack.
  const yieldBetweenSlices = options.verticalAccessPreviewYieldBetweenSlices === true
  const generator = pathfinder.getPathFromTo(
    movements,
    bot.entity.position,
    goal,
    {
      timeout: yieldBetweenSlices ? timeoutMs * 2 : timeoutMs,
      tickTimeout: tickTimeoutMs
    }
  )
  let preview = null
  let previewSlices = 0
  while (previewSlices < maxSlices) {
    if (yieldBetweenSlices && previewSlices > 0) await yieldToEventLoop()
    const next = generator.next()
    if (next.done) break
    preview = next.value?.result || next.value || null
    previewSlices += 1
    if (preview?.status !== 'partial') break
  }
  if (!preview) return fallback()
  return {
    ...preview,
    previewSlices,
    // still partial when the slice budget ran out: WE stopped the search, the
    // pathfinder did not prove anything about the route
    truncated: preview.status === 'partial' && previewSlices >= maxSlices
  }
}

function controlledVerticalAccessPreviewTickTimeoutMs(timeoutMs, options = {}) {
  const requested = Number(options.verticalAccessPreviewTickTimeoutMs ?? 40)
  return Number.isFinite(requested)
    ? Math.max(5, Math.min(timeoutMs, requested))
    : Math.min(timeoutMs, 40)
}

function controlledVerticalAccessExtendedPreviewLimit(options = {}) {
  const requested = Number(options.verticalAccessExtendedPreviewCandidates ?? 4)
  return Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 4
}

// The second pass spends its whole budget on one candidate: as many slices as
// the budget buys, with the loop handed back between them.
function extendedControlledVerticalAccessPreviewOptions(options = {}, extendedTimeoutMs) {
  const tickTimeoutMs = controlledVerticalAccessPreviewTickTimeoutMs(extendedTimeoutMs, options)
  return {
    ...options,
    verticalAccessPreviewSlices: Math.max(1, Math.ceil(extendedTimeoutMs / tickTimeoutMs)),
    verticalAccessPreviewYieldBetweenSlices: true
  }
}

// The extended pass buys at most `limit` re-previews and stops at the first
// legal one, so this order decides whether the step gets a plan at all.
// A truncated search reports the node closest to the goal it has reached so
// far, and among stands of the same kind the one that got nearest is the one
// most likely to finish. But "nearest" alone clusters: at gate lantern
// 604,82,-1 all 32 candidates truncate, exactly one finishes inside the
// extended budget, and remaining-distance order spends all four slots on four
// neighbours of one blocked column and never reaches it. A stand a straight
// scaffold pillar can reach comes first; a stand whose column is blocked has
// to be searched around the obstruction, which is why it truncated.
function selectTruncatedVerticalAccessPreviews(truncated = [], limit = 4) {
  return [...truncated]
    .sort((a, b) => {
      const aClear = a?.scaffoldColumnClear === true
      const bClear = b?.scaffoldColumnClear === true
      if (aClear !== bClear) return aClear ? -1 : 1
      const remainingDelta = truncatedPreviewRemainingDistance(a) - truncatedPreviewRemainingDistance(b)
      if (Math.abs(remainingDelta) > 0.001) return remainingDelta
      return a.candidateIndex - b.candidateIndex
    })
    .slice(0, Math.max(0, limit))
}

function truncatedPreviewRemainingDistance(entry) {
  if (!entry?.endpoint || !entry?.stand) return Number.POSITIVE_INFINITY
  return distance(entry.endpoint, entry.stand)
}

function controlledVerticalAccessPreviewSliceBudget(bot, goal, options = {}) {
  if (options.verticalAccessPreviewSlices != null) {
    const requested = Number(options.verticalAccessPreviewSlices)
    return Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 6
  }

  const minimumSlices = 6
  const requestedMaximum = Number(options.verticalAccessPreviewMaxSlices ?? 16)
  const maximumSlices = Number.isFinite(requestedMaximum)
    ? Math.max(minimumSlices, Math.floor(requestedMaximum))
    : 16
  const requestedBlocksPerSlice = Number(options.verticalAccessPreviewBlocksPerSlice ?? 3)
  const blocksPerSlice = Number.isFinite(requestedBlocksPerSlice) && requestedBlocksPerSlice > 0
    ? requestedBlocksPerSlice
    : 3
  const current = bot?.entity?.position
  const goalPosition = [goal?.x, goal?.y, goal?.z].every(Number.isFinite)
    ? { x: goal.x, y: goal.y, z: goal.z }
    : null
  if (!current || !goalPosition) return minimumSlices

  const distanceSlices = 2 + Math.ceil(distance(current, goalPosition) / blocksPerSlice)
  return Math.min(maximumSlices, Math.max(minimumSlices, distanceSlices))
}

function isUsablePartialVerticalAccessEndpoint(context, endpoint, target, placeDistance, options = {}) {
  if (!endpoint || !target || standIntersectsBlock(endpoint, target)) return false
  if (Number.isFinite(options.minimumPlacementStandY) && endpoint.y < options.minimumPlacementStandY) return false
  if (!isSafeStandPosition(context, endpoint, {
    ...options,
    allowReservedAirStand: options.allowReservedAirStand === true
  })) return false
  if (placementReachDistance(endpoint, target) > placeDistance) return false
  if (options.strictPlacementReferencePosition &&
    !isStrictReferenceReachableFromStand(
      endpoint,
      options.strictPlacementReferencePosition,
      placeDistance
    )) return false
  return true
}

function verticalAccessTerminalPillarRisk(plan) {
  const stand = plan?.stand
  const scaffolds = Array.isArray(plan?.scaffoldPositions) ? plan.scaffoldPositions : []
  if (!stand || scaffolds.length === 0) return 0

  const terminalSupportY = stand.y - 1
  const firstTopIndex = scaffolds.findIndex(position => position.y === terminalSupportY)
  if (firstTopIndex < 0) return 0
  const approach = scaffolds[firstTopIndex - 1]
  if (!approach) return 1

  // The live client can finish the climb when its first top support is one
  // level up and laterally adjacent to the previous scaffold: it places that
  // block beside its feet and steps onto it. A same-column transition asks it
  // to place the top block inside its own feet cell; path preview accepts that
  // route, but execution repeatedly stalls one block below it.
  const horizontal = horizontalDistance(approach, scaffolds[firstTopIndex])
  const hasDiagonalTopStep = approach.y === terminalSupportY - 1 &&
    horizontal > 0 && horizontal <= Math.SQRT2 + 0.001
  return hasDiagonalTopStep ? 0 : 1
}

function verticalAccessPathEndpoint(path = []) {
  const node = verticalAccessPathEndpointNode(path)
  return node
    ? {
        x: Math.floor(node.x),
        y: Math.floor(node.y),
        z: Math.floor(node.z)
      }
    : null
}

function verticalAccessPathEndpointNode(path = []) {
  for (let index = path.length - 1; index >= 0; index--) {
    const node = path[index]
    if (![node?.x, node?.y, node?.z].every(Number.isFinite)) continue
    return node
  }
  return null
}

function verticalAccessCandidateSummary(candidateIndex, stand, details = {}) {
  return {
    id: `vertical_${candidateIndex}${details.idSuffix || ''}`,
    stand,
    endpoint: details.endpoint || null,
    pathNodes: details.pathNodes || 0,
    routeLength: details.routeLength || 0,
    previewSlices: details.previewSlices || 1,
    scaffoldPositions: details.scaffoldPositions || [],
    formalConflicts: details.formalConflicts || [],
    toBreakCount: details.toBreakCount || 0,
    previewResult: details.previewResult || 'missing',
    executionResult: 'not_executed',
    rejectionReason: details.rejectionReason || null
  }
}

function logVerticalAccessCandidate(context, target, summary) {
  context.logger?.log?.(
    `[BUILD_VERTICAL_ACCESS_CANDIDATE] target=${formatPos(target)} id=${summary.id} ` +
    `stand=${formatPos(summary.stand)} endpoint=${summary.endpoint ? formatPos(summary.endpoint) : 'none'} ` +
    `preview=${summary.previewResult} execution=${summary.executionResult} ` +
    `previewSlices=${summary.previewSlices} pathNodes=${summary.pathNodes} routeLength=${summary.routeLength} ` +
    `scaffolds=${summary.scaffoldPositions.map(formatPos).join('|') || 'none'} ` +
    `formalConflicts=${summary.formalConflicts.map(formatPos).join('|') || 'none'} ` +
    `toBreak=${summary.toBreakCount} ` +
    `rejection=${summary.rejectionReason || 'none'}`
  )
}

function controlledVerticalAccessStandCandidates(context, target, placeDistance = 4.5, options = {}) {
  const bot = context?.bot
  if (!bot?.blockAt || !bot.entity?.position || !target) return []

  const candidates = []
  const yCandidates = [target.y - 4, target.y - 3, target.y - 2]
  for (const y of yCandidates) {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (dx === 0 && dz === 0) continue
        const stand = { x: target.x + dx, y, z: target.z + dz }
        if (standIntersectsBlock(stand, target)) continue
        if (Number.isFinite(options.minimumPlacementStandY) && stand.y < options.minimumPlacementStandY) continue
        if (isReservedPosition(stand, options.reservedPositions)) continue
        if (isReservedPosition({ x: stand.x, y: stand.y + 1, z: stand.z }, options.reservedPositions)) continue
        if (!isAirAt(context, stand) || !isAirAt(context, { x: stand.x, y: stand.y + 1, z: stand.z })) continue
        if (placementReachDistance(stand, target) > placeDistance) continue
        if (
          options.strictPlacementReferencePosition &&
          !isStrictReferenceReachableFromStand(
            stand,
            options.strictPlacementReferencePosition,
            placeDistance
          )
        ) continue
        candidates.push(stand)
      }
    }
  }

  // Nothing above this point looks under the candidate's feet, so the list
  // mixes stands a scaffold pillar walks straight up to with stands whose
  // column is blocked and can only be approached sideways. Partition, do not
  // filter: the blocked ones stay as the fallback they have always been.
  const clearColumn = new Map(candidates.map(stand => [
    formatPos(stand),
    hasClearScaffoldColumnBelow(context, stand)
  ]))
  candidates.sort((a, b) => {
    const aClear = clearColumn.get(formatPos(a)) === true
    const bClear = clearColumn.get(formatPos(b)) === true
    if (aClear !== bClear) return aClear ? -1 : 1
    if (options.strictPlacementReferencePosition) {
      const referenceDelta = placementReferenceReachDistance(
        a,
        options.strictPlacementReferencePosition
      ) - placementReferenceReachDistance(
        b,
        options.strictPlacementReferencePosition
      )
      if (Math.abs(referenceDelta) > 0.001) return referenceDelta
    }
    const distanceDelta = distance(bot.entity.position, a) - distance(bot.entity.position, b)
    if (Math.abs(distanceDelta) > 0.001) return distanceDelta
    if (options.preferOutsideReservedBounds === true) {
      const aInside = isInsideReservedBounds(a, options.reservedBounds)
      const bInside = isInsideReservedBounds(b, options.reservedBounds)
      if (aInside !== bInside) return aInside ? 1 : -1
    }
    return placementReachDistance(a, target) - placementReachDistance(b, target)
  })
  return candidates
}

function isAirAt(context, position) {
  const block = context?.bot?.blockAt?.(toBlockVec3(position))
  return !block || AIR_BLOCKS.has(block.name)
}

function controlledVerticalAccessExclusions(options = {}, target = null) {
  const positions = new Set()
  collectPositionKeys(positions, options.reservedPositions)
  collectPositionKeys(positions, options.scaffoldExclusionPositions)
  collectPositionKeys(positions, target)
  return positions
}

function collectPositionKeys(output, positions) {
  if (!positions) return
  if (typeof positions === 'string') {
    output.add(positions)
    return
  }
  if (Number.isFinite(positions.x) && Number.isFinite(positions.y) && Number.isFinite(positions.z)) {
    output.add(formatPos({
      x: Math.floor(positions.x),
      y: Math.floor(positions.y),
      z: Math.floor(positions.z)
    }))
    return
  }
  if (typeof positions[Symbol.iterator] !== 'function') return
  for (const position of positions) collectPositionKeys(output, position)
}

function scaffoldPositionsFromPath(path = []) {
  const positions = []
  const keys = new Set()
  for (const node of path) {
    for (const placement of Array.isArray(node?.toPlace) ? node.toPlace : []) {
      if (placement?.useOne) continue
      const position = scaffoldPlacementPosition(placement)
      if (!position) continue
      const key = formatPos(position)
      if (keys.has(key)) continue
      keys.add(key)
      positions.push(position)
    }
  }
  return positions
}

function scaffoldPlacementPosition(placement) {
  if (![placement?.x, placement?.y, placement?.z].every(Number.isFinite)) return null
  // mineflayer-pathfinder stores the REFERENCE block in toPlace.x/y/z and
  // the clicked face in dx/dy/dz. The temporary block appears on the other
  // side of that face, not in the reference cell itself.
  return {
    x: Math.floor(placement.x + (Number(placement.dx) || 0)),
    y: Math.floor(placement.y + (Number(placement.dy) || 0)),
    z: Math.floor(placement.z + (Number(placement.dz) || 0))
  }
}

// Stand candidates arrive sorted by STRAIGHT-LINE distance from the bot (see
// the comparator in findSafePlacementStandPositions). On sloped or enclosed
// sites the straight-line nearest candidate is regularly the one the bot
// cannot walk to without a long detour, and nothing downstream ever asks the
// pathfinder whether the stand is reachable at all. Live evidence, case2
// acceptance 2026-08-01: every candidate for target 583,65,-91 sat at y=62 on
// the far side of a 3-block drop; the bot burned the flat 15s move budget
// walking 74 blocks east and the build task died with move_timeout.
//
// Fix: before spending real move budget, ask the pathfinder for a bounded
// path preview per candidate and REORDER by route feasibility. Candidates are
// only demoted, never dropped, so a failed, skipped, or unavailable preview
// can never hand the caller a shorter (or empty) candidate list than before.
const STAND_PATH_TIER_REACHABLE = 0
const STAND_PATH_TIER_UNRESOLVED = 1
const STAND_PATH_TIER_NO_PATH = 2

function standPathTierForStatus(status) {
  if (status === 'success') return STAND_PATH_TIER_REACHABLE
  if (status === 'noPath') return STAND_PATH_TIER_NO_PATH
  // partial / timeout / missing / preview_error / unprobed: the search ran out
  // of budget rather than proving anything. Keep them in their original order
  // between the proven-reachable and the proven-unreachable candidates.
  return STAND_PATH_TIER_UNRESOLVED
}

function comparePrescreenedStands(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier
  // Route cost only ranks candidates whose search actually completed. A
  // partial search reports the g-score of whichever node it happened to reach
  // first, which is not comparable across candidates.
  if (a.tier === STAND_PATH_TIER_REACHABLE && a.cost !== b.cost) return a.cost - b.cost
  return a.index - b.index
}

// Flat adjacent work is the common case and must stay free: a candidate on the
// bot's own level within a few blocks needs no preview to be trusted.
function isTriviallyReachableStand(bot, stand, options = {}) {
  const position = bot?.entity?.position
  if (!position || !stand) return false
  if (Math.floor(position.y) !== Math.floor(stand.y)) return false
  const requested = Number(options.standPathPrescreenTrivialDistance ?? 3)
  const limit = Number.isFinite(requested) ? requested : 3
  return horizontalDistance(position, stand) <= limit
}

function prescreenPlacementStandsByPathCost(context, target, stands, params = {}) {
  const options = params.options || {}
  const skip = reason => ({ stands, applied: false, reason, probed: 0, ranking: [] })
  if (options.standPathPrescreen === false) return skip('disabled')
  if (!Array.isArray(stands) || stands.length < 2) return skip('single_candidate')
  const bot = context?.bot
  if (typeof bot?.pathfinder?.getPathTo !== 'function') return skip('pathfinder_unavailable')
  if (isTriviallyReachableStand(bot, stands[0], options)) return skip('nearest_stand_trivial')

  const movements = configureMovements(bot, {
    ...options,
    canDig: options.canDig ?? false,
    allowScaffolding: options.allowScaffolding === true,
    ...movementScaffoldExclusions(options, target)
  }, context)
  if (!movements) return skip('movements_unavailable')

  const probeLimit = Math.max(2, Number(options.standPathPrescreenCandidates ?? 6))
  const timeoutMs = Math.max(5, Number(options.standPathPrescreenTimeoutMs ?? 25))
  const scored = stands.map((stand, index) => ({
    stand,
    index,
    tier: STAND_PATH_TIER_UNRESOLVED,
    cost: Number.POSITIVE_INFINITY,
    status: 'unprobed'
  }))

  let probed = 0
  for (const entry of scored.slice(0, probeLimit)) {
    let preview = null
    try {
      const range = safeMoveRangeForStand(entry.stand, target, options)
      preview = bot.pathfinder.getPathTo(
        movements,
        new goals.GoalNear(entry.stand.x, entry.stand.y, entry.stand.z, range),
        timeoutMs
      )
    } catch {
      entry.status = 'preview_error'
      continue
    }
    probed += 1
    entry.status = preview?.status || 'missing'
    entry.cost = Number.isFinite(preview?.cost) ? Number(preview.cost) : Number.POSITIVE_INFINITY
    entry.tier = standPathTierForStatus(entry.status)
  }

  const ordered = [...scored].sort(comparePrescreenedStands)
  const reordered = ordered.some((entry, position) => entry.index !== position)
  const ranking = ordered.slice(0, probeLimit).map(entry => (
    entry.status === 'success' && Number.isFinite(entry.cost)
      ? `${formatPos(entry.stand)}:success:${entry.cost.toFixed(1)}`
      : `${formatPos(entry.stand)}:${entry.status}`
  ))
  return {
    stands: ordered.map(entry => entry.stand),
    applied: true,
    reason: reordered ? 'reordered' : 'order_preserved',
    probed,
    ranking
  }
}

async function moveToFirstReachablePlacementStand(context, target, stands, params = {}) {
  const options = params.options || {}
  disableControlledPathfinderPlacementReturn(context, target, options)
  const maxAttempts = Math.max(1, Number(options.standMoveAttempts || 4))
  const prescreen = prescreenPlacementStandsByPathCost(context, target, stands, params)
  const orderedStands = prescreen.stands
  const attempts = placementStandAttempts(orderedStands, target, maxAttempts, options)
  const placeDistance = params.placeDistance ?? 4.5
  let lastResult = null
  const blacklisted = orderedStands.filter(stand => isStandMoveBlacklisted(options, stand))
  context.logger?.log?.(
    `[BUILD_STAND_PATH_PRESCREEN] target=${formatPos(target)} applied=${prescreen.applied} ` +
    `result=${prescreen.reason} probed=${prescreen.probed} ` +
    `ranking=${prescreen.ranking.join('|') || 'none'}`
  )
  context.logger?.log?.(
    `[BUILD_STANCE_CANDIDATES] target=${formatPos(target)} total=${orderedStands.length} ` +
    `attempts=${attempts.map(formatPos).join('|') || 'none'} ` +
    `blacklisted=${blacklisted.map(formatPos).join('|') || 'none'}`
  )
  if (options.allowScaffolding === true) {
    context.logger?.log?.(
      `[BUILD_SCAFFOLD_DECISION] target=${formatPos(target)} position=pathfinder_dynamic ` +
      `targetConflict=excluded ownerTask=${options.scaffoldOwnerTask ?? params.owner ?? 'unknown'} ` +
      `ownerStep=${options.scaffoldOwnerStep ?? 'unknown'} cleanupPolicy=no_reserved_blueprint_placement`
    )
  }
  if (!attempts.length) {
    return fail('no_reachable_build_stance_after_scaffold_candidates', {
      target,
      blacklistedStandPositions: blacklisted
    })
  }

  for (let index = 0; index < attempts.length; index++) {
    const stand = attempts[index]
    const reason = index === 0 ? params.reason : `${params.reason || 'placement_stand'}_retry`
    const plannedScaffoldPositions = controlledVerticalAccessScaffoldPositions(options, stand)
    const plannedScaffoldKeys = Array.isArray(plannedScaffoldPositions)
      ? new Set(plannedScaffoldPositions.map(formatPos))
      : null
    const plannedScaffoldBaseline = snapshotControlledVerticalAccessScaffolds(
      context,
      plannedScaffoldPositions
    )
    const candidateScaffoldPositions = []
    const candidateScaffoldKeys = new Set()
    let scaffoldDeviation = null
    const onCandidateScaffoldPlaced = (position, placedName) => {
      options.onScaffoldPlaced?.(position, placedName)
      const normalized = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      }
      const key = formatPos(normalized)
      if (!candidateScaffoldKeys.has(key)) {
        candidateScaffoldKeys.add(key)
        candidateScaffoldPositions.push(normalized)
      }
      if (plannedScaffoldKeys && !plannedScaffoldKeys.has(key)) {
        scaffoldDeviation = key
      }
    }
    const shouldContinueCandidateMove = () => {
      if (scaffoldDeviation) return false
      return typeof options.shouldContinue !== 'function' || options.shouldContinue()
    }
    const cornerRecovery = await recoverUnreservedTemporaryCornerResidue(
      context,
      stand,
      {
        lockOwner: params.owner,
        options,
        target
      }
    )
    if (!cornerRecovery.ok) return cornerRecovery
    context.logger?.log?.(`[BUILD_PLACE_REPOSITION] target=${formatPos(target)} stand=${formatPos(stand)} reason=${reason}`)
    const candidateMoveOptions = {
      owner: params.owner,
      range: safeMoveRangeForStand(stand, target, options),
      timeoutMs: standMoveTimeoutWithMemo(context, stand, options),
      canDig: options.canDig ?? false,
      allowScaffolding: options.allowScaffolding === true,
      onScaffoldPlaced: onCandidateScaffoldPlaced,
      scaffoldAllowedPositions: plannedScaffoldPositions,
      reachedWhen: controlledVerticalAccessReachedWhen(context, target, params, placeDistance, options),
      verifyGoalReachedEvent: plannedScaffoldKeys != null,
      requireOnGroundAtGoal: plannedScaffoldKeys != null,
      ...movementScaffoldExclusions(options, target),
      shouldContinue: shouldContinueCandidateMove,
      holdLock: true
    }
    let moved = await moveTo(context, stand, candidateMoveOptions)
    reconcileControlledVerticalAccessScaffolds(
      context,
      target,
      stand,
      plannedScaffoldPositions,
      plannedScaffoldBaseline,
      candidateScaffoldKeys,
      onCandidateScaffoldPlaced
    )
    if (scaffoldDeviation) {
      const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
        owner: params.owner,
        options,
        reason: `scaffold_deviation:${scaffoldDeviation}`
      })
      if (!cleanup.ok) return cleanup
      context.logger?.log?.(
        `[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} ` +
        `reason=vertical_access_scaffold_deviation position=${scaffoldDeviation}`
      )
      lastResult = fail(`vertical_access_scaffold_deviation:${scaffoldDeviation}`)
      continue
    }
    const trackedVerticalProgress = plannedScaffoldKeys != null || options.trackVerticalAccessScaffolds === true
    if (
      !moved.ok &&
      moved.error === 'move_timeout' &&
      trackedVerticalProgress &&
      candidateScaffoldPositions.length > 0 &&
      options.controlledVerticalAccessProgressRetry !== false
    ) {
      const continuationTimeoutMs = Math.max(
        500,
        Number(options.verticalAccessProgressRetryTimeoutMs ?? options.nearXZMoveTimeoutMs ?? 12000)
      )
      context.logger?.log?.(
        `[BUILD_VERTICAL_ACCESS_PROGRESS_RETRY] target=${formatPos(target)} ` +
        `stand=${formatPos(stand)} placed=${candidateScaffoldPositions.map(formatPos).join('|')} ` +
        `timeoutMs=${continuationTimeoutMs}`
      )
      moved = await moveTo(context, stand, {
        ...candidateMoveOptions,
        timeoutMs: continuationTimeoutMs
      })
      reconcileControlledVerticalAccessScaffolds(
        context,
        target,
        stand,
        plannedScaffoldPositions,
        plannedScaffoldBaseline,
        candidateScaffoldKeys,
        onCandidateScaffoldPlaced
      )
      context.logger?.log?.(
        `[BUILD_VERTICAL_ACCESS_PROGRESS_RETRY_${moved.ok ? 'RECOVERED' : 'FAILED'}] ` +
        `target=${formatPos(target)} stand=${formatPos(stand)} ` +
        `result=${moved.ok ? moved.message : moved.error || 'unknown'}`
      )
      if (scaffoldDeviation) {
        const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
          owner: params.owner,
          options,
          reason: `scaffold_deviation:${scaffoldDeviation}`
        })
        if (!cleanup.ok) return cleanup
        context.logger?.log?.(
          `[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} ` +
          `reason=vertical_access_scaffold_deviation position=${scaffoldDeviation}`
        )
        lastResult = fail(`vertical_access_scaffold_deviation:${scaffoldDeviation}`)
        continue
      }
    }
    if (!moved.ok && moved.error === 'move_timeout') {
      rememberStandTimeout(options, stand)
      context.logger?.log?.(`[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} reason=stand_move_timeout_blacklisted`)
    }
    if (moved.ok) {
      if (botIntersectsBlock(context?.bot, target)) {
        context.logger?.log?.(`[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} reason=placement_target_occupied_after_move`)
        lastResult = fail('placement_target_occupied')
        const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
          owner: params.owner,
          options,
          reason: 'placement_target_occupied_after_move'
        })
        if (!cleanup.ok) return cleanup
        continue
      }
      if (options.requireReachablePlacementAfterStandMove === true) {
        const reachable = options.requireStrictPlacementReferenceReachAfterStandMove === true
          ? strictCurrentPlacementReferenceReachability(
              context,
              target,
              params.blockName,
              placeDistance,
              options,
              params.referencePosition
            )
          : currentPlacementReachability(
              context,
              target,
              params.blockName,
              placeDistance,
              options,
              params.referencePosition
            )
        if (!reachable.ok) {
          context.logger?.log?.(
            `[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} ` +
            'reason=placement_unreachable_after_move'
          )
          lastResult = fail('placement_unreachable_after_stand_move')
          const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
            owner: params.owner,
            options,
            reason: 'placement_unreachable_after_move'
          })
          if (!cleanup.ok) return cleanup
          continue
        }
      }
      return ok('placement_stand_reached', { standPosition: stand, attempts: index + 1 })
    }
    lastResult = moved
    if (moved.error === 'move_timeout') {
      // A controlled vertical route can time out on the same tick that its
      // final productive scaffold move brings a valid placement reference
      // into reach. Check that state before the XZ-only fallback: the fallback
      // may deliberately leave the elevated route and destroy the reach that
      // the caller is trying to recover.
      const recovered = currentPlacementReachability(context, target, params.blockName, placeDistance, options, params.referencePosition)
      if (recovered.ok && placementRecoveryStandHeightReached(
        context,
        target,
        params.blockName,
        placeDistance,
        options,
        params.referencePosition
      )) {
        context.logger?.log?.(`[BUILD_MOVE_TIMEOUT_REACH_RECOVERED] target=${formatPos(target)} reason=${recovered.reason}`)
        return ok('placement_reachable_after_partial_move', {
          standPosition: stand,
          attempts: index + 1,
          reachReason: recovered.reason
        })
      }
    }
    if (moved.error === 'move_timeout' && options.allowNearXZFallback === true) {
      context.logger?.log?.(`[BUILD_PLACE_REPOSITION_XZ_FALLBACK] target=${formatPos(target)} stand=${formatPos(stand)} reason=${reason}`)
      const xzMoved = await moveTo(context, stand, {
        ...candidateMoveOptions,
        timeoutMs: options.nearXZMoveTimeoutMs ?? Math.min(placementMoveTimeoutMs(context?.bot, stand, options), 12000),
        ignoreY: true
      })
      reconcileControlledVerticalAccessScaffolds(
        context,
        target,
        stand,
        plannedScaffoldPositions,
        plannedScaffoldBaseline,
        candidateScaffoldKeys,
        onCandidateScaffoldPlaced
      )
      if (scaffoldDeviation) {
        const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
          owner: params.owner,
          options,
          reason: `scaffold_deviation:${scaffoldDeviation}`
        })
        if (!cleanup.ok) return cleanup
        context.logger?.log?.(
          `[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} ` +
          `reason=vertical_access_scaffold_deviation position=${scaffoldDeviation}`
        )
        lastResult = fail(`vertical_access_scaffold_deviation:${scaffoldDeviation}`)
        continue
      }
      if (xzMoved.ok) {
        if (botIntersectsBlock(context?.bot, target)) {
          context.logger?.log?.(`[BUILD_PLACE_REPOSITION_REJECT] target=${formatPos(target)} stand=${formatPos(stand)} reason=placement_target_occupied_after_xz_move`)
          lastResult = fail('placement_target_occupied')
          const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
            owner: params.owner,
            options,
            reason: 'placement_target_occupied_after_xz_move'
          })
          if (!cleanup.ok) return cleanup
          continue
        }
        const recovered = currentPlacementReachability(context, target, params.blockName, placeDistance, options, params.referencePosition)
        if (recovered.ok && placementRecoveryStandHeightReached(
          context,
          target,
          params.blockName,
          placeDistance,
          options,
          params.referencePosition
        )) {
          context.logger?.log?.(`[BUILD_MOVE_XZ_REACH_RECOVERED] target=${formatPos(target)} stand=${formatPos(stand)} reason=${reason}`)
          return ok('placement_reachable_after_xz_move', {
            standPosition: stand,
            attempts: index + 1,
            reachReason: recovered.reason
          })
        }
        lastResult = fail('placement_still_unreachable_after_xz_move')
      } else {
        lastResult = xzMoved
      }
    }
    const shouldFreshReplan = shouldFreshReplanControlledVerticalAccess(
      moved,
      plannedScaffoldKeys,
      options
    )
    const cleanup = await cleanupRejectedVerticalAccessCandidate(context, target, stand, candidateScaffoldPositions, {
      owner: params.owner,
      options,
      reason: moved.error || lastResult?.error || 'candidate_move_failed'
    })
    if (!cleanup.ok) return cleanup
    if (moved.error !== 'move_timeout') return moved
    if (shouldFreshReplan) {
      const freshPlan = await planFreshControlledVerticalAccess(
        context,
        target,
        placeDistance,
        options
      )
      if (freshPlan.ok) {
        const current = context?.bot?.entity?.position
        context.logger?.log?.(
          `[BUILD_VERTICAL_ACCESS_FRESH_REPLAN] target=${formatPos(target)} ` +
          `from=${current ? `${Number(current.x).toFixed(3)},${Number(current.y).toFixed(3)},${Number(current.z).toFixed(3)}` : 'unknown'} ` +
          `stand=${freshPlan.data.stands.map(formatPos).join('|')}`
        )
        return moveToFirstReachablePlacementStand(
          context,
          target,
          freshPlan.data.stands,
          {
            ...params,
            options: freshPlan.data.options,
            reason: 'controlled_vertical_access_fresh_replan'
          }
        )
      }
      context.logger?.log?.(
        `[BUILD_VERTICAL_ACCESS_FRESH_REPLAN_SKIPPED] target=${formatPos(target)} ` +
        `reason=${freshPlan.error || 'no_plan'}`
      )
    }
    if (options.preferHighStand === true && target && stand.y >= target.y) {
      promoteLowStandFallback(attempts, target, index)
    }
  }

  return lastResult || fail('move_timeout')
}

function disableControlledPathfinderPlacementReturn(context, target, options = {}) {
  const pathfinder = context?.bot?.pathfinder
  // mineflayer-pathfinder 2.4.5 keeps its closure-local `returningPos`
  // across resetPath(), setGoal(), setMovements(), and stop(). Once that
  // return point becomes stale or blocked it runs before every new path and
  // can freeze unrelated moves for the rest of the process. Formal
  // controlled construction already owns and cleans every scaffold, so its
  // routes do not need the upstream edge-placement return maneuver.
  if (!pathfinder || options.controlledVerticalAccessPlans == null) return false
  if (options.disablePathfinderPlacementReturn === false) return false
  if (pathfinder.LOSWhenPlacingBlocks === false) return false
  pathfinder.LOSWhenPlacingBlocks = false
  context.logger?.log?.(
    `[BUILD_PATHFINDER_PLACEMENT_RETURN_DISABLED] target=${formatPos(target)} ` +
    'scope=controlled_construction reason=prevent_stale_returning_position'
  )
  return true
}

function shouldFreshReplanControlledVerticalAccess(moved, plannedScaffoldKeys, options = {}) {
  // Every controlled route is tied to the geometry captured by its preview.
  // The world can change between preview and execution (for example, a
  // delayed temporary support can reappear), so a timeout needs one fresh
  // plan even when this candidate did not place a new scaffold itself.
  // planFreshControlledVerticalAccess disables the flag on the recursive
  // call, keeping this recovery strictly bounded.
  return moved?.error === 'move_timeout' &&
    plannedScaffoldKeys != null &&
    options.controlledVerticalAccessFreshReplan !== false
}

async function recoverUnreservedTemporaryCornerResidue(context, stand, params = {}) {
  const bot = context?.bot
  const options = params.options || {}
  // A formal construction run supplies the complete target set. Without it,
  // an ordinary terrain block cannot be distinguished safely from an orphaned
  // scaffold, so recovery must stay disabled.
  if (!bot?.entity?.position || !options.reservedPositions) {
    return ok('temporary_corner_residue_recovery_not_applicable')
  }
  const nearby = nearbyUnreservedTemporaryBodyBlocks(bot, options.reservedPositions)
  if (!nearby.length) return ok('temporary_corner_residue_not_found')
  if (typeof bot?.pathfinder?.getPathTo !== 'function') {
    return ok('temporary_corner_residue_preview_unavailable')
  }

  const movements = configureMovements(bot, {
    ...options,
    canDig: false,
    allowScaffolding: options.allowScaffolding === true,
    ...movementScaffoldExclusions(options, params.target)
  }, context)
  if (!movements) return ok('temporary_corner_residue_movements_unavailable')

  let preview
  try {
    const range = safeMoveRangeForStand(stand, params.target, options)
    preview = await previewControlledVerticalAccessPath(
      bot,
      movements,
      new goals.GoalNear(stand.x, stand.y, stand.z, range),
      Math.max(50, Number(options.temporaryCornerPreviewTimeoutMs ?? 1000)),
      { ...options, verticalAccessPreviewSlices: options.temporaryCornerPreviewSlices ?? 6 }
    )
  } catch (err) {
    context.logger?.log?.(
      `[BUILD_TEMP_REFERENCE_CORNER_PREVIEW_SKIPPED] stand=${formatPos(stand)} ` +
      `reason=${err?.message || 'preview_error'}`
    )
    return ok('temporary_corner_residue_preview_error')
  }

  const cornerObstruction = temporaryCornerObstructionFromPath(
    bot,
    preview?.path,
    options.reservedPositions
  )
  const stepSupport = temporaryStepSupportResidueFromPath(
    bot,
    preview?.path,
    options.reservedPositions,
    options.reservedBounds
  )
  if (!cornerObstruction && isPlannedTerminalStepSupport(stepSupport, stand)) {
    context.logger?.log?.(
      `[BUILD_TEMP_REFERENCE_STEP_SUPPORT_PRESERVED] stand=${formatPos(stand)} ` +
      `position=${formatPos(stepSupport.position)} block=${stepSupport.blockName} ` +
      `firstStep=${formatPos(stepSupport.firstStep)} action=preserve_and_track`
    )
    // This support already exists, so the pathfinder preview has no toPlace
    // entry for it. Track it explicitly: the move may use it now, and the
    // ordinary vertical-access finally block will remove it after placement.
    options.onScaffoldPlaced?.(stepSupport.position, stepSupport.blockName)
    return ok('temporary_step_support_preserved', stepSupport)
  }
  const obstruction = cornerObstruction || stepSupport
  if (!obstruction) return ok('temporary_corner_residue_not_on_route')

  const residueKind = obstruction.kind || 'corner'
  context.logger?.log?.(
    `[BUILD_TEMP_REFERENCE_${residueKind === 'step_support' ? 'STEP_SUPPORT' : 'CORNER'}_RESIDUE] ` +
    `stand=${formatPos(stand)} ` +
    `position=${formatPos(obstruction.position)} block=${obstruction.blockName} ` +
    `firstStep=${formatPos(obstruction.firstStep)} action=stable_clear`
  )
  stopMovement(bot, 'temporary_route_residue_cleanup', params.lockOwner || null)
  const requestedQuiesceMs = Number(options.temporaryRouteResidueQuiesceMs ?? 100)
  const quiesceMs = Number.isFinite(requestedQuiesceMs)
    ? Math.max(0, requestedQuiesceMs)
    : 100
  if (quiesceMs > 0) await sleep(quiesceMs)
  const cleared = await clearTemporaryReferenceBlock(context, obstruction.position, {
    lockOwner: params.lockOwner,
    options
  })
  if (!cleared.ok) {
    return fail(`temporary_corner_residue_cleanup_failed:${cleared.error || 'unknown'}`, {
      position: obstruction.position,
      blockName: obstruction.blockName
    })
  }
  return ok(`temporary_${residueKind}_residue_cleared`, obstruction)
}

function temporaryCornerObstructionFromPath(bot, path = [], reservedPositions = null) {
  const current = bot?.entity?.position
  const first = Array.isArray(path) ? path[0] : null
  if (!current || !first || !reservedPositions) return null
  if ((first.toBreak || []).length > 0 || (first.toPlace || []).length > 0) return null

  const start = {
    x: Math.floor(current.x),
    y: Math.floor(current.y),
    z: Math.floor(current.z)
  }
  const firstStep = {
    x: Math.floor(first.x),
    y: Math.floor(first.y),
    z: Math.floor(first.z)
  }
  const dx = firstStep.x - start.x
  const dz = firstStep.z - start.z
  if (firstStep.y !== start.y || Math.abs(dx) !== 1 || Math.abs(dz) !== 1) return null

  const channels = [
    { x: start.x + dx, y: start.y, z: start.z },
    { x: start.x, y: start.y, z: start.z + dz }
  ].map(feet => ({
    feet,
    blocks: [feet, { x: feet.x, y: feet.y + 1, z: feet.z }]
      .map(position => ({ position, block: bot.blockAt?.(toBlockVec3(position)) }))
      .filter(entry => isBodyBlockingBlock(entry.block))
  }))

  for (let index = 0; index < channels.length; index++) {
    const blocked = channels[index]
    const other = channels[1 - index]
    if (other.blocks.length > 0 || blocked.blocks.length !== 1) continue
    const candidate = blocked.blocks[0]
    if (!isTemporaryReferenceName(candidate.block?.name)) continue
    if (isReservedPosition(candidate.position, reservedPositions)) continue
    return {
      position: candidate.position,
      blockName: candidate.block.name,
      firstStep,
      start,
      kind: 'corner'
    }
  }
  return null
}

function temporaryStepSupportResidueFromPath(
  bot,
  path = [],
  reservedPositions = null,
  reservedBounds = null
) {
  const current = bot?.entity?.position
  const first = Array.isArray(path) ? path[0] : null
  if (!current || !first || !reservedPositions || !reservedBounds) return null
  if ((first.toBreak || []).length > 0 || (first.toPlace || []).length > 0) return null

  const start = {
    x: Math.floor(current.x),
    y: Math.floor(current.y),
    z: Math.floor(current.z)
  }
  const firstStep = {
    x: Math.floor(first.x),
    y: Math.floor(first.y),
    z: Math.floor(first.z)
  }
  const dx = firstStep.x - start.x
  const dz = firstStep.z - start.z
  if (firstStep.y !== start.y + 1) return null
  if (Math.max(Math.abs(dx), Math.abs(dz)) !== 1) return null

  const support = {
    x: firstStep.x,
    y: firstStep.y - 1,
    z: firstStep.z
  }
  // This recovery is intentionally narrower than ordinary terrain repair:
  // the support must be inside the active Blueprint IR footprint and absent
  // from the complete formal target set. A formal dirt/stone block is never
  // removed, nor is a natural step outside the construction volume.
  if (!isInsideReservedBounds(support, reservedBounds)) return null
  if (isReservedPosition(support, reservedPositions)) return null
  const block = bot.blockAt?.(toBlockVec3(support))
  if (!isBodyBlockingBlock(block) || !isTemporaryReferenceName(block.name)) return null
  return {
    position: support,
    blockName: block.name,
    firstStep,
    start,
    kind: 'step_support'
  }
}

function isPlannedTerminalStepSupport(obstruction, stand) {
  return obstruction?.kind === 'step_support' && sameBlockPos(obstruction.firstStep, stand)
}

function nearbyUnreservedTemporaryBodyBlocks(bot, reservedPositions) {
  const current = bot?.entity?.position
  if (!current || !reservedPositions) return []
  const start = {
    x: Math.floor(current.x),
    y: Math.floor(current.y),
    z: Math.floor(current.z)
  }
  const found = []
  for (const offset of [
    { x: -1, z: 0 },
    { x: 1, z: 0 },
    { x: 0, z: -1 },
    { x: 0, z: 1 }
  ]) {
    for (const y of [start.y, start.y + 1]) {
      const position = { x: start.x + offset.x, y, z: start.z + offset.z }
      if (isReservedPosition(position, reservedPositions)) continue
      const block = bot.blockAt?.(toBlockVec3(position))
      if (isBodyBlockingBlock(block) && isTemporaryReferenceName(block.name)) {
        found.push({ position, blockName: block.name })
      }
    }
  }
  return found
}

function isBodyBlockingBlock(block) {
  if (!block || AIR_BLOCKS.has(block.name)) return false
  if (!Array.isArray(block.shapes)) return true
  return block.shapes.length > 0
}

async function planFreshControlledVerticalAccess(context, target, placeDistance, options = {}) {
  const requestedAlternatives = Number(
    options.verticalAccessPlanAlternatives ?? options.standMoveAttempts ?? 4
  )
  const boundedAlternatives = Number.isFinite(requestedAlternatives)
    ? Math.max(1, Math.min(4, Math.floor(requestedAlternatives)))
    : 4
  const planned = await planControlledVerticalAccess(context, target, placeDistance, {
    ...options,
    verticalAccessPlanAlternatives: boundedAlternatives
  })
  if (!planned.ok) return planned
  const plans = planned.data.plans || []
  return ok('controlled_vertical_access_fresh_replan_planned', {
    stands: planned.data.stands,
    plans,
    options: {
      ...options,
      controlledVerticalAccessFreshReplan: false,
      controlledVerticalAccessPlans: new Map(plans.map(plan => [
        formatPos(plan.stand),
        plan.scaffoldPositions
      ])),
      standTimeoutMemo: new Set(),
      verticalAccessPlanAlternatives: boundedAlternatives
    }
  })
}

async function cleanupRejectedVerticalAccessCandidate(context, target, stand, positions = [], params = {}) {
  if (!positions.length) return ok('vertical_access_candidate_cleanup_not_required')
  const support = currentBotTemporarySupportPosition(context?.bot, positions)
  if (support) {
    context.logger?.log?.(
      `[BUILD_VERTICAL_ACCESS_CANDIDATE_SUPPORT_DESCENT] target=${formatPos(target)} ` +
      `stand=${formatPos(stand)} support=${formatPos(support)} ` +
      `reason=${params.reason || 'candidate_rejected'}`
    )
  }
  const cleanup = await clearTemporaryPlacementReference(context, {
    positions
  }, {
    lockOwner: params.owner,
    options: params.options || {},
    settleAfterSupportClear: true,
    stopMovementBeforeClear: true,
    movementStopReason: 'vertical_access_candidate_cleanup'
  })
  if (!cleanup.ok) {
    return fail(`vertical_access_candidate_cleanup_failed:${cleanup.error || 'unknown'}`, {
      target,
      stand,
      positions,
      reason: params.reason || null
    })
  }
  params.options?.onControlledVerticalAccessScaffoldsCleaned?.(positions)
  context.logger?.log?.(
    `[BUILD_VERTICAL_ACCESS_CANDIDATE_CLEANUP] target=${formatPos(target)} ` +
    `stand=${formatPos(stand)} reason=${params.reason || 'candidate_rejected'} ` +
    `positions=${positions.map(formatPos).join('|')}`
  )
  return ok('vertical_access_candidate_cleanup_done', { positions })
}

function currentBotTemporarySupportPosition(bot, positions = []) {
  const pos = bot?.entity?.position
  if (!pos) return null
  const support = {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y) - 1,
    z: Math.floor(pos.z)
  }
  const tracked = positions.find(position => sameBlockPos(position, support))
  if (!tracked) return null
  const current = bot.blockAt?.(toBlockVec3(support))
  if (!current || !isTemporaryReferenceName(current.name)) return null
  return support
}

function isBotSupportedByTemporaryPosition(bot, position) {
  return Boolean(currentBotTemporarySupportPosition(bot, [position]))
}

async function waitForBotAfterTemporarySupportClear(bot, clearedPosition, options = {}) {
  if (!bot?.entity?.position) return ok('temporary_reference_support_descent_not_observable')
  const requestedTimeoutMs = Number(options.verticalAccessCleanupSettleTimeoutMs ?? 2500)
  const requestedPollMs = Number(options.verticalAccessCleanupSettlePollMs ?? 50)
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(100, requestedTimeoutMs)
    : 2500
  const pollMs = Number.isFinite(requestedPollMs)
    ? Math.max(10, requestedPollMs)
    : 50
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const pos = bot.entity.position
    const support = {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y) - 1,
      z: Math.floor(pos.z)
    }
    if (!sameBlockPos(support, clearedPosition) && bot.entity.onGround !== false) {
      return ok('temporary_reference_support_descent_settled', {
        clearedPosition,
        support
      })
    }
    await sleep(pollMs)
  }
  return fail('temporary_reference_support_descent_timeout', {
    clearedPosition,
    botPosition: {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z
    }
  })
}

function controlledVerticalAccessScaffoldPositions(options = {}, stand = null) {
  if (!stand || !(options.controlledVerticalAccessPlans instanceof Map)) return undefined
  return options.controlledVerticalAccessPlans.get(formatPos(stand)) || []
}

function snapshotControlledVerticalAccessScaffolds(context, positions) {
  if (!Array.isArray(positions)) return null
  return new Map(positions.map(position => {
    const current = context?.bot?.blockAt?.(toBlockVec3(position))
    return [formatPos(position), current?.name || 'air']
  }))
}

function reconcileControlledVerticalAccessScaffolds(
  context,
  target,
  stand,
  positions,
  baseline,
  candidateKeys,
  onScaffoldPlaced
) {
  if (!Array.isArray(positions) || !(baseline instanceof Map)) return
  for (const position of positions) {
    const positionKey = formatPos(position)
    if (!AIR_BLOCKS.has(baseline.get(positionKey) || 'air')) continue
    const current = context?.bot?.blockAt?.(toBlockVec3(position))
    if (!current || !isTemporaryReferenceName(current.name)) continue
    const wasTracked = candidateKeys.has(positionKey)
    onScaffoldPlaced(position, current.name)
    if (!wasTracked) {
      context.logger?.log?.(
        `[BUILD_VERTICAL_ACCESS_SCAFFOLD_RECONCILED] target=${formatPos(target)} ` +
        `stand=${formatPos(stand)} position=${positionKey} block=${current.name}`
      )
    }
  }
}

function controlledVerticalAccessReachedWhen(context, target, params, placeDistance, options = {}) {
  if (options.requireReachablePlacementAfterStandMove !== true) return undefined
  return () => {
    if (botIntersectsBlock(context?.bot, target)) return false
    if (options.requireStrictPlacementReferenceReachAfterStandMove === true) {
      const settledReachDistance = controlledPlacementSettledReachDistance(placeDistance, options)
      return strictCurrentPlacementReferenceReachability(
        context,
        target,
        params.blockName,
        settledReachDistance,
        options,
        params.referencePosition
      ).ok
    }
    return currentPlacementReachability(
      context,
      target,
      params.blockName,
      placeDistance,
      options,
      params.referencePosition
    ).ok
  }
}

function controlledPlacementSettledReachDistance(placeDistance, options = {}) {
  const distanceLimit = Number(placeDistance)
  if (!Number.isFinite(distanceLimit) || distanceLimit <= 0) return distanceLimit
  const requestedMargin = Number(options.strictPlacementReachSafetyMargin ?? 0.35)
  const margin = Number.isFinite(requestedMargin)
    ? Math.max(0, Math.min(requestedMargin, Math.max(0, distanceLimit - 0.1)))
    : 0.35
  return Math.max(0.1, distanceLimit - margin)
}

function strictCurrentPlacementReferenceReachability(context, target, blockName, placeDistance, options = {}, referencePosition = null) {
  const bot = context?.bot
  if (referencePosition && isStrictReferenceReachableFromCurrentPosition(bot, referencePosition, placeDistance)) {
    return { ok: true, reason: 'strict_explicit_reference_reach' }
  }
  const belowPosition = { x: target.x, y: target.y - 1, z: target.z }
  const below = bot?.blockAt?.(toBlockVec3(belowPosition))
  if (
    isPlacementReferenceBlock(below) &&
    isStrictReferenceReachableFromCurrentPosition(bot, below.position || belowPosition, placeDistance)
  ) {
    return { ok: true, reason: 'strict_below_reference_reach' }
  }
  const states = options.blockStates || options.states || options.orientation
  const reference = findReferenceBlocksForPlacement(context, target, blockName, states)
    .find(candidate => isStrictReferenceReachableFromCurrentPosition(bot, candidate.position, placeDistance))
  return reference
    ? { ok: true, reason: 'strict_placement_reference_reach', referencePosition: reference.position }
    : { ok: false, reason: 'strict_placement_reference_unreachable' }
}

function isStrictReferenceReachableFromCurrentPosition(bot, referencePosition, placeDistance) {
  const pos = bot?.entity?.position
  if (!pos || !referencePosition) return false
  const eye = { x: pos.x, y: pos.y + 1.62, z: pos.z }
  const blockCenter = {
    x: referencePosition.x + 0.5,
    y: referencePosition.y + 0.5,
    z: referencePosition.z + 0.5
  }
  return distance(eye, blockCenter) <= placeDistance
}

function isStrictReferenceReachableFromStand(stand, referencePosition, placeDistance) {
  return placementReferenceReachDistance(stand, referencePosition) <= placeDistance
}

function placementReferenceReachDistance(stand, referencePosition) {
  if (!stand || !referencePosition) return Number.POSITIVE_INFINITY
  const eye = { x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }
  const blockCenter = {
    x: referencePosition.x + 0.5,
    y: referencePosition.y + 0.5,
    z: referencePosition.z + 0.5
  }
  return distance(eye, blockCenter)
}

function placementStandAttempts(stands, target, maxAttempts, options = {}) {
  const eligible = stands.filter(stand => !isStandMoveBlacklisted(options, stand))
  const attempts = eligible.slice(0, maxAttempts)
  if (options.preferHighStand !== true || !target || maxAttempts <= 1) return attempts

  const sameLevelFallback = eligible.find(stand =>
    stand.y === target.y &&
    horizontalDistance(stand, target) <= 2.25 &&
    !attempts.some(candidate => sameBlockPos(candidate, stand))
  )
  if (sameLevelFallback) insertPlacementStandAttempt(attempts, sameLevelFallback, 1, maxAttempts)

  const lowFallback = eligible.find(stand =>
    stand.y < target.y &&
    !attempts.some(candidate => sameBlockPos(candidate, stand))
  )
  if (lowFallback) insertPlacementStandAttempt(attempts, lowFallback, attempts.length, maxAttempts)
  return attempts
}

function insertPlacementStandAttempt(attempts, stand, index, maxAttempts) {
  if (!stand || attempts.some(candidate => sameBlockPos(candidate, stand))) return
  const boundedIndex = Math.max(0, Math.min(index, attempts.length))
  if (attempts.length < maxAttempts) {
    attempts.splice(boundedIndex, 0, stand)
    return
  }
  if (boundedIndex >= maxAttempts) {
    attempts[maxAttempts - 1] = stand
    return
  }
  attempts.splice(boundedIndex, 0, stand)
  attempts.length = maxAttempts
}

function promoteLowStandFallback(attempts, target, currentIndex) {
  const lowIndex = attempts.findIndex((stand, index) => index > currentIndex && stand.y < target.y)
  if (lowIndex <= currentIndex + 1) return
  const [fallback] = attempts.splice(lowIndex, 1)
  attempts.splice(currentIndex + 1, 0, fallback)
}

function sameBlockPos(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z
}

function cursorPositionForFace(faceVector) {
  return new Vec3(
    0.5 + Math.sign(faceVector.x || 0) * 0.5,
    0.5 + Math.sign(faceVector.y || 0) * 0.5,
    0.5 + Math.sign(faceVector.z || 0) * 0.5
  )
}

function shouldPreferSideReference(context, target) {
  const footY = Math.floor(context?.bot?.entity?.position?.y ?? Number.POSITIVE_INFINITY)
  return Number.isFinite(footY) && target.y <= footY + 1
}

function standIntersectsBlock(stand, target) {
  if (!stand || !target) return false
  const minX = Math.floor(stand.x - BOT_HALF_WIDTH)
  const maxX = Math.floor(stand.x + BOT_HALF_WIDTH)
  const minY = Math.floor(stand.y)
  const maxY = Math.floor(stand.y + BOT_HEIGHT)
  const minZ = Math.floor(stand.z - BOT_HALF_WIDTH)
  const maxZ = Math.floor(stand.z + BOT_HALF_WIDTH)
  return target.x >= minX && target.x <= maxX &&
    target.y >= minY && target.y <= maxY &&
    target.z >= minZ && target.z <= maxZ
}

function isSafeStandPosition(context, stand, options = {}) {
  const bot = context?.bot
  if (options.ignoreReservedPositions !== true && options.allowReservedAirStand !== true) {
    if (isReservedPosition(stand, options.reservedPositions)) return false
    if (isReservedPosition({ x: stand.x, y: stand.y + 1, z: stand.z }, options.reservedPositions)) return false
  }

  const below = bot.blockAt(toBlockVec3({ x: stand.x, y: stand.y - 1, z: stand.z }))
  const feet = bot.blockAt(toBlockVec3(stand))
  const head = bot.blockAt(toBlockVec3({ x: stand.x, y: stand.y + 1, z: stand.z }))
  return hasIntegerStandSurface(below) &&
    (!feet || AIR_BLOCKS.has(feet.name)) &&
    (!head || AIR_BLOCKS.has(head.name))
}

// How far below a stand the first surface it could ever rest on sits, and
// whether the cells in between are clear. A stand hanging in the air is only
// ever reached by pillaring straight up to it, and the pathfinder can only
// pillar up an UNOBSTRUCTED column: depth 0 is the classic solid floor, a
// clear column of depth N is a stand an N-block scaffold pillar reaches, and
// a blocked column means the route has to come at the stand sideways around
// the obstruction - which is the search that keeps running out of slices.
function verticalAccessStandColumnSupport(context, stand, maxDepth = VERTICAL_ACCESS_STAND_COLUMN_MAX_DEPTH) {
  const bot = context?.bot
  if (typeof bot?.blockAt !== 'function' || !stand) return { depth: Infinity, clear: false }
  const limit = Number.isFinite(maxDepth) ? Math.max(1, Math.floor(maxDepth)) : VERTICAL_ACCESS_STAND_COLUMN_MAX_DEPTH
  for (let depth = 1; depth <= limit; depth++) {
    const below = bot.blockAt(toBlockVec3({ x: stand.x, y: stand.y - depth, z: stand.z }))
    if (hasIntegerStandSurface(below)) return { depth: depth - 1, clear: true }
    if (below && !AIR_BLOCKS.has(below.name)) return { depth: depth - 1, clear: false }
  }
  return { depth: Infinity, clear: false }
}

function hasClearScaffoldColumnBelow(context, stand, maxDepth) {
  return verticalAccessStandColumnSupport(context, stand, maxDepth).clear === true
}

function hasIntegerStandSurface(block) {
  if (!block || AIR_BLOCKS.has(block.name)) return false
  // Test doubles and older protocol adapters may not expose collision shapes;
  // preserve the previous solid-block behavior for those callers.
  if (!Array.isArray(block.shapes)) return true
  if (!block.shapes.length) return false
  const top = Math.max(...block.shapes
    .filter(shape => Array.isArray(shape) && shape.length >= 6)
    .map(shape => Number(shape[4]))
    .filter(Number.isFinite))
  // Integer-Y placement goals assume the support surface is exactly one
  // block high. Fences/walls peak at 1.5 and bottom slabs at 0.5, so treating
  // either as y+1 makes GoalNear permanently unreachable.
  return Number.isFinite(top) && Math.abs(top - 1) <= 0.001
}

function placementReachDistance(stand, target) {
  const eye = { x: stand.x + 0.5, y: stand.y + 1.6, z: stand.z + 0.5 }
  const blockCenter = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
  return distance(eye, blockCenter)
}

function isDigReachable(bot, target, digDistance = 4.5) {
  const pos = bot?.entity?.position
  if (!pos || !target) return false
  const eye = { x: pos.x, y: pos.y + 1.62, z: pos.z }
  const blockCenter = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
  return distance(eye, blockCenter) <= digDistance
}

function canRecoverClearAfterPartialMove(bot, target, block, digDistance = 4.5) {
  const blockName = block?.name || block
  const thinInteractiveBlock = isThinInteractiveClearBlockName(blockName)
  const thinDigDistance = Math.max(digDistance, 5)
  const digReachable = isDigReachable(bot, target, digDistance) ||
    (thinInteractiveBlock && isDigReachable(bot, target, thinDigDistance)) ||
    (thinInteractiveBlock && canDigCurrentBlock(bot, block))
  if (!digReachable) return false
  if (!botIntersectsBlock(bot, target)) return true
  return isThinInteractiveClearBlockName(blockName)
}

function canDigCurrentBlock(bot, block) {
  if (typeof bot?.canDigBlock !== 'function' || !block) return false
  try {
    return bot.canDigBlock(block) === true
  } catch {
    return false
  }
}

function isThinInteractiveClearBlockName(blockName) {
  const name = String(blockName || '')
  return isTrapdoorBlockName(name) ||
    /_door$/.test(name) ||
    isFenceGateBlockName(name) ||
    isButtonBlockName(name) ||
    /(?:^|_)wall_sign$/.test(name) ||
    /(?:^|_)sign$/.test(name) ||
    /(?:^|_)wall_banner$/.test(name) ||
    /(?:^|_)banner$/.test(name)
}

function safeMoveRangeForStand(stand, target, options = {}) {
  if (Number.isFinite(options.safeMoveRange)) return options.safeMoveRange
  const horizontal = Math.sqrt((stand.x - target.x) ** 2 + (stand.z - target.z) ** 2)
  if (options.preferCloseStand === true && stand.y > target.y && horizontal <= 1.5) {
    const requested = Number(options.closeStandMoveRange ?? 0.2)
    return Number.isFinite(requested) ? Math.max(0.1, requested) : 0.2
  }
  if (stand.y >= target.y - 1 && stand.y <= target.y && horizontal >= 2) return 1.4
  if (stand.y > target.y) return 0.8
  if (horizontal <= 1.5) return 0.15
  return horizontal >= 2 ? 0.75 : DEFAULT_SAFE_MOVE_RANGE
}

function requiredPlacementStandHeightReached(context, options = {}) {
  if (!Number.isFinite(options.minimumPlacementStandY)) return true
  const currentY = Math.floor(Number(context?.bot?.entity?.position?.y))
  return Number.isFinite(currentY) && currentY >= options.minimumPlacementStandY
}

function placementRecoveryStandHeightReached(
  context,
  target,
  blockName,
  placeDistance,
  options = {},
  referencePosition = null
) {
  if (requiredPlacementStandHeightReached(context, options)) return true
  if (options.requireStrictPlacementReferenceReachAfterStandMove !== true) return false
  const minimumY = Number(options.minimumPlacementStandY)
  const currentY = Math.floor(Number(context?.bot?.entity?.position?.y))
  // The generated minimum is a corridor guard, not a placement rule. Permit
  // landing exactly one level below it only when the real placement reference
  // is within strict interaction range. This preserves the guard against
  // distant ground-floor false positives while accepting a productive partial
  // move such as placing a standing lantern onto the chest one level above.
  if (!Number.isFinite(minimumY) || !Number.isFinite(currentY) || currentY !== minimumY - 1) return false
  const strict = strictCurrentPlacementReferenceReachability(
    context,
    target,
    blockName,
    placeDistance,
    options,
    referencePosition
  )
  if (!strict.ok) return false
  context.logger?.log?.(
    `[BUILD_MINIMUM_STAND_HEIGHT_STRICT_REFERENCE_RECOVERED] target=${formatPos(target)} ` +
    `currentY=${currentY} minimumY=${minimumY} reason=${strict.reason}`
  )
  return true
}

// Retry moves toward a stand that already move_timed-out in this action call
// get a capped timeout (the XZ-fallback cap) instead of re-burning the full
// adaptive timeout every outer placement retry.
function standMoveTimeoutWithMemo(context, stand, options = {}) {
  const full = placementMoveTimeoutMs(context?.bot, stand, options)
  const memo = options.standTimeoutMemo
  if (!memo || !stand || !memo.has(formatPos(stand))) return full
  const capped = Math.min(full, Number(options.nearXZMoveTimeoutMs ?? 12000))
  if (capped < full) {
    context?.logger?.log?.(`[BUILD_PLACE_STAND_TIMEOUT_MEMO] stand=${formatPos(stand)} cappedTimeoutMs=${capped} fullTimeoutMs=${full}`)
  }
  return capped
}

function rememberStandTimeout(options = {}, stand) {
  if (options.standTimeoutMemo && stand) options.standTimeoutMemo.add(formatPos(stand))
}

function isStandMoveBlacklisted(options = {}, stand) {
  return Boolean(options.standTimeoutMemo && stand && options.standTimeoutMemo.has(formatPos(stand)))
}

function movementScaffoldExclusions(options = {}, currentTarget = null) {
  return {
    reservedPositions: options.reservedPositions,
    scaffoldExclusionPositions: [
      options.scaffoldExclusionPositions,
      currentTarget
    ]
  }
}

function placementMoveTimeoutMs(bot, destination, options = {}) {
  const base = options.timeoutMs ?? 15000
  if (options.adaptiveMoveTimeout !== true || !destination) return base
  const currentY = Number(bot?.entity?.position?.y)
  if (!Number.isFinite(currentY) || !Number.isFinite(destination.y)) return base
  const verticalBlocks = Math.abs(destination.y - currentY)
  const perBlockMs = Number(options.verticalMoveTimeoutPerBlockMs ?? 2500)
  const maxMs = Number(options.maxAdaptiveMoveTimeoutMs ?? 60000)
  const extraMs = Number.isFinite(perBlockMs) && perBlockMs > 0
    ? Math.ceil(verticalBlocks * perBlockMs)
    : 0
  return Math.min(
    Number.isFinite(maxMs) && maxMs > base ? maxMs : base,
    Math.max(base, base + extraMs)
  )
}

function horizontalDistance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)
}

function uniqueNumbers(values) {
  return [...new Set(values.filter(value => Number.isFinite(value)))]
}

function isReservedPosition(position, reservedPositions) {
  if (!position || !reservedPositions) return false
  const key = formatPos(position)
  if (typeof reservedPositions.has === 'function') return reservedPositions.has(key)
  if (Array.isArray(reservedPositions)) {
    return reservedPositions.some(entry => {
      if (typeof entry === 'string') return entry === key
      return entry && entry.x === position.x && entry.y === position.y && entry.z === position.z
    })
  }
  return false
}

function isInsideReservedBounds(position, bounds) {
  if (!position || !bounds) return false
  return position.x >= bounds.minX && position.x <= bounds.maxX &&
    position.z >= bounds.minZ && position.z <= bounds.maxZ
}

function formatPos(position) {
  return `${position.x},${position.y},${position.z}`
}

function buildActionShouldContinue(options = {}) {
  if (typeof options.shouldContinue !== 'function') return true
  try {
    return options.shouldContinue() !== false
  } catch {
    return false
  }
}

async function moveNearBuildPosition(context, position, options = {}) {
  const target = normalizePosition(position)
  if (!target) return fail('missing_position')
  return moveTo(context, target, {
    range: options.range ?? 2,
    timeoutMs: options.timeoutMs ?? 15000,
    owner: options.owner,
    shouldContinue: options.shouldContinue,
    holdLock: options.holdLock
  })
}

function getFaceVector(reference, target) {
  return new Vec3(target.x - reference.x, target.y - reference.y, target.z - reference.z)
}

module.exports = {
  canPlaceBlock,
  clearBlockForBuilding,
  findReferenceBlockForPlacement,
  isReplaceablePlacementTarget,
  isTemporaryReferenceName,
  placementBlockNameMatches,
  moveNearBuildPosition,
  placeBlock,
  selectTemporaryReferenceMaterial,
  // exported for unit tests
  shouldSneakForPlacementReference,
  isRotationPlacedBlockName,
  placementLookDirection,
  lookTowardDirection,
  expectedPlacementStateKeys,
  expectedPlacementStateMismatch,
  postPlaceTunedStateKeys,
  alignPostPlaceTunedStates,
  statefulPlacementProfile,
  ORIENTED_PLACEMENT_FACING_RULES,
  orientedPlacementLookDirection,
  placementLookAngles,
  sendPlacementLookPacket,
  clickedFacePlacementRequest,
  clickedFaceReferenceStanding,
  faceNameForVector,
  orderReferencesForClickedFace,
  placeBlockAgainstReference,
  controlledVerticalAccessStandCandidates,
  controlledVerticalAccessReachedWhen,
  controlledPlacementSettledReachDistance,
  cleanupRejectedVerticalAccessCandidate,
  findSafePlacementStandPositions,
  hasIntegerStandSurface,
  verticalAccessStandColumnSupport,
  hasClearScaffoldColumnBelow,
  placeFluidFromTargetCell,
  moveToFirstReachablePlacementStand,
  planControlledVerticalAccess,
  planFreshControlledVerticalAccess,
  previewControlledVerticalAccessPath,
  controlledVerticalAccessPreviewSliceBudget,
  selectTruncatedVerticalAccessPreviews,
  disableControlledPathfinderPlacementReturn,
  shouldFreshReplanControlledVerticalAccess,
  temporaryCornerObstructionFromPath,
  temporaryStepSupportResidueFromPath,
  isPlannedTerminalStepSupport,
  confirmTemporaryReferenceClear,
  temporaryReferenceClearReach,
  temporaryReferenceResidueLedger,
  clearTemporaryReferenceBlock,
  clearTemporaryPlacementReference,
  placementStandAttempts,
  prescreenPlacementStandsByPathCost,
  isTriviallyReachableStand,
  relaxedFluidStanceCandidates,
  fluidRimPartialStands,
  walkablePartialSupportTop,
  rememberStandTimeout,
  standMoveTimeoutWithMemo
}
