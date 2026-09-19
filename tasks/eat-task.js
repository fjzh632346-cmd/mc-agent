const { BaseTask } = require('./base-task')
const { eatFood } = require('../actions/inventory')
const { selectSafeFood } = require('./task-utils')
const { StorageSystem } = require('../systems/storage-system')

class EatTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'eat_food' })
    this.started = false
    this.foodState = {
      selectedFood: null,
      noFoodInInventory: false,
      checkedStorage: false,
      storageResult: null,
      result: null,
      statusOwner: options.params?.statusOwner || 'bot'
    }
  }

  get requiredLocks() {
    return this.params?.allowStorageFallback === false ? ['inventory'] : ['movement', 'inventory']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    let foodItemName = this.selectFood(ctx)
    this.foodState.selectedFood = foodItemName

    if (!foodItemName && this.params.allowStorageFallback !== false) {
      this.foodState.noFoodInInventory = true
      this.foodState.checkedStorage = true
      logEvent(ctx, `[food] input=${this.params.input || 'eat_food'} actionKey=EAT_FOOD selectedFood=none result=no_food_in_inventory`)
      const stored = await this.fetchFoodFromStorage(ctx)
      this.foodState.storageResult = stored.error || stored.message || (stored.ok ? 'ok' : 'failed')
      if (stored.ok) {
        foodItemName = this.selectFood(ctx)
        this.foodState.selectedFood = foodItemName
      }
    }

    if (!foodItemName) {
      this.foodState.result = 'no_food_available'
      logEvent(ctx, `[food] noFoodInInventory=${this.foodState.noFoodInInventory} checkedStorage=${this.foodState.checkedStorage} result=no_food_available`)
      await this.fail(ctx, 'no_food_available')
      return
    }

    logEvent(ctx, `[food] input=${this.params.input || 'eat_food'} actionKey=EAT_FOOD selectedFood=${foodItemName} result=start`)
    const result = await eatFood(ctx, { owner: this.id, itemName: foodItemName })
    this.foodState.result = result.ok ? 'ok' : (result.error || 'eat_failed')
    logEvent(ctx, `[food] input=${this.params.input || 'eat_food'} actionKey=EAT_FOOD selectedFood=${foodItemName} result=${this.foodState.result}`)
    if (result.ok) await this.complete(ctx, { ...result.data, foodState: this.foodState })
    else await this.fail(ctx, result.error || 'eat_failed')
  }

  selectFood(ctx) {
    if (ctx.equipmentSystem && typeof ctx.equipmentSystem.selectBestFood === 'function') {
      const selection = ctx.equipmentSystem.selectBestFood(ctx)
      if (selection.success) return selection.itemName
    }
    const food = selectSafeFood(ctx)
    return food?.name || null
  }

  async fetchFoodFromStorage(ctx) {
    const storageSystem = ctx.storageSystem || new StorageSystem()
    const result = await storageSystem.takeItems(ctx, {
      owner: this.id,
      itemName: 'food',
      category: 'food',
      itemCategory: 'food',
      count: 1,
      query: this.params.input || 'eat_food_storage_fallback'
    })
    logEvent(ctx, `[food] noFoodInInventory=true checkedStorage=true result=${result.ok ? 'storage_food_found' : result.error || 'storage_food_not_found'}`)
    return result
  }

  toJSON() {
    return {
      ...super.toJSON(),
      foodState: this.foodState
    }
  }
}

function logEvent(ctx, message) {
  if (ctx?.logger?.log) ctx.logger.log(message)
  else if (ctx?.debug) ctx.debug(message)
}

module.exports = { EatTask }
