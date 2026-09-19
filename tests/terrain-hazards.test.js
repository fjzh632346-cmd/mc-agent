const assert = require('assert')

const {
  DEFAULT_TTL_MS,
  activeTerrainHazards,
  clearTerrainHazards,
  floodHoleColumns,
  getTerrainHazardSnapshot,
  hazardsBlockCorridor,
  listTerrainHazards,
  measureHole,
  rememberTerrainHazard,
  terrainHazardCellFilter
} = require('../systems/terrain-hazards')

const { avoidKnownTerrainHazards, shouldRetryWithoutHazards } = require('../actions/move')
const { createRecoveryState, runStuckRecovery } = require('../tasks/stuck-recovery')

// The pit that actually held her: a 5x5 shaft with a four-block drop, floor at
// y=60 (so she stands at 61) and the surrounding ground topping out at y=64.
// Everything about the hazard geometry is judged against this shape.
const PIT = { minX: 558, maxX: 562, minZ: 373, maxZ: 377, floorTopY: 60, groundTopY: 64 }

function createWorld(options = {}) {
  const filled = new Set()
  const pit = { ...PIT, ...(options.pit || {}) }
  const pits = options.pits || [pit]
  const insidePit = (x, z) => pits.some(p => x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ)

  function nameAt(x, y, z) {
    if (filled.has(`${x},${y},${z}`)) return 'dirt'
    if (y <= pit.floorTopY) return 'stone'
    if (y > pit.groundTopY) return 'air'
    return insidePit(x, z) ? 'air' : 'stone'
  }

  const bot = {
    entity: { position: { x: 560.5, y: 61, z: 375.5 } },
    blockAt(vec) {
      if (!vec) return null
      const x = Math.floor(vec.x)
      const y = Math.floor(vec.y)
      const z = Math.floor(vec.z)
      const name = nameAt(x, y, z)
      return { name, position: { x, y, z }, boundingBox: name === 'air' ? 'empty' : 'block' }
    }
  }

  return {
    bot,
    fillColumn(x, z) {
      for (let y = pit.floorTopY + 1; y <= pit.groundTopY; y += 1) filled.add(`${x},${y},${z}`)
    },
    fillWholePit() {
      for (let x = pit.minX; x <= pit.maxX; x += 1) {
        for (let z = pit.minZ; z <= pit.maxZ; z += 1) this.fillColumn(x, z)
      }
    }
  }
}

function createContext(options = {}) {
  const world = createWorld(options)
  const store = {}
  return {
    world,
    bot: world.bot,
    blackboard: {
      get: path => store[path],
      set: (path, value) => { store[path] = value }
    }
  }
}

const ANCHOR = { x: 560, y: 61, z: 375 }
const FOUR_FAILED_RUNGS = ['repath', 'jump_and_step', 'nearby_exit', 'safe_dig']

function remember(ctx, overrides = {}) {
  return rememberTerrainHazard(ctx, {
    position: ANCHOR,
    rungs: FOUR_FAILED_RUNGS,
    now: 1000,
    ...overrides
  })
}

// ── what counts as a hazard ─────────────────────────────────────────────────

async function testHazardCoversTheHoleAndNothingElse() {
  const ctx = createContext()
  const hazard = remember(ctx)
  assert.ok(hazard, 'a four-block pit must be remembered')
  // Exactly the 5x5 shaft: the surrounding ground stands at the rim height and
  // must never be part of the hazard, or she cannot walk the rim.
  assert.strictEqual(hazard.columns.length, 25)
  assert.deepStrictEqual(hazard.bounds, { minX: 558, maxX: 562, minZ: 373, maxZ: 377 })
  assert.strictEqual(hazard.floorY, 61)
  assert.strictEqual(hazard.rimY, 64)
}

async function testOpenGroundIsNotAHazard() {
  const ctx = createContext()
  // Standing on the plateau beside the pit: low ground carries on in every
  // direction, so nothing here is a hole. The real machine recorded exactly
  // this kind of false pit on a slope and then had to path around it.
  assert.strictEqual(rememberTerrainHazard(ctx, {
    position: { x: 540, y: 65, z: 375 },
    rungs: FOUR_FAILED_RUNGS,
    now: 1000
  }), null)
  assert.strictEqual(listTerrainHazards(ctx, { now: 1000 }).length, 0)
}

async function testFloodFillStopsAtTheWalls() {
  const ctx = createContext()
  const fill = floodHoleColumns(ctx.bot, ANCHOR, 64, {})
  assert.strictEqual(fill.bounded, true)
  assert.strictEqual(fill.columns.length, 25)
  assert.ok(fill.columns.every(column => column.x >= 558 && column.x <= 562))
  assert.ok(fill.columns.every(column => column.z >= 373 && column.z <= 377))
}

async function testFloodFillReportsUnboundedLowGround() {
  const ctx = createContext()
  // One block above the rim the shaft stops being a shaft: every column on the
  // plateau qualifies, and the fill runs off the edge of its window.
  const fill = floodHoleColumns(ctx.bot, ANCHOR, 65, {})
  assert.strictEqual(fill.bounded, false)
}

async function testRimIsMeasuredFromTheTerrain() {
  const ctx = createContext()
  const hole = measureHole(ctx.bot, ANCHOR, {})
  assert.strictEqual(hole.rimY, 64, 'the lip is the last height at which the pit still closes')
  assert.strictEqual(hole.columns.length, 25)
  assert.strictEqual(measureHole(ctx.bot, { x: 540, y: 65, z: 375 }, {}), null)
}

async function testFloodFillStillWorksAfterShePluggedHerOwnColumn() {
  const ctx = createContext()
  // By the time a successful escape is recorded, her pillar has filled the
  // very column she jammed in. A solid seed must not abort the fill.
  ctx.world.fillColumn(ANCHOR.x, ANCHOR.z)
  const hazard = remember(ctx)
  assert.ok(hazard)
  assert.strictEqual(hazard.columns.length, 24, 'the plugged column is no longer part of the hole')
  assert.ok(!hazard.columns.includes('560,375'))
}

// ── the cells the planner must refuse ───────────────────────────────────────

async function testFilterCoversTheMouthAndTheFlightPathOverIt() {
  const ctx = createContext()
  remember(ctx)
  const filter = terrainHazardCellFilter(ctx, {
    botPosition: { x: 558.5, y: 65, z: 376.5 },
    destination: { x: 427, y: 64, z: 376 },
    now: 2000
  })
  assert.ok(filter, 'a live hazard away from bot and goal must apply')

  // Inside the hole: walking in and dropping in are both off the table.
  assert.strictEqual(filter({ x: 560, y: 61, z: 375 }), true)
  assert.strictEqual(filter({ x: 560, y: 64, z: 375 }), true)
  // Just above the rim: this is the cell a sprint-jump across the mouth flies
  // through, and it is the only reason round 2 ended back on the pit floor.
  assert.strictEqual(filter({ x: 560, y: 65, z: 375 }), true)
  assert.strictEqual(filter({ x: 560, y: 66, z: 375 }), true)
  // Out of reach of the jump, and the solid rim she has to be able to walk on.
  assert.strictEqual(filter({ x: 560, y: 67, z: 375 }), false)
  assert.strictEqual(filter({ x: 557, y: 65, z: 375 }), false)
  assert.strictEqual(filter({ x: 563, y: 65, z: 375 }), false)
  assert.strictEqual(filter({ x: 560, y: 65, z: 378 }), false)
}

async function testPathfinderStopsSeeingTheMouthAsWalkable() {
  const ctx = createContext()
  remember(ctx)
  const blocks = new Map()
  const movements = {
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
    exclusionAreasStep: [],
    openable: new Set(),
    scafoldingBlocks: [],
    getBlock(pos, dx, dy, dz) {
      const key = `${pos.x + dx},${pos.y + dy},${pos.z + dz}`
      if (!blocks.has(key)) {
        blocks.set(key, { safe: true, position: { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz } })
      }
      return blocks.get(key)
    }
  }
  // She is out of the pit, standing on top of her own escape pillar, heading
  // home — the exact moment round 2 jumped straight back across the mouth.
  ctx.bot.entity.position = { x: 558.5, y: 65, z: 376.5 }
  // Drive the real wrapper against a Movements stub, so the assertion is about
  // our wiring rather than a copy of it.
  avoidKnownTerrainHazards(ctx.bot, movements, ctx, { destination: { x: 427, y: 64, z: 376 }, now: 2000 })

  const overTheMouth = movements.getBlock({ x: 560, y: 65, z: 375 }, 0, 0, 0)
  assert.strictEqual(overTheMouth.safe, false, 'the jump over the mouth must stop being planned')
  const onTheRim = movements.getBlock({ x: 557, y: 65, z: 375 }, 0, 0, 0)
  assert.strictEqual(onTheRim.safe, true, 'walking around the rim must stay free')
}

// ── when the memory must get out of the way ─────────────────────────────────

async function testTheHoleSheIsStandingInIsNeverAvoided() {
  const ctx = createContext()
  remember(ctx)
  const active = activeTerrainHazards(ctx, {
    botPosition: { x: 560.5, y: 61, z: 375.5 },
    now: 2000
  })
  assert.strictEqual(active.length, 0, 'you cannot path around the hole you are in')
  assert.strictEqual(terrainHazardCellFilter(ctx, {
    botPosition: { x: 560.5, y: 61, z: 375.5 },
    now: 2000
  }), null)
}

async function testBeingSentIntoTheHoleOverridesTheMemory() {
  const ctx = createContext()
  remember(ctx)
  // Mining trips and foundation work legitimately end at the bottom of a hole.
  const active = activeTerrainHazards(ctx, {
    botPosition: { x: 540.5, y: 65, z: 375.5 },
    destination: { x: 560, y: 61, z: 375 },
    now: 2000
  })
  assert.strictEqual(active.length, 0)

  const stillAvoided = activeTerrainHazards(ctx, {
    botPosition: { x: 540.5, y: 65, z: 375.5 },
    destination: { x: 427, y: 64, z: 376 },
    now: 2000
  })
  assert.strictEqual(stillAvoided.length, 1)
}

async function testCallersCanOptOutEntirely() {
  const ctx = createContext()
  remember(ctx)
  const movements = { getBlock: () => ({ safe: true, position: { x: 560, y: 65, z: 375 } }) }
  avoidKnownTerrainHazards(ctx.bot, movements, ctx, { avoidKnownHazards: false, now: 2000 })
  assert.strictEqual(movements.getBlock({ x: 560, y: 65, z: 375 }, 0, 0, 0).safe, true)
  assert.strictEqual(movements.__terrainHazards, null)
}

// ── lifecycle ───────────────────────────────────────────────────────────────

async function testHazardExpires() {
  const ctx = createContext()
  remember(ctx)
  assert.strictEqual(listTerrainHazards(ctx, { now: 1000 + DEFAULT_TTL_MS - 1, checkRefill: false }).length, 1)
  assert.strictEqual(listTerrainHazards(ctx, { now: 1000 + DEFAULT_TTL_MS + 1, checkRefill: false }).length, 0)
}

async function testTrappedAgainRefreshesInsteadOfDuplicating() {
  const ctx = createContext()
  remember(ctx)
  const again = remember(ctx, { now: 300000 })
  assert.strictEqual(again.trappedCount, 2)
  assert.strictEqual(again.firstSeenAt, 1000)
  assert.strictEqual(listTerrainHazards(ctx, { now: 300000, checkRefill: false }).length, 1)
  assert.strictEqual(again.expiresAt, 300000 + DEFAULT_TTL_MS)
}

async function testFillingThePitInForgetsIt() {
  const ctx = createContext()
  remember(ctx)
  ctx.world.fillWholePit()
  // Throttled: the check does not re-run within the same window.
  assert.strictEqual(listTerrainHazards(ctx, { now: 2000 }).length, 1)
  assert.strictEqual(listTerrainHazards(ctx, { now: 60000 }).length, 0, 'a filled pit stops being avoided')
}

async function testPartiallyFilledPitIsStillAHazard() {
  const ctx = createContext()
  remember(ctx)
  ctx.world.fillColumn(560, 375)
  ctx.world.fillColumn(561, 375)
  assert.strictEqual(listTerrainHazards(ctx, { now: 60000 }).length, 1)
}

async function testOldestHazardIsEvictedWhenFull() {
  // Ten separate three-wide pits along a line, far enough apart that each one
  // measures as its own enclosed hole.
  const pits = []
  for (let index = 0; index < 10; index += 1) {
    const minX = 520 + index * 20
    pits.push({ minX, maxX: minX + 2, minZ: 374, maxZ: 376 })
  }
  const ctx = createContext({ pits })
  for (let index = 0; index < 10; index += 1) {
    rememberTerrainHazard(ctx, {
      position: { x: 521 + index * 20, y: 61, z: 375 },
      rungs: FOUR_FAILED_RUNGS,
      now: 1000 + index
    })
  }
  const live = listTerrainHazards(ctx, { now: 2000, checkRefill: false })
  assert.strictEqual(live.length, 8)
  assert.ok(!live.some(hazard => hazard.anchor.x === 521), 'the oldest spot is dropped first')
}

async function testClearWipesEverything() {
  const ctx = createContext()
  remember(ctx)
  clearTerrainHazards(ctx)
  assert.strictEqual(listTerrainHazards(ctx, { now: 2000 }).length, 0)
  assert.strictEqual(getTerrainHazardSnapshot(ctx, { now: 2000 }).length, 0)
}

// ── the fallback that keeps avoidance from creating a new trap ──────────────

async function testCorridorTestOnlyFiresForHazardsOnTheWay() {
  const ctx = createContext()
  const hazard = remember(ctx)
  assert.strictEqual(
    hazardsBlockCorridor([hazard], { x: 570, y: 65, z: 375 }, { x: 427, y: 64, z: 376 }),
    true
  )
  assert.strictEqual(
    hazardsBlockCorridor([hazard], { x: 100, y: 65, z: 100 }, { x: 120, y: 65, z: 120 }),
    false,
    'a pit nowhere near the route must not buy a second pathfinding attempt'
  )
  assert.strictEqual(hazardsBlockCorridor([], { x: 570, y: 65, z: 375 }, { x: 427, y: 64, z: 376 }), false)
}

async function testFallbackOnlyFiresWhenSheNeverGotGoing() {
  const ctx = createContext()
  const hazard = remember(ctx)
  const rim = { x: 570, y: 65, z: 375 }
  const home = { x: 427, y: 64, z: 376 }

  // Refused route: the pit is on the way and she is still standing where she
  // started, so re-plan without the avoidance rather than strand her.
  assert.strictEqual(shouldRetryWithoutHazards([hazard], rim, rim, home), true)
  // Plain timeout on a long walk: she covered ground, the route was fine, and
  // a second full timeout would just make every long trip twice as slow.
  assert.strictEqual(
    shouldRetryWithoutHazards([hazard], rim, { x: 520, y: 64, z: 384 }, home),
    false
  )
  assert.strictEqual(shouldRetryWithoutHazards([], rim, rim, home), false)
  assert.strictEqual(shouldRetryWithoutHazards(null, rim, rim, home), false)
}

// ── the ladder writes the memory ────────────────────────────────────────────

function createLadderContext() {
  const ctx = createContext()
  const logs = []
  const position = ctx.bot.entity.position
  ctx.logger = { log: message => logs.push(String(message)) }
  ctx.logs = logs
  ctx.actionLock = {
    acquire: () => ({ ok: true }),
    release: () => ({ ok: true }),
    acquireMany: () => ({ ok: true }),
    releaseMany: () => ({ ok: true }),
    releaseAll: () => ({ ok: true })
  }
  ctx.bot.username = 'LinXia'
  ctx.bot.inventory = { items: () => [] }
  ctx.bot.chat = () => {}
  ctx.bot.setControlState = () => {}
  ctx.bot.clearControlStates = () => {}
  ctx.bot.pathfinder = {
    goal: null,
    setMovements() {},
    setGoal(goal) { this.goal = goal },
    stop() { this.goal = null }
  }
  ctx.lift = y => { position.y = y }
  return ctx
}

async function testClimbingOutRecordsTheSpotItClimbedOutOf() {
  const ctx = createLadderContext()
  const state = createRecoveryState()
  state.isStuck = true
  state.stuckReason = 'in_hole_or_low_ground'
  const result = await runStuckRecovery(ctx, state, { x: 427, y: 64, z: 376 }, 1, {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 5
  })
  assert.strictEqual(result.ok, true, 'the ladder gets her out after escalating')
  assert.ok(ctx.logs.some(line => line.includes('[ESCAPE_RUNG_SUCCESS]')))
  assert.ok(
    ctx.logs.some(line => line.includes('[TERRAIN_HAZARD_RECORDED]')),
    'the spot she just had to be rescued from is exactly what must be remembered'
  )
  const snapshot = getTerrainHazardSnapshot(ctx)
  assert.strictEqual(snapshot.length, 1)
  assert.deepStrictEqual(snapshot[0].anchor, { x: 560, y: 61, z: 375 })
  assert.strictEqual(snapshot[0].rimY, 64)
  assert.strictEqual(snapshot[0].reason, 'escape_ladder')
}

async function testGivingUpRecordsTheSpotToo() {
  const ctx = createLadderContext()
  const state = createRecoveryState()
  state.isStuck = true
  state.stuckReason = 'in_hole_or_low_ground'
  // Only two rungs on the ladder, neither of which can work here, so the pass
  // ends in a give-up with no measured exit height at all.
  const result = await runStuckRecovery(ctx, state, { x: 427, y: 64, z: 376 }, 1, {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 5,
    rungs: ['repath', 'jump_and_step', 'safe_posture'],
    hazardMinFailedRungs: 2
  })
  assert.strictEqual(result.ok, false)
  assert.ok(ctx.logs.some(line => line.includes('[ESCAPE_GAVE_UP]')))
  const snapshot = getTerrainHazardSnapshot(ctx)
  assert.strictEqual(snapshot.length, 1)
  assert.strictEqual(snapshot[0].rimY, 64, 'the rim comes from the terrain, not from how she got out')
}

async function testAnEasyEscapeDoesNotBlacklistTheGround() {
  const ctx = createLadderContext()
  const state = createRecoveryState()
  state.isStuck = true
  // A rung or two failing is not evidence of dangerous terrain; only a spot
  // that beat several of them earns a detour.
  await runStuckRecovery(ctx, state, { x: 427, y: 64, z: 376 }, 1, {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 5,
    hazardMinFailedRungs: 99
  })
  assert.strictEqual(getTerrainHazardSnapshot(ctx).length, 0)
  assert.ok(!ctx.logs.some(line => line.includes('[TERRAIN_HAZARD_RECORDED]')))
}

async function run() {
  await testHazardCoversTheHoleAndNothingElse()
  await testOpenGroundIsNotAHazard()
  await testFloodFillStopsAtTheWalls()
  await testFloodFillReportsUnboundedLowGround()
  await testRimIsMeasuredFromTheTerrain()
  await testFloodFillStillWorksAfterShePluggedHerOwnColumn()
  await testFilterCoversTheMouthAndTheFlightPathOverIt()
  await testPathfinderStopsSeeingTheMouthAsWalkable()
  await testTheHoleSheIsStandingInIsNeverAvoided()
  await testBeingSentIntoTheHoleOverridesTheMemory()
  await testCallersCanOptOutEntirely()
  await testHazardExpires()
  await testTrappedAgainRefreshesInsteadOfDuplicating()
  await testFillingThePitInForgetsIt()
  await testPartiallyFilledPitIsStillAHazard()
  await testOldestHazardIsEvictedWhenFull()
  await testClearWipesEverything()
  await testCorridorTestOnlyFiresForHazardsOnTheWay()
  await testFallbackOnlyFiresWhenSheNeverGotGoing()
  await testClimbingOutRecordsTheSpotItClimbedOutOf()
  await testGivingUpRecordsTheSpotToo()
  await testAnEasyEscapeDoesNotBlacklistTheGround()
  console.log('terrain-hazards tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
