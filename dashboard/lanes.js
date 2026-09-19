'use strict';
/**
 * 协作线进度 —— 自动读 docs/协作/<线名>/CC反馈.md
 *
 * 只读，零依赖。CC 每轮收尾会重写这些文件，所以看板不需要人工同步。
 * 解析的是 `说明.md` 规定的固定格式头部 + 一句话结论 + 需要老板拍板的问题。
 *
 * 外部来源（后勤第 4 轮加）：有的线把反馈搬到了自己的 worktree，主仓只剩指路条。
 * 这类线在 EXTERNAL_FEEDBACK 里登记一个绝对路径，**只读那一个文件**，读不到就
 * 静默回落到主仓的旧文件；两边都有时取「轮次」更大的那份。见 pickSource()。
 */
const fs = require('fs');
const path = require('path');

const STATUS_RANK = { '卡住了': 4, '等老板拍板': 3, '进行中': 2, '待开工': 2, '已完成': 1 };

// 线名 → 该线在自己 worktree 里的 CC反馈.md 绝对路径。
// 授权范围仅限这里列出的单个文件，只读；环境变量可覆盖（换机器/换盘符时不用改代码）。
const EXTERNAL_FEEDBACK = {
  '修缮': process.env.MC_LANE_FEEDBACK_修缮 ||
          process.env.MC_LANE_FEEDBACK_FIX ||
          'D:\\code\\MC-fix\\docs\\协作\\修缮\\CC反馈.md',
};

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch (_) { return null; }
}

function field(text, name) {
  const m = text.match(new RegExp('^-\\s*' + name + '\\s*[:：]\\s*(.+)$', 'm'));
  return m ? m[1].trim() : null;
}

function section(text, title) {
  const re = new RegExp('^##\\s*' + title + '\\s*$', 'm');
  const m = text.match(re);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^##\s+/m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function isPlaceholder(s) {
  if (!s) return true;
  return /^（.*）$/s.test(s.trim()) || s.includes('本文件由') || s.includes('每轮结束时重写');
}

// 「状态」字段可能带一长串括号说明，如「进行中（第 1、4 步已完成…）」。
// 看板灯只认前面的关键词，括号里的话单独作为备注返回，不再把整句塞进小标签里。
const STATUS_WORDS = ['卡住了', '等老板拍板', '进行中', '已完成'];
function splitStatus(raw) {
  if (!raw) return { status: '未知', statusNote: null };
  const t = String(raw).trim();
  const word = STATUS_WORDS.find(w => t.startsWith(w));
  if (!word) return { status: t.replace(/[（(].*$/s, '').trim() || '未知', statusNote: null };
  let note = t.slice(word.length).trim();
  note = note.replace(/^[（(]/, '').replace(/[）)]$/, '').replace(/^[:：\-—\s]+/, '').trim();
  return { status: word, statusNote: note || null };
}

function roundNumber(text) {
  const raw = field(text, '轮次');
  if (!raw) return null;
  const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// 读一个候选反馈文件，读不到 / 不是一份真反馈（没有「轮次」）就返回 null
function loadCandidate(file, origin) {
  const st = statOrNull(file);
  if (!st) return null;
  const text = readIfExists(file);
  if (text == null) return null;
  // 退役线或已迁移的线在主仓只留一张指路条（没有「轮次」字段），不当成一条在跑的线
  const round = roundNumber(text);
  if (round == null) return null;
  return { file, origin, text, round, updated: st.mtimeMs };
}

// 主仓 vs 外部：轮次大的赢；轮次相同取改得晚的；只有一份就用那份
function pickSource(main, external) {
  if (!main) return external;
  if (!external) return main;
  if (external.round !== main.round) return external.round > main.round ? external : main;
  return external.updated > main.updated ? external : main;
}

function collectLanes(root) {
  const dir = path.join(root, 'docs', '协作');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== '历史')
      .map(e => e.name);
  } catch (_) { return { ok: false, lanes: [] }; }

  // 登记了外部来源、但主仓已经没有这个目录的线，也要出现在看板上
  for (const name of Object.keys(EXTERNAL_FEEDBACK)) {
    if (!names.includes(name)) names.push(name);
  }

  const lanes = [];
  for (const name of names) {
    const main = loadCandidate(path.join(dir, name, 'CC反馈.md'), 'main');
    const externalPath = EXTERNAL_FEEDBACK[name] || null;
    const external = externalPath ? loadCandidate(externalPath, 'external') : null;
    const src = pickSource(main, external);
    if (!src) continue;

    const text = src.text;
    const conclusion = section(text, '一句话结论');
    const decisionsRaw = section(text, '需要老板拍板的问题');
    const decisions = [...decisionsRaw.matchAll(/^###\s*(.+)$/gm)].map(m => m[1].trim());

    // 任务书标题只从主仓读。线已迁移时主仓那份是指路条不是任务书，宁可不显示也不误报。
    const task = src.origin === 'main' ? readIfExists(path.join(dir, name, '给CC.md')) : null;
    const taskTitle = task ? (task.match(/^#\s+(.+)$/m) || [])[1] || null : null;
    // 任务书里的轮次（「后勤 第 6 轮任务 …」）。比反馈轮次大，说明老板已经派了新活。
    const tm = taskTitle ? taskTitle.match(/第\s*(\d+)\s*轮/) : null;
    const taskRound = tm ? parseInt(tm[1], 10) : null;

    // 上一轮交回「已完成」、但新一轮任务书已经贴出来了 → 灯不能还亮「已完成」，
    // 那会让人以为「正在做」那行也做完了。改成「待开工」。
    let { status, statusNote } = splitStatus(field(text, '状态'));
    if (status === '已完成' && taskRound != null && taskRound > src.round) {
      status = '待开工';
      statusNote = `第 ${src.round} 轮已交回；第 ${taskRound} 轮任务书已下达，还没开始`;
    }

    lanes.push({
      lane: name,
      round: field(text, '轮次'),
      date: field(text, '日期'),
      status,
      statusNote,
      taskRound,
      branch: field(text, '分支 / HEAD') || field(text, '分支/HEAD'),
      conclusion: isPlaceholder(conclusion) ? null : conclusion.replace(/\s+/g, ' ').trim(),
      decisions: /无\s*。?$/.test(decisionsRaw.trim()) ? [] : decisions,
      started: isPlaceholder(conclusion) === false || Boolean(field(text, '日期') && field(text, '日期') !== '—'),
      updated: src.updated,
      taskTitle,
      source: src.origin,
      sourceFile: src.file,
    });
  }

  lanes.sort((a, b) =>
    (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) || b.updated - a.updated);

  return {
    ok: true,
    lanes,
    pendingDecisions: lanes.reduce((n, l) => n + l.decisions.length, 0),
  };
}

module.exports = { collectLanes, EXTERNAL_FEEDBACK, pickSource, loadCandidate, splitStatus };
