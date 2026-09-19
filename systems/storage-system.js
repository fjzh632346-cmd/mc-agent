const storageActions = require('../actions/storage')
const { placeBlock } = require('../actions/build')
const { craftItem } = require('../actions/craft')
const { getInventoryCounts } = require('../tasks/task-utils')
const { foodCategory, getFoodCandidates, selectFoodItem } = require('../utils/food')
const { toBlockVec3 } = require('../utils/position')

const DEFAULT_FOOD_WITHDRAW_COUNT = 8
const DEFAULT_SEED_WITHDRAW_COUNT = 8
const DEFAULT_ITEM_WITHDRAW_COUNT = 16
const DEFAULT_CATEGORY_WITHDRAW_COUNT = 8

const ESSENTIAL_ITEMS = new Set([
  'torch', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple',
  'golden_apple', 'carrot', 'baked_potato'
])

const ESSENTIAL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword']
const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots']
const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe']
const WEAPON_NAMES = new Set(['bow', 'crossbow', 'trident'])
const TIER_SCORE = { netherite: 7, diamond: 6, iron: 5, chainmail: 4, stone: 3, golden: 2, gold: 2, leather: 1, wood: 1, wooden: 1 }
const CATEGORY_ITEM_NAMES = new Set([
  'armor', 'equipment', 'weapon', 'tool', 'food',
  'wood', 'logs', 'planks',
  'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood',
  'acacia_wood', 'dark_oak_wood', 'mangrove_wood', 'cherry_wood'
])

const LOG_ITEM_NAMES = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'stripped_oak_log', 'stripped_spruce_log', 'stripped_birch_log', 'stripped_jungle_log',
  'stripped_acacia_log', 'stripped_dark_oak_log', 'stripped_mangrove_log', 'stripped_cherry_log',
  'crimson_stem', 'warped_stem', 'stripped_crimson_stem', 'stripped_warped_stem'
]
const WOOD_BLOCK_ITEM_NAMES = [
  'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood', 'dark_oak_wood', 'mangrove_wood', 'cherry_wood',
  'stripped_oak_wood', 'stripped_spruce_wood', 'stripped_birch_wood', 'stripped_jungle_wood',
  'stripped_acacia_wood', 'stripped_dark_oak_wood', 'stripped_mangrove_wood', 'stripped_cherry_wood'
]
const PLANK_ITEM_NAMES = [
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
  'mangrove_planks', 'cherry_planks', 'crimson_planks', 'warped_planks'
]
const WOOD_CATEGORY_ITEM_NAMES = [...LOG_ITEM_NAMES, ...WOOD_BLOCK_ITEM_NAMES, ...PLANK_ITEM_NAMES]
const WOOD_SPECIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']

// —— 临时箱子中转（老板决策 #89-C）——
// 现场（建造 25 真机）：清地皮捡到草皮后空位 <= 1，生存系统按设计把建造按停、
// 改派 INVENTORY_FULL_STORE，可方圆 32 格一只箱子都没有（最近的在 119.6 格外），
// 于是 chest_not_found 每 30 秒重来一次，建造永远起不来。
// 这里给它开一个口子：就地放一只临时箱子当工地物资箱，再走原来的存料流程。
// 只有调用方显式授权（options.placeTemporaryChest === true）才会走到这里，
// 其余所有存料路径一个字节都没动。
const TEMPORARY_CHEST_PLANK_COST = 8
const TEMPORARY_CHEST_AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])
// 脚下不算实心的：放上去要么放不住，要么箱子当场被淹/被烧。
const TEMPORARY_CHEST_UNSUPPORTIVE_NAMES = new Set([
  ...TEMPORARY_CHEST_AIR_NAMES,
  'water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column',
  'fire', 'soul_fire', 'snow', 'light', 'structure_void',
  'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'seagrass', 'kelp',
  'torch', 'wall_torch', 'redstone_wire', 'rail', 'ladder', 'vine'
])
// 站位周围先近后远，y 与她脚下同高——箱子要伸手就够得到。
const TEMPORARY_CHEST_OFFSETS = Object.freeze([
  { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
  { x: 1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: 1 }, { x: -1, z: -1 },
  { x: 2, z: 0 }, { x: -2, z: 0 }, { x: 0, z: 2 }, { x: 0, z: -2 }
])
const TEMPORARY_CHEST_CONTAINER_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const CONSTRUCTION_TASK_TYPE = 'build_blueprint'
const OWNED_LOCK_TYPES = ['movement', 'combat', 'inventory', 'digging', 'building', 'crafting']

class StorageSystem {
  constructor(options = {}) {
    this.options = {
      chestSearchRadius: 24,
      ...options
    }
    this.status = {
      storageStatus: 'IDLE',
      targetChest: null,
      storedItems: [],
      withdrawnItems: [],
      missingItems: [],
      lastStorageError: null
    }
    this.invalidChestPositions = new Set()
  }

  rememberChest(context, position = null, options = {}) {
    const chest = position ? { position } : this.findNearbyChestBlock(context)
    if (!chest?.position) return this.fail('chest_not_found')
    const record = context.memory?.world?.addChestLocation?.(chest.position, {
      source: options.source || 'storage_system',
      tags: options.tags || ['storage']
    })
    if (!record) return this.fail('memory_missing')
    this.status.targetChest = record
    this.status.storageStatus = 'REMEMBERED'
    this.status.lastStorageError = null
    return { ok: true, record, targetChest: record }
  }

  findBestChest(context, options = {}) {
    const candidates = this.buildChestCandidates(context, options)
    const selected = candidates[0]
    if (!selected?.position) {
      const builtChestArea = findBuiltChestArea(context)
      if (builtChestArea?.origin) {
        return {
          ok: false,
          error: 'chest_area_has_no_confirmed_chest',
          chestArea: builtChestArea
        }
      }
      return { ok: false, error: 'chest_not_found' }
    }

    const record = context.memory?.world?.addChestLocation?.(selected.position, {
      source: selected.source || 'nearby_scan',
      tags: ['storage']
    }) || { position: selected.position, type: selected.name || 'chest' }
    console.log(`[CHEST_SELECTED] pos=${formatPos(record.position)} reason=${selected.source || selected.chestType || 'valid'}`)
    return { ok: true, chest: record, source: selected.source || 'nearby', candidate: selected }
  }

  async getStagingInventory(context, options = {}) {
    const candidates = this.buildChestCandidates(context, {
      radius: options.radius || this.options.chestSearchRadius,
      scanCenters: options.scanCenters || options.storageScanCenters || options.anchorPositions,
      scanOnlyProvidedCenters: true,
      exactScanCenters: true,
      skipUtilitySearch: true,
      skipMemorySearch: true
    })
    const counts = {}
    const chests = []
    const failures = []
    for (const candidate of candidates) {
      const opened = await storageActions.openChest(context, candidate.position, {
        owner: options.owner,
        holdLock: true
      })
      if (!opened.ok) {
        failures.push({ position: candidate.position, error: opened.error || 'open_failed' })
        continue
      }
      try {
        const items = storageActions.getChestItems(opened.chestWindow)
        for (const item of items) {
          const name = item.itemName || item.name
          if (!name) continue
          counts[name] = (counts[name] || 0) + (Number(item.count) || 0)
        }
        chests.push({
          position: candidate.position,
          source: candidate.source || null,
          itemCount: items.reduce((sum, item) => sum + (Number(item.count) || 0), 0)
        })
      } finally {
        storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
      }
    }
    return {
      ok: failures.length === 0 || chests.length > 0,
      counts,
      chests,
      failures
    }
  }

  async readStagingInventory(context, options = {}) {
    return this.getStagingInventory(context, options)
  }

  async readCandidateInventory(context, candidate, options = {}) {
    const opened = await this.openCandidateChest(context, candidate, options)
    if (!opened.ok) {
      return {
        ok: false,
        counts: {},
        chests: [],
        failures: [{ position: candidate?.position || null, error: opened.error || 'open_failed' }],
        error: opened.error || 'open_failed'
      }
    }
    try {
      const items = storageActions.getChestItems(opened.chestWindow)
      const counts = {}
      for (const item of items) {
        const name = item.itemName || item.name
        if (!name) continue
        counts[name] = (counts[name] || 0) + (Number(item.count) || 0)
      }
      return {
        ok: true,
        counts,
        chests: [{
          position: candidate.position,
          source: candidate.source || 'exact_staging_target',
          itemCount: items.reduce((sum, item) => sum + (Number(item.count) || 0), 0)
        }],
        failures: []
      }
    } finally {
      storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
    }
  }

  async ensureStagingMaterials(context, options = {}) {
    const required = normalizeRequiredMaterialMap(options.required || options.requirements || {})
    for (const entry of options.missing || []) {
      if (!entry?.item) continue
      required[entry.item] = Math.max(Number(required[entry.item]) || 0, Number(entry.required || entry.missing || 0))
    }
    if (!Object.keys(required).length) {
      return { ok: true, moved: [], missing: [], verified: true, reason: 'no_staging_materials_required' }
    }
    if (isDangerHigh(context)) return { ok: false, error: 'danger_too_high' }

    let targets = this.resolveStagingTargets(context, options)
    const target = targets[0] || null
    if (!target?.position) return { ok: false, error: 'staging_chest_not_found' }

    const moved = []
    const failures = []
    let staging = await this.readStagingTargetsInventory(context, targets, {
      owner: options.owner,
      reason: 'ensure_staging_materials_initial'
    })
    let counts = staging.counts || {}

    for (const [itemName, requiredCount] of Object.entries(required)) {
      let remaining = Math.max(0, requiredCount - (Number(counts[itemName]) || 0))
      if (remaining <= 0) continue

      const inventoryMove = Math.min(remaining, inventoryItemCount(context, itemName))
      if (inventoryMove > 0) {
        const deposited = await this.depositToAnyStagingTarget(context, targets, itemName, inventoryMove, options)
        if (!deposited.ok) {
          failures.push({ item: itemName, count: inventoryMove, source: 'inventory', error: deposited.error })
        } else {
          const count = deposited.count || 0
          moved.push({ item: itemName, count, source: 'inventory', targetChest: deposited.targetChest })
          targets = preferTargetFirst(targets, deposited.targetChest)
          counts[itemName] = (Number(counts[itemName]) || 0) + count
          remaining = Math.max(0, remaining - count)
        }
      }

      if (remaining > 0) {
        const transfer = await this.moveItemFromSourceChestToStaging(context, itemName, remaining, targets, options)
        if (transfer.ok && transfer.moved > 0) {
          moved.push(...transfer.movedItems)
          targets = preferTargetFirst(targets, transfer.movedItems.at(-1)?.targetChest)
          counts[itemName] = (Number(counts[itemName]) || 0) + transfer.moved
          remaining = Math.max(0, remaining - transfer.moved)
        }
        let craftError = null
        const maxCraftAttempts = Math.max(1, Number(options.maxStagingCraftAttempts) || 3)
        for (let attempt = 0; remaining > 0 && attempt < maxCraftAttempts; attempt += 1) {
          const crafted = await this.craftMissingMaterialToStaging(context, itemName, remaining, targets, {
            ...options,
            knownStorageCounts: counts
          })
          if (crafted.ok && crafted.count > 0) {
            moved.push({
              item: itemName,
              count: crafted.count,
              source: 'crafted',
              targetChest: crafted.targetChest,
              prepared: crafted.prepared,
              partial: crafted.partial === true
            })
            targets = preferTargetFirst(targets, crafted.targetChest)
            counts[itemName] = (Number(counts[itemName]) || 0) + crafted.count
            remaining = Math.max(0, remaining - crafted.count)
            craftError = crafted.partial ? (crafted.error || craftError) : null
            continue
          }
          craftError = crafted.error || craftError
          break
        }
        if (remaining > 0) {
          failures.push({
            item: itemName,
            count: remaining,
            source: 'storage',
            error: craftError || transfer.error || `staging_material_shortage:${itemName}:${remaining}`
          })
        }
      }
    }

    const finalInventory = await this.readStagingTargetsInventory(context, targets, {
      owner: options.owner,
      reason: 'ensure_staging_materials_final_verify'
    })
    const finalCounts = finalInventory.counts || {}
    const missing = missingMaterialsFromCounts(required, finalCounts)
    if (missing.length) {
      return {
        ok: false,
        error: `BLOCKED_MATERIAL_SHORTAGE:${missing.map(entry => `${entry.item}:${entry.missing}`).join(',')}`,
        targetChest: target,
        targetChests: targets,
        moved,
        failures,
        missing,
        inventory: finalCounts
      }
    }
    return {
      ok: true,
      targetChest: target,
      targetChests: targets,
      moved,
      failures,
      missing: [],
      inventory: finalCounts,
      verified: true
    }
  }

  async moveMaterialsToStaging(context, options = {}) {
    return this.ensureStagingMaterials(context, options)
  }

  async craftMissingMaterialToStaging(context, itemName, count, targets = [], options = {}) {
    if (options.allowCrafting === false) {
      return { ok: false, skipped: true, error: 'staging_material_crafting_disabled' }
    }

    const autoPreparationSystem = context.autoPreparationSystem
    if (typeof autoPreparationSystem?.ensureItem !== 'function') {
      return { ok: false, skipped: true, error: 'auto_preparation_unavailable' }
    }

    const requested = Math.max(1, Number(count) || 1)
    const before = liveInventoryItemCount(context, itemName)
    const craftContext = contextWithStorageCounts(context, options.knownStorageCounts || {})
    console.log(`[STAGING_CRAFT_ATTEMPT] item=${itemName} count=${requested}`)
    const prepared = await autoPreparationSystem.ensureItem(craftContext, itemName, requested, {
      allowStorage: true,
      owner: options.owner || 'staging_material_crafting',
      query: options.query || itemName,
      mode: options.craftMode || 'specified',
      scanCenters: options.sourceScanCenters || options.storageScanCenters || options.scanCenters,
      scanOnlyProvidedCenters: options.scanOnlyProvidedCenters ?? Boolean(options.sourceScanCenters || options.storageScanCenters || options.scanCenters),
      exactScanCenters: options.exactScanCenters,
      skipUtilitySearch: options.skipUtilitySearch,
      skipMemorySearch: options.skipMemorySearch,
      sourceContainerPreference: options.sourceContainerPreference,
      canDig: options.canDig,
      purpose: `staging_material:${itemName}`
    })
    const available = liveInventoryItemCount(context, itemName)
    const gained = Math.max(0, available - before)
    const preparedOk = prepared?.ok === true
    const depositCount = Math.min(requested, preparedOk ? available : gained)
    const partialError = prepared?.reason || prepared?.error || null
    if (depositCount <= 0) {
      const error = partialError || `crafted_item_not_in_inventory:${itemName}`
      console.log(`[STAGING_CRAFT_FAILED] item=${itemName} count=${requested} reason=${error}`)
      return { ok: false, error, prepared, before, available, gained }
    }

    const deposited = await this.depositToAnyStagingTarget(context, targets, itemName, depositCount, options)
    if (!deposited.ok || deposited.count <= 0) {
      const error = deposited.error || `staging_crafted_deposit_failed:${itemName}`
      console.log(`[STAGING_CRAFT_DEPOSIT_FAILED] item=${itemName} count=${depositCount} reason=${error}`)
      return { ok: false, error, prepared, deposited, before, available, gained }
    }

    const partial = !preparedOk || deposited.count < requested
    const status = partial ? 'PARTIAL' : 'SUCCESS'
    console.log(`[STAGING_CRAFT_${status}] item=${itemName} crafted=${gained || depositCount} deposited=${deposited.count}${partialError ? ` reason=${partialError}` : ''}`)
    return {
      ok: true,
      item: itemName,
      count: deposited.count,
      partial,
      error: partialError,
      targetChest: deposited.targetChest,
      prepared,
      deposited,
      before,
      available,
      gained
    }
  }

  async readStagingTargetsInventory(context, targets = [], options = {}) {
    const counts = {}
    const chests = []
    const failures = []
    for (const target of targets || []) {
      const inventory = await this.readCandidateInventory(context, target, options)
      for (const [itemName, count] of Object.entries(inventory.counts || {})) {
        counts[itemName] = (counts[itemName] || 0) + (Number(count) || 0)
      }
      chests.push(...(inventory.chests || []))
      failures.push(...(inventory.failures || []))
    }
    return {
      ok: failures.length === 0 || chests.length > 0,
      counts,
      chests,
      failures
    }
  }

  resolveExactStagingTarget(context, options = {}) {
    return this.resolveStagingTargets(context, options)[0] || null
  }

  resolveStagingTargets(context, options = {}) {
    const centers = options.scanCenters || options.stagingChests || options.targetScanCenters || []
    const targets = []
    const seen = new Set()
    for (const center of centers) {
      const position = center?.position || center
      if (!position) continue
      const lookup = storageActions.lookupLiveContainerBlock(context.bot, position, { log: true })
      if (!lookup.block) continue
      const key = posKey(lookup.block.position || position)
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({
        position: lookup.block.position || position,
        name: lookup.block.name,
        chestType: center.chestType || center.type || lookup.block.name,
        source: center.source || 'staging_target'
      })
    }
    if (targets.length) return targets

    const candidates = this.buildChestCandidates(context, {
      ...options,
      scanOnlyProvidedCenters: true,
      exactScanCenters: true,
      skipUtilitySearch: true,
      skipMemorySearch: true
    })
    return candidates
  }

  async depositToAnyStagingTarget(context, targets, itemName, count, options = {}) {
    let remaining = Math.max(0, Number(count) || 0)
    let moved = 0
    let lastError = null
    let lastTarget = null
    for (const target of targets || []) {
      if (remaining <= 0) break
      const deposited = await this.depositToCandidate(context, target, itemName, remaining, options)
      if (!deposited.ok || deposited.count <= 0) {
        lastError = deposited.error || `deposit_moved_zero:${itemName}`
        continue
      }
      moved += deposited.count
      remaining = Math.max(0, remaining - deposited.count)
      lastTarget = target
    }
    return {
      ok: moved > 0,
      count: moved,
      itemName,
      targetChest: lastTarget || targets?.[0] || null,
      error: moved > 0 ? null : (lastError || `staging_deposit_failed:${itemName}`)
    }
  }

  async depositToCandidate(context, candidate, itemName, count, options = {}) {
    const opened = await this.openCandidateChest(context, candidate, options)
    if (!opened.ok) return { ok: false, error: opened.error }
    try {
      const deposited = await storageActions.depositItem(context, opened.chestWindow, itemName, count, {
        owner: options.owner,
        holdLock: true
      })
      if (!deposited.ok) return { ok: false, error: deposited.error }
      return { ok: true, count: deposited.data?.count || 0, itemName, targetChest: candidate }
    } finally {
      storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
    }
  }

  async moveItemFromSourceChestToStaging(context, itemName, count, target, options = {}) {
    const targets = Array.isArray(target) ? target : [target].filter(Boolean)
    const targetKeys = new Set(targets.map(candidate => posKey(candidate.position)))
    const sourceCandidates = this.buildChestCandidates(context, {
      ...options,
      scanCenters: options.sourceScanCenters || options.sourceChests || options.storageScanCenters,
      scanOnlyProvidedCenters: Boolean(options.sourceScanCenters || options.sourceChests || options.storageScanCenters),
      exactScanCenters: options.exactScanCenters === true,
      containerPreference: options.sourceContainerPreference || 'any'
    }).filter(candidate => !targetKeys.has(posKey(candidate.position)))
    if (!sourceCandidates.length) return { ok: false, error: 'source_chest_not_found', moved: 0, movedItems: [] }

    let moved = 0
    const movedItems = []
    let lastError = null
    for (const source of sourceCandidates) {
      if (moved >= count) break
      const available = await this.countItemInCandidate(context, source, { ...options, itemName })
      if (!available.ok || available.count <= 0) {
        lastError = available.error || `chest_item_not_found:${itemName}`
        continue
      }
      const amount = Math.min(count - moved, available.count, Math.max(1, inventoryCapacityForItem(context, itemName)))
      const sourceOpened = await this.openCandidateChest(context, source, options)
      if (!sourceOpened.ok) {
        lastError = sourceOpened.error
        continue
      }
      let withdrawn = null
      try {
        withdrawn = await storageActions.withdrawItem(context, sourceOpened.chestWindow, itemName, amount, {
          owner: options.owner,
          query: options.query || itemName,
          holdLock: true
        })
      } finally {
        storageActions.closeChest(context, sourceOpened.chestWindow, { owner: options.owner })
      }
      if (!withdrawn?.ok || (withdrawn.data?.count || 0) <= 0) {
        lastError = withdrawn?.error || `withdraw_moved_zero:${itemName}`
        continue
      }

      const deposited = await this.depositToAnyStagingTarget(context, targets, itemName, withdrawn.data.count, options)
      if (!deposited.ok || deposited.count <= 0) {
        lastError = deposited.error || `deposit_moved_zero:${itemName}`
        continue
      }
      moved += deposited.count
      movedItems.push({
        item: itemName,
        count: deposited.count,
        source: 'storage',
        sourceChest: source,
        targetChest: deposited.targetChest
      })
    }

    return {
      ok: moved >= count,
      moved,
      movedItems,
      error: moved >= count ? null : (lastError || `staging_material_shortage:${itemName}:${count - moved}`)
    }
  }

  buildChestCandidates(context, options = {}) {
    const botPosition = context.bot?.entity?.position || context.blackboard?.get?.('bot.position')
    const byPos = new Map()
    const nearby = storageActions.findNearbyChests(context, options.radius || this.options.chestSearchRadius, {
      invalidPositions: this.invalidChestPositions,
      playerName: options.playerName,
      scanCenters: options.scanCenters || options.storageScanCenters || options.anchorPositions,
      scanOnlyProvidedCenters: options.scanOnlyProvidedCenters === true,
      exactScanCenters: options.exactScanCenters === true
    })
    if (nearby.ok) {
      for (const chest of nearby.data.chests || []) {
        if (chest?.position) byPos.set(posKey(chest.position), chest)
      }
    }

    const utilityChest = options.skipUtilitySearch === true ? null : context.utilityBlockSearch?.findNearestChest?.(context, {
      nearbyRadius: Math.max(options.radius || this.options.chestSearchRadius, 24),
      baseRadius: 64
    })
    if (utilityChest?.ok && utilityChest.position) {
      const key = posKey(utilityChest.position)
      if (!byPos.has(key)) {
        byPos.set(key, {
          position: utilityChest.position,
          name: utilityChest.block?.name || 'chest',
          chestType: utilityChest.block?.name || 'chest',
          source: utilityChest.source || 'utility_search',
          distance: utilityChest.distance,
          botDistance: utilityChest.distance
        })
      }
    }

    const remembered = options.skipMemorySearch === true ? null : context.memory?.world?.nearestChest?.(botPosition)
    if (remembered?.position && !this.invalidChestPositions.has(posKey(remembered.position))) {
      const lookup = storageActions.lookupLiveContainerBlock(context.bot, remembered.position, { log: true })
      if (!lookup.block) {
        this.invalidateChest(context, remembered.position, 'block_changed', lookup.name || null)
      } else {
        const key = posKey(remembered.position)
        if (!byPos.has(key)) {
          byPos.set(key, {
            position: remembered.position,
            name: lookup.block.name,
            chestType: remembered.type || lookup.block.name,
            source: 'memory',
            distance: distance(botPosition, remembered.position),
            botDistance: distance(botPosition, remembered.position)
          })
        }
      }
    }

    const withinRange = filterChestCandidatesByDistance([...byPos.values()], botPosition, options.maxDistance)
    const candidates = sortChestCandidates(withinRange, options)
    console.log(`[CHEST_CANDIDATES_SORTED] items=${JSON.stringify(candidates.map(chestCandidateLog))}`)
    return candidates
  }

  async storeItems(context, options = {}) {
    const category = normalizeCategory(options.category || options.itemCategory || (options.itemName && CATEGORY_ITEM_NAMES.has(options.itemName) ? options.itemName : null))
    console.log(`[STORAGE_TASK_START] mode=deposit itemQuery=${options.query || options.itemName || category || options.mode || 'auto'}`)
    console.log(`[storage] request=deposit category=${category || 'none'} selectedItems=[] result=start`)
    if (isDangerHigh(context)) return this.fail('danger_too_high')

    let items = selectItemsToStore(context, { ...options, category })
    if (!items.length) {
      if (category) console.log(`[storage] category=${category} matchedItems=[] result=no_matching_items`)
      return this.fail(category ? 'no_matching_items' : 'no_storable_items')
    }
    // 兜底口子（决策 #89-C）：范围内一只箱子都没有时先就地放一只。
    // 放箱/合成都动过背包，所以放成了要把要存的清单重算一遍。
    let temporaryChest = null
    if (options.placeTemporaryChest === true) {
      const deployed = await this.ensureTemporaryChest(context, options)
      if (deployed.ok) {
        temporaryChest = deployed
        // 放箱子（少一只 chest）和合成（少 8 块木板）都动过背包，
        // 黑板还是上一拍的数，所以这一次重算读实时背包。
        items = selectItemsToStore(context, { ...options, category, inventoryCounts: liveInventoryCounts(context) })
        if (!items.length) return this.fail('no_storable_items')
      }
    }
    if (category) {
      console.log(`[storage] mode=deposit category=${category} matchedItems=[${items.map(item => item.itemName).join(',')}] deposited=[]`)
    }

    const opened = await this.openBestChest(context, options)
    if (!opened.ok) return this.fail(opened.error)
    const chest = opened.chest

    const storedItems = []
    const missingItems = []
    try {
      for (const item of items) {
        const deposited = await storageActions.depositItem(context, opened.chestWindow, item.itemName, item.count, {
          owner: options.owner,
          holdLock: true
        })
        if (!deposited.ok) {
          if (isInventoryItemMissing(deposited.error)) {
            missingItems.push(missingItemRecord(item.itemName, category, item.count))
            console.log(`[CHEST_DEPOSIT_SKIP] item=${item.itemName} reason=${deposited.error}`)
            continue
          }
          return this.fail(deposited.error)
        }
        if ((deposited.data?.count || 0) <= 0) {
          missingItems.push(missingItemRecord(item.itemName, category, item.count))
          console.log(`[CHEST_DEPOSIT_SKIP] item=${item.itemName} reason=deposit_moved_zero`)
          continue
        }
        storedItems.push(deposited.data)
      }
    } finally {
      storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
    }

    if (!storedItems.length) {
      const reason = missingItems.length ? `inventory_item_not_found:${missingItems[0].itemName}` : 'deposit_moved_zero'
      return this.fail(reason)
    }

    this.status = {
      ...this.status,
      storageStatus: 'COMPLETED',
      targetChest: chest,
      storedItems,
      withdrawnItems: [],
      missingItems,
      lastStorageError: missingItems.length ? 'partial_deposit_missing_items' : null
    }
    if (missingItems.length) console.log(`[STORAGE_DEPOSIT_PARTIAL] missing=${JSON.stringify(missingItems)}`)
    if (temporaryChest) {
      console.log(`[TEMP_CHEST_STORED] pos=${formatPos(temporaryChest.position)} source=${temporaryChest.source} kinds=${storedItems.length} items=${JSON.stringify(storedItems.map(entry => ({ item: entry.itemName, count: entry.count })))}`)
    }
    console.log('[STORAGE_TASK_SUCCESS] mode=deposit')
    console.log(`[storage] mode=deposit category=${category || 'none'} matchedItems=[${items.map(item => item.itemName).join(',')}] deposited=${JSON.stringify(storedItems)} missing=${JSON.stringify(missingItems)} result=ok`)
    return { ok: true, storedItems, missingItems, targetChest: chest }
  }

  async storeNonEssentialItems(context, options = {}) {
    return this.storeItems(context, { ...options, mode: 'nonEssential' })
  }

  // 决策 #89-C 的落地：范围内没箱子就地放一只，登记成她自己的箱子。
  // 任何一步不成就返回 not-ok，调用方照旧走 openBestChest -> chest_not_found，
  // 行为不比改前差。
  async ensureTemporaryChest(context, options = {}) {
    if (this.buildChestCandidates(context, options).length) {
      return { ok: false, error: 'chest_already_in_range' }
    }

    // 先挑位置再动背包：挑不到就白合成一只，而木板多半是这一栋的材料。
    const spot = findTemporaryChestSpot(context, options)
    if (!spot) return { ok: false, error: 'temporary_chest_no_spot' }

    const acquired = await this.acquireTemporaryChestItem(context, options)
    if (!acquired.ok) {
      console.log(`[TEMP_CHEST_SKIPPED] pos=${formatPos(spot)} reason=${acquired.error}`)
      return acquired
    }

    const placed = await withOwnerLocksPreserved(context, options.owner, () => placeBlock(context, spot, 'chest', {
      owner: options.owner,
      shouldContinue: options.shouldContinue,
      canDig: false
    }))
    if (!placed.ok) {
      console.log(`[TEMP_CHEST_SKIPPED] pos=${formatPos(spot)} reason=place_failed:${placed.error}`)
      return { ok: false, error: `temporary_chest_place_failed:${placed.error}` }
    }
    if (!TEMPORARY_CHEST_CONTAINER_NAMES.has(blockNameAt(context, spot))) {
      console.log(`[TEMP_CHEST_SKIPPED] pos=${formatPos(spot)} reason=place_unverified`)
      return { ok: false, error: 'temporary_chest_place_unverified' }
    }

    // 登记成她自己的箱子，走的是现有的箱子登记路径——
    // 以后的就近卸货/取料才找得到它。
    const remembered = this.rememberChest(context, spot, {
      source: 'temporary_worksite_chest',
      tags: ['storage', 'worksite', 'temporary'],
      name: '工地物资箱',
      description: '背包满时就地放下的临时中转箱'
    })
    console.log(`[TEMP_CHEST_PLACED] pos=${formatPos(spot)} source=${acquired.source} registered=${remembered.ok === true} keepItems=${(options.keepItems || []).length}`)
    return { ok: true, position: spot, source: acquired.source, registered: remembered.ok === true }
  }

  async acquireTemporaryChestItem(context, options = {}) {
    if (liveItemCount(context, 'chest') > 0) return { ok: true, source: 'inventory' }

    const plank = plankForChestCraft(context)
    if (!plank) return { ok: false, error: 'no_chest_and_no_planks' }

    const crafted = await withOwnerLocksPreserved(context, options.owner, () => craftItem(context, 'chest', 1, {
      owner: options.owner,
      shouldContinue: options.shouldContinue
    }))
    if (!crafted.ok) return { ok: false, error: `chest_craft_failed:${crafted.error}` }
    if (liveItemCount(context, 'chest') <= 0) return { ok: false, error: 'chest_craft_unverified' }
    console.log(`[TEMP_CHEST_CRAFTED] planks=${plank} cost=${TEMPORARY_CHEST_PLANK_COST}`)
    return { ok: true, source: `crafted:${plank}` }
  }

  async takeItems(context, options = {}) {
    const category = normalizeCategory(options.category || options.itemCategory || (options.itemName && CATEGORY_ITEM_NAMES.has(options.itemName) ? options.itemName : null))
    console.log(`[STORAGE_TASK_START] mode=withdraw itemQuery=${options.query || options.itemName || category || 'unknown'}`)
    console.log(`[storage] request=withdraw category=${category || 'none'} selectedItems=[] result=start`)
    if (!storageShouldContinue(options)) return this.fail('task_interrupted')
    if (isDangerHigh(context)) return this.fail('danger_too_high')
    if (!options.itemName && !category) return this.fail('item_name_unrecognized')

    const result = category
      ? await this.withdrawCategoryFromCandidates(context, { ...options, category })
      : options.itemName === 'food'
      ? await this.withdrawFoodFromCandidates(context, options)
      : await this.withdrawItemFromCandidates(context, options)

    if (!storageShouldContinue(options)) return this.fail('task_interrupted')

    if (!result.ok) {
      this.status.missingItems = [missingItemRecord(options.itemName || null, category, options.count || 1)]
      console.log(`[STORAGE_TASK_FAILED] reason=${result.error}`)
      console.log(`[storage] request=withdraw category=${category || 'none'} selectedItems=[] result=${result.error}`)
      return this.fail(result.error)
    }

    let equipResult = null
    if (options.equipAfter && category === 'armor') {
      equipResult = await context.equipmentSystem?.equipBestArmor?.(context, { reason: 'storage_fetch_and_equip' }) || null
      console.log(`[armor] current=${JSON.stringify(context.equipmentSystem?.getArmorStatus?.(context) || null)} available=${JSON.stringify(context.equipmentSystem?.getArmorStatus?.(context)?.bestAvailableArmor || {})} selected=${JSON.stringify(equipResult?.results || [])} equipped=${equipResult?.equippedCount || 0} reason=storage_fetch_and_equip`)
    }

    this.status = {
      ...this.status,
      storageStatus: 'COMPLETED',
      targetChest: result.targetChest,
      storedItems: [],
      withdrawnItems: result.withdrawnItems,
      missingItems: [],
      lastStorageError: null
    }
    console.log('[STORAGE_TASK_SUCCESS] mode=withdraw')
    console.log(`[storage] request=withdraw category=${category || 'none'} selectedItems=${JSON.stringify(result.withdrawnItems || [])} result=ok`)
    return { ok: true, withdrawnItems: result.withdrawnItems, targetChest: result.targetChest, equipResult }
  }

  async checkStorage(context, options = {}) {
    console.log(`[STORAGE_TASK_START] mode=check itemQuery=${options.query || options.itemName || 'any'}`)
    const opened = await this.openBestChest(context, options)
    if (!opened.ok) return this.fail(opened.error)
    const chest = opened.chest

    let summary
    try {
      summary = storageActions.getChestSummary(context, opened.chestWindow)
    } finally {
      storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
    }
    if (!summary.ok) return this.fail(summary.error)
    this.status = {
      ...this.status,
      storageStatus: 'COMPLETED',
      targetChest: chest,
      lastStorageError: null
    }
    console.log('[STORAGE_TASK_SUCCESS] mode=check')
    return { ok: true, targetChest: chest, summary: summary.data }
  }

  async transferItems(context, options = {}) {
    console.log(`[STORAGE_TRANSFER_START] item=${options.itemName || 'unknown'} count=${options.count || 'all'} sourcePref=${options.sourceContainerPreference || 'any'} targetPref=${options.targetContainerPreference || 'any'}`)
    if (isDangerHigh(context)) return this.failTransfer('danger_too_high')
    if (!options.itemName) return this.failTransfer('missing_item_name')

    const sourceOptions = {
      ...options,
      containerPreference: options.sourceContainerPreference || 'any'
    }
    const source = this.buildChestCandidates(context, sourceOptions)[0]
    if (!source?.position) return this.failTransfer('source_chest_not_found')
    console.log(`[TRANSFER_SOURCE_SELECTED] pos=${formatPos(source.position)} type=${source.chestType || 'unknown'}`)

    const targetOptions = {
      ...options,
      containerPreference: options.targetContainerPreference || 'any'
    }
    const target = this.buildChestCandidates(context, targetOptions)
      .find(candidate => posKey(candidate.position) !== posKey(source.position))
    if (!target?.position) return this.failTransfer('target_chest_not_found')
    console.log(`[TRANSFER_TARGET_SELECTED] pos=${formatPos(target.position)} type=${target.chestType || 'unknown'}`)

    const initial = await this.countItemInCandidate(context, source, options)
    if (!initial.ok) return this.failTransfer(initial.error)
    const desiredTotal = withdrawCount(context, options.itemName, options.count || 'all', initial.count)
    if (desiredTotal <= 0) return this.failTransfer(`chest_item_not_found:${options.itemName}`)

    let moved = 0
    const withdrawnItems = []
    const depositedItems = []
    while (moved < desiredTotal) {
      const remaining = desiredTotal - moved
      const batchSize = Math.min(remaining, Math.max(1, inventoryCapacityForItem(context, options.itemName)))
      const sourceOpened = await this.openCandidateChest(context, source, options)
      if (!sourceOpened.ok) return this.failTransfer(sourceOpened.error, moved, remaining)

      let withdrawn = null
      try {
        const resolved = resolveWithdrawItem(context, sourceOpened.chestWindow, options.itemName, options)
        if (!resolved.itemName || resolved.count <= 0) break
        const amount = Math.min(batchSize, resolved.count, remaining)
        console.log(`[TRANSFER_WITHDRAW_ATTEMPT] item=${resolved.itemName} count=${amount}`)
        withdrawn = await storageActions.withdrawItem(context, sourceOpened.chestWindow, resolved.itemName, amount, {
          owner: options.owner,
          query: options.query || options.itemName,
          holdLock: true
        })
        if (!withdrawn.ok) return this.failTransfer(withdrawn.error, moved, desiredTotal - moved)
        if ((withdrawn.data?.count || 0) <= 0) return this.failTransfer(`withdraw_moved_zero:${resolved.itemName}`, moved, desiredTotal - moved)
        console.log(`[TRANSFER_WITHDRAW_SUCCESS] item=${resolved.itemName} count=${withdrawn.data.count}`)
        withdrawnItems.push(withdrawn.data)
      } finally {
        storageActions.closeChest(context, sourceOpened.chestWindow, { owner: options.owner })
      }

      const movedOut = withdrawn.data.count || 0
      const targetOpened = await this.openCandidateChest(context, target, options)
      if (!targetOpened.ok) return this.failTransfer(targetOpened.error, moved, desiredTotal - moved)

      let deposited = null
      try {
        console.log(`[TRANSFER_DEPOSIT_ATTEMPT] item=${options.itemName} count=${movedOut}`)
        deposited = await storageActions.depositItem(context, targetOpened.chestWindow, options.itemName, movedOut, {
          owner: options.owner,
          holdLock: true
        })
        if (!deposited.ok) return this.failTransfer(deposited.error, moved, desiredTotal - moved)
        if ((deposited.data?.count || 0) <= 0) return this.failTransfer(`deposit_moved_zero:${options.itemName}`, moved, desiredTotal - moved)
        console.log(`[TRANSFER_DEPOSIT_SUCCESS] item=${options.itemName} count=${deposited.data.count}`)
        depositedItems.push(deposited.data)
      } finally {
        storageActions.closeChest(context, targetOpened.chestWindow, { owner: options.owner })
      }

      moved += deposited.data.count
      console.log(`[TRANSFER_BATCH_DONE] moved=${moved} remaining=${Math.max(0, desiredTotal - moved)}`)
    }

    const remaining = Math.max(0, desiredTotal - moved)
    if (moved === 0) return this.failTransfer(`chest_item_not_found:${options.itemName}`)
    if (remaining > 0) return this.failTransfer('target_chest_space_insufficient', moved, remaining)
    console.log(`[STORAGE_TRANSFER_SUCCESS] moved=${moved}`)
    this.status = {
      ...this.status,
      storageStatus: 'COMPLETED',
      targetChest: target,
      storedItems: depositedItems,
      withdrawnItems,
      missingItems: [],
      lastStorageError: null
    }
    return { ok: true, moved, remaining, targetChest: target, sourceChest: source }
  }

  findNearbyChestBlock(context) {
    const nearby = storageActions.findNearbyChests(context, this.options.chestSearchRadius, {
      invalidPositions: this.invalidChestPositions
    })
    return nearby.ok ? nearby.data.chests[0] : null
  }

  async withdrawItemFromCandidates(context, options = {}) {
    const candidates = this.buildChestCandidates(context, options)
    if (!candidates.length) return { ok: false, error: 'chest_not_found' }

    let checked = 0
    const openedChests = []
    for (const candidate of candidates) {
      if (!storageShouldContinue(options)) return { ok: false, error: 'task_interrupted' }
      checked += 1
      console.log(`[WITHDRAW_SEARCH_CHEST] pos=${formatPos(candidate.position)} type=${candidate.chestType || 'unknown'} index=${checked}/${candidates.length}`)
      const opened = await this.openCandidateChest(context, candidate, options)
      if (!storageShouldContinue(options)) {
        if (opened.ok) storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
        return { ok: false, error: 'task_interrupted' }
      }
      if (!opened.ok) continue
      openedChests.push(candidate.position)

      let resolved
      let withdrawn
      try {
        resolved = resolveWithdrawItem(context, opened.chestWindow, options.itemName, options)
        console.log(`[ITEM_MATCH_RESULT] query=${options.query || options.itemName} matched=${resolved.itemName || 'none'} count=${resolved.count || 0}`)
        if (!resolved.itemName) {
          console.log(`[ITEM_NOT_IN_CHEST] pos=${formatPos(candidate.position)} item=${options.itemName}`)
        } else {
          const amount = withdrawCountForItem(context, resolved.itemName, requestedMoveCount(options), resolved.count)
          const requestedCount = requestedCountForLog(context, resolved.itemName, requestedMoveCount(options))
          if (Number.isFinite(requestedCount) && requestedCount > resolved.count) {
            console.log(`[WITHDRAW_PARTIAL_REQUEST] item=${resolved.itemName} requested=${requestedCount} available=${resolved.count} moving=${amount}`)
          }
          if (resolved.itemName === 'wheat_seeds') {
            console.log(`[SEED_WITHDRAW_PLAN] targetCount=${seedTargetCount(context, resolved.itemName, options)}`)
          }
          console.log(`[WITHDRAW_FOUND_ITEM] pos=${formatPos(candidate.position)} item=${resolved.itemName} count=${resolved.count}`)
          withdrawn = await storageActions.withdrawItem(context, opened.chestWindow, resolved.itemName, requestedMoveCount(options) === 'all' ? 'all' : amount, {
            owner: options.owner,
            query: options.query || options.itemName,
            holdLock: true
          })
        }
      } finally {
        storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
      }

      if (withdrawn?.ok && withdrawn.data?.itemName === options.itemName && (withdrawn.data.count || 0) > 0) {
        return {
          ok: true,
          withdrawnItems: [withdrawn.data],
          targetChest: opened.chest,
          openSummary: {
            openedChests,
            openCount: openedChests.length,
            reason: options.reason || 'withdraw_item'
          }
        }
      }
      if (resolved?.error?.startsWith('food_requires_confirmation')) return { ok: false, error: resolved.error }
      console.log('[WITHDRAW_SEARCH_NEXT_CHEST]')
    }

    console.log(`[WITHDRAW_ALL_CHESTS_FAILED] item=${options.itemName} checked=${checked}`)
    return {
      ok: false,
      error: `chest_item_not_found:${options.itemName}`,
      openSummary: {
        openedChests,
        openCount: openedChests.length,
        reason: options.reason || 'withdraw_item'
      }
    }
  }

  async withdrawFoodFromCandidates(context, options = {}) {
    const targetCount = foodTargetCount(options)
    const candidates = this.buildChestCandidates(context, options)
    if (!candidates.length) return { ok: false, error: 'chest_not_found' }

    const plan = []
    const withdrawnItems = []
    let total = 0
    let checked = 0
    let blockedError = null
    let lastChest = null

    for (const candidate of candidates) {
      if (total >= targetCount) break
      checked += 1
      console.log(`[WITHDRAW_SEARCH_CHEST] pos=${formatPos(candidate.position)} type=${candidate.chestType || 'unknown'} index=${checked}/${candidates.length}`)
      const opened = await this.openCandidateChest(context, candidate, options)
      if (!opened.ok) continue

      try {
        const chestItems = storageActions.getChestItems(opened.chestWindow)
        const foodCandidates = getFoodCandidates(context.bot, chestItems)
        const usable = foodCandidates.filter(candidate => isOrdinaryFood(candidate.itemName))
        if (!usable.length) {
          const blocked = selectFoodItem(context, chestItems, options)
          if (!blocked.ok && !blockedError) blockedError = blocked.error
          console.log(`[ITEM_NOT_IN_CHEST] pos=${formatPos(candidate.position)} item=food`)
        } else {
          for (const food of usable) {
            if (total >= targetCount) break
            const amount = Math.min(food.count, targetCount - total)
            if (amount <= 0) continue
            plan.push({ itemName: food.itemName, count: amount, pos: formatPos(candidate.position) })
            console.log(`[FOOD_WITHDRAW_PLAN] targetCount=${targetCount} selected=${JSON.stringify(plan)}`)
            console.log(`[FOOD_WITHDRAW_PARTIAL] item=${food.itemName} count=${amount}`)
            const withdrawn = await storageActions.withdrawItem(context, opened.chestWindow, food.itemName, amount, {
              owner: options.owner,
              query: options.query || options.itemName,
              holdLock: true
            })
            if (withdrawn.ok) {
              total += withdrawn.data.count || amount
              withdrawnItems.push(withdrawn.data)
              lastChest = opened.chest
            }
          }
        }
      } finally {
        storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
      }

      if (total < targetCount) console.log('[WITHDRAW_SEARCH_NEXT_CHEST]')
    }

    console.log(`[FOOD_WITHDRAW_TOTAL] count=${total}`)
    if (total > 0) return { ok: true, withdrawnItems, targetChest: lastChest }
    if (blockedError) return { ok: false, error: blockedError }
    console.log(`[WITHDRAW_ALL_CHESTS_FAILED] item=food checked=${checked}`)
    return { ok: false, error: 'chest_item_not_found:food' }
  }

  async withdrawCategoryFromCandidates(context, options = {}) {
    if (options.category === 'food') return this.withdrawFoodFromCandidates(context, { ...options, itemName: 'food' })

    const candidates = this.buildChestCandidates(context, options)
    if (!candidates.length) return { ok: false, error: 'chest_not_found' }

    let checked = 0
    for (const candidate of candidates) {
      checked += 1
      console.log(`[WITHDRAW_SEARCH_CHEST] pos=${formatPos(candidate.position)} type=${candidate.chestType || 'unknown'} index=${checked}/${candidates.length}`)
      const opened = await this.openCandidateChest(context, candidate, options)
      if (!opened.ok) continue

      const withdrawnItems = []
      try {
        const chestItems = storageActions.getChestItems(opened.chestWindow)
        const plan = selectCategoryItems(chestItems, options.category, options.count)
        console.log(`[CATEGORY_WITHDRAW_PLAN] category=${options.category} selected=${JSON.stringify(plan)}`)
        for (const item of plan) {
          const withdrawn = await storageActions.withdrawItem(context, opened.chestWindow, item.itemName, item.count, {
            owner: options.owner,
            query: options.query || options.category,
            holdLock: true
          })
          if (withdrawn.ok && (withdrawn.data?.count || 0) > 0) withdrawnItems.push(withdrawn.data)
        }
      } finally {
        storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
      }

      if (withdrawnItems.length) return { ok: true, withdrawnItems, targetChest: opened.chest }
      console.log('[WITHDRAW_SEARCH_NEXT_CHEST]')
    }

    console.log(`[WITHDRAW_ALL_CHESTS_FAILED] category=${options.category} checked=${checked}`)
    return { ok: false, error: `chest_category_not_found:${options.category}` }
  }

  async withdrawAllItemsFromCandidates(context, options = {}) {
    const candidates = this.buildChestCandidates(context, options)
    if (!candidates.length) return { ok: false, error: 'chest_not_found' }

    const withdrawnItems = []
    let checked = 0
    for (const candidate of candidates) {
      checked += 1
      console.log(`[WITHDRAW_SEARCH_CHEST] pos=${formatPos(candidate.position)} type=${candidate.chestType || 'unknown'} index=${checked}/${candidates.length}`)
      const opened = await this.openCandidateChest(context, candidate, options)
      if (!opened.ok) continue

      try {
        const items = storageActions.getChestItems(opened.chestWindow)
        const names = [...new Set(items.map(item => item.name).filter(Boolean))]
        if (!names.length) {
          console.log(`[ITEM_NOT_IN_CHEST] pos=${formatPos(candidate.position)} item=all`)
        }
        for (const itemName of names) {
          const summary = storageActions.getChestSummary(context, opened.chestWindow)
          const total = summary.ok ? summary.data.counts[itemName] || 0 : 0
          if (total <= 0) continue
          console.log(`[WITHDRAW_FOUND_ITEM] pos=${formatPos(candidate.position)} item=${itemName} count=${total}`)
          const withdrawn = await storageActions.withdrawItem(context, opened.chestWindow, itemName, 'all', {
            owner: options.owner,
            query: options.query || 'all',
            holdLock: true
          })
          if (withdrawn.ok) withdrawnItems.push(withdrawn.data)
        }
      } finally {
        storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
      }

      if (withdrawnItems.length) return { ok: true, withdrawnItems, targetChest: candidate }
      console.log('[WITHDRAW_SEARCH_NEXT_CHEST]')
    }

    console.log(`[WITHDRAW_ALL_CHESTS_FAILED] item=all checked=${checked}`)
    return { ok: false, error: 'chest_item_not_found:all' }
  }

  async openBestChest(context, options = {}) {
    let lastError = 'chest_not_found'
    const candidates = this.buildChestCandidates(context, options)
    if (!candidates.length) return { ok: false, error: 'chest_not_found' }
    for (const candidate of candidates) {
      const opened = await this.openCandidateChest(context, candidate, options)
      if (opened.ok) return opened
      lastError = opened.error
      console.log('[CHEST_RESCAN]')
    }
    return { ok: false, error: lastError }
  }

  async openCandidateChest(context, candidate, options = {}) {
    if (!storageShouldContinue(options)) return { ok: false, error: 'task_interrupted' }
    const opened = await storageActions.openChest(context, candidate.position, {
      owner: options.owner,
      holdLock: true,
      canDig: options.canDig,
      shouldContinue: options.shouldContinue
    })
    if (opened.ok) return { ok: true, ...opened.data, chest: candidate }
    const failureClass = classifyOpenFailure(opened.error)
    if (failureClass === 'not_found' || failureClass === 'block_changed') {
      this.invalidateChest(context, candidate.position, failureClass, opened.actualName || null)
    } else {
      console.log(`[CHEST_CACHE_RETAIN] pos=${formatPos(candidate.position)} reason=${failureClass}`)
    }
    return opened
  }

  async countItemInCandidate(context, candidate, options = {}) {
    const opened = await this.openCandidateChest(context, candidate, options)
    if (!opened.ok) return { ok: false, error: opened.error }
    try {
      const resolved = resolveWithdrawItem(context, opened.chestWindow, options.itemName, options)
      return {
        ok: Boolean(resolved.itemName),
        itemName: resolved.itemName,
        count: resolved.count || 0,
        error: resolved.itemName ? null : resolved.error || `chest_item_not_found:${options.itemName}`
      }
    } finally {
      storageActions.closeChest(context, opened.chestWindow, { owner: options.owner })
    }
  }

  invalidateChest(context, position, reason, actual = null) {
    if (!position) return
    this.invalidChestPositions.add(posKey(position))
    context?.memory?.world?.removeChestAt?.(position)
    const suffix = actual !== null ? ` actual=${actual || 'null'}` : ''
    console.log(`[CHEST_CACHE_INVALIDATE] pos=${formatPos(position)} reason=${reason}${suffix}`)
  }

  fail(error, extra = {}) {
    console.log(`[STORAGE_TASK_FAILED] reason=${error}`)
    this.status = {
      ...this.status,
      storageStatus: 'FAILED',
      lastStorageError: error,
      ...extra
    }
    return { ok: false, error, ...extra }
  }

  failTransfer(reason, moved = 0, remaining = null) {
    const suffix = remaining != null && moved > 0
      ? ` moved=${moved} remaining=${remaining}`
      : ''
    console.log(`[STORAGE_TRANSFER_FAILED] reason=${reason}${suffix}`)
    return this.fail(reason, {
      moved,
      remaining
    })
  }

  getStatus() {
    return { ...this.status }
  }
}

function storageShouldContinue(options = {}) {
  if (typeof options.shouldContinue !== 'function') return true
  try {
    return options.shouldContinue() !== false
  } catch {
    return false
  }
}

function resolveWithdrawItem(context, chestWindow, itemName, options = {}) {
  const summary = storageActions.getChestSummary({}, chestWindow)
  const counts = summary.ok ? summary.data.counts : {}
  if (itemName === 'food') {
    const selected = selectFoodItem(context, storageActions.getChestItems(chestWindow), options)
    return {
      itemName: selected.ok ? selected.itemName : null,
      count: selected.count || 0,
      error: selected.error
    }
  }
  return {
    itemName: (counts[itemName] || 0) > 0 ? itemName : null,
    count: counts[itemName] || 0
  }
}

function selectItemsToStore(context, options = {}) {
  // options.inventoryCounts：调用方刚动过背包、黑板还没刷新时用的实时口径。
  // 不传就照旧走 getInventoryCounts（优先读黑板快照）。
  const counts = options.inventoryCounts || getInventoryCounts(context)
  const category = normalizeCategory(options.category || options.itemCategory || (options.itemName && CATEGORY_ITEM_NAMES.has(options.itemName) ? options.itemName : null))
  if (category) {
    const categoryNames = categoryItemNames(context, category)
    const matched = Object.entries(counts)
      .filter(([itemName, count]) => count > 0 && categoryNames.has(itemName))
      .map(([itemName, count]) => ({ itemName, count }))
    return applyRequestedCount(matched, options.count)
  }

  if (options.itemName) {
    const available = counts[options.itemName] || 0
    if (!available) return []
    const requested = requestedMoveCount(options)
    const requestedCount = requestedCountForLog(context, options.itemName, requested)
    if (Number.isFinite(requestedCount) && requestedCount > available) {
      console.log(`[DEPOSIT_PARTIAL_REQUEST] item=${options.itemName} requested=${requestedCount} available=${available} moving=${depositCount(context, options.itemName, requested, available)}`)
    }
    return [{ itemName: options.itemName, count: depositCount(context, options.itemName, requested, available) }]
  }

  // keepItems：调用方点名不许倒的东西（工地就近卸货时是这一栋还要用的材料）
  const keepItems = new Set(Array.isArray(options.keepItems) ? options.keepItems : [])
  return Object.entries(counts)
    .filter(([itemName, count]) => count > 0 && !keepItems.has(itemName) && shouldStoreItem(itemName, count, options.mode))
    .map(([itemName, count]) => ({ itemName, count: storableCount(itemName, count) }))
    .filter(item => item.count > 0)
}

function shouldStoreItem(itemName, count, mode = 'nonEssential') {
  if (mode === 'all') return !isCriticalItem(itemName)
  if (mode === 'specific') return true
  return !isCriticalItem(itemName) && storableCount(itemName, count) > 0
}

function storableCount(itemName, count) {
  if (itemName.includes('log') || itemName.includes('planks')) return Math.max(0, count - 16)
  if (itemName === 'cobblestone' || itemName === 'dirt') return Math.max(0, count - 32)
  return count
}

function isCriticalItem(itemName) {
  return ESSENTIAL_ITEMS.has(itemName) || ESSENTIAL_SUFFIXES.some(suffix => itemName.endsWith(suffix))
}

function isDangerHigh(context) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return dangerLevel === 'high' || dangerLevel === 'critical'
}

function classifyOpenFailure(error) {
  const reason = String(error || 'open_failed')
  if (reason.includes('container_block_changed')) return 'block_changed'
  if (reason.includes('chest_not_found')) return 'not_found'
  if (reason.includes('block')) return 'open_failed'
  if (reason.includes('path')) return 'open_failed'
  return 'open_failed'
}

// maxDistance 是「就近卸货」用的硬边界：超出这个距离的箱子直接不进候选，
// 不靠排序把它压到最后——排序压不住「只剩这一个候选」的情况。
function filterChestCandidatesByDistance(candidates, botPosition, maxDistance) {
  const limit = Number(maxDistance)
  if (!Number.isFinite(limit) || limit <= 0 || !botPosition) return candidates
  const kept = []
  for (const candidate of candidates) {
    const value = distance(botPosition, candidate.position)
    if (Number.isFinite(value) && value <= limit) kept.push(candidate)
    else console.log(`[CHEST_CANDIDATE_OUT_OF_RANGE] pos=${formatPos(candidate.position)} distance=${Number.isFinite(value) ? value.toFixed(1) : 'unknown'} maxDistance=${limit}`)
  }
  return kept
}

function sortChestCandidates(candidates, options = {}) {
  const preference = options.containerPreference || 'any'
  return candidates.sort((a, b) => {
    const scoreA = chestPreferenceScore(a, preference)
    const scoreB = chestPreferenceScore(b, preference)
    return scoreA - scoreB || chestCandidateDistanceForScore(a) - chestCandidateDistanceForScore(b)
  })
}

function chestPreferenceScore(candidate, preference) {
  let score = 0
  if (candidate.source === 'look') score -= preference === 'any' || preference === 'look' ? 200 : 50
  if (/^build_storage_/.test(String(candidate.source || ''))) score -= 650
  if (candidate.source === 'build_origin' || /^storage_anchor_/.test(String(candidate.source || '')) || /^anchor_/.test(String(candidate.source || ''))) score -= 200
  if (preference === 'double' && candidate.chestType === 'double') score -= 300
  if (preference === 'single' && candidate.chestType === 'single') score -= 300
  if (preference === 'look' && candidate.source === 'look') score -= 200
  if (candidate.source === 'memory') score += 1000
  return score
}

function chestCandidateDistanceForScore(candidate) {
  const source = String(candidate?.source || '')
  if (source === 'look' || /^build_storage_/.test(source) || source === 'build_origin' || /^storage_anchor_/.test(source) || /^anchor_/.test(source)) {
    return candidate.distance ?? candidate.botDistance ?? 0
  }
  return candidate.botDistance ?? candidate.distance ?? 0
}

function chestCandidateLog(candidate) {
  return {
    pos: formatPos(candidate.position),
    type: candidate.chestType || candidate.name || 'unknown',
    source: candidate.source || 'unknown',
    distance: Number((candidate.botDistance ?? candidate.distance ?? 0).toFixed?.(1) ?? candidate.botDistance ?? candidate.distance ?? 0)
  }
}

function withdrawCount(context, itemName, requested, available) {
  const normalized = normalizedMoveCount(requested)
  if (normalized === 'all') return available
  if (normalized === 'stack') return Math.min(itemStackSize(context, itemName), available)
  const count = Number(normalized)
  if (Number.isFinite(count) && count > 0) return Math.min(count, available)
  return Math.min(DEFAULT_ITEM_WITHDRAW_COUNT, available)
}

function withdrawCountForItem(context, itemName, requested, available) {
  if (itemName === 'wheat_seeds' && requested == null) {
    return Math.min(DEFAULT_SEED_WITHDRAW_COUNT, available)
  }
  if (itemName === 'wheat' && requested == null) {
    return Math.min(DEFAULT_ITEM_WITHDRAW_COUNT, available)
  }
  return withdrawCount(context, itemName, requested, available)
}

function depositCount(context, itemName, requested, available) {
  const normalized = normalizedMoveCount(requested)
  if (normalized == null || normalized === 'all') return available
  if (normalized === 'stack') return Math.min(itemStackSize(context, itemName), available)
  const count = Number(normalized)
  if (Number.isFinite(count) && count > 0) return Math.min(count, available)
  return available
}

function seedTargetCount(context, itemName, options = {}) {
  const normalized = requestedMoveCount(options)
  if (normalized === 'all') return Infinity
  if (normalized === 'stack') return itemStackSize(context, itemName)
  const count = Number(normalized)
  if (Number.isFinite(count) && count > 0) return count
  return DEFAULT_SEED_WITHDRAW_COUNT
}

function foodTargetCount(options = {}) {
  const normalized = requestedMoveCount(options)
  if (normalized === 'all') return Infinity
  if (normalized === 'stack') return 64
  const count = Number(normalized)
  if (Number.isFinite(count) && count > 0) return count
  return DEFAULT_FOOD_WITHDRAW_COUNT
}

function normalizedMoveCount(requested) {
  if (requested == null || requested === '') return null
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) return requested
  const text = String(requested).trim().toLowerCase()
  if (['all', '全部', '所有', '全拿', '全放'].includes(text) || text.includes('全部') || text.includes('所有')) return 'all'
  if (['stack', '一组', '1组', '一组物品'].includes(text) || text.includes('一组') || /\bstack\b/.test(text)) return 'stack'
  const digit = text.match(/\d+/)
  if (digit) return Number(digit[0])
  const chinese = parseChineseCount(text)
  return Number.isFinite(chinese) && chinese > 0 ? chinese : null
}

function requestedMoveCount(options = {}) {
  const fromCount = normalizedMoveCount(options.count)
  if (fromCount != null) return fromCount
  return normalizedMoveCount(options.query)
}

function parseChineseCount(text) {
  const digits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  }
  if (Object.prototype.hasOwnProperty.call(digits, text)) return digits[text]
  const compact = String(text || '').replace(/[个顆颗件组\s]/g, '')
  if (Object.prototype.hasOwnProperty.call(digits, compact)) return digits[compact]
  if (compact.startsWith('十')) return 10 + (digits[compact.slice(1)] || 0)
  if (compact.includes('十')) {
    const [tens, ones] = compact.split('十')
    return (digits[tens] || 1) * 10 + (digits[ones] || 0)
  }
  return NaN
}

function itemStackSize(context, itemName) {
  return context?.bot?.registry?.itemsByName?.[itemName]?.stackSize || 64
}

function requestedCountForLog(context, itemName, requested) {
  const normalized = normalizedMoveCount(requested)
  if (normalized === 'stack') return itemStackSize(context, itemName)
  if (normalized === 'all' || normalized == null) return null
  const count = Number(normalized)
  return Number.isFinite(count) && count > 0 ? count : null
}

function isOrdinaryFood(itemName) {
  const category = foodCategory(itemName)
  return category === 'safe' || category === 'basic' || category === 'unknown_edible'
}

function normalizeCategory(category) {
  if (!category) return null
  const value = String(category).toLowerCase()
  if (value === 'equipment') return 'armor'
  if (CATEGORY_ITEM_NAMES.has(value)) return value
  return null
}

function missingItemRecord(itemName, category, count) {
  const record = { itemName, count }
  if (category) record.category = category
  return record
}

function isInventoryItemMissing(error) {
  return String(error || '').startsWith('inventory_item_not_found:')
}

function selectCategoryItems(chestItems, category, requestedCount = null) {
  const items = (chestItems || [])
    .map(item => ({ itemName: item.name, count: item.count || 1 }))
    .filter(item => item.itemName && item.count > 0)

  if (category === 'armor') return selectBestArmorItems(items)
  if (category === 'weapon') return selectBestItems(items.filter(item => isWeapon(item.itemName)), requestedCount || 1)
  if (category === 'tool') return selectBestItems(items.filter(item => isTool(item.itemName)), requestedCount || 1)
  if (isWoodCategory(category)) {
    const names = categoryItemNames(null, category)
    return applyRequestedCount(items.filter(item => names.has(item.itemName)), requestedCount ?? DEFAULT_CATEGORY_WITHDRAW_COUNT)
  }
  return []
}

function isWoodCategory(category) {
  return category === 'wood' ||
    category === 'logs' ||
    category === 'planks' ||
    WOOD_SPECIES.some(species => category === `${species}_wood`)
}

function categoryItemNames(context, category) {
  let names = []
  if (category === 'wood') names = WOOD_CATEGORY_ITEM_NAMES
  else if (category === 'logs') names = LOG_ITEM_NAMES
  else if (category === 'planks') names = PLANK_ITEM_NAMES
  else {
    const species = WOOD_SPECIES.find(candidate => category === `${candidate}_wood`)
    if (species) names = WOOD_CATEGORY_ITEM_NAMES.filter(itemName => itemName === `${species}_log` ||
      itemName === `stripped_${species}_log` ||
      itemName === `${species}_wood` ||
      itemName === `stripped_${species}_wood` ||
      itemName === `${species}_planks`)
  }

  const registryItems = context?.bot?.registry?.itemsByName
  if (!registryItems) return new Set(names)
  return new Set(names.filter(itemName => registryItems[itemName]))
}

function applyRequestedCount(items, requestedCount = null) {
  if (requestedCount == null || requestedCount === 'all') return items
  const target = Number(requestedCount)
  if (!Number.isFinite(target) || target <= 0) return items
  const selected = []
  let remaining = target
  for (const item of items) {
    if (remaining <= 0) break
    const count = Math.min(item.count, remaining)
    if (count > 0) selected.push({ itemName: item.itemName, count })
    remaining -= count
  }
  return selected
}

function selectBestArmorItems(items) {
  const selected = []
  for (const slot of ARMOR_SLOTS) {
    const best = items
      .filter(item => item.itemName.endsWith(`_${slot}`))
      .sort((a, b) => itemScore(b.itemName) - itemScore(a.itemName))[0]
    if (best) selected.push({ itemName: best.itemName, count: 1 })
  }
  return selected
}

function selectBestItems(items, requestedCount) {
  return items
    .sort((a, b) => itemScore(b.itemName) - itemScore(a.itemName))
    .slice(0, Math.max(1, Number(requestedCount) || 1))
    .map(item => ({ itemName: item.itemName, count: 1 }))
}

function isTool(itemName) {
  return TOOL_SUFFIXES.some(suffix => itemName.endsWith(suffix))
}

function isWeapon(itemName) {
  return itemName.endsWith('_sword') || itemName.endsWith('_axe') || WEAPON_NAMES.has(itemName)
}

function itemScore(itemName) {
  const tier = Object.keys(TIER_SCORE).find(prefix => itemName.startsWith(`${prefix}_`))
  const typeBonus = itemName.endsWith('_sword') ? 10 : itemName.endsWith('_pickaxe') ? 8 : itemName.endsWith('_axe') ? 7 : 0
  return (TIER_SCORE[tier] || 0) * 100 + typeBonus
}

function inventoryCapacityForItem(context, itemName) {
  const bot = context?.bot
  const stackSize = bot?.registry?.itemsByName?.[itemName]?.stackSize || 64
  const slots = bot?.inventory?.slots || []
  let capacity = 0
  for (const slot of slots) {
    if (!slot) capacity += stackSize
    else if (slot.name === itemName) capacity += Math.max(0, stackSize - (slot.count || 0))
  }
  if (capacity > 0) return capacity
  const emptySlots = Number(context?.blackboard?.get?.('inventory.emptySlots') ?? context?.worldState?.inventory?.emptySlots ?? 0)
  return emptySlots > 0 ? emptySlots * stackSize : stackSize
}

function normalizeRequiredMaterialMap(required = {}) {
  if (Array.isArray(required)) {
    return Object.fromEntries(required
      .filter(entry => entry?.item || entry?.itemName)
      .map(entry => [entry.item || entry.itemName, Number(entry.count || entry.required || entry.missing || 0)])
      .filter(([, count]) => count > 0))
  }
  const normalized = {}
  for (const [item, count] of Object.entries(required || {})) {
    const value = Number(count)
    if (item && value > 0) normalized[item] = value
  }
  return normalized
}

function inventoryItemCount(context, itemName) {
  const counts = getInventoryCounts(context) || {}
  const fromCounts = Number(counts[itemName]) || 0
  const fromItems = liveInventoryItemCount(context, itemName)
  return Math.max(fromCounts, fromItems)
}

function liveInventoryItemCount(context, itemName) {
  return (context?.bot?.inventory?.items?.() || [])
    .filter(item => (item.name || item.itemName) === itemName)
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0)
}

function missingMaterialsFromCounts(required = {}, counts = {}) {
  return Object.entries(required)
    .map(([item, count]) => ({
      item,
      required: count,
      available: Number(counts[item]) || 0
    }))
    .filter(entry => entry.available < entry.required)
    .map(entry => ({
      ...entry,
      missing: entry.required - entry.available
    }))
}

function contextWithStorageCounts(context = {}, knownStorageCounts = {}) {
  const originalBlackboard = context.blackboard
  const originalGet = originalBlackboard?.get?.bind(originalBlackboard)
  const originalStorageCounts = originalGet ? (originalGet('storage.counts') || {}) : {}
  const mergedStorageCounts = mergeCountMaps(originalStorageCounts, knownStorageCounts)
  return {
    ...context,
    blackboard: {
      ...originalBlackboard,
      get(key) {
        if (key === 'storage.counts') return mergedStorageCounts
        return originalGet ? originalGet(key) : undefined
      },
      set: originalBlackboard?.set?.bind(originalBlackboard),
      snapshot: originalBlackboard?.snapshot?.bind(originalBlackboard)
    }
  }
}

function mergeCountMaps(...maps) {
  const merged = {}
  for (const map of maps) {
    for (const [itemName, count] of Object.entries(map || {})) {
      merged[itemName] = (Number(merged[itemName]) || 0) + (Number(count) || 0)
    }
  }
  return merged
}

function distance(a, b) {
  if (!a || !b) return Infinity
  if (typeof a.distanceTo === 'function') return a.distanceTo(b)
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function posKey(position) {
  return `${position.x},${position.y},${position.z}`
}

function preferTargetFirst(targets = [], preferred = null) {
  const preferredPosition = preferred?.position || preferred
  if (!preferredPosition) return targets
  const preferredKey = posKey(preferredPosition)
  const index = targets.findIndex(target => posKey(target.position) === preferredKey)
  if (index <= 0) return targets
  return [targets[index], ...targets.slice(0, index), ...targets.slice(index + 1)]
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

// placeBlock / craftItem 的 finally 里是 releaseActionLocks(owner)——
// 它按 owner 一把全放，连调用方（储物任务）自己的 movement / inventory 一起放掉。
// 这两个动作是这条兜底链上唯一要借的外部动作，所以在这里存一次、还一次。
// 还不回来（例如任务已经走到终态被封死）就当兜底失败、回落老路径，
// 绝不让任务顶着「我以为我还拿着锁」往下跑（修缮 15 那个坑）。
async function withOwnerLocksPreserved(context, owner, run) {
  const actionLock = context?.actionLock
  const held = actionLock && owner != null
    ? OWNED_LOCK_TYPES.filter(type => actionLock.getOwner?.(type) === owner)
    : []

  let result = null
  let thrown = null
  try {
    result = await run()
  } catch (err) {
    thrown = err
  }

  if (held.length) {
    const restored = actionLock.acquireMany(held, owner, { reason: 'storage:temporary_chest' })
    console.log(`[TEMP_CHEST_LOCKS] types=${held.join(',')} restored=${restored.ok === true} reason=${restored.ok ? 'ok' : (restored.reason || 'unknown')}`)
    if (!restored.ok) return { ok: false, error: `action_locks_not_restored:${restored.reason || 'unknown'}` }
  }

  if (thrown) return { ok: false, error: thrown?.message || String(thrown) }
  return result
}

// 背包里真有多少件。这里刻意不走 getInventoryCounts：它优先读黑板快照，
// 而合成/放置刚动过背包，黑板还是上一拍的数。
function liveInventoryCounts(context) {
  const items = context?.bot?.inventory?.items?.()
  if (!Array.isArray(items)) return getInventoryCounts(context)
  const counts = {}
  for (const item of items) {
    if (!item?.name) continue
    counts[item.name] = (counts[item.name] || 0) + (Number(item.count) || 0)
  }
  return counts
}

function liveItemCount(context, itemName) {
  const items = context?.bot?.inventory?.items?.()
  if (Array.isArray(items)) {
    return items.reduce((total, item) => total + (item?.name === itemName ? Number(item.count) || 0 : 0), 0)
  }
  return Number(getInventoryCounts(context)[itemName]) || 0
}

// 箱子要 8 块同种木板，所以是「某一种够 8」，不是「木板总数够 8」。
function plankForChestCraft(context) {
  return PLANK_ITEM_NAMES.find(name => liveItemCount(context, name) >= TEMPORARY_CHEST_PLANK_COST) || null
}

// 生存系统用它决定「值不值得为荒地上的满背包派一趟卸货」：
// 身上有箱子、或够合成一只，才派；两样都没有就照旧原地站着，
// 免得派出去只换回一条 chest_not_found。
function canDeployTemporaryChest(counts = {}) {
  if ((Number(counts.chest) || 0) > 0) return true
  return PLANK_ITEM_NAMES.some(name => (Number(counts[name]) || 0) >= TEMPORARY_CHEST_PLANK_COST)
}

// 放置点：站位附近、脚下实心、头顶空着（不然箱子打不开），
// 且不在当前施工单的包围盒内——图纸里那些 air 格也算包围盒内，
// 楼梯井就是这么来的，往里塞一只箱子等于把上楼的路堵死。
function findTemporaryChestSpot(context, options = {}) {
  const origin = botBlockPosition(context)
  if (!origin) return null
  const box = constructionExclusionBox(context)
  const rejected = []
  for (const offset of TEMPORARY_CHEST_OFFSETS) {
    const target = { x: origin.x + offset.x, y: origin.y, z: origin.z + offset.z }
    const reason = temporaryChestSpotRejection(context, target, box)
    if (!reason) {
      console.log(`[TEMP_CHEST_SPOT] pos=${formatPos(target)} tried=${rejected.length + 1} rejected=${rejected.join('|') || 'none'}`)
      return target
    }
    rejected.push(`${formatPos(target)}:${reason}`)
  }
  console.log(`[TEMP_CHEST_SPOT_NONE] origin=${formatPos(origin)} bounds=${formatBox(box)} rejected=${rejected.join('|')}`)
  return null
}

function temporaryChestSpotRejection(context, target, box) {
  if (isInsideBox(box, target)) return 'inside_build_bounds'
  const here = blockNameAt(context, target)
  if (here == null) return 'unknown_block'
  if (!TEMPORARY_CHEST_AIR_NAMES.has(here)) return `not_empty:${here}`
  const above = blockNameAt(context, { x: target.x, y: target.y + 1, z: target.z })
  if (above != null && !TEMPORARY_CHEST_AIR_NAMES.has(above)) return `blocked_above:${above}`
  const below = blockNameAt(context, { x: target.x, y: target.y - 1, z: target.z })
  if (below == null) return 'no_support:unknown'
  if (TEMPORARY_CHEST_UNSUPPORTIVE_NAMES.has(below)) return `no_support:${below}`
  return null
}

function botBlockPosition(context) {
  const position = context?.bot?.entity?.position || context?.blackboard?.get?.('bot.position')
  if (!position || !Number.isFinite(Number(position.x))) return null
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}

function blockNameAt(context, position) {
  const bot = context?.bot
  if (typeof bot?.blockAt !== 'function') return null
  try {
    return bot.blockAt(toBlockVec3(position))?.name ?? null
  } catch {
    return null
  }
}

// 在建施工单的包围盒。worldBlocks 里连图纸声明的 air 格都在（楼梯井就是 air），
// 所以按它算；只有拿不到 worldBlocks 时才退回 reservedBounds——
// 那一份是按实心块算的，会漏掉井口，故高度方向不设限、宁可保守。
function constructionExclusionBox(context = {}) {
  const taskManager = context?.taskManager || null
  const tasks = [
    taskManager?.currentTask,
    ...(Array.isArray(taskManager?.queue) ? taskManager.queue : []),
    ...(Array.isArray(taskManager?.pausedStack) ? taskManager.pausedStack : [])
  ].filter(task => task && task.type === CONSTRUCTION_TASK_TYPE)

  let box = null
  for (const task of tasks) {
    const session = task.system?.session || task.session || null
    if (!session) continue
    const blocks = Array.isArray(session.worldBlocks) ? session.worldBlocks : []
    let fromBlocks = false
    for (const block of blocks) {
      const position = block?.position || block
      if (!Number.isFinite(Number(position?.x))) continue
      fromBlocks = true
      box = expandBox(box, position)
    }
    if (fromBlocks) continue
    const bounds = session.reservedBounds
    if (!bounds) continue
    box = expandBox(box, { x: bounds.minX, y: -Infinity, z: bounds.minZ })
    box = expandBox(box, { x: bounds.maxX, y: Infinity, z: bounds.maxZ })
  }
  return box
}

function expandBox(box, position) {
  const x = Number(position.x)
  const y = Number(position.y)
  const z = Number(position.z)
  if (!box) return { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z }
  return {
    minX: Math.min(box.minX, x),
    maxX: Math.max(box.maxX, x),
    minY: Math.min(box.minY, y),
    maxY: Math.max(box.maxY, y),
    minZ: Math.min(box.minZ, z),
    maxZ: Math.max(box.maxZ, z)
  }
}

function isInsideBox(box, position) {
  if (!box) return false
  return position.x >= box.minX && position.x <= box.maxX &&
    position.y >= box.minY && position.y <= box.maxY &&
    position.z >= box.minZ && position.z <= box.maxZ
}

function formatBox(box) {
  if (!box) return 'none'
  return `${box.minX}..${box.maxX},${box.minY}..${box.maxY},${box.minZ}..${box.maxZ}`
}

function findBuiltChestArea(context) {
  const built = context.memory?.world?.list?.().builtStructures || []
  return built.find(record => record.blueprintName === 'chest_area') || null
}

module.exports = {
  StorageSystem,
  canDeployTemporaryChest,
  findTemporaryChestSpot,
  selectItemsToStore,
  shouldStoreItem
}
