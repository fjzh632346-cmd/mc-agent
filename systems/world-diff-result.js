const { validateBuild: legacyValidateBuild } = require('../utils/site-planner')

function createWorldDiffResult(overrides = {}) {
  return {
    missingBlocks: [],
    wrongBlocks: [],
    wrongStates: [],
    extraBlocks: [],
    unreachableFunctionalPoints: [],
    scaffoldResidue: [],
    diagnostics: [],
    ...overrides
  }
}

function worldDiffOk(diff) {
  return [
    diff.missingBlocks,
    diff.wrongBlocks,
    diff.wrongStates,
    diff.extraBlocks,
    diff.unreachableFunctionalPoints,
    diff.scaffoldResidue
  ].every(list => !list || list.length === 0) &&
    !(diff.diagnostics || []).some(entry => entry.severity === 'error')
}

function worldDiffFromValidateBuild(validation = {}) {
  const diff = createWorldDiffResult({
    diagnostics: [{
      severity: validation.ok ? 'info' : 'error',
      code: 'legacy_validate_build',
      message: validation.ok ? 'legacy validateBuild passed' : 'legacy validateBuild reported differences'
    }]
  })

  for (const failure of validation.failures || []) {
    const expected = resolvedExpected(failure)
    if (failure.temporary) {
      diff.scaffoldResidue.push({
        position: failure.position,
        expected,
        actual: failure.actual
      })
    } else if (expected === 'air') {
      diff.extraBlocks.push({
        position: failure.position,
        actual: failure.actual
      })
    } else if (isAirName(failure.actual)) {
      diff.missingBlocks.push({
        position: failure.position,
        expected
      })
    } else {
      diff.wrongBlocks.push({
        position: failure.position,
        expected,
        actual: failure.actual
      })
    }
  }

  for (const restore of validation.pendingRestores || []) {
    diff.missingBlocks.push({
      position: restore.target || restore.position || null,
      expected: restore.expected || null,
      restoreStepId: restore.stepId || null,
      restoreForStepId: restore.restoreForStepId || null
    })
    diff.diagnostics.push({
      severity: 'error',
      code: 'pending_restore_step',
      message: `pending restore step: ${restore.stepId || 'unknown'}`
    })
  }

  return diff
}

function worldDiffFromFaithfulComparison(comparison = {}) {
  const metrics = comparison.metrics || {}
  const diff = createWorldDiffResult({
    diagnostics: (comparison.failures || []).map(failure => ({
      severity: comparison.ok ? 'info' : 'error',
      code: failure,
      message: `faithful comparison: ${failure}`
    }))
  })

  for (const mismatch of metrics.sampleMismatches || []) {
    const expected = resolvedExpected(mismatch)
    const entry = {
      position: mismatch.position,
      expected,
      actual: mismatch.actual
    }
    if (isAirName(mismatch.actual)) diff.missingBlocks.push(entry)
    else if (mismatch.expectedStates || mismatch.actualStates) {
      diff.wrongStates.push({
        ...entry,
        expectedStates: mismatch.expectedStates || null,
        actualStates: mismatch.actualStates || null
      })
    } else {
      diff.wrongBlocks.push(entry)
    }
  }

  for (const extra of metrics.sampleExtras || []) {
    const entry = {
      position: extra.position,
      actual: extra.type
    }
    if (extra.type === 'scaffolding') diff.scaffoldResidue.push(entry)
    else diff.extraBlocks.push(entry)
  }

  return diff
}

function worldDiffFromWalkability(walkability = {}) {
  const diff = createWorldDiffResult({
    diagnostics: (walkability.failures || []).map(failure => ({
      severity: walkability.ok ? 'info' : 'error',
      code: normalizeDiagnosticCode(failure),
      message: `walkability: ${failure}`
    }))
  })

  for (const target of walkability.unreachableTargets || []) {
    diff.unreachableFunctionalPoints.push({
      role: target.role,
      type: target.type || null,
      accessCells: target.accessCells || []
    })
  }

  for (const failure of walkability.failures || []) {
    if (!/^unreachable:|^jump_required:|^target_access_cell_missing:/.test(String(failure))) continue
    const [, role = failure] = String(failure).split(':')
    if (diff.unreachableFunctionalPoints.some(point => point.role === role)) continue
    diff.unreachableFunctionalPoints.push({ role, type: null, accessCells: [] })
  }

  return diff
}

function mergeWorldDiffResults(...results) {
  const merged = createWorldDiffResult()
  for (const result of results.filter(Boolean)) {
    merged.missingBlocks.push(...(result.missingBlocks || []))
    merged.wrongBlocks.push(...(result.wrongBlocks || []))
    merged.wrongStates.push(...(result.wrongStates || []))
    merged.extraBlocks.push(...(result.extraBlocks || []))
    merged.unreachableFunctionalPoints.push(...(result.unreachableFunctionalPoints || []))
    merged.scaffoldResidue.push(...(result.scaffoldResidue || []))
    merged.diagnostics.push(...(result.diagnostics || []))
  }
  return merged
}

class WorldDiffValidator {
  validateBuild(context, worldBlocks = [], scaffold = [], options = {}) {
    const legacy = legacyValidateBuild(context, worldBlocks, scaffold, options)
    const diff = worldDiffFromValidateBuild({
      ...legacy,
      pendingRestores: options.pendingRestores || []
    })
    return {
      ok: legacy.ok && worldDiffOk(diff),
      legacy,
      diff,
      diagnostics: diff.diagnostics
    }
  }

  fromFaithfulComparison(comparison) {
    const diff = worldDiffFromFaithfulComparison(comparison)
    return { ok: comparison?.ok === true && worldDiffOk(diff), legacy: comparison, diff, diagnostics: diff.diagnostics }
  }

  fromWalkability(walkability) {
    const diff = worldDiffFromWalkability(walkability)
    return { ok: walkability?.ok === true && worldDiffOk(diff), legacy: walkability, diff, diagnostics: diff.diagnostics }
  }
}

function normalizeDiagnosticCode(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9_:-]+/g, '_')
    .toLowerCase()
}

function isAirName(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air' || name === null || name === undefined
}

function resolvedExpected(entry = {}) {
  if (entry.materialResolution?.affectsWorldDiff === true && entry.materialResolution?.resolvedBlock) {
    return entry.materialResolution.resolvedBlock
  }
  return entry.expected
}

module.exports = {
  WorldDiffValidator,
  createWorldDiffResult,
  mergeWorldDiffResults,
  worldDiffFromFaithfulComparison,
  worldDiffFromValidateBuild,
  worldDiffFromWalkability,
  worldDiffOk
}
