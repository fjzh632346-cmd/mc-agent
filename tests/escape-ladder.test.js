const assert = require('assert')

const {
  DEFAULT_RUNGS,
  backoffFor,
  createLedger,
  getEscapeLedgerSnapshot,
  hasEscapedAnchor,
  loadLedger,
  measureEscapeProgress,
  noteEscapeSuccess,
  noteRungFailure,
  planEscapeAttempt,
  resetEscapeLedger
} = require('../tasks/escape-ladder')

const { ActionLock } = require('../core/action-lock')

const {
  attemptPillarUp,
  attemptSafePosture,
  createRecoveryState,
  findPillarItem,
  runStuckRecovery
} = require('../tasks/stuck-recovery')

// A pit whose walls are two blocks away from the centre: nothing within arm's
// reach to dig, rim visible but unreachable by pathfinding. This is the shape
// that killed the bot in round 5.
function createPitContext(options = {}) {
  const floorY = options.floorY ?? 60
  const rimY = options.rimY ?? 70
  const minX = options.minX ?? 558
  const maxX = options.maxX ?? 562
  const minZ = options.minZ ?? 373
  const maxZ = options.maxZ ?? 377
  const placed = []
  const chats = []
  const controls = []
  const position = { x: options.startX ?? 560.5, y: floorY + 1, z: options.startZ ?? 375.5 }
  let groundY = floorY + 1

  const insidePit = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ
  const blockNameAt = (x, y, z) => {
    const fx = Math.floor(x)
    const fy = Math.floor(y)
    const fz = Math.floor(z)
    if (placed.some(p => p.x === fx && p.y === fy && p.z === fz)) return 'dirt'
    if (fy <= floorY) return 'stone'
    if (fy > rimY) return 'air'
    return insidePit(fx, fz) ? 'air' : 'stone'
  }

  const bot = {
    entity: { position },
    username: 'LinXia',
    inventory: { items: () => options.items || [{ name: 'dirt', count: 32 }] },
    blockAt(vec) {
      if (!vec) return null
      const name = blockNameAt(vec.x, vec.y, vec.z)
      return { name, position: { x: Math.floor(vec.x), y: Math.floor(vec.y), z: Math.floor(vec.z) } }
    },
    setControlState(name, value) {
      controls.push({ name, value })
      // Model the jump: pillaring only works because the body clears the cell
      // it is about to fill, and the code now waits for exactly that.
      if (name === 'jump') position.y = value ? groundY + 0.6 : groundY
    },
    clearControlStates() { controls.push({ clear: true }) },
    chat(message) { chats.push(message) },
    async equip() { return true },
    async lookAt() { return true },
    async placeBlock(reference, face) {
      const target = {
        x: reference.position.x + (face.x || 0),
        y: reference.position.y + (face.y || 0),
        z: reference.position.z + (face.z || 0)
      }
      placed.push(target)
      // Placing under the feet lifts the bot one block, as in the real game.
      groundY += 1
      position.y = groundY
      return true
    },
    // Unlike a bare stub, this pathfinder actually relocates the bot when it
    // reaches a goal — otherwise "did that attempt help?" cannot be judged at
    // all, which is precisely the question this suite exists to answer.
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
        // Only reachable if it is walkable ground at (or one step from) our
        // level; a pit rim four blocks up is visible but not reachable.
        if (Number.isFinite(gy) && Math.abs(gy - position.y) > 1) return
        position.x = gx + 0.5
        position.z = gz + 0.5
        if (Number.isFinite(gy)) {
          position.y = gy
          groundY = gy
        }
      },
      stop() { this.goal = null }
    },
    once(event, callback) { callback() },
    removeListener() {}
  }

  const logs = []
  return {
    bot,
    placed,
    chats,
    controls,
    logs,
    blackboard: createBlackboard(),
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

function createBlackboard() {
  const store = {}
  return {
    get: path => store[path],
    set: (path, value) => { store[path] = value }
  }
}

// ── ledger bookkeeping ──────────────────────────────────────────────────────

async function testLedgerSurvivesTaskRecreation() {
  const ctx = createPitContext()
  const position = { x: 560.5, y: 61, z: 375.5 }

  const first = planEscapeAttempt(ctx, 'return_to_base', position, { now: 1000 })
  assert.strictEqual(first.rung, 'repath')
  noteRungFailure(ctx, 'return_to_base', 'repath', 'no_safe_player_point', { now: 1000 })

  // A brand-new task object would build a brand-new recovery state; the ledger
  // is what has to remember. Next plan must NOT start at rung 0 again.
  const second = planEscapeAttempt(ctx, 'return_to_base', position, { now: 20000 })
  assert.strictEqual(second.rung, 'jump_and_step')
  assert.deepStrictEqual(second.ledger.exhausted, ['repath'])
}

async function testEachFailureRetiresARungUntilGiveUp() {
  const ctx = createPitContext()
  const position = { x: 560.5, y: 61, z: 375.5 }
  let now = 1000
  for (const rung of DEFAULT_RUNGS) {
    const plan = planEscapeAttempt(ctx, 'return_to_base', position, { now })
    assert.strictEqual(plan.rung, rung, `expected ${rung}, got ${plan.rung}`)
    noteRungFailure(ctx, 'return_to_base', rung, `${rung}_failed`, { now })
    now += 120000
  }
  const exhausted = planEscapeAttempt(ctx, 'return_to_base', position, { now })
  assert.strictEqual(exhausted.giveUp, true)
  assert.strictEqual(exhausted.rung, 'safe_posture')
}

async function testBackoffGrowsWithConsecutiveFailures() {
  assert.strictEqual(backoffFor(1), 0)
  assert.strictEqual(backoffFor(2), 5000)
  assert.strictEqual(backoffFor(3), 15000)
  assert.strictEqual(backoffFor(4), 30000)
  assert.strictEqual(backoffFor(5), 60000)
  // Capped, not unbounded.
  assert.strictEqual(backoffFor(50), 60000)
}

async function testBackoffWindowHoldsInsteadOfRetrying() {
  const ctx = createPitContext()
  const position = { x: 560.5, y: 61, z: 375.5 }
  noteRungFailure(ctx, 'return_to_base', 'repath', 'x', { now: 1000 })
  noteRungFailure(ctx, 'return_to_base', 'jump_and_step', 'x', { now: 1000 })

  const during = planEscapeAttempt(ctx, 'return_to_base', position, { now: 2000 })
  assert.strictEqual(during.rung, null)
  assert.ok(during.waitMs > 0, 'should report remaining wait')

  const after = planEscapeAttempt(ctx, 'return_to_base', position, { now: 1000 + 5000 + 1 })
  assert.strictEqual(after.rung, 'nearby_exit')
}

async function testSuccessClearsTheLedger() {
  const ctx = createPitContext()
  const position = { x: 560.5, y: 61, z: 375.5 }
  noteRungFailure(ctx, 'return_to_base', 'repath', 'x', { now: 1000 })
  noteEscapeSuccess(ctx, 'return_to_base', { rung: 'pillar_up' })
  const snapshot = getEscapeLedgerSnapshot(ctx, 'return_to_base')
  assert.deepStrictEqual(snapshot.exhausted, [])
  assert.strictEqual(snapshot.consecutiveFailures, 0)
  assert.strictEqual(snapshot.escapes, 1)
  const plan = planEscapeAttempt(ctx, 'return_to_base', position, { now: 90000 })
  assert.strictEqual(plan.rung, 'repath')
}

async function testLedgerResetsOnceTheBotLeavesTheAnchor() {
  const ctx = createPitContext()
  const anchor = { x: 560.5, y: 61, z: 375.5 }
  planEscapeAttempt(ctx, 'return_to_base', anchor, { now: 1000 })
  noteRungFailure(ctx, 'return_to_base', 'repath', 'x', { now: 1000 })

  // Bot climbed out: a stale "already tried that" must not strand it elsewhere.
  const escaped = planEscapeAttempt(ctx, 'return_to_base', { x: 560.5, y: 71, z: 375.5 }, { now: 200000 })
  assert.strictEqual(escaped.reset, true)
  assert.strictEqual(escaped.rung, 'repath')
}

async function testProgressIsMeasuredAgainstTheAnchorNotTheStep() {
  const anchor = { x: 560.5, y: 61, z: 375.5 }
  // The round-5 false success: a 2-block sidestep inside the same pit.
  const shuffled = measureEscapeProgress(anchor, { x: 558.5, y: 61, z: 376.5 })
  assert.strictEqual(shuffled.improved, false)
  assert.strictEqual(shuffled.reason, 'still_at_anchor')

  // Actually climbing out counts.
  const climbed = measureEscapeProgress(anchor, { x: 560.5, y: 63, z: 375.5 })
  assert.strictEqual(climbed.improved, true)

  const walkedOut = measureEscapeProgress(anchor, { x: 570.5, y: 61, z: 375.5 })
  assert.strictEqual(walkedOut.improved, true)

  assert.strictEqual(hasEscapedAnchor({ anchor }, { x: 560.5, y: 61, z: 375.5 }), false)
  assert.strictEqual(hasEscapedAnchor({ anchor }, { x: 560.5, y: 64, z: 375.5 }), true)
}

// ── the new rungs ───────────────────────────────────────────────────────────

async function testPillarUpLiftsTheBotOutOfThePit() {
  const ctx = createPitContext()
  const state = createRecoveryState()
  const startY = ctx.bot.entity.position.y

  const result = await attemptPillarUp(ctx, state, { x: 427, y: 64, z: 376 }, 1, {
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    maxPillarLifts: 4
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.action, 'pillar_up')
  assert.ok(result.data.placed >= 1, 'should have placed at least one block')
  assert.ok(ctx.bot.entity.position.y > startY, 'bot should be higher than it started')
  assert.ok(ctx.placed.length >= 1)
}

async function testPillarUpRefusesWithoutMaterial() {
  const ctx = createPitContext({ items: [{ name: 'diamond_sword', count: 1 }] })
  const state = createRecoveryState()
  const result = await attemptPillarUp(ctx, state, { x: 427, y: 64, z: 376 }, 1, {
    pillarJumpMs: 1,
    pillarSettleMs: 1
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'no_pillar_material')
  assert.strictEqual(ctx.placed.length, 0)
}

async function testPillarUpNeverBuildsInsideAProtectedBuilding() {
  const ctx = createPitContext()
  const state = createRecoveryState()
  const result = await attemptPillarUp(ctx, state, { x: 427, y: 64, z: 376 }, 1, {
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    regions: [{
      runId: 'construction_run_test',
      blueprintId: 'villa',
      bounds: { minX: 550, maxX: 570, minY: 55, maxY: 90, minZ: 365, maxZ: 385 }
    }]
  })
  assert.strictEqual(result.ok, false)
  assert.ok(String(result.error).startsWith('pillar_protected_building:'), result.error)
  assert.strictEqual(ctx.placed.length, 0, 'must not place a single block inside a protected build')
}

async function testPillarUpPrefersExpendableBlocks() {
  const ctx = createPitContext({ items: [{ name: 'diamond_block', count: 4 }, { name: 'cobblestone', count: 8 }] })
  assert.strictEqual(findPillarItem(ctx).name, 'cobblestone')
}

async function testSafePostureStopsMovingAndAsksForHelp() {
  const ctx = createPitContext()
  const state = createRecoveryState()
  state.lastFailureReason = 'no_safe_block_to_dig'

  const result = await attemptSafePosture(ctx, state, { x: 427, y: 64, z: 376 }, 1, {})

  assert.strictEqual(result.ok, true)
  assert.strictEqual(state.lastRecoveryAction, 'safe_posture')
  assert.ok(ctx.controls.some(entry => entry.name === 'forward' && entry.value === false))
  assert.ok(ctx.controls.some(entry => entry.name === 'jump' && entry.value === false))
  assert.ok(ctx.chats.some(message => message.includes('卡在')), ctx.chats.join('|'))
}

async function testSafePostureStaysQuietDuringBackoff() {
  const ctx = createPitContext()
  const state = createRecoveryState()
  await attemptSafePosture(ctx, state, { x: 427, y: 64, z: 376 }, 1, { quiet: true })
  assert.strictEqual(ctx.chats.length, 0, 'backoff holds must not spam chat every cycle')
}

// ── end to end through runStuckRecovery ─────────────────────────────────────

async function testRecoveryEscalatesToPillarUpInsteadOfLoopingForever() {
  const ctx = createPitContext()
  const target = { x: 427, y: 64, z: 376 }
  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    maxPillarLifts: 12,
    backoffMs: [0],
    chatFeedback: false
  }

  const state = createRecoveryState()
  const result = await runStuckRecovery(ctx, state, target, 1, options)

  assert.ok(result.ok, `expected an escape, got ${result && result.error}`)
  assert.strictEqual(result.action, 'pillar_up', 'the pit is only escapable by pillaring out')
  assert.ok(ctx.placed.length >= 1, 'pillar_up should have placed blocks')
  assert.ok(ctx.bot.entity.position.y > 61, 'bot should end up above the pit floor')

  // It must have walked DOWN the ladder to get there. In particular the
  // sidestep rung has to be recorded as a failure: before this fix it reported
  // success for shuffling two blocks inside the same pit, which reset the stuck
  // state and made the higher rungs unreachable forever.
  const noProgress = ctx.logs.filter(line => line.includes('[ESCAPE_RUNG_NO_PROGRESS]'))
  assert.ok(
    noProgress.some(line => line.includes('rung=jump_and_step')),
    `sidestep should be recorded as no-progress: ${ctx.logs.join('\n')}`
  )
}

// With pillaring unavailable the pit is genuinely inescapable, so the ladder
// has to climb across separately re-created tasks rather than replaying rung 0.
// Round 15 (repair lane): an interrupt that lands INSIDE the ladder stops it
// there. Building round 22: a retreat home was cancelled by the next build
// order while nearby_exit was still walking; the ladder went on through
// safe_dig and pillar_up, and every rung took the movement lock back under a
// task nobody would ever release it for. The eight build orders that followed
// all died on lock_already_held.
async function testInterruptInsideTheLadderStopsItAndLeavesTheLockFree() {
  const ctx = createPitContext()
  const actionLock = new ActionLock()
  ctx.actionLock = actionLock

  const task = { id: 2, state: 'RUNNING' }
  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    backoffMs: [0],
    chatFeedback: false,
    shouldContinue: () => task.state === 'RUNNING'
  }

  // She is walking home, holding movement (moveTo holdLock:true).
  assert.strictEqual(actionLock.acquire('movement', task.id).ok, true)

  // The build order lands while a rung is mid-walk. This is exactly what
  // BaseTask.interrupt does: terminal state, release, seal.
  let logsAtInterrupt = null
  const setGoal = ctx.bot.pathfinder.setGoal.bind(ctx.bot.pathfinder)
  ctx.bot.pathfinder.setGoal = goal => {
    if (goal && logsAtInterrupt == null) {
      logsAtInterrupt = ctx.logs.length
      task.state = 'INTERRUPTED'
      actionLock.releaseAll(task.id)
      actionLock.markOwnerTerminated(task.id, 'interrupted:player_build_command')
    }
    return setGoal(goal)
  }

  const state = createRecoveryState()
  const result = await runStuckRecovery(ctx, state, { x: 427, y: 64, z: 376 }, task.id, options)

  assert.ok(logsAtInterrupt != null, 'the fixture never reached a walking rung')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'escape_abandoned')

  const abandoned = ctx.logs.find(line => line.includes('[ESCAPE_ABANDONED]'))
  assert.ok(abandoned && abandoned.includes('taskId=2'), ctx.logs.join(String.fromCharCode(10)))

  const after = ctx.logs.slice(logsAtInterrupt)
  const rungVerdicts = after.filter(line => line.includes('[ESCAPE_RUNG_'))
  assert.deepStrictEqual(rungVerdicts, [], `no rung verdicts after the cancel: ${after.join(' | ')}`)
  assert.strictEqual(ctx.placed.length, 0, 'no pillar built for a task nobody wants')

  // A rung that was cut off is not evidence that it is useless here.
  const abandonedRung = /rung=([a-z_]+)/.exec(abandoned)[1]
  const ledger = getEscapeLedgerSnapshot(ctx, 'return_to_base')
  assert.ok(!ledger.exhausted.includes(abandonedRung), `${abandonedRung} must not be written off: ${ledger.exhausted.join('|')}`)

  // And the lock is free for the build order that caused all this.
  assert.strictEqual(actionLock.getOwner('movement'), null)
  assert.strictEqual(actionLock.acquireMany(['movement', 'inventory', 'building'], 4).ok, true)
}

async function testEscalationAdvancesAcrossRecreatedTasks() {
  const ctx = createPitContext()
  const target = { x: 427, y: 64, z: 376 }
  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    allowDig: false,
    allowPillar: false,
    backoffMs: [0],
    chatFeedback: false
  }

  const rungsSeen = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = createRecoveryState()
    await runStuckRecovery(ctx, state, target, attempt + 1, options)
    rungsSeen.push(state.escapeRung)
  }

  assert.strictEqual(rungsSeen[0], 'repath')
  // Round 5's signature was every single attempt logging attempts=1 / rung 0.
  assert.ok(new Set(rungsSeen).size > 1, `ladder never escalated: ${rungsSeen.join('|')}`)
  assert.ok(!rungsSeen.every(rung => rung === 'repath'), 'every attempt restarted at rung 0')
}

async function testRecoveryGivesUpSafelyWhenEveryRungIsImpossible() {
  const ctx = createPitContext({ items: [] })
  const target = { x: 427, y: 64, z: 376 }
  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    allowDig: false,
    allowPillar: false,
    backoffMs: [0],
    chatFeedback: false
  }

  let gaveUp = false
  for (let attempt = 0; attempt < DEFAULT_RUNGS.length + 2; attempt += 1) {
    const state = createRecoveryState()
    const result = await runStuckRecovery(ctx, state, target, attempt + 1, options)
    if (result.error === 'escape_exhausted') {
      gaveUp = true
      assert.strictEqual(state.pathStatus, 'escape_gave_up')
      break
    }
  }
  assert.ok(gaveUp, 'ladder must terminate in a safe give-up, not retry forever')

  const snapshot = getEscapeLedgerSnapshot(ctx, 'return_to_base')
  assert.strictEqual(snapshot.gaveUp, true)
}

// The give-up message asks a human for blocks. If running out of blocks retired
// the pillar rung for good, handing the bot blocks would change nothing and the
// request would be a lie.
async function testRunningOutOfBlocksIsRetryableOnceBlocksArrive() {
  let items = []
  const ctx = createPitContext({ items: [] })
  ctx.bot.inventory.items = () => items
  const target = { x: 427, y: 64, z: 376 }
  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    pillarJumpMs: 1,
    pillarSettleMs: 1,
    maxPillarLifts: 12,
    backoffMs: [0],
    chatFeedback: false
  }

  const empty = await runStuckRecovery(ctx, createRecoveryState(), target, 1, options)
  assert.ok(!empty.ok, 'with no blocks the bot cannot get out')
  const stranded = getEscapeLedgerSnapshot(ctx, 'return_to_base')
  assert.ok(
    !stranded.exhausted.includes('pillar_up'),
    'running out of blocks must not retire the pillar rung permanently'
  )
  assert.strictEqual(stranded.gaveUp, false, 'this is "not yet", not "never"')

  // Somebody tosses the bot some dirt.
  items = [{ name: 'dirt', count: 16 }]
  const rescued = await runStuckRecovery(ctx, createRecoveryState(), target, 2, options)
  assert.ok(rescued.ok, `should escape once blocks arrive, got ${rescued.error}`)
  assert.strictEqual(rescued.action, 'pillar_up')
}

async function testBackoffHoldShortCircuitsTheLadder() {
  const ctx = createPitContext({ items: [] })
  const target = { x: 427, y: 64, z: 376 }
  const options = {
    escapeKey: 'return_to_base',
    recoveryTimeoutMs: 1,
    jumpMs: 1,
    allowDig: false,
    chatFeedback: false
  }

  const first = createRecoveryState()
  await runStuckRecovery(ctx, first, target, 1, options)

  // Immediately afterwards the ledger is inside its backoff window: the next
  // re-created task must hold, not burn another full ladder pass.
  const second = createRecoveryState()
  const held = await runStuckRecovery(ctx, second, target, 2, options)
  assert.ok(String(held.error).startsWith('escape_backoff_hold:'), held.error)
  assert.strictEqual(second.pathStatus, 'escape_backoff')
}

async function testLedgersAreKeyedPerSituation() {
  const ctx = createPitContext()
  const position = { x: 560.5, y: 61, z: 375.5 }
  noteRungFailure(ctx, 'return_to_base', 'repath', 'x', { now: 1000 })
  // A different task type in the same spot keeps its own ladder.
  const follow = planEscapeAttempt(ctx, 'follow', position, { now: 1000 })
  assert.strictEqual(follow.rung, 'repath')
  assert.deepStrictEqual(getEscapeLedgerSnapshot(ctx, 'return_to_base').exhausted, ['repath'])
}

async function testResetEscapeLedgerClearsEverything() {
  const ctx = createPitContext()
  noteRungFailure(ctx, 'return_to_base', 'repath', 'x', { now: 1000 })
  resetEscapeLedger(ctx, 'return_to_base')
  const snapshot = getEscapeLedgerSnapshot(ctx, 'return_to_base')
  assert.deepStrictEqual(snapshot.exhausted, [])
  assert.strictEqual(snapshot.gaveUp, false)
  assert.strictEqual(loadLedger(ctx, 'return_to_base').anchor, null)
  assert.deepStrictEqual(createLedger('k').exhausted, [])
}

async function run() {
  await testLedgerSurvivesTaskRecreation()
  await testEachFailureRetiresARungUntilGiveUp()
  await testBackoffGrowsWithConsecutiveFailures()
  await testBackoffWindowHoldsInsteadOfRetrying()
  await testSuccessClearsTheLedger()
  await testLedgerResetsOnceTheBotLeavesTheAnchor()
  await testProgressIsMeasuredAgainstTheAnchorNotTheStep()
  await testPillarUpLiftsTheBotOutOfThePit()
  await testPillarUpRefusesWithoutMaterial()
  await testPillarUpNeverBuildsInsideAProtectedBuilding()
  await testPillarUpPrefersExpendableBlocks()
  await testSafePostureStopsMovingAndAsksForHelp()
  await testSafePostureStaysQuietDuringBackoff()
  await testRecoveryEscalatesToPillarUpInsteadOfLoopingForever()
  await testInterruptInsideTheLadderStopsItAndLeavesTheLockFree()
  await testEscalationAdvancesAcrossRecreatedTasks()
  await testRecoveryGivesUpSafelyWhenEveryRungIsImpossible()
  await testRunningOutOfBlocksIsRetryableOnceBlocksArrive()
  await testBackoffHoldShortCircuitsTheLadder()
  await testLedgersAreKeyedPerSituation()
  await testResetEscapeLedgerClearsEverything()
  console.log('escape-ladder tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
