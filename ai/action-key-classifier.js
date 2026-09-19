const { ACTION_KEYS, VALID_ACTION_KEYS } = require('./action-keys')
const { createChatCompletion: defaultCreateChatCompletion, parseLlmJson } = require('./llm-client')

const ACTION_KEY_LIST = Object.values(ACTION_KEYS)

function createLlmActionKeyClassifier(client, options = {}) {
  const createChatCompletion = options.createChatCompletionFn || defaultCreateChatCompletion

  return async function classifyActionKey(rawText, invocationOptions = {}) {
    if (!client?.chat?.completions?.create) return null

    const response = await createChatCompletion(client, {
      model: options.model || 'deepseek-chat',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You classify Minecraft player utterances into one virtual action key.',
            `Allowed actionKey values: ${ACTION_KEY_LIST.join(', ')}.`,
            'Return strict JSON only: {"actionKey":"...","confidence":0-1,"reason":"short reason","params":{}}.',
            'Do not control the bot. Do not output code. Do not mention bot.dig, bot.attack, pathfinder, or API calls.',
            'Use CHAT for ordinary conversation. Use UNKNOWN only when the utterance is unclear.'
          ].join('\n')
        },
        {
          role: 'user',
          content: String(rawText || '')
        }
      ]
    }, {
      context: 'action_key_classifier',
      inputType: 'intent_semantic_layer',
      timeoutMs: invocationOptions.timeoutMs || options.timeoutMs,
      logger: invocationOptions.logger || options.logger,
      fallback: 'confirmation_chat'
    })

    const content = response.choices?.[0]?.message?.content
    return sanitizeLlmActionKeyResult(parseLlmJson(content, {
      context: 'action_key_classifier',
      inputType: 'intent_semantic_layer'
    }))
  }
}

function sanitizeLlmActionKeyResult(result) {
  const actionKey = VALID_ACTION_KEYS.has(result?.actionKey) ? result.actionKey : ACTION_KEYS.UNKNOWN
  return {
    actionKey,
    confidence: clampConfidence(result?.confidence),
    reason: typeof result?.reason === 'string' ? result.reason.slice(0, 200) : 'LLM classified the utterance',
    params: sanitizeParams(result?.params)
  }
}

function sanitizeParams(params) {
  if (!isPlainObject(params)) return {}
  const safe = {}
  for (const key of ['ore', 'blockName', 'memoryType', 'count', 'itemName', 'foodName', 'mode', 'radius', 'target', 'safeMode', 'priority']) {
    if (params[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof params[key])) {
      safe[key] = params[key]
    }
  }
  return safe
}

function clampConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

module.exports = {
  createLlmActionKeyClassifier,
  sanitizeLlmActionKeyResult
}
