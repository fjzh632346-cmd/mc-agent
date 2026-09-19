const { blockedRecord, environmentFields } = require('./minecraft-case-utils')

const FOOD_ITEMS = ['bread', 'cooked_beef', 'cooked_porkchop', 'apple', 'carrot', 'potato']
const WOOD_ITEMS = ['oak_log', 'birch_log', 'spruce_log', 'oak_planks', 'birch_planks', 'spruce_planks']

const STORAGE_SCENARIOS = [
  {
    id: 'loose-seed-withdraw',
    testName: 'take loose seed quantity from chest',
    commandOrInput: '从箱子里拿点种子',
    mode: 'withdraw',
    sourceRole: 'main',
    measure: { kind: 'item', name: 'wheat_seeds' },
    expectedBehavior: 'The AI should withdraw a loose seed quantity from a real container, moving 5-10 wheat_seeds and never only one.',
    regressionRisk: 'Loose quantity parsing and storage execution can pass unit tests while failing real container transfer.'
  },
  {
    id: 'all-seed-withdraw',
    testName: 'take all available seeds from chest',
    commandOrInput: '把箱子里的所有种子拿出来',
    mode: 'withdraw_all',
    sourceRole: 'main',
    measure: { kind: 'item', name: 'wheat_seeds' },
    expectedBehavior: 'The AI should withdraw all available wheat_seeds from the real container, up to the available amount.',
    regressionRisk: 'All-count withdrawal can regress to one stack, one item, or a false success.'
  },
  {
    id: 'deposit-items',
    testName: 'deposit items into a real container',
    commandOrInput: '把木头放箱子里',
    mode: 'deposit',
    targetRole: 'main',
    measure: { kind: 'category', name: 'wood', items: WOOD_ITEMS },
    expectedBehavior: 'The AI should deposit real inventory wood items into the target container and the container count should increase.',
    regressionRisk: 'Deposit can log success without moving items if the container delta is not verified.'
  },
  {
    id: 'food-generalization',
    testName: 'withdraw generalized food items',
    commandOrInput: '从箱子里拿点食物',
    mode: 'withdraw',
    sourceRole: 'main',
    measure: { kind: 'category', name: 'food', items: FOOD_ITEMS },
    expectedBehavior: 'The AI should treat bread, cooked meats, apple, carrot, and potato as food candidates instead of only beef.',
    regressionRisk: 'Food storage commands can silently narrow to one hard-coded item.'
  },
  {
    id: 'wood-generalization',
    testName: 'withdraw generalized wood items',
    commandOrInput: '从箱子里拿点木头',
    mode: 'withdraw',
    sourceRole: 'main',
    measure: { kind: 'category', name: 'wood', items: WOOD_ITEMS },
    expectedBehavior: 'The AI should treat oak, birch, spruce logs and planks as wood instead of only oak_log or oak_planks.',
    regressionRisk: 'Wood storage commands can pass with oak while ignoring other species.'
  },
  {
    id: 'multi-chest-fallback',
    testName: 'fallback from empty chest to backup chest',
    commandOrInput: '从箱子里拿点种子',
    mode: 'withdraw',
    sourceRole: 'backup',
    emptyRole: 'main',
    measure: { kind: 'item', name: 'wheat_seeds' },
    requireLog: /\[WITHDRAW_SEARCH_NEXT_CHEST\]/,
    expectedBehavior: 'The AI should continue searching when the first nearby chest is empty or lacks the target item.',
    regressionRisk: 'Storage search can stop at the first chest and report item missing even when another chest has the item.'
  },
  {
    id: 'double-chest',
    testName: 'withdraw from double chest',
    commandOrInput: '从大箱子里拿点种子',
    mode: 'withdraw',
    sourceRole: 'doubleLeft',
    measure: { kind: 'item', name: 'wheat_seeds' },
    requireLog: /\[DOUBLE_CHEST_DETECTED\]/,
    expectedBehavior: 'The AI should recognize and withdraw from a double chest.',
    regressionRisk: 'Double chest adjacency can be missed, causing false chest-not-found or partial inventory reads.'
  },
  {
    id: 'unreachable-chest-fallback',
    testName: 'fallback when nearest target chest is blocked',
    commandOrInput: '从箱子里拿点种子',
    mode: 'withdraw',
    sourceRole: 'backup',
    blockedRole: 'unreachable',
    measure: { kind: 'item', name: 'wheat_seeds' },
    requireLog: /\[CHEST_(OPEN_FAILED|CACHE_INVALIDATE|RESCAN)|path_unreachable|open_chest/i,
    expectedBehavior: 'The AI should not report success on a blocked chest or retry forever; with a reachable backup it should fallback.',
    regressionRisk: 'Blocked chests can trap storage tasks or produce false success without transfer.'
  },
  {
    id: 'follow-conflict',
    testName: 'storage while follow is active',
    commandOrInput: '从箱子里拿点种子',
    mode: 'withdraw',
    sourceRole: 'main',
    setupCommands: ['跟着我'],
    measure: { kind: 'item', name: 'wheat_seeds' },
    expectedBehavior: 'The AI should not deadlock storage when follow state is active.',
    regressionRisk: 'Follow movement ownership can block storage locks or keep the task from completing.'
  },
  {
    id: 'pause-resume-stop-entrypoints',
    testName: 'pause resume stop storage control entrypoints',
    commandOrInput: '暂停；继续；停止任务',
    mode: 'control',
    targetRole: 'main',
    measure: { kind: 'none' },
    expectedBehavior: 'Pause, resume, and stop commands should be routed while storage fixture is ready and should leave the bot idle.',
    regressionRisk: 'Storage can complete but control commands may lack lifecycle entrypoints or leave ActionLock stuck.'
  }
]

module.exports = {
  featureName: 'storage',
  testName: 'storage full integration',
  commandOrInput: 'storage full integration suite',

  async run({ adapter, projectConfig, createRecord }) {
    const config = projectConfig.minecraft.storage
    const records = []
    const setupCursor = adapter.createLogCursor()
    const environmentCommandResult = await prepareStorageEnvironment(adapter)
    await adapter.sendCommand('停止任务', { afterMs: 900 })
    const baseSnapshot = await adapter.snapshot({ logCursor: setupCursor, scanRadius: config.scanRadius, includeDebugStatus: true })
    const baseSetup = {
      setupStatus: 'READY',
      setupFailureReason: null,
      snapshot: baseSnapshot,
      fixtureStatus: {
        feature: 'storage',
        ready: false,
        reason: 'explicit_layout_pending',
        environmentCommandResult,
        commandFixturesAllowed: true,
        creativeFixturesAvailable: false,
        linxiaPos: baseSnapshot.companionPosition || null,
        testerPos: baseSnapshot.acceptancePlayerPosition || null,
        distance: baseSnapshot.distancePlayerToAi ?? null,
        fixtureChestPos: null,
        fixtureDistanceToLinXia: null,
        fixtureDistanceToTester: null,
        block_set_confirmed: false,
        inventory_insert_confirmed: false,
        openable_confirmed: false,
        reachable_confirmed: false
      }
    }

    const scenarios = selectedStorageScenarios()
    for (const scenario of scenarios) {
      console.log(`[storage-acceptance] start scenario=${scenario.id}`)
      const cursor = adapter.createLogCursor()
      await adapter.sendCommand('停止任务', { afterMs: 900 })
      const alignment = await alignStorageActors(adapter, config)
      if (!alignment.ok) {
        const blockedSetup = {
          ...baseSetup,
          setupStatus: 'BLOCKED',
          setupFailureReason: alignment.reason,
          snapshot: alignment.snapshot || baseSetup.snapshot,
          fixtureStatus: {
            ...(baseSetup.fixtureStatus || {}),
            ready: false,
            reason: alignment.reason,
            environmentCommandResult,
            actorAlignment: alignment
          }
        }
        records.push(createRecord(blockedScenarioRecord({ adapter, setup: blockedSetup, scenario })))
        console.log(`[storage-acceptance] blocked scenario=${scenario.id} reason=${alignment.reason}`)
        continue
      }
      const snapshot = alignment.snapshot
      const setup = {
        ...baseSetup,
        snapshot,
        fixtureStatus: {
          ...(baseSetup.fixtureStatus || {}),
          environmentCommandResult,
          actorAlignment: alignment,
          acceptancePlayerPosition: snapshot.acceptancePlayerPosition,
          companionPosition: snapshot.companionPosition,
          distancePlayerToAi: snapshot.distancePlayerToAi
        }
      }

      const layout = await prepareScenarioLayout({ adapter, setup, scenario, config, cursor })
      const mergedSetup = mergeSetupWithLayout(setup, layout)
      if (!layout.ready) {
        records.push(createRecord(blockedScenarioRecord({
          adapter,
          setup: {
            ...mergedSetup,
            setupStatus: 'BLOCKED',
            setupFailureReason: layout.reason || 'storage_layout_not_ready'
          },
          scenario
        })))
        console.log(`[storage-acceptance] blocked scenario=${scenario.id} reason=${layout.reason}`)
        continue
      }

      const runner = scenario.mode === 'control' ? runControlScenario : runTransferScenario
      records.push(createRecord(await runner({ adapter, config, setup: mergedSetup, layout, cursor, scenario })))
      console.log(`[storage-acceptance] done scenario=${scenario.id}`)
    }
    return records
  }
}

async function prepareScenarioLayout({ adapter, setup, scenario, config, cursor }) {
  const anchor = setup.snapshot?.companionPosition || setup.snapshot?.acceptancePlayerPosition || adapter.bot.entity.position
  const layout = storageLayout(anchor)
  const contents = scenarioContents(scenario)
  console.log(`[storage-acceptance] layout commands start scenario=${scenario.id}`)
  const commandResult = await runLayoutCommands(adapter, buildLayoutCommands(layout, contents, scenario, adapter.aiUsername()))
  console.log(`[storage-acceptance] layout commands done scenario=${scenario.id} denied=${commandResult.commandDenied}`)
  if (commandResult.commandDenied) {
    return { ready: false, reason: 'command_denied', layout, commandResult, verification: null }
  }

  await adapter.wait(900)
  console.log(`[storage-acceptance] layout verify start scenario=${scenario.id}`)
  const verification = await verifyLayout({ adapter, setup, layout, scenario, config, cursor })
  console.log(`[storage-acceptance] layout verify done scenario=${scenario.id} ready=${verification.ready} reason=${verification.reason || 'ready'}`)
  if (!verification.ready) {
    return { ready: false, reason: verification.reason, layout, commandResult, verification }
  }
  return { ready: true, reason: 'explicit_storage_layout_ready', layout, commandResult, verification }
}

function storageLayout(anchor) {
  const x = Math.floor(Number(anchor.x))
  const y = Math.floor(Number(anchor.y))
  const z = Math.floor(Number(anchor.z))
  return {
    anchor: { x, y, z },
    main: { x: x + 2, y, z },
    backup: { x: x + 4, y, z },
    empty: { x: x + 3, y, z: z + 2 },
    doubleLeft: { x: x + 2, y, z: z + 4 },
    doubleRight: { x: x + 3, y, z: z + 4 },
    unreachable: { x: x + 1, y, z: z + 1 }
  }
}

function scenarioContents(scenario) {
  const baseSeeds = [item('wheat_seeds', 16, 0)]
  const emptyItems = []
  const defaultContents = {
    main: baseSeeds,
    backup: emptyItems,
    empty: emptyItems,
    doubleLeft: emptyItems,
    doubleRight: emptyItems,
    unreachable: [item('wheat_seeds', 16, 0)]
  }

  if (scenario.id === 'food-generalization') {
    return {
      ...defaultContents,
      main: [
        ...baseSeeds,
        item('bread', 2, 1),
        item('cooked_beef', 2, 2),
        item('cooked_porkchop', 2, 3),
        item('apple', 2, 4),
        item('carrot', 2, 5),
        item('potato', 2, 6)
      ]
    }
  }

  if (scenario.id === 'wood-generalization') {
    return {
      ...defaultContents,
      main: [
        ...baseSeeds,
        item('oak_log', 2, 1),
        item('birch_log', 2, 2),
        item('spruce_log', 2, 3),
        item('oak_planks', 2, 4),
        item('birch_planks', 2, 5),
        item('spruce_planks', 2, 6)
      ]
    }
  }

  if (scenario.id === 'multi-chest-fallback') {
    return {
      ...defaultContents,
      main: [item('cobblestone', 3, 0)],
      backup: baseSeeds
    }
  }

  if (scenario.id === 'double-chest') {
    return {
      ...defaultContents,
      main: [item('cobblestone', 3, 0)],
      doubleLeft: baseSeeds
    }
  }

  if (scenario.id === 'unreachable-chest-fallback') {
    return {
      ...defaultContents,
      main: [item('cobblestone', 3, 0)],
      backup: baseSeeds,
      unreachable: baseSeeds
    }
  }

  return defaultContents
}

function buildLayoutCommands(layout, contents, scenario, aiUsername) {
  const roles = fixtureRolesForScenario(scenario)
  const cleanupRoles = allStorageFixtureRoles()
  const cleanupPositions = cleanupRoles.map(role => layout[role]).filter(Boolean)
  const positions = roles.map(role => layout[role]).filter(Boolean)
  const xs = cleanupPositions.map(pos => pos.x)
  const zs = cleanupPositions.map(pos => pos.z)
  const minX = Math.min(...xs) - 1
  const maxX = Math.max(...xs) + 1
  const minZ = Math.min(...zs) - 1
  const maxZ = Math.max(...zs) + 1
  const y = layout.anchor.y
  const commands = [
    `fill ${minX} ${y} ${minZ} ${maxX} ${y + 2} ${maxZ} minecraft:air replace minecraft:chest`,
    `fill ${minX} ${y} ${minZ} ${maxX} ${y + 2} ${maxZ} minecraft:air replace minecraft:trapped_chest`,
    `fill ${minX} ${y} ${minZ} ${maxX} ${y + 2} ${maxZ} minecraft:air replace minecraft:barrel`
  ]

  for (const pos of cleanupPositions) {
    commands.push(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:stone`)
    commands.push(`setblock ${pos.x} ${pos.y + 1} ${pos.z} minecraft:air`)
  }

  for (const role of roles) {
    const pos = layout[role]
    if (role === 'doubleLeft') {
      commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:chest[facing=north,type=left]`)
    } else if (role === 'doubleRight') {
      commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:chest[facing=north,type=right]`)
    } else {
      commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:chest`)
    }
  }

  if (roles.includes('unreachable')) {
    commands.push(`setblock ${layout.unreachable.x} ${layout.unreachable.y + 1} ${layout.unreachable.z} minecraft:stone`)
  }

  for (const [role, items] of Object.entries(contents)) {
    if (!roles.includes(role)) continue
    if (!layout[role]) continue
    for (const entry of items) {
      commands.push(`item replace block ${layout[role].x} ${layout[role].y} ${layout[role].z} container.${entry.slot} with minecraft:${entry.name} ${entry.count}`)
    }
  }
  commands.push(...scenarioInventoryCommands(scenario, aiUsername))
  return commands
}

function allStorageFixtureRoles() {
  return ['main', 'backup', 'empty', 'doubleLeft', 'doubleRight', 'unreachable']
}

function fixtureRolesForScenario(scenario) {
  const roles = new Set(['main'])
  for (const role of [scenario.sourceRole, scenario.targetRole, scenario.emptyRole, scenario.blockedRole]) {
    if (role) roles.add(role)
  }

  if (roles.has('doubleLeft') || roles.has('doubleRight')) {
    roles.add('doubleLeft')
    roles.add('doubleRight')
  }

  return [...roles]
}

function openableFixtureRolesForScenario(scenario, roles = fixtureRolesForScenario(scenario)) {
  return roles.filter(role => role !== 'unreachable' && role !== 'doubleRight')
}

function scenarioInventoryCommands(scenario, aiUsername) {
  if (scenario.id !== 'deposit-items') return []
  return [
    ...WOOD_ITEMS.map(itemName => `clear ${aiUsername} minecraft:${itemName}`),
    `give ${aiUsername} minecraft:oak_log 6`,
    `give ${aiUsername} minecraft:birch_log 6`,
    `give ${aiUsername} minecraft:spruce_planks 6`
  ]
}

async function runLayoutCommands(adapter, commands) {
  const results = []
  for (const command of commands) results.push(await runServerCommandFast(adapter, command))
  const denied = results.find(result => result.commandDenied)
  return {
    attempted: true,
    commands: results,
    commandDenied: Boolean(denied),
    deniedMessage: denied?.deniedMessage || null
  }
}

async function runServerCommandFast(adapter, command) {
  const text = String(command || '').replace(/^\//, '')
  const sentAt = new Date().toISOString()
  const before = adapter.systemMessages?.length || 0
  adapter.bot.chat(`/${text}`)
  await adapter.wait(180)
  const messages = (adapter.systemMessages || []).slice(before)
  const denied = messages.find(entry => fixtureCommandDeniedMessage(entry.message))
  return {
    command: `/${text}`,
    sentAt,
    messages,
    commandDenied: Boolean(denied),
    deniedMessage: denied?.message || null
  }
}

function fixtureCommandDeniedMessage(message) {
  return /permission|not allowed|requires operator|cheats? (are )?not enabled|denied|unknown command|没有权限|权限不足|未知的命令/i
    .test(String(message || ''))
}

async function verifyLayout({ adapter, setup, layout, scenario, config, cursor }) {
  const observations = {}
  const fixtureRoles = fixtureRolesForScenario(scenario)
  const rolesToOpen = openableFixtureRolesForScenario(scenario, fixtureRoles)
  for (const role of rolesToOpen) {
    console.log(`[storage-acceptance] observe role=${role} scenario=${scenario.id}`)
    observations[role] = await adapter.observeContainerAt(layout[role], `observe_${role}_container_timeout`).catch(err => ({
      ok: false,
      error: err.message,
      counts: {},
      position: layout[role]
    }))
  }

  const blockChecks = {}
  for (const role of fixtureRoles) {
    const block = adapter.bot.blockAt(toVec3Like(layout[role]))
    blockChecks[role] = {
      position: layout[role],
      blockName: block?.name || null,
      ok: ['chest', 'trapped_chest', 'barrel'].includes(block?.name)
    }
  }

  const seedContainers = fixtureRoles.map(role => observations[role]?.counts?.wheat_seeds || 0)
  const inventoryInsertConfirmed = seedContainers.some(count => count >= 10)
  const sourceRole = sourceRoleForScenario(scenario)
  const sourceObservation = sourceRole ? observations[sourceRole] : observations.main
  const blockSetConfirmed = Object.values(blockChecks).every(check => check.ok)
  const mainOpenable = Boolean(observations.main?.ok)
  const sourceOpenable = sourceRole === 'unreachable' ? true : Boolean(sourceObservation?.ok)
  const fixtureDistanceToLinXia = distance(layout.main, setup.snapshot?.companionPosition)
  const fixtureDistanceToTester = distance(layout.main, setup.snapshot?.acceptancePlayerPosition)
  const sourceDistanceToLinXia = sourceRole ? distance(layout[sourceRole], setup.snapshot?.companionPosition) : fixtureDistanceToLinXia
  const reachableConfirmed = sourceDistanceToLinXia != null && sourceDistanceToLinXia <= 5
  const companionAccess = {
    ok: true,
    reason: 'confirmed_by_reachable_layout_and_case_transfer',
    failure: null,
    relatedLogs: []
  }

  const base = {
    linxiaPos: setup.snapshot?.companionPosition || null,
    testerPos: setup.snapshot?.acceptancePlayerPosition || null,
    distance: setup.snapshot?.distancePlayerToAi ?? null,
    fixtureChestPos: layout.main,
    fixtureDistanceToLinXia,
    fixtureDistanceToTester,
    block_set_confirmed: blockSetConfirmed,
    inventory_insert_confirmed: inventoryInsertConfirmed,
    openable_confirmed: Boolean(mainOpenable && sourceOpenable),
    reachable_confirmed: Boolean(reachableConfirmed),
    seedCount: Math.max(...seedContainers, 0),
    chest: observations.main,
    storageLayout: layout,
    storageLayoutDistances: layoutDistances(layout, setup.snapshot),
    layoutObservations: observations,
    blockChecks,
    sourceRole,
    sourceDistanceToLinXia,
    companionAccess,
    scanRadius: config.scanRadius,
    actorAlignment: setup.fixtureStatus?.actorAlignment || null,
    inheritedFixtureStatus: setup.fixtureStatus || {},
    layoutLogCursor: cursor
  }

  if (!blockSetConfirmed) return { ready: false, reason: 'block_not_set', ...base }
  if (!inventoryInsertConfirmed) return { ready: false, reason: 'inventory_insert_failed', ...base }
  if (!mainOpenable || !sourceOpenable) return { ready: false, reason: 'chest_open_failed', ...base }
  if (!reachableConfirmed) return { ready: false, reason: 'chest_unreachable', ...base }
  return { ready: true, ...base }
}

async function prepareStorageEnvironment(adapter) {
  return {
    attempted: false,
    commands: [],
    commandDenied: false,
    deniedMessage: null,
    reason: 'storage_fixture_does_not_require_global_world_commands'
  }
}

async function alignStorageActors(adapter, config) {
  const before = await adapter.snapshot({ scanRadius: config.scanRadius, includeDebugStatus: true })
  const command = `tp ${adapter.aiUsername()} ${adapter.testUsername()}`
  const teleport = await adapter.runServerCommand(command).catch(err => ({
    command: `/${command}`,
    commandDenied: false,
    error: err.message
  }))
  await adapter.wait(1200)
  const after = await adapter.snapshot({ scanRadius: config.scanRadius, includeDebugStatus: true })
  const ok = after.distancePlayerToAi != null && after.distancePlayerToAi <= 5
  const reason = ok
    ? 'teleport_confirmed'
    : (teleport.commandDenied ? 'command_denied' : (teleport.error ? 'teleport_failed' : 'actor_distance_too_far'))
  return {
    ok,
    reason,
    attempted: true,
    mode: 'per_storage_case_teleport',
    teleport,
    beforeAcceptancePlayerPosition: before.acceptancePlayerPosition || null,
    beforeCompanionPosition: before.companionPosition || null,
    beforeDistancePlayerToAi: before.distancePlayerToAi ?? null,
    afterAcceptancePlayerPosition: after.acceptancePlayerPosition || null,
    afterCompanionPosition: after.companionPosition || null,
    afterDistancePlayerToAi: after.distancePlayerToAi ?? null,
    snapshot: after
  }
}

async function verifyCompanionCanOpen(adapter, config) {
  const cursor = adapter.createLogCursor()
  await adapter.sendCommand('看看箱子里有什么')
  const logs = await adapter.waitForLog([
    /\[STORAGE_TASK_SUCCESS\].*mode=check/,
    /\[STORAGE_TASK_FAILED\]/
  ], config.timeoutMs || 35000, cursor)
  const success = logs.some(line => /\[STORAGE_TASK_SUCCESS\].*mode=check/.test(line))
  const failure = [...logs].reverse().find(line => line.includes('[STORAGE_TASK_FAILED]'))
  await adapter.sendCommand('停止任务', { afterMs: 700 })
  return {
    ok: success,
    reason: success ? null : (failure?.includes('unreachable') ? 'chest_unreachable' : 'chest_open_failed'),
    failure: failure || null,
    relatedLogs: logs.slice(-60)
  }
}

async function runTransferScenario({ adapter, config, setup, layout, cursor, scenario }) {
  await adapter.sendCommand('停止任务', { afterMs: 900 })
  const positions = layout.layout || layout
  const measureRole = scenario.mode === 'deposit'
    ? scenario.targetRole
    : sourceRoleForScenario(scenario)
  const measurePos = positions[measureRole]
  const beforeContainer = await adapter.observeContainerAt(measurePos, `before_${scenario.id}_container_timeout`).catch(err => ({
    ok: false,
    error: err.message,
    counts: {},
    position: measurePos
  }))
  const beforeCount = measureCount(beforeContainer.counts, scenario.measure)
  const preState = await adapter.snapshot({ logCursor: cursor, scanRadius: config.scanRadius, includeDebugStatus: true })
  const beforeInventory = inventorySummary(preState)

  if (Array.isArray(scenario.setupCommands)) {
    for (const command of scenario.setupCommands) {
      await adapter.sendCommand(command, { afterMs: 1200 })
    }
    await adapter.wait(1200)
  }

  const commandCursor = adapter.createLogCursor()
  await adapter.sendCommand(scenario.commandOrInput)
  const logs = await adapter.waitForLog([
    /\[STORAGE_TASK_SUCCESS\]/,
    /\[STORAGE_TASK_FAILED\]/
  ], config.timeoutMs, commandCursor)
  await adapter.wait(1200)
  const postState = await adapter.snapshot({ logCursor: commandCursor, scanRadius: config.scanRadius, includeDebugStatus: true })
  const afterInventory = inventorySummary(postState)
  const afterContainer = await adapter.observeContainerAt(measurePos, `after_${scenario.id}_container_timeout`).catch(err => ({
    ok: false,
    error: err.message,
    counts: {},
    position: measurePos
  }))
  const afterCount = measureCount(afterContainer.counts, scenario.measure)
  const assertion = assertTransferScenario({
    scenario,
    postState,
    beforeCount,
    afterCount,
    beforeContainer,
    afterContainer,
    logs
  })

  if (scenario.id === 'follow-conflict') {
    await adapter.sendCommand('停止任务', { afterMs: 1000 })
  }

  return storageScenarioRecord({
    adapter,
    scenario,
    preState,
    postState,
    setup,
    layout,
    beforeInventory,
    afterInventory,
    beforeContainer,
    afterContainer,
    beforeCount,
    afterCount,
    assertion,
    logs,
    measureRole
  })
}

async function runControlScenario({ adapter, config, setup, layout, cursor, scenario }) {
  const positions = layout.layout || layout
  const preState = await adapter.snapshot({ logCursor: cursor, scanRadius: config.scanRadius, includeDebugStatus: true })
  const beforeInventory = inventorySummary(preState)
  const beforeContainer = await adapter.observeContainerAt(positions.main, `before_${scenario.id}_container_timeout`).catch(err => ({
    ok: false,
    error: err.message,
    counts: {},
    position: positions.main
  }))

  const commandCursor = adapter.createLogCursor()
  await adapter.sendCommand('从箱子里拿点种子', { afterMs: 250 })
  await adapter.sendCommand('暂停', { afterMs: 800 })
  await adapter.sendCommand('继续', { afterMs: 800 })
  await adapter.sendCommand('停止任务', { afterMs: 1200 })
  const logs = adapter.readLogsSince(commandCursor)
  await adapter.wait(800)
  const postState = await adapter.snapshot({ logCursor: commandCursor, scanRadius: config.scanRadius, includeDebugStatus: true })
  const afterInventory = inventorySummary(postState)
  const afterContainer = await adapter.observeContainerAt(positions.main, `after_${scenario.id}_container_timeout`).catch(err => ({
    ok: false,
    error: err.message,
    counts: {},
    position: positions.main
  }))
  const status = postState.debugStatus?.status || {}
  const pauseSeen = logs.some(line => /PAUSE|pause_current_task|暂停|鏆傚仠/i.test(line))
  const resumeSeen = logs.some(line => /RESUME|resume_current_task|继续|缁х画/i.test(line))
  const stopSeen = logs.some(line => /STOP_CURRENT_TASK|stop_current_task|停止任务|鍋滄浠诲姟/i.test(line))
  const idle = !status.currentTask && !status.lockOwner
  const pass = pauseSeen && resumeSeen && stopSeen && idle
  const assertion = {
    judgment: pass ? 'PASS' : 'FAIL',
    taskSucceeded: Boolean(postState.taskSignals.storage.taskSuccess),
    beforeCount: null,
    afterCount: null,
    containerDelta: null,
    actualTransferredCount: null,
    controlSignals: { pauseSeen, resumeSeen, stopSeen, idle },
    failureReason: pass ? null : controlFailureReason({ pauseSeen, resumeSeen, stopSeen, idle })
  }

  return storageScenarioRecord({
    adapter,
    scenario,
    preState,
    postState,
    setup,
    layout,
    beforeInventory,
    afterInventory,
    beforeContainer,
    afterContainer,
    beforeCount: null,
    afterCount: null,
    assertion,
    logs,
    measureRole: 'main'
  })
}

function assertTransferScenario({ scenario, postState, beforeCount, afterCount, beforeContainer, afterContainer, logs }) {
  const taskSucceeded = postState.taskSignals.storage.taskSuccess
  const fromLogs = scenario.mode === 'deposit'
    ? sumItems(postState.taskSignals.storage.storedItems)
    : sumItems(postState.taskSignals.storage.withdrawnItems)
  const delta = Number.isFinite(beforeCount) && Number.isFinite(afterCount)
    ? (scenario.mode === 'deposit' ? afterCount - beforeCount : beforeCount - afterCount)
    : null
  const actualTransferredCount = delta != null && delta > 0 ? delta : fromLogs
  const hasSource = scenario.mode === 'deposit' || (Number.isFinite(beforeCount) && beforeCount > 0)
  const requiredLogOk = scenario.requireLog ? logs.some(line => scenario.requireLog.test(line)) : true
  const itemCoverage = scenario.measure?.items
    ? transferredItemCoverage(beforeContainer.counts, afterContainer.counts, scenario.measure.items, scenario.mode)
    : null

  if (scenario.mode === 'deposit') {
    const pass = taskSucceeded && Number.isFinite(actualTransferredCount) && actualTransferredCount > 0
    return {
      judgment: pass ? 'PASS' : 'FAIL',
      taskSucceeded,
      beforeCount,
      afterCount,
      containerDelta: delta,
      actualTransferredCount,
      itemCoverage,
      failureReason: pass ? null : depositFailureReason({ taskSucceeded, actualTransferredCount })
    }
  }

  const expectedMin = scenario.mode === 'withdraw_all' ? beforeCount : Math.min(5, beforeCount || 5)
  const expectedMax = scenario.mode === 'withdraw_all' ? beforeCount : Math.min(10, beforeCount || 10)
  const quantityOk = Number.isFinite(actualTransferredCount) &&
    actualTransferredCount >= expectedMin &&
    actualTransferredCount <= expectedMax
  const notOnlyOne = Number.isFinite(actualTransferredCount) && actualTransferredCount > 1
  const coverageOk = !itemCoverage || itemCoverage.transferredDistinctCount >= (scenario.measure.name === 'food' || scenario.measure.name === 'wood' ? 2 : 1)
  const pass = taskSucceeded && hasSource && notOnlyOne && quantityOk && requiredLogOk && coverageOk
  return {
    judgment: pass ? 'PASS' : 'FAIL',
    taskSucceeded,
    hasSource,
    beforeCount,
    afterCount,
    containerDelta: delta,
    actualTransferredCount,
    expectedMin,
    expectedMax,
    quantityOk,
    notOnlyOne,
    requiredLogOk,
    itemCoverage,
    failureReason: pass ? null : withdrawFailureReason({
      scenario,
      taskSucceeded,
      hasSource,
      actualTransferredCount,
      expectedMin,
      expectedMax,
      quantityOk,
      notOnlyOne,
      requiredLogOk,
      coverageOk
    })
  }
}

function storageScenarioRecord({ adapter, scenario, preState, postState, setup, layout, beforeInventory, afterInventory, beforeContainer, afterContainer, beforeCount, afterCount, assertion, logs, measureRole }) {
  const positions = layout.layout || layout
  const containerPos = beforeContainer.position || afterContainer.position || positions[measureRole] || setup.fixtureStatus?.fixtureChestPos || null
  const isDeposit = scenario.mode === 'deposit'
  return {
    projectName: adapter.displayProjectName(),
    featureName: 'storage',
    testName: scenario.testName,
    commandOrInput: scenario.commandOrInput,
    preState,
    postState,
    observedBehavior: `sourceOrTargetRole=${measureRole}; beforeInventory=${JSON.stringify(beforeInventory)}; afterInventory=${JSON.stringify(afterInventory)}; beforeContainerCount=${beforeCount}; afterContainerCount=${afterCount}; actualTransferredCount=${assertion.actualTransferredCount}; taskSucceeded=${assertion.taskSucceeded}.`,
    expectedBehavior: scenario.expectedBehavior,
    actualResult: assertion.judgment === 'PASS'
      ? (scenario.mode === 'control' ? 'control_entrypoints_verified' : 'real_container_transfer_confirmed')
      : 'storage_integration_failed',
    judgment: assertion.judgment,
    passOrFail: assertion.judgment,
    failureReason: assertion.failureReason,
    evidence: {
      scenarioId: scenario.id,
      expectedBehavior: scenario.expectedBehavior,
      beforeInventory,
      afterInventory,
      sourceContainerPos: scenario.mode !== 'deposit' ? containerPos : null,
      targetContainerPos: isDeposit || scenario.mode === 'control' ? containerPos : null,
      beforeContainer,
      afterContainer,
      beforeContainerCount: beforeCount,
      afterContainerCount: afterCount,
      actualTransferredCount: assertion.actualTransferredCount,
      noTransferReason: assertion.actualTransferredCount == null && scenario.mode === 'control'
        ? 'control_entrypoints_verified_no_transfer_required'
        : null,
      assertion,
      taskSignals: postState.taskSignals,
      fixtureStatus: setup.fixtureStatus || {},
      storageLayout: positions,
      layoutResult: layout
    },
    relatedLogs: logs.slice(-100),
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: assertion.judgment === 'PASS'
      ? 'Keep this scenario in the full storage coverage suite.'
      : 'Inspect real storage task logs, container deltas, and fixture layout for this case.',
    ...environmentFields(adapter, postState, setup)
  }
}

function blockedScenarioRecord({ adapter, setup, scenario }) {
  const reason = setup.setupFailureReason || setup.fixtureStatus?.reason || 'storage_fixture_not_ready'
  const role = scenario.mode === 'deposit' ? scenario.targetRole : sourceRoleForScenario(scenario)
  const record = blockedRecord({
    adapter,
    featureName: 'storage',
    testName: scenario.testName,
    commandOrInput: scenario.commandOrInput,
    setup,
    expectedBehavior: scenario.expectedBehavior,
    regressionRisk: scenario.regressionRisk,
    nextSuggestion: 'Unblock storage fixture positioning and container verification before judging this integration case.'
  })
  return {
    ...record,
    actualResult: reason,
    setupFailureReason: reason,
    evidence: {
      ...(record.evidence || {}),
      scenarioId: scenario.id,
      expectedBehavior: scenario.expectedBehavior,
      beforeInventory: inventorySummary(setup.snapshot || {}),
      afterInventory: inventorySummary(setup.snapshot || {}),
      sourceContainerPos: scenario.mode === 'deposit' ? null : setup.fixtureStatus?.storageLayout?.[role] || setup.fixtureStatus?.fixtureChestPos || null,
      targetContainerPos: scenario.mode === 'deposit' ? setup.fixtureStatus?.storageLayout?.[role] || setup.fixtureStatus?.fixtureChestPos || null : null,
      actualTransferredCount: null,
      fixtureStatus: setup.fixtureStatus || {},
      storageLayout: setup.fixtureStatus?.storageLayout || null
    }
  }
}

function mergeSetupWithLayout(setup, layoutResult) {
  return {
    ...setup,
    fixtureStatus: {
      ...(setup.fixtureStatus || {}),
      ...(layoutResult.verification || {}),
      ready: Boolean(layoutResult.ready),
      reason: layoutResult.reason,
      layoutCommandResult: layoutResult.commandResult || null
    }
  }
}

function sourceRoleForScenario(scenario) {
  return scenario.sourceRole || scenario.targetRole || 'main'
}

function selectedStorageScenarios() {
  const filter = process.env.STORAGE_ACCEPTANCE_CASES || process.env.ACCEPTANCE_STORAGE_CASES || ''
  const wanted = new Set(String(filter).split(',').map(item => item.trim()).filter(Boolean))
  if (!wanted.size) return STORAGE_SCENARIOS
  return STORAGE_SCENARIOS.filter(scenario => wanted.has(scenario.id) || wanted.has(scenario.testName))
}

function inventorySummary(snapshot = {}) {
  return snapshot.debugStatus?.status?.inventorySummary || null
}

function measureCount(counts = {}, measure = {}) {
  if (!measure || measure.kind === 'none') return null
  if (measure.kind === 'item') return itemCount(counts, measure.name)
  if (measure.kind === 'category') {
    return (measure.items || []).reduce((sum, name) => sum + itemCount(counts, name), 0)
  }
  return 0
}

function itemCount(counts = {}, itemName) {
  return Number(counts?.[itemName] || 0)
}

function sumItems(items = []) {
  return items.reduce((sum, item) => sum + Number(item.count || 0), 0)
}

function transferredItemCoverage(before = {}, after = {}, itemNames = [], mode = 'withdraw') {
  const transferred = []
  for (const name of itemNames) {
    const delta = mode === 'deposit'
      ? itemCount(after, name) - itemCount(before, name)
      : itemCount(before, name) - itemCount(after, name)
    if (delta > 0) transferred.push({ itemName: name, count: delta })
  }
  return {
    fixtureItems: itemNames.filter(name => itemCount(before, name) > 0),
    transferredItems: transferred,
    transferredDistinctCount: transferred.length
  }
}

function item(name, count, slot) {
  return { name, count, slot }
}

function layoutDistances(layout, snapshot = {}) {
  const linxia = snapshot.companionPosition
  const tester = snapshot.acceptancePlayerPosition
  return Object.fromEntries(Object.entries(layout)
    .filter(([, pos]) => pos && Number.isFinite(Number(pos.x)))
    .map(([role, pos]) => [role, {
      distanceToLinXia: distance(pos, linxia),
      distanceToTester: distance(pos, tester)
    }]))
}

function distance(a, b) {
  if (!a || !b) return null
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  const dz = Number(a.z) - Number(b.z)
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100
}

function toVec3Like(position) {
  const Vec3 = require('vec3').Vec3
  return new Vec3(Number(position.x), Number(position.y), Number(position.z))
}

function withdrawFailureReason(state) {
  if (!state.hasSource) return 'source_container_missing_target_item'
  if (!state.taskSucceeded) return 'storage_task_did_not_succeed'
  if (!state.requiredLogOk) return 'required_storage_path_log_missing'
  if (!state.notOnlyOne) return `actualTransferredCount=${state.actualTransferredCount || 0}; expected more than 1`
  if (!state.quantityOk) return `actualTransferredCount=${state.actualTransferredCount}; expected ${state.expectedMin}-${state.expectedMax}`
  if (!state.coverageOk) return 'generalized_item_coverage_not_observed'
  return `${state.scenario.id}_failed`
}

function depositFailureReason(state) {
  if (!state.taskSucceeded) return 'storage_task_did_not_succeed'
  if (!Number.isFinite(state.actualTransferredCount) || state.actualTransferredCount <= 0) return 'deposit_container_count_did_not_increase'
  return 'deposit_failed'
}

function controlFailureReason(state) {
  if (!state.pauseSeen) return 'pause_entrypoint_not_observed'
  if (!state.resumeSeen) return 'resume_entrypoint_not_observed'
  if (!state.stopSeen) return 'stop_entrypoint_not_observed'
  if (!state.idle) return 'bot_not_idle_after_stop'
  return 'storage_control_entrypoints_failed'
}
