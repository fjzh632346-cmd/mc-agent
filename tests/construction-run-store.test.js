const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { BuildingSystem, _test: buildingSystemTest } = require('../systems/building-system')
const { CONSTRUCTION_PHASE_ORDER, REQUIRED_DESIGN_SPEC_FIELDS, normalizeConstructionPhase } = require('../systems/building-design-spec')
const {
  ConstructionRunStore,
  STEP_STATE,
  constructionRunCompatibility,
  createConstructionRun,
  isRunActive
} = require('../systems/construction-run-store')

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function createContext(items = [], options = {}) {
  const placed = []
  const cleared = []
  const occupied = new Map()
  const states = new Map()
  for (const entry of options.occupied || []) {
    const key = `${entry.x},${entry.y},${entry.z}`
    occupied.set(key, entry.name || entry.type || 'stone')
    if (entry.states) states.set(key, entry.states)
  }
  const bot = {
    username: 'LinXia',
    game: { dimension: options.dimension || 'overworld' },
    entity: { position: vec(0, 64, 0), onGround: true },
    entities: {},
    registry: {
      itemsByName: Object.fromEntries(items.map(item => [item.name, { name: item.name, stackSize: 64 }])),
      blocksByName: {}
    },
    heldItem: null,
    inventory: {
      items: () => items.filter(item => item.count > 0),
      slots: Array.from({ length: 45 }, () => null)
    },
    pathfinder: {
      setMovements() {},
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = vec(goal.x, goal.y, goal.z)
        }
      },
      stop() {}
    },
    blockAt(position) {
      const key = `${position.x},${position.y},${position.z}`
      if (occupied.has(key)) {
        return {
          name: occupied.get(key),
          position,
          getProperties: () => states.get(key) || {}
        }
      }
      if (position.y === 63) return { name: 'stone', position, getProperties: () => ({}) }
      return { name: 'air', position, getProperties: () => ({}) }
    },
    async equip(item) {
      this.heldItem = item
    },
    async placeBlock(reference, faceVector) {
      const position = {
        x: reference.position.x + faceVector.x,
        y: reference.position.y + faceVector.y,
        z: reference.position.z + faceVector.z
      }
      const key = `${position.x},${position.y},${position.z}`
      occupied.set(key, this.heldItem?.name || options.defaultPlacedBlock || 'oak_planks')
      states.set(key, options.placeStates?.[key] || {})
      placed.push({ position, blockName: occupied.get(key) })
    },
    canDigBlock() {
      return true
    },
    async dig(block) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      occupied.delete(key)
      states.delete(key)
      cleared.push({ name: block.name, position: block.position })
    }
  }
  return {
    bot,
    placed,
    cleared,
    occupied,
    states,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard: new Blackboard({
      bot: { position: { x: 0, y: 64, z: 0 } },
      inventory: { counts: Object.fromEntries(items.map(item => [item.name, item.count])) },
      mobs: { dangerLevel: 'none' }
    }),
    storageSystem: options.storageSystem || null,
    logger: { log() {} },
    debug() {}
  }
}

function createBlueprintDir(blueprints) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-resume-blueprints-'))
  for (const blueprint of blueprints) {
    fs.writeFileSync(path.join(dir, `${blueprint.name}.json`), JSON.stringify(blueprint), 'utf8')
  }
  return dir
}

function createRunStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-construction-runs-'))
  return new ConstructionRunStore({ filePath: path.join(root, 'construction-runs.json') })
}

function testSaveFallsBackToCopyWhenAtomicRenameIsTemporarilyLocked() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-construction-runs-rename-'))
  const filePath = path.join(root, 'construction-runs.json')
  const store = new ConstructionRunStore({ filePath })
  const originalRenameSync = fs.renameSync
  let renameAttempts = 0
  fs.renameSync = function simulatedRenameLock() {
    renameAttempts += 1
    const error = new Error('simulated Windows file lock')
    error.code = 'EPERM'
    throw error
  }

  try {
    const saved = store.save({ runs: [{ runId: 'run_eprem_save_fallback', status: 'ACTIVE' }] })
    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const tempFiles = fs.readdirSync(root).filter(name => name.startsWith('construction-runs.json.tmp-'))

    assert.strictEqual(saved.runs[0].runId, 'run_eprem_save_fallback')
    assert.strictEqual(loaded.runs[0].runId, 'run_eprem_save_fallback')
    assert.ok(renameAttempts > 0)
    assert.deepStrictEqual(tempFiles, [])
  } finally {
    fs.renameSync = originalRenameSync
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function createPhysicalStagingReader(counts = {}) {
  return {
    async getStagingInventory(context, options = {}) {
      const chests = []
      for (const center of options.scanCenters || []) {
        const position = center.position || center
        if (!position) continue
        if (context.bot.blockAt(vec(position.x, position.y, position.z)).name !== 'chest') continue
        chests.push({
          position,
          source: center.source || 'test_physical_staging_chest',
          itemCount: Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0)
        })
      }
      return {
        counts: chests.length ? { ...counts } : {},
        chests
      }
    }
  }
}

function createBuildingSystem(options = {}) {
  const sampleBlueprint = plankLineBlueprint('community_sample', 3)
  return new BuildingSystem({
    communityCollector: {
      loadSamples() {
        return {
          ok: true,
          source: 'test_community_fixture',
          samples: [{
            id: 'test-community-sample',
            blueprintName: sampleBlueprint.name,
            sourceKind: 'test_fixture',
            blueprint: sampleBlueprint
          }]
        }
      }
    },
    designer: {
      transformBlueprint(blueprint) {
        return {
          ok: true,
          blueprint,
          design: { strategy: 'identity_test_designer' },
          diagnostics: {}
        }
      }
    },
    // This suite asserts each persisted transition directly. Production
    // batching is covered in blueprint-building.test.js.
    constructionCheckpointStepInterval: 1,
    ...options
  })
}

function plankLineBlueprint(name = 'resume_line', count = 5) {
  return {
    name,
    origin: { x: 0, y: 0, z: 0 },
    blocks: Array.from({ length: count }, (_, x) => ({ x, y: 0, z: 0, type: 'oak_planks' }))
  }
}

function grassTerrainBlueprint(name = 'terrain_grass', count = 3) {
  return {
    name,
    origin: { x: 0, y: 0, z: 0 },
    blocks: Array.from({ length: count }, (_, x) => ({ x, y: 0, z: 0, type: 'grass_block' }))
  }
}

function snowyGrassTerrainBlueprint(name = 'terrain_snowy_grass') {
  return {
    name,
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'grass_block', states: { snowy: 'false' } }]
  }
}

function azaleaLeafBlueprint(name = 'leaf_override_resume') {
  return {
    name,
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'azalea_leaves' }]
  }
}

function mirroredWallButtonBlueprint(name = 'state_override_wall_button') {
  return {
    name,
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'dark_oak_button', states: { face: 'wall', facing: 'south', powered: 'false' } },
      { x: 0, y: 0, z: 1, type: 'stone' }
    ]
  }
}

async function startSystem(system, ctx, blueprintName, origin = { x: 0, y: 64, z: 0 }) {
  const started = await system.buildBlueprint(ctx, blueprintName, origin, {
    owner: 'test',
    explicitOrigin: true
  })
  assert.strictEqual(started.ok, true, started.error)
  return started
}

async function startSystemWithOptions(system, ctx, blueprintName, origin = { x: 0, y: 64, z: 0 }, options = {}) {
  const started = await system.buildBlueprint(ctx, blueprintName, origin, {
    owner: 'test',
    explicitOrigin: true,
    ...options
  })
  return started
}

function activeRun(store) {
  return store.listRuns().find(isRunActive)
}

function findPlacementStep(run, blockName) {
  return Object.values(run.steps || {}).find(step => {
    const stepBlockName = step.block?.id || step.resolvedBlock?.id || step.blockName
    return (step.action === 'place' || step.legacyKind === 'place') && stepBlockName === blockName
  })
}

async function testPartialRunResumeDoesNotReplayVerifiedBlocks() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('resume_line', 5)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'resume_line')
  await system1.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 2 })
  assert.strictEqual(ctx.placed.length, 2)

  ctx.placed.length = 0
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'resume_line')
  const resumed = system2.getStatus().constructionRun
  assert.strictEqual(resumed.statusCounts.verified, 2, JSON.stringify(resumed))
  const resumedPlacement = await system2.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(ctx.placed.length, 1, JSON.stringify({ resumedPlacement, status: system2.getStatus() }))
  assert.deepStrictEqual(ctx.placed[0].position, { x: 2, y: 64, z: 0 })
}

async function testImplicitOriginUsesActiveRunPlacement() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('implicit_origin_resume', 3)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'implicit_origin_resume', { x: 0, y: 64, z: 0 })
  await system1.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  const runId = activeRun(store).runId

  ctx.bot.entity.position = vec(8, 64, 0)
  ctx.blackboard.set('bot.position', { x: 8, y: 64, z: 0 })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await system2.buildBlueprint(ctx, 'implicit_origin_resume', null, { owner: 'test' })

  assert.strictEqual(started.ok, true, started.error)
  const status = system2.getStatus()
  assert.strictEqual(system2.session.resumedConstructionRun, true)
  assert.strictEqual(status.constructionRun.runId, runId)
  assert.deepStrictEqual(status.origin, { x: 0, y: 64, z: 0 })
  assert.strictEqual(store.getRun(runId).status, 'ACTIVE')
}

async function testLegacyRunWorldIdentityUpgradesThenGuardsResume() {
  const previousWorldId = process.env.MC_WORLD_ID
  try {
    delete process.env.MC_WORLD_ID
    const store = createRunStore()
    const dir = createBlueprintDir([plankLineBlueprint('world_identity_resume', 3)])
    const ctx = createContext([{ name: 'oak_planks', count: 20 }])
    const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
    await startSystem(system1, ctx, 'world_identity_resume')
    await system1.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
    const legacyRun = activeRun(store)
    assert.deepStrictEqual(legacyRun.world, { dimension: 'overworld' })

    process.env.MC_WORLD_ID = 'building-A:test-world'
    const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
    const resumed = await startSystemWithOptions(system2, ctx, 'world_identity_resume', { x: 0, y: 64, z: 0 }, {
      resumeOnly: true,
      allowFreshBuild: false
    })
    assert.strictEqual(resumed.ok, true, resumed.error)
    const upgraded = store.getRun(legacyRun.runId)
    assert.deepStrictEqual(upgraded.world, {
      dimension: 'overworld',
      worldId: 'building-A:test-world',
      identitySource: 'MC_WORLD_ID'
    })
    assert.strictEqual(upgraded.resumeHistory.length, 1)
    assert.strictEqual(upgraded.resumeHistory[0].invariants.world.worldId, 'building-A:test-world')
    assert.deepStrictEqual(upgraded.resumeHistory[0].worldIdentityUpgrade, {
      from: null,
      to: 'building-A:test-world',
      source: 'MC_WORLD_ID'
    })

    delete process.env.MC_WORLD_ID
    const system3 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
    const unverified = await startSystemWithOptions(system3, ctx, 'world_identity_resume', { x: 0, y: 64, z: 0 }, {
      resumeOnly: true,
      allowFreshBuild: false
    })
    assert.strictEqual(unverified.ok, false)
    assert.strictEqual(unverified.error, 'BUG_FRESH_BUILD_ATTEMPTED')
    assert.strictEqual(unverified.reason, 'world_identity_unverified')
    assert.strictEqual(store.getRun(legacyRun.runId).status, 'ACTIVE')
  } finally {
    if (previousWorldId === undefined) delete process.env.MC_WORLD_ID
    else process.env.MC_WORLD_ID = previousWorldId
  }
}

async function testPlacedButUnverifiedStepRecoversFromWorldScan() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('placed_scan', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'placed_scan')
  const run = activeRun(store)
  const stepId = Object.keys(run.steps)[0]
  ctx.occupied.set('0,64,0', 'oak_planks')
  store.updateStep(run.runId, stepId, { status: STEP_STATE.PLACED })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'placed_scan')
  assert.strictEqual(activeRun(store).steps[stepId].status, STEP_STATE.VERIFIED)
}

async function testExecutingStepWithoutWorldChangeReconcilesToPending() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('executing_pending', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'executing_pending')
  const run = activeRun(store)
  const stepId = Object.keys(run.steps)[0]
  store.updateStep(run.runId, stepId, { status: STEP_STATE.EXECUTING })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'executing_pending')

  const resumedRun = activeRun(store)
  assert.strictEqual(resumedRun.steps[stepId].status, STEP_STATE.PENDING)
  assert.strictEqual(system2.session.currentStepIndex, 0)
}

async function testVerifiedCheckpointMissingBlockBecomesPending() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('missing_checkpoint', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'missing_checkpoint')
  const run = activeRun(store)
  const stepId = Object.keys(run.steps)[0]
  store.updateStep(run.runId, stepId, { status: STEP_STATE.VERIFIED })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'missing_checkpoint')
  assert.strictEqual(activeRun(store).steps[stepId].status, STEP_STATE.PENDING)
  await system2.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(ctx.bot.blockAt(vec(0, 64, 0)).name, 'oak_planks')
}

async function testVerifiedCheckpointWrongBlockBecomesRepair() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('wrong_checkpoint', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'cobblestone' }]
  })
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'wrong_checkpoint')
  const run = activeRun(store)
  const placeStep = Object.values(run.steps).find(step => step.block?.id === 'oak_planks')
  store.updateStep(run.runId, placeStep.id, { status: STEP_STATE.VERIFIED })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'wrong_checkpoint')
  assert.strictEqual(activeRun(store).steps[placeStep.id].status, STEP_STATE.REPAIR)
}

async function testWrongOrientationEntersStateRepair() {
  const store = createRunStore()
  const blueprint = {
    name: 'state_repair',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'oak_stairs', states: { facing: 'east' } }]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([{ name: 'oak_stairs', count: 3 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'state_repair')
  ctx.occupied.set('0,64,0', 'oak_stairs')
  ctx.states.set('0,64,0', { facing: 'west' })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'state_repair')
  const run = activeRun(store)
  const step = Object.values(run.steps).find(entry => entry.block?.id === 'oak_stairs')
  assert.strictEqual(step.status, STEP_STATE.STATE_REPAIR)
}

async function testFunctionalContentsDoNotEnterStateRepair() {
  const store = createRunStore()
  const blueprint = {
    name: 'functional_runtime_contents',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      {
        x: 0,
        y: 0,
        z: 0,
        type: 'lectern',
        states: { has_book: 'true', powered: 'false', facing: 'west' }
      },
      {
        x: 1,
        y: 0,
        z: 0,
        type: 'brewing_stand',
        states: { has_bottle_0: 'true', has_bottle_1: 'true', has_bottle_2: 'false' }
      }
    ]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([
    { name: 'lectern', count: 1 },
    { name: 'brewing_stand', count: 1 }
  ])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'functional_runtime_contents')
  ctx.occupied.set('0,64,0', 'lectern')
  ctx.states.set('0,64,0', { has_book: false, powered: false, facing: 'west' })
  ctx.occupied.set('1,64,0', 'brewing_stand')
  ctx.states.set('1,64,0', { has_bottle_0: false, has_bottle_1: false, has_bottle_2: false })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'functional_runtime_contents')
  const run = activeRun(store)
  assert.strictEqual(findPlacementStep(run, 'lectern').status, STEP_STATE.VERIFIED)
  assert.strictEqual(findPlacementStep(run, 'brewing_stand').status, STEP_STATE.VERIFIED)
}

async function testLecternFacingStillEntersStateRepair() {
  const store = createRunStore()
  const blueprint = {
    name: 'lectern_facing_repair',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{
      x: 0,
      y: 0,
      z: 0,
      type: 'lectern',
      states: { has_book: 'true', powered: 'false', facing: 'west' }
    }]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([{ name: 'lectern', count: 1 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'lectern_facing_repair')
  ctx.occupied.set('0,64,0', 'lectern')
  ctx.states.set('0,64,0', { has_book: false, powered: false, facing: 'east' })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'lectern_facing_repair')
  const run = activeRun(store)
  assert.strictEqual(findPlacementStep(run, 'lectern').status, STEP_STATE.STATE_REPAIR)
}

async function testLeafDistanceDoesNotEnterStateRepair() {
  const store = createRunStore()
  const blueprint = {
    name: 'leaf_dynamic_state',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{
      x: 0,
      y: 0,
      z: 0,
      type: 'azalea_leaves',
      states: { distance: '1', persistent: 'true', waterlogged: 'false' }
    }]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([{ name: 'azalea_leaves', count: 1 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'leaf_dynamic_state')
  ctx.occupied.set('0,64,0', 'azalea_leaves')
  ctx.states.set('0,64,0', { distance: '7', persistent: 'true', waterlogged: 'false' })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'leaf_dynamic_state')
  const run = activeRun(store)
  const step = findPlacementStep(run, 'azalea_leaves')
  assert.strictEqual(step.status, STEP_STATE.VERIFIED)
}

async function testFenceConnectionsDoNotEnterStateRepair() {
  const store = createRunStore()
  const blueprint = {
    name: 'fence_dynamic_state',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{
      x: 0,
      y: 0,
      z: 0,
      type: 'spruce_fence',
      states: { north: 'true', west: 'true', east: 'false', south: 'false', waterlogged: 'false' }
    }]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([{ name: 'spruce_fence', count: 1 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'fence_dynamic_state')
  ctx.occupied.set('0,64,0', 'spruce_fence')
  ctx.states.set('0,64,0', { north: 'false', west: 'false', east: 'false', south: 'false', waterlogged: 'false' })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'fence_dynamic_state')
  const run = activeRun(store)
  const step = findPlacementStep(run, 'spruce_fence')
  assert.strictEqual(step.status, STEP_STATE.VERIFIED)
}

async function testLadderIgnoresSanitizedScaffoldingStates() {
  const store = createRunStore()
  const blueprint = {
    name: 'ladder_sanitized_scaffolding_state',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{
      x: 0,
      y: 0,
      z: 0,
      type: 'ladder',
      states: { waterlogged: 'false', distance: '0', bottom: 'false' }
    }]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([{ name: 'ladder', count: 1 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'ladder_sanitized_scaffolding_state')
  ctx.occupied.set('0,64,0', 'ladder')
  ctx.states.set('0,64,0', { waterlogged: false, facing: 'north' })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'ladder_sanitized_scaffolding_state')
  const run = activeRun(store)
  const step = findPlacementStep(run, 'ladder')
  assert.strictEqual(step.status, STEP_STATE.VERIFIED)
}

async function testStagingInventoryRestoresAndBlocksShortage() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('staging_restore', 2)])
  const calls = []
  const storageSystem = {
    async takeItems() {
      return { ok: false, error: 'not_used_in_resume_inventory_test' }
    },
    async getStagingInventory(context, options) {
      calls.push(options)
      return {
        counts: { oak_planks: 1 },
        chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'test_staging_chest', itemCount: 1 }]
      }
    }
  }
  const ctx = createContext([], { storageSystem })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await system.buildBlueprint(ctx, 'staging_restore', { x: 0, y: 64, z: 0 }, {
    owner: 'test',
    explicitOrigin: true,
    stagedStorageRefill: true
  })
  assert.strictEqual(started.ok, true, started.error)
  assert.ok(calls.length >= 2)
  assert.ok(calls[0].scanCenters.some(center => center.source === 'build_storage_1'))
  assert.ok(calls.some(call => call.reason === 'construction_run_resume_inventory_reconcile_primary'))
  const blocked = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(blocked.ok, false)
  assert.ok(blocked.error.startsWith('BLOCKED_MATERIAL_SHORTAGE:frame:oak_planks:1'), blocked.error)
}

async function testRunPersistsDesignSpecLifecycleAndArchive() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('archive_fixture', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'archive_fixture')

  const run = activeRun(store)
  assert.strictEqual(run.designSpec.frozen, true)
  for (const field of REQUIRED_DESIGN_SPEC_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(run.designSpec, field), `missing DesignSpec field ${field}`)
  }
  assert.strictEqual(run.blueprintFreeze.frozen, true)
  assert.strictEqual(run.blueprintFreeze.designSpecRevision, run.designSpec.revision)
  assert.strictEqual(run.frozenBlueprintIR.metadata.frozen, true)
  assert.strictEqual(run.materialStats.required.oak_planks, 1)
  assert.deepStrictEqual(run.lifecycle.phaseOrder, CONSTRUCTION_PHASE_ORDER)
  assert.strictEqual(run.lifecycle.gates.designComplete, true)
  assert.strictEqual(run.lifecycle.gates.blueprintFrozen, true)
  assert.strictEqual(run.lifecycle.gates.constructionPlanCompiled, true)

  await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 4 })
  const completed = store.getRun(run.runId)
  assert.strictEqual(completed.terminalState, 'COMPLETED')
  assert.strictEqual(completed.lifecycle.terminal, true)
  assert.deepStrictEqual(completed.lifecycle.phaseOrder, CONSTRUCTION_PHASE_ORDER)
  assert.strictEqual(completed.archive.designSpec.revision, run.designSpec.revision)
  assert.strictEqual(completed.archive.blueprintIR.metadata.frozen, true)
  assert.strictEqual(completed.archive.materialStats.required.oak_planks, 1)
  assert.ok(Number.isFinite(completed.archive.actualDurationMs))
  assert.deepStrictEqual(completed.archive.failuresAndRepairs, [])
}

async function testResidentialAndNonResidentialBuildsUseFullLifecycle() {
  const store = createRunStore()
  const dir = createBlueprintDir([
    {
      name: 'lifecycle_house',
      origin: { x: 0, y: 0, z: 0 },
      metadata: { buildingType: 'house', style: 'wood', floors: 1 },
      blocks: [{ x: 0, y: 0, z: 0, type: 'oak_planks' }]
    },
    {
      name: 'lifecycle_workshop',
      origin: { x: 0, y: 0, z: 0 },
      metadata: { buildingType: 'workshop', style: 'stone', floors: 1 },
      blocks: [{ x: 0, y: 0, z: 0, type: 'stone' }]
    }
  ])
  const inventoryByRun = {
    lifecycle_house: { oak_planks: 1 },
    lifecycle_workshop: { stone: 1 }
  }
  let activeBlueprint = 'lifecycle_house'
  const inventoryReasons = []
  const ctx = createContext([
    { name: 'oak_planks', count: 2 },
    { name: 'stone', count: 2 },
    { name: 'chest', count: 2 }
  ], {
    storageSystem: {
      async getStagingInventory(context, options = {}) {
        inventoryReasons.push(options.reason)
        const chests = []
        for (const center of options.scanCenters || []) {
          const position = center.position || center
          if (!position) continue
          if (context.bot.blockAt(vec(position.x, position.y, position.z)).name !== 'chest') continue
          chests.push({ position, source: center.source || 'lifecycle_staging_chest', itemCount: 1 })
        }
        return {
          counts: options.reason === 'construction_site_cleanup_inventory' ? {} : { ...inventoryByRun[activeBlueprint] },
          chests
        }
      }
    }
  })

  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const firstStart = await startSystemWithOptions(system1, ctx, 'lifecycle_house', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true,
    aesthetic: { required: false }
  })
  assert.strictEqual(firstStart.ok, true, firstStart.error)
  const firstResult = await system1.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 8 })
  assert.strictEqual(firstResult.completed, true, firstResult.error)
  const houseRun = store.getRun(system1.session.constructionRunId)

  activeBlueprint = 'lifecycle_workshop'
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const secondStart = await startSystemWithOptions(system2, ctx, 'lifecycle_workshop', { x: 4, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true,
    aesthetic: { required: false }
  })
  assert.strictEqual(secondStart.ok, true, secondStart.error)
  const secondResult = await system2.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 8 })
  assert.strictEqual(secondResult.completed, true, secondResult.error)
  const workshopRun = store.getRun(system2.session.constructionRunId)

  assert.strictEqual(houseRun.terminalState, 'COMPLETED')
  assert.strictEqual(workshopRun.terminalState, 'COMPLETED')
  assert.strictEqual(houseRun.designSpec.habitabilityRequirements.residential, true)
  assert.strictEqual(workshopRun.designSpec.habitabilityRequirements.residential, false)
  assert.notStrictEqual(houseRun.blueprintHash, workshopRun.blueprintHash)
  assert.deepStrictEqual(houseRun.placementContext.origin, { x: 0, y: 64, z: 0 })
  assert.deepStrictEqual(workshopRun.placementContext.origin, { x: 4, y: 64, z: 0 })
  for (const run of [houseRun, workshopRun]) {
    assert.strictEqual(run.designSpec.frozen, true)
    assert.strictEqual(run.blueprintFreeze.frozen, true)
    assert.ok(run.stagingChests.length > 0)
    assert.strictEqual(run.lifecycle.terminal, true)
    assert.deepStrictEqual(run.lifecycle.phaseOrder, CONSTRUCTION_PHASE_ORDER)
    assert.strictEqual(run.archive.siteCleanup.ok, true)
    assert.strictEqual(run.archive.blueprintIR.metadata.frozen, true)
  }
  assert.ok(inventoryReasons.includes('construction_staging_chest_prepare'))
  assert.ok(inventoryReasons.includes('construction_run_resume_inventory_reconcile_primary'))
  assert.ok(inventoryReasons.includes('construction_site_cleanup_inventory'))
}

async function testRealStagingChestCoordinatesPersistAcrossResume() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('real_chest_resume', 1)])
  const realChest = { x: 4, y: 64, z: 2 }
  const calls = []
  const storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(options)
      return {
        counts: { oak_planks: 1 },
        chests: [{ position: realChest, source: 'opened_staging_chest', itemCount: 1 }]
      }
    }
  }
  const ctx = createContext([{ name: 'oak_planks', count: 1 }], { storageSystem })
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'real_chest_resume')

  const run = activeRun(store)
  assert.deepStrictEqual(run.stagingChests[0].position, realChest)
  assert.strictEqual(run.stagingChests[0].verified, true)

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'real_chest_resume')
  assert.deepStrictEqual(calls[1].scanCenters[0].position, realChest)
}

async function testPhysicalStagingChestDeploysOutsideBounds() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('deploy_staging_chest', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 3 }, { name: 'chest', count: 1 }], {
    storageSystem: createPhysicalStagingReader({ oak_planks: 1 })
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'deploy_staging_chest', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })

  assert.strictEqual(started.ok, true, started.error)
  const run = activeRun(store)
  const chest = run.stagingChests[0]
  assert.strictEqual(chest.verified, true)
  assert.strictEqual(chest.source, 'deployed_staging_chest')
  assert.strictEqual(ctx.bot.blockAt(vec(chest.position.x, chest.position.y, chest.position.z)).name, 'chest')
  assert.ok(chest.position.x < run.bounds.minX || chest.position.x > run.bounds.maxX || chest.position.z < run.bounds.minZ || chest.position.z > run.bounds.maxZ)
  assert.strictEqual(run.lifecycle.gates.stagingChestVerified, true)
  assert.strictEqual(run.lifecycle.gates.stagingChestDeployed, true)
}

async function testPhysicalStagingChestIsNotDuplicatedOnResume() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('reuse_staging_chest', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 3 }, { name: 'chest', count: 2 }], {
    storageSystem: createPhysicalStagingReader({ oak_planks: 1 })
  })
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystemWithOptions(system1, ctx, 'reuse_staging_chest', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })
  const firstRun = activeRun(store)
  const firstChest = firstRun.stagingChests[0].position
  assert.strictEqual(ctx.placed.filter(entry => entry.blockName === 'chest').length, 1)

  ctx.placed.length = 0
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystemWithOptions(system2, ctx, 'reuse_staging_chest', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })
  const secondRun = activeRun(store)
  assert.strictEqual(secondRun.runId, firstRun.runId)
  assert.deepStrictEqual(secondRun.stagingChests[0].position, firstChest)
  assert.strictEqual(ctx.placed.filter(entry => entry.blockName === 'chest').length, 0)
  assert.strictEqual(secondRun.stagingChestPreparation.mode, 'resume_existing_staging_chest')
}

async function testRequiredPhysicalStagingChestBlocksWhenUnavailable() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('missing_staging_chest_item', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 3 }])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'missing_staging_chest_item', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })

  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'staging_chest_required_missing_chest_item')
  const run = store.listRuns()[0]
  assert.strictEqual(run.status, 'BLOCKED_STAGING_CHEST')
  assert.strictEqual(run.blockedReason, 'staging_chest_required_missing_chest_item')
}

async function testBlockedStagingChestRunResumesWhenChestBecomesAvailable() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('blocked_staging_resume', 1)])
  const firstContext = createContext([{ name: 'oak_planks', count: 3 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const blocked = await startSystemWithOptions(system1, firstContext, 'blocked_staging_resume', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })
  assert.strictEqual(blocked.ok, false)
  const blockedRun = store.listRuns()[0]
  assert.strictEqual(blockedRun.status, 'BLOCKED_STAGING_CHEST')
  assert.strictEqual(isRunActive(blockedRun), true)

  const secondContext = createContext([{ name: 'oak_planks', count: 3 }, { name: 'chest', count: 1 }], {
    storageSystem: createPhysicalStagingReader({ oak_planks: 1 })
  })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const resumed = await startSystemWithOptions(system2, secondContext, 'blocked_staging_resume', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })
  assert.strictEqual(resumed.ok, true, resumed.error)
  assert.strictEqual(system2.session.resumedConstructionRun, true)
  assert.strictEqual(system2.session.constructionRunId, blockedRun.runId)
  assert.strictEqual(activeRun(store).runId, blockedRun.runId)
}

async function testCompletedRunCleansEmptyTemporaryStagingChest() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('cleanup_staging_chest', 1)])
  const inventoryCalls = []
  const storageSystem = {
    async getStagingInventory(context, options) {
      inventoryCalls.push(options.reason)
      if (options.reason === 'construction_staging_chest_prepare') {
        return { counts: {}, chests: [] }
      }
      const chest = options.scanCenters?.[0]
      if (options.reason === 'construction_site_cleanup_inventory') {
        return { counts: {}, chests: chest ? [{ position: chest.position || chest, itemCount: 0 }] : [] }
      }
      return {
        counts: { oak_planks: 1 },
        chests: chest ? [{ position: chest.position || chest, itemCount: 1 }] : []
      }
    }
  }
  const ctx = createContext([{ name: 'oak_planks', count: 3 }, { name: 'chest', count: 1 }], { storageSystem })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'cleanup_staging_chest', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })
  assert.strictEqual(started.ok, true, started.error)
  const chestPosition = activeRun(store).stagingChests[0].position
  assert.strictEqual(ctx.bot.blockAt(vec(chestPosition.x, chestPosition.y, chestPosition.z)).name, 'chest')

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 8 })
  assert.strictEqual(result.completed, true, result.error)
  assert.strictEqual(ctx.bot.blockAt(vec(chestPosition.x, chestPosition.y, chestPosition.z)).name, 'air')
  assert.ok(inventoryCalls.includes('construction_site_cleanup_inventory'))
  const completed = store.getRun(system.session.constructionRunId)
  assert.strictEqual(completed.terminalState, 'COMPLETED')
  assert.strictEqual(completed.archive.siteCleanup.ok, true)
  assert.strictEqual(completed.archive.siteCleanup.stagingChests[0].action, 'removed')
}

async function testPhaseGateReadsRealStagingChestBeforePlacement() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'phase_gate')

  const calls = []
  ctx.storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(options)
      return { counts: {} }
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.placed.length, 1)
  assert.strictEqual(calls.length, 1)

  const run = store.getRun(system.session.constructionRunId)
  assert.strictEqual(run.phaseGates[calls[0].phase].ok, true)
  assert.strictEqual(run.phaseGates[calls[0].phase].materialsVerified, true)
}

async function testCachedPhaseGateStillRechecksRealStagingChestBeforePlacement() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate_cache_resume', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'phase_gate_cache_resume')

  const phase = system.session.steps[0].phase
  const oldGate = {
    ok: true,
    phase,
    dependenciesVerified: true,
    materialsVerified: true,
    checkedAt: '2000-01-01T00:00:00.000Z'
  }
  system.session.phaseGates = { [phase]: oldGate }
  const run = activeRun(store)
  system.session.constructionRun = store.upsertRun({
    ...run,
    status: 'ACTIVE',
    terminalState: null,
    phaseGates: system.session.phaseGates
  })

  const calls = []
  ctx.storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(options)
      return {
        counts: {},
        chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'empty_staging_chest', itemCount: 0 }]
      }
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.placed.length, 1)
  assert.strictEqual(calls.length, 1)

  const saved = store.getRun(system.session.constructionRunId)
  assert.strictEqual(saved.phaseGates[phase].ok, true)
  assert.strictEqual(saved.phaseGates[phase].cached, undefined)
  assert.strictEqual(saved.phaseGates[phase].materialsVerified, true)
}

async function testSameSessionPhaseGateDoesNotReopenChestEveryStep() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate_same_session', 2)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'phase_gate_same_session')

  const calls = []
  ctx.storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(options)
      return {
        counts: { oak_planks: 2 },
        chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'staging_chest', itemCount: 2 }]
      }
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 2 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.placed.length, 2)
  assert.strictEqual(calls.length, 1)

  const phase = calls[0].phase
  const saved = store.getRun(system.session.constructionRunId)
  assert.strictEqual(saved.phaseGates[phase].ok, true)
  assert.strictEqual(saved.phaseGates[phase].sessionId, system.session.phaseGateSessionId)
}

async function testStartupStorageReconcileSeedsCurrentPhaseGate() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate_startup_seed', 1)])
  const calls = []
  const ctx = createContext([{ name: 'oak_planks', count: 2 }, { name: 'chest', count: 1 }], {
    storageSystem: {
      async getStagingInventory(context, options = {}) {
        calls.push(options.reason)
        const chests = []
        for (const center of options.scanCenters || []) {
          const position = center.position || center
          if (!position) continue
          if (context.bot.blockAt(vec(position.x, position.y, position.z)).name !== 'chest') continue
          chests.push({ position, source: center.source || 'startup_seed_chest', itemCount: 1 })
        }
        return {
          counts: { oak_planks: 1 },
          chests
        }
      }
    }
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'phase_gate_startup_seed', { x: 0, y: 64, z: 0 }, {
    requirePhysicalStagingChest: true
  })
  assert.strictEqual(started.ok, true, started.error)

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.ok(calls.includes('construction_run_resume_inventory_reconcile_primary'), JSON.stringify(calls))
  assert.ok(!calls.includes('construction_phase_material_gate'), JSON.stringify(calls))

  const phase = Object.keys(system.session.phaseGates).find(key => system.session.phaseGates[key].startupStorageReconciled)
  assert.strictEqual(phase, 'frame')
  assert.strictEqual(system.session.phaseGates[phase].sessionId, system.session.phaseGateSessionId)
}

async function testPhaseGateRefillsStagingChestBeforePlacement() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate_refill', 1)])
  const items = [{ name: 'oak_planks', count: 1 }]
  const ctx = createContext(items)
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'phase_gate_refill')
  items[0].count = 0

  const calls = []
  let refillDone = false
  ctx.storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(options.reason)
      return {
        counts: refillDone ? { oak_planks: 1 } : {},
        chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'test_staging_chest', itemCount: refillDone ? 1 : 0 }]
      }
    },
    async ensureStagingMaterials(context, options) {
      calls.push(`ensure:${options.phase}`)
      refillDone = true
      return {
        ok: true,
        moved: [{ item: 'oak_planks', count: 1, source: 'inventory' }],
        missing: [],
        inventory: { oak_planks: 1 },
        verified: true
      }
    },
    async takeItems(context, options) {
      calls.push(`take:${options.reason}`)
      if (!refillDone) return { ok: false, error: 'staging_not_refilled' }
      items[0].count += options.count
      return { ok: true, withdrawnItems: [{ itemName: 'oak_planks', count: options.count }] }
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.placed.length, 1)
  assert.ok(calls.some(entry => String(entry).startsWith('ensure:')), JSON.stringify(calls))
  const run = store.getRun(system.session.constructionRunId)
  const gate = Object.values(run.phaseGates).find(entry => entry.materialRefill)
  assert.ok(gate)
  assert.strictEqual(gate.materialRefill.moved[0].source, 'inventory')
}

async function testPhaseGateContinuesWhenFailedRefillLeavesRequiredItemInInventory() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate_refill_inventory_recovery', 1)])
  const items = [{ name: 'oak_planks', count: 1 }]
  const ctx = createContext(items)
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'phase_gate_refill_inventory_recovery')
  items[0].count = 0

  const calls = []
  ctx.storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(`read:${options.reason}`)
      return {
        counts: {},
        chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'full_staging_chest', itemCount: 27 }]
      }
    },
    async ensureStagingMaterials(context, options) {
      calls.push(`ensure:${options.reason}`)
      items[0].count = 1
      return {
        ok: false,
        error: 'BLOCKED_MATERIAL_SHORTAGE:oak_planks:1',
        moved: [],
        failures: [{ item: 'oak_planks', count: 1, source: 'storage', error: 'staging_deposit_failed:oak_planks' }],
        missing: [{ item: 'oak_planks', required: 1, available: 0, missing: 1 }],
        inventory: {}
      }
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.placed.length, 1)
  assert.ok(calls.includes('ensure:construction_phase_material_gate_refill'), JSON.stringify(calls))
  assert.ok(!calls.includes('read:construction_phase_material_gate_primary_verify_after_refill'), JSON.stringify(calls))

  const run = store.getRun(system.session.constructionRunId)
  const gate = Object.values(run.phaseGates).find(entry => entry.phase === 'frame')
  assert.ok(gate)
  assert.strictEqual(gate.ok, true)
  assert.strictEqual(gate.materialRefill.ok, false)
}

async function testPhaseGateDefersSamePhaseShortageToInventoryBatch() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_gate_batch_defer', 2)])
  const items = [{ name: 'oak_planks', count: 2 }]
  const ctx = createContext(items)
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'phase_gate_batch_defer')
  items[0].count = 0

  const calls = []
  ctx.storageSystem = {
    async getStagingInventory(context, options) {
      calls.push(`read:${options.reason}`)
      return {
        counts: { oak_planks: 1 },
        chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'test_staging_chest', itemCount: 1 }]
      }
    },
    async ensureStagingMaterials(context, options) {
      calls.push(`ensure:${options.reason}`)
      return {
        ok: false,
        moved: [],
        missing: [{ item: 'oak_planks', required: 2, available: 1, missing: 1 }],
        inventory: { oak_planks: 1 },
        verified: true
      }
    },
    async takeItems(context, options) {
      calls.push(`take:${options.reason}:${options.count}`)
      assert.strictEqual(options.reason, 'building_inventory_batch_primary')
      assert.strictEqual(options.itemName, 'oak_planks')
      items[0].count += 1
      return {
        ok: true,
        withdrawnItems: [{ itemName: 'oak_planks', count: 1 }],
        targetChest: { position: { x: -3, y: 64, z: -4 } },
        openSummary: { openedChests: [{ x: -3, y: 64, z: -4 }], openCount: 1 }
      }
    }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.placed.length, 1)
  assert.ok(calls.includes('read:construction_phase_material_gate_primary'), JSON.stringify(calls))
  assert.ok(calls.some(entry => entry.startsWith('take:building_inventory_batch_primary:')), JSON.stringify(calls))
  assert.ok(!calls.some(entry => entry.startsWith('ensure:')), JSON.stringify(calls))

  const run = store.getRun(system.session.constructionRunId)
  const gate = Object.values(run.phaseGates).find(entry => entry.phase === 'frame')
  assert.ok(gate)
  assert.strictEqual(gate.ok, true)
  assert.strictEqual(gate.requirements.oak_planks, 1)
  assert.strictEqual(gate.phaseRequirements.oak_planks, 2)
}

async function testConstructionRunPrepareRefillsStagingBeforeBlocking() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('prepare_refill', 1)])
  let refillDone = false
  const calls = []
  const stagingChest = { position: { x: -3, y: 64, z: -4 }, source: 'test_staging_chest', itemCount: 0 }
  const ctx = createContext([], {
    storageSystem: {
      async getStagingInventory(context, options) {
        calls.push(options.reason)
        return {
          counts: refillDone ? { oak_planks: 1 } : {},
          chests: [{ ...stagingChest, itemCount: refillDone ? 1 : 0 }]
        }
      },
      async takeItems() {
        return { ok: false, error: 'not_used_in_prepare_refill_test' }
      },
      async ensureStagingMaterials(context, options) {
        calls.push(options.reason)
        assert.strictEqual(options.reason, 'construction_run_resume_inventory_refill')
        assert.strictEqual(options.required.oak_planks, 1)
        refillDone = true
        return {
          ok: true,
          moved: [{ item: 'oak_planks', count: 1, source: 'storage' }],
          missing: [],
          inventory: { oak_planks: 1 },
          verified: true
        }
      }
    }
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'prepare_refill', { x: 0, y: 64, z: 0 }, {
    stagedStorageRefill: true,
    requirePhysicalStagingChest: true
  })

  assert.strictEqual(started.ok, true, started.error)
  assert.ok(calls.includes('construction_run_resume_inventory_refill'), JSON.stringify(calls))
  assert.ok(calls.includes('construction_run_resume_inventory_verify_primary_after_refill'), JSON.stringify(calls))
  const run = activeRun(store)
  assert.strictEqual(run.status, 'ACTIVE')
  assert.strictEqual(run.stagingInventory.oak_planks, 1)
}

async function testPrepareUsesPartialRefillInventoryWhenStillBlocked() {
  const store = createRunStore()
  const dir = createBlueprintDir([{
    name: 'prepare_partial_refill',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 1, y: 0, z: 0, type: 'spruce_log' }
    ]
  }])
  const calls = []
  const ctx = createContext([], {
    storageSystem: {
      async getStagingInventory(context, options) {
        calls.push(options.reason)
        return {
          counts: {},
          chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'empty_staging_chest', itemCount: 0 }]
        }
      },
      async takeItems() {
        return { ok: false, error: 'not_used_in_partial_refill_inventory_test' }
      },
      async ensureStagingMaterials(context, options) {
        calls.push(options.reason)
        assert.strictEqual(options.reason, 'construction_run_resume_inventory_refill')
        assert.strictEqual(options.required.oak_planks, 1)
        assert.strictEqual(options.required.spruce_log, 1)
        return {
          ok: false,
          moved: [{ item: 'oak_planks', count: 1, source: 'storage' }],
          missing: [{ item: 'spruce_log', required: 1, available: 0, missing: 1 }],
          inventory: { oak_planks: 1 },
          verified: true
        }
      }
    }
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'prepare_partial_refill', { x: 0, y: 64, z: 0 }, {
    stagedStorageRefill: true
  })

  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'BLOCKED_MATERIAL_SHORTAGE:spruce_log:1')
  assert.ok(!started.error.includes('oak_planks'), started.error)
  assert.ok(calls.includes('construction_run_resume_inventory_refill'), JSON.stringify(calls))
  assert.ok(!calls.includes('construction_run_resume_inventory_verify_after_refill'), JSON.stringify(calls))
  const run = activeRun(store)
  assert.strictEqual(run.status, 'BLOCKED_MATERIAL_SHORTAGE')
  assert.strictEqual(run.stagingInventory.oak_planks, 1)
  assert.strictEqual(run.blockedReason, 'BLOCKED_MATERIAL_SHORTAGE:spruce_log:1')
}

async function testPrepareDefersFuturePhaseMaterialShortage() {
  const store = createRunStore()
  const dir = createBlueprintDir([{
    name: 'prepare_future_shortage',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 0, y: 4, z: 0, type: 'oak_planks' }
    ]
  }])
  const calls = []
  const ctx = createContext([], {
    storageSystem: {
      async getStagingInventory(context, options) {
        calls.push(options.reason)
        return {
          counts: { dirt: 8, oak_planks: 1 },
          chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'staging_chest', itemCount: 9 }]
        }
      },
      async takeItems() {
        return { ok: false, error: 'not_used_in_future_phase_shortage_test' }
      },
      async ensureStagingMaterials(context, options) {
        calls.push(options.reason)
        return {
          ok: false,
          moved: [],
          missing: [{ item: 'oak_planks', required: 2, available: 1, missing: 1 }],
          inventory: { dirt: 8, oak_planks: 1 },
          verified: true
        }
      }
    }
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'prepare_future_shortage', { x: 0, y: 64, z: 0 }, {
    stagedStorageRefill: true
  })

  assert.strictEqual(started.ok, true, started.error)
  assert.ok(calls.includes('construction_run_resume_inventory_reconcile_primary'), JSON.stringify(calls))
  assert.ok(!calls.includes('construction_run_resume_inventory_refill'), JSON.stringify(calls))
  const run = activeRun(store)
  assert.strictEqual(run.status, 'ACTIVE')
  assert.strictEqual(run.materialShortageCheckedPhase, 'site_prepare')
  assert.deepStrictEqual(run.materialShortageBacklog, [{
    item: 'oak_planks',
    required: 2,
    available: 1,
    missing: 1
  }])
}

async function testPrepareDoesNotTreatLiveInventoryAsStagingInventory() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('live_inventory_not_staged', 1)])
  const calls = []
  const ctx = createContext([{ name: 'oak_planks', count: 1 }], {
    storageSystem: {
      async getStagingInventory(context, options) {
        calls.push(options.reason)
        return {
          counts: {},
          chests: [{ position: { x: -3, y: 64, z: -4 }, source: 'empty_staging_chest', itemCount: 0 }]
        }
      }
    }
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'live_inventory_not_staged', { x: 0, y: 64, z: 0 }, {
    stagedStorageRefill: true
  })

  assert.strictEqual(started.ok, true, started.error)
  assert.ok(calls.includes('construction_run_resume_inventory_reconcile_primary'), JSON.stringify(calls))
  const run = activeRun(store)
  assert.strictEqual(run.status, 'ACTIVE')
  assert.strictEqual(run.stagingInventory.oak_planks, undefined)
}

async function testResumeChoosesEarliestUnresolvedPhaseBeforePlanOrder() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('phase_order_resume', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }, { name: 'spruce_door', count: 1 }])
  const executed = []
  const system = createBuildingSystem({
    blueprintDir: dir,
    constructionRunStore: store,
    executor: {
      async executeStep(context, step) {
        executed.push(step.id)
        return { ok: true }
      }
    }
  })
  await startSystem(system, ctx, 'phase_order_resume')

  const futureStep = {
    id: 'future-doors-step',
    kind: 'place',
    phase: 'doors_windows',
    position: { x: 1, y: 64, z: 0 },
    blockName: 'spruce_door',
    dependencies: []
  }
  const frameStep = {
    id: 'pending-frame-step',
    kind: 'place',
    phase: 'frame',
    position: { x: 0, y: 64, z: 0 },
    blockName: 'oak_planks',
    dependencies: []
  }
  const run = activeRun(store)
  const steps = {
    [futureStep.id]: {
      id: futureStep.id,
      action: 'place_block',
      legacyKind: 'place',
      phase: futureStep.phase,
      lifecyclePhase: futureStep.phase,
      target: futureStep.position,
      block: { id: futureStep.blockName, states: {} },
      dependencies: [],
      retry: { count: 0, lastError: null },
      status: STEP_STATE.PENDING
    },
    [frameStep.id]: {
      id: frameStep.id,
      action: 'place_block',
      legacyKind: 'place',
      phase: frameStep.phase,
      lifecyclePhase: frameStep.phase,
      target: frameStep.position,
      block: { id: frameStep.blockName, states: {} },
      dependencies: [],
      retry: { count: 0, lastError: null },
      status: STEP_STATE.PENDING
    }
  }
  system.session.steps = [futureStep, frameStep]
  system.session.currentStepIndex = 0
  system.session.phaseGates = {}
  system.session.constructionRun = store.upsertRun({
    ...run,
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'frame',
    phaseGates: {},
    steps
  })

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(executed, [frameStep.id])
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[frameStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[futureStep.id].status, STEP_STATE.PENDING)
}

async function testResumeDefersValidationUntilCleanupCompletes() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('cleanup_before_validation', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const executed = []
  const system = createBuildingSystem({
    blueprintDir: dir,
    constructionRunStore: store,
    executor: {
      async executeStep(context, step) {
        executed.push(step.id)
        return { ok: true }
      }
    }
  })
  await startSystem(system, ctx, 'cleanup_before_validation')

  const validationStep = {
    id: 'early-validation',
    kind: 'walkability_validate',
    action: 'validate_walkability',
    phase: 'walkability_final_check',
    dependencies: []
  }
  const cleanupStep = {
    id: 'cleanup-scaffold',
    kind: 'scaffold_remove',
    action: 'clear_block',
    phase: 'cleanup',
    position: { x: 2, y: 64, z: 0 },
    blockName: 'dirt',
    dependencies: []
  }
  const run = activeRun(store)
  const steps = {
    [validationStep.id]: {
      id: validationStep.id,
      action: 'validate_walkability',
      legacyKind: 'walkability_validate',
      phase: validationStep.phase,
      lifecyclePhase: 'cleanup',
      target: null,
      block: null,
      dependencies: [],
      retry: { count: 1, lastError: 'faithful_world_validation_failed:fidelity_ratio_below_threshold' },
      status: STEP_STATE.TERMINAL_FAILED
    },
    [cleanupStep.id]: {
      id: cleanupStep.id,
      action: 'clear_block',
      legacyKind: 'scaffold_remove',
      phase: cleanupStep.phase,
      lifecyclePhase: 'cleanup',
      target: cleanupStep.position,
      block: { id: cleanupStep.blockName, states: {} },
      dependencies: [],
      retry: { count: 0, lastError: null },
      status: STEP_STATE.CLEANUP
    }
  }
  system.session.steps = [validationStep, cleanupStep]
  system.session.currentStepIndex = 0
  system.session.phaseGates = {}
  system.session.constructionRun = store.upsertRun({
    ...run,
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'cleanup',
    phaseGates: {},
    steps
  })

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(executed, [cleanupStep.id])
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[cleanupStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[validationStep.id].status, STEP_STATE.TERMINAL_FAILED)
}

function testNormalizeConstructionPhaseDoesNotTreatAndesiteAsSitePrepare() {
  assert.strictEqual(normalizeConstructionPhase('frame', {
    kind: 'place',
    action: 'place_block',
    block: { id: 'andesite' }
  }), 'frame')
  assert.strictEqual(normalizeConstructionPhase('clear_obstruction', {
    kind: 'clear',
    action: 'clear_block',
    block: { id: 'andesite' }
  }), 'site_prepare')
}

async function testResumePrioritizesClearBeforeAndesiteFrameStep() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('andesite_clear_order', 1)])
  const ctx = createContext([{ name: 'andesite', count: 1 }, { name: 'oak_planks', count: 1 }])
  const executed = []
  const system = createBuildingSystem({
    blueprintDir: dir,
    constructionRunStore: store,
    executor: {
      async executeStep(context, step) {
        executed.push(step.id)
        return { ok: true }
      }
    }
  })
  await startSystem(system, ctx, 'andesite_clear_order')

  const andesiteFrameStep = {
    id: 'pending-andesite-frame',
    kind: 'place',
    action: 'place_block',
    phase: 'frame',
    position: { x: 1, y: 64, z: 0 },
    blockName: 'andesite',
    block: { id: 'andesite', states: {} },
    dependencies: []
  }
  const clearStep = {
    id: 'pending-clear-obstruction',
    kind: 'clear',
    action: 'clear_block',
    phase: 'clear_obstruction',
    position: { x: 0, y: 64, z: 0 },
    blockName: null,
    block: null,
    dependencies: []
  }
  const run = activeRun(store)
  system.session.steps = [andesiteFrameStep, clearStep]
  system.session.currentStepIndex = 0
  system.session.phaseGates = {}
  system.session.constructionRun = store.upsertRun({
    ...run,
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'site_prepare',
    phaseGates: {},
    steps: {
      [andesiteFrameStep.id]: {
        id: andesiteFrameStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: andesiteFrameStep.phase,
        lifecyclePhase: andesiteFrameStep.phase,
        target: andesiteFrameStep.position,
        block: { id: 'andesite', states: {} },
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING
      },
      [clearStep.id]: {
        id: clearStep.id,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: clearStep.phase,
        lifecyclePhase: 'site_prepare',
        target: clearStep.position,
        block: null,
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING
      }
    }
  })

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(executed, [clearStep.id])
}

async function testSurfaceDecorationDependsOnSupportStepPhase() {
  const store = createRunStore()
  const blueprint = {
    name: 'surface_support_dependency',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      {
        x: 0,
        y: 0,
        z: 0,
        type: 'spruce_stairs',
        states: { half: 'top', facing: 'west', shape: 'straight', waterlogged: 'false' }
      },
      {
        x: 0,
        y: 1,
        z: 0,
        type: 'white_candle',
        states: { candles: '3', lit: 'false', waterlogged: 'false' }
      },
      {
        x: 1,
        y: 0,
        z: 0,
        type: 'spruce_trapdoor',
        states: { half: 'top', facing: 'east', open: 'false', powered: 'false', waterlogged: 'false' }
      },
      {
        x: 1,
        y: 1,
        z: 0,
        type: 'lantern',
        states: { hanging: 'false', waterlogged: 'false' }
      },
      {
        x: 2,
        y: 1,
        z: -1,
        type: 'stone'
      },
      {
        x: 2,
        y: 1,
        z: 0,
        type: 'dark_oak_button',
        states: { face: 'wall', facing: 'south', powered: 'false' }
      },
      {
        x: 4,
        y: 1,
        z: 0,
        type: 'lantern',
        states: { signal_fire: 'false', lit: 'false', facing: 'north', waterlogged: 'false' }
      }
    ]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([
    { name: 'spruce_stairs', count: 2 },
    { name: 'white_candle', count: 3 },
    { name: 'spruce_trapdoor', count: 2 },
    { name: 'lantern', count: 2 },
    { name: 'stone', count: 2 },
    { name: 'dark_oak_button', count: 2 }
  ])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'surface_support_dependency')

  const stair = system.session.steps.find(step => step.blockName === 'spruce_stairs')
  const candle = system.session.steps.find(step => step.blockName === 'white_candle')
  const trapdoor = system.session.steps.find(step => step.blockName === 'spruce_trapdoor')
  const lantern = system.session.steps.find(step => step.blockName === 'lantern')
  const stone = system.session.steps.find(step =>
    step.blockName === 'stone' &&
    step.position?.x === 2 &&
    step.position?.y === 65 &&
    step.position?.z === -1
  )
  const button = system.session.steps.find(step => step.blockName === 'dark_oak_button')
  const safeCampfireReplacement = system.session.steps.find(step =>
    step.position?.x === 4 &&
    step.position?.y === 65 &&
    step.position?.z === 0
  )
  assert.ok(stair, 'missing stair step')
  assert.ok(candle, 'missing candle step')
  assert.ok(trapdoor, 'missing trapdoor step')
  assert.ok(lantern, 'missing lantern step')
  assert.ok(stone, 'missing side support step')
  assert.ok(button, 'missing wall button step')
  assert.ok(safeCampfireReplacement, 'missing safe campfire replacement step')
  assert.ok(candle.dependencies.includes(stair.id), JSON.stringify(candle))
  assert.ok(lantern.dependencies.includes(trapdoor.id), JSON.stringify(lantern))
  assert.ok(button.dependencies.includes(stone.id), JSON.stringify(button))
  assert.strictEqual(safeCampfireReplacement.blockName, 'stone')
  assert.strictEqual(system.session.worldBlocks.find(block =>
    block.position?.x === 4 &&
    block.position?.y === 65 &&
    block.position?.z === 0
  ).type, 'stone')
  assert.strictEqual(system.session.resolvedBlueprint.blocks.find(block =>
    block.x === 4 &&
    block.y === 1 &&
    block.z === 0
  ).type, 'stone')

  const inventoryReconciledPreview = buildingSystemTest.applyMaterialResolutionToPreview(
    system.session,
    Object.fromEntries(ctx.bot.inventory.items().map(item => [item.name, item.count])),
    { context: ctx, source: 'test_resume_inventory_reconcile' }
  )
  assert.strictEqual(inventoryReconciledPreview.worldBlocks.find(block =>
    block.position?.x === 4 &&
    block.position?.y === 65 &&
    block.position?.z === 0
  ).type, 'stone')
  assert.strictEqual(inventoryReconciledPreview.resolvedBlueprint.blocks.find(block =>
    block.x === 4 &&
    block.y === 1 &&
    block.z === 0
  ).type, 'stone')
  assert.strictEqual(inventoryReconciledPreview.orderPlan.steps.find(step =>
    step.position?.x === 4 &&
    step.position?.y === 65 &&
    step.position?.z === 0
  ).blockName, 'stone')
  assert.strictEqual(system.session.materialPlan.formalRequiredMaterials.stone, 2)
  assert.strictEqual(system.session.materialPlan.formalRequiredMaterials.lantern, 1)
  assert.strictEqual(system.session.materialPlan.formalRequiredMaterials.white_candle, 3)
  assert.strictEqual(system.session.requiredMaterials.stone, 2)
  assert.strictEqual(system.session.requiredMaterials.white_candle, 3)
  assert.strictEqual(system.session.constructionPlan.materials.formalRequired.stone, 2)
  assert.strictEqual(system.session.constructionPlan.materials.formalRequired.white_candle, 3)
  assert.strictEqual(system.session.constructionPlan.materials.required.stone, 2)
  assert.strictEqual(system.session.constructionPlan.materials.required.white_candle, 3)
  assert.strictEqual(system.session.constructionRun.materialStats.required.stone, 2)
  assert.strictEqual(system.session.constructionRun.materialStats.required.white_candle, 3)
  const stairRank = CONSTRUCTION_PHASE_ORDER.indexOf(stair.phase)
  const candleRank = CONSTRUCTION_PHASE_ORDER.indexOf(candle.phase)
  const trapdoorRank = CONSTRUCTION_PHASE_ORDER.indexOf(trapdoor.phase)
  const lanternRank = CONSTRUCTION_PHASE_ORDER.indexOf(lantern.phase)
  assert.ok(candleRank >= stairRank, `candle phase ${candle.phase} should not precede support phase ${stair.phase}`)
  assert.ok(lanternRank >= trapdoorRank, `lantern phase ${lantern.phase} should not precede support phase ${trapdoor.phase}`)
}

async function testResumeMergesStoredSupportDependencies() {
  const store = createRunStore()
  const blueprint = {
    name: 'stored_support_resume_dependency',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      {
        x: 1,
        y: 1,
        z: 0,
        type: 'lantern',
        states: { hanging: 'false', waterlogged: 'false' }
      }
    ]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([
    { name: 'lantern', count: 1 },
    { name: 'spruce_trapdoor', count: 1 },
    { name: 'dirt', count: 64 }
  ])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'stored_support_resume_dependency')
  const run = activeRun(store)
  const lantern = findPlacementStep(run, 'lantern')
  assert.ok(lantern, 'missing lantern step')

  const supportId = 'stored_support_trapdoor'
  const supportStep = {
    id: supportId,
    action: 'place_block',
    legacyKind: 'place',
    phase: 'doors_windows',
    lifecyclePhase: 'doors_windows',
    target: { x: 1, y: 64, z: 0 },
    block: {
      id: 'spruce_trapdoor',
      states: { half: 'top', facing: 'east', open: 'false', powered: 'false', waterlogged: 'false' }
    },
    originalBlock: { id: 'spruce_trapdoor' },
    resolvedBlock: { id: 'spruce_trapdoor' },
    role: 'trapdoor',
    materialAlternatives: ['spruce_trapdoor'],
    exactRequired: true,
    dependencies: [],
    retry: { count: 0, lastError: null },
    status: STEP_STATE.STATE_REPAIR,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  store.upsertRun({
    ...run,
    currentPhase: 'frame',
    steps: {
      ...run.steps,
      [lantern.id]: {
        ...run.steps[lantern.id],
        phase: 'frame',
        lifecyclePhase: 'frame',
        dependencies: [],
        status: STEP_STATE.RETRYABLE_FAILED,
        retry: { count: 1, lastError: 'place_failed:unstable_air' }
      },
      [supportId]: supportStep
    }
  })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'stored_support_resume_dependency')
  const resumedRun = system2.session.constructionRun
  const resumedLantern = resumedRun.steps[lantern.id]
  assert.ok(resumedLantern.dependencies.includes(supportId), JSON.stringify(resumedLantern))
  const supportRank = CONSTRUCTION_PHASE_ORDER.indexOf(supportStep.phase)
  const lanternRank = CONSTRUCTION_PHASE_ORDER.indexOf(resumedLantern.phase)
  assert.ok(lanternRank >= supportRank, `lantern phase ${resumedLantern.phase} should not precede support phase ${supportStep.phase}`)
}

async function testResumePersistsHealedHangingLanternDependencyDirection() {
  const store = createRunStore()
  const blueprint = {
    name: 'stored_hanging_lantern_reverse_dependency',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      {
        x: 1,
        y: 2,
        z: 0,
        type: 'spruce_slab',
        states: { type: 'bottom', waterlogged: 'false' }
      },
      {
        x: 1,
        y: 1,
        z: 0,
        type: 'lantern',
        states: { hanging: 'true', waterlogged: 'false' }
      }
    ]
  }
  const dir = createBlueprintDir([blueprint])
  const ctx = createContext([
    { name: 'lantern', count: 1 },
    { name: 'spruce_slab', count: 1 },
    { name: 'dirt', count: 64 }
  ])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, blueprint.name)
  const run = activeRun(store)
  const support = findPlacementStep(run, 'spruce_slab')
  const lantern = findPlacementStep(run, 'lantern')
  assert.ok(support, 'missing top support step')
  assert.ok(lantern, 'missing hanging lantern step')

  store.upsertRun({
    ...run,
    steps: {
      ...run.steps,
      [support.id]: {
        ...run.steps[support.id],
        dependencies: [lantern.id],
        status: STEP_STATE.RETRYABLE_FAILED
      },
      [lantern.id]: {
        ...run.steps[lantern.id],
        dependencies: [],
        status: STEP_STATE.RETRYABLE_FAILED
      }
    }
  })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, blueprint.name)
  const resumedRun = system2.session.constructionRun
  assert.deepStrictEqual(resumedRun.steps[support.id].dependencies, [])
  assert.deepStrictEqual(resumedRun.steps[lantern.id].dependencies, [support.id])
}

async function testBlueprintRevisionChangeDoesNotResumeWrongRun() {
  const store = createRunStore()
  const firstDir = createBlueprintDir([plankLineBlueprint('revision_fixture', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }])
  const system1 = createBuildingSystem({ blueprintDir: firstDir, constructionRunStore: store })
  await startSystem(system1, ctx, 'revision_fixture')
  const firstRun = activeRun(store)

  const secondDir = createBlueprintDir([plankLineBlueprint('revision_fixture', 2)])
  const system2 = createBuildingSystem({ blueprintDir: secondDir, constructionRunStore: store })
  await startSystem(system2, ctx, 'revision_fixture')
  const runs = store.listRuns()
  const abandoned = runs.find(run => run.runId === firstRun.runId)
  const active = runs.find(run => isRunActive(run))
  assert.strictEqual(abandoned.status, 'ABANDONED')
  assert.strictEqual(abandoned.abandonReason, 'blueprintHash_changed')
  assert.notStrictEqual(active.runId, firstRun.runId)
}

async function testExistingStructureWithoutActiveRunBlocksFreshBuild() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('existing_without_run', 4)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }], {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'oak_planks' },
      { x: 1, y: 64, z: 0, name: 'oak_planks' },
      { x: 2, y: 64, z: 0, name: 'oak_planks' }
    ]
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'existing_without_run', { x: 0, y: 64, z: 0 }, {
    existingStructureBlockThreshold: 2
  })

  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION')
  assert.strictEqual(started.existingStructure.detectedExistingBlocks, 3)
  assert.strictEqual(started.existingStructure.verifiedBlocks, 3)
  assert.strictEqual(started.constructionRunDecision.verifiedTargetBlocks, 3)
  assert.strictEqual(started.constructionRunDecision.verifiedConstructionSteps, started.existingStructure.verifiedSteps)
  assert.strictEqual(started.constructionRunDecision.pendingConstructionSteps, started.existingStructure.pendingSteps)
  assert.strictEqual(started.constructionRunDecision.resumeOrFresh, 'blocked')
  assert.strictEqual(ctx.placed.length, 0)
  assert.strictEqual(ctx.cleared.length, 0)
  assert.strictEqual(store.listRuns().length, 0)
}

async function testForceRebuildDoesNotOverwriteExistingStructureWithoutExplicitOverwrite() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('force_rebuild_protection', 2)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'force_rebuild_protection')
  const run = activeRun(store)
  ctx.occupied.set('0,64,0', 'oak_planks')

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx, 'force_rebuild_protection', { x: 0, y: 64, z: 0 }, {
    forceRebuild: true,
    rebuildReason: 'explicit_rebuild_requested',
    existingStructureBlockThreshold: 1
  })

  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION')
  assert.strictEqual(store.getRun(run.runId).status, 'ACTIVE')
  assert.strictEqual(store.getRun(run.runId).abandonReason, undefined)
  assert.strictEqual(ctx.placed.length, 0)
}

function cobbleFoundationBlueprint(name = 'natural_site_foundation', width = 7, depth = 7) {
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) blocks.push({ x, y: 0, z, type: 'cobblestone', phase: 'foundation' })
  }
  return { name, origin: { x: 0, y: 0, z: 0 }, blocks }
}

function naturalGrassOccupation(width = 7, depth = 7, origin = { x: 0, y: 64, z: 0 }) {
  const occupied = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) occupied.push({ x: origin.x + x, y: origin.y, z: origin.z + z, name: 'grass_block' })
  }
  return occupied
}

// GEN2-SIMPLE-CABIN replay: 49 natural grass_blocks at foundation-level
// expected positions (the exact false-positive of
// .tmp/gen2-decision-probe-2026-07-02T16-01-05-512Z.json: detected=49,
// verified=0, all grass_block). New rule: natural terrain -> automatic FRESH,
// no allowOverwriteExistingStructure bypass involved.
async function testNaturalTerrainSiteAutoFresh() {
  const store = createRunStore()
  const dir = createBlueprintDir([cobbleFoundationBlueprint('gen2_replay_natural', 7, 7)])
  const ctx = createContext([{ name: 'cobblestone', count: 128 }], {
    occupied: naturalGrassOccupation(7, 7)
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'gen2_replay_natural', { x: 0, y: 64, z: 0 }, {
    aesthetic: { required: false }
  })
  assert.strictEqual(started.ok, true, started.error)
  const decision = started.constructionRunDecision
  assert.strictEqual(decision.blocked, false)
  assert.strictEqual(decision.resumeOrFresh, 'fresh')
  assert.strictEqual(decision.escapeHatchUsed, false)
  assert.strictEqual(decision.siteClassification.detectedExistingBlocks, 49)
  assert.strictEqual(decision.siteClassification.naturalBlocks, 49)
  assert.strictEqual(decision.siteClassification.blueprintMatchingBlocks, 0)
  assert.strictEqual(decision.siteClassification.unknownBlocks, 0)
  assert.strictEqual(decision.siteClassification.decision, 'fresh_natural_terrain')
  assert.ok(activeRun(store), 'fresh run must be created')
}

// Half-built structure: blueprint-matching blocks at expected positions must
// force reconciliation, and the escape hatch must NOT be able to bypass it.
async function testPartialBuildForcesReconciliationEvenWithOverwriteFlag() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('partial_build_reconcile', 4)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }], {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'oak_planks' },
      { x: 1, y: 64, z: 0, name: 'oak_planks' }
    ]
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'partial_build_reconcile', { x: 0, y: 64, z: 0 }, {
    allowOverwriteExistingStructure: true
  })
  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION')
  assert.strictEqual(started.constructionRunDecision.blocked, true)
  assert.strictEqual(started.constructionRunDecision.escapeHatchUsed, false)
  assert.ok(started.constructionRunDecision.siteClassification.blueprintMatchingBlocks >= 2)
  assert.strictEqual(store.listRuns().length, 0)
  assert.strictEqual(ctx.placed.length, 0)
  assert.strictEqual(ctx.cleared.length, 0)
}

// Mixed scene: natural terrain plus a single blueprint-matching structural
// block -> reconciliation, zero tolerance for missed half-builds.
async function testMixedNaturalPlusOneMatchingBlockForcesReconciliation() {
  const store = createRunStore()
  const dir = createBlueprintDir([cobbleFoundationBlueprint('mixed_scene_reconcile', 7, 7)])
  const occupied = naturalGrassOccupation(7, 7)
  occupied[10] = { ...occupied[10], name: 'cobblestone' }
  const ctx = createContext([{ name: 'cobblestone', count: 128 }], { occupied })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'mixed_scene_reconcile', { x: 0, y: 64, z: 0 }, {
    aesthetic: { required: false },
    allowOverwriteExistingStructure: true
  })
  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION')
  assert.strictEqual(started.constructionRunDecision.siteClassification.blueprintMatchingBlocks, 1)
  assert.strictEqual(started.constructionRunDecision.siteClassification.naturalBlocks, 48)
  assert.strictEqual(started.constructionRunDecision.escapeHatchUsed, false)
  assert.strictEqual(store.listRuns().length, 0)
}

// Foreign artificial blocks (no blueprint match): refuse the automatic
// decision at/above threshold; the escape hatch remains available for this
// case only, and its use is recorded.
async function testUnknownArtificialBlocksRequireManualDecision() {
  const store = createRunStore()
  const dir = createBlueprintDir([cobbleFoundationBlueprint('unknown_artificial_site', 4, 4)])
  const occupied = naturalGrassOccupation(4, 4)
  occupied[0] = { ...occupied[0], name: 'bricks' }
  occupied[1] = { ...occupied[1], name: 'bookshelf' }
  const ctx = createContext([{ name: 'cobblestone', count: 64 }], { occupied })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const blockedStart = await startSystemWithOptions(system, ctx, 'unknown_artificial_site', { x: 0, y: 64, z: 0 }, {
    aesthetic: { required: false },
    existingStructureBlockThreshold: 2
  })
  assert.strictEqual(blockedStart.ok, false)
  assert.strictEqual(blockedStart.error, 'UNKNOWN_ARTIFICIAL_BLOCKS_REQUIRE_MANUAL_DECISION')
  assert.strictEqual(blockedStart.constructionRunDecision.siteClassification.unknownBlocks, 2)
  assert.strictEqual(blockedStart.constructionRunDecision.siteClassification.blueprintMatchingBlocks, 0)
  assert.strictEqual(store.listRuns().length, 0)

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const escaped = await startSystemWithOptions(system2, ctx, 'unknown_artificial_site', { x: 0, y: 64, z: 0 }, {
    aesthetic: { required: false },
    existingStructureBlockThreshold: 2,
    allowOverwriteExistingStructure: true
  })
  assert.strictEqual(escaped.ok, true, escaped.error)
  assert.strictEqual(escaped.constructionRunDecision.escapeHatchUsed, true)
  assert.strictEqual(escaped.constructionRunDecision.siteClassification.decision, 'fresh_via_escape_hatch')
}

// Log ambiguity: logs are deliberately NOT in the natural whitelist (wood
// blueprints contain logs; a missed half-build is worse than a false
// positive). A natural tree inside the footprint therefore counts as unknown
// blocks: at/above threshold the decision goes to the manual branch; leaves
// still classify as natural. This conservative behavior is intentional.
async function testNaturalTreeLogsTakeManualDecisionBranch() {
  const store = createRunStore()
  const dir = createBlueprintDir([cobbleFoundationBlueprint('tree_ambiguity_site', 4, 4)])
  const occupied = naturalGrassOccupation(4, 4)
  // a small oak tree standing inside the footprint (positions where the
  // blueprint expects cobblestone, so no overlap with blueprint log types)
  occupied[5] = { ...occupied[5], name: 'oak_log' }
  occupied[6] = { ...occupied[6], name: 'oak_log' }
  occupied[9] = { ...occupied[9], name: 'oak_leaves' }
  occupied[10] = { ...occupied[10], name: 'oak_leaves' }
  const ctx = createContext([{ name: 'cobblestone', count: 64 }], { occupied })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system, ctx, 'tree_ambiguity_site', { x: 0, y: 64, z: 0 }, {
    aesthetic: { required: false },
    existingStructureBlockThreshold: 2
  })
  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'UNKNOWN_ARTIFICIAL_BLOCKS_REQUIRE_MANUAL_DECISION')
  assert.strictEqual(started.constructionRunDecision.siteClassification.unknownBlocks, 2)
  // leaves are natural; 12 untouched grass + 2 leaves
  assert.strictEqual(started.constructionRunDecision.siteClassification.naturalBlocks, 14)
  assert.strictEqual(started.constructionRunDecision.siteClassification.blueprintMatchingBlocks, 0)
}

// --- RENOVATION (docs/RENOVATION_FLOW_DESIGN.md): explicit lineage run ---

function renovationOldRunFixture(store) {
  const oldRun = createConstructionRun({
    blueprintId: 'reno_line',
    blueprintRevision: 'old',
    blueprintHash: 'hash_old_base',
    planId: 'plan_old',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    bounds: { minX: 0, maxX: 3, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    frozenBlueprintIR: {
      blocks: [0, 1, 2, 3].map(x => ({
        key: `b_${x}`,
        position: { x, y: 0, z: 0 },
        block: { id: 'oak_planks', states: {} }
      }))
    },
    steps: []
  })
  store.upsertRun({ ...oldRun, status: 'COMPLETED', terminalState: 'COMPLETED' })
  return store.getRun(oldRun.runId)
}

function renovationNewBlueprint() {
  // new generation: keeps planks x=0..2, DROPS the old x=3 plank, adds a log
  return {
    name: 'reno_line',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks' },
      { x: 1, y: 0, z: 0, type: 'oak_planks' },
      { x: 2, y: 0, z: 0, type: 'oak_planks' },
      { x: 0, y: 1, z: 0, type: 'oak_log', states: { axis: 'y' } }
    ]
  }
}

function renovationSiteContext() {
  return createContext([
    { name: 'oak_planks', count: 20 },
    { name: 'oak_log', count: 8 }
  ], {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'oak_planks' },
      { x: 1, y: 64, z: 0, name: 'oak_planks' },
      { x: 2, y: 64, z: 0, name: 'oak_planks' },
      { x: 3, y: 64, z: 0, name: 'oak_planks' }
    ]
  })
}

async function testRenovationOfCompletedRunCreatesLineageRunWithDemolition() {
  const store = createRunStore()
  const oldRun = renovationOldRunFixture(store)
  const oldRecordBefore = JSON.stringify(oldRun)
  const dir = createBlueprintDir([renovationNewBlueprint()])
  const ctx = renovationSiteContext()

  // control: WITHOUT renovationOf the hard reconciliation rule still blocks —
  // renovation is a new explicit path, not a bypass.
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const blocked = await startSystemWithOptions(system1, ctx, 'reno_line', { x: 0, y: 64, z: 0 }, {})
  assert.strictEqual(blocked.ok, false)
  assert.strictEqual(blocked.error, 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION')
  assert.strictEqual(store.listRuns().length, 1, 'no run created by the blocked control start')

  // renovation entry: decision approved, lineage run created
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx, 'reno_line', { x: 0, y: 64, z: 0 }, {
    renovationOf: oldRun.runId
  })
  assert.strictEqual(started.ok, true, started.error)
  const decision = started.constructionRunDecision
  assert.strictEqual(decision.resumeOrFresh, 'renovation')
  assert.strictEqual(decision.reason, 'RENOVATION_OF_COMPLETED_RUN')
  assert.strictEqual(decision.siteClassification.decision, 'renovation_of_completed_run')
  assert.strictEqual(decision.renovation.matchedBaseBlocks, 4)

  const newRun = activeRun(store)
  assert.ok(newRun, 'renovation run is a NEW run')
  assert.notStrictEqual(newRun.runId, oldRun.runId)
  assert.strictEqual(newRun.renovationOf, oldRun.runId)
  assert.strictEqual(newRun.renovationBaseHash, 'hash_old_base')

  // reconciliation-style demolition: exactly the old block the new blueprint
  // no longer claims, persisted with the renovationClear marker
  const demolition = Object.values(newRun.steps).filter(step => step.renovationClear === true)
  assert.strictEqual(demolition.length, 1, JSON.stringify(demolition))
  assert.deepStrictEqual(demolition[0].target, { x: 3, y: 64, z: 0 })
  assert.strictEqual(demolition[0].renovationOf, oldRun.runId)

  // the old record is untouched by starting the renovation (byte-identical)
  assert.strictEqual(JSON.stringify(store.getRun(oldRun.runId)), oldRecordBefore)

  // executing the plan actually demolishes the superseded block (the clear
  // policy authorizes renovation_clear for the matching lineage run)
  await system2.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 10 })
  assert.ok(
    ctx.cleared.some(entry => entry.position.x === 3 && entry.position.y === 64 && entry.position.z === 0),
    `demolition executed: ${JSON.stringify(ctx.cleared)}`
  )
}

async function testRenovationRejectsInvalidLineageTargets() {
  const store = createRunStore()
  const oldRun = renovationOldRunFixture(store)
  const dir = createBlueprintDir([renovationNewBlueprint()])

  // nonexistent target
  const ctx1 = renovationSiteContext()
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const missing = await startSystemWithOptions(system1, ctx1, 'reno_line', { x: 0, y: 64, z: 0 }, {
    renovationOf: 'construction_run_does_not_exist'
  })
  assert.strictEqual(missing.ok, false)
  assert.strictEqual(missing.error, 'RENOVATION_TARGET_NOT_FOUND')
  assert.strictEqual(activeRun(store), undefined)

  // non-COMPLETED target
  const activeTarget = createConstructionRun({
    blueprintId: 'other_line',
    blueprintHash: 'hash_active',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    bounds: { minX: 0, maxX: 3, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    steps: []
  })
  store.upsertRun(activeTarget)
  const ctx2 = renovationSiteContext()
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const notCompleted = await startSystemWithOptions(system2, ctx2, 'reno_line', { x: 0, y: 64, z: 0 }, {
    renovationOf: activeTarget.runId
  })
  assert.strictEqual(notCompleted.ok, false)
  assert.strictEqual(notCompleted.error, 'RENOVATION_TARGET_NOT_COMPLETED')
  store.abandonRun(activeTarget.runId, 'test_cleanup')

  // bounds that do not overlap the new placement
  const farRun = renovationOldRunFixture(store)
  store.updateRun(farRun.runId, run => ({
    ...run,
    bounds: { minX: 500, maxX: 503, minY: 64, maxY: 64, minZ: 500, maxZ: 500 }
  }))
  const ctx3 = renovationSiteContext()
  const system3 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const disjoint = await startSystemWithOptions(system3, ctx3, 'reno_line', { x: 0, y: 64, z: 0 }, {
    renovationOf: farRun.runId
  })
  assert.strictEqual(disjoint.ok, false)
  assert.strictEqual(disjoint.error, 'RENOVATION_BOUNDS_DO_NOT_OVERLAP')

  // site no longer matches the base blueprint (razed / different building)
  const store2 = createRunStore()
  const oldRun2 = renovationOldRunFixture(store2)
  const razedCtx = createContext([
    { name: 'oak_planks', count: 20 },
    { name: 'oak_log', count: 8 }
  ], { occupied: [] })
  const system4 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store2 })
  const razed = await startSystemWithOptions(system4, razedCtx, 'reno_line', { x: 0, y: 64, z: 0 }, {
    renovationOf: oldRun2.runId
  })
  assert.strictEqual(razed.ok, false)
  assert.strictEqual(razed.error, 'RENOVATION_SITE_DOES_NOT_MATCH_BASE_BLUEPRINT')
  assert.strictEqual(JSON.stringify(store.getRun(oldRun.runId)), JSON.stringify(oldRun), 'old record untouched by rejections')
}

async function testOrdinaryRunsCarryNoRenovationFields() {
  const run = createConstructionRun({
    blueprintId: 'plain',
    blueprintHash: 'hash_plain',
    placementContext: { origin: { x: 0, y: 64, z: 0 } },
    steps: [{ id: 'step_a', kind: 'place', position: { x: 0, y: 64, z: 0 }, blockName: 'oak_planks', phase: 'foundation' }]
  })
  assert.strictEqual(run.renovationOf, null)
  assert.strictEqual(run.renovationBaseHash, null)
  assert.ok(!('renovationClear' in run.steps.step_a), 'ordinary steps carry no renovation marker')
}

async function testRescueExistingBuildIsReadOnly() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('rescue_read_only', 3)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }], {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'oak_planks' },
      { x: 1, y: 64, z: 0, name: 'oak_planks' }
    ]
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const report = system.rescueExistingBuild(ctx, 'rescue_read_only', { x: 0, y: 64, z: 0 }, {
    existingStructureBlockThreshold: 1
  })

  assert.strictEqual(report.ok, true)
  assert.strictEqual(report.mode, 'RESCUE_EXISTING_BUILD')
  assert.strictEqual(report.canResume, true)
  assert.strictEqual(report.verifiedBlocks, 2)
  assert.strictEqual(report.missingBlocks, 1)
  assert.ok(report.pendingSteps >= 1)
  assert.strictEqual(ctx.placed.length, 0)
  assert.strictEqual(ctx.cleared.length, 0)
  assert.strictEqual(store.listRuns().length, 0)
}

async function testSameRunConvergesAcrossTwoRestartsAndCompletes() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('restart_twice', 3)])
  const ctx = createContext([{ name: 'oak_planks', count: 20 }])

  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'restart_twice')
  await system1.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  const runId = activeRun(store).runId

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'restart_twice')
  await system2.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(activeRun(store).runId, runId)

  const system3 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system3, ctx, 'restart_twice')
  for (let i = 0; i < 6 && system3.getStatus().buildStatus !== 'COMPLETED'; i++) {
    await system3.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  }
  const completed = store.getRun(runId)
  assert.strictEqual(completed.terminalState, 'COMPLETED')
  assert.strictEqual(activeRun(store), undefined)
}

async function testFailedWithoutTerminalStateRemainsResumable() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('failed_resume_clear', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 5 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx, 'failed_resume_clear')
  const startedRun = activeRun(store)
  store.upsertRun({
    ...startedRun,
    status: 'FAILED',
    terminalState: null,
    blockedReason: 'old_retryable_failure'
  })

  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system2, ctx, 'failed_resume_clear')
  const resumedRun = activeRun(store)
  assert.strictEqual(resumedRun.runId, startedRun.runId)
  assert.strictEqual(resumedRun.status, 'ACTIVE')
  assert.strictEqual(resumedRun.terminalState, null)
  assert.strictEqual(resumedRun.blockedReason, null)

  const resumable = {
    runId: 'failed-resumable-run',
    blueprintId: 'failed-resumable',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'FAILED',
    terminalState: null,
    steps: {}
  }
  const terminal = {
    ...resumable,
    runId: 'failed-terminal-run',
    status: 'FAILED',
    terminalState: 'FAILED'
  }
  store.upsertRun(resumable)
  store.upsertRun(terminal)

  assert.strictEqual(isRunActive(resumable), true)
  assert.strictEqual(isRunActive(terminal), false)
  assert.strictEqual(store.findActiveCompatible(resumable).runId, resumable.runId)
}

async function testCompletedRunIsNotActive() {
  const store = createRunStore()
  const run = {
    runId: 'completed-run',
    blueprintId: 'done',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'COMPLETED',
    terminalState: 'COMPLETED',
    steps: {}
  }
  store.upsertRun(run)
  assert.strictEqual(store.findActiveCompatible(run), null)
  assert.strictEqual(constructionRunCompatibility(run, run).ok, true)
}

async function testActiveRunTerrainMaterialResolutionPreservesVerifiedSteps() {
  const store = createRunStore()
  const dir = createBlueprintDir([grassTerrainBlueprint('terrain_resume', 3)])
  const ctx1 = createContext([{ name: 'grass_block', count: 3 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx1, 'terrain_resume')
  const firstRun = activeRun(store)
  const firstGrassStep = Object.values(firstRun.steps).find(step => step.block?.id === 'grass_block')
  assert.ok(firstGrassStep, 'missing grass step')
  store.updateStep(firstRun.runId, firstGrassStep.id, { status: STEP_STATE.VERIFIED })

  const target = firstGrassStep.target
  const ctx2 = createContext([{ name: 'dirt', count: 3 }], {
    occupied: [{ x: target.x, y: target.y, z: target.z, name: 'grass_block' }]
  })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx2, 'terrain_resume')
  assert.strictEqual(started.ok, true, started.error)

  const resumed = activeRun(store)
  assert.strictEqual(resumed.runId, firstRun.runId)
  assert.strictEqual(store.listRuns().filter(isRunActive).length, 1)
  assert.strictEqual(system2.session.resumedConstructionRun, true)
  assert.strictEqual(ctx2.placed.length, 0)
  assert.strictEqual(Object.values(resumed.steps).filter(step => step.status === STEP_STATE.VERIFIED).length, 1)

  const resolvedPending = Object.values(resumed.steps)
    .filter(step => step.status === STEP_STATE.PENDING && step.originalBlock?.id === 'grass_block')
  assert.strictEqual(resolvedPending.length, 2)
  for (const step of resolvedPending) {
    assert.strictEqual(step.originalBlock.id, 'grass_block')
    assert.strictEqual(step.resolvedBlock.id, 'dirt')
    assert.strictEqual(step.block.id, 'dirt')
    assert.strictEqual(step.materialResolution.affectsWorldDiff, true)
    assert.strictEqual(step.materialResolution.exactRequired, false)
  }
  assert.strictEqual(system2.session.materialResolution.shortageResolvedCount, 0)
}

async function testRunScopedLeafMaterialOverrideUnblocksStagedResume() {
  const store = createRunStore()
  const dir = createBlueprintDir([azaleaLeafBlueprint('leaf_override_resume')])
  const ctx1 = createContext([{ name: 'azalea_leaves', count: 1 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx1, 'leaf_override_resume')
  const firstRun = activeRun(store)
  const leafStep = findPlacementStep(firstRun, 'azalea_leaves')
  assert.ok(leafStep, 'missing azalea leaf step')
  const runId = firstRun.runId

  store.updateRun(runId, run => ({
    ...run,
    status: 'BLOCKED_MATERIAL_SHORTAGE',
    blockedReason: 'BLOCKED_MATERIAL_SHORTAGE:frame:azalea_leaves:1',
    materialOverrides: [{
      originalBlock: 'azalea_leaves',
      resolvedBlock: 'oak_leaves',
      reason: 'USER_APPROVED_DECORATIVE_LEAF_SUBSTITUTION',
      userApproved: true,
      scope: 'currentRun',
      affectsWorldDiff: true,
      sourceStepIds: [leafStep.id]
    }]
  }))

  const ctx2 = createContext([{ name: 'oak_leaves', count: 1 }, { name: 'chest', count: 1 }], {
    storageSystem: {
      async takeItems() {
        return { ok: true, withdrawnItems: [] }
      },
      async getStagingInventory() {
        return {
          counts: { oak_leaves: 1 },
          chests: [{
            position: { x: 2, y: 64, z: 0 },
            source: 'test_staging_chest',
            verified: true
          }]
        }
      }
    }
  })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx2, 'leaf_override_resume', { x: 0, y: 64, z: 0 }, {
    allowStorageRefill: true,
    stagedStorageRefill: true
  })
  assert.strictEqual(started.ok, true, started.error)

  const resumed = activeRun(store)
  assert.strictEqual(resumed.runId, runId)
  assert.strictEqual(store.listRuns().filter(isRunActive).length, 1)
  assert.strictEqual(system2.session.resumedConstructionRun, true)

  const resolvedStep = resumed.steps[leafStep.id]
  assert.strictEqual(resolvedStep.originalBlock.id, 'azalea_leaves')
  assert.strictEqual(resolvedStep.resolvedBlock.id, 'oak_leaves')
  assert.strictEqual(resolvedStep.block.id, 'oak_leaves')
  assert.deepStrictEqual(resolvedStep.materialAlternatives, ['azalea_leaves', 'oak_leaves'])
  assert.strictEqual(resolvedStep.exactRequired, false)
  assert.strictEqual(resolvedStep.materialResolution.reason, 'USER_APPROVED_DECORATIVE_LEAF_SUBSTITUTION')
  assert.strictEqual(resolvedStep.materialResolution.userApproved, true)
  assert.strictEqual(resolvedStep.materialResolution.scope, 'currentRun')
  assert.strictEqual(resolvedStep.materialResolution.affectsWorldDiff, true)
  assert.deepStrictEqual(resolvedStep.materialResolution.sourceStepIds, [leafStep.id])
  assert.strictEqual(system2.session.materialResolution.originalRequired.azalea_leaves, 1)
  assert.strictEqual(system2.session.materialResolution.resolvedRequired.oak_leaves, 1)
  assert.strictEqual(system2.session.materialResolution.shortageOriginal[0].item, 'azalea_leaves')
  assert.strictEqual(system2.session.materialResolution.shortageOriginal[0].missing, 1)
  assert.strictEqual(system2.session.materialResolution.shortageResolvedCount, 0)
}

async function testRunScopedStateOverrideUpdatesExecutionAndWorldDiffTarget() {
  const store = createRunStore()
  const dir = createBlueprintDir([mirroredWallButtonBlueprint('state_override_wall_button')])
  const ctx1 = createContext([{ name: 'dark_oak_button', count: 1 }, { name: 'stone', count: 1 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx1, 'state_override_wall_button')
  const firstRun = activeRun(store)
  const buttonStep = findPlacementStep(firstRun, 'dark_oak_button')
  assert.ok(buttonStep, 'missing button step')

  store.updateRun(firstRun.runId, run => ({
    ...run,
    stateOverrides: [{
      blockId: 'dark_oak_button',
      states: { face: 'wall', facing: 'north', powered: 'false' },
      reason: 'LITEMATIC_NEGATIVE_Z_FACING_NORMALIZATION',
      scope: 'currentRun',
      affectsWorldDiff: true,
      sourceStepIds: [buttonStep.id]
    }]
  }))

  const ctx2 = createContext([{ name: 'dark_oak_button', count: 1 }, { name: 'stone', count: 1 }], {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'dark_oak_button', states: { face: 'wall', facing: 'north', powered: 'false' } },
      { x: 0, y: 64, z: 1, name: 'stone' }
    ]
  })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx2, 'state_override_wall_button')
  assert.strictEqual(started.ok, true, started.error)

  const resumed = activeRun(store)
  const resumedButton = resumed.steps[buttonStep.id]
  assert.strictEqual(resumed.runId, firstRun.runId)
  assert.strictEqual(system2.session.resumedConstructionRun, true)
  assert.strictEqual(resumedButton.status, STEP_STATE.VERIFIED)
  assert.strictEqual(resumedButton.block.states.facing, 'north')
  assert.strictEqual(resumedButton.stateNormalization.reason, 'LITEMATIC_NEGATIVE_Z_FACING_NORMALIZATION')
  const targetWorldBlock = system2.session.worldBlocks.find(block =>
    block.position?.x === 0 &&
    block.position?.y === 64 &&
    block.position?.z === 0
  )
  assert.strictEqual(targetWorldBlock.states.facing, 'north')
  const executionStep = system2.session.orderPlan.steps.find(step => step.id === buttonStep.id)
  assert.strictEqual(executionStep.states.facing, 'north')
}

async function testStagedTerrainMaterialResolutionReconcilesSatisfiedFallback() {
  const store = createRunStore()
  const dir = createBlueprintDir([grassTerrainBlueprint('terrain_staged_resolution', 2)])
  const ctx1 = createContext([{ name: 'grass_block', count: 2 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx1, 'terrain_staged_resolution')
  const firstRun = activeRun(store)
  const grassStep = Object.values(firstRun.steps).find(step => step.block?.id === 'grass_block')
  assert.ok(grassStep, 'missing grass step')
  const staleClearId = 'stale-clear-for-resolved-terrain'
  store.updateRun(firstRun.runId, run => ({
    ...run,
    steps: {
      ...(run.steps || {}),
      [staleClearId]: {
        id: staleClearId,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: 'clear_obstruction',
        target: grassStep.target,
        block: null,
        status: STEP_STATE.PENDING,
        retry: { count: 0, lastError: null }
      }
    }
  }))

  const target = grassStep.target
  const ctx2 = createContext([{ name: 'chest', count: 1 }], {
    occupied: [{ x: target.x, y: target.y, z: target.z, name: 'dirt' }],
    storageSystem: {
      async takeItems() {
        return { ok: true, withdrawnItems: [] }
      },
      async getStagingInventory() {
        return { counts: { dirt: 2 }, chests: [] }
      }
    }
  })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx2, 'terrain_staged_resolution', { x: 0, y: 64, z: 0 }, {
    allowStorageRefill: true,
    stagedStorageRefill: true
  })
  assert.strictEqual(started.ok, true, started.error)

  const resumed = activeRun(store)
  const resumedStep = resumed.steps[grassStep.id]
  assert.strictEqual(resumedStep.block.id, 'dirt')
  assert.strictEqual(resumedStep.originalBlock.id, 'grass_block')
  assert.strictEqual(resumedStep.resolvedBlock.id, 'dirt')
  assert.strictEqual(resumedStep.status, STEP_STATE.VERIFIED)
  assert.strictEqual(resumed.steps[staleClearId].status, STEP_STATE.VERIFIED)

  const ctx3 = createContext([{ name: 'chest', count: 1 }], {
    occupied: [{ x: target.x, y: target.y, z: target.z, name: 'dirt' }],
    storageSystem: {
      async takeItems() {
        return { ok: true, withdrawnItems: [] }
      },
      async getStagingInventory() {
        return { counts: { grass_block: 2, dirt: 2 }, chests: [] }
      }
    }
  })
  const system3 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const restarted = await startSystemWithOptions(system3, ctx3, 'terrain_staged_resolution', { x: 0, y: 64, z: 0 }, {
    allowStorageRefill: true,
    stagedStorageRefill: true
  })
  assert.strictEqual(restarted.ok, true, restarted.error)

  const resumedAgain = activeRun(store)
  const stableFallback = resumedAgain.steps[grassStep.id]
  assert.strictEqual(stableFallback.block.id, 'dirt')
  assert.strictEqual(stableFallback.originalBlock.id, 'grass_block')
  assert.strictEqual(stableFallback.resolvedBlock.id, 'dirt')
  assert.strictEqual(stableFallback.status, STEP_STATE.VERIFIED)
  assert.strictEqual(resumedAgain.steps[staleClearId].status, STEP_STATE.VERIFIED)
}

async function testResolvedDirtIgnoresGrassSnowyStateAcrossResume() {
  const store = createRunStore()
  const dir = createBlueprintDir([snowyGrassTerrainBlueprint('terrain_snowy_state_dirt')])
  const origin = { x: 0, y: 64, z: 0 }
  const ctx1 = createContext([{ name: 'dirt', count: 1 }], {
    occupied: [{ x: origin.x, y: origin.y, z: origin.z, name: 'dirt' }]
  })
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system1, ctx1, 'terrain_snowy_state_dirt', origin)
  assert.strictEqual(started.ok, true, started.error)

  const firstRun = activeRun(store)
  const terrainStep = Object.values(firstRun.steps || {}).find(step => step.block?.id === 'dirt')
  assert.ok(terrainStep, `missing resolved dirt terrain step: ${JSON.stringify(firstRun.steps)}`)
  assert.strictEqual(terrainStep.originalBlock.id, 'grass_block')
  assert.strictEqual(terrainStep.status, STEP_STATE.VERIFIED)
  store.updateRun(firstRun.runId, run => ({
    ...run,
    steps: {
      ...(run.steps || {}),
      [terrainStep.id]: {
        ...run.steps[terrainStep.id],
        block: { ...(run.steps[terrainStep.id].block || {}), states: { snowy: 'false' } },
        resolvedBlock: { id: 'dirt', states: { snowy: 'false' } }
      }
    }
  }))

  const ctx2 = createContext([{ name: 'dirt', count: 1 }], {
    occupied: [{ x: origin.x, y: origin.y, z: origin.z, name: 'dirt' }]
  })
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const resumed = await startSystemWithOptions(system2, ctx2, 'terrain_snowy_state_dirt', origin)
  assert.strictEqual(resumed.ok, true, resumed.error)

  const resumedRun = activeRun(store)
  const resumedStep = resumedRun.steps[terrainStep.id]
  assert.strictEqual(resumedStep.block.id, 'dirt')
  assert.strictEqual(resumedStep.block.states.snowy, 'false')
  assert.strictEqual(resumedStep.status, STEP_STATE.VERIFIED)
}

async function testTemporaryReferenceItemFailureRemainsRetryable() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('temporary_reference_retryable', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 1 }])
  let executedStep = null
  const system = createBuildingSystem({
    blueprintDir: dir,
    constructionRunStore: store,
    executor: {
      async executeStep(_context, step) {
        executedStep = step
        return { ok: false, error: 'stair_temporary_reference_item:block_item_not_found' }
      }
    }
  })
  await startSystem(system, ctx, 'temporary_reference_retryable')

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'stair_temporary_reference_item:block_item_not_found')
  assert.ok(executedStep, 'expected step execution')

  const saved = store.getRun(system.session.constructionRunId)
  const savedStep = saved.steps[executedStep.id]
  assert.strictEqual(saved.status, 'ACTIVE')
  assert.strictEqual(saved.terminalState, null)
  assert.strictEqual(savedStep.status, STEP_STATE.RETRYABLE_FAILED)
  assert.strictEqual(savedStep.retry.lastError, 'stair_temporary_reference_item:block_item_not_found')
}

async function testUnresolvedTerrainMaterialShortageBlocksResumeBeforePlacement() {
  const store = createRunStore()
  const dir = createBlueprintDir([grassTerrainBlueprint('terrain_shortage_blocks', 3)])
  const ctx1 = createContext([{ name: 'grass_block', count: 3 }])
  const system1 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system1, ctx1, 'terrain_shortage_blocks')
  const runId = activeRun(store).runId

  const ctx2 = createContext([{ name: 'dirt', count: 1 }])
  const system2 = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  const started = await startSystemWithOptions(system2, ctx2, 'terrain_shortage_blocks')

  assert.strictEqual(started.ok, false)
  assert.strictEqual(started.error, 'missing_materials')
  assert.strictEqual(activeRun(store).runId, runId)
  assert.strictEqual(ctx2.placed.length, 0)
}

async function testTerrainObstructionClearRecordsNoRestore() {
  const store = createRunStore()
  const dir = createBlueprintDir([{
    name: 'terrain_clear_policy',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'dirt' }]
  }])
  const ctx = createContext([{ name: 'dirt', count: 2 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'tall_grass' }]
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'terrain_clear_policy')

  const clearStep = system.session.steps.find(step => step.kind === 'clear')
  const placeStep = system.session.steps.find(step => step.kind === 'place')
  assert.ok(clearStep, 'missing clear step')
  assert.ok(placeStep, 'missing place step')

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.cleared.length, 1)
  assert.strictEqual(ctx.cleared[0].name, 'tall_grass')

  const saved = store.getRun(system.session.constructionRunId)
  assert.strictEqual(saved.steps[clearStep.id].clearReason, 'terrain_obstruction')
  assert.strictEqual(saved.steps[clearStep.id].clearCategory, 'terrain_obstruction')
  assert.strictEqual(saved.steps[clearStep.id].expectedAfter, 'dirt')
  assert.strictEqual(saved.steps[clearStep.id].replacementStepId, placeStep.id)
  assert.strictEqual(saved.steps[clearStep.id].restoreRequired, false)
}

async function testWrongBlockClearRequiresFollowupPlace() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('wrong_block_clear_policy', 1)])
  const ctx = createContext([{ name: 'oak_planks', count: 2 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'cobblestone' }]
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'wrong_block_clear_policy')

  const clearStep = system.session.steps.find(step => step.kind === 'clear')
  const placeStep = system.session.steps.find(step => step.kind === 'place')
  const cleared = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(cleared.ok, true, cleared.error)
  let saved = store.getRun(system.session.constructionRunId)
  assert.strictEqual(saved.steps[clearStep.id].clearReason, 'wrong_block_at_target')
  assert.strictEqual(saved.steps[clearStep.id].replacementStepId, placeStep.id)
  assert.strictEqual(saved.steps[placeStep.id].status, STEP_STATE.REPAIR)

  const placed = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(placed.ok, true, placed.error)
  assert.strictEqual(ctx.placed.length, 1)
  saved = store.getRun(system.session.constructionRunId)
  assert.strictEqual(saved.steps[placeStep.id].status, STEP_STATE.VERIFIED)
}

async function testPrepareReconcilesRuntimeMaterialBeforeStoredClear() {
  const store = createRunStore()
  const position = { x: 0, y: 64, z: 0 }
  const placement = { origin: position, rotationY: 0, mirror: { x: false, z: false } }
  const ctx = createContext([{ name: 'stone', count: 1 }], {
    occupied: [{ ...position, name: 'stone' }]
  })
  const system = createBuildingSystem({ constructionRunStore: store })
  const runtimePlaceStep = {
    id: 'step_stale_expected_material',
    kind: 'place',
    action: 'place_block',
    phase: 'frame',
    position,
    blockName: 'stone',
    block: { id: 'stone', states: {} },
    sourceBlockKey: 'source_stale_material',
    materialAlternatives: ['stone', 'lantern'],
    exactRequired: true,
    dependencies: []
  }
  const staleClearStep = {
    id: 'step_stale_clear',
    kind: 'clear',
    action: 'clear_block',
    phase: 'clear_obstruction',
    position,
    targetType: 'lantern',
    sourceBlockKey: runtimePlaceStep.sourceBlockKey,
    materialAlternatives: ['lantern'],
    exactRequired: true,
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_runtime_material_before_clear',
    blueprintId: 'runtime_material_before_clear',
    blueprintRevision: 'rev',
    blueprintHash: 'hash',
    planId: 'plan_original',
    placementContext: placement,
    world: { dimension: 'overworld' },
    bounds: { minX: 0, maxX: 0, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    stagingChests: [],
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'site_prepare',
    steps: {
      [runtimePlaceStep.id]: {
        id: runtimePlaceStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: 'frame',
        lifecyclePhase: 'frame',
        target: position,
        block: { id: 'lantern', states: {} },
        sourceBlockKey: runtimePlaceStep.sourceBlockKey,
        materialAlternatives: ['lantern'],
        exactRequired: true,
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.VERIFIED
      },
      [staleClearStep.id]: {
        id: staleClearStep.id,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: 'clear_obstruction',
        lifecyclePhase: 'site_prepare',
        target: position,
        sourceBlockKey: staleClearStep.sourceBlockKey,
        materialAlternatives: ['lantern'],
        exactRequired: true,
        dependencies: [],
        retry: { count: 1, lastError: 'USER_APPROVAL_REQUIRED' },
        status: STEP_STATE.TERMINAL_FAILED
      }
    }
  })
  const preview = {
    blueprintName: 'runtime_material_before_clear',
    blueprint: {
      name: 'runtime_material_before_clear',
      origin: { x: 0, y: 0, z: 0 },
      blocks: [{ x: 0, y: 0, z: 0, type: 'stone' }]
    },
    blueprintIR: {
      schemaVersion: 1,
      id: 'runtime_material_before_clear',
      name: 'runtime_material_before_clear',
      metadata: { revision: 'rev', frozen: true },
      blocks: [],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
    },
    selectedBlueprint: { sourceKind: 'test_fixture' },
    origin: position,
    worldBlocks: [{ x: 0, y: 0, z: 0, type: 'stone', position }],
    constructionPlan: {
      planId: 'plan_runtime',
      blueprintId: 'runtime_material_before_clear',
      blueprintRevision: 'rev',
      blueprintHash: 'hash',
      placement,
      materials: { required: { stone: 1 }, missing: [] },
      steps: [runtimePlaceStep]
    },
    orderPlan: {
      steps: [runtimePlaceStep],
      summary: { place: 1, totalSteps: 1 }
    },
    sitePlan: { summary: { totalTargets: 1, scaffoldBlocks: 0 } },
    materialPlan: {
      requiredMaterials: { stone: 1 },
      formalRequiredMaterials: { stone: 1 },
      missingMaterials: []
    },
    requiredMaterials: { stone: 1 },
    missingMaterials: [],
    totalBlocks: 1,
    designSpec: {
      designSpecId: 'design_runtime_material_before_clear',
      revision: 'design_rev',
      hash: 'design_hash',
      frozen: true,
      buildingType: 'test_fixture',
      style: 'test',
      width: 1,
      depth: 1,
      height: 1,
      floors: 1,
      roomLayout: { rooms: [] },
      functionalPoints: [],
      primaryMaterials: []
    },
    blueprintFreeze: {
      schemaVersion: 1,
      frozen: true,
      blueprintId: 'runtime_material_before_clear',
      blueprintRevision: 'rev',
      blueprintHash: 'hash',
      planId: 'plan_runtime',
      designSpecId: 'design_runtime_material_before_clear',
      designSpecRevision: 'design_rev'
    }
  }

  const prepared = await system.prepareConstructionRun(ctx, preview, { owner: 'test', allowStorageRefill: false })
  assert.strictEqual(prepared.ok, true, prepared.error)
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[runtimePlaceStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[runtimePlaceStep.id].block.id, 'stone')
  assert.strictEqual(saved.steps[staleClearStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(ctx.cleared.length, 0)
}

async function testExactClearDefersToPlacementRepair() {
  const store = createRunStore()
  const ctx = createContext([{ name: 'oak_planks', count: 2 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'stone' }]
  })
  const system = createBuildingSystem({ constructionRunStore: store })
  const position = { x: 0, y: 64, z: 0 }
  const clearStep = {
    id: 'step_exact_clear',
    kind: 'clear',
    action: 'clear_block',
    phase: 'clear_obstruction',
    position,
    targetType: 'oak_planks',
    sourceBlockKey: 'b_exact_clear',
    exactRequired: true,
    dependencies: []
  }
  const placeStep = {
    id: 'step_exact_place',
    kind: 'place',
    action: 'place_block',
    phase: 'frame',
    position,
    blockName: 'oak_planks',
    block: { id: 'oak_planks', states: {} },
    sourceBlockKey: 'b_exact_clear',
    exactRequired: true,
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_exact_clear_defers',
    blueprintId: 'exact_clear_defers',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'site_prepare',
    steps: {
      [clearStep.id]: {
        id: clearStep.id,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: 'clear_obstruction',
        lifecyclePhase: 'site_prepare',
        target: position,
        sourceBlockKey: clearStep.sourceBlockKey,
        exactRequired: true,
        dependencies: [],
        retry: { count: 1, lastError: 'USER_APPROVAL_REQUIRED' },
        status: STEP_STATE.TERMINAL_FAILED
      },
      [placeStep.id]: {
        id: placeStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: 'frame',
        lifecyclePhase: 'frame',
        target: position,
        block: { id: 'oak_planks', states: {} },
        sourceBlockKey: placeStep.sourceBlockKey,
        exactRequired: true,
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.REPAIR
      }
    }
  })
  system.session = {
    steps: [clearStep, placeStep],
    currentStepIndex: 0,
    constructionRun: run,
    constructionRunId: run.runId,
    phaseGates: {},
    phaseGateSessionId: `${run.runId}:test`,
    status: 'RUNNING',
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    materialPlan: { required: { oak_planks: 1 } }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.cleared.length, 1)
  assert.strictEqual(ctx.cleared[0].name, 'stone')
  assert.strictEqual(ctx.placed.length, 1)
  assert.strictEqual(ctx.placed[0].blockName, 'oak_planks')
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[placeStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[clearStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[clearStep.id].skipReason, 'clear_target_already_matches_placement')
  assert.strictEqual(saved.steps[clearStep.id].replacementStepId, placeStep.id)
  assert.strictEqual(saved.currentPhase, 'frame')
}

async function testResolvedExactClearYieldsToStateRepairPlacement() {
  const store = createRunStore()
  const position = { x: 0, y: 64, z: 0 }
  const expectedStates = {
    half: 'top',
    facing: 'east',
    open: 'false',
    powered: 'false',
    waterlogged: 'false'
  }
  const ctx = createContext([{ name: 'spruce_trapdoor', count: 1 }], {
    occupied: [{
      ...position,
      name: 'spruce_trapdoor',
      states: { ...expectedStates, facing: 'north' }
    }]
  })
  let executedStep = null
  const system = createBuildingSystem({
    constructionRunStore: store,
    executor: {
      executeStep: async (_context, step) => {
        executedStep = step
        return { ok: true }
      }
    }
  })
  const clearStep = {
    id: 'step_resolved_clear',
    kind: 'clear',
    action: 'clear_block',
    phase: 'clear_obstruction',
    position,
    sourceBlockKey: 'b_resolved_clear',
    role: 'trapdoor',
    exactRequired: true,
    materialAlternatives: ['spruce_trapdoor'],
    dependencies: []
  }
  const placeStep = {
    id: 'step_state_repair_place',
    kind: 'place',
    action: 'place_block',
    phase: 'doors_windows',
    position,
    blockName: 'spruce_trapdoor',
    block: { id: 'spruce_trapdoor', states: expectedStates },
    states: expectedStates,
    orientation: expectedStates,
    sourceBlockKey: 'b_resolved_clear',
    role: 'trapdoor',
    exactRequired: true,
    materialAlternatives: ['spruce_trapdoor'],
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_resolved_clear_yields_to_state_repair',
    blueprintId: 'resolved_clear_yields_to_state_repair',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'site_prepare',
    steps: {
      [clearStep.id]: {
        id: clearStep.id,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: 'clear_obstruction',
        lifecyclePhase: 'site_prepare',
        target: position,
        sourceBlockKey: clearStep.sourceBlockKey,
        role: 'trapdoor',
        exactRequired: true,
        materialAlternatives: ['spruce_trapdoor'],
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING,
        clearedAt: '2026-06-29T00:00:00.000Z',
        clearCategory: 'terrain_obstruction',
        clearReason: 'terrain_obstruction',
        expectedAfter: 'spruce_trapdoor',
        replacementStepId: placeStep.id
      },
      [placeStep.id]: {
        id: placeStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: 'doors_windows',
        lifecyclePhase: 'doors_windows',
        target: position,
        block: { id: 'spruce_trapdoor', states: expectedStates },
        sourceBlockKey: placeStep.sourceBlockKey,
        role: 'trapdoor',
        exactRequired: true,
        materialAlternatives: ['spruce_trapdoor'],
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.STATE_REPAIR
      }
    }
  })
  system.session = {
    steps: [clearStep, placeStep],
    currentStepIndex: 0,
    currentIndex: 0,
    placedBlocks: 0,
    clearedBlocks: 0,
    foundationBlocks: 0,
    scaffoldBlocks: 0,
    removedScaffoldBlocks: 0,
    constructionRun: run,
    constructionRunId: run.runId,
    phaseGates: {},
    phaseGateSessionId: `${run.runId}:test`,
    status: 'RUNNING',
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null,
    materialPlan: { required: { spruce_trapdoor: 1 } }
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(executedStep.id, placeStep.id)
  assert.deepStrictEqual(executedStep.states, expectedStates)
  assert.strictEqual(ctx.cleared.length, 0)
}

async function testResumeDoesNotPersistNewTransientScaffoldSteps() {
  const store = createRunStore()
  const ctx = createContext([{ name: 'oak_planks', count: 1 }, { name: 'dirt', count: 64 }])
  const system = createBuildingSystem({ constructionRunStore: store })
  const origin = { x: 0, y: 64, z: 0 }
  const placement = { origin, rotationY: 0, mirror: { x: false, z: false } }
  const frameStep = {
    id: 'step_frame_existing',
    kind: 'place',
    action: 'place_block',
    phase: 'frame',
    position: { x: 0, y: 64, z: 0 },
    blockName: 'oak_planks',
    dependencies: []
  }
  const newScaffoldPlace = {
    id: 'step_runtime_scaffold_place',
    kind: 'scaffold_place',
    action: 'place_block',
    phase: 'scaffold',
    position: { x: 2, y: 64, z: 0 },
    blockName: 'dirt',
    dependencies: []
  }
  const newScaffoldRemove = {
    id: 'step_runtime_scaffold_remove',
    kind: 'scaffold_remove',
    action: 'clear_block',
    phase: 'cleanup',
    position: { x: 2, y: 64, z: 0 },
    blockName: 'dirt',
    dependencies: [newScaffoldPlace.id]
  }
  const run = store.upsertRun({
    runId: 'run_scaffold_resume_filter',
    blueprintId: 'scaffold_resume_filter',
    blueprintRevision: 'rev',
    blueprintHash: 'hash',
    planId: 'plan_original',
    placementContext: placement,
    world: { dimension: 'overworld' },
    bounds: { minX: 0, maxX: 0, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    stagingChests: [],
    currentPhase: 'site_prepare',
    status: 'ACTIVE',
    terminalState: null,
    steps: {
      [frameStep.id]: {
        id: frameStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: 'frame',
        lifecyclePhase: 'frame',
        target: frameStep.position,
        block: { id: 'oak_planks', states: {} },
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING
      }
    }
  })
  const preview = {
    blueprintName: 'scaffold_resume_filter',
    blueprint: plankLineBlueprint('scaffold_resume_filter', 1),
    blueprintIR: {
      schemaVersion: 1,
      id: 'scaffold_resume_filter',
      name: 'scaffold_resume_filter',
      metadata: { revision: 'rev', frozen: true },
      blocks: [],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
    },
    selectedBlueprint: { sourceKind: 'test_fixture' },
    origin,
    worldBlocks: [{ x: 0, y: 0, z: 0, type: 'oak_planks', position: frameStep.position }],
    constructionPlan: {
      planId: 'plan_runtime',
      blueprintId: 'scaffold_resume_filter',
      blueprintRevision: 'rev',
      blueprintHash: 'hash',
      placement,
      materials: { required: { oak_planks: 1, dirt: 1 }, missing: [] },
      steps: [newScaffoldPlace, frameStep, newScaffoldRemove]
    },
    orderPlan: {
      steps: [newScaffoldPlace, frameStep, newScaffoldRemove],
      summary: { scaffoldPlace: 1, place: 1, scaffoldRemove: 1, totalSteps: 3 }
    },
    sitePlan: { summary: { totalTargets: 1, scaffoldBlocks: 1 } },
    materialPlan: {
      requiredMaterials: { oak_planks: 1, dirt: 1 },
      formalRequiredMaterials: { oak_planks: 1 },
      missingMaterials: []
    },
    requiredMaterials: { oak_planks: 1, dirt: 1 },
    missingMaterials: [],
    totalBlocks: 1,
    designSpec: {
      designSpecId: 'design_scaffold_resume_filter',
      revision: 'design_rev',
      hash: 'design_hash',
      frozen: true,
      buildingType: 'test_fixture',
      style: 'test',
      width: 1,
      depth: 1,
      height: 1,
      floors: 1,
      roomLayout: { rooms: [] },
      functionalPoints: [],
      primaryMaterials: []
    },
    blueprintFreeze: {
      schemaVersion: 1,
      frozen: true,
      blueprintId: 'scaffold_resume_filter',
      blueprintRevision: 'rev',
      blueprintHash: 'hash',
      planId: 'plan_runtime',
      designSpecId: 'design_scaffold_resume_filter',
      designSpecRevision: 'design_rev'
    }
  }

  const prepared = await system.prepareConstructionRun(ctx, preview, { owner: 'test', allowStorageRefill: false })
  assert.strictEqual(prepared.ok, true, prepared.error)
  assert.strictEqual(prepared.run.runId, run.runId)
  const saved = store.getRun(run.runId)
  assert.ok(saved.steps[frameStep.id])
  assert.strictEqual(saved.steps[newScaffoldPlace.id], undefined)
  assert.strictEqual(saved.steps[newScaffoldRemove.id], undefined)
  assert.deepStrictEqual(prepared.preview.orderPlan.steps.map(step => step.id), [frameStep.id])
}

async function testOptionalScaffoldSkipPersistsAcrossPrepare() {
  const store = createRunStore()
  const ctx = createContext([{ name: 'dirt', count: 64 }])
  const system = createBuildingSystem({ constructionRunStore: store })
  const origin = { x: 0, y: 64, z: 0 }
  const placement = { origin, rotationY: 0, mirror: { x: false, z: false } }
  const scaffoldStep = {
    id: 'step_optional_scaffold_skip',
    kind: 'scaffold_place',
    action: 'place_block',
    phase: 'scaffold',
    position: { x: 2, y: 70, z: 0 },
    blockName: 'dirt',
    sourceBlockKey: null,
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_optional_scaffold_skip',
    blueprintId: 'optional_scaffold_skip',
    blueprintRevision: 'rev',
    blueprintHash: 'hash',
    planId: 'plan_original',
    placementContext: placement,
    world: { dimension: 'overworld' },
    bounds: { minX: 0, maxX: 0, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    stagingChests: [],
    currentPhase: 'site_prepare',
    status: 'ACTIVE',
    terminalState: null,
    steps: {
      [scaffoldStep.id]: {
        id: scaffoldStep.id,
        action: 'place_block',
        legacyKind: 'scaffold_place',
        phase: 'scaffold',
        lifecyclePhase: 'site_prepare',
        target: scaffoldStep.position,
        block: { id: 'dirt', states: {} },
        sourceBlockKey: null,
        dependencies: [],
        retry: { count: 2, lastError: 'move_timeout' },
        status: STEP_STATE.VERIFIED,
        skipped: true,
        skipReason: 'optional_scaffold_move_timeout'
      }
    }
  })
  const preview = {
    blueprintName: 'optional_scaffold_skip',
    blueprint: { name: 'optional_scaffold_skip', origin: { x: 0, y: 0, z: 0 }, blocks: [] },
    blueprintIR: {
      schemaVersion: 1,
      id: 'optional_scaffold_skip',
      name: 'optional_scaffold_skip',
      metadata: { revision: 'rev', frozen: true },
      blocks: [],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
    },
    selectedBlueprint: { sourceKind: 'test_fixture' },
    origin,
    worldBlocks: [{ x: 0, y: 0, z: 0, type: 'air', position: origin }],
    constructionPlan: {
      planId: 'plan_runtime',
      blueprintId: 'optional_scaffold_skip',
      blueprintRevision: 'rev',
      blueprintHash: 'hash',
      placement,
      materials: { required: { dirt: 1 }, missing: [] },
      steps: [scaffoldStep]
    },
    orderPlan: {
      steps: [scaffoldStep],
      summary: { scaffoldPlace: 1, totalSteps: 1 }
    },
    sitePlan: { summary: { totalTargets: 0, scaffoldBlocks: 1 } },
    materialPlan: {
      requiredMaterials: { dirt: 1 },
      formalRequiredMaterials: {},
      missingMaterials: []
    },
    requiredMaterials: { dirt: 1 },
    missingMaterials: [],
    totalBlocks: 0,
    designSpec: {
      designSpecId: 'design_optional_scaffold_skip',
      revision: 'design_rev',
      hash: 'design_hash',
      frozen: true,
      buildingType: 'test_fixture',
      style: 'test',
      width: 1,
      depth: 1,
      height: 1,
      floors: 1,
      roomLayout: { rooms: [] },
      functionalPoints: [],
      primaryMaterials: []
    },
    blueprintFreeze: {
      schemaVersion: 1,
      frozen: true,
      blueprintId: 'optional_scaffold_skip',
      blueprintRevision: 'rev',
      blueprintHash: 'hash',
      planId: 'plan_runtime',
      designSpecId: 'design_optional_scaffold_skip',
      designSpecRevision: 'design_rev'
    }
  }

  const prepared = await system.prepareConstructionRun(ctx, preview, { owner: 'test', allowStorageRefill: false })
  assert.strictEqual(prepared.ok, true, prepared.error)
  assert.strictEqual(prepared.run.runId, run.runId)
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[scaffoldStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[scaffoldStep.id].skipped, true)
  assert.strictEqual(saved.steps[scaffoldStep.id].skipReason, 'optional_scaffold_move_timeout')
}

async function testScaffoldCleanupClearIsAllowed() {
  const store = createRunStore()
  const ctx = createContext([], {
    occupied: [{ x: 2, y: 64, z: 0, name: 'dirt' }]
  })
  const system = createBuildingSystem({ constructionRunStore: store })
  const step = {
    id: 'step_scaffold_cleanup_policy',
    kind: 'scaffold_remove',
    action: 'clear_block',
    phase: 'cleanup',
    position: { x: 2, y: 64, z: 0 },
    blockName: 'dirt',
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_scaffold_cleanup_policy',
    blueprintId: 'scaffold_cleanup_policy',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'cleanup',
    steps: {
      [step.id]: {
        id: step.id,
        action: 'clear_block',
        legacyKind: 'scaffold_remove',
        phase: 'cleanup',
        lifecyclePhase: 'cleanup',
        target: step.position,
        block: { id: 'dirt', states: {} },
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING
      }
    }
  })
  system.session = {
    steps: [step],
    currentStepIndex: 0,
    constructionRun: run,
    constructionRunId: run.runId,
    phaseGates: {},
    phaseGateSessionId: `${run.runId}:test`,
    status: 'RUNNING',
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.cleared.length, 1)
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[step.id].clearReason, 'temporary_scaffold_cleanup')
  assert.strictEqual(saved.steps[step.id].restoreRequired, false)
}

function testVerifiedScaffoldCleanupWithRemainingBlockReconcilesToCleanup() {
  const position = { x: 2, y: 64, z: 0 }
  const ctx = createContext([], {
    occupied: [{ ...position, name: 'dirt' }]
  })
  const step = {
    id: 'step_verified_scaffold_cleanup_reconcile',
    kind: 'scaffold_remove',
    action: 'clear_block',
    phase: 'cleanup',
    position,
    blockName: 'dirt',
    dependencies: []
  }
  const previous = {
    id: step.id,
    legacyKind: step.kind,
    action: step.action,
    status: STEP_STATE.VERIFIED,
    target: position,
    block: { id: 'dirt', states: {} }
  }

  assert.strictEqual(
    buildingSystemTest.reconciledStepStatus(ctx, step, previous),
    STEP_STATE.CLEANUP
  )
  ctx.occupied.delete(`${position.x},${position.y},${position.z}`)
  assert.strictEqual(
    buildingSystemTest.reconciledStepStatus(ctx, step, previous),
    STEP_STATE.VERIFIED
  )
}

function testVerifiedScaffoldCleanupPreventsPlacementRebuildOnResume() {
  const position = { x: 2, y: 64, z: 0 }
  const ctx = createContext([])
  const placement = {
    id: 'step_scaffold_place_completed_lifecycle',
    kind: 'scaffold_place',
    action: 'place_block',
    phase: 'scaffold',
    position,
    blockName: 'dirt',
    dependencies: []
  }
  const cleanup = {
    id: 'step_scaffold_remove_completed_lifecycle',
    kind: 'scaffold_remove',
    action: 'clear_block',
    phase: 'cleanup',
    position,
    blockName: 'dirt',
    dependencies: []
  }
  const cleanupState = {
    id: cleanup.id,
    status: STEP_STATE.VERIFIED,
    target: position,
    replacementStepId: placement.id,
    clearedAt: new Date().toISOString()
  }

  assert.strictEqual(
    buildingSystemTest.reconciledStepStatus(ctx, placement, {
      id: placement.id,
      status: STEP_STATE.PENDING,
      target: position,
      block: { id: 'dirt', states: {} }
    }, {
      steps: [placement, cleanup],
      runSteps: { [cleanup.id]: cleanupState }
    }),
    STEP_STATE.VERIFIED
  )

  assert.strictEqual(
    buildingSystemTest.reconciledStepStatus(ctx, placement, {
      id: placement.id,
      status: STEP_STATE.PENDING,
      target: position,
      block: { id: 'dirt', states: {} }
    }, {
      steps: [placement, cleanup],
      runSteps: { [cleanup.id]: { ...cleanupState, status: STEP_STATE.PENDING } }
    }),
    STEP_STATE.PENDING
  )
}

async function testVerifiedStructuralFinalBlockClearIsSkippedWhenAlreadySatisfied() {
  const store = createRunStore()
  const ctx = createContext([], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'oak_planks' }]
  })
  const system = createBuildingSystem({ constructionRunStore: store })
  const clearStep = {
    id: 'step_structural_clear',
    kind: 'clear',
    action: 'clear_block',
    phase: 'clear_obstruction',
    position: { x: 0, y: 64, z: 0 },
    sourceBlockKey: 'source_0',
    dependencies: []
  }
  const placeStep = {
    id: 'step_structural_place',
    kind: 'place',
    action: 'place_block',
    phase: 'frame',
    position: { x: 0, y: 64, z: 0 },
    sourceBlockKey: 'source_0',
    blockName: 'oak_planks',
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_structural_clear_policy',
    blueprintId: 'structural_clear_policy',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'site_prepare',
    steps: {
      [clearStep.id]: {
        id: clearStep.id,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: 'clear_obstruction',
        lifecyclePhase: 'site_prepare',
        target: clearStep.position,
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING
      },
      [placeStep.id]: {
        id: placeStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: 'frame',
        lifecyclePhase: 'frame',
        target: placeStep.position,
        block: { id: 'oak_planks', states: {} },
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.VERIFIED
      }
    }
  })
  system.session = {
    steps: [clearStep, placeStep],
    currentStepIndex: 0,
    constructionRun: run,
    constructionRunId: run.runId,
    phaseGates: {},
    phaseGateSessionId: `${run.runId}:test`,
    status: 'RUNNING',
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.placeNextBlock(ctx, { owner: 'test', maxBlocksPerUpdate: 1 })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.result.reason, 'clear_target_already_matches_placement')
  assert.strictEqual(ctx.cleared.length, 0)
  const saved = store.getRun(run.runId)
  assert.strictEqual(saved.steps[clearStep.id].status, STEP_STATE.VERIFIED)
  assert.strictEqual(saved.steps[clearStep.id].skipReason, 'clear_target_already_matches_placement')
  assert.strictEqual(saved.steps[clearStep.id].replacementStepId, placeStep.id)
}

async function testTemporaryFinalBlockRemovalCreatesRestoreStep() {
  const store = createRunStore()
  const ctx = createContext([], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'oak_planks' }]
  })
  const system = createBuildingSystem({ constructionRunStore: store })
  const clearStep = {
    id: 'step_temp_final_clear',
    kind: 'clear',
    action: 'clear_block',
    phase: 'clear_obstruction',
    position: { x: 0, y: 64, z: 0 },
    sourceBlockKey: 'source_temp',
    dependencies: []
  }
  const placeStep = {
    id: 'step_temp_final_place',
    kind: 'place',
    action: 'place_block',
    phase: 'frame',
    position: { x: 0, y: 64, z: 0 },
    sourceBlockKey: 'source_temp',
    blockName: 'oak_planks',
    dependencies: []
  }
  const run = store.upsertRun({
    runId: 'run_temp_final_clear_policy',
    blueprintId: 'temp_final_clear_policy',
    blueprintHash: 'hash',
    planId: 'plan',
    placementContext: { origin: { x: 0, y: 64, z: 0 }, rotationY: 0, mirror: { x: false, z: false } },
    world: { dimension: 'overworld' },
    status: 'ACTIVE',
    terminalState: null,
    currentPhase: 'site_prepare',
    steps: {
      [clearStep.id]: {
        id: clearStep.id,
        action: 'clear_block',
        legacyKind: 'clear',
        phase: 'clear_obstruction',
        lifecyclePhase: 'site_prepare',
        target: clearStep.position,
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.PENDING
      },
      [placeStep.id]: {
        id: placeStep.id,
        action: 'place_block',
        legacyKind: 'place',
        phase: 'frame',
        lifecyclePhase: 'frame',
        target: placeStep.position,
        block: { id: 'oak_planks', states: {} },
        dependencies: [],
        retry: { count: 0, lastError: null },
        status: STEP_STATE.VERIFIED
      }
    }
  })
  system.session = {
    steps: [clearStep, placeStep],
    currentStepIndex: 0,
    constructionRun: run,
    constructionRunId: run.runId,
    phaseGates: {},
    phaseGateSessionId: `${run.runId}:test`,
    status: 'RUNNING',
    origin: { x: 0, y: 64, z: 0 },
    reservedPositions: new Set(),
    reservedBounds: null
  }

  const result = await system.placeNextBlock(ctx, {
    owner: 'test',
    maxBlocksPerUpdate: 1,
    allowTemporaryFinalBlockRemoval: true
  })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(ctx.cleared.length, 1)
  const saved = store.getRun(run.runId)
  const savedClear = saved.steps[clearStep.id]
  assert.strictEqual(savedClear.restoreRequired, true)
  assert.ok(savedClear.restoreStepId)
  assert.strictEqual(saved.steps[savedClear.restoreStepId].restoreStep, true)
  assert.strictEqual(saved.steps[savedClear.restoreStepId].status, STEP_STATE.PENDING)
  assert.strictEqual(saved.steps[savedClear.restoreStepId].block.id, 'oak_planks')
}

async function testBoundedSmokePlaceRejectsClearObstruction() {
  const store = createRunStore()
  const dir = createBlueprintDir([{
    name: 'bounded_smoke_rejects_clear',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, type: 'dirt' }]
  }])
  const ctx = createContext([{ name: 'dirt', count: 2 }], {
    occupied: [{ x: 0, y: 64, z: 0, name: 'grass_block' }]
  })
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'bounded_smoke_rejects_clear')
  const before = JSON.stringify(store.getRun(system.session.constructionRunId).steps)

  const result = await system.placeNextBlock(ctx, {
    owner: 'test',
    maxBlocksPerUpdate: 1,
    expectedAction: 'place'
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'BOUNDED_ACTION_NOT_ALLOWED')
  assert.strictEqual(ctx.cleared.length, 0)
  assert.strictEqual(JSON.stringify(store.getRun(system.session.constructionRunId).steps), before)
}

async function testBoundedSmokeOnlyAllowsSpecifiedStepWithoutNewRun() {
  const store = createRunStore()
  const dir = createBlueprintDir([plankLineBlueprint('bounded_step_only', 2)])
  const ctx = createContext([{ name: 'oak_planks', count: 4 }])
  const system = createBuildingSystem({ blueprintDir: dir, constructionRunStore: store })
  await startSystem(system, ctx, 'bounded_step_only')

  const runId = system.session.constructionRunId
  const beforeRuns = store.listRuns().map(run => run.runId)
  const beforeSteps = JSON.stringify(store.getRun(runId).steps)
  const nextStepId = system.session.orderPlan.steps[0].id
  assert.notStrictEqual(nextStepId, 'step_not_allowed')

  const result = await system.placeNextBlock(ctx, {
    owner: 'test',
    maxBlocksPerUpdate: 1,
    allowedStepIds: ['step_not_allowed'],
    expectedAction: 'place',
    expectedTarget: { x: 0, y: 64, z: 0 },
    expectedOriginalBlock: 'oak_planks',
    expectedResolvedBlock: 'oak_planks'
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'BOUNDED_STEP_MISMATCH')
  assert.strictEqual(ctx.placed.length, 0)
  assert.deepStrictEqual(store.listRuns().map(run => run.runId), beforeRuns)
  assert.strictEqual(system.session.constructionRunId, runId)
  assert.strictEqual(JSON.stringify(store.getRun(runId).steps), beforeSteps)
}

function testFaithfulWorldSnapshotScansImplicitAirAndLimitsCleanupToHighTemporaryBlocks() {
  const ctx = createContext([], {
    occupied: [
      { x: 0, y: 64, z: 0, name: 'oak_planks' },
      { x: 2, y: 68, z: 1, name: 'spruce_planks' },
      { x: 1, y: 65, z: 0, name: 'dirt' },
      { x: 1, y: 66, z: 0, name: 'dark_oak_planks' }
    ]
  })
  const session = {
    blueprintName: 'implicit_air_extra_fixture',
    origin: { x: 0, y: 64, z: 0 },
    worldBlocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks', position: { x: 0, y: 64, z: 0 } },
      { x: 2, y: 4, z: 1, type: 'spruce_planks', position: { x: 2, y: 68, z: 1 } }
    ],
    orderPlan: { steps: [] },
    blueprint: { metadata: {} }
  }

  const snapshot = buildingSystemTest.actualWorldBlueprintFromSession(ctx, session)
  const implicitExtras = snapshot.blocks.filter(block => block.role === 'unexpected_world_block')
  assert.deepStrictEqual(
    implicitExtras.map(block => `${block.x},${block.y},${block.z}:${block.type}`).sort(),
    ['1,1,0:dirt', '1,2,0:dark_oak_planks']
  )

  const cleanupCandidates = buildingSystemTest.unexpectedTemporaryBuildVolumeBlocks(ctx, session)
  assert.deepStrictEqual(
    cleanupCandidates.map(candidate => `${candidate.position.x},${candidate.position.y},${candidate.position.z}:${candidate.blockName}`),
    ['1,66,0:dark_oak_planks']
  )

  let comparedActual = null
  const acceptedCleanup = buildingSystemTest.acceptedFaithfulCleanupResult(ctx, session, {
    faithfulValidator: {
      compareExpectedActual(expected, actual) {
        comparedActual = actual
        return { ok: true, metrics: { extraBlockCount: 2 } }
      }
    }
  }, {
    removed: [{ position: { x: 2, y: 68, z: 1 }, blockName: 'dirt' }],
    remaining: cleanupCandidates,
    passes: 1
  })
  assert.strictEqual(acceptedCleanup.ok, true)
  assert.strictEqual(acceptedCleanup.toleratedRemaining, true)
  assert.strictEqual(acceptedCleanup.remaining.length, 1)
  assert.deepStrictEqual(
    comparedActual.blocks
      .filter(block => block.role === 'unexpected_world_block')
      .map(block => `${block.x},${block.y},${block.z}:${block.type}`)
      .sort(),
    ['1,1,0:dirt', '1,2,0:dark_oak_planks']
  )
}

function testFinalValidationAndCompletionWaitForEveryLedgerStep() {
  const steps = [
    { id: 'repair', kind: 'place', phase: 'frame', position: { x: 0, y: 64, z: 0 }, blockName: 'oak_planks' },
    { id: 'faithful', kind: 'walkability_validate', phase: 'walkability_final_check' },
    { id: 'validate', kind: 'validate', phase: 'validate' }
  ]
  const constructionRun = {
    steps: {
      repair: { id: 'repair', status: STEP_STATE.STATE_REPAIR, phase: 'frame' },
      faithful: { id: 'faithful', status: STEP_STATE.RETRYABLE_FAILED, phase: 'walkability_final_check' },
      validate: { id: 'validate', status: STEP_STATE.PENDING, phase: 'validate' }
    }
  }
  const session = { steps, constructionRun }

  assert.strictEqual(buildingSystemTest.nextExecutableStepIndex(session), 0)
  let gate = buildingSystemTest.constructionCompletionLedgerGate(session)
  assert.strictEqual(gate.ok, false)
  assert.strictEqual(gate.unresolvedCount, 3)
  assert.deepStrictEqual(gate.counts, {
    state_repair: 1,
    retryable_failed: 1,
    pending: 1
  })

  constructionRun.steps.repair.status = STEP_STATE.VERIFIED
  assert.strictEqual(buildingSystemTest.nextExecutableStepIndex(session), 1)
  constructionRun.steps.faithful.status = STEP_STATE.VERIFIED
  assert.strictEqual(buildingSystemTest.nextExecutableStepIndex(session), 2)
  constructionRun.steps.validate.status = STEP_STATE.VERIFIED
  gate = buildingSystemTest.constructionCompletionLedgerGate(session)
  assert.strictEqual(gate.ok, true)
  assert.strictEqual(gate.unresolvedCount, 0)
}

async function run() {
  testSaveFallsBackToCopyWhenAtomicRenameIsTemporarilyLocked()
  await testPartialRunResumeDoesNotReplayVerifiedBlocks()
  await testImplicitOriginUsesActiveRunPlacement()
  await testLegacyRunWorldIdentityUpgradesThenGuardsResume()
  await testPlacedButUnverifiedStepRecoversFromWorldScan()
  await testExecutingStepWithoutWorldChangeReconcilesToPending()
  await testVerifiedCheckpointMissingBlockBecomesPending()
  await testVerifiedCheckpointWrongBlockBecomesRepair()
  await testWrongOrientationEntersStateRepair()
  await testFunctionalContentsDoNotEnterStateRepair()
  await testLecternFacingStillEntersStateRepair()
  await testLeafDistanceDoesNotEnterStateRepair()
  await testFenceConnectionsDoNotEnterStateRepair()
  await testLadderIgnoresSanitizedScaffoldingStates()
  await testStagingInventoryRestoresAndBlocksShortage()
  await testRunPersistsDesignSpecLifecycleAndArchive()
  await testResidentialAndNonResidentialBuildsUseFullLifecycle()
  await testRealStagingChestCoordinatesPersistAcrossResume()
  await testPhysicalStagingChestDeploysOutsideBounds()
  await testPhysicalStagingChestIsNotDuplicatedOnResume()
  await testRequiredPhysicalStagingChestBlocksWhenUnavailable()
  await testBlockedStagingChestRunResumesWhenChestBecomesAvailable()
  await testCompletedRunCleansEmptyTemporaryStagingChest()
  await testPhaseGateReadsRealStagingChestBeforePlacement()
  await testCachedPhaseGateStillRechecksRealStagingChestBeforePlacement()
  await testSameSessionPhaseGateDoesNotReopenChestEveryStep()
  await testStartupStorageReconcileSeedsCurrentPhaseGate()
  await testPhaseGateRefillsStagingChestBeforePlacement()
  await testPhaseGateContinuesWhenFailedRefillLeavesRequiredItemInInventory()
  await testPhaseGateDefersSamePhaseShortageToInventoryBatch()
  await testConstructionRunPrepareRefillsStagingBeforeBlocking()
  await testPrepareUsesPartialRefillInventoryWhenStillBlocked()
  await testPrepareDefersFuturePhaseMaterialShortage()
  await testPrepareDoesNotTreatLiveInventoryAsStagingInventory()
  await testResumeChoosesEarliestUnresolvedPhaseBeforePlanOrder()
  await testResumeDefersValidationUntilCleanupCompletes()
  testNormalizeConstructionPhaseDoesNotTreatAndesiteAsSitePrepare()
  await testResumePrioritizesClearBeforeAndesiteFrameStep()
  await testSurfaceDecorationDependsOnSupportStepPhase()
  await testResumeMergesStoredSupportDependencies()
  await testResumePersistsHealedHangingLanternDependencyDirection()
  await testBlueprintRevisionChangeDoesNotResumeWrongRun()
  await testExistingStructureWithoutActiveRunBlocksFreshBuild()
  await testForceRebuildDoesNotOverwriteExistingStructureWithoutExplicitOverwrite()
  await testNaturalTerrainSiteAutoFresh()
  await testPartialBuildForcesReconciliationEvenWithOverwriteFlag()
  await testMixedNaturalPlusOneMatchingBlockForcesReconciliation()
  await testUnknownArtificialBlocksRequireManualDecision()
  await testNaturalTreeLogsTakeManualDecisionBranch()
  await testRenovationOfCompletedRunCreatesLineageRunWithDemolition()
  await testRenovationRejectsInvalidLineageTargets()
  await testOrdinaryRunsCarryNoRenovationFields()
  await testRescueExistingBuildIsReadOnly()
  await testSameRunConvergesAcrossTwoRestartsAndCompletes()
  await testFailedWithoutTerminalStateRemainsResumable()
  await testCompletedRunIsNotActive()
  await testActiveRunTerrainMaterialResolutionPreservesVerifiedSteps()
  await testRunScopedLeafMaterialOverrideUnblocksStagedResume()
  await testRunScopedStateOverrideUpdatesExecutionAndWorldDiffTarget()
  await testStagedTerrainMaterialResolutionReconcilesSatisfiedFallback()
  await testResolvedDirtIgnoresGrassSnowyStateAcrossResume()
  await testTemporaryReferenceItemFailureRemainsRetryable()
  await testUnresolvedTerrainMaterialShortageBlocksResumeBeforePlacement()
  await testTerrainObstructionClearRecordsNoRestore()
  await testWrongBlockClearRequiresFollowupPlace()
  await testPrepareReconcilesRuntimeMaterialBeforeStoredClear()
  await testExactClearDefersToPlacementRepair()
  await testResolvedExactClearYieldsToStateRepairPlacement()
  await testResumeDoesNotPersistNewTransientScaffoldSteps()
    await testOptionalScaffoldSkipPersistsAcrossPrepare()
    testVerifiedScaffoldCleanupWithRemainingBlockReconcilesToCleanup()
    testVerifiedScaffoldCleanupPreventsPlacementRebuildOnResume()
  await testScaffoldCleanupClearIsAllowed()
  await testVerifiedStructuralFinalBlockClearIsSkippedWhenAlreadySatisfied()
  await testTemporaryFinalBlockRemovalCreatesRestoreStep()
  await testBoundedSmokePlaceRejectsClearObstruction()
  await testBoundedSmokeOnlyAllowsSpecifiedStepWithoutNewRun()
  testFaithfulWorldSnapshotScansImplicitAirAndLimitsCleanupToHighTemporaryBlocks()
  testFinalValidationAndCompletionWaitForEveryLedgerStep()
  console.log('construction run store tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
