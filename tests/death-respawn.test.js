const assert = require('assert')
const EventEmitter = require('events')

const { createDeathHandler } = require('../core/death-handler')
const { ActionLock } = require('../core/action-lock')
const { BaseTask, TASK_STATE } = require('../tasks/base-task')
const { TaskManager } = require('../tasks/task-manager')
const { SurvivalSystem } = require('../systems/survival-system')
const { WorksiteAnchor } = require('../systems/worksite-anchor')
const { GoalSystem } = require('../ai/goal-system')
const { MessageGenerator, REMINDER_TYPES, createReminderEvent, defaultReminderText } = require('../ai/message-generator')
const { createRecoveryState, runStuckRecovery } = require('../tasks/stuck-recovery')

// ─── harness ─────────────────────────────────────────────────────────────────

class StubTask extends BaseTask {
  constructor(options) {
    super(options)
    this.required = options.requiredLocks || []
    this.recovery = options.recovery || null
  }

  get requiredLocks() {
    return this.required
  }
}

function createBot(position = { x: 1530, y: 120, z: 1530 }) {
  const bot = new EventEmitter()
  bot.health = 20
  bot.food = 20
  bot.entity = { position: { ...position, distanceTo: () => 0 } }
  bot.items = [{ name: 'oak_planks', count: 64 }, { name: 'bread', count: 4 }]
  bot.inventory = new EventEmitter()
  bot.inventory.items = () => bot.items
  bot.players = {}
  bot.entities = {}
  bot.nearestEntity = () => ({ name: 'zombie', type: 'hostile' })
  bot.pathfinder = { setGoal() {}, setMovements() {}, stop() {} }
  bot.pvp = { stop() {} }
  return bot
}

function createBlackboard() {
  const store = {}
  return {
    snapshot: () => ({}),
    get: path => store[path],
    set: (path, value) => { store[path] = value },
    update() {}
  }
}

function createLogger() {
  const logs = []
  return { logs, log: line => logs.push(String(line)), warn: line => logs.push(String(line)) }
}

async function waitFor(predicate, label, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// Everything that thinks "she is still standing on the worksite": a running
// build holding its lock, a paused follow, a paused return-home that was
// mid-escape and still holds movement, a worksite anchor, survival and goal
// cooldowns, a survival pause reference.
function createLiveSystems(bot, options = {}) {
  const logger = createLogger()
  const actionLock = new ActionLock()
  const blackboard = createBlackboard()
  const taskManager = new TaskManager(bot, {
    actionLock,
    blackboard,
    debug: true,
    enabled: false,
    enableTaskFeedback: false,
    logger
  })
  taskManager.debug = line => logger.log(line)

  const build = new StubTask({ id: 1, type: 'build_blueprint', priority: 11, requiredLocks: ['building'] })
  const follow = new StubTask({ id: 2, type: 'follow_player', priority: 3, requiredLocks: ['movement'] })
  const returnHome = new StubTask({ id: 3, type: 'return_to_base', priority: 8, requiredLocks: ['movement'], recovery: createRecoveryState() })
  build.state = TASK_STATE.RUNNING
  follow.state = TASK_STATE.PAUSED
  follow.manualPause = true
  returnHome.state = TASK_STATE.PAUSED
  returnHome.recovery.isStuck = true
  returnHome.recovery.stuckTicks = 7
  returnHome.recovery.escapeRung = 'safe_dig'
  assert.strictEqual(actionLock.acquire('building', build.id).ok, true)
  assert.strictEqual(actionLock.acquire('movement', returnHome.id).ok, true)
  taskManager.currentTask = build
  taskManager.pausedStack = [follow, returnHome]
  if (options.queued) {
    const queued = new StubTask({ id: 4, type: 'mining', priority: 4 })
    taskManager.queue.push(queued)
  }

  const worksite = new WorksiteAnchor({ now: () => 1000 })
  const survivalSystem = new SurvivalSystem({ worksiteAnchor: worksite, safeModeEnabled: true })
  const goalSystem = new GoalSystem({ survivalSystem })
  worksite.update({ taskManager, bot })
  assert.ok(worksite.current(), 'fixture: worksite anchor should be set before death')
  survivalSystem.setCooldown('survival_too_far_from_base')
  survivalSystem.pausedTaskDueToSurvival = { id: 2, type: 'follow_player' }
  survivalSystem.sleepState = { sleeping: true }
  goalSystem.setCooldown('RETURN_TO_BASE')

  const memory = { world: { baseLocation: { position: { x: 1505, y: 120, z: 1505 } } } }
  const said = []
  const hooks = { deaths: [], respawns: [] }
  let clock = 1000
  const handler = createDeathHandler({
    logger,
    now: () => clock,
    respawnSettleMs: 0,
    respawnTimeoutMs: 0,
    systems: () => ({
      taskManager,
      goalSystem,
      blackboard,
      memory,
      messageGenerator: new MessageGenerator({ enableLlm: false, persona: { username: 'LinXia', style: 'linxia' } }),
      persona: { username: 'LinXia', style: 'linxia' }
    }),
    say: text => said.push(text),
    onDeath: record => hooks.deaths.push(record),
    onRespawn: record => hooks.respawns.push(record)
  })
  const detach = options.attach === false ? null : handler.attach(bot)

  bot.inventory.emit('updateSlot')
  clock = 5000
  return { logger, actionLock, taskManager, build, follow, returnHome, worksite, survivalSystem, goalSystem, memory, said, hooks, handler, detach, tick: ms => { clock += ms } }
}

// ─── death: everything that assumed "still there" is torn down ───────────────

async function testDeathTearsDownTasksLocksAnchorAndSurvival() {
  const bot = createBot()
  const s = createLiveSystems(bot, { queued: true })

  bot.items = []
  bot.inventory.emit('updateSlot')
  bot.health = 0
  bot.emit('health')
  bot.emit('death')
  await waitFor(() => s.logger.logs.some(line => line.includes('[BOT_DEATH_RESET]')), '[BOT_DEATH_RESET]')

  // The death line names what she was doing.
  const deathLine = s.logger.logs.find(line => line.startsWith('[BOT_DEATH]'))
  assert.ok(deathLine, s.logger.logs.join('\n'))
  assert.ok(deathLine.includes('pos=1530,120,1530'), deathLine)
  assert.ok(deathLine.includes('health=0'), deathLine)
  assert.ok(deathLine.includes('lastDamage=20hp->0(nearest=zombie)'), deathLine)
  assert.ok(deathLine.includes('currentTask=build_blueprint#1'), deathLine)
  assert.ok(deathLine.includes('paused=[follow_player#2,return_to_base#3]'), deathLine)
  assert.ok(deathLine.includes('items=68'), `the pack as it was before the death-tick clears: ${deathLine}`)

  // Current task and the whole paused stack: external termination, reason=bot_died.
  assert.strictEqual(s.taskManager.currentTask, null)
  assert.deepStrictEqual(s.taskManager.pausedStack, [])
  for (const task of [s.build, s.follow, s.returnHome]) {
    assert.strictEqual(task.state, TASK_STATE.INTERRUPTED, `${task.type} state`)
    assert.strictEqual(task.interruptReason, 'bot_died', `${task.type} reason`)
    assert.strictEqual(task.resumable, false)
  }
  assert.strictEqual(s.taskManager.interrupted.length, 3)
  assert.ok(s.logger.logs.some(line => line.includes('[TASK_INTERRUPTED] taskId=1 type=build_blueprint reason=bot_died')))
  assert.ok(s.logger.logs.some(line => line.includes('[TASK_INTERRUPTED] taskId=3 type=return_to_base reason=bot_died')))

  // Every lock is free and every dead owner is sealed (round 15's rule):
  // a continuation still awaiting inside the escape ladder is refused.
  assert.strictEqual(s.actionLock.getOwner('building'), null)
  assert.strictEqual(s.actionLock.getOwner('movement'), null)
  for (const id of [1, 2, 3]) assert.strictEqual(s.actionLock.isOwnerTerminated(id), true, `owner ${id} sealed`)
  const stale = s.actionLock.acquire('movement', s.returnHome.id)
  assert.strictEqual(stale.ok, false)
  assert.strictEqual(stale.reason, 'owner_terminated')
  assert.strictEqual(stale.terminatedReason, 'interrupted:bot_died')
  // Locks were released before sealing, so nothing had to be reclaimed.
  assert.deepStrictEqual(s.logger.logs.filter(line => line.includes('reclaim owner=')), [])
  // And a fresh task can take them.
  assert.strictEqual(s.actionLock.acquireMany(['movement', 'building'], 9).ok, true)

  // Queued-but-never-started work is left for her to pick up after respawn.
  assert.strictEqual(s.taskManager.queue.length, 1)
  assert.strictEqual(s.taskManager.queue[0].state, TASK_STATE.IDLE)

  // Worksite anchor gone, survival and goal cooldowns/state back to freshly online.
  assert.strictEqual(s.worksite.current(), null)
  assert.strictEqual(s.worksite.anchor, null)
  assert.strictEqual(s.survivalSystem.cooldowns.size, 0)
  assert.strictEqual(s.survivalSystem.pausedTaskDueToSurvival, null)
  assert.strictEqual(s.survivalSystem.sleepState, null)
  assert.strictEqual(s.survivalSystem.lastSurvivalDecision, null)
  assert.strictEqual(s.survivalSystem.safeModeEnabled, true, 'safe mode is the player\'s setting and survives')
  assert.strictEqual(s.goalSystem.cooldowns.size, 0)
  assert.deepStrictEqual(s.goalSystem.activeGoals, [])
  const resetLine = s.logger.logs.find(line => line.startsWith('[BOT_DEATH_RESET]'))
  assert.ok(resetLine.includes('droppedTasks=build_blueprint#1,follow_player#2,return_to_base#3'), resetLine)
  assert.ok(resetLine.includes('survivalReset=ok'), resetLine)
  assert.ok(resetLine.includes('worksiteAnchor=cleared'), resetLine)

  // The host hook (legacy escape/fight flags) ran once, with the dropped tasks.
  assert.strictEqual(s.hooks.deaths.length, 1)
  assert.strictEqual(s.hooks.deaths[0].dropped.length, 3)
  assert.strictEqual(s.handler.state.deaths, 1)

  // The stuck-recovery state died with its task: nothing on the manager still says "stuck".
  const survivors = [s.taskManager.currentTask, ...s.taskManager.pausedStack, ...s.taskManager.queue].filter(Boolean)
  assert.ok(!survivors.some(task => task.recovery?.isStuck), 'no live task carries a stuck flag')
}

// ─── respawn: one log line with the distances, one sentence to the player ────

async function testRespawnLogsDistancesAndTellsThePlayer() {
  const bot = createBot()
  const s = createLiveSystems(bot)

  bot.items = []
  bot.inventory.emit('updateSlot')
  bot.health = 0
  bot.emit('health')
  bot.emit('death')
  await waitFor(() => s.logger.logs.some(line => line.includes('[BOT_DEATH_RESET]')), 'death')

  // The server moves her to spawn (1100 blocks away) and empties the pack.
  bot.entity.position = { x: 424, y: 73, z: 379, distanceTo: () => 0 }
  bot.items = []
  bot.health = 20
  bot.emit('respawn')
  bot.emit('spawn')
  await waitFor(() => s.logger.logs.some(line => line.includes('[BOT_RESPAWN_SAY]')), '[BOT_RESPAWN_SAY]')

  const respawnLine = s.logger.logs.find(line => line.startsWith('[BOT_RESPAWN]'))
  assert.ok(respawnLine, s.logger.logs.join('\n'))
  assert.ok(respawnLine.includes('pos=424,73,379'), respawnLine)
  assert.ok(respawnLine.includes('distanceToBase=1561.6'), respawnLine)
  assert.ok(respawnLine.includes('distanceToDeath=1596.9'), respawnLine)
  assert.ok(respawnLine.includes('inventoryLost=true'), respawnLine)

  assert.strictEqual(s.said.length, 1, `exactly one line to the player: ${JSON.stringify(s.said)}`)
  const text = s.said[0]
  assert.ok(text.includes('死了'), text)
  assert.ok(text.includes('复活'), text)
  assert.ok(text.includes('东西没了'), text)
  assert.ok(text.includes('盖房子'), text)
  assert.ok(!/[a-z_]{4,}/.test(text), `no raw task keys in what she says: ${text}`)
  assert.strictEqual(s.hooks.respawns.length, 1)
  assert.strictEqual(s.hooks.respawns[0].distanceToBase, 1561.6)

  // No automatic behaviour was added: nothing got enqueued by the respawn itself.
  assert.strictEqual(s.taskManager.queue.length, 0)
  assert.strictEqual(s.taskManager.currentTask, null)
}

async function testRespawnTextVariants() {
  const kept = defaultReminderText(createReminderEvent(REMINDER_TYPES.BOT_RESPAWN, {
    facts: { inventoryLost: false, droppedTaskTypes: [] }
  }), { style: 'linxia' })
  assert.strictEqual(kept, '我刚才死了，在出生点复活了，东西还在身上。')

  const lost = defaultReminderText(createReminderEvent(REMINDER_TYPES.BOT_RESPAWN, {
    facts: { inventoryLost: true, droppedTaskTypes: ['mining', 'follow_player', 'mining'] }
  }), null)
  assert.strictEqual(lost, '我刚才死了，在出生点复活了，身上的东西没了，手上的挖矿、跟随也停了。')

  const unknown = defaultReminderText(createReminderEvent(REMINDER_TYPES.BOT_RESPAWN, { facts: {} }), { style: 'andy' })
  assert.strictEqual(unknown, '我刚才死了，在出生点复活了。')

  // First-person owner is stamped, so an LLM rewrite cannot drift to 你.
  const event = createReminderEvent(REMINDER_TYPES.BOT_RESPAWN, { facts: {} })
  assert.strictEqual(event.facts.statusOwner, 'bot')
}

// ─── death lands inside the escape ladder ────────────────────────────────────
//
// Round 16's real death: she was walking home from the spawn point, the ladder
// was mid-rung. The rung must stop there ([ESCAPE_ABANDONED]) instead of
// climbing on under a task that no longer exists, and movement must be free.

function createPitContext() {
  const floorY = 60
  const rimY = 70
  const placed = []
  const position = { x: 560.5, y: floorY + 1, z: 375.5 }
  let groundY = floorY + 1
  const insidePit = (x, z) => x >= 558 && x <= 562 && z >= 373 && z <= 377
  const blockNameAt = (x, y, z) => {
    const fx = Math.floor(x)
    const fy = Math.floor(y)
    const fz = Math.floor(z)
    if (placed.some(p => p.x === fx && p.y === fy && p.z === fz)) return 'dirt'
    if (fy <= floorY) return 'stone'
    if (fy > rimY) return 'air'
    return insidePit(fx, fz) ? 'air' : 'stone'
  }
  const emitter = new EventEmitter()
  const bot = {
    entity: { position },
    username: 'LinXia',
    health: 20,
    inventory: { items: () => [{ name: 'dirt', count: 32 }] },
    players: {},
    entities: {},
    blockAt(vec) {
      if (!vec) return null
      return { name: blockNameAt(vec.x, vec.y, vec.z), position: { x: Math.floor(vec.x), y: Math.floor(vec.y), z: Math.floor(vec.z) } }
    },
    setControlState(name, value) { if (name === 'jump') position.y = value ? groundY + 0.6 : groundY },
    clearControlStates() {},
    chat() {},
    async equip() { return true },
    async lookAt() { return true },
    async placeBlock(reference, face) {
      placed.push({ x: reference.position.x + (face.x || 0), y: reference.position.y + (face.y || 0), z: reference.position.z + (face.z || 0) })
      groundY += 1
      position.y = groundY
      return true
    },
    pathfinder: {
      goal: null,
      setMovements() {},
      setGoal(goal) {
        this.goal = goal
        if (!goal) return
        const gx = goal.x ?? goal.pos?.x
        const gy = goal.y ?? goal.pos?.y
        const gz = goal.z ?? goal.pos?.z
        if (!Number.isFinite(gx) || !Number.isFinite(gz)) return
        if (Number.isFinite(gy) && Math.abs(gy - position.y) > 1) return
        position.x = gx + 0.5
        position.z = gz + 0.5
        if (Number.isFinite(gy)) { position.y = gy; groundY = gy }
      },
      stop() { this.goal = null }
    },
    pvp: { stop() {} },
    // The ladder waits on goal_reached through once(); keep it immediate as the
    // ladder suite does. The death handler only needs on/emit here.
    once(event, callback) { callback() },
    on: (...args) => emitter.on(...args),
    emit: (...args) => emitter.emit(...args),
    removeListener: (...args) => emitter.removeListener(...args)
  }
  const logs = []
  return {
    bot,
    placed,
    logs,
    blackboard: createBlackboard(),
    logger: { log: msg => logs.push(String(msg)) }
  }
}

async function testDeathInsideTheEscapeLadderAbandonsItAndFreesMovement() {
  const ctx = createPitContext()
  const actionLock = new ActionLock()
  ctx.actionLock = actionLock
  const logger = { logs: ctx.logs, log: line => ctx.logs.push(String(line)) }

  const taskManager = new TaskManager(ctx.bot, { actionLock, blackboard: ctx.blackboard, debug: true, enabled: false, enableTaskFeedback: false })
  taskManager.debug = line => logger.log(line)
  const task = new StubTask({ id: 2, type: 'return_to_base', priority: 8, requiredLocks: ['movement'] })
  task.state = TASK_STATE.RUNNING
  taskManager.currentTask = task
  assert.strictEqual(actionLock.acquire('movement', task.id).ok, true)

  const handler = createDeathHandler({
    logger,
    respawnSettleMs: 0,
    respawnTimeoutMs: 0,
    systems: () => ({ taskManager, goalSystem: new GoalSystem({ survivalSystem: new SurvivalSystem() }) })
  })
  handler.attach(ctx.bot)

  // She dies while a rung is mid-walk (round 16: pushed off the platform on the way).
  let logsAtDeath = null
  const setGoal = ctx.bot.pathfinder.setGoal.bind(ctx.bot.pathfinder)
  ctx.bot.pathfinder.setGoal = goal => {
    if (goal && logsAtDeath == null) {
      logsAtDeath = ctx.logs.length
      ctx.bot.health = 0
      ctx.bot.emit('health')
      ctx.bot.emit('death')
    }
    return setGoal(goal)
  }

  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    backoffMs: [0],
    chatFeedback: false,
    shouldContinue: () => task.state === 'RUNNING'
  }
  const result = await runStuckRecovery(ctx, createRecoveryState(), { x: 427, y: 64, z: 376 }, task.id, options)

  assert.ok(logsAtDeath != null, 'the fixture never reached a walking rung')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'escape_abandoned')
  const abandoned = ctx.logs.find(line => line.includes('[ESCAPE_ABANDONED]'))
  assert.ok(abandoned && abandoned.includes('taskId=2') && abandoned.includes('reason=task_no_longer_running'), ctx.logs.join('\n'))
  assert.strictEqual(ctx.placed.length, 0, 'no pillar built for a dead task')

  assert.strictEqual(task.state, TASK_STATE.INTERRUPTED)
  assert.strictEqual(task.interruptReason, 'bot_died')
  assert.strictEqual(taskManager.currentTask, null)
  assert.strictEqual(actionLock.getOwner('movement'), null)
  assert.strictEqual(actionLock.acquire('movement', task.id).reason, 'owner_terminated')
  assert.deepStrictEqual(ctx.logs.filter(line => line.includes('reclaim owner=')), [])
  assert.strictEqual(actionLock.acquireMany(['movement', 'building'], 5).ok, true)
}

// ─── the pieces on their own ─────────────────────────────────────────────────

async function testSurvivalResetKeepsSafeModeAndClearsTheRest() {
  const worksite = new WorksiteAnchor({ now: () => 1000 })
  const survival = new SurvivalSystem({ worksiteAnchor: worksite, safeModeEnabled: true })
  worksite.anchor = { position: { x: 1, y: 2, z: 3 }, taskId: 1, taskState: 'RUNNING', source: 'active_construction_task', updatedAt: 1000 }
  survival.setCooldown('a')
  survival.setCooldown('b')
  survival.lastSurvivalDecision = { priority: 'X' }
  survival.interruptedTask = { id: 1 }
  survival.queuedSurvivalTask = { id: 2 }
  survival.lastSurvivalAction = 'RETURN_SAFE'
  survival.lastWorksite = { active: true }

  const result = survival.resetAfterDeath()
  assert.deepStrictEqual(result, { ok: true, reason: 'bot_died', worksiteAnchorCleared: true })
  assert.strictEqual(survival.cooldowns.size, 0)
  assert.strictEqual(survival.lastSurvivalDecision, null)
  assert.strictEqual(survival.interruptedTask, null)
  assert.strictEqual(survival.queuedSurvivalTask, null)
  assert.strictEqual(survival.lastSurvivalAction, null)
  assert.strictEqual(survival.lastWorksite, null)
  assert.strictEqual(worksite.anchor, null)
  assert.strictEqual(survival.safeModeEnabled, true)
  assert.strictEqual(survival.resetAfterDeath().worksiteAnchorCleared, false)
}

async function testHandlerSurvivesMissingSystems() {
  const bot = createBot()
  const logger = createLogger()
  const said = []
  const handler = createDeathHandler({ logger, systems: () => ({}), say: text => said.push(text), respawnSettleMs: 0, respawnTimeoutMs: 0 })
  handler.attach(bot)
  bot.health = 0
  bot.emit('health')
  bot.emit('death')
  await waitFor(() => logger.logs.some(line => line.includes('[BOT_DEATH_RESET]')), 'death without systems')
  bot.items = []
  bot.emit('respawn')
  bot.emit('spawn')
  await waitFor(() => logger.logs.some(line => line.includes('[BOT_RESPAWN_SAY]')), 'respawn without systems')
  assert.ok(logger.logs.find(line => line.startsWith('[BOT_DEATH]')).includes('currentTask=none paused=[]'))
  assert.ok(logger.logs.find(line => line.startsWith('[BOT_RESPAWN]')).includes('distanceToBase=UNKNOWN'))
  assert.strictEqual(said.length, 1)
  assert.ok(said[0].includes('身上的东西没了'), said[0])
}

// Real machine: bot.inventory does not exist when the host wires handlers
// (plugins inject after version negotiation), and the death tick empties the
// pack in the same millisecond as 'death'. The count must come from a sample
// taken before that burst, through a listener bound once the inventory exists.
async function testInventoryIsSampledLazilyAndBeforeTheDeathTick() {
  const bot = createBot()
  const items = bot.items
  delete bot.inventory
  const logger = createLogger()
  let clock = 1000
  const handler = createDeathHandler({ logger, now: () => clock, systems: () => ({}), respawnSettleMs: 0, respawnTimeoutMs: 0 })
  handler.attach(bot)
  assert.strictEqual(handler.state.inventorySamples.length, 0, 'nothing to sample before the plugin injects')

  bot.inventory = new EventEmitter()
  bot.inventory.items = () => bot.items
  bot.emit('inject_allowed')
  clock = 2000
  bot.items = items
  bot.inventory.emit('updateSlot')
  assert.strictEqual(handler.state.inventorySamples.at(-1).count, 68)

  // The death tick: every slot cleared, then health=0, then death - all "now".
  clock = 60000
  bot.items = []
  bot.inventory.emit('updateSlot')
  bot.health = 0
  bot.emit('health')
  bot.emit('death')
  await waitFor(() => logger.logs.some(line => line.includes('[BOT_DEATH_RESET]')), 'death')
  assert.ok(logger.logs.find(line => line.startsWith('[BOT_DEATH]')).includes('items=68'), logger.logs.join(String.fromCharCode(10)))
  bot.emit('respawn')
  bot.emit('spawn')
  await waitFor(() => logger.logs.some(line => line.includes('[BOT_RESPAWN_SAY]')), 'respawn')
  assert.ok(logger.logs.find(line => line.startsWith('[BOT_RESPAWN]')).includes('inventoryLost=true'))
}

async function run() {
  await testDeathTearsDownTasksLocksAnchorAndSurvival()
  await testRespawnLogsDistancesAndTellsThePlayer()
  await testRespawnTextVariants()
  await testDeathInsideTheEscapeLadderAbandonsItAndFreesMovement()
  await testSurvivalResetKeepsSafeModeAndClearsTheRest()
  await testHandlerSurvivesMissingSystems()
  await testInventoryIsSampledLazilyAndBeforeTheDeathTick()
  console.log('death-respawn tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
