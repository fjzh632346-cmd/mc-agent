const DEFAULT_LLM_TIMEOUT_MS = 8000

class LlmError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.details = details
  }
}

function getLlmTimeoutMs(value = process.env.LLM_TIMEOUT_MS) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_TIMEOUT_MS
  return Math.max(1, Math.floor(parsed))
}

async function createChatCompletion(client, request, options = {}) {
  if (!client?.chat?.completions?.create) {
    throw new LlmError('LLM_API_ERROR', 'LLM client is not available', {
      context: options.context || 'unknown'
    })
  }

  return withLlmTimeout(
    ({ signal }) => client.chat.completions.create(request, signal ? { signal } : undefined),
    options
  )
}

async function withLlmTimeout(operation, options = {}) {
  const timeoutMs = getLlmTimeoutMs(options.timeoutMs)
  const context = options.context || 'unknown'
  const inputType = options.inputType || options.stage || 'unknown'
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timer = null
  let timedOut = false

  const operationPromise = Promise.resolve()
    .then(() => operation({ signal: controller?.signal, timeoutMs }))
    .catch(error => {
      throw normalizeLlmError(error, { context, inputType, timeoutMs, timedOut })
    })

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      try { controller?.abort?.() } catch {}
      reject(new LlmError('LLM_TIMEOUT', `LLM request timed out after ${timeoutMs}ms`, {
        context,
        inputType,
        timeoutMs
      }))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operationPromise, timeoutPromise])
  } catch (error) {
    const normalized = normalizeLlmError(error, { context, inputType, timeoutMs, timedOut })
    logLlmIssue(options.logger, {
      code: normalized.code,
      context,
      timeoutMs,
      inputType,
      fallback: options.fallback || null,
      message: normalized.message
    })
    throw normalized
  } finally {
    if (timer) clearTimeout(timer)
    operationPromise.catch(() => {})
  }
}

function normalizeLlmError(error, details = {}) {
  if (error instanceof LlmError) return error
  if (error?.code && String(error.code).startsWith('LLM_')) {
    return new LlmError(error.code, error.message || error.code, { ...details, ...(error.details || {}) })
  }
  if (details.timedOut || error?.name === 'AbortError') {
    return new LlmError('LLM_TIMEOUT', `LLM request timed out after ${details.timeoutMs}ms`, details)
  }
  return new LlmError('LLM_API_ERROR', error?.message || 'LLM API error', details)
}

function parseLlmJson(content, details = {}) {
  const value = String(content || '').trim()
  if (!value) {
    throw new LlmError('LLM_EMPTY_RESPONSE', 'LLM returned an empty response', details)
  }
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new LlmError('LLM_BAD_JSON', 'LLM returned invalid JSON', {
      ...details,
      parseMessage: error.message
    })
  }
}

function logLlmIssue(logger, event = {}) {
  if (!logger) return
  const payload = {
    code: event.code || 'LLM_API_ERROR',
    context: event.context || 'unknown',
    timeoutMs: event.timeoutMs || null,
    inputType: event.inputType || 'unknown',
    fallback: event.fallback || null
  }
  const line = `[LLM_ERROR] ${JSON.stringify(payload)}`
  if (payload.code === 'LLM_TIMEOUT') logger.warn?.(line)
  else logger.warn?.(line)
}

function isLlmError(error, code = null) {
  if (!error || !String(error.code || '').startsWith('LLM_')) return false
  return code ? error.code === code : true
}

module.exports = {
  DEFAULT_LLM_TIMEOUT_MS,
  LlmError,
  createChatCompletion,
  getLlmTimeoutMs,
  isLlmError,
  logLlmIssue,
  parseLlmJson,
  withLlmTimeout
}
