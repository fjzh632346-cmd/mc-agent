const { StructureEncoder, cosineSimilarity } = require('./structure-encoder')

const AESTHETIC_DEFAULTS = Object.freeze({
  aestheticThreshold: 0.72,
  similarityThreshold: 0.58,
  minFacadeComplexity: 0.42,
  maxBoxFootprintFill: 0.94,
  minHeightVariance: 0.18
})

class AestheticModel {
  constructor(options = {}) {
    this.encoder = options.encoder || new StructureEncoder(options.encoder || options)
    this.options = {
      ...AESTHETIC_DEFAULTS,
      ...options
    }
  }

  score(input = {}, communitySamples = [], options = {}) {
    const config = { ...this.options, ...options }
    const encoding = normalizeEncoding(input, this.encoder)
    if (!encoding.ok) return encoding

    const sampleEncodings = normalizeSampleEncodings(communitySamples, this.encoder)
    if (!sampleEncodings.length) {
      return {
        ok: false,
        error: 'community_samples_missing_for_aesthetic_score',
        aesthetic_score: 0,
        similarity_to_good_builds: 0,
        accepted: false,
        threshold: config.aestheticThreshold,
        similarityThreshold: config.similarityThreshold,
        encoding
      }
    }

    const similarities = sampleEncodings.map(sample => ({
      id: sample.id,
      blueprintName: sample.blueprintName,
      sourceKind: sample.sourceKind,
      similarity: cosineSimilarity(encoding.vector, sample.encoding.vector)
    })).sort((a, b) => b.similarity - a.similarity)

    const best = similarities[0]?.similarity || 0
    const topThree = similarities.slice(0, 3).map(entry => entry.similarity)
    const topAverage = topThree.length ? topThree.reduce((sum, value) => sum + value, 0) / topThree.length : 0
    const metrics = deriveMetrics(encoding.features)
    const penalties = detectPenalties(metrics, config)
    const structureScore = structureQuality(metrics)
    const facadeScore = clamp(metrics.facadeComplexity)
    const communityScore = clamp(best * 0.7 + topAverage * 0.3)
    const baseScore = communityScore * 0.45 + structureScore * 0.28 + facadeScore * 0.2 + metrics.symmetryRatio * 0.07
    const penaltyValue = penalties.reduce((sum, penalty) => sum + penalty.weight, 0)
    const aestheticScore = round(clamp(baseScore - penaltyValue))
    const accepted = aestheticScore >= config.aestheticThreshold &&
      best >= config.similarityThreshold &&
      !penalties.some(penalty => penalty.hard)

    return {
      ok: true,
      aesthetic_score: aestheticScore,
      similarity_to_good_builds: round(best),
      similarity_average_top3: round(topAverage),
      accepted,
      threshold: config.aestheticThreshold,
      similarityThreshold: config.similarityThreshold,
      bestMatch: similarities[0] || null,
      similarities,
      penalties,
      metrics,
      encoding
    }
  }
}

function normalizeEncoding(input, encoder) {
  if (input?.encoding?.ok && Array.isArray(input.encoding.vector)) return input.encoding
  if (input?.ok && Array.isArray(input.vector) && input.features) return input
  return encoder.encode(input)
}

function normalizeSampleEncodings(samples = [], encoder) {
  return (samples || [])
    .map(sample => {
      const encoding = sample.encoding?.ok ? sample.encoding : encoder.encode(sample.blueprint || sample)
      if (!encoding.ok || !encoding.similarityReady) return null
      return {
        id: sample.id || sample.blueprintName || encoding.blueprintName,
        blueprintName: sample.blueprintName || encoding.blueprintName,
        sourceKind: sample.sourceKind || 'community_sample',
        encoding
      }
    })
    .filter(Boolean)
}

function deriveMetrics(features = {}) {
  const uniqueHeights = features.shape?.uniqueColumnHeights || []
  const footprintFill = Number(features.shape?.footprintFill ?? features.silhouette?.footprintFill ?? 1)
  return {
    footprintFill,
    uniqueColumnHeights: uniqueHeights,
    heightVariance: Number(features.heightVariance || 0),
    heightVarianceNormalized: Number(features.silhouette?.heightVarianceNormalized || 0),
    facadeComplexity: Number(features.facadeComplexity || 0),
    facadeLayerCount: Number(features.facadeLayerCount || 0),
    windowGroups: Number(features.windowGroups || 0),
    materialDiversity: Number(features.materialDiversity || 0),
    nodeCount: Number(features.nodeCount || 0),
    edgeCount: Number(features.edgeCount || 0),
    symmetryRatio: Number(features.symmetryRatio ?? features.symmetryScore ?? 0),
    volumeDistribution: features.volumeDistribution || [],
    roofLevelCount: Number(features.shape?.roofLevels?.length || features.silhouette?.roofLevelCount || 0),
    densityVariance: Number(features.densitySummary?.variance || 0)
  }
}

function detectPenalties(metrics, config) {
  const penalties = []
  const boxLike = metrics.footprintFill >= config.maxBoxFootprintFill &&
    metrics.uniqueColumnHeights.length <= 1 &&
    metrics.facadeComplexity < config.minFacadeComplexity
  if (boxLike) penalties.push({ code: 'box_like_structure', weight: 0.3, hard: true })

  const flat = metrics.heightVariance < config.minHeightVariance && metrics.uniqueColumnHeights.length <= 1
  if (flat) penalties.push({ code: 'flat_structure', weight: 0.18, hard: true })

  const noLayering = metrics.facadeLayerCount < 2
  if (noLayering) penalties.push({ code: 'no_facade_layering', weight: 0.18, hard: true })

  if (metrics.nodeCount <= 1 && metrics.volumeDistribution[0] > 0.9) {
    penalties.push({ code: 'single_mass_volume', weight: 0.1, hard: false })
  }

  if (metrics.windowGroups <= 0 && metrics.materialDiversity <= 2) {
    penalties.push({ code: 'plain_material_surface', weight: 0.08, hard: false })
  }

  return penalties
}

function structureQuality(metrics) {
  const heightScore = clamp(metrics.heightVarianceNormalized * 0.55 + clamp(metrics.uniqueColumnHeights.length / 5) * 0.45)
  const volumeScore = clamp(clamp(metrics.nodeCount / 5) * 0.55 + volumeBalance(metrics.volumeDistribution) * 0.45)
  const silhouetteScore = clamp((1 - metrics.footprintFill) * 0.55 + clamp(metrics.roofLevelCount / 3) * 0.25 + clamp(metrics.densityVariance * 2) * 0.2)
  return round(heightScore * 0.38 + volumeScore * 0.34 + silhouetteScore * 0.28)
}

function volumeBalance(distribution = []) {
  if (!distribution.length) return 0
  if (distribution.length === 1) return distribution[0] < 0.85 ? 0.45 : 0.1
  const top = distribution[0] || 0
  const second = distribution[1] || 0
  return clamp(0.35 + second / Math.max(top, 0.01))
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round((Number(value) || 0) * scale) / scale
}

module.exports = {
  AestheticModel,
  AESTHETIC_DEFAULTS
}
