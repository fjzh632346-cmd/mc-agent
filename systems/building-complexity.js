const BUILDING_COMPLEXITY_TIERS = Object.freeze({
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
  L5: 'L5'
})

const COMPLEXITY_TIER_ORDER = Object.freeze({
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5
})

const COMPLEXITY_TIER_SPECS = Object.freeze({
  L1: Object.freeze({
    complexityTier: 'L1',
    label: 'emergency_shelter',
    maxFootprint: { width: 5, depth: 5, area: 25 },
    maxFloors: 1,
    minBlockBudget: 1,
    maxBlockBudget: 80,
    maxMaterialTypes: 5,
    maxRareMaterials: 0,
    decorationLevel: 'none',
    roofComplexity: 'none',
    interiorComplexity: 'essentials',
    expectedBuildTimeClass: 'survival_fast',
    survivalFriendly: true,
    allowRareDecorations: false,
    allowComplexStairStates: false,
    allowHangingLanterns: false,
    allowCake: false,
    allowFlowerPots: false,
    allowExactDecorativePlants: false,
    requireExplicitConfirmation: false
  }),
  L2: Object.freeze({
    complexityTier: 'L2',
    label: 'simple_cottage',
    maxFootprint: { width: 7, depth: 7, area: 49 },
    maxFloors: 1,
    minBlockBudget: 120,
    maxBlockBudget: 250,
    maxMaterialTypes: 10,
    maxRareMaterials: 0,
    decorationLevel: 'low',
    roofComplexity: 'simple',
    interiorComplexity: 'basic',
    expectedBuildTimeClass: 'short',
    survivalFriendly: true,
    allowRareDecorations: false,
    allowComplexStairStates: false,
    allowHangingLanterns: false,
    allowCake: false,
    allowFlowerPots: false,
    allowExactDecorativePlants: false,
    requireExplicitConfirmation: false
  }),
  L3: Object.freeze({
    complexityTier: 'L3',
    label: 'simple_two_story_cabin',
    maxFootprint: { width: 9, depth: 9, area: 81 },
    maxFloors: 2,
    minBlockBudget: 250,
    maxBlockBudget: 500,
    maxMaterialTypes: 12,
    maxRareMaterials: 0,
    decorationLevel: 'basic',
    roofComplexity: 'simple_gabled',
    interiorComplexity: 'basic',
    expectedBuildTimeClass: 'medium',
    survivalFriendly: true,
    allowRareDecorations: false,
    allowComplexStairStates: false,
    allowHangingLanterns: false,
    allowCake: false,
    allowFlowerPots: false,
    allowExactDecorativePlants: false,
    requireExplicitConfirmation: false
  }),
  L4: Object.freeze({
    complexityTier: 'L4',
    label: 'detailed_residence',
    maxFootprint: { width: 16, depth: 16, area: 256 },
    maxFloors: 3,
    minBlockBudget: 500,
    maxBlockBudget: 1000,
    maxMaterialTypes: 28,
    maxRareMaterials: 12,
    decorationLevel: 'detailed',
    roofComplexity: 'complex',
    interiorComplexity: 'detailed',
    expectedBuildTimeClass: 'long',
    survivalFriendly: false,
    allowRareDecorations: true,
    allowComplexStairStates: true,
    allowHangingLanterns: true,
    allowCake: true,
    allowFlowerPots: true,
    allowExactDecorativePlants: true,
    requireExplicitConfirmation: false
  }),
  L5: Object.freeze({
    complexityTier: 'L5',
    label: 'showcase_build',
    maxFootprint: { width: 256, depth: 256, area: 65536 },
    maxFloors: 64,
    minBlockBudget: 1000,
    maxBlockBudget: Number.MAX_SAFE_INTEGER,
    maxMaterialTypes: Number.MAX_SAFE_INTEGER,
    maxRareMaterials: Number.MAX_SAFE_INTEGER,
    decorationLevel: 'showcase',
    roofComplexity: 'showcase',
    interiorComplexity: 'showcase',
    expectedBuildTimeClass: 'very_long',
    survivalFriendly: false,
    allowRareDecorations: true,
    allowComplexStairStates: true,
    allowHangingLanterns: true,
    allowCake: true,
    allowFlowerPots: true,
    allowExactDecorativePlants: true,
    requireExplicitConfirmation: true
  })
})

const RARE_MATERIALS = new Set([
  'amethyst_block',
  'beacon',
  'brewing_stand',
  'cake',
  'diamond_block',
  'emerald_block',
  'ender_chest',
  'gold_block',
  'iron_bars',
  'iron_block',
  'iron_trapdoor',
  'lapis_block',
  'lectern',
  'netherite_block',
  'player_head',
  'creeper_head',
  'creeper_wall_head',
  'zombie_head',
  'zombie_wall_head',
  'skeleton_skull',
  'wither_skeleton_skull'
])

const DECORATIVE_BLOCK_PATTERNS = [
  /banner$/,
  /button$/,
  /candle$/,
  /carpet$/,
  /flower/,
  /lantern$/,
  /leaves$/,
  /pot$/,
  /^potted_/,
  /sapling$/,
  /sign$/,
  /trapdoor$/,
  /wall_head$/
]

const EXACT_DECORATIVE_PLANT_PATTERNS = [
  /^potted_/,
  /azalea/,
  /bush$/,
  /cornflower/,
  /dandelion/,
  /daisy/,
  /flower/,
  /^(short_)?grass$/,
  /rose_bush/,
  /sapling$/,
  /tall_grass/
]

const FIXED_SCALE_NAMED_BLUEPRINTS = new Set([
  'modern_villa',
  'modern_house_on_a_hilltop_site_fit',
  'castle_garden',
  'survival_castle',
  'fort_wall_gate',
  'fort_watchtower',
  // Boss decision #66 (from the round 13 census): these four fit no tier at
  // all — bigger than L1 allows (two floors, or over 80 blocks) and smaller
  // than L2 requires (120 blocks), so naming one used to come back
  // no_usable_blueprint_candidate. They join this list rather than the tier
  // budgets moving: the thresholds themselves are untouched.
  'small_house',
  'two_story_wood_house',
  'simple_farmhouse',
  'garden_manor'
])

function adaptBuildIntentToDesignSpec(input = {}) {
  const explicit = input.designSpec || input.designBudget || null
  const tier = normalizeComplexityTier(
    explicit?.complexityTier ||
    input.complexityTier ||
    input.tier ||
    input.complexity
  ) || inferComplexityTier(input)
  const base = clonePlain(COMPLEXITY_TIER_SPECS[tier] || COMPLEXITY_TIER_SPECS.L2)
  const merged = {
    ...base,
    ...(explicit || {}),
    complexityTier: tier,
    complexitySource: explicit?.complexitySource || complexitySource(input),
    userIntent: {
      rawText: input.rawText || input.input || input.text || null,
      blueprintName: input.blueprintName || input.target || null,
      style: input.style || null,
      type: input.type || input.buildingType || null
    }
  }
  merged.requiresExplicitConfirmation = merged.requireExplicitConfirmation === true
  merged.complexityConfirmationRequired = merged.requiresExplicitConfirmation
  return merged
}

function inferComplexityTier(input = {}) {
  const text = intentText(input)
  const wantsTwoStory = hasTwoStorySignal(text, input)
  if (hasShowcaseSignal(text)) return 'L5'
  if (hasDetailedSignal(text)) return 'L4'
  if (hasSimpleSignal(text)) return wantsTwoStory ? 'L3' : (hasEmergencySignal(text) ? 'L1' : 'L2')
  if (hasEmergencySignal(text)) return 'L1'
  if (wantsTwoStory) return 'L3'
  return 'L2'
}

function shouldPreserveNamedBlueprintScale(input = {}) {
  if (input.designSpec || input.designBudget || input.complexityTier || input.tier || input.complexity) {
    return false
  }
  const blueprintName = normalizeToken(input.blueprintName || input.target || input.buildingType)
  if (!FIXED_SCALE_NAMED_BLUEPRINTS.has(blueprintName)) return false
  const text = [input.rawText, input.input, input.text].filter(Boolean).join(' ').toLowerCase()
  if (!text) return true
  return !hasExplicitComplexityModifier(text)
}

function hasExplicitComplexityModifier(text) {
  const value = String(text || '').toLowerCase()
  return hasShowcaseSignal(value) ||
    hasDetailedSignal(value) ||
    hasSimpleSignal(value) ||
    hasEmergencySignal(value) ||
    /\b(?:l[1-5]|level\s*[1-5])\b/.test(value)
}

function estimateBlueprintComplexity(blueprintOrCandidate = {}) {
  const blocks = Array.isArray(blueprintOrCandidate.blocks) ? blueprintOrCandidate.blocks : []
  const nonAir = blocks.filter(block => !isAir(blockType(block)))
  const fallbackBlockCount = Number(
    blueprintOrCandidate.blockCount ||
    blueprintOrCandidate.encodingSummary?.blockCount ||
    blueprintOrCandidate.materialCost ||
    blueprintOrCandidate.estimatedMaterialCost ||
    0
  )
  if (!nonAir.length) {
    return {
      blockCount: fallbackBlockCount,
      width: Number(blueprintOrCandidate.width || 0),
      depth: Number(blueprintOrCandidate.depth || 0),
      height: Number(blueprintOrCandidate.height || 0),
      footprint: Number(blueprintOrCandidate.footprint || 0),
      floors: Number(blueprintOrCandidate.requiredStories || blueprintOrCandidate.floors || 0),
      materialTypes: 0,
      rareMaterials: [],
      rareMaterialCount: 0,
      decorativeBlockCount: 0,
      stairCount: 0,
      complexStairStateCount: 0,
      trapdoorCount: 0,
      lanternCount: 0,
      hangingLanternCount: 0,
      cakeCount: 0,
      flowerPotCount: 0,
      exactDecorativePlantCount: 0,
      riskyBlocks: 0,
      estimatedStepCount: fallbackBlockCount,
      estimatedBuildTimeClass: buildTimeClass(fallbackBlockCount)
    }
  }

  const bounds = boundsForBlocks(nonAir)
  const materials = new Map()
  let decorativeBlockCount = 0
  let stairCount = 0
  let complexStairStateCount = 0
  let trapdoorCount = 0
  let lanternCount = 0
  let hangingLanternCount = 0
  let cakeCount = 0
  let flowerPotCount = 0
  let exactDecorativePlantCount = 0
  let rareMaterialBlockCount = 0
  const rareMaterials = new Set()

  for (const block of nonAir) {
    const type = blockType(block)
    const states = blockStates(block)
    materials.set(type, (materials.get(type) || 0) + 1)
    if (RARE_MATERIALS.has(type)) {
      rareMaterials.add(type)
      rareMaterialBlockCount += 1
    }
    if (isDecorativeBlock(type)) decorativeBlockCount += 1
    if (isStair(type)) {
      stairCount += 1
      if (isComplexStairState(states)) complexStairStateCount += 1
    }
    if (type.endsWith('_trapdoor') || type === 'trapdoor') trapdoorCount += 1
    if (type === 'lantern' || type === 'soul_lantern') {
      lanternCount += 1
      if (states.hanging === true || states.hanging === 'true') hangingLanternCount += 1
    }
    if (type === 'cake') cakeCount += 1
    if (type === 'flower_pot' || type.startsWith('potted_')) flowerPotCount += 1
    if (isExactDecorativePlant(type)) exactDecorativePlantCount += 1
  }

  const floors = estimateFloors(blueprintOrCandidate, bounds, nonAir)
  const riskyBlocks = stairCount + trapdoorCount + lanternCount + cakeCount + flowerPotCount + rareMaterialBlockCount
  const estimatedStepCount = nonAir.length + Math.ceil(riskyBlocks * 0.6) + (bounds.height > 6 ? Math.ceil(bounds.height * 2) : 0)
  return {
    blockCount: nonAir.length,
    width: bounds.width,
    depth: bounds.depth,
    height: bounds.height,
    footprint: bounds.width * bounds.depth,
    floors,
    materialTypes: materials.size,
    materialCounts: Object.fromEntries([...materials.entries()].sort(([a], [b]) => a.localeCompare(b))),
    rareMaterials: [...rareMaterials].sort(),
    rareMaterialCount: rareMaterials.size,
    rareMaterialBlockCount,
    decorativeBlockCount,
    stairCount,
    complexStairStateCount,
    trapdoorCount,
    lanternCount,
    hangingLanternCount,
    cakeCount,
    flowerPotCount,
    exactDecorativePlantCount,
    riskyBlocks,
    estimatedStepCount,
    estimatedBuildTimeClass: buildTimeClass(estimatedStepCount)
  }
}

function blueprintSatisfiesDesignSpec(blueprintOrCandidate, designSpec = {}) {
  const spec = adaptBuildIntentToDesignSpec({ designSpec })
  const metrics = estimateBlueprintComplexity(blueprintOrCandidate)
  const failures = []
  if (metrics.blockCount > spec.maxBlockBudget) failures.push(`block_budget_exceeded:${metrics.blockCount}/${spec.maxBlockBudget}`)
  if (metrics.blockCount < spec.minBlockBudget) failures.push(`block_budget_below_tier_target:${metrics.blockCount}/${spec.minBlockBudget}`)
  if (spec.maxFootprint?.width && metrics.width > spec.maxFootprint.width) failures.push(`footprint_width_exceeded:${metrics.width}/${spec.maxFootprint.width}`)
  if (spec.maxFootprint?.depth && metrics.depth > spec.maxFootprint.depth) failures.push(`footprint_depth_exceeded:${metrics.depth}/${spec.maxFootprint.depth}`)
  if (spec.maxFootprint?.area && metrics.footprint > spec.maxFootprint.area) failures.push(`footprint_area_exceeded:${metrics.footprint}/${spec.maxFootprint.area}`)
  if (metrics.floors > spec.maxFloors) failures.push(`floor_budget_exceeded:${metrics.floors}/${spec.maxFloors}`)
  if (metrics.materialTypes > spec.maxMaterialTypes) failures.push(`material_type_budget_exceeded:${metrics.materialTypes}/${spec.maxMaterialTypes}`)
  if (metrics.rareMaterialCount > spec.maxRareMaterials) failures.push(`rare_material_budget_exceeded:${metrics.rareMaterialCount}/${spec.maxRareMaterials}`)
  if (spec.allowRareDecorations === false && metrics.rareMaterialBlockCount > 0) failures.push(`rare_decorations_not_allowed:${metrics.rareMaterialBlockCount}`)
  if (spec.allowComplexStairStates === false && metrics.complexStairStateCount > 0) failures.push(`complex_stair_states_not_allowed:${metrics.complexStairStateCount}`)
  if (spec.allowHangingLanterns === false && (metrics.hangingLanternCount > 0 || metrics.lanternCount > 0)) failures.push(`hanging_lanterns_not_allowed:${metrics.lanternCount}`)
  if (spec.allowCake === false && metrics.cakeCount > 0) failures.push(`cake_not_allowed:${metrics.cakeCount}`)
  if (spec.allowFlowerPots === false && metrics.flowerPotCount > 0) failures.push(`flower_pots_not_allowed:${metrics.flowerPotCount}`)
  if (spec.allowExactDecorativePlants === false && metrics.exactDecorativePlantCount > 0) failures.push(`exact_decorative_plants_not_allowed:${metrics.exactDecorativePlantCount}`)
  return {
    ok: failures.length === 0,
    failures,
    metrics,
    designSpec: spec
  }
}

function createConstructionEstimate(input = {}) {
  const metrics = estimateBlueprintComplexity(input.blueprint || input)
  const designSpec = input.designSpec
    ? adaptBuildIntentToDesignSpec({ designSpec: input.designSpec })
    : adaptBuildIntentToDesignSpec(input)
  const expectedSteps = Number(input.constructionPlan?.steps?.length || input.orderPlan?.summary?.totalSteps || metrics.estimatedStepCount || metrics.blockCount)
  const estimatedMinutesLow = Math.max(1, Math.ceil(expectedSteps * 0.05))
  const estimatedMinutesHigh = Math.max(estimatedMinutesLow, Math.ceil(expectedSteps * 0.16))
  const warnings = []
  if (designSpec.complexityTier === 'L5') warnings.push('showcase_build_requires_explicit_confirmation')
  if (expectedSteps >= 900) warnings.push('expected_build_time_long')
  if (metrics.blockCount < designSpec.minBlockBudget) warnings.push('block_budget_below_tier_target')
  if (metrics.blockCount > designSpec.maxBlockBudget) warnings.push('block_budget_exceeded')
  if (metrics.rareMaterialCount > designSpec.maxRareMaterials) warnings.push('rare_material_budget_exceeded')
  if (designSpec.allowCake === false && metrics.cakeCount > 0) warnings.push('cake_not_allowed')
  if (designSpec.allowHangingLanterns === false && metrics.lanternCount > 0) warnings.push('lanterns_not_allowed')

  return {
    blockCount: metrics.blockCount,
    materialTypes: metrics.materialTypes,
    riskyBlocks: metrics.riskyBlocks,
    expectedSteps,
    estimatedMinutesLow,
    estimatedMinutesHigh,
    estimatedBuildTimeClass: buildTimeClass(expectedSteps),
    complexityTier: designSpec.complexityTier,
    warnings
  }
}

function normalizeComplexityTier(value) {
  const text = normalizeToken(value)
  if (!text) return null
  if (/^l?[1-5]$/.test(text)) return `L${text.replace(/^l/, '')}`
  if (['emergency', 'urgent', 'shelter', 'tiny'].includes(text)) return 'L1'
  if (['simple', 'small', 'fast', 'quick', 'basic', 'easy'].includes(text)) return 'L2'
  if (['simple_two_story', 'two_story_simple', 'medium'].includes(text)) return 'L3'
  if (['detailed', 'nice', 'refined', 'fancy', 'decorated'].includes(text)) return 'L4'
  if (['showcase', 'large', 'huge', 'complex', 'castle_scale', 'castle'].includes(text)) return 'L5'
  return null
}

function isLowComplexityTier(tier) {
  const normalized = normalizeComplexityTier(tier) || tier
  return (COMPLEXITY_TIER_ORDER[normalized] || 99) <= 3
}

function intentText(input = {}) {
  return [
    input.rawText,
    input.input,
    input.text,
    input.requestedName,
    input.blueprintName,
    input.target,
    input.style,
    input.type,
    input.buildingType
  ].filter(Boolean).join(' ').toLowerCase()
}

function hasTwoStorySignal(text, input = {}) {
  if (Number(input.floors || input.maxFloors || 0) >= 2) return true
  return /two[_\s-]*stor(e)?y|two[_\s-]*floor|2[_\s-]*(story|floor)|double[_\s-]*stor(e)?y/.test(text) ||
    text.includes('\u53cc\u5c42') ||
    text.includes('\u4e24\u5c42') ||
    text.includes('\u4e8c\u5c42')
}

function hasSimpleSignal(text) {
  return /simple|small|quick|fast|basic|easy|compact|starter|survival/.test(text) ||
    text.includes('\u7b80\u5355') ||
    text.includes('\u5feb\u4e00\u70b9') ||
    text.includes('\u5c0f\u4e00\u70b9') ||
    text.includes('\u522b\u592a\u590d\u6742') ||
    text.includes('\u5c0f\u6728\u5c4b')
}

function hasDetailedSignal(text) {
  return /detailed|fancy|refined|nice|decorated|beautiful/.test(text) ||
    text.includes('\u7cbe\u81f4') ||
    text.includes('\u597d\u770b\u4e00\u70b9') ||
    text.includes('\u7ec6\u8282\u591a\u4e00\u70b9')
}

function hasShowcaseSignal(text) {
  return /showcase|large|huge|complex|castle[_\s-]*scale|mega/.test(text) ||
    text.includes('\u5c55\u793a\u7ea7') ||
    text.includes('\u5927\u578b') ||
    text.includes('\u590d\u6742') ||
    text.includes('\u57ce\u5821\u7ea7') ||
    text.includes('\u8c6a\u534e')
}

function hasEmergencySignal(text) {
  return /emergency|urgent|night|panic/.test(text) ||
    text.includes('\u7d27\u6025') ||
    text.includes('\u5e87\u62a4\u6240') ||
    text.includes('\u5148\u8fc7\u591c')
}

function complexitySource(input = {}) {
  if (input.designSpec?.complexityTier || input.complexityTier || input.tier || input.complexity) return 'explicit'
  if (input.rawText || input.input || input.text) return 'user_intent_adapter'
  return 'default'
}

function boundsForBlocks(blocks) {
  const first = blockPosition(blocks[0])
  const bounds = blocks.reduce((acc, block) => {
    const position = blockPosition(block)
    return {
      minX: Math.min(acc.minX, position.x),
      maxX: Math.max(acc.maxX, position.x),
      minY: Math.min(acc.minY, position.y),
      maxY: Math.max(acc.maxY, position.y),
      minZ: Math.min(acc.minZ, position.z),
      maxZ: Math.max(acc.maxZ, position.z)
    }
  }, {
    minX: first.x,
    maxX: first.x,
    minY: first.y,
    maxY: first.y,
    minZ: first.z,
    maxZ: first.z
  })
  return {
    ...bounds,
    width: bounds.maxX - bounds.minX + 1,
    height: bounds.maxY - bounds.minY + 1,
    depth: bounds.maxZ - bounds.minZ + 1
  }
}

function estimateFloors(blueprint = {}, bounds, blocks = []) {
  const explicit = Number(blueprint.metadata?.floors || blueprint.requiredStories || blueprint.floors || blueprint.metadata?.requiredStories || 0)
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit)
  const fullLayerThreshold = Math.max(9, Math.floor((bounds.width * bounds.depth) * 0.35))
  const yCounts = new Map()
  for (const block of blocks) {
    const position = blockPosition(block)
    yCounts.set(position.y, (yCounts.get(position.y) || 0) + 1)
  }
  const floorLayers = [...yCounts.entries()]
    .filter(([, count]) => count >= fullLayerThreshold)
    .map(([y]) => y)
    .sort((a, b) => a - b)
  const storyFloors = floorLayers.filter((y, index) => index === 0 || y - floorLayers[index - 1] >= 3)
  if (storyFloors.length >= 2) return storyFloors.length
  if (bounds.height >= 14) return 3
  if (bounds.height >= 6) return 2
  return 1
}

function blockType(block = {}) {
  return String(block.block?.id || block.type || block.name || block.blockName || 'air')
}

function blockStates(block = {}) {
  return block.block?.states || block.states || block.orientation || {}
}

function blockPosition(block = {}) {
  return block.position || block.target || {
    x: Number(block.x) || 0,
    y: Number(block.y) || 0,
    z: Number(block.z) || 0
  }
}

function isAir(type) {
  return ['air', 'cave_air', 'void_air'].includes(String(type || 'air'))
}

function isDecorativeBlock(type) {
  return DECORATIVE_BLOCK_PATTERNS.some(pattern => pattern.test(type))
}

function isExactDecorativePlant(type) {
  return EXACT_DECORATIVE_PLANT_PATTERNS.some(pattern => pattern.test(type))
}

function isStair(type) {
  return String(type || '').endsWith('_stairs') || type === 'stairs'
}

function isComplexStairState(states = {}) {
  const shape = String(states.shape || 'straight').toLowerCase()
  return shape && shape !== 'straight'
}

function buildTimeClass(steps) {
  const count = Number(steps) || 0
  if (count <= 120) return 'survival_fast'
  if (count <= 300) return 'short'
  if (count <= 650) return 'medium'
  if (count <= 1200) return 'long'
  return 'very_long'
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value))
}

module.exports = {
  BUILDING_COMPLEXITY_TIERS,
  COMPLEXITY_TIER_ORDER,
  COMPLEXITY_TIER_SPECS,
  adaptBuildIntentToDesignSpec,
  blueprintSatisfiesDesignSpec,
  createConstructionEstimate,
  estimateBlueprintComplexity,
  inferComplexityTier,
  isLowComplexityTier,
  normalizeComplexityTier,
  shouldPreserveNamedBlueprintScale
}
