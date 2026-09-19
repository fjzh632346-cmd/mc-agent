const { BaseTask } = require('./base-task')
const { pickupNearestItem } = require('../actions/pickup')

class PickupItemTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'pickup_item' })
    this.started = false
    this.pickupState = null
  }

  get requiredLocks() {
    return ['movement']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    const result = await pickupNearestItem(ctx, {
      owner: this.id,
      radius: this.params.radius || 16,
      count: this.params.count || 1
    })
    this.pickupState = result
    if (result.ok) await this.complete(ctx, result.data)
    else await this.fail(ctx, result.error || 'pickup_failed')
  }

  toJSON() {
    return {
      ...super.toJSON(),
      pickupState: this.pickupState
    }
  }
}

module.exports = { PickupItemTask }
