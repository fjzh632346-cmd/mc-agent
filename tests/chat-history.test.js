const assert = require('assert')
const { appendAssistantTurn, findOrphanToolCalls } = require('../ai/chat-history')

function createMessages() {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'status please' }
  ]
}

function assistantWithTwoToolCalls() {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_status',
        type: 'function',
        function: { name: 'get_status', arguments: '{}' }
      },
      {
        id: 'call_inventory',
        type: 'function',
        function: { name: 'get_inventory', arguments: '{}' }
      }
    ]
  }
}

function assertMessagesAreConsumableByNextLlmCall(messages) {
  assert.deepStrictEqual(findOrphanToolCalls(messages), [])
}

async function testSuccessfulToolTurnHasNoOrphans() {
  const messages = createMessages()
  await appendAssistantTurn(messages, assistantWithTwoToolCalls(), {
    executeTool: async call => ({ ok: true, name: call.function.name })
  })

  assert.strictEqual(messages.length, 5)
  assert.strictEqual(messages[2].role, 'assistant')
  assert.strictEqual(messages[3].role, 'tool')
  assert.strictEqual(messages[4].role, 'tool')
  assertMessagesAreConsumableByNextLlmCall(messages)
}

async function testInterruptedToolTurnRollsBackAssistantToolCalls() {
  const messages = createMessages()
  const before = JSON.stringify(messages)
  let calls = 0

  await assert.rejects(
    () => appendAssistantTurn(messages, assistantWithTwoToolCalls(), {
      executeTool: async () => {
        calls += 1
        if (calls === 2) throw new Error('tool execution interrupted')
        return { ok: true }
      }
    }),
    /tool execution interrupted/
  )

  assert.strictEqual(JSON.stringify(messages), before)
  assertMessagesAreConsumableByNextLlmCall(messages)

  await appendAssistantTurn(messages, { role: 'assistant', content: 'local fallback' })
  assert.strictEqual(messages[messages.length - 1].content, 'local fallback')
  assertMessagesAreConsumableByNextLlmCall(messages)
}

function testDetectsOrphanAssistantToolCalls() {
  const messages = createMessages()
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'orphan_call',
        type: 'function',
        function: { name: 'get_status', arguments: '{}' }
      }
    ]
  })

  assert.deepStrictEqual(findOrphanToolCalls(messages), ['orphan_call'])
}

function testMatchedToolCallsAreNotOrphans() {
  const messages = createMessages()
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'matched_call',
        type: 'function',
        function: { name: 'get_status', arguments: '{}' }
      }
    ]
  })
  messages.push({
    role: 'tool',
    tool_call_id: 'matched_call',
    content: '{"ok":true}'
  })

  assert.deepStrictEqual(findOrphanToolCalls(messages), [])
}

async function run() {
  testDetectsOrphanAssistantToolCalls()
  testMatchedToolCallsAreNotOrphans()
  await testSuccessfulToolTurnHasNoOrphans()
  await testInterruptedToolTurnRollsBackAssistantToolCalls()
  console.log('chat-history tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
