const assert = require('assert')
const { FaithfulCommunityValidator, _test: { isComparableStateKey } } = require('../systems/faithful-community-validator')
const { _test: { isComparablePlacementStateKey } } = require('../systems/building-system')

// Pins the comparable-state-key exclusions in the faithful world comparison
// (the uncommitted half of 64d29e05 "validate and clean resumed blueprint
// construction", archived this round by boss ruling).
//
// Ten of the original exclusions forgive states the GAME computes from
// surroundings or that are importer bookkeeping / runtime container content —
// a placed block can never reproduce them, so comparing them only
// manufactures false FAILs. Exactly ONE exclusion is a real fidelity
// concession: the door HINGE (see the dedicated test below).
//
// Round 10 (#51, boss-approved) ported a second batch — world-derived
// redstone/hopper signal states, redstone-wire neighbour connections, stair
// corner shape, and signal-only `lit` — from resume reconciliation's own
// exclusion list (systems/building-system.js). Both rulers now import that
// list from utils/derived-placement-state-keys; testTwoRulersAgree below
// pins that they answer identically for a shared (block, key) table.
//
// Every exemption test has a reverse twin proving that genuine differences on
// the same or neighbouring block families are still caught — exemption
// without enforcement would pin nothing.

function compareSingleBlock(expectedBlock, actualBlock) {
  const validator = new FaithfulCommunityValidator()
  const result = validator.compareExpectedActual(
    { name: 'state_probe', blocks: [expectedBlock] },
    { name: 'state_probe_actual', blocks: [actualBlock] },
    {},
    {}
  )
  return {
    stateFidelity: result.metrics.blockStateFidelityRatio,
    fidelityRatio: result.metrics.fidelityRatio,
    presentRatio: result.metrics.presentRatio,
    mismatches: result.metrics.sampleMismatches,
    stateFailure: result.failures.includes('block_state_fidelity_below_threshold')
  }
}

function block(type, states, position = { x: 0, y: 64, z: 0 }) {
  return { ...position, type, ...(states ? { states } : {}) }
}

function assertExempt(expected, actual, label) {
  const outcome = compareSingleBlock(expected, actual)
  assert.strictEqual(outcome.stateFidelity, 1, `${label}: expected exemption, got mismatches ${JSON.stringify(outcome.mismatches)}`)
  assert.strictEqual(outcome.mismatches.length, 0, `${label}: mismatch recorded`)
  assert.strictEqual(outcome.stateFailure, false, `${label}: state failure flagged`)
}

function assertCaught(expected, actual, label) {
  const outcome = compareSingleBlock(expected, actual)
  assert.ok(outcome.mismatches.length > 0, `${label}: real difference was NOT caught`)
  assert.ok(
    outcome.stateFailure || outcome.fidelityRatio < 1 || outcome.presentRatio < 1,
    `${label}: no failure signal for a real difference`
  )
}

// ── The ten game-computed / bookkeeping exemptions ───────────────────────────

function testImporterBookkeepingKeysAreExempt() {
  assertExempt(
    block('oak_planks', { legacyId: '5', legacyData: '0', legacyVariant: '0' }),
    block('oak_planks'),
    'legacy bookkeeping keys'
  )
}

function testLeafDistanceIsExempt() {
  // distance is recomputed by the game from the nearest log.
  assertExempt(
    block('oak_leaves', { distance: '1', persistent: 'true' }),
    block('oak_leaves', { distance: '7', persistent: 'true' }),
    'leaf distance'
  )
}

function testLadderAutoStatesAreExempt() {
  assertExempt(
    block('ladder', { facing: 'north', distance: '2', bottom: 'true' }),
    block('ladder', { facing: 'north', distance: '0', bottom: 'false' }),
    'ladder distance/bottom'
  )
}

function testLegacyLanternKeysAreExempt() {
  // signal_fire/lit/facing are not vanilla lantern states; they leak in from
  // legacy campfire conversions.
  assertExempt(
    block('lantern', { signal_fire: 'false', lit: 'true', facing: 'north', hanging: 'false' }),
    block('lantern', { hanging: 'false' }),
    'legacy lantern keys'
  )
}

function testBrewingStandBottlesAreExempt() {
  // Runtime container content, not a placeable state.
  assertExempt(
    block('brewing_stand', { has_bottle_0: 'true', has_bottle_1: 'true', has_bottle_2: 'false' }),
    block('brewing_stand', { has_bottle_0: 'false', has_bottle_1: 'false', has_bottle_2: 'false' }),
    'brewing stand bottles'
  )
}

function testLecternBookIsExempt() {
  assertExempt(
    block('lectern', { facing: 'south', has_book: 'true' }),
    block('lectern', { facing: 'south', has_book: 'false' }),
    'lectern book'
  )
}

function testFenceConnectionsAreExempt() {
  // Connection states are recomputed from neighbours; the blueprint carries
  // the SOURCE context's neighbours, not the build site's.
  assertExempt(
    block('oak_fence', { north: 'true', south: 'false', east: 'true', west: 'false' }),
    block('oak_fence', { north: 'false', south: 'true', east: 'false', west: 'true' }),
    'fence connections'
  )
}

function testWallConnectionsAreExempt() {
  assertExempt(
    block('stone_brick_wall', { north: 'low', south: 'none', east: 'low', west: 'none', up: 'true' }),
    block('stone_brick_wall', { north: 'none', south: 'low', east: 'none', west: 'low', up: 'false' }),
    'wall connections'
  )
}

function testPaneConnectionsAreExempt() {
  assertExempt(
    block('glass_pane', { north: 'true', south: 'true', east: 'false', west: 'false' }),
    block('glass_pane', { north: 'false', south: 'false', east: 'true', west: 'true' }),
    'pane connections'
  )
}

function testIronBarsConnectionsAreExempt() {
  assertExempt(
    block('iron_bars', { north: 'true', south: 'false', east: 'false', west: 'true' }),
    block('iron_bars', { north: 'false', south: 'true', east: 'true', west: 'false' }),
    'iron bars connections'
  )
}

// ── Round 10 (#51, boss-approved): ported from resume reconciliation's
// isComparablePlacementStateKey — states a placement item cannot carry, so
// comparing them here only docks acceptance score for a gap the bot has no
// way to close. Same principle as the ten exemptions above, same source list
// (utils/derived-placement-state-keys), now shared by both rulers. ─────────

function testLiveSignalStatesAreExempt() {
  assertExempt(
    block('repeater', { powered: 'true', locked: 'true', facing: 'north', delay: '1' }),
    block('repeater', { powered: 'false', locked: 'false', facing: 'north', delay: '1' }),
    'live signal states (powered/locked)'
  )
  assertExempt(
    block('piston', { extended: 'true', facing: 'up' }),
    block('piston', { extended: 'false', facing: 'up' }),
    'live signal states (extended)'
  )
  assertExempt(
    block('observer', { triggered: 'true', facing: 'north' }),
    block('observer', { triggered: 'false', facing: 'north' }),
    'live signal states (triggered)'
  )
  assertExempt(
    block('hopper', { enabled: 'true', facing: 'down' }),
    block('hopper', { enabled: 'false', facing: 'down' }),
    'live signal states (enabled)'
  )
  assertExempt(
    block('redstone_wire', { power: '15' }),
    block('redstone_wire', { power: '0' }),
    'live signal states (power)'
  )
  assertExempt(
    block('note_block', { attached: 'true', instrument: 'bass', note: '0', powered: 'false' }),
    block('note_block', { attached: 'false', instrument: 'bass', note: '0', powered: 'false' }),
    'live signal states (attached)'
  )
}

function testRedstoneWireConnectionsAreExempt() {
  // Neighbour-derived, same reasoning as fence/wall/pane/iron_bars above.
  assertExempt(
    block('redstone_wire', { north: 'side', south: 'none', east: 'up', west: 'none', power: '0' }),
    block('redstone_wire', { north: 'none', south: 'side', east: 'none', west: 'up', power: '0' }),
    'redstone wire connections'
  )
}

function testStairShapeIsExempt() {
  // Corner shape is derived from neighbouring stairs, not the placement.
  assertExempt(
    block('oak_stairs', { facing: 'north', half: 'bottom', shape: 'inner_left' }),
    block('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' }),
    'stair shape'
  )
}

function testSignalLitIsExempt() {
  assertExempt(
    block('redstone_torch', { lit: 'true' }),
    block('redstone_torch', { lit: 'false' }),
    'redstone torch lit'
  )
  assertExempt(
    block('redstone_wall_torch', { lit: 'true', facing: 'north' }),
    block('redstone_wall_torch', { lit: 'false', facing: 'north' }),
    'redstone wall torch lit'
  )
  assertExempt(
    block('redstone_lamp', { lit: 'true' }),
    block('redstone_lamp', { lit: 'false' }),
    'redstone lamp lit'
  )
  assertExempt(
    block('furnace', { lit: 'true', facing: 'north' }),
    block('furnace', { lit: 'false', facing: 'north' }),
    'furnace lit'
  )
}

// ── The ONE real fidelity concession: door hinge ─────────────────────────────
// When a door is placed, the game derives the hinge side from the click
// position and neighbouring blocks; the bot cannot reliably control it, and a
// mirrored hinge would otherwise fail every legacy-import door forever. This
// is a DELIBERATE, boss-approved concession (round-5 ruling, option A): in
// the worst case a door opens mirrored relative to the source build. Facing,
// half, and open state on the SAME door stay strictly enforced — see
// testDoorFacingStillEnforced below.
function testDoorHingeConcessionIsExplicit() {
  assertExempt(
    block('oak_door', { half: 'lower', facing: 'south', hinge: 'left', open: 'false' }),
    block('oak_door', { half: 'lower', facing: 'south', hinge: 'right', open: 'false' }),
    'door hinge (deliberate concession)'
  )
}

// ── Reverse twins: genuine differences are still caught ──────────────────────

function testStairFacingStillEnforced() {
  assertCaught(
    block('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' }),
    block('oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' }),
    'stair facing'
  )
}

function testDoorFacingStillEnforced() {
  // The door exclusion is hinge-only: a door facing the wrong way fails.
  assertCaught(
    block('oak_door', { half: 'lower', facing: 'south', hinge: 'left', open: 'false' }),
    block('oak_door', { half: 'lower', facing: 'east', hinge: 'left', open: 'false' }),
    'door facing'
  )
}

function testFenceGateFacingStillEnforced() {
  // Gates are NOT in the dynamic-connection family; their facing is enforced.
  assertCaught(
    block('oak_fence_gate', { facing: 'north', open: 'false' }),
    block('oak_fence_gate', { facing: 'east', open: 'false' }),
    'fence gate facing'
  )
}

function testLanternHangingStillEnforced() {
  // The lantern exclusion covers only the legacy junk keys; hanging is real.
  assertCaught(
    block('lantern', { hanging: 'true' }),
    block('lantern', { hanging: 'false' }),
    'lantern hanging'
  )
}

function testSlabTypeStillEnforced() {
  assertCaught(
    block('stone_slab', { type: 'bottom' }),
    block('stone_slab', { type: 'top' }),
    'slab half'
  )
}

function testLogAxisStillEnforced() {
  assertCaught(
    block('oak_log', { axis: 'y' }),
    block('oak_log', { axis: 'x' }),
    'log axis'
  )
}

function testWrongBlockTypeStillEnforced() {
  assertCaught(
    block('oak_planks'),
    block('stone'),
    'wrong block type'
  )
}

function testMissingBlockStillEnforced() {
  assertCaught(
    block('oak_planks'),
    block('air'),
    'missing block'
  )
}

// ── Round 10 (#51): reachable states stay enforced, not relaxed ─────────────

function testRepeaterDelayStillEnforced() {
  // Reachable with a post-place right-click (delay-1 activations) — the
  // deliberately-not-relaxed case that keeps the gap visible until the bot
  // actually does that.
  assertCaught(
    block('repeater', { facing: 'north', delay: '2', powered: 'false', locked: 'false' }),
    block('repeater', { facing: 'north', delay: '1', powered: 'false', locked: 'false' }),
    'repeater delay'
  )
}

function testComparatorModeStillEnforced() {
  assertCaught(
    block('comparator', { facing: 'north', mode: 'subtract', powered: 'false' }),
    block('comparator', { facing: 'north', mode: 'compare', powered: 'false' }),
    'comparator mode'
  )
}

function testOpenStateStillEnforced() {
  // `open` has its own post-place align action, so it stays a real gap.
  assertCaught(
    block('oak_door', { half: 'lower', facing: 'south', hinge: 'left', open: 'true' }),
    block('oak_door', { half: 'lower', facing: 'south', hinge: 'left', open: 'false' }),
    'door open'
  )
}

function testCampfireLitStillEnforced() {
  // isSignalLitBlockName does NOT cover campfire — it is placeable, not
  // signal-derived, so it must stay enforced (unlike redstone_torch/lamp/furnace family).
  assertCaught(
    block('campfire', { lit: 'true', signal_fire: 'false', facing: 'north' }),
    block('campfire', { lit: 'false', signal_fire: 'false', facing: 'north' }),
    'campfire lit'
  )
}

// ── Round 10 (#51): the two rulers must agree on the same (block, key) ──────
// isComparableStateKey (faithful/acceptance) and isComparablePlacementStateKey
// (resume reconciliation) now share utils/derived-placement-state-keys; this
// pins that they answer identically across every key this suite exercises,
// on top of the pre-existing exclusions both already carried before round 10.

// Discovered by the round-10 parity probe, NOT part of #51: resume
// reconciliation has excluded `waterlogged` unconditionally since before
// round 9 (systems/building-system.js isComparablePlacementStateKey, first
// line); the faithful validator never has. This asymmetry is real but
// out of scope here — #51 only authorized the four exclusions above. Pinned
// so a future change to either side is a deliberate, visible decision, not a
// silent drift.
function testWaterloggedRulerAsymmetryIsKnown() {
  assert.strictEqual(isComparableStateKey('stone_brick_slab', 'waterlogged'), true, 'faithful still compares waterlogged (unexcluded)')
  assert.strictEqual(isComparablePlacementStateKey('stone_brick_slab', 'waterlogged', 'false'), false, 'reconcile still excludes waterlogged')
}

function testTwoRulersAgree() {
  const cases = [
    ['oak_planks', 'legacyId'],
    ['oak_leaves', 'distance'],
    ['ladder', 'distance'],
    ['ladder', 'bottom'],
    ['ladder', 'facing'],
    ['oak_door', 'hinge'],
    ['oak_door', 'facing'],
    ['oak_door', 'open'],
    ['brewing_stand', 'has_bottle_0'],
    ['lectern', 'has_book'],
    ['oak_fence', 'north'],
    ['oak_fence_gate', 'facing'],
    ['stone_brick_wall', 'north'],
    ['glass_pane', 'east'],
    ['iron_bars', 'west'],
    ['oak_stairs', 'shape'],
    ['oak_stairs', 'facing'],
    ['redstone_wire', 'north'],
    ['redstone_wire', 'power'],
    ['repeater', 'powered'],
    ['repeater', 'delay'],
    ['repeater', 'locked'],
    ['comparator', 'mode'],
    ['piston', 'extended'],
    ['observer', 'triggered'],
    ['hopper', 'enabled'],
    ['note_block', 'attached'],
    ['redstone_torch', 'lit'],
    ['redstone_wall_torch', 'lit'],
    ['redstone_lamp', 'lit'],
    ['furnace', 'lit'],
    ['smoker', 'lit'],
    ['blast_furnace', 'lit'],
    ['campfire', 'lit'],
    ['stone_slab', 'type'],
    ['oak_log', 'axis']
  ]
  for (const [blockName, key] of cases) {
    const faithful = isComparableStateKey(blockName, key)
    const reconcile = isComparablePlacementStateKey(blockName, key, 'probe_value')
    assert.strictEqual(
      faithful,
      reconcile,
      `ruler disagreement on (${blockName}, ${key}): faithful=${faithful} reconcile=${reconcile}`
    )
  }
}

function run() {
  testImporterBookkeepingKeysAreExempt()
  testLeafDistanceIsExempt()
  testLadderAutoStatesAreExempt()
  testLegacyLanternKeysAreExempt()
  testBrewingStandBottlesAreExempt()
  testLecternBookIsExempt()
  testFenceConnectionsAreExempt()
  testWallConnectionsAreExempt()
  testPaneConnectionsAreExempt()
  testIronBarsConnectionsAreExempt()
  testDoorHingeConcessionIsExplicit()
  testLiveSignalStatesAreExempt()
  testRedstoneWireConnectionsAreExempt()
  testStairShapeIsExempt()
  testSignalLitIsExempt()
  testStairFacingStillEnforced()
  testDoorFacingStillEnforced()
  testFenceGateFacingStillEnforced()
  testLanternHangingStillEnforced()
  testSlabTypeStillEnforced()
  testLogAxisStillEnforced()
  testWrongBlockTypeStillEnforced()
  testMissingBlockStillEnforced()
  testRepeaterDelayStillEnforced()
  testComparatorModeStillEnforced()
  testOpenStateStillEnforced()
  testCampfireLitStillEnforced()
  testWaterloggedRulerAsymmetryIsKnown()
  testTwoRulersAgree()
  console.log('faithful state comparison tests passed')
}

run()
