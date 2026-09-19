const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { BlueprintLoader } = require('../systems/blueprint-loader')
const { BuildingHardGate } = require('../systems/building-hard-gate')
const { CommunityStructureImporter } = require('../systems/community-structure-importer')
const { FaithfulCommunityValidator } = require('../systems/faithful-community-validator')
const { StructureEncoder } = require('../systems/structure-encoder')
const {
  checkBlueprintVersionCompatibility,
  formatVersionCompatibilityFailure,
  resolveTargetVersion
} = require('../systems/blueprint-version-compatibility')

const ROOT = process.cwd()
const SOURCE_FILE = path.join(ROOT, 'data', 'community-builds', 'sources.json')
const CACHE_DIR = path.join(ROOT, 'data', 'community-builds', 'cache')
const RAW_DIR = path.join(CACHE_DIR, 'raw')
const BLUEPRINT_DIR = path.join(CACHE_DIR, 'blueprints')
const CHECKOUT_DIR = path.join(ROOT, '.tmp', 'community-sync')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  ensureDir(CACHE_DIR)
  ensureDir(RAW_DIR)
  ensureDir(BLUEPRINT_DIR)
  ensureDir(CHECKOUT_DIR)

  const manifest = JSON.parse(fs.readFileSync(args.sources || SOURCE_FILE, 'utf8'))
  // --only=<id,id,...> processes just those sources and MERGES the results
  // into the existing index, leaving every other entry (and its cached
  // blueprint file) byte-untouched. This is the safe path for adding new
  // structures while other entries back live construction runs whose
  // resume state pins the exact cached blueprint content.
  const onlyIds = String(args.only || '').split(',').map(value => value.trim()).filter(Boolean)
  const selectedSources = onlyIds.length
    ? (manifest.sources || []).filter(source => onlyIds.includes(source.id))
    : (manifest.sources || [])
  if (onlyIds.length && selectedSources.length !== onlyIds.length) {
    const found = new Set(selectedSources.map(source => source.id))
    throw new Error(`unknown_source_ids:${onlyIds.filter(id => !found.has(id)).join(',')}`)
  }
  // 目标服务器版本：素材里出现该版本不存在的方块 -> 导入期即拦下
  // （建造线第 6 轮的教训：门楼 226 块 1.21 方块直到真机发料才炸）
  const targetVersion = resolveTargetVersion(args.targetVersion)
  const importer = new CommunityStructureImporter({ maxVolume: Number(args.maxVolume) || 90000 })
  const hardGate = new BuildingHardGate()
  const faithfulValidator = new FaithfulCommunityValidator()
  const encoder = new StructureEncoder()
  const loader = new BlueprintLoader()

  const records = []
  const evidence = {
    onlineAttempted: true,
    sources: [],
    fetchedSamples: 0,
    downloadSuccessCount: 0,
    parseSuccessCount: 0,
    adaptedAfterHardGateFailureCount: 0,
    rejectedByHabitableHardGate: 0,
    rejectedByVersionOrFormat: 0,
    rejectedByTargetVersionRegistry: 0,
    validAfterDedupe: 0
  }

  for (const source of selectedSources) {
    evidence.sources.push({
      id: source.id,
      source: source.source,
      repository: source.repository,
      sourcePageIdentifier: source.sourcePageIdentifier,
      downloadPageIdentifier: source.downloadPageIdentifier || null
    })
    evidence.fetchedSamples += 1
    const record = await syncSource(source, { args, importer, hardGate, faithfulValidator, encoder, loader, targetVersion })
    if (record.download?.ok) evidence.downloadSuccessCount += 1
    if (record.importStatus === 'parsed' || record.importStatus === 'verified' || record.importStatus === 'verified_adapted' || record.importStatus === 'rejected_hard_gate' || record.importStatus === 'rejected_target_version') {
      evidence.parseSuccessCount += 1
    }
    if (record.importStatus === 'verified_adapted') evidence.adaptedAfterHardGateFailureCount += 1
    if (record.importStatus === 'rejected_hard_gate') evidence.rejectedByHabitableHardGate += 1
    if (record.importStatus === 'rejected_format_or_version') evidence.rejectedByVersionOrFormat += 1
    if (record.importStatus === 'rejected_target_version') evidence.rejectedByTargetVersionRegistry += 1
    records.push(record)
  }

  const previousIndex = onlyIds.length ? readExistingIndex() : null
  const mergedRecords = previousIndex
    ? mergeRecords(previousIndex, records, onlyIds)
    : records

  const seenHashes = new Set()
  const samples = []
  for (const record of mergedRecords) {
    if (!String(record.importStatus || '').startsWith('verified')) continue
    if (record.cacheHash && seenHashes.has(record.cacheHash)) continue
    if (record.cacheHash) seenHashes.add(record.cacheHash)
    samples.push(record)
  }
  evidence.validAfterDedupe = samples.length

  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    systemType: 'faithful community structure retrieval',
    training: false,
    retrieval: true,
    ranking: true,
    adaptation: false,
    evidence: previousIndex ? { ...previousIndex.evidence, lastPartialSync: evidence } : evidence,
    samples,
    rejected: mergedRecords.filter(record => !String(record.importStatus || '').startsWith('verified'))
  }

  fs.writeFileSync(path.join(CACHE_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  console.log(JSON.stringify({
    ok: true,
    cacheIndex: path.join(CACHE_DIR, 'index.json'),
    evidence,
    selectedSamples: samples.map(sample => ({
      id: sample.id,
      title: sample.buildTitle,
      author: sample.author,
      format: sample.structureFileFormat,
      cacheHash: sample.cacheHash,
      hardGate: sample.hardGate?.ok
    })),
    rejected: index.rejected.map(sample => ({
      id: sample.id,
      status: sample.importStatus,
      reason: sample.error || sample.hardGate?.failures?.join(',') || 'unknown'
    }))
  }, null, 2))
}

async function syncSource(source, tools) {
  const base = baseRecord(source)
  const checkout = path.join(CHECKOUT_DIR, safePathName(source.id))
  const downloaded = await resolveSourceFile(source, checkout, tools.args)
  base.download = downloaded
  if (!downloaded.ok) {
    return {
      ...base,
      importStatus: 'download_failed',
      error: downloaded.error
    }
  }

  const sourcePath = downloaded.filePath || path.join(downloaded.checkout, source.filePath)
  if (!fs.existsSync(sourcePath)) {
    return {
      ...base,
      importStatus: 'download_failed',
      error: `source_file_missing:${source.filePath}`
    }
  }

  const ext = path.extname(source.filePath || source.fileName || sourcePath)
  const rawCachePath = path.join(RAW_DIR, `${safePathName(source.id)}${ext}`)
  fs.copyFileSync(sourcePath, rawCachePath)
  const imported = await tools.importer.importFile(rawCachePath, source, {
    maxVolume: Number(source.importMaxVolume || tools.args.maxVolume) || 90000
  })
  if (!imported.ok) {
    return {
      ...base,
      importStatus: 'rejected_format_or_version',
      error: imported.error,
      cacheHash: imported.cacheHash || null,
      localRawPath: rawCachePath
    }
  }

  const validation = tools.loader.validateBlueprint(imported.blueprint)
  if (!validation.ok) {
    return {
      ...base,
      importStatus: 'rejected_format_or_version',
      error: validation.error,
      cacheHash: imported.cacheHash,
      localRawPath: rawCachePath
    }
  }

  const versionCompatibility = checkBlueprintVersionCompatibility(imported.blueprint, {
    targetVersion: source.targetVersion || tools.targetVersion
  })
  if (!versionCompatibility.ok) {
    return {
      ...base,
      importStatus: 'rejected_target_version',
      error: formatVersionCompatibilityFailure(versionCompatibility),
      versionCompatibility,
      cacheHash: imported.cacheHash,
      localRawPath: relative(rawCachePath)
    }
  }

  const hardGate = tools.hardGate.evaluateBlueprint(imported.blueprint, source)
  const allowAdaptation = tools.args.allowAdaptation === 'true'
  const adapted = allowAdaptation
    ? adaptImportedBlueprintIfNeeded(imported.blueprint, hardGate, source, tools.hardGate)
    : null
  const finalBlueprint = markFaithfulBlueprint(adapted?.blueprint || imported.blueprint, source)
  const finalHardGate = adapted?.hardGate || hardGate
  const faithfulGate = tools.faithfulValidator.validateBlueprint(finalBlueprint, source, {
    requireSourceMode: true
  })
  const encoding = tools.encoder.encode(finalBlueprint)
  const blueprintPath = path.join(BLUEPRINT_DIR, `${safePathName(source.id)}.json`)
  fs.writeFileSync(blueprintPath, `${JSON.stringify(finalBlueprint, null, 2)}\n`)

  return {
    ...base,
    author: imported.metadata.author || source.author || base.author,
    buildTitle: imported.metadata.title || source.buildTitle,
    minecraftVersion: imported.blueprint.metadata?.minecraftVersion || source.minecraftVersion || null,
    structureFileFormat: imported.format,
    metadataFetchedAt: new Date().toISOString(),
    cacheHash: imported.cacheHash,
    localRawPath: relative(rawCachePath),
    localBlueprintPath: relative(blueprintPath),
    sourceMode: finalBlueprint.metadata?.sourceMode || 'faithful-community-import',
    versionCompatibility,
    importStatus: finalHardGate.ok && faithfulGate.ok ? (adapted ? 'verified_adapted' : 'verified') : 'rejected_hard_gate',
    rawHardGate: hardGate.ok ? undefined : hardGate,
    adaptation: adapted?.adaptation || undefined,
    hardGate: finalHardGate,
    faithfulValidation: faithfulGate,
    encodingSummary: encoding.ok
      ? {
          blockCount: encoding.features.blockCount,
          solidCount: encoding.features.solidCount,
          facadeComplexity: encoding.features.facadeComplexity,
          symmetryScore: encoding.features.symmetryScore,
          heightVariance: encoding.features.heightVariance,
          footprintFill: encoding.features.shape?.footprintFill,
          nodeCount: encoding.features.nodeCount
        }
      : { error: encoding.error }
  }
}

async function resolveSourceFile(source, checkout, args = {}) {
  if (source.downloadUrl || source.downloadPageIdentifier) {
    return downloadSourceFile(source, checkout, args)
  }
  return checkoutSource(source, checkout)
}

function markFaithfulBlueprint(blueprint, source = {}) {
  return {
    ...blueprint,
    metadata: {
      ...(blueprint.metadata || {}),
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      ...(source.structureUse ? { structureUse: source.structureUse } : {}),
      ...(source.buildingCategory ? { buildingCategory: source.buildingCategory } : {})
    }
  }
}

function adaptImportedBlueprintIfNeeded(blueprint, hardGate, source, hardGateSystem) {
  let current = blueprint
  let currentGate = hardGate
  const steps = []

  const extracted = extractConfiguredRegion(current, source, hardGateSystem)
  if (extracted) {
    current = extracted.blueprint
    currentGate = extracted.hardGate
    steps.push(extracted.adaptation)
  }

  const functional = adaptUnusableFunctionalBlocks(current, currentGate, source, hardGateSystem)
  if (functional) {
    current = functional.blueprint
    currentGate = functional.hardGate
    steps.push(functional.adaptation)
  }

  if (!steps.length || !currentGate.ok) return null

  const adaptation = {
    type: 'real_community_structure_adaptation',
    sourceId: source.id,
    usesProceduralFallback: false,
    rawHardGateFailures: hardGate.ok ? [] : hardGate.failures,
    steps,
    note: 'Adapted only from downloaded community structure blocks; no synthetic or procedural fallback blueprint was used.'
  }

  return {
    blueprint: {
      ...current,
      metadata: {
        ...(current.metadata || {}),
        habitabilityAdaptation: adaptation
      }
    },
    hardGate: currentGate,
    adaptation
  }
}

function extractConfiguredRegion(blueprint, source, hardGateSystem) {
  const extraction = source.siteFitExtraction
  const box = extraction?.box
  if (!box) return null

  const normalizedFrom = blueprint.metadata?.normalizedFromBounds || { minX: 0, minY: 0, minZ: 0 }
  const normalizedBox = {
    minX: Number(box.minX) - Number(normalizedFrom.minX || 0),
    maxX: Number(box.maxX) - Number(normalizedFrom.minX || 0),
    minY: box.minY == null ? -Infinity : Number(box.minY) - Number(normalizedFrom.minY || 0),
    maxY: box.maxY == null ? Infinity : Number(box.maxY) - Number(normalizedFrom.minY || 0),
    minZ: Number(box.minZ) - Number(normalizedFrom.minZ || 0),
    maxZ: Number(box.maxZ) - Number(normalizedFrom.minZ || 0)
  }
  if (![normalizedBox.minX, normalizedBox.maxX, normalizedBox.minZ, normalizedBox.maxZ].every(Number.isFinite)) {
    return null
  }

  const extractedBlocks = blueprint.blocks.filter(block =>
    block.x >= normalizedBox.minX &&
    block.x <= normalizedBox.maxX &&
    block.y >= normalizedBox.minY &&
    block.y <= normalizedBox.maxY &&
    block.z >= normalizedBox.minZ &&
    block.z <= normalizedBox.maxZ
  )
  if (!extractedBlocks.length) return null

  const normalized = normalizeBlocksToLocalOrigin(extractedBlocks)
  const extracted = {
    ...blueprint,
    name: extraction.blueprintName || `${blueprint.name}_site_fit`,
    description: `${blueprint.description || blueprint.name} (site-fit extract from real community structure)`,
    metadata: {
      ...(blueprint.metadata || {}),
      sourceKind: 'real_community_import',
      siteFitExtraction: {
        type: extraction.type || 'coordinate_crop',
        coordinateSpace: extraction.coordinateSpace || 'source_structure_coordinates',
        sourceBox: box,
        normalizedBox,
        extractedBlockCount: normalized.length,
        reason: extraction.reason || 'fit accepted Minecraft build site while preserving real imported structure blocks'
      }
    },
    blocks: normalized
  }
  const extractedGate = hardGateSystem.evaluateBlueprint(extracted, source)
  return {
    blueprint: extracted,
    hardGate: extractedGate,
    adaptation: {
      type: 'extract_real_structure_region',
      sourceBox: box,
      extractedBlockCount: normalized.length,
      hardGateAfterStep: {
        ok: extractedGate.ok,
        failures: extractedGate.failures
      }
    }
  }
}

function adaptUnusableFunctionalBlocks(blueprint, hardGate, source, hardGateSystem) {
  if (hardGate.ok) return null
  const unusable = hardGate.metrics?.unusableFunctionalBlocks || []
  const onlyFunctionalFailures = hardGate.failures?.every(failure => failure === 'allFunctionalBlocksUsable')
  if (!onlyFunctionalFailures || !unusable.length) return null

  const removals = removalSetForUnusableFunctionalBlocks(blueprint, unusable)
  if (!removals.size) return null
  const adapted = {
    ...blueprint,
    metadata: {
      ...(blueprint.metadata || {}),
      sourceKind: 'real_community_import'
    },
    blocks: blueprint.blocks.filter(block => !removals.has(posKey(block)))
  }
  const adaptedGate = hardGateSystem.evaluateBlueprint(adapted, source)
  return {
    blueprint: adapted,
    hardGate: adaptedGate,
    adaptation: {
      type: 'remove_unusable_functional_blocks',
      removedFunctionalBlocks: [...removals.values()].map(entry => entry.block),
      hardGateAfterStep: {
        ok: adaptedGate.ok,
        failures: adaptedGate.failures
      }
    }
  }
}

function normalizeBlocksToLocalOrigin(blocks) {
  const bounds = blocks.reduce((result, block) => ({
    minX: Math.min(result.minX, block.x),
    minY: Math.min(result.minY, block.y),
    minZ: Math.min(result.minZ, block.z)
  }), {
    minX: blocks[0].x,
    minY: blocks[0].y,
    minZ: blocks[0].z
  })
  return blocks
    .map(block => ({
      ...block,
      x: Math.round(block.x - bounds.minX),
      y: Math.round(block.y - bounds.minY),
      z: Math.round(block.z - bounds.minZ)
    }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z))
}

function removalSetForUnusableFunctionalBlocks(blueprint, unusable) {
  const byPos = new Map(blueprint.blocks.map(block => [posKey(block), block]))
  const removals = new Map()
  for (const entry of unusable) {
    const block = byPos.get(posKey(entry.position))
    if (!block) continue
    if (String(block.type || '').endsWith('_bed')) {
      for (const candidate of blueprint.blocks) {
        if (!String(candidate.type || '').endsWith('_bed')) continue
        if (candidate.y !== block.y) continue
        if (Math.abs(candidate.x - block.x) + Math.abs(candidate.z - block.z) <= 1) {
          removals.set(posKey(candidate), { block: compactBlock(candidate) })
        }
      }
      continue
    }
    removals.set(posKey(block), { block: compactBlock(block) })
  }
  return removals
}

function compactBlock(block) {
  return {
    type: block.type,
    x: block.x,
    y: block.y,
    z: block.z
  }
}

function posKey(block) {
  return `${Math.round(Number(block.x))},${Math.round(Number(block.y))},${Math.round(Number(block.z))}`
}

async function downloadSourceFile(source, checkout, args = {}) {
  ensureDir(checkout)
  const fileName = source.fileName || source.filePath || `${safePathName(source.id)}.${String(source.structureFileFormat || 'schematic').replace(/^\./, '')}`
  const target = path.join(checkout, path.basename(fileName))
  if (fs.existsSync(target) && args.forceDownload !== 'true') {
    return {
      ok: true,
      checkout,
      filePath: target,
      reused: true,
      sourcePageIdentifier: source.sourcePageIdentifier || null,
      downloadPageIdentifier: source.downloadPageIdentifier || null,
      url: source.downloadUrl || null,
      fetchedAt: source.ratingMetadata?.fetchedAt || null
    }
  }

  const resolved = source.downloadUrl
    ? { ok: true, url: source.downloadUrl, page: null }
    : await resolveDownloadUrlFromPage(source.downloadPageIdentifier, source)
  if (!resolved.ok) return resolved

  const downloadHeaders = {
    'User-Agent': 'LinXia-P9-community-sync/1.0',
    Accept: 'application/octet-stream,*/*'
  }
  if (resolved.cookie) downloadHeaders.Cookie = resolved.cookie
  if (resolved.referer) downloadHeaders.Referer = resolved.referer
  const response = await fetch(resolved.url, {
    headers: downloadHeaders
  })
  if (!response.ok) {
    return { ok: false, error: `download_failed:${response.status}:${response.statusText}` }
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(target, buffer)
  return {
    ok: true,
    checkout,
    filePath: target,
    reused: false,
    sourcePageIdentifier: source.sourcePageIdentifier || null,
    downloadPageIdentifier: source.downloadPageIdentifier || null,
    url: resolved.url,
    pageResolvedFrom: resolved.page || null,
    contentType: response.headers.get('content-type') || null,
    contentDisposition: response.headers.get('content-disposition') || null,
    bytes: buffer.length,
    fetchedAt: new Date().toISOString()
  }
}

async function resolveDownloadUrlFromPage(pageUrl, source = {}) {
  if (!pageUrl) return { ok: false, error: 'missing_download_url_or_page' }
  if (isBloxelizerApiUrl(pageUrl)) return resolveBloxelizerDownloadUrl(pageUrl, source)
  const cookies = []
  if (source.sourcePageIdentifier) {
    const sourceResponse = await fetch(source.sourcePageIdentifier, {
      headers: {
        'User-Agent': 'LinXia-P9-community-sync/1.0',
        Accept: 'text/html,*/*'
      }
    })
    if (sourceResponse.ok) cookies.push(...cookiesFromHeaders(sourceResponse.headers))
  }
  const headers = {
    'User-Agent': 'LinXia-P9-community-sync/1.0',
    Accept: 'text/html,*/*'
  }
  if (source.sourcePageIdentifier) headers.Referer = source.sourcePageIdentifier
  if (cookies.length) headers.Cookie = cookies.join('; ')
  const response = await fetch(pageUrl, { headers })
  if (!response.ok) return { ok: false, error: `download_page_failed:${response.status}:${response.statusText}` }
  cookies.push(...cookiesFromHeaders(response.headers))
  const html = await response.text()
  const match = html.match(/var\s+file\s*=\s*['"]([^'"]+)['"]/)
  if (!match) return { ok: false, error: 'download_page_missing_file_variable' }
  return {
    ok: true,
    page: pageUrl,
    url: new URL(match[1], pageUrl).href,
    cookie: dedupeCookies(cookies).join('; '),
    referer: pageUrl
  }
}

function isBloxelizerApiUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'api.bloxelizer.com' &&
      /^\/api\/schematics\/[^/]+\/?$/.test(url.pathname)
  } catch {
    return false
  }
}

async function resolveBloxelizerDownloadUrl(apiUrl, source = {}) {
  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'LinXia-P9-community-sync/1.0',
      Accept: 'application/json'
    }
  })
  if (!response.ok) return { ok: false, error: `download_page_failed:${response.status}:${response.statusText}` }

  let metadata
  try {
    metadata = await response.json()
  } catch {
    return { ok: false, error: 'bloxelizer_api_invalid_json' }
  }
  if (metadata?.visibility !== 'public' || metadata?.upload_status !== 'completed' || metadata?.locked === true) {
    return { ok: false, error: 'bloxelizer_schematic_not_public_and_ready' }
  }
  if (!metadata?.id || !metadata?.render_token) {
    return { ok: false, error: 'bloxelizer_api_missing_download_identity' }
  }

  const id = encodeURIComponent(String(metadata.id))
  const token = encodeURIComponent(String(metadata.render_token))
  return {
    ok: true,
    page: apiUrl,
    url: `https://bloxelizer.com/cdn/schematics/${id}?t=${token}`,
    referer: source.sourcePageIdentifier || apiUrl
  }
}

function cookiesFromHeaders(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')]
  return raw
    .filter(Boolean)
    .flatMap(value => String(value).split(/,(?=[^;,]+=)/))
    .map(value => value.split(';')[0].trim())
    .filter(Boolean)
}

function dedupeCookies(cookies) {
  const result = new Map()
  for (const cookie of cookies) {
    const name = cookie.split('=')[0]
    if (!name) continue
    result.set(name, cookie)
  }
  return [...result.values()]
}

function checkoutSource(source, checkout) {
  if (fs.existsSync(path.join(checkout, source.filePath || ''))) {
    return { ok: true, checkout, reused: true }
  }
  if (!fs.existsSync(checkout)) {
    const clone = spawnSync('git', [
      'clone',
      '--depth=1',
      '--branch',
      source.branch || 'main',
      source.cloneUrl,
      checkout
    ], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    if (clone.status !== 0) {
      return { ok: false, error: `git_clone_failed:${trim(clone.stderr || clone.stdout)}` }
    }
  }
  if (source.ref) {
    const checkoutRef = spawnSync('git', ['-C', checkout, 'checkout', source.ref], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    if (checkoutRef.status !== 0) {
      return { ok: false, error: `git_checkout_failed:${trim(checkoutRef.stderr || checkoutRef.stdout)}` }
    }
  }
  return { ok: true, checkout, reused: false }
}

function baseRecord(source) {
  return {
    id: source.id,
    source: source.source,
    sourcePageIdentifier: source.sourcePageIdentifier,
    repository: source.repository || null,
    author: source.author || null,
    buildTitle: source.buildTitle || source.id,
    category: source.category || null,
    style: source.style || null,
    buildingType: source.buildingType || null,
    structureUse: source.structureUse || null,
    buildingCategory: source.buildingCategory || null,
    requiredStories: source.requiredStories || null,
    ratingMetadata: source.ratingMetadata || null,
    metadataFetchedAt: null,
    minecraftVersion: source.minecraftVersion || null,
    structureFileFormat: source.structureFileFormat || null,
    license: source.license || { type: 'unknown', usage: null },
    cacheHash: null,
    importStatus: 'pending'
  }
}

function readExistingIndex() {
  const indexPath = path.join(CACHE_DIR, 'index.json')
  if (!fs.existsSync(indexPath)) return null
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  } catch {
    return null
  }
}

// Keep every previous record (verified or rejected) whose id was NOT part of
// this partial sync; the freshly processed ids replace their old entries.
function mergeRecords(previousIndex, records, onlyIds) {
  const processed = new Set(onlyIds)
  const kept = [
    ...(previousIndex.samples || []),
    ...(previousIndex.rejected || [])
  ].filter(record => record?.id && !processed.has(record.id))
  return [...kept, ...records]
}

function parseArgs(args) {
  const result = {}
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safePathName(value) {
  return String(value || 'sample').replace(/[^a-zA-Z0-9_.-]/g, '-')
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/')
}

function trim(value) {
  return String(value || '').trim().slice(0, 500)
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  isBloxelizerApiUrl,
  resolveBloxelizerDownloadUrl,
  resolveDownloadUrlFromPage
}
