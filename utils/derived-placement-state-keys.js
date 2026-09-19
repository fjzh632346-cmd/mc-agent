'use strict'

// States a placement item cannot carry: the world derives them at runtime
// (redstone circuitry, neighbour-derived connections/shapes) or a follow-up
// interaction sets them after the block is already down. Round 9
// (systems/building-system.js, isComparablePlacementStateKey) found this list
// so resume reconciliation stops burning functional blocks re-placing a block
// that was already correct. Round 10 (#51, boss-approved) ported the same
// list into the faithful-world validator (systems/faithful-community-validator.js,
// isComparableStateKey) so the acceptance score stops docking points for the
// same unreachable states. Both callers import this module instead of keeping
// their own copy, so the two rulers cannot silently drift apart again.
//
// Deliberately NOT here: `delay` (repeater), `mode` (comparator), `inverted`
// (daylight detector), `open` (door/trapdoor/fence gate — actions/build.js
// aligns it with a post-place activateBlock). Those are real, reachable
// fidelity gaps and both rulers must keep comparing them.

const LIVE_SIGNAL_STATE_KEYS = new Set([
  'attached',
  'enabled',
  'extended',
  'locked',
  'power',
  'powered',
  'triggered'
])

function isRedstoneWireConnectionKey(blockName, key) {
  return String(blockName || '') === 'redstone_wire' &&
    ['north', 'south', 'east', 'west'].includes(key)
}

function isStairsShapeKey(blockName, key) {
  return /_stairs$/.test(String(blockName || '')) && key === 'shape'
}

// `lit` is placeable on a campfire or lantern but signal/process derived on
// these, so only these lose the comparison.
function isSignalLitBlockName(blockName) {
  const name = String(blockName || '')
  return name === 'redstone_torch' ||
    name === 'redstone_wall_torch' ||
    name === 'redstone_lamp' ||
    name === 'furnace' ||
    name === 'smoker' ||
    name === 'blast_furnace'
}

module.exports = {
  LIVE_SIGNAL_STATE_KEYS,
  isRedstoneWireConnectionKey,
  isStairsShapeKey,
  isSignalLitBlockName
}
