# Minecraft AI Companion 总体验收清单

本清单用于真实 Minecraft 环境验收。目标是验证完整链路：

```text
中文输入 -> router -> actionKey -> intent-to-task -> TaskManager -> Action Lock -> 对应系统 -> 玩家反馈/日志
```

验收前建议先启动新日志会话，保留 `logs/bot-current.log` 和 `logs/acceptance-report.md`。每个用例失败时，优先按“日志关键词”搜索真实链路，不要只看聊天回复。

## 运行命令

```powershell
npm test
$env:VOICE_ENABLED="false"; npm run dev:acceptance
```

如果项目里有 watcher 脚本，可运行：

```powershell
npm run watch:acceptance
```

如果没有 watcher，直接查看：

```text
logs/bot-current.log
logs/acceptance-report.md
```

## 通用日志关键词

每条执行型命令都建议检查：

```text
[router] input=... actionKey=... confidence=...
[intent-to-task] actionKey=... task=... params=...
[execution-check] actionKey=... shouldExecute=... enqueued=... started=... failReason=...
[task-manager] enqueue/start/pause/interrupt/resume/complete/fail task=... reason=...
[action-lock] acquire/release type=... owner=... result=...
```

## 1. 状态查询

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| get_task_status | 让 bot 有一个当前任务或空闲均可 | `你现在在干嘛` | 返回当前任务、危险等级、背包空槽等状态 | 被当成聊天；没有 task 状态 | `[router]`, `GET_STATUS`, `[intent-to-task]`, `action=status`, `[task-manager]` |
| 背包查询 | bot 背包放入多种物品 | `你背包里有什么` | 返回 bot 自己背包汇总和空槽 | 只回聊天；说玩家背包；无物品列表 | `CHECK_INVENTORY`, `[inventory] action=check`, `inventoryState`, `emptySlots` |
| 防具查询 | bot 穿或携带部分防具 | `检查一下防具` | 返回 helmet/chestplate/leggings/boots 和缺失槽位 | 只返回 survivalState；没有 armorState | `CHECK_ARMOR`, `[armor] current=`, `available=`, `armorState` |

## 2. 防具 / 战斗

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 从箱子拿装备穿上 | 附近箱子放防具，bot 有权限打开 | `从箱子里拿装备穿上` | 进入 storage，按 `category:armor` 取出并装备 | 把“装备”当 itemName；进入 Crafting | `FETCH_AND_EQUIP_ARMOR`, `[storage] request=withdraw category=armor`, `[armor]` |
| 准备战斗 | bot 背包有武器/食物/防具，或材料可合成武器 | `准备战斗` | 进入 prepare_combat，检查武器、防具、食物 | 进入 `CRAFT_ITEM targetItem=准备战斗` | `PREPARE_COMBAT`, `[equipment] request=prepare_combat`, `[crafting] skipped=true` |
| 打僵尸 | 6-10 格内放僵尸，bot 有武器更好 | `打僵尸` | 进入 guard/combat，主动攻击僵尸 | 只聊天；不选武器；只挨打 | `ATTACK_HOSTILE`, `[combat] target=zombie`, `selectedWeapon`, `action=attack` |
| 第二只僵尸重复触发 | 第一只死后再刷第二只僵尸 | `打僵尸` 或等待主动防御 | 再次扫描并攻击新僵尸 | 第一次能打，第二次无反应 | `[combat] hostileDetected=`, `target=`, `[survival] dangerLevel`, `combatInterruptReason` |

## 3. 砍树

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 砍树 | bot 附近有树 | `砍树` | 进入 mining/tree，砍 1 棵树 | 只砍 1 个原木就结束；没用斧头 | `MINE_BLOCK`, `[tree] mode=tree_count`, `targetTreeCount=1`, `choppedLogCount` |
| 砍5个木头 | 附近有至少 5 个原木 | `砍5个木头` | 砍够 5 个 log 后停止 | 按 5 棵树理解；只砍一个 | `[tree] mode=log_count`, `targetLogCount=5`, `choppedLogCount=5` |
| 砍2棵树 | 附近有至少 2 棵树 | `砍2棵树` | 砍 2 棵完整树或尽量完整树干 | 按 2 个木头理解 | `[tree] mode=tree_count`, `targetTreeCount=2`, `result=` |
| 无树区域砍树 | 周围无树 | `砍树` | 明确反馈没有可达树或没有目标 | 静默不动；任务卡住 | `[tree]`, `no_reachable_block`, `nearby_tree_not_found`, `[task-manager] fail` |
| 被僵尸打断后恢复 | 砍树时刷近距离僵尸 | 自动或 `打僵尸` | 暂停砍树，战斗后恢复/重新扫描 | 继续砍不防御；打完不恢复 | `[task-manager] pause`, `[combat]`, `[task-manager] resume`, `[tree]` |

## 4. 挖矿

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 挖石头 | 附近有 stone，bot 有镐最好 | `挖石头` | 选择 pickaxe，挖多个普通石头 | 只挖一个；工具选择错 | `[mining] inputTarget=stone`, `selectedTool`, `minedCount`, `result=` |
| 挖沙子 | 附近有 sand | `挖沙子` | 选择 shovel 或徒手，允许挖 | 误判必须工具；静默失败 | `[mining] inputTarget=sand`, `preferredTool=shovel`, `selectedTool`, `result=` |
| 挖点铁矿 | 附近有 iron/deepslate iron，bot 有石镐以上 | `挖点铁矿` | 识别 iron_ore/deepslate_iron_ore，尽量挖附近同类 | 只挖一个；不识别深层矿 | `FIND_ORE`, `resolvedTarget=iron_ore`, `deepslate_iron_ore`, `minedCount` |
| 挖一个铁矿 | 附近有铁矿 | `挖一个铁矿` | 只挖 1 个铁矿 | 继续挖太多；或没行动 | `count=1`, `[mining]`, `minedCount=1` |
| 挖3个铁矿 | 附近有 3 个铁矿 | `挖3个铁矿` | 挖到 3 个或无可达目标为止 | 只挖 1 个；不重新扫描 | `count=3`, `remainingNearbyTargets`, `minedCount=3` |
| 挖钻石矿 | 附近有 diamond/deepslate diamond，bot 有铁镐以上 | `挖钻石矿` | 选择铁镐及以上，挖可达钻石矿 | 木镐/石镐误挖；只挖一个 | `diamond_ore`, `requiredTool=iron_pickaxe_or_better`, `selectedTool`, `wrong_tool_type`, `minedCount` |

## 5. 合成

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 做木棍 | 背包有原木或木板 | `做木棍` | 进入 Crafting，必要时递归做木板 | 进入 Storage/Farming；无递归计划 | `CRAFT_ITEM`, `[crafting] targetItem=stick`, `recursivePlan`, `result=` |
| 做火把 | 背包有煤和木棍，或可做木棍 | `做火把` | 合成 torch | 不找材料；误当聊天 | `[crafting] targetItem=torch`, `missingMaterials`, `recursivePlan` |
| 做箱子 | 背包有足够木板或原木 | `做箱子` | 递归木头->木板->箱子 | 说无配方；不递归 | `[crafting] targetItem=chest`, `recursivePlan`, `result=` |
| 做铁剑 | 背包有铁锭和木棍 | `做铁剑` | 进入 `CRAFT_ITEM itemName=iron_sword` | 被准备战斗规则吞掉 | `CRAFT_ITEM`, `iron_sword`, `[crafting]` |
| 做面包 | 背包或箱子有小麦 | `做面包` | 进入 Farming/Crafting 既有面包链路，成功做 bread | 说没农场但背包有小麦 | `MAKE_BREAD` 或 `bread`, `[crafting]`, `[farming]`, `wheat` |

## 6. 吃东西 / 人称

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 吃东西 | bot 背包放 bread/cooked_beef | `吃东西` | 进入 EatTask，优先吃背包食物 | 去找农场；说没找到农场 | `EAT_FOOD`, `[food] action=eat`, `selectedFood`, `result=` |
| 你饿了就吃 | 降低 bot 饥饿或模拟低 food | `你饿了就吃` | 目标是 bot 自己吃，`statusOwner=bot` | 理解成玩家状态 | `EAT_FOOD`, `statusOwner=bot`, `[survival] owner=bot` |
| 低血量反馈 | 让 bot 受伤至低血量 | 自动 survival 反馈 | 使用“我的血量太低了” | 说“你的血量太低了” | `[survival] health=`, `owner=bot`, `[response] statusOwner=bot` |
| 低饥饿反馈 | 降低 bot 饥饿值 | 自动或 `你饿了就吃` | 使用“我快饿了/我先吃点东西” | 说“你快饿了” | `[survival] food=`, `[food]`, `[response] statusOwner=bot` |

## 7. 捡东西

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 捡起来 | 附近丢一个物品 | `捡起来` | 移动到物品附近并拾取 | 只聊天；不移动 | `PICKUP_ITEM`, `[pickup] item=`, `move_to_item`, `result=` |
| 拿着这个 | 玩家准星/附近有掉落物 | `拿着这个` | 识别附近掉落物并拾取 | 误入 Storage 取物 | `PICKUP_ITEM`, `[pickup]`, `selectedItem` |
| 把地上的东西捡了 | 附近有多个掉落物 | `把地上的东西捡了` | 进入 pickup nearby，尽量捡附近物品 | 只捡一个或无反馈 | `PICKUP_NEARBY_ITEMS`, `[pickup]`, `count`, `result=` |

## 8. Storage 分类

| 项目 | 测试前准备 | 玩家输入 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 木头分类 | 背包有 oak_log、birch_log、spruce_planks | `把木头放箱子里` | `category:wood`，全部木材入箱 | 只存 oak_log | `[item-alias] input="木头" resolved=category:wood`, `[storage] mode=deposit category=wood`, `matchedItems` |
| 原木分类 | 背包有 logs 和 planks | `把原木放箱子里` | 只存 `*_log` / stripped logs | 把木板也存了 | `category=logs`, `matchedItems`, `deposited` |
| 木板分类 | 背包有 logs 和 planks | `把木板放箱子里` | 只存 `*_planks` | 把原木也存了 | `category=planks`, `matchedItems`, `deposited` |
| 食物分类 | 背包有多种普通食物 | `把食物放箱子里` | 按 food 分类存入 | 只存某一种食物 | `category=food`, `[storage] mode=deposit`, `matchedItems` |
| 种子分类 | 背包有 wheat_seeds 等种子 | `把种子放箱子里` | 存入种子或明确不支持分类 | 静默不动 | `[router]`, `itemName=wheat_seeds` 或 `category=seeds`, `[storage] result=` |
| 工具分类 | 背包有多种工具 | `把工具放箱子里` | 按 tool 分类处理，注意不要存关键工具或明确说明 | 把所有关键工具都清空且无说明 | `category=tool`, `[storage]`, `critical`, `result=` |
| 装备分类 | 背包有防具 | `把装备放箱子里` | 按 armor/equipment 分类处理 | 把“装备”当具体 itemName | `category=armor` 或 `equipment`, `[storage]`, `[armor]` |

## 9. Return / Follow

| 项目 | 测试前准备 | 玩家离 bot 有一定距离 | 预期行为 | 失败表现 | 日志关键词 |
| --- | --- | --- | --- | --- | --- |
| 过来找我 | bot 离玩家 5 格以上 | `过来找我` | 进入 return/follow，移动到玩家附近 | 只聊天；不打断低优先任务 | `RETURN_TO_PLAYER` 或 `FOLLOW_PLAYER`, `[return-to-player] target=`, `pathStatus`, `result=` |
| 回来找我 | bot 正在挖矿/砍树更好 | `回来找我` | 中断当前可中断任务，回玩家身边 | 文字回应但继续原任务 | `[TASK_INTERRUPT_FOR_PLAYER_MOVEMENT]`, `[task-manager] interrupt`, `[return-to-player]` |
| 跟着我 | 玩家移动 | `跟着我` | 进入 follow_player 并持续跟随 | 只走一次就停；被普通任务永久打断 | `FOLLOW_PLAYER`, `[task-manager] enqueue/start task=follow_player`, `distance`, `pathStatus` |

## 失败时必须收集

请复制或保留以下内容：

```text
1. 玩家原始输入和时间点
2. logs/bot-current.log 中该输入前后 200 行
3. logs/acceptance-report.md 最新失败段落
4. [router] / [intent-to-task] / [execution-check] / [task-manager] / [action-lock] 相关行
5. 对应系统日志，例如 [mining]、[tree]、[storage]、[food]、[combat]、[crafting]
6. 游戏内实际现象：是否移动、是否打开箱子、是否装备、是否攻击、是否挖掘、是否聊天反馈
```
