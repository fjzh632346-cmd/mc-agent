require('dotenv').config()

const WebSocket      = require('ws')
const { v4: uuidv4 } = require('uuid')
const fs             = require('fs')
const path           = require('path')
const os             = require('os')
const { exec }       = require('child_process')

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const APP_ID      = process.env.VOLC_TTS_APP_ID        || ''
const TOKEN       = process.env.VOLC_TTS_ACCESS_TOKEN  || ''
const RESOURCE_ID = process.env.VOLC_TTS_V3_RESOURCE_ID || 'volc.service_type.10029'
const SPEAKER     = process.env.VOLC_TTS_V3_SPEAKER    || ''
const ENDPOINT    = process.env.VOLC_TTS_V3_ENDPOINT   || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
const ENABLED     = process.env.VOLC_TTS_ENABLED !== 'false'
const MAX_RETRIES = 3
if (ENABLED && !SPEAKER) console.warn('[TTS] 没有设置音色：请在 .env 里填写 VOLC_TTS_V3_SPEAKER（火山引擎控制台里的音色编号），否则语音合成会失败')

// ─── V3 二进制协议 ────────────────────────────────────────────────────────────
//
// 客户端帧头 (4 bytes):
//   Byte0: version=0001 | header_size=0001  → 0x11
//   Byte1: msg_type=0001(FullClientRequest) | flags=0100(has_event) → 0x14
//   Byte2: serialization=0001(JSON) | compression=0000(none) → 0x10
//   Byte3: reserved → 0x00
//
// 服务器音频帧头 Byte1: msg_type=1011(AudioOnlyServer) | flags=0100 → 0xb4
//
// 帧体格式 (客户端发送 / 服务端接收均相同):
//   [4B header] [4B event BE] [4B sid_len BE] [sid_len B sid] [4B pay_len BE] [pay_len B payload]

// flags=4: event 号放在二进制字段，session_id 放在 JSON payload 里
const CLIENT_HDR   = Buffer.from([0x11, 0x14, 0x10, 0x00])
const SVR_AUDIO_T  = 0x0b

// ─── 帧构建 ───────────────────────────────────────────────────────────────────
// event=1 (无session): [hdr][4B event][4B payLen][JSON]
// event≥100 (有session): [hdr][4B event][4B sidLen][sid][4B payLen][JSON]
function buildFrame(payloadObj, sessionId = null) {
  const evB  = Buffer.allocUnsafe(4); evB.writeUInt32BE(payloadObj.event || 0)
  const pay  = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const payL = Buffer.allocUnsafe(4); payL.writeUInt32BE(pay.length)
  if (sessionId) {
    const sidB = Buffer.from(sessionId, 'utf8')
    const sidL = Buffer.allocUnsafe(4); sidL.writeUInt32BE(sidB.length)
    return Buffer.concat([CLIENT_HDR, evB, sidL, sidB, payL, pay])
  }
  return Buffer.concat([CLIENT_HDR, evB, payL, pay])
}

function sendFrame(payloadObj, sessionId = null) {
  console.log('[SEND] event=', payloadObj.event, 'sid=', sessionId ? sessionId.substring(0,8)+'...' : 'none')
  _ws.send(buildFrame(payloadObj, sessionId))
}

// ─── 帧解析 ───────────────────────────────────────────────────────────────────
// 服务端帧格式：
//   flags=0 → [hdr][4B payLen][payload]，event 在 JSON 里
//   flags=4 → [hdr][4B event][4B payLen][payload]，event 在二进制里
// session_id 始终在 JSON payload 里
function parseFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length < 4) return { event: -1 }

  const hdrBytes = (buf[0] & 0x0f) * 4
  const msgType  = (buf[1] >> 4) & 0x0f
  const flags    = buf[1] & 0x0f

  let off = hdrBytes
  let event = -1
  let sid = ''

  if (flags & 0x4) {
    if (off + 4 > buf.length) return { event: -1 }
    event = buf.readUInt32BE(off); off += 4
    // 服务端（及有 session 的客户端帧）带 sidLen+sid
    if (off + 4 <= buf.length) {
      const sidLen = buf.readUInt32BE(off); off += 4
      sid = buf.slice(off, off + sidLen).toString('utf8'); off += sidLen
    }
  }

  if (off + 4 > buf.length) return { event, sessionId: sid }
  const payLen = buf.readUInt32BE(off); off += 4
  const pay    = buf.slice(off, off + payLen)

  if (msgType === SVR_AUDIO_T) {
    return { event, sessionId: sid, audio: pay }
  }

  try {
    const json = JSON.parse(pay.toString('utf8'))
    if (event === -1 && json.event !== undefined) event = json.event
    return { event, sessionId: sid, msgType, ...json }
  } catch {
    return { event, sessionId: sid, msgType, _raw: pay.slice(0, 20).toString('hex') }
  }
}

// ─── PCM → WAV（用户提供的格式，24kHz 16bit mono）────────────────────────────
function pcmToWav(pcm, sr = 24000, bd = 16, ch = 1) {
  const hdr = Buffer.alloc(44)
  hdr.write('RIFF', 0);   hdr.writeUInt32LE(36 + pcm.length, 4)
  hdr.write('WAVE', 8);   hdr.write('fmt ', 12)
  hdr.writeUInt32LE(16, 16)
  hdr.writeUInt16LE(1, 20);   hdr.writeUInt16LE(ch, 22)
  hdr.writeUInt32LE(sr, 24);  hdr.writeUInt32LE(sr * ch * bd / 8, 28)
  hdr.writeUInt16LE(ch * bd / 8, 32);  hdr.writeUInt16LE(bd, 34)
  hdr.write('data', 36);  hdr.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([hdr, pcm])
}

// ─── 播放 WAV（PowerShell SoundPlayer，已确认在此 Windows 机器可用）─────────
function playWav(wav) {
  return new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), `andy_tts_${Date.now()}.wav`).replace(/\\/g, '/')
    fs.writeFileSync(tmp, wav)
    exec(
      `powershell -NoProfile -NonInteractive -Command ` +
      `"(New-Object System.Media.SoundPlayer '${tmp}').PlaySync()"`,
      { timeout: 60000 },
      (err) => {
        fs.unlink(tmp, () => {})
        if (err) console.warn('[TTS] 播放失败:', err.message)
        else     console.log('[TTS] 播放完成 ✓')
        resolve()
      }
    )
  })
}

// ─── 连接状态 ─────────────────────────────────────────────────────────────────
let _ws          = null
let _wsReady     = false
let _retryCount  = 0
let _connProm    = null   // 防并发 connect()

// 每次 speak 的临时 Promise 解决函数
let _connResolve = null   // 等待连接建立
let _connReject  = null
let _sessResolve = null   // 等待 SessionStarted(150)
let _sessReject  = null
let _playResolve = null   // 等待 SessionFinished(152) + 播放完成

let _audioChunks  = []
let _frameCount   = 0
let _normalClose  = false   // true 时 close 事件不触发重连

// ─── 消息处理器 ───────────────────────────────────────────────────────────────
function _onMessage(raw) {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const b1 = data[1]
  const msgType = (b1 >> 4) & 0x0f
  const flags   = b1 & 0x0f
  console.log('[RECV] msgType=0x' + msgType.toString(16), 'flags=0x' + flags.toString(16), 'len=', data.length)
  if (flags & 4) {
    const event = data.readInt32BE(4)
    console.log('[RECV] event(binary)=', event)
    if (msgType === 0x9 || msgType === 0xf) {
      try {
        const sidLen = data.readUInt32BE(8)
        const payLen = data.readUInt32BE(12 + sidLen)
        const payload = data.slice(16 + sidLen, 16 + sidLen + payLen).toString('utf8')
        console.log('[RECV] payload=', payload)
      } catch (e) { console.log('[RECV] parse err', e.message) }
    }
  } else {
    // flags=0: payload 直接跟在 header(4B)+payLen(4B) 之后
    try {
      const payLen = data.readUInt32BE(4)
      const payload = data.slice(8, 8 + payLen).toString('utf8')
      console.log('[RECV] payload=', payload)
    } catch (e) { console.log('[RECV] parse err', e.message) }
  }

  const msg = parseFrame(raw)

  switch (msg.event) {

    case 50:   // ConnectionStarted
      console.log('[TTS] 连接成功 ✓')
      _wsReady = true; _retryCount = 0
      _connResolve?.(); _connResolve = _connReject = null
      break

    case 51:   // ConnectionFailed
      console.error('[TTS] 连接失败:', JSON.stringify(msg))
      _connReject?.(new Error('ConnectionFailed'))
      _connResolve = _connReject = null
      break

    case 150:  // SessionStarted
      console.log('[TTS] Session 已开始 ✓')
      _sessResolve?.(); _sessResolve = _sessReject = null
      break

    case 350:  // Audio frame
    case 352:  // Audio frame (alternate event id)
      if (msg.audio?.length > 0) {
        _frameCount++
        _audioChunks.push(msg.audio)
        const total = _audioChunks.reduce((s, b) => s + b.length, 0)
        console.log(`[TTS] 第 ${_frameCount} 帧: ${msg.audio.length} bytes（累计 ${total} bytes）`)
      }
      break

    case 351:  // 文本/韵律元数据帧，不是错误，忽略即可
      console.log('[TTS] 收到 351 元数据帧(已忽略)')
      break

    case 152: {  // SessionFinished → 组装 PCM，加 WAV header，播放
      const total = _audioChunks.reduce((s, b) => s + b.length, 0)
      console.log(`[TTS] Session 结束: ${_frameCount} 帧 / ${total} bytes`)

      const pcm = Buffer.concat(_audioChunks)
      _audioChunks = []; _frameCount = 0

      const r = _playResolve; _playResolve = null
      if (pcm.length > 0) {
        console.log('[TTS] 开始播放...')
        playWav(pcmToWav(pcm)).then(() => r?.())
      } else {
        console.warn('[TTS] 音频为空，跳过播放')
        r?.()
      }
      break
    }

    case 52:   // ConnectionFinished
      console.log('[TTS] 连接关闭')
      _wsReady = false
      break

    default:
      if (msg.event !== -1) {
        console.log('[TTS] 未知事件:', msg.event, JSON.stringify(msg).substring(0, 100))
      }
  }
}

// ─── WebSocket 连接 ───────────────────────────────────────────────────────────
function _connect() {
  if (_wsReady) return Promise.resolve()
  if (_connProm) return _connProm

  _connProm = new Promise((resolve, reject) => {
    _connResolve = resolve
    _connReject  = reject

    const cid = uuidv4()
    console.log(`[TTS] 正在连接 connectId=${cid}`)

    _ws = new WebSocket(ENDPOINT, {
      headers: {
        'X-Api-Key':        process.env.VOLC_TTS_V3_API_KEY,
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-Connect-Id': cid,
        'X-Api-Request-Id': uuidv4()
      }
    })

    _ws.on('open', () => {
      console.log('[TTS] WS 已打开，发送 StartConnection')
      const _recvTimeout = setTimeout(() => {
        console.log('[TIMEOUT] no response in 30s')
        _ws.close()
      }, 30000)
      _ws.once('message', () => clearTimeout(_recvTimeout))
      sendFrame({ event: 1 })
    })

    _ws.on('message', _onMessage)

    _ws.on('unexpected-response', (req, res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        console.error(`[TTS] HTTP ${res.statusCode} body:`, body)
      })
    })

    _ws.on('error', (err) => {
      console.error('[TTS] WS 错误:', err.message)
      if (/401|403|Unauthorized|Forbidden/i.test(err.message)) {
        console.error('[TTS] 鉴权失败！请检查:\n  · VOLC_TTS_V3_API_KEY 是否正确\n  · VOLC_TTS_V3_RESOURCE_ID 是否匹配音色类型')
      }
      _wsReady = false
      _connReject?.(err); _connResolve = _connReject = null
    })

    _ws.on('close', (code, reason) => {
      console.log(`[TTS] WS 断开 code=${code} reason=${reason?.toString() || '-'}`)
      _wsReady = false
      _playResolve?.(); _playResolve = null
      if (_normalClose) {
        _normalClose = false
      } else {
        _scheduleReconnect()
      }
    })
  }).finally(() => { _connProm = null })

  return _connProm
}

function _scheduleReconnect() {
  if (_retryCount >= MAX_RETRIES) {
    console.warn(`[TTS] 已达最大重试次数 (${MAX_RETRIES})，放弃重连`)
    return
  }
  const delay = Math.pow(2, _retryCount) * 2000  // 2s / 4s / 8s
  _retryCount++
  console.log(`[TTS] ${delay / 1000}s 后重连 (${_retryCount}/${MAX_RETRIES})`)
  setTimeout(() => _connect().catch(() => {}), delay)
}

// ─── 单次合成 + 播放 ──────────────────────────────────────────────────────────
async function _doSpeak(text) {
  if (!_wsReady) await _connect()

  _audioChunks = []; _frameCount = 0
  const sid = uuidv4()
  console.log(`[TTS] 新 Session: ${sid.substring(0, 8)}...`)

  // 1. StartSession → 等 SessionStarted(150)
  await new Promise((ok, fail) => {
    let done = false
    _sessResolve = () => {
      if (done) return; done = true
      clearTimeout(timer)
      ok()
    }
    _sessReject = (e) => {
      if (done) return; done = true
      _sessResolve = _sessReject = null
      fail(e)
    }
    const timer = setTimeout(() => {
      _sessResolve = _sessReject = null
      if (!done) { done = true; fail(new Error('StartSession 超时 (10s)')) }
    }, 10000)

    sendFrame({
      event:     100,
      namespace: 'BidirectionalTTS',
      req_params: {
        speaker:      SPEAKER,
        audio_params: { format: 'pcm', sample_rate: 24000 },
        additions:    '{"disable_markdown_filter":false}'
      }
    }, sid)
  })

  // 2. TaskRequest
  const preview = text.length > 40 ? text.substring(0, 40) + '...' : text
  console.log(`[TTS] 发送文本: "${preview}"`)
  sendFrame({
    event:     200,
    namespace: 'BidirectionalTTS',
    req_params: { text, speaker: SPEAKER }
  }, sid)

  // 3. FinishSession（告知服务端文本发完）
  sendFrame({ event: 102, namespace: 'BidirectionalTTS' }, sid)

  // 4. 等 SessionFinished(152) + 播放完毕（由 _onMessage case 152 → playWav 触发）
  await new Promise((ok) => { _playResolve = ok })
}

// ─── 播放队列（顺序执行，不并发）────────────────────────────────────────────
const _queue = []
let   _busy  = false

async function _processQueue() {
  if (_busy || _queue.length === 0) return
  _busy = true
  while (_queue.length > 0) {
    const { text, resolve } = _queue.shift()
    try {
      await _doSpeak(text)
    } catch (err) {
      console.warn('[TTS] speak 失败:', err.message)
    }
    resolve()
  }
  _busy = false
}

// ─── 公开接口 ─────────────────────────────────────────────────────────────────
async function speak(text) {
  if (!ENABLED)       return
  if (!text?.trim())  return

  return new Promise((resolve) => {
    _queue.push({ text, resolve })
    _processQueue()
  })
}

module.exports = { speak }

// ─── 独立测试（node tts.js）─────────────────────────────────────────────────
if (require.main === module) {
  if (!TOKEN || TOKEN === '填入你的Access_Token') {
    console.error('[测试] 请先在 .env 填写 VOLC_TTS_ACCESS_TOKEN！')
    process.exit(1)
  }
  console.log(`[测试] APP_ID=${APP_ID}  SPEAKER=${SPEAKER}  RESOURCE_ID=${RESOURCE_ID}`)
  console.log(`[测试] ENDPOINT=${ENDPOINT}`)

  speak('你好，我是小猫软糖，这次终于成功啦！')
    .then(() => {
      console.log('测试完成')
      if (_ws) { _normalClose = true; _ws.close() }
      setTimeout(() => process.exit(0), 500)
    })
    .catch(err => { console.error('测试失败:', err.message); process.exit(1) })
}
