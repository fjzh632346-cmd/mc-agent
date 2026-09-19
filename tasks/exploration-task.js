const { BaseTask, TASK_STATE } = require('./base-task')
const { stopMoving } = require('../actions/move')
const { ExplorationSystem } = require('../systems/exploration-system')
const {
  createRecoveryState,
  getRecoverySnapshot,
  notePathFailure,
  runStuckRecovery
} = require('./stuck-recovery')

const EXPLORATION_MODES = Object.freeze({
  EXPLORE_NEARBY: 'EXPLORE_NEARBY',
  SAFE_EXPLORE: 'SAFE_EXPLORE',
  FIND_PLACE_OR_RESOURCE: 'FIND_PLACE_OR_RESOURCE',
  SCOUT_AREA: 'SCOUT_AREA',
  FIND_RESOURCE_AREA: 'FIND_RESOURCE_AREA',
  CHECK_EXPLORED_AREAS: 'CHECK_EXPLORED_AREAS',
  RETURN_IF_UNSAFE: 'RETURN_IF_UNSAFE'
})

class ExplorationTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'exploration' })
    this.system = new ExplorationSystem({
      ...(options.params?.explorationOptions || {}),
      ...pickExplorationOptions(options.params || {})
    })
    this.started = false
    this.mode = options.params?.mode || EXPLORATION_MODES.EXPLORE_NEARBY
    this.origin = options.params?.origin || null
    this.radius = options.params?.radius || null
    this.currentExploreRadius = null
    this.explorationMode = null
    this.centerPosition = null
    this.ringIndex = 0
    this.currentSector = 0
    this.directionVector = null
    this.checkpointIndex = 0
    this.maxDirectionalDistance = null
    this.currentTarget = null
    this.targetPosition = null
    this.targetDistance = null
    this.exploredPoints = []
    this.discoveredPlaces = []
    this.recentDiscoveredPlaces = []
    this.dangerZones = []
    this.distanceFromBase = null
    this.distanceFromPlayer = null
    this.failedReason = null
    this.dangerLevel = 'low'
    this.failedTargetCount = 0
    this.lastFailureReason = null
    this.safetyState = 'unknown'
    this.explorationStatus = 'IDLE'
    this.recovery = createRecoveryState()
  }

  get requiredLocks() {
    if (this.mode === EXPLORATION_MODES.CHECK_EXPLORED_AREAS) return []
    if (this.mode === EXPLORATION_MODES.RETURN_IF_UNSAFE) return []
    return ['movement']
  }

  async start(ctx) {
    await super.start(ctx)
    this.origin = this.origin || currentPosition(ctx)
  }

  async update(ctx) {
    if (this.state !== TASK_STATE.RUNNING) return
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    let result = await this.runExplorationAction(ctx)
    this.syncExplorationState()
    if (!result.ok && isPathFailure(result.error)) {
      result = await this.handleStuckExplorationFailure(ctx, result)
      this.syncExplorationState()
    }
    if (result.ok) await this.complete(ctx, this.explorationResult(result))
    else await this.fail(ctx, result.error || 'exploration_failed')
  }

  async runExplorationAction(ctx) {
    const options = {
      owner: this.id,
      mode: this.mode,
      origin: this.origin,
      radius: this.radius || radiusForMode(this.mode, this.params.radius),
      explorationMode: this.params.explorationMode || null,
      centerPosition: this.params.centerPosition || null,
      direction: this.params.direction || null,
      directionVector: this.params.directionVector || null,
      ringStartRadius: this.params.ringStartRadius || null,
      ringRadiusStep: this.params.ringRadiusStep || null,
      maxRingRadius: this.params.maxRingRadius || null,
      directionalStepDistance: this.params.directionalStepDistance || null,
      maxDirectionalDistance: this.params.maxDirectionalDistance || null,
      sectorCount: this.params.sectorCount || null,
      visitedCooldownMs: this.params.visitedCooldownMs || null,
      minDistanceBetweenExploreTargets: this.params.minDistanceBetweenExploreTargets || null,
      safeCheckpointDistance: this.params.safeCheckpointDistance || null,
      minExploreDistance: this.params.minExploreDistance || null,
      maxExploreDistance: this.params.maxExploreDistance || null,
      explorationRadius: this.params.explorationRadius || null,
      radiusStep: this.params.radiusStep || null,
      maxFailedTargetsBeforeShrink: this.params.maxFailedTargetsBeforeShrink || null,
      scanRadius: this.params.scanRadius || null,
      maxDistanceFromBase: this.params.maxDistanceFromBase || null,
      maxDistanceFromPlayer: this.params.maxDistanceFromPlayer || null
    }

    if (this.mode === EXPLORATION_MODES.CHECK_EXPLORED_AREAS) {
      return this.system.checkExploredAreas(ctx)
    }

    const radius = options.radius
    logEvent(ctx, `[EXPLORATION_TASK_START] radius=${radius} mode=${this.mode === EXPLORATION_MODES.SAFE_EXPLORE || this.params.safeMode ? 'safe' : 'normal'}`)

    const stop = this.system.shouldStopExploring(ctx, options)
    this.syncExplorationState()
    if (stop.shouldStop) {
      this.system.noteExploreFailure?.(ctx, stop.reason || 'unsafe_to_explore')
      this.syncExplorationState()
      this.handleUnsafeReason(ctx, stop.reason)
      if (this.mode === EXPLORATION_MODES.RETURN_IF_UNSAFE) return this.system.returnFromExploration(ctx, options)
      logEvent(ctx, `[EXPLORE_ABORT_DANGER] reason=${stop.reason || 'unsafe_to_explore'}`)
      return { ok: false, error: stop.reason || 'unsafe_to_explore' }
    }

    if (this.mode === EXPLORATION_MODES.RETURN_IF_UNSAFE) {
      return { ok: true, action: 'noop', reason: 'safe_to_continue' }
    }

    return this.system.exploreOnce(ctx, options)
  }

  handleUnsafeReason(ctx, reason) {
    if (reason === 'inventory_full') {
      ctx.taskManager?.enqueue?.('storage', { mode: 'INVENTORY_FULL_STORE' }, 6, 'exploration_task')
    } else if (reason === 'food_low') {
      ctx.taskManager?.enqueue?.('farming', { mode: 'EAT_FOOD' }, 8, 'exploration_task')
    } else if (['danger_too_high', 'hostile_nearby'].includes(reason)) {
      ctx.taskManager?.enqueue?.('guard_player', { durationMs: 15000, radius: 8 }, 9, 'exploration_task')
    } else if (['too_far_from_base', 'too_far_from_player', 'night_without_strategy'].includes(reason)) {
      this.system.returnFromExploration(ctx, { priority: 7 })
    }
  }

  syncExplorationState() {
    const status = this.system.getStatus()
    this.origin = status.origin || this.origin
    this.radius = status.radius || this.radius
    this.currentExploreRadius = status.currentExploreRadius ?? this.currentExploreRadius
    this.explorationMode = status.explorationMode || this.explorationMode
    this.centerPosition = status.centerPosition || this.centerPosition
    this.ringIndex = status.ringIndex ?? this.ringIndex
    this.currentSector = status.currentSector ?? this.currentSector
    this.directionVector = status.directionVector || this.directionVector
    this.checkpointIndex = status.checkpointIndex ?? this.checkpointIndex
    this.maxDirectionalDistance = status.maxDirectionalDistance ?? this.maxDirectionalDistance
    this.currentTarget = status.currentTarget || this.currentTarget
    this.targetPosition = status.targetPosition || this.targetPosition
    this.targetDistance = status.targetDistance ?? this.targetDistance
    this.exploredPoints = status.exploredPoints || this.exploredPoints
    this.discoveredPlaces = status.discoveredPlaces || this.discoveredPlaces
    this.recentDiscoveredPlaces = status.recentDiscoveredPlaces || this.recentDiscoveredPlaces
    this.dangerZones = status.dangerZones || this.dangerZones
    this.distanceFromBase = status.distanceFromBase ?? this.distanceFromBase
    this.distanceFromPlayer = status.distanceFromPlayer ?? this.distanceFromPlayer
    this.dangerLevel = status.dangerLevel || this.dangerLevel
    this.failedTargetCount = status.failedTargetCount ?? this.failedTargetCount
    this.lastFailureReason = status.lastFailureReason || this.lastFailureReason
    this.safetyState = status.safetyState || this.safetyState
    this.failedReason = status.lastExplorationError || this.failedReason
    this.explorationStatus = status.explorationStatus || this.explorationStatus
  }

  async pause(ctx, reason) {
    stopMoving(ctx, { owner: this.id, reason: reason || 'pause' })
    await super.pause(ctx, reason)
  }

  async resume(ctx) {
    await super.resume(ctx)
  }

  async interrupt(ctx, reason) {
    stopMoving(ctx, { owner: this.id, reason: reason || 'interrupt' })
    await super.interrupt(ctx, reason)
  }

  async handleStuckExplorationFailure(ctx, result) {
    const target = this.targetPosition || this.currentTarget || this.origin || currentPosition(ctx)
    notePathFailure(ctx, this.recovery, result.error || 'pathfinder_failed')
    logEvent(ctx, `[STUCK_DETECTED] task=exploration taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
    const dangerLevel = ctx.blackboard?.get?.('mobs.dangerLevel') || ctx.worldState?.mobs?.dangerLevel
    if (dangerLevel === 'high' || dangerLevel === 'critical') {
      this.recovery.lastFailureReason = result.error || 'pathfinder_failed'
      return result
    }
    const recoveryResult = await runStuckRecovery(ctx, this.recovery, target, this.id, {
      targetRange: 2,
      recoveryTimeoutMs: this.params.recoveryTimeoutMs || 4000,
      allowDig: this.params.allowDigDuringRecovery === true,
      chatFeedback: this.params.chatFeedbackDuringRecovery === true
    })
    if (!recoveryResult.ok) {
      this.recovery.lastFailureReason = recoveryResult.error || result.error || 'stuck_recovery_failed'
      return { ok: false, error: recoveryResult.error || result.error || 'stuck_recovery_failed' }
    }
    return {
      ok: true,
      action: 'stuck_recovered',
      reason: 'exploration_recovery_completed',
      data: recoveryResult.data || {}
    }
  }

  async fail(ctx, error) {
    this.failedReason = error instanceof Error ? error.message : String(error)
    this.explorationStatus = 'FAILED'
    logExplorationSummary(ctx, this, true, this.failedReason)
    logEvent(ctx, `[EXPLORATION_TASK_FAILED] reason=${this.failedReason}`)
    await super.fail(ctx, error)
  }

  async complete(ctx, result = {}) {
    logExplorationSummary(ctx, this, false, result.reason || 'ok')
    logEvent(ctx, '[EXPLORATION_TASK_SUCCESS]')
    await super.complete(ctx, result)
  }

  explorationResult(result) {
    return {
      ...result,
      mode: this.mode,
      origin: this.origin,
      radius: this.radius,
      currentExploreRadius: this.currentExploreRadius,
      explorationMode: this.explorationMode,
      centerPosition: this.centerPosition,
      ringIndex: this.ringIndex,
      currentSector: this.currentSector,
      directionVector: this.directionVector,
      checkpointIndex: this.checkpointIndex,
      maxDirectionalDistance: this.maxDirectionalDistance,
      currentTarget: this.currentTarget,
      targetPosition: this.targetPosition,
      targetDistance: this.targetDistance,
      exploredPoints: this.exploredPoints,
      discoveredPlaces: this.discoveredPlaces,
      recentDiscoveredPlaces: this.recentDiscoveredPlaces,
      dangerZones: this.dangerZones,
      distanceFromBase: this.distanceFromBase,
      distanceFromPlayer: this.distanceFromPlayer,
      dangerLevel: this.dangerLevel,
      failedTargetCount: this.failedTargetCount,
      lastFailureReason: this.lastFailureReason,
      safetyState: this.safetyState,
      explorationStatus: this.explorationStatus
    }
  }

  toJSON() {
    const recovery = getRecoverySnapshot(this.recovery)
    return {
      ...super.toJSON(),
      ...recovery,
      mode: this.mode,
      origin: this.origin,
      radius: this.radius,
      currentExploreRadius: this.currentExploreRadius,
      explorationMode: this.explorationMode,
      centerPosition: this.centerPosition,
      ringIndex: this.ringIndex,
      currentSector: this.currentSector,
      directionVector: this.directionVector,
      checkpointIndex: this.checkpointIndex,
      maxDirectionalDistance: this.maxDirectionalDistance,
      currentTarget: this.currentTarget,
      targetPosition: this.targetPosition,
      targetDistance: this.targetDistance,
      exploredPoints: this.exploredPoints,
      discoveredPlaces: this.discoveredPlaces,
      recentDiscoveredPlaces: this.recentDiscoveredPlaces,
      dangerZones: this.dangerZones,
      distanceFromBase: this.distanceFromBase,
      distanceFromPlayer: this.distanceFromPlayer,
      dangerLevel: this.dangerLevel,
      failedTargetCount: this.failedTargetCount,
      lastFailureReason: this.lastFailureReason || recovery.lastFailureReason,
      safetyState: this.safetyState,
      failedReason: this.failedReason,
      explorationStatus: this.explorationStatus,
      lastExplorationError: this.failedReason
    }
  }
}

function pickExplorationOptions(params) {
  const keys = [
    'minExploreDistance',
    'maxExploreDistance',
    'explorationRadius',
    'radiusStep',
    'maxFailedTargetsBeforeShrink',
    'maxMoveTargetAttempts',
    'targetCooldownMs',
    'directionSectors',
    'explorationMode',
    'centerPosition',
    'ringStartRadius',
    'ringRadiusStep',
    'maxRingRadius',
    'directionalStepDistance',
    'maxDirectionalDistance',
    'sectorCount',
    'visitedCooldownMs',
    'minDistanceBetweenExploreTargets',
    'safeCheckpointDistance',
    'direction',
    'directionVector'
  ]
  const picked = {}
  for (const key of keys) {
    if (params[key] != null) picked[key] = params[key]
  }
  return picked
}

function radiusForMode(mode, requested) {
  if (requested) return requested
  if (mode === EXPLORATION_MODES.SAFE_EXPLORE) return 32
  if (mode === EXPLORATION_MODES.SCOUT_AREA) return 24
  if (mode === EXPLORATION_MODES.FIND_RESOURCE_AREA || mode === EXPLORATION_MODES.FIND_PLACE_OR_RESOURCE) return 48
  return 32
}

function currentPosition(context) {
  const position = context.blackboard?.get?.('bot.position') || context.bot?.entity?.position || context.worldState?.bot?.position
  if (!position) return null
  return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) }
}

function logExplorationSummary(ctx, task, aborted, reason) {
  logEvent(ctx, `[EXPLORATION_SUMMARY] visited=${task.exploredPoints.length} discovered=${task.discoveredPlaces.length} dangerZones=${task.dangerZones.length} aborted=${aborted ? 'true' : 'false'} reason=${reason || 'ok'}`)
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

function isPathFailure(error) {
  return ['move_timeout', 'task_interrupted', 'pathfinder_failed', 'No path to the goal'].some(item => String(error || '').includes(item))
}

module.exports = {
  EXPLORATION_MODES,
  ExplorationTask
}
