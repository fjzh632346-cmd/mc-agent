'use strict'

// Which blueprints can a player actually name in chat?
//
// Before this module the answer lived in one hand-written if-chain in
// intent-parser.js: whatever was not in that chain fell through to the default
// small_house, so "建个雕像" (build a statue) silently built a small house, and
// simple_two_story_cabin had no saying of its own at all. Round 13 (logistics)
// turned the list into data derived from the blueprints themselves:
//
//   * local files      — blueprints/*.json, via BlueprintLoader.listBlueprints()
//   * generated ones   — ProceduralBlueprintGenerator's GENERATED_BLUEPRINT_NAMES
//
// English sayings come from the id ("simple_wood_cabin" → "simple wood cabin",
// and the "wood cabin" tail when no other blueprint answers to it). Chinese
// sayings cannot be derived from an English id, so they travel next to the
// blueprints in ZH_SAYINGS below, or in a blueprint file's own
// `metadata.zhNames` / `metadata.enNames` / `metadata.aliases` when it has
// them — never back inside the parser.
//
// A blueprint's natural complexity tier is measured, not declared: the lowest
// tier whose budget the blueprint actually satisfies (production checker,
// systems/building-complexity.js). The parser uses it so that naming a small
// build no longer runs into the L2 floor of 120 blocks.

const { BlueprintLoader } = require('../systems/blueprint-loader')
const {
  ProceduralBlueprintGenerator,
  GENERATED_BLUEPRINT_NAMES
} = require('../systems/procedural-blueprint-generator')
const {
  COMPLEXITY_TIER_ORDER,
  blueprintSatisfiesDesignSpec,
  shouldPreserveNamedBlueprintScale
} = require('../systems/building-complexity')

// 中文说法：一份图纸一行，跟着图纸走，不写回解析器。
// 本地 blueprints/*.json 那四份把中文名写在自己的 metadata.zhNames 里
// （loader 原样读出来；图纸哈希只算 id/name/bounds/blocks，不含 metadata，金值不受影响），
// 所以这张表只剩程序生成、没有文件可写的那十份。
// 这里只放「不会跟别的图纸抢」的说法；含糊的（如「小屋」「房子」）留给
// intent-parser 里原有那条链，向后兼容。
const ZH_SAYINGS = Object.freeze({
  two_story_wood_house: ['双层木屋', '两层木屋', '二层木屋'],
  simple_two_story_cabin: ['简单双层小屋', '双层小木屋', '二层小木屋', '双层木头小屋'],
  simple_wood_cabin: ['简易木屋', '简单木屋'],
  starter_shelter: ['避难所', '庇护所', '临时住所'],
  simple_farmhouse: ['农舍', '农家小屋'],
  modern_villa: ['现代别墅', '山顶别墅'],
  castle_garden: ['城堡花园'],
  garden_manor: ['花园庄园', '庄园'],
  statue: ['雕像', '雕塑'],
  fountain: ['喷泉']
})

const TIERS = Object.keys(COMPLEXITY_TIER_ORDER)
  .sort((a, b) => COMPLEXITY_TIER_ORDER[a] - COMPLEXITY_TIER_ORDER[b])

let cachedIndex = null

function normalizeAlias(value) {
  return String(value || '').toLowerCase().trim()
}

function idWords(id) {
  return String(id || '').split(/[_\-\s]+/).filter(Boolean)
}

// "simple_wood_cabin" → ["simple_wood_cabin", "simple wood cabin", "wood cabin"]
// The tail is a candidate only; buildIndex drops the tails two blueprints share.
function englishSayingsFor(id) {
  const words = idWords(id)
  const sayings = [normalizeAlias(id), words.join(' ')]
  if (words.length > 2) sayings.push(words.slice(-2).join(' '))
  return [...new Set(sayings.filter(Boolean))]
}

function naturalTierFor(blueprint) {
  for (const tier of TIERS) {
    const verdict = blueprintSatisfiesDesignSpec(blueprint, { complexityTier: tier })
    if (verdict.ok) return tier
  }
  return null
}

function entryFor(id, blueprint, source) {
  const metadata = blueprint?.metadata || {}
  // English sayings a blueprint declares for itself. The id-derived ones above
  // only ever produce the id's own words, so a name nobody would guess from the
  // id ("medium house" for tower_cottage) has to travel with the blueprint —
  // same rule as zhNames, and it lands in the same pool, so the parser stays
  // free of hand-written names (后勤 18).
  const fileAliases = [
    ...(metadata.aliases || []),
    ...(metadata.zhNames || []),
    ...(metadata.enNames || [])
  ]
    .map(normalizeAlias)
    .filter(Boolean)
  return {
    id,
    source,
    blocks: (blueprint?.blocks || []).length,
    displayName: metadata.displayName || blueprint?.name || id,
    naturalTier: naturalTierFor(blueprint),
    englishSayings: englishSayingsFor(id),
    zhSayings: [...new Set([...(ZH_SAYINGS[id] || []), ...fileAliases])]
  }
}

function buildBlueprintNameIndex(options = {}) {
  const loader = options.loader || new BlueprintLoader(options)
  const generator = options.generator || new ProceduralBlueprintGenerator()
  const entries = []
  const skipped = []

  for (const localName of loader.listBlueprints()) {
    const loaded = loader.loadBlueprint(localName)
    if (!loaded.ok) {
      skipped.push({ id: localName, source: 'local_file', error: loaded.error })
      continue
    }
    entries.push(entryFor(localName, loaded.blueprint, 'local_file'))
  }

  for (const name of GENERATED_BLUEPRINT_NAMES) {
    if (entries.some(entry => entry.id === name)) continue
    const generated = generator.generate(name)
    if (!generated.ok) {
      skipped.push({ id: name, source: 'generated', error: generated.error })
      continue
    }
    entries.push(entryFor(name, generated.blueprint, 'generated'))
  }

  // A tail two blueprints answer to ("cabin", "house") is not a saying — it is a
  // guess. Drop those instead of letting the first entry win by table order;
  // the parser's own older rules still resolve the common ones.
  const tailOwners = new Map()
  for (const entry of entries) {
    for (const saying of entry.englishSayings) {
      if (!tailOwners.has(saying)) tailOwners.set(saying, new Set())
      tailOwners.get(saying).add(entry.id)
    }
  }
  for (const entry of entries) {
    // Deduped: a blueprint may declare an enName its id already produces
    // (tower_cottage declares "tower cottage"), and a saying listed twice would
    // read as two blueprints claiming it.
    entry.sayings = [...new Set([
      ...entry.englishSayings.filter(saying => tailOwners.get(saying).size === 1),
      ...entry.zhSayings
    ])]
    // Can naming this blueprint actually build it? Either it fits some tier's
    // budget, or it is on the fixed-scale list, which skips the budget check
    // entirely (boss decision #66 put the four tier-less ones there). Round 13
    // left the tier-less ones unclaimed on purpose — claiming a name that then
    // returns no_usable_blueprint_candidate turns a wrong build into no build.
    // The list is asked, never copied: adding a blueprint to it is enough.
    entry.fixedScale = shouldPreserveNamedBlueprintScale({ blueprintName: entry.id }) === true
    entry.buildable = entry.naturalTier !== null || entry.fixedScale
  }

  return { entries, skipped }
}

function blueprintNameIndex(options = {}) {
  if (options.fresh || !cachedIndex) {
    const built = buildBlueprintNameIndex(options)
    if (options.fresh) return built
    cachedIndex = built
  }
  return cachedIndex
}

// Longest saying wins; a tie between different blueprints is ambiguous and the
// caller is expected to ask rather than pick one.
function resolveBlueprintNameFromText(text, entries = null) {
  const haystack = normalizeAlias(text)
  if (!haystack) return null
  const pool = entries || blueprintNameIndex().entries
  const best = new Map()

  for (const entry of pool) {
    if (entry.buildable === false) continue
    for (const saying of entry.sayings || []) {
      if (!saying || !haystack.includes(saying)) continue
      const current = best.get(entry.id)
      if (!current || saying.length > current.length) {
        best.set(entry.id, { id: entry.id, saying, length: saying.length })
      }
    }
  }
  if (!best.size) return null

  const ranked = [...best.values()].sort((a, b) => b.length - a.length || a.id.localeCompare(b.id))
  if (ranked.length === 1 || ranked[0].length > ranked[1].length) {
    return { name: ranked[0].id, matchedSaying: ranked[0].saying }
  }
  const topLength = ranked[0].length
  return {
    name: null,
    candidates: ranked.filter(item => item.length === topLength).map(item => item.id),
    matchedSaying: ranked[0].saying
  }
}

function naturalComplexityTierFor(blueprintName, entries = null) {
  const id = normalizeAlias(blueprintName)
  if (!id) return null
  const pool = entries || blueprintNameIndex().entries
  return pool.find(entry => entry.id === id)?.naturalTier || null
}

module.exports = {
  ZH_SAYINGS,
  buildBlueprintNameIndex,
  blueprintNameIndex,
  englishSayingsFor,
  naturalComplexityTierFor,
  resolveBlueprintNameFromText
}
