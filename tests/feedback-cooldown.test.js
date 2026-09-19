const assert = require('assert')
const { FeedbackCooldown } = require('../utils/feedback-cooldown')

async function testCanEmitAndCooldown() {
  console.log('  [Basic Cooldown Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 100 })

  // First emit should pass
  assert.strictEqual(fc.canEmit('test_key'), true)
  console.log('  ✓ first emit passes')

  // Second immediate emit should be suppressed
  assert.strictEqual(fc.canEmit('test_key'), false)
  console.log('  ✓ immediate re-emit suppressed')

  // Different key should pass
  assert.strictEqual(fc.canEmit('other_key'), true)
  console.log('  ✓ different key not affected by cooldown')
}

async function testEmitWithFn() {
  console.log('  [Emit With Function Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 100 })
  let callCount = 0

  // First emit
  const r1 = fc.emit('key1', () => { callCount++; return 'first' })
  assert.strictEqual(r1, 'first')
  assert.strictEqual(callCount, 1)
  console.log('  ✓ emit executes function on first call')

  // Second immediate - should suppress
  const r2 = fc.emit('key1', () => { callCount++; return 'second' })
  assert.strictEqual(r2, null)
  assert.strictEqual(callCount, 1, 'function should not be called on suppressed emit')
  console.log('  ✓ emit returns null when suppressed')
}

async function testSuppressedCount() {
  console.log('  [Suppressed Count Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 100 })

  fc.canEmit('spam_key')
  fc.canEmit('spam_key')
  fc.canEmit('spam_key')

  assert.strictEqual(fc.getSuppressedCount('spam_key'), 2)
  console.log('  ✓ suppressed count tracks correctly')

  // Reset clears count
  fc.reset('spam_key')
  assert.strictEqual(fc.getSuppressedCount('spam_key'), 0)
  console.log('  ✓ reset clears suppressed count')
}

async function testCustomCooldown() {
  console.log('  [Custom Cooldown Tests]')
  // Driven off an injected clock: a 1ms window judged against the wall clock
  // is really asking whether two consecutive calls took under a millisecond,
  // which is not what this case is about and fails at random when they do not.
  let clock = 1000
  const fc = new FeedbackCooldown({ defaultCooldownMs: 5000, now: () => clock })

  // Use a short 1ms cooldown
  fc.canEmit('custom_key', 1)
  assert.strictEqual(fc.canEmit('custom_key', 1), false)
  console.log('  ✓ custom cooldown honored')

  // ...and it really is only 1ms: one tick later the same key is free again.
  clock += 1
  assert.strictEqual(fc.canEmit('custom_key', 1), true, 'custom cooldown must expire on time')
  console.log('  ✓ custom cooldown expires')

  // Default cooldown still applies when not specified
  fc.canEmit('default_key')
  assert.strictEqual(fc.canEmit('default_key'), false, 'default cooldown still in effect')
  console.log('  ✓ default cooldown used when custom not specified')
}

async function testResetAll() {
  console.log('  [Reset All Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 500 })

  fc.canEmit('a')
  fc.canEmit('b')
  fc.canEmit('a')
  fc.canEmit('b')

  assert.strictEqual(fc.getSuppressedCount('a'), 1)
  assert.strictEqual(fc.getSuppressedCount('b'), 1)

  fc.resetAll()
  assert.strictEqual(fc.getSuppressedCount('a'), 0)
  assert.strictEqual(fc.getSuppressedCount('b'), 0)
  console.log('  ✓ resetAll clears everything')
}

async function testStatus() {
  console.log('  [Status Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 500 })

  fc.canEmit('task_eat_food_completed')
  fc.canEmit('task_eat_food_completed')
  fc.canEmit('task_craft_item_failed')

  const status = fc.status()
  assert.ok(status.task_eat_food_completed, 'should track eat_food key')
  assert.ok(status.task_eat_food_completed.lastEmittedMs >= 0)
  assert.strictEqual(status.task_eat_food_completed.suppressed, 1)

  assert.ok(status.task_craft_item_failed, 'should track craft_item key')
  assert.strictEqual(status.task_craft_item_failed.suppressed, 0)
  console.log('  ✓ status reflects all keys with suppression counts')
}

// The injected clock is a test affordance, not the default: production must
// still be on the wall clock.
async function testDefaultClockIsWallClock() {
  console.log('  [Default Clock Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 5000 })
  assert.strictEqual(fc._now, Date.now)
  fc.canEmit('wall')
  const status = fc.status()
  assert.ok(status.wall.lastEmittedMs >= 0 && status.wall.lastEmittedMs < 5000)
  console.log('  ✓ Date.now used when no clock injected')
}

async function testConstructorOptions() {
  console.log('  [Constructor Options Tests]')
  const fc = new FeedbackCooldown({ defaultCooldownMs: 8000, minCooldownMs: 3000 })

  fc.canEmit('x')
  assert.strictEqual(fc.canEmit('x'), false, '8000ms cooldown not expired')
  console.log('  ✓ custom defaultCooldownMs respected')
}

async function run() {
  console.log('[FeedbackCooldown Tests]')
  await testCanEmitAndCooldown()
  await testEmitWithFn()
  await testSuppressedCount()
  await testCustomCooldown()
  await testResetAll()
  await testStatus()
  await testDefaultClockIsWallClock()
  await testConstructorOptions()
  console.log('feedback-cooldown tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
