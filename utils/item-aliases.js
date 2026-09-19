const minecraftData = require('minecraft-data')

const DEFAULT_MINECRAFT_VERSION = '1.20.1'
let cachedValidItemNames = null

const ITEM_ALIAS_GROUPS = [
  ['enchanted_golden_apple', ['附魔金苹果']],
  ['golden_apple', ['金苹果']],
  ['golden_carrot', ['金胡萝卜']],

  ['cooked_beef', ['熟牛肉', '烤牛肉', '牛排']],
  ['beef', ['生牛肉', '牛肉']],

  ['cooked_porkchop', ['熟猪排', '烤猪排', '猪排']],
  ['porkchop', ['生猪排', '生猪肉', '猪肉']],

  ['cooked_chicken', ['熟鸡肉', '烤鸡肉', '鸡肉']],
  ['chicken', ['生鸡肉']],

  ['cooked_mutton', ['熟羊肉', '烤羊肉', '羊排']],
  ['mutton', ['生羊肉']],

  ['cooked_rabbit', ['熟兔肉', '烤兔肉', '兔肉']],
  ['rabbit', ['生兔肉']],

  ['cooked_cod', ['熟鳕鱼', '烤鳕鱼', '鳕鱼']],
  ['cod', ['生鳕鱼']],

  ['cooked_salmon', ['熟鲑鱼', '烤鲑鱼', '三文鱼', '鲑鱼']],
  ['salmon', ['生三文鱼', '生鲑鱼']],

  ['bread', ['面包']],
  ['apple', ['苹果']],
  ['carrot', ['胡萝卜']],
  ['baked_potato', ['烤土豆', '熟土豆']],
  ['potato', ['马铃薯', '土豆']],
  ['poisonous_potato', ['毒马铃薯', '毒土豆']],
  ['beetroot_soup', ['甜菜根汤', '甜菜汤']],
  ['beetroot', ['甜菜根']],
  ['mushroom_stew', ['蘑菇煲', '蘑菇汤']],
  ['rabbit_stew', ['兔肉煲', '兔肉汤']],
  ['pumpkin_pie', ['南瓜派']],
  ['cookie', ['曲奇', '饼干']],
  ['melon_slice', ['西瓜片']],
  ['dried_kelp', ['干海带']],
  ['rotten_flesh', ['腐肉']],
  ['spider_eye', ['蜘蛛眼']],
  ['pufferfish', ['河豚']],

  ['food', ['食物', '吃的']],
  ['grass_block', ['草方块', '草块']],
  ['wheat_seeds', ['小麦种子', '麦种', '种子']],
  ['dirt', ['泥土']],
  ['cobblestone', ['圆石']],
  ['iron_ingot', ['铁锭', '铁']],
  ['oak_log', ['\u6a61\u6728\u539f\u6728']],
  ['oak_planks', ['\u6a61\u6728\u6728\u677f']],
  ['torch', ['火把']],
  ['coal', ['煤炭', '煤']]
]

const UTF8_ITEM_ALIAS_GROUPS = [
  ['red_dye', ['\u7ea2\u8272\u67d3\u6599', '\u7ea2\u67d3\u6599']],
  ['blue_dye', ['\u84dd\u8272\u67d3\u6599', '\u84dd\u67d3\u6599']],
  ['enchanted_book', ['\u9644\u9b54\u4e66']],
  ['raw_iron', ['\u7c97\u94c1', '\u94c1\u539f\u77ff']],
  ['deepslate_iron_ore', ['\u6df1\u5c42\u94c1\u77ff\u77f3']],
  ['crafting_table', ['工作台', '合成台']],
  ['furnace', ['furnace', '熔炉', '炉子']],
  ['blast_furnace', ['高炉']],
  ['bucket', ['bucket', '铁桶']],
  ['barrel', ['barrel', '木桶']],
  ['oak_stairs', ['stairs', 'stair', '楼梯']],
  ['oak_slab', ['slab', '台阶']],
  ['red_bed', ['bed', '床']],
  ['smoker', ['烟熏炉']],
  ['chest', ['箱子', '木箱']],
  ['torch', ['火把']],
  ['stick', ['木棍', '棍子']],
  ['wheat', ['小麦']],
  ['wheat_seeds', ['小麦种子', '麦种', '种子']],
  ['bread', ['面包']],
  ['sand', ['沙子']],
  ['glass', ['玻璃']],
  ['coal', ['煤', '煤炭']],
  ['charcoal', ['木炭']],
  ['iron_ore', ['铁矿石', '铁矿']],
  ['raw_iron', ['粗铁']],
  ['iron_ingot', ['铁锭', '铁']],
  ['gold_ore', ['金矿石', '金矿']],
  ['raw_gold', ['粗金']],
  ['gold_ingot', ['金锭']],
  ['cobblestone', ['圆石']],
  ['stone', ['石头']],
  ['oak_log', ['橡木原木', '橡木', '原木', '木头']],
  ['spruce_log', ['云杉原木', '云杉木']],
  ['birch_log', ['白桦原木', '白桦木', '桦木']],
  ['jungle_log', ['丛林原木', '丛林木']],
  ['acacia_log', ['金合欢原木', '金合欢木']],
  ['dark_oak_log', ['深色橡木原木', '深色橡木']],
  ['mangrove_log', ['红树原木', '红树木']],
  ['cherry_log', ['樱花原木', '樱花木']],
  ['oak_planks', ['木板', '橡木木板']],
  ['spruce_planks', ['云杉木板']],
  ['birch_planks', ['白桦木板']],
  ['jungle_planks', ['丛林木板']],
  ['acacia_planks', ['金合欢木板']],
  ['dark_oak_planks', ['深色橡木木板']],
  ['mangrove_planks', ['红树木板']],
  ['cherry_planks', ['樱花木板']],
  ['iron_sword', ['铁剑', '铁制剑']],
  ['iron_pickaxe', ['铁镐', '铁镐子']],
  ['iron_axe', ['铁斧', '铁斧头']],
  ['iron_shovel', ['铁铲', '铁锹']],
  ['iron_hoe', ['铁锄', '铁锄头']],
  ['stone_sword', ['石剑']],
  ['stone_pickaxe', ['石镐', '石镐子']],
  ['stone_axe', ['石斧', '石斧头']],
  ['stone_shovel', ['石铲', '石锹']],
  ['stone_hoe', ['石锄', '石锄头']],
  ['wooden_sword', ['木剑']],
  ['wooden_pickaxe', ['木镐', '木镐子']],
  ['wooden_axe', ['木斧', '木斧头']],
  ['wooden_shovel', ['木铲', '木锹']],
  ['wooden_hoe', ['木锄', '木锄头']],
  ['pickaxe', ['镐子', '稿子', '镐']],
  ['axe', ['斧头', '斧子', '斧']],
  ['hoe', ['锄头', '锄']],
  ['shovel', ['铲子', '铲', '锹']],
  ['sword', ['剑']],
  ['furnace', ['熔炉']],
  ['beef', ['生牛肉', '牛肉']],
  ['cooked_beef', ['熟牛排', '牛排', '熟牛肉']],
  ['porkchop', ['生猪排', '猪肉', '猪排']],
  ['cooked_porkchop', ['熟猪排']],
  ['chicken', ['生鸡肉', '鸡肉']],
  ['cooked_chicken', ['熟鸡肉']],
  ['stone', ['石头']],
  ['cobblestone', ['圆石']],
  ['sand', ['沙子']],
  ['stick', ['木棍', '棍子']],
  ['diamond', ['钻石']],
  ['coal', ['煤', '煤炭']],
  ['charcoal', ['木炭']],
  ['torch', ['火把']],
  ['iron_pickaxe', ['铁镐', '铁镐子']],
  ['raw_iron', ['粗铁']],
  ['raw_gold', ['粗金']],
  ['raw_copper', ['粗铜']],
  ['diamond_ore', ['钻石矿', '钻石矿石']],
  ['iron_ore', ['铁矿', '铁矿石']],
  ['deepslate_iron_ore', ['深层铁矿', '深层铁矿石']],
  ['coal_ore', ['煤矿', '煤矿石']],
  ['gold_ore', ['金矿', '金矿石']],
  ['copper_ore', ['铜矿', '铜矿石']],
  ['redstone_ore', ['红石矿', '红石矿石']],
  ['lapis_ore', ['青金石矿', '青金石矿石']],
  ['torch', ['火把']],
  ['chest', ['箱子']],
  ['crafting_table', ['工作台']],
  ['bread', ['面包']],
  ['food', ['食物', '吃的']]
]

const CATEGORY_ALIAS_GROUPS = [
  ['armor', ['防具', '盔甲']],
  ['equipment', ['装备']],
  ['weapon', ['武器']],
  ['tool', ['工具']],
  ['food', ['食物', '吃的']],
  ['wood', ['\u6728\u5934', '\u6728\u6750']],
  ['logs', ['\u539f\u6728']],
  ['planks', ['\u6728\u677f']],
  ['oak_wood', ['\u6a61\u6728']],
  ['spruce_wood', ['\u4e91\u6749\u6728']],
  ['birch_wood', ['\u767d\u6866\u6728', '\u6866\u6728']],
  ['jungle_wood', ['\u4e1b\u6797\u6728']],
  ['acacia_wood', ['\u91d1\u5408\u6b22\u6728']],
  ['dark_oak_wood', ['\u6df1\u8272\u6a61\u6728']],
  ['mangrove_wood', ['\u7ea2\u6811\u6728']],
  ['cherry_wood', ['\u6a31\u82b1\u6728']]
]

for (const [itemName, aliases] of UTF8_ITEM_ALIAS_GROUPS) {
  ITEM_ALIAS_GROUPS.push([itemName, aliases])
}

const ITEM_ALIASES = ITEM_ALIAS_GROUPS
  .flatMap(([itemName, aliases]) => aliases.map(alias => ({ itemName, alias })))
  .sort((a, b) => b.alias.length - a.alias.length)

const CATEGORY_ALIASES = CATEGORY_ALIAS_GROUPS
  .flatMap(([category, aliases]) => aliases.map(alias => ({ category, alias })))
  .sort((a, b) => b.alias.length - a.alias.length)

function resolveItemAlias(text, options = {}) {
  return resolveItemOrCategoryAlias(text, { ...options, categoryAsItem: true })
}

function resolveItemOrCategoryAlias(text, options = {}) {
  const query = String(text || '')
  if (options.categoryAsItem !== true) {
    const categoryMatch = CATEGORY_ALIASES.find(entry => query.includes(entry.alias))
    if (categoryMatch) {
      console.log(`[ITEM_ALIAS_MATCH] query=${categoryMatch.alias} category=${categoryMatch.category}`)
      console.log(`[item-alias] input="${categoryMatch.alias}" resolved=category:${categoryMatch.category}`)
      return {
        ok: true,
        itemName: null,
        category: categoryMatch.category,
        alias: categoryMatch.alias,
        isCategory: true
      }
    }
  }

  if (options.skipItemAliases !== true) {
    const match = ITEM_ALIASES.find(entry => query.includes(entry.alias) && !isIgnoredItemAlias(entry, options))
    if (match) {
      console.log(`[ITEM_ALIAS_MATCH] query=${match.alias} matched=${match.itemName}`)
      return {
        ok: true,
        itemName: match.itemName,
        category: null,
        alias: match.alias,
        isCategory: false
      }
    }

    const itemIdMatch = resolveMinecraftItemId(query, options)
    if (itemIdMatch) {
      console.log(`[ITEM_ID_MATCH] query=${itemIdMatch.alias} matched=${itemIdMatch.itemName}`)
      return {
        ok: true,
        itemName: itemIdMatch.itemName,
        category: null,
        alias: itemIdMatch.alias,
        isCategory: false,
        source: 'minecraft_data_item_id'
      }
    }
  }

  const categoryMatch = CATEGORY_ALIASES.find(entry => query.includes(entry.alias))
  if (categoryMatch) {
    console.log(`[ITEM_ALIAS_MATCH] query=${categoryMatch.alias} category=${categoryMatch.category}`)
    console.log(`[item-alias] input="${categoryMatch.alias}" resolved=category:${categoryMatch.category}`)
    return {
      ok: true,
      itemName: options.categoryAsItem === true ? categoryMatch.category : null,
      category: categoryMatch.category,
      alias: categoryMatch.alias,
      isCategory: true
    }
  }

  if (options.logFailure !== false) {
    console.log(`[ITEM_ALIAS_FAILED] query=${query} reason=no_alias_match`)
  }
  return {
    ok: false,
    itemName: null,
    category: null,
    alias: null,
    reason: 'no_alias_match'
  }
}

function isIgnoredItemAlias(entry, options = {}) {
  const ignoredNames = new Set(options.ignoredItemNames || options.ignoreItemNames || [])
  const ignoredAliases = new Set(options.ignoredAliases || options.ignoreAliases || [])
  return ignoredNames.has(entry.itemName) || ignoredAliases.has(entry.alias)
}

function resolveMinecraftItemId(query, options = {}) {
  if (options.allowItemIdFallback === false) return null
  const names = getValidItemNames()
  const ignoredNames = new Set(options.ignoredItemNames || options.ignoreItemNames || [])
  const matches = String(query || '').match(/(?:minecraft:)?[a-z][a-z0-9_]*/g) || []
  for (const raw of matches) {
    const itemName = raw.startsWith('minecraft:') ? raw.slice('minecraft:'.length) : raw
    if (ignoredNames.has(itemName)) continue
    if (names.has(itemName)) return { itemName, alias: raw }
  }
  return null
}

function getValidItemNames() {
  if (cachedValidItemNames) return cachedValidItemNames
  try {
    const data = minecraftData(DEFAULT_MINECRAFT_VERSION)
    cachedValidItemNames = new Set(Object.keys(data.itemsByName || {}))
  } catch {
    cachedValidItemNames = new Set()
  }
  return cachedValidItemNames
}

module.exports = {
  ITEM_ALIAS_GROUPS,
  ITEM_ALIASES,
  CATEGORY_ALIAS_GROUPS,
  CATEGORY_ALIASES,
  resolveMinecraftItemId,
  resolveItemOrCategoryAlias,
  resolveItemAlias
}
