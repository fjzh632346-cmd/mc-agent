const { BuildingDesigner } = require('./building-designer')
const { AestheticModel } = require('./aesthetic-model')

class AestheticRefiner {
  constructor(options = {}) {
    this.designer = options.designer || new BuildingDesigner(options.design || options)
    this.model = options.model || new AestheticModel(options.model || options)
    this.options = {
      maxIterations: options.maxIterations ?? 2,
      ...options
    }
  }

  refineBlueprint(blueprint, request = {}, communitySamples = [], context = {}) {
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return { ok: false, error: 'invalid_blueprint_for_aesthetic_refiner' }
    }

    let current = blueprint
    let designResult = null
    let diagnostics = null
    const attempts = []
    const operations = []

    for (let iteration = 0; iteration <= this.options.maxIterations; iteration++) {
      const evaluation = this.model.score(current, communitySamples, request.aesthetic || {})
      if (!evaluation.ok) return evaluation

      attempts.push(summarizeAttempt(iteration, current, evaluation, operations.at(-1)))
      if (evaluation.accepted) {
        return {
          ok: true,
          blueprint: current,
          design: designResult?.design || current.metadata?.design || null,
          diagnostics: diagnostics || designResult?.diagnostics || {},
          initial: attempts[0],
          final: attempts.at(-1),
          attempts,
          operations,
          refined: operations.length > 0,
          iterations: operations.length,
          evaluation
        }
      }

      if (iteration >= this.options.maxIterations) break

      const nextOperations = chooseOperations(evaluation)
      const refined = this.applyRefinement(current, {
        ...request,
        forceDesignVariation: true,
        designVariant: request.designVariant || `aesthetic_refine_${iteration + 1}`
      }, evaluation, nextOperations, iteration, context, communitySamples)

      if (!refined.ok) {
        return {
          ok: false,
          error: refined.error || 'aesthetic_refinement_failed',
          attempts,
          operations
        }
      }

      current = refined.blueprint
      designResult = refined.designResult || designResult
      diagnostics = refined.diagnostics || diagnostics
      operations.push({
        iteration: iteration + 1,
        operations: nextOperations,
        reason: evaluation.penalties.map(penalty => penalty.code).join(',') || 'community_similarity_below_threshold'
      })
    }

    const finalEvaluation = attempts.at(-1)?.evaluation || this.model.score(current, communitySamples, request.aesthetic || {})
    return {
      ok: false,
      error: aestheticFailureReason(finalEvaluation),
      blueprint: current,
      design: designResult?.design || current.metadata?.design || null,
      diagnostics: diagnostics || designResult?.diagnostics || {},
      initial: attempts[0] || null,
      final: attempts.at(-1) || null,
      attempts,
      operations,
      refined: operations.length > 0,
      iterations: operations.length,
      evaluation: finalEvaluation
    }
  }

  applyRefinement(blueprint, request, evaluation, operations, iteration, context, communitySamples = []) {
    const designed = this.designer.transformBlueprint(blueprint, {
      ...request,
      previousDesigns: [{ similarity: evaluation.similarity_to_good_builds }],
      forceDesignVariation: true
    })
    if (!designed.ok) return designed

    let refinedBlueprint = designed.blueprint
    const designedEvaluation = this.model.score(refinedBlueprint, communitySamples, request.aesthetic || {})
    const designAlreadyAccepted = designedEvaluation.ok === true && designedEvaluation.accepted === true
    if (!designAlreadyAccepted && (iteration > 0 || needsLocalTweak(evaluation))) {
      refinedBlueprint = applyLocalTweaks(refinedBlueprint, request, operations)
    }

    return {
      ok: true,
      blueprint: refinedBlueprint,
      designResult: {
        ...designed,
        blueprint: refinedBlueprint
      },
      diagnostics: {
        ...(designed.diagnostics || {}),
        aestheticOperations: operations,
        designedEvaluation: designedEvaluation.ok ? summarizeEvaluationForDiagnostics(designedEvaluation) : null
      }
    }
  }
}

function summarizeEvaluationForDiagnostics(evaluation) {
  return {
    aesthetic_score: evaluation.aesthetic_score,
    similarity_to_good_builds: evaluation.similarity_to_good_builds,
    accepted: evaluation.accepted,
    threshold: evaluation.threshold,
    similarityThreshold: evaluation.similarityThreshold
  }
}

function chooseOperations(evaluation) {
  const penaltyCodes = new Set((evaluation.penalties || []).map(penalty => penalty.code))
  const operations = []
  if (penaltyCodes.has('box_like_structure') || penaltyCodes.has('flat_structure') || evaluation.similarity_to_good_builds < evaluation.similarityThreshold) {
    operations.push('silhouette_reconstruction')
  }
  if (penaltyCodes.has('no_facade_layering') || (evaluation.metrics?.facadeComplexity || 0) < 0.5) {
    operations.push('facade_reconstruction')
  }
  if ((evaluation.metrics?.heightVariance || 0) < 0.5 || (evaluation.metrics?.uniqueColumnHeights?.length || 0) < 2) {
    operations.push('hierarchy_adjustment')
  }
  if ((evaluation.metrics?.materialDiversity || 0) < 3 || penaltyCodes.has('plain_material_surface')) {
    operations.push('material_optimization')
  }
  return operations.length ? operations : ['community_similarity_alignment']
}

function needsLocalTweak(evaluation) {
  return evaluation.penalties?.some(penalty => ['no_facade_layering', 'plain_material_surface', 'single_mass_volume'].includes(penalty.code))
}

function applyLocalTweaks(blueprint, request, operations) {
  const style = normalizeStyle(request.style || blueprint.metadata?.design?.style || request.blueprintName || blueprint.name)
  const blocks = blueprint.blocks.map(block => ({ ...block }))
  const solid = blocks.filter(block => !isAir(block.type))
  if (!solid.length) return blueprint

  const bounds = boundsFor(solid)
  const map = new Map(blocks.map(block => [key(block.x, block.y, block.z), block]))

  if (operations.includes('facade_reconstruction')) addFacadeAccents(map, bounds, style)
  if (operations.includes('hierarchy_adjustment')) addHierarchyAccent(map, bounds, style)
  if (operations.includes('material_optimization')) optimizeMaterialPalette(map, bounds, style)

  return {
    ...blueprint,
    metadata: {
      ...(blueprint.metadata || {}),
      aestheticRefinement: {
        enabled: true,
        operations,
        style
      }
    },
    blocks: [...map.values()].sort(sortBlocks)
  }
}

function addFacadeAccents(map, bounds, style) {
  const accent = style === 'modern' ? 'gray_concrete' : style === 'castle' ? 'cobblestone' : 'oak_log'
  const window = 'glass'
  const y1 = Math.min(bounds.maxY, bounds.minY + 1)
  const y2 = Math.min(bounds.maxY, bounds.minY + 2)
  setIfSolid(map, bounds.minX, y1, midpoint(bounds.minZ, bounds.maxZ), accent, { phase: 'column', role: 'aesthetic_facade_accent' })
  setIfSolid(map, bounds.maxX, y1, midpoint(bounds.minZ, bounds.maxZ), accent, { phase: 'column', role: 'aesthetic_facade_accent' })
  setIfSolid(map, midpoint(bounds.minX, bounds.maxX), y2, bounds.minZ, window, { phase: 'window', role: 'window', groupId: 'aesthetic_front_window' })
}

function addHierarchyAccent(map, bounds, style) {
  const roof = style === 'castle' ? 'stone_bricks' : style === 'modern' ? 'white_concrete' : 'oak_planks'
  const x = midpoint(bounds.minX, bounds.maxX)
  const z = midpoint(bounds.minZ, bounds.maxZ)
  const target = highestSolidNear(map, bounds, x, z)
  if (!target) return
  map.set(key(target.x, target.y + 1, target.z), {
    x: target.x,
    y: target.y + 1,
    z: target.z,
    type: roof,
    phase: style === 'castle' ? 'battlement' : 'roof_high',
    role: 'aesthetic_height_accent'
  })
}

function optimizeMaterialPalette(map, bounds, style) {
  const accent = style === 'modern' ? 'gray_concrete' : style === 'castle' ? 'cobblestone' : 'oak_log'
  for (const pos of [
    { x: bounds.minX, z: bounds.minZ },
    { x: bounds.maxX, z: bounds.minZ },
    { x: bounds.minX, z: bounds.maxZ },
    { x: bounds.maxX, z: bounds.maxZ }
  ]) {
    for (let y = bounds.minY + 1; y <= Math.min(bounds.maxY, bounds.minY + 3); y++) {
      setIfSolid(map, pos.x, y, pos.z, accent, { phase: 'column', role: 'aesthetic_material_accent' })
    }
  }
}

function setIfSolid(map, x, y, z, type, extra = {}) {
  const existing = map.get(key(x, y, z))
  if (!existing || isAir(existing.type)) return
  if (existing.phase === 'path' || existing.role === 'doorway' || existing.role === 'gate') return
  map.set(key(x, y, z), { ...existing, type, ...extra })
}

function aestheticFailureReason(evaluation) {
  if (!evaluation) return 'aesthetic_refiner_no_evaluation'
  if (evaluation.aesthetic_score < evaluation.threshold) return 'aesthetic_score_below_threshold'
  if (evaluation.similarity_to_good_builds < evaluation.similarityThreshold) return 'community_similarity_below_threshold'
  const hard = evaluation.penalties?.find(penalty => penalty.hard)
  return hard ? `aesthetic_hard_penalty:${hard.code}` : 'aesthetic_refinement_did_not_converge'
}

function summarizeAttempt(iteration, blueprint, evaluation, previousOperation) {
  return {
    iteration,
    blueprintName: blueprint.name || null,
    aesthetic_score: evaluation.aesthetic_score,
    similarity_to_good_builds: evaluation.similarity_to_good_builds,
    accepted: evaluation.accepted,
    threshold: evaluation.threshold,
    similarityThreshold: evaluation.similarityThreshold,
    bestMatch: evaluation.bestMatch,
    penalties: evaluation.penalties,
    metrics: summarizeMetrics(evaluation.metrics),
    operation: previousOperation || null,
    evaluation
  }
}

function summarizeMetrics(metrics = {}) {
  return {
    footprintFill: metrics.footprintFill,
    uniqueColumnHeights: metrics.uniqueColumnHeights,
    heightVariance: metrics.heightVariance,
    facadeComplexity: metrics.facadeComplexity,
    facadeLayerCount: metrics.facadeLayerCount,
    windowGroups: metrics.windowGroups,
    materialDiversity: metrics.materialDiversity,
    nodeCount: metrics.nodeCount,
    symmetryRatio: metrics.symmetryRatio
  }
}

function boundsFor(blocks) {
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.x),
    maxX: Math.max(bounds.maxX, block.x),
    minY: Math.min(bounds.minY, block.y),
    maxY: Math.max(bounds.maxY, block.y),
    minZ: Math.min(bounds.minZ, block.z),
    maxZ: Math.max(bounds.maxZ, block.z)
  }), {
    minX: blocks[0].x,
    maxX: blocks[0].x,
    minY: blocks[0].y,
    maxY: blocks[0].y,
    minZ: blocks[0].z,
    maxZ: blocks[0].z
  })
}

function normalizeStyle(value) {
  const text = String(value || '').toLowerCase()
  if (text.includes('castle')) return 'castle'
  if (text.includes('modern') || text.includes('villa')) return 'modern'
  return 'wood'
}

function midpoint(min, max) {
  return Math.round((min + max) / 2)
}

function isAir(type) {
  return ['air', 'cave_air', 'void_air'].includes(type)
}

function key(x, y, z) {
  return `${x},${y},${z}`
}

function highestSolidNear(map, bounds, centerX, centerZ) {
  const candidates = [
    { x: centerX, z: centerZ },
    { x: centerX - 1, z: centerZ },
    { x: centerX + 1, z: centerZ },
    { x: centerX, z: centerZ - 1 },
    { x: centerX, z: centerZ + 1 }
  ].filter(pos => pos.x >= bounds.minX && pos.x <= bounds.maxX && pos.z >= bounds.minZ && pos.z <= bounds.maxZ)

  for (let y = bounds.maxY; y >= bounds.minY; y--) {
    for (const candidate of candidates) {
      const block = map.get(key(candidate.x, y, candidate.z))
      if (block && !isAir(block.type)) return block
    }
  }
  return null
}

function sortBlocks(a, b) {
  return (a.y - b.y) || (a.x - b.x) || (a.z - b.z)
}

module.exports = {
  AestheticRefiner
}
