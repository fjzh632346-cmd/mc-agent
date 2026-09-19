// Minimal Minecraft RCON client (no dependencies).
// Usage: node scripts/mc-rcon.js <command...>
//   Env: MC_RCON_HOST (default 127.0.0.1), MC_RCON_PORT (default 25575),
//        MC_RCON_PASSWORD (required).
// Exits 0 on success and prints the server response; non-zero on failure.
const net = require('net')

const host = process.env.MC_RCON_HOST || '127.0.0.1'
const port = Number(process.env.MC_RCON_PORT || 25575)
const password = process.env.MC_RCON_PASSWORD || ''
const command = process.argv.slice(2).join(' ').trim()

if (!password) {
  console.error('MC_RCON_PASSWORD is required')
  process.exit(2)
}
if (!command) {
  console.error('usage: node scripts/mc-rcon.js <command...>')
  process.exit(2)
}

const TYPE_LOGIN = 3
const TYPE_COMMAND = 2

function packet(id, type, payload) {
  const body = Buffer.from(payload, 'utf8')
  const buf = Buffer.alloc(14 + body.length)
  buf.writeInt32LE(10 + body.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  body.copy(buf, 12)
  return buf
}

const socket = net.createConnection({ host, port })
socket.setTimeout(10000)
let received = Buffer.alloc(0)
let loggedIn = false

socket.on('connect', () => socket.write(packet(1, TYPE_LOGIN, password)))
socket.on('timeout', () => { console.error('rcon timeout'); socket.destroy(); process.exit(1) })
socket.on('error', err => { console.error(`rcon error: ${err.message}`); process.exit(1) })
socket.on('data', chunk => {
  received = Buffer.concat([received, chunk])
  while (received.length >= 4) {
    const length = received.readInt32LE(0)
    if (received.length < 4 + length) return
    const id = received.readInt32LE(4)
    const payload = received.slice(12, 4 + length - 2).toString('utf8')
    received = received.slice(4 + length)
    if (!loggedIn) {
      if (id === -1) { console.error('rcon auth failed'); socket.destroy(); process.exit(1) }
      loggedIn = true
      socket.write(packet(2, TYPE_COMMAND, command))
    } else {
      if (payload) console.log(payload)
      socket.end()
      process.exit(0)
    }
  }
})
