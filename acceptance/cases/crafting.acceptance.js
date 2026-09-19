const { Vec3 } = require('vec3')
const { blockedRecord, environmentFields } = require('./minecraft-case-utils')

const FEATURE = 'crafting'
const DEFAULT_COMMAND = '做木棍'
const WOOD_ITEMS = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'crimson_stem',
  'warped_stem',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'crimson_planks',
  'warped_planks'
]

const COMMON_TRACKED_ITEMS = [
  'crafting_table',
  'chest',
  'wooden_pickaxe',
  'stone_pickaxe',
  'wooden_sword',
  'torch',
  'bread',
  'iron_pickaxe',
  'iron_ingot',
  'cobblestone',
  'coal',
  'wheat',
  'stick',
  'oak_log',
  'oak_planks'
]

const SCENARIOS = [
  {
    id: 'inventory-only-2x2',
    testName: 'inventory-only 2x2 crafting',
    command: DEFAULT_COMMAND,
    targetItem: 'stick',
    setup: {
      clear: ['stick'],
      give: [{ item: 'oak_planks', count: 2 }]
    },
    timeoutMs: 35000,
    expectedBehavior: 'The AI should route 做木棍 to CRAFT_ITEM/craft_item, craft sticks from inventory oak_planks through 2x2 crafting, increase stick count, and not trigger storage or farming.',
    regressionRisk: 'Inventory-only recipes can pass in unit tests while Mineflayer recipes or inventory deltas fail in the real game.',
    assert: assertInventoryOnly
  },
  {
    id: 'counted-stick-3',
    testName: 'counted stick crafting',
    command: '做3个木棍',
    targetItem: 'stick',
    setup: {
      clear: ['stick'],
      give: [{ item: 'oak_planks', count: 2 }],
      clearContainers: true
    },
    expect: {
      passReason: 'counted_stick_3_verified',
      planSteps: ['stick'],
      needsCraftingTable: false,
      storageTriggered: false,
      requestedCount: 3,
      minTargetDelta: 3
    },
    timeoutMs: 35000,
    expectedBehavior: 'The AI should route 做3个木棍 to CRAFT_ITEM/craft_item, preserve the requested count semantics, and craft at least 3 sticks rather than a single item.',
    regressionRisk: 'Counted crafting can collapse to one item or lose the player-requested quantity before TaskManager execution.',
    assert: assertCountedStick
  },
  {
    id: 'inventory-chained-log-to-stick',
    testName: 'inventory chained crafting',
    command: DEFAULT_COMMAND,
    targetItem: 'stick',
    setup: {
      clear: [...WOOD_ITEMS, 'stick'],
      give: [{ item: 'oak_log', count: 1 }]
    },
    timeoutMs: 45000,
    expectedBehavior: 'The AI should craft oak_log into oak_planks, consume the plan-produced oak_planks to craft sticks, increase stick count, and not fetch oak_planks from storage.',
    regressionRisk: 'Recursive planning can treat an intermediate item such as oak_planks as missing instead of plan-produced.',
    assert: assertInventoryChained
  },
  {
    id: 'storage-assisted-log-to-stick',
    testName: 'storage-assisted crafting',
    command: DEFAULT_COMMAND,
    targetItem: 'stick',
    setup: {
      clear: [...WOOD_ITEMS, 'stick'],
      chestItems: [{ item: 'oak_log', count: 1, slot: 0 }]
    },
    timeoutMs: 70000,
    expectedBehavior: 'The AI should fetch oak_log from a real chest only because it is missing from inventory, then craft sticks without requesting plan-produced oak_planks from storage.',
    regressionRisk: 'Storage-backed crafting can over-fetch intermediates, fail to retry crafting after storage, or falsely pass without a real transfer.',
    assert: assertStorageAssisted
  },
  {
    id: 'common-crafting-table-2x2',
    testName: 'common survival / crafting table',
    command: '做工作台',
    targetItem: 'crafting_table',
    setup: {
      clear: ['crafting_table'],
      give: [{ item: 'oak_planks', count: 4 }],
      clearContainers: true
    },
    expect: {
      passReason: 'common_crafting_table_2x2_verified',
      planSteps: ['crafting_table'],
      needsCraftingTable: false,
      storageTriggered: false
    },
    timeoutMs: 35000,
    expectedBehavior: 'The AI should craft a crafting_table from inventory planks through 2x2 inventory crafting without using storage or unrelated systems.',
    regressionRisk: 'Workbench bootstrapping can regress if the planner incorrectly requires an existing crafting table to craft a crafting table.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'common-chest-3x3',
    testName: 'common survival / chest',
    command: '做箱子',
    targetItem: 'chest',
    setup: {
      clear: ['chest'],
      give: [{ item: 'oak_planks', count: 8 }],
      placeCraftingTable: true,
      clearContainers: true
    },
    expect: {
      passReason: 'common_chest_3x3_crafting_table_verified',
      planSteps: ['chest'],
      needsCraftingTable: true,
      storageTriggered: false
    },
    timeoutMs: 45000,
    expectedBehavior: 'The AI should use a nearby crafting table to craft a chest from inventory planks through the normal 3x3 recipe path.',
    regressionRisk: '3x3 recipes can look plannable but fail at execution if the crafting table block is not found or passed to Mineflayer craft.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'common-chest-place-inventory-workbench',
    testName: 'common survival / chest with inventory workbench placement',
    command: '做箱子',
    targetItem: 'chest',
    setup: {
      clear: ['chest', 'crafting_table'],
      give: [
        { item: 'oak_planks', count: 8 },
        { item: 'crafting_table', count: 1 }
      ],
      clearContainers: true,
      clearCraftingTables: true,
      clearCraftingTableRadius: 32
    },
    expect: {
      passReason: 'common_chest_inventory_workbench_placement_verified',
      planSteps: ['chest'],
      needsCraftingTable: true,
      storageTriggered: false,
      consumedItems: ['crafting_table']
    },
    timeoutMs: 55000,
    expectedBehavior: 'The AI should craft a chest when no nearby crafting table exists by placing the crafting_table from inventory and using it for the 3x3 recipe.',
    regressionRisk: '3x3 crafting can falsely depend on pre-placed world workbenches and fail when the table is only in inventory.',
    assert: assertInventoryWorkbenchPlacement
  },
  {
    id: 'common-wooden-pickaxe-chained-3x3',
    testName: 'common survival / wooden pickaxe',
    command: '做木镐',
    targetItem: 'wooden_pickaxe',
    setup: {
      clear: ['wooden_pickaxe', 'stick'],
      give: [{ item: 'oak_planks', count: 5 }],
      placeCraftingTable: true,
      clearContainers: true
    },
    expect: {
      passReason: 'common_wooden_pickaxe_chained_3x3_verified',
      planSteps: ['stick', 'wooden_pickaxe'],
      needsCraftingTable: true,
      storageTriggered: false
    },
    timeoutMs: 50000,
    expectedBehavior: 'The AI should craft sticks from planks if needed, then use a nearby crafting table to craft a wooden_pickaxe.',
    regressionRisk: 'Tool recipes can regress by treating plan-produced sticks as missing or by failing the table-required final step.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'common-stone-pickaxe-tool',
    testName: 'common survival / stone pickaxe',
    command: '做石镐',
    targetItem: 'stone_pickaxe',
    setup: {
      clear: ['stone_pickaxe', 'stick'],
      give: [
        { item: 'cobblestone', count: 3 },
        { item: 'oak_planks', count: 2 }
      ],
      placeCraftingTable: true,
      clearContainers: true
    },
    expect: {
      passReason: 'common_stone_pickaxe_tool_crafting_verified',
      planSteps: ['stick', 'stone_pickaxe'],
      needsCraftingTable: true,
      storageTriggered: false
    },
    timeoutMs: 50000,
    expectedBehavior: 'The AI should craft sticks from planks if needed, then use cobblestone at a crafting table to craft a stone_pickaxe.',
    regressionRisk: 'Survival mining loops depend on reliable stone tool crafting from mixed base and intermediate materials.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'common-wooden-sword-tool',
    testName: 'common survival / wooden sword',
    command: '做木剑',
    targetItem: 'wooden_sword',
    setup: {
      clear: ['wooden_sword', 'stick'],
      give: [{ item: 'oak_planks', count: 4 }],
      placeCraftingTable: true,
      clearContainers: true
    },
    expect: {
      passReason: 'common_wooden_sword_crafting_verified',
      planSteps: ['stick', 'wooden_sword'],
      needsCraftingTable: true,
      storageTriggered: false
    },
    timeoutMs: 50000,
    expectedBehavior: 'The AI should craft sticks from planks if needed, then use a nearby crafting table to craft a wooden_sword.',
    regressionRisk: 'Combat preparation can regress if simple weapon recipes bypass the shared planner or fail table execution.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'common-torch-utility',
    testName: 'common survival / torch',
    command: '做火把',
    targetItem: 'torch',
    setup: {
      clear: ['torch', 'stick'],
      give: [
        { item: 'coal', count: 1 },
        { item: 'oak_planks', count: 2 }
      ],
      clearContainers: true
    },
    expect: {
      passReason: 'common_torch_utility_crafting_verified',
      planSteps: ['stick', 'torch'],
      needsCraftingTable: false,
      storageTriggered: false
    },
    timeoutMs: 45000,
    expectedBehavior: 'The AI should craft sticks from planks if needed, then craft torches through the 2x2 utility recipe path.',
    regressionRisk: 'Exploration and mining loops need torch crafting to handle intermediate sticks without a crafting table.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'common-torch-max-possible',
    testName: 'common survival / max possible torch',
    command: '能做多少火把就做多少',
    targetItem: 'torch',
    setup: {
      clear: ['torch', 'stick', 'coal', ...WOOD_ITEMS],
      give: [
        { item: 'coal', count: 2 },
        { item: 'oak_planks', count: 2 }
      ],
      clearContainers: true
    },
    expect: {
      passReason: 'common_torch_max_possible_verified',
      planSteps: ['stick', 'torch'],
      needsCraftingTable: false,
      storageTriggered: false,
      craftMode: 'max_possible',
      targetDelta: 8
    },
    timeoutMs: 50000,
    expectedBehavior: 'The AI should route 能做多少火把就做多少 to CRAFT_ITEM with max_possible mode and craft the maximum feasible 8 torches from 2 coal and 2 planks.',
    regressionRisk: 'Max-possible crafting can degrade into one recipe run or ignore materials produced by earlier plan steps.',
    assert: assertMaxPossibleCraft
  },
  {
    id: 'common-bread-food',
    testName: 'common survival / bread',
    command: '合成面包',
    targetItem: 'bread',
    setup: {
      clear: ['bread'],
      give: [{ item: 'wheat', count: 3 }],
      placeCraftingTable: true,
      clearContainers: true
    },
    expect: {
      passReason: 'common_bread_food_crafting_verified',
      planSteps: ['bread'],
      needsCraftingTable: true,
      storageTriggered: false
    },
    timeoutMs: 45000,
    expectedBehavior: 'The AI should route explicit 合成面包 to CRAFT_ITEM and craft bread from wheat through the crafting-table recipe path.',
    regressionRisk: 'Food loops depend on bread crafting, while the existing 做面包 farming shortcut must remain separate.',
    assert: assertCommonCraftSuccess
  },
  {
    id: 'bread-make-bread-farming-route',
    testName: 'bread route separation / make bread uses farming',
    command: '做面包',
    targetItem: 'bread',
    setup: {
      clear: ['bread'],
      give: [{ item: 'wheat', count: 3 }],
      placeCraftingTable: true,
      clearContainers: true
    },
    expect: {
      passReason: 'bread_make_bread_farming_route_verified',
      actionKey: 'MAKE_BREAD',
      farmingMode: 'MAKE_BREAD'
    },
    timeoutMs: 35000,
    expectedBehavior: 'The AI should route 做面包 to the Farming MAKE_BREAD path, while 合成面包 remains the explicit Crafting CRAFT_ITEM path.',
    regressionRisk: 'Bread command overlap can make farming food behavior and explicit crafting behavior silently steal each other routes.',
    assert: assertBreadMakeBreadRoute
  },
  {
    id: 'missing-material-negative',
    testName: 'missing-material negative case',
    command: '做铁剑',
    targetItem: 'iron_sword',
    setup: {
      clear: [...WOOD_ITEMS, 'stick', 'iron_ingot', 'iron_sword']
    },
    timeoutMs: 45000,
    expectedBehavior: 'The AI should fail the craft_item task clearly when inventory and nearby storage lack required materials, without triggering farming or hanging the active task loop.',
    regressionRisk: 'Missing-material crafting can fake success, start unrelated systems, or leave TaskManager running indefinitely.',
    assert: assertMissingMaterialNegative
  },
  {
    id: 'common-missing-iron-pickaxe-negative',
    testName: 'common survival / missing iron pickaxe negative',
    command: '做铁镐',
    targetItem: 'iron_pickaxe',
    setup: {
      clear: [...WOOD_ITEMS, 'stick', 'iron_ingot', 'iron_pickaxe'],
      clearContainers: true,
      clearContainerRadius: 12
    },
    expect: {
      passReason: 'common_missing_iron_pickaxe_negative_verified',
      missingItems: ['iron_ingot'],
      humanReadableFeedback: true
    },
    timeoutMs: 65000,
    expectedBehavior: 'The AI should fail clearly when asked to craft an iron_pickaxe with no iron in inventory or nearby storage, report iron_ingot as a missing base material, avoid unrelated farming, and return to idle.',
    regressionRisk: 'Missing-material tool crafting can fake success, lose the real missing base material, or leave TaskManager stuck after storage fallback fails.',
    assert: assertCommonMissingMaterialNegative
  }
]

module.exports = {
  featureName: FEATURE,
  testName: 'crafting integration suite',
  commandOrInput: 'crafting integration suite',

  async run({ adapter, projectConfig, createRecord }) {
    const config = projectConfig.minecraft.crafting || {}
    const records = []

    for (const scenario of SCENARIOS) {
      console.log(`[crafting-acceptance] start scenario=${scenario.id}`)
      const cursor = adapter.createLogCursor()
      await adapter.sendCommand('停止任务', { afterMs: 900 })
      const setup = await prepareCraftingScenario(adapter, config, scenario, cursor)
      if (setup.setupStatus !== 'READY') {
        records.push(createRecord(blockedRecord({
          adapter,
          featureName: FEATURE,
          testName: scenario.testName,
          commandOrInput: scenario.command,
          setup,
          expectedBehavior: scenario.expectedBehavior,
          regressionRisk: scenario.regressionRisk,
          nextSuggestion: 'Ensure LinXia is online, debug_status works, and command fixtures can prepare inventory/chest state.'
        })))
        console.log(`[crafting-acceptance] blocked scenario=${scenario.id} reason=${setup.setupFailureReason}`)
        continue
      }

      records.push(createRecord(await runCraftingScenario({ adapter, config, setup, scenario })))
      console.log(`[crafting-acceptance] done scenario=${scenario.id}`)
    }

    return records
  }
}

async function prepareCraftingScenario(adapter, config, scenario, cursor) {
  const alignment = await adapter.runServerCommand(`tp ${adapter.aiUsername()} ${adapter.testUsername()}`)
  await adapter.wait(700)
  const baseSnapshot = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const baseInventory = inventorySummary(baseSnapshot)
  const fixtureStatus = {
    feature: FEATURE,
    scenarioId: scenario.id,
    ready: false,
    reason: 'fixture_pending',
    alignment,
    beforeInventory: baseInventory,
    commands: [],
    chest: null
  }

  if (alignment.commandDenied) {
    return {
      setupStatus: 'BLOCKED',
      setupFailureReason: 'alignment_command_denied',
      snapshot: baseSnapshot,
      fixtureStatus: {
        ...fixtureStatus,
        reason: 'alignment_command_denied'
      }
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
      fixtureStatus: {
        ...fixtureStatus,
        reason: 'command_denied'
      }
    }
  }

  await adapter.wait(1200)
  const after = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const afterInventory = inventorySummary(after)
  const chest = scenario.setup?.chestItems
    ? await adapter.observeContainerAt(chestPositionFor(baseSnapshot), `observe_${scenario.id}_chest_timeout`).catch(err => ({
      ok: false,
      error: err.message,
      counts: {},
      position: chestPositionFor(baseSnapshot)
    }))
    : null
  const table = scenario.setup?.placeCraftingTable
    ? blockAtPosition(adapter, craftingTablePositionFor(baseSnapshot))
    : null

  const verification = verifyFixture({ scenario, inventory: afterInventory, chest, table })
  return {
    setupStatus: verification.ready ? 'READY' : 'BLOCKED',
    setupFailureReason: verification.ready ? null : verification.reason,
    snapshot: after,
    fixtureStatus: {
      ...fixtureStatus,
      ready: verification.ready,
      reason: verification.reason,
      afterInventory,
      chest,
      table,
      verification
    }
  }
}

function buildFixtureCommands(adapter, snapshot, scenario) {
  const commands = []
  const ai = adapter.aiUsername()
  for (const item of scenario.setup?.clear || []) {
    commands.push(`clear ${ai} minecraft:${item}`)
  }
  if (scenario.setup?.chestItems) {
    const pos = chestPositionFor(snapshot)
    commands.push(...clearNearbyContainersCommands(pos))
    commands.push(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:stone`)
    commands.push(`setblock ${pos.x} ${pos.y + 1} ${pos.z} minecraft:air`)
    commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:chest`)
    for (const entry of scenario.setup.chestItems) {
      commands.push(`item replace block ${pos.x} ${pos.y} ${pos.z} container.${entry.slot || 0} with minecraft:${entry.item} ${entry.count}`)
    }
  } else if (scenario.id === 'missing-material-negative') {
    const pos = chestPositionFor(snapshot)
    commands.push(...clearNearbyContainersCommands(pos))
  }
  if (scenario.setup?.clearContainers && !scenario.setup?.chestItems) {
    const pos = chestPositionFor(snapshot)
    commands.push(...clearNearbyContainersCommands(pos, scenario.setup.clearContainerRadius || 4))
  }
  if (scenario.setup?.clearCraftingTables && !scenario.setup?.placeCraftingTable) {
    const pos = craftingTablePositionFor(snapshot)
    commands.push(...clearNearbyCraftingTablesCommands(pos, scenario.setup.clearCraftingTableRadius || 8))
  }
  if (scenario.setup?.placeCraftingTable) {
    const pos = craftingTablePositionFor(snapshot)
    commands.push(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:stone`)
    commands.push(`setblock ${pos.x} ${pos.y + 1} ${pos.z} minecraft:air`)
    commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:crafting_table`)
  }
  for (const entry of scenario.setup?.give || []) {
    commands.push(`give ${ai} minecraft:${entry.item} ${entry.count}`)
  }
  return commands
}

function clearNearbyContainersCommands(pos, radius = 4) {
  const minX = pos.x - radius
  const maxX = pos.x + radius
  const minZ = pos.z - radius
  const maxZ = pos.z + radius
  return [
    `fill ${minX} ${pos.y - 2} ${minZ} ${maxX} ${pos.y + 3} ${maxZ} minecraft:air replace minecraft:chest`,
    `fill ${minX} ${pos.y - 2} ${minZ} ${maxX} ${pos.y + 3} ${maxZ} minecraft:air replace minecraft:trapped_chest`,
    `fill ${minX} ${pos.y - 2} ${minZ} ${maxX} ${pos.y + 3} ${maxZ} minecraft:air replace minecraft:barrel`
  ]
}

function clearNearbyCraftingTablesCommands(pos, radius = 8) {
  const minX = pos.x - radius
  const maxX = pos.x + radius
  const minZ = pos.z - radius
  const maxZ = pos.z + radius
  return [
    `fill ${minX} ${pos.y - 2} ${minZ} ${maxX} ${pos.y + 3} ${maxZ} minecraft:air replace minecraft:crafting_table`
  ]
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

function verifyFixture({ scenario, inventory, chest, table }) {
  if (!inventory) return { ready: false, reason: 'inventory_debug_unavailable' }
  const givenItems = new Set((scenario.setup?.give || []).map(entry => entry.item))
  for (const item of scenario.setup?.clear || []) {
    if (givenItems.has(item)) continue
    if (itemCount(inventory, item) > 0) return { ready: false, reason: `inventory_clear_failed:${item}` }
  }
  for (const entry of scenario.setup?.give || []) {
    if (itemCount(inventory, entry.item) < entry.count) return { ready: false, reason: `inventory_give_failed:${entry.item}` }
  }
  if (scenario.setup?.chestItems) {
    if (!chest?.ok) return { ready: false, reason: `chest_not_openable:${chest?.error || 'unknown'}` }
    for (const entry of scenario.setup.chestItems) {
      if ((chest.counts?.[entry.item] || 0) < entry.count) {
        return { ready: false, reason: `chest_item_missing:${entry.item}` }
      }
    }
  }
  if (scenario.setup?.placeCraftingTable && table?.blockName !== 'crafting_table') {
    return { ready: false, reason: `crafting_table_fixture_missing:${table?.blockName || 'none'}` }
  }
  return { ready: true, reason: 'fixture_ready' }
}

async function runCraftingScenario({ adapter, config, setup, scenario }) {
  const commandCursor = adapter.createLogCursor()
  const preState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const beforeInventory = inventorySummary(preState)
  const beforeChest = scenario.setup?.chestItems
    ? await adapter.observeContainerAt(chestPositionFor(setup.snapshot || preState), `before_${scenario.id}_chest_timeout`).catch(err => ({
      ok: false,
      error: err.message,
      counts: {},
      position: chestPositionFor(setup.snapshot || preState)
    }))
    : null

  await adapter.sendCommand(scenario.command, { afterMs: 250 })
  const terminalLogs = await waitForScenarioTerminal(adapter, scenario, commandCursor, config)
  await adapter.wait(isMissingMaterialScenario(scenario) ? 2800 : 1200)
  const postState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const afterInventory = inventorySummary(postState)
  const afterChest = scenario.setup?.chestItems
    ? await adapter.observeContainerAt(chestPositionFor(setup.snapshot || preState), `after_${scenario.id}_chest_timeout`).catch(err => ({
      ok: false,
      error: err.message,
      counts: {},
      position: chestPositionFor(setup.snapshot || preState)
    }))
    : null
  const logs = adapter.readLogsSince(commandCursor)
  const assertion = scenario.assert({
    scenario,
    logs,
    terminalLogs,
    preState,
    postState,
    beforeInventory,
    afterInventory,
    beforeChest,
    afterChest
  })

  return {
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState,
    postState,
    observedBehavior: observedBehavior({ scenario, beforeInventory, afterInventory, beforeChest, afterChest, assertion }),
    expectedBehavior: scenario.expectedBehavior,
    actualResult: assertion.judgment === 'PASS' ? assertion.passReason : 'crafting_integration_failed',
    judgment: assertion.judgment,
    passOrFail: assertion.judgment,
    failureReason: assertion.failureReason,
    evidence: {
      scenarioId: scenario.id,
      beforeInventory,
      afterInventory,
      beforeChest,
      afterChest,
      itemDeltas: itemDeltas(beforeInventory, afterInventory, trackedItemsFor(scenario)),
      planSteps: extractPlanSteps(logs),
      planStepDetails: extractPlanStepDetails(logs),
      storageRequestedItems: storageRequestedItems(logs),
      assertion,
      setup: setup.fixtureStatus || {},
      taskSignals: postState.taskSignals
    },
    relatedLogs: logs.slice(-140),
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: assertion.judgment === 'PASS'
      ? 'Keep this crafting case in the full coverage suite.'
      : 'Inspect routing, storage dependency planning, task terminal logs, and inventory/container deltas for this crafting case.',
    ...environmentFields(adapter, postState, setup)
  }
}

async function waitForScenarioTerminal(adapter, scenario, cursor, config) {
  const timeout = scenario.timeoutMs || config.timeoutMs || 45000
  if (scenario.id === 'bread-make-bread-farming-route') {
    return adapter.waitForLog([
      /\[CRAFT_BREAD_TASK_SUCCESS\] mode=MAKE_BREAD/,
      /\[CRAFT_BREAD_TASK_FAILED\] mode=MAKE_BREAD/,
      /\[TaskManager\] completed #[0-9]+ farming/,
      /\[TaskManager\] failed #[0-9]+ farming/,
      /\[TaskManager\] failed #[0-9]+ craft_item/,
      /\[TaskManager\] completed #[0-9]+ craft_item/
    ], timeout, cursor)
  }

  const terminal = isMissingMaterialScenario(scenario)
    ? [
        /\[task-manager\] fail task=craft_item id=[0-9]+ reason=missing_materials:/,
        /\[FARMING_TASK_START\]/
      ]
    : [
        /\[TaskManager\] completed #[0-9]+ craft_item/,
        /\[TaskManager\] failed #[0-9]+ craft_item/,
        /\[FARMING_TASK_START\]/
      ]
  if (!isMissingMaterialScenario(scenario)) {
    terminal.push(/\[TaskManager\] failed #[0-9]+ storage/)
  }
  if (!['missing-material-negative', 'storage-assisted-log-to-stick', 'common-missing-iron-pickaxe-negative'].includes(scenario.id)) {
    terminal.push(/\[STORAGE_TASK_START\]/)
    terminal.push(/\[FARMING_TASK_START\]/)
  }
  return adapter.waitForLog(terminal, timeout, cursor)
}

function isMissingMaterialScenario(scenario) {
  return ['missing-material-negative', 'common-missing-iron-pickaxe-negative'].includes(scenario.id)
}

function assertInventoryOnly(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, ['stick', 'oak_planks'])
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    !common.taskFailed &&
    !common.storageTriggered &&
    !common.farmingTriggered &&
    (deltas.stick?.delta || 0) > 0
  return assertion(pass, 'inventory_only_2x2_crafting_verified', {
    ...common,
    deltas
  }, inventoryPositiveFailure({ ...common, stickDelta: deltas.stick?.delta || 0 }))
}

function assertInventoryChained(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, ['stick', 'oak_log', 'oak_planks'])
  const planSteps = extractPlanSteps(ctx.logs)
  const storageItems = storageRequestedItems(ctx.logs)
  const hasPlankStep = planSteps.includes('oak_planks')
  const hasStickStep = planSteps.includes('stick')
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    !common.taskFailed &&
    !common.storageTriggered &&
    !common.farmingTriggered &&
    hasPlankStep &&
    hasStickStep &&
    (deltas.stick?.delta || 0) > 0 &&
    (deltas.oak_log?.delta || 0) < 0 &&
    (deltas.oak_planks?.after || 0) > 0 &&
    !storageItems.includes('oak_planks')
  return assertion(pass, 'inventory_chained_log_to_stick_verified', {
    ...common,
    deltas,
    planSteps,
    storageItems,
    hasPlankStep,
    hasStickStep
  }, chainedFailure({ ...common, deltas, hasPlankStep, hasStickStep, storageItems }))
}

function assertStorageAssisted(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, ['stick', 'oak_log', 'oak_planks'])
  const planSteps = extractPlanSteps(ctx.logs)
  const storageItems = storageRequestedItems(ctx.logs)
  const beforeChestOakLog = ctx.beforeChest?.counts?.oak_log || 0
  const afterChestOakLog = ctx.afterChest?.counts?.oak_log || 0
  const chestDelta = afterChestOakLog - beforeChestOakLog
  const storagePulledBase = storageItems.includes('oak_log') || chestDelta < 0
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    (!common.taskFailed || common.storageFetchDeferred) &&
    common.storageTriggered &&
    !common.farmingTriggered &&
    storagePulledBase &&
    !storageItems.includes('oak_planks') &&
    planSteps.includes('oak_planks') &&
    planSteps.includes('stick') &&
    (deltas.stick?.delta || 0) > 0
  return assertion(pass, 'storage_assisted_crafting_verified', {
    ...common,
    deltas,
    planSteps,
    storageItems,
    beforeChestOakLog,
    afterChestOakLog,
    chestDelta,
    storagePulledBase
  }, storageAssistedFailure({ ...common, deltas, planSteps, storageItems, storagePulledBase }))
}

function assertCountedStick(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, ['stick', 'oak_planks'])
  const planSteps = extractPlanSteps(ctx.logs)
  const requestedCount = ctx.scenario.expect?.requestedCount || 1
  const minTargetDelta = ctx.scenario.expect?.minTargetDelta || requestedCount
  const requestedCountObserved = taskParamObserved(ctx.logs, 'count', requestedCount)
  const targetDelta = deltas.stick?.delta || 0
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    !common.taskFailed &&
    !common.storageTriggered &&
    !common.farmingTriggered &&
    requestedCountObserved &&
    planSteps.includes('stick') &&
    targetDelta >= minTargetDelta

  return assertion(pass, ctx.scenario.expect?.passReason || 'counted_stick_verified', {
    ...common,
    deltas,
    planSteps,
    requestedCount,
    minTargetDelta,
    requestedCountObserved,
    targetDelta
  }, countedStickFailure({
    ...common,
    planSteps,
    requestedCountObserved,
    targetDelta,
    minTargetDelta
  }))
}

function assertMaxPossibleCraft(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, trackedItemsFor(ctx.scenario))
  const planSteps = extractPlanSteps(ctx.logs)
  const planStepDetails = extractPlanStepDetails(ctx.logs)
  const storageItems = storageRequestedItems(ctx.logs)
  const target = ctx.scenario.targetItem
  const targetDelta = deltas[target]?.delta || 0
  const expectedDelta = ctx.scenario.expect?.targetDelta
  const craftModeObserved = taskParamObserved(ctx.logs, 'craftMode', ctx.scenario.expect?.craftMode || 'max_possible')
  const expectedSteps = ctx.scenario.expect?.planSteps || [target]
  const hasExpectedSteps = expectedSteps.every(item => planSteps.includes(item))
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    !common.taskFailed &&
    !common.storageTriggered &&
    !common.farmingTriggered &&
    craftModeObserved &&
    hasExpectedSteps &&
    targetDelta === expectedDelta

  return assertion(pass, ctx.scenario.expect?.passReason || `${target}_max_possible_verified`, {
    ...common,
    deltas,
    planSteps,
    planStepDetails,
    storageItems,
    targetDelta,
    expectedDelta,
    craftModeObserved,
    hasExpectedSteps
  }, maxPossibleFailure({
    ...common,
    target,
    targetDelta,
    expectedDelta,
    craftModeObserved,
    hasExpectedSteps
  }))
}

function assertInventoryWorkbenchPlacement(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, trackedItemsFor(ctx.scenario))
  const planSteps = extractPlanSteps(ctx.logs)
  const planStepDetails = extractPlanStepDetails(ctx.logs)
  const target = ctx.scenario.targetItem
  const targetStep = [...planStepDetails].reverse().find(step => step.item === target)
  const targetDelta = deltas[target]?.delta || 0
  const tableDelta = deltas.crafting_table?.delta || 0
  const expectedSteps = ctx.scenario.expect?.planSteps || [target]
  const hasExpectedSteps = expectedSteps.every(item => planSteps.includes(item))
  const tableExpectationOk = Boolean(targetStep?.needsCraftingTable) === true
  const tableConsumed = tableDelta < 0
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    !common.taskFailed &&
    !common.storageTriggered &&
    !common.farmingTriggered &&
    hasExpectedSteps &&
    tableExpectationOk &&
    tableConsumed &&
    targetDelta > 0

  return assertion(pass, ctx.scenario.expect?.passReason || 'inventory_workbench_placement_verified', {
    ...common,
    deltas,
    planSteps,
    planStepDetails,
    targetDelta,
    tableDelta,
    targetStep,
    hasExpectedSteps,
    tableExpectationOk,
    tableConsumed
  }, inventoryWorkbenchFailure({
    ...common,
    target,
    targetDelta,
    hasExpectedSteps,
    tableExpectationOk,
    tableConsumed
  }))
}

function assertMissingMaterialNegative(ctx) {
  const common = commonSignals(ctx)
  const status = ctx.postState.debugStatus?.status || {}
  const idle = !status.currentTask && !status.taskType && !status.taskStatus
  const failureCode = status.failureCode || null
  const clearFailure = common.taskFailed ||
    /missing_materials|storage_fetch_needed|chest_item_not_found|no_recipe|craft_failed/i.test(String(failureCode || ''))
  const pass = common.intentOk &&
    common.taskStarted &&
    !common.craftingSuccess &&
    clearFailure &&
    !common.farmingTriggered &&
    idle
  return assertion(pass, 'missing_material_negative_verified', {
    ...common,
    idle,
    failureCode,
    clearFailure
  }, missingMaterialFailure({ ...common, idle, clearFailure, failureCode }))
}

function assertCommonCraftSuccess(ctx) {
  const common = commonSignals(ctx)
  const deltas = itemDeltas(ctx.beforeInventory, ctx.afterInventory, trackedItemsFor(ctx.scenario))
  const planSteps = extractPlanSteps(ctx.logs)
  const planStepDetails = extractPlanStepDetails(ctx.logs)
  const storageItems = storageRequestedItems(ctx.logs)
  const target = ctx.scenario.targetItem
  const targetStep = [...planStepDetails].reverse().find(step => step.item === target)
  const targetDelta = deltas[target]?.delta || 0
  const expectedSteps = ctx.scenario.expect?.planSteps || [target]
  const expectedNeedsTable = ctx.scenario.expect?.needsCraftingTable
  const hasExpectedSteps = expectedSteps.every(item => planSteps.includes(item))
  const tableExpectationOk = expectedNeedsTable == null ||
    Boolean(targetStep?.needsCraftingTable) === Boolean(expectedNeedsTable)
  const storageExpectationOk = ctx.scenario.expect?.storageTriggered === true
    ? common.storageTriggered
    : !common.storageTriggered
  const pass = common.intentOk &&
    common.taskStarted &&
    common.craftingSuccess &&
    !common.taskFailed &&
    !common.farmingTriggered &&
    storageExpectationOk &&
    hasExpectedSteps &&
    tableExpectationOk &&
    targetDelta > 0

  return assertion(pass, ctx.scenario.expect?.passReason || `${target}_crafting_verified`, {
    ...common,
    deltas,
    planSteps,
    planStepDetails,
    storageItems,
    targetDelta,
    targetStep,
    hasExpectedSteps,
    tableExpectationOk,
    storageExpectationOk
  }, commonCraftFailure({
    ...common,
    target,
    targetDelta,
    hasExpectedSteps,
    tableExpectationOk,
    storageExpectationOk
  }))
}

function assertCommonMissingMaterialNegative(ctx) {
  const common = commonSignals(ctx)
  const status = ctx.postState.debugStatus?.status || {}
  const idle = !status.currentTask && !status.taskType && !status.taskStatus
  const failureCode = status.failureCode || null
  const expectedMissing = ctx.scenario.expect?.missingItems || []
  const missingObserved = expectedMissing.every(item =>
    String(failureCode || '').includes(item) ||
    ctx.logs.some(line => line.includes(item) &&
      /missing_materials|storage_fetch_needed|chest_item_not_found|no_recipe|craft_failed/i.test(line)))
  const clearFailure = common.taskFailed ||
    /missing_materials|storage_fetch_needed|chest_item_not_found|no_recipe|craft_failed/i.test(String(failureCode || ''))
  const feedback = missingMaterialFeedback(ctx.logs, status)
  const humanReadableFeedbackObserved = ctx.scenario.expect?.humanReadableFeedback
    ? isHumanReadableMissingFeedback(feedback, expectedMissing)
    : true
  const pass = common.intentOk &&
    common.taskStarted &&
    !common.craftingSuccess &&
    clearFailure &&
    missingObserved &&
    humanReadableFeedbackObserved &&
    !common.farmingTriggered &&
    idle
  return assertion(pass, ctx.scenario.expect?.passReason || 'common_missing_material_negative_verified', {
    ...common,
    idle,
    failureCode,
    clearFailure,
    expectedMissing,
    missingObserved,
    feedback,
    humanReadableFeedbackObserved
  }, commonMissingFailure({ ...common, idle, clearFailure, failureCode, expectedMissing, missingObserved, humanReadableFeedbackObserved }))
}

function assertBreadMakeBreadRoute(ctx) {
  const logs = ctx.logs || []
  const intentOk = logs.some(line => line.includes('[INTENT_RESULT]') &&
    line.includes('actionKey=MAKE_BREAD') &&
    line.includes('intent=make_bread'))
  const farmingTaskStarted = logs.some(line => line.includes('[TASK_STARTED]') &&
    line.includes('"type":"farming"') &&
    line.includes('"mode":"MAKE_BREAD"'))
  const farmingStartObserved = logs.some(line =>
    (line.includes('[FARMING_TASK_START]') || line.includes('[CRAFT_BREAD_TASK_START]')) &&
    line.includes('mode=MAKE_BREAD'))
  const farmingBreadSuccess = logs.some(line =>
    line.includes('[CRAFT_BREAD_SUCCESS]') ||
    (line.includes('[CRAFT_BREAD_TASK_SUCCESS]') && line.includes('mode=MAKE_BREAD')) ||
    line.includes('[TaskManager] completed') && line.includes('farming'))
  const craftItemTaskStarted = logs.some(line => line.includes('[TASK_STARTED]') &&
    line.includes('"type":"craft_item"'))
  const craftItemIntentObserved = logs.some(line => line.includes('[INTENT_RESULT]') &&
    line.includes('actionKey=CRAFT_ITEM') &&
    line.includes('intent=craft_item'))
  const pass = intentOk &&
    farmingTaskStarted &&
    farmingStartObserved &&
    farmingBreadSuccess &&
    !craftItemTaskStarted &&
    !craftItemIntentObserved

  return assertion(pass, ctx.scenario.expect?.passReason || 'bread_make_bread_route_verified', {
    intentOk,
    farmingTaskStarted,
    farmingStartObserved,
    farmingBreadSuccess,
    craftItemTaskStarted,
    craftItemIntentObserved
  }, breadRouteFailure({
    intentOk,
    farmingTaskStarted,
    farmingStartObserved,
    farmingBreadSuccess,
    craftItemTaskStarted,
    craftItemIntentObserved
  }))
}

function commonSignals(ctx) {
  const logs = ctx.logs || []
  const target = ctx.scenario.targetItem
  const intentOk = logs.some(line => line.includes('[INTENT_RESULT]') &&
    line.includes('actionKey=CRAFT_ITEM') &&
    line.includes('intent=craft_item'))
  const taskStarted = logs.some(line => line.includes('[TASK_STARTED]') && line.includes('"type":"craft_item"'))
  const craftingSuccess = logs.some(line => new RegExp(`\\[crafting\\].*targetItem=${target}.*result=ok`).test(line)) ||
    logs.some(line => /\[TaskManager\] completed #[0-9]+ craft_item/.test(line)) ||
    Boolean(ctx.postState.taskSignals?.crafting?.taskSuccess)
  const taskFailed = logs.some(line => /\[TaskManager\] failed #[0-9]+ craft_item/.test(line)) ||
    Boolean(ctx.postState.taskSignals?.crafting?.taskFailure)
  const storageFetchDeferred = logs.some(line => line.includes('storage_fetch_needed'))
  const storageTriggered = logs.some(line => line.includes('[STORAGE_TASK_START]') || line.includes('"type":"storage"'))
  const farmingTriggered = logs.some(line => line.includes('[FARMING_TASK_START]') || line.includes('"type":"farming"'))
  return { intentOk, taskStarted, craftingSuccess, taskFailed, storageFetchDeferred, storageTriggered, farmingTriggered }
}

function assertion(pass, passReason, details, failureReason) {
  return {
    judgment: pass ? 'PASS' : 'FAIL',
    passReason,
    failureReason: pass ? null : failureReason,
    ...details
  }
}

function inventoryPositiveFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.storageTriggered) return 'storage_task_triggered'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (state.taskFailed && !state.storageFetchDeferred) return 'craft_item_task_failed'
  if (!state.craftingSuccess) return 'crafting_terminal_success_not_observed'
  if (state.stickDelta <= 0) return 'stick_count_did_not_increase'
  return 'crafting_case_failed'
}

function chainedFailure(state) {
  const base = inventoryPositiveFailure({
    ...state,
    stickDelta: state.deltas.stick?.delta || 0
  })
  if (base !== 'crafting_case_failed') return base
  if (!state.hasPlankStep) return 'oak_planks_intermediate_step_not_observed'
  if (!state.hasStickStep) return 'stick_step_not_observed'
  if ((state.deltas.oak_log?.delta || 0) >= 0) return 'oak_log_not_consumed'
  if ((state.deltas.oak_planks?.after || 0) <= 0) return 'oak_planks_intermediate_not_observed_in_inventory_delta'
  if (state.storageItems.includes('oak_planks')) return 'plan_produced_oak_planks_requested_from_storage'
  return 'inventory_chained_crafting_failed'
}

function storageAssistedFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (!state.storageTriggered) return 'storage_not_triggered_for_missing_base_material'
  if (!state.storagePulledBase) return 'storage_base_material_not_withdrawn'
  if (state.storageItems.includes('oak_planks')) return 'plan_produced_oak_planks_requested_from_storage'
  if (!state.planSteps.includes('oak_planks')) return 'oak_planks_intermediate_step_not_observed'
  if (!state.planSteps.includes('stick')) return 'stick_step_not_observed'
  if (state.taskFailed) return 'craft_item_task_failed'
  if (!state.craftingSuccess) return 'crafting_terminal_success_not_observed'
  if ((state.deltas.stick?.delta || 0) <= 0) return 'stick_count_did_not_increase'
  return 'storage_assisted_crafting_failed'
}

function countedStickFailure(state) {
  const base = inventoryPositiveFailure({
    ...state,
    stickDelta: state.targetDelta || 0
  })
  if (base !== 'crafting_case_failed') return base
  if (!state.requestedCountObserved) return 'requested_count_not_observed_in_task_params'
  if (!state.planSteps.includes('stick')) return 'stick_step_not_observed'
  if (state.targetDelta < state.minTargetDelta) return 'stick_count_below_requested_count'
  return 'counted_stick_crafting_failed'
}

function maxPossibleFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (state.storageTriggered) return 'storage_task_triggered'
  if (state.taskFailed) return 'craft_item_task_failed'
  if (!state.craftingSuccess) return 'crafting_terminal_success_not_observed'
  if (!state.craftModeObserved) return 'max_possible_mode_not_observed'
  if (!state.hasExpectedSteps) return 'expected_plan_steps_not_observed'
  if (state.targetDelta !== state.expectedDelta) return `${state.target}_max_possible_delta_mismatch`
  return 'max_possible_crafting_failed'
}

function inventoryWorkbenchFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (state.storageTriggered) return 'storage_task_triggered'
  if (state.taskFailed) return 'craft_item_task_failed'
  if (!state.craftingSuccess) return 'crafting_terminal_success_not_observed'
  if (!state.hasExpectedSteps) return 'expected_plan_steps_not_observed'
  if (!state.tableExpectationOk) return 'crafting_table_requirement_not_observed'
  if (!state.tableConsumed) return 'inventory_crafting_table_not_consumed_or_placed'
  if (state.targetDelta <= 0) return `${state.target}_count_did_not_increase`
  return 'inventory_workbench_placement_failed'
}

function missingMaterialFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (state.craftingSuccess) return 'missing_material_craft_succeeded_unexpectedly'
  if (!state.clearFailure) return 'missing_material_failure_not_clear'
  if (!state.idle) return 'task_loop_not_idle_after_missing_material'
  return `missing_material_negative_failed:${state.failureCode || 'unknown'}`
}

function commonCraftFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (!state.storageExpectationOk) return 'unexpected_storage_task_triggered'
  if (state.taskFailed) return 'craft_item_task_failed'
  if (!state.craftingSuccess) return 'crafting_terminal_success_not_observed'
  if (!state.hasExpectedSteps) return 'expected_plan_steps_not_observed'
  if (!state.tableExpectationOk) return 'crafting_table_requirement_not_observed'
  if (state.targetDelta <= 0) return `${state.target}_count_did_not_increase`
  return 'common_crafting_case_failed'
}

function commonMissingFailure(state) {
  if (!state.intentOk) return 'crafting_intent_not_observed'
  if (!state.taskStarted) return 'craft_item_task_not_started'
  if (state.farmingTriggered) return 'farming_task_triggered'
  if (state.craftingSuccess) return 'missing_material_craft_succeeded_unexpectedly'
  if (!state.clearFailure) return 'missing_material_failure_not_clear'
  if (!state.missingObserved) return `expected_missing_material_not_observed:${(state.expectedMissing || []).join(',')}`
  if (!state.humanReadableFeedbackObserved) return 'missing_material_feedback_not_human_readable'
  if (!state.idle) return 'task_loop_not_idle_after_missing_material'
  return `common_missing_material_negative_failed:${state.failureCode || 'unknown'}`
}

function breadRouteFailure(state) {
  if (!state.intentOk) return 'make_bread_intent_not_observed'
  if (state.craftItemIntentObserved) return 'make_bread_misrouted_to_craft_item_intent'
  if (state.craftItemTaskStarted) return 'make_bread_started_craft_item_task'
  if (!state.farmingTaskStarted) return 'make_bread_farming_task_not_started'
  if (!state.farmingStartObserved) return 'make_bread_farming_start_not_observed'
  if (!state.farmingBreadSuccess) return 'make_bread_farming_success_not_observed'
  return 'bread_make_bread_route_failed'
}

function taskParamObserved(logs = [], key, expectedValue) {
  const needle = `"${key}":${JSON.stringify(expectedValue)}`
  return logs.some(line => line.includes(needle))
}

function missingMaterialFeedback(logs = [], status = {}) {
  const messages = chatMessagesFromLogs(logs)
  const nonDebug = messages.filter(message => !String(message).startsWith('debug_status_ready'))
  if (nonDebug.length > 0) return nonDebug[nonDebug.length - 1]
  return status.lastChatReply || ''
}

function chatMessagesFromLogs(logs = []) {
  const messages = []
  for (const line of logs) {
    if (!line.includes('[CHAT_IGNORED]') || !line.includes('"username":"LinXia"')) continue
    const match = line.match(/"message":"((?:\\.|[^"\\])*)"/)
    if (!match) continue
    try {
      messages.push(JSON.parse(`"${match[1]}"`))
    } catch {
      messages.push(match[1])
    }
  }
  return messages
}

function isHumanReadableMissingFeedback(feedback, expectedMissing = []) {
  const text = String(feedback || '').trim()
  if (!text) return false
  if (/^(missing_materials|no_recipe|craft_failed|storage_fetch_needed):/i.test(text)) return false
  const mentionsExpected = expectedMissing.length === 0 ||
    expectedMissing.some(item => text.includes(item)) ||
    (expectedMissing.includes('iron_ingot') && /铁锭|鐵錠|铁|鐵/i.test(text))
  const hasHumanText = /缺|没有|沒有|不够|不夠|还差|還差|need|missing/i.test(text)
  return mentionsExpected && hasHumanText
}

function observedBehavior({ scenario, beforeInventory, afterInventory, beforeChest, afterChest, assertion }) {
  return [
    `scenario=${scenario.id}`,
    `beforeInventory=${JSON.stringify(beforeInventory)}`,
    `afterInventory=${JSON.stringify(afterInventory)}`,
    beforeChest ? `beforeChest=${JSON.stringify(beforeChest.counts || {})}` : null,
    afterChest ? `afterChest=${JSON.stringify(afterChest.counts || {})}` : null,
    `assertion=${JSON.stringify(assertion)}`
  ].filter(Boolean).join('; ')
}

function extractPlanSteps(logs = []) {
  return extractPlanStepDetails(logs).map(step => step.item).filter(Boolean)
}

function extractPlanStepDetails(logs = []) {
  const line = logs.find(line => line.includes('[crafting]') && line.includes('result=planned'))
  if (!line) return []
  const match = line.match(/recursivePlan=(\[.*?\]) missingMaterials=/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    return parsed.map(step => typeof step === 'string'
      ? { item: step, needsCraftingTable: null }
      : {
          item: step.item,
          count: step.count,
          needsCraftingTable: step.needsCraftingTable === true
        }).filter(step => step.item)
  } catch {
    return []
  }
}

function storageRequestedItems(logs = []) {
  const items = []
  for (const line of logs) {
    for (const match of line.matchAll(/"type":"storage","params":\{"mode":"TAKE_ITEMS","itemName":"([a-z0-9_]+)"/g)) {
      items.push(match[1])
    }
    const fetchMatch = line.match(/\[CraftTask\] fetching from storage: ([^\]]+)$/)
    if (fetchMatch) {
      for (const part of fetchMatch[1].split(',')) {
        const item = part.trim().split(':')[0]
        if (item) items.push(item)
      }
    }
  }
  return [...new Set(items)]
}

function itemDeltas(beforeInventory, afterInventory, names) {
  const out = {}
  for (const name of names) {
    const before = itemCount(beforeInventory, name)
    const after = itemCount(afterInventory, name)
    out[name] = { before, after, delta: after - before }
  }
  return out
}

function trackedItemsFor(scenario) {
  const items = new Set(COMMON_TRACKED_ITEMS)
  if (scenario?.targetItem) items.add(scenario.targetItem)
  for (const item of scenario?.setup?.clear || []) items.add(item)
  for (const entry of scenario?.setup?.give || []) items.add(entry.item)
  for (const entry of scenario?.setup?.chestItems || []) items.add(entry.item)
  return [...items]
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

function chestPositionFor(snapshot = {}) {
  const anchor = snapshot.companionPosition || snapshot.aiPosition || snapshot.acceptancePlayerPosition || snapshot.playerPosition || { x: 0, y: 64, z: 0 }
  return {
    x: Math.floor(Number(anchor.x)) + 2,
    y: Math.floor(Number(anchor.y)),
    z: Math.floor(Number(anchor.z))
  }
}

function craftingTablePositionFor(snapshot = {}) {
  const anchor = snapshot.companionPosition || snapshot.aiPosition || snapshot.acceptancePlayerPosition || snapshot.playerPosition || { x: 0, y: 64, z: 0 }
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
