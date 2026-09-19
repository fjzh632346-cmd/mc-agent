// 后勤 21 / 老板决策 #98：本地手工图纸不管档位都走「按预算直接盖」。
//
// 建造 26 真机：「建个塔楼小筑」20 ms 内失败 5/5，理由 verified_real_community_samples_unavailable。
// 塔楼小筑实测 L4，档位 > L3 就被 previewBlueprint 送去取社区样板，缓存里没有同风格的 → 失败。
// 这一份钉住：本地手工图纸（local_library + localName，且图纸 metadata 声明了档位）
// 直进预算路、不碰样本库；社区原样导入、生成器回落、没声明档位的老模板
// （small_house）、其余档位分支逐字不变。
const assert = require('assert')
const { parseIntent } = require('../ai/intent-parser')
const { BuildingSystem } = require('../systems/building-system')
const { BlueprintLoader } = require('../systems/blueprint-loader')
const { probeSaying, emptyCache } = require('../scripts/offline-build-start-probe')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { WorldMemory } = require('../memory/world-memory')
const os = require('os')
const path = require('path')

const ORIGIN = { x: 0, y: 64, z: 0 }

function vec(x, y, z) {
  return { x, y, z, distanceTo: other => Math.hypot(x - other.x, y - other.y, z - other.z) }
}

function createContext() {
  return {
    bot: {
      entity: { position: vec(0, 64, 0) },
      heldItem: null,
      registry: { blocksByName: {}, itemsByName: {}, itemsArray: [] },
      inventory: { items: () => [], slots: Array.from({ length: 45 }, () => null) },
      pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
      blockAt: position => ({ name: position.y === 63 ? 'grass_block' : (position.y < 63 ? 'stone' : 'air'), position })
    },
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-test-run-store.json',
    blackboard: new Blackboard({ bot: { position: { ...ORIGIN } }, inventory: { counts: {} }, mobs: { dangerLevel: 'none' } }),
    memory: { world: new WorldMemory(path.join(os.tmpdir(), `mc-r21-${Date.now()}-${Math.random()}.json`), { autosave: false }) },
    logger: { log() {} },
    debug() {}
  }
}

// 样本库替身：不管问什么都答「没有同风格的 verified 样本」——真机缓存对塔楼小筑就是这个答复。
// 被调用一次就记一笔，路由没进样本路时它应该一次都没被问到。
function refusingCollector() {
  return {
    calls: 0,
    loadSamples() {
      this.calls += 1
      return { ok: false, error: 'verified_real_community_samples_unavailable' }
    }
  }
}

function previewFromSaying(system, saying, extra = {}) {
  const intent = parseIntent(saying)
  return system.previewBlueprint(createContext(), intent.params.blueprintName, { ...ORIGIN }, {
    rawText: intent.params.rawText || saying,
    complexityTier: intent.params.complexityTier || null,
    designSpec: intent.params.designSpec || null,
    explicitOrigin: true,
    ...extra
  })
}

function towerCottageSelection(selectedOverrides = {}, blueprintMetadataOverrides = null) {
  const loaded = new BlueprintLoader().loadBlueprint('tower_cottage')
  assert.strictEqual(loaded.ok, true, loaded.error)
  if (blueprintMetadataOverrides) loaded.blueprint.metadata = blueprintMetadataOverrides(loaded.blueprint.metadata || {})
  return {
    selectBlueprint() {
      return {
        ok: true,
        blueprint: loaded.blueprint,
        selected: {
          id: 'local-json-tower_cottage',
          blueprintName: 'tower_cottage',
          sourceKind: 'local_library',
          localName: 'tower_cottage',
          localBlueprintPath: null,
          generatorKey: null,
          sourceMode: null,
          complexityTier: 'L4',
          ...selectedOverrides
        },
        candidates: [],
        attempted: []
      }
    }
  }
}

// 1. 正向：「建个塔楼小筑」→ L4 → 样本库一份都给不出 → 仍然出施工单，而且根本没去问样本库
function testTowerCottageL4BuildsWithoutCommunitySamples() {
  const intent = parseIntent('建个塔楼小筑')
  assert.strictEqual(intent.params.blueprintName, 'tower_cottage')
  assert.strictEqual(intent.params.designSpec.complexityTier, 'L4')

  const collector = refusingCollector()
  const system = new BuildingSystem({ constructionRunStore: false, communityCollector: collector })
  const preview = previewFromSaying(system, '建个塔楼小筑')

  assert.strictEqual(preview.ok, true, preview.error)
  assert.strictEqual(collector.calls, 0)
  assert.ok(String(preview.constructionPlan.planId).startsWith('construction_plan_'))
  assert.strictEqual(preview.orderPlan.steps.filter(step => step.action === 'place_block').length, 715)
  assert.strictEqual(preview.selectedBlueprint.sourceKind, 'local_library')
  assert.strictEqual(preview.designDiagnostics.complexityBudgetPreserved, true)
}

// 1'. 真机那份空样本库口径（探针同一套假世界）也要过——这支探针以后新图纸入库都要跑
function testStartProbeTowerCottageOnEmptyLibrary() {
  const row = probeSaying('建个塔楼小筑', emptyCache().path)
  assert.strictEqual(row.ok, true, row.error)
  assert.strictEqual(row.route, 'budget')
  assert.strictEqual(row.placeSteps, 715)
}

// 2. 续建/重建（designSpec=null）同样不该落到样本路——建造 26 列的「没有不改代码的绕法」之一
function testTowerCottageRebuildWithoutDesignSpecStaysOnBudgetRoute() {
  const collector = refusingCollector()
  const system = new BuildingSystem({ constructionRunStore: false, communityCollector: collector })
  const preview = system.previewBlueprint(createContext(), 'tower_cottage', { ...ORIGIN }, {
    rawText: '重建塔楼小筑',
    forceRebuild: true,
    rebuild: true,
    explicitOrigin: true
  })
  assert.strictEqual(preview.ok, true, preview.error)
  assert.strictEqual(collector.calls, 0)
}

// 3. 反证：同一份图纸若被标成社区原样导入 → 仍走社区原样路，不进预算路
function testSameBlueprintMarkedCommunityImportKeepsCommunityRoute() {
  const collector = refusingCollector()
  const system = new BuildingSystem({
    constructionRunStore: false,
    communityCollector: collector,
    selector: towerCottageSelection({
      sourceKind: 'real_community_import',
      sourceMode: 'faithful-community-import',
      localName: null,
      localBlueprintPath: 'data/community-builds/cache/blueprints/fake.json'
    })
  })
  let faithful = 0
  let budget = 0
  system.previewFaithfulCommunityBlueprint = () => { faithful += 1; return { ok: false, error: 'faithful_route_probe_stop' } }
  system.previewBudgetedSimpleBlueprint = () => { budget += 1; return { ok: false, error: 'budget_route_probe_stop' } }

  // isFaithfulCommunityImport 看的是图纸自己的 metadata，所以把标记也打在图纸上
  const selection = system.selector.selectBlueprint()
  selection.blueprint.metadata = { ...selection.blueprint.metadata, sourceKind: 'real_community_import', sourceMode: 'faithful-community-import', faithfulCommunityImport: true }
  system.selector = { selectBlueprint: () => selection }

  const preview = previewFromSaying(system, '建个塔楼小筑')
  assert.strictEqual(preview.error, 'faithful_route_probe_stop')
  assert.strictEqual(faithful, 1)
  assert.strictEqual(budget, 0)
}

// 3'. 反证：本地库候选里「其实是走路径加载 / 其实回落到了生成器」的，不算本地手工图纸 → 照旧取样本
function testLocalLookalikesStillAskForSamples() {
  for (const overrides of [
    { localBlueprintPath: 'data/community-builds/cache/blueprints/fake.json' },
    { generatorKey: 'tower_cottage' },
    { localName: null },
    { sourceKind: 'community_index' }
  ]) {
    const collector = refusingCollector()
    const system = new BuildingSystem({
      constructionRunStore: false,
      communityCollector: collector,
      selector: towerCottageSelection(overrides)
    })
    const preview = previewFromSaying(system, '建个塔楼小筑')
    assert.strictEqual(preview.ok, false, JSON.stringify(overrides))
    assert.strictEqual(preview.error, 'verified_real_community_samples_unavailable', JSON.stringify(overrides))
    assert.strictEqual(collector.calls, 1, JSON.stringify(overrides))
  }
}

// 3''. 反证：本地图纸但没在 metadata 里声明档位（small_house 那种老模板）→ 照旧取样本、走设计师改造
function testUndeclaredLocalTemplateKeepsDesignerRoute() {
  const collector = refusingCollector()
  const system = new BuildingSystem({
    constructionRunStore: false,
    communityCollector: collector,
    selector: towerCottageSelection({}, metadata => {
      const copy = { ...metadata }
      delete copy.complexityTier
      return copy
    })
  })
  const preview = previewFromSaying(system, '建个塔楼小筑')
  assert.strictEqual(preview.error, 'verified_real_community_samples_unavailable')
  assert.strictEqual(collector.calls, 1)
}

// 3'''. 回归：「建个小房子」照旧不进预算路（它有现成验收要求设计师改造）
function testSmallHouseTemplateStillAsksForSamples() {
  const collector = refusingCollector()
  const system = new BuildingSystem({ constructionRunStore: false, communityCollector: collector })
  const preview = previewFromSaying(system, '建个小房子')
  assert.strictEqual(preview.error, 'verified_real_community_samples_unavailable')
  assert.strictEqual(collector.calls, 1)
}

// 4. 回归：低档生成器回落（简易木屋 L2）照旧走预算路、照旧不问样本库
function testLowTierProceduralCabinUnchanged() {
  const collector = refusingCollector()
  const system = new BuildingSystem({ constructionRunStore: false, communityCollector: collector })
  const preview = previewFromSaying(system, '建个简易木屋')
  assert.strictEqual(preview.ok, true, preview.error)
  assert.strictEqual(preview.selectedBlueprint.sourceKind, 'procedural_fallback')
  assert.strictEqual(collector.calls, 0)
}

// 4'. 回归：生成式图纸在高档/固定尺度下照旧去取样本（#98 只放本地手工图纸）
function testGeneratedBlueprintStillAsksForSamples() {
  const collector = refusingCollector()
  const system = new BuildingSystem({ constructionRunStore: false, communityCollector: collector })
  const preview = previewFromSaying(system, '建个农舍')
  assert.strictEqual(preview.ok, false)
  assert.strictEqual(preview.error, 'verified_real_community_samples_unavailable')
  assert.strictEqual(collector.calls, 1)
}

function run() {
  testTowerCottageL4BuildsWithoutCommunitySamples()
  testStartProbeTowerCottageOnEmptyLibrary()
  testTowerCottageRebuildWithoutDesignSpecStaysOnBudgetRoute()
  testSameBlueprintMarkedCommunityImportKeepsCommunityRoute()
  testLocalLookalikesStillAskForSamples()
  testUndeclaredLocalTemplateKeepsDesignerRoute()
  testSmallHouseTemplateStillAsksForSamples()
  testLowTierProceduralCabinUnchanged()
  testGeneratedBlueprintStillAsksForSamples()
  console.log('local blueprint budget route tests passed')
}

run()
