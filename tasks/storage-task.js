const { BaseTask, TASK_STATE } = require('./base-task')
const { stopMoving } = require('../actions/move')
const { StorageSystem } = require('../systems/storage-system')

const STORAGE_MODES = Object.freeze({
  REMEMBER_CHEST: 'REMEMBER_CHEST',
  STORE_ITEMS: 'STORE_ITEMS',
  TAKE_ITEMS: 'TAKE_ITEMS',
  TRANSFER_ITEMS: 'TRANSFER_ITEMS',
  CHECK_STORAGE: 'CHECK_STORAGE',
  FETCH_AND_EQUIP_ARMOR: 'FETCH_AND_EQUIP_ARMOR',
  INVENTORY_FULL_STORE: 'INVENTORY_FULL_STORE'
})

class StorageTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'storage' })
    this.system = new StorageSystem(options.params?.storageOptions || {})
    this.started = false
    this.mode = options.params?.mode || STORAGE_MODES.STORE_ITEMS
    this.targetChest = null
    this.itemName = options.params?.itemName || null
    this.category = options.params?.category || options.params?.itemCategory || null
    this.equipAfter = options.params?.equipAfter === true
    this.query = options.params?.query || this.itemName
    this.count = options.params?.count || null
    this.storedItems = []
    this.withdrawnItems = []
    this.missingItems = []
    this.failedReason = null
    this.storageStatus = 'IDLE'
  }

  get requiredLocks() {
    return ['movement', 'inventory']
  }

  async start(ctx) {
    await super.start(ctx)
  }

  async update(ctx) {
    if (this.state !== TASK_STATE.RUNNING) return
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    if (this.started) return
    this.started = true

    const result = await this.runStorageAction(ctx)
    this.syncStorageState()
    if (result.ok) await this.complete(ctx, result)
    else await this.fail(ctx, result.error || 'storage_failed')
  }

  async runStorageAction(ctx) {
    const options = {
      owner: this.id,
      itemName: this.itemName,
      category: this.category,
      itemCategory: this.category,
      equipAfter: this.equipAfter || this.mode === STORAGE_MODES.FETCH_AND_EQUIP_ARMOR,
      query: this.query,
      count: this.count,
      mode: this.params.modeName || this.params.storeMode || this.params.mode,
      playerName: this.params.playerName || null,
      // 工地就近卸货用：把候选箱子锁死在这个半径内，
      // 免得记忆里那个几百格外的旧箱子又把她引走。
      radius: this.params.radius || null,
      maxDistance: this.params.maxDistance ?? null,
      scanCenters: this.params.scanCenters || null,
      // 这一栋还要用的材料留在身上，别倒进暂存箱又立刻取回来
      keepItems: this.params.keepItems || null,
      // 决策 #89-C：范围内一只箱子都没有时，允许就地放一只临时箱子中转。
      // 只有生存系统的荒地卸货会带这一条，其余调用方一律 false。
      placeTemporaryChest: this.params.placeTemporaryChest === true,
      containerPreference: this.params.containerPreference || 'any',
      sourceContainerPreference: this.params.sourceContainerPreference || 'any',
      targetContainerPreference: this.params.targetContainerPreference || 'any'
    }

    if (this.mode === STORAGE_MODES.REMEMBER_CHEST) return this.system.rememberChest(ctx, this.params.position || null, options)
    if (this.mode === STORAGE_MODES.TAKE_ITEMS) return this.system.takeItems(ctx, options)
    if (this.mode === STORAGE_MODES.FETCH_AND_EQUIP_ARMOR) return this.system.takeItems(ctx, { ...options, category: 'armor', itemCategory: 'armor', equipAfter: true })
    if (this.mode === STORAGE_MODES.TRANSFER_ITEMS) return this.system.transferItems(ctx, options)
    if (this.mode === STORAGE_MODES.CHECK_STORAGE) return this.system.checkStorage(ctx, options)
    if (this.mode === STORAGE_MODES.INVENTORY_FULL_STORE) return this.system.storeNonEssentialItems(ctx, options)
    return this.system.storeItems(ctx, options)
  }

  syncStorageState() {
    const status = this.system.getStatus()
    this.targetChest = status.targetChest || this.targetChest
    this.storedItems = status.storedItems || this.storedItems
    this.withdrawnItems = status.withdrawnItems || this.withdrawnItems
    this.missingItems = status.missingItems || this.missingItems
    this.failedReason = status.lastStorageError || this.failedReason
    this.storageStatus = status.storageStatus || this.storageStatus
  }

  async pause(ctx, reason) {
    stopMoving(ctx, { owner: this.id })
    await super.pause(ctx, reason)
  }

  async resume(ctx) {
    await super.resume(ctx)
  }

  async interrupt(ctx, reason) {
    stopMoving(ctx, { owner: this.id })
    await super.interrupt(ctx, reason)
  }

  async fail(ctx, error) {
    this.failedReason = error instanceof Error ? error.message : String(error)
    this.storageStatus = 'FAILED'
    await super.fail(ctx, error)
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mode: this.mode,
      targetChest: this.targetChest,
      itemName: this.itemName,
      category: this.category,
      equipAfter: this.equipAfter,
      count: this.count,
      storedItems: this.storedItems,
      withdrawnItems: this.withdrawnItems,
      missingItems: this.missingItems,
      failedReason: this.failedReason,
      storageStatus: this.storageStatus,
      lastStorageError: this.failedReason
    }
  }
}

module.exports = {
  STORAGE_MODES,
  StorageTask
}
