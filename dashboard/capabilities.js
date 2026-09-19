'use strict';
/**
 * 能力地图 —— 从代码里直接读出「林夏现在会做什么」
 *
 * 全部只读，零依赖。三类信息来源：
 *   1) require 真模块（常量文件，无副作用）：能力清单、仲裁优先级档位
 *   2) 静态扫描源码：能力 → 任务 的落点、入队优先级、任务要抢哪几把锁
 *   3) 人工写的白话名（下方 LABELS），只负责"翻译"，不决定任何逻辑
 *
 * 代码里加了新能力而这里没写白话名 —— 照样会出现在网页上，
 * 只是显示英文 key，并标一个"待补说明"。不会漏。
 */

const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------- 白话翻译表 */
// [中文名, 一句话说明, 领域]
const LABELS = {
  FOLLOW_PLAYER:            ['跟着我走', '你走到哪它跟到哪，保持两格距离', '陪伴跟随'],
  RETURN_TO_PLAYER:         ['回到我身边', '不管在多远，放下手上的活走回来', '陪伴跟随'],

  MINE:                     ['去挖矿', '按方块名去挖，默认挖 8 个', '采集挖掘'],
  MINE_BLOCK:               ['挖掉这个方块', '指定某种方块，挖到够数为止', '采集挖掘'],
  FIND_ORE:                 ['找矿脉', '找到矿就一直挖到挖完，最远 32 格', '采集挖掘'],
  PICKUP_ITEM:              ['捡东西', '把地上的掉落物捡起来', '采集挖掘'],
  PICKUP_NEARBY_ITEMS:      ['把附近的都捡了', '16 格内的掉落物一次收干净', '采集挖掘'],

  CRAFT_ITEM:               ['合成物品', '按配方做东西，缺料会说缺什么', '制作冶炼'],
  SMELT_ITEM:               ['烧炼', '用熔炉把矿石烧成锭', '制作冶炼'],
  COOK_ITEM:                ['做熟食', '把生肉之类烤熟', '制作冶炼'],
  USE_FURNACE:              ['用熔炉', '直接指挥熔炉干活', '制作冶炼'],

  BUILD:                    ['盖房子', '按图纸从头建一座建筑，项目里最重的一块', '建造'],

  REMEMBER_CHEST:           ['记住这个箱子', '把箱子位置记下来，以后直接叫名字', '存储管理'],
  STORE_ITEMS:              ['把东西存进去', '走到箱子边把背包里的东西放进去', '存储管理'],
  TAKE_ITEMS:               ['从箱子拿东西', '按名字去箱子里取', '存储管理'],
  TRANSFER_ITEMS:           ['箱子之间倒腾', '从一个箱子搬到另一个', '存储管理'],
  CHECK_STORAGE:            ['箱子里有什么', '不用跑过去，直接报存货', '存储管理'],
  FETCH_TOOL_FROM_STORAGE:  ['去拿工具', '自己去箱子里找合适的镐子斧头', '存储管理'],
  FETCH_FOOD_FROM_STORAGE:  ['去拿吃的', '饿了自己去箱子翻食物', '存储管理'],

  REMEMBER_FARM:            ['记住这块地', '把农田位置记下来', '农业种植'],
  HARVEST_FARM:             ['收庄稼', '把熟了的小麦割掉', '农业种植'],
  PLANT_WHEAT:             ['种小麦', '把种子补种回空地', '农业种植'],
  FARM_CYCLE:               ['照看农田', '收割加补种，一轮跑完', '农业种植'],
  MAKE_BREAD:               ['做面包', '有小麦就自己做成面包', '农业种植'],

  EXPLORE_NEARBY:           ['四处看看', '在附近转一圈认路', '探索寻路'],
  SAFE_EXPLORE:             ['小心地探索', '边走边躲危险，血少就撤', '探索寻路'],
  FIND_PLACE_OR_RESOURCE:   ['帮我找个地方', '找村庄、找水、找特定资源', '探索寻路'],
  SCOUT_AREA:               ['探一片区域', '按范围系统性地扫一遍', '探索寻路'],
  FIND_RESOURCE_AREA:       ['找资源点', '定位矿区、林区这类成片资源', '探索寻路'],
  CHECK_EXPLORED_AREAS:     ['去过哪些地方', '只是回答，不动身', '探索寻路'],

  EAT_FOOD:                 ['吃东西', '饿了就吃，背包没有会去箱子拿', '生存自保'],
  CHECK_FOOD:               ['还有吃的吗', '报一下食物存量', '生存自保'],
  SLEEP:                    ['去睡觉', '找床睡到天亮', '生存自保'],
  WAKE_UP:                  ['起床', '立刻从床上起来', '生存自保'],
  CHECK_SURVIVAL_STATUS:    ['你还好吗', '报血量、饥饿、周围危险', '生存自保'],
  ENABLE_SAFE_MODE:         ['开安全模式', '之后一切以保命优先', '生存自保'],
  DISABLE_SAFE_MODE:        ['关安全模式', '恢复正常干活', '生存自保'],
  RETURN_SAFE:              ['撤回安全的地方', '不安全就往家或往你那边撤', '生存自保'],
  RETURN_IF_UNSAFE:         ['不对劲就回来', '探索途中的自动撤退开关', '生存自保'],
  PRIORITIZE_SURVIVAL:      ['先保命', '把保命任务插到队列最前面', '生存自保'],
  RETURN_TO_BASE:           ['回家', '走回记住的基地位置', '生存自保'],

  PREPARE_COMBAT:           ['准备打架', '穿装备、拿武器、吃饱，一套做完', '战斗防卫'],
  ATTACK_HOSTILE:           ['打那个怪', '主动攻击附近敌对生物', '战斗防卫'],
  GUARD_PLAYER:             ['守着我', '待在你身边，有怪就打', '战斗防卫'],
  CHECK_ARMOR:              ['装备怎么样', '报当前盔甲和武器', '战斗防卫'],
  EQUIP_ARMOR:              ['穿上盔甲', '把背包里最好的一套穿上', '战斗防卫'],
  FETCH_AND_EQUIP_ARMOR:    ['去拿盔甲穿上', '背包没有就先去箱子取再穿', '战斗防卫'],
  FETCH_WEAPON_FROM_STORAGE:['去拿武器', '自己去箱子里找剑', '战斗防卫'],

  STOP_CURRENT_TASK:        ['停', '立刻停下手上的活', '任务控制'],
  CANCEL_TASK:              ['这个不做了', '取消当前任务，不再恢复', '任务控制'],
  PAUSE_TASK:               ['先等等', '挂起，待会儿能接着做', '任务控制'],
  RESUME_TASK:              ['继续', '把挂起的活捡回来', '任务控制'],
  PLAN:                     ['自己想个计划', '把一句大目标拆成一串任务', '任务控制'],

  GET_STATUS:               ['你在干嘛', '报当前任务和队列', '信息问答'],
  CHECK_INVENTORY:          ['背包里有什么', '列出背包内容', '信息问答'],
  CHECK_ITEM_IN_INVENTORY:  ['有没有某样东西', '查一件specific物品在不在', '信息问答'],
  COUNT_ITEM_IN_INVENTORY:  ['有几个', '数某样东西的数量', '信息问答'],
  REMEMBER_LOCATION:        ['记住这个地方', '把当前坐标存成家或地标', '信息问答'],
  CHAT:                     ['纯聊天', '不干活，只是说话', '信息问答'],
};

const DOMAIN_ORDER = [
  '生存自保', '战斗防卫', '陪伴跟随', '采集挖掘', '制作冶炼',
  '建造', '存储管理', '农业种植', '探索寻路', '任务控制', '信息问答',
];

// 六把锁的白话解释（来自 core/action-lock.js）
const LOCK_LABELS = {
  movement:  ['走动', '同一时间只能有一件事指挥脚'],
  combat:    ['打斗', '避免两个任务同时挥剑'],
  inventory: ['背包', '防止两边同时翻背包导致物品错乱'],
  digging:   ['挖掘', '同一时间只挖一处'],
  building:  ['放置', '盖房子时独占，别人不能乱放方块'],
  crafting:  ['合成', '工作台和熔炉一次一个任务用'],
};

const TIERS = {
  CRITICAL: { rank: 4, name: '保命级', desc: '任何时候都能打断别的活' },
  HIGH:     { rank: 3, name: '优先',   desc: '排在常规任务前面' },
  MEDIUM:   { rank: 2, name: '常规',   desc: '按先来后到排队' },
  LOW:      { rank: 1, name: '闲时',   desc: '谁都能把它挤下去' },
};

/* ------------------------------------------------------------ 读源码 */

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

/** 从 ai/intent-to-task.js 的 switch 里解析：能力 → 任务类型 + 入队优先级 */
function parseIntentRouting(root) {
  const src = readIfExists(path.join(root, 'ai', 'intent-to-task.js'));
  if (!src) return {};

  // 顶部的数字常量（BUILD 的优先级就写成 PLAYER_BUILD_PRIORITY）
  const consts = {};
  for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*(\d{1,2})\b/g)) consts[m[1]] = Number(m[2]);

  // 从一段代码里取"入队优先级"：可能是数字、常量名，或 a ? 4 : 6 这种
  const priorityOf = (text) => {
    const tern = [...text.matchAll(/\?\s*(\d{1,2})\s*:\s*(\d{1,2})\s*(?:,\s*[\w.?]+\s*)?\)/g)];
    if (tern.length) {
      const t = tern[tern.length - 1];
      const a = Number(t[1]), b = Number(t[2]);
      return { value: Math.max(a, b), label: `${Math.min(a, b)}~${Math.max(a, b)}` };
    }
    const num = [...text.matchAll(/[},]\s*(\d{1,2})\s*(?:,\s*[\w.?]+\s*)?\)/g)];
    if (num.length) { const v = Number(num[num.length - 1][1]); return { value: v, label: String(v) }; }
    const cst = [...text.matchAll(/[},]\s*([A-Z][A-Z0-9_]{2,})\s*(?:,\s*[\w.?]+\s*)?\)/g)];
    for (let i = cst.length - 1; i >= 0; i--) {
      const v = consts[cst[i][1]];
      if (v != null) return { value: v, label: String(v) };
    }
    return null;
  };

  // 先摸清各个 helper 最终把活派给哪个任务、用什么优先级
  const helpers = {};
  for (const m of src.matchAll(/function\s+(\w+)\s*\(/g)) {
    const win = src.slice(m.index, m.index + 900);
    const hit = win.match(/enqueueRequired\(\s*context\s*,\s*'([a-z_]+)'/) ||
                win.match(/taskManager\.enqueue\(\s*'([a-z_]+)'/) ||
                win.match(/returnCommand\(\s*context\s*,[^,]*?'(return_to_[a-z_]+)'/);
    if (hit) {
      helpers[m[1]] = { taskType: hit[1], priority: priorityOf(win) };
    }
  }
  if (!helpers.returnCommand) helpers.returnCommand = { taskType: 'return_to_player', priority: null };

  const at = src.indexOf('switch (decision.actionKey)');
  if (at < 0) return {};
  const lines = src.slice(at).split('\n');

  const out = {};
  let pending = [];
  let buf = [];

  const flush = () => {
    if (!pending.length) { buf = []; return; }
    const text = buf.join('\n');
    let taskType = null, priority = null;

    const direct = text.match(/enqueue\w*\(\s*context\s*,\s*'([a-z_]+)'/);
    if (direct) taskType = direct[1];
    else {
      const call = text.match(/return\s+(\w+)\(/);
      const h = call && helpers[call[1]];
      if (h) { taskType = h.taskType; priority = h.priority; }
    }
    const own = priorityOf(text);
    if (own) priority = own;

    for (const k of pending) out[k] = { taskType, priority: taskType ? priority : null };
    pending = [];
    buf = [];
  };

  for (const ln of lines) {
    const c = ln.match(/^\s*case ACTION_KEYS\.([A-Z_]+):/);
    if (c) {
      if (buf.join('').trim()) flush();       // 上一段结束
      pending.push(c[1]);                      // 连着写的 case 共用同一段
      continue;
    }
    if (/^\s{4}default:/.test(ln)) { flush(); break; }
    if (pending.length) buf.push(ln);
  }
  flush();
  return out;
}

/** 从 tasks/*.js 的 requiredLocks 里解析：任务 → 要抢哪几把锁 */
function parseTaskLocks(root) {
  const dir = path.join(root, 'tasks');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('-task.js')); } catch (_) { return {}; }

  const byFile = {};
  for (const f of files) {
    const src = readIfExists(path.join(dir, f));
    if (!src) continue;
    const at = src.indexOf('get requiredLocks');
    if (at < 0) continue;
    const chunk = src.slice(at, at + 700);
    const locks = new Set();
    for (const m of chunk.matchAll(/'(movement|combat|inventory|digging|building|crafting)'/g)) locks.add(m[1]);
    byFile[f] = [...locks];
  }

  // 任务类型 → 任务文件（读 task-manager.js 的 TASK_TYPES 表 + import 行）
  const tm = readIfExists(path.join(root, 'tasks', 'task-manager.js')) || '';
  const classToFile = {};
  for (const m of tm.matchAll(/require\('\.\/([\w-]+-task)'\)/g)) classToFile[m[1]] = m[1] + '.js';
  const imports = {};
  for (const m of tm.matchAll(/const\s*\{\s*(\w+)\s*\}\s*=\s*require\('\.\/([\w-]+)'\)/g)) imports[m[1]] = m[2] + '.js';

  const out = {};
  const table = tm.slice(tm.indexOf('const TASK_TYPES'), tm.indexOf('const TASK_TYPES') + 900);
  for (const m of table.matchAll(/^\s*([a-z_]+):\s*(\w+)/gm)) {
    const file = imports[m[2]];
    out[m[1]] = { file: file || null, locks: (file && byFile[file]) || [] };
  }
  return out;
}

/** 仲裁档位：直接 require 真的优先级模块（纯常量，无副作用） */
function freshRequire(file) {
  try { delete require.cache[require.resolve(file)]; } catch (_) {}
  return require(file);
}

function loadTiers(root) {
  try {
    const m = freshRequire(path.join(root, 'systems', 'task-arbitration', 'task-priority-manager.js'));
    const map = {};
    for (const t of m.COMBAT_TASKS) map[t] = 'CRITICAL';
    for (const t of m.HIGH_TASKS) map[t] = 'HIGH';
    for (const t of m.MEDIUM_TASKS) map[t] = 'MEDIUM';
    for (const t of m.LOW_TASKS) map[t] = 'LOW';
    return map;
  } catch (_) { return {}; }
}

function loadActionKeys(root) {
  const m = freshRequire(path.join(root, 'ai', 'action-keys.js'));
  return {
    keys: Object.values(m.ACTION_KEYS).filter(k => k !== 'UNKNOWN'),
    intents: m.ACTION_KEY_TO_INTENT,
    dangerous: new Set(m.DANGEROUS_ACTION_KEYS),
  };
}

/** 验收报告里跑过哪些用例 —— 用来标"验过没有" */
function loadVerified(root) {
  const text = readIfExists(path.join(root, 'acceptance', 'reports', 'latest-summary.md'));
  if (!text) return {};
  const out = {};
  for (const b of text.split(/^###\s+/m).slice(1)) {
    const name = b.split('\n')[0].trim().toLowerCase();
    const j = (b.match(/-\s*judgment:\s*(\w+)/i) || [])[1];
    if (name && j) out[name] = j.toUpperCase();
  }
  return out;
}

/* ------------------------------------------------------------ 组装 */

function collectCapabilities(root) {
  const { keys, intents, dangerous } = loadActionKeys(root);
  const routing = parseIntentRouting(root);
  const taskInfo = parseTaskLocks(root);
  const tierByTask = loadTiers(root);
  const verified = loadVerified(root);

  const caps = keys.map(key => {
    const label = LABELS[key];
    const r = routing[key] || {};
    const taskType = r.taskType || null;
    const t = taskType ? (taskInfo[taskType] || {}) : {};
    const tier = taskType ? (tierByTask[taskType] || null) : null;
    const intent = intents[key] || null;

    let acc = null;
    for (const [name, j] of Object.entries(verified)) {
      if (taskType && name.includes(taskType.split('_')[0])) { acc = j; break; }
      if (intent && name.includes(intent.split('_')[0])) { acc = j; break; }
    }

    return {
      key,
      name: label ? label[0] : key,
      plain: label ? label[1] : '',
      domain: label ? label[2] : '未归类',
      labeled: Boolean(label),
      intent,
      taskType,
      taskFile: t.file || null,
      locks: t.locks || [],
      tier,
      tierRank: tier ? TIERS[tier].rank : 0,
      enqueuePriority: r.priority ? r.priority.value : null,
      enqueuePriorityLabel: r.priority ? r.priority.label : null,
      dangerous: dangerous.has(key),
      instant: !taskType,          // 不进任务队列，说完就答
      acceptance: acc,
    };
  });

  // 联系一：落到同一个任务的能力，是同一套代码
  const byTask = {};
  for (const c of caps) if (c.taskType) (byTask[c.taskType] = byTask[c.taskType] || []).push(c.key);

  // 联系二：抢同一把锁的能力，不能同时干
  const byLock = {};
  for (const c of caps) for (const l of c.locks) (byLock[l] = byLock[l] || []).push(c.key);

  const domains = DOMAIN_ORDER.filter(d => caps.some(c => c.domain === d));
  for (const c of caps) if (!domains.includes(c.domain)) domains.push(c.domain);

  return {
    ok: true,
    caps,
    domains,
    byTask,
    byLock,
    lockLabels: LOCK_LABELS,
    tiers: TIERS,
    counts: {
      total: caps.length,
      instant: caps.filter(c => c.instant).length,
      critical: caps.filter(c => c.tier === 'CRITICAL').length,
      dangerous: caps.filter(c => c.dangerous).length,
      unlabeled: caps.filter(c => !c.labeled).length,
      tasks: Object.keys(byTask).length,
    },
  };
}

module.exports = { collectCapabilities, LABELS, LOCK_LABELS, TIERS };
