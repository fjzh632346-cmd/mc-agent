const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  ARCHIVED_RUN_FIELDS,
  ConstructionRunStore,
  RUN_STORE_SCHEMA_VERSION,
  constructionRunCompatibility,
  createConstructionRun,
  isRunActive
} = require('../systems/construction-run-store')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const { itemRequirementsForBlock } = require('../utils/building-material-map')

// Logistics lane round 8: data/memory/construction-runs.json had grown to
// 98 MB on disk (53 MB of content: steps 39 MB + frozenBlueprintIR 11 MB =
// 94%), and every checkpoint read and rewrote the whole file — measured at
// 2.1 s per load+save on the live ledger. Terminal runs now keep those two
// fields in a sidecar and the ledger holds a slim record plus a pointer.
// What must NOT change: resume matching (blueprintId + blueprintHash +
// placementContext + world), which runs are active, and the bytes that come
// back when an archived run is hydrated.

const WORLD = { dimension: 'overworld', worldId: 'building-A:new-world', identitySource: 'MC_WORLD_ID' }
const ORIGIN = { origin: { x: 10, y: 64, z: -20 }, rotationY: 0 }

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ops-run-archive-'))
}

function steps (count, status = 'verified') {
  const out = {}
  for (let i = 0; i < count; i++) {
    out[`step_${i.toString(16).padStart(8, '0')}`] = {
      id: `step_${i.toString(16).padStart(8, '0')}`,
      status: i % 7 === 0 ? 'pending' : status,
      action: 'place_block',
      target: { x: i, y: 64, z: 0 },
      block: { id: 'stone_bricks', states: {} },
      retry: { count: 0, lastError: null }
    }
  }
  return out
}

function run (overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'construction_run_test0001',
    blueprintId: 'test_blueprint',
    blueprintRevision: 3,
    blueprintHash: 'hash_abc',
    planId: 'construction_plan_abc123',
    placementContext: ORIGIN,
    world: WORLD,
    bounds: { minX: 0, maxX: 4, minY: 64, maxY: 68, minZ: 0, maxZ: 4 },
    currentPhase: 'frame',
    status: 'COMPLETED',
    terminalState: 'COMPLETED',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    archive: { designSpec: { revision: 3 } },
    frozenBlueprintIR: { metadata: { frozen: true }, blocks: [{ position: { x: 0, y: 0, z: 0 }, block: { id: 'stone_bricks' } }] },
    steps: steps(40),
    ...overrides
  }
}

function writeLegacyLedger (dir, runs) {
  const file = path.join(dir, 'construction-runs.json')
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, runs }, null, 2)}\n`, 'utf8')
  return file
}

function store (file, options = {}) {
  return new ConstructionRunStore({ filePath: file, isWritable: () => true, logger: { log: () => {} }, ...options })
}

// ---------------------------------------------------------------------------
// 1 迁移：旧格式首次加载 → 终态 run 的大块移出主档，备份落在旁边
function testLegacyLedgerMigratesOnFirstLoad () {
  const dir = tempDir()
  const file = writeLegacyLedger(dir, [run()])
  const before = fs.statSync(file).size
  const document = store(file).load()

  assert.strictEqual(document.schemaVersion, RUN_STORE_SCHEMA_VERSION)
  const slim = document.runs[0]
  for (const field of ARCHIVED_RUN_FIELDS) assert.strictEqual(slim[field], undefined, `${field} still in the ledger`)
  assert.ok(slim.archived && slim.archived.file, 'no archive pointer')
  assert.deepStrictEqual(slim.archived.fields, ARCHIVED_RUN_FIELDS)
  assert.strictEqual(slim.stepCount, 40)
  assert.strictEqual(slim.stepStatusCounts.verified + slim.stepStatusCounts.pending, 40)
  // fields the ledger must keep
  assert.strictEqual(slim.blueprintHash, 'hash_abc')
  assert.deepStrictEqual(slim.placementContext, ORIGIN)
  assert.deepStrictEqual(slim.world, WORLD)
  assert.strictEqual(slim.terminalState, 'COMPLETED')
  assert.ok(slim.archive, 'archive summary must stay in the ledger')

  const backup = path.join(dir, 'construction-runs.pre-archive.json')
  assert.ok(fs.existsSync(backup), 'no pre-archive backup')
  assert.strictEqual(fs.statSync(backup).size, before)
  assert.ok(fs.statSync(file).size < before, 'ledger did not shrink')
  const sidecar = path.resolve(dir, slim.archived.file)
  assert.ok(fs.existsSync(sidecar), 'sidecar missing')
}

// ---------------------------------------------------------------------------
// 2 幂等：再迁移一次不改动任何东西
function testMigrationIsIdempotent () {
  const dir = tempDir()
  const file = writeLegacyLedger(dir, [run()])
  const first = store(file).load()
  const ledgerAfterFirst = fs.readFileSync(file, 'utf8')
  const second = store(file).load()
  assert.strictEqual(fs.readFileSync(file, 'utf8'), ledgerAfterFirst)
  assert.deepStrictEqual(second.runs[0].archived, first.runs[0].archived)
  // a second store must not overwrite the backup with the already-slim ledger
  const backup = JSON.parse(fs.readFileSync(path.join(dir, 'construction-runs.pre-archive.json'), 'utf8'))
  assert.strictEqual(backup.schemaVersion, 1)
  assert.ok(backup.runs[0].steps, 'backup lost the steps it exists to preserve')
}

// ---------------------------------------------------------------------------
// 3 补水：归档的大块逐字节读得回来
function testArchivedRunHydratesByteForByte () {
  const dir = tempDir()
  const original = run()
  const file = writeLegacyLedger(dir, [original])
  const s = store(file)
  s.load()
  const hydrated = s.getRun(original.runId)
  assert.deepStrictEqual(hydrated.steps, original.steps)
  assert.deepStrictEqual(hydrated.frozenBlueprintIR, original.frozenBlueprintIR)
  // opting out gives the slim record
  const slim = s.getRun(original.runId, { hydrate: false })
  assert.strictEqual(slim.steps, undefined)
  assert.ok(slim.archived)
}

// ---------------------------------------------------------------------------
// 4 不变量：续建对账与活跃判定不受影响
function testResumeMatchingSurvivesArchiving () {
  const dir = tempDir()
  const active = run({
    runId: 'construction_run_active01',
    status: 'BLOCKED_MATERIAL_SHORTAGE',
    terminalState: null,
    blueprintHash: 'hash_active'
  })
  const terminal = run()
  const file = writeLegacyLedger(dir, [terminal, active])
  const s = store(file)
  const runs = s.load().runs

  const criteria = {
    blueprintId: 'test_blueprint',
    blueprintHash: 'hash_active',
    placementContext: ORIGIN,
    world: WORLD
  }
  const found = s.findActiveCompatible(criteria)
  assert.ok(found, 'active run no longer matches')
  assert.strictEqual(found.runId, 'construction_run_active01')
  // the active run keeps everything: a resume needs its verified step ids now
  assert.ok(found.steps && Object.keys(found.steps).length === 40)
  assert.strictEqual(found.archived, undefined)

  const archivedTerminal = runs.find(entry => entry.runId === terminal.runId)
  assert.strictEqual(isRunActive(archivedTerminal), false)
  // the four fields constructionRunCompatibility() compares are untouched
  for (const entry of runs) {
    const source = entry.runId === active.runId ? active : terminal
    assert.strictEqual(
      constructionRunCompatibility(entry, {
        blueprintId: source.blueprintId,
        blueprintHash: source.blueprintHash,
        placementContext: source.placementContext,
        world: source.world
      }).ok,
      true,
      `compatibility changed for ${entry.runId}`
    )
  }
}

// ---------------------------------------------------------------------------
// 5 活跃 run 转终态时才拆：施工中一步都不动它
function testActiveRunIsSplitOnlyWhenItTurnsTerminal () {
  const dir = tempDir()
  const file = writeLegacyLedger(dir, [])
  const s = store(file)
  const active = run({ runId: 'construction_run_live0001', status: 'ACTIVE', terminalState: null })
  s.upsertRun(active)
  let stored = JSON.parse(fs.readFileSync(file, 'utf8')).runs[0]
  assert.ok(stored.steps, 'active run must stay whole in the ledger')
  assert.strictEqual(stored.archived, undefined)
  assert.strictEqual(fs.existsSync(path.join(dir, 'construction-runs-archive')), false)

  const completed = s.upsertRun({ ...active, status: 'COMPLETED', terminalState: 'COMPLETED' })
  // the caller keeps the whole run in hand (the session runs on it)
  assert.ok(completed.steps, 'upsertRun must return the run it was given')
  stored = JSON.parse(fs.readFileSync(file, 'utf8')).runs[0]
  assert.strictEqual(stored.steps, undefined)
  assert.ok(stored.archived)
  assert.deepStrictEqual(s.hydrateRun(stored).steps, active.steps)
}

// ---------------------------------------------------------------------------
// 6 更新归档过的 run：先补水再写，不会写出一条没有旁挂的瘦记录
function testUpdatingAnArchivedRunKeepsItsSidecar () {
  const dir = tempDir()
  const original = run()
  const file = writeLegacyLedger(dir, [original])
  const s = store(file)
  s.load()
  const updated = s.abandonRun(original.runId, 'test_reason', { note: 'x' })
  assert.strictEqual(updated.status, 'ABANDONED')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).runs[0]
  assert.strictEqual(stored.steps, undefined)
  assert.ok(stored.archived, 'archive pointer lost on update')
  assert.deepStrictEqual(s.hydrateRun(stored).steps, original.steps)
  assert.strictEqual(s.hydrateRun(stored).abandonReason, 'test_reason')
}

// ---------------------------------------------------------------------------
// 7 开关：BOT_CONSTRUCTION_RUN_ARCHIVE=0 回到旧行为
function testKillSwitchKeepsOldBehaviour () {
  const dir = tempDir()
  const file = writeLegacyLedger(dir, [run()])
  const before = fs.readFileSync(file, 'utf8')
  const document = store(file, { archiveTerminalRuns: false }).load()
  assert.strictEqual(document.schemaVersion, 1)
  assert.ok(document.runs[0].steps, 'kill switch still archived the run')
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'kill switch still rewrote the ledger')
  assert.strictEqual(fs.existsSync(path.join(dir, 'construction-runs.pre-archive.json')), false)
}

// ---------------------------------------------------------------------------
// 8 离线不迁移：连接断着时主档一个字不动
function testMigrationWaitsWhileOffline () {
  const dir = tempDir()
  const file = writeLegacyLedger(dir, [run()])
  const before = fs.readFileSync(file, 'utf8')
  const offline = store(file, { isWritable: () => false })
  const document = offline.load()
  assert.strictEqual(document.schemaVersion, 1)
  assert.ok(document.runs[0].steps)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before)
}

// ---------------------------------------------------------------------------
// 9 旁挂文件坏了/丢了不炸：拿得到瘦记录，读点自己会兜底
function testMissingSidecarDegradesGracefully () {
  const dir = tempDir()
  const original = run()
  const file = writeLegacyLedger(dir, [original])
  const s = store(file)
  const slim = s.load().runs[0]
  fs.rmSync(path.resolve(dir, slim.archived.file))
  const hydrated = s.hydrateRun(slim)
  assert.strictEqual(hydrated.steps, undefined)
  assert.strictEqual(hydrated.runId, original.runId)
  assert.strictEqual(hydrated.blueprintHash, 'hash_abc')
  assert.strictEqual(s.findActiveCompatible({ blueprintId: 'test_blueprint' }), null)
}

// ---------------------------------------------------------------------------
// 10 体积：终态 run 的大块确实离开了主档
function testLedgerShrinksByTheArchivedFields () {
  const dir = tempDir()
  const runs = [0, 1, 2, 3, 4].map(i => run({
    runId: `construction_run_bulk${i}`,
    steps: steps(600),
    status: i === 0 ? 'ACTIVE' : 'ABANDONED',
    terminalState: i === 0 ? null : 'ABANDONED'
  }))
  const file = writeLegacyLedger(dir, runs)
  const before = fs.statSync(file).size
  store(file).load()
  const after = fs.statSync(file).size
  assert.ok(after < before * 0.35, `ledger ${before} -> ${after}`)
  const archiveDir = path.join(dir, 'construction-runs-archive')
  assert.strictEqual(fs.readdirSync(archiveDir).length, 4, 'one sidecar per terminal run')
}


// ---------------------------------------------------------------------------
// 11 自制门楼夹具：run 归档后补水，步骤 id 与重新编译出来的计划一一对上
//    （建造 13 tests/construction-resume-plan-id.test.js 的思路，跑在归档之后）
function testGatehouseRunSurvivesArchiving () {
  const legacy = require(path.join(__dirname, 'fixtures', 'gatehouse-axis.json'))
  const adapted = new LegacyBlueprintAdapter().fromLegacyBlueprint(legacy)
  assert.strictEqual(adapted.ok, true, adapted.error)
  const validation = new BlueprintValidator().validate(adapted.blueprint)
  assert.strictEqual(validation.ok, true)
  const inv = { dirt: 5000, cobblestone: 5000, stone: 5000 }
  for (const block of legacy.blocks) {
    if (!block.type || /air$/.test(block.type)) continue
    for (const [item, count] of Object.entries(itemRequirementsForBlock(block.type, block.states || {}))) inv[item] = (inv[item] || 0) + count * 2
    inv[block.type] = (inv[block.type] || 0) + 4
  }
  const compiled = new ConstructionCompiler().compile({
    blueprint: validation.blueprint,
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0 },
    siteSnapshot: { blocks: [], inventoryCounts: inv },
    inventoryPolicy: { counts: inv },
    compilerOptions: { includeWalkabilityGate: true }
  })
  assert.strictEqual(compiled.ok, true, compiled.error)
  const plan = compiled.plan
  const built = createConstructionRun({
    blueprintId: plan.blueprintId,
    blueprintRevision: plan.blueprintRevision,
    blueprintHash: plan.blueprintHash,
    planId: plan.planId,
    placementContext: plan.placement,
    world: WORLD,
    frozenBlueprintIR: validation.blueprint,
    steps: compiled.legacy.orderPlan.steps
  })
  const terminal = { ...built, status: 'ABANDONED', terminalState: 'ABANDONED' }

  const dir = tempDir()
  const file = writeLegacyLedger(dir, [terminal])
  const s = store(file)
  const slim = s.load().runs[0]
  assert.strictEqual(slim.steps, undefined)
  assert.strictEqual(slim.stepCount, Object.keys(terminal.steps).length)
  assert.ok(slim.stepCount > 500, `stepCount=${slim.stepCount}`)

  const hydrated = s.getRun(terminal.runId)
  assert.deepStrictEqual(Object.keys(hydrated.steps).sort(), Object.keys(terminal.steps).sort())
  // every step id the recompiled plan names still resolves in the archived run
  for (const step of plan.steps) assert.ok(hydrated.steps[step.id], `step ${step.id} lost`)
  assert.strictEqual(hydrated.frozenBlueprintIR.id, validation.blueprint.id)
  // the four resume-matching fields are unchanged in the slim record
  assert.strictEqual(constructionRunCompatibility(slim, {
    blueprintId: plan.blueprintId,
    blueprintHash: plan.blueprintHash,
    placementContext: plan.placement,
    world: WORLD
  }).ok, true)
}

testLegacyLedgerMigratesOnFirstLoad()
testMigrationIsIdempotent()
testArchivedRunHydratesByteForByte()
testResumeMatchingSurvivesArchiving()
testActiveRunIsSplitOnlyWhenItTurnsTerminal()
testUpdatingAnArchivedRunKeepsItsSidecar()
testKillSwitchKeepsOldBehaviour()
testMigrationWaitsWhileOffline()
testMissingSidecarDegradesGracefully()
testLedgerShrinksByTheArchivedFields()
testGatehouseRunSurvivesArchiving()

console.log('construction run archive tests passed')
