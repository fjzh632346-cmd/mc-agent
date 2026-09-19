const assert = require('assert')
const { parseIntent } = require('../ai/intent-parser')
const { BlueprintSelector } = require('../systems/blueprint-selector')
const {
  blueprintNameIndex,
  englishSayingsFor,
  naturalComplexityTierFor,
  resolveBlueprintNameFromText
} = require('../ai/blueprint-name-index')

// 后勤 13：本地图纸能不能被聊天点到。
//
// 病灶（第 13 轮读码 + 端到端探针实测）：图纸名字过去只认 intent-parser 里那条
// 手写 if 链，链上没有的说法一律掉进默认的 small_house——所以「建个雕像」会去
// 盖一间小房子，而 simple_two_story_cabin 连一个属于自己的说法都没有。
//
// 现在名单从图纸本身派生（ai/blueprint-name-index.js）：英文说法按 id 拆词，
// 中文说法跟着图纸走，复杂度档位用生产的预算检查器实测出来。
//
// 每条断言都配反向：老说法必须一个字都没变（向后兼容），歧义必须问而不是猜，
// 认不出的话必须和以前一样什么都不改。

// ---------------------------------------------------------------------------
// A. 十四份图纸各自的中文 / 英文说法
const SAYINGS = [
  // [图纸, 中文说法, 中文该解析成谁, 英文说法, 英文该解析成谁]
  ['chest_area', '建个箱子区', 'chest_area', 'build a chest area', 'chest_area'],
  ['farm_plot', '建个农田', 'farm_plot', 'build a farm plot', 'farm_plot'],
  ['fence_area', '建个围墙', 'fence_area', 'build a fence area', 'fence_area'],
  ['two_story_wood_house', '建个双层木屋', 'two_story_wood_house', 'build a two story wood house', 'two_story_wood_house'],
  ['simple_two_story_cabin', '建个简单双层小屋', 'simple_two_story_cabin', 'build a simple two story cabin', 'simple_two_story_cabin'],
  ['simple_wood_cabin', '建个小木屋', 'simple_wood_cabin', 'build a wood cabin', 'simple_wood_cabin'],
  ['starter_shelter', '建个避难所', 'starter_shelter', 'build a starter shelter', 'starter_shelter'],
  ['modern_villa', '建个现代别墅', 'modern_villa', 'build a modern villa', 'modern_villa'],
  ['castle_garden', '建个城堡花园', 'castle_garden', 'build a castle garden', 'castle_garden'],
  ['statue', '建个雕像', 'statue', 'build a statue', 'statue'],
  ['fountain', '建个喷泉', 'fountain', 'build a fountain', 'fountain'],
  // 第 14 轮（决策 #66）把这三份加进固定尺度白名单后，中英两种说法都点得到了
  ['small_house', '建个小屋', 'small_house', 'build a small house', 'small_house'],
  ['simple_farmhouse', '建个农舍', 'simple_farmhouse', 'build a simple farmhouse', 'simple_farmhouse'],
  ['garden_manor', '建个花园庄园', 'garden_manor', 'build a garden manor', 'garden_manor'],
  // 后勤 18（决策 #92）：开发设计的中等民居，自然档位实测 L4；后勤 19（决策 #94）删掉一只箱子后 715 块
  ['tower_cottage', '建个塔楼小筑', 'tower_cottage', 'build a tower cottage', 'tower_cottage']
]

function blueprintFor (phrase) {
  return parseIntent(phrase)?.params?.blueprintName || null
}

function testEveryBlueprintHasASaying () {
  for (const [id, zh, zhExpected, en, enExpected] of SAYINGS) {
    assert.strictEqual(blueprintFor(zh), zhExpected, `中文说法「${zh}」应解析成 ${zhExpected}（图纸 ${id}）`)
    assert.strictEqual(blueprintFor(en), enExpected, `英文说法 "${en}" 应解析成 ${enExpected}（图纸 ${id}）`)
  }
}

function testTheFiveThatUsedToBeUnreachable () {
  // 这五句以前分别掉进 small_house 和 two_story_wood_house，是本轮要修的
  assert.strictEqual(blueprintFor('建个雕像'), 'statue')
  assert.strictEqual(blueprintFor('建个喷泉'), 'fountain')
  assert.strictEqual(blueprintFor('建个临时避难所'), 'starter_shelter')
  assert.strictEqual(blueprintFor('建个简单双层小屋'), 'simple_two_story_cabin')
  assert.strictEqual(blueprintFor('build a simple two story cabin'), 'simple_two_story_cabin')
}

// ---------------------------------------------------------------------------
// B. 向后兼容：老链条与短语表原来认得的说法，一个字都不能变
const LEGACY_SAYINGS = [
  ['build a modern villa', 'modern_villa'],
  ['build a villa', 'modern_villa'],
  ['build a hilltop house', 'modern_villa'],
  ['建个现代住宅', 'modern_villa'],
  ['建个别墅', 'modern_villa'],
  ['build a fort wall', 'fort_wall_gate'],
  ['建个城墙', 'fort_wall_gate'],
  ['build a watchtower', 'fort_watchtower'],
  ['建个瞭望塔', 'fort_watchtower'],
  ['build a castle', 'castle_garden'],
  ['建个城堡', 'castle_garden'],
  ['build a farmhouse', 'simple_farmhouse'],
  ['build a starter', 'starter_shelter'],
  ['build a shelter', 'starter_shelter'],
  ['build a sculpture', 'statue'],
  ['建个双层', 'two_story_wood_house'],
  ['建个两层', 'two_story_wood_house'],
  ['建个二层', 'two_story_wood_house'],
  ['build a two story', 'two_story_wood_house'],
  ['build a survival house', 'two_story_wood_house'],
  ['build a wood house', 'two_story_wood_house'],
  ['建个小木屋', 'simple_wood_cabin'],
  ['建个木屋', 'simple_wood_cabin'],
  ['建个住宅', 'simple_wood_cabin'],
  ['建个房子', 'simple_wood_cabin'],
  ['build a cabin', 'simple_wood_cabin'],
  ['build a house', 'simple_wood_cabin'],
  ['建个小屋', 'small_house'],
  ['盖个小屋', 'small_house'],
  // 短语表那四条（走的是另一条路，本轮同样不许变）
  ['造个房子', 'simple_wood_cabin'],
  ['盖个房子', 'simple_wood_cabin'],
  ['造个围墙', 'fence_area'],
  ['搭个围栏', 'fence_area'],
  ['建个围栏', 'fence_area'],
  ['搭个箱子区', 'chest_area'],
  ['做个箱子区', 'chest_area'],
  ['做个农田', 'farm_plot'],
  ['搭个农田', 'farm_plot']
]

function testLegacySayingsUnchanged () {
  for (const [phrase, expected] of LEGACY_SAYINGS) {
    assert.strictEqual(blueprintFor(phrase), expected, `老说法「${phrase}」的答案变了`)
  }
}

function testNonBuildIntentsUntouched () {
  // 反向：不是造东西的话，一句都不许被这套名单碰到
  for (const phrase of ['你好', '跟着我', '挖点铁', '记住这里是基地', '睡觉']) {
    assert.notStrictEqual(parseIntent(phrase)?.intent, 'build', `「${phrase}」不该被当成造东西`)
  }
  // 没有造字/build 的句子也不该走这条路
  assert.strictEqual(parseIntent('雕像好看吗')?.params?.blueprintName ?? null, null)
}

// ---------------------------------------------------------------------------
// C. 歧义：两份图纸共用一个说法时要给候选，不能静默挑第一个
const AMBIGUOUS_ENTRIES = [
  { id: 'left_cabin', sayings: ['cabin'], naturalTier: 'L2', buildable: true },
  { id: 'right_cabin', sayings: ['cabin'], naturalTier: 'L2', buildable: true },
  { id: 'lonely_tower', sayings: ['lonely tower'], naturalTier: 'L2', buildable: true }
]

function testAmbiguousSayingReturnsCandidates () {
  const resolved = resolveBlueprintNameFromText('build a cabin', AMBIGUOUS_ENTRIES)
  assert.strictEqual(resolved.name, null, '歧义时不许直接给一个名字')
  assert.deepStrictEqual(resolved.candidates, ['left_cabin', 'right_cabin'])

  // 更长的说法赢，不算歧义
  const unambiguous = resolveBlueprintNameFromText('build a lonely tower', AMBIGUOUS_ENTRIES)
  assert.strictEqual(unambiguous.name, 'lonely_tower')
}

function testLongerSayingWins () {
  const entries = [
    { id: 'wood_cabin', sayings: ['wood cabin'], naturalTier: 'L2', buildable: true },
    { id: 'simple_wood_cabin_xl', sayings: ['simple wood cabin'], naturalTier: 'L2', buildable: true }
  ]
  assert.strictEqual(resolveBlueprintNameFromText('build a simple wood cabin', entries).name, 'simple_wood_cabin_xl')
  assert.strictEqual(resolveBlueprintNameFromText('build a wood cabin', entries).name, 'wood_cabin')
}

function testNoMatchStaysNull () {
  assert.strictEqual(resolveBlueprintNameFromText('build a spaceship'), null)
  assert.strictEqual(resolveBlueprintNameFromText(''), null)
  assert.strictEqual(resolveBlueprintNameFromText(null), null)
}

// ---------------------------------------------------------------------------
// D. 名单本身：从图纸派生，不是手抄
function testIndexIsDerivedFromBlueprints () {
  const { entries, skipped } = blueprintNameIndex()
  assert.deepStrictEqual(skipped, [], '有图纸加载不了')
  const ids = entries.map(entry => entry.id).sort()
  assert.deepStrictEqual(ids, [
    'castle_garden', 'chest_area', 'farm_plot', 'fence_area', 'fountain',
    'garden_manor', 'modern_villa', 'simple_farmhouse', 'simple_two_story_cabin',
    'simple_wood_cabin', 'small_house', 'starter_shelter', 'statue',
    'tower_cottage', 'two_story_wood_house'
  ], '名单应覆盖本地五份文件 + 程序生成的十份（后勤 18 加入 tower_cottage）')
  for (const entry of entries) {
    assert.ok(entry.sayings.length > 0, `${entry.id} 一个说法都没有`)
    assert.ok(entry.sayings.includes(entry.id), `${entry.id} 至少要认自己的 id`)
  }
}

function testEnglishSayingsComeFromTheId () {
  assert.deepStrictEqual(englishSayingsFor('simple_wood_cabin'), [
    'simple_wood_cabin', 'simple wood cabin', 'wood cabin'
  ])
  assert.deepStrictEqual(englishSayingsFor('statue'), ['statue'])
}

function testSharedTailsAreDropped () {
  // 两份图纸都叫得应的尾巴（house / cabin）不该被当成谁的说法
  const { entries } = blueprintNameIndex()
  const sayingOwners = new Map()
  for (const entry of entries) {
    for (const saying of entry.sayings) {
      sayingOwners.set(saying, (sayingOwners.get(saying) || 0) + 1)
    }
  }
  for (const [saying, owners] of sayingOwners) {
    assert.strictEqual(owners, 1, `说法「${saying}」被 ${owners} 份图纸同时认领`)
  }
}

// ---------------------------------------------------------------------------
// E. 复杂度档位：实测出来的，不是猜的
function testNaturalTierIsMeasured () {
  assert.strictEqual(naturalComplexityTierFor('statue'), 'L1')
  assert.strictEqual(naturalComplexityTierFor('fountain'), 'L1')
  assert.strictEqual(naturalComplexityTierFor('starter_shelter'), 'L1')
  assert.strictEqual(naturalComplexityTierFor('simple_wood_cabin'), 'L2')
  assert.strictEqual(naturalComplexityTierFor('simple_two_story_cabin'), 'L3')
  // 一档都不过的那几份如实返回 null
  assert.strictEqual(naturalComplexityTierFor('small_house'), null)
  assert.strictEqual(naturalComplexityTierFor('garden_manor'), null)
  assert.strictEqual(naturalComplexityTierFor('unknown_blueprint'), null)
}

function testNamedSmallBuildsGetTheirOwnTier () {
  // 「建个雕像」不带任何大小词 → 用雕像自己的档（L1），否则 L2 的 120 块下限会把它毙掉
  assert.strictEqual(parseIntent('建个雕像')?.params?.complexityTier, 'L1')
  assert.strictEqual(parseIntent('build a fountain')?.params?.complexityTier, 'L1')
  // 说了大小词就听玩家的，不许被自然档顶掉
  assert.strictEqual(parseIntent('建个精致的雕像')?.params?.complexityTier, 'L4')
  // 自然档就是 L2 的，行为与以前一致
  assert.strictEqual(parseIntent('建个小木屋')?.params?.complexityTier, 'L2')
  // 白名单里的图纸「按原样盖」：不带大小词时压根不挂档位（#66 之后 建个双层木屋
  // 与 建个小屋 都归这一类），但玩家一说大小词，档位照样回来
  assert.strictEqual(parseIntent('建个双层木屋')?.params?.complexityTier ?? null, null)
  assert.strictEqual(parseIntent('建个小屋')?.params?.complexityTier ?? null, null)
  assert.strictEqual(parseIntent('建个精致的双层木屋')?.params?.complexityTier, 'L4')
}

function testEveryBlueprintIsNowClaimable () {
  // 第 13 轮：一档都不过的六份故意不认领（认领只会把「盖错」变成「盖不了」）。
  // 第 14 轮：老板拍板（#66）把其中四份加进「按图纸原样盖」的白名单，于是十四份
  // 全部认领得起。判据问的是**白名单本身**，不是硬编码那四个名字——
  // 以后谁再往白名单里加一份，这里自动跟上。
  const { entries } = blueprintNameIndex({ fresh: true })
  const unclaimed = entries.filter(entry => entry.buildable === false).map(entry => entry.id)
  assert.deepStrictEqual(unclaimed, [], `还有图纸没被认领: ${unclaimed.join(',')}`)

  // 反向：认领的理由必须是「过了某一档」或「在白名单里」，不许两头落空
  for (const entry of entries) {
    assert.ok(
      entry.naturalTier !== null || entry.fixedScale === true,
      `${entry.id} 既没过任何一档也不在白名单，却被认领了`
    )
  }
  // 那四份的认领理由确实是白名单，而不是忽然过了某一档
  for (const id of ['small_house', 'two_story_wood_house', 'simple_farmhouse', 'garden_manor']) {
    const entry = entries.find(x => x.id === id)
    assert.strictEqual(entry.naturalTier, null, `${id} 不该忽然过档`)
    assert.strictEqual(entry.fixedScale, true, `${id} 应该靠白名单认领`)
  }
}

function testWhitelistedBlueprintsActuallySelect () {
  // #66 的真正判据：点名这四份，选择器要真的选得出来，而不是 no_usable_blueprint_candidate。
  // 反证是手工做的（把这四个 id 从白名单里删掉重跑 → 四份全部 no_usable_blueprint_candidate、
  // 本组变红），没有为此把白名单导出去——导出只为测试而改生产接口不划算。
  const selector = new BlueprintSelector({ allowCommunity: false, communityAvailable: false })
  for (const [phrase, expectedId] of [
    ['建个小屋', 'small_house'],
    ['建个双层木屋', 'two_story_wood_house'],
    ['建个农舍', 'simple_farmhouse'],
    ['建个花园庄园', 'garden_manor']
  ]) {
    const params = parseIntent(phrase)?.params || {}
    assert.strictEqual(params.blueprintName, expectedId, `「${phrase}」应解析成 ${expectedId}`)
    const selection = selector.selectBlueprint({
      blueprintName: params.blueprintName,
      ...(params.rawText ? { rawText: params.rawText } : {}),
      ...(params.designSpec ? { designSpec: params.designSpec } : {})
    })
    assert.strictEqual(selection.ok, true, `${expectedId} 仍然选不出来: ${selection.error}`)
  }
}

function testNaturalTierIsMeasured () {
  assert.strictEqual(naturalComplexityTierFor('statue'), 'L1')
  assert.strictEqual(naturalComplexityTierFor('fountain'), 'L1')
  assert.strictEqual(naturalComplexityTierFor('starter_shelter'), 'L1')
  assert.strictEqual(naturalComplexityTierFor('simple_wood_cabin'), 'L2')
  assert.strictEqual(naturalComplexityTierFor('simple_two_story_cabin'), 'L3')
  // 一档都不过的那几份如实返回 null
  assert.strictEqual(naturalComplexityTierFor('small_house'), null)
  assert.strictEqual(naturalComplexityTierFor('garden_manor'), null)
  assert.strictEqual(naturalComplexityTierFor('unknown_blueprint'), null)
}

function testNamedSmallBuildsGetTheirOwnTier () {
  // 「建个雕像」不带任何大小词 → 用雕像自己的档（L1），否则 L2 的 120 块下限会把它毙掉
  assert.strictEqual(parseIntent('建个雕像')?.params?.complexityTier, 'L1')
  assert.strictEqual(parseIntent('build a fountain')?.params?.complexityTier, 'L1')
  // 说了大小词就听玩家的，不许被自然档顶掉
  assert.strictEqual(parseIntent('建个精致的雕像')?.params?.complexityTier, 'L4')
  // 自然档就是 L2 的，行为与以前一致
  assert.strictEqual(parseIntent('建个小木屋')?.params?.complexityTier, 'L2')
  // 白名单里的图纸「按原样盖」：不带大小词时压根不挂档位（#66 之后 建个双层木屋
  // 与 建个小屋 都归这一类），但玩家一说大小词，档位照样回来
  assert.strictEqual(parseIntent('建个双层木屋')?.params?.complexityTier ?? null, null)
  assert.strictEqual(parseIntent('建个小屋')?.params?.complexityTier ?? null, null)
  assert.strictEqual(parseIntent('建个精致的双层木屋')?.params?.complexityTier, 'L4')
}

function testEveryBlueprintIsNowClaimable () {
  // 第 13 轮：一档都不过的六份故意不认领（认领只会把「盖错」变成「盖不了」）。
  // 第 14 轮：老板拍板（#66）把其中四份加进「按图纸原样盖」的白名单，于是十四份
  // 全部认领得起。判据问的是**白名单本身**，不是硬编码那四个名字——
  // 以后谁再往白名单里加一份，这里自动跟上。
  const { entries } = blueprintNameIndex({ fresh: true })
  const unclaimed = entries.filter(entry => entry.buildable === false).map(entry => entry.id)
  assert.deepStrictEqual(unclaimed, [], `还有图纸没被认领: ${unclaimed.join(',')}`)

  // 反向：认领的理由必须是「过了某一档」或「在白名单里」，不许两头落空
  for (const entry of entries) {
    assert.ok(
      entry.naturalTier !== null || entry.fixedScale === true,
      `${entry.id} 既没过任何一档也不在白名单，却被认领了`
    )
  }
  // 那四份的认领理由确实是白名单，而不是忽然过了某一档
  for (const id of ['small_house', 'two_story_wood_house', 'simple_farmhouse', 'garden_manor']) {
    const entry = entries.find(x => x.id === id)
    assert.strictEqual(entry.naturalTier, null, `${id} 不该忽然过档`)
    assert.strictEqual(entry.fixedScale, true, `${id} 应该靠白名单认领`)
  }
}

function testWhitelistedBlueprintsActuallySelect () {
  // #66 的真正判据：点名这四份，选择器要真的选得出来，而不是 no_usable_blueprint_candidate。
  // 反证是手工做的（把这四个 id 从白名单里删掉重跑 → 四份全部 no_usable_blueprint_candidate、
  // 本组变红），没有为此把白名单导出去——导出只为测试而改生产接口不划算。
  const selector = new BlueprintSelector({ allowCommunity: false, communityAvailable: false })
  for (const [phrase, expectedId] of [
    ['建个小屋', 'small_house'],
    ['建个双层木屋', 'two_story_wood_house'],
    ['建个农舍', 'simple_farmhouse'],
    ['建个花园庄园', 'garden_manor']
  ]) {
    const params = parseIntent(phrase)?.params || {}
    assert.strictEqual(params.blueprintName, expectedId, `「${phrase}」应解析成 ${expectedId}`)
    const selection = selector.selectBlueprint({
      blueprintName: params.blueprintName,
      ...(params.rawText ? { rawText: params.rawText } : {}),
      ...(params.designSpec ? { designSpec: params.designSpec } : {})
    })
    assert.strictEqual(selection.ok, true, `${expectedId} 仍然选不出来: ${selection.error}`)
  }
}

function testWhitelistIsWhatMakesThemSelectable () {
  // 反证：把这四份从白名单里拿掉，点名就又会被预算挡回 no_usable_blueprint_candidate
  const selector = new BlueprintSelector({ allowCommunity: false, communityAvailable: false })
  const removed = []
  for (const id of ['small_house', 'two_story_wood_house', 'simple_farmhouse', 'garden_manor']) {
    if (FIXED_SCALE_NAMED_BLUEPRINTS.delete(id)) removed.push(id)
  }
  try {
    assert.strictEqual(removed.length, 4, '这四份本该都在白名单里')
    for (const id of removed) {
      const selection = selector.selectBlueprint({ blueprintName: id, rawText: `build a ${id}` })
      assert.strictEqual(selection.ok, false, `${id} 离开白名单后不该还能选出来`)
      assert.strictEqual(selection.error, 'no_usable_blueprint_candidate')
    }
  } finally {
    for (const id of removed) FIXED_SCALE_NAMED_BLUEPRINTS.add(id)
  }
  // 放回去之后立刻恢复
  assert.strictEqual(
    selector.selectBlueprint({ blueprintName: 'garden_manor', rawText: 'build a garden manor' }).ok,
    true
  )
}

// ---------------------------------------------------------------------------
// F. 后勤 18（决策 #92）：开发设计的中等民居「塔楼小筑」
//
// 图纸本身放进 blueprints/ 就自动进名单（本地文件那条路），中文说法跟着
// metadata.zhNames 走。唯一缺的一环是英文：id 只能派生出 "tower cottage"，
// 而「medium house」谁也猜不出来——所以 metadata.enNames 这一路本轮接上了。
function testTowerCottageAnswersToAllFiveSayings () {
  for (const saying of [
    '建个塔楼小筑',
    '建个带塔楼的房子',
    '建个塔楼房子',
    '建个中等房子',
    'build a tower cottage',
    'build a medium house'
  ]) {
    assert.strictEqual(blueprintFor(saying), 'tower_cottage', `「${saying}」应解析成 tower_cottage`)
  }
}

function testTowerCottageIsBuildableAtItsMeasuredTier () {
  // 元数据里写的是 L3，实测只有 L4 的预算装得下（715 块 / 14×10 占地 / 19 种材料）。
  // 名单用实测值，所以点它不会被档位预算挡掉，也不会被换成别的图纸。
  assert.strictEqual(naturalComplexityTierFor('tower_cottage'), 'L4')
  const entry = blueprintNameIndex().entries.find(item => item.id === 'tower_cottage')
  assert.ok(entry, '名单里应该有 tower_cottage')
  assert.strictEqual(entry.buildable, true)
  assert.strictEqual(entry.fixedScale, false, '它自己能装进 L4，不需要固定尺度白名单')
  assert.strictEqual(entry.displayName, '塔楼小筑')

  // 端到端：拿解析器实际产出的参数去选图纸（它会带上实测的 L4 档位；
  // 只给名字不给档位会退回文本推断的 L2，那份预算装不下 716 块——
  // 这正是名单用实测档位的原因）
  const selector = new BlueprintSelector()
  const params = parseIntent('建个塔楼小筑').params
  assert.strictEqual(params.complexityTier, 'L4')
  const selected = selector.selectBlueprint({ ...params, rawText: '建个塔楼小筑' })
  assert.strictEqual(selected.ok, true, selected.error)
  assert.strictEqual(selected.blueprint.name, 'tower_cottage')
  const solid = selected.blueprint.blocks.filter(block => !/air$/.test(String(block.type || ''))).length
  // 老板决策 #94（后勤 19）：塔楼三层那只够不着的箱子 11,9,1 删掉，716 -> 715。
  // 这条断言钉的是「选出来的是这份图纸本身、没被档位兜底换成别的」，块数只是它的指纹。
  assert.strictEqual(solid, 715, '选出来的必须是那份 715 块的原稿，不是被换掉的')
}

function testTowerCottageDidNotStealAnyoneElsesSaying () {
  // 「中等房子」「medium house」是它独有的说法；别的图纸的老说法一个都不能变。
  // testLegacySayingsUnchanged 已经钉住了老说法，这里只补最容易被抢的三句。
  assert.strictEqual(blueprintFor('建个小屋'), 'small_house')
  assert.strictEqual(blueprintFor('建个小木屋'), 'simple_wood_cabin')
  assert.strictEqual(blueprintFor('build a house'), 'simple_wood_cabin')
  // 反向：同一个说法不该在一份图纸里出现两次（enNames 与 id 派生撞车时要去重）
  for (const entry of blueprintNameIndex().entries) {
    assert.strictEqual(new Set(entry.sayings).size, entry.sayings.length, `${entry.id} 的说法有重复`)
  }
}

testEveryBlueprintHasASaying()
testTheFiveThatUsedToBeUnreachable()
testLegacySayingsUnchanged()
testNonBuildIntentsUntouched()
testAmbiguousSayingReturnsCandidates()
testLongerSayingWins()
testNoMatchStaysNull()
testIndexIsDerivedFromBlueprints()
testEnglishSayingsComeFromTheId()
testSharedTailsAreDropped()
testNaturalTierIsMeasured()
testNamedSmallBuildsGetTheirOwnTier()
testEveryBlueprintIsNowClaimable()
testWhitelistedBlueprintsActuallySelect()
testTowerCottageAnswersToAllFiveSayings()
testTowerCottageIsBuildableAtItsMeasuredTier()
testTowerCottageDidNotStealAnyoneElsesSaying()

console.log('intent blueprint name tests passed')
