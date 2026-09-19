const { Vec3 } = require('vec3')
const { distance } = require('../actions/action-utils')

const DEFAULT_CONFIG = {
  nearbyRadius: 32,
  baseRadius: 64,
  verticalSearchRange: 16,
  maxPathDistance: 80,
  rememberFoundBlocks: true
}

const UTILITY_BLOCK_GROUPS = {
  bed: [
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed',
    'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
    'brown_bed', 'green_bed', 'red_bed', 'black_bed'
  ],
  chest: ['chest', 'trapped_chest', 'barrel'],
  crafting_table: ['crafting_table'],
  furnace: ['furnace', 'blast_furnace', 'smoker'],
  blast_furnace: ['blast_furnace'],
  smoker: ['smoker'],
  campfire: ['campfire', 'soul_campfire'],
  anvil: ['anvil', 'chipped_anvil', 'damaged_anvil']
}

const MEMORY_KEYS = {
  bed: 'beds',
  chest: 'chests',
  crafting_table: 'craftingTables',
  furnace: 'furnaces',
  blast_furnace: 'blastFurnaces',
  smoker: 'smokers',
  campfire: 'campfires',
  anvil: 'anvils'
}

class UtilityBlockSearch {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(options.utilitySearchConfig || options) }
    this.lastUtilitySearch = null
  }

  findNearestBed(context, options = {}) {
    return this.findUtilityBlock(context, 'bed', options)
  }

  findNearestChest(context, options = {}) {
    return this.findUtilityBlock(context, 'chest', options)
  }

  findNearestCraftingTable(context, options = {}) {
    return this.findUtilityBlock(context, 'crafting_table', options)
  }

  findNearestFurnace(context, options = {}) {
    return this.findUtilityBlock(context, 'furnace', options)
  }

  findNearestBlastFurnace(context, options = {}) {
    return this.findUtilityBlock(context, 'blast_furnace', options)
  }

  findNearestSmoker(context, options = {}) {
    return this.findUtilityBlock(context, 'smoker', options)
  }

  findUtilityBlock(context = {}, type, options = {}) {
    const bot = context.bot
    const currentPosition = bot?.entity?.position || context.blackboard?.get?.('bot.position') || null
    const names = UTILITY_BLOCK_GROUPS[type] || [type]
    const config = { ...this.config, ...options }
    const candidates = []

    for (const remembered of this.memoryRecords(context, type)) {
      const block = this.lookupBlock(bot, remembered.position, names)
      if (block) candidates.push({ block, position: normalizePosition(block.position || remembered.position), source: remembered.source || 'memory' })
      else this.forgetInvalidUtilityBlock(context, type, remembered.position)
    }

    for (const block of this.findBlocksNear(context, names, config.nearbyRadius, options.count || 32)) {
      candidates.push({ block, position: normalizePosition(block.position), source: 'nearby' })
    }

    const baseArea = this.getBaseArea(context, config)
    if (baseArea?.center) {
      for (const block of this.findBlocksNear(context, names, config.baseRadius, options.count || 64)) {
        const pos = normalizePosition(block.position)
        if (isInsideArea(pos, baseArea)) candidates.push({ block, position: pos, source: 'baseArea' })
      }
    }

    for (const record of this.builtStructureCandidates(context, type, names, config)) {
      candidates.push(record)
    }

    const unique = uniqueCandidates(candidates)
      .filter(candidate => candidate.position)
      .sort((a, b) => distance(currentPosition, a.position) - distance(currentPosition, b.position))

    const selected = unique[0] || null
    if (selected && config.rememberFoundBlocks) {
      this.rememberUtilityBlock(context, type, selected.position, {
        source: selected.source,
        blockName: selected.block?.name || selected.name || names[0]
      })
    }

    this.lastUtilitySearch = {
      type,
      baseArea,
      found: unique.length,
      selected: selected?.position || null,
      source: selected?.source || null,
      searchedAt: new Date().toISOString()
    }
    const candidatePositions = unique.map(candidate => formatPos(candidate.position)).join('|') || 'none'
    log(context, `[utility-search] type=${type} nearbyRadius=${config.nearbyRadius} baseRadius=${config.baseRadius} rawCandidates=${candidates.length} usableCandidates=${unique.length} found=${unique.length} selected=${selected ? formatPos(selected.position) : 'none'} candidates=${unique.length} positions=${candidatePositions}`)

    if (!selected) return { ok: false, error: 'not_found', type, baseArea, candidates: [] }
    return {
      ok: true,
      type,
      block: selected.block,
      position: selected.position,
      source: selected.source,
      distance: currentPosition ? distance(currentPosition, selected.position) : null,
      baseArea,
      candidates: unique
    }
  }

  rememberUtilityBlock(context = {}, type, position, metadata = {}) {
    const key = MEMORY_KEYS[type] || `${type}s`
    const normalized = normalizePosition(position)
    if (!normalized) return null
    const memory = getKnownUtilityBlocks(context)
    const list = Array.isArray(memory[key]) ? memory[key] : []
    const existingIndex = list.findIndex(record => distance(record.position, normalized) <= 1.5)
    const record = {
      ...(existingIndex >= 0 ? list[existingIndex] : {}),
      position: normalized,
      discoveredAt: existingIndex >= 0 ? list[existingIndex].discoveredAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: metadata.source || 'utility_search',
      blockName: metadata.blockName || type
    }
    const next = existingIndex >= 0
      ? list.map((item, index) => index === existingIndex ? record : item)
      : [...list, record]
    setKnownUtilityBlocks(context, { ...memory, [key]: next })
    return record
  }

  forgetInvalidUtilityBlock(context = {}, type, position) {
    const key = MEMORY_KEYS[type] || `${type}s`
    const target = normalizePosition(position)
    if (!target) return 0
    const memory = getKnownUtilityBlocks(context)
    const list = Array.isArray(memory[key]) ? memory[key] : []
    const next = list.filter(record => distance(record.position, target) > 1.5)
    if (next.length !== list.length) setKnownUtilityBlocks(context, { ...memory, [key]: next })
    return list.length - next.length
  }

  getBaseArea(context = {}, config = this.config) {
    const botPosition = context.bot?.entity?.position || context.blackboard?.get?.('bot.position') || null
    const base = context.memory?.world?.baseLocation?.position ||
      context.memory?.world?.baseLocation ||
      context.memory?.world?.homePosition ||
      context.blackboard?.get?.('basePosition') ||
      context.blackboard?.get?.('homePosition') ||
      botPosition
    const center = normalizePosition(base)
    if (!center) return null
    return {
      center,
      radius: config.baseRadius || DEFAULT_CONFIG.baseRadius,
      minY: center.y - (config.verticalSearchRange || DEFAULT_CONFIG.verticalSearchRange),
      maxY: center.y + (config.verticalSearchRange || DEFAULT_CONFIG.verticalSearchRange)
    }
  }

  getStatus(context = {}) {
    const memory = getKnownUtilityBlocks(context)
    return {
      baseArea: this.getBaseArea(context),
      knownBedCount: (memory.beds || []).length,
      knownChestCount: (memory.chests || []).length,
      knownCraftingTableCount: (memory.craftingTables || []).length,
      knownFurnaceCount: (memory.furnaces || []).length + (memory.blastFurnaces || []).length + (memory.smokers || []).length,
      nearestBed: this.lastUtilitySearch?.type === 'bed' ? this.lastUtilitySearch.selected : null,
      nearestChest: this.lastUtilitySearch?.type === 'chest' ? this.lastUtilitySearch.selected : null,
      nearestCraftingTable: this.lastUtilitySearch?.type === 'crafting_table' ? this.lastUtilitySearch.selected : null,
      nearestFurnace: ['furnace', 'blast_furnace', 'smoker'].includes(this.lastUtilitySearch?.type) ? this.lastUtilitySearch.selected : null,
      lastUtilitySearch: this.lastUtilitySearch
    }
  }

  memoryRecords(context, type) {
    const key = MEMORY_KEYS[type] || `${type}s`
    const memory = getKnownUtilityBlocks(context)
    const generic = type === 'chest' ? (context.memory?.world?.chestLocations?.() || []) : []
    return [...(memory[key] || []), ...generic].filter(record => record?.position)
  }

  findBlocksNear(context, names, radius, count) {
    const bot = context.bot
    const matching = blockIds(bot, names)
    const positions = []
    try {
      if (typeof bot?.findBlocks === 'function' && matching.length) {
        positions.push(...(bot.findBlocks({ matching, maxDistance: radius, count }) || []))
      } else if (typeof bot?.findBlock === 'function' && matching.length) {
        const block = bot.findBlock({ matching, maxDistance: radius })
        if (block?.position) positions.push(block.position)
      }
    } catch {}
    return positions
      .map(position => this.lookupBlock(bot, position, names))
      .filter(Boolean)
  }

  lookupBlock(bot, position, names) {
    const pos = toBlockLookupPosition(position)
    if (!pos) return null
    try {
      const block = bot?.blockAt?.(pos)
      if (block && names.includes(block.name)) return block
    } catch {}
    return null
  }

  builtStructureCandidates(context, type, names, config) {
    const built = context.memory?.world?.list?.().builtStructures || []
    const candidates = []
    for (const structure of built) {
      const origin = normalizePosition(structure.origin || structure.position)
      if (!origin) continue
      const area = {
        center: origin,
        radius: Math.max(12, Number(structure.radius) || 16),
        minY: origin.y - config.verticalSearchRange,
        maxY: origin.y + config.verticalSearchRange
      }
      for (const block of this.findBlocksNear(context, names, Math.max(area.radius, config.nearbyRadius), 32)) {
        const pos = normalizePosition(block.position)
        if (isInsideArea(pos, area)) candidates.push({ block, position: pos, source: 'builtStructures' })
      }
    }
    return candidates
  }
}

function blockIds(bot, names) {
  const registry = bot?.registry?.blocksByName
  if (!registry) return []
  return names.map(name => registry[name]?.id).filter(id => id != null)
}

function getKnownUtilityBlocks(context = {}) {
  const fromStore = context.memory?.world?.store?.get?.('knownUtilityBlocks', null)
  if (fromStore) return fromStore
  return context.blackboard?.get?.('knownUtilityBlocks') || {}
}

function setKnownUtilityBlocks(context = {}, value) {
  if (context.memory?.world?.store?.set) context.memory.world.store.set('knownUtilityBlocks', value)
  else context.blackboard?.set?.('knownUtilityBlocks', value)
}

function isInsideArea(position, area) {
  if (!position || !area?.center) return false
  if (position.y < area.minY || position.y > area.maxY) return false
  return distance(position, area.center) <= area.radius
}

function uniqueCandidates(candidates) {
  const byKey = new Map()
  for (const candidate of candidates) {
    const pos = normalizePosition(candidate.position)
    if (!pos) continue
    const key = `${pos.x},${pos.y},${pos.z}`
    if (!byKey.has(key)) byKey.set(key, { ...candidate, position: pos })
  }
  return [...byKey.values()]
}

function normalizePosition(position) {
  if (!position) return null
  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z))
  }
}

function toBlockLookupPosition(position) {
  const normalized = normalizePosition(position)
  if (!normalized) return null
  return new Vec3(normalized.x, normalized.y, normalized.z)
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function log(context, message) {
  if (context?.logger?.log) context.logger.log(message)
  else if (context?.debug) context.debug(message)
}

module.exports = {
  DEFAULT_CONFIG,
  UTILITY_BLOCK_GROUPS,
  UtilityBlockSearch
}
