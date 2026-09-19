const fs = require('fs')
const path = require('path')
const { atomicWriteJsonSync } = require('../utils/atomic-json')

class MemoryStore {
  constructor(filePath, defaultData = {}, options = {}) {
    this.filePath = filePath
    this.defaultData = structuredCloneSafe(defaultData)
    this.logger = options.logger || console
    this.data = structuredCloneSafe(defaultData)
  }

  load() {
    ensureDirectory(path.dirname(this.filePath))

    if (!fs.existsSync(this.filePath)) {
      this.data = structuredCloneSafe(this.defaultData)
      this.save()
      return this.data
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      this.data = raw.trim() ? JSON.parse(raw) : structuredCloneSafe(this.defaultData)
    } catch (err) {
      this.logger.warn?.(`[MemoryStore] Failed to load ${this.filePath}: ${err.message}`)
      this.data = structuredCloneSafe(this.defaultData)
    }

    return this.data
  }

  save() {
    atomicWriteJsonSync(this.filePath, this.data)
    return this.data
  }

  get(key, fallback = undefined) {
    if (!key) return this.list()
    const value = getPath(this.data, key)
    return value === undefined ? fallback : value
  }

  set(key, value) {
    setPath(this.data, key, value)
    this.save()
    return value
  }

  update(key, partialValue) {
    const current = this.get(key, {})
    const next = isPlainObject(current) && isPlainObject(partialValue)
      ? { ...current, ...partialValue }
      : partialValue
    return this.set(key, next)
  }

  delete(key) {
    const deleted = deletePath(this.data, key)
    if (deleted) this.save()
    return deleted
  }

  list() {
    return structuredCloneSafe(this.data)
  }

  clear() {
    this.data = structuredCloneSafe(this.defaultData)
    this.save()
    return this.data
  }
}

function defaultMemoryPath(fileName) {
  return path.join(process.cwd(), 'data', 'memory', fileName)
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
}

function getPath(object, key) {
  return String(key).split('.').reduce((target, part) => {
    if (target == null) return undefined
    return target[part]
  }, object)
}

function setPath(object, key, value) {
  const parts = String(key).split('.')
  let target = object
  while (parts.length > 1) {
    const part = parts.shift()
    if (!isPlainObject(target[part])) target[part] = {}
    target = target[part]
  }
  target[parts[0]] = value
}

function deletePath(object, key) {
  const parts = String(key).split('.')
  let target = object
  while (parts.length > 1) {
    target = target?.[parts.shift()]
    if (target == null) return false
  }
  const finalKey = parts[0]
  if (!Object.prototype.hasOwnProperty.call(target, finalKey)) return false
  delete target[finalKey]
  return true
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

module.exports = {
  MemoryStore,
  defaultMemoryPath
}
