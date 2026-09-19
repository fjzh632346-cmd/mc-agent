const { toBlockPos } = require('../utils/position')

function ok(message = 'done', data = {}) {
  return { ok: true, message, data }
}

function fail(error, data = {}) {
  return { ok: false, error: String(error), ...data }
}

function getActionOwner(context = {}, actionName = 'action', options = {}) {
  return options.owner ||
    context.task?.id ||
    context.currentTask?.id ||
    context.taskManager?.currentTask?.id ||
    `action:${actionName}`
}

function acquireActionLocks(context = {}, locks = [], actionName = 'action', options = {}) {
  if (!locks.length || !context.actionLock) {
    return { ok: true, owner: getActionOwner(context, actionName, options), locks: [] }
  }

  const owner = getActionOwner(context, actionName, options)
  const result = context.actionLock.acquireMany(locks, owner, {
    reason: options.reason || actionName,
    timeoutMs: options.lockTimeoutMs
  })

  if (!result.ok) {
    logActionLock(context, `acquire type=${locks.join(',')} owner=${owner} result=${result.reason || 'lock_unavailable'} currentOwner=${result.currentOwner || 'none'}`)
    return {
      ok: false,
      error: result.reason || 'lock_unavailable',
      type: result.type,
      currentOwner: result.currentOwner,
      owner
    }
  }

  logActionLock(context, `acquire type=${locks.join(',')} owner=${owner} result=ok`)
  return { ok: true, owner, locks }
}

function releaseActionLocks(context = {}, owner) {
  if (!context.actionLock || owner == null) return
  const result = context.actionLock.releaseAll(owner)
  logActionLock(context, `release type=${(result.released || []).join(',') || 'none'} owner=${owner} result=${result.ok ? 'ok' : result.reason || 'failed'}`)
}

function logActionLock(context, message) {
  const line = `[action-lock] ${message}`
  if (context?.logger?.log) context.logger.log(line)
  else if (context?.debug) context.debug(line)
}

function normalizePosition(position) {
  if (!position) return null
  if (
    typeof position.x !== 'number' ||
    typeof position.y !== 'number' ||
    typeof position.z !== 'number'
  ) {
    return toBlockPos(position)
  }
  return position
}

function distance(a, b) {
  if (!a || !b) return Infinity
  if (typeof a.distanceTo === 'function') return a.distanceTo(b)
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  acquireActionLocks,
  distance,
  fail,
  getActionOwner,
  logActionLock,
  normalizePosition,
  ok,
  releaseActionLocks,
  sleep
}
