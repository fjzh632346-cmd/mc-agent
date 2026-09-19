const crypto = require('crypto')
const { createSitePlan, isAirName, planBuildOrder, planMaterials, posKey } = require('../utils/site-planner')
const { itemRequirementsForBlock } = require('../utils/building-material-map')
const { isButtonBlockName, isFenceGateBlockName, transformHorizontalStates } = require('../utils/block-state-transform')
const { BLUEPRINT_IR_SCHEMA_VERSION, BLUEPRINT_PHASES, clonePlainObject, positionKey } = require('./blueprint-ir')
const { describeMaterialPolicyForBlock } = require('./material-resolution')

const PLAN_SCHEMA_VERSION = 1

class ConstructionCompiler {
  compile(input = {}) {
    const diagnostics = []
    const blueprint = input.blueprint
    if (!blueprint || blueprint.schemaVersion !== BLUEPRINT_IR_SCHEMA_VERSION) {
      diagnostics.push(diagnostic('error', 'invalid_blueprint_ir', 'blueprint', 'ConstructionCompiler requires BlueprintIR v1'))
      return { ok: false, error: 'invalid_blueprint_ir', diagnostics }
    }

    const placement = normalizePlacementContext(input.placementContext)
    if (!placement.ok) {
      diagnostics.push(...placement.diagnostics)
      return { ok: false, error: 'invalid_placement_context', diagnostics }
    }

    const worldBlocks = materializeBlueprintBlocks(blueprint, placement.placement)
    const plannerContext = createPlannerContext({
      inventoryPolicy: input.inventoryPolicy,
      siteSnapshot: input.siteSnapshot,
      placement: placement.placement
    })
    const compilerOptions = {
      ...(input.compilerOptions || {}),
      origin: placement.placement.origin,
      avoidInitialFootprint: input.compilerOptions?.avoidInitialFootprint === true
    }
    const formalMaterials = input.inventoryPolicy?.formalMaterials || requiredMaterialsFromBlueprint(blueprint)
    const sitePlan = createSitePlan(plannerContext, worldBlocks, compilerOptions)
    const materialPlan = planMaterials(plannerContext, formalMaterials, sitePlan, compilerOptions)
    const orderPlan = maybeAddWalkabilityGate(
      planBuildOrder(worldBlocks, sitePlan, materialPlan, plannerContext, compilerOptions),
      compilerOptions
    )
    const blueprintRevision = blueprintRevisionForPlan(blueprint)
    const blueprintHash = createBlueprintHash(blueprint)
    const normalizedSteps = normalizePlanSteps(orderPlan.steps, blueprint, worldBlocks, placement.placement, {
      blueprintRevision,
      blueprintHash
    })
    const steps = orderStepsByDependencies(normalizedSteps)
    const legacyOrderPlan = {
      ...orderPlan,
      steps: attachPlanStepIds(orderPlan.steps, steps, normalizedSteps)
    }
    const hasPrebuildBlockers = (sitePlan.blockedReasons || []).length > 0 ||
      (materialPlan.missingMaterials || []).length > 0
    const orderDiagnostics = validateStepDependencyOrder(steps)
      .map(entry => hasPrebuildBlockers && entry.severity === 'error'
        ? {
            ...entry,
            severity: 'warning',
            deferredBy: (sitePlan.blockedReasons || []).length > 0 ? 'site_blocked' : 'missing_materials'
          }
        : entry)
    diagnostics.push(...orderDiagnostics)
    if (orderDiagnostics.some(entry => entry.severity === 'error')) {
      return { ok: false, error: orderDiagnostics[0].code, diagnostics }
    }

    const plan = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: createPlanId(blueprint.id, placement.placement, steps),
      blueprintId: blueprint.id,
      blueprintRevision,
      blueprintHash,
      placement: placement.placement,
      materials: {
        required: materialPlan.requiredMaterials || {},
        formalRequired: materialPlan.formalRequiredMaterials || {},
        foundationMaterial: materialPlan.foundationMaterial || null,
        scaffoldMaterial: materialPlan.scaffoldMaterial || null,
        missing: materialPlan.missingMaterials || []
      },
      phases: summarizePhases(steps),
      steps,
      diagnostics
    }

    return {
      ok: true,
      plan,
      legacy: {
        worldBlocks,
        sitePlan,
        materialPlan,
        orderPlan: legacyOrderPlan
      },
      diagnostics
    }
  }
}

function materializeBlueprintBlocks(blueprint, placementContext = {}) {
  const placement = normalizePlacementContext(placementContext).placement
  return (blueprint.blocks || []).map(block => {
    const target = transformRelativePosition(block.position, placement)
    const sourceStates = clonePlainObject(block.block.states || {})
    const states = (isButtonBlockName(block.block.id) || isFenceGateBlockName(block.block.id))
      ? transformHorizontalStates(sourceStates, placement)
      : sourceStates
    return {
      key: block.key,
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      type: block.block.id,
      position: target,
      states,
      orientation: clonePlainObject(states),
      role: block.role || null,
      phase: block.phase,
      optional: block.optional === true,
      clearancePolicy: block.clearancePolicy,
      dependencies: [...(block.dependencies || [])],
      materialAlternatives: [...(block.materialAlternatives || [])]
    }
  })
}

function transformRelativePosition(position, placement) {
  let x = position.x
  const y = position.y
  let z = position.z
  if (placement.mirror.x) x *= -1
  if (placement.mirror.z) z *= -1

  const rotation = ((placement.rotationY % 360) + 360) % 360
  let rx = x
  let rz = z
  if (rotation === 90) {
    rx = -z
    rz = x
  } else if (rotation === 180) {
    rx = -x
    rz = -z
  } else if (rotation === 270) {
    rx = z
    rz = -x
  }

  return {
    x: placement.origin.x + rx,
    y: placement.origin.y + y,
    z: placement.origin.z + rz
  }
}

function normalizePlacementContext(context = {}) {
  const diagnostics = []
  const origin = normalizePoint(context.origin || context.worldOrigin || { x: 0, y: 0, z: 0 })
  if (!origin) diagnostics.push(diagnostic('error', 'bad_placement_origin', 'placementContext.origin', 'Placement origin must contain finite x/y/z'))

  const rotationValue = typeof context.rotation === 'number'
    ? context.rotation
    : Number(context.rotationY ?? context.rotation?.y ?? 0)
  const rotationY = Number.isFinite(rotationValue) ? normalizeRotation(rotationValue) : NaN
  if (!Number.isFinite(rotationY)) diagnostics.push(diagnostic('error', 'bad_placement_rotation', 'placementContext.rotationY', 'Placement rotation must be 0, 90, 180, or 270'))

  const mirror = {
    x: context.mirror?.x === true || context.mirrorX === true,
    z: context.mirror?.z === true || context.mirrorZ === true
  }

  return {
    ok: diagnostics.length === 0,
    placement: {
      origin: origin || { x: 0, y: 0, z: 0 },
      rotationY: Number.isFinite(rotationY) ? rotationY : 0,
      mirror
    },
    diagnostics
  }
}

function normalizeRotation(value) {
  const rotation = ((Math.round(value) % 360) + 360) % 360
  return [0, 90, 180, 270].includes(rotation) ? rotation : NaN
}

function createPlannerContext({ inventoryPolicy = {}, siteSnapshot = {}, placement }) {
  const blocks = new Map()
  for (const entry of siteSnapshot.blocks || []) {
    if (!entry?.position) continue
    blocks.set(positionKey(entry.position), entry.name || entry.type || 'air')
  }
  const counts = inventoryPolicy.counts || siteSnapshot.inventoryCounts || {}
  const items = Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }))
  const entities = Array.isArray(siteSnapshot.entities)
    ? Object.fromEntries(siteSnapshot.entities.map((entity, index) => [entity.id || index, entity]))
    : (siteSnapshot.entities || {})

  return {
    bot: {
      entity: { position: siteSnapshot.actorPosition || placement.origin },
      entities,
      inventory: {
        items: () => items
      },
      blockAt(position) {
        const normalized = normalizePoint(position) || { x: 0, y: 0, z: 0 }
        return {
          name: blocks.get(positionKey(normalized)) || 'air',
          position: normalized
        }
      }
    },
    blackboard: {
      get(key) {
        if (key === 'bot.position') return siteSnapshot.actorPosition || placement.origin
        if (key === 'inventory.counts') return counts
        return null
      }
    }
  }
}

function normalizePlanSteps(legacySteps = [], blueprint, worldBlocks, placement, identity = {}) {
  const sourceByWorldPosition = new Map()
  const blockByKey = new Map((blueprint.blocks || []).map(block => [block.key, block]))
  for (const block of worldBlocks) {
    sourceByWorldPosition.set(posKey(block.position), block.key)
  }
  const stepIdBySourceKey = new Map()
  const normalized = legacySteps.map(step => {
    const sourceBlockKey = step.position ? sourceByWorldPosition.get(posKey(step.position)) || null : null
    const sourceBlock = sourceBlockKey ? blockByKey.get(sourceBlockKey) : null
    const action = normalizeAction(step.kind)
    const policy = describeMaterialPolicyForBlock({
      blockId: step.blockName || sourceBlock?.block?.id || null,
      role: sourceBlock?.role || step.role || null,
      phase: sourceBlock?.phase || step.phase || null,
      position: sourceBlock?.position || null,
      bounds: blueprint.bounds,
      materialAlternatives: sourceBlock?.materialAlternatives || step.materialAlternatives || [],
      clearancePolicy: sourceBlock?.clearancePolicy || step.clearancePolicy || null
    })
    const id = createStableStepId({
      blueprintRevision: identity.blueprintRevision,
      blueprintHash: identity.blueprintHash,
      placement,
      sourceBlockKey,
      action,
      step
    })
    if (sourceBlockKey && !stepIdBySourceKey.has(sourceBlockKey) && isPlacementAction(step.kind)) {
      stepIdBySourceKey.set(sourceBlockKey, id)
    }
    return {
      id,
      sourceBlockKey,
      phase: normalizeStepPhase(step.phase, sourceBlock?.phase),
      action,
      target: step.position ? clonePlainObject(step.position) : null,
      block: step.blockName
        ? {
            id: step.blockName,
            states: clonePlainObject(step.states || step.orientation || {})
          }
        : null,
      dependencies: [],
      clearancePolicy: sourceBlock?.clearancePolicy || clearancePolicyForStep(step),
      role: policy.role || sourceBlock?.role || step.role || null,
      materialAlternatives: [...(policy.materialAlternatives || [])],
      exactRequired: policy.exactRequired === true,
      materialPolicySource: policy.source,
      legacyKind: step.kind
    }
  })

  for (const step of normalized) {
    const sourceBlock = step.sourceBlockKey ? blockByKey.get(step.sourceBlockKey) : null
    const dependencies = []
    for (const dependencyKey of sourceBlock?.dependencies || []) {
      const dependencyStepId = stepIdBySourceKey.get(dependencyKey)
      if (dependencyStepId) dependencies.push(dependencyStepId)
    }
    step.dependencies = dependencies
  }

  return normalized
}

function attachPlanStepIds(legacySteps = [], planSteps = [], originalPlanSteps = planSteps) {
  const legacyByStepId = new Map(originalPlanSteps.map((step, index) => [step.id, legacySteps[index]]))
  return planSteps.map(planStep => {
    const step = legacyByStepId.get(planStep.id)
    if (!step) return { id: planStep.id }
    return {
      ...step,
      id: planStep.id,
      sourceBlockKey: planStep.sourceBlockKey,
      action: planStep.action,
      role: planStep.role || step.role || null,
      materialAlternatives: [...(planStep.materialAlternatives || step.materialAlternatives || [])],
      exactRequired: planStep.exactRequired === true,
      materialPolicySource: planStep.materialPolicySource || null,
      dependencies: [...(planStep.dependencies || [])]
    }
  })
}

// Stable topological order: keep the planner's sequence and only DELAY a
// step until every dependency it names has been emitted. The previous
// depth-first version hoisted the dependency up to the dependent instead,
// which dragged blocks ahead of their own placement reference (live,
// fort-wall-gate: the ladder at 602,78,-16 pulled the 602,78,-17 column log
// above the brick and lower logs the planner had scheduled before it, and the
// log died with stateful_axis_no_y_reference).
function orderStepsByDependencies(steps = []) {
  const known = new Set(steps.map(step => step.id))
  const emitted = new Set()
  const pending = [...steps]
  const ordered = []
  const ready = step => (step.dependencies || []).every(id => emitted.has(id) || !known.has(id))

  while (pending.length) {
    let index = pending.findIndex(ready)
    // A dependency cycle can never become ready; fall back to planner order
    // for the head so the loop always terminates (the validator reports it).
    if (index < 0) index = 0
    const step = pending.splice(index, 1)[0]
    emitted.add(step.id)
    ordered.push(step)
  }
  return ordered
}

function validateStepDependencyOrder(steps = []) {
  const diagnostics = []
  const indexById = new Map(steps.map((step, index) => [step.id, index]))
  for (const [index, step] of steps.entries()) {
    for (const dependency of step.dependencies || []) {
      const dependencyIndex = indexById.get(dependency)
      if (dependencyIndex === undefined) {
        diagnostics.push(diagnostic('error', 'plan_step_missing_dependency', `steps.${index}.dependencies`, `Plan step dependency ${dependency} does not exist`))
      } else if (dependencyIndex >= index) {
        diagnostics.push(diagnostic('error', 'plan_step_dependency_order_violation', `steps.${index}.dependencies`, `Plan step ${step.id} depends on ${dependency} scheduled later`))
      }
    }
  }
  return diagnostics
}

function maybeAddWalkabilityGate(orderPlan, options = {}) {
  if (options.includeWalkabilityGate === false) return orderPlan
  if (!orderPlan?.steps) return orderPlan
  const steps = [...orderPlan.steps]
  const validateIndex = steps.findIndex(step => step.kind === 'validate')
  const insertIndex = validateIndex >= 0 ? validateIndex : steps.length
  if (!steps.some(step => step.kind === 'walkability_validate')) {
    steps.splice(insertIndex, 0, { kind: 'walkability_validate', phase: 'walkability_final_check' })
  }
  return {
    ...orderPlan,
    steps,
    summary: {
      ...(orderPlan.summary || {}),
      walkabilityValidate: 1,
      totalSteps: steps.length
    }
  }
}

function summarizePhases(steps = []) {
  return BLUEPRINT_PHASES
    .map(phase => ({
      phase,
      stepCount: steps.filter(step => step.phase === phase).length
    }))
    .filter(entry => entry.stepCount > 0)
}

function requiredMaterialsFromBlueprint(blueprint) {
  const required = {}
  for (const block of blueprint.blocks || []) {
    const blockId = block.block?.id
    if (!blockId || isAirName(blockId)) continue
    const requirements = itemRequirementsForBlock(blockId, block.block?.states)
    for (const [itemName, count] of Object.entries(requirements)) {
      required[itemName] = (required[itemName] || 0) + count
    }
  }
  return required
}

function createPlanId(blueprintId, placement, steps) {
  const hash = crypto
    .createHash('sha1')
    .update(stableStringify({
      blueprintId,
      placement,
      steps: steps.map(step => ({
        sourceBlockKey: step.sourceBlockKey,
        phase: step.phase,
        action: step.action,
        target: step.target,
        block: step.block,
        dependencies: step.dependencies,
        clearancePolicy: step.clearancePolicy
      }))
    }))
    .digest('hex')
    .slice(0, 12)
  return `construction_plan_${hash}`
}

function createStableStepId(input = {}) {
  const step = input.step || {}
  const target = step.position || null
  const sourceBlockKey = input.sourceBlockKey || (target ? `target:${posKey(target)}` : `phase:${step.phase || 'none'}`)
  const hash = crypto
    .createHash('sha1')
    .update(stableStringify({
      blueprintRevision: input.blueprintRevision,
      blueprintHash: input.blueprintHash,
      placement: input.placement,
      sourceBlockKey,
      action: input.action,
      legacyKind: step.kind,
      target,
      blockName: step.blockName || null,
      current: step.current || null
    }))
    .digest('hex')
    .slice(0, 16)
  return `step_${hash}`
}

function createBlueprintHash(blueprint) {
  return crypto
    .createHash('sha1')
    .update(stableStringify({
      schemaVersion: blueprint.schemaVersion,
      id: blueprint.id,
      name: blueprint.name,
      bounds: blueprint.bounds,
      blocks: (blueprint.blocks || []).map(block => ({
        key: block.key,
        position: block.position,
        block: block.block,
        phase: block.phase,
        role: block.role,
        dependencies: block.dependencies,
        clearancePolicy: block.clearancePolicy
      }))
    }))
    .digest('hex')
}

function blueprintRevisionForPlan(blueprint) {
  return String(
    blueprint.metadata?.revision ||
    blueprint.metadata?.cacheHash ||
    blueprint.metadata?.import?.cacheHash ||
    blueprint.metadata?.legacyBlueprintName ||
    blueprint.id ||
    'unknown'
  )
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function normalizeStepPhase(phase, fallback) {
  if (BLUEPRINT_PHASES.includes(phase)) return phase
  if (phase === 'clear_obstruction') return 'site_prepare'
  if (phase === 'foundation_fill') return 'foundation'
  if (phase === 'scaffold') return 'site_prepare'
  if (phase === 'validate' || phase === 'walkability_final_check') return 'cleanup'
  return BLUEPRINT_PHASES.includes(fallback) ? fallback : 'frame'
}

function normalizeAction(kind) {
  if (kind === 'clear' || kind === 'scaffold_remove') return 'clear_block'
  if (kind === 'foundation_fill' || kind === 'scaffold_place' || kind === 'place') return 'place_block'
  if (kind === 'walkability_validate') return 'validate_walkability'
  if (kind === 'validate') return 'validate_world'
  return String(kind || 'unknown')
}

function isPlacementAction(kind) {
  return kind === 'foundation_fill' || kind === 'scaffold_place' || kind === 'place'
}

function clearancePolicyForStep(step) {
  if (step.kind === 'clear' || step.kind === 'scaffold_remove') return 'clear_any'
  if (step.kind === 'validate' || step.kind === 'walkability_validate') return 'preserve'
  return 'clear_replaceable'
}

function normalizePoint(point) {
  if (!point) return null
  const x = Number(point.x)
  const y = Number(point.y)
  const z = Number(point.z)
  if (![x, y, z].every(Number.isFinite)) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z)
  }
}

function diagnostic(severity, code, path, message) {
  return { severity, code, path, message }
}

module.exports = {
  ConstructionCompiler,
  PLAN_SCHEMA_VERSION,
  createBlueprintHash,
  materializeBlueprintBlocks,
  normalizePlacementContext
}
