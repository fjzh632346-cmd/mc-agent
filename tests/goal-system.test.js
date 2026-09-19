const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')
const { GoalSystem, GOAL_TYPES } = require('../ai/goal-system')

function createContext(state = {}, options = {}) {
  const blackboard = new Blackboard({
    bot: {
      health: 20,
      food: 20,
      position: { x: 0, y: 64, z: 0 }
    },
    mobs: {
      dangerLevel: 'none',
      nearestHostileMob: null
    },
    inventory: {
      emptySlots: 10,
      foodCount: 0
    },
    world: {
      isDay: true
    },
    tasks: {
      currentTask: null
    },
    ...state
  })

  const taskManager = {
    enqueued: [],
    interrupted: null,
    enqueue(type, params, priority, source) {
      const task = { type, params, priority, source }
      this.enqueued.push(task)
      return task
    },
    async interruptCurrent(reason) {
      this.interrupted = reason
      return true
    }
  }

  const memory = options.memory || {
    summary() {
      return {
        world: {
          hasBaseLocation: Boolean(options.hasBaseLocation),
          chestLocations: options.chestLocations || 0
        },
        task: { total: 0 }
      }
    }
  }

  const bot = {
    inventory: {
      items: () => options.foodItems || []
    },
    async equip(item) {
      this.equipped = item
    },
    async consume() {
      this.consumed = true
    }
  }

  return {
    actionLock: new ActionLock(),
    blackboard,
    bot,
    memory,
    taskManager,
    logger: { error() {}, log() {} }
  }
}

async function testLowHealth() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    bot: { health: 8, food: 20 },
    inventory: { emptySlots: 10, foodCount: 1 }
  }, {
    foodItems: [{ name: 'bread', count: 1 }]
  })

  await goalSystem.update(context)
  assert.strictEqual(goalSystem.lastTriggeredGoal.type, GOAL_TYPES.LOW_HEALTH)
  assert.strictEqual(goalSystem.lastAction.type, 'TASK')
  assert.strictEqual(context.taskManager.enqueued[0].type, 'eat_food')
}

async function testLowFood() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    bot: { health: 20, food: 6 },
    inventory: { emptySlots: 10, foodCount: 0 }
  })

  await goalSystem.update(context)
  assert.strictEqual(goalSystem.lastTriggeredGoal.type, GOAL_TYPES.LOW_FOOD)
  assert.strictEqual(goalSystem.lastAction.type, 'REMINDER')
}

async function testDangerNearbyCreatesGuardTask() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    bot: { health: 20, food: 20 },
    mobs: {
      dangerLevel: 'high',
      nearestHostileMob: { name: 'zombie', distance: 3 }
    }
  })

  await goalSystem.update(context)
  assert.strictEqual(goalSystem.lastTriggeredGoal.type, GOAL_TYPES.DANGER_NEARBY)
  assert.strictEqual(context.taskManager.enqueued[0].type, 'guard_player')
}

async function testInventoryFullInterruptsCollectTask() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    inventory: { emptySlots: 0, foodCount: 0 },
    tasks: { currentTask: { type: 'mining' } }
  }, {
    hasBaseLocation: true
  })

  await goalSystem.update(context)
  assert.ok(goalSystem.completedGoals.some(goal => goal.type === GOAL_TYPES.INVENTORY_FULL))
  assert.strictEqual(context.taskManager.interrupted, 'survival_inventory_full')
  assert.strictEqual(context.taskManager.enqueued[0].type, 'return_to_base')
}

async function testNightWarning() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    bot: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
    player: { ownerPosition: { x: 80, y: 64, z: 0 } },
    world: { isDay: false }
  }, {
    hasBaseLocation: true
  })

  await goalSystem.update(context)
  assert.strictEqual(goalSystem.lastTriggeredGoal.type, GOAL_TYPES.NIGHT_WARNING)
  assert.strictEqual(goalSystem.lastAction.type, 'TASK')
  assert.strictEqual(context.taskManager.enqueued[0].type, 'return_to_base')
}

async function testCooldownPreventsSpam() {
  const goalSystem = new GoalSystem({ cooldownMs: 60000 })
  const context = createContext({
    bot: { health: 20, food: 6 },
    inventory: { emptySlots: 10, foodCount: 0 }
  })

  await goalSystem.update(context)
  await goalSystem.update(context)
  assert.strictEqual(goalSystem.completedGoals.filter(goal => goal.type === GOAL_TYPES.LOW_FOOD).length, 1)
}

async function testReturnToBaseSuggestion() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    inventory: { emptySlots: 0, foodCount: 0 }
  }, {
    hasBaseLocation: true
  })

  await goalSystem.update(context)
  const types = goalSystem.completedGoals.map(goal => goal.type)
  assert.ok(types.includes(GOAL_TYPES.INVENTORY_FULL))
  assert.ok(!types.includes(GOAL_TYPES.RETURN_TO_BASE_SUGGESTION))
}

async function testGoalSystemErrorDoesNotCrash() {
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })
  const context = createContext({
    bot: { health: 20, food: 6 },
    inventory: { emptySlots: 10, foodCount: 0 }
  })
  context.blackboard.update = () => {
    throw new Error('mock blackboard failure')
  }

  const status = await goalSystem.update(context)
  assert.ok(status.lastAction)
}

async function testGoalSystemCallsPlanningSystem() {
  const context = createContext({
    bot: { health: 20, food: 6 },
    inventory: { emptySlots: 10, foodCount: 0 }
  })
  let calledGoal = null
  context.planningSystem = {
    async createAndSubmitPlan(goalType) {
      calledGoal = goalType
      return { ok: true, plan: { goalType, status: 'COMPLETED' } }
    }
  }
  const goalSystem = new GoalSystem({ cooldownMs: 1000 })

  await goalSystem.update(context)
  assert.strictEqual(calledGoal, null)
  assert.strictEqual(goalSystem.lastAction.type, 'REMINDER')
}

async function run() {
  await testLowHealth()
  await testLowFood()
  await testDangerNearbyCreatesGuardTask()
  await testInventoryFullInterruptsCollectTask()
  await testNightWarning()
  await testCooldownPreventsSpam()
  await testReturnToBaseSuggestion()
  await testGoalSystemErrorDoesNotCrash()
  await testGoalSystemCallsPlanningSystem()
  console.log('goal-system tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
