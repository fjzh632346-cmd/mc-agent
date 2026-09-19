const { BaseTask, TASK_STATE } = require('./base-task')
const { moveTo, stopMovement, stopMoving } = require('../actions/move')
const { getBaseLocation } = require('./task-utils')
const {
  createRecoveryState,
  getRecoverySnapshot,
  notePathFailure,
  runStuckRecovery,
  updateStuckTracking
} = require('./stuck-recovery')

class ReturnToBaseTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'return_to_base' })
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
    logEvent(ctx, '[RETURN_TASK_START] target=base')

    const baseLocation = getBaseLocation(ctx)
    if (!baseLocation) {
      logEvent(ctx, '[RETURN_FAILED] reason=base_location_missing')
      await this.fail(ctx, 'base_location_missing:\u8bf7\u5148\u8bf4\u201c\u8bb0\u4f4f\u8fd9\u91cc\u662f\u57fa\u5730\u201d')
      return
    }

    logEvent(ctx, `[RETURN_TARGET_SELECTED] pos=${formatPos(baseLocation)} reason=base`)
    const dangerLevel = ctx.blackboard?.get?.('mobs.dangerLevel') || ctx.worldState?.mobs?.dangerLevel
    updateStuckTracking(ctx, this.recovery, baseLocation, recoveryOptions(this.params))
    if (this.recovery.isStuck) {
      logEvent(ctx, `[STUCK_DETECTED] task=return_to_base taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
      const recoveryResult = await runStuckRecovery(ctx, this.recovery, baseLocation, this.id, this.recoveryOptions())
      if (this.abandoned(ctx, recoveryResult)) return
      if (!recoveryResult.ok) {
        logEvent(ctx, `[RETURN_FAILED] reason=${recoveryResult.error || 'stuck_recovery_failed'}`)
        await this.fail(ctx, recoveryResult.error || 'stuck_recovery_failed')
        return
      }
    }
    stopMovement(ctx.bot, 'return_command', this.id)
    logEvent(ctx, '[RETURN_PATH_START]')
    let result = await moveTo(ctx, baseLocation, {
      owner: this.id,
      range: this.params.range || 2,
      timeoutMs: this.params.timeoutMs || 20000,
      canDig: dangerLevel === 'high' || dangerLevel === 'critical' ? false : undefined,
      holdLock: true,
      shouldContinue: () => this.isRunning()
    })

    // A "停止任务" that lands while the walk is in flight surfaces here as a
    // failed move. It is not a path problem: do not climb the escape ladder
    // and do not walk again for a task nobody wants any more (building lane
    // round 14: ESCAPE_RUNG / ESCAPE_PILLAR / RETURN_PATH_RETRY ran ~5 s
    // after TASK_INTERRUPTED and the next build order found her too far).
    if (this.abandoned(ctx, result)) return
    if (!result.ok && isPathFailure(result.error)) {
      notePathFailure(ctx, this.recovery, result.error || 'pathfinder_failed')
      logEvent(ctx, `[STUCK_DETECTED] task=return_to_base taskId=${this.id} reason=${this.recovery.stuckReason} inHole=${this.recovery.isInHole ? 'true' : 'false'}`)
      const recoveryResult = await runStuckRecovery(ctx, this.recovery, baseLocation, this.id, this.recoveryOptions())
      if (this.abandoned(ctx, recoveryResult)) return
      if (recoveryResult.ok) {
        logEvent(ctx, '[RETURN_PATH_RETRY] reason=recovery_success')
        result = await moveTo(ctx, baseLocation, {
          owner: this.id,
          range: this.params.range || 2,
          timeoutMs: this.params.timeoutMs || 20000,
          canDig: dangerLevel === 'high' || dangerLevel === 'critical' ? false : undefined,
          holdLock: true,
          shouldContinue: () => this.isRunning()
        })
      } else {
        result = { ok: false, error: recoveryResult.error || 'stuck_recovery_failed' }
      }
    }

    if (this.abandoned(ctx, result)) return
    if (result.ok) {
      this.recovery.pathStatus = 'arrived'
      logEvent(ctx, '[RETURN_SUCCESS]')
      await this.complete(ctx, { ...result.data, dangerLevel })
    } else {
      this.recovery.lastFailureReason = result.error || 'return_to_base_failed'
      logEvent(ctx, `[RETURN_FAILED] reason=${result.error || 'return_to_base_failed'}`)
      await this.fail(ctx, result.error || 'return_to_base_failed')
    }
  }

  // The one liveness judgment for this task. abandoned() reads it between two
  // awaits; the escape ladder and the walks read it from inside theirs, so an
  // interrupt lands the same way wherever it falls (round 15 — building 22 had
  // the ladder walk on for eight more seconds after the cancel and take the
  // movement lock back with it).
  isRunning() {
    return this.state === TASK_STATE.RUNNING
  }

  // True once the task has been interrupted or paused underneath an awaited
  // move/recovery: the rest of the chain must stop, and the terminal state
  // set by the interrupt must not be overwritten with FAILED.
  abandoned(ctx, result = {}) {
    if (this.isRunning()) return false
    this.recovery.lastFailureReason = result?.error || this.recovery.lastFailureReason
    logEvent(ctx, `[RETURN_ABANDONED] task=return_to_base taskId=${this.id} state=${this.state} lastResult=${result?.error || (result?.ok ? 'ok' : 'unknown')}`)
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
    targetRange: params.range || 2,
    stuckTickThreshold: params.stuckTickThreshold || 4,
    recoveryTimeoutMs: params.recoveryTimeoutMs || 4000,
    allowDig: params.allowDig !== false,
    // Keyed by task TYPE, not task id: the survival system re-creates this task
    // on every failure, and the escalation ledger has to outlive the instance
    // or the ladder restarts at rung 0 forever (round 5's pit death).
    escapeKey: params.escapeKey || 'return_to_base'
  }
}

module.exports = { ReturnToBaseTask }
