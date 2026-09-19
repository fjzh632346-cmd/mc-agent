const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
const REQUIRED_USABLE_ROLES = new Set(['bed', 'chest', 'furnace', 'crafting_table'])

class InteriorUsabilityValidator {
  validate(blueprint, options = {}) {
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return { ok: false, failures: ['invalid_blueprint_for_interior_usability'] }
    }

    const layoutPlan = options.layoutPlan || blueprint.metadata?.functionalLayout || {}
    const interiorPlan = options.interiorPlan || {}
    if (layoutPlan.enabled === false || interiorPlan.enabled === false) {
      return { ok: true, failures: [], usable: [], skipped: [] }
    }

    const blockMap = new Map(blueprint.blocks.map(block => [posKey(block), block]))
    const pathKeys = new Set((layoutPlan.pathCells || []).map(posKey))
    const stairKeys = new Set([
      ...(layoutPlan.stairCells || []).map(posKey),
      ...(layoutPlan.stairs || []).flatMap(stair => (stair.cells || []).map(posKey))
    ])
    const failures = []
    const usable = []

    const placements = interiorPlan.placements || []
    for (const placement of placements) {
      const role = normalizeRole(placement.role, placement.type)
      const key = posKey(placement)
      if (pathKeys.has(key)) failures.push(`furniture_blocks_path:${role}:${key}`)
      if (stairKeys.has(key)) failures.push(`furniture_blocks_stairs:${role}:${key}`)
      if (!isRequiredUsable(role)) continue

      const accessCells = adjacentCells(placement).filter(cell => isStandable(cell, blockMap))
      if (!accessCells.length) failures.push(`furniture_no_use_position:${role}:${key}`)
      else usable.push({ role, position: copyPos(placement), accessCells })
    }

    for (const role of REQUIRED_USABLE_ROLES) {
      if (!placements.some(placement => normalizeRole(placement.role, placement.type) === role)) {
        failures.push(`required_furniture_missing:${role}`)
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      usable,
      skipped: interiorPlan.skipped || []
    }
  }
}

function isStandable(cell, blockMap) {
  const feet = blockMap.get(posKey(cell))?.type || 'air'
  const head = blockMap.get(posKey({ x: cell.x, y: cell.y + 1, z: cell.z }))?.type || 'air'
  const support = blockMap.get(posKey({ x: cell.x, y: cell.y - 1, z: cell.z }))?.type || 'air'
  return isAir(feet) && isAir(head) && !isAir(support)
}

function adjacentCells(position) {
  const base = copyPos(position)
  return [
    { x: base.x + 1, y: base.y, z: base.z },
    { x: base.x - 1, y: base.y, z: base.z },
    { x: base.x, y: base.y, z: base.z + 1 },
    { x: base.x, y: base.y, z: base.z - 1 }
  ]
}

function isRequiredUsable(role) {
  return REQUIRED_USABLE_ROLES.has(role)
}

function normalizeRole(role, type) {
  if (role === 'bed' || type === 'white_wool' || type === 'white_bed' || type === 'bed') return 'bed'
  if (role === 'chest' || type === 'chest' || type === 'trapped_chest') return 'chest'
  if (role === 'furnace' || type === 'furnace' || type === 'blast_furnace' || type === 'smoker') return 'furnace'
  if (role === 'crafting_table' || type === 'crafting_table') return 'crafting_table'
  return role || type || 'unknown'
}

function isAir(type) {
  return AIR_BLOCKS.has(type)
}

function copyPos(position) {
  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z))
  }
}

function posKey(position) {
  return `${Math.round(Number(position.x))},${Math.round(Number(position.y))},${Math.round(Number(position.z))}`
}

module.exports = {
  InteriorUsabilityValidator
}
