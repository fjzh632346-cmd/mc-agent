const { MemoryStore, defaultMemoryPath } = require('./memory-store')

const DEFAULT_WORLD_MEMORY = {
  baseLocation: null,
  mineLocations: [],
  dangerZones: [],
  chestLocations: [],
  farmLocations: [],
  exploredAreas: [],
  discoveredPlaces: [],
  builtStructures: [],
  importantPlaces: []
}

class WorldMemory {
  constructor(filePath = defaultMemoryPath('world-memory.json'), options = {}) {
    this.store = new MemoryStore(filePath, DEFAULT_WORLD_MEMORY, options)
    this.store.load()
  }

  get baseLocation() {
    return this.store.get('baseLocation', null)
  }

  setBaseLocation(position, metadata = {}) {
    return this.store.set('baseLocation', createPlaceRecord('base', position, {
      name: metadata.name || '基地',
      description: metadata.description || '玩家标记的基地位置',
      ...metadata
    }))
  }

  addMineLocation(position, metadata = {}) {
    const existing = this.findPlaceAt('mineLocations', position, metadata.mergeDistance || 8)
    if (existing) return this.updatePlace('mineLocations', existing, metadata)
    return this.addPlace('mineLocations', 'mine', position, {
      name: metadata.name || '矿区',
      description: metadata.description || '玩家标记的矿区位置',
      ...metadata
    })
  }

  addDangerZone(position, metadata = {}) {
    const existing = this.findPlaceAt('dangerZones', position, metadata.mergeDistance || 8)
    if (existing) return this.updatePlace('dangerZones', existing, metadata)
    return this.addPlace('dangerZones', 'danger', position, {
      name: metadata.name || '危险区域',
      description: metadata.description || '玩家标记的危险区域',
      ...metadata
    })
  }

  addChestLocation(position, metadata = {}) {
    const normalized = normalizePosition(position)
    const existing = this.findChestAt(normalized)
    if (existing) {
      const list = this.store.get('chestLocations', [])
      const updated = {
        ...existing,
        ...metadata,
        position: existing.position,
        updatedAt: new Date().toISOString(),
        lastUsedAt: metadata.lastUsedAt || new Date().toISOString(),
        tags: unique([...(existing.tags || []), ...((metadata.tags || ['storage']))])
      }
      this.store.set('chestLocations', list.map(item => item.id === existing.id ? updated : item))
      return updated
    }

    return this.addPlace('chestLocations', 'chest', normalized, {
      name: metadata.name || '箱子区',
      description: metadata.description || '玩家标记的箱子位置',
      type: metadata.type || 'single_chest',
      tags: metadata.tags || ['storage'],
      lastUsedAt: metadata.lastUsedAt || new Date().toISOString(),
      ...metadata
    })
  }

  findChestAt(position, maxDistance = 1.5) {
    const target = normalizePosition(position)
    if (!target) return null
    return this.store.get('chestLocations', []).find(record => distance(record.position, target) <= maxDistance) || null
  }

  nearestChest(position) {
    const target = normalizePosition(position)
    const chests = this.store.get('chestLocations', [])
    if (!target || chests.length === 0) return null
    return [...chests].sort((a, b) => distance(a.position, target) - distance(b.position, target))[0] || null
  }

  chestLocations() {
    return this.store.get('chestLocations', [])
  }

  removeChestAt(position, maxDistance = 1.5) {
    const target = normalizePosition(position)
    if (!target) return 0
    const list = this.store.get('chestLocations', [])
    const kept = list.filter(record => distance(record.position, target) > maxDistance)
    const removed = list.length - kept.length
    if (removed > 0) this.store.set('chestLocations', kept)
    return removed
  }

  addFarmLocation(position, metadata = {}) {
    const normalized = normalizePosition(position)
    const existing = this.findFarmAt(normalized, metadata.radius || 6)
    const now = new Date().toISOString()

    try {
      if (existing) {
        const list = this.store.get('farmLocations', [])
        const updated = {
          ...existing,
          ...metadata,
          position: existing.position,
          type: metadata.type || existing.type || 'wheat_farm',
          radius: metadata.radius || existing.radius || 6,
          updatedAt: now,
          lastUsedAt: metadata.lastUsedAt || now,
          tags: unique([...(existing.tags || []), ...((metadata.tags || ['food']))])
        }
        this.store.set('farmLocations', list.map(item => item.id === existing.id ? updated : item))
        return updated
      }

      return this.addPlace('farmLocations', 'farm', normalized, {
        name: metadata.name || 'base_farm',
        description: metadata.description || 'player marked wheat farm location',
        type: metadata.type || 'wheat_farm',
        radius: metadata.radius || 6,
        tags: metadata.tags || ['food'],
        lastUsedAt: metadata.lastUsedAt || now,
        ...metadata
      })
    } catch (err) {
      this.store.logger?.warn?.(`[WorldMemory] Failed to write farm location: ${err.message}`)
      return null
    }
  }

  findFarmAt(position, maxDistance = 6) {
    const target = normalizePosition(position)
    if (!target) return null
    return this.store.get('farmLocations', []).find(record => {
      const radius = Math.max(maxDistance, Number(record.radius) || 6)
      return distance(record.position, target) <= radius
    }) || null
  }

  nearestFarm(position, options = {}) {
    const target = normalizePosition(position)
    const farms = this.store.get('farmLocations', [])
    if (!target || farms.length === 0) return null

    const filtered = options.tags?.length
      ? farms.filter(farm => options.tags.some(tag => (farm.tags || []).includes(tag)))
      : farms

    return [...filtered].sort((a, b) => distance(a.position, target) - distance(b.position, target))[0] || null
  }

  baseFarm() {
    const farms = this.store.get('farmLocations', [])
    return farms.find(farm => (farm.tags || []).includes('base') || farm.name === 'base_farm') || null
  }

  farmLocations() {
    return this.store.get('farmLocations', [])
  }

  addBuiltStructure(metadata = {}) {
    const list = this.store.get('builtStructures', [])
    const now = new Date().toISOString()
    const record = {
      id: metadata.id || `built-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: metadata.type || 'built_structure',
      blueprintName: metadata.blueprintName || 'unknown',
      origin: normalizePosition(metadata.origin),
      completedAt: metadata.completedAt || now,
      blockCount: metadata.blockCount || 0,
      createdAt: now,
      source: metadata.source || 'build_task'
    }
    list.push(record)
    this.store.set('builtStructures', list)
    return record
  }

  addImportantPlace(position, metadata = {}) {
    const existing = this.findPlaceAt('importantPlaces', position, metadata.mergeDistance || 8)
    if (existing) return this.updatePlace('importantPlaces', existing, metadata)
    return this.addPlace('importantPlaces', metadata.type || 'place', position, metadata)
  }

  addDiscoveredPlace(position, metadata = {}) {
    const existing = this.findPlaceAt('discoveredPlaces', position, metadata.mergeDistance || 8)
    const record = existing
      ? this.updatePlace('discoveredPlaces', existing, metadata)
      : this.addPlace('discoveredPlaces', metadata.type || 'place', position, {
        tags: metadata.tags || ['exploration'],
        ...metadata,
        source: metadata.source || 'exploration_system'
      })

    if (record) {
      const important = this.findPlaceAt('importantPlaces', position, metadata.mergeDistance || 8)
      if (important) this.updatePlace('importantPlaces', important, metadata)
      else this.addPlace('importantPlaces', metadata.type || 'place', position, metadata)
    }
    return record
  }

  addExploredArea(center, metadata = {}) {
    const normalized = normalizePosition(center)
    const existing = this.findExploredAreaAt(normalized, metadata.radius || 32)
    const now = new Date().toISOString()

    try {
      if (existing) {
        const list = this.store.get('exploredAreas', [])
        const updated = {
          ...existing,
          ...metadata,
          center: existing.center,
          radius: metadata.radius || existing.radius || 32,
          updatedAt: now,
          notes: unique([...(existing.notes || []), ...((metadata.notes || []))])
        }
        this.store.set('exploredAreas', list.map(item => item.id === existing.id ? updated : item))
        return updated
      }

      const record = {
        id: metadata.id || `explore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        center: normalized,
        radius: metadata.radius || 32,
        biome: metadata.biome || null,
        notes: metadata.notes || [],
        createdAt: metadata.createdAt || now,
        updatedAt: now,
        source: metadata.source || 'exploration_system'
      }
      const list = this.store.get('exploredAreas', [])
      list.push(record)
      this.store.set('exploredAreas', list)
      return record
    } catch (err) {
      this.store.logger?.warn?.(`[WorldMemory] Failed to write explored area: ${err.message}`)
      return null
    }
  }

  findExploredAreaAt(center, radius = 32) {
    const target = normalizePosition(center)
    if (!target) return null
    return this.store.get('exploredAreas', []).find(record => {
      const mergeRadius = Math.max(radius, Number(record.radius) || 32)
      return distance(record.center, target) <= mergeRadius
    }) || null
  }

  exploredAreas() {
    return this.store.get('exploredAreas', [])
  }

  discoveredPlaces() {
    return this.store.get('discoveredPlaces', [])
  }

  addPlace(key, type, position, metadata = {}) {
    try {
      const list = this.store.get(key, [])
      const record = createPlaceRecord(type, position, metadata)
      list.push(record)
      this.store.set(key, list)
      return record
    } catch (err) {
      this.store.logger?.warn?.(`[WorldMemory] Failed to write ${key}: ${err.message}`)
      return null
    }
  }

  findPlaceAt(key, position, maxDistance = 8) {
    const target = normalizePosition(position)
    if (!target) return null
    return this.store.get(key, []).find(record => distance(record.position, target) <= maxDistance) || null
  }

  updatePlace(key, existing, metadata = {}) {
    try {
      const list = this.store.get(key, [])
      const updated = {
        ...existing,
        ...metadata,
        position: existing.position,
        updatedAt: new Date().toISOString(),
        tags: unique([...(existing.tags || []), ...((metadata.tags || []))]),
        notes: unique([...(existing.notes || []), ...((metadata.notes || []))])
      }
      this.store.set(key, list.map(item => item.id === existing.id ? updated : item))
      return updated
    } catch (err) {
      this.store.logger?.warn?.(`[WorldMemory] Failed to update ${key}: ${err.message}`)
      return existing
    }
  }

  summary() {
    return {
      hasBaseLocation: Boolean(this.store.get('baseLocation')),
      mineLocations: this.store.get('mineLocations', []).length,
      dangerZones: this.store.get('dangerZones', []).length,
      chestLocations: this.store.get('chestLocations', []).length,
      farmLocations: this.store.get('farmLocations', []).length,
      exploredAreas: this.store.get('exploredAreas', []).length,
      discoveredPlaces: this.store.get('discoveredPlaces', []).length,
      builtStructures: this.store.get('builtStructures', []).length,
      importantPlaces: this.store.get('importantPlaces', []).length
    }
  }

  list() {
    return this.store.list()
  }
}

function createPlaceRecord(type, position, metadata = {}) {
  const now = new Date().toISOString()
  return {
    id: metadata.id || `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...metadata,
    type: metadata.type || type,
    position: normalizePosition(position),
    name: metadata.name || type,
    description: metadata.description || '',
    createdAt: metadata.createdAt || now,
    updatedAt: now,
    source: metadata.source || 'player_command'
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

function distance(a, b) {
  if (!a || !b) return Infinity
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

module.exports = {
  DEFAULT_WORLD_MEMORY,
  WorldMemory,
  createPlaceRecord
}
