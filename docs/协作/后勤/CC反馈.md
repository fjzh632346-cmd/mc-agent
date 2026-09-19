# 后勤 第 21 轮反馈

- 线: 后勤
- 轮次: 21
- 日期: 2026-09-13
- 状态: 已完成（第 1、2、3 步全做；**有一条拍板问题**：判据比任务书字面窄了一格，理由是字面版会打破一条现成验收，详见拍板问题 1）
- 实际运行模型 / 思考强度 / 是否 ultracode: **Opus 5 / UNKNOWN / 未开 ultracode**（任务书建议 `Opus 5` + `high`，模型对上；强度我读不到自己的实际取值，标 UNKNOWN；ultracode 按任务书「不开」）
- 分支 / HEAD: feat/ops / `a6242a5b`（本轮 2 笔：`7e6ca24d` 路由补丁 + 单测 + 开工级探针，`a6242a5b` 看板。main 已前进到 `51aa0529`，但它相对 `c4c1919e` 只动了 `docs/协作/` 下 10 个文档、与 feat/ops 零文件重叠；因为不是快进、合进来只会多一个合并提交，本轮**没有** `git merge main`）

---

## 一句话结论

上一轮真机「建个塔楼小筑」一块砖都盖不起来的卡点修好了：离线用同一句话从头走到出施工单，715 块一块不少；同时补上了一段「从一句话走到开工」的离线验收，十五句说法、两种样本库逐一对过，**只有塔楼小筑那两行变了，其余二十八行一个字没变**。

## 白话摘要

建造 26 在真机上说「建个塔楼小筑」，二十毫秒就失败了。原因是系统看它是 L4 的大房子，就非要先去找同风格的社区样板做美学参考，缓存里没有，于是直接放弃。您拍板（#98）说您亲手定稿的本地图纸不需要样板、直接照图盖——这一轮就只改了这一处判断。

改完用同一句话离线从头走一遍：认出图纸、定档 L4、跳过找样板、编出施工单，715 块一块不少。另外补了一段以前没有的离线验收：以前离线只验到「选对图纸、编得出施工单」，恰好漏掉了中间这一段路由，所以才会「离线全过、真机开不了工」。现在十五种图纸的默认说法，在「空样本库」和「真机那 4 份样本」两种情况下各跑一遍，逐行记下走的是哪条路、成没成。改前改后对比：只有塔楼小筑两行从失败变成功，其余二十八行完全相同。

有一处我没照任务书的字面做，需要您定：字面是「本地图纸一律直接盖」，但「建个小房子」那份老模板也是本地图纸，它现在走的是「设计师改造 + 样板美化」那条路，而且有一条现成的验收专门要求它必须被改造过——照字面做那条验收就挂了。我按「不降验收标准」把范围收窄成「**自己标明了档位的定稿图纸**才直接盖」（眼下只有塔楼小筑），小房子一切照旧。您若就是要连小房子一起直接盖，一句话的事，但那条验收也得跟着改。

所有测试全绿，其余图纸的施工单编号一个没变。**真机没验**，建造 27 照下面的判据盖一次就知道。

## 需要老板拍板的问题

### 问题 1：「本地图纸一律直接照图盖」要不要连「小房子」那份老模板也算进去？
- 背景：您的 #98 说本地手工图纸不管档位都直接盖。本地图纸目录里有五份：塔楼小筑（您定稿的）、箱子区、农田、围墙（这三份本来就直接盖）、还有一份 26 块的「小房子」老模板。小房子现在在真机上会被「设计师」改造成一栋 114 块的房子再盖，而且有一条现成验收专门钉着「小房子必须被改造过」。玩家只说「盖个房子」不点名时，默认盖的也是它。
- 选项 A（照字面）：五份本地图纸全部直接照图盖。代价：「建个小房子」/「盖个房子」从盖 114 块的改造版变成盖原样 26 块的小方盒；那条现成验收要改期望（等于为这次改动降一条验收）。
- 选项 B（我现在交的）：只有**图纸自己标明了档位**的定稿图纸直接盖（今天只有塔楼小筑；以后您定稿入库的新图纸带上档位就自动算进来）。代价：以后新图纸入库要记得在图纸里写档位——塔楼小筑入库时就写了，照做即可。
- 我的建议：**B**，因为 #98 的理由是「图纸是您亲手拍板的」，小房子不是；而且 B 不动任何现在在真机上能用的东西，也不用改验收。

## 技术细节

### 〇、开场（已证实）

- MC-ops 干净（除既有未跟踪缓存）；基线 `npm test` **exit 0 / 88 条通过行**（`.tmp/ops-round21-baseline.txt`）
- 第 20 轮反馈已归档到 `docs/协作/历史/后勤第20轮-临时箱子中转离线落地.md`
- **未进游戏**；未起服务器/bot/端口/RCON；未跑社区同步；未 `npm install|ci|update`；未联网；未碰主仓 `data/memory/`、主仓 `docs/协作/后勤/附件/`；未碰任何图纸；未碰 `community-build-collector.js`、`actions/build.js`、协调线地盘；主仓缓存只读（探针复制到临时目录后读取）

### 一、第 1 步：根因复现 + 补丁

**离线复现（已证实）**：`.tmp/ops-round21-repro.js`，`parseIntent('建个塔楼小筑')` → `blueprintName=tower_cottage`、`designSpec.complexityTier=L4` → `previewBlueprint` **16 ms 返回 `verified_real_community_samples_unavailable`**，与建造 26 真机一致。选择器给的标记：`sourceKind=local_library`、`localName=tower_cottage`、`localBlueprintPath=null`、`generatorKey=null`、`sourceMode=null`。

**`previewBudgetedSimpleBlueprint` 那一层有没有第二道拦截：没有（已证实）**。读了 `systems/building-system.js:875` 起的整段：只有 `getRequiredMaterials`、`missing_build_origin`、`build_origin_too_far`（`explicitOrigin` 时不查）、`compileConstructionPlan` 的失败返回，**没有任何 `minBlockBudget` / `maxBlockBudget` / `maxMaterialTypes` / `maxFootprint` 之类的判断**。按档位的预算检查在更早的选择器里（`blueprint-selector.js` 的 `blueprintSatisfiesDesignSpec`），塔楼小筑按 L4 本来就过（`attempted: local_library:local-json-tower_cottage:true`）。所以不存在「第二个根因」，也没有放宽任何通用预算。

**补丁（`7e6ca24d`，`systems/building-system.js` +19/−1）**：

| 位置 | 改动 |
|---|---|
| `:473` `previewBlueprint` | 调用处多传一个 `selected.blueprint` |
| `:3739` `shouldPreserveBudgetedBlueprint` | 第一行加 `if (isLocalHandmadeBlueprint(selected, blueprint)) return true`，原来三行**逐字未动** |
| `:3755` `isLocalHandmadeBlueprint`（新） | `blueprint.metadata.complexityTier` 有值 **且** `sourceKind === 'local_library'` **且** `localName` 有值 **且** 无 `localBlueprintPath` **且** 无 `generatorKey` **且** `sourceMode !== 'faithful-community-import'` |

**#98 落地的判据到底是什么字段（给开发）**：选择器现成打的 `selected.sourceKind === 'local_library'` + `selected.localName`（`blueprint-selector.js:121` 本地候选；`resolveCandidate` 走 `loader.loadBlueprint(localName)` 从 `blueprints/` 读）。排除项：`localBlueprintPath`（社区原样导入走路径加载）、`generatorKey`（本地加载失败会回落生成器）、`faithful-community-import`。**另加一条 `metadata.complexityTier`，这是任务书没写的，原因如下（已证实）**：

- 第一版照字面（不看 `metadata.complexityTier`）跑全量测试，**`tests/blueprint-building.test.js:1302` `testBuildTaskPlacesBlock` 挂了**：它钉着 `small_house` 必须走设计师改造（`designPlan.transformed === true`、`scaffoldBlocks === 0`），字面版让 `small_house` 进了预算路，`scaffoldBlocks` 变成 3
- 开工级探针也印证：字面版会让「建个小房子」在真机样本库口径下从「样本路成功、114 块放置」变成「预算路、45 块放置」——**一条今天在真机上能用的行为被改掉了**
- 按「不降验收标准」，我没有去改那条验收，而是把判据收窄到「图纸自己声明了档位」。本地五份里只有 `tower_cottage.json` 的 metadata 带 `complexityTier: "L4"`（后勤 18 入库时写的），其余四份只有 `displayName`/`zhNames`。收窄后第一版挂的那条验收恢复通过。选 A 还是 B 见拍板问题 1

**`建个塔楼小筑` → `buildBlueprint` 那一段的日志（已证实，`.tmp/ops-round21-buildlogs.js`，空样本库、空背包、`allowStorageRefill:false`，最后停在 `missing_materials` 属预期）**：

```
[BLUEPRINT_CANDIDATES] request=tower_cottage top=[{"id":"local-json-tower_cottage","blueprintName":"tower_cottage","sourceKind":"local_library","score":96.104,...
[BLUEPRINT_SELECTED] request=tower_cottage selected=tower_cottage source=local_library score=96.104 fallback=false
[BUILD_PIPELINE_STAGE] stage=select_blueprint status=ok selected=tower_cottage source=local_library
[BUILD_PIPELINE_STAGE] stage=parse_structure status=ok blocks=728
[BUILD_PIPELINE_STAGE] stage=design_transformation status=ok style=tudor_stone_tower transformed=false reason=low_complexity_request_preserves_simple_blueprint ...
[BUILD_PIPELINE_STAGE] stage=validate_style_grammar status=failed violations=[]
[BUILD_COMMUNITY_SAMPLES] blueprint=tower_cottage count=0 samples=[]
[BUILD_AESTHETIC_REFINE] blueprint=tower_cottage refined=false iterations=0 operations=[]
[BUILD_HABITABILITY_GATE] stage=pre blueprint=tower_cottage ok=true metrics={"detectedStories":3,...
[BUILD_DESIGN_SPEC] id=tower_cottage_58a669da3593 ... type=tower_cottage size=14x10x17 floors=3
[BUILD_CONSTRUCTION_ESTIMATE] tier=L4 blocks=715 steps=717 minutes=36-115 warnings=[]
```

- `validate_style_grammar status=failed violations=[]` **是老行为，不是本轮引入的**（已证实：同一脚本跑「建个简易木屋」也打这一行，小木屋第 25 轮真机连盖三次都成）
- `design_transformation ... reason=low_complexity_request_preserves_simple_blueprint` 这句理由串是预算路原有的固定文案，对 L4 读起来别扭，但我没改（改日志文案不在本轮范围）

**单测（新测试组 `tests/local-blueprint-budget-route.test.js`，9 条，已挂进 `npm test`）**：

| # | 内容 | 结果 |
|---|---|---|
| 1 | 正向：`建个塔楼小筑` → L4 → 样本库替身一律答「没有」→ **出施工单、715 块放置步、样本库一次都没被问** | 过 |
| 1' | 同一条走开工级探针（空样本库）→ `route=budget`、715 | 过 |
| 2 | 重建（`forceRebuild`，`designSpec=null`）同样走预算路 | 过 |
| 3 | 反证：同一份图纸标成社区原样导入 → 进社区原样路、预算路 0 次 | 过 |
| 3' | 反证：本地库候选但带 `localBlueprintPath` / 带 `generatorKey` / 无 `localName` / `sourceKind=community_index` → 照旧取样本 | 过（4 组） |
| 3'' | 反证：本地图纸但 metadata 没声明档位 → 照旧取样本 | 过 |
| 3''' | 回归：`建个小房子` 照旧取样本 | 过 |
| 4 | 回归：`建个简易木屋`（L2 生成器回落）照旧预算路、不问样本库 | 过 |
| 4' | 回归：`建个农舍`（生成式、固定尺度）照旧取样本 | 过 |

**测试自身的反证（已证实）**：把 `building-system.js` 换回改前备份跑这组测试，第 1 条当场挂出 `verified_real_community_samples_unavailable`——和真机报错同一个字符串；换回补丁后全过。别墅（社区原样导入）那条路由另有 `blueprint-building.test.js` 里现成的原样导入测试钉着，本轮全绿。

### 二、第 2 步：开工级离线探针 + 说法→路径表

**探针**：`scripts/offline-build-start-probe.js`（已提交，可复跑）。`node scripts/offline-build-start-probe.js [--json=out.json]`。一句说法 → `parseIntent` → `BuildingSystem.previewBlueprint`；假 bot、平地假世界、空背包、不落施工档案；只做「记下进了哪条路」的包装，不改行为。样本库两种口径：`empty`（空，本 worktree 的缓存就是 0 份）/ `main-cache`（主仓缓存索引复制到临时目录只读，**真机那只 bot 看到的就是这 4 份**：pirbaba 木屋、山顶别墅、城墙门楼、瞭望塔）。耗时：30 行全跑完约 2 秒。

**说法→路径表（改后，已证实；`.tmp/ops-round21-probe-after.json`）**。「路径」：预算路 = 按图直接盖；原样路 = 社区原样导入；样本路 = 取社区样板做美学参考。步数括号里是放置步。**真机以 main-cache 列为准。**

| 说法 | 意图图纸 | 档位 | main-cache（真机口径） | empty（空样本库） | 改前 → 改后 |
|---|---|---|---|---|---|
| 建个箱子区 | chest_area（本地） | L1 | 预算路 ✅ 8(6) `1985c2b47639` | 同左 | 不变 |
| 建个农田 | farm_plot（本地） | L1 | 预算路 ✅ 27(25) `bf94a5327990` | 同左 | 不变 |
| 建个围墙 | fence_area（本地） | L1 | 预算路 ✅ 18(16) `570d4a56f561` | 同左 | 不变 |
| 建个小房子 | small_house（本地老模板） | 固定尺度 | 样本路 ✅ 116(114) `8835a6fdcd74` | 样本路 ❌ samples_unavailable | 不变（见拍板问题 1） |
| **建个塔楼小筑** | **tower_cottage（本地定稿）** | **L4** | **预算路 ✅ 717(715) `0c7bde146102`** | **预算路 ✅ 同左** | **样本路 ❌ → 预算路 ✅** |
| 建个双层木屋 | two_story_wood_house | 固定尺度 | 原样路 ✅ 选中 pirbaba 1039(1016) `a38dbddefa31` | 样本路 ❌ samples_unavailable | 不变 |
| 建个简单双层小屋 | simple_two_story_cabin（生成） | L3 | 预算路 ✅ 467(465) `5be6d94adc81` | 同左 | 不变 |
| 建个简易木屋 | simple_wood_cabin（生成） | L2 | 预算路 ✅ 185(183) `9fe51d17389c` | 同左 | 不变 |
| 建个避难所 | starter_shelter（生成） | L1 | 预算路 ✅ 56(54) `4aad1be3f21a` | 同左 | 不变 |
| 建个农舍 | simple_farmhouse（生成） | 固定尺度 | 样本路 ❌ `aesthetic_score_below_threshold` | 样本路 ❌ samples_unavailable | 不变 |
| 建个现代别墅 | modern_villa | 固定尺度 | 原样路 ✅ 选中山顶别墅 4755(4592) `2acdfc2f9608` | 样本路 ❌ samples_unavailable | 不变 |
| 建个城堡花园 | castle_garden | 固定尺度 | 原样路 ✅ 选中城墙门楼 1901(1566) `b6e443049ef0` | 样本路 ❌ samples_unavailable | 不变 |
| 建个花园庄园 | garden_manor（生成） | 固定尺度 | 样本路 ❌ samples_unavailable | 同左 | 不变 |
| 建个雕像 | statue（生成） | L1 | 预算路 ✅ 18(16) `8664a9d7da06` | 同左 | 不变 |
| 建个喷泉 | fountain（生成） | L1 | 预算路 ✅ 33(31) `6d59fdc9777a` | 同左 | 不变 |

改前表：`.tmp/ops-round21-probe-before.json`（同一探针跑改前备份）。**30 行里只有塔楼小筑 2 行不同，其余 28 行成败、路径、planId、错误串逐字相同（已证实）**。

**21 份图纸（census 口径）怎么对上这张表**：
- 本地 5 份、生成 10 份：见上表各行（生成的 `two_story_wood_house` / `modern_villa` / `castle_garden` 在真机口径下**被社区原样导入顶替**，生成版本身默认说法够不着）
- 社区 `github-free-minecraft-schematics-house-pirbaba`、`mcbuild-modern-house-on-a-hilltop-18658`、`github-ifnullthenvoid-fort-wall-gate`：分别由「双层木屋 / 现代别墅 / 城堡花园」在真机口径下够到，均原样路 ✅
- 社区 `github-ifnullthenvoid-fort-watchtower`：**默认说法够不着**（「城堡花园」选中的是门楼，不是瞭望塔）
- 社区 `mcbuild-a-small-modern-house-16786`、`mcbuild-wood-modern-house-15774`：**只在 MC-ops 的缓存目录里有文件、不在任何索引里，任何说法都够不着**；主仓（真机）根本没有这两份

**表里的三处失败不在 #98 范围内（只报不改）**：`建个农舍` 真机口径 `aesthetic_score_below_threshold`、`建个花园庄园` 真机口径 `verified_real_community_samples_unavailable`——两者都是生成式图纸，#98 只放本地手工图纸；`建个小房子` 在空样本库下失败，真机有样本故能过。

**注意：探针里的 planId 不等于 census 金值（已证实，不是回归）**。planId 由摆放位置 + 步序算出，探针走完整 `previewBlueprint`（空背包、平地站点），census 走纯编译（给足背包）。例如塔楼小筑探针是 `0c7bde146102`（717 步），census 是 `aa0541605b26`（带脚手架 846 步）/ `152054c01dfc`（跳过脚手架）。真机的 planId 取决于实际地点和背包，**以真机日志为准**。

### 三、第 3 步：回归 + 看板 + 归档 + 提交

- `npm test`：基线 **88 条 / exit 0** → 收尾 **89 条 / exit 0**（多的一条是新测试组）
- **21 份图纸 planId 金值全部不变（已证实）**：复跑 `.tmp/ops-round15-hopper-census.js`，结果与第 20 轮那份逐字节相同，唯一差别是文件头时间戳
- 看板：`m01` 加「**建造 26 路由卡点 → 后勤 21 修（#98）**」一段，状态 `doing → done`（照任务书），名字改成「……已由后勤 21 修好（#98），待建造 27 真机连盖」；`dashboard-lanes` PASS；主仓与 MC-ops 两份一致，**主仓那份只改文件、未提交**
- 提交：`7e6ca24d`（`systems/building-system.js`、`tests/local-blueprint-budget-route.test.js`、`scripts/offline-build-start-probe.js`、`package.json`）、`a6242a5b`（`dashboard/board-data.json`），均显式指定文件

## 交接

### 给建造线（建造 27 照这个来）

1. **改动面**：`systems/building-system.js:473`（调用处多传图纸）、`:3739 shouldPreserveBudgetedBlueprint`（首行加一个岔口）、`:3755 isLocalHandmadeBlueprint`（新）。别的文件没动业务逻辑
2. **说法→路径表**：见上面第 2 步，**真机以 main-cache 列为准**。塔楼小筑现在应走预算路、715 块放置步
3. **真机上怎么判断走的是预算路**（按顺序）：
   - `[BLUEPRINT_SELECTED] request=tower_cottage selected=tower_cottage source=local_library ...`
   - `[BUILD_PIPELINE_STAGE] stage=design_transformation status=ok style=tudor_stone_tower transformed=false reason=low_complexity_request_preserves_simple_blueprint`（文案里的 low_complexity 是老文案，别被它误导）
   - `[BUILD_COMMUNITY_SAMPLES] blueprint=tower_cottage count=0 samples=[]`
   - `[BUILD_CONSTRUCTION_ESTIMATE] tier=L4 blocks=715 ...`
   - **不应再出现** `verified_real_community_samples_unavailable`
   - `stage=validate_style_grammar status=failed violations=[]` 会出现，**老行为、不拦开工**（小木屋同样有）
4. **`previewBudgetedSimpleBlueprint` 那一层没有拦截**：无块数 / 材料种类 / 占地上限判断（已证实，读码 + 离线出单）。拦截值不存在，所以 715 块 / 19 种材料 / 14×10 都过
5. **要留意的一点（合理推断）**：预算路里宜居硬闸是**跳过**的（`habitabilityHardGate.skipped=true`，日志里的 `ok=true` 是跳过时的占位值，不是真算出来的）。塔楼小筑的宜居硬闸第 19 轮离线全项通过过，但真机开工时**不会再算一遍**
6. **合并提示**：`feat/ops` 上待收共 **4 笔**——第 20 轮 `449aeec2` / `7a6fa672` + 本轮 `7e6ca24d` / `a6242a5b`，基于 `c4c1919e`。main 自 `c4c1919e` 起只多了 `51aa0529`（只动 `docs/协作/` 下 10 个文档），**与这 4 笔零文件重叠（已证实，`git diff --name-only` 求交集为空）**。两轮都改了 `package.json` 的 test 脚本，但都在同一分支上顺序改的，不冲突

### 给协调线

无（本轮不碰你们的地盘）。

### 给开发

- **#98 落地的判据**：`selected.sourceKind === 'local_library'` + `selected.localName`，排除 `localBlueprintPath` / `generatorKey` / `faithful-community-import`，**另加图纸 `metadata.complexityTier` 必须有值**——这一条是任务书没写、我为了不打破 `testBuildTaskPlacesBlock` 加的，已写成拍板问题 1。若老板选 A，删掉判据第一行 + 改那条验收即可
- **「开工级探针」建议进协议**：每次新图纸入库（以及每次合并前）跑一遍 `node scripts/offline-build-start-probe.js`，看新图纸那一行是不是 ✅、其余行和上一次比有没有变。说明.md 我没动，进不进由你们定
- **新图纸入库要带 `metadata.complexityTier`**（若选 B）：否则它会被当成老模板送去样本路。建议写进入库检查
- **UNKNOWN 清单**：
  1. 真机上塔楼小筑走预算路之后，缺料补给 / 暂存箱 / 施工一路能不能走通——离线只到出施工单为止，**UNKNOWN**
  2. 预算路跳过宜居硬闸，真机盖完后「能住人」只有第 19 轮的离线结论撑着，**真机未复验**
  3. 「不搭脚手架 + 17 格高」（后勤 18 的老拍板问题 2）仍未定，本轮没碰
  4. `建个农舍` / `建个花园庄园` 在真机口径下开不了工，属另一个根因，本轮只报不查

## 按 AGENTS.md 第 11 节

1. **读过的文件**：主仓 `docs/协作/说明.md`、`docs/协作/后勤/说明.md`、`docs/协作/后勤/给CC.md`、上轮 `CC反馈.md`、`AGENTS.md`（本会话前段已读）、主仓 `data/community-builds/cache/index.json`（只读）；MC-ops `systems/building-system.js`、`systems/blueprint-selector.js`、`systems/community-blueprint-index.js`、`systems/community-build-collector.js`（只读）、`systems/building-complexity.js`、`ai/intent-parser.js`、`ai/intent-to-task.js`、`ai/blueprint-name-index.js`、`tasks/build-task.js`、`tests/blueprint-building.test.js`、`blueprints/*.json`（只读）、`.tmp/ops-round15-hopper-census.js`。
2. **改动的文件**：MC-ops `systems/building-system.js`、`tests/local-blueprint-budget-route.test.js`（新）、`scripts/offline-build-start-probe.js`（新）、`package.json`、`dashboard/board-data.json`。主仓只改 `dashboard/board-data.json`、`docs/协作/后勤/CC反馈.md`，新增归档 `docs/协作/历史/后勤第20轮-临时箱子中转离线落地.md`（**只改文件、未提交**）。
3. **执行的命令**：`git status/log/diff/add <显式文件>/commit -F/merge-base`；`cp`（改前备份、归档、看板备份、临时换回改前文件跑对照后恢复）；按锚点精确替换的 node 补丁脚本（`.tmp/ops-round21-patch-*.js`，CRLF 保留）；离线复现 / 日志 / 探针脚本；`node tests/local-blueprint-budget-route.test.js`、`node tests/blueprint-building.test.js`、`node tests/dashboard-lanes.test.js`；`npm test`（基线 + 两次收尾，第一次因字面版判据挂 1 条，收窄后全绿）；复跑 census。**未执行**：社区同步、网络、`npm install/ci/update`、服务器/bot/端口/RCON、被禁 git 命令。
4. **测试结果**：基线 **88 / exit 0** → 字面版 **exit 1**（`testBuildTaskPlacesBlock`）→ 收窄版 **89 / exit 0**；新测试组 9 条全过；新测试组对改前代码当场挂出真机同款错误。
5. **当前最新判定**：
   - 第 1 步 **完成**（已证实）：根因复现到 16 ms 同款错误；预算路无第二道拦截；补丁 + 正向/反证/回归单测全过；`建个塔楼小筑` 离线出施工单（715 放置步）
   - 第 2 步 **完成**（已证实）：开工级探针已提交；15 句 × 2 口径的说法→路径表；改前改后仅 2 行变化
   - 第 3 步 **完成**（已证实）：全绿、21 份 planId 不变、看板、归档、两笔提交
   - **判据比字面窄一格，等老板拍板问题 1**；**真机未验**
6. **生成文件 / 内存是否变脏**：否。主仓 `data/memory/*`、`acceptance/reports/latest-*` 零触碰；MC-ops `.tmp/` 新增备份、补丁、探针输出（未跟踪、未提交）；探针的临时样本库与世界记忆写在系统临时目录。
7. **是否建议提交**：`feat/ops` 上本轮 2 笔已提交；建议**建造 27 真机验过塔楼小筑后，连同第 20 轮 2 笔共 4 笔一起收主干**。
8. **剩余风险**：
   - 拍板问题 1 若选 A，要改 `isLocalHandmadeBlueprint` 一行 + 改一条现成验收
   - 预算路跳过宜居硬闸（**已证实**），塔楼小筑真机开工时不复算
   - 新图纸若忘写 `metadata.complexityTier`，会静默走回样本路（**已证实**，单测 3'' 钉着这个行为）
   - 探针的 main-cache 口径依赖主仓缓存索引的当前内容；缓存一变，表就要重跑
   - 真机从出施工单到盖完这一段本轮完全没覆盖（UNKNOWN）
