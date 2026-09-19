const assert = require('assert')
const { ACTION_KEYS } = require('../ai/action-keys')
const { parseIntent } = require('../ai/intent-parser')
const { intentToTask } = require('../ai/intent-to-task')

function testChineseSmeltingCount() {
  const parsed = parseIntent('\u70e7\u4e24\u4e2a\u94c1\u77ff')
  assert.strictEqual(parsed.actionKey, ACTION_KEYS.SMELT_ITEM)
  assert.strictEqual(parsed.params.itemName, 'raw_iron')
  assert.strictEqual(parsed.params.count, 2)
  assert.notStrictEqual(parsed.params.parallelFurnaces, true)
}

function testExplicitParallelSmelting() {
  const parallel = parseIntent('\u5e76\u884c\u70e710\u4e2a\u94c1\u77ff')
  assert.strictEqual(parallel.actionKey, ACTION_KEYS.SMELT_ITEM)
  assert.strictEqual(parallel.params.itemName, 'raw_iron')
  assert.strictEqual(parallel.params.count, 10)
  assert.strictEqual(parallel.params.parallelFurnaces, true)

  const twoFurnaces = parseIntent('\u7528\u4e24\u4e2a\u7089\u5b50\u70e710\u4e2a\u94c1\u77ff')
  assert.strictEqual(twoFurnaces.actionKey, ACTION_KEYS.SMELT_ITEM)
  assert.strictEqual(twoFurnaces.params.itemName, 'raw_iron')
  assert.strictEqual(twoFurnaces.params.count, 10)
  assert.strictEqual(twoFurnaces.params.parallelFurnaces, true)
}

function testDefaultSmeltingStaysSingleFurnace() {
  const smelt = parseIntent('\u70e710\u4e2a\u94c1\u77ff')
  assert.strictEqual(smelt.actionKey, ACTION_KEYS.SMELT_ITEM)
  assert.strictEqual(smelt.params.itemName, 'raw_iron')
  assert.strictEqual(smelt.params.count, 10)
  assert.notStrictEqual(smelt.params.parallelFurnaces, true)

  const cook = parseIntent('\u70e410\u4e2a\u725b\u8089')
  assert.strictEqual(cook.actionKey, ACTION_KEYS.COOK_ITEM)
  assert.strictEqual(cook.params.count, 10)
  assert.notStrictEqual(cook.params.parallelFurnaces, true)
}

async function testIntentToTaskForwardsParallelFurnaces() {
  const enqueued = []
  const taskManager = {
    enqueue(type, params, priority, source) {
      const task = { id: 1, type, params, priority, source }
      enqueued.push(task)
      return task
    }
  }
  const decision = parseIntent('\u5e76\u884c\u70e710\u4e2a\u94c1\u77ff')
  decision.shouldExecute = true

  const result = await intentToTask(decision, { taskManager, logger: { log() {} } })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(enqueued.length, 1)
  assert.strictEqual(enqueued[0].type, 'smelt_item')
  assert.strictEqual(enqueued[0].params.inputName, 'raw_iron')
  assert.strictEqual(enqueued[0].params.count, 10)
  assert.strictEqual(enqueued[0].params.parallelFurnaces, true)
}

async function run() {
  testChineseSmeltingCount()
  testExplicitParallelSmelting()
  testDefaultSmeltingStaysSingleFurnace()
  await testIntentToTaskForwardsParallelFurnaces()
}

run()
  .then(() => console.log('smelting intent tests passed'))
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
