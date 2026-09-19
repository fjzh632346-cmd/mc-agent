const { Vec3 } = require('vec3')
const { blockedRecord, environmentFields } = require('./minecraft-case-utils')
const { DEFAULT_FARM_SCAN_RADIUS } = require('../../systems/farming-system')

const FEATURE = 'farming'
const FARMING_TIMEOUT_MS = 55000
const SEED_ITEMS = ['wheat_seeds']
const FARMING_TOOL_ITEMS = [
  'wooden_hoe',
  'stone_hoe',
  'iron_hoe',
  'diamond_hoe',
  'netherite_hoe',
  'golden_hoe'
]

const SCENARIOS = [
  {
    id: 'harvest-multiple-mature-wheat',
    testName: 'farming harvests multiple mature wheat without seeds or hoe',
    command: '\u5e2e\u6211\u6536\u4e00\u4e0b\u6210\u719f\u7684\u5c0f\u9ea6',
    mode: 'HARVEST_FARM',
    matureCount: 3,
    seedCount: 0,
    clearSeeds: true,
    clearHoes: true,
    expectedBehavior: 'When several mature wheat crops are available, LinXia should harvest the batch instead of completing after one crop. Harvesting should not require wheat_seeds or a hoe.',
    regressionRisk: 'Farming can regress into single-crop success or wrongly require farming tools for harvesting.',
    assert: assertMultipleHarvest
  },
  {
    id: 'harvest-and-replant-with-seeds',
    testName: 'farming harvests mature wheat then replants with available seeds',
    command: '\u6536\u5b8c\u4e4b\u540e\u8865\u79cd',
    mode: 'FARM_CYCLE',
    matureCount: 3,
    seedCount: 8,
    clearSeeds: true,
    clearHoes: true,
    expectedBehavior: 'When mature wheat and enough wheat_seeds are available, LinXia should harvest first and then replant real seedlings at harvested farmland.',
    regressionRisk: 'Farming can report task completion without actual PLANT_SUCCESS or crop state changes.',
    assert: assertHarvestThenReplant
  },
  {
    id: 'missing-seeds-clear-failure',
    testName: 'farming reports missing seeds instead of false success',
    command: '\u6536\u5b8c\u4e4b\u540e\u8865\u79cd',
    mode: 'FARM_CYCLE',
    matureCount: 2,
    seedCount: 0,
    clearSeeds: true,
    clearHoes: true,
    expectedBehavior: 'When harvest-and-replant needs seeds but LinXia has none and storage cannot provide them, the task should not report farming success and should expose missing_seeds, storage_unavailable, or another explicit seed/storage reason.',
    regressionRisk: 'Missing seed paths can falsely pass after harvest or silently claim storage helped when it did not.',
    assert: assertMissingSeedsFailure
  },
  {
    id: 'insufficient-mature-wheat-count',
    testName: 'farming reports partial when requested mature wheat is insufficient',
    command: '\u5e2e\u6211\u6536\u4e00\u4e0b\u6210\u719f\u7684\u5c0f\u9ea63\u4e2a',
    mode: 'HARVEST_FARM',
    matureCount: 1,
    requestedCount: 3,
    seedCount: 0,
    clearSeeds: true,
    clearHoes: true,
    expectedBehavior: 'When the player asks for more mature wheat than exists nearby, LinXia should report partial_harvest_insufficient_mature_wheat instead of calling the task a success.',
    regressionRisk: 'Requested-count farming can hide partial completion and pollute acceptance with false PASS results.',
    assert: assertInsufficientMatureWheat
  }
]

module.exports = {
  featureName: FEATURE,
  testName: 'farming real Minecraft auto item preparation suite',
  commandOrInput: 'farming real Minecraft auto item preparation suite',

  async run({ adapter, projectConfig, createRecord }) {
    const config = projectConfig.minecraft.farming || {}
    const records = []

    for (const scenario of SCENARIOS) {
      console.log(`[farming-acceptance] start scenario=${scenario.id}`)
      const cursor = adapter.createLogCursor()
      await adapter.sendCommand('\u505c\u6b62\u4efb\u52a1', { afterMs: 900 })
      const setup = await prepareScenario(adapter, config, scenario, cursor)
      if (setup.setupStatus !== 'READY') {
        records.push(createRecord(blockedRecord({
          adapter,
          featureName: FEATURE,
          testName: scenario.testName,
          commandOrInput: scenario.command,
          setup,
          expectedBehavior: scenario.expectedBehavior,
          regressionRisk: scenario.regressionRisk,
          nextSuggestion: 'Ensure LinXia is online, command fixtures are allowed, and the farm fixture can be created near the bot.'
        })))
        console.log(`[farming-acceptance] blocked scenario=${scenario.id} reason=${setup.setupFailureReason}`)
        continue
      }

      records.push(createRecord(await runScenario({ adapter, config, setup, scenario })))
      await cleanupScenario(adapter, setup).catch(() => {})
      console.log(`[farming-acceptance] done scenario=${scenario.id}`)
    }

    return records
  }
}

async function prepareScenario(adapter, config, scenario, cursor) {
  const alignment = await adapter.runServerCommand(`tp ${adapter.aiUsername()} ${adapter.testUsername()}`)
  await adapter.wait(800)
  const scanRadius = config.scanRadius || 16
  const taskScanRadius = farmingTaskScanRadius(config)
  const baseSnapshot = await adapter.snapshot({
    logCursor: cursor,
    scanRadius,
    companionScanRadius: taskScanRadius,
    includeDebugStatus: true
  })

  const fixtureStatus = {
    feature: FEATURE,
    scenarioId: scenario.id,
    ready: false,
    reason: 'fixture_pending',
    alignment,
    commands: [],
    beforeInventory: inventorySummary(baseSnapshot),
    taskScanRadius
  }

  if (alignment.commandDenied) return blockedSetup('alignment_command_denied', baseSnapshot, fixtureStatus)
  if (!baseSnapshot.configuredAiOnline || !baseSnapshot.debugStatusAvailable) {
    return blockedSetup(!baseSnapshot.configuredAiOnline ? 'configured_ai_not_online' : 'debug_status_unavailable', baseSnapshot, fixtureStatus)
  }

  const fixture = farmFixtureFor(baseSnapshot, scenario)
  const commands = buildFixtureCommands(adapter, fixture, scenario)
  const commandResult = await runFixtureCommands(adapter, commands)
  fixtureStatus.commands = commandResult.commands
  fixtureStatus.commandDenied = commandResult.commandDenied
  fixtureStatus.deniedMessage = commandResult.deniedMessage
  fixtureStatus.fixture = fixture

  if (commandResult.commandDenied) {
    return blockedSetup('command_denied', baseSnapshot, { ...fixtureStatus, reason: 'command_denied' })
  }

  await adapter.wait(1400)
  let after = await adapter.snapshot({
    logCursor: cursor,
    scanRadius,
    companionScanRadius: taskScanRadius,
    includeDebugStatus: true
  })
  let verification = verifyFixture(adapter, scenario, fixture, after)
  let retryResult = null

  if (!verification.ready && isRetryableFixtureReason(verification.reason)) {
    retryResult = await runFixtureCommands(adapter, buildPlotFixtureCommands(fixture, scenario))
    await adapter.wait(1400)
    after = await adapter.snapshot({
      logCursor: cursor,
      scanRadius,
      companionScanRadius: taskScanRadius,
      includeDebugStatus: true
    })
    verification = verifyFixture(adapter, scenario, fixture, after)
  }

  return {
    setupStatus: verification.ready ? 'READY' : 'BLOCKED',
    setupFailureReason: verification.ready ? null : verification.reason,
    snapshot: after,
    fixtureStatus: {
      ...fixtureStatus,
      ready: verification.ready,
      reason: verification.reason,
      afterInventory: inventorySummary(after),
      verification,
      retryCommands: retryResult,
      fixtureOnlyPreparedEnvironment: true,
      linxiaBehaviorStillRequiredForPass: true
    }
  }
}

async function runScenario({ adapter, config, setup, scenario }) {
  const commandCursor = adapter.createLogCursor()
  const scanRadius = config.scanRadius || 16
  const taskScanRadius = farmingTaskScanRadius(config)
  const preState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius,
    companionScanRadius: taskScanRadius,
    includeDebugStatus: true
  })
  const beforeInventory = inventorySummary(preState)
  const cropsBefore = fixtureCrops(adapter, setup.fixtureStatus.fixture)

  await adapter.sendCommand(scenario.command, { afterMs: 250 })
  const terminalLogs = await waitForScenarioTerminal(adapter, scenario, commandCursor, config)
  await adapter.wait(scenario.id === 'missing-seeds-clear-failure' ? 2000 : 1800)

  const postState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius,
    companionScanRadius: taskScanRadius,
    includeDebugStatus: true
  })
  const afterInventory = inventorySummary(postState)
  const cropsAfter = fixtureCrops(adapter, setup.fixtureStatus.fixture)
  const logs = adapter.readLogsSince(commandCursor)
  const assertion = scenario.assert({
    scenario,
    logs,
    terminalLogs,
    preState,
    postState,
    beforeInventory,
    afterInventory,
    cropsBefore,
    cropsAfter
  })

  return {
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState,
    postState,
    observedBehavior: assertion.judgment === 'PASS' ? assertion.passReason : 'farming_real_game_acceptance_failed',
    expectedBehavior: scenario.expectedBehavior,
    actualResult: assertion.judgment === 'PASS' ? assertion.passReason : 'farming_real_game_acceptance_failed',
    judgment: assertion.judgment,
    passOrFail: assertion.judgment,
    failureReason: assertion.failureReason,
    evidence: {
      scenarioId: scenario.id,
      requestedMode: scenario.mode,
      requestedCount: scenario.requestedCount || null,
      beforeInventory,
      afterInventory,
      itemDeltas: itemDeltas(beforeInventory, afterInventory, ['wheat', 'wheat_seeds', ...FARMING_TOOL_ITEMS]),
      cropsBefore,
      cropsAfter,
      farmingSignals: farmingSignals(logs),
      autoPrepSignals: autoPrepSignals(logs),
      assertion,
      setup: setup.fixtureStatus || {},
      taskSignals: postState.taskSignals,
      terminal: terminalFromLogs(logs)
    },
    relatedLogs: logs.slice(-180),
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: assertion.judgment === 'PASS'
      ? 'Keep this farming real-game acceptance slice as the guard for harvest/replant auto-preparation.'
      : 'Inspect command routing, FarmingTask preparation, crop scan radius, ActionLock state, and FARMING_TASK terminal logs.',
    ...environmentFields(adapter, postState, setup)
  }
}

function buildFixtureCommands(adapter, fixture, scenario) {
  const ai = adapter.aiUsername()
  const commands = [
    `execute at ${ai} run kill @e[type=minecraft:item,distance=..48]`,
    `execute at ${ai} run kill @e[type=minecraft:zombie,distance=..48]`,
    `execute at ${ai} run kill @e[type=minecraft:skeleton,distance=..48]`,
    `execute at ${ai} run kill @e[type=minecraft:creeper,distance=..48]`,
    `execute at ${ai} run kill @e[type=minecraft:spider,distance=..48]`,
    `fill ${fixture.clearMin.x} ${fixture.clearMin.y} ${fixture.clearMin.z} ${fixture.clearMax.x} ${fixture.clearMax.y} ${fixture.clearMax.z} minecraft:air replace minecraft:wheat`,
    `fill ${fixture.clearMin.x} ${fixture.clearMin.y - 1} ${fixture.clearMin.z} ${fixture.clearMax.x} ${fixture.clearMax.y - 1} ${fixture.clearMax.z} minecraft:dirt replace minecraft:farmland`,
    `setblock ${fixture.water.x} ${fixture.water.y} ${fixture.water.z} minecraft:water`,
    `clear ${ai} minecraft:wheat`,
    `clear ${ai} minecraft:wheat_seeds`,
    `clear ${ai} minecraft:glowstone_dust`
  ]

  if (scenario.clearHoes) {
    for (const item of FARMING_TOOL_ITEMS) commands.push(`clear ${ai} minecraft:${item}`)
  }

  commands.push(...buildPlotFixtureCommands(fixture, scenario))

  if (scenario.seedCount > 0) commands.push(`give ${ai} minecraft:wheat_seeds ${scenario.seedCount}`)
  return commands
}

function buildPlotFixtureCommands(fixture, scenario) {
  const commands = []
  commands.push(`setblock ${fixture.water.x} ${fixture.water.y} ${fixture.water.z} minecraft:water`)
  for (const light of fixture.lights || []) {
    commands.push(`setblock ${light.x} ${light.y} ${light.z} minecraft:light[level=15]`)
  }
  for (const plot of fixture.plots) {
    commands.push(`setblock ${plot.ground.x} ${plot.ground.y} ${plot.ground.z} minecraft:farmland`)
    commands.push(`setblock ${plot.crop.x} ${plot.crop.y} ${plot.crop.z} ${plot.mature ? 'minecraft:wheat[age=7]' : 'minecraft:air'}`)
  }
  return commands
}

function isRetryableFixtureReason(reason) {
  return reason === 'farmland_fixture_missing' ||
    /^mature_wheat_fixture_missing:/.test(String(reason || ''))
}

function verifyFixture(adapter, scenario, fixture, snapshot) {
  const inventory = inventorySummary(snapshot)
  if (!snapshot.configuredAiOnline) return { ready: false, reason: 'configured_ai_not_online' }
  if (!snapshot.debugStatusAvailable) return { ready: false, reason: 'debug_status_unavailable' }

  const crops = fixtureCrops(adapter, fixture)
  const mature = crops.filter(crop => crop.blockName === 'wheat' && crop.age === 7)
  const farmland = crops.filter(crop => crop.groundName === 'farmland')
  if (mature.length < scenario.matureCount) return { ready: false, reason: `mature_wheat_fixture_missing:${mature.length}/${scenario.matureCount}`, crops }
  if (farmland.length < fixture.plots.length) return { ready: false, reason: 'farmland_fixture_missing', crops }

  const seedCount = itemCount(inventory, 'wheat_seeds')
  if (scenario.seedCount > 0 && seedCount < scenario.seedCount) return { ready: false, reason: `inventory_give_failed:wheat_seeds:${seedCount}/${scenario.seedCount}`, crops, seedCount }
  if (scenario.clearSeeds && scenario.seedCount === 0 && seedCount > 0) return { ready: false, reason: `inventory_clear_failed:wheat_seeds:${seedCount}`, crops, seedCount }

  for (const hoe of FARMING_TOOL_ITEMS) {
    const count = itemCount(inventory, hoe)
    if (scenario.clearHoes && count > 0) return { ready: false, reason: `inventory_clear_failed:${hoe}:${count}`, crops, seedCount }
  }

  return {
    ready: true,
    reason: 'fixture_ready',
    crops,
    seedCount,
    hoeCounts: Object.fromEntries(FARMING_TOOL_ITEMS.map(item => [item, itemCount(inventory, item)]))
  }
}

function assertMultipleHarvest(ctx) {
  const common = commonSignals(ctx)
  const harvested = common.harvestSuccesses
  const summaryHarvested = common.harvestSummary?.harvested || 0
  const matureAfter = matureFixtureCount(ctx.cropsAfter)
  const noSeeds = itemCount(ctx.beforeInventory, 'wheat_seeds') === 0
  const noHoe = FARMING_TOOL_ITEMS.every(item => itemCount(ctx.beforeInventory, item) === 0)
  const noSeedFailure = !hasAnyLog(ctx.logs, ['missing_seeds', 'partial_replant_insufficient_seeds'])
  const pass = common.intentOk &&
    common.modeOk &&
    common.taskStarted &&
    common.taskSucceeded &&
    harvested >= ctx.scenario.matureCount &&
    summaryHarvested >= ctx.scenario.matureCount &&
    matureAfter === 0 &&
    noSeeds &&
    noHoe &&
    noSeedFailure

  return result(pass, 'harvested_multiple_mature_wheat_without_seed_or_hoe', {
    common,
    noSeeds,
    noHoe,
    matureAfter,
    noSeedFailure
  })
}

function assertHarvestThenReplant(ctx) {
  const common = commonSignals(ctx)
  const harvested = common.harvestSuccesses
  const planted = common.plantSuccesses
  const seedlings = seedlingFixtureCount(ctx.cropsAfter)
  const harvestBeforePlant = firstIndex(ctx.logs, '[CROP_HARVEST_SUCCESS]') >= 0 &&
    firstIndex(ctx.logs, '[PLANT_SUCCESS]') > firstIndex(ctx.logs, '[CROP_HARVEST_SUCCESS]')
  const noHoe = FARMING_TOOL_ITEMS.every(item => itemCount(ctx.beforeInventory, item) === 0)
  const pass = common.intentOk &&
    common.modeOk &&
    common.taskStarted &&
    common.taskSucceeded &&
    harvested >= ctx.scenario.matureCount &&
    planted >= ctx.scenario.matureCount &&
    seedlings >= ctx.scenario.matureCount &&
    harvestBeforePlant &&
    noHoe

  return result(pass, 'harvested_then_replanted_real_seedlings', {
    common,
    seedlings,
    harvestBeforePlant,
    noHoe
  })
}

function assertMissingSeedsFailure(ctx) {
  const common = commonSignals(ctx)
  const terminal = terminalFromLogs(ctx.logs)
  const explicitReason = [...ctx.logs].reverse().find(line =>
    line.includes('missing_seeds') ||
    line.includes('partial_replant_insufficient_seeds') ||
    line.includes('storage_unavailable') ||
    line.includes('chest_not_found') ||
    line.includes('insufficient_seeds')
  )
  const noFalseSuccess = !terminal.success && !ctx.logs.some(line => line.includes('[FARMING_TASK_SUCCESS]'))
  const noSeeds = itemCount(ctx.beforeInventory, 'wheat_seeds') === 0
  const storageFetched = ctx.logs.some(line => line.includes('result=storage_fetched'))
  const pass = common.intentOk &&
    common.modeOk &&
    common.taskStarted &&
    terminal.failure &&
    noFalseSuccess &&
    noSeeds &&
    Boolean(explicitReason) &&
    !storageFetched

  return result(pass, 'missing_seeds_reported_without_false_success', {
    common,
    terminal,
    explicitReason: explicitReason || null,
    noFalseSuccess,
    noSeeds,
    storageFetched
  })
}

function assertInsufficientMatureWheat(ctx) {
  const common = commonSignals(ctx)
  const terminal = terminalFromLogs(ctx.logs)
  const partialReason = ctx.logs.find(line => line.includes('partial_harvest_insufficient_mature_wheat'))
  const harvested = common.harvestSuccesses
  const pass = common.intentOk &&
    common.modeOk &&
    common.taskStarted &&
    terminal.failure &&
    Boolean(partialReason) &&
    harvested === ctx.scenario.matureCount &&
    harvested < ctx.scenario.requestedCount

  return result(pass, 'partial_harvest_insufficient_mature_wheat_reported', {
    common,
    terminal,
    partialReason: partialReason || null,
    harvested,
    requestedCount: ctx.scenario.requestedCount
  })
}

function commonSignals(ctx) {
  const terminal = terminalFromLogs(ctx.logs)
  const harvestSummary = harvestSummaryFromLogs(ctx.logs)
  return {
    intentOk: ctx.logs.some(line => line.includes('[INTENT_RESULT]') && line.includes(`actionKey=${ctx.scenario.mode === 'HARVEST_FARM' ? 'HARVEST_FARM' : 'FARM_CYCLE'}`)),
    modeOk: ctx.logs.some(line => line.includes(`mode=${ctx.scenario.mode}`)),
    taskStarted: ctx.logs.some(line => line.includes('[TASK_STARTED]') && line.includes('"type":"farming"')),
    taskSucceeded: terminal.success,
    taskFailed: terminal.failure,
    harvestSuccesses: ctx.logs.filter(line => line.includes('[CROP_HARVEST_SUCCESS]')).length,
    plantSuccesses: ctx.logs.filter(line => line.includes('[PLANT_SUCCESS]')).length,
    harvestSummary,
    terminal
  }
}

async function waitForScenarioTerminal(adapter, scenario, cursor, config) {
  return adapter.waitForLog([
    /\[FARMING_TASK_SUCCESS\]/,
    /\[FARMING_TASK_FAILED\]/,
    /\[TaskManager\] completed #\d+ farming/,
    /\[TaskManager\] failed #\d+ farming/,
    /\[task-manager\] complete task=farming\b/,
    /\[task-manager\] fail task=farming\b/
  ], scenario.timeoutMs || config.timeoutMs || FARMING_TIMEOUT_MS, cursor)
}

async function cleanupScenario(adapter, setup) {
  await adapter.sendCommand('\u505c\u6b62\u4efb\u52a1', { afterMs: 300 })
  const fixture = setup?.fixtureStatus?.fixture
  if (!fixture) return
  for (const plot of fixture.plots || []) {
    await adapter.runServerCommand(`setblock ${plot.crop.x} ${plot.crop.y} ${plot.crop.z} minecraft:air`)
  }
  for (const light of fixture.lights || []) {
    await adapter.runServerCommand(`setblock ${light.x} ${light.y} ${light.z} minecraft:air`)
  }
}

async function runFixtureCommands(adapter, commands) {
  const results = []
  for (const command of commands) {
    results.push(await adapter.runServerCommand(command))
  }
  const denied = results.find(result => result.commandDenied)
  return {
    attempted: commands.length > 0,
    commands: results,
    commandDenied: Boolean(denied),
    deniedMessage: denied?.deniedMessage || null
  }
}

function farmFixtureFor(snapshot = {}, scenario = {}) {
  const anchor = snapshot.companionPosition || snapshot.acceptancePlayerPosition || { x: 0, y: 64, z: 0 }
  const base = {
    x: Math.floor(Number(anchor.x)) + 4,
    groundY: Math.floor(Number(anchor.y)) - 1,
    cropY: Math.floor(Number(anchor.y)),
    z: Math.floor(Number(anchor.z)) + 4
  }
  const plots = []
  const plotCount = Math.max(Number(scenario.matureCount || 0), Number(scenario.requestedCount || 0), 3)
  for (let i = 0; i < plotCount; i++) {
    plots.push({
      ground: { x: base.x + i, y: base.groundY, z: base.z },
      crop: { x: base.x + i, y: base.cropY, z: base.z },
      mature: i < scenario.matureCount
    })
  }
  return {
    base,
    plots,
    water: { x: base.x - 1, y: base.groundY, z: base.z },
    lights: plots.map(plot => ({ x: plot.crop.x, y: plot.crop.y + 2, z: plot.crop.z })),
    clearMin: { x: base.x - 2, y: base.cropY - 1, z: base.z - 2 },
    clearMax: { x: base.x + plotCount + 2, y: base.cropY + 1, z: base.z + 2 }
  }
}

function fixtureCrops(adapter, fixture = {}) {
  return (fixture.plots || []).map(plot => {
    const cropBlock = blockAtPosition(adapter, plot.crop)
    const groundBlock = blockAtPosition(adapter, plot.ground)
    return {
      crop: plot.crop,
      ground: plot.ground,
      blockName: cropBlock.blockName,
      age: cropAge(cropBlock.block),
      mature: cropBlock.blockName === 'wheat' && cropAge(cropBlock.block) === 7,
      groundName: groundBlock.blockName
    }
  })
}

function blockAtPosition(adapter, position) {
  const block = adapter.bot?.blockAt?.(new Vec3(Number(position.x), Number(position.y), Number(position.z)))
  return {
    ok: Boolean(block),
    position,
    block,
    blockName: block?.name || null
  }
}

function cropAge(block) {
  if (!block) return null
  const properties = typeof block.getProperties === 'function' ? block.getProperties() : block._properties || {}
  const age = properties?.age ?? block.metadata
  const number = Number(age)
  return Number.isFinite(number) ? number : null
}

function terminalFromLogs(logs) {
  const line = [...logs].reverse().find(line =>
    /\[FARMING_TASK_SUCCESS\]/.test(line) ||
    /\[FARMING_TASK_FAILED\]/.test(line) ||
    /\[TaskManager\] completed #\d+ farming/.test(line) ||
    /\[TaskManager\] failed #\d+ farming/.test(line) ||
    /\[task-manager\] complete task=farming\b/.test(line) ||
    /\[task-manager\] fail task=farming\b/.test(line)
  )

  return {
    observed: Boolean(line),
    success: Boolean(line && (
      /\[FARMING_TASK_SUCCESS\]/.test(line) ||
      /\[TaskManager\] completed #\d+ farming/.test(line) ||
      /\[task-manager\] complete task=farming\b/.test(line)
    )),
    failure: Boolean(line && (
      /\[FARMING_TASK_FAILED\]/.test(line) ||
      /\[TaskManager\] failed #\d+ farming/.test(line) ||
      /\[task-manager\] fail task=farming\b/.test(line)
    )),
    line: line || null
  }
}

function harvestSummaryFromLogs(logs) {
  const line = [...logs].reverse().find(line => line.includes('[CROP_HARVEST_SUMMARY]'))
  if (!line) return null
  const match = line.match(/harvested=(\d+).*skippedImmature=(\d+)/)
  return {
    line,
    harvested: match ? Number(match[1]) : null,
    skippedImmature: match ? Number(match[2]) : null
  }
}

function farmingSignals(logs) {
  return {
    harvestAttempts: logs.filter(line => line.includes('[CROP_HARVEST_ATTEMPT]')).length,
    harvestSuccesses: logs.filter(line => line.includes('[CROP_HARVEST_SUCCESS]')).length,
    plantAttempts: logs.filter(line => line.includes('[PLANT_ATTEMPT]')).length,
    plantSuccesses: logs.filter(line => line.includes('[PLANT_SUCCESS]')).length,
    harvestSummary: harvestSummaryFromLogs(logs),
    plantSummary: [...logs].reverse().find(line => line.includes('[PLANT_SUMMARY]')) || null,
    terminal: terminalFromLogs(logs)
  }
}

function autoPrepSignals(logs) {
  return logs
    .filter(line => line.includes('[auto-prep]') && line.includes('target=farmingItem'))
    .map(line => line.replace(/^.*\[auto-prep\]/, '[auto-prep]'))
}

function matureFixtureCount(crops = []) {
  return crops.filter(crop => crop.blockName === 'wheat' && crop.age === 7).length
}

function seedlingFixtureCount(crops = []) {
  return crops.filter(crop => crop.blockName === 'wheat' && crop.age === 0).length
}

function inventorySummary(snapshot = {}) {
  return snapshot.debugStatus?.status?.inventorySummary || null
}

function itemCount(inventory, itemName) {
  if (!inventory) return 0
  return inventory.counts?.[itemName] || 0
}

function itemDeltas(before, after, items) {
  return Object.fromEntries(items.map(item => [item, {
    before: itemCount(before, item),
    after: itemCount(after, item),
    delta: itemCount(after, item) - itemCount(before, item)
  }]))
}

function firstIndex(logs, needle) {
  return logs.findIndex(line => line.includes(needle))
}

function hasAnyLog(logs, terms) {
  return logs.some(line => terms.some(term => line.includes(term)))
}

function result(pass, passReason, evidence) {
  return {
    judgment: pass ? 'PASS' : 'FAIL',
    passReason: pass ? passReason : null,
    failureReason: pass ? null : failureReason(evidence),
    ...evidence
  }
}

function failureReason(evidence = {}) {
  const terminal = evidence.terminal || evidence.common?.terminal
  if (terminal && !terminal.observed) return 'farming_task_did_not_reach_terminal_state'
  if (terminal?.line) return `farming_acceptance_assertion_failed terminal=${terminal.line}`
  return 'farming_acceptance_assertion_failed'
}

function blockedSetup(reason, snapshot, fixtureStatus) {
  return {
    setupStatus: 'BLOCKED',
    setupFailureReason: reason,
    snapshot,
    fixtureStatus: { ...fixtureStatus, ready: false, reason }
  }
}

function farmingTaskScanRadius(config = {}) {
  const radius = Number(config.taskScanRadius)
  return Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_FARM_SCAN_RADIUS
}
