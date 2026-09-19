const assert = require('assert')

delete process.env.INTENT_LLM_TIMEOUT_MS
delete process.env.REMINDER_LLM_TIMEOUT_MS
delete process.env.CHAT_LLM_TIMEOUT_MS
delete process.env.PROACTIVE_LLM_TIMEOUT_MS
delete process.env.LLM_TIMEOUT_MS

const { ACTION_KEYS } = require('../ai/action-keys')
const { REMINDER_TYPES, createReminderEvent } = require('../ai/message-generator')
const {
  CHAT_LLM_TIMEOUT_MS,
  INTENT_LLM_TIMEOUT_MS,
  PROACTIVE_LLM_TIMEOUT_MS,
  REMINDER_LLM_TIMEOUT_MS,
  createBotActionKeyClassifier,
  createBotReminderMessageGenerator,
  generateProactiveLine,
  runBotChatLoop
} = require('../bot')

function fakeClient() {
  return {
    chat: {
      completions: {
        create() {}
      }
    }
  }
}

async function testIntentClassifierDefaultTimeout() {
  let seenTimeout = null
  const classifier = createBotActionKeyClassifier(fakeClient(), {
    createChatCompletionFn: async (_client, _request, options) => {
      seenTimeout = options.timeoutMs
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              actionKey: ACTION_KEYS.CHAT,
              confidence: 0.9,
              reason: 'ordinary chat',
              params: {}
            })
          }
        }]
      }
    }
  })

  await classifier('hello')
  assert.strictEqual(INTENT_LLM_TIMEOUT_MS, 3000)
  assert.strictEqual(seenTimeout, 3000)
}

async function testReminderFeedbackDefaultTimeout() {
  let seenTimeout = null
  const generator = createBotReminderMessageGenerator({
    client: fakeClient(),
    persona: { username: 'LinXia' },
    createChatCompletionFn: async (_client, _request, options) => {
      seenTimeout = options.timeoutMs
      return { choices: [{ message: { content: '{"text":"我先停一下。"}' } }] }
    }
  })

  await generator.generate(createReminderEvent(REMINDER_TYPES.LOW_FOOD, {
    facts: { food: 3, statusOwner: 'bot' }
  }))
  assert.strictEqual(REMINDER_LLM_TIMEOUT_MS, 1500)
  assert.strictEqual(seenTimeout, 1500)
}

async function testOrdinaryChatDefaultTimeout() {
  let seenTimeout = null
  await runBotChatLoop({
    client: {},
    messages: [{ role: 'system', content: 'system' }],
    playerName: 'Alex',
    playerMessage: 'hello',
    tools: [],
    logger: { log() {}, warn() {}, error() {} },
    createChatCompletionFn: async (_client, _request, options) => {
      seenTimeout = options.timeoutMs
      return {
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'hi' }
        }]
      }
    },
    executeTool: async () => ({ ok: true })
  })

  assert.strictEqual(CHAT_LLM_TIMEOUT_MS, 8000)
  assert.strictEqual(seenTimeout, 8000)
}

async function testProactiveChatDefaultTimeout() {
  let seenTimeout = null
  await generateProactiveLine({
    client: {},
    persona: { systemPrompt: 'persona' },
    envDesc: 'safe',
    logger: { log() {}, warn() {}, error() {} },
    createChatCompletionFn: async (_client, _request, options) => {
      seenTimeout = options.timeoutMs
      return {
        choices: [{ message: { content: '今天天气不错。' } }]
      }
    }
  })

  assert.strictEqual(PROACTIVE_LLM_TIMEOUT_MS, 1500)
  assert.strictEqual(seenTimeout, 1500)
}

async function run() {
  await testIntentClassifierDefaultTimeout()
  await testReminderFeedbackDefaultTimeout()
  await testOrdinaryChatDefaultTimeout()
  await testProactiveChatDefaultTimeout()
  console.log('llm call-site timeout tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
