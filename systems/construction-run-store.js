const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const {
  createConstructionLifecycle,
  normalizeConstructionPhase,
  updateConstructionLifecycle
} = require('./building-design-spec')
const connectionState = require('../core/connection-state')

const DEFAULT_RUN_STORE_PATH = path.join(process.cwd(), 'data', 'memory', 'construction-runs.json')
const RUN_STORE_SCHEMA_VERSION = 2
// Terminal runs carry the two blocks that make the ledger huge: the whole step
// map and the frozen blueprint IR. Live 2026-09-02: 98 MB on disk / 53 MB of
// content, of which steps 39 MB + frozenBlueprintIR 11 MB (94%), and every
// checkpoint reads and rewrites the lot. They move to one sidecar file per run
// and are read back on demand (renovation needs the IR; the resume-evidence
// script needs the steps).
const ARCHIVED_RUN_FIELDS = ['steps', 'frozenBlueprintIR']
const RUN_ARCHIVE_DIR_SUFFIX = '-archive'
const ACTIVE_RUN_STATES = new Set([
  'ACTIVE',
  'RUNNING',
  'PAUSED',
  'FAILED',
  'BLOCKED_MATERIAL_SHORTAGE',
  'BLOCKED_STAGING_CHEST'
])
const TERMINAL_RUN_STATES = new Set(['COMPLETED', 'FAILED', 'ABANDONED', 'CANCELLED'])
const TERMINAL_STATUS_STATES = new Set(['COMPLETED', 'ABANDONED', 'CANCELLED'])
const VERIFIED_STEP_STATES = new Set(['verified'])
const TRANSIENT_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const MAX_RESUME_HISTORY = 64
const STEP_STATE = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  EXECUTING: 'executing',
  PLACED: 'placed',
  VERIFIED: 'verified',
  RETRYABLE_FAILED: 'retryable_failed',
  TERMINAL_FAILED: 'terminal_failed',
  REPAIR: 'repair',
  STATE_REPAIR: 'state_repair',
  CLEANUP: 'cleanup'
})

class ConstructionRunStore {
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_RUN_STORE_PATH
    // Offline guard. While the bot's socket is dead the build chain that was
    // in flight keeps failing on the dead bot (chests never open, moves time
    // out) and would persist those verdicts as a false BLOCKED_MATERIAL_
    // SHORTAGE / FAILED. Writes are held in memory and dropped from disk
    // until the connection is back; the next checkpoint writes the truth.
    // Defaults to the process-wide connection state; tests may inject.
    this.isWritable = typeof options.isWritable === 'function'
      ? options.isWritable
      : connectionState.isOnline
    this.logger = options.logger || console
    // Kill switch: BOT_CONSTRUCTION_RUN_ARCHIVE=0 keeps the whole run in the
    // main ledger and skips migration (old behaviour).
    this.archiveTerminalRuns = options.archiveTerminalRuns != null
      ? options.archiveTerminalRuns !== false
      : String(process.env.BOT_CONSTRUCTION_RUN_ARCHIVE ?? '1') !== '0'
    this.archiveDir = options.archiveDir || defaultArchiveDir(this.filePath)
    this.migratedAt = null
    this.lastWriteDeferred = false
    this.deferredWrites = []
    this.lastDeferredLogAt = 0
  }

  canWrite() {
    try {
      return this.isWritable() !== false
    } catch {
      return true
    }
  }

  deferWrite(operation, run) {
    this.lastWriteDeferred = true
    const record = {
      operation,
      runId: run?.runId || null,
      status: run?.status || null,
      at: new Date().toISOString()
    }
    this.deferredWrites.push(record)
    if (this.deferredWrites.length > 64) this.deferredWrites.shift()
    const now = Date.now()
    if (now - this.lastDeferredLogAt >= 5000) {
      this.lastDeferredLogAt = now
      this.logger?.log?.(
        `[CONSTRUCTION_RUN_WRITE_DEFERRED] op=${operation} runId=${record.runId || 'none'} ` +
        `status=${record.status || 'none'} reason=connection_offline deferred=${this.deferredWrites.length}`
      )
    }
    return record
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return { schemaVersion: RUN_STORE_SCHEMA_VERSION, runs: [] }
    }
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      return { schemaVersion: RUN_STORE_SCHEMA_VERSION, runs: [] }
    }
    const document = {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      runs: Array.isArray(parsed.runs) ? parsed.runs : []
    }
    return this.migrateIfNeeded(document)
  }

  // One-shot, idempotent: a v1 ledger keeps every terminal run whole, so the
  // first load after the upgrade backs the original up and splits them out.
  // A v2 ledger falls straight through.
  migrateIfNeeded(document) {
    if (!this.archiveTerminalRuns) return document
    if (Number(document.schemaVersion) >= RUN_STORE_SCHEMA_VERSION) return document
    // Same offline guard as every other write: while the socket is dead the
    // ledger is left alone and the next online load migrates it.
    if (!this.canWrite()) return document
    const pending = document.runs.filter(run => isRunTerminal(run) && runCarriesArchivedFields(run))
    if (!pending.length) {
      this.writeDocument(document)
      return { schemaVersion: RUN_STORE_SCHEMA_VERSION, runs: document.runs }
    }
    const backupPath = `${this.filePath.replace(/\.json$/i, '')}.pre-archive.json`
    try {
      if (!fs.existsSync(backupPath)) fs.copyFileSync(this.filePath, backupPath)
    } catch (error) {
      this.logger?.log?.(
        `[CONSTRUCTION_RUN_ARCHIVE_MIGRATION_FAILED] reason=backup_failed error=${error?.message || error} path=${backupPath}`
      )
      return document
    }
    const startedAt = Date.now()
    const written = this.writeDocument(document)
    this.migratedAt = new Date().toISOString()
    this.logger?.log?.(
      `[CONSTRUCTION_RUN_ARCHIVE_MIGRATED] runs=${pending.length} fields=${ARCHIVED_RUN_FIELDS.join(',')} ` +
      `backup=${path.basename(backupPath)} archiveDir=${path.basename(this.archiveDir)} ms=${Date.now() - startedAt}`
    )
    return written
  }

  save(document) {
    return this.writeDocument({
      schemaVersion: RUN_STORE_SCHEMA_VERSION,
      runs: Array.isArray(document?.runs) ? document.runs : []
    })
  }

  // Splits every terminal run's heavy fields into its sidecar, then writes the
  // ledger. Sidecars go down first: a crash between the two leaves an orphan
  // sidecar (harmless) rather than a ledger pointing at a file that is not
  // there yet.
  writeDocument(document) {
    const runs = Array.isArray(document?.runs) ? document.runs : []
    const normalized = {
      schemaVersion: RUN_STORE_SCHEMA_VERSION,
      runs: this.archiveTerminalRuns ? runs.map(run => this.archiveRun(run)) : runs
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSyncWithRetry(tmpPath, this.filePath)
    return normalized
  }

  archivePathFor(runId) {
    return path.join(this.archiveDir, `${String(runId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
  }

  // Terminal run carrying heavy fields -> sidecar + pointer. Anything else
  // (active run, already-split run) comes back untouched.
  archiveRun(run) {
    if (!run?.runId || !isRunTerminal(run) || !runCarriesArchivedFields(run)) return run
    const payload = { runId: run.runId, archivedAt: new Date().toISOString() }
    const slim = { ...run }
    for (const field of ARCHIVED_RUN_FIELDS) {
      if (run[field] == null) continue
      payload[field] = run[field]
      delete slim[field]
    }
    const target = this.archivePathFor(run.runId)
    try {
      fs.mkdirSync(this.archiveDir, { recursive: true })
      const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`
      // Sidecars are machine-only: compact, no indentation.
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, 'utf8')
      renameSyncWithRetry(tmpPath, target)
    } catch (error) {
      this.logger?.log?.(
        `[CONSTRUCTION_RUN_ARCHIVE_WRITE_FAILED] runId=${run.runId} error=${error?.message || error}`
      )
      return run
    }
    return {
      ...slim,
      stepCount: Object.keys(run.steps || {}).length,
      stepStatusCounts: stepStatusCounts(run.steps),
      archived: {
        file: path.relative(path.dirname(this.filePath), target).split(path.sep).join('/'),
        fields: ARCHIVED_RUN_FIELDS.filter(field => run[field] != null),
        at: payload.archivedAt
      }
    }
  }

  // Merges a sidecar back onto a slim run. Missing sidecar -> the run is
  // returned as it is; callers that need the heavy fields already tolerate
  // them being absent (they read `run.steps || {}`).
  hydrateRun(run) {
    if (!run?.archived?.file) return run
    const target = path.resolve(path.dirname(this.filePath), run.archived.file)
    try {
      const payload = JSON.parse(fs.readFileSync(target, 'utf8'))
      const hydrated = { ...run }
      for (const field of ARCHIVED_RUN_FIELDS) {
        if (payload[field] != null) hydrated[field] = payload[field]
      }
      return hydrated
    } catch (error) {
      this.logger?.log?.(
        `[CONSTRUCTION_RUN_ARCHIVE_READ_FAILED] runId=${run.runId} file=${run.archived.file} error=${error?.message || error}`
      )
      return run
    }
  }

  listRuns() {
    return this.load().runs
  }

  // Hydrates by default: the only caller that fetches a run by id is the
  // renovation path, and it reads the archived frozen IR.
  getRun(runId, options = {}) {
    const run = this.listRuns().find(entry => entry.runId === runId) || null
    if (!run || options.hydrate === false) return run
    return this.hydrateRun(run)
  }

  upsertRun(run) {
    const normalized = {
      ...run,
      updatedAt: new Date().toISOString()
    }
    if (!this.canWrite()) {
      this.deferWrite('upsertRun', normalized)
      return normalized
    }
    this.lastWriteDeferred = false
    const document = this.load()
    const index = document.runs.findIndex(entry => entry.runId === run.runId)
    if (index >= 0) document.runs[index] = normalized
    else document.runs.push(normalized)
    this.save(document)
    return normalized
  }

  updateRun(runId, updater) {
    const document = this.load()
    const index = document.runs.findIndex(run => run.runId === runId)
    if (index < 0) return null
    // An archived run must come back whole before it is patched, or the
    // update would write a slim record with no sidecar behind it.
    const current = this.hydrateRun(document.runs[index])
    const updated = {
      ...current,
      ...(typeof updater === 'function' ? updater(clonePlainObject(current)) : updater),
      updatedAt: new Date().toISOString()
    }
    if (!this.canWrite()) {
      this.deferWrite('updateRun', updated)
      return updated
    }
    this.lastWriteDeferred = false
    document.runs[index] = updated
    this.save(document)
    return updated
  }

  updateStep(runId, stepId, patch = {}) {
    return this.updateRun(runId, run => {
      const steps = { ...(run.steps || {}) }
      const previous = steps[stepId] || { id: stepId, status: STEP_STATE.PENDING }
      steps[stepId] = {
        ...previous,
        ...patch,
        id: stepId,
        lifecyclePhase: patch.lifecyclePhase || previous.lifecyclePhase || normalizeConstructionPhase(patch.phase || previous.phase, patch),
        updatedAt: new Date().toISOString()
      }
      const currentPhase = steps[stepId].lifecyclePhase || run.currentPhase || 'site_prepare'
      return {
        ...run,
        steps,
        currentPhase,
        lifecycle: updateConstructionLifecycle(run.lifecycle, steps, currentPhase)
      }
    })
  }

  findActiveCompatible(criteria = {}) {
    return this.listRuns()
      .filter(run => isRunActive(run))
      .find(run => constructionRunCompatibility(run, criteria).ok) || null
  }

  findActiveForBlueprint(blueprintId) {
    return this.listRuns()
      .filter(run => isRunActive(run))
      .find(run => run.blueprintId === blueprintId) || null
  }

  abandonRun(runId, reason, details = {}) {
    return this.updateRun(runId, run => ({
      ...run,
      status: 'ABANDONED',
      terminalState: 'ABANDONED',
      abandonedAt: new Date().toISOString(),
      abandonReason: reason,
      abandonDetails: details
    }))
  }
}

function createConstructionRun(input = {}) {
  const now = new Date().toISOString()
  const steps = {}
  for (const step of input.steps || []) {
    if (!step?.id) continue
    steps[step.id] = {
      id: step.id,
      sourceBlockKey: step.sourceBlockKey || null,
      action: step.action || legacyAction(step.kind),
      legacyKind: step.kind || null,
      phase: step.phase || null,
      lifecyclePhase: normalizeConstructionPhase(step.phase, step),
      target: clonePlainObject(step.target || step.position || null),
      block: clonePlainObject(step.block || (step.blockName ? { id: step.blockName, states: step.states || step.orientation || {} } : null)),
      originalBlock: clonePlainObject(step.originalBlock || (step.originalBlockName ? { id: step.originalBlockName } : null)),
      resolvedBlock: clonePlainObject(step.resolvedBlock || (step.resolvedBlockName ? { id: step.resolvedBlockName } : null)),
      role: step.role || null,
      materialAlternatives: [...(step.materialAlternatives || [])],
      exactRequired: step.exactRequired === true,
      materialPolicySource: step.materialPolicySource || null,
      materialResolution: clonePlainObject(step.materialResolution || null),
      dependencies: [...(step.dependencies || [])],
      // Renovation demolition marker: persists so a resumed renovation run
      // keeps its clear-policy authorization (JSON drops undefined for
      // ordinary steps, keeping non-renovation records byte-stable).
      ...(step.renovationClear === true ? { renovationClear: true, renovationOf: step.renovationOf || null } : {}),
      status: STEP_STATE.PENDING,
      retry: { count: 0, lastError: null },
      createdAt: now,
      updatedAt: now
    }
  }

  const runIdentity = {
    blueprintId: input.blueprintId,
    blueprintRevision: input.blueprintRevision,
    blueprintHash: input.blueprintHash,
    planId: input.planId,
    placementContext: input.placementContext,
    world: input.world || null
  }
  const lifecycle = input.lifecycle || createConstructionLifecycle({
    currentPhase: input.currentPhase || 'site_prepare',
    designSpec: input.designSpec,
    blueprintFreeze: input.blueprintFreeze,
    materialStats: input.materialStats,
    constructionPlan: { planId: input.planId },
    placementContext: input.placementContext,
    stagingChests: input.stagingChests,
    stagingInventoryVerified: input.stagingInventoryVerified === true
  })

  return {
    schemaVersion: RUN_STORE_SCHEMA_VERSION,
    runId: input.runId || `construction_run_${sha1(stableStringify({ ...runIdentity, createdAt: now })).slice(0, 16)}`,
    blueprintId: input.blueprintId,
    blueprintRevision: input.blueprintRevision || null,
    blueprintHash: input.blueprintHash || null,
    // RENOVATION lineage (docs/RENOVATION_FLOW_DESIGN.md): explicit pointer to
    // the COMPLETED run this run renovates, and the blueprint hash the
    // renovation starts from. null for ordinary runs.
    renovationOf: input.renovationOf || null,
    renovationBaseHash: input.renovationBaseHash || null,
    planId: input.planId,
    placementContext: clonePlainObject(input.placementContext || {}),
    world: clonePlainObject(input.world || null),
    bounds: clonePlainObject(input.bounds || null),
    stagingChests: clonePlainObject(input.stagingChests || []),
    currentPhase: normalizeConstructionPhase(input.currentPhase || lifecycle.currentPhase || 'site_prepare'),
    designSpec: clonePlainObject(input.designSpec || null),
    blueprintFreeze: clonePlainObject(input.blueprintFreeze || null),
    frozenBlueprintIR: clonePlainObject(input.frozenBlueprintIR || input.blueprintIR || null),
    materialStats: clonePlainObject(input.materialStats || null),
    lifecycle: clonePlainObject(lifecycle),
    archive: clonePlainObject(input.archive || null),
    steps,
    retry: { count: 0, lastError: null },
    status: 'ACTIVE',
    terminalState: null,
    createdAt: now,
    updatedAt: now
  }
}

function recordConstructionRunSession(run, evidence = {}) {
  if (!run?.runId) return run
  const at = evidence.observedAt || new Date().toISOString()
  const runtimeEvidence = normalizeRuntimeEvidence(evidence, at)
  const resumeHistory = Array.isArray(run.resumeHistory)
    ? run.resumeHistory.map(clonePlainObject)
    : []

  if (evidence.resumed === true) {
    const previousRun = evidence.previousRun || run
    const previousRuntime = previousRun.runtimeEvidence || run.runtimeEvidence || null
    const lastSequence = Number(resumeHistory[resumeHistory.length - 1]?.sequence || 0)
    const sequence = lastSequence + 1
    const checkpointBefore = constructionRunCheckpointEvidence(previousRun)
    const checkpointAfter = constructionRunCheckpointEvidence(run)
    const event = {
      eventId: `construction_resume_${sha1(stableStringify({
        runId: run.runId,
        sequence,
        at,
        processSessionId: runtimeEvidence.processSessionId,
        verified: checkpointAfter.verified
      })).slice(0, 16)}`,
      sequence,
      at,
      outcome: 'prepared',
      reason: evidence.reason || 'compatible_active_run',
      resumeOnly: evidence.resumeOnly === true,
      worldIdentityUpgrade: clonePlainObject(evidence.worldIdentityUpgrade || null),
      runtime: runtimeEvidence,
      previousRuntime: clonePlainObject(previousRuntime),
      processRestarted: comparableRuntimeFieldChanged(previousRuntime, runtimeEvidence, 'processSessionId'),
      lanPortChanged: comparableRuntimeFieldChanged(previousRuntime, runtimeEvidence, 'lanPort'),
      checkpointBefore,
      checkpointAfter,
      invariants: {
        runId: run.runId,
        blueprintId: run.blueprintId || null,
        blueprintHash: run.blueprintHash || null,
        planId: run.planId || null,
        placementContext: clonePlainObject(run.placementContext || null),
        world: clonePlainObject(run.world || null)
      }
    }
    resumeHistory.push(event)
  }

  return {
    ...run,
    runtimeEvidence,
    resumeHistory: resumeHistory.slice(-MAX_RESUME_HISTORY)
  }
}

function constructionRunCheckpointEvidence(run = {}) {
  const counts = {}
  for (const step of Object.values(run.steps || {})) {
    const status = String(step?.status || STEP_STATE.PENDING)
    counts[status] = (counts[status] || 0) + 1
  }
  return {
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    verified: counts[STEP_STATE.VERIFIED] || 0,
    pending: counts[STEP_STATE.PENDING] || 0,
    ready: counts[STEP_STATE.READY] || 0,
    executing: counts[STEP_STATE.EXECUTING] || 0,
    placed: counts[STEP_STATE.PLACED] || 0,
    retryableFailed: counts[STEP_STATE.RETRYABLE_FAILED] || 0,
    terminalFailed: counts[STEP_STATE.TERMINAL_FAILED] || 0,
    repair: counts[STEP_STATE.REPAIR] || 0,
    stateRepair: counts[STEP_STATE.STATE_REPAIR] || 0,
    cleanup: counts[STEP_STATE.CLEANUP] || 0,
    currentPhase: run.currentPhase || null,
    checkpoint: run.checkpoint
      ? {
          reason: run.checkpoint.reason || null,
          flushedAt: run.checkpoint.flushedAt || null,
          writeCount: Number(run.checkpoint.writeCount || 0)
        }
      : null,
    updatedAt: run.updatedAt || null
  }
}

function normalizeRuntimeEvidence(evidence = {}, observedAt) {
  const pid = Number(evidence.pid)
  const port = Number(evidence.lanPort)
  return {
    processSessionId: evidence.processSessionId ? String(evidence.processSessionId) : null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    lanPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
    dimension: evidence.dimension ? String(evidence.dimension) : null,
    worldId: normalizeWorldId(evidence.worldId),
    observedAt
  }
}

function normalizeWorldId(value) {
  const normalized = String(value || '').trim()
  return normalized || null
}

function comparableRuntimeFieldChanged(previous, current, field) {
  if (previous?.[field] == null || current?.[field] == null) return null
  return previous[field] !== current[field]
}

function constructionRunCompatibility(run, criteria = {}) {
  if (!run) return { ok: false, reason: 'run_missing' }
  const checks = [
    ['blueprintId', run.blueprintId, criteria.blueprintId],
    ['blueprintHash', run.blueprintHash, criteria.blueprintHash],
    ['placementContext', run.placementContext, criteria.placementContext]
  ]
  for (const [field, actual, expected] of checks) {
    if (expected == null) continue
    if (stableStringify(actual) !== stableStringify(expected)) {
      return { ok: false, reason: `${field}_changed`, field, actual, expected }
    }
  }
  const worldCompatibility = constructionWorldCompatibility(run.world, criteria.world)
  if (!worldCompatibility.ok) return worldCompatibility
  return {
    ok: true,
    worldIdentityUpgrade: worldCompatibility.worldIdentityUpgrade || null
  }
}

function constructionWorldCompatibility(actual = null, expected = null) {
  if (expected == null) return { ok: true, worldIdentityUpgrade: null }
  const actualDimension = actual?.dimension || null
  const expectedDimension = expected?.dimension || null
  if (expectedDimension != null && actualDimension !== expectedDimension) {
    return {
      ok: false,
      reason: 'world_dimension_changed',
      field: 'world.dimension',
      actual: actualDimension,
      expected: expectedDimension
    }
  }

  const actualWorldId = normalizeWorldId(actual?.worldId)
  const expectedWorldId = normalizeWorldId(expected?.worldId)
  if (actualWorldId && !expectedWorldId) {
    return {
      ok: false,
      reason: 'world_identity_unverified',
      field: 'world.worldId',
      actual: actualWorldId,
      expected: null
    }
  }
  if (actualWorldId && expectedWorldId && actualWorldId !== expectedWorldId) {
    return {
      ok: false,
      reason: 'world_id_changed',
      field: 'world.worldId',
      actual: actualWorldId,
      expected: expectedWorldId
    }
  }
  return {
    ok: true,
    worldIdentityUpgrade: !actualWorldId && expectedWorldId
      ? { from: null, to: expectedWorldId, source: expected?.identitySource || null }
      : null
  }
}

function defaultArchiveDir(filePath) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath).replace(/\.json$/i, '')
  return path.join(dir, `${base}${RUN_ARCHIVE_DIR_SUFFIX}`)
}

function runCarriesArchivedFields(run) {
  return ARCHIVED_RUN_FIELDS.some(field => run?.[field] != null)
}

function stepStatusCounts(steps) {
  const counts = {}
  for (const step of Object.values(steps || {})) {
    const status = step?.status || 'unknown'
    counts[status] = (counts[status] || 0) + 1
  }
  return counts
}

function isRunActive(run) {
  return run && ACTIVE_RUN_STATES.has(run.status) && !isRunTerminal(run)
}

function isRunTerminal(run) {
  return run && (TERMINAL_RUN_STATES.has(run.terminalState) || TERMINAL_STATUS_STATES.has(run.status))
}

function renameSyncWithRetry(source, target, attempts = 24) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(source, target)
      return
    } catch (error) {
      lastError = error
      if (!TRANSIENT_REPLACE_ERRORS.has(error.code) || attempt === attempts - 1) break
      sleepSync(25 * (attempt + 1))
    }
  }
  if (lastError && TRANSIENT_REPLACE_ERRORS.has(lastError.code)) {
    replaceByCopyWithRetry(source, target)
    return
  }
  throw lastError
}

function replaceByCopyWithRetry(source, target, attempts = 12) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.copyFileSync(source, target)
      removeTemporaryFile(source)
      return
    } catch (error) {
      lastError = error
      if (!TRANSIENT_REPLACE_ERRORS.has(error.code) || attempt === attempts - 1) break
      sleepSync(50 * (attempt + 1))
    }
  }
  throw lastError
}

function removeTemporaryFile(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // The save has already reached the target; stale temp cleanup can be retried by later maintenance.
  }
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function isStepVerified(stepState) {
  return VERIFIED_STEP_STATES.has(String(stepState?.status || ''))
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function clonePlainObject(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

function legacyAction(kind) {
  if (kind === 'clear' || kind === 'scaffold_remove') return 'clear_block'
  if (kind === 'foundation_fill' || kind === 'scaffold_place' || kind === 'place') return 'place_block'
  if (kind === 'walkability_validate') return 'validate_walkability'
  if (kind === 'validate') return 'validate_world'
  return String(kind || 'unknown')
}

module.exports = {
  ACTIVE_RUN_STATES,
  ARCHIVED_RUN_FIELDS,
  ConstructionRunStore,
  DEFAULT_RUN_STORE_PATH,
  MAX_RESUME_HISTORY,
  RUN_STORE_SCHEMA_VERSION,
  STEP_STATE,
  TERMINAL_RUN_STATES,
  constructionRunCompatibility,
  constructionRunCheckpointEvidence,
  constructionWorldCompatibility,
  createConstructionRun,
  isRunActive,
  isRunTerminal,
  isStepVerified,
  stepStatusCounts,
  recordConstructionRunSession,
  stableStringify
}
