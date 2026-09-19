const assert = require('assert')
const { Blackboard } = require('../core/blackboard')
const { PlanningSystem, PLAN_STATUS } = require('../ai/planning-system')
const { routePlayerCommand } = require('../ai/command-router')

function createContext(counts = {}, options = {}) {
  const blackboard = new Blackboard({
    inventory: { counts },
    bot: { position: { x: 0, y: 64, z: 0 } }
  })
  const taskManager = {
    enqueued: [],
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source, state: 'COMPLETED', result: { ok: true } }
      this.enqueued.push(task)
      return task
    },
    status() {
      return {
        currentTask: null,
        queue: [],
        pausedStack: [],
        recentCompleted: this.enqueued,
        recentFailed: [],
        recentInterrupted: []
      }
    }
  }
  const memory = {
    summary() {
      return {
        world: { hasBaseLocation: Boolean(options.hasBaseLocation) },
        task: { total: 0 }
      }
    },
    world: {
      baseLocation: options.hasBaseLocation ? { position: { x: 1, y: 64, z: 1 } } : null
    }
  }
  return { blackboard, taskManager, memory, planningSystem: new PlanningSystem() }
}

async function testPlanGeneration() {
  let context = createContext({ coal: 1, stick: 1 })
  let created = context.planningSystem.createPlan('make_torch', context)
  assert.strictEqual(created.ok, true)
  assert.deepStrictEqual(created.plan.steps.map(step => step.type), ['CHECK_ANY_ITEM', 'CHECK_ITEM', 'CRAFT_ITEM'])

  context = createContext({ stick: 1 })
  created = context.planningSystem.createPlan('make_stone_pickaxe', context)
  assert.strictEqual(created.plan.steps.some(step => step.type === 'MINE_BLOCKS' && step.target === 'cobblestone'), true)
  assert.strictEqual(created.plan.steps.at(-1).target, 'stone_pickaxe')

  context = createContext({ stick: 2 })
  created = context.planningSystem.createPlan('make_iron_pickaxe', context)
  assert.strictEqual(created.plan.steps.some(step => step.type === 'MINE_BLOCKS' && step.ore === 'iron'), true)
  assert.strictEqual(created.plan.steps.some(step => step.type === 'SMELT_ITEM' && step.target === 'iron_ingot'), true)
}

async function testPlanExecutionStatus() {
  const context = createContext({ coal: 1, stick: 1 })
  const result = await context.planningSystem.createAndSubmitPlan('make_torch', context)
  await context.planningSystem.update(context)
  await context.planningSystem.update(context)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.plan.status, PLAN_STATUS.COMPLETED)
  assert.strictEqual(context.taskManager.enqueued[0].type, 'craft_item')
  assert.strictEqual(context.planningSystem.status().recentCompletedPlans.at(-1).goalType, 'make_torch')
}

async function testPlanFailureAndUnsupported() {
  let context = createContext({ stick: 2 })
  let result = await context.planningSystem.createAndSubmitPlan('make_iron_pickaxe', context)
  assert.strictEqual(result.ok, true)
  await context.planningSystem.update(context)
  assert.strictEqual(context.taskManager.enqueued.some(task => task.type === 'mining'), true)

  context = createContext()
  result = context.planningSystem.createPlan('make_diamond_castle', context)
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'unsupported_plan_goal')
}

async function testReturnSafePlan() {
  let context = createContext({}, { hasBaseLocation: false })
  let result = await context.planningSystem.createAndSubmitPlan('return_safe', context)
  await context.planningSystem.update(context)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(context.taskManager.enqueued[0].type, 'return_to_player')

  context = createContext({}, { hasBaseLocation: true })
  result = await context.planningSystem.createAndSubmitPlan('return_safe', context)
  await context.planningSystem.update(context)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(context.taskManager.enqueued[0].type, 'return_to_base')
}

async function testCommandRouterCreatesPlan() {
  const context = createContext({ stick: 2, iron_ingot: 3 })
  const result = await routePlayerCommand('做个铁镐', {
    ...context,
    playerName: 'Alex'
  })
  assert.strictEqual(result.actionKey, 'CRAFT_ITEM')
  assert.strictEqual(result.action.action, 'enqueue_task')
  assert.strictEqual(context.taskManager.enqueued[0].type, 'craft_item')
  assert.strictEqual(context.taskManager.enqueued[0].params.itemName, 'iron_pickaxe')
}

async function testPlanningSystemErrorDoesNotCrash() {
  const planningSystem = new PlanningSystem()
  const result = await planningSystem.createAndSubmitPlan('make_torch', {
    blackboard: {
      get() {
        throw new Error('mock inventory failure')
      }
    }
  })
  assert.strictEqual(result.ok, false)
}

async function run() {
  await testPlanGeneration()
  await testPlanExecutionStatus()
  await testPlanFailureAndUnsupported()
  await testReturnSafePlan()
  await testCommandRouterCreatesPlan()
  await testPlanningSystemErrorDoesNotCrash()
  console.log('planning-system tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
