const { BaseTask } = require('./base-task')
const { findNearbyMob, startAttack, stopAttack } = require('../actions/fight')

class FightNearbyMobTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'fight_nearby_mob' })
    this.targetId = null
    this.until = null
  }

  get requiredLocks() {
    return ['movement', 'combat']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return

    const target = this.targetId
      ? ctx.bot.entities[this.targetId]
      : findNearbyMob(ctx.bot, this.params.mobName, this.params.radius || 8)

    if (!target) {
      stopAttack(ctx.bot)
      await this.complete(ctx, { reason: 'no_target' })
      return
    }

    if (!this.targetId) {
      this.targetId = target.id
      this.until = Date.now() + (this.params.durationMs || 10000)
      startAttack(ctx.bot, target)
      ctx.debug?.(`[FightTask#${this.id}] attacking ${target.name}`)
    }

    if (Date.now() >= this.until || target.isValid === false) {
      stopAttack(ctx.bot)
      await this.complete(ctx, { target: target.name })
    }
  }

  async pause(ctx, reason) {
    stopAttack(ctx.bot)
    this.targetId = null
    await super.pause(ctx, reason)
  }

  async interrupt(ctx, reason) {
    stopAttack(ctx.bot)
    this.targetId = null
    await super.interrupt(ctx, reason)
  }
}

module.exports = { FightNearbyMobTask }
