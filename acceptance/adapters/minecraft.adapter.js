const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const dotenv = require('dotenv')
const { MinecraftScenarioBuilder } = require('../scenario-builder')

class MinecraftAdapter {
  constructor({ rootDir, projectName, projectConfig }) {
    this.rootDir = rootDir
    this.projectName = projectName
    this.projectConfig = projectConfig
    this.config = projectConfig.minecraft || {}
    this.bot = null
    this.botProcess = null
    this.chatMessages = []
    this.systemMessages = []
    this.connectionInfo = null
    this.scenarioBuilder = new MinecraftScenarioBuilder(this)
  }

  displayProjectName() {
    return this.projectConfig.displayName || 'Minecraft AI Companion'
  }

  async setup() {
    dotenv.config({ path: path.join(this.rootDir, '.env') })
    if (this.config.startBot) this.startAiBot()

    const port = await this.resolvePort()
    const host = process.env.MC_HOST || this.config.host || 'localhost'
    const username = this.testUsername()
    const version = process.env.MC_VERSION || this.config.version || '1.20.1'
    const auth = process.env.MC_AUTH || this.config.auth || 'offline'
    this.connectionInfo = {
      host,
      port,
      version,
      auth,
      configuredAiUsername: this.aiUsername(),
      configuredTestUsername: username,
      acceptancePlayerUsername: username,
      aiUsernameSource: this.aiUsernameSource(),
      testUsernameSource: this.testUsernameSource()
    }
    console.log(`[ACCEPTANCE_CONFIG] ${JSON.stringify(this.startupConfig())}`)
    this.bot = mineflayer.createBot({
      host,
      port,
      username,
      version,
      auth
    })
    this.bot.loadPlugin(pathfinder)
    this.bot.on('chat', (username, message) => {
      this.chatMessages.push({ time: new Date().toISOString(), username, message })
      if (this.chatMessages.length > 100) this.chatMessages.shift()
    })
    this.bot.on('message', jsonMsg => {
      const message = typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : String(jsonMsg || '')
      if (!message) return
      this.systemMessages.push({ time: new Date().toISOString(), message })
      if (this.systemMessages.length > 120) this.systemMessages.shift()
    })
    await waitForEvent(this.bot, 'spawn', 30000)
    this.bot.pathfinder.setMovements(new Movements(this.bot))
  }

  async teardown() {
    if (this.bot) {
      const bot = this.bot
      try { bot.pathfinder?.setGoal(null) } catch {}
      try { bot.quit('acceptance_done') } catch {}
      try { bot.end?.('acceptance_done') } catch {}
      try { bot._client?.end?.('acceptance_done') } catch {}
      try { bot._client?.socket?.destroy?.() } catch {}
      try { bot.removeAllListeners() } catch {}
      this.bot = null
    }
    if (this.botProcess && !this.botProcess.killed) {
      this.botProcess.kill('SIGINT')
      this.botProcess = null
    }
  }

  startAiBot() {
    const [command, ...args] = String(this.config.botStartCommand || 'node bot.js').split(/\s+/)
    this.botProcess = spawn(command, args, {
      cwd: this.rootDir,
      stdio: 'inherit',
      shell: false
    })
  }

  async resolvePort() {
    const envName = this.config.portEnv || 'MC_PORT'
    const fromEnv = Number(process.env[envName])
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
    if (this.config.port) return Number(this.config.port)
    const { findMinecraftPort } = require(path.join(this.rootDir, 'port-finder'))
    return findMinecraftPort()
  }

  aiUsername() {
    const envName = this.config.aiBotUsernameEnv || 'ACCEPTANCE_AI_USERNAME'
    return process.env[envName] || this.config.aiBotUsername || this.config.aiBotUsernameDefault || 'linxia'
  }

  aiUsernameSource() {
    const envName = this.config.aiBotUsernameEnv || 'ACCEPTANCE_AI_USERNAME'
    if (process.env[envName]) return envName
    if (this.config.aiBotUsername) return 'acceptance.config.json:aiBotUsername'
    if (this.config.aiBotUsernameDefault) return 'acceptance.config.json:aiBotUsernameDefault'
    return 'adapter-default'
  }

  testUsername() {
    const envName = this.config.testPlayerUsernameEnv || 'ACCEPTANCE_TEST_USERNAME'
    return process.env[envName] || process.env.ACCEPTANCE_PLAYER_USERNAME || this.config.testPlayerUsername || this.config.testPlayerUsernameDefault || 'accept_tester'
  }

  testUsernameSource() {
    const envName = this.config.testPlayerUsernameEnv || 'ACCEPTANCE_TEST_USERNAME'
    if (process.env[envName]) return envName
    if (process.env.ACCEPTANCE_PLAYER_USERNAME) return 'ACCEPTANCE_PLAYER_USERNAME'
    if (this.config.testPlayerUsername) return 'acceptance.config.json:testPlayerUsername'
    if (this.config.testPlayerUsernameDefault) return 'acceptance.config.json:testPlayerUsernameDefault'
    return 'adapter-default'
  }

  startupConfig() {
    return {
      host: this.connectionInfo?.host || process.env.MC_HOST || this.config.host || 'localhost',
      port: this.connectionInfo?.port || this.config.port || null,
      configuredAiUsername: this.aiUsername(),
      configuredTestUsername: this.testUsername(),
      acceptancePlayerUsername: this.testUsername(),
      aiUsernameSource: this.aiUsernameSource(),
      testUsernameSource: this.testUsernameSource()
    }
  }

  async prepareFixture(feature, options = {}) {
    return this.scenarioBuilder.prepare(feature, options)
  }

  async sendCommand(command, options = {}) {
    const before = this.chatMessages.length
    this.bot.chat(command)
    await sleep(options.afterMs || 1200)
    if (options.confirm) {
      this.bot.chat(options.confirmText || '好')
      await sleep(options.afterConfirmMs || 1200)
    }
    return this.chatMessages.slice(before)
  }

  async moveTestPlayer(offset = {}) {
    const distance = Number(offset.distance || this.config.follow?.moveDistance || 8)
    const start = this.bot.entity.position.clone()
    const target = {
      x: Math.floor(start.x + Number(offset.x ?? distance)),
      y: Math.floor(start.y),
      z: Math.floor(start.z + Number(offset.z ?? 0))
    }
    const goal = new goals.GoalNear(target.x, target.y, target.z, 1)
    this.bot.pathfinder.setMovements(new Movements(this.bot))
    this.bot.pathfinder.setGoal(goal)
    await waitUntil(() => {
      const pos = this.bot.entity?.position
      return pos && pos.distanceTo({ x: target.x, y: target.y, z: target.z }) <= 2
    }, offset.timeoutMs || 12000).catch(() => {})
    this.bot.pathfinder.setGoal(null)
    return {
      from: positionJson(start),
      target,
      current: positionJson(this.bot.entity.position)
    }
  }

  async snapshot(options = {}) {
    const debugStatus = options.includeDebugStatus ? await this.requestDebugStatus().catch(err => ({ ok: false, error: err.message })) : null
    const logs = options.logCursor != null ? this.readLogsSince(options.logCursor) : this.readRecentLogs(80)
    const playerPosition = this.bot?.entity?.position ? positionJson(this.bot.entity.position) : null
    const companionLookup = this.companionLookup(playerPosition, debugStatus)
    const aiPosition = companionLookup.position
    const chest = await this.observeNearestChest(options).catch(err => ({ ok: false, error: err.message }))
    const cropScanRadius = options.scanRadius || this.config.farming?.scanRadius || 16
    const companionCropScanRadius = options.companionScanRadius || options.taskScanRadius || this.config.farming?.taskScanRadius || null
    const matureWheat = this.findMatureWheat(cropScanRadius)
    const crops = this.findWheatCrops(cropScanRadius)
    const cropsNearCompanion = aiPosition ? this.findWheatCropsNear(aiPosition, companionCropScanRadius || cropScanRadius) : []
    const matureWheatNearCompanion = cropsNearCompanion.filter(crop => crop.mature)
    const droppedItems = this.findDroppedItems(options.scanRadius || 16)
    const nearbyEntities = this.nearbyEntities(options.scanRadius || 16)
    const taskSignals = parseTaskSignals(logs)

    return {
      time: new Date().toISOString(),
      startupConfig: this.startupConfig(),
      configuredAiUsername: this.aiUsername(),
      configuredTestUsername: this.testUsername(),
      acceptancePlayerUsername: this.testUsername(),
      onlinePlayers: companionLookup.onlinePlayers,
      playerPosition,
      acceptancePlayerPosition: playerPosition,
      aiPosition,
      companionPosition: aiPosition,
      companionPositionSource: companionLookup.positionSource,
      companionPositionFromDebug: companionLookup.positionSource === 'debug_status',
      distancePlayerToAi: distance(playerPosition, aiPosition),
      recommendedTeleportCommand: companionLookup.recommendedTeleportCommand,
      companionLookup,
      configuredAiOnline: companionLookup.exactOnline,
      configuredAiVisible: companionLookup.exactVisible,
      nearbyBlocks: this.nearbyBlockCounts(options.scanRadius || 8),
      nearbyBlocksSummary: this.nearbyBlockCounts(options.scanRadius || 8),
      matureWheat,
      matureWheatNearCompanion,
      crops,
      cropsNearCompanion,
      chest,
      droppedItems,
      nearbyEntities,
      nearbyEntitiesSummary: nearbyEntities,
      chatMessages: this.chatMessages.slice(-12),
      debugStatus,
      debugStatusAvailable: Boolean(debugStatus?.ok),
      debugStatusPossibleReason: debugStatus?.ok ? [] : debugStatusPossibleReasons(),
      taskSignals,
      logCursor: this.createLogCursor()
    }
  }

  observeAiPosition() {
    const player = this.bot?.players?.[this.aiUsername()]
    if (player?.entity?.position) return positionJson(player.entity.position)
    return null
  }

  companionLookup(playerPosition = null, debugStatus = null) {
    const configuredAiUsername = this.aiUsername()
    const acceptancePlayerUsername = this.testUsername()
    const onlinePlayers = this.onlinePlayers()
    const exact = onlinePlayers.find(player => player.username === configuredAiUsername)
    const debugPosition = debugBotPosition(debugStatus, configuredAiUsername)
    const similarPlayers = onlinePlayers
      .filter(player => player.username !== configuredAiUsername && isSimilarName(configuredAiUsername, player.username))
      .map(player => ({
        username: player.username,
        entityVisible: player.entityVisible,
        position: player.position,
        matchType: player.username.toLowerCase() === configuredAiUsername.toLowerCase() ? 'case_insensitive' : 'similar'
      }))

    if (exact) {
      const entityPosition = exact.position || null
      const positionSource = entityPosition ? 'entity' : (debugPosition ? 'debug_status' : 'none')
      const position = entityPosition || debugPosition || null
      const exactVisible = Boolean(exact.entityVisible && entityPosition)
      const distanceToAcceptancePlayer = distance(playerPosition, position)
      return {
        configuredAiUsername,
        acceptancePlayerUsername,
        exactOnline: true,
        exactVisible,
        onlineAndVisible: exactVisible,
        onlineButNotVisible: !exactVisible,
        onlineWithDebugPosition: Boolean(debugPosition),
        matchedUsername: exact.username,
        matchType: 'exact',
        position,
        positionSource,
        companionPositionFromDebug: positionSource === 'debug_status',
        distanceToAcceptancePlayer,
        onlinePlayers,
        similarPlayers,
        recommendedTeleportCommand: `/tp ${configuredAiUsername} ${acceptancePlayerUsername}`,
        suggestion: exactVisible
          ? null
          : (debugPosition
              ? 'Configured AI player is online but not entity-visible; using debug_status botPosition as fallback evidence.'
              : 'Configured AI player is online but its entity is not visible to the acceptance player. Move both players into the same dimension and nearby area.'),
        blockedReason: exactVisible || debugPosition ? null : 'configured_ai_online_but_not_visible'
      }
    }

    const closest = similarPlayers[0]
    return {
      configuredAiUsername,
      acceptancePlayerUsername,
      exactOnline: false,
      exactVisible: false,
      onlineAndVisible: false,
      onlineButNotVisible: false,
      onlineWithDebugPosition: false,
      matchedUsername: null,
      matchType: null,
      position: null,
      positionSource: 'none',
      companionPositionFromDebug: false,
      distanceToAcceptancePlayer: null,
      onlinePlayers,
      similarPlayers,
      recommendedTeleportCommand: `/tp ${configuredAiUsername} ${acceptancePlayerUsername}`,
      suggestion: closest
        ? `Configured AI username is ${configuredAiUsername}, but online player ${closest.username} is similar. Should ACCEPTANCE_AI_USERNAME=${closest.username}?`
        : `Configured AI username ${configuredAiUsername} is not online or visible. Start that bot, or set ACCEPTANCE_AI_USERNAME to the exact in-game bot name.`,
      blockedReason: 'configured_ai_not_online'
    }
  }

  onlinePlayers() {
    return Object.values(this.bot?.players || {}).map(player => ({
      username: player.username,
      entityVisible: Boolean(player.entity),
      position: player.entity?.position ? positionJson(player.entity.position) : null
    }))
  }

  findWheatCrops(radius = 16) {
    const wheatId = this.bot.registry.blocksByName.wheat?.id
    if (wheatId == null) return []
    const positions = this.bot.findBlocks({ matching: wheatId, maxDistance: radius, count: 128 })
    return positions.map(position => {
      const block = this.bot.blockAt(position)
      const age = cropAge(block)
      return { position: positionJson(position), age, mature: age === 7 }
    })
  }

  findMatureWheat(radius = 16) {
    return this.findWheatCrops(radius).filter(crop => crop.mature)
  }

  findWheatCropsNear(center, radius = 16) {
    const wheatId = this.bot.registry.blocksByName.wheat?.id
    if (wheatId == null || !center) return []
    const origin = toVec3(center)
    const seen = new Set()
    const crops = []
    const horizontalRadius = Math.ceil(radius)
    const verticalRadius = Math.min(4, horizontalRadius)

    for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
      for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
        for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
          const position = new Vec3(
            Math.floor(origin.x) + dx,
            Math.floor(origin.y) + dy,
            Math.floor(origin.z) + dz
          )
          const distanceToCenter = distance(positionJson(position), positionJson(origin))
          if (distanceToCenter == null || distanceToCenter > radius) continue
          const key = `${position.x},${position.y},${position.z}`
          if (seen.has(key)) continue
          seen.add(key)
          const block = this.bot.blockAt(position)
          if (block?.type !== wheatId && block?.name !== 'wheat') continue
          const age = cropAge(block)
          crops.push({
            position: positionJson(position),
            age,
            mature: age === 7,
            distanceToCompanion: distanceToCenter
          })
        }
      }
    }

    return crops.sort((a, b) => a.distanceToCompanion - b.distanceToCompanion)
  }

  async observeNearestChest(options = {}) {
    const block = this.findNearestChest(options.scanRadius || this.config.storage?.scanRadius || 16)
    if (!block) return { ok: false, error: 'chest_not_found', counts: {}, position: null }
    return this.observeContainerBlock(block, 'observe_chest_open_timeout')
  }

  async observeContainerAt(position, label = 'observe_chest_open_timeout') {
    const block = this.bot.blockAt(toVec3(position))
    if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) {
      return { ok: false, error: 'container_not_found', counts: {}, position: positionJson(position), blockName: block?.name || null }
    }
    return this.observeContainerBlock(block, label)
  }

  async observeContainerBlock(block, label = 'observe_chest_open_timeout') {
    let container
    try {
      container = await this.openContainerBlock(block, label)
      const counts = {}
      for (const item of container.containerItems()) {
        counts[item.name] = (counts[item.name] || 0) + item.count
      }
      return { ok: true, position: positionJson(block.position), blockName: block.name, counts }
    } finally {
      if (container) container.close()
    }
  }

  findNearestChest(radius = 16) {
    const names = ['chest', 'trapped_chest', 'barrel']
    const ids = names.map(name => this.bot.registry.blocksByName[name]?.id).filter(id => id != null)
    const positions = this.bot.findBlocks({ matching: ids, maxDistance: radius, count: 16 })
    if (!positions.length) return null
    positions.sort((a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position))
    return this.bot.blockAt(positions[0])
  }

  nearbyBlockCounts(radius = 8) {
    const counts = {}
    const center = this.bot.entity.position
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -Math.min(4, radius); dy <= Math.min(4, radius); dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const block = this.bot.blockAt(center.offset(dx, dy, dz))
          if (block?.name) counts[block.name] = (counts[block.name] || 0) + 1
        }
      }
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20))
  }

  findDroppedItems(radius = 16) {
    return Object.values(this.bot.entities)
      .filter(entity => entity.name === 'item' && this.bot.entity.position.distanceTo(entity.position) <= radius)
      .map(entity => ({
        id: entity.id,
        position: positionJson(entity.position),
        itemName: entity.metadata?.[8]?.itemId || entity.displayName || 'item'
      }))
  }

  nearbyEntities(radius = 16) {
    return Object.values(this.bot.entities)
      .filter(entity => entity.position && this.bot.entity.position.distanceTo(entity.position) <= radius)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        type: entity.type,
        username: entity.username || null,
        position: positionJson(entity.position),
        distance: round(this.bot.entity.position.distanceTo(entity.position))
      }))
      .slice(0, 40)
  }

  createLogCursor() {
    const logPath = this.logPath()
    if (!fs.existsSync(logPath)) return 0
    return fs.statSync(logPath).size
  }

  readLogsSince(cursor = 0, options = {}) {
    const logPath = this.logPath()
    if (!fs.existsSync(logPath)) return []
    const stat = fs.statSync(logPath)
    if (stat.size <= cursor) return []
    const text = fs.readFileSync(logPath, 'utf8').slice(cursor)
    const lines = text.split(/\r?\n/).filter(Boolean)
    const limit = options.limit ?? 300
    if (limit === 0 || limit === false) return lines
    return lines.slice(-limit)
  }

  readRecentLogs(count = 80) {
    const logPath = this.logPath()
    if (!fs.existsSync(logPath)) return []
    return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-count)
  }

  logPath() {
    return path.resolve(this.rootDir, process.env.ACCEPTANCE_LOG_PATH || this.config.logPath || 'logs/bot-current.log')
  }

  async wait(ms) {
    await sleep(ms)
  }

  async waitForLog(patterns, timeoutMs = 30000, cursor = this.createLogCursor()) {
    const regexes = patterns.map(pattern => pattern instanceof RegExp ? pattern : new RegExp(pattern))
    let latest = []
    await waitUntil(() => {
      latest = this.readLogsSince(cursor)
      return latest.some(line => regexes.some(regex => regex.test(line)))
    }, timeoutMs).catch(() => {})
    return latest
  }

  async requestDebugStatus(timeoutMs = null) {
    const waitMs = resolvePositiveNumber(
      timeoutMs,
      process.env.ACCEPTANCE_DEBUG_STATUS_TIMEOUT_MS,
      this.config.debugStatusTimeoutMs,
      9000
    )
    const attempts = []
    for (const command of ['debug_status', 'get_task_status']) {
      const cursor = this.createLogCursor()
      this.bot.chat(command)
      const lines = await this.waitForLog([/\[DEBUG_STATUS\]/], waitMs, cursor)
      const parsed = latestParsedDebugStatus(lines)
      attempts.push({ command, observed: Boolean(parsed.line), parsed: Boolean(parsed.ok), timeoutMs: waitMs })
      if (!parsed.line) continue
      if (parsed.ok) return { ok: true, command, status: parsed.status, attempts }
      return { ok: false, error: parsed.error, command, line: parsed.line, attempts, possibleReason: debugStatusPossibleReasons() }
    }
    const fallback = this.latestDebugStatusFromRecentLogs()
    if (fallback.ok) return { ok: true, command: 'recent_log_fallback', status: fallback.status, attempts: [...attempts, { command: 'recent_log_fallback', observed: true }] }
    return { ok: false, error: 'debug_status_not_observed', attempts, possibleReason: debugStatusPossibleReasons() }
  }

  latestDebugStatusFromRecentLogs() {
    const parsed = latestParsedDebugStatus(this.readRecentLogs(1200))
    if (!parsed.line) return { ok: false, error: 'debug_status_recent_log_missing' }
    return parsed
  }

  async runServerCommand(command) {
    const text = String(command || '').replace(/^\//, '')
    const sentAt = new Date().toISOString()
    const before = this.systemMessages.length
    this.bot.chat(`/${text}`)
    await sleep(700)
    const messages = this.systemMessages.slice(before)
    const denied = messages.find(entry => commandDeniedMessage(entry.message))
    return {
      command: `/${text}`,
      sentAt,
      messages,
      commandDenied: Boolean(denied),
      deniedMessage: denied?.message || null
    }
  }

  canUseCreativeFixtures() {
    if (this.testUsername() !== 'accept_tester') return false
    return this.isCreativeMode() && Boolean(this.bot?.creative?.setInventorySlot)
  }

  isCreativeMode() {
    return this.bot?.game?.gameMode === 'creative' ||
      this.bot?.player?.gameMode === 'creative' ||
      this.bot?.player?.gamemode === 1
  }

  async prepareCreativeSeedChest(position, seedCount = 16) {
    if (!this.canUseCreativeFixtures()) {
      return {
        attempted: false,
        mode: 'creative',
        reason: 'acceptance_player_not_in_creative_or_not_accept_tester',
        testUsername: this.testUsername(),
        gameMode: this.bot?.game?.gameMode || this.bot?.player?.gameMode || this.bot?.player?.gamemode || null
      }
    }

    const chestPosition = toVec3(position)
    const placed = await this.placeCreativeBlock(chestPosition, 'chest', 36)
    await this.flyNear(chestPosition.offset(0.5, 1.2, 0.5))

    let container
    try {
      const chestBlock = this.bot.blockAt(chestPosition)
      container = await this.openContainerBlock(chestBlock, 'creative_open_seed_chest_timeout')
      await this.setCreativeInventoryItem('wheat_seeds', seedCount, 37)
      const seeds = this.bot.inventory.slots[37] || this.bot.inventory.items().find(item => item?.name === 'wheat_seeds')
      if (!seeds) throw new Error('creative_wheat_seeds_slot_missing')
      await container.deposit(seeds.type, seeds.metadata, seedCount)
      await sleep(250)
      const counts = {}
      for (const item of container.containerItems()) {
        counts[item.name] = (counts[item.name] || 0) + item.count
      }
      return {
        attempted: true,
        mode: 'creative',
        preparedBy: this.testUsername(),
        linxiaUsedCommands: false,
        chestPosition: positionJson(chestPosition),
        seedCount,
        observedCounts: counts,
        placed
      }
    } finally {
      if (container) container.close()
    }
  }

  async prepareCreativeWheatFarm(base) {
    if (!this.canUseCreativeFixtures()) {
      return {
        attempted: false,
        mode: 'creative',
        reason: 'acceptance_player_not_in_creative_or_not_accept_tester',
        testUsername: this.testUsername(),
        gameMode: this.bot?.game?.gameMode || this.bot?.player?.gameMode || this.bot?.player?.gamemode || null
      }
    }

    const plots = []
    for (let i = 0; i < 3; i++) {
      const ground = new Vec3(base.x + i, base.groundY, base.z)
      const crop = new Vec3(base.x + i, base.cropY, base.z)
      await this.prepareCreativeFarmland(ground, crop)
      if (i < 2) {
        await this.plantCreativeWheat(ground, crop)
        await this.growCreativeWheat(crop)
      }
      plots.push({
        ground: positionJson(ground),
        crop: positionJson(crop),
        intendedState: i < 2 ? 'mature_wheat' : 'empty_farmland'
      })
    }

    return {
      attempted: true,
      mode: 'creative',
      preparedBy: this.testUsername(),
      linxiaUsedCommands: false,
      plots
    }
  }

  async prepareCreativeFarmland(ground, crop) {
    await this.flyNear(crop.offset(0.5, 1.3, 0.5))
    await this.clearCreativeBlock(crop)
    let groundBlock = this.bot.blockAt(ground)
    if (!groundBlock || !['dirt', 'grass_block', 'farmland'].includes(groundBlock.name)) {
      await this.placeCreativeBlock(ground, 'dirt', 36)
      groundBlock = this.bot.blockAt(ground)
    }
    if (groundBlock?.name !== 'farmland') {
      await this.equipCreativeItem('diamond_hoe', 1, 36)
      await withTimeout(this.bot.activateBlock(groundBlock), 4000, 'creative_till_farmland_timeout')
      await sleep(300)
    }
  }

  async plantCreativeWheat(ground, crop) {
    const existing = this.bot.blockAt(crop)
    if (existing?.name === 'wheat') return
    await this.equipCreativeItem('wheat_seeds', 64, 37)
    const farmland = this.bot.blockAt(ground)
    await withTimeout(this.bot.placeBlock(farmland, new Vec3(0, 1, 0)), 4000, 'creative_plant_wheat_timeout')
    await sleep(300)
  }

  async growCreativeWheat(crop) {
    await this.equipCreativeItem('bone_meal', 64, 38)
    for (let i = 0; i < 12; i++) {
      const cropBlock = this.bot.blockAt(crop)
      if (cropBlock?.name === 'wheat' && cropAge(cropBlock) === 7) return
      if (cropBlock?.name !== 'wheat') throw new Error(`creative_wheat_missing_at_${positionJson(crop).x}_${positionJson(crop).y}_${positionJson(crop).z}`)
      await withTimeout(this.bot.activateBlock(cropBlock), 3000, 'creative_bone_meal_timeout')
      await sleep(200)
    }
  }

  async placeCreativeBlock(position, itemName, slot = 36) {
    const target = toVec3(position)
    await this.flyNear(target.offset(0.5, 1.3, 0.5))
    const existing = this.bot.blockAt(target)
    if (existing?.name === itemName) return { position: positionJson(target), blockName: existing.name, alreadyPresent: true }
    await this.clearCreativeBlock(target)
    const below = this.bot.blockAt(target.offset(0, -1, 0))
    if (!below || below.name === 'air') throw new Error(`fixture_target_has_no_support:${itemName}@${JSON.stringify(positionJson(target))}`)
    await this.equipCreativeItem(itemName, 64, slot)
    await withTimeout(this.bot.placeBlock(below, new Vec3(0, 1, 0)), 4000, `creative_place_${itemName}_timeout`)
    await sleep(300)
    const placed = this.bot.blockAt(target)
    return { position: positionJson(target), blockName: placed?.name || null, alreadyPresent: false }
  }

  findSupportedFixturePosition(options = {}) {
    const center = options.center ? toVec3(options.center) : this.bot.entity.position
    const radius = Number(options.radius || 5)
    const preferredY = Math.floor(center.y)
    const candidates = []
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -3; dy <= 2; dy++) {
          const target = new Vec3(Math.floor(center.x) + dx, preferredY + dy, Math.floor(center.z) + dz)
          const block = this.bot.blockAt(target)
          const below = this.bot.blockAt(target.offset(0, -1, 0))
          const above = this.bot.blockAt(target.offset(0, 1, 0))
          if (block?.name !== 'air') continue
          if (!below || below.name === 'air') continue
          if (above && above.name !== 'air') continue
          candidates.push({
            position: target,
            distance: center.distanceTo(target.offset(0.5, 0, 0.5))
          })
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance)
    return candidates[0]?.position || new Vec3(Math.floor(center.x) + 2, preferredY, Math.floor(center.z) + 2)
  }

  async openContainerBlock(block, label = 'open_container_timeout') {
    const opener = block?.name === 'barrel'
      ? (this.bot.openContainer || this.bot.openChest)
      : (this.bot.openChest || this.bot.openContainer)
    if (typeof opener !== 'function') throw new Error('missing_open_container_api')
    return withTimeout(opener.call(this.bot, block), 6000, label)
  }

  async clearCreativeBlock(position) {
    const block = this.bot.blockAt(toVec3(position))
    if (!block || block.name === 'air') return false
    await this.flyNear(block.position.offset(0.5, 1.3, 0.5))
    await withTimeout(this.bot.dig(block, true), 4000, 'creative_dig_timeout').catch(() => {})
    await sleep(150)
    return true
  }

  async equipCreativeItem(itemName, count = 64, slot = 36) {
    await this.setCreativeInventoryItem(itemName, count, slot)
    const item = this.bot.inventory.slots[slot] || this.bot.inventory.items().find(candidate => candidate?.name === itemName)
    if (!item) throw new Error(`creative_item_not_available:${itemName}`)
    await this.bot.equip(item, 'hand')
    return item
  }

  async setCreativeInventoryItem(itemName, count = 64, slot = 36) {
    const definition = this.bot.registry.itemsByName[itemName]
    if (!definition) throw new Error(`unknown_creative_item:${itemName}`)
    const Item = require('prismarine-item')(this.bot.registry)
    const item = new Item(definition.id, count)
    await this.bot.creative.setInventorySlot(slot, item)
    await sleep(120)
    return item
  }

  async flyNear(position) {
    const destination = toVec3(position)
    if (this.canUseCreativeFixtures()) {
      const current = this.bot.entity?.position
      if (!current || current.distanceTo(destination) > 5) {
        try {
          await withTimeout(this.bot.creative.flyTo(destination), 6000, 'creative_fly_timeout')
        } catch (err) {
          await this.walkNear(destination, 10000).catch(() => {
            throw err
          })
        }
      }
      return
    }
    await this.walkNear(destination, 8000)
  }

  async walkNear(destination, timeoutMs = 8000) {
    const goal = new goals.GoalNear(Math.floor(destination.x), Math.floor(destination.y), Math.floor(destination.z), 2)
    this.bot.pathfinder.setGoal(goal)
    await waitUntil(() => this.bot.entity?.position?.distanceTo(destination) <= 3, timeoutMs).catch(() => {})
    this.bot.pathfinder.setGoal(null)
  }
}

function commandDeniedMessage(message) {
  return /permission|not allowed|unknown command|requires operator|cheat|denied|没有权限|权限不足|未知的命令|无法执行/i.test(String(message || ''))
}

function parseTaskSignals(lines = []) {
  const signals = {
    intents: [],
    taskStarts: [],
    taskTicks: [],
    farming: {
      harvestAttempts: 0,
      harvestSuccesses: 0,
      plantAttempts: 0,
      plantSuccesses: 0,
      taskSuccess: false,
      taskFailure: null
    },
    storage: {
      chestSearches: 0,
      withdrawnItems: [],
      storedItems: [],
      taskSuccess: false,
      taskFailure: null
    },
    crafting: {
      taskSuccess: false,
      taskFailure: null,
      craftedItems: []
    },
    building: {
      siteScans: 0,
      steps: 0,
      validationOk: false,
      validationFailure: null,
      taskSuccess: false,
      taskFailure: null
    },
    following: {
      started: false,
      stopped: false
    }
  }

  for (const line of lines) {
    if (line.includes('[INTENT_RESULT]')) signals.intents.push(line)
    if (line.includes('[TASK_STARTED]')) signals.taskStarts.push(line)
    if (line.includes('[TASK_TICK]')) signals.taskTicks.push(line)
    if (line.includes('[FOLLOW_TASK_START]')) signals.following.started = true
    if (line.includes('[TASK_INTERRUPTED]') || line.includes('stop_follow')) signals.following.stopped = true
    if (line.includes('[CROP_HARVEST_ATTEMPT]')) signals.farming.harvestAttempts += 1
    if (line.includes('[CROP_HARVEST_SUCCESS]')) signals.farming.harvestSuccesses += 1
    if (line.includes('[PLANT_ATTEMPT]')) signals.farming.plantAttempts += 1
    if (line.includes('[PLANT_SUCCESS]')) signals.farming.plantSuccesses += 1
    if (line.includes('[FARMING_TASK_SUCCESS]')) signals.farming.taskSuccess = true
    if (line.includes('[FARMING_TASK_FAILED]')) signals.farming.taskFailure = line
    if (line.includes('[WITHDRAW_SEARCH_CHEST]')) signals.storage.chestSearches += 1
    if (line.includes('[STORAGE_TASK_SUCCESS]')) signals.storage.taskSuccess = true
    if (line.includes('[STORAGE_TASK_FAILED]')) signals.storage.taskFailure = line
    if (line.includes('[TaskManager] completed') && line.includes('craft_item')) signals.crafting.taskSuccess = true
    if (line.includes('[TaskManager] failed') && line.includes('craft_item')) signals.crafting.taskFailure = line
    if (line.includes('[BUILD_SITE_SCAN]')) signals.building.siteScans += 1
    if (line.includes('[BUILD_STEP]')) signals.building.steps += 1
    if (line.includes('[BUILD_VALIDATION] ok=true')) signals.building.validationOk = true
    if (line.includes('[BUILD_VALIDATION] ok=false')) signals.building.validationFailure = line
    if (line.includes('[TaskManager] completed') && line.includes('build_blueprint')) signals.building.taskSuccess = true
    if (line.includes('[TaskManager] failed') && line.includes('build_blueprint')) signals.building.taskFailure = line
    const craftMatch = line.match(/\[crafting\].*targetItem=([a-z0-9_]+).*result=ok/)
    if (craftMatch) {
      signals.crafting.taskSuccess = true
      signals.crafting.craftedItems.push({ itemName: craftMatch[1] })
    }
    const withdrawMatch = line.match(/\[WITHDRAW_[A-Z_]*SUCCESS\].*item=([a-z0-9_]+).*count=(\d+)/)
    if (withdrawMatch) signals.storage.withdrawnItems.push({ itemName: withdrawMatch[1], count: Number(withdrawMatch[2]) })
    const selectedMatch = line.match(/selectedItems=(\[.*\]) result=ok/)
    if (selectedMatch) {
      try {
        const items = JSON.parse(selectedMatch[1])
        if (Array.isArray(items)) signals.storage.withdrawnItems.push(...items)
      } catch {}
    }
    const depositMatch = line.match(/\[CHEST_DEPOSIT_SUCCESS\].*item=([a-z0-9_]+).*count=(\d+)/)
    if (depositMatch) signals.storage.storedItems.push({ itemName: depositMatch[1], count: Number(depositMatch[2]) })
    const depositedMatch = line.match(/deposited=(\[.*\]) result=ok/)
    if (depositedMatch) {
      try {
        const items = JSON.parse(depositedMatch[1])
        if (Array.isArray(items)) signals.storage.storedItems.push(...items)
      } catch {}
    }
  }

  return signals
}

function cropAge(block) {
  const props = block?.getProperties?.()
  const age = props?.age ?? block?.metadata
  const number = Number(age)
  return Number.isFinite(number) ? number : null
}

function waitForEvent(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${event}`))
    }, timeoutMs)
    const onEvent = (...args) => {
      cleanup()
      resolve(args)
    }
    const onError = err => {
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      emitter.removeListener(event, onEvent)
      emitter.removeListener('error', onError)
    }
    emitter.once(event, onEvent)
    emitter.once('error', onError)
  })
}

function waitUntil(predicate, timeoutMs, intervalMs = 500) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        reject(new Error('wait_until_timeout'))
      }
    }, intervalMs)
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(label || 'operation_timeout')), timeoutMs)
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timeout)
        resolve(value)
      },
      err => {
        clearTimeout(timeout)
        reject(err)
      }
    )
  })
}

function positionJson(position) {
  if (!position) return null
  return { x: round(position.x), y: round(position.y), z: round(position.z) }
}

function toVec3(position) {
  if (position instanceof Vec3) return position
  return new Vec3(Number(position.x), Number(position.y), Number(position.z))
}

function debugBotPosition(debugStatus, configuredAiUsername) {
  if (!debugStatus?.ok) return null
  const status = debugStatus.status || {}
  if (!status.botPosition) return null
  if (status.botUsername && normalizeName(status.botUsername) !== normalizeName(configuredAiUsername)) return null
  return positionJson(status.botPosition)
}

function latestParsedDebugStatus(lines) {
  let lastError = null
  for (const line of [...(lines || [])].reverse()) {
    if (!String(line).includes('[DEBUG_STATUS]')) continue
    const parsed = parseDebugStatusLine(line)
    if (parsed.ok) return { ...parsed, line }
    lastError = { ...parsed, line }
  }
  return lastError || { ok: false, error: 'debug_status_line_missing', line: null }
}

function parseDebugStatusLine(line) {
  const jsonStart = String(line).indexOf('{')
  if (jsonStart < 0) return { ok: false, error: 'debug_status_json_missing' }
  try {
    return { ok: true, status: JSON.parse(String(line).slice(jsonStart)) }
  } catch (err) {
    return { ok: false, error: `debug_status_json_parse_failed:${err.message}` }
  }
}

function round(value) {
  return Math.round(Number(value) * 100) / 100
}

function resolvePositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return 1
}

function distance(a, b) {
  if (!a || !b) return null
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  const dz = Number(a.z) - Number(b.z)
  return round(Math.sqrt(dx * dx + dy * dy + dz * dz))
}

function isSimilarName(configured, actual) {
  const a = normalizeName(configured)
  const b = normalizeName(actual)
  if (!a || !b) return false
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  return levenshtein(a, b) <= Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.35))
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '')
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  return dp[a.length][b.length]
}

function debugStatusPossibleReasons() {
  return [
    'AI bot has not been restarted after debug_status support was added.',
    'AI bot is not online.',
    'AI bot is not accepting chat messages from the acceptance test player.',
    'ACCEPTANCE_TEST_USERNAME is not allowed by the AI bot.',
    'Debug command name does not match the running bot version.'
  ]
}

module.exports = MinecraftAdapter
