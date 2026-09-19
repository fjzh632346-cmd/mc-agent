const { distance } = require('../actions/action-utils')
const { moveTo } = require('../actions/move')
const { toBlockVec3 } = require('../utils/position')

const SMELTING_RECIPES = {
  raw_iron: { output: 'iron_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  iron_ore: { output: 'iron_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  deepslate_iron_ore: { output: 'iron_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  raw_gold: { output: 'gold_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  gold_ore: { output: 'gold_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  deepslate_gold_ore: { output: 'gold_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  raw_copper: { output: 'copper_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  copper_ore: { output: 'copper_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  deepslate_copper_ore: { output: 'copper_ingot', mode: 'ore', furnacePreference: ['blast_furnace', 'furnace'] },
  sand: { output: 'glass', mode: 'general', furnacePreference: ['furnace'] },
  oak_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  spruce_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  birch_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  jungle_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  acacia_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  dark_oak_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  mangrove_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  cherry_log: { output: 'charcoal', mode: 'general', furnacePreference: ['furnace'] },
  cobblestone: { output: 'stone', mode: 'general', furnacePreference: ['furnace'] },
  beef: { output: 'cooked_beef', mode: 'food', furnacePreference: ['smoker', 'furnace'] },
  porkchop: { output: 'cooked_porkchop', mode: 'food', furnacePreference: ['smoker', 'furnace'] },
  chicken: { output: 'cooked_chicken', mode: 'food', furnacePreference: ['smoker', 'furnace'] },
  mutton: { output: 'cooked_mutton', mode: 'food', furnacePreference: ['smoker', 'furnace'] },
  potato: { output: 'baked_potato', mode: 'food', furnacePreference: ['smoker', 'furnace'] }
}

const FUEL_PRIORITY = ['coal', 'charcoal', 'coal_block', 'lava_bucket', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'stick']
const RESERVED_FUEL = {
  coal: 0,
  charcoal: 0,
  oak_log: 4,
  spruce_log: 4,
  birch_log: 4,
  jungle_log: 4,
  acacia_log: 4,
  dark_oak_log: 4,
  oak_planks: 8,
  spruce_planks: 8,
  birch_planks: 8,
  jungle_planks: 8,
  acacia_planks: 8,
  dark_oak_planks: 8,
  stick: 8
}
const FUEL_SMELT_UNITS = {
  coal: 8,
  charcoal: 8,
  coal_block: 80,
  lava_bucket: 100,
  oak_planks: 1.5,
  spruce_planks: 1.5,
  birch_planks: 1.5,
  jungle_planks: 1.5,
  acacia_planks: 1.5,
  dark_oak_planks: 1.5,
  stick: 0.5
}

class SmeltingSystem {
  constructor(options = {}) {
    this.options = {
      defaultCount: 64,
      furnaceSearchRadius: 64,
      maxSingleFurnaceBatch: 64,
      outputPollIntervalMs: 500,
      outputLogIntervalMs: 5000,
      outputTimeoutBaseMs: 5000,
      outputTimeoutPerItemMs: 12000,
      ...options
    }
    this.state = {
      targetInput: null,
      targetOutput: null,
      requestedCount: null,
      smeltMode: null,
      plannedCount: 0,
      smeltedCount: 0,
      selectedFurnace: null,
      selectedFuel: null,
      fuelItem: null,
      fuelCount: 0,
      furnaceBatches: null,
      parallelPlan: null,
      inputSourceInventory: false,
      inputSourceStorage: false,
      fuelSourceInventory: false,
      fuelSourceStorage: false,
      currentStep: 'idle',
      lastSmeltError: null,
      finishReason: null
    }
  }

  plan(context = {}, options = {}) {
    const counts = inventoryCounts(context)
    const target = this.resolveTarget(context, options.inputName, counts)
    if (!target) return this.fail('smelt_failed_no_input')

    const available = counts[target.input] || 0
    if (available <= 0) return this.fail('smelt_failed_no_input', { targetInput: target.input, targetOutput: target.output })

    const quantity = resolveSmeltQuantity(options.count, options.smeltMode, available, this.options.defaultCount)
    const requested = quantity.requestedCount
    if (quantity.mode === 'specified' && available < requested) {
      return this.fail('smelt_failed_insufficient_input', {
        targetInput: target.input,
        targetOutput: target.output,
        requestedCount: requested,
        availableCount: available,
        missingCount: requested - available,
        smeltMode: quantity.mode
      })
    }
    const parallelEnabled = options.parallelFurnaces === true
    if (quantity.strict && !parallelEnabled && requested > this.options.maxSingleFurnaceBatch) {
      return this.fail('smelt_failed_batch_too_large', {
        targetInput: target.input,
        targetOutput: target.output,
        requestedCount: requested,
        maxSingleFurnaceBatch: this.options.maxSingleFurnaceBatch,
        smeltMode: quantity.mode
      })
    }
    const fuel = this.selectFuel(counts, requested)
    if (!fuel) return this.fail('smelt_failed_no_fuel', { targetInput: target.input, targetOutput: target.output, requestedCount: requested })
    if (quantity.strict && fuel.capacity < requested) {
      return this.fail('smelt_failed_insufficient_fuel', {
        targetInput: target.input,
        targetOutput: target.output,
        requestedCount: requested,
        fuelCapacity: fuel.capacity,
        missingFuelCapacity: requested - fuel.capacity,
        maxSmeltableCount: fuel.capacity,
        selectedFuel: fuel.itemName,
        fuelCount: fuel.count,
        smeltMode: quantity.mode
      })
    }

    const furnace = this.findFurnace(context, target, options)
    if (!furnace.ok) return this.fail(furnace.error, { targetInput: target.input, targetOutput: target.output, requestedCount: requested })
    const plannedCount = quantity.strict ? requested : Math.min(requested, available, fuel.capacity)
    const furnaceBatches = parallelEnabled
      ? this.buildFurnaceBatches(this.findFurnaceCandidates(context, target, options, furnace), target, fuel, plannedCount)
      : null
    if (parallelEnabled && !furnaceBatches.length) {
      return this.fail('smelt_failed_batch_too_large', {
        targetInput: target.input,
        targetOutput: target.output,
        requestedCount: requested,
        plannedCount,
        maxSingleFurnaceBatch: this.options.maxSingleFurnaceBatch,
        selectedFurnaceCount: 0,
        smeltMode: quantity.mode
      })
    }

    const plan = {
      ok: true,
      targetInput: target.input,
      targetOutput: target.output,
      requestedCount: requested,
      smeltMode: quantity.mode,
      recipeMode: target.mode,
      strictQuantity: quantity.strict,
      availableCount: available,
      fuelCapacity: fuel.capacity,
      plannedCount,
      selectedFuel: fuel.itemName,
      fuelItem: fuel.itemName,
      fuelCount: fuel.count,
      selectedFurnace: furnace.position,
      furnaceBlock: furnace.block,
      furnaceType: furnace.type,
      furnaceBatches,
      parallelPlan: furnaceBatches
        ? {
            enabled: true,
            totalInputCount: plannedCount,
            totalFuelCount: furnaceBatches.reduce((sum, batch) => sum + batch.fuelCount, 0),
            batchCount: furnaceBatches.length,
            batches: furnaceBatches
          }
        : null,
      inputSourceInventory: true,
      fuelSourceInventory: true
    }
    this.state = { ...this.state, ...plan, currentStep: 'planned', lastSmeltError: null, finishReason: null }
    return plan
  }

  async execute(context = {}, plan) {
    if (!plan?.ok) return plan
    const bot = context.bot
    if (typeof bot?.openFurnace !== 'function') return this.fail('smelt_failed_unknown', { detail: 'missing_open_furnace' })

    if (this.hasParallelBatches(plan)) {
      return this.executeParallelBatches(context, plan)
    }

    const input = findInventoryItem(bot, plan.targetInput)
    const fuel = findInventoryItem(bot, plan.selectedFuel)
    if (!input) return this.fail('smelt_failed_no_input')
    if (!fuel) return this.fail('smelt_failed_no_fuel')

    let furnace
    try {
      if (distance(bot.entity?.position, plan.selectedFurnace) > (plan.openDistance || 4.5)) {
        this.step(context, 'move_to_furnace')
        const moved = await moveTo(context, plan.selectedFurnace, {
          owner: plan.owner || 'smelting',
          range: plan.moveRange || 2,
          timeoutMs: plan.moveTimeoutMs || 20000,
          holdLock: true
        })
        if (!moved.ok) return this.fail('smelt_failed_furnace_unreachable', { detail: moved.error })
      }

      const liveBlock = bot.blockAt?.(toBlockVec3(plan.selectedFurnace)) || plan.furnaceBlock
      if (!liveBlock || !['furnace', 'blast_furnace', 'smoker'].includes(liveBlock.name)) {
        return this.fail('smelt_failed_no_furnace', { detail: 'selected_furnace_missing' })
      }

      this.step(context, 'open_furnace')
      furnace = await bot.openFurnace(liveBlock)
      this.step(context, 'put_input')
      await furnace.putInput(input.type ?? input, null, plan.plannedCount)
      this.step(context, 'put_fuel')
      await furnace.putFuel(fuel.type ?? fuel, null, plan.fuelCount)
      this.step(context, 'wait')
      const ready = await this.waitForOutputReady(context, furnace, plan)
      if (!ready.ok) return this.fail(ready.reason, ready)
      this.step(context, 'take_output')
      const output = await furnace.takeOutput()
      const outputCount = output?.count || 0
      if (!output) return this.fail('smelt_failed_output_missing', { targetOutput: plan.targetOutput, plannedCount: plan.plannedCount })
      if (output.name !== plan.targetOutput) {
        return this.fail('smelt_failed_output_mismatch', {
          targetOutput: plan.targetOutput,
          actualOutput: output.name,
          actualCount: outputCount,
          plannedCount: plan.plannedCount
        })
      }
      if (outputCount < plan.plannedCount) {
        return this.fail('smelt_failed_output_incomplete', {
          targetOutput: plan.targetOutput,
          actualCount: outputCount,
          plannedCount: plan.plannedCount
        })
      }
      this.state = {
        ...this.state,
        smeltedCount: plan.plannedCount,
        outputTakenCount: outputCount,
        currentStep: 'done',
        finishReason: 'success',
        lastSmeltError: null
      }
      log(context, `[smelting] result=success smeltedCount=${this.state.smeltedCount} failReason=none`)
      return { ok: true, ...this.state, outputNameActual: output?.name || null }
    } catch (err) {
      return this.fail(classifySmeltError(err), { detail: err.message })
    } finally {
      try { furnace?.close?.() } catch {}
    }
  }

  hasParallelBatches(plan) {
    return plan?.parallelPlan?.enabled === true && Array.isArray(plan.furnaceBatches) && plan.furnaceBatches.length > 0
  }

  async executeParallelBatches(context = {}, plan) {
    const batchResults = plan.furnaceBatches.map((batch, index) => ({
      batchIndex: index,
      furnacePosition: batch.furnacePosition,
      inputItem: batch.inputItem,
      inputCount: batch.inputCount,
      fuelItem: batch.fuelItem,
      fuelCount: batch.fuelCount,
      outputItem: batch.outputItem,
      expectedOutputCount: batch.expectedOutputCount,
      status: 'pending',
      takenCount: 0
    }))
    log(context, `[smelting] parallel_start batchCount=${batchResults.length} plannedCount=${plan.plannedCount}`)

    for (let index = 0; index < plan.furnaceBatches.length; index += 1) {
      const batch = plan.furnaceBatches[index]
      let furnace
      try {
        furnace = await this.openBatchFurnace(context, batch, index, plan)
        const input = findInventoryItem(context.bot, batch.inputItem)
        const fuel = findInventoryItem(context.bot, batch.fuelItem)
        if (!input) {
          return this.failParallelBatch(context, 'smelt_failed_no_input', plan, batchResults, {
            batchIndex: index,
            missingItem: batch.inputItem
          })
        }
        if (!fuel) {
          return this.failParallelBatch(context, 'smelt_failed_no_fuel', plan, batchResults, {
            batchIndex: index,
            missingItem: batch.fuelItem
          })
        }

        this.state.currentStep = 'parallel_put_input'
        log(context, `[smelting] parallel_put_input batch=${index} furnace=${formatPos(batch.furnacePosition)} item=${batch.inputItem} count=${batch.inputCount}`)
        await furnace.putInput(input.type ?? input, null, batch.inputCount)
        this.state.currentStep = 'parallel_put_fuel'
        log(context, `[smelting] parallel_put_fuel batch=${index} furnace=${formatPos(batch.furnacePosition)} fuel=${batch.fuelItem} count=${batch.fuelCount}`)
        await furnace.putFuel(fuel.type ?? fuel, null, batch.fuelCount)
        batchResults[index] = { ...batchResults[index], status: 'loaded' }
      } catch (err) {
        return this.failParallelBatch(context, classifySmeltError(err), plan, batchResults, {
          batchIndex: index,
          detail: err.message
        })
      } finally {
        try { furnace?.close?.() } catch {}
      }
    }

    return this.collectParallelOutputs(context, plan, batchResults)
  }

  async openBatchFurnace(context, batch, batchIndex, plan = {}) {
    const bot = context.bot
    const position = batch.furnacePosition
    if (distance(bot.entity?.position, position) > (plan.openDistance || 4.5)) {
      this.state.currentStep = 'parallel_move_to_furnace'
      const moved = await moveTo(context, position, {
        owner: plan.owner || 'smelting',
        range: plan.moveRange || 2,
        timeoutMs: plan.moveTimeoutMs || 20000,
        holdLock: true
      })
      if (!moved.ok) {
        const err = new Error(moved.error || 'batch_furnace_unreachable')
        err.code = 'smelt_failed_furnace_unreachable'
        throw err
      }
    }

    const liveBlock = bot.blockAt?.(toBlockVec3(position)) || batch.furnaceBlock
    if (!liveBlock || !['furnace', 'blast_furnace', 'smoker'].includes(liveBlock.name)) {
      const err = new Error(`batch_${batchIndex}_furnace_missing`)
      err.code = 'smelt_failed_no_furnace'
      throw err
    }
    this.state.currentStep = 'parallel_open_furnace'
    return bot.openFurnace(liveBlock)
  }

  async waitForBatchOutputReady(context, furnace, batch, plan, batchIndex) {
    const batchPlan = {
      ...plan,
      targetOutput: batch.outputItem,
      plannedCount: batch.expectedOutputCount
    }
    const output = typeof furnace.outputItem === 'function' ? furnace.outputItem() : null
    const current = output?.name === batch.outputItem ? (output.count || 0) : 0
    log(context, `[smelting] parallel_wait batch=${batchIndex} current=${current} expected=${batch.expectedOutputCount}`)
    return this.waitForOutputReady(context, furnace, batchPlan)
  }

  async collectParallelOutputs(context, plan, batchResults) {
    const pending = new Set(batchResults.map(result => result.batchIndex))
    const timeoutMs = Number(plan.outputTimeoutMs || this.options.outputTimeoutBaseMs + (plan.plannedCount * this.options.outputTimeoutPerItemMs))
    const pollIntervalMs = Number(plan.outputPollIntervalMs || this.options.outputPollIntervalMs)
    const startedAt = Date.now()
    let totalSmeltedCount = 0

    while (pending.size > 0 && Date.now() - startedAt <= timeoutMs) {
      let collectedThisRound = false
      for (const batchIndex of [...pending]) {
        const batch = plan.furnaceBatches[batchIndex]
        let furnace
        try {
          furnace = await this.openBatchFurnace(context, batch, batchIndex, plan)
          const output = typeof furnace.outputItem === 'function' ? furnace.outputItem() : null
          const current = output?.name === batch.outputItem ? (output.count || 0) : 0
          log(context, `[smelting] parallel_wait batch=${batchIndex} current=${current} expected=${batch.expectedOutputCount}`)
          if (output && output.name !== batch.outputItem) {
            return this.failParallelBatch(context, 'smelt_failed_output_mismatch', plan, batchResults, {
              batchIndex,
              targetOutput: batch.outputItem,
              actualOutput: output.name,
              actualCount: output.count || 0
            })
          }
          if (current >= batch.expectedOutputCount) {
            log(context, `[smelting] parallel_output_ready batch=${batchIndex} furnace=${formatPos(batch.furnacePosition)} output=${batch.outputItem} count=${current}`)
            const taken = await furnace.takeOutput()
            const takenCount = taken?.count || 0
            if (!taken) {
              return this.failParallelBatch(context, 'smelt_failed_output_missing', plan, batchResults, { batchIndex })
            }
            if (taken.name !== batch.outputItem) {
              return this.failParallelBatch(context, 'smelt_failed_output_mismatch', plan, batchResults, {
                batchIndex,
                targetOutput: batch.outputItem,
                actualOutput: taken.name,
                actualCount: takenCount
              })
            }
            if (takenCount !== batch.expectedOutputCount) {
              const reason = takenCount > batch.expectedOutputCount ? 'smelt_failed_output_overrun' : 'smelt_failed_output_incomplete'
              batchResults[batchIndex] = {
                ...batchResults[batchIndex],
                status: 'failed',
                takenCount,
                actualOutputCount: takenCount,
                outputNameActual: taken.name
              }
              return this.failParallelBatch(context, reason, plan, batchResults, {
                batchIndex,
                targetOutput: batch.outputItem,
                actualCount: takenCount,
                actualOutputCount: takenCount,
                expectedOutputCount: batch.expectedOutputCount,
                plannedCount: batch.expectedOutputCount
              })
            }
            log(context, `[smelting] parallel_take_output batch=${batchIndex} furnace=${formatPos(batch.furnacePosition)} count=${takenCount}`)
            batchResults[batchIndex] = {
              ...batchResults[batchIndex],
              status: 'done',
              takenCount,
              outputNameActual: taken.name
            }
            totalSmeltedCount += takenCount
            pending.delete(batchIndex)
            collectedThisRound = true
          }
        } catch (err) {
          return this.failParallelBatch(context, classifySmeltError(err), plan, batchResults, {
            batchIndex,
            detail: err.message,
            partialSmeltedCount: totalSmeltedCount
          })
        } finally {
          try { furnace?.close?.() } catch {}
        }
      }

      if (pending.size > 0 && !collectedThisRound) await sleep(pollIntervalMs)
    }

    if (pending.size > 0) {
      return this.failParallelBatch(context, 'smelt_failed_output_timeout', plan, batchResults, {
        pendingBatches: [...pending],
        partialSmeltedCount: totalSmeltedCount,
        timeoutMs
      })
    }
    if (totalSmeltedCount !== plan.plannedCount) {
      const reason = totalSmeltedCount > plan.plannedCount ? 'smelt_failed_output_overrun' : 'smelt_failed_output_incomplete'
      return this.failParallelBatch(context, reason, plan, batchResults, {
        partialSmeltedCount: totalSmeltedCount,
        actualCount: totalSmeltedCount,
        plannedCount: plan.plannedCount
      })
    }

    this.state = {
      ...this.state,
      ...plan,
      parallel: true,
      smeltedCount: totalSmeltedCount,
      outputTakenCount: totalSmeltedCount,
      batchResults,
      currentStep: 'done',
      finishReason: 'success',
      lastSmeltError: null
    }
    log(context, `[smelting] parallel_success totalSmeltedCount=${totalSmeltedCount}`)
    log(context, `[smelting] result=success smeltedCount=${this.state.smeltedCount} failReason=none`)
    return { ok: true, ...this.state, success: true, parallel: true }
  }

  failParallelBatch(context, reason, plan, batchResults, extra = {}) {
    const partialSmeltedCount = extra.partialSmeltedCount ?? batchResults.reduce((sum, result) => sum + (result.takenCount || 0), 0)
    const { ok, ...planState } = plan
    log(context, `[smelting] parallel_fail reason=${reason} partialSmeltedCount=${partialSmeltedCount}`)
    return this.fail(reason, {
      ...planState,
      ...extra,
      parallel: true,
      batchResults,
      partialSmeltedCount,
      smeltedCount: partialSmeltedCount
    })
  }

  async waitForOutputReady(context, furnace, plan) {
    const timeoutMs = Number(plan.outputTimeoutMs || this.options.outputTimeoutBaseMs + (plan.plannedCount * this.options.outputTimeoutPerItemMs))
    const pollIntervalMs = Number(plan.outputPollIntervalMs || this.options.outputPollIntervalMs)
    const logIntervalMs = Number(plan.outputLogIntervalMs || this.options.outputLogIntervalMs)
    const startedAt = Date.now()
    let lastLogAt = 0
    let lastLoggedStatus = null

    while (Date.now() - startedAt <= timeoutMs) {
      const output = typeof furnace.outputItem === 'function' ? furnace.outputItem() : null
      const status = output ? `${output.name}:${output.count || 0}` : 'none:0'
      const isTarget = output?.name === plan.targetOutput
      const currentCount = isTarget ? (output.count || 0) : 0
      const shouldLog = status !== lastLoggedStatus || Date.now() - lastLogAt >= logIntervalMs
      if (shouldLog) {
        log(context, `[smelting] step=wait_output expected=${plan.targetOutput} expectedCount=${plan.plannedCount} current=${currentCount}`)
        lastLoggedStatus = status
        lastLogAt = Date.now()
      }

      if (output && !isTarget) {
        return {
          ok: false,
          reason: 'smelt_failed_output_mismatch',
          targetOutput: plan.targetOutput,
          actualOutput: output.name,
          actualCount: output.count || 0,
          plannedCount: plan.plannedCount
        }
      }
      if (currentCount >= plan.plannedCount) {
        log(context, `[smelting] step=output_ready output=${output.name} count=${output.count || 0}`)
        return { ok: true, outputName: output.name, outputCount: output.count || 0 }
      }

      await sleep(pollIntervalMs)
    }

    const output = typeof furnace.outputItem === 'function' ? furnace.outputItem() : null
    const currentCount = output?.name === plan.targetOutput ? (output.count || 0) : 0
    return {
      ok: false,
      reason: 'smelt_failed_output_timeout',
      targetOutput: plan.targetOutput,
      actualOutput: output?.name || null,
      actualCount: output?.count || 0,
      currentCount,
      plannedCount: plan.plannedCount,
      timeoutMs
    }
  }

  resolveTarget(context, inputName, counts = inventoryCounts(context)) {
    const normalized = inputName === 'log' ? firstAvailableLog(counts) : inputName
    if (normalized && SMELTING_RECIPES[normalized]) {
      return { input: normalized, ...SMELTING_RECIPES[normalized] }
    }
    const defaults = ['raw_iron', 'iron_ore', 'deepslate_iron_ore', 'raw_gold', 'gold_ore', 'deepslate_gold_ore', 'raw_copper', 'copper_ore', 'deepslate_copper_ore', 'beef', 'porkchop', 'chicken', 'mutton', 'sand', 'cobblestone']
    const found = defaults.find(name => (counts[name] || 0) > 0 && SMELTING_RECIPES[name])
    return found ? { input: found, ...SMELTING_RECIPES[found] } : null
  }

  findFurnace(context, target, options = {}) {
    const preferred = options.preferredFurnace
      ? [options.preferredFurnace, ...target.furnacePreference.filter(name => name !== options.preferredFurnace), 'furnace']
      : target.furnacePreference
    const utility = context.utilityBlockSearch

    for (const type of preferred) {
      const found = type === 'blast_furnace'
        ? utility?.findNearestBlastFurnace?.(context, { baseRadius: this.options.furnaceSearchRadius })
        : type === 'smoker'
          ? utility?.findNearestSmoker?.(context, { baseRadius: this.options.furnaceSearchRadius })
          : utility?.findUtilityBlock?.(context, type, { baseRadius: this.options.furnaceSearchRadius })
      if (found?.ok) return { ok: true, type, block: found.block, position: found.position, distance: found.distance }
    }

    const fallback = utility?.findNearestFurnace?.(context, { baseRadius: this.options.furnaceSearchRadius })
    if (fallback?.ok) return { ok: true, type: fallback.block?.name || 'furnace', block: fallback.block, position: fallback.position, distance: fallback.distance }

    const direct = findDirectFurnace(context, preferred, this.options.furnaceSearchRadius)
    if (direct) return direct
    return { ok: false, error: 'smelt_failed_no_furnace' }
  }

  findFurnaceCandidates(context, target, options = {}, selectedFurnace = null) {
    const preferred = options.preferredFurnace
      ? [options.preferredFurnace, ...target.furnacePreference.filter(name => name !== options.preferredFurnace), 'furnace']
      : target.furnacePreference
    const utility = context.utilityBlockSearch
    const candidates = []
    if (selectedFurnace?.ok) candidates.push(selectedFurnace)

    for (const type of preferred) {
      const found = type === 'blast_furnace'
        ? utility?.findNearestBlastFurnace?.(context, { baseRadius: this.options.furnaceSearchRadius })
        : type === 'smoker'
          ? utility?.findNearestSmoker?.(context, { baseRadius: this.options.furnaceSearchRadius })
          : utility?.findUtilityBlock?.(context, type, { baseRadius: this.options.furnaceSearchRadius })
      if (found?.ok) {
        for (const candidate of found.candidates || [found]) {
          candidates.push({
            ok: true,
            type: candidate.block?.name || type,
            block: candidate.block,
            position: candidate.position,
            distance: candidate.distance
          })
        }
      }
    }

    const fallback = utility?.findNearestFurnace?.(context, { baseRadius: this.options.furnaceSearchRadius })
    if (fallback?.ok) {
      for (const candidate of fallback.candidates || [fallback]) {
        candidates.push({
          ok: true,
          type: candidate.block?.name || fallback.block?.name || 'furnace',
          block: candidate.block || fallback.block,
          position: candidate.position || fallback.position,
          distance: candidate.distance || fallback.distance
        })
      }
    }

    const direct = findDirectFurnace(context, preferred, this.options.furnaceSearchRadius)
    if (direct) candidates.push(direct)

    return uniqueFurnaces(candidates)
  }

  buildFurnaceBatches(furnaces, target, fuel, plannedCount) {
    const maxBatch = this.options.maxSingleFurnaceBatch
    const units = FUEL_SMELT_UNITS[fuel.itemName] || 1
    const selected = furnaces.filter(furnace => furnace?.position && furnace?.block)
    let batchCount = Math.min(selected.length, plannedCount)

    while (batchCount > 0) {
      const inputCounts = splitCount(plannedCount, batchCount)
      if (inputCounts.every(count => count <= maxBatch)) {
        const batches = inputCounts.map((inputCount, index) => ({
          furnaceBlock: selected[index].block,
          furnaceType: selected[index].type || selected[index].block?.name || 'furnace',
          furnacePosition: selected[index].position,
          inputItem: target.input,
          outputItem: target.output,
          inputCount,
          expectedOutputCount: inputCount,
          fuelItem: fuel.itemName,
          fuelCount: Math.max(1, Math.ceil(inputCount / units))
        }))
        const totalFuelCount = batches.reduce((sum, batch) => sum + batch.fuelCount, 0)
        if (totalFuelCount <= fuel.count) return batches
      }
      batchCount -= 1
    }

    return []
  }

  selectFuel(counts, requestedCount) {
    let bestPartial = null
    for (const itemName of FUEL_PRIORITY) {
      const available = counts[itemName] || 0
      const reserved = RESERVED_FUEL[itemName] || 0
      const usable = Math.max(0, available - reserved)
      const units = FUEL_SMELT_UNITS[itemName] || 1
      if (usable > 0) {
        const count = Math.min(usable, Math.max(1, Math.ceil(requestedCount / units)))
        const capacity = Math.floor(count * units)
        if (capacity <= 0) continue
        const candidate = { itemName, count, capacity }
        if (capacity >= requestedCount) return candidate
        if (!bestPartial || capacity > bestPartial.capacity) bestPartial = candidate
      }
    }
    if (bestPartial) return bestPartial
    for (const itemName of ['coal', 'charcoal']) {
      if ((counts[itemName] || 0) > 0) return { itemName, count: 1, capacity: 8, reservedFallback: true }
    }
    return null
  }

  step(context, step) {
    this.state.currentStep = step
    log(context, `[smelting] step=${step}`)
  }

  fail(reason, extra = {}) {
    const { ok, success, ...safeExtra } = extra
    this.state = {
      ...this.state,
      ...safeExtra,
      currentStep: 'failed',
      lastSmeltError: reason,
      finishReason: reason
    }
    return { ...safeExtra, ok: false, reason, error: reason, smeltingState: this.state }
  }

  getStatus(context = {}, lastState = null) {
    return lastState || this.state
  }
}

function inventoryCounts(context = {}) {
  const counts = {}
  for (const item of context.bot?.inventory?.items?.() || []) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return { ...counts, ...(context.blackboard?.get?.('inventory.counts') || {}) }
}

function findInventoryItem(bot, name) {
  return (bot?.inventory?.items?.() || []).find(item => item.name === name) || null
}

function firstAvailableLog(counts) {
  return Object.keys(SMELTING_RECIPES).find(name => name.endsWith('_log') && (counts[name] || 0) > 0) || 'oak_log'
}

function resolveSmeltQuantity(count, mode, available, defaultCount) {
  if (mode === 'all') {
    return { mode: 'all', strict: true, requestedCount: available }
  }
  const number = Number(count)
  if (Number.isFinite(number) && number > 0) {
    return { mode: 'specified', strict: true, requestedCount: Math.floor(number) }
  }
  return {
    mode: 'default',
    strict: false,
    requestedCount: Math.min(defaultCount, available)
  }
}

function findDirectFurnace(context, preferred, maxDistance = 48) {
  const bot = context.bot
  if (!bot?.registry?.blocksByName || typeof bot.findBlock !== 'function') return null
  for (const type of preferred) {
    const id = bot.registry.blocksByName[type]?.id
    if (id == null) continue
    const block = bot.findBlock({ matching: id, maxDistance })
    if (block?.position) return { ok: true, type, block, position: block.position, distance: distance(bot.entity?.position, block.position) }
  }
  return null
}

function uniqueFurnaces(furnaces) {
  const byPosition = new Map()
  for (const furnace of furnaces) {
    const position = furnace?.position
    if (!position) continue
    const key = `${Math.round(Number(position.x))},${Math.round(Number(position.y))},${Math.round(Number(position.z))}`
    if (!byPosition.has(key)) byPosition.set(key, furnace)
  }
  return [...byPosition.values()]
}

function splitCount(total, parts) {
  const count = Math.max(1, Math.floor(parts))
  const base = Math.floor(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

function classifySmeltError(err) {
  if (err?.code) return err.code
  const message = String(err?.message || err || '').toLowerCase()
  if (message.includes('path') || message.includes('unreachable')) return 'smelt_failed_furnace_unreachable'
  if (message.includes('timeout')) return 'smelt_failed_timeout'
  return 'smelt_failed_unknown'
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(context, message) {
  if (context?.logger?.log) context.logger.log(message)
  else if (context?.debug) context.debug(message)
}

module.exports = {
  FUEL_PRIORITY,
  RESERVED_FUEL,
  SMELTING_RECIPES,
  SmeltingSystem
}
