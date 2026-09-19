const assert = require('assert')

const {
  BLOCK_VERSION_RENAMES,
  blockNameAliases,
  isSameBlockName,
  itemNameForBlock
} = require('../utils/building-material-map')
const {
  DEFAULT_TARGET_VERSION,
  checkBlueprintVersionCompatibility,
  resolveTargetVersion
} = require('../systems/blueprint-version-compatibility')

// ── the table itself ────────────────────────────────────────────────────────

function testGrassWasRenamedNotRemoved() {
  assert.strictEqual(BLOCK_VERSION_RENAMES.grass, 'short_grass')
  // Both directions resolve to the same pair, newest-known spelling first.
  assert.deepStrictEqual(blockNameAliases('grass'), ['short_grass', 'grass'])
  assert.deepStrictEqual(blockNameAliases('short_grass'), ['short_grass', 'grass'])
  assert.deepStrictEqual(blockNameAliases('minecraft:grass'), ['short_grass', 'grass'])
}

function testUnrelatedNamesAreLeftAlone() {
  assert.deepStrictEqual(blockNameAliases('stone'), ['stone'])
  // grass_block and tall_grass are different blocks that merely share a prefix,
  // and neither was renamed.
  assert.deepStrictEqual(blockNameAliases('grass_block'), ['grass_block'])
  assert.deepStrictEqual(blockNameAliases('tall_grass'), ['tall_grass'])
  assert.deepStrictEqual(blockNameAliases(''), [])
  assert.deepStrictEqual(blockNameAliases(null), [])
}

function testAliasAwareEquality() {
  assert.strictEqual(isSameBlockName('short_grass', 'grass'), true)
  assert.strictEqual(isSameBlockName('grass', 'short_grass'), true)
  assert.strictEqual(isSameBlockName('grass', 'grass'), true)
  assert.strictEqual(isSameBlockName('tall_grass', 'grass'), false)
  assert.strictEqual(isSameBlockName('grass_block', 'grass'), false)
  assert.strictEqual(isSameBlockName('fern', 'grass'), false)
}

function testRenameDoesNotDisturbBlockToItemTranslation() {
  // The version rename is a different axis from BLOCK_ITEM_RENAMES: both
  // spellings are placed by an item of the same name, and the existing
  // block -> item table must keep working untouched.
  assert.strictEqual(itemNameForBlock('grass'), 'grass')
  assert.strictEqual(itemNameForBlock('short_grass'), 'short_grass')
  assert.strictEqual(itemNameForBlock('redstone_wire'), 'redstone')
  assert.strictEqual(itemNameForBlock('lava'), 'lava_bucket')
}

// ── which protocol version the bot speaks ───────────────────────────────────

function testVersionComesFromTheEnvironment() {
  // The building lane's server has not been upgraded, so the DEFAULT must stay
  // on 1.20.1; only a lane that sets MC_VERSION moves.
  assert.strictEqual(DEFAULT_TARGET_VERSION, '1.20.1')
  assert.strictEqual(resolveTargetVersion(null, {}), '1.20.1')
  assert.strictEqual(resolveTargetVersion(null, { MC_VERSION: '1.21.8' }), '1.21.8')
  assert.strictEqual(resolveTargetVersion(null, { MC_VERSION: '  1.21.8  ' }), '1.21.8')
  // An explicit argument still wins over the environment.
  assert.strictEqual(resolveTargetVersion('1.20.1', { MC_VERSION: '1.21.8' }), '1.20.1')
}

function testBotConnectsWithTheResolvedVersion() {
  // bot.js pins the protocol version instead of negotiating it, so the literal
  // must not creep back in: a hard-coded version silently plans blocks for one
  // server while talking to another.
  const source = require('fs').readFileSync(require.resolve('../bot.js'), 'utf8')
  assert.ok(/version:\s*mcVersion/.test(source), 'createBot must use the resolved version')
  assert.ok(
    !/version:\s*'1\.20\.1'/.test(source),
    'the hard-coded connection version must be gone'
  )
}

// ── what the rename means for the blueprint library ─────────────────────────

function testTheVersionGateStillFlagsTheRenameAsAnUpgradeBlocker() {
  // Pinned deliberately, NOT as an endorsement. The logistics lane's gate
  // treats the rename as missing content on purpose, so that upgrade day
  // surfaces every library asset spelling it the old way
  // (tests/blueprint-version-compatibility.test.js). The repair lane is not
  // the place to overrule that - see the open question in this round's
  // feedback. This test exists so the two readings cannot silently diverge.
  const oldSpelling = { blocks: [{ type: 'grass' }, { type: 'stone' }] }
  assert.strictEqual(
    checkBlueprintVersionCompatibility(oldSpelling, { targetVersion: '1.20.1' }).ok,
    true
  )
  const afterUpgrade = checkBlueprintVersionCompatibility(oldSpelling, { targetVersion: '1.21.8' })
  assert.strictEqual(afterUpgrade.ok, false, 'the gate still reports old-spelling grass as missing on 1.21.8')
  assert.deepStrictEqual(afterUpgrade.missingBlocks, [{ name: 'grass', count: 1 }])

  // The alias table knows they are the same block even though the gate, by
  // design, refuses to act on that.
  assert.strictEqual(isSameBlockName('grass', afterUpgrade.missingBlocks[0].name), true)
}

// ── the predicates that decide whether short grass is an obstacle ───────────

function testEveryVegetationPredicateSourceKnowsBothSpellings() {
  // These predicates live behind large modules with heavy construction state,
  // so assert on the source: wherever short grass is named as passable/
  // replaceable/decorative, BOTH spellings have to be named. A regex site is
  // covered by `/^(short_)?grass$/`, a list site by listing both.
  const fs = require('fs')
  const files = [
    'actions/build.js',
    'systems/building-complexity.js',
    'systems/building-hard-gate.js',
    'systems/building-system.js',
    'systems/faithful-community-validator.js',
    'utils/site-planner.js'
  ]
  const offenders = []
  for (const file of files) {
    const source = fs.readFileSync(require.resolve(`../${file}`), 'utf8')
    const lines = source.split(/\r?\n/)
    lines.forEach((line, index) => {
      // A bare `/^grass$/` or a list entry `'grass',` that is not paired with
      // the new spelling on the neighbouring line.
      const bareRegex = /\/\^grass\$\//.test(line)
      const bareListEntry = /(^|[\s([])'grass'\s*[,)|]/.test(line)
      const bareEquality = /===\s*'grass'/.test(line)
      if (!bareRegex && !bareListEntry && !bareEquality) return
      const neighbourhood = lines.slice(Math.max(0, index - 1), index + 2).join('\n')
      if (!neighbourhood.includes('short_grass')) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepStrictEqual(offenders, [], `these still treat short grass as an obstacle on 1.21.8:\n${offenders.join('\n')}`)
}

function testGrassNamesResolveInBothRegistries() {
  // The reason the predicates cannot simply be renamed: each spelling is real
  // in exactly one of the two versions this project has to talk to.
  const minecraftData = require('minecraft-data')
  assert.ok(minecraftData('1.20.1').blocksByName.grass, '1.20.1 has grass')
  assert.ok(!minecraftData('1.20.1').blocksByName.short_grass, '1.20.1 has no short_grass')
  assert.ok(minecraftData('1.21.8').blocksByName.short_grass, '1.21.8 has short_grass')
  assert.ok(!minecraftData('1.21.8').blocksByName.grass, '1.21.8 has no grass')
}

function run() {
  testGrassWasRenamedNotRemoved()
  testUnrelatedNamesAreLeftAlone()
  testAliasAwareEquality()
  testRenameDoesNotDisturbBlockToItemTranslation()
  testVersionComesFromTheEnvironment()
  testBotConnectsWithTheResolvedVersion()
  testTheVersionGateStillFlagsTheRenameAsAnUpgradeBlocker()
  testEveryVegetationPredicateSourceKnowsBothSpellings()
  testGrassNamesResolveInBothRegistries()
  console.log('block version rename tests passed')
}

run()
