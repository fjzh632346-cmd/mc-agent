const assert = require('assert')
const { EventEmitter } = require('events')
const minecraftData = require('minecraft-data')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const move = require('../actions/move')
const mine = require('../actions/mine')
const fight = require('../actions/fight')
const inventory = require('../actions/inventory')
const build = require('../actions/build')
const craft = require('../actions/craft')
const smelt = require('../actions/smelt')
const farm = require('../actions/farm')
const explore = require('../actions/explore')
const pickup = require('../actions/pickup')
const storage = require('../actions/storage')
const { EquipmentSystem } = require('../systems/EquipmentSystem')
const { itemNameForBlock } = require('../utils/building-material-map')

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    clone() {
      return vec(x, y, z)
    },
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function createContext() {
  const block = { name: 'stone', position: vec(1, 64, 0) }
  const crop = { name: 'wheat', metadata: 7, position: vec(1, 64, 1) }
  const items = [
    { name: 'bread', count: 2 },
    { name: 'stone_pickaxe', count: 1 },
    { name: 'dirt', count: 8 },
    { name: 'wheat_seeds', count: 3 }
  ]
  const bot = {
    username: 'Bot',
    health: 20,
    entity: { position: vec(0, 64, 0), onGround: true },
    entities: {
      10: { id: 10, name: 'zombie', type: 'mob', position: vec(2, 64, 0) },
      11: { id: 11, username: 'Alex', type: 'player', position: vec(2, 64, 0) }
    },
    players: {
      Alex: { username: 'Alex', entity: { position: vec(3, 64, 0) } }
    },
    registry: {
      blocksByName: {
        stone: { id: 1 },
        wheat: { id: 2 }
      },
      itemsByName: {
        stick: { id: 100 },
        bread: { id: 101 },
        cobblestone: { id: 102 },
        raw_iron: { id: 103 },
        diamond: { id: 104 },
        oak_log: { id: 105 },
        sand: { id: 106 },
        dirt: { id: 107 },
        raw_copper: { id: 108 }
      },
      itemsById: {
        100: { id: 100, name: 'stick' },
        101: { id: 101, name: 'bread' },
        102: { id: 102, name: 'cobblestone' },
        103: { id: 103, name: 'raw_iron' },
        104: { id: 104, name: 'diamond' },
        105: { id: 105, name: 'oak_log' },
        106: { id: 106, name: 'sand' },
        107: { id: 107, name: 'dirt' },
        108: { id: 108, name: 'raw_copper' }
      },
      itemsArray: [
        { id: 100, name: 'stick' },
        { id: 101, name: 'bread' },
        { id: 102, name: 'cobblestone' },
        { id: 103, name: 'raw_iron' },
        { id: 104, name: 'diamond' },
        { id: 105, name: 'oak_log' },
        { id: 106, name: 'sand' },
        { id: 107, name: 'dirt' },
        { id: 108, name: 'raw_copper' }
      ]
    },
    inventory: {
      items: () => items,
      slots: Array.from({ length: 45 }, (_, index) => (index >= 9 && index < 13 ? { name: 'occupied' } : null))
    },
    heldItem: items[1],
    pathfinder: {
      setMovements() {},
      setGoal() {},
      stop() {}
    },
    pvp: {
      attacked: null,
      attack(entity) {
        this.attacked = entity
      },
      stop() {
        this.attacked = null
      }
    },
    blockAt(position) {
      if (position.x === 1 && position.y === 64 && position.z === 0) return block
      if (position.x === 1 && position.y === 64 && position.z === 1) return crop
      if (position.y === 63) return { name: 'farmland', position: vec(position.x, position.y, position.z) }
      return { name: 'air', position: vec(position.x, position.y, position.z) }
    },
    findBlock() {
      return block
    },
    findBlocks() {
      return [block.position]
    },
    canDigBlock() {
      return true
    },
    async dig(blockToDig) {
      simulateBlockDrop(this, blockToDig)
    },
    async equip(item) {
      this.heldItem = item
    },
    async placeBlock() {},
    recipesFor() {
      return [{ result: { id: 100 } }]
    },
    async craft() {}
  }

  const blackboard = new Blackboard({
    mobs: {
      dangerLevel: 'none',
      hostileMobs: [{ id: 10, name: 'zombie', distance: 2 }]
    },
    player: {
      ownerPosition: { x: 3, y: 64, z: 0 }
    }
  })

  return {
    bot,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard
  }
}

function testReservedBuildPositionsAreExcludedFromPathfinderDig() {
  const movements = { exclusionAreasBreak: [] }
  const reserved = { x: 4, y: 75, z: -2 }
  move.addReservedBreakExclusions(movements, {
    reservedPositions: new Set([`${reserved.x},${reserved.y},${reserved.z}`])
  })
  assert.strictEqual(movements.exclusionAreasBreak.length, 1)
  assert.strictEqual(
    movements.exclusionAreasBreak[0]({ position: reserved }),
    Infinity
  )
  assert.strictEqual(
    movements.exclusionAreasBreak[0]({ position: { x: 5, y: 75, z: -2 } }),
    0
  )
}

function simulateBlockDrop(bot, block) {
  const dropName = {
    stone: 'cobblestone',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
    diamond_ore: 'diamond',
    oak_log: 'oak_log',
    sand: 'sand',
    dirt: 'dirt',
    copper_ore: 'raw_copper',
    deepslate_copper_ore: 'raw_copper'
  }[block?.name] || block?.name
  if (!dropName) return
  const item = bot.registry.itemsByName[dropName] || { id: 999, name: dropName }
  const id = 1000 + Object.keys(bot.entities || {}).length
  bot.entity.position = block.position
  bot.entities[id] = {
    id,
    name: 'item',
    type: 'object',
    displayName: 'Item',
    metadata: { itemId: item.id },
    position: block.position
  }
  const existing = bot.inventory.items().find(candidate => candidate.name === dropName)
  if (existing) existing.count += 1
  else bot.inventory.items().push({ name: dropName, count: 1 })
}

function assertAllMethodsExist() {
  for (const fn of ['moveTo', 'followEntity', 'stopMoving']) assert.strictEqual(typeof move[fn], 'function')
  for (const fn of ['findNearbyBlocks', 'mineBlock', 'mineNearestBlock']) assert.strictEqual(typeof mine[fn], 'function')
  for (const fn of ['findNearbyHostileMob', 'attackMob', 'stopCombat']) assert.strictEqual(typeof fight[fn], 'function')
  for (const fn of ['getInventorySummary', 'countItem', 'hasItem', 'getEmptySlotCount', 'isInventoryFull', 'equipItem']) assert.strictEqual(typeof inventory[fn], 'function')
  for (const fn of ['placeBlock', 'canPlaceBlock', 'clearBlockForBuilding']) assert.strictEqual(typeof build[fn], 'function')
  for (const fn of ['canCraft', 'craftItem']) assert.strictEqual(typeof craft[fn], 'function')
  for (const fn of ['findNearbyCrops', 'harvestCrop', 'plantSeed']) assert.strictEqual(typeof farm[fn], 'function')
  for (const fn of ['getRandomNearbyPosition', 'moveRandomlyNearby', 'returnToPlayer']) assert.strictEqual(typeof explore[fn], 'function')
  for (const fn of ['findNearestDroppedItem', 'pickupNearestItem', 'isDroppedItemEntity']) assert.strictEqual(typeof pickup[fn], 'function')
}

async function testFailuresDoNotCrash() {
  assert.strictEqual((await move.moveTo(createContext(), null)).ok, false)
  assert.strictEqual((await mine.mineBlock(createContext(), null)).error, 'missing_block')
  assert.strictEqual((await fight.attackMob(createContext(), { username: 'Alex', position: vec(1, 64, 0) })).error, 'refuse_attack_player')
  assert.strictEqual(inventory.countItem(createContext(), '').error, 'missing_item_name')
  assert.strictEqual(build.canPlaceBlock(createContext(), null).error, 'missing_position')
  assert.strictEqual(craft.canCraft(createContext(), '').error, 'missing_item_name')
  assert.strictEqual((await farm.plantSeed(createContext(), null, 'wheat_seeds')).error, 'missing_position')
}

async function testMoveToRegistersInventoryScaffoldBlocksWhenAllowed() {
  const ctx = createContext()
  let capturedMovements = null
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_planks', count: 8 }]
  ctx.bot.pathfinder.setMovements = movements => {
    capturedMovements = movements
  }

  const result = await move.moveTo(ctx, { x: 0, y: 64, z: 0 }, { allowScaffolding: true })

  assert.strictEqual(result.ok, true)
  assert.ok(capturedMovements)
  assert.strictEqual(capturedMovements.allow1by1towers, true)
  assert.ok(capturedMovements.scafoldingBlocks.includes(ctx.bot.registry.itemsByName.dark_oak_planks.id))
}

async function testMoveToExcludesReservedBlueprintCellsFromScaffolding() {
  const ctx = createContext()
  let capturedMovements = null
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 8 }]
  ctx.bot.pathfinder.setMovements = movements => {
    capturedMovements = movements
  }

  const reservedTarget = { x: 4, y: 75, z: 0 }
  const currentTarget = { x: 5, y: 75, z: 0 }
  const result = await move.moveTo(ctx, { x: 0, y: 64, z: 0 }, {
    allowScaffolding: true,
    reservedPositions: new Set(['4,75,0']),
    scaffoldExclusionPositions: [currentTarget]
  })

  assert.strictEqual(result.ok, true)
  assert.ok(capturedMovements)
  // Round 11: the exclusion set must NOT be a cost callback either. Upstream
  // charges it against the walk cell of a forward bridge, so it vetoed legal
  // bridges THROUGH a target cell while happily letting through a bridge whose
  // floor IS the target. The exact-cell filter below is the only enforcement.
  assert.strictEqual(capturedMovements.exclusionAreasPlace.length, 0)
  assert.strictEqual(capturedMovements.exclusionPlace({
    position: vec(reservedTarget.x, reservedTarget.y, reservedTarget.z)
  }), 0)
  assert.strictEqual(capturedMovements.exclusionPlace({
    position: vec(currentTarget.x, currentTarget.y, currentTarget.z)
  }), 0)
  assert.strictEqual(capturedMovements.exclusionPlace({ position: vec(6, 75, 0) }), 0)
  assert.strictEqual(typeof capturedMovements.__scaffoldPlacementCellFilter, 'function')

  // mineflayer-pathfinder's forward-bridge branch charges exclusionPlace
  // against the walk cell above the actual scaffold. The hard filter must use
  // reference + face and reject the formal target itself.
  assert.strictEqual(capturedMovements.__scaffoldPlacementCellFilter({
    toPlace: [{
      x: reservedTarget.x - 1,
      y: reservedTarget.y,
      z: reservedTarget.z,
      dx: 1,
      dy: 0,
      dz: 0
    }]
  }), false)
  assert.strictEqual(capturedMovements.__scaffoldPlacementCellFilter({
    toPlace: [{
      x: currentTarget.x,
      y: currentTarget.y - 1,
      z: currentTarget.z,
      dx: 0,
      dy: 1,
      dz: 0
    }]
  }), false)
  assert.strictEqual(capturedMovements.__scaffoldPlacementCellFilter({
    toPlace: [{ x: 6, y: 74, z: 0, dx: 0, dy: 1, dz: 0 }]
  }), true)
}

async function testMoveToRestrictsControlledScaffoldingToPlannedCells() {
  const ctx = createContext()
  let capturedMovements = null
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 8 }]
  ctx.bot.pathfinder.setMovements = movements => {
    capturedMovements = movements
  }

  const allowed = { x: 6, y: 70, z: 1 }
  const result = await move.moveTo(ctx, { x: 0, y: 64, z: 0 }, {
    allowScaffolding: true,
    scaffoldAllowedPositions: [allowed]
  })

  assert.strictEqual(result.ok, true)
  assert.ok(capturedMovements)
  assert.strictEqual(capturedMovements.exclusionPlace({
    position: vec(allowed.x, allowed.y, allowed.z)
  }), 0)
  // Round 10: the allow-list must NOT be a cost callback. Upstream charges
  // that cost against the walk cell of a forward bridge, which rejected every
  // previewed bridge at execution time. Only the exact-cell neighbor filter
  // below enforces the plan.
  assert.strictEqual(capturedMovements.exclusionPlace({
    position: vec(allowed.x + 1, allowed.y, allowed.z)
  }), 0)
  assert.strictEqual(typeof capturedMovements.__scaffoldPlacementCellFilter, 'function')
  assert.strictEqual(capturedMovements.__scaffoldPlacementCellFilter({
    toPlace: [{
      x: allowed.x,
      y: allowed.y - 1,
      z: allowed.z,
      dx: 0,
      dy: 1,
      dz: 0
    }]
  }), true)
  assert.strictEqual(capturedMovements.__scaffoldPlacementCellFilter({
    toPlace: [{
      x: allowed.x,
      y: allowed.y,
      z: allowed.z,
      dx: 1,
      dy: 0,
      dz: 0
    }]
  }), false)
}

// Round 11: a route the preview found but the executor cannot must say so.
// The planner's verdict was previously swallowed -- pathfinder emits
// path_update, stores the empty path and returns, so a refused route looked
// exactly like a bot standing still until move_timeout.
async function testMoveToReportsPlannerRefusalOncePerWindow() {
  const ctx = createContext()
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 8 }]
  const emitter = new EventEmitter()
  for (const method of ['on', 'once', 'removeListener', 'emit', 'listenerCount']) {
    ctx.bot[method] = (...args) => emitter[method](...args)
  }
  const logs = []
  ctx.logger = { log: message => logs.push(message) }

  let clockNow = 1000
  const target = { x: 40, y: 64, z: 0 }
  ctx.bot.pathfinder.setGoal = () => {
    emitter.emit('path_update', { status: 'noPath', cost: 0 })
    emitter.emit('path_update', { status: 'noPath', cost: 0 })
    emitter.emit('path_update', { status: 'success', cost: 12.25 })
  }
  const walk = () => move.moveTo(ctx, target, {
    timeoutMs: 60,
    allowScaffolding: true,
    reservedPositions: new Set(['4,75,0', '5,75,0']),
    scaffoldAllowedPositions: [{ x: 6, y: 70, z: 1 }],
    pathStatusClock: () => clockNow
  })
  const statusLines = () => logs.filter(line => line.startsWith('[MOVE_PATH_STATUS]'))

  const first = await walk()
  assert.strictEqual(first.ok, false)
  assert.strictEqual(first.error, 'move_timeout')
  assert.strictEqual(statusLines().length, 1, 'repeat refusals inside the window collapse to one line')
  assert.strictEqual(
    statusLines()[0],
    '[MOVE_PATH_STATUS] status=noPath goal=40,64,0 allowList=1 excl=2 cost=0.0',
    'the line carries the verdict, the goal and both constraint sizes'
  )
  assert.ok(!logs.some(line => line.includes('status=success')), 'a route that was found is not reported')
  assert.strictEqual(emitter.listenerCount('path_update'), 0, 'the listener is removed when the move ends')

  // still inside the window: a second attempt at the same goal stays quiet
  await walk()
  assert.strictEqual(statusLines().length, 1, 'the same refusal is not repeated within the window')

  // past the window: the refusal is worth saying again
  clockNow += 6000
  await walk()
  assert.strictEqual(statusLines().length, 2, 'a refusal outside the window is reported again')
  assert.strictEqual(emitter.listenerCount('path_update'), 0)
}

async function testMoveToWaitsForControlledScaffoldOperationToSettle() {
  const ctx = createContext()
  let operationDone = false
  ctx.bot.placeBlock = () => new Promise(resolve => {
    setTimeout(() => {
      operationDone = true
      resolve()
    }, 40)
  })
  ctx.bot.pathfinder.setGoal = goal => {
    ctx.bot.placeBlock({}, {})
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }

  const result = await move.moveTo(ctx, { x: 4, y: 64, z: 0 }, {
    onScaffoldPlaced() {},
    scaffoldPostStopGraceMs: 0,
    scaffoldSettleQuietMs: 10,
    scaffoldSettleTimeoutMs: 500
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(operationDone, true)
}

async function testMoveToWaitsForQueuedControlledScaffoldOperationAfterStop() {
  const ctx = createContext()
  let operationDone = false
  ctx.bot.placeBlock = () => new Promise(resolve => {
    setTimeout(() => {
      operationDone = true
      resolve()
    }, 25)
  })
  ctx.bot.pathfinder.setGoal = () => {
    // Simulate pathfinder having queued the placement before stop(), without
    // invoking bot.placeBlock until after moveTo has observed goal completion.
    setTimeout(() => ctx.bot.placeBlock({}, {}), 80)
  }

  const result = await move.moveTo(ctx, { x: 4, y: 64, z: 0 }, {
    onScaffoldPlaced() {},
    scaffoldPostStopGraceMs: 150,
    scaffoldSettleQuietMs: 10,
    scaffoldSettleTimeoutMs: 500
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(operationDone, true)
}

async function testMoveToSynchronouslyCancelsLateControlledScaffold() {
  const ctx = createContext()
  let goalActive = false
  let nullGoalCount = 0
  let latePlacementCount = 0
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.clearControlStates = () => {}
  ctx.bot.placeBlock = async () => {
    latePlacementCount += 1
  }
  ctx.bot.pathfinder.stop = () => {
    // Match mineflayer-pathfinder 2.4.5: stop() only requests a later stop and
    // does not synchronously cancel its closure-local placement state.
  }
  ctx.bot.pathfinder.isBuilding = () => goalActive
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) {
      nullGoalCount += 1
      goalActive = false
      return
    }
    goalActive = true
    setTimeout(() => {
      if (goalActive) ctx.bot.placeBlock({}, {})
    }, 80)
  }

  const result = await move.moveTo(ctx, { x: 4, y: 64, z: 0 }, {
    timeoutMs: 1,
    onScaffoldPlaced() {},
    scaffoldPostStopGraceMs: 0,
    scaffoldSettleQuietMs: 10,
    scaffoldSettleTimeoutMs: 500
  })
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'move_timeout')
  assert.strictEqual(nullGoalCount, 1)
  assert.strictEqual(latePlacementCount, 0)
}

async function testMoveToSynchronouslyQuiescesReachedCondition() {
  const ctx = createContext()
  const calls = []
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder.setGoal = goal => calls.push(['setGoal', goal])
  ctx.bot.pathfinder.stop = () => calls.push(['stop'])
  ctx.bot.pathfinder.isBuilding = () => false
  ctx.bot.clearControlStates = () => calls.push(['clearControlStates'])

  const result = await move.moveTo(ctx, { x: 4, y: 64, z: 0 }, {
    range: 0.8,
    timeoutMs: 20,
    reachedWhen: () => true
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'movement_condition_reached')
  assert.strictEqual(calls.length, 4)
  assert.ok(calls[0][0] === 'setGoal' && calls[0][1] != null)
  assert.deepStrictEqual(calls.slice(1), [
    ['stop'],
    ['setGoal', null],
    ['clearControlStates']
  ])
}

async function testMoveToCanIgnoreYWithNearXZGoal() {
  const ctx = createContext()
  let capturedGoal = null
  ctx.bot.entity.position = vec(0, 72, 0)
  ctx.bot.pathfinder.setGoal = goal => {
    capturedGoal = goal
    ctx.bot.entity.position = vec(goal.x, 72, goal.z)
  }
  ctx.bot.once = (event, callback) => {
    if (event === 'goal_reached') setImmediate(callback)
  }
  ctx.bot.removeListener = () => {}

  const result = await move.moveTo(ctx, { x: 4, y: 80, z: 0 }, {
    ignoreY: true,
    range: 1,
    timeoutMs: 20
  })

  assert.strictEqual(result.ok, true)
  assert.ok(capturedGoal)
  assert.strictEqual(capturedGoal.y, undefined)
  assert.strictEqual(capturedGoal.x, 4)
  assert.strictEqual(capturedGoal.z, 0)
}

async function testLocksReleaseOnSuccessfulActions() {
  let ctx = createContext()
  const equipped = await inventory.equipItem(ctx, 'bread')
  assert.strictEqual(equipped.ok, true)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)

  ctx = createContext()
  const mined = await mine.mineBlock(ctx, ctx.bot.blockAt(vec(1, 64, 0)), { ignoreDanger: true })
  assert.strictEqual(mined.ok, true)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)

  ctx = createContext()
  const hostile = fight.findNearbyHostileMob(ctx, 8)
  assert.strictEqual(hostile.ok, true)
  const attacking = await fight.attackMob(ctx, hostile.data.mob, { holdLock: false })
  assert.strictEqual(attacking.ok, true)
  assert.strictEqual(ctx.actionLock.getOwner('combat'), null)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)

  ctx = createContext()
  const crafted = await craft.craftItem(ctx, 'stick', 1)
  assert.strictEqual(crafted.ok, true)
  assert.strictEqual(ctx.actionLock.getOwner('crafting'), null)
}

function testStandTimeoutMemoCapsRetryMoves() {
  // A stand that already move_timed-out within one placement call must not
  // re-burn the full adaptive move timeout on later retries (L3 renovation:
  // the same unreachable roof stand was walked 5x at up to 45s each).
  const lines = []
  const context = {
    bot: { entity: { position: vec(0, 64, 0) } },
    logger: { log: line => lines.push(String(line)) }
  }
  const stand = { x: 10, y: 88, z: 5 }
  const options = { standTimeoutMemo: new Set(), timeoutMs: 45000 }

  // before any timeout: full budget
  assert.strictEqual(build.standMoveTimeoutWithMemo(context, stand, options), 45000)

  // after a move_timeout on this stand: capped to the XZ-fallback budget
  build.rememberStandTimeout(options, stand)
  assert.strictEqual(build.standMoveTimeoutWithMemo(context, stand, options), 12000)
  assert.ok(lines.some(line => line.includes('[BUILD_PLACE_STAND_TIMEOUT_MEMO]') && line.includes('stand=10,88,5')))

  // a different stand keeps the full budget
  assert.strictEqual(build.standMoveTimeoutWithMemo(context, { x: 11, y: 88, z: 5 }, options), 45000)
  // never raises a budget that is already lower than the cap
  assert.strictEqual(build.standMoveTimeoutWithMemo(context, stand, { ...options, timeoutMs: 8000 }), 8000)
  // no memo (callers outside placeBlock/clear): unchanged behavior
  assert.strictEqual(build.standMoveTimeoutWithMemo(context, stand, { timeoutMs: 45000 }), 45000)
}

function testStandTimeoutBlacklistDiversifiesCandidates() {
  const target = { x: 0, y: 66, z: 0 }
  const candidateA = { x: -1, y: 66, z: 0 }
  const candidateB = { x: 0, y: 66, z: -1 }
  const options = { standTimeoutMemo: new Set(['-1,66,0']) }

  assert.deepStrictEqual(
    build.placementStandAttempts([candidateA, candidateB], target, 2, options),
    [candidateB]
  )
  options.standTimeoutMemo.add('0,66,-1')
  assert.deepStrictEqual(
    build.placementStandAttempts([candidateA, candidateB], target, 2, options),
    []
  )
}

async function testExhaustedStandBlacklistReturnsDiagnosticFailure() {
  const ctx = createContext()
  const target = { x: 0, y: 66, z: 0 }
  const stand = { x: -1, y: 66, z: 0 }
  const result = await build.moveToFirstReachablePlacementStand(ctx, target, [stand], {
    owner: 'test',
    options: { standTimeoutMemo: new Set(['-1,66,0']) }
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'no_reachable_build_stance_after_scaffold_candidates')
  assert.deepStrictEqual(result.blacklistedStandPositions, [stand])
}

function testStandingPlannerRejectsFenceHeightGoal() {
  const ctx = createContext()
  const target = { x: 0, y: 65, z: 0 }
  const fenceSupport = { x: -1, y: 65, z: 0 }
  const fullSupport = { x: 0, y: 65, z: -1 }
  ctx.bot.entity.position = vec(0.5, 66.42, 0.5)
  ctx.bot.blockAt = position => {
    if (position.x === fenceSupport.x && position.y === fenceSupport.y && position.z === fenceSupport.z) {
      return {
        name: 'spruce_fence',
        position,
        shapes: [[0.375, 0, 0.375, 0.625, 1.5, 0.625]]
      }
    }
    if (position.x === fullSupport.x && position.y === fullSupport.y && position.z === fullSupport.z) {
      return {
        name: 'dark_oak_planks',
        position,
        shapes: [[0, 0, 0, 1, 1, 1]]
      }
    }
    return { name: 'air', position, shapes: [] }
  }

  assert.strictEqual(build.hasIntegerStandSurface(ctx.bot.blockAt(fenceSupport)), false)
  assert.strictEqual(build.hasIntegerStandSurface(ctx.bot.blockAt(fullSupport)), true)
  const stands = build.findSafePlacementStandPositions(ctx, target, 4.5)
  assert.ok(stands.some(stand => stand.x === 0 && stand.y === 66 && stand.z === -1))
  assert.ok(!stands.some(stand => stand.x === -1 && stand.y === 66 && stand.z === 0))
}

function testFluidStandingPlannerRejectsReservedCloseCell() {
  const ctx = createContext()
  const target = { x: 0, y: 64, z: 0 }
  const reservedPositions = new Set(['1,65,0'])
  ctx.bot.entity.position = vec(4.5, 65, 0.5)
  ctx.bot.blockAt = position => {
    if (position.y === 64) {
      return {
        name: 'oak_planks',
        position,
        shapes: [[0, 0, 0, 1, 1, 1]]
      }
    }
    return { name: 'air', position, shapes: [] }
  }

  const fluid = build.findSafePlacementStandPositions(ctx, target, 4.5, {
    reservedPositions,
    preferHighStand: true,
    preferCloseStand: true,
    minHorizontalDistance: 1
  })

  assert.ok(fluid.length > 0)
  assert.strictEqual(Math.hypot(fluid[0].x - target.x, fluid[0].z - target.z), 1)
  assert.ok(!fluid.some(stand => reservedPositions.has(`${stand.x},${stand.y},${stand.z}`)))
}

function testStandingPlannerAllowsReservedAirCellOnlyWhenExplicitlyRecovering() {
  const ctx = createContext()
  const target = { x: 0, y: 64, z: 0 }
  const reservedStand = { x: -1, y: 65, z: 0 }
  const reservedPositions = new Set(['-1,65,0'])
  ctx.bot.entity.position = vec(0.5, 61, 0.5)
  ctx.bot.blockAt = position => {
    if (position.x === -1 && position.y === 64 && position.z === 0) {
      return {
        name: 'stone',
        position,
        shapes: [[0, 0, 0, 1, 1, 1]]
      }
    }
    return { name: 'air', position, shapes: [] }
  }

  const ordinary = build.findSafePlacementStandPositions(ctx, target, 4.5, {
    reservedPositions,
    preferHighStand: true
  })
  const recovery = build.findSafePlacementStandPositions(ctx, target, 4.5, {
    reservedPositions,
    preferHighStand: true,
    allowReservedAirStand: true,
    minimumPlacementStandY: target.y
  })

  assert.ok(!ordinary.some(stand => stand.x === reservedStand.x && stand.y === reservedStand.y && stand.z === reservedStand.z))
  assert.ok(recovery.some(stand => stand.x === reservedStand.x && stand.y === reservedStand.y && stand.z === reservedStand.z))
}

async function testCraftItemTableSemantics() {
  // ① explicit craftingTable:null is a real "no table" request: no table
  //    auto-discovery, bot.craft gets null (live failure: procurement passed
  //    null, canCraft re-bound an unreachable base table -> windowOpen timeout)
  {
    const ctx = createContext()
    const crafts = []
    ctx.bot.findBlock = () => { throw new Error('findBlock_must_not_run_for_explicit_null_table') }
    ctx.bot.recipesFor = (id, meta, count, table) => table === null ? [{ result: { id: 100 } }] : []
    ctx.bot.craft = async (recipe, count, table) => { crafts.push({ recipe, count, table }) }
    const result = await craft.craftItem(ctx, 'stick', 2, { craftingTable: null })
    assert.strictEqual(result.ok, true, result.error)
    assert.strictEqual(crafts.length, 1)
    assert.strictEqual(crafts[0].table, null)
  }

  // ② tableless recipe preferred even when a table is nearby: no window at all
  {
    const ctx = createContext()
    const crafts = []
    ctx.bot.registry.blocksByName.crafting_table = { id: 50 }
    ctx.bot.findBlock = () => ({ name: 'crafting_table', position: vec(2, 64, 0) })
    ctx.bot.recipesFor = () => [{ result: { id: 100 } }] // craftable with AND without table
    ctx.bot.craft = async (recipe, count, table) => { crafts.push({ table }) }
    const result = await craft.craftItem(ctx, 'stick', 1)
    assert.strictEqual(result.ok, true, result.error)
    assert.strictEqual(crafts[0].table, null, 'tableless recipe must not open the table window')
  }

  // ③ table-only recipe with a DISTANT table: walk into interaction range
  //    before bot.craft (live failure: crafting against a table 30 blocks
  //    away never opened the window)
  {
    const ctx = createContext()
    const crafts = []
    const tablePos = vec(30, 64, 0)
    ctx.bot.entity.position = vec(0, 64, 0)
    ctx.bot.registry.blocksByName.crafting_table = { id: 50 }
    ctx.bot.findBlock = () => ({ name: 'crafting_table', position: tablePos })
    ctx.bot.recipesFor = (id, meta, count, table) => table ? [{ result: { id: 100 } }] : []
    ctx.bot.pathfinder.setGoal = goal => {
      if (goal && Number.isFinite(goal.x)) ctx.bot.entity.position = vec(goal.x, goal.y ?? 64, goal.z)
    }
    ctx.bot.craft = async (recipe, count, table) => {
      assert.ok(ctx.bot.entity.position.distanceTo(tablePos) <= 4.5, 'must stand at the table before crafting')
      crafts.push({ table })
    }
    const result = await craft.craftItem(ctx, 'oak_log', 1)
    assert.strictEqual(result.ok, true, result.error)
    assert.strictEqual(crafts.length, 1)
    assert.ok(crafts[0].table, 'table recipe keeps the real table')
  }
}

async function testExploreSafety() {
  const ctx = createContext()
  ctx.blackboard.set('mobs.dangerLevel', 'high')
  const result = explore.getRandomNearbyPosition(ctx, 8)
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'danger_too_high')
}

async function testMiningRefusesProtectedBlocks() {
  const ctx = createContext()
  const protectedBlock = { name: 'crafting_table', position: vec(2, 64, 0) }
  ctx.bot.blockAt = () => protectedBlock
  const result = await mine.mineBlock(ctx, protectedBlock, { ignoreDanger: true })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'protected_block:crafting_table')
  assert.strictEqual(mine.PROTECTED_BLOCKS.has('crafting_table'), true)
}

async function testMiningToolRulesAndHandAllowed() {
  async function runCase(blockName, items, expected) {
    const ctx = createContext()
    const block = { name: blockName, position: vec(1, 64, 0) }
    ctx.equipmentSystem = new EquipmentSystem()
    ctx.bot.inventory.items = () => items
    ctx.bot.registry.blocksByName[blockName] = { id: 99, name: blockName }
    ctx.bot.blockAt = position => {
      if (position.x === 1 && position.y === 64 && position.z === 0) return block
      return { name: 'air', position }
    }
    ctx.bot.findBlock = () => block
    ctx.bot.findBlocks = () => [block.position]
    ctx.bot.dug = false
    ctx.bot.dig = async blockToDig => {
      ctx.bot.dug = true
      simulateBlockDrop(ctx.bot, blockToDig)
    }
    ctx.bot.canDigBlock = () => true
    ctx.bot.equip = async item => {
      ctx.bot.heldItem = item
    }

    const result = await mine.mineBlock(ctx, block, { ignoreDanger: true, targetBlock: blockName })
    assert.strictEqual(result.ok, expected.ok, blockName)
    if (expected.ok) {
      assert.strictEqual(ctx.bot.dug, true)
      assert.strictEqual(result.data.allowHand, expected.allowHand)
      assert.strictEqual(result.data.selectedTool, expected.selectedTool)
    } else {
      assert.strictEqual(result.error, expected.error)
    }
  }

  await runCase('oak_log', [], { ok: true, allowHand: true, selectedTool: 'hand' })
  await runCase('oak_log', [{ name: 'iron_axe', count: 1 }], { ok: true, allowHand: true, selectedTool: 'iron_axe' })
  await runCase('sand', [], { ok: true, allowHand: true, selectedTool: 'hand' })
  await runCase('dirt', [], { ok: true, allowHand: true, selectedTool: 'hand' })
  await runCase('diamond_ore', [], { ok: false, error: 'missing_required_tool:iron_pickaxe_or_better' })
  await runCase('diamond_ore', [{ name: 'iron_pickaxe', count: 1 }], { ok: true, allowHand: false, selectedTool: 'iron_pickaxe' })
  await runCase('iron_ore', [{ name: 'stone_pickaxe', count: 1 }], { ok: true, allowHand: false, selectedTool: 'stone_pickaxe' })
  await runCase('deepslate_iron_ore', [{ name: 'stone_pickaxe', count: 1 }], { ok: true, allowHand: false, selectedTool: 'stone_pickaxe' })
  await runCase('copper_ore', [{ name: 'stone_pickaxe', count: 1 }], { ok: true, allowHand: false, selectedTool: 'stone_pickaxe' })
  await runCase('deepslate_copper_ore', [{ name: 'stone_pickaxe', count: 1 }], { ok: true, allowHand: false, selectedTool: 'stone_pickaxe' })
  await runCase('iron_ore', [], { ok: false, error: 'missing_required_tool:stone_pickaxe_or_better' })
}

async function testPlaceBlockAcceptsPlacedBlockAfterTimeout() {
  const ctx = createContext()
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
    throw new Error('Event blockUpdate:(2, 64, 0) did not fire within timeout of 5000ms')
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.recoveredFrom.includes('blockUpdate'), true)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRepairsWrongBlockAfterStableConfirmFailure() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map()
  const repairs = []
  let attempts = 0
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.inventory.items = () => [{ name: 'spruce_fence', count: 2 }]
  ctx.bot.blockAt = position => {
    const blockKey = key(position)
    if (occupied.has(blockKey)) return { name: occupied.get(blockKey), position }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.dig = async block => {
    repairs.push(`${block.position.x},${block.position.y},${block.position.z}:${block.name}`)
    occupied.delete(key(block.position))
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    attempts += 1
    const placedPosition = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    occupied.set(key(placedPosition), attempts === 1 ? 'dirt' : ctx.bot.heldItem?.name)
  }

  const result = await build.placeBlock(ctx, target, 'spruce_fence', {
    owner: 'test',
    repairObstructedTarget: true,
    requireServerConfirmation: true,
    stableConfirmDelayMs: 1,
    placementAttempts: 2
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(attempts, 2)
  assert.deepStrictEqual(repairs, ['2,64,0:dirt'])
  assert.strictEqual(occupied.get('2,64,0'), 'spruce_fence')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesAlternateReference() {
  const ctx = createContext()
  let attempts = 0
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.entity.position = vec(0, 62, 0)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 2 }]
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    attempts += 1
    if (reference.position.y === target.y - 1) {
      throw new Error('Event blockUpdate:(2, 64, 0) did not fire within timeout of 5000ms')
    }
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(attempts, 3)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPrefersLowerReferenceWhenSupported() {
  const ctx = createContext()
  const references = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x)
  assert.strictEqual(references[0].y, target.y - 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPrefersSideReferenceWithoutLowerSupport() {
  const ctx = createContext()
  const references = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x - 1)
  assert.strictEqual(references[0].y, target.y)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsTemporaryReferenceColumnWhenUnsupported() {
  const ctx = createContext()
  const target = { x: 2, y: 66, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'stone']
  ])
  const placed = []
  const cleared = []
  ctx.bot.inventory.items = () => [
    { name: 'moss_block', count: 1 },
    { name: 'dirt', count: 4 }
  ]
  ctx.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    return { name: occupied.get(key) || 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(`${position.x},${position.y},${position.z}`, blockName)
    placed.push({ position, blockName })
  }
  ctx.bot.dig = async block => {
    occupied.delete(`${block.position.x},${block.position.y},${block.position.z}`)
    cleared.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'moss_block', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(occupied.get('2,66,0'), 'moss_block')
  assert.strictEqual(occupied.has('2,65,0'), false)
  assert.strictEqual(occupied.has('2,64,0'), false)
  assert.deepStrictEqual(placed.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'dirt@2,64,0',
    'dirt@2,65,0',
    'moss_block@2,66,0'
  ])
  assert.deepStrictEqual(cleared.map(position => `${position.x},${position.y},${position.z}`), [
    '2,65,0',
    '2,64,0'
  ])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockStandingTorchUsesBelowReferenceInWallCorner() {
  // A standing torch placed against a wall side face converts to wall_torch
  // (live: simple_two_story_cabin corner torch at rel 1,1,1). The reference
  // must be the floor block below even when walls flank the target.
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'oak_planks'], // floor below
    ['1,64,0', 'oak_planks'], // west wall
    ['2,64,1', 'oak_planks'] // south wall
  ])
  const placements = []
  ctx.bot.inventory.items = () => [{ name: 'torch', count: 4 }]
  ctx.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    return { name: occupied.get(key) || 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    occupied.set(`${position.x},${position.y},${position.z}`, ctx.bot.heldItem?.name || 'air')
    placements.push({ reference: { ...reference.position }, faceVector: { ...faceVector }, position })
  }

  const result = await build.placeBlock(ctx, target, 'torch', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(occupied.get('2,64,0'), 'torch')
  assert.strictEqual(placements.length, 1)
  assert.deepStrictEqual(placements[0].reference, { x: 2, y: 63, z: 0 })
  assert.deepStrictEqual(placements[0].faceVector, { x: 0, y: 1, z: 0 })
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockSneaksAgainstInteractiveReference() {
  const ctx = createContext()
  const references = []
  const controlStates = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'spruce_slab', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.setControlState = (control, value) => {
    controlStates.push({ control, value })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'spruce_slab' : 'air', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'smithing_table', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    assert.deepStrictEqual(controlStates[controlStates.length - 1], { control: 'sneak', value: true })
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_slab', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x - 1)
  assert.strictEqual(references[0].y, target.y)
  assert.deepStrictEqual(controlStates, [
    { control: 'sneak', value: true },
    { control: 'sneak', value: false }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesWaterBucketForWaterBlock() {
  const ctx = createContext()
  let placed = false
  let equippedItem = null
  let activated = false
  let normalPlaceCalled = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'water_bucket', count: 1 }]
  ctx.bot.equip = async item => {
    equippedItem = item.name
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'water' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    normalPlaceCalled = true
    throw new Error('water_should_use_bucket_activation')
  }
  ctx.bot.activateBlock = async (reference, faceVector) => {
    assert.strictEqual(ctx.bot.heldItem.name, 'water_bucket')
    assert.strictEqual(reference.position.x, target.x)
    assert.strictEqual(reference.position.y, target.y - 1)
    assert.strictEqual(reference.position.z, target.z)
    assert.strictEqual(faceVector.x, 0)
    assert.strictEqual(faceVector.y, 1)
    assert.strictEqual(faceVector.z, 0)
    activated = true
    placed = true
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
  }

  const result = await build.placeBlock(ctx, target, 'water', { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(equippedItem, 'water_bucket')
  assert.strictEqual(activated, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(normalPlaceCalled, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesHeldWaterBucketWhenInventoryListOmitsHeldItem() {
  const ctx = createContext()
  let placed = false
  let equipCalled = false
  let activated = false
  const target = { x: 2, y: 64, z: 0 }

  ctx.bot.heldItem = { name: 'water_bucket', count: 1 }
  ctx.bot.inventory.items = () => []
  ctx.bot.equip = async () => {
    equipCalled = true
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'water' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.activateBlock = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'water_bucket')
    activated = true
    placed = true
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
  }

  const result = await build.placeBlock(ctx, target, 'water', { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activated, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(equipCalled, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockWaitsForDelayedWaterAfterBucketUse() {
  const ctx = createContext()
  let placed = false
  let activateBlockCalled = false
  let activateItemCalled = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'water_bucket', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'water' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.activateBlock = async () => {
    activateBlockCalled = true
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
    setTimeout(() => {
      placed = true
    }, 20)
  }
  ctx.bot.activateItem = async () => {
    activateItemCalled = true
  }

  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    allowFluidTargetCellPlacement: false,
    fluidActivationConfirmMs: 120,
    fluidActivationPollMs: 5,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activateBlockCalled, true)
  assert.strictEqual(activateItemCalled, false)
  assert.strictEqual(placed, true)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackToActivateItemForWaterBucket() {
  const ctx = createContext()
  const lookTargets = []
  let placed = false
  let activateBlockCalled = false
  let activateItemCalled = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'water_bucket', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async lookTarget => {
    lookTargets.push(lookTarget)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'water' : 'air', position }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('water_should_use_bucket_activation')
  }
  ctx.bot.activateBlock = async (reference, faceVector, cursorPos) => {
    activateBlockCalled = true
  }
  ctx.bot.world = {
    raycast() {
      return { position: vec(target.x + 1, target.y, target.z) }
    }
  }
  ctx.bot.activateItem = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'water_bucket')
    activateItemCalled = true
    placed = true
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
  }

  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    allowFluidTargetCellPlacement: false,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(activateBlockCalled, false)
  assert.strictEqual(activateItemCalled, true)
  assert.strictEqual(lookTargets.length, 1)
  assert.strictEqual(lookTargets[0].x, target.x + 1.001)
  assert.strictEqual(lookTargets[0].y, target.y + 0.4)
  assert.strictEqual(lookTargets[0].z, target.z + 0.5)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

function configureClosedFluidFixture(ctx, target, options = {}) {
  const waterBucket = { name: 'water_bucket', count: 1 }
  const goals = []
  let activationCount = 0
  let placedLevel = null
  ctx.bot.entity.position = options.currentPosition || vec(target.x + 4.5, target.y + 1, target.z + 0.5)
  ctx.bot.entity.onGround = true
  ctx.bot.heldItem = waterBucket
  ctx.bot.inventory.items = () => waterBucket.count > 0 ? [waterBucket] : []
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placedLevel == null ? 'air' : 'water',
        position: vec(position.x, position.y, position.z),
        getProperties: () => placedLevel == null ? {} : { level: placedLevel }
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return {
        name: 'stone',
        position: vec(position.x, position.y, position.z),
        shapes: [[0, 0, 0, 1, 1, 1]]
      }
    }
    if (position.x === target.x && position.y === target.y + 1 && position.z === target.z) {
      return {
        name: 'spruce_slab',
        position: vec(position.x, position.y, position.z),
        shapes: [[0, 0.5, 0, 1, 1, 1]]
      }
    }
    const horizontal = Math.abs(position.x - target.x) + Math.abs(position.z - target.z)
    if (
      position.y === target.y &&
      (horizontal === 1 || (options.secondRingSupport === true && horizontal === 2))
    ) {
      return {
        name: 'oak_planks',
        position: vec(position.x, position.y, position.z),
        shapes: [[0, 0, 0, 1, 1, 1]]
      }
    }
    return { name: 'air', position: vec(position.x, position.y, position.z), shapes: [] }
  }
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goals.push({ x: goal.x, y: goal.y, z: goal.z })
    ctx.bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
    ctx.bot.entity.onGround = true
  }
  ctx.bot.pathfinder.stop = () => {}
  ctx.bot.clearControlStates = () => {}
  ctx.bot.world = {
    raycast() {
      const position = ctx.bot.entity.position
      const visibleStandDistance = Number(options.visibleStandDistance ?? 1)
      const atNorthStand = Math.floor(position.x) === target.x &&
        Math.floor(position.y) === target.y + 1 &&
        Math.floor(position.z) === target.z - visibleStandDistance
      if (options.currentRayVisible === true || atNorthStand) {
        return { position: vec(target.x, target.y - 1, target.z) }
      }
      return { position: vec(target.x + 3, target.y, target.z) }
    }
  }
  let lookForce = null
  ctx.bot.lookAt = async (_position, force) => {
    lookForce = force
  }
  ctx.bot.activateItem = async () => {
    activationCount += 1
    waterBucket.count -= 1
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
    if (options.wrongCell !== true) placedLevel = options.placedLevel ?? '0'
  }
  return {
    goals,
    activationCount: () => activationCount,
    lookForce: () => lookForce,
    placedLevel: () => placedLevel,
    waterBucket
  }
}

async function testFluidCurrentExactRaySkipsMovementAndPlacesSource() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const fixture = configureClosedFluidFixture(ctx, target, {
    currentPosition: vec(target.x + 0.5, target.y + 1, target.z - 0.5),
    currentRayVisible: true
  })
  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'fluid_placed_from_visible_reference')
  assert.strictEqual(result.data.activationStage, 'current')
  assert.strictEqual(fixture.goals.length, 0)
  assert.strictEqual(fixture.lookForce(), false)
  assert.strictEqual(fixture.placedLevel(), '0')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testFluidClosedTargetUsesUnreservedAdjacentUpperStance() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const fixture = configureClosedFluidFixture(ctx, target)
  const reservedPositions = new Set([
    `${target.x + 1},${target.y + 1},${target.z}`,
    `${target.x - 1},${target.y + 1},${target.z}`,
    `${target.x},${target.y + 1},${target.z + 1}`
  ])
  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    reservedPositions,
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.data.activationStage, 'adjacent_stance')
  assert.deepStrictEqual(fixture.goals, [{ x: target.x, y: target.y + 1, z: target.z - 1 }])
  assert.ok(!fixture.goals.some(goal => goal.x === target.x && goal.y === target.y && goal.z === target.z))
  assert.strictEqual(fixture.lookForce(), false)
  assert.strictEqual(fixture.placedLevel(), '0')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testFluidReservedAdjacentStandsAreRejectedBeforeNearCandidates() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const fixture = configureClosedFluidFixture(ctx, target, {
    currentPosition: vec(target.x + 0.5, target.y + 1, target.z - 4.5),
    secondRingSupport: true,
    visibleStandDistance: 99
  })
  const reservedPositions = new Set([
    `${target.x + 1},${target.y + 1},${target.z}`,
    `${target.x - 1},${target.y + 1},${target.z}`,
    `${target.x},${target.y + 1},${target.z + 1}`,
    `${target.x},${target.y + 1},${target.z - 1}`
  ])
  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    reservedPositions,
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'fluid_activation_reference_unreachable')
  assert.ok(fixture.goals.length > 0)
  assert.ok(!fixture.goals.some(goal => reservedPositions.has(`${goal.x},${goal.y},${goal.z}`)))
  assert.ok(fixture.goals.every(goal => Math.hypot(goal.x - target.x, goal.z - target.z) === 2))
  assert.strictEqual(fixture.activationCount(), 0)
  assert.strictEqual(fixture.waterBucket.count, 1)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testFluidNoExactRayDoesNotConsumeBucket() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const fixture = configureClosedFluidFixture(ctx, target)
  const reservedPositions = new Set([
    `${target.x + 1},${target.y + 1},${target.z}`,
    `${target.x - 1},${target.y + 1},${target.z}`,
    `${target.x},${target.y + 1},${target.z + 1}`,
    `${target.x},${target.y + 1},${target.z - 1}`
  ])
  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    reservedPositions,
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'fluid_activation_reference_unreachable')
  assert.strictEqual(fixture.goals.length, 0)
  assert.strictEqual(fixture.activationCount(), 0)
  assert.strictEqual(fixture.waterBucket.count, 1)
  assert.strictEqual(ctx.bot.heldItem.name, 'water_bucket')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testFluidFlowingWaterRequiresMaterialRefill() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const fixture = configureClosedFluidFixture(ctx, target, {
    currentPosition: vec(target.x + 0.5, target.y + 1, target.z - 0.5),
    currentRayVisible: true,
    placedLevel: 8
  })
  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'placement_retry_requires_material_refill:water_bucket')
  assert.strictEqual(result.placementError, 'place_failed:state_mismatch:level:8!=0')
  assert.strictEqual(fixture.activationCount(), 1)
  assert.strictEqual(ctx.bot.heldItem.name, 'bucket')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testFluidWrongCellWaterRequiresMaterialRefill() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const fixture = configureClosedFluidFixture(ctx, target, {
    currentPosition: vec(target.x + 0.5, target.y + 1, target.z - 0.5),
    currentRayVisible: true,
    wrongCell: true
  })
  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'placement_retry_requires_material_refill:water_bucket')
  assert.ok(String(result.placementError).startsWith('place_failed:'))
  assert.strictEqual(fixture.activationCount(), 1)
  assert.strictEqual(fixture.placedLevel(), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockDoesNotActivateWaterBucketThroughOccluder() {
  const ctx = createContext()
  const logs = []
  let activateItemCalled = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.logger = { log: message => logs.push(String(message)) }
  ctx.bot.inventory.items = () => [{ name: 'water_bucket', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.activateBlock = async () => {}
  ctx.bot.activateItem = async () => {
    activateItemCalled = true
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.world = {
    raycast() {
      return { position: vec(target.x + 2, target.y, target.z) }
    }
  }

  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    allowFluidTargetCellPlacement: false,
    placementAttempts: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(activateItemCalled, false)
  assert.strictEqual(ctx.bot.heldItem.name, 'water_bucket')
  assert.ok(logs.some(message =>
    message.includes('[BUILD_BUCKET_ACTIVATE_ITEM_SKIPPED]') &&
    message.includes('reason=reference_not_visible')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRejectsFlowingWaterForSourceTarget() {
  const ctx = createContext()
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'water_bucket', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'water' : 'air',
        position,
        getProperties: () => placed ? { level: 8 } : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.activateBlock = async () => {
    placed = true
    ctx.bot.heldItem = { name: 'bucket', count: 1 }
  }

  const result = await build.placeBlock(ctx, target, 'water', {
    owner: 'test',
    allowFluidTargetCellPlacement: false,
    blockStates: { level: '0' },
    requireStateConfirmation: true,
    placementAttempts: 1,
    fluidActivationConfirmMs: 1,
    fluidActivationPollMs: 1,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'place_failed:state_mismatch:level:8!=0')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockCanReplaceWaterWithSolidBlock() {
  const ctx = createContext()
  let placed = false
  let digCalled = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'oak_planks', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'oak_planks' : 'water', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async () => {
    digCalled = true
    throw new Error('water_should_be_replaced_by_placement')
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'oak_planks', { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.strictEqual(digCalled, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockRetriesDiggingAborted() {
  const ctx = createContext()
  const logs = []
  const target = { x: 1, y: 64, z: 0 }
  let occupied = true
  let digAttempts = 0
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'dirt' : 'air', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async () => {
    digAttempts += 1
    if (digAttempts === 1) throw new Error('Digging aborted')
    occupied = false
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    clearRetryDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(digAttempts, 2)
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_RETRY]')))
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockTimesOutAndCancelsUnboundedDig() {
  const ctx = createContext()
  const logs = []
  const target = { x: 1, y: 64, z: 0 }
  let digAttempts = 0
  let stopDiggingCalls = 0
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'ender_chest', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async () => {
    digAttempts += 1
    await new Promise(() => {})
  }
  ctx.bot.stopDigging = () => {
    stopDiggingCalls += 1
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    digTimeoutMs: 10
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'dig_timeout:ender_chest:10')
  assert.strictEqual(result.timedOut, true)
  assert.strictEqual(digAttempts, 1)
  assert.strictEqual(stopDiggingCalls, 1)
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_DIG_TIMEOUT]')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockSkipsRepositionWhenThinBlockDigReachable() {
  const ctx = createContext()
  const logs = []
  const goals = []
  const target = { x: 1, y: 64, z: 0 }
  let occupied = true
  let digAttempts = 0

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(target.x + 0.25, target.y, target.z + 0.25)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(target.x + 0.25, target.y, target.z + 0.25)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'spruce_trapdoor' : 'air', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async block => {
    digAttempts += 1
    assert.strictEqual(block.name, 'spruce_trapdoor')
    occupied = false
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    timeoutMs: 1,
    standMoveAttempts: 2
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(digAttempts, 1)
  assert.strictEqual(goals.length, 0)
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_THIN_INTERSECTION_REACHABLE]')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockUsesBotCanDigForThinBlockReachEdge() {
  const ctx = createContext()
  const logs = []
  const goals = []
  const target = { x: 1, y: 64, z: 0 }
  let occupied = true
  let digAttempts = 0

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(target.x, target.y, target.z + 6)
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.canDigBlock = block => block?.name === 'spruce_trapdoor'
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'spruce_trapdoor' : 'air', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async block => {
    digAttempts += 1
    assert.strictEqual(block.name, 'spruce_trapdoor')
    occupied = false
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    timeoutMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(digAttempts, 1)
  assert.strictEqual(goals.length, 0)
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_THIN_CAN_DIG_REACHABLE]')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockUsesExtendedReachForThinBlockReachEdge() {
  const ctx = createContext()
  const logs = []
  const goals = []
  const target = { x: 1, y: 64, z: 0 }
  let occupied = true
  let digAttempts = 0

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(target.x, target.y, target.z + 5)
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.canDigBlock = block => block?.name === 'spruce_trapdoor'
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'spruce_trapdoor' : 'air', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async block => {
    digAttempts += 1
    assert.strictEqual(block.name, 'spruce_trapdoor')
    occupied = false
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    timeoutMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(digAttempts, 1)
  assert.strictEqual(goals.length, 0)
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_THIN_EXTENDED_REACHABLE]')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockEquipsToolWhenOwnerAlreadyHoldsInventoryLock() {
  const ctx = createContext()
  const logs = []
  const target = { x: 1, y: 64, z: 0 }
  const items = [{ name: 'iron_pickaxe', count: 1 }]
  let occupied = true
  let equipAttempts = 0
  let heldWhileDigging = null

  ctx.equipmentSystem = new EquipmentSystem()
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.heldItem = { name: 'dirt', count: 1 }
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    equipAttempts += 1
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'cobblestone' : 'air', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async () => {
    heldWhileDigging = ctx.bot.heldItem?.name || null
    occupied = false
  }

  const inventoryLock = ctx.actionLock.acquire('inventory', 'test', { timeoutMs: 10000 })
  assert.strictEqual(inventoryLock.ok, true)

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    holdLock: true
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(equipAttempts, 1)
  assert.strictEqual(heldWhileDigging, 'iron_pickaxe')
  assert.ok(logs.some(message => message.includes('[BUILD_CLEAR_EQUIP_OWNER_LOCK_FALLBACK] block=cobblestone item=iron_pickaxe owner=test')))
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), 'test')

  ctx.actionLock.releaseAll('test')
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStoredDirtPathItemBeforeShovel() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const items = []
  const storageTakes = []
  let placed = false
  let activateBlockCalled = false
  let autoPreparationCalled = false

  ctx.storageSystem = {
    async takeItems(context, options) {
      storageTakes.push(options)
      assert.strictEqual(options.itemName, 'dirt_path')
      assert.strictEqual(options.count, 1)
      assert.strictEqual(options.owner, 'test')
      items.push({ name: 'dirt_path', count: 1 })
      return { ok: true, withdrawnItems: [{ itemName: 'dirt_path', count: 1 }] }
    }
  }
  ctx.autoPreparationSystem = {
    async ensureItem() {
      autoPreparationCalled = true
      return { ok: false, reason: 'unexpected_auto_preparation' }
    }
  }
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt_path' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt_path')
    assert.strictEqual(reference.name, 'stone')
    assert.deepStrictEqual(
      { x: faceVector.x, y: faceVector.y, z: faceVector.z },
      { x: 0, y: 1, z: 0 }
    )
    placed = true
  }
  ctx.bot.activateBlock = async () => {
    activateBlockCalled = true
    throw new Error('unexpected activateBlock')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    allowDirtPathItemStorageLookup: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'dirt_path_item_placed')
  assert.strictEqual(placed, true)
  assert.strictEqual(storageTakes.length, 1)
  assert.strictEqual(activateBlockCalled, false)
  assert.strictEqual(autoPreparationCalled, false)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockCachesDirtPathStorageMissForSameOwner() {
  const ctx = createContext()
  const targets = [
    { x: 2, y: 64, z: 0 },
    { x: 3, y: 64, z: 0 }
  ]
  const occupied = new Map(targets.map(target => [`${target.x},${target.y - 1},${target.z}`, 'stone']))
  const items = [
    { name: 'dirt', count: 2 },
    { name: 'iron_shovel', count: 1 }
  ]
  const logs = []
  let storageTakes = 0

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.storageSystem = {
    async takeItems() {
      storageTakes += 1
      return { ok: false, reason: 'chest_item_not_found:dirt_path' }
    }
  }
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    occupied.set(`${position.x},${position.y},${position.z}`, 'dirt')
  }
  ctx.bot.activateBlock = async block => {
    occupied.set(`${block.position.x},${block.position.y},${block.position.z}`, 'dirt_path')
  }

  for (const target of targets) {
    const result = await build.placeBlock(ctx, target, 'dirt_path', {
      owner: 'same_build_task',
      allowDirtPathItemStorageLookup: true,
      stableConfirmDelayMs: 1
    })
    assert.strictEqual(result.ok, true, result.error)
  }

  assert.strictEqual(storageTakes, 1)
  assert.ok(logs.some(message => message.includes('[BUILD_DIRT_PATH_ITEM_STORAGE_MISS_CACHED] owner=same_build_task')))
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testDirtPathStopsAfterInterruptedStorageLookup() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let running = true
  let placeAttempts = 0
  let activationAttempts = 0

  ctx.storageSystem = {
    async takeItems() {
      running = false
      return { ok: false, reason: 'task_interrupted' }
    }
  }
  ctx.bot.inventory.items = () => [
    { name: 'dirt', count: 1 },
    { name: 'iron_shovel', count: 1 }
  ]
  ctx.bot.blockAt = position => ({
    name: position.y === target.y - 1 ? 'stone' : 'air',
    position
  })
  ctx.bot.placeBlock = async () => { placeAttempts += 1 }
  ctx.bot.activateBlock = async () => { activationAttempts += 1 }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'interrupted_build',
    allowDirtPathItemStorageLookup: true,
    shouldContinue: () => running,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'task_interrupted')
  assert.strictEqual(placeAttempts, 0, 'interrupted lookup must not enter dirt base fallback')
  assert.strictEqual(activationAttempts, 0, 'interrupted lookup must not activate the target')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockClearsTopBeforeStoredDirtPathItem() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const items = [{ name: 'dirt_path', count: 1 }]
  const occupied = new Map([
    ['2,63,0', 'stone'],
    ['2,65,0', 'dirt']
  ])
  let placeAttempts = 0
  let digAttempts = 0
  let activateBlockCalled = false
  let autoPreparationCalled = false

  ctx.autoPreparationSystem = {
    async ensureItem() {
      autoPreparationCalled = true
      return { ok: false, reason: 'unexpected_auto_preparation' }
    }
  }
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.dig = async block => {
    digAttempts += 1
    occupied.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt_path')
    assert.strictEqual(reference.name, 'stone')
    assert.deepStrictEqual(
      { x: faceVector.x, y: faceVector.y, z: faceVector.z },
      { x: 0, y: 1, z: 0 }
    )
    placeAttempts += 1
    occupied.set('2,64,0', 'dirt_path')
  }
  ctx.bot.activateBlock = async () => {
    activateBlockCalled = true
    throw new Error('unexpected activateBlock')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    repairObstructedTarget: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'dirt_path_item_placed')
  assert.strictEqual(digAttempts, 1)
  assert.strictEqual(placeAttempts, 1)
  assert.strictEqual(occupied.get('2,65,0'), undefined)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.strictEqual(activateBlockCalled, false)
  assert.strictEqual(autoPreparationCalled, false)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesShovelForExistingDirtPathBase() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,64,0', 'dirt'],
    ['2,63,0', 'stone']
  ])
  let activated = false
  let normalPlaceCalled = false

  ctx.bot.inventory.items = () => [{ name: 'iron_shovel', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.placeBlock = async () => {
    normalPlaceCalled = true
  }
  ctx.bot.activateBlock = async (block, faceVector, cursorPos) => {
    assert.strictEqual(block.name, 'dirt')
    assert.deepStrictEqual(
      { x: faceVector.x, y: faceVector.y, z: faceVector.z },
      { x: 0, y: 1, z: 0 }
    )
    assert.deepStrictEqual(
      { x: cursorPos.x, y: cursorPos.y, z: cursorPos.z },
      { x: 0.5, y: 1, z: 0.5 }
    )
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activated = true
    occupied.set('2,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activated, true)
  assert.strictEqual(normalPlaceCalled, false)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockAcceptsDirtPathAfterBlockUpdateTimeout() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,64,0', 'dirt'],
    ['2,63,0', 'stone']
  ])
  const logs = []
  let activated = false
  let activateItemCalled = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.inventory.items = () => [{ name: 'iron_shovel', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.activateBlock = async () => {
    activated = true
    occupied.set('2,64,0', 'dirt_path')
    throw new Error('Event blockUpdate:(2, 64, 0) did not fire within timeout of 5000ms')
  }
  ctx.bot.activateItem = async () => {
    activateItemCalled = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activated, true)
  assert.strictEqual(activateItemCalled, false)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.ok(logs.some(message => message.includes('BUILD_DIRT_PATH_BLOCKUPDATE_RECOVERED')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesDirtPathBaseAfterBlockUpdateAir() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'stone']
  ])
  const logs = []
  let baseAttempts = 0
  let activated = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.inventory.items = () => [
    { name: 'dirt', count: 2 },
    { name: 'iron_shovel', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.placeBlock = async (reference, faceVector) => {
    baseAttempts += 1
    if (baseAttempts === 1) {
      throw new Error('Event blockUpdate:(2, 64, 0) did not fire within timeout of 5000ms')
    }
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    occupied.set(`${position.x},${position.y},${position.z}`, 'dirt')
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    activated = true
    occupied.set('2,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1,
    retryDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(baseAttempts, 2)
  assert.strictEqual(activated, true)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.ok(logs.some(message => message.includes('BUILD_DIRT_PATH_BASE_RETRY')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockAcceptsDelayedDirtPathBaseAfterTimeout() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'stone']
  ])
  const logs = []
  let baseAttempts = 0
  let basePlaced = false
  let targetReadsAfterBase = 0
  let activated = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.inventory.items = () => [
    { name: 'dirt', count: 1 },
    { name: 'iron_shovel', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '2,64,0' && basePlaced) {
      targetReadsAfterBase += 1
      return {
        name: targetReadsAfterBase >= 3 ? 'dirt' : 'air',
        position
      }
    }
    return {
      name: occupied.get(key) || 'air',
      position
    }
  }
  ctx.bot.placeBlock = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt')
    baseAttempts += 1
    basePlaced = true
    throw new Error('Event blockUpdate:(2, 64, 0) did not fire within timeout of 5000ms')
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activated = true
    occupied.set('2,64,0', 'dirt_path')
    basePlaced = false
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1,
    dirtPathBaseConfirmTimeoutMs: 20,
    dirtPathBaseConfirmIntervalMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(baseAttempts, 1)
  assert.strictEqual(activated, true)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.ok(logs.some(message => message.includes('BUILD_DIRT_PATH_BASE_DELAYED')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockMovesBeforePlacingDirtPathBase() {
  const ctx = createContext()
  const target = { x: 10, y: 64, z: 0 }
  const goals = []
  const occupied = new Map([
    ['10,63,0', 'stone']
  ])
  let basePlaced = false
  let activated = false

  ctx.bot.entity.position = vec(0, 64, 0)
  ctx.bot.once = (event, callback) => {
    if (event === 'goal_reached') setImmediate(callback)
  }
  ctx.bot.inventory.items = () => [
    { name: 'dirt', count: 1 },
    { name: 'iron_shovel', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    if (key === '10,64,0') {
      return { name: occupied.get(key) || 'air', position }
    }
    if (occupied.has(key)) return { name: occupied.get(key), position }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    assert.ok(goals.length > 0, 'expected movement before dirt path base placement')
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt')
    basePlaced = true
    occupied.set('10,64,0', 'dirt')
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activated = true
    occupied.set('10,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(basePlaced, true)
  assert.strictEqual(activated, true)
  assert.strictEqual(occupied.get('10,64,0'), 'dirt_path')
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockDirtPathBaseEquipsWhenOwnerAlreadyHoldsInventoryLock() {
  const ctx = createContext()
  const items = [{ name: 'dirt', count: 1 }, { name: 'iron_shovel', count: 1 }]
  const target = { x: 2, y: 64, z: 0 }
  const logs = []
  let targetBlock = 'air'
  let equipAttempts = 0
  let activated = false

  ctx.equipmentSystem = new EquipmentSystem()
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.heldItem = items[1]
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    equipAttempts += 1
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: targetBlock, position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt')
    targetBlock = 'dirt'
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activated = true
    targetBlock = 'dirt_path'
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activated, true)
  assert.strictEqual(equipAttempts, 2)
  assert.strictEqual(targetBlock, 'dirt_path')
  assert.ok(logs.some(message => message.includes('[BUILD_EQUIP_OWNER_LOCK_FALLBACK] block=dirt item=dirt owner=test')))
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesDirtPathActivationAfterAirRegression() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,64,0', 'dirt'],
    ['2,63,0', 'stone']
  ])
  const logs = []
  let activationAttempts = 0
  let baseReplaced = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.inventory.items = () => [
    { name: 'dirt', count: 2 },
    { name: 'iron_shovel', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.placeBlock = async (reference, faceVector) => {
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt')
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    baseReplaced = true
    occupied.set(`${position.x},${position.y},${position.z}`, 'dirt')
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activationAttempts += 1
    if (activationAttempts === 1) {
      occupied.delete('2,64,0')
      throw new Error('Event blockUpdate:(2, 64, 0) did not fire within timeout of 5000ms')
    }
    occupied.set('2,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1,
    retryDelayMs: 1,
    dirtPathActivationAttempts: 2
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activationAttempts, 2)
  assert.strictEqual(baseReplaced, true)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.ok(logs.some(message => message.includes('BUILD_DIRT_PATH_RETRY')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPlacesDirtThenUsesShovelForDirtPath() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'stone']
  ])
  const placed = []
  let activated = false

  ctx.bot.inventory.items = () => [
    { name: 'dirt', count: 1 },
    { name: 'iron_shovel', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    placed.push({ position, item: ctx.bot.heldItem?.name })
    occupied.set(`${position.x},${position.y},${position.z}`, ctx.bot.heldItem?.name)
  }
  ctx.bot.activateBlock = async (block, faceVector, cursorPos) => {
    assert.strictEqual(block.name, 'dirt')
    assert.deepStrictEqual(
      { x: faceVector.x, y: faceVector.y, z: faceVector.z },
      { x: 0, y: 1, z: 0 }
    )
    assert.deepStrictEqual(
      { x: cursorPos.x, y: cursorPos.y, z: cursorPos.z },
      { x: 0.5, y: 1, z: 0.5 }
    )
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activated = true
    occupied.set('2,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(placed.map(entry => `${entry.item}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'dirt@2,64,0'
  ])
  assert.strictEqual(activated, true)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackToActivateItemForDirtPath() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,64,0', 'dirt'],
    ['2,63,0', 'stone']
  ])
  const lookTargets = []
  let activateBlockCalled = false
  let activateItemCalled = false

  ctx.bot.inventory.items = () => [{ name: 'iron_shovel', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.lookAt = async lookTarget => {
    lookTargets.push(lookTarget)
  }
  ctx.bot.activateBlock = async (block, faceVector, cursorPos) => {
    assert.strictEqual(block.name, 'dirt')
    assert.deepStrictEqual(
      { x: faceVector.x, y: faceVector.y, z: faceVector.z },
      { x: 0, y: 1, z: 0 }
    )
    assert.deepStrictEqual(
      { x: cursorPos.x, y: cursorPos.y, z: cursorPos.z },
      { x: 0.5, y: 1, z: 0.5 }
    )
    activateBlockCalled = true
  }
  ctx.bot.activateItem = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'iron_shovel')
    activateItemCalled = true
    occupied.set('2,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1,
    dirtPathActivationDelayMs: 1,
    dirtPathFallbackDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activateBlockCalled, true)
  assert.strictEqual(activateItemCalled, true)
  assert.strictEqual(lookTargets.length, 1)
  assert.strictEqual(lookTargets[0].x, target.x + 0.5)
  assert.strictEqual(lookTargets[0].y, target.y + 1)
  assert.strictEqual(lookTargets[0].z, target.z + 0.5)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockClearsDirtPathTopObstruction() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,64,0', 'dirt'],
    ['2,65,0', 'dirt'],
    ['2,63,0', 'stone']
  ])
  const dug = []
  let activated = false

  ctx.bot.inventory.items = () => [{ name: 'iron_shovel', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => ({
    name: occupied.get(`${position.x},${position.y},${position.z}`) || 'air',
    position
  })
  ctx.bot.dig = async block => {
    dug.push(`${block.position.x},${block.position.y},${block.position.z}:${block.name}`)
    occupied.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    activated = true
    occupied.set('2,64,0', 'dirt_path')
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    repairObstructedTarget: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(dug, ['2,65,0:dirt'])
  assert.strictEqual(activated, true)
  assert.strictEqual(occupied.get('2,65,0'), undefined)
  assert.strictEqual(occupied.get('2,64,0'), 'dirt_path')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPreparesShovelForDirtPathWhenMissing() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const items = [{ name: 'dirt', count: 1 }]
  const prepareCalls = []
  const logs = []
  let targetBlock = 'dirt'
  let activated = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.autoPreparationSystem = {
    async ensureItem(context, itemName, count, options) {
      prepareCalls.push({ itemName, count, options })
      if (itemName !== 'wooden_shovel') return { ok: false, reason: 'not_selected' }
      items.push({ name: 'wooden_shovel', count: 1 })
      return { ok: true, reason: 'crafted', itemName }
    }
  }
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: targetBlock, position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'dirt')
    assert.strictEqual(ctx.bot.heldItem.name, 'wooden_shovel')
    activated = true
    targetBlock = 'dirt_path'
  }

  const result = await build.placeBlock(ctx, target, 'dirt_path', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(activated, true)
  assert.deepStrictEqual(prepareCalls.map(call => call.itemName), ['wooden_shovel'])
  assert.strictEqual(prepareCalls[0].options.allowStorage, true)
  assert.strictEqual(prepareCalls[0].options.owner, 'test')
  assert.ok(logs.some(message => message.includes('[BUILD_DIRT_PATH_SHOVEL_PREPARED] item=wooden_shovel')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

function testDirtPathUsesDirtAsRuntimeMaterial() {
  assert.strictEqual(itemNameForBlock('dirt_path'), 'dirt')
}

// Community imports carry placed-block names; the material map must translate
// the vanilla block/item renames or fixtures and refills request items that
// do not exist (round 6: fort gate frame blocked on give/refill redstone_wire).
function testRenamedBlockItemsUseRealInventoryItems() {
  assert.strictEqual(itemNameForBlock('redstone_wire'), 'redstone')
  assert.strictEqual(itemNameForBlock('tripwire'), 'string')
  assert.strictEqual(itemNameForBlock('carrots'), 'carrot')
  assert.strictEqual(itemNameForBlock('sweet_berry_bush'), 'sweet_berries')
  assert.strictEqual(itemNameForBlock('lava'), 'lava_bucket')
  assert.strictEqual(itemNameForBlock('powder_snow'), 'powder_snow_bucket')
  // Renames with states still translate (redstone wire carries connections).
  assert.strictEqual(
    itemNameForBlock('redstone_wire', { power: '0', north: 'side' }),
    'redstone'
  )
  // Non-renamed blocks keep identity mapping.
  assert.strictEqual(itemNameForBlock('repeater'), 'repeater')
  assert.strictEqual(itemNameForBlock('sticky_piston'), 'sticky_piston')
}

async function testGroundPlantRequiresBelowReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let normalPlaceCalled = false

  ctx.bot.inventory.items = () => [{ name: 'azalea', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'air', position }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    normalPlaceCalled = true
  }

  const result = await build.placeBlock(ctx, target, 'azalea', {
    owner: 'test',
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'no_support_block')
  assert.strictEqual(normalPlaceCalled, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesFacingSideReferenceForWallSigns() {
  const ctx = createContext()
  const references = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_sign', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dark_oak_wall_sign' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_wall_sign', {
    owner: 'test',
    blockStates: { facing: 'west' }
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x + 1)
  assert.strictEqual(references[0].y, target.y)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockAllowsTrapdoorReferenceForWallSigns() {
  const ctx = createContext()
  const references = []
  const controlStates = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_sign', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.setControlState = (control, value) => {
    controlStates.push({ control, value })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dark_oak_wall_sign' : 'air', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'dark_oak_trapdoor', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    assert.deepStrictEqual(controlStates[controlStates.length - 1], { control: 'sneak', value: true })
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_wall_sign', {
    owner: 'test',
    blockStates: { facing: 'east' }
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x - 1)
  assert.strictEqual(references[0].y, target.y)
  assert.deepStrictEqual(controlStates, [
    { control: 'sneak', value: true },
    { control: 'sneak', value: false }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesFacingSideReferenceForTripwireHook() {
  const ctx = createContext()
  const references = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'tripwire_hook', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'tripwire_hook' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'tripwire_hook', {
    owner: 'test',
    blockStates: { facing: 'west' }
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x + 1)
  assert.strictEqual(references[0].y, target.y)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulTrapdoorPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const lookCalls = []
  let placed = false

  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async (lookTarget, force) => {
    lookCalls.push({ lookTarget, force, from: ctx.bot.entity.position })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => ({ half: 'top', facing: 'west', open: false, powered: false, waterlogged: false })
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'west', open: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x + 1)
  assert.strictEqual(calls[0].faceVector.x, -1)
  assert.strictEqual(calls[0].options.half, 'top')
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(lookCalls.length, 1)
  assert.strictEqual(lookCalls[0].force, false)
  assert.ok(lookCalls[0].lookTarget.x > lookCalls[0].from.x, JSON.stringify(lookCalls[0]))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesCurrentStatefulReferenceReachForTrapdoor() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const goals = []
  const logs = []
  let placed = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(target.x, target.y, target.z + 5)
  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => ({ half: 'top', facing: 'west', open: false, powered: false, waterlogged: false })
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'west', open: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(goals.length, 0)
  assert.ok(logs.some(message => message.includes('reason=stateful_placement_reference')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockDefersInitialMoveForTrapdoorStatefulReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const goals = []
  const logs = []
  let placed = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(-5, 64, 0)
  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => ({ half: 'top', facing: 'south', open: false, powered: false, waterlogged: false })
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'south', open: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.ok(goals.length >= 1)
  assert.ok(logs.some(message => message.includes('BUILD_INITIAL_MOVE_DEFERRED_FOR_STATEFUL_REFERENCE')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRepairsWrongStateTrapdoorBeforeRetry() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const digs = []
  let placedState = null

  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placedState
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => placedState
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) {
      return { name: 'stone', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placedState = calls.length === 1
      ? { half: 'bottom', facing: 'north', open: false }
      : { half: 'top', facing: 'west', open: false }
  }
  ctx.bot.dig = async block => {
    digs.push(block)
    placedState = null
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'west', open: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(digs.length, 1)
  assert.strictEqual(calls[0].options.half, 'top')
  assert.strictEqual(calls[1].options.half, 'top')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

async function testPlaceBlockTogglesTrapdoorOpenState() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const activations = []
  let placedState = null

  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placedState
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => placedState
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placedState = { half: 'bottom', facing: 'south', open: false }
  }
  ctx.bot.activateBlock = async block => {
    activations.push(block)
    placedState = { ...placedState, open: true }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south', open: 'true' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].options.half, 'bottom')
  assert.strictEqual(activations.length, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesTrapdoorFacingMatchedSideReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placedState = null
  ctx.bot.entity.position = vec(target.x + 3, target.y, target.z)

  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placedState
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => placedState
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'air', position }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z + 1) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placedState = {
      half: 'bottom',
      facing: faceVector.z === 1 ? 'south' : 'north',
      open: false
    }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south', open: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsFacingMatchedTemporaryReferenceForTrapdoor() {
  const ctx = createContext()
  const target = { x: 2, y: 66, z: 0 }
  const occupied = new Map([
    ['2,65,0', 'grass'],
    ['2,64,-1', 'stone']
  ])
  const placedTemporary = []
  const clearedTemporary = []
  const statefulCalls = []
  const logs = []
  const moveGoals = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.logger = { log: message => logs.push(message) }
  ctx.bot.entity.position = vec(target.x + 3, target.y + 8, target.z)
  ctx.bot.pathfinder.setGoal = goal => {
    moveGoals.push({ x: goal.x, y: goal.y, z: goal.z })
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_trapdoor', count: 1 },
    { name: 'dirt', count: 4 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'dark_oak_trapdoor' && key(position) === key(target)
          ? { half: 'bottom', facing: 'south', open: false, powered: false, waterlogged: false }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.y === target.y - 2) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
    if (blockName === 'dirt' && placedTemporary.length === 1) {
      throw new Error('Event blockUpdate:(2, 65, -1) did not fire within timeout of 5000ms')
    }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_trapdoor')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    clearedTemporary.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_trapdoor', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south', open: 'false', powered: 'false', waterlogged: 'false' },
    reservedPositions: new Set(['2,66,-1']),
    temporaryReferenceAllowedPositions: new Set(['2,66,-1']),
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(placedTemporary.map(entry => `${entry.blockName}@${key(entry.position)}`), [
    'dirt@2,65,-1',
    'dirt@2,66,-1'
  ])
  assert.strictEqual(moveGoals.length > 0, true)
  assert.strictEqual(moveGoals[0].y <= target.y, true)
  assert.deepStrictEqual(clearedTemporary.map(position => key(position)), [
    '2,66,-1',
    '2,65,-1'
  ])
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.z, target.z - 1)
  assert.strictEqual(statefulCalls[0].faceVector.z, 1)
  assert.strictEqual(statefulCalls[0].options.forceLook, 'ignore')
  assert.strictEqual(logs.some(message => message.includes('[BUILD_STAIR_TEMP_REFERENCE_TIMEOUT_RECOVERED]')), true)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesDarkOakPlanksForTemporaryReference() {
  const ctx = createContext()
  const target = { x: 2, y: 66, z: 0 }
  const occupied = new Map([
    ['2,65,0', 'grass'],
    ['2,64,-1', 'stone']
  ])
  const placedTemporary = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x + 3, target.y + 8, target.z)
  ctx.bot.pathfinder.setGoal = goal => {
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_trapdoor', count: 1 },
    { name: 'dark_oak_planks', count: 4 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'dark_oak_trapdoor' && key(position) === key(target)
          ? { half: 'bottom', facing: 'south', open: false, powered: false, waterlogged: false }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.y === target.y - 2) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async () => {
    occupied.set(key(target), 'dark_oak_trapdoor')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_trapdoor', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south', open: 'false', powered: 'false', waterlogged: 'false' },
    reservedPositions: new Set(['2,66,-1']),
    temporaryReferenceAllowedPositions: new Set(['2,66,-1']),
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(placedTemporary.map(entry => entry.blockName), [
    'dark_oak_planks',
    'dark_oak_planks'
  ])
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPrefersHighStandForHighTemporaryReference() {
  const ctx = createContext()
  const target = { x: 2, y: 66, z: 0 }
  const occupied = new Map([['2,64,0', 'stone']])
  const placedTemporary = []
  const moveGoals = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x, target.y - 6, target.z - 3)
  ctx.bot.pathfinder.setGoal = goal => {
    moveGoals.push(goal)
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.once = (event, callback) => {
    if (event === 'goal_reached') setImmediate(callback)
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_trapdoor', count: 1 },
    { name: 'dark_oak_planks', count: 4 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'dark_oak_trapdoor'
          ? { half: 'bottom', facing: 'south', open: false, powered: false, waterlogged: false }
          : {}
      }
    }
    if (position.y === target.y - 2) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    occupied.set(key(position), ctx.bot.heldItem?.name || 'air')
    placedTemporary.push({ position, blockName: ctx.bot.heldItem?.name || 'air' })
  }
  ctx.bot._placeBlockWithOptions = async () => {
    occupied.set(key(target), 'dark_oak_trapdoor')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_trapdoor', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south', open: 'false', powered: 'false', waterlogged: 'false' },
    reservedPositions: new Set(['2,65,0']),
    temporaryReferenceAllowedPositions: new Set(['2,65,0']),
    preferHighStand: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placedTemporary[0].blockName, 'dark_oak_planks')
  assert.ok(moveGoals.length > 0)
  assert.ok(moveGoals[0].y >= target.y - 1)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockUsesRaisedCurrentStandForElevatedRepair() {
  const ctx = createContext()
  const target = { x: 0, y: 70, z: 0 }
  const goals = []
  let occupied = true

  ctx.bot.entity.position = vec(0, 71.5, -6)
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.once = (event, callback) => {
    if (event === 'goal_reached') setImmediate(callback)
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'dark_oak_slab' : 'air', position, getProperties: () => ({ type: 'double' }) }
    }
    if (position.x === target.x && position.y === 71 && position.z === -3) {
      return { name: 'spruce_planks', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.dig = async () => {
    occupied = false
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    preferHighStand: true,
    adaptiveMoveTimeout: true,
    clearStandMoveRange: 1.0,
    standMoveAttempts: 8
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goals.length > 0)
  assert.strictEqual(goals[0].y, 72)
  assert.strictEqual(occupied, false)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testClearBlockFallsBackToNearXZForElevatedRepair() {
  const ctx = createContext()
  const target = { x: 0, y: 70, z: 0 }
  const goals = []
  let occupied = true

  ctx.bot.entity.position = vec(0, 72, -6)
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && goal.y === undefined) {
      ctx.bot.entity.position = vec(goal.x, 72, goal.z)
    }
  }
  ctx.bot.once = (event, callback) => {
    if (event !== 'goal_reached') return
    const goal = goals[goals.length - 1]
    if (goal && goal.y === undefined) setImmediate(callback)
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: occupied ? 'dark_oak_slab' : 'air', position, getProperties: () => ({ type: 'double' }) }
    }
    if (position.x === 0 && position.y === 72 && position.z === -2) {
      return { name: 'spruce_planks', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.dig = async () => {
    occupied = false
  }

  const result = await build.clearBlockForBuilding(ctx, target, {
    owner: 'test',
    timeoutMs: 5,
    preferHighStand: true,
    adaptiveMoveTimeout: true,
    clearStandMoveRange: 1.0,
    standMoveAttempts: 1,
    allowNearXZFallback: true,
    nearXZMoveTimeoutMs: 20
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(goals.length, 2)
  assert.notStrictEqual(goals[0].y, undefined)
  assert.strictEqual(goals[1].y, undefined)
  assert.strictEqual(occupied, false)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockSneaksForStatefulTrapdoorAgainstFenceGateReference() {
  const ctx = createContext()
  const target = { x: 2, y: 65, z: 0 }
  const calls = []
  const controlStates = []
  let placedState = null

  ctx.bot.inventory.items = () => [{ name: 'dark_oak_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.setControlState = (control, value) => {
    controlStates.push({ control, value })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placedState
        ? {
            name: 'dark_oak_trapdoor',
            position,
            getProperties: () => placedState
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'dark_oak_fence_gate', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    assert.deepStrictEqual(controlStates[controlStates.length - 1], { control: 'sneak', value: true })
    calls.push({ reference, faceVector, options })
    placedState = { half: 'bottom', facing: 'south', open: false, powered: false, waterlogged: false }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_trapdoor', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south', open: 'false', powered: 'false', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.y, target.y - 1)
  assert.strictEqual(calls[0].faceVector.y, 1)
  assert.deepStrictEqual(controlStates, [
    { control: 'sneak', value: true },
    { control: 'sneak', value: false }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesTrapdoorAsStatefulTrapdoorReference() {
  const ctx = createContext()
  const target = { x: 2, y: 65, z: 0 }
  const calls = []
  const controlStates = []
  let placedState = null

  ctx.bot.entity.position = vec(target.x, target.y, target.z - 3)
  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.setControlState = (control, value) => {
    controlStates.push({ control, value })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placedState
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => placedState
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return {
        name: 'spruce_trapdoor',
        position,
        getProperties: () => ({ half: 'top', facing: 'north', open: false, powered: false, waterlogged: false })
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'oak_planks', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    assert.deepStrictEqual(controlStates[controlStates.length - 1], { control: 'sneak', value: true })
    calls.push({ reference, faceVector, options })
    placedState = { half: 'top', facing: 'south', open: false, powered: false, waterlogged: false }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'south', open: 'false', powered: 'false', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(calls[0].options.half, 'top')
  assert.deepStrictEqual(controlStates, [
    { control: 'sneak', value: true },
    { control: 'sneak', value: false }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRecoversTrapdoorReferenceReachAfterMoveTimeout() {
  const ctx = createContext()
  const target = { x: 8, y: 64, z: 0 }
  const calls = []
  const goals = []
  const logs = []
  const controlStates = []
  let placedState = null

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(0, 64, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [{ name: 'spruce_trapdoor', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.setControlState = (control, value) => {
    controlStates.push({ control, value })
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(target.x - 3, target.y, target.z - 3)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placedState
        ? {
            name: 'spruce_trapdoor',
            position,
            getProperties: () => placedState
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return {
        name: 'spruce_trapdoor',
        position,
        getProperties: () => ({ half: 'top', facing: 'north', open: false, powered: false, waterlogged: false })
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'oak_planks', position, getProperties: () => ({}) }
    }
    if (position.y === target.y - 1) return { name: 'stone', position, getProperties: () => ({}) }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placedState = { half: 'top', facing: 'south', open: false, powered: false, waterlogged: false }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('trapdoor_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_trapdoor', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'south', open: 'false', powered: 'false', waterlogged: 'false' },
    timeoutMs: 1,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(goals.length >= 1, true)
  assert.ok(logs.some(message => message.includes('partial_move_reference_reachable')))
  assert.deepStrictEqual(controlStates, [
    { control: 'sneak', value: true },
    { control: 'sneak', value: false }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulTopStairPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const goals = []
  let placed = false
  ctx.bot.entity.position = vec(target.x, target.y, target.z - 4)
  ctx.bot.inventory.items = () => [{ name: 'spruce_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'spruce_stairs' : 'air',
        position,
        getProperties: () => placed ? { half: 'top', facing: 'west' } : {}
      }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_stairs', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'west' }
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(goals.length, 1)
  assert.ok(goals[0].x > target.x)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].options.half, 'top')
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(calls[0].faceVector.x, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulBottomStairPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const goals = []
  const lookCalls = []
  let placed = false
  ctx.bot.entity.position = vec(target.x, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'spruce_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'spruce_stairs' : 'air',
        position,
        getProperties: () => placed ? { half: 'bottom', facing: 'north' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }
  ctx.bot.lookAt = async (lookTarget, force) => {
    lookCalls.push({ lookTarget, force, from: ctx.bot.entity.position })
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'north' }
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goals.some(goal => goal.z > target.z), JSON.stringify(goals))
  assert.strictEqual(lookCalls.length, 1)
  assert.strictEqual(lookCalls[0].force, false)
  assert.ok(lookCalls[0].lookTarget.z < lookCalls[0].from.z, JSON.stringify(lookCalls[0]))
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].options.half, 'bottom')
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPreservesStairFacingYawDuringStatefulPlace() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const digs = []
  const lookCalls = []
  let placedFacing = null

  ctx.bot.entity.position = vec(target.x + 2, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'spruce_stairs', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async (lookTarget, force) => {
    lookCalls.push({ lookTarget, force, from: ctx.bot.entity.position })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placedFacing ? 'spruce_stairs' : 'air',
        position,
        getProperties: () => placedFacing ? { half: 'bottom', facing: placedFacing } : {}
      }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placedFacing = options.forceLook === 'ignore' ? 'west' : 'north'
  }
  ctx.bot.dig = async block => {
    digs.push(block)
    placedFacing = null
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'west' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(lookCalls.length, 1)
  assert.strictEqual(lookCalls[0].force, false)
  assert.ok(lookCalls[0].lookTarget.x < lookCalls[0].from.x, JSON.stringify(lookCalls[0]))
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x - 1)
  assert.strictEqual(calls[0].faceVector.x, 1)
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(placedFacing, 'west')
  assert.strictEqual(digs.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

async function testPlaceBlockUsesAvailableMaterialForStairTemporaryReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map()
  const placedTemporary = []
  const clearedTemporary = []
  const statefulCalls = []
  const goals = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x, target.y, target.z)
  ctx.bot.inventory.items = () => [
    { name: 'spruce_stairs', count: 1 },
    { name: 'cobblestone', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'spruce_stairs'
          ? { half: 'bottom', facing: 'north' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: 'air',
        position,
        getProperties: () => ({})
      }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    assert.strictEqual(ctx.bot.heldItem.name, 'spruce_stairs')
    occupied.set(key(target), 'spruce_stairs')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    clearedTemporary.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'spruce_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'north' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goals.some(goal => goal.z > target.z), JSON.stringify(goals))
  assert.deepStrictEqual(placedTemporary.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'cobblestone@2,64,-1'
  ])
  assert.deepStrictEqual(clearedTemporary.map(position => `${position.x},${position.y},${position.z}`), [
    '2,64,-1'
  ])
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.x, target.x)
  assert.strictEqual(statefulCalls[0].reference.position.y, target.y)
  assert.strictEqual(statefulCalls[0].reference.position.z, target.z - 1)
  assert.strictEqual(statefulCalls[0].options.half, 'bottom')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsStairTemporaryReferenceColumn() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'stone'],
    ['2,62,1', 'stone']
  ])
  const placedTemporary = []
  const clearedTemporary = []
  const statefulCalls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x, target.y, target.z - 2)
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_stairs', count: 1 },
    { name: 'cobblestone', count: 2 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'dark_oak_stairs'
          ? { half: 'bottom', facing: 'south' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    assert.strictEqual(ctx.bot.heldItem.name, 'dark_oak_stairs')
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    clearedTemporary.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(placedTemporary.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'cobblestone@2,63,1',
    'cobblestone@2,64,1'
  ])
  assert.deepStrictEqual(clearedTemporary.map(position => `${position.x},${position.y},${position.z}`), [
    '2,64,1',
    '2,63,1'
  ])
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.x, target.x)
  assert.strictEqual(statefulCalls[0].reference.position.y, target.y)
  assert.strictEqual(statefulCalls[0].reference.position.z, target.z + 1)
  assert.strictEqual(statefulCalls[0].faceVector.z, -1)
  assert.strictEqual(statefulCalls[0].options.half, 'bottom')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockSkipsReservedStairTemporaryReferenceColumn() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['2,63,1', 'stone'],
    ['3,63,0', 'stone']
  ])
  const placedTemporary = []
  const clearedTemporary = []
  const statefulCalls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x, target.y, target.z - 2)
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_stairs', count: 1 },
    { name: 'cobblestone', count: 2 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'dark_oak_stairs'
          ? { half: 'bottom', facing: 'south' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    clearedTemporary.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'south' },
    reservedPositions: new Set(['2,64,1']),
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(placedTemporary.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'cobblestone@3,64,0'
  ])
  assert.deepStrictEqual(clearedTemporary.map(position => `${position.x},${position.y},${position.z}`), [
    '3,64,0'
  ])
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.x, target.x + 1)
  assert.strictEqual(statefulCalls[0].reference.position.y, target.y)
  assert.strictEqual(statefulCalls[0].reference.position.z, target.z)
  assert.strictEqual(statefulCalls[0].options.half, 'bottom')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockAllowsReservedPendingStairTemporaryReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map([
    ['1,63,0', 'stone'],
    ['3,64,0', 'dark_oak_button'],
    ['2,63,1', 'dark_oak_button'],
    ['2,63,-1', 'dark_oak_button']
  ])
  const placedTemporary = []
  const clearedTemporary = []
  const statefulCalls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x + 2, target.y, target.z)
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_stairs', count: 1 },
    { name: 'cobblestone', count: 1 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'dark_oak_stairs'
          ? { half: 'bottom', facing: 'west' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    clearedTemporary.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'west' },
    reservedPositions: new Set(['1,64,0']),
    temporaryReferenceAllowedPositions: new Set(['1,64,0']),
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(placedTemporary.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'cobblestone@1,64,0'
  ])
  assert.deepStrictEqual(clearedTemporary.map(position => `${position.x},${position.y},${position.z}`), [
    '1,64,0'
  ])
  assert.strictEqual(occupied.has('1,64,0'), false)
  assert.strictEqual(occupied.get('2,64,0'), 'dark_oak_stairs')
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.x, target.x - 1)
  assert.strictEqual(statefulCalls[0].faceVector.x, 1)
  assert.strictEqual(statefulCalls[0].options.half, 'bottom')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesDiagonalStairFacingStandWhenDirectStandBlocked() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map()
  const goals = []
  const calls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    const placedName = occupied.get(key(position))
    if (placedName) {
      return {
        name: placedName,
        position,
        getProperties: () => placedName === 'dark_oak_stairs'
          ? { half: 'bottom', facing: 'north' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y && (position.z === target.z + 2 || position.z === target.z + 3)) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'north' },
    reservedPositions: new Set([
      `${target.x + 1},${target.y},${target.z + 2}`,
      `${target.x - 1},${target.y},${target.z + 2}`
    ]),
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  const stairStandGoal = goals.find(goal => goal.x !== target.x && goal.z > target.z)
  assert.ok(stairStandGoal, JSON.stringify(goals))
  assert.ok(stairStandGoal.rangeSq <= 0.35 ** 2 + 0.000001, JSON.stringify(stairStandGoal))
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].options.half, 'bottom')
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesWideStairFacingStandAtEdge() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map()
  const goals = []
  const calls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x - 2, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    const placedName = occupied.get(key(position))
    if (placedName) {
      return {
        name: placedName,
        position,
        getProperties: () => placedName === 'dark_oak_stairs'
          ? { half: 'bottom', facing: 'north' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 2 && position.y === target.y - 1 && position.z === target.z + 2) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'north' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  const stairStandGoal = goals.find(goal => goal.x === target.x - 2 && goal.z === target.z + 2)
  assert.ok(stairStandGoal, JSON.stringify(goals))
  assert.ok(stairStandGoal.rangeSq <= 0.35 ** 2 + 0.000001, JSON.stringify(stairStandGoal))
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(calls[0].options.half, 'bottom')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackWhenStairFacingStandUnavailable() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map()
  const calls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x - 2, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = () => {
    throw new Error('stair_facing_stand_should_not_move_when_unavailable')
  }
  ctx.bot.blockAt = position => {
    const placedName = occupied.get(key(position))
    if (placedName) {
      return {
        name: placedName,
        position,
        getProperties: () => placedName === 'dark_oak_stairs'
          ? { half: 'bottom', facing: 'north' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'north' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_stair_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x - 1)
  assert.strictEqual(calls[0].faceVector.x, 1)
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackWhenStairFacingStandMoveTimesOut() {
  const ctx = createContext()
  const target = { x: 4, y: 66, z: 0 }
  const calls = []
  const goals = []
  let placed = false

  ctx.bot.entity.position = vec(0, 64, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.lookAt = async () => {}
  ctx.bot.pathfinder.setGoal = goal => {
    if (goal) goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'dark_oak_stairs' : 'air',
        position,
        getProperties: () => placed ? { half: 'bottom', facing: 'north' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'bottom', facing: 'north' },
    allowCurrentReferenceReachForHighTargets: true,
    standMoveAttempts: 1,
    timeoutMs: 1,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goals.length >= 1)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(calls[0].options.forceLook, 'ignore')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesHighOneAwayStairFacingStandAtEdge() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const occupied = new Map()
  const calls = []
  const goals = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x - 2, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_stairs', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    const placedName = occupied.get(key(position))
    if (placedName) {
      return {
        name: placedName,
        position,
        getProperties: () => placedName === 'dark_oak_stairs'
          ? { half: 'top', facing: 'west' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x + 1 && position.y === target.y + 1 && position.z === target.z) {
      return { name: 'dirt', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    occupied.set(key(target), 'dark_oak_stairs')
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('top_stair_should_use_stateful_place')
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_stairs', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'west' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(goals[0].x, target.x + 1)
  assert.strictEqual(goals[0].y, target.y + 2)
  assert.strictEqual(goals[0].z, target.z)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x - 1)
  assert.strictEqual(calls[0].faceVector.x, 1)
  assert.strictEqual(calls[0].options.half, 'top')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulTopSlabPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_slab', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'dark_oak_slab' : 'air',
        position,
        getProperties: () => placed ? { type: 'top', waterlogged: 'false' } : {}
      }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('top_slab_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_slab', {
    owner: 'test',
    blockStates: { type: 'top', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x - 1)
  assert.strictEqual(calls[0].faceVector.x, 1)
  assert.strictEqual(calls[0].options.half, 'top')
  assert.strictEqual(calls[0].options.forceLook, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRepairsWrongBlockAfterStatefulTopSlabMisplace() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const digs = []
  let targetBlock = 'air'
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_slab', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: targetBlock,
        position,
        getProperties: () => targetBlock === 'dark_oak_slab'
          ? { type: 'top', waterlogged: 'false' }
          : {}
      }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('top_slab_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    targetBlock = calls.length === 1 ? 'dirt' : 'dark_oak_slab'
  }
  ctx.bot.dig = async block => {
    digs.push(block)
    assert.strictEqual(block.name, 'dirt')
    targetBlock = 'air'
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_slab', {
    owner: 'test',
    blockStates: { type: 'top', waterlogged: 'false' },
    repairObstructedTarget: true,
    placementAttempts: 2,
    retryDelayMs: 1,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed_after_retry')
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(digs.length, 1)
  assert.strictEqual(targetBlock, 'dark_oak_slab')
  assert.strictEqual(calls[0].faceVector.x, 1)
  assert.strictEqual(calls[1].faceVector.x, 1)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesDoubleSlabMergePlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let stage = 0
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_slab', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: stage === 0 ? 'air' : 'dark_oak_slab',
        position,
        getProperties: () => stage >= 2
          ? { type: 'double', waterlogged: 'false' }
          : stage === 1
            ? { type: 'bottom', waterlogged: 'false' }
            : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('double_slab_should_use_merge_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    stage += 1
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_slab', {
    owner: 'test',
    blockStates: { type: 'double', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'double_slab_placed')
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(calls[0].reference.position.y, target.y - 1)
  assert.strictEqual(calls[0].faceVector.y, 1)
  assert.strictEqual(calls[0].options.half, 'bottom')
  assert.strictEqual(calls[1].reference.position.y, target.y)
  assert.strictEqual(calls[1].faceVector.y, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulBottomSlabPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_slab', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'dark_oak_slab' : 'air',
        position,
        getProperties: () => placed ? { type: 'bottom', waterlogged: 'false' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bottom_slab_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_slab', {
    owner: 'test',
    blockStates: { type: 'bottom', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].faceVector.y, 1)
  assert.strictEqual(calls[0].options.half, 'bottom')
  assert.strictEqual(calls[0].options.forceLook, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsTemporaryReferenceForStatefulBottomSlab() {
  const ctx = createContext()
  const target = { x: 2, y: 66, z: 0 }
  const occupied = new Map([
    ['2,63,0', 'stone']
  ])
  const temporaryPlaced = []
  const temporaryCleared = []
  const statefulCalls = []
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_slab', count: 1 },
    { name: 'dirt', count: 4 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`
    const name = occupied.get(key) || 'air'
    return {
      name,
      position,
      getProperties: () => name === 'dark_oak_slab'
        ? { type: 'bottom', waterlogged: 'false' }
        : {}
    }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(`${position.x},${position.y},${position.z}`, blockName)
    temporaryPlaced.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    occupied.set(`${target.x},${target.y},${target.z}`, 'dark_oak_slab')
  }
  ctx.bot.dig = async block => {
    occupied.delete(`${block.position.x},${block.position.y},${block.position.z}`)
    temporaryCleared.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_slab', {
    owner: 'test',
    blockStates: { type: 'bottom', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(occupied.get('2,66,0'), 'dark_oak_slab')
  assert.deepStrictEqual(temporaryPlaced.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'dirt@2,64,0',
    'dirt@2,65,0'
  ])
  assert.deepStrictEqual(temporaryCleared.map(position => `${position.x},${position.y},${position.z}`), [
    '2,65,0',
    '2,64,0'
  ])
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.y, target.y - 1)
  assert.strictEqual(statefulCalls[0].faceVector.y, 1)
  assert.strictEqual(statefulCalls[0].options.half, 'bottom')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsSideTemporaryReferenceForStatefulTopSlab() {
  const ctx = createContext()
  const target = { x: 2, y: 66, z: 0 }
  const occupied = new Map([
    ['2,64,0', 'stone'],
    ['1,65,0', 'stone']
  ])
  const temporaryPlaced = []
  const temporaryCleared = []
  const statefulCalls = []
  ctx.bot.inventory.items = () => [
    { name: 'dark_oak_slab', count: 1 },
    { name: 'dirt', count: 4 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const blockKey = `${position.x},${position.y},${position.z}`
    const name = occupied.get(blockKey) || 'air'
    return {
      name,
      position,
      getProperties: () => name === 'dark_oak_slab'
        ? { type: 'top', waterlogged: 'false' }
        : {}
    }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(`${position.x},${position.y},${position.z}`, blockName)
    temporaryPlaced.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    occupied.set(`${target.x},${target.y},${target.z}`, 'dark_oak_slab')
  }
  ctx.bot.dig = async block => {
    occupied.delete(`${block.position.x},${block.position.y},${block.position.z}`)
    temporaryCleared.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_slab', {
    owner: 'test',
    blockStates: { type: 'top', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(occupied.get('2,66,0'), 'dark_oak_slab')
  assert.deepStrictEqual(temporaryPlaced.map(entry => `${entry.blockName}@${entry.position.x},${entry.position.y},${entry.position.z}`), [
    'dirt@1,66,0'
  ])
  assert.deepStrictEqual(temporaryCleared.map(position => `${position.x},${position.y},${position.z}`), [
    '1,66,0'
  ])
  assert.strictEqual(statefulCalls.length, 1)
  assert.strictEqual(statefulCalls[0].reference.position.x, target.x - 1)
  assert.strictEqual(statefulCalls[0].reference.position.y, target.y)
  assert.strictEqual(statefulCalls[0].faceVector.x, 1)
  assert.strictEqual(statefulCalls[0].options.half, 'top')
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulWallButtonPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_button', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'dark_oak_button' : 'air',
        position,
        getProperties: () => placed ? { face: 'wall', facing: 'north', powered: 'false' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z + 1) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('wall_button_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_button', {
    owner: 'test',
    blockStates: { face: 'wall', facing: 'north', powered: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z + 1)
  assert.strictEqual(calls[0].faceVector.z, -1)
  assert.strictEqual(calls[0].options.forceLook, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesNorthSupportForSouthFacingWallButton() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_button', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'dark_oak_button' : 'air',
        position,
        getProperties: () => placed ? { face: 'wall', facing: 'south', powered: 'false' } : {}
      }
    }
    if (
      position.x === target.x &&
      position.y === target.y &&
      (position.z === target.z - 1 || position.z === target.z + 1)
    ) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('wall_button_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_button', {
    owner: 'test',
    blockStates: { face: 'wall', facing: 'south', powered: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.strictEqual(calls[0].faceVector.z, 1)
}

async function testPlaceBlockRejectsWrongSideWallButtonSupport() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let placementAttempts = 0
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_button', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z + 1) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placementAttempts += 1
  }
  ctx.bot._placeBlockWithOptions = async () => {
    placementAttempts += 1
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_button', {
    owner: 'test',
    blockStates: { face: 'wall', facing: 'south', powered: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'stateful_button_no_wall_reference')
  assert.strictEqual(placementAttempts, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesStatefulWallButtonReferenceStand() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const goals = []
  const logs = []
  let placed = false
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(2, 64, -4.4)
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_button', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goals.push(goal)
    if (goals.length === 1) {
      ctx.bot.entity.position = vec(target.x, target.y, target.z - 4.4)
      return
    }
    ctx.bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'dark_oak_button' : 'air',
        position,
        getProperties: () => placed ? { face: 'wall', facing: 'north', powered: 'false' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z + 1) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('wall_button_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_button', {
    owner: 'test',
    blockStates: { face: 'wall', facing: 'north', powered: 'false' },
    standMoveAttempts: 6,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(calls.length, 1)
  assert.ok(goals.length >= 2)
  assert.ok(logs.some(message => message.includes('stateful_reference_unreachable_after_move')))
  assert.strictEqual(calls[0].reference.position.z, target.z + 1)
  assert.strictEqual(calls[0].faceVector.z, -1)
  assert.strictEqual(calls[0].options.forceLook, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesStatefulVerticalLogPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'spruce_log', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'spruce_log' : 'air',
        position,
        getProperties: () => placed ? { axis: 'y' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('vertical_log_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_log', {
    owner: 'test',
    blockStates: { axis: 'y' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.y, target.y - 1)
  assert.strictEqual(calls[0].faceVector.y, 1)
  assert.strictEqual(calls[0].options.forceLook, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockMovesForStatefulHorizontalLogReferenceReach() {
  const ctx = createContext()
  const target = { x: 617, y: 70, z: -59 }
  const calls = []
  const goals = []
  let placed = false
  ctx.bot.entity.position = vec(612.5, 67, -56.5)
  ctx.bot.inventory.items = () => [{ name: 'spruce_log', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'spruce_log' : 'air',
        position,
        getProperties: () => placed ? { axis: 'z' } : {}
      }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'spruce_planks', position }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return {
        name: 'spruce_log',
        position,
        getProperties: () => ({ axis: 'y' })
      }
    }
    if (position.y === target.y - 1 && !(position.x === target.x && position.z === target.z)) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('horizontal_log_should_use_stateful_place')
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    const eye = {
      x: ctx.bot.entity.position.x,
      y: ctx.bot.entity.position.y + 1.62,
      z: ctx.bot.entity.position.z
    }
    const referenceCenter = {
      x: reference.position.x + 0.5,
      y: reference.position.y + 0.5,
      z: reference.position.z + 0.5
    }
    const referenceDistance = Math.sqrt(
      (eye.x - referenceCenter.x) ** 2 +
      (eye.y - referenceCenter.y) ** 2 +
      (eye.z - referenceCenter.z) ** 2
    )
    assert.ok(referenceDistance <= 5.6, `stateful reference was not reachable: ${referenceDistance}`)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_log', {
    owner: 'test',
    blockStates: { axis: 'z' },
    forceSafeApproach: true,
    preferHighStand: true,
    allowCurrentReachForHighTargets: true,
    allowCurrentReferenceReachForHighTargets: true,
    allowScaffolding: true,
    moveRange: 4,
    placementAttempts: 2,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'stateful_block_placed')
  assert.ok(goals.length >= 1)
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x)
  assert.strictEqual(calls[0].reference.position.y, target.y)
  assert.strictEqual(calls[0].reference.position.z, target.z - 1)
  assert.strictEqual(calls[0].faceVector.z, 1)
  assert.strictEqual(calls[0].options.forceLook, false)
  assert.strictEqual(result.data.referencePosition.z, target.z - 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsAxisLogTemporaryReferenceBesideGable() {
  // Live failure (L3 renovation): the FIRST gabled-roof ridge oak_log
  // (axis=x) has no x-adjacent reference — its only neighbor is the gable
  // plank BELOW, and the ground is 12 blocks down. The executor must build a
  // temporary side-attached column on the x axis, place the log against its
  // x face, and clear the column.
  const ctx = createContext()
  const target = { x: 5, y: 66, z: 5 } // ridge cell
  const occupied = new Map([
    ['5,65,5', 'oak_planks'] // gable-end plank directly below the ridge
  ])
  const placedTemporary = []
  const clearedTemporary = []
  const statefulCalls = []
  const key = position => `${position.x},${position.y},${position.z}`

  ctx.bot.entity.position = vec(target.x, target.y - 1, target.z - 2)
  ctx.bot.inventory.items = () => [
    { name: 'oak_log', count: 2 },
    { name: 'cobblestone', count: 4 }
  ]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    const occupiedName = occupied.get(key(position))
    if (occupiedName) {
      return {
        name: occupiedName,
        position,
        getProperties: () => occupiedName === 'oak_log' ? { axis: 'x' } : {}
      }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    const blockName = ctx.bot.heldItem?.name || 'air'
    occupied.set(key(position), blockName)
    placedTemporary.push({ position, blockName })
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulCalls.push({ reference, faceVector, options })
    assert.strictEqual(ctx.bot.heldItem.name, 'oak_log')
    occupied.set(key(target), 'oak_log')
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    clearedTemporary.push(block.position)
  }

  const result = await build.placeBlock(ctx, target, 'oak_log', {
    owner: 'test',
    blockStates: { axis: 'x' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  // temp column side-attached to the gable plank, on the x axis of the ridge
  const tempKeys = placedTemporary.map(entry => `${entry.blockName}@${key(entry.position)}`)
  assert.ok(
    tempKeys.includes('cobblestone@4,66,5') || tempKeys.includes('cobblestone@6,66,5'),
    `temp reference on the ridge x-axis: ${JSON.stringify(tempKeys)}`
  )
  assert.strictEqual(statefulCalls.length, 1)
  // the log was placed against an x-face (axis=x)
  assert.strictEqual(Math.abs(statefulCalls[0].faceVector.x), 1)
  assert.strictEqual(statefulCalls[0].faceVector.y, 0)
  assert.strictEqual(statefulCalls[0].faceVector.z, 0)
  // every temporary block was cleared
  assert.strictEqual(clearedTemporary.length, placedTemporary.length, JSON.stringify({ placedTemporary, clearedTemporary }))
  assert.strictEqual(occupied.get(key(target)), 'oak_log')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRejectsHorizontalLogWithoutAxisReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  ctx.bot.inventory.items = () => [{ name: 'spruce_log', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'spruce_planks', position, getProperties: () => ({}) }
    }
    if (position.x === target.x + 1 && position.y === target.y && position.z === target.z) {
      return { name: 'air', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('axis_log_should_not_use_normal_place')
  }
  ctx.bot._placeBlockWithOptions = async reference => {
    calls.push(reference)
  }
  const logs = []
  ctx.logger = { log: line => logs.push(String(line)) }

  const result = await build.placeBlock(ctx, target, 'spruce_log', {
    owner: 'test',
    blockStates: { axis: 'z' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'stateful_axis_no_z_reference')
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  // Round 13 diagnostics: the temp-reference failure is logged, mirrors
  // data.temporaryReferenceError, and lists the same-axis candidates tried.
  const failed = logs.filter(line => line.startsWith('[BUILD_TEMP_REFERENCE_FAILED]'))
  assert.strictEqual(failed.length, 1, JSON.stringify(logs))
  assert.ok(failed[0].includes('target=2,64,0'), failed[0])
  assert.ok(failed[0].includes('block=spruce_log axis=z error=stateful_axis_no_z_reference'), failed[0])
  const reason = failed[0].match(/ reason=(\S+)/)
  assert.ok(reason, failed[0])
  assert.strictEqual(result.data?.temporaryReferenceError, reason[1])
  assert.ok(failed[0].includes('candidates=2,64,-1;2,64,1'), failed[0])
}

async function testPlaceBlockUsesTopReferenceForHangingLantern() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'lantern', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'lantern' : 'air',
        position,
        getProperties: () => placed ? { hanging: 'true' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'chest', position }
    }
    if (position.x === target.x && position.y === target.y + 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    calls.push({ reference, faceVector })
    placed = true
  }

  const check = build.canPlaceBlock(ctx, target, {
    owner: 'test',
    blockName: 'lantern',
    blockStates: { hanging: 'true' }
  })
  assert.strictEqual(check.ok, true, check.error)
  assert.strictEqual(check.data.canPlace, true)
  assert.strictEqual(check.data.referencePosition.y, target.y + 1)

  const result = await build.placeBlock(ctx, target, 'lantern', {
    owner: 'test',
    blockStates: { hanging: 'true' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'hanging_lantern_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.y, target.y + 1)
  assert.strictEqual(calls[0].faceVector.y, -1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesBottomSlabTopReferenceForHangingLantern() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'lantern', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'lantern' : 'air',
        position,
        getProperties: () => placed ? { hanging: 'true', waterlogged: 'false' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y + 1 && position.z === target.z) {
      return {
        name: 'spruce_slab',
        position,
        getProperties: () => ({ type: 'bottom', waterlogged: 'false' })
      }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    calls.push({ reference, faceVector })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'lantern', {
    owner: 'test',
    blockStates: { hanging: 'true', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'hanging_lantern_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.name, 'spruce_slab')
  assert.strictEqual(calls[0].reference.position.y, target.y + 1)
  assert.strictEqual(calls[0].faceVector.y, -1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRejectsHangingLanternWithoutTopSupport() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let placeCalls = 0
  ctx.bot.inventory.items = () => [{ name: 'lantern', count: 1 }]
  ctx.bot.blockAt = position => ({
    name: 'air',
    position,
    getProperties: () => ({})
  })
  ctx.bot.placeBlock = async () => {
    placeCalls += 1
  }

  const result = await build.placeBlock(ctx, target, 'lantern', {
    owner: 'test',
    blockStates: { hanging: 'true', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'hanging_lantern_no_top_support')
  assert.strictEqual(placeCalls, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesBottomTrapdoorTopReferenceForHangingLantern() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const sneakStates = []
  let placed = false
  ctx.bot.inventory.items = () => [{ name: 'lantern', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.setControlState = (control, value) => {
    if (control === 'sneak') sneakStates.push(value)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placed ? 'lantern' : 'air',
        position,
        getProperties: () => placed ? { hanging: 'true' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y + 1 && position.z === target.z) {
      return {
        name: 'dark_oak_trapdoor',
        position,
        getProperties: () => ({ half: 'bottom', facing: 'south', open: false, powered: false, waterlogged: false })
      }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    calls.push({ reference, faceVector })
    placed = true
  }

  const trapdoorCheck = build.canPlaceBlock(ctx, target, {
    owner: 'test',
    blockName: 'lantern',
    blockStates: { hanging: 'true' }
  })
  assert.strictEqual(trapdoorCheck.ok, true, trapdoorCheck.error)
  assert.strictEqual(trapdoorCheck.data.canPlace, true)
  assert.strictEqual(trapdoorCheck.data.referencePosition.y, target.y + 1)

  const result = await build.placeBlock(ctx, target, 'lantern', {
    owner: 'test',
    blockStates: { hanging: 'true' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'hanging_lantern_placed')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].reference.position.y, target.y + 1)
  assert.strictEqual(calls[0].reference.name, 'dark_oak_trapdoor')
  assert.strictEqual(calls[0].faceVector.y, -1)
  assert.deepStrictEqual(sneakStates, [true, false])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRepairsWrongBlockAfterHangingLanternMisplace() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const digs = []
  let targetBlock = 'air'
  ctx.bot.inventory.items = () => [{ name: 'lantern', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: targetBlock,
        position,
        getProperties: () => targetBlock === 'lantern' ? { hanging: 'true' } : {}
      }
    }
    if (position.x === target.x && position.y === target.y + 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    calls.push({ reference, faceVector })
    targetBlock = calls.length === 1 ? 'dirt' : 'lantern'
  }
  ctx.bot.dig = async block => {
    digs.push(block)
    assert.strictEqual(block.name, 'dirt')
    targetBlock = 'air'
  }

  const result = await build.placeBlock(ctx, target, 'lantern', {
    owner: 'test',
    blockStates: { hanging: 'true' },
    repairObstructedTarget: true,
    placementAttempts: 2,
    retryDelayMs: 1,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'hanging_lantern_placed_after_retry')
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(digs.length, 1)
  assert.strictEqual(targetBlock, 'lantern')
  assert.strictEqual(calls[0].faceVector.y, -1)
  assert.strictEqual(calls[1].faceVector.y, -1)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockStacksCandleToExpectedCount() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let targetBlock = 'air'
  let candleCount = 0

  ctx.bot.inventory.items = () => [{ name: 'white_candle', count: 3 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: targetBlock,
        position,
        getProperties: () => targetBlock === 'white_candle'
          ? { candles: String(candleCount), lit: 'false', waterlogged: 'false' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    calls.push({ type: 'place', reference, faceVector })
    assert.strictEqual(ctx.bot.heldItem.name, 'white_candle')
    targetBlock = 'white_candle'
    candleCount = 1
  }
  ctx.bot.activateBlock = async block => {
    calls.push({ type: 'activate', block })
    assert.strictEqual(block.name, 'white_candle')
    assert.strictEqual(ctx.bot.heldItem.name, 'white_candle')
    candleCount += 1
  }

  const result = await build.placeBlock(ctx, target, 'white_candle', {
    owner: 'test',
    blockStates: { candles: '3', lit: 'false', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'candle_stack_placed')
  assert.deepStrictEqual(calls.map(call => call.type), ['place', 'activate', 'activate'])
  assert.strictEqual(candleCount, 3)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockExtendsExistingCandleStackWithoutClearing() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  let candleCount = 1

  ctx.bot.inventory.items = () => [{ name: 'white_candle', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: 'white_candle',
        position,
        getProperties: () => ({ candles: String(candleCount), lit: 'false', waterlogged: 'false' })
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('existing_candle_stack_should_activate_without_replace')
  }
  ctx.bot.dig = async () => {
    throw new Error('existing_candle_stack_should_not_clear')
  }
  ctx.bot.activateBlock = async block => {
    calls.push(block)
    assert.strictEqual(block.name, 'white_candle')
    candleCount += 1
  }

  const result = await build.placeBlock(ctx, target, 'white_candle', {
    owner: 'test',
    blockStates: { candles: '3', lit: 'false', waterlogged: 'false' },
    repairObstructedTarget: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'candle_stack_placed')
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(candleCount, 3)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRejectsIncompleteCandleStackState() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let targetBlock = 'air'
  let candleCount = 0
  let activateCalls = 0

  ctx.bot.inventory.items = () => [{ name: 'white_candle', count: 3 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: targetBlock,
        position,
        getProperties: () => targetBlock === 'white_candle'
          ? { candles: String(candleCount), lit: 'false', waterlogged: 'false' }
          : {}
      }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    targetBlock = 'white_candle'
    candleCount = 1
  }
  ctx.bot.activateBlock = async () => {
    activateCalls += 1
  }

  const result = await build.placeBlock(ctx, target, 'white_candle', {
    owner: 'test',
    blockStates: { candles: '3', lit: 'false', waterlogged: 'false' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'place_failed:state_mismatch:candles:1!=3')
  assert.strictEqual(activateCalls, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockClearsWrongStateTopStairBeforeAlternateReference() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const calls = []
  const digs = []
  let placedFacing = null
  ctx.bot.entity.position = vec(target.x + 3, target.y, target.z)
  ctx.bot.inventory.items = () => [{ name: 'spruce_stairs', count: 2 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return {
        name: placedFacing ? 'spruce_stairs' : 'air',
        position,
        getProperties: () => placedFacing ? { half: 'top', facing: placedFacing } : {}
      }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y && position.z === target.z - 1) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y - 1) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    calls.push({ reference, faceVector, options })
    placedFacing = calls.length === 1 ? 'south' : 'west'
  }
  ctx.bot.dig = async block => {
    digs.push(block)
    assert.strictEqual(block.name, 'spruce_stairs')
    placedFacing = null
  }

  const result = await build.placeBlock(ctx, target, 'spruce_stairs', {
    owner: 'test',
    blockStates: { half: 'top', facing: 'west' },
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(digs.length, 1)
  assert.strictEqual(calls[0].reference.position.x, target.x - 1)
  assert.strictEqual(calls[1].reference.position.z, target.z - 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

async function testPlaceBlockFallsBackToAvailableSideReferenceForTripwireHook() {
  const ctx = createContext()
  const references = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'tripwire_hook', count: 1 }]
  ctx.bot.equip = async item => {
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'tripwire_hook' : 'air', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'dark_oak_trapdoor', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    references.push(reference.position)
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'tripwire_hook', {
    owner: 'test',
    blockStates: { facing: 'west' }
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(references.length, 1)
  assert.strictEqual(references[0].x, target.x - 1)
  assert.strictEqual(references[0].y, target.y)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockOrientsFenceGateFacingAndConfirmsState() {
  const directionByFacing = {
    north: { x: 0, z: -1 },
    east: { x: 1, z: 0 },
    south: { x: 0, z: 1 },
    west: { x: -1, z: 0 }
  }

  for (const [facing, direction] of Object.entries(directionByFacing)) {
    const ctx = createContext()
    const lookCalls = []
    const statefulPlacements = []
    const pathfinderGoals = []
    const activationPackets = []
    let directPlaceCalled = false
    let placed = false
    let placedFacing = null
    let open = false
    let activationCount = 0
    const target = { x: 2, y: 64, z: 0 }
    ctx.bot.entity.position = vec(
      target.x + 0.5 - direction.x * 2,
      target.y,
      target.z + 0.5 - direction.z * 2
    )
    ctx.bot.inventory.items = () => [{ name: 'dark_oak_fence_gate', count: 1 }]
    ctx.bot.supportFeature = feature => feature === 'blockPlaceHasInsideBlock'
    ctx.bot._client = {
      write(name, packet) {
        activationPackets.push({ name, packet })
        activationCount += 1
        open = !open
      }
    }
    ctx.bot.pathfinder.setGoal = goal => {
      pathfinderGoals.push(goal)
    }
    ctx.bot.lookAt = async (lookTarget, forceLook) => {
      lookCalls.push({ lookTarget, forceLook })
      const dx = Math.sign(lookTarget.x - ctx.bot.entity.position.x)
      const dz = Math.sign(lookTarget.z - ctx.bot.entity.position.z)
      placedFacing = Object.keys(directionByFacing)
        .find(candidate => directionByFacing[candidate].x === dx && directionByFacing[candidate].z === dz)
    }
    ctx.bot.blockAt = position => {
      if (position.x === target.x && position.y === target.y && position.z === target.z) {
        return placed
          ? {
              name: 'dark_oak_fence_gate',
              position,
              getProperties: () => ({ facing: placedFacing, open, powered: false, in_wall: false })
            }
          : { name: 'air', position }
      }
      if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
        return { name: 'stone', position }
      }
      return { name: 'air', position }
    }
    ctx.bot.placeBlock = async () => {
      directPlaceCalled = true
      placed = true
    }
    ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
      statefulPlacements.push({ reference, faceVector, options })
      placed = true
    }
    ctx.bot.activateBlock = async () => {
      throw new Error('generic activateBlock must not reorient a fence gate')
    }

    const result = await build.placeBlock(ctx, target, 'dark_oak_fence_gate', {
      owner: 'test',
      blockStates: { facing, open: 'true', powered: 'false', in_wall: 'false' },
      requireStateConfirmation: true,
      stableConfirmDelayMs: 1
    })

    assert.strictEqual(result.ok, true, `${facing}:${result.error}`)
    assert.strictEqual(directPlaceCalled, false, facing)
    assert.strictEqual(statefulPlacements.length, 1, facing)
    assert.strictEqual(statefulPlacements[0].options.forceLook, 'ignore', facing)
    assert.strictEqual(statefulPlacements[0].options.swingArm, 'right', facing)
    assert.deepStrictEqual(pathfinderGoals, [null], facing)
    assert.strictEqual(lookCalls.length, 2, facing)
    for (const lookCall of lookCalls) {
      assert.strictEqual(lookCall.forceLook, false, facing)
      assert.strictEqual(Math.sign(lookCall.lookTarget.x - ctx.bot.entity.position.x), direction.x, facing)
      assert.strictEqual(Math.sign(lookCall.lookTarget.z - ctx.bot.entity.position.z), direction.z, facing)
    }
    assert.strictEqual(placedFacing, facing)
    assert.strictEqual(open, true)
    assert.strictEqual(activationCount, 1)
    assert.strictEqual(activationPackets.length, 1)
    assert.strictEqual(activationPackets[0].name, 'block_place')
    assert.strictEqual(activationPackets[0].packet.insideBlock, false)
    assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  }
}

async function testFenceGateWrongStateCleanupRequestsMaterialRefill() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const gate = { name: 'dark_oak_fence_gate', count: 1 }
  let placed = false
  let placementCount = 0
  let cleanupCount = 0
  ctx.bot.inventory.items = () => gate.count > 0 ? [gate] : []
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'dark_oak_fence_gate',
            position,
            getProperties: () => ({ facing: 'east', open: false, powered: false, in_wall: false })
          }
        : { name: 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async () => {
    placementCount += 1
    gate.count -= 1
    ctx.bot.heldItem = null
    placed = true
  }
  ctx.bot.dig = async () => {
    cleanupCount += 1
    placed = false
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_fence_gate', {
    owner: 'test',
    blockStates: { facing: 'north', open: 'false', powered: 'false', in_wall: 'false' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    placementAttempts: 3
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'placement_retry_requires_material_refill:dark_oak_fence_gate')
  assert.strictEqual(result.recoverable, true)
  assert.strictEqual(result.recoveryType, 'material_refill')
  assert.strictEqual(result.consumedBy, 'wrong_state_cleanup')
  assert.strictEqual(placementCount, 1)
  assert.strictEqual(cleanupCount, 1)
  assert.strictEqual(gate.count, 0)
  assert.strictEqual(placed, false)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function assertPlaceBlockOrientsOpposedFacing(blockName, blockId, itemId) {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const lookCalls = []
  const statefulPlacements = []
  let placed = false
  let placedFacing = 'west'
  let lastLookDirection = null

  ctx.bot.registry.blocksByName[blockName] = { id: blockId, name: blockName }
  ctx.bot.registry.itemsByName[blockName] = { id: itemId, name: blockName }
  ctx.bot.inventory.items = () => [{ name: blockName, count: 1 }]
  ctx.bot.lookAt = async (lookTarget, forceLook) => {
    lookCalls.push({ lookTarget, forceLook })
    if (lookTarget.x > ctx.bot.entity.position.x) lastLookDirection = 'east'
    else if (lookTarget.x < ctx.bot.entity.position.x) lastLookDirection = 'west'
    else if (lookTarget.z > ctx.bot.entity.position.z) lastLookDirection = 'south'
    else if (lookTarget.z < ctx.bot.entity.position.z) lastLookDirection = 'north'
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: blockName,
            position,
            getProperties: () => ({ lit: false, facing: placedFacing })
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position, getProperties: () => ({}) }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulPlacements.push({ reference, faceVector, options })
    placed = true
    const opposite = { east: 'west', west: 'east', south: 'north', north: 'south' }
    placedFacing = opposite[lastLookDirection] || 'west'
  }
  ctx.bot.placeBlock = async () => {
    throw new Error(`${blockName}_should_use_orientation_preserving_place`)
  }

  const result = await build.placeBlock(ctx, target, blockName, {
    owner: 'test',
    blockStates: { lit: 'false', facing: 'east' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(lookCalls.length, 1)
  assert.strictEqual(lookCalls[0].forceLook, false)
  assert.ok(lookCalls[0].lookTarget.x < ctx.bot.entity.position.x)
  assert.strictEqual(statefulPlacements.length, 1)
  assert.strictEqual(statefulPlacements[0].options.forceLook, 'ignore')
  assert.strictEqual(statefulPlacements[0].options.swingArm, 'right')
  assert.strictEqual(placedFacing, 'east')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockOrientsFurnaceFacingAndConfirmsState() {
  await assertPlaceBlockOrientsOpposedFacing('furnace', 40, 41)
}

async function testPlaceBlockOrientsChestFacingAndConfirmsState() {
  await assertPlaceBlockOrientsOpposedFacing('chest', 42, 43)
}

async function testPlaceBlockAlignsDoorOpenStateAfterPlacement() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let placed = false
  let open = false
  let facing = 'west'
  let activations = 0
  let directPlaceCalled = false
  let lastLookDirection = null
  let activeGoal = null
  const lookCalls = []
  const goals = []
  ctx.bot.entity.position = vec(4, 64, 0)
  ctx.bot.registry.blocksByName.spruce_door = { id: 28, name: 'spruce_door' }
  ctx.bot.registry.itemsByName.spruce_door = { id: 109, name: 'spruce_door' }
  ctx.bot.inventory.items = () => [{ name: 'spruce_door', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    activeGoal = goal
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
    }
  }
  ctx.bot.lookAt = async (lookTarget, forceLook) => {
    lookCalls.push({ lookTarget, forceLook })
    if (lookTarget.x > ctx.bot.entity.position.x) lastLookDirection = 'east'
    else if (lookTarget.x < ctx.bot.entity.position.x) lastLookDirection = 'west'
    else if (lookTarget.z > ctx.bot.entity.position.z) lastLookDirection = 'south'
    else if (lookTarget.z < ctx.bot.entity.position.z) lastLookDirection = 'north'
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'spruce_door',
            position,
            getProperties: () => ({ half: 'lower', facing, hinge: 'left', open })
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.y === target.y - 1) {
      return { name: 'stone', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot.placeBlock = async () => {
    directPlaceCalled = true
    placed = true
  }
  const statefulPlacements = []
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulPlacements.push({ reference, faceVector, options })
    facing = activeGoal == null ? (lastLookDirection || facing) : 'south'
    placed = true
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'spruce_door')
    activations += 1
    open = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_door', {
    owner: 'test',
    blockStates: { half: 'lower', facing: 'east', hinge: 'left', open: 'true', powered: 'false' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(directPlaceCalled, false)
  assert.strictEqual(statefulPlacements.length, 1)
  assert.strictEqual(statefulPlacements[0].options.forceLook, 'ignore')
  assert.strictEqual(statefulPlacements[0].options.swingArm, 'right')
  assert.strictEqual(lookCalls.length, 1)
  assert.strictEqual(lookCalls[0].forceLook, false)
  assert.ok(lookCalls[0].lookTarget.x > ctx.bot.entity.position.x)
  assert.ok(goals.some(goal => goal && goal.x < target.x))
  assert.strictEqual(activeGoal, null)
  assert.strictEqual(facing, 'east')
  assert.strictEqual(activations, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackToSideReferenceForDoor() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  let placed = false
  let facing = 'west'
  let lastLookDirection = null
  const statefulPlacements = []
  ctx.bot.entity.position = vec(4, 64, 0)
  ctx.bot.registry.blocksByName.spruce_door = { id: 28, name: 'spruce_door' }
  ctx.bot.registry.itemsByName.spruce_door = { id: 109, name: 'spruce_door' }
  ctx.bot.inventory.items = () => [{ name: 'spruce_door', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      ctx.bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
    }
  }
  ctx.bot.lookAt = async lookTarget => {
    if (lookTarget.x > ctx.bot.entity.position.x) lastLookDirection = 'east'
    else if (lookTarget.x < ctx.bot.entity.position.x) lastLookDirection = 'west'
    else if (lookTarget.z > ctx.bot.entity.position.z) lastLookDirection = 'south'
    else if (lookTarget.z < ctx.bot.entity.position.z) lastLookDirection = 'north'
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'spruce_door',
            position,
            getProperties: () => ({ half: 'lower', facing, hinge: 'left', open: false })
          }
        : { name: 'air', position, getProperties: () => ({}) }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x && position.y === target.y && Math.abs(position.z - target.z) === 1) {
      return { name: 'spruce_planks', position }
    }
    return { name: 'air', position, getProperties: () => ({}) }
  }
  ctx.bot._placeBlockWithOptions = async (reference, faceVector, options) => {
    statefulPlacements.push({ reference, faceVector, options })
    if (faceVector.y > 0) return
    facing = lastLookDirection || facing
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_door', {
    owner: 'test',
    blockStates: { half: 'lower', facing: 'west', hinge: 'left', open: 'false', powered: 'false' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1,
    placementAttempts: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(statefulPlacements.length, 2)
  assert.strictEqual(statefulPlacements[0].faceVector.y, 1)
  assert.strictEqual(statefulPlacements[1].faceVector.y, 0)
  assert.strictEqual(facing, 'west')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceFenceGateSneaksAgainstFenceGateReference() {
  const ctx = createContext()
  const controlStates = []
  let placed = false
  const target = { x: 2, y: 65, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'dark_oak_fence_gate', count: 1 }]
  ctx.bot.lookAt = async () => {}
  ctx.bot.setControlState = (control, value) => {
    controlStates.push({ control, value })
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return placed
        ? {
            name: 'dark_oak_fence_gate',
            position,
            getProperties: () => ({ facing: 'north', open: true, powered: false, in_wall: false })
          }
        : { name: 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'dark_oak_fence_gate', position }
    }
    return { name: 'air', position }
  }
  ctx.bot._placeBlockWithOptions = async () => {
    assert.deepStrictEqual(controlStates[controlStates.length - 1], { control: 'sneak', value: true })
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dark_oak_fence_gate', {
    owner: 'test',
    blockStates: { facing: 'north', open: 'true', powered: 'false', in_wall: 'false' },
    requireStateConfirmation: true,
    stableConfirmDelayMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(controlStates, [
    { control: 'sneak', value: true },
    { control: 'sneak', value: false }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockOrientsImportedBedFoot() {
  const ctx = createContext()
  const lookTargets = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'red_bed', count: 1 }]
  ctx.bot.lookAt = async lookTarget => {
    lookTargets.push(lookTarget)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'red_bed' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'red_bed', {
    owner: 'test',
    blockStates: { part: 'foot', facing: 'west', occupied: 'false' }
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(lookTargets.length, 1)
  // Vanilla convention: facing west means the head extends west, so the bot
  // must look toward -x when placing the foot.
  assert.ok(lookTargets[0].x < ctx.bot.entity.position.x)
  assert.strictEqual(lookTargets[0].z, ctx.bot.entity.position.z)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBedKeepsOrientedYawViaGenericPlace() {
  // bot.placeBlock re-looks at the click face and overrides the bed
  // orientation yaw (live: L3 bed landed facing=east instead of south), so
  // bed placement must go through _genericPlace with forceLook ignore.
  const ctx = createContext()
  const genericCalls = []
  let placed = false
  const target = { x: 2, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'white_bed', count: 1 }]
  ctx.bot.lookAt = async () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'white_bed' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'oak_planks', position }
    }
    if (placed && position.x === target.x && position.y === target.y && position.z === target.z + 1) {
      return { name: 'white_bed', position }
    }
    return { name: 'air', position }
  }
  ctx.bot._genericPlace = async (reference, faceVector, options) => {
    genericCalls.push({ reference: { ...reference.position }, faceVector: { ...faceVector }, options })
    placed = true
  }
  ctx.bot.placeBlock = async () => {
    throw new Error('bed placement must not use placeBlock (it overrides yaw)')
  }

  const result = await build.placeBlock(ctx, target, 'white_bed', {
    owner: 'test',
    blockStates: { part: 'foot', facing: 'south' }
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(genericCalls.length, 1)
  assert.strictEqual(genericCalls[0].options.forceLook, 'ignore')
  assert.deepStrictEqual(genericCalls[0].reference, { x: 2, y: 63, z: 0 })
  assert.deepStrictEqual(genericCalls[0].faceVector, { x: 0, y: 1, z: 0 })
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackToPartnerCellForBedPair() {
  const ctx = createContext()
  const lookTargets = []
  const references = []
  let fallbackPlaced = false
  const target = { x: 2, y: 64, z: 0 }
  // Vanilla convention: facing west -> head partner cell is west of the foot.
  const partner = { x: 1, y: 64, z: 0 }
  ctx.bot.inventory.items = () => [{ name: 'red_bed', count: 1 }]
  ctx.bot.lookAt = async lookTarget => {
    lookTargets.push(lookTarget)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: fallbackPlaced ? 'red_bed' : 'air', position }
    }
    if (position.x === partner.x && position.y === partner.y && position.z === partner.z) {
      return { name: fallbackPlaced ? 'red_bed' : 'air', position }
    }
    if (
      (position.x === target.x || position.x === partner.x) &&
      position.y === target.y - 1 &&
      position.z === target.z
    ) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async reference => {
    references.push(reference.position)
    if (reference.position.x === partner.x && reference.position.y === partner.y - 1) {
      fallbackPlaced = true
    }
  }

  const result = await build.placeBlock(ctx, target, 'red_bed', {
    owner: 'test',
    blockStates: { part: 'foot', facing: 'west', occupied: 'false' }
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.message, 'bed_pair_placed_from_partner')
  assert.strictEqual(references.length, 3)
  assert.strictEqual(references[0].x, target.x)
  assert.strictEqual(references[1].x, target.x)
  assert.strictEqual(references[2].x, partner.x)
  // Foot placement looks toward facing (west, -x); the partner fallback looks
  // back toward the foot cell (east, +x) so the head lands on the target.
  assert.ok(lookTargets[0].x < ctx.bot.entity.position.x)
  assert.ok(lookTargets[lookTargets.length - 1].x > ctx.bot.entity.position.x)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesTransientEquipTimeout() {
  const ctx = createContext()
  const items = [{ name: 'flower_pot', count: 1 }, { name: 'spruce_wood', count: 2 }]
  const target = { x: 2, y: 64, z: 0 }
  let placed = false
  let equipAttempts = 0
  ctx.bot.heldItem = items[0]
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    equipAttempts += 1
    if (equipAttempts === 1) {
      throw new Error('Event updateSlot:0 did not fire within timeout of 20000ms')
    }
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'spruce_wood' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_wood', { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(equipAttempts, 2)
  assert.strictEqual(placed, true)
  assert.strictEqual(ctx.bot.heldItem.name, 'spruce_wood')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesUnconfirmedEquipNoop() {
  const ctx = createContext()
  const items = [{ name: 'lantern', count: 1 }, { name: 'spruce_wood', count: 2 }]
  const target = { x: 2, y: 64, z: 0 }
  let placed = false
  let equipAttempts = 0
  ctx.bot.heldItem = items[0]
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    equipAttempts += 1
    if (equipAttempts === 1) return
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'spruce_wood' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'spruce_wood')
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'spruce_wood', { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(equipAttempts, 2)
  assert.strictEqual(placed, true)
  assert.strictEqual(ctx.bot.heldItem.name, 'spruce_wood')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockEquipsWhenOwnerAlreadyHoldsInventoryLock() {
  const ctx = createContext()
  const items = [{ name: 'lantern', count: 1 }, { name: 'dirt', count: 2 }]
  const target = { x: 2, y: 64, z: 0 }
  let placed = false
  let equipAttempts = 0
  ctx.equipmentSystem = new EquipmentSystem()
  ctx.bot.heldItem = items[0]
  ctx.bot.inventory.items = () => items
  ctx.bot.equip = async item => {
    equipAttempts += 1
    ctx.bot.heldItem = item
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'dirt')
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(equipAttempts, 1)
  assert.strictEqual(placed, true)
  assert.strictEqual(ctx.bot.heldItem.name, 'dirt')
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockBuildsPottedPlant() {
  const ctx = createContext()
  const items = [{ name: 'flower_pot', count: 1 }, { name: 'cornflower', count: 1 }]
  const target = { x: 2, y: 64, z: 0 }
  let targetBlock = 'air'
  let placedPot = false
  let activatedPot = false
  ctx.bot.heldItem = null
  ctx.bot.inventory.items = () => items
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: targetBlock, position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    assert.strictEqual(ctx.bot.heldItem.name, 'flower_pot')
    targetBlock = 'flower_pot'
    placedPot = true
  }
  ctx.bot.activateBlock = async block => {
    assert.strictEqual(block.name, 'flower_pot')
    assert.strictEqual(ctx.bot.heldItem.name, 'cornflower')
    targetBlock = 'potted_cornflower'
    activatedPot = true
  }

  const result = await build.placeBlock(ctx, target, 'potted_cornflower', { owner: 'test' })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.message, 'potted_block_placed')
  assert.strictEqual(placedPot, true)
  assert.strictEqual(activatedPot, true)
  assert.strictEqual(ctx.bot.heldItem.name, 'cornflower')
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesSafeApproachForHighTarget() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 0, y: 66, z: 0 }
  ctx.bot.entity.position = vec(10, 64, 0)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(goals[0].x, 3)
  assert.strictEqual(goals[0].y, 64)
  assert.strictEqual(goals[0].z, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPrefersLowStandForFormalTallTarget() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 0, y: 76, z: 0 }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 69 || position.y === 72) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(goals[0].y, 70)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockCanStandOnTopPlatformForTallTarget() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 0, y: 76, z: 0 }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x + 3 && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'dirt', position }
    }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', { owner: 'test' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(goals[0].x, target.x + 3)
  assert.strictEqual(goals[0].y, target.y)
  assert.strictEqual(goals[0].z, target.z)
  assert.ok(goals[0].rangeSq >= 1.9)
  assert.ok(goals[0].rangeSq <= 2.0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRetriesAlternateStandAfterMoveTimeout() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 0, y: 66, z: 0 }
  ctx.bot.entity.position = vec(10, 64, 0)
  ctx.bot.once = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goals.length === 2) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 1,
    standMoveAttempts: 2
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(goals.length, 2)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

// B-01. Stand candidates reach moveToFirstReachablePlacementStand sorted by
// straight-line distance from the bot, so on a slope the first candidate is
// regularly the one on the far side of a drop. Live case2 acceptance
// 2026-08-01: every candidate for 583,65,-91 sat at y=62, the bot walked 74
// blocks looking for a way down, and the build died with move_timeout.
// The bounded path preview must DEMOTE such a candidate, never drop it.
function testStandPathPrescreenDemotesUnreachableNearestStand() {
  const ctx = createContext()
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(0, 65, 0)
  const target = { x: 5, y: 65, z: 0 }
  const nearestDownSlope = { x: 2, y: 62, z: 1 }
  const fartherOnLevel = { x: 4, y: 65, z: 0 }
  assert.ok(
    Math.hypot(2, -3, 1) < Math.hypot(4, 0, 0),
    'fixture is only meaningful while the unreachable stand is straight-line nearest'
  )
  const probedGoals = []
  ctx.bot.pathfinder.getPathTo = (movements, goal) => {
    probedGoals.push(`${goal.x},${goal.y},${goal.z}`)
    if (goal.y === 62) return { status: 'noPath', cost: 0, path: [] }
    return { status: 'success', cost: 4.2, path: [] }
  }

  const result = build.prescreenPlacementStandsByPathCost(
    ctx,
    target,
    [nearestDownSlope, fartherOnLevel],
    { options: {} }
  )

  assert.strictEqual(result.applied, true)
  assert.strictEqual(result.reason, 'reordered')
  assert.strictEqual(result.probed, 2)
  assert.strictEqual(probedGoals.length, 2)
  // Demoted, not dropped: the caller must never end up with fewer candidates.
  assert.strictEqual(result.stands.length, 2)
  assert.deepStrictEqual(result.stands[0], fartherOnLevel)
  assert.deepStrictEqual(result.stands[1], nearestDownSlope)
}

// Cost guard: a 4800-step build cannot afford a path preview per candidate on
// ordinary flat work, so a candidate on the bot's own level within a few
// blocks must skip the preview entirely.
function testStandPathPrescreenSkipsTrivialNearbyStand() {
  const ctx = createContext()
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(0, 65, 0)
  let probes = 0
  ctx.bot.pathfinder.getPathTo = () => {
    probes += 1
    return { status: 'success', cost: 1, path: [] }
  }

  const result = build.prescreenPlacementStandsByPathCost(
    ctx,
    { x: 3, y: 65, z: 0 },
    [{ x: 2, y: 65, z: 0 }, { x: 4, y: 65, z: 0 }],
    { options: {} }
  )

  assert.strictEqual(result.applied, false)
  assert.strictEqual(result.reason, 'nearest_stand_trivial')
  assert.strictEqual(result.probed, 0)
  assert.strictEqual(probes, 0)
  assert.strictEqual(result.stands.length, 2)
}

// End-to-end over the real reposition loop: the unreachable nearest stand must
// never consume a move attempt, so no move_timeout is recorded and the bot
// lands on the reachable candidate instead.
async function testPlacementStandMoveSkipsUnreachableNearestStand() {
  const ctx = createContext()
  const logs = []
  ctx.logger = { log(message) { logs.push(message) } }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(0, 65, 0)
  ctx.bot.once = () => {}
  const target = { x: 5, y: 65, z: 0 }
  const nearestDownSlope = { x: 2, y: 62, z: 1 }
  const fartherOnLevel = { x: 4, y: 65, z: 0 }
  const goalsSeen = []
  ctx.bot.pathfinder.getPathTo = (movements, goal) => (
    goal.y === 62
      ? { status: 'noPath', cost: 0, path: [] }
      : { status: 'success', cost: 4.2, path: [] }
  )
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goalsSeen.push(`${goal.x},${goal.y},${goal.z}`)
    // Only the on-level stand is walkable; the down-slope one leaves the bot
    // where it stands, which is what produced move_timeout in the field.
    if (goal.y === 62) return
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => ({ name: position.y === 64 ? 'stone' : 'air', position })

  const result = await build.moveToFirstReachablePlacementStand(
    ctx,
    target,
    [nearestDownSlope, fartherOnLevel],
    {
      owner: 'test',
      options: { timeoutMs: 40, standMoveAttempts: 2 },
      placeDistance: 4.5,
      reason: 'test_placement_stand'
    }
  )

  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.data.standPosition, fartherOnLevel)
  assert.strictEqual(result.data.attempts, 1)
  assert.deepStrictEqual(goalsSeen, ['4,65,0'])
  assert.ok(!logs.some(message => message.includes('stand_move_timeout_blacklisted')))
  assert.ok(logs.some(message =>
    message.includes('[BUILD_STAND_PATH_PRESCREEN]') && message.includes('result=reordered')))
  assert.ok(logs.some(message =>
    message.includes('[BUILD_STANCE_CANDIDATES]') && message.includes('attempts=4,65,0|2,62,1')))
}

// Fountain-basin fixture reproducing the round-3 zero-candidate fluid
// terminal failure (water 611,68,-94): every strict upper stand dies on
// bottom-slab support / reservations, and the escalating relaxation must
// find the rim slab stands instead of failing with nothing to try.
function createFluidBasinContext(params = {}) {
  const ctx = createContext()
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(605, 69, -94)
  const target = { x: 611, y: 68, z: -94 }
  const FULL = [[0, 0, 0, 1, 1, 1]]
  const SLAB = [[0, 0, 0, 1, 0.5, 1]]
  const world = new Map()
  const put = (x, y, z, name, shapes) => world.set(`${x},${y},${z}`, { name, shapes, position: vec(x, y, z) })
  // basin floor + reference under the water cell
  put(611, 67, -94, 'stone', FULL)
  // bottom-slab rim ring at the target's own level (cardinal 1 and 2 out)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    if (params.withoutRimSlabs === true) break
    put(611 + dx, 68, -94 + dz, 'stone_slab', SLAB)
  }
  ctx.bot.blockAt = position => world.get(`${position.x},${position.y},${position.z}`) ||
    { name: 'air', position: vec(position.x, position.y, position.z) }
  return { ctx, target }
}

function testFluidStanceRelaxationFindsRimSlabStands() {
  const { ctx, target } = createFluidBasinContext()
  // Strict generation stays empty on this geometry: upper stands (y=69) sit
  // on 0.5-high slabs, which the integer-surface rule rejects.
  const strict = build.findSafePlacementStandPositions(ctx, target, 4.5, {
    preferHighStand: true,
    preferCloseStand: true,
    minHorizontalDistance: 1
  }).filter(stand => stand.y === target.y + 1)
  assert.strictEqual(strict.length, 0)

  const relaxed = build.relaxedFluidStanceCandidates(ctx, target, 4.5, {})
  assert.strictEqual(relaxed.level, 'rim_partial_stand')
  assert.ok(relaxed.stands.length >= 4, `expected rim stands, got ${relaxed.stands.length}`)
  for (const stand of relaxed.stands) {
    assert.strictEqual(stand.y, target.y)
    assert.strictEqual(stand.rimStand, true)
  }
}

function testFluidStanceRelaxationRespectsReservedHeadroom() {
  const { ctx, target } = createFluidBasinContext()
  // Reserve the headroom above every rim cell (the future enclosure). The
  // relaxation must NOT trade the reserved-cell contract for a stance: the
  // committed fluid tests pin that reserved cells stay untouchable.
  const reserved = new Set()
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      reserved.add(`${611 + dx},69,${-94 + dz}`)
      reserved.add(`${611 + dx},70,${-94 + dz}`)
    }
  }
  const relaxed = build.relaxedFluidStanceCandidates(ctx, target, 4.5, {
    reservedPositions: reserved
  })
  assert.strictEqual(relaxed.level, 'none')
  assert.strictEqual(relaxed.stands.length, 0)
}

function testFluidStanceRelaxationReportsNoneWithoutAnyStands() {
  const { ctx, target } = createFluidBasinContext({ withoutRimSlabs: true })
  const relaxed = build.relaxedFluidStanceCandidates(ctx, target, 4.5, {})
  assert.strictEqual(relaxed.level, 'none')
  assert.strictEqual(relaxed.stands.length, 0)
}

function testWalkablePartialSupportTopBounds() {
  const slab = { name: 'stone_slab', shapes: [[0, 0, 0, 1, 0.5, 1]] }
  const full = { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] }
  const carpet = { name: 'white_carpet', shapes: [[0, 0, 0, 1, 0.0625, 1]] }
  assert.strictEqual(build.walkablePartialSupportTop(slab), 0.5)
  assert.strictEqual(build.walkablePartialSupportTop(full), null)
  assert.strictEqual(build.walkablePartialSupportTop(carpet), null)
  assert.strictEqual(build.walkablePartialSupportTop({ name: 'air' }), null)
}

async function testPlaceBlockRejectsStandMoveThatStillIntersectsTarget() {
  const ctx = createContext()
  const goals = []
  const logs = []
  let placed = false
  const target = { x: 0, y: 66, z: 0 }
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(10, 64, 0)
  ctx.bot.once = (event, callback) => {
    if (event === 'goal_reached') setImmediate(callback)
  }
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (!goal) return
    if (goals.length === 1) {
      ctx.bot.entity.position = vec(target.x + 0.2, target.y, target.z + 0.2)
      return
    }
    ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    forceSafeApproach: true,
    standMoveAttempts: 2
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 2)
  assert.ok(logs.some(message => message.includes('placement_target_occupied_after_move')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockPrefersTopStandForHighScaffold() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 3, y: 70, z: 0 }
  ctx.bot.entity.position = vec(0, 69, 0)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'dirt', position }
    }
    if (position.y === 68) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    forceSafeApproach: true,
    preferHighStand: true
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(goals[0].x, target.x - 1)
  assert.strictEqual(goals[0].y, target.y + 1)
  assert.strictEqual(goals[0].z, target.z)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesCurrentReachForAlreadyReachableHighScaffold() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 4, y: 75, z: 0 }
  ctx.bot.entity.position = vec(0.5, 73, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.x === target.x - 1 && position.y === target.y && position.z === target.z) {
      return { name: 'dirt', position }
    }
    if (position.y === 72) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    forceSafeApproach: true,
    preferHighStand: true,
    allowCurrentReachForHighTargets: true
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesReachableReferenceForHighFormalTarget() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 1, y: 76, z: 0 }
  ctx.bot.entity.position = vec(0.5, 69, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 68) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    forceSafeApproach: true,
    allowCurrentReferenceReachForHighTargets: true
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRecoversNearXZMoveWithReachableHighReference() {
  const ctx = createContext()
  const goals = []
  const logs = []
  let placed = false
  const target = { x: 0, y: 75, z: 0 }

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.once = (event, callback) => {
    if (event !== 'goal_reached') return
    const goal = goals[goals.length - 1]
    if (goal && goal.y === undefined) {
      setImmediate(() => {
        ctx.bot.entity.position = vec(target.x, 69, target.z - 1.5)
        callback()
      })
    }
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 68 || position.y === 74) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 5,
    forceSafeApproach: true,
    preferHighStand: true,
    allowCurrentReferenceReachForHighTargets: true,
    allowNearXZFallback: true,
    nearXZMoveTimeoutMs: 20,
    standMoveAttempts: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.length >= 2)
  assert.ok(logs.some(message => message.includes('[BUILD_MOVE_XZ_REACH_RECOVERED]')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRecoversNearXZOneBelowMinimumWithStrictReference() {
  const ctx = createContext()
  const goals = []
  const logs = []
  let placed = false
  const target = { x: 0, y: 75, z: 0 }

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.inventory.items = () => [{ name: 'lantern', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.once = (event, callback) => {
    if (event !== 'goal_reached') return
    const goal = goals[goals.length - 1]
    if (goal && goal.y === undefined) {
      setImmediate(() => {
        ctx.bot.entity.position = vec(target.x, 72, target.z - 1.5)
        callback()
      })
    }
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'lantern' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'chest', position }
    }
    if (position.y === 68 || position.y === 74) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'lantern', {
    owner: 'test',
    timeoutMs: 5,
    forceSafeApproach: true,
    preferHighStand: true,
    minimumPlacementStandY: 73,
    allowCurrentReferenceReachForHighTargets: true,
    requireStrictPlacementReferenceReachAfterStandMove: true,
    allowNearXZFallback: true,
    nearXZMoveTimeoutMs: 20,
    standMoveAttempts: 1,
    blockStates: { hanging: 'false' }
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.ok(goals.length >= 2)
  assert.ok(logs.some(message => message.includes('[BUILD_MINIMUM_STAND_HEIGHT_STRICT_REFERENCE_RECOVERED]')))
  assert.ok(logs.some(message => message.includes('[BUILD_MOVE_XZ_REACH_RECOVERED]')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockUsesCurrentReachWhenForcedApproachAlreadyReachable() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 3, y: 64, z: 0 }
  ctx.bot.entity.position = vec(0.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    forceSafeApproach: true,
    allowCurrentReachForHighTargets: true
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 0)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRecoversHighReferenceReachAfterMoveTimeout() {
  const ctx = createContext()
  const goals = []
  const logs = []
  let placed = false
  const target = { x: 0, y: 77, z: 0 }
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(0.5, 72.25, 0.5)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 1,
    allowCurrentReferenceReachForHighTargets: true,
    allowScaffolding: true,
    moveRange: 4
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 1)
  assert.ok(logs.some(message => message.includes('[BUILD_MOVE_TIMEOUT_REACH_RECOVERED]')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRecoversDirectMoveWhenTargetReachable() {
  const ctx = createContext()
  const goals = []
  const logs = []
  let placed = false
  const target = { x: 4, y: 64, z: 0 }
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(12, 64, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(target.x + 2.5, target.y, target.z)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 1
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 1)
  assert.ok(logs.some(message => message.includes('reason=current_placement_reach')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRecoversPartialScaffoldMoveWhenTargetReachable() {
  const ctx = createContext()
  const goals = []
  const logs = []
  let placed = false
  const target = { x: 4, y: 75, z: 0 }
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(target.x - 2.5, target.y - 1, target.z + 0.5)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 68 || position.y === target.y - 2) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 1,
    forceSafeApproach: true,
    allowCurrentReachForHighTargets: true,
    standMoveAttempts: 4
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 1)
  assert.ok(logs.some(message => message.includes('[BUILD_MOVE_TIMEOUT_REACH_RECOVERED]')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockRepairsTargetScaffoldAfterMove() {
  const ctx = createContext()
  const goals = []
  const logs = []
  const occupied = new Map()
  const cleared = []
  const target = { x: 4, y: 75, z: 0 }
  const key = position => `${position.x},${position.y},${position.z}`
  const items = [
    { name: 'spruce_fence', count: 1 },
    { name: 'dirt', count: 1 }
  ]
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => items
  ctx.bot.heldItem = items[1]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (!goal) return
    occupied.set(key(target), 'dirt')
    ctx.bot.entity.position = vec(target.x - 2.5, target.y - 1, target.z + 0.5)
  }
  ctx.bot.blockAt = position => {
    const blockKey = key(position)
    if (occupied.has(blockKey)) return { name: occupied.get(blockKey), position }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 68 || position.y === target.y - 2) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.dig = async block => {
    occupied.delete(key(block.position))
    cleared.push(block.position)
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    occupied.set(key(position), ctx.bot.heldItem?.name || 'air')
  }

  const result = await build.placeBlock(ctx, target, 'spruce_fence', {
    owner: 'test',
    timeoutMs: 1,
    forceSafeApproach: true,
    allowCurrentReachForHighTargets: true,
    allowScaffolding: true,
    repairObstructedTarget: true,
    standMoveAttempts: 4
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(occupied.get(key(target)), 'spruce_fence')
  assert.deepStrictEqual(cleared.map(position => key(position)), [key(target)])
  assert.ok(logs.some(message => message.includes('[BUILD_PLACE_TARGET_REPAIR]')))
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

function testControlledVerticalAccessFiltersForRequiredReferenceReach() {
  const ctx = createContext()
  const target = { x: 27, y: 110, z: 15 }
  const topReference = { x: 27, y: 111, z: 15 }
  ctx.bot.entity.position = vec(28.5, 107, 4.5)
  ctx.bot.blockAt = position => ({
    name: 'air',
    position: vec(position.x, position.y, position.z)
  })

  const unfiltered = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5)
  assert.ok(unfiltered.some(stand =>
    stand.x === 27 && stand.y === 107 && stand.z === 11
  ))

  const candidates = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5, {
    strictPlacementReferencePosition: topReference
  })

  assert.ok(candidates.length > 0)
  assert.ok(!candidates.some(stand =>
    stand.x === 27 && stand.y === 107 && stand.z === 11
  ))
  assert.ok(candidates.some(stand =>
    stand.x === 27 && stand.y === 107 && stand.z === 12
  ))
  assert.ok(candidates.every(stand => {
    const eye = { x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }
    const center = {
      x: topReference.x + 0.5,
      y: topReference.y + 0.5,
      z: topReference.z + 0.5
    }
    return Math.sqrt(
      (eye.x - center.x) ** 2 +
      (eye.y - center.y) ** 2 +
      (eye.z - center.z) ** 2
    ) <= 4.5
  }))
}

function testControlledVerticalAccessHonorsMinimumStandHeight() {
  const ctx = createContext()
  const target = { x: 19, y: 117, z: 8 }
  ctx.bot.entity.position = vec(21.5, 111.5, 7.5)
  ctx.bot.blockAt = position => ({
    name: 'air',
    position: vec(position.x, position.y, position.z)
  })

  const unfiltered = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5)
  assert.ok(unfiltered.some(stand => stand.y < 115))

  const candidates = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5, {
    minimumPlacementStandY: 115,
    strictPlacementReferencePosition: { x: 19, y: 118, z: 8 }
  })
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every(stand => stand.y >= 115))
}

async function testControlledVerticalAccessPrefersDiagonalTerminalBridge() {
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  const pillarStand = { x: 0, y: 70, z: 0 }
  const bridgeStand = { x: 1, y: 70, z: 0 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(4.5, 64, 4.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  const placement = position => ({
    x: position.x,
    y: position.y - 1,
    z: position.z,
    dx: 0,
    dy: 1,
    dz: 0
  })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => {
    const isPillar = goal.x === pillarStand.x
    const cells = isPillar
      ? [{ x: 0, y: 68, z: 0 }, { x: 0, y: 69, z: 0 }]
      : [{ x: 0, y: 68, z: 0 }, { x: 1, y: 69, z: 0 }]
    return {
      status: 'success',
      cost: isPillar ? 1 : 20,
      path: [{
        x: goal.x,
        y: goal.y,
        z: goal.z,
        toBreak: [],
        toPlace: cells.map(placement)
      }]
    }
  }

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessCandidateStands: [pillarStand, bridgeStand],
    verticalAccessPreviewAttempts: 2,
    verticalAccessPlanAlternatives: 1
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.deepStrictEqual(planned.data.stands, [bridgeStand])
  assert.deepStrictEqual(planned.data.plans[0].scaffoldPositions, [
    { x: 0, y: 68, z: 0 },
    { x: 1, y: 69, z: 0 }
  ])
}

async function testControlledVerticalAccessPrefersPlacementReferenceMargin() {
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  const reference = { x: -1, y: 72, z: 0 }
  const shortRouteEdgeStand = { x: 1, y: 73, z: -3 }
  const longerRouteRobustStand = { x: -1, y: 73, z: -1 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(4.5, 73, -4.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'success',
    cost: goal.x === shortRouteEdgeStand.x ? 1 : 20,
    path: [{
      x: goal.x,
      y: goal.y,
      z: goal.z,
      toBreak: [],
      toPlace: []
    }]
  })

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessCandidateStands: [shortRouteEdgeStand, longerRouteRobustStand],
    verticalAccessPreviewAttempts: 2,
    verticalAccessPlanAlternatives: 2,
    strictPlacementReferencePosition: reference
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.deepStrictEqual(planned.data.stands, [
    longerRouteRobustStand,
    shortRouteEdgeStand
  ])
}

function testControlledVerticalAccessReachedWhenRequiresSettledReferenceMargin() {
  const ctx = createContext()
  const target = { x: 2, y: 64, z: 0 }
  const reference = { x: 0, y: 64, z: 0 }
  const reachedWhen = build.controlledVerticalAccessReachedWhen(
    ctx,
    target,
    { blockName: 'stone', referencePosition: reference },
    4.5,
    {
      requireReachablePlacementAfterStandMove: true,
      requireStrictPlacementReferenceReachAfterStandMove: true
    }
  )

  // Eye and reference center are 4.30 blocks apart: inside Minecraft's
  // nominal 4.5 reach, but too close to the boundary to survive movement
  // quiescence and server position settlement.
  ctx.bot.entity.position = vec(0.5, 62.88, 4.8)
  assert.strictEqual(reachedWhen(), false)

  // At 4.00 blocks the default 0.35 margin is satisfied.
  ctx.bot.entity.position = vec(0.5, 62.88, 4.5)
  assert.strictEqual(reachedWhen(), true)
  assert.strictEqual(build.controlledPlacementSettledReachDistance(4.5), 4.15)
  assert.strictEqual(build.controlledPlacementSettledReachDistance(4.5, {
    strictPlacementReachSafetyMargin: 0
  }), 4.5)
}

async function testControlledVerticalAccessFallsBackAfterRestrictedStandsExhausted() {
  const ctx = createContext()
  const logs = []
  const target = { x: 0, y: 72, z: 0 }
  const restrictedStand = { x: 1, y: 73, z: 0 }
  const previewedGoals = []
  ctx.logger = { log: message => logs.push(String(message)) }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  const generatedCandidates = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5)
  const fallbackStand = generatedCandidates[1]
  assert.ok(fallbackStand)
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => {
    previewedGoals.push({ x: goal.x, y: goal.y, z: goal.z })
    if (goal.x !== fallbackStand.x || goal.y !== fallbackStand.y || goal.z !== fallbackStand.z) {
      return {
        status: 'partial',
        cost: 1,
        path: [{ x: 3, y: 64, z: 0, toBreak: [], toPlace: [] }]
      }
    }
    return {
      status: 'success',
      cost: 2,
      path: [{ x: goal.x, y: goal.y, z: goal.z, toBreak: [], toPlace: [] }]
    }
  }

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessCandidateStands: [restrictedStand],
    verticalAccessGeneratedCandidateFallback: true,
    verticalAccessPreviewAttempts: 1,
    verticalAccessGeneratedFallbackPreviewAttempts: 2,
    verticalAccessPlanAlternatives: 1
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.strictEqual(planned.message, 'controlled_vertical_access_planned_after_generated_fallback')
  assert.strictEqual(planned.data.fallbackFromRestrictedCandidates, true)
  assert.strictEqual(planned.data.restrictedCandidateSummaries.length, 1)
  assert.strictEqual(previewedGoals.length, 3)
  assert.deepStrictEqual(previewedGoals[0], restrictedStand)
  assert.deepStrictEqual(previewedGoals[2], fallbackStand)
  assert.ok(logs.some(message =>
    message.includes('[BUILD_VERTICAL_ACCESS_CANDIDATE_FALLBACK]') &&
    message.includes('reason=restricted_candidates_exhausted')
  ))
}

async function testControlledVerticalAccessRejectsFormalScaffoldPath() {
  const ctx = createContext()
  const logs = []
  const target = { x: 0, y: 72, z: 0 }
  const forbidden = { x: 99, y: 70, z: 99 }
  let previewCount = 0
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => {
    previewCount += 1
    const placement = previewCount === 1
      ? forbidden
      : { x: goal.x, y: goal.y - 1, z: goal.z }
    return {
      status: 'success',
      cost: 8,
      path: [{ toBreak: [], toPlace: [placement] }]
    }
  }

  const result = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    reservedPositions: new Set([`${forbidden.x},${forbidden.y},${forbidden.z}`]),
    verticalAccessPlanAlternatives: 2
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.data.plans.length, 2)
  assert.ok(previewCount >= 3)
  assert.ok(result.data.plans.every(plan =>
    plan.scaffoldPositions.every(position =>
      `${position.x},${position.y},${position.z}` !== `${forbidden.x},${forbidden.y},${forbidden.z}`
    )
  ))
  assert.ok(logs.some(message => message.includes('formalConflict=1')))
}

async function testPlaceBlockPlansAndCleansControlledVerticalAccess() {
  const ctx = createContext()
  const events = new EventEmitter()
  const logs = []
  const goals = []
  const world = new Map()
  const cleared = []
  const target = { x: 0, y: 72, z: 0 }
  const key = position => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
  const items = [
    { name: 'spruce_fence', count: 1 },
    { name: 'dirt', count: 16 }
  ]

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => items
  ctx.bot.heldItem = items[1]
  ctx.bot.on = events.on.bind(events)
  ctx.bot.once = events.once.bind(events)
  ctx.bot.removeListener = events.removeListener.bind(events)
  ctx.bot.blockAt = position => {
    const blockName = world.get(key(position))
    if (blockName) return { name: blockName, position: vec(position.x, position.y, position.z) }
    if (key(position) === key({ x: target.x, y: target.y - 1, z: target.z })) {
      return { name: 'dark_oak_planks', position: vec(position.x, position.y, position.z) }
    }
    return { name: 'air', position: vec(position.x, position.y, position.z) }
  }
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'success',
    cost: 7,
    path: [{
      toBreak: [],
      toPlace: [
        { x: goal.x, y: goal.y - 3, z: goal.z, dx: 0, dy: 1, dz: 0 },
        { x: goal.x, y: goal.y - 2, z: goal.z, dx: 0, dy: 1, dz: 0 }
      ]
    }]
  })
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goals.push(goal)
    const scaffoldPositions = [
      { x: goal.x, y: goal.y - 2, z: goal.z },
      { x: goal.x, y: goal.y - 1, z: goal.z }
    ]
    for (const position of scaffoldPositions) {
      const oldBlock = { name: 'air', position: vec(position.x, position.y, position.z) }
      world.set(key(position), 'dirt')
      const newBlock = { name: 'dirt', position: vec(position.x, position.y, position.z) }
      events.emit('blockUpdate', oldBlock, newBlock)
    }
    ctx.bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
    setImmediate(() => events.emit('goal_reached'))
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    world.set(key(position), ctx.bot.heldItem?.name || 'air')
  }
  ctx.bot.dig = async block => {
    const support = {
      x: Math.floor(ctx.bot.entity.position.x),
      y: Math.floor(ctx.bot.entity.position.y) - 1,
      z: Math.floor(ctx.bot.entity.position.z)
    }
    world.delete(key(block.position))
    cleared.push(key(block.position))
    if (key(support) === key(block.position)) {
      ctx.bot.entity.position = vec(
        ctx.bot.entity.position.x,
        ctx.bot.entity.position.y - 1,
        ctx.bot.entity.position.z
      )
      ctx.bot.entity.onGround = true
    }
  }

  const result = await build.placeBlock(ctx, target, 'spruce_fence', {
    owner: 'test',
    reservedPositions: new Set([key(target)]),
    forceSafeApproach: true,
    preferHighStand: true,
    allowScaffolding: true,
    allowCurrentReachForHighTargets: true,
    allowCurrentReferenceReachForHighTargets: true,
    standMoveAttempts: 4,
    stableConfirmDelayMs: 0
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(world.get(key(target)), 'spruce_fence')
  assert.strictEqual(goals.length, 1)
  assert.notDeepStrictEqual(
    { x: goals[0].x, y: goals[0].y, z: goals[0].z },
    target
  )
  assert.deepStrictEqual(cleared, [
    `${goals[0].x},${goals[0].y - 1},${goals[0].z}`,
    `${goals[0].x},${goals[0].y - 2},${goals[0].z}`
  ])
  assert.strictEqual(world.has(`${goals[0].x},${goals[0].y - 1},${goals[0].z}`), false)
  assert.strictEqual(world.has(`${goals[0].x},${goals[0].y - 2},${goals[0].z}`), false)
  assert.strictEqual(events.listenerCount('blockUpdate'), 0)
  assert.ok(logs.some(message => message.includes('[BUILD_VERTICAL_ACCESS_PLAN]')))
  assert.ok(logs.some(message => message.includes('[BUILD_VERTICAL_ACCESS_CLEANUP]')))
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

async function testControlledVerticalAccessUsesActualPlacementCellCoordinates() {
  const ctx = createContext()
  const logs = []
  const target = { x: 0, y: 72, z: 0 }
  const formalReference = { x: 4, y: 66, z: 4 }
  const actualTemporary = { x: 4, y: 67, z: 4 }
  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'success',
    cost: 6,
    path: [{
      x: goal.x,
      y: goal.y,
      z: goal.z,
      toBreak: [],
      toPlace: [{
        ...formalReference,
        dx: 0,
        dy: 1,
        dz: 0
      }]
    }]
  })

  const allowed = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    reservedPositions: new Set([
      `${target.x},${target.y},${target.z}`,
      `${formalReference.x},${formalReference.y},${formalReference.z}`
    ]),
    verticalAccessPreviewAttempts: 1,
    verticalAccessPlanAlternatives: 1
  })

  assert.strictEqual(allowed.ok, true, allowed.error)
  assert.deepStrictEqual(allowed.data.plans[0].scaffoldPositions, [actualTemporary])
  assert.strictEqual(allowed.data.candidateSummaries[0].formalConflicts.length, 0)

  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'success',
    cost: 6,
    path: [{
      x: goal.x,
      y: goal.y,
      z: goal.z,
      toBreak: [],
      toPlace: [{
        x: actualTemporary.x,
        y: actualTemporary.y - 1,
        z: actualTemporary.z,
        dx: 0,
        dy: 1,
        dz: 0
      }]
    }]
  })
  const protectedActual = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    reservedPositions: new Set([
      `${target.x},${target.y},${target.z}`,
      `${actualTemporary.x},${actualTemporary.y},${actualTemporary.z}`
    ]),
    verticalAccessPreviewAttempts: 1
  })

  assert.strictEqual(protectedActual.ok, false)
  assert.strictEqual(protectedActual.error, 'no_reachable_build_stance_after_vertical_access_candidates')
  assert.deepStrictEqual(protectedActual.candidateSummaries[0].formalConflicts, [actualTemporary])
  assert.ok(logs.some(message =>
    message.includes('[BUILD_VERTICAL_ACCESS_CANDIDATE]') &&
    message.includes(`formalConflicts=${actualTemporary.x},${actualTemporary.y},${actualTemporary.z}`)
  ))
}

async function testControlledVerticalAccessExhaustionIncludesCandidateSummaries() {
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'partial',
    cost: 2,
    path: [{
      x: goal.x,
      y: 64,
      z: goal.z,
      toBreak: [],
      toPlace: []
    }]
  })

  const exhausted = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessPreviewAttempts: 3
  })

  assert.strictEqual(exhausted.ok, false)
  assert.strictEqual(exhausted.error, 'no_reachable_build_stance_after_vertical_access_candidates')
  assert.strictEqual(exhausted.candidateSummaries.length, 3)
  assert.ok(exhausted.candidateSummaries.every(summary =>
    summary.rejectionReason === 'preview_partial'
  ))
}

// Round 13, offline replay of the gate archive: the generator never looks
// under a candidate, so its list mixes stands a scaffold pillar walks
// straight up to with stands whose column is blocked. Measure that column.
function testVerticalAccessStandColumnSupportMeasuresThePillar() {
  const ctx = createContext()
  const solids = new Map()
  const put = (x, y, z, block) => solids.set(`${x},${y},${z}`, block)
  ctx.bot.blockAt = position => {
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    return solids.get(key) || { name: 'air', position, shapes: [] }
  }
  // a plain floor right under the feet
  put(0, 63, 0, { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] })
  assert.deepStrictEqual(
    build.verticalAccessStandColumnSupport(ctx, { x: 0, y: 64, z: 0 }),
    { depth: 0, clear: true }
  )
  // five empty cells then a floor: a five-block pillar reaches this stand
  put(5, 63, 0, { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] })
  assert.deepStrictEqual(
    build.verticalAccessStandColumnSupport(ctx, { x: 5, y: 69, z: 0 }),
    { depth: 5, clear: true }
  )
  // a fence two cells down: no integer surface, and the pillar cannot pass
  put(9, 67, 0, { name: 'oak_fence', shapes: [[0, 0, 0, 1, 1.5, 1]] })
  put(9, 63, 0, { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] })
  assert.deepStrictEqual(
    build.verticalAccessStandColumnSupport(ctx, { x: 9, y: 69, z: 0 }),
    { depth: 1, clear: false }
  )
  assert.strictEqual(build.hasClearScaffoldColumnBelow(ctx, { x: 9, y: 69, z: 0 }), false)
  assert.strictEqual(build.hasClearScaffoldColumnBelow(ctx, { x: 5, y: 69, z: 0 }), true)
  // nothing solid inside the scan depth
  assert.deepStrictEqual(
    build.verticalAccessStandColumnSupport(ctx, { x: 40, y: 200, z: 40 }),
    { depth: Infinity, clear: false }
  )
  // and the scan depth is honoured
  assert.deepStrictEqual(
    build.verticalAccessStandColumnSupport(ctx, { x: 5, y: 69, z: 0 }, 3),
    { depth: Infinity, clear: false }
  )
}

// Gate lantern 604,82,-1: every generated stand hangs in the air, and the
// ones whose column is blocked can only be approached sideways around the
// obstruction. Partition them behind the ones a straight pillar reaches --
// and keep them, they are still the fallback.
function testControlledVerticalAccessPartitionsStandsByScaffoldColumn() {
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  ctx.bot.entity.position = vec(0.5, 64, 8.5)
  // a floor at y63 everywhere, plus a fence rail at y66 over the negative-z
  // half: nothing can stand on it and no pillar can pass it, so those columns
  // are cut off from the floor while the positive-z ones are not
  ctx.bot.blockAt = position => {
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if (y === 63) return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    if (y === 66 && z < 0) return { name: 'oak_fence', position, shapes: [[0, 0, 0, 1, 1.5, 1]] }
    return { name: 'air', position, shapes: [] }
  }

  const candidates = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5, {})
  assert.ok(candidates.length > 6, `expected a real candidate list, got ${candidates.length}`)
  const blocked = candidates.filter(stand => !build.hasClearScaffoldColumnBelow(ctx, stand))
  const clear = candidates.filter(stand => build.hasClearScaffoldColumnBelow(ctx, stand))
  assert.ok(clear.length > 0 && blocked.length > 0, 'the fixture must produce both kinds')
  // nothing was dropped: the blocked stands are still in the list
  assert.ok(blocked.every(stand => candidates.some(other =>
    other.x === stand.x && other.y === stand.y && other.z === stand.z
  )))
  const firstBlocked = candidates.findIndex(stand => !build.hasClearScaffoldColumnBelow(ctx, stand))
  const lastClear = candidates.reduce(
    (last, stand, index) => (build.hasClearScaffoldColumnBelow(ctx, stand) ? index : last),
    -1
  )
  assert.ok(firstBlocked > lastClear, 'every clear-column stand comes before every blocked one')
}

// The extended pass buys four re-previews and stops at the first legal one,
// so its order decides the step. At gate lantern 604,82,-1 the four nearest
// truncated endpoints are four neighbours of one blocked column and the only
// affordable stand is never reached; the clear column has to come first.
function testTruncatedPreviewSelectionPrefersAClearScaffoldColumn() {
  const stand = index => ({ x: index, y: 80, z: 0 })
  const endpointAt = (index, remaining) => ({ x: index, y: 80 - remaining, z: 0 })
  const blockedNeighbours = [0, 1, 2, 3].map(index => ({
    stand: stand(index),
    candidateIndex: index,
    endpoint: endpointAt(index, 1 + index),
    scaffoldColumnClear: false
  }))
  const clearButFarther = {
    stand: stand(9),
    candidateIndex: 9,
    endpoint: endpointAt(9, 8),
    scaffoldColumnClear: true
  }
  const selected = build.selectTruncatedVerticalAccessPreviews(
    [...blockedNeighbours, clearButFarther],
    4
  )
  assert.strictEqual(selected.length, 4)
  assert.strictEqual(selected[0].candidateIndex, 9, 'the clear column goes first')
  assert.deepStrictEqual(selected.slice(1).map(entry => entry.candidateIndex), [0, 1, 2])

  // two clear columns: the nearer truncated endpoint still wins between them
  const twoClear = build.selectTruncatedVerticalAccessPreviews([
    { stand: stand(9), candidateIndex: 9, endpoint: endpointAt(9, 8), scaffoldColumnClear: true },
    { stand: stand(7), candidateIndex: 7, endpoint: endpointAt(7, 2), scaffoldColumnClear: true },
    ...blockedNeighbours
  ], 4)
  assert.deepStrictEqual(twoClear.map(entry => entry.candidateIndex), [7, 9, 0, 1])

  // nothing clear: unchanged behaviour, nearest truncated endpoint first
  const noneClear = build.selectTruncatedVerticalAccessPreviews(blockedNeighbours, 4)
  assert.deepStrictEqual(noneClear.map(entry => entry.candidateIndex), [0, 1, 2, 3])
}

// End to end on the gate-82 shape: every candidate truncates, only the stand
// with a clear column finishes inside the extended budget, and the pass has
// to spend one of its four slots on it.
async function testControlledVerticalAccessExtendsTheClearColumnCandidate() {
  const ctx = createContext()
  const logs = []
  ctx.logger = { log: message => logs.push(String(message)) }
  const target = { x: 0, y: 72, z: 0 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(0.5, 64, 8.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 32 }]
  // a fence rail at y66 cuts every column off from the floor except the ones
  // over x=3, so a straight scaffold pillar reaches those stands and no other
  ctx.bot.blockAt = position => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    if (y === 63) return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    if (y === 66 && x !== 3) return { name: 'oak_fence', position, shapes: [[0, 0, 0, 1, 1.5, 1]] }
    return { name: 'air', position, shapes: [] }
  }
  const candidates = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5, {})
  const clearStands = candidates.filter(stand => build.hasClearScaffoldColumnBelow(ctx, stand))
  const blockedStands = candidates.filter(stand => !build.hasClearScaffoldColumnBelow(ctx, stand))
  assert.ok(clearStands.length > 0 && blockedStands.length > 4, 'fixture must offer both kinds')
  const clearKeys = new Set(clearStands.map(stand => `${stand.x},${stand.y},${stand.z}`))
  // every preview truncates; only a clear-column stand ever finishes, and only
  // once it has been given the extended slice budget
  const generators = []
  ctx.bot.pathfinder.getPathTo = () => { throw new Error('sliced preview must not fall back') }
  ctx.bot.pathfinder.getPathFromTo = (_movements, _start, goal) => {
    const key = `${goal.x},${goal.y},${goal.z}`
    const record = { key, calls: 0 }
    generators.push(record)
    // the blocked stands stall three blocks from their stand, the clear ones
    // eight: nearest-endpoint order would take four blocked ones and miss them
    const remaining = clearKeys.has(key) ? 8 : 3
    return {
      next() {
        record.calls += 1
        const finished = clearKeys.has(key) && record.calls >= 20
        return {
          done: false,
          value: {
            result: finished
              ? { status: 'success', cost: 40, path: [{ x: goal.x, y: goal.y, z: goal.z, toBreak: [], toPlace: [] }] }
              : { status: 'partial', cost: 30, path: [{ x: goal.x, y: goal.y - remaining, z: goal.z, toBreak: [], toPlace: [] }] }
          }
        }
      }
    }
  }

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessExtendedPreviewTimeoutMs: 2000
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.strictEqual(planned.data.stands.length, 1)
  assert.ok(
    clearKeys.has(`${planned.data.stands[0].x},${planned.data.stands[0].y},${planned.data.stands[0].z}`),
    'the plan stands on a column a scaffold pillar can reach'
  )
  const extendedLine = logs.find(line => line.includes('[BUILD_VERTICAL_ACCESS_PREVIEW_EXTENDED]'))
  assert.ok(extendedLine, logs.join('\n'))
  assert.ok(extendedLine.includes(`truncated=${Math.min(candidates.length, 48)}`), extendedLine)
  assert.ok(/clearColumn=[1-9]\d*/.test(extendedLine), extendedLine)
  assert.ok(!extendedLine.includes('(blocked)'), 'every extended slot went to a clear column')
  assert.match(extendedLine, /order=vertical_\d+\(clear\)/, extendedLine)
  const extendedSummaries = planned.data.candidateSummaries.filter(summary => summary.id.endsWith('_extended'))
  assert.strictEqual(extendedSummaries.length, 1, 'stops at the first legal plan')
  assert.strictEqual(extendedSummaries[0].previewResult, 'success')
}

// Build-18 lantern 604,77,-2 (fort_wall_gate): 15 restricted + 19 generated
// stands, every preview cut off at 10-12 slices while still partial, step
// failed with no_reachable_build_stance_after_vertical_access_candidates.
// Offline the very same routes finish in 6-37 slices. So when the cheap pass
// produces no plan, the truncated candidates whose search got closest to
// their stand are previewed again with a real budget, best first, and the
// pass stops at the first legal plan.
function truncatedPreviewPathfinder(params = {}) {
  const generators = []
  const successAfter = params.successAfter ?? 20
  const nearStandKey = params.nearStandKey || null
  return {
    generators,
    getPathFromTo(_movements, _start, goal, options) {
      const record = { goal: { x: goal.x, y: goal.y, z: goal.z }, options, calls: 0 }
      generators.push(record)
      const key = `${goal.x},${goal.y},${goal.z}`
      // the truncated endpoint: far below the stand for everyone except one
      // candidate, whose search "got close" (3 blocks under its stand)
      const endpoint = key === nearStandKey
        ? { x: goal.x, y: goal.y - 3, z: goal.z }
        : { x: goal.x, y: 64, z: goal.z }
      return {
        next() {
          record.calls += 1
          const finished = record.calls >= successAfter
          return {
            done: false,
            value: {
              result: finished
                ? { status: 'success', cost: 40, path: [{ x: goal.x, y: goal.y, z: goal.z, toBreak: [], toPlace: [] }] }
                : { status: 'partial', cost: 30, path: [{ ...endpoint, toBreak: [], toPlace: [] }] }
            }
          }
        }
      }
    }
  }
}

async function testControlledVerticalAccessExtendsTruncatedPreviewsBestFirst() {
  const ctx = createContext()
  const logs = []
  ctx.logger = { log: message => logs.push(String(message)) }
  const target = { x: 0, y: 72, z: 0 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position, shapes: [] })
  const candidates = build.controlledVerticalAccessStandCandidates(ctx, target, 4.5, {})
  assert.ok(candidates.length >= 3)
  const nearStand = candidates[1]
  const pathfinder = truncatedPreviewPathfinder({
    successAfter: 20,
    nearStandKey: `${nearStand.x},${nearStand.y},${nearStand.z}`
  })
  ctx.bot.pathfinder.getPathTo = () => { throw new Error('sliced preview must not fall back to getPathTo') }
  ctx.bot.pathfinder.getPathFromTo = pathfinder.getPathFromTo

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessPreviewAttempts: 3,
    verticalAccessExtendedPreviewTimeoutMs: 2000
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.deepStrictEqual(planned.data.stands, [nearStand], 'the closest truncated search is extended first')
  const summaries = planned.data.candidateSummaries
  assert.strictEqual(summaries.length, 4, 'three cheap previews + one extended preview')
  assert.ok(summaries.slice(0, 3).every(summary => summary.rejectionReason === 'preview_partial'))
  assert.strictEqual(summaries[3].id, 'vertical_1_extended')
  assert.strictEqual(summaries[3].previewResult, 'success')
  assert.strictEqual(summaries[3].rejectionReason, null)
  assert.strictEqual(pathfinder.generators.length, 4, 'stops at the first legal plan')
  const extendedGenerator = pathfinder.generators[3]
  assert.strictEqual(extendedGenerator.calls, 20)
  assert.deepStrictEqual(extendedGenerator.options, { timeout: 4000, tickTimeout: 40 })
  assert.ok(pathfinder.generators.slice(0, 3).every(record => record.calls <= 16 && record.options.timeout === 1000))
  assert.ok(logs.some(line =>
    line.startsWith(`[BUILD_VERTICAL_ACCESS_PREVIEW_EXTENDED] target=0,72,0 truncated=3 extended=3 clearColumn=0 budgetMs=2000 order=vertical_1(blocked)|`)
  ), logs.join('\n'))
  assert.ok(logs.some(line =>
    line.includes('[BUILD_VERTICAL_ACCESS_CANDIDATE] target=0,72,0 id=vertical_1_extended') &&
    line.includes('preview=success')
  ))
  assert.ok(logs.some(line =>
    line.includes('[BUILD_VERTICAL_ACCESS_CANDIDATES] target=0,72,0 total=') &&
    line.includes('previewed=3 extended=1 legal=1 noPath=3')
  ))
}

async function testControlledVerticalAccessExtendedPassIsBoundedAndOptional() {
  const target = { x: 0, y: 72, z: 0 }
  const setup = () => {
    const ctx = createContext()
    const logs = []
    ctx.logger = { log: message => logs.push(String(message)) }
    ctx.bot.registry = minecraftData('1.20.1')
    ctx.bot.entity.position = vec(3.5, 64, 0.5)
    ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
    ctx.bot.blockAt = position => ({ name: 'air', position, shapes: [] })
    ctx.bot.pathfinder.getPathTo = () => { throw new Error('sliced preview must not fall back to getPathTo') }
    return { ctx, logs }
  }

  // the route never finishes: every extended candidate is tried, none more
  // than the limit, and the step still fails honestly
  const never = setup()
  const neverPathfinder = truncatedPreviewPathfinder({ successAfter: Number.POSITIVE_INFINITY })
  never.ctx.bot.pathfinder.getPathFromTo = neverPathfinder.getPathFromTo
  const exhausted = await build.planControlledVerticalAccess(never.ctx, target, 4.5, {
    verticalAccessPreviewAttempts: 5,
    verticalAccessPreviewTimeoutMs: 400,
    verticalAccessExtendedPreviewCandidates: 2,
    verticalAccessExtendedPreviewTimeoutMs: 400
  })
  assert.strictEqual(exhausted.ok, false)
  assert.strictEqual(exhausted.error, 'no_reachable_build_stance_after_vertical_access_candidates')
  assert.strictEqual(neverPathfinder.generators.length, 7, '5 cheap + 2 extended')
  assert.ok(neverPathfinder.generators.slice(5).every(record => record.calls === 10), '400ms / 40ms = 10 slices each')
  assert.strictEqual(exhausted.candidateSummaries.filter(summary => summary.id.endsWith('_extended')).length, 2)
  assert.ok(exhausted.candidateSummaries.every(summary => summary.rejectionReason === 'preview_partial'))

  // disabled: the old behaviour, one pass and out
  const disabled = setup()
  const disabledPathfinder = truncatedPreviewPathfinder({ successAfter: 20 })
  disabled.ctx.bot.pathfinder.getPathFromTo = disabledPathfinder.getPathFromTo
  const off = await build.planControlledVerticalAccess(disabled.ctx, target, 4.5, {
    verticalAccessPreviewAttempts: 3,
    verticalAccessExtendedPreviewCandidates: 0
  })
  assert.strictEqual(off.ok, false)
  assert.strictEqual(disabledPathfinder.generators.length, 3)
  assert.ok(!disabled.logs.some(line => line.includes('[BUILD_VERTICAL_ACCESS_PREVIEW_EXTENDED]')))

  // a search the PATHFINDER gave up on (noPath) is not ours to extend
  const refused = setup()
  let refusedCalls = 0
  refused.ctx.bot.pathfinder.getPathFromTo = (_movements, _start, goal) => ({
    next() {
      refusedCalls += 1
      return { done: false, value: { result: { status: 'noPath', cost: 0, path: [{ x: goal.x, y: 64, z: goal.z, toBreak: [], toPlace: [] }] } } }
    }
  })
  const noPath = await build.planControlledVerticalAccess(refused.ctx, target, 4.5, {
    verticalAccessPreviewAttempts: 3
  })
  assert.strictEqual(noPath.ok, false)
  assert.strictEqual(refusedCalls, 3)
  assert.ok(!refused.logs.some(line => line.includes('[BUILD_VERTICAL_ACCESS_PREVIEW_EXTENDED]')))
}

async function testControlledVerticalAccessAcceptsPartialPreviewAtGoal() {
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'partial',
    cost: 8,
    path: [{
      x: goal.x,
      y: goal.y,
      z: goal.z,
      toBreak: [],
      toPlace: [{
        x: goal.x,
        y: goal.y - 2,
        z: goal.z,
        dx: 0,
        dy: 1,
        dz: 0
      }]
    }]
  })

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    reservedPositions: new Set([`${target.x},${target.y},${target.z}`]),
    verticalAccessPreviewAttempts: 1,
    verticalAccessPlanAlternatives: 1
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.strictEqual(planned.data.plans.length, 1)
  assert.strictEqual(
    planned.data.candidateSummaries[0].previewResult,
    'partial_goal_reached'
  )
  assert.strictEqual(planned.data.candidateSummaries[0].rejectionReason, null)
}

async function testControlledVerticalAccessPromotesReachablePartialEndpoint() {
  const ctx = createContext()
  const target = { x: 24, y: 112, z: 9 }
  const requestedStand = { x: 25, y: 112, z: 8 }
  const reachableEndpoint = { x: 22, y: 112, z: 6 }
  const strictReference = { x: 24, y: 111, z: 9 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(15.5, 106, 1.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => {
    if (
      position.x === reachableEndpoint.x &&
      position.y === reachableEndpoint.y - 1 &&
      position.z === reachableEndpoint.z
    ) {
      return { name: 'spruce_planks', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    return { name: 'air', position, shapes: [] }
  }
  ctx.bot.pathfinder.getPathTo = () => ({
    status: 'partial',
    cost: 12.24,
    path: [{
      ...reachableEndpoint,
      toBreak: [],
      toPlace: []
    }]
  })

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessCandidateStands: [requestedStand],
    verticalAccessPreviewAttempts: 1,
    verticalAccessPlanAlternatives: 1,
    minimumPlacementStandY: 110,
    strictPlacementReferencePosition: strictReference,
    allowReservedAirStand: true,
    reservedPositions: new Set([
      `${target.x},${target.y},${target.z}`,
      `${reachableEndpoint.x},${reachableEndpoint.y},${reachableEndpoint.z}`
    ])
  })

  assert.strictEqual(planned.ok, true, planned.error)
  assert.deepStrictEqual(planned.data.stands, [reachableEndpoint])
  assert.deepStrictEqual(planned.data.plans[0].requestedStand, requestedStand)
  assert.strictEqual(
    planned.data.candidateSummaries[0].previewResult,
    'partial_reachable_endpoint'
  )
  assert.strictEqual(planned.data.candidateSummaries[0].rejectionReason, null)
}

async function testFreshControlledVerticalAccessReplanUsesCurrentPreviewAndFreshTimeoutMemo() {
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  const staleMemo = new Set(['0,69,4'])
  const stalePlans = new Map([['0,69,4', [{ x: 0, y: 68, z: 4 }]]])
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(5.5, 64, 5.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'partial',
    cost: 8,
    path: [{
      x: goal.x,
      y: goal.y,
      z: goal.z,
      toBreak: [],
      toPlace: [{
        x: goal.x,
        y: goal.y - 2,
        z: goal.z,
        dx: 0,
        dy: 1,
        dz: 0
      }]
    }]
  })

  const replanned = await build.planFreshControlledVerticalAccess(
    ctx,
    target,
    4.5,
    {
      controlledVerticalAccessPlans: stalePlans,
      reservedPositions: new Set([`${target.x},${target.y},${target.z}`]),
      standTimeoutMemo: staleMemo,
      verticalAccessPreviewAttempts: 4,
      verticalAccessPlanAlternatives: 4
    }
  )

  assert.strictEqual(replanned.ok, true, replanned.error)
  assert.strictEqual(replanned.data.plans.length, 4)
  assert.strictEqual(replanned.data.options.controlledVerticalAccessFreshReplan, false)
  assert.strictEqual(replanned.data.options.verticalAccessPlanAlternatives, 4)
  assert.notStrictEqual(replanned.data.options.standTimeoutMemo, staleMemo)
  assert.strictEqual(replanned.data.options.standTimeoutMemo.size, 0)
  assert.strictEqual(staleMemo.size, 1)
  assert.notStrictEqual(replanned.data.options.controlledVerticalAccessPlans, stalePlans)
  const freshStandKey = `${replanned.data.stands[0].x},${replanned.data.stands[0].y},${replanned.data.stands[0].z}`
  assert.deepStrictEqual(
    replanned.data.options.controlledVerticalAccessPlans.get(freshStandKey),
    replanned.data.plans[0].scaffoldPositions
  )
}

async function testRejectedVerticalCandidateDescendsBeforeClearingBotSupport() {
  const ctx = createContext()
  const logs = []
  const cleaned = []
  const support = { x: 1, y: 64, z: 1 }
  const world = new Map([[`${support.x},${support.y},${support.z}`, 'dirt']])
  const key = position =>
    `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`

  ctx.logger = { log: message => logs.push(String(message)) }
  ctx.bot.entity.position = vec(1.5, 65, 1.5)
  ctx.bot.entity.onGround = true
  ctx.bot.blockAt = position => {
    const name = world.get(key(position))
    if (name) return { name, position: vec(position.x, position.y, position.z) }
    if (position.y === 63) {
      return { name: 'stone', position: vec(position.x, position.y, position.z) }
    }
    return { name: 'air', position: vec(position.x, position.y, position.z) }
  }
  ctx.bot.dig = async block => {
    world.delete(key(block.position))
    ctx.bot.entity.position = vec(1.5, 64, 1.5)
    ctx.bot.entity.onGround = true
  }

  const result = await build.cleanupRejectedVerticalAccessCandidate(
    ctx,
    { x: 0, y: 70, z: 0 },
    { x: 1, y: 68, z: 1 },
    [support],
    {
      owner: 'test',
      reason: 'move_timeout',
      options: {
        verticalAccessCleanupSettleTimeoutMs: 100,
        verticalAccessCleanupSettlePollMs: 5,
        onControlledVerticalAccessScaffoldsCleaned(positions) {
          cleaned.push(...positions)
        }
      }
    }
  )

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(world.has(key(support)), false)
  assert.deepStrictEqual(cleaned, [support])
  assert.strictEqual(ctx.bot.entity.position.y, 64)
  assert.ok(logs.some(message =>
    message.includes('[BUILD_VERTICAL_ACCESS_CANDIDATE_SUPPORT_DESCENT]') &&
    message.includes(`support=${key(support)}`)
  ))
  assert.ok(logs.some(message =>
    message.includes('[BUILD_VERTICAL_ACCESS_CANDIDATE_CLEANUP]')))
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

async function testControlledVerticalAccessYieldsToEventLoopBetweenCandidates() {
  // 41 back-to-back previews once starved the loop for 12.6s and the server
  // kicked the client for an unanswered keep-alive (building lane, round 11,
  // 16:36Z). The planner must hand the loop back between candidates so
  // socket work runs mid-plan: a zero-delay timer armed before planning has
  // to fire while previews are still in progress, not after the last one.
  const ctx = createContext()
  const target = { x: 0, y: 72, z: 0 }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(4.5, 64, 4.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 16 }]
  ctx.bot.blockAt = position => ({ name: 'air', position })
  const stands = []
  for (let i = 0; i < 24; i++) stands.push({ x: 2 + (i % 6), y: 70, z: 2 + Math.floor(i / 6) })
  let previews = 0
  ctx.bot.pathfinder.getPathTo = () => {
    previews += 1
    const until = Date.now() + 4
    while (Date.now() < until) { /* synchronous A* slice stand-in */ }
    return { status: 'noPath', cost: 0, path: [] }
  }
  let timerFiredAfterPreviews = null
  setTimeout(() => { timerFiredAfterPreviews = previews }, 0)

  const planned = await build.planControlledVerticalAccess(ctx, target, 4.5, {
    verticalAccessCandidateStands: stands,
    verticalAccessPreviewAttempts: 24,
    verticalAccessPlanAlternatives: 1
  })

  assert.strictEqual(planned.ok, false)
  assert.strictEqual(previews, 24, 'every candidate was still previewed')
  assert.notStrictEqual(timerFiredAfterPreviews, null, 'timer ran before planning finished')
  assert.ok(
    timerFiredAfterPreviews < 24,
    `timer must fire mid-plan, but fired only after ${timerFiredAfterPreviews} previews`
  )
}

async function testProductiveControlledVerticalAccessContinuesBeforeXzFallback() {
  const ctx = createContext()
  const events = new EventEmitter()
  const logs = []
  const world = new Map()
  const target = { x: 0, y: 72, z: 0 }
  const stand = { x: 0, y: 69, z: 4 }
  const scaffold = { x: 0, y: 68, z: 4 }
  const positionKey = position =>
    `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
  let goalCount = 0

  ctx.logger = { log: message => logs.push(String(message)) }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(4.5, 64, 4.5)
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 8 }]
  ctx.bot.on = events.on.bind(events)
  ctx.bot.once = events.once.bind(events)
  ctx.bot.removeListener = events.removeListener.bind(events)
  ctx.bot.blockAt = position => {
    const name = world.get(positionKey(position))
    if (name) return { name, position: vec(position.x, position.y, position.z) }
    if (positionKey(position) === positionKey({ x: target.x, y: target.y - 1, z: target.z })) {
      return { name: 'dark_oak_planks', position: vec(position.x, position.y, position.z) }
    }
    return { name: 'air', position: vec(position.x, position.y, position.z) }
  }
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goalCount += 1
    if (goalCount === 1) {
      world.set(positionKey(scaffold), 'dirt')
      events.emit(
        'blockUpdate',
        { name: 'air', position: vec(scaffold.x, scaffold.y, scaffold.z) },
        { name: 'dirt', position: vec(scaffold.x, scaffold.y, scaffold.z) }
      )
      return
    }
    // The productive continuation reaches placement distance just before its
    // own timer fires, but no goal_reached event arrives. The caller must
    // recover this reach before considering an XZ-only fallback.
    setTimeout(() => {
      ctx.bot.entity.position = vec(stand.x + 0.5, stand.y, stand.z + 0.5)
      ctx.bot.entity.onGround = true
    }, 450)
  }

  const result = await build.moveToFirstReachablePlacementStand(ctx, target, [stand], {
    owner: 'test',
    blockName: 'spruce_fence',
    placeDistance: 4.5,
    reason: 'controlled_progress_test',
    options: {
      allowScaffolding: true,
      controlledVerticalAccessPlans: new Map([
        [positionKey(stand), [scaffold]]
      ]),
      allowCurrentReferenceReachForHighTargets: true,
      requireReachablePlacementAfterStandMove: true,
      requireStrictPlacementReferenceReachAfterStandMove: true,
      standTimeoutMemo: new Set(),
      timeoutMs: 5,
      nearXZMoveTimeoutMs: 30,
      verticalAccessProgressRetryTimeoutMs: 500,
      scaffoldPostStopGraceMs: 0,
      scaffoldSettleQuietMs: 10,
      scaffoldSettleTimeoutMs: 500
    }
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(goalCount, 2)
  assert.ok(logs.some(message =>
    message.includes('[BUILD_VERTICAL_ACCESS_PROGRESS_RETRY]')))
  assert.ok(logs.some(message =>
    message.includes('[BUILD_VERTICAL_ACCESS_PROGRESS_RETRY_FAILED]')))
  assert.ok(logs.some(message =>
    message.includes('[BUILD_MOVE_TIMEOUT_REACH_RECOVERED]')))
  assert.ok(!logs.some(message =>
    message.includes('[BUILD_PLACE_REPOSITION_XZ_FALLBACK]')))
  assert.strictEqual(events.listenerCount('blockUpdate'), 0)
  // The helper is called under placeBlock's outer held movement lock.
  assert.strictEqual(ctx.actionLock.getOwner('movement'), 'test')
}

async function testPlaceBlockCleansRejectedVerticalCandidateBeforeAlternateRoute() {
  const ctx = createContext()
  const events = new EventEmitter()
  const logs = []
  const world = new Map()
  const cleared = []
  const target = { x: 0, y: 72, z: 0 }
  const key = position => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
  const items = [
    { name: 'spruce_fence', count: 1 },
    { name: 'dirt', count: 16 }
  ]
  let goalCount = 0
  let rejectedPlannedKey = null
  let rejectedDeviationKey = null
  let rejectedRouteCleanBeforeAlternate = false

  ctx.logger = {
    log(message) {
      logs.push(message)
    }
  }
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.entity.position = vec(3.5, 64, 0.5)
  ctx.bot.inventory.items = () => items
  ctx.bot.heldItem = items[1]
  ctx.bot.on = events.on.bind(events)
  ctx.bot.once = events.once.bind(events)
  ctx.bot.removeListener = events.removeListener.bind(events)
  ctx.bot.blockAt = position => {
    const blockName = world.get(key(position))
    if (blockName) return { name: blockName, position: vec(position.x, position.y, position.z) }
    if (key(position) === key({ x: target.x, y: target.y - 1, z: target.z })) {
      return { name: 'dark_oak_planks', position: vec(position.x, position.y, position.z) }
    }
    if (position.y === 63) {
      return { name: 'stone', position: vec(position.x, position.y, position.z) }
    }
    return { name: 'air', position: vec(position.x, position.y, position.z) }
  }
  ctx.bot.pathfinder.getPathTo = (_movements, goal) => ({
    status: 'success',
    cost: 5,
    path: [{
      x: goal.x,
      y: goal.y,
      z: goal.z,
      toBreak: [],
      toPlace: [{
        x: goal.x,
        y: goal.y - 2,
        z: goal.z,
        dx: 0,
        dy: 1,
        dz: 0
      }]
    }]
  })
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goalCount += 1
    const planned = { x: goal.x, y: goal.y - 1, z: goal.z }
    if (goalCount === 1) {
      // one step off the planned column, not ten blocks away: she can only
      // place a scaffold she can reach, and a far air->dirt transition is the
      // server putting a block back, not a placement (see
      // trackMovementScaffoldPlacements)
      const deviation = { x: goal.x + 3, y: goal.y - 1, z: goal.z }
      rejectedPlannedKey = key(planned)
      rejectedDeviationKey = key(deviation)
      for (const position of [planned, deviation]) {
        const oldBlock = { name: 'air', position: vec(position.x, position.y, position.z) }
        world.set(key(position), 'dirt')
        events.emit('blockUpdate', oldBlock, {
          name: 'dirt',
          position: vec(position.x, position.y, position.z)
        })
      }
      setImmediate(() => events.emit('goal_reached'))
      return
    }

    rejectedRouteCleanBeforeAlternate =
      !world.has(rejectedPlannedKey) &&
      !world.has(rejectedDeviationKey)
    const oldBlock = { name: 'air', position: vec(planned.x, planned.y, planned.z) }
    world.set(key(planned), 'dirt')
    events.emit('blockUpdate', oldBlock, {
      name: 'dirt',
      position: vec(planned.x, planned.y, planned.z)
    })
    ctx.bot.entity.position = vec(goal.x + 0.5, goal.y, goal.z + 0.5)
    setImmediate(() => events.emit('goal_reached'))
  }
  ctx.bot.placeBlock = async (reference, faceVector) => {
    const position = {
      x: reference.position.x + faceVector.x,
      y: reference.position.y + faceVector.y,
      z: reference.position.z + faceVector.z
    }
    world.set(key(position), ctx.bot.heldItem?.name || 'air')
  }
  ctx.bot.dig = async block => {
    const support = {
      x: Math.floor(ctx.bot.entity.position.x),
      y: Math.floor(ctx.bot.entity.position.y) - 1,
      z: Math.floor(ctx.bot.entity.position.z)
    }
    const blockKey = key(block.position)
    world.delete(blockKey)
    cleared.push(blockKey)
    if (key(support) === blockKey) {
      ctx.bot.entity.position = vec(
        ctx.bot.entity.position.x,
        ctx.bot.entity.position.y - 1,
        ctx.bot.entity.position.z
      )
      ctx.bot.entity.onGround = true
    }
  }

  const result = await build.placeBlock(ctx, target, 'spruce_fence', {
    owner: 'test',
    reservedPositions: new Set([key(target)]),
    forceSafeApproach: true,
    preferHighStand: true,
    allowScaffolding: true,
    allowCurrentReachForHighTargets: true,
    allowCurrentReferenceReachForHighTargets: true,
    verticalAccessPlanAlternatives: 2,
    standMoveAttempts: 2,
    timeoutMs: 20,
    stableConfirmDelayMs: 0
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(world.get(key(target)), 'spruce_fence')
  assert.strictEqual(goalCount, 2)
  assert.strictEqual(rejectedRouteCleanBeforeAlternate, true)
  assert.ok(cleared.includes(rejectedPlannedKey))
  assert.ok(cleared.includes(rejectedDeviationKey))
  assert.strictEqual(world.has(rejectedPlannedKey), false)
  assert.strictEqual(world.has(rejectedDeviationKey), false)
  assert.ok(logs.some(message =>
    message.includes('[BUILD_PLACE_REPOSITION_REJECT]') &&
    message.includes('vertical_access_scaffold_deviation')
  ))
  assert.ok(logs.some(message => message.includes('[BUILD_VERTICAL_ACCESS_CANDIDATE_CLEANUP]')))
  assert.strictEqual(events.listenerCount('blockUpdate'), 0)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
  assert.strictEqual(ctx.actionLock.getOwner('digging'), null)
}

async function testPlaceBlockExtendsAdaptiveMoveTimeoutForTallTarget() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 0, y: 77, z: 0 }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.once = (event, callback) => {
    if (event === 'goal_reached') setTimeout(callback, 10)
  }
  ctx.bot.removeListener = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(target.x + 2, target.y, target.z)
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === 63) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 1,
    adaptiveMoveTimeout: true,
    maxAdaptiveMoveTimeoutMs: 100,
    allowCurrentReferenceReachForHighTargets: true,
    allowScaffolding: true,
    moveRange: 4
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(placed, true)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

async function testPlaceBlockFallsBackToLowStandForHighScaffoldAfterTopTimeout() {
  const ctx = createContext()
  const goals = []
  let placed = false
  const target = { x: 0, y: 75, z: 0 }
  ctx.bot.entity.position = vec(10, 69, 0)
  ctx.bot.once = () => {}
  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 1 }]
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal && goal.y < target.y) {
      ctx.bot.entity.position = vec(goal.x, goal.y, goal.z)
    }
  }
  ctx.bot.blockAt = position => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return { name: placed ? 'dirt' : 'air', position }
    }
    if (position.x === target.x && position.y === target.y - 1 && position.z === target.z) {
      return { name: 'stone', position }
    }
    if (position.y === target.y) return { name: 'dirt', position }
    if (position.y === 68) return { name: 'stone', position }
    return { name: 'air', position }
  }
  ctx.bot.placeBlock = async () => {
    placed = true
  }

  const result = await build.placeBlock(ctx, target, 'dirt', {
    owner: 'test',
    timeoutMs: 1,
    forceSafeApproach: true,
    preferHighStand: true,
    standMoveAttempts: 4
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(goals.length, 2)
  assert.ok(goals[0].y >= target.y)
  assert.ok(goals[1].y < target.y)
  assert.strictEqual(ctx.actionLock.getOwner('building'), null)
}

// 第 9 轮：放置参照的潜行名单。每一项都对应一次真机验证——
// 名单里的 11 种改前放不上（place_failed:unstable_air）、改后放得上；
// 下面「不该潜行」那 6 种改前就放得上，所以特意留在名单外。
// 第 9 轮（后勤四.3）：同一格有普通建材和「要潜行的」两种邻居可选时，
// 先给她普通那一块——潜行能救回交互块，但不撞这一次墙更省事。
function testReferenceCandidatesPreferNonInteractive() {
  const target = { x: 5, y: 64, z: 5 }
  const world = new Map()
  const put = (x, y, z, name) => world.set(`${x},${y},${z}`, { name, position: vec(x, y, z) })
  put(5, 63, 5, 'hopper')      // 下方：交互块
  put(6, 64, 5, 'stone')       // 侧面：普通建材
  put(4, 64, 5, 'repeater')    // 侧面：交互块
  const bot = {
    blockAt(pos) {
      return world.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air', position: vec(pos.x, pos.y, pos.z) }
    }
  }

  const refs = build.findReferenceBlockForPlacement({ bot }, target, 'oak_planks', null)
  assert.ok(refs, 'expected a reference candidate')
  assert.strictEqual(refs.name, 'stone')

  // 只有交互块可选时照样得给她一个，不能空手回去
  world.delete('6,64,5')
  const onlyInteractive = build.findReferenceBlockForPlacement({ bot }, target, 'oak_planks', null)
  assert.ok(onlyInteractive, 'expected interactive reference when nothing else is available')
  assert.strictEqual(build.shouldSneakForPlacementReference(onlyInteractive), true)
}

// Out of reach is not the same as impossible. The gate that refuses a dig
// she cannot land would, on its own, leave the fort gate column at
// 598,69..74,-18 standing forever; walking to it first is what actually
// removes it. And when the walk fails, the honest refusal still stands.
function farClearContext (blockName = 'dirt') {
  const ctx = createContext()
  const logs = []
  ctx.logger = { log: message => logs.push(String(message)) }
  const world = new Map([['14,64,0', blockName]])
  const digs = []
  ctx.bot.entity.position = vec(0.5, 64, 0.5)
  ctx.bot.blockAt = position => {
    const cell = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    return { name: world.get(cell) || 'air', position: vec(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)) }
  }
  ctx.bot.dig = async block => {
    digs.push(`${block.position.x},${block.position.y},${block.position.z}`)
    world.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  }
  ctx.bot.once = (event, callback) => { if (event === 'goal_reached') setImmediate(callback) }
  ctx.bot.removeListener = () => {}
  return { ctx, logs, world, digs }
}

const FAR_CLEAR_OPTIONS = {
  temporaryReferenceClearStableMs: 0,
  temporaryReferenceClearPollMs: 1,
  temporaryReferenceClearConfirmTimeoutMs: 20,
  temporaryReferenceClearAttempts: 1,
  temporaryReferenceClearRetryDelayMs: 0,
  temporaryReferenceClearApproachTimeoutMs: 1000
}

async function testTemporaryReferenceClearWalksIntoReachFirst() {
  const { ctx, logs, world, digs } = farClearContext()
  let goal = null
  ctx.bot.pathfinder.setGoal = requested => {
    if (!requested) return
    goal = requested
    // the walk lands her beside the column
    ctx.bot.entity.position = vec(12.5, 64, 0.5)
  }

  const result = await build.clearTemporaryReferenceBlock(ctx, { x: 14, y: 64, z: 0 }, {
    options: FAR_CLEAR_OPTIONS
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.ok(goal, 'it must actually ask to walk there')
  assert.deepStrictEqual(digs, ['14,64,0'], 'and only dig once it is in reach')
  assert.strictEqual(world.has('14,64,0'), false)
  const approach = logs.find(message => message.includes('[BUILD_TEMP_REFERENCE_CLEAR_APPROACH]'))
  assert.ok(approach, logs.join('\n'))
  assert.ok(approach.includes('pos=14,64,0'), approach)
  assert.ok(approach.includes('result=moved'), approach)
  assert.ok(approach.includes('inReach=true'), approach)
  assert.ok(!logs.some(message => message.includes('UNREACHABLE')))
  assert.ok(logs.some(message => message.includes('[BUILD_STAIR_TEMP_REFERENCE_CLEAR] pos=14,64,0')))
}

async function testTemporaryReferenceClearStaysHonestWhenTheWalkFails() {
  const { ctx, logs, world, digs } = farClearContext()
  // the walk never gets anywhere
  ctx.bot.pathfinder.setGoal = () => {}
  ctx.bot.once = () => {}

  const result = await build.clearTemporaryReferenceBlock(ctx, { x: 14, y: 64, z: 0 }, {
    options: FAR_CLEAR_OPTIONS
  })

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /^temporary_reference_clear_unreachable:dirt$/)
  assert.strictEqual(result.unreachable, true)
  assert.strictEqual(digs.length, 0)
  assert.strictEqual(world.get('14,64,0'), 'dirt')
  const approach = logs.find(message => message.includes('[BUILD_TEMP_REFERENCE_CLEAR_APPROACH]'))
  assert.ok(approach.includes('inReach=false'), approach)
  assert.ok(logs.some(message => message.includes('[BUILD_TEMP_REFERENCE_CLEAR_UNREACHABLE]')))
  assert.ok(build.temporaryReferenceResidueLedger(ctx).has('14,64,0'))
}

async function testTemporaryReferenceClearWalkCanBeTurnedOff() {
  const { ctx, digs } = farClearContext()
  let asked = false
  ctx.bot.pathfinder.setGoal = () => { asked = true }
  const result = await build.clearTemporaryReferenceBlock(ctx, { x: 14, y: 64, z: 0 }, {
    options: { ...FAR_CLEAR_OPTIONS, walkIntoReachBeforeClear: false }
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(asked, false)
  assert.strictEqual(digs.length, 0)
}

// Build-20 logged SCAFFOLD_PLACED for 598,69,-18 while she stood fourteen
// blocks away at 607.5,67,1.3. She cannot place a block she cannot reach:
// that air -> dirt transition is the server putting back what a too-far dig
// only pretended to remove.
async function testScaffoldTrackingIgnoresBlocksSheCouldNotHavePlaced() {
  const ctx = createContext()
  const listeners = {}
  ctx.bot.entity.position = vec(607.5, 67, 1.3)
  ctx.bot.on = (event, callback) => { listeners[event] = callback }
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder.setGoal = () => {}
  ctx.bot.once = (event, callback) => { if (event === 'goal_reached') setImmediate(callback) }
  const placed = []
  const moving = move.moveTo(ctx, { x: 607, y: 67, z: 1 }, {
    range: 4,
    timeoutMs: 30,
    onScaffoldPlaced: position => placed.push(`${position.x},${position.y},${position.z}`)
  })
  const emit = (x, y, z) => listeners.blockUpdate?.(
    { name: 'air', position: vec(x, y, z) },
    { name: 'dirt', position: vec(x, y, z) }
  )
  emit(598, 69, -18)   // fourteen blocks away: the server correcting us
  emit(607, 68, 1)     // beside her: a scaffold she really placed
  await moving
  assert.deepStrictEqual(placed, ['607,68,1'])
}

function testSneakForPlacementReferenceList() {
  const needsSneak = [
    'hopper', 'dropper', 'dispenser', 'crafter',
    'repeater', 'comparator', 'daylight_detector',
    'beacon', 'decorated_pot', 'redstone_wire',
    'shulker_box', 'red_shulker_box', 'light_blue_shulker_box'
  ]
  for (const name of needsSneak) {
    assert.strictEqual(build.shouldSneakForPlacementReference({ name }), true, `expected sneak for ${name}`)
  }

  const doesNotNeedSneak = ['bell', 'chiseled_bookshelf', 'respawn_anchor', 'cake', 'rail', 'snow']
  for (const name of doesNotNeedSneak) {
    assert.strictEqual(build.shouldSneakForPlacementReference({ name }), false, `expected no sneak for ${name}`)
  }

  // 第 9 轮之前就在名单里的，一个都不能掉
  const legacy = [
    'oak_door', 'oak_trapdoor', 'oak_fence_gate', 'stone_button', 'lever',
    'chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'blast_furnace',
    'anvil', 'white_bed', 'smoker', 'lectern', 'note_block'
  ]
  for (const name of legacy) {
    assert.strictEqual(build.shouldSneakForPlacementReference({ name }), true, `expected sneak for legacy ${name}`)
  }

  // 普通建材当参照时不该白按一次潜行
  for (const name of ['stone', 'oak_planks', 'cobblestone', 'dirt', '']) {
    assert.strictEqual(build.shouldSneakForPlacementReference({ name }), false, `expected no sneak for ${name}`)
  }
  assert.strictEqual(build.shouldSneakForPlacementReference(null), false)
}

// Round 11, live: she stood on a 5x5 tower top (feet y=106) with the chest on
// the ground six blocks below. The chest walk refuses drops over 4 and the
// old escape chain only ever moved her sideways at the same height, so the
// storage task died with chest_path_unreachable. The chain now descends:
// ledges first, and when there is no ledge, one deliberate drop she can afford.
function chestDescentContext(params = {}) {
  const ctx = createContext()
  const chestPosition = vec(8, 64, 0)
  const goals = []
  const movementsSeen = []
  ctx.bot.registry = minecraftData('1.20.1')
  ctx.bot.health = params.health ?? 20
  ctx.bot.entity.position = vec(0.5, 70, 0.5)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder.setMovements = movements => movementsSeen.push(movements)
  ctx.bot.pathfinder.setGoal = goal => {
    if (!goal) return
    goals.push({ x: goal.x, y: goal.y, z: goal.z })
    const arrive = params.arrive?.(goal, goals.length)
    if (arrive) ctx.bot.entity.position = vec(arrive.x, arrive.y, arrive.z)
  }
  const solid = new Set(params.solid || [])
  ctx.bot.blockAt = position => {
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    if (Math.floor(position.x) === 8 && Math.floor(position.y) === 64 && Math.floor(position.z) === 0) {
      return { name: 'chest', position: chestPosition, shapes: [[0, 0, 0, 1, 0.875, 1]] }
    }
    if (Math.floor(position.y) <= 63 || solid.has(key)) return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    return { name: 'air', position, shapes: [] }
  }
  return { ctx, chestPosition, goals, movementsSeen }
}

function captureConsole(run) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  return run().finally(() => { console.log = original }).then(result => ({ result, lines }))
}

async function testChestWalkDescendsByLedgeWhenChestIsFarBelow() {
  const ledgeSupport = '4,66,0' // a block under (4.5,67,0.5): a ledge 3 below her feet, the fall the walk allows
  const { ctx, chestPosition, goals, movementsSeen } = chestDescentContext({
    solid: [ledgeSupport],
    arrive(goal, count) {
      if (count === 1) return null // the direct walk times out
      if (count === 2) return { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 } // she reaches the ledge (GoalNear floors its cell; she stands on its centre)
      return { x: 7, y: 64, z: 0 } // and then the chest
    }
  })
  const { result, lines } = await captureConsole(() => storage.moveToChest(ctx, chestPosition, {
    owner: 'test',
    timeoutMs: 1,
    escapeWaypointTimeoutMs: 50,
    retryTimeoutMs: 50
  }))
  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(goals, [
    { x: 8, y: 64, z: 0 },
    { x: 4, y: 67, z: 0 },
    { x: 8, y: 64, z: 0 }
  ], 'direct walk, ledge, chest')
  assert.ok(lines.some(line => line.includes('[CHEST_PATH_ESCAPE_ATTEMPT] target=8,64,0 waypoint=4.5,67,0.5')))
  assert.ok(lines.some(line => line.includes('[CHEST_PATH_ESCAPE_RECOVERED]')))
  assert.ok(!lines.some(line => line.includes('CHEST_PATH_ESCAPE_DROP')), 'a ledge needs no deliberate drop')
  assert.ok(movementsSeen.every(movements => movements.maxDropDown === 4), 'the walk keeps its default drop')
}

async function testChestWalkTakesAnAffordableDropWhenThereIsNoLedge() {
  const { ctx, chestPosition, goals, movementsSeen } = chestDescentContext({
    health: 20,
    arrive(goal, count) {
      if (count === 1) return null
      return { x: 7, y: 64, z: 0 } // the retry with the wider drop gets there
    }
  })
  const { result, lines } = await captureConsole(() => storage.moveToChest(ctx, chestPosition, {
    owner: 'test',
    timeoutMs: 1,
    retryTimeoutMs: 50
  }))
  assert.strictEqual(result.ok, true, result.error)
  assert.deepStrictEqual(goals, [{ x: 8, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }], 'no ledge: straight to the retry')
  assert.ok(lines.some(line => line.includes('[CHEST_PATH_ESCAPE_DROP] target=8,64,0 drop=6 affordable=8 health=20 reason=no_ledge_within_3')), lines.join('\n'))
  assert.strictEqual(movementsSeen.length, 2)
  assert.strictEqual(movementsSeen[0].maxDropDown, 4, 'the first walk keeps the default drop')
  assert.strictEqual(movementsSeen[1].maxDropDown, 7, 'a 6-block fall is feet-to-landing-top 7 upstream')
  assert.ok(lines.some(line => line.includes('[CHEST_PATH_ESCAPE_RECOVERED] target=8,64,0 waypoint=drop:6')))
}

async function testChestWalkRefusesTheDropWhenHealthCannotAffordIt() {
  const { ctx, chestPosition, goals, movementsSeen } = chestDescentContext({
    health: 5,
    arrive() { return null }
  })
  const { result, lines } = await captureConsole(() => storage.moveToChest(ctx, chestPosition, {
    owner: 'test',
    timeoutMs: 1,
    retryTimeoutMs: 50
  }))
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'move_timeout', 'the original failure is reported, not hidden')
  assert.strictEqual(goals.length, 1, 'no second walk')
  assert.strictEqual(movementsSeen.length, 1)
  assert.ok(lines.some(line => line.includes('[CHEST_PATH_ESCAPE_DROP_REFUSED] target=8,64,0 drop=6 affordable=3 health=5')), lines.join('\n'))
}

async function testChestWalkKeepsSameLevelEscapeForSmallDrops() {
  // chest only 2 below: the old same-level chain still applies, no ledges
  const { ctx, goals } = chestDescentContext({
    solid: ['4,65,0'],
    arrive(goal, count) {
      if (count === 1) return null
      return { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }
    }
  })
  ctx.bot.entity.position = vec(0.5, 66, 0.5)
  ctx.bot.blockAt = position => {
    if (Math.floor(position.x) === 8 && Math.floor(position.y) === 64 && Math.floor(position.z) === 0) {
      return { name: 'chest', position: vec(8, 64, 0), shapes: [[0, 0, 0, 1, 0.875, 1]] }
    }
    if (Math.floor(position.y) <= 65) return { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] }
    return { name: 'air', position, shapes: [] }
  }
  const { lines } = await captureConsole(() => storage.moveToChest(ctx, vec(8, 64, 0), {
    owner: 'test',
    timeoutMs: 1,
    escapeWaypointTimeoutMs: 50,
    retryTimeoutMs: 50
  }))
  assert.strictEqual(goals[1].y, 66, 'same-level waypoint')
  assert.ok(!lines.some(line => line.includes('CHEST_PATH_ESCAPE_DROP')))
}

async function testOpenChestContinuesWhenMoveTimesOutAfterReachingOpenDistance() {
  const ctx = createContext()
  const chestPosition = vec(8, 64, 0)
  let opened = false
  const goals = []

  ctx.bot.entity.position = vec(0, 64, 0)
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder.setGoal = goal => {
    goals.push(goal)
    if (goal) ctx.bot.entity.position = vec(5, 64, 0)
  }
  ctx.bot.blockAt = position => {
    if (position.x === chestPosition.x && position.y === chestPosition.y && position.z === chestPosition.z) {
      return { name: 'chest', position: chestPosition, liveBlock: true }
    }
    return { name: 'air', position }
  }
  ctx.bot.openChest = async block => {
    assert.strictEqual(block.liveBlock, true)
    opened = true
    return {
      containerItems: () => [],
      close() {}
    }
  }

  const result = await storage.openChest(ctx, chestPosition, {
    owner: 'test',
    timeoutMs: 1,
    openDistance: 4.5
  })

  assert.strictEqual(result.ok, true)
  assert.ok(result.chestWindow)
  assert.strictEqual(result.data.chestWindow, result.chestWindow)
  assert.strictEqual(opened, true)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(ctx.actionLock.getOwner('movement'), null)
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function testSmeltSupportsSandToGlass() {
  const ctx = createContext()
  ctx.bot.inventory.items = () => [{ name: 'sand', count: 4 }, { name: 'coal', count: 8 }]
  ctx.bot.openFurnace = undefined
  // sand is an accepted smelt input (vanilla sand -> glass); with no furnace
  // API available the action must fail later than input validation.
  const sandResult = await smelt.smeltItem(ctx, 'sand', 4, { owner: 'test' })
  assert.strictEqual(sandResult.ok, false)
  assert.notStrictEqual(sandResult.error, 'unsupported_smelt_input')
  const unsupported = await smelt.smeltItem(ctx, 'oak_log', 1, { owner: 'test' })
  assert.strictEqual(unsupported.ok, false)
  assert.strictEqual(unsupported.error, 'unsupported_smelt_input')
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), null)
}

async function run() {
  assertAllMethodsExist()
  testReservedBuildPositionsAreExcludedFromPathfinderDig()
  await testFailuresDoNotCrash()
  await testSmeltSupportsSandToGlass()
  await testMoveToRegistersInventoryScaffoldBlocksWhenAllowed()
  await testMoveToExcludesReservedBlueprintCellsFromScaffolding()
  await testMoveToRestrictsControlledScaffoldingToPlannedCells()
  await testMoveToReportsPlannerRefusalOncePerWindow()
  await testMoveToWaitsForControlledScaffoldOperationToSettle()
  await testMoveToWaitsForQueuedControlledScaffoldOperationAfterStop()
  await testMoveToSynchronouslyCancelsLateControlledScaffold()
  await testMoveToSynchronouslyQuiescesReachedCondition()
  await testMoveToCanIgnoreYWithNearXZGoal()
  await testLocksReleaseOnSuccessfulActions()
  testStandTimeoutMemoCapsRetryMoves()
  testStandTimeoutBlacklistDiversifiesCandidates()
  await testExhaustedStandBlacklistReturnsDiagnosticFailure()
  testStandingPlannerRejectsFenceHeightGoal()
  testFluidStandingPlannerRejectsReservedCloseCell()
  testStandingPlannerAllowsReservedAirCellOnlyWhenExplicitlyRecovering()
  await testCraftItemTableSemantics()
  await testExploreSafety()
  await testMiningRefusesProtectedBlocks()
  await testMiningToolRulesAndHandAllowed()
  await testPlaceBlockAcceptsPlacedBlockAfterTimeout()
  await testPlaceBlockRepairsWrongBlockAfterStableConfirmFailure()
  await testPlaceBlockRetriesAlternateReference()
  await testPlaceBlockPrefersLowerReferenceWhenSupported()
  await testPlaceBlockPrefersSideReferenceWithoutLowerSupport()
  await testPlaceBlockBuildsTemporaryReferenceColumnWhenUnsupported()
  await testPlaceBlockStandingTorchUsesBelowReferenceInWallCorner()
  await testPlaceBlockSneaksAgainstInteractiveReference()
  await testPlaceBlockUsesWaterBucketForWaterBlock()
  await testPlaceBlockUsesHeldWaterBucketWhenInventoryListOmitsHeldItem()
  await testPlaceBlockWaitsForDelayedWaterAfterBucketUse()
  await testPlaceBlockFallsBackToActivateItemForWaterBucket()
  await testFluidCurrentExactRaySkipsMovementAndPlacesSource()
  await testFluidClosedTargetUsesUnreservedAdjacentUpperStance()
  await testFluidReservedAdjacentStandsAreRejectedBeforeNearCandidates()
  await testFluidNoExactRayDoesNotConsumeBucket()
  await testFluidFlowingWaterRequiresMaterialRefill()
  await testFluidWrongCellWaterRequiresMaterialRefill()
  await testPlaceBlockDoesNotActivateWaterBucketThroughOccluder()
  await testPlaceBlockRejectsFlowingWaterForSourceTarget()
  await testPlaceBlockCanReplaceWaterWithSolidBlock()
  await testClearBlockRetriesDiggingAborted()
  await testClearBlockTimesOutAndCancelsUnboundedDig()
  await testClearBlockSkipsRepositionWhenThinBlockDigReachable()
  await testClearBlockUsesBotCanDigForThinBlockReachEdge()
  await testClearBlockUsesExtendedReachForThinBlockReachEdge()
  await testClearBlockEquipsToolWhenOwnerAlreadyHoldsInventoryLock()
  await testPlaceBlockUsesStoredDirtPathItemBeforeShovel()
  await testPlaceBlockCachesDirtPathStorageMissForSameOwner()
  await testDirtPathStopsAfterInterruptedStorageLookup()
  await testPlaceBlockUsesShovelForExistingDirtPathBase()
  await testPlaceBlockAcceptsDirtPathAfterBlockUpdateTimeout()
  await testPlaceBlockRetriesDirtPathBaseAfterBlockUpdateAir()
  await testPlaceBlockAcceptsDelayedDirtPathBaseAfterTimeout()
  await testPlaceBlockMovesBeforePlacingDirtPathBase()
  await testPlaceBlockDirtPathBaseEquipsWhenOwnerAlreadyHoldsInventoryLock()
  await testPlaceBlockRetriesDirtPathActivationAfterAirRegression()
  await testPlaceBlockPlacesDirtThenUsesShovelForDirtPath()
  await testPlaceBlockFallsBackToActivateItemForDirtPath()
  await testPlaceBlockClearsDirtPathTopObstruction()
  await testPlaceBlockPreparesShovelForDirtPathWhenMissing()
  await testPlaceBlockClearsTopBeforeStoredDirtPathItem()
  testDirtPathUsesDirtAsRuntimeMaterial()
  testRenamedBlockItemsUseRealInventoryItems()
  await testGroundPlantRequiresBelowReference()
  await testPlaceBlockUsesFacingSideReferenceForWallSigns()
  await testPlaceBlockAllowsTrapdoorReferenceForWallSigns()
  await testPlaceBlockUsesFacingSideReferenceForTripwireHook()
  await testPlaceBlockUsesStatefulTrapdoorPlacement()
  await testPlaceBlockUsesCurrentStatefulReferenceReachForTrapdoor()
  await testPlaceBlockDefersInitialMoveForTrapdoorStatefulReference()
  await testPlaceBlockRepairsWrongStateTrapdoorBeforeRetry()
  await testPlaceBlockTogglesTrapdoorOpenState()
  await testPlaceBlockUsesTrapdoorFacingMatchedSideReference()
  await testPlaceBlockBuildsFacingMatchedTemporaryReferenceForTrapdoor()
  await testPlaceBlockUsesDarkOakPlanksForTemporaryReference()
  await testPlaceBlockPrefersHighStandForHighTemporaryReference()
  await testClearBlockUsesRaisedCurrentStandForElevatedRepair()
  await testClearBlockFallsBackToNearXZForElevatedRepair()
  await testPlaceBlockSneaksForStatefulTrapdoorAgainstFenceGateReference()
  await testPlaceBlockUsesTrapdoorAsStatefulTrapdoorReference()
  await testPlaceBlockRecoversTrapdoorReferenceReachAfterMoveTimeout()
  await testPlaceBlockUsesStatefulTopStairPlacement()
  await testPlaceBlockUsesStatefulBottomStairPlacement()
  await testPlaceBlockPreservesStairFacingYawDuringStatefulPlace()
  await testPlaceBlockUsesAvailableMaterialForStairTemporaryReference()
  await testPlaceBlockBuildsStairTemporaryReferenceColumn()
  await testPlaceBlockSkipsReservedStairTemporaryReferenceColumn()
  await testPlaceBlockAllowsReservedPendingStairTemporaryReference()
  await testPlaceBlockUsesDiagonalStairFacingStandWhenDirectStandBlocked()
  await testPlaceBlockUsesWideStairFacingStandAtEdge()
  await testPlaceBlockFallsBackWhenStairFacingStandUnavailable()
  await testPlaceBlockFallsBackWhenStairFacingStandMoveTimesOut()
  await testPlaceBlockUsesHighOneAwayStairFacingStandAtEdge()
  await testPlaceBlockUsesStatefulTopSlabPlacement()
  await testPlaceBlockRepairsWrongBlockAfterStatefulTopSlabMisplace()
  await testPlaceBlockUsesDoubleSlabMergePlacement()
  await testPlaceBlockUsesStatefulBottomSlabPlacement()
  await testPlaceBlockBuildsTemporaryReferenceForStatefulBottomSlab()
  await testPlaceBlockBuildsSideTemporaryReferenceForStatefulTopSlab()
  await testPlaceBlockUsesStatefulWallButtonPlacement()
  await testPlaceBlockUsesNorthSupportForSouthFacingWallButton()
  await testPlaceBlockRejectsWrongSideWallButtonSupport()
  await testPlaceBlockRetriesStatefulWallButtonReferenceStand()
  await testPlaceBlockUsesStatefulVerticalLogPlacement()
  await testPlaceBlockMovesForStatefulHorizontalLogReferenceReach()
  await testPlaceBlockBuildsAxisLogTemporaryReferenceBesideGable()
  await testPlaceBlockRejectsHorizontalLogWithoutAxisReference()
  await testPlaceBlockUsesTopReferenceForHangingLantern()
  await testPlaceBlockUsesBottomSlabTopReferenceForHangingLantern()
  await testPlaceBlockRejectsHangingLanternWithoutTopSupport()
  await testPlaceBlockUsesBottomTrapdoorTopReferenceForHangingLantern()
  await testPlaceBlockRepairsWrongBlockAfterHangingLanternMisplace()
  await testPlaceBlockStacksCandleToExpectedCount()
  await testPlaceBlockExtendsExistingCandleStackWithoutClearing()
  await testPlaceBlockRejectsIncompleteCandleStackState()
  await testPlaceBlockClearsWrongStateTopStairBeforeAlternateReference()
  await testPlaceBlockFallsBackToAvailableSideReferenceForTripwireHook()
  await testPlaceBlockOrientsFenceGateFacingAndConfirmsState()
  await testFenceGateWrongStateCleanupRequestsMaterialRefill()
  await testPlaceBlockOrientsFurnaceFacingAndConfirmsState()
  await testPlaceBlockOrientsChestFacingAndConfirmsState()
  await testPlaceBlockAlignsDoorOpenStateAfterPlacement()
  await testPlaceBlockFallsBackToSideReferenceForDoor()
  await testPlaceFenceGateSneaksAgainstFenceGateReference()
  await testPlaceBlockOrientsImportedBedFoot()
  await testPlaceBlockBedKeepsOrientedYawViaGenericPlace()
  await testPlaceBlockFallsBackToPartnerCellForBedPair()
  await testPlaceBlockRetriesTransientEquipTimeout()
  await testPlaceBlockRetriesUnconfirmedEquipNoop()
  await testPlaceBlockEquipsWhenOwnerAlreadyHoldsInventoryLock()
  await testPlaceBlockBuildsPottedPlant()
  await testPlaceBlockUsesSafeApproachForHighTarget()
  await testPlaceBlockPrefersLowStandForFormalTallTarget()
  await testPlaceBlockCanStandOnTopPlatformForTallTarget()
  await testPlaceBlockRetriesAlternateStandAfterMoveTimeout()
  testStandPathPrescreenDemotesUnreachableNearestStand()
  testStandPathPrescreenSkipsTrivialNearbyStand()
  await testPlacementStandMoveSkipsUnreachableNearestStand()
  testFluidStanceRelaxationFindsRimSlabStands()
  testFluidStanceRelaxationRespectsReservedHeadroom()
  testFluidStanceRelaxationReportsNoneWithoutAnyStands()
  testWalkablePartialSupportTopBounds()
  await testPlaceBlockRejectsStandMoveThatStillIntersectsTarget()
  await testPlaceBlockPrefersTopStandForHighScaffold()
  await testPlaceBlockUsesCurrentReachForAlreadyReachableHighScaffold()
  await testPlaceBlockUsesReachableReferenceForHighFormalTarget()
  await testPlaceBlockRecoversNearXZMoveWithReachableHighReference()
  await testPlaceBlockRecoversNearXZOneBelowMinimumWithStrictReference()
  await testPlaceBlockUsesCurrentReachWhenForcedApproachAlreadyReachable()
  await testPlaceBlockRecoversHighReferenceReachAfterMoveTimeout()
  await testPlaceBlockRecoversDirectMoveWhenTargetReachable()
  await testPlaceBlockRecoversPartialScaffoldMoveWhenTargetReachable()
  await testPlaceBlockRepairsTargetScaffoldAfterMove()
  testControlledVerticalAccessFiltersForRequiredReferenceReach()
  testControlledVerticalAccessHonorsMinimumStandHeight()
  testVerticalAccessStandColumnSupportMeasuresThePillar()
  testControlledVerticalAccessPartitionsStandsByScaffoldColumn()
  testTruncatedPreviewSelectionPrefersAClearScaffoldColumn()
  await testControlledVerticalAccessExtendsTheClearColumnCandidate()
  await testControlledVerticalAccessPrefersDiagonalTerminalBridge()
  await testControlledVerticalAccessPrefersPlacementReferenceMargin()
  testControlledVerticalAccessReachedWhenRequiresSettledReferenceMargin()
  await testControlledVerticalAccessFallsBackAfterRestrictedStandsExhausted()
  await testControlledVerticalAccessRejectsFormalScaffoldPath()
  await testPlaceBlockPlansAndCleansControlledVerticalAccess()
  await testControlledVerticalAccessUsesActualPlacementCellCoordinates()
  await testControlledVerticalAccessExhaustionIncludesCandidateSummaries()
  await testControlledVerticalAccessExtendsTruncatedPreviewsBestFirst()
  await testControlledVerticalAccessExtendedPassIsBoundedAndOptional()
  await testControlledVerticalAccessAcceptsPartialPreviewAtGoal()
  await testControlledVerticalAccessPromotesReachablePartialEndpoint()
  await testFreshControlledVerticalAccessReplanUsesCurrentPreviewAndFreshTimeoutMemo()
  await testControlledVerticalAccessYieldsToEventLoopBetweenCandidates()
  await testRejectedVerticalCandidateDescendsBeforeClearingBotSupport()
  await testProductiveControlledVerticalAccessContinuesBeforeXzFallback()
  await testPlaceBlockCleansRejectedVerticalCandidateBeforeAlternateRoute()
  await testPlaceBlockExtendsAdaptiveMoveTimeoutForTallTarget()
  await testPlaceBlockFallsBackToLowStandForHighScaffoldAfterTopTimeout()
  await testOpenChestContinuesWhenMoveTimesOutAfterReachingOpenDistance()
  await testChestWalkDescendsByLedgeWhenChestIsFarBelow()
  await testChestWalkTakesAnAffordableDropWhenThereIsNoLedge()
  await testChestWalkRefusesTheDropWhenHealthCannotAffordIt()
  await testChestWalkKeepsSameLevelEscapeForSmallDrops()
  await testTemporaryReferenceClearWalksIntoReachFirst()
  await testTemporaryReferenceClearStaysHonestWhenTheWalkFails()
  await testTemporaryReferenceClearWalkCanBeTurnedOff()
  await testScaffoldTrackingIgnoresBlocksSheCouldNotHavePlaced()
  testSneakForPlacementReferenceList()
  testReferenceCandidatesPreferNonInteractive()
  console.log('actions tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
