const assert = require('assert')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')

const adapter = new LegacyBlueprintAdapter()
const validator = new BlueprintValidator()

function communityBlueprint() {
  return {
    name: 'community_fixture_house',
    origin: { x: 10, y: 64, z: -4 },
    metadata: {
      sourceMode: 'faithful-community-import',
      sourceKind: 'real_community_import',
      buildingType: 'two_story_wood_house',
      worldOrigin: { x: 100, y: 70, z: 100 },
      rotation: 90
    },
    blocks: [
      { x: 10, y: 64, z: -4, type: 'oak_planks', phase: 'floor' },
      { x: 10, y: 65, z: -4, type: 'oak_log', phase: 'wall' },
      { x: 10, y: 66, z: -4, type: 'glass', phase: 'window', role: 'window' },
      { x: 11, y: 65, z: -4, type: 'oak_door', states: { half: 'lower', facing: 'south' }, phase: 'door' },
      { x: 11, y: 66, z: -4, type: 'oak_door', states: { half: 'upper', facing: 'south' }, phase: 'door' }
    ]
  }
}

function validateLegacy(blueprint) {
  const adapted = adapter.fromLegacyBlueprint(blueprint)
  assert.strictEqual(adapted.ok, true, JSON.stringify(adapted.diagnostics))
  const validation = validator.validate(adapted.blueprint)
  return { adapted, validation }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function diagnosticCodes(validation) {
  return validation.diagnostics.map(entry => entry.code)
}

function testCommunityBlueprintNormalizesToIR() {
  const { validation } = validateLegacy(communityBlueprint())
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics))
  const ir = validation.blueprint
  assert.strictEqual(ir.schemaVersion, 1)
  assert.strictEqual(ir.blocks[0].position.x, 0)
  assert.strictEqual(ir.blocks[0].position.y, 0)
  assert.strictEqual(ir.blocks[0].position.z, 0)
  assert.strictEqual(ir.metadata.worldOrigin, undefined)
  assert.strictEqual(ir.metadata.rotation, undefined)
  assert.ok(ir.blocks.every(block => Array.isArray(block.dependencies)))
  assert.ok(ir.blocks.every(block => Array.isArray(block.materialAlternatives)))
}

function testProceduralBlueprintNormalizesToSameIRShape() {
  const generated = new ProceduralBlueprintGenerator().generate('fountain')
  assert.strictEqual(generated.ok, true)
  const { validation } = validateLegacy(generated.blueprint)
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics))
  assert.strictEqual(validation.blueprint.schemaVersion, 1)
  assert.ok(validation.blueprint.blocks.every(block => block.block?.id))
  assert.ok(validation.blueprint.blocks.every(block => block.clearancePolicy))
}

function testValidatedIRIsImmutable() {
  const { validation } = validateLegacy(communityBlueprint())
  assert.strictEqual(Object.isFrozen(validation.blueprint), true)
  assert.strictEqual(Object.isFrozen(validation.blueprint.blocks), true)
  assert.strictEqual(Object.isFrozen(validation.blueprint.blocks[0]), true)
  assert.strictEqual(Object.isFrozen(validation.blueprint.blocks[0].position), true)
  assert.strictEqual(Object.isFrozen(validation.blueprint.blocks[0].block), true)
  assert.strictEqual(Object.isFrozen(validation.blueprint.blocks[3].block.states), true)
  assert.throws(() => validation.blueprint.blocks.push({}), TypeError)
}

function testDuplicateCoordinatesRejected() {
  const { adapted } = validateLegacy(communityBlueprint())
  const ir = clone(adapted.blueprint)
  ir.blocks[1].position = { ...ir.blocks[0].position }
  const result = validator.validate(ir)
  assert.strictEqual(result.ok, false)
  assert.ok(diagnosticCodes(result).includes('duplicate_position'))
}

function testMissingDependencyRejected() {
  const { adapted } = validateLegacy(communityBlueprint())
  const ir = clone(adapted.blueprint)
  ir.blocks[0].dependencies = ['missing_block_key']
  const result = validator.validate(ir)
  assert.strictEqual(result.ok, false)
  assert.ok(diagnosticCodes(result).includes('missing_dependency'))
}

function testCyclicDependencyRejected() {
  const { adapted } = validateLegacy(communityBlueprint())
  const ir = clone(adapted.blueprint)
  ir.blocks[0].dependencies = [ir.blocks[1].key]
  ir.blocks[1].dependencies = [ir.blocks[0].key]
  const result = validator.validate(ir)
  assert.strictEqual(result.ok, false)
  assert.ok(diagnosticCodes(result).includes('cyclic_dependency'))
}

function testIllegalPhaseRejected() {
  const { adapted } = validateLegacy(communityBlueprint())
  const ir = clone(adapted.blueprint)
  ir.blocks[0].phase = 'pour_concrete'
  const result = validator.validate(ir)
  assert.strictEqual(result.ok, false)
  assert.ok(diagnosticCodes(result).includes('bad_phase'))
}

function testBoundsMismatchRejected() {
  const { adapted } = validateLegacy(communityBlueprint())
  const ir = clone(adapted.blueprint)
  ir.bounds.max.x += 1
  const result = validator.validate(ir)
  assert.strictEqual(result.ok, false)
  assert.ok(diagnosticCodes(result).includes('bounds_mismatch'))
}

function testBedHeadDependsOnBedFoot() {
  const blueprint = {
    name: 'bed_pair_fixture',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks', phase: 'floor' },
      { x: 0, y: 0, z: 1, type: 'oak_planks', phase: 'floor' },
      { x: 0, y: 1, z: 0, type: 'white_bed', phase: 'functional_blocks', role: 'bed', states: { facing: 'south', part: 'foot' } },
      { x: 0, y: 1, z: 1, type: 'white_bed', phase: 'functional_blocks', role: 'bed', states: { facing: 'south', part: 'head' } }
    ]
  }
  const adapted = adapter.fromLegacyBlueprint(blueprint)
  assert.strictEqual(adapted.ok, true)
  const foot = adapted.blueprint.blocks.find(block => block.block.states.part === 'foot')
  const head = adapted.blueprint.blocks.find(block => block.block.states.part === 'head')
  assert.ok(foot && head)
  assert.ok(head.dependencies.includes(foot.key), JSON.stringify(head.dependencies))
  const result = validator.validate(adapted.blueprint)
  assert.strictEqual(result.ok, true, JSON.stringify(result.diagnostics))
}

function run() {
  testCommunityBlueprintNormalizesToIR()
  testProceduralBlueprintNormalizesToSameIRShape()
  testValidatedIRIsImmutable()
  testDuplicateCoordinatesRejected()
  testMissingDependencyRejected()
  testCyclicDependencyRejected()
  testIllegalPhaseRejected()
  testBoundsMismatchRejected()
  testBedHeadDependsOnBedFoot()
  console.log('blueprint ir tests passed')
}

run()
