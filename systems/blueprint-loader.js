const fs = require('fs')
const path = require('path')
const { itemRequirementsForBlock } = require('../utils/building-material-map')

const DEFAULT_BLUEPRINT_DIR = path.join(process.cwd(), 'blueprints')

const DANGEROUS_BLOCKS = new Set([
  'tnt', 'lava', 'lava_bucket', 'fire', 'campfire', 'soul_campfire',
  'magma_block', 'respawn_anchor'
])

class BlueprintLoader {
  constructor(options = {}) {
    this.blueprintDir = options.blueprintDir || DEFAULT_BLUEPRINT_DIR
  }

  listBlueprints() {
    try {
      if (!fs.existsSync(this.blueprintDir)) return []
      return fs.readdirSync(this.blueprintDir)
        .filter(file => file.endsWith('.json'))
        .map(file => path.basename(file, '.json'))
        .sort()
    } catch {
      return []
    }
  }

  loadBlueprint(name) {
    const safeName = normalizeBlueprintName(name)
    if (!safeName) return { ok: false, error: 'missing_blueprint_name' }

    const filePath = path.join(this.blueprintDir, `${safeName}.json`)
    return this.loadBlueprintFile(filePath, `blueprint_not_found:${safeName}`)
  }

  loadBlueprintFile(filePath, missingError = null) {
    if (!fs.existsSync(filePath)) return { ok: false, error: missingError || `blueprint_file_not_found:${filePath}` }

    try {
      const blueprint = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const validation = this.validateBlueprint(blueprint)
      if (!validation.ok) return validation
      return { ok: true, blueprint }
    } catch (err) {
      return { ok: false, error: `blueprint_parse_failed:${err.message}` }
    }
  }

  validateBlueprint(blueprint) {
    if (!blueprint || typeof blueprint !== 'object') return { ok: false, error: 'invalid_blueprint:not_object' }
    if (!blueprint.name || typeof blueprint.name !== 'string') return { ok: false, error: 'invalid_blueprint:missing_name' }
    if (!Array.isArray(blueprint.blocks) || blueprint.blocks.length === 0) {
      return { ok: false, error: 'invalid_blueprint:missing_blocks' }
    }

    for (const [index, block] of blueprint.blocks.entries()) {
      if (!isFiniteNumber(block.x) || !isFiniteNumber(block.y) || !isFiniteNumber(block.z)) {
        return { ok: false, error: `invalid_blueprint:block_${index}_bad_position` }
      }
      if (!block.type || typeof block.type !== 'string') {
        return { ok: false, error: `invalid_blueprint:block_${index}_missing_type` }
      }
      if (!/^[a-z0-9_]+$/.test(block.type)) {
        return { ok: false, error: `invalid_blueprint:block_${index}_bad_type:${block.type}` }
      }
      if (DANGEROUS_BLOCKS.has(block.type)) {
        return { ok: false, error: `invalid_blueprint:dangerous_block:${block.type}` }
      }
    }

    return { ok: true, blueprint }
  }

  getRequiredMaterials(blueprint) {
    const validation = this.validateBlueprint(blueprint)
    if (!validation.ok) return validation

    const required = {}
    for (const block of blueprint.blocks) {
      if (['air', 'cave_air', 'void_air'].includes(block.type)) continue
      for (const [itemName, count] of Object.entries(itemRequirementsForBlock(block))) {
        required[itemName] = (required[itemName] || 0) + count
      }
    }
    return { ok: true, materials: required, totalBlocks: Object.values(required).reduce((sum, count) => sum + count, 0) }
  }
}

function normalizeBlueprintName(name) {
  const value = String(name || '').trim()
  if (!value || value.includes('..') || value.includes('/') || value.includes('\\')) return null
  return value.replace(/\.json$/i, '')
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

const defaultLoader = new BlueprintLoader()

function loadBlueprint(name) {
  return defaultLoader.loadBlueprint(name)
}

function listBlueprints() {
  return defaultLoader.listBlueprints()
}

function validateBlueprint(blueprint) {
  return defaultLoader.validateBlueprint(blueprint)
}

function getRequiredMaterials(blueprint) {
  return defaultLoader.getRequiredMaterials(blueprint)
}

module.exports = {
  BlueprintLoader,
  DANGEROUS_BLOCKS,
  getRequiredMaterials,
  listBlueprints,
  loadBlueprint,
  validateBlueprint
}
