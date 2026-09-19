const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const { transformHorizontalBlockState } = require('../utils/block-state-transform')
const { modernizeLegacyBlock } = require('../utils/legacy-block-compat')

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
const SAFE_BLOCK_REPLACEMENTS = Object.freeze({
  campfire: 'lantern',
  soul_campfire: 'lantern',
  fire: 'air',
  soul_fire: 'air',
  lava: 'air',
  tnt: 'air',
  magma_block: 'stone',
  respawn_anchor: 'stone',
  scaffolding: 'ladder'
})
const SAFE_HANGING_DECORATION_SUPPORT_REPLACEMENT = 'stone'
const DEFAULT_MAX_VOLUME = 90000

class CommunityStructureImporter {
  constructor(options = {}) {
    this.options = {
      maxVolume: options.maxVolume || DEFAULT_MAX_VOLUME,
      includeAir: options.includeAir === true,
      ...options
    }
  }

  async importFile(filePath, source = {}, options = {}) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: `community_structure_file_missing:${filePath || 'unknown'}` }
    }

    const format = detectFormat(filePath, source)
    const buffer = fs.readFileSync(filePath)
    const cacheHash = sha256(buffer)
    const config = { ...this.options, ...options }

    let imported
    try {
      if (format === 'litematic') imported = await this.importLitematic(buffer, source, config)
      else if (format === 'schem') imported = await this.importSpongeSchem(buffer, source, config)
      else if (format === 'schematic') imported = await this.importClassicSchematic(buffer, source, config)
      else if (format === 'nbt') imported = await this.importGenericNbt(buffer, source, config)
      else if (format === 'json') imported = await this.importStandardizedJson(buffer, source, config)
      else return { ok: false, error: `unsupported_community_structure_format:${format}` }
    } catch (error) {
      return { ok: false, error: `community_structure_parse_error:${trimError(error)}` }
    }

    if (!imported.ok) {
      return {
        ...imported,
        source,
        format,
        cacheHash
      }
    }

    return {
      ok: true,
      source,
      format,
      cacheHash,
      metadata: imported.metadata,
      blueprint: annotateBlueprint(imported.blueprint, {
        source,
        format,
        cacheHash,
        localSourcePath: path.resolve(filePath),
        importedAt: new Date().toISOString(),
        parser: 'community-structure-importer'
      })
    }
  }

  async importLitematic(buffer, source, config) {
    const parsed = await nbt.parse(buffer)
    const root = nbt.simplify(parsed.parsed)
    if (!root?.Regions || !root.Metadata) return { ok: false, error: 'invalid_litematic_missing_regions_or_metadata' }

    const regions = Object.entries(root.Regions)
    if (!regions.length) return { ok: false, error: 'invalid_litematic_empty_regions' }

    const blocks = []
    const regionSummaries = []
    for (const [regionName, region] of regions) {
      const decoded = decodeLitematicRegion(regionName, region, config)
      if (!decoded.ok) return decoded
      blocks.push(...decoded.blocks)
      regionSummaries.push(decoded.summary)
    }

    const blueprint = normalizeBlueprint({
      name: safeBlueprintName(source.buildTitle || root.Metadata.Name || source.id || 'community_litematic'),
      description: source.description || root.Metadata.Description || 'Imported community Litematica structure',
      metadata: {
        sourceKind: 'real_community_import',
        sourceId: source.id || null,
        style: source.style || source.category || null,
        buildingType: source.buildingType || source.category || null,
        category: source.category || null,
        author: root.Metadata.Author || source.author || null,
        minecraftDataVersion: root.MinecraftDataVersion || null,
        minecraftVersion: source.minecraftVersion || `dataVersion:${root.MinecraftDataVersion || 'unknown'}`,
        structureFileFormat: 'litematic',
        litematicVersion: root.Version || null,
        litematicSubVersion: root.SubVersion || null,
        originalMetadata: root.Metadata,
        regionSummaries,
        sanitizedBlockCount: countSanitized(blocks),
        skipScaffolding: true
      },
      blocks
    })

    return {
      ok: true,
      metadata: {
        format: 'litematic',
        minecraftDataVersion: root.MinecraftDataVersion || null,
        litematicVersion: root.Version || null,
        author: root.Metadata.Author || source.author || null,
        title: source.buildTitle || root.Metadata.Name || null,
        regionCount: regions.length,
        totalBlocks: root.Metadata.TotalBlocks || blocks.length,
        totalVolume: root.Metadata.TotalVolume || null
      },
      blueprint
    }
  }

  async importSpongeSchem(buffer, source, config) {
    if (isLikelyJson(buffer)) {
      return this.importStandardizedJson(buffer, source, config)
    }
    const parsed = await nbt.parse(buffer)
    const root = nbt.simplify(parsed.parsed)
    const width = Number(root.Width)
    const height = Number(root.Height)
    const length = Number(root.Length)
    if (![width, height, length].every(Number.isFinite)) return { ok: false, error: 'invalid_schem_missing_dimensions' }
    if (width * height * length > config.maxVolume) return { ok: false, error: `community_structure_too_large:${width * height * length}` }
    if (!root.Palette || !root.BlockData) return { ok: false, error: 'invalid_schem_missing_palette_or_blockdata' }

    const palette = Object.entries(root.Palette)
      .sort((a, b) => a[1] - b[1])
      .map(([state]) => parseBlockStateString(state))
    const ids = decodeVarintBlockData(root.BlockData, width * height * length)
    const blocks = []
    for (let index = 0; index < ids.length; index++) {
      const x = index % width
      const z = Math.floor(index / width) % length
      const y = Math.floor(index / (width * length))
      const blockState = palette[ids[index]] || parseBlockStateString('minecraft:air')
      pushImportedBlock(blocks, x, y, z, blockState, config)
    }

    const blueprint = normalizeBlueprint({
      name: safeBlueprintName(source.buildTitle || root.Metadata?.Name || source.id || 'community_schem'),
      description: source.description || 'Imported community Sponge schematic',
      metadata: {
        sourceKind: 'real_community_import',
        sourceId: source.id || null,
        style: source.style || source.category || null,
        buildingType: source.buildingType || source.category || null,
        category: source.category || null,
        author: source.author || null,
        minecraftDataVersion: root.DataVersion || null,
        minecraftVersion: source.minecraftVersion || `dataVersion:${root.DataVersion || 'unknown'}`,
        structureFileFormat: 'schem',
        schemVersion: root.Version || null,
        sanitizedBlockCount: countSanitized(blocks),
        skipScaffolding: true
      },
      blocks
    })
    return { ok: true, metadata: { format: 'schem', paletteSize: palette.length }, blueprint }
  }

  async importGenericNbt(buffer, source, config) {
    const parsed = await nbt.parse(buffer)
    const root = nbt.simplify(parsed.parsed)
    if (root?.size && root?.blocks && root?.palette) {
      return this.importStructureNbt(root, source, config)
    }
    return { ok: false, error: 'unsupported_generic_nbt_structure' }
  }

  async importStandardizedJson(buffer, source, config) {
    const provenance = source.standardizedJsonFromCommunityFile || source.standardizedJson?.provenance
    if (!provenance) {
      return { ok: false, error: 'community_structure_json_without_real_file_provenance' }
    }

    const root = JSON.parse(buffer.toString('utf8'))
    const width = Number(root.width ?? root.size?.[0] ?? root.size?.x)
    const height = Number(root.height ?? root.size?.[1] ?? root.size?.y)
    const length = Number(root.length ?? root.size?.[2] ?? root.size?.z)
    if (![width, height, length].every(Number.isFinite)) return { ok: false, error: 'invalid_json_structure_missing_dimensions' }
    if (width * height * length > config.maxVolume) return { ok: false, error: `community_structure_too_large:${width * height * length}` }

    const palette = normalizeJsonPalette(root.palette || root.Palette || [])
    const blocks = []
    for (const entry of root.blocks || root.Blocks || []) {
      const parsed = parseJsonBlockEntry(entry)
      if (!parsed) continue
      const blockState = palette.get(String(parsed.state)) || parsed.state || { type: 'air', states: {} }
      pushImportedBlock(blocks, parsed.x, parsed.y, parsed.z, blockState, config)
    }

    const blueprint = normalizeBlueprint({
      name: safeBlueprintName(source.buildTitle || root.name || source.id || 'community_json'),
      description: source.description || root.metadata?.description || 'Imported standardized community structure JSON',
      metadata: {
        sourceKind: 'real_community_import',
        sourceId: source.id || null,
        style: source.style || source.category || null,
        buildingType: source.buildingType || source.category || null,
        category: source.category || null,
        author: root.metadata?.author || source.author || null,
        minecraftVersion: source.minecraftVersion || root.metadata?.minecraftVersion || 'standardized_json',
        structureFileFormat: 'json',
        standardizedJsonProvenance: provenance,
        originalMetadata: root.metadata || null,
        sanitizedBlockCount: countSanitized(blocks),
        skipScaffolding: true
      },
      blocks
    })

    return {
      ok: true,
      metadata: {
        format: 'json',
        author: root.metadata?.author || source.author || null,
        title: source.buildTitle || root.name || null,
        paletteSize: palette.size,
        totalBlocks: blocks.length
      },
      blueprint
    }
  }

  importStructureNbt(root, source, config) {
    const size = Array.isArray(root.size) ? root.size : [root.size.x, root.size.y, root.size.z]
    const [width, height, length] = size.map(Number)
    if (![width, height, length].every(Number.isFinite)) return { ok: false, error: 'invalid_nbt_missing_dimensions' }
    if (width * height * length > config.maxVolume) return { ok: false, error: `community_structure_too_large:${width * height * length}` }
    const palette = root.palette.map(entry => ({
      type: normalizeBlockName(entry.Name || entry.name),
      states: entry.Properties || entry.properties || {}
    }))
    const blocks = []
    for (const entry of root.blocks || []) {
      const state = palette[entry.state]
      if (!state) continue
      const [x, y, z] = entry.pos || [entry.x, entry.y, entry.z]
      pushImportedBlock(blocks, x, y, z, state, config)
    }
    const blueprint = normalizeBlueprint({
      name: safeBlueprintName(source.buildTitle || source.id || 'community_nbt'),
      description: source.description || 'Imported community structure NBT',
      metadata: {
        sourceKind: 'real_community_import',
        sourceId: source.id || null,
        style: source.style || source.category || null,
        buildingType: source.buildingType || source.category || null,
        category: source.category || null,
        author: source.author || null,
        minecraftDataVersion: root.DataVersion || root.dataVersion || null,
        minecraftVersion: source.minecraftVersion || `dataVersion:${root.DataVersion || root.dataVersion || 'unknown'}`,
        structureFileFormat: 'nbt',
        sanitizedBlockCount: countSanitized(blocks),
        skipScaffolding: true
      },
      blocks
    })
    return { ok: true, metadata: { format: 'nbt', paletteSize: palette.length }, blueprint }
  }

  async importClassicSchematic(buffer, source, config) {
    const uncompressed = zlib.gunzipSync(buffer)
    const root = nbt.simplify(nbt.parseUncompressed(uncompressed, 'big', { noArraySizeCheck: true }))
    const width = Number(root.Width)
    const height = Number(root.Height)
    const length = Number(root.Length)
    if (![width, height, length].every(Number.isFinite)) return { ok: false, error: 'invalid_schematic_missing_dimensions' }
    if (width * height * length > config.maxVolume) return { ok: false, error: `community_structure_too_large:${width * height * length}` }
    if (!root.Blocks || !root.Data) return { ok: false, error: 'invalid_schematic_missing_blocks_or_data' }

    const blocks = []
    for (let index = 0; index < root.Blocks.length; index++) {
      const x = index % width
      const z = Math.floor(index / width) % length
      const y = Math.floor(index / (width * length))
      const id = Number(root.Blocks[index]) & 0xff
      const legacyData = Number(root.Data[index]) & 0x0f
      const type = legacyBlockName(id, legacyData)
      pushImportedBlock(blocks, x, y, z, {
        type,
        states: legacyBlockStates(id, legacyData),
        rawName: `legacy:${id}:${legacyData}`
      }, config)
    }

    const blueprint = normalizeBlueprint({
      name: safeBlueprintName(source.buildTitle || source.id || 'community_schematic'),
      description: source.description || 'Imported community classic schematic',
      metadata: {
        sourceKind: 'real_community_import',
        sourceId: source.id || null,
        style: source.style || source.category || null,
        buildingType: source.buildingType || source.category || null,
        category: source.category || null,
        author: source.author || null,
        minecraftVersion: source.minecraftVersion || 'legacy_schematic',
        structureFileFormat: 'schematic',
        materials: root.Materials || null,
        sanitizedBlockCount: countSanitized(blocks),
        skipScaffolding: true
      },
      blocks
    })
    return { ok: true, metadata: { format: 'schematic', width, height, length }, blueprint }
  }
}

function decodeLitematicRegion(regionName, region, config) {
  const sizeRaw = region.Size
  const position = region.Position || { x: 0, y: 0, z: 0 }
  if (!sizeRaw || !region.BlockStatePalette || !region.BlockStates) {
    return { ok: false, error: `invalid_litematic_region:${regionName}` }
  }
  const size = {
    x: Math.abs(Number(sizeRaw.x)),
    y: Math.abs(Number(sizeRaw.y)),
    z: Math.abs(Number(sizeRaw.z))
  }
  const volume = size.x * size.y * size.z
  if (volume > config.maxVolume) return { ok: false, error: `community_structure_too_large:${volume}` }

  const palette = region.BlockStatePalette.map(entry => ({
    type: normalizeBlockName(entry.Name),
    states: entry.Properties || {},
    rawName: entry.Name || 'minecraft:air'
  }))
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))))
  const blocks = []
  const transform = {
    mirrorX: direction(sizeRaw.x) < 0,
    mirrorZ: direction(sizeRaw.z) < 0
  }
  for (let index = 0; index < volume; index++) {
    const paletteIndex = readPackedLong(region.BlockStates, index, bits)
    const blockState = palette[paletteIndex] || { type: 'air', states: {}, rawName: 'minecraft:air' }
    const x = index % size.x
    const z = Math.floor(index / size.x) % size.z
    const y = Math.floor(index / (size.x * size.z))
    const rawPosition = transformRegionPosition({ x, y, z }, sizeRaw, position)
    pushImportedBlock(
      blocks,
      rawPosition.x,
      rawPosition.y,
      rawPosition.z,
      transformBlockStateForRegionDirection(blockState, transform),
      config,
      { region: regionName }
    )
  }

  return {
    ok: true,
    blocks,
    summary: {
      name: regionName,
      size,
      position,
      transform,
      volume,
      paletteSize: palette.length,
      nonAirBlocks: blocks.filter(block => !AIR_BLOCKS.has(block.type)).length
    }
  }
}

function pushImportedBlock(blocks, x, y, z, blockState, config, extra = {}) {
  const type = normalizeBlockName(blockState.type || blockState.Name || blockState.name)
  const sanitizedType = SAFE_BLOCK_REPLACEMENTS[type] || type
  const isAir = AIR_BLOCKS.has(sanitizedType)
  if (isAir && !config.includeAir) return
  blocks.push({
    x: Number(x),
    y: Number(y),
    z: Number(z),
    type: sanitizedType,
    states: { ...(blockState.states || blockState.Properties || {}) },
    orientation: orientationFromStates(blockState.states || blockState.Properties || {}),
    rawBlockState: blockState.rawName || blockState.Name || blockState.name || type,
    sanitizedFrom: sanitizedType !== type ? type : undefined,
    role: inferRole(type),
    phase: inferPhase(type),
    ...extra
  })
}

function normalizeBlueprint(input) {
  const repairedInputBlocks = repairSanitizedSupportBlocks(input.blocks || [])
  const bounds = boundsFor(repairedInputBlocks)
  const blocks = repairedInputBlocks
    .map(block => ({
      ...block,
      x: Math.round(block.x - bounds.minX),
      y: Math.round(block.y - bounds.minY),
      z: Math.round(block.z - bounds.minZ)
    }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z))
  return {
    name: input.name,
    description: input.description,
    origin: { x: 0, y: 0, z: 0 },
    metadata: {
      ...(input.metadata || {}),
      normalizedFromBounds: bounds
    },
    blocks
  }
}

function transformBlockStateForRegionDirection(blockState = {}, transform = {}) {
  return transformHorizontalBlockState(blockState, transform)
}

function transformRegionPosition(position = {}, sizeRaw = {}, regionPosition = {}) {
  return {
    x: Number(regionPosition.x || 0) + Number(position.x || 0) * direction(sizeRaw.x),
    y: Number(regionPosition.y || 0) + Number(position.y || 0) * direction(sizeRaw.y),
    z: Number(regionPosition.z || 0) + Number(position.z || 0) * direction(sizeRaw.z)
  }
}

function repairSanitizedSupportBlocks(blocks = []) {
  const byPosition = new Map(blocks.map(block => [blockPositionKey(block), block]))
  return blocks.map(block => {
    if (!isSanitizedCampfireLantern(block)) return block
    const below = byPosition.get(blockPositionKey({ x: block.x, y: block.y - 1, z: block.z }))
    if (!isHangingLanternBlock(below)) return block
    return {
      ...block,
      type: SAFE_HANGING_DECORATION_SUPPORT_REPLACEMENT,
      states: {},
      orientation: {},
      safeSupportReplacement: true
    }
  })
}

function isSanitizedCampfireLantern(block) {
  return block?.type === 'lantern' &&
    (block.sanitizedFrom === 'campfire' || block.sanitizedFrom === 'soul_campfire')
}

function isHangingLanternBlock(block) {
  return block?.type === 'lantern' && String(block.states?.hanging || '').toLowerCase() === 'true'
}

function blockPositionKey(block) {
  return `${Number(block?.x)},${Number(block?.y)},${Number(block?.z)}`
}

function countSanitized(blocks) {
  return blocks.filter(block => block.sanitizedFrom).length
}

function annotateBlueprint(blueprint, imported) {
  return {
    ...blueprint,
    metadata: {
      ...(blueprint.metadata || {}),
      import: imported,
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      allowedFaithfulTransforms: [
        'translate',
        'rotate_90_180_270',
        'safe_mirror',
        'one_to_one_material_replacement',
        'safe_unsafe_block_support_replacement',
        'foundation_fill',
        'safe_fluid_handling'
      ]
    }
  }
}

function decodeVarintBlockData(bytes, expectedCount) {
  const data = Buffer.from(bytes)
  const ids = []
  let value = 0
  let position = 0
  for (const byte of data) {
    value |= (byte & 0x7f) << position
    if ((byte & 0x80) === 0) {
      ids.push(value)
      value = 0
      position = 0
      if (ids.length >= expectedCount) break
      continue
    }
    position += 7
  }
  return ids
}

function readPackedLong(longs, index, bits) {
  const bitIndex = BigInt(index * bits)
  const longIndex = Number(bitIndex / 64n)
  const offset = Number(bitIndex % 64n)
  const mask = (1n << BigInt(bits)) - 1n
  let value = BigInt.asUintN(64, BigInt(longs[longIndex] || 0n)) >> BigInt(offset)
  const spill = offset + bits - 64
  if (spill > 0) {
    value |= BigInt.asUintN(64, BigInt(longs[longIndex + 1] || 0n)) << BigInt(bits - spill)
  }
  return Number(value & mask)
}

function parseBlockStateString(value) {
  const text = String(value || 'minecraft:air')
  const match = text.match(/^([a-z0-9_:]+)(?:\[(.*)\])?$/)
  const name = match ? match[1] : text
  const states = {}
  if (match?.[2]) {
    for (const pair of match[2].split(',')) {
      const [key, stateValue] = pair.split('=')
      if (key) states[key] = stateValue
    }
  }
  return {
    type: normalizeBlockName(name),
    states,
    rawName: text
  }
}

function normalizeJsonPalette(palette) {
  const result = new Map()
  if (Array.isArray(palette)) {
    palette.forEach((entry, index) => {
      result.set(String(index), jsonPaletteEntry(entry))
    })
    return result
  }
  for (const [keyValue, entry] of Object.entries(palette || {})) {
    result.set(String(keyValue), jsonPaletteEntry(entry))
  }
  return result
}

function jsonPaletteEntry(entry) {
  if (typeof entry === 'string') return parseBlockStateString(entry)
  return {
    type: normalizeBlockName(entry?.name || entry?.Name || entry?.type || 'air'),
    states: entry?.properties || entry?.Properties || entry?.states || {},
    rawName: entry?.rawName || entry?.name || entry?.Name || entry?.type || 'air'
  }
}

function parseJsonBlockEntry(entry) {
  if (Array.isArray(entry) && entry.length >= 4) {
    return { x: Number(entry[0]), y: Number(entry[1]), z: Number(entry[2]), state: entry[3] }
  }
  if (entry && typeof entry === 'object') {
    const pos = entry.pos || entry.position || entry
    return {
      x: Number(pos.x ?? pos[0]),
      y: Number(pos.y ?? pos[1]),
      z: Number(pos.z ?? pos[2]),
      state: entry.state ?? entry.palette ?? entry.block ?? entry.type ?? entry.name
    }
  }
  return null
}

function isLikelyJson(buffer) {
  return Buffer.isBuffer(buffer) && buffer.slice(0, 64).toString('utf8').trimStart().startsWith('{')
}

function trimError(error) {
  return String(error?.message || error || 'unknown').replace(/\s+/g, ' ').slice(0, 240)
}

function legacyBlockName(id, legacyData = 0) {
  const entry = LEGACY_BLOCKS[id]
  const name = typeof entry === 'function'
    ? entry(legacyData)
    : entry || `legacy_block_${id}`
  return modernizeLegacyBlock(name, {
    legacyId: String(id),
    legacyData: String(legacyData)
  }).blockName
}

function legacyBlockStates(id, legacyData) {
  const type = legacyBlockName(id, legacyData)
  const states = {
    legacyId: String(id),
    legacyData: String(legacyData)
  }

  if (id === 144) return modernizeLegacyBlock(type, states).states

  if (type.endsWith('_stairs')) return { ...states, ...legacyStairStates(legacyData) }
  if (type.endsWith('_door')) return { ...states, ...legacyDoorStates(legacyData) }
  if (type.endsWith('_slab')) return { ...states, ...legacySlabStates(legacyData) }
  if (type.endsWith('_trapdoor')) return { ...states, ...legacyTrapdoorStates(legacyData) }
  if (type === 'ladder') return { ...states, facing: legacyLadderFacing(legacyData) }
  return states
}

function legacyStairStates(data) {
  const facingByData = ['east', 'west', 'south', 'north']
  return {
    facing: facingByData[data & 0x3] || 'north',
    half: (data & 0x4) ? 'top' : 'bottom'
  }
}

function legacyDoorStates(data) {
  if (data & 0x8) {
    return {
      half: 'upper',
      hinge: (data & 0x1) ? 'right' : 'left',
      powered: String(Boolean(data & 0x2))
    }
  }
  const facingByData = ['east', 'south', 'west', 'north']
  return {
    half: 'lower',
    facing: facingByData[data & 0x3] || 'north',
    open: String(Boolean(data & 0x4))
  }
}

function legacySlabStates(data) {
  return {
    type: (data & 0x8) ? 'top' : 'bottom',
    legacyVariant: String(data & 0x7)
  }
}

function legacyTrapdoorStates(data) {
  const facingByData = ['north', 'south', 'west', 'east']
  return {
    facing: facingByData[data & 0x3] || 'north',
    open: String(Boolean(data & 0x4)),
    half: (data & 0x8) ? 'top' : 'bottom'
  }
}

function legacyLadderFacing(data) {
  const facingByData = {
    2: 'north',
    3: 'south',
    4: 'west',
    5: 'east'
  }
  return facingByData[data] || 'north'
}

function orientationFromStates(states = {}) {
  const orientation = {}
  for (const key of ['facing', 'half', 'hinge', 'shape', 'open', 'axis', 'type', 'waterlogged']) {
    if (states[key] != null) orientation[key] = states[key]
  }
  return orientation
}

function inferRole(type) {
  if (type.includes('door') && !type.includes('trapdoor')) return 'door'
  if (type.includes('trapdoor')) return 'trapdoor'
  if (type.includes('stairs')) return 'stairs'
  if (type.includes('ladder')) return 'stairs'
  if (type.includes('glass')) return 'window'
  if (type.includes('bed')) return 'bed'
  if (type === 'chest' || type === 'trapped_chest') return 'chest'
  if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') return 'furnace'
  if (type === 'crafting_table') return 'crafting_table'
  if (type.includes('log') || type.includes('pillar')) return 'column'
  return undefined
}

function inferPhase(type) {
  if (type.includes('door')) return 'opening'
  if (type.includes('stairs') || type.includes('ladder')) return 'vertical_circulation'
  if (type.includes('glass')) return 'window'
  if (type.includes('slab') || type.includes('stairs')) return 'roof_or_detail'
  if (type.includes('log')) return 'column'
  return undefined
}

function normalizeBlockName(name) {
  const value = String(name || 'minecraft:air').replace(/^minecraft:/, '')
  return value.replace(/[^a-z0-9_]/g, '_')
}

function safeBlueprintName(value) {
  const normalized = normalizeBlockName(String(value || 'community_build').toLowerCase())
  return normalized || 'community_build'
}

function boundsFor(blocks) {
  if (!blocks.length) return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
  return blocks.reduce((bounds, block) => ({
    minX: Math.min(bounds.minX, block.x),
    minY: Math.min(bounds.minY, block.y),
    minZ: Math.min(bounds.minZ, block.z),
    maxX: Math.max(bounds.maxX, block.x),
    maxY: Math.max(bounds.maxY, block.y),
    maxZ: Math.max(bounds.maxZ, block.z)
  }), {
    minX: blocks[0].x,
    minY: blocks[0].y,
    minZ: blocks[0].z,
    maxX: blocks[0].x,
    maxY: blocks[0].y,
    maxZ: blocks[0].z
  })
}

function direction(value) {
  return Number(value) < 0 ? -1 : 1
}

function detectFormat(filePath, source = {}) {
  const explicit = String(source.structureFileFormat || '').replace(/^\./, '').toLowerCase()
  if (explicit) return explicit
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  return ext || 'unknown'
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

const LEGACY_BLOCKS = {
  0: 'air',
  1: 'stone',
  2: 'grass_block',
  3: 'dirt',
  4: 'cobblestone',
  5: 'oak_planks',
  9: 'water',
  12: 'sand',
  13: 'gravel',
  16: 'coal_ore',
  17: 'oak_log',
  18: 'oak_leaves',
  20: 'glass',
  24: 'sandstone',
  25: 'note_block',
  26: 'red_bed',
  33: 'piston',
  34: 'piston',
  35: 'white_wool',
  43: 'stone_slab',
  44: 'stone_slab',
  45: 'bricks',
  47: 'bookshelf',
  50: 'torch',
  51: 'fire',
  53: 'oak_stairs',
  54: 'chest',
  58: 'crafting_table',
  61: 'furnace',
  64: 'oak_door',
  65: 'ladder',
  67: 'cobblestone_stairs',
  68: 'oak_wall_sign',
  69: 'lever',
  70: 'stone_pressure_plate',
  71: 'iron_door',
  76: 'redstone_torch',
  77: 'stone_button',
  78: 'snow',
  79: 'ice',
  84: 'jukebox',
  85: 'oak_fence',
  87: 'netherrack',
  95: 'white_stained_glass',
  98: 'stone_bricks',
  101: 'iron_bars',
  102: 'glass_pane',
  109: 'stone_brick_stairs',
  118: 'cauldron',
  123: 'redstone_lamp',
  124: 'redstone_lamp',
  126: 'oak_slab',
  131: 'tripwire_hook',
  134: 'spruce_stairs',
  135: 'birch_stairs',
  136: 'jungle_stairs',
  139: 'cobblestone_wall',
  140: 'flower_pot',
  143: 'oak_button',
  144: 'skeleton_skull',
  145: 'anvil',
  152: 'redstone_block',
  155: 'quartz_block',
  156: 'quartz_stairs',
  160: legacyStainedGlassPane,
  164: 'dark_oak_stairs',
  166: 'barrier',
  167: 'iron_trapdoor',
  168: 'prismarine',
  169: 'sea_lantern',
  171: 'white_carpet',
  175: 'tall_grass',
  178: 'daylight_detector',
  179: 'red_sandstone',
  180: 'red_sandstone_stairs',
  182: 'red_sandstone_slab',
  184: 'dark_oak_fence_gate',
  188: 'spruce_fence',
  189: 'birch_fence',
  190: 'jungle_fence',
  191: 'dark_oak_fence',
  193: 'spruce_door',
  194: 'birch_door',
  195: 'jungle_door',
  196: 'acacia_door',
  197: 'dark_oak_door'
}

function legacyStainedGlassPane(data) {
  const colors = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black'
  ]
  return `${colors[data & 0xf] || 'white'}_stained_glass_pane`
}

module.exports = {
  CommunityStructureImporter,
  parseBlockStateString,
  _test: {
    legacyBlockName,
    legacyBlockStates,
    repairSanitizedSupportBlocks,
    transformBlockStateForRegionDirection,
    transformRegionPosition
  }
}
