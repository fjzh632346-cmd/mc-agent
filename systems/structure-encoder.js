const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])

class StructureEncoder {
  encode(input = {}, options = {}) {
    const blueprint = input.blueprint || input
    if (!blueprint || !Array.isArray(blueprint.blocks)) {
      return { ok: false, error: 'invalid_blueprint_for_structure_encoding' }
    }

    const blocks = blueprint.blocks
    const solid = blocks.filter(block => block && !isAir(block.type))
    if (!solid.length) {
      return {
        ok: true,
        blueprintName: blueprint.name || null,
        graph: { nodes: [], edges: [] },
        features: emptyFeatures(blocks.length),
        vector: emptyVector(),
        similarityReady: false
      }
    }

    const bounds = boundsFor(solid)
    const columns = buildColumns(solid)
    const heightMap = buildHeightMap(columns, bounds)
    const densityMap = buildDensityMap(solid, bounds, options.densityGridSize || 3)
    const blockDistribution = distribution(solid.map(block => block.type))
    const phaseCounts = countBy(solid.map(block => block.phase || 'none'))
    const roleCounts = countBy(solid.map(block => block.role || 'none'))
    const materialCounts = countBy(solid.map(block => block.type))
    const graph = buildGraph(solid, bounds)
    const uniqueColumnHeights = [...new Set([...columns.values()].map(column => column.height))].sort((a, b) => a - b)
    const roofLevels = [...new Set(solid
      .filter(block => String(block.phase || '').includes('roof') || String(block.role || '').includes('roof'))
      .map(block => block.y))]
      .sort((a, b) => a - b)
    const footprintArea = columns.size
    const bboxArea = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1)
    const footprintFill = bboxArea > 0 ? footprintArea / bboxArea : 0
    const heights = [...columns.values()].map(column => column.height)
    const heightVariance = variance(heights)
    const symmetryRatio = symmetryScore(columns, bounds)
    const facadeLayerCount = ['facade_base', 'facade_mid', 'facade_top'].filter(phase => phaseCounts[phase] > 0).length
    const windowGroups = countWindowGroups(solid)
    const materialDiversity = Object.keys(materialCounts).length
    const facadeComplexity = scoreFacadeComplexity({
      solidCount: solid.length,
      materialDiversity,
      windowGroups,
      facadeLayerCount,
      phaseCounts,
      roleCounts,
      graph
    })
    const volumeDistribution = graph.nodes
      .map(node => Number((node.blockCount / solid.length).toFixed(3)))
      .sort((a, b) => b - a)

    const features = {
      blockCount: blocks.length,
      solidCount: solid.length,
      blockDistribution,
      materialCounts,
      phaseCounts,
      roleCounts,
      shape: {
        bounds,
        footprintArea,
        bboxArea,
        footprintFill: round(footprintFill),
        width: bounds.maxX - bounds.minX + 1,
        height: bounds.maxY - bounds.minY + 1,
        depth: bounds.maxZ - bounds.minZ + 1,
        uniqueColumnHeights,
        roofLevels,
        silhouetteProfile: heightMap.profile
      },
      silhouette: {
        heightVariance: round(heightVariance),
        heightVarianceNormalized: round(clamp(heightVariance / 8)),
        footprintFill: round(footprintFill),
        roofLevelCount: roofLevels.length,
        columnHeightLevels: uniqueColumnHeights.length,
        protrusionRatio: round(clamp(1 - footprintFill))
      },
      heightMap: heightMap.cells,
      heightMapSummary: heightMap.summary,
      symmetryScore: symmetryRatio,
      symmetryRatio,
      densityMap,
      densitySummary: densitySummary(densityMap),
      heightVariance: round(heightVariance),
      volumeDistribution,
      facadeComplexity,
      facadeLayerCount,
      windowGroups,
      materialDiversity,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      flatness: round(uniqueColumnHeights.length <= 1 ? 1 : clamp(1 - heightVariance / 4))
    }

    return {
      ok: true,
      blueprintName: blueprint.name || null,
      graph,
      features,
      vector: featureVector(features),
      similarityReady: true
    }
  }

  similarity(a, b) {
    const left = Array.isArray(a?.vector) ? a.vector : this.encode(a).vector
    const right = Array.isArray(b?.vector) ? b.vector : this.encode(b).vector
    return cosineSimilarity(left, right)
  }
}

function buildGraph(blocks, bounds) {
  const entries = []
  const positionToNode = new Map()
  const nodeMap = new Map()

  blocks.forEach((block, index) => {
    const id = clusterKey(block, bounds, index)
    const node = nodeMap.get(id) || {
      id,
      label: id,
      blockCount: 0,
      materialCounts: {},
      phaseCounts: {},
      roleCounts: {},
      positions: [],
      bounds: null,
      centroid: { x: 0, y: 0, z: 0 }
    }
    node.blockCount += 1
    node.materialCounts[block.type] = (node.materialCounts[block.type] || 0) + 1
    node.phaseCounts[block.phase || 'none'] = (node.phaseCounts[block.phase || 'none'] || 0) + 1
    node.roleCounts[block.role || 'none'] = (node.roleCounts[block.role || 'none'] || 0) + 1
    node.positions.push({ x: block.x, y: block.y, z: block.z })
    node.bounds = expandBounds(node.bounds, block)
    node.centroid.x += block.x
    node.centroid.y += block.y
    node.centroid.z += block.z
    nodeMap.set(id, node)
    const positionKey = key(block.x, block.y, block.z)
    positionToNode.set(positionKey, id)
    entries.push({ block, nodeId: id })
  })

  const edgeMap = new Map()
  for (const { block, nodeId } of entries) {
    for (const delta of ADJACENT_DELTAS) {
      const otherId = positionToNode.get(key(block.x + delta.x, block.y + delta.y, block.z + delta.z))
      if (!otherId || otherId === nodeId) continue
      const edgeKey = [nodeId, otherId].sort().join('|')
      const existing = edgeMap.get(edgeKey) || { source: nodeId, target: otherId, adjacencyCount: 0 }
      existing.adjacencyCount += 1
      edgeMap.set(edgeKey, existing)
    }
  }

  const nodes = [...nodeMap.values()].map(node => ({
    ...node,
    positions: undefined,
    centroid: {
      x: round(node.centroid.x / node.blockCount),
      y: round(node.centroid.y / node.blockCount),
      z: round(node.centroid.z / node.blockCount)
    },
    features: {
      relativeVolume: round(node.blockCount / blocks.length),
      materialDiversity: Object.keys(node.materialCounts).length,
      height: node.bounds.maxY - node.bounds.minY + 1
    }
  })).sort((a, b) => b.blockCount - a.blockCount || a.id.localeCompare(b.id))

  return {
    nodes,
    edges: [...edgeMap.values()].sort((a, b) => b.adjacencyCount - a.adjacencyCount)
  }
}

function clusterKey(block, bounds, index) {
  if (block.volumeId) return `volume:${block.volumeId}`
  if (block.role === 'window' && block.groupId) return `window:${block.groupId}`
  if (block.phase && !['floor', 'wall', 'roof', 'none'].includes(block.phase)) return `phase:${block.phase}`
  if (block.role && ['tower', 'buttress', 'beam', 'facade_pier', 'porch_post', 'curtain_wall'].includes(block.role)) {
    return `role:${block.role}`
  }
  if (isPerimeter(block, bounds)) return `shell:${block.phase || block.type}`
  return `mass:${block.phase || block.type || index}`
}

function buildColumns(blocks) {
  const columns = new Map()
  for (const block of blocks) {
    const columnKey = key2(block.x, block.z)
    const column = columns.get(columnKey) || {
      x: block.x,
      z: block.z,
      minY: Infinity,
      maxY: -Infinity,
      count: 0,
      materials: {}
    }
    column.minY = Math.min(column.minY, block.y)
    column.maxY = Math.max(column.maxY, block.y)
    column.count += 1
    column.materials[block.type] = (column.materials[block.type] || 0) + 1
    columns.set(columnKey, column)
  }
  for (const column of columns.values()) column.height = column.maxY - column.minY + 1
  return columns
}

function buildHeightMap(columns, bounds) {
  const cells = []
  const profile = []
  for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
    const row = []
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const column = columns.get(key2(x, z))
      const height = column?.height || 0
      cells.push({ x, z, height, topY: column?.maxY ?? null, density: column?.count || 0 })
      row.push(height)
    }
    profile.push(row)
  }
  const heights = cells.map(cell => cell.height)
  return {
    cells,
    profile,
    summary: {
      min: Math.min(...heights),
      max: Math.max(...heights),
      mean: round(mean(heights)),
      variance: round(variance(heights))
    }
  }
}

function buildDensityMap(blocks, bounds, gridSize) {
  const grid = Array.from({ length: gridSize }, (_, z) =>
    Array.from({ length: gridSize }, (_, x) => ({ x, z, count: 0, density: 0 }))
  )
  const width = Math.max(1, bounds.maxX - bounds.minX + 1)
  const depth = Math.max(1, bounds.maxZ - bounds.minZ + 1)
  for (const block of blocks) {
    const gx = Math.min(gridSize - 1, Math.floor(((block.x - bounds.minX) / width) * gridSize))
    const gz = Math.min(gridSize - 1, Math.floor(((block.z - bounds.minZ) / depth) * gridSize))
    grid[gz][gx].count += 1
  }
  const maxCount = Math.max(1, ...grid.flat().map(cell => cell.count))
  for (const cell of grid.flat()) cell.density = round(cell.count / maxCount)
  return grid
}

function densitySummary(densityMap) {
  const densities = densityMap.flat().map(cell => cell.density)
  return {
    mean: round(mean(densities)),
    variance: round(variance(densities)),
    max: round(Math.max(...densities, 0))
  }
}

function symmetryScore(columns, bounds) {
  if (!columns.size) return 0
  const byColumn = (x, z) => columns.get(key2(x, z))
  const scores = []
  for (const column of columns.values()) {
    const mirrorX = bounds.maxX - (column.x - bounds.minX)
    const mirrorZ = bounds.maxZ - (column.z - bounds.minZ)
    scores.push(compareColumns(column, byColumn(mirrorX, column.z)))
    scores.push(compareColumns(column, byColumn(column.x, mirrorZ)))
  }
  return round(mean(scores))
}

function compareColumns(a, b) {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const heightScore = 1 - Math.min(1, Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1))
  const countScore = 1 - Math.min(1, Math.abs(a.count - b.count) / Math.max(a.count, b.count, 1))
  return round(heightScore * 0.65 + countScore * 0.35)
}

function scoreFacadeComplexity(input) {
  const windowRatio = clamp((input.windowGroups || 0) / 5)
  const layerRatio = clamp((input.facadeLayerCount || 0) / 3)
  const materialRatio = clamp((input.materialDiversity || 0) / 6)
  const nodeRatio = clamp((input.graph.nodes.length || 0) / 8)
  const columnRhythm = input.phaseCounts.column || input.roleCounts.beam || input.roleCounts.buttress || input.roleCounts.facade_pier ? 1 : 0
  return round(windowRatio * 0.25 + layerRatio * 0.25 + materialRatio * 0.18 + nodeRatio * 0.17 + columnRhythm * 0.15)
}

function featureVector(features) {
  const densityValues = features.densityMap.flat().map(cell => cell.density)
  const volumes = features.volumeDistribution.slice(0, 5)
  while (volumes.length < 5) volumes.push(0)
  return [
    clamp(features.heightVariance / 8),
    clamp((features.shape.uniqueColumnHeights.length || 0) / 6),
    clamp(1 - features.shape.footprintFill),
    clamp(features.facadeComplexity),
    clamp(features.symmetryRatio),
    clamp(features.materialDiversity / 8),
    clamp(features.windowGroups / 6),
    clamp(features.facadeLayerCount / 3),
    clamp(features.nodeCount / 8),
    clamp(features.edgeCount / 12),
    ...volumes.map(clamp),
    ...densityValues.map(clamp)
  ].map(round)
}

function cosineSimilarity(a = [], b = []) {
  const length = Math.max(a.length, b.length)
  let dot = 0
  let left = 0
  let right = 0
  for (let i = 0; i < length; i++) {
    const av = Number(a[i]) || 0
    const bv = Number(b[i]) || 0
    dot += av * bv
    left += av * av
    right += bv * bv
  }
  if (!left || !right) return 0
  return round(dot / (Math.sqrt(left) * Math.sqrt(right)))
}

function distribution(values) {
  const counts = countBy(values)
  const total = values.length || 1
  return Object.fromEntries(
    Object.entries(counts).map(([name, count]) => [name, round(count / total)])
  )
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})
}

function countWindowGroups(blocks) {
  const groups = new Set()
  let loose = 0
  for (const block of blocks) {
    if (block.role === 'window' && block.groupId) groups.add(block.groupId)
    else if (block.type === 'glass' || block.role === 'window') loose += 1
  }
  return groups.size + loose
}

function boundsFor(blocks) {
  return blocks.reduce((bounds, block) => expandBounds(bounds, block), null)
}

function expandBounds(bounds, block) {
  if (!bounds) {
    return { minX: block.x, maxX: block.x, minY: block.y, maxY: block.y, minZ: block.z, maxZ: block.z }
  }
  return {
    minX: Math.min(bounds.minX, block.x),
    maxX: Math.max(bounds.maxX, block.x),
    minY: Math.min(bounds.minY, block.y),
    maxY: Math.max(bounds.maxY, block.y),
    minZ: Math.min(bounds.minZ, block.z),
    maxZ: Math.max(bounds.maxZ, block.z)
  }
}

function emptyFeatures(blockCount) {
  return {
    blockCount,
    solidCount: 0,
    blockDistribution: {},
    materialCounts: {},
    phaseCounts: {},
    roleCounts: {},
    shape: {
      bounds: null,
      footprintArea: 0,
      bboxArea: 0,
      footprintFill: 0,
      width: 0,
      height: 0,
      depth: 0,
      uniqueColumnHeights: [],
      roofLevels: [],
      silhouetteProfile: []
    },
    silhouette: {
      heightVariance: 0,
      heightVarianceNormalized: 0,
      footprintFill: 0,
      roofLevelCount: 0,
      columnHeightLevels: 0,
      protrusionRatio: 0
    },
    heightMap: [],
    heightMapSummary: { min: 0, max: 0, mean: 0, variance: 0 },
    symmetryScore: 0,
    symmetryRatio: 0,
    densityMap: [],
    densitySummary: { mean: 0, variance: 0, max: 0 },
    heightVariance: 0,
    volumeDistribution: [],
    facadeComplexity: 0,
    facadeLayerCount: 0,
    windowGroups: 0,
    materialDiversity: 0,
    nodeCount: 0,
    edgeCount: 0,
    flatness: 1
  }
}

function emptyVector() {
  return Array.from({ length: 24 }, () => 0)
}

function mean(values = []) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function variance(values = []) {
  if (!values.length) return 0
  const avg = mean(values)
  return values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length
}

function isPerimeter(block, bounds) {
  return block.x === bounds.minX || block.x === bounds.maxX || block.z === bounds.minZ || block.z === bounds.maxZ
}

function isAir(type) {
  return AIR_BLOCKS.has(type)
}

function key(x, y, z) {
  return `${x},${y},${z}`
}

function key2(x, z) {
  return `${x},${z}`
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round((Number(value) || 0) * scale) / scale
}

const ADJACENT_DELTAS = Object.freeze([
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 }
])

module.exports = {
  StructureEncoder,
  cosineSimilarity
}
