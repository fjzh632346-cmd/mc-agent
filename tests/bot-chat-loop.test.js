const assert = require('assert')
const { findOrphanToolCalls } = require('../ai/chat-history')
const { runBotChatLoop } = require('../bot')

function createMessages() {
  return [
    { role: 'system', content: 'system prompt' }
  ]
}

function toolCallMessage() {
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

async function testInterruptedBotToolPathDoesNotPolluteHistory() {
  const messages = createMessages()
  const said = []
  let toolExecutions = 0

  const result = await runBotChatLoop({
    client: {},
    messages,
    playerName: 'Alex',
    playerMessage: 'check status',
    tools: [],
    say: text => said.push(text),
    logger: { log() {}, warn() {}, error() {} },
    createChatCompletionFn: async () => ({
      choices: [{ finish_reason: 'tool_calls', message: toolCallMessage() }]
    }),
    executeTool: async () => {
      toolExecutions += 1
      if (toolExecutions === 2) throw new Error('simulated tool interruption')
      return { ok: true }
    }
  })

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.code, 'TOOL_CALL_INTERRUPTED')
  assert.strictEqual(messages.length, 2)
  assert.strictEqual(messages[1].role, 'user')
  assert.deepStrictEqual(findOrphanToolCalls(messages), [])
  assert.strictEqual(messages.some(message => message.role === 'assistant' && message.tool_calls), false)
  assert.ok(said.some(text => text.includes('刚才这步没处理完整')))
}

async function testNextBotChatCallConsumesCleanHistory() {
  const messages = createMessages()
  messages.push({ role: 'user', content: '[Alex]: previous failed turn' })

  let consumedCleanHistory = false
  const replies = []
  const result = await runBotChatLoop({
    client: {},
    messages,
    playerName: 'Alex',
    playerMessage: 'hello again',
    tools: [],
    logger: { log() {}, warn() {}, error() {} },
    createChatCompletionFn: async (_client, request) => {
      consumedCleanHistory = findOrphanToolCalls(request.messages).length === 0
      return {
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'ready' }
        }]
      }
    },
    executeTool: async () => ({ ok: true }),
    sendReply: reply => replies.push(reply)
  })

  assert.strictEqual(result.ok, true)
  assert.strictEqual(consumedCleanHistory, true)
  assert.deepStrictEqual(findOrphanToolCalls(messages), [])
  assert.deepStrictEqual(replies, ['ready'])
}

async function run() {
  await testInterruptedBotToolPathDoesNotPolluteHistory()
  await testNextBotChatCallConsumesCleanHistory()
  console.log('bot chat loop tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
