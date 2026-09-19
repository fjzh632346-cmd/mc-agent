const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { protectedBreakExclusions } = require('../systems/protected-buildings')
const { hazardsBlockCorridor, terrainHazardCellFilter } = require('../systems/terrain-hazards')
const {
  acquireActionLocks,
  distance,
  fail,
  normalizePosition,
  ok,
  releaseActionLocks
} = require('./action-utils')

const SAFE_SCAFFOLD_ITEM_NAMES = new Set([
  'dirt',
  'cobblestone',
  'stone',
  'scaffolding',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks'
])

// Non-construction movement (gathering, pickup, return-to-base, observers,
// follow, wander) must never terraform: canDig DEFAULTS FALSE. The
// construction executor's own moves already pass canDig explicitly per
// purpose (see systems/building-system.js / actions/build.js), so only
// callers that genuinely need to dig opt in with canDig:true.
// Live incident: observer/pickup pathing with the old default-true dug
// through the finished L3 cabin walls twice during L3 acceptance.
function resolveMovementProfile(options = {}) {
  const allowScaffolding = options.allowScaffolding === true
  return {
    canDig: options.canDig ?? false,
    allowScaffolding,
    allow1by1towers: options.allow1by1towers ?? allowScaffolding
  }
}

function configureMovements(bot, options = {}, context = null) {
  if (!bot?.pathfinder) return null
  try {
    const movements = new Movements(bot)
    const profile = resolveMovementProfile(options)
    movements.canDig = profile.canDig
    movements.allow1by1towers = profile.allow1by1towers
    // A walk may widen the drop it accepts (the chest-walk descent in
    // actions/storage.js does, bounded by her health); the upstream default
    // of 4 stays in force for everyone who does not ask.
    if (Number.isFinite(Number(options.maxDropDown)) && Number(options.maxDropDown) > 0) {
      movements.maxDropDown = Math.floor(Number(options.maxDropDown))
    }
    if (!profile.allowScaffolding) movements.scafoldingBlocks = []
    else {
      addInventoryScaffoldBlocks(bot, movements, options)
      addScaffoldPlacementExclusions(movements, options)
    }
    enableDoorTraversal(bot, movements)
    avoidKnownTerrainHazards(bot, movements, context, options)
    if (movements.canDig && Array.isArray(movements.exclusionAreasBreak)) {
      // Even dig-enabled moves must never plan to break blocks of a COMPLETED
      // building (exempting the mover's own active construction run).
      movements.exclusionAreasBreak.push(...protectedBreakExclusions(context, {
        exemptRunId: options.protectionExemptRunId
      }))
      addReservedBreakExclusions(movements, options)
    }
    bot.pathfinder.setMovements(movements)
    return movements
  } catch {
    return null
  }
}

// mineflayer-pathfinder 2.4.5 never routes through wooden doors: its
// `openable` set is built only from block names containing 'gate', and
// canOpenDoors defaults to false, so a door cell is a plain obstacle — with
// canDig=false a door-only entrance has NO path at all (live control run:
// out->in against the test hut timed out with the door CLOSED and with the
// door OPEN alike; L3 acceptance previously needed script-side activateBlock
// plus direct-control walking to pass its own front door).
// Fix: enable canOpenDoors, register non-iron doors as openable, and
// reclassify doors/gates by their LIVE state at plan time:
//   closed door lower half -> openable: the planner emits a useOne step and
//     the executor right-clicks it open before walking through;
//   closed door upper half -> passable for the head-height check (it swings
//     open together with the lower half before the bot's body arrives);
//   open door / open gate  -> plain walkable and NOT openable, so the
//     executor does not toggle it shut in the bot's face (the upstream
//     canOpenDoors behavior activates unconditionally, which is why it ships
//     disabled with a "causes issues" note).
function enableDoorTraversal(bot, movements) {
  const doorIds = traversableDoorBlockIds(bot)
  if (doorIds.size === 0 || !(movements.openable instanceof Set)) return movements
  movements.canOpenDoors = true
  for (const id of doorIds) movements.openable.add(id)
  const baseGetBlock = movements.getBlock.bind(movements)
  movements.getBlock = (pos, dx, dy, dz) =>
    reclassifyOpenableBlock(baseGetBlock(pos, dx, dy, dz), doorIds)
  installDoorAwarePathNormalizer(bot)
  installOpenableActivationPathReset(bot)
  return movements
}

// Route around the pits that have already trapped her.
//
// The cost model cannot express this on its own: `exclusionAreasStep` is only
// consulted for the cell a move ENDS on, and the move that put her back on the
// pit floor in round 2 was a sprint-jump whose landing cell is honest ground on
// the far side — the hole it flies over is never priced in. So the hazard has
// to change what the planner believes about those cells, the same way door
// traversal already reclassifies door blocks: mark them unwalkable for this
// one setup and every route across the mouth disappears, while the rim stays
// free to walk. See systems/terrain-hazards.js for what qualifies as a hazard
// and how long one lives.
function avoidKnownTerrainHazards(bot, movements, context, options = {}) {
  movements.__terrainHazards = null
  if (options.avoidKnownHazards === false || !context) return movements
  const filter = terrainHazardCellFilter(context, {
    botPosition: bot?.entity?.position,
    destination: options.destination,
    now: options.now
  })
  if (!filter) return movements

  const baseGetBlock = movements.getBlock.bind(movements)
  movements.getBlock = (pos, dx, dy, dz) => {
    const block = baseGetBlock(pos, dx, dy, dz)
    if (block?.position && filter(block.position)) block.safe = false
    return block
  }
  movements.__terrainHazards = filter.hazards
  return movements
}

function addReservedBreakExclusions(movements, options = {}) {
  if (!Array.isArray(movements?.exclusionAreasBreak)) return movements
  const excluded = new Set()
  collectPositionKeys(excluded, options.reservedPositions)
  collectPositionKeys(excluded, options.breakExclusionPositions)
  if (excluded.size === 0) return movements
  movements.exclusionAreasBreak.push(block => {
    const position = block?.position
    if (!position) return 0
    return excluded.has(positionKey(position)) ? Infinity : 0
  })
  movements.__reservedBreakExclusions = excluded
  return movements
}

// mineflayer-pathfinder 2.4.5 leaves its closure-local `placing` flag true
// after a useOne (door/gate activation) consumes the last toPlace entry. On
// the following physics tick it dereferences an undefined placingBlock and
// terminates the whole process. Once the activation succeeds, reset only the
// current path by re-applying the same Movements object. The goal (including
// its dynamic flag) stays intact and pathfinder replans through the now-open
// block, while resetPath clears the stale placing state before the next tick.
function installOpenableActivationPathReset(bot) {
  const pathfinder = bot?.pathfinder
  if (!pathfinder || pathfinder.__openableActivationResetInstalled) return
  if (typeof bot.activateBlock !== 'function' || typeof pathfinder.setMovements !== 'function') return
  if (typeof pathfinder.isBuilding !== 'function') return

  pathfinder.__openableActivationResetInstalled = true
  const baseActivateBlock = bot.activateBlock.bind(bot)
  bot.activateBlock = (...args) => {
    const block = args[0]
    const pathfinderActivation = pathfinder.isBuilding() === true && isHandOpenablePathBlock(block)
    const result = baseActivateBlock(...args)
    if (!pathfinderActivation || !result || typeof result.then !== 'function') return result

    return Promise.resolve(result).then(value => {
      const movements = pathfinder.movements
      if (pathfinder.isBuilding() === true && movements) {
        pathfinder.setMovements(movements)
        console.log(`[PATHFINDER_OPENABLE_REPLAN] block=${block?.name || 'unknown'} reason=clear_consumed_use_one`)
      }
      return value
    })
  }
}

function isHandOpenablePathBlock(block) {
  const name = String(block?.name || '')
  return (name.endsWith('_door') && !name.includes('iron')) || name.endsWith('_fence_gate')
}

// Second half of the door fix, at the EXECUTOR boundary: pathfinder's
// postProcessPath snaps every path node onto the highest collision shape of
// the node's block (getPositionOnTopOf). A door keeps a collision shape even
// when open (the folded panel on the cell edge), so any node in a door cell
// gets lifted ON TOP of the panel (y+1, panel-edge x/z) — a spot the bot can
// physically never reach, and it shoves forward against the frame until
// move_timeout (observed live: door opened by useOne, bot frozen outside).
// getPositionOnTopOf is closure-local and not patchable, so we normalize the
// RESULT: wrap bot.pathfinder.getPathTo and snap door-cell nodes back to the
// walkable cell center at foot height.
function installDoorAwarePathNormalizer(bot) {
  const pf = bot?.pathfinder
  if (!pf || pf.__doorPathNormalizerInstalled || typeof pf.getPathTo !== 'function') return
  pf.__doorPathNormalizerInstalled = true
  const baseGetPathTo = pf.getPathTo.bind(pf)
  pf.getPathTo = (movements, goal, timeout) => {
    const result = baseGetPathTo(movements, goal, timeout)
    normalizeDoorPathNodes(bot, result?.path)
    return result
  }
}

function normalizeDoorPathNodes(bot, path) {
  if (!Array.isArray(path)) return path
  for (const node of path) {
    const fx = Math.floor(node.x)
    const fy = Math.floor(node.y)
    const fz = Math.floor(node.z)
    const block = typeof bot?.blockAt === 'function' ? bot.blockAt(new Vec3(fx, fy, fz), false) : null
    if (!isTraversableDoorBlock(block)) continue
    const props = typeof block.getProperties === 'function' ? (block.getProperties() || {}) : {}
    node.x = fx + 0.5
    node.y = String(props.half) === 'upper' ? fy - 1 : fy
    node.z = fz + 0.5
  }
  return path
}

function isTraversableDoorBlock(block) {
  return typeof block?.name === 'string' &&
    block.name.endsWith('_door') &&
    !block.name.includes('iron')
}

function traversableDoorBlockIds(bot) {
  const ids = new Set()
  for (const block of bot?.registry?.blocksArray || []) {
    // iron doors ignore right-clicks; only hand-openable doors are traversable
    if (block?.name?.endsWith('_door') && !block.name.includes('iron')) ids.add(block.id)
  }
  return ids
}

function reclassifyOpenableBlock(block, doorIds) {
  if (!block?.openable) return block
  const isDoor = doorIds.has(block.type)
  const props = typeof block.getProperties === 'function' ? (block.getProperties() || {}) : {}
  const open = String(props.open) === 'true'
  if (open || (isDoor && String(props.half) === 'upper')) {
    block.safe = true
    block.physical = false
    block.openable = false
  } else if (isDoor) {
    // closed lower half: keep openable=true (useOne branch), but never let
    // the planner treat the door panel as walkable floor
    block.physical = false
  }
  return block
}

function addInventoryScaffoldBlocks(bot, movements, options = {}) {
  const allowedNames = scaffoldItemNameSet(options)
  const ids = new Set(Array.isArray(movements.scafoldingBlocks) ? movements.scafoldingBlocks : [])
  for (const item of bot?.inventory?.items?.() || []) {
    if (!item?.name || item.count <= 0 || !allowedNames.has(item.name)) continue
    const id = bot?.registry?.itemsByName?.[item.name]?.id
    if (Number.isFinite(id)) ids.add(id)
  }
  movements.scafoldingBlocks = [...ids]
}

function addScaffoldPlacementExclusions(movements, options = {}) {
  if (!Array.isArray(movements?.exclusionAreasPlace)) return
  const excluded = new Set()
  collectPositionKeys(excluded, options.reservedPositions)
  collectPositionKeys(excluded, options.scaffoldExclusionPositions)
  if (excluded.size > 0) movements.__scaffoldPlacementExclusions = excluded

  // NEITHER the exclusion set nor the allow-list may be an exclusionAreasPlace
  // cost callback. Upstream getMoveForward (lib/movements.js:382) charges that
  // callback against the WALK cell (blockC) while the scaffold actually lands
  // on the floor it bridges in (blockD), so such a cost is wrong both ways:
  //   - it vetoes a legal bridge whenever the cell she walks THROUGH happens
  //     to be a formal target or off the plan -- the preview carries no
  //     callback, so it planned the bridge, execution returned noPath, and she
  //     stood still until move_timeout (building lane round 14, target
  //     607,73,-16; repair lane round 10 pillar and round 11 corridor fixtures)
  //   - it does NOT veto the real violation, a bridge whose floor IS the
  //     formal target, because that cell is never the one scored
  // Both constraints are enforced by installScaffoldPlacementCellFilter below,
  // which keys on reference + face: the cell the block truly occupies.
  let allowed = null
  if (options.scaffoldAllowedPositions != null) {
    allowed = new Set()
    collectPositionKeys(allowed, options.scaffoldAllowedPositions)
    movements.__scaffoldPlacementAllowed = allowed
  }

  installScaffoldPlacementCellFilter(movements, { excluded, allowed })
}

function installScaffoldPlacementCellFilter(movements, constraints = {}) {
  if (typeof movements?.getNeighbors !== 'function') return
  const excluded = constraints.excluded instanceof Set ? constraints.excluded : new Set()
  const allowed = constraints.allowed instanceof Set ? constraints.allowed : null
  if (excluded.size === 0 && allowed == null) return

  const baseGetNeighbors = movements.getNeighbors.bind(movements)
  const isAllowed = move => isScaffoldPathMoveAllowed(move, { excluded, allowed })
  movements.getNeighbors = node => {
    const neighbors = baseGetNeighbors(node)
    if (!Array.isArray(neighbors)) return neighbors
    return neighbors.filter(isAllowed)
  }
  movements.__scaffoldPlacementCellFilter = isAllowed
}

function isScaffoldPathMoveAllowed(move, constraints = {}) {
  const excluded = constraints.excluded instanceof Set ? constraints.excluded : new Set()
  const allowed = constraints.allowed instanceof Set ? constraints.allowed : null
  for (const placement of Array.isArray(move?.toPlace) ? move.toPlace : []) {
    if (placement?.useOne) continue
    const position = scaffoldPlacementCell(placement)
    if (!position) return false
    const key = positionKey(position)
    if (excluded.has(key)) return false
    if (allowed && !allowed.has(key)) return false
  }
  return true
}

function scaffoldPlacementCell(placement) {
  if (![placement?.x, placement?.y, placement?.z].every(Number.isFinite)) return null
  // Pathfinder's toPlace coordinate is the clicked reference block. The
  // temporary block is placed on the referenced face. Some upstream movement
  // branches charge exclusion cost against a different block (notably the
  // walk cell above a forward bridge), so cost callbacks alone cannot protect
  // a formal construction target. Filter generated moves by the actual cell.
  return {
    x: Math.floor(placement.x + (Number(placement.dx) || 0)),
    y: Math.floor(placement.y + (Number(placement.dy) || 0)),
    z: Math.floor(placement.z + (Number(placement.dz) || 0))
  }
}

function collectPositionKeys(output, positions) {
  if (!positions) return
  if (typeof positions === 'string') {
    output.add(positions)
    return
  }
  if (Number.isFinite(positions.x) && Number.isFinite(positions.y) && Number.isFinite(positions.z)) {
    output.add(positionKey(positions))
    return
  }
  if (typeof positions[Symbol.iterator] !== 'function') return
  for (const position of positions) collectPositionKeys(output, position)
}

function positionKey(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function scaffoldItemNameSet(options = {}) {
  const configured = options.scaffoldBlockNames
  if (!configured) return SAFE_SCAFFOLD_ITEM_NAMES
  const names = Array.isArray(configured)
    ? configured
    : (typeof configured[Symbol.iterator] === 'function' ? [...configured] : [])
  return new Set(names.map(name => String(name || '')).filter(Boolean))
}

async function moveTo(context, position, options = {}) {
  const bot = context?.bot
  const target = normalizePosition(position)
  if (!bot?.entity) return fail('missing_bot')
  if (!bot.pathfinder) return fail('missing_pathfinder')
  if (!target) return fail('missing_position')

  const lock = acquireActionLocks(context, ['movement'], 'moveTo', options)
  if (!lock.ok) return fail(lock.error, lock)

  const stopTrackingScaffolds = trackMovementScaffoldPlacements(bot, options)
  const scaffoldActivity = trackMovementScaffoldActivity(bot, options)
  const pathStatus = trackMovePathStatus(bot, context, target, options)
  try {
    const movements = configureMovements(bot, { ...options, destination: target }, context)
    pathStatus.bindMovements(movements)
    const range = options.range ?? 1
    const timeoutMs = options.timeoutMs ?? 15000
    const ignoreY = options.ignoreY === true
    if (isNearGoal(bot, target, range, ignoreY)) {
      return ok('already_near', { position: target, range })
    }
    const goal = ignoreY
      ? new goals.GoalNearXZ(target.x, target.z, range)
      : new goals.GoalNear(target.x, target.y, target.z, range)
    bot.pathfinder.setGoal(goal)

    const waitOptions = {
      ignoreY,
      reachedWhen: options.reachedWhen,
      verifyGoalReachedEvent: options.verifyGoalReachedEvent === true,
      requireOnGroundAtGoal: options.requireOnGroundAtGoal === true
    }
    const startedAt = normalizePosition(bot.entity?.position)
    let reached = await waitForGoal(bot, target, range, timeoutMs, options.shouldContinue, waitOptions)

    // Avoiding a known pit must never turn a reachable place into an
    // unreachable one — that would just trade round 2's bug for a worse one.
    // If the only route we refused to plan was through a remembered hazard,
    // drop the avoidance for one retry and walk the honest, riskier way.
    //
    // Only when she never got going, though. A long walk that simply ran out
    // of time is the ordinary outcome here, and paying a second full timeout
    // for every one of those would be its own regression.
    if (!reached && shouldRetryWithoutHazards(movements?.__terrainHazards, startedAt, bot.entity?.position, target, options)) {
      logMove(context, `[HAZARD_PATH_FALLBACK] target=${formatMovePos(target)} hazards=${movements.__terrainHazards.length} reason=no_route_while_avoiding`)
      configureMovements(bot, { ...options, destination: target, avoidKnownHazards: false }, context)
      bot.pathfinder.setGoal(goal)
      reached = await waitForGoal(bot, target, range, timeoutMs, options.shouldContinue, waitOptions)
    }

    if (reached === 'aborted') {
      stopMovePathfinder(bot, scaffoldActivity.active)
      await scaffoldActivity.waitForIdle()
      return fail('task_interrupted')
    }
    if (!reached) {
      stopMovePathfinder(bot, scaffoldActivity.active)
      await scaffoldActivity.waitForIdle()
      return fail('move_timeout')
    }

    if (reached === 'condition' || scaffoldActivity.active) {
      // A reachedWhen predicate is commonly a narrow interaction-range
      // boundary. pathfinder.stop() is lazy and can leave both the old goal
      // and movement controls active until a later physics tick, allowing the
      // bot to drift back out of range before the caller verifies the state.
      // Quiesce synchronously for condition-based completion just as we do
      // for a controlled scaffold transaction.
      stopMovePathfinder(bot, reached === 'condition' || scaffoldActivity.active)
    }
    if (scaffoldActivity.active) {
      // Position polling can become true while pathfinder is still completing
      // its final async scaffold equip/place. Stop the goal and wait until
      // that transaction is quiescent before the building action equips the
      // formal material.
      const settled = await scaffoldActivity.waitForIdle()
      if (!settled) return fail('movement_scaffold_not_quiescent')
    }
    return ok(reached === 'condition' ? 'movement_condition_reached' : 'moved', { position: target, range })
  } catch (err) {
    return fail(err.message)
  } finally {
    pathStatus.stop()
    scaffoldActivity.restore()
    stopTrackingScaffolds()
    if (!options.holdLock) releaseActionLocks(context, lock.owner)
  }
}

// Should a failed move be re-planned with the hazard avoidance switched off?
// Only if both halves hold: a remembered pit actually sits between here and
// there, and she never got going — "the planner refused this route" looks like
// standing still, while "the walk was longer than the timeout" looks like
// distance covered, and paying a second full timeout for every long walk would
// be its own regression.
function shouldRetryWithoutHazards(hazards, startedAt, endedAt, target, options = {}) {
  if (!hazards?.length) return false
  const start = normalizePosition(startedAt)
  const end = normalizePosition(endedAt)
  if (!start || !end) return false
  if (distance(start, end) >= Number(options.hazardFallbackMovedThreshold ?? 2)) return false
  return hazardsBlockCorridor(hazards, end, target)
}

function logMove(context, message) {
  if (context?.logger?.log) context.logger.log(message)
  else if (context?.debug) context.debug(message)
}

function formatMovePos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function stopMovePathfinder(bot, synchronizeScaffoldState = false) {
  try {
    bot?.pathfinder?.stop?.()
  } catch {}
  if (
    !synchronizeScaffoldState ||
    typeof bot?.pathfinder?.isBuilding !== 'function'
  ) return

  // mineflayer-pathfinder's stop() is lazy: it only sets stopPathing and the
  // physics loop checks that flag after its placing branch. A queued
  // placingBlock can therefore begin after moveTo's bounded settle window,
  // overlap a fresh controlled route, and place scaffold in a reserved formal
  // target. setGoal(null) invokes resetPath synchronously, clearing placing,
  // placingBlock locks, the path, and controls before we wait for any already
  // started equip/place promise to settle.
  try {
    bot?.pathfinder?.setGoal?.(null)
  } catch {}
  try {
    bot?.clearControlStates?.()
  } catch {}
}

// A failed A* leaves no trace of its own. mineflayer-pathfinder plans, emits
// path_update, sets pathUpdated = true and returns; an empty path then just
// looks like a bot standing still, and moveTo reports move_timeout with
// nothing to say why. Round 14 of the building lane and round 10 of this lane
// were both spent guessing at exactly that silence. Report the planner's own
// verdict, plus the two constraint sets that are the usual reason a route the
// preview found cannot be found again at execution time.
const PATH_STATUS_LOG_WINDOW_MS = 5000
const PATH_STATUS_REPORTED = new Map()

function trackMovePathStatus(bot, context, target, options = {}) {
  if (typeof bot?.on !== 'function') {
    return { bindMovements() {}, stop() {} }
  }
  const clock = typeof options.pathStatusClock === 'function' ? options.pathStatusClock : Date.now
  const goal = formatMovePos(target)
  let movements = null

  const onPathUpdate = results => {
    const status = results?.status
    if (status !== 'noPath' && status !== 'timeout') return
    const now = Number(clock()) || 0
    for (const [key, at] of PATH_STATUS_REPORTED) {
      if (now - at >= PATH_STATUS_LOG_WINDOW_MS) PATH_STATUS_REPORTED.delete(key)
    }
    const key = `${goal}|${status}`
    const last = PATH_STATUS_REPORTED.get(key)
    if (last != null && now - last < PATH_STATUS_LOG_WINDOW_MS) return
    PATH_STATUS_REPORTED.set(key, now)
    const allowList = movements?.__scaffoldPlacementAllowed?.size ?? 0
    const excl = movements?.__scaffoldPlacementExclusions?.size ?? 0
    const cost = Number.isFinite(results?.cost) ? Number(results.cost).toFixed(1) : 'na'
    logMove(context, `[MOVE_PATH_STATUS] status=${status} goal=${goal} allowList=${allowList} excl=${excl} cost=${cost}`)
  }

  bot.on('path_update', onPathUpdate)
  return {
    bindMovements(next) { movements = next },
    stop() {
      if (typeof bot.removeListener === 'function') bot.removeListener('path_update', onPathUpdate)
      else if (typeof bot.off === 'function') bot.off('path_update', onPathUpdate)
    }
  }
}

function trackMovementScaffoldPlacements(bot, options = {}) {
  if (typeof options.onScaffoldPlaced !== 'function' || typeof bot?.on !== 'function') {
    return () => {}
  }
  const allowedNames = scaffoldItemNameSet(options)
  const onBlockUpdate = (oldBlock, newBlock) => {
    if (!oldBlock?.position || !newBlock?.position) return
    if (!isAirBlockName(oldBlock.name) || isAirBlockName(newBlock.name)) return
    if (!allowedNames.has(newBlock.name)) return
    // An air -> scaffold transition is normally her own placement, but it is
    // also what the server sends when it puts back a block a too-far dig only
    // pretended to remove. Build-20 logged SCAFFOLD_PLACED for 598,69,-18
    // while she stood at 607.5,67,1.3, fourteen blocks away. She cannot place
    // a block she cannot reach, so that transition is the server correcting
    // us, not a placement.
    if (!isWithinPlacementReach(bot, newBlock.position)) return
    options.onScaffoldPlaced({
      x: Math.floor(newBlock.position.x),
      y: Math.floor(newBlock.position.y),
      z: Math.floor(newBlock.position.z)
    }, newBlock.name)
  }
  bot.on('blockUpdate', onBlockUpdate)
  return () => {
    if (typeof bot.removeListener === 'function') bot.removeListener('blockUpdate', onBlockUpdate)
    else if (typeof bot.off === 'function') bot.off('blockUpdate', onBlockUpdate)
  }
}

function isAirBlockName(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

// Same bound mineflayer uses for digging (canDigBlock: eye +1.65, 5.1), with
// slack for the block she is standing on top of while pillaring.
const PLACEMENT_REACH = 6

function isWithinPlacementReach(bot, position) {
  const current = bot?.entity?.position
  if (!current || !position) return true
  const distance = Math.sqrt(
    (Math.floor(position.x) + 0.5 - current.x) ** 2 +
    (Math.floor(position.y) + 0.5 - (current.y + 1.65)) ** 2 +
    (Math.floor(position.z) + 0.5 - current.z) ** 2
  )
  return distance <= PLACEMENT_REACH
}

function trackMovementScaffoldActivity(bot, options = {}) {
  if (typeof options.onScaffoldPlaced !== 'function') {
    return {
      active: false,
      restore() {},
      async waitForIdle() { return true }
    }
  }

  const originalEquip = bot?.equip
  const originalPlaceBlock = bot?.placeBlock
  let pending = 0
  let lastActivityAt = Date.now()
  const wrap = original => function trackedScaffoldOperation(...args) {
    pending += 1
    lastActivityAt = Date.now()
    let result
    try {
      result = original.apply(this, args)
    } catch (err) {
      pending -= 1
      lastActivityAt = Date.now()
      throw err
    }
    return Promise.resolve(result).finally(() => {
      pending -= 1
      lastActivityAt = Date.now()
    })
  }
  const trackedEquip = typeof originalEquip === 'function' ? wrap(originalEquip) : null
  const trackedPlaceBlock = typeof originalPlaceBlock === 'function' ? wrap(originalPlaceBlock) : null
  if (trackedEquip) bot.equip = trackedEquip
  if (trackedPlaceBlock) bot.placeBlock = trackedPlaceBlock

  return {
    active: true,
    restore() {
      if (trackedEquip && bot.equip === trackedEquip) bot.equip = originalEquip
      if (trackedPlaceBlock && bot.placeBlock === trackedPlaceBlock) bot.placeBlock = originalPlaceBlock
    },
    async waitForIdle() {
      const timeoutMs = Math.max(500, Number(options.scaffoldSettleTimeoutMs ?? 8000))
      const quietMs = Math.max(50, Number(options.scaffoldSettleQuietMs ?? 200))
      // stop() can race a pathfinder placement that has already been queued
      // but has not called bot.placeBlock yet. In that window pending is zero
      // and lastActivityAt may be old, so the previous check could return
      // immediately and let the formal build placement overlap the queued
      // scaffold. Keep the tracker installed for a bounded post-stop grace
      // period, then require the usual quiet window.
      const postStopGraceMs = Math.max(0, Number(options.scaffoldPostStopGraceMs ?? 750))
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const now = Date.now()
        if (
          pending === 0 &&
          now - startedAt >= postStopGraceMs &&
          now - lastActivityAt >= quietMs
        ) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return pending === 0
    }
  }
}

function followEntity(context, entity, options = {}) {
  const bot = context?.bot
  if (!bot?.entity) return fail('missing_bot')
  if (!bot.pathfinder) return fail('missing_pathfinder')
  if (!entity?.position) return fail('missing_entity')
  if (entity.username && entity.username === bot.username) return fail('cannot_follow_self')

  const lock = acquireActionLocks(context, ['movement'], 'followEntity', {
    lockTimeoutMs: options.lockTimeoutMs ?? 30000,
    ...options
  })
  if (!lock.ok) return fail(lock.error, lock)

  try {
    configureMovements(bot, { ...options, destination: entity.position }, context)
    const range = options.range ?? 2
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
    return ok('following', { entityId: entity.id ?? null, name: entity.name || entity.username || null, range })
  } catch (err) {
    releaseActionLocks(context, lock.owner)
    return fail(err.message)
  } finally {
    if (options.holdLock === false) releaseActionLocks(context, lock.owner)
  }
}

function stopMoving(context, options = {}) {
  const bot = context?.bot
  if (!bot?.pathfinder) return fail('missing_pathfinder')

  try {
    stopMovement(bot, options.reason || 'stopMoving', options.taskId ?? options.owner)
    if (options.owner) releaseActionLocks(context, options.owner)
    return ok('stopped_moving')
  } catch (err) {
    return fail(err.message)
  }
}

function startMoveNear(bot, position, range = 1) {
  configureMovements(bot)
  bot.pathfinder.setGoal(new goals.GoalNear(position.x, position.y, position.z, range))
}

function startFollow(bot, entity, range = 2) {
  configureMovements(bot)
  bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
}

function stopMovement(bot, reason = 'stop', taskId = null) {
  if (!bot?.pathfinder) return
  try {
    if (typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch {}
  try {
    bot.pathfinder.stop?.()
  } catch {}
  try {
    bot.clearControlStates?.()
  } catch {}
  console.log(`[PATHFINDER_GOAL_CLEAR] reason=${reason} taskId=${taskId ?? 'none'}`)
  console.log(`[BOT_CONTROL_CLEAR] reason=${reason} taskId=${taskId ?? 'none'}`)
}

function isNear(bot, position, range = 1) {
  if (!bot.entity?.position || !position) return false
  return distance(bot.entity.position, position) <= range
}

function isNearGoal(bot, position, range = 1, ignoreY = false) {
  if (!ignoreY) return isNear(bot, position, range)
  if (!bot.entity?.position || !position) return false
  const dx = bot.entity.position.x - position.x
  const dz = bot.entity.position.z - position.z
  return Math.sqrt(dx * dx + dz * dz) <= range
}

async function moveNear(bot, position, range = 1, timeoutMs = 15000) {
  const context = { bot }
  const result = await moveTo(context, position, { range, timeoutMs })
  return result.ok
}

function waitForGoal(bot, target, range, timeoutMs, shouldContinue = null, options = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(checkTimer)
      bot.removeListener?.('goal_reached', onReached)
      resolve(value)
    }
    const stableAtGoal = () =>
      options.requireOnGroundAtGoal !== true || bot.entity?.onGround === true
    const onReached = () => {
      if (options.verifyGoalReachedEvent !== true) {
        finish(true)
        return
      }
      if (stableAtGoal() && typeof options.reachedWhen === 'function' && options.reachedWhen()) {
        finish('condition')
        return
      }
      if (stableAtGoal() && isNearGoal(bot, target, range, options.ignoreY === true)) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const checkTimer = setInterval(() => {
      if (typeof shouldContinue === 'function' && !shouldContinue()) finish('aborted')
      else if (stableAtGoal() && typeof options.reachedWhen === 'function' && options.reachedWhen()) finish('condition')
      else if (stableAtGoal() && isNearGoal(bot, target, range, options.ignoreY === true)) finish(true)
    }, 100)

    if (typeof bot.once === 'function') bot.once('goal_reached', onReached)
    else finish(true)
    if (stableAtGoal() && typeof options.reachedWhen === 'function' && options.reachedWhen()) finish('condition')
    if (stableAtGoal() && isNearGoal(bot, target, range, options.ignoreY === true)) finish(true)
  })
}

module.exports = {
  addReservedBreakExclusions,
  avoidKnownTerrainHazards,
  configureMovements,
  enableDoorTraversal,
  shouldRetryWithoutHazards,
  installOpenableActivationPathReset,
  isScaffoldPathMoveAllowed,
  normalizeDoorPathNodes,
  reclassifyOpenableBlock,
  resolveMovementProfile,
  scaffoldPlacementCell,
  followEntity,
  isNear,
  moveNear,
  moveTo,
  startFollow,
  startMoveNear,
  stopMovement,
  stopMoving
}
