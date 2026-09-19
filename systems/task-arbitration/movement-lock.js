const { ActionLock, LOCK_TYPES } = require('../../core/action-lock')

class MovementLock {
  constructor(options = {}) {
    this.actionLock = options.actionLock || new ActionLock(options)
    this.now = options.now || (() => Date.now())
    this.staleMs = options.staleMs || 45000
    this.logger = options.logger || null
  }

  setActionLock(actionLock) {
    this.actionLock = actionLock
  }

  lock(ownerTaskId, options = {}) {
    if (ownerTaskId == null || ownerTaskId === '') {
      return { ok: false, reason: 'missing_owner', owner: ownerTaskId, type: LOCK_TYPES.MOVEMENT }
    }

    const recovered = this.recoverStaleLock()
    const currentOwner = this.actionLock.getOwner(LOCK_TYPES.MOVEMENT)
    if (currentOwner != null && currentOwner !== ownerTaskId) {
      const result = {
        ok: false,
        reason: 'movement_lock_held',
        type: LOCK_TYPES.MOVEMENT,
        owner: ownerTaskId,
        currentOwner,
        recovered
      }
      this.log(`[movement-lock] acquire owner=${ownerTaskId} result=${result.reason} currentOwner=${currentOwner}`)
      return result
    }

    const result = this.actionLock.acquire(LOCK_TYPES.MOVEMENT, ownerTaskId, options)
    this.log(`[movement-lock] acquire owner=${ownerTaskId} result=${result.ok ? 'ok' : result.reason}`)
    return { ...result, recovered }
  }

  unlock(ownerTaskId) {
    const result = this.actionLock.release(LOCK_TYPES.MOVEMENT, ownerTaskId)
    this.log(`[movement-lock] release owner=${ownerTaskId} result=${result.ok ? 'ok' : result.reason}`)
    return result
  }

  forceRelease(reason = 'force_release') {
    const result = this.actionLock.forceRelease(LOCK_TYPES.MOVEMENT, reason)
    this.log(`[movement-lock] forceRelease reason=${reason} result=${result.released ? 'released' : result.reason || 'none'}`)
    return result
  }

  transfer(ownerTaskId, reason = 'movement_lock_transfer') {
    const released = this.forceRelease(reason)
    const acquired = this.lock(ownerTaskId, { reason })
    return { ok: acquired.ok, released, acquired }
  }

  recoverStaleLock() {
    const status = this.actionLock.getStatus()
    const lock = status.locks?.[LOCK_TYPES.MOVEMENT]
    if (!lock?.lockedAt) return null
    if (this.now() - lock.lockedAt < this.staleMs) return null
    const released = this.actionLock.forceRelease(LOCK_TYPES.MOVEMENT, 'stale_movement_lock')
    this.log(`[movement-lock] stale owner=${lock.owner} ageMs=${this.now() - lock.lockedAt} result=${released.released ? 'released' : released.reason}`)
    return { previousOwner: lock.owner, released: released.released === true }
  }

  status() {
    return this.actionLock.getStatus().locks?.[LOCK_TYPES.MOVEMENT] || null
  }

  log(message) {
    if (this.logger?.log) this.logger.log(message)
  }
}

module.exports = {
  MovementLock
}
