const assert = require('assert')
const {
  FaithfulCommunityValidator,
  resolveStructureUse
} = require('../systems/faithful-community-validator')

// A 20x1x5 stone perimeter wall segment: structurally real (100 blocks,
// height 5) but with no interior, doors, roof, or habitable width — exactly
// the shape the residential habitability ruler is wrong for.
function wallBlueprint(overrides = {}) {
  const blocks = []
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 5; y++) {
      blocks.push({ x, y, z: 0, type: 'stone_bricks' })
    }
  }
  return {
    name: 'perimeter_wall_segment',
    blocks,
    metadata: {},
    ...overrides
  }
}

const HABITABILITY_CHECKS = [
  'minWidth',
  'minDepth',
  'actualDoorCount',
  'glassWindowCount',
  'detectedStories',
  'usableInteriorVolume',
  'shellLeakCount',
  'completeRoof',
  'verticalAccess',
  'functionalBlocksPresent'
]

function testResolveStructureUseDefaultsToResidential() {
  assert.strictEqual(resolveStructureUse({}, {}), 'residential')
  assert.strictEqual(resolveStructureUse({ metadata: {} }, {}), 'residential')
  assert.strictEqual(resolveStructureUse({ metadata: { structureUse: 'garbage' } }, {}), 'residential')
  assert.strictEqual(resolveStructureUse({ metadata: { structureUse: 'nonresidential' } }, {}), 'nonresidential')
  assert.strictEqual(resolveStructureUse({}, { selected: { structureUse: 'nonresidential' } }), 'nonresidential')
  assert.strictEqual(resolveStructureUse({}, { structureUse: 'Nonresidential ' }), 'nonresidential')
  // Request-level declaration wins over blueprint metadata.
  assert.strictEqual(
    resolveStructureUse({ metadata: { structureUse: 'nonresidential' } }, { structureUse: 'residential' }),
    'residential'
  )
}

function testResidentialStillBlockedByHabitability() {
  const validator = new FaithfulCommunityValidator()
  const result = validator.validateBlueprint(wallBlueprint(), { blueprintName: 'perimeter_wall_segment' })
  assert.strictEqual(result.structureUse, 'residential')
  assert.strictEqual(result.ok, false)
  const habitabilityFailures = result.failures.filter(name => HABITABILITY_CHECKS.includes(name))
  assert.ok(habitabilityFailures.length > 0, `expected habitability failures, got ${JSON.stringify(result.failures)}`)

  // Explicit residential must judge identically to the unlabeled default —
  // the delta=0 guarantee for every existing residential blueprint.
  const explicit = validator.validateBlueprint(
    wallBlueprint({ metadata: { structureUse: 'residential' } }),
    { blueprintName: 'perimeter_wall_segment' }
  )
  assert.deepStrictEqual(explicit.failures, result.failures)
  assert.deepStrictEqual(explicit.hardConstraints, result.hardConstraints)
}

function testNonresidentialNotBlockedByHabitability() {
  const validator = new FaithfulCommunityValidator()
  const result = validator.validateBlueprint(
    wallBlueprint({ metadata: { structureUse: 'nonresidential' } }),
    { blueprintName: 'perimeter_wall_segment' }
  )
  assert.strictEqual(result.structureUse, 'nonresidential')
  assert.strictEqual(result.ok, true, `expected pass, failures=${JSON.stringify(result.failures)}`)
  for (const name of HABITABILITY_CHECKS) {
    assert.ok(!(name in result.hardConstraints), `habitability check ${name} must not be enforced`)
  }
  // The structural checks stay enforced.
  assert.strictEqual(result.hardConstraints.minNonAirBlocks, true)
  assert.strictEqual(result.hardConstraints.minHeight, true)
  assert.strictEqual(result.hardConstraints.remainingScaffoldCount, true)
}

function testNonresidentialStillFailsStructuralChecks() {
  const validator = new FaithfulCommunityValidator()

  // Leftover scaffolding is a construction defect for any structure type.
  const withScaffold = wallBlueprint({ metadata: { structureUse: 'nonresidential' } })
  withScaffold.blocks.push({ x: 0, y: 5, z: 0, type: 'scaffolding' })
  const scaffoldResult = validator.validateBlueprint(withScaffold, { blueprintName: 'perimeter_wall_segment' })
  assert.strictEqual(scaffoldResult.ok, false)
  assert.ok(scaffoldResult.failures.includes('remainingScaffoldCount'))

  // A handful of blocks is not a structure; the size floor stays.
  const tiny = wallBlueprint({ metadata: { structureUse: 'nonresidential' } })
  tiny.blocks = tiny.blocks.slice(0, 10)
  const tinyResult = validator.validateBlueprint(tiny, { blueprintName: 'perimeter_wall_segment' })
  assert.strictEqual(tinyResult.ok, false)
  assert.ok(tinyResult.failures.includes('minNonAirBlocks'))
}

function testSourceModeRequirementAppliesToNonresidential() {
  // requireSourceMode is a provenance rule, not a habitability rule: it must
  // keep applying to non-residential structures too.
  const validator = new FaithfulCommunityValidator({ requireSourceMode: true })
  const result = validator.validateBlueprint(
    wallBlueprint({ metadata: { structureUse: 'nonresidential' } }),
    { blueprintName: 'perimeter_wall_segment' }
  )
  assert.strictEqual(result.ok, false)
  assert.ok(result.failures.includes('source_mode_not_faithful_community_import'))
}

function run() {
  testResolveStructureUseDefaultsToResidential()
  testResidentialStillBlockedByHabitability()
  testNonresidentialNotBlockedByHabitability()
  testNonresidentialStillFailsStructuralChecks()
  testSourceModeRequirementAppliesToNonresidential()
  console.log('structure use classification tests passed')
}

run()
