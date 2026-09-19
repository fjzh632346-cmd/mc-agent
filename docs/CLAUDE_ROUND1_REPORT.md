# Claude Round 1 Report — 建造系统只读核查

- Date: 2026-08-30
- Worktree: `D:\code\MC-blueprint-ir-v1`
- Branch: `refactor/building-blueprint-ir-v1`
- HEAD: `46597d1751a8b1bd5ff6a30cd2ec47eb631ba5f8` (`46597d17`)
- Scope: 只读核查 + 优先级表交付。**未修改任何业务代码，未提交，未跑真机验收。**
- 完整优先级表（详版）: https://claude.ai/code/artifact/c2f76862-b35d-4810-8501-0ce57c7d6cef

所有结论标注为「已证实 / 合理推断 / UNKNOWN」三类之一。

---

## 0. 先纠正三条前提（交接给我的「已知现状」有三条与代码不符）

### 1. 门感知寻路已经实现了 —— 已证实

交接文档写「door-aware pathfinding still missing，一直靠 workaround 绕过」，但同一天的提交
`cc9a39db fix(pathfinding): route through wooden doors (canOpenDoors was dead for doors)` 已落地：

- `actions/move.js:87-101` 的 `enableDoorTraversal()` 打开 `movements.canOpenDoors`、把非铁门注册进 `openable`、按门的实时状态重分类。
- 同时安装了 `installDoorAwarePathNormalizer`，把门格节点吸附回可站立格。
- `tests/door-traversal.test.js` 存在，且在 `npm test` 中通过。

文档写的是修复落地当天的状态，之后没人回来改。

### 2. `docs/decision-needed.md` 三条全部过期 —— 已证实

三条记录都写于 2026-05-30。当前代码里：

- `ai/planning-system.js:201` 规划铁镐时已经产出 `SMELT_ITEM` 步骤。
- `ai/planning-system.js:232` 与 `:277` 已经产出 `RETURN_TO_BASE`。
- `tasks/return-to-base-task.js`、`tasks/smelt-task.js`、`systems/SmeltingSystem.js` 均存在。

更硬的证据：`ai/goal-system.js` 里 `writeDecisionNeeded()` 只剩一个调用点（`:173`，关于 EscapeTask），
`ai/planning-system.js:163` 的同名方法**零调用点**。也就是说这三条消息，现在的代码根本已经写不出来了。
这个文件是只追加不清理的，不能当现状读。

### 3. 07-04 → 08-01 的历史断层已从 git 补上 —— 已证实

不是四周空白。`git log` 显示 07-27 到 08-01 有 **27 次连续的建造修复提交**
（`502ffe39` 起，到 HEAD `46597d17` 止），主题集中在：脚手架与建造目标冲突、垂直通道规划、
放置站位与 reach、resume 对账、临时参照物回收。07-04 到 07-27 之间确实无提交。

另外 `logs/bot-current.log` 覆盖的是 **2026-08-01T23:39Z → 2026-08-04T14:42Z**，即验收之后还有三天的运行记录；
08-01 验收当时的日志在轮转文件 `logs/bot-2026-08-01-03-19-11.log` 与 `logs/bot-2026-08-01-03-40-31.log` 里。

### 4. 关于「两条长期缺陷是否与 case2 同根」

- 门感知寻路那条：**不是**（已实现，见上）。
- 「封闭房屋内部清理会选屋外站位并 move_timeout」那条：**是同一类根因**，但 case2 的表现形式不是
  「屋外站位」，而是「山坡下方站位」。共同的根是：站位选择只看几何距离，不看路径可行性。

---

## A. case2 `move_timeout` 的完整现场 —— 已证实

证据来自 `logs/bot-2026-08-01-03-40-31.log` 与 `acceptance/reports/latest-report.json`。

清障阶段（`clear_obstruction`）在给别墅整地。目标格 `583,65,-91`，机器人当时站在 `579.5, 65, -94` 附近。
站位候选**全部 9 个都在 y=62** —— 比目标低 3 格，说明目标旁边就是一段 3 格落差的坡。

```text
10:42:01.290 [BUILD_STANCE_CANDIDATES] target=583,65,-91 total=9
                                       attempts=583,62,-90|584,62,-90|582,62,-90|586,62,-90
10:42:01.291 [BUILD_PLACE_REPOSITION] target=583,65,-91 stand=583,62,-90
10:42:07.080 [状态] x=609.90 y=65.00 z=-95.50           ← 已经跑出 27 格
10:42:17.062 [BUILD_PLACE_REPOSITION_REJECT] reason=stand_move_timeout_blacklisted
10:42:17.064 [BUILD_PLACE_REPOSITION] stand=584,62,-90 reason=..._retry
10:42:24.107 [action-lock] acquire type=movement owner=1  ← index=51 再来一次
10:42:37.108 [状态] x=657.53 y=62.00 z=-86.82           ← 跑出 74 格
10:42:39.848 [Task:build_blueprint#1] fail: move_timeout
10:42:39.859 [task-manager] fail task=build_blueprint id=1 reason=move_timeout
```

### 机制

站位候选的主排序键是**机器人当前位置到候选点的欧氏直线距离**，次键是 `preferOutsideReservedBounds`，
末键是 reach 距离。整条链路里没有任何一步问过「这个站位走得到吗、路径多长」。
落差 3 格 + `canDig:false` 时，寻路必须绕整座山坡下行；15 秒的固定超时里机器人只来得及朝错误方向
走一半，超时 → 拉黑 → 换下一个同样在坡下的候选 → 再超时 → 整个任务 FAILED。

| 环节 | 位置 |
| --- | --- |
| 候选排序（欧氏距离） | `actions/build.js:5957` |
| 候选排序（末键 reach） | `actions/build.js:5964` |
| 候选生成 | `actions/build.js:249` |
| 超时计算 | `actions/build.js:7113-7127` |
| 失败传导 | `systems/building-system.js:1791-1800` → `tasks/build-task.js:82-85` |

### 第二重障碍：就算不超时，这个用例也走不完 —— 已证实

系统**自己**在启动时就算出来了，并且发了警告：

```text
10:41:02.163 [BUILD_CONSTRUCTION_ESTIMATE] tier=L3 blocks=4431 steps=4813
             minutes=241-771
             warnings=["expected_build_time_long","block_budget_exceeded",
                       "rare_material_budget_exceeded"]
```

而验收给这个用例的终止预算是 **90 分钟**（`acceptance/cases/building.acceptance.js:38` 的
`FAITHFUL_IMPORT_MAX_TIMEOUT_MS`，报告里 `terminalTimeoutMs: 5400000` 已确认生效）。
实测吞吐 **24 步/分钟**（10:22:08 的 index=161 到 10:40:03 的 index=592，432 步 / 18 分钟）。
4813 步按此推算约 200 分钟。

这不是「把标准降下来」的问题，是这个用例的**终止预算与它自己选中的蓝图规模不匹配**。
**B-01~B-04 全修好，case2 也不会 PASS。** 见 B-05 的决策项。

---

## B. 链路断点（全部已证实，带 file:line）

目标形态：`目标 → 规划 → 备料(采集/合成/熔炼/开箱取料) → 建造 → 自验收 → 归档`，断线后能续建。

| # | 断点 | 位置 |
| --- | --- | --- |
| 1 | **目标 → 规划：建造方向完全没有接线**。`GOAL_TYPES` 只有 LOW_HEALTH / LOW_FOOD / DANGER_NEARBY / INVENTORY_FULL / NIGHT_WARNING / RETURN_TO_BASE_SUGGESTION 六个生存反射目标，且只在 `:153` 和 `:184` 调用 `planningSystem.createAndSubmitPlan('return_safe' \| 'get_food')`。GoalSystem 是生存反射层，不是通用目标规划器。建造只能从玩家指令进入。 | `ai/goal-system.js:7-14`、`:153`、`:184` |
| 2 | **规划不把建造目标分解成备料**。`if (goalType.startsWith('build_')) return [step('BUILD_BLUEPRINT', ...)]` —— 一个备料步骤都没有。对比 `:195-208` 的 `make_iron_pickaxe` 会展开成 MINE → SMELT → CRAFT。 | `ai/planning-system.js:236-239` |
| 3 | **备料没有「采集」**。`ensureItem()` 只有三条路：查背包 → `craftingSystem.planRecipe` → 可选 `_tryFetchFromStorage`。原料不够时返回 `plan_failed` + `missingMaterials`，不会派出去挖/砍。 | `systems/AutoPreparationSystem.js:290-403` |
| 4 | **备料没有「熔炼」**。对 `systems/CraftingSystem.js` 全文 grep `smelt\|Smelt\|mining\|gather`：**零命中**。`systems/SmeltingSystem.js`（795 行）和 `tasks/smelt-task.js` 都存在，但建造路径上没有任何地方 enqueue 它们 —— 唯一调用方是 `ai/plan-executor.js:92-97`，而断点 2 决定了建造计划里根本不会出现 `SMELT_ITEM` 步骤。 | `systems/CraftingSystem.js`、`ai/plan-executor.js:92-97` |
| 5 | **建造中单步失败 = 整任务死**。任何 `executeStep` 失败都设 `session.status='FAILED'` 并返回，转成 `TaskManager.fail`。只有可选脚手架有跳过逻辑（`:4191-4231`，需 `retryCount>=2` 且 `lastError==='move_timeout'`）。正式的 clear / place 步骤没有本轮重试或延后。 | `systems/building-system.js:1791-1800`、`tasks/build-task.js:82-85` |
| 6 | **失败后不会自己续建**。步骤失败直接 `failPlan`，无重试；TaskManager 对 FAILED 的 `build_blueprint` 无任何重排队逻辑。必须玩家再说一次「continue building X」。 | `ai/plan-executor.js:70-71`、`tasks/task-manager.js` |

### 没断的部分

- **自验收 + 归档已实现** —— WorldDiff、habitability final gate、`createConstructionArchive`：
  `systems/building-system.js:2841-2903`、`:3568-3571`。
- **对账式续建本身是好的，且已真机验证** —— 08-01 验收中途 bot 进程被重启，10:41:00 收到
  「continue building modern villa」后：
  `[BUILDING_RUN_DECISION] resumeOrFresh=resume reason=ACTIVE_RUN_COMPATIBLE`、
  `[BUILD_CONSTRUCTION_RUN] mode=resume runId=construction_run_9a1dfbf07e7ab98b verified=322 pending=4246 repair=0 stateRepair=432`。
- **中文自然语言入口是通的**（合理推断，代码路径已读，未做真机复现）——
  「给我盖个两层木屋」→ `ai/intent-parser.js:1024-1027` 的 `hasExplicitBuildVerb` 命中「盖」
  → `:1010` 的 `resolveBuildBlueprintName` 命中「两层」→ `two_story_wood_house`。

### 一个重要区别

历史上 GEN2 与 L3 达成的「完全材料自治（采集→合成→熔炼→剪羊毛全链）」是靠
`.tmp/gen2-procure-materials.js` 这类**外部驱动脚本**做的，不是 agent 自己走通的。
这个区别对「说一句话就自己盖完」的目标很关键。

---

## C. 优先级表

排序原则：阻塞真机验收 > 阻塞链路打通 > 体验优化。

### P0 —— 不修这些，building 真机验收拿不到诚实的 PASS

#### B-01　站位选择不含路径代价　`movement`　已证实

站位候选的主排序键是机器人当前位置到候选点的欧氏距离，次键是 `preferOutsideReservedBounds`，
末键是 reach 距离。整条链路里没有任何一步问过「这个站位走得到吗、路径多长」。
地形一有落差或围合，就会选中直线最近但实际要绕远路的站位。这是 case2 唯一 FAIL 的直接成因，
也是交接文档里「封闭房屋内部清理会选屋外站位」那条长期缺陷的同一个根。

```text
actions/build.js:5957  const distanceDelta = distance(bot.entity.position, a) - distance(bot.entity.position, b)
actions/build.js:5964  return placementReachDistance(a, target) - placementReachDistance(b, target)
actions/build.js:249   findSafePlacementStandPositions(context, target, digDistance, {...})
日志                   [BUILD_STANCE_CANDIDATES] target=583,65,-91 total=9 attempts=583,62,-90|...
```

- 影响面：所有非平坦地形 / 围合结构的 clear 与 place
- 预估改动：中（新增路径可行性预筛或代价项）
- 依赖：无
- 理由：唯一 FAIL 的直接根因

#### B-02　移动超时与真实路径长度无关　`movement`　已证实

建造路径上的移动超时基线是写死的 15000ms；`adaptiveMoveTimeout` 打开时也只按**垂直**落差补时间
（2500ms/格），完全不看水平路径。仓库里已经有一个按距离缩放的实现 `utils/movement-timeout.js`，
但它算的也是直线距离，且建造放置路径没有调用它。

```text
actions/build.js:7113-7127  placementMoveTimeoutMs() — base 15000，只加 |Δy| × 2500
utils/movement-timeout.js:1-9  distanceScaledMoveTimeout() — 直线距离，建造放置路径未调用
日志                        10:42:01.293 → 10:42:17.062 = 15.7s（直线 3 格的站位）
```

- 影响面：与 B-01 成对出现，放大失败率
- 预估改动：小
- 依赖：与 B-01 同批修更划算
- 理由：B-01 的放大器

#### B-03　单步失败即整任务失败，无跳过或延后　`executor`　已证实

5000 步里任何一步失败，整个任务立刻 FAILED。步骤本身会被标成 `RETRYABLE_FAILED` 存进 run store
（所以下次 resume 能重试），但**本轮任务已经死了**。这对一个动辄几小时的建造来说是致命的，
也是「连续游玩」体验最大的破坏源。

```text
systems/building-system.js:1791-1800  this.session.status = 'FAILED'; return { ok:false, ... }
tasks/build-task.js:82-85             } else if (!result.ok) { await this.fail(ctx, ...) }
systems/building-system.js:4191-4231  唯一的跳过逻辑，只对 kind==='scaffold_place'
```

- 影响面：所有大型建造；连续游玩体验
- 预估改动：中（需要「本轮延后 + 阶段末重试」语义，不能简单跳过依赖步骤）
- 依赖：需先确认哪些 kind 可延后（clear 可，place 受相位依赖约束）
- 理由：B-01/B-02 修好后，下一个失败点仍会以同样方式杀死任务

#### B-04　grass_block 材料死路　`material`　已证实

这份社区蓝图把**山体本身**算进了结构：1529 个 dirt、83 个 grass_block、61 个 sand。
运行时对账后需要 166 个 grass_block，验收 fixture 只给了 83。而 grass_block 在生存模式下必须精准采集，
机器人没有获取路径。材料策略只把其中 16 个替换成了 dirt，剩下 67 个仍在需求里。

```text
TASK_TICK  missingMaterials: [{"item":"grass_block","required":166,"available":83,"missing":83}]
日志        [MATERIAL_RESOLUTION] grass_block → dirt reason=terrain_alternative_available count=16
日志        [BUILD_MATERIAL_PLAN] required={... "grass_block":67 ...}
```

- 影响面：所有含地形层的社区导入蓝图
- 预估改动：小到中（扩展 terrain_material_policy 的替代覆盖面）
- 依赖：需确认「地表方块可替代」是否会破坏 WorldDiff 严格性
- 理由：B-01~03 修好后，这是下一个必然撞上的终止条件

#### B-05　验收终止预算 90 分钟 vs 系统自估 241–771 分钟　`validation`　已证实

**需要用户决策，未擅自改动。** 因为改它容易被误读成「降低验收标准」，
而实际要改的是*终止预算*这个 harness 参数，不是 world-fidelity / habitability 这些真正的判定标准。

```text
acceptance/cases/building.acceptance.js:38        FAITHFUL_IMPORT_MAX_TIMEOUT_MS = 90 * 60 * 1000
acceptance/cases/building.acceptance.js:337-352   resolveScenarioTimeoutMs() → min(90min, 4431 × 3500ms)
workflow/config/acceptance.config.json            building: { timeoutMs: 90000 }，无 faithfulImportMaxTimeoutMs 覆盖
acceptance/reports/latest-report.json             terminalTimeoutMs: 5400000
日志                                              [BUILD_CONSTRUCTION_ESTIMATE] minutes=241-771
```

- 影响面：case2 能否在单次验收窗口内诚实终止
- 预估改动：取决于选哪条路
- 依赖：需要用户决策
- 理由：不解决这条，B-01~04 全修好 case2 仍然不会 PASS

**三条候选路线（都不降低 world-fidelity / habitability 判定标准）：**

1. **拆成分段验收** —— case2 改成「一次 resume 窗口内推进 N 步且零 terminal_failed」，
   完成态由独立的收尾用例判定。改动最小，但需要新增断言语义。
2. **给 case2 换一个更小的社区结构** —— 保留「faithful community import」这个能力点，
   把规模降到 90 分钟能跑完的量级（约 1000–1500 块）。不改任何判定逻辑。
3. **放大终止预算** —— 在 `workflow/config/acceptance.config.json` 里给 building 加
   `faithfulImportMaxTimeoutMs`。最简单，但一次验收要跑 4 小时，实操上很难持续。

**建议：先做 2**，让 case2 恢复成一个能日常跑的回归闸门；把「4431 块的山顶别墅」单独立成一个长跑用例，走路线 1 的分段断言。

---

### P1 —— 不修这些，「说一句话就自己盖完」这条链永远接不起来

#### B-06　备料链缺「采集」　`material`　已证实

缺料时不会派任务去挖矿/砍树。历史上 GEN2 与 L3 达成的「完全材料自治」是靠
`.tmp/gen2-procure-materials.js` 这类外部驱动脚本做的，不是 agent 自己走通的。

```text
systems/AutoPreparationSystem.js:290-403  ensureItem() = 查背包 → planRecipe → 可选开箱，无采集分支
systems/CraftingSystem.js                 grep mining|gather → 零命中
```

- 影响面：整条自治链
- 预估改动：中
- 依赖：mining-task 已存在，需接线 + 防循环
- 理由：链路核心缺口

#### B-07　备料链缺「熔炼」　`material`　已证实

SmeltingSystem 和 smelt_item 任务都写好了，就是没接到建造的备料路径上。
历史上 `iron_bars:1` 卡死连续多轮（交接文档 2026-06-29 段）就是这个缺口的直接后果。

```text
systems/SmeltingSystem.js（795 行）、tasks/smelt-task.js 均存在
唯一 enqueue 点：ai/plan-executor.js:92-97，而建造计划里不会出现 SMELT_ITEM（见 B-08）
```

- 影响面：玻璃 / 铁制品 / 熟食链
- 预估改动：小（复用 B-06 的接线）
- 依赖：B-06
- 理由：与 B-06 同一处改动，一起做成本更低

#### B-08　规划层不分解建造目标　`integration`　已证实

`build_*` 目标只产出一个 `BUILD_BLUEPRINT` 步骤。备料全部塞在 BuildingSystem 的运行时物料闸门里，
规划层看不见，也就无法在开工前把「缺什么」变成可执行步骤。

```text
ai/planning-system.js:236-239  if (goalType.startsWith('build_')) return [step('BUILD_BLUEPRINT', ...)]
对比 :195-208                  make_iron_pickaxe → MINE_BLOCKS → SMELT_ITEM → CRAFT_ITEM
```

- 影响面：链路的「规划→备料」段
- 预估改动：中
- 依赖：需要一个「预编译蓝图拿物料清单」的只读入口
- 理由：链路结构性缺口

#### B-09　建造失败后不会自己续建　`integration`　已证实

ConstructionRun 层的 resume 是好的（08-01 真机验证过），但触发它需要玩家再说一次话。
计划层同样是一失败就终止。

```text
ai/plan-executor.js:70-71  step.status = FAILED; this.failPlan(...)
tasks/task-manager.js      对 FAILED 的 build_blueprint 无重排队逻辑
```

- 影响面：「中途掉线能接着盖」这条硬需求
- 预估改动：中
- 依赖：B-03（否则会在同一步上无限重试）
- 理由：用户明确要的形态之一

#### B-10　复杂度预算在社区导入路径上失效　`blueprint`　已证实

预算闸门只在 `designSpec` 已存在时生效。玩家说「build modern villa」时没有 tier，`designSpec` 为 null，
闸门被跳过；等蓝图选完之后才推导出 `maxBlockBudget: 500` / `maxFootprint 9×9`，此时只会发 warning。
结果是选中了一个超预算 8.9 倍、占地 35×34 的结构。

```text
systems/blueprint-selector.js:37-39  const budget = resolved.ok && designSpec ? blueprintSatisfiesDesignSpec(...) : { ok:true }
日志 candidateSummary.attempted[0]   budgetFailures: [], complexityMetrics: null
日志 [BUILD_DESIGN_SPEC]             maxBlockBudget=500 maxFootprint=9×9 ／ 实际 4431 块 35×34
```

- 影响面：所有无显式 tier 的建造请求
- 预估改动：中
- 依赖：与 B-05 决策相关（选小结构那条路会顺带缓解）
- 理由：规模失控的上游成因

#### B-11　内部清理仍优先选屋外站位　`placement`　已证实

交接文档 2026-07-04 记录的长期缺陷，代码里仍在。`preferOutsideReservedBounds` 只在
`step.phase==='interior'` 或 `y <= origin.y+1` 时关闭，其余情况一律把屋内站位排到最后。
封闭结构里就会选到走不到的屋外站位。与 B-01 同根，但需要单独的判定条件。

```text
systems/building-system.js:6313-6317  shouldPreferOutsideReservedBounds()
actions/build.js:5959-5963            aInside !== bInside → aInside ? 1 : -1
```

- 影响面：封闭房屋的内部清理 / 修补
- 预估改动：小（B-01 落地后可能自动缓解）
- 依赖：B-01
- 理由：已知长期缺陷，未复发但未消除

#### B-12　case1 当前状态未知　`validation`　UNKNOWN

08-01 那次验收 `results` 数组只有一条，只跑了 case2。case1（`rebuild two story wood house`）
自 2026-06-27 记录 `place_failed:unstable_air` 之后，**没有任何一次留下报告的运行**。
`acceptance/reports/` 下有 12 个未跟踪的 `building-case1-*-probe-*` 文件，属于探针而非验收。

```text
acceptance/reports/latest-report.json  results.length = 1，featureName=building，testName=case2 ...
未跟踪文件                             building-case1-{,lantern-,order-,temp-reference-}probe-*.{json,md}
```

- 影响面：建造回归覆盖率
- 预估改动：零代码（先跑一次拿基线）
- 依赖：ONLINE-GATE
- 理由：在动 P0 之前应该先有 case1 基线，否则改动的回归影响无法判断

---

### P2 —— 信号质量与卫生，不阻塞任何东西

#### B-13　三个闸门报 ok=false 但 violations 是空的　`validation`　已证实

faithful 导入路径会跳过设计器，但风格/立面/布局闸门仍然按「未通过」输出，且不给任何违规项。
读日志时会误以为有真实失败。

```text
[BUILD_PIPELINE_STAGE] stage=validate_style_grammar status=failed violations=[]
[BUILD_STYLE_GRAMMAR]  ok=false violations=[]
[BUILD_FACADE_PASS]    ok=false windows=0 layers=0
[BUILD_LAYOUT_PLAN]    ok=false rooms=0 entrances=0
```

- 影响面：诊断信号质量　/　预估改动：小　/　依赖：无
- 理由：纯噪音，但会持续误导后续排查

#### B-14　npm test 漏了两个测试文件　`validation`　已证实

`tests/protected-buildings.test.js` 和 `tests/wall-button-transform.test.js` 有独立的 npm script，
但不在 `npm test` 的 38 个文件里。已完工建筑保护是硬安全约束，不应该漏出主回归。

```text
package.json  "test": 38 个文件，不含 protected-buildings / wall-button-transform
              "test:protected-buildings" 与 "test:building" 才会跑到
```

- 影响面：回归覆盖　/　预估改动：一行　/　依赖：需确认这两个用例在主回归环境下稳定
- 理由：低成本补漏

#### B-15　run store 残留 16 个 .tmp-* 文件　`support`　已证实

原子写的临时文件没被清掉，堆在 `data/memory/` 下。目前无害（`construction-runs.json` 本体正常），
但会掩盖真正的写入异常。

```text
git status  16 × data/memory/construction-runs.json.tmp-<pid>-<ts>
```

- 影响面：仓库卫生　/　预估改动：小　/　依赖：无
- 理由：需要先确认是崩溃残留还是清理逻辑缺失

#### B-16　交接文档与 decision-needed.md 过期　`support`　已证实

见第 0 节。这次差点把「门感知寻路」排进 P0。
建议修复方式：`decision-needed.md` 改成每次启动重建（而不是只追加），
交接文档补 07-27→08-01 那 27 次提交的摘要。

```text
docs/CODEX_BUILDING_HANDOFF.md:18  "door-aware pathfinding still missing" ← 与 cc9a39db 冲突
docs/decision-needed.md            三条均为 2026-05-30，对应代码分支已不存在
```

- 影响面：后续会话的判断准确率　/　预估改动：小　/　依赖：无
- 理由：体验/流程优化，但复利很高

---

## D. 如果批准，建议的第一轮

按 AGENTS.md「一轮只打一个根因、最小补丁、必须配单测」。

**第一轮只打 B-01（站位选择的路径可行性）**

- 做法：在 `moveToFirstReachablePlacementStand` 之前，对候选站位做一次**只读的路径预算预筛** ——
  用 pathfinder 已有的能力估算路径代价，把「直线近但路径代价爆炸」的候选降权，而不是删掉。
  不动 TaskManager，不动 ActionLock，不改验收标准。
- 单测：构造一个「直线最近的站位在墙/坡的另一侧」的 mock 世界，断言选出的是路径可达的次近站位，
  且不产生 move_timeout。
- 真机：先跑 case1 拿基线（B-12），再跑 case2 看清障阶段能否越过 index=45/51 这两个已知失败点。
  跑之前先过 ONLINE-GATE（见 `docs/CODEX_BOT_STARTUP.md`）。

### 开工前需要确认的三件事

1. **B-05 选哪条路？**（建议：换小结构 + 单独立长跑用例）
2. **第一轮是否就打 B-01？** 还是先补 case1 基线（B-12）？
3. **B-06/B-07 的备料接线是否属于 AGENTS.md 第 10 节禁止的「大改造」范围？**
   本轮判断不属于（不是重写 crafting/storage 架构，是把已有的 mining/smelt 任务接进
   `ensureItem` 的失败分支），但这条边界应由用户划定。

---

## E. AGENTS.md 第 11 节报告

### 1. 读过的文件

`AGENTS.md`、`docs/CODEX_BUILDING_HANDOFF.md`、`docs/CODEX_BOT_STARTUP.md`、`docs/decision-needed.md`、
`acceptance/reports/latest-summary.md`、`acceptance/reports/latest-report.json`、
`logs/bot-2026-08-01-03-19-11.log`、`logs/bot-2026-08-01-03-40-31.log`、`logs/bot-current.log`（头尾）、
`actions/build.js`、`actions/move.js`、`systems/building-system.js`、`tasks/build-task.js`、
`systems/AutoPreparationSystem.js`、`systems/CraftingSystem.js`、`systems/blueprint-selector.js`、
`ai/planning-system.js`、`ai/plan-executor.js`、`ai/goal-system.js`、`ai/intent-parser.js`、
`acceptance/cases/building.acceptance.js`、`utils/movement-timeout.js`、
`workflow/config/acceptance.config.json`、`package.json`、`tasks/task-manager.js`、`systems/survival-system.js`

### 2. 改动的文件

**业务代码：0 个。**

本轮唯一写入：
- `docs/CLAUDE_ROUND1_REPORT.md`（本文件）
- `~/.claude/projects/D--code-MC/memory/handoff-docs-are-stale.md` 及 `MEMORY.md` 索引行（仓库外）

### 3. 执行的命令

`git status --short`、`git log --oneline -20`、`git log --pretty=format:"%h %ad %s" --date=short -60`、
`git branch --show-current`、`git rev-parse HEAD`、`git diff --stat`、`npm test`，以及若干 grep / read。

未执行：任何 `git add`、`git commit`、`git stash`、`git reset`、`git clean`、真机验收、bot 启动。

### 4. 测试结果

`npm test` —— **38 / 38 全部通过，退出码 0**。

### 5. 当前最新判定

- building = **FAIL**　`build_task_failed:move_timeout`，194 / 4431 块，2026-08-01T10:43:00Z
- building case1 = **UNKNOWN**（08-01 未运行）
- following / farming / storage 等其余 feature：本轮未核查，沿用 AGENTS.md 第 3 节基线

### 6. 生成文件 / 内存是否变脏

无新增脏文件。工作区在本轮开始前就是脏的（37 个改动文件 + 大量未跟踪文件）。
`npm test` 不写业务文件与验收报告。

### 7. 是否建议提交

**否。** 除非用户明确要求提交本报告文档。

### 8. 剩余风险

- `docs/RENOVATION_FLOW_DESIGN.md` 与 `acceptance/reports/latest-report.md`（2MB）只读了摘要与相关片段，
  未逐行读完。
- 「目标旁边是 3 格落差的山坡」是从「9 个站位候选全部落在 y=62」反推出来的**合理推断**，
  未做真机地形探针确认。若要在动手前坐实，需要一次只读探针。
- B-01 的修复方案（路径代价预筛）本身尚未验证 pathfinder 是否提供足够便宜的路径代价估算接口，
  这一点在开工第一步需要先确认。

### 调试类附加项（AGENTS.md 第 11 节下半）

- **根因**：站位选择只按几何直线距离排序，不含路径可行性/代价；叠加固定 15s 移动超时。
- **证据**：`actions/build.js:5957`、`:7113-7127`；日志 `[BUILD_STANCE_CANDIDATES] ... attempts=583,62,-90|...`
  与 10:42:07 / 10:42:37 的位置漂移。
- **问题归类**：**business logic（movement / placement 站位选择）**。
  不是验收脚本问题，不是 fixture/环境问题，不是日志问题，不是锁冲突，不是过期报告污染。
  唯一叠加的非业务因素是 B-05 的验收终止预算配置。
