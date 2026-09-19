const exploreActions = require('../actions/explore')

class ExplorationSystem {
  constructor(options = {}) {
    this.options = {
      defaultRadius: 32,
      scoutRadius: 48,
      resourceRadius: 48,
      noBaseMaxRadius: 32,
      explorationMode: 'ring',
      ringStartRadius: 32,
      ringRadiusStep: 16,
      maxRingRadius: 96,
      directionalStepDistance: 32,
      maxDirectionalDistance: 192,
      sectorCount: 8,
      visitedCooldownMs: 10 * 60 * 1000,
      minDistanceBetweenExploreTargets: 16,
      safeCheckpointDistance: 32,
      minExploreDistance: 24,
      maxExploreDistance: 96,
      explorationRadius: 48,
      radiusStep: 16,
      maxFailedTargetsBeforeShrink: 3,
      maxMoveTargetAttempts: 2,
      targetCooldownMs: 10 * 60 * 1000,
      directionSectors: 8,
      maxDistanceFromBase: 128,
      maxDistanceFromPlayer: 96,
      lowFoodThreshold: 8,
      lowHealthThreshold: 10,
      inventoryEmptySlotThreshold: 1,
      ...options
    }
    this.status = {
      explorationStatus: 'IDLE',
      explorationMode: this.options.explorationMode,
      centerPosition: null,
      ringIndex: 0,
      currentSector: 0,
      directionVector: null,
      checkpointIndex: 0,
      maxDirectionalDistance: this.options.maxDirectionalDistance,
      recentDiscoveredPlaces: [],
      origin: null,
      radius: this.options.defaultRadius,
      currentExploreRadius: this.options.explorationRadius,
      currentTarget: null,
      targetPosition: null,
      targetDistance: null,
      exploredPoints: [],
      discoveredPlaces: [],
      dangerZones: [],
      distanceFromBase: null,
      distanceFromPlayer: null,
      dangerLevel: 'low',
      successfulExploreCount: 0,
      failedTargetCount: 0,
      lastFailureReason: null,
      lastExplorationError: null,
      safetyState: 'unknown',
      directionIndex: 0,
      visitedTargets: []
    }
  }

  inspectExplorationState(context, options = {}) {
    const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel || 'none'
    const health = Number(context.blackboard?.get?.('bot.health') ?? context.bot?.health ?? 20)
    const food = Number(context.blackboard?.get?.('bot.food') ?? context.bot?.food ?? 20)
    const emptySlots = context.blackboard?.get?.('inventory.emptySlots')
    const isDay = context.blackboard?.get?.('world.isDay')
    const distanceFromBase = exploreActions.estimateDistanceFromBase(context).data.distanceFromBase
    const distanceFromPlayer = exploreActions.estimateDistanceFromPlayer(context).data.distanceFromPlayer
    const entities = exploreActions.scanNearbyEntities(context, options.radius || this.options.defaultRadius)
    const nearbyHostiles = entities.ok ? entities.data.nearbyHostiles : []
    const radius = this.resolveRadius(context, options)
    const explorationMode = resolveExplorationMode(options, this.options)
    const centerPosition = resolveCenterPosition(context, options) || this.status.centerPosition || currentPosition(context)
    const reasons = []

    if (['high', 'critical'].includes(dangerLevel)) reasons.push('danger_too_high')
    if (health <= (options.lowHealthThreshold || this.options.lowHealthThreshold)) reasons.push('health_low')
    if (food <= (options.lowFoodThreshold || this.options.lowFoodThreshold)) reasons.push('food_low')
    if (emptySlots != null && emptySlots <= (options.inventoryEmptySlotThreshold || this.options.inventoryEmptySlotThreshold)) reasons.push('inventory_full')
    if (isDay === false && options.allowNight !== true) reasons.push('night_without_strategy')
    if (nearbyHostiles.length > 0) reasons.push('hostile_nearby')
    if (distanceFromBase != null && distanceFromBase > (options.maxDistanceFromBase || this.options.maxDistanceFromBase)) reasons.push('too_far_from_base')
    if (distanceFromPlayer != null && distanceFromPlayer > (options.maxDistanceFromPlayer || this.options.maxDistanceFromPlayer)) reasons.push('too_far_from_player')
    if (['high', 'critical'].includes(dangerLevel)) {
      logEvent(context, `[DANGER_DETECTED] type=mob pos=${formatPos(currentPosition(context))} severity=9`)
      logEvent(context, `[DANGER_LEVEL_UPDATE] level=high reason=${dangerLevel}`)
      const pos = currentPosition(context)
      if (pos) this.recordDanger(context, { type: 'general_danger', name: dangerLevel, position: pos })
    }
    if (isDay === false && options.allowNight !== true) {
      const pos = currentPosition(context)
      logEvent(context, `[DANGER_DETECTED] type=night pos=${formatPos(pos)} severity=6`)
      logEvent(context, '[DANGER_LEVEL_UPDATE] level=medium reason=night')
      if (pos) this.recordDanger(context, { type: 'night', name: 'night', position: pos })
    }
    for (const hostile of nearbyHostiles) {
      logEvent(context, `[DANGER_DETECTED] type=mob pos=${formatPos(hostile.position)} severity=8`)
      this.recordDanger(context, { type: 'mob', name: hostile.name, position: hostile.position })
    }

    const canExplore = reasons.length === 0
    const currentExploreRadius = this.resolveCurrentExploreRadius(context, options)
    this.status = {
      ...this.status,
      explorationStatus: canExplore ? 'READY' : 'BLOCKED',
      explorationMode,
      centerPosition,
      origin: this.status.origin || centerPosition || currentPosition(context),
      radius,
      currentExploreRadius,
      distanceFromBase,
      distanceFromPlayer,
      dangerLevel: normalizeDangerLevel(dangerLevel, reasons),
      safetyState: canExplore ? 'safe' : reasons[0],
      lastFailureReason: canExplore ? this.status.lastFailureReason : reasons[0],
      lastExplorationError: canExplore ? null : reasons[0]
    }

    return {
      ok: true,
      canExplore,
      reason: reasons[0] || null,
      dangerLevel,
      healthStatus: health <= this.options.lowHealthThreshold ? 'low' : 'ok',
      foodStatus: food <= this.options.lowFoodThreshold ? 'low' : 'ok',
      inventoryStatus: emptySlots != null && emptySlots <= this.options.inventoryEmptySlotThreshold ? 'full' : 'ok',
      distanceFromBase,
      distanceFromPlayer,
      nearbyHostiles,
      needsReturn: reasons.some(reason => ['danger_too_high', 'health_low', 'food_low', 'inventory_full', 'night_without_strategy', 'too_far_from_base', 'too_far_from_player'].includes(reason)),
      radius,
      currentExploreRadius,
      explorationMode,
      centerPosition,
      safetyState: canExplore ? 'safe' : reasons[0]
    }
  }

  findNextExploreTarget(context, options = {}) {
    const state = this.inspectExplorationState(context, options)
    if (!state.canExplore) return this.fail(state.reason || 'cannot_explore')

    const targetDistance = state.explorationMode === 'directional'
      ? Math.min(
          Number(options.directionalStepDistance || this.options.directionalStepDistance),
          Number(options.maxDirectionalDistance || this.options.maxDirectionalDistance)
        )
      : state.currentExploreRadius
    const directionIndex = this.status.directionIndex || 0
    const directionVector = state.explorationMode === 'directional'
      ? normalizeDirectionVector(options.directionVector || directionVectorFromName(options.direction || options.target))
      : null
    const origin = state.explorationMode === 'directional'
      ? currentPosition(context)
      : state.centerPosition || state.origin || currentPosition(context)
    const target = exploreActions.findSafeExplorePoint(context, {
      radius: state.radius,
      minExploreDistance: options.minExploreDistance || this.options.minExploreDistance,
      maxExploreDistance: targetDistance,
      targetDistance,
      radiusStep: options.radiusStep || this.options.radiusStep,
      origin,
      directionIndex: state.explorationMode === 'directional' ? directionIndexFromVector(directionVector) : directionIndex,
      directionSectors: options.sectorCount || options.directionSectors || this.options.sectorCount || this.options.directionSectors,
      targetCooldownMs: options.visitedCooldownMs || options.targetCooldownMs || this.options.visitedCooldownMs || this.options.targetCooldownMs,
      visitedTargets: this.status.visitedTargets,
      maxDistanceFromBase: options.maxDistanceFromBase || this.options.maxDistanceFromBase,
      maxDistanceFromPlayer: options.maxDistanceFromPlayer || this.options.maxDistanceFromPlayer,
      ...options
    })
    if (!target.ok) {
      this.noteExploreFailure(context, target.error || 'safe_explore_point_not_found')
      return this.fail(target.error)
    }

    this.status.currentTarget = target.data.position
    this.status.targetPosition = target.data.position
    this.status.targetDistance = target.data.targetDistance || distanceBetween(state.origin || currentPosition(context), target.data.position)
    this.status.currentSector = target.data.directionIndex ?? directionIndex
    this.status.directionVector = directionVector
    this.status.ringIndex = state.explorationMode === 'ring' ? Math.max(0, Math.floor((this.status.currentExploreRadius - this.options.ringStartRadius) / this.options.ringRadiusStep)) : this.status.ringIndex
    this.status.explorationStatus = 'TARGET_FOUND'
    this.status.lastExplorationError = null
    logEvent(context, `[EXPLORE_TARGET_DISTANCE] distance=${Math.round(this.status.targetDistance || 0)} radius=${this.status.currentExploreRadius} direction=${target.data.directionLabel || directionIndex}`)
    logEvent(context, `[EXPLORE_DIRECTION_SELECTED] sector=${target.data.directionIndex ?? directionIndex} reason=${target.data.reason || 'sector_rotation_unexplored'}`)
    return { ok: true, target: target.data.position, radius: state.radius }
  }

  async exploreOnce(context, options = {}) {
    const state = this.inspectExplorationState(context, options)
    if (!state.canExplore) return this.fail(state.reason || 'cannot_explore')
    if (state.explorationMode === 'directional') {
      return this.exploreDirectional(context, options, state)
    }

    let target = null
    let moved = null
    const maxAttempts = Number(options.maxMoveTargetAttempts || this.options.maxMoveTargetAttempts || 2)
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      target = this.findNextExploreTarget(context, options)
      if (!target.ok) return target

      logEvent(context, `[PATH_TO_EXPLORE_START] pos=${formatPos(target.target)}`)
      moved = await exploreActions.moveToExplorePoint(context, target.target, {
        owner: options.owner,
        timeoutMs: options.timeoutMs || 15000
      })
      if (moved.ok) break

      logEvent(context, `[PATH_TO_EXPLORE_FAILED] reason=${moved.error || 'move_failed'}`)
      this.noteExploreFailure(context, moved.error || 'move_failed')
      if (attempt < maxAttempts) logEvent(context, `[EXPLORE_RETARGET] attempt=${attempt + 1} reason=${moved.error || 'move_failed'}`)
    }

    if (!moved?.ok) return this.fail(moved?.error || 'move_failed')
    logEvent(context, '[PATH_TO_EXPLORE_SUCCESS]')

    const exploredPoint = {
      position: target.target,
      visitedAt: new Date().toISOString()
    }
    this.status.exploredPoints = [...this.status.exploredPoints, exploredPoint]
    this.status.visitedTargets = rememberVisitedTarget(this.status.visitedTargets, target.target, this.options.targetCooldownMs)
    this.status.explorationStatus = 'MOVED'
    const scanned = this.scanAndRecord(context, options)
    if (!scanned.ok) return scanned

    this.recordExploredArea(context, target.target, target.radius, scanned)
    this.noteExploreSuccess(context)
    this.status.explorationStatus = 'COMPLETED'
    return { ok: true, target: target.target, scan: scanned, status: this.getStatus() }
  }

  async exploreDirectional(context, options = {}, initialState = null) {
    const directionVector = normalizeDirectionVector(options.directionVector || directionVectorFromName(options.direction || options.target)) || { x: 1, z: 0 }
    const stepDistance = Number(options.directionalStepDistance || this.options.directionalStepDistance)
    const maxDistance = Number(options.maxDirectionalDistance || this.options.maxDirectionalDistance)
    const maxCheckpoints = Math.max(1, Math.floor(maxDistance / Math.max(1, stepDistance)))
    const startPosition = currentPosition(context)
    if (!startPosition) return this.fail('missing_bot_position')
    let lastTarget = null
    let lastScan = { ok: true, discoveredPlaces: [], dangerZones: [] }

    this.status.directionVector = directionVector
    this.status.maxDirectionalDistance = maxDistance

    for (let checkpoint = 1; checkpoint <= maxCheckpoints; checkpoint += 1) {
      const state = checkpoint === 1 && initialState ? initialState : this.inspectExplorationState(context, options)
      if (!state.canExplore) {
        this.noteExploreFailure(context, state.reason || 'unsafe_checkpoint')
        return this.fail(state.reason || 'unsafe_checkpoint')
      }

      const targetDistance = Math.min(stepDistance, maxDistance - (checkpoint - 1) * stepDistance)
      const totalDistance = stepDistance * (checkpoint - 1) + targetDistance
      const target = {
        x: Math.round(startPosition.x + directionVector.x * totalDistance),
        y: Math.round(startPosition.y),
        z: Math.round(startPosition.z + directionVector.z * totalDistance)
      }
      this.status.checkpointIndex = checkpoint
      this.status.currentTarget = target
      this.status.targetPosition = target
      this.status.targetDistance = Math.round(totalDistance * 100) / 100
      this.status.currentSector = directionIndexFromVector(directionVector)
      this.status.explorationStatus = 'CHECKPOINT_TARGET_FOUND'
      logEvent(context, `[DIRECTIONAL_CHECKPOINT] index=${checkpoint} target=${formatPos(target)} step=${targetDistance} total=${totalDistance} max=${maxDistance}`)

      if (isVisitedRecently(this.status.visitedTargets, target, options, this.options)) {
        this.noteExploreFailure(context, 'visited_cooldown')
        return this.fail('visited_cooldown')
      }

      const moved = await exploreActions.moveToExplorePoint(context, target, {
        owner: options.owner,
        timeoutMs: options.timeoutMs || 15000,
        range: options.range || 2
      })
      if (!moved.ok) {
        logEvent(context, `[DIRECTIONAL_CHECKPOINT_FAILED] index=${checkpoint} reason=${moved.error || 'move_failed'}`)
        this.noteExploreFailure(context, moved.error || 'move_failed')
        return this.fail(moved.error || 'move_failed')
      }

      lastTarget = target
      this.status.exploredPoints = [...this.status.exploredPoints, {
        position: target,
        visitedAt: new Date().toISOString(),
        checkpointIndex: checkpoint
      }]
      this.status.visitedTargets = rememberVisitedTarget(this.status.visitedTargets, target, this.options.visitedCooldownMs || this.options.targetCooldownMs)
      lastScan = this.scanAndRecord(context, options)
      if (!lastScan.ok) return lastScan
      this.recordExploredArea(context, target, options.safeCheckpointDistance || this.options.safeCheckpointDistance, lastScan)
    }

    this.noteExploreSuccess(context)
    this.status.explorationStatus = 'COMPLETED'
    return { ok: true, target: lastTarget, scan: lastScan, status: this.getStatus(), checkpoints: maxCheckpoints }
  }

  scanAndRecord(context, options = {}) {
    logEvent(context, '[DANGER_SCAN_START]')
    const radius = options.scanRadius || this.status.radius || this.options.defaultRadius
    const blocks = exploreActions.scanNearbyBlocks(context, radius)
    const entities = exploreActions.scanNearbyEntities(context, radius)
    if (!blocks.ok && !entities.ok) return this.fail(blocks.error || entities.error || 'scan_failed')

    const discoveredPlaces = []
    const dangerZones = []

    const scannedBlocks = blocks.ok ? blocks.data.blocks : []
    const scannedEntities = entities.ok ? entities.data.entities : []

    for (const block of scannedBlocks) {
      if (block.category === 'resource') {
        const place = this.recordPlace(context, {
          type: 'resource_area',
          name: block.name,
          position: block.position,
          tags: ['exploration', 'resource']
        })
        if (place) {
          discoveredPlaces.push(place)
          context.memory?.world?.addMineLocation?.(block.position, {
            type: 'resource_area',
            name: block.name,
            source: 'exploration_system'
          })
        }
      } else if (block.category === 'danger') {
        const dangerType = block.name === 'lava' ? 'lava' : 'block'
        logEvent(context, `[DANGER_DETECTED] type=${dangerType} pos=${formatPos(block.position)} severity=9`)
        this.updateDangerLevel(context, 'high', dangerType)
        const danger = this.recordDanger(context, {
          type: block.name === 'lava' ? 'lava' : 'unknown_danger',
          name: block.name,
          position: block.position
        })
        if (danger) dangerZones.push(danger)
      } else if (block.category === 'water') {
        logEvent(context, `[DANGER_DETECTED] type=water pos=${formatPos(block.position)} severity=4`)
        const danger = this.recordDanger(context, {
          type: 'water',
          name: 'water',
          position: block.position,
          tags: ['exploration', 'danger', 'water']
        })
        if (danger) dangerZones.push(danger)
        const place = this.recordPlace(context, {
          type: 'water',
          name: 'water',
          position: block.position,
          tags: ['exploration', 'water']
        })
        if (place) discoveredPlaces.push(place)
      } else if (block.category === 'structure') {
        const place = this.recordPlace(context, {
          type: structureType(block.name),
          name: block.name,
          position: block.position,
          tags: ['exploration', 'structure']
        })
        if (place) discoveredPlaces.push(place)
      }
    }

    for (const landmark of detectGeneratedStructures(context, scannedBlocks, scannedEntities)) {
      const place = this.recordPlace(context, {
        type: landmark.type,
        name: landmark.type,
        position: landmark.position,
        tags: ['exploration', 'generated_structure', 'landmark'],
        confidence: landmark.confidence,
        evidence: landmark.evidence,
        source: 'exploration'
      })
      if (place) {
        discoveredPlaces.push(place)
        this.status.recentDiscoveredPlaces = [place, ...(this.status.recentDiscoveredPlaces || [])].slice(0, 5)
        context.blackboard?.set?.('messages.lastLandmarkDetected', {
          type: 'landmarkDetected',
          place,
          evidence: landmark.evidence,
          source: 'exploration'
        })
        logEvent(context, `[LANDMARK_DETECTED] type=${landmark.type} confidence=${landmark.confidence} pos=${formatPos(landmark.position)} evidence=${landmark.evidence.join(',')}`)
      }
    }

    for (const hostile of entities.ok ? entities.data.nearbyHostiles : []) {
      logEvent(context, `[DANGER_DETECTED] type=mob pos=${formatPos(hostile.position)} severity=8`)
      this.updateDangerLevel(context, 'high', 'mob')
      const danger = this.recordDanger(context, {
        type: 'mob',
        name: hostile.name,
        position: hostile.position
      })
      if (danger) dangerZones.push(danger)
    }

    for (const entity of scannedEntities) {
      if (entity.hostile || !isAnimal(entity.name)) continue
      const place = this.recordPlace(context, {
        type: 'animals',
        name: entity.name,
        position: entity.position,
        tags: ['exploration', 'animals'],
        confidence: 0.75
      })
      if (place) discoveredPlaces.push(place)
    }

    this.status = {
      ...this.status,
      discoveredPlaces: mergeById(this.status.discoveredPlaces, discoveredPlaces),
      dangerZones: mergeById(this.status.dangerZones, dangerZones),
      explorationStatus: 'SCANNED',
      lastExplorationError: null
    }

    return { ok: true, discoveredPlaces, dangerZones }
  }

  shouldStopExploring(context, options = {}) {
    const state = this.inspectExplorationState(context, options)
    return {
      ok: true,
      shouldStop: !state.canExplore || state.needsReturn,
      reason: state.reason,
      state
    }
  }

  returnFromExploration(context, options = {}) {
    const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
    if (hasBase && options.preferPlayer !== true) {
      const task = context.taskManager?.enqueue?.('return_to_base', {}, options.priority || 7, 'exploration_system')
      return task ? { ok: true, action: 'return_to_base', task } : this.fail('task_manager_missing')
    }
    const task = context.taskManager?.enqueue?.('return_to_player', {}, options.priority || 7, 'exploration_system')
    return task ? { ok: true, action: 'return_to_player', task } : this.fail('task_manager_missing')
  }

  checkExploredAreas(context) {
    const memory = context.memory?.world?.list?.() || {}
    this.status.explorationStatus = 'CHECKED_MEMORY'
    return {
      ok: true,
      exploredAreas: memory.exploredAreas || [],
      importantPlaces: memory.importantPlaces || [],
      dangerZones: memory.dangerZones || [],
      mineLocations: memory.mineLocations || []
    }
  }

  recordExploredArea(context, center, radius, scanned) {
    const notes = []
    if (scanned.discoveredPlaces?.length) notes.push(`found_places:${scanned.discoveredPlaces.length}`)
    if (scanned.dangerZones?.length) notes.push(`danger_zones:${scanned.dangerZones.length}`)
    const record = context.memory?.world?.addExploredArea?.(center, {
      radius,
      notes,
      source: 'exploration_system'
    })
    if (record) {
      logEvent(context, `[EXPLORED_AREA_RECORDED] center=${formatPos(center)} radius=${radius}`)
      logEvent(context, `[MEMORY_WRITE] key=exploredAreas value=${safeJson(record)}`)
    }
    return record || null
  }

  recordPlace(context, place) {
    const recorded = exploreActions.recordDiscoveredPlace(context, place)
    return recorded.ok ? recorded.data.record : null
  }

  recordDanger(context, danger) {
    const recorded = exploreActions.recordDangerZone(context, danger)
    return recorded.ok ? recorded.data.record : null
  }

  resolveRadius(context, options = {}) {
    const requested = Number(options.radius) || (
      options.mode === 'SCOUT_AREA' ? this.options.scoutRadius :
        options.mode === 'FIND_RESOURCE_AREA' || options.mode === 'FIND_PLACE_OR_RESOURCE' ? this.options.resourceRadius :
          this.options.defaultRadius
    )
    const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
    const maxRadius = hasBase ? requested : Math.min(requested, this.options.noBaseMaxRadius)
    const safeMode = context.blackboard?.get?.('survival.safeModeEnabled') === true
    const adjusted = safeMode ? Math.min(maxRadius, Math.ceil(maxRadius / 2)) : maxRadius
    return Math.max(4, Math.min(requested, adjusted))
  }

  resolveCurrentExploreRadius(context, options = {}) {
    const maxRadius = this.resolveMaxExploreDistance(context, options)
    const ringStart = Number(options.ringStartRadius || this.options.ringStartRadius)
    const minRadius = Math.min(maxRadius, Number(options.minExploreDistance || ringStart || this.options.minExploreDistance) || 24)
    const desired = Number(options.currentExploreRadius || options.explorationRadius || this.status.currentExploreRadius || ringStart || this.options.explorationRadius)
    return clamp(Math.max(desired, minRadius), minRadius, maxRadius)
  }

  resolveMaxExploreDistance(context, options = {}) {
    const mode = resolveExplorationMode(options, this.options)
    const requested = Number(
      mode === 'directional'
        ? options.maxDirectionalDistance || this.options.maxDirectionalDistance
        : options.maxRingRadius || options.maxExploreDistance || options.explorationRadius || options.radius || this.options.maxRingRadius || this.options.maxExploreDistance
    )
    const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
    const noBaseMax = Number(options.noBaseMaxRadius || this.options.noBaseMaxRadius) || 48
    const safeMode = context.blackboard?.get?.('survival.safeModeEnabled') === true || options.safeMode === true
    const safeCap = safeMode ? 64 : requested
    return Math.max(8, Math.min(requested, hasBase ? safeCap : Math.min(noBaseMax, safeCap)))
  }

  noteExploreSuccess(context) {
    const step = Number(this.options.ringRadiusStep || this.options.radiusStep) || 16
    const previous = this.status.currentExploreRadius || this.options.ringStartRadius || this.options.explorationRadius
    const next = Math.min(this.resolveMaxExploreDistance(context, {}), previous + step)
    this.status.successfulExploreCount += 1
    this.status.failedTargetCount = 0
    this.status.lastFailureReason = null
    this.status.currentExploreRadius = next
    this.status.directionIndex = ((this.status.directionIndex || 0) + 1) % (this.options.sectorCount || this.options.directionSectors)
    this.status.currentSector = this.status.directionIndex
    this.status.ringIndex = Math.max(0, Math.floor((next - this.options.ringStartRadius) / this.options.ringRadiusStep))
    this.status.safetyState = 'safe'
    if (next > previous) logEvent(context, `[EXPLORE_RADIUS_EXPAND] from=${previous} to=${next} reason=success`)
  }

  noteExploreFailure(context, reason) {
    const step = Number(this.options.ringRadiusStep || this.options.radiusStep) || 16
    const failed = (this.status.failedTargetCount || 0) + 1
    this.status.failedTargetCount = failed
    this.status.lastFailureReason = reason
    this.status.safetyState = reason
    this.status.directionIndex = ((this.status.directionIndex || 0) + 1) % (this.options.sectorCount || this.options.directionSectors)
    this.status.currentSector = this.status.directionIndex
    if (failed >= this.options.maxFailedTargetsBeforeShrink || isSafetyFailure(reason)) {
      const previous = this.status.currentExploreRadius || this.options.explorationRadius
      const next = Math.max(this.options.ringStartRadius || this.options.minExploreDistance, previous - step)
      this.status.currentExploreRadius = next
      this.status.ringIndex = Math.max(0, Math.floor((next - this.options.ringStartRadius) / this.options.ringRadiusStep))
      this.status.failedTargetCount = 0
      logEvent(context, `[EXPLORE_RADIUS_SHRINK] from=${previous} to=${next} reason=${reason}`)
    }
  }

  updateDangerLevel(context, level, reason) {
    this.status.dangerLevel = level
    logEvent(context, `[DANGER_LEVEL_UPDATE] level=${level} reason=${reason}`)
  }

  fail(error, extra = {}) {
    this.status = {
      ...this.status,
      explorationStatus: 'FAILED',
      lastExplorationError: error,
      ...extra
    }
    return { ok: false, error, ...extra }
  }

  getStatus() {
    return { ...this.status }
  }
}

function structureType(blockName) {
  if (blockName === 'farmland' || blockName === 'hay_block') return 'farm_nearby'
  if (blockName === 'chest' || blockName === 'bell') return 'interesting_structure'
  if (String(blockName || '').endsWith('_log')) return 'trees'
  return 'interesting_structure'
}

function detectGeneratedStructures(context, blocks = [], entities = []) {
  const byName = new Map()
  for (const block of blocks) byName.set(block.name, [...(byName.get(block.name) || []), block])
  const names = new Set(blocks.map(block => block.name))
  const biome = String(context.blackboard?.get?.('world.currentBiome') || context.worldState?.world?.currentBiome || '').toLowerCase()
  const current = currentPosition(context) || blocks[0]?.position || { x: 0, y: 64, z: 0 }
  const found = []

  const sandstoneCount = countNames(byName, ['sandstone', 'smooth_sandstone', 'cut_sandstone', 'chiseled_sandstone'])
  const terracottaCount = countNames(byName, ['orange_terracotta', 'blue_terracotta'])
  if (sandstoneCount >= 2 && terracottaCount >= 1) {
    const evidence = ['sandstone', 'terracotta']
    if (biome.includes('desert')) evidence.push('desert_biome')
    found.push(landmark('probable_desert_temple', current, confidence(0.62, evidence), evidence))
  }

  if (hasAnyBlock(names, ['bell', 'bed', 'white_bed', 'composter', 'cartography_table', 'smithing_table', 'fletching_table', 'grindstone', 'dirt_path']) ||
    entities.some(entity => entity.name === 'villager')) {
    found.push(landmark('village', current, 0.7, ['village_blocks_or_villagers']))
  }

  if (hasAnyBlock(names, ['obsidian', 'crying_obsidian']) && hasAnyBlock(names, ['netherrack', 'magma_block', 'gold_block'])) {
    found.push(landmark('ruined_portal', current, 0.78, ['obsidian', 'nether_blocks']))
  }

  if (hasAnyBlock(names, ['rail', 'cobweb']) && hasAnyBlock(names, ['oak_planks', 'oak_fence']) && current.y < 50) {
    found.push(landmark('mineshaft', current, 0.74, ['rail', 'planks', 'underground']))
  }

  if (hasAnyBlock(names, ['oak_planks', 'spruce_planks', 'dark_oak_planks']) && hasAnyBlock(names, ['chest']) && (biome.includes('ocean') || biome.includes('beach'))) {
    found.push(landmark('shipwreck', current, 0.68, ['planks', 'chest', 'ocean_or_beach']))
  }

  if (hasAnyBlock(names, ['mossy_cobblestone', 'tripwire_hook']) && hasAnyBlock(names, ['jungle_log', 'jungle_planks'])) {
    found.push(landmark('jungle_temple', current, 0.66, ['jungle_blocks', 'temple_traps']))
  }

  return dedupeLandmarks(found)
}

function landmark(type, position, confidenceValue, evidence) {
  return { type, position, confidence: Math.round(confidenceValue * 100) / 100, evidence }
}

function confidence(base, evidence) {
  return Math.min(0.9, base + Math.max(0, evidence.length - 2) * 0.1)
}

function countNames(byName, names) {
  return names.reduce((sum, name) => sum + (byName.get(name)?.length || 0), 0)
}

function hasAnyBlock(names, candidates) {
  return candidates.some(name => names.has(name))
}

function dedupeLandmarks(items) {
  const seen = new Set()
  return items.filter(item => {
    if (seen.has(item.type)) return false
    seen.add(item.type)
    return true
  })
}

function isAnimal(name) {
  return ['cow', 'pig', 'sheep', 'chicken', 'horse', 'rabbit'].includes(String(name || ''))
}

function mergeById(existing, next) {
  const map = new Map()
  for (const item of [...(existing || []), ...(next || [])]) {
    if (item?.id) map.set(item.id, item)
  }
  return [...map.values()]
}

function rememberVisitedTarget(existing, position, cooldownMs) {
  const now = Date.now()
  const kept = (existing || []).filter(item => now - Number(item.visitedAtMs || 0) <= cooldownMs)
  kept.push({
    position,
    visitedAtMs: now,
    visitedAt: new Date(now).toISOString()
  })
  return kept.slice(-64)
}

function isVisitedRecently(existing, position, options = {}, defaults = {}) {
  const cooldownMs = Number(options.visitedCooldownMs || options.targetCooldownMs || defaults.visitedCooldownMs || defaults.targetCooldownMs || 10 * 60 * 1000)
  const minDistance = Number(options.minDistanceBetweenExploreTargets || defaults.minDistanceBetweenExploreTargets || 16)
  const now = Date.now()
  return (existing || []).some(item => now - Number(item.visitedAtMs || 0) <= cooldownMs && distanceBetween(item.position, position) < minDistance)
}

function resolveExplorationMode(options = {}, defaults = {}) {
  if (options.explorationMode === 'directional' || options.mode === 'DIRECTIONAL_EXPLORE') return 'directional'
  if (options.direction || options.directionVector || options.maxDirectionalDistance) return 'directional'
  return options.explorationMode || defaults.explorationMode || 'ring'
}

function resolveCenterPosition(context, options = {}) {
  if (options.centerPosition) return options.centerPosition
  const base = context.memory?.world?.baseLocation?.position || context.memory?.world?.baseLocation
  if (base) return base
  return context.blackboard?.get?.('player.ownerPosition') ||
    context.blackboard?.get?.('player.nearestPlayer.position') ||
    currentPosition(context)
}

function directionVectorFromName(direction) {
  const normalized = String(direction || '').toLowerCase()
  const map = {
    east: { x: 1, z: 0 },
    west: { x: -1, z: 0 },
    south: { x: 0, z: 1 },
    north: { x: 0, z: -1 },
    desert: { x: 1, z: 0 },
    forward: { x: 1, z: 0 },
    东: { x: 1, z: 0 },
    西: { x: -1, z: 0 },
    南: { x: 0, z: 1 },
    北: { x: 0, z: -1 }
  }
  for (const [key, value] of Object.entries(map)) {
    if (normalized.includes(key)) return value
  }
  return null
}

function normalizeDirectionVector(vector) {
  if (!vector) return null
  const x = Number(vector.x || 0)
  const z = Number(vector.z || 0)
  const length = Math.sqrt(x * x + z * z)
  if (!length) return null
  return { x: x / length, z: z / length }
}

function directionIndexFromVector(vector) {
  if (!vector) return 0
  const angle = Math.atan2(vector.z, vector.x)
  const normalized = angle < 0 ? angle + Math.PI * 2 : angle
  return Math.round(normalized / (Math.PI * 2 / 8)) % 8
}

function isSafetyFailure(reason) {
  return ['danger_too_high', 'health_low', 'food_low', 'hostile_nearby', 'night_without_strategy'].some(item => String(reason || '').includes(item))
}

function distanceBetween(a, b) {
  if (!a || !b) return null
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function currentPosition(context) {
  const position = context.blackboard?.get?.('bot.position') || context.bot?.entity?.position || context.worldState?.bot?.position
  if (!position) return null
  return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) }
}

function normalizeDangerLevel(dangerLevel, reasons) {
  if (['critical', 'high'].includes(dangerLevel)) return 'high'
  if (reasons.includes('hostile_nearby') || reasons.includes('night_without_strategy')) return 'medium'
  return 'low'
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

module.exports = {
  ExplorationSystem
}
