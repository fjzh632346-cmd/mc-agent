const assert = require('assert')
const { Blackboard } = require('../core/blackboard')
const { SurvivalSystem, SURVIVAL_PRIORITIES } = require('../systems/survival-system')
const { WorksiteAnchor, constructionMaterialNames, releaseReturnForPlayerBuild, worksiteAnchorOptionsFromEnv } = require('../systems/worksite-anchor')
const { StorageSystem, selectItemsToStore } = require('../systems/storage-system')
const { GoalSystem } = require('../ai/goal-system')

const CHEST_ID = 54

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function key(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

// 修缮线第 8 轮的固定场景：工地在 (600,67,-19) 一带，
// 「基地」还指着几个月前那个 589 格外的坐标 (11,106,8)。
const WORKSITE = { x: 600, y: 67, z: -19 }
const OLD_BASE = { x: 11, y: 106, z: 8 }
const SITE_CHEST = { x: 596, y: 67, z: -23 }

function createContext(options = {}) {
  const position = options.position || WORKSITE
  const chests = options.chests || []
  const chestKeys = new Set(chests.map(key))

  const blackboard = new Blackboard({
    bot: {
      health: options.health ?? 20,
      food: options.food ?? 20,
      position,
      onGround: options.onGround ?? true
    },
    mobs: {
      dangerLevel: options.dangerLevel || 'none',
      nearestHostileMob: null,
      hostileMobs: [],
      nearbyHostileCount: 0
    },
    inventory: {
      emptySlots: options.emptySlots ?? 10,
      foodCount: options.foodCount ?? 0,
      counts: options.counts || {}
    },
    world: { isDay: options.isDay ?? true, weather: null },
    player: { ownerPosition: options.playerPosition || position },
    tasks: {
      currentTask: options.currentTask || null,
      queue: options.queue || [],
      pausedStack: options.pausedStack || []
    }
  })

  const memory = {
    summary() {
      return {
        world: {
          hasBaseLocation: true,
          chestLocations: options.rememberedChests?.length || 0,
          farmLocations: 0
        },
        task: { total: 0 }
      }
    },
    world: {
      baseLocation: { position: options.basePosition || OLD_BASE },
      chestLocations: () => (options.rememberedChests || []).map(pos => ({ position: pos }))
    }
  }

  const bot = {
    entity: { position: vec(position.x, position.y, position.z) },
    health: options.health ?? 20,
    food: options.food ?? 20,
    oxygen: 20,
    players: {},
    registry: { blocksByName: { chest: { id: CHEST_ID }, trapped_chest: { id: 55 }, barrel: { id: 56 } } },
    inventory: { items: () => [] },
    pathfinder: { stop() {}, setMovements() {}, setGoal() {} },
    findBlocks(query = {}) {
      if (!Array.isArray(query.matching) || !query.matching.includes(CHEST_ID)) return []
      const from = query.point || bot.entity.position
      const max = query.maxDistance ?? 32
      return chests
        .filter(chest => Math.sqrt((chest.x - from.x) ** 2 + (chest.y - from.y) ** 2 + (chest.z - from.z) ** 2) <= max)
        .map(chest => vec(chest.x, chest.y, chest.z))
    },
    blockAt(pos) {
      if (!pos) return null
      if (chestKeys.has(key(pos))) return { name: 'chest', type: CHEST_ID, id: CHEST_ID, position: vec(pos.x, pos.y, pos.z) }
      return { name: 'air', type: 0, id: 0, position: vec(pos.x, pos.y, pos.z) }
    }
  }

  const taskManager = {
    enqueued: [],
    paused: null,
    interrupted: null,
    interruptedByType: [],
    currentTask: options.currentTask || null,
    queue: options.queue || [],
    pausedStack: options.pausedStack || [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 100, type, params, priority, source }
      this.enqueued.push(task)
      return task
    },
    async pauseCurrent(reason) {
      this.paused = reason
      return true
    },
    async interruptCurrent(reason) {
      this.interrupted = reason
      return true
    },
    async interruptTaskByType(type, reason) {
      this.interruptedByType.push({ type, reason })
      if (this.currentTask?.type === type) this.currentTask = null
      this.queue = this.queue.filter(task => task.type !== type)
      return true
    },
    async resumePaused(reason) {
      this.resumed = reason
      return true
    }
  }

  const logs = []
  return {
    blackboard,
    bot,
    memory,
    taskManager,
    logs,
    logger: { log: message => logs.push(String(message)), warn() {}, error() {} },
    reminderOutput() {}
  }
}

function buildTask(overrides = {}) {
  return { id: 1, type: 'build_blueprint', state: 'RUNNING', priority: 5, source: 'player_command', ...overrides }
}

function createSystem(options = {}) {
  const clock = { now: options.startAt ?? 1000 }
  const anchor = new WorksiteAnchor({ now: () => clock.now, ...(options.anchor || {}) })
  const system = new SurvivalSystem({ cooldownMs: 1, worksiteAnchor: anchor, ...(options.survival || {}) })
  return { system, anchor, clock }
}

// 1. 施工活跃 + 背包满 → 就近卸货，施工任务只是暂停、不是被中断
async function testActiveBuildWithFullInventoryUnloadsNearby() {
  const { system } = createSystem()
  const task = buildTask()
  const ctx = createContext({ emptySlots: 0, currentTask: task, chests: [SITE_CHEST] })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(state.worksite.atWorksite, true)
  assert.strictEqual(decision.action, 'STORE_INVENTORY')
  // 就近卸货不再被「施工中先别管生存」那道闸挡回 REMIND
  assert.strictEqual(decision.deferredForTask, null)
  assert.strictEqual(decision.shouldInterrupt, true)

  const applied = await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(applied.type, 'TASK')
  assert.strictEqual(ctx.taskManager.enqueued.length, 1)
  const enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.type, 'storage')
  assert.strictEqual(enqueued.params.mode, 'INVENTORY_FULL_STORE')
  assert.strictEqual(enqueued.params.worksiteUnload, true)
  assert.strictEqual(enqueued.params.maxDistance, 32)
  assert.deepStrictEqual(enqueued.params.scanCenters.map(key), [key(SITE_CHEST)])
  // 施工任务是被暂停（可恢复），不是被 interrupt 掉
  assert.strictEqual(ctx.taskManager.paused, 'survival_inventory_full')
  assert.strictEqual(ctx.taskManager.interrupted, null)
  // 全程没有任何「回基地」
  assert.ok(!ctx.taskManager.enqueued.some(item => item.type.startsWith('return_to')))
}

// 2. 施工活跃 + 距基地远 → 根本不触发回家
async function testActiveBuildFarFromBaseDoesNotReturn() {
  const { system } = createSystem()
  const ctx = createContext({ currentTask: buildTask() })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(state.isFarFromBase, true)
  assert.ok(state.distanceFromBase > 500)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.NORMAL)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
  assert.ok(ctx.logs.some(line => line.includes('[WORKSITE_ANCHOR_HOLD] priority=TOO_FAR_FROM_BASE')))
}

// 3. 空闲 + 距基地远 → 行为与旧代码逐字相同（这轮不改空闲行为）
async function testIdleFarFromBaseKeepsOldBehaviour() {
  const { system } = createSystem()
  const ctx = createContext({})

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(state.worksite.active, false)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
  assert.strictEqual(decision.action, 'RETURN_SAFE')
  assert.strictEqual(ctx.taskManager.enqueued.length, 1)
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'return_to_base')
  assert.strictEqual(ctx.taskManager.enqueued[0].params.reason, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
}

// 3b. 空闲 + 背包满 + 只认得远处的箱子 → 仍走旧的 RETURN_SAFE（未被本轮波及）
async function testIdleInventoryFullKeepsOldBehaviour() {
  const { system } = createSystem()
  const ctx = createContext({ emptySlots: 0 })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(decision.action, 'RETURN_SAFE')
}

// 4. 保命触发仍然能打断施工（本轮不动保命仲裁）
async function testLifeSavingStillPreemptsBuildAtWorksite() {
  const { system } = createSystem()
  const ctx = createContext({ health: 4, foodCount: 0, currentTask: buildTask(), chests: [SITE_CHEST] })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.worksite.atWorksite, true)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.CRITICAL_HEALTH)
  assert.strictEqual(decision.action, 'RETURN_SAFE')
  assert.strictEqual(decision.shouldInterrupt, true)

  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(ctx.taskManager.interrupted, 'survival_critical_health')
  const enqueued = ctx.taskManager.enqueued[0]
  assert.strictEqual(enqueued.type, 'return_to_base')
  assert.strictEqual(enqueued.params.critical, true)
}

// 5. 在工地但半径内没有任何箱子 → 原地报 BLOCKED，绝不跑向旧基地
async function testWorksiteWithoutChestStaysPut() {
  const { system } = createSystem()
  const ctx = createContext({ emptySlots: 0, currentTask: buildTask(), chests: [] })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  const applied = await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  assert.strictEqual(system.actionForPriority(SURVIVAL_PRIORITIES.INVENTORY_FULL, ctx), 'STAY_PUT')
  assert.notStrictEqual(applied.type, 'TASK')
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
  assert.strictEqual(ctx.taskManager.interrupted, null)
}

// 5b. 半径外的箱子不算「就近」——旧基地那口箱子不能把她引走
async function testChestOutsideRadiusIsNotNearby() {
  const { system, anchor } = createSystem()
  const farChest = { x: WORKSITE.x + 80, y: WORKSITE.y, z: WORKSITE.z }
  const ctx = createContext({ emptySlots: 0, currentTask: buildTask(), chests: [farChest], rememberedChests: [OLD_BASE] })

  system.evaluateSurvivalState(ctx)
  const found = anchor.findNearbyStorage(ctx)

  assert.strictEqual(found.ok, false)
  assert.strictEqual(found.reason, 'no_chest_within_radius')
  assert.strictEqual(system.actionForPriority(SURVIVAL_PRIORITIES.INVENTORY_FULL, ctx), 'STAY_PUT')
}

// 6. 余温窗口：施工任务失败的那一瞬间不能被拉走；窗口走完才恢复旧行为
async function testGraceWindowCoversTheMomentAfterBuildFails() {
  const { system, anchor, clock } = createSystem({ anchor: { graceMs: 180000 } })
  const building = createContext({ currentTask: buildTask() })
  assert.strictEqual(system.evaluateSurvivalState(building).survivalPriority, SURVIVAL_PRIORITIES.NORMAL)

  // 建造任务失败并被移出 TaskManager，人还站在工地上
  clock.now += 1000
  const justFailed = createContext({})
  justFailed.taskManager.pausedStack = []
  const heldState = system.evaluateSurvivalState(justFailed)
  assert.strictEqual(heldState.worksite.active, true)
  assert.strictEqual(heldState.worksite.ageMs, 1000)
  assert.strictEqual(heldState.survivalPriority, SURVIVAL_PRIORITIES.NORMAL)

  // 余温窗口走完，回到旧的空闲行为
  clock.now += 180001
  const expired = createContext({})
  const expiredState = system.evaluateSurvivalState(expired)
  assert.strictEqual(expiredState.worksite.active, false)
  assert.strictEqual(expiredState.survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
  assert.strictEqual(anchor.current(), null)
}

// 6b. 走远离开工地就不再受锚点保护（锚点是「在工地」而不是「盖过房」）
async function testAnchorOnlyHoldsWhileNearTheWorksite() {
  const { system, clock } = createSystem()
  system.evaluateSurvivalState(createContext({ currentTask: buildTask() }))

  clock.now += 1000
  const walkedOff = createContext({ position: { x: WORKSITE.x - 200, y: WORKSITE.y, z: WORKSITE.z } })
  const state = system.evaluateSurvivalState(walkedOff)

  assert.strictEqual(state.worksite.active, true)
  assert.strictEqual(state.worksite.atWorksite, false)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
}

// 7. 开关关掉 → 逐字回到旧行为
async function testSwitchRevertsToOldBehaviour() {
  const { system } = createSystem({ anchor: { enabled: false } })
  const ctx = createContext({ emptySlots: 0, currentTask: buildTask(), chests: [SITE_CHEST] })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)

  assert.strictEqual(state.worksite.active, false)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.INVENTORY_FULL)
  // 旧行为：施工中一律推迟，不就近卸货
  assert.strictEqual(decision.action, 'REMIND')
  assert.strictEqual(decision.deferredForTask, 'build_blueprint')

  const idle = createContext({})
  const idleState = system.evaluateSurvivalState(idle)
  assert.strictEqual(idleState.survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)

  assert.deepStrictEqual(worksiteAnchorOptionsFromEnv({ WORKSITE_ANCHOR: 'false' }), { enabled: false })
  assert.deepStrictEqual(worksiteAnchorOptionsFromEnv({}), {})
  assert.deepStrictEqual(
    worksiteAnchorOptionsFromEnv({ WORKSITE_ANCHOR_GRACE_MS: '60000', WORKSITE_ANCHOR_RADIUS: '48', WORKSITE_STORAGE_RADIUS: '24' }),
    { graceMs: 60000, radius: 48, storageRadius: 24 }
  )
}

// 8. 上线时被排下的「回家」，在施工任务入队后要作废——否则 HIGH 压 MEDIUM，
//    她会先走完几百格再回来盖房。
async function testQueuedBuildCancelsObsoleteReturn() {
  const { system } = createSystem()
  const runningReturn = {
    id: 1,
    type: 'return_to_base',
    state: 'RUNNING',
    source: 'survival_system',
    params: { reason: SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE }
  }
  const queuedBuild = buildTask({ id: 2, state: 'IDLE' })
  const ctx = createContext({ currentTask: runningReturn, queue: [queuedBuild] })

  system.evaluateSurvivalState(ctx)
  const released = await system.releaseObsoleteReturn(ctx)

  assert.strictEqual(released.ok, true)
  assert.deepStrictEqual(ctx.taskManager.interruptedByType, [{ type: 'return_to_base', reason: 'worksite_anchor_active' }])
  assert.ok(ctx.logs.some(line => line.includes('[WORKSITE_RETURN_CANCELLED]')))
}

// 8b. 保命撤退和玩家亲口下的回家指令一律不撤
async function testCriticalAndPlayerReturnsAreNeverCancelled() {
  const { system } = createSystem()
  const criticalReturn = {
    id: 1,
    type: 'return_to_base',
    state: 'RUNNING',
    source: 'survival_system',
    params: { reason: SURVIVAL_PRIORITIES.CRITICAL_HEALTH, critical: true }
  }
  const ctx = createContext({ currentTask: criticalReturn, queue: [buildTask({ id: 2, state: 'IDLE' })] })
  system.evaluateSurvivalState(ctx)
  assert.strictEqual((await system.releaseObsoleteReturn(ctx)).reason, 'no_obsolete_return_task')

  const playerReturn = { id: 3, type: 'return_to_base', state: 'RUNNING', source: 'player_command', params: {} }
  const ctx2 = createContext({ currentTask: playerReturn, queue: [buildTask({ id: 4, state: 'IDLE' })] })
  system.evaluateSurvivalState(ctx2)
  assert.strictEqual((await system.releaseObsoleteReturn(ctx2)).reason, 'no_obsolete_return_task')

  assert.deepStrictEqual(ctx.taskManager.interruptedByType, [])
  assert.deepStrictEqual(ctx2.taskManager.interruptedByType, [])
}

// 8c. 不在工地上时不撤——空闲的回家任务照旧
async function testObsoleteReturnIsKeptWhenNotAtWorksite() {
  const { system } = createSystem()
  const runningReturn = {
    id: 1,
    type: 'return_to_base',
    state: 'RUNNING',
    source: 'survival_system',
    params: { reason: SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE }
  }
  const ctx = createContext({ currentTask: runningReturn })
  system.evaluateSurvivalState(ctx)

  const released = await system.releaseObsoleteReturn(ctx)
  assert.strictEqual(released.ok, false)
  assert.strictEqual(released.reason, 'not_at_worksite')
  assert.deepStrictEqual(ctx.taskManager.interruptedByType, [])
}

// 9. 存档层的硬边界：超过 maxDistance 的候选箱子直接不进候选表，
//    记忆里那口 589 格外的旧箱子不能因为「只剩它一个」而被选中。
async function testStorageCandidatesRespectMaxDistance() {
  const storage = new StorageSystem()
  const ctx = createContext({ chests: [], rememberedChests: [] })
  ctx.memory.world.nearestChest = () => ({ position: OLD_BASE, type: 'chest' })
  ctx.bot.blockAt = pos => (
    key(pos) === key(OLD_BASE)
      ? { name: 'chest', type: CHEST_ID, id: CHEST_ID, position: vec(OLD_BASE.x, OLD_BASE.y, OLD_BASE.z) }
      : { name: 'air', type: 0, id: 0, position: vec(pos.x, pos.y, pos.z) }
  )

  const unbounded = storage.buildChestCandidates(ctx, {})
  assert.strictEqual(unbounded.length, 1)
  assert.strictEqual(key(unbounded[0].position), key(OLD_BASE))

  const bounded = storage.buildChestCandidates(ctx, { maxDistance: 32 })
  assert.strictEqual(bounded.length, 0)
}

// 9b. 半径内的箱子照常入选，maxDistance 不是把候选表一刀切空
async function testStorageCandidatesKeepNearbyChest() {
  const storage = new StorageSystem()
  const ctx = createContext({ chests: [SITE_CHEST] })

  const bounded = storage.buildChestCandidates(ctx, { maxDistance: 32, skipUtilitySearch: true, skipMemorySearch: true })
  assert.strictEqual(bounded.length, 1)
  assert.strictEqual(key(bounded[0].position), key(SITE_CHEST))
}

// 10. 现场扫描有缓存，生存循环不会每 tick 都去扫方块
async function testNearbyStorageProbeIsCached() {
  const { anchor, clock } = createSystem()
  let scans = 0
  const ctx = createContext({ chests: [SITE_CHEST], currentTask: buildTask() })
  const findBlocks = ctx.bot.findBlocks.bind(ctx.bot)
  ctx.bot.findBlocks = query => {
    scans += 1
    return findBlocks(query)
  }

  anchor.update(ctx)
  assert.strictEqual(anchor.findNearbyStorage(ctx).source, 'live_scan')
  const scansAfterFirst = scans
  assert.ok(scansAfterFirst > 0)

  assert.strictEqual(anchor.findNearbyStorage(ctx).cached, true)
  assert.strictEqual(scans, scansAfterFirst)

  clock.now += 15001
  assert.strictEqual(anchor.findNearbyStorage(ctx).cached, undefined)
  assert.ok(scans > scansAfterFirst)
}

// 11. 施工任务自己记着的暂存箱优先于现场扫描（走既有 staging 链路）
async function testStagingChestFromConstructionRunWins() {
  const { anchor } = createSystem()
  const stagingChest = { x: WORKSITE.x + 2, y: WORKSITE.y, z: WORKSITE.z + 1 }
  const task = buildTask()
  task.system = { session: { constructionRun: { stagingChests: [{ position: stagingChest }] } } }
  const ctx = createContext({ currentTask: task, chests: [SITE_CHEST] })

  anchor.update(ctx)
  const found = anchor.findNearbyStorage(ctx)

  assert.strictEqual(found.source, 'construction_staging_chest')
  assert.deepStrictEqual(found.positions.map(key), [key(stagingChest)])
}

// 8d. 走真实驱动（GoalSystem，线上唯一跑生存的地方）也要撤得掉
async function testGoalSystemCancelsObsoleteReturn() {
  const { system } = createSystem()
  const goalSystem = new GoalSystem({ survivalSystem: system })
  const runningReturn = {
    id: 1,
    type: 'return_to_base',
    state: 'RUNNING',
    source: 'survival_system',
    params: { reason: SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE }
  }
  const ctx = createContext({ emptySlots: 2, currentTask: runningReturn, queue: [buildTask({ id: 2, state: 'IDLE' })] })

  await goalSystem.update(ctx)

  assert.deepStrictEqual(ctx.taskManager.interruptedByType, [{ type: 'return_to_base', reason: 'worksite_anchor_active' }])
}

// 13. 卸完货、生存回到 NORMAL 之后，挂起的施工任务必须有人叫醒——
//     哪怕天黑着、夜间提醒一直占着目标候选位。
async function testGoalSystemResumesPausedBuildOnceNormal() {
  const { system } = createSystem()
  const goalSystem = new GoalSystem({ survivalSystem: system })
  const ctx = createContext({ isDay: false, position: OLD_BASE, basePosition: OLD_BASE })
  const paused = { id: 7, type: 'build_blueprint', state: 'PAUSED', manualPause: true, pauseReason: 'survival_inventory_full' }
  ctx.taskManager.pausedStack = [paused]
  ctx.taskManager.currentTask = null
  system.pausedTaskDueToSurvival = paused

  const state = system.evaluateSurvivalState(ctx)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.NORMAL)
  assert.ok(goalSystem.detectGoals(ctx).length > 0)

  await goalSystem.update(ctx)

  assert.strictEqual(ctx.taskManager.resumed, 'survival_recovered')
}

// 14. 就近卸货不许把这一栋还要用的材料倒掉——倒了下一秒材料闸门又得取回来
async function testWorksiteUnloadKeepsConstructionMaterials() {
  const { system } = createSystem()
  const task = buildTask()
  task.system = { session: { requiredMaterials: { oak_planks: 131, cobblestone: 20 } } }
  const ctx = createContext({ emptySlots: 0, currentTask: task, chests: [SITE_CHEST] })

  const state = system.evaluateSurvivalState(ctx)
  await system.applySurvivalDecision(ctx, system.createSurvivalPlan(ctx, state))

  const params = ctx.taskManager.enqueued[0].params
  assert.deepStrictEqual([...params.keepItems].sort(), ['cobblestone', 'oak_planks'])
  assert.deepStrictEqual(constructionMaterialNames(ctx).sort(), ['cobblestone', 'oak_planks'])

  // 存档层真的会把它们跳过（走真正的选件函数，不是复述一遍规则）
  ctx.blackboard.set('inventory.counts', { oak_planks: 124, cobblestone: 200, gravel: 64 })
  const kept = selectItemsToStore(ctx, { mode: 'nonEssential', keepItems: params.keepItems })
  assert.ok(!kept.some(item => item.itemName === 'oak_planks'))
  assert.ok(!kept.some(item => item.itemName === 'cobblestone'))
  assert.ok(kept.some(item => item.itemName === 'gravel'))
  const unfiltered = selectItemsToStore(ctx, { mode: 'nonEssential' })
  assert.ok(unfiltered.some(item => item.itemName === 'oak_planks'))
}

// 15. 真机复现的那一条：她正在往旧基地走时玩家下施工令。
//     生存循环这时被移动 await 卡住跑不了，所以撤销必须挂在指令那一侧。
async function testPlayerBuildCommandCancelsRunningReturn() {
  const runningReturn = {
    id: 1,
    type: 'return_to_base',
    state: 'RUNNING',
    source: 'survival_system',
    params: { reason: SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE }
  }
  const ctx = createContext({ currentTask: runningReturn, position: { x: WORKSITE.x - 200, y: 64, z: WORKSITE.z } })

  const released = await releaseReturnForPlayerBuild(ctx, {})

  assert.strictEqual(released.ok, true)
  assert.deepStrictEqual(ctx.taskManager.interruptedByType, [{ type: 'return_to_base', reason: 'player_build_command' }])
  assert.ok(ctx.logs.some(line => line.includes('trigger=player_build_command')))

  // 开关关掉就不撤
  const ctx2 = createContext({ currentTask: { ...runningReturn } })
  const off = await releaseReturnForPlayerBuild(ctx2, { WORKSITE_ANCHOR: 'false' })
  assert.strictEqual(off.reason, 'worksite_anchor_disabled')
  assert.deepStrictEqual(ctx2.taskManager.interruptedByType, [])

  // 保命撤退不撤
  const ctx3 = createContext({
    currentTask: { ...runningReturn, params: { reason: SURVIVAL_PRIORITIES.CRITICAL_HEALTH, critical: true } }
  })
  assert.strictEqual((await releaseReturnForPlayerBuild(ctx3, {})).reason, 'no_obsolete_return_task')
}

// 16. 夜里那条同族的回家：在工地上不往老基地走（第 9 轮，老板决策 44）
//     基地故意摆在 40 格外：> 24（夜里那条的门槛）但 <= 64（白天那条的门槛），
//     这样触发的只有 NIGHT_UNSAFE，不会被 TOO_FAR_FROM_BASE 抢先，测的就是新加的这一条。
const NIGHT_BASE = { x: WORKSITE.x + 40, y: WORKSITE.y, z: WORKSITE.z }

async function testNightUnsafeHeldAtWorksite() {
  const { system } = createSystem()
  const ctx = createContext({ isDay: false, basePosition: NIGHT_BASE, currentTask: buildTask() })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(state.isNight, true)
  assert.strictEqual(state.distanceFromBase, 40)
  assert.strictEqual(state.isFarFromBase, false)
  assert.strictEqual(state.worksite.atWorksite, true)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.NORMAL)
  assert.strictEqual(ctx.taskManager.enqueued.length, 0)
  assert.ok(ctx.logs.some(line => line.includes('[WORKSITE_ANCHOR_HOLD] priority=NIGHT_UNSAFE')))
}

// 16b. 不在工地上照旧：夜里离基地远还是回家（本轮不改空闲行为）
async function testNightUnsafeUnchangedAwayFromWorksite() {
  const { system } = createSystem()
  const ctx = createContext({ isDay: false, basePosition: NIGHT_BASE })

  const state = system.evaluateSurvivalState(ctx)
  const decision = system.createSurvivalPlan(ctx, state)
  await system.applySurvivalDecision(ctx, decision)

  assert.strictEqual(state.worksite.active, false)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.NIGHT_UNSAFE)
  assert.strictEqual(decision.action, 'RETURN_SAFE')
  assert.strictEqual(ctx.taskManager.enqueued[0].type, 'return_to_base')
  assert.strictEqual(ctx.taskManager.enqueued[0].params.reason, SURVIVAL_PRIORITIES.NIGHT_UNSAFE)

  // 开关关掉 → 工地上也照旧回家
  const { system: off } = createSystem({ anchor: { enabled: false } })
  const ctx2 = createContext({ isDay: false, basePosition: NIGHT_BASE, currentTask: buildTask() })
  assert.strictEqual(off.evaluateSurvivalState(ctx2).survivalPriority, SURVIVAL_PRIORITIES.NIGHT_UNSAFE)
}

// 16c. 只压「离基地太远」那一半；「离玩家太远」照旧管跟丢
async function testNightUnsafeStillFiresWhenPlayerIsFar() {
  const { system } = createSystem()
  const ctx = createContext({
    isDay: false,
    basePosition: NIGHT_BASE,
    currentTask: buildTask(),
    playerPosition: { x: WORKSITE.x + 200, y: WORKSITE.y, z: WORKSITE.z }
  })

  const state = system.evaluateSurvivalState(ctx)

  assert.strictEqual(state.worksite.atWorksite, true)
  assert.strictEqual(state.survivalPriority, SURVIVAL_PRIORITIES.NIGHT_UNSAFE)
}

// 12. 用例不是摆设：把锚点关掉，第 1、2 条立刻回到被拉走的旧结局
async function testCasesFailWithoutTheAnchor() {
  const { system } = createSystem({ anchor: { enabled: false } })

  const full = createContext({ emptySlots: 0, chests: [SITE_CHEST] })
  const fullState = system.evaluateSurvivalState(full)
  assert.strictEqual(system.createSurvivalPlan(full, fullState).action, 'RETURN_SAFE')

  const far = createContext({ currentTask: null })
  const farState = system.evaluateSurvivalState(far)
  assert.strictEqual(farState.survivalPriority, SURVIVAL_PRIORITIES.TOO_FAR_FROM_BASE)
}

// 修缮 15 顺带项：让日志能分辨「锚点这段时间根本没被调到」和
// 「调到了但没进刷新分支」。建造 22 的现场是前者——整条 tick 卡在一次施工
// update 里，锚点连着 17 分 28 秒没被刷过，而当时两种情况在日志里长得一样。
async function testAnchorUpdateHeartbeatSeparatesSilenceFromMissedBranch() {
  const { anchor, clock } = createSystem()
  const task = buildTask()
  const ctx = createContext({ currentTask: task })
  const beats = () => ctx.logs.filter(line => line.startsWith('[WORKSITE_ANCHOR_UPDATE]'))

  anchor.update(ctx)
  clock.now += 500
  anchor.update(ctx)
  assert.strictEqual(beats().length, 1, '限频窗口内不该再打一条')
  assert.ok(beats()[0].includes('calls=1 sinceLastCallMs=first refreshed=true reason=refreshed'), beats()[0])

  // 施工任务终态了：调到了，但进不去刷新分支
  task.state = 'FAILED'
  ctx.taskManager.currentTask = null
  ctx.blackboard.set('tasks.currentTask', null)
  clock.now += 9500
  anchor.update(ctx)
  assert.strictEqual(beats().length, 2)
  assert.ok(
    beats()[1].includes('calls=3 sinceLastCallMs=9500 refreshed=false reason=no_active_construction_task'),
    beats()[1]
  )

  // 上游循环卡住：整整十七分半没人调过来，下一条心跳自己把这个洞报出来
  clock.now += 1047700
  anchor.update(ctx)
  assert.strictEqual(beats().length, 3)
  assert.ok(beats()[2].includes('calls=4 sinceLastCallMs=1047700'), beats()[2])
}

// 同一条洞的另一半：生存评估自己有没有被调到。心跳打在入口，
// 出口那两行 [survival] 只能证明「跑完了」。
async function testSurvivalEvalHeartbeatCountsTheGap() {
  const { system, clock } = createSystem({ survival: { now: () => clock.now } })
  const ctx = createContext({ currentTask: buildTask() })
  const beats = () => ctx.logs.filter(line => line.startsWith('[SURVIVAL_EVAL_HEARTBEAT]'))

  system.evaluateSurvivalState(ctx)
  clock.now += 500
  system.evaluateSurvivalState(ctx)
  assert.strictEqual(beats().length, 1, '限频窗口内不该再打一条')
  assert.ok(beats()[0].includes('calls=1 sinceLastCallMs=first currentTask=build_blueprint#1'), beats()[0])

  clock.now += 1047700
  system.evaluateSurvivalState(ctx)
  assert.strictEqual(beats().length, 2)
  assert.ok(beats()[1].includes('calls=3 sinceLastCallMs=1047700'), beats()[1])
}

async function run() {
  const originalLog = console.log
  console.log = () => {}
  try {
    await testActiveBuildWithFullInventoryUnloadsNearby()
    await testActiveBuildFarFromBaseDoesNotReturn()
    await testIdleFarFromBaseKeepsOldBehaviour()
    await testIdleInventoryFullKeepsOldBehaviour()
    await testLifeSavingStillPreemptsBuildAtWorksite()
    await testWorksiteWithoutChestStaysPut()
    await testChestOutsideRadiusIsNotNearby()
    await testGraceWindowCoversTheMomentAfterBuildFails()
    await testAnchorOnlyHoldsWhileNearTheWorksite()
    await testSwitchRevertsToOldBehaviour()
    await testQueuedBuildCancelsObsoleteReturn()
    await testCriticalAndPlayerReturnsAreNeverCancelled()
    await testObsoleteReturnIsKeptWhenNotAtWorksite()
    await testGoalSystemCancelsObsoleteReturn()
    await testGoalSystemResumesPausedBuildOnceNormal()
    await testStorageCandidatesRespectMaxDistance()
    await testStorageCandidatesKeepNearbyChest()
    await testNearbyStorageProbeIsCached()
    await testStagingChestFromConstructionRunWins()
    await testWorksiteUnloadKeepsConstructionMaterials()
    await testPlayerBuildCommandCancelsRunningReturn()
    await testNightUnsafeHeldAtWorksite()
    await testNightUnsafeUnchangedAwayFromWorksite()
    await testNightUnsafeStillFiresWhenPlayerIsFar()
    await testCasesFailWithoutTheAnchor()
    await testAnchorUpdateHeartbeatSeparatesSilenceFromMissedBranch()
    await testSurvivalEvalHeartbeatCountsTheGap()
  } finally {
    console.log = originalLog
  }
  console.log('worksite-anchor tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
