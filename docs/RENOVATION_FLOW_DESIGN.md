# Renovation Flow Design (已批准,附两个批准条件)

Status: APPROVED WITH CONDITIONS 2026-07-03 — 用户批准本设计,附下述两个批准
条件;条件写入本文档并提交后设计正式生效。Originally written 2026-07-03 for the
pending L3 cabin renovation (stair relocation + gabled roof, new blueprint hash
`simple_two_story_cabin` post-`a90e0416`).

## 批准条件(2026-07-03,随批准写入,具有与红线同等效力)

1. **中途放弃的脏基线条款**:R_new 中途放弃(`ABANDONED`)时,R_old 必须同时
   标记"翻新中断,diff 已知脏"(dirty-diff 标记,状态字段纪律)。此后 R_old
   的 strict WorldDiff 非零**不算保护失效**,也不构成任何补救施工的理由;脏
   diff 只能通过**再次翻新**(新 R_new' 按对账式增量施工)收敛。**禁止手工
   补块把 R_old 的 diff 洗绿**——洗绿等同伪造验收历史。
2. **链一跳封顶是授予时硬检查,非文档约定**:豁免授予代码在授予时必须硬性
   验证 renovationOf 链恰好一跳(R_new → R_old 且 R_old 无进一步被豁免的
   承继指向被利用),链长 >1 或任何传递性豁免请求一律拒绝并记日志。不允许
   以"文档写了一跳封顶"代替代码检查。

## 问题定义

一栋 COMPLETED 建筑(run R_old,hash H_old)需要按修订后的蓝图(hash H_new)
改造。现状约束:

- R_old 已入保护名册:任何非 R_old 豁免的挖掘被硬守卫拒绝。
- `decideConstructionRunStart` 对同址新蓝图:`blueprintMatchingBlocks > 0`
  → 强制 RECONCILIATION,fresh 不可旁路(红线,本设计不动它)。
- resume 路径要求 hash 兼容:R_old 的冻结 IR 是 H_old,无法直接按 H_new 施工。

## 设计:RENOVATION run(新 run 类型,显式承继)

### 1. run 记录与新蓝图的绑定

新建 run R_new,新增字段:

```
renovationOf: R_old.runId          // 显式承继指针
renovationBaseHash: H_old          // 改造起点的蓝图 hash
blueprintHash: H_new               // 目标蓝图(冻结 IR 为 H_new 全量)
```

R_old 保持不变、不删除、不改状态(它仍是历史验收记录的锚点)。R_new 的编译
以 H_new 全量蓝图 + 现场实测(reconciliation 扫描)为输入:与 H_old 一致且
H_new 不变的方块 → `verified`(不动);H_new 移除的 → `renovation_clear`
步骤;H_new 新增/改状态的 → `place`/`state_repair` 步骤。即"对账式增量施工",
不是拆了重来。

### 2. RECONCILIATION 硬规则的关系(不旁路)

`blueprintMatching > 0 → RECONCILIATION` 语义是"该场地有属于某蓝图的既有
结构,禁止 fresh 覆盖"。RENOVATION 不是 fresh:入口显式携带
`renovationOf=R_old`,决策层新增分支:

```
if (options.renovationOf) {
  验证 R_old 存在、terminalState=COMPLETED、bounds 与新蓝图 bounds 重叠
  验证现场 blueprintMatching 方块主要匹配 H_old(承继对象正确,不是别人的建筑)
  → decision = 'renovation_of_completed_run'(新决策值,全程留日志)
}
```

fresh/escape-hatch 路径原样不动;没有 `renovationOf` 时行为与今天完全一致。
换言之:硬规则依旧拦住所有"不承认既有建筑"的路径,翻新是一条新的、显式承认
既有建筑的路径。

### 3. 保护豁免的复用

守卫豁免仍按 region-runId 精确匹配,不加全局开关。执行期:

- `building-system.executeStep` 发布 `context.activeConstructionRunId = R_new.runId`。
- 保护名册查询时,若命中区域的 runId ∈ {R_new.runId, R_new.renovationOf},
  且当前活跃 run 的 renovationOf 指向该区域 runId → 豁免放行,日志
  `[PROTECTED_BUILDING_DIG_EXEMPT] ... via=renovationOf`。
- 即豁免链最多一跳(R_new → R_old),不可传递;其他 COMPLETED 建筑照常拒绝。
- 一跳封顶按批准条件 2 在豁免授予代码中硬检查,不是文档约定。

### 4. 翻新验收标准

- 完工判定:R_new 全步 verified → `terminalState=COMPLETED`。
- strict WorldDiff 以 **H_new** 冻结 IR 为期望,标准与新建一致
  (missing/wrong/criticalWrongStates = 0/0/0,extra/scaffold = 0,宜居硬闸门
  对真实方块全过——含身宽楼梯判定)。
- R_new COMPLETED 后自动入保护名册;**名册去重**:同一空间两条 COMPLETED
  (R_old 与 R_new)时,以 `renovationOf` 链的最新一代为准生成单一保护区域
  (实现:roster 提取时,被 `renovationOf` 指向且指向者已 COMPLETED 的 run
  不再单独入册——防止豁免语义混乱)。
- 旧验收记录标记:R_old 增加一个状态字段 `supersededByRenovation: R_new.runId`
  (仅此一个字段,逐字节纪律同僵尸收敛;在 R_new 落 COMPLETED 的同一会话内
  补记)。历史报告/交接文档不改写,新增状态段说明"H_old 验收由 H_new 翻新
  验收承继"。

### 5. 中途失败的回滚/续建语义

- **默认:续建(前滚)**。R_new 持久化每步状态,崩溃/中断后 resume 走既有
  reconciliation:世界实测重算 verified/pending/repair,从断点继续。翻新的
  中间态(部分旧、部分新)对对账是普通的"部分完成"。
- **不提供自动回滚**。回滚 = 按 H_old 再翻新一次(R_rollback.renovationOf =
  R_new),是显式的新决策而非隐式恢复;拆除的旧方块材料在翻新步骤中回收入
  暂存箱,材料账随 run 持久化,保证前滚/回滚都有料可用。
- 失败终态:R_new 若被放弃 → `ABANDONED`(带 reason)。此时保护名册回落到
  R_old(去重规则只在 R_new COMPLETED 时生效),半翻新现场由 R_old 的保护
  区域继续覆盖(bounds 并集由名册去重逻辑在 R_new 活跃期间临时并入——活跃
  RENOVATION run 的 bounds 并入其承继区域,防止翻新期间第三方挖掘)。
- 放弃同时按批准条件 1 给 R_old 打"翻新中断,diff 已知脏"标记:脏 diff 不算
  保护失效,只能通过再次翻新收敛,禁止手工补块洗绿。

### 6. 待实现清单(批准后另行排期)

1. run store:`renovationOf`/`renovationBaseHash`/`supersededByRenovation`
   字段 + schema 校验 + 单测。
2. `decideConstructionRunStart`:`renovation_of_completed_run` 分支 + 决策
   日志 + 拒绝条件(承继对象非 COMPLETED / bounds 不重叠 / 现场不匹配 H_old)
   单测。
3. protected-buildings:roster 去重 + renovationOf 豁免一跳 + 活跃翻新期
   bounds 并入,单测(同 runId 放行/异 runId 拒绝/链不传递)。
4. 编译器:renovation_clear 步骤类型(拆除并回收材料入暂存箱)。
5. 离线预检脚本:翻新计划的 clear/keep/place 三分类统计 + canonical 相位序
   模拟。
6. L3 木屋实地翻新施工(单独会话,纯生存,strict WorldDiff 以 H_new 收口)。

## 红线自检

- 不旁路 `blueprintMatching → RECONCILIATION`:翻新是显式新分支,fresh 语义
  未动。
- 无全局保护开关:豁免仍按 runId,链一跳封顶。
- R_old 记录只加一个承继标记字段(状态字段纪律),历史验收不改写不作废。
- 本文档为纯设计:未写 run store,未动世界方块。
