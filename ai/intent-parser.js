const { ACTION_KEYS, intentForActionKey } = require('./action-keys')
const { parseExplorationIntent } = require('./exploration-intent')
const { parseFarmingIntent } = require('./farming-intent')
const { parseSurvivalIntent } = require('./survival-intent')
const { parseStorageIntent } = require('./storage-intent')
const { resolveItemOrCategoryAlias } = require('../utils/item-aliases')
const {
  adaptBuildIntentToDesignSpec,
  inferComplexityTier,
  shouldPreserveNamedBlueprintScale
} = require('../systems/building-complexity')
const {
  naturalComplexityTierFor,
  resolveBlueprintNameFromText
} = require('./blueprint-name-index')

const INTENTS = Object.freeze({
  FOLLOW_PLAYER: 'follow_player',
  MINING: 'mining',
  GUARD_PLAYER: 'guard_player',
  STOP_CURRENT_TASK: 'stop_current_task',
  RETURN_TO_PLAYER: 'return_to_player',
  RETURN_TO_BASE: 'return_to_base',
  SLEEP: 'sleep',
  WAKE_UP: 'wake_up',
  GET_STATUS: 'get_status',
  CHECK_INVENTORY: 'check_inventory',
  CHECK_ITEM_IN_INVENTORY: 'check_item_in_inventory',
  COUNT_ITEM_IN_INVENTORY: 'count_item_in_inventory',
  REMEMBER_BASE: 'remember_base',
  REMEMBER_MINE: 'remember_mine',
  REMEMBER_DANGER: 'remember_danger',
  REMEMBER_CHEST: 'remember_chest',
  REMEMBER_FARM: 'remember_farm',
  HARVEST_FARM: 'harvest_farm',
  PLANT_WHEAT: 'plant_wheat',
  FARM_CYCLE: 'farm_cycle',
  MAKE_BREAD: 'make_bread',
  EAT_FOOD: 'eat_food',
  CHECK_FOOD: 'check_food',
  CRAFT_ITEM: 'craft_item',
  SMELT_ITEM: 'smelt_item',
  COOK_ITEM: 'cook_item',
  USE_FURNACE: 'use_furnace',
  EXPLORE_NEARBY: 'explore_nearby',
  SCOUT_AREA: 'scout_area',
  FIND_RESOURCE_AREA: 'find_resource_area',
  CHECK_EXPLORED_AREAS: 'check_explored_areas',
  RETURN_IF_UNSAFE: 'return_if_unsafe',
  CHECK_SURVIVAL_STATUS: 'check_survival_status',
  ENABLE_SAFE_MODE: 'enable_safe_mode',
  DISABLE_SAFE_MODE: 'disable_safe_mode',
  RETURN_SAFE: 'return_safe',
  PRIORITIZE_SURVIVAL: 'prioritize_survival',
  PREPARE_COMBAT: 'prepare_combat',
  ATTACK_HOSTILE: 'attack_hostile',
  CHECK_ARMOR: 'check_armor',
  EQUIP_ARMOR: 'equip_armor',
  FETCH_AND_EQUIP_ARMOR: 'fetch_and_equip_armor',
  FETCH_WEAPON_FROM_STORAGE: 'fetch_weapon_from_storage',
  FETCH_TOOL_FROM_STORAGE: 'fetch_tool_from_storage',
  FETCH_FOOD_FROM_STORAGE: 'fetch_food_from_storage',
  FIND_ORE: 'find_ore',
  MINE_BLOCK: 'mine_block',
  PICKUP_ITEM: 'pickup_item',
  PICKUP_NEARBY_ITEMS: 'pickup_nearby_items',
  QUERY_BASE: 'query_base',
  MEMORY_SUMMARY: 'memory_summary',
  PLAN: 'plan',
  BUILD: 'build',
  CHAT: 'chat',
  UNKNOWN: 'unknown'
})

const EMERGENCY_RULES = [
  { actionKey: ACTION_KEYS.STOP_CURRENT_TASK, intent: INTENTS.STOP_CURRENT_TASK, phrases: ['停下', '别动', '取消任务', '别打了', '别挖了', '不用做了', '先停', '停止任务'], reason: '玩家明确要求停止当前任务' },
  { actionKey: ACTION_KEYS.RETURN_TO_PLAYER, intent: INTENTS.RETURN_TO_PLAYER, phrases: ['回来', '回到我身边', '回我这', '来找我', '到我身边', '来我身边', '别跑远'], reason: '玩家明确要求 AI 回到身边' }
]

const PHRASE_RULES = [
  {
    actionKey: ACTION_KEYS.GET_STATUS,
    intent: INTENTS.GET_STATUS,
    phrases: ['你现在在干嘛', '你现在做什么', '现在在干嘛', '状态怎么样', '当前任务', '任务状态'],
    reason: 'player asked for current task/status'
  },
  {
    actionKey: ACTION_KEYS.FOLLOW_PLAYER,
    intent: INTENTS.FOLLOW_PLAYER,
    phrases: ['跟着我', '跟我走', '过来', '来找我', '回到我身边', '来我这', '来我这边', '靠近我', '别离我太远', '不要离我太远', '跟上', '一起走', '和我一起走'],
    reason: '玩家表达了希望 AI 靠近并一起行动'
  },
  {
    actionKey: ACTION_KEYS.MINE,
    intent: INTENTS.MINING,
    phrases: ['去挖矿', '帮我挖矿', '找点矿', '找点铁矿', '挖铁', '挖煤', '找钻石', '去地下看看', '挖矿', '我们去找点铁吧'],
    reason: '玩家表达了挖掘或寻找矿物的意图'
  },
  {
    actionKey: ACTION_KEYS.GUARD_PLAYER,
    intent: INTENTS.GUARD_PLAYER,
    phrases: ['保护我', '守着我', '有怪', '附近有怪', '附近危险', '帮我打怪', '别让怪靠近', '别让怪物靠近'],
    reason: '玩家表达了需要保护或处理敌对生物'
  },
  {
    actionKey: ACTION_KEYS.GET_STATUS,
    intent: INTENTS.GET_STATUS,
    phrases: ['你在干嘛', '状态怎么样', '当前任务', '你现在做什么', '任务状态', '你在做什么'],
    reason: '玩家在询问 AI 当前状态'
  },
  {
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    intent: INTENTS.CRAFT_ITEM,
    itemName: 'torch',
    phrases: ['做火把', '做个火把', '造火把', '来点火把'],
    reason: '玩家希望 AI 制作火把'
  },
  {
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    intent: INTENTS.CRAFT_ITEM,
    itemName: 'stone_pickaxe',
    phrases: ['做石镐', '做个石镐', '造石镐', '做一把石镐'],
    reason: '玩家希望 AI 制作石镐'
  },
  {
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    intent: INTENTS.CRAFT_ITEM,
    itemName: 'iron_pickaxe',
    phrases: ['做铁镐', '做个铁镐', '造铁镐', '做一把铁镐'],
    reason: '玩家希望 AI 制作铁镐'
  },
  {
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    intent: INTENTS.CRAFT_ITEM,
    needsItemExtraction: true,
    phrases: ['做', '造', '合成', '搞', '制作', '做点', '造点', '搞点', '做几个', '造几个', '合成几个',
      '做些', '造些', '搞些', '合成些', '做一把', '造一把', '合成一把',
      '能做多少', '能做几个', '能造多少', '能合成多少', '能做多少就做多少', '能造多少就造多少',
      '把能做的', '把能做多少', '都做出来', '都造出来', '都做', '全做出来',
      '准备', '帮我做', '帮我造', '帮我准备', '帮我合成'],
    reason: 'player requested item crafting'
  },
  {
    actionKey: ACTION_KEYS.BUILD,
    intent: INTENTS.BUILD,
    blueprintName: 'small_house',
    phrases: ['建个小屋', '造个房子', '建个房子', '在这里建房子', '盖个小屋', '盖个房子'],
    reason: 'player requested the small_house blueprint'
  },
  {
    actionKey: ACTION_KEYS.BUILD,
    intent: INTENTS.BUILD,
    blueprintName: 'fence_area',
    phrases: ['建个围墙', '造个围墙', '搭个围栏', '建个围栏'],
    reason: 'player requested the fence_area blueprint'
  },
  {
    actionKey: ACTION_KEYS.BUILD,
    intent: INTENTS.BUILD,
    blueprintName: 'chest_area',
    phrases: ['搭个箱子区', '建个箱子区', '造个箱子区', '做个箱子区'],
    reason: 'player requested the chest_area blueprint'
  },
  {
    actionKey: ACTION_KEYS.BUILD,
    intent: INTENTS.BUILD,
    blueprintName: 'farm_plot',
    phrases: ['做个农田', '建个农田', '造个农田', '搭个农田'],
    reason: 'player requested the farm_plot blueprint'
  },
  {
    actionKey: ACTION_KEYS.REMEMBER_LOCATION,
    intent: INTENTS.REMEMBER_BASE,
    memoryType: 'base',
    phrases: ['记住这里是基地', '记住这里是我们的基地', '这里是基地', '这里是我们的基地', '把这里记为基地', '把这里记为我们的基地', '记一下这里是基地', '记一下这里是我们的基地', '这里当基地', '这是我们的基地'],
    reason: '玩家明确要求记住当前位置是基地'
  },
  {
    actionKey: ACTION_KEYS.REMEMBER_LOCATION,
    intent: INTENTS.REMEMBER_MINE,
    memoryType: 'mine',
    phrases: ['记住这里有矿', '这里有矿', '这里是矿区', '这里有铁矿', '这里有煤矿', '这里有钻石', '把这里记为矿区'],
    reason: '玩家明确要求记住当前位置有矿'
  },
  {
    actionKey: ACTION_KEYS.REMEMBER_LOCATION,
    intent: INTENTS.REMEMBER_DANGER,
    memoryType: 'danger',
    phrases: ['这里很危险', '记住这里很危险', '这里危险', '这里有危险', '这里怪很多', '这里有岩浆'],
    reason: '玩家明确要求标记当前位置为危险区域'
  },
  {
    actionKey: ACTION_KEYS.REMEMBER_LOCATION,
    intent: INTENTS.REMEMBER_CHEST,
    memoryType: 'chest',
    phrases: ['这是箱子区', '这里是箱子区', '记住这里是箱子区', '这里有箱子', '把这里记为箱子区'],
    reason: '玩家明确要求记住当前位置是箱子区'
  },
  {
    actionKey: ACTION_KEYS.REMEMBER_LOCATION,
    intent: INTENTS.QUERY_BASE,
    memoryType: 'query_base',
    phrases: ['你记得基地在哪吗', '基地在哪', '基地在哪里', '你知道基地在哪吗', '我们的基地在哪'],
    reason: '玩家在查询基地位置记忆'
  },
  {
    actionKey: ACTION_KEYS.REMEMBER_LOCATION,
    intent: INTENTS.MEMORY_SUMMARY,
    memoryType: 'summary',
    phrases: ['你记得什么', '你都记得什么', '记忆状态', '你记住了什么', '你知道哪些地方'],
    reason: '玩家在查询 AI 记忆摘要'
  }
]

const QUESTION_MARKERS = ['吗', '嘛', '么', '？', '?']
const PREFERENCE_MARKERS = ['喜欢', '觉得', '想不想', '愿不愿意', '会不会']
const SOFT_REQUEST_MARKERS = ['能不能', '可以', '能', '要不要', '可不可以']

const EXTRA_QUESTION_MARKERS = ['吗', '嘛', '么', '？', '会不会']
const EXTRA_PREFERENCE_MARKERS = ['喜欢', '觉得', '想不想', '愿不愿意', '会不会']

function parseIntent(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return unknown(raw)

  const text = normalize(raw)
  const directIntent = parseDirectCommandIntent(text, raw)
  if (directIntent) return directIntent

  const lifecycleIntent = parseTaskLifecycleIntent(text, raw)
  if (lifecycleIntent) return lifecycleIntent

  const survivalIntent = parseSurvivalIntent(raw)
  if (survivalIntent) return survivalIntent

  const explorationIntent = parseExplorationIntent(raw)
  if (explorationIntent) return explorationIntent

  const farmingIntent = parseFarmingIntent(raw)
  if (farmingIntent) return farmingIntent

  const storageIntent = parseStorageIntent(raw)
  if (storageIntent) return storageIntent

  if (isOrdinaryChatQuestion(text)) {
    return chat(raw, '普通聊天或偏好问题，不应触发任务')
  }

  const emergency = matchRules(text, raw, EMERGENCY_RULES, 'rules', 0.98)
  if (emergency.actionKey !== ACTION_KEYS.UNKNOWN) return emergency

  const phrase = matchRules(text, raw, PHRASE_RULES, 'rules', null)
  if (phrase.actionKey !== ACTION_KEYS.UNKNOWN) return phrase

  const fuzzy = matchFuzzy(text, raw)
  if (fuzzy.actionKey !== ACTION_KEYS.UNKNOWN) return fuzzy

  return unknown(raw)
}

function parseDirectCommandIntent(text, raw) {
  if (isWakeUpCommand(text)) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.WAKE_UP,
      intent: INTENTS.WAKE_UP,
      confidence: 0.96,
      source: 'direct_command_rule',
      reason: 'player requested bot to wake up',
      params: { input: raw }
    })
  }

  if (isSleepCommand(text)) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.SLEEP,
      intent: INTENTS.SLEEP,
      confidence: 0.95,
      source: 'direct_command_rule',
      reason: 'player requested bot to sleep',
      params: { input: raw }
    })
  }

  const explicitBuildIntent = parseExplicitBuildIntent(text, raw)
  if (explicitBuildIntent) return explicitBuildIntent

  const inventoryItemQuery = parseInventoryItemQuery(text, raw)
  if (inventoryItemQuery) return inventoryItemQuery

  if (isInventoryQuery(text)) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.CHECK_INVENTORY,
      intent: INTENTS.CHECK_INVENTORY,
      confidence: 0.96,
      source: 'direct_command_rule',
      reason: 'player asked for bot inventory summary',
      params: {}
    })
  }

  const explicitCraftTargetIntent = parseExplicitCraftTargetIntent(text, raw)
  if (explicitCraftTargetIntent) return explicitCraftTargetIntent

  const smeltIntent = parseSmeltIntent(text, raw)
  if (smeltIntent) return smeltIntent

  if (isEatFoodCommand(text)) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.EAT_FOOD,
      intent: INTENTS.EAT_FOOD,
      confidence: 0.95,
      source: 'direct_command_rule',
      reason: 'player asked bot to eat food from inventory',
      params: { statusOwner: 'bot' }
    })
  }

  if (hasAny(text, ['打僵尸', '攻击僵尸', '干掉僵尸', '有僵尸', '僵尸来了', '要打僵尸了', '打怪', '打怪物', '附近有怪', '附近有僵尸'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.ATTACK_HOSTILE,
      intent: INTENTS.ATTACK_HOSTILE,
      confidence: 0.95,
      source: 'direct_command_rule',
      reason: 'player requested attacking nearby hostile mob',
      params: { mobName: text.includes('僵尸') ? 'zombie' : null, radius: 10 }
    })
  }

  if (hasAny(text, ['捡起来', '拿着这个', '我给你东西', '把地上的东西捡了', '收一下掉落物', '捡地上的东西', '捡东西'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.PICKUP_ITEM,
      intent: INTENTS.PICKUP_ITEM,
      confidence: 0.95,
      source: 'direct_command_rule',
      reason: 'player requested dropped item pickup',
      params: { radius: 16 }
    })
  }

  if (hasAny(text, ['准备战斗', '战斗准备', '准备打怪', '准备打架', '备战'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.PREPARE_COMBAT,
      intent: INTENTS.PREPARE_COMBAT,
      confidence: 0.96,
      source: 'direct_command_rule',
      reason: 'player requested combat preparation',
      params: {}
    })
  }

  if (hasAny(text, ['做个铁镐', '做一把铁镐', '造个铁镐', '鍋氫釜閾侀晲'])) {
    return craftDecision(raw, 'iron_pickaxe', text)
  }

  if (hasAny(text, ['做个石镐', '做一把石镐', '造个石镐'])) {
    return craftDecision(raw, 'stone_pickaxe', text)
  }

  if (hasAny(text, ['做火把', '做个火把', '造火把', '做点火把'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.CRAFT_ITEM,
      intent: INTENTS.CRAFT_ITEM,
      confidence: 0.95,
      source: 'direct_command_rule',
      reason: 'player requested item crafting',
      params: { itemName: 'torch', count: extractUtf8Count(text), craftMode: 'specified' }
    })
  }

  if (hasAny(text, ['检查一下防具', '检查防具', '看一下防具', '防具状态', '看看防具', '检查盔甲', '盔甲状态'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.CHECK_ARMOR,
      intent: INTENTS.CHECK_ARMOR,
      confidence: 0.97,
      source: 'direct_command_rule',
      reason: 'player requested armor status',
      params: {}
    })
  }

  if (hasAny(text, ['穿上防具', '穿防具', '装备防具', '穿上盔甲', '装备盔甲'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.EQUIP_ARMOR,
      intent: INTENTS.EQUIP_ARMOR,
      confidence: 0.94,
      source: 'direct_command_rule',
      reason: 'player requested armor equip',
      params: { category: 'armor', itemCategory: 'armor' }
    })
  }

  if (hasStorageTakeVerb(text) && hasAny(text, ['箱子', '仓库']) && hasAny(text, ['装备', '防具', '盔甲']) && hasAny(text, ['穿上', '穿', '装备'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.FETCH_AND_EQUIP_ARMOR,
      intent: INTENTS.FETCH_AND_EQUIP_ARMOR,
      confidence: 0.95,
      source: 'direct_command_rule',
      reason: 'player requested armor/equipment category from storage and equip',
      params: { category: 'armor', itemCategory: 'armor', equipAfter: true }
    })
  }

  if (hasStorageTakeVerb(text) && hasAny(text, ['箱子', '仓库']) && hasAny(text, ['武器'])) {
    return storageCategoryDecision(raw, ACTION_KEYS.FETCH_WEAPON_FROM_STORAGE, INTENTS.FETCH_WEAPON_FROM_STORAGE, 'weapon')
  }

  if (hasStorageTakeVerb(text) && hasAny(text, ['箱子', '仓库']) && hasAny(text, ['工具'])) {
    return storageCategoryDecision(raw, ACTION_KEYS.FETCH_TOOL_FROM_STORAGE, INTENTS.FETCH_TOOL_FROM_STORAGE, 'tool')
  }

  if (hasStorageTakeVerb(text) && hasAny(text, ['箱子', '仓库']) && hasAny(text, ['食物', '吃的'])) {
    return storageCategoryDecision(raw, ACTION_KEYS.FETCH_FOOD_FROM_STORAGE, INTENTS.FETCH_FOOD_FROM_STORAGE, 'food')
  }

  if (hasAny(text, ['找钻石矿', '找点钻石矿', '去找钻石矿', '挖钻石矿'])) {
    return oreDecision(raw, 'diamond', 'diamond_ore', 'iron_pickaxe_or_better')
  }

  if (hasAny(text, ['挖铁矿', '挖点铁矿', '挖一些铁矿', '去挖铁矿']) || (text.includes('挖') && text.includes('铁矿'))) {
    return oreDecision(raw, 'iron', 'iron_ore', 'stone_pickaxe_or_better')
  }

  if (hasAny(text, ['挖铜矿', '挖点铜矿', '挖一些铜矿', '去挖铜矿', '找铜矿', '找点铜矿']) || (text.includes('铜') && text.includes('矿'))) {
    return oreDecision(raw, 'copper', 'copper_ore', 'stone_pickaxe_or_better')
  }

  if (hasAny(text, ['找附近能挖的矿', '去找附近能挖的矿', '找矿', '找点矿', '找附近的矿'])) {
    return oreDecision(raw, 'any', 'ore', 'pickaxe')
  }

  if (hasAny(text, ['挖石头', '挖点石头', '挖一些石头'])) {
    return blockMineDecision(raw, 'stone', 'pickaxe', ['stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff'])
  }

  if (hasAny(text, ['挖沙子', '挖点沙子', '挖一些沙子'])) {
    return blockMineDecision(raw, 'sand', 'shovel', ['sand', 'red_sand'])
  }

  if (hasAny(text, ['挖木头', '挖原木', '砍树', '砍点树', '砍木头', '砍原木']) ||
    (text.includes('砍') && (text.includes('树') || text.includes('木头') || text.includes('原木')))) {
    return blockMineDecision(raw, 'oak_log', 'axe', allLogBlockNames(), treeMiningParams(text))
  }

  const craftedItemName = extractUtf8CraftItemName(text)
  if (craftedItemName && hasAny(text, ['做', '造', '合成', '制作', '做一把', '做个'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.CRAFT_ITEM,
      intent: INTENTS.CRAFT_ITEM,
      confidence: 0.94,
      source: 'direct_command_rule',
      reason: 'player requested item crafting',
      params: { itemName: craftedItemName, count: extractUtf8Count(text), craftMode: 'specified' }
    })
  }

  return null
}

function parseInventoryItemQuery(text, raw) {
  const inventoryLike = hasAny(text, ['背包', '身上', '你有', '有没有', '还有', '有多少', '几个'])
  if (!inventoryLike) return null
  if (hasAny(text, ['仓库', '箱子', '箱子里'])) return null
  if (isInventoryQuery(text)) return null

  const resolved = resolveItemOrCategoryAlias(raw, { categoryAsItem: false, logFailure: false })
  if (!resolved.ok) return null

  const wantsCount = hasAny(text, ['多少', '几个', '几根', '几块', '几颗', '几把', '还有'])
  const actionKey = wantsCount ? ACTION_KEYS.COUNT_ITEM_IN_INVENTORY : ACTION_KEYS.CHECK_ITEM_IN_INVENTORY
  return decision({
    rawText: raw,
    actionKey,
    intent: wantsCount ? INTENTS.COUNT_ITEM_IN_INVENTORY : INTENTS.CHECK_ITEM_IN_INVENTORY,
    confidence: 0.97,
    source: 'direct_command_rule',
    reason: resolved.isCategory ? 'player asked for inventory category' : 'player asked for specific inventory item',
    params: {
      itemName: resolved.itemName,
      category: resolved.category,
      query: raw,
      queryAlias: resolved.alias
    }
  })
}

function parseExplicitCraftTargetIntent(text, raw) {
  const hasCraftVerb = hasExplicitCraftVerb(text)

  const itemName = resolveExplicitCraftTargetName(text, {
    protectedOnly: true,
    exactOnly: !hasCraftVerb
  })
  if (!itemName) return null

  return decision({
    rawText: raw,
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    intent: INTENTS.CRAFT_ITEM,
    confidence: 0.96,
    source: 'explicit_craft_target_rule',
    reason: 'player explicitly requested crafting a known target item',
    params: {
      itemName,
      count: extractUtf8Count(text),
      craftMode: hasAny(text, ['都', '全部', '所有', 'all']) ? 'max_possible' : 'specified'
    }
  })
}

function hasExplicitCraftVerb(text) {
  return hasAny(text, [
    'craft',
    'make',
    '合成',
    '制作',
    '做',
    '造'
  ])
}

function resolveExplicitCraftTargetName(text, options = {}) {
  for (const [itemName, aliases] of [
    ['bucket', ['bucket', '\u94c1\u6876']],
    ['oak_stairs', ['stairs', 'stair', '\u697c\u68af']],
    ['oak_slab', ['slab', '\u53f0\u9636']],
    ['barrel', ['barrel', '\u6728\u6876']],
    ['red_bed', ['bed', '\u5e8a']],
    ['furnace', ['furnace', '\u7194\u7089', '\u7089\u5b50']]
  ]) {
    if (aliases.some(alias => options.exactOnly ? text.trim() === alias : text.includes(alias))) return itemName
  }

  if (options.protectedOnly === true) return null

  const resolved = resolveItemOrCategoryAlias(text, {
    categoryAsItem: true,
    logFailure: false
  })
  if (resolved.ok && resolved.itemName) return resolved.itemName
  return null
}

function parseSmeltIntent(text, raw) {
  const smeltLike = hasAny(text, ['烧', '烤', '熔炉', '高炉', '烟熏炉'])
  if (!smeltLike) return null
  if (hasAny(text, ['拿', '拿出', '取', '取出', '箱子', '仓库', '放进', '放到', '存'])) return null
  if (hasAny(text, ['烧饭', '烧水'])) return null

  const cooking = hasAny(text, ['烤肉', '烤牛肉', '烤猪排', '烤鸡肉', '烤羊肉', '生牛肉', '生猪排', '生鸡肉', '生羊肉', '烟熏炉', '烤熟']) ||
    (text.includes('肉') && (text.includes('烤') || text.includes('熟')))
  let preferredFurnace = null
  if (text.includes('高炉')) preferredFurnace = 'blast_furnace'
  else if (text.includes('烟熏炉')) preferredFurnace = 'smoker'
  else if (text.includes('熔炉')) preferredFurnace = 'furnace'

  const params = {
    itemName: extractSmeltItemName(text),
    count: extractSmeltCount(text),
    smeltMode: text.includes('都') || text.includes('所有') || text.includes('全部') ? 'all' : 'default',
    preferredFurnace
  }
  if (isExplicitParallelSmeltingRequest(text)) params.parallelFurnaces = true

  return decision({
    rawText: raw,
    actionKey: cooking ? ACTION_KEYS.COOK_ITEM : ACTION_KEYS.SMELT_ITEM,
    intent: cooking ? INTENTS.COOK_ITEM : INTENTS.SMELT_ITEM,
    confidence: 0.94,
    source: 'direct_command_rule',
    reason: cooking ? 'player requested cooking/smoking item' : 'player requested furnace smelting',
    params
  })
}

function isExplicitParallelSmeltingRequest(text) {
  if (hasAny(text, ['\u5e76\u884c', '\u591a\u7089'])) return true
  return hasAny(text, [
    '\u4e24\u4e2a\u7089',
    '\u4e24\u4e2a\u7089\u5b50',
    '\u4e24\u4e2a\u7194\u7089',
    '\u591a\u4e2a\u7089',
    '\u591a\u4e2a\u7089\u5b50',
    '\u591a\u4e2a\u7194\u7089',
    '\u51e0\u4e2a\u7089',
    '\u51e0\u4e2a\u7089\u5b50',
    '\u4e00\u8d77\u70e7'
  ]) && hasAny(text, ['\u7089', '\u7194\u7089'])
}

function isInventoryQuery(text) {
  return hasAny(text, [
    '你背包里有什么',
    '你背包有什么',
    '你身上有什么',
    '你现在有什么东西',
    '检查一下背包',
    '检查背包',
    '看看你的背包',
    '看一下你的背包',
    '你带了什么',
    '你带着什么'
  ])
}

function isEatFoodCommand(text) {
  if (hasAny(text, [
    '吃东西',
    '吃点东西',
    '吃点食物',
    '你饿了就吃',
    '饿了就吃',
    '先吃饭',
    '补充饥饿值',
    '把饱食度补一下',
    '你饿了就吃点东西'
  ])) return true
  return text.includes('吃') && hasAny(text, ['食物', '东西', '饭']) && !hasAny(text, ['农场', '小麦', '种', '收'])
}

function isSleepCommand(text) {
  return hasAny(text, [
    '去睡觉',
    '上床睡觉',
    '天黑了去睡觉',
    '回家睡觉',
    '找床睡觉',
    '睡一觉',
    '晚上了先睡觉',
    '晚上了睡觉',
    '先睡觉',
    '该睡觉了'
  ])
}

function isWakeUpCommand(text) {
  if (!text) return false
  if (!hasAny(text, ['起床', '醒醒', '醒来', '醒过来', '别睡了', '不要睡了', '起来'])) return false
  return !hasAny(text, ['捡起来', '拿起来', '站起来', '存起来', '收起来', '放起来', '装起来', '藏起来'])
}

function hasStorageTakeVerb(text) {
  return hasAny(text, ['拿', '取', '拿出', '取出', '拿点', '取点', '带上'])
}

function planDecision(raw, planGoal) {
  return decision({
    rawText: raw,
    actionKey: ACTION_KEYS.PLAN,
    intent: INTENTS.PLAN,
    confidence: 0.95,
    source: 'direct_command_rule',
    reason: `player requested plan ${planGoal}`,
    params: { planGoal }
  })
}

function craftDecision(raw, itemName, text = normalize(raw)) {
  return decision({
    rawText: raw,
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    intent: INTENTS.CRAFT_ITEM,
    confidence: 0.95,
    source: 'direct_command_rule',
    reason: 'player requested item crafting',
    params: {
      itemName,
      count: extractUtf8Count(text),
      craftMode: hasAny(text, ['都', '全部', '所有']) ? 'max_possible' : 'specified'
    }
  })
}

function storageCategoryDecision(raw, actionKey, intent, category) {
  return decision({
    rawText: raw,
    actionKey,
    intent,
    confidence: 0.92,
    source: 'direct_command_rule',
    reason: `player requested ${category} category from storage`,
    params: { category, itemCategory: category }
  })
}

function oreDecision(raw, ore, targetBlock, requiredTool) {
  const blockNames = ore === 'diamond'
    ? ['diamond_ore', 'deepslate_diamond_ore']
    : ore === 'iron'
      ? ['iron_ore', 'deepslate_iron_ore']
      : ore === 'copper'
        ? ['copper_ore', 'deepslate_copper_ore']
        : ['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'diamond_ore', 'deepslate_diamond_ore']
  const text = normalize(raw)
  const count = extractMineCount(text)
  return decision({
    rawText: raw,
    actionKey: ACTION_KEYS.FIND_ORE,
    intent: INTENTS.FIND_ORE,
    confidence: ore === 'diamond' ? 0.95 : 0.9,
    source: 'direct_command_rule',
    reason: 'player requested mining resource search',
    params: {
      ore,
      blockName: targetBlock === 'ore' ? null : targetBlock,
      targetBlock,
      blockNames,
      requiredTool,
      count,
      mentionedTool: extractMentionedTool(text)
    }
  })
}

function blockMineDecision(raw, blockName, preferredTool, blockNames = null, extraParams = {}) {
  const count = extractMineCount(normalize(raw))
  return decision({
    rawText: raw,
    actionKey: ACTION_KEYS.MINE_BLOCK,
    intent: INTENTS.MINE_BLOCK,
    confidence: 0.93,
    source: 'direct_command_rule',
    reason: 'player requested specific block mining',
    params: { blockName, targetBlock: blockName, preferredTool, blockNames, count, ...extraParams }
  })
}

function allLogBlockNames() {
  return [
    'oak_log', 'birch_log', 'spruce_log', 'acacia_log', 'dark_oak_log', 'jungle_log', 'mangrove_log', 'cherry_log',
    'stripped_oak_log', 'stripped_birch_log', 'stripped_spruce_log', 'stripped_acacia_log', 'stripped_dark_oak_log', 'stripped_jungle_log', 'stripped_mangrove_log', 'stripped_cherry_log',
    'oak_wood', 'birch_wood', 'spruce_wood', 'acacia_wood', 'dark_oak_wood', 'jungle_wood', 'mangrove_wood', 'cherry_wood',
    'stripped_oak_wood', 'stripped_birch_wood', 'stripped_spruce_wood', 'stripped_acacia_wood', 'stripped_dark_oak_wood', 'stripped_jungle_wood', 'stripped_mangrove_wood', 'stripped_cherry_wood'
  ]
}

function treeMiningParams(text) {
  const count = extractMineCount(text)
  const scope = nearbyMiningScope(text)
  if (text.includes('木头') || text.includes('原木')) {
    return {
      treeMode: 'log_count',
      targetLogCount: count || 8,
      count: count || 8,
      ...scope
    }
  }
  return {
    treeMode: 'tree_count',
    targetTreeCount: count || 1,
    count: null,
    ...scope
  }
}

function nearbyMiningScope(text) {
  if (!hasAny(text, ['附近', '近处', '身边', '旁边', '周围'])) return {}
  return {
    maxDistance: 8,
    maxSearchRadius: 8
  }
}

function extractMentionedTool(text) {
  if (text.includes('铁斧')) return 'iron_axe'
  if (text.includes('铁镐')) return 'iron_pickaxe'
  if (text.includes('钻石镐')) return 'diamond_pickaxe'
  if (text.includes('石镐')) return 'stone_pickaxe'
  if (text.includes('木镐')) return 'wooden_pickaxe'
  if (text.includes('斧')) return 'axe'
  if (text.includes('镐')) return 'pickaxe'
  if (text.includes('铲')) return 'shovel'
  return null
}

function extractUtf8CraftItemName(text) {
  const explicitTargetName = resolveExplicitCraftTargetName(text, { protectedOnly: true })
  if (explicitTargetName) return explicitTargetName

  const map = {
    铁剑: 'iron_sword',
    铁镐: 'iron_pickaxe',
    铁斧: 'iron_axe',
    铁铲: 'iron_shovel',
    石剑: 'stone_sword',
    石镐: 'stone_pickaxe',
    石斧: 'stone_axe',
    木剑: 'wooden_sword',
    木镐: 'wooden_pickaxe',
    钻石剑: 'diamond_sword',
    钻石镐: 'diamond_pickaxe'
  }
  for (const [alias, itemName] of Object.entries(map)) {
    if (text.includes(alias)) return itemName
  }
  return null
}

function extractUtf8Count(text) {
  const match = text.match(/(\d+)/)
  return match ? Number(match[1]) : null
}

function extractSmeltCount(text) {
  const digit = extractUtf8Count(text)
  if (digit) return digit

  const match = text.match(/([\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])(?:\u4e2a|\u5757|\u4efd|\u53ea|\u7ec4|\u5806)/)
  if (!match) return null
  return {
    '\u4e00': 1,
    '\u4e8c': 2,
    '\u4e24': 2,
    '\u4e09': 3,
    '\u56db': 4,
    '\u4e94': 5,
    '\u516d': 6,
    '\u4e03': 7,
    '\u516b': 8,
    '\u4e5d': 9,
    '\u5341': 10
  }[match[1]] || null
}

function extractMineCount(text) {
  const digit = text.match(/(\d+)\s*(?:个|块)?/)
  if (digit) return Number(digit[1])
  if (text.includes('一个') || text.includes('一块') || text.includes('挖1')) return 1
  if (text.includes('两个') || text.includes('两块')) return 2
  if (text.includes('三个') || text.includes('三块')) return 3
  if (text.includes('四个') || text.includes('四块')) return 4
  if (text.includes('五个') || text.includes('五块')) return 5
  return null
}

function parseTaskLifecycleIntent(text, raw) {
  if (isFollowCancelPhrase(text, raw)) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.CANCEL_TASK,
      intent: 'cancel_task',
      confidence: 0.99,
      source: 'rules',
      reason: 'player explicitly asked to stop following',
      params: { targetTaskType: 'follow_player' }
    })
  }

  if (hasAny(text, ['停一下', '暂停一下', '先别动', '先停一下', '等一下', '暂停'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.PAUSE_TASK,
      intent: 'pause_task',
      confidence: 0.98,
      source: 'rules',
      reason: '玩家要求暂停当前任务'
    })
  }

  if (hasAny(text, ['继续', '继续跟', '继续跟着', '继续任务', '恢复任务'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.RESUME_TASK,
      intent: 'resume_task',
      confidence: 0.98,
      source: 'rules',
      reason: '玩家要求恢复暂停任务'
    })
  }

  if (hasAny(text, ['取消当前任务', '取消任务', '别跟了', '不用跟了', '不要跟了', '停止跟随', '别再跟了'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.CANCEL_TASK,
      intent: 'cancel_task',
      confidence: 0.98,
      source: 'rules',
      reason: '玩家要求取消当前任务'
    })
  }

  if (hasAny(text, ['回基地', '回到基地', '返回基地'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.RETURN_TO_BASE,
      intent: INTENTS.RETURN_TO_BASE,
      confidence: 0.97,
      source: 'rules',
      reason: '玩家要求返回基地'
    })
  }

  if (hasAny(text, ['回来', '回到我身边', '回我这', '来找我', '到我身边', '来我身边', '别探索了回来', '别探索了回來', '回安全的地方']) &&
    !hasAny(text, ['附近', '周围', '探索', '看看周围', '附近看看', '找找附近', '危险', '不安全'])) {
    return decision({
      rawText: raw,
      actionKey: hasAny(text, ['回安全的地方']) ? ACTION_KEYS.RETURN_SAFE : ACTION_KEYS.RETURN_TO_PLAYER,
      intent: hasAny(text, ['回安全的地方']) ? INTENTS.RETURN_SAFE : INTENTS.RETURN_TO_PLAYER,
      confidence: 0.97,
      source: 'rules',
      reason: '玩家要求停止当前行动并返回'
    })
  }

  if (hasAny(text, ['跟着我', '跟着我走', '陪我走', '跟上我', '跟我走', '跟随我'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.FOLLOW_PLAYER,
      intent: INTENTS.FOLLOW_PLAYER,
      confidence: 0.95,
      source: 'rules',
      reason: '玩家要求持续跟随'
    })
  }

  if (hasAny(text, ['来我身边', '过来', '到我这里', '来我这里', '靠近我', '来找我', '回到我身边'])) {
    return decision({
      rawText: raw,
      actionKey: ACTION_KEYS.RETURN_TO_PLAYER,
      intent: INTENTS.RETURN_TO_PLAYER,
      confidence: 0.95,
      source: 'rules',
      reason: '玩家要求一次性靠近'
    })
  }

  return null
}

function parseExplicitBuildIntent(text, raw) {
  const lower = String(raw || '').toLowerCase()
  const compact = String(text || '').toLowerCase()
  const forceRebuild = /\b(rebuild|reconstruct)\b/.test(lower)
  const resumeBuild = !forceRebuild && (
    /\b(continue|resume)\b/.test(lower) ||
    compact.includes('\u7eed\u5efa') ||
    compact.includes('\u7ee7\u7eed\u5efa') ||
    compact.includes('\u7ee7\u7eed\u76d6')
  )
  if (isQuestionLike(compact) && !forceRebuild && !resumeBuild) return null
  const hasBuildVerb = forceRebuild || resumeBuild || hasExplicitBuildVerb(lower, compact)
  if (!hasBuildVerb) return null

  const target = resolveBuildBlueprintTarget(lower, compact)
  if (!target) return null
  // Ambiguous saying: keep the first candidate so every downstream caller
  // still gets a blueprintName, but flag it so the chat layer asks instead
  // of quietly building one of them.
  const blueprintCandidates = target.candidates || null
  const blueprintName = target.name || blueprintCandidates?.[0] || null
  if (!blueprintName) return null
  const preserveNamedScale = shouldPreserveNamedBlueprintScale({
    blueprintName,
    rawText: raw
  })
  // A named blueprint is measured, not guessed: when the player named one and
  // said nothing about size, use the lowest tier that blueprint actually fits
  // (blueprint-name-index, measured with the production budget checker).
  // Without this the default L2 floor of 120 blocks rejects every small named
  // build — a statue (16), a fountain (31), a shelter (54) — with
  // no_usable_blueprint_candidate, which is how "build a statue" came to build
  // nothing at all. Any explicit size word still wins: inferComplexityTier
  // only returns the L2 default when the text carried no signal.
  const naturalTier = naturalComplexityTierFor(blueprintName)
  const inferredTier = inferComplexityTier({ rawText: raw, blueprintName })
  const useNaturalTier = Boolean(naturalTier) && inferredTier === 'L2' && naturalTier !== 'L2'
  const designSpec = forceRebuild || resumeBuild || preserveNamedScale
    ? null
    : adaptBuildIntentToDesignSpec({
        rawText: raw,
        blueprintName,
        ...(useNaturalTier ? { complexityTier: naturalTier } : {})
      })

  return decision({
    rawText: raw,
    actionKey: ACTION_KEYS.BUILD,
    intent: INTENTS.BUILD,
    confidence: 0.96,
    source: 'direct_command_rule',
    reason: forceRebuild
      ? `player explicitly requested rebuilding the ${blueprintName} blueprint`
      : (resumeBuild
          ? `player explicitly requested resuming the ${blueprintName} blueprint`
          : `player requested the ${blueprintName} blueprint`),
    params: {
      blueprintName,
      rawText: raw,
      ...(designSpec
        ? {
            complexityTier: designSpec.complexityTier,
            designSpec,
            ...(designSpec.complexityConfirmationRequired
              ? { requiresConfirmation: true, confirmationReason: 'complexity_l5_requires_explicit_confirmation' }
              : {})
          }
        : {}),
      ...(forceRebuild ? { forceRebuild: true, rebuildReason: 'explicit_rebuild_requested' } : {}),
      ...(resumeBuild ? { resumeOnly: true } : {}),
      ...(blueprintCandidates
        ? {
            blueprintCandidates,
            requiresConfirmation: true,
            confirmationReason: 'blueprint_name_ambiguous'
          }
        : {})
    }
  })
}

// The index derived from the blueprints answers first: its sayings are whole
// names ("简单双层小屋", "garden manor"), while the hand-written chain below
// matches fragments ("双层", "house"), so letting the fragment win would keep
// hiding the blueprints whose names contain one. The chain still answers
// everything the index does not know, and a regression test pins every saying
// it used to resolve to the same blueprint it resolved to before.
// Returns null, { name }, or { candidates } when two blueprints share a saying.
function resolveBuildBlueprintTarget(lower, compact) {
  const derived = resolveBlueprintNameFromText(`${lower} ${compact}`)
  if (derived?.name) return { name: derived.name, matchedSaying: derived.matchedSaying }
  if (derived?.candidates?.length) {
    return { name: null, candidates: derived.candidates, matchedSaying: derived.matchedSaying }
  }
  const known = resolveBuildBlueprintName(lower, compact)
  return known ? { name: known } : null
}

function resolveBuildBlueprintName(lower, compact) {
  const text = `${lower} ${compact}`
  if (
    text.includes('modern') ||
    text.includes('villa') ||
    text.includes('hilltop house') ||
    text.includes('\u73b0\u4ee3\u4f4f\u5b85') ||
    text.includes('\u73b0\u4ee3\u623f\u5c4b') ||
    text.includes('\u5c71\u9876\u522b\u5885')
  ) return 'modern_villa'
  if (text.includes('fort wall') || text.includes('wall gate') || text.includes('\u57ce\u5899')) return 'fort_wall_gate'
  if (text.includes('watchtower') || text.includes('\u77ad\u671b\u5854')) return 'fort_watchtower'
  if (text.includes('castle')) return 'castle_garden'
  if (text.includes('\u522b\u5885')) return 'modern_villa'
  if (text.includes('\u57ce\u5821')) return 'castle_garden'
  if (text.includes('garden manor') || (text.includes('garden') && text.includes('manor'))) return 'garden_manor'
  if (text.includes('farmhouse') || text.includes('farm house')) return 'simple_farmhouse'
  if (text.includes('starter') || text.includes('shelter')) return 'starter_shelter'
  if (text.includes('statue') || text.includes('sculpture')) return 'statue'
  if (text.includes('fountain')) return 'fountain'
  if (text.includes('\u53cc\u5c42') || text.includes('\u4e24\u5c42') || text.includes('\u4e8c\u5c42')) return 'two_story_wood_house'
  if (text.includes('\u5c0f\u6728\u5c4b') || (text.includes('\u7b80\u5355') && text.includes('\u5c0f\u5c4b'))) return 'simple_wood_cabin'
  if (text.includes('\u5c0f\u5c4b')) return 'small_house'
  if (text.includes('\u6728\u5c4b') || text.includes('\u4f4f\u5b85') || text.includes('\u623f\u5b50')) return 'simple_wood_cabin'
  if ((text.includes('two') && text.includes('story')) || text.includes('survival house') || text.includes('wood house')) {
    return 'two_story_wood_house'
  }
  if (text.includes('cabin') || text.includes('small house')) return 'simple_wood_cabin'
  if (text.includes('house')) return 'simple_wood_cabin'
  return null
}

function hasExplicitBuildVerb(lower, compact) {
  return /\b(build|construct|create|make)\b/.test(lower) ||
    compact.includes('\u5efa') ||
    compact.includes('\u9020') ||
    compact.includes('\u76d6') ||
    compact.includes('\u642d')
}

function hasAny(text, phrases) {
  return phrases.some(phrase => text.includes(normalize(phrase)))
}

function isFollowCancelPhrase(text, raw) {
  const candidates = [
    '别跟着我',
    '不要跟着我',
    '不用跟着我',
    '先别跟着我',
    '别再跟着我',
    '别跟随我',
    '停止跟随',
    '取消跟随',
    '不用跟着我了',
    '别跟着我了',
    '不要跟我了',
    '你别跟了',
    '停止跟随',
    '取消跟随',
    '别再跟着我',
    '先别跟我',
    '不用跟我',
    '别跟我',
    '不要跟着我',
    '不用跟了',
    '别跟了',
    '别再跟了'
  ]
  const normalizedRaw = normalize(raw)
  const directMatch = candidates.some(phrase => {
    const normalized = normalize(phrase)
    return text.includes(normalized) || normalizedRaw.includes(normalized)
  })
  if (directMatch) return true

  const compact = normalizedRaw || text
  const hasStopWord = ['别', '不要', '不用', '停止', '取消', '先别', '别再'].some(word => compact.includes(normalize(word)))
  const hasFollowWord = ['跟着', '跟随', '跟'].some(word => compact.includes(normalize(word)))
  return hasStopWord && hasFollowWord
}

function matchRules(text, raw, rules, source, forcedConfidence) {
  let best = null
  for (const rule of rules) {
    for (const phrase of rule.phrases) {
      const normalizedPhrase = normalize(phrase)
      if (text === normalizedPhrase || text.includes(normalizedPhrase)) {
        const exact = text === normalizedPhrase
        const confidence = forcedConfidence ?? confidenceForRule(rule, text, exact)
        if (!best || confidence > best.confidence) {
          best = { rule, confidence }
        }
      }
    }
  }

  if (!best) return unknown(raw)
  if (isWriteMemoryIntent(best.rule.intent) && isQuestionLike(text)) return unknown(raw)
  if (best.rule.actionKey === ACTION_KEYS.MINE && isPreferenceQuestion(text)) return chat(raw, '玩家在聊挖矿偏好，不是挖矿命令')

  return decision({
    rawText: raw,
    actionKey: best.rule.actionKey,
    intent: best.rule.intent,
    confidence: best.confidence,
    source,
    reason: best.rule.reason,
    params: extractParams(best.rule.intent, text, best.rule.memoryType, best.rule.planGoal, best.rule.blueprintName, best.rule.needsItemExtraction, best.rule.itemName)
  })
}

function matchFuzzy(text, raw) {
  if (isQuestionLike(text) && isPreferenceQuestion(text)) return chat(raw, '普通问句，不直接执行任务')

  const candidates = []
  addFuzzy(candidates, ACTION_KEYS.BUILD, INTENTS.BUILD, text, ['建', '造', '盖', '搭', '围', '小屋', '房子', '围墙', '围栏', '箱子区', '农田'], 'player may want blueprint building')
  addFuzzy(candidates, ACTION_KEYS.FOLLOW_PLAYER, INTENTS.FOLLOW_PLAYER, text, ['靠近', '别离队', '一起', '跟上', '跟随', '身边'], '玩家可能希望 AI 跟随或靠近')
  addFuzzy(candidates, ACTION_KEYS.MINE, INTENTS.MINING, text, ['挖', '矿', '铁', '煤', '钻石', '地下'], '玩家可能希望 AI 挖矿或寻找矿物')
  addFuzzy(candidates, ACTION_KEYS.GUARD_PLAYER, INTENTS.GUARD_PLAYER, text, ['保护', '守', '怪', '危险', '打怪'], '玩家可能需要保护或战斗')
  addFuzzy(candidates, ACTION_KEYS.GET_STATUS, INTENTS.GET_STATUS, text, ['状态', '任务', '干嘛', '做什么', '在做'], '玩家可能在询问当前状态')

  const best = candidates.sort((a, b) => b.confidence - a.confidence)[0]
  if (!best || best.confidence < 0.5) return unknown(raw)
  if (best.actionKey === ACTION_KEYS.BUILD && isQuestionLike(text)) return chat(raw, 'building question, not a direct build command')

  if (best.actionKey === ACTION_KEYS.MINE && isQuestionLike(text)) return chat(raw, '玩家在聊挖矿，不是明确挖矿命令')
  if (isQuestionLike(text) && SOFT_REQUEST_MARKERS.some(marker => text.includes(marker))) {
    best.confidence = Math.min(best.confidence, 0.65)
  }

  return decision({
    rawText: raw,
    ...best,
    source: 'rules',
    params: extractParams(best.intent, text)
  })
}

function addFuzzy(candidates, actionKey, intent, text, tokens, reason) {
  let hits = 0
  for (const token of tokens) if (text.includes(token)) hits += 1
  if (!hits) return
  candidates.push({
    actionKey,
    intent,
    confidence: Math.min(0.84, 0.46 + hits * 0.18),
    reason
  })
}

function confidenceForRule(rule, text, exact) {
  if (isQuestionLike(text) && rule.actionKey === ACTION_KEYS.GUARD_PLAYER) return 0.65
  if (isQuestionLike(text) && rule.actionKey === ACTION_KEYS.GET_STATUS) return 0.93
  if (isQuestionLike(text) && rule.actionKey === ACTION_KEYS.REMEMBER_LOCATION && ['query_base', 'summary'].includes(rule.memoryType)) return 0.93
  if (isQuestionLike(text)) return 0.62
  if (exact) return 0.95
  return 0.9
}

function extractParams(intent, text, memoryType = null, planGoal = null, blueprintName = null, needsItemExtraction = false, fixedItemName = null) {
  const params = {}
  if (intent === INTENTS.MINING) {
    if (text.includes('钻石')) Object.assign(params, { ore: 'diamond', blockName: 'diamond_ore' })
    else if (text.includes('铁')) Object.assign(params, { ore: 'iron', blockName: 'iron_ore' })
    else if (text.includes('煤')) Object.assign(params, { ore: 'coal', blockName: 'coal_ore' })
    const count = extractMineCount(text)
    if (count) params.count = count
  }
  if (intent === INTENTS.BUILD) {
    if (blueprintName) params.blueprintName = blueprintName
    else if (text.includes('围墙') || text.includes('围栏') || text.includes('围')) params.blueprintName = 'fence_area'
    else if (text.includes('箱子')) params.blueprintName = 'chest_area'
    else if (text.includes('农田')) params.blueprintName = 'farm_plot'
    else params.blueprintName = 'small_house'
  }
  if (intent === INTENTS.CRAFT_ITEM || needsItemExtraction) {
    const craft = extractCraftParams(text)
    Object.assign(params, craft)
  }
  if (fixedItemName) params.itemName = fixedItemName
  if (memoryType) params.memoryType = memoryType
  if (planGoal) params.planGoal = planGoal
  if (blueprintName) params.blueprintName = blueprintName
  return params
}

function extractSmeltItemName(text) {
  const map = {
    深层铁矿: 'deepslate_iron_ore',
    铁矿石: 'iron_ore',
    铁矿: 'raw_iron',
    粗铁: 'raw_iron',
    铁: 'raw_iron',
    金矿石: 'gold_ore',
    金矿: 'raw_gold',
    粗金: 'raw_gold',
    铜矿石: 'copper_ore',
    铜矿: 'raw_copper',
    粗铜: 'raw_copper',
    沙子: 'sand',
    圆石: 'cobblestone',
    原木: 'log',
    木头: 'log',
    生牛肉: 'beef',
    牛肉: 'beef',
    生猪排: 'porkchop',
    猪排: 'porkchop',
    生鸡肉: 'chicken',
    鸡肉: 'chicken',
    生羊肉: 'mutton',
    羊肉: 'mutton',
    马铃薯: 'potato',
    土豆: 'potato'
  }
  for (const [alias, itemName] of Object.entries(map)) {
    if (text.includes(alias)) return itemName
  }
  return null
}

function extractCraftParams(text) {
  const params = { craftMode: 'specified' }

  const craftAll = /能做多少[就]?(.*?)(?:做|造|合成|都做|都造)/.test(text) ||
    /(?:能造多少|能合成多少)[就]?/.test(text) ||
    /把.*都(?:做成|合成|做|造)/.test(text) ||
    /(?:全部|所有|全都).*(?:做成|合成|做|造)/.test(text) ||
    /把能做的/.test(text) ||
    /都做出来/.test(text) ||
    /全做出来/.test(text) ||
    /能做多少就做多少/.test(text)

  if (craftAll) {
    params.craftMode = 'max_possible'
  }

  const countMatch = text.match(/(\d+)\s*[个把把儿支根块片张桶]/)
  if (countMatch && !craftAll) {
    params.count = parseInt(countMatch[1], 10)
  }

  const itemName = extractCraftItemName(text)
  if (itemName) params.itemName = itemName

  return params
}

function extractCraftItemName(text) {
  const explicitTargetName = resolveExplicitCraftTargetName(text)
  if (explicitTargetName) return explicitTargetName

  const nameMap = {
    '铁剑': 'iron_sword', '铁镐': 'iron_pickaxe', '铁斧': 'iron_axe', '铁铲': 'iron_shovel', '铁锄': 'iron_hoe',
    '石剑': 'stone_sword', '石镐': 'stone_pickaxe', '石斧': 'stone_axe', '石铲': 'stone_shovel', '石锄': 'stone_hoe',
    '木剑': 'wooden_sword', '木镐': 'wooden_pickaxe', '木斧': 'wooden_axe', '木铲': 'wooden_shovel', '木锄': 'wooden_hoe',
    '钻石剑': 'diamond_sword', '钻石镐': 'diamond_pickaxe', '钻石斧': 'diamond_axe', '钻石铲': 'diamond_shovel', '钻石锄': 'diamond_hoe',
    '金剑': 'golden_sword', '金镐': 'golden_pickaxe', '金斧': 'golden_axe', '金铲': 'golden_shovel', '金锄': 'golden_hoe',
    '剑': 'sword', '镐子': 'pickaxe', '稿子': 'pickaxe', '镐': 'pickaxe', '稿': 'pickaxe', '斧头': 'axe', '斧子': 'axe', '斧': 'axe', '铲子': 'shovel', '铲': 'shovel', '锹': 'shovel', '锄头': 'hoe', '锄': 'hoe',
    '工作台': 'crafting_table', '箱子': 'chest', '火把': 'torch', '木棍': 'stick', '棍子': 'stick', 'sticks': 'stick',
    '面包': 'bread', '梯子': 'ladder', '门': 'door', '木门': 'oak_door', '铁门': 'iron_door',
    '木板': 'oak_planks', '橡木木板': 'oak_planks',
    '圆石': 'cobblestone', '石镐子': 'stone_pickaxe',
    '铁锭': 'iron_ingot', '铁块': 'iron_block',
    '栅栏': 'oak_fence', '围栏': 'oak_fence',
    '床': 'bed', '熔炉': 'furnace', '高炉': 'blast_furnace',
    '弓': 'bow', '箭': 'arrow', '弩': 'crossbow',
    '盾牌': 'shield', '盾': 'shield',
    '船': 'boat', '橡木船': 'oak_boat',
    '铁桶': 'bucket', '桶': 'bucket',
    '漏斗': 'hopper', '发射器': 'dispenser', '投掷器': 'dropper',
    '活塞': 'piston', '粘性活塞': 'sticky_piston',
    '煤炭': 'coal', '煤': 'coal', '木炭': 'charcoal',
    '铁套': 'iron_chestplate',
    '皮甲': 'leather_chestplate',
    '石工具': 'stone_tools', '木工具': 'wooden_tools', '铁工具': 'iron_tools'
  }

  for (const [cn, en] of Object.entries(nameMap)) {
    if (text.includes(cn)) return en
  }

  for (const [cn, en] of Object.entries(nameMap)) {
    if (text.includes(cn.slice(0, -1))) return en
  }

  return null
}

function decision({ rawText, actionKey, intent, confidence, source, reason, params = {} }) {
  return {
    ok: actionKey !== ACTION_KEYS.UNKNOWN && actionKey !== ACTION_KEYS.CHAT,
    actionKey,
    intent: intent || intentForActionKey(actionKey),
    confidence,
    rawText,
    source,
    reason,
    shouldExecute: false,
    params
  }
}

function chat(rawText, reason) {
  return {
    ok: true,
    actionKey: ACTION_KEYS.CHAT,
    intent: INTENTS.CHAT,
    confidence: 0.9,
    rawText,
    source: 'rules',
    reason,
    shouldExecute: false,
    params: {}
  }
}

function unknown(rawText) {
  return {
    ok: false,
    actionKey: ACTION_KEYS.UNKNOWN,
    intent: INTENTS.UNKNOWN,
    confidence: 0,
    rawText,
    source: 'unknown',
    reason: '无法判断玩家是否在下达任务指令',
    shouldExecute: false,
    params: {}
  }
}

function isQuestionLike(text) {
  return QUESTION_MARKERS.some(marker => text.includes(marker)) ||
    EXTRA_QUESTION_MARKERS.some(marker => text.includes(marker))
}

function isPreferenceQuestion(text) {
  return PREFERENCE_MARKERS.some(marker => text.includes(marker)) ||
    EXTRA_PREFERENCE_MARKERS.some(marker => text.includes(marker))
}

function isOrdinaryChatQuestion(text) {
  return isQuestionLike(text) && isPreferenceQuestion(text)
}

function isWriteMemoryIntent(intent) {
  return [INTENTS.REMEMBER_BASE, INTENTS.REMEMBER_MINE, INTENTS.REMEMBER_DANGER, INTENTS.REMEMBER_CHEST].includes(intent)
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[，。！？、,.!?\s]/g, '')
}

module.exports = {
  ACTION_KEYS,
  INTENTS,
  PHRASE_RULES,
  parseIntent,
  normalize
}
