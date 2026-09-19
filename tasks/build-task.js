const { BaseTask, TASK_STATE } = require('./base-task')
const { stopMoving } = require('../actions/move')
const { BuildingSystem } = require('../systems/building-system')

class BuildTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'build_blueprint' })
    this.system = options.params?.buildingSystem || new BuildingSystem(options.params?.buildingOptions || options.params?.options || {})
    this.started = false
    this.startPromise = null
    this.blueprintName = options.params?.blueprintName || options.params?.target
    this.origin = options.params?.origin || null
    this.rawText = options.params?.rawText || options.params?.input || null
    this.complexityTier = options.params?.complexityTier || null
    this.designSpec = options.params?.designSpec || null
    this.confirmedComplexity = options.params?.confirmedComplexity === true
    this.forceRebuild = options.params?.forceRebuild === true || options.params?.rebuild === true
    this.rebuildReason = options.params?.rebuildReason || (this.forceRebuild ? 'explicit_rebuild_requested' : null)
    this.resumeOnly = options.params?.resumeOnly === true
    this.totalBlocks = 0
    this.placedBlocks = 0
    this.clearedBlocks = 0
    this.foundationBlocks = 0
    this.scaffoldBlocks = 0
    this.removedScaffoldBlocks = 0
    this.currentIndex = 0
    this.currentStepIndex = 0
    this.totalSteps = 0
    this.missingMaterials = []
    this.sitePlan = null
    this.materialPlan = null
    this.orderPlan = null
    this.constructionEstimate = null
    this.selectedBlueprint = null
    this.candidateSummary = null
    this.designPlan = null
    this.aestheticPlan = null
    this.layoutPlan = null
    this.interiorPlan = null
    this.interiorValidation = null
    this.walkabilityPrecheck = null
    this.habitabilityHardGate = null
    this.habitabilityFinalGate = null
    this.failedReason = null
    this.structureRecorded = false
    // Bumped by pause()/interrupt(). An awaited build chain captures the
    // epoch it started under; once the task is paused (connection lost) and
    // later resumed, that stale chain must neither keep running nor have its
    // eventual verdict applied, even though the task is RUNNING again.
    this.runEpoch = 0
  }

  chainGuard() {
    const epoch = this.runEpoch
    return {
      shouldContinue: () => this.state === TASK_STATE.RUNNING && this.runEpoch === epoch,
      isCurrent: () => this.state === TASK_STATE.RUNNING && this.runEpoch === epoch
    }
  }

  get requiredLocks() {
    return ['building']
  }

  async start(ctx) {
    await super.start(ctx)
    await this.beginBuild(ctx)
  }

  async update(ctx) {
    if (this.state !== TASK_STATE.RUNNING) return
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return

    if (!this.started) {
      const started = await this.beginBuild(ctx)
      if (!started) return
    }

    const guard = this.chainGuard()
    const result = await this.system.placeNextBlock(ctx, {
      owner: this.id,
      shouldContinue: guard.shouldContinue
    })
    this.syncBuildState()

    // interrupt()/pause() can run while an awaited movement/storage operation
    // is settling. Do not let that stale continuation turn the task into
    // FAILED or COMPLETED when it finally returns, including after the task
    // has already been resumed under a newer epoch.
    if (!guard.isCurrent()) return

    if (result.ok && result.completed) {
      this.recordBuiltStructure(ctx)
      await this.complete(ctx, this.buildResult())
    } else if (!result.ok) {
      this.failedReason = result.error || 'build_failed'
      await this.fail(ctx, this.failedReason)
    }
  }

  async pause(ctx, reason) {
    this.runEpoch += 1
    stopMoving(ctx, { owner: this.id })
    this.system.checkpointConstructionRun?.('task_pause')
    await super.pause(ctx, reason)
  }

  async resume(ctx) {
    await super.resume(ctx)
    // A checkpoint attempted while offline was held back; write the current
    // in-memory truth now that the task is live again.
    this.system.markConstructionCheckpointDirty?.()
    this.system.checkpointConstructionRun?.('task_resume')
  }

  async interrupt(ctx, reason) {
    this.runEpoch += 1
    stopMoving(ctx, { owner: this.id })
    this.system.checkpointConstructionRun?.('task_interrupt')
    await super.interrupt(ctx, reason)
  }

  async complete(ctx, result = {}) {
    this.system.checkpointConstructionRun?.('task_complete')
    await super.complete(ctx, result)
  }

  syncBuildState() {
    const status = this.system.getStatus()
    if (!status) return
    this.origin = status.origin
    this.blueprintName = status.blueprintName || this.blueprintName
    this.totalBlocks = status.totalBlocks
    this.placedBlocks = status.placedBlocks
    this.clearedBlocks = status.clearedBlocks || 0
    this.foundationBlocks = status.foundationBlocks || 0
    this.scaffoldBlocks = status.scaffoldBlocks || 0
    this.removedScaffoldBlocks = status.removedScaffoldBlocks || 0
    this.currentIndex = status.currentIndex
    this.currentStepIndex = status.currentStepIndex || 0
    this.totalSteps = status.totalSteps || 0
    this.missingMaterials = status.missingMaterials || []
    this.sitePlan = status.sitePlan || null
    this.materialPlan = status.materialPlan || null
    this.orderPlan = status.orderPlan || null
    this.constructionEstimate = status.constructionEstimate || null
    this.complexityTier = status.designSpec?.complexityTier || this.complexityTier
    this.designSpec = status.designSpec || this.designSpec
    this.selectedBlueprint = status.selectedBlueprint || null
    this.candidateSummary = status.candidateSummary || null
    this.designPlan = status.designPlan || null
    this.aestheticPlan = status.aestheticPlan || null
    this.layoutPlan = status.layoutPlan || null
    this.interiorPlan = status.interiorPlan || null
    this.interiorValidation = status.interiorValidation || null
    this.walkabilityPrecheck = status.walkabilityPrecheck || null
    this.habitabilityHardGate = status.habitabilityHardGate || null
    this.habitabilityFinalGate = status.habitabilityFinalGate || null
    this.failedReason = status.lastBuildError || this.failedReason
  }

  recordBuiltStructure(ctx) {
    if (this.structureRecorded) return
    try {
      ctx.memory?.world?.addBuiltStructure?.({
        type: 'built_structure',
        blueprintName: this.blueprintName,
        selectedBlueprint: this.selectedBlueprint,
        origin: this.origin,
        blockCount: this.totalBlocks,
        designPlan: this.designPlan,
        aestheticPlan: this.aestheticPlan,
        layoutPlan: this.layoutPlan,
        interiorPlan: this.interiorPlan
      })
      this.structureRecorded = true
    } catch {}
  }

  async beginBuild(ctx) {
    if (this.started || this.state !== TASK_STATE.RUNNING) return this.started
    if (this.startPromise) return this.startPromise
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return false

    this.startPromise = this.startBuildSession(ctx)
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async startBuildSession(ctx) {
    const guard = this.chainGuard()
    try {
      const started = await this.system.buildBlueprint(ctx, this.blueprintName, this.origin, {
        owner: this.id,
        explicitOrigin: Boolean(this.origin),
        rawText: this.rawText,
        complexityTier: this.complexityTier,
        designSpec: this.designSpec,
        confirmedComplexity: this.confirmedComplexity,
        ...(this.forceRebuild ? { forceRebuild: true, rebuild: true } : {}),
        ...(this.rebuildReason ? { rebuildReason: this.rebuildReason } : {}),
        ...(this.resumeOnly ? { resumeOnly: true, allowFreshBuild: false } : {}),
        shouldContinue: guard.shouldContinue
      })
      this.syncBuildState()
      // The start chain ran on a connection that has since dropped (the task
      // was paused meanwhile): its verdict is void. Leave `started` false so
      // the resumed task begins the build again through the run store.
      if (!guard.isCurrent()) {
        this.started = false
        return false
      }
      if (!started.ok) {
        this.started = false
        this.missingMaterials = started.missingMaterials || []
        this.failedReason = started.error || 'build_start_failed'
        await this.fail(ctx, this.failedReason)
        return false
      }
      this.started = true
      return true
    } catch (err) {
      this.started = false
      if (!guard.isCurrent()) return false
      this.failedReason = err?.message || 'build_start_failed'
      await this.fail(ctx, this.failedReason)
      return false
    }
  }

  async fail(ctx, error) {
    this.failedReason = error instanceof Error ? error.message : String(error)
    this.system.checkpointConstructionRun?.('task_fail')
    await super.fail(ctx, error)
  }

  buildResult() {
    return {
      blueprintName: this.blueprintName,
      origin: this.origin,
      forceRebuild: this.forceRebuild,
      rebuildReason: this.rebuildReason,
      resumeOnly: this.resumeOnly,
      totalBlocks: this.totalBlocks,
      placedBlocks: this.placedBlocks,
      clearedBlocks: this.clearedBlocks,
      foundationBlocks: this.foundationBlocks,
      scaffoldBlocks: this.scaffoldBlocks,
      removedScaffoldBlocks: this.removedScaffoldBlocks,
      currentIndex: this.currentIndex,
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.totalSteps,
      complexityTier: this.complexityTier,
      designSpec: this.designSpec,
      constructionEstimate: this.constructionEstimate,
      selectedBlueprint: this.selectedBlueprint,
      designPlan: this.designPlan,
      aestheticPlan: this.aestheticPlan,
      layoutPlan: this.layoutPlan,
      interiorPlan: this.interiorPlan,
      interiorValidation: this.interiorValidation,
      walkabilityPrecheck: this.walkabilityPrecheck,
      habitabilityHardGate: this.habitabilityHardGate,
      habitabilityFinalGate: this.habitabilityFinalGate
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      blueprintName: this.blueprintName,
      origin: this.origin,
      forceRebuild: this.forceRebuild,
      rebuildReason: this.rebuildReason,
      resumeOnly: this.resumeOnly,
      totalBlocks: this.totalBlocks,
      placedBlocks: this.placedBlocks,
      clearedBlocks: this.clearedBlocks,
      foundationBlocks: this.foundationBlocks,
      scaffoldBlocks: this.scaffoldBlocks,
      removedScaffoldBlocks: this.removedScaffoldBlocks,
      currentIndex: this.currentIndex,
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.totalSteps,
      missingMaterials: this.missingMaterials,
      sitePlan: this.sitePlan,
      materialPlan: this.materialPlan,
      orderPlan: this.orderPlan,
      complexityTier: this.complexityTier,
      designSpec: this.designSpec,
      constructionEstimate: this.constructionEstimate,
      selectedBlueprint: this.selectedBlueprint,
      candidateSummary: this.candidateSummary,
      designPlan: this.designPlan,
      aestheticPlan: this.aestheticPlan,
      layoutPlan: this.layoutPlan,
      interiorPlan: this.interiorPlan,
      interiorValidation: this.interiorValidation,
      walkabilityPrecheck: this.walkabilityPrecheck,
      habitabilityHardGate: this.habitabilityHardGate,
      habitabilityFinalGate: this.habitabilityFinalGate,
      failedReason: this.failedReason,
      buildStatus: this.system.getStatus()?.buildStatus || this.state,
      lastBuildError: this.failedReason
    }
  }
}

module.exports = { BuildTask }
