const { MemoryStore, defaultMemoryPath } = require('./memory-store')

const DEFAULT_PLAYER_MEMORY = {
  ownerName: null,
  playerPreferences: {},
  favoriteTasks: [],
  dislikedTasks: [],
  lastKnownPosition: null,
  interactionHistory: []
}

class PlayerMemory {
  constructor(filePath = defaultMemoryPath('player-memory.json'), options = {}) {
    this.store = new MemoryStore(filePath, DEFAULT_PLAYER_MEMORY, options)
    this.store.load()
    this.maxHistory = options.maxHistory || 50
  }

  setOwnerName(ownerName) {
    return this.store.set('ownerName', ownerName)
  }

  setLastKnownPosition(position) {
    return this.store.set('lastKnownPosition', normalizePosition(position))
  }

  setPreference(key, value) {
    return this.store.set(`playerPreferences.${key}`, value)
  }

  addInteraction(entry) {
    const history = this.store.get('interactionHistory', [])
    history.push({
      at: new Date().toISOString(),
      ...entry
    })
    this.store.set('interactionHistory', history.slice(-this.maxHistory))
  }

  summary() {
    return {
      ownerName: this.store.get('ownerName', null),
      preferenceCount: Object.keys(this.store.get('playerPreferences', {})).length,
      favoriteTasks: this.store.get('favoriteTasks', []).length,
      dislikedTasks: this.store.get('dislikedTasks', []).length,
      hasLastKnownPosition: Boolean(this.store.get('lastKnownPosition')),
      interactions: this.store.get('interactionHistory', []).length
    }
  }

  list() {
    return this.store.list()
  }
}

function normalizePosition(position) {
  if (!position) return null
  return {
    x: Math.round(Number(position.x) * 100) / 100,
    y: Math.round(Number(position.y) * 100) / 100,
    z: Math.round(Number(position.z) * 100) / 100
  }
}

module.exports = {
  DEFAULT_PLAYER_MEMORY,
  PlayerMemory
}
