const SAFE_FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'apple',
  'carrot', 'baked_potato', 'pumpkin_pie', 'melon_slice'
])

const CRAFTING_RECIPES = {
  stick: {
    output: 4,
    alternatives: [[{ item: 'planks', count: 2 }]]
  },
  torch: {
    output: 4,
    alternatives: [
      [{ item: 'coal', count: 1 }, { item: 'stick', count: 1 }],
      [{ item: 'charcoal', count: 1 }, { item: 'stick', count: 1 }]
    ]
  },
  stone_pickaxe: {
    output: 1,
    alternatives: [[{ item: 'cobblestone', count: 3 }, { item: 'stick', count: 2 }]]
  },
  iron_pickaxe: {
    output: 1,
    alternatives: [[{ item: 'iron_ingot', count: 3 }, { item: 'stick', count: 2 }]]
  },
  bread: {
    output: 1,
    alternatives: [[{ item: 'wheat', count: 3 }]]
  }
}

const PLANK_ITEMS = [
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
  'crimson_planks', 'warped_planks'
]

function getInventoryCounts(context = {}) {
  const blackboardCounts = safeGetBlackboardCounts(context)
  if (blackboardCounts) return { ...blackboardCounts }

  const counts = {}
  for (const item of context.bot?.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return counts
}

function safeGetBlackboardCounts(context) {
  try {
    return context.blackboard?.get?.('inventory.counts') || null
  } catch {
    return null
  }
}

function countItem(counts, itemName) {
  if (itemName === 'planks') return PLANK_ITEMS.reduce((sum, name) => sum + (counts[name] || 0), 0)
  return counts[itemName] || 0
}

function hasItem(counts, itemName, count = 1) {
  return countItem(counts, itemName) >= count
}

function hasAnyItem(counts, itemNames) {
  return itemNames.some(itemName => hasItem(counts, itemName, 1))
}

function chooseRecipeMaterials(itemName, requestedCount, counts) {
  const recipe = CRAFTING_RECIPES[itemName]
  if (!recipe) return { ok: true, craftRuns: requestedCount, materials: [], missing: [] }

  const craftRuns = Math.max(1, Math.ceil((requestedCount || 1) / recipe.output))
  for (const alternative of recipe.alternatives) {
    const materials = alternative.map(material => ({
      item: material.item,
      count: material.count * craftRuns
    }))
    const missing = missingMaterials(materials, counts)
    if (missing.length === 0) return { ok: true, craftRuns, materials, missing: [] }
  }

  const first = recipe.alternatives[0].map(material => ({
    item: material.item,
    count: material.count * craftRuns
  }))
  return { ok: false, craftRuns, materials: first, missing: missingMaterials(first, counts) }
}

function missingMaterials(materials, counts) {
  return materials
    .map(material => ({
      item: material.item,
      required: material.count,
      available: countItem(counts, material.item)
    }))
    .filter(material => material.available < material.required)
}

function selectSafeFood(context = {}) {
  const foods = (context.bot?.inventory?.items?.() || [])
    .filter(item => SAFE_FOOD_ITEMS.has(item.name))
    .sort((a, b) => foodScore(b.name) - foodScore(a.name))
  return foods[0] || null
}

function foodScore(itemName) {
  const scores = {
    cooked_beef: 8,
    cooked_porkchop: 8,
    cooked_mutton: 6,
    cooked_salmon: 6,
    cooked_chicken: 6,
    bread: 5,
    baked_potato: 5,
    cooked_cod: 5,
    cooked_rabbit: 5,
    carrot: 3,
    apple: 4
  }
  return scores[itemName] || 1
}

function getBaseLocation(context = {}) {
  const direct = context.memory?.world?.baseLocation
  if (direct?.position) return direct.position
  if (direct?.x != null) return direct
  const summaryBase = context.memory?.summary?.().world?.baseLocation
  if (summaryBase?.position) return summaryBase.position
  return null
}

module.exports = {
  CRAFTING_RECIPES,
  SAFE_FOOD_ITEMS,
  chooseRecipeMaterials,
  countItem,
  getBaseLocation,
  getInventoryCounts,
  hasAnyItem,
  hasItem,
  selectSafeFood
}
