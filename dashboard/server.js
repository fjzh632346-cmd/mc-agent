#!/usr/bin/env node
/**
 * LinXia 项目进度看板 —— 本地服务
 *
 * 零依赖：只用 Node 标准库，不需要 npm install。
 * 启动：node dashboard/server.js      （或双击 dashboard/启动进度看板.bat）
 * 打开：http://localhost:4321
 *
 * 自动读取（只读，绝不修改项目文件）：
 *   - git 提交记录        → 工作时长、改动量、活跃度
 *   - 验收报告            → 每个用例的通过情况
 *   - package.json        → 测试套件清单
 *   - docs/               → 文档时间线
 *   - systems/ 等目录     → 代码体量、超大文件预警
 *   - data/memory/        → 存储健康检查（只看文件大小，不解析内容）
 *   - ai/ tasks/ systems/ → 能力地图（会做哪些事、优先级、彼此抢什么资源）
 *
 * 人工输入（任务树、优先级、状态、备注）存在 dashboard/board-data.json，
 * 全部通过网页编辑，使用者无需打开任何文件。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { collectCapabilities } = require('./capabilities');
const { collectLanes } = require('./lanes');

const HERE = __dirname;
// 仓库根：默认就是看板所在仓库的上一级；看板入版本管理后会有两份拷贝，
// 跑哪一份都可以用环境变量指到真正在用的仓库（协作文件常驻主仓）。
const ROOT = process.env.MC_DASHBOARD_ROOT || path.resolve(HERE, '..');
const BOARD_FILE = path.join(HERE, 'board-data.json');
const SEED_FILE = path.join(HERE, 'board-seed.json');
const PORT = Number(process.env.DASHBOARD_PORT || 4321);

/* ------------------------------------------------------------------ 小工具 */

function safe(label, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return Object.assign({ __error: `${label}: ${err && err.message ? err.message : err}` },
      fallback === undefined ? {} : fallback);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function mb(bytes) {
  return Math.round((bytes / 1048576) * 10) / 10;
}

function git(args) {
  return execSync(
    `git -c i18n.logOutputEncoding=UTF-8 ${args}`,
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

/* --------------------------------------------------------- 一、Git 工作量 */

const SESSION_GAP_MIN = 90;   // 两次提交间隔超过这么久，算两段工作
const LEAD_IN_MIN = 25;       // 每段工作在第一次提交之前的估算投入

function collectGit() {
  const raw = git('log --date=iso-strict --pretty=format:%x01%H%x1f%at%x1f%an%x1f%s --numstat -n 400');

  const commits = [];
  for (const chunk of raw.split('\x01')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const [hash, at, author, ...subjParts] = lines[0].split('\x1f');
    const subject = subjParts.join('\x1f');
    let files = 0, added = 0, removed = 0;
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].trim().split('\t');
      if (m.length < 3) continue;
      files++;
      if (m[0] !== '-') added += Number(m[0]) || 0;
      if (m[1] !== '-') removed += Number(m[1]) || 0;
    }
    commits.push({
      hash: (hash || '').slice(0, 8),
      ts: Number(at) * 1000,
      author,
      subject,
      files,
      added,
      removed,
    });
  }

  commits.sort((a, b) => a.ts - b.ts);

  // 把提交切成"工作段"，估算时长
  const sessions = [];
  let cur = null;
  for (const c of commits) {
    if (!cur || c.ts - cur.end > SESSION_GAP_MIN * 60000) {
      if (cur) sessions.push(cur);
      cur = { start: c.ts, end: c.ts, commits: 0, added: 0, removed: 0, files: 0 };
    }
    cur.end = c.ts;
    cur.commits++;
    cur.added += c.added;
    cur.removed += c.removed;
    cur.files += c.files;
  }
  if (cur) sessions.push(cur);

  for (const s of sessions) {
    s.hours = Math.round(((s.end - s.start) / 3600000 + LEAD_IN_MIN / 60) * 100) / 100;
  }

  // 按天汇总
  const byDay = new Map();
  for (const s of sessions) {
    const d = new Date(s.start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = byDay.get(key) || { day: key, hours: 0, commits: 0, added: 0, removed: 0 };
    row.hours += s.hours;
    row.commits += s.commits;
    row.added += s.added;
    row.removed += s.removed;
    byDay.set(key, row);
  }
  const daily = [...byDay.values()]
    .map(r => ({ ...r, hours: Math.round(r.hours * 10) / 10 }))
    .sort((a, b) => a.day.localeCompare(b.day));

  let branch = '', dirtyCount = 0, dirtyFiles = [];
  try { branch = git('rev-parse --abbrev-ref HEAD').trim(); } catch (_) {}
  try {
    const st = git('status --porcelain').split('\n').filter(Boolean);
    dirtyCount = st.length;
    dirtyFiles = st.slice(0, 40).map(l => l.trim());
  } catch (_) {}

  const totalHours = Math.round(sessions.reduce((n, s) => n + s.hours, 0) * 10) / 10;
  const last = commits[commits.length - 1];

  return {
    ok: true,
    branch,
    dirtyCount,
    dirtyFiles,
    totalCommits: commits.length,
    totalHours,
    sessions: sessions.length,
    daily,
    lastCommit: last ? { ...last } : null,
    recent: commits.slice(-25).reverse(),
  };
}

/* ------------------------------------------------------------- 二、验收状态 */

function collectAcceptance() {
  const file = path.join(ROOT, 'acceptance', 'reports', 'latest-summary.md');
  const st = statOrNull(file);
  if (!st) return { ok: false, reason: '还没有验收报告' };

  const text = fs.readFileSync(file, 'utf8');
  const pick = re => { const m = text.match(re); return m ? m[1].trim() : null; };

  const result = pick(/-\s*result:\s*(.+)/);
  const counts = {};
  if (result) {
    for (const [, n, k] of result.matchAll(/(\d+)\s+(PASS|FAIL|BLOCKED|ERROR)/g)) counts[k] = Number(n);
  }

  const cases = [];
  const blocks = text.split(/^###\s+/m).slice(1);
  for (const b of blocks) {
    const lines = b.split('\n');
    const c = { name: lines[0].trim() };
    for (const l of lines.slice(1)) {
      const m = l.match(/^-\s*([A-Za-z]+):\s*(.+)$/);
      if (m) c[m[1]] = m[2].trim();
    }
    cases.push(c);
  }

  return {
    ok: true,
    finishedAt: pick(/-\s*finishedAt:\s*(.+)/),
    result,
    counts,
    cases,
    reportAgeDays: Math.floor((Date.now() - st.mtimeMs) / 86400000),
  };
}

/* --------------------------------------------------------- 三、测试套件清单 */

function collectTests() {
  const pkg = readJson(path.join(ROOT, 'package.json'), null);
  if (!pkg || !pkg.scripts) return { ok: false };
  const main = pkg.scripts.test || '';
  const suites = [...main.matchAll(/tests\/([\w.-]+)\.test\.js/g)].map(m => m[1]);
  const shortcuts = Object.keys(pkg.scripts).filter(k => k.startsWith('test:')).length;
  return { ok: true, suiteCount: suites.length, suites, shortcuts };
}

/* ------------------------------------------------------- 四、工程健康检查 */

const BIG_FILE_WARN = 120 * 1024;      // 单个源码文件超过这么大就提醒
const BIG_DATA_WARN = 20 * 1024 * 1024; // 单个数据文件超过这么大就提醒

// 已经查过、老板知情、但还没排期的问题：在自动扫描结果上挂一条备注，免得每轮重新讨论一遍
const KNOWN_ISSUE_NOTES = {
  'construction-runs.json': '已查实并修好（后勤第 8 轮，任务清单 x01/d31）：拖慢的是「每存一次进度整本读写一遍」，不是份数多。收尾的施工已把步骤记录与整张图纸挪到 construction-runs-archive\ 一场一份，正档 98MB→11MB、一个来回 2.1s→0.28s。旁边那份 construction-runs.pre-archive.json 是迁移前的备份，确认无误后可删。',
};

function walkDir(dir, depth) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out.push(...walkDir(full, depth - 1));
    } else if (e.isFile()) {
      const st = statOrNull(full);
      if (st) out.push({ file: path.relative(ROOT, full).replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

function collectHealth() {
  const issues = [];

  // 1. 超大源码文件
  const codeDirs = ['systems', 'actions', 'core', 'perception', 'tasks', 'utils', 'ai', 'rules'];
  const codeFiles = [];
  for (const d of codeDirs) codeFiles.push(...walkDir(path.join(ROOT, d), 2));
  const rootJs = walkDir(ROOT, 0).filter(f => f.file.endsWith('.js'));
  codeFiles.push(...rootJs);

  const bigCode = codeFiles.filter(f => f.size >= BIG_FILE_WARN).sort((a, b) => b.size - a.size);
  for (const f of bigCode.slice(0, 6)) {
    issues.push({
      level: f.size >= 250 * 1024 ? 'critical' : 'warning',
      title: `单个文件过大：${f.file}`,
      detail: `${Math.round(f.size / 1024)} KB。文件越大，改动越容易碰坏别的地方，AI 每次也要多读很多内容。`,
      metric: `${Math.round(f.size / 1024)} KB`,
    });
  }

  // 2. 超大数据文件 + 残留临时文件
  const memDir = path.join(ROOT, 'data', 'memory');
  const memFiles = walkDir(memDir, 0);
  for (const f of memFiles.filter(f => !f.file.includes('.tmp-') && f.size >= BIG_DATA_WARN).sort((a, b) => b.size - a.size)) {
    issues.push({
      level: 'critical',
      title: `数据文件过大：${f.file}`,
      detail: `${mb(f.size)} MB。程序每次更新它都要把整份重写一遍，会明显拖慢运行，也更容易在中途写坏。`,
      metric: `${mb(f.size)} MB`,
      note: KNOWN_ISSUE_NOTES[path.basename(f.file)] || null,
    });
  }
  const tmps = memFiles.filter(f => f.file.includes('.tmp-'));
  if (tmps.length) {
    const total = tmps.reduce((n, f) => n + f.size, 0);
    issues.push({
      level: 'warning',
      title: `残留了 ${tmps.length} 个写到一半的文件`,
      detail: `共 ${mb(total)} MB，在 data/memory 里。说明保存过程中断过 ${tmps.length} 次。清掉不影响功能，但中断本身值得查。`,
      metric: `${mb(total)} MB`,
    });
  }

  // 3. 日志堆积
  const logs = walkDir(path.join(ROOT, 'logs'), 0);
  if (logs.length > 100) {
    const total = logs.reduce((n, f) => n + f.size, 0);
    issues.push({
      level: 'warning',
      title: `日志文件堆积：${logs.length} 个`,
      detail: `共 ${mb(total)} MB。建议定期归档，只留最近的。`,
      metric: `${logs.length} 个`,
    });
  }

  const totalCodeSize = codeFiles.reduce((n, f) => n + f.size, 0);
  return {
    ok: true,
    issues,
    codeFileCount: codeFiles.length,
    codeSizeKB: Math.round(totalCodeSize / 1024),
    biggest: bigCode.slice(0, 8).map(f => ({ file: f.file, kb: Math.round(f.size / 1024) })),
  };
}

/* ----------------------------------------------------- 五、待决事项 & 文档 */

function collectDecisions() {
  const file = path.join(ROOT, 'docs', 'decision-needed.md');
  if (!statOrNull(file)) return { ok: false, items: [] };
  const text = fs.readFileSync(file, 'utf8');
  const items = text.split('\n')
    .filter(l => l.trim().startsWith('- '))
    .map(l => {
      const body = l.trim().slice(2);
      const m = body.match(/^(\d{4}-\d{2}-\d{2})T[\d:.]+Z\s+(.*)$/);
      return m ? { date: m[1], text: m[2] } : { date: null, text: body };
    });
  return { ok: true, items };
}

function collectDocs() {
  const dir = path.join(ROOT, 'docs');
  return {
    ok: true,
    items: walkDir(dir, 0)
      .filter(f => f.file.endsWith('.md'))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => ({
        name: path.basename(f.file),
        kb: Math.round(f.size / 1024),
        updated: new Date(f.mtime).toISOString().slice(0, 10),
      })),
  };
}

/* --------------------------------------------------------- 六、能力地图 */

let capCache = { at: 0, data: null };
const CAP_CACHE_MS = 30000;

function capabilities(force) {
  if (!force && capCache.data && Date.now() - capCache.at < CAP_CACHE_MS) return capCache.data;
  const data = safe('capabilities', () => collectCapabilities(ROOT), {
    ok: false, caps: [], domains: [], byTask: {}, byLock: {}, lockLabels: {}, counts: {},
  });
  capCache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------ 快照与缓存 */

let cache = { at: 0, data: null };
const CACHE_MS = 20000;

function snapshot(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = {
    generatedAt: new Date().toISOString(),
    projectRoot: ROOT,
    git: safe('git', collectGit, { ok: false, daily: [], recent: [] }),
    acceptance: safe('acceptance', collectAcceptance, { ok: false }),
    tests: safe('tests', collectTests, { ok: false }),
    health: safe('health', collectHealth, { ok: false, issues: [] }),
    decisions: safe('decisions', collectDecisions, { ok: false, items: [] }),
    lanes: safe('lanes', () => collectLanes(ROOT), { ok: false, lanes: [], pendingDecisions: 0 }),
    docs: safe('docs', collectDocs, { ok: false, items: [] }),
  };
  cache = { at: Date.now(), data };
  return data;
}

/* --------------------------------------------------------------- 任务看板 */

function loadBoard() {
  let board = readJson(BOARD_FILE, null);
  if (!board) {
    board = readJson(SEED_FILE, null) || { groups: [], updatedAt: null };
    try { fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2), 'utf8'); } catch (_) {}
  }
  return board;
}

function saveBoard(board) {
  board.updatedAt = new Date().toISOString();
  const tmp = BOARD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8');
  fs.renameSync(tmp, BOARD_FILE);
  return board;
}

/* ------------------------------------------------------------------ 服务器 */

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'app.html')), 'text/html; charset=utf-8');
    }
    if (p === '/api/snapshot') {
      return send(res, 200, JSON.stringify(snapshot(url.searchParams.get('force') === '1')));
    }
    if (p === '/api/capabilities') {
      return send(res, 200, JSON.stringify(capabilities(url.searchParams.get('force') === '1')));
    }
    if (p === '/api/board' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(loadBoard()));
    }
    if (p === '/api/board' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
      req.on('end', () => {
        try {
          const board = JSON.parse(raw);
          if (!board || !Array.isArray(board.groups)) throw new Error('数据格式不对');
          return send(res, 200, JSON.stringify(saveBoard(board)));
        } catch (err) {
          return send(res, 400, JSON.stringify({ error: String(err.message || err) }));
        }
      });
      return;
    }
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (err) {
    return send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const line = '='.repeat(52);
  console.log(`\n${line}`);
  console.log('  LinXia 项目进度看板已启动');
  console.log(`  在浏览器打开：  http://localhost:${PORT}`);
  console.log(`  监控的项目：    ${ROOT}`);
  console.log('  关掉这个窗口即可停止。');
  console.log(`${line}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。可能看板已经在运行了，先去浏览器看看 http://localhost:${PORT}`);
    console.error(`如果要换端口，运行：set DASHBOARD_PORT=4322 && node dashboard/server.js\n`);
  } else {
    console.error('启动失败：', err.message);
  }
  process.exit(1);
});
