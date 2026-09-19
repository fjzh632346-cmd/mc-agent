'use strict'

// Event-loop stall probe (diagnostic, opt-in).
//
// Two independent signals, both cheap:
//   1. Timer drift: a repeating timer notes how late it fires versus its
//      schedule. A synchronous burst of N ms delays the timer by ~N ms, so
//      any callback that lands `thresholdMs` or more behind schedule is
//      reported as a stall, together with whatever the caller says the bot
//      was doing at that moment (task / phase / step) via `contextProvider`.
//   2. perf_hooks.monitorEventLoopDelay (when available and not disabled):
//      a sampling histogram of loop delay; its max / p99 are attached to
//      every stall report and to the periodic summary line, so an hour with
//      *no* stall still leaves positive evidence in the log.
//
// Clock and timers are injectable so the drift logic is unit-testable
// without waiting on real time.

const DEFAULT_THRESHOLD_MS = 2000
const DEFAULT_INTERVAL_MS = 500
const DEFAULT_SUMMARY_INTERVAL_MS = 60000

function loadEventLoopHistogram(resolutionMs) {
  try {
    const { monitorEventLoopDelay } = require('perf_hooks')
    if (typeof monitorEventLoopDelay !== 'function') return null
    const histogram = monitorEventLoopDelay({ resolution: resolutionMs })
    histogram.enable()
    return histogram
  } catch {
    return null
  }
}

function nsToMs(value) {
  return Number.isFinite(value) ? Math.round(value / 1e6) : null
}

class EventLoopProbe {
  constructor(options = {}) {
    this.options = {
      thresholdMs: DEFAULT_THRESHOLD_MS,
      intervalMs: DEFAULT_INTERVAL_MS,
      summaryIntervalMs: DEFAULT_SUMMARY_INTERVAL_MS,
      histogramResolutionMs: 20,
      logger: console,
      now: Date.now,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: timer => clearInterval(timer),
      contextProvider: () => null,
      onStall: null,
      histogram: undefined,
      ...options
    }
    this.timer = null
    this.expectedAt = null
    this.lastSummaryAt = null
    this.histogram = null
    this.stats = { ticks: 0, stalls: 0, maxStallMs: 0, lastStall: null, startedAt: null }
  }

  start() {
    if (this.timer) return false
    const { intervalMs, histogram, histogramResolutionMs } = this.options
    this.histogram = histogram === undefined ? loadEventLoopHistogram(histogramResolutionMs) : histogram
    const now = this.options.now()
    this.stats.startedAt = now
    this.expectedAt = now + intervalMs
    this.lastSummaryAt = now
    this.timer = this.options.setInterval(() => this.tick(), intervalMs)
    this.log(`[EVENT_LOOP_PROBE] started thresholdMs=${this.options.thresholdMs} intervalMs=${intervalMs} histogram=${this.histogram ? 'on' : 'off'}`)
    return true
  }

  stop() {
    if (!this.timer) return false
    this.options.clearInterval(this.timer)
    this.timer = null
    try { this.histogram?.disable?.() } catch {}
    this.log(`[EVENT_LOOP_PROBE] stopped ticks=${this.stats.ticks} stalls=${this.stats.stalls} maxStallMs=${this.stats.maxStallMs}`)
    return true
  }

  isRunning() {
    return Boolean(this.timer)
  }

  // One timer firing. Public so tests can drive it off an injected clock.
  tick() {
    const { intervalMs, thresholdMs, summaryIntervalMs } = this.options
    const now = this.options.now()
    const lagMs = this.expectedAt == null ? 0 : Math.max(0, now - this.expectedAt)
    this.stats.ticks += 1
    let stall = null
    if (lagMs >= thresholdMs) {
      stall = this.reportStall(lagMs, now)
    }
    if (summaryIntervalMs > 0 && this.lastSummaryAt != null && now - this.lastSummaryAt >= summaryIntervalMs) {
      this.reportSummary(now)
    }
    this.expectedAt = now + intervalMs
    return stall
  }

  reportStall(lagMs, now) {
    let context = null
    try {
      context = this.options.contextProvider?.() || null
    } catch (err) {
      context = { contextError: err?.message || String(err) }
    }
    const loop = this.histogramSnapshot()
    const stall = { stallMs: lagMs, at: new Date(now).toISOString(), context, loop }
    this.stats.stalls += 1
    this.stats.maxStallMs = Math.max(this.stats.maxStallMs, lagMs)
    this.stats.lastStall = stall
    this.log(
      `[EVENT_LOOP_STALL] stallMs=${lagMs} thresholdMs=${this.options.thresholdMs} ` +
      `loopMaxMs=${loop?.maxMs ?? 'n/a'} loopP99Ms=${loop?.p99Ms ?? 'n/a'} ` +
      `${formatContext(context)}`,
      'warn'
    )
    try { this.histogram?.reset?.() } catch {}
    try { this.options.onStall?.(stall) } catch {}
    return stall
  }

  reportSummary(now) {
    const loop = this.histogramSnapshot()
    const windowSeconds = Math.round((now - this.lastSummaryAt) / 1000)
    this.log(
      `[EVENT_LOOP_PROBE] window=${windowSeconds}s loopMaxMs=${loop?.maxMs ?? 'n/a'} ` +
      `loopP99Ms=${loop?.p99Ms ?? 'n/a'} loopMeanMs=${loop?.meanMs ?? 'n/a'} ` +
      `stallsTotal=${this.stats.stalls} maxStallMs=${this.stats.maxStallMs}`
    )
    try { this.histogram?.reset?.() } catch {}
    this.lastSummaryAt = now
  }

  histogramSnapshot() {
    const h = this.histogram
    if (!h) return null
    try {
      return {
        maxMs: nsToMs(h.max),
        p99Ms: nsToMs(typeof h.percentile === 'function' ? h.percentile(99) : NaN),
        meanMs: nsToMs(h.mean)
      }
    } catch {
      return null
    }
  }

  getStats() {
    return { ...this.stats }
  }

  log(message, level = 'log') {
    const logger = this.options.logger
    const fn = logger?.[level] || logger?.log
    if (typeof fn === 'function') fn.call(logger, message)
  }
}

function formatContext(context) {
  if (!context || typeof context !== 'object') return 'context=none'
  return Object.entries(context)
    .map(([key, value]) => `${key}=${value == null ? 'none' : String(value)}`)
    .join(' ')
}

function createEventLoopProbeFromEnv(env = process.env, options = {}) {
  const enabled = env.EVENT_LOOP_PROBE === 'true' || env.EVENT_LOOP_PROBE === '1'
  if (!enabled) return null
  const thresholdMs = Number(env.EVENT_LOOP_PROBE_THRESHOLD_MS)
  const intervalMs = Number(env.EVENT_LOOP_PROBE_INTERVAL_MS)
  const summaryIntervalMs = Number(env.EVENT_LOOP_PROBE_SUMMARY_MS)
  return new EventLoopProbe({
    ...(Number.isFinite(thresholdMs) && thresholdMs > 0 ? { thresholdMs } : {}),
    ...(Number.isFinite(intervalMs) && intervalMs > 0 ? { intervalMs } : {}),
    ...(Number.isFinite(summaryIntervalMs) && summaryIntervalMs >= 0 ? { summaryIntervalMs } : {}),
    ...options
  })
}

module.exports = {
  EventLoopProbe,
  createEventLoopProbeFromEnv,
  DEFAULT_THRESHOLD_MS,
  DEFAULT_INTERVAL_MS
}
