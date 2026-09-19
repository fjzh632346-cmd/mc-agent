const fs = require('fs')
const path = require('path')
const { BlueprintLoader } = require('./blueprint-loader')
const { BuildingHardGate } = require('./building-hard-gate')
const { CommunityBlueprintIndex } = require('./community-blueprint-index')
const { ProceduralBlueprintGenerator } = require('./procedural-blueprint-generator')
const { BuildingDesigner } = require('./building-designer')
const { StructureEncoder } = require('./structure-encoder')
const {
  canonicalBlueprintName,
  normalizeBlueprintRequest,
  rankBlueprintCandidate
} = require('../utils/blueprint-ranking')

const DEFAULT_CACHE_INDEX = path.join(process.cwd(), 'data', 'community-builds', 'cache', 'index.json')

class CommunityBuildCollector {
  constructor(options = {}) {
    this.index = options.index || new CommunityBlueprintIndex({
      available: options.available !== false,
      candidates: options.candidates,
      sources: options.sources
    })
    this.loader = options.loader || new BlueprintLoader(options)
    this.generator = options.generator || new ProceduralBlueprintGenerator()
    this.designer = options.designer || new BuildingDesigner(options.design || options)
    this.encoder = options.encoder || new StructureEncoder(options.encoder || options)
    this.hardGate = options.hardGate || new BuildingHardGate(options.hardGate || options)
    this.options = {
      cacheIndexPath: options.cacheIndexPath || DEFAULT_CACHE_INDEX,
      allowSyntheticSamples: options.allowSyntheticSamples === true,
      requireRealCommunity: options.requireRealCommunity !== false,
      minSamples: options.minSamples ?? 1,
      maxSamples: options.maxSamples ?? 4,
      minQualityScore: options.minQualityScore ?? 0.7,
      version: options.version || '1.20.1',
      ...options
    }
  }

  listSources() {
    const cache = this.readCacheIndex()
    const cached = cache.ok
      ? (cache.index.samples || []).map(sample => ({
          id: sample.id,
          source: sample.source,
          repository: sample.repository,
          sourcePageIdentifier: sample.sourcePageIdentifier,
          importStatus: sample.importStatus,
          cacheHash: sample.cacheHash
        }))
      : []
    return {
      verifiedCache: cached,
      syntheticIndex: this.options.allowSyntheticSamples ? this.index.listSources() : []
    }
  }

  loadSamples(input = {}, context = {}) {
    const request = normalizeBlueprintRequest(input)
    if (!request.blueprintName) return { ok: false, error: 'missing_community_sample_request', samples: [] }

    const real = this.loadVerifiedCacheSamples(request, context)
    if (real.ok) return real

    if (!this.options.allowSyntheticSamples) {
      return {
        ok: false,
        error: real.error || 'real_community_samples_unavailable',
        request,
        samples: [],
        realCommunity: false,
        fallbackUsed: false,
        cache: real.cache || null,
        attempted: real.attempted || [],
        rejected: real.rejected || []
      }
    }

    const synthetic = this.loadSyntheticSamples(request, context)
    return {
      ...synthetic,
      source: 'synthetic_test_fixture',
      realCommunity: false,
      fallbackUsed: true,
      warning: 'synthetic_samples_are_allowed_only_for_unit_tests_not_p9_acceptance',
      realCacheError: real.error || null
    }
  }

  loadVerifiedCacheSamples(request, context = {}) {
    const cache = this.readCacheIndex()
    if (!cache.ok) return { ok: false, error: cache.error, cache, samples: [] }

    const hardRejected = []
    const candidates = (cache.index.samples || [])
      .filter(sample => String(sample.importStatus || '').startsWith('verified'))
      .filter(sample => {
        const compatibility = samplePassesHardRequirements(sample, request)
        if (!compatibility.ok) hardRejected.push({ id: sample.id, reason: compatibility.reason })
        return compatibility.ok
      })
      .map(sample => this.rankCachedSample(sample, request, context))
      .sort((a, b) => b.score - a.score)

    const samples = []
    const attempted = []
    const rejected = []

    for (const candidate of candidates) {
      if (samples.length >= this.options.maxSamples) break
      const loaded = this.resolveCachedSample(candidate, request)
      attempted.push({
        id: candidate.id,
        score: candidate.score,
        source: candidate.source,
        sourcePageIdentifier: candidate.sourcePageIdentifier,
        ok: loaded.ok,
        error: loaded.error || null
      })
      if (!loaded.ok) {
        rejected.push({ id: candidate.id, reason: loaded.error })
        continue
      }
      samples.push(loaded.sample)
    }

    if (samples.length < this.options.minSamples) {
      return {
        ok: false,
        error: 'verified_real_community_samples_unavailable',
        request,
        samples,
        attempted,
        rejected: [...hardRejected, ...rejected],
        cache: {
          indexPath: this.options.cacheIndexPath,
          generatedAt: cache.index.generatedAt || null,
          evidence: cache.index.evidence || null
        }
      }
    }

    return {
      ok: true,
      request,
      source: 'verified_real_community_cache',
      realCommunity: true,
      fallbackUsed: false,
      generatedAt: cache.index.generatedAt || null,
      evidence: cache.index.evidence || null,
      samples,
      attempted,
      candidates: candidates.slice(0, this.options.maxSamples)
    }
  }

  readCacheIndex() {
    if (!fs.existsSync(this.options.cacheIndexPath)) {
      return { ok: false, error: `community_cache_index_missing:${this.options.cacheIndexPath}` }
    }
    try {
      const index = JSON.parse(fs.readFileSync(this.options.cacheIndexPath, 'utf8'))
      return { ok: true, index }
    } catch (err) {
      return { ok: false, error: `community_cache_index_parse_failed:${err.message}` }
    }
  }

  rankCachedSample(sample, request, context = {}) {
    const styleMatch = scoreStyleMatch(sample, request)
    const typeMatch = scoreTypeMatch(sample, request)
    const storyMatch = scoreStoryMatch(sample, request)
    const hardGateScore = sample.hardGate?.ok ? 1 : 0
    const ratingScore = scoreRating(sample.ratingMetadata)
    const diversityScore = scoreAestheticDiversity(sample.encodingSummary)
    const score = hardGateScore * 1000 +
      typeMatch * 240 +
      storyMatch * 180 +
      styleMatch * 120 +
      ratingScore * 40 +
      diversityScore * 20
    return {
      ...sample,
      score: Math.round(score),
      context
    }
  }

  resolveCachedSample(candidate, request) {
    if (!candidate.localBlueprintPath) return { ok: false, error: `community_cached_blueprint_missing:${candidate.id}` }
    const blueprintPath = path.resolve(process.cwd(), candidate.localBlueprintPath)
    if (!fs.existsSync(blueprintPath)) return { ok: false, error: `community_cached_blueprint_file_missing:${candidate.localBlueprintPath}` }

    let blueprint
    try {
      blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'))
    } catch (err) {
      return { ok: false, error: `community_cached_blueprint_parse_failed:${err.message}` }
    }

    const hardGate = this.hardGate.evaluateBlueprint(blueprint, {
      ...request,
      requiredStories: candidate.requiredStories || request.requiredStories
    })
    if (!hardGate.ok) {
      return { ok: false, error: `community_sample_hard_gate_failed:${hardGate.failures.join(',')}`, hardGate }
    }

    const encoding = this.encoder.encode(blueprint)
    if (!encoding.ok) return encoding

    return {
      ok: true,
      sample: {
        id: candidate.id,
        displayName: candidate.buildTitle || candidate.id,
        blueprintName: blueprint.name,
        sourceKind: 'real_community_import',
        sourceName: candidate.repository || candidate.source,
        source: candidate.source,
        sourcePageIdentifier: candidate.sourcePageIdentifier,
        repository: candidate.repository,
        author: candidate.author,
        buildTitle: candidate.buildTitle,
        category: candidate.category,
        style: candidate.style,
        buildingType: candidate.buildingType,
        requiredStories: candidate.requiredStories,
        quality: 'verified_real_community',
        rating: candidate.ratingMetadata || null,
        likes: candidate.ratingMetadata?.likes ?? candidate.ratingMetadata?.stars ?? null,
        downloads: candidate.ratingMetadata?.downloads ?? null,
        license: candidate.license || null,
        metadataFetchedAt: candidate.metadataFetchedAt || null,
        minecraftVersion: candidate.minecraftVersion || null,
        structureFileFormat: candidate.structureFileFormat,
        cacheHash: candidate.cacheHash,
        importStatus: candidate.importStatus,
        localBlueprintPath: candidate.localBlueprintPath,
        localRawPath: candidate.localRawPath,
        hardGate,
        blueprint,
        blockDistribution: encoding.features.blockDistribution,
        shape: encoding.features.shape,
        heightMap: encoding.features.heightMap,
        symmetryScore: encoding.features.symmetryScore,
        densityMap: encoding.features.densityMap,
        encoding
      }
    }
  }

  loadSyntheticSamples(request, context = {}) {
    if (!request.blueprintName) return { ok: false, error: 'missing_community_sample_request', samples: [] }

    const candidates = this.rankCommunityCandidates(request, context)
    const samples = []
    const attempted = []

    for (const candidate of candidates) {
      if (samples.length >= this.options.maxSamples) break
      const resolved = this.resolveCandidate(candidate, request)
      attempted.push({
        id: candidate.id,
        blueprintName: candidate.blueprintName,
        sourceKind: candidate.sourceKind,
        score: candidate.score,
        ok: resolved.ok,
        error: resolved.error || null
      })
      if (!resolved.ok) continue
      samples.push(resolved.sample)
    }

    if (samples.length < this.options.minSamples) {
      return {
        ok: false,
        error: 'community_samples_unavailable',
        request,
        samples,
        attempted,
        candidates: candidates.slice(0, this.options.maxSamples)
      }
    }

    return {
      ok: true,
      request,
      source: 'synthetic_test_fixture',
      samples,
      attempted,
      candidates: candidates.slice(0, this.options.maxSamples)
    }
  }

  rankCommunityCandidates(request, context = {}) {
    const all = this.index.listCandidates()
      .filter(candidate => candidate.sourceKind === 'community_index')
      .filter(candidate => qualityScore(candidate) >= this.options.minQualityScore)

    const exact = all.filter(candidate => candidateMatches(candidate, request))
    const style = styleForRequest(request)
    const styleMatches = all.filter(candidate => styleForCandidate(candidate) === style)
    const fallback = all

    return uniqueCandidates([...exact, ...styleMatches, ...fallback])
      .map(candidate => rankBlueprintCandidate(candidate, request, {
        version: this.options.version,
        context
      }))
      .sort((a, b) => b.score - a.score)
  }

  resolveCandidate(candidate, request) {
    const loaded = this.loadBlueprintForCandidate(candidate, request)
    if (!loaded.ok) return loaded

    const designed = this.designer.transformBlueprint(loaded.blueprint, {
      blueprintName: candidate.blueprintName || request.blueprintName,
      style: candidate.style || request.style,
      type: candidate.buildingType || request.type,
      selected: candidate,
      forceDesignVariation: true,
      designVariant: `community_sample_${candidate.id || candidate.blueprintName}`
    })
    if (!designed.ok) return designed

    const encoding = this.encoder.encode(designed.blueprint)
    if (!encoding.ok) return encoding

    return {
      ok: true,
      sample: {
        id: candidate.id,
        displayName: candidate.displayName || candidate.blueprintName,
        blueprintName: designed.blueprint.name,
        sourceKind: candidate.sourceKind,
        sourceName: candidate.sourceName,
        quality: candidate.quality || 'high',
        rating: candidate.rating || null,
        likes: candidate.likes || 0,
        downloads: candidate.downloads || 0,
        rank: candidate.rank || null,
        blueprint: designed.blueprint,
        blockDistribution: encoding.features.blockDistribution,
        shape: encoding.features.shape,
        heightMap: encoding.features.heightMap,
        symmetryScore: encoding.features.symmetryScore,
        densityMap: encoding.features.densityMap,
        encoding
      }
    }
  }

  loadBlueprintForCandidate(candidate, request) {
    if (candidate.localName || candidate.sourceKind === 'local_library') {
      const loaded = this.loader.loadBlueprint(candidate.localName || candidate.blueprintName)
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

    return { ok: false, error: `community_sample_blueprint_unavailable:${candidate.id || generatorKey}` }
  }
}

function samplePassesHardRequirements(sample, request) {
  if (!sample?.hardGate?.ok) return { ok: false, reason: 'sample_hard_gate_failed' }
  const requestStyle = styleForRequest(request)
  const sampleStyle = styleForCandidate(sample)
  if (requestStyle && sampleStyle && requestStyle !== sampleStyle) {
    return { ok: false, reason: `style_mismatch:${sampleStyle}->${requestStyle}` }
  }

  const requestType = canonicalBlueprintName(request.blueprintName || request.type || request.requestedName)
  const sampleNames = [sample.buildingType, sample.category, sample.buildTitle, sample.id]
    .map(canonicalBlueprintName)
    .filter(Boolean)
  const typeCompatible = !requestType || sampleNames.some(name => {
    if (name === requestType) return true
    if (requestType.includes('house') && name.includes('house') && requestStyle === sampleStyle) return true
    return false
  })
  if (!typeCompatible) return { ok: false, reason: `building_type_mismatch:${sample.buildingType || sample.category || sample.id}->${requestType}` }

  const requiredStories = Number(request.requiredStories || (String(request.blueprintName || '').includes('two') ? 2 : 1))
  const sampleStories = sample.hardGate?.metrics?.detectedStories || sample.requiredStories || 1
  if (Number.isFinite(requiredStories) && sampleStories < requiredStories) {
    return { ok: false, reason: `story_mismatch:${sampleStories}<${requiredStories}` }
  }
  return { ok: true }
}

function scoreStyleMatch(sample, request) {
  return styleForCandidate(sample) === styleForRequest(request) ? 1 : 0
}

function scoreTypeMatch(sample, request) {
  const target = canonicalBlueprintName(request.blueprintName || request.type)
  const names = [sample.buildingType, sample.category, sample.buildTitle, sample.id]
    .map(canonicalBlueprintName)
    .filter(Boolean)
  return names.some(name => name === target || name.includes(target) || target.includes(name)) ? 1 : 0
}

function scoreStoryMatch(sample, request) {
  const required = Number(request.requiredStories || (String(request.blueprintName || '').includes('two') ? 2 : 1))
  const sampleStories = sample.hardGate?.metrics?.detectedStories || sample.requiredStories || 1
  return sampleStories >= required ? 1 : 0
}

function scoreRating(metadata = {}) {
  if (!metadata) return 0
  const likes = Number(metadata.likes ?? metadata.stars ?? 0)
  const downloads = Number(metadata.downloads ?? 0)
  return Math.min(1, (Math.log10(likes + 1) / 4) * 0.55 + (Math.log10(downloads + 1) / 5) * 0.45)
}

function scoreAestheticDiversity(summary = {}) {
  if (!summary) return 0
  return Math.min(1, (
    Number(summary.facadeComplexity || 0) * 0.45 +
    Math.min(1, Number(summary.heightVariance || 0) / 8) * 0.3 +
    Math.min(1, Number(summary.nodeCount || 0) / 10) * 0.25
  ))
}

function candidateMatches(candidate, request) {
  const target = request.blueprintName
  const names = [
    candidate.id,
    candidate.blueprintName,
    candidate.generatorKey,
    candidate.style,
    candidate.buildingType,
    ...(candidate.tags || [])
  ].map(canonicalBlueprintName).filter(Boolean)
  return names.includes(target)
}

function styleForRequest(request = {}) {
  const key = canonicalBlueprintName(request.style || request.type || request.blueprintName || request.requestedName)
  return normalizeStyleFamily(key)
}

function styleForCandidate(candidate = {}) {
  const key = canonicalBlueprintName(candidate.style || candidate.buildingType || candidate.blueprintName)
  return normalizeStyleFamily(key)
}

function normalizeStyleFamily(key) {
  const text = String(key || '').toLowerCase()
  if (text.includes('castle')) return 'castle'
  if (text.includes('modern') || text.includes('villa')) return 'modern'
  if (text.includes('farm') || text.includes('manor') || text.includes('house') || text.includes('shelter') || text.includes('wood') || text.includes('starter') || text.includes('survival')) return 'wood'
  return text || 'wood'
}

function qualityScore(candidate = {}) {
  if (typeof candidate.qualityScore === 'number') return candidate.qualityScore
  const table = { high: 0.95, medium: 0.65, low: 0.35, fallback: 0.2 }
  return table[String(candidate.quality || '').toLowerCase()] ?? 0.55
}

function uniqueCandidates(candidates = []) {
  const seen = new Set()
  const result = []
  for (const candidate of candidates) {
    const id = candidate.id || `${candidate.sourceKind}:${candidate.blueprintName}`
    if (seen.has(id)) continue
    seen.add(id)
    result.push(candidate)
  }
  return result
}

module.exports = {
  CommunityBuildCollector
}
