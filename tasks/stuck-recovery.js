const { distance, normalizePosition, sleep } = require('../actions/action-utils')
const { moveTo, stopMovement } = require('../actions/move')
const { checkProtectedBuildingDig, findProtectedRegionAt } = require('../systems/protected-buildings')
const { rememberTerrainHazard } = require('../systems/terrain-hazards')
const { toBlockVec3 } = require('../utils/position')
const {
  DEFAULT_RUNGS,
  getEscapeLedgerSnapshot,
  hasEscapedAnchor,
  loadLedger,
  markGaveUp,
  measureEscapeProgress,
  noteEscapeSuccess,
  noteRungFailure,
  planEscapeAttempt
} = require('./escape-ladder')

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'grass', 'short_grass', 'tall_grass'])
const DANGER_BLOCKS = new Set(['lava', 'fire', 'magma_block', 'cactus'])
const WATER_BLOCKS = new Set(['water'])
const PROTECTED_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'hay_block', 'bell',
  'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
  'mangrove_door', 'cherry_door'
])

function createRecoveryState(options = {}) {
  return {
    stuckTicks: 0,
    lastPosition: null,
    lastDistanceToTarget: null,
    pathFailureCount: 0,
    stuckReason: null,
    recoveryAttempts: 0,
    isInHole: false,
    isStuck: false,
    lastRecoveryAction: null,
    lastFailureReason: null,
    pathStatus: 'idle',
    targetPlayer: options.targetPlayer || null,
    distanceToPlayer: null,
    recovering: false,
    escapeRung: null,
    escapeLedger: null
  }
}

function updateStuckTracking(ctx, state, targetPosition, options = {}) {
  const position = currentPosition(ctx)
  const target = normalizePosition(targetPosition)
  if (!position || !target) {
    state.pathStatus = 'missing_target'
    return state
  }

  const targetRange = Number(options.targetRange ?? 2)
  const currentDistance = distance(position, target)
  state.distanceToPlayer = Math.round(currentDistance * 100) / 100
  if (currentDistance <= targetRange + 0.75) {
    resetProgressState(state)
    state.pathStatus = 'arrived'
    return state
  }

  const movementDelta = state.lastPosition ? distance(position, state.lastPosition) : Infinity
  const distanceDelta = state.lastDistanceToTarget == null
    ? Infinity
    : state.lastDistanceToTarget - currentDistance
  const hasGoal = Boolean(ctx.bot?.pathfinder?.goal || ctx.bot?.pathfinder?._goal)
  const isInHole = detectInHole(ctx, target, options)
  const noMovement = movementDelta < Number(options.minMovementDelta ?? 0.35)
  const noProgress = distanceDelta < Number(options.minDistanceProgress ?? 0.15)

  if (isInHole || (hasGoal && noMovement && noProgress)) {
    state.stuckTicks += 1
  } else {
    state.stuckTicks = Math.max(0, state.stuckTicks - 1)
  }

  state.lastPosition = clonePos(position)
  state.lastDistanceToTarget = currentDistance
  state.isInHole = isInHole
  state.isStuck = state.stuckTicks >= Number(options.stuckTickThreshold ?? 4) || isInHole
  state.stuckReason = state.isInHole
    ? 'in_hole_or_low_ground'
    : state.isStuck
      ? 'no_movement_or_no_distance_progress'
      : null
  state.pathStatus = state.isStuck ? 'stuck' : hasGoal ? 'moving' : 'idle'
  logEvent(ctx, `[stuck] isStuck=${state.isStuck ? 'true' : 'false'} reason=${state.stuckReason || 'none'} positionDelta=${Number.isFinite(movementDelta) ? movementDelta.toFixed(2) : 'new'} distanceDelta=${Number.isFinite(distanceDelta) ? distanceDelta.toFixed(2) : 'new'} attempts=${state.recoveryAttempts}`)
  return state
}

function notePathFailure(ctx, state, reason = 'pathfinder_failed', options = {}) {
  state.stuckTicks += 1
  state.pathFailureCount = (state.pathFailureCount || 0) + 1
  state.isInHole = detectInHole(ctx, null, options)
  const threshold = Number(options.pathFailureThreshold ?? 2)
  state.isStuck = state.isInHole || state.pathFailureCount >= threshold
  state.stuckReason = reason
  state.lastFailureReason = reason
  state.pathStatus = 'path_failed'
  logEvent(ctx, `[stuck] pathFailureCount=${state.pathFailureCount} threshold=${threshold} isStuck=${state.isStuck ? 'true' : 'false'} reason=${reason} inHole=${state.isInHole ? 'true' : 'false'}`)
  return state
}

const RUNG_RUNNERS = {
  repath: attemptRepath,
  jump_and_step: attemptJumpAndStep,
  nearby_exit: attemptNearbyExit,
  safe_dig: attemptSafeDig,
  pillar_up: attemptPillarUp,
  safe_posture: attemptSafePosture
}

// Escalating self-rescue. The ledger (see escape-ladder.js) remembers which
// rungs already proved useless AT THIS SPOT and survives the task being
// re-created, so a re-queued retreat resumes where the last one gave up
// instead of replaying rung 0 forever.
async function runStuckRecovery(ctx, state, targetPosition, owner, options = {}) {
  if (state.recovering) return { ok: false, error: 'recovery_already_running' }
  const target = normalizePosition(targetPosition)
  if (!target) return { ok: false, error: 'missing_recovery_target' }

  const key = options.escapeKey || 'stuck_recovery'
  const rungs = options.rungs || DEFAULT_RUNGS
  // Is the task that asked for this still alive?
  //
  // Round 10's gate lives between two awaits in the return tasks, so an
  // interrupt that lands INSIDE the ladder is not seen until the whole ladder
  // has finished. Building round 22: a retreat home was interrupted while
  // nearby_exit was still walking; the ladder went on through safe_dig and
  // pillar_up, and each rung took the movement lock again for a task nobody
  // would ever release it for. Same predicate, checked every step.
  const stillWanted = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true
  const abandon = rung => {
    state.lastFailureReason = 'escape_abandoned'
    state.pathStatus = 'escape_abandoned'
    logEvent(ctx, `[ESCAPE_ABANDONED] taskId=${owner} key=${key} rung=${rung || 'none'} reason=task_no_longer_running`)
    return { ok: false, error: 'escape_abandoned' }
  }
  state.recovering = true
  state.recoveryAttempts += 1
  state.pathStatus = 'recovering'

  const startPosition = livePosition(ctx)
  const plan = planEscapeAttempt(ctx, key, startPosition, options)
  state.escapeRung = plan.rung
  state.escapeLedger = getEscapeLedgerSnapshot(ctx, key)

  logEvent(ctx, `[STUCK_RECOVERY_START] taskId=${owner} reason=${state.stuckReason || 'unknown'} inHole=${state.isInHole ? 'true' : 'false'} attempts=${state.recoveryAttempts} rung=${plan.rung || 'none'} exhausted=${state.escapeLedger.exhausted.join('|') || 'none'} consecutiveFailures=${state.escapeLedger.consecutiveFailures}${plan.reset ? ' ledgerReset=true' : ''}`)

  try {
    if (!stillWanted()) return abandon(plan.rung)

    // Still inside the backoff window: hold still rather than burn another
    // full ladder pass (and another 30s of mob exposure) on a spot that has
    // already refused every rung we tried.
    if (plan.waitMs > 0) {
      logEvent(ctx, `[ESCAPE_BACKOFF_HOLD] taskId=${owner} key=${key} waitMs=${plan.waitMs} consecutiveFailures=${state.escapeLedger.consecutiveFailures}`)
      await attemptSafePosture(ctx, state, target, owner, { ...options, quiet: true })
      state.lastFailureReason = 'escape_backoff_hold'
      state.pathStatus = 'escape_backoff'
      return { ok: false, error: `escape_backoff_hold:${plan.waitMs}` }
    }

    maybeChat(ctx, options.startMessage || '我好像被困住了，正在尝试脱困。', options)

    if (plan.giveUp) {
      const posture = await attemptSafePosture(ctx, state, target, owner, options)
      state.lastFailureReason = 'escape_exhausted'
      state.pathStatus = 'escape_gave_up'
      logEvent(ctx, `[ESCAPE_GAVE_UP] taskId=${owner} key=${key} rungsTried=${state.escapeLedger.exhausted.join('|') || 'none'} posture=${posture.ok ? 'held' : 'failed'}`)
      return { ok: false, error: 'escape_exhausted' }
    }

    const ledger = loadLedger(ctx, key)
    const anchor = ledger.anchor
    // safe_posture is the terminal rung, never an escape — running it must not
    // be mistaken for success, or it would clear the ledger at the end of every
    // pass and the ladder would restart at rung 0 forever (the original bug).
    const actionRungs = rungs.filter(rung => rung !== 'safe_posture')
    let lastError = null

    for (const rung of actionRungs.slice(actionRungs.indexOf(plan.rung))) {
      if (!stillWanted()) return abandon(rung)
      if (ledger.exhausted.includes(rung)) continue
      const runner = RUNG_RUNNERS[rung]
      if (typeof runner !== 'function') continue

      const before = clonePos(livePosition(ctx))
      const attempt = await runner(ctx, state, target, owner, options)
      // Before the ledger is touched and before any ESCAPE_RUNG_* line: a rung
      // that was cut off mid-flight is not evidence that it is useless here.
      if (!stillWanted()) return abandon(rung)
      if (!attempt.ok) {
        lastError = attempt.error || `${rung}_failed`
        noteRungFailure(ctx, key, rung, lastError, options)
        logEvent(ctx, `[ESCAPE_RUNG_FAILED] taskId=${owner} key=${key} rung=${rung} reason=${lastError}`)
        continue
      }

      // A rung only counts if it actually got the bot out of the spot it
      // jammed in. Judge on the best evidence available: where the bot ended
      // up, and where the rung was aiming. A rung that walks to another cell
      // of the same pit satisfies neither.
      const after = livePosition(ctx)
      const destination = normalizePosition(attempt.data?.position) || null
      const progress = bestProgress(anchor, [after, destination], options)
      if (anchor && !progress.improved) {
        lastError = `no_progress:${rung}`
        noteRungFailure(ctx, key, rung, lastError, options)
        logEvent(ctx, `[ESCAPE_RUNG_NO_PROGRESS] taskId=${owner} key=${key} rung=${rung} yGain=${progress.yGain} flatGain=${progress.flatGain} — 动了但没离开困住的位置，记为失败并升级`)
        continue
      }

      // Getting out is only half of it. Round 2's real machine run climbed out
      // of the pit and then took a route home that jumped straight back across
      // its mouth. Write the spot down BEFORE clearing the ledger, while we
      // still know where she jammed.
      recordTerrainHazard(ctx, key, owner, anchor, ledger, options)
      noteEscapeSuccess(ctx, key, { rung })
      logEvent(ctx, `[ESCAPE_RUNG_SUCCESS] taskId=${owner} key=${key} rung=${rung} yGain=${progress.yGain} flatGain=${progress.flatGain}`)
      return finishRecovery(ctx, state, attempt)
    }

    if (!stillWanted()) return abandon(null)

    // Nothing on the ladder worked this pass. Whether or not we formally give
    // up, stop moving — walking on while stuck is how round 5 ended.
    state.escapeLedger = getEscapeLedgerSnapshot(ctx, key)
    const everythingTried = actionRungs.every(rung => state.escapeLedger.exhausted.includes(rung))
    await attemptSafePosture(ctx, state, target, owner, options)

    if (everythingTried) {
      markGaveUp(ctx, key, options)
      state.escapeLedger = getEscapeLedgerSnapshot(ctx, key)
      recordTerrainHazard(ctx, key, owner, anchor, ledger, options)
      state.lastFailureReason = 'escape_exhausted'
      state.pathStatus = 'escape_gave_up'
      logEvent(ctx, `[ESCAPE_GAVE_UP] taskId=${owner} key=${key} rungsTried=${state.escapeLedger.exhausted.join('|')}`)
      return { ok: false, error: 'escape_exhausted' }
    }

    const reason = lastError || 'recovery_failed'
    state.lastFailureReason = reason
    state.pathStatus = 'recovery_failed'
    logEvent(ctx, `[STUCK_RECOVERY_FAILED] taskId=${owner} reason=${reason} exhausted=${state.escapeLedger.exhausted.join('|') || 'none'} retryable=${actionRungs.filter(r => !state.escapeLedger.exhausted.includes(r)).join('|') || 'none'}`)
    return { ok: false, error: reason }
  } finally {
    state.recovering = false
  }
}

// Remember the spot so pathing plans around it next time.
//
// Deliberately narrow, and narrow on two independent axes. The ledger has to
// show that at least `hazardMinFailedRungs` rungs were already proven useless
// here — one rung failing is a hiccup, not dangerous ground — and the hazard
// module then has to measure a genuinely enclosed hole at the anchor. A
// `move_timeout` on an open slope satisfies the first test and fails the
// second, which is exactly what keeps mining and foundation work out of it.
function recordTerrainHazard(ctx, key, owner, anchor, ledger, options = {}) {
  if (options.rememberHazards === false || !anchor) return null
  const failedRungs = ledger?.exhausted || []
  if (failedRungs.length < Number(options.hazardMinFailedRungs ?? 2)) return null

  const hazard = rememberTerrainHazard(ctx, {
    position: anchor,
    reason: 'escape_ladder',
    rungs: [...failedRungs],
    escapeKey: key,
    now: options.now,
    ttlMs: options.hazardTtlMs
  })
  if (!hazard) return null

  logEvent(ctx, `[TERRAIN_HAZARD_RECORDED] taskId=${owner} key=${key} anchor=${formatPos(hazard.anchor)} rim=${hazard.rimY} columns=${hazard.columns.length} trapped=${hazard.trappedCount} rungsTried=${failedRungs.join('|') || 'none'}`)
  return hazard
}

function getRecoverySnapshot(state = {}) {
  return {
    stuckTicks: state.stuckTicks ?? 0,
    lastPosition: state.lastPosition || null,
    lastDistanceToTarget: state.lastDistanceToTarget ?? null,
    stuckReason: state.stuckReason || null,
    recoveryAttempts: state.recoveryAttempts ?? 0,
    isInHole: state.isInHole === true,
    isStuck: state.isStuck === true,
    lastRecoveryAction: state.lastRecoveryAction || null,
    lastFailureReason: state.lastFailureReason || null,
    pathStatus: state.pathStatus || 'idle',
    targetPlayer: state.targetPlayer || null,
    distanceToPlayer: state.distanceToPlayer ?? null,
    escapeRung: state.escapeRung || null,
    escapeLedger: state.escapeLedger || null
  }
}

async function attemptRepath(ctx, state, target, owner, options) {
  state.lastRecoveryAction = 'repath_to_safe_player_point'
  stopMovement(ctx.bot, 'stuck_recovery_repath', owner)
  const safePoint = findSafePointNearTarget(ctx, target, options)
  if (!safePoint) {
    logEvent(ctx, `[STUCK_RECOVERY_ATTEMPT] taskId=${owner} action=repath result=no_safe_player_point`)
    return { ok: false, error: 'no_safe_player_point' }
  }
  logEvent(ctx, `[STUCK_RECOVERY_ATTEMPT] taskId=${owner} action=repath target=${formatPos(safePoint)} reason=player_adjacent_safe_point`)
  const result = await moveTo(ctx, safePoint, {
    owner,
    range: options.range ?? 1,
    timeoutMs: options.recoveryTimeoutMs ?? 4000,
    holdLock: true,
    canDig: false,
    shouldContinue: options.shouldContinue
  })
  if (!result.ok) return { ok: false, error: result.error || 'repath_failed' }
  return { ok: true, action: 'repath_to_safe_player_point', data: result.data }
}

async function attemptJumpAndStep(ctx, state, target, owner, options) {
  state.lastRecoveryAction = 'jump_and_step'
  logEvent(ctx, `[STUCK_RECOVERY_ATTEMPT] taskId=${owner} action=jump_and_step`)
  try {
    ctx.bot?.setControlState?.('jump', true)
    ctx.bot?.setControlState?.('forward', true)
    await sleep(Number(options.jumpMs ?? 250))
  } finally {
    ctx.bot?.setControlState?.('jump', false)
    ctx.bot?.setControlState?.('forward', false)
  }

  const localPoint = findNearbyExitPoint(ctx, target, { ...options, radius: 3, maxYBoost: 2 })
  if (!localPoint) return { ok: false, error: 'no_short_step_point' }
  const safety = isSafeStandPoint(ctx, localPoint, options)
  if (!safety.safe) return { ok: false, error: safety.reason || 'unsafe_short_step_point' }
  const result = await moveTo(ctx, localPoint, {
    owner,
    range: 1,
    timeoutMs: options.recoveryTimeoutMs ?? 4000,
    holdLock: true,
    canDig: false,
    shouldContinue: options.shouldContinue
  })
  if (!result.ok) return { ok: false, error: result.error || 'jump_step_failed' }
  return { ok: true, action: 'jump_and_step', data: result.data }
}

async function attemptNearbyExit(ctx, state, target, owner, options) {
  state.lastRecoveryAction = 'scan_nearby_exit'
  const exitPoint = findNearbyExitPoint(ctx, target, { ...options, radius: options.exitScanRadius ?? 6, maxYBoost: 5 })
  if (!exitPoint) {
    logEvent(ctx, `[STUCK_RECOVERY_ATTEMPT] taskId=${owner} action=scan_nearby_exit result=no_exit`)
    return { ok: false, error: 'no_nearby_exit' }
  }
  logEvent(ctx, `[STUCK_RECOVERY_ATTEMPT] taskId=${owner} action=scan_nearby_exit target=${formatPos(exitPoint)} reason=higher_and_closer`)
  const result = await moveTo(ctx, exitPoint, {
    owner,
    range: 1,
    timeoutMs: options.recoveryTimeoutMs ?? 5000,
    holdLock: true,
    canDig: false,
    shouldContinue: options.shouldContinue
  })
  if (!result.ok) return { ok: false, error: result.error || 'nearby_exit_failed' }
  return { ok: true, action: 'scan_nearby_exit', data: result.data }
}

async function attemptSafeDig(ctx, state, target, owner, options) {
  if (options.allowDig === false || typeof ctx.bot?.dig !== 'function') {
    state.lastRecoveryAction = 'safe_dig_unavailable'
    logEvent(ctx, `[recovery] action=dig allowed=false reason=dig_disabled attempts=${state.recoveryAttempts}`)
    return { ok: false, error: 'safe_dig_unavailable' }
  }
  const digGate = canAttemptDigRecovery(state, options)
  if (!digGate.ok) {
    state.lastRecoveryAction = 'safe_dig_denied'
    logEvent(ctx, `[recovery] action=dig allowed=false reason=${digGate.reason} attempts=${state.recoveryAttempts} stuckTicks=${state.stuckTicks} inHole=${state.isInHole ? 'true' : 'false'}`)
    return { ok: false, error: digGate.reason }
  }
  const block = findSafeBlockToDig(ctx, target, options)
  if (!block) {
    state.lastRecoveryAction = 'safe_dig_no_block'
    logEvent(ctx, '[dig-recovery] block=none protected=false dangerAfterDig=unknown result=no_safe_block_to_dig')
    return { ok: false, error: 'no_safe_block_to_dig' }
  }

  const digLock = ctx.actionLock?.acquire?.('digging', owner, { reason: 'stuck_recovery_dig' })
  if (digLock && !digLock.ok) return { ok: false, error: digLock.reason || 'dig_lock_unavailable' }
  state.lastRecoveryAction = 'safe_dig'
  logEvent(ctx, `[STUCK_RECOVERY_ATTEMPT] taskId=${owner} action=safe_dig block=${block.name} pos=${formatPos(block.position)}`)
  logEvent(ctx, `[dig-recovery] block=${block.name} protected=false dangerAfterDig=false result=selected`)
  const buildingGuard = checkProtectedBuildingDig(ctx, block.position, { source: 'stuck_recovery_safe_dig' })
  if (!buildingGuard.allowed) {
    ctx.actionLock?.release?.('digging', owner)
    return { ok: false, error: `protected_building_dig_blocked:${buildingGuard.region.runId}` }
  }
  try {
    await ctx.bot.dig(block)
  } catch (err) {
    return { ok: false, error: err.message || 'safe_dig_failed' }
  } finally {
    ctx.actionLock?.release?.('digging', owner)
  }

  const safePoint = findNearbyExitPoint(ctx, target, { ...options, radius: 4, maxYBoost: 3 }) ||
    findSafePointNearTarget(ctx, target, options)
  if (!safePoint) return { ok: true, action: 'safe_dig', data: { dug: block.name } }
  const result = await moveTo(ctx, safePoint, {
    owner,
    range: 1,
    timeoutMs: options.recoveryTimeoutMs ?? 5000,
    holdLock: true,
    canDig: false,
    shouldContinue: options.shouldContinue
  })
  if (!result.ok) return { ok: false, error: result.error || 'safe_dig_repath_failed' }
  return { ok: true, action: 'safe_dig', data: { dug: block.name, ...result.data } }
}

// Blocks the bot may spend on saving itself. Deliberately mundane: nothing
// here is worth more than getting out of a pit alive.
const PILLAR_BLOCKS = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack', 'andesite',
  'diorite', 'granite', 'tuff', 'sand', 'gravel', 'oak_planks', 'spruce_planks',
  'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'
]

// Round 6: the lid.
//
// A pit with a roof over it defeats the entire ladder. pillar_up is the only
// rung that can actually lift her out, and it needs somewhere to jump into:
// with a course of ceiling two blocks above her feet she rises 0.2 before her
// head hits it, never clears the cell she is trying to fill, and the rung dies
// on pillar_jump_did_not_clear. That is the round-6 east-ditch stall, and
// round 5's control run proved the diagnosis by taking the lid off the same
// cavity — out in three lifts, one second.
//
// So take the lid out first, one course per lift, and only when it is safe to.
// isDigSafe is already the right question: it refuses protected blocks, lava,
// fire, cactus, water, AND anything with water or lava within one block of the
// target — which is exactly "do not pull the sea down on your own head",
// because localBlocks scans a block above the ceiling too.
//
// Three refusals, all deliberate:
//   * a ceiling we cannot see (unloaded column, blockAt null) is left alone and
//     the jump decides, exactly as it did before this existed;
//   * bedrock and anything else flagged undiggable is never attempted;
//   * the budget is small. A lid this thick is a cave system, not a trap, and
//     tunnelling upward forever is its own way to die.
async function clearHeadroomForLift(ctx, feet, owner, options = {}, budget = {}) {
  const bot = ctx.bot
  if (options.allowCeilingDig === false) return { cleared: true, reason: 'ceiling_dig_disabled' }
  if (typeof bot?.dig !== 'function') return { cleared: true, reason: 'ceiling_dig_unavailable' }

  // The cell her head rises into. Anything solid there ends the jump before it
  // starts; anything else is not this rung's problem.
  const head = { x: feet.x, y: feet.y + 2, z: feet.z }
  const block = bot.blockAt?.(toBlockVec3(head))
  if (!block) return { cleared: true, reason: 'ceiling_unknown' }
  if (AIR_BLOCKS.has(block.name)) return { cleared: true, reason: 'ceiling_open' }

  if (block.diggable === false) {
    logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${block.name} result=refused reason=undiggable`)
    return { cleared: false, reason: `undiggable:${block.name}` }
  }
  if (!isDigSafe(ctx, block, options)) {
    const why = ceilingRefusalReason(ctx, block)
    logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${block.name} result=refused reason=${why}`)
    return { cleared: false, reason: `${why}:${block.name}` }
  }
  // Same region source the placement half already uses. Reading them from
  // different places is how a caller-supplied region list ends up honoured by
  // the pillar and ignored by the dig that precedes it.
  const guard = checkProtectedBuildingDig(ctx, head, {
    source: 'stuck_recovery_ceiling_dig',
    ...resolveRegionOptions(ctx, options)
  })
  if (!guard.allowed) {
    logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${block.name} result=refused reason=protected_building runId=${guard.region?.runId || 'unknown'}`)
    return { cleared: false, reason: `protected_building:${guard.region?.runId || 'unknown'}` }
  }

  const maxDigs = Number(options.maxCeilingDigs ?? 3)
  if (Number(budget.dug ?? 0) >= maxDigs) {
    logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${block.name} result=refused reason=budget_exhausted dug=${budget.dug}/${maxDigs}`)
    return { cleared: false, reason: `ceiling_too_thick:${maxDigs}` }
  }

  const digLock = ctx.actionLock?.acquire?.('digging', owner, { reason: 'stuck_recovery_ceiling_dig' })
  if (digLock && !digLock.ok) return { cleared: false, reason: digLock.reason || 'ceiling_dig_lock_unavailable' }
  try {
    await ctx.bot.dig(block)
  } catch (err) {
    logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${block.name} result=dig_failed reason=${err.message || 'unknown'}`)
    return { cleared: false, reason: `ceiling_dig_failed:${err.message || 'unknown'}` }
  } finally {
    ctx.actionLock?.release?.('digging', owner)
  }

  // Trust the world, not the call: a dig that "succeeded" into a block that is
  // still there would send her straight back into the same failed jump.
  const after = bot.blockAt?.(toBlockVec3(head))
  if (after && !AIR_BLOCKS.has(after.name)) {
    logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${after.name} result=still_blocked`)
    return { cleared: false, reason: `ceiling_still_blocked:${after.name}` }
  }
  budget.dug = Number(budget.dug ?? 0) + 1
  logEvent(ctx, `[ESCAPE_CEILING_DIG] pos=${formatPos(head)} block=${block.name} result=cleared dug=${budget.dug}/${maxDigs}`)
  return { cleared: true, reason: 'ceiling_dug', dug: block.name }
}

// Naming only — isDigSafe owns the decision. Kept next to it so the two cannot
// drift into disagreeing about what "unsafe" meant.
function ceilingRefusalReason(ctx, block) {
  const name = String(block?.name || '')
  if (DANGER_BLOCKS.has(name) || WATER_BLOCKS.has(name)) return 'fluid_or_danger_ceiling'
  if (PROTECTED_BLOCKS.has(name)) return 'protected_block'
  const position = normalizePosition(block?.position)
  if (position) {
    for (const nearby of localBlocks(ctx, position, 1)) {
      if (DANGER_BLOCKS.has(nearby.name)) return 'lava_above_ceiling'
      if (WATER_BLOCKS.has(nearby.name)) return 'water_above_ceiling'
    }
  }
  return 'unsafe_ceiling'
}

// The rung that was missing: pillar up. A pit whose walls are out of arm's
// reach defeats every other rung — repath and nearby_exit can see the rim but
// pathfinding cannot climb to it, and safe_dig finds nothing to dig because the
// walls are two blocks away. Placing a block underfoot and jumping is the one
// move that works, and it is the standard thing a human player does.
async function attemptPillarUp(ctx, state, target, owner, options = {}) {
  state.lastRecoveryAction = 'pillar_up'
  const bot = ctx.bot
  if (options.allowPillar === false) return { ok: false, error: 'pillar_up_disabled' }
  if (typeof bot?.placeBlock !== 'function' || typeof bot?.equip !== 'function') {
    return { ok: false, error: 'pillar_up_unavailable' }
  }

  const item = findPillarItem(ctx, options)
  if (!item) {
    logEvent(ctx, '[ESCAPE_PILLAR] block=none result=no_pillar_material')
    return { ok: false, error: 'no_pillar_material' }
  }

  const lifts = Number(options.maxPillarLifts ?? 12)
  // Come to a stop first. The rungs before this one leave pathfinder goals and
  // movement controls set, and a bot that is still drifting steps off the block
  // it is trying to stand on — the place then fails with a blockUpdate timeout.
  try { stopMovement(ctx.bot, 'stuck_recovery_pillar', owner) } catch {}
  for (const control of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) {
    try { bot.setControlState?.(control, false) } catch {}
  }
  await sleep(Number(options.pillarSettleMs ?? 250))

  const startY = Math.floor(Number(livePosition(ctx)?.y ?? 0))
  let placed = 0
  // One budget for the whole climb, not per lift: a two-course lid costs two.
  const ceilingBudget = { dug: 0 }

  const lock = ctx.actionLock?.acquire?.('building', owner, { reason: 'stuck_recovery_pillar' })
  if (lock && !lock.ok) return { ok: false, error: lock.reason || 'pillar_lock_unavailable' }
  try {
    for (let lift = 0; lift < lifts; lift += 1) {
      // Each lift places a real block in the world. Do not keep building a
      // staircase for a task that has already been cancelled.
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
        logEvent(ctx, `[ESCAPE_PILLAR] result=abandoned lifts=${placed} reason=task_no_longer_running`)
        break
      }
      const position = livePosition(ctx)
      if (!position) break
      const feet = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      }

      // Never pillar through somebody's building, and never turn a finished
      // structure into scaffolding.
      const region = findProtectedRegionAt(feet, resolveRegionOptions(ctx, options))
      if (region) {
        logEvent(ctx, `[ESCAPE_PILLAR] pos=${formatPos(feet)} result=protected_building_blocked runId=${region.runId || 'unknown'}`)
        return { ok: false, error: `pillar_protected_building:${region.runId || 'unknown'}` }
      }

      const support = bot.blockAt?.(toBlockVec3({ x: feet.x, y: feet.y - 1, z: feet.z }))
      if (!support || AIR_BLOCKS.has(support.name)) {
        logEvent(ctx, `[ESCAPE_PILLAR] pos=${formatPos(feet)} result=no_support_below`)
        break
      }

      const headroom = await clearHeadroomForLift(ctx, feet, owner, options, ceilingBudget)
      if (!headroom.cleared) {
        return placed > 0
          ? { ok: true, action: 'pillar_up', data: { placed, liftedFrom: startY } }
          : { ok: false, error: `pillar_ceiling_blocked:${headroom.reason}` }
      }

      const lift = await placeUnderfoot(ctx, bot, item, support, feet, options)
      if (!lift.ok) {
        logEvent(ctx, `[ESCAPE_PILLAR] pos=${formatPos(feet)} result=place_failed reason=${lift.error}`)
        return placed > 0
          ? { ok: true, action: 'pillar_up', data: { placed, liftedFrom: startY } }
          : { ok: false, error: lift.error }
      }

      placed += 1
      await sleep(Number(options.pillarSettleMs ?? 250))
      const lifted = livePosition(ctx)
      logEvent(ctx, `[ESCAPE_PILLAR] pos=${formatPos(feet)} block=${item.name} lift=${placed}/${lifts} now=${formatPos(lifted)} result=placed`)
      // If the block went down but we did not rise, stacking again would just
      // re-place into the same cell. Stop rather than burn the whole stack.
      if (lifted && Math.floor(Number(lifted.y)) <= feet.y) {
        logEvent(ctx, `[ESCAPE_PILLAR] pos=${formatPos(feet)} result=no_lift_after_place lifts=${placed}`)
        break
      }

      // Only stop stacking once there is real ground to step onto beside us,
      // AND that ground is meaningfully above where we jammed. Both halves
      // matter: "am I standing somewhere safe" is true everywhere inside the
      // pit, and so is "is the neighbouring block safe" while we are still on
      // the flat pit floor. Either test alone ends the climb after one block
      // and leaves the bot exactly as stuck as before.
      if (placed >= Number(options.pillarClearance ?? 2) && clearedSurroundingWalls(ctx, livePosition(ctx), options)) {
        logEvent(ctx, `[ESCAPE_PILLAR] result=cleared_walls lifts=${placed} liftedFrom=${startY}`)
        return { ok: true, action: 'pillar_up', data: { placed, liftedFrom: startY, clearedWalls: true } }
      }

      const stepOut = findAdjacentStandPoint(ctx, { ...options, minY: startY + Number(options.pillarClearance ?? 2), live: true })
      if (stepOut) {
        logEvent(ctx, `[ESCAPE_PILLAR] pos=${formatPos(stepOut)} result=rim_reached lifts=${placed}`)
        const moved = await moveTo(ctx, stepOut, {
          owner,
          range: 1,
          timeoutMs: options.recoveryTimeoutMs ?? 5000,
          holdLock: true,
          canDig: false
        })
        if (moved.ok) return { ok: true, action: 'pillar_up', data: { placed, liftedFrom: startY, exited: true } }
      }
    }
  } finally {
    ctx.actionLock?.release?.('building', owner)
  }

  if (!placed) return { ok: false, error: 'pillar_up_no_lift' }
  return { ok: true, action: 'pillar_up', data: { placed, liftedFrom: startY } }
}

// Terminal rung. Everything failed; stop burning the movement lock and stop
// walking into whatever is hurting us. Stand still, say where we are, and let
// the ledger's backoff keep us quiet until the situation changes.
async function attemptSafePosture(ctx, state, target, owner, options = {}) {
  state.lastRecoveryAction = 'safe_posture'
  try {
    stopMovement(ctx.bot, 'escape_safe_posture', owner)
  } catch {}
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
    try { ctx.bot?.setControlState?.(control, false) } catch {}
  }
  const position = livePosition(ctx)
  logEvent(ctx, `[ESCAPE_SAFE_POSTURE] taskId=${owner} pos=${formatPos(position)} reason=${state.lastFailureReason || state.stuckReason || 'unknown'}`)
  if (options.quiet !== true) {
    maybeChat(ctx, options.helpMessage || `我卡在 ${formatPos(position)} 出不来了，自己想的办法都试过了，来拉我一把或者给我点方块。`, options)
  }
  return { ok: true, action: 'safe_posture', data: { position } }
}

// Best progress across several candidate positions (where the bot ended up,
// where the rung was aiming). Test stubs and laggy position tracking make the
// observed position unreliable on its own; the rung's own destination is
// evidence of intent that does not depend on physics having ticked.
function bestProgress(anchor, candidates, options = {}) {
  let best = { improved: false, yGain: 0, flatGain: 0, reason: 'still_at_anchor' }
  for (const candidate of candidates) {
    if (!candidate) continue
    const progress = measureEscapeProgress(anchor, candidate, options)
    if (progress.improved) return progress
    if (progress.flatGain > best.flatGain || progress.yGain > best.yGain) best = progress
  }
  return best
}

// One lift of the pillar: jump, and place a block into the space we just left.
// Retried once because the first hop can be eaten by a pending physics tick.
async function placeUnderfoot(ctx, bot, item, support, feet, options = {}) {
  const attempts = Number(options.pillarPlaceAttempts ?? 3)
  let lastError = 'pillar_place_failed'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await bot.equip(item, 'hand')
      // Face the block we are placing against. Without this the server can
      // reject the placement, which surfaces as a blockUpdate timeout.
      if (typeof bot.lookAt === 'function') {
        // lookAt needs a real Vec3 (it calls .minus on it), not a plain object.
        const aim = toBlockVec3({ x: feet.x, y: feet.y - 1, z: feet.z })
        if (aim) await bot.lookAt(aim.offset(0.5, 0.5, 0.5), true)
      }
      bot.setControlState?.('jump', true)
      // Wait until the body has actually cleared the cell we are filling. A
      // fixed sleep is a guess: too short and we are still standing in the
      // target, which is exactly how this failed on real hardware.
      const airborne = await waitUntilAirborne(bot, feet.y, options)
      if (!airborne) {
        lastError = 'pillar_jump_did_not_clear'
      } else {
        await bot.placeBlock(support, { x: 0, y: 1, z: 0 })
        return { ok: true }
      }
    } catch (err) {
      lastError = err.message || 'pillar_place_failed'
    } finally {
      bot.setControlState?.('jump', false)
    }
    await sleep(Number(options.pillarSettleMs ?? 250))
  }
  return { ok: false, error: lastError }
}

async function waitUntilAirborne(bot, feetY, options = {}) {
  const deadline = Date.now() + Number(options.pillarJumpTimeoutMs ?? 900)
  const needed = feetY + Number(options.pillarClearHeight ?? 0.55)
  while (Date.now() < deadline) {
    const y = Number(bot?.entity?.position?.y)
    if (Number.isFinite(y) && y >= needed) return true
    await sleep(40)
  }
  return false
}

// Are we now standing higher than everything penning us in? Once the bot's
// feet clear the tallest solid block around it, normal pathfinding has a route
// again and stacking more blocks is pure waste.
function clearedSurroundingWalls(ctx, position, options = {}) {
  const bot = ctx.bot
  if (!bot?.blockAt || !position) return false
  const radius = Number(options.pillarWallScanRadius ?? 3)
  const feetY = Math.floor(Number(position.y))
  const cx = Math.floor(position.x)
  const cz = Math.floor(position.z)
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      if (dx === 0 && dz === 0) continue
      for (let y = feetY; y <= feetY + 1; y += 1) {
        const block = bot.blockAt(toBlockVec3({ x: cx + dx, y, z: cz + dz }))
        if (block && !AIR_BLOCKS.has(block.name)) return false
      }
    }
  }
  return true
}

// Ground the bot could step onto from where it currently stands: a neighbour
// at foot level that is clear and has something solid beneath it. Inside a pit
// every neighbour is a cliff, so this only becomes true at the rim.
function findAdjacentStandPoint(ctx, options = {}) {
  const position = options.live === true ? livePosition(ctx) : currentPosition(ctx)
  if (!position) return null
  const feet = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  const minY = Number.isFinite(Number(options.minY)) ? Number(options.minY) : -Infinity
  if (feet.y < minY) return null
  for (const dir of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
    const candidate = { x: feet.x + dir.x, y: feet.y, z: feet.z + dir.z }
    if (isSafeStandPoint(ctx, candidate, options).safe) return candidate
  }
  return null
}

function findPillarItem(ctx, options = {}) {
  const items = ctx.bot?.inventory?.items?.() || []
  const preferred = options.pillarBlocks || PILLAR_BLOCKS
  for (const name of preferred) {
    const match = items.find(item => item?.name === name && Number(item.count || 0) > 0)
    if (match) return match
  }
  return null
}

function resolveRegionOptions(ctx, options = {}) {
  return {
    exemptRunId: options.exemptRunId || ctx?.activeConstructionRunId || null,
    ...(options.regions ? { regions: options.regions } : {})
  }
}

function finishRecovery(ctx, state, result) {
  state.pathStatus = 'recovering_success'
  state.isStuck = false
  state.isInHole = false
  state.stuckTicks = 0
  state.stuckReason = null
  state.lastFailureReason = null
  state.lastRecoveryAction = result.action || state.lastRecoveryAction
  logEvent(ctx, `[STUCK_RECOVERY_SUCCESS] action=${state.lastRecoveryAction}`)
  return result
}

function findSafePointNearTarget(ctx, target, options = {}) {
  const rings = [2, 3, 4]
  for (const radius of rings) {
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8
      const candidate = {
        x: Math.round(target.x + Math.cos(angle) * radius),
        y: Math.round(target.y),
        z: Math.round(target.z + Math.sin(angle) * radius)
      }
      if (isSafeStandPoint(ctx, candidate, options).safe) return candidate
    }
  }
  return null
}

function findNearbyExitPoint(ctx, target, options = {}) {
  const origin = currentPosition(ctx)
  if (!origin) return null
  const radius = Number(options.radius ?? 6)
  const maxYBoost = Number(options.maxYBoost ?? 5)
  const candidates = []
  for (let dy = 0; dy <= maxYBoost; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) === 0) continue
        if (Math.sqrt(dx * dx + dz * dz) > radius) continue
        const candidate = {
          x: Math.round(origin.x + dx),
          y: Math.round(origin.y + dy),
          z: Math.round(origin.z + dz)
        }
        const safety = isSafeStandPoint(ctx, candidate, options)
        if (!safety.safe) continue
        candidates.push({
          position: candidate,
          score: dy * 20 - distance(candidate, target) - distance(candidate, origin) * 0.4
        })
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.position || null
}

function findSafeBlockToDig(ctx, target, options = {}) {
  const bot = ctx.bot
  const origin = currentPosition(ctx)
  if (!bot?.blockAt || !origin) return null
  const checks = [
    { x: origin.x, y: origin.y + 1, z: origin.z },
    ...sortDirectionsTowardTarget(origin, target).map(dir => ({
      x: origin.x + dir.x,
      y: origin.y,
      z: origin.z + dir.z
    })),
    ...sortDirectionsTowardTarget(origin, target).map(dir => ({
      x: origin.x + dir.x,
      y: origin.y + 1,
      z: origin.z + dir.z
    }))
  ]

  for (const position of checks) {
    if (position.y < origin.y) continue
    const block = bot.blockAt(toBlockVec3(position))
    if (!block || AIR_BLOCKS.has(block.name)) continue
    if (!isDigSafe(ctx, block, options)) continue
    return block
  }
  return null
}

function isDigSafe(ctx, block, options = {}) {
  if (!block?.name || PROTECTED_BLOCKS.has(block.name)) return false
  if (DANGER_BLOCKS.has(block.name) || WATER_BLOCKS.has(block.name)) return false
  const position = normalizePosition(block.position)
  const origin = currentPosition(ctx)
  if (!position || !origin) return false
  if (position.x === Math.floor(origin.x) && position.z === Math.floor(origin.z) && position.y <= Math.floor(origin.y)) return false
  for (const nearby of localBlocks(ctx, position, 1)) {
    if (DANGER_BLOCKS.has(nearby.name) || WATER_BLOCKS.has(nearby.name)) return false
  }
  return true
}

function isSafeStandPoint(ctx, position, options = {}) {
  const bot = ctx.bot
  const target = normalizePosition(position)
  if (!target) return { safe: false, reason: 'missing_position' }
  if (!bot?.blockAt) return { safe: true, reason: 'no_block_scan' }

  const feet = bot.blockAt(toBlockVec3(target))
  const head = bot.blockAt(toBlockVec3({ x: target.x, y: target.y + 1, z: target.z }))
  const below = bot.blockAt(toBlockVec3({ x: target.x, y: target.y - 1, z: target.z }))
  if (feet && !AIR_BLOCKS.has(feet.name)) return { safe: false, reason: `blocked_feet:${feet.name}` }
  if (head && !AIR_BLOCKS.has(head.name)) return { safe: false, reason: `blocked_head:${head.name}` }
  if (!below || AIR_BLOCKS.has(below.name)) return { safe: false, reason: 'cliff' }
  if (DANGER_BLOCKS.has(below.name) || WATER_BLOCKS.has(below.name)) return { safe: false, reason: below.name }
  for (const block of localBlocks(ctx, target, Number(options.localSafetyRadius ?? 1))) {
    if (DANGER_BLOCKS.has(block.name)) return { safe: false, reason: 'lava' }
    if (WATER_BLOCKS.has(block.name) && options.allowWater !== true) return { safe: false, reason: 'water' }
  }
  return { safe: true, reason: 'safe' }
}

function detectInHole(ctx, target, options = {}) {
  const position = currentPosition(ctx)
  if (!position) return false
  if (target && Number(target.y) - Number(position.y) >= Number(options.holeDepthThreshold ?? 3)) return true
  const bot = ctx.bot
  if (!bot?.blockAt) return false
  const sides = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 }
  ]
  const blockedSides = sides.filter(dir => {
    const block = bot.blockAt(toBlockVec3({
      x: Math.floor(position.x + dir.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z + dir.z)
    }))
    return block && !AIR_BLOCKS.has(block.name)
  }).length
  const head = bot.blockAt(toBlockVec3({ x: position.x, y: position.y + 1, z: position.z }))
  return blockedSides >= 3 && (!head || AIR_BLOCKS.has(head.name))
}

function localBlocks(ctx, center, radius) {
  const bot = ctx.bot
  if (!bot?.blockAt) return []
  const blocks = []
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const block = bot.blockAt(toBlockVec3({ x: center.x + dx, y: center.y + dy, z: center.z + dz }))
        if (block) blocks.push(block)
      }
    }
  }
  return blocks
}

function sortDirectionsTowardTarget(origin, target) {
  const directions = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 }
  ]
  return directions.sort((a, b) => {
    const da = distance({ x: origin.x + a.x, y: origin.y, z: origin.z + a.z }, target)
    const db = distance({ x: origin.x + b.x, y: origin.y, z: origin.z + b.z }, target)
    return da - db
  })
}

function resetProgressState(state) {
  state.stuckTicks = 0
  state.pathFailureCount = 0
  state.stuckReason = null
  state.isStuck = false
  state.isInHole = false
}

function canAttemptDigRecovery(state, options = {}) {
  const minAttempts = Number(options.minDigRecoveryAttempts ?? 1)
  if (state.recoveryAttempts < minAttempts) {
    return { ok: false, reason: 'dig_recovery_not_enough_attempts' }
  }
  if (options.requireInHoleForDig === true && !state.isInHole) {
    return { ok: false, reason: 'dig_recovery_requires_hole' }
  }
  const minStuckTicks = Number(options.minDigStuckTicks ?? 1)
  if (state.stuckTicks < minStuckTicks) {
    return { ok: false, reason: 'dig_recovery_not_confirmed_stuck' }
  }
  return { ok: true }
}

// The blackboard snapshot only refreshes on a tick, which is far too slow for
// a climb: reading it inside the pillar loop reports the same feet position for
// every lift, so the bot re-places into the block it just set and burns the
// whole stack without moving. Ask the entity directly.
function livePosition(ctx) {
  return ctx?.bot?.entity?.position || currentPosition(ctx)
}

function currentPosition(ctx) {
  return ctx.blackboard?.get?.('bot.position') || ctx.bot?.entity?.position || ctx.worldState?.bot?.position || null
}

function clonePos(position) {
  return position ? { x: position.x, y: position.y, z: position.z } : null
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function maybeChat(ctx, message, options = {}) {
  if (options.chatFeedback === false) return
  try {
    ctx.bot?.chat?.(message)
  } catch {}
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

module.exports = {
  attemptPillarUp,
  clearHeadroomForLift,
  attemptSafePosture,
  createRecoveryState,
  detectInHole,
  findPillarItem,
  getRecoverySnapshot,
  notePathFailure,
  runStuckRecovery,
  updateStuckTracking
}
