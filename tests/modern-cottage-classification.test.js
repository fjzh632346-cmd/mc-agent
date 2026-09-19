const assert = require('assert')
const { FaithfulCommunityValidator } = require('../systems/faithful-community-validator')

// A 16x10 two-story modern house: real interior, doors, stairs, glass, roof —
// but smaller than the villa ruler's 18x14 footprint floor. This is the shape
// the modern_cottage tier exists for (measured candidates: 17x10x15, interior
// volume 15; thresholds sit under those with margin).
function cottageBlueprint(overrides = {}) {
  const width = 16
  const depth = 10
  const roofY = 8
  const secondFloorY = 4
  const blocks = []

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ x, y: 0, z, type: 'quartz_block' })
      blocks.push({ x, y: secondFloorY, z, type: 'quartz_block' })
      blocks.push({ x, y: roofY, z, type: 'quartz_block' })
    }
  }
  for (const y of [1, 2, 3, 5, 6, 7]) {
    for (let x = 0; x < width; x++) {
      for (const z of [0, depth - 1]) {
        if (!overrides.noDoor && z === 0 && x === Math.floor(width / 2) && (y === 1 || y === 2)) continue
        blocks.push(wallOrWindow(x, y, z, width, depth, overrides))
      }
    }
    for (let z = 1; z < depth - 1; z++) {
      for (const x of [0, width - 1]) {
        blocks.push(wallOrWindow(x, y, z, width, depth, overrides))
      }
    }
  }
  if (!overrides.noDoor) {
    blocks.push({ x: Math.floor(width / 2), y: 1, z: 0, type: 'oak_door', states: { half: 'lower', facing: 'south' } })
    blocks.push({ x: Math.floor(width / 2), y: 2, z: 0, type: 'oak_door', states: { half: 'upper', facing: 'south' } })
  }
  if (!overrides.noStairs) {
    for (let i = 0; i < 4; i++) {
      blocks.push({ x: 2 + i, y: 1 + i, z: 2, type: 'oak_stairs', states: { facing: 'east' } })
    }
  }
  blocks.push({ x: 3, y: 1, z: 3, type: 'chest' })

  return {
    name: overrides.name || 'small_modern_house_candidate',
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      buildingType: 'modern_house',
      style: 'modern',
      ...(overrides.buildingCategory ? { buildingCategory: overrides.buildingCategory } : {})
    },
    blocks: blocks.filter(block => !(overrides.partialRoof && block.y === roofY && block.x > Math.floor(width / 2)))
  }
}

function wallOrWindow(x, y, z, width, depth, overrides = {}) {
  const window = !overrides.noGlass && y === 2 &&
    (z === depth - 1) && [3, 4, 5, 6, 9, 10, 11, 12].includes(x)
  if (window) return { x, y, z, type: 'glass_pane' }
  return { x, y, z, type: 'white_concrete' }
}

// Decision #30 (2026-09-01): villa ruler relaxed to minWidth 17 / interior 15.
const VILLA_LIMITS = { minWidth: 17, minDepth: 14, minInteriorVolume: 15 }
const UNRELAXED = { minDoorCount: 1, minGlassCount: 8, minFunctionCount: 1, minStories: 2, minRoofCoverage: 0.82, minHeight: 8 }

function validate(blueprint, request = {}) {
  return new FaithfulCommunityValidator().validateBlueprint(blueprint, { blueprintName: 'modern_cottage', ...request })
}

// 正: an explicitly annotated cottage is measured with the cottage ruler and passes.
function testExplicitAnnotationUsesCottageRuler() {
  const result = validate(cottageBlueprint({ buildingCategory: 'modern_cottage' }))
  assert.strictEqual(result.category, 'modern_cottage')
  assert.strictEqual(result.ok, true, `expected pass, failures=${JSON.stringify(result.failures)}`)
  // Only size and interior volume are relaxed relative to villa...
  assert.ok(result.limits.minWidth < VILLA_LIMITS.minWidth)
  assert.ok(result.limits.minDepth < VILLA_LIMITS.minDepth)
  assert.ok(result.limits.minInteriorVolume < VILLA_LIMITS.minInteriorVolume)
  // ...while every other floor stays at the villa values.
  for (const [name, value] of Object.entries(UNRELAXED)) {
    assert.strictEqual(result.limits[name], value, `${name} must stay at the villa value`)
  }
}

// 反: the same building without the annotation keeps the villa ruler and fails on size.
function testUnannotatedModernKeepsVillaRuler() {
  const result = validate(cottageBlueprint())
  assert.strictEqual(result.category, 'villa')
  assert.strictEqual(result.ok, false)
  assert.ok(result.failures.includes('minWidth'), JSON.stringify(result.failures))
  assert.ok(result.failures.includes('minDepth'), JSON.stringify(result.failures))
}

// 反: even the literal words "modern cottage" in names never select the tier.
function testRegexInferenceNeverSelectsCottage() {
  const result = validate(
    cottageBlueprint({ name: 'modern_cottage_hillside' }),
    { blueprintName: 'modern cottage', type: 'modern_cottage' }
  )
  assert.strictEqual(result.category, 'villa')
  assert.strictEqual(result.ok, false)
}

// 反: annotation only accepts the whitelisted tier — it cannot re-route to
// other categories (a "wood" annotation on a modern build stays villa).
function testAnnotationWhitelistDoesNotLeak() {
  const result = validate(cottageBlueprint({ buildingCategory: 'wood' }))
  assert.strictEqual(result.category, 'villa')
  const generic = validate(cottageBlueprint({ buildingCategory: 'garbage_value' }))
  assert.strictEqual(generic.category, 'villa')
}

// 反: the cottage ruler keeps every non-size check biting.
function testCottageStillFailsUnrelaxedChecks() {
  const noStairs = validate(cottageBlueprint({ buildingCategory: 'modern_cottage', noStairs: true }))
  assert.strictEqual(noStairs.ok, false)
  assert.ok(noStairs.failures.includes('verticalAccess'), JSON.stringify(noStairs.failures))

  const noGlass = validate(cottageBlueprint({ buildingCategory: 'modern_cottage', noGlass: true }))
  assert.strictEqual(noGlass.ok, false)
  assert.ok(noGlass.failures.includes('glassWindowCount'), JSON.stringify(noGlass.failures))

  const noDoor = validate(cottageBlueprint({ buildingCategory: 'modern_cottage', noDoor: true }))
  assert.strictEqual(noDoor.ok, false)
  assert.ok(noDoor.failures.includes('actualDoorCount'), JSON.stringify(noDoor.failures))
}

// 反: existing tiers are untouched — a canonical wood house still judges wood,
// and a nonresidential wall still passes the nonresidential ruler.
function testOtherTiersUnaffected() {
  const validator = new FaithfulCommunityValidator()
  const woodish = cottageBlueprint()
  woodish.metadata.style = 'wood'
  woodish.metadata.buildingType = 'wood_house'
  woodish.name = 'plain_wood_house'
  const wood = validator.validateBlueprint(woodish, { blueprintName: 'wood house' })
  assert.strictEqual(wood.category, 'wood')

  const wall = {
    name: 'perimeter_wall_segment',
    metadata: { structureUse: 'nonresidential' },
    blocks: Array.from({ length: 100 }, (_, i) => ({ x: i % 20, y: Math.floor(i / 20), z: 0, type: 'stone_bricks' }))
  }
  const wallResult = validator.validateBlueprint(wall, { blueprintName: 'perimeter_wall_segment' })
  assert.strictEqual(wallResult.ok, true, JSON.stringify(wallResult.failures))
}

function run() {
  testExplicitAnnotationUsesCottageRuler()
  testUnannotatedModernKeepsVillaRuler()
  testRegexInferenceNeverSelectsCottage()
  testAnnotationWhitelistDoesNotLeak()
  testCottageStillFailsUnrelaxedChecks()
  testOtherTiersUnaffected()
  console.log('modern cottage classification tests passed')
}

run()
