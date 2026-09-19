// test-asr-auth.js — ASR 握手诊断（正确协议格式）
require('dotenv').config()
const WebSocket     = require('ws')
const { v4: uuidv4 } = require('uuid')

const ENDPOINT    = process.env.VOLC_ASR_ENDPOINT    || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
const RESOURCE_ID = process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'
const API_KEY     = process.env.VOLC_ASR_API_KEY      || ''

function hex2(n) { return n.toString(16).padStart(2, '0') }
function hexDump(buf, label) {
  console.log(`[HEX ${label}] (${buf.length}B)`)
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.slice(i, i + 16)
    const h = [...slice].map(hex2).join(' ').padEnd(47)
    const a = [...slice].map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    console.log(`  ${i.toString(16).padStart(4,'0')}  ${h}  ${a}`)
  }
}

function decodeHeader(buf) {
  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3]
  return {
    raw:           `${hex2(b0)} ${hex2(b1)} ${hex2(b2)} ${hex2(b3)}`,
    version:       (b0 >> 4) & 0x0f,
    header_size:   (b0 & 0x0f),
    msg_type:      (b1 >> 4) & 0x0f,
    flags:          b1 & 0x0f,
    serialization: (b2 >> 4) & 0x0f,
    compression:    b2 & 0x0f,
    reserved:       b3
  }
}

function msgTypeName(t) {
  const m = { 0x1:'FullClientRequest', 0x2:'AudioOnlyClient',
              0x9:'FullServerResponse', 0xb:'AudioOnlyServer', 0xf:'Error' }
  return m[t] || `unknown(${t})`
}

// ─── 新协议：flags=0，无二进制 event，frame = [hdr][payLen][JSON] ─────────────
// header byte1 = msg_type(4bit)|flags(4bit) = 0x1|0x0 = 0x10
const HDR_FULL = Buffer.from([0x11, 0x10, 0x10, 0x00])  // FullClientRequest, JSON, flags=0

function buildConfigFrame() {
  const payload = Buffer.from(JSON.stringify({
    user: { uid: 'test-user' },
    audio: {
      format:  'pcm',
      rate:    16000,
      bits:    16,
      channel: 1,
      codec:   'raw'
    },
    request: {
      model_name:  'bigmodel',
      language:    'zh-CN',
      enable_punc: true,
      result_type: 'full'
    }
  }), 'utf8')
  const payL = Buffer.allocUnsafe(4); payL.writeUInt32BE(payload.length, 0)
  return Buffer.concat([HDR_FULL, payL, payload])
}

// ─── 解析服务端响应帧 ─────────────────────────────────────────────────────────
function parseServerFrame(buf) {
  if (buf.length < 4) return { error: 'too short' }
  const hdr      = decodeHeader(buf)
  const hdrBytes = hdr.header_size * 4
  let off = hdrBytes

  let event = -1
  if (hdr.flags & 0x4) {
    if (off + 4 > buf.length) return { hdr, error: 'truncated event' }
    event = buf.readUInt32BE(off); off += 4
    // session id may follow
    if (off + 4 <= buf.length) {
      const sidLen = buf.readUInt32BE(off); off += 4
      if (sidLen > 0 && sidLen < 256 && off + sidLen <= buf.length) {
        off += sidLen
      }
    }
  }

  if (off + 4 > buf.length) return { hdr, event, noPayload: true }
  // ASR server always has a 4-byte sequence/code field after the header (before payLen)
  // This applies to all server frame types (FullServerResponse, Error, etc.)
  off += 4
  if (off + 4 > buf.length) return { hdr, event, noPayload: true }
  const payLen = buf.readUInt32BE(off); off += 4
  if (payLen > buf.length - off) return { hdr, event, payLen, error: 'payload truncated' }
  const pay = buf.slice(off, off + payLen)
  const payStr = pay.toString('utf8')
  try {
    const json = JSON.parse(payStr)
    if (event === -1 && json.event !== undefined) event = json.event
    return { hdr, event, payLen, payStr, json }
  } catch (e) {
    return { hdr, event, payLen, payStr, parseErr: e.message }
  }
}

// ─── 主测试 ───────────────────────────────────────────────────────────────────
console.log('=== ASR 握手诊断测试（新协议：flags=0，{user,audio,request}）===')
console.log('ENDPOINT   :', ENDPOINT)
console.log('RESOURCE_ID:', RESOURCE_ID)
console.log('API_KEY    :', API_KEY ? API_KEY.substring(0,8)+'...' : '(未填写!)')
console.log()

if (!API_KEY) {
  console.error('❌ VOLC_ASR_API_KEY 未填写')
  process.exit(1)
}

const headers = {
  'X-Api-Key':         API_KEY,
  'X-Api-Resource-Id': RESOURCE_ID,
  'X-Api-Request-Id':  uuidv4(),
  'X-Api-Connect-Id':  uuidv4()
}

console.log('── HTTP 升级请求 Headers ──────────────────────────────────')
Object.entries(headers).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
console.log()

const ws = new WebSocket(ENDPOINT, { headers })
let gotResponse = false

const timeout = setTimeout(() => {
  console.error('❌ 超时 (12s)，未收到响应')
  ws.close(); process.exit(1)
}, 12000)

ws.on('upgrade', (res) => {
  console.log('── WS Upgrade 响应头 ──────────────────────────────────────')
  Object.entries(res.headers).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
  const logid = res.headers['x-tt-logid'] || res.headers['x-request-id']
  if (logid) console.log(`\n  ★ X-Tt-Logid: ${logid}`)
  console.log()
})

ws.on('open', () => {
  const frame = buildConfigFrame()
  console.log('── 发送 ConfigFrame（新协议：flags=0） ─────────────────────')
  hexDump(frame, 'SEND')
  const hdr = decodeHeader(frame)
  console.log('  header 解析:', JSON.stringify(hdr))
  const payStr = frame.slice(8).toString('utf8')
  console.log('  payload:', payStr)
  console.log()
  ws.send(frame)
})

ws.on('message', (raw) => {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const parsed = parseServerFrame(buf)
  const { hdr, event, payLen, payStr, json, parseErr, noPayload, error } = parsed

  console.log('── 收到帧 ──────────────────────────────────────────────────')
  hexDump(buf, 'RECV')
  if (hdr) {
    console.log(`  header: ${hdr.raw}  msg_type=0x${hdr.msg_type.toString(16)}(${msgTypeName(hdr.msg_type)}) flags=0x${hdr.flags.toString(16)} serial=${hdr.serialization}`)
  }
  if (error)    console.log('  parse error:', error)
  if (event !== undefined && event !== -1) console.log(`  event: ${event}`)
  if (payLen !== undefined) console.log(`  payLen: ${payLen}`)
  if (payStr)   console.log('  payload str:', payStr)
  if (json)     console.log('  payload json:', JSON.stringify(json, null, 2))
  if (parseErr) console.log('  json parse err:', parseErr)
  if (noPayload) console.log('  (no payload)')
  console.log()

  if (json) {
    // FullServerResponse with result = success
    if (hdr && hdr.msg_type === 0x9 && json.result !== undefined) {
      gotResponse = true
      console.log(`✅ 连接成功！收到 FullServerResponse，result.text="${json.result.text || ''}"`)
      clearTimeout(timeout); ws.close()
      return
    }
    if (json.error) {
      console.error('❌ 服务端错误:', json.error)
      clearTimeout(timeout); ws.close()
    }
  }
})

ws.on('unexpected-response', (req, res) => {
  const logid = res.headers['x-tt-logid'] || '无'
  let body = ''
  res.on('data', c => { body += c })
  res.on('end', () => {
    clearTimeout(timeout)
    console.error(`❌ HTTP ${res.statusCode}  X-Tt-Logid: ${logid}`)
    console.error('响应体:', body)
    process.exit(1)
  })
})

ws.on('error', err => {
  clearTimeout(timeout)
  console.error('❌ WS 错误:', err.message)
  process.exit(1)
})

ws.on('close', (code, reason) => {
  clearTimeout(timeout)
  if (gotResponse) {
    console.log('\n🎉 测试通过，退出码 0')
    process.exit(0)
  } else {
    console.error(`WS 关闭 code=${code} reason=${reason?.toString() || '-'}`)
    process.exit(1)
  }
})
