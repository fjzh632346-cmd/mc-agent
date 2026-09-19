const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { BlueprintLoader } = require('../systems/blueprint-loader')
const { BlueprintSelector } = require('../systems/blueprint-selector')
const { CommunityBlueprintIndex } = require('../systems/community-blueprint-index')
const { CommunityStructureImporter, _test: importerTest } = require('../systems/community-structure-importer')
const { FaithfulCommunityValidator } = require('../systems/faithful-community-validator')

function fixtureHouse(overrides = {}) {
  const width = overrides.width || 13
  const depth = overrides.depth || 11
  const roofY = overrides.roofY ?? 8
  const secondFloorY = overrides.secondFloorY ?? 4
  const blocks = []
  const wallLevels = overrides.oneStory ? [1, 2, 3] : [1, 2, 3, 5, 6, 7]

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ x, y: 0, z, type: overrides.floorType || 'oak_planks' })
      if (!overrides.oneStory) blocks.push({ x, y: secondFloorY, z, type: overrides.floorType || 'oak_planks' })
      blocks.push({ x, y: roofY, z, type: overrides.roofType || 'oak_planks' })
    }
  }

  for (const y of wallLevels) {
    for (let x = 0; x < width; x++) {
      for (const z of [0, depth - 1]) {
        if (!overrides.openFrame && !(z === 0 && x === Math.floor(width / 2) && (y === 1 || y === 2))) {
          blocks.push(wallBlock(x, y, z, overrides))
        }
      }
    }
    for (let z = 1; z < depth - 1; z++) {
      for (const x of [0, width - 1]) {
        if (!overrides.openFrame) blocks.push(wallBlock(x, y, z, overrides))
      }
    }
  }

  if (!overrides.openFrame) {
    blocks.push({ x: Math.floor(width / 2), y: 1, z: 0, type: 'oak_door', states: { half: 'lower', facing: 'south' } })
    blocks.push({ x: Math.floor(width / 2), y: 2, z: 0, type: 'oak_door', states: { half: 'upper', facing: 'south' } })
  }
  if (!overrides.noStairs && !overrides.oneStory) {
    for (let i = 0; i < 4; i++) {
      blocks.push({ x: 2 + i, y: 1 + i, z: 2, type: 'oak_stairs', states: { facing: 'east' } })
    }
  }
  if (!overrides.noFunctional) blocks.push({ x: 3, y: 1, z: 3, type: 'chest' })
  if (overrides.glass) {
    for (const x of [3, 4, width - 5, width - 4]) {
      blocks.push({ x, y: 2, z: depth - 1, type: 'glass_pane' })
      if (!overrides.oneStory) blocks.push({ x, y: 6, z: depth - 1, type: 'glass_pane' })
    }
  }

  return {
    name: overrides.name || 'faithful_two_story_house',
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      sourceKind: 'real_community_import',
      sourceMode: overrides.sourceMode === false ? undefined : 'faithful-community-import',
      buildingType: overrides.buildingType || 'two_story_wood_house',
      style: overrides.style || 'wood'
    },
    blocks: blocks
      .filter(block => !(overrides.partialRoof && block.y === roofY && block.x > Math.floor(width / 2)))
      .filter(block => !(overrides.windowAir && String(block.type).includes('glass')))
  }
}

function wallBlock(x, y, z, options = {}) {
  if (options.glass && y === 2 && (x === 0 || z === 0 || x === (options.width || 13) - 1 || z === (options.depth || 11) - 1)) {
    return { x, y, z, type: 'glass_pane' }
  }
  return { x, y, z, type: options.wallType || 'oak_planks' }
}

function writeCache(samples) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-faithful-cache-'))
  const blueprintDir = path.join(root, 'blueprints')
  fs.mkdirSync(blueprintDir, { recursive: true })
  const index = {
    version: 1,
    samples: samples.map(sample => {
      const fileName = `${sample.id}.json`
      fs.writeFileSync(path.join(blueprintDir, fileName), JSON.stringify(sample.blueprint), 'utf8')
      return {
        id: sample.id,
        importStatus: sample.importStatus || 'verified',
        buildTitle: sample.title || sample.id,
        category: sample.category,
        style: sample.style,
        buildingType: sample.buildingType,
        requiredStories: sample.requiredStories,
        localBlueprintPath: path.join(blueprintDir, fileName),
        localRawPath: path.join(root, 'raw', `${sample.id}.schem`),
        structureFileFormat: 'schem',
        cacheHash: sample.cacheHash || sample.id,
        hardGate: { ok: true },
        sourceMode: 'faithful-community-import',
        adaptation: sample.adaptation,
        encodingSummary: { blockCount: sample.blueprint.blocks.length }
      }
    })
  }
  const indexPath = path.join(root, 'index.json')
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8')
  return { root, indexPath }
}

async function testSelectorLoadsFaithfulCacheFile() {
  const blueprint = fixtureHouse({ name: 'community_wood_house' })
  const cache = writeCache([{
    id: 'real-wood-house',
    blueprint,
    category: 'wood_house',
    style: 'wood',
    buildingType: 'two_story_wood_house',
    requiredStories: 2
  }])
  const loader = new BlueprintLoader()
  const selector = new BlueprintSelector({
    loader,
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  })
  const selected = selector.selectBlueprint({ blueprintName: 'two_story_wood_house' })
  assert.strictEqual(selected.ok, true, selected.error)
  assert.strictEqual(selected.selected.sourceKind, 'real_community_import')
  assert.strictEqual(selected.selected.sourceMode, 'faithful-community-import')
  assert.strictEqual(selected.blueprint.name, 'community_wood_house')
  assert.strictEqual(selected.blueprint.metadata.sourceMode, 'faithful-community-import')
}

async function testSelectorLoadsNonProceduralAdaptedFaithfulCacheFile() {
  const blueprint = fixtureHouse({ name: 'adapted_community_wood_house' })
  const cache = writeCache([{
    id: 'real-adapted-wood-house',
    blueprint,
    category: 'wood_house',
    style: 'wood',
    buildingType: 'two_story_wood_house',
    requiredStories: 2,
    importStatus: 'verified_adapted',
    adaptation: {
      type: 'real_community_structure_adaptation',
      usesProceduralFallback: false,
      steps: [{ type: 'remove_unusable_functional_blocks' }]
    }
  }])
  const selector = new BlueprintSelector({
    index: new CommunityBlueprintIndex({ cacheIndexPath: cache.indexPath, candidates: [] })
  })
  const selected = selector.selectBlueprint({ blueprintName: 'two_story_wood_house' })
  assert.strictEqual(selected.ok, true, selected.error)
  assert.strictEqual(selected.selected.sourceKind, 'real_community_import')
  assert.strictEqual(selected.selected.sourceMode, 'faithful-community-import')
  assert.strictEqual(selected.blueprint.name, 'adapted_community_wood_house')
}

async function testValidatorAcceptsCanonicalWoodAndVillaFixtures() {
  const validator = new FaithfulCommunityValidator()
  const wood = fixtureHouse()
  const villa = fixtureHouse({
    name: 'faithful_modern_villa',
    width: 18,
    depth: 14,
    roofY: 9,
    wallType: 'white_concrete',
    floorType: 'quartz_block',
    roofType: 'quartz_block',
    glass: true,
    style: 'modern',
    buildingType: 'modern_villa'
  })

  let result = validator.validateBlueprint(wood, { blueprintName: 'two_story_wood_house', requiredStories: 2 }, { requireSourceMode: true })
  assert.strictEqual(result.ok, true, result.failures.join(','))

  result = validator.validateBlueprint(villa, { blueprintName: 'modern_villa', requiredStories: 2 }, { requireSourceMode: true })
  assert.strictEqual(result.ok, true, result.failures.join(','))
}

async function testValidatorRejectsNegativeFixtures() {
  const validator = new FaithfulCommunityValidator()
  const cases = [
    ['open_frame', fixtureHouse({ openFrame: true }), 'usableInteriorVolume'],
    ['fake_two_story', fixtureHouse({ oneStory: true, roofY: 4 }), 'detectedStories'],
    ['bad_stairs', fixtureHouse({ noStairs: true }), 'verticalAccess'],
    ['compressed_large_sample', fixtureHouse({ width: 8, depth: 7, roofY: 5 }), 'minWidth'],
    ['generation_seed_only', fixtureHouse({ sourceMode: false }), 'source_mode_not_faithful_community_import'],
    ['window_air', fixtureHouse({
      width: 18,
      depth: 14,
      roofY: 9,
      glass: true,
      windowAir: true,
      style: 'modern',
      buildingType: 'modern_villa'
    }), 'glassWindowCount']
  ]

  for (const [name, blueprint, expectedFailure] of cases) {
    const result = validator.validateBlueprint(blueprint, {
      blueprintName: blueprint.metadata?.buildingType || 'two_story_wood_house',
      requiredStories: 2
    }, {
      requireSourceMode: true
    })
    assert.strictEqual(result.ok, false, name)
    assert.ok(result.failures.includes(expectedFailure), `${name}:${result.failures.join(',')}`)
  }
}

// Decision #30 (2026-09-01): the residential (villa) ruler boundary sits at
// minWidth 17 / minInteriorVolume 15 — 17/15 pass, 16/14 fail.
async function testVillaRulerBoundaryAfterDecision30() {
  const validator = new FaithfulCommunityValidator()

  // Width boundary: an otherwise-canonical villa at width 17 passes outright...
  const villaAt17 = fixtureHouse({
    name: 'boundary_villa_w17',
    width: 17,
    depth: 14,
    roofY: 9,
    wallType: 'white_concrete',
    floorType: 'quartz_block',
    roofType: 'quartz_block',
    glass: true,
    style: 'modern',
    buildingType: 'modern_villa'
  })
  let result = validator.validateBlueprint(villaAt17, { blueprintName: 'modern_villa', requiredStories: 2 }, { requireSourceMode: true })
  assert.strictEqual(result.category, 'villa')
  assert.strictEqual(result.limits.minWidth, 17)
  assert.strictEqual(result.limits.minInteriorVolume, 15)
  assert.strictEqual(result.ok, true, result.failures.join(','))

  // ...while the same villa at width 16 fails on width alone.
  const villaAt16 = fixtureHouse({
    name: 'boundary_villa_w16',
    width: 16,
    depth: 14,
    roofY: 9,
    wallType: 'white_concrete',
    floorType: 'quartz_block',
    roofType: 'quartz_block',
    glass: true,
    style: 'modern',
    buildingType: 'modern_villa'
  })
  result = validator.validateBlueprint(villaAt16, { blueprintName: 'modern_villa', requiredStories: 2 }, { requireSourceMode: true })
  assert.strictEqual(result.hardConstraints.minWidth, false)
  assert.ok(result.failures.includes('minWidth'), result.failures.join(','))

  // Interior-volume boundary: a sealed villa-classified box whose interior is
  // filled except for exactly N standable columns pins the check at 15/14.
  for (const [openColumns, shouldPass] of [[15, true], [14, false]]) {
    const probe = volumeProbeBox(openColumns)
    const probeResult = validator.validateBlueprint(probe, { blueprintName: 'modern_villa' })
    assert.strictEqual(probeResult.category, 'villa')
    assert.strictEqual(probeResult.metrics.usableInteriorVolume, openColumns)
    assert.strictEqual(probeResult.hardConstraints.usableInteriorVolume, shouldPass,
      `interior volume ${openColumns} should ${shouldPass ? 'pass' : 'fail'}`)
    if (!shouldPass) assert.ok(probeResult.failures.includes('usableInteriorVolume'))
  }
}

// A sealed 17x14 stone box (floor y0, walls y1-3, lid y4) whose interior is
// solid except `openColumns` columns open at y1-y2 (capped at y3) — each open
// column yields exactly one standable interior cell (y1: air headroom at y2,
// stone support at y0), so usableInteriorVolume === openColumns.
function volumeProbeBox(openColumns) {
  const width = 17
  const depth = 14
  const blocks = []
  const open = new Set()
  for (let i = 0; i < openColumns; i++) {
    open.add(`${1 + (i % (width - 2))},${1 + Math.floor(i / (width - 2))}`)
  }
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ x, y: 0, z, type: 'stone' })
      blocks.push({ x, y: 4, z, type: 'stone' })
      const interior = x > 0 && x < width - 1 && z > 0 && z < depth - 1
      for (const y of [1, 2, 3]) {
        if (interior && open.has(`${x},${z}`) && y !== 3) continue
        blocks.push({ x, y, z, type: 'stone' })
      }
    }
  }
  return {
    name: 'modern_villa_volume_probe',
    origin: { x: 0, y: 0, z: 0 },
    metadata: { sourceKind: 'real_community_import', sourceMode: 'faithful-community-import', buildingType: 'modern_villa', style: 'modern' },
    blocks
  }
}

async function testWorldFidelityRejectsBadActualScans() {
  const validator = new FaithfulCommunityValidator({ minFidelityRatio: 0.99, minBlockStateFidelityRatio: 0.99 })
  const expected = fixtureHouse()
  const exact = {
    ...expected,
    blocks: expected.blocks.map(block => ({ ...block, states: block.states ? { ...block.states } : block.states }))
  }
  let comparison = validator.compareExpectedActual(expected, exact, { blueprintName: 'two_story_wood_house', requiredStories: 2 })
  assert.strictEqual(comparison.ok, true, comparison.failures.join(','))

  const lowFidelity = {
    ...expected,
    blocks: expected.blocks.map((block, index) => index % 12 === 0 ? { ...block, type: 'dirt' } : block)
  }
  comparison = validator.compareExpectedActual(expected, lowFidelity, { blueprintName: 'two_story_wood_house', requiredStories: 2 })
  assert.strictEqual(comparison.ok, false)
  assert.ok(comparison.failures.includes('fidelity_ratio_below_threshold'))

  const lostState = {
    ...expected,
    blocks: expected.blocks.map(block => block.states ? { ...block, states: {} } : block)
  }
  comparison = validator.compareExpectedActual(expected, lostState, { blueprintName: 'two_story_wood_house', requiredStories: 2 })
  assert.strictEqual(comparison.ok, false)
  assert.ok(comparison.failures.includes('block_state_fidelity_below_threshold'))

  const extraScaffold = {
    ...expected,
    blocks: [...expected.blocks, { x: 20, y: 2, z: 20, type: 'scaffolding' }]
  }
  comparison = validator.compareExpectedActual(expected, extraScaffold, { blueprintName: 'two_story_wood_house', requiredStories: 2 })
  assert.strictEqual(comparison.ok, false)
  assert.ok(comparison.failures.includes('extra_block_ratio_above_threshold') || comparison.failures.includes('actual_remainingScaffoldCount'))

  const partialRoof = {
    ...expected,
    blocks: expected.blocks.filter(block => !(block.y === 8 && block.x > 6))
  }
  comparison = validator.compareExpectedActual(expected, partialRoof, { blueprintName: 'two_story_wood_house', requiredStories: 2 })
  assert.strictEqual(comparison.ok, false)
  assert.ok(comparison.failures.includes('fidelity_ratio_below_threshold') || comparison.failures.includes('present_ratio_below_threshold'))

  const smaller = {
    ...expected,
    blocks: expected.blocks.filter(block => block.x < 10)
  }
  comparison = validator.compareExpectedActual(expected, smaller, { blueprintName: 'two_story_wood_house', requiredStories: 2 })
  assert.strictEqual(comparison.ok, false)
  assert.ok(comparison.failures.includes('actual_bounding_box_smaller_than_expected'))
}

function testClassicSchematicLegacyIdsNormalizeToPlaceableBlocks() {
  const legacyName = importerTest.legacyBlockName
  const cases = [
    [9, 0, 'water'],
    [13, 0, 'gravel'],
    [16, 0, 'coal_ore'],
    [34, 0, 'piston'],
    [68, 0, 'oak_wall_sign'],
    [76, 0, 'redstone_torch'],
    [144, 0, 'skeleton_skull'],
    [144, 4, 'skeleton_wall_skull'],
    [160, 0, 'white_stained_glass_pane'],
    [160, 15, 'black_stained_glass_pane'],
    [184, 0, 'dark_oak_fence_gate']
  ]

  for (const [id, data, expected] of cases) {
    assert.strictEqual(legacyName(id, data), expected, `legacy ${id}:${data}`)
  }
  assert.deepStrictEqual(importerTest.legacyBlockStates(144, 4), {
    legacyId: '144',
    legacyData: '4',
    facing: 'west'
  })
  assert.strictEqual(legacyName(250, 0), 'legacy_block_250')
}

function testFaithfulComparisonAcceptsLegacyWallSkullVariant() {
  const validator = new FaithfulCommunityValidator({ minFidelityRatio: 0.99, minBlockStateFidelityRatio: 1 })
  const expected = fixtureHouse()
  expected.blocks.push({
    x: 5,
    y: 3,
    z: 5,
    type: 'skeleton_skull',
    states: { legacyId: '144', legacyData: '4' }
  })
  const actual = {
    ...expected,
    blocks: expected.blocks.map(block => block.type === 'skeleton_skull'
      ? { ...block, type: 'skeleton_wall_skull', states: { facing: 'west' } }
      : { ...block })
  }
  const comparison = validator.compareExpectedActual(expected, actual, {
    blueprintName: 'two_story_wood_house',
    requiredStories: 2
  })
  assert.strictEqual(comparison.ok, true, `${comparison.failures.join(',')}:${JSON.stringify(comparison.metrics)}`)
  assert.strictEqual(
    comparison.metrics.sampleMismatches.some(mismatch => mismatch.expected === 'skeleton_skull'),
    false,
    'the modern wall-skull variant must count as an exact legacy block match'
  )
  assert.strictEqual(comparison.metrics.blockStateFidelityRatio, 1)
}

function testLitematicNegativeRegionMirrorsDirectionalStates() {
  const transformed = importerTest.transformBlockStateForRegionDirection({
    type: 'dark_oak_button',
    states: { face: 'wall', facing: 'south', powered: 'false' }
  }, { mirrorZ: true })
  assert.strictEqual(transformed.states.facing, 'north')

  const stair = importerTest.transformBlockStateForRegionDirection({
    type: 'oak_stairs',
    states: { facing: 'north', shape: 'inner_left', half: 'bottom' }
  }, { mirrorZ: true })
  assert.strictEqual(stair.states.facing, 'south')
  assert.strictEqual(stair.states.shape, 'inner_right')

  const doubleMirror = importerTest.transformBlockStateForRegionDirection({
    type: 'oak_stairs',
    states: { facing: 'east', shape: 'outer_left', half: 'bottom' }
  }, { mirrorX: true, mirrorZ: true })
  assert.strictEqual(doubleMirror.states.facing, 'west')
  assert.strictEqual(doubleMirror.states.shape, 'outer_left')
}

async function testStandardizedJsonPreservesServerCompatibleGrassName() {
  const importer = new CommunityStructureImporter({ maxVolume: 16 })
  const source = {
    id: 'json-grass-fixture',
    buildTitle: 'Grass Fixture',
    standardizedJsonFromCommunityFile: 'fixture.litematic'
  }
  const root = {
    width: 1,
    height: 1,
    length: 1,
    palette: ['minecraft:grass'],
    blocks: [[0, 0, 0, 0]]
  }

  const result = await importer.importStandardizedJson(Buffer.from(JSON.stringify(root), 'utf8'), source, { maxVolume: 16 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.blueprint.blocks.length, 1)
  assert.strictEqual(result.blueprint.blocks[0].type, 'grass')
  assert.strictEqual(result.blueprint.blocks[0].sanitizedFrom, undefined)
  assert.strictEqual(result.blueprint.metadata.sanitizedBlockCount, 0)
}

async function testImporterRepairsSanitizedCampfireHangingLanternSupport() {
  const importer = new CommunityStructureImporter({ maxVolume: 16 })
  const source = {
    id: 'json-hanging-lantern-fixture',
    buildTitle: 'Hanging Lantern Fixture',
    standardizedJsonFromCommunityFile: 'fixture.litematic'
  }
  const root = {
    width: 1,
    height: 2,
    length: 1,
    palette: [
      'minecraft:lantern[hanging=true,waterlogged=false]',
      'minecraft:campfire[facing=north,lit=false]'
    ],
    blocks: [
      [0, 0, 0, 0],
      [0, 1, 0, 1]
    ]
  }

  const result = await importer.importStandardizedJson(Buffer.from(JSON.stringify(root), 'utf8'), source, { maxVolume: 16 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.blueprint.blocks.length, 2)

  const hangingLantern = result.blueprint.blocks.find(block => block.y === 0)
  const support = result.blueprint.blocks.find(block => block.y === 1)
  assert.strictEqual(hangingLantern.type, 'lantern')
  assert.strictEqual(hangingLantern.states.hanging, 'true')
  assert.strictEqual(support.type, 'stone')
  assert.strictEqual(support.sanitizedFrom, 'campfire')
  assert.strictEqual(support.safeSupportReplacement, true)
  assert.deepStrictEqual(support.states, {})
  assert.deepStrictEqual(support.orientation, {})
}

async function run() {
  await testSelectorLoadsFaithfulCacheFile()
  await testSelectorLoadsNonProceduralAdaptedFaithfulCacheFile()
  await testValidatorAcceptsCanonicalWoodAndVillaFixtures()
  await testValidatorRejectsNegativeFixtures()
  await testVillaRulerBoundaryAfterDecision30()
  await testWorldFidelityRejectsBadActualScans()
  testClassicSchematicLegacyIdsNormalizeToPlaceableBlocks()
  testFaithfulComparisonAcceptsLegacyWallSkullVariant()
  testLitematicNegativeRegionMirrorsDirectionalStates()
  await testStandardizedJsonPreservesServerCompatibleGrassName()
  await testImporterRepairsSanitizedCampfireHangingLanternSupport()
  console.log('faithful community import tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
