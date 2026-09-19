function distanceScaledMoveTimeout(start, target, options = {}) {
  const minimumMs = Math.max(1, Number(options.minimumMs ?? 15000))
  const maximumMs = Math.max(minimumMs, Number(options.maximumMs ?? 60000))
  const baseMs = Math.max(0, Number(options.baseMs ?? 10000))
  const perBlockMs = Math.max(0, Number(options.perBlockMs ?? 1000))
  const distance = positionDistance(start, target)
  if (!Number.isFinite(distance)) return minimumMs
  return Math.min(maximumMs, Math.max(minimumMs, Math.ceil(baseMs + distance * perBlockMs)))
}

function positionDistance(a, b) {
  if (![a?.x, a?.y, a?.z, b?.x, b?.y, b?.z].every(Number.isFinite)) return null
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

function localEscapeWaypoints(start, target, options = {}) {
  if (![start?.x, start?.y, start?.z].every(Number.isFinite)) return []
  const offset = Math.max(2, Number(options.offset ?? 4))
  const center = {
    x: Math.floor(start.x) + 0.5,
    y: Math.floor(start.y),
    z: Math.floor(start.z) + 0.5
  }
  const candidates = [
    { x: center.x + offset, y: center.y, z: center.z },
    { x: center.x - offset, y: center.y, z: center.z },
    { x: center.x, y: center.y, z: center.z + offset },
    { x: center.x, y: center.y, z: center.z - offset }
  ]
  if (![target?.x, target?.y, target?.z].every(Number.isFinite)) return candidates
  return candidates
    .map((position, index) => ({ position, index, targetDistance: positionDistance(position, target) }))
    .sort((a, b) => (b.targetDistance - a.targetDistance) || (a.index - b.index))
    .map(entry => entry.position)
}

// Same-level waypoints cannot help when the target sits further below her
// than the pathfinder is willing to drop: round 11 watched her shuffle four
// blocks sideways on a tower top and fail the same way again. When the
// target is that far down, offer LEDGES instead: cells around her, one to
// maxFall levels lower and up to `offset` blocks out, each reachable by a
// legal drop, so the walk can descend in legs. Nearest the target level
// first, then closest to the target; the caller keeps the ones that are
// actually standable.
//
// maxFall counts the blocks her FEET fall. Upstream maxDropDown (default 4)
// is measured from her feet to the top of the landing block, so it allows
// a fall of maxDropDown - 1 = 3; callers convert (see actions/storage.js).
function descendingEscapeWaypoints(start, target, options = {}) {
  if (![start?.x, start?.y, start?.z, target?.x, target?.y, target?.z].every(Number.isFinite)) return []
  const maxFall = Math.max(1, Math.floor(Number(options.maxFall ?? 3)))
  const offset = Math.max(1, Math.floor(Number(options.offset ?? 4)))
  const startY = Math.floor(start.y)
  const drop = startY - Math.floor(target.y)
  if (drop <= maxFall) return []
  const center = { x: Math.floor(start.x) + 0.5, z: Math.floor(start.z) + 0.5 }
  const candidates = []
  for (let level = 1; level <= maxFall; level++) {
    const y = startY - level
    if (y < Math.floor(target.y)) break
    for (let step = 1; step <= offset; step++) {
      candidates.push(
        { x: center.x + step, y, z: center.z },
        { x: center.x - step, y, z: center.z },
        { x: center.x, y, z: center.z + step },
        { x: center.x, y, z: center.z - step }
      )
    }
  }
  return candidates
    .map((position, index) => ({ position, index, targetDistance: positionDistance(position, target) }))
    .sort((a, b) => (a.position.y - b.position.y) || (a.targetDistance - b.targetDistance) || (a.index - b.index))
    .map(entry => entry.position)
}

// How far (in blocks her feet fall) she may deliberately drop with the
// health she has: vanilla fall damage is (distance - 3) HP, and she keeps at
// least 3 hearts in reserve. Never more than 8 blocks, never less than the
// fall the pathfinder already allows (3 with the default maxDropDown of 4).
function safeDropDownForHealth(health, options = {}) {
  const defaultDrop = Math.max(1, Math.floor(Number(options.defaultDrop ?? 3)))
  const maximumDrop = Math.max(defaultDrop, Math.floor(Number(options.maximumDrop ?? 8)))
  const reserveHp = Math.max(0, Number(options.reserveHp ?? 6))
  const hp = Number(health)
  if (!Number.isFinite(hp)) return defaultDrop
  const affordable = 3 + Math.floor(hp - reserveHp)
  return Math.max(defaultDrop, Math.min(maximumDrop, affordable))
}

module.exports = {
  descendingEscapeWaypoints,
  distanceScaledMoveTimeout,
  localEscapeWaypoints,
  positionDistance,
  safeDropDownForHealth
}
