const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { MemoryStore } = require('../memory/memory-store')
const { WorldMemory } = require('../memory/world-memory')
const { TaskMemory } = require('../memory/task-memory')
const { createGameMemory } = require('../memory')
const { atomicWriteJsonSync } = require('../utils/atomic-json')
const { parseIntent } = require('../ai/intent-parser')
const { routePlayerCommand } = require('../ai/command-router')

const TMP_DIR = path.join(__dirname, 'tmp-memory')

function resetTmp() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })
}

function createContext(memory) {
  return {
    memory,
    playerName: 'Alex',
    bot: {
      entity: {
        position: { x: 10, y: 64, z: -3 }
      }
    },
    blackboard: {
      get(key) {
        if (key === 'bot.position') return { x: 10, y: 64, z: -3 }
        return undefined
      }
    },
    taskManager: {
      enqueue() {
        throw new Error('should_not_enqueue')
      },
      async interruptCurrent() {
        throw new Error('should_not_interrupt')
      },
      status() {
        return {}
      }
    }
  }
}

async function testMemoryStoreCrud() {
  resetTmp()
  const file = path.join(TMP_DIR, 'store.json')
  const store = new MemoryStore(file, { items: {} })

  store.load()
  assert.strictEqual(fs.existsSync(file), true)

  store.set('items.base', { x: 1 })
  assert.deepStrictEqual(store.get('items.base'), { x: 1 })

  store.update('items.base', { y: 2 })
  assert.deepStrictEqual(store.get('items.base'), { x: 1, y: 2 })

  assert.strictEqual(store.delete('items.base'), true)
  assert.strictEqual(store.get('items.base'), undefined)

  store.clear()
  assert.deepStrictEqual(store.list(), { items: {} })
}

async function testBrokenJsonDoesNotCrash() {
  resetTmp()
  const file = path.join(TMP_DIR, 'broken.json')
  fs.writeFileSync(file, '{ bad json', 'utf8')

  const store = new MemoryStore(file, { safe: true }, { logger: { warn() {} } })
  assert.doesNotThrow(() => store.load())
  assert.deepStrictEqual(store.list(), { safe: true })
}

async function testAtomicJsonWriteCreatesParseableJson() {
  resetTmp()
  const file = path.join(TMP_DIR, 'atomic-create.json')

  atomicWriteJsonSync(file, { ok: true, nested: { count: 2 } })

  const raw = fs.readFileSync(file, 'utf8')
  assert.strictEqual(raw.endsWith('\n'), true)
  assert.deepStrictEqual(JSON.parse(raw), { ok: true, nested: { count: 2 } })
}

async function testAtomicJsonWriteReplacesWholeFile() {
  resetTmp()
  const file = path.join(TMP_DIR, 'atomic-replace.json')
  fs.writeFileSync(file, `${JSON.stringify({ old: true, padding: 'x'.repeat(200) })}\n`, 'utf8')

  atomicWriteJsonSync(file, { old: false, next: true })

  const raw = fs.readFileSync(file, 'utf8')
  assert.deepStrictEqual(JSON.parse(raw), { old: false, next: true })
  assert.strictEqual(raw.includes('padding'), false)
}

async function testAtomicJsonWriteFailureKeepsExistingTarget() {
  resetTmp()
  const file = path.join(TMP_DIR, 'atomic-failure.json')
  fs.writeFileSync(file, `${JSON.stringify({ intact: true })}\n`, 'utf8')

  const failingFs = {
    ...fs,
    renameSync() {
      const err = new Error('rename failed')
      err.code = 'EACCES'
      throw err
    }
  }

  assert.throws(() => {
    atomicWriteJsonSync(file, { intact: false, partial: true }, {
      fs: failingFs,
      maxRenameAttempts: 1
    })
  }, /rename failed/)

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { intact: true })
  const leftovers = fs.readdirSync(TMP_DIR).filter(name => name.includes('.atomic-failure.json.tmp-'))
  assert.deepStrictEqual(leftovers, [])
}

async function testMemoryStoreUsesAtomicJsonWrite() {
  resetTmp()
  const file = path.join(TMP_DIR, 'store-atomic.json')
  const store = new MemoryStore(file, { items: {} })

  store.load()
  store.set('items.base', { x: 1 })

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { items: { base: { x: 1 } } })
  const tempFiles = fs.readdirSync(TMP_DIR).filter(name => name.includes('.store-atomic.json.tmp-'))
  assert.deepStrictEqual(tempFiles, [])
}

async function testWorldAndTaskMemory() {
  resetTmp()
  const world = new WorldMemory(path.join(TMP_DIR, 'world.json'))
  const base = world.setBaseLocation({ x: 10, y: 64, z: -3 })
  const danger = world.addDangerZone({ x: 12, y: 64, z: -4 })

  assert.strictEqual(base.type, 'base')
  assert.strictEqual(world.baseLocation.position.x, 10)
  assert.strictEqual(danger.type, 'danger')
  assert.strictEqual(world.summary().dangerZones, 1)

  const task = new TaskMemory(path.join(TMP_DIR, 'task.json'), { maxHistory: 50 })
  task.recordCompleted({ id: 1, type: 'MiningTask', source: 'test', params: {}, result: { ok: true }, startedAt: 100 })
  task.recordFailed({ id: 2, type: 'FollowTask', source: 'test', params: {}, error: 'player_not_found', startedAt: 200 })

  const summary = task.summary()
  assert.strictEqual(summary.total, 2)
  assert.strictEqual(summary.completed, 1)
  assert.strictEqual(summary.failed, 1)
}

async function testMemoryCommandParsingAndRouting() {
  resetTmp()
  const memory = createGameMemory({
    worldPath: path.join(TMP_DIR, 'world-memory.json'),
    playerPath: path.join(TMP_DIR, 'player-memory.json'),
    taskPath: path.join(TMP_DIR, 'task-memory.json'),
    logger: { warn() {} }
  })

  let parsed = parseIntent('记住这里是基地')
  assert.strictEqual(parsed.intent, 'remember_base')
  assert.strictEqual(parsed.ok, true)

  let routed = await routePlayerCommand('记住这里是基地', createContext(memory))
  assert.strictEqual(routed.handled, true)
  assert.strictEqual(routed.action.action, 'memory_write')
  assert.strictEqual(memory.world.baseLocation.position.x, 10)

  parsed = parseIntent('这里很危险')
  assert.strictEqual(parsed.intent, 'remember_danger')
  routed = await routePlayerCommand('这里很危险', createContext(memory))
  assert.strictEqual(routed.action.action, 'memory_write')
  assert.strictEqual(memory.world.summary().dangerZones, 1)

  parsed = parseIntent('你记得基地在哪吗')
  assert.strictEqual(parsed.intent, 'query_base')
  routed = await routePlayerCommand('你记得基地在哪吗', createContext(memory))
  assert.strictEqual(routed.action.action, 'memory_query')
  assert.strictEqual(routed.action.data.baseLocation.position.x, 10)

  routed = await routePlayerCommand('你会记住我说的话吗', createContext(memory))
  assert.strictEqual(routed.handled, false)
  assert.strictEqual(memory.world.summary().mineLocations, 0)
}

async function run() {
  await testMemoryStoreCrud()
  await testBrokenJsonDoesNotCrash()
  await testAtomicJsonWriteCreatesParseableJson()
  await testAtomicJsonWriteReplacesWholeFile()
  await testAtomicJsonWriteFailureKeepsExistingTarget()
  await testMemoryStoreUsesAtomicJsonWrite()
  await testWorldAndTaskMemory()
  await testMemoryCommandParsingAndRouting()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  console.log('memory tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
