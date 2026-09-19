// Round 10 (repair lane): the controlled vertical-access executor hands
// moveTo a scaffold allow-list (scaffoldAllowedPositions) so the pathfinder
// may only place the scaffolds the preview planned. Upstream getMoveForward
// charges exclusionAreasPlace against the WALK cell rather than the placed
// floor cell, so a cost callback keyed on the allow-list rejected every
// forward bridge: the preview (no allow-list) said "success", the execution
// A* said "noPath", and she stood still until move_timeout. Live evidence:
// building lane round 14, target 607,73,-16, 254 log lines.
//
// This test runs the real mineflayer-pathfinder Movements on the real 1.21.8
// registry in a tiny fake world, through the repo's configureMovements.
const assert = require('assert')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.8')
const PBlock = require('prismarine-block')(mcData)
const { goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { configureMovements } = require('../actions/move')

const world = new Map()
const key = (x, y, z) => `${x},${y},${z}`
function fill (x1, y1, z1, x2, y2, z2, name) {
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) world.set(key(x, y, z), name)
}
function blockAt (pos) {
  const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
  const block = PBlock.fromStateId(mcData.blocksByName[world.get(key(x, y, z)) || 'air'].defaultState, 0)
  block.position = new Vec3(x, y, z)
  return block
}

// A lone pillar top at 0,70,0 (she stands at y=71) above a deep pit (ground
// top y=66, drop 5 > maxDropDown). The stand 2,71,-1 needs three floor cells
// bridged at y=70. No pillar/jump alternative exists inside the allow-list.
fill(-10, 40, -10, 10, 66, 10, 'stone')
fill(0, 67, 0, 0, 70, 0, 'stone')

const bot = {
  registry: mcData,
  version: '1.21.8',
  entity: { position: new Vec3(0.5, 71, 0.5), onGround: true, effects: {}, height: 1.8, width: 0.6 },
  entities: {},
  inventory: { items: () => [{ name: 'dirt', type: mcData.itemsByName.dirt.id, count: 64 }] },
  game: { minY: -64 },
  blockAt,
  pathfinder: { setMovements () {}, bestHarvestTool () { return null } },
  on () {}, once () {}, removeListener () {}
}

const stand = { x: 2, y: 71, z: -1 }
const plannedFloors = [{ x: 0, y: 70, z: -1 }, { x: 1, y: 70, z: -1 }, { x: 2, y: 70, z: -1 }]

function plan (allowed) {
  const movements = configureMovements(bot, {
    canDig: false,
    allowScaffolding: true,
    scaffoldAllowedPositions: allowed
  }, null)
  const start = new Move(0, 71, 0, movements.countScaffoldingItems(), 0)
  movements.clearCollisionIndex()
  movements.updateCollisionIndex()
  const result = new AStar(start, movements, new goals.GoalNear(stand.x, stand.y, stand.z, 0.75), 1000, 40, -1).compute()
  const placed = result.path.flatMap(node => node.toPlace.map(p => key(p.x + (p.dx || 0), p.y + (p.dy || 0), p.z + (p.dz || 0))))
  return { status: result.status, cost: Number(result.cost), placed }
}

// preview: no allow-list -> the bridge is the (only) route
const preview = plan(undefined)
assert.strictEqual(preview.status, 'success', 'preview must find the bridge route')
assert.deepStrictEqual(preview.placed, plannedFloors.map(p => key(p.x, p.y, p.z)), 'preview bridges the three planned floor cells')

// execution: the allow-list is exactly the previewed scaffolds -> must agree
const execution = plan(plannedFloors)
assert.strictEqual(execution.status, 'success', `execution A* must reach the previewed stand under its own allow-list (got ${execution.status})`)
assert.strictEqual(execution.cost, preview.cost, 'execution follows the previewed route at the same cost')
assert.deepStrictEqual(execution.placed, preview.placed, 'execution places exactly the previewed scaffolds')

// the allow-list still means something: a bridge into a cell that was not
// planned is refused, so no path exists when the last floor is missing
const truncated = plan(plannedFloors.slice(0, 2))
assert.strictEqual(truncated.status, 'noPath', 'an unplanned scaffold cell is still refused')

console.log('scaffold allow-list path tests passed')
