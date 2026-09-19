// Reusable execution-layer backoff/escalation ledger.
//
// Why this exists: every task that can get physically stuck built its recovery
// state inside the task instance (`createRecoveryState()` in the constructor).
// The survival system re-creates the task on every failure, so the ladder
// restarted at rung 0 forever — "失败后原样重排、无退避、无升级". Round 5's
// pit death and round 6's east-ditch stall are the same bug.
//
// The ledger lives on the blackboard (or a context-local fallback), keyed by a
// caller-supplied string, so it OUTLIVES the task object. It records which
// rungs have already been proven useless here, how long to wait before trying
// again, and when to stop thrashing and hold a safe posture instead.
//
// It also fixes the second half of the bug: a rung used to count as "success"
// whenever its `moveTo` returned ok, even when the bot only shuffled sideways
// inside the same pit. Progress is now measured against an anchor position.

const DEFAULT_RUNGS = ['repath', 'jump_and_step', 'nearby_exit', 'safe_dig', 'pillar_up', 'safe_posture']

// Backoff between escalation attempts, indexed by consecutive failure count.
// The last value is the cap.
const DEFAULT_BACKOFF_MS = [0, 5000, 15000, 30000, 60000]

const LEDGER_PATH = 'recovery.escapeLedgers'
const CONTEXT_FALLBACK = Symbol.for('linxia.escapeLedgers')

// A situation counts as "somewhere else" once the bot has climbed this far or
// walked this far from where the trouble started. Past that the old ledger no
// longer describes reality and must not suppress a fresh recovery.
const DEFAULT_ANCHOR_RESET_Y = 2
const DEFAULT_ANCHOR_RESET_DISTANCE = 6

// How much better the bot has to be off for an attempt to count as progress.
const DEFAULT_MIN_Y_GAIN = 1
const DEFAULT_MIN_DISTANCE_GAIN = 2

function createLedger(key) {
  return {
    key,
    consecutiveFailures: 0,
    exhausted: [],
    lastFailureReason: null,
    lastRung: null,
    lastAttemptAt: 0,
    nextAttemptAt: 0,
    gaveUp: false,
    gaveUpAt: null,
    anchor: null,
    escapes: 0
  }
}

function ledgerStore(ctx) {
  const blackboard = ctx?.blackboard
  if (blackboard?.get && blackboard?.set) {
    const existing = blackboard.get(LEDGER_PATH)
    if (existing && typeof existing === 'object') return existing
    const created = {}
    blackboard.set(LEDGER_PATH, created)
    // Some blackboards clone on set; read back so we mutate the stored object.
    return blackboard.get(LEDGER_PATH) || created
  }
  if (!ctx) return {}
  if (!ctx[CONTEXT_FALLBACK]) ctx[CONTEXT_FALLBACK] = {}
  return ctx[CONTEXT_FALLBACK]
}

function loadLedger(ctx, key) {
  const store = ledgerStore(ctx)
  if (!store[key]) store[key] = createLedger(key)
  return store[key]
}

function saveLedger(ctx, key, ledger) {
  const store = ledgerStore(ctx)
  store[key] = ledger
  const blackboard = ctx?.blackboard
  if (blackboard?.set) blackboard.set(LEDGER_PATH, store)
  return ledger
}

function resetEscapeLedger(ctx, key) {
  return saveLedger(ctx, key, createLedger(key))
}

function getEscapeLedgerSnapshot(ctx, key) {
  const ledger = loadLedger(ctx, key)
  return {
    key: ledger.key,
    consecutiveFailures: ledger.consecutiveFailures,
    exhausted: [...ledger.exhausted],
    lastFailureReason: ledger.lastFailureReason,
    lastRung: ledger.lastRung,
    nextAttemptAt: ledger.nextAttemptAt,
    gaveUp: ledger.gaveUp === true,
    anchor: ledger.anchor ? { ...ledger.anchor } : null,
    escapes: ledger.escapes
  }
}

// The anchor is where the trouble started. If the bot is demonstrably no longer
// there, the ledger describes a situation that no longer exists — drop it so a
// stale "gave up" flag can never strand a bot that has since moved on.
function anchorStillValid(ledger, position, options = {}) {
  if (!ledger.anchor || !position) return false
  const yGain = Number(position.y) - Number(ledger.anchor.y)
  if (yGain >= Number(options.anchorResetY ?? DEFAULT_ANCHOR_RESET_Y)) return false
  const dx = Number(position.x) - Number(ledger.anchor.x)
  const dz = Number(position.z) - Number(ledger.anchor.z)
  const flat = Math.sqrt(dx * dx + dz * dz)
  return flat < Number(options.anchorResetDistance ?? DEFAULT_ANCHOR_RESET_DISTANCE)
}

// Decide what to try next for `key`, given where the bot currently is.
// Returns { rung, rungIndex, giveUp, waitMs, ledger, reset }.
function planEscapeAttempt(ctx, key, position, options = {}) {
  const rungs = options.rungs || DEFAULT_RUNGS
  const now = Number(options.now ?? Date.now())
  let ledger = loadLedger(ctx, key)
  let reset = false

  if (ledger.anchor && !anchorStillValid(ledger, position, options)) {
    ledger = resetEscapeLedger(ctx, key)
    reset = true
  }
  if (!ledger.anchor && position) {
    ledger.anchor = { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
  }

  if (ledger.nextAttemptAt > now) {
    return {
      rung: null,
      rungIndex: -1,
      giveUp: ledger.gaveUp === true,
      waitMs: ledger.nextAttemptAt - now,
      ledger,
      reset
    }
  }

  const remaining = rungs.filter(rung => !ledger.exhausted.includes(rung))
  if (!remaining.length) {
    ledger.gaveUp = true
    if (!ledger.gaveUpAt) ledger.gaveUpAt = now
    saveLedger(ctx, key, ledger)
    return { rung: 'safe_posture', rungIndex: rungs.length - 1, giveUp: true, waitMs: 0, ledger, reset }
  }

  const rung = remaining[0]
  saveLedger(ctx, key, ledger)
  return { rung, rungIndex: rungs.indexOf(rung), giveUp: false, waitMs: 0, ledger, reset }
}

// Did the attempt actually get the bot out, or did it just shuffle?
// `jump_and_step` used to report success for a 2-block sidestep inside the very
// same pit, which reset the stuck state and made escalation unreachable. The
// only thing that counts is leaving the anchor — the spot where the bot jammed.
function measureEscapeProgress(anchor, position, options = {}) {
  if (!anchor || !position) return { improved: false, yGain: 0, flatGain: 0, reason: 'missing_position' }
  const yGain = Number(position.y) - Number(anchor.y)
  const flatGain = flatDistance(anchor, position)
  const improved = yGain >= Number(options.anchorResetY ?? DEFAULT_ANCHOR_RESET_Y) ||
    flatGain >= Number(options.anchorResetDistance ?? DEFAULT_ANCHOR_RESET_DISTANCE)
  return {
    improved,
    yGain: Math.round(yGain * 100) / 100,
    flatGain: Math.round(flatGain * 100) / 100,
    reason: improved ? 'left_anchor' : 'still_at_anchor'
  }
}

// True once the bot is demonstrably out of the spot it jammed in.
function hasEscapedAnchor(ledger, position, options = {}) {
  if (!ledger?.anchor || !position) return false
  return !anchorStillValid(ledger, position, options)
}

function flatDistance(a, b) {
  const dx = Number(a.x) - Number(b.x)
  const dz = Number(a.z) - Number(b.z)
  return Math.sqrt(dx * dx + dz * dz)
}

// Some failures say "this rung cannot work here" and some only say "not right
// now". Running out of blocks is the second kind: the give-up message asks a
// human for blocks, so the rung has to still be available once they arrive.
// Retiring it permanently would make that request pointless.
const TRANSIENT_FAILURES = [
  'no_pillar_material',
  'lock_unavailable',
  'recovery_already_running',
  'pillar_up_unavailable'
]

function isTransientFailure(reason) {
  const text = String(reason || '')
  return TRANSIENT_FAILURES.some(item => text.includes(item))
}

// Record that a rung was tried and did not get the bot out. Unless the failure
// was transient the rung is retired for this situation, and either way the wait
// before the next attempt grows.
function noteRungFailure(ctx, key, rung, reason, options = {}) {
  const ledger = loadLedger(ctx, key)
  const now = Number(options.now ?? Date.now())
  const transient = options.transient === true || isTransientFailure(reason)
  if (rung && !transient && !ledger.exhausted.includes(rung)) ledger.exhausted.push(rung)
  ledger.consecutiveFailures += 1
  ledger.lastFailureReason = reason || null
  ledger.lastRung = rung || null
  ledger.lastAttemptAt = now
  ledger.nextAttemptAt = now + backoffFor(ledger.consecutiveFailures, options)
  return saveLedger(ctx, key, ledger)
}

// Every rung has been tried and none worked. Hold the safe posture and stay
// quiet until the backoff expires or the situation changes.
function markGaveUp(ctx, key, options = {}) {
  const ledger = loadLedger(ctx, key)
  const now = Number(options.now ?? Date.now())
  ledger.gaveUp = true
  if (!ledger.gaveUpAt) ledger.gaveUpAt = now
  ledger.nextAttemptAt = Math.max(ledger.nextAttemptAt, now + backoffFor(ledger.consecutiveFailures, options))
  return saveLedger(ctx, key, ledger)
}

// The bot got out. Wipe the ledger so the next unrelated jam starts clean.
function noteEscapeSuccess(ctx, key, options = {}) {
  const ledger = loadLedger(ctx, key)
  const escapes = ledger.escapes + 1
  const fresh = createLedger(key)
  fresh.escapes = escapes
  fresh.lastRung = options.rung || null
  return saveLedger(ctx, key, fresh)
}

function backoffFor(consecutiveFailures, options = {}) {
  const schedule = options.backoffMs || DEFAULT_BACKOFF_MS
  if (!schedule.length) return 0
  const index = Math.min(Math.max(consecutiveFailures - 1, 0), schedule.length - 1)
  return Number(schedule[index]) || 0
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  DEFAULT_RUNGS,
  anchorStillValid,
  backoffFor,
  createLedger,
  getEscapeLedgerSnapshot,
  hasEscapedAnchor,
  isTransientFailure,
  loadLedger,
  markGaveUp,
  measureEscapeProgress,
  noteEscapeSuccess,
  noteRungFailure,
  planEscapeAttempt,
  resetEscapeLedger
}
