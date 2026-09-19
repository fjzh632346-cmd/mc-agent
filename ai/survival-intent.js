const { ACTION_KEYS } = require('./action-keys')

const SURVIVAL_INTENTS = new Set([
  ACTION_KEYS.CHECK_SURVIVAL_STATUS,
  ACTION_KEYS.ENABLE_SAFE_MODE,
  ACTION_KEYS.DISABLE_SAFE_MODE,
  ACTION_KEYS.RETURN_SAFE,
  ACTION_KEYS.PRIORITIZE_SURVIVAL
])

function parseSurvivalIntent(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return null
  const text = normalize(raw)
  if (isExplorationContext(text)) return null

  const explicit = matchExplicitSurvivalRule(text, raw)
  if (explicit) return explicit

  const chat = detectSurvivalChat(text, raw)
  if (chat) return chat

  const semantic = matchSemanticSurvivalIntent(text, raw)
  if (semantic) return semantic

  return null
}

function matchExplicitSurvivalRule(text, rawText) {
  if (hasAny(text, ['你现在安全吗', '现在安全吗', '你安全吗', '安全吗', '当前安全吗'])) {
    return decision(rawText, ACTION_KEYS.CHECK_SURVIVAL_STATUS, 0.92, { mode: 'CHECK_SURVIVAL_STATUS' }, 'explicit_survival_rule')
  }

  if (hasAny(text, ['你现在安全吗', '检查一下状态'])) {
    return decision(rawText, ACTION_KEYS.CHECK_SURVIVAL_STATUS, 0.92, { mode: 'CHECK_SURVIVAL_STATUS' }, 'explicit_survival_rule')
  }

  if (hasAny(text, ['开启安全模式', '先保证安全', '优先活下来'])) {
    return decision(rawText, ACTION_KEYS.ENABLE_SAFE_MODE, 0.92, { mode: 'ENABLE_SAFE_MODE', safeMode: true }, 'explicit_survival_rule')
  }

  if (hasAny(text, ['关闭安全模式', '不用安全模式'])) {
    return decision(rawText, ACTION_KEYS.DISABLE_SAFE_MODE, 0.92, { mode: 'DISABLE_SAFE_MODE', safeMode: false }, 'explicit_survival_rule')
  }

  if (hasAny(text, ['不安全就回来', '现在先回基地'])) {
    return decision(rawText, ACTION_KEYS.RETURN_SAFE, 0.9, { mode: 'RETURN_SAFE' }, 'explicit_survival_rule')
  }

  return null
}

function matchSemanticSurvivalIntent(text, rawText) {
  if (hasAny(text, ['你状态怎么样', '你血量和食物还好吗', '现在危险吗', '你还能继续吗'])) {
    return decision(rawText, ACTION_KEYS.CHECK_SURVIVAL_STATUS, 0.86, { mode: 'CHECK_SURVIVAL_STATUS' }, 'semantic_survival_rule')
  }

  if (hasAny(text, ['接下来保守一点', '不要冒险', '危险就回来', '别跑太远'])) {
    return decision(rawText, ACTION_KEYS.ENABLE_SAFE_MODE, 0.86, { mode: 'ENABLE_SAFE_MODE', safeMode: true }, 'semantic_survival_rule')
  }

  if (hasAny(text, ['先回来', '不行就撤', '离远了就回基地', '赶紧回安全地方'])) {
    return decision(rawText, ACTION_KEYS.RETURN_SAFE, 0.84, { mode: 'RETURN_SAFE' }, 'semantic_survival_rule')
  }

  if (hasAny(text, ['安全优先', '生存优先', '先别管任务活下来'])) {
    return decision(rawText, ACTION_KEYS.PRIORITIZE_SURVIVAL, 0.84, { mode: 'PRIORITIZE_SURVIVAL' }, 'semantic_survival_rule')
  }

  return null
}

function detectSurvivalChat(text, rawText) {
  const mentionsSurvival = hasAny(text, ['冒险', '安全模式', '判断危险', '高级生存', '生存策略'])
  if (!mentionsSurvival) return null
  const discussionLike = hasAny(text, ['喜欢', '是什么', '怎么', '以后能不能', '难不难'])
  if (isQuestionLike(text) && discussionLike) {
    return {
      ok: true,
      actionKey: ACTION_KEYS.CHAT,
      intent: 'chat',
      confidence: 0.9,
      rawText,
      source: 'survival_chat_guard',
      reason: 'survival discussion or question, not an execution command',
      shouldExecute: false,
      params: {}
    }
  }
  return null
}

function decision(rawText, actionKey, confidence, params = {}, source = 'survival_intent') {
  return {
    ok: SURVIVAL_INTENTS.has(actionKey),
    actionKey,
    intent: intentForSurvivalAction(actionKey),
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

function intentForSurvivalAction(actionKey) {
  const intents = {
    [ACTION_KEYS.CHECK_SURVIVAL_STATUS]: 'check_survival_status',
    [ACTION_KEYS.ENABLE_SAFE_MODE]: 'enable_safe_mode',
    [ACTION_KEYS.DISABLE_SAFE_MODE]: 'disable_safe_mode',
    [ACTION_KEYS.RETURN_SAFE]: 'return_safe',
    [ACTION_KEYS.PRIORITIZE_SURVIVAL]: 'prioritize_survival'
  }
  return intents[actionKey] || 'unknown'
}

function isQuestionLike(text) {
  return hasAny(text, ['吗', '嘛', '么', '？', '?', '怎么', '是什么', '能不能', '难不难'])
}

function hasAny(text, terms) {
  return terms.some(term => text.includes(term))
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[，。！？、?.!\s]/g, '')
}

function isExplorationContext(text) {
  return hasAny(text, ['附近探索', '探索附近', '附近看看', '周围看看', '看看周围', '去周围', '找找附近', '附近有没有'])
}

module.exports = {
  parseSurvivalIntent
}
