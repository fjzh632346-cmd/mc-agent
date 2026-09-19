const farmingActions = require('../actions/farm')
const { StorageSystem } = require('./storage-system')
const { getInventoryCounts, selectSafeFood } = require('../tasks/task-utils')

const FOOD_ITEMS = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot', 'baked_potato']
const RISKY_OR_PRECIOUS_FOOD = new Set(['golden_apple', 'enchanted_golden_apple', 'rotten_flesh', 'spider_eye', 'pufferfish'])
const DEFAULT_FARM_SCAN_RADIUS = 12

class FarmingSystem {
  constructor(options = {}) {
    this.options = {
      farmSearchRadius: DEFAULT_FARM_SCAN_RADIUS,
      maxHarvestPerRun: 32,
      maxPlantPerRun: 32,
      reserveSeeds: 2,
      excessBreadKeep: 16,
      ...options
    }
    this.storageSystem = options.storageSystem || new StorageSystem(options.storageOptions || {})
    this.status = {
      farmingStatus: 'IDLE',
      targetFarm: null,
      matureWheatCount: 0,
      emptyFarmlandCount: 0,
      harvestedItems: [],
      plantedCount: 0,
      madeBreadCount: 0,
      eatenFood: null,
      missingSeeds: false,
      missingWheat: false,
      lastFarmingError: null
    }
  }

  rememberFarm(context, position = null, options = {}) {
    const target = normalizePosition(position || currentPosition(context))
    if (!target) return this.fail('farm_position_missing')

    const record = context.memory?.world?.addFarmLocation?.(target, {
      name: options.name || 'base_farm',
      type: 'wheat_farm',
      radius: options.radius || this.options.farmSearchRadius,
      tags: options.tags || ['base', 'food'],
      source: options.source || 'farming_system'
    })
    if (!record) return this.fail('memory_write_failed')

    this.status.targetFarm = record
    this.status.farmingStatus = 'REMEMBERED'
    this.status.lastFarmingError = null
    return { ok: true, farm: record, actionCount: 1 }
  }

  findBestFarm(context, options = {}) {
    const explicit = normalizePosition(options.position)
    if (explicit) return { ok: true, farm: this.withEffectiveFarmRadius(farmRecord(explicit, options), options), source: 'explicit' }

    const botPosition = currentPosition(context)
    const memoryFarm = context.memory?.world?.nearestFarm?.(botPosition, options)
    if (memoryFarm?.position) return { ok: true, farm: this.withEffectiveFarmRadius(memoryFarm, options), source: 'memory' }

    const baseFarm = context.memory?.world?.baseFarm?.()
    if (baseFarm?.position) return { ok: true, farm: this.withEffectiveFarmRadius(baseFarm, options), source: 'base_farm' }

    const builtFarmPlot = findBuiltFarmPlot(context)
    if (builtFarmPlot?.origin) {
      return { ok: true, farm: this.withEffectiveFarmRadius(farmRecord(builtFarmPlot.origin, { radius: 8, source: 'built_farm_plot' }), options), source: 'built_farm_plot' }
    }

    const nearby = farmingActions.findNearbyFarmland(context, options.radius || this.options.farmSearchRadius)
    if (nearby.ok && nearby.data.farmland.length > 0) {
      const block = nearby.data.farmland[0]
      return { ok: true, farm: this.withEffectiveFarmRadius(farmRecord(block.position, { radius: options.radius || this.options.farmSearchRadius, source: 'nearby_scan' }), options), source: 'nearby' }
    }

    return { ok: false, error: nearby.error || 'farm_not_found' }
  }

  inspectFarm(context, options = {}) {
    if (isDangerHigh(context)) return this.fail('danger_too_high')

    const farm = options.farm || this.findBestFarm(context, options)
    if (!farm.ok && !farm.position) return this.fail(farm.error || 'farm_not_found')
    const targetFarm = this.withEffectiveFarmRadius(farm.position ? farm : farm.farm, options)

    const mature = farmingActions.findMatureWheat(context, targetFarm, options)
    const empty = farmingActions.findEmptyFarmland(context, targetFarm)
    const counts = getInventoryCounts(context)
    const food = farmingActions.getFoodSummary(context)
    const seeds = farmingActions.getSeedSummary(context)

    const matureWheatCount = mature.ok ? mature.data.crops.length : 0
    const emptyFarmlandCount = empty.ok ? empty.data.farmland.length : 0
    const seedCount = seeds.ok ? seeds.data.wheatSeedCount : (counts.wheat_seeds || 0)
    const wheatCount = counts.wheat || 0
    const breadCount = food.ok ? food.data.breadCount : (counts.bread || 0)

    this.status = {
      ...this.status,
      farmingStatus: 'INSPECTED',
      targetFarm,
      matureWheatCount,
      emptyFarmlandCount,
      missingSeeds: emptyFarmlandCount > 0 && seedCount <= this.options.reserveSeeds,
      missingWheat: wheatCount < 3,
      lastFarmingError: null
    }

    return {
      ok: true,
      targetFarm,
      matureWheatCount,
      emptyFarmlandCount,
      seedCount,
      wheatCount,
      breadCount,
      canHarvest: matureWheatCount > 0,
      canPlant: emptyFarmlandCount > 0 && seedCount > this.options.reserveSeeds,
      reason: matureWheatCount > 0 || emptyFarmlandCount > 0 ? null : 'farm_has_no_ready_work'
    }
  }

  getPreparationPlan(context, options = {}) {
    if (isDangerHigh(context)) return this.fail('danger_too_high')
    const farm = this.resolveFarm(context, options)
    if (!farm.ok) return { ok: false, error: farm.error }

    const mode = options.mode || 'FARM_CYCLE'
    const mature = farmingActions.findMatureWheat(context, farm.farm, options)
    if (!mature.ok) return { ok: false, error: mature.error }
    const empty = farmingActions.findEmptyFarmland(context, farm.farm)
    if (!empty.ok) return { ok: false, error: empty.error }

    const matureWheatCount = mature.data.crops.length
    const emptyFarmlandCount = empty.data.farmland.length
    const requestedCount = positiveCount(options.count)
    const harvestTarget = mode === 'HARVEST_FARM'
      ? Math.min(requestedCount || matureWheatCount, this.options.maxHarvestPerRun)
      : 0
    const plantTarget = mode === 'PLANT_WHEAT'
      ? Math.min(requestedCount || emptyFarmlandCount, this.options.maxPlantPerRun)
      : mode === 'FARM_CYCLE'
        ? Math.min(requestedCount || (matureWheatCount > 0 ? matureWheatCount : emptyFarmlandCount), this.options.maxPlantPerRun)
        : 0
    const seedCount = inventoryCounts(context).wheat_seeds || 0

    return {
      ok: true,
      mode,
      farm: farm.farm,
      matureWheatCount,
      emptyFarmlandCount,
      harvestTarget,
      plantTarget,
      seedCount,
      requiresSeeds: plantTarget > 0,
      requiredSeeds: plantTarget
    }
  }

  async harvestMatureWheat(context, options = {}) {
    if (isDangerHigh(context)) return this.fail('danger_too_high')
    const farm = this.resolveFarm(context, options)
    if (!farm.ok) return this.fail(farm.error)

    const requestedCount = positiveCount(options.count)
    const harvestLimit = Math.min(requestedCount || this.options.maxHarvestPerRun, this.options.maxHarvestPerRun)
    const harvestedItems = []
    const harvestedPositions = new Set()
    let skippedImmature = 0
    let scannedMatureCount = 0

    while (harvestedItems.length < harvestLimit) {
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return this.fail('task_interrupted')
      console.log(`[CROP_SCAN_START] crop=wheat radius=${farm.farm.radius || options.radius || this.options.farmSearchRadius}`)
      const mature = farmingActions.findMatureWheat(context, farm.farm, options)
      if (!mature.ok) return this.fail(mature.error)
      skippedImmature = 0
      for (const crop of mature.data.allCrops || []) {
        const age = farmingActions.getCropAge(crop.block)
        const pos = formatPos(crop.position)
        console.log(`[CROP_FOUND] crop=wheat age=${age ?? 'unknown'} mature=${crop.mature ? 'true' : 'false'} pos=${pos}`)
        if (!crop.mature) {
          skippedImmature += 1
          console.log(`[CROP_SKIP_IMMATURE] crop=wheat age=${age ?? 'unknown'} pos=${pos}`)
        }
      }
      const unharvestedMature = mature.data.crops
        .filter(crop => !harvestedPositions.has(posKey(crop.position)))
      scannedMatureCount = Math.max(scannedMatureCount, unharvestedMature.length)
      if (unharvestedMature.length === 0) break

      const crop = unharvestedMature[0]
      const age = farmingActions.getCropAge(crop.block)
      console.log(`[CROP_HARVEST_ATTEMPT] crop=wheat age=${age ?? 'unknown'} pos=${formatPos(crop.position)}`)
      const harvested = await farmingActions.harvestCrop(context, crop.block, {
        owner: options.owner,
        shouldContinue: options.shouldContinue
      })
      if (!harvested.ok) return this.fail(harvested.error)
      harvestedItems.push({ itemName: 'wheat', position: harvested.data.position })
      harvestedPositions.add(posKey(harvested.data.position))
      console.log(`[CROP_HARVEST_SUCCESS] crop=wheat pos=${formatPos(harvested.data.position)}`)
    }

    console.log(`[CROP_HARVEST_SUMMARY] harvested=${harvestedItems.length} skippedImmature=${skippedImmature}`)
    if (harvestedItems.length === 0) {
      this.status.farmingStatus = 'NO_MATURE_WHEAT'
      this.status.matureWheatCount = 0
      this.status.lastFarmingError = 'no_mature_wheat'
      return { ok: false, error: 'no_mature_wheat', harvestedItems: [], matureWheatCount: 0, actionCount: 0, reason: 'no_mature_wheat' }
    }

    if (requestedCount && harvestedItems.length < requestedCount) {
      const error = 'partial_harvest_insufficient_mature_wheat'
      this.status = {
        ...this.status,
        farmingStatus: 'PARTIAL',
        targetFarm: farm.farm,
        matureWheatCount: scannedMatureCount,
        harvestedItems,
        lastFarmingError: error
      }
      return {
        ok: false,
        error,
        harvestedItems,
        targetFarm: farm.farm,
        requestedCount,
        harvestedCount: harvestedItems.length,
        missingCount: requestedCount - harvestedItems.length,
        actionCount: harvestedItems.length,
        reason: error
      }
    }

    this.status = {
      ...this.status,
      farmingStatus: 'HARVESTED',
      targetFarm: farm.farm,
      matureWheatCount: scannedMatureCount,
      harvestedItems,
      lastFarmingError: null
    }
    return { ok: true, harvestedItems, targetFarm: farm.farm, actionCount: harvestedItems.length }
  }

  async replantWheat(context, options = {}) {
    if (isDangerHigh(context)) return this.fail('danger_too_high')
    const farm = this.resolveFarm(context, options)
    if (!farm.ok) return this.fail(farm.error)

    console.log(`[PLANT_SCAN_START] crop=wheat radius=${farm.farm.radius || options.radius || this.options.farmSearchRadius}`)
    let seedCount = inventoryCounts(context).wheat_seeds || 0
    console.log(`[SEED_CHECK] item=wheat_seeds count=${seedCount}`)
    if (seedCount <= 0) {
      console.log('[PLANT_FAILED] reason=missing_seeds')
      return this.fail('missing_seeds', { missingSeeds: true })
    }

    const empty = farmingActions.findEmptyFarmland(context, farm.farm)
    if (!empty.ok) return this.fail(empty.error)
    for (const block of empty.data.farmland || []) {
      console.log(`[FARMLAND_FOUND] pos=${formatPos(block.position)} empty=true`)
    }
    if (empty.data.farmland.length === 0) {
      console.log('[PLANT_FAILED] reason=no_empty_farmland')
      this.status = {
        ...this.status,
        farmingStatus: 'NO_EMPTY_FARMLAND',
        targetFarm: farm.farm,
        emptyFarmlandCount: 0,
        plantedCount: 0,
        lastFarmingError: null
      }
      return { ok: true, plantedCount: 0, targetFarm: farm.farm, actionCount: 0, reason: 'no_empty_farmland' }
    }

    let plantedCount = 0
    const requestedCount = positiveCount(options.count)
    const targetPlantCount = Math.min(requestedCount || empty.data.farmland.length, this.options.maxPlantPerRun)
    const plantable = Math.min(targetPlantCount, seedCount)
    for (const block of empty.data.farmland.slice(0, plantable)) {
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return this.fail('task_interrupted')
      const target = { x: block.position.x, y: block.position.y + 1, z: block.position.z }
      console.log(`[PLANT_ATTEMPT] item=wheat_seeds pos=${formatPos(target)}`)
      const planted = await farmingActions.plantSeed(context, target, 'wheat_seeds', {
        owner: options.owner,
        shouldContinue: options.shouldContinue
      })
      if (!planted.ok) {
        console.log(`[PLANT_FAILED] reason=${planted.error}`)
        return this.fail(planted.error)
      }
      plantedCount += 1
      console.log(`[PLANT_SUCCESS] item=wheat_seeds pos=${formatPos(target)}`)
    }

    if (plantedCount < targetPlantCount) {
      const error = 'partial_replant_insufficient_seeds'
      this.status = {
        ...this.status,
        farmingStatus: 'PARTIAL',
        targetFarm: farm.farm,
        emptyFarmlandCount: empty.data.farmland.length,
        plantedCount,
        missingSeeds: true,
        lastFarmingError: error
      }
      console.log(`[PLANT_SUMMARY] planted=${plantedCount}`)
      console.log(`[PLANT_FAILED] reason=${error} required=${targetPlantCount} available=${seedCount}`)
      return {
        ok: false,
        error,
        plantedCount,
        targetFarm: farm.farm,
        actionCount: plantedCount,
        requiredSeeds: targetPlantCount,
        availableSeeds: seedCount,
        missingSeeds: targetPlantCount - plantedCount,
        reason: error
      }
    }

    this.status = {
      ...this.status,
      farmingStatus: plantedCount > 0 ? 'PLANTED' : 'NO_EMPTY_FARMLAND',
      targetFarm: farm.farm,
      emptyFarmlandCount: empty.data.farmland.length,
      plantedCount,
      missingSeeds: false,
      lastFarmingError: null
    }
    console.log(`[PLANT_SUMMARY] planted=${plantedCount}`)
    return { ok: true, plantedCount, targetFarm: farm.farm, actionCount: plantedCount }
  }

  async makeBreadIfPossible(context, options = {}) {
    console.log('[CRAFT_BREAD_TASK_START]')
    let wheatCount = inventoryCounts(context).wheat || 0
    console.log(`[WHEAT_CHECK] count=${wheatCount}`)
    if (wheatCount < 3 && options.tryStorage !== false) {
      const needed = 3 - wheatCount
      console.log(`[WHEAT_FROM_STORAGE_ATTEMPT] item=wheat count=${needed}`)
      await this.tryTakeFromStorage(context, 'wheat', needed, options)
      wheatCount = inventoryCounts(context).wheat || wheatCount
      console.log(`[WHEAT_CHECK] count=${wheatCount}`)
    }
    if (wheatCount < 3) {
      console.log('[CRAFT_BREAD_FAILED] reason=not_enough_wheat')
      return this.fail('not_enough_wheat', { missingWheat: true })
    }

    const breadCount = Math.max(1, Math.floor(wheatCount / 3))
    const requestedCount = options.count || breadCount
    console.log('[CRAFTING_TABLE_SEARCH]')
    const craftingTable = findNearbyCraftingTable(context, options)
    if (!craftingTable) {
      console.log('[CRAFTING_TABLE_NOT_FOUND]')
      console.log('[CRAFT_BREAD_FAILED] reason=no_crafting_table')
      return this.fail('no_crafting_table')
    }
    console.log(`[CRAFTING_TABLE_FOUND] pos=${formatPos(craftingTable.position)}`)

    if (distance(currentPosition(context), craftingTable.position) > 4) {
      const moved = await farmingActions.moveNearFarmPosition(context, craftingTable.position, {
        owner: options.owner,
        range: 3,
        shouldContinue: options.shouldContinue
      })
      if (!moved.ok) {
        console.log(`[CRAFT_BREAD_FAILED] reason=${moved.error}`)
        return this.fail(moved.error)
      }
    }

    console.log(`[CRAFT_BREAD_PLAN] wheat=${wheatCount} bread=${requestedCount}`)
    console.log(`[CRAFT_BREAD_ATTEMPT] wheat=${wheatCount} count=${requestedCount}`)
    const crafted = await farmingActions.craftBread(context, requestedCount, {
      owner: options.owner,
      shouldContinue: options.shouldContinue,
      craftingTable
    })
    if (!crafted.ok) {
      console.log(`[CRAFT_BREAD_FAILED] reason=${crafted.error || 'bread_craft_failed'}`)
      return this.fail(crafted.error || 'bread_craft_failed')
    }

    const madeBreadCount = requestedCount
    console.log(`[CRAFT_BREAD_SUCCESS] count=${madeBreadCount}`)
    this.status = {
      ...this.status,
      farmingStatus: 'BREAD_MADE',
      madeBreadCount,
      missingWheat: false,
      lastFarmingError: null
    }
    return { ok: true, madeBreadCount, actionCount: madeBreadCount }
  }

  async ensureFood(context, options = {}) {
    let hunger = Number(context.bot?.food ?? context.blackboard?.get?.('bot.food') ?? context.worldState?.bot?.food ?? 20)
    console.log(`[HUNGER_CHECK] food=${Number.isFinite(hunger) ? hunger : 'unknown'}`)
    if (isDangerHigh(context)) return this.fail('danger_too_high')
    if (Number.isFinite(hunger) && hunger >= 18) {
      console.log(`[EAT_LOOP_DONE] eaten=0 food=${hunger}`)
      this.status = {
        ...this.status,
        farmingStatus: 'FOOD_OK',
        lastFarmingError: null
      }
      return { ok: true, action: 'already_full', actionCount: 0, reason: 'food_already_sufficient' }
    }

    const inventoryFood = summarizeInventoryFood(context)
    console.log(`[FOOD_IN_INVENTORY] ordinaryCount=${inventoryFood.ordinaryCount} riskyOrPreciousCount=${inventoryFood.riskyOrPreciousCount} items=${JSON.stringify(inventoryFood.foods)}`)

    if (inventoryFood.ordinaryCount <= 0 && (hasStoredFood(context) || (options.tryStorage !== false && knownChestCount(context) > 0))) {
      console.log(`[FOOD_FROM_STORAGE_ATTEMPT] item=food count=${options.count || 8}`)
      await this.tryTakeFromStorage(context, 'food', options.count || 8, options)
    }

    const counts = inventoryCounts(context)
    if (summarizeInventoryFood(context).ordinaryCount <= 0 && (counts.wheat || 0) >= 3) {
      const bread = await this.makeBreadIfPossible(context, options)
      if (!bread.ok) return bread
    }

    let eatenCount = 0
    let eatenFood = null
    while (!Number.isFinite(hunger) || hunger < 18) {
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return this.fail('task_interrupted')
      const food = selectSafeFood(context)
      if (!food) break
      const before = Number(context.bot?.food ?? hunger)
      console.log(`[FOOD_SELECTED] item=${food.name} source=inventory reason=ordinary_priority`)
      const eaten = await farmingActions.eatFood(context, food.name, {
        owner: options.owner,
        shouldContinue: options.shouldContinue
      })
      if (!eaten.ok) return this.fail(eaten.error)
      eatenCount += 1
      eatenFood = eaten.data
      const after = Number(context.bot?.food)
      hunger = Number.isFinite(after) && after > before ? after : Math.min(20, (Number.isFinite(hunger) ? hunger : before) + foodRestoreEstimate(food.name))
      console.log(`[EAT_SUCCESS] item=${food.name} foodAfter=${hunger}`)
      if (eatenCount >= (options.maxEatCount || 8)) break
    }

    console.log(`[EAT_LOOP_DONE] eaten=${eatenCount} food=${Number.isFinite(hunger) ? hunger : 'unknown'}`)
    if (eatenCount > 0) {
      this.status = {
        ...this.status,
        farmingStatus: 'ATE_FOOD',
        eatenFood,
        lastFarmingError: null
      }
      return { ok: true, action: 'eat', eatenFood, eatCount: eatenCount, actionCount: eatenCount }
    }

    const farm = this.findBestFarm(context, options)
    if (farm.ok && !isDangerHigh(context)) return this.farmCycle(context, options)

    return this.fail(farm.ok ? 'no_food' : 'farm_not_found')
  }

  checkFoodStatus(context, options = {}) {
    const counts = getInventoryCounts(context)
    const farm = this.findBestFarm(context, options)
    let farmInspection = null
    if (farm.ok) {
      const mature = farmingActions.findMatureWheat(context, farm.farm, options)
      const empty = farmingActions.findEmptyFarmland(context, farm.farm)
      farmInspection = {
        targetFarm: farm.farm,
        matureWheatCount: mature.ok ? mature.data.crops.length : 0,
        emptyFarmlandCount: empty.ok ? empty.data.farmland.length : 0
      }
    }

    this.status = {
      ...this.status,
      farmingStatus: 'CHECKED_FOOD',
      targetFarm: farmInspection?.targetFarm || null,
      matureWheatCount: farmInspection?.matureWheatCount || 0,
      emptyFarmlandCount: farmInspection?.emptyFarmlandCount || 0,
      missingSeeds: (counts.wheat_seeds || 0) <= this.options.reserveSeeds,
      missingWheat: (counts.wheat || 0) < 3,
      lastFarmingError: null
    }

    return {
      ok: true,
      foodSummary: {
        breadCount: counts.bread || 0,
        wheatCount: counts.wheat || 0,
        seedCount: counts.wheat_seeds || 0,
        foodCount: FOOD_ITEMS.reduce((sum, itemName) => sum + (counts[itemName] || 0), 0)
      },
      farmInspection,
      actionCount: 1,
      reason: farm.ok ? null : 'farm_not_found'
    }
  }

  async farmCycle(context, options = {}) {
    if (isDangerHigh(context)) return this.fail('danger_too_high')
    const farm = this.resolveFarm(context, options)
    if (!farm.ok) return this.fail(farm.error)
    let farmActionCount = 0

    const harvested = await this.harvestMatureWheat(context, { ...options, farm: farm.farm })
    if (harvested.ok) farmActionCount += harvested.actionCount || 0
    if (!harvested.ok && harvested.error !== 'no_mature_wheat') {
      return this.fail(harvested.error, { actionCount: farmActionCount, harvestedItems: harvested.harvestedItems || [] })
    }
    if (harvested.ok) this.status.lastFarmingError = null

    const planted = await this.replantWheat(context, {
      ...options,
      count: options.count || (harvested.ok ? harvested.actionCount : null),
      farm: farm.farm
    })
    if (planted.ok) farmActionCount += planted.actionCount || 0
    if (!planted.ok) {
      const actionCount = farmActionCount + (planted.actionCount || 0)
      return this.fail(planted.error || 'replant_failed', {
        actionCount,
        plantedCount: planted.plantedCount || 0,
        harvestedItems: harvested.harvestedItems || this.status.harvestedItems || [],
        missingSeeds: planted.missingSeeds || planted.error === 'missing_seeds'
      })
    }

    if (!harvested.ok && harvested.error === 'no_mature_wheat' && (planted.actionCount || 0) === 0) {
      return this.fail('no_farming_work_available', { actionCount: 0 })
    }

    if (harvested.ok && (harvested.actionCount || 0) > 0 && (planted.actionCount || 0) === 0) {
      return this.fail('partial_replant_blocked', {
        actionCount: farmActionCount,
        plantedCount: 0,
        harvestedItems: harvested.harvestedItems || this.status.harvestedItems || []
      })
    }

    if ((inventoryCounts(context).wheat || 0) >= 3) {
      const bread = await this.makeBreadIfPossible(context, options)
      if (bread.ok) farmActionCount += bread.actionCount || 0
      if (!bread.ok && farmActionCount === 0 && bread.error !== 'not_enough_wheat') return bread
      if (!bread.ok && farmActionCount > 0) {
        this.status.lastFarmingError = null
        this.status.farmingStatus = 'COMPLETED'
      }
    }

    if ((inventoryCounts(context).bread || 0) > this.options.excessBreadKeep && knownChestCount(context) > 0) {
      await this.storageSystem.storeItems(context, {
        owner: options.owner,
        itemName: 'bread',
        count: (inventoryCounts(context).bread || 0) - this.options.excessBreadKeep,
        mode: 'specific'
      })
    }

    this.status = {
      ...this.status,
      farmingStatus: 'COMPLETED',
      targetFarm: farm.farm,
      lastFarmingError: null
    }
    return { ok: true, ...this.getStatus(), actionCount: farmActionCount }
  }

  async tryTakeFromStorage(context, itemName, count, options = {}) {
    if (isDangerHigh(context)) return { ok: false, error: 'danger_too_high' }
    if (knownChestCount(context) <= 0 && (itemName !== 'food' || !hasStoredFood(context))) return { ok: false, error: 'chest_not_found' }
    return this.storageSystem.takeItems(context, { owner: options.owner, itemName, count })
  }

  resolveFarm(context, options = {}) {
    if (options.farm?.position) return { ok: true, farm: this.withEffectiveFarmRadius(options.farm, options) }
    const farm = this.findBestFarm(context, options)
    if (!farm.ok) return { ok: false, error: farm.error || 'farm_not_found' }
    return { ok: true, farm: this.withEffectiveFarmRadius(farm.farm, options) }
  }

  withEffectiveFarmRadius(farm, options = {}) {
    const explicitRadius = Number(options.radius)
    if (Number.isFinite(explicitRadius) && explicitRadius > 0) {
      return { ...farm, radius: explicitRadius }
    }
    const farmRadius = Number(farm?.radius)
    const defaultRadius = Number(this.options.farmSearchRadius)
    const radius = Math.max(
      Number.isFinite(farmRadius) && farmRadius > 0 ? farmRadius : 0,
      Number.isFinite(defaultRadius) && defaultRadius > 0 ? defaultRadius : DEFAULT_FARM_SCAN_RADIUS
    )
    return { ...farm, radius }
  }

  fail(error, extra = {}) {
    this.status = {
      ...this.status,
      farmingStatus: 'FAILED',
      lastFarmingError: error,
      ...extra
    }
    return { ok: false, error, ...extra }
  }

  getStatus() {
    return { ...this.status }
  }
}

function currentPosition(context) {
  return context.blackboard?.get?.('bot.position') || context.bot?.entity?.position || context.worldState?.bot?.position || null
}

function normalizePosition(position) {
  if (!position) return null
  const x = Number(position.x)
  const y = Number(position.y)
  const z = Number(position.z)
  if (![x, y, z].every(Number.isFinite)) return null
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100 }
}

function farmRecord(position, options = {}) {
  return {
    id: options.id || `farm_candidate_${Date.now()}`,
    name: options.name || 'farm_candidate',
    position: normalizePosition(position),
    type: 'wheat_farm',
    radius: options.radius || DEFAULT_FARM_SCAN_RADIUS,
    tags: options.tags || ['food'],
    source: options.source || 'runtime'
  }
}

function findBuiltFarmPlot(context) {
  const built = context.memory?.world?.list?.().builtStructures || []
  return built.find(record => record.blueprintName === 'farm_plot') || null
}

function isDangerHigh(context) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return dangerLevel === 'high' || dangerLevel === 'critical'
}

function knownChestCount(context) {
  return context.memory?.summary?.().world?.chestLocations || context.memory?.world?.summary?.().chestLocations || 0
}

function hasStoredFood(context) {
  const counts = context.blackboard?.get?.('storage.counts') || context.blackboard?.get?.('storage.foodCounts') || {}
  return FOOD_ITEMS.some(itemName => (counts[itemName] || 0) > 0)
}

function inventoryCounts(context) {
  const items = context.bot?.inventory?.items?.()
  if (items && items.length > 0) {
    const counts = {}
    for (const item of items) counts[item.name] = (counts[item.name] || 0) + item.count
    return counts
  }
  return getInventoryCounts(context)
}

function positiveCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : null
}

function summarizeInventoryFood(context) {
  const counts = inventoryCounts(context)
  const foods = {}
  let ordinaryCount = 0
  let riskyOrPreciousCount = 0
  for (const [itemName, count] of Object.entries(counts)) {
    if (FOOD_ITEMS.includes(itemName)) {
      foods[itemName] = count
      ordinaryCount += count
    } else if (RISKY_OR_PRECIOUS_FOOD.has(itemName)) {
      foods[itemName] = count
      riskyOrPreciousCount += count
    }
  }
  return { foods, ordinaryCount, riskyOrPreciousCount }
}

function findNearbyCraftingTable(context, options = {}) {
  const bot = context?.bot
  const tableId = bot?.registry?.blocksByName?.crafting_table?.id
  if (tableId == null || typeof bot?.findBlock !== 'function') return null
  return bot.findBlock({ matching: tableId, maxDistance: options.craftingTableSearchRadius || 32 }) || null
}

function foodRestoreEstimate(itemName) {
  const values = {
    bread: 5,
    cooked_beef: 8,
    cooked_porkchop: 8,
    cooked_chicken: 6,
    cooked_mutton: 6,
    cooked_rabbit: 5,
    cooked_cod: 5,
    cooked_salmon: 6,
    apple: 4,
    carrot: 3,
    baked_potato: 5,
    pumpkin_pie: 8,
    melon_slice: 2
  }
  return values[itemName] || 4
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function posKey(position) {
  if (!position) return 'unknown'
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function distance(a, b) {
  if (!a || !b) return 0
  if (typeof a.distanceTo === 'function') return a.distanceTo(b)
  const dx = Number(a.x || 0) - Number(b.x || 0)
  const dy = Number(a.y || 0) - Number(b.y || 0)
  const dz = Number(a.z || 0) - Number(b.z || 0)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

module.exports = {
  DEFAULT_FARM_SCAN_RADIUS,
  FarmingSystem
}
