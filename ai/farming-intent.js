const { ACTION_KEYS } = require('./action-keys')

const FARMING_INTENTS = new Set([
  ACTION_KEYS.REMEMBER_FARM,
  ACTION_KEYS.HARVEST_FARM,
  ACTION_KEYS.PLANT_WHEAT,
  ACTION_KEYS.FARM_CYCLE,
  ACTION_KEYS.MAKE_BREAD,
  ACTION_KEYS.EAT_FOOD,
  ACTION_KEYS.CHECK_FOOD
])

const HARVEST_TERMS = [
  '\u6536\u5272',
  '\u6536\u83b7',
  '\u6536\u5c0f\u9ea6',
  '\u6536\u4e00\u4e0b',
  '\u6536\u4e86',
  '\u6536\u6389',
  '\u6536\u5b8c',
  '\u6536\u719f',
  '\u80fd\u6536',
  '\u5272\u5b8c',
  '\u5272\u6389',
  '\u719f\u4e86\u7684',
  '\u6210\u719f\u7684'
]

const REPLANT_TERMS = [
  '\u8865\u79cd',
  '\u91cd\u65b0\u79cd',
  '\u91cd\u79cd',
  '\u518d\u79cd',
  '\u79cd\u56de\u53bb',
  '\u79cd\u4e0a',
  '\u64ad\u79cd'
]

function parseFarmingIntent(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return null
  const text = normalize(raw)

  const explicit = matchExplicitFarmingRule(text, raw)
  if (explicit) return explicit

  const chat = detectFarmingChat(text, raw)
  if (chat) return chat

  const semantic = matchSemanticFarmingIntent(text, raw)
  if (semantic) return semantic

  return null
}

function matchExplicitFarmingRule(text, rawText) {
  if (hasHarvestAndReplantIntent(text)) {
    return decision(rawText, ACTION_KEYS.FARM_CYCLE, 0.93, farmingParams(text, { mode: 'FARM_CYCLE' }), 'explicit_farming_rule')
  }

  if (hasAny(text, ['记住这里是农田', '这里是小麦田', '以后在这里种地', '这是食物区'])) {
    return decision(rawText, ACTION_KEYS.REMEMBER_FARM, 0.94, { mode: 'REMEMBER_FARM' }, 'explicit_farming_rule')
  }

  if (hasAny(text, ['收一下小麦', '去收农田', '把成熟的小麦收了', '成熟的小麦收一下', '帮我收一下成熟的小麦', '收掉熟了的麦子', '没熟的别动', '检查一下农田'])) {
    return decision(rawText, ACTION_KEYS.HARVEST_FARM, 0.92, farmingParams(text, { mode: 'HARVEST_FARM' }), 'explicit_farming_rule')
  }

  if (hasAny(text, ['种点小麦', '把农田补种一下', '去补种小麦', '把空地补种上小麦', '这块田缺的地方补一下种子'])) {
    return decision(rawText, ACTION_KEYS.PLANT_WHEAT, 0.92, farmingParams(text, { mode: 'PLANT_WHEAT', itemName: 'wheat_seeds' }), 'explicit_farming_rule')
  }

  if (hasAny(text, ['整理一下农田', '维护一下农场', '把小麦收了再补种', '去处理一下农田', '收完之后补种'])) {
    return decision(rawText, ACTION_KEYS.FARM_CYCLE, 0.9, farmingParams(text, { mode: 'FARM_CYCLE' }), 'explicit_farming_rule')
  }

  if (hasAny(text, ['做面包', '做点面包', '帮我做面包', '把小麦做成面包'])) {
    return decision(rawText, ACTION_KEYS.MAKE_BREAD, 0.92, { mode: 'MAKE_BREAD', itemName: 'bread' }, 'explicit_farming_rule')
  }

  if (hasAny(text, ['吃点东西', '你饿了就吃', '你饿了就吃点东西', '先补充食物', '没吃的就去箱子里找', '去箱子里拿点吃的'])) {
    return decision(rawText, ACTION_KEYS.EAT_FOOD, 0.9, { mode: 'EAT_FOOD' }, 'explicit_farming_rule')
  }

  if (hasAny(text, ['食物还够吗', '还有吃的吗', '食物够不够', '我们还有多少面包', '你现在饿不饿'])) {
    return decision(rawText, ACTION_KEYS.CHECK_FOOD, 0.9, { mode: 'CHECK_FOOD' }, 'explicit_farming_rule')
  }

  return null
}

function matchSemanticFarmingIntent(text, rawText) {
  if (hasHarvestAndReplantIntent(text)) {
    return decision(rawText, ACTION_KEYS.FARM_CYCLE, 0.86, farmingParams(text, { mode: 'FARM_CYCLE' }), 'semantic_farming_rule')
  }

  if (hasAny(text, ['农田那边处理一下'])) {
    return decision(rawText, ACTION_KEYS.FARM_CYCLE, 0.62, farmingParams(text, { mode: 'FARM_CYCLE', needConfirm: true }), 'semantic_farming_unclear')
  }

  if (hasAny(text, ['看看农田该不该收了', '处理一下农田', '处理一下农场'])) {
    return decision(rawText, ACTION_KEYS.FARM_CYCLE, 0.84, farmingParams(text, { mode: 'FARM_CYCLE' }), 'semantic_farming_rule')
  }

  if (hasAny(text, ['去收一下庄稼', '把能收的作物收掉', '能收的作物收了', '熟了的麦子收掉'])) {
    return decision(rawText, ACTION_KEYS.HARVEST_FARM, 0.84, farmingParams(text, { mode: 'HARVEST_FARM' }), 'semantic_farming_rule')
  }

  if (hasAny(text, ['补一下种子', '把空地种上', '去把农田补种一下', '补种上小麦'])) {
    return decision(rawText, ACTION_KEYS.PLANT_WHEAT, 0.84, farmingParams(text, { mode: 'PLANT_WHEAT', itemName: 'wheat_seeds' }), 'semantic_farming_rule')
  }

  if (hasAny(text, ['把小麦做成吃的', '用小麦做面包'])) {
    return decision(rawText, ACTION_KEYS.MAKE_BREAD, 0.86, { mode: 'MAKE_BREAD', itemName: 'bread' }, 'semantic_farming_rule')
  }

  if (text.includes('做点能吃的') && !isQuestionLike(text)) {
    return decision(rawText, ACTION_KEYS.MAKE_BREAD, 0.82, { mode: 'MAKE_BREAD', itemName: 'bread' }, 'semantic_farming_rule')
  }

  if (hasAny(text, ['还有多少吃的', '吃的还够不够', '食物情况', '面包还够不够', '小麦够不够做面包'])) {
    return decision(rawText, ACTION_KEYS.CHECK_FOOD, 0.84, { mode: 'CHECK_FOOD' }, 'semantic_farming_rule')
  }

  return null
}

function detectFarmingChat(text, rawText) {
  const mentionsFarming = hasAny(text, ['种田', '农田', '农场', '小麦', '面包', '食物', '自动农场', '养牛'])
  if (!mentionsFarming) return null

  const discussionLike = hasAny(text, [
    '喜欢', '难不难', '以后可以', '要不要', '怎么种', '怎么做', '好吃吗',
    '大农场', '养牛', '村民', '红石', '自动'
  ])
  if (isQuestionLike(text) && discussionLike) {
    return {
      ok: true,
      actionKey: ACTION_KEYS.CHAT,
      intent: 'chat',
      confidence: 0.9,
      rawText,
      source: 'farming_chat_guard',
      reason: 'farming or food discussion, not an execution command',
      shouldExecute: false,
      params: {}
    }
  }

  return null
}

function decision(rawText, actionKey, confidence, params = {}, source = 'farming_intent') {
  return {
    ok: FARMING_INTENTS.has(actionKey),
    actionKey,
    intent: intentForFarmingAction(actionKey),
    confidence,
    rawText,
    source,
    reason: source,
    shouldExecute: false,
    params: {
      needConfirm: confidence < 0.8,
      ...params
    }
  }
}

function intentForFarmingAction(actionKey) {
  const intents = {
    [ACTION_KEYS.REMEMBER_FARM]: 'remember_farm',
    [ACTION_KEYS.HARVEST_FARM]: 'harvest_farm',
    [ACTION_KEYS.PLANT_WHEAT]: 'plant_wheat',
    [ACTION_KEYS.FARM_CYCLE]: 'farm_cycle',
    [ACTION_KEYS.MAKE_BREAD]: 'make_bread',
    [ACTION_KEYS.EAT_FOOD]: 'eat_food',
    [ACTION_KEYS.CHECK_FOOD]: 'check_food'
  }
  return intents[actionKey] || 'unknown'
}

function isQuestionLike(text) {
  return hasAny(text, ['吗', '嘛', '么', '？', '?', '难不难', '够不够', '饿不饿'])
}

function hasAny(text, terms) {
  return terms.some(term => text.includes(term))
}

function hasHarvestAndReplantIntent(text) {
  return hasAny(text, HARVEST_TERMS) && hasAny(text, REPLANT_TERMS)
}

function farmingParams(text, base = {}) {
  const count = extractCount(text)
  return count ? { ...base, count } : base
}

function extractCount(text) {
  const digit = String(text || '').match(/(\d+)\s*(?:个|棵|株|格|块)?/)
  if (digit) return Number(digit[1])
  if (text.includes('一个') || text.includes('一棵') || text.includes('一株')) return 1
  if (text.includes('两个') || text.includes('两棵') || text.includes('两株')) return 2
  if (text.includes('三个') || text.includes('三棵') || text.includes('三株')) return 3
  return null
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[，。！？、?.!\s]/g, '')
}

module.exports = {
  parseFarmingIntent
}
