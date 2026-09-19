const { DEFAULT_FARM_SCAN_RADIUS } = require('../systems/farming-system')

class MinecraftScenarioBuilder {
  constructor(adapter) {
    this.adapter = adapter
    this.config = adapter.config.fixture || {}
  }

  async prepare(feature, options = {}) {
    if (feature === 'following') return this.prepareFollowing(options)
    if (feature === 'farming') return this.prepareFarming(options)
    if (feature === 'storage') return this.prepareStorage(options)
    return this.blocked(feature, 'unknown_fixture_feature')
  }

  async prepareFollowing(options = {}) {
    const snapshot = await this.adapter.snapshot({ ...options, includeDebugStatus: true })
    if (snapshot.companionPosition) {
      const maxReadyDistance = this.adapter.config.follow?.maxFollowDistance || this.config.setupRadius || 6
      const entityVisible = snapshot.companionPositionSource === 'entity' && snapshot.configuredAiVisible
      if (!entityVisible && snapshot.distancePlayerToAi != null && snapshot.distancePlayerToAi > maxReadyDistance) {
        return this.blocked('following', 'ai_too_far_for_following_test', snapshot)
      }
      return {
        setupStatus: 'READY',
        fixtureStatus: {
          feature: 'following',
          ready: true,
          reason: entityVisible && snapshot.distancePlayerToAi > maxReadyDistance
            ? 'companion_entity_visible_far_but_testable'
            : (snapshot.companionPositionSource === 'debug_status' ? 'companion_position_from_debug_status' : 'companion_visible'),
          maxReadyDistance,
          companionLookup: snapshot.companionLookup,
          acceptancePlayerPosition: snapshot.acceptancePlayerPosition,
          companionPosition: snapshot.companionPosition,
          companionPositionSource: snapshot.companionPositionSource,
          companionPositionFromDebug: Boolean(snapshot.companionPositionFromDebug),
          distancePlayerToAi: snapshot.distancePlayerToAi,
          recommendedTeleportCommand: snapshot.recommendedTeleportCommand,
          debugStatusAvailable: snapshot.debugStatusAvailable
        },
        snapshot
      }
    }
    return this.blocked('following', snapshot.companionLookup?.blockedReason || 'companion_not_visible', snapshot)
  }

  async prepareFarming(options = {}) {
    const scanRadius = options.scanRadius || this.adapter.config.farming?.scanRadius || 16
    const taskScanRadius = this.farmingTaskScanRadius(options)
    const minMatureWheat = this.adapter.config.farming?.minMatureWheatForBatchCheck || 2
    let snapshot = await this.adapter.snapshot({ ...options, scanRadius, companionScanRadius: taskScanRadius, includeDebugStatus: true })
    let companionReadiness = this.farmingCompanionReadiness(snapshot, taskScanRadius, minMatureWheat)
    if (companionReadiness.fixtureReadyForCompanion) {
      return {
        setupStatus: 'READY',
        fixtureStatus: this.readyFixtureStatus('farming', 'existing_mature_wheat_near_companion', snapshot, companionReadiness),
        snapshot
      }
    }

    let companionAlignmentResult = null
    companionAlignmentResult = await this.tryAlignCompanionForFarming(snapshot).catch(err => ({ attempted: true, mode: 'teleport_command', error: err.message }))
    if (companionAlignmentResult?.attempted) {
      snapshot = await this.adapter.snapshot({ ...options, scanRadius, companionScanRadius: taskScanRadius, includeDebugStatus: true })
      companionAlignmentResult.afterCompanionPosition = snapshot.companionPosition
      companionAlignmentResult.afterAcceptancePlayerPosition = snapshot.acceptancePlayerPosition
      companionAlignmentResult.afterDistancePlayerToAi = snapshot.distancePlayerToAi
      companionReadiness = this.farmingCompanionReadiness(snapshot, taskScanRadius, minMatureWheat)
      if (companionReadiness.fixtureReadyForCompanion) {
        return {
          setupStatus: 'READY',
          fixtureStatus: this.readyFixtureStatus('farming', 'existing_mature_wheat_after_companion_alignment', snapshot, {
            companionAlignmentResult,
            ...companionReadiness
          }),
          snapshot
        }
      }
    }

    let commandResult = null
    if (this.allowCommandFixtures()) {
      commandResult = await this.tryBuildFarmingFixture(snapshot).catch(err => ({ attempted: true, mode: 'command', error: err.message }))
      snapshot = await this.adapter.snapshot({ ...options, scanRadius, companionScanRadius: taskScanRadius, includeDebugStatus: true })
      companionReadiness = this.farmingCompanionReadiness(snapshot, taskScanRadius, minMatureWheat)
      if (companionReadiness.fixtureReadyForCompanion) {
        return {
          setupStatus: 'READY',
          fixtureStatus: this.readyFixtureStatus('farming', 'command_fixture_created', snapshot, {
            fixtureType: 'command',
            commandResult,
            companionAlignmentResult,
            ...companionReadiness
          }),
          snapshot
        }
      }
    }

    let creativeResult = null
    if (this.allowCreativeFixtures()) {
      creativeResult = await this.tryBuildCreativeFarmingFixture(snapshot).catch(err => ({ attempted: true, mode: 'creative', error: err.message }))
      snapshot = await this.adapter.snapshot({ ...options, scanRadius, companionScanRadius: taskScanRadius, includeDebugStatus: true })
      companionReadiness = this.farmingCompanionReadiness(snapshot, taskScanRadius, minMatureWheat)
      if (companionReadiness.fixtureReadyForCompanion) {
        return {
          setupStatus: 'READY',
          fixtureStatus: this.readyFixtureStatus('farming', 'creative_fixture_created', snapshot, {
            fixtureType: 'creative',
            creativeResult,
            commandResult,
            companionAlignmentResult,
            ...companionReadiness,
            seedChest: creativeResult?.seedChest || null
          }),
          snapshot
        }
      }
    }

    const reason = commandResult || creativeResult
      ? 'fixture_attempts_did_not_create_companion_reachable_mature_wheat'
      : (companionReadiness.matureWheatCount > 0 ? 'mature_wheat_not_in_companion_scan' : 'mature_wheat_fixture_missing')
    return this.blocked('farming', reason, snapshot, { commandResult, creativeResult, companionReadiness, companionAlignmentResult })
  }

  async prepareStorage(options = {}) {
    const scanRadius = options.scanRadius || this.adapter.config.storage?.scanRadius || 16
    let snapshot = await this.adapter.snapshot({ ...options, scanRadius, includeDebugStatus: true })
    const actorAlignment = await this.ensureStorageActorsAligned(snapshot, scanRadius)
    snapshot = actorAlignment.snapshot || snapshot
    if (!actorAlignment.ok) {
      return this.blocked('storage', actorAlignment.reason, snapshot, {
        companionAlignmentResult: actorAlignment,
        companionReadiness: this.storageReadinessFromSnapshot(snapshot, scanRadius, actorAlignment)
      })
    }

    let readiness = await this.storageReadiness(snapshot, scanRadius, { actorAlignment })
    if (readiness.ready) {
      return {
        setupStatus: 'READY',
        fixtureStatus: this.readyFixtureStatus('storage', 'existing_seed_chest', snapshot, readiness),
        snapshot
      }
    }

    let commandResult = null
    if (this.allowCommandFixtures() || this.canUseStorageCommandFixture(actorAlignment)) {
      commandResult = await this.tryBuildStorageFixture(snapshot).catch(err => ({ attempted: true, mode: 'command', error: err.message }))
      snapshot = await this.adapter.snapshot({ ...options, scanRadius, includeDebugStatus: true })
      readiness = await this.storageReadiness(snapshot, scanRadius, { actorAlignment, commandResult })
      if (readiness.ready) {
        return {
          setupStatus: 'READY',
          fixtureStatus: this.readyFixtureStatus('storage', 'command_fixture_created', snapshot, {
            fixtureType: 'command',
            commandResult,
            ...readiness
          }),
          snapshot
        }
      }
    }

    let creativeResult = null
    if (this.allowCreativeFixtures()) {
      creativeResult = await this.tryBuildCreativeStorageFixture(snapshot).catch(err => ({ attempted: true, mode: 'creative', error: err.message }))
      snapshot = await this.adapter.snapshot({ ...options, scanRadius, includeDebugStatus: true })
      readiness = await this.storageReadiness(snapshot, scanRadius, { actorAlignment, commandResult, creativeResult })
      if (readiness.ready) {
        return {
          setupStatus: 'READY',
          fixtureStatus: this.readyFixtureStatus('storage', 'creative_fixture_created', snapshot, {
            fixtureType: 'creative',
            commandResult,
            creativeResult,
            ...readiness
          }),
          snapshot
        }
      }
    }

    const reason = commandResult?.commandDenied
      ? 'command_denied'
      : (readiness.reason || 'chest_not_found_nearby')
    return this.blocked('storage', reason, snapshot, {
      commandResult,
      creativeResult,
      companionReadiness: readiness,
      companionAlignmentResult: actorAlignment
    })
  }

  async tryBuildFarmingFixture(snapshot = null) {
    const base = this.fixtureBase(this.fixtureAnchorForCompanion(snapshot))
    const commands = [
      `setblock ${base.x} ${base.groundY} ${base.z} minecraft:farmland`,
      `setblock ${base.x} ${base.cropY} ${base.z} minecraft:wheat[age=7]`,
      `setblock ${base.x + 1} ${base.groundY} ${base.z} minecraft:farmland`,
      `setblock ${base.x + 1} ${base.cropY} ${base.z} minecraft:wheat[age=7]`,
      `setblock ${base.x + 2} ${base.groundY} ${base.z} minecraft:farmland`,
      `setblock ${base.x + 2} ${base.cropY} ${base.z} minecraft:air`,
      `give ${this.adapter.aiUsername()} minecraft:wheat_seeds 16`
    ]
    return this.runCommands(commands)
  }

  async tryBuildStorageFixture(snapshot = null) {
    const chest = this.storageFixtureChestPosition(snapshot)
    const chestX = chest.x
    const chestY = chest.y
    const chestZ = chest.z
    const commands = [
      `setblock ${chestX} ${chestY - 1} ${chestZ} minecraft:stone`,
      `setblock ${chestX} ${chestY + 1} ${chestZ} minecraft:air`,
      `setblock ${chestX} ${chestY} ${chestZ} minecraft:chest`,
      `data merge block ${chestX} ${chestY} ${chestZ} {Items:[{Slot:0b,id:"minecraft:wheat_seeds",Count:16b}]}`,
      `item replace block ${chestX} ${chestY} ${chestZ} container.0 with minecraft:wheat_seeds 16`
    ]
    const result = await this.runCommands(commands)
    return {
      ...result,
      fixtureChestPos: chest
    }
  }

  async tryBuildCreativeFarmingFixture(snapshot = null) {
    const base = this.fixtureBase(this.fixtureAnchorForCompanion(snapshot))
    const farm = await this.adapter.prepareCreativeWheatFarm(base)
    const seedChest = await this.adapter.prepareCreativeSeedChest(this.fixtureChestPosition(base), 16)
    return {
      attempted: true,
      mode: 'creative',
      fixtureCreatedBy: this.adapter.testUsername(),
      linxiaUsedCommands: false,
      farm,
      seedChest
    }
  }

  async tryBuildCreativeStorageFixture(snapshot = null) {
    const fixtureChestPos = this.fixtureChestPosition(this.fixtureAnchorForStorage(snapshot))
    const seedChest = await this.adapter.prepareCreativeSeedChest(fixtureChestPos, 16)
    return {
      attempted: true,
      mode: 'creative',
      fixtureCreatedBy: this.adapter.testUsername(),
      linxiaUsedCommands: false,
      fixtureChestPos,
      seedChest
    }
  }

  async runCommands(commands) {
    const results = []
    for (const command of commands) {
      results.push(await this.adapter.runServerCommand(command))
    }
    await this.adapter.wait(1200)
    const denied = results.find(result => result.commandDenied)
    return {
      attempted: true,
      commands: results,
      commandDenied: Boolean(denied),
      deniedMessage: denied?.deniedMessage || null
    }
  }

  canUseStorageCommandFixture(actorAlignment = null) {
    const teleport = actorAlignment?.teleport || null
    return Boolean(actorAlignment?.ok || (teleport?.attempted && !teleport.commandDenied && !teleport.error))
  }

  fixtureBase(anchor = this.adapter.bot.entity.position) {
    const pos = anchor || this.adapter.bot.entity.position
    return {
      x: Math.floor(pos.x) + 2,
      groundY: Math.floor(pos.y) - 1,
      cropY: Math.floor(pos.y),
      z: Math.floor(pos.z) + 2
    }
  }

  fixtureChestPosition(anchor = null) {
    const supported = this.adapter.findSupportedFixturePosition?.({ radius: 4, center: anchor || this.adapter.bot.entity.position })
    if (supported) return { x: supported.x, y: supported.y, z: supported.z }
    const base = this.fixtureBase(anchor || this.adapter.bot.entity.position)
    return { x: base.x, y: base.cropY, z: base.z + 2 }
  }

  storageFixtureChestPosition(snapshot = null) {
    const existing = snapshot?.chest?.ok ? snapshot.chest.position : null
    if (existing && this.distance(existing, snapshot?.acceptancePlayerPosition) <= 5 && this.distance(existing, snapshot?.companionPosition) <= 5) {
      return {
        x: Math.floor(existing.x),
        y: Math.floor(existing.y),
        z: Math.floor(existing.z)
      }
    }
    const anchor = this.fixtureAnchorForStorage(snapshot)
    return {
      x: Math.floor(anchor.x) + 2,
      y: Math.floor(anchor.y),
      z: Math.floor(anchor.z) + 2
    }
  }

  fixtureAnchorForStorage(snapshot = null) {
    return snapshot?.companionPosition || snapshot?.acceptancePlayerPosition || this.adapter.bot.entity.position
  }

  fixtureAnchorForCompanion(snapshot = null) {
    return snapshot?.companionPosition || this.adapter.observeAiPosition?.() || this.adapter.bot.entity.position
  }

  async tryAlignCompanionForFarming(snapshot = null) {
    if (!snapshot?.companionPosition) return { attempted: false, reason: 'companion_position_missing' }
    if (snapshot.distancePlayerToAi != null && snapshot.distancePlayerToAi <= 4) {
      return { attempted: false, reason: 'companion_already_near_fixture', distancePlayerToAi: snapshot.distancePlayerToAi }
    }
    const command = `tp ${this.adapter.aiUsername()} ${this.adapter.testUsername()}`
    const commandResult = await this.adapter.runServerCommand(command)
    await this.adapter.wait(1200)
    return {
      attempted: true,
      mode: 'teleport_command',
      command: commandResult.command,
      beforeCompanionPosition: snapshot.companionPosition,
      beforeAcceptancePlayerPosition: snapshot.acceptancePlayerPosition,
      beforeDistancePlayerToAi: snapshot.distancePlayerToAi
    }
  }

  async tryAlignAcceptancePlayerForStorage(snapshot = null) {
    if (!snapshot?.companionPosition) return { attempted: false, reason: 'companion_position_missing' }
    if (snapshot.distancePlayerToAi != null && snapshot.distancePlayerToAi <= 5) {
      return { attempted: false, reason: 'acceptance_player_already_near_companion', distancePlayerToAi: snapshot.distancePlayerToAi }
    }
    await this.adapter.flyNear({
      x: snapshot.companionPosition.x + 1,
      y: snapshot.companionPosition.y + 1,
      z: snapshot.companionPosition.z + 1
    })
    return {
      attempted: true,
      mode: 'acceptance_player_move',
      beforeAcceptancePlayerPosition: snapshot.acceptancePlayerPosition,
      beforeCompanionPosition: snapshot.companionPosition,
      beforeDistancePlayerToAi: snapshot.distancePlayerToAi
    }
  }

  async ensureStorageActorsAligned(snapshot, scanRadius) {
    const maxDistance = 5
    const base = {
      attempted: false,
      mode: 'storage_actor_positioning',
      beforeAcceptancePlayerPosition: snapshot?.acceptancePlayerPosition || null,
      beforeCompanionPosition: snapshot?.companionPosition || null,
      beforeDistancePlayerToAi: snapshot?.distancePlayerToAi ?? null,
      scanRadius
    }
    if (!snapshot?.companionPosition) return { ok: false, reason: snapshot?.companionLookup?.blockedReason || 'configured_ai_not_online', snapshot, ...base }
    if (snapshot.distancePlayerToAi != null && snapshot.distancePlayerToAi <= maxDistance) {
      return { ok: true, reason: 'actors_already_within_5_blocks', snapshot, ...base }
    }

    const teleport = await this.tryTeleportCompanionToTester(snapshot).catch(err => ({ attempted: true, mode: 'teleport_command', error: err.message }))
    let after = await this.adapter.snapshot({ scanRadius, includeDebugStatus: true })
    if (after.distancePlayerToAi != null && after.distancePlayerToAi <= maxDistance) {
      return {
        ok: true,
        reason: 'teleport_confirmed',
        snapshot: after,
        ...base,
        attempted: true,
        teleport,
        afterAcceptancePlayerPosition: after.acceptancePlayerPosition,
        afterCompanionPosition: after.companionPosition,
        afterDistancePlayerToAi: after.distancePlayerToAi
      }
    }

    if (teleport.commandDenied) {
      let fallback = await this.tryAlignAcceptancePlayerForStorage(after).catch(err => ({ attempted: true, mode: 'acceptance_player_move', error: err.message }))
      if (fallback?.attempted) {
        after = await this.adapter.snapshot({ scanRadius, includeDebugStatus: true })
        if (after.distancePlayerToAi != null && after.distancePlayerToAi <= maxDistance) {
          return {
            ok: true,
            reason: 'acceptance_player_aligned_after_command_denied',
            snapshot: after,
            ...base,
            attempted: true,
            teleport,
            fallback,
            afterAcceptancePlayerPosition: after.acceptancePlayerPosition,
            afterCompanionPosition: after.companionPosition,
            afterDistancePlayerToAi: after.distancePlayerToAi
          }
        }
      }
      return {
        ok: false,
        reason: 'command_denied',
        snapshot: after,
        ...base,
        attempted: true,
        teleport,
        fallback,
        afterAcceptancePlayerPosition: after.acceptancePlayerPosition,
        afterCompanionPosition: after.companionPosition,
        afterDistancePlayerToAi: after.distancePlayerToAi
      }
    }

    return {
      ok: false,
      reason: teleport.error ? 'teleport_failed' : 'actor_distance_too_far',
      snapshot: after,
      ...base,
      attempted: true,
      teleport,
      afterAcceptancePlayerPosition: after.acceptancePlayerPosition,
      afterCompanionPosition: after.companionPosition,
      afterDistancePlayerToAi: after.distancePlayerToAi
    }
  }

  async tryTeleportCompanionToTester(snapshot = null) {
    const command = `tp ${this.adapter.aiUsername()} ${this.adapter.testUsername()}`
    const commandResult = await this.adapter.runServerCommand(command)
    await this.adapter.wait(1000)
    return {
      attempted: true,
      mode: 'teleport_command',
      command: commandResult.command,
      commandDenied: Boolean(commandResult.commandDenied),
      deniedMessage: commandResult.deniedMessage || null,
      commandMessages: commandResult.messages || [],
      beforeCompanionPosition: snapshot?.companionPosition || null,
      beforeAcceptancePlayerPosition: snapshot?.acceptancePlayerPosition || null,
      beforeDistancePlayerToAi: snapshot?.distancePlayerToAi ?? null
    }
  }

  async storageReadiness(snapshot, scanRadius, details = {}) {
    const chest = snapshot?.chest || {}
    const seedCount = chest?.counts?.wheat_seeds || 0
    const playerToChest = this.distance(snapshot?.acceptancePlayerPosition, chest?.position)
    const companionToChest = this.distance(snapshot?.companionPosition, chest?.position)
    const base = {
      linxiaPos: snapshot?.companionPosition || null,
      testerPos: snapshot?.acceptancePlayerPosition || null,
      fixtureChestPos: chest?.position || details.creativeResult?.fixtureChestPos || details.commandResult?.fixtureChestPos || null,
      fixtureDistanceToLinXia: companionToChest,
      fixtureDistanceToTester: playerToChest,
      block_set_confirmed: Boolean(chest.ok && ['chest', 'trapped_chest', 'barrel'].includes(chest.blockName)),
      inventory_insert_confirmed: seedCount >= 10,
      openable_confirmed: false,
      reachable_confirmed: companionToChest != null && companionToChest <= 4.5,
      seedCount,
      chest,
      playerToChest,
      companionToChest,
      scanRadius,
      actorAlignment: details.actorAlignment || null,
      commandResult: details.commandResult || null,
      creativeResult: details.creativeResult || null
    }
    if (!chest.ok) return { ready: false, reason: 'chest_not_found_nearby', ...base }
    if (!base.block_set_confirmed) return { ready: false, reason: 'block_not_set', ...base }
    if (playerToChest > 5) return { ready: false, reason: 'chest_not_found_nearby', ...base }
    if (seedCount < 10) return { ready: false, reason: 'inventory_insert_failed', ...base }
    const companionAccess = await this.verifyCompanionStorageAccess()
    const withAccess = {
      ...base,
      companionAccess,
      openable_confirmed: Boolean(companionAccess.ok),
      reachable_confirmed: Boolean(companionAccess.ok || base.reachable_confirmed)
    }
    if (!companionAccess.ok) return { ready: false, reason: companionAccess.reason || 'chest_open_failed', ...withAccess }
    return { ready: true, ...withAccess }
  }

  storageReadinessFromSnapshot(snapshot, scanRadius, actorAlignment = null) {
    const chest = snapshot?.chest || {}
    const seedCount = chest?.counts?.wheat_seeds || 0
    const playerToChest = this.distance(snapshot?.acceptancePlayerPosition, chest?.position)
    const companionToChest = this.distance(snapshot?.companionPosition, chest?.position)
    return {
      ready: false,
      reason: actorAlignment?.reason || 'actor_distance_too_far',
      linxiaPos: snapshot?.companionPosition || null,
      testerPos: snapshot?.acceptancePlayerPosition || null,
      fixtureChestPos: chest?.position || null,
      fixtureDistanceToLinXia: companionToChest,
      fixtureDistanceToTester: playerToChest,
      block_set_confirmed: Boolean(chest.ok && ['chest', 'trapped_chest', 'barrel'].includes(chest.blockName)),
      inventory_insert_confirmed: seedCount >= 10,
      openable_confirmed: false,
      reachable_confirmed: false,
      seedCount,
      chest,
      playerToChest,
      companionToChest,
      scanRadius,
      actorAlignment
    }
  }

  async verifyCompanionStorageAccess() {
    const cursor = this.adapter.createLogCursor()
    await this.adapter.sendCommand('看看箱子里有什么')
    const logs = await this.adapter.waitForLog([
      /\[STORAGE_TASK_SUCCESS\].*mode=check/,
      /\[STORAGE_TASK_FAILED\]/
    ], this.adapter.config.storage?.timeoutMs || 35000, cursor)
    const success = logs.some(line => /\[STORAGE_TASK_SUCCESS\].*mode=check/.test(line))
    const failure = [...logs].reverse().find(line => line.includes('[STORAGE_TASK_FAILED]'))
    const reason = failure?.includes('chest_path_unreachable')
      ? 'chest_unreachable'
      : (failure?.includes('CHEST_OPEN_FAILED') || failure ? 'chest_open_failed' : 'chest_open_failed')
    return {
      ok: success,
      reason: success ? null : reason,
      failure: failure || null,
      relatedLogs: logs.slice(-40)
    }
  }

  farmingTaskScanRadius(options = {}) {
    const configured = options.taskScanRadius ||
      this.adapter.config.farming?.taskScanRadius ||
      this.config.farmingTaskScanRadius
    const radius = Number(configured)
    return Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_FARM_SCAN_RADIUS
  }

  farmingCompanionReadiness(snapshot, scanRadius, minMatureWheat = 2) {
    const matureWheat = (snapshot?.matureWheatNearCompanion || [])
      .map(crop => ({
        ...crop,
        distanceToCompanion: crop.distanceToCompanion ?? this.distance(crop.position, snapshot?.companionPosition)
      }))
    const reachableMatureWheat = matureWheat.filter(crop => crop.distanceToCompanion != null && crop.distanceToCompanion <= scanRadius)
    const fixtureReadyForCompanion = Boolean(snapshot?.companionPosition) && reachableMatureWheat.length >= minMatureWheat
    return {
      fixtureReadyForCompanion,
      scanRadius,
      minMatureWheat,
      matureWheatCount: snapshot?.matureWheat?.length || 0,
      matureWheatCountWithinCompanionScan: reachableMatureWheat.length,
      companionPosition: snapshot?.companionPosition || null,
      companionPositionSource: snapshot?.companionPositionSource || 'none',
      matureWheatPositions: reachableMatureWheat.map(crop => crop.position),
      matureWheatDistancesToCompanion: reachableMatureWheat.map(crop => ({
        position: crop.position,
        distanceToCompanion: crop.distanceToCompanion
      })),
      nearestMatureWheatToCompanion: matureWheat.slice(0, 4).map(crop => ({
        position: crop.position,
        distanceToCompanion: crop.distanceToCompanion
      }))
    }
  }

  distance(a, b) {
    if (!a || !b) return null
    const dx = Number(a.x) - Number(b.x)
    const dy = Number(a.y) - Number(b.y)
    const dz = Number(a.z) - Number(b.z)
    return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100
  }

  allowCommandFixtures() {
    const envName = this.config.allowCommandFixturesEnv || 'ACCEPTANCE_ALLOW_COMMAND_FIXTURES'
    return process.env[envName] === 'true'
  }

  allowCreativeFixtures() {
    return Boolean(this.adapter.canUseCreativeFixtures?.())
  }

  readyFixtureStatus(feature, reason, snapshot, details = {}) {
    return {
      feature,
      ready: true,
      reason,
      commandFixturesAllowed: this.allowCommandFixtures(),
      creativeFixturesAvailable: this.allowCreativeFixtures(),
      startupConfig: snapshot?.startupConfig || this.adapter.startupConfig(),
      acceptancePlayerPosition: snapshot?.acceptancePlayerPosition || null,
      companionPosition: snapshot?.companionPosition || null,
      companionPositionSource: snapshot?.companionPositionSource || 'none',
      companionPositionFromDebug: Boolean(snapshot?.companionPositionFromDebug),
      distancePlayerToAi: snapshot?.distancePlayerToAi ?? null,
      debugStatusAvailable: Boolean(snapshot?.debugStatusAvailable),
      preparedBy: details.preparedBy || (
        details.fixtureType === 'creative'
          ? this.adapter.testUsername()
          : (details.fixtureType === 'command' ? 'command_fixture' : 'existing_world_state')
      ),
      fixtureOnlyPreparedEnvironment: true,
      linxiaBehaviorStillRequiredForPass: true,
      ...details
    }
  }

  blocked(feature, reason, snapshot = null, fixtureAttempts = {}) {
    const attempts = this.normalizeFixtureAttempts(fixtureAttempts)
    return {
      setupStatus: 'BLOCKED',
      setupFailureReason: reason,
      fixtureStatus: {
        feature,
        ready: false,
        fixtureSetupFailed: true,
        reason,
        commandFixturesAllowed: this.allowCommandFixtures(),
        creativeFixturesAvailable: this.allowCreativeFixtures(),
        commandResult: attempts.commandResult,
        creativeResult: attempts.creativeResult,
        companionReadiness: attempts.companionReadiness || null,
        companionAlignmentResult: attempts.companionAlignmentResult || null,
        startupConfig: snapshot?.startupConfig || this.adapter.startupConfig(),
        companionLookup: snapshot?.companionLookup || null,
        acceptancePlayerPosition: snapshot?.acceptancePlayerPosition || null,
        companionPosition: snapshot?.companionPosition || null,
        companionPositionSource: snapshot?.companionPositionSource || 'none',
        companionPositionFromDebug: Boolean(snapshot?.companionPositionFromDebug),
        distancePlayerToAi: snapshot?.distancePlayerToAi ?? null,
        recommendedTeleportCommand: snapshot?.recommendedTeleportCommand || null,
        debugStatusAvailable: Boolean(snapshot?.debugStatusAvailable),
        debugStatusPossibleReason: snapshot?.debugStatusPossibleReason || [],
        manualPreparation: this.manualPreparation(feature)
      },
      snapshot
    }
  }

  normalizeFixtureAttempts(fixtureAttempts = {}) {
    if (!fixtureAttempts) return { commandResult: null, creativeResult: null }
    if ('commandResult' in fixtureAttempts || 'creativeResult' in fixtureAttempts) {
      return {
        commandResult: fixtureAttempts.commandResult || null,
        creativeResult: fixtureAttempts.creativeResult || null,
        companionReadiness: fixtureAttempts.companionReadiness || null,
        companionAlignmentResult: fixtureAttempts.companionAlignmentResult || null
      }
    }
    return { commandResult: fixtureAttempts, creativeResult: null, companionReadiness: null, companionAlignmentResult: null }
  }

  manualPreparation(feature) {
    const manual = this.config.manualPreparation || {}
    return manual[feature] || []
  }
}

module.exports = {
  MinecraftScenarioBuilder
}
