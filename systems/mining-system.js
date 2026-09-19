const { ORE_BLOCKS, findNearbyBlocks, mineBlock, mineNearestBlock } = require('../actions/mine')
const { isInventoryFull } = require('../actions/inventory')
const { toBlockVec3 } = require('../utils/position')

class MiningSystem {
  constructor(botOrOptions = {}, maybeOptions = {}) {
    const options = botOrOptions?.entity || botOrOptions?.inventory ? maybeOptions : botOrOptions
    this.bot = botOrOptions?.entity || botOrOptions?.inventory ? botOrOptions : null
    this.options = {
      defaultBlocks: ['stone'],
      maxDistance: 16,
      maxBlocks: 64,
      stopDangerLevels: ['high', 'critical'],
      ...options
    }
  }

  canHandle(task) {
    return ['mine_ore', 'mine_nearby_block', 'mine_blocks'].includes(task?.type)
  }

  async run(task = {}, context = {}) {
    const stopBeforeStart = taskStopReason(context)
    if (stopBeforeStart) return interruptedResult([], stopBeforeStart)

    const danger = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
    if (this.options.stopDangerLevels.includes(danger)) {
      return { ok: false, error: 'danger_too_high', data: { dangerLevel: danger } }
    }

    const inventory = isInventoryFull(context)
    if (!inventory.ok) return inventory
    if (inventory.data.full || inventory.data.nearFull) {
      return { ok: false, error: 'inventory_full', data: inventory.data }
    }

    const blockNames = this.resolveBlockNames(task)
    const targetBlock = task.params?.targetBlock || task.params?.blockName || task.params?.ore || blockNames[0] || 'unknown'
    const requiredTool = task.params?.requiredTool || requiredToolForTarget(targetBlock, blockNames)
    const preferredTool = task.params?.preferredTool || preferredToolForTarget(targetBlock, blockNames)
    const allowHand = !requiredTool
    log(context, `[mining] inputTarget=${task.params?.inputTarget || task.params?.blockName || task.params?.ore || targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} minedCount=0 errorSource=none result=start`)
    if (isTreeRequest(task.params || {}, blockNames)) {
      return this.runTreeTask(task, context, blockNames, targetBlock, preferredTool, requiredTool)
    }
    const params = task.params || {}
    const count = Math.max(1, Math.min(params.count || this.options.maxBlocks, this.options.maxBlocks))
    const mineUntilExhausted = params.mineUntilExhausted === true
    const explicitRequestedCount = !mineUntilExhausted && params.count != null
    const mined = []
    let remainingNearbyTargets = null

    // A pickup miss (block dug but its drop not collected) is non-fatal: keep trying
    // other nearby targets up to a retry budget instead of aborting the whole task.
    const pickupRetryBudget = Math.max(0, params.pickupRetryBudget ?? 4)
    const maxAttempts = mineUntilExhausted ? count : count + pickupRetryBudget
    let attempts = 0
    let pickupMisses = 0
    let lastPickupError = null

    while (mined.length < count && attempts < maxAttempts) {
      attempts++
      const stopReason = taskStopReason(context)
      if (stopReason) {
        log(context, `[mining] inputTarget=${targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} minedCount=${mined.length} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} errorSource=mining result=${stopReason}`)
        return interruptedResult(mined, stopReason, { remainingNearbyTargets })
      }

      const currentDanger = context.blackboard?.get?.('mobs.dangerLevel')
      if (this.options.stopDangerLevels.includes(currentDanger)) {
        log(context, `[mining] inputTarget=${targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} minedCount=${mined.length} errorSource=mining result=danger_interrupted`)
        return { ok: mined.length > 0, error: 'danger_interrupted', data: { mined, dangerLevel: currentDanger, finishReason: 'danger_interrupted' } }
      }

      const result = await mineNearestBlock(context, blockNames, {
        maxDistance: params.maxDistance || this.options.maxDistance,
        timeoutMs: params.moveTimeoutMs || params.timeoutMs,
        scanCount: count,
        ignoreDanger: params.ignoreDanger === true,
        inputTarget: params.inputTarget || params.targetBlock || params.blockName || params.ore || null,
        targetBlock,
        preferredTool,
        requiredTool,
        minedCountBefore: mined.length,
        shouldContinue: () => !taskStopReason(context)
      })

      if (!result.ok) {
        const error = normalizeMiningError(result.error, params, blockNames)
        const errorSource = errorSourceFor(error)
        remainingNearbyTargets = countRemainingTargets(context, blockNames, params.maxDistance || this.options.maxDistance, count)
        // Non-fatal pickup miss: the block was dug but its drop was not collected.
        // Skip it and keep trying other nearby targets within the retry budget rather
        // than failing the whole task and falsely reporting total failure.
        if (isPickupMissError(error) && (remainingNearbyTargets ?? 0) > 0 && pickupMisses < pickupRetryBudget) {
          pickupMisses++
          lastPickupError = error
          log(context, `[mining] inputTarget=${params.inputTarget || targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} requestedCount=${count} minedCount=${mined.length} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} pickupMisses=${pickupMisses} errorSource=pickup result=pickup_miss_retry`)
          continue
        }
        const completion = miningFailureCompletion({
          error,
          minedCount: mined.length,
          requestedCount: count,
          remainingNearbyTargets,
          mineUntilExhausted,
          explicitRequestedCount
        })
        const finishReason = completion.finishReason
        log(context, `[mining] inputTarget=${params.inputTarget || targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} requestedCount=${count} minedCount=${mined.length} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} finishReason=${finishReason} errorSource=${errorSource} result=${finishReason}`)
        if (isTreeRequest(params, blockNames)) {
          log(context, `[tree] input=${task.params?.inputTarget || task.params?.blockName || targetBlock} targetLog=${targetBlock} selectedBlock=none result=fail failReason=${finishReason}`)
        }
        return {
          ok: completion.ok,
          error: completion.ok ? null : finishReason,
          data: {
            mined,
            originalError: result.error,
            finishReason,
            lastMiningError: error,
            errorSource,
            targetCount: count,
            requestedCount: count,
            minedCount: mined.length,
            remainingNearbyTargets
          }
        }
      }

      mined.push(result.data)
      pickupMisses = 0
      remainingNearbyTargets = countRemainingTargets(context, blockNames, params.maxDistance || this.options.maxDistance, count)
      log(context, `[mining] inputTarget=${params.inputTarget || targetBlock} resolvedTarget=${targetBlock} selectedBlock=${result.data?.block || 'unknown'} selectedBlock.name=${result.data?.block || 'unknown'} preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=${result.data?.selectedTool || context.bot?.heldItem?.name || 'unknown'} allowHand=${result.data?.allowHand === true} requestedCount=${count} minedCount=${mined.length} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} errorSource=none result=block_mined`)
    }

    if (!mineUntilExhausted && mined.length < count) {
      remainingNearbyTargets = countRemainingTargets(context, blockNames, params.maxDistance || this.options.maxDistance, count)
      const finishReason = lastPickupError ? `partial_${lastPickupError}` : 'partial_insufficient_targets'
      log(context, `[mining] inputTarget=${params.inputTarget || targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} requestedCount=${count} minedCount=${mined.length} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} finishReason=${finishReason} errorSource=pickup result=${finishReason}`)
      return {
        ok: false,
        error: finishReason,
        message: 'mining_partial',
        data: { mined, blockNames, finishReason, lastMiningError: lastPickupError, errorSource: 'pickup', targetCount: count, requestedCount: count, minedCount: mined.length, remainingNearbyTargets }
      }
    }

    if (mineUntilExhausted) {
      remainingNearbyTargets = countRemainingTargets(context, blockNames, params.maxDistance || this.options.maxDistance, count)
      const finishReason = remainingNearbyTargets === 0 ? 'complete_with_no_more_targets' : 'partial_reached_mining_limit'
      log(context, `[mining] inputTarget=${params.inputTarget || targetBlock} resolvedTarget=${targetBlock} selectedBlock=none selectedBlock.name=none preferredTool=${preferredTool || 'none'} requiredTool=${requiredTool || 'none'} selectedTool=unknown allowHand=${allowHand} requestedCount=${count} minedCount=${mined.length} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} finishReason=${finishReason} errorSource=${remainingNearbyTargets === 0 ? 'none' : 'mining'} result=${finishReason}`)
      return {
        ok: remainingNearbyTargets === 0 && mined.length > 0,
        error: remainingNearbyTargets === 0 ? null : finishReason,
        message: remainingNearbyTargets === 0 ? 'mining_done' : 'mining_partial',
        data: { mined, blockNames, finishReason, targetCount: count, requestedCount: count, minedCount: mined.length, remainingNearbyTargets }
      }
    }

    return {
      ok: mined.length > 0,
      message: mined.length > 0 ? 'mining_done' : 'no_blocks_mined',
      data: { mined, blockNames, finishReason: 'target_count_reached', targetCount: count, requestedCount: count, minedCount: mined.length, remainingNearbyTargets }
    }
  }

  findTargets(context, blockNames, maxDistance = this.options.maxDistance) {
    return findNearbyBlocks(context, blockNames, maxDistance, context.count || this.options.maxBlocks)
  }

  async mineTarget(context, block, options = {}) {
    return mineBlock(context, block, options)
  }

  async runTreeTask(task, context, blockNames, targetBlock, preferredTool, requiredTool) {
    const params = task.params || {}
    const maxDistance = params.maxDistance || this.options.maxDistance
    const mode = params.treeMode || (params.targetTreeCount ? 'tree_count' : 'log_count')
    const targetTreeCount = Math.max(1, Math.min(Number(params.targetTreeCount || params.count || 1), 16))
    const targetLogCount = Math.max(1, Math.min(Number(params.targetLogCount || params.count || this.options.maxBlocks), this.options.maxBlocks))
    const mined = []
    const treeState = {
      mode,
      targetTreeCount: mode === 'tree_count' ? targetTreeCount : null,
      completedTreeCount: 0,
      targetLogCount: mode === 'log_count' ? targetLogCount : null,
      choppedLogCount: 0,
      currentTreeRoot: null,
      currentTreeLogCount: 0,
      remainingLogsInCurrentTree: null,
      searchRadius: maxDistance,
      maxSearchRadius: params.maxSearchRadius || maxDistance,
      canExpandSearch: Boolean((params.maxSearchRadius || maxDistance) > maxDistance || params.canExpandSearch === true),
      selectedTool: null,
      lastTreeError: null,
      finishReason: null
    }

    const initialRemaining = countRemainingTargets(context, blockNames, maxDistance, this.options.maxBlocks)
    if (!initialRemaining) {
      treeState.finishReason = 'nearby_tree_not_found'
      treeState.lastTreeError = 'nearby_tree_not_found'
      log(context, `[tree] input=${params.inputTarget || params.blockName || targetBlock} mode=${mode} targetTreeCount=${targetTreeCount} completedTreeCount=0 targetLogCount=${targetLogCount} choppedLogCount=0 currentTreeRoot=none remainingNearbyTargets=0 finishReason=nearby_tree_not_found canExpandSearch=${treeState.canExpandSearch} result=fail failReason=nearby_tree_not_found`)
      return { ok: false, error: 'nearby_tree_not_found', data: { mined, finishReason: 'nearby_tree_not_found', lastMiningError: 'nearby_tree_not_found', errorSource: 'mining', remainingNearbyTargets: 0, treeState } }
    }

    while (true) {
      const stopReason = taskStopReason(context)
      if (stopReason) {
        treeState.finishReason = stopReason
        treeState.lastTreeError = stopReason
        return interruptedResult(mined, stopReason, { treeState, remainingNearbyTargets: countRemainingTargets(context, blockNames, maxDistance, this.options.maxBlocks) })
      }
      if (mode === 'tree_count' && treeState.completedTreeCount >= targetTreeCount) break
      if (mode === 'log_count' && treeState.choppedLogCount >= targetLogCount) break

      const root = nearestTreeRoot(context, blockNames, maxDistance, this.options.maxBlocks)
      if (!root) {
        treeState.finishReason = partialTreeTargetReached(mode, treeState, targetTreeCount, targetLogCount)
          ? 'target_count_reached'
          : (mined.length > 0 ? 'partial_completed_no_more_trees' : 'nearby_tree_not_found')
        treeState.lastTreeError = treeState.finishReason === 'nearby_tree_not_found' ? 'nearby_tree_not_found' : null
        const remainingNearbyTargets = countRemainingTargets(context, blockNames, maxDistance, this.options.maxBlocks)
        const missingTreeCount = mode === 'tree_count' ? Math.max(0, targetTreeCount - treeState.completedTreeCount) : null
        const missingLogCount = mode === 'log_count' ? Math.max(0, targetLogCount - treeState.choppedLogCount) : null
        log(context, `[tree] input=${params.inputTarget || params.blockName || targetBlock} mode=${mode} targetTreeCount=${targetTreeCount} completedTreeCount=${treeState.completedTreeCount} targetLogCount=${targetLogCount} choppedLogCount=${treeState.choppedLogCount} currentTreeRoot=none remainingNearbyTargets=${remainingNearbyTargets ?? 0} finishReason=${treeState.finishReason} canExpandSearch=${treeState.canExpandSearch} result=${treeState.finishReason}`)
        return {
          ok: treeState.finishReason === 'target_count_reached',
          error: treeState.finishReason === 'target_count_reached' ? null : treeState.finishReason,
          data: {
            mined,
            finishReason: treeState.finishReason,
            lastMiningError: treeState.lastTreeError || treeState.finishReason,
            errorSource: 'mining',
            remainingNearbyTargets,
            missingTreeCount,
            missingLogCount,
            treeState
          }
        }
      }

      const logs = collectConnectedTreeLogs(context, root, blockNames)
      treeState.currentTreeRoot = root.position || null
      treeState.currentTreeLogCount = logs.length
      log(context, `[tree] input=${params.inputTarget || params.blockName || targetBlock} mode=${mode} targetTrees=${targetTreeCount} targetLogs=${targetLogCount} currentTreeRoot=${formatPos(root.position)} currentTreeLogCount=${logs.length} choppedLogs=${treeState.choppedLogCount} completedTrees=${treeState.completedTreeCount} result=tree_selected`)
      let minedThisTree = 0

      for (const block of logs) {
        const stopReason = taskStopReason(context)
        if (stopReason) {
          treeState.finishReason = stopReason
          treeState.lastTreeError = stopReason
          return interruptedResult(mined, stopReason, { treeState, remainingNearbyTargets: countRemainingTargets(context, blockNames, maxDistance, this.options.maxBlocks) })
        }
        if (mode === 'log_count' && treeState.choppedLogCount >= targetLogCount) break

        const fresh = context.bot?.blockAt?.(block.position) || block
        if (!fresh || !isTreeBlockName(fresh.name)) continue
        const result = await mineBlock(context, fresh, {
          maxDistance,
          ignoreDanger: params.ignoreDanger === true,
          inputTarget: params.inputTarget || params.targetBlock || params.blockName || targetBlock,
          targetBlock,
          preferredTool,
          requiredTool,
          minedCountBefore: treeState.choppedLogCount,
          shouldContinue: () => !taskStopReason(context)
        })
        if (!result.ok) {
          const error = normalizeMiningError(result.error, params, blockNames)
          treeState.finishReason = error
          treeState.lastTreeError = error
          treeState.remainingLogsInCurrentTree = Math.max(0, logs.length - minedThisTree)
          return { ok: mined.length > 0, error: mined.length > 0 ? null : error, data: { mined, originalError: result.error, finishReason: error, lastMiningError: error, errorSource: errorSourceFor(error), remainingNearbyTargets: countRemainingTargets(context, blockNames, maxDistance, this.options.maxBlocks), treeState } }
        }
        mined.push(result.data)
        minedThisTree += 1
        treeState.choppedLogCount += 1
        treeState.selectedTool = result.data?.selectedTool || context.bot?.heldItem?.name || null
        treeState.remainingLogsInCurrentTree = Math.max(0, logs.length - minedThisTree)
        log(context, `[tree] targetLog=${result.data?.block || fresh.name} selectedTool=${treeState.selectedTool || 'unknown'} allowHand=${result.data?.allowHand === true} choppedLogs=${treeState.choppedLogCount} remainingLogsInCurrentTree=${treeState.remainingLogsInCurrentTree} result=log_mined`)
      }

      if (mode === 'tree_count' && minedThisTree > 0) treeState.completedTreeCount += 1
      if (minedThisTree === 0) break
    }

    treeState.finishReason = partialTreeTargetReached(mode, treeState, targetTreeCount, targetLogCount)
      ? 'target_count_reached'
      : (mined.length > 0 ? 'partial_completed_no_more_trees' : 'no_logs_mined')
    treeState.lastTreeError = treeState.finishReason === 'target_count_reached' ? null : treeState.finishReason
    const remainingNearbyTargets = countRemainingTargets(context, blockNames, maxDistance, this.options.maxBlocks)
    const missingTreeCount = mode === 'tree_count' ? Math.max(0, targetTreeCount - treeState.completedTreeCount) : null
    const missingLogCount = mode === 'log_count' ? Math.max(0, targetLogCount - treeState.choppedLogCount) : null
    log(context, `[tree] input=${params.inputTarget || params.blockName || targetBlock} mode=${mode} targetTreeCount=${targetTreeCount} completedTreeCount=${treeState.completedTreeCount} targetLogCount=${targetLogCount} choppedLogCount=${treeState.choppedLogCount} remainingNearbyTargets=${remainingNearbyTargets ?? 'unknown'} finishReason=${treeState.finishReason} canExpandSearch=${treeState.canExpandSearch} result=${treeState.finishReason}`)
    return {
      ok: treeState.finishReason === 'target_count_reached',
      error: treeState.finishReason === 'target_count_reached' ? null : treeState.finishReason,
      message: mined.length > 0 ? 'tree_chopped' : 'no_logs_mined',
      data: {
        mined,
        blockNames,
        finishReason: treeState.finishReason,
        lastMiningError: treeState.lastTreeError,
        errorSource: treeState.finishReason === 'target_count_reached' ? null : 'mining',
        targetCount: mode === 'tree_count' ? targetTreeCount : targetLogCount,
        remainingNearbyTargets,
        missingTreeCount,
        missingLogCount,
        treeState
      }
    }
  }

  resolveBlockNames(task = {}) {
    const params = task.params || {}
    if (params.blockNames) return Array.isArray(params.blockNames) ? params.blockNames : [params.blockNames]
    if (params.blockName) return [params.blockName]
    if (params.ore) return ORE_BLOCKS[params.ore] || ORE_BLOCKS.iron
    return this.options.defaultBlocks
  }
}

function partialTreeTargetReached(mode, treeState, targetTreeCount, targetLogCount) {
  if (mode === 'tree_count') return treeState.completedTreeCount >= targetTreeCount
  if (mode === 'log_count') return treeState.choppedLogCount >= targetLogCount
  return false
}

function normalizeMiningError(error, params = {}, blockNames = []) {
  if (String(error).startsWith('missing_required_tool')) return error
  if (error === 'wrong_tool_type') return 'wrong_tool_type'
  if (error === 'block_not_found' && isTreeRequest(params, blockNames)) return 'nearby_tree_not_found'
  if (error === 'block_not_found') return isOreRequest(params, blockNames) ? 'nearby_ore_not_found' : 'no_reachable_block'
  if (error === 'nearby_target_block_protected') return 'nearby_target_block_not_found'
  if (String(error).startsWith('protected_block')) return 'protected_block'
  if (error === 'unknown_block_names') return 'unknown_item_alias'
  if (String(error).includes('path')) return 'path_unreachable'
  if (String(error).includes('cannot_dig')) return 'wrong_tool_type'
  return error
}

function miningFailureCompletion({ error, minedCount, requestedCount, remainingNearbyTargets, mineUntilExhausted, explicitRequestedCount }) {
  if (mineUntilExhausted) {
    if (minedCount > 0 && isNoMoreTargetError(error) && remainingNearbyTargets === 0) {
      return { ok: true, finishReason: 'complete_with_no_more_targets' }
    }
    if (minedCount > 0 && isPathFailure(error)) {
      return { ok: false, finishReason: `partial_${error}` }
    }
    return { ok: false, finishReason: minedCount > 0 ? `partial_${error}` : error }
  }

  if (explicitRequestedCount && minedCount < requestedCount) {
    if (isNoMoreTargetError(error) && remainingNearbyTargets === 0) {
      return { ok: false, finishReason: 'partial_insufficient_targets' }
    }
    if (isPathFailure(error)) {
      return { ok: false, finishReason: `partial_${error}` }
    }
    return { ok: false, finishReason: minedCount > 0 ? `partial_${error}` : error }
  }

  if (minedCount > 0 && isNoMoreTargetError(error) && remainingNearbyTargets === 0) {
    return { ok: true, finishReason: 'complete_with_no_more_targets' }
  }
  return { ok: minedCount > 0, finishReason: error }
}

function isNoMoreTargetError(error) {
  return ['nearby_ore_not_found', 'no_reachable_block', 'nearby_target_block_not_found', 'block_gone'].includes(String(error))
}

function isPathFailure(error) {
  const key = String(error || '')
  return key.includes('path') || key.includes('move_timeout') || key.includes('unreachable')
}

function isOreRequest(params = {}, blockNames = []) {
  if (params.ore || params.targetBlock === 'ore') return true
  return blockNames.some(name => String(name).includes('_ore'))
}

function isTreeRequest(params = {}, blockNames = []) {
  const names = [
    params.blockName,
    params.targetBlock,
    ...(Array.isArray(blockNames) ? blockNames : [blockNames])
  ].filter(Boolean).map(name => String(name))
  return names.some(name => /(^|_)log$/.test(name) || name.includes('_log') || name.includes('_wood') || name.includes('_stem'))
}

function nearestTreeRoot(context, blockNames, maxDistance, count) {
  const found = findNearbyBlocks({ ...context, count }, blockNames, maxDistance, count)
  if (!found.ok) return null
  return found.data?.blocks?.find(block => isTreeBlockName(block?.name)) || null
}

function collectConnectedTreeLogs(context, root, blockNames = []) {
  const bot = context.bot
  if (!bot?.blockAt || !root?.position) return root ? [root] : []
  const allowed = new Set((Array.isArray(blockNames) ? blockNames : [blockNames]).filter(Boolean))
  const rootPos = normalizePos(root.position)
  const queue = [rootPos]
  const seen = new Set()
  const logs = []
  while (queue.length && logs.length < 96) {
    const pos = queue.shift()
    const key = posKey(pos)
    if (seen.has(key)) continue
    seen.add(key)
    if (Math.abs(pos.x - rootPos.x) > 5 || Math.abs(pos.z - rootPos.z) > 5 || pos.y < rootPos.y - 2 || pos.y > rootPos.y + 32) continue
    const block = bot.blockAt(toBlockVec3(pos))
    if (!block || !isTreeBlockName(block.name, allowed)) continue
    logs.push(block)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          queue.push({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz })
        }
      }
    }
  }
  return logs.sort((a, b) => a.position.y - b.position.y || positionDistance(context.bot?.entity?.position, a.position) - positionDistance(context.bot?.entity?.position, b.position))
}

function isTreeBlockName(name, allowed = null) {
  if (!name) return false
  if (allowed?.size && allowed.has(name)) return true
  return /(^|_)log$/.test(name) || name.includes('_log') || name.includes('_wood') || name.includes('_stem')
}

function normalizePos(position) {
  return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) }
}

function posKey(position) {
  return `${position.x},${position.y},${position.z}`
}

function positionDistance(a, b) {
  if (!a || !b) return 0
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

function requiredToolForTarget(targetBlock, blockNames = []) {
  const names = [targetBlock, ...blockNames].filter(Boolean)
  if (names.some(name => String(name).includes('obsidian'))) return 'diamond_pickaxe_or_better'
  if (names.some(name => String(name).includes('ancient_debris'))) return 'diamond_pickaxe_or_better'
  if (names.some(name => String(name).includes('diamond_ore'))) return 'iron_pickaxe_or_better'
  if (names.some(name => ['gold_ore', 'redstone_ore', 'emerald_ore'].some(ore => String(name).includes(ore)))) return 'iron_pickaxe_or_better'
  if (names.some(name => ['iron_ore', 'copper_ore', 'lapis_ore'].some(ore => String(name).includes(ore)))) return 'stone_pickaxe_or_better'
  if (names.some(name => String(name).includes('coal_ore'))) return 'wooden_pickaxe_or_better'
  if (names.some(name => ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'blackstone'].includes(String(name)))) return 'wooden_pickaxe_or_better'
  return null
}

function preferredToolForTarget(targetBlock, blockNames = []) {
  const names = [targetBlock, ...blockNames].filter(Boolean).map(name => String(name))
  if (names.some(name => name.includes('_log') || name.includes('_wood') || name.includes('_stem') || name.includes('_planks'))) return 'axe'
  if (names.some(name => ['dirt', 'coarse_dirt', 'podzol', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay'].includes(name))) return 'shovel'
  if (names.some(name => name.includes('leaves'))) return 'shears'
  if (names.some(name => name.includes('_ore') || ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'blackstone'].includes(name))) return 'pickaxe'
  return null
}

function errorSourceFor(error) {
  if (String(error).includes('tool')) return 'equipment'
  if (isPathFailure(error)) return 'pathfinder'
  return 'mining'
}

function isPickupMissError(error) {
  return String(error).includes('pickup')
}

function taskStopReason(context = {}) {
  const task = context.task || context.currentTask
  if (!task) return null
  if (task.state === 'INTERRUPTED') return 'task_interrupted'
  if (task.state === 'PAUSED') return 'task_paused'
  const managerTask = context.taskManager?.currentTask
  if (managerTask && task.id != null && managerTask.id !== task.id) return 'task_interrupted'
  if (context.taskManager && !managerTask && task.id != null && ['RUNNING', 'STARTING'].includes(task.state)) return 'task_interrupted'
  return null
}

function interruptedResult(mined, reason, extra = {}) {
  return {
    ok: mined.length > 0,
    error: mined.length > 0 ? null : reason,
    data: {
      mined,
      finishReason: reason,
      lastMiningError: reason,
      errorSource: 'mining',
      ...extra
    }
  }
}

function countRemainingTargets(context, blockNames, maxDistance, count) {
  const found = findNearbyBlocks({ ...context, count }, blockNames, maxDistance, count)
  if (!found.ok) return null
  return found.data?.blocks?.length ?? 0
}

function log(context, message) {
  if (context.logger?.log) context.logger.log(message)
  else if (context.debug) context.debug(message)
}

module.exports = { MiningSystem }
