const assert = require('assert')
const { Blackboard } = require('../core/blackboard')
const { WorldState } = require('../perception/world-state')
const { TickLoop } = require('../core/tick-loop')

function vec(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.sqrt((x - other.x) ** 2 + (y - other.y) ** 2 + (z - other.z) ** 2)
    }
  }
}

function createMockBot() {
  const botPosition = vec(0, 64, 0)
  const ownerPosition = vec(3, 64, 0)
  const zombiePosition = vec(5, 64, 0)
  const cowPosition = vec(8, 64, 0)
  const itemPosition = vec(2, 64, 1)

  return {
    username: 'PartnerBot',
    health: 18,
    food: 17,
    game: { dimension: 'overworld' },
    isRaining: false,
    thunderState: 0,
    time: { timeOfDay: 6000 },
    entity: {
      position: botPosition,
      onGround: true
    },
    players: {
      Alex: {
        username: 'Alex',
        entity: {
          id: 2,
          username: 'Alex',
          position: ownerPosition,
          type: 'player'
        }
      }
    },
    entities: {
      1: { id: 1, name: 'zombie', type: 'mob', position: zombiePosition },
      2: { id: 2, name: 'cow', type: 'mob', position: cowPosition },
      3: { id: 3, name: 'item', type: 'object', position: itemPosition },
      4: {
        id: 4,
        name: 'armor_stand',
        type: 'object',
        displayName: 'Armor Stand',
        position: vec(9, 64, 0),
        get objectType() {
          throw new Error('deprecated objectType getter should not be used')
        },
        get mobType() {
          throw new Error('deprecated mobType getter should not be used')
        }
      }
    },
    heldItem: { name: 'stone_pickaxe', count: 1, type: 1 },
    inventory: {
      items() {
        return [
          { name: 'bread', count: 3 },
          { name: 'stone_pickaxe', count: 1 },
          { name: 'dirt', count: 12 }
        ]
      },
      slots: Array.from({ length: 45 }, (_, index) => {
        if (index < 9) return null
        if (index < 12) return { name: 'occupied' }
        return null
      })
    },
    blockAt(position) {
      if (position.y < 64) return { name: 'stone' }
      if (position.y === 64) return { name: 'grass_block' }
      return { name: 'air' }
    },
    canSeeEntity() {
      return true
    }
  }
}

async function testBlackboardSetGetUpdate() {
  const blackboard = new Blackboard()
  blackboard.set('bot.health', 12)
  blackboard.update({ mobs: { dangerLevel: 'medium' } })
  blackboard.pushRecentEvent({ type: 'test_event' })

  assert.strictEqual(blackboard.get('bot.health'), 12)
  assert.strictEqual(blackboard.get('mobs.dangerLevel'), 'medium')
  assert.strictEqual(blackboard.get('events.recent').length, 1)
}

async function testWorldStateWithMockBot() {
  const blackboard = new Blackboard({ config: { ownerName: 'Alex' } })
  const worldState = new WorldState({ entityScanRadius: 16, blockScanRadius: 1 })
  const snapshot = worldState.update({
    bot: createMockBot(),
    blackboard,
    taskManager: {
      status() {
        return {
          currentTask: { id: 1, type: 'follow_player' },
          queue: [],
          pausedStack: [],
          locks: { locks: {} }
        }
      }
    }
  })

  assert.strictEqual(snapshot.bot.health, 18)
  assert.strictEqual(snapshot.player.owner.username, 'Alex')
  assert.strictEqual(snapshot.player.ownerDistance, 3)
  assert.strictEqual(snapshot.mobs.hostileMobs[0].name, 'zombie')
  assert.strictEqual(snapshot.mobs.passiveMobs[0].name, 'cow')
  assert.strictEqual(snapshot.mobs.nearestHostileMob.name, 'zombie')
  assert.strictEqual(snapshot.mobs.dangerLevel, 'medium')
  assert.strictEqual(snapshot.inventory.emptySlots, 33)
  assert.strictEqual(snapshot.inventory.foodCount, 3)
  assert.strictEqual(snapshot.inventory.toolCount, 1)
  assert.strictEqual(blackboard.get('tasks.currentTask.type'), 'follow_player')
}

async function testTickLoopLifecycleAndUpdates() {
  let worldUpdates = 0
  let goalUpdates = 0
  let taskUpdates = 0
  const calls = []
  const loop = new TickLoop({
    intervalMs: 1000,
    logger: { log() {}, error() {} },
    worldState: {
      update() {
        worldUpdates += 1
        calls.push('world')
      }
    },
    goalSystem: {
      update() {
        goalUpdates += 1
        calls.push('goals')
      }
    },
    taskManager: {
      update() {
        taskUpdates += 1
        calls.push('tasks')
      }
    }
  })

  assert.strictEqual(loop.isRunning(), false)
  assert.strictEqual(loop.start(), true)
  assert.strictEqual(loop.start(), false)
  assert.strictEqual(loop.isRunning(), true)
  assert.strictEqual(loop.stop(), true)
  assert.strictEqual(loop.isRunning(), false)

  await loop.updateOnce()
  assert.strictEqual(worldUpdates, 1)
  assert.strictEqual(goalUpdates, 1)
  assert.strictEqual(taskUpdates, 1)
  assert.deepStrictEqual(calls, ['world', 'goals', 'tasks'])
}

async function testTickLoopSurvivesUpdateErrors() {
  const errors = []
  const loop = new TickLoop({
    logger: {
      log() {},
      error(...args) {
        errors.push(args)
      }
    },
    worldState: {
      update() {
        throw new Error('mock world failure')
      }
    },
    taskManager: {
      update() {
        throw new Error('should not run')
      }
    }
  })

  const result = await loop.updateOnce()
  assert.strictEqual(result, false)
  assert.strictEqual(errors.length, 2)
  assert.strictEqual(errors[0][0], '[TickLoop] update failed:')
  assert.ok(errors[0][1] instanceof Error)
  assert.ok(String(errors[1][0]).includes('mock world failure'))
  assert.strictEqual(loop.isRunning(), false)
}

async function testTickLoopThrottlesRepeatedErrors() {
  const errors = []
  let now = 1000
  const originalNow = Date.now
  Date.now = () => now

  try {
    const loop = new TickLoop({
      errorThrottleMs: 5000,
      logger: {
        log() {},
        error(...args) {
          errors.push(args)
        }
      },
      worldState: {
        update() {
          throw new Error('same failure')
        }
      }
    })

    await loop.updateOnce()
    await loop.updateOnce()
    await loop.updateOnce()
    assert.strictEqual(errors.length, 2)

    now += 5000
    await loop.updateOnce()
    assert.strictEqual(errors.length, 3)
    assert.ok(String(errors[2][0]).includes('suppressed 2 repeats'))
  } finally {
    Date.now = originalNow
  }
}

async function run() {
  await testBlackboardSetGetUpdate()
  await testWorldStateWithMockBot()
  await testTickLoopLifecycleAndUpdates()
  await testTickLoopSurvivesUpdateErrors()
  await testTickLoopThrottlesRepeatedErrors()
  console.log('tick-loop/world-state tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
