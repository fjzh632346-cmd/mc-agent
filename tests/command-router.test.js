const assert = require('assert')
const { ACTION_KEYS } = require('../ai/action-keys')
const { sanitizeLlmActionKeyResult } = require('../ai/action-key-classifier')
const { parseIntent } = require('../ai/intent-parser')
const { routePlayerCommand } = require('../ai/command-router')
const { TaskManager } = require('../tasks/task-manager')
const { ActionLock } = require('../core/action-lock')
const { getChineseItemName } = require('../utils/item-names')

function createTaskManagerMock(options = {}) {
  return {
    enqueued: [],
    interrupted: false,
    currentTask: options.currentTask || null,
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source }
      this.enqueued.push(task)
      return task
    },
    async interruptCurrent(reason) {
      this.interrupted = reason
      this.currentTask = null
      return true
    },
    async interruptTaskByType(type, reason) {
      this.interrupted = reason
      this.interruptedType = type
      this.currentTask = null
      return true
    },
    status() {
      return {
        currentTask: { type: 'follow_player' },
        queue: [],
        pausedStack: [],
        dangerLevel: 'none',
        inventoryEmptySlots: 12
      }
    }
  }
}

function createEquipmentSystemMock() {
  const armorState = {
    helmet: null,
    chestplate: { name: 'iron_chestplate' },
    leggings: null,
    boots: null,
    missingArmorSlots: ['helmet', 'leggings', 'boots'],
    bestAvailableArmor: {
      helmet: { name: 'iron_helmet' },
      leggings: { name: 'iron_leggings' },
      boots: { name: 'iron_boots' }
    }
  }
  return {
    getArmorStatus() {
      return armorState
    },
    async equipBestArmor() {
      return { success: true, equippedCount: 3, reason: 'player_command', results: [] }
    }
  }
}

function createInventoryContext(items = []) {
  return {
    bot: {
      inventory: {
        items: () => items,
        slots: Array.from({ length: 45 }, (_, index) => (index >= 9 && index < 12 ? items[index - 9] || null : null))
      },
      heldItem: null
    },
    actionLock: new ActionLock(),
    logger: { log() {}, error() {} }
  }
}

function assertActionKey(text, actionKey) {
  const parsed = parseIntent(text)
  assert.strictEqual(parsed.actionKey, actionKey, text)
  assert.ok(parsed.confidence >= 0.8, `${text} confidence ${parsed.confidence}`)
}

async function assertAcceptanceRoute(text, expected) {
  const taskManager = createTaskManagerMock()
  const logs = []
  const context = {
    taskManager,
    playerName: 'Alex',
    logger: {
      log: message => logs.push(message),
      error: message => logs.push(message)
    }
  }

  if (expected.withArmor) context.equipmentSystem = createEquipmentSystemMock()
  if (expected.inventoryItems) Object.assign(context, createInventoryContext(expected.inventoryItems))

  const result = await routePlayerCommand(text, context)
  assert.strictEqual(result.actionKey, expected.actionKey, text)
  assert.strictEqual(result.handled, true, text)
  assert.notStrictEqual(result.action?.action, 'chat', text)

  if (expected.taskType) {
    assert.strictEqual(taskManager.enqueued.length, 1, text)
    assert.strictEqual(taskManager.enqueued[0].type, expected.taskType, text)
    assert.strictEqual(result.whetherExecuted, true, text)
    if (!expected.skipExecutionLogCheck) {
      assert.ok(
        logs.some(line => line.includes('[execution-check]') && line.includes('enqueued=true')),
        `${text} missing execution-check enqueue log`
      )
    }
  }

  if (expected.action) assert.strictEqual(result.action.action, expected.action, text)
  if (expected.notTaskType) assert.notStrictEqual(taskManager.enqueued[0]?.type, expected.notTaskType, text)
  if (expected.param) {
    const params = taskManager.enqueued[0]?.params || result.action?.inventoryState || result.action?.armorState || {}
    for (const [key, value] of Object.entries(expected.param)) {
      assert.deepStrictEqual(params[key], value, `${text} param ${key}`)
    }
  }

  return { result, taskManager, logs }
}

async function testRulesAndActionKeys() {
  assertActionKey('跟我走', ACTION_KEYS.FOLLOW_PLAYER)
  assertActionKey('别离我太远', ACTION_KEYS.FOLLOW_PLAYER)

  const mine = parseIntent('找点铁矿')
  assert.strictEqual(mine.actionKey, ACTION_KEYS.MINE)
  assert.strictEqual(mine.params.ore, 'iron')

  assertActionKey('附近有怪', ACTION_KEYS.ATTACK_HOSTILE)

  const stop = parseIntent('别挖了')
  assert.strictEqual(stop.actionKey, ACTION_KEYS.STOP_CURRENT_TASK)
  assert.strictEqual(stop.source, 'rules')

  for (const text of ['不用跟着我了', '别跟着我了', '不要跟我了', '你别跟了', '停止跟随', '取消跟随', '别再跟着我', '先别跟我']) {
    assertActionKey(text, ACTION_KEYS.CANCEL_TASK)
  }
  const stopFollow = parseIntent('别跟着我')
  assert.strictEqual(stopFollow.actionKey, ACTION_KEYS.CANCEL_TASK)
  assert.strictEqual(stopFollow.params.targetTaskType, 'follow_player')

  const back = parseIntent('回来')
  assert.strictEqual(back.actionKey, ACTION_KEYS.RETURN_TO_PLAYER)
  assert.strictEqual(back.source, 'rules')

  assertActionKey('你在干嘛', ACTION_KEYS.GET_STATUS)
  assertActionKey('你现在在干嘛？', ACTION_KEYS.GET_STATUS)
  assertActionKey('状态怎么样？', ACTION_KEYS.GET_STATUS)
  assertActionKey('现在安全吗？', ACTION_KEYS.CHECK_SURVIVAL_STATUS)
  assertActionKey('记住这里是我们的基地', ACTION_KEYS.REMEMBER_LOCATION)

  const chat = parseIntent('你喜欢挖矿吗？')
  assert.strictEqual(chat.actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(chat.shouldExecute, false)

  const soft = parseIntent('你能保护我吗？')
  assert.strictEqual(soft.actionKey, ACTION_KEYS.GUARD_PLAYER)
  assert.ok(soft.confidence >= 0.5 && soft.confidence < 0.8)

  const unknown = parseIntent('今天的月亮像方块')
  assert.strictEqual(unknown.actionKey, ACTION_KEYS.UNKNOWN)
}

async function testLlmFallbackAndExecution() {
  const taskManager = createTaskManagerMock()
  const commandLog = []
  const result = await routePlayerCommand('你贴近我行动', {
    taskManager,
    playerName: 'Alex',
    commandLog,
    llmClassifier: async () => ({
      actionKey: ACTION_KEYS.FOLLOW_PLAYER,
      confidence: 0.86,
      reason: '玩家希望 AI 靠近并跟随行动',
      code: 'bot.pathfinder.setGoal()'
    })
  })

  assert.strictEqual(result.actionKey, ACTION_KEYS.FOLLOW_PLAYER)
  assert.strictEqual(result.source, 'llm')
  assert.strictEqual(result.shouldExecute, true)
  assert.strictEqual(taskManager.enqueued[0].type, 'follow_player')
  assert.strictEqual(commandLog.length, 1)
  assert.strictEqual(commandLog[0].whetherExecuted, true)
}

async function testDangerousConfirmationAndChatFallback() {
  let taskManager = createTaskManagerMock()
  let result = await routePlayerCommand('地下好像有矿', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE)
  assert.strictEqual(result.shouldConfirm, true)
  assert.strictEqual(taskManager.enqueued.length, 0)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('你能保护我吗？', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.GUARD_PLAYER)
  assert.strictEqual(result.shouldConfirm, true)
  assert.strictEqual(taskManager.enqueued.length, 0)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('你喜欢挖矿吗？', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.handled, false)
  assert.strictEqual(result.actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(taskManager.enqueued.length, 0)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('我们去找点铁吧', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE)
  assert.strictEqual(result.shouldExecute, true)
  assert.strictEqual(taskManager.enqueued[0].params.ore, 'iron')
}

async function testIntentToTaskEffects() {
  let taskManager = createTaskManagerMock()
  let result = await routePlayerCommand('跟我走', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.action.action, 'enqueue_task')
  assert.strictEqual(taskManager.enqueued[0].type, 'follow_player')
  assert.ok(taskManager.enqueued[0].priority >= 9)

  taskManager = createTaskManagerMock({ currentTask: { id: 42, type: 'exploration' } })
  result = await routePlayerCommand('来找我', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.action.action, 'enqueue_task')
  assert.strictEqual(taskManager.enqueued[0].type, 'return_to_player')
  assert.strictEqual(taskManager.interrupted, 'return_to_player_command')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('别挖了', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.action.action, 'interrupt')
  assert.strictEqual(taskManager.interrupted, 'player_command')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('不用跟着我了', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.action.action, 'interrupt')
  assert.strictEqual(taskManager.interrupted, 'stop_follow')
  assert.strictEqual(taskManager.interruptedType, 'follow_player')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('别跟着我', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.CANCEL_TASK)
  assert.strictEqual(result.action.action, 'interrupt')
  assert.strictEqual(taskManager.interrupted, 'stop_follow')
  assert.strictEqual(taskManager.interruptedType, 'follow_player')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('你在干嘛', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.action.action, 'status')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('你现在在干嘛？', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.action.action, 'status')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('现在安全吗？', {
    taskManager,
    playerName: 'Alex',
    blackboard: { snapshot: () => ({ bot: { health: 20, food: 20 }, mobs: { dangerLevel: 'none' }, inventory: { emptySlots: 10, foodCount: 0 }, world: { isDay: true }, tasks: {} }), get: () => null, set() {} },
    memory: { summary: () => ({ world: { hasBaseLocation: false, chestLocations: 0, farmLocations: 0 }, task: { total: 0 } }) }
  })
  assert.strictEqual(result.action.action, 'survival_status')
}

async function testChineseAcceptanceCommandChain() {
  let taskManager = createTaskManagerMock()
  let result = await routePlayerCommand('准备战斗', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.PREPARE_COMBAT)
  assert.strictEqual(result.action.action, 'enqueue_task')
  assert.strictEqual(taskManager.enqueued[0].type, 'prepare_combat')
  assert.notStrictEqual(taskManager.enqueued[0].type, 'craft_item')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('检查一下防具', {
    taskManager,
    playerName: 'Alex',
    equipmentSystem: createEquipmentSystemMock()
  })
  assert.strictEqual(result.actionKey, ACTION_KEYS.CHECK_ARMOR)
  assert.strictEqual(result.action.action, 'armor_status')
  assert.ok(result.action.armorState)
  assert.deepStrictEqual(result.action.armorState.missingArmorSlots, ['helmet', 'leggings', 'boots'])

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('从箱子里拿装备穿上', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FETCH_AND_EQUIP_ARMOR)
  assert.strictEqual(taskManager.enqueued[0].type, 'storage')
  assert.strictEqual(taskManager.enqueued[0].params.mode, 'FETCH_AND_EQUIP_ARMOR')
  assert.strictEqual(taskManager.enqueued[0].params.category, 'armor')
  assert.strictEqual(taskManager.enqueued[0].params.itemName, null)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('把装备穿上', {
    taskManager,
    playerName: 'Alex',
    llmClassifier: async () => ({
      actionKey: ACTION_KEYS.EQUIP_ARMOR,
      confidence: 0.9,
      reason: 'Player wants to equip armor'
    })
  })
  assert.strictEqual(result.actionKey, ACTION_KEYS.EQUIP_ARMOR)
  assert.strictEqual(result.whetherExecuted, true)
  assert.strictEqual(taskManager.enqueued[0].type, 'equip_armor')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('做一把铁剑', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.CRAFT_ITEM)
  assert.strictEqual(taskManager.enqueued[0].type, 'craft_item')
  assert.strictEqual(taskManager.enqueued[0].params.itemName, 'iron_sword')

  for (const entry of [
    ['做木棍', 'stick'],
    ['做火把', 'torch'],
    ['做箱子', 'chest'],
    ['做铁剑', 'iron_sword'],
    ['做工作台', 'crafting_table'],
    ['做木镐', 'wooden_pickaxe'],
    ['做石镐', 'stone_pickaxe'],
    ['做木剑', 'wooden_sword'],
    ['合成面包', 'bread']
  ]) {
    taskManager = createTaskManagerMock()
    result = await routePlayerCommand(entry[0], { taskManager, playerName: 'Alex' })
    assert.strictEqual(result.actionKey, ACTION_KEYS.CRAFT_ITEM, entry[0])
    assert.strictEqual(taskManager.enqueued[0].type, 'craft_item', entry[0])
    assert.strictEqual(taskManager.enqueued[0].params.itemName, entry[1], entry[0])
  }

  for (const entry of [
    ['bucket', 'bucket'],
    ['\u94c1\u6876', 'bucket'],
    ['\u505a\u94c1\u6876', 'bucket'],
    ['\u5408\u6210\u94c1\u6876', 'bucket'],
    ['craft furnace', 'furnace'],
    ['furnace', 'furnace'],
    ['\u5408\u6210\u7194\u7089', 'furnace'],
    ['craft barrel', 'barrel'],
    ['barrel', 'barrel'],
    ['\u5408\u6210\u6728\u6876', 'barrel'],
    ['\u6728\u6876', 'barrel'],
    ['craft stairs', 'oak_stairs'],
    ['stairs', 'oak_stairs'],
    ['\u5408\u6210\u697c\u68af', 'oak_stairs'],
    ['craft slab', 'oak_slab'],
    ['slab', 'oak_slab'],
    ['\u5408\u6210\u53f0\u9636', 'oak_slab'],
    ['craft bed', 'red_bed'],
    ['bed', 'red_bed'],
    ['\u5408\u6210\u5e8a', 'red_bed']
  ]) {
    taskManager = createTaskManagerMock()
    result = await routePlayerCommand(entry[0], { taskManager, playerName: 'Alex' })
    assert.strictEqual(result.actionKey, ACTION_KEYS.CRAFT_ITEM, entry[0])
    assert.strictEqual(taskManager.enqueued[0].type, 'craft_item', entry[0])
    assert.strictEqual(taskManager.enqueued[0].params.itemName, entry[1], entry[0])
  }

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('\u505a\u94c1\u952d', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.CRAFT_ITEM)
  assert.strictEqual(taskManager.enqueued[0].type, 'craft_item')
  assert.strictEqual(taskManager.enqueued[0].params.itemName, 'iron_ingot')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('做面包', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MAKE_BREAD)
  assert.strictEqual(taskManager.enqueued[0].type, 'farming')
  assert.strictEqual(taskManager.enqueued[0].params.mode, 'MAKE_BREAD')
  assert.notStrictEqual(taskManager.enqueued[0].type, 'craft_item')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('找钻石矿', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FIND_ORE)
  assert.strictEqual(taskManager.enqueued[0].type, 'mining')
  assert.strictEqual(taskManager.enqueued[0].params.blockName, 'diamond_ore')
  assert.strictEqual(taskManager.enqueued[0].params.requiredTool, 'iron_pickaxe_or_better')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('用铁斧找钻石矿', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FIND_ORE)
  assert.strictEqual(taskManager.enqueued[0].params.mentionedTool, 'iron_axe')
  assert.strictEqual(taskManager.enqueued[0].params.requiredTool, 'iron_pickaxe_or_better')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('挖石头', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(taskManager.enqueued[0].params.blockName, 'stone')
  assert.strictEqual(taskManager.enqueued[0].params.preferredTool, 'pickaxe')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('挖沙子', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(taskManager.enqueued[0].params.blockName, 'sand')
  assert.strictEqual(taskManager.enqueued[0].params.preferredTool, 'shovel')

  let inventoryResult = await routePlayerCommand('你背包里有什么', createInventoryContext([
    { name: 'oak_log', count: 12 },
    { name: 'stone_pickaxe', count: 1 },
    { name: 'bread', count: 3 }
  ]))
  assert.strictEqual(inventoryResult.actionKey, ACTION_KEYS.CHECK_INVENTORY)
  assert.strictEqual(inventoryResult.action.action, 'inventory_status')
  assert.strictEqual(inventoryResult.action.inventoryState.items.find(item => item.name === 'oak_log').count, 12)
  assert.strictEqual(inventoryResult.action.inventoryState.items.find(item => item.name === 'oak_log').displayName, '橡木原木')
  assert.strictEqual(inventoryResult.action.inventoryState.items.find(item => item.name === 'stone_pickaxe').displayName, '石镐')
  assert.strictEqual(inventoryResult.action.inventoryState.items.find(item => item.name === 'bread').displayName, '面包')

  inventoryResult = await routePlayerCommand('你背包里有木棍吗', createInventoryContext([
    { name: 'stick', count: 5 }
  ]))
  assert.strictEqual(inventoryResult.actionKey, ACTION_KEYS.CHECK_ITEM_IN_INVENTORY)
  assert.strictEqual(inventoryResult.action.action, 'inventory_item_status')
  assert.strictEqual(inventoryResult.action.inventoryState.itemName, 'stick')
  assert.strictEqual(inventoryResult.action.inventoryState.count, 5)

  inventoryResult = await routePlayerCommand('你还有多少煤', createInventoryContext([
    { name: 'coal', count: 22 }
  ]))
  assert.strictEqual(inventoryResult.actionKey, ACTION_KEYS.COUNT_ITEM_IN_INVENTORY)
  assert.strictEqual(inventoryResult.action.inventoryState.itemName, 'coal')
  assert.strictEqual(inventoryResult.action.inventoryState.count, 22)

  inventoryResult = await routePlayerCommand('你有食物吗', createInventoryContext([
    { name: 'bread', count: 2 },
    { name: 'stick', count: 5 }
  ]))
  assert.strictEqual(inventoryResult.actionKey, ACTION_KEYS.CHECK_ITEM_IN_INVENTORY)
  assert.strictEqual(inventoryResult.action.inventoryState.category, 'food')
  assert.strictEqual(inventoryResult.action.inventoryState.matchedItems[0].name, 'bread')

  inventoryResult = await routePlayerCommand('检查一下背包', createInventoryContext([]))
  assert.strictEqual(inventoryResult.actionKey, ACTION_KEYS.CHECK_INVENTORY)
  assert.strictEqual(inventoryResult.action.inventoryState.emptySlots, 36)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('砍树', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(taskManager.enqueued[0].params.treeMode, 'tree_count')
  assert.strictEqual(taskManager.enqueued[0].params.targetTreeCount, 1)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('砍3棵树', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(taskManager.enqueued[0].params.treeMode, 'tree_count')
  assert.strictEqual(taskManager.enqueued[0].params.targetTreeCount, 3)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('砍附近2棵树', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(taskManager.enqueued[0].params.treeMode, 'tree_count')
  assert.strictEqual(taskManager.enqueued[0].params.targetTreeCount, 2)
  assert.strictEqual(taskManager.enqueued[0].params.maxDistance, 8)
  assert.strictEqual(taskManager.enqueued[0].params.maxSearchRadius, 8)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('砍10个木头', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(taskManager.enqueued[0].params.treeMode, 'log_count')
  assert.strictEqual(taskManager.enqueued[0].params.targetLogCount, 10)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('吃东西', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.EAT_FOOD)
  assert.strictEqual(taskManager.enqueued[0].type, 'eat_food')
  assert.notStrictEqual(taskManager.enqueued[0].type, 'farming')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('你饿了就吃', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.EAT_FOOD)
  assert.strictEqual(taskManager.enqueued[0].type, 'eat_food')
  assert.strictEqual(taskManager.enqueued[0].params.statusOwner, 'bot')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('挖铁矿', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FIND_ORE)
  assert.strictEqual(taskManager.enqueued[0].params.count > 1, true)
  assert.strictEqual(taskManager.enqueued[0].params.mineUntilExhausted, true)
  assert.strictEqual(taskManager.enqueued[0].params.blockName, 'iron_ore')
  assert.ok(taskManager.enqueued[0].params.blockNames.includes('deepslate_iron_ore'))

  taskManager = createTaskManagerMock()
  const executionLogs = []
  result = await routePlayerCommand('挖铜矿', {
    taskManager,
    playerName: 'Alex',
    logger: { log: message => executionLogs.push(message), error: message => executionLogs.push(message) }
  })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FIND_ORE)
  assert.strictEqual(taskManager.enqueued[0].type, 'mining')
  assert.strictEqual(taskManager.enqueued[0].params.blockName, 'copper_ore')
  assert.ok(taskManager.enqueued[0].params.blockNames.includes('deepslate_copper_ore'))
  assert.strictEqual(taskManager.enqueued[0].params.requiredTool, 'stone_pickaxe_or_better')
  assert.ok(executionLogs.some(line => line.includes('[execution-check]') && line.includes('enqueued=true')))

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('挖一个铁矿', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FIND_ORE)
  assert.strictEqual(taskManager.enqueued[0].params.count, 1)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('挖3个铁矿', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.FIND_ORE)
  assert.strictEqual(taskManager.enqueued[0].params.count, 3)

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('打僵尸', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.ATTACK_HOSTILE)
  assert.strictEqual(taskManager.enqueued[0].type, 'guard_player')

  taskManager = createTaskManagerMock()
  result = await routePlayerCommand('捡起来', { taskManager, playerName: 'Alex' })
  assert.strictEqual(result.actionKey, ACTION_KEYS.PICKUP_ITEM)
  assert.strictEqual(taskManager.enqueued[0].type, 'pickup_item')
}

async function testAcceptanceSmokeMatrix() {
  await assertAcceptanceRoute('你背包里有什么', {
    actionKey: ACTION_KEYS.CHECK_INVENTORY,
    action: 'inventory_status',
    inventoryItems: [{ name: 'bread', count: 2 }]
  })

  await assertAcceptanceRoute('检查一下防具', {
    actionKey: ACTION_KEYS.CHECK_ARMOR,
    action: 'armor_status',
    withArmor: true
  })

  await assertAcceptanceRoute('从箱子里拿装备穿上', {
    actionKey: ACTION_KEYS.FETCH_AND_EQUIP_ARMOR,
    taskType: 'storage',
    param: { mode: 'FETCH_AND_EQUIP_ARMOR', category: 'armor', itemName: null }
  })

  await assertAcceptanceRoute('准备战斗', {
    actionKey: ACTION_KEYS.PREPARE_COMBAT,
    taskType: 'prepare_combat',
    notTaskType: 'craft_item'
  })

  await assertAcceptanceRoute('打僵尸', {
    actionKey: ACTION_KEYS.ATTACK_HOSTILE,
    taskType: 'guard_player',
    param: { mode: 'attack_hostile', mobName: 'zombie' }
  })

  await assertAcceptanceRoute('砍树', {
    actionKey: ACTION_KEYS.MINE_BLOCK,
    taskType: 'mining',
    param: { treeMode: 'tree_count', targetTreeCount: 1 }
  })

  await assertAcceptanceRoute('砍5个木头', {
    actionKey: ACTION_KEYS.MINE_BLOCK,
    taskType: 'mining',
    param: { treeMode: 'log_count', targetLogCount: 5 }
  })

  await assertAcceptanceRoute('砍2棵树', {
    actionKey: ACTION_KEYS.MINE_BLOCK,
    taskType: 'mining',
    param: { treeMode: 'tree_count', targetTreeCount: 2 }
  })

  await assertAcceptanceRoute('砍附近2棵树', {
    actionKey: ACTION_KEYS.MINE_BLOCK,
    taskType: 'mining',
    param: { treeMode: 'tree_count', targetTreeCount: 2, maxDistance: 8, maxSearchRadius: 8 }
  })

  await assertAcceptanceRoute('挖石头', {
    actionKey: ACTION_KEYS.MINE_BLOCK,
    taskType: 'mining',
    param: { blockName: 'stone', preferredTool: 'pickaxe' }
  })

  await assertAcceptanceRoute('挖点铁矿', {
    actionKey: ACTION_KEYS.FIND_ORE,
    taskType: 'mining',
    param: { blockName: 'iron_ore', requiredTool: 'stone_pickaxe_or_better' }
  })

  await assertAcceptanceRoute('烧铁', {
    actionKey: ACTION_KEYS.SMELT_ITEM,
    taskType: 'smelt_item',
    param: { inputName: 'raw_iron' }
  })

  await assertAcceptanceRoute('用烟熏炉烤肉', {
    actionKey: ACTION_KEYS.COOK_ITEM,
    taskType: 'smelt_item',
    param: { preferredFurnace: 'smoker' }
  })

  await assertAcceptanceRoute('做些火把', {
    actionKey: ACTION_KEYS.CRAFT_ITEM,
    taskType: 'craft_item',
    param: { itemName: 'torch' }
  })

  for (const entry of [
    ['做木棍', 'stick'],
    ['做火把', 'torch'],
    ['做箱子', 'chest'],
    ['做铁剑', 'iron_sword'],
    ['做工作台', 'crafting_table'],
    ['做木镐', 'wooden_pickaxe'],
    ['做石镐', 'stone_pickaxe'],
    ['做木剑', 'wooden_sword'],
    ['合成面包', 'bread']
  ]) {
    await assertAcceptanceRoute(entry[0], {
      actionKey: ACTION_KEYS.CRAFT_ITEM,
      taskType: 'craft_item',
      param: { itemName: entry[1] }
    })
  }

  await assertAcceptanceRoute('做面包', {
    actionKey: ACTION_KEYS.MAKE_BREAD,
    taskType: 'farming',
    notTaskType: 'craft_item',
    param: { mode: 'MAKE_BREAD' },
    skipExecutionLogCheck: true
  })

  await assertAcceptanceRoute('吃东西', {
    actionKey: ACTION_KEYS.EAT_FOOD,
    taskType: 'eat_food',
    notTaskType: 'farming'
  })

  await assertAcceptanceRoute('捡起来', {
    actionKey: ACTION_KEYS.PICKUP_ITEM,
    taskType: 'pickup_item'
  })

  await assertAcceptanceRoute('把木头放箱子里', {
    actionKey: ACTION_KEYS.STORE_ITEMS,
    taskType: 'storage',
    param: { mode: 'STORE_ITEMS', category: 'wood', itemName: null }
  })

  await assertAcceptanceRoute('回来找我', {
    actionKey: ACTION_KEYS.RETURN_TO_PLAYER,
    taskType: 'return_to_player'
  })

  await assertAcceptanceRoute('去睡觉', {
    actionKey: ACTION_KEYS.SLEEP,
    taskType: 'sleep',
    param: { input: '去睡觉', radius: 32 },
    notTaskType: 'return_to_player'
  })
}

function testChineseItemNames() {
  assert.strictEqual(getChineseItemName('oak_log'), '橡木原木')
  assert.strictEqual(getChineseItemName('iron_pickaxe'), '铁镐')
  assert.strictEqual(getChineseItemName('bread'), '面包')
  assert.strictEqual(getChineseItemName('unknown_mod_item'), 'unknown_mod_item')
}

async function testArmorTasksExecuteThroughTaskManager() {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } } }
  const calls = { armor: 0, weapon: 0, food: 0 }
  const equipmentSystem = {
    async equipBestArmor() {
      calls.armor += 1
      return { success: true, equippedCount: 2, reason: 'test', results: [] }
    },
    async equipBestWeapon() {
      calls.weapon += 1
      return { success: true, itemName: 'iron_sword' }
    },
    selectBestFood() {
      calls.food += 1
      return { success: true, itemName: 'bread' }
    },
    getArmorStatus() {
      return { helmet: null, chestplate: { name: 'iron_chestplate' }, leggings: null, boots: null, missingArmorSlots: ['helmet'], bestAvailableArmor: {} }
    }
  }

  let manager = new TaskManager(bot, { enabled: false, debug: false, equipmentSystem })
  await routePlayerCommand('把装备穿上', {
    taskManager: manager,
    playerName: 'Alex',
    llmClassifier: async () => ({
      actionKey: ACTION_KEYS.EQUIP_ARMOR,
      confidence: 0.9,
      reason: 'Player wants to equip armor'
    })
  })
  await manager.update()
  assert.strictEqual(manager.completed[0].type, 'equip_armor')
  assert.strictEqual(calls.armor, 1)

  manager = new TaskManager(bot, { enabled: false, debug: false, equipmentSystem })
  await routePlayerCommand('准备战斗', { taskManager: manager, playerName: 'Alex' })
  await manager.update()
  assert.strictEqual(manager.completed[0].type, 'prepare_combat')
  assert.strictEqual(calls.weapon, 1)
  assert.strictEqual(calls.food, 1)
  assert.strictEqual(calls.armor, 2)
}

async function testPrepareCombatMissingWeaponUsesBareHandFallback() {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 2 }, { name: 'stick', count: 1 }] }
  }
  const equipmentSystem = {
    async equipBestArmor() {
      return { success: true, equippedCount: 1, reason: 'test', results: [] }
    },
    async equipBestWeapon() {
      return { success: false, reason: 'missing_weapon' }
    },
    selectBestFood() {
      return { success: true, itemName: 'bread' }
    },
    getArmorStatus() {
      return { helmet: null, chestplate: { name: 'iron_chestplate' }, leggings: null, boots: null, armorLevel: 4, missingArmorSlots: [], bestAvailableArmor: {} }
    }
  }
  const manager = new TaskManager(bot, { enabled: false, debug: false, equipmentSystem, enableTaskFeedback: false })
  await routePlayerCommand('准备战斗', { taskManager: manager, playerName: 'Alex' })
  await manager.update()
  assert.strictEqual(manager.completed[0].type, 'prepare_combat')
  assert.strictEqual(manager.failed.length, 0)
  assert.strictEqual(manager.queue.length, 0)
  assert.strictEqual(manager.completed[0].combatReadyState.selectedWeapon, 'hand')
  assert.strictEqual(manager.completed[0].combatReadyState.weaponFallback, 'bare_hand')
  assert.strictEqual(manager.completed[0].combatReadyState.readiness, 'ready')
}

async function testPrepareCombatDoesNotForceWeaponCrafting() {
  const cases = [
    {
      items: [{ name: 'iron_ingot', count: 2 }, { name: 'stick', count: 1 }],
      expected: 'iron_sword'
    },
    {
      items: [{ name: 'cobblestone', count: 2 }, { name: 'oak_planks', count: 2 }],
      expected: 'stone_sword'
    },
    {
      items: [{ name: 'oak_log', count: 1 }],
      expected: 'wooden_sword'
    }
  ]

  for (const entry of cases) {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => entry.items }
    }
    const equipmentSystem = {
      async equipBestArmor() {
        return { success: true, equippedCount: 0, reason: 'test', results: [] }
      },
      async equipBestWeapon() {
        return { success: false, reason: 'missing_weapon' }
      },
      selectBestFood() {
        return { success: false, reason: 'no_food_available' }
      },
      getArmorStatus() {
        return { helmet: null, chestplate: null, leggings: null, boots: null, armorLevel: 0, missingArmorSlots: [], bestAvailableArmor: {} }
      }
    }
    const manager = new TaskManager(bot, { enabled: false, debug: false, equipmentSystem, enableTaskFeedback: false })
    await routePlayerCommand('准备战斗', { taskManager: manager, playerName: 'Alex' })
    await manager.update()
    assert.strictEqual(manager.completed[0].type, 'prepare_combat')
    assert.strictEqual(manager.completed[0].combatReadyState?.selectedWeapon, 'hand')
    assert.strictEqual(manager.completed[0].combatReadyState?.weaponFallback, 'bare_hand')
    assert.strictEqual(manager.queue.length, 0, entry.expected)
  }
}

async function testCombatAndPickupTasksExecuteThroughTaskManager() {
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.sqrt((this.x - other.x) ** 2 + (this.y - other.y) ** 2 + (this.z - other.z) ** 2)
    }
  }
  const zombie = { id: 10, name: 'zombie', type: 'mob', position: { ...position, x: 2 } }
  const itemEntity = { id: 20, name: 'item', type: 'object', displayName: 'Item', position: { ...position, x: 2 } }
  const bot = {
    entity: { position },
    health: 20,
    entities: { 10: zombie, 20: itemEntity },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }], slots: Array(45).fill(null) },
    pathfinder: {
      goalSet: false,
      setMovements() {},
      setGoal() {
        this.goalSet = true
      },
      stop() {}
    },
    once(event, cb) {
      cb()
    },
    removeListener() {},
    pvp: {
      attacked: null,
      attack(entity) {
        this.attacked = entity
      },
      stop() {}
    },
    async equip(item) {
      this.heldItem = item
    }
  }
  const equipmentSystem = {
    async equipBestWeapon() {
      return { success: true, itemName: 'iron_sword', reason: 'best_weapon_available' }
    },
    async equipBestArmor() {
      return { success: true, equippedCount: 0, results: [] }
    }
  }
  const blackboard = {
    snapshot: () => ({
      mobs: { hostileMobs: [{ id: 10, name: 'zombie', distance: 2, position: zombie.position }], dangerLevel: 'medium' },
      player: { ownerPosition: position },
      bot: { health: 20, food: 20 },
      inventory: {},
      world: {},
      tasks: {}
    }),
    get(path, fallback) {
      if (path === 'mobs.hostileMobs') return [{ id: 10, name: 'zombie', distance: 2, position: zombie.position }]
      if (path === 'player.ownerPosition') return position
      return fallback
    },
    update() {},
    set() {}
  }

  let manager = new TaskManager(bot, { enabled: false, debug: false, equipmentSystem, blackboard, enableTaskFeedback: false })
  await routePlayerCommand('打僵尸', { taskManager: manager, playerName: 'Alex' })
  await manager.update()
  assert.strictEqual(manager.currentTask.type, 'guard_player')
  assert.strictEqual(bot.pvp.attacked, zombie)

  manager = new TaskManager(bot, { enabled: false, debug: false, blackboard, enableTaskFeedback: false })
  await routePlayerCommand('捡起来', { taskManager: manager, playerName: 'Alex' })
  await manager.update()
  assert.strictEqual(manager.completed[0].type, 'pickup_item')
  assert.strictEqual(bot.pathfinder.goalSet, true)
}

async function testLlmSanitizingAndLowConfidence() {
  const sanitized = sanitizeLlmActionKeyResult({
    actionKey: ACTION_KEYS.MINE,
    confidence: 0.9,
    reason: 'mine',
    params: { ore: 'iron', code: 'bot.dig()' },
    directBotCall: 'bot.attack()'
  })
  assert.strictEqual(sanitized.actionKey, ACTION_KEYS.MINE)
  assert.strictEqual(sanitized.params.ore, 'iron')
  assert.strictEqual(sanitized.params.code, undefined)

  const taskManager = createTaskManagerMock()
  const result = await routePlayerCommand('也许深处有东西？', {
    taskManager,
    playerName: 'Alex',
    llmClassifier: async () => ({
      actionKey: ACTION_KEYS.MINE,
      confidence: 0.4,
      reason: 'too uncertain'
    })
  })
  assert.strictEqual(result.handled, false)
  assert.strictEqual(taskManager.enqueued.length, 0)
}

async function run() {
  testChineseItemNames()
  await testRulesAndActionKeys()
  await testLlmFallbackAndExecution()
  await testDangerousConfirmationAndChatFallback()
  await testIntentToTaskEffects()
  await testChineseAcceptanceCommandChain()
  await testAcceptanceSmokeMatrix()
  await testArmorTasksExecuteThroughTaskManager()
  await testPrepareCombatMissingWeaponUsesBareHandFallback()
  await testPrepareCombatDoesNotForceWeaponCrafting()
  await testCombatAndPickupTasksExecuteThroughTaskManager()
  await testLlmSanitizingAndLowConfidence()
  console.log('command-router tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
