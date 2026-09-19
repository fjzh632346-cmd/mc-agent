const POTTED_PLANT_ITEMS = Object.freeze({
  potted_azalea_bush: 'azalea',
  potted_flowering_azalea_bush: 'flowering_azalea'
})

const DOUBLE_HEIGHT_PLANT_BLOCKS = new Set([
  'large_fern',
  'lilac',
  'peony',
  'rose_bush',
  'sunflower',
  'tall_grass'
])

// Blocks vanilla renamed BETWEEN VERSIONS. Unlike BLOCK_ITEM_RENAMES below
// (block -> the item that places it, within one version), both spellings here
// name the same block; which one is real depends on which server you are
// talking to. `grass` exists on 1.20.1 and not on 1.21.8; `short_grass` is the
// other way round (verified against minecraft-data 3.110.2).
//
// Everything authored before the upgrade — community blueprints, stored
// construction records, the passable-vegetation predicates scattered through
// the build path — carries the old spelling, so name comparisons have to
// accept either one rather than being rewritten version by version.
const BLOCK_VERSION_RENAMES = Object.freeze({
  grass: 'short_grass'
})

const BLOCK_VERSION_RENAMES_REVERSED = Object.freeze(
  Object.fromEntries(Object.entries(BLOCK_VERSION_RENAMES).map(([from, to]) => [to, from]))
)

// Every spelling this block goes by, newest-known name first. A name with no
// cross-version alias returns just itself.
function blockNameAliases(blockName) {
  const name = String(blockName || '').replace(/^minecraft:/, '').trim()
  if (!name) return []
  const renamed = BLOCK_VERSION_RENAMES[name]
  if (renamed) return [renamed, name]
  const original = BLOCK_VERSION_RENAMES_REVERSED[name]
  if (original) return [name, original]
  return [name]
}

// Alias-aware name equality: `grass` and `short_grass` are the same block.
function isSameBlockName(candidate, blockName) {
  const aliases = blockNameAliases(blockName)
  if (!aliases.length) return false
  return blockNameAliases(candidate).some(alias => aliases.includes(alias))
}

// Blocks whose placed-block name differs from the inventory item that places
// them (vanilla renames). Community imports carry the block names, so both
// material planning and runtime equip must translate to the real item.
const BLOCK_ITEM_RENAMES = Object.freeze({
  redstone_wire: 'redstone',
  tripwire: 'string',
  cocoa: 'cocoa_beans',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  melon_stem: 'melon_seeds',
  attached_melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds',
  sweet_berry_bush: 'sweet_berries',
  bamboo_sapling: 'bamboo',
  kelp_plant: 'kelp',
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  weeping_vines_plant: 'weeping_vines',
  twisting_vines_plant: 'twisting_vines',
  big_dripleaf_stem: 'big_dripleaf',
  lava: 'lava_bucket',
  powder_snow: 'powder_snow_bucket'
})

function itemNameForBlock(blockName, blockStates = null) {
  const { name, states } = normalizeBlockMaterialInput(blockName, blockStates)
  if (!name) return name
  if (isUnsupportedSanitizedCampfireMaterial(name, states)) return 'stone'
  if (BLOCK_ITEM_RENAMES[name]) return BLOCK_ITEM_RENAMES[name]
  if (name === 'water') return 'water_bucket'
  if (name === 'dirt_path') return 'dirt'
  if (name === 'wall_torch') return 'torch'
  if (name.endsWith('_wall_torch')) return name.replace(/_wall_torch$/, '_torch')
  const wallSign = name.match(/^(.+)_wall_sign$/)
  if (wallSign) return `${wallSign[1]}_sign`
  const wallBanner = name.match(/^(.+)_wall_banner$/)
  if (wallBanner) return `${wallBanner[1]}_banner`
  const wallHead = name.match(/^(.+)_wall_head$/)
  if (wallHead) return `${wallHead[1]}_head`
  const wallSkull = name.match(/^(.+)_wall_skull$/)
  if (wallSkull) return `${wallSkull[1]}_skull`
  if (name.startsWith('potted_')) return 'flower_pot'
  return name
}

function itemNamesForBlock(blockName, blockStates = null) {
  const { name, states } = normalizeBlockMaterialInput(blockName, blockStates)
  if (isUnsupportedSanitizedCampfireMaterial(name, states)) return ['stone']
  if (!isPottedBlockName(name)) return [itemNameForBlock(name, states)].filter(Boolean)
  return ['flower_pot', plantItemNameForPottedBlock(name)].filter(Boolean)
}

function itemRequirementsForBlock(blockName, blockStates = null) {
  const { name, states } = normalizeBlockMaterialInput(blockName, blockStates)
  if (!name || isGeneratedMultiblockPartState(name, states)) return {}

  const primaryItemName = itemNameForBlock(name, states)
  const primaryItemCount = primaryItemCountForBlockState(name, states)
  const requirements = {}
  for (const itemName of itemNamesForBlock(name, states)) {
    requirements[itemName] = (requirements[itemName] || 0) +
      (itemName === primaryItemName ? primaryItemCount : 1)
  }
  return requirements
}

function normalizeBlockMaterialInput(blockName, blockStates = null) {
  if (blockName && typeof blockName === 'object') {
    return {
      name: String(blockName.type || blockName.blockName || blockName.name || blockName.id || ''),
      states: blockName.states || blockName.orientation || blockName.block?.states || blockStates || {}
    }
  }
  return {
    name: String(blockName || ''),
    states: blockStates || {}
  }
}

function isUnsupportedSanitizedCampfireMaterial(blockName, states = {}) {
  return String(blockName || '') === 'lantern' &&
    Object.prototype.hasOwnProperty.call(states || {}, 'signal_fire')
}

function isPottedBlockName(blockName) {
  return String(blockName || '').startsWith('potted_')
}

// Placing one bed item creates both halves, so the head block must not add a
// second bed item to material plans.
function isBedHeadBlockState(blockName, blockStates = null) {
  const { name, states } = normalizeBlockMaterialInput(blockName, blockStates)
  if (!/(^|_)bed$/.test(name)) return false
  return String(states?.part || '').toLowerCase() === 'head'
}

function isGeneratedMultiblockPartState(blockName, blockStates = null) {
  const { name, states } = normalizeBlockMaterialInput(blockName, blockStates)
  if (isBedHeadBlockState(name, states)) return true
  if (/_door$/.test(name) && String(states?.half || '').toLowerCase() === 'upper') return true
  return DOUBLE_HEIGHT_PLANT_BLOCKS.has(name) &&
    String(states?.half || '').toLowerCase() === 'upper'
}

function primaryItemCountForBlockState(blockName, blockStates = null) {
  const { name, states } = normalizeBlockMaterialInput(blockName, blockStates)
  if (/_slab$/.test(name) && String(states?.type || '').toLowerCase() === 'double') return 2
  if (name === 'candle' || /_candle$/.test(name)) return boundedStateCount(states, 'candles', 4)
  if (name === 'sea_pickle') return boundedStateCount(states, 'pickles', 4)
  if (name === 'turtle_egg') return boundedStateCount(states, 'eggs', 4)
  if (name === 'pink_petals') return boundedStateCount(states, 'flower_amount', 4)
  if (name === 'snow') return boundedStateCount(states, 'layers', 8)
  return 1
}

function boundedStateCount(states, key, maximum) {
  const count = Number(states?.[key])
  if (!Number.isFinite(count)) return 1
  return Math.max(1, Math.min(maximum, Math.trunc(count)))
}

function plantItemNameForPottedBlock(blockName) {
  const name = String(blockName || '')
  if (!isPottedBlockName(name)) return null
  return POTTED_PLANT_ITEMS[name] || name.replace(/^potted_/, '')
}

module.exports = {
  BLOCK_VERSION_RENAMES,
  blockNameAliases,
  isBedHeadBlockState,
  isGeneratedMultiblockPartState,
  isPottedBlockName,
  isSameBlockName,
  isUnsupportedSanitizedCampfireMaterial,
  itemNameForBlock,
  itemNamesForBlock,
  itemRequirementsForBlock,
  plantItemNameForPottedBlock
}
