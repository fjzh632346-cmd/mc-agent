const { EquipmentSystem } = require('./EquipmentSystem')
const { CraftingSystem } = require('./CraftingSystem')

const PICKAXE_BY_MIN_TIER = {
  wood: ['wooden_pickaxe', 'stone_pickaxe'],
  stone: ['stone_pickaxe'],
  iron: [],
  diamond: []
}

class AutoPreparationSystem {
  constructor(options = {}) {
    this.equipmentSystem = options.equipmentSystem || new EquipmentSystem()
    this.craftingSystem = options.craftingSystem || new CraftingSystem(options.craftingOptions || {})
    this.storageSystem = options.storageSystem || null
    this.logger = options.logger || console
  }

  async ensureToolForBlock(context, blockName, options = {}) {
    const ctx = this._withContext(context)
    const selection = this.equipmentSystem.selectBestToolForBlock(blockName, ctx)
    if (selection.success) {
      const fallbackUsed = selection.itemName === 'hand'
      const reason = fallbackUsed ? 'bare_hand_fallback' : 'already_available'
      this._log(ctx, `[auto-prep] target=tool block=${blockName} result=${reason} item=${selection.itemName} preferredTool=${selection.preferredTool || 'none'} allowHand=${selection.allowHand === true}`)
      return {
        ok: true,
        reason,
        itemName: selection.itemName,
        alreadyAvailable: !fallbackUsed,
        fallbackUsed,
        fallback: fallbackUsed ? 'bare_hand' : null,
        ...this._toolExecutionDetails(selection),
        selection
      }
    }

    if (selection.reason !== 'missing_required_tool') {
      this._log(ctx, `[auto-prep] target=tool block=${blockName} result=failed reason=${selection.reason || 'unknown'}`)
      return {
        ok: false,
        reason: selection.reason || 'tool_selection_failed',
        ...this._toolExecutionDetails(selection),
        selection
      }
    }

    if (selection.toolType !== 'pickaxe') {
      const reason = `unsupported_tool_type:${selection.toolType || 'unknown'}`
      this._log(ctx, `[auto-prep] target=tool block=${blockName} result=failed reason=${reason}`)
      return {
        ok: false,
        reason,
        ...this._toolExecutionDetails(selection),
        selection
      }
    }

    const candidates = this._pickaxeCandidates(selection.minTier)
    if (!candidates.length) {
      const reason = `unsupported_min_tier:${selection.minTier || 'unknown'}`
      this._log(ctx, `[auto-prep] target=tool block=${blockName} result=failed reason=${reason}`)
      return {
        ok: false,
        reason,
        ...this._toolExecutionDetails(selection),
        selection
      }
    }

    let lastFailure = null
    for (const itemName of candidates) {
      const prepared = await this.ensureItem(ctx, itemName, 1, {
        ...options,
        purpose: options.purpose || `tool_for:${blockName}`
      })
      if (!prepared.ok) {
        lastFailure = {
          ...prepared,
          itemName
        }
        continue
      }

      const verify = this.equipmentSystem.selectBestToolForBlock(blockName, ctx)
      if (verify.success) {
        this._log(ctx, `[auto-prep] target=tool block=${blockName} result=prepared item=${verify.itemName}`)
        return {
          ok: true,
          reason: 'prepared',
          itemName: verify.itemName,
          craftedItemName: itemName,
          fallbackUsed: false,
          fallback: null,
          ...this._toolExecutionDetails(verify),
          selection: verify,
          prepared
        }
      }

      lastFailure = {
        ok: false,
        reason: `prepared_tool_not_usable:${verify.reason || 'unknown'}`,
        itemName,
        selection: verify
      }
    }

    const reason = lastFailure?.reason || 'tool_preparation_failed'
    this._log(ctx, `[auto-prep] target=tool block=${blockName} result=failed reason=${reason}`)
    return {
      ok: false,
      reason,
      missingMaterials: lastFailure?.missingMaterials || [],
      storageDeps: lastFailure?.storageDeps || [],
      ...this._toolExecutionDetails(selection),
      selection,
      lastFailure
    }
  }

  async ensureCombatWeapon(context, options = {}) {
    const ctx = this._withContext(context)
    const selection = this.equipmentSystem.selectBestWeaponForTarget(ctx, options)

    if (!selection.success) {
      if (['missing_weapon', 'no_inventory'].includes(selection.reason)) {
        this._log(ctx, `[auto-prep] target=weapon result=bare_hand_fallback reason=${selection.reason || 'missing_weapon'} preferredWeapon=${options.preferredWeaponType || options.preferredWeaponName || options.weaponType || 'none'}`)
        return {
          ok: true,
          reason: 'bare_hand_fallback',
          itemName: 'hand',
          alreadyAvailable: false,
          fallbackUsed: true,
          fallback: 'bare_hand',
          allowHand: true,
          canExecuteBareHand: true,
          preferredWeaponType: options.preferredWeaponType || options.weaponType || null,
          selection
        }
      }

      this._log(ctx, `[auto-prep] target=weapon result=failed reason=${selection.reason || 'unknown'}`)
      return {
        ok: false,
        reason: selection.reason || 'weapon_selection_failed',
        fallbackUsed: false,
        fallback: null,
        allowHand: false,
        canExecuteBareHand: false,
        selection
      }
    }

    const equipped = await this.equipmentSystem.equipBestWeapon(ctx, options)
    if (!equipped.success) {
      this._log(ctx, `[auto-prep] target=weapon result=failed reason=${equipped.reason || 'equip_failed'} selected=${selection.itemName || 'none'}`)
      return {
        ok: false,
        reason: equipped.reason || 'weapon_equip_failed',
        itemName: selection.itemName,
        fallbackUsed: false,
        fallback: null,
        allowHand: false,
        canExecuteBareHand: false,
        selection,
        equipped
      }
    }

    this._log(ctx, `[auto-prep] target=weapon result=equipped item=${equipped.itemName || selection.itemName} weaponType=${equipped.weaponType || selection.weaponType || 'unknown'} reason=${equipped.reason || selection.reason || 'best_weapon_available'}`)
    return {
      ok: true,
      reason: equipped.alreadyEquipped ? 'already_equipped' : 'equipped',
      itemName: equipped.itemName || selection.itemName,
      alreadyAvailable: true,
      fallbackUsed: false,
      fallback: null,
      allowHand: false,
      canExecuteBareHand: false,
      weaponType: equipped.weaponType || selection.weaponType || null,
      weaponTier: equipped.weaponTier || selection.weaponTier || null,
      weaponDamage: equipped.weaponDamage || selection.weaponDamage || null,
      durabilityPercent: equipped.durabilityPercent ?? selection.durabilityPercent ?? null,
      selection,
      equipped
    }
  }

  async ensureFarmingItems(context, options = {}) {
    const ctx = this._withContext(context)
    const mode = options.mode || options.farmingMode || 'FARM_CYCLE'
    const requiresSeeds = mode === 'PLANT_WHEAT' || mode === 'FARM_CYCLE' || options.requiresSeeds === true
    const requiredSeeds = requiresSeeds ? Math.max(1, Number(options.requiredSeeds || options.seedCount || options.count || 1) || 1) : 0

    if (!requiresSeeds || requiredSeeds <= 0) {
      this._log(ctx, `[auto-prep] target=farmingItem mode=${mode} result=no_tool_required item=hand seedsRequired=0`)
      return {
        ok: true,
        reason: 'harvest_requires_no_tool',
        mode,
        itemName: 'hand',
        requiredSeeds: 0,
        currentSeeds: this._inventoryCount(ctx.bot, 'wheat_seeds'),
        allowHand: true,
        canExecuteBareHand: true,
        fallbackUsed: true,
        optionalTool: options.requiresHoe ? 'hoe' : null
      }
    }

    const currentSeeds = this._inventoryCount(ctx.bot, 'wheat_seeds')
    if (currentSeeds >= requiredSeeds) {
      this._log(ctx, `[auto-prep] target=farmingItem item=wheat_seeds mode=${mode} result=existing count=${currentSeeds} required=${requiredSeeds}`)
      return {
        ok: true,
        reason: 'seeds_available',
        mode,
        itemName: 'wheat_seeds',
        requiredSeeds,
        currentSeeds,
        alreadyAvailable: true,
        optionalTool: options.requiresHoe ? 'hoe' : null
      }
    }

    const missingSeeds = requiredSeeds - currentSeeds
    if (options.allowStorage) {
      const storageSystem = ctx.storageSystem || this.storageSystem
      if (storageSystem && typeof storageSystem.takeItems === 'function') {
        const storageResult = await storageSystem.takeItems(ctx, {
          itemName: 'wheat_seeds',
          count: missingSeeds,
          owner: options.owner || options.taskId || 'auto-preparation',
          canDig: options.canDig
        })
        const afterStorageSeeds = this._inventoryCount(ctx.bot, 'wheat_seeds')
        if (storageResult?.ok && afterStorageSeeds >= requiredSeeds) {
          this._log(ctx, `[auto-prep] target=farmingItem item=wheat_seeds mode=${mode} result=storage_fetched count=${afterStorageSeeds} required=${requiredSeeds}`)
          return {
            ok: true,
            reason: 'storage_fetched',
            mode,
            itemName: 'wheat_seeds',
            requiredSeeds,
            currentSeeds: afterStorageSeeds,
            storageResult,
            optionalTool: options.requiresHoe ? 'hoe' : null
          }
        }

        const reason = storageResult?.error || storageResult?.reason || 'insufficient_seeds'
        this._log(ctx, `[auto-prep] target=farmingItem item=wheat_seeds mode=${mode} result=failed reason=${reason} current=${afterStorageSeeds} required=${requiredSeeds}`)
        return {
          ok: false,
          reason,
          itemName: 'wheat_seeds',
          mode,
          requiredSeeds,
          currentSeeds: afterStorageSeeds,
          missingSeeds: Math.max(0, requiredSeeds - afterStorageSeeds),
          storageResult
        }
      }

      this._log(ctx, `[auto-prep] target=farmingItem item=wheat_seeds mode=${mode} result=failed reason=storage_unavailable current=${currentSeeds} required=${requiredSeeds}`)
      return {
        ok: false,
        reason: 'storage_unavailable',
        itemName: 'wheat_seeds',
        mode,
        requiredSeeds,
        currentSeeds,
        missingSeeds
      }
    }

    this._log(ctx, `[auto-prep] target=farmingItem item=wheat_seeds mode=${mode} result=failed reason=missing_seeds current=${currentSeeds} required=${requiredSeeds}`)
    return {
      ok: false,
      reason: 'missing_seeds',
      itemName: 'wheat_seeds',
      mode,
      requiredSeeds,
      currentSeeds,
      missingSeeds
    }
  }

  async ensureItem(context, itemName, count = 1, options = {}) {
    const ctx = this._withContext(context)
    const currentCount = this._inventoryCount(ctx.bot, itemName)
    if (currentCount >= count) {
      this._log(ctx, `[auto-prep] target=item item=${itemName} result=existing count=${currentCount}`)
      return {
        ok: true,
        reason: 'already_available',
        itemName,
        count,
        currentCount,
        alreadyAvailable: true
      }
    }

    const needed = Math.max(1, count - currentCount)
    let plan = this.craftingSystem.planRecipe(itemName, needed, options.mode || 'specified', ctx)

    if (!plan.ok) {
      const missingMaterials = plan.missingMaterials || []
      this._log(ctx, `[auto-prep] target=item item=${itemName} result=failed reason=${plan.reason || 'plan_failed'} missing=${missingMaterials.map((m) => `${m.itemName || m.item || m.name}:${m.missing ?? m.needed ?? m.count ?? 'unknown'}`).join(',') || 'none'}`)
      return {
        ok: false,
        reason: plan.reason || 'plan_failed',
        itemName,
        count,
        missingMaterials,
        plan
      }
    }

    const storageDeps = this._normalizeStorageDependencies(this.craftingSystem.getStorageDependencies(plan, ctx))
    if (storageDeps.length > 0) {
      if (!options.allowStorage) {
        this._log(ctx, `[auto-prep] target=item item=${itemName} result=failed reason=storage_required deps=${this._formatStorageDependencies(storageDeps)}`)
        return {
          ok: false,
          reason: 'storage_required',
          itemName,
          count,
          storageDeps,
          plan
        }
      }

      const storageResult = await this._tryFetchFromStorage(ctx, storageDeps, options)
      if (!storageResult.ok) {
        return {
          ok: false,
          reason: storageResult.reason,
          itemName,
          count,
          storageDeps,
          plan,
          storageResult
        }
      }

      plan = this.craftingSystem.planRecipe(itemName, needed, options.mode || 'specified', ctx)
      if (!plan.ok) {
        return {
          ok: false,
          reason: plan.reason || 'plan_failed_after_storage',
          itemName,
          count,
          missingMaterials: plan.missingMaterials || [],
          plan
        }
      }
    }

    const result = await this.craftingSystem.executePlan(plan, ctx)
    const craftOk = result.ok === true || result.success === true
    if (!craftOk) {
      this._log(ctx, `[auto-prep] target=item item=${itemName} result=failed reason=${result.reason || 'craft_failed'}`)
      return {
        ok: false,
        reason: result.reason || 'craft_failed',
        itemName,
        count,
        plan,
        result
      }
    }

    const finalCount = await this._waitForInventoryCount(ctx.bot, itemName, count, {
      timeoutMs: options.craftInventoryConfirmTimeoutMs,
      intervalMs: options.craftInventoryConfirmIntervalMs
    })
    if (finalCount < count) {
      const reason = `crafted_item_not_available:${finalCount}/${count}`
      this._log(ctx, `[auto-prep] target=item item=${itemName} result=failed reason=${reason}`)
      return {
        ok: false,
        reason,
        itemName,
        count,
        finalCount,
        plan,
        result
      }
    }

    this._log(ctx, `[auto-prep] target=item item=${itemName} result=crafted count=${finalCount}`)
    return {
      ok: true,
      reason: 'crafted',
      itemName,
      count,
      finalCount,
      plan,
      result
    }
  }

  _pickaxeCandidates(minTier) {
    return [...(PICKAXE_BY_MIN_TIER[minTier] || [])]
  }

  _toolExecutionDetails(selection = {}) {
    return {
      preferredTool: selection.preferredTool || selection.toolType || null,
      requiredTool: selection.requiredTool || null,
      toolType: selection.toolType || selection.preferredTool || null,
      minTier: selection.minTier || null,
      allowHand: selection.allowHand === true,
      canExecuteBareHand: selection.allowHand === true && !selection.requiredTool
    }
  }

  _withContext(context = {}) {
    return {
      ...context,
      equipmentSystem: context.equipmentSystem || this.equipmentSystem,
      craftingSystem: context.craftingSystem || this.craftingSystem,
      storageSystem: context.storageSystem || this.storageSystem
    }
  }

  _inventoryCount(bot, itemName) {
    if (!bot?.inventory?.items) return 0
    return bot.inventory.items()
      .filter((item) => item?.name === itemName)
      .reduce((sum, item) => sum + (item.count || 0), 0)
  }

  async _waitForInventoryCount(bot, itemName, count, options = {}) {
    const required = Math.max(1, Number(count) || 1)
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 1800) || 0)
    const intervalMs = Math.max(25, Number(options.intervalMs ?? 100) || 100)
    const startedAt = Date.now()

    let current = this._inventoryCount(bot, itemName)
    while (current < required && Date.now() - startedAt < timeoutMs) {
      await sleep(intervalMs)
      current = this._inventoryCount(bot, itemName)
    }
    return current
  }

  async _tryFetchFromStorage(context, storageDeps, options) {
    const storageSystem = context.storageSystem || this.storageSystem
    if (!storageSystem || typeof storageSystem.takeItems !== 'function') {
      const reason = 'storage_unavailable'
      this._log(context, `[auto-prep] target=storage result=failed reason=${reason}`)
      return { ok: false, reason }
    }

    const deps = this._normalizeStorageDependencies(storageDeps)
    for (const dep of deps) {
      const result = await storageSystem.takeItems(context, {
        itemName: dep.itemName,
        count: dep.count,
        owner: options.owner || options.taskId || 'auto-preparation',
        query: options.query || dep.itemName,
        radius: options.radius,
        scanCenters: options.sourceScanCenters || options.storageScanCenters || options.scanCenters,
        scanOnlyProvidedCenters: options.scanOnlyProvidedCenters,
        exactScanCenters: options.exactScanCenters,
        skipUtilitySearch: options.skipUtilitySearch,
        skipMemorySearch: options.skipMemorySearch,
        sourceContainerPreference: options.sourceContainerPreference,
        canDig: options.canDig
      })
      if (!result?.ok) {
        const reason = result?.reason || `storage_take_failed:${dep.itemName}`
        this._log(context, `[auto-prep] target=storage item=${dep.itemName} result=failed reason=${reason}`)
        return { ok: false, reason, dep, result }
      }
    }

    this._log(context, `[auto-prep] target=storage result=ok deps=${this._formatStorageDependencies(deps)}`)
    return { ok: true }
  }

  _normalizeStorageDependencies(storageDeps = []) {
    if (!Array.isArray(storageDeps)) return []
    return storageDeps
      .map(dep => this._normalizeStorageDependency(dep))
      .filter(dep => dep.itemName && dep.count > 0)
  }

  _normalizeStorageDependency(dep = {}) {
    const itemName = dep.itemName || dep.item || dep.name || null
    const rawCount = dep.count ?? dep.neededFromStorage ?? dep.needed ?? dep.missing ?? 0
    const count = Math.max(0, Number(rawCount) || 0)
    return {
      ...dep,
      itemName,
      count,
      item: dep.item || itemName,
      neededFromStorage: dep.neededFromStorage ?? count
    }
  }

  _formatStorageDependencies(storageDeps = []) {
    const deps = this._normalizeStorageDependencies(storageDeps)
    return deps.map(dep => `${dep.itemName}:${dep.count}`).join(',') || 'none'
  }

  _log(context, message) {
    if (context?.logger?.log) {
      context.logger.log(message)
      return
    }
    if (this.logger?.log) this.logger.log(message)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  AutoPreparationSystem
}
