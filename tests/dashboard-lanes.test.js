const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { collectLanes, pickSource, loadCandidate, splitStatus } = require('../dashboard/lanes')

// Round-7 logistics lane: the progress board moved into version control, so the
// round-4 offline self-test became a real test group. It runs against a fixture
// tree in a temp dir instead of the live 协作 files, so it does not drift with
// whatever round the three lanes happen to be on.

const LANES = path.join(__dirname, '..', 'dashboard', 'lanes.js')

function feedback ({ lane, round, status = '已完成', date = '2026-09-02', conclusion = '一句话。', decisions = '无' }) {
  return `# ${lane} 第 ${round} 轮反馈\n\n` +
    `- 线: ${lane}\n- 轮次: ${round}\n- 日期: ${date}\n- 状态: ${status}\n- 分支 / HEAD: x / y\n\n---\n\n` +
    `## 一句话结论\n\n${conclusion}\n\n## 需要老板拍板的问题\n\n${decisions}\n\n## 技术细节\n\n略\n`
}

function makeTree () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ops-lanes-'))
  const collab = path.join(root, 'docs', '协作')
  for (const lane of ['建造', '修缮', '后勤']) fs.mkdirSync(path.join(collab, lane), { recursive: true })
  fs.mkdirSync(path.join(collab, '历史'), { recursive: true })
  fs.writeFileSync(path.join(collab, '建造', 'CC反馈.md'), feedback({ lane: '建造', round: 12, status: '进行中（门楼续建）' }))
  fs.writeFileSync(path.join(collab, '建造', '给CC.md'), '# 建造 第 13 轮任务 — 续建准备\n')
  // the fix lane moved its feedback out: the main tree only keeps a signpost
  fs.writeFileSync(path.join(collab, '修缮', 'CC反馈.md'), '# 修缮线已迁移\n\n请去 worktree 看反馈。\n')
  fs.writeFileSync(path.join(collab, '后勤', 'CC反馈.md'),
    feedback({ lane: '后勤', round: 7, status: '卡住了', decisions: '### 问题 1：要不要加线\n- 背景：略\n' }))
  const external = path.join(root, 'external-修缮-CC反馈.md')
  fs.writeFileSync(external, feedback({ lane: '修缮', round: 7, status: '进行中' }))
  return { root, collab, external }
}

function laneMapUnder (root, env) {
  const code = `const {collectLanes}=require(${JSON.stringify(LANES)});` +
    `const r=collectLanes(${JSON.stringify(root)});` +
    `console.log(JSON.stringify({total:r.lanes.length,pending:r.pendingDecisions,lanes:r.lanes.map(l=>({lane:l.lane,round:l.round,source:l.source,status:l.status}))}));`
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' })
  return JSON.parse(out.trim().split(/\r?\n/).pop())
}

// ---------------------------------------------------------------------------
// A. 主仓 / 外部两份反馈的取舍规则（纯函数）
function testPickSourceRules () {
  const main = (round, updated) => ({ origin: 'main', round, updated })
  const external = (round, updated) => ({ origin: 'external', round, updated })
  assert.strictEqual(pickSource(main(1, 100), external(3, 50)).origin, 'external')
  assert.strictEqual(pickSource(main(5, 50), external(2, 999)).origin, 'main')
  assert.strictEqual(pickSource(main(2, 10), external(2, 20)).origin, 'external')
  assert.strictEqual(pickSource(main(2, 30), external(2, 20)).origin, 'main')
  assert.strictEqual(pickSource(null, external(2, 20)).origin, 'external')
  assert.strictEqual(pickSource(main(2, 20), null).origin, 'main')
  assert.strictEqual(pickSource(null, null), null)
}

// ---------------------------------------------------------------------------
// B. 指路条不是反馈：没有「轮次」字段的文件不当成一条在跑的线
function testSignpostIsNotAFeedback () {
  const { collab } = makeTree()
  assert.strictEqual(loadCandidate(path.join(collab, '修缮', 'CC反馈.md'), 'main'), null)
  const built = loadCandidate(path.join(collab, '建造', 'CC反馈.md'), 'main')
  assert.ok(built)
  assert.strictEqual(built.round, 12)
  assert.strictEqual(loadCandidate(path.join(collab, '没有这个目录', 'CC反馈.md'), 'main'), null)
}

// ---------------------------------------------------------------------------
// C. 状态字段：灯只认关键词，括号里的说明单独出来
function testStatusSplit () {
  assert.deepStrictEqual(splitStatus('进行中（第 1、4 步已完成）'), { status: '进行中', statusNote: '第 1、4 步已完成' })
  assert.deepStrictEqual(splitStatus('已完成'), { status: '已完成', statusNote: null })
  assert.deepStrictEqual(splitStatus('卡住了：等真机'), { status: '卡住了', statusNote: '等真机' })
  assert.strictEqual(splitStatus(null).status, '未知')
}

// ---------------------------------------------------------------------------
// D. 主路径：外部反馈登记好时，迁移出去的线走外部来源
function testExternalFeedbackWins () {
  const { root, external } = makeTree()
  const result = laneMapUnder(root, { MC_LANE_FEEDBACK_FIX: external })
  assert.strictEqual(result.total, 3, JSON.stringify(result))
  const fix = result.lanes.find(lane => lane.lane === '修缮')
  assert.ok(fix, JSON.stringify(result))
  assert.strictEqual(fix.source, 'external')
  assert.strictEqual(String(fix.round), '7')
  const ops = result.lanes.find(lane => lane.lane === '后勤')
  assert.strictEqual(ops.status, '卡住了')
  assert.strictEqual(result.pending, 1)
  // 卡住了 outranks 进行中 / 已完成 in the board sort
  assert.strictEqual(result.lanes[0].lane, '后勤')
}

// ---------------------------------------------------------------------------
// E. 回落：外部文件不存在 → 回落主仓；外部是指路条 → 判无效
function testFallsBackWhenExternalIsMissingOrASignpost () {
  const { root, collab } = makeTree()
  const missing = laneMapUnder(root, { MC_LANE_FEEDBACK_FIX: path.join(root, 'nope', 'CC反馈.md') })
  // the fix lane only has a signpost in the tree, so it drops off the board,
  // but the other two lanes must survive
  assert.ok(missing.total >= 2, JSON.stringify(missing))
  assert.ok(missing.lanes.every(lane => lane.source === 'main'))
  const signpost = laneMapUnder(root, { MC_LANE_FEEDBACK_FIX: path.join(collab, '修缮', 'CC反馈.md') })
  assert.ok(signpost.lanes.every(lane => lane.source === 'main'), JSON.stringify(signpost))
}

// ---------------------------------------------------------------------------
// F. 读不到 docs/协作 时不炸（换机器 / 路径写错）
function testMissingCollabTreeIsNotAnError () {
  const empty = collectLanes(path.join(os.tmpdir(), 'mc-ops-lanes-does-not-exist'))
  assert.strictEqual(empty.ok, false)
  assert.deepStrictEqual(empty.lanes, [])
}

// ---------------------------------------------------------------------------
// G. 看板数据文件本身合法（入库那份）
function testBoardDataIsValid () {
  const board = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'board-data.json'), 'utf8'))
  assert.ok(Array.isArray(board.groups) && board.groups.length > 0)
  const ids = new Set()
  const allowedStatus = ['done', 'doing', 'todo', 'hold']
  const allowedPriority = ['P0', 'P1', 'P2', 'P3', '—', null, undefined]
  let tasks = 0
  for (const group of board.groups) {
    assert.ok(group.id && group.name, JSON.stringify(group).slice(0, 120))
    assert.ok(Array.isArray(group.tasks), `group ${group.id} has no tasks array`)
    for (const task of group.tasks) {
      assert.ok(task.id && task.name, JSON.stringify(task).slice(0, 120))
      assert.ok(!ids.has(task.id), `duplicate board id ${task.id}`)
      ids.add(task.id)
      assert.ok(allowedStatus.includes(task.status), `${task.id} status=${task.status}`)
      assert.ok(allowedPriority.includes(task.priority), `${task.id} priority=${task.priority}`)
      tasks++
    }
  }
  assert.ok(tasks > 40, `board tasks=${tasks}`)
}

testPickSourceRules()
testSignpostIsNotAFeedback()
testStatusSplit()
testExternalFeedbackWins()
testFallsBackWhenExternalIsMissingOrASignpost()
testMissingCollabTreeIsNotAnError()
testBoardDataIsValid()

console.log('dashboard lanes tests passed')
