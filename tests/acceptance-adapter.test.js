const assert = require('assert')
const path = require('path')
const MinecraftAdapter = require('../acceptance/adapters/minecraft.adapter')
const { findManualHoldRequest } = require('../acceptance/acceptance-runner')

function createAdapter() {
  const adapter = new MinecraftAdapter({
    rootDir: path.resolve(__dirname, '..'),
    projectName: 'minecraft',
    projectConfig: {
      displayName: 'Minecraft AI Companion',
      minecraft: {
        aiBotUsernameDefault: 'LinXia',
        testPlayerUsernameDefault: 'accept_tester'
      }
    }
  })
  adapter.bot = {
    players: {
      LinXia: { username: 'LinXia', entity: null },
      accept_tester: {
        username: 'accept_tester',
        entity: { position: { x: 10, y: 64, z: 10 } }
      }
    }
  }
  return adapter
}

function testDebugStatusPositionFallback() {
  const adapter = createAdapter()
  const lookup = adapter.companionLookup(
    { x: 10, y: 64, z: 10 },
    {
      ok: true,
      status: {
        botUsername: 'LinXia',
        botPosition: { x: 13, y: 64, z: 14 }
      }
    }
  )

  assert.strictEqual(lookup.exactOnline, true)
  assert.strictEqual(lookup.exactVisible, false)
  assert.strictEqual(lookup.onlineAndVisible, false)
  assert.strictEqual(lookup.onlineButNotVisible, true)
  assert.strictEqual(lookup.onlineWithDebugPosition, true)
  assert.strictEqual(lookup.positionSource, 'debug_status')
  assert.strictEqual(lookup.companionPositionFromDebug, true)
  assert.deepStrictEqual(lookup.position, { x: 13, y: 64, z: 14 })
  assert.strictEqual(lookup.distanceToAcceptancePlayer, 5)
  assert.strictEqual(lookup.recommendedTeleportCommand, '/tp LinXia accept_tester')
  assert.strictEqual(lookup.blockedReason, null)
}

function testRecentLogDebugStatusFallback() {
  const adapter = createAdapter()
  adapter.readRecentLogs = () => [
    '[LOG] [DEBUG_STATUS] {"botUsername":"LinXia","botPosition":{"x":20,"y":64,"z":20}}'
  ]

  const fallback = adapter.latestDebugStatusFromRecentLogs()
  assert.strictEqual(fallback.ok, true)
  assert.deepStrictEqual(fallback.status.botPosition, { x: 20, y: 64, z: 20 })
}

function testFollowingHoldRequest() {
  const hold = findManualHoldRequest([
    {
      featureName: 'following',
      judgment: 'BLOCKED',
      setupFailureReason: 'ai_too_far_for_following_test',
      recommendedTeleportCommand: '/tp LinXia accept_tester'
    }
  ], {}, { holdOpenSeconds: 20 })

  assert.strictEqual(hold.seconds, 20)
  assert.strictEqual(hold.reason, 'ai_too_far_for_following_test')
  assert.strictEqual(hold.recommendedTeleportCommand, '/tp LinXia accept_tester')

  const disabled = findManualHoldRequest([
    {
      featureName: 'following',
      judgment: 'BLOCKED',
      setupFailureReason: 'ai_too_far_for_following_test'
    }
  ], {}, { holdOpenSeconds: 0 })
  assert.strictEqual(disabled, null)
}

function run() {
  testDebugStatusPositionFallback()
  testRecentLogDebugStatusFallback()
  testFollowingHoldRequest()
  console.log('acceptance-adapter tests passed')
}

run()
