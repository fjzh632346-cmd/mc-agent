# 建造 第 28 轮任务 — 床按图纸朝向放（根治）+ 楼梯井多出木板取证 + 真机再连盖「塔楼小筑」三次

- 线: 建造（民居线）
- 轮次: 28
- 下发日期: 2026-09-17
- **建议模型 / 思考强度 / 是否 ultracode**：`Fable 5.1` + `high`（先一个离线根因的最小补丁 + 单测，再多小时自主真机三连盖带多套判据——「极难」档）。**不开 ultracode**（真机轮；床的根因已钉到日志行，不值得撒子代理）。开场把实际模型/强度/ultracode 写进反馈头部
- 上一轮: 第 27 轮审毕——合三线 87→90 组全绿、主干快进 `d11d4c20`、探针 30 行逐行同后勤 21、三块地逐格核过；真机三栋都从一句话开工、都不搭脚手架过了高处（B 五点全在），**0/3 完工**：A/B 卡「床按 yaw 不按图纸」、C 卡「楼梯井 (4,4,5) 多一块木板不许拆」；脚本自己的账（补料只补一遍、传进地基窒息、旧版脱困锁死区）写得清楚。开发评价：路由的坎过去了，三个新根因取证到位——通过。老板拍板（**#114–#117**，正式出处见台账）：
  - **#114 同图纸活动档案只认她 32 格以内的**（问题 1 选 A）——**交后勤 22 离线改**（`findActiveCompatible`），本轮**不改**，你继续用英文 `rebuild …` 绕（口径见第 0 节）
  - **#115 脚手架先不开**（问题 2 选 A），`skipScaffolding: true` 原样；两处修好后再比开/关耗时
  - **#116 建造 28 = 床朝向根治 + 楼梯井木板取证 + 三连盖**
  - **#117 修缮 20 = 旧版脱困锁死区**（你四.3 那条，含阈值），12 处慢扫法顺延修缮 21。修缮 19（执行步看门狗）正在跑
  - **#35 塔楼小筑稳定档：本轮不定**，三连盖全完工再定

> 开工前：把上一轮的 `CC反馈.md` 整份归档到
> `docs\协作\历史\第27轮-合三线与塔楼三连盖零完工.md`，再重写反馈文件。

---

## 0. 现场与口径

**根因 1（已证实，A/B 各一次）**：`[BUILD_BED_PLACE_KEEP_YAW] target=… reference=…`——放床的朝向跟她当时的 yaw 走，不看图纸 `states.facing`。A 三层床 `471,73,-237` 放成 `head,facing=north`（图纸 east），床头压到 (11,9,−1) 火把格 → 火把步 `protected_block:white_bed` → 续建 `protected_obstruction` 档案卡死；B 三层床镜像成 `facing=west`、二层床 foot 挪到 (2,5,2) → (2,5,1) 永远 `unstable_air`。**床是她自己放的，不该受「保护块」豁免。**

**根因 2（合理推断）**：C 楼梯井 (4,4,5) 多了一块 `spruce_planks`，图纸该格是 air；`clear_obstruction` 三次 `STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN`。日志里该坐标无 `TEMP_REFERENCE` / `SCAFFOLD_PLACED`；正上方 (4,5,5) 是二层地板——最像放二层地板/楼梯时贴错一格，**没抓到放置那一刻**。

**世界现状**：三栋半成品 A `460,64,-236`（707/715，档案 ABANDONED）/ B `966,72,-278`（714/715，ABANDONED）/ C `917,67,-406`（586/715，档案 **ACTIVE**）；她在 Q1 箱子旁 `416.5,63,-89.5`；Q1 箱子 `418,64,-88` 与 A 一层双箱 `461,65,-235/-234` **已满**，A 塔楼储藏双箱 `470/471,65,-235` 有木板/原木/圆石；一头猪在 `966,72,-310`。**清背包换箱子或先取料**。

**活动档案口径（后勤 22 修好前）**：C 档案 ACTIVE——在别处说中文建造令会被它抓走；本轮**先用 `rebuild the tower cottage` 作废 C**（或在 C 附近 32 格内先用中文续建把 C 盖完——见第 3 步「第一栋」），每栋首令用 `rebuild …`、续建用中文。**已有半成品的工地上发 rebuild 会 `EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION`**（无损，但别当失败）。英文 rebuild 令估算档位掉到 L3 只警告（`block_budget_exceeded`），不拦，记档即可。

**保姆脚本**：`.tmp/cc-r27-tower-driver.js`（r26 + 8 处补丁：每次 `BUILD_MATERIAL_MISSING` 都补、`tpSafe()` 落门廊北侧、`GIVE_CAP` 按需求算）直接用；`verify-tower.js` 直接用。**#75 兜底仍不带**；再见旧版脱困锁死区（`lock_already_held currentOwner=legacy_escape`）→ 记档、人工重启 bot、写清血/饱食数值（给修缮 20 当证据）。

## 第 1 步：床按图纸朝向放（一轮一根因，最小补丁 + 单测，离线先过）

- 落点：`BUILD_BED_PLACE_KEEP_YAW` 那条路（`systems/building-system.js`，读码定位并写行号）。改成：**放床前按图纸 `states.facing` 转身/选站位**（床的朝向由玩家朝向决定，所以要让她面朝 facing 方向再放），放完**读回世界里的 `part` / `facing`**，与图纸不符 → 拆掉重放（最多 N 次，N 与同砖三败口径一致），仍不对按 `bed_orientation_mismatch` 失败（写清）。**她自己放的床不受「保护块」豁免**：拆重放那条路必须绕过 `protected_block`（只对本 run 刚放的床，别放宽通用规则）
- **不动**：编译顺序、`skipScaffolding`、脚手架/立柱逻辑、`clear_obstruction` 判据（根因 2 本轮只取证）
- 单测：图纸床 `facing=east/south/west/north` 四向各一条（假 bot 任意 yaw → 放后朝向 = 图纸）；反证：去掉转身那一步 → 朝向跟 yaw 走（红）；回归：`tests/blueprint-building.test.js` 里现成的放置/朝向测试（`oriented-placement-state` / `clicked-face-placement` 那几组）全绿
- 离线用塔楼图纸编一次施工单：planId 金值 `152054c01dfc`（skip）/ `aa0541605b26`（不 skip）**不得变**（本改动在运行期，不该动编译）；变了就停、写清

## 第 2 步：楼梯井木板取证（只加日志，不改行为）

- 在放置路径打一条能追溯的日志：`[BUILD_PLACE_COMMIT] step= target=<rel> world=<abs> item= reason=<blueprint|temp_reference|scaffold|vertical_access|refill_stage> stance=<她的位置>`——凡是往世界里放砖的分支都打（图纸步、临时参照、立柱、脚手架）。真机 C 栋若再出现楼梯井 (4,4,5) 或任何图纸 air 格被填，就能钉到哪一步、哪个分支
- 顺手在 `clear_obstruction` 走到 `STRUCTURAL_CLEAR_REQUIRES_RESTORE_PLAN` 时多打一行：该格是不是本 run 自己放的（查放置日志/run 记录）——**只打日志，不改判据**（改不改是拍板项）

## 第 3 步：真机连盖三次（判据同第 27 轮，加床/楼梯井两条）

**第一栋 = C 续建**（省 586 块，也验「补丁对半成品续建有效」）：把她传到 C 门廊北侧 32 格内，中文 `建个塔楼小筑` 续 C 的 ACTIVE 档案；楼梯井那块木板**先由你 RCON `setblock … air` 清掉并记档**（图纸外方块只准这一处，写清坐标与前后状态），让她继续。C 盖完 = 第一栋 ✅。
**第二、三栋**：A、B 两块地已被半成品占了——**选新地**（口径「落脚 15×12 零高差、外圈 ≤1」，第 26 轮测绘表还在，挑两块，逐格复核），首令 `rebuild the tower cottage`（作废 C 的已完工档案没关系，它已 COMPLETED），origin 落格、续建中文。三栋用三种说法记清。

**每栋判据**（在第 27 轮基础上加粗为新增）：
1. 开工四行日志齐、0 条 `verified_real_community_samples_unavailable`
2. **三张床（二层 (2,5,1)-(2,5,2) south、三层 (10,9,0)-(11,9,0) east、以及图纸里另一张）放完 RCON 读回 `part`/`facing` 与图纸一致**；`[BUILD_BED_PLACE_KEEP_YAW]` 不再出现（或改成新日志名，写清）；(11,9,−1) 火把、塔尖火把放上
3. **图纸 13 个 air 格盖完时全是 air**；若哪格被填，`[BUILD_PLACE_COMMIT]` 钉到是谁放的
4. 同砖三败即停（#90）；#74 救援传送保留；五个高处点实况照记
5. 盖完 `verify-tower.js` 715/715 + air 13/13 → 走到 `BUILD_HABITABILITY_GATE stage=final`（预算路真机第一次到 final，**结果原样记**，ok=false 也不算这轮失败）
6. 收工：`forceload remove all`、只杀本线、RCON 优雅停；记时长、`give` 次数、立柱搭拆次数、`lock_already_held`（终态 owner 口径）/ `reclaim` / `[TASK_PREEMPT]` / `[EVENT_LOOP_STALL]` / `[TASK_UPDATE_WATCHDOG]`（若修缮 19 已合——本轮没合，应为 0 条）

**停机点**：床补丁离线单测不过 → 不进游戏，状态「卡住了」；第一栋（C 续建）床仍放歪 → 停，不盖二三栋，把读回的 `part`/`facing` 与她当时 yaw 写细。

## 第 4 步：判定 + 归档 + 提交

- 反馈「一句话结论」直接回答 3/3 与否；#35 建议（三连盖全完工才能定）
- 提交显式指定文件：补丁 + 单测 + 日志 + 反馈 + 归档；`.tmp/`、施工档案、`data/memory/*`、`dashboard/*`、`docs/协作/后勤/*` 不提交；主干 `D:\code\MC` 快进一次

## 交接（写进反馈）

- **给开发**：床补丁落点/行号与读回核对结果；楼梯井木板若复现、是哪个分支放的；#35 建议；#95 开/关脚手架比对要不要排（只给建议）
- **给后勤线**：①活动档案距离改后（后勤 22）你这边真机要怎么验（给一个最小场景）②`staged_material_missing:<item>:chest_not_found` / `no_reachable_build_stance_after_vertical_access_candidates` 等本轮未映射键清单 ③缺料找箱子只查 24 格（`CHEST_NOT_FOUND radius=24`）在荒地的后果 ④预算路 `stage=final` 真机结果
- **给协调线（修缮）**：①旧版脱困锁死区若复发的血/饱食/锁 owner 原始行（修缮 20 要）②停工即跑家次数、抢掉存物任务次数 ③她被困室内 `noPath` 的实例 ④`[EVENT_LOOP_STALL]` 分布

## 红线

- 一轮一根因：只改「床朝向」这一条放置逻辑 + 只加日志；**不改 `clear_obstruction` 判据、不改档案匹配（后勤 22）、不改脚手架、不改通用保护块规则**
- 图纸外方块只准第 3 步第一栋那一处 `setblock air`（清楼梯井木板），记档；其余不 `setblock`/`fill`
- 不 `cd` 到 `MC-fix` / `MC-ops` / `MC`（主干快进用 `git -C` 即可，与第 27 轮同法）；游戏一线一服一图；收工只杀本线
- 不改图纸；`docs\协作\后勤\附件\` 不动；禁止全量 `syncCommunityBlueprints`；提交显式指定文件；禁止 `git add -A` / `reset --hard` / `clean -fd` / `stash` / `checkout --`
- 不确定要不要做的写「需要老板拍板」

## 分步验收

| 步 | 完成判据 | 做不完怎么办 |
|---|---|---|
| 1 | 四向单测 + 反证 + 回归全绿；planId 两金值不变 | 不过 → 「卡住了」不进游戏 |
| 2 | 放置日志覆盖所有往世界放砖的分支 | 某分支找不到 → 写清哪支没覆盖 |
| 3 | 三栋 715/715 + air 13/13 + 三张床朝向对 + 到 `stage=final` | 首栋床仍歪 → 停；三败即停；成败如实 |
| 4 | 反馈 + 归档 + 提交 + 主干快进 | — |
