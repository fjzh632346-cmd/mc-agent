const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { blockedRecord, environmentFields } = require('./minecraft-case-utils')
const { isRunActive } = require('../../systems/construction-run-store')
const { AestheticModel, AESTHETIC_DEFAULTS } = require('../../systems/aesthetic-model')
const { AestheticRefiner } = require('../../systems/aesthetic-refiner')
const { BuildingDesigner, analyzeBlueprint, validateFacade, validateStyleGrammar } = require('../../systems/building-designer')
const { BuildingHardGate } = require('../../systems/building-hard-gate')
const { BlueprintLoader } = require('../../systems/blueprint-loader')
const { BlueprintSelector } = require('../../systems/blueprint-selector')
const { CommunityBuildCollector } = require('../../systems/community-build-collector')
const { FaithfulCommunityValidator } = require('../../systems/faithful-community-validator')
const { InteriorPlanner } = require('../../systems/interior-planner')
const { InteriorUsabilityValidator } = require('../../systems/interior-usability-validator')
const { SpaceLayoutPlanner } = require('../../systems/space-layout-planner')
const { StructureEncoder } = require('../../systems/structure-encoder')
const { WalkabilityChecker } = require('../../systems/walkability-checker')
const { createSitePlan } = require('../../utils/site-planner')

const FEATURE = 'building'
const STOP_COMMAND = '\u505c\u6b62\u4efb\u52a1'
const DEFAULT_TIMEOUT_MS = 120000
const FIXTURE_DIRT_RESERVE = 256
const FIXTURE_DIRECT_DIRT_LIMIT = 256
const FIXTURE_INVENTORY_STACK_BUDGET = 20
const FIXTURE_STONE_RUNTIME_RESERVE = 16
const FIXTURE_FOOD_RESERVE_ITEM = 'cooked_beef'
const FIXTURE_FOOD_MIN_RESERVE = 8
const FIXTURE_FOOD_MAX_RESERVE = 64
const FIXTURE_FOOD_BLOCKS_PER_ITEM = 32
const FIXTURE_FOOD_SATURATION_SECONDS = 5
const FIXTURE_FOOD_SATURATION_AMPLIFIER = 10
const FIXTURE_SITE_BASE_OFFSET_X = 8
const FIXTURE_SITE_MIN_STRIDE_X = 56
const FIXTURE_SITE_MARGIN_X = 24
const FIXTURE_SITE_STRIDE_Z = 2
const FIXTURE_SITE_CLEARANCE_MARGIN = 10
const FAITHFUL_IMPORT_MIN_TIMEOUT_MS = 180000
const FAITHFUL_IMPORT_TIMEOUT_PER_BLOCK_MS = 3500
const FAITHFUL_IMPORT_MAX_TIMEOUT_MS = 90 * 60 * 1000

const CASES = [
  {
    id: 'case1_two_story_house',
    testName: 'case1 P9R faithful community two-story wood house import',
    command: 'rebuild two story wood house',
    blueprintName: 'two_story_wood_house',
    timeoutMs: 180000,
    requireCommunity: true,
    requireInterior: false,
    requireAesthetic: false,
    requireStairs: false,
    requiredLivingTargets: []
  },
  {
    id: 'case2_fort_wall_gate',
    testName: 'case2 P9R faithful community fort wall gate import (nonresidential)',
    command: 'build fort wall gate',
    blueprintName: 'fort_wall_gate',
    timeoutMs: 180000,
    requireCommunity: true,
    requireInterior: false,
    requireAesthetic: false,
    requiredZones: [],
    requireStairs: false,
    requiredLivingTargets: []
  },
  {
    // Resume-only regression: the machinery for "reconnect and keep building"
    // gets its own scenario because the fresh-build fixtures (site clearing,
    // computed origin) are destructive against a half-built ACTIVE run.
    // This scenario clears nothing, teleports nothing to a computed origin,
    // and judges the resume machinery itself, not completion.
    id: 'case3_resume_active_run',
    testName: 'case3 resume-only continuation of the stored active construction run',
    command: 'resume building modern villa',
    blueprintName: 'modern_villa',
    resumeExisting: true,
    timeoutMs: 240000,
    minProgressSteps: 10
  }
]

module.exports = {
  featureName: FEATURE,
  testName: 'BUILDING-P9R faithful community blueprint import gate',
  commandOrInput: CASES.map(testCase => testCase.command).join(' | '),
  _test: {
    blueprintBuildBounds,
    blueprintBounds,
    estimateFixtureScaffoldBlocks,
    fillCommands,
    fixtureDirectDirtForReserve,
    fixtureDirtReserveForBlueprint,
    fixtureFoodReserveForBlueprint,
    fixtureFoodReserveCommands,
    fixtureRuntimeMaterialReserve,
    fixtureOrigin,
    fixtureStorageClearCommands,
    fixtureSiteStrideX,
    failureReason,
    judgeResumeScenario,
    latestBuildTaskPauseReason,
    mergeLogLines,
    readActiveConstructionRuns,
    summarizeResumeProgress,
    resolveScenarioTimeoutMs,
    selectedBuildingScenarios,
    storagePositionsForMaterials
  },

  async run({ adapter, projectConfig, createRecord }) {
    const selectedScenarios = selectedBuildingScenarios(CASES)
    if (!selectedScenarios.length) {
      const requested = buildingScenarioFilterText()
      return [createRecord({
        projectName: adapter.displayProjectName(),
        featureName: FEATURE,
        testName: 'building scenario filter',
        commandOrInput: requested || '',
        observedBehavior: 'No building scenario matched the requested acceptance scenario filter.',
        expectedBehavior: 'A requested scenario filter should match at least one building scenario id, case number, blueprint name, or test name.',
        actualResult: 'building_scenario_filter_no_match',
        judgment: 'ERROR',
        passOrFail: 'ERROR',
        setupStatus: 'ERROR',
        failureReason: `building_scenario_filter_no_match:${requested || 'empty'}`,
        evidence: { requested, availableScenarioIds: CASES.map(scenario => scenario.id) },
        relatedLogs: [],
        regressionRisk: 'The focused acceptance probe did not execute the intended building behavior.',
        nextSuggestion: 'Use ACCEPTANCE_BUILDING_SCENARIOS=case1_two_story_house or case2_fort_wall_gate.'
      })]
    }

    const records = []
    for (const { scenario, index } of selectedScenarios) {
      const record = scenario.resumeExisting === true
        ? await runResumeScenario({ adapter, projectConfig, createRecord, scenario, index })
        : await runScenario({ adapter, projectConfig, createRecord, scenario, index })
      records.push(record)
    }
    return records
  }
}

function selectedBuildingScenarios(cases = CASES, filterText = buildingScenarioFilterText()) {
  if (!filterText) return cases.map((scenario, index) => ({ scenario, index }))
  const wanted = new Set(String(filterText).split(',').map(value => value.trim()).filter(Boolean))
  return cases
    .map((scenario, index) => ({ scenario, index }))
    .filter(({ scenario, index }) => {
      const aliases = [
        scenario.id,
        scenario.testName,
        scenario.blueprintName,
        String(index + 1),
        `case${index + 1}`
      ].filter(Boolean)
      return aliases.some(alias => wanted.has(alias))
    })
}

function buildingScenarioFilterText() {
  return process.env.ACCEPTANCE_BUILDING_SCENARIOS ||
    process.env.ACCEPTANCE_BUILDING_SCENARIO ||
    process.env.ACCEPTANCE_SCENARIO ||
    ''
}

async function runScenario({ adapter, projectConfig, createRecord, scenario, index }) {
  const config = projectConfig.minecraft.building || {}
  const cursor = adapter.createLogCursor()
  await adapter.sendCommand(STOP_COMMAND, { afterMs: 700 })

  const baseSnapshot = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 20,
    includeDebugStatus: true
  })

  const expected = expectedBlueprint(scenario.blueprintName)
  if (!expected.ok) {
    return createRecord(blockedRecord({
      adapter,
      featureName: FEATURE,
      testName: scenario.testName,
      commandOrInput: scenario.command,
      setup: {
        setupStatus: 'BLOCKED',
        setupFailureReason: expected.error,
        snapshot: baseSnapshot,
        fixtureStatus: { feature: FEATURE, scenario: scenario.id, ready: false, reason: expected.error }
      },
      expectedBehavior: expectedBehavior(scenario),
      regressionRisk: regressionRisk(),
      nextSuggestion: 'Fix blueprint selector/generator before running real building acceptance.'
    }))
  }

  if (!baseSnapshot.configuredAiOnline || !baseSnapshot.debugStatusAvailable) {
    return createRecord(blockedRecord({
      adapter,
      featureName: FEATURE,
      testName: scenario.testName,
      commandOrInput: scenario.command,
      setup: {
        setupStatus: 'BLOCKED',
        setupFailureReason: !baseSnapshot.configuredAiOnline ? 'configured_ai_not_online' : 'debug_status_unavailable',
        snapshot: baseSnapshot,
        fixtureStatus: fixtureStatus(scenario, {
          ready: false,
          reason: !baseSnapshot.configuredAiOnline ? 'configured_ai_not_online' : 'debug_status_unavailable',
          baseSnapshot
        })
      },
      expectedBehavior: expectedBehavior(scenario),
      regressionRisk: regressionRisk(),
      nextSuggestion: 'Start a fresh LinXia bot and confirm debug_status before rerunning building acceptance.'
    }))
  }

  const origin = fixtureOrigin(baseSnapshot, index, expected.blueprint)
  const fixture = await prepareFixture(adapter, scenario, expected.blueprint, origin)
  await adapter.wait(900)
  const setupSnapshot = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 20,
    includeDebugStatus: true
  })
  const setupBlocks = observeBlueprintBlocks(adapter, expected.blueprint, origin)
  const ready = !fixture.commandResult.commandDenied &&
    !fixture.teleport.commandDenied &&
    setupSnapshot.configuredAiOnline &&
    setupBlocks.supportOk &&
    setupBlocks.targetsPrepared

  if (!ready) {
    return createRecord(blockedRecord({
      adapter,
      featureName: FEATURE,
      testName: scenario.testName,
      commandOrInput: scenario.command,
      setup: {
        setupStatus: 'BLOCKED',
        setupFailureReason: setupFailureReason({ fixture, setupSnapshot, setupBlocks }),
        snapshot: setupSnapshot,
        origin,
        fixtureStatus: fixtureStatus(scenario, {
          ready: false,
          reason: setupFailureReason({ fixture, setupSnapshot, setupBlocks }),
          origin,
          expected: expected.summary,
          fixture,
          setupBlocks
        })
      },
      expectedBehavior: expectedBehavior(scenario),
      regressionRisk: regressionRisk(),
      nextSuggestion: 'Ensure command fixtures can clear the site, give materials, and teleport LinXia.'
    }))
  }

  await adapter.sendCommand(STOP_COMMAND, { afterMs: 500 })
  await adapter.runServerCommand(`tp ${adapter.aiUsername()} ${origin.x} ${origin.y} ${origin.z}`)
  await adapter.wait(500)

  const commandCursor = adapter.createLogCursor()
  const preState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 20,
    includeDebugStatus: true
  })

  await adapter.sendCommand(scenario.command, { afterMs: 250 })

  const startLogs = await adapter.waitForLog([
    /\[BUILD_SITE_SCAN\]/,
    /\[TaskManager\] failed #[0-9]+ build_blueprint/
  ], 16000, commandCursor)

  if (startLogs.some(line => line.includes('[BUILD_SITE_SCAN]'))) {
    const away = evacuationPosition(origin)
    await adapter.runServerCommand(`tp ${adapter.aiUsername()} ${away.x} ${away.y} ${away.z}`)
    await adapter.wait(500)
  }

  const terminalTimeoutMs = resolveScenarioTimeoutMs(scenario, config, expected)
  const terminalLogs = await adapter.waitForLog([
    /\[TaskManager\] completed #[0-9]+ build_blueprint/,
    /\[TaskManager\] failed #[0-9]+ build_blueprint/
  ], terminalTimeoutMs, commandCursor)

  await adapter.wait(1200)
  const postState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 20,
    includeDebugStatus: true
  })
  const tailLogs = adapter.readLogsSince(commandCursor, { limit: 8000 })
  const logs = mergeLogLines(startLogs, terminalLogs, tailLogs)
  const afterBlocks = observeBlueprintBlocks(adapter, expected.blueprint, origin)
  const living = observeLivingUse(adapter, expected, origin)
  const assertion = assertScenario({ scenario, expected, logs, afterBlocks, living, terminalLogs })

  return createRecord({
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState,
    postState,
    observedBehavior: observedBehavior(assertion, afterBlocks, living, expected),
    expectedBehavior: expectedBehavior(scenario),
    actualResult: assertion.judgment === 'PASS' ? 'building_p9r_faithful_import_passed' : 'building_p9r_faithful_import_failed',
    judgment: assertion.judgment,
    passOrFail: assertion.judgment,
    failureReason: assertion.failureReason,
    evidence: {
      scenario,
      terminalTimeoutMs,
      origin,
      expected: expected.summary,
      fixture: fixtureStatus(scenario, {
        ready: true,
        origin,
        expected: expected.summary,
        materialSetup: fixture.materialSetup,
        foodReserve: fixture.foodReserve,
        runtimeReserve: fixture.runtimeReserve,
        storagePositions: fixture.storagePositions
      }),
      afterBlocks,
      living,
      assertion,
      taskSignals: postState.taskSignals
    },
    relatedLogs: logs.slice(-180),
    regressionRisk: regressionRisk(),
    nextSuggestion: assertion.judgment === 'PASS'
      ? 'Keep extending building features only behind the same faithful import, world fidelity, and final live gate evidence checks.'
      : 'Inspect BUILD_FAITHFUL_WORLD_GATE, BUILD_HABITABILITY_GATE, BUILD_STEP, BUILD_VALIDATION, material setup, and placement logs.',
    ...environmentFields(adapter, postState, {
      setupStatus: 'READY',
      setupFailureReason: null,
      fixtureStatus: fixtureStatus(scenario, {
        ready: true,
        origin,
        expected: expected.summary,
        materialSetup: fixture.materialSetup,
        foodReserve: fixture.foodReserve,
        runtimeReserve: fixture.runtimeReserve,
        storagePositions: fixture.storagePositions
      })
    })
  })
}

// ─── Resume-only scenario ────────────────────────────────────────────────────
// The fresh-build fixture wipes the site flat and teleports LinXia to an
// origin computed from the acceptance player's position — both destructive
// against a half-built stored run. This flow clears nothing and lets the
// resume machinery pick the STORED origin; the resume-phrased command sets
// resumeOnly, which is exactly the path allowsDistantStoredResumeOrigin()
// gates on, so the origin-distance check passes without any teleport.
// Judged: stored ACTIVE run identified, stored origin adopted, N steps of
// real progress with zero terminal failure. Completion is NOT required.
async function runResumeScenario({ adapter, projectConfig, createRecord, scenario }) {
  const config = projectConfig.minecraft.building || {}
  const cursor = adapter.createLogCursor()
  await adapter.sendCommand(STOP_COMMAND, { afterMs: 700 })

  const baseSnapshot = await adapter.snapshot({
    logCursor: cursor,
    scanRadius: config.scanRadius || 20,
    includeDebugStatus: true
  })

  if (!baseSnapshot.configuredAiOnline || !baseSnapshot.debugStatusAvailable) {
    return createRecord(blockedRecord({
      adapter,
      featureName: FEATURE,
      testName: scenario.testName,
      commandOrInput: scenario.command,
      setup: {
        setupStatus: 'BLOCKED',
        setupFailureReason: !baseSnapshot.configuredAiOnline ? 'configured_ai_not_online' : 'debug_status_unavailable',
        snapshot: baseSnapshot,
        fixtureStatus: { feature: FEATURE, scenario: scenario.id, ready: false }
      },
      expectedBehavior: resumeExpectedBehavior(scenario),
      regressionRisk: resumeRegressionRisk(),
      nextSuggestion: 'Start a fresh LinXia bot and confirm debug_status before rerunning resume acceptance.'
    }))
  }

  const store = readActiveConstructionRuns()
  if (!store.ok || !store.runs.length) {
    return createRecord(blockedRecord({
      adapter,
      featureName: FEATURE,
      testName: scenario.testName,
      commandOrInput: scenario.command,
      setup: {
        setupStatus: 'BLOCKED',
        setupFailureReason: store.ok ? 'resume_fixture_no_active_run' : `resume_run_store_unreadable:${store.error}`,
        snapshot: baseSnapshot,
        fixtureStatus: {
          feature: FEATURE,
          scenario: scenario.id,
          ready: false,
          activeRunCount: store.runs?.length || 0
        }
      },
      expectedBehavior: resumeExpectedBehavior(scenario),
      regressionRisk: resumeRegressionRisk(),
      nextSuggestion: 'Run a fresh build first (case1/case2) so an ACTIVE construction run exists, then rerun the resume scenario.'
    }))
  }

  const commandCursor = adapter.createLogCursor()
  await adapter.sendCommand(scenario.command, { afterMs: 250 })
  await adapter.waitForLog([
    /\[BUILD_CONSTRUCTION_RUN_RESUME_PLACEMENT\]/,
    /\[TaskManager\] failed #[0-9]+ build_blueprint/
  ], 20000, commandCursor)

  const windowMs = resolveScenarioTimeoutMs(scenario, config, null)
  const minSteps = Math.max(1, Number(scenario.minProgressSteps ?? 10))
  const startedAt = Date.now()
  let summary = summarizeResumeProgress([])
  while (Date.now() - startedAt < windowMs) {
    summary = summarizeResumeProgress(adapter.readLogsSince(commandCursor, { limit: 12000 }))
    if (summary.terminalFailureReason || summary.completed) break
    if (summary.resumePlacement && summary.stepCount >= minSteps) break
    await adapter.wait(4000)
  }
  const logs = adapter.readLogsSince(commandCursor, { limit: 12000 })
  summary = summarizeResumeProgress(logs)

  // The scenario never requires completion: stop the task cleanly so the run
  // checkpoints and stays ACTIVE for the next resume.
  if (!summary.terminalFailureReason && !summary.completed) {
    await adapter.sendCommand(STOP_COMMAND, { afterMs: 1500 })
  }

  const postState = await adapter.snapshot({
    logCursor: commandCursor,
    scanRadius: config.scanRadius || 20,
    includeDebugStatus: true
  })
  const verdict = judgeResumeScenario({ activeRuns: store.runs, summary, minSteps })

  return createRecord({
    projectName: adapter.displayProjectName(),
    featureName: FEATURE,
    testName: scenario.testName,
    commandOrInput: scenario.command,
    preState: baseSnapshot,
    postState,
    observedBehavior: verdict.observedBehavior,
    expectedBehavior: resumeExpectedBehavior(scenario),
    actualResult: verdict.judgment === 'PASS' ? 'building_resume_machinery_passed' : verdict.actualResult,
    judgment: verdict.judgment,
    passOrFail: verdict.judgment,
    failureReason: verdict.failureReason,
    evidence: {
      scenario,
      windowMs,
      minSteps,
      summary,
      matchedRun: verdict.matchedRun
        ? {
            runId: verdict.matchedRun.runId,
            blueprintId: verdict.matchedRun.blueprintId,
            status: verdict.matchedRun.status,
            storedOrigin: verdict.matchedRun.placementContext?.origin || null
          }
        : null,
      activeRunIds: store.runs.map(run => run.runId),
      taskSignals: postState.taskSignals
    },
    relatedLogs: logs.slice(-180),
    regressionRisk: resumeRegressionRisk(),
    nextSuggestion: verdict.judgment === 'PASS'
      ? 'Keep the resume scenario non-destructive: no site clearing, no computed-origin teleports.'
      : 'Inspect BUILDING_RUN_DECISION, BUILD_CONSTRUCTION_RUN_RESUME_PLACEMENT, and the terminal failure reason.',
    ...environmentFields(adapter, postState, {
      setupStatus: 'READY',
      setupFailureReason: null,
      fixtureStatus: {
        feature: FEATURE,
        scenario: scenario.id,
        ready: true,
        nonDestructive: true,
        activeRunCount: store.runs.length
      }
    })
  })
}

function readActiveConstructionRuns(storePath = constructionRunStorePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    const runs = (Array.isArray(raw) ? raw : raw.runs || []).filter(run => isRunActive(run))
    return { ok: true, runs }
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || 'unknown', runs: [] }
  }
}

function constructionRunStorePath() {
  return process.env.ACCEPTANCE_RUN_STORE_PATH ||
    path.join(process.cwd(), 'data', 'memory', 'construction-runs.json')
}

function summarizeResumeProgress(logs = []) {
  const summary = {
    resumePlacement: null,
    decisionResumeOrFresh: null,
    stepCount: 0,
    terminalFailureReason: null,
    completed: false
  }
  for (const line of logs) {
    const text = String(line)
    const placement = text.match(/\[BUILD_CONSTRUCTION_RUN_RESUME_PLACEMENT\] runId=(\S+) blueprint=(\S+) origin=(-?\d+),(-?\d+),(-?\d+)/)
    if (placement) {
      summary.resumePlacement = {
        runId: placement[1],
        blueprintId: placement[2],
        origin: { x: Number(placement[3]), y: Number(placement[4]), z: Number(placement[5]) }
      }
    }
    const decision = text.match(/\[BUILDING_RUN_DECISION\].*"resumeOrFresh":"(resume|fresh)"/)
    if (decision) summary.decisionResumeOrFresh = decision[1]
    if (text.includes('[BUILD_STEP]')) summary.stepCount += 1
    const failed = text.match(/\[task-manager\] fail task=build_blueprint id=\d+ reason=(\S+)/)
    if (failed) summary.terminalFailureReason = failed[1]
    if (/\[TaskManager\] completed #\d+ build_blueprint/.test(text)) summary.completed = true
  }
  return summary
}

function judgeResumeScenario({ activeRuns = [], summary, minSteps = 10 }) {
  const reason = summary.terminalFailureReason
  if (reason && reason.startsWith('BLOCKED_MATERIAL_SHORTAGE')) {
    return {
      judgment: 'BLOCKED',
      actualResult: 'building_resume_blocked_material_shortage',
      failureReason: `resume_blocked:${reason}`,
      matchedRun: null,
      observedBehavior: `Resume preparation stopped on a material shortage (${reason}); staging chests need restocking before the machinery can be judged.`
    }
  }
  if (!summary.resumePlacement) {
    return {
      judgment: 'FAIL',
      actualResult: 'building_resume_machinery_failed',
      failureReason: reason ? `resume_failed_before_placement:${reason}` : 'resume_placement_not_engaged',
      matchedRun: null,
      observedBehavior: 'The stored active run was never adopted: no resume placement was logged before the task ended.'
    }
  }
  const matchedRun = activeRuns.find(run => run.runId === summary.resumePlacement.runId) || null
  if (!matchedRun) {
    return {
      judgment: 'FAIL',
      actualResult: 'building_resume_machinery_failed',
      failureReason: `resume_run_not_in_store:${summary.resumePlacement.runId}`,
      matchedRun: null,
      observedBehavior: 'A resume placement was logged for a run id that is not an ACTIVE run in the store.'
    }
  }
  const storedOrigin = matchedRun.placementContext?.origin || null
  const adopted = summary.resumePlacement.origin
  if (!storedOrigin || storedOrigin.x !== adopted.x || storedOrigin.y !== adopted.y || storedOrigin.z !== adopted.z) {
    return {
      judgment: 'FAIL',
      actualResult: 'building_resume_machinery_failed',
      failureReason: 'resume_origin_mismatch',
      matchedRun,
      observedBehavior: `The resume adopted origin ${adopted.x},${adopted.y},${adopted.z} instead of the stored origin ${storedOrigin ? `${storedOrigin.x},${storedOrigin.y},${storedOrigin.z}` : 'null'}.`
    }
  }
  if (summary.decisionResumeOrFresh === 'fresh') {
    return {
      judgment: 'FAIL',
      actualResult: 'building_resume_machinery_failed',
      failureReason: 'fresh_run_instead_of_resume',
      matchedRun,
      observedBehavior: 'The run decision chose a fresh run although a compatible ACTIVE run exists.'
    }
  }
  if (reason) {
    return {
      judgment: 'FAIL',
      actualResult: 'building_resume_machinery_failed',
      failureReason: `resume_terminal_failed:${reason}`,
      matchedRun,
      observedBehavior: `The resumed task terminal-failed with ${reason} inside the observation window.`
    }
  }
  if (summary.stepCount < minSteps) {
    return {
      judgment: 'FAIL',
      actualResult: 'building_resume_machinery_failed',
      failureReason: `resume_insufficient_progress:${summary.stepCount}/${minSteps}`,
      matchedRun,
      observedBehavior: `Only ${summary.stepCount} build steps were observed inside the window (minimum ${minSteps}).`
    }
  }
  return {
    judgment: 'PASS',
    actualResult: 'building_resume_machinery_passed',
    failureReason: null,
    matchedRun,
    observedBehavior: `Stored run ${matchedRun.runId} was resumed at its stored origin and progressed ${summary.stepCount} steps (completion not required) with no terminal failure.`
  }
}

function resumeExpectedBehavior(scenario) {
  return 'A resume-phrased command adopts the stored ACTIVE construction run at its STORED origin (resumeOnly path), reconciles, and makes real progress ' +
    `(>=${scenario.minProgressSteps ?? 10} steps) without terminal failure; the site is never cleared and no computed-origin teleport happens.`
}

function resumeRegressionRisk() {
  return 'If the resume machinery regresses, a reconnect mid-build silently restarts the structure from scratch or dies on the origin-distance gate.'
}

function resolveScenarioTimeoutMs(scenario, config = {}, expected = {}) {
  const configured = positiveMs(scenario.timeoutMs || config.timeoutMs, DEFAULT_TIMEOUT_MS)
  if (scenario.dynamicTimeoutMs === false) return configured
  if (expected?.summary?.sourceMode !== 'faithful-community-import') return configured

  const blockCount = Number(expected?.summary?.nonAirCount || expected?.summary?.blockCount || 0)
  if (!Number.isFinite(blockCount) || blockCount <= 250) return configured

  const minTimeout = Math.max(
    configured,
    positiveMs(config.faithfulImportMinTimeoutMs, FAITHFUL_IMPORT_MIN_TIMEOUT_MS)
  )
  const perBlockMs = positiveMs(config.faithfulImportTimeoutPerBlockMs, FAITHFUL_IMPORT_TIMEOUT_PER_BLOCK_MS)
  const maxTimeout = positiveMs(config.faithfulImportMaxTimeoutMs, FAITHFUL_IMPORT_MAX_TIMEOUT_MS)
  const estimated = Math.ceil(blockCount * perBlockMs)
  return Math.min(maxTimeout, Math.max(minTimeout, estimated))
}

function positiveMs(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function expectedBlueprint(blueprintName) {
  const loader = new BlueprintLoader()
  const selector = new BlueprintSelector({ loader })
  const selected = selector.selectBlueprint({ blueprintName })
  if (!selected.ok) return selected
  if (selected.selected.sourceMode !== 'faithful-community-import') {
    return { ok: false, error: `expected_not_faithful_community_import:${selected.selected.sourceKind || 'unknown'}` }
  }
  const encoder = new StructureEncoder()
  const encoding = encoder.encode(selected.blueprint)
  if (!encoding.ok) return encoding
  const validator = new FaithfulCommunityValidator()
  const faithfulValidation = validator.validateBlueprint(selected.blueprint, {
    blueprintName,
    selected: selected.selected,
    requiredStories: selected.selected.requiredStories
  }, {
    requireSourceMode: true
  })
  if (!faithfulValidation.ok) {
    return { ok: false, error: `faithful_expected_failed:${faithfulValidation.failures.join(',')}`, faithfulValidation }
  }
  const materialResult = loader.getRequiredMaterials(selected.blueprint)
  if (!materialResult.ok) return materialResult
  return {
    ok: true,
    blueprint: selected.blueprint,
    selected: selected.selected,
    designPlan: {
      layer: 'faithful_community_import',
      transformed: false,
      sourceMode: selected.selected.sourceMode
    },
    layoutPlan: { enabled: false },
    aestheticPlan: {
      enabled: false,
      skipped: true,
      faithfulValidation
    },
    designQuality: { ok: true, skipped: true, reason: 'faithful_community_import' },
    interiorPlan: { enabled: false, placements: [], rooms: [] },
    interiorUsability: { ok: true, skipped: true },
    walkability: { ok: true, skipped: true },
    faithfulValidation,
    materials: materialResult.materials,
    summary: {
      blueprintName: selected.blueprint.name,
      selected: selected.selected,
      sourceMode: selected.selected.sourceMode,
      sourceKind: selected.selected.sourceKind,
      cacheHash: selected.selected.cacheHash,
      localRawPath: selected.selected.localRawPath,
      localBlueprintPath: selected.selected.localBlueprintPath,
      structureFileFormat: selected.selected.structureFileFormat,
      blockCount: selected.blueprint.blocks.length,
      nonAirCount: selected.blueprint.blocks.filter(block => !isAir(block.type)).length,
      design: {
        transformed: false,
        layer: 'faithful_community_import',
        metrics: faithfulValidation.metrics
      },
      aesthetic: {
        skipped: true,
        faithfulValidation
      },
      layout: { enabled: false },
      interior: { enabled: false },
      interiorUsability: { ok: true, skipped: true },
      walkability: { ok: true, skipped: true },
      faithfulValidation,
      materials: materialResult.materials
    }
  }
}

function buildAcceptanceContrast({
  encoder,
  hardGate,
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
  const initialHardGate = initialBlueprint ? hardGate.evaluateBlueprint(initialBlueprint, request) : null
  const initialEncoding = initialBlueprint ? encoder.encode(initialBlueprint) : null
  const importedEvaluation = imported?.blueprint
    ? new AestheticModel({ encoder }).score(imported.blueprint, samples, request?.aesthetic || {})
    : null
  const importedEncoding = imported?.encoding || (imported?.blueprint ? encoder.encode(imported.blueprint) : null)
  const importedHardGate = imported?.hardGate || (imported?.blueprint
    ? hardGate.evaluateBlueprint(imported.blueprint, {
        ...request,
        requiredStories: imported.requiredStories || request?.requiredStories
      })
    : null)
  const finalEncoding = finalEvaluation?.encoding || (finalBlueprint ? encoder.encode(finalBlueprint) : null)

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
    oldProceduralOutput: summarizeAcceptanceContrastEntry({
      label: 'old_procedural_output',
      sourceKind: 'initial_rule_based_structure',
      blueprint: initialBlueprint,
      hardGate: initialHardGate,
      encoding: initialEncoding,
      evaluation: initialEvaluation
    }),
    importedCommunitySample: summarizeAcceptanceContrastEntry({
      label: 'imported_community_sample',
      sourceKind: imported?.sourceKind || 'community_sample_unavailable',
      blueprint: imported?.blueprint || null,
      hardGate: importedHardGate,
      encoding: importedEncoding,
      evaluation: importedEvaluation?.ok ? importedEvaluation : null,
      sample: imported
    }),
    communityGuidedAdaptedOutput: summarizeAcceptanceContrastEntry({
      label: 'community_guided_adapted_output',
      sourceKind: 'community_retrieval_and_adaptation',
      blueprint: finalBlueprint,
      hardGate: finalHardGate,
      encoding: finalEncoding,
      evaluation: finalEvaluation
    })
  }
}

function summarizeAcceptanceContrastEntry({ label, sourceKind, blueprint, hardGate, encoding, evaluation, sample = null }) {
  const usableEncoding = encoding?.ok === false ? null : encoding
  const hardMetrics = hardGate?.metrics || {}
  const aestheticMetrics = evaluation?.metrics || {}
  const encodingFeatures = usableEncoding?.features || {}
  const graph = usableEncoding?.graph || {}
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
    materialCoherence: summarizeAcceptanceMaterialCoherence(usableEncoding, aestheticMetrics),
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

function summarizeAcceptanceMaterialCoherence(encoding, aestheticMetrics = {}) {
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

async function prepareFixture(adapter, scenario, blueprint, origin) {
  const bounds = blueprintBounds(blueprint, origin)
  const buildBounds = blueprintBuildBounds(blueprint, origin)
  const loader = new BlueprintLoader()
  const materials = loader.getRequiredMaterials(blueprint).materials || {}
  const materialSetup = splitMaterialsForScenario(materials, scenario)
  const dirtReserve = fixtureDirtReserveForBlueprint(blueprint, origin)
  const directDirt = fixtureDirectDirtForReserve(dirtReserve)
  const runtimeReserve = fixtureRuntimeMaterialReserve(materials)
  const foodReserve = fixtureFoodReserveForBlueprint(blueprint)
  addFixtureStorageReserve(materialSetup, { dirt: dirtReserve })
  addFixtureStorageReserve(materialSetup, runtimeReserve)
  const storagePositions = storagePositionsForMaterials(buildBounds, origin, materialSetup.storage)

  const commands = [
    `clear ${adapter.aiUsername()}`,
    `execute at ${adapter.aiUsername()} run kill @e[type=minecraft:item,distance=..80]`,
    `execute positioned ${origin.x} ${origin.y} ${origin.z} run tp @a[name=!${adapter.aiUsername()},name=!${adapter.testUsername()},distance=..32] ${bounds.maxX + 8} ${origin.y} ${bounds.maxZ + 8}`,
    ...fillCommands(
      { x: bounds.minX, y: origin.y, z: bounds.minZ },
      { x: bounds.maxX, y: bounds.maxY + 2, z: bounds.maxZ },
      'minecraft:air'
    ),
    ...fillCommands(
      { x: bounds.minX, y: origin.y - 1, z: bounds.minZ },
      { x: bounds.maxX, y: origin.y - 1, z: bounds.maxZ },
      'minecraft:stone'
    ),
    ...fixtureStorageClearCommands(bounds, origin),
    `give ${adapter.aiUsername()} minecraft:iron_pickaxe 1`,
    `give ${adapter.aiUsername()} minecraft:iron_axe 1`,
    `give ${adapter.aiUsername()} minecraft:iron_shovel 1`,
    `give ${adapter.aiUsername()} minecraft:dirt ${directDirt}`,
    ...fixtureFoodReserveCommands(adapter.aiUsername(), foodReserve),
    ...giveCommands(adapter.aiUsername(), materialSetup.inventory),
    ...storageCommands(storagePositions, materialSetup.storage)
  ]

  const commandResult = await runFixtureCommands(adapter, commands)
  const teleport = await adapter.runServerCommand(`tp ${adapter.aiUsername()} ${origin.x} ${origin.y} ${origin.z}`)
  await adapter.wait(700)
  return { commandResult, teleport, materialSetup, storagePositions, bounds, dirtReserve, directDirt, runtimeReserve, foodReserve }
}

function fixtureStorageClearCommands(bounds, origin) {
  return fillCommands(
    { x: bounds.minX - 24, y: origin.y - 4, z: bounds.minZ - 16 },
    { x: bounds.maxX + 48, y: origin.y + 2, z: bounds.minZ - 2 },
    'minecraft:air'
  )
}

function fillCommands(min, max, blockName, maxVolume = 30000) {
  const commands = []
  pushFillCommand(commands, normalizeFillCorner(min), normalizeFillCorner(max), blockName, maxVolume)
  return commands
}

function pushFillCommand(commands, min, max, blockName, maxVolume) {
  const volume = fillVolume(min, max)
  if (volume <= maxVolume) {
    commands.push(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${blockName}`)
    return
  }

  const spans = {
    x: max.x - min.x + 1,
    y: max.y - min.y + 1,
    z: max.z - min.z + 1
  }
  const axis = Object.entries(spans).sort((a, b) => b[1] - a[1])[0][0]
  const mid = Math.floor((min[axis] + max[axis]) / 2)
  const firstMax = { ...max, [axis]: mid }
  const secondMin = { ...min, [axis]: mid + 1 }
  pushFillCommand(commands, min, firstMax, blockName, maxVolume)
  pushFillCommand(commands, secondMin, max, blockName, maxVolume)
}

function normalizeFillCorner(position) {
  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z))
  }
}

function fillVolume(min, max) {
  return (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1)
}

function fixtureDirtReserveForBlueprint(blueprint, origin) {
  const scaffoldBlocks = estimateFixtureScaffoldBlocks(blueprint, origin)
  const margin = scaffoldBlocks > 0 ? Math.max(64, Math.ceil(scaffoldBlocks * 0.1)) : 0
  return Math.max(FIXTURE_DIRT_RESERVE, scaffoldBlocks + margin)
}

function fixtureDirectDirtForReserve(dirtReserve) {
  return Math.min(FIXTURE_DIRECT_DIRT_LIMIT, Math.max(0, Math.ceil(Number(dirtReserve) || 0)))
}

function fixtureRuntimeMaterialReserve(materials = {}) {
  const stone = Math.ceil(Number(materials.stone) || 0)
  if (stone <= 0) return {}
  return {
    stone: stone + Math.max(FIXTURE_STONE_RUNTIME_RESERVE, Math.ceil(stone * 0.1))
  }
}

function fixtureFoodReserveForBlueprint(blueprint) {
  const nonAirCount = (blueprint?.blocks || []).filter(block => block?.type && !isAir(block.type)).length
  const count = Math.min(
    FIXTURE_FOOD_MAX_RESERVE,
    Math.max(FIXTURE_FOOD_MIN_RESERVE, Math.ceil(nonAirCount / FIXTURE_FOOD_BLOCKS_PER_ITEM))
  )
  return { item: FIXTURE_FOOD_RESERVE_ITEM, count }
}

function fixtureFoodReserveCommands(ai, foodReserve = {}) {
  const count = Math.ceil(Number(foodReserve.count) || 0)
  if (count <= 0) return []
  return [
    `give ${ai} minecraft:${foodReserve.item || FIXTURE_FOOD_RESERVE_ITEM} ${count}`,
    `effect give ${ai} minecraft:saturation ${FIXTURE_FOOD_SATURATION_SECONDS} ${FIXTURE_FOOD_SATURATION_AMPLIFIER} true`
  ]
}

function estimateFixtureScaffoldBlocks(blueprint, origin) {
  if (!blueprint?.blocks?.length || !origin) return 0
  const worldBlocks = blueprint.blocks
    .filter(block => block?.type && !['air', 'cave_air', 'void_air'].includes(block.type))
    .map(block => ({
      type: block.type,
      position: {
        x: Math.round(origin.x + block.x),
        y: Math.round(origin.y + block.y),
        z: Math.round(origin.z + block.z)
      }
    }))
  if (!worldBlocks.length) return 0
  const context = {
    bot: {
      username: 'fixture_planner',
      entity: { position: { x: origin.x, y: origin.y, z: origin.z } },
      entities: {},
      blockAt(position) {
        const pos = normalizeFixturePosition(position)
        if (pos.y === Math.round(origin.y) - 1) return { name: 'stone', position: pos }
        return { name: 'air', position: pos }
      }
    }
  }
  return createSitePlan(context, worldBlocks, { ignoreEntityObstructions: true }).summary.scaffoldBlocks || 0
}

function normalizeFixturePosition(position) {
  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z))
  }
}

function splitMaterialsForScenario(materials, scenario) {
  const inventory = {}
  const storage = {}
  const refill = new Set(scenario.storageRefillMaterials || [])
  let inventorySlots = 0
  const entries = Object.entries(materials)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const [item, count] of entries) {
    const stackSlots = Math.max(1, Math.ceil(Number(count) / fixtureStackLimit(item)))
    if (refill.has(item) || inventorySlots + stackSlots > FIXTURE_INVENTORY_STACK_BUDGET) {
      const missing = Math.min(Math.max(2, Math.ceil(count * 0.25)), count)
      const keepInInventory = refill.has(item) ? Math.max(0, count - missing) : 0
      if (keepInInventory > 0) {
        inventory[item] = keepInInventory
        inventorySlots += Math.max(1, Math.ceil(keepInInventory / fixtureStackLimit(item)))
      }
      storage[item] = count - keepInInventory
    } else {
      inventory[item] = count
      inventorySlots += stackSlots
    }
  }
  return { inventory, storage }
}

function addFixtureStorageReserve(materialSetup, extras) {
  for (const [item, count] of Object.entries(extras || {})) {
    const existing = Number(materialSetup.storage[item] || 0)
    materialSetup.storage[item] = Math.max(existing, Number(count) || 0)
  }
  return materialSetup
}

function storagePositionsForMaterials(bounds, origin, materials) {
  const stacks = storageStacks(materials)
  if (!stacks.length) return []
  const chestCount = Math.ceil(stacks.length / 27)
  return Array.from({ length: chestCount }, (_, index) => ({
    x: bounds.minX - 3 - index * 2,
    y: origin.y,
    z: bounds.minZ - 4
  }))
}

function giveCommands(ai, materials) {
  const commands = []
  for (const [item, count] of Object.entries(materials || {})) {
    let remaining = Math.ceil(Number(count) || 0)
    const limit = fixtureStackLimit(item)
    while (remaining > 0) {
      const size = Math.min(limit, remaining)
      commands.push(`give ${ai} minecraft:${item} ${size}`)
      remaining -= size
    }
  }
  return commands
}

function storageCommands(positions, materials) {
  const stacks = storageStacks(materials)
  if (!stacks.length) return []
  const commands = []
  positions.forEach((pos, index) => {
    commands.push(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:stone`)
    commands.push(`setblock ${pos.x} ${pos.y + 1} ${pos.z} minecraft:air`)
    commands.push(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:chest`)
  })
  stacks.forEach((stack, index) => {
    const chest = positions[Math.floor(index / 27)]
    const slot = index % 27
    if (!chest) return
    commands.push(`item replace block ${chest.x} ${chest.y} ${chest.z} container.${slot} with minecraft:${stack.item} ${stack.count}`)
  })
  return commands
}

function storageStacks(materials) {
  const stacks = []
  for (const [item, count] of Object.entries(materials || {})) {
    let remaining = Math.ceil(Number(count) || 0)
    const limit = fixtureStackLimit(item)
    while (remaining > 0) {
      const size = Math.min(limit, remaining)
      stacks.push({ item, count: size })
      remaining -= size
    }
  }
  return stacks
}

function fixtureStackLimit(item) {
  const value = String(item || '')
  if (value.endsWith('_bed')) return 1
  if (value.endsWith('_banner') || value.endsWith('_sign')) return 16
  if (value.endsWith('_bucket') || value.endsWith('_boat') || value.endsWith('_minecart')) return 1
  if (/_sword$|_pickaxe$|_axe$|_shovel$|_hoe$|_helmet$|_chestplate$|_leggings$|_boots$/.test(value)) return 1
  if (['saddle', 'shield', 'elytra', 'totem_of_undying', 'cake'].includes(value)) return 1
  if (['egg', 'snowball', 'ender_pearl', 'honey_bottle', 'potion', 'splash_potion', 'lingering_potion'].includes(value)) return 16
  return 64
}

async function runFixtureCommands(adapter, commands) {
  const results = []
  for (const command of commands) results.push(await adapter.runServerCommand(command))
  const denied = results.find(result => result.commandDenied)
  return {
    attempted: commands.length,
    commands: results,
    commandDenied: Boolean(denied),
    deniedMessage: denied?.deniedMessage || null
  }
}

function mergeLogLines(...groups) {
  const seen = new Set()
  const merged = []
  for (const group of groups) {
    for (const line of group || []) {
      if (seen.has(line)) continue
      seen.add(line)
      merged.push(line)
    }
  }
  return merged
}

function assertScenario({ scenario, expected, logs, afterBlocks, living, terminalLogs }) {
  const routeEvidence = firstRouteEvidence(logs)
  const taskStartEvidence = firstTaskStartEvidence(logs)
  const intentObserved = Boolean(routeEvidence)
  const taskStarted = Boolean(taskStartEvidence)
  const faithfulMode = expected.summary?.sourceMode === 'faithful-community-import'
  const builtName = expected.summary?.blueprintName || scenario.blueprintName
  const lineForBuild = line => line.includes(`blueprint=${builtName}`) || line.includes(`selected=${builtName}`)
  const selectedObserved = logs.some(line =>
    line.includes('[BLUEPRINT_SELECTED]') &&
    line.includes('source=real_community_import') &&
    (line.includes(`selected=${builtName}`) || line.includes(`request=${scenario.blueprintName}`))
  )
  const designObserved = faithfulMode
    ? logs.some(line => line.includes('[BUILD_DESIGN]') && lineForBuild(line) && line.includes('transformed=false'))
    : logs.some(line => line.includes('[BUILD_DESIGN]') && lineForBuild(line) && line.includes('transformed=true'))
  const layoutObserved = faithfulMode || logs.some(line => line.includes('[BUILD_LAYOUT_PLAN]') && lineForBuild(line) && line.includes('ok=true'))
  const styleGrammarObserved = faithfulMode || logs.some(line => line.includes('[BUILD_STYLE_GRAMMAR]') && lineForBuild(line) && line.includes('ok=true'))
  const facadeObserved = faithfulMode || logs.some(line => line.includes('[BUILD_FACADE_PASS]') && lineForBuild(line) && line.includes('ok=true'))
  const structureEncodingObserved = logs.some(line => line.includes('[BUILD_STRUCTURE_ENCODING]') && lineForBuild(line))
  const communitySimilarityObserved = faithfulMode || logs.some(line => line.includes('[BUILD_COMMUNITY_SIMILARITY]') && lineForBuild(line))
  const aestheticScoreObserved = faithfulMode || logs.some(line => line.includes('[BUILD_AESTHETIC_SCORE]') && line.includes('stage=final') && lineForBuild(line))
  const refinerObserved = faithfulMode || logs.some(line => line.includes('[BUILD_AESTHETIC_REFINE]') && lineForBuild(line) && line.includes('refined=true'))
  const aestheticAcceptedObserved = faithfulMode || logs.some(line => line.includes('[BUILD_AESTHETIC_SCORE]') && line.includes('stage=final') && lineForBuild(line) && line.includes('accepted=true'))
  const communityObserved = !scenario.requireCommunity ||
    logs.some(line => line.includes('[BUILD_COMMUNITY_SAMPLES]') && line.includes('real_community_import'))
  const habitabilityPreGateObserved = logs.some(line => line.includes('[BUILD_HABITABILITY_GATE]') && line.includes('stage=pre') && line.includes('ok=true'))
  const habitabilityFinalGateObserved = logs.some(line => line.includes('[BUILD_HABITABILITY_GATE]') && line.includes('stage=final') && line.includes('ok=true'))
  const interiorObserved = !scenario.requireInterior ||
    logs.some(line => line.includes('[BUILD_INTERIOR_PLAN]') && line.includes('complete=true'))
  const interiorUsabilityObserved = !scenario.requireInterior ||
    logs.some(line => line.includes('[BUILD_INTERIOR_USABILITY]') && line.includes('ok=true'))
  const faithfulWorldGateObserved = logs.some(line => line.includes('[BUILD_FAITHFUL_WORLD_GATE]') && line.includes('ok=true'))
  const walkabilityPreGateObserved = faithfulMode || logs.some(line => line.includes('[BUILD_WALKABILITY_GATE]') && line.includes('stage=pre') && line.includes('ok=true'))
  const walkabilityFinalGateObserved = faithfulMode ? faithfulWorldGateObserved : logs.some(line => line.includes('[BUILD_WALKABILITY_GATE]') && line.includes('stage=final') && line.includes('ok=true'))
  const validationOk = logs.some(line => line.includes('[BUILD_VALIDATION] ok=true'))
  const taskCompleted = logs.some(line => /\[TaskManager\] completed #[0-9]+ build_blueprint/.test(line))
  const taskFailed = [...logs].reverse().find(line => /\[TaskManager\] failed #[0-9]+ build_blueprint/.test(line))
  const taskFailureReason = latestBuildTaskFailureReason(logs)
  const taskPauseReason = latestBuildTaskPauseReason(logs)
  const terminalObserved = Boolean(taskCompleted || taskFailed)
  const blocksOk = afterBlocks.ok
  const furnitureOk = !scenario.requireInterior || afterBlocks.interiorOk
  const zonesOk = !scenario.requiredZones?.length ||
    scenario.requiredZones.every(zone => expected.interiorPlan.rooms.some(room => room.zone === zone))
  const stairsOk = !scenario.requireStairs ||
    living.reachableTargets.some(target => String(target.role || '').includes('stairs'))
  const requiredLivingTargetsOk = !(scenario.requiredLivingTargets || []).length ||
    scenario.requiredLivingTargets.every(role => living.reachableTargets.some(target => target.role === role))
  const walkabilityOk = living.ok === true
  const gardenOk = !scenario.requireGarden || afterBlocks.gardenOk
  const precisionOk = !scenario.requirePrecision || afterBlocks.correctCount === afterBlocks.expectedCount
  const storageOk = !scenario.storageRefillMaterials?.length || distinctStorageRefillItems(logs).length >= scenario.storageRefillMaterials.length
  const designQuality = assertDesignQuality(scenario, expected)
  const aestheticQuality = assertAestheticQuality(scenario, expected)

  const pass = intentObserved &&
    taskStarted &&
    selectedObserved &&
    designObserved &&
    layoutObserved &&
    styleGrammarObserved &&
    facadeObserved &&
    structureEncodingObserved &&
    communitySimilarityObserved &&
    aestheticScoreObserved &&
    refinerObserved &&
    aestheticAcceptedObserved &&
    habitabilityPreGateObserved &&
    habitabilityFinalGateObserved &&
    designQuality.ok &&
    aestheticQuality.ok &&
    communityObserved &&
    interiorObserved &&
    interiorUsabilityObserved &&
    walkabilityPreGateObserved &&
    walkabilityFinalGateObserved &&
    walkabilityOk &&
    stairsOk &&
    requiredLivingTargetsOk &&
    validationOk &&
    taskCompleted &&
    terminalObserved &&
    blocksOk &&
    furnitureOk &&
    zonesOk &&
    gardenOk &&
    precisionOk &&
    storageOk

  return {
    judgment: pass ? 'PASS' : 'FAIL',
    intentObserved,
    taskStarted,
    selectedObserved,
    designObserved,
    layoutObserved,
    styleGrammarObserved,
    facadeObserved,
    structureEncodingObserved,
    communitySimilarityObserved,
    aestheticScoreObserved,
    refinerObserved,
    aestheticAcceptedObserved,
    designQuality,
    aestheticQuality,
    communityObserved,
    interiorObserved,
    interiorUsabilityObserved,
    habitabilityPreGateObserved,
    habitabilityFinalGateObserved,
    walkabilityPreGateObserved,
    walkabilityFinalGateObserved,
    walkabilityOk,
    stairsOk,
    requiredLivingTargetsOk,
    livingFailures: living.failures,
    validationOk,
    taskCompleted,
    taskFailed: taskFailed || null,
    taskFailureReason,
    taskPauseReason,
    terminalObserved,
    blocksOk,
    furnitureOk,
    zonesOk,
    gardenOk,
    precisionOk,
    storageOk,
    storageRefillItems: distinctStorageRefillItems(logs),
    routeEvidence,
    taskStartEvidence,
    failureReason: pass ? null : failureReason({
      intentObserved,
      taskStarted,
      selectedObserved,
      designObserved,
      layoutObserved,
      styleGrammarObserved,
      facadeObserved,
      structureEncodingObserved,
      communitySimilarityObserved,
      aestheticScoreObserved,
      refinerObserved,
      aestheticAcceptedObserved,
      designQuality,
      aestheticQuality,
      communityObserved,
      interiorObserved,
      interiorUsabilityObserved,
      habitabilityPreGateObserved,
      habitabilityFinalGateObserved,
      walkabilityPreGateObserved,
      walkabilityFinalGateObserved,
      walkabilityOk,
      stairsOk,
      requiredLivingTargetsOk,
      livingFailures: living.failures,
      validationOk,
      taskCompleted,
      taskFailed,
      taskFailureReason,
      taskPauseReason,
      terminalObserved,
      blocksOk,
      furnitureOk,
      zonesOk,
      gardenOk,
      precisionOk,
      storageOk
    })
  }
}

function firstRouteEvidence(logs) {
  return (logs || []).find(line =>
    (line.includes('[INTENT_RESULT]') && line.includes('BUILD')) ||
    (line.includes('[intent-to-task]') && line.includes('actionKey=BUILD') && line.includes('build_blueprint')) ||
    (line.includes('[router]') && line.includes('actionKey=BUILD')) ||
    (line.includes('[CommandRouter]') && line.includes('"actionKey":"BUILD"'))
  ) || null
}

function latestBuildTaskFailureReason(logs) {
  const line = [...(logs || [])].reverse().find(entry => /\[Task:build_blueprint#[0-9]+\] fail:/.test(entry))
  const match = line?.match(/\[Task:build_blueprint#[0-9]+\] fail:\s*([^\s]+)/)
  return match?.[1] || null
}

function latestBuildTaskPauseReason(logs) {
  const line = [...(logs || [])].reverse().find(entry => /\[Task:build_blueprint#[0-9]+\] pause:/.test(entry))
  const match = line?.match(/\[Task:build_blueprint#[0-9]+\] pause:\s*([^\s]+)/)
  return match?.[1] || null
}

function firstTaskStartEvidence(logs) {
  return (logs || []).find(line =>
    (line.includes('[TASK_STARTED]') && line.includes('build_blueprint')) ||
    (line.includes('[TASK_CREATED]') && line.includes('build_blueprint')) ||
    (line.includes('[TASK_CREATE_ATTEMPT]') && line.includes('build_blueprint')) ||
    (line.includes('[TASK_ENQUEUED]') && line.includes('build_blueprint')) ||
    (line.includes('[task-manager] enqueue task=build_blueprint')) ||
    (line.includes('[BUILD_SITE_SCAN]') && line.includes(`blueprint=`))
  ) || null
}

function observeBlueprintBlocks(adapter, blueprint, origin) {
  const observed = []
  let correctCount = 0
  let supportOk = true
  let interiorExpected = 0
  let interiorCorrect = 0
  let gardenExpected = 0
  let gardenCorrect = 0
  for (const block of blueprint.blocks) {
    const pos = {
      x: origin.x + block.x - (blueprint.origin?.x || 0),
      y: origin.y + block.y - (blueprint.origin?.y || 0),
      z: origin.z + block.z - (blueprint.origin?.z || 0)
    }
    const live = adapter.bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z))
    const below = adapter.bot?.blockAt?.(new Vec3(pos.x, pos.y - 1, pos.z))
    const actual = live?.name || null
    const expected = block.type
    const correct = isAir(expected) ? isAir(actual) : actual === expected
    if (correct) correctCount += 1
    if (!isAir(expected) && block.y === 0 && (!below || isAir(below.name))) supportOk = false
    if (block.phase === 'interior') {
      interiorExpected += 1
      if (correct) interiorCorrect += 1
    }
    if (block.phase === 'garden') {
      gardenExpected += 1
      if (correct) gardenCorrect += 1
    }
    observed.push({
      relative: { x: block.x, y: block.y, z: block.z },
      position: pos,
      expected,
      actual,
      phase: block.phase || null,
      role: block.role || null,
      support: below?.name || null,
      correct
    })
  }

  const targetsPrepared = observed.every(entry => entry.actual === 'air' || entry.expected === 'air' || entry.actual === entry.expected)
  return {
    ok: correctCount === blueprint.blocks.length,
    correctCount,
    expectedCount: blueprint.blocks.length,
    supportOk,
    targetsPrepared,
    interiorExpected,
    interiorCorrect,
    interiorOk: interiorExpected === 0 || interiorExpected === interiorCorrect,
    gardenExpected,
    gardenCorrect,
    gardenOk: gardenExpected === 0 || gardenExpected === gardenCorrect,
    observed
  }
}

function observeLivingUse(adapter, expected, origin) {
  if (expected.summary?.sourceMode === 'faithful-community-import') {
    return {
      ok: true,
      skipped: true,
      reason: 'faithful_world_gate_handles_reachability_and_fidelity',
      failures: [],
      summary: null,
      reachableTargets: [],
      unreachableTargets: []
    }
  }
  const result = new WalkabilityChecker().checkWorld({ bot: adapter.bot }, expected.blueprint, {
    origin,
    layoutPlan: expected.layoutPlan,
    interiorPlan: expected.interiorPlan
  })
  return {
    ok: result.ok === true,
    failures: result.failures || [],
    summary: result.summary || null,
    reachableTargets: (result.reachableTargets || []).map(target => ({
      role: target.role,
      type: target.type,
      reachedAt: target.reachedAt || null
    })),
    unreachableTargets: (result.unreachableTargets || []).map(target => ({
      role: target.role,
      type: target.type
    }))
  }
}

function fixtureOrigin(snapshot, index, blueprint = null) {
  const anchor = snapshot.acceptancePlayerPosition || snapshot.playerPosition || snapshot.companionPosition || { x: 0, y: 64, z: 0 }
  const strideX = fixtureSiteStrideX(blueprint)
  return {
    x: Math.round(Number(anchor.x)) + FIXTURE_SITE_BASE_OFFSET_X + index * strideX,
    y: Math.round(Number(anchor.y)),
    z: Math.round(Number(anchor.z)) + index * FIXTURE_SITE_STRIDE_Z
  }
}

function fixtureSiteStrideX(blueprint = null) {
  const blocks = Array.isArray(blueprint?.blocks) ? blueprint.blocks : []
  if (!blocks.length) return FIXTURE_SITE_MIN_STRIDE_X
  const xs = blocks.map(block => Number(block.x)).filter(Number.isFinite)
  if (!xs.length) return FIXTURE_SITE_MIN_STRIDE_X
  const width = Math.max(...xs) - Math.min(...xs) + 1
  return Math.max(FIXTURE_SITE_MIN_STRIDE_X, width + FIXTURE_SITE_MARGIN_X)
}

function evacuationPosition(origin) {
  return {
    x: origin.x - 3,
    y: origin.y,
    z: origin.z - 3
  }
}

function blueprintBounds(blueprint, origin) {
  const buildBounds = blueprintBuildBounds(blueprint, origin)
  return {
    minX: buildBounds.minX - FIXTURE_SITE_CLEARANCE_MARGIN,
    maxX: buildBounds.maxX + FIXTURE_SITE_CLEARANCE_MARGIN,
    minY: buildBounds.minY,
    maxY: buildBounds.maxY,
    minZ: buildBounds.minZ - FIXTURE_SITE_CLEARANCE_MARGIN,
    maxZ: buildBounds.maxZ + FIXTURE_SITE_CLEARANCE_MARGIN
  }
}

function blueprintBuildBounds(blueprint, origin) {
  const positions = blueprint.blocks.map(block => ({
    x: origin.x + block.x - (blueprint.origin?.x || 0),
    y: origin.y + block.y - (blueprint.origin?.y || 0),
    z: origin.z + block.z - (blueprint.origin?.z || 0)
  }))
  return {
    minX: Math.min(...positions.map(pos => pos.x)),
    maxX: Math.max(...positions.map(pos => pos.x)),
    minY: Math.min(...positions.map(pos => pos.y)),
    maxY: Math.max(...positions.map(pos => pos.y)),
    minZ: Math.min(...positions.map(pos => pos.z)),
    maxZ: Math.max(...positions.map(pos => pos.z))
  }
}

function distinctStorageRefillItems(logs) {
  const items = new Set()
  for (const line of logs || []) {
    const match = line.match(/\[BUILD_STORAGE_REFILL\] item=([a-z0-9_]+)/)
    if (match) items.add(match[1])
  }
  return [...items]
}

function assertDesignQuality(scenario, expected) {
  if (expected.summary?.sourceMode === 'faithful-community-import') {
    return {
      ok: true,
      skipped: true,
      reason: 'faithful_community_import',
      metrics: expected.summary.faithfulValidation?.metrics || {}
    }
  }
  const design = expected.summary?.design || {}
  const metrics = design.metrics || {}
  const materialCounts = metrics.materialCounts || {}
  const failures = []
  if (metrics.isPureBox === true || metrics.pureBox === true) failures.push('design_is_pure_box')
  if (!(metrics.footprintFill < 0.95)) failures.push('silhouette_has_no_footprint_variation')
  if (!Array.isArray(metrics.uniqueColumnHeights) || metrics.uniqueColumnHeights.length < 2) failures.push('silhouette_has_no_height_variation')
  if (!design.styleValidation?.ok) failures.push(`style_grammar_failed:${(design.styleValidation?.violations || []).join(',')}`)
  if (!design.facadeValidation?.ok) failures.push(`facade_validation_failed:${(design.facadeValidation?.violations || []).join(',')}`)

  if (scenario.blueprintName === 'two_story_wood_house') {
    if (!Array.isArray(metrics.roofLevels) || metrics.roofLevels.length < 2) failures.push('wood_roof_levels_missing')
    if ((metrics.windowGroups || 0) < 2) failures.push('wood_window_groups_missing')
    if ((materialCounts.oak_log || 0) < 8) failures.push('wood_beam_structure_missing')
  }

  if (scenario.blueprintName === 'modern_villa') {
    if ((metrics.volumeCount || 0) < 3 || (design.volumeCount || 0) < 3) failures.push('modern_volume_segmentation_missing')
    if ((materialCounts.glass || 0) < 8 || (metrics.windowGroups || 0) < 2) failures.push('modern_large_windows_missing')
    if (!materialCounts.white_concrete || !materialCounts.gray_concrete) failures.push('modern_palette_missing')
  }

  if (scenario.blueprintName === 'castle_garden') {
    if ((metrics.towerBlocks || 0) < 12) failures.push('castle_tower_missing')
    if ((metrics.battlementBlocks || 0) < 4) failures.push('castle_battlements_missing')
    if (!String(design.symmetryRules?.mode || '').includes('local_symmetry')) failures.push('castle_local_symmetry_missing')
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      footprintFill: metrics.footprintFill,
      uniqueColumnHeights: metrics.uniqueColumnHeights,
      roofLevels: metrics.roofLevels,
      windowGroups: metrics.windowGroups,
      volumeCount: metrics.volumeCount,
      towerBlocks: metrics.towerBlocks,
      battlementBlocks: metrics.battlementBlocks
    }
  }
}

function assertAestheticQuality(scenario, expected) {
  if (expected.summary?.sourceMode === 'faithful-community-import') {
    return {
      ok: true,
      skipped: true,
      reason: 'faithful_community_import',
      metrics: {
        sourceMode: expected.summary.sourceMode,
        cacheHash: expected.summary.cacheHash,
        structureFileFormat: expected.summary.structureFileFormat
      }
    }
  }
  const aesthetic = expected.summary?.aesthetic || {}
  const final = aesthetic.final || {}
  const metrics = final.metrics || {}
  const contrast = aesthetic.contrast || {}
  const oldOutput = contrast.oldProceduralOutput
  const importedSample = contrast.importedCommunitySample
  const adaptedOutput = contrast.communityGuidedAdaptedOutput
  const failures = []
  const threshold = final.threshold ?? AESTHETIC_DEFAULTS.aestheticThreshold
  const similarityThreshold = final.similarityThreshold ?? AESTHETIC_DEFAULTS.similarityThreshold

  if (!(final.aesthetic_score >= threshold)) failures.push('aesthetic_score_below_threshold')
  if (!(final.similarity_to_good_builds >= similarityThreshold)) failures.push('community_similarity_below_threshold')
  if (final.accepted !== true) failures.push('aesthetic_model_rejected')
  if (!Array.isArray(aesthetic.communitySamples) || aesthetic.communitySamples.length < 1) failures.push('community_samples_missing')
  if (!(aesthetic.refinement?.iterations >= 1)) failures.push('refinement_loop_not_used')
  if (metrics.footprintFill >= 0.95) failures.push('box_like_structure_still_exists')
  if (!Array.isArray(metrics.uniqueColumnHeights) || metrics.uniqueColumnHeights.length < 2) failures.push('flat_structure_still_exists')
  if ((metrics.facadeComplexity || 0) < AESTHETIC_DEFAULTS.minFacadeComplexity) failures.push('facade_complexity_below_baseline')
  if (!oldOutput || !importedSample || !adaptedOutput) failures.push('aesthetic_contrast_missing')
  if (importedSample && importedSample.sourceKind !== 'real_community_import') failures.push('contrast_imported_sample_not_real_community')
  if (importedSample && !importedSample.cacheHash) failures.push('contrast_imported_sample_cache_hash_missing')
  if (importedSample && !importedSample.format) failures.push('contrast_imported_sample_format_missing')
  if (importedSample && importedSample.hardConstraintsOk !== true) failures.push('contrast_imported_sample_hard_gate_failed')
  if (adaptedOutput && adaptedOutput.hardConstraintsOk !== true) failures.push('contrast_adapted_output_hard_gate_failed')
  if (adaptedOutput && !(adaptedOutput.aestheticScore >= threshold)) failures.push('contrast_adapted_score_below_threshold')
  if (adaptedOutput && !(adaptedOutput.similarityToCommunity >= similarityThreshold)) failures.push('contrast_adapted_similarity_below_threshold')
  if (oldOutput && adaptedOutput && !(Number(adaptedOutput.aestheticScore) > Number(oldOutput.aestheticScore))) {
    failures.push('contrast_does_not_show_aesthetic_improvement')
  }
  const contrastEntries = [oldOutput, importedSample, adaptedOutput].filter(Boolean)
  const requiredContrastFields = contrast.requiredFields || [
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
  ]
  for (const entry of contrastEntries) {
    for (const field of requiredContrastFields) {
      if (!Object.prototype.hasOwnProperty.call(entry, field)) {
        failures.push(`contrast_field_missing:${entry.label || 'unknown'}:${field}`)
      }
    }
  }

  if (scenario.blueprintName === 'modern_villa' && (metrics.facadeLayerCount || 0) < 3) {
    failures.push('modern_facade_layers_below_baseline')
  }

  if (scenario.blueprintName === 'castle_garden') {
    if ((metrics.nodeCount || 0) < 3) failures.push('castle_depth_structure_missing')
    if ((metrics.facadeLayerCount || 0) < 3) failures.push('castle_wall_depth_layers_missing')
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      aesthetic_score: final.aesthetic_score,
      similarity_to_good_builds: final.similarity_to_good_builds,
      threshold,
      similarityThreshold,
      facadeComplexity: metrics.facadeComplexity,
      facadeLayerCount: metrics.facadeLayerCount,
      footprintFill: metrics.footprintFill,
      uniqueColumnHeights: metrics.uniqueColumnHeights,
      nodeCount: metrics.nodeCount,
      refinementIterations: aesthetic.refinement?.iterations || 0,
      contrastObserved: !!(oldOutput && importedSample && adaptedOutput),
      importedSampleId: importedSample?.sampleId || null,
      importedCacheHash: importedSample?.cacheHash || null,
      oldProceduralScore: oldOutput?.aestheticScore ?? null,
      adaptedScore: adaptedOutput?.aestheticScore ?? null,
      adaptedHardConstraintsOk: adaptedOutput?.hardConstraintsOk === true
    }
  }
}

function setupFailureReason({ fixture, setupSnapshot, setupBlocks }) {
  if (fixture.commandResult?.commandDenied) return 'command_denied'
  if (fixture.teleport?.commandDenied) return 'teleport_command_denied'
  if (!setupSnapshot?.configuredAiOnline) return 'configured_ai_not_online'
  if (!setupBlocks?.supportOk) return 'fixture_support_missing'
  if (!setupBlocks?.targetsPrepared) return 'fixture_targets_not_prepared'
  return 'fixture_not_ready'
}

function fixtureStatus(scenario, data) {
  return {
    feature: FEATURE,
    scenario: scenario.id,
    blueprintName: scenario.blueprintName,
    fixtureMode: 'FRESH_FIXTURE_BUILD',
    ...data
  }
}

function expectedBehavior(scenario) {
  return `LinXia should route "${scenario.command}" through BUILD -> build_blueprint, select a faithful real community structure file, skip procedural generation/refiner/interior rewrite, build the real blueprint blocks, pass world fidelity validation, and complete through TaskManager.`
}

function observedBehavior(assertion, afterBlocks, living, expected) {
  return `selected=${assertion.selectedObserved}; sourceMode=${expected.summary.sourceMode}; encoding=${assertion.structureEncodingObserved}; faithfulWorldGate=${assertion.walkabilityFinalGateObserved}; habitabilityFinal=${assertion.habitabilityFinalGateObserved}; validation=${assertion.validationOk}; taskCompleted=${assertion.taskCompleted}; blocks=${afterBlocks.correctCount}/${afterBlocks.expectedCount}; expected=${expected.summary.blueprintName}.`
}

function regressionRisk() {
  return 'Building P9R depends on natural-language routing, TaskManager lifecycle, ActionLock building/movement/digging/inventory ownership, faithful community cache selection, structure parsing, site preparation, pathing, placement, final world fidelity gate, and block validation.'
}

function failureReason(state) {
  if (state.taskFailed) return `build_task_failed:${state.taskFailureReason || 'unknown'}`
  if (!state.intentObserved) return 'intent_not_routed_to_building'
  if (!state.taskStarted) return 'build_task_not_started'
  if (!state.terminalObserved && state.taskPauseReason) return `build_task_paused:${state.taskPauseReason}`
  if (!state.terminalObserved) return 'build_task_terminal_state_timeout'
  if (!state.selectedObserved) return 'blueprint_selection_not_observed'
  if (!state.designObserved) return 'design_layer_not_observed'
  if (!state.structureEncodingObserved) return 'structure_encoding_not_observed'
  if (!state.communitySimilarityObserved) return 'community_similarity_check_not_observed'
  if (!state.aestheticScoreObserved) return 'aesthetic_score_not_observed'
  if (!state.refinerObserved) return 'aesthetic_refiner_not_observed'
  if (!state.aestheticAcceptedObserved) return 'aesthetic_final_acceptance_not_observed'
  if (!state.layoutObserved) return 'space_layout_plan_not_observed'
  if (!state.styleGrammarObserved) return 'style_grammar_validation_not_observed'
  if (!state.facadeObserved) return 'facade_refinement_not_observed'
  if (!state.designQuality?.ok) return `design_quality_failed:${(state.designQuality?.failures || []).join(',')}`
  if (!state.aestheticQuality?.ok) return `aesthetic_quality_failed:${(state.aestheticQuality?.failures || []).join(',')}`
    if (!state.communityObserved) return 'community_blueprint_not_selected'
    if (!state.interiorObserved) return 'interior_plan_not_observed'
    if (!state.interiorUsabilityObserved) return 'interior_usability_validation_not_observed'
    if (!state.habitabilityPreGateObserved) return 'habitability_pre_gate_not_observed'
    if (!state.habitabilityFinalGateObserved) return 'habitability_final_gate_not_observed'
    if (!state.walkabilityPreGateObserved) return 'walkability_pre_gate_not_observed'
  if (!state.walkabilityFinalGateObserved) return 'walkability_final_gate_not_observed'
  if (!state.walkabilityOk) return `live_walkability_failed:${(state.livingFailures || []).join(',')}`
  if (!state.stairsOk) return 'stairs_not_reachable'
  if (!state.requiredLivingTargetsOk) return 'required_living_target_not_reachable'
  if (!state.storageOk) return 'multi_material_storage_refill_not_observed'
  if (!state.taskCompleted) return 'build_task_terminal_success_not_observed'
  if (!state.validationOk) return 'build_validation_success_not_observed'
  if (!state.blocksOk) return 'blueprint_blocks_not_all_present'
  if (!state.furnitureOk) return 'interior_furniture_not_all_present'
  if (!state.zonesOk) return 'required_functional_zones_missing'
  if (!state.gardenOk) return 'garden_blocks_not_all_present'
  if (!state.precisionOk) return 'decorative_precision_blocks_not_aligned'
  return 'building_p9_acceptance_failed'
}

function isAir(name) {
  return ['air', 'cave_air', 'void_air', null, undefined].includes(name)
}
