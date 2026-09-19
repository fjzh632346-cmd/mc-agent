const {
  BLUEPRINT_IR_SCHEMA_VERSION,
  BLUEPRINT_PHASES,
  CLEARANCE_POLICIES,
  calculateBlueprintBounds,
  clonePlainObject,
  createDiagnostic,
  deepFreeze,
  isAirBlockId,
  positionKey
} = require('./blueprint-ir')

class BlueprintValidator {
  validate(blueprint, options = {}) {
    const diagnostics = []
    validateSchema(blueprint, diagnostics)

    if (blueprint?.blocks && Array.isArray(blueprint.blocks)) {
      validateBlocks(blueprint.blocks, diagnostics)
      validateBounds(blueprint, diagnostics)
      validateDependencies(blueprint.blocks, diagnostics)
      validateCompatibilityRules(blueprint.blocks, diagnostics)
    }

    const ok = diagnostics.every(diagnostic => diagnostic.severity !== 'error')
    return {
      ok,
      blueprint: ok
        ? (options.freeze === false ? clonePlainObject(blueprint) : deepFreeze(clonePlainObject(blueprint)))
        : null,
      diagnostics
    }
  }
}

function validateSchema(blueprint, diagnostics) {
  if (!blueprint || typeof blueprint !== 'object') {
    diagnostics.push(error('blueprint_not_object', 'blueprint', 'BlueprintIR must be an object'))
    return
  }
  if (blueprint.schemaVersion !== BLUEPRINT_IR_SCHEMA_VERSION) {
    diagnostics.push(error('unsupported_schema_version', 'schemaVersion', 'BlueprintIR schemaVersion must be 1'))
  }
  if (!blueprint.id || typeof blueprint.id !== 'string') {
    diagnostics.push(error('missing_id', 'id', 'BlueprintIR id must be a non-empty string'))
  }
  if (!blueprint.name || typeof blueprint.name !== 'string') {
    diagnostics.push(error('missing_name', 'name', 'BlueprintIR name must be a non-empty string'))
  }
  if (!blueprint.bounds || typeof blueprint.bounds !== 'object') {
    diagnostics.push(error('missing_bounds', 'bounds', 'BlueprintIR bounds are required'))
  }
  if (!Array.isArray(blueprint.blocks) || blueprint.blocks.length === 0) {
    diagnostics.push(error('missing_blocks', 'blocks', 'BlueprintIR blocks must be a non-empty array'))
  }
}

function validateBlocks(blocks, diagnostics) {
  const keys = new Set()
  const positions = new Map()
  blocks.forEach((block, index) => {
    const path = `blocks.${index}`
    if (!block || typeof block !== 'object') {
      diagnostics.push(error('block_not_object', path, 'BlueprintIR block must be an object'))
      return
    }
    if (!block.key || typeof block.key !== 'string') {
      diagnostics.push(error('missing_block_key', `${path}.key`, 'Block key must be a non-empty string'))
    } else if (keys.has(block.key)) {
      diagnostics.push(error('duplicate_block_key', `${path}.key`, `Duplicate block key: ${block.key}`))
    } else {
      keys.add(block.key)
    }

    if (!isIntegerPosition(block.position)) {
      diagnostics.push(error('bad_position', `${path}.position`, 'Block position must contain integer x/y/z coordinates'))
    } else {
      const key = positionKey(block.position)
      if (positions.has(key)) {
        diagnostics.push(error('duplicate_position', `${path}.position`, `Duplicate block position: ${key}`))
      } else {
        positions.set(key, block.key)
      }
    }

    const blockId = block.block?.id
    if (!blockId || typeof blockId !== 'string' || !/^[a-z0-9_]+$/.test(blockId)) {
      diagnostics.push(error('bad_block_id', `${path}.block.id`, 'Block id must be a namespaced-safe lowercase id'))
    }
    if (block.block?.states !== undefined && !isPlainObject(block.block.states)) {
      diagnostics.push(error('bad_block_states', `${path}.block.states`, 'Block states must be an object'))
    }
    if (!BLUEPRINT_PHASES.includes(block.phase)) {
      diagnostics.push(error('bad_phase', `${path}.phase`, `Block phase must be one of ${BLUEPRINT_PHASES.join(', ')}`))
    }
    if (!Array.isArray(block.dependencies)) {
      diagnostics.push(error('bad_dependencies', `${path}.dependencies`, 'Block dependencies must be an explicit array'))
    } else if (block.dependencies.some(dep => typeof dep !== 'string' || !dep)) {
      diagnostics.push(error('bad_dependency_key', `${path}.dependencies`, 'Dependencies must contain non-empty block keys'))
    }
    if (!Array.isArray(block.materialAlternatives)) {
      diagnostics.push(error('bad_material_alternatives', `${path}.materialAlternatives`, 'Material alternatives must be an ordered array'))
    } else if (!isAirBlockId(blockId) && block.materialAlternatives.length === 0) {
      diagnostics.push(error('missing_material_alternatives', `${path}.materialAlternatives`, 'Non-air blocks need at least one material alternative'))
    }
    if (!CLEARANCE_POLICIES.includes(block.clearancePolicy)) {
      diagnostics.push(error('bad_clearance_policy', `${path}.clearancePolicy`, `clearancePolicy must be one of ${CLEARANCE_POLICIES.join(', ')}`))
    }
    if (typeof block.optional !== 'boolean') {
      diagnostics.push(error('bad_optional', `${path}.optional`, 'optional must be boolean'))
    }
  })
}

function validateBounds(blueprint, diagnostics) {
  const expected = calculateBlueprintBounds(blueprint.blocks)
  if (!sameBounds(expected, blueprint.bounds)) {
    diagnostics.push(error('bounds_mismatch', 'bounds', 'BlueprintIR bounds must match block positions', {
      expected,
      actual: blueprint.bounds
    }))
  }
}

function validateDependencies(blocks, diagnostics) {
  const keys = new Set(blocks.map(block => block.key))
  for (const [index, block] of blocks.entries()) {
    for (const dependency of block.dependencies || []) {
      if (!keys.has(dependency)) {
        diagnostics.push(error('missing_dependency', `blocks.${index}.dependencies`, `Missing dependency ${dependency}`, {
          blockKey: block.key,
          dependency
        }))
      }
    }
  }

  const graph = new Map(blocks.map(block => [block.key, block.dependencies || []]))
  const visiting = new Set()
  const visited = new Set()
  const stack = []
  for (const key of graph.keys()) {
    visitDependency(key, graph, visiting, visited, stack, diagnostics)
  }
}

function visitDependency(key, graph, visiting, visited, stack, diagnostics) {
  if (visited.has(key)) return
  if (visiting.has(key)) {
    const cycleStart = stack.indexOf(key)
    const cycle = cycleStart >= 0 ? stack.slice(cycleStart).concat(key) : [key]
    diagnostics.push(error('cyclic_dependency', 'blocks.dependencies', `Cyclic dependency detected: ${cycle.join(' -> ')}`, { cycle }))
    return
  }

  visiting.add(key)
  stack.push(key)
  for (const dependency of graph.get(key) || []) {
    if (graph.has(dependency)) visitDependency(dependency, graph, visiting, visited, stack, diagnostics)
  }
  stack.pop()
  visiting.delete(key)
  visited.add(key)
}

function validateCompatibilityRules(blocks, diagnostics) {
  const keyByPosition = new Map(blocks.map(block => [positionKey(block.position), block.key]))
  for (const [index, block] of blocks.entries()) {
    const blockId = block.block?.id
    if (isDoorBlock(blockId) && String(block.block?.states?.half || '').toLowerCase() === 'upper') {
      const lower = keyByPosition.get(positionKey({
        x: block.position.x,
        y: block.position.y - 1,
        z: block.position.z
      }))
      if (!lower) {
        diagnostics.push(createDiagnostic('warning', 'door_upper_without_lower_entry', `blocks.${index}`, 'Upper door block has no lower-door compatibility entry'))
      }
    }
  }
}

function isIntegerPosition(position) {
  return position &&
    Number.isInteger(position.x) &&
    Number.isInteger(position.y) &&
    Number.isInteger(position.z)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameBounds(a, b) {
  return a && b &&
    samePoint(a.min, b.min) &&
    samePoint(a.max, b.max) &&
    samePoint(a.size, b.size)
}

function samePoint(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z
}

function isDoorBlock(blockId) {
  return /(^|_)door$/.test(String(blockId || ''))
}

function error(code, path, message, details = null) {
  return createDiagnostic('error', code, path, message, details)
}

module.exports = {
  BlueprintValidator
}
