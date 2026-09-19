const { installConsoleFileLogger } = require('./utils/file-logger')
if (require.main === module) installConsoleFileLogger()

require('dotenv').config()

const mineflayer  = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { checkProtectedBuildingDig } = require('./systems/protected-buildings')
const { resolveTargetVersion } = require('./systems/blueprint-version-compatibility')
const pvp         = require('mineflayer-pvp').plugin
const OpenAI      = require('openai')
const { Vec3 }    = require('vec3')
const tts         = require('./tts')
const { findMinecraftPort } = require('./port-finder')
const { createTaskManager } = require('./tasks/task-manager')
const { ActionLock } = require('./core/action-lock')
const { Blackboard } = require('./core/blackboard')
const { WorldState } = require('./perception/world-state')
const { TickLoop } = require('./core/tick-loop')
const { routePlayerCommand, formatCommandResponse } = require('./ai/command-router')
const { intentToTask } = require('./ai/intent-to-task')
const { ACTION_KEYS } = require('./ai/action-keys')
const { createLlmActionKeyClassifier } = require('./ai/action-key-classifier')
const { GoalSystem } = require('./ai/goal-system')
const { PlanningSystem } = require('./ai/planning-system')
const { MessageGenerator } = require('./ai/message-generator')
const { createChatCompletion } = require('./ai/llm-client')
const { appendAssistantTurn } = require('./ai/chat-history')
const { createGameMemory } = require('./memory')
const { toBlockVec3 } = require('./utils/position')
const { EquipmentSystem } = require('./systems/EquipmentSystem')
const { CraftingSystem } = require('./systems/CraftingSystem')
const { StorageSystem } = require('./systems/storage-system')
const { AutoPreparationSystem } = require('./systems/AutoPreparationSystem')
const { enableDoorTraversal, stopMovement } = require('./actions/move')
const {
  claimLegacyEscapeMovement,
  releaseLegacyEscapeMovement
} = require('./utils/legacy-movement-guard')
const { createEventLoopProbeFromEnv } = require('./utils/event-loop-probe')
const { createConnectionSupervisorFromEnv } = require('./core/connection-supervisor')
const { createDeathHandler } = require('./core/death-handler')
const connectionState = require('./core/connection-state')
const { formatStatusLine } = require('./utils/status-line')

// ─── 人设加载 ─────────────────────────────────────────────────────────────────
const DEFAULT_PERSONA_ID = 'andy'
const DEFAULT_PERSONA = require(`./personas/${DEFAULT_PERSONA_ID}`)
const persona = process.env.PERSONA
  ? require(`./personas/${process.env.PERSONA}`)
  : DEFAULT_PERSONA
console.log(`[persona] loaded: ${persona.name} (${persona.username})`)

// ─── DeepSeek 客户端 ──────────────────────────────────────────────────────────
const deepseek = (require.main === module || process.env.DEEPSEEK_API_KEY)
  ? new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com'
    })
  : null

function readTimeoutMs(envNames, fallbackMs) {
  for (const name of envNames) {
    const parsed = Number(process.env[name])
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return fallbackMs
}

const INTENT_LLM_TIMEOUT_MS = readTimeoutMs(['INTENT_LLM_TIMEOUT_MS'], 3000)
const REMINDER_LLM_TIMEOUT_MS = readTimeoutMs(['REMINDER_LLM_TIMEOUT_MS'], 1500)
const CHAT_LLM_TIMEOUT_MS = readTimeoutMs(['CHAT_LLM_TIMEOUT_MS', 'LLM_TIMEOUT_MS'], 8000)
const PROACTIVE_LLM_TIMEOUT_MS = readTimeoutMs(['PROACTIVE_LLM_TIMEOUT_MS'], 1500)

function createBotActionKeyClassifier(client, options = {}) {
  return createLlmActionKeyClassifier(client, {
    timeoutMs: INTENT_LLM_TIMEOUT_MS,
    ...options
  })
}

function createBotReminderMessageGenerator(options = {}) {
  return new MessageGenerator({
    client: options.client || deepseek,
    persona: options.persona || persona,
    timeoutMs: REMINDER_LLM_TIMEOUT_MS,
    ...options
  })
}

async function runBotChatLoop(options = {}) {
  const {
    client = deepseek,
    createChatCompletionFn = createChatCompletion,
    messages,
    playerName,
    playerMessage,
    tools,
    executeTool,
    trimHistory = () => {},
    say = () => {},
    sendReply = () => {},
    speak = () => {},
    logger = console,
    timeoutMs = CHAT_LLM_TIMEOUT_MS
  } = options

  if (!Array.isArray(messages)) throw new TypeError('messages must be an array')
  messages.push({ role: 'user', content: `[${playerName}]: ${playerMessage}` })
  trimHistory()

  for (let round = 0; round < 10; round++) {
    let resp
    try {
      resp = await createChatCompletionFn(client, {
        model: 'deepseek-chat',
        messages,
        tools,
        tool_choice: 'auto'
      }, {
        context: 'chat_loop',
        inputType: 'ordinary_chat',
        timeoutMs,
        logger,
        fallback: 'local_chat_fallback'
      })
    } catch (err) {
      logger.error?.('[AI] API error:', err.code || 'LLM_API_ERROR', err.message)
      if (err.code === 'LLM_TIMEOUT') say('我刚才理解有点慢，我们先用明确指令来做任务吧。')
      else say('我现在连不上理解模块，你可以先用明确指令告诉我要做什么。')
      return { ok: false, code: err.code || 'LLM_API_ERROR', error: err }
    }

    const choice = resp.choices?.[0] || {}
    if (choice.finish_reason === 'tool_calls') {
      const calls = choice.message?.tool_calls || []
      logger.log?.(`[AI] tool calls: ${calls.map(c => c.function?.name).join(', ')}`)
      try {
        await appendAssistantTurn(messages, choice.message, {
          logger,
          executeTool
        })
      } catch (err) {
        logger.error?.('[TOOL_CALL_INTERRUPTED]', err.message)
        say('刚才这步没处理完整，我先不继续乱猜。')
        return { ok: false, code: 'TOOL_CALL_INTERRUPTED', error: err }
      }
    } else {
      messages.push(choice.message)
      const reply = choice.message?.content || ''
      if (reply) {
        sendReply(reply)
        speak(reply)
      }
      return { ok: true, code: 'CHAT_COMPLETED', reply }
    }
  }

  return { ok: false, code: 'CHAT_ROUND_LIMIT' }
}

async function generateProactiveLine(options = {}) {
  const {
    client = deepseek,
    createChatCompletionFn = createChatCompletion,
    persona: activePersona = persona,
    envDesc,
    logger = console,
    timeoutMs = PROACTIVE_LLM_TIMEOUT_MS
  } = options

  const prompt = `现在是你主动找主人说话的时机，根据下面的环境信息，以你的人设说一句自然的话（可以是关心、可以是分享、可以是吐槽）。只回复一句话，不要超过50字。\n\n${envDesc}`
  const res = await createChatCompletionFn(client, {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: activePersona.systemPrompt },
      { role: 'user', content: prompt }
    ],
    max_tokens: 80
  }, {
    context: 'proactive_chat',
    inputType: 'environment_summary',
    timeoutMs,
    logger,
    fallback: 'skip_proactive'
  })
  return res.choices[0]?.message?.content?.trim() || ''
}

const classifyActionKey = createBotActionKeyClassifier(deepseek)
const reminderMessageGenerator = createBotReminderMessageGenerator()

// ─── 状态 ─────────────────────────────────────────────────────────────────────
let isFollowing = false
let isGuarding  = false
let isEscaping  = false
let isFighting  = false
let isEating    = false
let isPickingUp = false
let guardTimer  = null
let mcData      = null
let taskSystem  = null
let actionLock  = null
let blackboard  = null
let worldState  = null
let tickLoop    = null
let memorySystem = null
let goalSystem = null
let planningSystem = null
let equipmentSystem = null
let craftingSystem = null
let storageSystem = null
let autoPreparationSystem = null
let lastAutoPickupAt = 0
let legacyEscapeMovementClaim = null
let eventLoopProbe = null
let statusTimer = null
let systemsInitialized = false
let connectionPausedTask = null

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','witch',
  'blaze','ghast','slime','magma_cube','enderman','silverfish',
  'vindicator','evoker','vex','pillager','ravager','phantom',
  'drowned','husk','stray','wither_skeleton','zombified_piglin'
])

const FOOD_ITEMS = new Set([
  'bread','cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton',
  'cooked_rabbit','cooked_salmon','cooked_cod','apple','golden_apple',
  'enchanted_golden_apple','carrot','baked_potato','pumpkin_pie',
  'mushroom_stew','rabbit_stew','beetroot_soup','melon_slice',
  'sweet_berries','glow_berries','dried_kelp','cookie','chorus_fruit'
])

// ─── 对话历史 ─────────────────────────────────────────────────────────────────
let messages = [{ role: 'system', content: persona.systemPrompt }]

function trimHistory() {
  // system + 最多 40 条(20 轮)，超出保留最近 36 条(18 轮)
  if (messages.length <= 41) return
  messages = [messages[0], ...messages.slice(-36)]
}

// ─── 主入口（异步，用于端口检测）─────────────────────────────────────────────
async function main() {
  // .env 里有 MC_PORT 则直接用，否则自动扫描
  let port
  if (process.env.MC_PORT) {
    port = parseInt(process.env.MC_PORT, 10)
    console.log(`[端口] 使用 .env 指定端口: ${port}`)
  } else {
    try {
      port = await findMinecraftPort()
    } catch (err) {
      console.error(`\n❌ ${err.message}\n`)
      process.exit(1)
    }
  }

// ─── 创建 bot ─────────────────────────────────────────────────────────────────
// The protocol version is pinned rather than negotiated, so it has to follow
// whichever server this lane is pointed at. `resolveTargetVersion` is the same
// resolver the blueprint compatibility gate uses (explicit -> MC_VERSION ->
// default), so a run cannot end up planning blocks for one version while
// talking to another. The default stays 1.20.1 on purpose: the building lane's
// server has not been upgraded yet, and only the repair lane's trial server
// runs 1.21.8 (via MC_VERSION=1.21.8).
const mcVersion = resolveTargetVersion(null)
console.log(`[版本] 连接协议版本: ${mcVersion}${process.env.MC_VERSION ? ' (来自 MC_VERSION)' : ' (默认值)'}`)

// The bot object is single-use: after its socket ends, the only way back is a
// new bot. The connection supervisor owns that (backoff reconnect, generation
// tracking); this file wires the same handlers onto every bot it hands over.
// BOT_RECONNECT=false restores the old behaviour (stay dead after 'end').
const createBot = () => {
  const created = mineflayer.createBot({
    host:     'localhost',
    port,
    username: persona.username,
    version:  mcVersion,
    auth:     'offline'
  })
  created.loadPlugin(pathfinder)
  created.loadPlugin(pvp)
  return created
}
// 她死了整套系统不知道（修缮 16 清单第 2 条）——死亡/复活只在这一处接，
// 具体做什么见 core/death-handler.js。系统是上线后才建的，所以按需取。
// 必须在 connection.connect() 之前建好：第一只 bot 是同步发出来的。
const deathHandler = createDeathHandler({
  logger: console,
  say: text => botSay(text),
  systems: () => ({
    taskManager: taskSystem,
    goalSystem,
    blackboard,
    memory: memorySystem,
    messageGenerator: reminderMessageGenerator,
    persona
  }),
  onDeath: resetLegacyModesAfterDeath
})
const connection = createConnectionSupervisorFromEnv(process.env, { createBot, logger: console })
let bot = null
connection.on('bot', (nextBot, info) => {
  bot = nextBot
  registerBotEventHandlers(nextBot)
  if (info.reconnect) console.log(`[连接] 第 ${info.generation - 1} 次重连：正在连接 ...`)
})
connection.on('online', onConnectionOnline)
connection.on('offline', onConnectionOffline)
connection.on('reconnect_scheduled', info => {
  console.log(`[连接] 已断线(${info.reason})，${(info.delayMs / 1000).toFixed(0)}s 后第 ${info.attempt}/${info.maxAttempts} 次重连`)
})
connection.on('reconnect_disabled', onReconnectDisabled)
connection.on('gave_up', onReconnectGaveUp)
connection.on('kicked', reason => console.log('被踢出:', reason))
connection.on('bot_error', err => console.log('报错:', err))
console.log(`[连接] 自动重连=${connection.enabled ? '开' : '关(BOT_RECONNECT=false)'} 上限=${connection.options.maxAttempts} 次 退避=${connection.options.backoffMs.join('/')}ms`)
connection.connect()

function registerBotEventHandlers(target) {
  target.once('spawn', onBotSpawn)
  target.on('health', onBotHealth)
  target.on('entitySpawn', onBotEntitySpawn)
  target.on('chat', onBotChat)
  target.on('end', onBotEnd)
  deathHandler.attach(target)
}

// bot.js 自己那几面老旗子（逃生/战斗/吃/捡）也按「她已经不在那儿」复位。
// 跟随/守护那两面是玩家开的，留给现有逻辑；不新加任何自动行为。
function resetLegacyModesAfterDeath() {
  const before = { escaping: isEscaping, fighting: isFighting, eating: isEating, pickingUp: isPickingUp }
  if (isEscaping) exitEscapeMode()
  isFighting = false
  isEating = false
  isPickingUp = false
  try { bot?.pvp?.stop?.() } catch {}
  console.log(`[BOT_DEATH_LEGACY_RESET] escaping=${before.escaping} fighting=${before.fighting} eating=${before.eating} pickingUp=${before.pickingUp}`)
}

function currentTaskLabel() {
  const task = taskSystem?.currentTask
  return task ? `${task.type}#${task.id}` : null
}

function printStatusLine() {
  if (!connection.isOnline()) {
    console.log(formatStatusLine({
      online: false,
      reason: connection.lastEndReason,
      reconnect: connection.status(),
      pausedTask: connectionPausedTask?.label || null
    }))
    return
  }
  const p = bot?.entity?.position
  console.log(formatStatusLine({
    online: true,
    position: p,
    health: bot?.health,
    food: bot?.food,
    mode: getCurrentMode()
  }))
}

function onConnectionOnline(info) {
  connectionState.setOnline(true)
  console.log(`[连接] 在线 generation=${info.generation} reconnected=${info.reconnected}`)
}

// Runs on 'end'. Everything that must know the socket is dead happens here:
// the world/position we hold is now a cache, so the tick loop stops, the
// current task is paused (not spun locally against a dead bot), and the run
// store refuses verdict writes until we are back.
function onConnectionOffline(info) {
  connectionState.setOnline(false, info.reason)
  console.log(`[连接] 离线 reason=${info.reason} wasOnline=${info.wasOnline} generation=${info.generation}`)
  if (guardTimer)      { clearInterval(guardTimer); guardTimer = null }
  if (_proactiveTimer) { clearTimeout(_proactiveTimer); _proactiveTimer = null }
  if (tickLoop)        tickLoop.stop()
  if (!connection.enabled) return
  pauseCurrentTaskForConnectionLoss()
}

function pauseCurrentTaskForConnectionLoss() {
  if (!taskSystem?.currentTask) return
  const task = taskSystem.currentTask
  const label = `${task.type}#${task.id}`
  connectionPausedTask = { taskId: task.id, label }
  taskSystem.pauseCurrent('connection_lost')
    .then(paused => console.log(`[连接] 任务已暂停 task=${label} paused=${paused}`))
    .catch(err => console.log(`[连接] 暂停任务失败 task=${label} error=${err.message}`))
}

async function resumeTaskAfterReconnect() {
  const paused = connectionPausedTask
  connectionPausedTask = null
  if (!paused || !taskSystem) return
  try {
    const resumed = await taskSystem.resumePaused('connection_restored', { taskId: paused.taskId })
    console.log(`[连接] 任务恢复 task=${paused.label} resumed=${resumed}`)
  } catch (err) {
    console.log(`[连接] 任务恢复失败 task=${paused.label} error=${err.message}`)
  }
}

// Legacy stay-dead behaviour (BOT_RECONNECT=false): identical to the old
// 'end' handler.
function onReconnectDisabled() {
  if (taskSystem)    taskSystem.stop()
  if (_voiceCleanup) _voiceCleanup()
}

function onReconnectGaveUp(info) {
  console.log(`[连接] 已放弃重连 attempts=${info.attempts}/${info.maxAttempts} lastReason=${info.reason} —— 进程将退出(exitCode=1)`)
  if (taskSystem)      taskSystem.stop()
  if (_voiceCleanup)   _voiceCleanup()
  if (eventLoopProbe)  eventLoopProbe.stop()
  if (statusTimer)     { clearInterval(statusTimer); statusTimer = null }
  process.exitCode = 1
}

// ─── 通用辅助 ─────────────────────────────────────────────────────────────────
function getCurrentMode() {
  const m = []
  if (isEscaping)  m.push('逃生中')
  if (isFighting)  m.push('战斗中')
  if (isFollowing) m.push('跟随中')
  if (isGuarding)  m.push('守护中')
  return m.length ? m.join('/') : '空闲'
}

// What the bot was doing when the event loop stalled (EVENT_LOOP_PROBE=true).
// Read defensively: it runs from a timer, possibly mid-task.
function describeRuntimeContext() {
  const task = taskSystem?.currentTask || null
  const session = task?.system?.session || null
  return {
    task: task ? `${task.type}#${task.id}` : 'none',
    state: task?.state || 'idle',
    phase: session?.constructionRun?.currentPhase || session?.currentPhase || 'none',
    step: task?.currentStepIndex ?? 'none',
    mode: getCurrentMode()
  }
}

// Non-construction movement (follow/come/move_to/pickup command paths) must
// never terraform: no digging, no scaffold towers. Construction moves go
// through actions/move.js configureMovements with explicit per-purpose options.
const mkMovements = () => {
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  // doors/gates are traversable (state-aware open/pass-through), never dug
  enableDoorTraversal(bot, movements)
  return movements
}
const findFood    = () => bot.inventory.items().find(i => FOOD_ITEMS.has(i.name))

// 发聊天 + 同步触发 TTS
function botSay(text) {
  const msg = text.substring(0, 250)
  debugRuntimeState.lastChatReply = msg
  if (!connection.isOnline()) {
    console.log(`[离线] 未发送聊天: ${msg}`)
    return
  }
  bot.chat(msg)
  tts.speak(msg).catch(() => {})
}

function sendLongChat(text) {
  const LIMIT = 250
  let remaining = text.trim()
  let delay = 0
  while (remaining.length > 0) {
    let chunk = remaining.substring(0, LIMIT)
    if (remaining.length > LIMIT) {
      const cut = Math.max(
        chunk.lastIndexOf('。'), chunk.lastIndexOf('！'),
        chunk.lastIndexOf('？'), chunk.lastIndexOf('，'),
        chunk.lastIndexOf(' ')
      )
      if (cut > LIMIT / 2) chunk = chunk.substring(0, cut + 1)
    }
    const c = chunk  // capture for closure
    setTimeout(() => bot.chat(c), delay)
    remaining = remaining.substring(chunk.length).trim()
    delay += 1200
  }
}

// ─── AI 工具定义 ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'chat',
      description: '在游戏聊天框发消息',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: '获取 bot 当前坐标、血量、饥饿度、游戏时间、天气、运行模式',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_inventory',
      description: '获取背包所有物品和数量',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_nearby_blocks',
      description: '扫描周围方块，返回各种方块数量统计（按数量降序，最多25种）',
      parameters: {
        type: 'object',
        properties: { radius: { type: 'number', description: '扫描半径，最大16，默认10' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_nearby_entities',
      description: '获取周围实体列表（玩家、动物、怪物），含类型、距离、坐标',
      parameters: {
        type: 'object',
        properties: { radius: { type: 'number', description: '扫描半径，默认16' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_block',
      description: '找附近最近的指定方块，返回坐标',
      parameters: {
        type: 'object',
        properties: {
          blockName:   { type: 'string', description: '方块英文 ID，如 oak_log、diamond_ore' },
          maxDistance: { type: 'number', description: '最大搜索距离，默认32' }
        },
        required: ['blockName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: '用 pathfinder 走到指定坐标，等待到达（最多20秒）后返回结果',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'follow_player',
      description: '持续跟随指定玩家，保持2格距离',
      parameters: {
        type: 'object',
        properties: { playerName: { type: 'string', description: '玩家游戏名' } },
        required: ['playerName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_follow',
      description: '停止跟随，停在原地',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dig_block',
      description: '挖掉指定坐标的方块',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'place_block',
      description: '在指定坐标放置方块，背包里必须有该方块',
      parameters: {
        type: 'object',
        properties: {
          blockName: { type: 'string', description: '方块英文 ID，如 dirt、oak_planks' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' }
        },
        required: ['blockName', 'x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'equip_item',
      description: '把背包里的物品装备到主手',
      parameters: {
        type: 'object',
        properties: { itemName: { type: 'string', description: '物品英文 ID' } },
        required: ['itemName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attack_entity',
      description: '用 pvp 插件持续攻击附近指定名称的实体',
      parameters: {
        type: 'object',
        properties: { entityName: { type: 'string', description: '实体名称，如 zombie、skeleton' } },
        required: ['entityName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_at',
      description: '让 bot 看向指定坐标',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' }
        },
        required: ['x', 'y', 'z']
      }
    }
  }
]

TOOLS.push(
  {
    type: 'function',
    function: {
      name: 'start_task',
      description: 'Create a lifecycle-managed task. High priority tasks can pause lower priority tasks and resume them later.',
      parameters: {
        type: 'object',
        properties: {
          taskType: {
            type: 'string',
            enum: ['follow_player', 'mine_nearby_block', 'fight_nearby_mob', 'mining', 'guard_player', 'return_to_player']
          },
          username: { type: 'string' },
          playerName: { type: 'string' },
          blockName: { type: 'string' },
          mobName: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          range: { type: 'number' },
          radius: { type: 'number' },
          durationMs: { type: 'number' },
          priority: { type: 'number' }
        },
        required: ['taskType']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_task_status',
      description: 'Get current autonomous task status, queued tasks, and home position.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'interrupt_current_task',
      description: 'Interrupt the currently running task and release its action locks.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' }
        }
      }
    }
  }
)

const SAFE_CHAT_TOOL_NAMES = new Set([
  'chat',
  'get_status',
  'get_inventory',
  'get_nearby_blocks',
  'get_nearby_entities',
  'find_block',
  'get_task_status'
])
const CHAT_TOOLS = TOOLS.filter(tool => SAFE_CHAT_TOOL_NAMES.has(tool.function?.name))

// ─── 工具执行器 ───────────────────────────────────────────────────────────────
async function executeTool(call) {
  const name = call.function.name
  const args = JSON.parse(call.function.arguments || '{}')
  console.log(`  ┣ 执行: ${name}(${JSON.stringify(args)})`)

  try {
    switch (name) {

      case 'chat': {
        const chatMsg = String(args.message).substring(0, 250)
        bot.chat(chatMsg)
        tts.speak(chatMsg).catch(() => {})
        return { success: true }
      }

      case 'get_status': {
        const p = bot.entity.position
        const t = bot.time.timeOfDay
        const timeStr = t < 6000 ? '清晨' : t < 12000 ? '白天' : t < 13800 ? '黄昏' : '夜晚'
        return {
          position: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
          health: bot.health,
          food: bot.food,
          time: timeStr,
          weather: bot.isRaining ? '下雨' : '晴天',
          mode: getCurrentMode()
        }
      }

      case 'get_inventory': {
        const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
        return { items, total_stacks: items.length }
      }

      case 'get_nearby_blocks': {
        const r   = Math.min(args.radius || 10, 16)
        const pos = toBlockVec3(bot.entity.position)
        if (!pos) return { radius: r, blocks: [], error: 'missing_position' }
        const counts = {}
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dz = -r; dz <= r; dz++) {
              if (dx*dx + dy*dy + dz*dz > r*r) continue
              const b = bot.blockAt(pos.offset(dx, dy, dz))
              if (b && b.name !== 'air' && b.name !== 'cave_air') {
                counts[b.name] = (counts[b.name] || 0) + 1
              }
            }
          }
        }
        const blocks = Object.entries(counts)
          .sort(([,a],[,b]) => b - a).slice(0, 25)
          .map(([name, count]) => ({ name, count }))
        return { radius: r, blocks }
      }

      case 'get_nearby_entities': {
        const r   = args.radius || 16
        const pos = bot.entity.position
        const entities = Object.values(bot.entities)
          .filter(e => e !== bot.entity && pos.distanceTo(e.position) <= r)
          .map(e => ({
            name:     e.username || e.name || e.type,
            type:     e.type,
            distance: +pos.distanceTo(e.position).toFixed(1),
            position: { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1) }
          }))
          .sort((a, b) => a.distance - b.distance)
        return { count: entities.length, entities }
      }

      case 'find_block': {
        if (!mcData) return { error: 'mcData 未初始化' }
        const type = mcData.blocksByName[args.blockName]
        if (!type) return { error: `未知方块: ${args.blockName}` }
        const block = bot.findBlock({ matching: type.id, maxDistance: args.maxDistance || 32 })
        if (!block) return { found: false, message: `附近没有 ${args.blockName}` }
        return { found: true, position: { x: block.position.x, y: block.position.y, z: block.position.z } }
      }

      case 'move_to': {
        bot.pathfinder.setMovements(mkMovements())
        bot.pathfinder.setGoal(new goals.GoalNear(args.x, args.y, args.z, 1))
        const reached = await new Promise(resolve => {
          let done = false
          const onReached = () => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve(true)
          }
          const timer = setTimeout(() => {
            if (done) return
            done = true
            bot.removeListener('goal_reached', onReached)
            resolve(false)
          }, 20000)
          bot.once('goal_reached', onReached)
        })
        const p = bot.entity.position
        return {
          reached,
          current_position: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }
        }
      }

      case 'follow_player': {
        const player = bot.players[args.playerName]
        if (!player?.entity) return { error: `找不到玩家 ${args.playerName}` }
        isFollowing = true
        bot.pathfinder.setMovements(mkMovements())
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true)
        return { success: true, following: args.playerName }
      }

      case 'stop_follow': {
        clearLegacyFollowState('legacy_tool_stop_follow')
        return { success: true }
      }

      case 'dig_block': {
        const block = bot.blockAt(new Vec3(args.x, args.y, args.z))
        if (!block || block.name === 'air') return { error: '该位置没有方块' }
        const buildingGuard = checkProtectedBuildingDig({ logger: console }, block.position, { source: 'legacy_tool_dig_block' })
        if (!buildingGuard.allowed) return { error: `受保护建筑，拒绝挖掘 (run ${buildingGuard.region.runId})` }
        await bot.dig(block)
        return { success: true, dug: block.name }
      }

      case 'place_block': {
        if (!mcData) return { error: 'mcData 未初始化' }
        const itemType = mcData.itemsByName[args.blockName]
        if (!itemType) return { error: `未知方块/物品: ${args.blockName}` }
        const invItem = bot.inventory.findInventoryItem(itemType.id)
        if (!invItem) return { error: `背包里没有 ${args.blockName}` }
        await bot.equip(invItem, 'hand')
        const target = new Vec3(args.x, args.y, args.z)
        const faces = [
          new Vec3(0,1,0), new Vec3(0,-1,0),
          new Vec3(1,0,0), new Vec3(-1,0,0),
          new Vec3(0,0,1), new Vec3(0,0,-1)
        ]
        for (const face of faces) {
          const ref = bot.blockAt(target.plus(face))
          if (ref && ref.name !== 'air') {
            await bot.placeBlock(ref, face.scaled(-1))
            return { success: true, placed: args.blockName }
          }
        }
        return { error: '找不到可放置的相邻面，请先确保目标位置旁边有方块' }
      }

      case 'equip_item': {
        if (!mcData) return { error: 'mcData 未初始化' }
        const itemType = mcData.itemsByName[args.itemName]
        if (!itemType) return { error: `未知物品: ${args.itemName}` }
        const invItem = bot.inventory.findInventoryItem(itemType.id)
        if (!invItem) return { error: `背包里没有 ${args.itemName}` }
        await bot.equip(invItem, 'hand')
        return { success: true, equipped: args.itemName }
      }

      case 'attack_entity': {
        const entity = Object.values(bot.entities).find(
          e => e.name === args.entityName || e.username === args.entityName
        )
        if (!entity) return { error: `附近没有 ${args.entityName}` }
        isFighting = true
        bot.pvp.attack(entity)
        return { success: true, attacking: entity.name || entity.username }
      }

      case 'look_at': {
        await bot.lookAt(new Vec3(args.x, args.y, args.z))
        return { success: true }
      }

      case 'start_task': {
        if (!taskSystem) return { error: 'task system not initialized' }
        const task = taskSystem.enqueue(
          args.taskType,
          {
            username: args.username,
            playerName: args.playerName,
            blockName: args.blockName,
            mobName: args.mobName,
            x: args.x,
            y: args.y,
            z: args.z,
            range: args.range,
            radius: args.radius,
            durationMs: args.durationMs
          },
          args.priority || 5,
          'ai_tool'
        )
        return { queued: true, task }
      }

      case 'get_task_status': {
        if (!taskSystem) return { error: 'task system not initialized' }
        return taskSystem.status()
      }

      case 'interrupt_current_task': {
        if (!taskSystem) return { error: 'task system not initialized' }
        return { interrupted: await taskSystem.interruptCurrent(args.reason || 'ai_tool_interrupt') }
      }

      default:
        return { error: `未知工具: ${name}` }
    }
  } catch (err) {
    console.log(`  ┗ [工具错误] ${name}: ${err.message}`)
    return { error: err.message }
  }
}

// ─── AI 主调用循环 ────────────────────────────────────────────────────────────
async function callDeepSeek(playerName, playerMessage) {
  console.log(`\n[AI] player ${playerName}: "${playerMessage}"`)
  return runBotChatLoop({
    client: deepseek,
    messages,
    playerName,
    playerMessage,
    tools: CHAT_TOOLS,
    trimHistory,
    say: botSay,
    logger: console,
    executeTool: async call => {
      const result = await executeTool(call)
      const str = JSON.stringify(result)
      console.log(`[tool result] ${str.length > 160 ? str.substring(0, 160) + '...' : str}`)
      return str
    },
    sendReply: reply => {
      const preview = reply.length > 100 ? reply.substring(0, 100) + '...' : reply
      console.log(`[AI] final reply "${preview}"`)
      sendLongChat(reply)
    },
    speak: reply => tts.speak(reply).catch(() => {})
  })
}

// ─── bot 行为模块 ─────────────────────────────────────────────────────────────
async function autoEat() {
  if (isEating) return
  const food = findFood()
  if (!food) { console.log('[饥饿] 没吃的了'); return }
  try {
    isEating = true
    await bot.equip(food, 'hand')
    await bot.consume()
    console.log(`[饥饿] 吃了 ${food.name}，饥饿度: ${bot.food}`)
  } catch (e) {
    console.log('[饥饿] 吃饭失败:', e.message)
  } finally {
    isEating = false
  }
}

function enterEscapeMode() {
  if (isEscaping) return
  const claim = claimLegacyEscapeMovement(taskSystem, actionLock)
  if (!claim.ok) {
    console.log(
      `[LEGACY_ESCAPE_DEFERRED] reason=${claim.reason} ` +
      `task=${claim.taskType || 'none'} taskId=${claim.taskId ?? 'none'} ` +
      `movementOwner=${claim.movementOwner ?? 'none'} buildingOwner=${claim.buildingOwner ?? 'none'}`
    )
    return
  }
  legacyEscapeMovementClaim = claim
  isEscaping = true; isFighting = false
  bot.pvp.stop()
  botSay('血量危险！撤退！')
  console.log('[逃生] 进入逃生模式')
  doEscape()
}
function doEscape() {
  if (!isEscaping) return
  const t = bot.players['action']?.entity
  if (!t) return
  bot.pathfinder.setMovements(mkMovements())
  bot.pathfinder.setGoal(new goals.GoalFollow(t, 1), true)
}
function exitEscapeMode() {
  isEscaping = false
  const released = releaseLegacyEscapeMovement(actionLock, legacyEscapeMovementClaim)
  legacyEscapeMovementClaim = null
  if (!released.ok) {
    console.log(`[LEGACY_ESCAPE_LOCK_RELEASE_FAILED] reason=${released.reason || 'unknown'}`)
  }
  console.log('[逃生] 血量恢复，退出逃生模式')
  if (isFollowing) startFollow()
  else bot.pathfinder.stop()
}

function startFollow() {
  const t = bot.players['action']?.entity
  if (!t) { botSay('找不到你...'); return }
  bot.pathfinder.setMovements(mkMovements())
  bot.pathfinder.setGoal(new goals.GoalFollow(t, 2), true)
}

function startGuard() {
  if (guardTimer) clearInterval(guardTimer)
  guardTimer = setInterval(() => {
    if (!isGuarding || isEscaping) return
    const hostile = Object.values(bot.entities).find(e =>
      HOSTILE_MOBS.has(e.name) && bot.entity.position.distanceTo(e.position) <= 8
    )
    if (hostile) {
      if (!isFighting) { isFighting = true; console.log(`[守护] 发现 ${hostile.name}，开始攻击`) }
      bot.pvp.attack(hostile)
    } else if (isFighting) {
      isFighting = false; bot.pvp.stop()
      console.log('[守护] 敌人消失，停止战斗')
      if (isFollowing) startFollow()
    }
  }, 500)
}
function stopGuard() {
  isGuarding = false; isFighting = false
  bot.pvp.stop()
  if (guardTimer) { clearInterval(guardTimer); guardTimer = null }
}

async function pickupItem(entity) {
  if (isPickingUp || isEscaping || isFighting) return
  isPickingUp = true
  const itemName = entity.displayName || entity.name || 'item'
  const startDistance = bot.entity.position.distanceTo(entity.position).toFixed(1)
  console.log(`[danger] entity=${entity.id ?? 'unknown'} type=item hostile=false ignored=true`)
  console.log(`[avoidance] entity=${entity.id ?? 'unknown'} type=item avoided=false reason=item_not_danger`)
  console.log(`[pickup] item=${itemName} distance=${startDistance} action=move_to_item result=start`)
  console.log(`[捡物] 距离 ${bot.entity.position.distanceTo(entity.position).toFixed(1)} 格，前往捡取`)
  bot.pathfinder.setMovements(mkMovements())
  bot.pathfinder.setGoal(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1))
  await new Promise(resolve => {
    const done = () => { bot.removeListener('goal_reached', done); resolve() }
    bot.once('goal_reached', done)
    setTimeout(() => { bot.removeListener('goal_reached', done); resolve() }, 5000)
  })
  isPickingUp = false
  console.log(`[pickup] item=${itemName} distance=0 action=wait_collect result=ok`)
  console.log('[捡物] 完成')
  if (isEscaping)       doEscape()
  else if (isFollowing) startFollow()
}

// ─── Spawn ────────────────────────────────────────────────────────────────────
async function onBotSpawn() {
  if (systemsInitialized) {
    await onBotRespawnAfterReconnect()
    return
  }
  systemsInitialized = true
  mcData = require('minecraft-data')(bot.version)
  actionLock = new ActionLock()
  memorySystem = createGameMemory()
  blackboard = new Blackboard({
    config: {
      ownerName: process.env.MC_OWNER || process.env.PLAYER_NAME || null
    }
  })
  worldState = new WorldState({
    entityScanRadius: Number(process.env.WORLD_ENTITY_SCAN_RADIUS || 24),
    blockScanRadius: Number(process.env.WORLD_BLOCK_SCAN_RADIUS || 3)
  })
  planningSystem = new PlanningSystem()
  equipmentSystem = new EquipmentSystem()
  craftingSystem = new CraftingSystem()
  storageSystem = new StorageSystem()
  autoPreparationSystem = new AutoPreparationSystem({
    equipmentSystem,
    craftingSystem,
    storageSystem
  })
  taskSystem = createTaskManager(bot, {
    actionLock,
    blackboard,
    equipmentSystem,
    autoPreparationSystem,
    craftingSystem,
    storageSystem,
    taskMemory: memorySystem.task,
    memory: memorySystem,
    planningSystem,
    messageGenerator: reminderMessageGenerator,
    reminderOutput: text => botSay(text),
    persona
  })
  goalSystem = new GoalSystem()
  tickLoop = new TickLoop({
    bot,
    actionLock,
    blackboard,
    worldState,
    goalSystem,
    planningSystem,
    memory: memorySystem,
    equipmentSystem,
    autoPreparationSystem,
    craftingSystem,
    storageSystem,
    taskManager: taskSystem,
    messageGenerator: reminderMessageGenerator,
    reminderOutput: text => botSay(text),
    persona,
    intervalMs: Number(process.env.AI_TICK_MS || 500)
  })
  tickLoop.start()
  eventLoopProbe = createEventLoopProbeFromEnv(process.env, { contextProvider: describeRuntimeContext })
  eventLoopProbe?.start()
  botSay(persona.greeting)
  console.log('[Bot] 上线成功，AI 大脑已就绪')
  scheduleDevParallelSmeltHarness()
  _scheduleProactive()

  if (!statusTimer) statusTimer = setInterval(printStatusLine, 10000)
}

// A fresh bot after a reconnect: the systems survive, only the bot handle
// underneath them changed. Re-point the task manager and tick loop at it,
// restart the timers the offline handler stopped, then resume whatever the
// disconnect paused through the task manager's ordinary resume path.
async function onBotRespawnAfterReconnect() {
  if (taskSystem) taskSystem.bot = bot
  if (tickLoop)   tickLoop.options.bot = bot
  console.log(`[Bot] 重连成功 generation=${connection.generation}，接着干`)
  await resumeTaskAfterReconnect()
  if (tickLoop && !tickLoop.isRunning()) tickLoop.start()
  _scheduleProactive()
  if (isGuarding)  startGuard()
  if (isFollowing) startFollow()
}

// ─── 血量/饥饿监听 ────────────────────────────────────────────────────────────
function onBotHealth() {
  // 血量 0 是死了，不是「危险」：这一拍紧跟着 death 事件，逃生模式在这里
  // 进去只会喊一句「血量危险！撤退！」然后立刻被死亡复位撤掉（修缮 17 真机所见）。
  if (bot.health <= 0) return
  if (bot.health <= 6 && !isEscaping)  enterEscapeMode()
  if (bot.health >= 16 && isEscaping)  exitEscapeMode()
  if (bot.food <= 15 && !isEating)     autoEat()
}

// ─── 自动捡物 ─────────────────────────────────────────────────────────────────
function onBotEntitySpawn(entity) {
  if (entity.name !== 'item') return
  maybeQueuePlayerOfferedPickup(entity)
}

function maybeQueuePlayerOfferedPickup(entity) {
  const config = {
    enabled: true,
    playerDroppedItemRadius: 6,
    maxPickupDistance: 12,
    cooldownMs: 1500
  }
  if (!config.enabled || !taskSystem || isEscaping || isFighting) return
  if (!bot?.entity?.position || !entity?.position) return
  const now = Date.now()
  if (now - lastAutoPickupAt < config.cooldownMs) return

  const botDistance = bot.entity.position.distanceTo(entity.position)
  if (botDistance > config.maxPickupDistance) return
  const player = bot.players?.[process.env.MC_OWNER || process.env.PLAYER_NAME || 'action']?.entity ||
    Object.values(bot.players || {}).map(p => p.entity).filter(Boolean)
      .sort((a, b) => a.position.distanceTo(entity.position) - b.position.distanceTo(entity.position))[0]
  const playerDistance = player?.position?.distanceTo?.(entity.position) ?? Infinity
  const offeredByPlayer = playerDistance <= config.playerDroppedItemRadius
  console.log(`[pickup-detect] item=${entity.displayName || entity.name || 'item'} itemPos=${formatPos(entity.position)} playerDistance=${round(playerDistance)} botDistance=${round(botDistance)} offeredByPlayer=${offeredByPlayer}`)
  console.log(`[avoidance] entity=${entity.id ?? 'unknown'} type=item avoided=false reason=item_not_danger`)
  if (!offeredByPlayer) return

  lastAutoPickupAt = now
  console.log(`[pickup] auto=false item=${entity.displayName || entity.name || 'item'} action=observe_only reason=await_player_command`)
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 'unknown'
}

// ─── 聊天处理（硬指令优先，其余交给 AI）──────────────────────────────────────
const HARD_CMDS = {
  '过来': (u) => {
    const t = bot.players[u]?.entity
    if (!t) { botSay(persona.responses.comeNotFound); return }
    bot.pathfinder.setMovements(mkMovements())
    bot.pathfinder.setGoal(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2))
    botSay(persona.responses.come)
  },
  '停':    ()  => { isFollowing = false; bot.pathfinder.stop(); botSay(persona.responses.stop) },
  '跟我':  ()  => { isFollowing = true; botSay(persona.responses.follow); startFollow() },
  '别跟了':()  => { isFollowing = false; bot.pathfinder.stop(); botSay(persona.responses.stop) },
  '守护我':()  => { isGuarding = true; botSay(persona.responses.guard); startGuard() },
  '别打了':()  => { stopGuard(); botSay(persona.responses.unguard) },
  '状态':  ()  => {
    const p = bot.entity.position
    botSay(persona.responses.status(p, bot.health, bot.food))
  },
  '帮助':  ()  => botSay(persona.responses.help)
}

let _lastPlayerChat = 0
let pendingAction = null
const debugRuntimeState = {
  lastAction: null,
  lastActionAt: null,
  lastActionKey: null,
  lastChatReply: null,
  failureCode: null
}

// 统一入口：语音输入和 MC 聊天栏都走这里
async function handleUserChat(username, message) {
  _lastPlayerChat = Date.now()
  console.log('[CHAT_INPUT]', JSON.stringify({ username, message }))
  if (handleDebugStatusCommand(username, message)) return
  if (taskSystem && await executePendingActionIfConfirmed(username, message)) return

  if (taskSystem && shouldRouteBeforeHardCommand(message)) {
    const routed = await routeTaskCommand(username, message)
    if (routed) return
  }

  if (HARD_CMDS[message]) {
    HARD_CMDS[message](username)
    return
  }

  if (taskSystem) {
    const routed = await routeTaskCommand(username, message)
    if (routed) return
  }

  await callDeepSeek(username, message)
}

async function routeTaskCommand(username, message) {
  const routeResult = await routePlayerCommand(message, createTaskContext(username))
  rememberRouteResult(routeResult)
  syncLegacyFollowStateAfterRoute(routeResult)

  if (routeResult.shouldConfirm) {
    setPendingAction(routeResult, message)
  }

  if (routeResult.handled) {
    const response = formatCommandResponse(routeResult)
    if (response) botSay(response)
    return true
  }

  return false
}

function createTaskContext(username) {
  return {
    playerName: username,
    taskManager: taskSystem,
    blackboard,
    memory: memorySystem,
    planningSystem,
    equipmentSystem,
    autoPreparationSystem,
    craftingSystem,
    storageSystem,
    llmClassifier: classifyActionKey,
    logger: console,
    bot
  }
}

function scheduleDevParallelSmeltHarness() {
  if (process.env.DEV_PARALLEL_SMELT_HARNESS !== 'true') return
  console.log('[dev-smelting-parallel] enabled')

  setTimeout(() => {
    if (!taskSystem?.enqueue) {
      console.log('[dev-smelting-parallel] blocked reason=task_manager_unavailable')
      return
    }

    const status = typeof taskSystem.status === 'function' ? taskSystem.status() : {}
    const currentTask = status.currentTask || status.current || null
    if (currentTask) {
      console.log(`[dev-smelting-parallel] blocked reason=current_task_active task=${currentTask.type || 'unknown'} id=${currentTask.id ?? 'unknown'}`)
      return
    }

    const params = {
      inputName: 'raw_iron',
      count: 10,
      parallelFurnaces: true,
      actionKey: 'SMELT_ITEM',
      rawText: '[dev] parallel smelt raw_iron x10'
    }
    console.log('[dev-smelting-parallel] enqueue smelt_item inputName=raw_iron count=10 parallelFurnaces=true')
    const task = taskSystem.enqueue('smelt_item', params, 5, 'dev_parallel_smelt_harness')
    console.log(`[dev-smelting-parallel] enqueued taskId=${task?.id ?? 'unknown'} state=${task?.state || 'unknown'}`)
  }, 1500)
}

function handleDebugStatusCommand(username, message) {
  const text = String(message || '').trim().toLowerCase()
  if (!['debug_status', 'get_task_status'].includes(text)) return false
  const status = buildAcceptanceDebugStatus(username)
  console.log(`[DEBUG_STATUS] ${JSON.stringify(status)}`)
  if (!isAcceptanceProbeUser(username)) botSay(`debug_status_ready ${status.taskType || 'idle'}`)
  return true
}

function buildAcceptanceDebugStatus(requestedBy = null) {
  const status = taskSystem?.status?.({ lightweight: true, acceptance: true }) || {}
  const currentTask = status.currentTask || status.current || null
  const activeFollowTask = currentTask?.type === 'follow_player'
    ? currentTask
    : (status.currentMovementTask?.type === 'follow_player' ? status.currentMovementTask : null)
  const locks = status.activeLocks?.locks || status.locks?.locks || {}
  return {
    botUsername: bot.username,
    botPosition: formatDebugPosition(bot.entity?.position),
    currentTask,
    taskType: currentTask?.type || null,
    taskStatus: currentTask?.state || null,
    actionKey: currentTask?.params?.actionKey || debugRuntimeState.lastActionKey || null,
    lockOwner: resolveLockOwner(locks),
    countRequested: currentTask?.params?.count ?? status.currentStorageTask?.count ?? null,
    countCompleted: resolveCountCompleted(status),
    failureCode: status.lastError?.error || debugRuntimeState.failureCode || null,
    lastAction: debugRuntimeState.lastAction,
    lastActionAt: debugRuntimeState.lastActionAt,
    lastChatReply: debugRuntimeState.lastChatReply,
    followTarget: activeFollowTask?.targetPlayer || activeFollowTask?.params?.playerName || activeFollowTask?.params?.username || null,
    isFollowing: Boolean(activeFollowTask),
    dangerLevel: status.dangerLevel ?? null,
    inventorySummary: summarizeDebugInventory(status.inventoryState),
    requestedBy,
    acceptedPlayers: acceptedPlayerNames()
  }
}

function syncLegacyFollowStateAfterRoute(routeResult = {}) {
  const actionKey = routeResult.actionKey || routeResult.parsed?.actionKey || routeResult.action?.actionKey || null
  if (actionKey === ACTION_KEYS.FOLLOW_PLAYER) {
    isFollowing = false
    return
  }
  if ([ACTION_KEYS.CANCEL_TASK, ACTION_KEYS.STOP_CURRENT_TASK, ACTION_KEYS.PAUSE_TASK].includes(actionKey)) {
    clearLegacyFollowState(`route_${actionKey}`)
  }
}

function clearLegacyFollowState(reason = 'stop_follow') {
  isFollowing = false
  stopMovement(bot, reason, null)
}

function rememberRouteResult(routeResult = {}) {
  const actionKey = routeResult.actionKey || routeResult.parsed?.actionKey || routeResult.action?.actionKey || null
  const action = routeResult.action?.action || routeResult.intent || 'route'
  rememberAction(action, actionKey)
  if (routeResult.action?.error || routeResult.action?.reason || routeResult.action?.task?.error) {
    debugRuntimeState.failureCode = routeResult.action.error || routeResult.action.reason || routeResult.action.task.error
  }
}

function rememberAction(action, actionKey = null) {
  debugRuntimeState.lastAction = action || null
  debugRuntimeState.lastActionKey = actionKey || debugRuntimeState.lastActionKey || null
  debugRuntimeState.lastActionAt = new Date().toISOString()
}

function resolveLockOwner(locks = {}) {
  const active = Object.values(locks).filter(Boolean)
  if (!active.length) return null
  return active.map(lock => `${lock.type}:${lock.owner}`).join(',')
}

function resolveCountCompleted(status = {}) {
  const storageMoved = (status.currentStorageTask?.withdrawnItems || [])
    .concat(status.currentStorageTask?.storedItems || [])
    .reduce((sum, item) => sum + Number(item.count || 0), 0)
  const farmingMoved =
    Number(status.harvestedItems?.length || 0) +
    Number(status.plantedCount || 0) +
    Number(status.madeBreadCount || 0) +
    (status.eatenFood ? 1 : 0)
  return storageMoved || farmingMoved || null
}

function summarizeDebugInventory(inventoryState = {}) {
  if (!inventoryState) return null
  const counts = inventoryState.counts || Object.fromEntries((inventoryState.items || []).map(item => [item.name, item.count]))
  return {
    emptySlots: inventoryState.emptySlots ?? null,
    usedSlots: inventoryState.usedSlots ?? null,
    counts,
    items: (inventoryState.items || []).map(item => ({
      name: item.name,
      count: item.count
    })),
    heldItem: inventoryState.heldItem?.name || null,
    heldItemCount: inventoryState.heldItem?.count || null
  }
}

function formatDebugPosition(position) {
  if (!position) return null
  return {
    x: Math.round(Number(position.x) * 100) / 100,
    y: Math.round(Number(position.y) * 100) / 100,
    z: Math.round(Number(position.z) * 100) / 100
  }
}

function acceptedPlayerNames() {
  return [
    process.env.MC_OWNER,
    process.env.PLAYER_NAME,
    process.env.ACCEPTANCE_TEST_USERNAME,
    process.env.ACCEPTANCE_PLAYER_USERNAME,
    'action',
    'accept_tester',
    'AcceptanceTester',
    'acceptance_tester'
  ].filter(Boolean)
}

function isAcceptanceProbeUser(username) {
  return ['action', 'accept_tester', 'AcceptanceTester', 'acceptance_tester'].includes(username)
}

function isAcceptedPlayer(username) {
  return acceptedPlayerNames().includes(username)
}

async function executePendingActionIfConfirmed(username, message) {
  if (!pendingAction || !isConfirmationMessage(message)) return false

  if (Date.now() > pendingAction.expiresAt) {
    pendingAction = null
    botSay('刚才那个待确认的任务已经失效，我会重新判断当前这句话。')
    return true
  }

  const action = pendingAction
  pendingAction = null
  console.log(`[CONFIRMATION_MATCHED] text=${message} actionKey=${action.actionKey}`)
  console.log(`[PENDING_ACTION_EXECUTE] actionKey=${action.actionKey} args=${JSON.stringify(action.args || {})}`)

  const decision = {
    ...action.decision,
    params: action.args || {},
    shouldExecute: true,
    confidence: 1
  }
  console.log(`[INTENT_RESULT] actionKey=${storageLogActionKey(decision.actionKey)} intent=${decision.intent} executed=true ${JSON.stringify({
    rawText: action.sourceText,
    actionKey: decision.actionKey,
    intent: decision.intent,
    confidence: decision.confidence,
    source: decision.source,
    reason: decision.reason,
    shouldExecute: decision.shouldExecute,
    whetherExecuted: true
  })}`)

  const result = await intentToTask(decision, createTaskContext(username))
  rememberAction('confirmed_action', decision.actionKey)
  const response = formatCommandResponse({
    handled: true,
    shouldConfirm: false,
    actionKey: decision.actionKey,
    action: result
  })
  if (response) botSay(response)
  return true
}

function setPendingAction(routeResult, sourceText) {
  const parsed = routeResult.parsed || routeResult
  pendingAction = {
    actionKey: parsed.actionKey,
    args: parsed.params || {},
    taskType: taskTypeForActionKey(parsed.actionKey),
    sourceText,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
    reason: parsed.reason || null,
    target: {
      itemName: parsed.params?.itemName || null,
      mode: parsed.params?.mode || null,
      actionKey: parsed.actionKey
    },
    decision: parsed
  }
  console.log(`[PENDING_ACTION_SET] actionKey=${pendingAction.actionKey} args=${JSON.stringify(pendingAction.args)}`)
}

function isConfirmationMessage(message) {
  const text = String(message || '').replace(/[，。！？、,.!?\s]/g, '')
  return ['好', '是', '对', '继续', '再试一次', '拿吧', '放吧', '可以', '行'].some(phrase => text.includes(phrase))
}

function taskTypeForActionKey(actionKey) {
  const taskTypes = {
    [ACTION_KEYS.FOLLOW_PLAYER]: 'follow_player',
    [ACTION_KEYS.RETURN_TO_PLAYER]: 'return_to_player',
    [ACTION_KEYS.STORE_ITEMS]: 'storage',
    [ACTION_KEYS.TAKE_ITEMS]: 'storage',
    [ACTION_KEYS.CHECK_STORAGE]: 'storage',
    [ACTION_KEYS.REMEMBER_CHEST]: 'storage',
    [ACTION_KEYS.REMEMBER_FARM]: 'farming',
    [ACTION_KEYS.HARVEST_FARM]: 'farming',
    [ACTION_KEYS.PLANT_WHEAT]: 'farming',
    [ACTION_KEYS.FARM_CYCLE]: 'farming',
    [ACTION_KEYS.MAKE_BREAD]: 'farming',
    [ACTION_KEYS.EAT_FOOD]: 'eat_food',
    [ACTION_KEYS.CHECK_INVENTORY]: 'inventory_status',
    [ACTION_KEYS.CHECK_FOOD]: 'farming',
    [ACTION_KEYS.PAUSE_TASK]: 'task_lifecycle',
    [ACTION_KEYS.RESUME_TASK]: 'task_lifecycle',
    [ACTION_KEYS.CANCEL_TASK]: 'task_lifecycle',
    [ACTION_KEYS.STOP_CURRENT_TASK]: 'task_lifecycle'
  }
  return taskTypes[actionKey] || null
}

function storageLogActionKey(actionKey) {
  if (actionKey === ACTION_KEYS.STORE_ITEMS) return 'STORAGE_DEPOSIT'
  if (actionKey === ACTION_KEYS.TAKE_ITEMS) return 'STORAGE_WITHDRAW'
  return actionKey
}

function shouldRouteBeforeHardCommand(message) {
  const normalized = String(message || '').replace(/[，。！？、,.!?\s]/g, '')
  if ([
    '跟着我', '跟着我走', '陪我走', '跟上我', '跟我走',
    '来我身边', '过来', '到我这里', '来我这里',
    '停一下', '暂停一下', '先别动', '先停一下',
    '继续', '继续跟', '继续任务',
    '取消当前任务', '取消任务', '不用跟着我了', '别跟着我了',
    '不要跟我了', '你别跟了', '停止跟随', '取消跟随',
    '别再跟着我', '先别跟我', '别跟了', '不用跟了'
  ].some(phrase => normalized.includes(phrase))) return true

  const text = String(message || '').replace(/[，。！？,.!?\s]/g, '')
  return [
    '跟着我', '跟着我走', '陪我走', '跟上我', '跟我走',
    '来我身边', '过来', '到我这里', '来我这里',
    '停一下', '暂停一下', '先别动', '先停一下',
    '继续', '继续跟', '继续任务',
    '取消当前任务', '取消任务', '别跟了', '不用跟了', '不要跟了'
  ].some(phrase => text.includes(phrase))
}

function onBotChat(username, message) {
  if (!isAcceptedPlayer(username)) {
    console.log('[CHAT_IGNORED]', JSON.stringify({ username, message, acceptedPlayers: acceptedPlayerNames() }))
    return
  }
  handleUserChat(username, message)
}

// ─── 主动说话 ─────────────────────────────────────────────────────────────────
const PROACTIVE_ENABLED = process.env.PROACTIVE_CHAT_ENABLED !== 'false'
let _proactiveTimer = null

function _scheduleProactive() {
  if (!PROACTIVE_ENABLED) return
  const delay = 240000 + Math.random() * 120000  // 4~6 分钟随机
  _proactiveTimer = setTimeout(async () => {
    await _doProactive()
    _scheduleProactive()
  }, delay)
  console.log(`[主动] 下次说话在 ${(delay / 60000).toFixed(1)} 分钟后`)
}

async function _doProactive() {
  if (!bot.entity) return
  if (Date.now() - _lastPlayerChat < 30000) return  // 30s 内用户说过话，跳过
  if (isEscaping || !_wsReady()) return

  const p = bot.entity.position
  const tod = bot.time?.timeOfDay ?? 6000
  const isDaytime = tod < 13000 || tod > 23000

  const nearbyHostile = Object.values(bot.entities)
    .filter(e => HOSTILE_MOBS.has(e.name) && bot.entity.position.distanceTo(e.position) <= 5)
    .map(e => e.name)

  const interestingBlocks = []
  if (mcData) {
    for (const name of ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'ancient_debris', 'amethyst_cluster']) {
      const b = mcData.blocksByName[name]
      if (b && bot.findBlock({ matching: b.id, maxDistance: 10 })) {
        interestingBlocks.push(name.replace(/_/g, ' '))
      }
    }
  }

  const nearbyFriendly = [...new Set(
    Object.values(bot.entities)
      .filter(e => ['villager','cow','pig','sheep','chicken','horse','cat','wolf','fox'].includes(e.name)
               && bot.entity.position.distanceTo(e.position) <= 10)
      .map(e => e.name)
  )]

  const envDesc = [
    `当前时间: ${isDaytime ? '白天' : '夜晚'}`,
    `坐标: (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`,
    `血量: ${bot.health.toFixed(1)}, 饱食度: ${bot.food}`,
    nearbyHostile.length  ? `附近5格有敌对生物: ${nearbyHostile.join(', ')}` : '附近没有敌对生物',
    interestingBlocks.length ? `附近10格稀有方块: ${interestingBlocks.join(', ')}` : null,
    nearbyFriendly.length ? `附近有友好生物: ${nearbyFriendly.join(', ')}` : null,
  ].filter(Boolean).join('\n')

  try {
    const line = await generateProactiveLine({ envDesc, persona, logger: console })
    if (line) {
      console.log(`[主动] ${line}`)
      botSay(line)
    }
  } catch (err) {
    console.warn('[主动] 调用失败:', err.code || 'LLM_API_ERROR', err.message)
  }
}

function _wsReady() {
  try { return bot.entity != null } catch { return false }
}

let _voiceCleanup = null

// ─── 语音输入（VOICE_INPUT_ENABLED=true 时启用）──────────────────────────────
if (process.env.VOICE_INPUT_ENABLED === 'true') {
  const { startPushToTalk } = require('./mic-recorder')
  const { createAsrSession } = require('./asr')

  const VOICE_SAMPLE_RATE = 16000
  const VOICE_CHANNELS = 1
  const VOICE_BITS_PER_SAMPLE = 16
  const MIN_VOICE_MS = 350
  const SILENCE_RMS_THRESHOLD = Number(process.env.VOICE_RMS_THRESHOLD || 0.008)
  const ASR_CHUNK_MS = 100
  const ASR_CHUNK_BYTES = VOICE_SAMPLE_RATE * VOICE_CHANNELS * (VOICE_BITS_PER_SAMPLE / 8) * ASR_CHUNK_MS / 1000

  let voiceBusy = false

  function getPcmDurationMs(pcmBuffer) {
    return Math.round(pcmBuffer.length / (VOICE_SAMPLE_RATE * VOICE_CHANNELS * (VOICE_BITS_PER_SAMPLE / 8)) * 1000)
  }

  function getPcmRms(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 2) return 0
    let sumSquares = 0
    const samples = Math.floor(pcmBuffer.length / 2)
    for (let i = 0; i < samples; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2) / 32768
      sumSquares += sample * sample
    }
    return Math.sqrt(sumSquares / samples)
  }

  function sendPcmInChunks(session, pcmBuffer) {
    for (let offset = 0; offset < pcmBuffer.length; offset += ASR_CHUNK_BYTES) {
      session.sendAudio(pcmBuffer.subarray(offset, Math.min(offset + ASR_CHUNK_BYTES, pcmBuffer.length)))
    }
  }

  const { stop: stopHotkey } = startPushToTalk({
    mouseButton: 'Mouse4',
    preRollMs: 800,
    tailMs: 500,
    maxRecordMs: 15000,
    sampleRate: VOICE_SAMPLE_RATE,
    channels: VOICE_CHANNELS,
    bitsPerSample: VOICE_BITS_PER_SAMPLE,

    onPressStart: () => {
      console.log('[Voice] 本地收音中...')
    },

    onPressEnd: async ({ pcmBuffer, durationMs, pressDurationMs }) => {
      const actualDurationMs = durationMs || getPcmDurationMs(pcmBuffer)
      if (!pcmBuffer || pcmBuffer.length === 0) {
        console.log('[Voice] 空音频，跳过 ASR')
        return
      }

      if (voiceBusy) {
        console.log('[Voice] 上一段语音仍在处理，跳过本次 ASR')
        return
      }

      const effectiveDurationMs = pressDurationMs || actualDurationMs
      if (effectiveDurationMs < MIN_VOICE_MS) {
        console.log(`[Voice] 音频过短 (${effectiveDurationMs}ms)，跳过 ASR`)
        return
      }

      const rms = getPcmRms(pcmBuffer)
      if (rms < SILENCE_RMS_THRESHOLD) {
        console.log(`[Voice] 接近静音 (rms=${rms.toFixed(4)})，跳过 ASR`)
        return
      }

      voiceBusy = true
      try {
        console.log(`[Voice] 发送完整音频到 ASR: ${(actualDurationMs / 1000).toFixed(2)}s, rms=${rms.toFixed(4)}`)
        const session = await createAsrSession({
          sampleRate: VOICE_SAMPLE_RATE,
          channels: VOICE_CHANNELS,
          bitsPerSample: VOICE_BITS_PER_SAMPLE
        })

        sendPcmInChunks(session, pcmBuffer)
        const text = await session.finish()
        const finalText = typeof text === 'string' ? text : String(text || '')
        console.log('[VOICE FINAL TEXT]', finalText, finalText.length)

        if (!finalText.trim()) {
          console.log('[Voice] 没识别到内容')
          return
        }

        const normalizedText = finalText.trim()
        console.log(`[Voice] 识别结果: ${normalizedText}`)
        console.log('[VOICE SEND TO CHAT]', normalizedText)
        bot.chat(`[语音] ${normalizedText}`)
        await handleUserChat('action', normalizedText)
      } catch (err) {
        console.error('[Voice] ASR 识别失败:', err.message)
      } finally {
        voiceBusy = false
      }
    }
  })

  _voiceCleanup = stopHotkey
  console.log('[Voice] 语音输入已启用：按住 Mouse4/XBUTTON1 说话，松开后一次性 ASR')
}

// ─── 错误处理 ─────────────────────────────────────────────────────────────────
// The supervisor's own 'end' listener runs first (it attached before us) and
// drives onConnectionOffline / the reconnect schedule; this one only keeps the
// familiar log line. 'kicked' / 'error' are logged via the supervisor above.
function onBotEnd(reason) {
  console.log('断线原因:', reason)
}

} // end main()

if (require.main === module) {
  main()
}

module.exports = {
  CHAT_LLM_TIMEOUT_MS,
  DEFAULT_PERSONA,
  DEFAULT_PERSONA_ID,
  INTENT_LLM_TIMEOUT_MS,
  PROACTIVE_LLM_TIMEOUT_MS,
  REMINDER_LLM_TIMEOUT_MS,
  activePersona: persona,
  createBotActionKeyClassifier,
  createBotReminderMessageGenerator,
  generateProactiveLine,
  runBotChatLoop
}
