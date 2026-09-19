const { MemoryStore, defaultMemoryPath } = require('./memory-store')

const DEFAULT_TASK_MEMORY = {
  history: []
}

class TaskMemory {
  constructor(filePath = defaultMemoryPath('task-memory.json'), options = {}) {
    this.store = new MemoryStore(filePath, DEFAULT_TASK_MEMORY, options)
    this.store.load()
    this.maxHistory = options.maxHistory || 100
  }

  recordTask(task, status, details = {}) {
    const history = this.store.get('history', [])
    const record = {
      id: task?.id ?? null,
      type: task?.type || details.type || 'unknown',
      status,
      source: task?.source || details.source || null,
      params: task?.params || {},
      error: task?.error || details.error || null,
      result: task?.result || details.result || null,
      startedAt: task?.startedAt || details.startedAt || null,
      endedAt: Date.now(),
      createdAt: new Date().toISOString()
    }
    history.push(record)
    this.store.set('history', history.slice(-this.maxHistory))
    return record
  }

  recordCompleted(task, details = {}) {
    return this.recordTask(task, 'completed', details)
  }

  recordFailed(task, details = {}) {
    return this.recordTask(task, 'failed', details)
  }

  recordInterrupted(task, details = {}) {
    return this.recordTask(task, 'interrupted', details)
  }

  recent(limit = 10) {
    return this.store.get('history', []).slice(-limit)
  }

  summary() {
    const history = this.store.get('history', [])
    return {
      total: history.length,
      completed: history.filter(item => item.status === 'completed').length,
      failed: history.filter(item => item.status === 'failed').length,
      interrupted: history.filter(item => item.status === 'interrupted').length,
      recent: history.slice(-5)
    }
  }

  list() {
    return this.store.list()
  }
}

module.exports = {
  DEFAULT_TASK_MEMORY,
  TaskMemory
}
