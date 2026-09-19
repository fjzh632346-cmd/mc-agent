const LEGACY_ESCAPE_OWNER = 'legacy_escape'

function claimLegacyEscapeMovement(taskSystem, actionLock) {
  const currentTask = taskSystem?.currentTask || null
  const buildingOwner = safeLockOwner(actionLock, 'building')
  if (currentTask || buildingOwner != null) {
    return {
      ok: false,
      reason: currentTask ? 'managed_task_active' : 'building_lock_active',
      taskId: currentTask?.id ?? null,
      taskType: currentTask?.type || null,
      buildingOwner,
      movementOwner: safeLockOwner(actionLock, 'movement')
    }
  }

  if (typeof actionLock?.acquire !== 'function') {
    return { ok: true, owner: null, acquired: false }
  }

  const acquired = actionLock.acquire('movement', LEGACY_ESCAPE_OWNER, {
    reason: 'critical_health_legacy_escape'
  })
  if (!acquired.ok) {
    return {
      ok: false,
      reason: acquired.reason || 'movement_lock_unavailable',
      taskId: null,
      taskType: null,
      buildingOwner,
      movementOwner: acquired.currentOwner ?? safeLockOwner(actionLock, 'movement')
    }
  }
  return { ok: true, owner: LEGACY_ESCAPE_OWNER, acquired: true }
}

function releaseLegacyEscapeMovement(actionLock, claim) {
  if (!claim?.acquired || !claim.owner || typeof actionLock?.release !== 'function') {
    return { ok: true, released: false, reason: 'legacy_escape_lock_not_acquired' }
  }
  return actionLock.release('movement', claim.owner)
}

function safeLockOwner(actionLock, type) {
  if (typeof actionLock?.getOwner !== 'function') return null
  try {
    return actionLock.getOwner(type)
  } catch {
    return null
  }
}

module.exports = {
  LEGACY_ESCAPE_OWNER,
  claimLegacyEscapeMovement,
  releaseLegacyEscapeMovement
}
