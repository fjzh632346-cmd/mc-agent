const assert = require('assert')
const { Blackboard } = require('../core/blackboard')
const { PlanningSystem, PLAN_STATUS } = require('../ai/planning-system')

function createTaskManagerMock({ failTask = false } = {}) {
  return {
    enqueued: [],
    completedIds: new Set(),
    failedIds: new Set(),
    enqueue(type, params, priority, source) {
      const task = { id: this.enqueued.length + 1, type, params, priority, source, state: 'RUNNING' }
      this.enqueued.push(task)
      return task
    },
    completeNext() {
      const task = this.enqueued.find(candidate => candidate.state === 'RUNNING')
      if (!task) return
      task.state = failTask ? 'FAILED' : 'COMPLETED'
      task.error = failTask ? 'mock_task_failed' : null
      task.result = { ok: !failTask }
      if (failTask) this.failedIds.add(task.id)
      else this.completedIds.add(task.id)
    },
    status() {
      return {
        currentTask: this.enqueued.find(task => task.state === 'RUNNING') || null,
        queue: [],
        pausedStack: [],
        recentCompleted: this.enqueued.filter(task => task.state === 'COMPLETED'),
        recentFailed: this.enqueued.filter(task => task.state === 'FAILED'),
        recentInterrupted: []
      }
    }
  }
}

function createContext(counts = {}, options = {}) {
  return {
    blackboard: new Blackboard({
      inventory: { counts },
      mobs: { dangerLevel: 'none' }
    }),
    taskManager: options.taskManager || createTaskManagerMock(),
    memory: {
      summary() {
        return { world: { hasBaseLocation: Boolean(options.hasBaseLocation) }, task: { total: 0 } }
      },
      world: {
        baseLocation: options.hasBaseLocation ? { position: { x: 1, y: 64, z: 1 } } : null
      }
    }
  }
}

async function testPlanExecutorRunsInOrder() {
  const planningSystem = new PlanningSystem()
  const context = createContext({ coal: 1, stick: 1 })
  const submitted = await planningSystem.createAndSubmitPlan('make_torch', context)
  assert.strictEqual(submitted.ok, true)

  await planningSystem.update(context)
  assert.strictEqual(context.taskManager.enqueued[0].type, 'craft_item')
  assert.strictEqual(planningSystem.status().currentStep.type, 'CRAFT_ITEM')

  context.taskManager.completeNext()
  await planningSystem.update(context)
  assert.strictEqual(submitted.plan.status, PLAN_STATUS.COMPLETED)
}

async function testPlanFailsWhenStepTaskFails() {
  const taskManager = createTaskManagerMock({ failTask: true })
  const planningSystem = new PlanningSystem()
  const context = createContext({ coal: 1, stick: 1 }, { taskManager })
  const submitted = await planningSystem.createAndSubmitPlan('make_torch', context)

  await planningSystem.update(context)
  taskManager.completeNext()
  await planningSystem.update(context)

  assert.strictEqual(submitted.plan.status, PLAN_STATUS.FAILED)
  assert.strictEqual(planningSystem.status().failureReason, 'mock_task_failed')
  assert.strictEqual(planningSystem.status().failedStep.type, 'CRAFT_ITEM')
}

async function run() {
  await testPlanExecutorRunsInOrder()
  await testPlanFailsWhenStepTaskFails()
  console.log('plan executor tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
