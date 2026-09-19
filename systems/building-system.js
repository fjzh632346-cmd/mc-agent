const {
  clearBlockForBuilding,
  isReplaceablePlacementTarget,
  isTemporaryReferenceName,
  placeBlock,
  selectTemporaryReferenceMaterial
} = require('../actions/build')
const { BlueprintLoader } = require('./blueprint-loader')
const { BlueprintSelector } = require('./blueprint-selector')
const { BuildingHardGate } = require('./building-hard-gate')
const { BuildingDesigner } = require('./building-designer')
const { AestheticModel } = require('./aesthetic-model')
const { AestheticRefiner } = require('./aesthetic-refiner')
const { CommunityBuildCollector } = require('./community-build-collector')
const { InteriorPlanner } = require('./interior-planner')
const { InteriorUsabilityValidator } = require('./interior-usability-validator')
const { SpaceLayoutPlanner } = require('./space-layout-planner')
const { StructureEncoder } = require('./structure-encoder')
const { WalkabilityChecker } = require('./walkability-checker')
const { FaithfulCommunityValidator, isFaithfulCommunityImport } = require('./faithful-community-validator')
const { LegacyBlueprintAdapter } = require('./blueprint-compatibility-adapter')
const { BlueprintValidator } = require('./blueprint-validator')
const { ConstructionCompiler, materializeBlueprintBlocks } = require('./construction-compiler')
const { MineflayerConstructionExecutor } = require('./construction-executor')
const {
  adaptBuildIntentToDesignSpec,
  createConstructionEstimate,
  isLowComplexityTier,
  shouldPreserveNamedBlueprintScale
} = require('./building-complexity')
const {
  ConstructionRunStore,
  STEP_STATE,
  constructionRunCompatibility,
  createConstructionRun,
  isStepVerified,
  recordConstructionRunSession
} = require('./construction-run-store')
const {
  CONSTRUCTION_PHASE_ORDER,
  completeConstructionLifecycle,
  createBlueprintFreezeRecord,
  createConstructionLifecycle,
  createDesignSpec,
  freezeBlueprintIR,
  normalizeConstructionPhase,
  updateConstructionLifecycle
} = require('./building-design-spec')
const {
  mergeWorldDiffResults,
  WorldDiffValidator,
  worldDiffFromFaithfulComparison,
  worldDiffFromWalkability
} = require('./world-diff-result')
const { TERRAIN_MATERIALS, resolveMaterialSteps } = require('./material-resolution')
const { isBedHeadBlockState, itemRequirementsForBlock } = require('../utils/building-material-map')
const {
  legacyBlockNameMatches,
  legacyBlockStateMismatch,
  legacySkullPlacement
} = require('../utils/legacy-block-compat')
const { toBlockVec3 } = require('../utils/position')
const {
  LIVE_SIGNAL_STATE_KEYS,
  isRedstoneWireConnectionKey,
  isStairsShapeKey,
  isSignalLitBlockName
} = require('../utils/derived-placement-state-keys')
const {
  getLiveInventoryCounts,
  isAirName,
  isCoveredGrassDecayEquivalent,
  isGrassSmotheringCover,
  isStableNaturalTargetEquivalent,
  PROTECTED_SITE_BLOCKS
} = require('../utils/site-planner')

const BUILDING_PROCESS_SESSION_ID = `${process.pid}:${Date.now()}`

const REPLACEABLE_CLEAR_BLOCKS = new Set([
  ...TERRAIN_MATERIALS,
  'grass',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'snow',
  'snow_layer',
  'vine',
  'glow_lichen',
  'seagrass',
  'tall_seagrass',
  'dandelion',
  'poppy',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'red_tulip',
  'orange_tulip',
  'white_tulip',
  'pink_tulip',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'wither_rose',
  'sunflower',
  'lilac',
  'rose_bush',
  'peony'
])

class BuildingSystem {
  constructor(options = {}) {
    this.loader = options.loader || new BlueprintLoader(options)
    this.selector = options.selector || new BlueprintSelector({ ...options, loader: this.loader })
    this.designer = options.designer || new BuildingDesigner(options.design || options)
    this.structureEncoder = options.structureEncoder || new StructureEncoder(options.structureEncoding || options)
    this.communityCollector = options.communityCollector || new CommunityBuildCollector({
      ...options,
      loader: this.loader,
      designer: this.designer,
      encoder: this.structureEncoder
    })
    this.aestheticModel = options.aestheticModel || new AestheticModel({
      ...(options.aesthetic || options),
      encoder: this.structureEncoder
    })
    this.aestheticRefiner = options.aestheticRefiner || new AestheticRefiner({
      ...(options.aesthetic || options),
      designer: this.designer,
      model: this.aestheticModel
    })
    this.layoutPlanner = options.layoutPlanner || new SpaceLayoutPlanner(options.layout || options)
    this.interiorPlanner = options.interiorPlanner || new InteriorPlanner(options.interior || options)
    this.interiorValidator = options.interiorValidator || new InteriorUsabilityValidator(options.interiorValidation || options)
    this.walkabilityChecker = options.walkabilityChecker || new WalkabilityChecker(options.walkability || options)
    this.hardGate = options.hardGate || new BuildingHardGate(options.hardGate || options)
    this.faithfulValidator = options.faithfulValidator || new FaithfulCommunityValidator(options.faithfulValidation || options)
    this.blueprintAdapter = options.blueprintAdapter || new LegacyBlueprintAdapter()
    this.blueprintValidator = options.blueprintValidator || new BlueprintValidator()
    this.constructionCompiler = options.constructionCompiler || new ConstructionCompiler(options.compiler || options)
    this.constructionRunStore = options.constructionRunStore === false
      ? null
      : (options.constructionRunStore || new ConstructionRunStore(options.constructionRuns || {}))
    this.worldDiffValidator = options.worldDiffValidator || new WorldDiffValidator(options.worldDiff || options)
    this.executor = options.executor || new MineflayerConstructionExecutor({
      executeStep: (context, step, stepOptions) => this.executeStep(context, step, stepOptions),
      getProgress: () => this.getStatus(),
      setStatus: (status, reason) => {
        if (!this.session) return
        this.session.status = status
        if (reason) this.session.lastBuildError = reason
      }
    })
    this.options = {
      maxBlocksPerUpdate: 3,
      maxDistanceFromBot: 32,
      materialStorageSearchRadius: 80,
      inventoryBatchStepLimit: 100,
      reservedEmptyInventorySlots: 2,
      constructionCheckpointStepInterval: 10,
      constructionCheckpointMaxIntervalMs: 30000,
      ...options
    }
    this.constructionCheckpointState = createConstructionCheckpointState()
    this.session = null
  }

  async buildBlueprint(context, blueprintName, origin = null, options = {}) {
    const preview = this.previewBlueprint(context, blueprintName, origin, options)
    if (!preview.ok) return preview
    let finalPreview = preview
    const buildOrigin = preview.origin

    logSelection(context, blueprintName, preview)
    logDesign(context, preview)
    logAesthetic(context, preview)
    logBuilding(context, `[BUILD_PIPELINE] blueprint=${preview.blueprintName} stages=${JSON.stringify([
      'load_blueprint_or_concept',
      'generate_initial_structure',
      'structure_encoding',
      'community_similarity_check',
      'aesthetic_scoring',
      'aesthetic_refine_loop',
      'habitability_hard_gate_pre',
      'site_scan',
      'clear_obstructions',
      'foundation_fill',
      'material_planning',
      'construction',
      'interior_planning',
      'final_aesthetic_rescore',
      'habitability_hard_gate_post',
      'walkability_final_check',
      'remove_scaffolding',
      'accept_or_reject_build'
    ])}`)
    logBuilding(context, `[BUILD_LAYOUT_PLAN] blueprint=${preview.blueprintName} ok=${preview.layoutPlan?.complete === true} rooms=${preview.layoutPlan?.rooms?.length || 0} entrances=${preview.layoutPlan?.entrances?.length || 0} mainPathWidth=${preview.layoutPlan?.minMainPathWidth || 0} stairs=${preview.layoutPlan?.stairs?.length || 0}`)
    logBuilding(context, `[BUILD_INTERIOR_PLAN] blueprint=${preview.blueprintName} enabled=${preview.interiorPlan?.enabled === true} complete=${preview.interiorPlan?.complete === true} rooms=${preview.interiorPlan?.rooms?.length || 0} placements=${preview.interiorPlan?.placements?.length || 0} skipped=${JSON.stringify(preview.interiorPlan?.skipped || [])}`)
    logBuilding(context, `[BUILD_INTERIOR_USABILITY] blueprint=${preview.blueprintName} ok=${preview.interiorValidation?.ok === true} failures=${JSON.stringify(preview.interiorValidation?.failures || [])}`)
    logBuilding(context, `[BUILD_WALKABILITY_GATE] stage=pre blueprint=${preview.blueprintName} ok=${preview.walkabilityPrecheck?.ok === true} summary=${JSON.stringify(preview.walkabilityPrecheck?.summary || null)} failures=${JSON.stringify(preview.walkabilityPrecheck?.failures || [])}`)
    logBuilding(context, `[BUILD_HABITABILITY_GATE] stage=pre blueprint=${preview.blueprintName} ok=${preview.habitabilityHardGate?.ok === true} metrics=${JSON.stringify(preview.habitabilityHardGate?.metrics || null)} failures=${JSON.stringify(preview.habitabilityHardGate?.failures || [])}`)
    logBuilding(context, `[BUILD_DESIGN_SPEC] id=${preview.designSpec?.designSpecId || 'none'} revision=${preview.designSpec?.revision || 'none'} frozen=${preview.designSpec?.frozen === true} type=${preview.designSpec?.buildingType || 'unknown'} size=${preview.designSpec?.width || 0}x${preview.designSpec?.depth || 0}x${preview.designSpec?.height || 0} floors=${preview.designSpec?.floors || 0}`)
    logBuilding(context, `[BUILD_CONSTRUCTION_ESTIMATE] tier=${preview.constructionEstimate?.complexityTier || preview.designSpec?.complexityTier || 'unknown'} blocks=${preview.constructionEstimate?.blockCount ?? preview.totalBlocks ?? 0} steps=${preview.constructionEstimate?.expectedSteps ?? preview.orderPlan?.summary?.totalSteps ?? 0} minutes=${preview.constructionEstimate ? `${preview.constructionEstimate.estimatedMinutesLow}-${preview.constructionEstimate.estimatedMinutesHigh}` : 'unknown'} warnings=${JSON.stringify(preview.constructionEstimate?.warnings || [])}`)
    logBuilding(context, `[BUILD_BLUEPRINT_FREEZE] blueprint=${preview.blueprintFreeze?.blueprintId || preview.blueprintName} revision=${preview.blueprintFreeze?.blueprintRevision || 'none'} hash=${preview.blueprintFreeze?.blueprintHash || 'none'} designRevision=${preview.blueprintFreeze?.designSpecRevision || 'none'}`)

    const initialRunDecision = this.decideConstructionRunStart(context, preview, options)
    const initialBoundedStartGuard = guardBoundedConstructionStart(initialRunDecision, options)
    if (!initialBoundedStartGuard.ok) {
      logConstructionRunDecision(context, initialRunDecision)
      return boundedConstructionStartBlockedResult(preview, initialBoundedStartGuard)
    }
    if (initialRunDecision.blocked) {
      logConstructionRunDecision(context, initialRunDecision)
      return existingStructureBlockedResult(preview, initialRunDecision)
    }

    if (preview.blockedReasons.length) {
      return {
        ...preview,
        ok: false,
        error: preview.blockedReasons[0] || 'site_blocked'
      }
    }

    const stagedStorageRefill = shouldUseStagedStorageRefill(context, preview, options)
    if (preview.missingMaterials.length && options.allowStorageRefill !== false && !stagedStorageRefill) {
      logBuilding(context, `[BUILD_MATERIAL_MISSING] blueprint=${blueprintName} missing=${JSON.stringify(preview.missingMaterials)}`)
      const refill = await this.refillMaterialsFromStorage(context, preview.missingMaterials, {
        ...options,
        materialStorageScanCenters: materialStorageScanCentersForPreview(preview)
      })
      if (!refill.ok) {
        logBuilding(context, `[BUILD_STORAGE_REFILL_FAILED] blueprint=${blueprintName} failed=${JSON.stringify(refill.failed || [])}`)
      }
      finalPreview = this.previewBlueprint(context, blueprintName, buildOrigin, {
        ...options,
        explicitOrigin: true
      })
      if (!finalPreview.ok) return finalPreview
    } else if (preview.missingMaterials.length && stagedStorageRefill) {
      logBuilding(context, `[BUILD_MATERIAL_STAGED_REFILL] blueprint=${blueprintName} missing=${JSON.stringify(preview.missingMaterials)} mode=on_demand`)
    }

    const canProceedWithStagedRefill = shouldUseStagedStorageRefill(context, finalPreview, options) &&
      finalPreview.missingMaterials.length > 0 &&
      (finalPreview.blockedReasons || []).length === 0
    if (!finalPreview.canBuild && !canProceedWithStagedRefill) {
      return {
        ...finalPreview,
        ok: false,
        error: finalPreview.missingMaterials.length ? 'missing_materials' : (finalPreview.reason || 'cannot_build')
      }
    }

    finalPreview = applyRuntimeSafeBlockSubstitutions(finalPreview, context)
    finalPreview = applyPhysicalSupportDependencies(finalPreview)
    const runDecision = this.decideConstructionRunStart(context, finalPreview, options)
    logConstructionRunDecision(context, runDecision)
    const boundedStartGuard = guardBoundedConstructionStart(runDecision, options)
    if (!boundedStartGuard.ok) {
      return boundedConstructionStartBlockedResult(finalPreview, boundedStartGuard)
    }
    if (runDecision.blocked) {
      return existingStructureBlockedResult(finalPreview, runDecision)
    }
    if (runDecision.resumeOrFresh === 'renovation' && runDecision.renovation?.oldRun) {
      finalPreview = applyRenovationClearSteps(finalPreview, runDecision.renovation.oldRun, context)
      logBuilding(context, `[BUILD_RENOVATION_PLAN] renovationOf=${runDecision.renovation.oldRun.runId} demolitionSteps=${finalPreview.orderPlan?.summary?.renovationClear || 0} totalSteps=${finalPreview.orderPlan?.summary?.totalSteps || 0}`)
    }
    const constructionRun = await this.prepareConstructionRun(context, finalPreview, options)
    if (!constructionRun.ok) {
      return {
        ...finalPreview,
        ok: false,
        error: constructionRun.error || 'construction_run_prepare_failed',
        constructionRun
      }
    }
    finalPreview = constructionRun.preview || finalPreview

    const sessionStartedAt = new Date().toISOString()
    const phaseGateSessionId = `${constructionRun.run?.runId || 'construction_run_unavailable'}:${sessionStartedAt}`
    const phaseGates = {
      ...(constructionRun.run?.phaseGates || {})
    }
    const startupPhaseGate = startupPhaseGateFromStorageReconciliation(constructionRun.storage, phaseGateSessionId)
    if (startupPhaseGate) {
      phaseGates[startupPhaseGate.phase] = startupPhaseGate
    }
    this.session = {
      blueprintName: finalPreview.blueprintName,
      blueprint: finalPreview.blueprint,
      resolvedBlueprint: finalPreview.resolvedBlueprint || finalPreview.blueprint,
      blueprintIR: finalPreview.blueprintIR,
      blueprintValidation: finalPreview.blueprintValidation,
      designSpec: finalPreview.designSpec,
      blueprintFreeze: finalPreview.blueprintFreeze,
      selectedBlueprint: finalPreview.selectedBlueprint,
      candidateSummary: finalPreview.candidateSummary,
      designPlan: finalPreview.designPlan,
      designDiagnostics: finalPreview.designDiagnostics,
      aestheticPlan: finalPreview.aestheticPlan,
      layoutPlan: finalPreview.layoutPlan,
      interiorPlan: finalPreview.interiorPlan,
      interiorValidation: finalPreview.interiorValidation,
      walkabilityPrecheck: finalPreview.walkabilityPrecheck,
      habitabilityHardGate: finalPreview.habitabilityHardGate,
      faithfulValidation: finalPreview.faithfulValidation || null,
      habitabilityRequired: finalPreview.habitabilityRequired === true,
      origin: finalPreview.origin,
      worldBlocks: finalPreview.worldBlocks,
      requiredMaterials: finalPreview.requiredMaterials,
      materialPlan: finalPreview.materialPlan,
      materialResolution: finalPreview.materialResolution || null,
      constructionPlan: finalPreview.constructionPlan,
      constructionEstimate: finalPreview.constructionEstimate,
      sitePlan: finalPreview.sitePlan,
      orderPlan: finalPreview.orderPlan,
      reservedPositions: createReservedPositionSet(finalPreview.worldBlocks),
      reservedBounds: createReservedBounds(finalPreview.worldBlocks),
      steps: finalPreview.orderPlan.steps,
      constructionRun: constructionRun.run,
      constructionRunId: constructionRun.run?.runId || null,
      resumedConstructionRun: constructionRun.resumed === true,
      phaseGateSessionId,
      phaseGates,
      missingMaterials: canProceedWithStagedRefill ? finalPreview.missingMaterials : [],
      totalBlocks: finalPreview.totalBlocks,
      placedBlocks: constructionRun.progress?.placedBlocks || 0,
      clearedBlocks: constructionRun.progress?.clearedBlocks || 0,
      foundationBlocks: constructionRun.progress?.foundationBlocks || 0,
      scaffoldBlocks: constructionRun.progress?.scaffoldBlocks || 0,
      removedScaffoldBlocks: constructionRun.progress?.removedScaffoldBlocks || 0,
      currentIndex: constructionRun.progress?.currentIndex || 0,
      currentStepIndex: constructionRun.progress?.currentStepIndex || 0,
      status: 'RUNNING',
      lastBuildError: null,
      startedAt: sessionStartedAt
    }
    this.constructionCheckpointState = createConstructionCheckpointState()

    logBuilding(context, `[BUILD_CONSTRUCTION_RUN] mode=${constructionRun.resumed ? 'resume' : 'new'} runId=${this.session.constructionRunId || 'none'} verified=${constructionRun.reconciliation?.verified || 0} pending=${constructionRun.reconciliation?.pending || 0} repair=${constructionRun.reconciliation?.repair || 0} stateRepair=${constructionRun.reconciliation?.stateRepair || 0}`)
    logBuilding(context, `[BUILD_SITE_SCAN] blueprint=${finalPreview.blueprintName} origin=${formatPos(this.session.origin)} summary=${JSON.stringify(finalPreview.sitePlan.summary)} blocked=${JSON.stringify(finalPreview.blockedReasons)}`)
    logBuilding(context, `[BUILD_MATERIAL_PLAN] blueprint=${finalPreview.blueprintName} required=${JSON.stringify(finalPreview.materialPlan.requiredMaterials)} missing=${JSON.stringify(finalPreview.materialPlan.missingMaterials)}`)
    logBuilding(context, `[BUILD_ORDER_PLAN] blueprint=${finalPreview.blueprintName} summary=${JSON.stringify(finalPreview.orderPlan.summary)}`)
    const deferredAxisSteps = (finalPreview.orderPlan.steps || []).filter(step => step.deferredReason === 'axis_reference_unresolved')
    if (deferredAxisSteps.length) {
      // Planner fallback fired: these axis blocks have no same-axis reference
      // anywhere in the plan and were pushed to the tail (they will lean on the
      // temporary reference column at runtime instead of failing mid-layer).
      logBuilding(context, `[BUILD_ORDER_AXIS_DEFERRED] blueprint=${finalPreview.blueprintName} count=${deferredAxisSteps.length} roots=${deferredAxisSteps.filter(step => step.axisReferenceRoot).length} first=${deferredAxisSteps.slice(0, 6).map(step => `${formatPos(step.position)}:${step.blockName}`).join(',')}`)
    }
    const deferredClickableSteps = (finalPreview.orderPlan.steps || []).filter(step => step.deferredReason === 'clickable_reference_unresolved')
    if (deferredClickableSteps.length) {
      // Planner fallback fired: the blueprint gives these blocks no reference a
      // right-click can place against (hopper / repeater / redstone wire ...),
      // so they were pushed to the tail instead of failing place_failed:unstable_air
      // mid-build. They still need the runtime temporary reference to land.
      logBuilding(context, `[BUILD_ORDER_CLICKABLE_DEFERRED] blueprint=${finalPreview.blueprintName} count=${deferredClickableSteps.length} roots=${deferredClickableSteps.filter(step => step.clickableReferenceRoot).length} first=${deferredClickableSteps.slice(0, 6).map(step => `${formatPos(step.position)}:${step.blockName}`).join(',')}`)
    }
    return { ok: true, status: 'RUNNING', build: this.getStatus(), constructionRunDecision: runDecision }
  }

  decideConstructionRunStart(context, preview, options = {}) {
    return decideConstructionRunStart(context, preview, options, this.constructionRunStore, this.options)
  }

  rescueExistingBuild(context, blueprintName, origin = null, options = {}) {
    const preview = this.previewBlueprint(context, blueprintName, origin, {
      ...options,
      explicitOrigin: options.explicitOrigin ?? Boolean(origin),
      allowStorageRefill: false
    })
    if (!preview.ok) return preview
    const decision = this.decideConstructionRunStart(context, preview, {
      ...options,
      rescueExistingBuild: true
    })
    const report = {
      ok: true,
      mode: 'RESCUE_EXISTING_BUILD',
      blueprintName: preview.blueprintName,
      origin: preview.origin,
      constructionRunDecision: decision,
      ...decision.rescue
    }
    if (options.persistRun === true && report.canResume && this.constructionRunStore) {
      const criteria = constructionRunCriteria(context, preview)
      const existing = this.constructionRunStore.findActiveCompatible(criteria)
      const runArtifacts = constructionRunArtifactsFromPreview(preview, criteria)
      const run = existing || createConstructionRun({
        blueprintId: criteria.blueprintId,
        blueprintRevision: criteria.blueprintRevision,
        blueprintHash: criteria.blueprintHash,
        planId: criteria.planId,
        placementContext: criteria.placementContext,
        world: criteria.world,
        bounds: criteria.bounds,
        stagingChests: criteria.stagingChests,
        designSpec: runArtifacts.designSpec,
        blueprintFreeze: runArtifacts.blueprintFreeze,
        frozenBlueprintIR: runArtifacts.frozenBlueprintIR,
        materialStats: runArtifacts.materialStats,
        lifecycle: runArtifacts.lifecycle,
        steps: preview.orderPlan?.steps || []
      })
      const executionPreview = applyConstructionExecutionStepsForRun(preview, run)
      const reconciliation = reconcileConstructionRun(context, run, executionPreview.orderPlan?.steps || [])
      const saved = this.constructionRunStore.upsertRun({
        ...run,
        ...reconciliation.runPatch,
        status: 'ACTIVE',
        terminalState: null,
        blockedReason: null
      })
      report.runId = saved.runId
      report.persisted = true
    }
    return report
  }

  previewBlueprint(context, blueprintName, origin = null, options = {}) {
    const intentDesignSpec = designSpecFromBuildOptions(blueprintName, options)
    const selected = this.selector.selectBlueprint({
      blueprintName,
      style: options.style,
      type: options.type,
      complexity: options.complexity,
      complexityTier: intentDesignSpec?.complexityTier || options.complexityTier,
      rawText: options.rawText || options.input || null,
      designSpec: intentDesignSpec,
      resumeOnly: options.resumeOnly === true,
      forceRebuild: options.forceRebuild === true || options.rebuild === true,
      rebuild: options.rebuild === true
    }, context)
    if (!selected.ok) return selected
    const placementOrigin = this.resumeOriginForSelectedBlueprint(context, selected, origin, options)

    const aestheticRequest = {
      blueprintName,
      style: options.style,
      type: options.type,
      complexity: options.complexity,
      complexityTier: intentDesignSpec?.complexityTier || options.complexityTier,
      designSpec: intentDesignSpec,
      rawText: options.rawText || options.input || null,
      selected: selected.selected,
      builtStructureCount: context.memory?.world?.summary?.().builtStructures || 0,
      forceDesignVariation: options.forceDesignVariation,
      aesthetic: options.aesthetic
    }

    if (intentDesignSpec?.complexityConfirmationRequired && options.confirmedComplexity !== true) {
      return {
        ok: false,
        error: 'complexity_confirmation_required',
        designSpec: intentDesignSpec,
        selectedBlueprint: selected.selected,
        constructionEstimate: createConstructionEstimate({
          blueprint: selected.blueprint,
          designSpec: intentDesignSpec
        }),
        message: 'showcase_build_requires_explicit_confirmation'
      }
    }

    if (isFaithfulCommunityImport(selected.blueprint, selected.selected)) {
      return this.previewFaithfulCommunityBlueprint(context, blueprintName, placementOrigin, options, selected, aestheticRequest)
    }

    if (shouldPreserveBudgetedBlueprint(intentDesignSpec, selected.selected, selected.blueprint)) {
      return this.previewBudgetedSimpleBlueprint(context, blueprintName, placementOrigin, options, selected, aestheticRequest)
    }

    const community = this.communityCollector.loadSamples(aestheticRequest, context)
    if (!community.ok) return community

    const generationSeed = selectCommunityGenerationSeed(community, aestheticRequest)
    const generationBlueprint = generationSeed
      ? blueprintFromCommunityGenerationSeed(generationSeed, blueprintName)
      : selected.blueprint
    const initialEncoding = this.structureEncoder.encode(generationBlueprint)
    if (!initialEncoding.ok) return initialEncoding

    const requireAestheticGate = isArchitecturalAestheticTarget(blueprintName, selected.selected, selected.blueprint, options)
    const refinement = requireAestheticGate
      ? this.aestheticRefiner.refineBlueprint(
          generationBlueprint,
          aestheticRequest,
          community.samples,
          {
            ...context,
            communityGenerationSeed: generationSeed
          }
        )
      : this.scoreNonArchitecturalFixture(selected.blueprint, aestheticRequest, community.samples)
    if (!refinement.ok) return refinement

    const designResult = {
      ok: true,
      blueprint: refinement.blueprint,
      design: refinement.design || refinement.blueprint.metadata?.design || null,
      diagnostics: refinement.diagnostics || {}
    }
    if (!designResult.design) return { ok: false, error: 'aesthetic_refiner_missing_design' }

    const refinedEncoding = refinement.evaluation?.encoding || this.structureEncoder.encode(designResult.blueprint)
    if (!refinedEncoding.ok) return refinedEncoding

    const layout = this.layoutPlanner.plan(designResult.blueprint, {
      blueprintName,
      selected: selected.selected,
      design: designResult.design
    })
    if (!layout.ok) return layout

    const interior = this.interiorPlanner.plan(layout.blueprint, {
      blueprintName,
      selected: selected.selected,
      design: designResult.design,
      layout: layout.plan
    })
    if (!interior.ok) return interior
    const activeBlueprint = interior.blueprint

    const finalAesthetic = this.aestheticModel.score(activeBlueprint, community.samples, options.aesthetic || {})
    if (!finalAesthetic.ok) return finalAesthetic
    const finalAccepted = finalAesthetic.accepted || !requireAestheticGate
    const acceptedFinalAesthetic = finalAccepted && !finalAesthetic.accepted
      ? {
          ...finalAesthetic,
          accepted: true,
          exemptReason: 'non_architectural_fixture'
        }
      : finalAesthetic
    if (!finalAccepted) {
      return {
        ok: false,
        error: aestheticFailureReason(finalAesthetic),
        aestheticPlan: summarizeAestheticPlan({
          community,
          initialEncoding,
          refinedEncoding,
          refinement,
          finalAesthetic: acceptedFinalAesthetic,
          generationSeed
        })
      }
    }

    const interiorValidation = this.interiorValidator.validate(activeBlueprint, {
      layoutPlan: layout.plan,
      interiorPlan: interior.plan
    })
    if (!interiorValidation.ok) {
      return {
        ok: false,
        error: `interior_usability_failed:${interiorValidation.failures[0] || 'unknown'}`,
        interiorValidation
      }
    }

    const walkabilityPrecheck = this.walkabilityChecker.checkBlueprint(activeBlueprint, {
      layoutPlan: layout.plan,
      interiorPlan: interior.plan
    })
    if (!walkabilityPrecheck.ok) {
      return {
        ok: false,
        error: `walkability_precheck_failed:${walkabilityPrecheck.failures[0] || 'unknown'}`,
        walkabilityPrecheck
      }
    }

    const habitabilityHardGate = this.hardGate.evaluateBlueprint(activeBlueprint, aestheticRequest)
    if (requireAestheticGate && !habitabilityHardGate.ok) {
      return {
        ok: false,
        error: `habitability_hard_gate_failed:${habitabilityHardGate.failures[0] || 'unknown'}`,
        hardGate: habitabilityHardGate,
        aestheticPlan: summarizeAestheticPlan({
          community,
          initialEncoding,
          refinedEncoding,
          refinement,
          finalAesthetic: acceptedFinalAesthetic,
          generationSeed
        })
      }
    }
    const contrast = this.buildAestheticContrast({
      request: aestheticRequest,
      community,
      initialBlueprint: selected.blueprint,
      finalBlueprint: activeBlueprint,
      initialEvaluation: refinement.initial?.evaluation || refinement.initial || null,
      finalEvaluation: acceptedFinalAesthetic,
      finalHardGate: habitabilityHardGate
    })

    const materialResult = this.loader.getRequiredMaterials(activeBlueprint)
    if (!materialResult.ok) return materialResult

    const buildOrigin = normalizeOrigin(placementOrigin || currentBotPosition(context))
    if (!buildOrigin) return { ok: false, error: 'missing_build_origin' }

    if (!options.explicitOrigin &&
        tooFarFromBot(context, buildOrigin, this.options.maxDistanceFromBot) &&
        !this.allowsDistantStoredResumeOrigin(selected, buildOrigin, options)) {
      return { ok: false, error: 'build_origin_too_far' }
    }

    const planningOptions = {
      ...options,
      skipScaffolding: options.skipScaffolding ??
        (activeBlueprint.metadata?.skipScaffolding === true
          ? true
          : undefined) ??
        shouldSkipLocalScaffolding(activeBlueprint, aestheticRequest, requireAestheticGate)
    }
    const compiled = this.compileConstructionPlan(context, activeBlueprint, buildOrigin, materialResult, planningOptions)
    if (!compiled.ok) return compiled
    const {
      blueprintIR,
      blueprintValidation,
      constructionPlan,
      worldBlocks,
      sitePlan,
      materialPlan,
      materialResolution,
      orderPlan
    } = compiled
    const missingMaterials = materialPlan.missingMaterials
    const blockedReasons = sitePlan.blockedReasons || []
    const canBuild = missingMaterials.length === 0 && blockedReasons.length === 0
    const designArtifacts = createFrozenDesignArtifacts({
      request: aestheticRequest,
      selected: selected.selected,
      blueprint: activeBlueprint,
      blueprintIR,
      constructionPlan,
      designPlan: designResult.design,
      layoutPlan: layout.plan,
      interiorPlan: interior.plan,
      habitabilityHardGate,
      materialPlan,
      source: 'designed_blueprint'
    })
    const constructionEstimate = createConstructionEstimate({
      blueprint: activeBlueprint,
      constructionPlan,
      orderPlan,
      designSpec: designArtifacts.designSpec
    })

    return {
      ok: true,
      blueprint: activeBlueprint,
      blueprintIR: designArtifacts.blueprintIR,
      blueprintValidation,
      blueprintName: activeBlueprint.name,
      selectedBlueprint: selected.selected,
      candidateSummary: summarizeCandidates(selected.candidates, selected.attempted),
      designSpec: designArtifacts.designSpec,
      blueprintFreeze: designArtifacts.blueprintFreeze,
      designPlan: designResult.design,
      designDiagnostics: designResult.diagnostics,
      aestheticPlan: summarizeAestheticPlan({
        community,
        initialEncoding,
        refinedEncoding,
        refinement,
        finalAesthetic: acceptedFinalAesthetic,
        contrast,
        generationSeed
      }),
      layoutPlan: layout.plan,
      interiorPlan: interior.plan,
      interiorValidation,
      walkabilityPrecheck,
      habitabilityHardGate,
      habitabilityRequired: requireAestheticGate,
      origin: buildOrigin,
      requiredMaterials: materialPlan.requiredMaterials,
      formalRequiredMaterials: materialPlan.formalRequiredMaterials,
      materialPlan,
      materialResolution,
      constructionPlan,
      constructionEstimate,
      missingMaterials,
      totalBlocks: materialResult.totalBlocks,
      worldBlocks,
      sitePlan,
      orderPlan,
      blockedReasons,
      canBuild,
      reason: blockedReasons[0] || (missingMaterials.length ? 'missing_materials' : null)
    }
  }

  resumeOriginForSelectedBlueprint(context, selected, origin, options = {}) {
    if (origin || options.explicitOrigin || options.forceRebuild === true || options.rebuild === true) return origin
    if (!this.constructionRunStore) return origin
    const blueprintId = selected?.blueprint?.name || selected?.selected?.blueprintName || selected?.selected?.id
    if (!blueprintId) return origin
    const active = this.constructionRunStore.findActiveForBlueprint(blueprintId)
    const resumeOrigin = normalizeOrigin(active?.placementContext?.origin)
    if (!resumeOrigin) return origin
    logBuilding(context, `[BUILD_CONSTRUCTION_RUN_RESUME_PLACEMENT] runId=${active.runId} blueprint=${blueprintId} origin=${formatPos(resumeOrigin)}`)
    return resumeOrigin
  }

  allowsDistantStoredResumeOrigin(selected, buildOrigin, options = {}) {
    if (options.resumeOnly !== true || options.explicitOrigin === true) return false
    if (options.forceRebuild === true || options.rebuild === true) return false
    if (!this.constructionRunStore) return false
    const blueprintId = selected?.blueprint?.name || selected?.selected?.blueprintName || selected?.selected?.id
    if (!blueprintId) return false
    const active = this.constructionRunStore.findActiveForBlueprint(blueprintId)
    const storedOrigin = normalizeOrigin(active?.placementContext?.origin)
    const requestedOrigin = normalizeOrigin(buildOrigin)
    return Boolean(
      storedOrigin &&
      requestedOrigin &&
      storedOrigin.x === requestedOrigin.x &&
      storedOrigin.y === requestedOrigin.y &&
      storedOrigin.z === requestedOrigin.z
    )
  }

  previewFaithfulCommunityBlueprint(context, blueprintName, origin = null, options = {}, selected, request = {}) {
    const activeBlueprint = selected.blueprint
    const initialEncoding = this.structureEncoder.encode(activeBlueprint)
    if (!initialEncoding.ok) return initialEncoding

    const faithfulPrecheck = this.faithfulValidator.validateBlueprint(activeBlueprint, {
      ...request,
      selected: selected.selected,
      requiredStories: selected.selected?.requiredStories || request.requiredStories
    }, {
      requireSourceMode: true
    })
    if (!faithfulPrecheck.ok) {
      return {
        ok: false,
        error: `faithful_community_precheck_failed:${faithfulPrecheck.failures[0] || 'unknown'}`,
        faithfulValidation: faithfulPrecheck
      }
    }

    const materialResult = this.loader.getRequiredMaterials(activeBlueprint)
    if (!materialResult.ok) return materialResult

    const buildOrigin = normalizeOrigin(origin || currentBotPosition(context))
    if (!buildOrigin) return { ok: false, error: 'missing_build_origin' }

    if (!options.explicitOrigin &&
        tooFarFromBot(context, buildOrigin, this.options.maxDistanceFromBot) &&
        !this.allowsDistantStoredResumeOrigin(selected, buildOrigin, options)) {
      return { ok: false, error: 'build_origin_too_far' }
    }

    const planningOptions = {
      ...options,
      skipScaffolding: options.skipScaffolding ?? false
    }
    const compiled = this.compileConstructionPlan(context, activeBlueprint, buildOrigin, materialResult, planningOptions)
    if (!compiled.ok) return compiled
    const {
      blueprintIR,
      blueprintValidation,
      constructionPlan,
      worldBlocks,
      sitePlan,
      materialPlan,
      materialResolution,
      orderPlan
    } = compiled
    const missingMaterials = materialPlan.missingMaterials
    const blockedReasons = sitePlan.blockedReasons || []
    const canBuild = missingMaterials.length === 0 && blockedReasons.length === 0

    const designPlan = {
      layer: 'faithful_community_import',
      transformed: false,
      reason: 'faithful_community_import_skips_designer_refiner_and_interior_rewrite',
      style: activeBlueprint.metadata?.style || selected.selected?.style || null,
      buildingType: activeBlueprint.metadata?.buildingType || selected.selected?.buildingType || null,
      sourceMode: activeBlueprint.metadata?.sourceMode || selected.selected?.sourceMode || null
    }
    const aestheticPlan = faithfulAestheticPlan({
      selected: selected.selected,
      encoding: initialEncoding,
      validation: faithfulPrecheck
    })
    const layoutPlan = {
      enabled: false,
      reason: 'faithful_community_import_preserves_source_layout'
    }
    const interiorPlan = {
      enabled: false,
      reason: 'faithful_community_import_preserves_source_blocks'
    }
    const interiorValidation = {
      ok: true,
      skipped: true,
      reason: 'faithful_community_import_no_interior_rewrite'
    }
    const walkabilityPrecheck = {
      ok: true,
      source: 'faithful_community_validator',
      metrics: faithfulPrecheck.metrics,
      failures: []
    }
    const designArtifacts = createFrozenDesignArtifacts({
      request,
      selected: selected.selected,
      blueprint: activeBlueprint,
      blueprintIR,
      constructionPlan,
      designPlan,
      layoutPlan,
      interiorPlan,
      habitabilityHardGate: faithfulPrecheck,
      materialPlan,
      source: 'faithful_community_import'
    })
    const constructionEstimate = createConstructionEstimate({
      blueprint: activeBlueprint,
      constructionPlan,
      orderPlan,
      designSpec: designArtifacts.designSpec
    })

    return {
      ok: true,
      blueprint: activeBlueprint,
      blueprintIR: designArtifacts.blueprintIR,
      blueprintValidation,
      blueprintName: activeBlueprint.name,
      selectedBlueprint: selected.selected,
      candidateSummary: summarizeCandidates(selected.candidates, selected.attempted),
      designSpec: designArtifacts.designSpec,
      blueprintFreeze: designArtifacts.blueprintFreeze,
      designPlan,
      designDiagnostics: { faithfulCommunityImport: true },
      aestheticPlan,
      layoutPlan,
      interiorPlan,
      interiorValidation,
      walkabilityPrecheck,
      habitabilityHardGate: faithfulPrecheck,
      faithfulValidation: faithfulPrecheck,
      habitabilityRequired: true,
      origin: buildOrigin,
      requiredMaterials: materialPlan.requiredMaterials,
      formalRequiredMaterials: materialPlan.formalRequiredMaterials,
      materialPlan,
      materialResolution,
      constructionPlan,
      constructionEstimate,
      missingMaterials,
      totalBlocks: materialResult.totalBlocks,
      worldBlocks,
      sitePlan,
      orderPlan,
      blockedReasons,
      canBuild,
      reason: blockedReasons[0] || (missingMaterials.length ? 'missing_materials' : null)
    }
  }

  previewBudgetedSimpleBlueprint(context, blueprintName, origin = null, options = {}, selected, request = {}) {
    const activeBlueprint = selected.blueprint
    const materialResult = this.loader.getRequiredMaterials(activeBlueprint)
    if (!materialResult.ok) return materialResult

    const buildOrigin = normalizeOrigin(origin || currentBotPosition(context))
    if (!buildOrigin) return { ok: false, error: 'missing_build_origin' }

    if (!options.explicitOrigin &&
        tooFarFromBot(context, buildOrigin, this.options.maxDistanceFromBot) &&
        !this.allowsDistantStoredResumeOrigin(selected, buildOrigin, options)) {
      return { ok: false, error: 'build_origin_too_far' }
    }

    const planningOptions = {
      ...options,
      skipScaffolding: options.skipScaffolding ?? activeBlueprint.metadata?.skipScaffolding === true
    }
    const compiled = this.compileConstructionPlan(context, activeBlueprint, buildOrigin, materialResult, planningOptions)
    if (!compiled.ok) return compiled
    const {
      blueprintIR,
      blueprintValidation,
      constructionPlan,
      worldBlocks,
      sitePlan,
      materialPlan,
      materialResolution,
      orderPlan
    } = compiled
    const missingMaterials = materialPlan.missingMaterials
    const blockedReasons = sitePlan.blockedReasons || []
    const canBuild = missingMaterials.length === 0 && blockedReasons.length === 0
    const designPlan = {
      layer: 'complexity_budget_preserved',
      transformed: false,
      reason: 'low_complexity_request_preserves_simple_blueprint',
      style: activeBlueprint.metadata?.style || selected.selected?.style || request.style || null,
      buildingType: activeBlueprint.metadata?.buildingType || selected.selected?.buildingType || blueprintName,
      roofType: request.designSpec?.roofComplexity || activeBlueprint.metadata?.roofType || null
    }
    const layoutPlan = {
      enabled: false,
      reason: 'low_complexity_template_preserves_layout',
      rooms: activeBlueprint.metadata?.rooms || [],
      entrances: activeBlueprint.metadata?.doorways || [],
      stairs: activeBlueprint.metadata?.stairs || []
    }
    const interiorPlan = {
      enabled: false,
      reason: 'low_complexity_template_preserves_basic_interior',
      placements: activeBlueprint.metadata?.interiorAnchors || [],
      complete: true
    }
    const interiorValidation = {
      ok: true,
      skipped: true,
      reason: 'budgeted_simple_template'
    }
    const walkabilityPrecheck = {
      ok: true,
      skipped: true,
      reason: 'budgeted_simple_template'
    }
    const habitabilityHardGate = {
      ok: true,
      skipped: true,
      reason: 'complexity_budget_overrides_high_detail_hard_gate',
      metrics: {
        detectedStories: request.designSpec?.maxFloors || activeBlueprint.metadata?.floors || selected.selected?.requiredStories || null,
        materialCounts: materialPlan.formalRequiredMaterials || materialPlan.requiredMaterials || {},
        bounds: blueprintBoundsForLegacy(activeBlueprint)
      },
      failures: []
    }
    const designArtifacts = createFrozenDesignArtifacts({
      request,
      selected: selected.selected,
      blueprint: activeBlueprint,
      blueprintIR,
      constructionPlan,
      designPlan,
      layoutPlan,
      interiorPlan,
      habitabilityHardGate,
      materialPlan,
      source: 'complexity_budget_blueprint'
    })
    const constructionEstimate = createConstructionEstimate({
      blueprint: activeBlueprint,
      constructionPlan,
      orderPlan,
      designSpec: designArtifacts.designSpec
    })

    return {
      ok: true,
      blueprint: activeBlueprint,
      blueprintIR: designArtifacts.blueprintIR,
      blueprintValidation,
      blueprintName: activeBlueprint.name,
      selectedBlueprint: selected.selected,
      candidateSummary: summarizeCandidates(selected.candidates, selected.attempted),
      designSpec: designArtifacts.designSpec,
      blueprintFreeze: designArtifacts.blueprintFreeze,
      designPlan,
      designDiagnostics: { complexityBudgetPreserved: true },
      aestheticPlan: {
        enabled: false,
        skipped: true,
        layer: 'complexity_budget_preserved',
        reason: 'low_complexity_request_skips_high_detail_refinement',
        accepted: true,
        threshold: null,
        similarityThreshold: null,
        community: { sampleCount: 0, samples: [] },
        refinement: { refined: false, iterations: 0, operations: [] },
        final: { accepted: true, metrics: selected.selected?.complexityMetrics || null }
      },
      layoutPlan,
      interiorPlan,
      interiorValidation,
      walkabilityPrecheck,
      habitabilityHardGate,
      habitabilityRequired: false,
      origin: buildOrigin,
      requiredMaterials: materialPlan.requiredMaterials,
      formalRequiredMaterials: materialPlan.formalRequiredMaterials,
      materialPlan,
      materialResolution,
      constructionPlan,
      constructionEstimate,
      missingMaterials,
      totalBlocks: materialResult.totalBlocks,
      worldBlocks,
      sitePlan,
      orderPlan,
      blockedReasons,
      canBuild,
      reason: blockedReasons[0] || (missingMaterials.length ? 'missing_materials' : null)
    }
  }

  scoreNonArchitecturalFixture(blueprint, request, communitySamples) {
    const designed = this.designer.transformBlueprint(blueprint, request)
    if (!designed.ok) return designed
    const evaluation = this.aestheticModel.score(designed.blueprint, communitySamples, {
      aestheticThreshold: 0,
      similarityThreshold: 0
    })
    if (!evaluation.ok) return evaluation
    const acceptedEvaluation = {
      ...evaluation,
      accepted: true,
      exemptReason: 'non_architectural_fixture'
    }
    return {
      ok: true,
      blueprint: designed.blueprint,
      design: designed.design,
      diagnostics: designed.diagnostics || {},
      initial: summarizeAestheticEvaluation(acceptedEvaluation),
      final: summarizeAestheticEvaluation(acceptedEvaluation),
      attempts: [{
        iteration: 0,
        aesthetic_score: acceptedEvaluation.aesthetic_score,
        similarity_to_good_builds: acceptedEvaluation.similarity_to_good_builds,
        accepted: true,
        threshold: acceptedEvaluation.threshold,
        similarityThreshold: acceptedEvaluation.similarityThreshold,
        bestMatch: acceptedEvaluation.bestMatch,
        penalties: acceptedEvaluation.penalties,
        metrics: acceptedEvaluation.metrics,
        evaluation: acceptedEvaluation
      }],
      operations: [],
      refined: false,
      iterations: 0,
      evaluation: acceptedEvaluation
    }
  }

  buildAestheticContrast({
    request,
    community,
    initialBlueprint,
    finalBlueprint,
    initialEvaluation,
    finalEvaluation,
    finalHardGate
  }) {
    const samples = community?.samples || []
    const imported = samples[0] || null
    const initialHardGate = initialBlueprint ? this.hardGate.evaluateBlueprint(initialBlueprint, request) : null
    const initialEncoding = initialBlueprint ? this.structureEncoder.encode(initialBlueprint) : null
    const importedEvaluation = imported?.blueprint
      ? this.aestheticModel.score(imported.blueprint, samples, request?.aesthetic || {})
      : null
    const importedEncoding = imported?.encoding || (imported?.blueprint ? this.structureEncoder.encode(imported.blueprint) : null)
    const importedHardGate = imported?.hardGate || (imported?.blueprint
      ? this.hardGate.evaluateBlueprint(imported.blueprint, {
          ...request,
          requiredStories: imported.requiredStories || request?.requiredStories
        })
      : null)
    const finalEncoding = finalEvaluation?.encoding || (finalBlueprint ? this.structureEncoder.encode(finalBlueprint) : null)

    return {
      requiredFields: [
        'enclosure',
        'stories',
        'usableFloorArea',
        'doors',
        'stairContinuity',
        'roofCoverage',
        'functionalReachability',
        'materialCoherence',
        'structuralComplexity',
        'aestheticScore'
      ],
      oldProceduralOutput: summarizeContrastEntry({
        label: 'old_procedural_output',
        sourceKind: 'initial_rule_based_structure',
        blueprint: initialBlueprint,
        hardGate: initialHardGate,
        encoding: initialEncoding,
        evaluation: initialEvaluation
      }),
      importedCommunitySample: summarizeContrastEntry({
        label: 'imported_community_sample',
        sourceKind: imported?.sourceKind || 'community_sample_unavailable',
        blueprint: imported?.blueprint || null,
        hardGate: importedHardGate,
        encoding: importedEncoding,
        evaluation: importedEvaluation?.ok ? importedEvaluation : null,
        sample: imported
      }),
      communityGuidedAdaptedOutput: summarizeContrastEntry({
        label: 'community_guided_adapted_output',
        sourceKind: 'community_retrieval_and_adaptation',
        blueprint: finalBlueprint,
        hardGate: finalHardGate,
        encoding: finalEncoding,
        evaluation: finalEvaluation
      })
    }
  }

  checkMaterials(context, blueprint) {
    const required = this.loader.getRequiredMaterials(blueprint)
    if (!required.ok) return { ok: false, error: required.error, missingMaterials: [] }

    const counts = getLiveInventoryCounts(context)
    const missingMaterials = Object.entries(required.materials)
      .map(([item, requiredCount]) => ({
        item,
        required: requiredCount,
        available: counts[item] || 0,
        missing: Math.max(0, requiredCount - (counts[item] || 0))
      }))
      .filter(item => item.available < item.required)

    return {
      ok: missingMaterials.length === 0,
      requiredMaterials: required.materials,
      missingMaterials
    }
  }

  compileConstructionPlan(context, blueprint, buildOrigin, materialResult, planningOptions = {}) {
    const adapted = this.blueprintAdapter.fromLegacyBlueprint(blueprint)
    if (!adapted.ok) {
      return {
        ok: false,
        error: `blueprint_ir_adapter_failed:${adapted.error || 'unknown'}`,
        diagnostics: adapted.diagnostics || []
      }
    }

    const validation = this.blueprintValidator.validate(adapted.blueprint)
    if (!validation.ok) {
      const first = validation.diagnostics.find(entry => entry.severity === 'error')
      return {
        ok: false,
        error: `blueprint_ir_invalid:${first?.code || 'unknown'}`,
        diagnostics: validation.diagnostics
      }
    }

    const placementContext = {
      origin: buildOrigin,
      rotationY: planningOptions.rotationY || planningOptions.rotation || 0,
      mirror: planningOptions.mirror || null
    }
    const snapshotBlocks = materializeBlueprintBlocks(validation.blueprint, placementContext)
    const siteSnapshot = captureSiteSnapshot(context, snapshotBlocks)
    const compiled = this.constructionCompiler.compile({
      blueprint: validation.blueprint,
      placementContext,
      siteSnapshot,
      inventoryPolicy: {
        counts: getLiveInventoryCounts(context),
        formalMaterials: materialResult.materials || {}
      },
      compilerOptions: {
        ...planningOptions,
        includeWalkabilityGate: true,
        avoidInitialFootprint: planningOptions.explicitOrigin !== true
      }
    })

    if (!compiled.ok) {
      const first = compiled.diagnostics?.find(entry => entry.severity === 'error')
      return {
        ok: false,
        error: `construction_compile_failed:${first?.code || compiled.error || 'unknown'}`,
        diagnostics: compiled.diagnostics || []
      }
    }

    const preview = {
      ok: true,
      blueprintIR: validation.blueprint,
      blueprintValidation: validation,
      constructionPlan: compiled.plan,
      worldBlocks: compiled.legacy.worldBlocks,
      sitePlan: compiled.legacy.sitePlan,
      materialPlan: compiled.legacy.materialPlan,
      orderPlan: compiled.legacy.orderPlan
    }
    return applyMaterialResolutionToPreview(preview, getLiveInventoryCounts(context), {
      context,
      source: 'preview_material_resolution'
    })
  }

  async prepareConstructionRun(context, preview, options = {}) {
    if (!this.constructionRunStore) {
      return {
        ok: true,
        run: null,
        resumed: false,
        progress: { currentStepIndex: 0 },
        reconciliation: null
      }
    }

    const criteria = constructionRunCriteria(context, preview)
    const runArtifacts = constructionRunArtifactsFromPreview(preview, criteria)
    let existing = null
    if (options.forceRebuild !== true && options.rebuild !== true) {
      existing = this.constructionRunStore.findActiveCompatible(criteria)
      if (!existing) {
        const incompatible = this.constructionRunStore.findActiveForBlueprint(criteria.blueprintId)
        if (incompatible) {
          const compatibility = constructionRunCompatibility(incompatible, criteria)
          this.constructionRunStore.abandonRun(incompatible.runId, compatibility.reason || 'incompatible_construction_run', {
            compatibility,
            requested: criteria
          })
          logBuilding(context, `[BUILD_CONSTRUCTION_RUN_ABANDON] runId=${incompatible.runId} reason=${compatibility.reason || 'incompatible_construction_run'}`)
        }
      }
    } else {
      const active = this.constructionRunStore.findActiveForBlueprint(criteria.blueprintId)
      if (active) {
        this.constructionRunStore.abandonRun(active.runId, 'explicit_rebuild_requested', { requested: criteria })
        logBuilding(context, `[BUILD_CONSTRUCTION_RUN_ABANDON] runId=${active.runId} reason=explicit_rebuild_requested`)
      }
    }

    // RENOVATION lineage: a new renovation run records its explicit
    // renovationOf pointer and the base blueprint hash it renovates from.
    const renovationBase = options.renovationOf && !existing
      ? this.constructionRunStore.getRun(options.renovationOf)
      : null
    const run = existing || createConstructionRun({
      blueprintId: criteria.blueprintId,
      blueprintRevision: criteria.blueprintRevision,
      blueprintHash: criteria.blueprintHash,
      planId: criteria.planId,
      placementContext: criteria.placementContext,
      world: criteria.world,
      bounds: criteria.bounds,
      stagingChests: criteria.stagingChests,
      renovationOf: renovationBase?.runId || null,
      renovationBaseHash: renovationBase?.blueprintHash || null,
      designSpec: runArtifacts.designSpec,
      blueprintFreeze: runArtifacts.blueprintFreeze,
      frozenBlueprintIR: runArtifacts.frozenBlueprintIR,
      materialStats: runArtifacts.materialStats,
      lifecycle: runArtifacts.lifecycle,
      steps: preview.orderPlan?.steps || []
    })
    const preferredStagingChests = Array.isArray(run.stagingChests) && run.stagingChests.length
      ? run.stagingChests
      : criteria.stagingChests

    let executionPreview = applyConstructionExecutionStepsForRun(preview, run)

    const staging = await this.preparePhysicalStagingChest(context, run, executionPreview, {
      ...options,
      scanCenters: preferredStagingChests,
      bounds: criteria.bounds
    })
    if (!staging.ok) {
      const blockedRun = {
        ...run,
        status: 'BLOCKED_STAGING_CHEST',
        blockedReason: staging.error,
        stagingChestPreparation: staging,
        updatedAt: new Date().toISOString()
      }
      this.constructionRunStore.upsertRun(blockedRun)
      return { ok: false, error: staging.error, run: blockedRun, staging }
    }
    const preparedStagingChests = staging.chests?.length ? staging.chests : preferredStagingChests

    let reconciliation = reconcileConstructionRun(context, run, executionPreview.orderPlan?.steps || [])
    let reconciledRun = {
      ...run,
      ...reconciliation.runPatch,
      status: 'ACTIVE',
      terminalState: null,
      blockedReason: null,
      world: criteria.world,
      bounds: criteria.bounds,
      stagingChests: preparedStagingChests,
      primaryStagingChests: constructionRunStagingCenters(run, 'primary', preparedStagingChests),
      secondaryStagingChests: constructionRunStagingCenters(run, 'secondary', []),
      stagingMaterialIndex: run.stagingMaterialIndex || {},
      lastInventorySnapshot: run.lastInventorySnapshot || null,
      lastRestockAt: run.lastRestockAt || null,
      batchMaterialPlan: run.batchMaterialPlan || null,
      stagingChestPreparation: staging,
      designSpec: runArtifacts.designSpec || run.designSpec || null,
      blueprintFreeze: runArtifacts.blueprintFreeze || run.blueprintFreeze || null,
      frozenBlueprintIR: runArtifacts.frozenBlueprintIR || run.frozenBlueprintIR || null,
      materialStats: runArtifacts.materialStats || run.materialStats || null,
      lifecycle: updateConstructionLifecycle(
        {
          ...(run.lifecycle || runArtifacts.lifecycle || {}),
          gates: {
            ...((run.lifecycle || runArtifacts.lifecycle || {}).gates || {}),
            stagingChestKnown: preparedStagingChests.length > 0,
            stagingChestVerified: staging.skipped !== true && preparedStagingChests.length > 0,
            stagingChestDeployed: staging.deployed === true
          }
        },
        reconciliation.runPatch.steps,
        reconciliation.runPatch.currentPhase
      )
    }

    const storage = await this.reconcileConstructionRunStorage(context, reconciledRun, executionPreview, options)
    const resolvedPreview = storage.preview || executionPreview
    if (storage.run) reconciledRun = storage.run
    executionPreview = applyConstructionExecutionStepsForRun(resolvedPreview, reconciledRun)
    reconciliation = reconcileConstructionRun(context, reconciledRun, executionPreview.orderPlan?.steps || [])
    reconciledRun = {
      ...reconciledRun,
      ...reconciliation.runPatch,
      stagingChests: storage.chests?.length ? storage.chests : reconciledRun.stagingChests,
      primaryStagingChests: constructionRunStagingCenters(reconciledRun, 'primary', reconciledRun.primaryStagingChests || []),
      secondaryStagingChests: constructionRunStagingCenters(reconciledRun, 'secondary', reconciledRun.secondaryStagingChests || []),
      stagingMaterialIndex: storage.inventory
        ? stagingMaterialIndexFromInventories({
            primary: { counts: storage.inventory, chests: storage.chests || [] },
            previous: reconciledRun.stagingMaterialIndex,
            reason: 'construction_run_storage_reconcile'
          })
        : (reconciledRun.stagingMaterialIndex || {}),
      lastInventorySnapshot: inventoryBatchSnapshot(context),
      lastRestockAt: reconciledRun.lastRestockAt || null,
      batchMaterialPlan: reconciledRun.batchMaterialPlan || null,
      stagingInventory: storage.inventory || reconciledRun.stagingInventory || null,
      materialShortageBacklog: storage.deferredMissing || storage.missing || [],
      materialShortageCheckedPhase: storage.checkedPhase || reconciledRun.currentPhase || null,
      lifecycle: storage.inventory
        ? updateConstructionLifecycle({
            ...(reconciledRun.lifecycle || {}),
            gates: {
              ...(reconciledRun.lifecycle?.gates || {}),
              stagingInventoryVerified: true
            }
          }, reconciledRun.steps, reconciledRun.currentPhase)
        : reconciledRun.lifecycle
    }
    if (!storage.ok) {
      reconciledRun.status = 'BLOCKED_MATERIAL_SHORTAGE'
      reconciledRun.blockedReason = storage.error
      this.constructionRunStore.upsertRun(reconciledRun)
      return { ok: false, error: storage.error, run: reconciledRun, reconciliation, storage, preview: resolvedPreview }
    }

    const runWithRuntimeEvidence = recordConstructionRunSession(reconciledRun, {
      resumed: Boolean(existing),
      previousRun: existing,
      reason: existing
        ? (options.resumeOnly === true ? 'resume_only_request' : 'compatible_active_run')
        : 'new_run',
      resumeOnly: options.resumeOnly === true,
      worldIdentityUpgrade: existing
        ? constructionRunCompatibility(existing, criteria).worldIdentityUpgrade
        : null,
      processSessionId: BUILDING_PROCESS_SESSION_ID,
      pid: process.pid,
      lanPort: process.env.MC_PORT,
      dimension: context?.bot?.game?.dimension || criteria.world?.dimension || null,
      worldId: criteria.world?.worldId || null
    })
    const saved = this.constructionRunStore.upsertRun(runWithRuntimeEvidence)
    if (existing && saved.resumeHistory?.length) {
      const evidence = saved.resumeHistory[saved.resumeHistory.length - 1]
      logBuilding(context, `[BUILD_CONSTRUCTION_RUN_RESUME_EVIDENCE] runId=${saved.runId} sequence=${evidence.sequence} before=${evidence.checkpointBefore.verified}/${evidence.checkpointBefore.total} after=${evidence.checkpointAfter.verified}/${evidence.checkpointAfter.total} processRestarted=${evidence.processRestarted} lanPort=${evidence.runtime.lanPort || 'unknown'} lanPortChanged=${evidence.lanPortChanged} worldId=${evidence.runtime.worldId || 'unverified'} worldIdentityUpgrade=${Boolean(evidence.worldIdentityUpgrade)}`)
    }
    const progress = progressFromConstructionRun(saved, executionPreview.orderPlan?.steps || [])
    return {
      ok: true,
      run: saved,
      resumed: Boolean(existing),
      progress,
      reconciliation,
      storage,
      preview: executionPreview
    }
  }

  async reconcileConstructionRunStorage(context, run, preview, options = {}) {
    const reader = context?.storageSystem?.getStagingInventory || context?.storageSystem?.readStagingInventory
    if (typeof reader !== 'function') {
      const remaining = remainingMaterialRequirementsForRun(run, preview.orderPlan?.steps || [])
      if (requiresStagingInventoryVerification(context, run, preview, options)) {
        return {
          ok: false,
          error: 'staging_inventory_reader_unavailable',
          inventory: null,
          chests: run.stagingChests || [],
          missing: Object.entries(remaining).map(([item, count]) => ({
            item,
            required: count,
            available: 0,
            missing: count
          })),
          skipped: false,
          reason: 'staging_inventory_reader_unavailable'
        }
      }
      return { ok: true, inventory: null, skipped: true, reason: 'staging_inventory_reader_unavailable' }
    }

    const storageSession = storageSessionFromRun(run, preview)
    const primaryCenters = materialStorageScanCentersForTier(storageSession, 'primary')
    const secondaryCenters = materialStorageScanCentersForTier(storageSession, 'secondary')
    const allStagingCenters = materialStorageScanCentersForTier(storageSession, 'all')

    const inventory = await reader.call(context.storageSystem, context, {
      runId: run.runId,
      scanCenters: primaryCenters,
      canDig: false,
      owner: options.owner,
      reason: 'construction_run_resume_inventory_reconcile_primary'
    })
    const stagingCounts = inventory?.counts || inventory || {}
    const counts = mergeMaterialCounts(liveInventoryCountsIncludingHeld(context), stagingCounts)
    let resolvedPreview = applyMaterialResolutionToPreview(preview, counts, {
      context,
      source: 'construction_run_resume_material_resolution',
      runSteps: run.steps || {},
      materialOverrides: run.materialOverrides || [],
      origin: run.placementContext?.origin,
      skipVerified: true
    })
    let resolvedRun = mergeResolvedStepsIntoRun(run, resolvedPreview.orderPlan?.steps || [], {
      context,
      origin: run.placementContext?.origin
    })
    let remaining = remainingMaterialRequirementsForRun(resolvedRun, resolvedPreview.orderPlan?.steps || [])
    const chests = normalizeStagingChestRecords(allStagingCenters, run.stagingChests || [])
    let missing = Object.entries(remaining)
      .map(([item, count]) => ({
        item,
        required: count,
        available: Number(counts[item]) || 0
      }))
      .filter(entry => entry.available < entry.required)
      .map(entry => ({ ...entry, missing: entry.required - entry.available }))

    const mover = context?.storageSystem?.ensureStagingMaterials || context?.storageSystem?.moveMaterialsToStaging
    let refill = null
    let finalInventory = inventory
    let finalStagingCounts = stagingCounts
    let finalCounts = counts
    let finalChests = chests
    const checkedPhase = firstUnresolvedPhase(resolvedPreview.orderPlan?.steps || [], resolvedRun.steps || {}) ||
      normalizeConstructionPhase(resolvedRun.currentPhase || 'site_prepare')
    let phaseRequired = materialRequirementsForRunPhase(resolvedRun, resolvedPreview.orderPlan?.steps || [], checkedPhase)
    let phaseMissing = missingFromCounts(phaseRequired, finalCounts)

    if (phaseMissing.length && typeof mover === 'function') {
      refill = await mover.call(context.storageSystem, context, {
        runId: run.runId,
        required: phaseRequired,
        missing: phaseMissing,
        scanCenters: primaryCenters,
        sourceScanCenters: secondaryCenters,
        scanOnlyProvidedCenters: true,
        exactScanCenters: true,
        skipUtilitySearch: true,
        skipMemorySearch: true,
        canDig: false,
        owner: options.owner,
        reason: 'construction_run_resume_inventory_refill'
      })
      if (refill?.inventory) {
        finalStagingCounts = refill.inventory
        finalCounts = mergeMaterialCounts(liveInventoryCountsIncludingHeld(context), finalStagingCounts)
        resolvedPreview = applyMaterialResolutionToPreview(preview, finalCounts, {
          context,
          source: 'construction_run_resume_material_resolution_after_refill',
          runSteps: resolvedRun.steps || {},
          materialOverrides: resolvedRun.materialOverrides || run.materialOverrides || [],
          origin: resolvedRun.placementContext?.origin || run.placementContext?.origin,
          skipVerified: true
        })
        resolvedRun = mergeResolvedStepsIntoRun(resolvedRun, resolvedPreview.orderPlan?.steps || [], {
          context,
          origin: resolvedRun.placementContext?.origin || run.placementContext?.origin
        })
        remaining = remainingMaterialRequirementsForRun(resolvedRun, resolvedPreview.orderPlan?.steps || [])
        phaseRequired = materialRequirementsForRunPhase(resolvedRun, resolvedPreview.orderPlan?.steps || [], checkedPhase)
        missing = Object.entries(remaining)
          .map(([item, count]) => ({
            item,
            required: count,
            available: Number(finalCounts[item]) || 0
          }))
          .filter(entry => entry.available < entry.required)
          .map(entry => ({ ...entry, missing: entry.required - entry.available }))
        phaseMissing = missingFromCounts(phaseRequired, finalCounts)
      }
      if (refill?.ok) {
        finalInventory = await reader.call(context.storageSystem, context, {
          runId: run.runId,
        scanCenters: primaryCenters,
        exactScanCenters: true,
        owner: options.owner,
        reason: 'construction_run_resume_inventory_verify_primary_after_refill'
        })
        finalStagingCounts = finalInventory?.counts || finalInventory || {}
        finalCounts = mergeMaterialCounts(liveInventoryCountsIncludingHeld(context), finalStagingCounts)
        finalChests = chests
        resolvedPreview = applyMaterialResolutionToPreview(preview, finalCounts, {
          context,
          source: 'construction_run_resume_material_resolution_verify_after_refill',
          runSteps: resolvedRun.steps || {},
          materialOverrides: resolvedRun.materialOverrides || run.materialOverrides || [],
          origin: resolvedRun.placementContext?.origin || run.placementContext?.origin,
          skipVerified: true
        })
        resolvedRun = mergeResolvedStepsIntoRun(resolvedRun, resolvedPreview.orderPlan?.steps || [], {
          context,
          origin: resolvedRun.placementContext?.origin || run.placementContext?.origin
        })
        remaining = remainingMaterialRequirementsForRun(resolvedRun, resolvedPreview.orderPlan?.steps || [])
        phaseRequired = materialRequirementsForRunPhase(resolvedRun, resolvedPreview.orderPlan?.steps || [], checkedPhase)
        missing = Object.entries(remaining)
          .map(([item, count]) => ({
            item,
            required: count,
            available: Number(finalCounts[item]) || 0
          }))
          .filter(entry => entry.available < entry.required)
          .map(entry => ({ ...entry, missing: entry.required - entry.available }))
        phaseMissing = missingFromCounts(phaseRequired, finalCounts)
      }
    } else if (phaseMissing.length && secondaryCenters.length) {
      const secondaryInventory = await reader.call(context.storageSystem, context, {
        runId: run.runId,
        scanCenters: secondaryCenters,
        exactScanCenters: true,
        owner: options.owner,
        reason: 'construction_run_resume_inventory_secondary_shortage_probe'
      })
      finalCounts = mergeMaterialCounts(finalCounts, secondaryInventory?.counts || secondaryInventory || {})
      finalChests = chests
      phaseMissing = missingFromCounts(phaseRequired, finalCounts)
      missing = Object.entries(remaining)
        .map(([item, count]) => ({
          item,
          required: count,
          available: Number(finalCounts[item]) || 0
        }))
        .filter(entry => entry.available < entry.required)
        .map(entry => ({ ...entry, missing: entry.required - entry.available }))
    }

    if (missing.length) {
      if (!phaseMissing.length) {
        return {
          ok: true,
          inventory: finalStagingCounts,
          availableCounts: finalCounts,
          chests: finalChests,
          missing: [],
          deferredMissing: missing,
          checkedPhase,
          phaseRequirements: phaseRequired,
          materialResolution: resolvedPreview.materialResolution || null,
          preview: resolvedPreview,
          run: resolvedRun,
          refill
        }
      }
      return {
        ok: false,
        error: `BLOCKED_MATERIAL_SHORTAGE:${phaseMissing.map(entry => `${entry.item}:${entry.missing}`).join(',')}`,
        inventory: finalStagingCounts,
        availableCounts: finalCounts,
        chests: finalChests,
        missing: phaseMissing,
        deferredMissing: missing,
        checkedPhase,
        phaseRequirements: phaseRequired,
        materialResolution: resolvedPreview.materialResolution || null,
        preview: resolvedPreview,
        run: resolvedRun,
        refill
      }
    }
    return {
      ok: true,
      inventory: finalStagingCounts,
      availableCounts: finalCounts,
      chests: finalChests,
      missing: [],
      deferredMissing: [],
      checkedPhase,
      phaseRequirements: phaseRequired,
      materialResolution: resolvedPreview.materialResolution || null,
      preview: resolvedPreview,
      run: resolvedRun,
      refill
    }
  }

  async preparePhysicalStagingChest(context, run, preview, options = {}) {
    const forcePhysical = options.requirePhysicalStagingChest === true ||
      options.stagedStorageRefill === true ||
      shouldUseStagedStorageRefill(context, preview, options)
    const recorded = normalizeStagingChestRecords(run.stagingChests || [], [])
    const confirmedRecorded = recorded.filter(chest => isContainerAt(context, chest.position))
    if (confirmedRecorded.length) {
      return {
        ok: true,
        mode: 'resume_existing_staging_chest',
        chests: confirmedRecorded,
        deployed: false,
        reused: true
      }
    }

    const explicit = normalizeOrigin(options.stagingChestPosition || options.stagingChest)
    if (explicit && isContainerAt(context, explicit)) {
      return {
        ok: true,
        mode: 'explicit_existing_staging_chest',
        chests: [{
          position: explicit,
          source: 'explicit_staging_chest',
          verified: true,
          temporary: options.temporaryStagingChest === true
        }],
        deployed: false,
        reused: true
      }
    }

    const reader = context?.storageSystem?.getStagingInventory || context?.storageSystem?.readStagingInventory
    if (typeof reader === 'function') {
      const inventory = await reader.call(context.storageSystem, context, {
        runId: run.runId,
        scanCenters: options.scanCenters || run.stagingChests || materialStorageScanCentersForPreview(preview),
        owner: options.owner,
        reason: 'construction_staging_chest_prepare'
      })
      const chests = normalizeStagingChestRecords(inventory?.chests || [], [])
      if (chests.length) {
        return {
          ok: true,
          mode: 'identified_existing_staging_chest',
          chests,
          inventory: inventory?.counts || inventory || {},
          deployed: false,
          reused: true
        }
      }
    }

    if (!forcePhysical) {
      return {
        ok: true,
        mode: 'physical_staging_chest_not_required',
        chests: recorded.length ? recorded : normalizeStagingChestRecords(options.scanCenters || [], []),
        deployed: false,
        skipped: true
      }
    }

    if (options.deployStagingChest === false) {
      return { ok: false, error: 'staging_chest_required_but_deploy_disabled' }
    }
    if (!hasInventoryItem(context, 'chest')) {
      return { ok: false, error: 'staging_chest_required_missing_chest_item' }
    }

    const candidates = stagingChestCandidates(options.bounds || run.bounds, preview.origin || run.placementContext?.origin)
    for (const position of candidates) {
      if (!isAirAt(context, position)) continue
      const placed = await placeBlock(context, position, 'chest', {
        owner: options.owner,
        timeoutMs: options.timeoutMs || 15000,
        reservedPositions: createReservedPositionSet(preview.worldBlocks || []),
        reservedBounds: createReservedBounds(preview.worldBlocks || []),
        preferOutsideReservedBounds: true,
        forceSafeApproach: true
      })
      if (!placed.ok) continue
      if (!isContainerAt(context, position)) {
        return { ok: false, error: 'staging_chest_deploy_unverified', deployResult: placed }
      }
      return {
        ok: true,
        mode: 'deployed_new_staging_chest',
        chests: [{
          position,
          source: 'deployed_staging_chest',
          verified: true,
          temporary: options.temporaryStagingChest !== false
        }],
        deployed: true,
        reused: false,
        deployResult: placed.reason || 'placed'
      }
    }

    return { ok: false, error: 'staging_chest_required_no_reachable_outside_bounds_position' }
  }

  async placeNextBlock(context, options = {}) {
    if (!this.session) return { ok: false, error: 'build_session_missing' }
    if (isDangerHigh(context)) {
      this.session.status = 'FAILED'
      this.session.lastBuildError = 'danger_too_high'
      return { ok: false, error: 'danger_too_high', build: this.getStatus() }
    }

    let lastResult = null
    const limit = Math.max(1, options.maxBlocksPerUpdate || this.options.maxBlocksPerUpdate || 1)
    for (let i = 0; i < limit; i++) {
      if (this.session.constructionRun) {
        this.session.currentStepIndex = nextExecutableStepIndex(this.session)
      }
      const step = this.session.steps[this.session.currentStepIndex]
      if (!step) {
        const completed = await this.finalizeConstructionRun(context, options)
        return { ok: completed.ok, completed: completed.ok, build: this.getStatus(), result: lastResult, cleanup: completed.cleanup }
      }

      const boundedGuard = guardBoundedSmokeStep(step, options)
      if (!boundedGuard.ok) {
        return {
          ok: false,
          error: boundedGuard.error,
          step,
          actualNextStep: boundedGuard.actualNextStep,
          expectedStep: boundedGuard.expectedStep,
          boundedGuard,
          build: this.getStatus()
        }
      }

      const scaffoldSkip = optionalScaffoldSkipResult(context, this.session, step)
      if (scaffoldSkip.ok) {
        logBuilding(context, `[BUILD_OPTIONAL_SCAFFOLD_SKIPPED] target=${formatPos(step.position)} retry=${scaffoldSkip.data.retryCount} reason=${scaffoldSkip.message}`)
        this.updateConstructionStep(step, STEP_STATE.VERIFIED, {
          scaffoldSkipRecord: scaffoldSkip.scaffoldSkipRecord
        })
        lastResult = scaffoldSkip
        this.session.currentStepIndex = this.session.constructionRun
          ? nextExecutableStepIndex(this.session)
          : this.session.currentStepIndex + 1
        this.session.updatedAt = new Date().toISOString()
        continue
      }

      const clearAlreadySatisfied = clearStepAlreadySatisfiedSkipResult(context, this.session, step, options)
      if (clearAlreadySatisfied.ok) {
        logBuilding(context, `[BUILD_CLEAR_ALREADY_SATISFIED] target=${formatPos(step.position)} expectedStep=${clearAlreadySatisfied.expectedStepId || 'none'} reason=${clearAlreadySatisfied.reason}`)
        this.updateConstructionStep(step, STEP_STATE.VERIFIED, {
          clearSkipRecord: clearAlreadySatisfied.clearSkipRecord
        })
        lastResult = clearAlreadySatisfied
        this.session.currentStepIndex = this.session.constructionRun
          ? nextExecutableStepIndex(this.session)
          : this.session.currentStepIndex + 1
        this.session.updatedAt = new Date().toISOString()
        continue
      }

      const phaseGate = await this.ensureConstructionPhaseReady(context, step, options)
      if (!constructionShouldContinue(options)) {
        return { ok: false, error: 'task_interrupted', interrupted: true, step, build: this.getStatus() }
      }
      if (!phaseGate.ok) {
        this.session.status = phaseGate.status || 'FAILED'
        this.session.lastBuildError = phaseGate.error
        return { ok: false, error: phaseGate.error, step, build: this.getStatus(), phaseGate }
      }

      const inventoryBatch = await this.ensureInventoryBatchReady(context, step, options)
      if (!constructionShouldContinue(options)) {
        return { ok: false, error: 'task_interrupted', interrupted: true, step, build: this.getStatus() }
      }
      if (!inventoryBatch.ok) {
        this.session.status = inventoryBatch.status || 'BLOCKED_MATERIAL_SHORTAGE'
        this.session.lastBuildError = inventoryBatch.error
        return { ok: false, error: inventoryBatch.error, step, build: this.getStatus(), inventoryBatch }
      }

      const executionRunStatus = step.runStatus ||
        this.session?.constructionRun?.steps?.[step.id]?.status ||
        STEP_STATE.PENDING
      this.updateConstructionStep(step, STEP_STATE.READY)
      this.updateConstructionStep(step, STEP_STATE.EXECUTING)
      const result = await this.executor.executeStep(context, step, {
        ...options,
        executionRunStatus,
        executionStepId: step.id
      })
      if (!result.ok) {
        if (result.error === 'task_interrupted' || !constructionShouldContinue(options)) {
          return { ...result, ok: false, error: 'task_interrupted', interrupted: true, step, build: this.getStatus() }
        }
        this.updateConstructionStep(step, isRetryableBuildError(result.error) ? STEP_STATE.RETRYABLE_FAILED : STEP_STATE.TERMINAL_FAILED, {
          retryError: result.error
        })
        this.session.status = 'FAILED'
        this.session.lastBuildError = result.error
        return { ...result, ok: false, error: result.error, step, build: this.getStatus() }
      }

      lastResult = result
      this.applyStepResult(step, result)
      const stepResultDetails = constructionStepDetailsFromResult(result)
      this.updateConstructionStep(step, STEP_STATE.PLACED, stepResultDetails)
      this.updateConstructionStep(step, STEP_STATE.VERIFIED, stepResultDetails)
      this.markClearStepsSatisfiedByPlacement(context, step)
      this.session.currentStepIndex = this.session.constructionRun
        ? nextExecutableStepIndex(this.session)
        : this.session.currentStepIndex + 1
      this.session.updatedAt = new Date().toISOString()

      if (step.kind === 'validate') {
        const completed = await this.finalizeConstructionRun(context, options)
        return { ok: completed.ok, completed: completed.ok, step, build: this.getStatus(), cleanup: completed.cleanup }
      }
    }

    return { ok: true, completed: false, result: lastResult, build: this.getStatus() }
  }

  async ensureConstructionPhaseReady(context, step, options = {}) {
    if (!this.session?.constructionRun || !step) return { ok: true, skipped: true, reason: 'construction_run_unavailable' }
    const phase = normalizeConstructionPhase(step.phase, step)
    const dependencyGate = phaseDependenciesSatisfied(this.session, phase)
    if (!dependencyGate.ok) {
      const gate = {
        ok: false,
        phase,
        sessionId: this.session.phaseGateSessionId,
        status: 'FAILED',
        error: dependencyGate.error,
        missingDependencies: dependencyGate.missingDependencies,
        checkedAt: new Date().toISOString()
      }
      this.recordConstructionPhaseGate(phase, gate)
      return gate
    }

    const cached = this.session.phaseGates?.[phase]
    if (cached?.ok === true && cached.sessionId === this.session.phaseGateSessionId) {
      return { ok: true, phase, cached: true, sessionId: cached.sessionId }
    }

    const materialGate = await this.ensureConstructionPhaseMaterials(context, phase, {
      ...options,
      currentStep: step
    })
    // A material check that ran into an interrupt/pause (typically: the
    // connection dropped mid-check and every chest open failed on the dead
    // socket) is not a verdict. Recording it would stamp a false
    // BLOCKED_MATERIAL_SHORTAGE on the run.
    if (!constructionShouldContinue(options)) {
      return { ok: false, phase, error: 'task_interrupted', interrupted: true, sessionId: this.session.phaseGateSessionId }
    }
    if (!materialGate.ok) {
      const gate = {
        ...materialGate,
        phase,
        sessionId: this.session.phaseGateSessionId,
        status: 'BLOCKED_MATERIAL_SHORTAGE',
        checkedAt: new Date().toISOString()
      }
      this.recordConstructionPhaseGate(phase, gate)
      return gate
    }

    const gate = {
      ok: true,
      phase,
      sessionId: this.session.phaseGateSessionId,
      dependenciesVerified: true,
      materialsVerified: materialGate.verified === true,
      skippedMaterialCheck: materialGate.skipped === true,
      materialRefill: materialGate.refill || null,
      requirements: materialGate.requirements || {},
      phaseRequirements: materialGate.phaseRequirements || {},
      deferredMissing: materialGate.deferredMissing || [],
      checkedAt: new Date().toISOString()
    }
    this.recordConstructionPhaseGate(phase, gate)
    return gate
  }

  async ensureConstructionPhaseMaterials(context, phase, options = {}) {
    const phaseRequirements = phaseMaterialRequirements(this.session, phase)
    const requirements = phaseMaterialGateRequirements(this.session, phase, options.currentStep, phaseRequirements)
    if (!Object.keys(phaseRequirements).length) {
      return { ok: true, phase, verified: true, requirements: {}, phaseRequirements: {} }
    }
    if (!Object.keys(requirements).length) {
      return {
        ok: true,
        phase,
        verified: true,
        requirements: {},
        phaseRequirements,
        skipped: true,
        reason: 'no_current_step_material_requirement'
      }
    }

    const storage = context?.storageSystem
    const reader = storage?.getStagingInventory || storage?.readStagingInventory
    if (typeof reader !== 'function') {
      if (this.session?.constructionRun?.stagingChestPreparation?.skipped !== true && this.session?.constructionRun?.stagingChests?.length) {
        return {
          ok: false,
          phase,
          error: `BLOCKED_MATERIAL_SHORTAGE:${phase}:staging_inventory_reader_unavailable`,
          requirements,
          phaseRequirements,
          inventory: null,
          missing: Object.entries(requirements).map(([item, count]) => ({
            item,
            required: count,
            available: 0,
            missing: count
          })),
          reason: 'staging_inventory_reader_unavailable'
        }
      }
      return { ok: true, phase, skipped: true, reason: 'staging_inventory_reader_unavailable', requirements, phaseRequirements }
    }

    const primaryCenters = materialStorageScanCentersForTier(this.session, 'primary')
    const secondaryCenters = materialStorageScanCentersForTier(this.session, 'secondary')
    let primaryInventory = await reader.call(storage, context, {
      runId: this.session.constructionRunId,
      phase,
      scanCenters: primaryCenters,
      canDig: false,
      owner: options.owner,
      reason: 'construction_phase_material_gate_primary'
    })
    let secondaryInventory = null
    let counts = mergeMaterialCounts(liveInventoryCountsIncludingHeld(context), primaryInventory?.counts || primaryInventory || {})
    let missing = missingFromCounts(requirements, counts)
    let refillResult = null

    if (missing.length) {
      const mover = storage.ensureStagingMaterials || storage.moveMaterialsToStaging
      if (typeof mover === 'function') {
        const moved = await mover.call(storage, context, {
          runId: this.session.constructionRunId,
          phase,
          required: requirements,
          missing,
          scanCenters: primaryCenters,
          sourceScanCenters: secondaryCenters,
          scanOnlyProvidedCenters: true,
          exactScanCenters: true,
          skipUtilitySearch: true,
          skipMemorySearch: true,
          canDig: false,
          owner: options.owner,
          reason: 'construction_phase_material_gate_refill'
        })
        refillResult = moved || null
        if (!moved?.ok) {
          if (moved?.inventory) {
            counts = mergeMaterialCounts(liveInventoryCountsIncludingHeld(context), moved.inventory)
            missing = missingFromCounts(requirements, counts)
          }
          if (missing.length) {
            return {
              ok: false,
              phase,
              error: `BLOCKED_MATERIAL_SHORTAGE:${phase}:${missing.map(entry => `${entry.item}:${entry.missing}`).join(',')}`,
              requirements,
              phaseRequirements,
              inventory: counts,
              missing,
              refill: refillResult
            }
          }
        }
        if (moved?.ok) {
          primaryInventory = await reader.call(storage, context, {
            runId: this.session.constructionRunId,
            phase,
            scanCenters: primaryCenters,
            exactScanCenters: true,
            canDig: false,
            owner: options.owner,
            reason: 'construction_phase_material_gate_primary_verify_after_refill'
          })
          counts = mergeMaterialCounts(liveInventoryCountsIncludingHeld(context), primaryInventory?.counts || primaryInventory || {})
          missing = missingFromCounts(requirements, counts)
        }
      } else if (secondaryCenters.length) {
        secondaryInventory = await reader.call(storage, context, {
          runId: this.session.constructionRunId,
          phase,
          scanCenters: secondaryCenters,
          exactScanCenters: true,
          canDig: false,
          owner: options.owner,
          reason: 'construction_phase_material_gate_secondary_shortage_probe'
        })
        counts = mergeMaterialCounts(
          liveInventoryCountsIncludingHeld(context),
          primaryInventory?.counts || primaryInventory || {},
          secondaryInventory?.counts || secondaryInventory || {}
        )
        missing = missingFromCounts(requirements, counts)
      }
    }

    this.persistConstructionRunLogistics({
      stagingMaterialIndex: stagingMaterialIndexFromInventories({
        primary: primaryInventory,
        secondary: secondaryInventory,
        previous: this.session.constructionRun?.stagingMaterialIndex,
        reason: 'construction_phase_material_gate'
      }),
      lastInventorySnapshot: inventoryBatchSnapshot(context)
    })

    if (missing.length) {
      return {
        ok: false,
        phase,
        error: `BLOCKED_MATERIAL_SHORTAGE:${phase}:${missing.map(entry => `${entry.item}:${entry.missing}`).join(',')}`,
        requirements,
        phaseRequirements,
        inventory: counts,
        missing
      }
    }

    return {
      ok: true,
      phase,
      verified: true,
      requirements,
      phaseRequirements,
      inventory: counts,
      missing: [],
      deferredMissing: missingFromCounts(phaseRequirements, counts),
      refill: refillResult
    }
  }

  async ensureInventoryBatchReady(context, step, options = {}) {
    if (!this.session?.constructionRun || !step || options.allowStorageRefill === false) {
      return { ok: true, skipped: true, reason: 'batching_not_applicable' }
    }
    if (!['foundation_fill', 'scaffold_place', 'place'].includes(step.kind)) {
      return { ok: true, skipped: true, reason: 'non_material_step' }
    }

    const currentRequirements = itemRequirementsForStep(step)
    const currentItems = Object.keys(currentRequirements)
    if (!currentItems.length || currentItems.every(itemName => inventoryItemCount(context, itemName) >= currentRequirements[itemName])) {
      const active = this.session.inventoryBatchState || this.session.constructionRun.batchMaterialPlan
      if (active && inventoryBatchStillValid(active, this.session, step)) {
        return { ok: true, cached: true, batchId: active.batchId, reason: 'batch_still_valid' }
      }
    }

    const reason = inventoryBatchRestockReason(this.session, step, currentItems, context, options)
    if (!reason) return { ok: true, skipped: true, reason: 'restock_threshold_not_met' }

    const inventoryBefore = inventoryBatchSnapshot(context)
    const plan = createInventoryBatchPlan(this.session, step, inventoryBefore.counts, {
      ...this.options,
      ...options
    }, context)
    const primaryCenters = materialStorageScanCentersForTier(this.session, 'primary')
    const secondaryCenters = materialStorageScanCentersForTier(this.session, 'secondary')
    const decision = {
      batchId: plan.batchId,
      plannedSteps: plan.plannedSteps.length,
      materialsNeeded: plan.materialsNeeded,
      inventoryBefore,
      primaryChestsUsed: [],
      secondaryChestsUsed: [],
      materialsWithdrawn: [],
      expectedStepsBeforeRestock: plan.expectedStepsBeforeRestock,
      reasonForRestock: reason
    }

    if (!plan.withdrawals.length) {
      this.session.inventoryBatchState = plan
      logBuilding(context, `[INVENTORY_BATCH_DECISION] ${JSON.stringify(decision)}`)
      this.persistConstructionRunLogistics({
        lastInventorySnapshot: inventoryBefore,
        batchMaterialPlan: plan,
        primaryStagingChests: materialStorageScanCentersForTier(this.session, 'primary'),
        secondaryStagingChests: materialStorageScanCentersForTier(this.session, 'secondary')
      })
      return { ok: true, skipped: true, reason: 'inventory_already_satisfies_batch', plan, decision }
    }

    const storage = context?.storageSystem
    if (!storage || typeof storage.takeItems !== 'function') {
      const baseBatchSatisfied = Object.entries(plan.baseRequiredMaterials || {}).every(
        ([itemName, count]) => inventoryItemCount(context, itemName) >= count
      )
      if (baseBatchSatisfied) {
        return { ok: true, skipped: true, reason: 'retry_reserve_storage_unavailable', plan, decision }
      }
      return { ok: false, status: 'BLOCKED_MATERIAL_SHORTAGE', error: `BLOCKED_MATERIAL_SHORTAGE:${normalizeConstructionPhase(step.phase, step)}:storage_system_unavailable` }
    }

    const restock = await this.withdrawInventoryBatchMaterials(context, plan, {
      ...options,
      primaryCenters,
      secondaryCenters,
      currentItems,
      currentRequirements
    })
    decision.primaryChestsUsed = restock.primaryChestsUsed
    decision.secondaryChestsUsed = restock.secondaryChestsUsed
    decision.materialsWithdrawn = restock.materialsWithdrawn
    decision.inventoryAfter = inventoryBatchSnapshot(context)
    decision.failures = restock.failures

    logBuilding(context, `[INVENTORY_BATCH_DECISION] ${JSON.stringify(decision)}`)
    logBuilding(context, `[CHEST_OPEN_SUMMARY] ${JSON.stringify({
      batchId: plan.batchId,
      openedChests: restock.openedChests,
      openCount: restock.openCount,
      reason,
      stepsSinceLastRestock: stepsSinceLastRestock(this.session)
    })}`)

    const currentMissing = currentItems.filter(itemName => inventoryItemCount(context, itemName) <= 0)
    const ok = currentMissing.length === 0
    this.session.inventoryBatchState = {
      ...plan,
      materialsWithdrawn: restock.materialsWithdrawn,
      failures: restock.failures
    }
    this.persistConstructionRunLogistics({
      stagingMaterialIndex: stagingMaterialIndexFromBatchRestock(restock, this.session.constructionRun?.stagingMaterialIndex),
      lastInventorySnapshot: decision.inventoryAfter,
      lastRestockAt: restock.materialsWithdrawn.length ? new Date().toISOString() : this.session.constructionRun?.lastRestockAt || null,
      batchMaterialPlan: this.session.inventoryBatchState,
      primaryStagingChests: primaryCenters,
      secondaryStagingChests: secondaryCenters
    })
    if (ok) return { ok: true, plan: this.session.inventoryBatchState, decision, restock }
    return {
      ok: false,
      status: 'BLOCKED_MATERIAL_SHORTAGE',
      error: `BLOCKED_MATERIAL_SHORTAGE:${normalizeConstructionPhase(step.phase, step)}:${currentMissing.map(item => `${item}:1`).join(',')}`,
      plan: this.session.inventoryBatchState,
      decision,
      restock
    }
  }

  async withdrawInventoryBatchMaterials(context, plan, options = {}) {
    const storage = context.storageSystem
    const primaryCenters = options.primaryCenters || []
    const secondaryCenters = options.secondaryCenters || []
    const materialsWithdrawn = []
    const failures = []
    const primaryChestsUsed = []
    const secondaryChestsUsed = []
    const openedChests = []
    let openCount = 0

    for (const request of plan.withdrawals || []) {
      if (!request.item || request.count <= 0) continue
      let remaining = Math.max(0, request.count - inventoryItemCount(context, request.item))
      if (remaining <= 0) continue

      const primary = await this.takeMaterialFromCenters(context, request.item, remaining, primaryCenters, {
        ...options,
        reason: 'building_inventory_batch_primary'
      })
      openCount += primary.openCount || 0
      appendUniquePositions(openedChests, primary.openedChests)
      appendUniquePositions(primaryChestsUsed, primary.openedChests)
      if (primary.moved > 0) {
        materialsWithdrawn.push({ item: request.item, count: primary.moved, source: 'primary' })
        remaining = Math.max(0, remaining - primary.moved)
      }

      const currentRequired = Math.max(0, Number(options.currentRequirements?.[request.item]) || 0)
      const currentStepSatisfied = currentRequired <= 0 || inventoryItemCount(context, request.item) >= currentRequired
      if (remaining > 0 && currentStepSatisfied) {
        failures.push({
          item: request.item,
          missing: remaining,
          error: 'deferred_batch_material_shortage_primary_only'
        })
      } else if (remaining > 0 && secondaryCenters.length) {
        const secondary = await this.takeMaterialFromCenters(context, request.item, remaining, secondaryCenters, {
          ...options,
          reason: 'building_inventory_batch_secondary_shortage'
        })
        openCount += secondary.openCount || 0
        appendUniquePositions(openedChests, secondary.openedChests)
        appendUniquePositions(secondaryChestsUsed, secondary.openedChests)
        if (secondary.moved > 0) {
          materialsWithdrawn.push({ item: request.item, count: secondary.moved, source: 'secondary' })
          remaining = Math.max(0, remaining - secondary.moved)
        }
        if (remaining > 0) failures.push({ item: request.item, missing: remaining, error: secondary.error || primary.error || 'batch_material_not_found' })
      } else if (remaining > 0) {
        failures.push({ item: request.item, missing: remaining, error: primary.error || 'batch_material_not_found' })
      }
    }

    return {
      ok: failures.length === 0,
      materialsWithdrawn,
      failures,
      primaryChestsUsed,
      secondaryChestsUsed,
      openedChests,
      openCount
    }
  }

  async takeMaterialFromCenters(context, itemName, count, centers, options = {}) {
    if (!centers?.length || count <= 0) {
      return { ok: false, moved: 0, error: 'storage_scan_centers_empty', openedChests: [], openCount: 0 }
    }
    const before = inventoryItemCount(context, itemName)
    const result = await context.storageSystem.takeItems(context, {
      itemName,
      count,
      owner: options.owner,
      query: itemName,
      radius: materialStorageSearchRadius(this.options, options),
      scanCenters: centers,
      scanOnlyProvidedCenters: true,
      exactScanCenters: true,
      skipUtilitySearch: true,
      skipMemorySearch: true,
      canDig: false,
      shouldContinue: options.shouldContinue,
      reason: options.reason || 'building_inventory_batch_refill'
    })
    const after = inventoryItemCount(context, itemName)
    const moved = movedItemCount(result, itemName, after - before)
    return {
      ok: result.ok === true && moved > 0,
      moved,
      error: result.error || null,
      openedChests: result.openSummary?.openedChests || (result.targetChest?.position ? [result.targetChest.position] : []),
      openCount: result.openSummary?.openCount || (result.targetChest?.position ? 1 : 0),
      result
    }
  }

  persistConstructionRunLogistics(patch = {}) {
    if (!this.session?.constructionRun?.runId || !patch || typeof patch !== 'object') return null
    const updated = {
      ...patch,
      updatedAt: new Date().toISOString()
    }
    this.session.constructionRun = {
      ...this.session.constructionRun,
      ...updated
    }
    if (!this.constructionRunStore) return this.session.constructionRun
    this.markConstructionCheckpointDirty()
    this.flushConstructionRunCheckpoint('logistics', { force: true })
    return this.session.constructionRun
  }

  recordConstructionPhaseGate(phase, gate) {
    this.session.phaseGates = {
      ...(this.session.phaseGates || {}),
      [phase]: gate
    }
    if (!this.session.constructionRun) return
    const status = gate.status || this.session.constructionRun.status || 'ACTIVE'
    this.session.constructionRun = {
      ...this.session.constructionRun,
      phaseGates: this.session.phaseGates,
      currentPhase: phase,
      status,
      blockedReason: gate.ok === false ? gate.error : this.session.constructionRun.blockedReason || null,
      lifecycle: updateConstructionLifecycle(this.session.constructionRun.lifecycle, this.session.constructionRun.steps, phase),
      updatedAt: new Date().toISOString()
    }
    if (this.constructionRunStore) {
      this.markConstructionCheckpointDirty()
      this.flushConstructionRunCheckpoint('phase_gate', { force: true })
    }
  }

  async finalizeConstructionRun(context, options = {}) {
    if (!this.session) return { ok: false, error: 'build_session_missing' }
    const ledgerGate = constructionCompletionLedgerGate(this.session)
    if (!ledgerGate.ok) {
      this.session.status = 'FAILED'
      this.session.lastBuildError = ledgerGate.error
      return { ok: false, error: ledgerGate.error, ledgerGate }
    }
    const cleanup = await this.cleanupConstructionSite(context, options)
    if (!cleanup.ok && options.failOnCleanupError === true) {
      this.session.status = 'FAILED'
      this.session.lastBuildError = cleanup.error || 'site_cleanup_failed'
      return { ok: false, error: this.session.lastBuildError, cleanup }
    }
    this.session.siteCleanup = cleanup
    this.session.status = 'COMPLETED'
    this.session.completedAt = new Date().toISOString()
    this.markConstructionRunCompleted()
    return { ok: true, cleanup }
  }

  async cleanupConstructionSite(context, options = {}) {
    const run = this.session?.constructionRun
    if (!run) return { ok: true, skipped: true, reason: 'construction_run_unavailable' }
    const cleanupTemporaryChests = options.cleanupTemporaryStagingChest ?? this.options.cleanupTemporaryStagingChest ?? true
    const stagingChests = []
    const failures = []

    for (const chest of run.stagingChests || []) {
      const position = normalizeOrigin(chest.position || chest)
      if (!position) continue
      if (chest.temporary !== true) {
        stagingChests.push({ position, action: 'kept', reason: 'non_temporary_staging_chest' })
        continue
      }
      if (!cleanupTemporaryChests) {
        stagingChests.push({ position, action: 'kept', reason: 'cleanup_temporary_staging_chest_disabled' })
        continue
      }
      if (!isContainerAt(context, position)) {
        stagingChests.push({ position, action: 'already_clear', reason: 'staging_chest_absent' })
        continue
      }

      const inventory = await this.readSingleStagingChestInventory(context, chest, options, 'construction_site_cleanup_inventory')
      const itemCount = Object.values(inventory.counts || {}).reduce((sum, count) => sum + (Number(count) || 0), 0)
      if (itemCount > 0 && options.leftoverMaterialPolicy !== 'discard') {
        stagingChests.push({
          position,
          action: 'kept',
          reason: options.leftoverMaterialPolicy === 'return_to_storage'
            ? 'leftover_material_return_not_configured'
            : 'leftover_material_policy_keep_at_site',
          itemCount,
          counts: inventory.counts
        })
        continue
      }

      const cleared = await clearBlockForBuilding(context, position, {
        owner: options.owner,
        allowProtectedClearing: true,
        timeoutMs: options.timeoutMs || 15000,
        reservedPositions: this.session.reservedPositions,
        reservedBounds: this.session.reservedBounds,
        preferOutsideReservedBounds: true
      })
      const entry = {
        position,
        action: cleared.ok ? 'removed' : 'failed',
        reason: cleared.reason || null,
        error: cleared.error || null
      }
      stagingChests.push(entry)
      if (!cleared.ok) failures.push(entry)
    }

    return {
      ok: failures.length === 0,
      error: failures[0]?.error || null,
      stagingChests,
      entranceClearance: stagingChests.map(entry => ({
        position: entry.position,
        blocksEntrance: false,
        reason: 'staging_chest_outside_build_bounds'
      })),
      checkedAt: new Date().toISOString()
    }
  }

  async readSingleStagingChestInventory(context, chest, options = {}, reason = 'staging_chest_inventory') {
    const reader = context?.storageSystem?.getStagingInventory || context?.storageSystem?.readStagingInventory
    if (typeof reader !== 'function') return { ok: true, counts: {}, skipped: true, reason: 'staging_inventory_reader_unavailable' }
    const inventory = await reader.call(context.storageSystem, context, {
      runId: this.session?.constructionRunId,
      scanCenters: [chest],
      owner: options.owner,
      reason
    })
    return {
      ok: inventory?.ok !== false,
      counts: inventory?.counts || inventory || {},
      chests: inventory?.chests || []
    }
  }

  evaluateClearPolicy(context, step, options = {}) {
    return evaluateClearPolicy(context, this.session, step, options)
  }

  ensureRestoreStepForClear(clearStep, policy) {
    if (!this.session?.constructionRun || !clearStep?.id || !policy?.restoreRequired) return null
    const expectedStep = policy.expectedStep || findExpectedPlacementStepForClear(this.session, clearStep)
    const blockName = policy.expectedAfter || expectedStep?.blockName
    if (!blockName || isAirName(blockName)) return null
    const restoreStepId = policy.restoreStepId || `step_restore_${clearStep.id.replace(/^step_/, '')}`
    const existing = this.session.steps.find(step => step?.id === restoreStepId)
    if (existing) return existing

    const restoreStep = {
      id: restoreStepId,
      kind: 'place',
      action: 'place_block',
      legacyKind: 'place',
      phase: expectedStep?.phase || policy.restoreBeforePhase || 'frame',
      position: clonePlainObject(clearStep.position),
      target: clonePlainObject(clearStep.position),
      blockName,
      block: { id: blockName, states: clonePlainObject(expectedStep?.states || expectedStep?.orientation || {}) || {} },
      states: clonePlainObject(expectedStep?.states || expectedStep?.orientation || {}) || {},
      orientation: clonePlainObject(expectedStep?.states || expectedStep?.orientation || {}) || {},
      sourceBlockKey: clearStep.sourceBlockKey || expectedStep?.sourceBlockKey || null,
      dependencies: [clearStep.id],
      role: expectedStep?.role || clearStep.role || null,
      materialAlternatives: [...(expectedStep?.materialAlternatives || clearStep.materialAlternatives || [])],
      exactRequired: expectedStep?.exactRequired === true,
      materialPolicySource: expectedStep?.materialPolicySource || clearStep.materialPolicySource || null,
      restoreForStepId: clearStep.id,
      restoreRequiredByClearStepId: clearStep.id,
      restoreStep: true
    }

    this.session.steps.push(restoreStep)
    const run = this.session.constructionRun
    const now = new Date().toISOString()
    const steps = {
      ...(run.steps || {}),
      [restoreStepId]: {
        id: restoreStepId,
        sourceBlockKey: restoreStep.sourceBlockKey,
        action: 'place_block',
        legacyKind: 'place',
        phase: restoreStep.phase,
        lifecyclePhase: normalizeConstructionPhase(restoreStep.phase, restoreStep),
        target: clonePlainObject(restoreStep.position),
        block: clonePlainObject(restoreStep.block),
        originalBlock: expectedStep?.originalBlock ? clonePlainObject(expectedStep.originalBlock) : { id: blockName },
        resolvedBlock: expectedStep?.resolvedBlock ? clonePlainObject(expectedStep.resolvedBlock) : { id: blockName },
        role: restoreStep.role,
        materialAlternatives: [...restoreStep.materialAlternatives],
        exactRequired: restoreStep.exactRequired,
        materialPolicySource: restoreStep.materialPolicySource,
        materialResolution: clonePlainObject(expectedStep?.materialResolution || null),
        dependencies: [...restoreStep.dependencies],
        status: STEP_STATE.PENDING,
        retry: { count: 0, lastError: null },
        restoreForStepId: clearStep.id,
        restoreRequiredByClearStepId: clearStep.id,
        restoreStep: true,
        createdAt: now,
        updatedAt: now
      }
    }
    const updatedRun = {
      ...run,
      steps,
      lifecycle: updateConstructionLifecycle(run.lifecycle, steps, run.currentPhase || 'site_prepare'),
      updatedAt: now
    }
    this.session.constructionRun = updatedRun
    if (this.constructionRunStore) {
      this.markConstructionCheckpointDirty()
      this.flushConstructionRunCheckpoint('restore_step_added', { force: true })
    }
    policy.restoreStepId = restoreStepId
    return restoreStep
  }

  async executeStep(context, step, options = {}) {
    const owner = options.owner
    // Grant the protected-building dig exemption for THIS run only: the run
    // may modify its own (possibly already COMPLETED) building during
    // reconciliation/repair, never any other completed building.
    if (this.session?.constructionRunId) {
      context.activeConstructionRunId = this.session.constructionRunId
    }
    const executionRunStatus = runStatusForExecution(step, options)
    logBuilding(context, `[BUILD_STEP] index=${this.session.currentStepIndex} kind=${step.kind} phase=${step.phase || 'none'} pos=${step.position ? formatPos(step.position) : 'none'} block=${step.blockName || step.current || 'none'}`)

    if (step.kind === 'clear') {
      const policy = this.evaluateClearPolicy(context, step, options)
      if (!policy.allowed) {
        return clearPolicyBlockedResult(policy)
      }
      const restoreStep = policy.restoreRequired ? this.ensureRestoreStepForClear(step, policy) : null
      if (restoreStep) policy.restoreStepId = restoreStep.id
      const largeVerticalTravel = isLargeVerticalTravelStep(context?.bot, step)
      const cleared = await clearBlockForBuilding(context, step.position, {
        owner,
        timeoutMs: options.timeoutMs || 15000,
        verticalMoveTimeoutPerBlockMs: options.verticalMoveTimeoutPerBlockMs,
        maxAdaptiveMoveTimeoutMs: options.maxAdaptiveMoveTimeoutMs,
        adaptiveMoveTimeout: largeVerticalTravel,
        allowScaffolding: largeVerticalTravel,
        canDig: largeVerticalTravel,
        reservedPositions: this.session?.reservedPositions,
        reservedBounds: this.session?.reservedBounds,
        preferOutsideReservedBounds: shouldPreferOutsideReservedBounds(step, this.session?.origin),
        clearStandMoveRange: largeVerticalTravel ? 1.0 : undefined,
        standMoveAttempts: largeVerticalTravel ? 8 : undefined,
        allowNearXZFallback: largeVerticalTravel,
        moveRange: largeVerticalTravel ? 4 : undefined
      })
      if (!cleared.ok) return { ...cleared, clearPolicy: policy }
      const after = blockDetailsAt(context, step.position)
      if (!isAirName(after.name)) {
        return {
          ok: false,
          error: `clear_did_not_reduce_diff:${after.name}`,
          clearPolicy: policy,
          afterClear: after
        }
      }
      return {
        ...cleared,
        clearPolicy: policy,
        clearRecord: clearRecordFromPolicy(policy, after),
        afterClear: after
      }
    }

    if (step.kind === 'foundation_fill' || step.kind === 'scaffold_place' || step.kind === 'place') {
      let currentDetails = blockDetailsAt(context, step.position)
      let current = currentDetails.name
      if (coveredGrassDecaySatisfied(current, step.blockName, step.position, this.session?.worldBlocks) ||
        (buildTargetNameMatches(current, step.blockName, step.position, this.session?.origin, expectedStatesForStep(step)) &&
        stepStateMatches(currentDetails.states, step))) {
        return { ok: true, skipped: true, reason: 'already_correct' }
      }
      if (step.kind === 'place' && isAirName(step.blockName)) return { ok: true, skipped: true, reason: 'air_target' }
      if (isUpperHalfDoorStep(step)) {
        return this.repairUpperDoorStep(context, step, currentDetails, options)
      }
      let lowerDoorPairRepair = null
      if (isLowerHalfDoorStep(step)) {
        const preparedDoorPair = await this.prepareLowerDoorPairForPlacement(context, step, currentDetails, options)
        if (!preparedDoorPair.ok) return preparedDoorPair
        lowerDoorPairRepair = preparedDoorPair.repaired ? preparedDoorPair : null
        if (lowerDoorPairRepair) {
          currentDetails = blockDetailsAt(context, step.position)
          current = currentDetails.name
        }
      }
      const highPlacement = isHighPlacementStep(step, this.session.origin)
      const largeVerticalTravel = isLargeVerticalTravelStep(context?.bot, step)
      const adaptiveRepairClear = highPlacement || largeVerticalTravel
      let clearRecord = null
      if (shouldClearConstructionPlacementTarget(current, step.blockName)) {
        const policy = this.evaluateClearPolicy(context, step, {
          ...options,
          clearMode: 'repair_target',
          currentDetails
        })
        if (!policy.allowed) return clearPolicyBlockedResult(policy)
        const cleared = await clearBlockForBuilding(context, step.position, {
          owner,
          timeoutMs: options.timeoutMs || 15000,
          verticalMoveTimeoutPerBlockMs: options.verticalMoveTimeoutPerBlockMs,
          maxAdaptiveMoveTimeoutMs: options.maxAdaptiveMoveTimeoutMs,
          adaptiveMoveTimeout: adaptiveRepairClear,
          allowScaffolding: adaptiveRepairClear,
          canDig: adaptiveRepairClear,
          allowProtectedClearing: executionRunStatus === STEP_STATE.REPAIR,
          reservedPositions: this.session?.reservedPositions,
          reservedBounds: this.session?.reservedBounds,
          preferOutsideReservedBounds: shouldPreferOutsideReservedBounds(step, this.session?.origin),
          preferHighStand: highPlacement,
          clearStandMoveRange: adaptiveRepairClear ? 1.0 : undefined,
          standMoveAttempts: adaptiveRepairClear ? 8 : undefined,
          allowNearXZFallback: adaptiveRepairClear
        })
        if (!cleared.ok) return cleared
        const after = blockDetailsAt(context, step.position)
        if (!isAirName(after.name)) {
          return { ok: false, error: `clear_did_not_reduce_diff:${after.name}`, clearPolicy: policy, afterClear: after }
        }
        clearRecord = clearRecordFromPolicy(policy, after)
      } else if (current === step.blockName && !stepStateMatches(currentDetails.states, step) && hasExpectedPlacementStates(step)) {
        const policy = this.evaluateClearPolicy(context, step, {
          ...options,
          clearMode: 'state_repair',
          currentDetails
        })
        if (!policy.allowed) return clearPolicyBlockedResult(policy)
        const cleared = await clearBlockForBuilding(context, step.position, {
          owner,
          timeoutMs: options.timeoutMs || 15000,
          verticalMoveTimeoutPerBlockMs: options.verticalMoveTimeoutPerBlockMs,
          maxAdaptiveMoveTimeoutMs: options.maxAdaptiveMoveTimeoutMs,
          adaptiveMoveTimeout: adaptiveRepairClear,
          allowScaffolding: adaptiveRepairClear,
          canDig: adaptiveRepairClear,
          allowProtectedClearing: executionRunStatus === STEP_STATE.STATE_REPAIR,
          reservedPositions: this.session?.reservedPositions,
          reservedBounds: this.session?.reservedBounds,
          preferOutsideReservedBounds: shouldPreferOutsideReservedBounds(step, this.session?.origin),
          preferHighStand: highPlacement,
          clearStandMoveRange: adaptiveRepairClear ? 1.0 : undefined,
          standMoveAttempts: adaptiveRepairClear ? 8 : undefined,
          allowNearXZFallback: adaptiveRepairClear
        })
        if (!cleared.ok) return cleared
        const after = blockDetailsAt(context, step.position)
        if (!isAirName(after.name)) {
          return { ok: false, error: `clear_did_not_reduce_diff:${after.name}`, clearPolicy: policy, afterClear: after }
        }
        clearRecord = clearRecordFromPolicy(policy, after)
      }
      const support = await this.ensureGroundSupportForStep(context, step, options)
      if (!support.ok) return support
      const material = await this.ensureMaterialForStep(context, step, options)
      if (!material.ok) return material
      const scaffoldPlacement = step.kind === 'scaffold_place'
      const highFormalPlacement = highPlacement && !scaffoldPlacement
      const firstPostScaffoldPlacement = step.kind === 'place' &&
        (this.session?.scaffoldBlocks || 0) > 0 &&
        (this.session?.placedBlocks || 0) === 0
      const verticalAccess = isVerticalAccessBlockName(step.blockName)
      const belowTargetVerticalRecovery = !scaffoldPlacement && !highPlacement && !largeVerticalTravel &&
        isBelowTargetVerticalRecoveryStep(context?.bot, step)
      const baseLayerSurfacePreservation = !scaffoldPlacement && !highPlacement && !largeVerticalTravel &&
        isBaseLayerSurfacePreservationStep(context?.bot, step, this.session?.origin)
      const resumedBaseLayerSurface = this.session?.resumedConstructionRun === true &&
        hasNearbyCompletedFormalSurface(
          context,
          step,
          this.session?.reservedPositions
        )
      const baseLayerSurfaceRepair = baseLayerSurfacePreservation &&
        (isRepairExecutionStatus(executionRunStatus) || resumedBaseLayerSurface)
      const baseLayerSurfaceAccessPlan = baseLayerSurfaceRepair &&
        requiresHighPlacementAccessPlan(context?.bot, step)
      // Ground-supported plants are placed one block above the formal terrain
      // surface. Once that surface is filled, reaching the plant from outside
      // requires walking across physically-air formal cells at the plant Y.
      const groundSurfaceDecorationRecovery = !scaffoldPlacement &&
        requiresGroundSupportBlockName(step.blockName)
      const placementSurfaceGuard = belowTargetVerticalRecovery ||
        baseLayerSurfacePreservation ||
        groundSurfaceDecorationRecovery
      const verticalPlacementRecovery = highPlacement || largeVerticalTravel ||
        belowTargetVerticalRecovery ||
        groundSurfaceDecorationRecovery ||
        baseLayerSurfaceRepair
      const adaptiveMovement = scaffoldPlacement || firstPostScaffoldPlacement || verticalPlacementRecovery
      const canDigForVerticalPlacement = firstPostScaffoldPlacement ||
        (largeVerticalTravel && isTerrainFillStep(step))
      const placeOptions = {
        owner,
        shouldContinue: options.shouldContinue,
        timeoutMs: options.timeoutMs || 15000,
        verticalMoveTimeoutPerBlockMs: options.verticalMoveTimeoutPerBlockMs,
        maxAdaptiveMoveTimeoutMs: options.maxAdaptiveMoveTimeoutMs,
        reservedPositions: this.session?.reservedPositions,
        temporaryReferenceAllowedPositions: temporaryReferenceAllowedPositionsForStep(this.session, step),
        reservedBounds: this.session?.reservedBounds,
        preferOutsideReservedBounds: shouldPreferOutsideReservedBounds(step, this.session?.origin),
        preferHighStand: verticalPlacementRecovery && !scaffoldPlacement,
        allowReservedAirStand: placementSurfaceGuard || highFormalPlacement,
        trackVerticalAccessScaffolds: belowTargetVerticalRecovery || baseLayerSurfaceAccessPlan,
        minimumPlacementStandY: placementSurfaceGuard
          ? minimumSurfacePlacementStandY(context?.bot, step, {
            forceAboveTarget: baseLayerSurfaceRepair
          })
          : (highFormalPlacement ? minimumHighPlacementStandY(step) : undefined),
        planExistingPlacementStandAccess: belowTargetVerticalRecovery ||
          baseLayerSurfaceAccessPlan ||
          (highFormalPlacement && requiresHighPlacementAccessPlan(context?.bot, step)),
        allowCurrentReachForHighTargets: scaffoldPlacement || highPlacement,
        allowCurrentReferenceReachForHighTargets: scaffoldPlacement || highPlacement,
        allowScaffolding: scaffoldPlacement || firstPostScaffoldPlacement || verticalPlacementRecovery,
        scaffoldOwnerTask: owner,
        scaffoldOwnerStep: step.id || null,
        canDig: canDigForVerticalPlacement,
        adaptiveMoveTimeout: adaptiveMovement,
        moveRange: (scaffoldPlacement || verticalPlacementRecovery) ? 4 : undefined,
        forceSafeApproach: step.kind === 'foundation_fill' || scaffoldPlacement || verticalAccess ||
          verticalPlacementRecovery || baseLayerSurfacePreservation,
        placementAttempts: (verticalAccess || verticalPlacementRecovery || baseLayerSurfacePreservation)
          ? 4
          : undefined,
        standMoveAttempts: largeVerticalTravel ? 8 : (verticalPlacementRecovery ? 6 : undefined),
        allowNearXZFallback: verticalPlacementRecovery,
        repairObstructedTarget: true,
        allowProtectedTargetRepair: isRepairExecutionStatus(executionRunStatus),
        requireStateConfirmation: hasExpectedPlacementStates(step),
        blockStates: expectedStatesForStep(step),
        // 后勤 16（决策 #78）：序列层可以点名「这一步必须点哪一格的哪一面」，
        // 以及「那一格得先垫一块临时砖」——漏斗的朝向只由被点的那一格决定，
        // 挑参照那一步按「哪块好点」排序，正确的那一格反而排在最后。
        // 只透传：没有声明的步这里一个字段都不多（tests/clicked-face-placement.test.js）。
        ...clickedFacePlacementOptions(step)
      }
      const finalizePlaced = result => this.finalizeLowerDoorPairPlacement(
        context,
        step,
        attachClearRecordToStepResult(result, clearRecord),
        lowerDoorPairRepair
      )
      let placed = await placeBlock(context, step.position, step.blockName, placeOptions)
      if (placed.ok) return finalizePlaced(placed)
      if (isOptionalDecorationPlacementFailure(step, placed)) {
        return optionalDecorationSkipResult(context, step, placed)
      }
      if (isTemporaryReferenceMaterialError(placed.error)) {
        const referenceMaterial = selectTemporaryReferenceMaterial(context, placeOptions)
        const refilled = await this.ensureMaterialItem(context, referenceMaterial, options, 1)
        if (refilled.ok) {
          logBuilding(context, `[BUILD_TEMP_REFERENCE_REFILL_RETRY] item=${referenceMaterial} step=${this.session.currentStepIndex} reason=${placed.error}`)
          placed = await placeBlock(context, step.position, step.blockName, placeOptions)
          if (placed.ok) return finalizePlaced(placed)
          if (isOptionalDecorationPlacementFailure(step, placed)) {
            return optionalDecorationSkipResult(context, step, placed)
          }
        } else {
          logBuilding(context, `[BUILD_TEMP_REFERENCE_REFILL_FAILED] item=${referenceMaterial} step=${this.session.currentStepIndex} error=${refilled.error || 'unknown'}`)
        }
      }
      if (isPlacementSupportFailure(placed.error)) {
        logBuilding(context, `[BUILD_PLANNED_REFERENCE_REPAIR_TRIGGER] reason=${placed.error || 'unknown'} target=${formatPos(step.position)} block=${step.blockName}`)
        const plannedReference = await this.ensurePlannedReferenceForStep(context, step, options)
        if (plannedReference.ok && plannedReference.repaired) {
          placed = await placeBlock(context, step.position, step.blockName, placeOptions)
          if (placed.ok) return finalizePlaced(placed)
          if (isOptionalDecorationPlacementFailure(step, placed)) {
            return optionalDecorationSkipResult(context, step, placed)
          }
        }
      }
      const maxConsumedItemRefillRetries = Math.max(
        0,
        Number(options.consumedItemRefillRetries ?? this.options.consumedItemRefillRetries ?? 2) || 0
      )
      let consumedItemRefillRetries = 0
      while (isConsumedPlacementMaterialError(placed.error) &&
        consumedItemRefillRetries < maxConsumedItemRefillRetries) {
        const refilled = await this.ensureMaterialForStep(context, step, options)
        if (!refilled.ok) {
          return {
            ...refilled,
            recoveryError: placed.error,
            consumedItemRefillRetries
          }
        }
        consumedItemRefillRetries += 1
        logBuilding(context, `[BUILD_STAGED_REFILL_RETRY] item=${itemNamesForStep(step).join(',')} step=${this.session.currentStepIndex} attempt=${consumedItemRefillRetries}/${maxConsumedItemRefillRetries} reason=placement_consumed_item`)
        placed = await placeBlock(context, step.position, step.blockName, placeOptions)
        if (placed.ok) return finalizePlaced(placed)
        if (isOptionalDecorationPlacementFailure(step, placed)) {
          return optionalDecorationSkipResult(context, step, placed)
        }
      }
      if (isConsumedPlacementMaterialError(placed.error)) {
        return {
          ok: false,
          error: `placement_material_refill_retry_limit:${itemNamesForStep(step).join(',')}:${placed.error}`,
          lastPlacementError: placed.error,
          consumedItemRefillRetries
        }
      }
      return placed
    }

    if (step.kind === 'scaffold_remove') {
      const policy = this.evaluateClearPolicy(context, step, options)
      if (!policy.allowed) return clearPolicyBlockedResult(policy)
      const highCleanup = isHighPlacementStep(step, this.session.origin)
      const largeVerticalTravel = isLargeVerticalTravelStep(context?.bot, step)
      const adaptiveCleanup = highCleanup || largeVerticalTravel
      const cleared = await clearBlockForBuilding(context, step.position, {
        owner,
        shouldContinue: options.shouldContinue,
        timeoutMs: options.timeoutMs || 15000,
        verticalMoveTimeoutPerBlockMs: options.scaffoldCleanupVerticalMoveTimeoutPerBlockMs ||
          options.verticalMoveTimeoutPerBlockMs ||
          4500,
        maxAdaptiveMoveTimeoutMs: options.scaffoldCleanupMaxAdaptiveMoveTimeoutMs ||
          options.maxAdaptiveMoveTimeoutMs ||
          120000,
        adaptiveMoveTimeout: adaptiveCleanup,
        allowScaffolding: adaptiveCleanup,
        // Cleanup movement may build a temporary access route, but the
        // target scaffold is cleared explicitly below. Letting pathfinder dig
        // its route can silently punch holes through formal blueprint blocks.
        canDig: false,
        reservedPositions: this.session?.reservedPositions,
        reservedBounds: this.session?.reservedBounds,
        preferOutsideReservedBounds: true,
        preferHighStand: highCleanup,
        clearStandMoveRange: adaptiveCleanup ? 1.0 : undefined,
        standMoveAttempts: adaptiveCleanup ? 8 : undefined,
        allowNearXZFallback: adaptiveCleanup,
        moveRange: adaptiveCleanup ? 4 : undefined,
        temporary: true
      })
      if (!cleared.ok) return { ...cleared, clearPolicy: policy }
      const after = blockDetailsAt(context, step.position)
      if (!isAirName(after.name)) {
        return { ok: false, error: `clear_did_not_reduce_diff:${after.name}`, clearPolicy: policy, afterClear: after }
      }
      return {
        ...cleared,
        clearPolicy: policy,
        clearRecord: clearRecordFromPolicy(policy, after),
        afterClear: after
      }
    }

    if (step.kind === 'walkability_validate') {
      if (isFaithfulCommunityImport(this.session.blueprint, this.session.selectedBlueprint)) {
        const temporaryCleanup = await cleanupUnexpectedTemporaryBuildVolumeBlocks(
          context,
          this.session,
          {
            ...options,
            faithfulValidator: this.faithfulValidator
          }
        )
        logBuilding(
          context,
          `[BUILD_UNTRACKED_TEMPORARY_CLEANUP] ok=${temporaryCleanup.ok === true} ` +
          `removed=${temporaryCleanup.removed?.length || 0} remaining=${temporaryCleanup.remaining?.length || 0} ` +
          `passes=${temporaryCleanup.passes || 0} tolerated=${temporaryCleanup.toleratedRemaining === true} ` +
          `error=${temporaryCleanup.error || 'none'}`
        )
        if (!temporaryCleanup.ok) {
          return {
            ok: false,
            error: `faithful_temporary_cleanup_failed:${temporaryCleanup.error || 'unknown'}`,
            temporaryCleanup
          }
        }
        const actualBlueprint = actualWorldBlueprintFromSession(context, this.session)
        const faithfulWorld = this.faithfulValidator.compareExpectedActual(
          this.session.resolvedBlueprint || this.session.blueprint,
          actualBlueprint,
          {
            blueprintName: this.session.blueprintName,
            selected: this.session.selectedBlueprint,
            requiredStories: this.session.selectedBlueprint?.requiredStories
          }
        )
        this.session.faithfulWorldValidation = faithfulWorld
        this.session.habitabilityFinalGate = faithfulWorld
        setWorldDiffPart(this.session, 'faithful_world', worldDiffFromFaithfulComparison(faithfulWorld))
        logBuilding(context, `[BUILD_FAITHFUL_WORLD_GATE] blueprint=${this.session.blueprintName} ok=${faithfulWorld.ok === true} metrics=${JSON.stringify(faithfulWorld.metrics || null)} failures=${JSON.stringify(faithfulWorld.failures || [])}`)
        logBuilding(context, `[BUILD_HABITABILITY_GATE] stage=final blueprint=${this.session.blueprintName} ok=${faithfulWorld.ok === true} skipped=false metrics=${JSON.stringify(faithfulWorld.metrics?.livability || null)} failures=${JSON.stringify(faithfulWorld.failures || [])}`)
        if (!faithfulWorld.ok) return { ok: false, error: `faithful_world_validation_failed:${faithfulWorld.failures[0] || 'unknown'}` }
        return { ok: true, walkability: faithfulWorld, hardGate: faithfulWorld, worldDiffResult: this.session.worldDiffResult }
      }

      const validation = this.walkabilityChecker.checkWorld(context, this.session.blueprint, {
        origin: this.session.origin,
        layoutPlan: this.session.layoutPlan,
        interiorPlan: this.session.interiorPlan
      })
      setWorldDiffPart(this.session, 'walkability', worldDiffFromWalkability(validation))
      logBuilding(context, `[BUILD_WALKABILITY_GATE] stage=final blueprint=${this.session.blueprintName} ok=${validation.ok === true} summary=${JSON.stringify(validation.summary || null)} failures=${JSON.stringify(validation.failures || [])}`)
      if (!validation.ok) return { ok: false, error: `walkability_failed:${validation.failures[0] || 'unknown'}` }
      const actualBlueprint = actualWorldBlueprintFromSession(context, this.session)
      const hardGate = this.session.habitabilityRequired
        ? this.hardGate.evaluateBlueprint(actualBlueprint, {
            blueprintName: this.session.blueprintName,
            requiredStories: this.session.aestheticPlan?.community?.samples?.[0]?.requiredStories
          })
        : { ok: true, skipped: true, reason: 'non_architectural_fixture' }
      this.session.habitabilityFinalGate = hardGate
      logBuilding(context, `[BUILD_HABITABILITY_GATE] stage=final blueprint=${this.session.blueprintName} ok=${hardGate.ok === true} skipped=${hardGate.skipped === true} metrics=${JSON.stringify(hardGate.metrics || null)} failures=${JSON.stringify(hardGate.failures || [])}`)
      if (!hardGate.ok) return { ok: false, error: `habitability_failed:${hardGate.failures[0] || 'unknown'}` }
      return { ok: true, walkability: validation, hardGate, worldDiffResult: this.session.worldDiffResult }
    }

    if (step.kind === 'validate') {
      let diffValidation = this.worldDiffValidator.validateBuild(
        context,
        this.session.worldBlocks,
        this.session.orderPlan.steps.filter(s => s.kind === 'scaffold_remove'),
        {
          pendingRestores: pendingRestoreRecords(this.session.constructionRun),
          origin: this.session.origin
        }
      )
      let validation = diffValidation.legacy
      setWorldDiffPart(this.session, 'legacy_validation', diffValidation.diff)
      if (!validation.ok) {
        const repair = await this.repairValidationFailures(context, validation, options)
        if (repair.repairs.length > 0) {
          this.session.validationRepairs = repair.repairs
          logBuilding(context, `[BUILD_VALIDATION_REPAIR] attempted=${repair.repairs.length} ok=${repair.ok === true} repairs=${JSON.stringify(repair.repairs)}`)
          if (!repair.ok) return { ok: false, error: repair.error || `validation_failed:${validation.failures[0]?.expected || 'unknown'}` }
          diffValidation = this.worldDiffValidator.validateBuild(
            context,
            this.session.worldBlocks,
            this.session.orderPlan.steps.filter(s => s.kind === 'scaffold_remove'),
            {
              pendingRestores: pendingRestoreRecords(this.session.constructionRun),
              origin: this.session.origin
            }
          )
          validation = diffValidation.legacy
          setWorldDiffPart(this.session, 'legacy_validation', diffValidation.diff)
        }
      }
      logBuilding(context, `[BUILD_VALIDATION] ok=${validation.ok} failures=${JSON.stringify(validation.failures)}`)
      if (!validation.ok) return { ok: false, error: `validation_failed:${validation.failures[0]?.expected || 'unknown'}` }
      return { ok: true, validation, worldDiffResult: this.session.worldDiffResult }
    }

    return { ok: false, error: `unknown_build_step:${step.kind}` }
  }

  async prepareLowerDoorPairForPlacement(context, step, currentDetails, options = {}) {
    const upperStep = findUpperDoorStepForLower(this.session, step)
    if (!upperStep) return { ok: true, skipped: true, reason: 'upper_door_step_missing' }
    const upperPosition = upperDoorPositionForLower(step)
    const upperActual = blockDetailsAt(context, upperPosition)
    if (isAirName(upperActual.name)) {
      return { ok: true, skipped: true, reason: 'upper_door_space_clear', upperStep, upperPosition }
    }
    if (upperActual.name !== step.blockName || !isUpperHalfDoorActual(upperActual)) {
      return {
        ok: false,
        error: `lower_door_upper_obstructed:${upperActual.name || 'unknown'}`,
        upperPosition,
        upperAfter: upperActual
      }
    }

    const lowerIsAlreadyCorrect = currentDetails?.name === step.blockName && stepStateMatches(currentDetails.states, step)
    if (lowerIsAlreadyCorrect && stepStateMatches(upperActual.states, upperStep)) {
      return { ok: true, skipped: true, reason: 'door_pair_already_correct', upperStep, upperPosition }
    }

    const policy = this.evaluateClearPolicy(context, upperStep, {
      ...options,
      clearMode: 'state_repair',
      currentDetails: upperActual
    })
    if (!policy.allowed) return clearPolicyBlockedResult(policy)

    logBuilding(context, `[BUILD_DOOR_PAIR_REPAIR] lower=${formatPos(step.position)} upper=${formatPos(upperPosition)} block=${step.blockName}`)
    const cleared = await clearBlockForBuilding(context, upperPosition, {
      owner: options.owner,
      timeoutMs: options.timeoutMs || 15000,
      allowProtectedClearing: upperStep.runStatus === STEP_STATE.REPAIR ||
        upperStep.runStatus === STEP_STATE.STATE_REPAIR ||
        options.doorUpperRepair === true,
      reservedPositions: this.session?.reservedPositions,
      reservedBounds: this.session?.reservedBounds,
      preferOutsideReservedBounds: shouldPreferOutsideReservedBounds(upperStep, this.session?.origin)
    })
    if (!cleared.ok) return cleared
    const afterClear = blockDetailsAt(context, upperPosition)
    if (!isAirName(afterClear.name)) {
      return {
        ok: false,
        error: `upper_door_clear_did_not_reduce_diff:${afterClear.name || 'unknown'}`,
        upperPosition,
        afterClear
      }
    }
    return {
      ok: true,
      repaired: true,
      reason: 'upper_door_cleared_for_lower_repair',
      upperStep,
      upperPosition,
      upperClearRecord: clearRecordFromPolicy(policy, afterClear)
    }
  }

  finalizeLowerDoorPairPlacement(context, step, result, lowerDoorPairRepair = null) {
    if (!result.ok || !isLowerHalfDoorStep(step)) return result
    const upperStep = lowerDoorPairRepair?.upperStep || findUpperDoorStepForLower(this.session, step)
    if (!upperStep) return result
    const upperAfter = blockDetailsAt(context, upperStep.position)
    if (upperAfter.name !== upperStep.blockName || !stepStateMatches(upperAfter.states, upperStep)) {
      return {
        ...result,
        ok: false,
        error: `lower_door_upper_unstable:${upperAfter.name || 'air'}`,
        upperPosition: upperStep.position,
        upperAfter
      }
    }

    const upperDetails = lowerDoorPairRepair?.upperClearRecord
      ? { clearRecord: lowerDoorPairRepair.upperClearRecord }
      : {}
    this.updateConstructionStep(upperStep, STEP_STATE.PLACED, upperDetails)
    this.updateConstructionStep(upperStep, STEP_STATE.VERIFIED, upperDetails)
    return {
      ...result,
      doorPairRepair: {
        upperStepId: upperStep.id || null,
        upperCleared: lowerDoorPairRepair?.repaired === true
      }
    }
  }

  async repairUpperDoorStep(context, step, currentDetails, options = {}) {
    const owner = options.owner
    const executionRunStatus = runStatusForExecution(step, options)
    const lowerPosition = lowerDoorPositionForUpper(step)
    const lowerStep = findLowerDoorStepForUpper(this.session, step)
    if (!lowerStep) {
      return {
        ok: false,
        error: 'upper_door_lower_step_missing',
        lowerPosition
      }
    }

    if (currentDetails?.name && !isAirName(currentDetails.name) && currentDetails.name !== step.blockName) {
      const policy = this.evaluateClearPolicy(context, step, {
        ...options,
        clearMode: 'repair_target',
        currentDetails
      })
      if (!policy.allowed) return clearPolicyBlockedResult(policy)
      const cleared = await clearBlockForBuilding(context, step.position, {
        owner,
        timeoutMs: options.timeoutMs || 15000,
        allowProtectedClearing: executionRunStatus === STEP_STATE.REPAIR,
        reservedPositions: this.session?.reservedPositions,
        reservedBounds: this.session?.reservedBounds,
        preferOutsideReservedBounds: shouldPreferOutsideReservedBounds(step, this.session?.origin)
      })
      if (!cleared.ok) return cleared
      const afterClear = blockDetailsAt(context, step.position)
      if (!isAirName(afterClear.name)) {
        return {
          ok: false,
          error: `clear_did_not_reduce_diff:${afterClear.name}`,
          clearPolicy: policy,
          afterClear
        }
      }
    }

    const lowerActual = blockDetailsAt(context, lowerPosition)
    const previousRunStatus = lowerStep.runStatus
    this.updateConstructionStep(lowerStep, STEP_STATE.READY)
    this.updateConstructionStep(lowerStep, STEP_STATE.EXECUTING)
    lowerStep.runStatus = lowerActual.name === lowerStep.blockName
      ? STEP_STATE.STATE_REPAIR
      : (isAirName(lowerActual.name) ? STEP_STATE.PENDING : STEP_STATE.REPAIR)
    const repaired = await this.executeStep(context, lowerStep, {
      ...options,
      doorUpperRepair: true
    })
    if (!repaired.ok) {
      lowerStep.runStatus = previousRunStatus
      this.updateConstructionStep(lowerStep, isRetryableBuildError(repaired.error) ? STEP_STATE.RETRYABLE_FAILED : STEP_STATE.TERMINAL_FAILED, {
        retryError: repaired.error
      })
      return {
        ok: false,
        error: `upper_door_lower_repair_failed:${repaired.error || 'unknown'}`,
        lowerPosition,
        expectedSupport: lowerStep.blockName
      }
    }
    this.updateConstructionStep(lowerStep, STEP_STATE.PLACED)
    this.updateConstructionStep(lowerStep, STEP_STATE.VERIFIED)

    const upperAfter = blockDetailsAt(context, step.position)
    if (upperAfter.name === step.blockName && stepStateMatches(upperAfter.states, step)) {
      return {
        ok: true,
        repaired: true,
        reason: 'upper_door_repaired_via_lower',
        lowerPosition,
        lowerStepId: lowerStep.id
      }
    }

    return {
      ok: false,
      error: `upper_door_unstable:${upperAfter.name || 'air'}`,
      lowerPosition,
      expectedSupport: lowerStep.blockName,
      upperAfter
    }
  }

  async ensureGroundSupportForStep(context, step, options = {}) {
    if (!step || step.kind !== 'place' || !requiresGroundSupportBlockName(step.blockName)) {
      return { ok: true, skipped: true, reason: 'ground_support_not_required' }
    }
    const supportPosition = { x: step.position.x, y: step.position.y - 1, z: step.position.z }
    const actual = blockDetailsAt(context, supportPosition)
    if (isUpperHalfDoubleHeightGroundPlantStep(step) && isMatchingLowerHalfDoubleHeightGroundPlant(actual, step)) {
      return { ok: true, skipped: true, reason: 'ground_support_upper_half_double_plant', supportPosition }
    }
    if (isGroundPlantSupportName(actual.name)) {
      return { ok: true, skipped: true, reason: 'ground_support_present', supportPosition }
    }

    const supportStep = findPlacementStepAt(this.session, supportPosition)
    if (!supportStep || !supportStep.blockName || isAirName(supportStep.blockName)) {
      return {
        ok: false,
        error: `ground_support_missing:${actual.name || 'air'}`,
        supportPosition,
        expectedSupport: supportStep?.blockName || null
      }
    }

    logBuilding(context, `[BUILD_GROUND_SUPPORT_REPAIR] target=${formatPos(step.position)} block=${step.blockName} support=${formatPos(supportPosition)} supportBlock=${supportStep.blockName} actual=${actual.name}`)
    this.updateConstructionStep(supportStep, STEP_STATE.READY)
    this.updateConstructionStep(supportStep, STEP_STATE.EXECUTING)
    supportStep.runStatus = STEP_STATE.REPAIR
    const repaired = await this.executeStep(context, supportStep, {
      ...options,
      groundSupportRepair: true
    })
    if (!repaired.ok) {
      this.updateConstructionStep(supportStep, isRetryableBuildError(repaired.error) ? STEP_STATE.RETRYABLE_FAILED : STEP_STATE.TERMINAL_FAILED, {
        retryError: repaired.error
      })
      return {
        ok: false,
        error: `ground_support_repair_failed:${repaired.error || 'unknown'}`,
        supportPosition,
        expectedSupport: supportStep.blockName
      }
    }
    this.updateConstructionStep(supportStep, STEP_STATE.PLACED)
    this.updateConstructionStep(supportStep, STEP_STATE.VERIFIED)

    const after = blockDetailsAt(context, supportPosition)
    if (!isGroundPlantSupportName(after.name)) {
      return {
        ok: false,
        error: `ground_support_unstable:${after.name || 'air'}`,
        supportPosition,
        expectedSupport: supportStep.blockName
      }
    }
    return { ok: true, repaired: true, supportPosition, supportBlock: after.name }
  }

  async ensurePlannedReferenceForStep(context, step, options = {}) {
    if (!step?.position || step.kind !== 'place') return { ok: false, error: 'planned_reference_not_applicable' }
    const depth = Number(options.plannedReferenceRepairDepth || 0)
    if (depth >= 2) return { ok: false, error: 'planned_reference_depth_exceeded' }
    const candidates = findPlannedReferenceSteps(this.session, step)
    if (!candidates.length) return { ok: false, error: 'planned_reference_missing' }

    let lastError = null
    for (const candidate of candidates) {
      const actual = blockDetailsAt(context, candidate.position)
      if (actual.name === candidate.blockName && stepStateMatches(actual.states, candidate)) {
        return { ok: true, repaired: true, alreadyPresent: true, referenceStep: candidate }
      }
      logBuilding(context, `[BUILD_PLANNED_REFERENCE_REPAIR] target=${formatPos(step.position)} block=${step.blockName} reference=${formatPos(candidate.position)} referenceBlock=${candidate.blockName}`)
      this.updateConstructionStep(candidate, STEP_STATE.READY)
      this.updateConstructionStep(candidate, STEP_STATE.EXECUTING)
      const previousRunStatus = candidate.runStatus
      candidate.runStatus = actual && !isAirName(actual.name) && actual.name !== candidate.blockName
        ? STEP_STATE.REPAIR
        : (candidate.runStatus || STEP_STATE.PENDING)
      const repaired = await this.executeStep(context, candidate, {
        ...options,
        plannedReferenceRepairDepth: depth + 1
      })
      candidate.runStatus = previousRunStatus
      if (!repaired.ok) {
        lastError = repaired.error || 'planned_reference_repair_failed'
        this.updateConstructionStep(candidate, isRetryableBuildError(lastError) ? STEP_STATE.RETRYABLE_FAILED : STEP_STATE.TERMINAL_FAILED, {
          retryError: lastError
        })
        continue
      }
      const after = blockDetailsAt(context, candidate.position)
      if (after.name !== candidate.blockName || !stepStateMatches(after.states, candidate)) {
        lastError = `planned_reference_unstable:${after.name || 'air'}`
        this.updateConstructionStep(candidate, isRetryableBuildError(lastError) ? STEP_STATE.RETRYABLE_FAILED : STEP_STATE.TERMINAL_FAILED, {
          retryError: lastError
        })
        continue
      }
      this.updateConstructionStep(candidate, STEP_STATE.PLACED)
      this.updateConstructionStep(candidate, STEP_STATE.VERIFIED)
      if (!isPlannedPlacementReferenceBlockName(candidate.blockName, candidate.states || candidate.orientation)) {
        lastError = `planned_reference_not_supporting:${candidate.blockName}`
        continue
      }
      return { ok: true, repaired: true, referenceStep: candidate }
    }

    return { ok: false, error: lastError || 'planned_reference_repair_failed' }
  }

  async ensureMaterialForStep(context, step, options = {}) {
    if (!step?.blockName || isAirName(step.blockName)) return { ok: true }
    if (isBedHeadBlockState(step)) return { ok: true, skipped: 'bed_head_created_by_foot' }
    const requirements = itemRequirementsForStep(step)
    const itemNames = Object.keys(requirements)
    if (!itemNames.length) return { ok: false, error: `missing_material_item:${step.blockName}` }
    for (const itemName of itemNames) {
      const ensured = await this.ensureMaterialItem(context, itemName, options, requirements[itemName])
      if (!ensured.ok) return ensured
    }
    return { ok: true }
  }

  async ensureMaterialItem(context, itemName, options = {}, requiredCount = 1) {
    const neededCount = Math.max(1, Number(requiredCount) || 1)
    if (inventoryItemCount(context, itemName) >= neededCount) return { ok: true }
    const storage = context.storageSystem
    if (!storage || typeof storage.takeItems !== 'function' || options.allowStorageRefill === false) {
      return { ok: false, error: `missing_material:${itemName}` }
    }

    const currentStep = this.session?.steps?.[this.session.currentStepIndex] || null
    if (currentStep) {
      const batched = await this.ensureInventoryBatchReady(context, currentStep, {
        ...options,
        forceRestockReason: 'current_step_material_missing'
      })
      if (batched.ok && inventoryItemCount(context, itemName) >= neededCount) return { ok: true }
    }

    const before = inventoryItemCount(context, itemName)
    if (before <= 0 && liveInventoryEmptySlotCount(context) <= 0) {
      const released = await this.releaseInventorySlotForStagedRefill(context, itemName, options)
      if (!released.ok) return { ok: false, error: `staged_material_inventory_full:${itemName}:${released.error}` }
    }

    const missingForStep = Math.max(1, neededCount - before)
    const remaining = Math.max(this.remainingStepItemCount(itemName), missingForStep)
    const count = Math.max(missingForStep, Math.min(remaining || missingForStep, itemStackSizeForContext(context, itemName)))
    logBuilding(context, `[BUILD_STAGED_REFILL] item=${itemName} requested=${count} step=${this.session.currentStepIndex}`)
    let result = await this.takeStagedMaterialFromStorage(context, itemName, count, options)
    const after = inventoryItemCount(context, itemName)
    const moved = movedItemCount(result, itemName, after - before)
    if (result.ok && after >= neededCount) {
      logBuilding(context, `[BUILD_STAGED_REFILL_OK] item=${itemName} moved=${moved} available=${after}`)
      return { ok: true }
    }

    if (before <= 0 && after <= 0 && liveInventoryEmptySlotCount(context) <= 0) {
      const released = await this.releaseInventorySlotForStagedRefill(context, itemName, options)
      if (released.ok) {
        result = await this.takeStagedMaterialFromStorage(context, itemName, count, options)
        const retryAfter = inventoryItemCount(context, itemName)
        const retryMoved = movedItemCount(result, itemName, retryAfter - before)
        if (result.ok && retryAfter >= neededCount) {
          logBuilding(context, `[BUILD_STAGED_REFILL_OK] item=${itemName} moved=${retryMoved} available=${retryAfter}`)
          return { ok: true }
        }
      } else {
        logBuilding(context, `[BUILD_STAGED_REFILL_SLOT_RELEASE_FAILED] needed=${itemName} error=${released.error}`)
      }
    }

    const error = result.error || (moved <= 0 ? 'storage_refill_moved_zero' : 'storage_refill_failed')
    logBuilding(context, `[BUILD_STAGED_REFILL_FAILED] item=${itemName} error=${error}`)
    return { ok: false, error: `staged_material_missing:${itemName}:${error}` }
  }

  async takeStagedMaterialFromStorage(context, itemName, count, options = {}) {
    const primaryCenters = materialStorageScanCentersForTier(this.session, 'primary')
    const secondaryCenters = materialStorageScanCentersForTier(this.session, 'secondary')
    const primary = await this.takeMaterialFromCenters(context, itemName, count, primaryCenters, {
      ...options,
      reason: 'building_staged_material_refill_primary'
    })
    if (primary.ok || !secondaryCenters.length) return primary.result || { ok: false, error: primary.error || 'storage_refill_failed' }

    const remaining = Math.max(0, count - primary.moved)
    const secondary = await this.takeMaterialFromCenters(context, itemName, remaining, secondaryCenters, {
      ...options,
      reason: 'building_staged_material_refill_secondary_shortage'
    })
    if (secondary.ok) {
      return {
        ...secondary.result,
        openSummary: mergeOpenSummaries(primary.result?.openSummary, secondary.result?.openSummary)
      }
    }
    return secondary.result || primary.result || { ok: false, error: secondary.error || primary.error || 'storage_refill_failed' }
  }

  async releaseInventorySlotForStagedRefill(context, neededItemName, options = {}) {
    const storage = context.storageSystem
    if (!storage || typeof storage.storeItems !== 'function') {
      return { ok: false, error: 'storage_deposit_unavailable' }
    }
    const selected = selectMaterialRefillSlotReleaseStack(context, this.session, neededItemName)
    if (!selected) return { ok: false, error: 'no_releasable_inventory_stack' }

    const emptySlotsBefore = liveInventoryEmptySlotCount(context)
    logBuilding(context, `[BUILD_STAGED_REFILL_SLOT_RELEASE] needed=${neededItemName} item=${selected.itemName} count=${selected.count} emptySlotsBefore=${emptySlotsBefore}`)
    const stored = await storage.storeItems(context, {
      itemName: selected.itemName,
      count: selected.count,
      owner: options.owner,
      query: selected.itemName,
      radius: materialStorageSearchRadius(this.options, options),
      scanCenters: materialStorageScanCentersForTier(this.session, 'primary'),
      scanOnlyProvidedCenters: true,
      exactScanCenters: true,
      skipUtilitySearch: true,
      skipMemorySearch: true,
      canDig: false,
      reason: 'building_staged_material_slot_release'
    })
    if (!stored.ok) return { ok: false, error: stored.error || 'slot_release_deposit_failed' }
    return { ok: true, released: selected, storedItems: stored.storedItems || [] }
  }

  remainingStepItemCount(itemName) {
    if (!this.session?.steps) return 1
    let count = 0
    for (let index = this.session.currentStepIndex; index < this.session.steps.length; index++) {
      const step = this.session.steps[index]
      if (!['foundation_fill', 'scaffold_place', 'place'].includes(step?.kind)) continue
      count += itemRequirementCountForStep(step, itemName)
    }
    return count
  }

  async repairValidationFailures(context, validation, options = {}) {
    const repairable = (validation.failures || [])
      .filter(failure => failure && failure.expected && failure.expected !== 'air' && isAirName(failure.actual) && !failure.temporary)
    const limit = Math.max(0, Number(this.options.validationRepairLimit ?? 6))
    const repairs = []
    if (!repairable.length) return { ok: true, repairs }
    if (repairable.length > limit) {
      return {
        ok: false,
        repairs,
        error: `validation_repair_limit_exceeded:${repairable.length}`
      }
    }

    for (const failure of repairable) {
      const source = findWorldBlock(this.session.worldBlocks, failure.position, failure.expected)
      if (!source) {
        repairs.push({ position: failure.position, expected: failure.expected, ok: false, error: 'repair_source_not_found' })
        return { ok: false, repairs, error: 'validation_repair_source_not_found' }
      }
      const result = await placeBlock(context, source.position, source.type, {
        owner: options.owner,
        timeoutMs: options.timeoutMs || 15000,
        reservedPositions: this.session?.reservedPositions,
        reservedBounds: this.session?.reservedBounds,
        preferOutsideReservedBounds: false,
        forceSafeApproach: true,
        placementAttempts: 4,
        requireServerConfirmation: true,
        stableConfirmDelayMs: options.validationRepairConfirmDelayMs ?? 300,
        blockStates: source.states || source.orientation || null
      })
      repairs.push({
        position: source.position,
        expected: source.type,
        ok: result.ok === true,
        reason: result.reason || null,
        error: result.error || null
      })
      if (!result.ok) return { ok: false, repairs, error: `validation_repair_failed:${result.error || source.type}` }
    }

    return { ok: true, repairs }
  }

  applyStepResult(step) {
    if (step.kind === 'clear') this.session.clearedBlocks += 1
    if (step.kind === 'foundation_fill') this.session.foundationBlocks += 1
    if (step.kind === 'scaffold_place') this.session.scaffoldBlocks += 1
    if (step.kind === 'scaffold_remove') this.session.removedScaffoldBlocks += 1
    if (step.kind === 'place') {
      this.session.placedBlocks += 1
      this.session.currentIndex += 1
    }
  }

  updateConstructionStep(step, status, details = {}) {
    if (!this.session?.constructionRun || !step?.id) return
    const run = this.session.constructionRun
    const previous = run.steps?.[step.id] || {}
    const retry = {
      ...(previous.retry || { count: 0, lastError: null })
    }
    if (details.retryError) {
      retry.count = Number(retry.count || 0) + 1
      retry.lastError = details.retryError
      retry.lastAt = new Date().toISOString()
    }
    const updatedStep = {
      ...previous,
      ...constructionStepPatchFromDetails(details),
      id: step.id,
      status,
      retry,
      lifecyclePhase: normalizeConstructionPhase(step.phase, step),
      updatedAt: new Date().toISOString()
    }
    const steps = {
      ...(run.steps || {}),
      [step.id]: updatedStep
    }
    const currentPhase = normalizeConstructionPhase(step.phase, step)
    this.session.constructionRun = {
      ...run,
      steps,
      currentPhase,
      lifecycle: updateConstructionLifecycle(run.lifecycle, steps, currentPhase),
      updatedAt: new Date().toISOString()
    }
    step.runStatus = status
    this.recordConstructionCheckpointStatus(status)
  }

  markClearStepsSatisfiedByPlacement(context, placementStep) {
    if (!this.session?.constructionRun || !placementStep?.id) return []
    if (!['place', 'foundation_fill', 'scaffold_place'].includes(placementStep.kind)) return []
    const runSteps = this.session.constructionRun.steps || {}
    const placementRunStep = runSteps[placementStep.id]
    if (!isStepVerified(placementRunStep)) return []

    const marked = []
    for (const clearStep of this.session.steps || []) {
      if (!clearStep || clearStep.id === placementStep.id || clearStep.kind !== 'clear') continue
      const clearRunStep = this.session.constructionRun.steps?.[clearStep.id]
      if (isStepVerified(clearRunStep)) continue
      const expectedStep = findExpectedPlacementStepForClear(this.session, clearStep)
      if (expectedStep?.id !== placementStep.id) continue
      if (!clearStepTargetAlreadyMatchesPlacement(context, clearStep, {
        steps: this.session.steps || [],
        runSteps: this.session.constructionRun.steps || {},
        origin: this.session.origin
      })) {
        continue
      }

      const clearSkipRecord = {
        skippedAt: new Date().toISOString(),
        skipReason: 'clear_target_already_matches_placement',
        expectedStepId: placementStep.id,
        expectedRunStepStatus: placementRunStep.status || STEP_STATE.VERIFIED,
        target: clonePlainObject(clearStep.position || clearStep.target || placementStep.position || null)
      }
      this.updateConstructionStepPreservingPhase(clearStep, STEP_STATE.VERIFIED, { clearSkipRecord })
      marked.push({
        clearStepId: clearStep.id,
        expectedStepId: placementStep.id,
        target: clearSkipRecord.target
      })
      logBuilding(context, `[BUILD_CLEAR_ALREADY_SATISFIED] target=${formatPos(clearSkipRecord.target)} expectedStep=${placementStep.id} reason=clear_target_already_matches_placement`)
    }
    return marked
  }

  updateConstructionStepPreservingPhase(step, status, details = {}) {
    if (!this.session?.constructionRun || !step?.id) return
    const run = this.session.constructionRun
    const preservedPhase = run.currentPhase || normalizeConstructionPhase(step.phase, step)
    const previous = run.steps?.[step.id] || {}
    const retry = {
      ...(previous.retry || { count: 0, lastError: null })
    }
    if (details.retryError) {
      retry.count = Number(retry.count || 0) + 1
      retry.lastError = details.retryError
      retry.lastAt = new Date().toISOString()
    }
    const updatedStep = {
      ...previous,
      ...constructionStepPatchFromDetails(details),
      id: step.id,
      status,
      retry,
      lifecyclePhase: normalizeConstructionPhase(step.phase, step),
      updatedAt: new Date().toISOString()
    }
    const steps = {
      ...(run.steps || {}),
      [step.id]: updatedStep
    }
    this.session.constructionRun = {
      ...run,
      steps,
      currentPhase: preservedPhase,
      lifecycle: updateConstructionLifecycle(run.lifecycle, steps, preservedPhase),
      updatedAt: new Date().toISOString()
    }
    step.runStatus = status
    this.recordConstructionCheckpointStatus(status)
  }

  markConstructionCheckpointDirty() {
    this.constructionCheckpointState.dirty = true
  }

  recordConstructionCheckpointStatus(status) {
    if (!this.session?.constructionRun) return { flushed: false, reason: 'construction_run_unavailable' }
    this.markConstructionCheckpointDirty()
    if (status === STEP_STATE.VERIFIED) {
      this.constructionCheckpointState.verifiedSinceFlush += 1
    }

    const terminalFailure = [
      STEP_STATE.RETRYABLE_FAILED,
      STEP_STATE.TERMINAL_FAILED
    ].includes(status)
    const stepInterval = Math.max(1, Number(this.options.constructionCheckpointStepInterval || 10))
    const maxIntervalMs = Math.max(1000, Number(this.options.constructionCheckpointMaxIntervalMs || 30000))
    const intervalReached = this.constructionCheckpointState.verifiedSinceFlush >= stepInterval
    const maxAgeReached = Date.now() - this.constructionCheckpointState.lastFlushAt >= maxIntervalMs

    if (terminalFailure) {
      return this.flushConstructionRunCheckpoint('step_failure', { force: true })
    }
    if (status === STEP_STATE.VERIFIED && (intervalReached || maxAgeReached)) {
      return this.flushConstructionRunCheckpoint(intervalReached ? 'verified_step_batch' : 'checkpoint_max_age')
    }
    return { flushed: false, reason: 'batch_pending' }
  }

  checkpointConstructionRun(reason = 'manual_checkpoint') {
    return this.flushConstructionRunCheckpoint(reason)
  }

  flushConstructionRunCheckpoint(reason = 'checkpoint', options = {}) {
    if (!this.session?.constructionRun || !this.constructionRunStore) {
      return { flushed: false, reason: 'construction_run_store_unavailable' }
    }
    if (!this.constructionCheckpointState.dirty && options.force !== true) {
      return { flushed: false, reason: 'checkpoint_clean' }
    }

    const flushedAt = new Date().toISOString()
    const writeCount = this.constructionCheckpointState.writeCount + 1
    const checkpoint = {
      strategy: 'verified_step_batch',
      stepInterval: Math.max(1, Number(this.options.constructionCheckpointStepInterval || 10)),
      maxIntervalMs: Math.max(1000, Number(this.options.constructionCheckpointMaxIntervalMs || 30000)),
      writeCount,
      verifiedSincePrevious: this.constructionCheckpointState.verifiedSinceFlush,
      reason,
      flushedAt
    }
    const snapshot = {
      ...this.session.constructionRun,
      checkpoint,
      updatedAt: flushedAt
    }
    const saved = this.constructionRunStore.upsertRun(snapshot)
    // The store holds writes back while the connection is down; keep the
    // checkpoint dirty so the next opportunity flushes the same truth.
    const deferred = this.constructionRunStore.lastWriteDeferred === true
    if (saved) this.session.constructionRun = saved
    this.constructionCheckpointState = {
      dirty: deferred,
      verifiedSinceFlush: deferred ? this.constructionCheckpointState.verifiedSinceFlush : 0,
      lastFlushAt: Date.now(),
      writeCount,
      lastReason: reason
    }
    return { flushed: !deferred, deferred, checkpoint }
  }

  markConstructionRunCompleted() {
    if (!this.session?.constructionRun || !this.constructionRunStore) return
    const completedAt = new Date().toISOString()
    const completed = {
      ...this.session.constructionRun,
      status: 'COMPLETED',
      terminalState: 'COMPLETED',
      completedAt,
      lifecycle: completeConstructionLifecycle(this.session.constructionRun.lifecycle),
      archive: createConstructionArchive(this.session, completedAt)
    }
    this.session.constructionRun = completed
    this.markConstructionCheckpointDirty()
    this.flushConstructionRunCheckpoint('complete', { force: true })
  }

  async refillMaterialsFromStorage(context, missingMaterials = [], options = {}) {
    const storage = context.storageSystem
    if (!storage || typeof storage.takeItems !== 'function') return { ok: false, error: 'storage_system_unavailable' }
    const withdrawn = []
    const failed = []
    const maxAttempts = Math.max(1, Number(options.maxStorageRefillAttempts || 6))
    for (const material of missingMaterials) {
      let remaining = material.missing || Math.max(0, material.required - material.available)
      if (!material.item || remaining <= 0) continue

      let attempts = 0
      while (remaining > 0 && attempts < maxAttempts) {
        attempts += 1
        const before = getLiveInventoryCounts(context)[material.item] || 0
        const requested = remaining
        const result = await storage.takeItems(context, {
          itemName: material.item,
          count: requested,
          owner: options.owner,
          query: material.item,
          radius: materialStorageSearchRadius(this.options, options),
          scanCenters: options.materialStorageScanCenters || materialStorageScanCentersForTier(this.session, 'primary'),
          scanOnlyProvidedCenters: true,
          exactScanCenters: true,
          skipUtilitySearch: true,
          skipMemorySearch: true,
          canDig: false,
          shouldContinue: options.shouldContinue,
          reason: 'building_material_refill'
        })
        const after = getLiveInventoryCounts(context)[material.item] || 0
        const moved = movedItemCount(result, material.item, after - before)

        if (result.ok && moved > 0) {
          withdrawn.push(...(result.withdrawnItems || []))
          remaining = Math.max(0, remaining - moved)
          logBuilding(context, `[BUILD_STORAGE_REFILL] item=${material.item} requested=${requested} moved=${moved} remaining=${remaining}`)
          continue
        }

        const error = result.error || (moved <= 0 ? 'storage_refill_moved_zero' : 'storage_refill_failed')
        failed.push({ item: material.item, count: requested, remaining, error })
        logBuilding(context, `[BUILD_STORAGE_REFILL_FAILED] item=${material.item} requested=${requested} remaining=${remaining} error=${error}`)
        break
      }

      if (remaining > 0 && attempts >= maxAttempts) {
        failed.push({ item: material.item, count: material.missing, remaining, error: 'storage_refill_attempt_limit' })
      }
    }
    return { ok: failed.length === 0, withdrawn, failed }
  }

  getStatus() {
    if (!this.session) return null
    return {
      blueprintName: this.session.blueprintName,
      selectedBlueprint: this.session.selectedBlueprint || null,
      blueprintIR: summarizeBlueprintIR(this.session.blueprintIR),
      constructionPlan: summarizeConstructionPlan(this.session.constructionPlan),
      constructionEstimate: this.session.constructionEstimate || null,
      constructionRun: summarizeConstructionRun(this.session.constructionRun),
      executorBackend: this.executor?.constructor?.name || 'unknown',
      candidateSummary: this.session.candidateSummary || null,
      designSpec: summarizeDesignSpec(this.session.designSpec),
      blueprintFreeze: this.session.blueprintFreeze || null,
      designPlan: summarizeDesignPlan(this.session.designPlan, this.session.designDiagnostics),
      aestheticPlan: this.session.aestheticPlan || null,
      layoutPlan: summarizeLayoutPlan(this.session.layoutPlan),
      interiorPlan: summarizeInteriorPlan(this.session.interiorPlan),
      interiorValidation: this.session.interiorValidation || null,
      walkabilityPrecheck: summarizeWalkability(this.session.walkabilityPrecheck),
      habitabilityHardGate: this.session.habitabilityHardGate || null,
      habitabilityFinalGate: this.session.habitabilityFinalGate || null,
      habitabilityRequired: this.session.habitabilityRequired === true,
      origin: this.session.origin,
      totalBlocks: this.session.totalBlocks,
      placedBlocks: this.session.placedBlocks,
      clearedBlocks: this.session.clearedBlocks,
      foundationBlocks: this.session.foundationBlocks,
      scaffoldBlocks: this.session.scaffoldBlocks,
      removedScaffoldBlocks: this.session.removedScaffoldBlocks,
      currentIndex: this.session.currentIndex,
      currentStepIndex: this.session.currentStepIndex,
      totalSteps: this.session.steps?.length || 0,
      missingMaterials: this.session.missingMaterials,
      materialPlan: summarizeMaterialPlan(this.session.materialPlan),
      materialResolution: this.session.materialResolution || null,
      sitePlan: this.session.sitePlan?.summary || null,
      orderPlan: this.session.orderPlan?.summary || null,
      worldDiffResult: summarizeWorldDiffResult(this.session.worldDiffResult),
      buildStatus: this.session.status,
      lastBuildError: this.session.lastBuildError
    }
  }
}

function designSpecFromBuildOptions(blueprintName, options = {}) {
  const hasExplicitDesignSignal = Boolean(
    options.designSpec ||
    options.designBudget ||
    options.complexityTier ||
    options.complexity
  )
  if ((options.forceRebuild === true || options.resumeOnly === true) && !hasExplicitDesignSignal) return null
  if (shouldPreserveNamedBlueprintScale({ blueprintName, ...options }) && !hasExplicitDesignSignal) return null
  const hasIntentSignal = options.userIntent === true ||
    Boolean(options.rawText || options.input || options.text) ||
    hasExplicitDesignSignal
  if (!hasIntentSignal) return null
  return adaptBuildIntentToDesignSpec({
    rawText: options.rawText || options.input || options.text || null,
    blueprintName,
    style: options.style,
    type: options.type,
    complexity: options.complexity,
    complexityTier: options.complexityTier,
    designSpec: options.designSpec || options.designBudget || null
  })
}

function shouldPreserveBudgetedBlueprint(designSpec, selected = {}, blueprint = null) {
  if (isLocalHandmadeBlueprint(selected, blueprint)) return true
  if (!designSpec || !isLowComplexityTier(designSpec.complexityTier)) return false
  if (selected.sourceKind === 'real_community_import' || selected.sourceMode === 'faithful-community-import') return false
  return true
}

// 决策 #98：blueprints/ 目录里的本地手工图纸不管档位都「按预算直接盖」。
// 建造 26 真机：塔楼小筑实测 L4，档位 > L3 就被送去取社区样板做美学参考，
// 缓存里没有同风格的样板 -> verified_real_community_samples_unavailable，
// 20 ms 内失败、一块砖没盖。图纸是老板亲手拍板的，美学参考对它没有意义。
// 判据全用选择器现成打的标记：local_library + 从 blueprints/ 按名字加载
// （localName），且不是走 localBlueprintPath 的社区原样导入、也不是回落到生成器的。
// 再加一条：图纸自己在 metadata 里声明了档位（complexityTier）——定稿的设计图才带它。
// 没声明的老模板（small_house 那 26 块）照旧走设计师改造 + 样本美学那条路，
// 那条路有现成验收钉着（testBuildTaskPlacesBlock 要求 transformed=true），#98 不动它。
function isLocalHandmadeBlueprint(selected = {}, blueprint = null) {
  return Boolean(blueprint?.metadata?.complexityTier) &&
    selected.sourceKind === 'local_library' &&
    Boolean(selected.localName) &&
    !selected.localBlueprintPath &&
    !selected.generatorKey &&
    selected.sourceMode !== 'faithful-community-import'
}

function blueprintBoundsForLegacy(blueprint = {}) {
  const blocks = (blueprint.blocks || []).filter(block => block && !isAirName(block.type || block.name || block.blockName || block.block?.id))
  if (!blocks.length) return null
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, Number(block.x) || 0),
    maxX: Math.max(bounds.maxX, Number(block.x) || 0),
    minY: Math.min(bounds.minY, Number(block.y) || 0),
    maxY: Math.max(bounds.maxY, Number(block.y) || 0),
    minZ: Math.min(bounds.minZ, Number(block.z) || 0),
    maxZ: Math.max(bounds.maxZ, Number(block.z) || 0)
  }), {
    minX: Number(blocks[0].x) || 0,
    maxX: Number(blocks[0].x) || 0,
    minY: Number(blocks[0].y) || 0,
    maxY: Number(blocks[0].y) || 0,
    minZ: Number(blocks[0].z) || 0,
    maxZ: Number(blocks[0].z) || 0
  })
}

function blockNameAt(context, position) {
  return blockDetailsAt(context, position).name
}

function blockDetailsAt(context, position) {
  try {
    const block = context.bot?.blockAt?.(toBlockVec3(position))
    const states = block
      ? (typeof block.getProperties === 'function'
          ? block.getProperties()
          : (block.properties || block._properties || null))
      : null
    return {
      name: block?.name || 'air',
      states
    }
  } catch {
    return { name: 'air', states: null }
  }
}

function findWorldBlock(worldBlocks = [], position, expectedType = null) {
  return worldBlocks.find(block =>
    block?.position &&
    block.position.x === position?.x &&
    block.position.y === position?.y &&
    block.position.z === position?.z &&
    (!expectedType || block.type === expectedType)
  ) || null
}

function guardBoundedConstructionStart(decision = {}, options = {}) {
  if (!boundedConstructionStartGuardEnabled(options)) return { ok: true }
  if (options.forceRebuild === true && options.allowForceRebuild !== true) {
    return {
      ok: false,
      error: 'BUG_FRESH_BUILD_ATTEMPTED',
      reason: 'force_rebuild_not_allowed_in_bounded_resume',
      constructionRunDecision: decision
    }
  }
  if (decision.resumeOrFresh !== 'resume') {
    return {
      ok: false,
      error: 'BUG_FRESH_BUILD_ATTEMPTED',
      reason: decision.reason || 'bounded_resume_requires_active_compatible_run',
      constructionRunDecision: decision
    }
  }
  return { ok: true }
}

function boundedConstructionStartGuardEnabled(options = {}) {
  return options.resumeOnly === true ||
    options.boundedSmoke === true ||
    options.freshBuild === false ||
    options.allowFreshBuild === false ||
    options.allowForceRebuild === false ||
    boundedSmokeGuardEnabled(options)
}

function boundedConstructionStartBlockedResult(preview, guard) {
  return {
    ...preview,
    ok: false,
    error: guard.error,
    reason: guard.reason,
    boundedGuard: guard,
    constructionRunDecision: guard.constructionRunDecision || null
  }
}

function guardBoundedSmokeStep(step, options = {}) {
  if (!boundedSmokeGuardEnabled(options)) return { ok: true }
  const actualNextStep = summarizeStepForGuard(step)
  const expectedStep = expectedStepForGuard(options)
  const allowedStepIds = normalizeStringList(options.allowedStepIds)
  if (allowedStepIds.length && !allowedStepIds.includes(step?.id)) {
    return {
      ok: false,
      error: 'BOUNDED_STEP_MISMATCH',
      actualNextStep,
      expectedStep
    }
  }

  if (options.expectedTarget && !positionsEqual(step?.position || step?.target, options.expectedTarget)) {
    return {
      ok: false,
      error: 'TARGET_MISMATCH',
      actualNextStep,
      expectedStep
    }
  }

  const actualOriginal = step?.originalBlockName || step?.originalBlock?.id || step?.materialResolution?.originalBlock || null
  if (options.expectedOriginalBlock && actualOriginal !== options.expectedOriginalBlock) {
    return {
      ok: false,
      error: 'ORIGINAL_BLOCK_MISMATCH',
      actualNextStep,
      expectedStep
    }
  }

  const actualResolved = step?.resolvedBlockName || step?.resolvedBlock?.id || step?.materialResolution?.resolvedBlock || step?.blockName || step?.block?.id || null
  if (options.expectedResolvedBlock && actualResolved !== options.expectedResolvedBlock) {
    return {
      ok: false,
      error: 'RESOLVED_BLOCK_MISMATCH',
      actualNextStep,
      expectedStep
    }
  }

  const actualAction = boundedActionForStep(step)
  const allowedActions = normalizeStringList(options.allowedActions || [])
    .concat(normalizeStringList(options.expectedAction ? [options.expectedAction] : []))
    .map(normalizeBoundedAction)
    .filter(Boolean)
  if (allowedActions.length && !allowedActions.includes(actualAction)) {
    return {
      ok: false,
      error: 'BOUNDED_ACTION_NOT_ALLOWED',
      actualNextStep,
      expectedStep
    }
  }

  if (actualAction === 'clear_obstruction' && options.allowClearObstruction !== true) {
    return {
      ok: false,
      error: 'BOUNDED_ACTION_NOT_ALLOWED',
      actualNextStep,
      expectedStep
    }
  }
  if (actualAction === 'repair' && options.allowRepair !== true) {
    return {
      ok: false,
      error: 'BOUNDED_ACTION_NOT_ALLOWED',
      actualNextStep,
      expectedStep
    }
  }
  if (actualAction === 'cleanup' && options.allowCleanup !== true) {
    return {
      ok: false,
      error: 'BOUNDED_ACTION_NOT_ALLOWED',
      actualNextStep,
      expectedStep
    }
  }

  return { ok: true, actualNextStep, expectedStep }
}

function boundedSmokeGuardEnabled(options = {}) {
  return options.boundedSmoke === true ||
    normalizeStringList(options.allowedStepIds).length > 0 ||
    normalizeStringList(options.allowedActions).length > 0 ||
    Boolean(options.expectedAction) ||
    Boolean(options.expectedTarget) ||
    Boolean(options.expectedOriginalBlock) ||
    Boolean(options.expectedResolvedBlock)
}

function expectedStepForGuard(options = {}) {
  return {
    allowedStepIds: normalizeStringList(options.allowedStepIds),
    allowedActions: normalizeStringList(options.allowedActions || (options.expectedAction ? [options.expectedAction] : [])),
    expectedOriginalBlock: options.expectedOriginalBlock || null,
    expectedResolvedBlock: options.expectedResolvedBlock || null,
    expectedTarget: clonePlainObject(options.expectedTarget || null)
  }
}

function summarizeStepForGuard(step = {}) {
  return {
    stepId: step.id || null,
    action: boundedActionForStep(step),
    phase: step.phase || null,
    status: step.runStatus || step.status || null,
    target: clonePlainObject(step.position || step.target || null),
    originalBlock: step.originalBlockName || step.originalBlock?.id || step.materialResolution?.originalBlock || null,
    resolvedBlock: step.resolvedBlockName || step.resolvedBlock?.id || step.materialResolution?.resolvedBlock || step.blockName || step.block?.id || null
  }
}

function runStatusForExecution(step = {}, options = {}) {
  const optionStatusApplies = !options.executionStepId || options.executionStepId === step?.id
  if (optionStatusApplies && options.executionRunStatus) return options.executionRunStatus
  return step?.runStatus || step?.status || null
}

function isRepairExecutionStatus(status) {
  return status === STEP_STATE.REPAIR || status === STEP_STATE.STATE_REPAIR
}

function boundedActionForStep(step = {}) {
  const kind = step.kind || step.legacyKind || kindFromAction(step.action)
  const status = step.runStatus || step.status
  const phase = step.phase || null
  if (kind === 'scaffold_remove' || phase === 'cleanup') return 'cleanup'
  if (kind === 'clear' || phase === 'clear_obstruction') return 'clear_obstruction'
  if (status === STEP_STATE.REPAIR || status === STEP_STATE.STATE_REPAIR) return 'repair'
  if (kind === 'place' || kind === 'foundation_fill' || kind === 'scaffold_place' || step.action === 'place_block') return 'place'
  return normalizeBoundedAction(step.action || kind)
}

function normalizeBoundedAction(action) {
  const value = String(action || '').trim().toLowerCase()
  if (!value) return null
  if (value === 'place_block' || value === 'place') return 'place'
  if (value === 'clear_block' || value === 'clear' || value === 'clear_obstruction') return 'clear_obstruction'
  if (value === 'scaffold_remove' || value === 'cleanup') return 'cleanup'
  if (value === 'repair' || value === 'state_repair') return 'repair'
  return value
}

function normalizeStringList(value) {
  if (value == null) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map(entry => String(entry || '').trim()).filter(Boolean)
}

function evaluateClearPolicy(context, session, step, options = {}) {
  const currentDetails = options.currentDetails || blockDetailsAt(context, step.position || step.target)
  const currentBlock = currentDetails.name || 'air'
  const expectedStep = options.clearMode === 'repair_target' || options.clearMode === 'state_repair'
    ? step
    : findExpectedPlacementStepForClear(session, step)
  const clearStepExpectedAfter = clearStepExpectedBlockName(step)
  const expectedAfter = expectedStep?.blockName || expectedStep?.block?.id || clearStepExpectedAfter || null
  const expectedStates = expectedStep?.states || expectedStep?.orientation || expectedStep?.block?.states || null
  const base = {
    allowed: false,
    stepId: step.id || null,
    action: step.kind || step.legacyKind || kindFromAction(step.action),
    clearCategory: null,
    clearReason: null,
    currentBlock,
    target: clonePlainObject(step.position || step.target || null),
    expectedAfter: expectedAfter || null,
    expectedStates: clonePlainObject(expectedStates || null),
    expectedStepId: expectedStep?.id || null,
    expectedStep,
    restoreRequired: false,
    restoreStepId: null,
    restoreBeforePhase: expectedStep?.phase || 'frame',
    sourceDiffCategory: null,
    riskLevel: 'low',
    wouldBreakExistingStructure: false,
    requiresUserApproval: false
  }

  if (isAirName(currentBlock)) {
    return {
      ...base,
      allowed: true,
      clearCategory: 'already_clear',
      clearReason: 'already_clear',
      expectedAfter: expectedAfter || 'air',
      sourceDiffCategory: 'already_air'
    }
  }

  if (step.kind === 'scaffold_remove') {
    return {
      ...base,
      allowed: true,
      clearCategory: 'temporary_scaffold',
      clearReason: 'temporary_scaffold_cleanup',
      expectedAfter: 'air',
      sourceDiffCategory: 'scaffoldResidue',
      riskLevel: 'low'
    }
  }

  if (step.renovationClear === true) {
    // Renovation demolition (docs/RENOVATION_FLOW_DESIGN.md): only a live
    // renovation run may demolish blocks of the blueprint generation it
    // supersedes, and only via its own direct lineage pointer.
    const sessionRenovationOf = session?.constructionRun?.renovationOf || null
    if (sessionRenovationOf && step.renovationOf === sessionRenovationOf) {
      return {
        ...base,
        allowed: true,
        clearCategory: 'renovation_clear',
        clearReason: 'renovation_demolition_of_superseded_blueprint_block',
        expectedAfter: expectedAfter || 'air',
        sourceDiffCategory: 'extraBlocks',
        riskLevel: 'medium',
        wouldBreakExistingStructure: true
      }
    }
    return {
      ...base,
      clearCategory: 'renovation_clear',
      clearReason: 'renovation_clear_requires_matching_renovation_run',
      error: 'RENOVATION_CLEAR_REQUIRES_RENOVATION_RUN',
      riskLevel: 'high',
      wouldBreakExistingStructure: true,
      requiresUserApproval: true
    }
  }

  if (options.clearMode === 'state_repair') {
    return {
      ...base,
      allowed: true,
      clearCategory: 'wrong_state_at_target',
      clearReason: 'wrong_state_at_target',
      sourceDiffCategory: 'wrongStates',
      riskLevel: 'medium',
      replacementStepId: step.id || null
    }
  }

  const finalBlockAtTarget = expectedAfter && !isAirName(expectedAfter) && currentBlock === expectedAfter
  const expectedRunStep = expectedStep?.id ? session?.constructionRun?.steps?.[expectedStep.id] : null
  const verifiedFinalBlock = finalBlockAtTarget && isStepVerified(expectedRunStep)
  if (finalBlockAtTarget || verifiedFinalBlock) {
    const structural = isStructuralFinalBlockName(currentBlock) || isStructuralFinalBlockName(expectedAfter)
    if (options.allowTemporaryFinalBlockRemoval !== true) {
      return {
        ...base,
        clearCategory: structural ? 'structural_verified_final_block' : 'verified_final_block',
        clearReason: structural ? 'structural_final_block_requires_restore_plan' : 'temporary_final_block_removal_requires_approval',
        error: structural ? 'STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN' : 'USER_APPROVAL_REQUIRED',
        riskLevel: structural ? 'high' : 'medium',
        wouldBreakExistingStructure: true,
        requiresUserApproval: true,
        restoreRequired: true
      }
    }
    return {
      ...base,
      allowed: true,
      clearCategory: structural ? 'structural_verified_final_block' : 'verified_final_block_temporary_removal',
      clearReason: 'temporary_final_block_removal',
      sourceDiffCategory: 'temporary_final_block_removal',
      riskLevel: structural ? 'high' : 'medium',
      wouldBreakExistingStructure: true,
      restoreRequired: true
    }
  }

  if (isReplaceableTerrainObstruction(currentBlock) && currentBlock !== expectedAfter) {
    return {
      ...base,
      allowed: true,
      clearCategory: 'terrain_obstruction',
      clearReason: 'terrain_obstruction',
      sourceDiffCategory: 'wrongBlocks',
      riskLevel: 'low',
      replacementStepId: expectedStep?.id || step.id || null
    }
  }

  if (expectedAfter && currentBlock !== expectedAfter) {
    return {
      ...base,
      allowed: true,
      clearCategory: 'wrong_block_at_target',
      clearReason: 'wrong_block_at_target',
      sourceDiffCategory: 'wrongBlocks',
      riskLevel: isStructuralFinalBlockName(currentBlock) ? 'medium' : 'low',
      replacementStepId: expectedStep?.id || step.id || null
    }
  }

  const protectedBlock = PROTECTED_SITE_BLOCKS.has(currentBlock)
  const structural = isStructuralFinalBlockName(currentBlock)
  return {
    ...base,
    clearCategory: structural ? 'structural_block' : (protectedBlock ? 'protected_block' : 'unknown_obstruction'),
    clearReason: structural ? 'structural_clear_requires_restore_plan' : (protectedBlock ? 'protected_block_requires_user_approval' : 'clear_policy_unknown_obstruction'),
    error: structural ? 'STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN' : 'USER_APPROVAL_REQUIRED',
    riskLevel: structural || protectedBlock ? 'high' : 'medium',
    wouldBreakExistingStructure: structural,
    requiresUserApproval: true,
    restoreRequired: structural
  }
}

function findExpectedPlacementStepForClear(session, clearStep = {}) {
  if (!clearStep) return null
  if (clearStep.sourceBlockKey) {
    const bySource = (session?.steps || []).find(step =>
      step?.id !== clearStep.id &&
      step.sourceBlockKey === clearStep.sourceBlockKey &&
      ['place', 'foundation_fill', 'scaffold_place'].includes(step.kind) &&
      !isAirName(step.blockName)
    )
    if (bySource) return bySource
  }
  return findPlacementStepAt(session, clearStep.position || clearStep.target)
}

function clearStepExpectedBlockName(step = {}) {
  if (!step) return null
  if (step.targetType && !isAirName(step.targetType)) return step.targetType
  const alternatives = Array.isArray(step.materialAlternatives)
    ? step.materialAlternatives.filter(name => name && !isAirName(name))
    : []
  return alternatives.length === 1 ? alternatives[0] : null
}

function clearPolicyBlockedResult(policy) {
  return {
    ok: false,
    error: policy.error || 'CLEAR_POLICY_BLOCKED',
    clearPolicy: summarizeClearPolicy(policy),
    userApprovalRequired: policy.requiresUserApproval === true
  }
}

function clearRecordFromPolicy(policy, afterClear = null) {
  return {
    clearedBlock: policy.currentBlock || null,
    clearedAt: new Date().toISOString(),
    clearReason: policy.clearReason || policy.clearCategory || null,
    clearCategory: policy.clearCategory || null,
    expectedAfter: policy.expectedAfter || null,
    sourceDiffCategory: policy.sourceDiffCategory || null,
    restoreRequired: policy.restoreRequired === true,
    restoreStepId: policy.restoreStepId || null,
    restoreBeforePhase: policy.restoreBeforePhase || null,
    replacementStepId: policy.replacementStepId || policy.expectedStepId || null,
    riskLevel: policy.riskLevel || null,
    wouldBreakExistingStructure: policy.wouldBreakExistingStructure === true,
    requiresUserApproval: policy.requiresUserApproval === true,
    afterClear: afterClear ? clonePlainObject({ name: afterClear.name, states: afterClear.states || null }) : null
  }
}

function summarizeClearPolicy(policy = {}) {
  return {
    allowed: policy.allowed === true,
    stepId: policy.stepId || null,
    action: policy.action || null,
    target: clonePlainObject(policy.target || null),
    currentBlock: policy.currentBlock || null,
    expectedAfter: policy.expectedAfter || null,
    clearCategory: policy.clearCategory || null,
    clearReason: policy.clearReason || null,
    sourceDiffCategory: policy.sourceDiffCategory || null,
    restoreRequired: policy.restoreRequired === true,
    restoreStepId: policy.restoreStepId || null,
    replacementStepId: policy.replacementStepId || policy.expectedStepId || null,
    riskLevel: policy.riskLevel || null,
    wouldBreakExistingStructure: policy.wouldBreakExistingStructure === true,
    requiresUserApproval: policy.requiresUserApproval === true,
    error: policy.error || null
  }
}

function attachClearRecordToStepResult(result, clearRecord) {
  if (!clearRecord) return result
  return {
    ...result,
    clearRecord
  }
}

function optionalScaffoldSkipResult(context, session, step) {
  if (step?.kind !== 'scaffold_place') return { ok: false, reason: 'not_scaffold_place' }
  if (step.sourceBlockKey) return { ok: false, reason: 'formal_scaffold_step' }
  const state = session?.constructionRun?.steps?.[step.id] || {}
  const retryCount = Number(state.retry?.count || 0)
  const lastError = String(state.retry?.lastError || '')
  if (retryCount < 2 || lastError !== 'move_timeout') {
    return { ok: false, reason: 'retry_threshold_not_met' }
  }
  const target = step.position || step.target
  if (!target) return { ok: false, reason: 'missing_target' }
  const current = blockDetailsAt(context, target)
  if (!isAirName(current.name)) return { ok: false, reason: `target_not_air:${current.name || 'unknown'}` }
  const support = blockDetailsAt(context, { x: target.x, y: target.y - 1, z: target.z })
  if (isAirName(support.name) || support.name === 'water' || support.name === 'lava') {
    return { ok: false, reason: `support_unstable:${support.name || 'unknown'}` }
  }
  const skippedAt = new Date().toISOString()
  const scaffoldSkipRecord = {
    skipped: true,
    skippedAt,
    skipReason: 'optional_scaffold_move_timeout',
    skippedBlock: step.blockName || step.block?.id || null,
    retryCount,
    lastError,
    target: clonePlainObject(target),
    supportBlock: support.name
  }
  return {
    ok: true,
    skipped: true,
    message: 'optional_scaffold_move_timeout',
    data: {
      position: clonePlainObject(target),
      blockName: step.blockName || step.block?.id || null,
      retryCount,
      lastError,
      supportBlock: support.name
    },
    scaffoldSkipRecord
  }
}

function constructionStepDetailsFromResult(result = {}) {
  return result.clearRecord ? { clearRecord: result.clearRecord } : {}
}

function constructionStepPatchFromDetails(details = {}) {
  if (details.scaffoldSkipRecord) {
    const record = details.scaffoldSkipRecord
    return {
      skipped: true,
      skippedAt: record.skippedAt || new Date().toISOString(),
      skipReason: record.skipReason || 'optional_scaffold_skipped',
      skippedBlock: record.skippedBlock || null,
      skippedRetryCount: Number(record.retryCount || 0),
      skippedLastError: record.lastError || null,
      skippedSupportBlock: record.supportBlock || null
    }
  }
  if (details.clearSkipRecord) {
    const record = details.clearSkipRecord
    return {
      skipped: true,
      skippedAt: record.skippedAt || new Date().toISOString(),
      skipReason: record.skipReason || 'clear_skipped',
      replacementStepId: record.expectedStepId || null,
      expectedRunStepStatus: record.expectedRunStepStatus || null
    }
  }
  if (!details.clearRecord) return {}
  const record = details.clearRecord
  return {
    clearedBlock: record.clearedBlock || null,
    clearedAt: record.clearedAt || new Date().toISOString(),
    clearReason: record.clearReason || null,
    clearCategory: record.clearCategory || null,
    expectedAfter: record.expectedAfter || null,
    sourceDiffCategory: record.sourceDiffCategory || null,
    restoreRequired: record.restoreRequired === true,
    restoreStepId: record.restoreStepId || null,
    restoreBeforePhase: record.restoreBeforePhase || null,
    replacementStepId: record.replacementStepId || null,
    riskLevel: record.riskLevel || null,
    wouldBreakExistingStructure: record.wouldBreakExistingStructure === true,
    requiresUserApproval: record.requiresUserApproval === true
  }
}

function pendingRestoreRecords(run) {
  return Object.values(run?.steps || {})
    .filter(step => step?.restoreStep === true && !isStepVerified(step))
    .map(step => ({
      stepId: step.id,
      target: clonePlainObject(step.target || null),
      expected: step.resolvedBlock?.id || step.block?.id || null,
      restoreForStepId: step.restoreForStepId || step.restoreRequiredByClearStepId || null
    }))
}

function isReplaceableTerrainObstruction(blockName) {
  const name = String(blockName || '')
  return REPLACEABLE_CLEAR_BLOCKS.has(name) || name.endsWith('_leaves') || name.endsWith('_flower')
}

function isStructuralFinalBlockName(blockName) {
  const name = String(blockName || '')
  if (!name || isAirName(name)) return false
  return /_log$|_wood$|_planks$|_stairs$|_slab$|_fence$|_fence_gate$|_door$|_trapdoor$|glass|pane|ladder|chest$|barrel$|furnace$|smoker$|crafting_table$|lectern$|bookshelf$|bed$|sign$|banner$|wall_head$|_button$|pressure_plate$/.test(name)
}

function summarizeAestheticPlan({ community, initialEncoding, refinedEncoding, refinement, finalAesthetic, contrast = null, generationSeed = null }) {
  const initialAttempt = refinement?.attempts?.[0] || null
  const finalAttempt = refinement?.attempts?.at?.(-1) || null
  return {
    enabled: true,
    layer: 'aesthetic_learning',
    community: {
      source: community?.source || 'community_unavailable',
      realCommunity: community?.realCommunity === true,
      fallbackUsed: community?.fallbackUsed === true,
      evidence: community?.evidence || null,
      sampleCount: community?.samples?.length || 0,
      samples: (community?.samples || []).map(sample => ({
        id: sample.id,
        blueprintName: sample.blueprintName,
        sourceKind: sample.sourceKind,
        source: sample.source,
        sourcePageIdentifier: sample.sourcePageIdentifier,
        author: sample.author,
        buildTitle: sample.buildTitle,
        category: sample.category,
        structureFileFormat: sample.structureFileFormat,
        minecraftVersion: sample.minecraftVersion,
        cacheHash: sample.cacheHash,
        importStatus: sample.importStatus,
        license: sample.license,
        rating: sample.rating,
        similarityReady: sample.encoding?.similarityReady === true
      }))
    },
    generationSeed: generationSeed
      ? {
          id: generationSeed.id,
          sourceKind: generationSeed.sourceKind,
          source: generationSeed.source,
          sourcePageIdentifier: generationSeed.sourcePageIdentifier,
          author: generationSeed.author,
          buildTitle: generationSeed.buildTitle,
          structureFileFormat: generationSeed.structureFileFormat,
          cacheHash: generationSeed.cacheHash,
          importStatus: generationSeed.importStatus,
          localBlueprintPath: generationSeed.localBlueprintPath
        }
      : null,
    structureEncoding: summarizeEncoding(refinedEncoding || initialEncoding),
    initial: initialAttempt ? summarizeAestheticAttempt(initialAttempt) : null,
    final: finalAesthetic ? summarizeAestheticEvaluation(finalAesthetic) : (finalAttempt ? summarizeAestheticAttempt(finalAttempt) : null),
    refinement: {
      refined: refinement?.refined === true,
      iterations: refinement?.iterations || 0,
      operations: refinement?.operations || []
    },
    contrast,
    accepted: finalAesthetic?.accepted === true,
    threshold: finalAesthetic?.threshold ?? finalAttempt?.threshold ?? null,
    similarityThreshold: finalAesthetic?.similarityThreshold ?? finalAttempt?.similarityThreshold ?? null
  }
}

function isArchitecturalAestheticTarget(blueprintName, selected = {}, blueprint = {}, options = {}) {
  if (options.aesthetic?.required === true) return true
  if (options.aesthetic?.required === false) return false
  if (selected.sourceKind === 'community_index') return true
  const text = [
    blueprintName,
    selected.blueprintName,
    selected.requestedName,
    selected.style,
    selected.buildingType,
    blueprint.name,
    blueprint.metadata?.style,
    blueprint.metadata?.buildingType
  ].filter(Boolean).join(' ').toLowerCase()
  if (/(house|shelter|villa|castle|farmhouse|manor|modern|wood|starter|survival)/.test(text)) return true
  const solidCount = (blueprint.blocks || []).filter(block => block && !isAirName(block.type)).length
  return solidCount >= 32
}

function selectCommunityGenerationSeed(community, request = {}) {
  const targetText = [
    request.blueprintName,
    request.type,
    request.style,
    request.selected?.blueprintName,
    request.selected?.buildingType
  ].filter(Boolean).join(' ').toLowerCase()
  if (!/(modern|villa)/.test(targetText)) return null
  return (community?.samples || []).find(sample =>
    sample?.sourceKind === 'real_community_import' &&
    sample?.blueprint &&
    String(sample.importStatus || '').startsWith('verified') &&
    /(modern|villa)/.test(`${sample.category || ''} ${sample.style || ''} ${sample.buildingType || ''} ${sample.buildTitle || ''}`.toLowerCase())
  ) || null
}

function blueprintFromCommunityGenerationSeed(seed, blueprintName) {
  return {
    ...seed.blueprint,
    name: blueprintName || seed.blueprint?.name || seed.id,
    metadata: {
      ...(seed.blueprint?.metadata || {}),
      sourceKind: 'real_community_import',
      communityGenerationSeed: {
        id: seed.id,
        importedBlueprintName: seed.blueprint?.name || null,
        source: seed.source,
        sourcePageIdentifier: seed.sourcePageIdentifier,
        author: seed.author,
        buildTitle: seed.buildTitle,
        structureFileFormat: seed.structureFileFormat,
        cacheHash: seed.cacheHash,
        importStatus: seed.importStatus,
        note: 'This blueprint is seeded from a verified real community import; requested name is preserved for build routing and validation.'
      }
    }
  }
}

function summarizeEncoding(encoding) {
  if (!encoding?.ok) return null
  return {
    nodes: encoding.graph?.nodes?.length || 0,
    edges: encoding.graph?.edges?.length || 0,
    heightVariance: encoding.features?.heightVariance,
    symmetryRatio: encoding.features?.symmetryRatio,
    facadeComplexity: encoding.features?.facadeComplexity,
    densityVariance: encoding.features?.densitySummary?.variance,
    blockDistribution: encoding.features?.blockDistribution,
    shape: {
      footprintFill: encoding.features?.shape?.footprintFill,
      uniqueColumnHeights: encoding.features?.shape?.uniqueColumnHeights,
      roofLevels: encoding.features?.shape?.roofLevels
    }
  }
}

function faithfulAestheticPlan({ selected = {}, encoding, validation }) {
  const summary = summarizeEncoding(encoding)
  return {
    enabled: false,
    layer: 'faithful_community_import',
    skipped: true,
    reason: 'faithful_community_import_preserves_source_blocks',
    accepted: validation?.ok === true,
    threshold: null,
    similarityThreshold: null,
    community: {
      source: 'verified_real_community_cache',
      realCommunity: true,
      fallbackUsed: false,
      evidence: {
        sourceMode: selected.sourceMode || null,
        cacheHash: selected.cacheHash || null,
        structureFileFormat: selected.structureFileFormat || null,
        localRawPath: selected.localRawPath || null,
        localBlueprintPath: selected.localBlueprintPath || null
      },
      sampleCount: 1,
      samples: [{
        id: selected.id || null,
        blueprintName: selected.blueprintName || null,
        sourceKind: selected.sourceKind || null,
        author: selected.author || null,
        buildTitle: selected.buildTitle || null,
        cacheHash: selected.cacheHash || null,
        structureFileFormat: selected.structureFileFormat || null,
        importStatus: selected.importStatus || null,
        sourceMode: selected.sourceMode || null
      }]
    },
    initial: {
      accepted: validation?.ok === true,
      aesthetic_score: null,
      similarity_to_good_builds: null,
      penalties: []
    },
    final: {
      accepted: validation?.ok === true,
      aesthetic_score: null,
      similarity_to_good_builds: null,
      metrics: validation?.metrics || null
    },
    refinement: {
      refined: false,
      iterations: 0,
      operations: []
    },
    structureEncoding: summary,
    faithfulValidation: validation
  }
}

function summarizeAestheticAttempt(attempt) {
  return {
    iteration: attempt.iteration,
    aesthetic_score: attempt.aesthetic_score,
    similarity_to_good_builds: attempt.similarity_to_good_builds,
    accepted: attempt.accepted,
    threshold: attempt.threshold,
    similarityThreshold: attempt.similarityThreshold,
    bestMatch: attempt.bestMatch,
    penalties: attempt.penalties,
    metrics: attempt.metrics
  }
}

function summarizeAestheticEvaluation(evaluation) {
  return {
    aesthetic_score: evaluation.aesthetic_score,
    similarity_to_good_builds: evaluation.similarity_to_good_builds,
    similarity_average_top3: evaluation.similarity_average_top3,
    accepted: evaluation.accepted,
    threshold: evaluation.threshold,
    similarityThreshold: evaluation.similarityThreshold,
    bestMatch: evaluation.bestMatch,
    penalties: evaluation.penalties,
    metrics: {
      footprintFill: evaluation.metrics?.footprintFill,
      uniqueColumnHeights: evaluation.metrics?.uniqueColumnHeights,
      heightVariance: evaluation.metrics?.heightVariance,
      facadeComplexity: evaluation.metrics?.facadeComplexity,
      facadeLayerCount: evaluation.metrics?.facadeLayerCount,
      windowGroups: evaluation.metrics?.windowGroups,
      materialDiversity: evaluation.metrics?.materialDiversity,
      nodeCount: evaluation.metrics?.nodeCount,
      symmetryRatio: evaluation.metrics?.symmetryRatio
    }
  }
}

function summarizeContrastEntry({ label, sourceKind, blueprint, hardGate, encoding, evaluation, sample = null }) {
  const hardMetrics = hardGate?.metrics || {}
  const aestheticMetrics = evaluation?.metrics || {}
  const encodingFeatures = encoding?.features || {}
  const graph = encoding?.graph || {}
  const nodeCount = aestheticMetrics.nodeCount ?? graph.nodes?.length ?? 0
  const facadeComplexity = aestheticMetrics.facadeComplexity ?? encodingFeatures.facadeComplexity ?? null
  const heightVariance = aestheticMetrics.heightVariance ?? encodingFeatures.heightVariance ?? null
  const roofLevels = aestheticMetrics.roofLevelCount ?? encodingFeatures.shape?.roofLevels?.length ?? null

  return {
    label,
    sourceKind,
    sampleId: sample?.id || null,
    author: sample?.author || null,
    title: sample?.buildTitle || blueprint?.name || null,
    format: sample?.structureFileFormat || null,
    cacheHash: sample?.cacheHash || null,
    blueprintName: blueprint?.name || null,
    hardConstraintsOk: hardGate?.ok === true,
    enclosure: {
      enclosed: hardMetrics.shellLeakCount === 0 && hardMetrics.exposedInteriorCells === 0,
      shellLeakCount: hardMetrics.shellLeakCount ?? null,
      exposedInteriorCells: hardMetrics.exposedInteriorCells ?? null
    },
    stories: hardMetrics.detectedStories ?? null,
    usableFloorArea: hardMetrics.usableInteriorVolume ?? null,
    doors: hardMetrics.actualDoorCount ?? null,
    stairContinuity: hardMetrics.continuousStairPath === true,
    roofCoverage: hardMetrics.roofCoverage ?? null,
    functionalReachability: {
      rooms: hardMetrics.allRequiredRoomsReachable === true,
      functionalBlocks: hardMetrics.allFunctionalBlocksUsable === true
    },
    materialCoherence: summarizeMaterialCoherence(encoding, aestheticMetrics),
    structuralComplexity: {
      nodeCount,
      facadeComplexity,
      heightVariance,
      roofLevels
    },
    aestheticScore: evaluation?.aesthetic_score ?? null,
    similarityToCommunity: evaluation?.similarity_to_good_builds ?? null
  }
}

function summarizeMaterialCoherence(encoding, aestheticMetrics = {}) {
  const distribution = encoding?.features?.blockDistribution || {}
  const entries = Object.entries(distribution).sort((a, b) => b[1] - a[1])
  const dominant = entries[0] || [null, null]
  return {
    dominantMaterial: dominant[0],
    dominantRatio: roundMetric(dominant[1]),
    materialDiversity: aestheticMetrics.materialDiversity ?? entries.length
  }
}

function roundMetric(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null
}

function aestheticFailureReason(evaluation) {
  if (!evaluation) return 'aesthetic_score_missing'
  if (evaluation.aesthetic_score < evaluation.threshold) return 'aesthetic_score_below_threshold'
  if (evaluation.similarity_to_good_builds < evaluation.similarityThreshold) return 'community_similarity_below_threshold'
  const hard = evaluation.penalties?.find(penalty => penalty.hard)
  return hard ? `aesthetic_hard_penalty:${hard.code}` : 'aesthetic_rejected'
}

function shouldSkipLocalScaffolding(blueprint, request = {}, requireAestheticGate = false) {
  if (!requireAestheticGate) return false
  if (!blueprint?.blocks?.length) return false
  if (blueprint.metadata?.requiresScaffolding === true) return false

  const solid = blueprint.blocks.filter(block => block && !isAirName(block.type))
  if (!solid.length) return false
  const bounds = solid.reduce((acc, block) => ({
    minY: Math.min(acc.minY, block.y),
    maxY: Math.max(acc.maxY, block.y)
  }), {
    minY: solid[0].y,
    maxY: solid[0].y
  })
  const height = bounds.maxY - bounds.minY + 1
  if (height <= 5) return true

  const design = blueprint.metadata?.design || {}
  const selected = request.selected || {}
  const type = String(
    request.type ||
    selected.buildingType ||
    design.buildingType ||
    blueprint.metadata?.buildingType ||
    ''
  ).toLowerCase()
  const name = String(blueprint.name || request.blueprintName || '').toLowerCase()
  const residential = /house|cabin|villa|home|farmhouse/.test(`${type} ${name}`)
  const verticalComplex = /castle|tower|wall|fort|keep/.test(`${type} ${name}`)
  if (!residential || verticalComplex) return false
  return height <= 7
}

function summarizeMaterialPlan(plan) {
  if (!plan) return null
  return {
    requiredMaterials: plan.requiredMaterials,
    formalRequiredMaterials: plan.formalRequiredMaterials,
    foundationMaterial: plan.foundationMaterial,
    foundationRequiredMaterials: plan.foundationRequiredMaterials,
    scaffoldMaterial: plan.scaffoldMaterial,
    scaffoldRequiredMaterials: plan.scaffoldRequiredMaterials,
    missingMaterials: plan.missingMaterials
  }
}

function summarizeBlueprintIR(blueprintIR) {
  if (!blueprintIR) return null
  return {
    schemaVersion: blueprintIR.schemaVersion,
    id: blueprintIR.id,
    name: blueprintIR.name,
    blockCount: blueprintIR.blocks?.length || 0,
    bounds: blueprintIR.bounds || null,
    phases: [...new Set((blueprintIR.blocks || []).map(block => block.phase))],
    frozen: Object.isFrozen(blueprintIR)
  }
}

function summarizeConstructionPlan(plan) {
  if (!plan) return null
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    blueprintId: plan.blueprintId,
    blueprintRevision: plan.blueprintRevision || null,
    blueprintHash: plan.blueprintHash || null,
    phaseCount: plan.phases?.length || 0,
    stepCount: plan.steps?.length || 0,
    materialCount: Object.keys(plan.materials?.required || {}).length,
    missingMaterialCount: plan.materials?.missing?.length || 0,
    diagnosticCount: plan.diagnostics?.length || 0
  }
}

function createFrozenDesignArtifacts({
  request,
  selected,
  blueprint,
  blueprintIR,
  constructionPlan,
  designPlan,
  layoutPlan,
  interiorPlan,
  habitabilityHardGate,
  materialPlan,
  source
}) {
  const designSpec = createDesignSpec({
    request,
    selectedBlueprint: selected,
    blueprint,
    blueprintIR,
    constructionPlan,
    designPlan,
    layoutPlan,
    interiorPlan,
    habitabilityHardGate,
    materialPlan,
    source
  })
  const blueprintFreeze = createBlueprintFreezeRecord({
    designSpec,
    blueprintIR,
    constructionPlan
  })
  return {
    designSpec,
    blueprintFreeze,
    blueprintIR: freezeBlueprintIR(blueprintIR, blueprintFreeze)
  }
}

function constructionRunArtifactsFromPreview(preview, criteria) {
  const materialStats = materialStatsFromPreview(preview)
  const designSpec = preview.designSpec || createDesignSpec({
    blueprint: preview.blueprint,
    blueprintIR: preview.blueprintIR,
    constructionPlan: preview.constructionPlan,
    designPlan: preview.designPlan,
    layoutPlan: preview.layoutPlan,
    interiorPlan: preview.interiorPlan,
    habitabilityHardGate: preview.habitabilityHardGate,
    materialPlan: preview.materialPlan,
    selectedBlueprint: preview.selectedBlueprint,
    source: 'construction_run_prepare'
  })
  const blueprintFreeze = preview.blueprintFreeze || createBlueprintFreezeRecord({
    designSpec,
    blueprintIR: preview.blueprintIR,
    constructionPlan: preview.constructionPlan
  })
  const frozenBlueprintIR = preview.blueprintIR?.metadata?.frozen === true
    ? clonePlainObject(preview.blueprintIR)
    : freezeBlueprintIR(preview.blueprintIR, blueprintFreeze)
  const lifecycle = createConstructionLifecycle({
    currentPhase: 'site_prepare',
    designSpec,
    blueprintFreeze,
    materialStats,
    materialPlan: preview.materialPlan,
    constructionPlan: preview.constructionPlan,
    placementContext: criteria.placementContext,
    stagingChests: criteria.stagingChests
  })
  return {
    designSpec,
    blueprintFreeze,
    frozenBlueprintIR,
    materialStats,
    lifecycle
  }
}

function materialStatsFromPreview(preview = {}) {
  return {
    totalBlocks: preview.totalBlocks || 0,
    required: clonePlainObject(preview.materialPlan?.requiredMaterials || preview.requiredMaterials || {}),
    formalRequired: clonePlainObject(preview.materialPlan?.formalRequiredMaterials || preview.formalRequiredMaterials || {}),
    missing: clonePlainObject(preview.materialPlan?.missingMaterials || preview.missingMaterials || []),
    planMaterialCount: Object.keys(preview.constructionPlan?.materials?.required || {}).length
  }
}

function createConstructionArchive(session, completedAt) {
  const startedAtMs = Date.parse(session.startedAt || '')
  const completedAtMs = Date.parse(completedAt || '')
  return {
    schemaVersion: 1,
    archivedAt: completedAt,
    designSpec: clonePlainObject(session.designSpec || session.constructionRun?.designSpec || null),
    blueprintIR: clonePlainObject(session.blueprintIR || session.constructionRun?.frozenBlueprintIR || null),
    materialStats: clonePlainObject(session.constructionRun?.materialStats || materialStatsFromPreview(session)),
    actualDurationMs: Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
      ? Math.max(0, completedAtMs - startedAtMs)
      : null,
    failuresAndRepairs: failureAndRepairRecords(session.constructionRun),
    siteCleanup: clonePlainObject(session.siteCleanup || null),
    materialSubstitutions: clonePlainObject(
      session.materialPlan?.materialSubstitutions ||
        session.blueprintIR?.metadata?.materialSubstitutions ||
        []
    )
  }
}

function failureAndRepairRecords(run) {
  return Object.values(run?.steps || {})
    .filter(step => {
      const retryCount = Number(step.retry?.count || 0)
      return retryCount > 0 || ['repair', 'state_repair', 'retryable_failed', 'terminal_failed'].includes(step.status)
    })
    .map(step => ({
      stepId: step.id,
      status: step.status,
      lifecyclePhase: step.lifecyclePhase || step.phase || null,
      retry: clonePlainObject(step.retry || null),
      target: clonePlainObject(step.target || null),
      block: clonePlainObject(step.block || null)
    }))
}

function summarizeDesignSpec(spec) {
  if (!spec) return null
  return {
    designSpecId: spec.designSpecId || null,
    revision: spec.revision || null,
    hash: spec.hash || null,
    frozen: spec.frozen === true,
    buildingType: spec.buildingType || null,
    style: spec.style || null,
    width: spec.width || null,
    depth: spec.depth || null,
    height: spec.height || null,
    floors: spec.floors || null,
    entranceDirection: spec.entranceDirection || null,
    roomCount: spec.roomLayout?.rooms?.length || 0,
    functionalPointCount: spec.functionalPoints?.length || 0,
    roofType: spec.roofType || null,
    primaryMaterials: spec.primaryMaterials || [],
    habitabilityRequirements: spec.habitabilityRequirements || null,
    complexityTier: spec.complexityTier || null,
    maxFootprint: spec.maxFootprint || null,
    maxFloors: spec.maxFloors || null,
    minBlockBudget: spec.minBlockBudget || null,
    maxBlockBudget: spec.maxBlockBudget || null,
    maxMaterialTypes: spec.maxMaterialTypes || null,
    maxRareMaterials: spec.maxRareMaterials || null,
    decorationLevel: spec.decorationLevel || null,
    roofComplexity: spec.roofComplexity || null,
    interiorComplexity: spec.interiorComplexity || null,
    expectedBuildTimeClass: spec.expectedBuildTimeClass || null,
    survivalFriendly: spec.survivalFriendly === true,
    allowRareDecorations: spec.allowRareDecorations === true,
    allowComplexStairStates: spec.allowComplexStairStates === true,
    allowHangingLanterns: spec.allowHangingLanterns === true,
    allowCake: spec.allowCake === true,
    allowFlowerPots: spec.allowFlowerPots === true,
    allowExactDecorativePlants: spec.allowExactDecorativePlants === true,
    complexityConfirmationRequired: spec.complexityConfirmationRequired === true
  }
}

function summarizeMaterialStats(stats) {
  if (!stats) return null
  return {
    totalBlocks: stats.totalBlocks || 0,
    requiredMaterialCount: Object.keys(stats.required || {}).length,
    missingMaterialCount: Array.isArray(stats.missing) ? stats.missing.length : 0,
    planMaterialCount: stats.planMaterialCount || 0
  }
}

function summarizeConstructionArchive(archive) {
  if (!archive) return null
  return {
    archivedAt: archive.archivedAt || null,
    designSpec: summarizeDesignSpec(archive.designSpec),
    hasBlueprintIR: Boolean(archive.blueprintIR),
    materialStats: summarizeMaterialStats(archive.materialStats),
    actualDurationMs: archive.actualDurationMs ?? null,
    failureOrRepairCount: archive.failuresAndRepairs?.length || 0,
    siteCleanup: archive.siteCleanup ? {
      ok: archive.siteCleanup.ok === true,
      stagingChestActions: archive.siteCleanup.stagingChests?.map(entry => entry.action) || []
    } : null,
    materialSubstitutionCount: archive.materialSubstitutions?.length || 0
  }
}

function startupPhaseGateFromStorageReconciliation(storage, sessionId) {
  if (!storage || storage.ok !== true || storage.skipped === true || !storage.checkedPhase) return null
  if (Array.isArray(storage.missing) && storage.missing.length) return null
  const phase = normalizeConstructionPhase(storage.checkedPhase || 'site_prepare')
  return {
    ok: true,
    phase,
    sessionId,
    dependenciesVerified: true,
    materialsVerified: true,
    startupStorageReconciled: true,
    requirements: clonePlainObject(storage.phaseRequirements || {}),
    inventory: clonePlainObject(storage.inventory || {}),
    missing: [],
    checkedAt: new Date().toISOString()
  }
}

function summarizeConstructionRun(run) {
  if (!run) return null
  const statusCounts = {}
  for (const step of Object.values(run.steps || {})) {
    const status = step.status || 'unknown'
    statusCounts[status] = (statusCounts[status] || 0) + 1
  }
  return {
    runId: run.runId,
    blueprintId: run.blueprintId,
    blueprintRevision: run.blueprintRevision || null,
    blueprintHash: run.blueprintHash || null,
    planId: run.planId,
    placementContext: run.placementContext || null,
    world: run.world || null,
    bounds: run.bounds || null,
    stagingChests: run.stagingChests || [],
    currentPhase: run.currentPhase || null,
    lifecycle: run.lifecycle || null,
    designSpec: summarizeDesignSpec(run.designSpec),
    blueprintFreeze: run.blueprintFreeze || null,
    materialStats: summarizeMaterialStats(run.materialStats),
    archive: summarizeConstructionArchive(run.archive),
    status: run.status,
    terminalState: run.terminalState || null,
    statusCounts,
    reconciliation: run.reconciliation || null,
    retry: run.retry || null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  }
}

function summarizeWorldDiffResult(result) {
  if (!result) return null
  return {
    missingBlocks: result.missingBlocks?.length || 0,
    wrongBlocks: result.wrongBlocks?.length || 0,
    wrongStates: result.wrongStates?.length || 0,
    extraBlocks: result.extraBlocks?.length || 0,
    unreachableFunctionalPoints: result.unreachableFunctionalPoints?.length || 0,
    scaffoldResidue: result.scaffoldResidue?.length || 0,
    diagnostics: result.diagnostics?.length || 0
  }
}

function summarizeInteriorPlan(plan) {
  if (!plan) return null
  return {
    enabled: plan.enabled,
    profile: plan.profile,
    rooms: plan.rooms?.map(room => ({ id: room.id, zone: room.zone })) || [],
    placementCount: plan.placements?.length || 0,
    placements: (plan.placements || []).map(placement => ({
      role: placement.role,
      type: placement.type,
      roomId: placement.roomId || null,
      zone: placement.zone || null
    })),
    skipped: plan.skipped || [],
    complete: plan.complete,
    pathPreserved: plan.pathPreserved,
    source: plan.source
  }
}

function summarizeLayoutPlan(plan) {
  if (!plan) return null
  return {
    enabled: plan.enabled,
    style: plan.style,
    profile: plan.profile,
    minMainPathWidth: plan.minMainPathWidth,
    roomCount: plan.rooms?.length || 0,
    rooms: (plan.rooms || []).map(room => ({
      id: room.id,
      zone: room.zone,
      entrance: room.entrance || null
    })),
    entrances: plan.entrances?.length || 0,
    pathCells: plan.pathCells?.length || 0,
    stairs: (plan.stairs || []).map(stair => ({
      id: stair.id,
      width: stair.width,
      lowerCells: stair.lowerCells?.length || 0,
      upperCells: stair.upperCells?.length || 0
    })),
    functionalTargets: (plan.functionalTargets || []).map(target => ({
      role: target.role,
      type: target.type,
      accessCells: target.accessCells?.length || 0
    })),
    complete: plan.complete
  }
}

function summarizeWalkability(result) {
  if (!result) return null
  return {
    ok: result.ok === true,
    enabled: result.enabled !== false,
    failures: result.failures || [],
    summary: result.summary || null
  }
}

function summarizeDesignPlan(plan, diagnostics = {}) {
  if (!plan) return null
  const styleValidation = plan.styleValidation || diagnostics.styleValidation || null
  const facadeValidation = plan.facadeValidation || diagnostics.facadeValidation || null
  const metrics = styleValidation?.metrics || facadeValidation?.metrics || plan.silhouette?.after || null
  return {
    enabled: true,
    layer: plan.layer || 'design',
    style: plan.style || null,
    buildingType: plan.buildingType || null,
    transformed: plan.transformed === true || diagnostics.transformed === true,
    reason: plan.reason || diagnostics.reason || null,
    silhouette: plan.silhouette ? {
      footprintShape: plan.silhouette.footprintShape,
      heightVariation: plan.silhouette.heightVariation,
      roofLevels: plan.silhouette.roofLevels,
      protrusions: plan.silhouette.protrusions,
      recesses: plan.silhouette.recesses,
      avoidsPureBox: plan.silhouette.avoidsPureBox === true
    } : null,
    volumeCount: plan.volumeSegmentation?.length || 0,
    roofType: plan.roofType || null,
    symmetryRules: plan.symmetryRules || null,
    facadeLayout: plan.facadeLayout || null,
    styleValidation: styleValidation ? {
      ok: styleValidation.ok === true,
      violations: styleValidation.violations || []
    } : null,
    facadeValidation: facadeValidation ? {
      ok: facadeValidation.ok === true,
      violations: facadeValidation.violations || []
    } : null,
    metrics: metrics ? {
      footprintFill: metrics.footprintFill,
      uniqueColumnHeights: metrics.uniqueColumnHeights,
      roofLevels: metrics.roofLevels,
      windowGroups: metrics.windowGroups,
      volumeCount: metrics.volumeCount,
      pureBox: metrics.isPureBox,
      towerBlocks: metrics.towerBlocks,
      battlementBlocks: metrics.battlementBlocks,
      facadeLayerCount: metrics.facadeLayerCount
    } : null
  }
}

function summarizeCandidates(candidates = [], attempted = []) {
  return {
    top: candidates.slice(0, 5).map(candidate => ({
      id: candidate.id,
      blueprintName: candidate.blueprintName,
      sourceKind: candidate.sourceKind,
      score: candidate.score,
      reasons: candidate.rank?.reasons || []
    })),
    attempted
  }
}

function logSelection(context, requested, preview) {
  const selected = preview.selectedBlueprint
  if (!selected) return
  logBuilding(context, `[BLUEPRINT_CANDIDATES] request=${requested || 'unknown'} top=${JSON.stringify(preview.candidateSummary?.top || [])}`)
  logBuilding(context, `[BLUEPRINT_SELECTED] request=${requested || 'unknown'} selected=${selected.blueprintName} source=${selected.sourceKind || 'unknown'} score=${selected.score ?? 'unknown'} fallback=${selected.fallback === true}`)
  logBuilding(context, `[BUILD_PIPELINE_STAGE] stage=select_blueprint status=ok selected=${selected.blueprintName} source=${selected.sourceKind || 'unknown'}`)
  logBuilding(context, `[BUILD_PIPELINE_STAGE] stage=parse_structure status=ok blocks=${preview.blueprint?.blocks?.length || 0}`)
}

function logDesign(context, preview) {
  const design = preview.designPlan
  if (!design) return
  const summary = summarizeDesignPlan(design, preview.designDiagnostics)
  logBuilding(context, `[BUILD_PIPELINE_STAGE] stage=design_transformation status=ok style=${summary.style || 'unknown'} transformed=${summary.transformed === true} reason=${summary.reason || 'none'} footprintFill=${summary.metrics?.footprintFill ?? 'unknown'} pureBox=${summary.metrics?.pureBox === true}`)
  logBuilding(context, `[BUILD_PIPELINE_STAGE] stage=validate_style_grammar status=${summary.styleValidation?.ok ? 'ok' : 'failed'} violations=${JSON.stringify(summary.styleValidation?.violations || [])}`)
  logBuilding(context, `[BUILD_DESIGN] blueprint=${preview.blueprintName} style=${summary.style || 'unknown'} type=${summary.buildingType || 'unknown'} silhouette=${summary.silhouette?.footprintShape || 'unknown'} volumes=${summary.volumeCount} roof=${summary.roofType || 'unknown'} transformed=${summary.transformed === true}`)
  logBuilding(context, `[BUILD_STYLE_GRAMMAR] blueprint=${preview.blueprintName} ok=${summary.styleValidation?.ok === true} style=${summary.style || 'unknown'} violations=${JSON.stringify(summary.styleValidation?.violations || [])}`)
  logBuilding(context, `[BUILD_FACADE_PASS] blueprint=${preview.blueprintName} ok=${summary.facadeValidation?.ok === true} windows=${summary.metrics?.windowGroups ?? 0} layers=${summary.metrics?.facadeLayerCount ?? 0} pureBox=${summary.metrics?.pureBox === true}`)
}

function logAesthetic(context, preview) {
  const plan = preview.aestheticPlan
  if (!plan) return
  const initial = plan.initial || {}
  const final = plan.final || {}
  const encoding = plan.structureEncoding || {}
  logBuilding(context, `[BUILD_COMMUNITY_SAMPLES] blueprint=${preview.blueprintName} count=${plan.community?.sampleCount || 0} samples=${JSON.stringify(plan.community?.samples || [])}`)
  logBuilding(context, `[BUILD_PIPELINE_STAGE] stage=structure_encoding status=ok nodes=${encoding.nodes ?? 0} edges=${encoding.edges ?? 0} heightVariance=${encoding.heightVariance ?? 0} facadeComplexity=${encoding.facadeComplexity ?? 0} symmetry=${encoding.symmetryRatio ?? 0}`)
  logBuilding(context, `[BUILD_STRUCTURE_ENCODING] blueprint=${preview.blueprintName} nodes=${encoding.nodes ?? 0} edges=${encoding.edges ?? 0} heightVariance=${encoding.heightVariance ?? 0} densityVariance=${encoding.densityVariance ?? 0} footprintFill=${encoding.shape?.footprintFill ?? 'unknown'}`)
  logBuilding(context, `[BUILD_COMMUNITY_SIMILARITY] blueprint=${preview.blueprintName} similarity=${final.similarity_to_good_builds ?? 'unknown'} threshold=${plan.similarityThreshold ?? 'unknown'} best=${final.bestMatch?.id || 'unknown'}`)
  logBuilding(context, `[BUILD_AESTHETIC_SCORE] stage=initial blueprint=${preview.blueprintName} score=${initial.aesthetic_score ?? 'unknown'} similarity=${initial.similarity_to_good_builds ?? 'unknown'} accepted=${initial.accepted === true} penalties=${JSON.stringify(initial.penalties || [])}`)
  logBuilding(context, `[BUILD_AESTHETIC_REFINE] blueprint=${preview.blueprintName} refined=${plan.refinement?.refined === true} iterations=${plan.refinement?.iterations || 0} operations=${JSON.stringify(plan.refinement?.operations || [])}`)
  logBuilding(context, `[BUILD_AESTHETIC_SCORE] stage=final blueprint=${preview.blueprintName} score=${final.aesthetic_score ?? 'unknown'} similarity=${final.similarity_to_good_builds ?? 'unknown'} threshold=${plan.threshold ?? 'unknown'} similarityThreshold=${plan.similarityThreshold ?? 'unknown'} accepted=${plan.accepted === true} facadeComplexity=${final.metrics?.facadeComplexity ?? 'unknown'}`)
  logBuilding(context, `[BUILD_PIPELINE_STAGE] stage=aesthetic_scoring status=${plan.accepted ? 'ok' : 'failed'} score=${final.aesthetic_score ?? 'unknown'} similarity=${final.similarity_to_good_builds ?? 'unknown'}`)
}

function movedItemCount(result, itemName, inventoryDelta = 0) {
  const fromResult = (result?.withdrawnItems || [])
    .filter(item => (item.itemName || item.name) === itemName)
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0)
  return Math.max(0, fromResult, Number(inventoryDelta) || 0)
}

function shouldUseStagedStorageRefill(context, preview, options = {}) {
  if (options.allowStorageRefill === false) return false
  if (!context?.storageSystem || typeof context.storageSystem.takeItems !== 'function') return false
  if (options.stagedStorageRefill === true) return true
  return isFaithfulCommunityImport(preview?.blueprint, preview?.selectedBlueprint)
}

function requiresStagingInventoryVerification(context, run, preview, options = {}) {
  if (options.requirePhysicalStagingChest === true || options.stagedStorageRefill === true) return true
  if (shouldUseStagedStorageRefill(context, preview, options)) return true
  return run?.stagingChestPreparation?.skipped !== true &&
    Array.isArray(run?.stagingChests) &&
    run.stagingChests.some(chest => chest?.verified === true)
}

function normalizeStagingChestRecords(chests = [], fallback = []) {
  const records = []
  const fallbackByPosition = new Map()
  for (const chest of fallback || []) {
    const position = normalizeOrigin(chest.position || chest)
    if (!position) continue
    fallbackByPosition.set(`${position.x},${position.y},${position.z}`, chest)
  }
  for (const chest of chests || []) {
    const position = normalizeOrigin(chest.position || chest)
    if (!position) continue
    const previous = fallbackByPosition.get(`${position.x},${position.y},${position.z}`) || {}
    records.push({
      position,
      source: chest.source || 'staging_inventory_scan',
      itemCount: Number(chest.itemCount || 0),
      verified: true,
      temporary: chest.temporary ?? previous.temporary ?? false
    })
  }
  if (records.length) return records
  return clonePlainObject(fallback || [])
}

function stagingChestCandidates(bounds, origin) {
  const y = Number(origin?.y ?? bounds?.minY ?? 64)
  if (!bounds) {
    const base = normalizeOrigin(origin) || { x: 0, y, z: 0 }
    return [
      { x: base.x + 3, y, z: base.z },
      { x: base.x - 3, y, z: base.z },
      { x: base.x, y, z: base.z + 3 },
      { x: base.x, y, z: base.z - 3 }
    ]
  }
  return [
    { x: bounds.minX - 3, y, z: bounds.minZ - 4 },
    { x: bounds.maxX + 3, y, z: bounds.minZ - 4 },
    { x: bounds.minX - 3, y, z: bounds.maxZ + 4 },
    { x: bounds.maxX + 3, y, z: bounds.maxZ + 4 },
    { x: Math.floor((bounds.minX + bounds.maxX) / 2), y, z: bounds.minZ - 5 },
    { x: bounds.maxX + 4, y, z: Math.floor((bounds.minZ + bounds.maxZ) / 2) }
  ]
}

function isContainerAt(context, position) {
  const block = blockAtPosition(context, position)
  return ['chest', 'trapped_chest', 'barrel'].includes(block?.name)
}

function isAirAt(context, position) {
  const block = blockAtPosition(context, position)
  return !block || isAirName(block.name)
}

function blockAtPosition(context, position) {
  const normalized = normalizeOrigin(position)
  if (!normalized || typeof context?.bot?.blockAt !== 'function') return null
  return context.bot.blockAt(toBlockVec3(normalized))
}

function hasInventoryItem(context, itemName) {
  const live = getLiveInventoryCounts(context)
  if ((Number(live[itemName]) || 0) > 0) return true
  return (context?.bot?.inventory?.items?.() || []).some(item => (item.name || item.itemName) === itemName && Number(item.count || 0) > 0)
}

function materialStorageSearchRadius(systemOptions = {}, runOptions = {}) {
  const configured = Number(runOptions.materialStorageSearchRadius ?? runOptions.storageSearchRadius ?? systemOptions.materialStorageSearchRadius)
  return Number.isFinite(configured) && configured > 0 ? configured : 80
}

function materialStorageScanCenters(session) {
  if (!session?.origin) return []
  const radius = materialStorageAnchorRadius(session)
  const centers = [{ source: 'build_origin', position: session.origin, radius }]
  const bounds = session.reservedBounds
  if (bounds) {
    for (let index = 0; index < 4; index++) {
      centers.push({
        source: `build_storage_${index + 1}`,
        position: {
          x: bounds.minX - 3 - index * 2,
          y: session.origin.y,
          z: bounds.minZ - 4
        },
        radius
      })
    }
  }
  return centers
}

function materialStorageScanCentersForPreview(preview) {
  return materialStorageScanCenters({
    origin: preview?.origin,
    reservedBounds: preview?.worldBlocks ? createReservedBounds(preview.worldBlocks) : null
  })
}

function materialStorageScanCentersForTier(session, tier = 'all') {
  const run = session?.constructionRun || (session?.runId ? session : null)
  const fallback = materialStorageScanCenters(session)
  if (!run) return tier === 'secondary' ? [] : fallback
  const centers = constructionRunStagingCenters(run, tier, fallback)
  if (tier === 'secondary') return centers
  return centers.length ? centers : fallback
}

function storageSessionFromRun(run, preview) {
  return {
    origin: preview?.origin || run?.placementContext?.origin || run?.placementContext?.placement?.origin || null,
    reservedBounds: run?.bounds || (preview?.worldBlocks ? createReservedBounds(preview.worldBlocks) : null),
    materialStorageAnchorRadius: run?.materialStorageAnchorRadius,
    constructionRun: run
  }
}

function constructionRunStagingCenters(run, tier = 'all', fallback = []) {
  const primary = normalizeStagingChestRecords(run?.primaryStagingChests || [], [])
  const secondary = normalizeStagingChestRecords(run?.secondaryStagingChests || [], [])
  const staging = normalizeStagingChestRecords(run?.stagingChests || [], [])
  const fallbackRecords = normalizeStagingChestRecords(fallback || [], [])
  const primaryKeys = new Set(primary.map(chest => positionKey(chest.position)))
  const markedPrimary = staging.filter(chest =>
    chest.primary === true ||
    chest.temporary === true ||
    String(chest.source || '').startsWith('primary_')
  )
  const markedPrimaryKeys = new Set(markedPrimary.map(chest => positionKey(chest.position)))
  const inferredPrimary = primary.length ? primary : markedPrimary
  const inferredPrimaryKeys = new Set(inferredPrimary.map(chest => positionKey(chest.position)))
  const inferredSecondary = secondary.length
    ? secondary
    : staging.filter(chest => {
        const key = positionKey(chest.position)
        return !primaryKeys.has(key) && !markedPrimaryKeys.has(key) && !inferredPrimaryKeys.has(key)
      })

  if (tier === 'primary') {
    return dedupeStagingCenters(inferredPrimary.length ? inferredPrimary : (fallbackRecords.length ? fallbackRecords : staging))
      .map(chest => ({ ...chest, primary: chest.primary ?? true }))
  }
  if (tier === 'secondary') {
    return dedupeStagingCenters(inferredSecondary)
      .map(chest => ({ ...chest, secondary: chest.secondary ?? true, primary: false }))
  }
  return dedupeStagingCenters([
    ...inferredPrimary.map(chest => ({ ...chest, primary: chest.primary ?? true })),
    ...inferredSecondary.map(chest => ({ ...chest, secondary: chest.secondary ?? true, primary: false })),
    ...staging,
    ...fallbackRecords
  ])
}

function dedupeStagingCenters(centers = []) {
  const result = []
  const seen = new Set()
  for (const center of centers || []) {
    const position = normalizeOrigin(center?.position || center)
    if (!position) continue
    const key = positionKey(position)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      ...center,
      position,
      radius: center.radius,
      source: center.source || 'staging_chest'
    })
  }
  return result
}

function mergeMaterialCounts(...maps) {
  const merged = {}
  for (const map of maps || []) {
    for (const [itemName, count] of Object.entries(map || {})) {
      const numeric = Number(count) || 0
      if (numeric > 0) merged[itemName] = (merged[itemName] || 0) + numeric
    }
  }
  return merged
}

function liveInventoryCountsIncludingHeld(context) {
  const counts = { ...getLiveInventoryCounts(context) }
  const held = context?.bot?.heldItem
  if (held?.name && (Number(counts[held.name]) || 0) <= 0) {
    counts[held.name] = Math.max(1, Number(held.count) || 1)
  }
  return counts
}

function inventoryBatchSnapshot(context) {
  const counts = liveInventoryCountsIncludingHeld(context)
  const emptySlots = liveInventoryEmptySlotCount(context)
  const totalSlots = 36
  const held = context?.bot?.heldItem
  return {
    counts,
    emptySlots,
    usedSlots: Math.max(0, totalSlots - emptySlots),
    totalSlots,
    heldItem: held?.name || null,
    heldItemCount: held?.name ? Math.max(1, Number(held.count) || 1) : 0
  }
}

function inventoryBatchStillValid(active, session, step) {
  if (!active?.batchId || !session || !step) return false
  if (active.phase && active.phase !== normalizeConstructionPhase(step.phase, step)) return false
  const index = Number(session.currentStepIndex) || 0
  return Number(active.untilStepIndex) > index
}

function inventoryBatchRestockReason(session, step, currentItems, context, options = {}) {
  if (options.forceRestockReason) return options.forceRestockReason
  const currentRequirements = itemRequirementsForStep(step)
  if (Object.entries(currentRequirements).some(([itemName, count]) => inventoryItemCount(context, itemName) < count)) {
    return 'current_step_material_missing'
  }
  const active = session?.inventoryBatchState || session?.constructionRun?.batchMaterialPlan
  if (!active?.batchId) return 'batch_start'
  const phase = normalizeConstructionPhase(step.phase, step)
  if (active.phase && active.phase !== phase) return 'phase_changed'
  if ((Number(session.currentStepIndex) || 0) >= Number(active.untilStepIndex || 0)) return 'batch_ended'
  for (const itemName of Object.keys(active.materialsNeeded || {})) {
    if (inventoryItemCount(context, itemName) <= 0) return 'planned_batch_material_exhausted'
  }
  return null
}

function createInventoryBatchPlan(session, currentStep, inventoryCounts, options = {}, context = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.inventoryBatchStepLimit) || 100))
  const phase = normalizeConstructionPhase(currentStep?.phase, currentStep)
  const plannedSteps = []
  const required = {}
  const repairRetryReserve = {}
  const runSteps = session?.constructionRun?.steps || {}
  const startIndex = Number(session?.currentStepIndex) || 0
  for (let index = startIndex; index < (session?.steps || []).length && plannedSteps.length < limit; index++) {
    const step = session.steps[index]
    if (!step || !['foundation_fill', 'scaffold_place', 'place'].includes(constructionStepKind(step))) continue
    if (normalizeConstructionPhase(step.phase, step) !== phase) continue
    const state = runSteps[step.id]
    if (isStepVerified(state)) continue
    const hydratedStep = state ? hydrateRuntimeStepFromStoredRunStep(step, state) : step
    if (shouldDeferFragilePlacementStep(session, hydratedStep, state)) continue
    const itemRequirements = itemRequirementsForStep(hydratedStep)
    plannedSteps.push({ id: hydratedStep.id, index, itemNames: Object.keys(itemRequirements) })
    for (const [itemName, count] of Object.entries(itemRequirements)) {
      required[itemName] = (required[itemName] || 0) + count
      if (isRepairExecutionStatus(state?.status)) repairRetryReserve[itemName] = 1
    }
  }

  const baseRequiredMaterials = { ...required }
  for (const [itemName, count] of Object.entries(repairRetryReserve)) {
    required[itemName] = (required[itemName] || 0) + count
  }

  const materialsNeeded = {}
  for (const [itemName, count] of Object.entries(required)) {
    const missing = Math.max(0, count - (Number(inventoryCounts[itemName]) || 0))
    if (missing > 0) materialsNeeded[itemName] = missing
  }
  const currentRequirements = itemRequirementsForStep(currentStep)
  const priorityItems = Object.entries(currentRequirements)
    .filter(([itemName, count]) => (Number(inventoryCounts[itemName]) || 0) < (Number(count) || 0))
    .map(([itemName]) => itemName)
  const withdrawals = capBatchWithdrawalsToInventorySlots(context, materialsNeeded, inventoryCounts, {
    ...options,
    priorityItems
  })
  const firstIndex = plannedSteps[0]?.index ?? startIndex
  const lastIndex = plannedSteps.at(-1)?.index ?? startIndex
  return {
    batchId: `batch_${Date.now()}_${startIndex}`,
    phase,
    fromStepIndex: firstIndex,
    untilStepIndex: lastIndex + 1,
    plannedStepIds: plannedSteps.map(step => step.id),
    plannedSteps,
    requiredMaterials: required,
    baseRequiredMaterials,
    repairRetryReserve,
    materialsNeeded,
    withdrawals,
    reservedSlots: {
      empty: reservedEmptySlots(options),
      tools: 2,
      food: 1,
      temporarySafetyBlocks: 2
    },
    expectedStepsBeforeRestock: plannedSteps.length,
    restockThreshold: 'current_step_material_missing OR planned_batch_material_exhausted OR phase_changed OR batch_ended OR material_index_expired'
  }
}

function capBatchWithdrawalsToInventorySlots(context, materialsNeeded, inventoryCounts, options = {}) {
  const emptySlots = liveInventoryEmptySlotCount(context)
  const priorityItems = new Set((options.priorityItems || []).filter(Boolean))
  const prioritySlotsNeeded = [...priorityItems].reduce((total, itemName) => {
    if ((Number(inventoryCounts[itemName]) || 0) > 0) return total
    const needed = Number(materialsNeeded?.[itemName]) || 0
    if (needed <= 0) return total
    return total + 1
  }, 0)
  // Reserved space must not prevent the current step from obtaining its own
  // missing item. Borrow only the slots needed by priority items; later batch
  // materials still obey the normal reserve.
  let availableSlots = Math.max(
    Math.max(0, emptySlots - reservedEmptySlots(options)),
    Math.min(emptySlots, prioritySlotsNeeded)
  )
  const withdrawals = []
  const entries = Object.entries(materialsNeeded || {})
    .sort((a, b) => {
      const priorityDelta = Number(priorityItems.has(b[0])) - Number(priorityItems.has(a[0]))
      if (priorityDelta !== 0) return priorityDelta
      return (b[1] - a[1]) || a[0].localeCompare(b[0])
    })
  for (const [itemName, needed] of entries) {
    if (needed <= 0) continue
    const stackSize = itemStackSizeForContext(context, itemName)
    const inventoryCount = Number(inventoryCounts[itemName]) || 0
    const remainder = inventoryCount > 0 ? inventoryCount % stackSize : 0
    const freeInExistingStack = remainder > 0 ? stackSize - remainder : 0
    const countWithoutNewSlot = Math.min(needed, freeInExistingStack)
    let remaining = Math.max(0, needed - countWithoutNewSlot)
    const slotsNeeded = Math.min(availableSlots, Math.ceil(remaining / stackSize))
    const countWithNewSlots = Math.min(remaining, slotsNeeded * stackSize)
    const count = countWithoutNewSlot + countWithNewSlots
    if (count <= 0) continue
    if (countWithNewSlots > 0) availableSlots -= slotsNeeded
    withdrawals.push({ item: itemName, count })
  }
  return withdrawals
}

function reservedEmptySlots(options = {}) {
  const configured = Number(options.reservedEmptyInventorySlots)
  return Number.isFinite(configured) && configured >= 0 ? configured : 2
}

function appendUniquePositions(target, positions = []) {
  const seen = new Set(target.map(pos => formatPos(pos)))
  for (const position of positions || []) {
    const normalized = normalizeOrigin(position)
    if (!normalized) continue
    const key = formatPos(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    target.push(normalized)
  }
}

function stepsSinceLastRestock(session) {
  const plan = session?.constructionRun?.batchMaterialPlan || session?.inventoryBatchState
  if (!plan) return 0
  return Math.max(0, (Number(session.currentStepIndex) || 0) - (Number(plan.fromStepIndex) || 0))
}

function stagingMaterialIndexFromInventories({ primary = null, secondary = null, previous = null, reason = 'unknown' } = {}) {
  return {
    ...(previous || {}),
    updatedAt: new Date().toISOString(),
    reason,
    primary: primary
      ? {
          counts: primary.counts || primary || {},
          chests: primary.chests || []
        }
      : previous?.primary || null,
    secondary: secondary
      ? {
          counts: secondary.counts || secondary || {},
          chests: secondary.chests || []
        }
      : previous?.secondary || null
  }
}

function stagingMaterialIndexFromBatchRestock(restock = {}, previous = null) {
  const withdrawn = {}
  for (const item of restock.materialsWithdrawn || []) {
    withdrawn[item.item] = (withdrawn[item.item] || 0) + (Number(item.count) || 0)
  }
  return {
    ...(previous || {}),
    updatedAt: new Date().toISOString(),
    reason: 'inventory_batch_restock',
    lastWithdrawn: withdrawn,
    primaryOpenedChests: restock.primaryChestsUsed || [],
    secondaryOpenedChests: restock.secondaryChestsUsed || []
  }
}

function mergeOpenSummaries(...summaries) {
  const openedChests = []
  let openCount = 0
  for (const summary of summaries || []) {
    appendUniquePositions(openedChests, summary?.openedChests || [])
    openCount += Number(summary?.openCount) || 0
  }
  return { openedChests, openCount }
}

function materialStorageAnchorRadius(session) {
  const configured = Number(session?.materialStorageAnchorRadius)
  return Number.isFinite(configured) && configured > 0 ? configured : 32
}

function inventoryItemCount(context, itemName) {
  const bot = context?.bot
  const items = bot?.inventory?.items?.() || []
  const count = items
    .filter(item => item?.name === itemName)
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0)
  if (count > 0) return count
  const held = bot?.heldItem
  return held?.name === itemName ? Math.max(1, Number(held.count) || 1) : 0
}

function liveInventoryEmptySlotCount(context) {
  const bot = context?.bot
  const slots = bot?.inventory?.slots
  if (Array.isArray(slots) && slots.length > 0) {
    return slots.slice(9, 45).filter(slot => !slot).length
  }
  const items = bot?.inventory?.items?.() || []
  return Math.max(0, 36 - items.filter(item => (Number(item?.count) || 0) > 0).length)
}

function selectMaterialRefillSlotReleaseStack(context, session, neededItemName) {
  const items = context?.bot?.inventory?.items?.() || []
  const candidates = items
    .filter(item => item?.name && item.name !== neededItemName && (Number(item.count) || 0) > 0)
    .filter(item => !isCriticalBuildInventoryItem(item.name))
    .map(item => {
      const count = Math.max(1, Number(item.count) || 1)
      const remaining = remainingStepItemCountForSession(session, item.name)
      return {
        item,
        itemName: item.name,
        count,
        remaining,
        surplus: count - remaining
      }
    })
    .sort((a, b) => {
      const surplusTier = Number(b.surplus > 0) - Number(a.surplus > 0)
      if (surplusTier) return surplusTier
      return (b.surplus - a.surplus) || (b.count - a.count) || a.itemName.localeCompare(b.itemName)
    })
  return candidates[0] || null
}

function remainingStepItemCountForSession(session, itemName) {
  if (!session?.steps) return 0
  let count = 0
  for (let index = session.currentStepIndex || 0; index < session.steps.length; index++) {
    const step = session.steps[index]
    if (!['foundation_fill', 'scaffold_place', 'place'].includes(step?.kind)) continue
    count += itemRequirementCountForStep(step, itemName)
  }
  return count
}

function isCriticalBuildInventoryItem(itemName) {
  const value = String(itemName || '')
  return /_pickaxe$|_axe$|_shovel$|_hoe$|_sword$|_helmet$|_chestplate$|_leggings$|_boots$/.test(value) ||
    value === 'shield' ||
    value === 'bow' ||
    value === 'crossbow' ||
    value === 'trident'
}

function itemNamesForStep(step) {
  return Object.keys(itemRequirementsForStep(step))
}

function itemRequirementsForStep(step) {
  return itemRequirementsForBlock(step)
}

function itemRequirementCountForStep(step, itemName) {
  return itemRequirementsForStep(step)[itemName] || 0
}

function itemStackSizeForContext(context, itemName) {
  return context?.bot?.registry?.itemsByName?.[itemName]?.stackSize || 64
}

function logBuilding(context, message) {
  if (context.logger?.log) context.logger.log(message)
  else if (context.debug) context.debug(message)
}

function formatPos(position) {
  if (!position) return 'unknown'
  return `${position.x},${position.y},${position.z}`
}

function isVerticalAccessBlockName(name) {
  const value = String(name || '')
  return /_stairs$/.test(value) || value === 'ladder'
}

function requiresGroundSupportBlockName(blockName) {
  const name = String(blockName || '')
  if (name.startsWith('potted_')) return false
  return name === 'azalea' ||
    name === 'flowering_azalea' ||
    name === 'grass' ||
    name === 'short_grass' ||
    name === 'tall_grass' ||
    name === 'fern' ||
    name === 'large_fern' ||
    name === 'dead_bush' ||
    /_sapling$/.test(name) ||
    /_tulip$/.test(name) ||
    [
      'dandelion',
      'poppy',
      'blue_orchid',
      'allium',
      'azure_bluet',
      'oxeye_daisy',
      'cornflower',
      'lily_of_the_valley',
      'wither_rose',
      'sunflower',
      'lilac',
      'rose_bush',
      'peony'
    ].includes(name)
}

function isUpperHalfDoubleHeightGroundPlantStep(step) {
  const name = String(step?.blockName || step?.block?.id || step?.resolvedBlock?.id || '')
  return isDoubleHeightGroundPlantName(name) &&
    String(placementStateValue(step, 'half') || '').toLowerCase() === 'upper'
}

function isDoorBlockName(blockName) {
  return /_door$/.test(String(blockName || ''))
}

function isUpperHalfDoorStep(step) {
  const name = String(step?.blockName || step?.block?.id || step?.resolvedBlock?.id || '')
  return isDoorBlockName(name) &&
    String(placementStateValue(step, 'half') || '').toLowerCase() === 'upper'
}

function isLowerHalfDoorStep(step) {
  const name = String(step?.blockName || step?.block?.id || step?.resolvedBlock?.id || '')
  return isDoorBlockName(name) &&
    String(placementStateValue(step, 'half') || '').toLowerCase() === 'lower'
}

function isUpperHalfDoorActual(actual) {
  const name = String(actual?.name || '')
  if (!isDoorBlockName(name)) return false
  return String(actual?.states?.half || '').toLowerCase() === 'upper'
}

function lowerDoorPositionForUpper(step) {
  const position = step?.position
  if (!position) return null
  return { x: position.x, y: position.y - 1, z: position.z }
}

function upperDoorPositionForLower(step) {
  const position = step?.position
  if (!position) return null
  return { x: position.x, y: position.y + 1, z: position.z }
}

function findLowerDoorStepForUpper(session, step) {
  const lowerPosition = lowerDoorPositionForUpper(step)
  const lowerStep = findPlacementStepAt(session, lowerPosition)
  if (!lowerStep) return null
  if (lowerStep.blockName !== step.blockName) return null
  if (!isLowerHalfDoorStep(lowerStep)) return null
  return lowerStep
}

function findUpperDoorStepForLower(session, step) {
  const upperPosition = upperDoorPositionForLower(step)
  const upperStep = findPlacementStepAt(session, upperPosition)
  if (!upperStep) return null
  if (upperStep.blockName !== step.blockName) return null
  if (!isUpperHalfDoorStep(upperStep)) return null
  return upperStep
}

function isMatchingLowerHalfDoubleHeightGroundPlant(actual, step) {
  const actualName = String(actual?.name || '')
  const expectedName = String(step?.blockName || step?.block?.id || step?.resolvedBlock?.id || '')
  if (!expectedName || actualName !== expectedName || !isDoubleHeightGroundPlantName(expectedName)) return false
  const actualHalf = String(actual?.states?.half || '').toLowerCase()
  return actualHalf !== 'upper'
}

function isDoubleHeightGroundPlantName(blockName) {
  return [
    'tall_grass',
    'large_fern',
    'sunflower',
    'lilac',
    'rose_bush',
    'peony'
  ].includes(String(blockName || ''))
}

function placementStateValue(step, key) {
  return (step?.states ||
    step?.orientation ||
    step?.block?.states ||
    step?.resolvedBlock?.states ||
    {})[key]
}

function isGroundPlantSupportName(blockName) {
  return [
    'grass_block',
    'dirt',
    'coarse_dirt',
    'rooted_dirt',
    'podzol',
    'mycelium',
    'moss_block',
    'farmland',
    'mud',
    'clay'
  ].includes(String(blockName || ''))
}

function findPlacementStepAt(session, position) {
  if (!position) return null
  return (session?.steps || []).find(step =>
    step &&
    ['place', 'foundation_fill', 'scaffold_place'].includes(step.kind) &&
    !isAirName(step.blockName) &&
    positionsEqual(step.position, position)
  ) || null
}

function findPlannedReferenceSteps(session, step) {
  if (!session?.steps || !step?.position) return []
  const offsets = [
    { x: 0, y: -1, z: 0, priority: 0 },
    { x: 1, y: 0, z: 0, priority: 1 },
    { x: -1, y: 0, z: 0, priority: 1 },
    { x: 0, y: 0, z: 1, priority: 1 },
    { x: 0, y: 0, z: -1, priority: 1 },
    { x: 0, y: 1, z: 0, priority: 2 }
  ]
  const wanted = offsets.map(offset => ({
    position: {
      x: step.position.x + offset.x,
      y: step.position.y + offset.y,
      z: step.position.z + offset.z
    },
    priority: offset.priority
  }))
  return wanted
    .map(entry => {
      const candidate = findPlacementStepAt(session, entry.position)
      return candidate ? { candidate, priority: entry.priority } : null
    })
    .filter(candidate =>
      candidate &&
      candidate.candidate.id !== step.id &&
      isPlannedPlacementReferenceBlockName(candidate.candidate.blockName, candidate.candidate.states || candidate.candidate.orientation)
    )
    .sort((a, b) =>
      a.priority - b.priority ||
      phaseOrderRank(normalizeConstructionPhase(a.candidate.phase, a.candidate)) - phaseOrderRank(normalizeConstructionPhase(b.candidate.phase, b.candidate))
    )
    .map(entry => entry.candidate)
}

function isPlannedPlacementReferenceBlockName(blockName, states = null) {
  const name = String(blockName || '')
  if (!name || isAirName(name)) return false
  if (requiresGroundSupportBlockName(name)) return false
  if (isSideAttachedPlannedReferenceBlockName(name)) return false
  if (name === 'lantern' && String(states?.hanging || '').toLowerCase() === 'true') return false
  return ![
    /water$/,
    /lava$/,
    /fire$/,
    /carpet$/,
    /_bed$/,
    /^bed$/,
    /sign$/,
    /banner$/,
    /flower$/,
    /^(short_)?grass$/,
    /sapling$/,
    /ladder$/,
    /torch$/,
    /_door$/,
    /trapdoor$/,
    /button$/,
    /pressure_plate$/,
    /^lantern$/,
    /^flower_pot$/,
    /^potted_/
  ].some(pattern => pattern.test(name))
}

function isSideAttachedPlannedReferenceBlockName(blockName) {
  const value = String(blockName || '')
  return value === 'ladder' ||
    value === 'tripwire_hook' ||
    value.endsWith('_wall_sign') ||
    value.endsWith('_wall_banner') ||
    value.endsWith('_wall_torch') ||
    value.endsWith('_wall_head') ||
    value.endsWith('_wall_skull')
}

function positionsEqual(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z
}

function isHighPlacementStep(step, origin) {
  if (!step?.position || !origin || !Number.isFinite(origin.y)) return false
  return step.position.y >= origin.y + 3
}

function isLargeVerticalTravelStep(bot, step, threshold = 6) {
  if (!step?.position) return false
  const currentY = Number(bot?.entity?.position?.y)
  if (!Number.isFinite(currentY) || !Number.isFinite(step.position.y)) return false
  return Math.abs(step.position.y - currentY) >= threshold
}

function isBelowTargetVerticalRecoveryStep(bot, step, threshold = 3) {
  if (!step?.position) return false
  const currentY = Math.floor(Number(bot?.entity?.position?.y))
  if (!Number.isFinite(currentY) || !Number.isFinite(step.position.y)) return false
  return step.position.y >= currentY + threshold
}

function isBaseLayerSurfacePreservationStep(bot, step, origin) {
  if (step?.kind !== 'place' || !step?.position || !origin) return false
  const currentY = Math.floor(Number(bot?.entity?.position?.y))
  const originY = Math.floor(Number(origin.y))
  if (!Number.isFinite(currentY) || !Number.isFinite(originY)) return false
  return step.position.y === originY && currentY >= step.position.y
}

function hasNearbyCompletedFormalSurface(context, step, reservedPositions, radius = 3) {
  const target = step?.position
  if (!target || typeof context?.bot?.blockAt !== 'function') return false
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if ((dx === 0 && dz === 0) || Math.sqrt((dx * dx) + (dz * dz)) > radius) continue
      const support = { x: target.x + dx, y: target.y, z: target.z + dz }
      if (!reservedPositionCollectionHas(reservedPositions, support)) continue
      const supportBlock = blockDetailsAt(context, support)
      const feetBlock = blockDetailsAt(context, { x: support.x, y: support.y + 1, z: support.z })
      const headBlock = blockDetailsAt(context, { x: support.x, y: support.y + 2, z: support.z })
      if (!isAirName(supportBlock.name) && isAirName(feetBlock.name) && isAirName(headBlock.name)) {
        return true
      }
    }
  }
  return false
}

function reservedPositionCollectionHas(reservedPositions, position) {
  if (!reservedPositions || !position) return false
  const key = formatPos(position)
  if (typeof reservedPositions.has === 'function') return reservedPositions.has(key)
  if (!Array.isArray(reservedPositions)) return false
  return reservedPositions.some(entry => {
    if (typeof entry === 'string') return entry === key
    return entry?.x === position.x && entry?.y === position.y && entry?.z === position.z
  })
}

function minimumSurfacePlacementStandY(bot, step, options = {}) {
  const targetY = Math.floor(Number(step?.position?.y))
  const currentY = Math.floor(Number(bot?.entity?.position?.y))
  if (!Number.isFinite(targetY)) return undefined
  if (options.forceAboveTarget === true) return targetY + 1
  if (!Number.isFinite(currentY) || currentY <= targetY) return targetY
  // A resumed repair may start on top of an already-filled base layer. Keep
  // the approach on that surface, but do not inherit an unrelated roof Y.
  return targetY + 1
}

function minimumHighPlacementStandY(step) {
  const targetY = Math.floor(Number(step?.position?.y))
  if (!Number.isFinite(targetY)) return undefined
  // A player can comfortably place a block from a floor two levels below it.
  // Keep that legitimate reach while preventing high construction from
  // falling back to a distant fixture floor when future formal air cells are
  // the intended approach corridor.
  return targetY - 2
}

function requiresHighPlacementAccessPlan(bot, step, placeDistance = 4.5) {
  const current = bot?.entity?.position
  const target = step?.position
  if (!current || !target) return false
  const dx = Number(current.x) - Number(target.x)
  const dz = Number(current.z) - Number(target.z)
  if (![dx, dz].every(Number.isFinite)) return false
  return Math.sqrt((dx * dx) + (dz * dz)) > placeDistance
}

function isTerrainFillStep(step) {
  if (!step) return false
  return step.role === 'terrain_fill' ||
    step.materialResolution?.role === 'terrain_fill' ||
    step.resolvedBlock?.role === 'terrain_fill' ||
    step.originalBlock?.role === 'terrain_fill'
}

function isOptionalDecorationPlacementFailure(step, result) {
  if (step?.kind !== 'place' || !isOptionalDecorationBlockName(step.blockName)) return false
  return /place_failed|no_support_block|not_changed|unstable|blockUpdate|timeout|No block has been placed/i
    .test(String(result?.error || result?.message || ''))
}

function isPlacementSupportFailure(error) {
  const value = String(error || '')
  return value === 'no_support_block' ||
    value === 'place_failed:unstable_air' ||
    value.startsWith('temporary_reference_') ||
    value.startsWith('stair_temporary_reference_')
}

function isOptionalDecorationBlockName(blockName) {
  const value = String(blockName || '')
  return value.endsWith('_wall_sign') ||
    value.endsWith('_wall_banner') ||
    value === 'tripwire_hook' ||
    value === 'lever' ||
    value === 'flower_pot' ||
    value === 'sea_pickle' ||
    value === 'chain' ||
    value.endsWith('_pressure_plate') ||
    value.endsWith('_carpet')
}

function optionalDecorationSkipResult(context, step, result) {
  logBuilding(context, `[BUILD_OPTIONAL_DECORATION_SKIPPED] block=${step.blockName} pos=${formatPos(step.position)} reason=${result.error || result.message || 'unknown'}`)
  return {
    ok: true,
    skipped: true,
    optionalSkipped: true,
    reason: 'optional_decoration_unplaced',
    blockName: step.blockName,
    position: step.position,
    originalError: result.error || null
  }
}

function toWorldBlocks(blueprint, origin) {
  const blueprintOrigin = blueprint.origin || { x: 0, y: 0, z: 0 }
  return blueprint.blocks.map(block => ({
    ...block,
    type: block.type,
    position: {
      x: origin.x + block.x - blueprintOrigin.x,
      y: origin.y + block.y - blueprintOrigin.y,
      z: origin.z + block.z - blueprintOrigin.z
    }
  }))
}

function captureSiteSnapshot(context, worldBlocks = []) {
  const seen = new Set()
  const blocks = []
  const addPosition = position => {
    if (!position) return
    const key = formatPos(position)
    if (seen.has(key)) return
    seen.add(key)
    const current = blockDetailsAt(context, position)
    blocks.push({
      position: { ...position },
      name: current.name || 'air',
      states: current.states || null
    })
  }

  const bounds = snapshotBoundsFor(worldBlocks)
  if (bounds) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z++) addPosition({ x, y, z })
      }
    }
  } else {
    for (const target of worldBlocks) {
      if (target?.position) addPosition(target.position)
    }
  }

  const entities = Object.values(context?.bot?.entities || {})
    .filter(entity => entity?.position)
    .filter(entity => !isSelfEntity(context, entity))
    .map(entity => ({
      id: entity.id || entity.username || entity.name || null,
      username: entity.username || null,
      name: entity.name || null,
      type: entity.type || null,
      kind: entity.kind || null,
      width: entity.width || null,
      height: entity.height || null,
      position: {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z
      }
    }))

  return {
    blocks,
    entities,
    actorPosition: currentBotPosition(context),
    inventoryCounts: getLiveInventoryCounts(context)
  }
}

function isSelfEntity(context, entity) {
  const bot = context?.bot
  const botEntity = bot?.entity
  if (!entity || !botEntity) return false
  if (entity === botEntity) return true

  if (entity.id !== undefined && entity.id !== null && botEntity.id !== undefined && botEntity.id !== null) {
    if (entity.id === botEntity.id) return true
  }

  const botUsername = bot?.username || botEntity.username || bot?.player?.username || null
  const entityUsername = entity.username || null
  if (botUsername && entityUsername === botUsername) return true

  return false
}

function snapshotBoundsFor(worldBlocks = []) {
  const positions = worldBlocks.map(block => block?.position).filter(Boolean)
  if (!positions.length) return null
  const raw = positions.reduce((bounds, position) => ({
    minX: Math.min(bounds.minX, position.x),
    maxX: Math.max(bounds.maxX, position.x),
    minY: Math.min(bounds.minY, position.y),
    maxY: Math.max(bounds.maxY, position.y),
    minZ: Math.min(bounds.minZ, position.z),
    maxZ: Math.max(bounds.maxZ, position.z)
  }), {
    minX: positions[0].x,
    maxX: positions[0].x,
    minY: positions[0].y,
    maxY: positions[0].y,
    minZ: positions[0].z,
    maxZ: positions[0].z
  })
  const height = raw.maxY - raw.minY + 1
  const pad = Math.max(6, Math.min(18, height + 4))
  return {
    minX: raw.minX - pad,
    maxX: raw.maxX + pad,
    minY: raw.minY - 4,
    maxY: raw.maxY + 2,
    minZ: raw.minZ - pad,
    maxZ: raw.maxZ + pad
  }
}

function actualWorldBlueprintFromSession(context, session) {
  const worldBlocks = (session.worldBlocks || []).filter(block => block?.position)
  const expectedByPosition = new Map(worldBlocks.map(block => [formatPos(block.position), block]))
  const bounds = createBuildBounds(worldBlocks)
  const blocks = []
  const seen = new Set()
  const addActual = (position, expected = null) => {
    const key = formatPos(position)
    if (seen.has(key)) return
    seen.add(key)
    const actual = blockDetailsAt(context, position)
    if (isAirName(actual.name)) return
    blocks.push({
      x: position.x - session.origin.x,
      y: position.y - session.origin.y,
      z: position.z - session.origin.z,
      type: actual.name || 'air',
      expectedType: expected?.type || null,
      states: actual.states || null,
      expectedStates: expected?.states || null,
      orientation: expected?.orientation || null,
      role: expected?.role || (expected ? null : 'unexpected_world_block'),
      phase: expected?.phase || null
    })
  }
  if (bounds) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
          const position = { x, y, z }
          addActual(position, expectedByPosition.get(formatPos(position)) || null)
        }
      }
    }
  } else {
    for (const block of worldBlocks) addActual(block.position, block)
  }
  for (const step of session.orderPlan?.steps || []) {
    if (step.kind !== 'scaffold_remove') continue
    if (seen.has(formatPos(step.position))) continue
    const actual = blockDetailsAt(context, step.position)
    if (isAirName(actual.name)) continue
    seen.add(formatPos(step.position))
    blocks.push({
      x: step.position.x - session.origin.x,
      y: step.position.y - session.origin.y,
      z: step.position.z - session.origin.z,
      type: 'scaffolding',
      actualType: actual.name,
      states: actual.states || null,
      role: 'temporary_scaffold',
      phase: 'cleanup'
    })
  }
  return {
    name: session.blueprintName,
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      ...(session.blueprint?.metadata || {}),
      actualWorldSnapshot: true,
      origin: session.origin
    },
    blocks
  }
}

function unexpectedTemporaryBuildVolumeBlocks(context, session, options = {}) {
  const worldBlocks = (session?.worldBlocks || []).filter(block => block?.position && !isAirName(block.type))
  const bounds = createBuildBounds(worldBlocks)
  const origin = session?.origin
  if (!bounds || !origin) return []
  const expectedPositions = new Set(worldBlocks.map(block => formatPos(block.position)))
  const minimumY = origin.y + Math.max(2, Number(options.unexpectedTemporaryCleanupMinYOffset ?? 2) || 2)
  const candidates = []
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = Math.max(bounds.minY, minimumY); y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const position = { x, y, z }
        if (expectedPositions.has(formatPos(position))) continue
        const actual = blockDetailsAt(context, position)
        if (isAirName(actual.name) || !isTemporaryReferenceName(actual.name)) continue
        candidates.push({ position, blockName: actual.name, states: actual.states || null })
      }
    }
  }
  return candidates.sort((a, b) =>
    b.position.y - a.position.y ||
    a.position.x - b.position.x ||
    a.position.z - b.position.z
  )
}

async function cleanupUnexpectedTemporaryBuildVolumeBlocks(context, session, options = {}) {
  const removed = []
  const failedAttempts = []
  const maxPasses = Math.max(1, Number(options.unexpectedTemporaryCleanupMaxPasses ?? 3) || 3)
  for (let pass = 1; pass <= maxPasses; pass++) {
    const candidates = unexpectedTemporaryBuildVolumeBlocks(context, session, options)
    if (!candidates.length) return { ok: true, removed, remaining: [], passes: pass - 1 }
    const acceptedBeforePass = acceptedFaithfulCleanupResult(
      context,
      session,
      options,
      { removed, remaining: candidates, failedAttempts, passes: pass - 1 }
    )
    if (acceptedBeforePass) return acceptedBeforePass
    for (const candidate of candidates) {
      if (!constructionShouldContinue(options)) {
        return { ok: false, error: 'task_interrupted', removed, remaining: candidates, passes: pass }
      }
      const cleared = await clearBlockForBuilding(context, candidate.position, {
        owner: options.owner || session.owner || 'building',
        shouldContinue: options.shouldContinue,
        timeoutMs: options.unexpectedTemporaryCleanupTimeoutMs || options.timeoutMs || 20000,
        verticalMoveTimeoutPerBlockMs: options.scaffoldCleanupVerticalMoveTimeoutPerBlockMs ||
          options.verticalMoveTimeoutPerBlockMs ||
          4500,
        maxAdaptiveMoveTimeoutMs: options.scaffoldCleanupMaxAdaptiveMoveTimeoutMs ||
          options.maxAdaptiveMoveTimeoutMs ||
          120000,
        adaptiveMoveTimeout: true,
        allowScaffolding: true,
        canDig: false,
        reservedPositions: session.reservedPositions,
        reservedBounds: session.reservedBounds,
        preferOutsideReservedBounds: false,
        preferHighStand: true,
        clearStandMoveRange: 1.0,
        standMoveAttempts: 8,
        allowNearXZFallback: true,
        moveRange: 4,
        temporary: true
      })
      if (!cleared.ok) {
        const failed = {
          ...candidate,
          pass,
          error: cleared.error || 'clear_failed'
        }
        failedAttempts.push(failed)
        logBuilding(
          context,
          `[BUILD_UNTRACKED_TEMPORARY_DEFER] pass=${pass}/${maxPasses} ` +
          `pos=${formatPos(candidate.position)} block=${candidate.blockName} error=${failed.error}`
        )
        continue
      }
      removed.push(candidate)
      const acceptedAfterRemoval = acceptedFaithfulCleanupResult(
        context,
        session,
        options,
        {
          removed,
          remaining: unexpectedTemporaryBuildVolumeBlocks(context, session, options),
          failedAttempts,
          passes: pass
        }
      )
      if (acceptedAfterRemoval) return acceptedAfterRemoval
    }
    const remaining = unexpectedTemporaryBuildVolumeBlocks(context, session, options)
    if (!remaining.length) return { ok: true, removed, remaining, failedAttempts, passes: pass }
  }
  const remaining = unexpectedTemporaryBuildVolumeBlocks(context, session, options)
  const lastFailure = failedAttempts[failedAttempts.length - 1] || null
  return {
    ok: remaining.length === 0,
    error: remaining.length
      ? `temporary_cleanup_did_not_converge:${formatPos(remaining[0].position)}:${lastFailure?.error || 'remaining'}`
      : null,
    removed,
    remaining,
    failedAttempts,
    passes: maxPasses
  }
}

function acceptedFaithfulCleanupResult(context, session, options = {}, progress = {}) {
  const faithfulValidation = faithfulWorldValidationForSession(
    context,
    session,
    options.faithfulValidator
  )
  if (faithfulValidation?.ok !== true) return null
  const remaining = progress.remaining || unexpectedTemporaryBuildVolumeBlocks(context, session, options)
  return {
    ok: true,
    error: null,
    removed: progress.removed || [],
    remaining,
    failedAttempts: progress.failedAttempts || [],
    passes: progress.passes || 0,
    toleratedRemaining: remaining.length > 0,
    faithfulPreview: faithfulValidation
  }
}

function faithfulWorldValidationForSession(context, session, faithfulValidator) {
  if (!faithfulValidator || typeof faithfulValidator.compareExpectedActual !== 'function') return null
  return faithfulValidator.compareExpectedActual(
    session.resolvedBlueprint || session.blueprint,
    actualWorldBlueprintFromSession(context, session),
    {
      blueprintName: session.blueprintName,
      selected: session.selectedBlueprint,
      requiredStories: session.selectedBlueprint?.requiredStories
    }
  )
}

function setWorldDiffPart(session, key, diff) {
  if (!session || !key || !diff) return
  session.worldDiffParts = {
    ...(session.worldDiffParts || {}),
    [key]: diff
  }
  session.worldDiffResult = mergeWorldDiffResults(...Object.values(session.worldDiffParts))
}

function shouldPreferOutsideReservedBounds(step = {}, origin = null) {
  if (step.phase === 'interior' || step.interior === true) return false
  if (origin && step.position && step.position.y <= origin.y + 1) return false
  return true
}

function createReservedPositionSet(worldBlocks = []) {
  return new Set(
    worldBlocks
      .filter(block => block && !isAirName(block.type))
      .map(block => formatPos(block.position))
  )
}

function createReservedBounds(worldBlocks = []) {
  const solid = worldBlocks.filter(block => block && !isAirName(block.type))
  if (!solid.length) return null
  return solid.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.position.x),
    maxX: Math.max(bounds.maxX, block.position.x),
    minZ: Math.min(bounds.minZ, block.position.z),
    maxZ: Math.max(bounds.maxZ, block.position.z)
  }), {
    minX: solid[0].position.x,
    maxX: solid[0].position.x,
    minZ: solid[0].position.z,
    maxZ: solid[0].position.z
  })
}

function constructionRunCriteria(context, preview) {
  const plan = preview.constructionPlan || {}
  const bounds = createBuildBounds(preview.worldBlocks || [])
  return {
    blueprintId: plan.blueprintId || preview.blueprintIR?.id || preview.blueprintName,
    blueprintRevision: plan.blueprintRevision || preview.selectedBlueprint?.cacheHash || preview.blueprintIR?.metadata?.revision || null,
    blueprintHash: plan.blueprintHash || null,
    planId: plan.planId || null,
    placementContext: plan.placement || { origin: preview.origin, rotationY: 0, mirror: { x: false, z: false } },
    world: getWorldIdentity(context),
    bounds,
    stagingChests: materialStorageScanCentersForPreview(preview)
  }
}

function decideConstructionRunStart(context, preview, options = {}, store = null, systemOptions = {}) {
  const criteria = constructionRunCriteria(context, preview)
  const forceFresh = options.forceRebuild === true || options.rebuild === true
  const activeCompatible = !forceFresh && store?.findActiveCompatible
    ? store.findActiveCompatible(criteria)
    : null
  const activeForBlueprint = store?.findActiveForBlueprint
    ? store.findActiveForBlueprint(criteria.blueprintId)
    : null
  const compatibility = activeForBlueprint
    ? constructionRunCompatibility(activeForBlueprint, criteria)
    : null
  const rescue = analyzeExistingBuildAgainstPreview(context, preview, options, systemOptions)
  const resumeOrFresh = activeCompatible
    ? 'resume'
    : (forceFresh ? 'fresh' : 'fresh')
  const reason = constructionRunDecisionReason({
    forceFresh,
    options,
    activeCompatible,
    activeForBlueprint,
    compatibility
  })
  const wouldCreateFresh = !activeCompatible || forceFresh
  // Double-signal site rule:
  // 1. Any blueprint-matching block (right type at an expected position, even
  //    with wrong states) means a half-built structure or ruin -> forced
  //    reconciliation. NOT bypassable by any option.
  // 2. No matching blocks and everything detected is natural terrain -> the
  //    site is untouched ground; fresh build proceeds automatically.
  // 3. No matching blocks but unknown (artificial/unclassified) blocks at or
  //    above the threshold -> refuse the automatic decision (status quo for
  //    foreign structures; below-threshold obstructions keep flowing into the
  //    normal clear/repair path). allowOverwriteExistingStructure remains
  //    available as an explicit escape hatch only for this case.
  const blueprintMatchingBlocks = rescue.blueprintMatchingBlocks || 0
  const unknownBlocks = rescue.unknownBlocks || 0
  const naturalBlocks = rescue.naturalBlocks || 0
  const hardReconciliationRequired = wouldCreateFresh && blueprintMatchingBlocks > 0
  const unknownAboveThreshold = unknownBlocks >= rescue.threshold
  const escapeHatchUsed = wouldCreateFresh &&
    !hardReconciliationRequired &&
    unknownAboveThreshold &&
    options.allowOverwriteExistingStructure === true
  // RENOVATION (docs/RENOVATION_FLOW_DESIGN.md): an explicit renovationOf
  // entry point is the one path that ACKNOWLEDGES the existing building.
  // It never bypasses the blueprintMatching->RECONCILIATION rule for fresh
  // paths — without options.renovationOf the behavior below is unchanged.
  const renovation = options.renovationOf && !activeCompatible
    ? evaluateRenovationStart(context, options.renovationOf, criteria, rescue, store)
    : null
  const renovationApproved = renovation?.ok === true
  const blocked = renovationApproved
    ? false
    : (options.renovationOf && !activeCompatible)
        ? true
        : hardReconciliationRequired || (wouldCreateFresh && unknownAboveThreshold && !escapeHatchUsed)
  const siteClassification = {
    detectedExistingBlocks: rescue.detectedExistingBlocks,
    naturalBlocks,
    blueprintMatchingBlocks,
    unknownBlocks,
    decision: renovationApproved
      ? 'renovation_of_completed_run'
      : (blocked
          ? (options.renovationOf ? 'renovation_rejected' : (hardReconciliationRequired ? 'reconciliation_required' : 'manual_decision_required'))
          : (escapeHatchUsed ? 'fresh_via_escape_hatch' : (naturalBlocks > 0 ? 'fresh_natural_terrain' : 'fresh_empty_site')))
  }
  const strictResumeCompatibilityFailure = options.resumeOnly === true &&
    activeForBlueprint &&
    compatibility?.ok === false
  const blockedReason = strictResumeCompatibilityFailure
    ? compatibility.reason
    : (options.renovationOf
        ? (renovation?.reason || 'RENOVATION_REJECTED')
        : (hardReconciliationRequired
            ? 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION'
            : 'UNKNOWN_ARTIFICIAL_BLOCKS_REQUIRE_MANUAL_DECISION'))
  logBuilding(context, `[BUILD_SITE_CLASSIFICATION] detected=${siteClassification.detectedExistingBlocks} natural=${naturalBlocks} blueprintMatching=${blueprintMatchingBlocks} unknown=${unknownBlocks} decision=${siteClassification.decision}`)
  if (escapeHatchUsed) {
    logBuilding(context, `[BUILD_OVERWRITE_ESCAPE_HATCH] allowOverwriteExistingStructure=true bypassed manual decision for ${unknownBlocks} unknown non-blueprint blocks at ${JSON.stringify(criteria.placementContext?.origin || null)} — verify these are not someone else's structure`)
  }
  if (options.renovationOf) {
    logBuilding(context, `[BUILD_RENOVATION_DECISION] renovationOf=${options.renovationOf} approved=${renovationApproved} reason=${renovationApproved ? 'RENOVATION_OF_COMPLETED_RUN' : (renovation?.reason || 'RENOVATION_REJECTED')} baseHash=${renovation?.oldRun?.blueprintHash || 'unknown'} baseMatched=${renovation?.matchedBaseBlocks ?? 'n/a'}/${renovation?.scannedBaseBlocks ?? 'n/a'}`)
  }

  return {
    identity: {
      username: context?.bot?.username || null
    },
    worktree: process.cwd(),
    branch: process.env.GIT_BRANCH || null,
    runId: activeCompatible?.runId || activeForBlueprint?.runId || null,
    resumeOrFresh: blocked ? 'blocked' : (renovationApproved ? 'renovation' : resumeOrFresh),
    reason: blocked ? blockedReason : (renovationApproved ? 'RENOVATION_OF_COMPLETED_RUN' : reason),
    renovation,
    siteClassification,
    escapeHatchUsed,
    blueprintHash: criteria.blueprintHash,
    placement: criteria.placementContext,
    bounds: criteria.bounds,
    detectedExistingTargetBlocks: rescue.detectedExistingBlocks,
    detectedExistingBlocks: rescue.detectedExistingBlocks,
    verifiedTargetBlocks: rescue.verifiedBlocks,
    missingTargetBlocks: rescue.missingBlocks,
    wrongTargetBlocks: rescue.wrongBlocks,
    wrongStateTargetBlocks: rescue.wrongStates,
    extraNonBlueprintBlocks: rescue.extraBlocks,
    verifiedConstructionSteps: rescue.verifiedSteps,
    pendingConstructionSteps: rescue.pendingSteps,
    verifiedSteps: rescue.verifiedSteps,
    pendingSteps: rescue.pendingSteps,
    currentPhase: blocked ? rescue.likelyCurrentPhase : null,
    activeCompatibleRunId: activeCompatible?.runId || null,
    activeForBlueprintRunId: activeForBlueprint?.runId || null,
    compatibility,
    forceFresh,
    blocked,
    rescue
  }
}

// Reconciliation-style incremental demolition (docs/RENOVATION_FLOW_DESIGN.md
// §1): blocks the OLD frozen blueprint placed that the NEW blueprint no
// longer claims must be cleared, or they survive as strict-WorldDiff extras.
// Two sources:
//  - old-run frozen IR positions outside the new target set -> new
//    renovation_clear steps (front of the order plan, clear_obstruction
//    phase);
//  - existing site-planner clear steps that sit on an old frozen block ->
//    tagged renovationClear so the clear policy recognizes the demolition as
//    authorized renovation work instead of refusing a structural clear.
function applyRenovationClearSteps(preview, oldRun, context) {
  const origin = oldRun?.placementContext?.origin
  const oldBlocks = (oldRun?.frozenBlueprintIR?.blocks || [])
    .filter(block => block?.position && block?.block?.id && !isAirName(block.block.id))
  if (!origin || !oldBlocks.length || !preview?.orderPlan) return preview
  const oldByWorldKey = new Map(oldBlocks.map(block => [
    positionKey({ x: origin.x + block.position.x, y: origin.y + block.position.y, z: origin.z + block.position.z }),
    block
  ]))
  const targetKeys = new Set((preview.worldBlocks || []).map(block => positionKey(block.position)))
  const steps = (preview.orderPlan.steps || []).map(step => {
    if (step?.kind !== 'clear' || !step.position) return step
    const oldBlock = oldByWorldKey.get(positionKey(step.position))
    if (!oldBlock) return step
    return { ...step, renovationClear: true, renovationOf: oldRun.runId }
  })
  const existingClearKeys = new Set(steps
    .filter(step => step?.kind === 'clear' && step.position)
    .map(step => positionKey(step.position)))
  const demolitionSteps = []
  for (const [worldKey, oldBlock] of oldByWorldKey) {
    if (targetKeys.has(worldKey)) continue // reconciled at target cells (verify/repair)
    if (existingClearKeys.has(worldKey)) continue
    const [x, y, z] = worldKey.split(',').map(Number)
    const position = { x, y, z }
    const actual = blockDetailsAt(context, position)
    if (isAirName(actual.name)) continue // already gone
    demolitionSteps.push({
      id: `step_renovation_clear_${x}_${y}_${z}`,
      kind: 'clear',
      action: 'clear_block',
      legacyKind: 'clear',
      renovationClear: true,
      renovationOf: oldRun.runId,
      phase: 'clear_obstruction',
      position,
      target: position,
      current: actual.name,
      expectedBaseBlock: oldBlock.block.id,
      dependencies: []
    })
  }
  if (!demolitionSteps.length && steps.every((step, index) => step === (preview.orderPlan.steps || [])[index])) {
    return preview
  }
  // Demolish top-down so nothing is dug out from under a higher old block.
  demolitionSteps.sort((a, b) => b.position.y - a.position.y || a.position.x - b.position.x || a.position.z - b.position.z)
  const mergedSteps = [...demolitionSteps, ...steps]
  return {
    ...preview,
    orderPlan: {
      ...preview.orderPlan,
      steps: mergedSteps,
      summary: {
        ...(preview.orderPlan.summary || {}),
        renovationClear: demolitionSteps.length,
        totalSteps: mergedSteps.length
      }
    }
  }
}

// Validates an explicit renovation entry (docs/RENOVATION_FLOW_DESIGN.md §2):
// the renovated run must exist, be COMPLETED, overlap the new placement, and
// the site must still substantially match the OLD frozen blueprint (we are
// renovating the building we claim to renovate, not someone else's).
function evaluateRenovationStart(context, renovationOfRunId, criteria, rescue, store) {
  const oldRun = store?.getRun ? store.getRun(renovationOfRunId) : null
  if (!oldRun) {
    return { ok: false, reason: 'RENOVATION_TARGET_NOT_FOUND', renovationOf: renovationOfRunId }
  }
  const completed = oldRun.terminalState === 'COMPLETED' || oldRun.status === 'COMPLETED'
  if (!completed) {
    return { ok: false, reason: 'RENOVATION_TARGET_NOT_COMPLETED', renovationOf: renovationOfRunId, oldRun }
  }
  if (!boundsOverlap(oldRun.bounds, criteria.bounds)) {
    return { ok: false, reason: 'RENOVATION_BOUNDS_DO_NOT_OVERLAP', renovationOf: renovationOfRunId, oldRun }
  }
  const origin = oldRun.placementContext?.origin
  const baseBlocks = (oldRun.frozenBlueprintIR?.blocks || [])
    .filter(block => block?.position && block?.block?.id && !isAirName(block.block.id))
  let matchedBaseBlocks = 0
  let scannedBaseBlocks = 0
  if (origin && baseBlocks.length) {
    for (const block of baseBlocks) {
      const worldPos = {
        x: origin.x + block.position.x,
        y: origin.y + block.position.y,
        z: origin.z + block.position.z
      }
      const actual = blockDetailsAt(context, worldPos)
      scannedBaseBlocks += 1
      if (actual.name === block.block.id) matchedBaseBlocks += 1
    }
  }
  // "Substantially matches H_old": at least half of the old frozen blocks
  // still stand as their old type. The building being renovated is COMPLETED,
  // so in practice this is ~100%; the threshold only guards against pointing
  // renovationOf at a site that holds a different structure.
  const baseMatchOk = baseBlocks.length > 0 && matchedBaseBlocks * 2 >= scannedBaseBlocks
  if (!baseMatchOk) {
    return {
      ok: false,
      reason: 'RENOVATION_SITE_DOES_NOT_MATCH_BASE_BLUEPRINT',
      renovationOf: renovationOfRunId,
      oldRun,
      matchedBaseBlocks,
      scannedBaseBlocks
    }
  }
  return {
    ok: true,
    reason: 'RENOVATION_OF_COMPLETED_RUN',
    renovationOf: renovationOfRunId,
    oldRun,
    renovationBaseHash: oldRun.blueprintHash || null,
    matchedBaseBlocks,
    scannedBaseBlocks
  }
}

function boundsOverlap(a, b) {
  if (!a || !b) return false
  const finite = bounds => [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ].every(Number.isFinite)
  if (!finite(a) || !finite(b)) return false
  return a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ
}

function constructionRunDecisionReason({ forceFresh, options = {}, activeCompatible, activeForBlueprint, compatibility }) {
  if (activeCompatible && !forceFresh) return 'ACTIVE_RUN_COMPATIBLE'
  if (forceFresh) return normalizeFreshBuildReason(options.rebuildReason || 'USER_REQUESTED_REBUILD')
  if (!activeForBlueprint) return 'NO_ACTIVE_RUN'
  if (compatibility && !compatibility.ok) return normalizeFreshBuildReason(compatibility.reason || 'INCOMPATIBLE_ACTIVE_RUN')
  return 'NO_ACTIVE_COMPATIBLE_RUN'
}

function normalizeFreshBuildReason(reason) {
  const value = String(reason || 'NO_ACTIVE_RUN')
  if (value === 'explicit_rebuild_requested') return 'USER_REQUESTED_REBUILD'
  return value.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
}

// Position-independent whitelist of block types that occur as untouched
// natural terrain/vegetation. Deliberately EXCLUDES logs (wood blueprints
// contain logs — a false "existing structure" report is acceptable, a missed
// half-built structure is not) and player-worked blocks (cobblestone,
// farmland, dirt_path, obsidian).
const NATURAL_SITE_BLOCKS = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'bedrock',
  'gravel', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'clay', 'mud', 'packed_mud',
  'moss_block', 'moss_carpet',
  'snow', 'snow_block', 'powder_snow', 'ice', 'packed_ice', 'blue_ice',
  'water', 'lava',
  'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'lily_pad',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony',
  'brown_mushroom', 'red_mushroom', 'sugar_cane', 'cactus', 'bamboo', 'bamboo_sapling',
  'azalea', 'flowering_azalea', 'sweet_berry_bush', 'pumpkin', 'melon'
])

function isNaturalSiteBlock(blockName) {
  const name = String(blockName || '')
  if (NATURAL_SITE_BLOCKS.has(name)) return true
  return name.endsWith('_leaves') || name.endsWith('_sapling')
}

function analyzeExistingBuildAgainstPreview(context, preview, options = {}, systemOptions = {}) {
  const threshold = Math.max(1, Number(options.existingStructureBlockThreshold || systemOptions.existingStructureBlockThreshold || 16))
  const worldBlocks = (preview.worldBlocks || []).filter(block => block?.position && !isAirName(block.type))
  const expectedByPosition = new Map(worldBlocks.map(block => [positionKey(block.position), block]))
  const summary = {
    threshold,
    bounds: createBuildBounds(worldBlocks),
    detectedExistingBlocks: 0,
    verifiedBlocks: 0,
    missingBlocks: 0,
    wrongBlocks: 0,
    wrongStates: 0,
    naturalBlocks: 0,
    unknownBlocks: 0,
    blueprintMatchingBlocks: 0,
    extraBlocks: 0,
    likelyCurrentPhase: 'site_prepare',
    canResume: false,
    reason: 'no_existing_structure_detected',
    samples: {
      verified: [],
      missing: [],
      wrongBlocks: [],
      wrongStates: [],
      extraBlocks: []
    }
  }

  for (const block of worldBlocks) {
    const actual = blockDetailsAt(context, block.position)
    if (isAirName(actual.name)) {
      summary.missingBlocks += 1
      addSample(summary.samples.missing, block.position, block.type, actual.name)
      continue
    }
    summary.detectedExistingBlocks += 1
    const coveredGrassDecay = coveredGrassDecaySatisfied(actual.name, block.type, block.position, worldBlocks)
    if (!coveredGrassDecay &&
      !buildTargetNameMatches(actual.name, block.type, block.position, preview.origin, block.states || block.orientation)) {
      summary.wrongBlocks += 1
      if (isNaturalSiteBlock(actual.name)) summary.naturalBlocks += 1
      else summary.unknownBlocks += 1
      addSample(summary.samples.wrongBlocks, block.position, block.type, actual.name)
      continue
    }
    // A match on a natural block type (dirt/grass terrain fill etc.) is not
    // evidence of a half-built structure — untouched ground coincides with
    // terrain-resolved blueprint blocks by design. Only matches on
    // non-natural (structural) types feed the reconciliation signal.
    const structuralMatch = !isNaturalSiteBlock(block.type)
    if (!coveredGrassDecay &&
      !blockStatesMatchExpected(actual.states, block.states || block.orientation || {}, block.type)) {
      summary.wrongStates += 1
      if (structuralMatch) summary.blueprintMatchingBlocks += 1
      else summary.naturalBlocks += 1
      addSample(summary.samples.wrongStates, block.position, block.type, actual.name)
      continue
    }
    summary.verifiedBlocks += 1
    if (structuralMatch) summary.blueprintMatchingBlocks += 1
    else summary.naturalBlocks += 1
    addSample(summary.samples.verified, block.position, block.type, actual.name)
  }

  summary.extraBlocks = countExtraStructureBlocks(context, summary.bounds, expectedByPosition, summary.samples.extraBlocks)
  const transientRun = createConstructionRun({
    blueprintId: preview.constructionPlan?.blueprintId || preview.blueprintIR?.id || preview.blueprintName,
    blueprintRevision: preview.constructionPlan?.blueprintRevision || preview.blueprintIR?.metadata?.revision || null,
    blueprintHash: preview.constructionPlan?.blueprintHash || null,
    planId: preview.constructionPlan?.planId || null,
    placementContext: preview.constructionPlan?.placement || { origin: preview.origin, rotationY: 0, mirror: { x: false, z: false } },
    world: getWorldIdentity(context),
    bounds: summary.bounds,
    steps: preview.orderPlan?.steps || []
  })
  const reconciliation = reconcileConstructionRun(context, transientRun, preview.orderPlan?.steps || [])
  summary.verifiedSteps = reconciliation.verified
  summary.pendingSteps = reconciliation.pending
  summary.repairSteps = reconciliation.repair
  summary.stateRepairSteps = reconciliation.stateRepair
  summary.cleanupSteps = reconciliation.cleanup
  summary.likelyCurrentPhase = reconciliation.runPatch.currentPhase || 'site_prepare'
  summary.canResume = summary.detectedExistingBlocks >= threshold && (
    summary.verifiedBlocks > 0 ||
    summary.verifiedSteps > 0 ||
    summary.wrongBlocks > 0 ||
    summary.wrongStates > 0
  )
  summary.reason = summary.canResume
    ? 'existing_structure_can_be_reconciled'
    : (summary.detectedExistingBlocks >= threshold ? 'existing_structure_needs_manual_reconciliation' : 'no_significant_existing_structure')
  return summary
}

function countExtraStructureBlocks(context, bounds, expectedByPosition, samples = []) {
  if (!bounds) return 0
  let count = 0
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const position = { x, y, z }
        if (expectedByPosition.has(positionKey(position))) continue
        const actual = blockDetailsAt(context, position)
        if (isAirName(actual.name)) continue
        count += 1
        addSample(samples, position, null, actual.name)
      }
    }
  }
  return count
}

function blockStatesMatchExpected(actualStates, expectedStates = {}, blockName = null) {
  for (const [key, value] of Object.entries(expectedStates || {})) {
    if (!isComparablePlacementStateKey(blockName, key, value)) continue
    if (String(actualStates?.[key]) !== String(value)) return false
  }
  return true
}

function addSample(samples, position, expected, actual) {
  if (!Array.isArray(samples) || samples.length >= 8) return
  samples.push({ position: clonePlainObject(position), expected: expected || null, actual: actual || null })
}

function existingStructureBlockedResult(preview, decision) {
  return {
    ...preview,
    ok: false,
    error: decision.reason || 'EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION',
    constructionRunDecision: decision,
    existingStructure: decision.rescue,
    rescue: decision.rescue
  }
}

function logConstructionRunDecision(context, decision) {
  logBuilding(context, `[BUILDING_RUN_DECISION] ${JSON.stringify({
    identity: decision.identity,
    worktree: decision.worktree,
    branch: decision.branch,
    runId: decision.runId,
    resumeOrFresh: decision.resumeOrFresh,
    reason: decision.reason,
    blueprintHash: decision.blueprintHash,
    placement: decision.placement,
    bounds: decision.bounds,
    detectedExistingTargetBlocks: decision.detectedExistingTargetBlocks,
    detectedExistingBlocks: decision.detectedExistingBlocks,
    verifiedTargetBlocks: decision.verifiedTargetBlocks,
    missingTargetBlocks: decision.missingTargetBlocks,
    wrongTargetBlocks: decision.wrongTargetBlocks,
    wrongStateTargetBlocks: decision.wrongStateTargetBlocks,
    extraNonBlueprintBlocks: decision.extraNonBlueprintBlocks,
    verifiedConstructionSteps: decision.verifiedConstructionSteps,
    pendingConstructionSteps: decision.pendingConstructionSteps,
    verifiedSteps: decision.verifiedSteps,
    pendingSteps: decision.pendingSteps,
    currentPhase: decision.currentPhase
  })}`)
}

function applyRuntimeSafeBlockSubstitutions(preview, context = null) {
  if (!preview || typeof preview !== 'object') return preview
  let patched = 0
  const replacementPositions = new Set()
  const worldBlocks = Array.isArray(preview.worldBlocks)
    ? preview.worldBlocks.map(block => {
        if (!requiresUnsupportedCampfireRuntimeReplacement(
          block,
          block?.type,
          block?.states || block?.orientation
        )) {
          return block
        }
        patched += 1
        if (block?.position) replacementPositions.add(positionKey(block.position))
        return {
          ...block,
          type: 'stone',
          states: {},
          orientation: {},
          runtimeSafeReplacement: {
            from: block.type,
            reason: 'unsupported_sanitized_campfire_lantern'
          }
        }
      })
    : preview.worldBlocks

  const steps = Array.isArray(preview.orderPlan?.steps)
    ? preview.orderPlan.steps.map(step => {
        if (!requiresUnsupportedCampfireRuntimeReplacement(
          step,
          step?.blockName,
          step?.states || step?.orientation || step?.block?.states
        )) {
          return step
        }
        patched += 1
        if (step.position) replacementPositions.add(positionKey(step.position))
        return {
          ...step,
          blockName: 'stone',
          states: {},
          orientation: {},
          block: step.block ? { ...step.block, id: 'stone', states: {} } : step.block,
          runtimeSafeReplacement: {
            from: step.blockName,
            reason: 'unsupported_sanitized_campfire_lantern'
          }
        }
      })
    : preview.orderPlan?.steps

  const constructionPlanSteps = Array.isArray(preview.constructionPlan?.steps)
    ? preview.constructionPlan.steps.map(step => {
        const blockName = step?.block?.id || step?.blockName
        const states = step?.block?.states || step?.states || step?.orientation
        if (!requiresUnsupportedCampfireRuntimeReplacement(step, blockName, states)) return step
        patched += 1
        const position = step.target || step.position
        if (position) replacementPositions.add(positionKey(position))
        return {
          ...step,
          blockName: step.blockName ? 'stone' : step.blockName,
          states: step.states ? {} : step.states,
          orientation: step.orientation ? {} : step.orientation,
          block: step.block ? { ...step.block, id: 'stone', states: {} } : step.block,
          runtimeSafeReplacement: {
            from: blockName,
            reason: 'unsupported_sanitized_campfire_lantern'
          }
        }
      })
    : preview.constructionPlan?.steps

  const resolvedBlueprint = applyRuntimeSafeBlueprintSubstitutions(
    preview.resolvedBlueprint || preview.blueprint
  )
  patched += resolvedBlueprint.patched

  if (!patched) return preview
  return reconcileRuntimeMaterialPlan({
    ...preview,
    resolvedBlueprint: resolvedBlueprint.blueprint,
    worldBlocks,
    orderPlan: preview.orderPlan
      ? {
          ...preview.orderPlan,
          steps
        }
      : preview.orderPlan,
    constructionPlan: preview.constructionPlan
      ? {
          ...preview.constructionPlan,
          steps: constructionPlanSteps
        }
      : preview.constructionPlan,
    runtimeSafeReplacements: {
      ...(preview.runtimeSafeReplacements || {}),
      unsupportedSanitizedCampfireLantern: replacementPositions.size
    }
  }, context)
}

function applyMaterialResolutionToPreview(preview, counts = {}, options = {}) {
  if (!preview || typeof preview !== 'object') return preview
  const steps = preview.orderPlan?.steps || []
  if (!Array.isArray(steps) || !steps.length) return preview
  const resolution = resolveMaterialSteps(steps, counts || {}, {
    bounds: preview.sitePlan?.bounds || createBuildBounds(preview.worldBlocks || []),
    runSteps: materialResolutionRunSteps(
      options.context,
      options.runSteps || {},
      steps,
      options.origin
    ),
    materialOverrides: options.materialOverrides || [],
    skipVerified: options.skipVerified
  })
  if (!resolution.resolutions.length) return preview

  const resolutionByStepId = new Map()
  const resolutionByPosition = new Map()
  for (const step of resolution.steps) {
    if (!step?.materialResolution) continue
    if (step.id) resolutionByStepId.set(step.id, step.materialResolution)
    if (step.position) resolutionByPosition.set(positionKey(step.position), step.materialResolution)
  }

  const worldBlocks = (preview.worldBlocks || []).map(block => {
    const materialResolution = block?.position ? resolutionByPosition.get(positionKey(block.position)) : null
    if (!materialResolution) return block
    const changed = materialResolution.resolvedBlock !== materialResolution.originalBlock
    return {
      ...block,
      type: materialResolution.resolvedBlock,
      originalType: materialResolution.originalBlock,
      states: changed ? {} : (block.states || null),
      orientation: changed ? {} : (block.orientation || null),
      materialResolution
    }
  })

  const orderPlan = preview.orderPlan
    ? {
        ...preview.orderPlan,
        steps: resolution.steps
      }
    : preview.orderPlan
  const constructionPlan = preview.constructionPlan
    ? {
        ...preview.constructionPlan,
        steps: (preview.constructionPlan.steps || []).map(step => {
          const materialResolution = resolutionByStepId.get(step.id)
          if (!materialResolution) return step
          const changed = materialResolution.resolvedBlock !== materialResolution.originalBlock
          return {
            ...step,
            block: step.block
              ? {
                  ...step.block,
                  id: materialResolution.resolvedBlock,
                  states: changed ? {} : (step.block.states || {})
                }
              : step.block,
            originalBlock: { id: materialResolution.originalBlock },
            resolvedBlock: { id: materialResolution.resolvedBlock },
            role: step.role || materialResolution.role || null,
            exactRequired: materialResolution.exactRequired === true,
            materialResolution
          }
        }),
        materials: {
          ...(preview.constructionPlan.materials || {})
        }
      }
    : preview.constructionPlan
  const resolvedBlueprint = resolveBlueprintForMaterialResolution(preview.blueprint, preview.origin, resolutionByPosition)
  const materialResolution = summarizeMaterialResolution(resolution, counts)
  logMaterialResolution(options.context, materialResolution, options.source)

  const materialPlan = reconcileResolvedMaterialPlan(
    preview.materialPlan,
    worldBlocks,
    counts,
    materialResolution,
    orderPlan?.steps || []
  )
  if (constructionPlan?.materials) {
    constructionPlan.materials = {
      ...constructionPlan.materials,
      required: materialPlan.requiredMaterials,
      formalRequired: materialPlan.formalRequiredMaterials,
      missing: materialPlan.missingMaterials,
      materialResolution
    }
  }

  return applyRuntimeSafeBlockSubstitutions({
    ...preview,
    blueprint: resolvedBlueprint || preview.blueprint,
    resolvedBlueprint: resolvedBlueprint || preview.resolvedBlueprint || preview.blueprint,
    worldBlocks,
    orderPlan,
    constructionPlan,
    materialPlan,
    requiredMaterials: materialPlan.requiredMaterials,
    formalRequiredMaterials: materialPlan.formalRequiredMaterials,
    missingMaterials: materialPlan.missingMaterials,
    materialResolution,
    canBuild: materialPlan.missingMaterials.length === 0 && !(preview.blockedReasons || []).length,
    reason: (preview.blockedReasons || [])[0] || (materialPlan.missingMaterials.length ? 'missing_materials' : null)
  }, options.context)
}

function applyRuntimeSafeBlueprintSubstitutions(blueprint) {
  if (!blueprint || !Array.isArray(blueprint.blocks)) return { blueprint, patched: 0 }
  let patched = 0
  const blocks = blueprint.blocks.map(block => {
    const blockName = block?.type || block?.name || block?.blockName || block?.block?.id
    const states = block?.states || block?.orientation || block?.block?.states
    if (!requiresUnsupportedCampfireRuntimeReplacement(block, blockName, states)) return block
    patched += 1
    return {
      ...block,
      type: block.type ? 'stone' : block.type,
      name: block.name ? 'stone' : block.name,
      blockName: block.blockName ? 'stone' : block.blockName,
      states: block.states ? {} : block.states,
      orientation: block.orientation ? {} : block.orientation,
      block: block.block ? { ...block.block, id: 'stone', states: {} } : block.block,
      runtimeSafeReplacement: {
        from: blockName,
        reason: 'unsupported_sanitized_campfire_lantern'
      }
    }
  })
  return {
    blueprint: patched ? { ...blueprint, blocks } : blueprint,
    patched
  }
}

function resolveBlueprintForMaterialResolution(blueprint, origin, resolutionByPosition) {
  if (!blueprint || !origin || !resolutionByPosition?.size) return blueprint
  const worldBlocks = toWorldBlocks(blueprint, origin)
  let changed = false
  const blocks = (blueprint.blocks || []).map((block, index) => {
    const world = worldBlocks[index]
    const materialResolution = world?.position ? resolutionByPosition.get(positionKey(world.position)) : null
    if (!materialResolution) return block
    changed = true
    const resolved = materialResolution.resolvedBlock
    const blockChanged = resolved !== materialResolution.originalBlock
    return {
      ...block,
      type: resolved,
      originalType: materialResolution.originalBlock,
      states: blockChanged ? {} : (block.states || {}),
      orientation: blockChanged ? {} : (block.orientation || {}),
      materialResolution
    }
  })
  if (!changed) return blueprint
  return {
    ...blueprint,
    blocks,
    metadata: {
      ...(blueprint.metadata || {}),
      materialResolutionApplied: true
    }
  }
}

function reconcileResolvedMaterialPlan(materialPlan = {}, worldBlocks = [], counts = {}, materialResolution = null, steps = []) {
  const executableFormalRequired = materialCountsFromPlacementSteps(steps, { includeSupport: false })
  const executableRequired = materialCountsFromPlacementSteps(steps, { includeSupport: true })
  const hasExecutableMaterials = Object.keys(executableRequired).length > 0
  const formalRequiredMaterials = hasExecutableMaterials
    ? executableFormalRequired
    : (materialPlan.formalRequiredMaterials || materialCountsFromWorldBlocks(worldBlocks))
  const requiredMaterials = hasExecutableMaterials
    ? executableRequired
    : mergeMaterialCounts(
        formalRequiredMaterials,
        materialPlan.foundationRequiredMaterials || {},
        materialPlan.scaffoldRequiredMaterials || {}
      )
  return {
    ...materialPlan,
    requiredMaterials,
    formalRequiredMaterials,
    missingMaterials: missingMaterialsFromRequiredCounts(requiredMaterials, counts || {}),
    materialResolution
  }
}

function summarizeMaterialResolution(resolution, counts = {}) {
  const shortageOriginal = missingMaterialsFromRequiredCounts(resolution.originalRequired || {}, counts || {})
  const shortageResolved = missingMaterialsFromRequiredCounts(resolution.resolvedRequired || {}, counts || {})
  return {
    originalRequired: clonePlainObject(resolution.originalRequired || {}),
    resolvedRequired: clonePlainObject(resolution.resolvedRequired || {}),
    available: clonePlainObject(counts || {}),
    substitutions: clonePlainObject(resolution.substitutions || []),
    shortageOriginal,
    shortageResolved,
    shortageResolvedCount: shortageResolved.reduce((sum, entry) => sum + (Number(entry.missing) || 0), 0),
    affectsWorldDiff: (resolution.substitutions || []).length > 0
  }
}

function logMaterialResolution(context, materialResolution, source = 'material_resolution') {
  const groups = new Map()
  for (const substitution of materialResolution?.substitutions || []) {
    const key = `${substitution.originalBlock}->${substitution.resolvedBlock}:${substitution.reason}:${substitution.source}`
    const entry = groups.get(key) || {
      originalBlock: substitution.originalBlock,
      resolvedBlock: substitution.resolvedBlock,
      reason: substitution.reason,
      source: substitution.source || source,
      exactRequired: false,
      affectsWorldDiff: true,
      count: 0
    }
    entry.count += 1
    groups.set(key, entry)
  }
  for (const entry of groups.values()) {
    logBuilding(context, `[MATERIAL_RESOLUTION] ${JSON.stringify(entry)}`)
  }
}

function mergeResolvedStepsIntoRun(run, steps = [], options = {}) {
  if (!run?.steps || !Array.isArray(steps)) return run
  const patched = { ...(run.steps || {}) }
  for (const step of steps) {
    if (!step?.id || !patched[step.id]) continue
    if (patched[step.id].status === STEP_STATE.VERIFIED &&
      !verifiedNaturalEquivalentMayAdoptResolvedStep(options.context, patched[step.id], step, options.origin)) {
      continue
    }
    const mergedStates = expectedStatesForStep(step) || expectedStatesForStep(patched[step.id]) || {}
    patched[step.id] = {
      ...patched[step.id],
      phase: step.phase || patched[step.id].phase || null,
      lifecyclePhase: normalizeConstructionPhase(step.phase || patched[step.id].phase, step),
      role: step.role || patched[step.id].role || null,
      materialAlternatives: [...(step.materialAlternatives || patched[step.id].materialAlternatives || [])],
      exactRequired: step.exactRequired === true,
      originalBlock: step.originalBlockName ? { id: step.originalBlockName } : (patched[step.id].originalBlock || null),
      resolvedBlock: step.resolvedBlockName ? { id: step.resolvedBlockName } : (patched[step.id].resolvedBlock || null),
      block: step.blockName
        ? { id: step.blockName, states: mergedStates }
        : patched[step.id].block,
      materialResolution: clonePlainObject(step.materialResolution || patched[step.id].materialResolution || null),
      // The runtime plan is authoritative for unresolved dependency edges.
      // Keeping the union would resurrect invalid edges that were deliberately
      // removed by applyPhysicalSupportDependencies while healing a stored run.
      dependencies: Array.isArray(step.dependencies)
        ? mergeStepDependencies(step.dependencies)
        : mergeStepDependencies(patched[step.id].dependencies)
    }
  }
  return {
    ...run,
    steps: patched
  }
}

function materialResolutionRunSteps(context, runSteps = {}, steps = [], origin = null) {
  if (!context || !origin || !runSteps || typeof runSteps !== 'object') return runSteps
  let adjusted = null
  for (const step of steps || []) {
    const stored = step?.id ? runSteps[step.id] : null
    if (stored?.status !== STEP_STATE.VERIFIED || !step?.position) continue
    const expected = stored.resolvedBlock?.id || stored.block?.id || null
    const actual = blockDetailsAt(context, step.position).name
    if (!expected || actual === expected ||
      !isStableNaturalTargetEquivalent(actual, expected, step.position, { origin })) {
      continue
    }
    if (!adjusted) adjusted = { ...runSteps }
    adjusted[step.id] = { ...stored, status: STEP_STATE.PENDING }
  }
  return adjusted || runSteps
}

function verifiedNaturalEquivalentMayAdoptResolvedStep(context, stored, step, origin = null) {
  const position = step?.position || stored?.target
  const previousBlock = stored?.resolvedBlock?.id || stored?.block?.id || null
  const resolvedBlock = step?.resolvedBlockName || step?.blockName || step?.resolvedBlock?.id || step?.block?.id || null
  if (!context || !origin || !position || !previousBlock || !resolvedBlock || previousBlock === resolvedBlock) return false
  const actual = blockDetailsAt(context, position).name
  return actual === resolvedBlock &&
    isStableNaturalTargetEquivalent(actual, previousBlock, position, { origin })
}

function mergeStepDependencies(...dependencyLists) {
  const merged = []
  for (const list of dependencyLists) {
    if (!Array.isArray(list)) continue
    for (const dependency of list) {
      if (!dependency || merged.includes(dependency)) continue
      merged.push(dependency)
    }
  }
  return merged
}

function applyConstructionExecutionStepsForRun(preview, run) {
  const orderSteps = preview?.orderPlan?.steps || []
  if (!preview?.orderPlan || !Array.isArray(orderSteps) || !run?.steps) return preview
  const steps = mergeRuntimeAndStoredSteps(orderSteps, run.steps || {})
  const mergedPreview = applyRunStateOverridesToPreview({
    ...preview,
    orderPlan: {
      ...preview.orderPlan,
      steps,
      summary: summarizeExecutionOrderSteps(steps, preview.orderPlan.summary)
    },
    constructionPlan: preview.constructionPlan
      ? {
          ...preview.constructionPlan,
        steps
      }
      : preview.constructionPlan
  }, run)
  return applyPhysicalSupportDependencies(mergedPreview)
}

function applyRunStateOverridesToPreview(preview, run) {
  const overrides = Array.isArray(run?.stateOverrides) ? run.stateOverrides.filter(isValidStateOverride) : []
  if (!overrides.length || !preview || typeof preview !== 'object') return preview

  const overrideByStepId = new Map()
  for (const override of overrides) {
    for (const stepId of stateOverrideStepIds(override)) {
      if (!overrideByStepId.has(stepId)) overrideByStepId.set(stepId, override)
    }
  }
  if (!overrideByStepId.size) return preview

  const positionOverrides = new Map()
  const steps = (preview.orderPlan?.steps || []).map(step => {
    const patched = applyStateOverrideToStep(step, overrideByStepId.get(step?.id))
    if (patched !== step && patched.position) {
      positionOverrides.set(positionKey(patched.position), {
        override: overrideByStepId.get(step.id),
        blockName: patched.blockName || patched.block?.id || null
      })
    }
    return patched
  })

  const worldBlocks = (preview.worldBlocks || []).map(block => {
    const entry = block?.position ? positionOverrides.get(positionKey(block.position)) : null
    if (!entry) return block
    if (entry.blockName && block.type && entry.blockName !== block.type) return block
    return applyStateOverrideToWorldBlock(block, entry.override)
  })

  const constructionPlan = preview.constructionPlan
    ? {
        ...preview.constructionPlan,
        steps: (preview.constructionPlan.steps || []).map(step =>
          applyStateOverrideToConstructionPlanStep(step, overrideByStepId.get(step?.id))
        )
      }
    : preview.constructionPlan

  return {
    ...preview,
    worldBlocks,
    orderPlan: {
      ...preview.orderPlan,
      steps,
      summary: summarizeExecutionOrderSteps(steps, preview.orderPlan.summary)
    },
    constructionPlan,
    stateOverridesApplied: overrides.length
  }
}

function isValidStateOverride(override) {
  return override && typeof override === 'object' &&
    override.states &&
    typeof override.states === 'object' &&
    stateOverrideStepIds(override).length > 0
}

function stateOverrideStepIds(override = {}) {
  return [
    ...(Array.isArray(override.sourceStepIds) ? override.sourceStepIds : []),
    ...(Array.isArray(override.stepIds) ? override.stepIds : [])
  ].filter(Boolean)
}

function applyStateOverrideToStep(step, override) {
  if (!step || !override) return step
  const blockName = step.blockName || step.block?.id || null
  if (override.blockId && blockName && override.blockId !== blockName) return step
  const states = {
    ...(step.states || step.orientation || step.block?.states || {}),
    ...(override.states || {})
  }
  return {
    ...step,
    states,
    orientation: states,
    block: step.block ? { ...step.block, states } : step.block,
    stateNormalization: stateNormalizationRecord(override)
  }
}

function applyStateOverrideToConstructionPlanStep(step, override) {
  if (!step || !override) return step
  const blockName = step.block?.id || null
  if (override.blockId && blockName && override.blockId !== blockName) return step
  const states = {
    ...(step.block?.states || {}),
    ...(override.states || {})
  }
  return {
    ...step,
    block: step.block ? { ...step.block, states } : step.block,
    stateNormalization: stateNormalizationRecord(override)
  }
}

function applyStateOverrideToWorldBlock(block, override) {
  if (!block || !override) return block
  if (override.blockId && block.type && override.blockId !== block.type) return block
  const states = {
    ...(block.states || block.orientation || {}),
    ...(override.states || {})
  }
  return {
    ...block,
    states,
    orientation: states,
    stateNormalization: stateNormalizationRecord(override)
  }
}

function stateNormalizationRecord(override = {}) {
  return {
    reason: override.reason || 'state_override',
    scope: override.scope || 'currentRun',
    affectsWorldDiff: override.affectsWorldDiff === true,
    sourceStepIds: stateOverrideStepIds(override),
    states: clonePlainObject(override.states || {})
  }
}

function summarizeExecutionOrderSteps(steps = [], fallback = {}) {
  const summary = {
    ...(fallback || {}),
    clear: 0,
    foundation: 0,
    scaffoldPlace: 0,
    place: 0,
    exteriorPlace: 0,
    interiorPlace: 0,
    fluidPlace: 0,
    scaffoldRemove: 0,
    totalSteps: steps.length
  }
  for (const step of steps || []) {
    if (step?.kind === 'clear') summary.clear += 1
    else if (step?.kind === 'foundation_fill') summary.foundation += 1
    else if (step?.kind === 'scaffold_place') summary.scaffoldPlace += 1
    else if (step?.kind === 'scaffold_remove') summary.scaffoldRemove += 1
    else if (step?.kind === 'place') {
      summary.place += 1
      if (step.interior === true || step.phase === 'interior') summary.interiorPlace += 1
      else summary.exteriorPlace += 1
      if (isFluidPlacementStep(step)) summary.fluidPlace += 1
    }
  }
  return summary
}

function reconcileRuntimeMaterialPlan(preview, context = null) {
  const executableFormalRequired = materialCountsFromPlacementSteps(preview.orderPlan?.steps || [], { includeSupport: false })
  const executableRequired = materialCountsFromPlacementSteps(preview.orderPlan?.steps || [], { includeSupport: true })
  const hasExecutableMaterials = Object.keys(executableRequired).length > 0
  const formalRequiredMaterials = hasExecutableMaterials
    ? executableFormalRequired
    : materialCountsFromWorldBlocks(preview.worldBlocks || [])
  if (!Object.keys(formalRequiredMaterials).length || !preview.materialPlan) return preview

  const requiredMaterials = hasExecutableMaterials
    ? executableRequired
    : mergeMaterialCounts(
        formalRequiredMaterials,
        preview.materialPlan.foundationRequiredMaterials || {},
        preview.materialPlan.scaffoldRequiredMaterials || {}
      )
  const counts = context ? getLiveInventoryCounts(context) : null
  const missingMaterials = counts
    ? missingMaterialsFromRequiredCounts(requiredMaterials, counts)
    : (preview.materialPlan.missingMaterials || [])
  const materialPlan = {
    ...preview.materialPlan,
    requiredMaterials,
    formalRequiredMaterials,
    missingMaterials
  }
  const constructionPlan = preview.constructionPlan
    ? {
        ...preview.constructionPlan,
        materials: {
          ...(preview.constructionPlan.materials || {}),
          required: requiredMaterials,
          formalRequired: formalRequiredMaterials,
          missing: missingMaterials
        }
      }
    : preview.constructionPlan

  return {
    ...preview,
    requiredMaterials,
    formalRequiredMaterials,
    missingMaterials,
    materialPlan,
    constructionPlan,
    canBuild: missingMaterials.length === 0 && !(preview.blockedReasons || []).length,
    reason: (preview.blockedReasons || [])[0] || (missingMaterials.length ? 'missing_materials' : null)
  }
}

function materialCountsFromWorldBlocks(worldBlocks = []) {
  const counts = {}
  for (const block of worldBlocks || []) {
    if (!block || isAirName(block.type || block.name || block.blockName)) continue
    for (const [itemName, count] of Object.entries(itemRequirementsForStep(block))) {
      if (!itemName) continue
      counts[itemName] = (counts[itemName] || 0) + count
    }
  }
  return counts
}

function materialCountsFromPlacementSteps(steps = [], options = {}) {
  const counts = {}
  const includeSupport = options.includeSupport === true
  for (const step of steps || []) {
    const kind = String(step?.kind || '')
    if (kind !== 'place' && !(includeSupport && (kind === 'foundation_fill' || kind === 'scaffold_place'))) {
      continue
    }
    const blockName = step.blockName || step.block?.id || step.type || step.name
    if (!blockName || isAirName(blockName)) continue
    const block = {
      ...step,
      type: blockName,
      name: blockName,
      blockName
    }
    for (const [itemName, count] of Object.entries(itemRequirementsForStep(block))) {
      if (!itemName) continue
      counts[itemName] = (counts[itemName] || 0) + count
    }
  }
  return counts
}

function mergeMaterialCounts(...maps) {
  const merged = {}
  for (const map of maps) {
    for (const [itemName, count] of Object.entries(map || {})) {
      const amount = Number(count) || 0
      if (amount <= 0) continue
      merged[itemName] = (merged[itemName] || 0) + amount
    }
  }
  return merged
}

function missingMaterialsFromRequiredCounts(requiredMaterials = {}, counts = {}) {
  return Object.entries(requiredMaterials)
    .map(([item, required]) => ({
      item,
      required,
      available: Number(counts[item]) || 0,
      missing: Math.max(0, required - (Number(counts[item]) || 0)),
      usages: [{ usage: 'runtime_reconciled', count: required }]
    }))
    .filter(entry => entry.available < entry.required)
}

function isUnsupportedSanitizedCampfireRuntimeBlock(blockName, states = {}) {
  if (String(blockName || '') !== 'lantern') return false
  return Object.prototype.hasOwnProperty.call(states || {}, 'signal_fire')
}

function requiresUnsupportedCampfireRuntimeReplacement(value, blockName, states = {}) {
  if (isUnsupportedSanitizedCampfireRuntimeBlock(blockName, states)) return true
  return String(blockName || '') !== 'stone' &&
    value?.runtimeSafeReplacement?.reason === 'unsupported_sanitized_campfire_lantern'
}

function applyPhysicalSupportDependencies(preview) {
  const steps = preview?.orderPlan?.steps
  if (!Array.isArray(steps) || !steps.length) return preview
  const patchedSteps = steps.map(step => ({
    ...step,
    dependencies: [...(step.dependencies || [])]
  }))
  const byPosition = new Map()
  const byId = new Map()
  for (const step of patchedSteps) {
    if (!step?.id || !step.position) continue
    byPosition.set(positionKey(step.position), step)
    byId.set(step.id, step)
  }

  let patched = 0
  for (const step of patchedSteps) {
    const supportOffset = physicalSupportOffsetForStep(step)
    if (!supportOffset) continue
    const support = byPosition.get(positionKey({
      x: step.position.x + supportOffset.x,
      y: step.position.y + supportOffset.y,
      z: step.position.z + supportOffset.z
    }))
    if (!support?.id || support.id === step.id) continue
    if (!isValidPlannedPhysicalSupport(step, support)) {
      const invalidDependencyIndex = step.dependencies.indexOf(support.id)
      if (invalidDependencyIndex >= 0) {
        // Stored runs may contain the obsolete reverse edge. Remove it before
        // adding the valid direction so resumption cannot preserve a cycle.
        step.dependencies.splice(invalidDependencyIndex, 1)
        patched += 1
      }
      continue
    }
    if (stepTransitivelyDependsOn(support, step.id, byId)) continue
    if (!step.dependencies.includes(support.id)) {
      step.dependencies.push(support.id)
      patched += 1
    }
    const supportPhase = normalizeConstructionPhase(support.phase, support)
    const stepPhase = normalizeConstructionPhase(step.phase, step)
    if (phaseOrderRank(supportPhase) > phaseOrderRank(stepPhase)) {
      step.phase = supportPhase
      patched += 1
    }
  }

  if (!patched) return preview
  return {
    ...preview,
    orderPlan: {
      ...preview.orderPlan,
      steps: patchedSteps
    }
  }
}

function stepTransitivelyDependsOn(step, targetId, byId, visited = new Set()) {
  if (!step?.id || !targetId || visited.has(step.id)) return false
  visited.add(step.id)
  for (const dependencyId of step.dependencies || []) {
    if (dependencyId === targetId) return true
    if (stepTransitivelyDependsOn(byId.get(dependencyId), targetId, byId, visited)) return true
  }
  return false
}

function isValidPlannedPhysicalSupport(step, support) {
  const stepName = String(step?.blockName || '')
  const stepStates = step?.block?.states || step?.states || {}
  const supportName = String(support?.blockName || '')
  const supportStates = support?.block?.states || support?.states || {}
  const lantern = stepName === 'lantern' || stepName === 'soul_lantern'
  const hangingLantern = lantern && String(stepStates.hanging ?? '').toLowerCase() === 'true'

  // Closed trapdoors support lanterns only on the matching physical face,
  // even though trapdoors are intentionally excluded from generic references.
  if (lantern && /trapdoor$/.test(supportName)) {
    const half = String(supportStates.half ?? '').toLowerCase()
    return hangingLantern ? half === 'bottom' : half === 'top'
  }
  return isPlannedPlacementReferenceBlockName(supportName, supportStates)
}

function physicalSupportOffsetForStep(step) {
  if (!step || !['foundation_fill', 'scaffold_place', 'place'].includes(step.kind)) return false
  const originalName = String(step.blockName || '')
  const originalStates = step.block?.states || step.states || {}
  const legacyPlacement = legacySkullPlacement(originalName, originalStates)
  const name = legacyPlacement?.blockName || originalName
  const states = legacyPlacement
    ? { ...originalStates, ...legacyPlacement.states }
    : originalStates
  if (name.endsWith('_slab')) {
    const type = String(states.type ?? '').toLowerCase()
    // Stateful bottom/double slabs can be placed reliably against the
    // permanent block below. If that formal block is still planned, schedule
    // it first instead of constructing and exhausting a temporary dirt column.
    // Top slabs intentionally keep their side/upper-reference strategy.
    if (type === 'bottom' || type === 'double') return { x: 0, y: -1, z: 0 }
  }
  if (name === 'lantern' || name === 'soul_lantern') {
    const hanging = String(states.hanging ?? '').toLowerCase() === 'true'
    return hanging ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 }
  }
  if (
    name.endsWith('_candle') ||
    name === 'candle' ||
    name === 'cake' ||
    name === 'flower_pot' ||
    name.startsWith('potted_') ||
    name === 'sea_pickle' ||
    name.endsWith('_pressure_plate') ||
    name.endsWith('_carpet')
  ) {
    return { x: 0, y: -1, z: 0 }
  }
  if (name.endsWith('_button')) {
    const face = String(states.face ?? '').toLowerCase()
    if (face === 'ceiling') return { x: 0, y: 1, z: 0 }
    if (face === 'floor') return { x: 0, y: -1, z: 0 }
    return oppositeFacingOffset(states.facing)
  }
  if (
    name === 'ladder' ||
    name.endsWith('_wall_sign') ||
    name.endsWith('_wall_banner') ||
    name.endsWith('_wall_head') ||
    name.endsWith('_wall_skull') ||
    name.endsWith('_wall_torch')
  ) {
    return oppositeFacingOffset(states.facing)
  }
  if (
    name.endsWith('_torch') ||
    (name.endsWith('_sign') && !name.endsWith('_wall_sign')) ||
    (name.endsWith('_banner') && !name.endsWith('_wall_banner')) ||
    (name.endsWith('_head') && !name.endsWith('_wall_head')) ||
    (name.endsWith('_skull') && !name.endsWith('_wall_skull'))
  ) {
    return { x: 0, y: -1, z: 0 }
  }
  return null
}

function oppositeFacingOffset(facing) {
  switch (String(facing ?? '').toLowerCase()) {
    case 'north':
      return { x: 0, y: 0, z: 1 }
    case 'south':
      return { x: 0, y: 0, z: -1 }
    case 'east':
      return { x: -1, y: 0, z: 0 }
    case 'west':
      return { x: 1, y: 0, z: 0 }
    default:
      return null
  }
}

function positionKey(position) {
  return `${position.x},${position.y},${position.z}`
}

// 施工单上的参照声明 → 放置动作的 options。声明缺失时返回空对象，展开后
// 对 placeOptions 是恒等操作。
function clickedFacePlacementOptions(step = {}) {
  const options = {}
  const clickedFaceReference = step?.clickedFaceReference
  if (clickedFaceReference?.position) options.clickedFaceReference = clickedFaceReference
  const temporaryReference = step?.temporaryReference
  if (temporaryReference?.position) options.temporaryReference = temporaryReference
  return options
}

function temporaryReferenceAllowedPositionsForStep(session, step) {
  const current = step?.position || step?.target || null
  const currentKey = current ? positionKey(current) : null
  const allowed = new Set()
  const steps = Object.values(session?.constructionRun?.steps || {})
  for (const runStep of steps) {
    const status = runStep?.status || STEP_STATE.PENDING
    if (![STEP_STATE.PENDING, STEP_STATE.READY, STEP_STATE.EXECUTING].includes(status)) continue
    const target = runStep.target || runStep.position
    if (!target) continue
    const key = positionKey(target)
    if (key === currentKey) continue
    allowed.add(key)
  }
  return allowed
}

function createBuildBounds(worldBlocks = []) {
  const solid = worldBlocks.filter(block => block && block.position && !isAirName(block.type))
  if (!solid.length) return null
  return solid.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.position.x),
    maxX: Math.max(bounds.maxX, block.position.x),
    minY: Math.min(bounds.minY, block.position.y),
    maxY: Math.max(bounds.maxY, block.position.y),
    minZ: Math.min(bounds.minZ, block.position.z),
    maxZ: Math.max(bounds.maxZ, block.position.z)
  }), {
    minX: solid[0].position.x,
    maxX: solid[0].position.x,
    minY: solid[0].position.y,
    maxY: solid[0].position.y,
    minZ: solid[0].position.z,
    maxZ: solid[0].position.z
  })
}

function getWorldIdentity(context) {
  const dimension = context?.bot?.game?.dimension ||
    context?.bot?.entity?.dimension ||
    context?.worldState?.dimension ||
    'overworld'
  const contextWorldId = String(context?.worldIdentity?.id || context?.worldIdentity?.worldId || '').trim()
  const environmentWorldId = String(process.env.MC_WORLD_ID || '').trim()
  const worldId = contextWorldId || environmentWorldId || null
  return {
    dimension,
    ...(worldId
      ? {
          worldId,
          identitySource: contextWorldId ? 'context.worldIdentity' : 'MC_WORLD_ID'
        }
      : {})
  }
}

function reconcileConstructionRun(context, run, steps = []) {
  const now = new Date().toISOString()
  const reconciledSteps = { ...(run.steps || {}) }
  const summary = { verified: 0, pending: 0, repair: 0, stateRepair: 0, cleanup: 0 }
  const reconciliationSteps = mergeRuntimeAndStoredSteps(steps, run.steps || {})

  for (const step of reconciliationSteps) {
    if (!step?.id) continue
    const previous = reconciledSteps[step.id] || { id: step.id, retry: { count: 0, lastError: null } }
    const status = reconciledStepStatus(context, step, previous, {
      steps: reconciliationSteps,
      runSteps: reconciledSteps,
      origin: run.placementContext?.origin || null
    })
    const runtimeBlockName = step.blockName || step.block?.id || null
    const previousBlockName = previous.resolvedBlock?.id || previous.block?.id || null
    const actual = step.position ? blockDetailsAt(context, step.position) : null
    const previousMatchesActual = status === STEP_STATE.VERIFIED &&
      previousBlockName &&
      actual?.name === previousBlockName &&
      stepStateMatches(actual.states, {
        ...step,
        blockName: previousBlockName,
        states: previous.resolvedBlock?.states || previous.block?.states || null,
        orientation: previous.resolvedBlock?.states || previous.block?.states || null
      })
    const preservePreviousMaterial = status === STEP_STATE.VERIFIED &&
      previous.block &&
      (previousMatchesActual || !runtimeBlockName || runtimeBlockName === previousBlockName)
    const preservePreviousBlock = preservePreviousMaterial && !step.stateNormalization
    step.runStatus = status
    reconciledSteps[step.id] = {
      ...previous,
      id: step.id,
      sourceBlockKey: step.sourceBlockKey || previous.sourceBlockKey || null,
      action: step.action || previous.action || null,
      legacyKind: step.kind || previous.legacyKind || null,
      phase: step.phase || previous.phase || null,
      lifecyclePhase: normalizeConstructionPhase(step.phase || previous.phase, step),
      target: step.position || previous.target || null,
      block: preservePreviousBlock
        ? previous.block
        : (step.blockName
            ? { id: step.blockName, states: step.states || step.orientation || {} }
            : previous.block || null),
      originalBlock: preservePreviousMaterial
        ? (previous.originalBlock || null)
        : (step.originalBlockName
            ? { id: step.originalBlockName }
            : (step.originalBlock || previous.originalBlock || null)),
      resolvedBlock: preservePreviousMaterial
        ? (previous.resolvedBlock || null)
        : (step.resolvedBlockName
            ? { id: step.resolvedBlockName }
            : (step.resolvedBlock || previous.resolvedBlock || null)),
      role: step.role || previous.role || null,
      materialAlternatives: [...(step.materialAlternatives || previous.materialAlternatives || [])],
      exactRequired: step.exactRequired === true || previous.exactRequired === true,
      materialPolicySource: step.materialPolicySource || previous.materialPolicySource || null,
      materialResolution: clonePlainObject(preservePreviousMaterial
        ? (previous.materialResolution || null)
        : (step.materialResolution || previous.materialResolution || null)),
      stateNormalization: clonePlainObject(step.stateNormalization || previous.stateNormalization || null),
      dependencies: Array.isArray(step.dependencies)
        ? mergeStepDependencies(step.dependencies)
        : mergeStepDependencies(previous.dependencies),
      status,
      updatedAt: now,
      reconciledAt: now
    }
    if (status === STEP_STATE.VERIFIED) summary.verified += 1
    else if (status === STEP_STATE.REPAIR) summary.repair += 1
    else if (status === STEP_STATE.STATE_REPAIR) summary.stateRepair += 1
    else if (status === STEP_STATE.CLEANUP) summary.cleanup += 1
    else summary.pending += 1
  }

  return {
    ...summary,
    runPatch: {
      steps: reconciledSteps,
      reconciliation: {
        ...summary,
        at: now
      },
      currentPhase: normalizeConstructionPhase(firstUnresolvedPhase(steps, reconciledSteps) || run.currentPhase || 'site_prepare')
    }
  }
}

function mergeRuntimeAndStoredSteps(runtimeSteps = [], storedSteps = {}) {
  const byId = new Map()
  for (const runtimeStep of runtimeSteps || []) {
    if (!runtimeStep?.id) continue
    const normalized = normalizeRuntimeConstructionStep(runtimeStep)
    if (!storedSteps?.[normalized.id] && isTransientScaffoldStep(normalized)) continue
    byId.set(normalized.id, storedSteps?.[normalized.id]
      ? hydrateRuntimeStepFromStoredRunStep(normalized, storedSteps[normalized.id])
      : normalized)
  }
  for (const stored of Object.values(storedSteps || {})) {
    if (!stored?.id || byId.has(stored.id)) continue
    byId.set(stored.id, legacyStepFromStoredRunStep(stored))
  }
  return [...byId.values()]
}

function hydrateRuntimeStepFromStoredRunStep(runtimeStep = {}, stored = {}) {
  if (!stored || typeof stored !== 'object') return runtimeStep
  const legacy = legacyStepFromStoredRunStep(stored)
  const states = expectedStatesForStep(runtimeStep) || expectedStatesForStep(legacy) || null
  const blockName = runtimeStep.blockName || legacy.blockName || null
  const runtimeBlock = runtimeStep.block || null
  const block = runtimeBlock
    ? {
        ...runtimeBlock,
        states: expectedStatesForStep({ block: runtimeBlock }) || states || runtimeBlock.states || {}
      }
    : (stored.block
        ? {
            ...clonePlainObject(stored.block),
            states: states || stored.block.states || {}
          }
        : (blockName ? { id: blockName, states: states || {} } : runtimeBlock))

  return {
    ...legacy,
    ...runtimeStep,
    kind: runtimeStep.kind || legacy.kind,
    action: runtimeStep.action || legacy.action,
    phase: runtimeStep.phase || legacy.phase,
    position: runtimeStep.position || legacy.position,
    blockName,
    block,
    states: states || runtimeStep.states || legacy.states || null,
    orientation: expectedStatesForStep({ states: runtimeStep.orientation }) || states || legacy.orientation || null,
    sourceBlockKey: runtimeStep.sourceBlockKey || legacy.sourceBlockKey || null,
    role: runtimeStep.role || legacy.role || null,
    materialAlternatives: [...(runtimeStep.materialAlternatives || legacy.materialAlternatives || [])],
    exactRequired: runtimeStep.exactRequired === true || legacy.exactRequired === true,
    originalBlockName: runtimeStep.originalBlockName || legacy.originalBlockName || null,
    resolvedBlockName: runtimeStep.resolvedBlockName || legacy.resolvedBlockName || null,
    materialResolution: clonePlainObject(runtimeStep.materialResolution || legacy.materialResolution || null),
    dependencies: Array.isArray(runtimeStep.dependencies)
      ? mergeStepDependencies(runtimeStep.dependencies)
      : mergeStepDependencies(legacy.dependencies)
  }
}

function isFluidPlacementStep(step = {}) {
  const name = String(step.blockName || step.block?.id || '')
  return /(?:^|_)water$|(?:^|_)lava$/.test(name)
}

function isTransientScaffoldStep(step = {}) {
  const kind = step.kind || step.legacyKind || kindFromAction(step.action)
  return kind === 'scaffold_place' || kind === 'scaffold_remove'
}

function normalizeRuntimeConstructionStep(step = {}) {
  const block = step.block || null
  const position = step.position || step.target || null
  const states = expectedStatesForStep({ ...step, block })
  return {
    ...step,
    kind: step.kind || kindFromAction(step.action),
    position,
    blockName: step.blockName || block?.id || null,
    states,
    orientation: step.orientation || states || null
  }
}

function legacyStepFromStoredRunStep(stored = {}) {
  const states = expectedStatesForStep(stored)
  return {
    id: stored.id,
    kind: stored.legacyKind || kindFromAction(stored.action),
    action: stored.action,
    phase: stored.phase || null,
    position: stored.target || null,
    blockName: stored.resolvedBlock?.id || stored.block?.id || null,
    states,
    orientation: states,
    sourceBlockKey: stored.sourceBlockKey || null,
    role: stored.role || null,
    materialAlternatives: [...(stored.materialAlternatives || [])],
    exactRequired: stored.exactRequired === true,
    originalBlockName: stored.originalBlock?.id || stored.materialResolution?.originalBlock || null,
    resolvedBlockName: stored.resolvedBlock?.id || stored.materialResolution?.resolvedBlock || null,
    materialResolution: clonePlainObject(stored.materialResolution || null),
    dependencies: [...(stored.dependencies || [])],
    ...(stored.renovationClear === true ? { renovationClear: true, renovationOf: stored.renovationOf || null } : {})
  }
}

function kindFromAction(action) {
  if (action === 'clear_block') return 'clear'
  if (action === 'place_block') return 'place'
  if (action === 'validate_walkability') return 'walkability_validate'
  if (action === 'validate_world') return 'validate'
  return 'unknown'
}

function reconciledStepStatus(context, step, previous = {}, options = {}) {
  if (step.kind === 'validate' || step.kind === 'walkability_validate') {
    return previous.status === STEP_STATE.VERIFIED ? STEP_STATE.PENDING : (previous.status || STEP_STATE.PENDING)
  }
  if (
    step.kind === 'scaffold_place' &&
    previous.status === STEP_STATE.VERIFIED &&
    previous.skipped === true &&
    previous.skipReason === 'optional_scaffold_move_timeout' &&
    !step.sourceBlockKey &&
    !previous.sourceBlockKey
  ) {
    return STEP_STATE.VERIFIED
  }
  if (!step.position) return previous.status || STEP_STATE.PENDING
  const actual = blockDetailsAt(context, step.position)
  if (
    step.kind === 'scaffold_place' &&
    isAirName(actual.name) &&
    hasVerifiedScaffoldCleanupForPlacement(step, options)
  ) {
    // A scaffold is intentionally absent after its paired cleanup step. Once
    // that cleanup has been verified, resume reconciliation must preserve the
    // completed lifecycle instead of rebuilding the temporary column.
    return STEP_STATE.VERIFIED
  }
  if (step.kind === 'scaffold_remove') return isAirName(actual.name) ? STEP_STATE.VERIFIED : STEP_STATE.CLEANUP
  if (previous.status === STEP_STATE.VERIFIED && previous.block?.id) {
    const previousStates = expectedStatesForStep(previous)
    const previousStep = {
      ...step,
      blockName: previous.resolvedBlock?.id || previous.block.id,
      states: previousStates,
      orientation: previousStates
    }
    if (coveredGrassDecaySatisfied(actual.name, previousStep.blockName, step.position, options.steps) ||
      (buildTargetNameMatches(actual.name, previousStep.blockName, step.position, options.origin, expectedStatesForStep(previousStep)) &&
      stepStateMatches(actual.states, previousStep))) {
      return STEP_STATE.VERIFIED
    }
  }
  if (step.kind === 'clear') {
    if (clearStepTargetAlreadyMatchesPlacement(context, step, options)) return STEP_STATE.VERIFIED
    if (shouldDeferExactClearToPlacementRepair({
      steps: options.steps || [],
      constructionRun: { steps: options.runSteps || {} }
    }, step, previous)) {
      return previous.status
    }
    return isAirName(actual.name) ? STEP_STATE.VERIFIED : STEP_STATE.PENDING
  }
  if (!step.blockName || isAirName(step.blockName)) return STEP_STATE.VERIFIED
  if (coveredGrassDecaySatisfied(actual.name, step.blockName, step.position, options.steps)) {
    return STEP_STATE.VERIFIED
  }
  if (buildTargetNameMatches(actual.name, step.blockName, step.position, options.origin, expectedStatesForStep(step))) {
    return stepStateMatches(actual.states, step) ? STEP_STATE.VERIFIED : STEP_STATE.STATE_REPAIR
  }
  if (isAirName(actual.name)) return STEP_STATE.PENDING
  return STEP_STATE.REPAIR
}

function hasVerifiedScaffoldCleanupForPlacement(placementStep, options = {}) {
  if (!placementStep?.id || !placementStep.position) return false
  const targetKey = positionKey(placementStep.position)
  return (options.steps || []).some(candidate => {
    if (!candidate?.id) return false
    const kind = candidate.kind || candidate.legacyKind || kindFromAction(candidate.action)
    if (kind !== 'scaffold_remove') return false
    const state = options.runSteps?.[candidate.id]
    if (!isStepVerified(state)) return false
    if (state?.replacementStepId === placementStep.id) return true
    const position = candidate.position || candidate.target || state?.target
    return position && positionKey(position) === targetKey
  })
}

function clearStepTargetAlreadyMatchesPlacement(context, clearStep, options = {}) {
  const expectedStep = findExpectedPlacementStepForClear({
    steps: options.steps || [],
    constructionRun: { steps: options.runSteps || {} }
  }, clearStep)
  if (!expectedStep) return false
  const expectedRunStep = expectedStep.id ? options.runSteps?.[expectedStep.id] : null
  const actual = blockDetailsAt(context, clearStep.position || clearStep.target)
  const candidates = [
    {
      blockName: expectedStep.resolvedBlockName || expectedStep.resolvedBlock?.id || null,
      states: expectedStatesForStep({ resolvedBlock: expectedStep.resolvedBlock }) || null
    },
    {
      blockName: expectedStep.blockName || expectedStep.block?.id || null,
      states: expectedStatesForStep(expectedStep) || null
    },
    {
      blockName: expectedRunStep?.resolvedBlock?.id || null,
      states: expectedStatesForStep({ resolvedBlock: expectedRunStep?.resolvedBlock }) || null
    },
    {
      blockName: expectedRunStep?.block?.id || null,
      states: expectedStatesForStep({ block: expectedRunStep?.block }) || null
    }
  ]
  const seen = new Set()
  for (const candidate of candidates) {
    const expectedBlock = candidate.blockName
    if (!expectedBlock || isAirName(expectedBlock) || seen.has(expectedBlock)) continue
    seen.add(expectedBlock)
    const expectedStates = candidate.states || null
    if (coveredGrassDecaySatisfied(
      actual.name,
      expectedBlock,
      clearStep.position || clearStep.target,
      options.steps
    )) {
      return true
    }
    if (!buildTargetNameMatches(
      actual.name,
      expectedBlock,
      clearStep.position || clearStep.target,
      options.origin,
      expectedStates
    )) continue
    if (stepStateMatches(actual.states, {
      ...expectedStep,
      blockName: expectedBlock,
      states: expectedStates,
      orientation: expectedStates
    })) {
      return true
    }
  }
  return false
}

function clearStepAlreadySatisfiedSkipResult(context, session, step, options = {}) {
  if (!step || step.kind !== 'clear') return { ok: false }
  if (options.allowTemporaryFinalBlockRemoval === true) return { ok: false }
  const runSteps = session?.constructionRun?.steps || {}
  const steps = session?.steps || []
  if (!clearStepTargetAlreadyMatchesPlacement(context, step, {
    steps,
    runSteps,
    origin: session?.origin || null
  })) {
    return { ok: false }
  }

  const expectedStep = findExpectedPlacementStepForClear(session, step)
  const expectedRunStep = expectedStep?.id ? runSteps[expectedStep.id] : null
  const target = step.position || step.target || null
  return {
    ok: true,
    skipped: true,
    reason: 'clear_target_already_matches_placement',
    expectedStepId: expectedStep?.id || null,
    expectedRunStepStatus: expectedRunStep?.status || null,
    clearSkipRecord: {
      skippedAt: new Date().toISOString(),
      skipReason: 'clear_target_already_matches_placement',
      expectedStepId: expectedStep?.id || null,
      expectedRunStepStatus: expectedRunStep?.status || null,
      target: clonePlainObject(target)
    }
  }
}

function isStepSatisfiedForScheduling(session, step, state) {
  if (isStepVerified(state)) return true
  const hydratedStep = state ? hydrateRuntimeStepFromStoredRunStep(step, state) : step
  if (shouldDeferFragilePlacementStep(session, hydratedStep, state)) return true
  if (shouldDeferValidationUntilCleanup(session, step)) return true
  return shouldDeferExactClearToPlacementRepair(session, step, state)
}

function shouldDeferValidationUntilCleanup(session, step) {
  const kind = step?.kind || kindFromAction(step?.action)
  if (kind !== 'validate' && kind !== 'walkability_validate') return false
  const runSteps = session?.constructionRun?.steps || {}
  return (session?.steps || []).some(candidate => {
    if (!candidate?.id || candidate.id === step.id) return false
    const candidateKind = candidate.kind || kindFromAction(candidate.action)
    const state = runSteps[candidate.id]
    if (isStepVerified(state)) return false
    if (kind === 'walkability_validate') {
      return candidateKind !== 'walkability_validate' && candidateKind !== 'validate'
    }
    return candidateKind !== 'validate'
  })
}

function constructionCompletionLedgerGate(session) {
  const runSteps = Object.values(session?.constructionRun?.steps || {})
  const unresolved = runSteps.filter(step => !isStepVerified(step))
  const counts = unresolved.reduce((summary, step) => {
    const status = step?.status || STEP_STATE.PENDING
    summary[status] = (summary[status] || 0) + 1
    return summary
  }, {})
  return {
    ok: unresolved.length === 0,
    error: unresolved.length ? `construction_run_unresolved_steps:${unresolved.length}` : null,
    unresolvedCount: unresolved.length,
    counts,
    sample: unresolved.slice(0, 12).map(step => ({
      id: step.id,
      status: step.status || STEP_STATE.PENDING,
      phase: step.phase || step.lifecyclePhase || null,
      target: clonePlainObject(step.target || null),
      error: step.retry?.lastError || null
    }))
  }
}

function shouldDeferExactClearToPlacementRepair(session, step, state = null) {
  if (!step || step.kind !== 'clear') return false
  const clearAlreadyResolvedOrFailed = Boolean(
    state?.clearedAt ||
    state?.clearRecord ||
    state?.clearCategory ||
    [STEP_STATE.RETRYABLE_FAILED, STEP_STATE.TERMINAL_FAILED].includes(state?.status)
  )
  if (!clearAlreadyResolvedOrFailed) return false
  const expectedStep = findExpectedPlacementStepForClear(session, step)
  if (!expectedStep) return false
  if (step.role === 'terrain_fill' || expectedStep.role === 'terrain_fill') return false
  if (step.exactRequired !== true && expectedStep.exactRequired !== true) return false
  const expectedRunStep = expectedStep.id ? session?.constructionRun?.steps?.[expectedStep.id] : null
  if (!expectedRunStep || isStepVerified(expectedRunStep)) return false
  return [
    STEP_STATE.PENDING,
    STEP_STATE.REPAIR,
    STEP_STATE.STATE_REPAIR,
    STEP_STATE.RETRYABLE_FAILED,
    STEP_STATE.TERMINAL_FAILED
  ].includes(expectedRunStep.status)
}

function firstUnresolvedPhase(steps = [], runSteps = {}) {
  let selected = null
  let selectedRank = null
  const session = { steps, constructionRun: { steps: runSteps } }
  for (const step of steps) {
    if (!step || isStepSatisfiedForScheduling(session, step, runSteps[step.id])) continue
    const phase = normalizeConstructionPhase(step.phase, step)
    const rank = phaseOrderRank(phase)
    if (selectedRank === null || rank < selectedRank) {
      selected = phase
      selectedRank = rank
    }
  }
  return selected
}

function nextExecutableStepIndex(session) {
  const steps = session?.steps || []
  const runSteps = session?.constructionRun?.steps || {}
  const verified = new Set(Object.values(runSteps).filter(isStepVerified).map(step => step.id))
  const earliestPhaseRank = earliestUnresolvedPhaseRank(steps, runSteps)
  const candidates = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const state = runSteps[step?.id]
    if (!step || isStepSatisfiedForScheduling(session, step, state)) continue
    const hydratedStep = state ? hydrateRuntimeStepFromStoredRunStep(step, state) : step
    if ((hydratedStep.dependencies || []).every(id => verified.has(id))) {
      candidates.push({ index, step, state, hydratedStep })
    }
  }
  const selected = candidates
    .filter(candidate => !shouldDeferFragilePlacementStep(session, candidate.hydratedStep, candidate.state))
    .sort((a, b) =>
      schedulingCandidatePriority(a) - schedulingCandidatePriority(b) ||
      phaseOrderRank(normalizeConstructionPhase(a.hydratedStep.phase, a.hydratedStep)) -
        phaseOrderRank(normalizeConstructionPhase(b.hydratedStep.phase, b.hydratedStep)) ||
      a.index - b.index
    )[0] ||
    candidates[0]
  if (selected) {
    if (selected.hydratedStep !== selected.step) Object.assign(selected.step, selected.hydratedStep)
    selected.step.runStatus = selected.state?.status || STEP_STATE.PENDING
    return selected.index
  }
  const unresolved = steps.findIndex(step => {
    if (!step || isStepSatisfiedForScheduling(session, step, runSteps[step.id])) return false
    return earliestPhaseRank === null || phaseOrderRank(normalizeConstructionPhase(step.phase, step)) === earliestPhaseRank
  })
  return unresolved >= 0 ? unresolved : steps.length
}

function schedulingCandidatePriority(candidate = {}) {
  const status = candidate.state?.status || candidate.hydratedStep?.runStatus || candidate.step?.runStatus || STEP_STATE.PENDING
  if (status === STEP_STATE.STATE_REPAIR) return 2
  if (status === STEP_STATE.CLEANUP) return 3
  if ([STEP_STATE.RETRYABLE_FAILED, STEP_STATE.TERMINAL_FAILED, 'failed'].includes(status)) return 1
  return 0
}

function shouldDeferFragilePlacementStep(session, step, state = null) {
  if (!isFragilePlacementStep(step)) return false
  const status = state?.status || step?.runStatus || STEP_STATE.PENDING
  if (!isUnresolvedConstructionStatus(status)) return false
  const target = step?.position || step?.target || null
  if (!target) return false
  const runSteps = session?.constructionRun?.steps || {}
  return (session?.steps || []).some(other => {
    if (!other || other.id === step.id) return false
    const otherState = runSteps[other.id]
    const hydratedOther = otherState ? hydrateRuntimeStepFromStoredRunStep(other, otherState) : other
    if (!['place', 'foundation_fill', 'scaffold_place'].includes(constructionStepKind(hydratedOther))) return false
    if (isFragilePlacementStep(hydratedOther)) return false
    if (isStepVerified(otherState)) return false
    const otherStatus = otherState?.status || hydratedOther.runStatus || STEP_STATE.PENDING
    if ([STEP_STATE.STATE_REPAIR, STEP_STATE.CLEANUP, STEP_STATE.TERMINAL_FAILED].includes(otherStatus)) return false
    if (!isUnresolvedConstructionStatus(otherStatus)) return false
    const otherTarget = hydratedOther.position || hydratedOther.target || null
    return otherTarget && chebyshevStepDistance(target, otherTarget) <= 2
  })
}

function isFragilePlacementStep(step) {
  if (!step || !['place', 'foundation_fill', 'scaffold_place'].includes(constructionStepKind(step))) return false
  const name = String(step.blockName || step.block?.id || step.resolvedBlock?.id || '')
  return name.endsWith('_leaves')
}

function constructionStepKind(step = {}) {
  return step.kind || step.legacyKind || kindFromAction(step.action)
}

function isUnresolvedConstructionStatus(status) {
  return [
    STEP_STATE.PENDING,
    STEP_STATE.READY,
    STEP_STATE.EXECUTING,
    STEP_STATE.PLACED,
    STEP_STATE.REPAIR,
    STEP_STATE.STATE_REPAIR,
    STEP_STATE.RETRYABLE_FAILED,
    STEP_STATE.TERMINAL_FAILED,
    'failed'
  ].includes(status)
}

function chebyshevStepDistance(a, b) {
  return Math.max(
    Math.abs(Number(a.x) - Number(b.x)),
    Math.abs(Number(a.y) - Number(b.y)),
    Math.abs(Number(a.z) - Number(b.z))
  )
}

function earliestUnresolvedPhaseRank(steps = [], runSteps = {}) {
  let earliest = null
  const session = { steps, constructionRun: { steps: runSteps } }
  for (const step of steps) {
    if (!step || isStepSatisfiedForScheduling(session, step, runSteps[step.id])) continue
    const rank = phaseOrderRank(normalizeConstructionPhase(step.phase, step))
    if (earliest === null || rank < earliest) earliest = rank
  }
  return earliest
}

function phaseOrderRank(phase) {
  const index = CONSTRUCTION_PHASE_ORDER.indexOf(phase)
  return index >= 0 ? index : CONSTRUCTION_PHASE_ORDER.length
}

function progressFromConstructionRun(run, steps = []) {
  const runSteps = run?.steps || {}
  const verifiedSteps = Object.values(runSteps).filter(isStepVerified)
  return {
    currentStepIndex: nextExecutableStepIndex({ steps, constructionRun: run }),
    currentIndex: verifiedSteps.filter(step => step.legacyKind === 'place').length,
    placedBlocks: verifiedSteps.filter(step => step.legacyKind === 'place').length,
    clearedBlocks: verifiedSteps.filter(step => step.legacyKind === 'clear').length,
    foundationBlocks: verifiedSteps.filter(step => step.legacyKind === 'foundation_fill').length,
    scaffoldBlocks: verifiedSteps.filter(step => step.legacyKind === 'scaffold_place').length,
    removedScaffoldBlocks: verifiedSteps.filter(step => step.legacyKind === 'scaffold_remove').length
  }
}

function remainingMaterialRequirementsForRun(run, steps = []) {
  const required = {}
  const runSteps = run?.steps || {}
  for (const step of steps) {
    if (!['foundation_fill', 'scaffold_place', 'place'].includes(step?.kind)) continue
    if (isStepVerified(runSteps[step.id])) continue
    for (const [itemName, count] of Object.entries(itemRequirementsForStep(step))) {
      required[itemName] = (required[itemName] || 0) + count
    }
  }
  return required
}

function materialRequirementsForRunPhase(run, steps = [], phase = 'site_prepare') {
  const required = {}
  const runSteps = run?.steps || {}
  const session = { steps, constructionRun: run }
  const targetPhase = normalizeConstructionPhase(phase || 'site_prepare')
  for (const step of steps) {
    if (normalizeConstructionPhase(step?.phase, step) !== targetPhase) continue
    if (!['foundation_fill', 'scaffold_place', 'place'].includes(constructionStepKind(step))) continue
    const state = runSteps[step.id]
    if (isStepVerified(state)) continue
    const hydratedStep = state ? hydrateRuntimeStepFromStoredRunStep(step, state) : step
    if (shouldDeferFragilePlacementStep(session, hydratedStep, state)) continue
    for (const [itemName, count] of Object.entries(itemRequirementsForStep(hydratedStep))) {
      required[itemName] = (required[itemName] || 0) + count
    }
  }
  return required
}

function phaseDependenciesSatisfied(session, phase) {
  const targetIndex = CONSTRUCTION_PHASE_ORDER.indexOf(phase)
  if (targetIndex <= 0) return { ok: true, missingDependencies: [] }
  const earlier = new Set(CONSTRUCTION_PHASE_ORDER.slice(0, targetIndex))
  const runSteps = session?.constructionRun?.steps || {}
  const verified = new Set(Object.values(runSteps).filter(isStepVerified).map(step => step.id))
  const missingDependencies = []

  for (const step of session?.steps || []) {
    const stepPhase = normalizeConstructionPhase(step.phase, step)
    if (!earlier.has(stepPhase)) continue
    const state = runSteps[step.id]
    if (state?.status === STEP_STATE.STATE_REPAIR) continue
    const hydratedStep = state ? hydrateRuntimeStepFromStoredRunStep(step, state) : step
    if ((hydratedStep.dependencies || []).some(id => !verified.has(id))) continue
    if (!isStepSatisfiedForScheduling(session, step, state)) {
      missingDependencies.push({
        stepId: step.id,
        phase: stepPhase,
        status: state?.status || STEP_STATE.PENDING
      })
    }
  }

  if (!missingDependencies.length) return { ok: true, missingDependencies: [] }
  return {
    ok: false,
    missingDependencies,
    error: `phase_dependency_incomplete:${phase}:${missingDependencies[0].phase}:${missingDependencies[0].stepId}`
  }
}

function phaseMaterialRequirements(session, phase) {
  const required = {}
  const runSteps = session?.constructionRun?.steps || {}
  for (const step of session?.steps || []) {
    if (normalizeConstructionPhase(step.phase, step) !== phase) continue
    if (!['foundation_fill', 'scaffold_place', 'place'].includes(constructionStepKind(step))) continue
    const state = runSteps[step.id]
    if (isStepVerified(state)) continue
    const hydratedStep = state ? hydrateRuntimeStepFromStoredRunStep(step, state) : step
    if (shouldDeferFragilePlacementStep(session, hydratedStep, state)) continue
    for (const [itemName, count] of Object.entries(itemRequirementsForStep(hydratedStep))) {
      required[itemName] = (required[itemName] || 0) + count
    }
  }
  return required
}

function phaseMaterialGateRequirements(session, phase, currentStep = null, phaseRequirements = null) {
  const targetPhase = normalizeConstructionPhase(phase || 'site_prepare')
  if (!currentStep || normalizeConstructionPhase(currentStep.phase, currentStep) !== targetPhase) {
    return phaseRequirements || phaseMaterialRequirements(session, targetPhase)
  }
  if (!['foundation_fill', 'scaffold_place', 'place'].includes(constructionStepKind(currentStep))) return {}
  if (isStepVerified(session?.constructionRun?.steps?.[currentStep.id])) return {}
  return itemRequirementsForStep(currentStep)
}

function missingFromCounts(required = {}, counts = {}) {
  return Object.entries(required)
    .map(([item, count]) => ({
      item,
      required: count,
      available: Number(counts[item]) || 0
    }))
    .filter(entry => entry.available < entry.required)
    .map(entry => ({
      ...entry,
      missing: entry.required - entry.available
    }))
}

function stepStateMatches(actualStates, step) {
  const expected = expectedStatesForStep(step) || {}
  const blockName = step?.blockName || step?.block?.id || step?.resolvedBlock?.id || null
  if (legacySkullPlacement(blockName, expected)) {
    if (!actualStates) return true
    if (legacyBlockStateMismatch(actualStates, blockName, expected)) return false
  }
  if (!hasExpectedPlacementStates(step)) return true
  if (!actualStates) return true
  for (const [key, value] of Object.entries(expected)) {
    if (!isComparablePlacementStateKey(blockName, key, value)) continue
    if (String(actualStates[key]) !== String(value)) return false
  }
  return true
}

function buildTargetNameMatches(actualName, expectedName, position, origin, expectedStates = null) {
  return actualName === expectedName ||
    legacyBlockNameMatches(actualName, expectedName, expectedStates) ||
    isStableNaturalTargetEquivalent(
    actualName,
    expectedName,
    position,
    { origin }
  )
}

// Cover lookup for the covered-grass decay exemption (see site-planner's
// isCoveredGrassDecayEquivalent). Accepts either session worldBlocks entries
// ({ type, position }) or construction steps (place steps with blockName);
// scaffold/clear/foundation steps never count as blueprint cover, and only
// covers that actually smother grass qualify (shared isGrassSmotheringCover).
// The derived key set is cached per source array.
const blueprintCoverKeysCache = new WeakMap()
function blueprintCoverLookup(source) {
  if (!Array.isArray(source) || !source.length) return null
  let keys = blueprintCoverKeysCache.get(source)
  if (!keys) {
    keys = new Set()
    for (const entry of source) {
      if (!entry || !entry.position) continue
      const kind = entry.kind || entry.legacyKind || (entry.action ? kindFromAction(entry.action) : null)
      const name = entry.type ?? (kind === 'place' ? (entry.blockName || entry.block?.id || entry.resolvedBlock?.id) : null)
      if (!name || !isGrassSmotheringCover(name)) continue
      keys.add(positionKey(entry.position))
    }
    blueprintCoverKeysCache.set(source, keys)
  }
  if (!keys.size) return null
  return position => !!position && keys.has(positionKey(position))
}

// The exemption replaces the whole name+state match: dirt cannot carry grass
// states, so callers must use this INSTEAD of buildTargetNameMatches +
// stepStateMatches for the exempted case, never merged into either.
function coveredGrassDecaySatisfied(actualName, expectedName, position, source) {
  return isCoveredGrassDecayEquivalent(actualName, expectedName, position, blueprintCoverLookup(source))
}

function shouldClearConstructionPlacementTarget(actualName, expectedName) {
  return !isAirName(actualName) &&
    actualName !== expectedName &&
    !isReplaceablePlacementTarget(actualName, expectedName)
}

function hasExpectedPlacementStates(step) {
  const states = expectedStatesForStep(step) || {}
  const blockName = step?.blockName || step?.block?.id || step?.resolvedBlock?.id || null
  if (legacySkullPlacement(blockName, states)) return true
  return Object.entries(states).some(([key, value]) => isComparablePlacementStateKey(blockName, key, value))
}

function expectedStatesForStep(step) {
  for (const states of [step?.states, step?.orientation, step?.block?.states, step?.resolvedBlock?.states]) {
    if (states && typeof states === 'object' && Object.keys(states).length > 0) return states
  }
  return null
}

function isComparablePlacementStateKey(blockName, key, value) {
  if (value == null || key === 'waterlogged') return false
  if (['legacyId', 'legacyData', 'legacyVariant'].includes(key)) return false
  const name = String(blockName || '')
  if (key === 'snowy' && !supportsSnowyPlacementState(name)) return false
  if (isDoorBlockName(name) && key === 'hinge') return false
  if (name === 'ladder') return key === 'facing'
  if (/_fence_gate$/.test(name)) return key === 'facing'
  // These values describe container/runtime contents, not a state that can be
  // reproduced by placing the block item, so resume reconciliation must not
  // consume scarce functional blocks trying to repair them. The faithful world
  // validator (isComparableStateKey) carries the same four exclusions, and
  // (round 10, #51, boss-approved) the wider set below as well — both callers
  // now import the shared list from utils/derived-placement-state-keys so the
  // two rulers cannot drift apart again.
  if (name === 'brewing_stand' && /^has_bottle_/.test(key)) return false
  if (name === 'lectern' && key === 'has_book') return false
  if (/_leaves$/.test(name) && key === 'distance') return false
  if (isDynamicConnectionStateBlock(name) && ['north', 'south', 'east', 'west', 'up'].includes(key)) return false
  // Same principle as the four exclusions above, applied to the rest of the
  // states a placed block item cannot carry. Comparing them makes resume
  // reconciliation mark an already-correct block state_repair, break it and
  // place it again with the identical result — forever, burning a functional
  // block each pass. Logistics round 9 measured 138 such steps on
  // fort-wall-gate: 99 redstone-wire connections, 32 stair shapes, 7 live
  // signal values. `open` is NOT here: actions/build.js toggles it after
  // placing (alignDoorOpenState and friends), so it is achievable.
  if (LIVE_SIGNAL_STATE_KEYS.has(key)) return false
  if (isRedstoneWireConnectionKey(name, key)) return false
  if (isStairsShapeKey(name, key)) return false
  if (key === 'lit' && isSignalLitBlockName(name)) return false
  return true
}

function supportsSnowyPlacementState(blockName) {
  return [
    'grass_block',
    'podzol',
    'mycelium'
  ].includes(String(blockName || ''))
}

function isDynamicConnectionStateBlock(blockName) {
  const name = String(blockName || '')
  return (/_fence$/.test(name) && !/_fence_gate$/.test(name)) ||
    /_wall$/.test(name) ||
    /_pane$/.test(name) ||
    name === 'iron_bars'
}

function isConsumedPlacementMaterialError(error) {
  const value = String(error || '')
  return value === 'block_item_not_found' ||
    value.startsWith('placement_retry_requires_material_refill:')
}

function isTemporaryReferenceMaterialError(error) {
  return /temporary_reference_item:(?:block_item_not_found|cannot_equip_block|missing)/i.test(String(error || ''))
}

function isRetryableBuildError(error) {
  return /place_failed|no_support_block|not_changed|unstable|blockUpdate|timeout|No block has been placed|missing_material|staged_material|block_item_not_found|temporary_reference_item|placement_target_occupied/i.test(String(error || ''))
}

function currentBotPosition(context) {
  const position = context.blackboard?.get?.('bot.position') || context.bot?.entity?.position
  if (!position) return null
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  }
}

function normalizeOrigin(origin) {
  if (!origin) return null
  const x = Number(origin.x)
  const y = Number(origin.y)
  const z = Number(origin.z)
  if (![x, y, z].every(Number.isFinite)) return null
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z) }
}

function tooFarFromBot(context, origin, maxDistance) {
  const position = currentBotPosition(context)
  if (!position) return false
  const distance = Math.sqrt((origin.x - position.x) ** 2 + (origin.y - position.y) ** 2 + (origin.z - position.z) ** 2)
  return distance > maxDistance
}

function isDangerHigh(context) {
  const dangerLevel = context.blackboard?.get?.('mobs.dangerLevel') || context.worldState?.mobs?.dangerLevel
  return dangerLevel === 'high' || dangerLevel === 'critical'
}

function constructionShouldContinue(options = {}) {
  if (typeof options.shouldContinue !== 'function') return true
  try {
    return options.shouldContinue() !== false
  } catch {
    return false
  }
}

function clonePlainObject(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

function createConstructionCheckpointState() {
  return {
    dirty: false,
    verifiedSinceFlush: 0,
    lastFlushAt: Date.now(),
    writeCount: 0,
    lastReason: null
  }
}

module.exports = {
  BuildingSystem,
  toWorldBlocks,
  _test: {
    acceptedFaithfulCleanupResult,
    clickedFacePlacementOptions,
    mergeRuntimeAndStoredSteps,
    actualWorldBlueprintFromSession,
    applyMaterialResolutionToPreview,
    applyPhysicalSupportDependencies,
    applyRuntimeSafeBlockSubstitutions,
    blueprintCoverLookup,
    buildTargetNameMatches,
    constructionCompletionLedgerGate,
    coveredGrassDecaySatisfied,
    faithfulWorldValidationForSession,
    isComparablePlacementStateKey,
    nextExecutableStepIndex,
    physicalSupportOffsetForStep,
    reconciledStepStatus,
    stepStateMatches,
    isTemporaryReferenceMaterialError,
    shouldClearConstructionPlacementTarget,
    unexpectedTemporaryBuildVolumeBlocks
  }
}
