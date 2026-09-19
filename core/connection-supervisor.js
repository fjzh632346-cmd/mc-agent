'use strict'

const EventEmitter = require('events')

// Keeps the bot connected.
//
// mineflayer's bot object is single-use: once its socket ends there is no
// way back but creating a new bot. This supervisor owns that lifecycle:
//   connect -> 'bot' (a fresh bot; the host wires its handlers)
//   spawn   -> 'online'  (attempt counter resets)
//   end     -> 'offline' then either 'reconnect_scheduled' (backoff timer),
//              'reconnect_disabled' (enabled=false: legacy behaviour, stay
//              dead) or 'gave_up' (maxAttempts exhausted).
// Every bot gets a generation number; events from a superseded bot are
// ignored, so a late 'end' from an old socket cannot schedule a second
// reconnect. Clock and timers are injectable for tests.

const DEFAULT_BACKOFF_MS = Object.freeze([5000, 10000, 20000, 40000, 60000])
const DEFAULT_MAX_ATTEMPTS = 20

class ConnectionSupervisor extends EventEmitter {
  constructor(options = {}) {
    super()
    if (typeof options.createBot !== 'function') throw new TypeError('createBot must be a function')
    this.options = {
      enabled: options.enabled !== false,
      backoffMs: normalizeBackoff(options.backoffMs),
      maxAttempts: Number.isFinite(options.maxAttempts) && options.maxAttempts >= 0
        ? Math.floor(options.maxAttempts)
        : DEFAULT_MAX_ATTEMPTS,
      now: options.now || Date.now,
      setTimeout: options.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: options.clearTimeout || (timer => clearTimeout(timer)),
      logger: options.logger || console,
      createBot: options.createBot
    }
    this.state = 'idle'
    this.bot = null
    this.generation = 0
    this.attempt = 0
    this.timer = null
    this.lastEndReason = null
    this.nextReconnectAt = null
    this.connectedSince = null
  }

  get enabled() {
    return this.options.enabled
  }

  connect() {
    if (this.state === 'stopped') return null
    this.clearTimer()
    this.generation += 1
    const generation = this.generation
    this.state = 'connecting'
    let bot = null
    try {
      bot = this.options.createBot({ generation, reconnect: generation > 1 })
    } catch (err) {
      const reason = `create_failed:${err?.message || err}`
      this.log(`[CONNECTION] create_bot_failed generation=${generation} reason=${reason}`)
      this.handleEnd(reason, generation)
      return null
    }
    this.bot = bot
    this.attach(bot, generation)
    this.emit('bot', bot, { generation, reconnect: generation > 1 })
    return bot
  }

  attach(bot, generation) {
    bot.once('spawn', () => this.handleSpawn(generation))
    bot.once('end', reason => this.handleEnd(reason, generation))
    bot.on('kicked', reason => this.emit('kicked', reason, { generation }))
    // mineflayer emits 'error' on the bot; an EventEmitter with no 'error'
    // listener would throw, so always keep one and re-emit under a safe name.
    bot.on('error', err => this.emit('bot_error', err, { generation }))
  }

  handleSpawn(generation) {
    if (generation !== this.generation || this.state === 'stopped') return
    const reconnected = generation > 1
    this.state = 'online'
    this.attempt = 0
    this.nextReconnectAt = null
    this.connectedSince = this.options.now()
    this.emit('online', { generation, reconnected })
  }

  handleEnd(reason, generation) {
    if (generation !== this.generation || this.state === 'stopped') return
    const wasOnline = this.state === 'online'
    this.state = 'offline'
    this.lastEndReason = reason == null ? 'unknown' : String(reason)
    this.connectedSince = null
    this.emit('offline', { reason: this.lastEndReason, generation, wasOnline, attempt: this.attempt })
    if (!this.options.enabled) {
      this.emit('reconnect_disabled', { reason: this.lastEndReason, generation })
      return
    }
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.attempt >= this.options.maxAttempts) {
      this.state = 'gave_up'
      this.emit('gave_up', { attempts: this.attempt, maxAttempts: this.options.maxAttempts, reason: this.lastEndReason })
      return
    }
    const delayMs = this.backoffFor(this.attempt)
    this.attempt += 1
    this.state = 'reconnecting'
    this.nextReconnectAt = this.options.now() + delayMs
    this.emit('reconnect_scheduled', {
      attempt: this.attempt,
      maxAttempts: this.options.maxAttempts,
      delayMs,
      reason: this.lastEndReason
    })
    this.timer = this.options.setTimeout(() => {
      this.timer = null
      this.connect()
    }, delayMs)
  }

  backoffFor(attemptIndex) {
    const list = this.options.backoffMs
    return list[Math.min(Math.max(0, attemptIndex), list.length - 1)]
  }

  isOnline() {
    return this.state === 'online'
  }

  status() {
    const now = this.options.now()
    return {
      state: this.state,
      enabled: this.options.enabled,
      generation: this.generation,
      attempt: this.attempt,
      maxAttempts: this.options.maxAttempts,
      lastEndReason: this.lastEndReason,
      nextReconnectInMs: this.nextReconnectAt == null ? null : Math.max(0, this.nextReconnectAt - now),
      onlineForMs: this.connectedSince == null ? null : Math.max(0, now - this.connectedSince)
    }
  }

  stop() {
    this.clearTimer()
    this.state = 'stopped'
    this.options.enabled = false
  }

  clearTimer() {
    if (this.timer != null) {
      this.options.clearTimeout(this.timer)
      this.timer = null
    }
  }

  log(message) {
    this.options.logger?.log?.(message)
  }
}

function normalizeBackoff(list) {
  const values = Array.isArray(list)
    ? list.map(Number).filter(value => Number.isFinite(value) && value >= 0)
    : []
  return values.length ? values : [...DEFAULT_BACKOFF_MS]
}

function parseBackoffEnv(value) {
  if (!value) return null
  const parsed = String(value).split(/[,\s]+/).map(Number).filter(v => Number.isFinite(v) && v >= 0)
  return parsed.length ? parsed : null
}

function createConnectionSupervisorFromEnv(env = process.env, options = {}) {
  const enabled = env.BOT_RECONNECT !== 'false' && env.BOT_RECONNECT !== '0'
  const maxAttempts = Number(env.BOT_RECONNECT_MAX_ATTEMPTS)
  const backoffMs = parseBackoffEnv(env.BOT_RECONNECT_BACKOFF_MS)
  return new ConnectionSupervisor({
    enabled,
    ...(Number.isFinite(maxAttempts) && maxAttempts >= 0 ? { maxAttempts } : {}),
    ...(backoffMs ? { backoffMs } : {}),
    ...options
  })
}

module.exports = {
  ConnectionSupervisor,
  createConnectionSupervisorFromEnv,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS
}
