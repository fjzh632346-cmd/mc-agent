const fs = require('fs')
const path = require('path')

function atomicWriteJsonSync(filePath, value, options = {}) {
  const fsModule = options.fs || fs
  const spacing = options.spacing ?? 2
  const contents = `${JSON.stringify(value, null, spacing)}\n`
  return atomicWriteFileSync(filePath, contents, { ...options, fs: fsModule })
}

function atomicWriteFileSync(filePath, contents, options = {}) {
  const fsModule = options.fs || fs
  const maxRenameAttempts = options.maxRenameAttempts ?? 3
  const directory = path.dirname(filePath)
  const fileName = path.basename(filePath)
  const tempPath = path.join(
    directory,
    `.${fileName}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )

  let fd = null
  let renamed = false

  try {
    fsModule.mkdirSync(directory, { recursive: true })
    fd = fsModule.openSync(tempPath, 'w')
    fsModule.writeFileSync(fd, contents, 'utf8')
    if (typeof fsModule.fsyncSync === 'function') fsModule.fsyncSync(fd)
    fsModule.closeSync(fd)
    fd = null

    renameWithRetrySync(fsModule, tempPath, filePath, maxRenameAttempts)
    renamed = true
    fsyncDirectoryBestEffort(fsModule, directory)
  } catch (err) {
    if (fd !== null) {
      try {
        fsModule.closeSync(fd)
      } catch (_) {}
    }
    if (!renamed) cleanupTempFile(fsModule, tempPath)
    throw err
  }

  return filePath
}

function renameWithRetrySync(fsModule, source, target, maxAttempts) {
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fsModule.renameSync(source, target)
      return
    } catch (err) {
      lastError = err
      if (!isRetryableRenameError(err) || attempt >= maxAttempts) break
      sleepSync(10 * attempt)
    }
  }
  throw lastError
}

function isRetryableRenameError(err) {
  return err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
}

function sleepSync(ms) {
  if (typeof SharedArrayBuffer !== 'function' || typeof Atomics?.wait !== 'function') return
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function fsyncDirectoryBestEffort(fsModule, directory) {
  if (typeof fsModule.openSync !== 'function' || typeof fsModule.fsyncSync !== 'function') return
  let fd = null
  try {
    fd = fsModule.openSync(directory, 'r')
    fsModule.fsyncSync(fd)
  } catch (_) {
    // Some platforms, including Windows setups, do not allow opening directories.
  } finally {
    if (fd !== null) {
      try {
        fsModule.closeSync(fd)
      } catch (_) {}
    }
  }
}

function cleanupTempFile(fsModule, tempPath) {
  try {
    if (fsModule.existsSync(tempPath)) fsModule.unlinkSync(tempPath)
  } catch (_) {}
}

module.exports = {
  atomicWriteFileSync,
  atomicWriteJsonSync
}
