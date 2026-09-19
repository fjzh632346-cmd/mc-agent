const LOCK_TYPES = Object.freeze({
  MOVEMENT: 'movement',
  COMBAT: 'combat',
  INVENTORY: 'inventory',
  DIGGING: 'digging',
  BUILDING: 'building',
  CRAFTING: 'crafting'
})

const SUPPORTED_LOCK_TYPES = new Set(Object.values(LOCK_TYPES))

// 一个 owner 走到终态之后，它名下的锁就该封死。
//
// 修缮 15 的病：回家任务被续建命令打断，任务已经 INTERRUPTED、锁也放了，
// 但它那条还在 await 里的脱困链继续往下跑，又拿同一个 owner 把 movement
// 锁了回来——这一次没有任何人会再放它，因为放锁的那几个终态方法早跑完了。
// 之后每一条建造命令都撞 lock_already_held currentOwner=<那个死任务>，
// 只有重启进程才能恢复。
//
// 所以锁自己记一笔「这个 owner 已经死了」：终态时回收它名下所有锁，
// 之后它再来 acquire 一律拒绝（owner_terminated）。任务被恢复时清掉这一笔。
const DEFAULT_TERMINATED_OWNER_LIMIT = 256

class ActionLock {
  constructor({ now = () => Date.now(), terminatedOwnerLimit = DEFAULT_TERMINATED_OWNER_LIMIT } = {}) {
    this.locks = new Map()
    this.now = now
    // owner -> { reason, at }。插入序即淘汰序，超上限丢最老的一条。
    this.terminatedOwners = new Map()
    this.terminatedOwnerLimit = Number(terminatedOwnerLimit) > 0
      ? Number(terminatedOwnerLimit)
      : DEFAULT_TERMINATED_OWNER_LIMIT
  }

  // 任务进终态时调用：先把它名下的锁收回来（兜底，正常路径上终态方法已经放过一遍），
  // 再把它记成死 owner。返回 reclaimed 让调用方决定要不要打日志。
  markOwnerTerminated(owner, reason = 'task_terminal') {
    if (owner == null || owner === '') {
      return { ok: false, reason: 'missing_owner', owner, reclaimed: [] }
    }

    const reclaimed = this.releaseAll(owner).released || []
    this.terminatedOwners.delete(owner)
    this.terminatedOwners.set(owner, { reason: String(reason), at: this.now() })
    while (this.terminatedOwners.size > this.terminatedOwnerLimit) {
      const oldest = this.terminatedOwners.keys().next().value
      this.terminatedOwners.delete(oldest)
    }

    return { ok: true, owner, reason: String(reason), reclaimed }
  }

  // 任务被恢复（PAUSED / INTERRUPTED 重新跑起来）时调用，把那一笔抹掉。
  clearOwnerTerminated(owner) {
    if (owner == null || owner === '') {
      return { ok: false, reason: 'missing_owner', owner, cleared: false }
    }
    return { ok: true, owner, cleared: this.terminatedOwners.delete(owner) }
  }

  isOwnerTerminated(owner) {
    if (owner == null || owner === '') return false
    return this.terminatedOwners.has(owner)
  }

  acquire(type, owner, options = {}) {
    const invalid = this.validate(type, owner)
    if (invalid) return invalid

    const terminated = this.terminatedOwners.get(owner)
    if (terminated) {
      return {
        ok: false,
        reason: 'owner_terminated',
        type,
        owner,
        terminatedReason: terminated.reason,
        terminatedAgeMs: this.now() - terminated.at
      }
    }

    this.cleanupExpired()

    const current = this.locks.get(type)
    if (current && current.owner !== owner) {
      return {
        ok: false,
        reason: 'lock_already_held',
        type,
        owner,
        currentOwner: current.owner,
        lock: { ...current }
      }
    }

    const lockedAt = current?.lockedAt || this.now()
    const timeoutMs = options.timeoutMs ?? options.timeout ?? current?.timeoutMs ?? null
    const lock = {
      type,
      owner,
      lockedAt,
      reason: options.reason ?? current?.reason ?? null,
      timeoutMs,
      expiresAt: timeoutMs ? lockedAt + timeoutMs : null
    }

    this.locks.set(type, lock)
    return {
      ok: true,
      type,
      owner,
      alreadyHeld: Boolean(current),
      lock: { ...lock }
    }
  }

  acquireMany(types, owner, options = {}) {
    const acquired = []

    for (const type of types) {
      const result = this.acquire(type, owner, options)
      if (!result.ok) {
        for (const acquiredType of acquired) {
          this.release(acquiredType, owner)
        }
        return {
          ...result,
          acquired,
          reason: result.reason || 'lock_acquire_failed'
        }
      }
      acquired.push(type)
    }

    return { ok: true, owner, types: acquired }
  }

  release(type, owner) {
    const invalid = this.validate(type, owner)
    if (invalid) return invalid

    this.cleanupExpired()

    const current = this.locks.get(type)
    if (!current) {
      return { ok: true, released: false, reason: 'not_locked', type, owner }
    }
    if (current.owner !== owner) {
      return {
        ok: false,
        released: false,
        reason: 'owner_mismatch',
        type,
        owner,
        currentOwner: current.owner
      }
    }

    this.locks.delete(type)
    return { ok: true, released: true, type, owner }
  }

  releaseAll(owner) {
    if (owner == null || owner === '') {
      return { ok: false, reason: 'missing_owner', owner, released: [] }
    }

    this.cleanupExpired()

    const released = []
    for (const [type, lock] of this.locks.entries()) {
      if (lock.owner === owner) {
        this.locks.delete(type)
        released.push(type)
      }
    }

    return { ok: true, owner, released }
  }

  releaseOwner(owner) {
    return this.releaseAll(owner)
  }

  forceRelease(type, reason = 'force_release') {
    if (!SUPPORTED_LOCK_TYPES.has(type)) {
      return { ok: false, reason: 'unsupported_lock_type', type }
    }

    this.cleanupExpired()

    const current = this.locks.get(type)
    if (!current) return { ok: true, released: false, reason: 'not_locked', type }

    this.locks.delete(type)
    return { ok: true, released: true, reason, type, previous: { ...current } }
  }

  isLocked(type) {
    if (!SUPPORTED_LOCK_TYPES.has(type)) return false
    this.cleanupExpired()
    return this.locks.has(type)
  }

  getOwner(type) {
    if (!SUPPORTED_LOCK_TYPES.has(type)) return null
    this.cleanupExpired()
    return this.locks.get(type)?.owner ?? null
  }

  getStatus() {
    this.cleanupExpired()

    const locks = {}
    for (const type of SUPPORTED_LOCK_TYPES) {
      const lock = this.locks.get(type)
      locks[type] = lock ? { ...lock } : null
    }

    return {
      supportedTypes: [...SUPPORTED_LOCK_TYPES],
      locks
    }
  }

  snapshot() {
    return this.getStatus()
  }

  cleanupExpired() {
    const now = this.now()
    for (const [type, lock] of this.locks.entries()) {
      if (lock.expiresAt && lock.expiresAt <= now) {
        this.locks.delete(type)
      }
    }
  }

  validate(type, owner) {
    if (!SUPPORTED_LOCK_TYPES.has(type)) {
      return { ok: false, reason: 'unsupported_lock_type', type, owner }
    }
    if (owner == null || owner === '') {
      return { ok: false, reason: 'missing_owner', type, owner }
    }
    return null
  }
}

module.exports = {
  ActionLock,
  LOCK_TYPES,
  SUPPORTED_LOCK_TYPES
}
