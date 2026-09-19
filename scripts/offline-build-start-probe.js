'use strict'
// 开工级离线探针（后勤第 21 轮，决策 #98 之后补的那一段）。
//
// 后勤 18/19 离线全过、建造 26 真机却 20 ms 开不了工：离线验的是「选图纸 → 编施工单 →
// 宜居硬闸」，而真机死在两者之间的 previewBlueprint 路由（L4 本地图纸被送去取社区样板）。
// 这支探针把那一段补上：一句说法 → parseIntent → BuildingSystem.previewBlueprint，
// 断言拿到施工单，并记下走的是哪条路。
//
// 永不进游戏：假 bot、平地假世界、空背包、不落施工档案（constructionRunStore=false）。
// 样本库两种口径各跑一遍：
//   empty      空样本库（本 worktree 的缓存索引就是 0 份）
//   main-cache 主仓缓存索引的只读副本——真机上那只 bot 看到的就是这 4 份
//
// 用法：node scripts/offline-build-start-probe.js [--json=<输出路径>] [--main-cache=<主仓 cache/index.json>]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseIntent } = require('../ai/intent-parser')
const { blueprintNameIndex } = require('../ai/blueprint-name-index')
const { BuildingSystem } = require('../systems/building-system')
const { BlueprintSelector } = require('../systems/blueprint-selector')
const { CommunityBlueprintIndex } = require('../systems/community-blueprint-index')
const { CommunityBuildCollector } = require('../systems/community-build-collector')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { WorldMemory } = require('../memory/world-memory')

const DEFAULT_MAIN_CACHE = 'D:/code/MC-blueprint-ir-v1/data/community-builds/cache/index.json'
const ORIGIN = { x: 0, y: 64, z: 0 }

function argValue(name, fallback = null) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function vec(x, y, z) {
  return { x, y, z, distanceTo: other => Math.hypot(x - other.x, y - other.y, z - other.z) }
}

function createProbeContext(logs) {
  const bot = {
    entity: { position: vec(ORIGIN.x, ORIGIN.y, ORIGIN.z) },
    heldItem: null,
    registry: { blocksByName: {}, itemsByName: {}, itemsArray: [] },
    inventory: { items: () => [], slots: Array.from({ length: 45 }, () => null) },
    pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
    blockAt: position => ({
      name: position.y === ORIGIN.y - 1 ? 'grass_block' : (position.y < ORIGIN.y - 1 ? 'stone' : 'air'),
      position
    })
  }
  return {
    bot,
    actionLock: new ActionLock(),
    protectedBuildingRunStorePath: 'nonexistent-offline-probe-run-store.json',
    blackboard: new Blackboard({
      bot: { position: { ...ORIGIN } },
      inventory: { counts: {} },
      mobs: { dangerLevel: 'none' }
    }),
    memory: { world: new WorldMemory(path.join(os.tmpdir(), `offline-start-probe-${process.pid}-${Date.now()}.json`), { autosave: false }) },
    logger: { log: message => logs.push(String(message)) },
    debug() {}
  }
}

// 主仓索引里的 localBlueprintPath 是相对主仓根目录的；复制一份到临时目录并改成绝对路径，
// 主仓本身一个字节都不写。
function readOnlyCacheCopy(indexPath) {
  if (!indexPath || !fs.existsSync(indexPath)) return null
  const root = path.resolve(path.dirname(indexPath), '..', '..', '..')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  for (const sample of index.samples || []) {
    if (sample.localBlueprintPath && !path.isAbsolute(sample.localBlueprintPath)) {
      sample.localBlueprintPath = path.join(root, sample.localBlueprintPath)
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-start-probe-cache-'))
  const copy = path.join(dir, 'index.json')
  fs.writeFileSync(copy, JSON.stringify(index), 'utf8')
  return { path: copy, samples: (index.samples || []).length }
}

function emptyCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-start-probe-empty-'))
  const copy = path.join(dir, 'index.json')
  fs.writeFileSync(copy, JSON.stringify({ version: 1, samples: [] }), 'utf8')
  return { path: copy, samples: 0 }
}

function createProbeSystem(cacheIndexPath) {
  const system = new BuildingSystem({
    constructionRunStore: false,
    selector: new BlueprintSelector({ index: new CommunityBlueprintIndex({ cacheIndexPath }) }),
    communityCollector: new CommunityBuildCollector({ cacheIndexPath })
  })
  // 只记账不改行为：看它最后进了哪条路
  const route = { value: 'selection_or_gate' }
  const wrap = (name, label) => {
    const original = system[name].bind(system)
    system[name] = (...args) => {
      route.value = label
      return original(...args)
    }
  }
  wrap('previewFaithfulCommunityBlueprint', 'community_faithful')
  wrap('previewBudgetedSimpleBlueprint', 'budget')
  const loadSamples = system.communityCollector.loadSamples.bind(system.communityCollector)
  system.communityCollector.loadSamples = (...args) => {
    route.value = 'community_samples'
    return loadSamples(...args)
  }
  return { system, route }
}

function probeSaying(saying, cacheIndexPath) {
  const intent = parseIntent(saying)
  const row = {
    saying,
    actionKey: intent?.actionKey || null,
    intentBlueprint: intent?.params?.blueprintName || null,
    tier: intent?.params?.designSpec?.complexityTier || intent?.params?.complexityTier || null
  }
  if (!row.intentBlueprint) return { ...row, ok: false, route: 'intent', error: 'intent_has_no_blueprint' }

  const logs = []
  const { system, route } = createProbeSystem(cacheIndexPath)
  const started = Date.now()
  let preview
  try {
    preview = system.previewBlueprint(createProbeContext(logs), row.intentBlueprint, { ...ORIGIN }, {
      rawText: intent.params.rawText || intent.rawText || saying,
      complexityTier: intent.params.complexityTier || null,
      designSpec: intent.params.designSpec || null,
      confirmedComplexity: intent.params.confirmedComplexity === true,
      ...(intent.params.forceRebuild === true ? { forceRebuild: true, rebuild: true } : {}),
      ...(intent.params.resumeOnly === true ? { resumeOnly: true } : {}),
      explicitOrigin: true
    })
  } catch (err) {
    preview = { ok: false, error: `threw:${err.message}` }
  }
  const steps = preview.orderPlan?.steps || []
  return {
    ...row,
    ok: preview.ok === true && Boolean(preview.constructionPlan?.planId),
    route: route.value,
    selected: preview.selectedBlueprint?.blueprintName || null,
    selectedSource: preview.selectedBlueprint?.sourceKind || null,
    sampleId: preview.selectedBlueprint?.id || null,
    planId: preview.constructionPlan?.planId || null,
    totalSteps: steps.length,
    placeSteps: steps.filter(step => step.action === 'place_block').length,
    error: preview.ok ? null : (preview.error || 'unknown'),
    ms: Date.now() - started
  }
}

function defaultSayings() {
  return blueprintNameIndex().entries.map(entry => ({
    id: entry.id,
    source: entry.source,
    saying: `建个${entry.zhSayings[0] || entry.englishSayings[0]}`
  }))
}

function runProbe(options = {}) {
  const configs = []
  configs.push({ name: 'empty', cache: emptyCache() })
  const main = readOnlyCacheCopy(options.mainCache === undefined ? DEFAULT_MAIN_CACHE : options.mainCache)
  if (main) configs.push({ name: 'main-cache', cache: main })

  const rows = []
  for (const entry of options.sayings || defaultSayings()) {
    for (const config of configs) {
      rows.push({ id: entry.id, source: entry.source, config: config.name, ...probeSaying(entry.saying, config.cache.path) })
    }
  }
  return { configs: configs.map(config => ({ name: config.name, samples: config.cache.samples })), rows }
}

if (require.main === module) {
  const result = runProbe({ mainCache: argValue('main-cache', DEFAULT_MAIN_CACHE) })
  console.log('config     说法                         意图图纸                档位  路径                选中                        来源                   成败  步数(放置)  planId / 错误')
  for (const row of result.rows) {
    console.log([
      row.config.padEnd(10),
      row.saying.padEnd(22),
      String(row.intentBlueprint).padEnd(22),
      String(row.tier || '-').padEnd(4),
      row.route.padEnd(18),
      String(row.selected || '-').padEnd(26),
      String(row.selectedSource || '-').padEnd(20),
      (row.ok ? 'OK' : 'FAIL').padEnd(4),
      `${row.totalSteps}(${row.placeSteps})`.padEnd(10),
      row.ok ? row.planId : row.error
    ].join(' '))
  }
  const out = argValue('json')
  if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2))
}

module.exports = { probeSaying, runProbe, createProbeSystem, emptyCache }
