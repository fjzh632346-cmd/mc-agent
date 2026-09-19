const { BaseTask } = require('./base-task')
const { checkProtectedBuildingDig } = require('../systems/protected-buildings')
const { isNear, startMoveNear, stopMovement } = require('../actions/move')
const { Vec3 } = require('vec3')

class MineNearbyBlockTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'mine_nearby_block' })
    this.phase = 'find'
    this.targetPos = null
    this.digging = false
  }

  get requiredLocks() {
    return ['movement', 'digging']
  }

  findTarget(bot) {
    if (this.params.x != null && this.params.y != null && this.params.z != null) {
      return bot.blockAt(new Vec3(this.params.x, this.params.y, this.params.z))
    }

    const blockName = this.params.blockName || 'stone'
    const blockType = bot.registry.blocksByName[blockName]
    if (!blockType) return null
    return bot.findBlock({ matching: blockType.id, maxDistance: this.params.maxDistance || 16 })
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return

    if (this.phase === 'find') {
      const block = this.findTarget(ctx.bot)
      if (!block) {
        await this.fail(ctx, 'target_block_not_found')
        return
      }
      this.targetPos = block.position.clone()
      startMoveNear(ctx.bot, this.targetPos, 1)
      this.phase = 'move'
      ctx.debug?.(`[MineNearbyBlockTask#${this.id}] moving to ${block.name} at ${this.targetPos}`)
      return
    }

    if (this.phase === 'move') {
      if (!isNear(ctx.bot, this.targetPos, 1.5)) {
        startMoveNear(ctx.bot, this.targetPos, 1)
        return
      }
      stopMovement(ctx.bot)
      this.phase = 'dig'
    }

    if (this.phase === 'dig') {
      if (this.digging) return
      this.digging = true
      const block = ctx.bot.blockAt(this.targetPos)
      if (!block || block.name === 'air') {
        await this.fail(ctx, 'target_block_gone')
        return
      }
      if (!ctx.bot.canDigBlock(block)) {
        await this.fail(ctx, 'cannot_dig')
        return
      }

      const buildingGuard = checkProtectedBuildingDig(ctx, block.position, { source: 'mine_nearby_block_task' })
      if (!buildingGuard.allowed) {
        await this.fail(ctx, `protected_building_dig_blocked:${buildingGuard.region.runId}`)
        return
      }
      try {
        await ctx.bot.dig(block)
        await this.complete(ctx, { block: block.name, position: block.position })
      } catch (err) {
        await this.fail(ctx, err)
      }
    }
  }

  async pause(ctx, reason) {
    stopMovement(ctx.bot)
    await super.pause(ctx, reason)
  }

  async interrupt(ctx, reason) {
    stopMovement(ctx.bot)
    await super.interrupt(ctx, reason)
  }
}

module.exports = { MineNearbyBlockTask }
