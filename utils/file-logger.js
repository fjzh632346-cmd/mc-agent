const fs = require('fs')
const path = require('path')
const util = require('util')

const SENSITIVE_PATTERNS = [
  /(api[_-]?key\s*[:=]\s*)['"]?[^'",\s]+/gi,
  /(token\s*[:=]\s*)['"]?[^'",\s]+/gi,
  /(password\s*[:=]\s*)['"]?[^'",\s]+/gi,
  /(authorization\s*[:=]\s*)['"]?[^'",\s]+/gi,
  /(bearer\s+)[a-z0-9._-]+/gi,
  /(DEEPSEEK_API_KEY\s*[:=]\s*)['"]?[^'",\s]+/gi,
  /(OPENAI_API_KEY\s*[:=]\s*)['"]?[^'",\s]+/gi
]

let installed = false

function installConsoleFileLogger(options = {}) {
  if (installed) return null
  installed = true

  const logsDir = options.logsDir || path.join(process.cwd(), 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const timestamp = formatFileTimestamp(new Date())
  const currentLogPath = path.join(logsDir, 'bot-current.log')
  const sessionLogPath = path.join(logsDir, `bot-${timestamp}.log`)
  fs.writeFileSync(currentLogPath, '', 'utf8')
  fs.writeFileSync(sessionLogPath, '', 'utf8')

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }

  const write = (level, args) => {
    const now = new Date().toISOString()
    const message = redact(util.format(...args))
    const line = message
      .split(/\r?\n/)
      .map(part => `[${now}] [${level}] ${part}`)
      .join('\n') + '\n'
    try {
      fs.appendFileSync(currentLogPath, line, 'utf8')
      fs.appendFileSync(sessionLogPath, line, 'utf8')
    } catch (err) {
      original.error('[FileLogger] write failed:', err.message)
    }
  }

  console.log = (...args) => {
    original.log(...args)
    write('LOG', args)
  }
  console.info = (...args) => {
    original.info(...args)
    write('INFO', args)
  }
  console.warn = (...args) => {
    original.warn(...args)
    write('WARN', args)
  }
  console.error = (...args) => {
    original.error(...args)
    write('ERROR', args)
  }

  console.log(`[FileLogger] writing logs to ${currentLogPath} and ${sessionLogPath}`)
  return { logsDir, currentLogPath, sessionLogPath }
}

function redact(text) {
  return SENSITIVE_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, '$1[REDACTED]'),
    String(text || '')
  )
}

function formatFileTimestamp(date) {
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-')
}

module.exports = {
  installConsoleFileLogger,
  redact
}
