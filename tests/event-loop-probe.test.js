const assert = require('assert')
const { EventLoopProbe, createEventLoopProbeFromEnv } = require('../utils/event-loop-probe')

function createHarness(options = {}) {
  let clock = 10000
  const logs = []
  const timers = []
  const probe = new EventLoopProbe({
    thresholdMs: 2000,
    intervalMs: 500,
    summaryIntervalMs: 60000,
    histogram: options.histogram === undefined ? null : options.histogram,
    logger: {
      log: message => logs.push({ level: 'log', message }),
      warn: message => logs.push({ level: 'warn', message })
    },
    now: () => clock,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearInterval: id => { timers[id - 1] = null },
    contextProvider: options.contextProvider || (() => ({ task: 'build_blueprint#7', phase: 'frame', step: 391 })),
    onStall: options.onStall || null
  })
  return {
    probe,
    logs,
    timers,
    advance(ms) { clock += ms }
  }
}

function testOnTimeTicksReportNothing() {
  const h = createHarness()
  h.probe.start()
  assert.strictEqual(h.timers.length, 1, 'start schedules one interval')
  assert.strictEqual(h.timers[0].ms, 500)
  for (let i = 0; i < 5; i++) {
    h.advance(500)
    assert.strictEqual(h.probe.tick(), null, 'on-time tick is not a stall')
  }
  const stalls = h.logs.filter(entry => entry.message.includes('[EVENT_LOOP_STALL]'))
  assert.strictEqual(stalls.length, 0, 'no stall lines when the loop is on time')
  assert.strictEqual(h.probe.getStats().stalls, 0)
  console.log('  ok on-time ticks report nothing')
}

function testLateTickReportsStallWithContext() {
  const stalls = []
  const h = createHarness({ onStall: stall => stalls.push(stall) })
  h.probe.start()
  h.advance(500)
  h.probe.tick()
  // The loop was blocked: the next firing lands 25s after it was due.
  h.advance(500 + 25000)
  const stall = h.probe.tick()
  assert.ok(stall, 'late tick is reported')
  assert.strictEqual(stall.stallMs, 25000)
  assert.deepStrictEqual(stall.context, { task: 'build_blueprint#7', phase: 'frame', step: 391 })
  assert.strictEqual(stalls.length, 1, 'onStall callback fired once')
  const line = h.logs.find(entry => entry.message.includes('[EVENT_LOOP_STALL]'))
  assert.ok(line, 'stall line logged')
  assert.strictEqual(line.level, 'warn')
  assert.ok(line.message.includes('stallMs=25000'), line.message)
  assert.ok(line.message.includes('task=build_blueprint#7'), line.message)
  assert.ok(line.message.includes('phase=frame'), line.message)
  assert.ok(line.message.includes('step=391'), line.message)
  const stats = h.probe.getStats()
  assert.strictEqual(stats.stalls, 1)
  assert.strictEqual(stats.maxStallMs, 25000)
  console.log('  ok late tick reports a stall with task context')
}

function testBelowThresholdIsNotAStall() {
  const h = createHarness()
  h.probe.start()
  h.advance(500)
  h.probe.tick()
  h.advance(500 + 1999)
  assert.strictEqual(h.probe.tick(), null, '1999ms late is below the 2000ms threshold')
  h.advance(500 + 2000)
  assert.ok(h.probe.tick(), '2000ms late is exactly the threshold')
  console.log('  ok threshold is inclusive at exactly thresholdMs')
}

function testStallResetsScheduleSoOneBurstIsOneReport() {
  const h = createHarness()
  h.probe.start()
  h.advance(500)
  h.probe.tick()
  h.advance(500 + 30000)
  assert.ok(h.probe.tick(), 'burst reported once')
  h.advance(500)
  assert.strictEqual(h.probe.tick(), null, 'the tick after the burst is on time again')
  assert.strictEqual(h.probe.getStats().stalls, 1)
  console.log('  ok a single burst yields a single report')
}

function testHistogramSnapshotAttachedAndReset() {
  let resets = 0
  const histogram = {
    max: 31 * 1e6,
    mean: 4 * 1e6,
    percentile: () => 27 * 1e6,
    reset: () => { resets += 1 },
    disable: () => {}
  }
  const h = createHarness({ histogram })
  h.probe.start()
  h.advance(500)
  h.probe.tick()
  h.advance(500 + 5000)
  const stall = h.probe.tick()
  assert.deepStrictEqual(stall.loop, { maxMs: 31, p99Ms: 27, meanMs: 4 })
  const line = h.logs.find(entry => entry.message.includes('[EVENT_LOOP_STALL]'))
  assert.ok(line.message.includes('loopMaxMs=31'), line.message)
  assert.ok(line.message.includes('loopP99Ms=27'), line.message)
  assert.strictEqual(resets, 1, 'histogram reset after a stall report')
  console.log('  ok histogram snapshot rides along and resets')
}

function testPeriodicSummaryLine() {
  const h = createHarness()
  h.probe.start()
  for (let i = 0; i < 121; i++) {
    h.advance(500)
    h.probe.tick()
  }
  const summaries = h.logs.filter(entry => entry.message.includes('[EVENT_LOOP_PROBE] window='))
  assert.strictEqual(summaries.length, 1, `one summary per 60s window, got ${summaries.length}`)
  assert.ok(summaries[0].message.includes('stallsTotal=0'), summaries[0].message)
  console.log('  ok periodic summary line every summaryIntervalMs')
}

function testContextProviderErrorsDoNotBreakReporting() {
  const h = createHarness({ contextProvider: () => { throw new Error('boom') } })
  h.probe.start()
  h.advance(500)
  h.probe.tick()
  h.advance(500 + 3000)
  const stall = h.probe.tick()
  assert.ok(stall)
  assert.strictEqual(stall.context.contextError, 'boom')
  console.log('  ok a throwing context provider is reported, not fatal')
}

function testStartStopIdempotent() {
  const h = createHarness()
  assert.strictEqual(h.probe.start(), true)
  assert.strictEqual(h.probe.start(), false, 'second start is a no-op')
  assert.strictEqual(h.probe.isRunning(), true)
  assert.strictEqual(h.probe.stop(), true)
  assert.strictEqual(h.probe.stop(), false, 'second stop is a no-op')
  assert.strictEqual(h.timers[0], null, 'interval cleared')
  console.log('  ok start/stop are idempotent and clear the timer')
}

function testEnvFactory() {
  assert.strictEqual(createEventLoopProbeFromEnv({}), null, 'off by default')
  assert.strictEqual(createEventLoopProbeFromEnv({ EVENT_LOOP_PROBE: 'false' }), null)
  const probe = createEventLoopProbeFromEnv({
    EVENT_LOOP_PROBE: 'true',
    EVENT_LOOP_PROBE_THRESHOLD_MS: '1500',
    EVENT_LOOP_PROBE_INTERVAL_MS: '250'
  }, { histogram: null, logger: { log() {}, warn() {} } })
  assert.ok(probe instanceof EventLoopProbe)
  assert.strictEqual(probe.options.thresholdMs, 1500)
  assert.strictEqual(probe.options.intervalMs, 250)
  const defaults = createEventLoopProbeFromEnv({ EVENT_LOOP_PROBE: '1', EVENT_LOOP_PROBE_THRESHOLD_MS: 'nope' }, { histogram: null })
  assert.strictEqual(defaults.options.thresholdMs, 2000, 'garbage env falls back to the default')
  console.log('  ok env factory is opt-in and parses knobs')
}

async function testRealTimerDetectsRealBlock() {
  // The one wall-clock case: block the real loop for ~250ms and let a real
  // interval catch it. Threshold is set well below the block so the case is
  // robust on a slow machine, and well above timer jitter.
  const logs = []
  const probe = new EventLoopProbe({
    thresholdMs: 150,
    intervalMs: 20,
    summaryIntervalMs: 0,
    histogram: null,
    logger: { log: m => logs.push(m), warn: m => logs.push(m) },
    contextProvider: () => ({ task: 'sync_burst' })
  })
  probe.start()
  await new Promise(resolve => setTimeout(resolve, 60))
  const until = Date.now() + 250
  while (Date.now() < until) { /* synchronous burst */ }
  await new Promise(resolve => setTimeout(resolve, 60))
  probe.stop()
  const stall = logs.find(line => line.includes('[EVENT_LOOP_STALL]'))
  assert.ok(stall, `real synchronous burst detected; logs=${JSON.stringify(logs)}`)
  assert.ok(stall.includes('task=sync_burst'), stall)
  console.log('  ok real interval catches a real synchronous burst')
}

async function main() {
  console.log('[event-loop-probe tests]')
  testOnTimeTicksReportNothing()
  testLateTickReportsStallWithContext()
  testBelowThresholdIsNotAStall()
  testStallResetsScheduleSoOneBurstIsOneReport()
  testHistogramSnapshotAttachedAndReset()
  testPeriodicSummaryLine()
  testContextProviderErrorsDoNotBreakReporting()
  testStartStopIdempotent()
  testEnvFactory()
  await testRealTimerDetectsRealBlock()
  console.log('event-loop-probe tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
