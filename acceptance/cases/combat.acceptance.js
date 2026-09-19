const { blockedRecord, environmentFields } = require('./minecraft-case-utils')

const FEATURE = 'combat'
const ATTACK_COMMAND = '\u6253\u50f5\u5c38'
const WEAPON_ITEMS = [
  'wooden_sword',
  'stone_sword',
  'iron_sword',
  'diamond_sword',
  'netherite_sword',
  'golden_sword',
  'wooden_axe',
  'stone_axe',
  'iron_axe',
  'diamond_axe',
  'netherite_axe',
  'golden_axe',
  'bow',
  'crossbow',
  'trident'
]

const SCENARIOS = [
  {
    id: 'weapon-auto-equip-sword',
    testName: 'combat auto-equips sword before attacking zombie',
    command: ATTACK_COMMAND,
    targetMob: 'zombie',
    expectedWeapon: 'stone_sword',
    setup: {
      clear: WEAPON_ITEMS,
      give: [{ item: 'stone_sword', count: 1 }]
    },
    timeoutMs: 45000,
    expectedBehavior: 'When LinXia has a sword and is ordered to attack a nearby zombie, the real combat path should equip the sword before attack, avoid bare-hand fallback, and complete without weapon/tool failure.',
    regressionRisk: 'Combat can pass unit tests while the real command path attacks with the wrong held item or falls back to bare hand.',
    assert: assertWeaponAutoEquip
  },
  {
    id: 'no-weapon-bare-hand-fallback',
    testName: 'combat bare-hand fallback when no weapon is available',
    command: ATTACK_COMMAND,
    targetMob: 'zombie',
    expectedWeapon: 'hand',
    setup: {
      clear: WEAPON_ITEMS
    },
    timeoutMs: 45000,
    expectedBehavior: 'When LinXia has no sword, axe, bow, crossbow, or trident and is ordered to attack a nearby zombie, the real combat path should attack with bare-hand fallback instead of failing for missing weapon/tool.',
    regressionRisk: 'Combat can regress by treating missing weapons as a fatal task failure instead of allowing bare-hand fallback.',
    assert: assertBareHandFallback
  }
]

module.exports = {
  featureName: FEATURE,
  testName: 'combat real Minecraft auto weapon suite',
  commandOrInput: 'combat real Minecraft auto weapon suite',

  async run({ adapter, projectConfig, createRecord }) {
    const config = projectConfig.minecraft.combat || {}
    const records = []

    for (const scenario of SCENARIOS) {
      console.log(`[combat-acceptance] start scenario=${scenario.id}`)
      const cursor = adapter.createLogCursor()
      await adapter.sendCommand('\u505c\u6b62\u4efb\u52a1', { afterMs: 900 })
      const setup = await prepareCombatScenario(adapter, config, scenario, cursor)
      if (setup.setupStatus !== 'READY') {
        records.push(createRecord(blockedRecord({
          adapter,
          featureName: FEATURE,
          testName: scenario.testName,
          commandOrInput: scenario.command,
          setup,
          expectedBehavior: scenario.expectedBehavior,
          regressionRisk: scenario.regressionRisk,
          nextSuggestion: 'Ensure LinXia is online, debug_status works, command fixtures are allowed, and a zombie can be summoned near the bot.'
        })))
        console.log(`[combat-acceptance] blocked scenario=${scenario.id} reason=${setup.setupFailureReason}`)
        continue
      }

      records.push(createRecord(await runCombatScenario({ adapter, config, setup, scenario })))
      await cleanupScenario(adapter)
      console.log(`[combat-acceptance] done scenario=${scenario.id}`)
    }

    return records
  }
}

async function prepareCombatScenario(adapter, config, scenario, cursor) {
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
    commands: []
  }

  if (alignment.commandDenied) {
    return blockedSetup('alignment_command_denied', baseSnapshot, fixtureStatus)
  }

  if (!baseSnapshot.configuredAiOnline || !baseSnapshot.debugStatusAvailable) {
    return blockedSetup(!baseSnapshot.configuredAiOnline ? 'configured_ai_not_online' : 'debug_status_unavailable', baseSnapshot, fixtureStatus)
  }

  const commands = buildInventoryFixtureCommands(adapter, scenario)
  const commandResult = await runFixtureCommands(adapter, commands)
  fixtureStatus.commands = commandResult.commands
  fixtureStatus.commandDenied = commandResult.commandDenied
  fixtureStatus.deniedMessage = commandResult.deniedMessage

  if (commandResult.commandDenied) {
    return blockedSetup('command_denied', baseSnapshot, { ...fixtureStatus, reason: 'command_denied' })
  }

  await adapter.wait(1000)
  const after = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const afterInventory = inventorySummary(after)
  const verification = verifyInventoryFixture({ scenario, inventory: afterInventory })

  return {
    setupStatus: verification.ready ? 'READY' : 'BLOCKED',
    setupFailureReason: verification.ready ? null : verification.reason,
    snapshot: after,
    fixtureStatus: {
      ...fixtureStatus,
      ready: verification.ready,
      reason: verification.reason,
      afterInventory,
      verification
    }
  }
}

async function runCombatScenario({ adapter, config, setup, scenario }) {
  const commandCursor = adapter.createLogCursor()
  const targetPosition = targetMobPositionFor(setup.snapshot)
  const spawn = await spawnTargetMob(adapter, targetPosition, scenario.targetMob)
  await adapter.wait(250)

  const preState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const beforeInventory = inventorySummary(preState)
  const targetBefore = findTargetMob(adapter, scenario.targetMob, targetPosition, config.scanRadius || 16)

  if (spawn.commandDenied || !targetBefore) {
    return combatFixtureBlockedRecord({
      adapter,
      config,
      setup,
      scenario,
      preState,
      beforeInventory,
      spawn,
      targetBefore,
      reason: spawn.commandDenied ? 'target_mob_command_denied' : 'target_mob_fixture_missing'
    })
  }

  await adapter.sendCommand(scenario.command, { afterMs: 250 })
  const terminalLogs = await waitForScenarioTerminal(adapter, scenario, commandCursor, config)
  await adapter.wait(1800)

  const postState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 16,
    includeDebugStatus: true
  })
  const afterInventory = inventorySummary(postState)
  const targetAfter = findTargetMob(adapter, scenario.targetMob, targetPosition, config.scanRadius || 16)
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
    spawn
  })

  return {
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState,
    postState,
    observedBehavior: assertion.judgment === 'PASS' ? assertion.passReason : 'combat_auto_weapon_real_game_failed',
    expectedBehavior: scenario.expectedBehavior,
    actualResult: assertion.judgment === 'PASS' ? assertion.passReason : 'combat_auto_weapon_real_game_failed',
    judgment: assertion.judgment,
    passOrFail: assertion.judgment,
    failureReason: assertion.failureReason,
    evidence: {
      scenarioId: scenario.id,
      beforeInventory,
      afterInventory,
      targetBefore,
      targetAfter,
      itemDeltas: itemDeltas(beforeInventory, afterInventory, trackedItemsFor(scenario)),
      combatSignals: combatSignals(logs),
      equipmentSignals: equipmentSignals(logs),
      autoPrepSignals: autoPrepSignals(logs),
      assertion,
      setup: setup.fixtureStatus || {},
      spawn,
      taskSignals: postState.taskSignals
    },
    relatedLogs: logs.slice(-160),
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: assertion.judgment === 'PASS'
      ? 'Keep this combat real-game acceptance slice as the minimum guard for weapon selection.'
      : 'Inspect command routing, guard_player task start, CombatSystem attack logs, ensureCombatWeapon logs, and ActionLock state.',
    ...environmentFields(adapter, postState, setup)
  }
}

function buildInventoryFixtureCommands(adapter, scenario) {
  const ai = adapter.aiUsername()
  const commands = [
    `execute at ${ai} run kill @e[type=minecraft:zombie,distance=..48]`,
    `execute at ${ai} run kill @e[type=minecraft:item,distance=..48]`
  ]

  for (const item of scenario.setup?.clear || []) {
    commands.push(`clear ${ai} minecraft:${item}`)
  }

  for (const entry of scenario.setup?.give || []) {
    commands.push(`give ${ai} minecraft:${entry.item} ${entry.count}`)
  }

  return commands
}

async function spawnTargetMob(adapter, position, mobName) {
  const commands = [
    'difficulty easy',
    `setblock ${position.x} ${position.y - 1} ${position.z} minecraft:stone`,
    `setblock ${position.x} ${position.y} ${position.z} minecraft:air`,
    `setblock ${position.x} ${position.y + 1} ${position.z} minecraft:air`,
    `summon minecraft:${mobName} ${position.x + 0.5} ${position.y} ${position.z + 0.5} {Tags:["combat_acceptance"],NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:20f}`
  ]
  const result = await runFixtureCommands(adapter, commands)
  return {
    targetMob: mobName,
    targetPosition: position,
    commands: result.commands,
    commandDenied: result.commandDenied,
    deniedMessage: result.deniedMessage
  }
}

function combatFixtureBlockedRecord({ adapter, config, setup, scenario, preState, beforeInventory, spawn, targetBefore, reason }) {
  const logs = adapter.readLogsSince(preState.logCursor || 0)
  const blockedSetup = {
    setupStatus: 'BLOCKED',
    setupFailureReason: reason,
    snapshot: preState,
    fixtureStatus: {
      ...(setup.fixtureStatus || {}),
      ready: false,
      reason,
      spawn,
      targetBefore
    }
  }
  return {
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState,
    postState: preState,
    observedBehavior: `Combat target fixture blocked: ${reason}.`,
    expectedBehavior: scenario.expectedBehavior,
    actualResult: 'environment_blocked',
    judgment: 'BLOCKED',
    passOrFail: 'BLOCKED',
    failureReason: null,
    evidence: {
      scenarioId: scenario.id,
      beforeInventory,
      spawn,
      targetBefore,
      setup: blockedSetup.fixtureStatus,
      nearbyEntities: preState.nearbyEntitiesSummary || preState.nearbyEntities || []
    },
    relatedLogs: logs.slice(-80),
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: 'Confirm the server is not peaceful, command fixtures can summon hostile mobs, and the acceptance player can observe spawned entities near LinXia.',
    ...environmentFields(adapter, preState, blockedSetup)
  }
}

async function cleanupScenario(adapter) {
  await adapter.runServerCommand(`execute at ${adapter.aiUsername()} run kill @e[type=minecraft:zombie,distance=..48]`).catch(() => {})
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

async function waitForScenarioTerminal(adapter, scenario, cursor, config) {
  const timeout = scenario.timeoutMs || config.timeoutMs || 45000
  return adapter.waitForLog([
    /\[combat\] target=zombie .* action=attack result=ok/,
    /\[TaskManager\] completed #[0-9]+ guard_player/,
    /\[TaskManager\] failed #[0-9]+ guard_player/
  ], timeout, cursor)
}

function verifyInventoryFixture({ scenario, inventory }) {
  if (!inventory) return { ready: false, reason: 'inventory_debug_unavailable' }
  const givenItems = new Set((scenario.setup?.give || []).map(entry => entry.item))
  for (const item of scenario.setup?.clear || []) {
    if (givenItems.has(item)) continue
    if (itemCount(inventory, item) > 0) return { ready: false, reason: `inventory_clear_failed:${item}` }
  }
  for (const entry of scenario.setup?.give || []) {
    if (itemCount(inventory, entry.item) < entry.count) return { ready: false, reason: `inventory_give_failed:${entry.item}` }
  }
  return { ready: true, reason: 'fixture_ready' }
}

function assertWeaponAutoEquip(ctx) {
  const common = commonSignals(ctx)
  const expected = ctx.scenario.expectedWeapon
  const expectedEquipped = ctx.logs.some(line =>
    line.includes('[auto-prep] target=weapon') &&
    line.includes('result=equipped') &&
    line.includes(`item=${expected}`)
  )
  const equipmentSelected = ctx.logs.some(line =>
    line.includes('[equipment] request=combat') &&
    line.includes(`selected=${expected}`) &&
    line.includes('error=none')
  )
  const combatSelected = ctx.logs.some(line =>
    line.includes('[combat] target=zombie') &&
    line.includes(`selectedWeapon=${expected}`) &&
    line.includes('action=attack') &&
    line.includes('result=ok')
  )
  const noBareHand = !ctx.logs.some(line =>
    line.includes('[equipment] request=combat') &&
    (line.includes('selected=hand') || line.includes('bare_hand_fallback'))
  )
  const pass = common.intentOk &&
    common.guardTaskStarted &&
    common.targetPresentBefore &&
    expectedEquipped &&
    equipmentSelected &&
    combatSelected &&
    noBareHand &&
    !common.taskFailed &&
    !common.fatalWeaponOrToolFailure

  return assertion(pass, 'combat_weapon_auto_equip_verified', {
    ...common,
    expectedEquipped,
    equipmentSelected,
    combatSelected,
    noBareHand,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'combat_intent_not_observed'],
      [!common.guardTaskStarted, 'guard_player_task_not_started'],
      [!common.targetPresentBefore, 'zombie_fixture_not_observed'],
      [!expectedEquipped, `expected_weapon_not_auto_equipped:${expected}`],
      [!equipmentSelected, `combat_equipment_log_missing:${expected}`],
      [!combatSelected, `combat_attack_not_using_expected_weapon:${expected}`],
      [!noBareHand, 'unexpected_bare_hand_fallback'],
      [common.taskFailed, 'guard_player_task_failed'],
      [common.fatalWeaponOrToolFailure, 'fatal_weapon_or_tool_failure_logged']
    ])
  })
}

function assertBareHandFallback(ctx) {
  const common = commonSignals(ctx)
  const fallbackLogged = ctx.logs.some(line =>
    line.includes('[auto-prep] target=weapon') &&
    line.includes('result=bare_hand_fallback')
  )
  const equipmentSelectedHand = ctx.logs.some(line =>
    line.includes('[equipment] request=combat') &&
    line.includes('selected=hand') &&
    line.includes('fallback=bare_hand') &&
    line.includes('error=none')
  )
  const combatSelectedHand = ctx.logs.some(line =>
    line.includes('[combat] target=zombie') &&
    line.includes('selectedWeapon=hand') &&
    line.includes('action=attack') &&
    line.includes('result=ok')
  )
  const noWeaponRemaining = WEAPON_ITEMS.every(item => itemCount(ctx.afterInventory, item) === 0)
  const pass = common.intentOk &&
    common.guardTaskStarted &&
    common.targetPresentBefore &&
    fallbackLogged &&
    equipmentSelectedHand &&
    combatSelectedHand &&
    noWeaponRemaining &&
    !common.taskFailed &&
    !common.fatalWeaponOrToolFailure

  return assertion(pass, 'combat_bare_hand_fallback_verified', {
    ...common,
    fallbackLogged,
    equipmentSelectedHand,
    combatSelectedHand,
    noWeaponRemaining,
    failureReason: pass ? null : failureReason([
      [!common.intentOk, 'combat_intent_not_observed'],
      [!common.guardTaskStarted, 'guard_player_task_not_started'],
      [!common.targetPresentBefore, 'zombie_fixture_not_observed'],
      [!fallbackLogged, 'bare_hand_fallback_not_logged'],
      [!equipmentSelectedHand, 'combat_equipment_hand_log_missing'],
      [!combatSelectedHand, 'combat_attack_not_using_hand'],
      [!noWeaponRemaining, 'weapon_present_despite_no_weapon_fixture'],
      [common.taskFailed, 'guard_player_task_failed'],
      [common.fatalWeaponOrToolFailure, 'fatal_weapon_or_tool_failure_logged']
    ])
  })
}

function commonSignals(ctx) {
  const logs = ctx.logs || []
  const fatalFailureLines = logs.filter(line =>
    !line.includes('result=bare_hand_fallback') &&
    !line.includes('reason=bare_hand_fallback') &&
    /missing_weapon|wrong_tool_type|missing_tool/.test(line) &&
    (line.includes('[TaskManager] failed') ||
      line.includes('[combat]') ||
      line.includes('[equipment] request=combat') ||
      line.includes('weapon_preparation_failed'))
  )
  return {
    intentOk: logs.some(line => line.includes('[INTENT_RESULT]') &&
      line.includes('actionKey=ATTACK_HOSTILE') &&
      line.includes('intent=attack_hostile') &&
      line.includes('executed=true')),
    guardTaskStarted: logs.some(line =>
      (line.includes('[task-manager] start task=guard_player')) ||
      (line.includes('[TASK_STARTED]') && line.includes('"type":"guard_player"'))
    ),
    taskCompleted: logs.some(line => /\[TaskManager\] completed #[0-9]+ guard_player/.test(line)),
    taskFailed: logs.some(line => /\[TaskManager\] failed #[0-9]+ guard_player/.test(line)),
    combatAttackOk: logs.some(line => line.includes('[combat] target=zombie') &&
      line.includes('action=attack') &&
      line.includes('result=ok')),
    targetPresentBefore: Boolean(ctx.targetBefore),
    fatalWeaponOrToolFailure: fatalFailureLines.length > 0,
    fatalFailureLines
  }
}

function autoPrepSignals(logs = []) {
  return logs.filter(line => line.includes('[auto-prep] target=weapon'))
}

function equipmentSignals(logs = []) {
  return logs.filter(line => line.includes('[equipment] request=combat'))
}

function combatSignals(logs = []) {
  return logs.filter(line => line.includes('[combat]'))
}

function assertion(pass, passReason, details = {}) {
  return {
    judgment: pass ? 'PASS' : 'FAIL',
    passReason,
    failureReason: pass ? null : (details.failureReason || 'combat_acceptance_expectation_not_met'),
    ...details
  }
}

function failureReason(entries) {
  const failed = entries.find(([condition]) => condition)
  return failed ? failed[1] : 'combat_acceptance_expectation_not_met'
}

function blockedSetup(reason, snapshot, fixtureStatus) {
  return {
    setupStatus: 'BLOCKED',
    setupFailureReason: reason,
    snapshot,
    fixtureStatus: { ...fixtureStatus, reason }
  }
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
    ...WEAPON_ITEMS,
    scenario.expectedWeapon,
    ...(scenario.setup?.give || []).map(entry => entry.item)
  ].filter(Boolean)))
}

function targetMobPositionFor(snapshot = {}) {
  const anchor = snapshot.companionPosition || snapshot.aiPosition || snapshot.acceptancePlayerPosition || snapshot.playerPosition || { x: 0, y: 64, z: 0 }
  return {
    x: Math.floor(Number(anchor.x)) + 3,
    y: Math.floor(Number(anchor.y)),
    z: Math.floor(Number(anchor.z))
  }
}

function findTargetMob(adapter, mobName, position, radius = 16) {
  const center = {
    x: Number(position.x) + 0.5,
    y: Number(position.y),
    z: Number(position.z) + 0.5
  }
  const entities = Object.values(adapter.bot?.entities || {})
    .filter(entity => entity.name === mobName && entity.position)
    .map(entity => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      position: positionJson(entity.position),
      distanceToFixture: distance(positionJson(entity.position), center),
      distanceToAcceptancePlayer: adapter.bot?.entity?.position ? round(adapter.bot.entity.position.distanceTo(entity.position)) : null
    }))
    .filter(entity => entity.distanceToFixture == null || entity.distanceToFixture <= radius)
    .sort((a, b) => (a.distanceToFixture || 0) - (b.distanceToFixture || 0))
  return entities[0] || null
}

function positionJson(position) {
  if (!position) return null
  return { x: round(position.x), y: round(position.y), z: round(position.z) }
}

function distance(a, b) {
  if (!a || !b) return null
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  const dz = Number(a.z) - Number(b.z)
  return round(Math.sqrt(dx * dx + dy * dy + dz * dz))
}

function round(value) {
  return Math.round(Number(value) * 100) / 100
}
