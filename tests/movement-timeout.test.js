const assert = require('assert')
const {
  descendingEscapeWaypoints,
  distanceScaledMoveTimeout,
  localEscapeWaypoints,
  safeDropDownForHealth
} = require('../utils/movement-timeout')

function run() {
  assert.strictEqual(
    distanceScaledMoveTimeout({ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 4 }),
    15000
  )
  const longRouteTimeout = distanceScaledMoveTimeout(
    { x: 617.5, y: 65, z: -80.5 },
    { x: 577, y: 65, z: -108 }
  )
  assert.ok(longRouteTimeout > 58000 && longRouteTimeout < 59000)
  assert.strictEqual(
    distanceScaledMoveTimeout({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }),
    60000
  )
  assert.strictEqual(distanceScaledMoveTimeout(null, null), 15000)

  const escapeWaypoints = localEscapeWaypoints(
    { x: 613.7, y: 65, z: -80.5 },
    { x: 577, y: 65, z: -108 }
  )
  assert.deepStrictEqual(escapeWaypoints[0], { x: 617.5, y: 65, z: -80.5 })
  assert.strictEqual(escapeWaypoints.length, 4)

  // Round 11 live: tower top at feet y=106, chest at y=100 (drop 6 > 4).
  // Ledges are offered from the deepest legal level up, nearest the chest
  // first, so a descent can be walked in legs of at most maxDropDown.
  // maxFall 3 = the fall upstream maxDropDown 4 actually permits
  const ledges = descendingEscapeWaypoints({ x: 672.5, y: 106, z: 302.5 }, { x: 677, y: 100, z: 302 }, { offset: 4, maxFall: 3 })
  assert.strictEqual(ledges.length, 3 * 4 * 4, 'three levels x four offsets x four directions')
  assert.deepStrictEqual(ledges[0], { x: 676.5, y: 103, z: 302.5 }, 'deepest legal level, closest to the chest')
  assert.ok(ledges.every(ledge => ledge.y >= 103 && ledge.y <= 105))
  assert.ok(ledges.slice(0, 16).every(ledge => ledge.y === 103), 'all deepest-level ledges come first')
  assert.deepStrictEqual(
    descendingEscapeWaypoints({ x: 672.5, y: 103, z: 302.5 }, { x: 677, y: 100, z: 302 }),
    [],
    'a fall the pathfinder already accepts needs no ledges'
  )
  assert.deepStrictEqual(descendingEscapeWaypoints({ x: 1, y: 70, z: 1 }, null), [])

  // (distance - 3) HP of fall damage, three hearts kept in reserve, 8 at most
  assert.strictEqual(safeDropDownForHealth(20), 8)
  assert.strictEqual(safeDropDownForHealth(9), 6)
  assert.strictEqual(safeDropDownForHealth(8), 5)
  assert.strictEqual(safeDropDownForHealth(5), 3, 'never below the fall the walk already allows')
  assert.strictEqual(safeDropDownForHealth(undefined), 3)
  console.log('movement timeout tests passed')
}

run()
