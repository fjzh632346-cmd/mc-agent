const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  loadProtectedRegions,
  findProtectedRegionAt,
  checkProtectedBuildingDig,
  protectedBreakExclusions,
  resetProtectedRegionCache
} = require('../systems/protected-buildings')
const { resolveMovementProfile } = require('../actions/move')
const { ActionLock } = require('../core/action-lock')
const build = require('../actions/build')
const mine = require('../actions/mine')

function writeRunStore(runs) {
  const filePath = path.join(os.tmpdir(), `mc-protected-runs-${Date.now()}-${Math.random()}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, runs }), 'utf8')
  return filePath
}

const COMPLETED_RUN = {
  runId: 'construction_run_test_completed',
  blueprintId: 'test_cabin',
  status: 'COMPLETED',
  terminalState: 'COMPLETED',
  bounds: { minX: 100, maxX: 110, minY: 60, maxY: 70, minZ: -20, maxZ: -10 }
}
const ACTIVE_RUN = {
  runId: 'construction_run_test_active',
  blueprintId: 'other',
  status: 'ACTIVE',
  terminalState: null,
  bounds: { minX: 200, maxX: 210, minY: 60, maxY: 70, minZ: 0, maxZ: 10 }
}
const ABANDONED_RUN = {
  runId: 'construction_run_test_abandoned',
  blueprintId: 'other2',
  status: 'ABANDONED',
  terminalState: 'ABANDONED',
  bounds: { minX: 300, maxX: 310, minY: 60, maxY: 70, minZ: 0, maxZ: 10 }
}

function collectLogs() {
  const lines = []
  return { lines, logger: { log: line => lines.push(String(line)) } }
}

function testRegionsExtractedDynamicallyFromRunStore() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([COMPLETED_RUN, ACTIVE_RUN, ABANDONED_RUN])
  const regions = loadProtectedRegions({ runStorePath: storePath })
  assert.strictEqual(regions.length, 1, 'only COMPLETED runs are protected')
  assert.strictEqual(regions[0].runId, COMPLETED_RUN.runId)
  // margin 1 applied on every axis
  assert.deepStrictEqual(regions[0].bounds, { minX: 99, maxX: 111, minY: 59, maxY: 71, minZ: -21, maxZ: -9 })
  // region lookup: inside (incl. margin shell) vs outside
  assert.ok(findProtectedRegionAt({ x: 105, y: 65, z: -15 }, { runStorePath: storePath }))
  assert.ok(findProtectedRegionAt({ x: 99, y: 59, z: -21 }, { runStorePath: storePath }), 'margin shell protected')
  assert.strictEqual(findProtectedRegionAt({ x: 98, y: 65, z: -15 }, { runStorePath: storePath }), null)
  assert.strictEqual(findProtectedRegionAt({ x: 205, y: 65, z: 5 }, { runStorePath: storePath }), null, 'ACTIVE not protected')
}

function testDigGuardBlocksAndLogs() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([COMPLETED_RUN])
  const { lines, logger } = collectLogs()
  const context = { logger, protectedBuildingRunStorePath: storePath }

  const blocked = checkProtectedBuildingDig(context, { x: 105, y: 65, z: -15 }, { source: 'unit_test_digger' })
  assert.strictEqual(blocked.allowed, false)
  assert.strictEqual(blocked.region.runId, COMPLETED_RUN.runId)
  const logLine = lines.find(line => line.includes('[PROTECTED_BUILDING_DIG_BLOCKED]'))
  assert.ok(logLine, 'blocked log emitted')
  assert.ok(logLine.includes('pos=105,65,-15'), logLine)
  assert.ok(logLine.includes(`runId=${COMPLETED_RUN.runId}`), logLine)
  assert.ok(logLine.includes('source=unit_test_digger'), logLine)

  const outside = checkProtectedBuildingDig(context, { x: 500, y: 65, z: 500 }, { source: 'unit_test_digger' })
  assert.strictEqual(outside.allowed, true)
  assert.strictEqual(outside.region, null)
}

function testExemptionByRunIdOnly() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([COMPLETED_RUN])
  const { lines, logger } = collectLogs()
  const context = { logger, protectedBuildingRunStorePath: storePath }

  // same runId (reconciliation/repair of its own building): allowed + logged
  const exempt = checkProtectedBuildingDig(context, { x: 105, y: 65, z: -15 }, {
    source: 'reconciliation_repair',
    exemptRunId: COMPLETED_RUN.runId
  })
  assert.strictEqual(exempt.allowed, true)
  assert.strictEqual(exempt.exempted, true)
  assert.ok(lines.some(line => line.includes('[PROTECTED_BUILDING_DIG_EXEMPT]') && line.includes(`exemptRunId=${COMPLETED_RUN.runId}`)))

  // foreign runId: still blocked
  const foreign = checkProtectedBuildingDig(context, { x: 105, y: 65, z: -15 }, {
    source: 'reconciliation_repair',
    exemptRunId: 'construction_run_other'
  })
  assert.strictEqual(foreign.allowed, false)

  // context.activeConstructionRunId also grants (building-system executeStep path)
  const viaContext = checkProtectedBuildingDig(
    { logger, protectedBuildingRunStorePath: storePath, activeConstructionRunId: COMPLETED_RUN.runId },
    { x: 105, y: 65, z: -15 },
    { source: 'executor' }
  )
  assert.strictEqual(viaContext.allowed, true)
}

function testMovementProfileDefaults() {
  // non-construction default: no digging, no towers, no scaffolding
  assert.deepStrictEqual(resolveMovementProfile({}), { canDig: false, allowScaffolding: false, allow1by1towers: false })
  // construction moves that opt in keep digging
  assert.strictEqual(resolveMovementProfile({ canDig: true }).canDig, true)
  // explicit false stays false
  assert.strictEqual(resolveMovementProfile({ canDig: false }).canDig, false)
  // scaffolding remains opt-in
  const scaffolding = resolveMovementProfile({ allowScaffolding: true })
  assert.strictEqual(scaffolding.allowScaffolding, true)
  assert.strictEqual(scaffolding.allow1by1towers, true)
}

function testProtectedBreakExclusions() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([COMPLETED_RUN])
  const context = { protectedBuildingRunStorePath: storePath }
  const [exclusion] = protectedBreakExclusions(context, {})
  assert.strictEqual(exclusion({ position: { x: 105, y: 65, z: -15 } }), Infinity, 'protected block break penalty')
  assert.strictEqual(exclusion({ position: { x: 500, y: 65, z: 500 } }), 0)
  const [exempt] = protectedBreakExclusions(context, { exemptRunId: COMPLETED_RUN.runId })
  assert.strictEqual(exempt({ position: { x: 105, y: 65, z: -15 } }), 0, 'own run may plan breaks in its building')
}

async function testClearBlockForBuildingHonorsGuard() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([COMPLETED_RUN])
  const { lines, logger } = collectLogs()
  const digs = []
  const inside = { x: 105, y: 65, z: -15 }
  const dug = new Set()
  const keyOf = p => `${p.x},${p.y},${p.z}`
  const bot = {
    entity: { position: { x: 105, y: 65, z: -14, distanceTo: () => 1 } },
    blockAt: position => dug.has(keyOf(position))
      ? { name: 'air', position }
      : { name: 'oak_planks', position, boundingBox: 'block' },
    canDigBlock: () => true,
    pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
    async dig(block) { digs.push(block.position); dug.add(keyOf(block.position)) }
  }
  const context = { bot, actionLock: new ActionLock(), logger, protectedBuildingRunStorePath: storePath, debug: () => {} }

  const refused = await build.clearBlockForBuilding(context, inside, { owner: 'test', timeoutMs: 500 })
  assert.strictEqual(refused.ok, false)
  assert.ok(String(refused.error).startsWith('protected_building_dig_blocked:'), refused.error)
  assert.strictEqual(digs.length, 0, 'no dig happened inside protected region')
  assert.ok(lines.some(line => line.includes('[PROTECTED_BUILDING_DIG_BLOCKED]')))

  // exemption: the run's own repair may clear
  const exempted = await build.clearBlockForBuilding(context, inside, {
    owner: 'test',
    timeoutMs: 500,
    protectionExemptRunId: COMPLETED_RUN.runId
  })
  assert.strictEqual(exempted.ok, true, exempted.error)
  assert.strictEqual(digs.length, 1)
}

async function testMineBlockHonorsGuard() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([COMPLETED_RUN])
  const { lines, logger } = collectLogs()
  const digs = []
  const position = { x: 105, y: 65, z: -15, distanceTo: () => 1 }
  const block = { name: 'oak_planks', position, boundingBox: 'block' }
  const bot = {
    entity: { position: { x: 105, y: 65, z: -14, distanceTo: () => 1 } },
    blockAt: () => block,
    canDigBlock: () => true,
    inventory: { items: () => [] },
    pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
    async dig(target) { digs.push(target.position) }
  }
  const context = {
    bot,
    actionLock: new ActionLock(),
    logger,
    protectedBuildingRunStorePath: storePath,
    blackboard: { get: () => null, getData: () => null },
    debug: () => {}
  }
  const result = await mine.mineBlock(context, block, { owner: 'test', timeoutMs: 500 })
  assert.strictEqual(result.ok, false)
  assert.ok(String(result.error).startsWith('protected_building_dig_blocked:'), result.error)
  assert.strictEqual(digs.length, 0)
  assert.ok(lines.some(line => line.includes('[PROTECTED_BUILDING_DIG_BLOCKED]') && line.includes('source=test')))
}

// --- RENOVATION lineage (docs/RENOVATION_FLOW_DESIGN.md) ---

const RENO_OLD = {
  runId: 'construction_run_reno_old',
  blueprintId: 'cabin',
  status: 'COMPLETED',
  terminalState: 'COMPLETED',
  bounds: { minX: 100, maxX: 110, minY: 60, maxY: 70, minZ: -20, maxZ: -10 }
}
const RENO_ACTIVE = {
  runId: 'construction_run_reno_active',
  blueprintId: 'cabin',
  status: 'ACTIVE',
  terminalState: null,
  renovationOf: RENO_OLD.runId,
  bounds: { minX: 100, maxX: 110, minY: 60, maxY: 73, minZ: -20, maxZ: -10 }
}

function testActiveRenovationExtendsRegionAndGetsOneHopExemption() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([RENO_OLD, RENO_ACTIVE])
  const { lines, logger } = collectLogs()
  const context = { logger, protectedBuildingRunStorePath: storePath }

  // single region (old building), bounds unioned with the active renovation
  const regions = loadProtectedRegions({ runStorePath: storePath })
  assert.strictEqual(regions.length, 1)
  assert.strictEqual(regions[0].runId, RENO_OLD.runId)
  assert.deepStrictEqual(regions[0].activeRenovationRunIds, [RENO_ACTIVE.runId])
  assert.strictEqual(regions[0].bounds.maxY, 74, 'active renovation bounds unioned (+margin)')

  // the renovation run may dig the building it renovates (one direct hop)
  const exempt = checkProtectedBuildingDig(context, { x: 105, y: 65, z: -15 }, {
    source: 'renovation_demolition',
    exemptRunId: RENO_ACTIVE.runId
  })
  assert.strictEqual(exempt.allowed, true)
  assert.strictEqual(exempt.via, 'renovationOf')
  assert.ok(lines.some(line => line.includes('[PROTECTED_BUILDING_DIG_EXEMPT]') && line.includes('via=renovationOf')))

  // any other completed building still refuses the renovation run
  resetProtectedRegionCache()
  const blockedForeign = checkProtectedBuildingDig({ logger, protectedBuildingRunStorePath: writeRunStore([
    { ...COMPLETED_RUN, bounds: { minX: 300, maxX: 310, minY: 60, maxY: 70, minZ: 0, maxZ: 10 } },
    RENO_OLD,
    RENO_ACTIVE
  ]) }, { x: 305, y: 65, z: 5 }, { source: 'renovation_demolition', exemptRunId: RENO_ACTIVE.runId })
  assert.strictEqual(blockedForeign.allowed, false, 'renovation exemption never crosses to other buildings')
}

function testCompletedRenovationDedupesRosterToLatestGeneration() {
  resetProtectedRegionCache()
  const renoCompleted = {
    ...RENO_ACTIVE,
    status: 'COMPLETED',
    terminalState: 'COMPLETED'
  }
  const storePath = writeRunStore([RENO_OLD, renoCompleted])
  const regions = loadProtectedRegions({ runStorePath: storePath })
  assert.strictEqual(regions.length, 1, 'lineage produces a single protected region')
  assert.strictEqual(regions[0].runId, renoCompleted.runId, 'latest generation owns the region')
  // the old box is still inside the new region (protection continuity), but
  // attribution moved to the new run
  const region = findProtectedRegionAt({ x: 105, y: 65, z: -15 }, { runStorePath: storePath })
  assert.strictEqual(region.runId, renoCompleted.runId)
}

function testAbandonedRenovationFallsBackToOldBuilding() {
  resetProtectedRegionCache()
  const renoAbandoned = {
    ...RENO_ACTIVE,
    status: 'ABANDONED',
    terminalState: 'ABANDONED'
  }
  const storePath = writeRunStore([RENO_OLD, renoAbandoned])
  const regions = loadProtectedRegions({ runStorePath: storePath })
  assert.strictEqual(regions.length, 1)
  assert.strictEqual(regions[0].runId, RENO_OLD.runId, 'roster falls back to the old building')
  assert.strictEqual(regions[0].bounds.maxY, 71, 'abandoned renovation no longer extends bounds')

  // an abandoned renovation run loses its dig exemption
  resetProtectedRegionCache()
  const { lines, logger } = collectLogs()
  const denied = checkProtectedBuildingDig({ logger, protectedBuildingRunStorePath: storePath }, { x: 105, y: 65, z: -15 }, {
    source: 'renovation_demolition',
    exemptRunId: renoAbandoned.runId
  })
  assert.strictEqual(denied.allowed, false, 'terminal renovation run has no exemption')
  assert.ok(lines.some(line => line.includes('[PROTECTED_BUILDING_DIG_BLOCKED]')))
}

function testRenovationExemptionChainIsHardCappedAtOneHop() {
  resetProtectedRegionCache()
  // R1 completed; R2 renovation of R1, ABANDONED (so R1 still owns a region);
  // R3 active renovation of R2. R3 digging in R1's region is a TRANSITIVE
  // exemption request and must be rejected with the chain log.
  const r1 = { ...RENO_OLD, runId: 'construction_run_gen1' }
  const r2 = {
    runId: 'construction_run_gen2_reno',
    blueprintId: 'cabin',
    status: 'ABANDONED',
    terminalState: 'ABANDONED',
    renovationOf: r1.runId,
    bounds: r1.bounds
  }
  const r3 = {
    runId: 'construction_run_gen3_reno',
    blueprintId: 'cabin',
    status: 'ACTIVE',
    terminalState: null,
    renovationOf: r2.runId,
    bounds: r1.bounds
  }
  const storePath = writeRunStore([r1, r2, r3])
  const { lines, logger } = collectLogs()
  const denied = checkProtectedBuildingDig({ logger, protectedBuildingRunStorePath: storePath }, { x: 105, y: 65, z: -15 }, {
    source: 'renovation_demolition',
    exemptRunId: r3.runId
  })
  assert.strictEqual(denied.allowed, false, 'two-hop renovation chain must be refused')
  const chainLine = lines.find(line => line.includes('[PROTECTED_BUILDING_RENOVATION_CHAIN_REJECTED]'))
  assert.ok(chainLine, 'chain rejection is logged loudly')
  assert.ok(chainLine.includes('chainHops=2'), chainLine)
  assert.ok(lines.some(line => line.includes('[PROTECTED_BUILDING_DIG_BLOCKED]')))
}

function testBreakExclusionsHonorRenovationExemption() {
  resetProtectedRegionCache()
  const storePath = writeRunStore([RENO_OLD, RENO_ACTIVE])
  const context = { protectedBuildingRunStorePath: storePath }
  const [blockedFn] = protectedBreakExclusions(context, { exemptRunId: 'construction_run_unrelated' })
  assert.strictEqual(blockedFn({ position: { x: 105, y: 65, z: -15 } }), Infinity)
  const [renovationFn] = protectedBreakExclusions(context, { exemptRunId: RENO_ACTIVE.runId })
  assert.strictEqual(renovationFn({ position: { x: 105, y: 65, z: -15 } }), 0, 'renovation run may plan breaks in the renovated building')
}

async function run() {
  testRegionsExtractedDynamicallyFromRunStore()
  testDigGuardBlocksAndLogs()
  testExemptionByRunIdOnly()
  testMovementProfileDefaults()
  testProtectedBreakExclusions()
  await testClearBlockForBuildingHonorsGuard()
  await testMineBlockHonorsGuard()
  testActiveRenovationExtendsRegionAndGetsOneHopExemption()
  testCompletedRenovationDedupesRosterToLatestGeneration()
  testAbandonedRenovationFallsBackToOldBuilding()
  testRenovationExemptionChainIsHardCappedAtOneHop()
  testBreakExclusionsHonorRenovationExemption()
  resetProtectedRegionCache()
  console.log('protected buildings tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
