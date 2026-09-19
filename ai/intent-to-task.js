const { ACTION_KEYS } = require('./action-keys')
const { releaseReturnForPlayerBuild } = require('../systems/worksite-anchor')
const { SurvivalSystem } = require('../systems/survival-system')
const { getInventorySummary } = require('../actions/inventory')
const { getChineseItemName } = require('../utils/item-names')

const BASE_EXECUTE_CONFIDENCE = 0.8
const DANGEROUS_EXECUTE_CONFIDENCE = 0.88
const CONFIRM_CONFIDENCE = 0.5
const DEFAULT_BLOCK_MINE_COUNT = 8
const DEFAULT_ORE_MINE_LIMIT = 64
const PLAYER_BUILD_PRIORITY = 11

async function intentToTask(decision, context = {}) {
  if (!decision || decision.actionKey === ACTION_KEYS.UNKNOWN) {
    return { ok: false, action: 'chat', reason: 'unknown_action_key' }
  }

  if (decision.actionKey === ACTION_KEYS.CHAT) {
    return { ok: false, action: 'chat', reason: 'ordinary_chat' }
  }

  if (!decision.shouldExecute) {
    return {
      ok: true,
      action: 'confirm',
      actionKey: decision.actionKey,
      intent: decision.intent,
      message: confirmationMessage(decision.actionKey)
    }
  }

  logIntentToTask(context, decision, 'pending', decision.params || {})

  switch (decision.actionKey) {
    case ACTION_KEYS.FOLLOW_PLAYER:
      return followCommand(context, {
        username: context.playerName,
        playerName: context.playerName,
        durationMs: decision.params?.durationMs || context.durationMs || null,
        range: 2
      }, 9)

    case ACTION_KEYS.MINE:
      return enqueueRequired(context, 'mining', {
        ...decision.params,
        count: decision.params?.count || (isOreMiningParams(decision.params) ? DEFAULT_ORE_MINE_LIMIT : DEFAULT_BLOCK_MINE_COUNT),
        mineUntilExhausted: decision.params?.count == null && isOreMiningParams(decision.params),
        maxDistance: 24
      }, 4)

    case ACTION_KEYS.FIND_ORE:
      return enqueueRequired(context, 'mining', {
        ...decision.params,
        count: decision.params?.count || DEFAULT_ORE_MINE_LIMIT,
        mineUntilExhausted: decision.params?.count == null,
        maxDistance: decision.params?.maxDistance || 32
      }, 5)

    case ACTION_KEYS.MINE_BLOCK:
      return enqueueRequired(context, 'mining', {
        ...decision.params,
        count: defaultMiningCount(decision.params),
        mineUntilExhausted: decision.params?.count == null && isOreMiningParams(decision.params),
        maxDistance: decision.params?.maxDistance || 24
      }, 4)

    case ACTION_KEYS.PICKUP_ITEM:
    case ACTION_KEYS.PICKUP_NEARBY_ITEMS:
      return enqueueRequired(context, 'pickup_item', {
        radius: decision.params?.radius || 16,
        count: decision.params?.count || 1
      }, 6, decision.actionKey)

    case ACTION_KEYS.GUARD_PLAYER:
      return enqueueRequired(context, 'guard_player', {
        username: context.playerName,
        playerName: context.playerName,
        durationMs: context.durationMs || 20000,
        radius: 8
      }, 8)

    case ACTION_KEYS.ATTACK_HOSTILE:
      return enqueueRequired(context, 'guard_player', {
        username: context.playerName,
        playerName: context.playerName,
        durationMs: context.durationMs || 20000,
        radius: decision.params?.radius || 10,
        mobName: decision.params?.mobName || null,
        mode: 'attack_hostile'
      }, 9, ACTION_KEYS.ATTACK_HOSTILE)

    case ACTION_KEYS.RETURN_TO_PLAYER:
      return returnCommand(context, 'return_to_player', {
        username: context.playerName,
        playerName: context.playerName,
        range: 2
      }, 9)

    case ACTION_KEYS.RETURN_TO_BASE:
      return returnCommand(context, 'return_to_base', { range: 2 }, 8)

    case ACTION_KEYS.SLEEP:
      logEvent(context, `[sleep] input=${decision.rawText || 'sleep'} actionKey=SLEEP`)
      return enqueueRequired(context, 'sleep', {
        input: decision.rawText || null,
        radius: decision.params?.radius || 32
      }, 9, ACTION_KEYS.SLEEP)

    case ACTION_KEYS.WAKE_UP:
      return wakeUp(context)

    case ACTION_KEYS.STOP_CURRENT_TASK:
      return stopCurrentTask(context, 'player_command')

    case ACTION_KEYS.CANCEL_TASK:
      return stopCurrentTask(context, 'stop_follow', decision.params?.targetTaskType || null)

    case ACTION_KEYS.PAUSE_TASK:
      return pauseCurrentTask(context)

    case ACTION_KEYS.RESUME_TASK:
      return resumeCurrentTask(context)

    case ACTION_KEYS.GET_STATUS:
      return getStatus(context)

    case ACTION_KEYS.CHECK_INVENTORY:
      return checkInventory(context)

    case ACTION_KEYS.CHECK_ITEM_IN_INVENTORY:
    case ACTION_KEYS.COUNT_ITEM_IN_INVENTORY:
      return checkInventoryItem(context, decision)

    case ACTION_KEYS.REMEMBER_LOCATION:
      return handleMemory(decision, context)

    case ACTION_KEYS.REMEMBER_CHEST:
      return enqueueStorage(context, 'REMEMBER_CHEST', decision)

    case ACTION_KEYS.STORE_ITEMS:
      return enqueueStorage(context, 'STORE_ITEMS', decision)

    case ACTION_KEYS.TAKE_ITEMS:
      return enqueueStorage(context, 'TAKE_ITEMS', decision)

    case ACTION_KEYS.TRANSFER_ITEMS:
      return enqueueStorage(context, 'TRANSFER_ITEMS', decision)

    case ACTION_KEYS.CHECK_STORAGE:
      return enqueueStorage(context, 'CHECK_STORAGE', decision)

    case ACTION_KEYS.REMEMBER_FARM:
      return enqueueFarming(context, 'REMEMBER_FARM', decision, 5)

    case ACTION_KEYS.HARVEST_FARM:
      return enqueueFarming(context, 'HARVEST_FARM', decision, 5)

    case ACTION_KEYS.PLANT_WHEAT:
      return enqueueFarming(context, 'PLANT_WHEAT', decision, 5)

    case ACTION_KEYS.FARM_CYCLE:
      return enqueueFarming(context, 'FARM_CYCLE', decision, 5)

    case ACTION_KEYS.MAKE_BREAD:
      return enqueueFarming(context, 'MAKE_BREAD', decision, 6)

    case ACTION_KEYS.EAT_FOOD:
      return enqueueRequired(context, 'eat_food', {
        reason: 'player_command',
        allowStorageFallback: decision.params?.allowStorageFallback !== false,
        statusOwner: 'bot',
        input: decision.rawText || null
      }, 7, ACTION_KEYS.EAT_FOOD)

    case ACTION_KEYS.CHECK_FOOD:
      return enqueueFarming(context, 'CHECK_FOOD', decision, 4)

    case ACTION_KEYS.EXPLORE_NEARBY:
      return enqueueExploration(context, 'EXPLORE_NEARBY', decision, 6)

    case ACTION_KEYS.SAFE_EXPLORE:
      return enqueueExploration(context, 'SAFE_EXPLORE', decision, 6)

    case ACTION_KEYS.FIND_PLACE_OR_RESOURCE:
      return enqueueExploration(context, 'FIND_PLACE_OR_RESOURCE', decision, 6)

    case ACTION_KEYS.SCOUT_AREA:
      return enqueueExploration(context, 'SCOUT_AREA', decision, 6)

    case ACTION_KEYS.FIND_RESOURCE_AREA:
      return enqueueExploration(context, 'FIND_RESOURCE_AREA', decision, 6)

    case ACTION_KEYS.CHECK_EXPLORED_AREAS:
      return enqueueExploration(context, 'CHECK_EXPLORED_AREAS', decision, 3)

    case ACTION_KEYS.RETURN_IF_UNSAFE:
      return enqueueExploration(context, 'RETURN_IF_UNSAFE', decision, 7)

    case ACTION_KEYS.CHECK_SURVIVAL_STATUS:
      return checkSurvivalStatus(context)

    case ACTION_KEYS.PREPARE_COMBAT:
      return enqueueRequired(context, 'prepare_combat', {
        reason: 'player_command'
      }, 8)

    case ACTION_KEYS.CHECK_ARMOR:
      return checkArmorStatus(context)

    case ACTION_KEYS.EQUIP_ARMOR:
      return enqueueRequired(context, 'equip_armor', {
        reason: 'player_command'
      }, 8)

    case ACTION_KEYS.FETCH_AND_EQUIP_ARMOR:
      return enqueueStorage(context, 'FETCH_AND_EQUIP_ARMOR', decision)

    case ACTION_KEYS.FETCH_WEAPON_FROM_STORAGE:
    case ACTION_KEYS.FETCH_TOOL_FROM_STORAGE:
    case ACTION_KEYS.FETCH_FOOD_FROM_STORAGE:
      return enqueueStorage(context, 'TAKE_ITEMS', decision)

    case ACTION_KEYS.ENABLE_SAFE_MODE:
      return setSafeMode(context, true)

    case ACTION_KEYS.DISABLE_SAFE_MODE:
      return setSafeMode(context, false)

    case ACTION_KEYS.RETURN_SAFE:
      return enqueueReturnSafe(context)

    case ACTION_KEYS.PRIORITIZE_SURVIVAL:
      return prioritizeSurvival(context)

    case ACTION_KEYS.CRAFT_ITEM:
      return enqueueRequired(context, 'craft_item', {
        itemName: decision.params?.itemName || null,
        count: decision.params?.count || null,
        craftMode: decision.params?.craftMode || 'specified',
        item: decision.params?.item || null
      }, 5)

    case ACTION_KEYS.SMELT_ITEM:
    case ACTION_KEYS.COOK_ITEM:
    case ACTION_KEYS.USE_FURNACE:
      return enqueueRequired(context, 'smelt_item', {
        inputName: decision.params?.itemName || null,
        count: decision.params?.count || null,
        smeltMode: decision.params?.smeltMode || 'default',
        preferredFurnace: decision.params?.preferredFurnace || null,
        ...(decision.params?.parallelFurnaces === true ? { parallelFurnaces: true } : {}),
        rawText: decision.rawText || null,
        actionKey: decision.actionKey
      }, 5, decision.actionKey)

    case ACTION_KEYS.PLAN:
      return createPlan(decision, context)

    case ACTION_KEYS.BUILD:
      if (decision.params?.requiresConfirmation === true && decision.params?.confirmedComplexity !== true) {
        return {
          ok: true,
          action: 'confirm',
          actionKey: decision.actionKey,
          intent: decision.intent,
          message: '这个是精细版，可能需要很久。要不要改成 L3 简易版，或者确认继续展示级版本？',
          reason: decision.params.confirmationReason || 'complexity_confirmation_required'
        }
      }
      // 玩家刚下施工令：生存系统为了那个几个月前的旧基地自动排下的非紧急回家就作废了。
      // 不撤的话它是 HIGH、施工是 MEDIUM，施工只能排队干等她走完几百格（第 8 轮真机复现）。
      await releaseReturnForPlayerBuild(context)
      return enqueueRequired(context, 'build_blueprint', {
        blueprintName: decision.params?.blueprintName || decision.params?.target || 'small_house',
        origin: decision.params?.origin || null,
        rawText: decision.params?.rawText || decision.rawText || null,
        complexityTier: decision.params?.complexityTier || null,
        designSpec: decision.params?.designSpec || null,
        confirmedComplexity: decision.params?.confirmedComplexity === true,
        ...(decision.params?.forceRebuild === true ? { forceRebuild: true } : {}),
        ...(decision.params?.rebuildReason ? { rebuildReason: decision.params.rebuildReason } : {}),
        ...(decision.params?.resumeOnly === true ? { resumeOnly: true } : {})
      }, PLAYER_BUILD_PRIORITY)

    default:
      return { ok: false, action: 'chat', reason: 'unsupported_action_key' }
  }
}

function checkInventoryItem(context, decision) {
  const summary = getInventorySummary(context, { owner: 'check_inventory_item_status' })
  if (!summary.ok) return { ok: false, action: 'error', actionKey: decision.actionKey, error: summary.error }

  const category = normalizeInventoryCategory(decision.params?.category)
  if (category) {
    const matchedItems = categoryItems(summary.data, category)
    logEvent(context, `[inventory-query] input="${decision.rawText || ''}" category=${category} matchedItems=${matchedItems.map(item => `${item.name}:${item.count}`).join(',')}`)
    return {
      ok: true,
      action: 'inventory_item_status',
      actionKey: decision.actionKey,
      inventoryState: {
        category,
        matchedItems,
        count: matchedItems.reduce((sum, item) => sum + item.count, 0)
      }
    }
  }

  const itemName = decision.params?.itemName
  if (!itemName) return checkInventory(context)
  const count = summary.data.counts?.[itemName] || 0
  const displayName = getChineseItemName(itemName)
  logEvent(context, `[inventory-query] input="${decision.rawText || ''}" queryItem=${itemName} count=${count} result=${count > 0 ? 'has_item' : 'missing_item'}`)
  return {
    ok: true,
    action: 'inventory_item_status',
    actionKey: decision.actionKey,
    inventoryState: {
      itemName,
      displayName,
      displayNameZh: displayName,
      count,
      hasItem: count > 0,
      countOnly: decision.actionKey === ACTION_KEYS.COUNT_ITEM_IN_INVENTORY
    }
  }
}

function normalizeInventoryCategory(category) {
  if (!category) return null
  const aliases = { tool: 'tools', weapon: 'weapons', equipment: 'armor' }
  return aliases[category] || category
}

function categoryItems(summary, category) {
  const categories = summary.categories || {}
  if (Array.isArray(categories[category])) return categories[category]
  if (category === 'food') return summary.food || []
  if (category === 'tools') return summary.tools || []
  if (category === 'weapons') return summary.weapons || []
  if (category === 'armor') return summary.armor || []
  return []
}

function checkInventory(context) {
  const summary = getInventorySummary(context, { owner: 'check_inventory_status' })
  if (!summary.ok) return { ok: false, action: 'error', actionKey: ACTION_KEYS.CHECK_INVENTORY, error: summary.error }
  const inventoryState = {
    emptySlots: summary.data.emptySlots,
    usedSlots: summary.data.usedSlots,
    items: summary.data.items,
    tools: summary.data.tools,
    weapons: summary.data.weapons,
    armor: summary.data.armor,
    food: summary.data.food,
    blocks: summary.data.blocks,
    categories: summary.data.categories,
    heldItem: summary.data.heldItem
  }
  logEvent(context, `[inventory] action=check items=${JSON.stringify(inventoryState.items)} emptySlots=${inventoryState.emptySlots}`)
  return {
    ok: true,
    action: 'inventory_status',
    actionKey: ACTION_KEYS.CHECK_INVENTORY,
    inventoryState
  }
}

async function createPlan(decision, context) {
  const planningSystem = context.planningSystem
  if (!planningSystem) return { ok: false, action: 'error', error: 'planning_system_missing' }
  const goalType = decision.params?.planGoal || decision.params?.goalType || decision.intent
  const result = await planningSystem.createAndSubmitPlan(goalType, context, { target: decision.params?.target })
  if (!result.ok) return { ok: false, action: 'plan_failed', error: result.error, plan: result.plan }
  return { ok: true, action: 'plan_created', actionKey: ACTION_KEYS.PLAN, intent: decision.intent, plan: result.plan }
}

function enqueueRequired(context, taskType, params, priority, actionKeyOverride = null) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }
  logIntentToTask(context, { actionKey: actionKeyOverride || actionKeyForTask(taskType), intent: taskType }, taskType, params)
  const task = taskManager.enqueue(taskType, params, priority, 'player_command')
  return {
    ok: true,
    action: 'enqueue_task',
    actionKey: actionKeyOverride || actionKeyForTask(taskType),
    intent: taskType,
    task
  }
}

function enqueueStorage(context, mode, decision) {
  return enqueueRequired(context, 'storage', {
    mode,
    itemName: decision.params?.itemName || null,
    category: decision.params?.category || decision.params?.itemCategory || null,
    itemCategory: decision.params?.itemCategory || decision.params?.category || null,
    equipAfter: decision.params?.equipAfter === true,
    count: decision.params?.count || null,
    query: decision.rawText || null,
    storeMode: decision.params?.mode || null,
    playerName: context.playerName || null,
    containerPreference: decision.params?.containerPreference || 'any',
    sourceContainerPreference: decision.params?.sourceContainerPreference || 'any',
    targetContainerPreference: decision.params?.targetContainerPreference || 'any'
  }, mode === 'CHECK_STORAGE' ? 4 : 6, decision.actionKey)
}

function enqueueFarming(context, mode, decision, priority) {
  return enqueueRequired(context, 'farming', {
    mode,
    itemName: decision.params?.itemName || null,
    foodName: decision.params?.foodName || null,
    count: decision.params?.count || null,
    radius: decision.params?.radius || null
  }, priority)
}

function enqueueExploration(context, mode, decision, priority) {
  return enqueueRequired(context, 'exploration', {
    mode,
    target: decision.params?.target || null,
    radius: decision.params?.radius || null,
    minExploreDistance: decision.params?.minExploreDistance || null,
    maxExploreDistance: decision.params?.maxExploreDistance || null,
    explorationRadius: decision.params?.explorationRadius || null,
    explorationMode: decision.params?.explorationMode || null,
    ringStartRadius: decision.params?.ringStartRadius || null,
    ringRadiusStep: decision.params?.ringRadiusStep || null,
    maxRingRadius: decision.params?.maxRingRadius || null,
    directionalStepDistance: decision.params?.directionalStepDistance || null,
    maxDirectionalDistance: decision.params?.maxDirectionalDistance || null,
    sectorCount: decision.params?.sectorCount || null,
    visitedCooldownMs: decision.params?.visitedCooldownMs || null,
    minDistanceBetweenExploreTargets: decision.params?.minDistanceBetweenExploreTargets || null,
    safeCheckpointDistance: decision.params?.safeCheckpointDistance || null,
    direction: decision.params?.direction || null,
    directionVector: decision.params?.directionVector || null,
    radiusStep: decision.params?.radiusStep || null,
    maxFailedTargetsBeforeShrink: decision.params?.maxFailedTargetsBeforeShrink || null,
    safeMode: decision.params?.safeMode === true
  }, priority)
}

async function followCommand(context, params = {}, priority = 9) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }
  await interruptCurrentForPlayerMovement(context, 'follow_player_command')
  logEvent(context, `[FOLLOW_COMMAND_RECEIVED] targetPlayer=${params.username || params.playerName || 'nearest'} priority=${priority}`)
  const task = taskManager.enqueue('follow_player', params, priority, 'player_command')
  return {
    ok: true,
    action: 'enqueue_task',
    actionKey: ACTION_KEYS.FOLLOW_PLAYER,
    intent: 'follow_player',
    task
  }
}

async function returnCommand(context, preferredTaskType, params = {}, priority = 7) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }

  const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
  const taskType = preferredTaskType === 'return_to_base' && !hasBase ? 'return_to_player' : preferredTaskType
  const targetLabel = taskType === 'return_to_base' ? 'base' : 'player'
  const arbitrateRoutineReturn = shouldArbitrateRoutineReturn(context, preferredTaskType)
  const taskParams = arbitrateRoutineReturn
    ? { ...params, arbitrationPriority: 'LOW' }
    : params

  if (arbitrateRoutineReturn) {
    logEvent(context, `[RETURN_COMMAND_ARBITRATED] target=${targetLabel} priority=LOW current=${taskManager.currentTask.type}`)
  } else {
    await interruptCurrentForPlayerMovement(context, `${preferredTaskType}_command`)
  }

  logEvent(context, `[RETURN_COMMAND_RECEIVED] target=${targetLabel} priority=${arbitrateRoutineReturn ? 'LOW' : priority}`)
  const task = taskManager.enqueue(taskType, taskParams, priority, 'player_command')
  return {
    ok: true,
    action: 'enqueue_task',
    actionKey: taskType === 'return_to_base' ? ACTION_KEYS.RETURN_TO_BASE : ACTION_KEYS.RETURN_TO_PLAYER,
    intent: taskType,
    task
  }
}

function shouldArbitrateRoutineReturn(context, preferredTaskType) {
  if (preferredTaskType !== 'return_to_base') return false
  return isActiveBuildTask(context.taskManager?.currentTask)
}

function isActiveBuildTask(task) {
  if (!task || task.type !== 'build_blueprint') return false
  return !['COMPLETED', 'FAILED', 'BLOCKED', 'INTERRUPTED'].includes(task.state)
}

async function interruptCurrentForPlayerMovement(context, reason) {
  const taskManager = context.taskManager
  const current = taskManager?.currentTask
  if (!current) return false
  if (!isInterruptibleForPlayerMovement(current.type)) return false
  logEvent(context, `[TASK_INTERRUPT_FOR_PLAYER_MOVEMENT] from=${current.type} reason=${reason}`)
  return taskManager.interruptCurrent?.(reason)
}

function isInterruptibleForPlayerMovement(type) {
  return [
    'exploration',
    'mining',
    'mine_nearby_block',
    'farming',
    'storage',
    'build_blueprint',
    'return_to_base'
  ].includes(type)
}

function checkSurvivalStatus(context) {
  const survivalSystem = getSurvivalSystem(context)
  const state = survivalSystem.evaluateSurvivalState(context)
  const decision = survivalSystem.createSurvivalPlan(context, state)
  const armorState = context.equipmentSystem?.getArmorStatus?.(context) ||
    context.taskManager?.options?.equipmentSystem?.getArmorStatus?.(context) ||
    null
  return {
    ok: true,
    action: 'survival_status',
    actionKey: ACTION_KEYS.CHECK_SURVIVAL_STATUS,
    status: state,
    armorState,
    decision
  }
}

function checkArmorStatus(context) {
  const equipmentSystem = context.equipmentSystem || context.taskManager?.options?.equipmentSystem
  if (!equipmentSystem?.getArmorStatus) return { ok: false, action: 'error', error: 'equipment_system_missing' }
  const armorState = equipmentSystem.getArmorStatus(context)
  logEvent(context, `[armor] current=${JSON.stringify({
    helmet: armorState.helmet?.name || null,
    chestplate: armorState.chestplate?.name || null,
    leggings: armorState.leggings?.name || null,
    boots: armorState.boots?.name || null
  })} available=${JSON.stringify(armorState.bestAvailableArmor || {})} selected=null equipped=false reason=status_check`)
  return {
    ok: true,
    action: 'armor_status',
    actionKey: ACTION_KEYS.CHECK_ARMOR,
    armorState
  }
}

async function equipArmor(context) {
  const equipmentSystem = context.equipmentSystem || context.taskManager?.options?.equipmentSystem
  if (!equipmentSystem?.equipBestArmor) return { ok: false, action: 'error', error: 'equipment_system_missing' }
  const result = await equipmentSystem.equipBestArmor(context, { reason: 'player_command' })
  const armorState = equipmentSystem.getArmorStatus?.(context) || null
  logEvent(context, `[armor] current=${JSON.stringify(armorState || {})} available=${JSON.stringify(armorState?.bestAvailableArmor || {})} selected=${JSON.stringify(result.results || [])} equipped=${result.equippedCount || 0} reason=${result.reason || 'player_command'}`)
  return {
    ok: result.success !== false,
    action: 'equip_armor',
    actionKey: ACTION_KEYS.EQUIP_ARMOR,
    result,
    armorState
  }
}

function setSafeMode(context, enabled) {
  const survivalSystem = getSurvivalSystem(context)
  const result = survivalSystem.setSafeMode(context, enabled)
  return {
    ok: true,
    action: 'safe_mode',
    actionKey: enabled ? ACTION_KEYS.ENABLE_SAFE_MODE : ACTION_KEYS.DISABLE_SAFE_MODE,
    safeModeEnabled: result.safeModeEnabled
  }
}

function enqueueReturnSafe(context) {
  const hasBase = Boolean(context.memory?.summary?.().world?.hasBaseLocation || context.memory?.world?.baseLocation)
  return returnCommand(context, hasBase ? 'return_to_base' : 'return_to_player', {}, 8)
}

async function prioritizeSurvival(context) {
  const survivalSystem = getSurvivalSystem(context)
  const state = survivalSystem.evaluateSurvivalState(context)
  const decision = survivalSystem.createSurvivalPlan(context, state)
  const result = await survivalSystem.applySurvivalDecision(context, decision)
  return {
    ok: result.ok,
    action: 'survival_decision',
    actionKey: ACTION_KEYS.PRIORITIZE_SURVIVAL,
    decision,
    result
  }
}

function getSurvivalSystem(context) {
  if (context.survivalSystem) return context.survivalSystem
  if (context.taskManager?.options?.survivalSystem) return context.taskManager.options.survivalSystem
  context.survivalSystem = new SurvivalSystem()
  return context.survivalSystem
}

async function stopCurrentTask(context, reason = 'player_command', targetTaskType = null) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }
  const interrupted = targetTaskType && taskManager.interruptTaskByType
    ? await taskManager.interruptTaskByType(targetTaskType, reason)
    : await taskManager.interruptCurrent(reason)
  return {
    ok: true,
    action: 'interrupt',
    interrupted,
    message: interrupted ? '已停止当前任务' : '当前没有正在执行的任务'
  }
}

async function pauseCurrentTask(context) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }
  const paused = await taskManager.pauseCurrent('player_command_pause')
  return {
    ok: true,
    action: 'pause',
    paused,
    message: paused ? '已暂停当前任务。' : '当前没有正在执行的任务。'
  }
}

async function resumeCurrentTask(context) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }
  const resumed = await taskManager.resumePaused('player_command_resume')
  return {
    ok: true,
    action: 'resume',
    resumed,
    message: resumed ? '继续。' : '当前没有可继续的任务。'
  }
}

async function wakeUp(context) {
  const bot = context.bot
  const taskManager = context.taskManager
  const ctx = taskManager?.createContext ? taskManager.createContext(context) : context
  const sleepTask = taskManager?.currentTask?.type === 'sleep' ? taskManager.currentTask : null

  if (sleepTask) {
    sleepTask.resumable = false
    if (typeof bot?.wake === 'function' && bot.isSleeping) {
      try { await bot.wake() } catch {}
    }
    sleepTask.updateSleepState?.(ctx, {
      isSleeping: false,
      sleepPhase: 'woke_up',
      waitingForPlayers: false,
      lastSleepAction: 'wake',
      lastSleepError: null,
      sleepReason: 'player_wake_command'
    })
    await sleepTask.complete(ctx, { sleepState: sleepTask.sleepState, message: 'woke_up_by_player' })
    taskManager.currentTask = null
    return { ok: true, action: 'wake_up', actionKey: ACTION_KEYS.WAKE_UP, message: '我起来了。' }
  }

  if (typeof bot?.wake === 'function' && bot.isSleeping) {
    try {
      await bot.wake()
      ctx.blackboard?.set?.('sleep.isSleeping', false)
      ctx.blackboard?.set?.('sleep.sleepPhase', 'woke_up')
      ctx.blackboard?.set?.('sleep.lastSleepError', null)
      return { ok: true, action: 'wake_up', actionKey: ACTION_KEYS.WAKE_UP, message: '我起来了。' }
    } catch (err) {
      return { ok: false, action: 'error', actionKey: ACTION_KEYS.WAKE_UP, error: err.message || 'wake_failed' }
    }
  }

  return { ok: true, action: 'wake_up', actionKey: ACTION_KEYS.WAKE_UP, message: '我现在没在睡。' }
}

function getStatus(context) {
  const taskManager = context.taskManager
  if (!taskManager) return { ok: false, action: 'error', error: 'task_manager_missing' }
  return {
    ok: true,
    action: 'status',
    status: taskManager.status()
  }
}

function handleMemory(decision, context) {
  const memoryType = decision.params?.memoryType
  if (memoryType === 'query_base') return queryBase(context)
  if (memoryType === 'summary') return memorySummary(context)
  return rememberPlace(context, memoryType || memoryTypeFromIntent(decision.intent))
}

function rememberPlace(context, kind) {
  const memory = context.memory
  if (!memory?.world) return { ok: false, action: 'error', error: 'memory_missing' }
  const position = getCurrentPosition(context)
  if (!position) return { ok: false, action: 'error', error: 'position_missing' }

  let record
  if (kind === 'base') record = memory.world.setBaseLocation(position, { source: 'player_command' })
  else if (kind === 'mine') record = memory.world.addMineLocation(position, { source: 'player_command' })
  else if (kind === 'danger') record = memory.world.addDangerZone(position, { source: 'player_command' })
  else if (kind === 'chest') record = memory.world.addChestLocation(position, { source: 'player_command' })
  else return { ok: false, action: 'error', error: 'unknown_memory_kind' }

  return {
    ok: true,
    action: 'memory_write',
    memoryType: kind,
    record
  }
}

function queryBase(context) {
  const baseLocation = context.memory?.world?.baseLocation || null
  return {
    ok: true,
    action: 'memory_query',
    memoryType: 'base',
    data: { baseLocation }
  }
}

function memorySummary(context) {
  return {
    ok: true,
    action: 'memory_summary',
    summary: context.memory?.summary?.() || null
  }
}

function getCurrentPosition(context) {
  return context.blackboard?.get?.('bot.position') ||
    context.bot?.entity?.position ||
    context.worldState?.bot?.position ||
    null
}

function memoryTypeFromIntent(intent) {
  const types = {
    remember_base: 'base',
    remember_mine: 'mine',
    remember_danger: 'danger',
    remember_chest: 'chest'
  }
  return types[intent] || null
}

function actionKeyForTask(taskType) {
  const keys = {
    follow_player: ACTION_KEYS.FOLLOW_PLAYER,
    mining: ACTION_KEYS.MINE,
    guard_player: ACTION_KEYS.GUARD_PLAYER,
    return_to_player: ACTION_KEYS.RETURN_TO_PLAYER,
    return_to_base: ACTION_KEYS.RETURN_TO_BASE,
    sleep: ACTION_KEYS.SLEEP,
    build_blueprint: ACTION_KEYS.BUILD,
    craft_item: ACTION_KEYS.CRAFT_ITEM,
    prepare_combat: ACTION_KEYS.PREPARE_COMBAT,
    equip_armor: ACTION_KEYS.EQUIP_ARMOR,
    pickup_item: ACTION_KEYS.PICKUP_ITEM,
    eat_food: ACTION_KEYS.EAT_FOOD,
    smelt_item: ACTION_KEYS.SMELT_ITEM,
    exploration: ACTION_KEYS.EXPLORE_NEARBY,
    farming: ACTION_KEYS.FARM_CYCLE,
    storage: ACTION_KEYS.STORE_ITEMS
  }
  return keys[taskType] || null
}

function isOreMiningParams(params = {}) {
  if (!params) return false
  if (params.ore || params.targetBlock === 'ore') return true
  const names = params.blockNames
    ? (Array.isArray(params.blockNames) ? params.blockNames : [params.blockNames])
    : [params.blockName, params.targetBlock]
  return names.filter(Boolean).some(name => String(name).includes('_ore'))
}

function defaultMiningCount(params = {}) {
  if (params.count != null) return params.count
  if (params.treeMode === 'tree_count') return params.targetTreeCount || 1
  if (params.treeMode === 'log_count') return params.targetLogCount || DEFAULT_BLOCK_MINE_COUNT
  return isOreMiningParams(params) ? DEFAULT_ORE_MINE_LIMIT : DEFAULT_BLOCK_MINE_COUNT
}

function confirmationMessage(actionKey) {
  const labels = {
    [ACTION_KEYS.FOLLOW_PLAYER]: '你是想让我跟着你吗？',
    [ACTION_KEYS.MINE]: '你是想让我去挖矿吗？',
    [ACTION_KEYS.GUARD_PLAYER]: '你是想让我保护你吗？',
    [ACTION_KEYS.STOP_CURRENT_TASK]: '你是想让我停下当前任务吗？',
    [ACTION_KEYS.PAUSE_TASK]: '你是想让我暂停当前任务吗？',
    [ACTION_KEYS.RESUME_TASK]: '你是想让我继续刚才的任务吗？',
    [ACTION_KEYS.CANCEL_TASK]: '你是想让我取消当前任务吗？',
    [ACTION_KEYS.RETURN_TO_PLAYER]: '你是想让我回到你身边吗？',
    [ACTION_KEYS.GET_STATUS]: '你是想问我当前状态吗？',
    [ACTION_KEYS.REMEMBER_LOCATION]: '你是想让我记住这个位置吗？'
  }
  return labels[actionKey] || '你是想让我执行这个动作吗？'
}

function logEvent(context, message) {
  if (context?.logger?.log) context.logger.log(message)
  else if (context?.debug) context.debug(message)
}

function logIntentToTask(context, decision, task, params = {}) {
  logEvent(context, `[intent-to-task] actionKey=${decision?.actionKey || 'UNKNOWN'} task=${task} params=${JSON.stringify(params)}`)
}

module.exports = {
  BASE_EXECUTE_CONFIDENCE,
  CONFIRM_CONFIDENCE,
  DANGEROUS_EXECUTE_CONFIDENCE,
  intentToTask
}
