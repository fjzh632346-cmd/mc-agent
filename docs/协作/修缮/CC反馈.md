# 修缮 第 18 轮反馈

- 线: 修缮（协调线）
- 轮次: 18
- 日期: 2026-09-14
- 状态: 已完成（第 1 步根因钉到行号、两处补丁、单测 + 反证、真机判据全部达标；第 2 步做完；第 3 步 24 做了，23 **没做**——任务书写的前提在日志里不成立，证据见技术细节）
- 分支 / HEAD: feat/fix / 2ef88e3b（在 dcc8b215 之上新增 4 笔，未 rebase、未动历史）
- 实际运行的模型 / 强度 / 是否 ultracode: **Opus 5**；思考强度 **UNKNOWN**（会话内读不到生效档位）；**全程未开 ultracode**（按任务书：一处搜索、一个根因，一支探针直接连服务器量比撒子代理硬）

---

## 一句话结论

她不会再因为一句「你现在在干嘛」卡住十几秒被服务器踢下线了：原因是每找一次工作台或床，她都要把自己周围同一片地一格一格重新数五十遍（记忆里每座盖过的房子数一遍），而且每一遍连整段全是空气、全是石头的地方也一格一格数；两处都改了，真机上一次查找从十秒左右降到二三十毫秒，同一套触发序列跑下来零卡顿、零踢线；顺手让她死的时候把排着队还没开始的活一起清掉，并把「备料缺三块圆石」说成人话。

## 白话摘要

上一轮我猜的原因是「她记住的工作台和床里混进了一千多格外的远点，一个个算路过去算太久」。这轮先量再改，结果这个猜测是错的：她记住的全在五十格以内，找的过程里也根本没有算路这一步。真正花时间的是两件事叠在一起：一是找东西时会顺带看「附近有没有盖过的房子」，而记忆里已经攒了五十座房子，程序给每一座都把她身边同一片地重新数一遍，数出来的结果五十遍一模一样；二是游戏新版本里，整段只有一种方块（全是空气或全是石头）的区块没有「目录」，找东西的程序看不到目录就只好一格一格数，她脚下这片地三分之二都是这种区块。

第一处改成「同样的范围一次查找里只数一遍」，第二处改成「整段只有一种方块、又不是要找的，就直接跳过」，找到的东西和以前逐格核对过、完全一样。在真机世界上量：一次查找从三秒四（单独测）降到二十毫秒上下；让她本人按上轮会卡死的四种说法各来一遍——问三次「你现在在干嘛」、「去周围看看」、夜里「去睡觉」、没有镐时「去挖矿」——十一次查找每次二十到五十毫秒，一次卡顿都没有，服务器零踢线。上一轮没能验到的「找路探索」这一种也跑到了，不过这次是她自己判断「附近没有安全的点可去」没成功，不是卡死。

另外两件小事：她死的时候，排在队里还没开始的活也一起清掉了（按老板定的）；还有「备料失败」那句，以前说「附近条件不够」，现在会说「备料缺三个圆石」。任务书里另一条小活（血量很低时那句空话）我没做，因为翻日志发现那句空话其实不是在血量低时说的，而是她死后在一千多格外复活、准备往家走时说的，要改的话得跟「复活后离家太远要不要先问你」一起定。

下一步按老板定的顺序做修缮 19：给每一步执行加个上限，任何一步卡住都不能把后面所有的活一起拖死。

## 需要老板拍板的问题

### 问题 1：你问「你现在在干嘛」时，她要不要顺带去找一次工作台和床？

- 背景：这句话会顺手查「附近有没有工作台（能不能合成）」和「附近有没有床（能不能睡）」，把结果一起报给你。上一轮就是这两次查找各卡十秒把她卡掉线的。现在两次加起来五十毫秒左右。
- 选项 A：**维持现在**。代价：每问一次多花几十毫秒，你感觉不到。
- 选项 B：**改成只报上次找到的结果，不当场找**。代价：报出来的可能是过时的（比如你刚拆了那张床她还说有床）。
- 我的建议：A。卡死的根子已经拔了，现在这点开销不值得换来「报的可能不准」。

### 问题 2：同一种「一格一格数」的慢法，还有十二处别的地方在用，要不要统一换掉？

- 背景：这轮只改了「找工作台/床/箱子/熔炉」那一处。挖矿找方块、种地找庄稼、睡觉自己找床、探索、存东西、烧炼找熔炉等十二处，直接调的是游戏库原来那个查找，照样一格一格数。单次一般零点一到零点三秒，机器忙的时候能到三秒；它们一次只数一遍，所以没到卡死踢线的程度，但会让她时不时顿一下。
- 选项 A：**修缮 19 之后单开一小轮统一换**。代价：十二处要逐处核对「找到的东西不变」，一轮。
- 选项 B：**不动**，等真有卡顿的现场再说。代价：挖矿、种地这类频繁找方块的活仍然偶尔顿一下。
- 我的建议：A。这轮已经证明换法安全（五种方块逐格核对一致），挨个换是体力活，排在修缮 19 后面。

## 技术细节

### 一、开场（已证实）

上一轮反馈整份归档到 `D:\code\MC-blueprint-ir-v1\docs\协作\历史\修缮第17轮-死亡链根治与对照表与完整一局.md`（41557 字节，主仓只新增这一个文件）。开场 `git status --short` = 两个 `data/memory/*.json` 脏 + `construction-runs.json` + `.tmp/` + `=` + 本线 docs 目录（均非本轮产物，未动）；`git log` 头部 `dcc8b215`；分支 `feat/fix`；`npm test` **79 组 passed / exit 0**。

### 二、第 1 步：清单 18 根因（已证实，钉到行号）

**2.1 上一轮的「合理推断」被证伪**

- `systems/UtilityBlockSearch.js:68-131`（`dcc8b215` 版本）整段是同步代码：读记忆 → `bot.findBlocks` 扫描 → 按距离排序取第一个。**没有任何可达性/寻路计算**。
- 第 17 轮卡死那几次的候选全部在近处：`logs/bot-2026-09-13-04-54-47.log` 11:57:14.043 `positions=1541,121,1494|1502,120,1500|1527,121,1524|1535,121,1532|1495,121,1537`；记忆里 `knownUtilityBlocks` = 工作台 5 张、床 5 张，坐标全在 1491..1541 / 1494..1538。**没有远点**。

**2.2 真正的时间线（已证实）**

同一份日志 11:57:03.740 `你现在在干嘛`（状态读背包锁放掉）→ **10.3 s 静默** → 11:57:14.043 `[utility-search] type=crafting_table` → **9.9 s 静默** → 11:57:23.947 `[utility-search] type=bed` → 11:57:23.979 `ECONNRESET` → `[EVENT_LOOP_STALL] stallMs=20274`。`[utility-search]` 那一行是在搜索**结束**时打的，所以两段静默就是两次搜索本身。

触发链：`TaskManager.status()`（`tasks/task-manager.js:751` `craftingSystem.getCraftingStatus` → `systems/CraftingSystem.js:926` `_findNearbyCraftingTable` → `findNearestCraftingTable`；`:759` `findSleepState` → `utils/sleep.js:118` `buildSleepState` → `findNearestBed`）。

**2.3 探针量出来的两层乘法（已证实）**

探针 `.tmp/r18/probe-search.js`：一个普通 mineflayer 客户端连 25566，站到她上轮站的位置，用真世界 + 真记忆（`data/memory/world-memory.json` 拷到临时目录的副本，50 座 `builtStructures`）调产品代码，包一层 `bot.blockAt` 计数。

| 测什么（`dcc8b215` 原码） | 耗时 | `blockAt` 次数 |
|---|---|---|
| 区段普查（±5 区块） | 2904 段里 **1885 段是单值容器、没有调色板** | — |
| 一遍 `findBlocks` 半径 32 | 72 ms | 139,264 |
| 一遍 `findBlocks` 半径 64 | 312 ms | 737,280 |
| `findUtilityBlock('crafting_table')` 整次 | **3418 ms** | **7,839,856** |
| `findUtilityBlock('bed')` 整次 | 3537 ms | 7,840,167 |
| 其中 `builtStructureCandidates` 单独 | **2972 ms（87%）** | **6,963,300（= 50 × 139,264）** |

- **第一层（次数）**：`builtStructureCandidates`（原 `:234-252`）对记忆里**每一座**房子调一次 `findBlocksNear(… max(area.radius, nearbyRadius)=32, 32)`（原 `:246`），而 `findBlocksNear` 调的 `bot.findBlocks` **以她为中心**（mineflayer 默认 `point = bot.entity.position`），不是以房子为中心——50 遍参数相同、结果相同，再各自按房子范围过滤（原 `:247-248`）。加上近处一遍、基地一遍，一次搜索 **52 遍全量扫描**。
- **第二层（单价）**：`node_modules/mineflayer/lib/plugins/blocks.js:122-137` `isBlockInSection`：`if (section.palette)` 才看调色板跳过，否则 `return true`；`prismarine-chunk` 1.18+ 的 `SingleValueContainer`（整段一种方块）**没有 `palette` 属性**（`PaletteChunkSection.js:35` `this.palette = this.data.palette` 取到 `undefined`），于是这类区段被逐格 `blockAt` 扫满 4096 格。
- 探针是闲置独立进程；真 bot 事件循环里还有物理/收包，同样的活慢 ~3 倍（第 17 轮 10 s 对探针 3.4 s）。

**2.4 为什么第 16 轮没事、第 17 轮每局必撞（合理推断）**：代价随记忆里的房子数线性涨。第 16、17 轮在修缮世界里反复盖小木屋、死亡续建，`builtStructures` 攒到 50。

### 三、第 1 步：两处补丁（`57f1da82` + `6209a1c5`）

**3.1 `57f1da82` 一次搜索内按「半径/个数」只扫一遍**

- `findUtilityBlock` 里建一个本次搜索的 `scanCache`（`systems/UtilityBlockSearch.js:74-80` 注释 + `new Map()`），`findBlocksNear(context, names, radius, count, scanCache)`（`:219-225`）命中就返回；`builtStructureCandidates(…, scanCache)`（`:256`）共用。
- **语义不变的理由**：被去掉的只是「参数相同、以同一点为中心」的重复扫描，每遍返回同一个列表；每座房子的范围过滤原样保留。
- 同时加 `[utility-search-done] type= candidates= totalMs= scans= steps=memory:…,nearby:…,baseArea:…,builtStructures:… slowest=`（`:128-130`）。任务书要的「逐候选计时」按实际结构改成了「逐步计时」——搜索里没有逐候选计算这一步（二.1）。
- 探针复测：`crafting_table 3418 → 338 ms`、`bed 3537 → 350 ms`，`blockAt 7.84M → 0.88M`，**选中的坐标与候选数完全相同**（5 / 10）。离线 `TaskManager.status()` 一次：**105 遍 → 5 遍**（`.tmp/r18/status-scan-count.js`）。

**3.2 只有第一处时真机不达标（如实记录，已证实）**

第一遍真机（`verify`，HEAD `8925c376`）：0 次踢线，但 11 次搜索 `totalMs=397..3841`，**4 次 `[EVENT_LOOP_STALL]`：4958 / 7559 / 3525 / 3370 ms**，全部 `slowest=baseArea`（半径 64 那一遍 0.3~3.2 s，随机器负载起伏；`.tmp/r18/pos-raw` 同一位置复测回到 316~394 ms，与站位无关）。判据 `stallMs ≤ 2000` 与 `totalMs ≤ 1000` 均未达。剩下的就是二.3 的第二层。

**3.3 `6209a1c5` 跳过「整段只有一种方块、又不是要找的」区段**

- `sectionAwareFindBlocks`（`:306-342`）：与 mineflayer 4.37.1 `findBlocks` **同一个 `OctahedronIterator`、同一个匹配（`blockAt(cursor,false).type`）、同一个「层走完且够数才停」、同一个排序截断**，只在 `sectionMayContain`（`:299-304`）里多认一种能跳过的：`section.data.value` 存在（单值容器）且那一种方块不是要找的。带调色板的区段照旧查调色板；两者都没有的（直接调色板）照旧扫。
- 只在区段可读时走它（`canScanBySection`，`:287-297`：`bot.world.getColumn` / `registry.blocksByStateId` / `game.minY/height` / `entity.position.floored` / `prismarine-world` 迭代器都在）；否则回落到原来的 `bot.findBlocks` / `bot.findBlock`——单测里的假 bot 走的就是回落路径。
- **`prismarine-world` 不是本仓直接依赖**（mineflayer 的依赖，已提升到顶层 `node_modules`）；`require` 包了 `try`，缺了就回落，不会报错。
- **探针逐格核对（真世界，已证实）**：五组 `same=true`——工作台 r32（2 个）、工作台 r64（5）、床两色 r64（10）、箱子组 r64（5）、熔炉组 r64（5）；半径 64 一遍 **314 ms / 737,280 次 → 9 ms / 16,389 次**。整次搜索 `crafting_table 23 ms`、`bed 21 ms`，选中与候选数同前。

### 四、第 1 步：单测与反证（`tests/systems.test.js`，追加 3 个函数，未改既有）

| 测试 | 断言 | 反证 |
|---|---|---|
| `testUtilityBlockSearchScansOncePerRadius` | 50 座房子（1 近 49 远）时 `findBlocks` 调用序列恰为 `['32/32','64/64']`；结果仍是最近那张工作台；`[utility-search-done]` 带 `scans=2`、`totalMs=` | 去掉缓存命中那一行 → 调用 52 次（`'32/32'` ×51）→ 红；还原绿 |
| `testStatusQueryDoesNotRescanPerRememberedStructure` | 真 `TaskManager` + 真 `CraftingSystem`，50 座房子，一次 `status()` 扫描 ≤ 6 次（**只卡上限，不规定状态查询该不该搜**，那是问题 1） | 换回 `dcc8b215` 的搜索 → `status() scanned 105 times` → 红；还原绿 |
| `testUtilityBlockSearchSkipsUniformSections` | 假区块一列 8 段：1 段带调色板含工作台，1 段整段石头、6 段整段空气（均无调色板）；找到 `5,64,3`；`blockAt ≤ 2×4096+16`；不得调用库的 `findBlocks` | 去掉单值区段跳过那一行 → `blockAt called 61442 times` → 红；还原绿 |

### 五、第 1 步：真机（修缮世界 25566，探针 bot `EVENT_LOOP_PROBE=true`）

**候选表条件**：任务书要「人为把候选表弄脏（远点）」——远点假设已证伪（二.1），所以**直接复用第 17 轮留下的世界记忆**（50 座房子、5 桌 5 床），这正是卡死的真实条件，写明用的是这种。

序列 `.tmp/r18/steps-verify.js`：`你现在在干嘛` ×3（间隔 15 s）→ `去周围看看` → 传回 → 夜里 `去睡觉` → `起床` → 白天、手上无镐 `去挖矿` → `停下` → `你现在在干嘛`。

| 判据 | 改前（第 17 轮 `full3`） | 只有 `57f1da82`（`verify`） | 两笔都在（`verify2`，HEAD `6209a1c5`） |
|---|---|---|---|
| `[EVENT_LOOP_STALL]` | 20274 / 15011 / 12724 / 11825 ms | 4958 / 7559 / 3525 / 3370 ms | **0 条** ✔（60 s 窗口 `loopP99Ms=36..193 maxStallMs=0`） |
| 服务器 `latest.log` `Timed out` | 3 次 | 0 | **0** ✔（唯一一条 `lost connection` 是驱动玩家自己退出） |
| `[utility-search-done] totalMs` | （约 10 s/次，推算） | 397..3841 | **21..49**（11 次）✔ |
| 「你现在在干嘛」回话延迟 | 20 s 后掉线 | 0.9..2.2 s | **~0.1 s**（13:01:13.640 → .776） |
| `exploration` | 0 次（一说就被踢） | start + fail | **start + fail** ✔（`safe_explore_point_not_found`，0.2 s 内） |

顺带观察（未深究）：`去睡觉` 找到床并躺下（「我躺好了」）；`去挖矿` 失败于 `auto_preparation_failed:missing_materials:cobblestone=3`（前一步 `wooden_pickaxe result=failed reason=crafted_item_not_available:0/1`，手上有木板木棍却没做成木镐——**原因 UNKNOWN**，记候选）；探索失败原因 **UNKNOWN**（首跑，靶场石台四周是更低的地形，是否因此无安全点未查）。

### 六、第 2 步：死亡时清队列（`8925c376`，#106）

- `tasks/task-manager.js:459-469` `abortAllForDeath`：当前任务 + 挂起栈之后，把 `this.queue` 整个取下清空，逐个 `resumable=false`、`state=INTERRUPTED`、`interruptReason=bot_died`，记 `interrupted` + 任务记忆，打 `[TASK_INTERRUPTED] taskId= type= reason=bot_died queued=true`。**不调 `interrupt`**（没起过、没持锁）。返回值（`dropped`）不变，所以复活那句话、宿主钩子都不变。
- `core/death-handler.js`：死前快照多记一份 `queued`（与 `paused` 同样的做法），`[BOT_DEATH_RESET]` 加 `queuedDropped=mining#4` 这样的字段。
- 单测 `tests/death-respawn.test.js` 第一组：「队列原样」改为「队列空 + 队列任务 `INTERRUPTED` / `bot_died` / `resumable=false` + `interrupted` 共 4 条 + 有 `queued=true` 日志 + **没有** `[Task:mining#4] interrupt` + 重置行含 `queuedDropped=mining#4`」。反证：把清队列那两行换成空数组 → `actual: 1 / expected: 0` 红；还原绿。「守着我」名单未动（#107）。
- 真机本轮未造死亡（任务书此步只要求单测）。

### 七、第 3 步

**24（`2ef88e3b`，做了）**：`ai/message-generator.js` 对照表加前缀行 `auto_preparation_failed:missing_materials:` → `friendlyPreparationMaterials`：解析 `item=count,…` → 「备料缺 3 个圆石、1 个橡木原木」。`tests/message-generator.test.js` 表驱动用例加 2 条（两件 / 一件）。反证：删掉那一行 → 该键落到兜底、测试里的「不许记成未映射」日志钩子抛错 → 红；还原绿。本轮真机那句「挖矿没成功，附近条件不够」正是这个键，合并后会变成「挖矿没成功，备料缺 3 个圆石」（**真机未复验，合理推断**：同一条 `taskFailedText` 路径，单测已覆盖整句）。

**23（没做——前提不成立，已证实）**：任务书写「血量 2 时 `EAT_FOOD` 的提醒是空的 GENERAL」。第 17 轮日志 `logs/bot-2026-09-13-04-22-00.log`：
- 11:42:56.756 `[survival] health=2 food=17 action=EAT_FOOD dangerLevel=critical` —— 这是**死前**；这一档映射到 `LOW_HEALTH`，有话术（「我血量有点低，剩X点」），不是空的。
- 11:42:57.4 死亡、复活 → 11:42:57.529 `[survival] health=20 food=20 action=RETURN_SAFE` → 紧接 `[response] … message=我发现了一些情况，需要你看一下。` —— **空话是复活后 `TOO_FAR_FROM_BASE` 说的**。
- 全部两次空 GENERAL（`.tmp/r17/full-c-raw/step11.log:339` 与上面同一处）都是 `action=RETURN_SAFE health=20`。
- 根源：`systems/survival-system.js:1152-1160` `reminderTypeForSurvivalPriority` 对 `TOO_FAR_FROM_BASE`、`STUCK_OR_FALL_RISK` 没有映射，落到 `GENERAL`。
- 为什么不顺手补：给「离家太远」配一句话，内容取决于清单 22（复活后夜里硬走 1500 格回家，建议「离家太远先问玩家」）怎么定——现在补「我先往回走」，定了「先问」又得改。候选池里把 23 并进 22。

### 八、第 4 步：回归与提交

- `npm test`：开场 79 组 / 第 1 步 79 / 第 2 步 79 / 第 1 步第二笔 79 / 第 3 步 79，**全部 exit 0**。组数不变——新测试都加在既有文件里（`systems` +3 个函数、`death-respawn` 改 1 组、`message-generator` +2 条用例）。第 16 轮仲裁单测、第 17 轮死亡链 7 组与对照表用例全部通过。
- 4 笔提交，显式指定文件：
  - `57f1da82` `systems/UtilityBlockSearch.js` + `tests/systems.test.js`
  - `8925c376` `tasks/task-manager.js` + `core/death-handler.js` + `tests/death-respawn.test.js`
  - `6209a1c5` `systems/UtilityBlockSearch.js` + `tests/systems.test.js`
  - `2ef88e3b` `ai/message-generator.js` + `tests/message-generator.test.js`
- `git diff --stat dcc8b215..HEAD`：7 个文件，+270 / −15。

## 按 AGENTS.md 第 11 节

**1. 读过的文件**：本线 `说明.md` / `给CC.md` / `CC反馈.md`（第 17 轮）；主仓（只读）`docs/协作/说明.md`；`AGENTS.md`；记忆 `tick-freeze-and-loop-stall-r17`；`systems/UtilityBlockSearch.js`、`systems/CraftingSystem.js`（`_findNearbyCraftingTable` / `getCraftingStatus`）、`utils/sleep.js`、`tasks/task-manager.js`（`status` / `abortAllForDeath`）、`core/death-handler.js`、`memory/{world-memory,memory-store}.js`、`systems/survival-system.js`（只读 `reminderTypeForSurvivalPriority` 与生存提醒段）、`ai/message-generator.js`、`systems/worksite-anchor.js`（只读取消路径）、`tests/{systems,death-respawn,message-generator}.test.js`；`node_modules/mineflayer/lib/plugins/blocks.js`、`node_modules/prismarine-chunk/src/pc/common/{PaletteChunkSection,PaletteContainer}.js`、`node_modules/prismarine-world/src/iterators.js`（只读）；第 17 轮 `.tmp/r17/*` 脚本与 `logs/bot-2026-09-13-*.log`。

**2. 改动的文件**：见八。**未提交**：`data/memory/*`、`.tmp/r18/*`、`.tmp/r18-npm-test-*.log`、`logs/*`、`docs/协作/修缮/`。**地盘避让**：`systems/building-system.js`、`systems/storage-system.js`、`actions/build.js`、`survival-system.js` 的 `actionForPriority` / `enqueueDecisionTask` **一字未动**；`task-manager.js` / `death-handler.js` 只动了第 2 步那一处；`node_modules` 一字未动。

**3. 执行的命令**：`git status/log/branch/diff/show`、显式 `git add <文件>` + `git commit` ×4；`npm test` ×5 + 单文件测试若干；反证 5 次（均就地替换、从 `.tmp/r18/*.fixed*.js` 还原复绿）；`node .tmp/r18/{probe-search,probe-section-scan,status-scan-count,playthrough,add-*-test}.js`；`mc-server.ps1 start|stop|status`（`MC_SERVER_DIR=D:\code\MC-server-fix`，JDK 21）；bot 起 2 次（`.tmp/r18/start-bot-probe.ps1`：`Start-Process node bot.js`，tag=verify / verify2，均带 `EVENT_LOOP_PROBE=true`）；RCON `forceload/gamerule/time/tp/clear/give/kill/save-all/stop`（口令每次从 `server.properties` 现读，未落盘）。
**收工核对**：两次 `Stop-Process` 前都用 `Get-CimInstance` 看命令行 + `Get-NetTCPConnection` 确认连的是 25566、且不是 `$PID`；服务器 RCON 优雅停，`status` = `not running`；收工后本机无残留 `node.exe` / `java.exe`。
**未执行**：`npm install/ci/update`、`git add -A`、`reset --hard`、`clean`、`stash`、`rebase`、`checkout --`、`syncCommunityBlueprints`、`taskkill /IM`、任何连 25565 或进建造/后勤 worktree 的操作。

**4. 测试结果**：开场 79 组 / 终态 **79 组 passed，exit 0**；新增与改动的断言全部在反证下变红、还原后复绿（四、六、七）。

**5. 当前最新判定**：
- 清单 18 的卡死 = 一次搜索内以她为中心的同参数全量扫描被重复 52 遍（`UtilityBlockSearch.js` 原 `:93` → `:246`，每座记忆中的房子一遍）× 每遍对无调色板的单值区段逐格 `blockAt`（`mineflayer blocks.js:136`）→ **已证实**（探针计数 50×139,264 与实测 6,963,300 相等 + 真机时间线）；
- 上一轮「候选混进远点、逐个算可达性」→ **已证伪**；
- `57f1da82` 去掉重复扫描后结果不变、次数 52→2 → **已证实**（单测 + 反证 + 真世界探针选中与候选数一致）；
- 只有它时真机仍有 3.4~7.6 s 卡顿 → **已证实**；
- `6209a1c5` 跳过单值区段后结果逐格一致、单遍 314→9 ms → **已证实**（五组 `same=true`）；
- 两笔都在时真机 0 卡顿、0 踢线、搜索 21..49 ms、探索首跑到 → **已证实**；
- 状态查询顺带做两次搜索 → **已证实**（`task-manager.js:751/759`），改不改 → 问题 1；
- 死亡清队列 → **已证实**（单测 + 反证；真机未造死亡）；
- 23 的空话出自 `TOO_FAR_FROM_BASE` 而非血量 2 → **已证实**；
- 真机那句备料失败合并后会说对 → **合理推断**（单测覆盖整句，真机未复验）；
- 探索 `safe_explore_point_not_found` 的原因、木镐 `crafted_item_not_available:0/1` 的原因 → **UNKNOWN**。

**6. 生成文件 / 内存是否变脏**：`data/memory/{task-memory,world-memory}.json` 在本轮 bot 运行中继续变脏（开场已脏，**均未提交**）；探针用的记忆是临时目录里的副本，未写回。`.tmp/r18/` 新增（探针脚本与输出、驱动与步骤表、两段真机 raw/trace、bot 日志、反证用副本）。**修缮世界**：沿用第 16 轮石台，本轮未新建方块；她在 `1505,116,1508` 附近有一个第 16/17 轮挖出的坑（探针与她都落到 y=116），未填。收尾 `doDaylightCycle/doMobSpawning true`、`keepInventory false`、`time set day`、`forceload remove all`、`save-all flush` 均回显成功。

**7. 是否建议提交**：已提交 4 笔（在 `dcc8b215` 之上，未 rebase）。建造 27 合的是 `dcc8b215` 快照，**本线待下次合并轮收的是这 4 笔**。

**8. 剩余风险**：
- **中**：`sectionAwareFindBlocks` 复刻了 mineflayer 4.37.1 的遍历。**升级 mineflayer 时要复核**：若库修好了单值区段（或改了遍历/提前收手规则），这份复刻要么删掉、要么对齐。已在代码注释里写明来源版本。
- **中**：依赖 `prismarine-world` 的迭代器（传递依赖、非直接依赖）。缺了会自动回落到库的慢扫描，不报错，但性能回到改前第二层——`[utility-search-done] steps=` 里 `baseArea` 回到几百毫秒就是它。
- **中**：「同参数只扫一遍」在 mineflayer 提前收手触发时（某种方块在范围内超过 32/64 个）与改前逐遍扫描的结果**理论上也一致**（同参数同中心、同一份世界快照）；但同一次搜索内若世界在两次调用之间变了，改前后一遍能看到、现在看不到——一次搜索几十毫秒，可忽略。
- **低**：其余 12 处直接调库 `findBlocks` / `findBlock` 的地方（`actions/{farm,mine,storage,smelt,explore,craft}.js`、`utils/sleep.js`、`bot.js`、`systems/{farming-system,SmeltingSystem,CraftingSystem}.js`、`tasks/mine-nearby-block-task.js`）**仍付第二层的单价**（问题 2）。
- **低**：真机只验了四种触发；建造中自动补料找箱子（`chest`）这条路没在真机上走（探针已验箱子组结果一致、9 ms）。
- **低**：第 2 步真机未造死亡。

## 交接

### 给老板 / 开发

- **18 的根因**：不是远点、不是算路；是「同一片地重复数 50 遍」×「全空气/全石头的区段逐格数」。两层都在搜索文件里，两笔都修了，改前改后见五。
- **「你现在在干嘛」为什么会搜**：状态汇报里含「附近能不能合成」「附近能不能睡」，各查一次。现在五十毫秒，建议维持（问题 1）。
- **修缮 19（清单 17）我建议的落点与判据**：
  - 落点一（结构保险）：`TaskManager.tick()` 里 `await activeTask.update(ctx)` 外面套看门狗——超过 N 秒没返回：打 `[TASK_UPDATE_WATCHDOG] taskId= type= elapsedMs=`，把该任务按 `update_timeout` 走 `fail`（放锁 + 封 owner，修缮 15 那套保证卡着的续体抢不到锁），`isTicking` 复位让下一拍照常跑。卡住的那个 promise 不强杀，只是不再挡门。
  - 落点二（真正卡住的那一下）：`actions/mine.js:179` `await bot.dig(fresh)` 加超时，超时 `bot.stopDigging()` 并按失败返回。
  - N 的取值需要一个口径：第 15 轮量到小木屋正常一步最长 8.6 s；门楼 478 s 那一步本身就是卡住。建议默认 60 s、施工任务每放一块刷新一次心跳（**合理推断**，要在修缮 19 离线量）。
  - 判据：离线——一个 `update` 永不返回的假任务，N 秒后下一条排队任务开始、`停下` 生效、卡住任务的 owner 再抢锁得 `owner_terminated`；真机——复现第 17 轮（挖矿中 RCON 传送），不冻死，看门狗 1 条，下一条命令在 N+1 秒内 `start`。
  - 注意：第 15、16 轮的第 7 条（高优先插队要等当前这一步做完）**不会**被看门狗解决（N 秒以内照样要等），它是同一个位置的另一个问题。

### 给建造线

- 本轮 4 笔、7 个文件：`systems/UtilityBlockSearch.js`、`tests/systems.test.js`、`tasks/task-manager.js`（`abortAllForDeath` 一处 +12 行）、`core/death-handler.js`（+1 行快照、日志加一个字段）、`tests/death-respawn.test.js`、`ai/message-generator.js`（对照表 +1 行 + 1 个解析函数）、`tests/message-generator.test.js`。**与 `dcc8b215` 零冲突预期**（全部是它之上的顺序提交，没有改写历史）；与建造 27 同时在合的 `feat/ops@a6242a5b` 若也动了 `ai/message-generator.js` 的对照表，是**相邻行追加**，手工并即可。
- **新日志**：`[utility-search-done] type= candidates= totalMs= scans= steps=… slowest=`——施工中补料找箱子也走这条，`totalMs` 超过几百毫秒说明回落到了库的慢扫描（见剩余风险第二条）；`[BOT_DEATH_RESET]` 多了 `queuedDropped=`；死亡时队列任务打 `[TASK_INTERRUPTED] … reason=bot_died queued=true`。
- **行为变化**：她死的时候，排着队还没开始的活也清掉了（#106）。保姆脚本若在她死后按「队列里还有续建令」判断，要改成死后重发。

### 给后勤线

- 第 20 条（`铁矿` → `raw_iron` 只认一个名字，`ai/intent-parser.js:1183`）照旧转你们；第 15 条（`照看农田` 被判成盖房）照旧。

## 候选池（更新）

1. ~~清单 18 搜索卡死被踢~~（**本轮 `57f1da82` + `6209a1c5`**）；~~死亡时队列留着~~（**本轮 `8925c376`**）；~~24 备料缺料话术~~（**本轮 `2ef88e3b`**）
2. **修缮 19（已定 #108）**：清单 17 一次挖不回来的挖掘冻死任务系统——每步执行上限 + 放行后面的活（落点与判据见交接）
3. **问题 2**：其余 12 处直接调库 `findBlocks` 的地方统一换成跳过单值区段的扫法
4. **22 + 23 合并**：复活后离家一千多格——夜里硬走回家走进坑（22），且那一刻说的是空话「我发现了一些情况」（23，`TOO_FAR_FROM_BASE` / `STUCK_OR_FALL_RISK` 无提醒映射）；建议「离家太远先问玩家」，定了再配话术
5. 「守着我」顶掉跟随后改成会自动接回（#107 记候选）
6. **新**：探索首跑 `safe_explore_point_not_found`（0.2 s 内，靶场上，原因 UNKNOWN）
7. **新**：手上有木板木棍，自动备料做木镐失败 `crafted_item_not_available:0/1`（原因 UNKNOWN）
8. 19 `续建` 丢档位（转建造线）；20 `铁矿` 只认 `raw_iron`（转后勤线）；21 `fight_nearby_mob` / `mine_nearby_block` 聊天不可达（开发判不补入口）；15 `照看农田` 判成盖房（后勤）
9. 仍在的老条目：玩家挡工地整单失败（判据侧，建造线）；高优先插队等长 update（第 7 条，与修缮 19 同位置不同问题）；「停下」误杀挂起栈；采矿挖脚下；安全模式闸是死代码；`drop_not_found` 判整条失败；「去挖矿」目标是石头；夜里自保空；生存日志刷屏；锚点刷新挂在 tick 队列（15）
10. 更早的：残留账只在内存；`minimumPlacementStandY`；净空柱判据；`CHEST_PATH_UNREACHABLE` 落差；`EVENT_LOOP_STALL` 在图纸加载处；`.tmp/rcon-many.js` 明文口令（历史遗留）
