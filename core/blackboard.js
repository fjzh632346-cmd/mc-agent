class Blackboard {
  constructor(initialState = {}) {
    this.state = {
      bot: {
        position: null,
        health: null,
        food: null,
        onGround: null,
        dimension: null
      },
      player: {
        nearestPlayer: null,
        owner: null,
        ownerPosition: null,
        ownerDistance: null,
        canSeeOwner: false
      },
      world: {
        time: null,
        isDay: null,
        weather: null,
        nearbyBlocks: {},
        droppedItems: []
      },
      mobs: {
        nearbyMobs: [],
        hostileMobs: [],
        passiveMobs: [],
        nearestHostileMob: null,
        dangerLevel: 'none'
      },
      inventory: {
        nearFull: false,
        emptySlots: null,
        heldItem: null,
        foodCount: 0,
        toolCount: 0,
        counts: {}
      },
      tasks: {
        currentTask: null,
        queue: [],
        pausedStack: [],
        locks: null
      },
      events: {
        recent: []
      },
      updatedAt: null
    }
    this.update(initialState)
  }

  get(path, fallback = undefined) {
    if (!path) return this.snapshot()

    const value = path.split('.').reduce((current, part) => {
      if (current == null) return undefined
      return current[part]
    }, this.state)

    return value === undefined ? fallback : value
  }

  set(path, value) {
    const parts = path.split('.')
    let target = this.state

    while (parts.length > 1) {
      const part = parts.shift()
      if (!target[part] || typeof target[part] !== 'object') target[part] = {}
      target = target[part]
    }

    target[parts[0]] = value
    this.state.updatedAt = Date.now()
    return value
  }

  update(partial = {}) {
    this.merge(this.state, partial)
    this.state.updatedAt = Date.now()
    return this.snapshot()
  }

  pushRecentEvent(event, limit = 20) {
    const item = {
      at: Date.now(),
      ...event
    }
    this.state.events.recent.push(item)
    this.state.events.recent = this.state.events.recent.slice(-limit)
    this.state.updatedAt = Date.now()
    return item
  }

  snapshot() {
    return structuredCloneSafe(this.state)
  }

  merge(target, source) {
    if (!source || typeof source !== 'object') return target

    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value)) {
        if (!isPlainObject(target[key])) target[key] = {}
        this.merge(target[key], value)
      } else {
        target[key] = value
      }
    }

    return target
  }
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value))
}

function createBlackboard(initialState) {
  return new Blackboard(initialState)
}

module.exports = {
  Blackboard,
  createBlackboard
}
