const { exec }  = require('child_process')
const mcProtocol = require('minecraft-protocol')

// 扫描 netstat 获取所有 LISTENING 端口
function getListeningPorts() {
  return new Promise((resolve, reject) => {
    exec('netstat -ano -p TCP', (err, stdout) => {
      if (err) return reject(err)
      const ports = []
      for (const line of stdout.split('\n')) {
        // 匹配 LISTENING 行
        if (!/LISTENING/i.test(line)) continue
        // 提取地址:端口
        const m = line.match(/(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/i)
        if (!m) continue
        const port = parseInt(m[1], 10)
        // MC 局域网端口范围
        if (port >= 49152 && port <= 65535) ports.push(port)
      }
      resolve([...new Set(ports)].sort((a, b) => a - b))
    })
  })
}

// 用 minecraft-protocol ping 验证是否是 MC 服务器
function pingPort(port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000)
    mcProtocol.ping({ host: '127.0.0.1', port, version: '1.20.1' }, (err, res) => {
      clearTimeout(timer)
      // 只要没有报错、且返回了 motd/description 就认为是 MC
      if (err) return resolve(false)
      resolve(res && (res.description || res.motd) ? port : false)
    })
  })
}

async function findMinecraftPort() {
  console.log('🔍 正在扫描端口...')
  const candidates = await getListeningPorts()

  if (candidates.length === 0) {
    throw new Error('未检测到开放的 Minecraft 局域网，请确认已在 MC 里按 ESC → 对局域网开放')
  }

  console.log(`   发现候选 [${candidates.join(', ')}] → 验证中...`)

  // 并发 ping 所有候选，取最先响应的
  const results = await Promise.all(candidates.map(pingPort))
  const found   = results.find(r => r !== false)

  if (!found) {
    throw new Error('未检测到开放的 Minecraft 局域网，请确认已在 MC 里按 ESC → 对局域网开放')
  }

  console.log(`✅ 找到 MC 服务器：端口 ${found}`)
  return found
}

module.exports = { findMinecraftPort }
