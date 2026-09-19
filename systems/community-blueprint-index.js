const fs = require('fs')
const path = require('path')
const { canonicalBlueprintName, normalizeBlueprintRequest } = require('../utils/blueprint-ranking')

const DEFAULT_CACHE_INDEX = path.join(process.cwd(), 'data', 'community-builds', 'cache', 'index.json')

const DEFAULT_SOURCES = Object.freeze([
  {
    id: 'community-cache',
    name: 'Local cached Minecraft community blueprint index',
    type: 'offline_index',
    prioritySignals: ['rating', 'likes', 'downloads', 'versionRange']
  },
  {
    id: 'local-library',
    name: 'Built-in LinXia blueprint library',
    type: 'local_library',
    prioritySignals: ['style', 'complexity', 'materialCost']
  },
  {
    id: 'procedural-fallback',
    name: 'Procedural fallback blueprint generator',
    type: 'procedural_generator',
    prioritySignals: ['availability']
  }
])

const DEFAULT_CANDIDATES = Object.freeze([
  community('pmc-survival-house-compact', 'two_story_wood_house', {
    displayName: 'Compact Two-story Survival House',
    style: 'survival',
    buildingType: 'two_story_wood_house',
    tags: ['house', 'survival', 'wood', 'two_story'],
    rating: 4.8,
    likes: 4820,
    downloads: 21000,
    complexity: 'medium',
    materialCost: 118,
    generatorKey: 'two_story_wood_house'
  }),
  community('mcpedl-starter-shelter-open', 'starter_shelter', {
    displayName: 'Open Starter Shelter',
    style: 'starter',
    buildingType: 'starter_shelter',
    tags: ['shelter', 'starter', 'survival'],
    rating: 4.6,
    likes: 2200,
    downloads: 11800,
    complexity: 'small',
    materialCost: 54,
    generatorKey: 'starter_shelter'
  }),
  community('community-simple-farmhouse-a', 'simple_farmhouse', {
    displayName: 'Simple Farmhouse With Crop Yard',
    style: 'farmhouse',
    buildingType: 'simple_farmhouse',
    tags: ['farmhouse', 'farm', 'garden', 'house'],
    rating: 4.7,
    likes: 3050,
    downloads: 14200,
    complexity: 'medium',
    materialCost: 96,
    generatorKey: 'simple_farmhouse'
  }),
  community('modern-villa-highlike-01', 'modern_villa', {
    displayName: 'Compact Modern Villa',
    style: 'modern',
    buildingType: 'modern_villa',
    tags: ['modern', 'villa', 'multi_room', 'glass'],
    rating: 4.9,
    likes: 6100,
    downloads: 32200,
    complexity: 'medium',
    materialCost: 108,
    generatorKey: 'modern_villa'
  }),
  community('castle-garden-survival-01', 'castle_garden', {
    displayName: 'Mini Castle With Garden',
    style: 'castle',
    buildingType: 'castle_garden',
    tags: ['castle', 'garden', 'stone', 'courtyard'],
    rating: 4.85,
    likes: 5300,
    downloads: 28700,
    complexity: 'large',
    materialCost: 136,
    generatorKey: 'castle_garden'
  }),
  community('garden-manor-compact-01', 'garden_manor', {
    displayName: 'Garden Manor Starter',
    style: 'manor',
    buildingType: 'garden_manor',
    tags: ['garden', 'manor', 'house'],
    rating: 4.65,
    likes: 2600,
    downloads: 12100,
    complexity: 'medium',
    materialCost: 118,
    generatorKey: 'garden_manor'
  }),
  community('statue-white-compact-01', 'statue', {
    displayName: 'Compact White Statue',
    style: 'art',
    buildingType: 'statue',
    tags: ['statue', 'sculpture', 'decorative'],
    rating: 4.55,
    likes: 1900,
    downloads: 8800,
    complexity: 'small',
    materialCost: 36,
    generatorKey: 'statue'
  }),
  community('fountain-blue-compact-01', 'fountain', {
    displayName: 'Compact Courtyard Fountain',
    style: 'art',
    buildingType: 'fountain',
    tags: ['fountain', 'decorative', 'water_feature'],
    rating: 4.7,
    likes: 2400,
    downloads: 11000,
    complexity: 'small',
    materialCost: 42,
    generatorKey: 'fountain'
  }),
  local('local-small-house-json', 'small_house', {
    displayName: 'Legacy Small House JSON',
    tags: ['small_house', 'starter', 'legacy'],
    localName: 'small_house',
    complexity: 'small',
    materialCost: 32
  }),
  local('local-farm-plot-json', 'farm_plot', {
    displayName: 'Legacy Farm Plot JSON',
    tags: ['farm_plot', 'farm'],
    localName: 'farm_plot',
    complexity: 'small',
    materialCost: 34
  })
])

class CommunityBlueprintIndex {
  constructor(options = {}) {
    this.sources = options.sources || DEFAULT_SOURCES
    this.candidates = options.candidates || DEFAULT_CANDIDATES
    this.available = options.available !== false
    this.cacheIndexPath = options.cacheIndexPath || DEFAULT_CACHE_INDEX
    this.useVerifiedCache = options.useVerifiedCache !== false
  }

  listSources() {
    return [...this.sources]
  }

  listCandidates() {
    return [...this.findCachedCandidates({}), ...this.candidates]
  }

  findCandidates(input = {}) {
    const request = normalizeBlueprintRequest(input)
    const target = request.blueprintName
    if (!target) return []

    const cached = this.available && this.useVerifiedCache
      ? this.findCachedCandidates(request)
      : []
    if (cached.length) return cached

    const candidates = this.available
      ? this.candidates.filter(candidate => matchesCandidate(candidate, request))
      : this.candidates.filter(candidate => candidate.sourceKind !== 'community_index' && matchesCandidate(candidate, request))

    return candidates.length ? candidates : this.fallbackCandidates(target)
  }

  readCacheIndex() {
    if (!this.useVerifiedCache || !fs.existsSync(this.cacheIndexPath)) return null
    try {
      return JSON.parse(fs.readFileSync(this.cacheIndexPath, 'utf8'))
    } catch {
      return null
    }
  }

  findCachedCandidates(input = {}) {
    const request = normalizeBlueprintRequest(input)
    const index = this.readCacheIndex()
    if (!index?.samples?.length) return []
    const candidates = index.samples
      .filter(isSelectableFaithfulSample)
      .map(sample => cachedSampleCandidate(sample))
    if (!request.blueprintName) return candidates
    return candidates.filter(candidate => matchesCandidate(candidate, request))
  }

  fallbackCandidates(name) {
    const blueprintName = canonicalBlueprintName(name) || 'starter_shelter'
    return [
      {
        id: `fallback-${blueprintName}`,
        blueprintName,
        displayName: `Fallback ${blueprintName}`,
        sourceKind: 'procedural_fallback',
        sourceName: 'procedural-fallback',
        generatorKey: blueprintName,
        style: blueprintName,
        buildingType: blueprintName,
        tags: [blueprintName, 'fallback'],
        rating: 2,
        likes: 0,
        downloads: 0,
        quality: 'fallback',
        complexity: 'small',
        fallback: true,
        versionRange: { min: '1.20.0', max: '1.20.6' }
      }
    ]
  }
}

function isSelectableFaithfulSample(sample = {}) {
  if (!String(sample.importStatus || '').startsWith('verified')) return false
  if (sample.sourceMode !== 'faithful-community-import') return false
  if (!sample.adaptation) return true
  return sample.adaptation.usesProceduralFallback === false
}

function community(id, blueprintName, extra = {}) {
  return {
    id,
    blueprintName,
    sourceKind: 'community_index',
    sourceName: 'community-cache',
    quality: 'high',
    versionRange: { min: '1.20.0', max: '1.20.6' },
    ...extra
  }
}

function local(id, blueprintName, extra = {}) {
  return {
    id,
    blueprintName,
    sourceKind: 'local_library',
    sourceName: 'local-library',
    quality: 'medium',
    versionRange: { min: '1.20.0', max: '1.20.6' },
    ...extra
  }
}

function matchesCandidate(candidate, request) {
  const target = request.blueprintName
  const names = [
    candidate.id,
    candidate.blueprintName,
    candidate.localName,
    candidate.generatorKey,
    candidate.style,
    candidate.buildingType,
    ...(candidate.tags || [])
  ].map(canonicalBlueprintName).filter(Boolean)
  return names.includes(target)
}

function cachedSampleCandidate(sample = {}) {
  const blueprintName = canonicalBlueprintName(sample.buildingType || sample.category || sample.style || sample.id) ||
    sample.buildingType ||
    sample.category ||
    sample.id
  return {
    id: sample.id,
    blueprintName,
    displayName: sample.buildTitle || sample.id,
    sourceKind: 'real_community_import',
    sourceName: sample.repository || sample.source || 'verified-community-cache',
    sourceMode: sample.sourceMode || 'faithful-community-import',
    quality: 'verified_real_community',
    versionRange: { min: '1.20.0', max: '1.20.6' },
    style: sample.style || sample.category || blueprintName,
    buildingType: sample.buildingType || blueprintName,
    structureUse: sample.structureUse || null,
    tags: [
      sample.id,
      sample.buildTitle,
      sample.category,
      sample.style,
      sample.buildingType,
      blueprintName,
      'faithful-community-import',
      'real-community-import'
    ].filter(Boolean),
    rating: sample.ratingMetadata?.rating || 4.8,
    likes: sample.ratingMetadata?.likes ?? sample.ratingMetadata?.stars ?? 0,
    downloads: sample.ratingMetadata?.downloads ?? 0,
    complexity: sample.encodingSummary?.blockCount > 5000 ? 'large' : 'medium',
    materialCost: sample.encodingSummary?.blockCount || 160,
    localBlueprintPath: sample.localBlueprintPath,
    localRawPath: sample.localRawPath,
    cacheHash: sample.cacheHash,
    structureFileFormat: sample.structureFileFormat,
    author: sample.author,
    buildTitle: sample.buildTitle,
    category: sample.category,
    requiredStories: sample.requiredStories,
    importStatus: sample.importStatus,
    license: sample.license || null,
    ratingMetadata: sample.ratingMetadata || null,
    hardGate: sample.hardGate || null,
    cacheEvidence: true
  }
}

module.exports = {
  CommunityBlueprintIndex,
  DEFAULT_CANDIDATES,
  DEFAULT_SOURCES,
  _test: {
    isSelectableFaithfulSample
  }
}
