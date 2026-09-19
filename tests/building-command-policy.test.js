const assert = require('assert')
const { parseIntent } = require('../ai/intent-parser')
const { ACTION_KEYS } = require('../ai/action-keys')
const { BlueprintSelector } = require('../systems/blueprint-selector')
const { _test: communityIndexTest } = require('../systems/community-blueprint-index')
const { _test: buildingSystemTest } = require('../systems/building-system')
const { shouldPreserveNamedBlueprintScale } = require('../systems/building-complexity')
const build = require('../actions/build')

function largeBlueprint(name) {
  return {
    name,
    origin: { x: 0, y: 0, z: 0 },
    blocks: Array.from({ length: 1001 }, (_, index) => ({
      x: index,
      y: 0,
      z: 0,
      type: 'stone_bricks'
    }))
  }
}

function selectorFor(blueprintName, buildingType) {
  const blueprint = largeBlueprint(blueprintName)
  const candidate = {
    id: `fixture-${blueprintName}`,
    blueprintName,
    localName: blueprintName,
    sourceKind: 'local_library',
    buildingType,
    style: buildingType,
    tags: [buildingType],
    quality: 'high',
    complexity: 'large',
    versionRange: { min: '1.20.0', max: '1.20.6' }
  }
  return new BlueprintSelector({
    index: {
      findCandidates: () => [candidate],
      fallbackCandidates: () => []
    },
    loader: {
      listBlueprints: () => [],
      loadBlueprint: () => ({ ok: true, blueprint })
    },
    generator: {
      supports: () => false,
      generate: () => ({ ok: false, error: 'fixture_generator_disabled' })
    }
  })
}

function testNamedFormalBuildingsPreserveScale() {
  for (const rawText of [
    'build modern villa',
    '\u5efa\u9020\u73b0\u4ee3\u522b\u5885',
    'build castle',
    '\u5efa\u9020\u57ce\u5821',
    'build fort wall gate',
    'build watchtower'
  ]) {
    const intent = parseIntent(rawText)
    assert.strictEqual(intent.actionKey, ACTION_KEYS.BUILD, rawText)
    assert.strictEqual(intent.params.complexityTier, undefined, rawText)
    assert.strictEqual(intent.params.designSpec, undefined, rawText)
  }

  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'modern_house_on_a_hilltop_site_fit'
  }), true)
  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'survival_castle'
  }), true)
  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'fort_wall_gate'
  }), true)
  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'fort_watchtower'
  }), true)
  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'modern_villa',
    rawText: 'build small modern villa'
  }), false)
  assert.strictEqual(shouldPreserveNamedBlueprintScale({
    blueprintName: 'fort_wall_gate',
    rawText: 'build small fort wall gate'
  }), false)

  const villa = selectorFor('modern_house_on_a_hilltop_site_fit', 'modern_villa')
    .selectBlueprint({ blueprintName: 'modern_villa', rawText: 'build modern villa' })
  assert.strictEqual(villa.ok, true, villa.error)
  assert.strictEqual(villa.selected.budget, null)

  const reducedVilla = selectorFor('modern_house_on_a_hilltop_site_fit', 'modern_villa')
    .selectBlueprint({ blueprintName: 'modern_villa', rawText: 'build small modern villa' })
  assert.strictEqual(reducedVilla.ok, false)
  assert.ok(reducedVilla.attempted[0].error.startsWith('complexity_budget_rejected'))
}

function testModernCommunityBlueprintNaturalLanguageAliases() {
  for (const rawText of [
    'build the hilltop house',
    '\u5efa\u9020\u73b0\u4ee3\u4f4f\u5b85',
    '\u5efa\u9020\u73b0\u4ee3\u623f\u5c4b',
    '\u5efa\u9020\u5c71\u9876\u522b\u5885'
  ]) {
    const intent = parseIntent(rawText)
    assert.strictEqual(intent.actionKey, ACTION_KEYS.BUILD, rawText)
    assert.strictEqual(intent.params.blueprintName, 'modern_villa', rawText)
  }
}

function testVerifiedRealCommunityAdaptationsRemainSelectable() {
  const base = {
    importStatus: 'verified_adapted',
    sourceMode: 'faithful-community-import'
  }
  assert.strictEqual(
    communityIndexTest.isSelectableFaithfulSample(base),
    true,
    'a verified faithful sample without adaptation remains selectable'
  )
  assert.strictEqual(
    communityIndexTest.isSelectableFaithfulSample({
      ...base,
      adaptation: { usesProceduralFallback: false }
    }),
    true,
    'a real-source-only adaptation remains selectable'
  )
  assert.strictEqual(
    communityIndexTest.isSelectableFaithfulSample({
      ...base,
      adaptation: { usesProceduralFallback: true }
    }),
    false,
    'a procedural adaptation must not enter the faithful library'
  )
  assert.strictEqual(
    communityIndexTest.isSelectableFaithfulSample({
      ...base,
      importStatus: 'rejected'
    }),
    false,
    'an unverified sample must not enter the faithful library'
  )
}

function testResumeIntentIsResumeOnlyAndUnbudgeted() {
  for (const rawText of [
    'continue building modern villa',
    'resume castle',
    '\u7eed\u5efa\u73b0\u4ee3\u522b\u5885',
    '\u7ee7\u7eed\u5efa\u57ce\u5821'
  ]) {
    const intent = parseIntent(rawText)
    assert.strictEqual(intent.actionKey, ACTION_KEYS.BUILD, rawText)
    assert.strictEqual(intent.params.resumeOnly, true, rawText)
    assert.notStrictEqual(intent.params.forceRebuild, true, rawText)
    assert.strictEqual(intent.params.complexityTier, undefined, rawText)
    assert.strictEqual(intent.params.designSpec, undefined, rawText)
  }

  const resumedCastle = selectorFor('survival_castle', 'castle_garden')
    .selectBlueprint({
      blueprintName: 'castle_garden',
      rawText: 'resume castle',
      resumeOnly: true
    })
  assert.strictEqual(resumedCastle.ok, true, resumedCastle.error)
  assert.strictEqual(resumedCastle.selected.budget, null)
}

function testSolidPlacementDelegatesWaterReplacementToPlacementAction() {
  assert.strictEqual(
    buildingSystemTest.shouldClearConstructionPlacementTarget('water', 'quartz_block'),
    false
  )
  assert.strictEqual(
    buildingSystemTest.shouldClearConstructionPlacementTarget('stone', 'quartz_block'),
    true
  )
  assert.strictEqual(
    buildingSystemTest.shouldClearConstructionPlacementTarget('air', 'quartz_block'),
    false
  )
}

function testTemporaryReferenceMaterialFailureTriggersDedicatedRefill() {
  assert.strictEqual(
    buildingSystemTest.isTemporaryReferenceMaterialError(
      'stair_temporary_reference_item:block_item_not_found'
    ),
    true
  )
  assert.strictEqual(
    buildingSystemTest.isTemporaryReferenceMaterialError('block_item_not_found'),
    false
  )
}

async function testControlledVerticalAccessPreviewContinuesBoundedSearch() {
  const partial = {
    status: 'partial',
    cost: 12,
    path: [{ x: 4, y: 65, z: 0 }]
  }
  const success = {
    status: 'success',
    cost: 18,
    path: [{ x: 8, y: 68, z: 0 }]
  }
  let nextCalls = 0
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      getPathFromTo(_movements, start, goal, options) {
        assert.deepStrictEqual(start, bot.entity.position)
        assert.strictEqual(goal.id, 'goal')
        assert.deepStrictEqual(options, { timeout: 1000, tickTimeout: 40 })
        return {
          next() {
            nextCalls += 1
            return {
              done: false,
              value: { result: nextCalls === 1 ? partial : success }
            }
          }
        }
      }
    }
  }

  const preview = await build.previewControlledVerticalAccessPath(
    bot,
    { id: 'movements' },
    { id: 'goal' },
    1000,
    { verticalAccessPreviewSlices: 3 }
  )

  assert.strictEqual(preview.status, 'success')
  assert.strictEqual(preview.previewSlices, 2)
  assert.strictEqual(preview.truncated, false)
  assert.deepStrictEqual(preview.path, success.path)
  assert.strictEqual(nextCalls, 2)
}

async function testControlledVerticalAccessPreviewAdaptsWithinBoundForLongRoute() {
  const partial = { status: 'partial', cost: 30, path: [{ x: 20, y: 68, z: 0 }] }
  const success = { status: 'success', cost: 38, path: [{ x: 30, y: 72, z: 0 }] }
  let nextCalls = 0
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      getPathFromTo() {
        return {
          next() {
            nextCalls += 1
            return {
              done: false,
              value: { result: nextCalls < 10 ? partial : success }
            }
          }
        }
      }
    }
  }
  const goal = { x: 30, y: 72, z: 0 }

  const preview = await build.previewControlledVerticalAccessPath(
    bot,
    { id: 'movements' },
    goal,
    1000
  )

  assert.strictEqual(build.controlledVerticalAccessPreviewSliceBudget(bot, goal), 13)
  assert.strictEqual(preview.status, 'success')
  assert.strictEqual(preview.previewSlices, 10)
  assert.strictEqual(nextCalls, 10)
  assert.strictEqual(
    build.controlledVerticalAccessPreviewSliceBudget(bot, { x: 300, y: 72, z: 0 }),
    16,
    'long routes remain hard-bounded'
  )
}

// Build-18 lantern 604,77,-2: a route that pillars 8-11 scaffolds needs more
// slices than the distance budget hands out, so the first pass stops the
// search while it is still partial. That stop must be reported as OURS
// (truncated), and a pass that is allowed to keep going must hand the loop
// back between slices and give A* wall-clock slack for doing so.
async function testControlledVerticalAccessPreviewFlagsTruncationAndYieldsWhenExtended() {
  const partial = { status: 'partial', cost: 30, path: [{ x: 20, y: 68, z: 0 }] }
  const success = { status: 'success', cost: 38, path: [{ x: 30, y: 72, z: 0 }] }
  const requested = []
  let nextCalls = 0
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      getPathFromTo(_movements, _start, _goal, options) {
        requested.push(options)
        return {
          next() {
            nextCalls += 1
            return { done: false, value: { result: nextCalls < 25 ? partial : success } }
          }
        }
      }
    }
  }
  const goal = { x: 30, y: 72, z: 0 }

  const cheap = await build.previewControlledVerticalAccessPath(bot, { id: 'movements' }, goal, 1000)
  assert.strictEqual(cheap.status, 'partial')
  assert.strictEqual(cheap.previewSlices, 13, 'distance budget for this goal')
  assert.strictEqual(cheap.truncated, true, 'budget ran out while still partial')
  assert.deepStrictEqual(requested[0], { timeout: 1000, tickTimeout: 40 })

  nextCalls = 0
  // a self-rescheduling immediate can only run when the preview lets the
  // loop turn, so it counts the yields
  let ticksBetweenSlices = 0
  let ticker = null
  const tick = () => { ticksBetweenSlices += 1; ticker = setImmediate(tick) }
  ticker = setImmediate(tick)
  const extended = await build.previewControlledVerticalAccessPath(bot, { id: 'movements' }, goal, 2000, {
    verticalAccessPreviewSlices: 50,
    verticalAccessPreviewYieldBetweenSlices: true
  })
  clearImmediate(ticker)
  assert.strictEqual(extended.status, 'success')
  assert.strictEqual(extended.previewSlices, 25)
  assert.strictEqual(extended.truncated, false)
  assert.deepStrictEqual(requested[1], { timeout: 4000, tickTimeout: 40 }, 'wall slack for the yields')
  assert.ok(ticksBetweenSlices >= 20, `timers must run between slices (ran ${ticksBetweenSlices})`)

  nextCalls = 0
  const exhausted = await build.previewControlledVerticalAccessPath(bot, { id: 'movements' }, goal, 2000, {
    verticalAccessPreviewSlices: 5,
    verticalAccessPreviewYieldBetweenSlices: true
  })
  assert.strictEqual(exhausted.status, 'partial')
  assert.strictEqual(exhausted.truncated, true)
}

function testTemporaryCornerResidueRequiresDiagonalRouteAndNonFormalTarget() {
  const blocks = new Map([
    ['590,68,-95', { name: 'dirt', shapes: [[0, 0, 0, 1, 1, 1]] }]
  ])
  const bot = {
    entity: { position: { x: 590.5, y: 68, z: -95.5 } },
    blockAt(position) {
      return blocks.get(`${position.x},${position.y},${position.z}`) || {
        name: 'air',
        shapes: []
      }
    }
  }
  const diagonalPath = [{ x: 589.5, y: 68, z: -94.5, toBreak: [], toPlace: [] }]
  const obstruction = build.temporaryCornerObstructionFromPath(
    bot,
    diagonalPath,
    new Set(['583,70,-88'])
  )
  assert.deepStrictEqual(obstruction.position, { x: 590, y: 68, z: -95 })
  assert.strictEqual(obstruction.blockName, 'dirt')

  assert.strictEqual(
    build.temporaryCornerObstructionFromPath(
      bot,
      diagonalPath,
      new Set(['590,68,-95'])
    ),
    null,
    'a formal Blueprint IR target must never be treated as scaffold residue'
  )
  assert.strictEqual(
    build.temporaryCornerObstructionFromPath(
      bot,
      [{ x: 589.5, y: 68, z: -95.5, toBreak: [], toPlace: [] }],
      new Set(['583,70,-88'])
    ),
    null,
    'a cardinal first step does not have the diagonal corner-clipping failure'
  )
}

function testTemporaryStepSupportResidueRequiresBuildVolumeAndNonFormalTarget() {
  const support = { x: 594, y: 68, z: -83 }
  const bot = {
    entity: { position: { x: 594.47, y: 68, z: -83.3 } },
    blockAt(position) {
      if (`${position.x},${position.y},${position.z}` === '594,68,-83') {
        return { name: 'dirt', shapes: [[0, 0, 0, 1, 1, 1]] }
      }
      return { name: 'air', shapes: [] }
    }
  }
  const firstStepUp = [{ x: 594.5, y: 69, z: -82.5, toBreak: [], toPlace: [] }]
  const buildBounds = { minX: 580, maxX: 614, minZ: -104, maxZ: -71 }
  const residue = build.temporaryStepSupportResidueFromPath(
    bot,
    firstStepUp,
    new Set(['591,70,-79']),
    buildBounds
  )
  assert.deepStrictEqual(residue.position, support)
  assert.strictEqual(residue.blockName, 'dirt')
  assert.strictEqual(residue.kind, 'step_support')
  assert.strictEqual(
    build.isPlannedTerminalStepSupport(residue, { x: 594, y: 69, z: -83 }),
    true,
    'a support under the preview terminal step is active route geometry, not residue'
  )
  assert.strictEqual(
    build.isPlannedTerminalStepSupport(residue, { x: 594, y: 69, z: -82 }),
    false,
    'a support below a non-terminal first step can still be cleared as orphaned residue'
  )

  assert.strictEqual(
    build.temporaryStepSupportResidueFromPath(
      bot,
      firstStepUp,
      new Set(['594,68,-83']),
      buildBounds
    ),
    null,
    'a formal Blueprint IR support target must never be treated as residue'
  )
  assert.strictEqual(
    build.temporaryStepSupportResidueFromPath(
      bot,
      firstStepUp,
      new Set(['591,70,-79']),
      { minX: 600, maxX: 614, minZ: -104, maxZ: -71 }
    ),
    null,
    'a natural step outside the active construction footprint must be preserved'
  )
}

function testLegacyWallSkullUsesEncodedSideSupportAndWorldEquivalence() {
  const target = { x: 10, y: 70, z: 20 }
  const blocks = new Map([
    ['10,69,20', { name: 'quartz_block', position: { x: 10, y: 69, z: 20 } }],
    ['11,70,20', { name: 'quartz_block', position: { x: 11, y: 70, z: 20 } }]
  ])
  const bot = {
    blockAt(position) {
      return blocks.get(`${position.x},${position.y},${position.z}`) || {
        name: 'air',
        position: { x: position.x, y: position.y, z: position.z }
      }
    }
  }
  const legacyStates = { legacyId: '144', legacyData: '4' }
  const reference = build.findReferenceBlockForPlacement(
    { bot },
    target,
    'skeleton_skull',
    legacyStates
  )
  assert.deepStrictEqual(reference.position, { x: 11, y: 70, z: 20 })
  assert.strictEqual(
    build.placementBlockNameMatches('skeleton_wall_skull', 'skeleton_skull', legacyStates),
    true
  )
  assert.strictEqual(
    buildingSystemTest.buildTargetNameMatches(
      'skeleton_wall_skull',
      'skeleton_skull',
      target,
      null,
      legacyStates
    ),
    true
  )
  const legacyStep = { blockName: 'skeleton_skull', states: legacyStates }
  assert.strictEqual(buildingSystemTest.stepStateMatches({ facing: 'west' }, legacyStep), true)
  assert.strictEqual(buildingSystemTest.stepStateMatches({ facing: 'east' }, legacyStep), false)
  assert.deepStrictEqual(buildingSystemTest.physicalSupportOffsetForStep({
    kind: 'place',
    blockName: 'skeleton_skull',
    states: legacyStates
  }), { x: 1, y: 0, z: 0 })
}

function testControlledVerticalAccessFreshReplanDoesNotRequireNewScaffoldPlacement() {
  assert.strictEqual(
    build.shouldFreshReplanControlledVerticalAccess(
      { error: 'move_timeout' },
      new Set(['607,68,-91']),
      {}
    ),
    true,
    'a controlled preview must be replanned even when no new scaffold placement was observed'
  )
  assert.strictEqual(
    build.shouldFreshReplanControlledVerticalAccess(
      { error: 'move_timeout' },
      null,
      {}
    ),
    false,
    'an ordinary unplanned stance move must not enter controlled-route recovery'
  )
  assert.strictEqual(
    build.shouldFreshReplanControlledVerticalAccess(
      { error: 'move_timeout' },
      new Set(),
      { controlledVerticalAccessFreshReplan: false }
    ),
    false,
    'the recursive fresh plan must remain bounded to one retry'
  )
}

function testControlledConstructionDisablesPersistentPathfinderPlacementReturn() {
  const logs = []
  const context = {
    bot: { pathfinder: { LOSWhenPlacingBlocks: true } },
    logger: { log(line) { logs.push(line) } }
  }
  const options = { controlledVerticalAccessPlans: new Map() }
  assert.strictEqual(
    build.disableControlledPathfinderPlacementReturn(
      context,
      { x: 600, y: 70, z: -78 },
      options
    ),
    true
  )
  assert.strictEqual(context.bot.pathfinder.LOSWhenPlacingBlocks, false)
  assert.strictEqual(logs.length, 1)
  assert.ok(logs[0].includes('scope=controlled_construction'))
  assert.strictEqual(
    build.disableControlledPathfinderPlacementReturn(
      context,
      { x: 600, y: 70, z: -78 },
      options
    ),
    false,
    'the process-wide compatibility switch must be idempotent'
  )
  assert.strictEqual(logs.length, 1)

  const ordinary = { bot: { pathfinder: { LOSWhenPlacingBlocks: true } } }
  assert.strictEqual(
    build.disableControlledPathfinderPlacementReturn(
      ordinary,
      { x: 0, y: 64, z: 0 },
      {}
    ),
    false,
    'ordinary movement without a controlled construction plan is unchanged'
  )
  assert.strictEqual(ordinary.bot.pathfinder.LOSWhenPlacingBlocks, true)
}

async function testTemporaryReferenceClearRequiresStableAir() {
  let observation = 0
  const context = {
    bot: {
      blockAt() {
        observation += 1
        return observation % 2 === 0
          ? { name: 'dirt' }
          : { name: 'air' }
      }
    }
  }
  const unstable = await build.confirmTemporaryReferenceClear(
    context,
    { x: 1, y: 2, z: 3 },
    {
      temporaryReferenceClearStableMs: 30,
      temporaryReferenceClearPollMs: 10,
      temporaryReferenceClearConfirmTimeoutMs: 70
    }
  )
  assert.strictEqual(unstable.ok, false)

  observation = 0
  context.bot.blockAt = () => ({ name: 'air' })
  const stable = await build.confirmTemporaryReferenceClear(
    context,
    { x: 1, y: 2, z: 3 },
    {
      temporaryReferenceClearStableMs: 20,
      temporaryReferenceClearPollMs: 10,
      temporaryReferenceClearConfirmTimeoutMs: 100
    }
  )
  assert.strictEqual(stable.ok, true)
  assert.ok(stable.data.stableMs >= 20)
}

// Build-20 at the fort gate: she stood on the wall at 603.5,78,-5.5 and
// "cleared" the scaffold column at 598,69..74,-18, 14-16 blocks away. Six
// [BUILD_STAIR_TEMP_REFERENCE_CLEAR] lines said done, RCON still read dirt.
// mineflayer sends the dig anyway and then sets ITS OWN copy of the block to
// air on a timer, so both the promise and bot.blockAt agree with the lie.
function unreachableClearContext (botPosition, cell, blockName = 'dirt') {
  const logs = []
  const digs = []
  const world = new Map([[`${cell.x},${cell.y},${cell.z}`, blockName]])
  const context = {
    logger: { log: message => logs.push(String(message)) },
    bot: {
      entity: { position: { x: botPosition.x, y: botPosition.y, z: botPosition.z } },
      blockAt(position) {
        const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
        return { name: world.get(key) || 'air', position }
      },
      async dig (block) {
        digs.push(block)
        // exactly what mineflayer does: flip the LOCAL copy, tell nobody
        world.delete(`${Math.floor(block.position.x)},${Math.floor(block.position.y)},${Math.floor(block.position.z)}`)
      }
    }
  }
  return { context, logs, digs, world }
}

const FAST_CLEAR_OPTIONS = {
  temporaryReferenceClearStableMs: 0,
  temporaryReferenceClearPollMs: 1,
  temporaryReferenceClearConfirmTimeoutMs: 20,
  temporaryReferenceClearAttempts: 1,
  temporaryReferenceClearRetryDelayMs: 0,
  temporaryReferenceMovementQuiesceMs: 0
}

async function testTemporaryReferenceClearRefusesTheDigItCannotReach() {
  const cell = { x: 598, y: 69, z: -18 }
  const { context, logs, digs, world } = unreachableClearContext(
    { x: 603.5, y: 78, z: -5.5 },
    cell
  )
  const reach = build.temporaryReferenceClearReach(context.bot, cell, null)
  assert.ok(reach.distance > 14 && reach.distance < 17, `distance was ${reach.distance}`)
  assert.strictEqual(reach.withinReach, false)

  const result = await build.clearTemporaryReferenceBlock(context, cell, {
    options: FAST_CLEAR_OPTIONS
  })

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /^temporary_reference_clear_unreachable:dirt$/)
  assert.strictEqual(result.unreachable, true)
  assert.strictEqual(digs.length, 0, 'the dig packet must never be sent')
  assert.strictEqual(world.get('598,69,-18'), 'dirt', 'and the block is still there')
  const line = logs.find(message => message.includes('[BUILD_TEMP_REFERENCE_CLEAR_UNREACHABLE]'))
  assert.ok(line, logs.join('\n'))
  assert.ok(line.includes('pos=598,69,-18'), line)
  assert.ok(line.includes('block=dirt'), line)
  assert.match(line, /distance=1[456]\.\d\d/, line)
  assert.ok(line.includes('reason=out_of_reach'), line)
  assert.ok(!logs.some(message => message.includes('[BUILD_STAIR_TEMP_REFERENCE_CLEAR]')),
    'and it must not also claim the clear succeeded')
  const ledger = build.temporaryReferenceResidueLedger(context)
  assert.ok(ledger.has('598,69,-18'))
  assert.strictEqual(ledger.get('598,69,-18').blockName, 'dirt')
}

async function testTemporaryReferenceClearStillDigsWhatItCanReach() {
  const cell = { x: 2, y: 64, z: 0 }
  const { context, logs, digs, world } = unreachableClearContext({ x: 0.5, y: 64, z: 0.5 }, cell)
  const result = await build.clearTemporaryReferenceBlock(context, cell, {
    options: FAST_CLEAR_OPTIONS
  })
  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(digs.length, 1)
  assert.strictEqual(world.has('2,64,0'), false)
  assert.ok(logs.some(message => message.includes('[BUILD_STAIR_TEMP_REFERENCE_CLEAR] pos=2,64,0')))
  assert.ok(!logs.some(message => message.includes('UNREACHABLE')))
  assert.strictEqual(build.temporaryReferenceResidueLedger(context)?.size ?? 0, 0)
}

// mineflayer defers to bot.canDigBlock for the same question, so when the bot
// exposes it we use its answer rather than a second opinion.
async function testTemporaryReferenceClearDefersToCanDigBlock() {
  const cell = { x: 2, y: 64, z: 0 }
  const { context, digs } = unreachableClearContext({ x: 0.5, y: 64, z: 0.5 }, cell)
  context.bot.canDigBlock = () => false
  const refused = await build.clearTemporaryReferenceBlock(context, cell, { options: FAST_CLEAR_OPTIONS })
  assert.strictEqual(refused.ok, false)
  assert.match(refused.error, /unreachable/)
  assert.strictEqual(digs.length, 0)
}

// The lie is sticky: after a refused dig the client keeps reporting air for
// that cell (live probe: still air 6 s later, and only a chunk reload put the
// block back). A later pass must not read that as "already clear".
async function testTemporaryReferenceClearDoesNotTrustClientAirForALiedCell() {
  const cell = { x: 598, y: 69, z: -18 }
  const { context, logs, digs } = unreachableClearContext({ x: 603.5, y: 78, z: -5.5 }, cell)
  const first = await build.clearTemporaryReferenceBlock(context, cell, { options: FAST_CLEAR_OPTIONS })
  assert.strictEqual(first.ok, false)

  // now the client claims the cell is air, exactly as mineflayer left it
  context.bot.blockAt = position => ({ name: 'air', position })
  const second = await build.clearTemporaryReferenceBlock(context, cell, { options: FAST_CLEAR_OPTIONS })
  assert.strictEqual(second.ok, false, 'client air is not evidence for a cell we never reached')
  assert.strictEqual(second.unreachable, true)
  assert.strictEqual(digs.length, 0)
  const line = [...logs].reverse().find(message => message.includes('[BUILD_TEMP_REFERENCE_CLEAR_UNREACHABLE]'))
  assert.ok(line.includes('reason=unverified_client_air'), line)

  // and once she is actually next to it, the cell clears and leaves the ledger
  context.bot.entity.position = { x: 597.5, y: 69, z: -17.5 }
  context.bot.blockAt = position => ({ name: 'air', position })
  const third = await build.clearTemporaryReferenceBlock(context, cell, { options: FAST_CLEAR_OPTIONS })
  assert.strictEqual(third.ok, true, third.error)
  assert.strictEqual(build.temporaryReferenceResidueLedger(context).size, 0)
}

// A cell she cannot reach is left behind and written down, not turned into a
// cleanup failure: the brick that just went up must not be lost over it.
async function testTemporaryReferenceCleanupLeavesResidueInsteadOfClaimingSuccess() {
  const near = { x: 2, y: 64, z: 0 }
  const far = { x: 20, y: 64, z: 0 }
  const { context, logs, digs, world } = unreachableClearContext({ x: 0.5, y: 64, z: 0.5 }, near)
  world.set('20,64,0', 'dirt')
  world.set('3,64,0', 'dirt')

  const result = await build.clearTemporaryPlacementReference(
    context,
    { positions: [far, near, { x: 3, y: 64, z: 0 }] },
    { options: FAST_CLEAR_OPTIONS }
  )

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.message, 'temporary_reference_cleanup_left_residue')
  assert.strictEqual(result.data.unreachable.length, 1)
  assert.deepStrictEqual(result.data.unreachable[0].position, far)
  assert.strictEqual(digs.length, 2, 'the two reachable cells were still dug')
  assert.strictEqual(world.get('20,64,0'), 'dirt')
  const residueLine = logs.find(message => message.includes('[BUILD_TEMP_REFERENCE_RESIDUE]'))
  assert.ok(residueLine, logs.join('\n'))
  assert.ok(residueLine.includes('left=1/3'), residueLine)
  assert.ok(residueLine.includes('positions=20,64,0'), residueLine)
  assert.ok(residueLine.includes('reason=out_of_reach'), residueLine)
  assert.ok(!logs.some(message => message.includes('[BUILD_STAIR_TEMP_REFERENCE_CLEAR] pos=20,64,0')),
    'no success line for the cell that was left behind')
  assert.ok(build.temporaryReferenceResidueLedger(context).has('20,64,0'))
}

async function testControlledScaffoldCleanupSynchronouslyStopsMovement() {
  const calls = []
  const context = {
    bot: {
      pathfinder: {
        setGoal(goal) { calls.push(['setGoal', goal]) },
        stop() { calls.push(['stop']) }
      },
      clearControlStates() { calls.push(['clearControlStates']) },
      blockAt() { return { name: 'air' } },
      async dig() {}
    }
  }
  const result = await build.clearTemporaryPlacementReference(
    context,
    { positions: [{ x: 1, y: 2, z: 3 }] },
    {
      lockOwner: 'test-build',
      stopMovementBeforeClear: true,
      movementStopReason: 'test_vertical_cleanup',
      options: {
        temporaryReferenceMovementQuiesceMs: 0,
        temporaryReferenceClearStableMs: 0,
        temporaryReferenceClearConfirmTimeoutMs: 0
      }
    }
  )
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(calls, [
    ['setGoal', null],
    ['stop'],
    ['clearControlStates']
  ])
}

async function run() {
  testNamedFormalBuildingsPreserveScale()
  testModernCommunityBlueprintNaturalLanguageAliases()
  testVerifiedRealCommunityAdaptationsRemainSelectable()
  testResumeIntentIsResumeOnlyAndUnbudgeted()
  testSolidPlacementDelegatesWaterReplacementToPlacementAction()
  testTemporaryReferenceMaterialFailureTriggersDedicatedRefill()
  testLegacyWallSkullUsesEncodedSideSupportAndWorldEquivalence()
  await testControlledVerticalAccessPreviewContinuesBoundedSearch()
  await testControlledVerticalAccessPreviewAdaptsWithinBoundForLongRoute()
  await testControlledVerticalAccessPreviewFlagsTruncationAndYieldsWhenExtended()
  testTemporaryCornerResidueRequiresDiagonalRouteAndNonFormalTarget()
  testTemporaryStepSupportResidueRequiresBuildVolumeAndNonFormalTarget()
  testControlledVerticalAccessFreshReplanDoesNotRequireNewScaffoldPlacement()
  testControlledConstructionDisablesPersistentPathfinderPlacementReturn()
  await testTemporaryReferenceClearRefusesTheDigItCannotReach()
  await testTemporaryReferenceClearStillDigsWhatItCanReach()
  await testTemporaryReferenceClearDefersToCanDigBlock()
  await testTemporaryReferenceClearDoesNotTrustClientAirForALiedCell()
  await testTemporaryReferenceCleanupLeavesResidueInsteadOfClaimingSuccess()
  await testTemporaryReferenceClearRequiresStableAir()
  await testControlledScaffoldCleanupSynchronouslyStopsMovement()
  console.log('building command policy tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
