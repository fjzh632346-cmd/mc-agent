const { logActionLock } = require('../actions/action-utils')

const TASK_STATE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  INTERRUPTED: 'INTERRUPTED'
}

class BaseTask {
  constructor({ id, type, priority = 5, params = {}, source = 'system', resumable = true }) {
    this.id = id
    this.type = type
    this.priority = priority
    this.params = params
    this.source = source
    this.resumable = resumable
    this.state = TASK_STATE.IDLE
    this.createdAt = Date.now()
    this.startedAt = null
    this.updatedAt = null
    this.completedAt = null
    this.error = null
    this.blockedReason = null
    this.result = null
    this.pauseReason = null
    this.interruptReason = null
    this.lockWaitReason = null
  }

  get lockType() {
    return null
  }

  get requiredLocks() {
    return this.lockType ? [this.lockType] : []
  }

  isTerminal() {
    return [
      TASK_STATE.COMPLETED,
      TASK_STATE.FAILED,
      TASK_STATE.BLOCKED
    ].includes(this.state)
  }

  async start(ctx) {
    ctx.actionLock?.clearOwnerTerminated?.(this.id)
    this.startedAt = Date.now()
    this.updatedAt = Date.now()
    this.state = TASK_STATE.RUNNING
    ctx.debug?.(`[Task:${this.type}#${this.id}] start`)
  }

  async update(ctx) {
    this.updatedAt = Date.now()
    ctx.debug?.(`[Task:${this.type}#${this.id}] update`)
  }

  acquireLocks(ctx, options = {}) {
    if (!this.requiredLocks.length) return { ok: true, types: [] }

    const result = ctx.taskArbiter?.acquireTaskLocks
      ? ctx.taskArbiter.acquireTaskLocks(this, ctx, options)
      : ctx.actionLock.acquireMany(this.requiredLocks, this.id, {
          reason: `${this.type}:${this.state}`,
          ...options
        })

    if (!result.ok) {
      this.lockWaitReason = result.reason
      ctx.debug?.(
        `[Task:${this.type}#${this.id}] waiting for ${result.type} lock held by ${result.currentOwner}`
      )
      return result
    }

    this.lockWaitReason = null
    for (const lock of result.types || []) {
      ctx.debug?.(`[ACTION_LOCK_ACQUIRE] lock=${lock} taskId=${this.id}`)
    }
    return result
  }

  async pause(ctx, reason = 'paused') {
    this.pauseReason = reason
    this.state = TASK_STATE.PAUSED
    logReleasedLocks(ctx, releaseTaskLocks(ctx, this), this.id)
    ctx.debug?.(`[Task:${this.type}#${this.id}] pause: ${reason}`)
  }

  async resume(ctx) {
    // 复活：把终态那一笔抹掉，否则它拿不回自己的锁。
    ctx.actionLock?.clearOwnerTerminated?.(this.id)
    this.pauseReason = null
    this.interruptReason = null
    this.updatedAt = Date.now()
    this.state = TASK_STATE.RUNNING
    ctx.debug?.(`[Task:${this.type}#${this.id}] resume`)
  }

  async complete(ctx, result = {}) {
    this.result = result
    this.completedAt = Date.now()
    this.state = TASK_STATE.COMPLETED
    terminateTaskLocks(ctx, this, 'completed')
    ctx.debug?.(`[Task:${this.type}#${this.id}] complete`)
  }

  async block(ctx, reason = 'blocked') {
    this.blockedReason = String(reason)
    this.state = TASK_STATE.BLOCKED
    terminateTaskLocks(ctx, this, 'blocked')
    ctx.debug?.(`[Task:${this.type}#${this.id}] block: ${this.blockedReason}`)
  }

  async fail(ctx, error) {
    this.error = error instanceof Error ? error.message : String(error)
    this.state = TASK_STATE.FAILED
    terminateTaskLocks(ctx, this, 'failed')
    ctx.debug?.(`[Task:${this.type}#${this.id}] fail: ${this.error}`)
  }

  async interrupt(ctx, reason = 'interrupted') {
    this.interruptReason = reason
    this.state = TASK_STATE.INTERRUPTED
    terminateTaskLocks(ctx, this, `interrupted:${reason}`)
    ctx.debug?.(`[Task:${this.type}#${this.id}] interrupt: ${reason}`)
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      priority: this.priority,
      params: this.params,
      source: this.source,
      state: this.state,
      error: this.error,
      blockedReason: this.blockedReason,
      result: this.result,
      pauseReason: this.pauseReason,
      interruptReason: this.interruptReason,
      lockWaitReason: this.lockWaitReason,
      requiredLocks: this.requiredLocks,
      manualPause: this.manualPause === true,
      resumable: this.resumable
    }
  }
}

// 终态收尾：先按老路放锁，再把这个 owner 封死。
//
// 封死那一步是给「还在 await 里的续体」准备的：脱困链、走位、储物这些
// 链条不知道任务已经没了，它们回来还会用同一个 owner 再 acquire 一次，
// 而那一次不会有任何人再来放锁（第 15 轮：movement 被一个 INTERRUPTED
// 的回家任务占死，之后 8 次建造全撞 lock_already_held）。
// reclaim 那一行只在真的收回了东西时才打——正常情况上一行已经放干净了。
function terminateTaskLocks(ctx, task, reason) {
  logReleasedLocks(ctx, releaseTaskLocks(ctx, task), task.id)
  const terminated = ctx.actionLock?.markOwnerTerminated?.(task.id, reason)
  if (terminated?.reclaimed?.length) {
    logActionLock(ctx, `reclaim owner=${task.id} types=${terminated.reclaimed.join(',')} reason=${reason}`)
  }
  return terminated
}

function releaseTaskLocks(ctx, task) {
  if (ctx.taskArbiter?.releaseTaskLocks) return ctx.taskArbiter.releaseTaskLocks(task, ctx)
  return ctx.actionLock?.releaseAll?.(task.id)
}

function logReleasedLocks(ctx, result, taskId) {
  for (const lock of result?.released || []) {
    ctx.debug?.(`[ACTION_LOCK_RELEASE] lock=${lock} taskId=${taskId}`)
  }
}

module.exports = { BaseTask, TASK_STATE }
