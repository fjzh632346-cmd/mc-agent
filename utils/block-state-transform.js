const HORIZONTAL_FACING_VECTORS = Object.freeze({
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 }
})

const FACING_BY_VECTOR = new Map(
  Object.entries(HORIZONTAL_FACING_VECTORS)
    .map(([facing, vector]) => [`${vector.x},${vector.z}`, facing])
)

function transformHorizontalBlockState(blockState = {}, transform = {}) {
  const states = transformHorizontalStates(
    blockState.states || blockState.Properties || {},
    transform
  )
  return {
    ...blockState,
    states,
    Properties: states
  }
}

function transformHorizontalStates(states = {}, transform = {}) {
  const normalized = normalizeHorizontalTransform(transform)
  const transformed = { ...(states || {}) }
  if (transformed.facing != null) {
    transformed.facing = transformHorizontalFacing(transformed.facing, normalized)
  }

  const mirroredAxisCount = Number(normalized.mirrorX) + Number(normalized.mirrorZ)
  if (mirroredAxisCount % 2 === 1 && transformed.shape != null) {
    transformed.shape = swapLeftRightState(transformed.shape)
  }
  if (mirroredAxisCount % 2 === 1 && transformed.hinge != null) {
    transformed.hinge = swapLeftRightState(transformed.hinge)
  }
  return transformed
}

function transformHorizontalFacing(facing, transform = {}) {
  const normalized = normalizeHorizontalTransform(transform)
  const source = HORIZONTAL_FACING_VECTORS[String(facing || '').toLowerCase()]
  if (!source) return String(facing || '').toLowerCase()

  let x = normalized.mirrorX ? -source.x : source.x
  let z = normalized.mirrorZ ? -source.z : source.z
  if (normalized.rotationY === 90) {
    const nextX = -z
    z = x
    x = nextX
  } else if (normalized.rotationY === 180) {
    x = -x
    z = -z
  } else if (normalized.rotationY === 270) {
    const nextX = z
    z = -x
    x = nextX
  }
  return FACING_BY_VECTOR.get(`${x},${z}`) || String(facing || '').toLowerCase()
}

function normalizeHorizontalTransform(transform = {}) {
  const rotation = Number(transform.rotationY ?? transform.rotation ?? 0)
  const rotationY = ((Math.round(rotation) % 360) + 360) % 360
  return {
    rotationY: [0, 90, 180, 270].includes(rotationY) ? rotationY : 0,
    mirrorX: transform.mirrorX === true || transform.mirror?.x === true,
    mirrorZ: transform.mirrorZ === true || transform.mirror?.z === true
  }
}

function swapLeftRightState(value) {
  const text = String(value || '').toLowerCase()
  if (text.includes('left')) return text.replace('left', 'right')
  if (text.includes('right')) return text.replace('right', 'left')
  return value
}

function isButtonBlockName(blockName) {
  return /(^|_)button$/.test(String(blockName || ''))
}

function isFenceGateBlockName(blockName) {
  return /_fence_gate$/.test(String(blockName || ''))
}

module.exports = {
  isButtonBlockName,
  isFenceGateBlockName,
  normalizeHorizontalTransform,
  transformHorizontalBlockState,
  transformHorizontalFacing,
  transformHorizontalStates
}
