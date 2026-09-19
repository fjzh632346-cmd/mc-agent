const { BaseTask } = require('./base-task')
const { craftItem } = require('../actions/craft')
const { CraftingSystem } = require('../systems/CraftingSystem')

class CraftTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'craft_item' })
    this.started = false
    this.plan = null
    this.craftingSystem = options.craftingSystem || new CraftingSystem()
  }

  get requiredLocks() {
    return ['crafting', 'inventory']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    const itemName = this.params.itemName || this.params.item
    if (!itemName) {
      await this.fail(ctx, 'missing_item_name')
      return
    }

    const requestedCount = this.params.count || 1
    const craftMode = this.params.craftMode || 'specified'

    const craftingSystem = ctx.craftingSystem || this.craftingSystem

    const plan = craftingSystem.planRecipe(itemName, requestedCount, craftMode, ctx)
    if (!plan.ok) {
      this.plan = plan
      log(ctx, `[crafting] targetItem=${itemName} recursivePlan=null missingMaterials=${JSON.stringify(plan.missingMaterials || [])} result=${plan.reason}`)
      if (plan.reason === 'missing_materials' && !this.params.storageFetched && ctx.taskManager?.enqueue) {
        const storageDeps = (plan.missingMaterials || [])
          .filter(dep => dep.item && Number(dep.needed || 0) > 0)
        if (storageDeps.length > 0) {
          const logItems = storageDeps.map(dep => `${dep.item}:${dep.needed}`).join(',')
          ctx.debug?.(`[CraftTask] fetching from storage: ${logItems}`)
          for (const dep of storageDeps) {
            ctx.taskManager.enqueue('storage', {
              mode: 'TAKE_ITEMS',
              itemName: dep.item,
              count: dep.needed
            }, this.priority + 2)
          }
          ctx.taskManager.enqueue('craft_item', {
            itemName,
            count: requestedCount,
            craftMode,
            storageFetched: true
          }, this.priority)
          await this.fail(ctx, `storage_fetch_needed:${logItems}`)
          return
        }
      }
      const targetItem = plan.targetItem || plan.selectedFromAbstract || itemName
      const reason = plan.reason === 'missing_materials'
        ? `missing_materials:${targetItem}:${JSON.stringify(plan.missingMaterials)}`
        : plan.reason === 'no_recipe'
          ? `no_recipe:${targetItem}`
          : plan.reason === 'reserved_item_conflict'
            ? `reserved_item_conflict:${targetItem}:${JSON.stringify(plan.reservedConflicts || [])}`
          : plan.reason
      await this.fail(ctx, reason)
      return
    }

    this.plan = plan
    log(ctx, `[crafting] targetItem=${itemName} recursivePlan=${JSON.stringify((plan.steps || []).map(s => ({ item: s.item, count: s.count, needsCraftingTable: s.needsCraftingTable })))} missingMaterials=[] result=planned`)

    if (!this.params.storageFetched) {
      const storageDeps = craftingSystem.getStorageDependencies(plan, ctx)
      if (storageDeps.length > 0) {
        const logItems = storageDeps.map(d => `${d.item}:${d.neededFromStorage}`).join(',')
        ctx.debug?.(`[CraftTask] fetching from storage: ${logItems}`)
        for (const dep of storageDeps) {
          ctx.taskManager.enqueue('storage', {
            mode: 'TAKE_ITEMS',
            itemName: dep.item,
            count: dep.neededFromStorage
          }, this.priority + 2)
        }
        ctx.taskManager.enqueue('craft_item', {
          itemName,
          count: requestedCount,
          craftMode,
          storageFetched: true
        }, this.priority)
        await this.fail(ctx, `storage_fetch_needed:${logItems}`)
        return
      }
    }

    const result = await craftingSystem.executePlan(plan, ctx)
    if (result.success) {
      let equippedWeapon = null
      if (this.params.equipAfter && ctx.equipmentSystem?.equipBestWeapon) {
        equippedWeapon = await ctx.equipmentSystem.equipBestWeapon(ctx)
      }
      log(ctx, `[crafting] targetItem=${itemName} recursivePlan=${JSON.stringify((plan.steps || []).map(s => s.item))} missingMaterials=[] result=ok`)
      await this.complete(ctx, {
        targetItem: result.targetItem,
        craftedCount: result.craftedCount,
        executedSteps: result.executedSteps,
        equippedWeapon
      })
    } else {
      log(ctx, `[crafting] targetItem=${itemName} recursivePlan=${JSON.stringify((plan.steps || []).map(s => s.item))} missingMaterials=${JSON.stringify(result.missingMaterials || [])} result=${result.reason || 'craft_failed'}`)
      await this.fail(ctx, result.reason || 'craft_failed')
    }
  }

  toJSON() {
    const base = super.toJSON()
    return {
      ...base,
      plan: this.plan ? {
        targetItem: this.plan.targetItem,
        abstractTarget: this.plan.abstractTarget || null,
        selectedFromAbstract: this.plan.selectedFromAbstract || null,
        requestedCount: this.plan.requestedCount,
        plannedCount: this.plan.plannedCount,
        steps: (this.plan.steps || []).map(s => ({
          step: s.step, item: s.item, count: s.count, needsCraftingTable: s.needsCraftingTable
        })),
        missingMaterials: this.plan.missingMaterials || []
      } : null
    }
  }
}

function log(ctx, message) {
  if (ctx.logger?.log) ctx.logger.log(message)
  else if (ctx.debug) ctx.debug(message)
}

module.exports = { CraftTask }
