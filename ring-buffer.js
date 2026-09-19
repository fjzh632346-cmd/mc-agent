// ring-buffer.js — 环形缓冲区，用于解耦 ffmpeg stdout → VAD 处理
class RingBuffer {
  constructor(capacity = 128 * 1024) {
    this._buf = Buffer.allocUnsafe(capacity)
    this._capacity = capacity
    this._readPos = 0
    this._writePos = 0
    this._available = 0
  }

  /** 写入数据，满时覆盖旧数据 */
  write(data) {
    const len = data.length
    if (len > this._capacity) {
      // 只保留最后 capacity 字节
      data = data.subarray(len - this._capacity)
      return this._writeFull(data)
    }
    this._ensureSpace(len)
    const first = Math.min(len, this._capacity - this._writePos)
    data.copy(this._buf, this._writePos, 0, first)
    if (len > first) {
      data.copy(this._buf, 0, first, len)
    }
    this._writePos = (this._writePos + len) % this._capacity
    this._available = Math.min(this._available + len, this._capacity)
  }

  /** 读取指定字节数，不够返回 null */
  read(size) {
    if (this._available < size) return null
    const out = Buffer.allocUnsafe(size)
    const first = Math.min(size, this._capacity - this._readPos)
    this._buf.copy(out, 0, this._readPos, this._readPos + first)
    if (size > first) {
      this._buf.copy(out, first, 0, size - first)
    }
    this._readPos = (this._readPos + size) % this._capacity
    this._available -= size
    return out
  }

  /** 可读字节数 */
  get available() {
    return this._available
  }

  /** 清空 */
  reset() {
    this._readPos = 0
    this._writePos = 0
    this._available = 0
  }

  _ensureSpace(len) {
    if (this._capacity - this._available >= len) return
    const toDrop = len - (this._capacity - this._available)
    this._readPos = (this._readPos + toDrop) % this._capacity
    this._available -= toDrop
  }

  _writeFull(data) {
    data.copy(this._buf, 0)
    this._writePos = 0
    this._readPos = 0
    this._available = data.length
  }
}

module.exports = { RingBuffer }
