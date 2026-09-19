const {
  BLUEPRINT_IR_SCHEMA_VERSION,
  calculateBlueprintBounds,
  clonePlainObject,
  createDiagnostic,
  isAirBlockId,
  normalizeClearancePolicy,
  normalizeMaterialAlternatives,
  normalizePhase,
  normalizePoint,
  positionKey,
  sanitizeMetadata
} = require('./blueprint-ir')

class LegacyBlueprintAdapter {
  fromLegacyBlueprint(blueprint, options = {}) {
    const diagnostics = []
    if (!blueprint || typeof blueprint !== 'object') {
      return fail(diagnostics, 'legacy_blueprint_not_object')
    }
    if (!Array.isArray(blueprint.blocks)) {
      return fail(diagnostics, 'legacy_blueprint_missing_blocks')
    }

    const origin = normalizePoint(blueprint.origin, { x: 0, y: 0, z: 0 })
    const blocks = blueprint.blocks.map((block, index) => normalizeLegacyBlock(block, index, origin))
    const keyByPosition = new Map()
    const blockByKey = new Map()
    for (const block of blocks) {
      keyByPosition.set(positionKey(block.position), block.key)
      blockByKey.set(block.key, block)
    }

    const normalizedBlocks = blocks.map((block, index) => ({
      ...block,
      dependencies: normalizeDependencies(
        blueprint.blocks[index]?.dependencies,
        block,
        keyByPosition,
        blockByKey
      )
    }))

    const ir = {
      schemaVersion: BLUEPRINT_IR_SCHEMA_VERSION,
      id: String(options.id || blueprint.id || blueprint.name || 'legacy_blueprint'),
      name: String(blueprint.name || options.name || 'legacy_blueprint'),
      bounds: calculateBlueprintBounds(normalizedBlocks),
      blocks: normalizedBlocks,
      metadata: sanitizeMetadata(blueprint.metadata || {}, {
        sourceFormat: blueprint.metadata?.sourceFormat || 'legacy_blueprint',
        legacyBlueprintName: blueprint.name || null,
        compatibilityAdapter: 'LegacyBlueprintAdapter'
      })
    }

    return {
      ok: true,
      blueprint: ir,
      diagnostics
    }
  }
}

function normalizeLegacyBlock(block = {}, index, origin) {
  const position = normalizePoint({
    x: Number(block.x) - origin.x,
    y: Number(block.y) - origin.y,
    z: Number(block.z) - origin.z
  }, { x: 0, y: 0, z: 0 })
  const blockId = String(block.block?.id || block.id || block.type || block.name || 'air')
  const key = String(block.key || `b${String(index).padStart(5, '0')}_${positionKey(position)}`)
  const states = block.block?.states || block.states || block.orientation || {}
  const nbt = block.block?.nbt || block.nbt || null

  return {
    key,
    position,
    block: {
      id: blockId,
      states: clonePlainObject(states) || {},
      nbt: clonePlainObject(nbt) || null
    },
    role: block.role || null,
    phase: normalizePhase(block.phase, block.role, blockId),
    dependencies: [],
    materialAlternatives: normalizeMaterialAlternatives(block.materialAlternatives, blockId),
    clearancePolicy: normalizeClearancePolicy(block.clearancePolicy, blockId),
    optional: block.optional === true
  }
}

function normalizeDependencies(rawDependencies, block, keyByPosition, blockByKey) {
  const explicit = Array.isArray(rawDependencies)
    ? rawDependencies.map(String).filter(Boolean)
    : null
  const dependencies = explicit || inferDependencies(block, keyByPosition, blockByKey)
  return [...new Set(dependencies)].filter(key => key && key !== block.key)
}

function inferDependencies(block, keyByPosition, blockByKey) {
  if (!block || isAirBlockId(block.block?.id)) return []
  const dependencies = []
  const position = block.position
  const sideOffsets = requiredSideAttachmentOffsets(block.block?.id, block.block?.states)
  for (const offset of sideOffsets) {
    const supportKey = keyByPosition.get(positionKey({
      x: position.x + offset.x,
      y: position.y + offset.y,
      z: position.z + offset.z
    }))
    if (supportKey && !isAirBlockId(blockByKey.get(supportKey)?.block?.id)) dependencies.push(supportKey)
  }

  if (isDoorBlock(block.block?.id) && String(block.block?.states?.half || '').toLowerCase() === 'upper') {
    const lowerKey = keyByPosition.get(positionKey({ x: position.x, y: position.y - 1, z: position.z }))
    if (lowerKey) dependencies.push(lowerKey)
  }

  if (isBedBlock(block.block?.id) && String(block.block?.states?.part || '').toLowerCase() === 'head') {
    // Vanilla bed facing points foot -> head; placing the foot creates the
    // head, so the head block must be scheduled after the foot block.
    const facing = horizontalOffsetForBedFacing(block.block?.states?.facing)
    if (facing) {
      const footKey = keyByPosition.get(positionKey({
        x: position.x - facing.x,
        y: position.y,
        z: position.z - facing.z
      }))
      if (footKey) dependencies.push(footKey)
    }
  }

  return dependencies
}

function horizontalOffsetForBedFacing(facing) {
  const value = String(facing || '').toLowerCase()
  if (value === 'east') return { x: 1, z: 0 }
  if (value === 'west') return { x: -1, z: 0 }
  if (value === 'south') return { x: 0, z: 1 }
  if (value === 'north') return { x: 0, z: -1 }
  return null
}

function isBedBlock(blockId) {
  return /(^|_)bed$/.test(String(blockId || ''))
}

function requiredSideAttachmentOffsets(blockId, states = {}) {
  if (!isSideAttachedBlock(blockId)) return []
  const facing = String(states?.facing || '').toLowerCase()
  if (facing === 'west') return [{ x: 1, y: 0, z: 0 }]
  if (facing === 'east') return [{ x: -1, y: 0, z: 0 }]
  if (facing === 'north') return [{ x: 0, y: 0, z: 1 }]
  if (facing === 'south') return [{ x: 0, y: 0, z: -1 }]
  return []
}

function isSideAttachedBlock(blockId) {
  const value = String(blockId || '')
  return value === 'ladder' ||
    value === 'tripwire_hook' ||
    value.endsWith('_wall_sign') ||
    value.endsWith('_wall_banner') ||
    value.endsWith('_wall_torch')
}

function isDoorBlock(blockId) {
  const value = String(blockId || '')
  return /(^|_)door$/.test(value)
}

function fail(diagnostics, code) {
  diagnostics.push(createDiagnostic('error', code, 'blueprint', code))
  return { ok: false, error: code, diagnostics }
}

module.exports = {
  LegacyBlueprintAdapter
}
