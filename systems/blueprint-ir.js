const { itemNameForBlock } = require('../utils/building-material-map')

const BLUEPRINT_IR_SCHEMA_VERSION = 1

const BLUEPRINT_PHASES = Object.freeze([
  'site_prepare',
  'foundation',
  'frame',
  'floor',
  'wall',
  'stairs',
  'roof',
  'doors_windows',
  'functional_blocks',
  'interior',
  'exterior_detail',
  'cleanup'
])

const CLEARANCE_POLICIES = Object.freeze([
  'preserve',
  'must_air',
  'clear_replaceable',
  'clear_any'
])

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])

function createDiagnostic(severity, code, path, message, details = null) {
  return {
    severity,
    code,
    path,
    message,
    details
  }
}

function calculateBlueprintBounds(blocks = []) {
  if (!blocks.length) {
    return {
      min: { x: 0, y: 0, z: 0 },
      max: { x: -1, y: -1, z: -1 },
      size: { x: 0, y: 0, z: 0 }
    }
  }

  const first = blocks[0].position || blocks[0]
  const bounds = blocks.reduce((acc, block) => {
    const position = block.position || block
    return {
      minX: Math.min(acc.minX, position.x),
      maxX: Math.max(acc.maxX, position.x),
      minY: Math.min(acc.minY, position.y),
      maxY: Math.max(acc.maxY, position.y),
      minZ: Math.min(acc.minZ, position.z),
      maxZ: Math.max(acc.maxZ, position.z)
    }
  }, {
    minX: first.x,
    maxX: first.x,
    minY: first.y,
    maxY: first.y,
    minZ: first.z,
    maxZ: first.z
  })

  return {
    min: { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
    max: { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ },
    size: {
      x: bounds.maxX - bounds.minX + 1,
      y: bounds.maxY - bounds.minY + 1,
      z: bounds.maxZ - bounds.minZ + 1
    }
  }
}

function normalizePhase(rawPhase, role = null, blockId = null) {
  const value = String(rawPhase || '').trim().toLowerCase()
  if (BLUEPRINT_PHASES.includes(value)) return value

  if ([
    'clear',
    'clear_obstruction',
    'site',
    'site_scan',
    'scaffold',
    'scaffold_place'
  ].includes(value)) return 'site_prepare'
  if (['base', 'foundation_fill'].includes(value)) return 'foundation'
  if (['second_floor', 'flooring'].includes(value)) return 'floor'
  if (['window', 'windows', 'door', 'doors', 'doorway'].includes(value)) return 'doors_windows'
  if (['garden', 'basin', 'basin_water', 'water_feature', 'battlement', 'detail', 'decor', 'path'].includes(value)) {
    return 'exterior_detail'
  }
  if (['tower', 'pillar', 'body'].includes(value)) return 'frame'

  const text = `${role || ''} ${blockId || ''}`.toLowerCase()
  if (/stairs|ladder|stairwell/.test(text)) return 'stairs'
  if (/door|window|glass/.test(text)) return 'doors_windows'
  if (/bed|chest|furnace|smoker|blast_furnace|crafting_table/.test(text)) return 'functional_blocks'
  if (/interior|furniture|room|kitchen|bedroom|living/.test(text)) return 'interior'
  if (/roof/.test(text)) return 'roof'
  if (/floor/.test(text)) return 'floor'
  if (/wall|partition/.test(text)) return 'wall'

  return 'frame'
}

function normalizeClearancePolicy(value, blockId = null) {
  if (CLEARANCE_POLICIES.includes(value)) return value
  return AIR_BLOCKS.has(blockId) ? 'clear_any' : 'clear_replaceable'
}

function normalizeMaterialAlternatives(value, blockId) {
  if (AIR_BLOCKS.has(blockId)) return []
  const raw = Array.isArray(value) ? value : []
  const alternatives = []
  for (const entry of raw) {
    const id = typeof entry === 'string'
      ? entry
      : entry?.id || entry?.blockId || entry?.itemName || entry?.item
    if (!id || alternatives.includes(id)) continue
    alternatives.push(String(id))
  }
  const preferred = itemNameForBlock(blockId) || blockId
  if (preferred && !alternatives.includes(preferred)) alternatives.unshift(preferred)
  return alternatives
}

function normalizePoint(point, fallback = null) {
  if (!point) return fallback
  const x = Number(point.x)
  const y = Number(point.y)
  const z = Number(point.z)
  if (![x, y, z].every(Number.isFinite)) return fallback
  return {
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z)
  }
}

function positionKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function sanitizeMetadata(metadata = {}, extra = {}) {
  const copy = clonePlainObject(metadata) || {}
  delete copy.origin
  delete copy.worldOrigin
  delete copy.rotation
  delete copy.mirror
  delete copy.placement
  return {
    ...copy,
    ...extra
  }
}

function clonePlainObject(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return Object.freeze(value)
}

function isAirBlockId(blockId) {
  return AIR_BLOCKS.has(blockId)
}

module.exports = {
  AIR_BLOCKS,
  BLUEPRINT_IR_SCHEMA_VERSION,
  BLUEPRINT_PHASES,
  CLEARANCE_POLICIES,
  calculateBlueprintBounds,
  clonePlainObject,
  createDiagnostic,
  deepFreeze,
  isAirBlockId,
  normalizeClearancePolicy,
  normalizeMaterialAlternatives,
  normalizePhase,
  normalizePoint,
  positionKey,
  sanitizeMetadata
}
