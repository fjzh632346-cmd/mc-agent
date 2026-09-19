// Round 5 (repair lane): clearing must not dig away the ground it is standing
// on.
//
// Live repro on the repair server, before this guard existed: LinXia stood on
// the rim block of a four-deep pit, was asked to clear that block, dug it, and
// clearBlockForBuilding returned `block_cleared` with no warning of any kind.
// The next movement request came back `move_timeout` and the server put her at
// the bottom of the pit — the same terminal error the 2026-08-01 build died on.
//
// The guard is deliberately narrow. It only speaks up when the target really is
// the block under her feet AND the drop underneath is one the project already
// calls a hole (terrain-hazards' DEFAULT_MIN_DEPTH). Ordinary ground-level
// clearing, and clearing anything that is not her own footing, must go through
// completely unchanged — that half is what the "no change" cases below pin.
const assert = require('assert')
const build = require('../actions/build')
const { DEFAULT_MIN_DEPTH } = require('../systems/terrain-hazards')

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    clone() {
      return vec(x, y, z)
    },
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

// A world where only the named cells hold a block; everything else is air, and
// anything outside `known` reads as null the way an unloaded chunk does.
function createWorld(solids, options = {}) {
  const map = new Map()
  for (const [key, name] of Object.entries(solids)) map.set(key, name)
  return position => {
    const key = `${position.x},${position.y},${position.z}`
    if (options.unknownBelowY !== undefined && position.y < options.unknownBelowY) return null
    return { name: map.get(key) || 'air', position: vec(position.x, position.y, position.z) }
  }
}

function createContext(params = {}) {
  const logs = []
  const digs = []
  const goals = []
  const bot = {
    username: 'LinXia',
    health: 20,
    entity: { position: vec(600.5, 64, 400.5), onGround: true },
    heldItem: { name: 'diamond_pickaxe' },
    inventory: { items: () => [{ name: 'diamond_pickaxe', count: 1 }] },
    pathfinder: {
      setMovements() {},
      stop() {},
      getPathTo: () => ({ status: 'success', cost: 1, path: [] }),
      setGoal(goal) {
        if (!goal) return
        goals.push(`${goal.x},${goal.y},${goal.z}`)
        if (params.moveFails === true) return
        bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
      }
    },
    once() {},
    blockAt: params.blockAt,
    canDigBlock: () => true,
    async dig(block) {
      digs.push(`${block.position.x},${block.position.y},${block.position.z}`)
      params.onDig?.(block)
    },
    async equip() {}
  }
  return {
    ctx: { bot, logger: { log: message => logs.push(message) } },
    logs,
    digs,
    goals
  }
}

// The repro, in miniature: she stands on 600,63,400 with three blocks of air
// under it. She must step off first and only then dig, and the decision has to
// be visible in the log.
async function testStandingOnTargetOverAPitStepsOffFirst() {
  const solids = {
    '600,63,400': 'stone',
    // the rim she can step back onto
    '601,63,400': 'stone',
    '602,63,400': 'stone',
    // pit floor, three blocks down
    '600,59,400': 'stone',
    '601,59,400': 'stone'
  }
  let cleared = false
  const blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '600,63,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
    return createWorld(solids)(position)
  }
  const { ctx, logs, digs } = createContext({
    blockAt,
    onDig: () => { cleared = true }
  })

  const result = await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(digs, ['600,63,400'], 'the block is still cleared, just not from on top of it')
  assert.ok(
    logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_RISK]') && message.includes('fallDepth=3')),
    'the risk has to be stated, with the drop it measured'
  )
  assert.ok(
    logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_STEPPED_OFF]')),
    'and so does the step-off that answered it'
  )
  assert.ok(
    ctx.bot.entity.position.x !== 600.5 || ctx.bot.entity.position.z !== 400.5,
    'she must not still be standing on the block she just dug'
  )
}

// Nowhere to step: refuse. A failed clear is a step the build can retry or
// route around; a bot stranded at the bottom of a pit is neither.
async function testNoSafeStandRefusesInsteadOfDigging() {
  const solids = {
    '600,63,400': 'stone',
    // a lone pillar over a hole — every neighbouring column is open
    '600,55,400': 'stone'
  }
  const { ctx, logs, digs } = createContext({ blockAt: createWorld(solids) })

  const result = await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40
  })

  assert.strictEqual(result.ok, false)
  assert.ok(
    result.error.startsWith('unsafe_clear_own_footing:'),
    `expected a named footing refusal, got ${result.error}`
  )
  assert.strictEqual(result.fallDepth, 7)
  assert.deepStrictEqual(digs, [], 'nothing may be dug once we know it strands her')
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_RISK]')))
}

// Found a stand but could not get to it: still a refusal, not a dig.
async function testFailedStepOffRefusesToDig() {
  const solids = {
    '600,63,400': 'stone',
    '601,63,400': 'stone',
    '600,59,400': 'stone'
  }
  const { ctx, logs, digs } = createContext({
    blockAt: createWorld(solids),
    moveFails: true
  })

  const result = await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40,
    standMoveAttempts: 1
  })

  assert.strictEqual(result.ok, false)
  assert.ok(result.error.startsWith('unsafe_clear_own_footing:'), result.error)
  assert.deepStrictEqual(digs, [])
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_STEP_OFF_FAILED]')))
}

// --- the "no change" half -------------------------------------------------

// Standing on the target but on honest ground: one block of drop is a step,
// not a hole. Digs immediately, exactly as before, and says nothing.
async function testStandingOnTargetOverSolidGroundIsUnchanged() {
  const solids = {
    '600,63,400': 'stone',
    '600,62,400': 'stone',
    '600,61,400': 'stone'
  }
  let cleared = false
  const blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '600,63,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
    return createWorld(solids)(position)
  }
  const { ctx, logs, digs, goals } = createContext({ blockAt, onDig: () => { cleared = true } })

  const result = await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(digs, ['600,63,400'])
  assert.deepStrictEqual(goals, [], 'no repositioning for a harmless step down')
  assert.ok(!logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_')))
}

// Ordinary clearing of a block that is simply in front of her: untouched.
async function testClearingABlockSheIsNotStandingOnIsUnchanged() {
  const solids = {
    '601,64,400': 'stone',
    '600,63,400': 'stone',
    '601,63,400': 'stone'
  }
  let cleared = false
  const blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '601,64,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
    return createWorld(solids)(position)
  }
  const { ctx, logs, digs, goals } = createContext({ blockAt, onDig: () => { cleared = true } })

  const result = await build.clearBlockForBuilding(ctx, { x: 601, y: 64, z: 400 }, {
    owner: 'test',
    timeoutMs: 40
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(digs, ['601,64,400'])
  assert.deepStrictEqual(goals, [])
  assert.ok(!logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_')))
}

// Her hitbox is 0.7 wide, so most positions the pathfinder stops in straddle
// two columns. A block she overlaps by four centimetres while standing squarely
// on its neighbour is not her footing, and refusing those would block half the
// ordinary clears on a building site.
async function testStraddlingTheTargetWithOtherSupportIsUnchanged() {
  const solids = {
    '599,63,400': 'stone',
    '598,63,400': 'stone',
    '599,59,400': 'stone'
  }
  let cleared = false
  const world = createWorld(solids)
  const blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '599,63,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
    return world(position)
  }
  const { ctx, logs, digs, goals } = createContext({ blockAt, onDig: () => { cleared = true } })
  // 598.69 spans 598.34..599.04: mostly on 598, four centimetres over 599.
  ctx.bot.entity.position = vec(598.69, 64, 400.5)

  const result = await build.clearBlockForBuilding(ctx, { x: 599, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(digs, ['599,63,400'])
  assert.deepStrictEqual(goals, [], 'solid ground under the other half of her feet means nothing to step off')
  assert.ok(!logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_')))
}

// An unloaded column reads as null, not as a void. Refusing to dig on the
// strength of blocks nobody ever looked at would strand her far more often
// than the bug being fixed, so an unknown drop must NOT trip the guard.
async function testUnknownColumnBelowDoesNotTripTheGuard() {
  const solids = { '600,63,400': 'stone' }
  let cleared = false
  const world = createWorld(solids, { unknownBelowY: 63 })
  const blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '600,63,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
    return world(position)
  }
  const { ctx, logs, digs } = createContext({ blockAt, onDig: () => { cleared = true } })

  const result = await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(digs, ['600,63,400'])
  assert.ok(!logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_')))
}

// The threshold is the project's existing definition of a hole, not a new
// number invented here. One block above it trips, one block below it does not.
async function testGuardTripsExactlyAtTheHazardDepth() {
  async function runWithDrop(drop) {
    const solids = { '600,63,400': 'stone' }
    solids[`600,${63 - drop - 1},400`] = 'stone'
    let cleared = false
    const world = createWorld(solids)
    const blockAt = position => {
      const key = `${position.x},${position.y},${position.z}`
      if (key === '600,63,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
      return world(position)
    }
    const { ctx, logs } = createContext({ blockAt, onDig: () => { cleared = true } })
    await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, { owner: 'test', timeoutMs: 40 })
    return logs.some(message => message.includes('[BUILD_CLEAR_FOOTING_RISK]'))
  }

  assert.strictEqual(await runWithDrop(DEFAULT_MIN_DEPTH - 1), false, 'a drop shallower than a hole is not a hazard')
  assert.strictEqual(await runWithDrop(DEFAULT_MIN_DEPTH), true, 'a drop that deep is one')
}

// The caller can still take the risk deliberately (a controlled demolition of
// scaffolding under her own feet, say) — but it has to be asked for by name.
async function testExplicitOptOutStillDigs() {
  const solids = { '600,63,400': 'stone', '600,55,400': 'stone' }
  let cleared = false
  const world = createWorld(solids)
  const blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '600,63,400' && cleared) return { name: 'air', position: vec(position.x, position.y, position.z) }
    return world(position)
  }
  const { ctx, digs } = createContext({ blockAt, onDig: () => { cleared = true } })

  const result = await build.clearBlockForBuilding(ctx, { x: 600, y: 63, z: 400 }, {
    owner: 'test',
    timeoutMs: 40,
    allowClearingOwnFooting: true
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(digs, ['600,63,400'])
}

// Source-level guard. The no-safe-stand fallback walks straight at the
// obstacle; on 2026-08-01 that branch lost her and the ONLY clue was a missing
// [BUILD_STANCE_CANDIDATES] line. It must never go silent again.
function testNoSafeStandFallbackIsNotSilent() {
  const source = require('fs').readFileSync(require.resolve('../actions/build.js'), 'utf8')
  assert.ok(
    source.includes('[BUILD_CLEAR_NO_SAFE_STAND]'),
    'the zero-candidate clear fallback must log before it walks at the obstacle'
  )
  const fallbackIndex = source.indexOf('const moveTarget = safeApproach || target')
  const logIndex = source.indexOf('[BUILD_CLEAR_NO_SAFE_STAND]')
  assert.ok(logIndex > -1 && fallbackIndex > logIndex, 'the log has to come before the fallback move')
}

async function run() {
  await testStandingOnTargetOverAPitStepsOffFirst()
  await testNoSafeStandRefusesInsteadOfDigging()
  await testFailedStepOffRefusesToDig()
  await testStandingOnTargetOverSolidGroundIsUnchanged()
  await testClearingABlockSheIsNotStandingOnIsUnchanged()
  await testStraddlingTheTargetWithOtherSupportIsUnchanged()
  await testUnknownColumnBelowDoesNotTripTheGuard()
  await testGuardTripsExactlyAtTheHazardDepth()
  await testExplicitOptOutStillDigs()
  testNoSafeStandFallbackIsNotSilent()
  console.log('clear-footing-guard tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
