'use strict'

/**
 * Target-server version registry check for imported community blueprints.
 *
 * Motivation (building lane round 6): `fort-wall-gate` imported and passed every
 * existing gate, then died on the real server with
 * `BLOCKED_MATERIAL_SHORTAGE:chiseled_tuff_bricks:68,...` — 226 of its 1233
 * blocks are 1.21 content that simply does not exist on the 1.20.1 server. No
 * amount of code can place a block the server does not have, so the honest place
 * to catch this is import time, not material-hand-out time.
 *
 * This module answers one question: does every block name in this blueprint
 * exist in the target server version's registry?
 *
 * Deliberately NOT treated as incompatible:
 *   - air variants (never placed)
 *   - blocks that exist but have no matching item (water, wall signs, redstone
 *     wire, potted plants ...). Those are a material-translation concern the
 *     build path already owns; they are reported separately as `blockWithoutItem`.
 *   - `legacy_block_<id>` placeholders produced by classic .schematic imports.
 *     Their real identity is unknown, so they are reported as `unresolved`
 *     rather than failed — refusing them would reject already-verified assets.
 */

const minecraftData = require('minecraft-data')

const DEFAULT_TARGET_VERSION = '1.20.1'
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
const LEGACY_NUMERIC_BLOCK = /^legacy_block_\d+$/

const registryCache = new Map()

function registryFor(version) {
  if (registryCache.has(version)) return registryCache.get(version)
  const data = minecraftData(version)
  if (!data || !data.blocksByName) {
    throw new Error(`unknown_target_version:${version}`)
  }
  const entry = {
    blocks: new Set(Object.keys(data.blocksByName)),
    items: new Set(Object.keys(data.itemsByName || {}))
  }
  registryCache.set(version, entry)
  return entry
}

function normalizeBlockName(block) {
  const raw = block && (block.type || block.name || block.block)
  return String(raw || '').replace(/^minecraft:/, '').trim().toLowerCase()
}

function countBlockNames(blueprint) {
  const counts = new Map()
  for (const block of (blueprint && blueprint.blocks) || []) {
    const name = normalizeBlockName(block)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return counts
}

function toEntries(pairs) {
  return pairs
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }))
}

/**
 * @param {object} blueprint  imported blueprint ({ blocks: [{type,x,y,z}] })
 * @param {object} options    { targetVersion }
 * @returns {{ok:boolean, targetVersion:string, blockCount:number,
 *            missingBlocks:Array<{name:string,count:number}>,
 *            missingBlockTotal:number,
 *            blockWithoutItem:Array<{name:string,count:number}>,
 *            unresolved:Array<{name:string,count:number}>,
 *            error?:string}}
 */
function checkBlueprintVersionCompatibility(blueprint, options = {}) {
  const targetVersion = String(options.targetVersion || DEFAULT_TARGET_VERSION)
  const empty = {
    targetVersion,
    blockCount: 0,
    missingBlocks: [],
    missingBlockTotal: 0,
    blockWithoutItem: [],
    unresolved: []
  }

  if (!blueprint || !Array.isArray(blueprint.blocks)) {
    return { ...empty, ok: false, error: 'invalid_blueprint_for_version_check' }
  }

  let registry
  try {
    registry = registryFor(targetVersion)
  } catch (error) {
    return { ...empty, ok: false, error: String((error && error.message) || error) }
  }

  const counts = countBlockNames(blueprint)
  const missing = []
  const withoutItem = []
  const unresolved = []

  for (const [name, count] of counts) {
    if (AIR_BLOCKS.has(name)) continue
    if (LEGACY_NUMERIC_BLOCK.test(name)) { unresolved.push([name, count]); continue }
    if (!registry.blocks.has(name)) { missing.push([name, count]); continue }
    if (!registry.items.has(name)) withoutItem.push([name, count])
  }

  const missingBlocks = toEntries(missing)
  return {
    ok: missingBlocks.length === 0,
    targetVersion,
    blockCount: (blueprint.blocks || []).length,
    missingBlocks,
    missingBlockTotal: missingBlocks.reduce((sum, entry) => sum + entry.count, 0),
    blockWithoutItem: toEntries(withoutItem),
    unresolved: toEntries(unresolved)
  }
}

/** Compact one-line summary for logs and index records. */
function formatVersionCompatibilityFailure(result) {
  if (!result || result.ok) return ''
  if (result.error) return result.error
  const listed = result.missingBlocks.slice(0, 6).map(e => `${e.name}:${e.count}`).join(',')
  const more = result.missingBlocks.length > 6 ? `,+${result.missingBlocks.length - 6}种` : ''
  return `target_version_${result.targetVersion}_missing_blocks:${listed}${more}`
}

/**
 * Resolve the target version from (in order): explicit option, CLI arg value,
 * MC_VERSION env, default. Kept here so the sync script and any future caller
 * agree on one resolution order.
 */
function resolveTargetVersion(explicit, env = process.env) {
  const candidate = explicit || env.MC_VERSION || DEFAULT_TARGET_VERSION
  return String(candidate).trim()
}

module.exports = {
  DEFAULT_TARGET_VERSION,
  checkBlueprintVersionCompatibility,
  formatVersionCompatibilityFailure,
  resolveTargetVersion
}
