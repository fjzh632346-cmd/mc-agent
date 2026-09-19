const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])

const STYLE_ALIASES = Object.freeze({
  survival: 'wood',
  starter: 'wood',
  farmhouse: 'wood',
  manor: 'wood',
  wood_house: 'wood',
  two_story_wood_house: 'wood',
  simple_farmhouse: 'wood',
  starter_shelter: 'wood',
  small_house: 'wood',
  modern_villa: 'modern',
  villa: 'modern',
  modern: 'modern',
  castle_garden: 'castle',
  castle: 'castle'
})

const DESIGNABLE_NAME_PATTERNS = [
  /house/,
  /shelter/,
  /villa/,
  /castle/,
  /farmhouse/,
  /manor/
]

const STYLE_GRAMMARS = Object.freeze({
  modern: {
    palette: ['white_concrete', 'gray_concrete', 'glass'],
    roofTypes: ['flat', 'stepped_flat'],
    requiredFeatures: ['large_windows', 'volume_offsets', 'clean_geometry']
  },
  wood: {
    palette: ['oak_planks', 'oak_log', 'glass'],
    roofTypes: ['gabled', 'stepped_gabled'],
    requiredFeatures: ['beam_structure', 'pitched_roof', 'irregular_windows', 'wood_layering']
  },
  castle: {
    palette: ['stone_bricks', 'cobblestone', 'glass'],
    roofTypes: ['battlement'],
    requiredFeatures: ['thick_stone_walls', 'battlements', 'tower', 'local_symmetry']
  }
})

class BuildingDesigner {
  constructor(options = {}) {
    this.options = {
      enabled: options.enabled !== false,
      pureBoxFillThreshold: options.pureBoxFillThreshold ?? 0.95,
      similarityThreshold: options.similarityThreshold ?? 0.9,
      ...options
    }
  }

  transformBlueprint(blueprint, request = {}) {
    if (!this.options.enabled) {
      return {
        ok: true,
        blueprint,
        design: disabledDesign(blueprint),
        diagnostics: { transformed: false, reason: 'designer_disabled' }
      }
    }
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return { ok: false, error: 'invalid_blueprint_for_design' }
    }

    const analysis = analyzeBlueprint(blueprint)
    const style = normalizeStyle(request.style || blueprint.metadata?.style || blueprint.metadata?.buildingType || request.blueprintName || blueprint.name)
    const designable = isDesignableBlueprint(blueprint, request, style)
    const styleValidationBefore = validateStyleGrammar(blueprint, style, null)
    const mustTransform = designable && (
      analysis.isPureBox ||
      !blueprint.metadata?.style ||
      !styleValidationBefore.ok ||
      shouldForceVariation(request)
    )

    const design = createDesignSchema({
      blueprint,
      request,
      style,
      analysis,
      transformed: mustTransform,
      reason: mustTransform
        ? transformationReason(analysis, blueprint, styleValidationBefore, request)
        : 'style_and_silhouette_already_acceptable'
    })

    if (!mustTransform) {
      return {
        ok: true,
        blueprint: annotateBlueprint(blueprint, design, false),
        design,
        diagnostics: {
          transformed: false,
          reason: design.reason,
          analysis,
          styleValidation: styleValidationBefore
        }
      }
    }

    const generated = generateBlueprintFromDesign(blueprint, design)
    const styleValidation = validateStyleGrammar(generated, design.style, design)
    const facadeValidation = validateFacade(generated)
    const transformed = annotateBlueprint(generated, {
      ...design,
      styleValidation,
      facadeValidation,
      metrics: {
        ...styleValidation.metrics,
        pureBox: styleValidation.metrics?.isPureBox === true
      },
      silhouette: {
        ...design.silhouette,
        after: analyzeBlueprint(generated)
      }
    }, true)

    return {
      ok: true,
      blueprint: transformed,
      design: transformed.metadata.design,
      diagnostics: {
        transformed: true,
        reason: design.reason,
        analysis,
        styleValidation,
        facadeValidation
      }
    }
  }

  design(input = {}) {
    const blueprint = input.blueprint || { name: input.blueprintName || input.type || 'building', blocks: [] }
    const style = normalizeStyle(input.style || input.type || input.blueprintName || blueprint.name)
    const analysis = analyzeBlueprint(blueprint)
    const design = createDesignSchema({
      blueprint,
      request: input,
      style,
      analysis,
      transformed: true,
      reason: 'concept_to_design'
    })
    return { ok: true, design }
  }
}

function createDesignSchema({ blueprint, request = {}, style, analysis, transformed, reason }) {
  const resolvedStyle = style || 'wood'
  const variant = designVariant(request, analysis)
  return {
    layer: 'design',
    style: resolvedStyle,
    buildingType: canonicalBuildingType(request.blueprintName || blueprint.metadata?.buildingType || blueprint.name, resolvedStyle),
    transformed: Boolean(transformed),
    reason,
    variant,
    silhouette: silhouetteForStyle(resolvedStyle, analysis, variant),
    volumeSegmentation: volumesForStyle(resolvedStyle, variant),
    roofType: roofForStyle(resolvedStyle),
    symmetryRules: symmetryForStyle(resolvedStyle, variant),
    facadeLayout: facadeForStyle(resolvedStyle, variant),
    styleGrammar: STYLE_GRAMMARS[resolvedStyle] || null,
    original: {
      blueprintName: blueprint.name,
      blockCount: blueprint.blocks?.length || 0,
      pureBox: analysis.isPureBox,
      footprintFill: analysis.footprintFill,
      uniqueColumnHeights: analysis.uniqueColumnHeights
    }
  }
}

function generateBlueprintFromDesign(original, design) {
  if (design.style === 'modern') return modernVillaBlueprint(original, design)
  if (design.style === 'castle') return castleBlueprint(original, design)
  return woodHouseBlueprint(original, design)
}

function isTwoStoryWoodDesign(original, design) {
  const text = `${design?.buildingType || ''} ${original?.name || ''} ${original?.metadata?.buildingType || ''}`.toLowerCase()
  return /two[_\s-]*story|2[_\s-]*story/.test(text)
}

function woodHouseBlueprint(original, design) {
  const b = new DesignBlockBuilder(original.name, 'Designed wood house with stepped silhouette, beams, gabled roof, and grouped windows', original.metadata)
  const twoStory = isTwoStoryWoodDesign(original, design)
  b.metadata = {
    ...b.metadata,
    style: 'wood',
    buildingType: canonicalBuildingType(original.name, 'wood'),
    interiorProfile: twoStory ? 'two_story_wood_house' : (original.metadata?.interiorProfile || 'basic_house'),
    skipScaffolding: !twoStory
  }

  woodVolume(b, { id: 'main', minX: 0, maxX: 4, minZ: 0, maxZ: 3, wallTop: 2 })
  woodVolume(b, { id: 'side_wing', minX: 3, maxX: 5, minZ: 2, maxZ: 4, wallTop: 2 })
  woodPorch(b)
  gabledRoof(b, { minX: 0, maxX: 4, minZ: 0, maxZ: 3, eaveY: 3, ridgeY: 4, axis: 'x', material: 'oak_planks', phase: 'roof_high' })
  gabledRoof(b, { minX: 3, maxX: 5, minZ: 2, maxZ: 4, eaveY: 3, ridgeY: 4, axis: 'z', material: 'oak_planks', phase: 'roof_low' })
  if (twoStory) addWoodUpperStory(b)

  addOpening(b, 2, 1, 0, 'doorway')
  addOpening(b, 2, 2, 0, 'doorway')
  addWindowGroup(b, [{ x: 0, y: 2, z: 1 }, { x: 0, y: 2, z: 2 }], 'front_left_group')
  addWindowGroup(b, [{ x: 4, y: 2, z: 1 }, { x: 4, y: 2, z: 2 }], 'front_right_group')
  addWindowGroup(b, [{ x: 5, y: 2, z: 3 }], 'side_irregular')
  addWindowGroup(b, [{ x: 3, y: 2, z: 4 }, { x: 4, y: 2, z: 4 }], 'rear_pair')
  b.set(1, 2, 0, 'oak_planks', { phase: 'facade_mid', role: 'timber_mid_trim', volumeId: 'main' })
  b.set(3, 2, 3, 'oak_planks', { phase: 'facade_mid', role: 'timber_mid_trim', volumeId: 'main' })

  b.fill(0, 0, -1, 4, 0, -1, 'oak_planks', { phase: 'porch', role: 'protrusion' })
  b.set(1, 1, -1, 'oak_log', { phase: 'column', role: 'porch_post' })
  b.set(1, 2, -1, 'oak_log', { phase: 'column', role: 'porch_post' })
  b.set(3, 1, -1, 'oak_log', { phase: 'column', role: 'porch_post' })
  b.set(3, 2, -1, 'oak_log', { phase: 'column', role: 'porch_post' })
  b.fill(1, 3, -1, 3, 3, -1, 'oak_planks', { phase: 'roof_low', role: 'porch_roof' })

  b.metadata.rooms = [
    room('ground_main', 'living_room', 1, 1, 1, 3, 1, 2),
    ...(twoStory ? [room('upper_sleeping', 'bedroom', 6, 4, 2, 7, 4, 3)] : [room('upper_sleeping', 'bedroom', 1, 2, 1, 3, 2, 2)]),
    room('side_workshop', 'work', 4, 1, 3, 4, 1, 4)
  ]
  b.metadata.walkways = [
    rect(2, 1, 0, 2, 1, 0),
    rect(3, 1, 2, 4, 1, 3)
  ]
  b.metadata.doorways = [pos(2, 1, 0), pos(2, 2, 0)]
  b.metadata.windows = b.blocks().filter(block => block.role === 'window').map(block => pos(block.x, block.y, block.z))
  b.metadata.interiorAnchors = [
    anchor('bed', 'white_wool', 1, 1, 2, 'ground_main', 'bedroom'),
    anchor('crafting_table', 'crafting_table', 2, 1, 1, 'ground_main', 'work'),
    anchor('furnace', 'furnace', 4, 1, 4, 'side_workshop', 'work'),
    anchor('chest', 'chest', 3, 1, 1, 'ground_main', 'storage'),
    anchor('table', 'oak_planks', 1, 1, 1, 'ground_main', 'living_room')
  ]

  return b.blueprint(design)
}

function modernVillaBlueprint(original, design) {
  const b = new DesignBlockBuilder(original.name, 'Designed modern villa with offset volumes, large glass facade, and stepped flat roofs', original.metadata)
  b.metadata = {
    ...b.metadata,
    style: 'modern',
    buildingType: canonicalBuildingType(original.name, 'modern'),
    interiorProfile: 'modern_villa'
  }

  modernVolume(b, { id: 'living_volume', minX: 0, maxX: 4, minZ: 0, maxZ: 3, wallTop: 2, roofY: 3, wall: 'white_concrete', accent: 'gray_concrete' })
  modernVolume(b, { id: 'bedroom_volume', minX: 3, maxX: 6, minZ: 1, maxZ: 4, wallTop: 3, roofY: 4, wall: 'white_concrete', accent: 'gray_concrete' })
  modernVolume(b, { id: 'entry_volume', minX: 0, maxX: 2, minZ: 4, maxZ: 5, wallTop: 1, roofY: 2, wall: 'gray_concrete', accent: 'white_concrete', floor: 'gray_concrete' })

  addWindowGroup(b, [
    { x: 1, y: 1, z: 0 }, { x: 1, y: 2, z: 0 },
    { x: 2, y: 1, z: 0 }, { x: 2, y: 2, z: 0 },
    { x: 3, y: 1, z: 0 }, { x: 3, y: 2, z: 0 }
  ], 'front_large_window')
  addWindowGroup(b, [
    { x: 6, y: 1, z: 2 }, { x: 6, y: 2, z: 2 },
    { x: 6, y: 1, z: 3 }, { x: 6, y: 2, z: 3 }
  ], 'side_large_window')
  addWindowGroup(b, [
    { x: 4, y: 3, z: 4 }, { x: 5, y: 3, z: 4 }
  ], 'upper_strip_window')

  b.fill(0, 1, 0, 0, 2, 3, 'gray_concrete', { phase: 'facade_mid', role: 'recess_frame' })
  b.fill(4, 1, 0, 4, 2, 3, 'gray_concrete', { phase: 'column', role: 'facade_pier' })
  b.fill(3, 1, 4, 6, 1, 4, 'gray_concrete', { phase: 'facade_base', role: 'accent_band' })
  addOpening(b, 2, 1, 0, 'doorway')
  addOpening(b, 2, 2, 0, 'doorway')

  b.metadata.rooms = [
    room('living_room', 'living_room', 1, 1, 1, 2, 1, 2),
    room('kitchen', 'kitchen', 2, 1, 1, 2, 1, 2),
    room('bedroom', 'bedroom', 5, 1, 2, 5, 1, 3)
  ]
  b.metadata.walkways = [
    rect(2, 1, 0, 2, 1, 0)
  ]
  b.metadata.doorways = [pos(2, 1, 0), pos(2, 2, 0)]
  b.metadata.windows = b.blocks().filter(block => block.role === 'window').map(block => pos(block.x, block.y, block.z))
  b.metadata.interiorAnchors = [
    anchor('bed', 'white_wool', 5, 1, 3, 'bedroom', 'bedroom'),
    anchor('crafting_table', 'crafting_table', 2, 1, 1, 'kitchen', 'utility'),
    anchor('furnace', 'furnace', 5, 1, 2, 'kitchen', 'kitchen'),
    anchor('chest', 'chest', 2, 1, 2, 'kitchen', 'kitchen'),
    anchor('sofa', 'oak_planks', 1, 1, 1, 'living_room', 'living_room'),
    anchor('table', 'glass', 1, 1, 2, 'living_room', 'living_room')
  ]

  return b.blueprint(design)
}

function castleBlueprint(original, design) {
  const b = new DesignBlockBuilder(original.name, 'Designed compact castle with towers, battlements, gate wall, and uneven skyline', original.metadata)
  b.metadata = {
    ...b.metadata,
    style: 'castle',
    buildingType: canonicalBuildingType(original.name, 'castle'),
    interiorProfile: 'castle',
    skipScaffolding: false
  }

  castleWallVolume(b, { id: 'keep', minX: 1, maxX: 5, minZ: 1, maxZ: 4, wallTop: 3 })
  castleTower(b, { id: 'front_left_tower', minX: 0, maxX: 1, minZ: 0, maxZ: 1, topY: 3 })
  castleTower(b, { id: 'front_right_tower', minX: 5, maxX: 6, minZ: 0, maxZ: 1, topY: 3 })
  castleTower(b, { id: 'rear_offset_tower', minX: 5, maxX: 6, minZ: 4, maxZ: 5, topY: 2 })
  castleCurtainWall(b)
  battlements(b, { minX: 1, maxX: 5, minZ: 1, maxZ: 4, y: 4, material: 'stone_bricks' })
  battlements(b, { minX: 0, maxX: 6, minZ: 0, maxZ: 0, y: 3, material: 'stone_bricks', onlyFront: true })

  addOpening(b, 3, 1, 0, 'gate')
  addOpening(b, 3, 2, 0, 'gate')
  addWindowGroup(b, [{ x: 1, y: 2, z: 0 }, { x: 5, y: 2, z: 0 }], 'arrow_slits')
  addWindowGroup(b, [{ x: 0, y: 3, z: 1 }, { x: 6, y: 3, z: 1 }, { x: 6, y: 3, z: 4 }], 'tower_slits')

  b.fill(1, 0, 6, 5, 0, 6, 'dirt', { phase: 'garden', role: 'courtyard_bed' })
  b.fill(3, 0, 8, 4, 0, 9, 'dirt', { phase: 'path', role: 'rear_courtyard_path' })
  b.set(1, 1, 6, 'green_wool', { phase: 'garden', role: 'shrub' })
  b.set(3, 1, 6, 'green_wool', { phase: 'garden', role: 'shrub' })
  b.set(5, 1, 6, 'green_wool', { phase: 'garden', role: 'shrub' })
  fenceRect(b, 0, 0, 6, 6, 0, 7, 'oak_fence', { phase: 'garden', role: 'garden_edge' })

  b.metadata.rooms = [
    room('hall', 'hall', 2, 1, 1, 4, 1, 2),
    room('room', 'room', 2, 1, 3, 4, 1, 3)
  ]
  b.metadata.walkways = [
    rect(3, 1, 0, 3, 1, 1)
  ]
  b.metadata.doorways = [pos(3, 1, 0), pos(3, 2, 0)]
  b.metadata.windows = b.blocks().filter(block => block.role === 'window').map(block => pos(block.x, block.y, block.z))
  b.metadata.interiorAnchors = [
    anchor('bed', 'white_wool', 2, 1, 3, 'room', 'room'),
    anchor('crafting_table', 'crafting_table', 4, 1, 3, 'room', 'work'),
    anchor('furnace', 'furnace', 2, 1, 2, 'hall', 'hall'),
    anchor('chest', 'chest', 4, 1, 2, 'hall', 'storage')
  ]

  return b.blueprint(design)
}

function woodVolume(b, volume) {
  b.fill(volume.minX, 0, volume.minZ, volume.maxX, 0, volume.maxZ, 'oak_planks', { phase: 'facade_base', volumeId: volume.id })
  for (let y = 1; y <= volume.wallTop; y++) {
    for (let x = volume.minX; x <= volume.maxX; x++) {
      for (let z = volume.minZ; z <= volume.maxZ; z++) {
        if (!onPerimeter(x, z, volume)) continue
        const corner = isCorner(x, z, volume)
        const rhythm = ((x - volume.minX) % 3 === 0 && (z === volume.minZ || z === volume.maxZ)) ||
          ((z - volume.minZ) % 3 === 0 && (x === volume.minX || x === volume.maxX))
        const beam = corner || rhythm
        b.set(x, y, z, beam ? 'oak_log' : 'oak_planks', {
          phase: beam ? 'column' : (y === 1 ? 'facade_base' : y === volume.wallTop ? 'facade_top' : 'facade_mid'),
          role: beam ? 'beam' : 'wall',
          volumeId: volume.id
        })
      }
    }
  }
}

function woodPorch(b) {
  b.fill(1, 0, -1, 3, 0, -1, 'oak_planks', { phase: 'porch', role: 'entry_deck' })
}

function addWoodUpperStory(b) {
  const volume = { id: 'upper_story', minX: 5, maxX: 8, minZ: 1, maxZ: 4 }
  b.fill(volume.minX, 3, volume.minZ, volume.maxX, 3, volume.maxZ, 'oak_planks', {
    phase: 'floor',
    role: 'upper_floor',
    volumeId: volume.id
  })
  for (let x = volume.minX; x <= volume.maxX; x++) {
    for (let z = volume.minZ; z <= volume.maxZ; z++) {
      if (!onPerimeter(x, z, volume)) continue
      const beam = isCorner(x, z, volume) || x === volume.minX || x === volume.maxX
      b.set(x, 4, z, beam ? 'oak_log' : 'oak_planks', {
        phase: beam ? 'column' : 'facade_top',
        role: beam ? 'upper_beam' : 'upper_wall',
        volumeId: volume.id
      })
    }
  }
  addWindowGroup(b, [{ x: 6, y: 4, z: 3 }], 'upper_rear_window')
  addWindowGroup(b, [{ x: 7, y: 4, z: 2 }], 'upper_side_window')
  for (const brace of [
    { x: volume.minX, z: volume.minZ },
    { x: volume.maxX, z: volume.minZ },
    { x: volume.minX, z: volume.maxZ },
    { x: volume.maxX, z: volume.maxZ }
  ]) {
    b.set(brace.x, 5, brace.z, 'oak_planks', {
      phase: 'roof_support',
      role: 'upper_roof_support',
      volumeId: volume.id
    })
  }
  b.fill(volume.minX, 6, volume.minZ, volume.maxX, 6, volume.maxZ, 'oak_planks', {
    phase: 'roof_high',
    role: 'upper_roof',
    volumeId: volume.id
  })
}

function modernVolume(b, volume) {
  b.fill(volume.minX, 0, volume.minZ, volume.maxX, 0, volume.maxZ, volume.floor || volume.wall, { phase: 'facade_base', role: 'slab', volumeId: volume.id })
  for (let y = 1; y <= volume.wallTop; y++) {
    for (let x = volume.minX; x <= volume.maxX; x++) {
      for (let z = volume.minZ; z <= volume.maxZ; z++) {
        if (!onPerimeter(x, z, volume)) continue
        const accent = isCorner(x, z, volume) || ((x - volume.minX) % 4 === 0 && (z === volume.minZ || z === volume.maxZ))
        b.set(x, y, z, accent ? volume.accent : volume.wall, {
          phase: accent ? 'column' : (y === 1 ? 'facade_mid' : 'facade_top'),
          role: accent ? 'facade_pier' : 'wall',
          volumeId: volume.id
        })
      }
    }
  }
  if (volume.roofY - 1 > 0) {
    b.fill(volume.minX, volume.roofY - 1, volume.minZ, volume.maxX, volume.roofY - 1, volume.maxZ, volume.wall, {
      phase: 'roof_support',
      role: 'roof_support',
      volumeId: volume.id
    })
  }
  b.fill(volume.minX, volume.roofY, volume.minZ, volume.maxX, volume.roofY, volume.maxZ, volume.wall, {
    phase: volume.roofY > 3 ? 'roof_high' : 'roof_low',
    role: 'flat_roof',
    volumeId: volume.id
  })
}

function castleWallVolume(b, volume) {
  b.fill(volume.minX, 0, volume.minZ, volume.maxX, 0, volume.maxZ, 'cobblestone', { phase: 'facade_base', role: 'stone_foundation', volumeId: volume.id })
  for (let y = 1; y <= volume.wallTop; y++) {
    for (let x = volume.minX; x <= volume.maxX; x++) {
      for (let z = volume.minZ; z <= volume.maxZ; z++) {
        if (!onPerimeter(x, z, volume)) continue
        const pier = isCorner(x, z, volume) || ((x - volume.minX) % 3 === 0 && (z === volume.minZ || z === volume.maxZ))
        b.set(x, y, z, pier ? 'cobblestone' : 'stone_bricks', {
          phase: pier ? 'column' : (y === 1 ? 'facade_base' : y === volume.wallTop ? 'facade_top' : 'facade_mid'),
          role: pier ? 'buttress' : 'thick_wall',
          volumeId: volume.id
        })
      }
    }
  }
  b.fill(volume.minX, volume.wallTop + 1, volume.minZ, volume.maxX, volume.wallTop + 1, volume.maxZ, 'stone_bricks', {
    phase: 'roof_walkway',
    role: 'wall_walkway',
    volumeId: volume.id
  })
}

function castleTower(b, tower) {
  b.fill(tower.minX, 0, tower.minZ, tower.maxX, 0, tower.maxZ, 'cobblestone', { phase: 'tower', role: 'tower_base', volumeId: tower.id })
  for (let y = 1; y <= tower.topY; y++) {
    for (let x = tower.minX; x <= tower.maxX; x++) {
      for (let z = tower.minZ; z <= tower.maxZ; z++) {
        const edge = onPerimeter(x, z, tower)
        b.set(x, y, z, edge ? 'stone_bricks' : 'air', {
          phase: edge ? 'tower' : 'tower_void',
          role: edge ? 'tower_wall' : 'tower_air',
          volumeId: tower.id
        })
      }
    }
  }
  for (let x = tower.minX; x <= tower.maxX; x++) {
    for (let z = tower.minZ; z <= tower.maxZ; z++) {
      if ((x + z) % 2 === 0 || isCorner(x, z, tower)) {
        b.set(x, tower.topY + 1, z, 'stone_bricks', { phase: 'battlement', role: 'crenel', volumeId: tower.id })
      }
    }
  }
}

function castleCurtainWall(b) {
  for (let x = 0; x <= 6; x++) {
    b.set(x, 1, 0, 'stone_bricks', { phase: 'facade_base', role: 'curtain_wall' })
    b.set(x, 2, 0, 'stone_bricks', { phase: 'facade_mid', role: 'curtain_wall' })
  }
  for (let z = 1; z <= 5; z++) {
    b.set(0, 1, z, 'stone_bricks', { phase: 'facade_base', role: 'curtain_wall' })
    b.set(6, 1, z, 'stone_bricks', { phase: 'facade_base', role: 'curtain_wall' })
  }
}

function gabledRoof(b, roof) {
  const xValues = range(roof.minX, roof.maxX)
  const zValues = range(roof.minZ, roof.maxZ)
  if (roof.axis === 'x') {
    const centerA = Math.floor((roof.minZ + roof.maxZ) / 2)
    const centerB = Math.ceil((roof.minZ + roof.maxZ) / 2)
    for (const x of xValues) {
      for (const z of zValues) {
        const center = z === centerA || z === centerB
        if (center && roof.ridgeY - 1 > 0) {
          b.set(x, roof.ridgeY - 1, z, roof.material, {
            phase: 'roof_support',
            role: 'roof_support'
          })
        }
        b.set(x, center ? roof.ridgeY : roof.eaveY, z, roof.material, {
          phase: roof.phase,
          role: center ? 'roof_ridge' : 'roof_slope'
        })
      }
    }
  } else {
    const centerA = Math.floor((roof.minX + roof.maxX) / 2)
    const centerB = Math.ceil((roof.minX + roof.maxX) / 2)
    for (const x of xValues) {
      for (const z of zValues) {
        const center = x === centerA || x === centerB
        if (center && roof.ridgeY - 1 > 0) {
          b.set(x, roof.ridgeY - 1, z, roof.material, {
            phase: 'roof_support',
            role: 'roof_support'
          })
        }
        b.set(x, center ? roof.ridgeY : roof.eaveY, z, roof.material, {
          phase: roof.phase,
          role: center ? 'roof_ridge' : 'roof_slope'
        })
      }
    }
  }
}

function battlements(b, area) {
  for (let x = area.minX; x <= area.maxX; x++) {
    for (let z = area.minZ; z <= area.maxZ; z++) {
      const edge = area.onlyFront ? z === area.minZ : (x === area.minX || x === area.maxX || z === area.minZ || z === area.maxZ)
      if (!edge) continue
      if ((x + z) % 2 !== 0) continue
      b.set(x, area.y, z, area.material, { phase: 'battlement', role: 'crenel' })
    }
  }
}

function addWindowGroup(b, positions, groupId) {
  for (const p of positions) {
    b.set(p.x, p.y, p.z, 'glass', { phase: 'window', role: 'window', groupId })
  }
}

function addOpening(b, x, y, z, role) {
  const half = y % 2 === 0 ? 'upper' : 'lower'
  const doorType = role === 'gate' ? 'spruce_door' : 'oak_door'
  b.set(x, y, z, doorType, {
    phase: 'path',
    role: role === 'gate' ? 'gate' : 'door',
    states: { half, facing: 'south', hinge: 'left', open: 'false' },
    orientation: { half, facing: 'south', hinge: 'left', open: 'false' }
  })
}

function fenceRect(b, minX, minY, minZ, maxX, maxY, maxZ, type, extra = {}) {
  for (let x = minX; x <= maxX; x++) {
    b.set(x, maxY, minZ, type, extra)
    b.set(x, maxY, maxZ, type, extra)
  }
  for (let z = minZ; z <= maxZ; z++) {
    b.set(minX, maxY, z, type, extra)
    b.set(maxX, maxY, z, type, extra)
  }
}

class DesignBlockBuilder {
  constructor(name, description, metadata = {}) {
    this.name = name
    this.description = description
    this.metadata = { ...(metadata || {}) }
    this.map = new Map()
  }

  set(x, y, z, type, extra = {}) {
    this.map.set(key(x, y, z), { x, y, z, type, ...extra })
  }

  fill(minX, minY, minZ, maxX, maxY, maxZ, type, extra = {}) {
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) this.set(x, y, z, type, extra)
      }
    }
  }

  blocks() {
    return [...this.map.values()].sort(sortBlocks)
  }

  blueprint(design) {
    return {
      name: this.name,
      description: this.description,
      origin: { x: 0, y: 0, z: 0 },
      metadata: {
        ...this.metadata,
        design
      },
      blocks: this.blocks()
    }
  }
}

function analyzeBlueprint(blueprint = {}) {
  const blocks = Array.isArray(blueprint.blocks) ? blueprint.blocks : []
  const solid = blocks.filter(block => block && !isAir(block.type))
  const materialCounts = {}
  const phaseCounts = {}
  for (const block of blocks) {
    if (!isAir(block.type)) materialCounts[block.type] = (materialCounts[block.type] || 0) + 1
    phaseCounts[block.phase || 'none'] = (phaseCounts[block.phase || 'none'] || 0) + 1
  }
  if (!solid.length) {
    return emptyAnalysis(blocks.length, materialCounts, phaseCounts)
  }

  const bounds = boundsFor(solid)
  const columns = new Map()
  for (const block of solid) {
    const columnKey = `${block.x},${block.z}`
    const existing = columns.get(columnKey) || { x: block.x, z: block.z, minY: Infinity, maxY: -Infinity, count: 0 }
    existing.minY = Math.min(existing.minY, block.y)
    existing.maxY = Math.max(existing.maxY, block.y)
    existing.count += 1
    columns.set(columnKey, existing)
  }

  const heights = [...columns.values()].map(column => column.maxY - column.minY + 1)
  const uniqueColumnHeights = [...new Set(heights)].sort((a, b) => a - b)
  const bboxArea = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1)
  const footprintFill = bboxArea > 0 ? columns.size / bboxArea : 0
  const roofLevels = [...new Set(solid
    .filter(block => String(block.phase || '').includes('roof') || String(block.role || '').includes('roof'))
    .map(block => block.y))]
    .sort((a, b) => a - b)
  const windowGroups = countWindowGroups(blocks)
  const volumeIds = new Set(solid.map(block => block.volumeId).filter(Boolean))
  const hasFacadeDepth = solid.some(block => ['column', 'porch', 'facade_base', 'facade_mid', 'facade_top'].includes(block.phase) ||
    ['beam', 'buttress', 'facade_pier', 'protrusion', 'recess_frame'].includes(block.role))

  return {
    blockCount: blocks.length,
    solidCount: solid.length,
    bounds,
    footprintArea: columns.size,
    bboxArea,
    footprintFill: Number(footprintFill.toFixed(3)),
    uniqueColumnHeights,
    isPureBox: footprintFill >= 0.95 && uniqueColumnHeights.length <= 1 && !hasFacadeDepth,
    roofLevels,
    windowGroups,
    volumeCount: Math.max(volumeIds.size, inferVolumeCount(columns)),
    materialCounts,
    phaseCounts,
    hasFacadeDepth,
    towerBlocks: phaseCounts.tower || 0,
    battlementBlocks: phaseCounts.battlement || 0,
    facadeLayerCount: ['facade_base', 'facade_mid', 'facade_top'].filter(phase => phaseCounts[phase] > 0).length
  }
}

function validateStyleGrammar(blueprint, style, design) {
  const analysis = analyzeBlueprint(blueprint)
  const materials = analysis.materialCounts
  const violations = []
  if (style === 'modern') {
    if (!materials.white_concrete) violations.push('modern_missing_white')
    if (!materials.gray_concrete) violations.push('modern_missing_gray')
    if ((materials.glass || 0) < 8 || analysis.windowGroups < 2) violations.push('modern_missing_large_grouped_windows')
    if (!['flat', 'stepped_flat'].includes(design?.roofType || blueprint.metadata?.design?.roofType)) violations.push('modern_roof_not_flat')
    if (analysis.volumeCount < 3 || analysis.uniqueColumnHeights.length < 2) violations.push('modern_missing_offset_volumes')
  } else if (style === 'castle') {
    if (!materials.stone_bricks && !materials.cobblestone) violations.push('castle_missing_stone')
    if (analysis.towerBlocks < 12) violations.push('castle_missing_tower')
    if (analysis.battlementBlocks < 4) violations.push('castle_missing_battlements')
    if (analysis.uniqueColumnHeights.length < 3) violations.push('castle_missing_height_variation')
  } else if (style === 'wood') {
    if ((materials.oak_log || 0) < 8) violations.push('wood_missing_beams')
    if ((materials.glass || 0) < 4 || analysis.windowGroups < 2) violations.push('wood_missing_irregular_window_groups')
    if (!['gabled', 'stepped_gabled'].includes(design?.roofType || blueprint.metadata?.design?.roofType)) violations.push('wood_roof_not_gabled')
    if (analysis.roofLevels.length < 2 || analysis.uniqueColumnHeights.length < 2) violations.push('wood_missing_roof_height_variation')
  }

  if (analysis.isPureBox) violations.push('silhouette_is_pure_box')
  if (!analysis.hasFacadeDepth || analysis.facadeLayerCount < 3) violations.push('facade_is_flat_or_unlayered')

  return {
    ok: violations.length === 0,
    style,
    violations,
    metrics: analysis
  }
}

function validateFacade(blueprint) {
  const analysis = analyzeBlueprint(blueprint)
  const violations = []
  if (analysis.windowGroups < 2) violations.push('window_groups_missing')
  if (!analysis.phaseCounts.column) violations.push('column_rhythm_missing')
  if (analysis.facadeLayerCount < 3) violations.push('wall_layers_missing')
  if (!analysis.hasFacadeDepth) violations.push('facade_depth_missing')
  return { ok: violations.length === 0, violations, metrics: analysis }
}

function annotateBlueprint(blueprint, design, transformed) {
  return {
    ...blueprint,
    description: blueprint.description,
    metadata: {
      ...(blueprint.metadata || {}),
      designLayer: {
        enabled: true,
        transformed: Boolean(transformed),
        style: design.style,
        reason: design.reason
      },
      design
    }
  }
}

function normalizeStyle(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return STYLE_ALIASES[key] || (key.includes('castle') ? 'castle' : key.includes('modern') || key.includes('villa') ? 'modern' : key.includes('house') || key.includes('wood') || key.includes('shelter') ? 'wood' : null)
}

function isDesignableBlueprint(blueprint, request, style) {
  if (['wood', 'modern', 'castle'].includes(style)) return true
  const name = `${request.blueprintName || ''} ${blueprint.name || ''} ${blueprint.metadata?.buildingType || ''}`.toLowerCase()
  return DESIGNABLE_NAME_PATTERNS.some(pattern => pattern.test(name))
}

function shouldForceVariation(request = {}) {
  if (request.forceDesignVariation === true) return true
  const previous = request.previousDesigns || request.previousSilhouettes || []
  return Array.isArray(previous) && previous.some(item => Number(item?.similarity || item?.silhouetteSimilarity || 0) > 0.9)
}

function transformationReason(analysis, blueprint, styleValidation, request) {
  const reasons = []
  if (analysis.isPureBox) reasons.push('pure_box_blueprint')
  if (!blueprint.metadata?.style) reasons.push('missing_style_metadata')
  if (!styleValidation.ok) reasons.push(`style_grammar:${styleValidation.violations.join(',')}`)
  if (shouldForceVariation(request)) reasons.push('silhouette_similarity_exceeded')
  return reasons.join('|') || 'design_upgrade_required'
}

function silhouetteForStyle(style, analysis, variant) {
  if (style === 'modern') {
    return {
      footprintShape: 'offset_interlocking_rectangles',
      heightVariation: 'split_level_flat_roofs',
      roofLevels: [2, 3, 4],
      protrusions: ['bedroom_volume_offset_east', 'entry_volume_recessed_south'],
      recesses: ['front_glass_entry_recess'],
      avoidsPureBox: true,
      before: analysis,
      variant
    }
  }
  if (style === 'castle') {
    return {
      footprintShape: 'keep_with_asymmetric_rear_tower_and_curtain_wall',
      heightVariation: 'front_towers_high_rear_tower_lower',
      roofLevels: [3, 4],
      protrusions: ['front_gate_towers', 'rear_offset_tower', 'garden_courtyard'],
      recesses: ['gate_opening', 'roof_walkway'],
      avoidsPureBox: true,
      before: analysis,
      variant
    }
  }
  return {
    footprintShape: 'l_shaped_main_house_with_side_wing_and_porch',
    heightVariation: 'main_gable_higher_than_side_wing',
    roofLevels: [3, 4, 5],
    protrusions: ['side_wing', 'front_porch'],
    recesses: ['entry_door_recess'],
    avoidsPureBox: true,
    before: analysis,
    variant
  }
}

function volumesForStyle(style) {
  if (style === 'modern') {
    return [
      volume('living_volume', 'main living block', { minX: 0, maxX: 4, minZ: 0, maxZ: 3, height: 3 }),
      volume('bedroom_volume', 'offset taller bedroom block', { minX: 3, maxX: 6, minZ: 1, maxZ: 4, height: 4 }),
      volume('entry_volume', 'lower recessed entry block', { minX: 0, maxX: 2, minZ: 4, maxZ: 5, height: 2 })
    ]
  }
  if (style === 'castle') {
    return [
      volume('keep', 'central stone keep', { minX: 1, maxX: 5, minZ: 1, maxZ: 4, height: 4 }),
      volume('front_left_tower', 'front local symmetry tower', { minX: 0, maxX: 1, minZ: 0, maxZ: 1, height: 4 }),
      volume('front_right_tower', 'front local symmetry tower', { minX: 5, maxX: 6, minZ: 0, maxZ: 1, height: 4 }),
      volume('rear_offset_tower', 'asymmetric rear tower', { minX: 5, maxX: 6, minZ: 4, maxZ: 5, height: 3 })
    ]
  }
  return [
    volume('main', 'main two-story timber body', { minX: 0, maxX: 4, minZ: 0, maxZ: 3, height: 5 }),
    volume('side_wing', 'lower side room wing', { minX: 3, maxX: 5, minZ: 2, maxZ: 5, height: 4 }),
    volume('porch', 'front porch protrusion', { minX: 1, maxX: 3, minZ: -1, maxZ: -1, height: 3 })
  ]
}

function roofForStyle(style) {
  if (style === 'modern') return 'stepped_flat'
  if (style === 'castle') return 'battlement'
  return 'stepped_gabled'
}

function symmetryForStyle(style) {
  if (style === 'castle') {
    return {
      mode: 'local_symmetry_with_asymmetric_rear_tower',
      axis: 'front_gate_x',
      enforceVariation: true
    }
  }
  if (style === 'modern') {
    return {
      mode: 'asymmetric_balanced',
      axis: null,
      enforceVariation: true
    }
  }
  return {
    mode: 'soft_asymmetry',
    axis: 'entry_center',
    enforceVariation: true
  }
}

function facadeForStyle(style) {
  if (style === 'modern') {
    return {
      windowGroups: ['front_large_window', 'side_large_window', 'upper_strip_window'],
      columnRhythm: 'every_4_blocks',
      wallLayers: ['gray_base', 'white_mid', 'roof_cap'],
      depth: ['entry_recess', 'gray_piers']
    }
  }
  if (style === 'castle') {
    return {
      windowGroups: ['arrow_slits', 'tower_slits'],
      columnRhythm: 'buttress_every_3_blocks',
      wallLayers: ['cobblestone_base', 'stone_mid', 'battlement_top'],
      depth: ['towers', 'curtain_wall', 'gate_recess']
    }
  }
  return {
    windowGroups: ['front_left_group', 'front_right_group', 'side_irregular', 'rear_pair'],
    columnRhythm: 'timber_beam_every_3_blocks',
    wallLayers: ['plank_base', 'timber_mid', 'gabled_top'],
    depth: ['porch', 'side_wing']
  }
}

function designVariant(request = {}, analysis = {}) {
  if (request.designVariant) return String(request.designVariant)
  const seed = Number(request.variationSeed ?? request.builtStructureCount ?? 0)
  if (analysis.isPureBox) return seed % 2 === 0 ? 'box_breaker_a' : 'box_breaker_b'
  return seed % 2 === 0 ? 'balanced_a' : 'balanced_b'
}

function canonicalBuildingType(name, style) {
  const key = String(name || '').toLowerCase()
  if (key.includes('castle')) return 'castle'
  if (key.includes('villa') || style === 'modern') return 'modern_villa'
  if (key.includes('farm')) return 'wood_farmhouse'
  if (key.includes('shelter')) return 'wood_shelter'
  return 'wood_house'
}

function countWindowGroups(blocks = []) {
  const groups = new Set()
  let looseGlass = 0
  for (const block of blocks) {
    if (block?.role === 'window' && block.groupId) groups.add(block.groupId)
    else if (block?.type === 'glass' || block?.role === 'window') looseGlass += 1
  }
  return groups.size + looseGlass
}

function inferVolumeCount(columns) {
  const count = columns.size
  if (count <= 0) return 0
  if (count <= 12) return 1
  if (count <= 28) return 2
  return 3
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
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  })
}

function emptyAnalysis(blockCount, materialCounts, phaseCounts) {
  return {
    blockCount,
    solidCount: 0,
    bounds: null,
    footprintArea: 0,
    bboxArea: 0,
    footprintFill: 0,
    uniqueColumnHeights: [],
    isPureBox: false,
    roofLevels: [],
    windowGroups: 0,
    volumeCount: 0,
    materialCounts,
    phaseCounts,
    hasFacadeDepth: false,
    towerBlocks: 0,
    battlementBlocks: 0,
    facadeLayerCount: 0
  }
}

function volume(id, label, bounds) {
  return { id, label, bounds }
}

function room(id, zone, minX, minY, minZ, maxX, maxY, maxZ) {
  return { id, zone, bounds: { minX, minY, minZ, maxX, maxY, maxZ } }
}

function anchor(role, type, x, y, z, roomId, zone) {
  return { role, type, x, y, z, roomId, zone }
}

function rect(minX, minY, minZ, maxX, maxY, maxZ) {
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

function pos(x, y, z) {
  return { x, y, z }
}

function range(min, max) {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index)
}

function onPerimeter(x, z, bounds) {
  return x === bounds.minX || x === bounds.maxX || z === bounds.minZ || z === bounds.maxZ
}

function isCorner(x, z, bounds) {
  return (x === bounds.minX || x === bounds.maxX) && (z === bounds.minZ || z === bounds.maxZ)
}

function isAir(type) {
  return AIR_BLOCKS.has(type)
}

function key(x, y, z) {
  return `${x},${y},${z}`
}

function sortBlocks(a, b) {
  return (a.y - b.y) || (a.x - b.x) || (a.z - b.z)
}

function disabledDesign(blueprint) {
  return {
    layer: 'design',
    style: normalizeStyle(blueprint?.metadata?.style || blueprint?.name) || 'unknown',
    buildingType: blueprint?.metadata?.buildingType || blueprint?.name || 'unknown',
    transformed: false,
    reason: 'designer_disabled',
    silhouette: null,
    volumeSegmentation: [],
    roofType: null,
    symmetryRules: null,
    facadeLayout: null,
    styleGrammar: null
  }
}

module.exports = {
  BuildingDesigner,
  STYLE_GRAMMARS,
  analyzeBlueprint,
  validateFacade,
  validateStyleGrammar
}
