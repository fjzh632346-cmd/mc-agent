const LEGACY_SKULL_ID = 144
const LEGACY_WALL_SKULL_FACING = Object.freeze({
  2: 'north',
  3: 'south',
  4: 'west',
  5: 'east'
})

function legacySkullPlacement(blockName, states = null) {
  const expectedName = String(blockName || '')
  const legacyId = Number(states?.legacyId)
  const legacyData = Number(states?.legacyData)
  if (legacyId !== LEGACY_SKULL_ID || !Number.isInteger(legacyData)) return null
  if (expectedName !== 'skeleton_skull' && expectedName !== 'skeleton_wall_skull') return null

  const orientation = legacyData & 0x7
  const facing = LEGACY_WALL_SKULL_FACING[orientation]
  if (facing) {
    return {
      blockName: 'skeleton_wall_skull',
      states: { facing },
      itemName: 'skeleton_skull'
    }
  }

  return {
    blockName: 'skeleton_skull',
    states: { rotation: String((legacyData & 0x8) + ((legacyData & 0x1) * 4)) },
    itemName: 'skeleton_skull'
  }
}

function legacyBlockNameMatches(actualName, expectedName, expectedStates = null) {
  const placement = legacySkullPlacement(expectedName, expectedStates)
  return placement ? String(actualName || '') === placement.blockName : false
}

function legacyBlockStateMismatch(actualStates, expectedName, expectedStates = null) {
  const placement = legacySkullPlacement(expectedName, expectedStates)
  if (!placement) return null
  for (const [key, value] of Object.entries(placement.states)) {
    if (String(actualStates?.[key]) !== String(value)) {
      return `${key}:${actualStates?.[key] ?? 'unknown'}!=${value}`
    }
  }
  return null
}

function modernizeLegacyBlock(blockName, states = null) {
  const placement = legacySkullPlacement(blockName, states)
  if (!placement) return { blockName, states: states || {} }
  return {
    blockName: placement.blockName,
    states: { ...(states || {}), ...placement.states }
  }
}

module.exports = {
  legacyBlockNameMatches,
  legacyBlockStateMismatch,
  legacySkullPlacement,
  modernizeLegacyBlock
}
