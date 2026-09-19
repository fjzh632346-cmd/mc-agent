# 修缮 第 19 轮任务 —（协调线第四轮）「一步卡死拖死全局」根治（清单 17）：执行步看门狗 + 挖掘超时

- 线: 修缮（协调线）
- 轮次: 19
- 下发日期: 2026-09-17
- **建议模型 / 思考强度 / 是否 ultracode**：`Opus 5` + `xhigh`（改的位置是任务管理器的串行心脏、时序类；超时口径要先量后定——「疑难」档）。**不开 ultracode**（一个根因、一处落点）。若离线量口径时发现「正常一步」与「卡死」在时长上分不开，把数据写全、状态「等老板拍板」，不硬定阈值
- 上一轮: 第 18 轮审毕——上轮「远点 + 算路」猜测被证伪，真根因钉到两层（同参数全量扫描 ×52 遍 × 无调色板单值区段逐格数），两笔补丁结果逐格一致，真机 0 卡顿 0 踢线、搜索 10 s → 20–50 ms、探索首跑到；#106 清队列、24 话术做完；23 前提不成立如实报。开发评价：先量再改、把自己上轮的推断推翻并证实——这就是要的取证——通过。老板拍板（**#110–#113**，正式出处见主仓台账）：
  - **#110 「你现在在干嘛」维持当场找一次工作台和床**（问题 1 选 A），不改
  - **#111 其余 12 处直接调库的慢扫法，修缮 19 之后单开一小轮统一换**（问题 2 选 A）→ 排修缮 20，本轮不碰
  - **#112 建造 27 改合 `feat/fix@2ef88e3b`**（你的 12 笔一起收）。**本轮你在 `2ef88e3b` 之上继续提交，不 rebase、不动历史**
  - **#113 修缮 19 = 清单 17**，落点与判据按你第 18 轮交接里的建议起步（下面第 1 步），N 的取值先量再定
  - 22+23 合并那条（复活离家太远先问玩家 + 配话术）仍待拍板，本轮不做；探索 `safe_explore_point_not_found`、木镐 `crafted_item_not_available:0/1` 两个 UNKNOWN 记候选，本轮有余力只取证不修

> 开工前：把上一轮的 `CC反馈.md` 整份归档到
> `D:\code\MC-blueprint-ir-v1\docs\协作\历史\修缮第18轮-搜索卡死根因证伪与两层补丁.md`，再重写反馈文件。

---

## 0. 三条线的现状（你需要知道的）

- 建造 27 仍未开工（截至 09-17），开工后合 `feat/fix@2ef88e3b` + `feat/ops@a6242a5b`，然后在 25565 盖塔楼。**地盘避让**：本轮不碰 `systems/building-system.js`、`systems/storage-system.js`、`actions/build.js`、`survival-system.js` 的 `actionForPriority` / `enqueueDecisionTask`、`systems/UtilityBlockSearch.js`（上轮刚改完，问题 2 留修缮 20）
- 后勤 22 未下发
- 主仓 `data/community-builds/cache/index.json` 本 worktree 仍没有——照旧不复制

## 第 1 步：清单 17 根治（主攻，一根因）

**现场（第 17 轮已证实，`.tmp/r17/full-d-raw-frozen/`）**：她被 RCON 传回靶场，客户端位置 40 s 后才同步；采矿在同步前按旧位置选了 1100 格外、区块未加载的石头，`bot.dig` 永不回（超距挖只回空 ack）→ `TaskManager.tick()` 里 `await activeTask.update(ctx)` 永不返回 → `isTicking` 永远 true → 之后五条命令只 `TASK_ENQUEUED`、零 `start`；「停下」打断了任务状态但叫不醒那个 await；`[状态]` 每 10 s 照打（事件循环活着，是 tick 门闩关着）。第 15/16 轮的第 7 条（插队要等当前一步做完 6.66 s）是同一位置的**另一个**问题——**本轮不解决第 7 条**，写清即可。

**1.1 先离线复现（改前，已证实才往下走）**：假任务 `update` 返回永不 resolve 的 promise → 断言：后续入队任务不 `start`、`停下` 后任务状态变了但 tick 仍不动、`isTicking` 为 true。这一条就是之后的反证基线。

**1.2 先量口径再定 N（本轮最重要的取证）**：
- 从第 15/16/17/18 轮的 raw 日志里（`.tmp/r15..r18/`）按任务类型统计 **正常一步 `update` 的时长分布**（相邻两条 `[TASK_TICK]` 同一 taskId 的间隔，或你能找到的更准的锚点）：施工 / 采矿 / 回家 / 跟随 / 守护 / 存取 / 烧炼 / 睡觉，各给 p50 / p99 / max，并把「已知卡死」那几次（门楼 478 s、第 17 轮 D 段永不回）单列
- 表贴进反馈。**N 要满足：所有正常步的 max 之下留 ≥3 倍余量，且仍能在一分钟量级抓住卡死**。第 18 轮建议默认 60 s——用数据核它；若某类任务正常一步就超过 20 s（长距离回家？），那类任务需要**心跳**而不是更大的 N（见 1.3）
- 若分不开 → 状态「等老板拍板」，给两三个候选 N 各自的误触发/漏抓次数

**1.3 落点一：执行步看门狗（`tasks/task-manager.js` `tick()`）**
- `await activeTask.update(ctx)` 外套一层：超过 N 秒**没有进展**就触发。「进展」= 任务调过 `ctx.heartbeat()`（新增，任务内每完成一个原子动作调一次：施工每放一块、采矿每挖一块、移动每到一个路点……**只在你能确认的几处加**，加了哪处写清；没加心跳的任务按「update 开始」计时）
- 触发时：打 `[TASK_UPDATE_WATCHDOG] taskId= type= elapsedMs= limitMs= lastHeartbeatMs=`；该任务按 `update_timeout` 走 `fail`——放锁 + `markOwnerTerminated`（修缮 15 口径，保证卡着的续体以后抢锁得 `owner_terminated`）；记 `interrupted`/任务记忆；`isTicking` 复位，下一拍照常起队列里的下一条
- **卡住的那个 promise 不强杀**，但它**日后若 resolve/reject 回来**必须被丢弃：加一个守卫，终态任务的迟到返回只打 `[TASK_UPDATE_LATE_RETURN] taskId= type= lateMs=`，不碰任何状态、不放/不抢锁、不触发完成回调。**这一条要有单测**
- `stop`/`停下` 对卡住任务：照旧走 interrupt；看门狗触发后 `停下` 不应再报「打断了」（任务已终态）
- 玩家提示：对照表加 `update_timeout` → 「这一步卡住太久，我先放下换下一件」

**1.4 落点二：挖掘那一下的超时（`actions/mine.js:179` 附近 `await bot.dig(fresh)`）**
- 加超时（口径也从 1.2 的采矿分布定，一般远小于 N）：超时 `bot.stopDigging()`，按失败返回 `dig_timeout`，任务层照常处理失败（采矿任务对单块失败是换块还是整条失败——**照现有逻辑，不改**，写清现状）
- 对照表加 `dig_timeout` → 「这块挖不动，换一块」
- **顺手加一道便宜的前置检查（若代价小）**：目标方块距离 > 可交互距离（或区块未加载）就不发 dig，直接 `target_out_of_reach`——写清有没有做、为什么

**1.5 单测（`tests/task-arbitration.test.js` 或新文件，写清）**
- 永不返回的假任务 → N 秒后（假时钟或把 N 调小）：`[TASK_UPDATE_WATCHDOG]` 1 条；该任务终态 `update_timeout`、锁 owner 为 null、`isOwnerTerminated` true；队列下一条 `start`；卡住任务的续体再 `acquire` → `owner_terminated`
- 迟到返回：让那个 promise 事后 resolve → `[TASK_UPDATE_LATE_RETURN]` 1 条，任务状态/锁/队列**零变化**
- 心跳：一个 update 跑 3N 秒但每 N/2 调一次心跳 → **不触发**
- `停下`：看门狗触发后再 `停下` → 不报错、不重复打断
- 挖掘超时：假 bot `dig` 永不回 → `stopDigging` 被调、返回 `dig_timeout`
- **反证**：拆掉看门狗 → 1.1 的冻死基线复现（红）；拆掉迟到守卫 → 迟到返回污染状态（红）

**1.6 真机（修缮世界 25566，探针 bot `EVENT_LOOP_PROBE=true`）**
- **复现第 17 轮**：`去挖矿` 开挖后 RCON 把她传到 1000+ 格外（或反过来，先传再立刻下 `去挖矿`，让她按旧位置选目标）→ 判据：`[TASK_UPDATE_WATCHDOG]`（或 `dig_timeout`）**≥1 条**；之后 `建个小木屋` 在 **N+5 s 内 `start`**；`停下` 生效；`lock_already_held`（终态 owner 口径）0、`reclaim` 0、`owner_terminated` 按预期出现
- **误触发核验**：跑一段正常序列（`建个小木屋` 盖到完工 + 中途 `守着我` + `去挖矿` + `回家`）→ **`[TASK_UPDATE_WATCHDOG]` 0 条**；施工中 `[TASK_PREEMPT]` 同一对 ≤1（第 16 轮回归）
- 改前对照用第 17 轮 `full-d-raw-frozen/` 即可，不必重跑改前

## 第 2 步（有余力才做，只取证不修）

- 探索 `safe_explore_point_not_found`（0.2 s 内失败）：读 `ai/exploration-intent.js` / `actions/explore.js`，写清「安全点」判据是什么、靶场为什么一个都不满足；**不改**
- 木镐 `crafted_item_not_available:0/1`（手上有木板木棍）：翻第 18 轮 raw 找配方/工作台那几行，写清卡在哪一步；**不改**
- 没余力写「未做」

## 第 3 步：回归 + 归档 + 提交

- `npm test` 全绿（基线 79 组，写清增减）；第 16–18 轮的仲裁 / 死亡链 / 对照表 / 搜索单测全部要过
- 归档第 18 轮；提交显式指定文件；`.tmp/` / `data/memory/*` / `logs/*` 不提交
- 候选池更新：修缮 20 = #111 十二处统一换；22+23 待拍板；第 7 条（插队等长 update）写清「看门狗不解决它」

## 交接（写进反馈）

- **给老板/开发**：N 的口径表（各任务类型正常步分布 + 卡死样本）与最终取值、为什么；心跳加在了哪几处；真机复现改前/改后；误触发核验 0 条与否；修缮 20（12 处统一换）你建议的核对办法；第 7 条要不要顺着看门狗的位置一起处理（只给建议，不做）
- **给建造线**：本轮几笔、改了哪些文件；**新日志** `[TASK_UPDATE_WATCHDOG]` / `[TASK_UPDATE_LATE_RETURN]` / `dig_timeout` / `target_out_of_reach`（若做了）；**行为变化**：卡住 N 秒的施工一步会被判失败放行（保姆脚本里「同砖三败」与它的关系写清——一次看门狗算不算一败，给建议）；若在 `tasks/build-task.js` 加了心跳，写清行号
- **给后勤线**：无（除非发现意图词表问题）

## 红线

- 一轮主攻一个根因（17）；**不重构 TaskManager**——只在 `tick()` 的 await 处套一层 + 一个迟到守卫 + `ctx.heartbeat()`，仲裁/挂起/恢复逻辑一字不动
- 地盘避让见第 0 节；不碰 `actions/build.js`、`UtilityBlockSearch.js`
- 在 `2ef88e3b` 之上提交，**不 rebase、不改写历史**（建造 27 合那个快照）
- 只在修缮世界 25566 跑；不进建造/后勤 worktree、不连 25565；收工只杀本线、按端口/工作目录核对、排除 `$PID`
- 脚本放 `.tmp/`；`data/memory/*`、`logs/*`、`.tmp/*` 不提交；提交显式指定文件；禁 `git add -A` / `reset --hard` / `clean` / `stash` / `checkout --`
- 不把 FAIL 写成 PASS、不藏 BLOCKED；每条结论标 已证实 / 合理推断 / UNKNOWN；N 若定不下来写「等老板拍板」

## 分步验收

| 步 | 完成判据 | 做不完怎么办 |
|---|---|---|
| 1 | 冻死离线复现（改前）→ 口径表 + N → 看门狗 + 迟到守卫 + 心跳 + 挖掘超时 + 单测 + 反证 → 真机复现不冻死、正常序列 0 误触发 | N 分不开 → 状态「等老板拍板」附候选；真机误触发 >0 → 如实写次数与那一步是什么，不调大 N 糊过去 |
| 2 | 两个 UNKNOWN 的取证结论 | 没余力写「未做」 |
| 3 | 全绿 + 归档 + 提交 + 候选池更新 | — |
