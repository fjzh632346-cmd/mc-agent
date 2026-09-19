const assert = require('assert')
const {
  enableDoorTraversal,
  installOpenableActivationPathReset,
  normalizeDoorPathNodes,
  reclassifyOpenableBlock
} = require('../actions/move')

// -- fixtures ---------------------------------------------------------------

const REGISTRY_BLOCKS = [
  { name: 'oak_door', id: 11 },
  { name: 'spruce_door', id: 12 },
  { name: 'iron_door', id: 13 },
  { name: 'oak_fence_gate', id: 21 },
  { name: 'stone', id: 31 }
]

function fakeBot() {
  return { registry: { blocksArray: REGISTRY_BLOCKS } }
}

function fakeMovements(blockByKey = {}) {
  return {
    canOpenDoors: false,
    openable: new Set([21]), // upstream ships gates only
    getBlock(pos, dx, dy, dz) {
      const key = `${dx},${dy},${dz}`
      return blockByKey[key] || { type: 0, safe: true, physical: false, openable: false }
    }
  }
}

function doorBlock({ type = 11, open = false, half = 'lower', openable = true }) {
  return {
    type,
    safe: false,
    physical: true,
    openable,
    shapes: [[0, 0, 0, 1, 1, 0.1875]],
    getProperties: () => ({ open, half, hinge: 'left', facing: 'north' })
  }
}

function gateBlock({ open = false }) {
  return {
    type: 21,
    safe: false,
    physical: false,
    openable: true,
    shapes: open ? [] : [[0, 0, 0.4, 1, 1.5, 0.6]],
    getProperties: () => ({ open, in_wall: false, facing: 'north' })
  }
}

const DOOR_IDS = new Set([11, 12])

// -- enableDoorTraversal ------------------------------------------------------

{
  const movements = fakeMovements()
  enableDoorTraversal(fakeBot(), movements)
  assert.strictEqual(movements.canOpenDoors, true, 'canOpenDoors enabled')
  assert.ok(movements.openable.has(11), 'oak_door registered openable')
  assert.ok(movements.openable.has(12), 'spruce_door registered openable')
  assert.ok(!movements.openable.has(13), 'iron_door NOT openable (ignores right-click)')
  assert.ok(movements.openable.has(21), 'gates keep their upstream registration')
}

{
  // getBlock wrapper applies state reclassification
  const closedLower = doorBlock({ open: false, half: 'lower' })
  const movements = fakeMovements({ '1,0,0': closedLower })
  enableDoorTraversal(fakeBot(), movements)
  const b = movements.getBlock({ x: 0, y: 0, z: 0 }, 1, 0, 0)
  assert.strictEqual(b.openable, true, 'closed lower door stays openable (useOne branch)')
  assert.strictEqual(b.physical, false, 'closed door never counts as walkable floor')
  assert.strictEqual(b.safe, false, 'closed lower door is not free to walk through')
}

{
  // a bot without door blocks in the registry leaves movements untouched
  const movements = fakeMovements()
  enableDoorTraversal({ registry: { blocksArray: [{ name: 'stone', id: 31 }] } }, movements)
  assert.strictEqual(movements.canOpenDoors, false, 'no doors in registry -> untouched')
}

// -- reclassifyOpenableBlock --------------------------------------------------

{
  const b = reclassifyOpenableBlock(doorBlock({ open: false, half: 'upper' }), DOOR_IDS)
  assert.strictEqual(b.safe, true, 'closed UPPER half passable for the head-height check')
  assert.strictEqual(b.openable, false, 'upper half never gets its own useOne activation')
  assert.strictEqual(b.physical, false)
}

{
  const b = reclassifyOpenableBlock(doorBlock({ open: true, half: 'lower' }), DOOR_IDS)
  assert.strictEqual(b.safe, true, 'open door is plain walkable')
  assert.strictEqual(b.openable, false, 'open door must NOT be toggled shut mid-walk')
  assert.strictEqual(b.physical, false)
}

{
  const b = reclassifyOpenableBlock(doorBlock({ open: true, half: 'upper' }), DOOR_IDS)
  assert.strictEqual(b.safe, true)
  assert.strictEqual(b.openable, false)
}

{
  const b = reclassifyOpenableBlock(gateBlock({ open: true }), DOOR_IDS)
  assert.strictEqual(b.safe, true, 'open gate is plain walkable')
  assert.strictEqual(b.openable, false, 'open gate must NOT be toggled shut mid-walk')
}

{
  const b = reclassifyOpenableBlock(gateBlock({ open: false }), DOOR_IDS)
  assert.strictEqual(b.openable, true, 'closed gate keeps the upstream useOne behavior')
  assert.strictEqual(b.safe, false)
}

{
  // non-openable blocks pass through untouched
  const stone = { type: 31, safe: false, physical: true, openable: false }
  const b = reclassifyOpenableBlock(stone, DOOR_IDS)
  assert.strictEqual(b.safe, false)
  assert.strictEqual(b.physical, true)
  assert.strictEqual(reclassifyOpenableBlock(null, DOOR_IDS), null, 'null block tolerated')
}

// -- normalizeDoorPathNodes ---------------------------------------------------
// postProcessPath lifts door-cell nodes onto the door panel's collision shape
// (y+1, panel-edge x/z); the normalizer must snap them back to the walkable
// cell center at foot height.

function worldBot(blocks) {
  return {
    blockAt: pos => blocks[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' }
  }
}

{
  // node lifted onto the panel top: floored block is the door's UPPER half
  const blocks = {
    '545,70,-39': { name: 'oak_door', getProperties: () => ({ half: 'upper', open: true }) }
  }
  const path = [{ x: 545.296875, y: 70, z: -38.5 }]
  normalizeDoorPathNodes(worldBot(blocks), path)
  assert.deepStrictEqual(path[0], { x: 545.5, y: 69, z: -38.5 }, 'panel-top node snapped to lower cell center')
}

{
  // node already at the lower half keeps its cell, recentered
  const blocks = {
    '545,69,-39': { name: 'oak_door', getProperties: () => ({ half: 'lower', open: false }) }
  }
  const path = [{ x: 545.09, y: 69, z: -38.91 }]
  normalizeDoorPathNodes(worldBot(blocks), path)
  assert.strictEqual(path[0].x, 545.5)
  assert.strictEqual(path[0].y, 69)
  assert.strictEqual(path[0].z, -38.5)
}

{
  // non-door nodes untouched; iron doors untouched
  const blocks = {
    '10,64,10': { name: 'stone' },
    '11,64,10': { name: 'iron_door', getProperties: () => ({ half: 'lower', open: false }) }
  }
  const path = [
    { x: 10.5, y: 64.2, z: 10.5 },
    { x: 11.3, y: 64, z: 10.9 }
  ]
  normalizeDoorPathNodes(worldBot(blocks), path)
  assert.deepStrictEqual(path[0], { x: 10.5, y: 64.2, z: 10.5 })
  assert.deepStrictEqual(path[1], { x: 11.3, y: 64, z: 10.9 })
}

{
  // tolerates missing paths and bots without blockAt
  assert.strictEqual(normalizeDoorPathNodes({ }, null), null)
  const path = [{ x: 1.5, y: 2, z: 3.5 }]
  normalizeDoorPathNodes({}, path)
  assert.deepStrictEqual(path[0], { x: 1.5, y: 2, z: 3.5 })
}

// -- consumed useOne reset ---------------------------------------------------
// Upstream 2.4.5 keeps isBuilding=true after the last door activation and
// crashes on the next physics tick. Successful activation must reset the old
// path without clearing its goal.

const openableResetTest = (async () => {
  const movements = fakeMovements()
  let building = true
  let setMovementsCalls = 0
  const bot = {
    registry: { blocksArray: REGISTRY_BLOCKS },
    pathfinder: {
      movements,
      isBuilding: () => building,
      setMovements(next) {
        assert.strictEqual(next, movements, 'same movements object reapplied')
        setMovementsCalls += 1
        building = false
      }
    },
    activateBlock: async block => `opened:${block.name}`
  }

  installOpenableActivationPathReset(bot)
  installOpenableActivationPathReset(bot)
  const result = await bot.activateBlock({ name: 'spruce_door' })
  assert.strictEqual(result, 'opened:spruce_door')
  assert.strictEqual(setMovementsCalls, 1, 'successful pathfinder door activation replans exactly once')

  building = false
  await bot.activateBlock({ name: 'spruce_door' })
  assert.strictEqual(setMovementsCalls, 1, 'manual door activation does not touch pathfinder state')
})()

openableResetTest.then(() => {
  console.log('door-traversal tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
