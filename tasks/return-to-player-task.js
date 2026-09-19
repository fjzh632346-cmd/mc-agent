const { BaseTask, TASK_STATE } = require('./base-task')
const { returnToPlayer } = require('../actions/explore')
const { stopMovement, stopMoving } = require('../actions/move')
const {
  createRecoveryState,
  getRecoverySnapshot,
  notePathFailure,
  runStuckRecovery,
  updateStuckTracking
} = require('./stuck-recovery')

class ReturnToPlayerTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'return_to_player' })
    this.started = false
    this.recovery = createRecoveryState()
  }

  get requiredLocks() {
    return ['movement']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return

    this.started = true
    logEvent(ctx, '[RETURN_TASK_START] target=player')
    const targetInfo = selectPlayer(ctx, this.params)
    const target = targetInfo?.position || null
    this.recovery.targetPlayer = targetInfo?.username || this.params.username || this.params.playerName || null
    if (target) logEvent(ctx, `[RETURN_TARGET_SELECTED] pos=${formatPos(target)} reason=player`)
    if (!target) {
      this.recovery.lastFailureReason = 'player_not_found'
      await this.fail(ctx, 'player_not_found')
      return
    }

    updateStuckTracking(ctx, this.recovery, target, recoveryOptions(this.params))
    if (this.recovery.isStuck) {
      logEvent(ctx, `[STUCK_DETECTED] task=return_to_player taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
      const recoveryResult = await runStuckRecovery(ctx, this.recovery, target, this.id, this.recoveryOptions())
      if (this.abandoned(ctx, recoveryResult)) return
      if (!recoveryResult.ok) {
        logEvent(ctx, `[RETURN_FAILED] reason=${recoveryResult.error || 'stuck_recovery_failed'}`)
        await this.fail(ctx, recoveryResult.error || 'stuck_recovery_failed')
        return
      }
    }

    stopMovement(ctx.bot, 'return_command', this.id)
    logEvent(ctx, '[RETURN_PATH_START]')
    let result = await returnToPlayer(ctx, {
      owner: this.id,
      range: this.params.range || 2,
      timeoutMs: this.params.timeoutMs || 15000,
      holdLock: true
    })

    // Same rule as return_to_base: an interrupt that lands mid-walk is not a
    // path failure, so neither the retry walk nor the escape ladder may run.
    if (this.abandoned(ctx, result)) return
    if (!result.ok && isPathFailure(result.error)) {
      const options = this.recoveryOptions()
      notePathFailure(ctx, this.recovery, result.error || 'pathfinder_failed', options)
      if (!this.recovery.isStuck) {
        logEvent(ctx, `[RETURN_PATH_RETRY] reason=path_timeout_not_confirmed_stuck pathFailureCount=${this.recovery.pathFailureCount || 0}`)
        result = await returnToPlayer(ctx, {
          owner: this.id,
          range: this.params.range || 2,
          timeoutMs: this.params.timeoutMs || 15000,
          holdLock: true
        })
        if (this.abandoned(ctx, result)) return
        if (!result.ok && isPathFailure(result.error)) {
          notePathFailure(ctx, this.recovery, result.error || 'pathfinder_failed', options)
          if (this.recovery.isStuck) {
            logEvent(ctx, `[STUCK_DETECTED] task=return_to_player taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
            const recoveryResult = await runStuckRecovery(ctx, this.recovery, target, this.id, options)
            if (this.abandoned(ctx, recoveryResult)) return
            result = recoveryResult.ok
              ? await returnToPlayer(ctx, {
                owner: this.id,
                range: this.params.range || 2,
                timeoutMs: this.params.timeoutMs || 15000,
                holdLock: true
              })
              : { ok: false, error: recoveryResult.error || 'stuck_recovery_failed' }
          }
        }
      } else {
        logEvent(ctx, `[STUCK_DETECTED] task=return_to_player taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
        const recoveryResult = await runStuckRecovery(ctx, this.recovery, target, this.id, options)
        if (this.abandoned(ctx, recoveryResult)) return
        if (recoveryResult.ok) {
          logEvent(ctx, '[RETURN_PATH_RETRY] reason=recovery_success')
          result = await returnToPlayer(ctx, {
            owner: this.id,
            range: this.params.range || 2,
            timeoutMs: this.params.timeoutMs || 15000,
            holdLock: true
          })
        } else {
          result = { ok: false, error: recoveryResult.error || 'stuck_recovery_failed' }
        }
      }
    }

    if (this.abandoned(ctx, result)) return
    if (result.ok) {
      this.recovery.pathStatus = 'arrived'
      logEvent(ctx, '[RETURN_SUCCESS]')
      await this.complete(ctx, result.data)
    } else {
      this.recovery.lastFailureReason = result.error || 'return_failed'
      logEvent(ctx, `[RETURN_FAILED] reason=${result.error || 'return_failed'}`)
      await this.fail(ctx, result.error || 'return_failed')
    }
  }

  // Same one liveness judgment as return_to_base: abandoned() reads it between
  // two awaits, the escape ladder and the walks read it from inside theirs.
  isRunning() {
    return this.state === TASK_STATE.RUNNING
  }

  // True once the task has been interrupted or paused underneath an awaited
  // move/recovery: stop the chain and keep the state the interrupt set.
  abandoned(ctx, result = {}) {
    if (this.isRunning()) return false
    this.recovery.lastFailureReason = result?.error || this.recovery.lastFailureReason
    logEvent(ctx, `[RETURN_ABANDONED] task=return_to_player taskId=${this.id} state=${this.state} lastResult=${result?.error || (result?.ok ? 'ok' : 'unknown')}`)
    return true
  }

  recoveryOptions() {
    return { ...recoveryOptions(this.params), shouldContinue: () => this.isRunning() }
  }

  async pause(ctx, reason) {
    stopMoving(ctx, { owner: this.id })
    await super.pause(ctx, reason)
  }

  async interrupt(ctx, reason) {
    stopMoving(ctx, { owner: this.id })
    await super.interrupt(ctx, reason)
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...getRecoverySnapshot(this.recovery)
    }
  }
}

function selectPlayer(ctx, params = {}) {
  const username = params.username || params.playerName
  if (username && ctx.bot?.players?.[username]?.entity?.position) {
    return { username, position: ctx.bot.players[username].entity.position }
  }
  const ownerPosition = ctx.blackboard?.get?.('player.ownerPosition') ||
    ctx.blackboard?.get?.('player.nearestPlayer.position')
  if (ownerPosition) return { username: username || null, position: ownerPosition }
  const bot = ctx.bot
  const player = Object.values(bot?.players || {})
    .filter(candidate => candidate?.entity && candidate.username !== bot.username)[0]
  return player?.entity?.position ? { username: player.username || null, position: player.entity.position } : null
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

function isPathFailure(error) {
  return ['move_timeout', 'task_interrupted', 'pathfinder_failed', 'No path to the goal'].some(item => String(error || '').includes(item))
}

function recoveryOptions(params = {}) {
  return {
    // Ledger key is per task TYPE so escalation survives task re-creation.
    escapeKey: params.escapeKey || 'return_to_player',
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

module.exports = { ReturnToPlayerTask }
