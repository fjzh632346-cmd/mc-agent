const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', undefined, null])
const DOOR_PATTERN = /(^|_)door$/
const TRAPDOOR_PATTERN = /trapdoor$/
const STAIR_PATTERN = /stairs$/
const CLIMBABLE_BLOCKS = new Set(['ladder', 'vine', 'scaffolding'])
const FUNCTIONAL_BLOCK_PATTERN = /(^|_)(bed|chest|trapped_chest|furnace|blast_furnace|smoker|crafting_table)$/
const {
  legacyBlockStateMismatch,
  legacySkullPlacement,
  modernizeLegacyBlock
} = require('../utils/legacy-block-compat')
const { isGrassSmotheringCover } = require('../utils/site-planner')
const {
  LIVE_SIGNAL_STATE_KEYS,
  isRedstoneWireConnectionKey,
  isStairsShapeKey,
  isSignalLitBlockName
} = require('../utils/derived-placement-state-keys')

// Structure-use classification. Habitability checks are a residential ruler;
// walls, watchtowers, and similar structures are judged on structural checks
// only. Classification is EXPLICIT (curated source/blueprint metadata) and
// defaults to residential, so a blueprint can never dodge the habitability
// gate by merely lacking interior features.
const STRUCTURE_USES = Object.freeze(['residential', 'nonresidential'])
const NONRESIDENTIAL_CHECKS = Object.freeze([
  'minNonAirBlocks',
  'minHeight',
  'remainingScaffoldCount'
])

const DEFAULT_LIMITS = Object.freeze({
  generic: {
    minWidth: 5,
    minDepth: 5,
    minHeight: 4,
    minNonAirBlocks: 48,
    minInteriorVolume: 4,
    minDoorCount: 1,
    minGlassCount: 0,
    minFunctionCount: 0,
    minStories: 1,
    minRoofCoverage: 0.84
  },
  wood: {
    minWidth: 13,
    minDepth: 11,
    minHeight: 8,
    minNonAirBlocks: 250,
    minInteriorVolume: 12,
    minDoorCount: 1,
    minGlassCount: 0,
    minFunctionCount: 1,
    minStories: 2,
    minRoofCoverage: 0.86
  },
  villa: {
    // Boss decision #30 (2026-09-01): residential ruler relaxed one notch —
    // minWidth 18->17, minInteriorVolume 16->15. Every other floor unchanged.
    minWidth: 17,
    minDepth: 14,
    minHeight: 8,
    minNonAirBlocks: 450,
    minInteriorVolume: 15,
    minDoorCount: 1,
    minGlassCount: 8,
    minFunctionCount: 1,
    minStories: 2,
    minRoofCoverage: 0.82
  },
  castle: {
    minWidth: 13,
    minDepth: 13,
    minHeight: 8,
    minNonAirBlocks: 350,
    minInteriorVolume: 8,
    minDoorCount: 1,
    minGlassCount: 0,
    minFunctionCount: 0,
    minStories: 1,
    minRoofCoverage: 0.68
  },
  // Small modern houses measured 17x10x15 with interior volume 15 failed the
  // pre-decision-#30 villa ruler (minWidth 18, interior 16) on size alone;
  // under the relaxed villa ruler they now qualify directly. This tier stays
  // for smaller cottages: it relaxes ONLY footprint/size and interior volume
  // relative to villa; doors, glass, stories, roof, and function floors stay
  // at the villa values. It is reachable ONLY via explicit annotation - the
  // name regex never selects it (see classifyBlueprint).
  modern_cottage: {
    minWidth: 14,
    minDepth: 8,
    minHeight: 8,
    minNonAirBlocks: 300,
    minInteriorVolume: 12,
    minDoorCount: 1,
    minGlassCount: 8,
    minFunctionCount: 1,
    minStories: 2,
    minRoofCoverage: 0.82
  }
})

// Categories that may be selected by explicit human annotation. Regex
// inference must never land here, so an unlabeled "modern" build keeps the
// strictest villa ruler instead of silently downgrading.
const EXPLICIT_ANNOTATION_CATEGORIES = new Set(['modern_cottage'])

class FaithfulCommunityValidator {
  constructor(options = {}) {
    this.options = {
      requireSourceMode: options.requireSourceMode === true,
      minFidelityRatio: options.minFidelityRatio ?? 0.985,
      minPresentRatio: options.minPresentRatio ?? 0.995,
      minBlockStateFidelityRatio: options.minBlockStateFidelityRatio ?? 0.95,
      maxExtraBlockRatio: options.maxExtraBlockRatio ?? 0.015,
      maxBoundingBoxShrinkBlocks: options.maxBoundingBoxShrinkBlocks ?? 0,
      maxShellLeakCount: options.maxShellLeakCount ?? 0,
      maxScaffoldCount: options.maxScaffoldCount ?? 0,
      ...options
    }
  }

  validateBlueprint(blueprint, request = {}, options = {}) {
    const config = { ...this.options, ...options }
    const summary = summarizeBlueprint(blueprint, request)
    const failures = []

    if (!summary.ok) failures.push(summary.error || 'invalid_blueprint')
    if (config.requireSourceMode && !isFaithfulCommunityImport(blueprint, request.selected)) {
      failures.push('source_mode_not_faithful_community_import')
    }
    if (!summary.metrics.nonAirBlocks) failures.push('empty_blueprint')

    const limits = limitsFor(summary.category, request, options)
    const structureUse = resolveStructureUse(blueprint, request)
    const checks = {
      minNonAirBlocks: summary.metrics.nonAirBlocks >= limits.minNonAirBlocks,
      minWidth: summary.metrics.bounds.width >= limits.minWidth,
      minDepth: summary.metrics.bounds.depth >= limits.minDepth,
      minHeight: summary.metrics.bounds.height >= limits.minHeight,
      actualDoorCount: summary.metrics.doorCount >= limits.minDoorCount,
      glassWindowCount: summary.metrics.glassCount >= limits.minGlassCount,
      detectedStories: summary.metrics.detectedStories >= limits.minStories,
      usableInteriorVolume: summary.metrics.usableInteriorVolume >= limits.minInteriorVolume,
      shellLeakCount: summary.metrics.shellLeakCount <= config.maxShellLeakCount,
      completeRoof: summary.metrics.roofCoverage >= limits.minRoofCoverage,
      verticalAccess: limits.minStories <= 1 || summary.metrics.verticalAccessCount >= 1,
      functionalBlocksPresent: summary.metrics.functionalBlockCount >= limits.minFunctionCount,
      remainingScaffoldCount: summary.metrics.scaffoldCount <= config.maxScaffoldCount
    }
    const enforcedChecks = structureUse === 'nonresidential'
      ? Object.fromEntries(NONRESIDENTIAL_CHECKS.map(name => [name, checks[name]]))
      : checks

    for (const [name, ok] of Object.entries(enforcedChecks)) {
      if (!ok) failures.push(name)
    }

    return {
      ok: failures.length === 0,
      failures,
      hardConstraints: enforcedChecks,
      metrics: summary.metrics,
      category: summary.category,
      limits,
      structureUse
    }
  }

  compareExpectedActual(expectedBlueprint, actualBlueprint, request = {}, options = {}) {
    const config = { ...this.options, ...options }
    const expectedBlocks = nonAirBlocks(expectedBlueprint)
    const actualBlocks = nonAirBlocks(actualBlueprint)
    const expectedMap = blockMap(expectedBlocks)
    const actualMap = blockMap(actualBlocks)
    const failures = []

    if (!expectedBlocks.length) failures.push('expected_blueprint_empty')
    if (!actualBlocks.length) failures.push('actual_world_scan_empty')

    let exactMatches = 0
    let presentExpected = 0
    let statefulExpected = 0
    let stateMatches = 0
    const mismatches = []
    for (const expected of expectedBlocks) {
      const actual = actualMap.get(posKey(expected))
      if (!actual || isAir(actual.type)) {
        mismatches.push({ position: compactPos(expected), expected: expected.type, actual: 'air' })
        continue
      }
      presentExpected += 1
      const runtimeExpected = modernizeLegacyBlock(expected.type, expected.states)
      const typeMatches = normalizeType(actual.type) === normalizeType(runtimeExpected.blockName)
      // Covered-grass decay exemption: skip the state comparison too — dirt
      // cannot carry grass states, and the decay itself is the exempted event.
      const coveredGrassDecay = !typeMatches && coveredGrassDecayEquivalent(expected, actual, expectedMap)
      if (typeMatches || coveredGrassDecay) {
        exactMatches += 1
        if (typeMatches && hasStates(expected)) {
          statefulExpected += 1
          if (statesMatch(expected.states, actual.states, expected.type)) stateMatches += 1
          else mismatches.push({
            position: compactPos(expected),
            expected: expected.type,
            actual: actual.type,
            expectedStates: expected.states,
            actualStates: actual.states || null
          })
        }
      } else {
        mismatches.push({ position: compactPos(expected), expected: expected.type, actual: actual.type })
      }
    }

    const extras = []
    for (const actual of actualBlocks) {
      if (expectedMap.has(posKey(actual))) continue
      extras.push({ position: compactPos(actual), type: actual.type })
    }

    const expectedTotal = expectedBlocks.length
    const fidelityRatio = expectedTotal ? round(exactMatches / expectedTotal) : 0
    const presentRatio = expectedTotal ? round(presentExpected / expectedTotal) : 0
    const blockStateFidelityRatio = statefulExpected ? round(stateMatches / statefulExpected) : 1
    const extraBlockRatio = expectedTotal ? round(extras.length / expectedTotal) : 1
    const expectedBounds = expectedTotal ? boundsFor(expectedBlocks) : null
    const actualBounds = actualBlocks.length ? boundsFor(actualBlocks) : null
    const shrink = compareBoundsShrink(expectedBounds, actualBounds)
    const livability = this.validateBlueprint(actualBlueprint, request, {
      ...options,
      requireSourceMode: false
    })

    if (fidelityRatio < config.minFidelityRatio) failures.push('fidelity_ratio_below_threshold')
    if (presentRatio < config.minPresentRatio) failures.push('present_ratio_below_threshold')
    if (blockStateFidelityRatio < config.minBlockStateFidelityRatio) failures.push('block_state_fidelity_below_threshold')
    if (extraBlockRatio > config.maxExtraBlockRatio) failures.push('extra_block_ratio_above_threshold')
    if (shrink.maxShrink > config.maxBoundingBoxShrinkBlocks) failures.push('actual_bounding_box_smaller_than_expected')
    if (!livability.ok) failures.push(...livability.failures.map(failure => `actual_${failure}`))

    return {
      ok: failures.length === 0,
      failures,
      metrics: {
        expectedBlocks: expectedTotal,
        actualBlocks: actualBlocks.length,
        exactMatches,
        presentExpected,
        statefulExpected,
        stateMatches,
        missingOrWrongCount: mismatches.length,
        extraBlockCount: extras.length,
        fidelityRatio,
        presentRatio,
        blockStateFidelityRatio,
        extraBlockRatio,
        expectedBounds: summarizeBounds(expectedBounds),
        actualBounds: summarizeBounds(actualBounds),
        boundingBoxShrink: shrink,
        sampleMismatches: mismatches.slice(0, 12),
        sampleExtras: extras.slice(0, 12),
        livability: livability.metrics
      },
      livability
    }
  }
}

function summarizeBlueprint(blueprint, request = {}) {
  if (!blueprint || !Array.isArray(blueprint.blocks)) {
    return { ok: false, error: 'invalid_blueprint_for_faithful_validation', metrics: emptyMetrics(), category: 'generic' }
  }

  const blocks = nonAirBlocks(blueprint)
  if (!blocks.length) {
    return { ok: true, metrics: emptyMetrics(), category: classifyBlueprint(blueprint, request) }
  }

  const bounds = boundsFor(blocks)
  const map = blockMap(blocks)
  const standable = findStandableCells(map, bounds)
  const exterior = floodExterior(map, expandBounds(bounds, 1))
  const interior = standable.filter(cell => !exterior.has(posKey(cell)))
  const exposed = exposedInteriorCells(interior, exterior, map)
  const stories = detectStories(interior, bounds, standable, map)
  const roof = roofCoverage(interior, map, bounds)
  const materialCounts = countMaterials(blocks)
  const doorCount = blocks.filter(block => isRealDoor(block.type)).length
  const glassCount = blocks.filter(block => isGlass(block.type)).length
  const verticalAccessCount = blocks.filter(block => isStair(block.type) || isClimbable(block.type)).length
  const functionalBlockCount = blocks.filter(block => isFunctionalBlock(block.type)).length
  const scaffoldCount = blocks.filter(block => block.type === 'scaffolding').length

  return {
    ok: true,
    category: classifyBlueprint(blueprint, request),
    metrics: {
      sourceMode: blueprint.metadata?.sourceMode || null,
      sourceKind: blueprint.metadata?.sourceKind || null,
      nonAirBlocks: blocks.length,
      materialCounts,
      bounds: summarizeBounds(bounds),
      doorCount,
      glassCount,
      verticalAccessCount,
      functionalBlockCount,
      scaffoldCount,
      usableInteriorVolume: interior.length,
      standableCellCount: standable.length,
      shellLeakCount: exposed.length,
      exposedInteriorCells: exposed.length,
      exposedCells: exposed.slice(0, 16),
      detectedStories: stories.detectedStories,
      storyLevels: stories.storyLevels,
      roofCoverage: roof.coverage,
      completeRoof: roof.completeRoof
    }
  }
}

function isFaithfulCommunityImport(blueprint = {}, selected = {}) {
  return blueprint?.metadata?.sourceMode === 'faithful-community-import' ||
    selected?.sourceMode === 'faithful-community-import'
}

function resolveStructureUse(blueprint = {}, request = {}) {
  const declared = [
    request.structureUse,
    request.selected?.structureUse,
    blueprint.metadata?.structureUse
  ]
  for (const value of declared) {
    const normalized = String(value || '').trim().toLowerCase()
    if (STRUCTURE_USES.includes(normalized)) return normalized
  }
  return 'residential'
}

function limitsFor(category, request = {}, options = {}) {
  const base = DEFAULT_LIMITS[category] || DEFAULT_LIMITS.generic
  const requiredStories = Number(request.requiredStories || options.requiredStories || 0)
  return {
    ...base,
    minStories: requiredStories > 0 ? Math.max(base.minStories, requiredStories) : base.minStories
  }
}

function classifyBlueprint(blueprint = {}, request = {}) {
  const declaredCategory = [
    request.buildingCategory,
    request.selected?.buildingCategory,
    blueprint.metadata?.buildingCategory
  ]
  for (const value of declaredCategory) {
    const normalized = String(value || '').trim().toLowerCase()
    if (EXPLICIT_ANNOTATION_CATEGORIES.has(normalized)) return normalized
  }
  const text = [
    request.blueprintName,
    request.type,
    request.style,
    request.selected?.buildingType,
    request.selected?.style,
    blueprint.name,
    blueprint.metadata?.buildingType,
    blueprint.metadata?.category,
    blueprint.metadata?.style
  ].filter(Boolean).join(' ').toLowerCase()
  if (/(modern|villa)/.test(text)) return 'villa'
  if (/(castle|manor|fort|tower)/.test(text)) return 'castle'
  if (/(wood|wooden|house|survival|starter)/.test(text)) return 'wood'
  return 'generic'
}

function findStandableCells(blockMap, bounds) {
  const cells = []
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY + 1; y <= bounds.maxY - 1; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const cell = { x, y, z }
        if (!cellPassable(cell, blockMap)) continue
        if (!cellPassable({ x, y: y + 1, z }, blockMap)) continue
        if (!isWalkableSupport(blockAt({ x, y: y - 1, z }, blockMap)?.type)) continue
        cells.push(cell)
      }
    }
  }
  return cells
}

function floodExterior(blockMap, bounds) {
  const visited = new Set()
  const queue = []
  const enqueue = cell => {
    if (!inside(cell, bounds) || !cellPassableForShell(cell, blockMap)) return
    const key = posKey(cell)
    if (visited.has(key)) return
    visited.add(key)
    queue.push(cell)
  }

  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      enqueue({ x, y, z: bounds.minZ })
      enqueue({ x, y, z: bounds.maxZ })
    }
  }
  for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      enqueue({ x: bounds.minX, y, z })
      enqueue({ x: bounds.maxX, y, z })
    }
  }
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      enqueue({ x, y: bounds.minY, z })
      enqueue({ x, y: bounds.maxY, z })
    }
  }

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    for (const next of adjacent6(current)) enqueue(next)
  }
  return visited
}

function exposedInteriorCells(interiorCells, exterior, blockMap) {
  const exposed = []
  for (const cell of interiorCells) {
    if (nearDoor(cell, blockMap, 2)) continue
    const openToExterior = adjacentHorizontal(cell).some(next => {
      const nextBlock = blockAt(next, blockMap)
      return exterior.has(posKey(next)) && !isRealDoor(nextBlock?.type)
    })
    if (openToExterior) exposed.push(compactPos(cell))
  }
  return exposed
}

function nearDoor(cell, blockMap, radius = 1) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > radius) continue
        const block = blockAt({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }, blockMap)
        if (isRealDoor(block?.type)) return true
      }
    }
  }
  return false
}

function detectStories(interiorCells, bounds, standableCells = [], blockMap = null) {
  let storyLevels = storyLevelsFor(interiorCells, bounds)
  if (storyLevels.length < 2 && standableCells.length && blockMap) {
    const roofedStandable = standableCells.filter(cell => hasSolidAbove(cell, blockMap, bounds))
    const fallbackLevels = storyLevelsFor(roofedStandable, bounds)
    if (fallbackLevels.length > storyLevels.length) storyLevels = fallbackLevels
  }
  return {
    detectedStories: storyLevels.length || (interiorCells.length ? 1 : 0),
    storyLevels
  }
}

function storyLevelsFor(cells, bounds) {
  const counts = new Map()
  for (const cell of cells) counts.set(cell.y, (counts.get(cell.y) || 0) + 1)
  const footprint = Math.max(1, (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1))
  const minCells = Math.max(4, Math.min(6, Math.floor(footprint * 0.025)))
  const levels = [...counts.entries()]
    .filter(([, count]) => count >= minCells)
    .map(([y]) => y)
    .sort((a, b) => a - b)
  const stories = []
  for (const y of levels) {
    if (!stories.length || y - stories[stories.length - 1] >= 3) stories.push(y)
  }
  return stories
}

function roofCoverage(interiorCells, blockMap, bounds) {
  if (!interiorCells.length) return { coverage: 0, completeRoof: false }
  let covered = 0
  for (const cell of interiorCells) {
    if (hasSolidAbove(cell, blockMap, bounds)) covered += 1
  }
  const coverage = round(covered / interiorCells.length)
  return {
    coverage,
    completeRoof: coverage >= 0.84
  }
}

function hasSolidAbove(cell, blockMap, bounds) {
  for (let y = cell.y + 2; y <= bounds.maxY; y++) {
    if (!isAir(blockAt({ x: cell.x, y, z: cell.z }, blockMap)?.type)) return true
  }
  return false
}

function compareBoundsShrink(expected, actual) {
  if (!expected || !actual) return { width: Infinity, height: Infinity, depth: Infinity, maxShrink: Infinity }
  const expectedSummary = summarizeBounds(expected)
  const actualSummary = summarizeBounds(actual)
  const shrink = {
    width: expectedSummary.width - actualSummary.width,
    height: expectedSummary.height - actualSummary.height,
    depth: expectedSummary.depth - actualSummary.depth
  }
  return {
    ...shrink,
    maxShrink: Math.max(shrink.width, shrink.height, shrink.depth)
  }
}

function nonAirBlocks(blueprint = {}) {
  return (blueprint.blocks || []).filter(block => block && !isAir(block.type))
}

function blockMap(blocks = []) {
  return new Map(blocks.map(block => [posKey(block), block]))
}

function boundsFor(blocks = []) {
  const first = blocks[0]
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.x),
    maxX: Math.max(bounds.maxX, block.x),
    minY: Math.min(bounds.minY, block.y),
    maxY: Math.max(bounds.maxY, block.y),
    minZ: Math.min(bounds.minZ, block.z),
    maxZ: Math.max(bounds.maxZ, block.z)
  }), {
    minX: first.x,
    maxX: first.x,
    minY: first.y,
    maxY: first.y,
    minZ: first.z,
    maxZ: first.z
  })
}

function summarizeBounds(bounds) {
  if (!bounds) {
    return { minX: 0, maxX: -1, minY: 0, maxY: -1, minZ: 0, maxZ: -1, width: 0, height: 0, depth: 0 }
  }
  return {
    ...bounds,
    width: bounds.maxX - bounds.minX + 1,
    height: bounds.maxY - bounds.minY + 1,
    depth: bounds.maxZ - bounds.minZ + 1
  }
}

function emptyMetrics() {
  return {
    sourceMode: null,
    sourceKind: null,
    nonAirBlocks: 0,
    materialCounts: {},
    bounds: summarizeBounds(null),
    doorCount: 0,
    glassCount: 0,
    verticalAccessCount: 0,
    functionalBlockCount: 0,
    scaffoldCount: 0,
    usableInteriorVolume: 0,
    standableCellCount: 0,
    shellLeakCount: 0,
    exposedInteriorCells: 0,
    exposedCells: [],
    detectedStories: 0,
    storyLevels: [],
    roofCoverage: 0,
    completeRoof: false
  }
}

function countMaterials(blocks = []) {
  const counts = {}
  for (const block of blocks) counts[block.type] = (counts[block.type] || 0) + 1
  return counts
}

function expandBounds(bounds, amount = 1) {
  return {
    minX: bounds.minX - amount,
    maxX: bounds.maxX + amount,
    minY: bounds.minY - amount,
    maxY: bounds.maxY + amount,
    minZ: bounds.minZ - amount,
    maxZ: bounds.maxZ + amount
  }
}

function adjacent6(cell) {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y + 1, z: cell.z },
    { x: cell.x, y: cell.y - 1, z: cell.z },
    { x: cell.x, y: cell.y, z: cell.z + 1 },
    { x: cell.x, y: cell.y, z: cell.z - 1 }
  ]
}

function adjacentHorizontal(cell) {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y, z: cell.z + 1 },
    { x: cell.x, y: cell.y, z: cell.z - 1 }
  ]
}

function inside(cell, bounds) {
  return cell.x >= bounds.minX && cell.x <= bounds.maxX &&
    cell.y >= bounds.minY && cell.y <= bounds.maxY &&
    cell.z >= bounds.minZ && cell.z <= bounds.maxZ
}

function cellPassable(cell, blockMap) {
  const block = blockAt(cell, blockMap)
  return isAir(block?.type) ||
    isPassableDecor(block?.type) ||
    isClimbable(block?.type) ||
    isRealDoor(block?.type) ||
    isPassableTrapdoor(block)
}

function cellPassableForShell(cell, blockMap) {
  const block = blockAt(cell, blockMap)
  return isAir(block?.type) ||
    isPassableDecor(block?.type) ||
    isClimbable(block?.type) ||
    isPassableTrapdoor(block)
}

function isWalkableSupport(type) {
  const name = String(type || '')
  if (isAir(name) || isPassableDecor(name) || isClimbable(name) || isRealDoor(name)) return false
  if (name.includes('glass') || name.includes('fence') || name.includes('wall') || name.includes('pane')) return false
  return true
}

function isPassableDecor(type) {
  const name = String(type || '')
  return ['torch', 'lantern', 'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'flower_pot', 'cake'].includes(name) ||
    name.endsWith('_carpet') ||
    name.endsWith('_wall_sign') ||
    name.endsWith('_sign') ||
    name.endsWith('_candle') ||
    name.startsWith('potted_')
}

function isPassableTrapdoor(block) {
  const name = String(block?.type || '')
  return TRAPDOOR_PATTERN.test(name) && String(block?.states?.open) === 'true'
}

function isFunctionalBlock(type) {
  return FUNCTIONAL_BLOCK_PATTERN.test(String(type || ''))
}

function isRealDoor(type) {
  const name = String(type || '')
  return DOOR_PATTERN.test(name) && !TRAPDOOR_PATTERN.test(name)
}

function isStair(type) {
  return STAIR_PATTERN.test(String(type || ''))
}

function isClimbable(type) {
  return CLIMBABLE_BLOCKS.has(String(type || ''))
}

function isGlass(type) {
  return String(type || '').includes('glass')
}

function isAir(type) {
  return AIR_BLOCKS.has(type)
}

function blockAt(cell, blockMap) {
  return blockMap.get(posKey(cell))
}

function normalizeType(type) {
  return String(type || '')
}

function hasStates(block = {}) {
  return block.states && typeof block.states === 'object' && Object.keys(block.states).length > 0
}

function statesMatch(expected = {}, actual = {}, blockType = null) {
  if (!expected || typeof expected !== 'object') return true
  if (!actual || typeof actual !== 'object') return false
  if (legacySkullPlacement(blockType, expected)) {
    return !legacyBlockStateMismatch(actual, blockType, expected)
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!isComparableStateKey(blockType, key)) continue
    if (String(actual[key]) !== String(value)) return false
  }
  return true
}

// Boss-decreed exemption (round 9 ruling, same class as the door-hinge
// concession): grass_block that the blueprint itself covers with a non-air
// block at (x, y+1, z) inevitably decays to dirt under vanilla rules, so the
// bot can never maintain it. One-way ONLY — expected grass_block with actual
// dirt; the reverse and every other type difference stay enforced. Coverage is
// judged from the blueprint (expectedMap holds non-air blueprint blocks only),
// never from the live world, and only covers that actually smother grass
// qualify (shared isGrassSmotheringCover — snow layers, glass, and leaves let
// grass survive, so those cells stay enforced). Executor twin:
// isCoveredGrassDecayEquivalent in utils/site-planner.js — keep the two rules
// identical.
function coveredGrassDecayEquivalent(expected, actual, expectedMap) {
  if (normalizeType(expected.type) !== 'grass_block') return false
  if (normalizeType(actual.type) !== 'dirt') return false
  const above = expectedMap.get(posKey({ x: expected.x, y: expected.y + 1, z: expected.z }))
  return !!above && isGrassSmotheringCover(above.type)
}

function isComparableStateKey(blockType, key) {
  const type = String(blockType || '')
  if (!key) return false
  if (['legacyId', 'legacyData', 'legacyVariant'].includes(key)) return false
  if (key === 'distance' && type.endsWith('_leaves')) return false
  if (key === 'hinge' && DOOR_PATTERN.test(type)) return false
  if (type === 'ladder' && ['distance', 'bottom'].includes(key)) return false
  if (type === 'lantern' && ['signal_fire', 'lit', 'facing'].includes(key)) return false
  if (type === 'brewing_stand' && /^has_bottle_/.test(key)) return false
  if (type === 'lectern' && key === 'has_book') return false
  if (isDynamicConnectionStateBlock(type) && ['north', 'south', 'east', 'west', 'up'].includes(key)) return false
  // Round 10 (#51, boss-approved): the same states resume reconciliation
  // already excludes (systems/building-system.js, isComparablePlacementStateKey)
  // for being placement-unreachable — world-derived redstone/hopper signals,
  // redstone-wire neighbour connections, stair corner shape, and `lit` on the
  // signal-only block family. Shared with that ruler via
  // utils/derived-placement-state-keys so the two stay in lockstep. NOT
  // relaxed: `delay` (repeater), `mode`/`inverted` (comparator/daylight
  // detector), `open` — those are reachable and both rulers keep comparing
  // them.
  if (LIVE_SIGNAL_STATE_KEYS.has(key)) return false
  if (isRedstoneWireConnectionKey(type, key)) return false
  if (isStairsShapeKey(type, key)) return false
  if (key === 'lit' && isSignalLitBlockName(type)) return false
  return true
}

function isDynamicConnectionStateBlock(type) {
  return (/_fence$/.test(type) && !/_fence_gate$/.test(type)) ||
    /_wall$/.test(type) ||
    /_pane$/.test(type) ||
    type === 'iron_bars'
}

function posKey(block) {
  return `${Math.round(Number(block.x))},${Math.round(Number(block.y))},${Math.round(Number(block.z))}`
}

function compactPos(block) {
  return {
    x: Math.round(Number(block.x)),
    y: Math.round(Number(block.y)),
    z: Math.round(Number(block.z))
  }
}

function round(value) {
  return Number((Number(value) || 0).toFixed(4))
}

module.exports = {
  FaithfulCommunityValidator,
  isFaithfulCommunityImport,
  resolveStructureUse,
  summarizeBlueprint,
  _test: {
    isComparableStateKey
  }
}
