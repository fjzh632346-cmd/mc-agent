const {
  countItem,
  getEmptySlotCount,
  getInventorySummary,
  hasItem,
  isInventoryFull
} = require('../actions/inventory')

class InventorySystem {
  constructor(options = {}) {
    this.options = {
      minFoodCount: 3,
      requiredTools: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
      ...options
    }
  }

  canHandle(task) {
    return ['inventory_check', 'check_inventory', 'inventory_status'].includes(task?.type)
  }

  async run(task = {}, context = {}) {
    const summary = getInventorySummary(context)
    if (!summary.ok) return summary

    const full = isInventoryFull(context)
    if (!full.ok) return full

    const emptySlots = getEmptySlotCount(context)
    if (!emptySlots.ok) return emptySlots

    const foodStatus = this.checkFood(context, task)
    const toolStatus = this.checkTools(context, task)

    return {
      ok: true,
      message: 'inventory_checked',
      data: {
        summary: summary.data,
        full: full.data.full,
        nearFull: full.data.nearFull,
        emptySlots: emptySlots.data.emptySlots,
        missingFood: foodStatus.missingFood,
        foodCount: foodStatus.foodCount,
        missingTool: toolStatus.missingTool,
        availableTools: toolStatus.availableTools
      }
    }
  }

  checkFood(context, task = {}) {
    const minFoodCount = task.params?.minFoodCount ?? this.options.minFoodCount
    const summary = getInventorySummary(context)
    const foodCount = summary.ok ? summary.data.foodCount : 0
    return {
      foodCount,
      missingFood: foodCount < minFoodCount
    }
  }

  checkTools(context, task = {}) {
    const requiredTools = task.params?.requiredTools || this.options.requiredTools
    const availableTools = []

    for (const tool of requiredTools) {
      const result = countItem(context, tool)
      if (result.ok && result.data.count > 0) availableTools.push(tool)
    }

    return {
      availableTools,
      missingTool: availableTools.length === 0
    }
  }

  hasRequiredItem(context, itemName, count = 1) {
    return hasItem(context, itemName, count)
  }
}

module.exports = { InventorySystem }
