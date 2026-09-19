class FeedbackCooldown {
  constructor(options = {}) {
    this.options = {
      defaultCooldownMs: 5000,
      minCooldownMs: 2000,
      ...options
    }
    // Wall clock by default. A caller may inject one instead: a cooldown of a
    // millisecond or two is decided by how long the two calls happened to take,
    // which is a coin flip on a loaded machine rather than a test (the building
    // lane's round 10 opened on exactly that red, green again on a re-run).
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this._lastEmitted = new Map()
    this._suppressCount = new Map()
  }

  canEmit(key, customCooldownMs = null) {
    const now = this._now()
    const cooldownMs = customCooldownMs ?? this.options.defaultCooldownMs
    const last = this._lastEmitted.get(key) || 0
    if (now - last < cooldownMs) {
      this._suppressCount.set(key, (this._suppressCount.get(key) || 0) + 1)
      return false
    }
    this._lastEmitted.set(key, now)
    this._suppressCount.delete(key)
    return true
  }

  emit(key, emitFn, customCooldownMs = null) {
    if (!this.canEmit(key, customCooldownMs)) return null
    if (typeof emitFn === 'function') {
      try { return emitFn() } catch { return null }
    }
    return null
  }

  getSuppressedCount(key) {
    return this._suppressCount.get(key) || 0
  }

  reset(key) {
    this._lastEmitted.delete(key)
    this._suppressCount.delete(key)
  }

  resetAll() {
    this._lastEmitted.clear()
    this._suppressCount.clear()
  }

  status() {
    const now = this._now()
    const entries = {}
    for (const [key, last] of this._lastEmitted.entries()) {
      entries[key] = {
        lastEmittedMs: now - last,
        suppressed: this._suppressCount.get(key) || 0
      }
    }
    return entries
  }
}

module.exports = { FeedbackCooldown }
