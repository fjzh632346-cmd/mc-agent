const assert = require('assert')
const { Blackboard } = require('../core/blackboard')
const { GoalSystem, GOAL_TYPES, buildGoalReminderEvent } = require('../ai/goal-system')
const {
  MessageGenerator,
  REMINDER_TYPES,
  createReminderEvent,
  createTaskReminderEvent,
  defaultReminderText,
  validateGeneratedText
} = require('../ai/message-generator')

function mockClientReturning(text) {
  return {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: JSON.stringify({ text }) } }] }
        }
      }
    }
  }
}

function mockClientThrowing() {
  return {
    chat: {
      completions: {
        async create() {
          throw new Error('mock llm failure')
        }
      }
    }
  }
}

function createGoalContext(state = {}, extras = {}) {
  const blackboard = new Blackboard({
    bot: { health: 20, food: 20 },
    mobs: { dangerLevel: 'none', nearestHostileMob: null },
    inventory: { emptySlots: 10, foodCount: 0 },
    world: { isDay: true },
    tasks: { currentTask: null },
    ...state
  })
  const taskManager = {
    interrupted: null,
    async interruptCurrent(reason) {
      this.interrupted = reason
      return true
    },
    enqueue() {
      return { id: 1 }
    }
  }
  const memory = {
    summary() {
      return { world: { hasBaseLocation: false, chestLocations: 0 }, task: { total: 0 } }
    }
  }
  return {
    blackboard,
    taskManager,
    memory,
    logger: { warn() {}, error() {}, log() {} },
    ...extras
  }
}

async function testInventoryEventAndPersonaText() {
  const event = createReminderEvent(REMINDER_TYPES.INVENTORY_FULL, {
    facts: { emptySlots: 0 }
  })
  const generator = new MessageGenerator({
    persona: { name: '林夏', username: 'LinXia' },
    enableLlm: false
  })
  const result = await generator.generate(event)

  assert.strictEqual(event.type, REMINDER_TYPES.INVENTORY_FULL)
  assert.strictEqual(result.ok, true)
  assert.ok(result.text.includes('背包'))
  assert.ok(result.text.includes('0'))
  assert.strictEqual(result.persona, '林夏')
}

async function testDangerFactMustBePreserved() {
  const event = createReminderEvent(REMINDER_TYPES.DANGER_NEARBY, {
    facts: { mob: 'creeper', distance: 5 }
  })
  const badGenerator = new MessageGenerator({
    client: mockClientReturning('附近没什么问题，可以继续挖。'),
    persona: { name: '林夏', username: 'LinXia' }
  })
  const result = await badGenerator.generate(event)

  assert.strictEqual(validateGeneratedText('附近没什么问题，可以继续挖。', event), false)
  assert.strictEqual(result.source, 'fallback')
  assert.ok(result.text.includes('苦力怕'))
}

async function testLlmPersonaTextWhenSafe() {
  const event = createReminderEvent(REMINDER_TYPES.DANGER_NEARBY, {
    facts: { mob: 'creeper', distance: 5 }
  })
  const generator = new MessageGenerator({
    client: mockClientReturning('小心，附近有苦力怕，离我们很近。'),
    persona: { name: '林夏', username: 'LinXia' }
  })
  const result = await generator.generate(event)

  assert.strictEqual(result.source, 'persona')
  assert.ok(result.text.includes('苦力怕'))
}

async function testLlmFailureFallsBack() {
  const event = createReminderEvent(REMINDER_TYPES.LOW_HEALTH, {
    facts: { health: 6 }
  })
  const generator = new MessageGenerator({
    client: mockClientThrowing(),
    persona: { name: '安迪', username: 'Andy' }
  })
  const result = await generator.generate(event, { logger: { warn() {} } })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.source, 'fallback')
  assert.ok(result.text.includes('血量'))
}

async function testBotStatusOwnerUsesFirstPerson() {
  let event = createReminderEvent(REMINDER_TYPES.LOW_HEALTH, {
    facts: { health: 5, statusOwner: 'bot' }
  })
  let generator = new MessageGenerator({
    client: mockClientReturning('你的血量太低了，先撤退。'),
    persona: { username: 'Andy' }
  })
  let result = await generator.generate(event)
  assert.strictEqual(result.source, 'persona')
  assert.ok(result.text.includes('我的血量'))
  assert.strictEqual(result.text.includes('你的血量'), false)

  event = createReminderEvent(REMINDER_TYPES.LOW_FOOD, {
    facts: { food: 3, statusOwner: 'bot' }
  })
  generator = new MessageGenerator({
    client: mockClientReturning('你快饿坏了，先吃点东西。'),
    persona: { username: 'Andy' }
  })
  result = await generator.generate(event)
  assert.ok(result.text.includes('我快饿'))
  assert.strictEqual(result.text.includes('你快饿'), false)
}

async function testGoalSystemProducesReminderEvent() {
  let spoken = null
  const context = createGoalContext({
    inventory: { emptySlots: 0, foodCount: 0 },
    tasks: { currentTask: { type: 'mining' } }
  }, {
    messageGenerator: new MessageGenerator({ enableLlm: false, persona: { username: 'Andy' } }),
    reminderOutput(text) {
      spoken = text
    }
  })
  const goalSystem = new GoalSystem({ cooldownMs: 1000, enableSurvivalSystem: false })

  await goalSystem.update(context)
  assert.ok(goalSystem.completedGoals.some(goal => goal.type === GOAL_TYPES.INVENTORY_FULL))
  assert.strictEqual(goalSystem.lastAction.type, 'REMINDER')
  assert.strictEqual(goalSystem.lastAction.event.type, REMINDER_TYPES.INVENTORY_FULL)
  assert.strictEqual(goalSystem.lastAction.event.facts.emptySlots, 0)
  assert.ok(spoken.includes('背包'))
  assert.strictEqual(context.taskManager.interrupted, 'inventory_full')
}

async function testBuildGoalReminderEvent() {
  const context = createGoalContext({
    inventory: { emptySlots: 0 },
    mobs: { dangerLevel: 'high', nearestHostileMob: { name: 'creeper', distance: 4 } }
  })
  const inventoryEvent = buildGoalReminderEvent({ type: GOAL_TYPES.INVENTORY_FULL }, context)
  const dangerEvent = buildGoalReminderEvent({ type: GOAL_TYPES.DANGER_NEARBY }, context)

  assert.strictEqual(inventoryEvent.type, REMINDER_TYPES.INVENTORY_FULL)
  assert.strictEqual(inventoryEvent.facts.emptySlots, 0)
  assert.strictEqual(dangerEvent.type, REMINDER_TYPES.DANGER_NEARBY)
  assert.strictEqual(dangerEvent.facts.mob, 'creeper')
}

async function testTaskFeedbackEventShape() {
  const event = createTaskReminderEvent({
    id: 7,
    type: 'mining',
    error: 'danger_too_high'
  }, 'failed')

  assert.strictEqual(event.type, REMINDER_TYPES.TASK_FAILED)
  assert.strictEqual(event.facts.taskType, 'mining')
  assert.strictEqual(event.facts.error, 'danger_too_high')
}

async function testUnsupportedToolTierFeedbackIsFriendly() {
  const event = createTaskReminderEvent({
    id: 8,
    type: 'mining',
    error: 'auto_preparation_failed:unsupported_min_tier:iron'
  }, 'failed')
  const generator = new MessageGenerator({ enableLlm: false, persona: { username: 'LinXia' } })
  const result = await generator.generate(event)

  assert.ok(result.text.includes('iron pickaxe or better'))
  assert.strictEqual(result.text.includes('auto_preparation_failed'), false)
  assert.strictEqual(result.text.includes('unsupported_min_tier'), false)
}

async function testLlmTimeoutFeedbackIsPlayerFriendly() {
  const event = createTaskReminderEvent({
    id: 9,
    type: 'mining',
    error: 'LLM_TIMEOUT'
  }, 'failed')
  const generator = new MessageGenerator({ enableLlm: false, persona: { username: 'LinXia' } })
  const result = await generator.generate(event)

  assert.ok(result.text.includes('反应慢了一下'))
  assert.strictEqual(result.text.includes('LLM_TIMEOUT'), false)
  assert.strictEqual(result.text.includes('原因是'), false)
}

// Repair 17, item 9: one row per failure reason that round 16 measured, plus
// the fallback that must keep the raw key in the log instead of hiding it.
async function testFailureReasonTableCoversTheMeasuredCases() {
  const noLog = { log() { throw new Error('a mapped key must not be logged as unmapped') } }
  const cases = [
    ['entity_obstruction:accept_tester:1533,120,1533:1533,120,1533', 'accept_tester，你站在我要盖的地方，往旁边挪几步我再盖'],
    ['entity_obstruction:zombie:1,2,3:1,2,3', '有只僵尸站在我要盖的地方，我先等它走开'],
    ['smelt_failed_no_fuel:fuel_not_found', '没燃料，我手上没有煤炭'],
    ['smelt_failed_no_input:smelt_input_not_found', '手上没有要烧的原料'],
    ['pickup_failed:drop_not_found', '挖到了但没捡到掉落物'],
    ['inventory_full', '背包满了，得先存点东西'],
    ['escape_exhausted', '我卡住出不来了，来拉我一把'],
    ['build_origin_too_far', '离工地太远，先带我过去'],
    ['verified_real_community_samples_unavailable', '这张图纸开不了工，找不到参考样板'],
    ['bot_died', '我死了一次，手上的事都停了'],
    ['Food is full', '我不饿，吃不下'],
    ['missing_seeds', '没有小麦种子'],
    ['mob_too_far', '那只怪离得太远，我够不着'],
    ['sleep_failed_monsters_nearby', '附近有怪，睡不了']
  ]
  for (const [key, expected] of cases) {
    const event = createTaskReminderEvent({ id: 1, type: 'build_blueprint', error: key }, 'failed', { logger: noLog })
    assert.strictEqual(event.facts.displayError, expected, key)
    assert.strictEqual(defaultReminderText(event, { username: 'LinXia', style: 'linxia' }), `盖房子没成功，${expected}`)
    assert.strictEqual(event.facts.rawError, key, 'the raw key stays in the facts for the log')
  }

  const stuck = createTaskReminderEvent({ id: 2, type: 'return_to_base', error: 'escape_exhausted' }, 'failed', { logger: noLog, position: { x: 424.5, y: 73, z: 379.2 } })
  assert.strictEqual(stuck.facts.displayError, '我卡在 424,73,379 出不来了')

  const logs = []
  const unknown = createTaskReminderEvent({ id: 3, type: 'mining', error: 'some_new_failure:detail' }, 'failed', { logger: { log: line => logs.push(line) } })
  assert.strictEqual(unknown.facts.displayError, '这一步没处理完整，我先停一下，别乱做。')
  assert.ok(logs.some(line => line.includes('[TASK_FEEDBACK_UNMAPPED] key=some_new_failure:detail')), logs.join('\n'))
  assert.ok(!defaultReminderText(unknown).includes('some_new_failure'))

  const missing = createTaskReminderEvent({ id: 4, type: 'mining', error: 'ore_not_found' }, 'failed', { logger: { log: line => logs.push(line) } })
  assert.strictEqual(missing.facts.displayError, '附近条件不够，我先停一下，别乱动。')
  assert.ok(logs.some(line => line.includes('key=ore_not_found')))

  const died = createTaskReminderEvent({ id: 5, type: 'mining', interruptReason: 'bot_died' }, 'interrupted', { logger: noLog })
  assert.strictEqual(defaultReminderText(died), '挖矿先停下了，我死了一次，手上的事都停了')

  // The player stopped it themselves: no reason to explain (real machine said 这一步没处理完整).
  const stopped = createTaskReminderEvent({ id: 6, type: 'follow_player', interruptReason: 'player_command' }, 'interrupted', { logger: noLog })
  assert.strictEqual(defaultReminderText(stopped), '跟随先停下了，我等你下一步安排。')
}

async function run() {
  await testFailureReasonTableCoversTheMeasuredCases()
  await testInventoryEventAndPersonaText()
  await testDangerFactMustBePreserved()
  await testLlmPersonaTextWhenSafe()
  await testLlmFailureFallsBack()
  await testBotStatusOwnerUsesFirstPerson()
  await testGoalSystemProducesReminderEvent()
  await testBuildGoalReminderEvent()
  await testTaskFeedbackEventShape()
  await testUnsupportedToolTierFeedbackIsFriendly()
  await testLlmTimeoutFeedbackIsPlayerFriendly()
  console.log('message-generator tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
