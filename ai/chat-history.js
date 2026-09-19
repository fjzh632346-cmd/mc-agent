function getToolCalls(message = {}) {
  return Array.isArray(message.tool_calls) ? message.tool_calls : []
}

async function appendAssistantTurn(messages, assistantMessage, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array')
  if (!assistantMessage || assistantMessage.role !== 'assistant') {
    throw new TypeError('assistantMessage must be an assistant message')
  }

  const startIndex = messages.length
  messages.push(assistantMessage)

  const calls = getToolCalls(assistantMessage)
  if (!calls.length) return { toolCalls: 0 }

  if (typeof options.executeTool !== 'function') {
    messages.splice(startIndex)
    throw new TypeError('executeTool is required for assistant tool calls')
  }

  try {
    for (const call of calls) {
      const result = await options.executeTool(call)
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: content == null ? 'null' : content
      })
    }
    return { toolCalls: calls.length }
  } catch (err) {
    messages.splice(startIndex)
    options.logger?.warn?.(`[CHAT_HISTORY_ROLLBACK] tool_calls=${calls.length} reason=${err?.message || err}`)
    throw err
  }
}

function findOrphanToolCalls(messages = []) {
  const pending = new Set()
  for (const message of messages) {
    if (message?.role === 'assistant') {
      for (const call of getToolCalls(message)) {
        if (call?.id) pending.add(call.id)
      }
    }
    if (message?.role === 'tool' && message.tool_call_id) {
      pending.delete(message.tool_call_id)
    }
  }
  return [...pending]
}

module.exports = {
  appendAssistantTurn,
  findOrphanToolCalls
}
