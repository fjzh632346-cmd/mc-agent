const { Vec3 } = require('vec3')

function toBlockPos(pos) {
  if (!pos) return null

  if (typeof pos.floored === 'function') {
    const p = pos.floored()
    return { x: p.x, y: p.y, z: p.z }
  }

  if (typeof pos.floor === 'function') {
    const p = pos.floor()
    return { x: p.x, y: p.y, z: p.z }
  }

  if (
    typeof pos.x === 'number' &&
    typeof pos.y === 'number' &&
    typeof pos.z === 'number'
  ) {
    return {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z)
    }
  }

  return null
}

function toBlockVec3(pos) {
  const blockPos = toBlockPos(pos)
  if (!blockPos) return null
  return new Vec3(blockPos.x, blockPos.y, blockPos.z)
}

module.exports = {
  toBlockPos,
  toBlockVec3
}
