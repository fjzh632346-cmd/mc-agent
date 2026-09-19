# 后勤 第 3 轮反馈

- 线: 后勤
- 轮次: 3
- 日期: 2026-08-31
- 状态: 已完成
- 分支 / HEAD: feat/ops / 3d1fa406（本轮零代码提交，与建造线第 8 轮合并轮完全错开）

---

## 一句话结论

新版 Java 根本不用装 —— 这台电脑上本来就有三份现成的，我挑了最稳的一份验过能跑，升级路上唯一那道「得有人动手」的门槛就此清空；升级的目标版本、要下载的东西、怎么验收，全部收敛成了修缮线拿去就能照做的稿子，顺带把验收考场里几十条布置命令逐条查了一遍，一处都不受新版本改名影响。

## 白话摘要

第一件事，也是本轮的硬任务：新版 Java。您猜得完全正确 —— 启动器给新版游戏下载过运行时，就在盘上。我在机器上一共翻出**三份**能用的新版 Java：一份是随别的软件装好的**完整版**，另外两份是启动器自己下载的游戏运行时。我挑了那份完整的，因为它不归启动器管，不会被启动器某天自动升级或删掉。挑完不是光看看就算数，我让它实际跑了一小段程序，确认真能干活。**全程只查看、没安装、没下载、没改任何设置**，您原来那套旧版 Java 一个字没动，服务器启动脚本也没动。两条施工线以后起服务器前指一下那份的位置就行。

顺带一个巧合可以让您更放心：游戏官方给这个新版本标注的「该用哪个运行时」，正好就是启动器给您下载的那两份里的一份 —— 说明这条路子是官方认的。

第二件事，把升级方案收敛成了定稿。目标版本按您拍板的定死，服务器程序的官方下载地址和校验码都取到了并写进稿子，加上启动写法、七条验收判据、出问题怎么退回来，修缮线下一轮拿去就能开工，不用再回头问任何一个数。

第三件事，补上一轮留的那个尾巴：验收考场里那几十条「发东西、摆方块、清场」的布置命令，会不会用到新版本里改了名的方块？逐条查完了，**一条都不受影响**，考场这一侧不用改。真正会被改名影响的还是老三样：三份素材里那二十九块草，和代码里十处只认旧名字的地方，这些在升级那一轮一起改。

第四件事，看板按今天四项拍板和三条线的进展更新完了，现在八组五十三条。

## 需要老板拍板的问题

无。

上一轮那两个问题（装不装 Java、升到哪个版本）您都已经拍板，本轮全部落实完毕，没有产生新的待决事项。

## 技术细节

### 〇、本轮零游戏占用（已证实）

全程未起服务器、未起 bot、未连任何端口，未跑 `npm install/ci/update`，未跑任何 sync（全量与 `--only` 都没跑），未碰门楼条目。对看板也**没有起 HTTP 实例**（本轮红线比上轮更严，改用离线校验，见第四节）。`java -version` / `javac -version` / 跑一个 8 行的探针类，都只是进程内执行，不涉及网络与服务端。

网络访问仅两次**只读元数据**：Mojang 官方版本清单与 1.21.8 版本 JSON（为交付「官方下载地址与 SHA1」所必需），**未下载任何 jar、未下载 Java zip**（因为找到了现成的）。

`D:\code\MC-fix`、`D:\code\MC` 一次都没碰。主仓只动了 `dashboard\board-data.json` 与本文件（外加历史归档一份），未做任何 git 提交。

### 一、第 1 步：Java 21 落地 —— **不需要下载，机器上已有三份**（已证实）

#### 1.1 搜索范围与结果

按任务书指定的位置逐处只读排查：

| 位置 | 结果 |
|---|---|
| `C:\Program Files\Zulu\` | 只有 `zulu-17`（现状那份） |
| `C:\Program Files\Microsoft\` | **`jdk-21.0.6.7-hotspot` ← 命中** |
| `C:\Program Files\Java\`、`C:\Program Files\Eclipse Adoptium\`、`C:\Program Files (x86)\Java\` | 不存在 |
| `D:\javatools\` | 只有 `JDK1.8` / `JRE1.8` / Eclipse / MySQL 等，无 21 |
| `%APPDATA%\.minecraft\runtime\` | **三个运行时，两个命中**（见下表） |
| `D:\MCLDownload\Game\.minecraft`、`D:\我的世界联机\尝试\.minecraft` | 无 `runtime\` 目录 |
| PCL 本体 | 只找到 `D:\BaiduNetdiskDownload\PCL最新正式版`（安装包目录），未在其中发现独立运行时；按红线未打开 PCL 图形界面 |

#### 1.2 三个候选的 `-version` 原样输出（已证实）

**候选 A（推荐并选定）** `C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot\bin\java.exe`

```text
openjdk version "21.0.6" 2025-01-21 LTS
OpenJDK Runtime Environment Microsoft-10800203 (build 21.0.6+7-LTS)
OpenJDK 64-Bit Server VM Microsoft-10800203 (build 21.0.6+7-LTS, mixed mode, sharing)
```

**候选 B** `C:\Users\LENOVO\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\java.exe`

```text
openjdk version "21.0.3" 2024-04-16 LTS
OpenJDK Runtime Environment Microsoft-9388422 (build 21.0.3+9-LTS)
OpenJDK 64-Bit Server VM Microsoft-9388422 (build 21.0.3+9-LTS, mixed mode)
```

**候选 C** `C:\Users\LENOVO\AppData\Roaming\.minecraft\runtime\java-runtime-epsilon\bin\java.exe`

```text
openjdk version "25.0.1" 2025-10-21 LTS
OpenJDK Runtime Environment Microsoft-12574223 (build 25.0.1+8-LTS)
OpenJDK 64-Bit Server VM Microsoft-12574223 (build 25.0.1+8-LTS, mixed mode)
```

（同目录第四份 `jre-legacy` 是 `1.8.0_51`，不合格，记录备查。）

#### 1.3 为什么选 A（合理推断 + 已证实的事实支撑）

- **它是完整 JDK，不是精简 JRE**（已证实）：目录含 `bin conf include jmods legal lib release`，`javac -version` = `javac 21.0.6`。候选 B/C 是 Mojang 分发的运行时，够起服务端，但缺开发件、且**归启动器管** —— 启动器可能在某次更新时替换或清理它们，作为长期基线不可靠
- **主版本正好是 21**（已证实，`Runtime.version().feature()` = 21）。候选 C 是 25，虽然理论上向下兼容，但没有必要引入额外变量
- **官方旁证**（已证实）：Mojang 的 1.21.8 版本 JSON 里 `javaVersion = { component: "java-runtime-delta", majorVersion: 21 }` —— 官方要求就是 major 21，候选 B 正是这个 component 的实体。选 A 与官方要求同代同级

#### 1.4 验收：不止看版本号，实际跑了一段程序（已证实）

```text
> "C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot\bin\java.exe" Probe.java
java.version=21.0.6
java.home=C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot
java.vendor=Microsoft
os.arch=amd64
feature=21
```

（探针源码在临时目录，非仓库文件。用的是单文件源码启动模式，即时编译执行，证明这份 JDK 的编译器与虚拟机都完好、且是 64 位。）

#### 1.5 现有环境无恙复核（已证实）

| 项 | 复核结果 |
|---|---|
| `java -version`（PATH） | 仍是 `openjdk version "17.0.14" ... Zulu17.56+15-CA` —— 未改 PATH |
| `JAVA_HOME` | 仍是 `D:\javatools\jdk1.8` —— 未改 |
| `C:\Program Files\Zulu\` | 仍只有 `zulu-17`，未覆盖未删除 |
| `scripts/mc-server.ps1` | `git status --short` 在 MC-ops 与主仓**均为空**，一字节未改 |
| 注册表 / 安装器 / PCL 图形界面 | **一律未碰**（本轮没有安装动作，无从产生） |
| `D:\javatools\jdk-21\` | **未创建**（用不着，无需解压绿色版） |

#### 1.6 两条施工线怎么用（第 2 轮已确认脚本支持，本轮复核脚本未变）

起服前设一个环境变量即可，**脚本不用改**：

```powershell
$env:MC_SERVER_JAVA = 'C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot\bin\java.exe'
scripts\mc-server.ps1 start
```

依据：`scripts/mc-server.ps1:19-20`

```powershell
$JavaExe = $env:MC_SERVER_JAVA
if (-not $JavaExe) { $JavaExe = 'C:\Program Files\Zulu\zulu-17\bin\java.exe' }
```

不设这个变量时行为完全不变（仍走 Zulu 17），所以**这一步对现有 1.20.1 服务器零影响**，两条线可以各自选各自的 Java、同时在线。

### 二、第 2 步：1.21.8 定案收敛 —— 试验田轮任务书要点终稿

> 修缮线第 4 轮可直接抄。以下每一个数字都在本地或官方元数据里核过。

#### 2.1 定案参数表（已证实）

| 项 | 值 | 来源 |
|---|---|---|
| 目标版本 | **1.21.8**（release，2025-07-17T12:04:02+00:00） | Mojang 官方版本 JSON |
| `server.jar` 下载地址 | `https://piston-data.mojang.com/v1/objects/6bce4ef400e4efaa63a13d5e6f6b500be969ef81/server.jar` | 同上 `downloads.server.url` |
| `server.jar` **SHA1** | `6bce4ef400e4efaa63a13d5e6f6b500be969ef81` | 同上 `downloads.server.sha1` |
| `server.jar` 大小 | `57555044` 字节（约 54.9 MiB） | 同上 `downloads.server.size` |
| 版本 JSON（上面三项的出处） | `https://piston-meta.mojang.com/v1/packages/1873c42e50571bfca4553f980f5ff0f334e78068/1.21.8.json`（自身 SHA1 = `1873c42e…78068`） | 官方 `version_manifest_v2.json` |
| 官方要求的 Java | `component=java-runtime-delta`，`majorVersion=21` | 同上 `javaVersion` |
| 实际要用的 Java | `C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot\bin\java.exe`（21.0.6 LTS） | 本轮第 1 步 |
| **DataVersion** | **4440**（现状 1.20.1 = 3465） | 本地 `minecraft-data` 实查 |
| **协议号** | **772**（现状 1.20.1 = 763） | 本地 `minecraft-data` 实查 |
| 依赖改动 | **零**（第 2 轮已证实全部支持 1.21.8） | 后勤第 2 轮 |

校验命令（下载后核对，Windows 自带）：

```powershell
Get-FileHash .\server.jar -Algorithm SHA1
# 期望 6BCE4EF400E4EFAA63A13D5E6F6B500BE969EF81
```

#### 2.2 版本号写死点复核（已证实，本轮重数）

生产代码 **12 个文件 14 处**（不含测试固定装置）：

```text
bot.js:256                                  version: '1.20.1'   ← 真正连服务器的那一处
port-finder.js:29                           mcProtocol.ping(... version:'1.20.1')
acceptance/adapters/minecraft.adapter.js:35 已支持 MC_VERSION 环境变量兜底，试验田用环境变量即可，无需改代码
workflow/config/acceptance.config.json:21   "version": "1.20.1"
systems/blueprint-selector.js               systems/community-build-collector.js
utils/item-aliases.js                       utils/blueprint-ranking.js
personas/{linxia,sumu,suzu,zhiyu}.js        人设提示词里的「当前在 Minecraft 1.20.1」
```

故意钉死、**不要动**的：`tests/actions.test.js`（19 处固定装置）、`tests/blueprint-version-compatibility.test.js`（15 处，双向断言需要旧版本）、`systems/blueprint-version-compatibility.js`（2 处，是「默认目标版本」的定义位置，随升级一起改一次即可）。

#### 2.3 试验田轮七条验收判据（终稿，逐条给结论）

1. 服务器用 **Java 21** 启动成功，`logs/latest.log` 出现 `Starting minecraft server version 1.21.8`
2. bot 连上，ONLINE-GATE 四信号齐（`MC_PORT` 指定时「找到 MC 服务器」的替代信号是 `[端口] 使用 .env 指定端口: <端口>`）
3. 世界读写正常：挖一块、放一块，读回的方块名与预期一致；世界 `level.dat` 的 DataVersion 变成 **4440**
4. **矮草判定**（本次升级唯一已知代码回归点）：站到草地上下一条移动指令，不应把 `short_grass` 当障碍去挖或绕
5. 下一小段建造（10–20 步），零终态失败
6. `npm test` 全绿，且组数与升级前一致（没有因改版本号而丢组）
7. RCON 优雅停服，世界无损，能再次正常启动

#### 2.4 试验田轮要改的三处（终稿）

1. `bot.js:256` 的连接版本改为读环境变量（默认值先不动，试验田用 `MC_VERSION=1.21.8` 指定）
2. 补 `grass → short_grass` 版本改名对照表（做法与建造线 `a060f0c7` 的 `BLOCK_ITEM_RENAMES` 同型）
3. 补那 **10 处**只认 `grass` 不认 `short_grass` 的可穿过植被判断：
   `actions/build.js:69/5478/5515`、`systems/building-complexity.js:178`、`systems/building-system.js:74/5628/5813`、`systems/building-hard-gate.js:437`、`systems/faithful-community-validator.js:606`、`utils/site-planner.js:22`
   （已两个名字都认的参照写法：`actions/explore.js:321`、`tasks/stuck-recovery.js:6`、`systems/building-system.js:6646`）

**不要做**：不在试验田轮修既有 bug；不碰建造线的服务器、世界、端口；不升 `mineflayer` 等依赖（第 2 轮已证实不需要）；不备份修缮线世界（它是可弃的，这正是当试验田的理由）。

### 三、补上一轮 UNKNOWN：验收夹具的 `/give`、`/setblock` 版本排查 —— **结论：零影响**（已证实，离线静态）

手段：两支离线探针，只读源码文本 + `minecraft-data` 两个版本的注册表，不起服务器。

探针留档：`D:\code\MC-ops\.tmp\ops-fixture-version-audit.js`（逐名对照 + 方块状态属性核对）、`.tmp\ops-fixture-rename-sweep.js`（广谱「旧版有、新版无」扫描），结果 `.tmp\ops-fixture-version-audit.json`。

覆盖：`acceptance/cases/*.js`（7 个用例文件 + utils）、`acceptance/scenario-builder.js`、`acceptance/adapters/*.js`、`acceptance/acceptance-runner.js`、`workflow/config/acceptance.config.json`，共 14 个文件。另已确认 `tests/` 与 `scripts/` 下无任何 `setblock` / `fill` / `give` 夹具命令。

#### 3.1 逐名对照结果

抽出候选名 27 个，在 1.20.1 与 1.21.8 两版注册表逐个核对：

- **方块**：`air / stone / dirt / chest / trapped_chest / barrel / crafting_table / farmland / wheat / water / light / iron_ore / diamond_ore / oak_log` —— **两版皆在**
- **物品**：`oak_planks / spruce_planks / birch_log / stick / torch / coal / bread / cooked_beef / wheat_seeds / glowstone_dust / iron_ingot / iron_axe / iron_pickaxe / iron_shovel / iron_sword / wooden_pickaxe / stone_pickaxe / wooden_sword / crafting_table / chest` 及全部锄类 —— **两版皆在**
- **方块状态属性**逐条核（`chest[facing=north,type=left|right]`、`wheat[age=7]`、`light[level=15]`）：属性名与取值在 1.21.8 下**全部合法**，零问题
- 探针初报的 7 个「两版皆无」经人工复核**全部是误报**：`zombie/skeleton/creeper/spider/item` 是 `kill @e[type=…]` 的**实体名**（两版注册表实查均在）、`saturation` 是 `effect give` 的**状态效果名**（两版均在）、`glowstone_dust` 被探针误分类为方块（它是物品，两版均在）

#### 3.2 广谱改名扫描

对同样 14 个文件做「凡是 1.20.1 认得而 1.21.8 不认得的名字」全量扫描（方块 + 物品 + 实体 + 效果 + 生物群系）：

```text
=== 1.20.1 有、1.21.8 无 的名字 ===
（无）

=== 抽样核对 grass / short_grass 在夹具里的出现 ===
（无）
```

探针自身可信度已验证：单独查 `grass` 确实是「1.20.1 有 / 1.21.8 无」（`short_grass` 反之），说明扫描器能抓到这类改名，只是夹具里根本没有用到 `grass`。

#### 3.3 唯一的间接口子（合理推断，需在真机确认）

建造用例的地基/清场是 `fill … ${blockName}`，`blockName` 来自**蓝图的材料表**而非写死的名字（`acceptance/cases/building.acceptance.js:912-921`，发料走 `splitMaterialsForScenario`）。所以「夹具本身零改名风险」成立，但**如果拿一份含 `grass` 的蓝图跑验收**（pirbaba 那份 22 块、mcbuild 那份 6 块），夹具会照着蓝图发出 `minecraft:grass`，在 1.21.8 下失败。这不是夹具的问题，正是 2.4 第 2 条那张改名对照表要解决的问题 —— 对照表补上后此口子随之关闭。

### 四、第 3 步：看板更新（已完成）

改前已备份到 `D:\code\MC-ops\.tmp\board-data.backup-ops-round3.json`（更新脚本 `.tmp\ops-round3-board-update.js` 同处，两者都放在本线自己的工作区，主仓不留额外文件）。

| # | 条目 | 改动 | 依据 |
|---|---|---|---|
| 1 | `u01` 纸上预研 | 改写为「已收官」：定案 1.21.8、Java 已落地、试验田稿子备齐、夹具排查干净 | 老板拍板 + 本轮 |
| 2 | `u02` 试验田 | 注明**前置已解除**（Java 不用装了），任务书要点终稿位置，附带提醒矮草改名这个唯一回归点 | 本轮 |
| 3 | `u03` 正式升 | 补「完工定义已拍板（草皮豁免）→ 建造线落实后本步解冻」 | 建造线第 8 轮任务书 0 节 |
| 4 | `b04` 草方块 | 性质改写：从「缺料」改成「图纸与游戏规则打架」，写入 98.42% vs 98.5% 的数学上限与您的豁免裁决 | 建造线第 6/7 轮反馈 + 老板拍板 |
| 5 | `f01` 洼地死循环 | 补 2026-08-31 进展：修缮线第 2 轮已交「脱困台账 + 垫方块」并入库，真机复跑待验 | 建造线第 8 轮任务书（提交 9130ac5） |
| 6 | `f02` 清障闭眼直走 | **P1 → P0**，注明是修缮线下一轮主攻方向「找路不避坑」 | 老板 2026-08-31 拍板 |
| 7 | `x02` 别墅孤本 | 补「完工归档在望，届时按第 6 轮思路重评估全量禁令；在那之前禁令与两份备份原样挂着」 | 老板草皮豁免拍板 |
| 8 | **新增 `d21`** | 「新版本 Java 不用装：这台电脑上本来就有，挑了最稳的一份」 | 本轮 |
| 9 | **新增 `d22`** | 「网页看她干活：方案取消，改用游戏客户端旁观」 | 老板 2026-08-31 拍板 |
| 10 | **新增 `d23`** | 「素材进库前先问一句『新版本里这方块改名了没』」（含夹具排查结论） | 本轮 |
| 11 | 顶层 `updatedAt` / `note` | 校正到 2026-08-31 晚，写明同日四项拍板与直播取消 | — |

**离线校验结果**（本轮红线更严，**未起 HTTP 实例**，改用与 `dashboard/server.js:380 loadBoard()`、`dashboard/app.html:367 STATUS` 同口径的离线校验）：

```text
JSON 合法: yes
组/条: 8 / 53          （上轮 8 / 50）
已完成/未完成: 28 / 25
P0 未完成: b02, b03, b04, u02, f01, f02
非法状态: 无   非法优先级: 无   重复 id: 无   字段缺失: 无
```

三条线的进度条是 `dashboard/lanes.js` 每次访问时自动读各线 `CC反馈.md` 生成的，不需要人工同步，本文件写完即生效。离线调用 `lanes.collectLanes()` 实测（未起 HTTP）：后勤 = 第 3 轮 / 已完成（本文件），建造 = 第 7 轮 / 卡住了，修缮 = 第 1 轮 / 已完成。

**顺带发现一个看板的准确性问题（已证实，本轮未改）**：修缮线自第 2 轮起把 `CC反馈.md` 搬到了自己的 worktree（主仓 `docs/协作/修缮/给CC.md` 只剩指路条），但 `dashboard/lanes.js:37` 只扫主仓的 `docs/协作/<线名>/`，**所以看板上「修缮线」那一格会永远停在第 1 轮 / 2026-08-30**，不会再更新。要修得让 `lanes.js` 去读 `D:\code\MC-fix` 下的文件 —— 那超出本线红线（禁碰 `MC-fix`），所以本轮只报不改，请开发定：要么授权后勤线读 MC-fix 的那一个文件，要么请修缮线每轮往主仓同步一份。

## 按 AGENTS.md 第 11 节

### 1. 读过的文件

主仓：`docs/协作/说明.md`、`docs/协作/后勤/{说明,给CC,CC反馈}.md`、`docs/协作/建造/{给CC（第 8 轮）,CC反馈（第 7 轮）}.md`、`docs/协作/修缮/给CC.md`（指路条）、`dashboard/{board-data.json,server.js,app.html,lanes.js}`；

MC-ops：`AGENTS.md`、`package.json`、`bot.js`、`port-finder.js`、`scripts/mc-server.ps1`、`workflow/config/acceptance.config.json`、`acceptance/cases/*.js`、`acceptance/scenario-builder.js`、`acceptance/adapters/minecraft.adapter.js`、`node_modules/minecraft-data`（只读注册表）；

只读环境探查：`C:\Program Files\{Zulu,Microsoft}`、`%APPDATA%\.minecraft\runtime\*`、`D:\javatools\`、`D:\MCLDownload\`、`D:\我的世界联机\`。

### 2. 改动的文件

**主仓（授权的两处，只改文件不提交）**

| 文件 | 改动 |
|---|---|
| `dashboard/board-data.json` | 11 处（对照清单见技术细节四），现 8 组 53 条 |
| `docs/协作/后勤/CC反馈.md` | 本文件（第 2 轮原文已整份挪至 `docs/协作/历史/后勤第2轮-升级预研与版本闸门.md`） |
| `docs/协作/历史/后勤第2轮-升级预研与版本闸门.md` | 新增（归档，只增不删） |

**MC-ops**：**零代码改动、零提交**（按任务书要求与建造线第 8 轮合并轮错开）。只在未跟踪的 `.tmp/` 下新增两支一次性探针 `ops-fixture-version-audit.js`、`ops-fixture-rename-sweep.js` 与结果 JSON。

**系统层面**：无。未安装、未下载、未改注册表、未改 `JAVA_HOME`、未改 PATH、未动任何现有 Java。

### 3. 执行的命令

`git status --short` / `git log --oneline -10` / `git branch --show-current`（MC-ops）、`npm test`（MC-ops）、
`java -version` ×5（PATH 一次 + 四个候选各一次）、`javac -version`、单文件探针类执行 ×1、
`node .tmp/ops-fixture-version-audit.js`、`node .tmp/ops-fixture-rename-sweep.js`、若干 `node -e` 只读查询、看板更新脚本 + 离线校验脚本、只读目录列举与 `grep`。
网络：只读取 Mojang 官方 `version_manifest_v2.json` 与 `1.21.8.json` 两份元数据。

未执行：`npm install/ci/update`、任何 `syncCommunityBlueprints`（全量与 `--only` 均无）、任何服务器/bot/端口/RCON 操作、`node dashboard/server.js`、`git add -A` / `git stash` / `git reset` / `git clean` / `git checkout --`、任何安装器、对 `D:\code\MC-fix` 与 `D:\code\MC` 的任何访问、对门楼条目的任何操作。

### 4. 测试结果

| 时点 | 命令 | 结果 |
|---|---|---|
| 开场 | `npm test`（MC-ops，43 组） | **退出码 0，全绿** |
| 收尾 | 无代码改动，未重跑 | — |

（本轮零代码改动，开场那次即为本轮的回归基线；`git status --short` 在 MC-ops 收尾时仍只有 `.tmp/`、`data/community-builds/cache/` 两个未跟踪项，与开场一致。）

### 5. 当前最新判定

- **第 1 步 Java 21：完成，且完全没有产生安装动作**（已证实）。选定 `C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot\bin\java.exe`（21.0.6 LTS，完整 JDK，实跑验证）；备选两份在 `.minecraft\runtime\`。现有环境逐项复核无恙
- **第 2 步 1.21.8 定案：完成**（已证实）。下载地址 + SHA1 + 大小 + DataVersion 4440 + 协议 772 + Java 路径 + 七条判据 + 三处要改的代码，齐了，修缮线可直接开工
- **补 UNKNOWN 夹具排查：完成，结论零影响**（已证实，离线静态）。唯一间接口子是「蓝图里带 `grass` 时夹具会照着发」，由改名对照表覆盖
- **第 3 步看板：完成**（11 处，8 组 53 条，离线校验通过）

### 6. 生成文件 / 内存是否变脏

主仓 `data/memory/*` 与 `acceptance/reports/latest-*` 本轮**未触碰**（`git status` 里那些改动来自另外两条线）。`dashboard/` 在主仓是未跟踪目录，改完即生效，改前备份在 `D:\code\MC-ops\.tmp\board-data.backup-ops-round3.json`（本轮在主仓只写了授权的两处 —— `dashboard\board-data.json` 与 `docs\协作\后勤\`，外加一份历史归档，未在主仓留任何临时文件）。

MC-ops：`data/community-builds/cache/` 本轮**一字节未动**（没跑任何 sync）；`.tmp/` 新增两支探针与结果 JSON，均未跟踪。

### 7. 是否建议提交

MC-ops 本轮**无可提交内容**（零代码改动，刻意与建造线第 8 轮合并轮错开）。主仓两处按本线协议只改不提交；`docs/协作/后勤/CC反馈.md` 与历史归档建议随合并轮或建造线的文档提交一并入库。

### 8. 剩余风险

- **选定的那份 Java 是「本来就在机器上」的，来源未经我安装**（已证实其版本与可执行性，但**它是谁装的、会不会被别的软件卸载，UNKNOWN**）。若某天它消失了，备选是 `.minecraft\runtime\java-runtime-delta`（21.0.3），再不济才需要下绿色版 —— 本轮没有为此预先下载任何东西
- **`server.jar` 的 SHA1 是从官方元数据读来的，本轮没有下载 jar、因而没有实际比对过**（红线所限）。下载者必须自己核一次哈希（命令见 2.1）
- **矮草改名的代码影响面（10 处）至今只有静态定位，零真机证据**（UNKNOWN）。试验田轮第 4 条判据就是为它设的
- **1.21.8 的游戏机制变化对真机行为的影响完全没有证据**（UNKNOWN，本线定位使然）。试验田轮存在的意义就是先在可弃世界上撞一遍
- 新闸门生效后，对门楼条目跑 `--only` 会把它从索引剔除（设计意图；升级完成前禁止触发）。本轮**未触发**
- 建造线第 8 轮正在做三线合并，`feat/ops` 的 HEAD 本轮未动（仍 `3d1fa406`），**不会给合并带来任何新增冲突面**；上一轮提醒的 `package.json` 依赖冲突在建造线删掉网页直播依赖后自行消失
- **看板上「修缮线」那一格从第 2 轮起就不再更新了**（已证实，原因见技术细节四末尾）。这不影响任何施工，但会让看板对修缮线的进度显示长期滞后，需要开发拍一下怎么补
- 别墅孤本禁令与两份缓存备份**原样挂着**，本轮未动
