const DEFAULT_VERSION = '1.20.1'

const BLUEPRINT_ALIASES = Object.freeze({
  house: 'two_story_wood_house',
  survival_house: 'two_story_wood_house',
  wood_house: 'two_story_wood_house',
  wooden_house: 'two_story_wood_house',
  two_story_house: 'two_story_wood_house',
  two_storey_house: 'two_story_wood_house',
  two_story_wooden_house: 'two_story_wood_house',
  simple_two_story_cabin: 'simple_two_story_cabin',
  simple_two_story_wood_house: 'simple_two_story_cabin',
  simple_wood_cabin: 'simple_wood_cabin',
  wood_cabin: 'simple_wood_cabin',
  cabin: 'simple_wood_cabin',
  small_house: 'small_house',
  shelter: 'starter_shelter',
  starter: 'starter_shelter',
  starter_house: 'starter_shelter',
  starter_shelter: 'starter_shelter',
  farm_house: 'simple_farmhouse',
  farmhouse: 'simple_farmhouse',
  simple_farmhouse: 'simple_farmhouse',
  modern: 'modern_villa',
  modern_house: 'modern_villa',
  modern_villa: 'modern_villa',
  villa: 'modern_villa',
  castle: 'castle_garden',
  garden_castle: 'castle_garden',
  castle_garden: 'castle_garden',
  manor: 'garden_manor',
  garden_manor: 'garden_manor',
  statue: 'statue',
  sculpture: 'statue',
  fountain: 'fountain'
})

const MATERIAL_WEIGHTS = Object.freeze({
  air: 0,
  dirt: 1,
  grass_block: 1,
  oak_planks: 1.2,
  spruce_planks: 1.2,
  birch_planks: 1.2,
  oak_log: 1.6,
  cobblestone: 1.4,
  stone: 1.5,
  stone_bricks: 1.8,
  glass: 2,
  white_concrete: 2.4,
  white_wool: 1.5,
  blue_wool: 1.5,
  green_wool: 1.5,
  oak_fence: 2,
  chest: 3,
  crafting_table: 3,
  furnace: 4,
  white_bed: 4
})

function normalizeBlueprintRequest(input = {}) {
  const request = typeof input === 'string' ? { blueprintName: input } : { ...input }
  const rawName = request.blueprintName || request.target || request.name || request.style || request.type || ''
  const canonicalName = canonicalBlueprintName(rawName)
  return {
    ...request,
    requestedName: rawName || canonicalName,
    blueprintName: canonicalName || rawName || null,
    style: normalizeToken(request.style || canonicalName || rawName),
    type: normalizeToken(request.type || request.buildingType || canonicalName || rawName)
  }
}

function canonicalBlueprintName(name) {
  const normalized = normalizeToken(name)
  if (!normalized) return null
  return BLUEPRINT_ALIASES[normalized] || normalized
}

function rankBlueprintCandidate(candidate = {}, requestInput = {}, context = {}) {
  const request = normalizeBlueprintRequest(requestInput)
  const targetName = request.blueprintName
  const candidateName = canonicalBlueprintName(candidate.blueprintName || candidate.name || candidate.id)
  const candidateType = canonicalBlueprintName(candidate.buildingType || candidate.type || candidateName)
  const candidateStyle = normalizeToken(candidate.style || candidateType || candidateName)
  const tags = new Set((candidate.tags || []).map(normalizeToken))

  const compatibility = versionCompatibilityScore(candidate, context.version || DEFAULT_VERSION)
  const nameMatch = candidateName === targetName || candidateType === targetName ? 1 : 0
  const styleMatch = candidateStyle === request.style || tags.has(request.style) || tags.has(targetName) ? 1 : 0
  const popularity = popularityScore(candidate)
  const quality = qualityScore(candidate)
  const complexity = complexityScore(candidate, request)
  const materialCost = materialCostScore(candidate)
  const sourceBonus = sourceScore(candidate)

  const score =
    nameMatch * 42 +
    styleMatch * 20 +
    compatibility * 18 +
    popularity * 12 +
    quality * 8 +
    complexity * 4 +
    materialCost * 3 +
    sourceBonus

  const reasons = []
  if (nameMatch) reasons.push('name_match')
  if (styleMatch) reasons.push('style_match')
  if (compatibility >= 1) reasons.push('version_match')
  if (popularity >= 0.7) reasons.push('popular')
  if (quality >= 0.7) reasons.push('high_quality')
  if (candidate.fallback) reasons.push('fallback')

  return {
    ...candidate,
    score: Number(score.toFixed(3)),
    rank: {
      compatibility,
      nameMatch,
      styleMatch,
      popularity,
      quality,
      complexity,
      materialCost,
      sourceBonus,
      reasons
    }
  }
}

function evaluateBlueprintComplexity(blueprintOrCandidate = {}) {
  const blocks = Array.isArray(blueprintOrCandidate.blocks) ? blueprintOrCandidate.blocks : []
  const nonAir = blocks.filter(block => !isAir(block.type))
  if (!nonAir.length) {
    return {
      blockCount: Number(blueprintOrCandidate.blockCount || 0),
      materialTypes: 0,
      height: Number(blueprintOrCandidate.height || 0),
      footprint: Number(blueprintOrCandidate.footprint || 0),
      score: complexityLabelToScore(blueprintOrCandidate.complexity)
    }
  }

  const xs = nonAir.map(block => block.x)
  const ys = nonAir.map(block => block.y)
  const zs = nonAir.map(block => block.z)
  const materialTypes = new Set(nonAir.map(block => block.type)).size
  const width = Math.max(...xs) - Math.min(...xs) + 1
  const height = Math.max(...ys) - Math.min(...ys) + 1
  const depth = Math.max(...zs) - Math.min(...zs) + 1
  const score = Math.min(1, (nonAir.length / 120) * 0.55 + (height / 8) * 0.25 + (materialTypes / 8) * 0.2)
  return {
    blockCount: nonAir.length,
    materialTypes,
    width,
    height,
    depth,
    footprint: width * depth,
    score: Number(score.toFixed(3))
  }
}

function estimateMaterialCost(input = {}) {
  const materials = input.materials || materialCounts(input.blocks || [])
  let total = 0
  for (const [name, count] of Object.entries(materials)) {
    total += (MATERIAL_WEIGHTS[name] || 2) * count
  }
  return Number(total.toFixed(2))
}

function materialCounts(blocks = []) {
  const counts = {}
  for (const block of blocks) {
    if (!block?.type || isAir(block.type)) continue
    counts[block.type] = (counts[block.type] || 0) + 1
  }
  return counts
}

function versionCompatibilityScore(candidate = {}, version = DEFAULT_VERSION) {
  if (!candidate.versionRange && !candidate.versions) return 0.85
  if (Array.isArray(candidate.versions)) {
    return candidate.versions.includes(version) || candidate.versions.includes(versionMajorMinor(version)) ? 1 : 0
  }
  const range = candidate.versionRange || {}
  const current = versionTuple(version)
  const min = range.min ? versionTuple(range.min) : null
  const max = range.max ? versionTuple(range.max) : null
  if (min && compareVersionTuple(current, min) < 0) return 0
  if (max && compareVersionTuple(current, max) > 0) return 0
  return 1
}

function popularityScore(candidate = {}) {
  const rating = Math.max(0, Math.min(5, Number(candidate.rating || 0))) / 5
  const likes = Math.min(1, Math.log10(Math.max(1, Number(candidate.likes || 0))) / 4)
  const downloads = Math.min(1, Math.log10(Math.max(1, Number(candidate.downloads || 0))) / 5)
  return Number((rating * 0.45 + likes * 0.25 + downloads * 0.3).toFixed(3))
}

function qualityScore(candidate = {}) {
  if (typeof candidate.qualityScore === 'number') return Math.max(0, Math.min(1, candidate.qualityScore))
  const table = { high: 0.95, medium: 0.65, low: 0.35, fallback: 0.2 }
  return table[normalizeToken(candidate.quality)] ?? 0.55
}

function complexityScore(candidate = {}, request = {}) {
  const target = normalizeToken(request.complexity || request.complexityTarget || 'medium')
  const candidateScore = complexityLabelToScore(candidate.complexity)
  const targetScore = complexityLabelToScore(target)
  return Number((1 - Math.min(1, Math.abs(candidateScore - targetScore))).toFixed(3))
}

function materialCostScore(candidate = {}) {
  const estimate = Number(candidate.materialCost || candidate.estimatedMaterialCost || 0)
  if (!estimate) return 0.6
  return Number(Math.max(0, Math.min(1, 1 - estimate / 220)).toFixed(3))
}

function sourceScore(candidate = {}) {
  if (candidate.sourceKind === 'real_community_import' || candidate.sourceKind === 'faithful_community_import') return 9
  if (candidate.sourceKind === 'community_index') return 4
  if (candidate.sourceKind === 'local_library') return 2
  if (candidate.fallback) return -8
  return 0
}

function complexityLabelToScore(value) {
  const text = normalizeToken(value)
  if (text === 'tiny') return 0.15
  if (text === 'small') return 0.3
  if (text === 'medium') return 0.55
  if (text === 'large') return 0.8
  if (text === 'huge') return 1
  return 0.55
}

function versionTuple(version) {
  return String(version || DEFAULT_VERSION)
    .split('.')
    .map(part => Number(part.replace(/\D.*$/, '')) || 0)
    .concat([0, 0, 0])
    .slice(0, 3)
}

function compareVersionTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff) return diff
  }
  return 0
}

function versionMajorMinor(version) {
  const tuple = versionTuple(version)
  return `${tuple[0]}.${tuple[1]}`
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function isAir(type) {
  return ['air', 'cave_air', 'void_air'].includes(type)
}

module.exports = {
  BLUEPRINT_ALIASES,
  DEFAULT_VERSION,
  canonicalBlueprintName,
  estimateMaterialCost,
  evaluateBlueprintComplexity,
  materialCounts,
  normalizeBlueprintRequest,
  rankBlueprintCandidate,
  versionCompatibilityScore
}
