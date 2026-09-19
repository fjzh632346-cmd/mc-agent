const SAFE_FOOD_PRIORITY = [
  'bread',
  'apple',
  'baked_potato',
  'carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'cooked_cod',
  'cooked_salmon',
  'pumpkin_pie',
  'mushroom_stew',
  'beetroot_soup',
  'rabbit_stew',
  'cookie',
  'melon_slice',
  'beetroot',
  'sweet_berries',
  'glow_berries',
  'dried_kelp'
]

const BASIC_FOOD_PRIORITY = [
  'beef',
  'porkchop',
  'mutton',
  'rabbit',
  'cod',
  'salmon',
  'potato'
]

const RISKY_FOOD_PRIORITY = [
  'chicken',
  'raw_chicken',
  'rotten_flesh',
  'spider_eye',
  'pufferfish',
  'poisonous_potato'
]

const PRECIOUS_FOOD_PRIORITY = [
  'golden_apple',
  'enchanted_golden_apple'
]

const FALLBACK_FOOD_NAMES = new Set([
  ...SAFE_FOOD_PRIORITY,
  ...BASIC_FOOD_PRIORITY,
  ...RISKY_FOOD_PRIORITY,
  ...PRECIOUS_FOOD_PRIORITY,
  'chorus_fruit',
  'golden_carrot',
  'honey_bottle',
  'suspicious_stew',
  'tropical_fish'
])

function selectFoodItem(context = {}, chestItems = [], options = {}) {
  const candidates = getFoodCandidates(context.bot, chestItems)
  console.log(`[FOOD_CANDIDATES] items=${JSON.stringify(candidates.map(toLogCandidate))}`)

  const safe = candidates.filter(candidate => candidate.category === 'safe' || candidate.category === 'basic' || candidate.category === 'unknown_edible')
  if (safe.length > 0) return selected(safe[0], 'priority/safety')

  const precious = candidates.filter(candidate => candidate.category === 'precious')
  if (precious.length > 0) {
    if (options.allowPrecious || isEmergencyContext(context)) return selected(precious[0], 'emergency')
    return blocked('food_requires_confirmation:precious', precious[0], 'precious/emergency')
  }

  const risky = candidates.filter(candidate => candidate.category === 'risky')
  if (risky.length > 0) return blocked('food_requires_confirmation:risky', risky[0], 'side_effects')

  return { ok: false, error: 'chest_item_not_found:food', candidates }
}

function getFoodCandidates(bot, chestItems = []) {
  const edibleNames = getEdibleItemNames(bot)
  const byName = new Map()

  for (const item of chestItems || []) {
    if (!item?.name || !edibleNames.has(item.name)) continue
    const current = byName.get(item.name) || {
      itemName: item.name,
      count: 0,
      category: foodCategory(item.name),
      priority: foodPriority(item.name)
    }
    current.count += item.count || 1
    byName.set(item.name, current)
  }

  return [...byName.values()]
    .sort((a, b) => a.priority - b.priority || a.itemName.localeCompare(b.itemName))
}

function getEdibleItemNames(bot) {
  const registry = bot?.registry || {}
  const names = new Set(FALLBACK_FOOD_NAMES)

  for (const food of Object.values(registry.foodsByName || {})) {
    if (food?.name) names.add(food.name)
  }

  for (const food of registry.foodsArray || []) {
    if (food?.name) names.add(food.name)
  }

  return names
}

function foodCategory(itemName) {
  if (SAFE_FOOD_PRIORITY.includes(itemName)) return 'safe'
  if (BASIC_FOOD_PRIORITY.includes(itemName)) return 'basic'
  if (RISKY_FOOD_PRIORITY.includes(itemName)) return 'risky'
  if (PRECIOUS_FOOD_PRIORITY.includes(itemName)) return 'precious'
  return 'unknown_edible'
}

function foodPriority(itemName) {
  const category = foodCategory(itemName)
  if (category === 'safe') return SAFE_FOOD_PRIORITY.indexOf(itemName)
  if (category === 'basic') return 100 + BASIC_FOOD_PRIORITY.indexOf(itemName)
  if (category === 'unknown_edible') return 200
  if (category === 'risky') return 300 + RISKY_FOOD_PRIORITY.indexOf(itemName)
  return 400 + PRECIOUS_FOOD_PRIORITY.indexOf(itemName)
}

function selected(candidate, reason) {
  console.log(`[FOOD_SELECTED] item=${candidate.itemName} reason=${reason}`)
  return { ok: true, itemName: candidate.itemName, count: candidate.count, reason, candidates: [candidate] }
}

function blocked(error, candidate, reason) {
  console.log(`[FOOD_SELECTED] item=${candidate.itemName} reason=${reason}`)
  return { ok: false, error, itemName: candidate.itemName, count: candidate.count, reason, candidates: [candidate] }
}

function isEmergencyContext(context) {
  const health = Number(context.blackboard?.get?.('bot.health') ?? context.bot?.health ?? 20)
  const danger = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return health <= 8 || danger === 'high' || danger === 'critical'
}

function toLogCandidate(candidate) {
  return {
    item: candidate.itemName,
    count: candidate.count,
    category: candidate.category,
    priority: candidate.priority
  }
}

module.exports = {
  foodCategory,
  getFoodCandidates,
  selectFoodItem
}
