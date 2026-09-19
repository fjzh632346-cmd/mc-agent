const { Vec3 } = require('vec3')
const { blockedRecord, environmentFields } = require('./minecraft-case-utils')

const FEATURE = 'mining'

const TOOL_AND_MATERIAL_ITEMS = [
  'wooden_pickaxe',
  'stone_pickaxe',
  'iron_pickaxe',
  'diamond_pickaxe',
  'netherite_pickaxe',
  'wooden_axe',
  'stone_axe',
  'iron_axe',
  'diamond_axe',
  'netherite_axe',
  'stick',
  'oak_planks',
  'oak_log',
  'cobblestone'
]

const WOODCUTTING_CLEAR_ITEMS = TOOL_AND_MATERIAL_ITEMS.filter(item => item !== 'oak_log')

const MINING_CLEAR_ITEMS = [
  ...TOOL_AND_MATERIAL_ITEMS,
  'raw_iron',
  'iron_ore',
  'diamond'
]

const WOOD_BLOCKS_TO_CLEAR = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'oak_wood',
  'spruce_wood',
  'birch_wood',
  'jungle_wood',
  'acacia_wood',
  'dark_oak_wood',
  'mangrove_wood',
  'cherry_wood'
]

const SCENARIOS = [
  {
    id: 'auto-wooden-pickaxe-stone',
    testName: 'mining auto-prepares wooden pickaxe for stone',
    command: '挖石头',
    targetBlock: 'stone',
    expectedTool: 'wooden_pickaxe',
    setup: {
      clear: TOOL_AND_MATERIAL_ITEMS,
      give: [{ item: 'oak_planks', count: 5 }],
      placeCraftingTable: true
    },
    timeoutMs: 70000,
    expectedBehavior: 'When mining stone with no pickaxe, LinXia should craft sticks and a wooden_pickaxe from inventory planks, equip it, mine one stone-like block, and not trigger farming.',
    regressionRisk: 'Mining can regress by reporting missing tools even though the verified crafting chain can make a wooden pickaxe.',
    assert: assertAutoToolSuccess
  },
  {
    id: 'auto-stone-pickaxe-iron-ore',
    testName: 'mining auto-prepares stone pickaxe for iron ore',
    command: '挖一个铁矿',
    targetBlock: 'iron_ore',
    expectedTool: 'stone_pickaxe',
    setup: {
      clear: TOOL_AND_MATERIAL_ITEMS,
      give: [
        { item: 'cobblestone', count: 3 },
        { item: 'oak_planks', count: 2 }
      ],
      placeCraftingTable: true
    },
    timeoutMs: 80000,
    expectedBehavior: 'When mining iron ore with no pickaxe, LinXia should craft sticks and a stone_pickaxe, equip it, mine one iron_ore block, and not use a wooden pickaxe.',
    regressionRisk: 'Iron ore requires stone_pickaxe_or_better; auto-preparation must not make or use a wooden pickaxe for this target.',
    assert: assertAutoToolSuccess
  },
  {
    id: 'mining-count-three-iron-ore',
    testName: 'mining mines exactly three iron ore blocks',
    command: '挖3个铁矿',
    targetBlock: 'iron_ore',
    expectedTool: 'stone_pickaxe',
    setup: {
      clear: MINING_CLEAR_ITEMS,
      clearNearbyTargets: ['iron_ore', 'deepslate_iron_ore'],
      give: [{ item: 'stone_pickaxe', count: 1 }],
      targetBlocks: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 1, dy: 0, dz: 0 },
        { dx: 0, dy: 0, dz: 1 }
      ]
    },
    timeoutMs: 90000,
    expectedBehavior: 'When asked to mine three iron ore blocks, LinXia should route a count=3 mining task, use a stone pickaxe or better, mine three iron_ore targets, and not complete after one block.',
    regressionRisk: 'Ore count requests can regress into a single-block mine while still reporting task completion.',
    assert: assertIronOreCountThree
  },
  {
    id: 'mining-iron-ore-until-exhausted',
    testName: 'mining iron ore until nearby targets are exhausted',
    command: '能挖多少铁矿就挖多少',
    targetBlock: 'iron_ore',
    expectedTool: 'stone_pickaxe',
    fixtureTargetCount: 4,
    setup: {
      clear: MINING_CLEAR_ITEMS,
      clearNearbyTargets: ['iron_ore', 'deepslate_iron_ore'],
      give: [{ item: 'stone_pickaxe', count: 1 }],
      targetBlocks: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 1, dy: 0, dz: 0 },
        { dx: 0, dy: 0, dz: 1 },
        { dx: 1, dy: 0, dz: 1 }
      ]
    },
    timeoutMs: 110000,
    expectedBehavior: 'When asked to mine as much iron ore as possible from a finite fixture vein, LinXia should continue past one block and finish because no more nearby iron ore targets remain.',
    regressionRisk: 'Mine-until-exhausted requests can regress into premature completion after one nearby ore.',
    assert: assertIronOreUntilExhausted
  },
  {
    id: 'missing-material-negative',
    testName: 'mining auto-preparation reports missing materials',
    command: '挖一个铁矿',
    targetBlock: 'iron_ore',
    expectedTool: 'stone_pickaxe',
    setup: {
      clear: TOOL_AND_MATERIAL_ITEMS,
      give: [{ item: 'oak_planks', count: 2 }],
      placeCraftingTable: true
    },
    timeoutMs: 70000,
    expectedBehavior: 'When mining iron ore without cobblestone or a usable pickaxe, LinXia should fail the mining task clearly with auto_preparation_failed/missing_materials and not trigger farming.',
    regressionRisk: 'A missing material path can hang the task loop or falsely report mining success after crafting only an unusable intermediate.',
    assert: assertMissingMaterialClearFailure
  },
  {
    id: 'diamond-ore-low-tier-tool-failure',
    testName: 'mining diamond ore fails clearly when pickaxe tier is too low',
    command: '挖钻石矿',
    targetBlock: 'diamond_ore',
    expectedTool: 'iron_pickaxe',
    setup: {
      clear: MINING_CLEAR_ITEMS,
      clearNearbyTargets: ['diamond_ore', 'deepslate_diamond_ore'],
      give: [{ item: 'stone_pickaxe', count: 1 }],
      targetBlocks: [{ dx: 0, dy: 0, dz: 0 }]
    },
    timeoutMs: 70000,
    settleMs: 3000,
    expectedBehavior: 'When diamond ore is nearby but LinXia only has a stone pickaxe, the mining task should fail, avoid mining the block, and explain that an iron pickaxe or better is needed without exposing only a raw failure code.',
    regressionRisk: 'Tier-gated ores can be attempted with too-weak tools or report raw internal failure reasons to the player.',
    assert: assertDiamondOreLowTierFailure
  },
  {
    id: 'woodcutting-bare-hand-log',
    testName: 'woodcutting breaks log bare-handed when no axe is available',
    command: '砍1个木头',
    targetBlock: 'oak_log',
    setup: {
      clear: TOOL_AND_MATERIAL_ITEMS,
      clearNearbyWood: true,
      treeBlocks: [{ dx: 0, dy: 0, dz: 0 }]
    },
    timeoutMs: 50000,
    expectedBehavior: 'When chopping a log with no axe, LinXia should route through mining/tree task, use bare-hand fallback, break the log, and complete.',
    regressionRisk: 'Woodcutting can regress by treating a missing axe like missing pickaxe material even though logs are hand-breakable.',
    assert: assertWoodcuttingBareHandSuccess
  },
  {
    id: 'woodcutting-count-two-trees',
    testName: 'woodcutting tree count does not complete after one block',
    command: '砍附近2棵树',
    targetBlock: 'oak_log',
    setup: {
      clear: WOODCUTTING_CLEAR_ITEMS,
      clearNearbyWood: true,
      give: [{ item: 'iron_axe', count: 1 }],
      treeBlocks: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 0, dy: 1, dz: 0 },
        { dx: 5, dy: 0, dz: 0 },
        { dx: 5, dy: 1, dz: 0 }
      ]
    },
    timeoutMs: 70000,
    expectedBehavior: 'When asked to chop two trees, LinXia should chop connected logs from both fixture trees and only complete after reaching the requested tree count.',
    regressionRisk: 'Tree count requests can regress into mining a single log and reporting task completion.',
    assert: assertWoodcuttingCountSuccess
  },
  {
    id: 'woodcutting-count-three-trees',
    testName: 'woodcutting chops three trees for a three-tree request',
    command: '砍3棵树',
    targetBlock: 'oak_log',
    setup: {
      clear: WOODCUTTING_CLEAR_ITEMS,
      clearNearbyWood: true,
      give: [{ item: 'iron_axe', count: 1 }],
      treeBlocks: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 0, dy: 1, dz: 0 },
        { dx: 4, dy: 0, dz: 0 },
        { dx: 4, dy: 1, dz: 0 },
        { dx: 0, dy: 0, dz: 4 },
        { dx: 0, dy: 1, dz: 4 }
      ]
    },
    timeoutMs: 90000,
    expectedBehavior: 'When asked to chop three trees, LinXia should complete exactly the requested tree-count behavior, chop at least two logs per fixture tree, and not finish after the first tree.',
    regressionRisk: 'Tree count requests can regress into one-tree or one-log completion.',
    assert: assertWoodcuttingThreeTreesSuccess
  },
  {
    id: 'woodcutting-default-log-batch',
    testName: 'woodcutting default log batch chops more than one log',
    command: '多砍点木头',
    targetBlock: 'oak_log',
    setup: {
      clear: WOODCUTTING_CLEAR_ITEMS,
      clearNearbyWood: true,
      give: [{ item: 'iron_axe', count: 1 }],
      treeBlocks: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 0, dy: 1, dz: 0 },
        { dx: 4, dy: 0, dz: 0 },
        { dx: 4, dy: 1, dz: 0 },
        { dx: 0, dy: 0, dz: 4 },
        { dx: 0, dy: 1, dz: 4 },
        { dx: 4, dy: 0, dz: 4 },
        { dx: 4, dy: 1, dz: 4 }
      ]
    },
    timeoutMs: 90000,
    expectedBehavior: 'When asked to chop more wood without an explicit number, LinXia should use the default log_count batch behavior and chop multiple logs, not just one block.',
    regressionRisk: 'Default woodcutting batch requests can collapse into a single-log task.',
    assert: assertWoodcuttingDefaultLogBatch
  },
  {
    id: 'woodcutting-insufficient-trees',
    testName: 'woodcutting reports partial when nearby trees are insufficient',
    command: '砍附近3棵树',
    targetBlock: 'oak_log',
    setup: {
      clear: WOODCUTTING_CLEAR_ITEMS,
      clearNearbyWood: true,
      give: [{ item: 'iron_axe', count: 1 }],
      treeBlocks: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 0, dy: 1, dz: 0 }
      ]
    },
    timeoutMs: 70000,
    expectedBehavior: 'When only one nearby tree is available for a three-tree request, LinXia should fail the task with partial/insufficient tree evidence instead of reporting success.',
    regressionRisk: 'Insufficient tree targets can be hidden as success, causing false acceptance passes and stale task memory.',
    assert: assertWoodcuttingInsufficientTrees
  }
]

module.exports = {
  featureName: FEATURE,
  testName: 'mining auto-preparation suite',
  commandOrInput: 'mining auto-preparation suite',

  async run({ adapter, projectConfig, createRecord }) {
    const config = projectConfig.minecraft.mining || {}
    const records = []

    // Optional env-gated scenario filter (default: run all). Lets a single
    // targeted scenario be run without batching the full suite, which avoids
    // losing evidence to an outer timeout. Does not alter fixtures/assertions.
    const scenarioFilter = String(process.env.ACCEPTANCE_MINING_SCENARIOS || '')
      .split(',').map(entry => entry.trim()).filter(Boolean)
    const scenarios = scenarioFilter.length
      ? SCENARIOS.filter(scenario => scenarioFilter.includes(scenario.id))
      : SCENARIOS

    for (const scenario of scenarios) {
      console.log(`[mining-acceptance] start scenario=${scenario.id}`)
      const cursor = adapter.createLogCursor()
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
          nextSuggestion: 'Ensure LinXia is online, command fixtures are allowed, and the target block/crafting table can be placed near the bot.'
        })))
        console.log(`[mining-acceptance] blocked scenario=${scenario.id} reason=${setup.setupFailureReason}`)
        continue
      }

      records.push(createRecord(await runScenario({ adapter, config, setup, scenario })))
      console.log(`[mining-acceptance] done scenario=${scenario.id}`)
    }

    return records
  }
}

async function prepareScenario(adapter, config, scenario, cursor) {
  const alignment = await adapter.runServerCommand(`tp ${adapter.aiUsername()} ${adapter.testUsername()}`)
  await adapter.wait(700)
  const baseSnapshot = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })

  const fixtureStatus = {
    feature: FEATURE,
    scenarioId: scenario.id,
    ready: false,
    reason: 'fixture_pending',
    alignment,
    commands: [],
    beforeInventory: inventorySummary(baseSnapshot)
  }

  if (alignment.commandDenied) {
    return {
      setupStatus: 'BLOCKED',
      setupFailureReason: 'alignment_command_denied',
      snapshot: baseSnapshot,
      fixtureStatus: { ...fixtureStatus, reason: 'alignment_command_denied' }
    }
  }

  if (!baseSnapshot.configuredAiOnline || !baseSnapshot.debugStatusAvailable) {
    return {
      setupStatus: 'BLOCKED',
      setupFailureReason: !baseSnapshot.configuredAiOnline ? 'configured_ai_not_online' : 'debug_status_unavailable',
      snapshot: baseSnapshot,
      fixtureStatus
    }
  }

  const commands = buildFixtureCommands(adapter, baseSnapshot, scenario)
  const commandResult = await runFixtureCommands(adapter, commands)
  fixtureStatus.commands = commandResult.commands
  fixtureStatus.commandDenied = commandResult.commandDenied
  fixtureStatus.deniedMessage = commandResult.deniedMessage

  if (commandResult.commandDenied) {
    return {
      setupStatus: 'BLOCKED',
      setupFailureReason: 'command_denied',
      snapshot: baseSnapshot,
      fixtureStatus: { ...fixtureStatus, reason: 'command_denied' }
    }
  }

  await adapter.wait(1200)
  const after = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const inventory = inventorySummary(after)
  const table = scenario.setup.placeCraftingTable ? blockAtPosition(adapter, craftingTablePositionFor(baseSnapshot)) : null
  const fixtureTargets = fixtureBlockPositionsFor(baseSnapshot, scenario).map(position => blockAtPosition(adapter, position))
  const target = fixtureTargets[0] || blockAtPosition(adapter, targetBlockPositionFor(baseSnapshot))
  const verification = verifyFixture({ scenario, inventory, table, target, fixtureTargets })

  return {
    setupStatus: verification.ready ? 'READY' : 'BLOCKED',
    setupFailureReason: verification.ready ? null : verification.reason,
    snapshot: after,
    fixtureStatus: {
      ...fixtureStatus,
      ready: verification.ready,
      reason: verification.reason,
      afterInventory: inventory,
      table,
      target,
      fixtureTargets,
      verification
    }
  }
}

function buildFixtureCommands(adapter, snapshot, scenario) {
  const ai = adapter.aiUsername()
  const target = targetBlockPositionFor(snapshot)
  const table = craftingTablePositionFor(snapshot)
  const commands = []

  commands.push(`execute at ${ai} run kill @e[type=minecraft:item,distance=..48]`)

  for (const item of scenario.setup.clear || []) {
    commands.push(`clear ${ai} minecraft:${item}`)
  }

  commands.push(`setblock ${target.x} ${target.y - 1} ${target.z} minecraft:dirt`)
  commands.push(`setblock ${target.x} ${target.y + 1} ${target.z} minecraft:air`)
  if (scenario.setup.clearNearbyWood) {
    const min = { x: target.x - 24, y: target.y - 4, z: target.z - 24 }
    const max = { x: target.x + 24, y: target.y + 8, z: target.z + 24 }
    for (const blockName of WOOD_BLOCKS_TO_CLEAR) {
      commands.push(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} minecraft:air replace minecraft:${blockName}`)
    }
  }
  for (const blockName of scenario.setup.clearNearbyTargets || []) {
    const radius = Number(scenario.setup.clearNearbyTargetRadius || 32)
    const min = { x: target.x - radius, y: target.y - radius, z: target.z - radius }
    const max = { x: target.x + radius, y: target.y + 16, z: target.z + radius }
    addFillReplaceCommands(commands, min, max, blockName)
  }

  const fixtureBlocks = scenario.setup.treeBlocks || scenario.setup.targetBlocks || null
  if (fixtureBlocks) {
    for (const entry of fixtureBlocks) {
      const pos = {
        x: target.x + Number(entry.dx || 0),
        y: target.y + Number(entry.dy || 0),
        z: target.z + Number(entry.dz || 0)
      }
      if (entry.dy === 0) commands.push(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:dirt`)
      commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:${entry.block || scenario.targetBlock}`)
      commands.push(`setblock ${pos.x} ${pos.y + 1} ${pos.z} minecraft:air`)
    }
  } else {
    commands.push(`setblock ${target.x} ${target.y} ${target.z} minecraft:${scenario.targetBlock}`)
  }

  if (scenario.setup.placeCraftingTable) {
    commands.push(`setblock ${table.x} ${table.y - 1} ${table.z} minecraft:dirt`)
    commands.push(`setblock ${table.x} ${table.y + 1} ${table.z} minecraft:air`)
    commands.push(`setblock ${table.x} ${table.y} ${table.z} minecraft:crafting_table`)
  }

  for (const entry of scenario.setup.give || []) {
    commands.push(`give ${ai} minecraft:${entry.item} ${entry.count}`)
  }

  return commands
}

function addFillReplaceCommands(commands, min, max, blockName) {
  const chunkSize = 30
  for (let x = min.x; x <= max.x; x += chunkSize) {
    for (let y = min.y; y <= max.y; y += chunkSize) {
      for (let z = min.z; z <= max.z; z += chunkSize) {
        const chunkMax = {
          x: Math.min(max.x, x + chunkSize - 1),
          y: Math.min(max.y, y + chunkSize - 1),
          z: Math.min(max.z, z + chunkSize - 1)
        }
        commands.push(`fill ${x} ${y} ${z} ${chunkMax.x} ${chunkMax.y} ${chunkMax.z} minecraft:air replace minecraft:${blockName}`)
      }
    }
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

function verifyFixture({ scenario, inventory, table, target, fixtureTargets = [] }) {
  if (!inventory) return { ready: false, reason: 'inventory_debug_unavailable' }
  const givenItems = new Set((scenario.setup.give || []).map(entry => entry.item))
  for (const item of scenario.setup.clear || []) {
    if (givenItems.has(item)) continue
    if (itemCount(inventory, item) > 0) return { ready: false, reason: `inventory_clear_failed:${item}` }
  }
  for (const entry of scenario.setup.give || []) {
    if (itemCount(inventory, entry.item) < entry.count) return { ready: false, reason: `inventory_give_failed:${entry.item}` }
  }
  if (scenario.setup.placeCraftingTable && table?.blockName !== 'crafting_table') {
    return { ready: false, reason: `crafting_table_fixture_missing:${table?.blockName || 'none'}` }
  }
  if (target?.blockName !== scenario.targetBlock) {
    return { ready: false, reason: `target_block_fixture_missing:${target?.blockName || 'none'}` }
  }
  for (const fixtureTarget of fixtureTargets) {
    if (fixtureTarget?.blockName !== scenario.targetBlock) {
      return { ready: false, reason: `target_block_fixture_missing:${fixtureTarget?.blockName || 'none'}` }
    }
  }
  return { ready: true, reason: 'fixture_ready' }
}

async function runScenario({ adapter, config, setup, scenario }) {
  const commandCursor = adapter.createLogCursor()
  const preState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const beforeInventory = inventorySummary(preState)
  const targetBefore = blockAtPosition(adapter, targetBlockPositionFor(setup.snapshot || preState))

  await adapter.sendCommand(scenario.command, { afterMs: 250 })
  const terminalLogs = await waitForScenarioTerminal(adapter, scenario, commandCursor, config)
  await adapter.wait(scenario.settleMs || (scenario.id === 'missing-material-negative' ? 2500 : 1500))

  const postState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const afterInventory = inventorySummary(postState)
  const targetAfter = blockAtPosition(adapter, targetBlockPositionFor(setup.snapshot || preState))
  const fixtureTargetsAfter = fixtureBlockPositionsFor(setup.snapshot || preState, scenario).map(position => blockAtPosition(adapter, position))
  const logs = adapter.readLogsSince(commandCursor)
  const assertion = scenario.assert({
    scenario,
    logs,
    terminalLogs,
    preState,
    postState,
    beforeInventory,
    afterInventory,
    targetBefore,
    targetAfter,
    fixtureTargetsAfter
  })

  return {
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState,
    postState,
    observedBehavior: assertion.judgment === 'PASS' ? assertion.passReason : 'mining_auto_preparation_integration_failed',
    expectedBehavior: scenario.expectedBehavior,
    actualResult: assertion.judgment === 'PASS' ? assertion.passReason : 'mining_auto_preparation_integration_failed',
    judgment: assertion.judgment,
    passOrFail: assertion.judgment,
    failureReason: assertion.failureReason,
    evidence: {
      scenarioId: scenario.id,
      beforeInventory,
      afterInventory,
      targetBefore,
      targetAfter,
      fixtureTargetsAfter,
      itemDeltas: itemDeltas(beforeInventory, afterInventory, trackedItemsFor(scenario)),
      autoPrepSignals: autoPrepSignals(logs),
      miningSignals: miningSignals(logs),
      assertion,
      setup: setup.fixtureStatus || {},
      taskSignals: postState.taskSignals
    },
    relatedLogs: logs.slice(-160),
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: assertion.judgment === 'PASS'
      ? 'Keep this mining auto-preparation slice in the targeted acceptance suite.'
      : 'Inspect command routing, auto-prep logs, crafting execution, equipment selection, and mining terminal task logs.',
    ...environmentFields(adapter, postState, setup)
  }
}

async function waitForScenarioTerminal(adapter, scenario, cursor, config) {
  const timeout = scenario.timeoutMs || config.timeoutMs || 70000
  const terminal = [
    /\[TaskManager\] completed #[0-9]+ mining/,
    /\[TaskManager\] failed #[0-9]+ mining/,
    /\[FARMING_TASK_START\]/
  ]
  return adapter.waitForLog(terminal, timeout, cursor)
}

function assertAutoToolSuccess(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, trackedItemsFor(ctx.scenario))
  const pass = common.intentOk &&
    common.taskStarted &&
    common.autoPrepared &&
    common.toolEquipped &&
    common.blockMined &&
    common.taskCompleted &&
    !common.taskFailed &&
    !common.farmingTriggered &&
    itemCount(ctx.afterInventory, ctx.scenario.expectedTool) >= 1

  return assertion(pass, `${ctx.scenario.id}_verified`, {
    ...common,
    deltas,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!common.autoPrepared, 'auto_preparation_not_confirmed'],
      [!common.toolEquipped, `expected_tool_not_equipped:${ctx.scenario.expectedTool}`],
      [!common.blockMined, 'target_block_not_mined'],
      [!common.taskCompleted, 'mining_task_not_completed'],
      [common.taskFailed, 'mining_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered'],
      [itemCount(ctx.afterInventory, ctx.scenario.expectedTool) < 1, `expected_tool_missing_after:${ctx.scenario.expectedTool}`]
    ])
  })
}

function assertMissingMaterialClearFailure(ctx) {
  const common = commonSignals(ctx)
  const missingCobble = ctx.logs.some(line => line.includes('auto_preparation_failed') && line.includes('cobblestone'))
  const noMinedBlock = !common.blockMined
  const pass = common.intentOk &&
    common.taskStarted &&
    common.autoPrepFailed &&
    missingCobble &&
    common.taskFailed &&
    noMinedBlock &&
    !common.taskCompleted &&
    !common.farmingTriggered

  return assertion(pass, 'missing_material_negative_verified', {
    ...common,
    missingCobble,
    noMinedBlock,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!common.autoPrepFailed, 'auto_preparation_failure_not_logged'],
      [!missingCobble, 'missing_cobblestone_not_reported'],
      [!common.taskFailed, 'mining_task_not_failed'],
      [common.taskCompleted, 'mining_task_completed_unexpectedly'],
      [common.blockMined, 'block_mined_despite_missing_tool_material'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertIronOreCountThree(ctx) {
  const common = commonSignals(ctx)
  const countParamObserved = taskParamObserved(ctx.logs, '"count":3')
  const minedCount = minedCountFromMiningLogs(ctx.logs)
  const ironOreMinedEvents = blockMinedEventCount(ctx.logs, 'iron_ore')
  const suitablePickaxe = toolSelectedOneOf(ctx.logs, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])
  const weakPickaxeUsed = toolSelectedOneOf(ctx.logs, ['wooden_pickaxe'])
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskCompleted &&
    !common.taskFailed &&
    countParamObserved &&
    minedCount >= 3 &&
    ironOreMinedEvents >= 3 &&
    suitablePickaxe &&
    !weakPickaxeUsed &&
    !common.farmingTriggered

  return assertion(pass, 'iron_ore_count_three_verified', {
    ...common,
    countParamObserved,
    minedCount,
    ironOreMinedEvents,
    suitablePickaxe,
    weakPickaxeUsed,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!countParamObserved, 'count_3_not_observed_in_task_params'],
      [minedCount < 3, `mined_count_too_low:${minedCount}`],
      [ironOreMinedEvents < 3, `iron_ore_mined_events_too_low:${ironOreMinedEvents}`],
      [!suitablePickaxe, 'suitable_pickaxe_not_used_for_iron_ore'],
      [weakPickaxeUsed, 'wooden_pickaxe_used_for_iron_ore'],
      [!common.taskCompleted, 'mining_task_not_completed'],
      [common.taskFailed, 'mining_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertIronOreUntilExhausted(ctx) {
  const common = commonSignals(ctx)
  const expectedCount = Number(ctx.scenario.fixtureTargetCount || 1)
  const mineUntilExhaustedObserved = taskParamObserved(ctx.logs, '"mineUntilExhausted":true')
  const minedCount = minedCountFromMiningLogs(ctx.logs)
  const ironOreMinedEvents = blockMinedEventCount(ctx.logs, 'iron_ore')
  const exhaustedFinish = ctx.logs.some(line =>
    line.includes('complete_with_no_more_targets') ||
    line.includes('finishReason=complete_with_no_more_targets')
  )
  const remainingZero = ctx.logs.some(line => line.includes('remainingNearbyTargets=0') && line.includes('complete_with_no_more_targets'))
  const suitablePickaxe = toolSelectedOneOf(ctx.logs, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])
  const prematureSingleBlockCompletion = common.taskCompleted && minedCount <= 1 && !exhaustedFinish
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskCompleted &&
    !common.taskFailed &&
    mineUntilExhaustedObserved &&
    minedCount >= expectedCount &&
    ironOreMinedEvents >= expectedCount &&
    exhaustedFinish &&
    remainingZero &&
    suitablePickaxe &&
    !prematureSingleBlockCompletion &&
    !common.farmingTriggered

  return assertion(pass, 'iron_ore_until_exhausted_verified', {
    ...common,
    expectedCount,
    mineUntilExhaustedObserved,
    minedCount,
    ironOreMinedEvents,
    exhaustedFinish,
    remainingZero,
    suitablePickaxe,
    prematureSingleBlockCompletion,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!mineUntilExhaustedObserved, 'mine_until_exhausted_not_observed'],
      [minedCount < expectedCount, `mined_count_too_low:${minedCount}`],
      [ironOreMinedEvents < expectedCount, `iron_ore_mined_events_too_low:${ironOreMinedEvents}`],
      [!exhaustedFinish, 'exhausted_finish_reason_missing'],
      [!remainingZero, 'remaining_targets_not_zero_at_exhaustion'],
      [!suitablePickaxe, 'suitable_pickaxe_not_used_for_iron_ore'],
      [prematureSingleBlockCompletion, 'premature_single_block_completion'],
      [!common.taskCompleted, 'mining_task_not_completed'],
      [common.taskFailed, 'mining_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertDiamondOreLowTierFailure(ctx) {
  const common = commonSignals(ctx)
  const minedCount = minedCountFromMiningLogs(ctx.logs)
  const diamondOreMinedEvents = blockMinedEventCount(ctx.logs, 'diamond_ore')
  const requiredToolLogged = ctx.logs.some(line => line.includes('iron_pickaxe_or_better'))
  const missingRequiredTool = ctx.logs.some(line => line.includes('missing_required_tool:iron_pickaxe_or_better'))
  const rawInternalReasonExposed = /auto_preparation_failed|unsupported_min_tier/i.test(feedbackText(ctx))
  const feedback = feedbackText(ctx)
  const feedbackMentionsBetterPickaxe = /铁镐|更高级|iron pickaxe|iron_pickaxe_or_better/i.test(feedback)
  const rawReasonExposed = /missing_required_tool:|原因是missing_required_tool/i.test(feedback)
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskFailed &&
    !common.taskCompleted &&
    requiredToolLogged &&
    missingRequiredTool &&
    minedCount === 0 &&
    diamondOreMinedEvents === 0 &&
    feedbackMentionsBetterPickaxe &&
    !rawInternalReasonExposed &&
    !rawReasonExposed &&
    !common.farmingTriggered

  return assertion(pass, 'diamond_low_tier_tool_failure_verified', {
    ...common,
    minedCount,
    diamondOreMinedEvents,
    requiredToolLogged,
    missingRequiredTool,
    feedback,
    feedbackMentionsBetterPickaxe,
    rawInternalReasonExposed,
    rawReasonExposed,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!requiredToolLogged, 'required_iron_pickaxe_or_better_not_logged'],
      [!missingRequiredTool, 'missing_required_tool_not_logged'],
      [minedCount !== 0, `diamond_ore_mined_despite_low_tier_tool:${minedCount}`],
      [diamondOreMinedEvents !== 0, `diamond_ore_mined_events_unexpected:${diamondOreMinedEvents}`],
      [!common.taskFailed, 'mining_task_should_fail_for_low_tier_tool'],
      [common.taskCompleted, 'mining_task_completed_despite_low_tier_tool'],
      [!feedbackMentionsBetterPickaxe, 'feedback_does_not_explain_better_pickaxe_needed'],
      [rawInternalReasonExposed, 'feedback_exposes_raw_auto_preparation_reason'],
      [rawReasonExposed, 'feedback_exposes_raw_missing_required_tool_reason'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertWoodcuttingBareHandSuccess(ctx) {
  const common = commonSignals(ctx)
  const bareHandFallback = ctx.logs.some(line =>
    (line.includes('[auto-prep] target=tool') && line.includes('bare_hand_fallback')) ||
    (line.includes('[equipment]') && line.includes('selectedTool=hand') && line.includes('allowHand=true'))
  )
  const treeLogMined = treeLogMinedCount(ctx.logs) >= 1
  const targetGone = ctx.targetAfter?.blockName !== ctx.scenario.targetBlock
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskCompleted &&
    !common.taskFailed &&
    bareHandFallback &&
    treeLogMined &&
    targetGone &&
    !common.farmingTriggered

  return assertion(pass, 'woodcutting_bare_hand_verified', {
    ...common,
    bareHandFallback,
    treeLogMined,
    targetGone,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!bareHandFallback, 'bare_hand_fallback_not_observed'],
      [!treeLogMined, 'log_not_mined'],
      [!targetGone, 'target_log_still_present'],
      [!common.taskCompleted, 'woodcutting_task_not_completed'],
      [common.taskFailed, 'woodcutting_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertWoodcuttingThreeTreesSuccess(ctx) {
  const common = commonSignals(ctx)
  const completedTreeCount = maxNumberFromLogs(ctx.logs, /completedTreeCount=([0-9]+)/g)
  const choppedLogCount = maxNumberFromLogs(ctx.logs, /choppedLogCount=([0-9]+)/g)
  const logMinedCount = treeLogMinedCount(ctx.logs)
  const targetTreeCountObserved = taskParamObserved(ctx.logs, '"targetTreeCount":3')
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskCompleted &&
    !common.taskFailed &&
    targetTreeCountObserved &&
    completedTreeCount >= 3 &&
    choppedLogCount >= 6 &&
    logMinedCount >= 6 &&
    !common.farmingTriggered

  return assertion(pass, 'woodcutting_three_trees_verified', {
    ...common,
    completedTreeCount,
    choppedLogCount,
    logMinedCount,
    targetTreeCountObserved,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!targetTreeCountObserved, 'target_tree_count_3_not_observed'],
      [completedTreeCount < 3, `completed_tree_count_too_low:${completedTreeCount}`],
      [choppedLogCount < 6, `chopped_log_count_too_low:${choppedLogCount}`],
      [logMinedCount < 6, `log_mined_count_too_low:${logMinedCount}`],
      [!common.taskCompleted, 'woodcutting_task_not_completed'],
      [common.taskFailed, 'woodcutting_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertWoodcuttingDefaultLogBatch(ctx) {
  const common = commonSignals(ctx)
  const targetLogCount = maxNumberFromLogs(ctx.logs, /targetLogCount[":=]+([0-9]+)/g)
  const choppedLogCount = maxNumberFromLogs(ctx.logs, /choppedLogCount=([0-9]+)/g)
  const logMinedCount = treeLogMinedCount(ctx.logs)
  const logCountModeObserved = ctx.logs.some(line => line.includes('"treeMode":"log_count"') || line.includes('mode=log_count'))
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskCompleted &&
    !common.taskFailed &&
    logCountModeObserved &&
    targetLogCount >= 8 &&
    choppedLogCount >= 8 &&
    logMinedCount >= 8 &&
    !common.farmingTriggered

  return assertion(pass, 'woodcutting_default_log_batch_verified', {
    ...common,
    targetLogCount,
    choppedLogCount,
    logMinedCount,
    logCountModeObserved,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!logCountModeObserved, 'log_count_mode_not_observed'],
      [targetLogCount < 8, `target_log_count_too_low:${targetLogCount}`],
      [choppedLogCount < 8, `chopped_log_count_too_low:${choppedLogCount}`],
      [logMinedCount < 8, `log_mined_count_too_low:${logMinedCount}`],
      [!common.taskCompleted, 'woodcutting_task_not_completed'],
      [common.taskFailed, 'woodcutting_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertWoodcuttingCountSuccess(ctx) {
  const common = commonSignals(ctx)
  const completedTreeCount = maxNumberFromLogs(ctx.logs, /completedTreeCount=([0-9]+)/g)
  const choppedLogCount = maxNumberFromLogs(ctx.logs, /choppedLogCount=([0-9]+)/g)
  const logMinedCount = treeLogMinedCount(ctx.logs)
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskCompleted &&
    !common.taskFailed &&
    completedTreeCount >= 2 &&
    choppedLogCount >= 4 &&
    logMinedCount >= 4 &&
    !common.farmingTriggered

  return assertion(pass, 'woodcutting_count_verified', {
    ...common,
    completedTreeCount,
    choppedLogCount,
    logMinedCount,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [completedTreeCount < 2, `completed_tree_count_too_low:${completedTreeCount}`],
      [choppedLogCount < 4, `chopped_log_count_too_low:${choppedLogCount}`],
      [logMinedCount < 4, `log_mined_count_too_low:${logMinedCount}`],
      [!common.taskCompleted, 'woodcutting_task_not_completed'],
      [common.taskFailed, 'woodcutting_task_failed'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function assertWoodcuttingInsufficientTrees(ctx) {
  const common = commonSignals(ctx)
  const completedTreeCount = maxNumberFromLogs(ctx.logs, /completedTreeCount=([0-9]+)/g)
  const choppedLogCount = maxNumberFromLogs(ctx.logs, /choppedLogCount=([0-9]+)/g)
  const partialReason = ctx.logs.some(line => line.includes('partial_completed_no_more_trees'))
  const pass = common.intentOk &&
    common.taskStarted &&
    common.taskFailed &&
    !common.taskCompleted &&
    partialReason &&
    completedTreeCount === 1 &&
    choppedLogCount >= 2 &&
    !common.farmingTriggered

  return assertion(pass, 'woodcutting_insufficient_trees_verified', {
    ...common,
    completedTreeCount,
    choppedLogCount,
    partialReason,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'intent_not_routed_to_mining'],
      [!common.taskStarted, 'mining_task_not_started'],
      [!partialReason, 'partial_insufficient_reason_missing'],
      [completedTreeCount !== 1, `completed_tree_count_unexpected:${completedTreeCount}`],
      [choppedLogCount < 2, `chopped_log_count_too_low:${choppedLogCount}`],
      [!common.taskFailed, 'woodcutting_task_should_fail_partial'],
      [common.taskCompleted, 'woodcutting_task_completed_despite_insufficient_trees'],
      [common.farmingTriggered, 'unexpected_farming_triggered']
    ])
  })
}

function commonSignals(ctx) {
  const logs = ctx.logs || []
  const expectedTool = ctx.scenario.expectedTool
  return {
    intentOk: logs.some(line => line.includes('[INTENT_RESULT]') && (line.includes('MINE_BLOCK') || line.includes('FIND_ORE'))),
    taskStarted: logs.some(line =>
      (line.includes('[task-manager] start task=mining')) ||
      (line.includes('[TASK_STARTED]') && line.includes('"type":"mining"'))
    ),
    taskCompleted: logs.some(line => /\[TaskManager\] completed #[0-9]+ mining/.test(line)),
    taskFailed: logs.some(line => /\[TaskManager\] failed #[0-9]+ mining/.test(line)),
    autoPrepared: logs.some(line => line.includes('[auto-prep] target=tool') && line.includes('result=prepared') && line.includes(expectedTool)),
    autoPrepFailed: logs.some(line => line.includes('auto_preparation_failed') || (line.includes('[auto-prep] target=tool') && line.includes('result=failed'))),
    toolEquipped: logs.some(line => line.includes('[equipment]') && line.includes(`selectedTool=${expectedTool}`) && line.includes('error=none')),
    blockMined: logs.some(line => line.includes('[mining]') && line.includes('result=block_mined')),
    farmingTriggered: logs.some(line => line.includes('[FARMING_TASK_START]'))
  }
}

function autoPrepSignals(logs) {
  return (logs || []).filter(line => line.includes('[auto-prep]'))
}

function miningSignals(logs) {
  return (logs || []).filter(line => line.includes('[mining]') || line.includes('[equipment]') || line.includes('[tree]'))
}

function treeLogMinedCount(logs = []) {
  return logs.filter(line => line.includes('[tree]') && line.includes('result=log_mined')).length
}

function minedCountFromMiningLogs(logs = []) {
  return maxNumberFromLogs(logs.filter(line => line.includes('[mining]')), /minedCount=([0-9]+)/g)
}

function blockMinedEventCount(logs = [], blockName) {
  return logs.filter(line =>
    line.includes('[mining]') &&
    line.includes('result=block_mined') &&
    (!blockName || line.includes(`selectedBlock.name=${blockName}`) || line.includes(`selectedBlock=${blockName}`))
  ).length
}

function toolSelectedOneOf(logs = [], itemNames = []) {
  return logs.some(line =>
    line.includes('[equipment]') &&
    line.includes('error=none') &&
    itemNames.some(itemName => line.includes(`selectedTool=${itemName}`))
  )
}

function taskParamObserved(logs = [], fragment) {
  return logs.some(line =>
    (line.includes('[TASK_CREATED]') || line.includes('[TASK_STARTED]') || line.includes('[intent-to-task]')) &&
    line.includes(fragment)
  )
}

function feedbackText(ctx) {
  const chatLines = (ctx.logs || [])
    .filter(line => line.includes('[CHAT_IGNORED]') || line.includes('[CHAT_OUTPUT]'))
    .join('\n')
  return chatLines
}

function maxNumberFromLogs(logs = [], pattern) {
  let max = 0
  for (const line of logs) {
    const matches = line.matchAll(pattern)
    for (const match of matches) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > max) max = value
    }
  }
  return max
}

function assertion(pass, passReason, details = {}) {
  return {
    judgment: pass ? 'PASS' : 'FAIL',
    passReason,
    failureReason: pass ? null : (details.failureReason || 'mining_auto_preparation_expectation_not_met'),
    ...details
  }
}

function failureReason(entries) {
  const failed = entries.find(([condition]) => condition)
  return failed ? failed[1] : 'mining_auto_preparation_expectation_not_met'
}

function itemDeltas(before, after, items) {
  const result = {}
  for (const item of items) {
    const beforeCount = itemCount(before, item)
    const afterCount = itemCount(after, item)
    result[item] = { before: beforeCount, after: afterCount, delta: afterCount - beforeCount }
  }
  return result
}

function trackedItemsFor(scenario) {
  return Array.from(new Set([
    scenario.expectedTool,
    'wooden_pickaxe',
    'stone_pickaxe',
    'iron_pickaxe',
    'stick',
    'oak_planks',
    'cobblestone',
    'raw_iron',
    'iron_ore',
    'diamond',
    'oak_log'
  ].filter(Boolean)))
}

function inventorySummary(snapshot = {}) {
  return snapshot.debugStatus?.status?.inventorySummary || null
}

function itemCount(inventory, itemName) {
  if (!inventory) return 0
  if (inventory.counts && Object.prototype.hasOwnProperty.call(inventory.counts, itemName)) {
    return Number(inventory.counts[itemName] || 0)
  }
  return (inventory.items || []).reduce((sum, item) => {
    return sum + (item.name === itemName ? Number(item.count || 0) : 0)
  }, inventory.heldItem === itemName ? Number(inventory.heldItemCount || 1) : 0)
}

function anchorPosition(snapshot = {}) {
  return snapshot.companionPosition || snapshot.aiPosition || snapshot.acceptancePlayerPosition || snapshot.playerPosition || { x: 0, y: 64, z: 0 }
}

function targetBlockPositionFor(snapshot = {}) {
  const anchor = anchorPosition(snapshot)
  return {
    x: Math.floor(Number(anchor.x)) + 2,
    y: Math.floor(Number(anchor.y)) + 1,
    z: Math.floor(Number(anchor.z))
  }
}

function fixtureBlockPositionsFor(snapshot = {}, scenario = {}) {
  const target = targetBlockPositionFor(snapshot)
  const entries = scenario.setup?.treeBlocks || scenario.setup?.targetBlocks || null
  if (!entries) return [target]
  return entries.map(entry => ({
    x: target.x + Number(entry.dx || 0),
    y: target.y + Number(entry.dy || 0),
    z: target.z + Number(entry.dz || 0)
  }))
}

function craftingTablePositionFor(snapshot = {}) {
  const anchor = anchorPosition(snapshot)
  return {
    x: Math.floor(Number(anchor.x)) + 1,
    y: Math.floor(Number(anchor.y)),
    z: Math.floor(Number(anchor.z)) + 2
  }
}

function blockAtPosition(adapter, position) {
  const block = adapter.bot?.blockAt?.(new Vec3(Number(position.x), Number(position.y), Number(position.z)))
  return {
    ok: Boolean(block),
    position,
    blockName: block?.name || null
  }
}
