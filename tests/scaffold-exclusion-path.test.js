// Round 11 (repair lane): the sibling of the round 10 allow-list bug.
// moveTo also hands the pathfinder an EXCLUSION set (reservedPositions /
// scaffoldExclusionPositions = the blueprint's formal target cells) so no
// scaffold is ever dropped into a cell the build itself will occupy. That
// constraint was expressed as an exclusionAreasPlace cost callback, and
// upstream getMoveForward (lib/movements.js:382) charges that callback
// against the WALK cell (blockC) while the scaffold actually lands on the
// floor it bridges in (blockD). So the callback was wrong in both directions:
// it vetoed a legal bridge merely because she would walk THROUGH a target
// cell (preview success -> execution noPath -> stand still until
// move_timeout), and it never caught the real violation, a bridge whose
// floor IS the target cell.
//
// Real mineflayer-pathfinder Movements + real 1.21.8 registry + the repo's
// configureMovements, in a tiny fake world.
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

// A walled, roofed corridor along z=0 whose floor is missing for x=11..15.
// Nothing exists below y=70, so stepping off is an unbounded fall: the five
// forward bridges are the only route from the start pillar to the platform.
fill(10, 70, 0, 10, 70, 0, 'stone')        // start pillar top (she stands at y=71)
fill(16, 70, 0, 16, 70, 0, 'stone')        // goal platform
fill(9, 70, -1, 17, 72, -1, 'stone')       // wall
fill(9, 70, 1, 17, 72, 1, 'stone')         // wall
fill(9, 73, -1, 17, 73, 1, 'stone')        // roof: no detour one level up
fill(9, 71, 0, 9, 72, 0, 'stone')          // dead end behind her
fill(17, 71, 0, 17, 72, 0, 'stone')        // dead end past the goal

const bot = {
  registry: mcData,
  version: '1.21.8',
  entity: { position: new Vec3(10.5, 71, 0.5), onGround: true, effects: {}, height: 1.8, width: 0.6 },
  entities: {},
  inventory: { items: () => [{ name: 'dirt', type: mcData.itemsByName.dirt.id, count: 64 }] },
  game: { minY: -64 },
  blockAt,
  pathfinder: { setMovements () {}, bestHarvestTool () { return null } },
  on () {}, once () {}, removeListener () {}
}

const stand = { x: 16, y: 71, z: 0 }
const bridgeFloors = [
  { x: 11, y: 70, z: 0 }, { x: 12, y: 70, z: 0 }, { x: 13, y: 70, z: 0 },
  { x: 14, y: 70, z: 0 }, { x: 15, y: 70, z: 0 }
]
const walkCellOnRoute = { x: 13, y: 71, z: 0 }   // formal target she passes THROUGH
const floorCellOnRoute = { x: 13, y: 70, z: 0 }  // formal target a bridge would OCCUPY

function plan (excluded) {
  const movements = configureMovements(bot, {
    canDig: false,
    allowScaffolding: true,
    reservedPositions: excluded
  }, null)
  const start = new Move(10, 71, 0, movements.countScaffoldingItems(), 0)
  movements.clearCollisionIndex()
  movements.updateCollisionIndex()
  const result = new AStar(start, movements, new goals.GoalNear(stand.x, stand.y, stand.z, 0.8), 2000, 40, -1).compute()
  const placed = result.path.flatMap(node => node.toPlace.map(p => key(p.x + (p.dx || 0), p.y + (p.dy || 0), p.z + (p.dz || 0))))
  return { status: result.status, cost: Number(result.cost), placed, movements }
}

const expectedFloors = bridgeFloors.map(p => key(p.x, p.y, p.z))

// baseline: with no exclusions the corridor is crossed by bridging
const baseline = plan([])
assert.strictEqual(baseline.status, 'success', 'baseline must find the bridge route')
assert.deepStrictEqual(baseline.placed, expectedFloors, 'baseline bridges the five missing floor cells')

// the bug: a formal target on the WALK line must not veto the bridge under it
const throughTarget = plan([walkCellOnRoute])
assert.strictEqual(throughTarget.status, 'success',
  `bridging past a formal target cell must stay routable (got ${throughTarget.status})`)
assert.strictEqual(throughTarget.cost, baseline.cost, 'and it costs what the unconstrained route costs')
assert.deepStrictEqual(throughTarget.placed, expectedFloors, 'placing the same five floor cells')
assert.ok(!throughTarget.placed.includes(key(walkCellOnRoute.x, walkCellOnRoute.y, walkCellOnRoute.z)),
  'no scaffold is ever planned into the formal target cell itself')

// the constraint is NOT lost: a bridge whose floor IS the formal target is
// still refused, and with no alternative route that means noPath
const ontoTarget = plan([floorCellOnRoute])
assert.strictEqual(ontoTarget.status, 'noPath', 'a scaffold in the formal target cell is still refused')

// and the refusal comes from the exact-cell neighbor filter, never a cost
// callback -- the callback scores the wrong cell in both directions
assert.strictEqual(ontoTarget.movements.exclusionAreasPlace.length, 0,
  'the exclusion set must not be an exclusionAreasPlace cost callback')
assert.strictEqual(ontoTarget.movements.exclusionPlace({
  position: new Vec3(floorCellOnRoute.x, floorCellOnRoute.y, floorCellOnRoute.z)
}), 0, 'no place cost is charged anywhere')
assert.strictEqual(typeof ontoTarget.movements.__scaffoldPlacementCellFilter, 'function')
assert.strictEqual(ontoTarget.movements.__scaffoldPlacementCellFilter({
  toPlace: [{ x: 12, y: 70, z: 0, dx: 1, dy: 0, dz: 0 }]
}), false, 'the filter rejects the bridge that lands on the formal target')
assert.strictEqual(ontoTarget.movements.__scaffoldPlacementCellFilter({
  toPlace: [{ x: 11, y: 70, z: 0, dx: 1, dy: 0, dz: 0 }]
}), true, 'and allows a bridge that lands anywhere else')

console.log('scaffold exclusion path tests passed')
