const { getInventoryCounts } = require('../tasks/task-utils')
const { toBlockVec3 } = require('./position')
const { itemRequirementsForBlock } = require('./building-material-map')
const { legacyBlockNameMatches } = require('./legacy-block-compat')

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
const TERRAIN_SUPPORT = '__terrain_support__'
const NON_REFERENCE_BLOCK_PATTERNS = [
  /_door$/,
  /trapdoor$/,
  /ladder$/,
  /torch$/,
  /button$/,
  /pressure_plate$/,
  /carpet$/,
  /_bed$/,
  /^bed$/,
  /sign$/,
  /banner$/,
  /flower$/,
  /^lantern$/,
  /^(short_)?grass$/,
  /sapling$/,
  /water$/,
  /lava$/
]
// Blocks this pass refuses to count as a reference: either the click is eaten
// by the block's own interaction (hopper / repeater / comparator / dropper open
// a GUI or toggle) or there is no full face to click (redstone wire, rails).
// Live evidence (round 11 fort-wall-gate): the three place_failed:unstable_air
// points all had a hopper, a repeater or a redstone wire as their only
// available reference.
// This list is deliberately more conservative than the executor: round 9 put
// hopper & co. in actions/build.js SNEAK_ONLY_REFERENCE_BLOCKS, so a sneaking
// right-click DOES place against them today (后勤 16 uses exactly that to point
// one hopper at the other). Planning still refuses to depend on it: sneaking is
// one more thing that can go wrong, and a plain building block is always safer.
const UNCLICKABLE_REFERENCE_BLOCKS = new Set([
  'beacon',
  'bell',
  'cake',
  'chiseled_bookshelf',
  'comparator',
  'crafter',
  'daylight_detector',
  'decorated_pot',
  'dispenser',
  'dropper',
  'hopper',
  'repeater',
  'respawn_anchor'
])
const UNCLICKABLE_REFERENCE_PATTERNS = [
  /shulker_box$/,
  /^redstone_wire$/,
  /rail$/,
  /^tripwire$/,
  /^lily_pad$/,
  /^snow$/
]
// Blocks whose facing is decided ONLY by which face was clicked — turning the
// bot does nothing (后勤 11 orientation table: actions/build.js
// ORIENTED_PLACEMENT_FACING_RULES.hopper.clickedFace === true, from the 修缮 10
// real-server probe). A hopper's output points AT the block that was clicked,
// so the blueprint's facing dictates exactly one neighbour cell. Data on
// purpose: another family joining this club is one line here.
const CLICKED_FACE_FACING_BLOCKS = new Set(['hopper'])
// facing -> the neighbour cell that has to be clicked. 'up' is absent because
// a hopper cannot point up; a blueprint carrying one falls through to "no
// requirement" and keeps today's behaviour.
const CLICKED_FACE_FACING_OFFSETS = {
  down: { x: 0, y: -1, z: 0 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 }
}
const OPPOSITE_FACE = {
  up: 'down',
  down: 'up',
  east: 'west',
  west: 'east',
  north: 'south',
  south: 'north'
}
const HAZARD_BLOCKS = new Set(['water', 'lava'])
const PROTECTED_SITE_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'bed',
  'white_bed',
  'orange_bed',
  'magenta_bed',
  'light_blue_bed',
  'yellow_bed',
  'lime_bed',
  'pink_bed',
  'gray_bed',
  'light_gray_bed',
  'cyan_bed',
  'purple_bed',
  'blue_bed',
  'brown_bed',
  'green_bed',
  'red_bed',
  'black_bed',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
  'hopper'
])

const FILL_MATERIALS = [
  'dirt',
  'cobblestone',
  'stone',
  'oak_planks',
  'spruce_planks',
  'birch_planks'
]

const SCAFFOLD_MATERIALS = [
  'dirt',
  'cobblestone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'scaffolding'
]
const SCAFFOLD_PLATFORM_OFFSET = 3

function createSitePlan(context, worldBlocks = [], options = {}) {
  const targetByKey = new Map()
  const nonAirTargets = []
  for (const block of worldBlocks) {
    targetByKey.set(posKey(block.position), block)
    if (!isAirName(block.type)) nonAirTargets.push(block)
  }

  const bounds = boundsFor(worldBlocks)
  const coverAbove = coverLookupFromTargets(targetByKey)
  const targetStates = worldBlocks.map(block => describeTarget(context, block, options, coverAbove))
  const correct = targetStates.filter(state => state.status === 'correct')
  const placements = targetStates.filter(state => state.needsPlacement)
  const obstructions = targetStates.filter(state => state.needsClear)
  const protectedObstructions = obstructions.filter(state => state.protected)
  const hazards = targetStates.filter(state => state.hazard)
  const toolFailures = obstructions.filter(state => state.toolFailure)
  const entityObstructions = options.ignoreEntityObstructions === true
    ? []
    : findEntityObstructions(context, nonAirTargets)
  const foundationFills = planFoundationFills(context, nonAirTargets, targetByKey, options)
  const foundationHazards = foundationFills.filter(fill => fill.hazard)
  const scaffold = planScaffold(context, nonAirTargets, targetByKey, bounds, options)
  const blockedReasons = [
    ...protectedObstructions.map(state => `protected_obstruction:${state.current}:${formatPos(state.position)}`),
    ...hazards.map(state => `hazard_obstruction:${state.current}:${formatPos(state.position)}`),
    ...entityObstructions.map(state => `entity_obstruction:${state.entityName}:${formatPos(state.entityPosition)}:${formatPos(state.position)}`),
    ...foundationHazards.map(fill => `hazard_foundation:${fill.current}:${formatPos(fill.position)}`),
    ...toolFailures.map(state => `missing_clear_tool:${state.current}:${formatPos(state.position)}:${state.toolFailure}`)
  ]

  return {
    bounds,
    targetStates,
    correct,
    placements,
    obstructions,
    protectedObstructions,
    hazards,
    entityObstructions,
    foundationFills,
    scaffold,
    toolFailures,
    blockedReasons,
    summary: {
      totalTargets: worldBlocks.length,
      correct: correct.length,
      placements: placements.length,
      obstructions: obstructions.length,
      protectedObstructions: protectedObstructions.length,
      entityObstructions: entityObstructions.length,
      hazards: hazards.length + foundationHazards.length,
      foundationFills: foundationFills.filter(fill => !fill.hazard).length,
      scaffoldBlocks: scaffold.place.length
    }
  }
}

function findEntityObstructions(context, nonAirTargets = []) {
  const entities = Object.values(context?.bot?.entities || {})
  if (!entities.length || !nonAirTargets.length) return []

  const targetByKey = new Map(nonAirTargets.map(block => [posKey(block.position), block]))
  const obstructions = []
  const seen = new Set()
  for (const entity of entities) {
    if (!isBlockingBuildEntity(context, entity)) continue
    for (const position of occupiedBlockPositions(entity)) {
      const target = targetByKey.get(posKey(position))
      if (!target) continue
      const key = `${entity.id || entity.username || entity.name || 'entity'}:${posKey(position)}`
      if (seen.has(key)) continue
      seen.add(key)
      obstructions.push({
        position: target.position,
        entityName: entity.username || entity.name || entity.type || 'entity',
        entityPosition: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      })
    }
  }
  return obstructions
}

function isBlockingBuildEntity(context, entity) {
  if (!entity?.position) return false
  if (entity === context?.bot?.entity) return false
  const username = entity.username || entity.name
  if (username && username === context?.bot?.username) return false
  if (entity.name === 'item' || entity.name === 'experience_orb' || entity.name === 'item_frame') return false
  return entity.type === 'player' || entity.type === 'mob' || entity.kind === 'Hostile mobs' || entity.kind === 'Passive mobs'
}

function occupiedBlockPositions(entity) {
  const width = entity.width || 0.8
  const height = entity.height || 1.8
  const minX = Math.floor(entity.position.x - width / 2)
  const maxX = Math.floor(entity.position.x + width / 2)
  const minY = Math.floor(entity.position.y)
  const maxY = Math.floor(entity.position.y + height)
  const minZ = Math.floor(entity.position.z - width / 2)
  const maxZ = Math.floor(entity.position.z + width / 2)
  const positions = []
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        positions.push({ x, y, z })
      }
    }
  }
  return positions
}

function planMaterials(context, formalMaterials = {}, sitePlan = {}, options = {}) {
  const counts = getLiveInventoryCounts(context)
  const formalRequired = {}
  for (const state of sitePlan.placements || []) {
    if (isAirName(state.type)) continue
    for (const [itemName, count] of Object.entries(itemRequirementsForBlock(state))) {
      formalRequired[itemName] = (formalRequired[itemName] || 0) + count
    }
  }

  const foundationCount = (sitePlan.foundationFills || []).filter(fill => !fill.hazard).length
  const foundationMaterial = foundationCount > 0
    ? chooseMaterial(counts, options.foundationMaterial, FILL_MATERIALS, formalRequired)
    : null
  const foundationRequired = foundationMaterial ? { [foundationMaterial]: foundationCount } : {}

  const scaffoldCount = sitePlan.scaffold?.place?.length || 0
  const scaffoldMaterial = scaffoldCount > 0
    ? chooseMaterial(
      counts,
      options.scaffoldMaterial,
      SCAFFOLD_MATERIALS,
      { ...formalRequired, ...foundationRequired }
    )
    : null
  const scaffoldRequired = scaffoldMaterial ? { [scaffoldMaterial]: scaffoldCount } : {}

  const combined = mergeCounts(formalRequired, foundationRequired, scaffoldRequired)
  const missingMaterials = Object.entries(combined)
    .map(([item, required]) => {
      const available = counts[item] || 0
      return {
        item,
        required,
        available,
        missing: Math.max(0, required - available),
        usages: materialUsages(item, formalRequired, foundationRequired, scaffoldRequired)
      }
    })
    .filter(item => item.missing > 0)

  return {
    ok: missingMaterials.length === 0,
    inventoryCounts: counts,
    blueprintRequiredMaterials: formalMaterials,
    formalRequiredMaterials: formalRequired,
    foundationMaterial,
    foundationRequiredMaterials: foundationRequired,
    scaffoldMaterial,
    scaffoldRequiredMaterials: scaffoldRequired,
    requiredMaterials: combined,
    missingMaterials
  }
}

function planBuildOrder(worldBlocks = [], sitePlan = {}, materialPlan = {}, context = {}, options = {}) {
  const origin = options.origin || currentBotPosition(context) || { x: 0, y: 0, z: 0 }
  const clearSteps = sortClearObstructionSteps((sitePlan.obstructions || [])
    .filter(state => !state.protected && !state.hazard && !state.toolFailure)
    .map(state => ({
      kind: 'clear',
      position: state.position,
      current: state.current,
      targetType: state.type,
      phase: 'clear_obstruction'
    })))

  const foundationSteps = (sitePlan.foundationFills || [])
    .filter(fill => !fill.hazard)
    .map(fill => ({
      kind: 'foundation_fill',
      position: fill.position,
      blockName: materialPlan.foundationMaterial,
      phase: 'foundation_fill'
    }))

  const scaffoldPlaceSteps = supportAwareSortScaffoldSteps((sitePlan.scaffold?.place || []).map(step => ({
    kind: 'scaffold_place',
    position: step.position,
    blockName: materialPlan.scaffoldMaterial,
    phase: 'scaffold'
  })), {
    bounds: sitePlan.bounds,
    foundationSteps,
    correct: sitePlan.correct || [],
    origin
  })

  const scaffoldRemoveSteps = [...(sitePlan.scaffold?.remove || [])].map(step => ({
    kind: 'scaffold_remove',
    position: step.position,
    blockName: materialPlan.scaffoldMaterial,
    phase: 'cleanup'
  }))

  const placeByKey = new Map((sitePlan.placements || []).map(state => [posKey(state.position), state]))
  const allPlaceSteps = worldBlocks
    .filter(block => placeByKey.has(posKey(block.position)) && !isAirName(block.type))
    .map(block => ({
      kind: 'place',
      position: block.position,
      blockName: block.type,
      phase: block.phase || (block.interior ? 'interior' : buildPhase(block, sitePlan.bounds)),
      roomId: block.roomId || null,
      role: block.role || null,
      interior: block.interior === true,
      states: block.states || null,
      orientation: block.orientation || null
    }))

  const exteriorPlaceSteps = supportAwareSortPlaceSteps(allPlaceSteps
    .filter(step => step.phase !== 'interior' && step.interior !== true)
    .sort((a, b) => {
      const aAvoided = initialFootprintIncludes(a.position, options)
      const bAvoided = initialFootprintIncludes(b.position, options)
      if (aAvoided !== bAvoided) return aAvoided ? 1 : -1
      if (aAvoided && bAvoided) {
        const da = horizontalDistance(a.position, origin)
        const db = horizontalDistance(b.position, origin)
        if (da !== db) return db - da
      }
      if (a.position.y !== b.position.y) return a.position.y - b.position.y
      const da = horizontalDistance(a.position, origin)
      const db = horizontalDistance(b.position, origin)
      if (da !== db) return da - db
      return (a.position.x - b.position.x) || (a.position.z - b.position.z)
    }), {
      bounds: sitePlan.bounds,
      foundationSteps,
      scaffoldPlaceSteps,
      correct: sitePlan.correct || []
    })
  // #64 first pass: push the power sources behind the rest of this group *before*
  // the axis and clickable schedulers run, so a block whose only reference is a
  // redstone wire or a button is deferred by the machinery that already knows how
  // to defer (live: four y=72 beams at the fort leaned on wire that moved).
  const exteriorOrdered = orderedWithPowerSourcesLast(exteriorPlaceSteps)
  const nonFluidExteriorPlaceSteps = exteriorOrdered.filter(step => !isFluidBlockName(step.blockName))
  const fluidExteriorPlaceSteps = exteriorOrdered.filter(step => isFluidBlockName(step.blockName))

  const interiorPlaceSteps = allPlaceSteps
    .filter(step => step.phase === 'interior' || step.interior === true)
    .sort((a, b) => {
      const room = String(a.roomId || '').localeCompare(String(b.roomId || ''))
      if (room) return room
      const da = horizontalDistance(a.position, origin)
      const db = horizontalDistance(b.position, origin)
      if (da !== db) return da - db
      if (a.position.y !== b.position.y) return a.position.y - b.position.y
      return (a.position.x - b.position.x) || (a.position.z - b.position.z)
    })
  const interiorOrdered = orderedWithPowerSourcesLast(interiorPlaceSteps)
  const nonFluidInteriorPlaceSteps = interiorOrdered.filter(step => !isFluidBlockName(step.blockName))
  const fluidInteriorPlaceSteps = interiorOrdered.filter(step => isFluidBlockName(step.blockName))

  // Axis blocks (logs/stems) take their axis from the clicked face, so they
  // need a reference ON that axis, not just any neighbour. The support-aware
  // sort above is axis-agnostic (live: fort-wall-gate y=72 beam grid failed
  // with stateful_axis_no_*_reference because its only same-axis neighbours
  // were scheduled later). Hold such steps until a same-axis reference has
  // been scheduled; whatever never gets one is deferred to the tail.
  const axisSupport = createInitialSupportMap({
    bounds: sitePlan.bounds,
    foundationSteps,
    scaffoldPlaceSteps,
    correct: sitePlan.correct || []
  })
  const exteriorAxis = scheduleAxisReferenceSteps(nonFluidExteriorPlaceSteps, axisSupport)
  for (const step of scaffoldRemoveSteps) axisSupport.delete(posKey(step.position))
  const interiorAxis = scheduleAxisReferenceSteps(nonFluidInteriorPlaceSteps, axisSupport)
  const deferredAxisSteps = orderDeferredAxisSteps([...exteriorAxis.deferred, ...interiorAxis.deferred], axisSupport)

  // Second pass, beside the axis one: a step whose only neighbours are blocks
  // that eat the right-click or have no clickable face gets placed but never
  // lands, and the executor reports place_failed:unstable_air (live: round 11
  // fort-wall-gate died 62s in on a sticky_piston whose only reference was a
  // repeater). Hold such steps until a clickable reference is scheduled; the
  // ones the blueprint never provides go to the tail with a reason.
  const clickableSupport = createInitialSupportMap({
    bounds: sitePlan.bounds,
    foundationSteps,
    scaffoldPlaceSteps,
    correct: sitePlan.correct || []
  })
  const exteriorClickable = scheduleClickableReferenceSteps(exteriorAxis.scheduled, clickableSupport)
  for (const step of scaffoldRemoveSteps) clickableSupport.delete(posKey(step.position))
  const interiorClickable = scheduleClickableReferenceSteps(interiorAxis.scheduled, clickableSupport)
  for (const step of deferredAxisSteps) setSupport(clickableSupport, step.position, step.blockName)
  const deferredClickableSteps = orderDeferredClickableSteps(
    [...exteriorClickable.deferred, ...interiorClickable.deferred],
    clickableSupport
  )

  // Third pass: hoppers take their facing from the clicked cell, so they need
  // that one cell scheduled first — see scheduleClickedFaceReferenceSteps().
  const clickedFaceSupport = createInitialSupportMap({
    bounds: sitePlan.bounds,
    foundationSteps,
    scaffoldPlaceSteps,
    correct: sitePlan.correct || []
  })
  const exteriorClickedFace = scheduleClickedFaceReferenceSteps(exteriorClickable.scheduled, clickedFaceSupport)
  for (const step of scaffoldRemoveSteps) clickedFaceSupport.delete(posKey(step.position))
  const interiorClickedFace = scheduleClickedFaceReferenceSteps(interiorClickable.scheduled, clickedFaceSupport)
  for (const step of deferredAxisSteps) setSupport(clickedFaceSupport, step.position, step.blockName)
  for (const step of deferredClickableSteps) setSupport(clickedFaceSupport, step.position, step.blockName)
  const deferredClickedFaceSteps = orderDeferredClickedFaceSteps(
    [...exteriorClickedFace.deferred, ...interiorClickedFace.deferred],
    clickedFaceSupport
  )

  const exteriorFluidSchedule = scheduleOccludedFluidPlacements(
    exteriorClickedFace.scheduled,
    fluidExteriorPlaceSteps,
    exteriorPlaceSteps
  )
  const interiorFluidSchedule = scheduleOccludedFluidPlacements(
    interiorClickedFace.scheduled,
    fluidInteriorPlaceSteps,
    interiorPlaceSteps
  )
  const fluidPlaceSteps = [...fluidExteriorPlaceSteps, ...fluidInteriorPlaceSteps]

  // #64: everything that can switch a circuit on goes behind the rest of the
  // build, deferred tails included, so the wiring is only energised once the
  // structure it drives is complete. Order changes; the set does not.
  const { inert: orderedSteps, powered: powerSourceSteps } = movePowerSourcesLast([
    ...clearSteps,
    ...foundationSteps,
    ...scaffoldPlaceSteps,
    ...exteriorFluidSchedule.steps,
    ...scaffoldRemoveSteps,
    ...interiorFluidSchedule.steps,
    ...deferredAxisSteps,
    ...deferredClickableSteps,
    ...deferredClickedFaceSteps,
    ...exteriorFluidSchedule.deferred,
    ...interiorFluidSchedule.deferred
  ])

  const steps = [
    ...orderedSteps,
    ...powerSourceSteps,
    { kind: 'validate', phase: 'validate' }
  ]

  return {
    steps,
    summary: {
      clear: clearSteps.length,
      foundation: foundationSteps.length,
      scaffoldPlace: scaffoldPlaceSteps.length,
      place: allPlaceSteps.length,
      exteriorPlace: exteriorPlaceSteps.length,
      interiorPlace: interiorPlaceSteps.length,
      fluidPlace: fluidPlaceSteps.length,
      scaffoldRemove: scaffoldRemoveSteps.length,
      axisReferenceDeferred: deferredAxisSteps.length,
      axisReferenceRoots: deferredAxisSteps.filter(step => step.axisReferenceRoot === true).length,
      clickableReferenceDeferred: deferredClickableSteps.length,
      clickableReferenceRoots: deferredClickableSteps.filter(step => step.clickableReferenceRoot === true).length,
      clickedFaceReferenceDeferred: deferredClickedFaceSteps.length,
      clickedFaceReferenceRoots: deferredClickedFaceSteps.filter(step => step.clickedFaceReferenceRoot === true).length,
      clickedFaceTemporaryReferences: deferredClickedFaceSteps.filter(step => step.temporaryReference).length,
      totalSteps: steps.length
    }
  }
}

function scheduleOccludedFluidPlacements(nonFluidSteps = [], fluidSteps = [], allSteps = []) {
  const steps = [...nonFluidSteps]
  const deferred = []
  const stepByKey = new Map(allSteps.map(step => [posKey(step.position), step]))
  const containmentOffsets = [
    { x: 0, y: -1, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 }
  ]

  for (const fluidStep of fluidSteps) {
    const position = fluidStep.position
    const occluder = stepByKey.get(posKey({
      x: position.x,
      y: position.y + 1,
      z: position.z
    }))
    if (!occluder || isFluidBlockName(occluder.blockName) || !isPlacementReferenceName(occluder.blockName)) {
      deferred.push(fluidStep)
      continue
    }

    const occluderIndex = steps.indexOf(occluder)
    if (occluderIndex < 0) {
      deferred.push(fluidStep)
      continue
    }

    let lastContainmentIndex = -1
    for (const offset of containmentOffsets) {
      const containment = stepByKey.get(posKey({
        x: position.x + offset.x,
        y: position.y + offset.y,
        z: position.z + offset.z
      }))
      if (!containment ||
          isFluidBlockName(containment.blockName) ||
          !isPlacementReferenceName(containment.blockName)) {
        continue
      }
      lastContainmentIndex = Math.max(lastContainmentIndex, steps.indexOf(containment))
    }

    if (lastContainmentIndex >= occluderIndex) {
      deferred.push(fluidStep)
      continue
    }
    steps.splice(lastContainmentIndex + 1, 0, fluidStep)
  }

  return { steps, deferred }
}

function sortClearObstructionSteps(steps = []) {
  const groups = new Map()
  for (const step of steps) {
    const key = `${Math.round(step.position.x)},${Math.round(step.position.z)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(step)
  }

  const emittedColumns = new Set()
  const sorted = []
  for (const step of steps) {
    const key = `${Math.round(step.position.x)},${Math.round(step.position.z)}`
    const column = groups.get(key) || []
    if (column.length <= 1) {
      sorted.push(step)
      continue
    }
    if (emittedColumns.has(key)) continue
    sorted.push(...column.slice().sort((a, b) => b.position.y - a.position.y))
    emittedColumns.add(key)
  }
  return sorted
}

function supportAwareSortPlaceSteps(steps = [], options = {}) {
  const pending = [...steps]
  const sorted = []
  const placed = createInitialSupportMap(options)

  while (pending.length) {
    let progressed = false
    for (let index = 0; index < pending.length;) {
      const step = pending[index]
      if (hasPlacementReference(step, placed)) {
        sorted.push(step)
        setSupport(placed, step.position, step.blockName)
        pending.splice(index, 1)
        progressed = true
        continue
      }
      index += 1
    }

    if (!progressed) {
      sorted.push(...pending)
      break
    }
  }

  return sorted
}

function sortScaffoldPlaceSteps(steps = [], origin = { x: 0, y: 0, z: 0 }) {
  return [...steps].sort((a, b) => {
    if (a.position.y !== b.position.y) return a.position.y - b.position.y
    const da = horizontalDistance(a.position, origin)
    const db = horizontalDistance(b.position, origin)
    if (da !== db) return da - db
    return (a.position.x - b.position.x) || (a.position.z - b.position.z)
  })
}

function supportAwareSortScaffoldSteps(steps = [], options = {}) {
  const pending = sortScaffoldPlaceSteps(steps, options.origin)
  const sorted = []
  const placed = createInitialSupportMap({
    bounds: options.bounds,
    foundationSteps: options.foundationSteps,
    correct: options.correct
  })

  while (pending.length) {
    let progressed = false
    for (let index = 0; index < pending.length;) {
      const step = pending[index]
      if (hasPlacementReference(step, placed)) {
        sorted.push(step)
        setSupport(placed, step.position, step.blockName)
        pending.splice(index, 1)
        progressed = true
        continue
      }
      index += 1
    }

    if (!progressed) {
      sorted.push(...pending)
      break
    }
  }

  return sorted
}

function createInitialSupportMap(options = {}) {
  const supports = new Map()
  for (const step of options.foundationSteps || []) {
    setSupport(supports, step.position, step.blockName)
  }
  for (const step of options.scaffoldPlaceSteps || []) {
    setSupport(supports, step.position, step.blockName)
  }
  for (const state of options.correct || []) {
    setSupport(supports, state.position, state.type)
  }

  const bounds = options.bounds
  if (bounds) {
    const supportY = bounds.minY - 1
    for (let x = bounds.minX - 1; x <= bounds.maxX + 1; x++) {
      for (let z = bounds.minZ - 1; z <= bounds.maxZ + 1; z++) {
        supports.set(`${x},${supportY},${z}`, TERRAIN_SUPPORT)
      }
    }
  }
  return supports
}

function setSupport(supports, position, blockName) {
  if (!position || !supports) return
  if (!isPlacementReferenceName(blockName) && !isSideAttachmentReferenceName(blockName)) return
  supports.set(posKey(position), blockName)
}

function hasPlacementReference(step, placed) {
  const position = step?.position
  if (!position || !placed) return false
  const sideOffsets = [
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 }
  ]
  const verticalOffsets = [
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 }
  ]
  const sideAttached = isSideAttachedBlockName(step.blockName)
  const topAttached = requiresTopPlacementReference(step)
  const offsets = topAttached
    ? [{ x: 0, y: 1, z: 0 }]
    : sideAttached
    ? sideAttachmentOffsets(step, sideOffsets)
    : [...verticalOffsets, ...sideOffsets]
  return offsets.some(offset => {
    const supportName = placed.get(`${position.x + offset.x},${position.y + offset.y},${position.z + offset.z}`)
    return supportName === TERRAIN_SUPPORT ||
      (sideAttached ? isSideAttachmentReferenceName(supportName) : isPlacementReferenceName(supportName))
  })
}

const AXIS_BLOCK_PATTERN = /(_log|_wood|_stem|_hyphae)$/

function axisReferenceStepAxis(step) {
  if (step?.kind !== 'place' || !AXIS_BLOCK_PATTERN.test(String(step.blockName || ''))) return null
  const axis = String(step.states?.axis || step.orientation?.axis || '').toLowerCase()
  return axis === 'x' || axis === 'y' || axis === 'z' ? axis : null
}

function axisReferenceOffsets(axis) {
  if (axis === 'x') return [{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
  if (axis === 'z') return [{ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }]
  return [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }]
}

function hasAxisReference(step, axis, placed) {
  const position = step?.position
  if (!position || !placed) return false
  return axisReferenceOffsets(axis).some(offset => {
    const supportName = placed.get(`${position.x + offset.x},${position.y + offset.y},${position.z + offset.z}`)
    return supportName === TERRAIN_SUPPORT || isPlacementReferenceName(supportName)
  })
}

// Stable pass: every non-axis step keeps its slot. An axis step without a
// same-axis reference waits and is emitted right after the step that provides
// one (chains release each other). Steps that never get one come back as
// `deferred` so the caller can push them to the tail instead of letting them
// fail in place.
function scheduleAxisReferenceSteps(steps = [], placed = new Map()) {
  const scheduled = []
  const waiting = []
  const release = () => {
    let progressed = true
    while (progressed) {
      progressed = false
      for (let index = 0; index < waiting.length;) {
        const entry = waiting[index]
        if (!hasAxisReference(entry.step, entry.axis, placed)) { index += 1; continue }
        waiting.splice(index, 1)
        scheduled.push(entry.step)
        setSupport(placed, entry.step.position, entry.step.blockName)
        progressed = true
      }
    }
  }
  for (const step of steps) {
    const axis = axisReferenceStepAxis(step)
    if (axis && !hasAxisReference(step, axis, placed)) {
      waiting.push({ step, axis })
      continue
    }
    scheduled.push(step)
    if (step?.position) setSupport(placed, step.position, step.blockName)
    release()
  }
  return { scheduled, deferred: waiting.map(entry => entry.step) }
}

// Tail order for deferred axis steps: keep chains valid (a step goes after the
// neighbour it clicks against). A step with no reference anywhere in the plan
// is a root: it is emitted first and relies on the executor's temporary
// reference column at runtime.
function orderDeferredAxisSteps(deferred = [], placed = new Map()) {
  const pending = [...deferred]
  const ordered = []
  const pendingKeys = () => new Set(pending.map(step => posKey(step.position)))
  const leansOnPending = (step, keys) => axisReferenceOffsets(axisReferenceStepAxis(step)).some(offset =>
    keys.has(`${step.position.x + offset.x},${step.position.y + offset.y},${step.position.z + offset.z}`)
  )
  while (pending.length) {
    let index = pending.findIndex(step => hasAxisReference(step, axisReferenceStepAxis(step), placed))
    const root = index < 0
    if (root) {
      // Nothing is satisfiable: pick a physically floating step (no pending
      // neighbour on its axis either) as the root, so a chain such as a beam
      // resting on a column is placed column-first once the column stands.
      const keys = pendingKeys()
      index = pending.findIndex(step => !leansOnPending(step, keys))
      if (index < 0) index = 0
    }
    const step = pending.splice(index, 1)[0]
    ordered.push({ ...step, deferredReason: 'axis_reference_unresolved', axisReferenceRoot: root })
    setSupport(placed, step.position, step.blockName)
  }
  return ordered
}

// A button or lever carries its own answer to "which neighbour must be
// clicked": face says floor/ceiling/wall and, for a wall, facing says which
// side. Clicking any other neighbour yields the wrong face/facing and the
// executor's state gate fails the step (live round 14: dark_oak_button at
// 601,77,-17 came out facing=west against an expected east, and task #4 died
// there; round 11 lost 607,77,-5 the same way with face=wall!=ceiling).
// Same shape as requiredSideAttachmentOffsets() for ladders and wall torches.
function requiredFaceAttachmentOffsets(step) {
  const blockName = String(step?.blockName || '')
  if (!/_button$/.test(blockName) && blockName !== 'lever') return null
  const states = step.states || step.orientation || {}
  const face = String(states.face || '').toLowerCase()
  if (face === 'floor') return [{ x: 0, y: -1, z: 0 }]
  if (face === 'ceiling') return [{ x: 0, y: 1, z: 0 }]
  if (face !== 'wall') return null
  const facing = String(states.facing || '').toLowerCase()
  if (facing === 'west') return [{ x: 1, y: 0, z: 0 }]
  if (facing === 'east') return [{ x: -1, y: 0, z: 0 }]
  if (facing === 'north') return [{ x: 0, y: 0, z: 1 }]
  if (facing === 'south') return [{ x: 0, y: 0, z: -1 }]
  return null
}

function hasRequiredFaceAttachment(step, placed) {
  const offsets = requiredFaceAttachmentOffsets(step)
  if (!offsets || !step?.position || !placed) return true
  const position = step.position
  return offsets.some(offset => {
    const supportName = placed.get(`${position.x + offset.x},${position.y + offset.y},${position.z + offset.z}`)
    if (supportName === TERRAIN_SUPPORT) return true
    if (isUnclickableReferenceName(supportName)) return false
    return isPlacementReferenceName(supportName)
  })
}

function isUnclickableReferenceName(blockName) {
  const value = String(blockName || '')
  if (!value) return false
  return UNCLICKABLE_REFERENCE_BLOCKS.has(value) ||
    UNCLICKABLE_REFERENCE_PATTERNS.some(pattern => pattern.test(value))
}

// Same neighbour set as hasPlacementReference(), but only counting references a
// right-click can actually place against.
function hasClickableReference(step, placed) {
  const position = step?.position
  if (!position || !placed) return false
  const sideOffsets = [
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 }
  ]
  const verticalOffsets = [
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 }
  ]
  const sideAttached = isSideAttachedBlockName(step.blockName)
  const topAttached = requiresTopPlacementReference(step)
  const offsets = topAttached
    ? [{ x: 0, y: 1, z: 0 }]
    : sideAttached
    ? sideAttachmentOffsets(step, sideOffsets)
    : [...verticalOffsets, ...sideOffsets]
  return offsets.some(offset => {
    const supportName = placed.get(`${position.x + offset.x},${position.y + offset.y},${position.z + offset.z}`)
    if (supportName === TERRAIN_SUPPORT) return true
    if (isUnclickableReferenceName(supportName)) return false
    return sideAttached ? isSideAttachmentReferenceName(supportName) : isPlacementReferenceName(supportName)
  })
}

// Release condition for the clickable pass. It carries the axis pass's own
// condition so that delaying a step here can never invalidate what
// scheduleAxisReferenceSteps() already guaranteed.
function clickableReferenceSatisfied(step, placed) {
  const axis = axisReferenceStepAxis(step)
  if (axis && !hasAxisReference(step, axis, placed)) return false
  // A face-attached block has exactly one usable neighbour, so "any clickable
  // reference" is not enough: wait for that one.
  if (!hasRequiredFaceAttachment(step, placed)) return false
  // No reference at all is not this pass's business: the executor builds a
  // temporary reference column for that case. Only hold a step that has a
  // reference and cannot click any of them.
  if (!hasPlacementReference(step, placed)) return true
  return hasClickableReference(step, placed)
}

// Stable pass, same shape as scheduleAxisReferenceSteps(): every satisfied step
// keeps its slot, an unsatisfied one waits and is emitted right after the step
// that provides a clickable reference, and whatever never gets one comes back as
// `deferred` for the caller to push to the tail.
function scheduleClickableReferenceSteps(steps = [], placed = new Map()) {
  const scheduled = []
  const waiting = []
  const release = () => {
    let progressed = true
    while (progressed) {
      progressed = false
      for (let index = 0; index < waiting.length;) {
        const step = waiting[index]
        if (!clickableReferenceSatisfied(step, placed)) { index += 1; continue }
        waiting.splice(index, 1)
        scheduled.push(step)
        setSupport(placed, step.position, step.blockName)
        progressed = true
      }
    }
  }
  for (const step of steps) {
    if (step?.kind === 'place' && !clickableReferenceSatisfied(step, placed)) {
      waiting.push(step)
      continue
    }
    scheduled.push(step)
    if (step?.position) setSupport(placed, step.position, step.blockName)
    release()
  }
  return { scheduled, deferred: waiting }
}

// Tail order for the deferred steps: keep chains valid (a step goes after the
// neighbour it clicks against). A step the blueprint never gives a clickable
// neighbour is a root: the blueprint itself cannot support it, so it is emitted
// first and left to the executor's temporary reference column.
function orderDeferredClickableSteps(deferred = [], placed = new Map()) {
  const pending = [...deferred]
  const ordered = []
  while (pending.length) {
    let index = pending.findIndex(step => clickableReferenceSatisfied(step, placed))
    const root = index < 0
    if (root) {
      // Nothing is satisfiable: start the chain from a step that leans on no
      // other pending step, else from the lowest one, so a column is placed
      // bottom-up once its root stands on the temporary reference.
      const keys = new Set(pending.map(step => posKey(step.position)))
      index = pending.findIndex(step => !stepLeansOnPendingNeighbour(step, keys))
      if (index < 0) {
        index = 0
        for (let candidate = 1; candidate < pending.length; candidate++) {
          if (pending[candidate].position.y < pending[index].position.y) index = candidate
        }
      }
    }
    const step = pending.splice(index, 1)[0]
    ordered.push({ ...step, deferredReason: 'clickable_reference_unresolved', clickableReferenceRoot: root })
    setSupport(placed, step.position, step.blockName)
  }
  return ordered
}

function isClickedFaceFacingBlockName(blockName) {
  return CLICKED_FACE_FACING_BLOCKS.has(String(blockName || ''))
}

// Which cell this step must click, and which face of it, for the blueprint's
// facing to land. Returns null for anything the look can steer (the whole rest
// of the orientation table) or for a facing this family cannot produce.
function clickedFaceReferenceRequirement(step) {
  if (step?.kind !== 'place' || !step.position) return null
  if (!isClickedFaceFacingBlockName(step.blockName)) return null
  const facing = String(step.states?.facing || step.orientation?.facing || '').toLowerCase()
  const offset = CLICKED_FACE_FACING_OFFSETS[facing]
  if (!offset) return null
  return {
    position: {
      x: step.position.x + offset.x,
      y: step.position.y + offset.y,
      z: step.position.z + offset.z
    },
    // The clicked face points from the reference back at the target, i.e. the
    // opposite of the block's own facing.
    face: OPPOSITE_FACE[facing] || null,
    facing
  }
}

function clickedFaceReferenceSatisfied(step, placed) {
  const requirement = clickedFaceReferenceRequirement(step)
  if (!requirement || !placed) return true
  const supportName = placed.get(posKey(requirement.position))
  return supportName === TERRAIN_SUPPORT || isPlacementReferenceName(supportName)
}

// Third pass, beside the axis and clickable ones. A hopper takes its facing
// from the clicked cell, so "any reference will do" is wrong for it: place it
// against the wrong neighbour and the block lands with the wrong facing, both
// rulers compare hopper facing, and every resume digs it out and repeats the
// mistake (live: fort-wall-gate 603,74,-2 facing=east and 604,74,-2
// facing=west each want the other as their reference — a deadlock no ordering
// can break on its own). Hold such a step until the cell it must click is
// scheduled; the ones that never get it come back as `deferred`.
function scheduleClickedFaceReferenceSteps(steps = [], placed = new Map()) {
  const scheduled = []
  const waiting = []
  const emit = step => {
    const requirement = clickedFaceReferenceRequirement(step)
    scheduled.push(requirement ? { ...step, clickedFaceReference: requirement } : step)
  }
  const release = () => {
    let progressed = true
    while (progressed) {
      progressed = false
      for (let index = 0; index < waiting.length;) {
        const step = waiting[index]
        if (!clickedFaceReferenceSatisfied(step, placed)) { index += 1; continue }
        waiting.splice(index, 1)
        emit(step)
        setSupport(placed, step.position, step.blockName)
        progressed = true
      }
    }
  }
  for (const step of steps) {
    if (step?.kind === 'place' && !clickedFaceReferenceSatisfied(step, placed)) {
      waiting.push(step)
      continue
    }
    emit(step)
    if (step?.position) setSupport(placed, step.position, step.blockName)
    release()
  }
  return { scheduled, deferred: waiting }
}

// Tail order for the deferred ones. Whatever is left is a cycle: every member
// wants a cell that another member still owes it. Any member can be the root —
// give the root a temporary block in the cell it must click, and the rest of
// the cycle falls into place behind it, so ONE temporary block breaks a cycle
// of any length (2 members: A on a temp block at B, then B clicks A. 3: same,
// then the other two chain). That is why there is no unresolvable_reference_cycle
// here: a cycle is always resolvable, and the only unschedulable case — a
// facing this family cannot produce — never enters the pass, because
// clickedFaceReferenceRequirement() returns null and the step counts as
// satisfied.
function orderDeferredClickedFaceSteps(deferred = [], placed = new Map()) {
  const pending = [...deferred]
  const ordered = []
  while (pending.length) {
    let index = pending.findIndex(step => clickedFaceReferenceSatisfied(step, placed))
    const root = index < 0
    // Stable: the earliest step of the cycle in the incoming order is the root.
    if (root) index = 0
    const step = pending.splice(index, 1)[0]
    const requirement = clickedFaceReferenceRequirement(step)
    ordered.push({
      ...step,
      ...(requirement ? { clickedFaceReference: requirement } : {}),
      // Only the root needs a block conjured into the cell it clicks; the rest
      // of the cycle finds a real block there by the time they run.
      ...(root && requirement ? { temporaryReference: { position: requirement.position, face: requirement.face } } : {}),
      deferredReason: 'clicked_face_reference_unresolved',
      clickedFaceReferenceRoot: root
    })
    setSupport(placed, step.position, step.blockName)
  }
  return ordered
}

function stepLeansOnPendingNeighbour(step, keys) {
  const position = step?.position
  if (!position) return false
  const offsets = [
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 }
  ]
  return offsets.some(offset =>
    keys.has(`${position.x + offset.x},${position.y + offset.y},${position.z + offset.z}`)
  )
}

function isSideAttachedBlockName(blockName) {
  const value = String(blockName || '')
  return value === 'ladder' ||
    value === 'tripwire_hook' ||
    value.endsWith('_wall_sign') ||
    value.endsWith('_wall_banner') ||
    value.endsWith('_wall_torch')
}

function requiresTopPlacementReference(step) {
  return step?.blockName === 'lantern' &&
    String(step.states?.hanging || step.orientation?.hanging || '').toLowerCase() === 'true'
}

function requiredSideAttachmentOffsets(step) {
  if (!isSideAttachedBlockName(step?.blockName)) return null
  const facing = String(step.states?.facing || step.orientation?.facing || '').toLowerCase()
  if (facing === 'west') return [{ x: 1, y: 0, z: 0 }]
  if (facing === 'east') return [{ x: -1, y: 0, z: 0 }]
  if (facing === 'north') return [{ x: 0, y: 0, z: 1 }]
  if (facing === 'south') return [{ x: 0, y: 0, z: -1 }]
  return null
}

function sideAttachmentOffsets(step, sideOffsets = []) {
  if (!isSideAttachedBlockName(step?.blockName)) return null
  const preferred = requiredSideAttachmentOffsets(step) || []
  const offsets = [...preferred]
  for (const offset of sideOffsets) {
    if (!offsets.some(candidate => candidate.x === offset.x && candidate.y === offset.y && candidate.z === offset.z)) {
      offsets.push(offset)
    }
  }
  return offsets
}

function isPlacementReferenceName(blockName) {
  const value = String(blockName || '')
  if (!value || isAirName(value)) return false
  return !NON_REFERENCE_BLOCK_PATTERNS.some(pattern => pattern.test(value))
}

function isSideAttachmentReferenceName(blockName) {
  const value = String(blockName || '')
  if (!value || isAirName(value)) return false
  return ![
    /water$/,
    /lava$/,
    /fire$/,
    /carpet$/,
    /_bed$/,
    /^bed$/,
    /sign$/,
    /banner$/,
    /flower$/,
    /^(short_)?grass$/,
    /sapling$/
  ].some(pattern => pattern.test(value))
}

function initialFootprintIncludes(position, options = {}) {
  if (options.avoidInitialFootprint !== true || !position || !options.origin) return false
  const dx = Math.abs(position.x - options.origin.x)
  const dz = Math.abs(position.z - options.origin.z)
  const dy = position.y - options.origin.y
  return dx <= 1 && dz <= 1 && dy >= 0 && dy <= 1
}

function validateBuild(context, worldBlocks = [], scaffold = [], options = {}) {
  const failures = []
  const targetByKey = new Map(worldBlocks.map(block => [posKey(block.position), block]))
  const coverAbove = coverLookupFromTargets(targetByKey)
  for (const block of worldBlocks) {
    const actual = blockNameAt(context, block.position)
    if (isAirName(block.type)) {
      if (!isAirName(actual)) failures.push({ position: block.position, expected: 'air', actual })
    } else if (
      actual !== block.type &&
      !legacyBlockNameMatches(actual, block.type, block.states || block.orientation) &&
      !isStableNaturalTargetEquivalent(actual, block.type, block.position, options) &&
      !isCoveredGrassDecayEquivalent(actual, block.type, block.position, coverAbove)
    ) {
      failures.push({ position: block.position, expected: block.type, actual })
    }
  }

  for (const step of scaffold) {
    const actual = blockNameAt(context, step.position)
    if (!isAirName(actual)) failures.push({ position: step.position, expected: 'air', actual, temporary: true })
  }

  return {
    ok: failures.length === 0,
    failures
  }
}

function describeTarget(context, block, options, coverAbove = null) {
  const current = blockNameAt(context, block.position)
  const desiredAir = isAirName(block.type)
  const currentAir = isAirName(current)
  // Keep the exact formal target in the work graph so material resolution and
  // construction-run lineage can record which natural variant is in use. The
  // executor/reconciler and final validator accept stable natural equivalence.
  const correct = desiredAir
    ? currentAir
    : current === block.type ||
      legacyBlockNameMatches(current, block.type, block.states || block.orientation) ||
      isCoveredGrassDecayEquivalent(current, block.type, block.position, coverAbove)
  const replaceableObstruction = isReplaceableWaterObstruction(current, block.type, options)
  const needsClear = !correct && !currentAir && !replaceableObstruction
  const protectedBlock = needsClear && isProtectedSiteBlock(current, options)
  const hazard = needsClear && HAZARD_BLOCKS.has(current)
  const toolFailure = needsClear && !protectedBlock && !hazard
    ? clearToolFailure(context, current)
    : null

  return {
    type: block.type,
    position: block.position,
    states: block.states || null,
    orientation: block.orientation || null,
    current,
    status: correct ? 'correct' : (currentAir ? 'missing' : 'obstructed'),
    needsPlacement: !desiredAir && !correct,
    needsClear,
    replaceableObstruction,
    protected: protectedBlock,
    hazard,
    toolFailure
  }
}

function isStableNaturalTargetEquivalent(actualName, expectedName, position, options = {}) {
  const originY = Math.floor(Number(options.origin?.y))
  const targetY = Math.floor(Number(position?.y))
  if (!Number.isFinite(originY) || !Number.isFinite(targetY) || targetY !== originY) return false
  // Dirt and grass at the imported terrain/base layer can naturally cycle in
  // either direction: grass spreads onto exposed dirt, while covered grass
  // decays back to dirt.  Keeping this equivalence at origin Y avoids an
  // endless clear/place loop without weakening structural blocks above it.
  return (expectedName === 'dirt' && actualName === 'grass_block') ||
    (expectedName === 'grass_block' && actualName === 'dirt')
}

// Boss-decreed comparable-state exemption (round 9 ruling, same class as the
// door-hinge concession): grass_block that the blueprint itself covers with a
// non-air block at (x, y+1, z) inevitably decays to dirt under vanilla rules,
// so the bot can never maintain it. One-way ONLY — expected grass_block with
// actual dirt; the reverse and every other type difference stay enforced.
// Coverage is judged from the blueprint, never the live world, keeping the
// check deterministic. `coverAbove` receives the cell to test (already +1).
function isCoveredGrassDecayEquivalent(actualName, expectedName, position, coverAbove) {
  if (expectedName !== 'grass_block' || actualName !== 'dirt') return false
  if (typeof coverAbove !== 'function' || !position) return false
  return coverAbove({ x: position.x, y: position.y + 1, z: position.z }) === true
}

function coverLookupFromTargets(targetByKey) {
  if (!targetByKey || typeof targetByKey.get !== 'function') return null
  return position => {
    const above = targetByKey.get(posKey(position))
    return !!above && isGrassSmotheringCover(above.type)
  }
}

// Vanilla lets grass survive under light-passing covers: snow layers turn it
// snowy, and glass/leaves pass enough light. Only covers that actually smother
// grass qualify for the decay exemption — anything else and the bot CAN keep
// the grass alive, so the standard stays enforced. (Tinted glass blocks light
// completely and therefore smothers.)
function isGrassSmotheringCover(coverName) {
  const value = String(coverName || '')
  if (!value || isAirName(value)) return false
  if (value === 'snow') return false
  if (value.endsWith('_leaves')) return false
  if (value === 'glass' || value === 'glass_pane' || value.endsWith('_glass') || value.endsWith('_glass_pane')) {
    return value === 'tinted_glass'
  }
  return true
}

function isReplaceableWaterObstruction(current, targetType, options = {}) {
  if (options.allowWaterReplacement === false) return false
  if (current !== 'water') return false
  if (isAirName(targetType) || targetType === 'water' || targetType === 'lava') return false
  return true
}

function planFoundationFills(context, nonAirTargets, targetByKey, options) {
  const fills = []
  const seen = new Set()
  const lowestByColumn = new Map()
  const minTargetY = Math.min(...nonAirTargets.map(block => block.position.y))
  for (const block of nonAirTargets) {
    const columnKey = `${block.position.x},${block.position.z}`
    const existing = lowestByColumn.get(columnKey)
    if (!existing || block.position.y < existing.position.y) lowestByColumn.set(columnKey, block)
  }

  for (const block of lowestByColumn.values()) {
    if (block.position.y !== minTargetY) continue
    const below = {
      x: block.position.x,
      y: block.position.y - 1,
      z: block.position.z
    }
    const belowKey = posKey(below)
    const plannedBelow = targetByKey.get(belowKey)
    if (plannedBelow && !isAirName(plannedBelow.type)) continue
    if (seen.has(belowKey)) continue
    seen.add(belowKey)

    const current = blockNameAt(context, below)
    if (isAirName(current)) {
      fills.push({ position: below, current, reason: 'air_under_blueprint' })
    } else if (HAZARD_BLOCKS.has(current)) {
      fills.push({ position: below, current, hazard: true, reason: 'hazard_under_blueprint' })
    }
  }
  return fills
}

function planScaffold(context, nonAirTargets, targetByKey, bounds, options = {}) {
  if (!bounds || nonAirTargets.length === 0) return { place: [], remove: [] }
  if (options.skipScaffolding === true) return { place: [], remove: [] }
  const threshold = options.scaffoldHeightThreshold ?? 3
  const maxTargetY = Math.max(...nonAirTargets.map(block => block.position.y))
  const highTargets = nonAirTargets.filter(block => block.position.y - bounds.minY >= threshold)
  if (!highTargets.length) return { place: [], remove: [] }
  const scaffoldTopY = Math.max(bounds.minY, maxTargetY - 4)
  const highestTargets = highTargets.filter(block => block.position.y === maxTargetY)
  const highBounds = boundsFor(highestTargets.length ? highestTargets : highTargets)
  if ((highBounds.maxX - highBounds.minX + 1) * (highBounds.maxZ - highBounds.minZ + 1) <= 1) {
    const place = []
    const seen = new Set()
    const column = findScaffoldColumn(context, targetByKey, bounds, highBounds, maxTargetY) || {
      x: bounds.maxX + 1,
      z: highBounds.minZ
    }
    for (let y = bounds.minY; y <= maxTargetY; y++) {
      pushScaffoldPosition(context, targetByKey, place, seen, {
        x: column.x,
        y,
        z: column.z
      })
    }
    return {
      place,
      remove: [...place].reverse()
    }
  }
  const scaffoldLines = [
    { z: highBounds.minZ - SCAFFOLD_PLATFORM_OFFSET, rampId: 'front' }
  ]
  if (highBounds.maxZ - highBounds.minZ >= 3) {
    scaffoldLines.push({ z: highBounds.maxZ + SCAFFOLD_PLATFORM_OFFSET, rampId: 'back' })
  }

  const place = []
  const seen = new Set()
  const rampHeight = scaffoldTopY - bounds.minY + 1
  const addScaffoldLine = line => {
    for (let step = 0; step < rampHeight; step++) {
      const x = highBounds.minX - rampHeight + step
      const topY = bounds.minY + step
      for (let y = bounds.minY; y <= topY; y++) {
        pushScaffoldPosition(context, targetByKey, place, seen, { x, y, z: line.z })
      }
    }
    for (let x = highBounds.minX; x <= highBounds.maxX; x++) {
      pushScaffoldPosition(context, targetByKey, place, seen, { x, y: scaffoldTopY, z: line.z })
    }
  }
  const [frontLine, ...remainingLines] = scaffoldLines
  addScaffoldLine(frontLine)
  addRoofSideWorkPlatform(context, targetByKey, place, seen, highBounds, bounds.minY, scaffoldTopY, scaffoldLines)
  for (const line of remainingLines) addScaffoldLine(line)
  return {
    place,
    remove: [...place].reverse()
  }
}

function addRoofSideWorkPlatform(context, targetByKey, place, seen, highBounds, baseY, scaffoldTopY, scaffoldLines = []) {
  const frontZ = scaffoldLines[0]?.z ?? highBounds.minZ - 4
  const sideLineZs = scaffoldLines.map(line => line.z)
  const minZ = Math.min(frontZ, ...sideLineZs, highBounds.minZ)
  const maxZ = Math.max(frontZ, ...sideLineZs, highBounds.maxZ)
  const sideX = highBounds.maxX + 3
  addScaffoldColumn(context, targetByKey, place, seen, sideX, frontZ, baseY, scaffoldTopY)
  for (let x = highBounds.maxX + 1; x <= sideX; x++) {
    pushScaffoldPosition(context, targetByKey, place, seen, { x, y: scaffoldTopY, z: frontZ })
  }
  for (let z = minZ; z <= maxZ; z++) {
    pushScaffoldPosition(context, targetByKey, place, seen, { x: sideX, y: scaffoldTopY, z })
  }
  for (const z of sideLineZs) {
    if (z === frontZ) continue
    for (let x = sideX - 1; x >= highBounds.maxX + 1; x--) {
      pushScaffoldPosition(context, targetByKey, place, seen, { x, y: scaffoldTopY, z })
    }
  }

  const leftSideX = highBounds.minX - 3
  addScaffoldColumn(context, targetByKey, place, seen, leftSideX, frontZ, baseY, scaffoldTopY)
  for (let x = highBounds.minX - 1; x >= leftSideX; x--) {
    pushScaffoldPosition(context, targetByKey, place, seen, { x, y: scaffoldTopY, z: frontZ })
  }
  for (let z = minZ; z <= maxZ; z++) {
    pushScaffoldPosition(context, targetByKey, place, seen, { x: leftSideX, y: scaffoldTopY, z })
  }
  for (const z of sideLineZs) {
    if (z === frontZ) continue
    for (let x = leftSideX + 1; x <= highBounds.minX - 1; x++) {
      pushScaffoldPosition(context, targetByKey, place, seen, { x, y: scaffoldTopY, z })
    }
  }
}

function addScaffoldColumn(context, targetByKey, place, seen, x, z, baseY, topY) {
  for (let y = baseY; y <= topY; y++) {
    pushScaffoldPosition(context, targetByKey, place, seen, { x, y, z })
  }
}

function findScaffoldColumn(context, targetByKey, bounds, highBounds, maxY) {
  const candidates = [
    { x: bounds.maxX + 1, z: highBounds.minZ },
    { x: bounds.minX - 1, z: highBounds.minZ },
    { x: highBounds.minX, z: bounds.maxZ + 1 },
    { x: highBounds.minX, z: bounds.minZ - 1 }
  ]
  return candidates.find(candidate => scaffoldColumnClear(context, targetByKey, candidate, bounds.minY, maxY)) || null
}

function scaffoldColumnClear(context, targetByKey, column, minY, maxY) {
  for (let y = minY; y <= maxY; y++) {
    const position = { x: column.x, y, z: column.z }
    if (targetByKey.has(posKey(position))) return false
    if (!isAirName(blockNameAt(context, position))) return false
  }
  return true
}

function pushScaffoldPosition(context, targetByKey, place, seen, position) {
  const positionKey = posKey(position)
  if (seen.has(positionKey)) return
  seen.add(positionKey)
  if (targetByKey.has(positionKey)) return
  if (!isAirName(blockNameAt(context, position))) return
  place.push({ position })
}

function clearToolFailure(context, blockName) {
  const equipment = context.equipmentSystem || context.autoPreparationSystem?.equipmentSystem
  if (!equipment || typeof equipment.selectBestToolForBlock !== 'function') return null
  const selection = equipment.selectBestToolForBlock(blockName, context)
  if (selection?.success) return null
  if (selection?.reason === 'missing_required_tool') {
    return selection.requiredTool || selection.reason
  }
  return null
}

function chooseMaterial(counts, explicit, candidates, reserved = {}) {
  if (explicit) return explicit
  for (const name of candidates) {
    if ((counts[name] || 0) > (reserved[name] || 0)) return name
  }
  return candidates[0]
}

function materialUsages(item, formal, foundation, scaffold) {
  const usages = []
  if (formal[item]) usages.push({ usage: 'formal', count: formal[item] })
  if (foundation[item]) usages.push({ usage: 'foundation', count: foundation[item] })
  if (scaffold[item]) usages.push({ usage: 'scaffold', count: scaffold[item] })
  return usages
}

function mergeCounts(...sets) {
  const merged = {}
  for (const set of sets) {
    for (const [name, count] of Object.entries(set || {})) {
      if (!name || !count) continue
      merged[name] = (merged[name] || 0) + count
    }
  }
  return merged
}

function getLiveInventoryCounts(context = {}) {
  const liveItems = context.bot?.inventory?.items?.()
  if (Array.isArray(liveItems)) {
    const counts = {}
    for (const item of liveItems) counts[item.name] = (counts[item.name] || 0) + (item.count || 0)
    return counts
  }
  return getInventoryCounts(context)
}

function blockNameAt(context, position) {
  try {
    return context.bot?.blockAt?.(toBlockVec3(position))?.name || 'air'
  } catch {
    return 'air'
  }
}

function boundsFor(blocks) {
  if (!blocks.length) return null
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.position.x),
    maxX: Math.max(bounds.maxX, block.position.x),
    minY: Math.min(bounds.minY, block.position.y),
    maxY: Math.max(bounds.maxY, block.position.y),
    minZ: Math.min(bounds.minZ, block.position.z),
    maxZ: Math.max(bounds.maxZ, block.position.z)
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  })
}

// Blocks that switch a circuit on the moment they are placed. Building round
// 20, live: she placed the roof redstone torch in blueprint order, the circuit
// went live, the piston at 604,79,-9 extended, and its head took over
// 604,79,-8 — a cell the blueprint still wanted a block in. Resume then read
// the head as an obstruction, tried to clear it, and stopped after three
// strikes on the same cell. Boss decision #64: power sources go in after the
// whole building stands, so nothing is energised while blocks are still
// arriving.
//
// Redstone wire is deliberately NOT here, though decision #64 named it. Wire
// carries no charge of its own — without a torch, lever or block driving it,
// laying wire early energises nothing — and four of the fort's y=72 beams use
// a wire as the same-axis reference they are placed against (606,72,-6,
// 606,72,-4, 602,72,-3, 602,72,-1). Moving it to the tail left those beams
// with nothing to click, which the axis-order suite caught. Sources last,
// wiring in place: the circuit is complete but dead until the last torch.
//
// The rest of the redstone family — piston, sticky_piston, repeater,
// comparator, observer, hopper, dropper, dispenser — is inert until powered
// and keeps its place in the normal order, where it can still serve as a
// reference for its neighbours.
const REDSTONE_POWER_SOURCE_BLOCKS = new Set([
  'redstone_torch',
  'redstone_wall_torch',
  'redstone_block',
  'lever',
  'daylight_detector',
  'target'
])

const REDSTONE_POWER_SOURCE_PATTERNS = [
  /_button$/,
  /_pressure_plate$/
]

function isRedstonePowerSourceBlockName(blockName) {
  const name = String(blockName || '')
  if (!name) return false
  if (REDSTONE_POWER_SOURCE_BLOCKS.has(name)) return true
  return REDSTONE_POWER_SOURCE_PATTERNS.some(pattern => pattern.test(name))
}

// Stable partition: the power sources keep the order the schedulers gave them,
// they just all move behind everything else that is being placed.
function movePowerSourcesLast(steps = []) {
  const inert = []
  const powered = []
  for (const step of steps) {
    if (step?.kind === 'place' && isRedstonePowerSourceBlockName(step.blockName)) powered.push(step)
    else inert.push(step)
  }
  return { inert, powered }
}

function orderedWithPowerSourcesLast(steps = []) {
  const { inert, powered } = movePowerSourcesLast(steps)
  return [...inert, ...powered]
}
function buildPhase(block, bounds) {
  if (!bounds) return 'structure'
  if (block.position.y === bounds.minY) return 'floor'
  if (block.position.y === bounds.maxY) return 'roof'
  return 'wall'
}

function currentBotPosition(context) {
  const position = context.blackboard?.get?.('bot.position') || context.bot?.entity?.position
  if (!position) return null
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  }
}

function horizontalDistance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)
}

function isProtectedSiteBlock(name, options = {}) {
  if (options.allowProtectedClearing === true) return false
  return PROTECTED_SITE_BLOCKS.has(name)
}

function isAirName(name) {
  return AIR_BLOCKS.has(name)
}

function isFluidBlockName(name) {
  return name === 'water' || name === 'lava'
}

function posKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function formatPos(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

module.exports = {
  isRedstonePowerSourceBlockName,
  REDSTONE_POWER_SOURCE_BLOCKS,
  AIR_BLOCKS,
  FILL_MATERIALS,
  HAZARD_BLOCKS,
  PROTECTED_SITE_BLOCKS,
  SCAFFOLD_MATERIALS,
  coverLookupFromTargets,
  createSitePlan,
  getLiveInventoryCounts,
  isAirName,
  isCoveredGrassDecayEquivalent,
  isGrassSmotheringCover,
  isStableNaturalTargetEquivalent,
  clickedFaceReferenceRequirement,
  isClickedFaceFacingBlockName,
  orderDeferredAxisSteps,
  orderDeferredClickableSteps,
  orderDeferredClickedFaceSteps,
  requiredFaceAttachmentOffsets,
  planBuildOrder,
  planMaterials,
  posKey,
  scheduleAxisReferenceSteps,
  scheduleClickableReferenceSteps,
  scheduleClickedFaceReferenceSteps,
  validateBuild
}
