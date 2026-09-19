const crypto = require('crypto')
const { adaptBuildIntentToDesignSpec } = require('./building-complexity')

const DESIGN_SPEC_SCHEMA_VERSION = 1
const BLUEPRINT_FREEZE_SCHEMA_VERSION = 1
const CONSTRUCTION_LIFECYCLE_SCHEMA_VERSION = 1

const REQUIRED_DESIGN_SPEC_FIELDS = Object.freeze([
  'buildingType',
  'style',
  'width',
  'depth',
  'height',
  'floors',
  'entranceDirection',
  'roomLayout',
  'functionalPoints',
  'roofType',
  'primaryMaterials',
  'palette',
  'habitabilityRequirements',
  'complexityTier',
  'maxFootprint',
  'maxFloors',
  'minBlockBudget',
  'maxBlockBudget',
  'maxMaterialTypes',
  'maxRareMaterials',
  'decorationLevel',
  'roofComplexity',
  'interiorComplexity',
  'expectedBuildTimeClass',
  'survivalFriendly',
  'allowRareDecorations',
  'allowComplexStairStates',
  'allowHangingLanterns',
  'allowCake',
  'allowFlowerPots',
  'allowExactDecorativePlants'
])

const BUILDING_LIFECYCLE_FLOW = Object.freeze([
  'user_request',
  'building_design',
  'blueprint_freeze',
  'site_selection',
  'material_calculation',
  'staging_chest_deployment',
  'material_transport_and_verification',
  'construction_plan_compile',
  'phased_construction',
  'world_diff_acceptance',
  'automatic_repair',
  'site_cleanup',
  'blueprint_archive_reuse'
])

const CONSTRUCTION_PHASE_ORDER = Object.freeze([
  'site_prepare',
  'foundation',
  'frame',
  'floor',
  'wall',
  'stairs',
  'roof',
  'doors_windows',
  'functional_blocks',
  'interior',
  'exterior_detail',
  'cleanup'
])

function createDesignSpec(input = {}) {
  const request = input.request || {}
  const blueprint = input.blueprint || {}
  const designPlan = input.designPlan || {}
  const metrics = input.habitabilityHardGate?.metrics || input.hardGate?.metrics || {}
  const materialCounts = materialCountsFrom(input, blueprint, metrics)
  const bounds = input.bounds || metrics.bounds || blueprintBounds(blueprint) || blueprintIrBounds(input.blueprintIR)
  const dimensions = dimensionsFromBounds(bounds)
  const buildingType = normalizeText(
    designPlan.buildingType ||
      request.type ||
      request.blueprintName ||
      input.selectedBlueprint?.buildingType ||
      blueprint.metadata?.buildingType ||
      blueprint.name ||
      'unknown'
  )
  const style = normalizeText(
    designPlan.style ||
      request.style ||
      input.selectedBlueprint?.style ||
      blueprint.metadata?.style ||
      styleFromMaterials(materialCounts) ||
      'mixed'
  )
  const floors = normalizePositiveInteger(
    input.floors ||
      metrics.detectedStories ||
      input.selectedBlueprint?.requiredStories ||
      blueprint.metadata?.floors ||
      roomLayoutFloors(input.layoutPlan) ||
      1
  )
  const complexityBudget = adaptBuildIntentToDesignSpec({
    ...(request || {}),
    designSpec: input.designBudget || request.designSpec || request.designBudget || null,
    blueprintName: request.blueprintName || input.selectedBlueprint?.requestedName || input.selectedBlueprint?.blueprintName || blueprint.name,
    style: request.style,
    type: request.type || request.buildingType || buildingType,
    floors
  })

  const spec = {
    schemaVersion: DESIGN_SPEC_SCHEMA_VERSION,
    designSpecId: null,
    revision: null,
    hash: null,
    frozen: false,
    source: input.source || sourceForBlueprint(blueprint, input.selectedBlueprint),
    buildingType,
    style,
    width: dimensions.width,
    depth: dimensions.depth,
    height: dimensions.height,
    floors,
    entranceDirection: entranceDirectionFrom(input.layoutPlan, blueprint),
    roomLayout: roomLayoutFrom(input.layoutPlan, dimensions, floors),
    functionalPoints: functionalPointsFrom(input.interiorPlan, blueprint, input.blueprintIR),
    roofType: normalizeText(designPlan.roofType || roofTypeFrom(style, blueprint, metrics)),
    primaryMaterials: topMaterials(materialCounts, 5),
    palette: paletteFrom(materialCounts, style),
    habitabilityRequirements: habitabilityRequirementsFrom({
      buildingType,
      floors,
      metrics,
      hardGate: input.habitabilityHardGate || input.hardGate || null,
      layoutPlan: input.layoutPlan || null,
      interiorPlan: input.interiorPlan || null
    }),
    complexityTier: complexityBudget.complexityTier,
    maxFootprint: clonePlainObject(complexityBudget.maxFootprint),
    maxFloors: complexityBudget.maxFloors,
    minBlockBudget: complexityBudget.minBlockBudget,
    maxBlockBudget: complexityBudget.maxBlockBudget,
    maxMaterialTypes: complexityBudget.maxMaterialTypes,
    maxRareMaterials: complexityBudget.maxRareMaterials,
    decorationLevel: complexityBudget.decorationLevel,
    roofComplexity: complexityBudget.roofComplexity,
    interiorComplexity: complexityBudget.interiorComplexity,
    expectedBuildTimeClass: complexityBudget.expectedBuildTimeClass,
    survivalFriendly: complexityBudget.survivalFriendly === true,
    allowRareDecorations: complexityBudget.allowRareDecorations === true,
    allowComplexStairStates: complexityBudget.allowComplexStairStates === true,
    allowHangingLanterns: complexityBudget.allowHangingLanterns === true,
    allowCake: complexityBudget.allowCake === true,
    allowFlowerPots: complexityBudget.allowFlowerPots === true,
    allowExactDecorativePlants: complexityBudget.allowExactDecorativePlants === true,
    complexityConfirmationRequired: complexityBudget.complexityConfirmationRequired === true,
    derivedFrom: {
      blueprintId: input.blueprintId || input.constructionPlan?.blueprintId || input.blueprintIR?.id || blueprint.name || null,
      blueprintRevision: input.blueprintRevision || input.constructionPlan?.blueprintRevision || input.blueprintIR?.metadata?.revision || null,
      blueprintHash: input.blueprintHash || input.constructionPlan?.blueprintHash || null,
      planId: input.planId || input.constructionPlan?.planId || null
    }
  }

  return freezeDesignSpec(spec)
}

function freezeDesignSpec(spec = {}) {
  const normalized = {
    ...clonePlainObject(spec),
    schemaVersion: spec.schemaVersion || DESIGN_SPEC_SCHEMA_VERSION,
    frozen: true
  }
  const hash = sha1(stableStringify(stripDesignSpecVolatileFields(normalized)))
  const shortHash = hash.slice(0, 12)
  normalized.hash = hash
  normalized.revision = spec.revision || `design_rev_${shortHash}`
  normalized.designSpecId = spec.designSpecId || `${slugPart(spec.buildingType || 'building')}_${shortHash}`
  return normalized
}

function createBlueprintFreezeRecord(input = {}) {
  const designSpec = input.designSpec || {}
  const constructionPlan = input.constructionPlan || {}
  const blueprintIR = input.blueprintIR || {}
  return {
    schemaVersion: BLUEPRINT_FREEZE_SCHEMA_VERSION,
    frozen: true,
    immutable: true,
    stage: 'blueprint_freeze',
    blueprintId: input.blueprintId || constructionPlan.blueprintId || blueprintIR.id || null,
    blueprintRevision: input.blueprintRevision || constructionPlan.blueprintRevision || blueprintIR.metadata?.revision || null,
    blueprintHash: input.blueprintHash || constructionPlan.blueprintHash || null,
    planId: input.planId || constructionPlan.planId || null,
    designSpecId: designSpec.designSpecId || null,
    designSpecRevision: designSpec.revision || null,
    designSpecHash: designSpec.hash || null
  }
}

function freezeBlueprintIR(blueprintIR, blueprintFreeze) {
  if (!blueprintIR) return null
  const cloned = clonePlainObject(blueprintIR)
  cloned.metadata = {
    ...(cloned.metadata || {}),
    frozen: true,
    blueprintFreeze: clonePlainObject(blueprintFreeze || null)
  }
  return cloned
}

function createConstructionLifecycle(input = {}) {
  const currentPhase = normalizeConstructionPhase(input.currentPhase || 'site_prepare')
  return {
    schemaVersion: CONSTRUCTION_LIFECYCLE_SCHEMA_VERSION,
    flow: [...BUILDING_LIFECYCLE_FLOW],
    phaseOrder: [...CONSTRUCTION_PHASE_ORDER],
    currentPhase,
    phaseStatus: defaultPhaseStatus(currentPhase),
    gates: {
      designComplete: input.designSpec?.frozen === true,
      blueprintFrozen: input.blueprintFreeze?.frozen === true,
      siteSelected: Boolean(input.placementContext?.origin || input.origin),
      materialsCalculated: Boolean(input.materialPlan || input.materialStats),
      stagingChestKnown: Array.isArray(input.stagingChests) && input.stagingChests.length > 0,
      stagingInventoryVerified: input.stagingInventoryVerified === true,
      constructionPlanCompiled: Boolean(input.constructionPlan?.planId || input.planId)
    },
    terminal: false
  }
}

function updateConstructionLifecycle(lifecycle = {}, runSteps = {}, currentPhase = null) {
  const normalizedCurrent = normalizeConstructionPhase(currentPhase || lifecycle.currentPhase || 'site_prepare')
  const phaseStatus = defaultPhaseStatus(normalizedCurrent)
  const byPhase = new Map()

  for (const step of Object.values(runSteps || {})) {
    const phase = normalizeConstructionPhase(step.lifecyclePhase || step.phase, step)
    if (!CONSTRUCTION_PHASE_ORDER.includes(phase)) continue
    const bucket = byPhase.get(phase) || []
    bucket.push(step)
    byPhase.set(phase, bucket)
  }

  for (const phase of CONSTRUCTION_PHASE_ORDER) {
    const steps = byPhase.get(phase) || []
    if (!steps.length) continue
    if (steps.every(step => step.status === 'verified')) phaseStatus[phase] = 'completed'
    else if (steps.some(step => ['repair', 'state_repair', 'retryable_failed', 'terminal_failed'].includes(step.status))) {
      phaseStatus[phase] = 'repair'
    } else if (phase === normalizedCurrent) {
      phaseStatus[phase] = 'active'
    } else {
      phaseStatus[phase] = 'pending'
    }
  }

  return {
    schemaVersion: lifecycle.schemaVersion || CONSTRUCTION_LIFECYCLE_SCHEMA_VERSION,
    flow: Array.isArray(lifecycle.flow) ? lifecycle.flow : [...BUILDING_LIFECYCLE_FLOW],
    phaseOrder: Array.isArray(lifecycle.phaseOrder) ? lifecycle.phaseOrder : [...CONSTRUCTION_PHASE_ORDER],
    currentPhase: normalizedCurrent,
    phaseStatus,
    gates: { ...(lifecycle.gates || {}) },
    terminal: lifecycle.terminal === true
  }
}

function completeConstructionLifecycle(lifecycle = {}) {
  const completed = {}
  for (const phase of CONSTRUCTION_PHASE_ORDER) completed[phase] = 'completed'
  return {
    schemaVersion: lifecycle.schemaVersion || CONSTRUCTION_LIFECYCLE_SCHEMA_VERSION,
    flow: Array.isArray(lifecycle.flow) ? lifecycle.flow : [...BUILDING_LIFECYCLE_FLOW],
    phaseOrder: Array.isArray(lifecycle.phaseOrder) ? lifecycle.phaseOrder : [...CONSTRUCTION_PHASE_ORDER],
    currentPhase: 'cleanup',
    phaseStatus: completed,
    gates: {
      ...(lifecycle.gates || {}),
      worldDiffAccepted: true,
      siteCleanupComplete: true,
      archivedForReuse: true
    },
    terminal: true
  }
}

function normalizeConstructionPhase(phase, step = {}) {
  const phaseText = String(phase || '').toLowerCase()
  const legacyKind = String(step.legacyKind || '').toLowerCase()
  const kind = String(step.kind || '').toLowerCase()
  const action = String(step.action || '').toLowerCase()
  const role = String(step.role || '').toLowerCase()
  const blockName = String(step.block?.id || step.blockName || '').toLowerCase()
  const controlText = [phaseText, legacyKind, kind, action, role].join(' ')
  const text = [controlText, blockName].join(' ')
  if (controlText.includes('cleanup') || controlText.includes('scaffold_remove') || controlText.includes('validate')) return 'cleanup'
  if (phaseText.includes('site') || phaseText.includes('clear') || ['clear', 'scaffold_place'].includes(legacyKind) || ['clear', 'scaffold_place'].includes(kind) || ['clear_block', 'scaffold_place'].includes(action)) return 'site_prepare'
  if (text.includes('foundation')) return 'foundation'
  if (text.includes('floor')) return 'floor'
  if (text.includes('wall')) return 'wall'
  if (text.includes('stair') || text.includes('ladder')) return 'stairs'
  if (text.includes('roof')) return 'roof'
  if (text.includes('door') || text.includes('window') || text.includes('glass')) return 'doors_windows'
  if (text.includes('functional') || functionalBlockNames.has(step.block?.id) || functionalBlockNames.has(step.blockName)) {
    return 'functional_blocks'
  }
  if (text.includes('interior') || text.includes('furniture') || text.includes('carpet')) return 'interior'
  if (text.includes('exterior') || text.includes('detail') || text.includes('facade')) return 'exterior_detail'
  if (CONSTRUCTION_PHASE_ORDER.includes(String(phase || ''))) return phase
  return 'frame'
}

function defaultPhaseStatus(currentPhase) {
  return Object.fromEntries(CONSTRUCTION_PHASE_ORDER.map(phase => [phase, phase === currentPhase ? 'active' : 'pending']))
}

function materialCountsFrom(input, blueprint, metrics) {
  const materialPlan = input.materialPlan || {}
  return clonePlainObject(
    materialPlan.formalRequiredMaterials ||
      materialPlan.requiredMaterials ||
      input.materialCounts ||
      metrics.materialCounts ||
      countBlueprintMaterials(blueprint)
  ) || {}
}

function countBlueprintMaterials(blueprint = {}) {
  const counts = {}
  for (const block of blueprint.blocks || []) {
    const type = block.type || block.name || block.blockName
    if (!type || type === 'air') continue
    counts[type] = (counts[type] || 0) + 1
  }
  return counts
}

function blueprintBounds(blueprint = {}) {
  const blocks = (blueprint.blocks || []).filter(block => block && (block.type || block.name || block.blockName) !== 'air')
  if (!blocks.length) return null
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, Number(block.x) || 0),
    maxX: Math.max(bounds.maxX, Number(block.x) || 0),
    minY: Math.min(bounds.minY, Number(block.y) || 0),
    maxY: Math.max(bounds.maxY, Number(block.y) || 0),
    minZ: Math.min(bounds.minZ, Number(block.z) || 0),
    maxZ: Math.max(bounds.maxZ, Number(block.z) || 0)
  }), {
    minX: Number(blocks[0].x) || 0,
    maxX: Number(blocks[0].x) || 0,
    minY: Number(blocks[0].y) || 0,
    maxY: Number(blocks[0].y) || 0,
    minZ: Number(blocks[0].z) || 0,
    maxZ: Number(blocks[0].z) || 0
  })
}

function blueprintIrBounds(blueprintIR = {}) {
  const blocks = (blueprintIR.blocks || blueprintIR.nodes || []).filter(block => block?.position)
  if (!blocks.length) return null
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, Number(block.position.x) || 0),
    maxX: Math.max(bounds.maxX, Number(block.position.x) || 0),
    minY: Math.min(bounds.minY, Number(block.position.y) || 0),
    maxY: Math.max(bounds.maxY, Number(block.position.y) || 0),
    minZ: Math.min(bounds.minZ, Number(block.position.z) || 0),
    maxZ: Math.max(bounds.maxZ, Number(block.position.z) || 0)
  }), {
    minX: Number(blocks[0].position.x) || 0,
    maxX: Number(blocks[0].position.x) || 0,
    minY: Number(blocks[0].position.y) || 0,
    maxY: Number(blocks[0].position.y) || 0,
    minZ: Number(blocks[0].position.z) || 0,
    maxZ: Number(blocks[0].position.z) || 0
  })
}

function dimensionsFromBounds(bounds) {
  if (!bounds) return { width: 1, depth: 1, height: 1 }
  return {
    width: Math.max(1, (Number(bounds.maxX) || 0) - (Number(bounds.minX) || 0) + 1),
    depth: Math.max(1, (Number(bounds.maxZ) || 0) - (Number(bounds.minZ) || 0) + 1),
    height: Math.max(1, (Number(bounds.maxY) || 0) - (Number(bounds.minY) || 0) + 1)
  }
}

function entranceDirectionFrom(layoutPlan = {}, blueprint = {}) {
  const entrance = (layoutPlan.entrances || [])[0]
  if (entrance?.direction) return normalizeText(entrance.direction)
  if (entrance?.facing) return normalizeText(entrance.facing)
  const door = (blueprint.blocks || []).find(block => String(block.type || block.name || '').includes('door'))
  return normalizeText(door?.states?.facing || door?.properties?.facing || 'south')
}

function roomLayoutFrom(layoutPlan = {}, dimensions, floors) {
  const rooms = Array.isArray(layoutPlan.rooms) && layoutPlan.rooms.length
    ? layoutPlan.rooms.map((room, index) => ({
        id: room.id || `room_${index + 1}`,
        role: room.role || room.type || room.name || 'room',
        floor: normalizePositiveInteger(room.floor || room.story || 1),
        bounds: clonePlainObject(room.bounds || null)
      }))
    : [{
        id: 'main_volume',
        role: 'main',
        floor: 1,
        bounds: {
          minX: 0,
          minY: 0,
          minZ: 0,
          maxX: Math.max(0, dimensions.width - 1),
          maxY: Math.max(0, dimensions.height - 1),
          maxZ: Math.max(0, dimensions.depth - 1)
        }
      }]
  return {
    floors,
    rooms,
    entrances: clonePlainObject(layoutPlan.entrances || []),
    stairs: clonePlainObject(layoutPlan.stairs || [])
  }
}

function functionalPointsFrom(interiorPlan = {}, blueprint = {}, blueprintIR = {}) {
  const points = []
  for (const placement of interiorPlan.placements || []) {
    const blockName = placement.block || placement.type || placement.blockName
    if (!blockName) continue
    points.push({
      role: placement.role || placement.kind || blockName,
      block: blockName,
      position: clonePlainObject(placement.position || null),
      roomId: placement.roomId || placement.room || null
    })
  }
  for (const block of blueprint.blocks || []) {
    const type = block.type || block.name || block.blockName
    if (!functionalBlockNames.has(type) && !String(type || '').includes('door')) continue
    points.push({
      role: String(type).includes('door') ? 'entrance' : type,
      block: type,
      position: { x: block.x, y: block.y, z: block.z },
      roomId: null
    })
  }
  for (const node of blueprintIR.blocks || []) {
    const block = node.block?.id || node.type || node.name
    if (!functionalBlockNames.has(block)) continue
    points.push({
      role: block,
      block,
      position: clonePlainObject(node.position || null),
      roomId: null
    })
  }
  return dedupePoints(points).slice(0, 64)
}

function habitabilityRequirementsFrom({ buildingType, floors, metrics, hardGate, layoutPlan, interiorPlan }) {
  const residential = /house|home|residence|residential|villa|cabin|apartment/i.test(buildingType || '')
  return {
    residential,
    entranceRequired: true,
    roofRequired: true,
    floorsRequired: floors,
    verticalConnectivityRequired: floors > 1,
    functionalReachabilityRequired: true,
    interiorPathRequired: residential || interiorPlan?.enabled === true,
    minUsableInteriorVolume: hardGate?.limits?.minUsableInteriorVolume || null,
    detectedStories: metrics.detectedStories || null,
    layoutRoomsRequired: residential ? Math.max(1, layoutPlan?.rooms?.length || 1) : 0
  }
}

function roofTypeFrom(style, blueprint, metrics) {
  if (blueprint.metadata?.design?.roofType) return blueprint.metadata.design.roofType
  if (blueprint.metadata?.roofType) return blueprint.metadata.roofType
  if (metrics.completeRoof === true && /modern|glass|concrete/i.test(style || '')) return 'flat'
  if (/wood|cabin|house|medieval/i.test(`${style || ''} ${blueprint.name || ''}`)) return 'gabled'
  return metrics.completeRoof === true ? 'complete' : 'unknown'
}

function topMaterials(counts = {}, limit = 5) {
  return Object.entries(counts)
    .filter(([name, count]) => name && Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([item, count]) => ({ item, count }))
}

function paletteFrom(counts = {}, style = 'mixed') {
  const primary = topMaterials(counts, 8).map(entry => entry.item)
  return {
    style,
    primary,
    accents: primary.filter(item => /glass|lantern|flower|carpet|banner|door|trapdoor|slab|stair/i.test(item)).slice(0, 6)
  }
}

function styleFromMaterials(counts = {}) {
  const text = Object.keys(counts).join(' ')
  if (/spruce|oak|planks|log|wood/i.test(text)) return 'wood'
  if (/quartz|concrete|glass/i.test(text)) return 'modern'
  if (/stone|cobblestone|deepslate|brick/i.test(text)) return 'stone'
  return null
}

function roomLayoutFloors(layoutPlan = {}) {
  const roomFloors = (layoutPlan.rooms || []).map(room => Number(room.floor || room.story || 1))
  return roomFloors.length ? Math.max(...roomFloors) : null
}

function sourceForBlueprint(blueprint = {}, selected = {}) {
  return selected.sourceMode || selected.sourceKind || blueprint.metadata?.sourceMode || blueprint.metadata?.sourceKind || 'local_blueprint'
}

function dedupePoints(points) {
  const seen = new Set()
  const result = []
  for (const point of points) {
    const key = `${point.block}|${point.role}|${point.position?.x},${point.position?.y},${point.position?.z}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(point)
  }
  return result
}

function normalizeText(value) {
  return String(value || 'unknown').trim() || 'unknown'
}

function normalizePositiveInteger(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.round(parsed)) : 1
}

function slugPart(value) {
  return String(value || 'building').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'building'
}

function stripDesignSpecVolatileFields(value) {
  const cloned = clonePlainObject(value)
  delete cloned.designSpecId
  delete cloned.revision
  delete cloned.hash
  delete cloned.frozen
  return cloned
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function clonePlainObject(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

const functionalBlockNames = new Set([
  'barrel',
  'blast_furnace',
  'brewing_stand',
  'cake',
  'chest',
  'crafting_table',
  'enchanting_table',
  'ender_chest',
  'furnace',
  'lectern',
  'smoker',
  'smithing_table'
])

module.exports = {
  BLUEPRINT_FREEZE_SCHEMA_VERSION,
  BUILDING_LIFECYCLE_FLOW,
  CONSTRUCTION_LIFECYCLE_SCHEMA_VERSION,
  CONSTRUCTION_PHASE_ORDER,
  DESIGN_SPEC_SCHEMA_VERSION,
  REQUIRED_DESIGN_SPEC_FIELDS,
  completeConstructionLifecycle,
  createBlueprintFreezeRecord,
  createConstructionLifecycle,
  createDesignSpec,
  freezeBlueprintIR,
  freezeDesignSpec,
  normalizeConstructionPhase,
  updateConstructionLifecycle
}
