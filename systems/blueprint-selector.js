const path = require('path')
const { BlueprintLoader } = require('./blueprint-loader')
const { CommunityBlueprintIndex } = require('./community-blueprint-index')
const { ProceduralBlueprintGenerator } = require('./procedural-blueprint-generator')
const {
  adaptBuildIntentToDesignSpec,
  blueprintSatisfiesDesignSpec,
  isLowComplexityTier,
  shouldPreserveNamedBlueprintScale
} = require('./building-complexity')
const {
  canonicalBlueprintName,
  normalizeBlueprintRequest,
  rankBlueprintCandidate
} = require('../utils/blueprint-ranking')

class BlueprintSelector {
  constructor(options = {}) {
    this.loader = options.loader || new BlueprintLoader(options)
    this.index = options.index || new CommunityBlueprintIndex({
      available: options.communityAvailable !== false
    })
    this.generator = options.generator || new ProceduralBlueprintGenerator()
    this.version = options.version || '1.20.1'
    this.allowCommunity = options.allowCommunity !== false
  }

  selectBlueprint(input = {}, context = {}) {
    const request = normalizeBlueprintRequest(input)
    if (!request.blueprintName) return { ok: false, error: 'missing_blueprint_request' }
    const designSpec = designSpecForSelection(input, request)

    const candidates = this.rankCandidates({ ...request, designSpec }, context)
    const attempted = []
    for (const candidate of candidates) {
      const resolved = this.resolveCandidate(candidate, request)
      const budget = resolved.ok && designSpec
        ? blueprintSatisfiesDesignSpec(resolved.blueprint, designSpec)
        : { ok: true, failures: [], metrics: null }
      attempted.push({
        id: candidate.id,
        blueprintName: candidate.blueprintName,
        sourceKind: candidate.sourceKind,
        score: candidate.score,
        ok: resolved.ok && budget.ok,
        error: resolved.error || (budget.ok ? null : `complexity_budget_rejected:${budget.failures[0] || 'unknown'}`),
        budgetFailures: budget.failures || [],
        complexityMetrics: budget.metrics || null
      })
      if (!resolved.ok) continue
      if (!budget.ok) continue

      return {
        ok: true,
        blueprint: resolved.blueprint,
        selected: {
          id: candidate.id,
          displayName: candidate.displayName || candidate.blueprintName,
          blueprintName: resolved.blueprint.name,
          requestedName: request.requestedName,
          sourceKind: candidate.sourceKind,
          sourceName: candidate.sourceName,
          score: candidate.score,
          rank: candidate.rank,
          fallback: Boolean(candidate.fallback),
          generatorKey: candidate.generatorKey || null,
          localName: candidate.localName || null,
          localBlueprintPath: candidate.localBlueprintPath || null,
          localRawPath: candidate.localRawPath || null,
          sourceMode: candidate.sourceMode || null,
          cacheHash: candidate.cacheHash || null,
          structureFileFormat: candidate.structureFileFormat || null,
          author: candidate.author || null,
          buildTitle: candidate.buildTitle || null,
          category: candidate.category || null,
          style: candidate.style || null,
          buildingType: candidate.buildingType || null,
          requiredStories: candidate.requiredStories || null,
          importStatus: candidate.importStatus || null,
          license: candidate.license || null,
          complexityTier: designSpec?.complexityTier || null,
          complexityMetrics: budget.metrics || null,
          budget: designSpec || null
        },
        candidates,
        attempted
      }
    }

    return {
      ok: false,
      error: 'no_usable_blueprint_candidate',
      candidates,
      attempted
    }
  }

  rankCandidates(request, context = {}) {
    const communityCandidates = this.allowCommunity
      ? this.index.findCandidates(request)
      : this.index.fallbackCandidates(request.blueprintName)
    const localCandidates = this.localCandidates(request)
    const complexityFallbacks = complexityFallbackCandidates(request)
    const fallback = this.index.fallbackCandidates(request.blueprintName)
    const unique = uniqueCandidates([...communityCandidates, ...localCandidates, ...complexityFallbacks, ...fallback])
    return unique
      .map(candidate => rankBlueprintCandidate(candidate, request, { version: this.version, context }))
      .sort((a, b) => b.score - a.score)
  }

  localCandidates(request) {
    const localNames = this.loader.listBlueprints()
    const target = canonicalBlueprintName(request.blueprintName)
    return localNames
      .filter(name => canonicalBlueprintName(name) === target || name === target)
      .map(name => ({
        id: `local-json-${name}`,
        blueprintName: name,
        localName: name,
        displayName: `Local JSON ${name}`,
        sourceKind: 'local_library',
        sourceName: 'blueprints',
        tags: [name, target],
        quality: 'medium',
        rating: 3.8,
        likes: 0,
        downloads: 0,
        complexity: 'small',
        versionRange: { min: '1.20.0', max: '1.20.6' }
      }))
  }

  resolveCandidate(candidate, request) {
    if (candidate.localBlueprintPath) {
      const blueprintPath = path.resolve(process.cwd(), candidate.localBlueprintPath)
      const loaded = this.loader.loadBlueprintFile(
        blueprintPath,
        `blueprint_not_found:${candidate.localBlueprintPath}`
      )
      if (!loaded.ok) return loaded
      return {
        ok: true,
        blueprint: annotateFaithfulCommunityBlueprint(loaded.blueprint, candidate)
      }
    }

    if (candidate.localName || candidate.sourceKind === 'local_library') {
      const localName = candidate.localName || candidate.blueprintName
      const loaded = this.loader.loadBlueprint(localName)
      if (loaded.ok) return loaded
      if (!candidate.generatorKey) return loaded
    }

    const generatorKey = candidate.generatorKey || candidate.blueprintName || request.blueprintName
    if (this.generator.supports(generatorKey)) {
      const generated = this.generator.generate(generatorKey)
      if (!generated.ok) return generated
      const validation = this.loader.validateBlueprint(generated.blueprint)
      if (!validation.ok) return validation
      return { ok: true, blueprint: generated.blueprint }
    }

    const fallbackKey = canonicalBlueprintName(request.blueprintName) || 'starter_shelter'
    const generated = this.generator.generate(fallbackKey)
    if (!generated.ok) return generated
    const validation = this.loader.validateBlueprint(generated.blueprint)
    if (!validation.ok) return validation
    return { ok: true, blueprint: generated.blueprint }
  }
}

function designSpecForSelection(input = {}, request = {}) {
  const hasExplicitDesignSignal = Boolean(
    input.designSpec ||
    input.designBudget ||
    input.complexityTier ||
    input.complexity
  )
  if ((input.forceRebuild === true || input.rebuild === true || input.resumeOnly === true) && !hasExplicitDesignSignal) return null
  if (shouldPreserveNamedBlueprintScale({ ...request, ...input }) && !hasExplicitDesignSignal) return null
  if (input.designSpec || input.designBudget) {
    return adaptBuildIntentToDesignSpec({
      ...request,
      designSpec: input.designSpec || input.designBudget
    })
  }
  if (!input.complexityTier && !input.complexity && !input.rawText && !input.input && !input.text) return null
  return adaptBuildIntentToDesignSpec({
    ...request,
    rawText: input.rawText || input.input || input.text || null,
    complexity: input.complexity,
    complexityTier: input.complexityTier
  })
}

function complexityFallbackCandidates(request = {}) {
  const spec = request.designSpec
  if (!spec || !isLowComplexityTier(spec.complexityTier)) return []
  const target = canonicalBlueprintName(request.blueprintName)
  if (spec.complexityTier === 'L3' && target === 'two_story_wood_house') {
    return [{
      id: 'procedural-simple-two-story-cabin-l3',
      blueprintName: 'two_story_wood_house',
      displayName: 'Procedural Simple Two-story Cabin',
      sourceKind: 'procedural_fallback',
      sourceName: 'procedural-fallback',
      generatorKey: 'simple_two_story_cabin',
      style: 'wood',
      buildingType: 'two_story_wood_house',
      tags: ['two_story_wood_house', 'simple_two_story_cabin', 'simple', 'cabin', 'wood', 'l3'],
      rating: 3.5,
      likes: 0,
      downloads: 0,
      quality: 'medium',
      complexity: 'medium',
      fallback: true,
      materialCost: 360,
      requiredStories: 2,
      versionRange: { min: '1.20.0', max: '1.20.6' }
    }]
  }
  if (spec.complexityTier === 'L2' && ['small_house', 'simple_wood_cabin'].includes(target)) {
    return [{
      id: 'procedural-simple-wood-cabin-l2',
      blueprintName: target || 'simple_wood_cabin',
      displayName: 'Procedural Simple Wood Cabin',
      sourceKind: 'procedural_fallback',
      sourceName: 'procedural-fallback',
      generatorKey: 'simple_wood_cabin',
      style: 'wood',
      buildingType: 'simple_wood_cabin',
      tags: ['small_house', 'simple_wood_cabin', 'simple', 'cabin', 'wood', 'l2'],
      rating: 3.4,
      likes: 0,
      downloads: 0,
      quality: 'medium',
      complexity: 'small',
      fallback: true,
      materialCost: 180,
      requiredStories: 1,
      versionRange: { min: '1.20.0', max: '1.20.6' }
    }]
  }
  return []
}

function uniqueCandidates(candidates = []) {
  const seen = new Set()
  const result = []
  for (const candidate of candidates) {
    const key = `${candidate.sourceKind || 'unknown'}:${candidate.id || candidate.blueprintName}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function annotateFaithfulCommunityBlueprint(blueprint, candidate = {}) {
  return {
    ...blueprint,
    metadata: {
      ...(blueprint.metadata || {}),
      sourceKind: 'real_community_import',
      sourceMode: candidate.sourceMode || blueprint.metadata?.sourceMode || 'faithful-community-import',
      faithfulCommunityImport: true,
      selectedCommunitySample: {
        id: candidate.id,
        displayName: candidate.displayName || candidate.buildTitle || candidate.id,
        author: candidate.author || null,
        buildTitle: candidate.buildTitle || null,
        sourceName: candidate.sourceName || null,
        localBlueprintPath: candidate.localBlueprintPath || null,
        localRawPath: candidate.localRawPath || null,
        cacheHash: candidate.cacheHash || null,
        structureFileFormat: candidate.structureFileFormat || null,
        importStatus: candidate.importStatus || null,
        license: candidate.license || null
      }
    }
  }
}

module.exports = {
  BlueprintSelector
}
