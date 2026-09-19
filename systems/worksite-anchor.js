// 工地锚点。
//
// 「回基地」这条生存动作瞄准的是 world-memory 里 baseLocation 那一个点——
// 它只由玩家一句「记住这里是基地」写入，没有任何自动更新机制，
// 所以工地搬到几百格外之后，它还指着几个月前那个坐标。
// 结果是：施工任务一结束（哪怕是失败后立刻要重来的那种），
// INVENTORY_FULL / TOO_FAR_FROM_BASE 就会把她从工地拽走几百格。
//
// 这里给「家」补一个临时的、跟着施工走的锚点：施工任务活着的时候，
// 锚点每次生存评估都刷到她当前站的地方；施工任务结束后，锚点在
// graceMs 的余温窗口内继续有效——因为人还站在工地上，工地就还是家。
//
// 锚点只影响两条「不危险但要回家」的判定，保命档（血量/饥饿/危险）
// 一概不看它。WORKSITE_ANCHOR=false 可整体关掉，回到旧行为。
const storageActions = require('../actions/storage')

const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,
  // 施工任务结束后，锚点还能撑多久（毫秒）。她失败后原地重来通常在秒级。
  graceMs: 180000,
  // 距锚点多远还算「在工地」。与 survival 的 farFromBaseDistance 取同一个数，
  // 免得出现「离工地够近但已经算离基地太远」的夹缝。
  radius: 64,
  // 「就近卸货」的箱子搜索半径。
  storageRadius: 32,
  // 现场扫描的结果缓存多久，避免生存循环每 500ms 扫一次方块。
  storageProbeCacheMs: 15000
})

// 心跳日志的限频窗口。锚点每 500ms 被刷一次，逐条打会淹掉日志；
// 只要能分辨「这段时间根本没被调到」和「调到了但没进刷新分支」就够了。
const HEARTBEAT_LOG_INTERVAL_MS = 10000

const CONSTRUCTION_TASK_TYPE = 'build_blueprint'
const TERMINAL_TASK_STATES = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED'])

class WorksiteAnchor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    // 余温窗口与扫描缓存都靠时钟，注入一个假时钟才能把这两条钉死在单测里。
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.anchor = null
    this.storageProbe = null
    this.updateHeartbeat = { calls: 0, lastCallAt: null, lastLogAt: null }
  }

  reset() {
    this.anchor = null
    this.storageProbe = null
  }

  isEnabled() {
    return this.options.enabled !== false
  }

  // 施工任务活着就把锚点刷到她当前位置；否则保留旧锚点让余温窗口自己走完。
  update(context = {}, now = this.now()) {
    if (!this.isEnabled()) return null
    const task = findConstructionTask(context)
    const position = botPosition(context)
    this.noteUpdateHeartbeat(context, task, position, now)
    if (task && position) {
      this.anchor = {
        position,
        taskId: task.id ?? null,
        taskState: task.state || null,
        source: 'active_construction_task',
        updatedAt: now
      }
    }
    return this.current(now)
  }

  // 修缮 14 留下的问题：施工中途锚点连着十几分钟没刷新，而日志里
  // 「没被调到」和「调到了但没进刷新分支」长得一模一样。这条限频心跳
  // 把两者分开：sinceLastCallMs 很大 = 没被调到（上游循环卡住了），
  // sinceLastCallMs 正常而 refreshed=false = 调到了但没找到在跑的施工任务。
  // 只记账，不改任何判定。
  noteUpdateHeartbeat(context, task, position, now = this.now()) {
    const beat = this.updateHeartbeat
    beat.calls += 1
    const sinceLastCallMs = beat.lastCallAt == null ? null : now - beat.lastCallAt
    beat.lastCallAt = now
    if (beat.lastLogAt != null && now - beat.lastLogAt < HEARTBEAT_LOG_INTERVAL_MS) return null

    beat.lastLogAt = now
    const refreshed = Boolean(task && position)
    const reason = refreshed
      ? 'refreshed'
      : task
        ? 'no_bot_position'
        : 'no_active_construction_task'
    const anchorAgeMs = this.anchor ? now - this.anchor.updatedAt : null
    const line = `[WORKSITE_ANCHOR_UPDATE] calls=${beat.calls} sinceLastCallMs=${sinceLastCallMs ?? 'first'} refreshed=${refreshed} reason=${reason} taskId=${task?.id ?? 'none'} anchorAgeMs=${anchorAgeMs ?? 'none'} graceMs=${this.options.graceMs}`
    log(context, line)
    return line
  }

  current(now = this.now()) {
    if (!this.isEnabled() || !this.anchor) return null
    const ageMs = now - this.anchor.updatedAt
    if (ageMs > this.options.graceMs) return null
    return { ...this.anchor, ageMs }
  }

  // 生存状态里带出去的那一份描述，供日志与单测断言。
  describe(context = {}, now = this.now()) {
    const anchor = this.current(now)
    if (!anchor) {
      return { active: false, atWorksite: false, position: null, distance: null, ageMs: null, taskId: null }
    }
    const position = botPosition(context)
    const value = position ? positionDistance(position, anchor.position) : null
    return {
      active: true,
      atWorksite: value != null && value <= this.options.radius,
      position: anchor.position,
      distance: value == null ? null : Math.round(value * 100) / 100,
      ageMs: anchor.ageMs,
      taskId: anchor.taskId,
      source: anchor.source
    }
  }

  isAtWorksite(context = {}, now = this.now()) {
    return this.describe(context, now).atWorksite === true
  }

  // 「就近」的定义：以她自己为圆心 storageRadius 格以内的容器。
  // 三个来源，从便宜到贵：施工任务自己的暂存箱记录 → 世界记忆里的箱子 → 现场扫描。
  // 扫描结果缓存 storageProbeCacheMs，生存循环不会每 tick 都去扫方块。
  findNearbyStorage(context = {}, now = this.now()) {
    const position = botPosition(context)
    if (!position) return { ok: false, reason: 'bot_position_unknown', positions: [] }

    const radius = this.options.storageRadius
    const fromRun = stagingChestPositions(context).filter(pos => positionDistance(position, pos) <= radius)
    if (fromRun.length) return { ok: true, source: 'construction_staging_chest', positions: fromRun }

    const fromMemory = rememberedChestPositions(context).filter(pos => positionDistance(position, pos) <= radius)
    if (fromMemory.length) return { ok: true, source: 'world_memory_chest', positions: fromMemory }

    if (this.storageProbe && now - this.storageProbe.at < this.options.storageProbeCacheMs &&
      positionDistance(position, this.storageProbe.from) <= 4) {
      return { ...this.storageProbe.result, cached: true }
    }

    const scanned = scanNearbyChests(context, radius)
    const result = scanned.length
      ? { ok: true, source: 'live_scan', positions: scanned }
      : { ok: false, reason: 'no_chest_within_radius', positions: [] }
    this.storageProbe = { at: now, from: position, result }
    return result
  }
}

function findConstructionTask(context = {}) {
  const tasks = []
  const taskManager = context.taskManager || null
  if (taskManager?.currentTask) tasks.push(taskManager.currentTask)
  if (Array.isArray(taskManager?.queue)) tasks.push(...taskManager.queue)
  if (Array.isArray(taskManager?.pausedStack)) tasks.push(...taskManager.pausedStack)

  const snapshotTasks = context.blackboard?.snapshot?.()?.tasks || {}
  if (snapshotTasks.currentTask) tasks.push(snapshotTasks.currentTask)
  if (Array.isArray(snapshotTasks.queue)) tasks.push(...snapshotTasks.queue)
  if (Array.isArray(snapshotTasks.pausedStack)) tasks.push(...snapshotTasks.pausedStack)

  return tasks.find(task =>
    task && task.type === CONSTRUCTION_TASK_TYPE && !TERMINAL_TASK_STATES.has(String(task.state || ''))
  ) || null
}

function constructionTaskObjects(context = {}) {
  const taskManager = context.taskManager || null
  return [
    taskManager?.currentTask,
    ...(Array.isArray(taskManager?.queue) ? taskManager.queue : []),
    ...(Array.isArray(taskManager?.pausedStack) ? taskManager.pausedStack : [])
  ].filter(task => task && task.type === CONSTRUCTION_TASK_TYPE)
}

// 这一栋还要用的材料。就近卸货时把它们留在身上——
// 否则她会把 131 块木板倒进暂存箱，下一秒材料闸门再把它们取回来。
function constructionMaterialNames(context = {}) {
  const names = new Set()
  for (const task of constructionTaskObjects(context)) {
    const sources = [
      task.system?.session?.requiredMaterials,
      task.system?.session?.materialPlan?.requiredMaterials,
      task.system?.session?.materialPlan?.formalRequiredMaterials,
      task.materialPlan?.requiredMaterials,
      task.materialPlan?.formalRequiredMaterials
    ]
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue
      for (const [name, count] of Object.entries(source)) {
        if (Number(count) > 0) names.add(name)
      }
    }
  }
  return [...names]
}

function stagingChestPositions(context = {}) {
  const tasks = constructionTaskObjects(context)

  const positions = []
  for (const task of tasks) {
    const chests = task.system?.session?.constructionRun?.stagingChests
    if (!Array.isArray(chests)) continue
    for (const chest of chests) {
      const position = normalizePosition(chest?.position || chest)
      if (position) positions.push(position)
    }
  }
  return positions
}

function rememberedChestPositions(context = {}) {
  const world = context.memory?.world
  // WorldMemory 把它做成方法，测试替身常直接给数组，两种都收。
  const list = typeof world?.chestLocations === 'function' ? world.chestLocations() : world?.chestLocations
  const records = Array.isArray(list) ? list : []
  return records.map(record => normalizePosition(record?.position || record)).filter(Boolean)
}

function scanNearbyChests(context = {}, radius) {
  try {
    const found = storageActions.findNearbyChests(context, radius, { scanOnlyProvidedCenters: false })
    if (!found?.ok) return []
    const position = botPosition(context)
    return (found.data?.chests || [])
      .map(chest => normalizePosition(chest?.position))
      .filter(pos => pos && (!position || positionDistance(position, pos) <= radius))
  } catch {
    return []
  }
}

// 生存系统为了「旧基地」自动排下的那趟非紧急回家。
// 玩家亲口下的回家指令（source=player_command）和保命撤退（critical）都不在此列。
const HELD_RETURN_REASONS = new Set(['INVENTORY_FULL', 'TOO_FAR_FROM_BASE'])

function findObsoleteWorksiteReturnTask(taskManager) {
  const tasks = [
    taskManager?.currentTask,
    ...(Array.isArray(taskManager?.queue) ? taskManager.queue : []),
    ...(Array.isArray(taskManager?.pausedStack) ? taskManager.pausedStack : [])
  ].filter(Boolean)
  return tasks.find(task =>
    ['return_to_base', 'return_to_player'].includes(task.type) &&
    task.source === 'survival_system' &&
    task.params?.critical !== true &&
    HELD_RETURN_REASONS.has(String(task.params?.reason || ''))
  ) || null
}

// 撤掉那趟回家。它是 HIGH、施工是 MEDIUM，不撤的话施工只能排队干等她走完几百格。
async function cancelObsoleteWorksiteReturn(context = {}, options = {}) {
  if (options.enabled === false) return { ok: false, reason: 'worksite_anchor_disabled' }
  const taskManager = context.taskManager
  if (!taskManager?.interruptTaskByType) return { ok: false, reason: 'task_manager_unavailable' }
  const task = findObsoleteWorksiteReturnTask(taskManager)
  if (!task) return { ok: false, reason: 'no_obsolete_return_task' }

  const reason = options.reason || 'worksite_anchor_active'
  log(context, `[WORKSITE_RETURN_CANCELLED] task=${task.type}#${task.id ?? 'unknown'} returnReason=${task.params?.reason || 'unknown'} trigger=${options.trigger || reason}`)
  const cancelled = await taskManager.interruptTaskByType(task.type, reason)
  return { ok: Boolean(cancelled), task, reason: cancelled ? null : 'interrupt_rejected' }
}

// 玩家刚下施工令时走的那一条：这时还没有工地锚点（施工任务尚未入队），
// 但「玩家要她盖房」本身就说明那趟为旧基地排的回家过期了。
async function releaseReturnForPlayerBuild(context = {}, env = process.env) {
  return cancelObsoleteWorksiteReturn(context, {
    enabled: worksiteAnchorOptionsFromEnv(env).enabled !== false,
    trigger: 'player_build_command',
    reason: 'player_build_command'
  })
}

function log(context, message) {
  if (context?.logger?.log) context.logger.log(message)
  else if (context?.debug) context.debug(message)
}

function botPosition(context = {}) {
  return normalizePosition(context.bot?.entity?.position || context.blackboard?.get?.('bot.position'))
}

function normalizePosition(position) {
  if (!position) return null
  const x = Number(position.x)
  const y = Number(position.y)
  const z = Number(position.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

function positionDistance(a, b) {
  if (!a || !b) return Infinity
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function worksiteAnchorOptionsFromEnv(env = process.env) {
  const options = {}
  if (String(env.WORKSITE_ANCHOR || '').toLowerCase() === 'false') options.enabled = false
  const graceMs = Number(env.WORKSITE_ANCHOR_GRACE_MS)
  if (Number.isFinite(graceMs) && graceMs >= 0) options.graceMs = graceMs
  const radius = Number(env.WORKSITE_ANCHOR_RADIUS)
  if (Number.isFinite(radius) && radius > 0) options.radius = radius
  const storageRadius = Number(env.WORKSITE_STORAGE_RADIUS)
  if (Number.isFinite(storageRadius) && storageRadius > 0) options.storageRadius = storageRadius
  return options
}

function createWorksiteAnchorFromEnv(env = process.env, options = {}) {
  return new WorksiteAnchor({ ...worksiteAnchorOptionsFromEnv(env), ...options })
}

module.exports = {
  DEFAULT_WORKSITE_ANCHOR_OPTIONS: DEFAULT_OPTIONS,
  cancelObsoleteWorksiteReturn,
  constructionMaterialNames,
  findObsoleteWorksiteReturnTask,
  releaseReturnForPlayerBuild,
  WorksiteAnchor,
  createWorksiteAnchorFromEnv,
  worksiteAnchorOptionsFromEnv
}
