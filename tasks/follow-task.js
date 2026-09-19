const { BaseTask } = require('./base-task')
const { startFollow, stopMovement } = require('../actions/move')
const {
  createRecoveryState,
  getRecoverySnapshot,
  runStuckRecovery,
  updateStuckTracking
} = require('./stuck-recovery')

class FollowTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'follow_player' })
    this.followStarted = false
    this.durationMs = Number.isFinite(Number(this.params.durationMs)) && Number(this.params.durationMs) > 0
      ? Number(this.params.durationMs)
      : null
    this.until = null
    this.recovery = createRecoveryState()
  }

  get lockType() {
    return 'movement'
  }

  async start(ctx) {
    await super.start(ctx)
    this.until = this.durationMs ? Date.now() + this.durationMs : null
  }

  findTargetPlayer(bot) {
    const username = this.params.username || this.params.playerName
    if (username && bot.players[username]?.entity) return bot.players[username]

    return Object.values(bot.players)
      .filter(player => player.username !== bot.username && player.entity)
      .sort((a, b) => {
        const botPos = bot.entity.position
        return botPos.distanceTo(a.entity.position) - botPos.distanceTo(b.entity.position)
      })[0] || null
  }

  async update(ctx) {
    await super.update(ctx)
    if (this.state !== 'RUNNING') return

    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return

    const player = this.findTargetPlayer(ctx.bot)
    if (!player?.entity) {
      this.recovery.lastFailureReason = 'player_not_found'
      await this.fail(ctx, 'player_not_found')
      return
    }
    this.recovery.targetPlayer = player.username || this.params.username || this.params.playerName || null

    if (!this.followStarted) {
      startFollow(ctx.bot, player.entity, this.params.range || 2)
      this.followStarted = true
      ctx.debug?.(`[FollowTask#${this.id}] following ${player.username}`)
      logEvent(ctx, `[FOLLOW_TASK_START] targetPlayer=${player.username || 'unknown'} range=${this.params.range || 2}`)
    }

    updateStuckTracking(ctx, this.recovery, player.entity.position, recoveryOptions(this.params))
    if (this.recovery.isStuck && !this.recovery.recovering) {
      logEvent(ctx, `[STUCK_DETECTED] task=follow_player taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
      stopMovement(ctx.bot, 'follow_stuck_recovery', this.id)
      this.followStarted = false
      const recoveryResult = await runStuckRecovery(ctx, this.recovery, player.entity.position, this.id, recoveryOptions(this.params))
      if (!recoveryResult.ok) {
        this.recovery.lastFailureReason = recoveryResult.error || 'stuck_recovery_failed'
        await this.fail(ctx, recoveryResult.error || 'stuck_recovery_failed')
        return
      }
      this.followStarted = false
    }

    if (this.until && Date.now() >= this.until) {
      stopMovement(ctx.bot, 'complete', this.id)
      await this.complete(ctx, { followed: player.username })
    }
  }

  async pause(ctx, reason) {
    stopMovement(ctx.bot, movementStopReason(reason, 'pause'), this.id)
    this.followStarted = false
    await super.pause(ctx, reason)
  }

  async resume(ctx) {
    await super.resume(ctx)
    this.followStarted = false
  }

  async interrupt(ctx, reason) {
    stopMovement(ctx.bot, movementStopReason(reason, 'interrupt'), this.id)
    this.followStarted = false
    await super.interrupt(ctx, reason)
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...getRecoverySnapshot(this.recovery)
    }
  }
}

function movementStopReason(reason, fallback) {
  if (reason === 'stop_follow') return 'stop_follow'
  if (typeof reason === 'string' && reason.includes('preempted_by:storage')) return 'preempt_by_storage'
  if (typeof reason === 'string' && reason.includes('preempted_by:farming')) return 'preempt_by_farming_or_food'
  if (typeof reason === 'string' && reason.includes('preempted_by:exploration')) return 'preempt_by_exploration'
  return fallback
}

function recoveryOptions(params = {}) {
  return {
    // Ledger key is per task TYPE so escalation survives task re-creation.
    escapeKey: params.escapeKey || 'follow',
    targetRange: params.range || 2,
    stuckTickThreshold: params.stuckTickThreshold || 4,
    recoveryTimeoutMs: params.recoveryTimeoutMs || 4000,
    pathFailureThreshold: params.pathFailureThreshold || 2,
    allowDig: params.allowDig === true,
    minDigRecoveryAttempts: params.minDigRecoveryAttempts || 3,
    requireInHoleForDig: params.requireInHoleForDig !== false,
    minDigStuckTicks: params.minDigStuckTicks || 2
  }
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

module.exports = { FollowTask }
