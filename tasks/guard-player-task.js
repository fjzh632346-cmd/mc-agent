const { BaseTask } = require('./base-task')
const { CombatSystem } = require('../systems/combat-system')
const { stopCombat } = require('../actions/fight')
const { stopMovement } = require('../actions/move')

class GuardPlayerTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'guard_player' })
    this.system = new CombatSystem()
    this.until = null
    this.lastAction = null
    this.idleTicks = 0
  }

  get requiredLocks() {
    return ['movement', 'combat']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return

    if (!this.until) this.until = Date.now() + (this.params.durationMs || 15000)

    const result = await this.system.run({
      type: 'protect_player',
      params: {
        holdLock: true,
        owner: this.id,
        protectPlayerRadius: this.params.radius || 8,
        minHealthToFight: this.params.minHealthToFight || 8
      }
    }, ctx)

    if (result.ok) {
      this.lastAction = result.data
      this.idleTicks = 0
    } else if (result.error === 'hostile_not_found') {
      this.idleTicks += 1
      ctx.logger?.log?.(`[combat] hostileDetected=false target=none action=guard result=idle idleTicks=${this.idleTicks}`)
      if ((this.lastAction && this.idleTicks >= 2) || this.idleTicks >= 4) {
        await this.finishGuard(ctx, 'no_hostile_remaining')
      }
    } else if (result.error === 'health_too_low') {
      await this.finishGuard(ctx, 'health_too_low')
    } else {
      await this.fail(ctx, result.error)
      return
    }

    if (Date.now() >= this.until) {
      await this.finishGuard(ctx, 'duration_elapsed')
    }
  }

  async finishGuard(ctx, reason) {
    stopCombat(ctx, { owner: this.id })
    stopMovement(ctx.bot, `guard_complete:${reason}`, this.id)
    await this.complete(ctx, { guarded: true, lastAction: this.lastAction, finishReason: reason })
  }

  async pause(ctx, reason) {
    stopCombat(ctx, { owner: this.id })
    stopMovement(ctx.bot, reason, this.id)
    await super.pause(ctx, reason)
  }

  async interrupt(ctx, reason) {
    stopCombat(ctx, { owner: this.id })
    stopMovement(ctx.bot, reason, this.id)
    await super.interrupt(ctx, reason)
  }
}

module.exports = { GuardPlayerTask }
