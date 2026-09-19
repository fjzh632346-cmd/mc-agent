const { ACTION_KEYS } = require('./action-keys')
const { resolveItemOrCategoryAlias } = require('../utils/item-aliases')

const STORAGE_INTENTS = new Set([
  ACTION_KEYS.REMEMBER_CHEST,
  ACTION_KEYS.STORE_ITEMS,
  ACTION_KEYS.TAKE_ITEMS,
  ACTION_KEYS.TRANSFER_ITEMS,
  ACTION_KEYS.CHECK_STORAGE
])

const STORAGE_TARGET_IGNORED_ITEM_NAMES = ['chest']
const STORAGE_TARGET_IGNORED_ALIASES = [
  '\u7bb1\u5b50',
  '\u7bb1',
  '\u4ed3\u5e93',
  '\u67dc\u5b50',
  '\u7bb1\u5185',
  '\u7bb1\u91cc',
  '\u91cc\u9762',
  '\u91cc',
  'chest',
  'storage',
  'container'
]

function parseStorageIntent(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return null
  const text = normalize(raw)

  const chat = detectStorageChat(text, raw)
  if (chat) return chat

  const transfer = matchTransferStorageRule(text, raw)
  if (transfer) return transfer

  const explicit = matchExplicitStorageRule(text, raw)
  if (explicit) return explicit

  const semantic = matchSemanticStorageIntent(text, raw)
  if (semantic) return semantic

  return null
}

function matchTransferStorageRule(text, rawText) {
  const sourcePref = extractSourceContainerPreference(text)
  const targetPref = extractTargetContainerPreference(text)
  const hasTransferVerb = hasAny(text, ['转到', '轉到', '转进', '搬到', '搬进', '放到', '放进', '放入'])
  const hasSourceAndTarget = sourcePref !== 'any' && targetPref !== 'any'
  if (!hasTransferVerb || !hasSourceAndTarget) return null

  return decision(rawText, ACTION_KEYS.TRANSFER_ITEMS, 0.9, {
    mode: 'TRANSFER_ITEMS',
    itemName: extractItemName(text),
    count: extractCount(text) || 'all',
    sourceContainerPreference: sourcePref,
    targetContainerPreference: targetPref,
    containerPreference: targetPref
  }, 'explicit_storage_transfer_rule')
}

function matchExplicitStorageRule(text, rawText) {
  if (hasAny(text, ['全部拿出来', '全都拿出来', '都拿出来', '全部取出来', '全都取出来'])) {
    return decision(rawText, ACTION_KEYS.TAKE_ITEMS, 0.88, {
      mode: 'TAKE_ITEMS',
      itemName: extractItemName(text),
      count: 'all'
    }, 'explicit_storage_rule')
  }

  if (hasAny(text, ['拿食物', '拿点食物', '找点吃的', '拿点吃的', '取点食物', '取点吃的'])) {
    return decision(rawText, ACTION_KEYS.TAKE_ITEMS, 0.84, {
      mode: 'TAKE_ITEMS',
      itemName: 'food',
      count: extractCount(text)
    }, 'explicit_storage_rule')
  }

  if (hasAny(text, ['找一下有没有', '找一下有沒有', '找找有没有']) && hasAny(text, ['箱子', '仓库'])) {
    return decision(rawText, ACTION_KEYS.TAKE_ITEMS, 0.84, {
      mode: 'TAKE_ITEMS',
      itemName: extractItemName(text),
      count: extractCount(text)
    }, 'explicit_storage_rule')
  }

  if (hasAny(text, ['记住这个箱子', '这里是箱子区', '这是仓库', '这是箱子', '记住箱子'])) {
    return decision(rawText, ACTION_KEYS.REMEMBER_CHEST, 0.94, { mode: 'REMEMBER_CHEST' }, 'explicit_storage_rule')
  }

  if (hasAny(text, ['看看箱子里有什么', '箱子里有什么', '检查一下箱子', '检查箱子', '看一下箱子', '仓库里有什么', '你记得哪些箱子'])) {
    return decision(rawText, ACTION_KEYS.CHECK_STORAGE, 0.9, { mode: 'CHECK_STORAGE', itemName: extractItemName(text) }, 'explicit_storage_rule')
  }

  if ((text.includes('放') || text.includes('存')) && hasAny(text, ['箱子', '仓库'])) {
    const itemName = extractItemName(text)
    const category = extractCategoryName(text)
    return decision(rawText, ACTION_KEYS.STORE_ITEMS, 0.9, {
      mode: category ? 'category' : itemName ? 'specific' : 'nonEssential',
      itemName,
      category,
      itemCategory: category
    }, 'explicit_storage_rule')
  }

  if ((text.includes('拿') || text.includes('取')) && hasAny(text, ['箱子', '仓库'])) {
    const category = extractCategoryName(text)
    return decision(rawText, ACTION_KEYS.TAKE_ITEMS, 0.88, {
      mode: 'TAKE_ITEMS',
      itemName: extractItemName(text),
      category,
      itemCategory: category,
      count: extractCount(text)
    }, 'explicit_storage_rule')
  }

  if (hasAny(text, ['把东西存起来', '整理一下背包', '清一下背包', '整理背包'])) {
    return decision(rawText, ACTION_KEYS.STORE_ITEMS, 0.88, { mode: 'nonEssential' }, 'explicit_storage_rule')
  }

  return null
}

function matchSemanticStorageIntent(text, rawText) {
  const itemNameToStore = extractItemName(text)
  if (itemNameToStore && hasAny(text, ['\u5b58', '\u5b58\u5165', '\u653e\u8fdb', '\u653e\u5165', '\u653e\u5230', '\u653e\u56de'])) {
    return decision(rawText, ACTION_KEYS.STORE_ITEMS, 0.84, {
      mode: 'specific',
      itemName: itemNameToStore
    }, 'semantic_storage_rule')
  }

  if (hasAny(text, ['箱子那边处理一下', '仓库那边处理一下'])) {
    return decision(rawText, ACTION_KEYS.STORE_ITEMS, 0.62, { mode: 'unclear', needConfirm: true }, 'semantic_storage_unclear')
  }

  if (hasAny(text, ['背包满', '背包快满', '帮我收一下', '没用的东西', '多余的东西', '杂物', '放回去', '清一下身上'])) {
    return decision(rawText, ACTION_KEYS.STORE_ITEMS, 0.84, {
      mode: 'nonEssential',
      itemName: extractItemName(text)
    }, 'semantic_storage_rule')
  }

  if (hasAny(text, ['以后东西放这里', '当仓库', '用来存材料', '设成存东西的地方', '存东西的地方'])) {
    return decision(rawText, ACTION_KEYS.REMEMBER_CHEST, 0.86, { mode: 'REMEMBER_CHEST' }, 'semantic_storage_rule')
  }

  if (hasAny(text, ['帮我拿', '拿点', '拿些', '拿一些', '取几个', '取点', '取些', '拿出来']) ||
    ((text.startsWith('拿') || text.startsWith('取')) && !hasAny(text, ['起来', '着这个']))) {
    const category = extractCategoryName(text)
    return decision(rawText, ACTION_KEYS.TAKE_ITEMS, 0.84, {
      mode: 'TAKE_ITEMS',
      itemName: extractItemName(text),
      category,
      itemCategory: category,
      count: extractCount(text)
    }, 'semantic_storage_rule')
  }

  if (hasAny(text, ['还有多少', '有没有', '还有食物', '还有木头', '仓库里', '箱子里'])) {
    return decision(rawText, ACTION_KEYS.CHECK_STORAGE, 0.82, {
      mode: 'CHECK_STORAGE',
      itemName: extractItemName(text)
    }, 'semantic_storage_rule')
  }

  return null
}

function detectStorageChat(text, rawText) {
  const mentionsStorage = hasAny(text, ['箱子', '仓库', '存东西', '背包'])
  if (!mentionsStorage) return null
  const questionLike = hasAny(text, ['吗', '嘛', '么', '？', '?', '难不难', '会不会', '要不要', '怎么办', '知道'])
  const discussionLike = hasAny(text, ['喜欢', '系统', '以后可以', '自动仓库', '造个仓库', '如果', '怎么用'])
  if (questionLike && discussionLike) {
    return {
      ok: true,
      actionKey: ACTION_KEYS.CHAT,
      intent: 'chat',
      confidence: 0.9,
      rawText,
      source: 'storage_chat_guard',
      reason: 'storage discussion or question, not an execution command',
      shouldExecute: false,
      params: {}
    }
  }
  return null
}

function decision(rawText, actionKey, confidence, params = {}, source = 'storage_intent') {
  const text = normalize(rawText)
  const itemName = params.itemName || null
  return {
    ok: STORAGE_INTENTS.has(actionKey),
    actionKey,
    intent: intentForStorageAction(actionKey),
    confidence,
    rawText,
    source,
    reason: source,
    shouldExecute: false,
    params: {
      needConfirm: confidence < 0.8,
      containerPreference: params.containerPreference || extractContainerPreference(text),
      ...params,
      itemName,
      count: params.count
    }
  }
}

function intentForStorageAction(actionKey) {
  const intents = {
    [ACTION_KEYS.REMEMBER_CHEST]: 'remember_chest',
    [ACTION_KEYS.STORE_ITEMS]: 'store_items',
    [ACTION_KEYS.TAKE_ITEMS]: 'take_items',
    [ACTION_KEYS.TRANSFER_ITEMS]: 'transfer_items',
    [ACTION_KEYS.CHECK_STORAGE]: 'check_storage'
  }
  return intents[actionKey] || 'unknown'
}

function extractItemName(text) {
  const resolved = resolveItemOrCategoryAlias(text, {
    categoryAsItem: false,
    ignoredItemNames: STORAGE_TARGET_IGNORED_ITEM_NAMES,
    ignoredAliases: STORAGE_TARGET_IGNORED_ALIASES
  })
  if (resolved.isCategory) return null
  return resolved.itemName || null
}

function extractCategoryName(text) {
  return resolveItemOrCategoryAlias(text, {
    categoryAsItem: false,
    logFailure: false,
    ignoredItemNames: STORAGE_TARGET_IGNORED_ITEM_NAMES,
    ignoredAliases: STORAGE_TARGET_IGNORED_ALIASES,
    allowItemIdFallback: false,
    skipItemAliases: true
  }).category
}

function extractCount(text) {
  if (hasAny(text, ['所有', '全部', '全都', '都拿', '拿光'])) {
    console.log('[COUNT_PARSE] raw=所有 count=all')
    return 'all'
  }
  const match = text.match(/(\d+)/)
  const count = match ? Number(match[1]) : null
  if (count != null) console.log(`[COUNT_PARSE] raw=${match[1]} count=${count}`)
  return count
}

function extractContainerPreference(text) {
  const wantsLook = hasAny(text, ['这个', '這個', '这边', '眼前'])
  const wantsDouble = hasAny(text, ['大箱子', '双箱', '雙箱', '大箱'])
  const wantsSingle = hasAny(text, ['小箱子', '单箱', '單箱', '小箱'])
  if (wantsDouble) return 'double'
  if (wantsSingle) return 'single'
  if (wantsLook) return 'look'
  return 'any'
}

function extractSourceContainerPreference(text) {
  const parts = splitTransferText(text)
  const source = parts.source || text
  if (hasAny(source, ['大箱子的', '大箱子里', '大箱里的', '双箱里的', '双箱子的', '大箱子', '双箱'])) return 'double'
  if (hasAny(source, ['小箱子的', '小箱子里', '小箱里的', '单箱里的', '单箱子的', '小箱子', '单箱'])) return 'single'
  if (hasAny(source, ['这个箱子的', '这个箱子里', '这个箱里的', '这个箱子'])) return 'look'
  return 'any'
}

function extractTargetContainerPreference(text) {
  const parts = splitTransferText(text)
  const target = parts.target || text
  if (hasAny(target, ['小箱子', '小箱', '单箱'])) return 'single'
  if (hasAny(target, ['大箱子', '大箱', '双箱'])) return 'double'
  if (hasAny(target, ['那个箱子', '那个箱', '这个箱子', '这个箱'])) return 'look'
  return 'any'
}

function splitTransferText(text) {
  const verbs = ['放到', '放进', '放入', '转到', '轉到', '转进', '搬到', '搬进']
  for (const verb of verbs) {
    const index = text.indexOf(verb)
    if (index >= 0) {
      return {
        source: text.slice(0, index),
        target: text.slice(index + verb.length)
      }
    }
  }
  return { source: text, target: '' }
}

function hasAny(text, terms) {
  return terms.some(term => text.includes(term))
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[，。！？、,.!\s]/g, '')
}

module.exports = {
  parseStorageIntent
}
