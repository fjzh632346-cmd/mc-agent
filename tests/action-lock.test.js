const assert = require('assert')
const { ActionLock } = require('../core/action-lock')
const { BaseTask } = require('../tasks/base-task')
const { TaskManager, TASK_TYPES } = require('../tasks/task-manager')
const { FollowTask } = require('../tasks/follow-task')
const { MineNearbyBlockTask } = require('../tasks/mine-nearby-block-task')

function createMockBot() {
  const position = { distanceTo: () => 0 }
  return {
    username: 'TestBot',
    entity: { position },
    entities: {},
    players: {},
    inventory: { items: () => [] },
    time: { timeOfDay: 6000 },
    pathfinder: {
      stop() {},
      setGoal() {},
      setMovements() {}
    },
    pvp: {
      attack() {},
      stop() {}
    }
  }
}

class HoldMovementTask extends BaseTask {
  constructor(options) {
    super({ ...options, type: 'hold_movement' })
    this.updates = 0
  }

  get requiredLocks() {
    return ['movement']
  }

  async update(ctx) {
    await super.update(ctx)
    const locks = this.acquireLocks(ctx)
    if (!locks.ok) return
    this.updates += 1
  }
}

async function testConflictingMovementLock() {
  const actionLock = new ActionLock()
  const follow = new FollowTask({ id: 'follow', priority: 1, params: {} })
  const mine = new MineNearbyBlockTask({ id: 'mine', priority: 1, params: {} })
  const ctx = { actionLock, debug() {} }

  assert.strictEqual(follow.acquireLocks(ctx).ok, true)
  const blocked = mine.acquireLocks(ctx)

  assert.strictEqual(blocked.ok, false)
  assert.strictEqual(blocked.reason, 'lock_already_held')
  assert.strictEqual(blocked.type, 'movement')
  assert.strictEqual(actionLock.getOwner('movement'), 'follow')
}

async function testHighPriorityPreemptsAndRestoresLowPriorityTask() {
  TASK_TYPES.hold_movement = HoldMovementTask

  const actionLock = new ActionLock()
  const bot = createMockBot()
  const manager = new TaskManager(bot, { debug: false, actionLock })

  manager.enqueue('hold_movement', {}, 1, 'test')
  await manager.tick()

  assert.strictEqual(manager.status().currentTask.type, 'hold_movement')
  assert.strictEqual(manager.status().locks.locks.movement.owner, 1)

  manager.enqueue('fight_nearby_mob', { radius: 4 }, 10, 'test')
  await manager.tick()

  let status = manager.status()
  assert.strictEqual(status.currentTask, null)
  assert.strictEqual(status.pausedStack.length, 1)
  assert.strictEqual(status.pausedStack[0].type, 'hold_movement')
  assert.strictEqual(status.locks.locks.movement, null)
  assert.strictEqual(status.locks.locks.combat, null)
  assert.strictEqual(status.recentCompleted.at(-1).type, 'fight_nearby_mob')

  await manager.tick()

  status = manager.status()
  assert.strictEqual(status.currentTask.type, 'hold_movement')
  assert.strictEqual(status.currentTask.state, 'RUNNING')
  assert.strictEqual(status.locks.locks.movement.owner, 1)
}

async function testLocksReleaseOnTerminalStates() {
  const actionLock = new ActionLock()
  const ctx = { actionLock, debug() {} }

  const completed = new HoldMovementTask({ id: 'complete', priority: 1, params: {} })
  assert.strictEqual(completed.acquireLocks(ctx).ok, true)
  await completed.complete(ctx)
  assert.strictEqual(actionLock.getOwner('movement'), null)

  const failed = new HoldMovementTask({ id: 'fail', priority: 1, params: {} })
  assert.strictEqual(failed.acquireLocks(ctx).ok, true)
  await failed.fail(ctx, 'expected_failure')
  assert.strictEqual(actionLock.getOwner('movement'), null)

  const interrupted = new HoldMovementTask({ id: 'interrupt', priority: 1, params: {} })
  assert.strictEqual(interrupted.acquireLocks(ctx).ok, true)
  await interrupted.interrupt(ctx, 'expected_interrupt')
  assert.strictEqual(actionLock.getOwner('movement'), null)
}

async function testTimeoutAndForceRelease() {
  let now = 1000
  const actionLock = new ActionLock({ now: () => now })

  assert.strictEqual(actionLock.acquire('inventory', 'task-a', { timeoutMs: 50 }).ok, true)
  assert.strictEqual(actionLock.isLocked('inventory'), true)
  now = 1051
  assert.strictEqual(actionLock.isLocked('inventory'), false)

  assert.strictEqual(actionLock.acquire('building', 'task-b').ok, true)
  assert.strictEqual(actionLock.forceRelease('building').released, true)
  assert.strictEqual(actionLock.getOwner('building'), null)
}

// 修缮 15 的主症状，最小复原。
//
// 建造 22：回家任务 #2 被续建命令打断（锁在打断那一刻放掉了），可它那条
// 还在 await 里的脱困链回来之后，又用同一个 owner 把 movement 锁了回去——
// 这一次没有任何人会再放它，之后 8 条建造命令全撞 lock_already_held
// currentOwner=2，只有重启进程才好。
async function testTerminatedOwnerCannotStealTheLockBack() {
  const actionLock = new ActionLock()
  const ctx = { actionLock, debug() {} }

  const goingHome = new HoldMovementTask({ id: 2, priority: 8, params: {} })
  assert.strictEqual(goingHome.acquireLocks(ctx).ok, true)
  assert.strictEqual(actionLock.getOwner('movement'), 2)

  await goingHome.interrupt(ctx, 'player_build_command')
  assert.strictEqual(actionLock.getOwner('movement'), null)

  // 脱困链的下一根梯级回来了：moveTo(holdLock:true) 用 owner=2 再抢一次
  const stolen = actionLock.acquire('movement', 2, { reason: 'moveTo' })
  assert.strictEqual(stolen.ok, false)
  assert.strictEqual(stolen.reason, 'owner_terminated')
  assert.strictEqual(stolen.terminatedReason, 'interrupted:player_build_command')
  assert.strictEqual(actionLock.getOwner('movement'), null)

  // 续建任务照常拿得到锁（建造 22 里这三把全被 owner=2 挡住）
  const build = actionLock.acquireMany(['movement', 'inventory', 'building'], 4)
  assert.strictEqual(build.ok, true)
  assert.strictEqual(actionLock.getOwner('movement'), 4)
  assert.strictEqual(actionLock.getOwner('building'), 4)
}

// 终态回收兜底：负责放锁的那一路（仲裁器）没放干净时，锁自己把该 owner
// 名下的全收回来，并留下一行账。正常情况下它一条都不该打。
async function testTerminalStateReclaimsWhatTheReleasePathMissed() {
  const actionLock = new ActionLock()
  const logs = []
  const ctx = {
    actionLock,
    taskArbiter: { releaseTaskLocks: () => ({ ok: true, released: [] }) },
    debug() {},
    logger: { log: line => logs.push(String(line)) }
  }

  const task = new HoldMovementTask({ id: 7, priority: 5, params: {} })
  assert.strictEqual(actionLock.acquireMany(['movement', 'digging'], 7).ok, true)

  await task.fail(ctx, 'expected_failure')

  assert.strictEqual(actionLock.getOwner('movement'), null)
  assert.strictEqual(actionLock.getOwner('digging'), null)
  assert.deepStrictEqual(
    logs.filter(line => line.startsWith('[action-lock] reclaim')),
    ['[action-lock] reclaim owner=7 types=movement,digging reason=failed']
  )
}

// 封死不能封住复活的任务：INTERRUPTED 且 resumable 的会被重新跑起来。
async function testResumeUnsealsTheOwner() {
  const actionLock = new ActionLock()
  const logs = []
  const ctx = { actionLock, debug() {}, logger: { log: line => logs.push(String(line)) } }

  const task = new HoldMovementTask({ id: 9, priority: 5, params: {} })
  assert.strictEqual(task.acquireLocks(ctx).ok, true)
  await task.interrupt(ctx, 'preempted_by:build_blueprint#10')
  assert.strictEqual(actionLock.acquire('movement', 9).reason, 'owner_terminated')

  await task.resume(ctx)
  assert.strictEqual(task.acquireLocks(ctx).ok, true)
  assert.strictEqual(actionLock.getOwner('movement'), 9)
  // 正常来回不该打出 reclaim（终态那一步已经放干净了）
  assert.deepStrictEqual(logs.filter(line => line.startsWith('[action-lock] reclaim')), [])
}

async function run() {
  await testConflictingMovementLock()
  await testTerminatedOwnerCannotStealTheLockBack()
  await testTerminalStateReclaimsWhatTheReleasePathMissed()
  await testResumeUnsealsTheOwner()
  await testHighPriorityPreemptsAndRestoresLowPriorityTask()
  await testLocksReleaseOnTerminalStates()
  await testTimeoutAndForceRelease()
  console.log('action-lock tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
