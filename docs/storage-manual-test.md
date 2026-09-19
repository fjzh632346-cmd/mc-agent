# Storage / Chest 手动验收说明

本说明用于真实 Minecraft 环境验收 Storage / Chest 系统。目标是确认仓库任务通过 `command-router -> intent-to-task -> StorageTask -> TaskManager -> actions/storage` 执行，不绕过 TaskManager，不让 LLM 直接操作 Mineflayer API。

## 1. 测试前准备

1. 启动 Minecraft 服务器和 bot。
2. 确认 bot 已进入游戏，玩家能通过现有语音或文本指令控制 bot。
3. 在玩家和 bot 附近放置至少 1 个普通箱子。
4. 可选：并排放置两个箱子组成双箱子，用于确认双箱子至少不会崩溃。
5. 给 bot 背包放入一些可存储物品，例如 `cobblestone`、`dirt`、`oak_planks`。
6. 给箱子里放入一些可取出的物品，例如 `oak_log`、`torch`、`iron_ingot`、`bread`。
7. 先在安全区域测试，避免怪物、岩浆、掉落等干扰路径和开箱。

## 2. 需要放置的箱子

- 普通箱子：放在 bot 4 格以内，用于基础开箱、存取物品测试。
- 远一点的箱子：放在 bot 5 到 12 格附近，用于验证距离太远时会先移动再开箱。
- 双箱子：两个普通箱子并排放置，用于确认 `openChest/openContainer` 打开后存取不会崩溃。

## 3. 需要给 bot 的物品

建议给 bot：

- `cobblestone` 64 个
- `dirt` 64 个
- `oak_planks` 16 个
- `stick` 8 个
- `stone_pickaxe` 1 把
- `bread` 或其他安全食物若干

非必要物品测试时，系统应优先存入圆石、泥土等杂物，并保留工具、武器、食物、火把和少量常用材料。

## 4. 玩家测试指令与预期结果

### 4.1 记住附近箱子

玩家说：

- `记住这个箱子`
- `这里是箱子区`
- `这是仓库`

预期：

- 识别为 `REMEMBER_CHEST`。
- 创建 `StorageTask`，通过 TaskManager 执行。
- world-memory 中记录 chest / storage 位置。
- 若附近没有箱子，应失败并返回明确原因，例如 `no_chest_nearby` 或 `chest_not_found`。

### 4.2 查询记住了哪些箱子

玩家说：

- `你记得哪些箱子`
- `箱子里有什么`
- `仓库里有没有铁`

预期：

- 识别为 `CHECK_STORAGE`。
- 如果查询记忆，能返回已记录箱子位置。
- 如果查询箱子内容，bot 会打开已记住或附近的箱子并读取内容。
- 如果没有已知箱子，应返回明确原因，不应随机乱跑。

### 4.3 存入背包物品

玩家说：

- `把东西存起来`
- `整理一下背包`
- `把圆石放箱子里`
- `把没用的东西放仓库`

预期：

- 识别为 `STORE_ITEMS`。
- 创建 `StorageTask`，不直接调用 Mineflayer API。
- 若箱子较远，先移动到可开箱距离。
- 成功后指定物品或非必要物品进入箱子。
- 任务结束后释放 `movement` / `inventory` lock。

### 4.4 从箱子取出指定物品

玩家说：

- `帮我拿点木头`
- `从箱子里拿铁锭`
- `去仓库取几个火把`
- `拿一些食物出来`

预期：

- 识别为 `TAKE_ITEMS`。
- 打开箱子后调用窗口 `withdraw` 取物。
- 箱子里有对应物品时，物品进入 bot 背包。
- 箱子里没有对应物品时，任务失败并返回明确缺失物品。

### 4.5 背包满时自动回箱子存非必要物品

准备：

1. 给 bot 背包装满圆石、泥土等非必要物品。
2. 确保附近或 memory 中已有箱子。
3. 等待 Goal System / Tick Loop 检测背包状态，或直接说 `整理一下背包`。

预期：

- 自动触发或手动触发 `STORE_ITEMS`，mode 应为 `nonEssential`。
- 不应丢弃重要物品。
- 不应自动拆玩家建筑获取箱子或材料。

### 4.6 dangerLevel 高时拒绝或暂停开箱

准备：

1. 在附近制造危险，例如怪物靠近，或用调试方式把 `dangerLevel` 设为高。
2. 再说 `把东西存起来` 或 `从箱子里拿铁锭`。

预期：

- Storage 动作拒绝或暂停。
- 失败原因应包含 `danger_too_high` 或等价说明。
- 不应继续打开箱子。
- 已持有的 `movement` / `inventory` lock 必须释放。

### 4.7 pause / resume / interrupt

测试方式：

1. 让 bot 执行一个需要移动到箱子的 `STORE_ITEMS` 或 `TAKE_ITEMS`。
2. 在移动或开箱前触发暂停，可通过现有任务管理调试接口、优先级更高任务，或项目已有暂停指令完成。
3. 再触发恢复。
4. 最后用 `停下`、`取消任务` 或项目已有中断指令打断任务。

预期：

- pause 后 StorageTask 不应继续存取物品。
- resume 后可以继续执行或重新尝试当前 StorageTask。
- interrupt 后任务结束，箱子窗口关闭，lock 释放。
- 不应留下永久占用的 `movement` / `inventory` lock。

### 4.8 get_task_status Storage 状态

玩家说：

- `你现在在干什么`
- 或使用项目已有 `get_task_status` 调试入口。

预期状态字段应能看到：

- `currentStorageTask`
- `storageMode`
- `storageStatus`
- `storageTarget`
- `storedItems`
- `takenItems`
- `missingItems`
- `lastStorageError`
- 当前 locks / task 状态

## 5. Mineflayer API 验收重点

请在日志中重点确认：

- `bot.openChest(block)` 或 `bot.openContainer(block)` 被用于真实箱子方块。
- 打开的窗口对象支持 `deposit(itemType, metadata, count)`。
- 打开的窗口对象支持 `withdraw(itemType, metadata, count)`。
- 读取箱子内容时优先使用 `containerItems()`，否则使用窗口 items fallback。
- 单箱子可以正常存取。
- 双箱子至少不会崩溃，窗口内容读取和存取不报错。
- 箱子距离太远时，任务先调用移动动作接近箱子。
- 箱子不存在、打不开、距离不可达时返回明确错误。
- 成功、失败、中断后都释放 `movement` / `inventory` lock。

## 6. 如果失败，先看哪些日志

优先查看：

- command-router / intent-parser 输出的 `actionKey`、`confidence`、`needConfirm`。
- intent-to-task 是否创建了 `StorageTask`。
- TaskManager 当前任务状态、失败原因和 locks。
- StorageTask 的 `failedReason`、`missingItems`、`storedItems`、`takenItems`。
- actions/storage 返回的错误原因，例如 `chest_not_found`、`no_known_chest`、`missing_open_chest_api`、`danger_too_high`。
- Mineflayer 抛出的窗口错误，例如 open、deposit、withdraw 失败。

如果是低置信度或聊天句子，例如 `你喜欢开箱子吗？`、`以后可以做自动仓库吗？`，预期不创建 StorageTask。
