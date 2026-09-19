# 后勤 第 22 轮任务 — 同图纸活动档案只认 32 格内（决策 #114）+ 意图词表两条 + 看板归档

- 线: 后勤（永不进游戏，离线活）
- 轮次: 22
- 下发日期: 2026-09-17
- **建议模型 / 思考强度 / 是否 ultracode**：`Opus 5` + `high`（根因已由建造 27 钉到行号，最小补丁 + 单测；意图词表两条是词表活——「常规」档）。**不开 ultracode**。开场把实际模型/强度/ultracode 写进反馈头部
- 上一轮: 第 21 轮审毕通过（#98 路由补丁 + 探针 + 说法→路径表；老板拍 #104 选 B、#105 探针进协议）。你的四笔已随建造 27 进主干（`d11d4c20`，`main` 已快进），**本轮先 `git merge main`（快进）再开工**，之后在新基线上提交

> 开工前：把上一轮的 `CC反馈.md` 整份归档到
> `docs\协作\历史\后勤第21轮-本地图纸走预算路与开工级探针.md`，再重写反馈文件。

---

## 0. 现场（建造 27 真机实撞，已证实到行号）

- **同图纸活动档案不看距离**：`systems/building-system.js:1225` `findActiveCompatible(criteria)`——A 栋档案 ACTIVE 时在 500 格外的 B 说 `盖个带塔楼的房子` → 去续 A → `build_origin_too_far` ×15。中文无 forceRebuild 触发词（`ai/intent-parser.js:944` 只认 `rebuild|reconstruct`）；建造线靠英文 `rebuild the tower cottage` 绕（`[BUILD_CONSTRUCTION_RUN_ABANDON] reason=explicit_rebuild_requested`）。老板拍 **#114 = 选 A：续建只认她 32 格以内的档案**（续建本来就要求 32 格内，把条件提前到挑档案时）；不加中文触发词（B）、不维持（C）
- 意图词表两条（修缮 16/17 交接）：清单 15「照看农田」被判成 `BUILD`；清单 20「铁矿」只映射 `raw_iron`（`ai/intent-parser.js:1183`），手里的 `iron_ore` 方块烧炼表里有却不被当输入
- 世界里现有三栋塔楼半成品档案：A、B ABANDONED，C ACTIVE（建造 28 会先续 C）。**你不碰 `data/memory/`**，只在单测里造档案

## 第 1 步：活动档案按距离（#114，一轮一根因）

- `findActiveCompatible`（或它的调用处 `:1220–1380` 那段，读码定位写行号）：候选档案的 origin 与她当前位置的水平距离 **> 32 格**的不匹配（32 = 现有续建口径 `build_origin_too_far` 用的那个常量，**复用它，别新造一个数**；若那个常量不是 32，以它为准并写清）
- 匹配不到时行为**照旧**（走新建）；`forceRebuild` 路径**照旧**；`resumeBuild` / 「继续盖」显式续建路径——**写清它走不走 `findActiveCompatible`**，若走，同样按距离；若有第二处匹配逻辑，写清不改
- 单测：①32 格内有 ACTIVE 档案 → 续它 ②同图纸 ACTIVE 档案在 500 格外 → 不续、新建（`mode=new`）③两份 ACTIVE 一近一远 → 续近的 ④反证：去掉距离判断 → ②变成续远的（红）⑤回归：`tests/construction-resume-plan-id.test.js`、`construction-run-archive` 那几组全绿
- 交接给建造线一个最小真机场景（建造 28/29 验）：在 C 附近 32 格内中文续建 → 续 C；在 500 格外中文开工 → 新档案、不报 `build_origin_too_far`

## 第 2 步：意图词表两条（顺手，词表活）

- 「照看农田」/「看看农田」/「去种地」这类 → `FARM`（现有 farming 意图），不再落 `BUILD`；写清现在为什么落 BUILD（哪个词命中了建造词表）
- 「铁矿」→ 同时认 `raw_iron` 与 `iron_ore`（烧炼输入按现有烧炼表能接受的为准；`iron_ore` 方块在烧炼表里有，写清烧炼系统取输入时的字段）；**只改词表/映射，不改烧炼逻辑**
- 单测：每条一正向一反证；回归 `tests/intent-*.test.js` 全绿；**跑一次开工级探针 `node scripts/offline-build-start-probe.js`（#105）**，30 行与第 21 轮表逐行不变（词表改动不该影响建造路由）

## 第 3 步：取证不改（写进反馈给开发）

- 缺料找箱子只查 24 格：`[CHEST_NOT_FOUND] radius=24` 那个半径从哪来（常量/配置）、荒地开工时后勤 20 的临时箱子机制与它的关系（临时箱子放下后是否在 24 格内被找到）——**只读码写清，不改**
- 建造 27 未映射键清单里属于建造侧的（`staged_material_missing:<item>:chest_not_found`、`no_reachable_build_stance_after_*`、`BLOCKED_MATERIAL_SHORTAGE:*`、`placement_material_refill_retry_limit:*`、`phase_dependency_incomplete:*`）——各给一句人话**建议**（不改 `ai/message-generator.js`，那是修缮 19 正在动的文件；由开发转修缮线）

## 第 4 步：回归 + 看板 + 归档 + 提交

- `npm test` 全绿（新基线 90 组，写清增减）；21 份 planId 金值不变（`.tmp/ops-round15-hopper-census.js` 复跑——**建造 27 报本 worktree 之外找不到这脚本和 21 份清单，请把清单（图纸 → planId）写进本轮反馈并提交到 `docs/协作/后勤/附件/planid-census.md`**，以后各线都能核）
- 看板：`m01` 加「建造 27 三连盖 0/3（床朝向 / 楼梯井）→ 建造 28」一行；`dashboard-lanes` PASS；主仓与 MC-ops 两份一致，主仓只改文件不提交
- 归档第 21 轮；提交显式指定文件

## 交接（写进反馈）

- **给建造线**：①距离判据用的常量与行号 ②最小真机场景 ③词表改动对建造路由零影响（探针表）
- **给协调线**：无（本轮不碰其地盘）
- **给开发**：第 3 步两条取证；UNKNOWN 清单；planId 清单文件位置

## 红线

- 一轮一根因：只改档案匹配的距离条件 + 两条词表；**不改 `previewBlueprint` / `shouldPreserveBudgetedBlueprint`（第 21 轮刚改）、不改烧炼/农田逻辑、不改 `ai/message-generator.js`（修缮 19 在动）、不改 `actions/build.js`**
- 不改任何图纸；主仓 `docs\协作\后勤\附件\` 只准**新增** `planid-census.md`，原稿不动；不碰主仓 `data/memory/`
- 不碰协调线地盘（`systems/task-arbitration/`、`core/action-lock.js`、`tasks/base-task.js`、`tasks/task-manager.js`）
- 永不进游戏；禁止全量 `syncCommunityBlueprints`；不进 `D:\code\MC` / `MC-fix`
- 提交显式指定文件；禁止 `git add -A` / `reset --hard` / `clean -fd` / `stash` / `checkout --`

## 分步验收

| 步 | 完成判据 | 做不完怎么办 |
|---|---|---|
| 1 | 距离判据 + 5 条单测 + 回归全绿 + 真机场景写清 | 发现第二处匹配逻辑 → 写清、只改主路、状态「等老板拍板」 |
| 2 | 两条词表 + 单测 + 探针 30 行不变 | 某词表冲突（一词两意）→ 写清、不硬改 |
| 3 | 两条取证写清 | — |
| 4 | 全绿 + planId 清单入库 + 看板 + 归档 + 提交 | 看板可留下轮 |
