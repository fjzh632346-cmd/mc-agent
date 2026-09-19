const { BaseTask, TASK_STATE } = require('./base-task')
const { MiningSystem } = require('../systems/mining-system')

class MiningTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'mining' })
    const defaultLimit = isOreMiningParams(options.params) ? 64 : 8
    const maxBlocks = options.params?.count || options.params?.maxBlocks || defaultLimit
    this.system = new MiningSystem({ maxBlocks })
    this.started = false
    this.miningState = {
      targetBlock: options.params?.targetBlock || options.params?.blockName || options.params?.ore || null,
      minedCount: 0,
      targetCount: maxBlocks,
      lastMinedBlock: null,
      remainingNearbyTargets: null,
      selectedTool: null,
      lastMiningError: null,
      errorSource: null,
      finishReason: null,
      treeState: null
    }
  }

  get requiredLocks() {
    return ['movement', 'digging', 'inventory']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return

    this.started = true
    const result = await this.system.run({ type: 'mine_blocks', params: this.params }, {
      ...ctx,
      task: this,
      currentTask: this
    })
    this.miningState = {
      targetBlock: this.params.targetBlock || this.params.blockName || this.params.ore || this.miningState.targetBlock,
      minedCount: result.data?.mined?.length || 0,
      targetCount: result.data?.targetCount || this.params.count || this.miningState.targetCount,
      lastMinedBlock: result.data?.mined?.[result.data.mined.length - 1]?.block || null,
      remainingNearbyTargets: result.data?.remainingNearbyTargets ?? null,
      selectedTool: ctx.bot?.heldItem?.name || null,
      lastMiningError: result.data?.lastMiningError || result.error || null,
      errorSource: result.data?.errorSource || (result.ok ? null : inferMiningErrorSource(result.error)),
      finishReason: result.data?.finishReason || (result.ok ? 'target_count_reached' : result.error || 'mining_failed'),
      treeState: result.data?.treeState || null
    }
    if (this.state === TASK_STATE.PAUSED) {
      this.started = false
      return
    }
    if (this.state === TASK_STATE.INTERRUPTED) return
    if (result.ok) await this.complete(ctx, { ...result.data, miningState: this.miningState })
    else await this.fail(ctx, result.error || 'mining_failed')
  }

  toJSON() {
    return {
      ...super.toJSON(),
      miningState: this.miningState
    }
  }
}

function inferMiningErrorSource(error) {
  if (String(error).includes('tool')) return 'equipment'
  if (String(error).includes('path')) return 'pathfinder'
  return 'mining'
}

function isOreMiningParams(params = {}) {
  if (params?.ore || params?.targetBlock === 'ore') return true
  const names = params?.blockNames
    ? (Array.isArray(params.blockNames) ? params.blockNames : [params.blockNames])
    : [params?.blockName, params?.targetBlock]
  return names.filter(Boolean).some(name => String(name).includes('_ore'))
}

module.exports = { MiningTask }
