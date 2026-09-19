const { ACTION_KEYS, DANGEROUS_ACTION_KEYS, VALID_ACTION_KEYS, intentForActionKey } = require('./action-keys')
const { parseIntent } = require('./intent-parser')
const { intentToTask, BASE_EXECUTE_CONFIDENCE, DANGEROUS_EXECUTE_CONFIDENCE, CONFIRM_CONFIDENCE } = require('./intent-to-task')

const LLM_TIMEOUT_FALLBACK_MESSAGE = '\u6211\u521a\u624d\u7406\u89e3\u6709\u70b9\u6162\uff0c\u4f60\u662f\u60f3\u8ba9\u6211\u6267\u884c\u67d0\u4e2a\u4efb\u52a1\u5417\uff1f'
const LLM_UNAVAILABLE_FALLBACK_MESSAGE = '\u6211\u73b0\u5728\u8fde\u4e0d\u4e0a\u7406\u89e3\u6a21\u5757\uff0c\u4f60\u53ef\u4ee5\u628a\u4efb\u52a1\u8bf4\u5f97\u66f4\u660e\u786e\u4e00\u70b9\u5417\uff1f'

async function routePlayerCommand(rawText, context = {}) {
  let decision = parseIntent(rawText)

  if (decision.actionKey === ACTION_KEYS.UNKNOWN && context.llmClassifier) {
    decision = await classifyWithLlm(rawText, context.llmClassifier, context)
  }

  decision = finalizeDecision(decision)

  if (decision.actionKey === ACTION_KEYS.CHAT && decision.params?.fallbackMessage) {
    logDecision(context, decision, false)
    return {
      ok: true,
      handled: true,
      shouldConfirm: false,
      whetherExecuted: false,
      parsed: decision,
      action: {
        ok: true,
        action: 'chat',
        message: decision.params.fallbackMessage,
        reason: decision.reason,
        code: decision.errorCode || null
      },
      ...decision
    }
  }

  if (decision.actionKey === ACTION_KEYS.CHAT || decision.actionKey === ACTION_KEYS.UNKNOWN || decision.confidence < CONFIRM_CONFIDENCE) {
    logDecision(context, decision, false)
    return {
      ok: false,
      handled: false,
      shouldConfirm: false,
      whetherExecuted: false,
      parsed: decision,
      ...decision
    }
  }

  if (!decision.shouldExecute) {
    logDecision(context, decision, false)
    return {
      ok: true,
      handled: true,
      shouldConfirm: true,
      whetherExecuted: false,
      parsed: decision,
      action: {
        ok: true,
        action: 'confirm',
        intent: decision.intent,
        actionKey: decision.actionKey,
        message: confirmationMessage(decision.actionKey)
      },
      ...decision
    }
  }

  const action = await intentToTask(decision, context)
  const whetherExecuted = Boolean(action.ok && !['confirm', 'chat', 'error'].includes(action.action))
  logExecutionCheck(context, decision, action)
  logDecision(context, decision, whetherExecuted)

  return {
    ok: action.ok,
    handled: true,
    shouldConfirm: false,
    whetherExecuted,
    parsed: decision,
    action,
    ...decision
  }
}

async function classifyWithLlm(rawText, llmClassifier, context = {}) {
  try {
    const result = await llmClassifier(rawText, {
      logger: context.logger,
      timeoutMs: context.llmTimeoutMs
    })
    const actionKey = VALID_ACTION_KEYS.has(result?.actionKey) ? result.actionKey : ACTION_KEYS.UNKNOWN
    return {
      ok: actionKey !== ACTION_KEYS.UNKNOWN && actionKey !== ACTION_KEYS.CHAT,
      actionKey,
      intent: intentForActionKey(actionKey),
      confidence: clampConfidence(result?.confidence),
      rawText,
      source: 'llm',
      reason: typeof result?.reason === 'string' ? result.reason : 'LLM chose an action key',
      shouldExecute: false,
      params: sanitizeParams(result?.params)
    }
  } catch (err) {
    const errorCode = String(err?.code || 'LLM_API_ERROR')
    const fallbackMessage = errorCode === 'LLM_TIMEOUT'
      ? LLM_TIMEOUT_FALLBACK_MESSAGE
      : LLM_UNAVAILABLE_FALLBACK_MESSAGE
    return {
      ok: true,
      actionKey: ACTION_KEYS.CHAT,
      intent: 'chat',
      confidence: 0.9,
      rawText,
      source: errorCode === 'LLM_TIMEOUT' ? 'llm_timeout' : 'llm_unavailable',
      reason: `LLM classification failed: ${errorCode}`,
      errorCode,
      shouldExecute: false,
      params: { fallbackMessage }
    }
  }
}

function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return {}
  const safe = {}
  for (const key of ['ore', 'blockName', 'targetBlock', 'requiredTool', 'preferredTool', 'mentionedTool', 'category', 'itemCategory', 'memoryType', 'count', 'target', 'blueprintName', 'itemName', 'foodName', 'mode', 'radius', 'minExploreDistance', 'maxExploreDistance', 'explorationRadius', 'explorationMode', 'ringStartRadius', 'ringRadiusStep', 'maxRingRadius', 'directionalStepDistance', 'maxDirectionalDistance', 'sectorCount', 'visitedCooldownMs', 'minDistanceBetweenExploreTargets', 'safeCheckpointDistance', 'direction', 'radiusStep', 'maxFailedTargetsBeforeShrink', 'safeMode', 'priority', 'needConfirm', 'equipAfter', 'query', 'queryAlias', 'smeltMode', 'preferredFurnace']) {
    if (params[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof params[key])) {
      safe[key] = params[key]
    }
  }
  if (params.directionVector && typeof params.directionVector === 'object') {
    const x = Number(params.directionVector.x)
    const z = Number(params.directionVector.z)
    if (Number.isFinite(x) && Number.isFinite(z)) safe.directionVector = { x, z }
  }
  if (Array.isArray(params.blockNames)) safe.blockNames = params.blockNames.filter(name => typeof name === 'string')
  return safe
}

function finalizeDecision(decision) {
  const actionKey = VALID_ACTION_KEYS.has(decision.actionKey) ? decision.actionKey : ACTION_KEYS.UNKNOWN
  const confidence = clampConfidence(decision.confidence)
  const threshold = DANGEROUS_ACTION_KEYS.has(actionKey) ? DANGEROUS_EXECUTE_CONFIDENCE : BASE_EXECUTE_CONFIDENCE
  const shouldExecute = actionKey !== ACTION_KEYS.CHAT &&
    actionKey !== ACTION_KEYS.UNKNOWN &&
    decision.params?.needConfirm !== true &&
    confidence >= threshold

  return {
    ...decision,
    ok: actionKey !== ACTION_KEYS.UNKNOWN && actionKey !== ACTION_KEYS.CHAT,
    actionKey,
    intent: decision.intent || intentForActionKey(actionKey),
    confidence,
    source: decision.source || 'unknown',
    reason: decision.reason || 'No reason provided',
    shouldExecute
  }
}

function formatCommandResponse(routeResult) {
  if (!routeResult?.handled) return null

  const { actionKey, action } = routeResult
  if (routeResult.shouldConfirm) return action.message

  if (action.action === 'enqueue_task') {
    const messages = {
      [ACTION_KEYS.FIND_ORE]: '好，我去找附近能挖的矿。',
      [ACTION_KEYS.MINE_BLOCK]: '好，我去挖指定方块。',
      [ACTION_KEYS.PREPARE_COMBAT]: '好，我先检查武器、防具和食物。',
      [ACTION_KEYS.ATTACK_HOSTILE]: '好，我去处理附近的敌对生物。',
      [ACTION_KEYS.EQUIP_ARMOR]: '好，我把能穿的防具穿上。',
      [ACTION_KEYS.FETCH_AND_EQUIP_ARMOR]: '好，我去箱子里拿防具并穿上。',
      [ACTION_KEYS.FETCH_WEAPON_FROM_STORAGE]: '好，我去箱子里拿武器。',
      [ACTION_KEYS.FETCH_TOOL_FROM_STORAGE]: '好，我去箱子里拿工具。',
      [ACTION_KEYS.FETCH_FOOD_FROM_STORAGE]: '好，我去箱子里拿食物。',
      [ACTION_KEYS.FOLLOW_PLAYER]: '好，我跟着你。',
      [ACTION_KEYS.MINE]: '好，我去找附近能挖的矿。',
      [ACTION_KEYS.PICKUP_ITEM]: '好，我去捡附近的掉落物。',
      [ACTION_KEYS.PICKUP_NEARBY_ITEMS]: '好，我去捡附近的掉落物。',
      [ACTION_KEYS.GUARD_PLAYER]: '好，我来保护你。',
      [ACTION_KEYS.EXPLORE_NEARBY]: '好，我在附近探索一下。',
      [ACTION_KEYS.SAFE_EXPLORE]: '好，我在附近安全探索，不会跑太远。',
      [ACTION_KEYS.FIND_PLACE_OR_RESOURCE]: '好，我去附近找找有用的地点和资源。',
      [ACTION_KEYS.RETURN_TO_PLAYER]: '好，我回到你身边。',
      [ACTION_KEYS.RETURN_TO_BASE]: '好，我回基地。',
      [ACTION_KEYS.SLEEP]: '好，我去找床睡觉。',
      [ACTION_KEYS.EAT_FOOD]: '好，我先吃点东西。',
      [ACTION_KEYS.SMELT_ITEM]: '好，我去找熔炉烧炼。',
      [ACTION_KEYS.COOK_ITEM]: '好，我去找炉子烤一下。',
      [ACTION_KEYS.USE_FURNACE]: '好，我去使用熔炉。'
    }
    return messages[actionKey] || '好，我开始执行。'
  }

  if (action.action === 'chat') return action.message || null

  if (['interrupt', 'pause', 'resume', 'wake_up'].includes(action.action)) return action.message

  if (action.action === 'status') {
    const status = action.status || {}
    const task = status.currentTask?.type || '空闲'
    const danger = status.dangerLevel || '未知'
    const slots = status.inventoryEmptySlots ?? '未知'
    if (status.currentExplorationTask || ['exploration', 'return_to_player', 'return_to_base'].includes(task)) {
      const explore = status.currentExplorationTask || {}
      const discovered = status.discoveredPlaces?.length ?? explore.discoveredPlaces?.length ?? 0
      const dangerZones = status.dangerZones?.length ?? explore.dangerZones?.length ?? 0
      const target = status.targetPosition || status.currentTarget || explore.targetPosition || explore.currentTarget || null
      const returning = task === 'return_to_player' || task === 'return_to_base'
      const targetText = target ? `；目标：(${target.x}, ${target.y}, ${target.z})` : ''
      const radius = status.currentExploreRadius ?? explore.currentExploreRadius ?? '未知'
      const distance = status.targetDistance ?? explore.targetDistance ?? '未知'
      const failed = status.failedTargetCount ?? explore.failedTargetCount ?? 0
      const safety = status.safetyState || explore.safetyState || danger
      return `当前任务：${task}；状态：${explore.state || status.currentTask?.state || '未知'}；探索半径：${radius}；目标距离：${distance}${targetText}；已探索区域：${status.knownExploredAreaCount ?? '未知'}；失败目标：${failed}；安全状态：${safety}；发现地点：${discovered}；危险区：${dangerZones}；正在返回：${returning ? '是' : '否'}`
    }
    return `当前任务：${task}；危险等级：${danger}；背包空槽：${slots}`
  }

  if (action.action === 'inventory_status') {
    return formatInventorySummary(action.inventoryState)
  }

  if (action.action === 'inventory_item_status') {
    return formatInventoryItemStatus(action.inventoryState)
  }

  if (action.action === 'survival_status') {
    const status = action.status || {}
    const priority = status.survivalPriority || 'NORMAL'
    const risk = status.overallRiskLevel || 'low'
    const recommended = status.recommendedAction || 'NONE'
    const reason = status.reason || 'normal survival state'
    return `安全状态：${risk}；生存优先级：${priority}；建议动作：${recommended}；原因：${reason}`
  }

  if (action.action === 'armor_status') {
    const armor = action.armorState || {}
    return `防具状态：头盔=${armor.helmet?.name || '无'}；胸甲=${armor.chestplate?.name || '无'}；护腿=${armor.leggings?.name || '无'}；靴子=${armor.boots?.name || '无'}；缺少=${(armor.missingArmorSlots || []).join(',') || '无'}`
  }

  if (action.action === 'equip_armor') {
    const count = action.result?.equippedCount ?? 0
    return count > 0 ? `已穿上 ${count} 件防具。` : '没有找到更好的防具可穿。'
  }

  if (action.action === 'safe_mode') {
    return action.safeModeEnabled ? '安全模式已开启。' : '安全模式已关闭。'
  }

  if (action.action === 'memory_write') {
    const labels = {
      base: '基地位置',
      mine: '矿区位置',
      danger: '危险区域',
      chest: '箱子区'
    }
    return `记住了：${labels[action.memoryType] || '重要地点'}。`
  }

  if (action.action === 'memory_query') {
    const base = action.data?.baseLocation
    if (!base?.position) return '我还没有记录基地位置。'
    const p = base.position
    return `我记得基地在 (${p.x}, ${p.y}, ${p.z})。`
  }

  if (action.action === 'memory_summary') {
    const world = action.summary?.world
    const task = action.summary?.task
    if (!world) return '我还没有可用的记忆。'
    return `我记得：基地${world.hasBaseLocation ? '已记录' : '未记录'}，矿区${world.mineLocations}个，危险区域${world.dangerZones}个，箱子区${world.chestLocations}个，最近任务${task?.total ?? 0}条。`
  }

  if (action.action === 'plan_created') {
    return `我已经拆好计划：${action.plan.goalType}。`
  }

  if (action.action === 'plan_failed') {
    return `这个计划暂时做不了：${action.error}`
  }

  return null
}

function formatInventorySummary(inventoryState = {}) {
  const items = inventoryState.items || []
  const emptySlots = inventoryState.emptySlots ?? '未知'
  if (!items.length) return `我背包现在基本是空的，还有 ${emptySlots} 个空槽。`
  const itemText = items
    .slice(0, 12)
    .map(item => `${item.displayName || item.name} x${item.count}`)
    .join('、')
  const more = items.length > 12 ? `，另外还有 ${items.length - 12} 种东西` : ''
  return `我背包里有：${itemText}${more}。空槽还有 ${emptySlots} 个。`
}

function logDecision(context, decision, whetherExecuted) {
  const isLlmFailure = String(decision.errorCode || '').startsWith('LLM_')
  const entry = {
    rawText: isLlmFailure ? '[redacted]' : decision.rawText,
    actionKey: decision.actionKey,
    intent: decision.intent,
    confidence: decision.confidence,
    source: decision.source,
    reason: decision.reason,
    shouldExecute: decision.shouldExecute,
    whetherExecuted,
    errorCode: decision.errorCode || undefined
  }

  context.commandLog?.push?.(entry)
  const logActionKey = storageLogActionKey(entry.actionKey)
  context.logger?.log?.(`[router] input="${entry.rawText}" actionKey=${entry.actionKey} confidence=${entry.confidence} slots=${JSON.stringify(decision.params || {})}`)
  context.logger?.log?.(`[intent-parser] input="${entry.rawText}" intent=${entry.intent} confidence=${entry.confidence} source=${entry.source} reason=${entry.reason}`)
  context.logger?.log?.(`[INTENT_RESULT] actionKey=${logActionKey} intent=${entry.intent} executed=${entry.whetherExecuted} ${JSON.stringify(entry)}`)
  context.logger?.log?.(`[CommandRouter] ${JSON.stringify(entry)}`)
}

function logExecutionCheck(context, decision, action = {}) {
  const executable = decision.shouldExecute === true && isExecutableActionKey(decision.actionKey)
  if (!executable) return

  const enqueued = action.action === 'enqueue_task' && action.task && action.task.blocked !== true
  const handled = Boolean(action.ok && !['chat', 'error'].includes(action.action))
  const failReason = action.error || action.reason || action.task?.error || null
  const dropped = !enqueued && !failReason && action.action !== 'confirm' && action.action !== 'status' && action.action !== 'interrupt' && action.action !== 'pause' && action.action !== 'resume' && action.action !== 'wake_up' && action.action !== 'safe_mode' && action.action !== 'survival_status' && action.action !== 'armor_status'

  context.logger?.log?.(`[execution-check] actionKey=${decision.actionKey} shouldExecute=${decision.shouldExecute} enqueued=${enqueued} started=false handled=${handled} failReason=${failReason || (dropped ? 'execution_dropped' : 'none')}`)
  if (dropped) {
    context.logger?.error?.(`[execution-check] actionKey=${decision.actionKey} result=execution_dropped action=${JSON.stringify(action)}`)
  }
}

function isExecutableActionKey(actionKey) {
  return [
    ACTION_KEYS.FOLLOW_PLAYER,
    ACTION_KEYS.MINE,
    ACTION_KEYS.GUARD_PLAYER,
    ACTION_KEYS.RETURN_TO_PLAYER,
    ACTION_KEYS.RETURN_TO_BASE,
    ACTION_KEYS.SLEEP,
    ACTION_KEYS.WAKE_UP,
    ACTION_KEYS.PREPARE_COMBAT,
    ACTION_KEYS.ATTACK_HOSTILE,
    ACTION_KEYS.EQUIP_ARMOR,
    ACTION_KEYS.FETCH_AND_EQUIP_ARMOR,
    ACTION_KEYS.FETCH_WEAPON_FROM_STORAGE,
    ACTION_KEYS.FETCH_TOOL_FROM_STORAGE,
    ACTION_KEYS.FETCH_FOOD_FROM_STORAGE,
    ACTION_KEYS.FIND_ORE,
    ACTION_KEYS.MINE_BLOCK,
    ACTION_KEYS.PICKUP_ITEM,
    ACTION_KEYS.PICKUP_NEARBY_ITEMS,
    ACTION_KEYS.EAT_FOOD,
    ACTION_KEYS.CRAFT_ITEM,
    ACTION_KEYS.SMELT_ITEM,
    ACTION_KEYS.COOK_ITEM,
    ACTION_KEYS.USE_FURNACE,
    ACTION_KEYS.STORE_ITEMS,
    ACTION_KEYS.TAKE_ITEMS,
    ACTION_KEYS.TRANSFER_ITEMS,
    ACTION_KEYS.REMEMBER_CHEST,
    ACTION_KEYS.CHECK_STORAGE,
    ACTION_KEYS.BUILD
  ].includes(actionKey)
}

function formatInventoryItemStatus(inventoryState = {}) {
  if (inventoryState.category) {
    const items = inventoryState.matchedItems || []
    if (!items.length) return `没有，我背包里没有${categoryLabel(inventoryState.category)}。`
    const text = items.map(item => `${item.displayName || item.displayNameZh || item.name} x${item.count}`).join('、')
    return `我有${categoryLabel(inventoryState.category)}：${text}。`
  }
  const name = inventoryState.displayName || inventoryState.displayNameZh || inventoryState.itemName || '这个'
  const count = inventoryState.count || 0
  if (inventoryState.countOnly) return `我有 ${count} 个${name}。`
  return count > 0 ? `有，我背包里有 ${count} 个${name}。` : `没有，我背包里没有${name}。`
}

function categoryLabel(category) {
  const labels = {
    food: '食物',
    wood: '木头',
    logs: '原木',
    planks: '木板',
    tools: '工具',
    tool: '工具',
    weapons: '武器',
    weapon: '武器',
    armor: '防具',
    ores: '矿物',
    materials: '材料'
  }
  return labels[category] || category
}

function storageLogActionKey(actionKey) {
  if (actionKey === ACTION_KEYS.STORE_ITEMS) return 'STORAGE_DEPOSIT'
  if (actionKey === ACTION_KEYS.TAKE_ITEMS) return 'STORAGE_WITHDRAW'
  if (actionKey === ACTION_KEYS.TRANSFER_ITEMS) return 'STORAGE_TRANSFER'
  return actionKey
}

function confirmationMessage(actionKey) {
  const labels = {
    [ACTION_KEYS.FOLLOW_PLAYER]: '你是想让我跟着你吗？',
    [ACTION_KEYS.MINE]: '你是想让我去挖矿吗？',
    [ACTION_KEYS.GUARD_PLAYER]: '你是想让我保护你吗？',
    [ACTION_KEYS.STOP_CURRENT_TASK]: '你是想让我停下当前任务吗？',
    [ACTION_KEYS.RETURN_TO_PLAYER]: '你是想让我回到你身边吗？',
    [ACTION_KEYS.GET_STATUS]: '你是想问我当前状态吗？',
    [ACTION_KEYS.REMEMBER_LOCATION]: '你是想让我记住这个位置吗？',
    [ACTION_KEYS.PLAN]: '你是想让我制定并执行这个制作计划吗？'
  }
  return labels[actionKey] || '你是想让我执行这个动作吗？'
}

function clampConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

module.exports = {
  classifyWithLlm,
  formatCommandResponse,
  routePlayerCommand
}
