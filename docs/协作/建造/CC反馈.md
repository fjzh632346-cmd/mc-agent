# 建造 第 27 轮反馈

- 线: 建造（民居线）
- 轮次: 27
- 日期: 2026-09-17
- 状态: **已完成**（第 1、2 步全做；第 3 步三栋都开了工、都盖到了高处、**0/3 完工**——两栋卡在「床放歪」、一栋卡在「楼梯井里多出一块木板拆不掉」，均为真机新根因，只取证未修；第 4 步未做；收工干净）
- 分支 / HEAD: refactor/building-blueprint-ir-v1 / `d11d4c20`（合修缮 15+16+17 = `288d6a9a`，合后勤 20+21 = `d11d4c20`）；本反馈与文档随后一笔
- 实际运行模型 / 强度 / ultracode: Fable 5.1（`claude-fable-5-1`，已证实）/ 思考强度本端读不到档位，UNKNOWN / **未开 ultracode**（真机轮，任务书标「不开」；全程未用子代理）

**老板旁观用 origin（三栋都在，都没盖完）**：
- A：`460,64,-236`（比计划北移 4 格，原因见技术细节三；缺 8 块 + 2 块床朝向错）
- B：`966,72,-278`（按计划；缺 1 块 + 3 块床位置/朝向错；**五个高处点全在，含塔尖火把**）
- C：`917,67,-406`（按计划；只盖到 586/715，塔顶与锥顶没盖，卡在楼梯井）
- 她登出点：小木屋 Q1 箱子旁 `416.5,63,-89.5`

---

## 一句话结论

三栋塔楼小筑都从一句话顺利开工、都不搭脚手架盖到了十几格高（第二栋连塔尖火把都放上了），但没有一栋盖完：两栋在放床时把床放歪、卡死在后面的火把和另一张床上，第三栋在楼梯井里多出一块木板又不许拆——三个都是这轮真机新暴露的问题，不是路由、不是材料、不是她够不着。

## 白话摘要

先把修缮线三轮和后勤线两轮的代码收进主线，只有测试清单那一行撞了两次、都按"三家的测试都保留"合上，测试从八十七组涨到九十组全绿；离线探针三十行和后勤线那张表逐行一样，塔楼那行确认走"按图直接盖"的路。三块地重新逐格核过，落脚区都是零高差，只有一块地里有一格是泥土不是草。

真机上，"建个塔楼小筑"这句话这次一说就开工了，上一轮那个"找不到社区样本"的坎已经过去。第一栋盖了两个多小时到七百零七块（缺八块），卡在塔楼三层：她放床时是按自己当时脸朝哪放的、不是按图纸，床头压到了火把的位置，火把放不了、床又不许拆，就停了。第二栋更好，七百一十四块都在、塔尖火把也在，但两张床一张放歪一张挪了一格，图纸上那一步就永远放不上，按"同一块砖三次失败就停"停了。第三栋盖到五百八十六块，楼梯井本该是空的地方多了一块木板，她要清掉它、系统说"拆结构块得先有恢复方案"不让拆，也停了。

这一轮我自己的保姆脚本也给她添了乱：一次是补料只补一遍、她把料拿去搭临时立柱又不捡掉落物，第二次缺料没人补；一次是我把她传送到她刚砌好的地基里，她窒息死了两回；死后她又卡在一个"血不够高不肯退出逃生、饱食度又不够低不肯吃饭"的死区里把移动锁占死，只能重启她。这些都写清了，不算她的账。

三个问题都要开发排：床按图纸朝向放、楼梯井那块木板从哪来的、还有"同一张图纸只要有一份没盖完的档案，别处再说建就会去续那份"这条规矩（我是用英文"rebuild"绕过去的）。要不要继续给塔楼小筑定"稳定档"，我的答案是现在还不能。

## 需要老板拍板的问题

### 问题 1：同一张图纸、另一块地再开工，现在会被上一栋没盖完的档案"抓走"，要不要改？
- 背景：说"盖个带塔楼的房子"时，系统先找这张图纸有没有没盖完的施工档案，有就去续那份、不管它在五百格外，结果报"工地太远"；只有英文"rebuild …"能作废旧档案另起一栋，中文没有对应说法。这一轮 B、C 两栋我都是这么绕的，绕的代价是 A、B 的档案被标成"已放弃"（世界里的房子还在）。
- 选项 A：续建只认"离她三十二格以内"的档案，远处的不抓。代价：改一处判断 + 单测；风险：同一张图纸在附近有两栋半成品时要靠距离分辨。
- 选项 B：加一句中文（比如"另起一栋"/"重新盖"）触发作废旧档案的路。代价：改说法解析 + 单测；风险：玩家误说把在建的作废了。
- 选项 C：维持现状，靠英文绕。代价：零；风险：以后每次多栋连盖都得记得这个坑。
- 我的建议：A，因为"续建"本来就要求她在三十二格内，把这条件提前到挑档案时最自然，也不需要玩家学新话。

### 问题 2：塔楼小筑不搭脚手架能盖到顶，但每栋两个小时以上，要不要给它开脚手架（#95）？
- 背景：三栋里 B 栋五个高处点全部放上（塔尖火把在），A 栋只差塔尖火把；代价是 y+5 以上每块砖都要"搭四到六格临时立柱、放砖、逐格拆"，约一分半一块，三栋累计搭拆了四百七十四块立柱，材料还会被立柱吃掉要反复补。一栋两小时出头，其中六成时间花在高处。
- 选项 A：维持不搭（`skipScaffolding` 不动），先修床和楼梯井两处根因再看。代价：每栋两小时；风险：无新增。
- 选项 B：打开脚手架（编译期多 17 块脚手架步 + 拆除步），看能不能把高处时间压下来。代价：后勤线离线出一份新 planId、再真机验一栋；风险：拆脚手架又是一轮"够不着"。
- 我的建议：A，因为"够不上"这轮已经证伪了，卡住的是床和清障，先修它们；等两处修好再用同一栋比较开/关脚手架的耗时才有意义。

### 问题 3：#35 塔楼小筑能不能定"稳定档"？
- 背景：口径同第 25 轮小木屋（三连盖全完工）。这轮 0/3 完工，但三栋都开工、都过了高处，失败点集中在两个确定性的问题上。
- 我的建议：**不能定**，等床朝向 + 清障两处修好后再连盖三次；三块地、脚本、材料清单都现成。

## 技术细节

### 一、第 1 步：合三线（完成，两处 `package.json` 冲突按并集解）

| 项 | 结果 |
|---|---|
| 开场基线 `npm test` @ `51aa0529` | exit 0，**87** 组（**已证实**） |
| `git merge --no-edit dcc8b215`（修缮 15+16+17） | 只撞 `package.json` test 链一行（HEAD 链有后勤 18/19 的 `dashboard-lanes`/`intent-blueprint-names` 等 9 组，修缮链没有），按并集解：在 `connection-recovery` 后插 `death-respawn`；`systems/survival-system.js` **自动合上**（`resetAfterDeath` 在 `:837`）；合并提交 `288d6a9a`；`npm test` exit 0，**88** 组 |
| `git merge --no-edit a6242a5b`（后勤 20+21） | 又只撞 `package.json` 同一行，并集：`blueprint-building` 后插 `local-blueprint-budget-route`、`storage-system` 后插 `temporary-worksite-chest`；`survival-system.js` 自动合上；合并提交 `d11d4c20`；`npm test` exit 0，**90** 组（**已证实**，`.tmp/cc-r27-test-after-ops.txt`） |
| 三个数 | 90 = 后勤 21 收尾 89 + 修缮 17 的 `death-respawn` 1；修缮 17 的 79 = 主干 87 − 修缮链缺的 9 组（`axis-reference-order`/`clickable-reference-order`/`clicked-face-reference-order`/`clicked-face-placement`/`oriented-placement-state`/`construction-run-archive`/`construction-resume-plan-id`/`dashboard-lanes`/`intent-blueprint-names`）+ 1，口径是"每个测试文件一行 tests passed"（**已证实**，链长 66 → 68） |
| `dashboard/board-data.json` | 工作区（后勤线写的）与 `a6242a5b` 版本逐字一致，合并前 `git show HEAD:… >` 退回、`update-index --refresh` 后合并，合后复制回工作区，`git diff --stat -- dashboard/board-data.json` 为空（**已证实**） |
| 主仓 `main` | `git -C D:\code\MC merge --ff-only d11d4c20` 快进（`51aa0529 → d11d4c20`）；`npm --prefix D:\code\MC test` exit 0，**90** 组（**已证实**，`.tmp/cc-r27-main-test.txt`）。主仓工作区只剩它自己的 `latest-*` 与 `data/memory/*` 脏，未动 |

### 二、第 2 步：离线核（完成，census 只核了塔楼两个金值）

- `node scripts/offline-build-start-probe.js --json=.tmp/cc-r27-probe.json`：1.7 s 跑完 30 行；**塔楼行 empty / main-cache 均「budget ✅ 717(715) construction_plan_0c7bde146102」**；其余 28 行与后勤 21 反馈第 2 步表逐行比对，路径 / 成败 / 步数 / planId / 错误串**全部相同**（**已证实**，含 `建个小房子` main-cache 116(114) `8835a6fdcd74`、`建个农舍` `aesthetic_score_below_threshold`、`建个花园庄园` 两列 `samples_unavailable`）
- census：`.tmp/ops-round15-hopper-census.js` **不在本 worktree**，21 份金值清单也不在任何我能读的文件里（`docs/协作/历史/后勤第*` 与 `docs/协作/后勤/附件/` 都只有塔楼的两个）。按后勤口径重算塔楼（`LegacyBlueprintAdapter → BlueprintValidator → ConstructionCompiler`，origin `0,64,0`，给足背包，`includeWalkabilityGate:true`）：`skipScaffolding:true` → **`construction_plan_152054c01dfc`**（812 步）、`false` → **`construction_plan_aa0541605b26`**（846 步），两个金值合并后不变（**已证实**）；其余 19 份 **UNKNOWN**（没脚本没清单）
- 三块地 RCON 逐格复核（`forceload` → `execute if block` → `forceload remove all`）：落脚 14×10（房子 x −1..12、z −2..7）三块**全部零高差**（140/140）；B 落脚区内 `966,71,-275` 是 `dirt`（平的，不是草）；外圈：A 全 0、B 有 71 列 −1、C 有 9 列 +1（≤1 口径成立）；体积 y+1..y+17 无残留（B 的 2 处"残留"是高草上半截）（**已证实**）。开工时 A 的 `[BUILD_SITE_SCAN] … hazards=0 foundationFills=0`

### 三、第 3 步：三连盖（0/3 完工；三栋各卡一处，两处同因）

**说法与路由（**已证实**，三栋日志同型）**：`[BLUEPRINT_SELECTED] request=tower_cottage selected=tower_cottage source=local_library score=96.104` → `[BUILD_PIPELINE_STAGE] stage=design_transformation status=ok style=tudor_stone_tower transformed=false reason=low_complexity_request_preserves_simple_blueprint` → `stage=validate_style_grammar status=failed violations=[]`（老行为） → `[BUILD_COMMUNITY_SAMPLES] blueprint=tower_cottage count=0 samples=[]` → `[BUILD_HABITABILITY_GATE] stage=pre ok=true`（预算路占位） → `[BUILD_CONSTRUCTION_ESTIMATE] tier=L4 blocks=715 steps=767`。**全程 0 条 `verified_real_community_samples_unavailable`**。三栋说法：A `建个塔楼小筑`；B 首令 `rebuild the tower cottage`、续建 `盖个带塔楼的房子`；C 首令 `rebuild the medium house`、续建 `建个中等房子`（首令用英文的原因见下"活动档案"）。**英文 rebuild 令不带 designSpec，估算打成 `tier=L3 … warnings=["block_budget_exceeded"]`，只警告不拦**（**已证实**）。

**origin = 她位置取整**（**已证实**，`systems/building-system.js:8658`）：A 首次 tp 到 `460.5,64,-235.5` → origin `460,64,-236`（计划 −232，北移 4 格；地基没填充、site scan 通过，之后按实际 origin 续建）；B/C 改成落在 origin 格上，origin 与计划一致。

| 栋 | 时段（UTC） | 结果 | 核方块（RCON 逐格，`verify-tower.js`） | 五个高处点 | planId（真机） |
|---|---|---|---|---|---|
| A | 05:11–08:18（3 h 07，其中约 25 min 是脚本自己惹的，见四） | `site_blocked`：`protected_obstruction:white_bed:471,73,-237`——塔楼三层火把位 (11,9,−1) 被床头占着 | **705/715 完全对 + 2 块床类型对朝向错 = 707 在位**；缺 8：门廊 6 根 `spruce_fence`（rel y1）、`chest` (1,1,1)、`torch` (11,9,−1)、塔尖 `torch` (10,16,0)；air 13/13 | 屋脊 10/10、烟囱顶 1/1、锥顶 30/30、塔尖木头 1/1、**塔尖火把 0/1** | `construction_plan_0ee1fe962b52`（档案后被 B 的 rebuild 标 ABANDONED） |
| B | 08:35–10:32（1 h 57） | `3strike`：二层床脚 (2,5,1) 三次 `place_failed:unstable_air` | **711/715 完全对 + 3 块床 = 714 在位**；缺 1：(2,5,1)；air 13/13 | **5/5 全在（含塔尖火把）** | `construction_plan_49f8683f6085`（被 C 的 rebuild 标 ABANDONED） |
| C | 10:46–12:28（1 h 42） | `3strike`：楼梯井空格 (4,4,5) 三次 `STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN` | **586/715**；air 11/13；缺 131（塔楼 y+12 地板 9、锥顶 14、屋脊 9、塔尖 2、二层床、门等） | 屋脊 1/10、烟囱顶 1/1、锥顶 16/30、塔尖 0/2 | `construction_plan_f50585349295`（档案仍 ACTIVE：624 verified / 132 pending） |

**根因 1（**已证实**，A、B 各一次）：床的朝向/落点不按图纸。** 图纸塔楼三层床 (10,9,0) foot + (11,9,0) head `facing=east`。A 世界里 `471,73,-237` = `white_bed[part=head,facing=north]`（床头压到 (11,9,−1) 火把位）；B 世界里 `976,81,-278` = `white_bed[foot,facing=west]`、`975,81,-278` = `[head,facing=west]`（镜像，床头跑到 (9,9,0)），于是 (11,9,0) 那一步永远 `unstable_air`。B 二层床图纸 (2,5,1) foot + (2,5,2) head `facing=south`，世界里 foot 在 `968,77,-276` = (2,5,2)（挪了一格），(2,5,1) 那步永远放不上。日志每次都是 `[BUILD_BED_PLACE_KEEP_YAW] target=… reference=…`——**朝向跟她当时的 yaw 走**，A 二层两张床恰好对了。A 的后果更重：床头占了火把格，火把步 `protected_block:white_bed` → 续建时 `protected_obstruction` → 档案卡死。

**根因 2（**合理推断**）：C 的楼梯井 (4,4,5) 多了一块 `spruce_planks`。** 图纸该格是 air；`clear_obstruction` 步三次 `STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN`（拆"结构块"要恢复方案）。那块木板从哪来 **UNKNOWN**：日志里该坐标没有 `TEMP_REFERENCE` / `SCAFFOLD_PLACED` 记录，(4,4,5) 正上方 (4,5,5) 是二层地板，最像是二层地板/楼梯放砖时贴错了一格；没抓到放置那一刻。

**#95 五个高处点实况（**已证实**）**：B 全部放上；A 除塔尖火把（没轮到）全放上；C 没盖到。高处的真实代价：**`skipScaffolding:true` 只跳过编译期脚手架，运行期 y+5 以上每块砖走 `BUILD_VERTICAL_ACCESS_PLAN`：搭 4–6 格立柱（`BUILD_VERTICAL_ACCESS_SCAFFOLD_PLACED` 三栋合计 474 次）→ 放砖 → `BUILD_STAIR_TEMP_REFERENCE_CLEAR` 逐格拆**，约 90 s/块；地面 y+1..y+4 约 8 块/min。塔楼外角 y+10（A `470,74,-238`）：`place_failed:unstable_air` ×3 + 三个站位 `stand_move_timeout_blacklisted` 后才 `no_reachable_build_stance_after_scaffold_candidates`，之后从别的角度放上；烟囱柱 y+10/11（B `965,82,-275`、C `916,78,-403`）两次 `no_reachable…` 后由脚本 #74 屋顶传送到已核实实心块上，**一放即中**（`TARGET_ADVANCED AFTER_TP=true`）。

**预算路真机全链路（后勤 21 的 UNKNOWN 第 1 条）**：出施工单 ✅（`BUILD_CONSTRUCTION_RUN mode=new`）→ 缺料补给：她自己的路是找 24 格内箱子（`[CHEST_NOT_FOUND] radius=24` → `[BUILD_STORAGE_REFILL_FAILED]` → `staged_material_missing:<item>:chest_not_found`，未映射键），荒地没箱子就 `missing_materials`，由脚本 `give`（三栋合计 39 次）✅ → 施工 ✅ → **完工 ❌**（三栋都没走到 `BUILD_HABITABILITY_GATE stage=final`）。**材料会被立柱/临时参照吃掉、拆下的掉落物她不捡**（`[pickup] action=observe_only reason=await_player_command`，58+ 次），所以同一种材料要反复补。跨进程重启续建 ✅（`processRestarted=true`，同 runId）。

**同图纸活动档案（**已证实**，`systems/building-system.js:1225`）**：`findActiveCompatible(criteria)` 不看距离；A 档案 ACTIVE 时在 B 说 `盖个带塔楼的房子` → 去续 A → `build_origin_too_far` ×15。中文无 forceRebuild 触发词（`ai/intent-parser.js:944` 只认 `rebuild|reconstruct`）；`rebuild the tower cottage` → `[BUILD_CONSTRUCTION_RUN_ABANDON] runId=… reason=explicit_rebuild_requested` → 新档案。**注意 rebuild 令在已有半成品的工地上会 `EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION`**（我重启脚本时误发过 5 次，档案没被作废、无损）。

**宜居复验（**合理推断**，不是真机闸）**：预算路的 `stage=pre` 是占位 `ok=true`；三栋都没到 `stage=final`。我用现成入口 `BuildingHardGate.evaluateBlueprint` 对"图纸 + 逐格实测差异"的成品跑了一次（scratchpad `hardgate-world.js`）：图纸本身 ok=true；A 成品 **ok=false `allFunctionalBlocksUsable`**（缺箱子/火把/床歪）；B 成品 **ok=true**（床朝向错闸看不出来）；C 成品 ok=false（门还没放、`upper_sleeping`/`tower_3` 不可达）。缺的入口：对真机方块（含朝向）直接评估的闸，现在只有从 session 的世界快照走的那条。

**修缮 16/17 判据在建造场景**（两段 bot 日志合计，`.tmp/cc-r27-bot-log-1.log` + `-2.log`）：

| 项 | 计数 | 说明 |
|---|---|---|
| `lock_already_held` | **2** | ① `owner=34 currentOwner=legacy_escape`（窒息死后旧版脱困占锁，见四，脚本按 #75 撤销后的规矩记档停手）② `owner=task_manager_status_inventory currentOwner=13`（`debug_status` 读背包，正在跑的建造任务 13 持锁——修缮 16 说的合法那一条） |
| currentOwner 已终态的 `lock_already_held` | **0** | ✅ |
| `[action-lock] reclaim` | **0** | ✅ |
| `[TASK_PREEMPT]` | **0** | 无 CRITICAL 打断 |
| `[BOT_DEATH]` / `[BOT_RESPAWN]` | 2 / 2 | 都是脚本把她传进自家地基窒息（见四），`items=520/544 inventoryLost=false`，`[BOT_DEATH_RESET] … worksiteAnchor=cleared`，`[BOT_RESPAWN_SAY]` 一句到位；死时 `currentTask=none`，无 `TASK_INTERRUPTED reason=bot_died` |
| `[EVENT_LOOP_STALL]` | 18 | 2.0–4.4 s，多数 `task=none`；`[utility-search]` 14 行后无 >10 s 静默、未被踢 |
| `enqueue task=return_to_base` | 34 | 停工后离基地 500+ 格立刻跑家（老问题），两次把存物任务抢掉 |
| `[TASK_FEEDBACK_UNMAPPED]` key | 见下 | `missing_materials` 23、`no_reachable_build_stance_after_vertical_access_candidates` 6、`STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN` 6、`EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION` 6、`place_failed:unstable_air` 5、`player_build_command` 3、`BLOCKED_MATERIAL_SHORTAGE:wall:cobblestone:1` 3、`staged_material_missing:cobblestone:chest_not_found` 2、`placement_target_occupied` 2、`BLOCKED_MATERIAL_SHORTAGE:roof:spruce_planks:1` 2、各 1：`protected_obstruction:white_bed:471,73,-237`、`protected_block:white_bed`、`placement_material_refill_retry_limit:dark_oak_planks:block_item_not_found`、`placement_material_refill_retry_limit::block_item_not_found`（物品名为空）、`phase_dependency_incomplete:wall:floor:step_cba1b0a605107f88`、`no_reachable_build_stance_after_scaffold_candidates`、`lock_already_held`、`inventory_item_not_found:dark_oak_log`、`chest_path_unreachable`、`BLOCKED_MATERIAL_SHORTAGE:white_bed:2`、`escape_backoff_hold:<ms>` ×13 |

### 四、脚本自己的账（我的，不算她的）

1. **补给只补一次**（r26 脚本沿用）：A 第一段 22 min 254 步后圆石/木板被立柱吃光，8 次 `missing_materials` 无人补 → `shortage_stuck`。改成每次 `BUILD_MATERIAL_MISSING` 都给（上限 2000/项）。
2. **续建落点传进地基**：我把"落在 origin 格"用到了续建上，`460,64,-236` 已是石砖 → 血 5 秒归零（`dangerLevel=none`、无敌对）→ **死两次**（第二次是旧脚本的救援又传了一次）。改成 `tpSafe()`：脚下实、身位/头位空或草，续建/救援一律落门廊北侧 (o.z−4)，新地才落 origin 格。
3. **窒息后旧版脱困锁死区**（真根因，归修缮线）：`bot.js:1183-1185` 血 ≤6 `enterEscapeMode`（`utils/legacy-movement-guard.js` 以 `legacy_escape` 拿 movement 锁）、血 ≥16 才 `exitEscapeMode`、自动吃饭只在饱食 ≤15、自然回血要饱食 ≥18；她血 13.5 / 饱食 17 → 不回血、不吃、不退出，`停止任务` 无效，建造令 `lock_already_held currentOwner=legacy_escape`。**只能重启 bot**（人工 `Stop-Process` + `start-detached`，记档，不是脚本兜底）。
4. 重启脚本时误用首令 rebuild（B 一次，`EXISTING_STRUCTURE…` ×5 无损）、未加载区块上落点检查全 false 且同步 RCON 把脚本自己的连接卡到被踢（B/C 各一次，`forceload` 后解决）、补给上限按剩余需求算错（B 一次 `GIVE_CAP_HIT`）。
5. 人工干预两次：B 她被困塔楼二层（`noPath` ×52，715 块全禁挖）10 min 不动，我 RCON 传到门廊外；B 工地上有头猪 `entity_obstruction:pig` 拦开工，`tp` 到 30 格外。

### 五、收工（**已证实**）

- 脚本：每栋结束 `停止任务` + 传到 Q1 箱子旁；最后 `Get-CimInstance` 核 `cc-r27-tower-driver` 0 个
- bot：按 `Get-NetTCPConnection RemotePort=25565` 核对后 `Stop-Process`（pid 32396；之前 3456 同法）；25566 零连接、修缮线无进程
- 世界：`forceload query` = `No force loaded chunks`（每栋收工 `remove all`）；`save-all flush` → `mc-server.ps1 stop` 经 RCON → `All dimensions are saved` / `RCON Listener stopped`；25565/25575 监听 0、`server.pid` 已删、node 进程 0
- 世界现状：三栋半成品（见表）；她的存物：Q1 箱子 `418,64,-88` 已满（27/27）、A 一层双箱 `461,65,-235/-234` 已满、A 塔楼储藏双箱 `470/471,65,-235` 存了木板/原木/圆石；那头猪在 `966,72,-310`；未 `setblock`/`fill`/`give` 图纸外方块，未改 gamerule/time
- 日志：`.tmp/cc-r27-bot-log-1.log`（05:07–05:48）、`-2.log`（05:48–12:36）、`cc-r27-driver.log`、`cc-r27-verify-{A,B,C}.json`、`cc-r27-results-*.json`

## 交接

**给开发**：① #35 不能定稳定档（0/3，两处确定性根因）；② 拍板问题 1–3；③ 床朝向（`BUILD_BED_PLACE_KEEP_YAW` 跟 yaw 不跟图纸 `states.facing`，A/B 各一次，A 还牵连火把格）——最小改法建议：放床前按图纸 facing 转身/选站位，或放完比对 `part/facing` 不对就拆重放（床是她自己放的、不该受保护）；④ C 楼梯井多出的木板来源要加放置日志才能钉死；⑤ 英文 rebuild 令估算档位掉到 L3 只警告。

**给后勤线**：① 探针 main-cache 表与真机对得上：路径同、`BUILD_CONSTRUCTION_ESTIMATE` 步数 767（真机含 50 步清草）vs 探针 717；② 预算路跳过宜居硬闸：真机没到 final 无从验，我用 `evaluateBlueprint` 对成品跑的结果见三，建议完工后对世界快照跑一次；③ #95 五点实况见三；④ `metadata.complexityTier` 这条规矩这轮没踩到（图纸没动）；⑤ 后勤 20 临时箱子（第 4 步）**未做**：三栋都没余力；顺带观察：缺料时她找箱子的路只查 24 格（`CHEST_NOT_FOUND radius=24`），荒地开工靠不上任何箱子。

**给协调线（修缮）**：① `lock_already_held` 2 / reclaim 0 / `TASK_PREEMPT` 0 / 终态 owner 0——新判据在建造场景成立，唯一异常那条是旧版脱困锁死区（技术细节四.3，含阈值）；② 停工即跑家 34 次，两次抢掉存物任务（存物优先级 6 < 回家 8）；③ 她被困在塔楼二层室内下不来（B，`noPath` 到所有一层站位）；④ 三栋新失败键清单见三；⑤ 她死时 `currentTask=none` 所以没触发 `TASK_INTERRUPTED reason=bot_died`，死亡链本身两次都正常。

## 按 AGENTS.md 第 11 节

### 1. 读过的文件

`docs/协作/说明.md`、`AGENTS.md`、`docs/协作/建造/给CC.md`（第 27 轮）、上轮 `CC反馈.md`、`docs/协作/后勤/CC反馈.md`（后勤 21 第 2/3 步与交接）、`docs/协作/历史/后勤第19轮-*.md`（census/宜居段）、`docs/CODEX_BOT_STARTUP.md`、`scripts/{start-detached.ps1,mc-server.ps1,mc-rcon.js,offline-build-start-probe.js}`、`blueprints/tower_cottage.json`、`systems/building-system.js`（L138–210、L560–600、L600–620、L700–770、L875–1000、L1220–1380、L2868–2910、L3739–3845、L6420–6500、L8658）、`systems/building-hard-gate.js`（L1–40）、`systems/construction-run-store.js`（L29、L166–330）、`core/action-lock.js`（L25–100）、`core/death-handler.js`（日志行）、`tasks/task-manager.js`（日志行）、`bot.js`（L985–1040、L1180–1186）、`utils/legacy-movement-guard.js`、`actions/action-utils.js`（L15–40）、`ai/intent-parser.js`（L944–1010）、`tests/construction-resume-plan-id.test.js`（L28–62）、`.tmp/cc-r26-tower-driver.js`、`cc-r26-chat.js`、`cc-r26-plots*.json`、`data/memory/construction-runs.json`（只读）、`logs/bot-current.log`、`D:\code\MC-server\server.properties`（键名，密码只进进程环境）、`D:\code\MC-server\logs\latest.log`（尾部）

### 2. 改动的文件

| 提交 | 内容 |
|---|---|
| `288d6a9a` | 合修缮 15+16+17（`dcc8b215`），`package.json` 并集 |
| `d11d4c20` | 合后勤 20+21（`a6242a5b`），`package.json` 并集 |
| （随后一笔） | 本反馈、`docs/协作/说明.md`（+1 行归档第 26 轮）、`docs/协作/历史/第26轮-合后勤18与19与塔楼开工路由卡点.md`（新）、`docs/协作/老板决策台账.md` + `docs/协作/建造/给CC.md`（开发已改，随轮入库）、他线归档件 `docs/协作/历史/修缮第16轮-*.md` / `修缮第17轮-*.md` / `后勤第20轮-*.md`（未跟踪 → 入库） |
| （工作区，不提交） | `dashboard/board-data.json`（与 HEAD 一致）、`docs/协作/后勤/*`（后勤线地盘，未动）、`data/memory/*`、`acceptance/reports/latest-*` |
| （未入库） | `.tmp/cc-r27-tower-driver.js`（r26 脚本 + 本轮 8 处补丁）、`cc-r27-plots.json`、`cc-r27-start-driver.ps1`、`cc-r27-probe.{json,out}`、`cc-r27-test-*.txt`、`cc-r27-main-test.txt`、`cc-r27-bot-log-{1,2}.log`、`cc-r27-bot-stdout-{1,2}.log`、`cc-r27-server-start.log`、`cc-r27-driver.log`、`cc-r27-driver.ps.log`、`cc-r27-results-*.json`、`cc-r27-verify-{A,B,C}.json`、`cc-r27-go-{A,B,C}.flag`、`cc-r27-board-data.json.backup`；scratchpad：`rcm.js`、`rconc.js`、`plotcheck27.js`、`ringcheck27.js`、`footcheck.js`、`whatblock.js`、`findchests.js`、`verify-tower.js`、`compile-tower.js`、`hardgate-world.js`、`patch-driver-*.js` |
| （世界） | 三栋半成品、她的存物、一头猪挪位；零 `setblock`/`fill`/图纸外 `give` |

未改任何项目 JS 逻辑（合并带进来的除外）；未改图纸；未手改存档。

### 3. 执行的命令

`git status/log/merge-base/diff/merge --no-edit ×2/add package.json/commit --no-edit ×2/show HEAD:… >/update-index --refresh`、`git -C D:\code\MC merge --ff-only d11d4c20`、`npm test` ×3（87/88/90）、`npm --prefix D:\code\MC test` ×1（90）、`node scripts/offline-build-start-probe.js --json=…`、`node` 只读脚本（编译金值、parseIntent ×3 批、图纸结构、施工档案读取、宜居硬闸）、`node --check` ×8、`cp` 归档/备份、`scripts\start-detached.ps1` ×12（服务器 1、bot 2、保姆脚本 9）、`scripts\mc-server.ps1 start/status/stop`、`Stop-Process` ×10（保姆脚本 8 次按命令行核对、bot 2 次按端口核对，均排除自身）；RCON（`rcm.js`/`rconc.js`，密码运行时读）：`forceload add/query/remove all` 若干、`execute if block` 约 4 万次（地块复核 + 三栋逐格核对）、`data get entity LinXia Pos/Inventory/Health` 若干、`data get block … Items` ×3、`tp LinXia` ×8（手动：安全点 2、箱子旁 4、门廊外 1、脚本外）、`tp @e[type=pig]` ×1、`execute if entity` ×3、`list`/`time query`、`save-all flush` ×2、`stop`（经 `mc-server.ps1`）；聊天（`cc-r26-chat.js`）：`停止任务` ×3、`把东西存起来` ×3、`把木板/原木/圆石/石砖/深色橡木木板放进箱子` ×8、`debug_status`（脚本内）。
未执行：`npm install/ci/update`、`git add -A/.`、`git reset/clean/checkout --/restore/stash`、进 `MC-fix`/`MC-ops`、连 25566、改项目 JS、改图纸、手改存档、`setblock`/`fill`、`syncCommunityBlueprints`。

### 4. 测试结果

| 时点 | 命令 | 结果 |
|---|---|---|
| 开场 @51aa0529 | `npm test` | exit 0 / 87 组 |
| 合修缮 @288d6a9a | `npm test` | exit 0 / 88 组 |
| 合后勤 @d11d4c20 | `npm test` | exit 0 / 90 组 |
| 主仓 @d11d4c20 | `npm --prefix D:\code\MC test` | exit 0 / 90 组 |
| 离线 | 探针 30 行同后勤 21；塔楼金值 `152054c01dfc`/`aa0541605b26` 不变 | 通过 |
| 真机 | A 707/715 在位（`site_blocked`）、B 714/715（`3strike`）、C 586/715（`3strike`）；完工 0/3 | **FAIL（三栋各卡一处，根因见三）** |

### 5. 当前最新判定

- 第 1 步 **完成**；第 2 步 **完成（census 19 份 UNKNOWN）**；第 3 步 **完成但 0/3 完工**（三栋都开工、都过高处；A/B 卡床朝向，C 卡楼梯井清障）；第 4 步 **未做**；第 5 步 **完成**（本笔）
- #35 不能定；#95 "不搭能盖到顶"成立、代价约 90 s/块；预算路全链路走到"施工"，"完工"未到

### 6. 生成文件 / 内存是否变脏

`data/memory/construction-runs.json`：+3 份档案（A、B ABANDONED；C ACTIVE）及若干 `.tmp-*` 中间文件；`task-memory.json` / `world-memory.json`：脏；`acceptance/reports/latest-*`：未动（本轮没跑验收）；`dashboard/board-data.json`：与 HEAD 一致；`logs/`：两段（已另存 `.tmp/`）；`.tmp/cc-r27-*` 约 20 个文件（bot 日志 15 MB + 3 MB）。均不提交。

### 7. 是否建议提交

本反馈 + 文档 + 他线归档件一笔（显式指定文件）；主仓再快进一次。`data/memory/*`、`logs/*`、`.tmp/*`、`dashboard/*`、`docs/协作/后勤/*`、`latest-*` 不提交。

### 8. 剩余风险

- 床朝向不修，塔楼小筑永远盖不完（三层床与火把互占）；C 那块木板来源不明，可能还有别的空格会被误填
- 三份半成品档案：A、B 已 ABANDONED，C ACTIVE——下次在 C 附近说建造令会续 C，在别处说会被 C 抓走（问题 1）
- 她的常驻箱子（Q1）和 A 一层双箱都满了，下轮清背包要换箱子或先取料
- 旧版脱困锁死区只要她再掉到血 7–15 / 饱食 16–17 就会复发，与建造无关
- 本轮脚本 8 处补丁都在 `.tmp/`，下轮直接用；`hardgate-world.js` 只是"图纸 + 差异"的近似，不等于真机世界闸
