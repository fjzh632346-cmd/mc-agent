const { ACTION_KEYS } = require('./action-keys')

const EXPLORATION_INTENTS = new Set([
  ACTION_KEYS.EXPLORE_NEARBY,
  ACTION_KEYS.SAFE_EXPLORE,
  ACTION_KEYS.FIND_PLACE_OR_RESOURCE,
  ACTION_KEYS.SCOUT_AREA,
  ACTION_KEYS.FIND_RESOURCE_AREA,
  ACTION_KEYS.CHECK_EXPLORED_AREAS,
  ACTION_KEYS.RETURN_IF_UNSAFE
])

function parseExplorationIntent(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return null
  const text = normalize(raw)

  const explicit = matchExplicitExplorationRule(text, raw)
  if (explicit) return explicit

  const chat = detectExplorationChat(text, raw)
  if (chat) return chat

  const semantic = matchSemanticExplorationIntent(text, raw)
  if (semantic) return semantic

  return null
}

function matchExplicitExplorationRule(text, rawText) {
  const directional = detectDirectionalExploration(text)
  if (directional) {
    return decision(rawText, ACTION_KEYS.SAFE_EXPLORE, 0.92, {
      mode: 'SAFE_EXPLORE',
      explorationMode: 'directional',
      direction: directional.direction,
      directionVector: directional.directionVector,
      directionalStepDistance: 32,
      maxDirectionalDistance: 192,
      safeMode: true
    }, 'explicit_directional_exploration_rule')
  }

  if (hasAny(text, ['安全探索', '安全地探索', '安全看看', '危险就回来', '不要掉下去', '别碰岩浆', '别跑太远'])) {
    return decision(rawText, ACTION_KEYS.SAFE_EXPLORE, 0.94, {
      mode: 'SAFE_EXPLORE',
      radius: hasAny(text, ['别跑太远', '不要跑太远', '别走太远']) ? 24 : 32,
      safeMode: true
    }, 'explicit_safe_exploration_rule')
  }

  if (hasAny(text, ['附近探索一下', '探索一下附近', '去附近探索', '附近看看', '去周围看看', '看看周围有什么', '看看周围有什么资源'])) {
    return decision(rawText, ACTION_KEYS.EXPLORE_NEARBY, 0.92, { mode: 'EXPLORE_NEARBY', radius: 32 }, 'explicit_exploration_rule')
  }

  if (hasAny(text, ['找找附近有没有矿洞', '找找附近有没有山洞', '找找附近有没有洞口', '找找附近有没有水源', '找找附近有没有村庄', '找找附近有没有动物', '找找附近有没有资源', '找个适合挖矿的地方'])) {
    return decision(rawText, ACTION_KEYS.FIND_PLACE_OR_RESOURCE, 0.9, {
      mode: 'FIND_PLACE_OR_RESOURCE',
      radius: 48,
      target: extractFindTarget(text)
    }, 'explicit_exploration_rule')
  }

  if (hasAny(text, ['侦查一下这片区域'])) {
    return decision(rawText, ACTION_KEYS.SCOUT_AREA, 0.9, { mode: 'SCOUT_AREA', radius: 24 }, 'explicit_exploration_rule')
  }

  if (hasAny(text, ['你记得探索过哪里吗', '你探索过哪些地方'])) {
    return decision(rawText, ACTION_KEYS.CHECK_EXPLORED_AREAS, 0.9, { mode: 'CHECK_EXPLORED_AREAS' }, 'explicit_exploration_rule')
  }

  return null
}

function detectDirectionalExploration(text) {
  if (!hasAny(text, ['探索', '走远', '远一点', '侦查', '看看'])) return null
  const directionWords = [
    ['east', ['往东', '向东', '朝东', '东边']],
    ['west', ['往西', '向西', '朝西', '西边']],
    ['south', ['往南', '向南', '朝南', '南边']],
    ['north', ['往北', '向北', '朝北', '北边']],
    ['desert', ['沙漠方向', '朝沙漠', '往沙漠']],
    ['forward', ['这个方向', '前面', '往前', '向前']]
  ]
  for (const [direction, words] of directionWords) {
    if (hasAny(text, words)) return { direction, directionVector: directionVector(direction) }
  }
  return null
}

function directionVector(direction) {
  const vectors = {
    east: { x: 1, z: 0 },
    west: { x: -1, z: 0 },
    south: { x: 0, z: 1 },
    north: { x: 0, z: -1 },
    desert: { x: 1, z: 0 },
    forward: { x: 1, z: 0 }
  }
  return vectors[direction] || { x: 1, z: 0 }
}

function matchSemanticExplorationIntent(text, rawText) {
  if (hasAny(text, ['附近处理一下'])) {
    return decision(rawText, ACTION_KEYS.EXPLORE_NEARBY, 0.62, { mode: 'EXPLORE_NEARBY', needConfirm: true }, 'semantic_exploration_unclear')
  }

  if (hasAny(text, ['在附近转一圈', '帮我看看周围', '别走太远探一下附近', '安全地看看周边', '周围看看', '附近转转'])) {
    const safe = hasAny(text, ['安全', '危险', '别走太远', '别跑太远', '不要跑太远'])
    return decision(rawText, safe ? ACTION_KEYS.SAFE_EXPLORE : ACTION_KEYS.EXPLORE_NEARBY, 0.86, {
      mode: safe ? 'SAFE_EXPLORE' : 'EXPLORE_NEARBY',
      radius: hasAny(text, ['别走太远', '别跑太远', '不要跑太远']) ? 24 : 32,
      safeMode: safe
    }, 'semantic_exploration_rule')
  }

  if (hasAny(text, ['观察一下这片区域', '看看附近有什么值得注意的地方', '帮我侦查周围环境'])) {
    return decision(rawText, ACTION_KEYS.SCOUT_AREA, 0.84, { mode: 'SCOUT_AREA', radius: 24 }, 'semantic_exploration_rule')
  }

  if (hasAny(text, ['找个能挖矿的地方', '看看附近有没有洞口', '看看附近有没有山洞', '看看附近有没有矿洞', '看看附近有没有水源', '看看附近有没有村庄', '看看附近有没有动物', '帮我找找资源点', '附近有没有适合挖矿的区域', '附近有没有资源'])) {
    return decision(rawText, ACTION_KEYS.FIND_PLACE_OR_RESOURCE, 0.86, {
      mode: 'FIND_PLACE_OR_RESOURCE',
      radius: 48,
      target: extractFindTarget(text)
    }, 'semantic_exploration_rule')
  }

  if (hasAny(text, ['你记得哪里有矿洞吗', '哪里比较危险', '你发现过什么地点'])) {
    return decision(rawText, ACTION_KEYS.CHECK_EXPLORED_AREAS, 0.86, { mode: 'CHECK_EXPLORED_AREAS' }, 'semantic_exploration_rule')
  }

  return null
}

function detectExplorationChat(text, rawText) {
  const mentionsExploration = hasAny(text, ['探索', '跑图', '矿洞', '村庄', '远一点', '自动跑图'])
  if (!mentionsExploration) return null

  const discussionLike = hasAny(text, [
    '喜欢', '能不能', '难不难', '要不要', '一般在哪里', '怎么找',
    '以后', '自动跑图', '远一点'
  ])
  if (isQuestionLike(text) && discussionLike) {
    return {
      ok: true,
      actionKey: ACTION_KEYS.CHAT,
      intent: 'chat',
      confidence: 0.9,
      rawText,
      source: 'exploration_chat_guard',
      reason: 'exploration discussion or question, not an execution command',
      shouldExecute: false,
      params: {}
    }
  }

  return null
}

function decision(rawText, actionKey, confidence, params = {}, source = 'exploration_intent') {
  return {
    ok: EXPLORATION_INTENTS.has(actionKey),
    actionKey,
    intent: intentForExplorationAction(actionKey),
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

function intentForExplorationAction(actionKey) {
  const intents = {
    [ACTION_KEYS.EXPLORE_NEARBY]: 'explore_nearby',
    [ACTION_KEYS.SAFE_EXPLORE]: 'safe_explore',
    [ACTION_KEYS.FIND_PLACE_OR_RESOURCE]: 'find_place_or_resource',
    [ACTION_KEYS.SCOUT_AREA]: 'scout_area',
    [ACTION_KEYS.FIND_RESOURCE_AREA]: 'find_resource_area',
    [ACTION_KEYS.CHECK_EXPLORED_AREAS]: 'check_explored_areas',
    [ACTION_KEYS.RETURN_IF_UNSAFE]: 'return_if_unsafe'
  }
  return intents[actionKey] || 'unknown'
}

function extractFindTarget(text) {
  const targets = [
    ['cave', ['山洞', '洞口', '矿洞']],
    ['water', ['水源', '水']],
    ['village', ['村庄', '村子']],
    ['animals', ['动物', '牛', '羊', '猪', '鸡']],
    ['resource', ['资源', '矿', '煤', '铁']]
  ]
  for (const [target, words] of targets) {
    if (words.some(word => text.includes(word))) return target
  }
  return null
}

function isQuestionLike(text) {
  return hasAny(text, ['吗', '嘛', '么', '？', '?', '难不难', '能不能', '要不要', '在哪里', '怎么'])
}

function hasAny(text, terms) {
  return terms.some(term => text.includes(term))
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[，。！？、?.!\s]/g, '')
}

module.exports = {
  parseExplorationIntent
}
