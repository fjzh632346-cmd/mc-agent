// Round 6 (repair lane): getting out from under a lid.
//
// The building lane's round-6 "east ditch" is not a ditch. Round 7 identified
// it as a roofed cavity — two blocks of clearance with a one-block shell over
// it — and round 5 of this lane proved on the real server that the whole escape
// ladder dies in one: repath finds no safe point, jump_and_step gains nothing,
// nearby_exit times out, safe_dig chews sideways into the wall and only makes
// the cavity bigger, and pillar_up — the one rung that can actually lift her —
// fails on `pillar_jump_did_not_clear` because her head hits the ceiling before
// she clears the cell she is trying to fill. The control run in that same round
// took the lid off the same cavity and she was out in three lifts.
//
// So pillar_up now takes the lid out first. The cases below pin both halves:
// that it works under a roof, and that an open-topped pit is bit-for-bit the
// climb it always was.
const assert = require('assert')
const {
  attemptPillarUp,
  clearHeadroomForLift
} = require('../tasks/stuck-recovery')

const AIR = new Set(['air', 'cave_air', 'void_air'])

// A roofed cavity: solid rock to `floorY`, two blocks of air above it, then a
// lid `lidThickness` courses thick, and whatever `aboveLid` says on top of that.
//
// The jump model is the point of this fixture. A stub that always lets the bot
// rise would let every case below pass without the fix, so jumping here checks
// the cell her head rises into, exactly like the server does.
function createRoofedCavity(options = {}) {
  const floorY = options.floorY ?? 61
  const lidY = options.lidY ?? 64
  const lidThickness = options.lidThickness ?? 1
  const lidBlock = options.lidBlock ?? 'stone'
  const aboveLid = options.aboveLid ?? 'air'
  const lidTop = lidY + lidThickness - 1
  const minX = options.minX ?? 613
  const maxX = options.maxX ?? 617
  const minZ = options.minZ ?? 398
  const maxZ = options.maxZ ?? 402

  const placed = []
  const dug = []
  const controls = []
  const position = { x: options.startX ?? 615.5, y: floorY + 1, z: options.startZ ?? 400.5 }
  let groundY = floorY + 1

  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const insideCavity = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ

  // One mutable world, not two lists: a cell that was dug and then pillared
  // back over has to read as the block that is there NOW, or the climb loses
  // its own footing on the way up.
  const edited = new Map()
  const blockNameAt = (x, y, z) => {
    const k = key(x, y, z)
    if (edited.has(k)) return edited.get(k)
    const fy = Math.floor(y)
    if (fy <= floorY) return 'stone'
    if (fy >= lidY && fy <= lidTop) return lidBlock
    if (fy === lidTop + 1) return aboveLid
    if (fy > lidTop + 1) return 'air'
    // between the floor and the lid: hollow inside the cavity, rock outside
    return insideCavity(Math.floor(x), Math.floor(z)) ? 'air' : 'stone'
  }

  const bot = {
    entity: { position },
    username: 'LinXia',
    inventory: { items: () => options.items || [{ name: 'dirt', count: 32 }] },
    blockAt(vec) {
      if (!vec) return null
      if (options.unknownAt && options.unknownAt(vec)) return null
      const name = blockNameAt(vec.x, vec.y, vec.z)
      return {
        name,
        diggable: name !== 'bedrock',
        position: { x: Math.floor(vec.x), y: Math.floor(vec.y), z: Math.floor(vec.z) }
      }
    },
    async dig(block) {
      if (options.digThrows) throw new Error(options.digThrows)
      // A dig that reports success without changing anything is a real failure
      // mode; `digIsALie` lets a case exercise the read-back that catches it.
      if (options.digIsALie) return
      const k = key(block.position.x, block.position.y, block.position.z)
      dug.push(k)
      edited.set(k, 'air')
    },
    setControlState(name, value) {
      controls.push({ name, value })
      if (name !== 'jump') return
      if (!value) { position.y = groundY; return }
      // She only leaves the ground if there is somewhere for her head to go.
      if (!AIR.has(blockNameAt(position.x, groundY + 2, position.z))) return
      position.y = groundY + 0.6
    },
    clearControlStates() {},
    chat() {},
    async equip() { return true },
    async lookAt() { return true },
    async placeBlock(reference, face) {
      const target = {
        x: reference.position.x + (face.x || 0),
        y: reference.position.y + (face.y || 0),
        z: reference.position.z + (face.z || 0)
      }
      placed.push(target)
      edited.set(key(target.x, target.y, target.z), 'dirt')
      groundY += 1
      position.y = groundY
      return true
    },
    pathfinder: {
      goal: null,
      setMovements() {},
      setGoal(goal) {
        this.goal = goal
        if (!goal) return
        const gx = goal.x ?? goal.pos?.x
        const gy = goal.y ?? goal.pos?.y
        const gz = goal.z ?? goal.pos?.z
        if (!Number.isFinite(gx) || !Number.isFinite(gz)) return
        if (Number.isFinite(gy) && Math.abs(gy - position.y) > 1) return
        position.x = gx + 0.5
        position.z = gz + 0.5
        if (Number.isFinite(gy)) { position.y = gy; groundY = gy }
      },
      stop() { this.goal = null }
    },
    once(event, callback) { callback() },
    removeListener() {}
  }

  const store = {}
  const logs = []
  return {
    bot,
    placed,
    dug,
    controls,
    logs,
    floorY,
    lidY,
    blackboard: { get: path => store[path], set: (path, value) => { store[path] = value } },
    logger: { log: msg => { logs.push(String(msg)); if (process.env.DBG) console.log('LOG', msg) } },
    actionLock: {
      acquire: () => ({ ok: true }),
      release: () => ({ ok: true }),
      acquireMany: () => ({ ok: true }),
      releaseMany: () => ({ ok: true }),
      releaseAll: () => ({ ok: true })
    }
  }
}

const FAST = { pillarSettleMs: 1, pillarJumpTimeoutMs: 30, maxPillarLifts: 5 }

function feetOf(ctx) {
  return { x: Math.floor(ctx.bot.entity.position.x), y: Math.floor(ctx.bot.entity.position.y), z: Math.floor(ctx.bot.entity.position.z) }
}

// ── the rung under a lid ────────────────────────────────────────────────────

async function testCeilingIsDugWhenItBlocksTheJump() {
  const ctx = createRoofedCavity()
  const budget = {}

  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, budget)

  assert.strictEqual(result.cleared, true, result.reason)
  assert.strictEqual(result.reason, 'ceiling_dug')
  assert.deepStrictEqual(ctx.dug, ['615,64,400'], 'the course her head rises into, and only that one')
  assert.strictEqual(budget.dug, 1)
  assert.ok(ctx.logs.some(m => m.includes('[ESCAPE_CEILING_DIG]') && m.includes('result=cleared')))
}

// End to end: the exact shape that beat the ladder on the real server.
async function testPillarUpEscapesARoofedCavity() {
  const ctx = createRoofedCavity()
  const startY = ctx.bot.entity.position.y

  const result = await attemptPillarUp(ctx, {}, { x: 600, y: 65, z: 400 }, 'test', FAST)

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.action, 'pillar_up')
  assert.ok(ctx.bot.entity.position.y > startY, 'she has to end up higher than the cavity floor')
  assert.ok(ctx.bot.entity.position.y >= ctx.lidY + 1, 'and above the lid, not just under it')
  assert.deepStrictEqual(ctx.dug, ['615,64,400'], 'one course of lid, no tunnelling')
  assert.ok(ctx.placed.length >= 2)
}

// A two-course lid costs two digs, from one budget across the whole climb.
async function testThickLidIsDugOneCoursePerLift() {
  const ctx = createRoofedCavity({ lidThickness: 2 })

  const result = await attemptPillarUp(ctx, {}, { x: 600, y: 66, z: 400 }, 'test', FAST)

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(ctx.dug, ['615,64,400', '615,65,400'])
}

// ── the refusals ────────────────────────────────────────────────────────────

// Water or lava sitting on the lid would pour in the moment it opens. isDigSafe
// already scans a block out in every direction, which is why this is a reuse
// and not a new rule.
async function testLidWithWaterOnTopIsNotDug() {
  const ctx = createRoofedCavity({ aboveLid: 'water' })
  const budget = {}

  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, budget)

  assert.strictEqual(result.cleared, false)
  assert.ok(result.reason.startsWith('water_above_ceiling'), result.reason)
  assert.deepStrictEqual(ctx.dug, [], 'she must not open a hole under a pond')
  assert.strictEqual(budget.dug ?? 0, 0)
  assert.ok(ctx.logs.some(m => m.includes('[ESCAPE_CEILING_DIG]') && m.includes('result=refused')))
}

async function testLidWithLavaOnTopIsNotDug() {
  const ctx = createRoofedCavity({ aboveLid: 'lava' })
  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, {})
  assert.strictEqual(result.cleared, false)
  assert.ok(result.reason.startsWith('lava_above_ceiling'), result.reason)
  assert.deepStrictEqual(ctx.dug, [])
}

async function testLidThatIsItselfFluidIsNotDug() {
  const ctx = createRoofedCavity({ lidBlock: 'lava' })
  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, {})
  assert.strictEqual(result.cleared, false)
  assert.ok(result.reason.startsWith('fluid_or_danger_ceiling'), result.reason)
  assert.deepStrictEqual(ctx.dug, [])
}

async function testBedrockLidIsNotDug() {
  const ctx = createRoofedCavity({ lidBlock: 'bedrock' })
  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, {})
  assert.strictEqual(result.cleared, false)
  assert.strictEqual(result.reason, 'undiggable:bedrock')
  assert.deepStrictEqual(ctx.dug, [])
  assert.ok(ctx.logs.some(m => m.includes('reason=undiggable')))
}

// The whole climb gets a small allowance. Past it the shape is a cave system,
// not a trap, and tunnelling upward forever is its own way to die.
async function testBudgetCapsHowMuchLidSheWillTakeOut() {
  const ctx = createRoofedCavity({ lidThickness: 4 })

  const result = await attemptPillarUp(ctx, {}, { x: 600, y: 68, z: 400 }, 'test', { ...FAST, maxPillarLifts: 8 })

  assert.strictEqual(ctx.dug.length, 3, 'three courses, then it stops asking')
  assert.ok(ctx.logs.some(m => m.includes('reason=budget_exhausted')))
  // Three lifts of real progress happened before the budget ran out, so the
  // rung reports what it achieved rather than pretending it failed outright.
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.data.placed, 3)
}

async function testDigThatDoesNotActuallyClearIsCaught() {
  const ctx = createRoofedCavity({ digIsALie: true })
  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, {})
  assert.strictEqual(result.cleared, false)
  assert.ok(result.reason.startsWith('ceiling_still_blocked:'), result.reason)
}

async function testDigFailureIsReportedNotSwallowed() {
  const ctx = createRoofedCavity({ digThrows: 'dig_interrupted' })
  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, {})
  assert.strictEqual(result.cleared, false)
  assert.ok(result.reason.startsWith('ceiling_dig_failed:'), result.reason)
  assert.ok(ctx.logs.some(m => m.includes('result=dig_failed')))
}

// ── the "no change" half ────────────────────────────────────────────────────

// An open-topped pit is the round-2/3 shape, and it must climb exactly as it
// did before any of this existed: no dig, no log, no decision.
async function testOpenSkyPitIsUntouched() {
  const ctx = createRoofedCavity({ lidY: 200 })
  const startY = ctx.bot.entity.position.y

  const result = await attemptPillarUp(ctx, {}, { x: 600, y: 65, z: 400 }, 'test', FAST)

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(ctx.bot.entity.position.y > startY)
  assert.deepStrictEqual(ctx.dug, [], 'nothing to clear means nothing is cleared')
  assert.ok(!ctx.logs.some(m => m.includes('[ESCAPE_CEILING_DIG]')), 'and nothing to say about it')
}

// An unloaded column reads as null. Round 5 set the rule and it holds here:
// never act on a block nobody has looked at — leave it to the jump, the way it
// always was.
async function testUnknownCeilingIsLeftAlone() {
  const ctx = createRoofedCavity({ unknownAt: vec => Math.floor(vec.y) === 64 })
  const budget = {}

  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', {}, budget)

  assert.strictEqual(result.cleared, true)
  assert.strictEqual(result.reason, 'ceiling_unknown')
  assert.deepStrictEqual(ctx.dug, [])
  assert.strictEqual(budget.dug ?? 0, 0)
}

// A caller that must not terraform can switch it off by name, and then the rung
// behaves exactly as it did in round 5 — including failing under a lid.
async function testCeilingDigCanBeDisabled() {
  const ctx = createRoofedCavity()

  const cleared = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', { allowCeilingDig: false }, {})
  assert.strictEqual(cleared.cleared, true)
  assert.strictEqual(cleared.reason, 'ceiling_dig_disabled')
  assert.deepStrictEqual(ctx.dug, [])

  const result = await attemptPillarUp(ctx, {}, { x: 600, y: 65, z: 400 }, 'test', {
    ...FAST,
    allowCeilingDig: false
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'pillar_jump_did_not_clear', 'the round-5 failure, unchanged')
}

// The lid of a finished building is a roof, not an obstacle.
async function testProtectedBuildingRoofIsNeverDug() {
  const ctx = createRoofedCavity()
  const regions = [{
    runId: 'construction_run_villa',
    blueprintId: 'villa',
    bounds: { minX: 610, maxX: 620, minY: 60, maxY: 70, minZ: 395, maxZ: 405 }
  }]

  const result = await clearHeadroomForLift(ctx, feetOf(ctx), 'test', { regions }, {})

  assert.strictEqual(result.cleared, false)
  assert.ok(result.reason.startsWith('protected_building:'), result.reason)
  assert.deepStrictEqual(ctx.dug, [], 'a finished roof is a roof, not an obstacle')
  assert.ok(ctx.logs.some(m => m.includes('reason=protected_building')))
}

// ── source guard ────────────────────────────────────────────────────────────

// The clear has to happen BEFORE the jump it exists to enable. If a later edit
// moves it after placeUnderfoot the suite above would still pass on the fixture
// while doing nothing at all on a real server.
function testHeadroomIsClearedBeforeThePlace() {
  const source = require('fs').readFileSync(require.resolve('../tasks/stuck-recovery.js'), 'utf8')
  const clearIndex = source.indexOf('await clearHeadroomForLift(')
  const placeIndex = source.indexOf('await placeUnderfoot(')
  assert.ok(clearIndex > -1, 'pillar_up must clear its headroom')
  assert.ok(placeIndex > -1)
  assert.ok(clearIndex < placeIndex, 'headroom must be cleared before the jump-and-place')
  assert.ok(
    source.includes('isDigSafe(ctx, block, options)'),
    'the fluid/protected decision must stay delegated to isDigSafe, not re-implemented'
  )
}

async function run() {
  await testCeilingIsDugWhenItBlocksTheJump()
  await testPillarUpEscapesARoofedCavity()
  await testThickLidIsDugOneCoursePerLift()
  await testLidWithWaterOnTopIsNotDug()
  await testLidWithLavaOnTopIsNotDug()
  await testLidThatIsItselfFluidIsNotDug()
  await testBedrockLidIsNotDug()
  await testBudgetCapsHowMuchLidSheWillTakeOut()
  await testDigThatDoesNotActuallyClearIsCaught()
  await testDigFailureIsReportedNotSwallowed()
  await testOpenSkyPitIsUntouched()
  await testUnknownCeilingIsLeftAlone()
  await testCeilingDigCanBeDisabled()
  await testProtectedBuildingRoofIsNeverDug()
  testHeadroomIsClearedBeforeThePlace()
  console.log('escape-ceiling-dig tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
