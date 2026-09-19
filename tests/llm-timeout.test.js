const assert = require('assert')
const { ACTION_KEYS } = require('../ai/action-keys')
const { createLlmActionKeyClassifier } = require('../ai/action-key-classifier')
const { routePlayerCommand } = require('../ai/command-router')
const { createChatCompletion, isLlmError } = require('../ai/llm-client')
const { MessageGenerator, REMINDER_TYPES, createReminderEvent } = require('../ai/message-generator')
const { TickLoop } = require('../core/tick-loop')
const { TaskManager } = require('../tasks/task-manager')
const { BaseTask, TASK_STATE } = require('../tasks/base-task')
const { GoalSystem } = require('../ai/goal-system')
const { SurvivalSystem } = require('../systems/survival-system')

class CompletingTask extends BaseTask {
  get requiredLocks() {
    return ['movement']
  }

  async update(ctx) {
    this.acquireLocks(ctx)
    await this.complete(ctx, { ok: true })
  }
}

class FailingTask extends BaseTask {
  get requiredLocks() {
    return ['movement']
  }

  async update(ctx) {
    this.acquireLocks(ctx)
    await this.fail(ctx, 'real_task_failure')
  }
}

function neverReturningClient() {
  return {
    chat: {
      completions: {
        create() {
          return new Promise(() => {})
        }
      }
    }
  }
}

function delayedRejectingClient(delayMs = 30) {
  return {
    chat: {
      completions: {
        create() {
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late api failure')), delayMs)
          })
        }
      }
    }
  }
}

function createTaskManagerMock() {
  return {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source }
      this.enqueued.push(task)
      return task
    },
    status() {
      return { currentTask: null, queue: [], pausedStack: [] }
    }
  }
}

function quietLogger(logs = []) {
  return {
    log(message) { logs.push(String(message)) },
    warn(message) { logs.push(String(message)) },
    error(message) { logs.push(String(message)) }
  }
}

async function testWrapperTimesOutWithTypedError() {
  const logs = []
  await assert.rejects(
    () => createChatCompletion(neverReturningClient(), {
      model: 'test',
      messages: [{ role: 'user', content: 'SECRET_PROMPT_DO_NOT_LOG' }]
    }, {
      context: 'test_wrapper',
      inputType: 'unit',
      timeoutMs: 10,
      logger: quietLogger(logs),
      fallback: 'unit_fallback'
    }),
    error => {
      assert.strictEqual(error.code, 'LLM_TIMEOUT')
      assert.strictEqual(isLlmError(error), true)
      return true
    }
  )
  assert.ok(logs.some(line => line.includes('LLM_TIMEOUT') && line.includes('test_wrapper')))
  assert.strictEqual(logs.some(line => line.includes('SECRET_PROMPT_DO_NOT_LOG')), false)
}

async function testNoUnhandledRejectionAfterTimeout() {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(
      () => createChatCompletion(delayedRejectingClient(25), {
        model: 'test',
        messages: [{ role: 'user', content: 'x' }]
      }, {
        context: 'late_reject',
        inputType: 'unit',
        timeoutMs: 5,
        logger: quietLogger()
      }),
      error => error.code === 'LLM_TIMEOUT'
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepStrictEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
}

async function testExplicitRuleRoutesWhenLlmWouldHang() {
  const taskManager = createTaskManagerMock()
  const result = await routePlayerCommand('挖石头', {
    taskManager,
    playerName: 'Alex',
    llmClassifier: createLlmActionKeyClassifier(neverReturningClient(), { timeoutMs: 10 }),
    logger: quietLogger()
  })

  assert.strictEqual(result.actionKey, ACTION_KEYS.MINE_BLOCK)
  assert.strictEqual(result.whetherExecuted, true)
  assert.strictEqual(taskManager.enqueued.length, 1)
  assert.strictEqual(taskManager.enqueued[0].type, 'mining')
}

async function testLlmTimeoutFallsBackWithoutCreatingTask() {
  const taskManager = createTaskManagerMock()
  const logs = []
  const classifier = createLlmActionKeyClassifier(neverReturningClient(), { timeoutMs: 10 })
  const result = await routePlayerCommand('ambiguous moon square request', {
    taskManager,
    playerName: 'Alex',
    llmClassifier: classifier,
    logger: quietLogger(logs)
  })

  assert.strictEqual(result.handled, true)
  assert.strictEqual(result.actionKey, ACTION_KEYS.CHAT)
  assert.strictEqual(result.action.action, 'chat')
  assert.strictEqual(result.action.code, 'LLM_TIMEOUT')
  assert.strictEqual(result.whetherExecuted, false)
  assert.strictEqual(taskManager.enqueued.length, 0)
  assert.ok(result.action.message.includes('\u7406\u89e3\u6709\u70b9\u6162'))
  assert.ok(logs.some(line => line.includes('LLM_TIMEOUT')))
  assert.strictEqual(logs.some(line => line.includes('ambiguous moon')), false)
}

async function testMessageGeneratorTimeoutUsesFallback() {
  const event = createReminderEvent(REMINDER_TYPES.LOW_HEALTH, {
    facts: { health: 5, statusOwner: 'bot' }
  })
  const logs = []
  const generator = new MessageGenerator({
    client: neverReturningClient(),
    timeoutMs: 10,
    persona: { username: 'LinXia' }
  })

  const result = await generator.generate(event, { logger: quietLogger(logs) })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.source, 'fallback')
  assert.ok(result.text)
  assert.ok(logs.some(line => line.includes('LLM_TIMEOUT') && line.includes('message_generator')))
}

async function testTaskFeedbackTimeoutDoesNotMarkFailedTaskCompleted() {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [],
      slots: Array(45).fill(null)
    }
  }
  const manager = new TaskManager(bot, {
    enabled: false,
    debug: false,
    messageGenerator: new MessageGenerator({
      client: neverReturningClient(),
      timeoutMs: 10,
      persona: { username: 'LinXia' }
    }),
    logger: quietLogger()
  })
  const task = new BaseTask({ id: 99, type: 'mock_task' })
  task.state = TASK_STATE.FAILED
  task.error = 'real_task_failure'
  manager.currentTask = task

  await manager.tick({ logger: quietLogger() })
  assert.strictEqual(manager.completed.length, 0)
  assert.strictEqual(manager.failed.length, 1)
  assert.strictEqual(manager.failed[0].state, TASK_STATE.FAILED)
  assert.strictEqual(manager.failed[0].error, 'real_task_failure')
}

async function testTaskFeedbackDoesNotBlockTaskManagerCompletion() {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [],
      slots: Array(45).fill(null)
    }
  }
  const blackboardUpdates = []
  const spoken = []
  const manager = new TaskManager(bot, {
    enabled: false,
    debug: false,
    messageGenerator: {
      generate() {
        return new Promise(() => {})
      }
    },
    reminderOutput(text) {
      spoken.push(text)
    },
    logger: quietLogger()
  })
  const task = new CompletingTask({ id: 100, type: 'mock_complete' })
  const nextTask = new BaseTask({ id: 101, type: 'mock_next' })
  manager.currentTask = task
  manager.queue.push(nextTask)

  const blackboard = {
    update(value) {
      blackboardUpdates.push(value)
    },
    set() {}
  }
  const outcome = await Promise.race([
    manager.tick({ blackboard }).then(() => 'done'),
    new Promise(resolve => setImmediate(() => resolve('pending')))
  ])

  assert.strictEqual(outcome, 'done')
  assert.strictEqual(manager.currentTask, null)
  assert.strictEqual(manager.completed.length, 1)
  assert.strictEqual(manager.completed[0].state, TASK_STATE.COMPLETED)
  assert.strictEqual(manager.actionLock.getOwner('movement'), null)
  assert.ok(spoken.length >= 1)
  assert.ok(blackboardUpdates.some(update => update?.tasks?.currentTask === null))

  await manager.tick({ blackboard })
  assert.strictEqual(manager.currentTask, nextTask)
}

async function testRejectedAsyncTaskFeedbackDoesNotChangeResultOrLeakUnhandled() {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [],
      slots: Array(45).fill(null)
    }
  }
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const logs = []
    const manager = new TaskManager(bot, {
      enabled: false,
      debug: true,
      messageGenerator: {
        generate() {
          return Promise.reject(new Error('feedback api failed'))
        }
      },
      logger: quietLogger(logs)
    })
    manager.debug = message => logs.push(String(message))
    manager.currentTask = new FailingTask({ id: 102, type: 'mock_fail' })

    await manager.tick({
      blackboard: {
        update() {},
        set() {}
      }
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.deepStrictEqual(unhandled, [])
    assert.strictEqual(manager.currentTask, null)
    assert.strictEqual(manager.completed.length, 0)
    assert.strictEqual(manager.failed.length, 1)
    assert.strictEqual(manager.failed[0].state, TASK_STATE.FAILED)
    assert.strictEqual(manager.failed[0].error, 'real_task_failure')
    assert.strictEqual(manager.actionLock.getOwner('movement'), null)
    assert.ok(logs.some(line => line.includes('async task feedback skipped')))
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
}

async function testTickLoopIsBoundedByLlmTimeout() {
  const start = Date.now()
  const generator = new MessageGenerator({
    client: neverReturningClient(),
    timeoutMs: 10,
    persona: { username: 'LinXia' }
  })
  const loop = new TickLoop({
    logger: quietLogger(),
    worldState: { update() {} },
    goalSystem: {
      async update(context) {
        const event = createReminderEvent(REMINDER_TYPES.LOW_FOOD, {
          facts: { food: 3, statusOwner: 'bot' }
        })
        await context.messageGenerator.generate(event, context)
      }
    },
    taskManager: { update() {} },
    messageGenerator: generator
  })

  const result = await loop.updateOnce()
  assert.strictEqual(result, true)
  assert.ok(Date.now() - start < 200)
}

async function testGoalReminderDoesNotAwaitLlmInTickPath() {
  const start = Date.now()
  let spoken = null
  const goalSystem = new GoalSystem({ cooldownMs: 1, enableSurvivalSystem: false })
  const context = {
    blackboard: {
      snapshot: () => ({
        bot: { health: 20, food: 20 },
        inventory: { emptySlots: 0, foodCount: 0 },
        mobs: {},
        world: { isDay: true }
      }),
      set() {},
      update() {}
    },
    taskManager: {
      async interruptCurrent() {}
    },
    memory: {
      summary: () => ({ world: { chestLocations: 0, hasBaseLocation: false } })
    },
    messageGenerator: {
      generate() {
        return new Promise(() => {})
      }
    },
    reminderOutput(text) {
      spoken = text
    },
    logger: quietLogger()
  }

  await goalSystem.update(context)
  assert.strictEqual(goalSystem.lastAction.type, 'REMINDER')
  assert.ok(spoken)
  assert.ok(Date.now() - start < 100)
}

async function testSurvivalReminderDoesNotAwaitLlmInTickPath() {
  const start = Date.now()
  let spoken = null
  const survivalSystem = new SurvivalSystem({ cooldownMs: 1 })
  const context = {
    blackboard: {
      set() {}
    },
    messageGenerator: {
      generate() {
        return new Promise(() => {})
      }
    },
    reminderOutput(text) {
      spoken = text
    },
    logger: quietLogger()
  }
  survivalSystem.lastState = { food: 3, health: 20 }

  await survivalSystem.remind(context, {
    priority: 'LOW_FOOD_WARNING',
    action: 'REMIND',
    riskLevel: 'medium',
    reason: 'low_food'
  })

  assert.ok(spoken)
  assert.ok(Date.now() - start < 100)
}

async function run() {
  await testWrapperTimesOutWithTypedError()
  await testNoUnhandledRejectionAfterTimeout()
  await testExplicitRuleRoutesWhenLlmWouldHang()
  await testLlmTimeoutFallsBackWithoutCreatingTask()
  await testMessageGeneratorTimeoutUsesFallback()
  await testTaskFeedbackTimeoutDoesNotMarkFailedTaskCompleted()
  await testTaskFeedbackDoesNotBlockTaskManagerCompletion()
  await testRejectedAsyncTaskFeedbackDoesNotChangeResultOrLeakUnhandled()
  await testTickLoopIsBoundedByLlmTimeout()
  await testGoalReminderDoesNotAwaitLlmInTickPath()
  await testSurvivalReminderDoesNotAwaitLlmInTickPath()
  console.log('llm-timeout tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
