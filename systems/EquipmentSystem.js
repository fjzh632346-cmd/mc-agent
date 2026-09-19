const { FOOD_ITEMS, TOOL_SUFFIXES } = require('../perception/world-state')
const { itemNameForBlock } = require('../utils/building-material-map')

const TOOL_TIER_ORDER = ['netherite', 'diamond', 'iron', 'stone', 'wood', 'golden', 'gold']
const PICKAXE_MATERIALS = ['wood', 'stone', 'iron', 'gold', 'diamond', 'netherite', 'golden']
const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']
const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots']
const ARMOR_DESTINATIONS = {
  helmet: 'head',
  chestplate: 'torso',
  leggings: 'legs',
  boots: 'feet'
}
const ARMOR_EQUIPMENT_SLOTS = {
  helmet: 5,
  chestplate: 6,
  leggings: 7,
  boots: 8
}
const ARMOR_TIER_ORDER = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'gold', 'leather']
const ARMOR_LEVEL_SCORE = {
  netherite: 6,
  diamond: 5,
  iron: 4,
  chainmail: 3,
  golden: 2,
  gold: 2,
  leather: 1,
  unknown: 0
}

const FOOD_PRIORITY_SCORES = {
  cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_salmon: 6,
  cooked_chicken: 6, bread: 5, baked_potato: 5, cooked_cod: 5,
  cooked_rabbit: 5, golden_carrot: 6, apple: 4, carrot: 3,
  pumpkin_pie: 4, mushroom_stew: 4, beetroot_soup: 4, rabbit_stew: 4,
  melon_slice: 2, sweet_berries: 2, glow_berries: 2, dried_kelp: 1,
  cookie: 2, potato: 3
}

const PRECIOUS_FOOD = new Set(['golden_apple', 'enchanted_golden_apple'])
const RISKY_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'raw_chicken'])

const ITEM_CATEGORIES = {
  weapon: new Set(),
  tool: new Set(),
  food: new Set(FOOD_ITEMS || []),
  block: new Set(),
  seed: new Set(),
  precious: new Set(['diamond', 'diamond_block', 'netherite_ingot', 'netherite_block', 'netherite_scrap',
    'enchanted_golden_apple', 'beacon', 'elytra', 'dragon_egg', 'nether_star'])
}

for (const tier of PICKAXE_MATERIALS) {
  const suffix = tier === 'gold' ? '_pickaxe' : `_pickaxe`
  const pickName = `${tier}${tier === 'gold' ? 'en' : ''}${tier === 'wood' ? 'en' : ''}_pickaxe`
  ITEM_CATEGORIES.tool.add(pickName)
}

const BLOCK_TOOL_MAP = {
  pickaxe: new Set([
    'stone', 'cobblestone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff',
    'netherrack', 'blackstone', 'basalt', 'end_stone', 'sandstone', 'red_sandstone',
    'prismarine', 'prismarine_bricks', 'dark_prismarine', 'purpur_block', 'purpur_pillar',
    'quartz_block', 'quartz_pillar', 'terracotta', 'white_terracotta', 'orange_terracotta',
    'magenta_terracotta', 'light_blue_terracotta', 'yellow_terracotta', 'lime_terracotta',
    'pink_terracotta', 'gray_terracotta', 'light_gray_terracotta', 'cyan_terracotta',
    'purple_terracotta', 'blue_terracotta', 'brown_terracotta', 'green_terracotta',
    'red_terracotta', 'black_terracotta', 'glazed_terracotta', 'concrete',
    'white_concrete', 'orange_concrete', 'magenta_concrete', 'light_blue_concrete',
    'yellow_concrete', 'lime_concrete', 'pink_concrete', 'gray_concrete',
    'light_gray_concrete', 'cyan_concrete', 'purple_concrete', 'blue_concrete',
    'brown_concrete', 'green_concrete', 'red_concrete', 'black_concrete',
    'obsidian', 'crying_obsidian', 'ancient_debris',
    'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore',
    'coal_ore', 'deepslate_coal_ore', 'gold_ore', 'deepslate_gold_ore',
    'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
    'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
    'nether_quartz_ore', 'nether_gold_ore', 'gilded_blackstone',
    'iron_block', 'gold_block', 'diamond_block', 'netherite_block',
    'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil',
    'furnace', 'blast_furnace', 'smoker', 'brewing_stand', 'cauldron',
    'hopper', 'dropper', 'dispenser', 'observer', 'piston', 'sticky_piston',
    'spawner', 'lodestone', 'bell', 'lantern', 'soul_lantern',
    'iron_bars', 'iron_door', 'iron_trapdoor', 'chain',
    'stone_bricks', 'stone_brick_stairs', 'stone_brick_slab',
    'bricks', 'brick_stairs', 'brick_slab', 'nether_bricks',
    'rail', 'powered_rail', 'detector_rail', 'activator_rail'
  ]),
  axe: new Set([
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo_block',
    'crimson_stem', 'warped_stem',
    'stripped_oak_log', 'stripped_spruce_log', 'stripped_birch_log',
    'stripped_jungle_log', 'stripped_acacia_log', 'stripped_dark_oak_log',
    'stripped_mangrove_log', 'stripped_cherry_log',
    'stripped_crimson_stem', 'stripped_warped_stem',
    'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood',
    'dark_oak_wood', 'mangrove_wood', 'cherry_wood',
    'crimson_hyphae', 'warped_hyphae',
    'stripped_oak_wood', 'stripped_spruce_wood', 'stripped_birch_wood',
    'stripped_jungle_wood', 'stripped_acacia_wood', 'stripped_dark_oak_wood',
    'stripped_mangrove_wood', 'stripped_cherry_wood',
    'stripped_crimson_hyphae', 'stripped_warped_hyphae',
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'bamboo_planks', 'crimson_planks', 'warped_planks',
    'oak_slab', 'spruce_slab', 'birch_slab', 'jungle_slab', 'acacia_slab',
    'dark_oak_slab', 'mangrove_slab', 'cherry_slab',
    'bamboo_slab', 'crimson_slab', 'warped_slab',
    'crafting_table', 'chest', 'trapped_chest', 'barrel',
    'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence', 'acacia_fence',
    'dark_oak_fence', 'mangrove_fence', 'cherry_fence',
    'bamboo_fence', 'crimson_fence', 'warped_fence',
    'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
    'dark_oak_door', 'mangrove_door', 'cherry_door',
    'bamboo_door', 'crimson_door', 'warped_door',
    'bookshelf', 'lectern', 'loom', 'cartography_table', 'fletching_table',
    'smithing_table', 'composter', 'note_block', 'jukebox',
    'ladder', 'scaffolding', 'campfire', 'soul_campfire',
    'oak_sign', 'spruce_sign', 'birch_sign', 'jungle_sign', 'acacia_sign',
    'dark_oak_sign', 'mangrove_sign', 'cherry_sign',
    'bamboo_sign', 'crimson_sign', 'warped_sign',
    'oak_button', 'spruce_button', 'birch_button', 'jungle_button', 'acacia_button',
    'dark_oak_button', 'mangrove_button', 'cherry_button',
    'bamboo_button', 'crimson_button', 'warped_button',
    'oak_pressure_plate', 'spruce_pressure_plate', 'birch_pressure_plate',
    'jungle_pressure_plate', 'acacia_pressure_plate', 'dark_oak_pressure_plate',
    'mangrove_pressure_plate', 'cherry_pressure_plate',
    'bamboo_pressure_plate', 'crimson_pressure_plate', 'warped_pressure_plate',
    'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor',
    'acacia_trapdoor', 'dark_oak_trapdoor', 'mangrove_trapdoor', 'cherry_trapdoor',
    'bamboo_trapdoor', 'crimson_trapdoor', 'warped_trapdoor',
    'oak_stairs', 'spruce_stairs', 'birch_stairs', 'jungle_stairs', 'acacia_stairs',
    'dark_oak_stairs', 'mangrove_stairs', 'cherry_stairs',
    'bamboo_stairs', 'crimson_stairs', 'warped_stairs',
    'beehive', 'bee_nest'
  ]),
  shovel: new Set([
    'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt',
    'grass_block', 'dirt_path', 'farmland',
    'sand', 'red_sand', 'gravel', 'clay', 'soul_sand', 'soul_soil',
    'snow', 'snow_block', 'powder_snow'
  ]),
  hoe: new Set([
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
    'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
    'azalea_leaves', 'flowering_azalea_leaves',
    'hay_block', 'dried_kelp_block', 'moss_block',
    'sculk', 'sculk_catalyst', 'sculk_shrieker', 'sculk_sensor',
    'sponge', 'wet_sponge', 'target',
    'warped_wart_block', 'nether_wart_block', 'shroomlight'
  ]),
  shears: new Set([
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool',
    'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool',
    'cobweb', 'vine', 'cave_vines',
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
    'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
    'azalea_leaves', 'flowering_azalea_leaves',
    'tall_grass', 'large_fern', 'fern', 'dead_bush', 'seagrass', 'tall_seagrass',
    'glow_lichen', 'hanging_roots', 'small_dripleaf', 'big_dripleaf',
    'spore_blossom', 'azalea', 'flowering_azalea'
  ])
}

const BLOCK_MIN_TIER = {
  stone: 'wood',
  cobblestone: 'wood',
  deepslate: 'wood',
  cobbled_deepslate: 'wood',
  blackstone: 'wood',
  coal_ore: 'wood',
  deepslate_coal_ore: 'wood',
  diamond_ore: 'iron',
  deepslate_diamond_ore: 'iron',
  emerald_ore: 'iron',
  deepslate_emerald_ore: 'iron',
  gold_ore: 'iron',
  deepslate_gold_ore: 'iron',
  redstone_ore: 'iron',
  deepslate_redstone_ore: 'iron',
  lapis_ore: 'stone',
  deepslate_lapis_ore: 'stone',
  iron_ore: 'stone',
  deepslate_iron_ore: 'stone',
  copper_ore: 'stone',
  deepslate_copper_ore: 'stone',
  obsidian: 'diamond',
  crying_obsidian: 'diamond',
  ancient_debris: 'diamond',
  netherite_block: 'diamond'
}

const WEAPON_TIER_ORDER = ['netherite', 'diamond', 'iron', 'stone', 'wood', 'golden', 'gold']
const WEAPON_TYPE_PRIORITY = {
  sword: 3,
  axe: 2,
  trident: 2,
  bow: 1,
  crossbow: 1
}
const WEAPON_DAMAGE = {
  sword: {
    netherite: 8,
    diamond: 7,
    iron: 6,
    stone: 5,
    wood: 4,
    golden: 4,
    gold: 4,
    unknown: 4
  },
  axe: {
    netherite: 10,
    diamond: 9,
    iron: 9,
    stone: 9,
    wood: 7,
    golden: 7,
    gold: 7,
    unknown: 6
  },
  trident: { unknown: 9 },
  bow: { unknown: 2 },
  crossbow: { unknown: 2 }
}

class EquipmentSystem {
  constructor(options = {}) {
    this.options = {
      durabilityWarnThreshold: 0.1,
      maxDurabilityMap: options.maxDurabilityMap || {},
      ...options
    }
    this._durabilityMap = new Map()
    this.lastArmorEquipReason = null
    this.lastArmorEquipError = null
  }

  // --- Core selection methods ---

  selectBestToolForBlock(blockName, context = {}) {
    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')

    const preferredTool = this._toolTypeForBlock(blockName, context)
    if (!preferredTool) {
      const handItem = this._getHeldItem(context)
      return {
        success: true,
        itemName: 'hand',
        reason: 'no_special_tool_needed',
        heldAlready: true,
        toolType: 'none',
        preferredTool: null,
        requiredTool: null,
        allowHand: true,
        heldItem: handItem?.name || null
      }
    }

    const minTier = this._minTierForBlock(blockName)
    const requiredTool = minTier ? `${formatToolTier(minTier)}_${preferredTool}_or_better` : null
    const tools = this._filterTools(items, preferredTool, minTier)
    if (!tools.length) {
      if (!minTier) {
        const handItem = this._getHeldItem(context)
        return {
          success: true,
          itemName: 'hand',
          reason: 'preferred_tool_missing_allow_hand',
          heldAlready: true,
          toolType: preferredTool,
          preferredTool,
          requiredTool: null,
          allowHand: true,
          heldItem: handItem?.name || null,
          blockName
        }
      }
      return this._fail('missing_required_tool', {
        requiredTool,
        toolType: preferredTool,
        preferredTool,
        minTier,
        allowHand: false,
        blockName
      })
    }

    const best = this._pickBestByTierAndDurability(tools, context)
    if (!best) return this._fail('missing_required_tool', {
      requiredTool,
      toolType: preferredTool,
      preferredTool,
      minTier,
      allowHand: false,
      blockName
    })

    const durabilityPercent = this._getDurabilityPercent(best, context)
    return {
      success: true,
      itemName: best.name,
      reason: `best_tool_for_${blockName}`,
      toolType: preferredTool,
      preferredTool,
      requiredTool,
      allowHand: !requiredTool,
      tier: this._extractTier(best.name),
      durabilityPercent,
      durability: best.durability,
      maxDurability: best.maxDurability
    }
  }

  selectBestWeaponForTarget(context = {}, options = {}) {
    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')

    const weapons = items
      .map(item => ({ item, weaponType: this._weaponType(item?.name) }))
      .filter(entry => entry.weaponType)

    if (!weapons.length) return this._fail('missing_weapon', { detail: 'no_weapons_in_inventory' })

    const preferredWeaponName = options.preferredWeaponName || options.weaponName || null
    if (preferredWeaponName) {
      const exact = weapons.find(entry => entry.item.name === preferredWeaponName)
      if (exact) return this._weaponSelection(exact.item, exact.weaponType, context, 'preferred_weapon_available')
    }

    const preferredWeaponType = normalizeWeaponType(options.preferredWeaponType || options.weaponType || options.preferredWeapon || null)
    const pool = preferredWeaponType
      ? weapons.filter(entry => entry.weaponType === preferredWeaponType)
      : weapons

    const scored = (pool.length ? pool : weapons).map(entry => this._scoreWeapon(entry.item, entry.weaponType, context))
    scored.sort((a, b) => {
      if (a.damage !== b.damage) return b.damage - a.damage
      if (a.tierIdx !== b.tierIdx) return a.tierIdx - b.tierIdx
      if (a.typePriority !== b.typePriority) return b.typePriority - a.typePriority
      return b.durabilityPercent - a.durabilityPercent
    })

    const best = scored[0]
    const reason = preferredWeaponType && !pool.length
      ? `preferred_weapon_missing:${preferredWeaponType}`
      : (preferredWeaponName && !weapons.some(entry => entry.item.name === preferredWeaponName)
          ? `preferred_weapon_missing:${preferredWeaponName}`
          : (preferredWeaponType ? 'preferred_weapon_type_available' : 'best_weapon_available'))
    return this._weaponSelection(best.item, best.weaponType, context, reason, best)
  }

  selectBestFood(context = {}, options = {}) {
    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')

    const survivalState = options.survivalState || {}
    const dangerLevel = survivalState.dangerLevel || 'none'
    const isEmergency = dangerLevel === 'high' || dangerLevel === 'critical' ||
      (survivalState.health != null && survivalState.health <= 8)

    const edibleItems = items.filter(item => {
      const name = item.name
      if (!name) return false
      if (PRECIOUS_FOOD.has(name)) return isEmergency
      if (RISKY_FOOD.has(name)) return false
      const registry = context.bot?.registry
      if (registry?.foodsByName?.[name]) return true
      if (registry?.foodsArray?.some(f => f.name === name)) return true
      return false
    })

    if (!edibleItems.length) {
      if (isEmergency) {
        const precious = items.find(item => PRECIOUS_FOOD.has(item.name))
        if (precious) {
          return {
            success: true, itemName: precious.name, reason: 'emergency_precious_food',
            isEmergency: true, durabilityPercent: 1
          }
        }
      }
      return this._fail('no_food_available')
    }

    edibleItems.sort((a, b) => {
      const isPreciousA = PRECIOUS_FOOD.has(a.name)
      const isPreciousB = PRECIOUS_FOOD.has(b.name)
      if (isPreciousA !== isPreciousB) return isPreciousB ? 1 : -1
      const scoreA = FOOD_PRIORITY_SCORES[a.name] || 1
      const scoreB = FOOD_PRIORITY_SCORES[b.name] || 1
      return scoreB - scoreA
    })

    const best = edibleItems[0]
    return {
      success: true,
      itemName: best.name,
      reason: options.reason || 'hunger',
      foodScore: FOOD_PRIORITY_SCORES[best.name] || 1,
      count: best.count
    }
  }

  selectBlockForBuilding(blockName, context = {}) {
    if (!blockName) return this._fail('missing_block_name')
    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')

    const itemName = itemNameForBlock(blockName)
    const item = items.find(i => i.name === itemName)
    if (!item) return this._fail('block_not_in_inventory', { blockName, itemName })
    return { success: true, itemName: item.name, blockName, count: item.count }
  }

  selectSeeds(context = {}) {
    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')

    const seedNames = ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato',
      'pumpkin_seeds', 'melon_seeds', 'sweet_berries', 'bamboo']
    const seed = items.find(i => seedNames.includes(i.name))
    if (!seed) return this._fail('no_seeds_available')
    return { success: true, itemName: seed.name, count: seed.count }
  }

  selectHoe(context = {}) {
    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')
    const hoe = items.find(i => i.name.endsWith('_hoe'))
    if (!hoe) return this._fail('no_hoe_available')
    return { success: true, itemName: hoe.name }
  }

  selectBestArmorForSlot(slot, context = {}) {
    const normalizedSlot = this._normalizeArmorSlot(slot)
    if (!normalizedSlot) return this._fail('unknown_armor_slot', { slot })

    const items = this._getItems(context)
    if (!items) return this._fail('no_inventory')

    const candidates = items.filter(item => this._isArmorForSlot(item?.name, normalizedSlot))
    if (!candidates.length) return this._fail('no_armor_available', { slot: normalizedSlot })

    const current = this._getEquippedArmorItem(context, normalizedSlot)
    const best = this._pickBestArmor(candidates, context)
    if (!best) return this._fail('no_usable_armor_available', { slot: normalizedSlot })

    if (current && this._compareArmor(best, current, context) <= 0) {
      return this._fail('no_upgrade_available', {
        slot: normalizedSlot,
        currentArmor: this._summarizeArmorItem(current, context),
        bestAvailableArmor: this._summarizeArmorItem(best, context)
      })
    }

    return {
      success: true,
      slot: normalizedSlot,
      itemName: best.name,
      reason: current ? 'armor_upgrade_available' : 'missing_armor_slot',
      armorTier: this._extractArmorTier(best.name),
      durabilityPercent: this._getDurabilityPercent(best, context),
      currentArmor: current ? this._summarizeArmorItem(current, context) : null
    }
  }

  // --- Equip methods (select + equip) ---

  async equipBestToolForBlock(blockName, context = {}) {
    const selection = this.selectBestToolForBlock(blockName, context)
    if (!selection.success) return selection
    if (selection.heldAlready) return selection
    return this._equipItem(selection.itemName, context, selection)
  }

  async equipBestWeapon(context = {}, options = {}) {
    const selection = this.selectBestWeaponForTarget(context, options)
    if (!selection.success) return selection
    return this._equipItem(selection.itemName, context, selection)
  }

  async equipBestFood(context = {}, options = {}) {
    const selection = this.selectBestFood(context, options)
    if (!selection.success) return selection
    return this._equipItem(selection.itemName, context, selection)
  }

  async equipBlockForBuilding(blockName, context = {}) {
    const selection = this.selectBlockForBuilding(blockName, context)
    if (!selection.success) return selection
    return this._equipItem(selection.itemName, context, selection)
  }

  async equipSeeds(context = {}) {
    const selection = this.selectSeeds(context)
    if (!selection.success) return selection
    return this._equipItem(selection.itemName, context, selection)
  }

  async equipHoe(context = {}) {
    const selection = this.selectHoe(context)
    if (!selection.success) return selection
    return this._equipItem(selection.itemName, context, selection)
  }

  async equipBestArmor(context = {}, options = {}) {
    const results = []
    let equippedCount = 0

    for (const slot of ARMOR_SLOTS) {
      const selection = this.selectBestArmorForSlot(slot, context)
      if (!selection.success) {
        results.push(selection)
        continue
      }

      const result = await this._equipArmorItem(selection.itemName, slot, context, selection)
      results.push(result)
      if (result.success && result.equipped) equippedCount += 1
    }

    this.lastArmorEquipReason = options.reason || (equippedCount > 0 ? 'equip_best_armor' : 'no_armor_upgrade')
    const failed = results.find(result => result.success === false && !['no_armor_available', 'no_upgrade_available'].includes(result.reason))
    this.lastArmorEquipError = failed?.reason || null

    return {
      success: equippedCount > 0 || !failed,
      equippedCount,
      reason: this.lastArmorEquipReason,
      results
    }
  }

  async equipItemByName(itemName, context = {}) {
    if (!itemName) return this._fail('missing_item_name')
    return this._equipItem(itemName, context, {})
  }

  // --- Check methods ---

  hasRequiredToolForBlock(blockName, context = {}) {
    const selection = this.selectBestToolForBlock(blockName, context)
    return { ok: selection.success, ...selection }
  }

  hasWeapon(context = {}) {
    const selection = this.selectBestWeaponForTarget(context)
    return { ok: selection.success, ...selection }
  }

  hasFood(context = {}) {
    const selection = this.selectBestFood(context)
    return { ok: selection.success, ...selection }
  }

  hasArmor(context = {}) {
    return { ok: ARMOR_SLOTS.some(slot => Boolean(this._getEquippedArmorItem(context, slot))) }
  }

  getArmorLevel(context = {}) {
    return ARMOR_SLOTS.reduce((sum, slot) => {
      const item = this._getEquippedArmorItem(context, slot)
      return sum + ARMOR_LEVEL_SCORE[this._extractArmorTier(item?.name)] || sum
    }, 0)
  }

  isHoldingItem(itemName, context = {}) {
    const held = this._getHeldItem(context)
    return held?.name === itemName
  }

  getHeldItemType(context = {}) {
    const held = this._getHeldItem(context)
    if (!held?.name) return 'none'
    const name = held.name
    if (name.endsWith('_pickaxe')) return 'pickaxe'
    if (name.endsWith('_axe')) return 'axe'
    if (name.endsWith('_shovel')) return 'shovel'
    if (name.endsWith('_hoe')) return 'hoe'
    if (name.endsWith('_sword')) return 'sword'
    if (name === 'bow' || name === 'crossbow') return 'bow'
    if (name === 'shield') return 'shield'
    if (name === 'shears') return 'shears'
    if (this._isEdible(name, context)) return 'food'
    return 'other'
  }

  getToolStatus(context = {}) {
    const items = this._getItems(context) || []
    const toolItems = items.filter(i => TOOL_TYPES.some(tt => i.name.endsWith(`_${tt}`)))
    const held = this._getHeldItem(context)

    return {
      heldItem: held ? { name: held.name, durability: held.durability, maxDurability: held.maxDurability } : null,
      heldItemType: this.getHeldItemType(context),
      hasPickaxe: toolItems.some(i => i.name.endsWith('_pickaxe')),
      hasAxe: toolItems.some(i => i.name.endsWith('_axe')),
      hasShovel: toolItems.some(i => i.name.endsWith('_shovel')),
      hasHoe: toolItems.some(i => i.name.endsWith('_hoe')),
      hasSword: toolItems.some(i => i.name.endsWith('_sword')),
      hasShears: toolItems.some(i => i.name === 'shears'),
      hasFood: this.hasFood(context).ok,
      availableTools: toolItems.map(i => ({
        name: i.name,
        durabilityPercent: this._getDurabilityPercent(i)
      }))
    }
  }

  getArmorStatus(context = {}) {
    const equipped = {}
    const bestAvailableArmor = {}
    const missingArmorSlots = []

    for (const slot of ARMOR_SLOTS) {
      const current = this._getEquippedArmorItem(context, slot)
      equipped[slot] = current ? this._summarizeArmorItem(current, context) : null
      if (!current) missingArmorSlots.push(slot)

      const selection = this.selectBestArmorForSlot(slot, context)
      bestAvailableArmor[slot] = selection.success
        ? this._summarizeArmorItem(this._getItems(context).find(item => item.name === selection.itemName), context)
        : null
    }

    return {
      helmet: equipped.helmet,
      chestplate: equipped.chestplate,
      leggings: equipped.leggings,
      boots: equipped.boots,
      armorLevel: this.getArmorLevel(context),
      missingArmorSlots,
      bestAvailableArmor,
      lastArmorEquipReason: this.lastArmorEquipReason,
      lastArmorEquipError: this.lastArmorEquipError
    }
  }

  // --- Internal helpers ---

  async _equipItem(itemName, context, selection) {
    const bot = context.bot
    if (!bot || typeof bot.equip !== 'function') return this._fail('missing_bot_equip')

    const held = this._getHeldItem(context)
    if (held?.name === itemName) {
      return { ...selection, alreadyEquipped: true, heldItem: itemName }
    }

    const item = this._getItems(context)?.find(i => i.name === itemName)
    if (!item) return this._fail('item_not_found', { itemName })

    const lockOwner = getEquipmentLockOwner(context, 'equipment_system')
    const lock = context.actionLock?.acquire?.('inventory', lockOwner, { timeoutMs: 10000 })
    if (lock && !lock.ok) {
      return this._fail('inventory_lock_busy', { itemName, lockOwner: lock.currentOwner })
    }

    try {
      await bot.equip(item, 'hand')
      return { ...selection, itemName, equipped: true }
    } catch (err) {
      return this._fail('equip_failed', { itemName, error: err.message })
    } finally {
      if (lock?.ok && !lock.alreadyHeld) context.actionLock?.release?.('inventory', lockOwner)
    }
  }

  async _equipArmorItem(itemName, slot, context, selection) {
    const bot = context.bot
    if (!bot || typeof bot.equip !== 'function') return this._fail('missing_bot_equip')

    const item = this._getItems(context)?.find(i => i.name === itemName)
    if (!item) return this._fail('item_not_found', { itemName, slot })

    const lockOwner = getEquipmentLockOwner(context, 'equipment_system_armor')
    const lock = context.actionLock?.acquire?.('inventory', lockOwner, { timeoutMs: 10000 })
    if (lock && !lock.ok) {
      return this._fail('inventory_lock_busy', { itemName, slot, lockOwner: lock.currentOwner })
    }

    try {
      await bot.equip(item, ARMOR_DESTINATIONS[slot])
      this.lastArmorEquipReason = selection.reason
      this.lastArmorEquipError = null
      return { ...selection, itemName, equipped: true, destination: ARMOR_DESTINATIONS[slot] }
    } catch (err) {
      this.lastArmorEquipError = err.message
      return this._fail('armor_equip_failed', { itemName, slot, error: err.message })
    } finally {
      if (lock?.ok && !lock.alreadyHeld) context.actionLock?.release?.('inventory', lockOwner)
    }
  }

  _toolTypeForBlock(blockName, context = {}) {
    if (!blockName) return null
    const name = String(blockName).toLowerCase()

    if (BLOCK_TOOL_MAP.pickaxe.has(name)) return 'pickaxe'
    if (BLOCK_TOOL_MAP.axe.has(name)) return 'axe'
    if (BLOCK_TOOL_MAP.shovel.has(name)) return 'shovel'
    if (BLOCK_TOOL_MAP.hoe.has(name)) return 'hoe'

    if (name.endsWith('_ore') || name.includes('_ore')) return 'pickaxe'
    if (name.includes('_log') || name.includes('_wood') || name.includes('_planks') || name.includes('_stem') || name.includes('_hyphae')) return 'axe'
    if (name === 'dirt' || name.includes('grass') || name.includes('sand') || name.includes('gravel') || name === 'clay' || name.includes('soul_sand') || name.includes('soul_soil')) return 'shovel'
    if (name === 'stone' || name.includes('cobblestone') || name.includes('deepslate') || name.includes('netherrack')) return 'pickaxe'
    if (BLOCK_TOOL_MAP.shears.has(name)) return 'shears'

    if (context.bot?.registry?.blocksByName) {
      const block = context.bot.registry.blocksByName[blockName]
      if (block?.harvestTools) {
        const toolIds = Object.keys(block.harvestTools)
        if (toolIds.length > 0) {
          const toolTypeId = parseInt(toolIds[0])
          const toolItems = context.bot.registry.itemsArray || []
          const toolItem = toolItems.find(i => i.id === toolTypeId)
          if (toolItem?.name) {
            for (const tt of TOOL_TYPES) {
              if (toolItem.name.endsWith(`_${tt}`)) return tt
            }
          }
        }
      }
    }

    return null
  }

  _minTierForBlock(blockName) {
    if (!blockName) return null
    const name = String(blockName).toLowerCase()
    return BLOCK_MIN_TIER[name] || null
  }

  _filterTools(items, toolType, minTier) {
    const suffix = `_${toolType}`

    const tools = items.filter(item => {
      const name = item.name
      if (!name) return false
      if (toolType === 'shears') return name === 'shears'
      if (!name.endsWith(suffix)) return false

      if (minTier) {
        const itemTier = this._extractTier(name)
        const minTierIdx = TOOL_TIER_ORDER.indexOf(minTier)
        const itemTierIdx = TOOL_TIER_ORDER.indexOf(itemTier)
        if (itemTierIdx > minTierIdx) return false
      }
      return true
    })

    return tools
  }

  _pickBestByTierAndDurability(tools, context = {}) {
    const scored = tools.map(tool => ({
      tool,
      tierIdx: TOOL_TIER_ORDER.indexOf(this._extractTier(tool.name)),
      durabilityPercent: this._getDurabilityPercent(tool, context)
    }))

    scored.sort((a, b) => {
      if (a.tierIdx !== b.tierIdx) return a.tierIdx - b.tierIdx
      return b.durabilityPercent - a.durabilityPercent
    })

    const winner = scored[0]
    if (winner.durabilityPercent <= this.options.durabilityWarnThreshold) {
      const backup = scored.find(s => s.durabilityPercent > this.options.durabilityWarnThreshold)
      if (backup) return backup.tool
    }

    return winner.tool
  }

  _extractTier(itemName) {
    if (!itemName) return 'unknown'
    const name = itemName.toLowerCase()
    if (name.startsWith('netherite_')) return 'netherite'
    if (name.startsWith('diamond_')) return 'diamond'
    if (name.startsWith('iron_')) return 'iron'
    if (name.startsWith('stone_')) return 'stone'
    if (name.startsWith('golden_')) return 'golden'
    if (name.startsWith('gold_')) return 'golden'
    if (name.startsWith('wooden_')) return 'wood'
    return 'unknown'
  }

  _normalizeArmorSlot(slot) {
    if (!slot) return null
    const name = String(slot).toLowerCase()
    if (ARMOR_SLOTS.includes(name)) return name
    if (name === 'head') return 'helmet'
    if (name === 'torso' || name === 'body') return 'chestplate'
    if (name === 'legs') return 'leggings'
    if (name === 'feet') return 'boots'
    return null
  }

  _isArmorForSlot(itemName, slot) {
    if (!itemName || !slot) return false
    return String(itemName).toLowerCase().endsWith(`_${slot}`)
  }

  _extractArmorTier(itemName) {
    if (!itemName) return 'unknown'
    const name = String(itemName).toLowerCase()
    if (name.startsWith('netherite_')) return 'netherite'
    if (name.startsWith('diamond_')) return 'diamond'
    if (name.startsWith('iron_')) return 'iron'
    if (name.startsWith('chainmail_')) return 'chainmail'
    if (name.startsWith('golden_')) return 'golden'
    if (name.startsWith('gold_')) return 'gold'
    if (name.startsWith('leather_')) return 'leather'
    return 'unknown'
  }

  _armorTierIndex(itemName) {
    const tier = this._extractArmorTier(itemName)
    const idx = ARMOR_TIER_ORDER.indexOf(tier)
    return idx === -1 ? ARMOR_TIER_ORDER.length : idx
  }

  _pickBestArmor(items, context = {}) {
    const scored = items.map(item => ({
      item,
      tierIdx: this._armorTierIndex(item.name),
      durabilityPercent: this._getDurabilityPercent(item, context)
    }))

    scored.sort((a, b) => {
      if (a.tierIdx !== b.tierIdx) return a.tierIdx - b.tierIdx
      return b.durabilityPercent - a.durabilityPercent
    })

    const winner = scored[0]
    if (winner.durabilityPercent <= this.options.durabilityWarnThreshold) {
      const backup = scored.find(s => s.durabilityPercent > this.options.durabilityWarnThreshold)
      if (backup) return backup.item
    }
    return winner?.item || null
  }

  _compareArmor(a, b, context = {}) {
    const tierA = this._armorTierIndex(a?.name)
    const tierB = this._armorTierIndex(b?.name)
    if (tierA !== tierB) return tierB - tierA
    return this._getDurabilityPercent(a, context) - this._getDurabilityPercent(b, context)
  }

  _getEquippedArmorItem(context = {}, slot) {
    const normalizedSlot = this._normalizeArmorSlot(slot)
    if (!normalizedSlot) return null
    const index = ARMOR_EQUIPMENT_SLOTS[normalizedSlot]
    return context.bot?.inventory?.slots?.[index] || context.bot?.equipment?.[ARMOR_DESTINATIONS[normalizedSlot]] || null
  }

  _summarizeArmorItem(item, context = {}) {
    if (!item) return null
    const maxDurability = item.maxDurability ||
      this._durabilityMap.get(item.name) ||
      this.options.maxDurabilityMap[item.name] ||
      this._estimateMaxDurability(item)
    return {
      name: item.name,
      durability: item.durability ?? null,
      maxDurability: maxDurability ?? null,
      durabilityPercent: this._getDurabilityPercent(item, context)
    }
  }

  _weaponTierIndex(itemName) {
    const name = itemName.toLowerCase()
    for (let i = 0; i < WEAPON_TIER_ORDER.length; i++) {
      if (name.startsWith(`${WEAPON_TIER_ORDER[i]}_`)) return i
    }
    if (name === 'bow') return 5
    if (name === 'crossbow') return 6
    if (name === 'trident') return 3
    return 7
  }

  _weaponType(itemName) {
    if (!itemName) return null
    const name = String(itemName).toLowerCase()
    if (name.endsWith('_sword')) return 'sword'
    if (name.endsWith('_axe')) return 'axe'
    if (name === 'bow') return 'bow'
    if (name === 'crossbow') return 'crossbow'
    if (name === 'trident') return 'trident'
    return null
  }

  _scoreWeapon(item, weaponType, context = {}) {
    const tier = this._extractTier(item?.name)
    const damageTable = WEAPON_DAMAGE[weaponType] || {}
    return {
      item,
      weaponType,
      tier,
      tierIdx: this._weaponTierIndex(item.name),
      damage: damageTable[tier] ?? damageTable.unknown ?? 1,
      typePriority: WEAPON_TYPE_PRIORITY[weaponType] || 0,
      durabilityPercent: this._getDurabilityPercent(item, context)
    }
  }

  _weaponSelection(item, weaponType, context = {}, reason = 'best_weapon_available', score = null) {
    const scored = score || this._scoreWeapon(item, weaponType, context)
    return {
      success: true,
      itemName: item.name,
      reason,
      weaponType,
      weaponTier: scored.tier,
      weaponDamage: scored.damage,
      durabilityPercent: scored.durabilityPercent
    }
  }

  _getDurabilityPercent(item, context = {}) {
    if (!item) return 1
    if (item.durability === undefined || item.durability === null) return 1

    const maxDurability = item.maxDurability ||
      this._durabilityMap.get(item.name) ||
      this.options.maxDurabilityMap[item.name] ||
      this._estimateMaxDurability(item)
    if (!maxDurability || maxDurability <= 0) return 1

    return Math.min(1, Math.max(0, item.durability / maxDurability))
  }

  _estimateMaxDurability(item) {
    if (!item?.name) return null
    const tier = this._extractTier(item.name)
    const baseDurability = {
      netherite: 2031, diamond: 1561, iron: 250, stone: 131, wooden: 59, wood: 59,
      chainmail: 240, leather: 80, gold: 32, golden: 32
    }
    const base = baseDurability[tier] || 250
    this._durabilityMap.set(item.name, base)
    return base
  }

  _getItems(context = {}) {
    return context.bot?.inventory?.items?.() || null
  }

  _getHeldItem(context = {}) {
    return context.bot?.heldItem || null
  }

  _isEdible(itemName, context = {}) {
    if (!itemName) return false
    const registry = context.bot?.registry
    if (registry?.foodsByName?.[itemName]) return true
    if (FOOD_ITEMS?.has?.(itemName)) return true
    return false
  }

  _fail(reason, extra = {}) {
    return { success: false, reason, ...extra }
  }
}

function getEquipmentLockOwner(context = {}, fallback) {
  return context.task?.id ||
    context.currentTask?.id ||
    context.taskManager?.currentTask?.id ||
    fallback
}

function formatToolTier(tier) {
  return tier === 'wood' ? 'wooden' : tier
}

function normalizeWeaponType(value) {
  if (!value) return null
  const text = String(value).toLowerCase()
  if (text.includes('sword')) return 'sword'
  if (text.includes('axe')) return 'axe'
  if (text.includes('bow')) return text.includes('cross') ? 'crossbow' : 'bow'
  if (text.includes('trident')) return 'trident'
  return null
}

module.exports = { EquipmentSystem, BLOCK_TOOL_MAP, BLOCK_MIN_TIER, TOOL_TIER_ORDER }
