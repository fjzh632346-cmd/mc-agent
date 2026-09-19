# Claude Code Kickoff — 建筑系统完善 + 全链路一体化

Last updated: 2026-08-30

## 这份文件是什么

给 Claude Code 在本仓库开新会话时用的**开场指令**。

两种用法:

1. 直接把下面「开场指令」整段复制粘贴给 CC
2. 或者对 CC 说:`读 docs/CLAUDE_CODE_KICKOFF.md 并按它执行`

文件内引用的现状快照来自 2026-08-30 的一次只读核查(读取 `AGENTS.md`、
`docs/CODEX_BUILDING_HANDOFF.md`、`docs/CODEX_BOT_STARTUP.md`、
`acceptance/reports/latest-summary.md`、`docs/decision-needed.md`、
`logs/` 目录清单、`package.json`)。核查过程**没有执行任何命令**,
因此所有 git 与测试状态在下文中标为待验证。

---

# 开场指令

你现在接手 `D:\code\MC-blueprint-ir-v1` —— Minecraft AI 伙伴「林夏 LinXia」项目
(Node.js + mineflayer)。这不是简单指令 bot,是带任务生命周期、ActionLock、
记忆和真机验收的 agent 系统。

## 第一步:先读,读完再说话

```text
AGENTS.md                          ← 本项目铁律,必须完整遵守
docs/CODEX_BUILDING_HANDOFF.md     ← 建造系统交接(733 行,最后更新 2026-07-04)
docs/CODEX_BOT_STARTUP.md
docs/RENOVATION_FLOW_DESIGN.md
acceptance/reports/latest-summary.md
docs/decision-needed.md
logs/bot-current.log               ← 4MB,只读尾部
```

## 第二步:先跑,拿真实状态

```powershell
cd D:\code\MC-blueprint-ir-v1
git status --short
git log --oneline -20
git branch --show-current
git diff --stat
npm test
```

注意:这是 git worktree,主仓在 `D:\code\MC`,分支 `refactor/building-blueprint-ir-v1`,
工作区是脏的、有大量未提交改动。

禁止 `git add -A` / `git add .` / `git reset --hard` / `git clean -fd`。
不要提交,除非我明确要求。

---

## 已知现状 —— 请你用真实文件验证,不要照单全收

**最新验收** (`acceptance/reports/latest-summary.md`, 2026-08-01T10:43Z):

```text
0 PASS / 1 FAIL / 0 BLOCKED / 0 ERROR
building / case2 P9R faithful community modern structure import
reason: build_task_failed:move_timeout
distancePlayerToAi: 91.1
recommendedTeleportCommand: /tp LinXia accept_tester
```

**历史断层**:建造交接文档最后更新 2026-07-04,里面写的下一个任务是 case1 的
`place_failed:unstable_air`;但 8-01 的报告已经变成 case2 的 `move_timeout`。
中间约四周没有留下任何交接记录。请你从 `git log` 和日志把这段补上。

**两条长期缺陷**(来自 `docs/CODEX_BUILDING_HANDOFF.md`):

- 门感知寻路(door-aware pathfinding)始终缺失,一直靠 workaround 绕过
- 封闭房屋的内部清理步骤会选屋外站位,并因此 `move_timeout`

这两条和 case2 的失败原因是同一个词。**请优先验证是不是同一个根因。**

**未实现的挂账**(来自 `docs/decision-needed.md`):

- GoalSystem 缺 `ReturnToBaseTask`
- PlanningSystem 规划铁镐时缺 `SmeltingSystem` / `FurnaceTask`

---

## 本轮任务

### A. 完善建筑系统(第一优先)

把 building 真机验收推到真实 PASS。按 `AGENTS.md`:一轮只打一个根因,
最小补丁,必须配单测。不许为了 PASS 改验收标准、改断言或手改报告。

### B. 把散落的功能串联成一体

现在各系统是割裂的。证据就在 `docs/decision-needed.md`:规划铁镐时缺熔炼、
目标系统缺回家 —— 说明这条链根本没打通:

```text
目标 → 规划 → 备料(采集/合成/熔炼/开箱取料) → 建造 → 自验收 → 归档
                   ↑ 断线后能续建
```

最终形态:我在游戏里说一句「给我盖个两层木屋」,agent 自己判断缺什么料、
去采、去合成、去熔炼、回来盖、盖完自己验收,中途掉线能接着盖。

请你逐点列出这条链路目前**断在哪里**,每个断点给出文件和行号。

### C. 输出优先级表(本轮硬性交付物)

不要一上来就改代码。先给我一张表,每项包含:

| 字段 | 说明 |
|---|---|
| 编号 / 名称 | |
| 分类 | blueprint / compiler / executor / movement / support / placement / material / validation / habitability / world fixture / integration |
| 证据 | 具体文件行号或日志行;没有证据就写 UNKNOWN,不许编 |
| 影响面 | |
| 预估改动量 | |
| 依赖关系 | |
| 优先级 | P0 / P1 / P2 + 理由 |

排序原则:**阻塞真机验收的 > 阻塞链路打通的 > 体验优化。**

---

## 报告格式

按 `AGENTS.md` 第 11 节。每一条结论必须标注三类之一:

```text
已证实   ← 有文件 / 日志 / 命令输出支撑
合理推断
UNKNOWN
```

禁止出现「应该修好了」「大概没问题」这类说法。

## 本轮红线

- 在我看过并确认你的优先级表之前,**不要改任何业务代码**
- 不做 `AGENTS.md` 第 10 节列出的那些大改造
- 不重构 TaskManager 内部
- 不降低验收标准,不把 FAIL 手改成 PASS,不隐藏 BLOCKED
- 跑真机验收前必须先过 ONLINE-GATE(见 `docs/CODEX_BOT_STARTUP.md`)

## 补充背景

我平时的测试方式是让另一个 AI 以真人身份进游戏,带着 agent 一起推进流程、
边玩边暴露 bug。所以你的改动要经得起真实连续游玩,不能只是单测绿。

---

## 完成本轮后

如果第一轮诊断质量达标,把结果落成 `docs/CLAUDE_HANDOFF.md`,
把 2026-07-04 之后那四周的空白补上,保持本项目的交接文档体系不断档。
