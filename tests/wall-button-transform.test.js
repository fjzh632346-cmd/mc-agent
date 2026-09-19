const assert = require('assert')
const fixture = require('./fixtures/wall-button-negative-region.json')
const { _test: importerTest } = require('../systems/community-structure-importer')
const { materializeBlueprintBlocks } = require('../systems/construction-compiler')

const BUTTON_FAMILY = [
  'oak_button',
  'spruce_button',
  'birch_button',
  'jungle_button',
  'acacia_button',
  'dark_oak_button',
  'mangrove_button',
  'cherry_button',
  'bamboo_button',
  'stone_button',
  'polished_blackstone_button'
]
const FENCE_GATE_FAMILY = [
  'oak_fence_gate',
  'spruce_fence_gate',
  'birch_fence_gate',
  'jungle_fence_gate',
  'acacia_fence_gate',
  'dark_oak_fence_gate',
  'mangrove_fence_gate',
  'cherry_fence_gate',
  'bamboo_fence_gate',
  'crimson_fence_gate',
  'warped_fence_gate'
]

function testNegativeRegionTransformsPositionAndFacingOnce() {
  const transform = {
    mirrorX: fixture.region.size.x < 0,
    mirrorZ: fixture.region.size.z < 0
  }
  const buttonPosition = importerTest.transformRegionPosition(
    fixture.button.localPosition,
    fixture.region.size,
    fixture.region.position
  )
  const supportPosition = importerTest.transformRegionPosition(
    fixture.support.localPosition,
    fixture.region.size,
    fixture.region.position
  )
  const importedButton = importerTest.transformBlockStateForRegionDirection({
    type: fixture.button.blockId,
    states: fixture.button.properties
  }, transform)

  assert.deepStrictEqual(buttonPosition, fixture.button.rawPosition)
  assert.deepStrictEqual(supportPosition, fixture.support.rawPosition)
  assert.strictEqual(importedButton.states.face, 'wall')
  assert.strictEqual(importedButton.states.facing, 'north')
  assert.strictEqual(importedButton.states.powered, 'false')
  assert.strictEqual(supportPosition.z, buttonPosition.z + 1)

  const [worldButton] = materializeBlueprintBlocks({
    blocks: [{
      key: `button_${fixture.button.rawPosition.x},${fixture.button.rawPosition.y},${fixture.button.rawPosition.z}`,
      position: buttonPosition,
      block: { id: fixture.button.blockId, states: importedButton.states },
      dependencies: [],
      materialAlternatives: []
    }]
  }, fixture.placement)

  assert.deepStrictEqual(worldButton.position, fixture.placement.target)
  assert.strictEqual(worldButton.states.facing, 'north')
}

function testWallButtonRotationTransformsPositionAndFacingTogether() {
  const [button] = materializeBlueprintBlocks(buttonBlueprint('dark_oak_button'), {
    origin: { x: 100, y: 64, z: 200 },
    rotationY: 90,
    mirror: { x: false, z: false }
  })

  assert.deepStrictEqual(button.position, { x: 98, y: 66, z: 208 })
  assert.strictEqual(button.states.facing, 'west')
  assert.strictEqual(button.states.face, 'wall')
}

function testWallButtonMirrorTransformsPositionAndFacingTogether() {
  for (const blockName of BUTTON_FAMILY) {
    const [button] = materializeBlueprintBlocks(buttonBlueprint(blockName), {
      origin: { x: 100, y: 64, z: 200 },
      rotationY: 0,
      mirror: { x: false, z: true }
    })

    assert.deepStrictEqual(button.position, { x: 108, y: 66, z: 198 }, blockName)
    assert.strictEqual(button.states.facing, 'north', blockName)
  }
}

function testFenceGateRotationTransformsPositionAndFacingTogether() {
  for (const blockName of FENCE_GATE_FAMILY) {
    const [gate] = materializeBlueprintBlocks(fenceGateBlueprint(blockName), {
      origin: { x: 100, y: 64, z: 200 },
      rotationY: 90,
      mirror: { x: false, z: false }
    })

    assert.deepStrictEqual(gate.position, { x: 98, y: 66, z: 208 }, blockName)
    assert.strictEqual(gate.states.facing, 'west', blockName)
    assert.strictEqual(gate.states.open, 'true', blockName)
  }
}

function testFenceGateMirrorTransformsPositionAndFacingTogether() {
  for (const blockName of FENCE_GATE_FAMILY) {
    const [gate] = materializeBlueprintBlocks(fenceGateBlueprint(blockName), {
      origin: { x: 100, y: 64, z: 200 },
      rotationY: 0,
      mirror: { x: false, z: true }
    })

    assert.deepStrictEqual(gate.position, { x: 108, y: 66, z: 198 }, blockName)
    assert.strictEqual(gate.states.facing, 'north', blockName)
    assert.strictEqual(gate.states.open, 'true', blockName)
  }
}

function buttonBlueprint(blockName) {
  return {
    blocks: [{
      key: `button_${blockName}`,
      position: { x: 8, y: 2, z: 2 },
      block: {
        id: blockName,
        states: { face: 'wall', facing: 'south', powered: 'false' }
      },
      dependencies: [],
      materialAlternatives: []
    }]
  }
}

function fenceGateBlueprint(blockName) {
  return {
    blocks: [{
      key: `fence_gate_${blockName}`,
      position: { x: 8, y: 2, z: 2 },
      block: {
        id: blockName,
        states: { facing: 'south', open: 'true', powered: 'false', in_wall: 'false' }
      },
      dependencies: [],
      materialAlternatives: []
    }]
  }
}

function run() {
  testNegativeRegionTransformsPositionAndFacingOnce()
  testWallButtonRotationTransformsPositionAndFacingTogether()
  testWallButtonMirrorTransformsPositionAndFacingTogether()
  testFenceGateRotationTransformsPositionAndFacingTogether()
  testFenceGateMirrorTransformsPositionAndFacingTogether()
  console.log('wall button transform tests passed')
}

run()
