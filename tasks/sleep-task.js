const { BaseTask } = require('./base-task')
const { moveTo, stopMoving } = require('../actions/move')
const { findNearestBed, isNight } = require('../utils/sleep')

const MONSTER_SLEEP_DISTANCE = 8
const DEFAULT_SLEEP_FEEDBACK_COOLDOWN_MS = 30000

class SleepTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'sleep' })
    this.started = false
    this.sleepState = {
      isNight: null,
      isSleeping: false,
      sleepPhase: 'idle',
      knownBedPosition: null,
      nearestBedPosition: null,
      distanceToBed: null,
      lastSleepAction: null,
      lastSleepError: null,
      canSleepNow: false,
      sleepReason: null,
      pathStatus: 'idle',
      waitingSince: null,
      waitingForPlayers: false
    }
    this.lastFeedbackAt = 0
    this.lastFeedbackLevel = null
  }

  get requiredLocks() {
    return ['movement']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return

    if (this.sleepState.sleepPhase === 'waiting_for_others' || this.sleepState.sleepPhase === 'sleeping') {
      await this.updateWaiting(ctx)
      return
    }

    if (this.started) return
    this.started = true

    logEvent(ctx, `[sleep] input=${this.params.input || 'sleep'} actionKey=SLEEP`)
    this.updateSleepState(ctx, { sleepPhase: 'finding_bed' })

    const night = isNight(ctx)
    const bed = findNearestBed(ctx, { radius: this.params.radius || 32 })
    this.updateSleepState(ctx, {
      isNight: night,
      nearestBedPosition: bed.ok ? bed.position : null,
      distanceToBed: bed.ok ? roundDistance(bed.distance) : null,
      canSleepNow: night && bed.ok,
      sleepReason: bed.ok ? (night ? 'night_and_bed_available' : 'bed_available_but_not_night') : 'sleep_failed_no_bed_found'
    })
    logEvent(ctx, `[sleep] isNight=${night} nearestBed=${bed.ok ? formatPos(bed.position) : 'none'} distance=${bed.ok ? roundDistance(bed.distance) : 'unknown'}`)

    if (!night && this.params.force !== true) {
      await this.failSleep(ctx, 'sleep_failed_not_night')
      return
    }
    if (!bed.ok) {
      await this.failSleep(ctx, bed.error || 'sleep_failed_no_bed_found')
      return
    }
    if (Number(bed.distance) > (this.params.maxBedDistance || 32)) {
      await this.failSleep(ctx, 'sleep_failed_bed_too_far')
      return
    }
    if (hasNearbyHostile(ctx)) {
      await this.failSleep(ctx, 'sleep_failed_monsters_nearby')
      return
    }

    this.updateSleepState(ctx, { sleepPhase: 'moving_to_bed', lastSleepAction: 'move_to_bed', pathStatus: 'moving' })
    const moved = await moveTo(ctx, bed.position, {
      owner: this.id,
      range: this.params.range || 2,
      timeoutMs: this.params.timeoutMs || 15000,
      holdLock: true,
      shouldContinue: () => this.state === 'RUNNING'
    })
    this.updateSleepState(ctx, { pathStatus: moved.ok ? 'arrived' : 'failed' })
    logEvent(ctx, `[sleep] pathStatus=${moved.ok ? 'arrived' : moved.error || 'failed'}`)
    if (!moved.ok) {
      await this.failSleep(ctx, pathFailureReason(moved.error))
      return
    }

    await this.trySleep(ctx, bed)
  }

  async trySleep(ctx, bed) {
    try {
      if (typeof ctx.bot?.sleep !== 'function') {
        await this.failSleep(ctx, 'sleep_failed_server_rejected')
        return
      }
      this.updateSleepState(ctx, { sleepPhase: 'sleeping', lastSleepAction: 'bot.sleep' })
      logEvent(ctx, '[sleep] action=bot.sleep result=start')
      await ctx.bot.sleep(bed.bed || bed)
      await this.enterWaitingForOthers(ctx, bed, 'success')
    } catch (err) {
      if (isAlreadySleeping(ctx, err)) {
        await this.enterWaitingForOthers(ctx, bed, 'success_after_sleep_exception')
        return
      }
      await this.failSleep(ctx, classifySleepError(err), err)
    }
  }

  async enterWaitingForOthers(ctx, bed, result) {
    const now = Date.now()
    this.updateSleepState(ctx, {
      isNight: isNight(ctx),
      isSleeping: Boolean(ctx.bot?.isSleeping ?? true),
      sleepPhase: 'waiting_for_others',
      knownBedPosition: bed.position,
      nearestBedPosition: bed.position,
      lastSleepAction: 'bot.sleep',
      lastSleepError: null,
      sleepReason: 'sleep_waiting_for_others',
      waitingSince: this.sleepState.waitingSince || now,
      waitingForPlayers: true
    })
    logEvent(ctx, `[sleep] action=bot.sleep result=${result}`)
    logEvent(ctx, `[sleep] phase=waiting_for_others isSleeping=${this.sleepState.isSleeping} waitingForPlayers=true`)
    this.emitWaitingFeedback(ctx, true)
  }

  async updateWaiting(ctx) {
    const night = isNight(ctx)
    const sleeping = Boolean(ctx.bot?.isSleeping ?? this.sleepState.isSleeping)
    this.updateSleepState(ctx, {
      isNight: night,
      isSleeping: sleeping,
      waitingForPlayers: night && sleeping,
      sleepReason: night && sleeping ? 'sleep_waiting_for_others' : this.sleepState.sleepReason
    })

    if (hasNearbyHostile(ctx)) {
      logEvent(ctx, '[sleep] wake reason=damage_or_monsters_nearby')
      await this.failSleep(ctx, 'sleep_failed_monsters_nearby')
      return
    }

    if (!night) {
      this.updateSleepState(ctx, {
        sleepPhase: 'woke_up',
        isSleeping: false,
        waitingForPlayers: false,
        lastSleepAction: 'wake',
        sleepReason: 'morning'
      })
      logEvent(ctx, '[sleep] wake reason=morning')
      emitChat(ctx, '天亮了，我起来了。')
      await this.complete(ctx, { sleepState: this.sleepState, message: 'woke_up' })
      return
    }

    if (!sleeping && Date.now() - Number(this.sleepState.waitingSince || Date.now()) > 3000) {
      this.updateSleepState(ctx, {
        sleepPhase: 'failed',
        waitingForPlayers: false,
        sleepReason: 'sleep_failed_server_rejected'
      })
      logEvent(ctx, '[sleep] wake reason=unknown')
      await this.failSleep(ctx, 'sleep_failed_server_rejected')
      return
    }

    this.emitWaitingFeedback(ctx, false)
  }

  async failSleep(ctx, reason, err = null) {
    this.updateSleepState(ctx, {
      sleepPhase: 'failed',
      lastSleepError: reason,
      sleepReason: reason,
      lastSleepAction: 'fail',
      waitingForPlayers: false
    })
    if (err) logEvent(ctx, `[sleep] failReason=${reason} error=${JSON.stringify(String(err.message || err))}`)
    else logEvent(ctx, `[sleep] failReason=${reason}`)
    await this.fail(ctx, reason)
  }

  emitWaitingFeedback(ctx, immediate) {
    const now = Date.now()
    const cooldownMs = this.params.sleepFeedbackCooldownMs || DEFAULT_SLEEP_FEEDBACK_COOLDOWN_MS
    const waitMs = Math.max(0, now - Number(this.sleepState.waitingSince || now))
    const level = feedbackLevel(waitMs)

    if (!immediate && now - this.lastFeedbackAt < cooldownMs) {
      logEvent(ctx, `[sleep] waitMs=${waitMs} feedbackLevel=${level}`)
      logEvent(ctx, '[sleep] feedback skipped reason=cooldown')
      return
    }

    const text = waitingFeedbackText(level)
    this.lastFeedbackAt = now
    this.lastFeedbackLevel = level
    logEvent(ctx, `[sleep] waitMs=${waitMs} feedbackLevel=${level}`)
    emitChat(ctx, text)
  }

  updateSleepState(ctx, patch = {}) {
    this.sleepState = { ...this.sleepState, ...patch }
    try {
      ctx.blackboard?.set?.('sleep', this.sleepState)
    } catch {}
  }

  async pause(ctx, reason) {
    stopMoving(ctx, { owner: this.id, reason })
    await super.pause(ctx, reason)
  }

  async interrupt(ctx, reason) {
    stopMoving(ctx, { owner: this.id, reason })
    await super.interrupt(ctx, reason)
  }

  toJSON() {
    return {
      ...super.toJSON(),
      sleepState: this.sleepState
    }
  }
}

function hasNearbyHostile(ctx) {
  const mobs = ctx.blackboard?.snapshot?.().mobs || ctx.worldState?.mobs || {}
  if (['high', 'critical'].includes(mobs.dangerLevel)) return true
  const hostiles = [
    ...(Array.isArray(mobs.hostileMobs) ? mobs.hostileMobs : []),
    mobs.nearestHostileMob
  ].filter(Boolean)
  return hostiles.some(hostile => Number(hostile.distance) <= MONSTER_SLEEP_DISTANCE)
}

function pathFailureReason(error) {
  const reason = String(error || '')
  if (reason.includes('timeout') || reason.includes('path') || reason.includes('No path')) return 'sleep_failed_bed_unreachable'
  if (reason.includes('interrupted')) return 'task_interrupted'
  return 'sleep_failed_bed_unreachable'
}

function classifySleepError(err) {
  const message = String(err?.message || err || '').toLowerCase()
  if (message.includes('not night') || message.includes('day')) return 'sleep_failed_not_night'
  if (message.includes('monster')) return 'sleep_failed_monsters_nearby'
  if (message.includes('occupied')) return 'sleep_failed_bed_occupied'
  if (message.includes('dimension') || message.includes('nether') || message.includes('end')) return 'sleep_failed_dimension_not_safe'
  if (message.includes('too far')) return 'sleep_failed_bed_unreachable'
  if (message.includes('may not rest') || message.includes('server')) return 'sleep_failed_server_rejected'
  return 'sleep_failed_unknown'
}

function isAlreadySleeping(ctx, err) {
  if (ctx.bot?.isSleeping === true) return true
  const message = String(err?.message || err || '').toLowerCase()
  return message.includes('already sleeping') || message.includes('is sleeping') || message.includes('in bed')
}

function feedbackLevel(waitMs) {
  if (waitMs >= 90000) return 'long'
  if (waitMs >= 30000) return 'medium'
  return 'initial'
}

function waitingFeedbackText(level) {
  if (level === 'long') return '我先躺着等你，不急。'
  if (level === 'medium') return '我还在床上等你，等大家都睡了就天亮了。'
  return '我躺好了，你也来睡吧。'
}

function emitChat(ctx, text) {
  if (ctx.reminderOutput) ctx.reminderOutput(text)
  else if (ctx.bot?.chat) ctx.bot.chat(text)
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function roundDistance(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

module.exports = { SleepTask }
