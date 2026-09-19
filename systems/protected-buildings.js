const fs = require('fs')
const path = require('path')

// Completed buildings are protected world regions: any dig targeting a block
// inside a COMPLETED construction run's bounds (+margin) must be refused
// unless the digger is that run's own reconciliation/repair flow (exemption
// is granted strictly per matching runId — never globally).
//
// Regions are derived dynamically from the run store so every future
// completed building is protected automatically; nothing is hardcoded.

const DEFAULT_RUN_STORE_PATH = path.join(process.cwd(), 'data', 'memory', 'construction-runs.json')
const DEFAULT_MARGIN = 1

let regionCache = { filePath: null, mtimeMs: -1, margin: null, regions: [], renovationLinks: new Map() }

function boundsFinite(bounds) {
  return bounds &&
    [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ]
      .every(Number.isFinite)
}

function isCompletedRun(run) {
  return run && (run.terminalState === 'COMPLETED' || run.status === 'COMPLETED')
}

function isTerminalRun(run) {
  return run && (
    ['COMPLETED', 'FAILED', 'ABANDONED', 'CANCELLED'].includes(run.terminalState) ||
    ['COMPLETED', 'ABANDONED', 'CANCELLED'].includes(run.status)
  )
}

function unionBounds(a, b) {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ),
    maxZ: Math.max(a.maxZ, b.maxZ)
  }
}

function loadProtectedState(options = {}) {
  const filePath = options.runStorePath || DEFAULT_RUN_STORE_PATH
  const margin = options.margin ?? DEFAULT_MARGIN
  let stat = null
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { regions: [], renovationLinks: new Map() }
  }
  if (regionCache.filePath === filePath && regionCache.mtimeMs === stat.mtimeMs && regionCache.margin === margin) {
    return regionCache
  }
  let runs = []
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    runs = Array.isArray(data) ? data : (data.runs || [])
  } catch {
    // unreadable mid-write: keep the previous cache rather than dropping protection
    return regionCache.filePath === filePath ? regionCache : { regions: [], renovationLinks: new Map() }
  }
  // Renovation lineage links: runId -> { renovationOf, completed, terminal }.
  // Used for the one-hop dig exemption (hard-checked at grant time) and for
  // roster generation dedup.
  const renovationLinks = new Map()
  for (const run of runs) {
    if (!run?.runId) continue
    renovationLinks.set(run.runId, {
      runId: run.runId,
      renovationOf: run.renovationOf || null,
      completed: isCompletedRun(run),
      terminal: isTerminalRun(run)
    })
  }
  const completed = runs
    .filter(isCompletedRun)
    .filter(run => boundsFinite(run.bounds))
  // Lineage dedup: a COMPLETED run superseded by a COMPLETED renovation does
  // not enroll separately — the latest generation of the renovationOf chain
  // owns the single protected region for that space. An ABANDONED or still
  // active renovation does NOT supersede: the roster keeps (falls back to)
  // the old building.
  const supersededByCompletedRenovation = new Set(
    completed
      .filter(run => run.renovationOf)
      .map(run => run.renovationOf)
  )
  // Active (non-terminal) renovation runs temporarily extend the region of
  // the building they renovate, so the half-renovated site stays protected
  // against third-party digging throughout the renovation.
  const activeRenovationsByTarget = new Map()
  for (const run of runs) {
    if (!run?.renovationOf || isTerminalRun(run) || !boundsFinite(run.bounds)) continue
    const list = activeRenovationsByTarget.get(run.renovationOf) || []
    list.push(run)
    activeRenovationsByTarget.set(run.renovationOf, list)
  }
  const regions = completed
    .filter(run => !supersededByCompletedRenovation.has(run.runId))
    .map(run => {
      let bounds = run.bounds
      const activeRenovations = activeRenovationsByTarget.get(run.runId) || []
      for (const renovation of activeRenovations) {
        bounds = unionBounds(bounds, renovation.bounds)
      }
      return {
        runId: run.runId,
        blueprintId: run.blueprintId || null,
        activeRenovationRunIds: activeRenovations.map(renovation => renovation.runId),
        bounds: {
          minX: bounds.minX - margin,
          maxX: bounds.maxX + margin,
          minY: bounds.minY - margin,
          maxY: bounds.maxY + margin,
          minZ: bounds.minZ - margin,
          maxZ: bounds.maxZ + margin
        }
      }
    })
  regionCache = { filePath, mtimeMs: stat.mtimeMs, margin, regions, renovationLinks }
  return regionCache
}

function loadProtectedRegions(options = {}) {
  return loadProtectedState(options).regions
}

function positionInBounds(position, bounds) {
  return position.x >= bounds.minX && position.x <= bounds.maxX &&
    position.y >= bounds.minY && position.y <= bounds.maxY &&
    position.z >= bounds.minZ && position.z <= bounds.maxZ
}

function findProtectedRegionAt(position, options = {}) {
  if (!position || !Number.isFinite(position.x)) return null
  const regions = options.regions || loadProtectedRegions(options)
  return regions.find(region => positionInBounds(position, region.bounds)) || null
}

function resolveGuardOptions(context, options = {}) {
  return {
    ...options,
    runStorePath: options.runStorePath || context?.protectedBuildingRunStorePath || undefined
  }
}

// Renovation exemption, HARD-CHECKED at grant time (approval condition 2 in
// docs/RENOVATION_FLOW_DESIGN.md): the active run may dig inside the region
// of the building it renovates ONLY via a DIRECT renovationOf pointer read
// from the run store — exactly one hop, never transitive. Any longer chain is
// rejected and logged. Returns { granted, via, rejectedChainHops }.
function renovationExemption(exemptRunId, region, renovationLinks) {
  if (!exemptRunId || !region || !renovationLinks) return { granted: false }
  const activeRun = renovationLinks.get(exemptRunId)
  if (!activeRun?.renovationOf) return { granted: false }
  if (activeRun.terminal) return { granted: false }
  if (activeRun.renovationOf === region.runId) {
    return { granted: true, via: 'renovationOf' }
  }
  // Not a direct pointer. Walk the chain purely to DETECT (and loudly log) a
  // transitive exemption attempt — it is never granted.
  let cursor = renovationLinks.get(activeRun.renovationOf)
  let hops = 1
  while (cursor?.renovationOf && hops < 16) {
    hops += 1
    if (cursor.renovationOf === region.runId) {
      return { granted: false, rejectedChainHops: hops }
    }
    cursor = renovationLinks.get(cursor.renovationOf)
  }
  return { granted: false }
}

// Returns { allowed, region, exempted }. Exemption is granted ONLY when the
// caller's runId matches the region's runId (a construction run may touch its
// own building during reconciliation/repair; it may never touch another
// completed building), or when the caller is a live RENOVATION run whose
// renovationOf points DIRECTLY at the region's run (one hop, hard-checked).
function checkProtectedBuildingDig(context, position, options = {}) {
  const guardOptions = resolveGuardOptions(context, options)
  const state = loadProtectedState(guardOptions)
  const region = findProtectedRegionAt(position, { ...guardOptions, regions: options.regions || state.regions })
  if (!region) return { allowed: true, region: null, exempted: false }
  const source = options.source || 'unknown'
  const exemptRunId = options.exemptRunId || context?.activeConstructionRunId || null
  const pos = `${position.x},${position.y},${position.z}`
  if (exemptRunId && exemptRunId === region.runId) {
    context?.logger?.log?.(`[PROTECTED_BUILDING_DIG_EXEMPT] pos=${pos} runId=${region.runId} blueprintId=${region.blueprintId || 'unknown'} source=${source} exemptRunId=${exemptRunId}`)
    return { allowed: true, region, exempted: true }
  }
  const renovation = renovationExemption(exemptRunId, region, state.renovationLinks)
  if (renovation.granted) {
    context?.logger?.log?.(`[PROTECTED_BUILDING_DIG_EXEMPT] pos=${pos} runId=${region.runId} blueprintId=${region.blueprintId || 'unknown'} source=${source} exemptRunId=${exemptRunId} via=renovationOf`)
    return { allowed: true, region, exempted: true, via: 'renovationOf' }
  }
  if (renovation.rejectedChainHops) {
    context?.logger?.log?.(`[PROTECTED_BUILDING_RENOVATION_CHAIN_REJECTED] pos=${pos} runId=${region.runId} exemptRunId=${exemptRunId} chainHops=${renovation.rejectedChainHops} — renovation exemption is one hop only, transitive chains are never granted`)
  }
  context?.logger?.log?.(`[PROTECTED_BUILDING_DIG_BLOCKED] pos=${pos} runId=${region.runId} blueprintId=${region.blueprintId || 'unknown'} source=${source} exemptRunId=${exemptRunId || 'none'}`)
  return { allowed: false, region, exempted: false }
}

// Pathfinder-level avoidance: penalty functions for Movements.exclusionAreasBreak
// so route planning never plans to break protected blocks (instead of walking
// up and being refused by the dig guard).
function protectedBreakExclusions(context, options = {}) {
  const guardOptions = resolveGuardOptions(context, options)
  const exemptRunId = options.exemptRunId || context?.activeConstructionRunId || null
  return [block => {
    if (!block?.position) return 0
    const state = loadProtectedState(guardOptions)
    const region = findProtectedRegionAt(block.position, { ...guardOptions, regions: state.regions })
    if (!region) return 0
    if (exemptRunId && exemptRunId === region.runId) return 0
    if (renovationExemption(exemptRunId, region, state.renovationLinks).granted) return 0
    return Infinity
  }]
}

function resetProtectedRegionCache() {
  regionCache = { filePath: null, mtimeMs: -1, margin: null, regions: [], renovationLinks: new Map() }
}

module.exports = {
  DEFAULT_MARGIN,
  loadProtectedRegions,
  findProtectedRegionAt,
  checkProtectedBuildingDig,
  protectedBreakExclusions,
  resetProtectedRegionCache
}
