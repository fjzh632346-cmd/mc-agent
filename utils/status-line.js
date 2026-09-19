'use strict'

// The 10-second `[状态]` line. While the socket is dead it must say so
// instead of echoing the last cached position: the building lane watched a
// kicked bot print the same coordinates for 18 minutes and took it for alive.
function formatStatusLine(input = {}) {
  if (input.online === false) {
    const parts = ['[状态] 离线']
    parts.push(`原因=${input.reason || 'unknown'}`)
    const r = input.reconnect
    if (r) {
      if (r.state === 'gave_up') {
        parts.push(`重连已放弃(${r.attempt}/${r.maxAttempts})`)
      } else if (r.enabled === false) {
        parts.push('重连已关闭')
      } else if (r.state === 'connecting') {
        parts.push(`重连第${r.attempt}次连接中`)
      } else if (r.nextReconnectInMs != null) {
        parts.push(`重连第${r.attempt}/${r.maxAttempts}次于${Math.ceil(r.nextReconnectInMs / 1000)}秒后`)
      }
    }
    if (input.pausedTask) parts.push(`已暂停任务=${input.pausedTask}`)
    return parts.join(' | ')
  }
  const p = input.position || {}
  const num = value => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : 'n/a'
  const health = Number.isFinite(Number(input.health)) ? Number(input.health).toFixed(1) : 'n/a'
  const food = input.food ?? 'n/a'
  return `[状态] x=${num(p.x)} y=${num(p.y)} z=${num(p.z)} | 血=${health} 饿=${food} | ${input.mode || '空闲'}`
}

module.exports = { formatStatusLine }
