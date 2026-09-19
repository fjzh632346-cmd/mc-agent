const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')
const { ConnectionSupervisor, createConnectionSupervisorFromEnv, DEFAULT_BACKOFF_MS } = require('../core/connection-supervisor')
const connectionState = require('../core/connection-state')
const { ConstructionRunStore } = require('../systems/construction-run-store')
const { BuildTask } = require('../tasks/build-task')
const { TASK_STATE } = require('../tasks/base-task')
const { formatStatusLine } = require('../utils/status-line')
const { yieldToEventLoop } = require('../utils/event-loop')

// ─── harness ─────────────────────────────────────────────────────────────────

function createFakeTimers() {
  let clock = 100000
  const timers = []
  return {
    now: () => clock,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: clock + ms, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: timer => { if (timer) timer.cleared = true },
    pending: () => timers.filter(t => !t.cleared && !t.fired),
    advance(ms) {
      clock += ms
      for (const timer of timers) {
        if (timer.cleared || timer.fired || timer.at > clock) continue
        timer.fired = true
        timer.fn()
      }
    }
  }
}

function createSupervisorHarness(options = {}) {
  const timers = createFakeTimers()
  const bots = []
  const events = []
  const supervisor = new ConnectionSupervisor({
    createBot: options.createBot || (() => {
      const bot = new EventEmitter()
      bot.id = bots.length + 1
      bots.push(bot)
      return bot
    }),
    enabled: options.enabled,
    backoffMs: options.backoffMs,
    maxAttempts: options.maxAttempts,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: { log() {} }
  })
  for (const name of ['bot', 'online', 'offline', 'reconnect_scheduled', 'reconnect_disabled', 'gave_up', 'kicked', 'bot_error']) {
    supervisor.on(name, (...args) => events.push({ name, args }))
  }
  return { supervisor, timers, bots, events, names: () => events.map(e => e.name) }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createTaskContext() {
  return {
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, pathfinder: null },
    actionLock: { acquireMany: () => ({ ok: true, types: ['building'] }), releaseAll: () => ({ released: [] }) },
    debug: () => {},
    logger: { log() {} }
  }
}

function fakeBuildStatus() {
  return {
    blueprintName: 'small_house',
    origin: { x: 0, y: 64, z: 0 },
    totalBlocks: 10,
    placedBlocks: 3,
    clearedBlocks: 0,
    foundationBlocks: 0,
    scaffoldBlocks: 0,
    removedScaffoldBlocks: 0,
    currentIndex: 3,
    currentStepIndex: 3,
    totalSteps: 10,
    missingMaterials: []
  }
}

// ─── connection supervisor ───────────────────────────────────────────────────

function testReconnectAfterEndAndResumeCounters() {
  const h = createSupervisorHarness()
  const first = h.supervisor.connect()
  assert.strictEqual(h.bots.length, 1)
  assert.strictEqual(h.supervisor.state, 'connecting')
  first.emit('spawn')
  assert.strictEqual(h.supervisor.state, 'online')
  assert.strictEqual(h.supervisor.isOnline(), true)
  assert.deepStrictEqual(h.events.find(e => e.name === 'online').args[0], { generation: 1, reconnected: false })

  first.emit('end', 'socketClosed')
  assert.strictEqual(h.supervisor.isOnline(), false)
  assert.strictEqual(h.supervisor.state, 'reconnecting')
  const offline = h.events.find(e => e.name === 'offline').args[0]
  assert.strictEqual(offline.reason, 'socketClosed')
  assert.strictEqual(offline.wasOnline, true)
  const scheduled = h.events.find(e => e.name === 'reconnect_scheduled').args[0]
  assert.strictEqual(scheduled.delayMs, 5000)
  assert.strictEqual(scheduled.attempt, 1)
  assert.strictEqual(h.timers.pending().length, 1, 'one reconnect timer armed')
  assert.strictEqual(h.supervisor.status().nextReconnectInMs, 5000)

  h.timers.advance(4999)
  assert.strictEqual(h.bots.length, 1, 'not before the backoff elapses')
  h.timers.advance(1)
  assert.strictEqual(h.bots.length, 2, 'a fresh bot is created after the backoff')
  const second = h.bots[1]
  assert.strictEqual(h.supervisor.bot, second)
  const botEvent = h.events.filter(e => e.name === 'bot')[1].args
  assert.strictEqual(botEvent[0], second)
  assert.deepStrictEqual(botEvent[1], { generation: 2, reconnect: true })

  second.emit('spawn')
  assert.strictEqual(h.supervisor.isOnline(), true)
  assert.strictEqual(h.supervisor.attempt, 0, 'attempt counter resets on spawn')
  assert.deepStrictEqual(h.events.filter(e => e.name === 'online')[1].args[0], { generation: 2, reconnected: true })
  console.log('  ok end -> offline -> backoff -> new bot -> online (counters reset)')
}

function testBackoffSequenceAndGiveUp() {
  const h = createSupervisorHarness({ maxAttempts: 7 })
  const delays = []
  h.supervisor.on('reconnect_scheduled', info => delays.push(info.delayMs))
  let bot = h.supervisor.connect()
  for (let i = 0; i < 7; i++) {
    bot.emit('end', 'ECONNREFUSED')
    const pending = h.timers.pending()
    assert.strictEqual(pending.length, 1, `attempt ${i + 1} arms exactly one timer`)
    h.timers.advance(pending[0].ms)
    bot = h.supervisor.bot
  }
  assert.deepStrictEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000], 'doubling backoff capped at 60s')
  assert.strictEqual(h.supervisor.state, 'connecting')
  bot.emit('end', 'ECONNREFUSED')
  assert.strictEqual(h.supervisor.state, 'gave_up')
  const gaveUp = h.events.find(e => e.name === 'gave_up').args[0]
  assert.strictEqual(gaveUp.attempts, 7)
  assert.strictEqual(gaveUp.maxAttempts, 7)
  assert.strictEqual(h.timers.pending().length, 0, 'no more timers after giving up')
  assert.strictEqual(h.bots.length, 8, '1 initial + 7 retries')
  console.log('  ok backoff 5/10/20/40/60/60/60 then gives up honestly at the cap')
}

function testDisabledKeepsLegacyBehaviour() {
  const h = createSupervisorHarness({ enabled: false })
  const bot = h.supervisor.connect()
  bot.emit('spawn')
  bot.emit('end', 'keepAliveError')
  assert.deepStrictEqual(h.names().slice(-2), ['offline', 'reconnect_disabled'])
  assert.strictEqual(h.timers.pending().length, 0, 'switch off: no reconnect timer')
  assert.strictEqual(h.supervisor.state, 'offline')
  assert.strictEqual(h.bots.length, 1)
  console.log('  ok BOT_RECONNECT=false leaves the old stay-dead behaviour')
}

function testStaleGenerationEventsAreIgnored() {
  const h = createSupervisorHarness()
  const first = h.supervisor.connect()
  first.emit('spawn')
  first.emit('end', 'socketClosed')
  h.timers.advance(5000)
  const second = h.supervisor.bot
  assert.notStrictEqual(second, first)
  const eventsBefore = h.events.length
  // A late second 'end' from the dead socket must not schedule anything.
  first.emit('end', 'socketClosed')
  first.emit('spawn')
  assert.strictEqual(h.events.length, eventsBefore, 'stale bot events are dropped')
  assert.strictEqual(h.timers.pending().length, 0)
  assert.strictEqual(h.supervisor.state, 'connecting')
  second.emit('spawn')
  assert.strictEqual(h.supervisor.isOnline(), true)
  console.log('  ok events from a superseded bot are ignored')
}

function testCreateBotFailureCountsAsAnAttempt() {
  let calls = 0
  const h = createSupervisorHarness({
    createBot: () => {
      calls += 1
      if (calls === 2) throw new Error('boom')
      const bot = new EventEmitter()
      h.bots.push(bot)
      return bot
    }
  })
  const first = h.supervisor.connect()
  first.emit('spawn')
  first.emit('end', 'socketClosed')
  h.timers.advance(5000)
  assert.strictEqual(calls, 2)
  assert.strictEqual(h.supervisor.state, 'reconnecting', 'a throwing createBot is treated like an immediate end')
  const scheduled = h.events.filter(e => e.name === 'reconnect_scheduled')
  assert.strictEqual(scheduled.length, 2)
  assert.strictEqual(scheduled[1].args[0].delayMs, 10000)
  h.timers.advance(10000)
  assert.strictEqual(calls, 3)
  h.supervisor.bot.emit('spawn')
  assert.strictEqual(h.supervisor.isOnline(), true)
  console.log('  ok createBot throwing is retried with backoff')
}

function testBotErrorAndKickAreForwardedNotThrown() {
  const h = createSupervisorHarness()
  const bot = h.supervisor.connect()
  bot.emit('error', new Error('read ECONNRESET'))
  bot.emit('kicked', '{"translate":"disconnect.timeout"}')
  assert.deepStrictEqual(h.names(), ['bot', 'bot_error', 'kicked'])
  console.log('  ok bot error/kicked are forwarded without throwing')
}

function testEnvFactory() {
  const noop = () => new EventEmitter()
  const on = createConnectionSupervisorFromEnv({}, { createBot: noop })
  assert.strictEqual(on.enabled, true)
  assert.deepStrictEqual(on.options.backoffMs, [...DEFAULT_BACKOFF_MS])
  const off = createConnectionSupervisorFromEnv({ BOT_RECONNECT: 'false' }, { createBot: noop })
  assert.strictEqual(off.enabled, false)
  const tuned = createConnectionSupervisorFromEnv({
    BOT_RECONNECT_MAX_ATTEMPTS: '3',
    BOT_RECONNECT_BACKOFF_MS: '1000,2000'
  }, { createBot: noop })
  assert.strictEqual(tuned.options.maxAttempts, 3)
  assert.deepStrictEqual(tuned.options.backoffMs, [1000, 2000])
  console.log('  ok env factory: on by default, BOT_RECONNECT=false switches off')
}

// ─── run store offline guard ─────────────────────────────────────────────────

function testRunStoreHoldsWritesWhileOffline() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-run-store-offline-'))
  const filePath = path.join(root, 'construction-runs.json')
  let online = true
  const logs = []
  const store = new ConstructionRunStore({ filePath, isWritable: () => online, logger: { log: m => logs.push(m) } })

  store.upsertRun({ runId: 'run_a', status: 'ACTIVE' })
  assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).runs[0].status, 'ACTIVE')
  assert.strictEqual(store.lastWriteDeferred, false)

  online = false
  const deferred = store.upsertRun({ runId: 'run_a', status: 'BLOCKED_MATERIAL_SHORTAGE', blockedReason: 'x' })
  assert.strictEqual(deferred.status, 'BLOCKED_MATERIAL_SHORTAGE', 'caller still gets the in-memory object')
  assert.strictEqual(store.lastWriteDeferred, true)
  assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).runs[0].status, 'ACTIVE', 'disk untouched while offline')
  assert.strictEqual(store.updateRun('run_a', { status: 'FAILED' }).status, 'FAILED')
  assert.strictEqual(store.abandonRun('run_a', 'offline_junk').status, 'ABANDONED')
  assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).runs[0].status, 'ACTIVE')
  assert.strictEqual(store.deferredWrites.length, 3)
  assert.deepStrictEqual(store.deferredWrites.map(w => w.operation), ['upsertRun', 'updateRun', 'updateRun'])
  assert.ok(logs.some(line => line.includes('[CONSTRUCTION_RUN_WRITE_DEFERRED]') && line.includes('reason=connection_offline')), logs.join('\n'))

  online = true
  store.upsertRun({ runId: 'run_a', status: 'ACTIVE', currentPhase: 'frame' })
  assert.strictEqual(store.lastWriteDeferred, false)
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8')).runs[0]
  assert.strictEqual(written.status, 'ACTIVE')
  assert.strictEqual(written.currentPhase, 'frame')
  console.log('  ok run store defers upsert/update/abandon while offline and writes again when back')
}

function testRunStoreDefaultsToProcessConnectionState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-run-store-state-'))
  const filePath = path.join(root, 'construction-runs.json')
  const store = new ConstructionRunStore({ filePath, logger: { log() {} } })
  try {
    assert.strictEqual(connectionState.isOnline(), true, 'default is online')
    store.upsertRun({ runId: 'run_b', status: 'ACTIVE' })
    connectionState.setOnline(false, 'socketClosed')
    assert.deepStrictEqual(connectionState.getConnectionState().reason, 'socketClosed')
    store.upsertRun({ runId: 'run_b', status: 'BLOCKED_MATERIAL_SHORTAGE' })
    assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).runs[0].status, 'ACTIVE')
    assert.strictEqual(store.lastWriteDeferred, true)
  } finally {
    connectionState.setOnline(true)
  }
  store.upsertRun({ runId: 'run_b', status: 'ACTIVE' })
  assert.strictEqual(store.lastWriteDeferred, false)
  console.log('  ok run store follows the process-wide connection state by default')
}

// ─── build task: stale chain after pause/resume ──────────────────────────────

async function testStaleBuildChainVerdictIsDroppedAfterResume() {
  const ctx = createTaskContext()
  const pending = deferred()
  const calls = []
  const checkpoints = []
  let dirtyMarks = 0
  const fakeSystem = {
    async buildBlueprint() { return { ok: true } },
    getStatus() { return fakeBuildStatus() },
    checkpointConstructionRun(reason) { checkpoints.push(reason) },
    markConstructionCheckpointDirty() { dirtyMarks += 1 },
    async placeNextBlock(context, options) {
      calls.push(options)
      if (calls.length === 1) return pending.promise
      return { ok: true, completed: false }
    }
  }
  const task = new BuildTask({ id: 3, params: { blueprintName: 'small_house', buildingSystem: fakeSystem } })
  await task.start(ctx)
  assert.strictEqual(task.started, true)

  const staleUpdate = task.update(ctx)
  await yieldToEventLoop()
  assert.strictEqual(calls.length, 1)
  const staleGuard = calls[0].shouldContinue
  assert.strictEqual(staleGuard(), true, 'the in-flight chain may run while the task is live')

  // Connection lost: the task manager pauses the current task.
  await task.pause(ctx, 'connection_lost')
  assert.strictEqual(task.state, TASK_STATE.PAUSED)
  assert.strictEqual(staleGuard(), false, 'paused: the chain must stop at its next check')
  assert.deepStrictEqual(checkpoints, ['task_pause'])

  // Connection back: resumed under a new epoch.
  await task.resume(ctx)
  assert.strictEqual(task.state, TASK_STATE.RUNNING)
  assert.strictEqual(staleGuard(), false, 'resumed task is RUNNING, yet the stale chain stays stopped')
  assert.ok(dirtyMarks >= 1, 'resume marks the checkpoint dirty')
  assert.deepStrictEqual(checkpoints, ['task_pause', 'task_resume'])

  // The stale chain finally returns the verdict it reached on the dead socket.
  pending.resolve({ ok: false, error: 'BLOCKED_MATERIAL_SHORTAGE:frame:dark_oak_log:92' })
  await staleUpdate
  assert.strictEqual(task.state, TASK_STATE.RUNNING, 'stale verdict must not fail the resumed task')
  assert.strictEqual(task.failedReason, null)
  assert.ok(!checkpoints.includes('task_fail'), 'no task_fail checkpoint from the stale chain')

  // A fresh tick continues the build normally.
  await task.update(ctx)
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(calls[1].shouldContinue(), true)
  assert.strictEqual(task.state, TASK_STATE.RUNNING)
  console.log('  ok a build chain left over from before the disconnect cannot fail the resumed task')
}

async function testStaleBuildStartVerdictIsDroppedAfterResume() {
  const ctx = createTaskContext()
  const pending = deferred()
  let buildCalls = 0
  const fakeSystem = {
    async buildBlueprint(context, name, origin, options) {
      buildCalls += 1
      if (buildCalls === 1) return pending.promise
      assert.strictEqual(options.shouldContinue(), true)
      return { ok: true }
    },
    getStatus() { return fakeBuildStatus() },
    checkpointConstructionRun() {},
    markConstructionCheckpointDirty() {},
    async placeNextBlock() { return { ok: true, completed: false } }
  }
  const task = new BuildTask({ id: 4, params: { blueprintName: 'small_house', buildingSystem: fakeSystem } })
  const startPromise = task.start(ctx)
  await yieldToEventLoop()
  assert.strictEqual(task.state, TASK_STATE.RUNNING)
  assert.strictEqual(task.started, false)

  await task.pause(ctx, 'connection_lost')
  await task.resume(ctx)
  // The start chain that ran on the dead socket concludes "no materials".
  pending.resolve({ ok: false, error: 'BLOCKED_MATERIAL_SHORTAGE:stone:1', missingMaterials: [{ item: 'stone', missing: 1 }] })
  await startPromise
  assert.strictEqual(task.state, TASK_STATE.RUNNING, 'stale start verdict must not fail the task')
  assert.strictEqual(task.started, false)
  assert.strictEqual(task.failedReason, null)

  await task.update(ctx)
  assert.strictEqual(buildCalls, 2, 'the resumed task begins the build again through the run store')
  assert.strictEqual(task.started, true)
  console.log('  ok a build start left over from before the disconnect cannot fail the resumed task')
}

async function testInterruptStillWinsOverLateVerdict() {
  const ctx = createTaskContext()
  const pending = deferred()
  const fakeSystem = {
    async buildBlueprint() { return { ok: true } },
    getStatus() { return fakeBuildStatus() },
    checkpointConstructionRun() {},
    markConstructionCheckpointDirty() {},
    async placeNextBlock() { return pending.promise }
  }
  const task = new BuildTask({ id: 5, params: { blueprintName: 'small_house', buildingSystem: fakeSystem } })
  await task.start(ctx)
  const update = task.update(ctx)
  await yieldToEventLoop()
  await task.interrupt(ctx, 'manager_stop')
  pending.resolve({ ok: true, completed: true })
  await update
  assert.strictEqual(task.state, TASK_STATE.INTERRUPTED, 'existing interrupt semantics unchanged')
  console.log('  ok interrupt semantics are unchanged')
}

// ─── status line ─────────────────────────────────────────────────────────────

function testStatusLineOfflineNeverPrintsCachedPosition() {
  const online = formatStatusLine({
    online: true,
    position: { x: 603.49, y: 78, z: -10.5 },
    health: 20,
    food: 20,
    mode: '空闲'
  })
  assert.strictEqual(online, '[状态] x=603.49 y=78.00 z=-10.50 | 血=20.0 饿=20 | 空闲')

  const offline = formatStatusLine({
    online: false,
    reason: 'socketClosed',
    position: { x: 603.49, y: 78, z: -10.5 },
    health: 20,
    food: 20,
    reconnect: { state: 'reconnecting', enabled: true, attempt: 2, maxAttempts: 20, nextReconnectInMs: 9400 },
    pausedTask: 'build_blueprint#2'
  })
  assert.ok(offline.startsWith('[状态] 离线'), offline)
  assert.ok(!offline.includes('603'), `offline line must not echo the cached position: ${offline}`)
  assert.ok(offline.includes('原因=socketClosed'), offline)
  assert.ok(offline.includes('重连第2/20次于10秒后'), offline)
  assert.ok(offline.includes('已暂停任务=build_blueprint#2'), offline)

  const gaveUp = formatStatusLine({ online: false, reason: 'ECONNREFUSED', reconnect: { state: 'gave_up', enabled: true, attempt: 20, maxAttempts: 20 } })
  assert.ok(gaveUp.includes('重连已放弃(20/20)'), gaveUp)
  const disabled = formatStatusLine({ online: false, reason: 'socketClosed', reconnect: { state: 'offline', enabled: false } })
  assert.ok(disabled.includes('重连已关闭'), disabled)
  console.log('  ok status line says offline (and why) instead of echoing cached coordinates')
}

async function main() {
  console.log('[connection-recovery tests]')
  testReconnectAfterEndAndResumeCounters()
  testBackoffSequenceAndGiveUp()
  testDisabledKeepsLegacyBehaviour()
  testStaleGenerationEventsAreIgnored()
  testCreateBotFailureCountsAsAnAttempt()
  testBotErrorAndKickAreForwardedNotThrown()
  testEnvFactory()
  testRunStoreHoldsWritesWhileOffline()
  testRunStoreDefaultsToProcessConnectionState()
  await testStaleBuildChainVerdictIsDroppedAfterResume()
  await testStaleBuildStartVerdictIsDroppedAfterResume()
  await testInterruptStillWinsOverLateVerdict()
  testStatusLineOfflineNeverPrintsCachedPosition()
  console.log('connection-recovery tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
