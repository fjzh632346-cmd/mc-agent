const TERRAIN_MATERIALS = Object.freeze([
  'grass_block',
  'dirt',
  'podzol',
  'moss_block',
  'coarse_dirt',
  'rooted_dirt',
  'mycelium'
])

const TERRAIN_ALTERNATIVES = Object.freeze({
  grass_block: ['grass_block', 'dirt', 'podzol', 'moss_block', 'coarse_dirt', 'rooted_dirt'],
  podzol: ['podzol', 'dirt', 'grass_block', 'moss_block', 'coarse_dirt', 'rooted_dirt'],
  moss_block: ['moss_block', 'dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt'],
  dirt: ['dirt', 'grass_block', 'podzol', 'moss_block', 'coarse_dirt', 'rooted_dirt'],
  coarse_dirt: ['coarse_dirt', 'dirt', 'rooted_dirt', 'podzol', 'grass_block', 'moss_block'],
  rooted_dirt: ['rooted_dirt', 'dirt', 'coarse_dirt', 'podzol', 'grass_block', 'moss_block'],
  mycelium: ['mycelium', 'dirt', 'podzol', 'moss_block', 'grass_block']
})

const TERRAIN_ROLES = new Set([
  'terrain',
  'terrain_fill',
  'ground',
  'ground_fill',
  'fill',
  'surface_fill',
  'decorative_ground',
  'landscape',
  'landscaping'
])

const STRUCTURAL_ROLE_PATTERNS = [
  /wall/,
  /beam/,
  /column/,
  /pillar/,
  /post/,
  /floor/,
  /roof/,
  /stair/,
  /slab/,
  /fence/,
  /door/,
  /window/,
  /glass/,
  /trapdoor/,
  /ladder/,
  /chest/,
  /furnace/,
  /table/,
  /lectern/,
  /barrel/,
  /bed/,
  /functional/
]

const STRUCTURAL_BLOCK_PATTERNS = [
  /_log$/,
  /_wood$/,
  /_planks$/,
  /_stairs$/,
  /_slab$/,
  /_fence$/,
  /_fence_gate$/,
  /_door$/,
  /_trapdoor$/,
  /glass/,
  /window/,
  /ladder/,
  /chest$/,
  /barrel$/,
  /furnace$/,
  /smoker$/,
  /crafting_table$/,
  /lectern$/,
  /bookshelf$/,
  /bed$/
]

function describeMaterialPolicyForBlock(input = {}) {
  const blockId = input.blockId || blockNameFrom(input)
  const role = normalizeRole(input.role)
  const phase = input.phase || null
  const derivedTerrain = isDerivedTerrainFill(input)
  const effectiveRole = role || (derivedTerrain ? 'terrain_fill' : null)
  const exactRequired = isExactRequired({
    ...input,
    blockId,
    role: effectiveRole
  })
  const materialAlternatives = materialAlternativesFor({
    ...input,
    blockId,
    role: effectiveRole,
    exactRequired
  })

  return {
    role: effectiveRole,
    phase,
    materialAlternatives,
    exactRequired,
    source: input.materialPolicySource || (role
      ? 'blueprint_role'
      : (derivedTerrain ? 'terrain_material_policy:bottom_layer_ground' : 'material_policy:strict_default'))
  }
}

function resolveMaterialSteps(steps = [], counts = {}, options = {}) {
  const remaining = { ...(counts || {}) }
  const runSteps = options.runSteps || {}
  const materialOverrides = normalizeMaterialOverrides(options.materialOverrides || [])
  const futureOriginalDemand = pendingOriginalMaterialDemand(steps, runSteps, options)
  const resolvedSteps = []
  const resolutions = []
  const originalRequired = {}
  const resolvedRequired = {}
  const substitutions = []

  for (const step of steps || []) {
    const cloned = clonePlainObject(step)
    if (!isMaterialPlacementStep(cloned) || (options.skipVerified !== false && isVerified(runSteps[cloned.id]))) {
      resolvedSteps.push(cloned)
      continue
    }

    const originalBlock = originalBlockNameFrom(cloned) || blockNameFrom(cloned)
    if (!originalBlock) {
      resolvedSteps.push(cloned)
      continue
    }

    originalRequired[originalBlock] = (originalRequired[originalBlock] || 0) + 1
    futureOriginalDemand[originalBlock] = Math.max(0, (futureOriginalDemand[originalBlock] || 0) - 1)
    const policy = describeMaterialPolicyForBlock({
      blockId: originalBlock,
      role: cloned.role,
      phase: cloned.phase,
      position: cloned.position || cloned.target,
      bounds: options.bounds,
      materialAlternatives: cloned.materialAlternatives,
      exactRequired: cloned.exactRequired,
      materialPolicySource: cloned.materialPolicySource,
      clearancePolicy: cloned.clearancePolicy
    })
    const override = materialOverrideForStep(cloned, originalBlock, materialOverrides)
    const resolution = override
      ? resolveStepOverride(originalBlock, policy, override)
      : resolveStepMaterial(originalBlock, policy, remaining, futureOriginalDemand)
    const resolvedBlock = resolution.resolvedBlock
    const resolvedItem = resolvedBlock
    const materialAlternatives = resolution.materialAlternatives || policy.materialAlternatives
    const exactRequired = resolution.exactRequired === undefined
      ? policy.exactRequired
      : resolution.exactRequired
    resolvedRequired[resolvedItem] = (resolvedRequired[resolvedItem] || 0) + 1
    if (remaining[resolvedItem] > 0) remaining[resolvedItem] -= 1

    cloned.role = cloned.role || policy.role
    cloned.materialAlternatives = materialAlternatives
    cloned.exactRequired = exactRequired === true
    cloned.originalBlockName = originalBlock
    cloned.resolvedBlockName = resolvedBlock
    cloned.materialResolution = {
      originalBlock,
      resolvedBlock,
      reason: resolution.reason,
      source: resolution.source || policy.source,
      exactRequired: exactRequired === true,
      affectsWorldDiff: resolution.affectsWorldDiff === true || resolvedBlock !== originalBlock,
      role: policy.role,
      originalPhase: cloned.phase || null,
      resolvedPhase: cloned.phase || null,
      materialAlternatives: [...materialAlternatives]
    }
    if (resolution.userApproved === true) cloned.materialResolution.userApproved = true
    if (resolution.scope) cloned.materialResolution.scope = resolution.scope
    if (resolution.sourceStepIds?.length) {
      cloned.materialResolution.sourceStepIds = [...resolution.sourceStepIds]
    }
    if (resolvedBlock !== originalBlock) {
      cloned.blockName = resolvedBlock
      cloned.states = {}
      cloned.orientation = {}
      if (cloned.block) cloned.block = { ...cloned.block, id: resolvedBlock, states: {} }
      substitutions.push({
        stepId: cloned.id || null,
        originalBlock,
        resolvedBlock,
        reason: resolution.reason,
        source: cloned.materialResolution.source,
        userApproved: cloned.materialResolution.userApproved === true,
        scope: cloned.materialResolution.scope || null,
        affectsWorldDiff: cloned.materialResolution.affectsWorldDiff === true,
        sourceStepIds: [...(cloned.materialResolution.sourceStepIds || [])]
      })
    }
    resolutions.push(cloned.materialResolution)
    resolvedSteps.push(cloned)
  }

  return {
    steps: resolvedSteps,
    resolutions,
    originalRequired,
    resolvedRequired,
    substitutions
  }
}

function resolveStepMaterial(originalBlock, policy, remaining, futureOriginalDemand = {}) {
  if (policy.exactRequired === true || !isTerrainRole(policy.role) || !TERRAIN_MATERIALS.includes(originalBlock)) {
    return {
      resolvedBlock: originalBlock,
      reason: policy.exactRequired === true ? 'exact_required' : 'strict_material',
      source: policy.source
    }
  }

  for (const alternative of policy.materialAlternatives || []) {
    const available = remaining[alternative] || 0
    const reservedForOriginal = alternative === originalBlock
      ? 0
      : (futureOriginalDemand[alternative] || 0)
    if (available > reservedForOriginal) {
      return {
        resolvedBlock: alternative,
        reason: alternative === originalBlock ? 'exact_available' : 'terrain_alternative_available',
        source: policy.source
      }
    }
  }

  return {
    resolvedBlock: originalBlock,
    reason: 'no_available_terrain_alternative',
    source: policy.source
  }
}

function pendingOriginalMaterialDemand(steps = [], runSteps = {}, options = {}) {
  const demand = {}
  for (const step of steps || []) {
    if (!isMaterialPlacementStep(step) || (options.skipVerified !== false && isVerified(runSteps[step?.id]))) continue
    const originalBlock = originalBlockNameFrom(step) || blockNameFrom(step)
    if (!originalBlock) continue
    demand[originalBlock] = (demand[originalBlock] || 0) + 1
  }
  return demand
}

function resolveStepOverride(originalBlock, policy, override) {
  const resolvedBlock = override.resolvedBlock
  return {
    resolvedBlock,
    reason: override.reason || 'USER_APPROVED_MATERIAL_SUBSTITUTION',
    source: override.source || 'material_override:current_run',
    exactRequired: false,
    affectsWorldDiff: override.affectsWorldDiff !== false,
    userApproved: override.userApproved === true,
    scope: override.scope || 'currentRun',
    sourceStepIds: [...(override.sourceStepIds || [])],
    materialAlternatives: ensureFirst(uniqueList([
      ...(policy.materialAlternatives || []),
      originalBlock,
      resolvedBlock
    ]), originalBlock)
  }
}

function materialAlternativesFor(input = {}) {
  const blockId = input.blockId || blockNameFrom(input)
  const explicit = uniqueList(input.materialAlternatives || [])
  if (input.exactRequired === true || !isTerrainRole(input.role) || !TERRAIN_MATERIALS.includes(blockId)) {
    return explicit.length ? ensureFirst(explicit, blockId) : [blockId].filter(Boolean)
  }
  return ensureFirst(uniqueList([
    ...explicit,
    ...(TERRAIN_ALTERNATIVES[blockId] || [blockId])
  ]), blockId)
}

function isExactRequired(input = {}) {
  if (input.exactRequired === true) return true
  const blockId = input.blockId || blockNameFrom(input)
  const role = normalizeRole(input.role)
  if (!TERRAIN_MATERIALS.includes(blockId)) return true
  if (!isTerrainRole(role)) return true
  if (isStructuralRole(role) || isStructuralBlock(blockId)) return true
  return false
}

function isDerivedTerrainFill(input = {}) {
  const blockId = input.blockId || blockNameFrom(input)
  if (!TERRAIN_MATERIALS.includes(blockId)) return false
  if (input.role && !isTerrainRole(input.role)) return false
  if (isStructuralRole(input.role) || isStructuralBlock(blockId)) return false
  const position = input.position
  const bounds = input.bounds
  if (!position || !bounds) return false
  const minY = bounds.minY ?? bounds.min?.y
  return Number.isFinite(minY) && Math.round(position.y) === Math.round(minY)
}

function isTerrainRole(role) {
  return TERRAIN_ROLES.has(normalizeRole(role))
}

function isStructuralRole(role) {
  const value = normalizeRole(role)
  if (!value) return false
  return STRUCTURAL_ROLE_PATTERNS.some(pattern => pattern.test(value))
}

function isStructuralBlock(blockName) {
  const value = String(blockName || '')
  return STRUCTURAL_BLOCK_PATTERNS.some(pattern => pattern.test(value))
}

function isMaterialPlacementStep(step) {
  return ['foundation_fill', 'scaffold_place', 'place'].includes(step?.kind) ||
    step?.action === 'place_block'
}

function blockNameFrom(value) {
  if (!value) return null
  if (typeof value === 'string') return value
  return value.blockId || value.blockName || value.type || value.name || value.id || value.block?.id || null
}

function originalBlockNameFrom(value) {
  if (!value) return null
  return blockNameFrom(value.originalBlockName) ||
    blockNameFrom(value.originalBlock) ||
    blockNameFrom(value.materialResolution?.originalBlock) ||
    null
}

function normalizeMaterialOverrides(value = []) {
  const source = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? Object.values(value) : [])
  const overrides = []
  for (const override of source) {
    if (!override || typeof override !== 'object') continue
    const originalBlock = blockNameFrom(override.originalBlock) ||
      blockNameFrom(override.originalBlockName)
    const resolvedBlock = blockNameFrom(override.resolvedBlock) ||
      blockNameFrom(override.resolvedBlockName)
    const sourceStepIds = normalizeIdList(override.sourceStepIds || override.stepIds || override.stepId)
    if (!originalBlock || !resolvedBlock || !sourceStepIds.length) continue
    overrides.push({
      ...override,
      originalBlock,
      resolvedBlock,
      sourceStepIds,
      scope: override.scope || 'currentRun'
    })
  }
  return overrides
}

function materialOverrideForStep(step, originalBlock, overrides = []) {
  if (!step?.id || !originalBlock) return null
  for (const override of overrides) {
    if (override.scope !== 'currentRun') continue
    if (override.userApproved !== true) continue
    if (override.originalBlock !== originalBlock) continue
    if (!override.sourceStepIds.includes(step.id)) continue
    return override
  }
  return null
}

function normalizeRole(role) {
  return role ? String(role).trim().toLowerCase() : null
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return value.map(entry => String(entry || '').trim()).filter(Boolean)
  }
  const single = String(value || '').trim()
  return single ? [single] : []
}

function uniqueList(values = []) {
  const out = []
  for (const value of values) {
    const normalized = blockNameFrom(value)
    if (!normalized || out.includes(normalized)) continue
    out.push(normalized)
  }
  return out
}

function ensureFirst(values = [], first) {
  const filtered = values.filter(value => value !== first)
  return first ? [first, ...filtered] : filtered
}

function isVerified(stepState) {
  return String(stepState?.status || '') === 'verified'
}

function clonePlainObject(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

module.exports = {
  TERRAIN_MATERIALS,
  describeMaterialPolicyForBlock,
  resolveMaterialSteps
}
