const assert = require('assert')
const {
  DEFAULT_TARGET_VERSION,
  checkBlueprintVersionCompatibility,
  formatVersionCompatibilityFailure,
  resolveTargetVersion
} = require('../systems/blueprint-version-compatibility')

// The real case this gate exists for: the fort wall gate carries 1.21 tuff and
// copper-door content that does not exist on the 1.20.1 acceptance server, so
// the material hand-out on the real server failed with
// BLOCKED_MATERIAL_SHORTAGE:chiseled_tuff_bricks:68,tuff_bricks:16,chiseled_tuff:8
function fortGateLikeBlueprint() {
  const blocks = []
  const push = (type, count) => {
    for (let i = 0; i < count; i++) blocks.push({ x: i, y: 0, z: 0, type })
  }
  push('stone_bricks', 40)
  push('tuff_brick_stairs', 100)
  push('chiseled_tuff_bricks', 68)
  push('tuff_brick_wall', 26)
  push('tuff_bricks', 16)
  push('chiseled_tuff', 8)
  push('waxed_oxidized_copper_door', 6)
  push('oxidized_copper_door', 2)
  return { name: 'fort_wall_gate_like', blocks, metadata: {} }
}

function blueprintOf(types) {
  return {
    name: 'probe',
    blocks: types.map((type, i) => ({ x: i, y: 0, z: 0, type })),
    metadata: {}
  }
}

function testRejectsBlocksMissingFromTargetVersion() {
  const result = checkBlueprintVersionCompatibility(fortGateLikeBlueprint(), { targetVersion: '1.20.1' })
  assert.strictEqual(result.ok, false, '1.20.1 应当拦下含 1.21 方块的素材')
  assert.strictEqual(result.targetVersion, '1.20.1')
  assert.strictEqual(result.missingBlockTotal, 226, '缺失方块总数应为 226')
  assert.strictEqual(result.missingBlocks.length, 7, '缺失方块种类应为 7')
  // 按数量降序，最大的一项排头，方便日志与反馈直接引用
  assert.deepStrictEqual(result.missingBlocks[0], { name: 'tuff_brick_stairs', count: 100 })
  const names = result.missingBlocks.map(entry => entry.name)
  for (const expected of ['chiseled_tuff_bricks', 'tuff_bricks', 'chiseled_tuff', 'oxidized_copper_door']) {
    assert.ok(names.includes(expected), `缺失清单应含 ${expected}`)
  }
  // 该版本存在的方块不能被误报
  assert.ok(!names.includes('stone_bricks'), 'stone_bricks 在 1.20.1 存在，不该进缺失清单')
}

function testSameBlueprintPassesOnTargetVersionThatHasThem() {
  const result = checkBlueprintVersionCompatibility(fortGateLikeBlueprint(), { targetVersion: '1.21.1' })
  assert.strictEqual(result.ok, true, '1.21.1 有这些方块，应当放行')
  assert.strictEqual(result.missingBlocks.length, 0)
  assert.strictEqual(result.missingBlockTotal, 0)
}

// 升级方向的回归护栏：grass 在 1.20.3 起改名为 short_grass。素材库里
// 三份社区图纸（分别 22 / 6 / 1 处）都带着它，升级后会失效。
function testGrassRenameIsDetectedInBothDirections() {
  const grassOnly = blueprintOf(['grass', 'grass', 'stone'])
  const shortGrassOnly = blueprintOf(['short_grass', 'stone'])

  assert.strictEqual(checkBlueprintVersionCompatibility(grassOnly, { targetVersion: '1.20.1' }).ok, true)
  const afterUpgrade = checkBlueprintVersionCompatibility(grassOnly, { targetVersion: '1.21.1' })
  assert.strictEqual(afterUpgrade.ok, false, '升级到 1.21 后 grass 不存在，应当被拦下')
  assert.deepStrictEqual(afterUpgrade.missingBlocks, [{ name: 'grass', count: 2 }])

  assert.strictEqual(checkBlueprintVersionCompatibility(shortGrassOnly, { targetVersion: '1.20.1' }).ok, false)
  assert.strictEqual(checkBlueprintVersionCompatibility(shortGrassOnly, { targetVersion: '1.21.1' }).ok, true)
}

function testAirVariantsAreIgnored() {
  const result = checkBlueprintVersionCompatibility(
    blueprintOf(['air', 'cave_air', 'void_air', 'stone']),
    { targetVersion: '1.20.1' }
  )
  assert.strictEqual(result.ok, true, '空气不参与版本判定')
  assert.strictEqual(result.missingBlocks.length, 0)
}

// 别墅（经典 .schematic）带 375 个 legacy_block_NNN 占位名。真实身份未知，
// 拿它们判死会把已经验证过的素材误杀，所以只记 unresolved 不判失败。
function testLegacyNumericPlaceholdersAreReportedNotFailed() {
  const result = checkBlueprintVersionCompatibility(
    blueprintOf(['legacy_block_159', 'legacy_block_159', 'legacy_block_35', 'stone']),
    { targetVersion: '1.20.1' }
  )
  assert.strictEqual(result.ok, true, 'legacy 占位名不判失败')
  assert.strictEqual(result.missingBlocks.length, 0)
  assert.deepStrictEqual(result.unresolved, [
    { name: 'legacy_block_159', count: 2 },
    { name: 'legacy_block_35', count: 1 }
  ])
}

// 方块存在但没有同名物品（水、墙上牌子、红石线……）是发料侧的翻译问题，
// 归 building-material-map 管，不是版本问题，不能在这里判死。
function testBlocksWithoutMatchingItemPassButAreReported() {
  const result = checkBlueprintVersionCompatibility(
    blueprintOf(['water', 'redstone_wire', 'oak_wall_sign', 'stone']),
    { targetVersion: '1.20.1' }
  )
  assert.strictEqual(result.ok, true, '有方块无物品不判版本失败')
  const names = result.blockWithoutItem.map(entry => entry.name).sort()
  assert.deepStrictEqual(names, ['oak_wall_sign', 'redstone_wire', 'water'])
}

function testNamespaceAndCaseAreNormalized() {
  const result = checkBlueprintVersionCompatibility(
    { name: 'p', blocks: [{ x: 0, y: 0, z: 0, type: 'minecraft:Stone_Bricks' }], metadata: {} },
    { targetVersion: '1.20.1' }
  )
  assert.strictEqual(result.ok, true, 'minecraft: 前缀与大小写应被归一')
  assert.strictEqual(result.missingBlocks.length, 0)
}

function testUnknownTargetVersionFailsSoftly() {
  const result = checkBlueprintVersionCompatibility(blueprintOf(['stone']), { targetVersion: '9.9.9' })
  assert.strictEqual(result.ok, false)
  assert.ok(/unknown_target_version|9\.9\.9/.test(result.error || ''), '未知版本应给出可读错误而不是抛异常')
}

function testInvalidBlueprintFailsSoftly() {
  const result = checkBlueprintVersionCompatibility(null, { targetVersion: '1.20.1' })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'invalid_blueprint_for_version_check')
}

function testFailureFormatting() {
  const result = checkBlueprintVersionCompatibility(fortGateLikeBlueprint(), { targetVersion: '1.20.1' })
  const text = formatVersionCompatibilityFailure(result)
  assert.ok(text.startsWith('target_version_1.20.1_missing_blocks:'), text)
  assert.ok(text.includes('tuff_brick_stairs:100'), text)
  assert.ok(text.includes('+1种'), '超过 6 种时应折叠计数')
  assert.strictEqual(formatVersionCompatibilityFailure({ ok: true }), '', '通过时不产出失败文案')
}

function testTargetVersionResolutionOrder() {
  assert.strictEqual(resolveTargetVersion('1.21.8', { MC_VERSION: '1.21.1' }), '1.21.8', '显式参数优先')
  assert.strictEqual(resolveTargetVersion(null, { MC_VERSION: '1.21.1' }), '1.21.1', '其次读 MC_VERSION')
  assert.strictEqual(resolveTargetVersion(null, {}), DEFAULT_TARGET_VERSION, '兜底为默认版本')
  assert.strictEqual(DEFAULT_TARGET_VERSION, '1.20.1', '默认版本应与当前专用服务器一致')
}

function run() {
  testRejectsBlocksMissingFromTargetVersion()
  testSameBlueprintPassesOnTargetVersionThatHasThem()
  testGrassRenameIsDetectedInBothDirections()
  testAirVariantsAreIgnored()
  testLegacyNumericPlaceholdersAreReportedNotFailed()
  testBlocksWithoutMatchingItemPassButAreReported()
  testNamespaceAndCaseAreNormalized()
  testUnknownTargetVersionFailsSoftly()
  testInvalidBlueprintFailsSoftly()
  testFailureFormatting()
  testTargetVersionResolutionOrder()
  console.log('blueprint version compatibility tests passed')
}

run()
