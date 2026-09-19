const { createReminderEvent, defaultReminderText, generateReminderMessage, REMINDER_TYPES } = require('../ai/message-generator')
const { buildSleepState } = require('../utils/sleep')
const { cancelObsoleteWorksiteReturn, constructionMaterialNames, createWorksiteAnchorFromEnv } = require('./worksite-anchor')
const { canDeployTemporaryChest } = require('./storage-system')

const SURVIVAL_PRIORITIES = Object.freeze({
  CRITICAL_HEALTH: 'CRITICAL_HEALTH',
  DANGER_NEARBY: 'DANGER_NEARBY',
  LOW_FOOD_CRITICAL: 'LOW_FOOD_CRITICAL',
  STUCK_OR_FALL_RISK: 'STUCK_OR_FALL_RISK',
  INVENTORY_FULL: 'INVENTORY_FULL',
  TOO_FAR_FROM_BASE: 'TOO_FAR_FROM_BASE',
  NIGHT_UNSAFE: 'NIGHT_UNSAFE',
  SLEEP_NIGHT: 'SLEEP_NIGHT',
  LOW_FOOD_WARNING: 'LOW_FOOD_WARNING',
  NORMAL: 'NORMAL'
})

const PRIORITY_ORDER = [
  SURVIVAL_PRIORITIES.CRITICAL_HEALTH,
  SURVIVAL_PRIORITIES.DANGER_NEARBY,
  SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL,
  SURVIVAL_PRIORITIES.STUCK_OR_FALL_RISK,
  SURVIVAL_PRIORITIES.INVENTORY_FULL,
  SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE,
  SURVIVAL_PRIORITIES.NIGHT_UNSAFE,
  SURVIVAL_PRIORITIES.SLEEP_NIGHT,
  SURVIVAL_PRIORITIES.LOW_FOOD_WARNING,
  SURVIVAL_PRIORITIES.NORMAL
]

const LOW_PRIORITY_TASKS = new Set([
  'build_blueprint', 'exploration', 'farming', 'mining', 'mine_nearby_block', 'storage'
])
const COMBAT_TASKS = new Set(['combat', 'fight_nearby_mob', 'guard_player'])
// 只有这两档保命动作允许打断战斗：DANGER_NEARBY 的处置本身就是战斗，
// 让它打断 fight_nearby_mob 只会来回切换。
const COMBAT_INTERRUPTING_PRIORITIES = new Set([
  SURVIVAL_PRIORITIES.CRITICAL_HEALTH,
  SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL
])
// 这几档发起的撤退/进食视为紧急：带 critical 标记，才能越过"盖房时推迟回家"那道闸。
const CRITICAL_SURVIVAL_PRIORITIES = new Set([
  SURVIVAL_PRIORITIES.CRITICAL_HEALTH,
  SURVIVAL_PRIORITIES.DANGER_NEARBY,
  SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL
])
const CRITICAL_ACTIONS = new Set(['RETURN_SAFE'])
// NIGHT_UNSAFE 的两半门槛，原来写死在候选里，拆出来只为让那段读得下去。
// 与工地锚点那条心跳同一个窗口，两条日志才好对着读。
const EVAL_HEARTBEAT_LOG_INTERVAL_MS = 10000
const NIGHT_BASE_DISTANCE = 24
const NIGHT_PLAYER_DISTANCE = 32

class SurvivalSystem {
  constructor(options = {}) {
    this.options = {
      criticalHealthThreshold: 10,
      criticalFoodThreshold: 4,
      lowFoodThreshold: 8,
      inventoryEmptySlotThreshold: 1,
      farFromBaseDistance: 64,
      farFromPlayerDistance: 64,
      hostileInterruptDistance: 6,
      cooldownMs: 30000,
      safeModeExitCooldownMs: 45000,
      recoveryFoodThreshold: 12,
      recoveryHealthThreshold: 16,
      recoveryOxygenThreshold: 15,
      ...options
    }
    this.cooldowns = new Map()
    this.worksite = options.worksiteAnchor || createWorksiteAnchorFromEnv(process.env, options.worksiteAnchorOptions || {})
    this.lastWorksite = null
    this.safeModeEnabled = Boolean(options.safeModeEnabled)
    this.lastSurvivalDecision = null
    this.pausedTaskDueToSurvival = null
    this.interruptedTask = null
    this.queuedSurvivalTask = null
    this.lastSurvivalAction = null
    this.lastState = null
    this.safeSince = null
    this.sleepState = null
    // 心跳靠时钟限频，注入一个假时钟才能把窗口钉死在单测里（与工地锚点同一手法）。
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.evalHeartbeat = { calls: 0, lastCallAt: null, lastLogAt: null }
  }

  // 生存评估的限频心跳，打在入口而不是出口：出口那两行 [survival] 只能
  // 证明「跑完了」，分不出「压根没被调到」和「进来就抛了」。配合
  // [WORKSITE_ANCHOR_UPDATE] 读——锚点的刷新就挂在这条链上。只记账，不改判定。
  noteEvaluationHeartbeat(context = {}, now = this.now()) {
    const beat = this.evalHeartbeat
    beat.calls += 1
    const sinceLastCallMs = beat.lastCallAt == null ? null : now - beat.lastCallAt
    beat.lastCallAt = now
    if (beat.lastLogAt != null && now - beat.lastLogAt < EVAL_HEARTBEAT_LOG_INTERVAL_MS) return null

    beat.lastLogAt = now
    const currentTask = context.blackboard?.get?.('tasks.currentTask') || null
    const taskLabel = currentTask ? `${currentTask.type || 'unknown'}#${currentTask.id ?? 'none'}` : 'none'
    const line = `[SURVIVAL_EVAL_HEARTBEAT] calls=${beat.calls} sinceLastCallMs=${sinceLastCallMs ?? 'first'} currentTask=${taskLabel}`
    logEvent(context, line)
    return line
  }

  evaluateSurvivalState(context = {}) {
    this.noteEvaluationHeartbeat(context)
    const snapshot = context.blackboard?.snapshot?.() || {}
    const bot = snapshot.bot || {}
    const mobs = snapshot.mobs || {}
    const inventory = snapshot.inventory || {}
    const world = snapshot.world || {}
    const tasks = snapshot.tasks || {}
    const memorySummary = context.memory?.summary?.().world || {}
    const base = context.memory?.world?.baseLocation?.position || context.memory?.world?.baseLocation || null
    const currentPosition = bot.position || context.bot?.entity?.position || null
    const playerPosition = snapshot.player?.ownerPosition || snapshot.player?.nearestPlayer?.position || null
    const distanceFromBase = base && currentPosition ? roundDistance(distance(base, currentPosition)) : null
    const distanceFromPlayer = playerPosition && currentPosition ? roundDistance(distance(playerPosition, currentPosition)) : null
    this.worksite.update(context)
    const worksite = this.worksite.describe(context)
    this.lastWorksite = worksite
    const priority = this.chooseSurvivalPriority(context, { distanceFromBase, distanceFromPlayer, worksite })
    const health = Number(bot.health ?? context.bot?.health ?? 20)
    const food = Number(bot.food ?? context.bot?.food ?? 20)
    const oxygen = Number(bot.oxygen ?? context.bot?.oxygen ?? 20)
    const hostileSummary = summarizeHostiles(mobs)
    const sleepState = buildSleepState(context, this.sleepState || {})
    const nearbyHostileCount = hostileSummary.count
    const equipmentSystem = context.equipmentSystem || context.taskManager?.options?.equipmentSystem || null
    const hasFood = equipmentSystem
      ? equipmentSystem.hasFood(context).ok
      : (Number(inventory.foodCount || 0) > 0 || Object.keys(inventory.counts || {}).some(name => isFoodName(name) && inventory.counts[name] > 0))
    const hasWeapon = equipmentSystem
      ? equipmentSystem.hasWeapon(context).ok
      : Object.keys(inventory.counts || {}).some(name => /sword|axe|bow|trident/.test(name))

    const state = {
      health,
      food,
      oxygen,
      armorLevel: Number(bot.armorLevel || inventory.armorLevel || 0),
      dangerLevel: mobs.dangerLevel || 'none',
      nearbyHostileCount,
      nearestHostileDistance: hostileSummary.nearestDistance,
      nearbyHostiles: hostileSummary.hostiles,
      isBurning: isBurning(context, bot),
      isDrowning: oxygen < this.options.recoveryOxygenThreshold,
      isNight: world.isDay === false,
      sleepState,
      nearbyBedAvailable: Boolean(sleepState.nearestBedPosition),
      isInDarkArea: world.lightLevel != null ? Number(world.lightLevel) <= 7 : false,
      isFarFromBase: distanceFromBase != null && distanceFromBase > this.options.farFromBaseDistance,
      isLost: !base && distanceFromPlayer != null && distanceFromPlayer > this.options.farFromPlayerDistance,
      inventoryFull: inventory.emptySlots != null && inventory.emptySlots <= this.options.inventoryEmptySlotThreshold,
      hasFood,
      hasWeapon,
      hasSafePathToBase: base ? this.isSafeModeEnabled(context) !== true || mobs.dangerLevel !== 'critical' : false,
      currentBiome: world.currentBiome || null,
      currentTaskRisk: taskRisk(tasks.currentTask),
      healthStatus: health <= this.options.criticalHealthThreshold ? 'critical' : 'ok',
      foodStatus: foodStatus(food, this.options),
      dangerStatus: ['high', 'critical'].includes(mobs.dangerLevel) ? 'danger' : (hostileSummary.nearestDistance <= this.options.hostileInterruptDistance ? 'danger' : (mobs.nearestHostileMob ? 'watch' : 'safe')),
      inventoryStatus: inventory.emptySlots != null && inventory.emptySlots <= this.options.inventoryEmptySlotThreshold ? 'full' : 'ok',
      timeStatus: world.isDay === false ? 'night' : 'day_or_unknown',
      nightStatus: world.isDay === false ? 'night' : 'day_or_unknown',
      distanceStatus: distanceStatus(distanceFromBase, distanceFromPlayer, this.options),
      taskStatus: tasks.currentTask ? { type: tasks.currentTask.type, priority: tasks.currentTask.priority, state: tasks.currentTask.state } : null,
      baseStatus: memorySummary.hasBaseLocation || base ? 'known' : 'missing',
      overallRiskLevel: riskLevelForPriority(priority.priority),
      survivalPriority: priority.priority,
      recommendedAction: this.actionForPriority(priority.priority, context),
      reason: priority.reason,
      distanceFromBase,
      distanceFromPlayer,
      knownChestCount: memorySummary.chestLocations || 0,
      knownFarmCount: memorySummary.farmLocations || 0,
      worksite,
      safeModeEnabled: this.isSafeModeEnabled(context)
    }

    this.updateSafeModeFromState(context, state)
    state.safeModeEnabled = this.isSafeModeEnabled(context)
    this.lastState = state

    this.writeStatus(context, state)
    logEvent(context, `[survival] health=${state.health} food=${state.food} owner=bot action=${state.recommendedAction || 'NONE'} dangerLevel=${state.dangerLevel || 'none'}`)
    logEvent(context, `[survival] isNight=${state.isNight} sleepCandidate=${sleepState.canSleepNow ? 'true' : 'false'} action=${state.recommendedAction === 'SLEEP' ? 'enqueue_sleep' : 'none'}`)
    return state
  }

  chooseSurvivalPriority(context = {}, extra = {}) {
    const snapshot = context.blackboard?.snapshot?.() || {}
    const bot = snapshot.bot || {}
    const mobs = snapshot.mobs || {}
    const inventory = snapshot.inventory || {}
    const world = snapshot.world || {}
    const currentTask = snapshot.tasks?.currentTask || null
    const hostileSummary = summarizeHostiles(mobs)
    const distanceFromBase = extra.distanceFromBase ?? null
    const distanceFromPlayer = extra.distanceFromPlayer ?? null
    const worksite = extra.worksite || this.lastWorksite || null
    const candidates = []

    if (Number(bot.health) <= this.options.criticalHealthThreshold) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.CRITICAL_HEALTH, 'health is critical'))
    }
    if (['high', 'critical'].includes(mobs.dangerLevel)) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.DANGER_NEARBY, 'danger level is high'))
    } else if (hostileSummary.nearestDistance <= this.options.hostileInterruptDistance) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.DANGER_NEARBY, `hostile mob within ${this.options.hostileInterruptDistance} blocks`))
    }
    if (Number(bot.food) <= this.options.criticalFoodThreshold) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL, 'food is critically low'))
    } else if (Number(bot.food) <= this.options.lowFoodThreshold) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.LOW_FOOD_WARNING, 'food is low'))
    }
    if (bot.onGround === false && currentTask) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.STUCK_OR_FALL_RISK, 'fall or stuck risk detected'))
    }
    if (inventory.emptySlots != null && inventory.emptySlots <= this.options.inventoryEmptySlotThreshold) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.INVENTORY_FULL, 'inventory is full'))
    }
    if (distanceFromBase != null && distanceFromBase > this.options.farFromBaseDistance) {
      // 站在工地上的时候，工地就是家：不为了那个几个月前的旧坐标把她拽走。
      if (worksite?.atWorksite) {
        logEvent(context, `[WORKSITE_ANCHOR_HOLD] priority=TOO_FAR_FROM_BASE distanceFromBase=${distanceFromBase} worksiteDistance=${worksite.distance} ageMs=${worksite.ageMs}`)
      } else {
        candidates.push(candidate(SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE, 'too far from base'))
      }
    }
    if (world.isDay === false) {
      const nightFarFromBase = distanceFromBase != null && distanceFromBase > NIGHT_BASE_DISTANCE
      const nightFarFromPlayer = distanceFromPlayer != null && distanceFromPlayer > NIGHT_PLAYER_DISTANCE
      // 「天黑了离基地太远」这一半在工地上不算数——工地就是家，与白天那条同一口径。
      // 「离玩家太远」那一半照旧：它管的是别把人跟丢，跟那个旧基地坐标无关。
      const baseHalfHeld = nightFarFromBase && worksite?.atWorksite === true
      if (baseHalfHeld) {
        logEvent(context, `[WORKSITE_ANCHOR_HOLD] priority=NIGHT_UNSAFE distanceFromBase=${distanceFromBase} worksiteDistance=${worksite.distance} ageMs=${worksite.ageMs}`)
      }
      if ((nightFarFromBase && !baseHalfHeld) || nightFarFromPlayer) {
        candidates.push(candidate(SURVIVAL_PRIORITIES.NIGHT_UNSAFE, 'night and far from safety'))
      }
    }
    const sleepState = buildSleepState(context, {})
    if (
      world.isDay === false &&
      sleepState.canSleepNow &&
      hostileSummary.nearestDistance > this.options.hostileInterruptDistance &&
      (!currentTask || LOW_PRIORITY_TASKS.has(currentTask.type))
    ) {
      candidates.push(candidate(SURVIVAL_PRIORITIES.SLEEP_NIGHT, 'night and bed available'))
    }

    if (!candidates.length) return candidate(SURVIVAL_PRIORITIES.NORMAL, 'normal survival state')
    return candidates.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))[0]
  }

  createSurvivalPlan(context, survivalState = null) {
    const state = survivalState || this.evaluateSurvivalState(context)
    const priority = state.survivalPriority || state.priority || SURVIVAL_PRIORITIES.NORMAL
    const resolvedAction = this.actionForPriority(priority, context)
    // 工地上的就近卸货不再让位给「施工中先别管生存」那道闸——
    // 让位等于背着满背包接着盖，材料闸门迟早把这一轮堵死。
    const worksiteUnload = this.isWorksiteUnload(priority, resolvedAction)
    const constructionDefer = !worksiteUnload && shouldAllowConstructionDefer(priority)
      ? shouldDeferSurvivalForConstruction(context, state)
      : { ok: false }
    const deferReturnSafe = !worksiteUnload && shouldDeferReturnSafeForCurrentTask(context, state)
    const deferredForBuild = constructionDefer.ok || deferReturnSafe
    const action = deferredForBuild ? 'REMIND' : resolvedAction
    return {
      ok: true,
      priority,
      action,
      worksite: state.worksite || this.lastWorksite || null,
      shouldInterrupt: deferredForBuild ? false : this.shouldInterruptCurrentTask(context, state).shouldInterrupt,
      targetTask: 'current',
      reason: state.reason,
      deferredForTask: deferredForBuild
        ? constructionDefer.task?.type || context.blackboard?.get?.('tasks.currentTask')?.type || null
        : null,
      deferredReason: constructionDefer.ok ? constructionDefer.reason : (deferReturnSafe ? 'return_safe_deferred_for_active_build' : null),
      cooldownKey: `survival_${priority.toLowerCase()}`,
      riskLevel: state.overallRiskLevel,
      dangerLevel: state.dangerLevel,
      nearbyHostiles: state.nearbyHostileCount,
      nearestHostileDistance: state.nearestHostileDistance,
      combatInterruptReason: priority === SURVIVAL_PRIORITIES.DANGER_NEARBY ? state.reason : null
    }
  }

  shouldInterruptCurrentTask(context, survivalState = null) {
    const state = survivalState || this.evaluateSurvivalState(context)
    const currentTask = context.blackboard?.get?.('tasks.currentTask')
    if (!currentTask) return { ok: true, shouldInterrupt: false, reason: 'no_current_task' }
    if (state.survivalPriority === SURVIVAL_PRIORITIES.NORMAL) return { ok: true, shouldInterrupt: false, reason: 'normal' }
    const worksiteUnload = this.isWorksiteUnload(state.survivalPriority, this.actionForPriority(state.survivalPriority, context))
    if (!worksiteUnload && shouldAllowConstructionDefer(state.survivalPriority) && shouldDeferSurvivalForConstruction(context, state).ok) {
      return { ok: true, shouldInterrupt: false, reason: 'survival_deferred_for_construction' }
    }
    if (state.survivalPriority === SURVIVAL_PRIORITIES.LOW_FOOD_WARNING) return { ok: true, shouldInterrupt: false, reason: 'warning_only' }
    if (state.survivalPriority === SURVIVAL_PRIORITIES.SLEEP_NIGHT) return { ok: true, shouldInterrupt: false, reason: 'night_warning_only' }
    if (!worksiteUnload && shouldDeferReturnSafeForCurrentTask(context, state)) return { ok: true, shouldInterrupt: false, reason: 'return_safe_deferred_for_active_build' }
    if (!canInterruptTaskType(currentTask.type, state.survivalPriority)) return { ok: true, shouldInterrupt: false, reason: 'current_task_is_high_priority' }
    if (this.isCoolingDown(`interrupt_${state.survivalPriority}`)) return { ok: true, shouldInterrupt: false, reason: 'cooldown' }
    return { ok: true, shouldInterrupt: true, reason: state.reason }
  }

  // 工地锚点一激活，之前为了那个旧坐标排下的「回家」就作废了：
  // 不撤的话它压着施工任务（HIGH 压 MEDIUM），她会先走完几百格再回来盖。
  // 只撤生存系统自己因这两档发起、且没带 critical 标记的那趟；
  // 玩家亲口下的回家指令、保命撤退一概不碰。
  async releaseObsoleteReturn(context) {
    if (!this.worksite.isEnabled()) return { ok: false, reason: 'worksite_anchor_disabled' }
    // 自带锚点刷新：这个方法在目标候选判断之前调用，不能指望 evaluateSurvivalState 先跑过。
    this.worksite.update(context)
    this.lastWorksite = this.worksite.describe(context)
    if (this.lastWorksite.atWorksite !== true) return { ok: false, reason: 'not_at_worksite' }

    const released = await cancelObsoleteWorksiteReturn(context, {
      enabled: true,
      trigger: 'worksite_anchor_active',
      reason: 'worksite_anchor_active'
    })
    if (released.ok && this.queuedSurvivalTask && String(this.queuedSurvivalTask.id) === String(released.task?.id)) {
      this.queuedSurvivalTask = null
    }
    return released.task ? { ...released, task: toRecoveryTaskReference(released.task) } : released
  }

  async applySurvivalDecision(context, decision) {
    if (!decision || decision.priority === SURVIVAL_PRIORITIES.NORMAL) {
      this.lastSurvivalDecision = decision || null
      this.lastSurvivalAction = 'NONE'
      this.writeStatus(context)
      return { ok: true, type: 'NOOP', message: 'normal survival state' }
    }

    const currentTask = context.blackboard?.get?.('tasks.currentTask')
    if (decision.action === 'GUARD_PLAYER' && currentTask?.type === 'guard_player') {
      this.lastSurvivalDecision = { ...decision, task: currentTask, skippedReason: 'combat_already_active' }
      this.lastSurvivalAction = 'GUARD_PLAYER'
      this.writeStatus(context)
      return { ok: true, type: 'NOOP', message: 'combat already active', decision }
    }

    if (decision.deferredForTask === 'build_blueprint') {
      this.lastSurvivalDecision = { ...decision, task: null, skippedReason: decision.deferredReason || 'construction_active_or_queued' }
      this.lastSurvivalAction = 'DEFERRED_FOR_CONSTRUCTION'
      logEvent(context, `[survival] deferred action=${decision.action || 'none'} priority=${decision.priority || 'unknown'} reason=${decision.deferredReason || 'construction_active_or_queued'}`)
      this.writeStatus(context)
      return { ok: true, type: 'DEFERRED', message: 'survival deferred for construction', decision }
    }

    if (this.isCoolingDown(decision.cooldownKey) && !isUrgentCombatDecision(decision)) {
      return { ok: true, type: 'COOLDOWN', message: 'survival decision cooling down', decision }
    }
    this.setCooldown(decision.cooldownKey)
    await this.emitInterventionFeedback(context, decision)

    if (decision.shouldInterrupt && currentTask) {
      if (decision.action === 'GUARD_PLAYER') {
        const paused = await context.taskManager?.pauseCurrent?.(`survival_${decision.priority.toLowerCase()}`)
        if (paused) this.rememberPausedTaskForRecovery(context, currentTask)
      } else if (CRITICAL_ACTIONS.has(decision.action)) {
        await context.taskManager?.interruptCurrent?.(`survival_${decision.priority.toLowerCase()}`)
        this.interruptedTask = currentTask
      } else {
        const paused = await context.taskManager?.pauseCurrent?.(`survival_${decision.priority.toLowerCase()}`)
        if (paused) this.rememberPausedTaskForRecovery(context, currentTask)
      }
      this.setCooldown(`interrupt_${decision.priority}`)
    }

    const task = this.enqueueDecisionTask(context, decision)
    this.queuedSurvivalTask = task || null
    this.lastSurvivalAction = decision.action
    this.lastSurvivalDecision = { ...decision, task: task || null }
    logEvent(context, `[survival] dangerLevel=${decision.dangerLevel || decision.riskLevel || 'unknown'} nearbyHostiles=${decision.nearbyHostiles ?? 'unknown'} nearestHostileDistance=${decision.nearestHostileDistance ?? 'unknown'} action=${task ? `enqueue_${task.type}` : String(decision.action || 'none').toLowerCase()} combatInterruptReason=${decision.combatInterruptReason || decision.reason || 'unknown'}`)
    this.writeStatus(context)

    if (task) return { ok: true, type: 'TASK', decision, task }
    return this.remind(context, decision)
  }

  // 工地上有没有可以就近卸货的箱子。不在工地上一律返回 null，
  // 免得空闲路径也去扫方块。
  worksiteUnloadTarget(context) {
    if (!this.lastWorksite?.atWorksite) return null
    const found = this.worksite.findNearbyStorage(context)
    return found?.ok ? found : null
  }

  isWorksiteUnload(priority, action) {
    return priority === SURVIVAL_PRIORITIES.INVENTORY_FULL &&
      action === 'STORE_INVENTORY' &&
      this.lastWorksite?.atWorksite === true
  }

  enqueueDecisionTask(context, decision) {
    const taskManager = context.taskManager
    if (!taskManager?.enqueue) return null
    const survivalParams = survivalReasonParams(decision.priority)
    switch (decision.action) {
      case 'EAT_FOOD':
        return taskManager.enqueue('eat_food', { ...survivalParams }, 10, 'survival_system')
      case 'GUARD_PLAYER':
        if (hasActiveOrQueuedGuardTask(taskManager)) return taskManager.currentTask || taskManager.queue?.find?.(task => task?.type === 'guard_player') || null
        return taskManager.enqueue('guard_player', { durationMs: 15000, radius: 8 }, 9, 'survival_system')
      case 'STORE_INVENTORY': {
        const nearby = this.worksiteUnloadTarget(context)
        const atWorksite = this.lastWorksite?.atWorksite === true
        if (!nearby && !atWorksite) return taskManager.enqueue('storage', { mode: 'INVENTORY_FULL_STORE' }, 6, 'survival_system')
        const radius = this.worksite.options.storageRadius
        const keepItems = constructionMaterialNames(context)
        // 工地上一只箱子都没有（荒地开工）：照旧把半径锁死在工地范围内，
        // 但给这一趟带上「就地放一只临时箱子」的授权（决策 #89-C）。
        // 没有这一条她会 chest_not_found 每 30 秒空转一次，建造永远起不来。
        if (!nearby) {
          logEvent(context, `[WORKSITE_UNLOAD_NO_CHEST] radius=${radius} keepItems=${keepItems.length} action=deploy_temporary_chest`)
          return taskManager.enqueue('storage', {
            mode: 'INVENTORY_FULL_STORE',
            radius,
            maxDistance: radius,
            keepItems,
            worksiteUnload: true,
            placeTemporaryChest: true
          }, 6, 'survival_system')
        }
        logEvent(context, `[WORKSITE_UNLOAD] source=${nearby.source} radius=${radius} chests=${nearby.positions.map(formatPosition).join('|')} keepItems=${keepItems.length}`)
        return taskManager.enqueue('storage', {
          mode: 'INVENTORY_FULL_STORE',
          radius,
          maxDistance: radius,
          scanCenters: nearby.positions,
          keepItems,
          worksiteUnload: true
        }, 6, 'survival_system')
      }
      case 'STAY_PUT':
        logEvent(context, `[WORKSITE_INVENTORY_BLOCKED] reason=no_chest_within_${this.worksite.options.storageRadius} worksiteDistance=${this.lastWorksite?.distance ?? 'unknown'} action=stay_put`)
        return null
      case 'TAKE_FOOD_FROM_STORAGE':
        return taskManager.enqueue('storage', { mode: 'TAKE_ITEMS', itemName: 'bread', count: 1 }, 8, 'survival_system')
      case 'MAKE_BREAD':
        return taskManager.enqueue('farming', { mode: 'MAKE_BREAD' }, 8, 'survival_system')
      case 'FARM_FOOD':
        return taskManager.enqueue('farming', { mode: 'FARM_CYCLE' }, 6, 'survival_system')
      case 'RETURN_SAFE':
        return taskManager.enqueue(hasBase(context) ? 'return_to_base' : 'return_to_player', { ...survivalParams }, 8, 'survival_system')
      case 'SLEEP':
        return null
      default:
        return null
    }
  }

  actionForPriority(priority, context = {}) {
    const counts = context.blackboard?.get?.('inventory.counts') || {}
    const foodCount = context.blackboard?.get?.('inventory.foodCount') || 0
    const memory = context.memory?.summary?.().world || {}
    if (priority === SURVIVAL_PRIORITIES.CRITICAL_HEALTH) return foodCount > 0 ? 'EAT_FOOD' : 'RETURN_SAFE'
    if (priority === SURVIVAL_PRIORITIES.DANGER_NEARBY) return 'GUARD_PLAYER'
    if (priority === SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL) {
      if (foodCount > 0) return 'EAT_FOOD'
      if (memory.chestLocations > 0) return 'TAKE_FOOD_FROM_STORAGE'
      if ((counts.wheat || 0) >= 3) return 'MAKE_BREAD'
      if (memory.farmLocations > 0) return 'FARM_FOOD'
      return 'REMIND'
    }
    if (priority === SURVIVAL_PRIORITIES.INVENTORY_FULL) {
      // 在工地上：只认就近的箱子。无论如何都不为了卸货跑去几百格外的旧基地。
      // 一只都找不到时（荒地开工）还有一条路：身上有箱子、或够合成一只，
      // 就派一趟带「就地放临时箱」授权的卸货（决策 #89-C）；
      // 两样都没有才照旧原地站着等人——派出去也只换回一条 chest_not_found。
      if (this.lastWorksite?.atWorksite) {
        if (this.worksiteUnloadTarget(context)) return 'STORE_INVENTORY'
        return canDeployTemporaryChest(counts) ? 'STORE_INVENTORY' : 'STAY_PUT'
      }
      return memory.chestLocations > 0 ? 'STORE_INVENTORY' : 'RETURN_SAFE'
    }
    if (priority === SURVIVAL_PRIORITIES.SLEEP_NIGHT) return 'REMIND'
    if ([SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE, SURVIVAL_PRIORITIES.NIGHT_UNSAFE, SURVIVAL_PRIORITIES.STUCK_OR_FALL_RISK].includes(priority)) return 'RETURN_SAFE'
    if (priority === SURVIVAL_PRIORITIES.LOW_FOOD_WARNING) return foodCount > 0 ? 'EAT_FOOD' : 'REMIND'
    return 'NONE'
  }

  setSafeMode(context, enabled) {
    this.safeModeEnabled = Boolean(enabled)
    this.safeSince = this.safeModeEnabled ? null : Date.now()
    context.blackboard?.set?.('survival.safeModeEnabled', this.safeModeEnabled)
    this.writeStatus(context)
    return { ok: true, safeModeEnabled: this.safeModeEnabled }
  }

  isSafeModeEnabled(context = {}) {
    const fromBlackboard = context.blackboard?.get?.('survival.safeModeEnabled')
    return fromBlackboard == null ? this.safeModeEnabled : Boolean(fromBlackboard)
  }

  shouldBlockNewTask(type, params = {}, source = 'ai') {
    if (!this.safeModeEnabled) return { ok: true }
    if (source === 'survival_system') return { ok: true }
    if (params?.force === true || params?.confirmed === true) return { ok: true }
    if (!LOW_PRIORITY_TASKS.has(type)) return { ok: true }
    return { ok: false, reason: 'safe_mode_blocks_low_priority_task' }
  }

  canStartTask(task) {
    return this.shouldBlockNewTask(task?.type, task?.params, task?.source)
  }

  hasPendingRecovery() {
    return Boolean(this.pausedTaskDueToSurvival)
  }

  rememberPausedTaskForRecovery(context, candidate) {
    const taskManager = context.taskManager
    const retainedCandidate = findRetainedPausedTask(taskManager, candidate) || candidate
    if (!retainedCandidate || isSurvivalInterventionTask(retainedCandidate)) return this.pausedTaskDueToSurvival

    const retainedExisting = findRetainedPausedTask(taskManager, this.pausedTaskDueToSurvival)
    if (retainedExisting && !isSurvivalInterventionTask(retainedExisting)) return retainedExisting

    this.pausedTaskDueToSurvival = toRecoveryTaskReference(retainedCandidate)
    return this.pausedTaskDueToSurvival
  }

  evaluateRecoverySafety(context, survivalState = null) {
    const state = survivalState || this.lastState || {}
    const taskManager = context.taskManager
    let trackedTask = this.pausedTaskDueToSurvival
    let pausedTask = findRetainedPausedTask(taskManager, trackedTask)
    if (!pausedTask || isSurvivalInterventionTask(pausedTask)) {
      pausedTask = findLastRecoverableSurvivalPause(taskManager)
      if (pausedTask) {
        this.pausedTaskDueToSurvival = toRecoveryTaskReference(pausedTask)
        trackedTask = this.pausedTaskDueToSurvival
      }
    }
    const activeTask = taskManager?.currentTask || null
    const activeSurvivalTask = findActiveSurvivalTask(taskManager, trackedTask)
    const food = Number(state.food ?? context.blackboard?.get?.('bot.food') ?? context.bot?.food ?? 20)
    const health = Number(state.health ?? context.blackboard?.get?.('bot.health') ?? context.bot?.health ?? 20)
    const oxygen = Number(state.oxygen ?? context.blackboard?.get?.('bot.oxygen') ?? context.bot?.oxygen ?? 20)
    const dangerLevel = state.dangerLevel || context.blackboard?.get?.('mobs.dangerLevel') || 'none'
    const nearestHostileDistance = Number(state.nearestHostileDistance ?? Infinity)
    const burning = state.isBurning === true || isBurning(context)
    const drowning = state.isDrowning === true || oxygen < this.options.recoveryOxygenThreshold
    const combat = ['fight_nearby_mob', 'guard_player'].includes(activeTask?.type) ||
      ['high', 'critical'].includes(dangerLevel)
    const immediateDanger = combat ||
      nearestHostileDistance <= this.options.hostileInterruptDistance ||
      burning ||
      drowning
    const criticalPriority = [
      SURVIVAL_PRIORITIES.CRITICAL_HEALTH,
      SURVIVAL_PRIORITIES.DANGER_NEARBY,
      SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL
    ].includes(state.survivalPriority)
    const safeMode = this.isSafeModeEnabled(context)

    let rejectionReason = null
    if (!trackedTask) rejectionReason = 'no_paused_survival_task'
    else if (!taskManager?.resumePaused) rejectionReason = 'task_manager_resume_unavailable'
    else if (!pausedTask) rejectionReason = 'missing_paused_task'
    else if (food < this.options.recoveryFoodThreshold) rejectionReason = 'food_below_recovery_threshold'
    else if (health < this.options.recoveryHealthThreshold) rejectionReason = 'health_below_recovery_threshold'
    else if (drowning) rejectionReason = 'drowning_risk'
    else if (burning) rejectionReason = 'burning_risk'
    else if (immediateDanger) rejectionReason = 'immediate_danger'
    else if (criticalPriority) rejectionReason = `critical_survival_priority:${state.survivalPriority}`
    else if (activeSurvivalTask) rejectionReason = `active_survival_task:${activeSurvivalTask.type}`
    else if (activeTask) rejectionReason = `active_task:${activeTask.type}`
    else if (safeMode) rejectionReason = 'safe_mode_enabled'

    return {
      food,
      health,
      dangerFlags: {
        dangerLevel,
        combat,
        drowning,
        burning,
        immediateDanger,
        oxygen,
        nearestHostileDistance: Number.isFinite(nearestHostileDistance) ? nearestHostileDistance : null
      },
      safeMode,
      activeSurvivalTask: summarizeRecoveryTask(activeSurvivalTask),
      pausedTaskId: trackedTask?.id ?? null,
      pausedTaskType: trackedTask?.type ?? null,
      retainedPausedTask: pausedTask,
      canResume: rejectionReason == null,
      rejectionReason
    }
  }

  async resumeIfSafe(context, survivalState = null) {
    const state = survivalState || this.evaluateSurvivalState(context)
    const recovery = this.evaluateRecoverySafety(context, state)
    logEvent(context, `[SURVIVAL_RECOVERY_EVAL] ${JSON.stringify({
      food: recovery.food,
      health: recovery.health,
      dangerFlags: recovery.dangerFlags,
      safeMode: recovery.safeMode,
      activeSurvivalTask: recovery.activeSurvivalTask,
      pausedTaskId: recovery.pausedTaskId,
      pausedTaskType: recovery.pausedTaskType,
      canResume: recovery.canResume,
      rejectionReason: recovery.rejectionReason
    })}`)
    if (!recovery.canResume) return { ok: false, reason: recovery.rejectionReason }

    const task = recovery.retainedPausedTask
    const resumed = await context.taskManager.resumePaused('survival_recovered', {
      taskId: task.id,
      taskType: task.type
    })
    if (!resumed) return { ok: false, reason: 'task_manager_resume_rejected' }

    this.pausedTaskDueToSurvival = null
    this.queuedSurvivalTask = null
    this.lastSurvivalAction = 'RESUME_PREVIOUS_TASK'
    this.lastSurvivalDecision = {
      priority: SURVIVAL_PRIORITIES.NORMAL,
      action: 'RESUME_PREVIOUS_TASK',
      reason: 'survival_recovered',
      riskLevel: 'low'
    }
    this.writeStatus(context, state)
    return { ok: true, task }
  }

  craftMissingBasicTools(context) {
    if (this.isCoolingDown('auto_craft_tools')) return { ok: false, reason: 'cooldown' }
    if (context.taskManager?.queue?.length > 3) return { ok: false, reason: 'queue_busy' }

    const equipmentSystem = context.equipmentSystem || context.taskManager?.options?.equipmentSystem || null
    if (!equipmentSystem) return { ok: false, reason: 'no_equipment_system' }

    const toolStatus = equipmentSystem.getToolStatus(context) || {}
    const counts = context.blackboard?.get?.('inventory.counts') || {}
    const inventoryItems = context.bot?.inventory?.items?.() || []
    if (inventoryItems.length > 0 && !counts.cobblestone) {
      for (const item of inventoryItems) {
        if (!counts[item.name]) counts[item.name] = item.count
      }
    }

    const missing = []
    if (!toolStatus.hasPickaxe) missing.push('pickaxe')
    if (!toolStatus.hasAxe) missing.push('axe')
    if (!toolStatus.hasSword) missing.push('sword')
    if (missing.length === 0) return { ok: false, reason: 'all_tools_present' }

    const crafted = []
    for (const toolType of missing) {
      const itemName = this._bestCraftableTool(toolType, counts)
      if (itemName) {
        context.taskManager.enqueue('craft_item', { itemName, count: 1 }, 5, 'survival_system')
        crafted.push(itemName)
      }
    }

    if (crafted.length > 0) {
      this.setCooldown('auto_craft_tools')
      logEvent(context, `[SURVIVAL_AUTO_CRAFT] tools=${crafted.join(',')}`)
      return { ok: true, crafted }
    }
    return { ok: false, reason: 'no_craftable_tools' }
  }

  async ensureArmorForRisk(context, state = null) {
    if (this.isCoolingDown('armor_check')) return { ok: false, reason: 'cooldown' }
    const survivalState = state || this.lastState || this.evaluateSurvivalState(context)
    const equipmentSystem = context.equipmentSystem || context.taskManager?.options?.equipmentSystem || null
    if (!equipmentSystem?.equipBestArmor) return { ok: false, reason: 'no_equipment_system_armor' }

    const currentTask = context.blackboard?.get?.('tasks.currentTask')
    const riskyTask = ['exploration', 'mining', 'mine_nearby_block', 'fight_nearby_mob', 'guard_player']
      .includes(currentTask?.type)
    const shouldCheck =
      ['high', 'critical'].includes(survivalState.dangerLevel) ||
      survivalState.survivalPriority === SURVIVAL_PRIORITIES.DANGER_NEARBY ||
      survivalState.isNight === true ||
      riskyTask

    if (!shouldCheck) return { ok: false, reason: 'not_risky' }

    const result = await equipmentSystem.equipBestArmor(context, {
      reason: `survival_${survivalState.survivalPriority || 'risk'}`
    })
    this.setCooldown('armor_check')
    return { ok: true, result }
  }

  _bestCraftableTool(toolType, counts) {
    const sticks = counts.stick || 0
    if (sticks < 2) return null

    const planks = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks']
      .reduce((sum, name) => sum + (counts[name] || 0), 0)

    const tiers = [
      { name: 'stone', material: counts.cobblestone || 0, matCount: 3, prefix: 'stone_' },
      { name: 'iron', material: counts.iron_ingot || 0, matCount: 3, prefix: 'iron_' },
      { name: 'wooden', material: planks, matCount: 3, prefix: 'wooden_' }
    ]

    for (const tier of tiers) {
      if (tier.material >= tier.matCount) {
        return `${tier.prefix}${toolType}`
      }
    }
    return null
  }

  updateSafeModeFromState(context, state) {
    const highRisk = ['high'].includes(state.overallRiskLevel) || ['critical', 'high'].includes(state.dangerLevel)
    if (highRisk) {
      if (!this.safeModeEnabled) logEvent(context, '[SURVIVAL_SAFE_MODE_ENTER] reason=high_risk')
      this.safeModeEnabled = true
      this.safeSince = null
      context.blackboard?.set?.('survival.safeModeEnabled', true)
      return
    }

    const safeForExit = isSafeModeExitState(state, this.options)
    if (this.safeModeEnabled && safeForExit) {
      if (!this.safeSince) this.safeSince = Date.now()
      if (Date.now() - this.safeSince >= this.options.safeModeExitCooldownMs) {
        this.safeModeEnabled = false
        context.blackboard?.set?.('survival.safeModeEnabled', false)
        logEvent(context, '[SURVIVAL_SAFE_MODE_EXIT] reason=risk_cleared')
      }
    } else if (!safeForExit) {
      this.safeSince = null
    }
  }

  async remind(context, decision) {
    const cooldown = context.feedbackCooldown
    const key = `survival_remind_${decision.priority || 'normal'}`
    if (cooldown && !cooldown.canEmit(key, 30000)) {
      const suppressed = cooldown.getSuppressedCount(key)
      return { ok: true, type: 'REMINDER_COOLDOWN', suppressed, decision }
    }
    const event = createReminderEvent({
      type: reminderTypeForSurvivalPriority(decision.priority),
      severity: decision.riskLevel === 'high' ? 'high' : 'medium',
      meaning: decision.reason || decision.priority,
      facts: {
        priority: decision.priority,
        action: decision.action,
        reason: decision.reason,
        health: this.lastState?.health,
        food: this.lastState?.food,
        statusOwner: 'bot'
      },
      suggestion: suggestionForDecision(decision),
      source: 'survival_system'
    })
    const generated = {
      ok: true,
      text: defaultReminderText(event, context.persona),
      source: 'fallback',
      event
    }
    const text = generated.text || event.fallbackText || event.meaning
    const payload = { event, generated: { ...generated, text }, decision }
    context.blackboard?.set?.('messages.lastSurvivalReminder', payload)
    logEvent(context, `[response] statusOwner=bot message=${text}`)
    context.reminderOutput?.(text, event, generated)
    generateSurvivalReminderInBackground(context, event, decision)
    return { ok: true, type: 'REMINDER', message: text, event, generated, decision }
  }

  async emitInterventionFeedback(context, decision) {
    if (decision.action === 'REMIND') return
    const cooldown = context.feedbackCooldown
    const key = `survival_intervention_${decision.priority || 'normal'}`
    if (cooldown && !cooldown.canEmit(key, 15000)) return
    const event = createReminderEvent({
      type: reminderTypeForSurvivalPriority(decision.priority),
      severity: decision.riskLevel === 'high' ? 'high' : 'medium',
      meaning: decision.reason || decision.priority,
      facts: {
        priority: decision.priority,
        action: decision.action,
        reason: decision.reason,
        health: this.lastState?.health,
        food: this.lastState?.food,
        statusOwner: 'bot'
      },
      suggestion: suggestionForDecision(decision),
      source: 'survival_system'
    })
    const generated = {
      ok: true,
      text: defaultReminderText(event, context.persona),
      source: 'fallback',
      event
    }
    const text = generated.text || event.fallbackText || event.meaning
    logEvent(context, `[response] statusOwner=bot message=${text}`)
    context.blackboard?.set?.('messages.lastSurvivalReminder', { event, generated: { ...generated, text }, decision })
    context.reminderOutput?.(text, event, generated)
    generateSurvivalReminderInBackground(context, event, decision)
  }

  status(context = {}) {
    return {
      survivalState: this.lastState,
      survivalStatus: this.lastSurvivalDecision?.priority || SURVIVAL_PRIORITIES.NORMAL,
      overallRiskLevel: this.lastSurvivalDecision?.riskLevel || 'low',
      survivalPriority: this.lastSurvivalDecision?.priority || SURVIVAL_PRIORITIES.NORMAL,
      recommendedAction: this.lastSurvivalDecision?.action || 'NONE',
      safeModeEnabled: this.isSafeModeEnabled(context),
      safeMode: this.isSafeModeEnabled(context),
      lastSurvivalDecision: this.lastSurvivalDecision,
      lastSurvivalReason: this.lastSurvivalDecision?.reason || this.lastState?.reason || null,
      survivalReason: this.lastSurvivalDecision?.reason || this.lastState?.reason || null,
      interruptedTask: this.interruptedTask,
      pausedTask: this.pausedTaskDueToSurvival,
      queuedSurvivalTask: this.queuedSurvivalTask,
      lastSurvivalAction: this.lastSurvivalAction,
      canResumePreviousTask: Boolean(this.pausedTaskDueToSurvival && !this.isSafeModeEnabled(context)),
      foodStatus: this.lastState?.foodStatus || null,
      healthStatus: this.lastState?.healthStatus || null,
      nightStatus: this.lastState?.nightStatus || this.lastState?.timeStatus || null,
      inventoryStatus: this.lastState?.inventoryStatus || null,
      pausedTaskDueToSurvival: this.pausedTaskDueToSurvival,
      survivalCooldowns: Object.fromEntries([...this.cooldowns.entries()].map(([key, until]) => [key, Math.max(0, until - Date.now())])),
      sleepState: this.sleepState || buildSleepState(context, {})
    }
  }

  writeStatus(context, state = null) {
    try {
      const status = this.status(context)
      context.blackboard?.set?.('survival', {
        ...status,
        state: state || context.blackboard?.get?.('survival.state') || null
      })
      this.sleepState = state?.sleepState || status.sleepState || this.sleepState
    } catch {}
  }

  // 死了就没有「刚才那个场面」了（修缮 17）：冷却、上一轮决策、为生存挂起或
  // 打断的任务引用、睡觉状态、工地锚点，全部回到刚上线的样子。
  // 安全模式是玩家亲口开的，留着。只加这一个函数，不动别的判定。
  resetAfterDeath(reason = 'bot_died') {
    const hadAnchor = Boolean(this.worksite?.anchor)
    this.cooldowns.clear()
    this.lastSurvivalDecision = null
    this.pausedTaskDueToSurvival = null
    this.interruptedTask = null
    this.queuedSurvivalTask = null
    this.lastSurvivalAction = null
    this.lastState = null
    this.safeSince = null
    this.sleepState = null
    this.lastWorksite = null
    this.worksite?.reset?.()
    return { ok: true, reason: String(reason), worksiteAnchorCleared: hadAnchor }
  }

  isCoolingDown(key) {
    return (this.cooldowns.get(key) || 0) > Date.now()
  }

  setCooldown(key) {
    this.cooldowns.set(key, Date.now() + this.options.cooldownMs)
  }
}

function candidate(priority, reason) {
  return { priority, reason }
}

function canInterruptTaskType(type, survivalPriority) {
  if (LOW_PRIORITY_TASKS.has(type)) return true
  if (!COMBAT_TASKS.has(type)) return false
  return COMBAT_INTERRUPTING_PRIORITIES.has(survivalPriority)
}

function survivalReasonParams(priority) {
  if (!priority || priority === SURVIVAL_PRIORITIES.NORMAL) return {}
  const params = { reason: priority }
  if (CRITICAL_SURVIVAL_PRIORITIES.has(priority)) params.critical = true
  return params
}

function summarizeHostiles(mobs = {}) {
  const list = Array.isArray(mobs.hostileMobs) ? mobs.hostileMobs.slice() : []
  if (mobs.nearestHostileMob) list.push(mobs.nearestHostileMob)
  const unique = new Map()
  for (const hostile of list) {
    if (!hostile) continue
    const key = hostile.id ?? `${hostile.name || 'hostile'}:${hostile.distance ?? 'unknown'}`
    if (!unique.has(key)) unique.set(key, hostile)
  }
  const hostiles = [...unique.values()]
  const distances = hostiles
    .map(hostile => Number(hostile.distance))
    .filter(value => Number.isFinite(value))
  const nearestDistance = distances.length ? Math.min(...distances) : Infinity
  const reportedCount = Number(mobs.nearbyHostileCount ?? 0)
  const count = reportedCount > 0 ? reportedCount : hostiles.length
  return { count, hostiles, nearestDistance }
}

function findRetainedPausedTask(taskManager, trackedTask) {
  if (!taskManager || !trackedTask || !Array.isArray(taskManager.pausedStack)) return null
  return taskManager.pausedStack.find(task =>
    task === trackedTask ||
    (String(task?.id) === String(trackedTask.id) && task?.type === trackedTask.type)
  ) || null
}

function findLastRecoverableSurvivalPause(taskManager) {
  if (!Array.isArray(taskManager?.pausedStack)) return null
  for (let index = taskManager.pausedStack.length - 1; index >= 0; index--) {
    const task = taskManager.pausedStack[index]
    if (isRecoverableSurvivalPause(task)) return task
  }
  return null
}

function isRecoverableSurvivalPause(task) {
  if (!task || isSurvivalInterventionTask(task)) return false
  return task.manualPause === true &&
    task.state === 'PAUSED' &&
    String(task.pauseReason || '').startsWith('survival_')
}

function isSurvivalInterventionTask(task) {
  return task?.source === 'survival_system' || [
    'eat_food',
    'guard_player',
    'fight_nearby_mob',
    'return_to_base',
    'return_to_player',
    'sleep'
  ].includes(task?.type)
}

function toRecoveryTaskReference(task) {
  if (!task) return null
  return {
    id: task.id ?? null,
    type: task.type || null,
    source: task.source || null,
    state: task.state || null,
    pauseReason: task.pauseReason || null
  }
}

function findActiveSurvivalTask(taskManager, trackedTask) {
  if (!taskManager) return null
  const tasks = [
    taskManager.currentTask,
    ...(Array.isArray(taskManager.queue) ? taskManager.queue : [])
  ].filter(Boolean)
  return tasks.find(task =>
    String(task.id) !== String(trackedTask?.id) &&
    (task.source === 'survival_system' || ['eat_food', 'guard_player', 'fight_nearby_mob'].includes(task.type))
  ) || null
}

function summarizeRecoveryTask(task) {
  if (!task) return null
  return {
    id: task.id ?? null,
    type: task.type || null,
    state: task.state || null,
    priority: task.priority ?? null
  }
}

function isBurning(context, snapshotBot = {}) {
  const liveBot = context?.bot || {}
  const entity = liveBot.entity || {}
  return Boolean(
    snapshotBot.isBurning ||
    snapshotBot.isOnFire ||
    liveBot.isBurning ||
    liveBot.isOnFire ||
    entity.isBurning ||
    entity.isOnFire ||
    entity.onFire
  )
}

function isUrgentCombatDecision(decision = {}) {
  return decision.priority === SURVIVAL_PRIORITIES.DANGER_NEARBY &&
    decision.action === 'GUARD_PLAYER' &&
    Number(decision.nearbyHostiles || 0) > 0
}

function hasActiveOrQueuedGuardTask(taskManager) {
  if (!taskManager) return false
  if (taskManager.currentTask?.type === 'guard_player') return true
  return Array.isArray(taskManager.queue) && taskManager.queue.some(task => task?.type === 'guard_player')
}

function hasActiveOrQueuedSleepTask(taskManager) {
  if (!taskManager) return false
  if (taskManager.currentTask?.type === 'sleep') return true
  return Array.isArray(taskManager.queue) && taskManager.queue.some(task => task?.type === 'sleep')
}

function shouldDeferSurvivalForConstruction(context, survivalState = {}) {
  const task = findProtectedConstructionTask(context)
  if (!task) return { ok: false }
  return {
    ok: true,
    task,
    reason: 'construction_active_or_queued',
    priority: survivalState.survivalPriority || survivalState.priority || null
  }
}

function shouldAllowConstructionDefer(priority) {
  return ![
    SURVIVAL_PRIORITIES.NORMAL,
    SURVIVAL_PRIORITIES.CRITICAL_HEALTH,
    SURVIVAL_PRIORITIES.DANGER_NEARBY,
    SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL
  ].includes(priority)
}

function findProtectedConstructionTask(context = {}) {
  const tasks = []
  const taskManager = context.taskManager || null
  if (taskManager?.currentTask) tasks.push(taskManager.currentTask)
  if (Array.isArray(taskManager?.queue)) tasks.push(...taskManager.queue)
  if (Array.isArray(taskManager?.pausedStack)) tasks.push(...taskManager.pausedStack)

  const snapshotTasks = context.blackboard?.snapshot?.()?.tasks || {}
  if (snapshotTasks.currentTask) tasks.push(snapshotTasks.currentTask)
  if (Array.isArray(snapshotTasks.queue)) tasks.push(...snapshotTasks.queue)
  if (Array.isArray(snapshotTasks.pausedStack)) tasks.push(...snapshotTasks.pausedStack)

  return tasks.find(isProtectedConstructionTask) || null
}

function isProtectedConstructionTask(task = {}) {
  return Boolean(task && task.type === 'build_blueprint')
}

function shouldDeferReturnSafeForCurrentTask(context, survivalState = {}) {
  if (![
    SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE,
    SURVIVAL_PRIORITIES.INVENTORY_FULL,
    SURVIVAL_PRIORITIES.STUCK_OR_FALL_RISK
  ].includes(survivalState.survivalPriority)) return false
  const currentTask = context?.blackboard?.get?.('tasks.currentTask')
  if (!currentTask || currentTask.type !== 'build_blueprint') return false
  return currentTask.source === 'player_command' || currentTask.source === 'acceptance' || currentTask.priority >= 5
}

function foodStatus(food, options) {
  if (food <= options.criticalFoodThreshold) return 'critical'
  if (food <= options.lowFoodThreshold) return 'low'
  return 'ok'
}

function isSafeModeExitState(state = {}, options = {}) {
  const food = Number(state.food)
  const health = Number(state.health)
  const oxygen = Number(state.oxygen)
  const nearestHostileDistance = Number(state.nearestHostileDistance ?? Infinity)
  const unsafePriority = [
    SURVIVAL_PRIORITIES.CRITICAL_HEALTH,
    SURVIVAL_PRIORITIES.DANGER_NEARBY,
    SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL,
    SURVIVAL_PRIORITIES.STUCK_OR_FALL_RISK
  ].includes(state.survivalPriority)

  return food >= options.recoveryFoodThreshold &&
    health >= options.recoveryHealthThreshold &&
    oxygen >= options.recoveryOxygenThreshold &&
    state.isBurning !== true &&
    state.isDrowning !== true &&
    !['high', 'critical'].includes(state.dangerLevel) &&
    nearestHostileDistance > options.hostileInterruptDistance &&
    !unsafePriority
}

function distanceStatus(distanceFromBase, distanceFromPlayer, options) {
  if (distanceFromBase != null && distanceFromBase > options.farFromBaseDistance) return 'too_far_from_base'
  if (distanceFromPlayer != null && distanceFromPlayer > options.farFromPlayerDistance) return 'too_far_from_player'
  return 'ok'
}

function riskLevelForPriority(priority) {
  if ([SURVIVAL_PRIORITIES.CRITICAL_HEALTH, SURVIVAL_PRIORITIES.DANGER_NEARBY, SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL].includes(priority)) return 'high'
  if (priority === SURVIVAL_PRIORITIES.NORMAL) return 'low'
  return 'medium'
}

function distance(a, b) {
  if (!a || !b) return Infinity
  if (typeof a.distanceTo === 'function') return a.distanceTo(b)
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function roundDistance(value) {
  return Math.round(Number(value) * 100) / 100
}

function formatPosition(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function hasBase(context) {
  return Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
}

function isFoodName(name) {
  return ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot', 'baked_potato', 'golden_apple'].includes(String(name || ''))
}

function taskRisk(task) {
  if (!task) return 'none'
  if (['exploration', 'mining', 'mine_nearby_block'].includes(task.type)) return 'medium'
  if (['build_blueprint', 'farming', 'storage'].includes(task.type)) return 'low'
  if (['guard_player', 'return_to_base', 'return_to_player', 'eat_food', 'sleep'].includes(task.type)) return 'survival'
  return 'unknown'
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

function generateSurvivalReminderInBackground(context, event, decision) {
  Promise.resolve()
    .then(() => generateReminderMessage(event, context))
    .then(generated => {
      const text = generated?.text
      if (!text) return
      context.blackboard?.set?.('messages.lastSurvivalReminder.llm', {
        event,
        generated: { ...generated, text },
        decision
      })
    })
    .catch(err => {
      context.logger?.warn?.(`[SurvivalSystem] async reminder generation skipped: ${err.code || 'LLM_ERROR'} ${err.message}`)
    })
}

function suggestionForDecision(decision) {
  if (decision.action === 'RETURN_SAFE') return 'return to a known safe place'
  if (decision.action === 'EAT_FOOD') return 'eat before continuing'
  if (decision.action === 'STORE_INVENTORY') return 'store non-essential items'
  if (decision.action === 'STAY_PUT') return 'stay at the worksite and wait for a chest'
  if (decision.action === 'GUARD_PLAYER') return 'handle nearby danger first'
  if (decision.action === 'SLEEP') return 'sleep through the night if the bed is safe'
  if (decision.priority === SURVIVAL_PRIORITIES.SLEEP_NIGHT) return 'remind the player that it is night'
  return 'pause and reassess'
}

function reminderTypeForSurvivalPriority(priority) {
  if (priority === SURVIVAL_PRIORITIES.CRITICAL_HEALTH) return REMINDER_TYPES.LOW_HEALTH
  if ([SURVIVAL_PRIORITIES.LOW_FOOD_CRITICAL, SURVIVAL_PRIORITIES.LOW_FOOD_WARNING].includes(priority)) return REMINDER_TYPES.LOW_FOOD
  if (priority === SURVIVAL_PRIORITIES.DANGER_NEARBY) return REMINDER_TYPES.DANGER_NEARBY
  if (priority === SURVIVAL_PRIORITIES.INVENTORY_FULL) return REMINDER_TYPES.INVENTORY_FULL
  if (priority === SURVIVAL_PRIORITIES.NIGHT_UNSAFE) return REMINDER_TYPES.NIGHT_WARNING
  if (priority === SURVIVAL_PRIORITIES.SLEEP_NIGHT) return REMINDER_TYPES.NIGHT_WARNING
  return REMINDER_TYPES.GENERAL
}

module.exports = {
  PRIORITY_ORDER,
  SURVIVAL_PRIORITIES,
  SurvivalSystem
}
