const REMINDER_TYPES = Object.freeze({
  LOW_HEALTH: 'LOW_HEALTH',
  LOW_FOOD: 'LOW_FOOD',
  DANGER_NEARBY: 'DANGER_NEARBY',
  INVENTORY_FULL: 'INVENTORY_FULL',
  NIGHT_WARNING: 'NIGHT_WARNING',
  RETURN_TO_BASE_SUGGESTION: 'RETURN_TO_BASE_SUGGESTION',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_FAILED: 'TASK_FAILED',
  TASK_INTERRUPTED: 'TASK_INTERRUPTED',
  BOT_RESPAWN: 'BOT_RESPAWN',
  GENERAL: 'GENERAL'
})

const { getChineseItemName } = require('../utils/item-names')
const { createChatCompletion: defaultCreateChatCompletion, parseLlmJson } = require('./llm-client')

const MOB_NAMES = Object.freeze({
  creeper: '苦力怕',
  zombie: '僵尸',
  skeleton: '骷髅',
  spider: '蜘蛛',
  cave_spider: '洞穴蜘蛛',
  witch: '女巫',
  enderman: '末影人',
  drowned: '溺尸',
  husk: '尸壳',
  stray: '流浪者',
  pillager: '掠夺者',
  phantom: '幻翼',
  slime: '史莱姆',
  magma_cube: '岩浆怪'
})

const TASK_NAMES = Object.freeze({
  follow_player: '跟随',
  mine_nearby_block: '挖附近方块',
  fight_nearby_mob: '战斗',
  mining: '挖矿',
  guard_player: '守护',
  return_to_player: '回到玩家身边',
  craft_item: '合成',
  eat_food: '吃东西',
  return_to_base: '回基地',
  sleep: '睡觉',
  smelt_item: '烧炼',
  build_blueprint: '盖房子',
  exploration: '探索',
  farming: '种地',
  storage: '整理箱子',
  prepare_combat: '备战',
  equip_armor: '穿盔甲',
  pickup_item: '捡东西'
})

function createReminderEvent(type, options = {}) {
  const input = typeof type === 'object' && type !== null ? type : { ...options, type }
  const normalizedType = input.type || REMINDER_TYPES.GENERAL
  const defaults = defaultsForEvent(normalizedType, input.facts || {})
  const facts = { ...(defaults.facts || {}), ...(input.facts || {}) }
  if (isBotStatusEvent(normalizedType) && !facts.statusOwner) facts.statusOwner = 'bot'
  return {
    type: normalizedType,
    severity: input.severity || defaults.severity,
    meaning: input.meaning || defaults.meaning,
    facts,
    suggestion: input.suggestion || defaults.suggestion,
    fallbackText: input.fallbackText || defaults.fallbackText,
    source: input.source || 'system',
    createdAt: input.createdAt || new Date().toISOString()
  }
}

class MessageGenerator {
  constructor(options = {}) {
    this.options = {
      model: process.env.REMINDER_LLM_MODEL || 'deepseek-chat',
      enableLlm: process.env.REMINDER_LLM_ENABLED !== 'false',
      maxTextLength: 120,
      timeoutMs: process.env.REMINDER_LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS,
      ...options
    }
    this.client = options.client || options.llmClient || null
    this.persona = options.persona || null
    this.createChatCompletion = options.createChatCompletionFn || defaultCreateChatCompletion
  }

  async generate(eventInput, context = {}) {
    const event = createReminderEvent(eventInput)
    const persona = context.persona || this.persona
    const personaName = getPersonaName(persona)

    if (this.client?.chat?.completions?.create && this.options.enableLlm) {
      try {
        const text = normalizeOwnerPronouns(await this.generateWithLlm(event, persona, context), event)
        if (validateGeneratedText(text, event)) {
          return { ok: true, text: trimText(text, this.options.maxTextLength), persona: personaName, source: 'persona', event }
        }
      } catch (err) {
        context.logger?.warn?.(`[MessageGenerator] persona generation failed: ${err.code || 'LLM_API_ERROR'} ${err.message}`)
      }
    }

    const text = defaultReminderText(event, persona)
    return { ok: true, text, persona: personaName, source: 'fallback', event }
  }

  async generateWithLlm(event, persona, context = {}) {
    const personaBrief = buildPersonaBrief(persona)
    const response = await this.createChatCompletion(this.client, {
      model: this.options.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You rewrite Minecraft AI reminder events into short Chinese chat lines.',
            'Return strict JSON: {"text":"..."} only.',
            'You may change tone, but you must preserve all facts and risk level.',
            'Never claim a danger is safe. Never invent actions already completed.',
            'When facts.statusOwner is "bot", speak in first person: 我的血量, 我快饿了. Do not say 你的血量 or 你快饿了.',
            'Do not include code, tool calls, markdown, or bot API names.',
            'Keep the line natural for TTS and under 60 Chinese characters.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            persona: personaBrief,
            event: {
              type: event.type,
              severity: event.severity,
              meaning: event.meaning,
              facts: event.facts,
              suggestion: event.suggestion
            }
          })
        }
      ]
    }, {
      context: 'message_generator',
      inputType: event.type,
      timeoutMs: this.options.timeoutMs,
      logger: context.logger || this.options.logger,
      fallback: 'local_template'
    })
    const content = response.choices?.[0]?.message?.content
    const parsed = parseLlmJson(content, {
      context: 'message_generator',
      inputType: event.type
    })
    return String(parsed.text || '').trim()
  }
}

async function generateReminderMessage(event, context = {}) {
  if (context.messageGenerator?.generate) return context.messageGenerator.generate(event, context)
  return new MessageGenerator({ persona: context.persona }).generate(event, context)
}

function defaultReminderText(eventInput, persona = null) {
  const event = createReminderEvent(eventInput)
  const style = getPersonaStyle(persona)
  const facts = event.facts || {}

  if (event.type === REMINDER_TYPES.TASK_FAILED) return taskFailedText(facts)
  if (event.type === REMINDER_TYPES.TASK_INTERRUPTED) return taskInterruptedText(facts)

  if (style === 'linxia') return linxiaText(event, facts)
  if (style === 'andy') return andyText(event, facts)
  return genericText(event, facts)
}

function linxiaText(event, facts) {
  switch (event.type) {
    case REMINDER_TYPES.INVENTORY_FULL:
      return `背包好像塞满了，空槽只剩${numberOrUnknown(facts.emptySlots)}个，我们先整理一下吧。`
    case REMINDER_TYPES.DANGER_NEARBY:
      return `小心，附近有${mobName(facts.mob)}，离我们大概${distanceText(facts.distance)}，先别冒进。`
    case REMINDER_TYPES.LOW_HEALTH:
      return `我血量有点低，剩${numberOrUnknown(facts.health)}点，先稳一下比较好。`
    case REMINDER_TYPES.LOW_FOOD:
      return `我快饿了，饥饿值只有${numberOrUnknown(facts.food)}，得找点吃的。`
    case REMINDER_TYPES.NIGHT_WARNING:
      return '天黑了，外面会更危险，我们小心点。'
    case REMINDER_TYPES.RETURN_TO_BASE_SUGGESTION:
      return '我记得基地位置，要不要先回去整理一下？'
    case REMINDER_TYPES.TASK_COMPLETED:
      return `${taskName(facts.taskType)}完成啦。`
    case REMINDER_TYPES.TASK_FAILED:
      return taskFailedText(facts)
    case REMINDER_TYPES.TASK_INTERRUPTED:
      return taskInterruptedText(facts)
    default:
      return event.fallbackText || event.meaning || '我发现了一些情况，需要你看一下。'
  }
}

function andyText(event, facts) {
  switch (event.type) {
    case REMINDER_TYPES.INVENTORY_FULL:
      return `背包已满，空槽${numberOrUnknown(facts.emptySlots)}个，建议回基地或找箱子整理。`
    case REMINDER_TYPES.DANGER_NEARBY:
      return `危险：附近有${mobName(facts.mob)}，距离约${distanceText(facts.distance)}，建议后退或准备战斗。`
    case REMINDER_TYPES.LOW_HEALTH:
      return `我的血量偏低：${numberOrUnknown(facts.health)}点，建议停止危险行动。`
    case REMINDER_TYPES.LOW_FOOD:
      return `我快饿了，饥饿值偏低：${numberOrUnknown(facts.food)}，需要补充食物。`
    case REMINDER_TYPES.NIGHT_WARNING:
      return '已进入夜晚，敌对生物风险上升。'
    case REMINDER_TYPES.RETURN_TO_BASE_SUGGESTION:
      return '已记录基地位置，建议返回基地整理资源。'
    case REMINDER_TYPES.TASK_COMPLETED:
      return `${taskName(facts.taskType)}已完成。`
    case REMINDER_TYPES.TASK_FAILED:
      return `${taskName(facts.taskType)}失败：${facts.error || '未知原因'}。`
    case REMINDER_TYPES.TASK_INTERRUPTED:
      return `${taskName(facts.taskType)}已中断：${facts.reason || '任务被打断'}。`
    default:
      return event.fallbackText || event.meaning || '检测到需要注意的状态。'
  }
}

function genericText(event, facts) {
  switch (event.type) {
    case REMINDER_TYPES.INVENTORY_FULL:
      return `背包满了，空槽${numberOrUnknown(facts.emptySlots)}个，建议先整理或回基地。`
    case REMINDER_TYPES.DANGER_NEARBY:
      return `附近有${mobName(facts.mob)}，距离约${distanceText(facts.distance)}，请小心。`
    case REMINDER_TYPES.LOW_HEALTH:
      return `我的血量偏低，当前${numberOrUnknown(facts.health)}点，我先小心一点。`
    case REMINDER_TYPES.LOW_FOOD:
      return `我快饿了，饥饿值当前${numberOrUnknown(facts.food)}，需要食物。`
    case REMINDER_TYPES.NIGHT_WARNING:
      return '天黑了，附近危险会上升。'
    case REMINDER_TYPES.RETURN_TO_BASE_SUGGESTION:
      return '已有基地位置，建议考虑回基地。'
    case REMINDER_TYPES.TASK_COMPLETED:
      return `${taskName(facts.taskType)}已完成。`
    case REMINDER_TYPES.TASK_FAILED:
      return `${taskName(facts.taskType)}失败：${facts.error || '未知原因'}。`
    case REMINDER_TYPES.TASK_INTERRUPTED:
      return `${taskName(facts.taskType)}已中断：${facts.reason || '任务被打断'}。`
    default:
      return event.fallbackText || event.meaning || '附近有情况，请注意。'
  }
}

function defaultsForEvent(type, facts = {}) {
  switch (type) {
    case REMINDER_TYPES.INVENTORY_FULL:
      return {
        severity: 'medium',
        meaning: '背包满了，需要提醒玩家先整理或回基地',
        facts,
        suggestion: '建议先回基地或找箱子存东西',
        fallbackText: '背包满了，建议先整理或回基地。'
      }
    case REMINDER_TYPES.DANGER_NEARBY:
      return {
        severity: 'high',
        meaning: '附近有危险生物，需要提醒玩家',
        facts,
        suggestion: '建议后退或准备战斗',
        fallbackText: '附近有危险，请小心。'
      }
    case REMINDER_TYPES.LOW_HEALTH:
      return {
        severity: 'high',
        meaning: '血量低，需要停止危险行动',
        facts,
        suggestion: '建议吃东西、撤退或回到安全位置',
        fallbackText: '我的血量偏低，我先小心一点。'
      }
    case REMINDER_TYPES.LOW_FOOD:
      return {
        severity: 'medium',
        meaning: '饥饿值低，需要补充食物',
        facts,
        suggestion: '建议吃东西或寻找食物',
        fallbackText: '我快饿了，需要食物。'
      }
    case REMINDER_TYPES.NIGHT_WARNING:
      return {
        severity: 'medium',
        meaning: '世界进入夜晚，危险会上升',
        facts,
        suggestion: '建议回基地或提高警惕',
        fallbackText: '天黑了，请小心。'
      }
    case REMINDER_TYPES.RETURN_TO_BASE_SUGGESTION:
      return {
        severity: 'medium',
        meaning: '当前状态适合返回基地',
        facts,
        suggestion: '建议返回基地整理或避险',
        fallbackText: '建议考虑返回基地。'
      }
    case REMINDER_TYPES.TASK_COMPLETED:
      return {
        severity: 'low',
        meaning: '任务已经完成',
        facts,
        suggestion: '可以继续下一个任务',
        fallbackText: '任务完成了。'
      }
    case REMINDER_TYPES.TASK_FAILED:
      return {
        severity: 'medium',
        meaning: '任务执行失败',
        facts,
        suggestion: '需要检查失败原因后再继续',
        fallbackText: '任务失败了。'
      }
    case REMINDER_TYPES.TASK_INTERRUPTED:
      return {
        severity: 'medium',
        meaning: '任务被中断',
        facts,
        suggestion: '可以稍后恢复或重新下达任务',
        fallbackText: '任务已中断。'
      }
    case REMINDER_TYPES.BOT_RESPAWN:
      return {
        severity: 'high',
        meaning: '我刚才死了一次，已经在出生点复活，手上的事都停了',
        facts,
        suggestion: '需要玩家重新安排，或带我回去',
        fallbackText: respawnText(facts)
      }
    default:
      return {
        severity: 'low',
        meaning: '系统产生了一条提醒',
        facts,
        suggestion: '请注意当前状态',
        fallbackText: '我发现了一些情况，需要你看一下。'
      }
  }
}

function validateGeneratedText(text, eventInput) {
  const textValue = String(text || '').trim()
  if (!textValue) return false
  const event = createReminderEvent(eventInput)
  const facts = event.facts || {}

  if (event.type === REMINDER_TYPES.DANGER_NEARBY) {
    if (/(没危险|没有危险|不危险|安全|没什么问题)/.test(textValue)) return false
    if (facts.mob) {
      const local = mobName(facts.mob)
      const raw = String(facts.mob)
      if (!textValue.includes(local) && !textValue.includes(raw)) return false
    }
  }

  if (event.type === REMINDER_TYPES.INVENTORY_FULL && /(没满|还有很多|不用整理)/.test(textValue)) return false
  if (event.type === REMINDER_TYPES.LOW_HEALTH && /(血量很高|不用担心血量)/.test(textValue)) return false
  if (event.type === REMINDER_TYPES.LOW_FOOD && /(不饿|食物充足|饥饿值很高)/.test(textValue)) return false
  if (facts.statusOwner === 'bot' && /(你的血量|你血量|你快饿|你饿了|你的饥饿|你的饱食)/.test(textValue)) return false
  return true
}

function isBotStatusEvent(type) {
  return [
    REMINDER_TYPES.LOW_HEALTH,
    REMINDER_TYPES.LOW_FOOD,
    REMINDER_TYPES.INVENTORY_FULL,
    REMINDER_TYPES.BOT_RESPAWN
  ].includes(type)
}

// 复活后对玩家说的那一句（修缮 17）。keepInventory 关着时东西会掉，说清楚；
// 手上停掉的活也点一下名，免得玩家以为她还在盖。
function respawnText(facts = {}) {
  const parts = ['我刚才死了，在出生点复活了']
  if (facts.inventoryLost === true) parts.push('身上的东西没了')
  else if (facts.inventoryLost === false) parts.push('东西还在身上')
  const dropped = Array.isArray(facts.droppedTaskTypes)
    ? [...new Set(facts.droppedTaskTypes.filter(Boolean).map(type => taskName(type)))]
    : []
  if (dropped.length) parts.push(`手上的${dropped.join('、')}也停了`)
  return `${parts.join('，')}。`
}

function normalizeOwnerPronouns(text, eventInput) {
  const event = createReminderEvent(eventInput)
  if (event.facts?.statusOwner !== 'bot') return text
  return String(text || '')
    .replace(/你的血量/g, '我的血量')
    .replace(/你血量/g, '我血量')
    .replace(/你快饿了/g, '我快饿了')
    .replace(/你饿了/g, '我饿了')
    .replace(/你的饥饿值/g, '我的饥饿值')
    .replace(/你的饱食度/g, '我的饱食度')
}

function taskFailedText(facts = {}) {
  const name = taskName(facts.taskType)
  const error = String(facts.displayError || friendlyTaskError(facts.error) || '').trim()
  if (!error) return `${name}没成功，我先停一下，别乱做。`
  return `${name}没成功，${error}`
}

function taskInterruptedText(facts = {}) {
  const name = taskName(facts.taskType)
  const reason = String(facts.displayReason || friendlyTaskError(facts.reason) || '').trim()
  if (!reason) return `${name}先停下了，我等你下一步安排。`
  return `${name}先停下了，${reason}`
}

function createTaskReminderEvent(task, status, options = {}) {
  const taskType = friendlyTaskType(task)
  const treeState = task?.miningState?.treeState || task?.result?.miningState?.treeState || task?.result?.treeState || null
  const facts = {
    taskId: task?.id ?? null,
    taskType,
    rawTaskType: task?.type || 'unknown_task',
    mode: task?.mode || task?.params?.mode || null,
    status,
    error: task?.error || null,
    displayError: friendlyTaskError(task?.error || null, options),
    rawError: task?.error || null,
    reason: task?.interruptReason || task?.pauseReason || null,
    displayReason: friendlyTaskError(task?.interruptReason || task?.pauseReason || null, options),
    rawReason: task?.interruptReason || task?.pauseReason || null,
    finishReason: treeState?.finishReason || task?.miningState?.finishReason || task?.result?.finishReason || null,
    targetTreeCount: treeState?.targetTreeCount ?? null,
    completedTreeCount: treeState?.completedTreeCount ?? null,
    targetLogCount: treeState?.targetLogCount ?? null,
    choppedLogCount: treeState?.choppedLogCount ?? null,
    canExpandSearch: treeState?.canExpandSearch === true
  }

  if (status === 'completed') {
    return createReminderEvent(REMINDER_TYPES.TASK_COMPLETED, { facts })
  }
  if (status === 'failed') {
    const partialTreeText = partialTreeFailureText(facts)
    return createReminderEvent(REMINDER_TYPES.TASK_FAILED, {
      severity: 'medium',
      facts,
      fallbackText: partialTreeText || undefined,
      suggestion: '建议检查条件后再重试'
    })
  }
  return createReminderEvent(REMINDER_TYPES.TASK_INTERRUPTED, {
    severity: 'medium',
    facts,
    suggestion: '可以稍后恢复或重新下达任务'
  })
}

function partialTreeFailureText(facts = {}) {
  if (facts.finishReason !== 'partial_completed_no_more_trees') return null
  if (facts.targetTreeCount != null) {
    const done = Number(facts.completedTreeCount || 0)
    const target = Number(facts.targetTreeCount || 0)
    const missing = Math.max(0, target - done)
    return `我只砍完了 ${done} 棵树，附近没有找到更多树了，还差 ${missing} 棵。要不要我扩大范围继续找？`
  }
  if (facts.targetLogCount != null) {
    const done = Number(facts.choppedLogCount || 0)
    const target = Number(facts.targetLogCount || 0)
    const missing = Math.max(0, target - done)
    return `我现在只砍到 ${done} 个木头，附近没有更多树了，还差 ${missing} 个。要不要我走远一点继续找？`
  }
  return '我只完成了一部分，附近暂时没有更多树了。要不要我扩大范围继续找？'
}

function getPersonaName(persona) {
  return persona?.name || persona?.username || 'default'
}

function getPersonaStyle(persona) {
  const marker = `${persona?.username || ''} ${persona?.name || ''}`.toLowerCase()
  if (marker.includes('linxia') || marker.includes('林夏')) return 'linxia'
  if (marker.includes('andy') || marker.includes('安迪')) return 'andy'
  return 'generic'
}

function buildPersonaBrief(persona) {
  if (!persona) return { name: 'default' }
  return {
    name: persona.name,
    username: persona.username,
    styleHint: String(persona.systemPrompt || '').slice(0, 800)
  }
}

function mobName(name) {
  if (!name) return '危险生物'
  return MOB_NAMES[name] || String(name).replace(/_/g, ' ')
}

function taskName(type) {
  return TASK_NAMES[type] || type || '任务'
}

function friendlyTaskType(task) {
  const mode = task?.mode || task?.params?.mode || null
  if (mode === 'HARVEST_FARM') return '收小麦'
  if (mode === 'PLANT_WHEAT') return '补种小麦'
  if (mode === 'FARM_CYCLE') return '收割补种'
  if (mode === 'MAKE_BREAD') return '合成面包'
  if (mode === 'EAT_FOOD') return '吃东西'
  if (mode === 'CHECK_FOOD') return '检查食物'
  return task?.type || 'unknown_task'
}

// 失败原因 → 人话 的对照表（修缮 17，清单第 9 条）。以前只有两句写死的话管着
// 所有失败，第 16 轮量到的五种真实原因没有一种说对。按顺序匹配，第一条命中的
// 算数；`key` 是整串相等，`prefix` 是前缀。表里没有的才走兜底，而且兜底时把
// 原始 key 打进日志，别再被人话盖住。
const FAILURE_REASON_TABLE = [
  { key: 'LLM_TIMEOUT', text: '我刚才反应慢了一下，先停一下，别乱挖。' },
  { key: 'TOOL_CALL_INTERRUPTED', text: '刚才这步没处理完整，我先不继续乱猜。' },
  { key: 'bot_died', text: '我死了一次，手上的事都停了' },
  // 玩家自己叫停的，不用再解释原因（真机：「跟随先停下了，这一步没处理完整」）。
  { key: 'player_command', text: '' },
  { key: 'stop_follow', text: '' },
  { key: 'follow_player_command', text: '' },
  { key: 'player_wake_command', text: '' },
  { key: 'return_to_base_command', text: '' },
  { key: 'return_to_player_command', text: '' },
  { key: 'inventory_full', text: '背包满了，得先存点东西' },
  { key: 'escape_exhausted', text: stuckText },
  { key: 'stuck_recovery_failed', text: stuckText },
  { key: 'build_origin_too_far', text: '离工地太远，先带我过去' },
  { key: 'danger_too_high', text: '附近太危险，我先不动' },
  { key: 'Food is full', text: '我不饿，吃不下' },
  { key: 'mob_too_far', text: '那只怪离得太远，我够不着' },
  { prefix: 'sleep_failed_monsters_nearby', text: '附近有怪，睡不了' },
  { prefix: 'sleep_failed_no_bed', text: '附近没有床' },
  { key: 'verified_real_community_samples_unavailable', text: '这张图纸开不了工，找不到参考样板' },
  { prefix: 'entity_obstruction:', text: entityObstructionText },
  { prefix: 'smelt_failed_no_fuel', text: '没燃料，我手上没有煤炭' },
  { prefix: 'smelt_failed_no_input', text: '手上没有要烧的原料' },
  { prefix: 'no_furnace', text: '附近没有熔炉' },
  { prefix: 'pickup_failed:drop_not_found', text: '挖到了但没捡到掉落物' },
  { prefix: 'pickup_failed', text: '掉落物没捡到' },
  { prefix: 'auto_preparation_failed:unsupported_min_tier:', text: friendlyUnsupportedMinTier },
  { prefix: 'missing_required_tool:', text: friendlyRequiredTool },
  { prefix: 'missing_materials:', text: friendlyMissingMaterials },
  { prefix: 'reserved_item_conflict:', text: friendlyReservedConflict },
  { prefix: 'no_recipe:', text: key => `找不到${getChineseItemName(key.slice('no_recipe:'.length))}的可用配方` },
  { prefix: 'chest_item_not_found:', text: key => `箱子里没有${getChineseItemName(key.slice('chest_item_not_found:'.length))}` },
  { prefix: 'chest_category_not_found:', text: key => `箱子里没有${categoryName(key.slice('chest_category_not_found:'.length))}` },
  { key: 'no_mature_wheat', text: '附近没有成熟的小麦' },
  { key: 'missingSeeds', text: '没有小麦种子' },
  { key: 'missing_seeds', text: '没有小麦种子' },
  { key: 'no_empty_farmland', text: '没有需要补种的耕地' },
  { key: 'no_crafting_table', text: '附近没有工作台，无法合成面包' },
  { key: 'not_enough_wheat', text: '小麦不够，至少需要 3 个' },
  { key: 'no_food', text: '没有普通安全食物' },
  { key: 'food_not_found', text: '没有普通安全食物' },
  { key: 'task_interrupted', text: '任务已中断' },
  { key: 'move_timeout', text: '路径不可达或移动超时' },
  { key: 'recipe_not_found', text: '找不到可用合成配方' }
]

function friendlyTaskError(error, options = {}) {
  const key = String(error || '')
  if (!key) return null
  for (const entry of FAILURE_REASON_TABLE) {
    if (!matchesFailureReason(entry, key)) continue
    return typeof entry.text === 'function' ? entry.text(key, options) : entry.text
  }
  if (looksTechnicalReason(key)) {
    const text = friendlyGenericTaskIssue(key)
    const logger = options.logger || console
    logger.log?.(`[TASK_FEEDBACK_UNMAPPED] key=${key} text=${text}`)
    return text
  }
  return key
}

function matchesFailureReason(entry, key) {
  if (entry.key) return key === entry.key
  if (entry.prefix) return key.startsWith(entry.prefix)
  return false
}

// entity_obstruction:<name>:<pos>:<pos> —— 站在工地里的是玩家就点名请他挪，
// 是怪就说等它走开。这是清单第 3 条的提示侧；判据侧（等待/换原点）归建造线。
function entityObstructionText(key) {
  const name = String(key).slice('entity_obstruction:'.length).split(':')[0].trim()
  if (!name) return '有人站在我要盖的地方，往旁边挪几步我再盖'
  if (MOB_NAMES[name]) return `有只${MOB_NAMES[name]}站在我要盖的地方，我先等它走开`
  return `${name}，你站在我要盖的地方，往旁边挪几步我再盖`
}

function stuckText(key, options = {}) {
  const position = options.position
  if (position && Number.isFinite(Number(position.x))) {
    return `我卡在 ${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)} 出不来了`
  }
  return '我卡住出不来了，来拉我一把'
}

function looksTechnicalReason(key) {
  return /[:_]/.test(key) || /^[A-Z0-9_]+$/.test(key)
}

function friendlyGenericTaskIssue(key) {
  if (/timeout/i.test(key)) return '我刚才反应慢了一下，先停一下，别乱做。'
  if (/partial_completed_no_more_trees/i.test(key)) return '附近能找到的树不够，我先停一下，别乱跑远。'
  if (/missing|not_found|no_/i.test(key)) return '附近条件不够，我先停一下，别乱动。'
  return '这一步没处理完整，我先停一下，别乱做。'
}

function friendlyUnsupportedMinTier(key) {
  const tier = key.slice('auto_preparation_failed:unsupported_min_tier:'.length).split(':')[0]
  return friendlyToolTier(tier)
}

function friendlyRequiredTool(key) {
  const required = key.slice('missing_required_tool:'.length)
  const tier = String(required).split('_')[0]
  return friendlyToolTier(tier)
}

function friendlyToolTier(tier) {
  const labels = {
    wooden: '\u6728\u9550',
    stone: '\u77f3\u9550',
    iron: '\u94c1\u9550',
    diamond: '\u94bb\u77f3\u9550',
    netherite: '\u4e0b\u754c\u5408\u91d1\u9550'
  }
  const label = labels[tier] || '\u66f4\u9ad8\u7ea7\u7684\u9550\u5b50'
  const english = tier === 'iron' ? ' (iron pickaxe or better)' : ''
  return `\u6211\u73b0\u5728\u7684\u9550\u5b50\u7b49\u7ea7\u4e0d\u591f\uff0c\u8fd9\u79cd\u65b9\u5757\u81f3\u5c11\u9700\u8981${label}\u6216\u66f4\u9ad8\u7ea7\u7684\u9550\u3002${english}`
}

function friendlyMissingMaterials(key) {
  const rest = key.slice('missing_materials:'.length)
  const separator = rest.indexOf(':')
  const target = separator >= 0 ? rest.slice(0, separator) : null
  const json = separator >= 0 ? rest.slice(separator + 1) : rest
  let missing = []
  try {
    missing = JSON.parse(json)
  } catch {
    missing = []
  }
  const text = missing
    .map(item => `${Number(item.needed || 1)} 个${getChineseItemName(item.item)}`)
    .join('、')
  const targetName = target ? getChineseItemName(target) : '这个'
  return text ? `做${targetName}还缺 ${text}` : `做${targetName}的材料不够`
}

function friendlyReservedConflict(key) {
  const rest = key.slice('reserved_item_conflict:'.length)
  const target = rest.split(':')[0]
  return `做${getChineseItemName(target)}会消耗预留物品，暂时不自动动这些材料`
}

function categoryName(category) {
  const labels = {
    food: '食物',
    wood: '木头',
    logs: '原木',
    planks: '木板',
    tool: '工具',
    weapon: '武器',
    armor: '防具'
  }
  return labels[category] || category
}

function distanceText(distance) {
  if (distance == null || Number.isNaN(Number(distance))) return '不远'
  return `${Number(distance).toFixed(1)}格`
}

function numberOrUnknown(value) {
  if (value == null || value === '') return '未知'
  return Number.isFinite(Number(value)) ? Number(value) : value
}

function trimText(text, maxLength) {
  const value = String(text || '').trim()
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength)
}

module.exports = {
  MessageGenerator,
  REMINDER_TYPES,
  createReminderEvent,
  createTaskReminderEvent,
  defaultReminderText,
  friendlyTaskName: taskName,
  generateReminderMessage,
  validateGeneratedText
}
