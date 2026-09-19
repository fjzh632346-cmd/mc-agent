require('dotenv').config()

const WebSocket     = require('ws')
const { v4: uuidv4 } = require('uuid')
const EventEmitter  = require('events')

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const ENDPOINT        = process.env.VOLC_ASR_ENDPOINT    || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
const RESOURCE_ID     = process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'
const CONNECT_TIMEOUT = 10000
const SESSION_TIMEOUT = 30000
const FINAL_RESULT_STABLE_MS = Number(process.env.VOLC_ASR_FINAL_STABLE_MS || 700)

// ─── 二进制协议帧头 ───────────────────────────────────────────────────────────
//
// sauc/bigmodel 端点协议（与 TTS 不同，无二进制 event 字段）:
//   客户端 → 服务端:
//     ConfigFrame:  [0x11, 0x10, 0x10, 0x00] + [4B payLen] + [JSON]
//     AudioFrame:   [0x11, 0x20, 0x00, 0x00] + [4B payLen] + [PCM]
//     AudioEnd:     [0x11, 0x22, 0x00, 0x00] + [4B payLen] + [PCM/empty]
//   服务端 → 客户端:
//     FullServerResponse: [0x11, 0x91, 0x10, 0x00] + [4B seq] + [4B payLen] + [JSON]
//     Error:              [0x11, 0xf0, 0x10, 0x00] + [4B code] + [4B payLen] + [JSON]
//
// JSON 响应字段: { result: { text: "..." }, audio_info: { duration: N } }

const HDR_CFG       = Buffer.from([0x11, 0x10, 0x10, 0x00])  // FullClientRequest, JSON, no-event
const HDR_AUDIO     = Buffer.from([0x11, 0x20, 0x00, 0x00])  // AudioOnlyClient, binary
const HDR_AUDIO_END = Buffer.from([0x11, 0x22, 0x00, 0x00])  // AudioOnlyClient, binary, last-chunk

// ─── 帧构建 ───────────────────────────────────────────────────────────────────
function buildConfigFrame(sampleRate, channels, bitsPerSample) {
  const pay  = Buffer.from(JSON.stringify({
    user:    { uid: uuidv4() },
    audio:   { format: 'pcm', rate: sampleRate, bits: bitsPerSample, channel: channels, codec: 'raw' },
    request: { model_name: 'bigmodel', language: 'zh-CN', enable_punc: true, result_type: 'full' }
  }), 'utf8')
  const payL = Buffer.allocUnsafe(4); payL.writeUInt32BE(pay.length, 0)
  return Buffer.concat([HDR_CFG, payL, pay])
}

function buildAudioFrame(pcmChunk, isLast = false) {
  const hdr  = isLast ? HDR_AUDIO_END : HDR_AUDIO
  const payL = Buffer.allocUnsafe(4); payL.writeUInt32BE(pcmChunk.length, 0)
  return Buffer.concat([hdr, payL, pcmChunk])
}

// ─── 帧解析 ───────────────────────────────────────────────────────────────────
// 服务端帧格式: [hdr 4B][seq/code 4B][payLen 4B][payload]
function parseServerFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length < 12) return {}
  const hdrBytes = (buf[0] & 0x0f) * 4
  const msgType  = (buf[1] >> 4) & 0x0f
  let off = hdrBytes + 4  // skip seq/code field
  const payLen = buf.readUInt32BE(off); off += 4
  if (payLen > buf.length - off) return { msgType }
  const pay = buf.slice(off, off + payLen)
  try {
    return { msgType, ...JSON.parse(pay.toString('utf8')) }
  } catch {
    return { msgType }
  }
}

// ─── createAsrSession ─────────────────────────────────────────────────────────
async function createAsrSession({ sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const emitter = new EventEmitter()

  const wsHeaders = {
    'X-Api-Key':         process.env.VOLC_ASR_API_KEY || '',
    'X-Api-Resource-Id': RESOURCE_ID,
    'X-Api-Request-Id':  uuidv4(),
    'X-Api-Connect-Id':  uuidv4()
  }
  if (process.env.VOLC_ASR_APP_KEY)    wsHeaders['X-Api-App-Key']    = process.env.VOLC_ASR_APP_KEY
  if (process.env.VOLC_ASR_ACCESS_KEY) wsHeaders['X-Api-Access-Key'] = process.env.VOLC_ASR_ACCESS_KEY

  const ws = new WebSocket(ENDPOINT, { headers: wsHeaders })
  let partialText = '', finalText = '', _finished = false
  let finalSettleTimer = null

  let finishResolve, finishReject
  const finishProm = new Promise((res, rej) => {
    finishResolve = res; finishReject = rej
  })

  const sessionTimer = setTimeout(() => {
    if (!_finished) {
      console.warn('[ASR] 超时 (30s)，强制结束')
      resolveFinalText('timeout')
      ws.close()
    }
  }, SESSION_TIMEOUT)

  let _finishCalled = false

  function resolveFinalText(reason) {
    if (_finished) return
    _finished = true
    if (finalSettleTimer) {
      clearTimeout(finalSettleTimer)
      finalSettleTimer = null
    }
    clearTimeout(sessionTimer)
    const text = finalText || partialText
    console.log(`[ASR FINAL TEXT] ${JSON.stringify(text)} len=${text.length} reason=${reason}`)
    finishResolve(text)
  }

  function scheduleFinalResolve() {
    if (!_finishCalled || _finished) return
    if (finalSettleTimer) clearTimeout(finalSettleTimer)
    finalSettleTimer = setTimeout(() => resolveFinalText('stable'), FINAL_RESULT_STABLE_MS)
  }

  ws.on('message', (raw) => {
    const msg = parseServerFrame(raw)

    if (msg.result !== undefined) {
      const text = msg.result.text || ''
      if (text) {
        console.log(`[ASR] 识别: "${text}"`)
        partialText = text
        finalText   = text
        emitter.emit('partial', text)
      }
      // Wait briefly for ASR refinements after finish(). Some responses arrive as
      // "你" first, then the complete sentence moments later.
      if (_finishCalled && text) scheduleFinalResolve()
    }

    if (msg.error) {
      console.error('[ASR] 服务端错误:', msg.error.substring(0, 200))
      clearTimeout(sessionTimer)
      if (!_finished) {
        _finished = true
        finishReject(new Error('ASR error: ' + msg.error.slice(0, 120)))
      }
    }
  })

  ws.on('unexpected-response', (req, res) => {
    const logid = res.headers['x-tt-logid'] || '无'
    let body = ''
    res.on('data', c => { body += c })
    res.on('end', () => {
      console.error(`[ASR] HTTP ${res.statusCode}  X-Tt-Logid: ${logid}`)
      console.error('[ASR] 响应体:', body.substring(0, 400))
      clearTimeout(sessionTimer)
      const err = new Error(`ASR HTTP ${res.statusCode}: ${body.slice(0, 120)}`)
      if (!_finished) { _finished = true; finishReject(err) }
    })
  })

  ws.on('error', err => {
    console.error('[ASR] WS 错误:', err.message)
    clearTimeout(sessionTimer)
    if (!_finished) { _finished = true; finishReject(err) }
  })

  ws.on('close', (code) => {
    console.log(`[ASR] WS 断开 code=${code}`)
    resolveFinalText('close')
  })

  // WS open → send ConfigFrame
  await new Promise((resolve, reject) => {
    const connTimer = setTimeout(() => {
      try { ws.close() } catch (_) {}
      reject(new Error('ASR WebSocket 连接超时 (10s)'))
    }, CONNECT_TIMEOUT)

    ws.on('open', () => {
      console.log('[ASR] WS 已打开，发送 ConfigFrame')
      ws.send(buildConfigFrame(sampleRate, channels, bitsPerSample))
      clearTimeout(connTimer)
      resolve()
    })

    ws.on('error', err => { clearTimeout(connTimer); reject(err) })
  })

  emitter.sendAudio = function sendAudio(pcmChunk) {
    if (!pcmChunk || pcmChunk.length === 0) return
    ws.send(buildAudioFrame(pcmChunk, false))
    console.log(`[ASR] 发送音频: ${pcmChunk.length} bytes`)
  }

  emitter.finish = async function finish() {
    _finishCalled = true
    console.log('[ASR] 发送最终音频帧 (end-of-audio)')
    try {
      ws.send(buildAudioFrame(Buffer.alloc(0), true))
    } catch (e) {
      console.warn('[ASR] 发送结束帧失败:', e.message)
    }
    try {
      const text = await finishProm
      try { ws.close() } catch (_) {}
      return text
    } catch (err) {
      try { ws.close() } catch (_) {}
      throw err
    }
  }

  return emitter
}

module.exports = { createAsrSession }

// ─── 空连接测试（node asr.js）────────────────────────────────────────────────
if (require.main === module) {
  const apiKey = process.env.VOLC_ASR_API_KEY
  if (!apiKey) { console.error('[测试] VOLC_ASR_API_KEY 未填写'); process.exit(1) }

  console.log('[测试] 连接测试: ConfigFrame → 收到 FullServerResponse → 结束')
  console.log(`[测试] ENDPOINT=${ENDPOINT}`)

  createAsrSession()
    .then(async session => {
      console.log('[测试] ✓ Session 建立成功，发送结束帧...')
      const text = await session.finish()
      console.log('[测试] 识别结果:', JSON.stringify(text || '(空)'))
      console.log('[测试] ✓ 连接测试完成')
      process.exit(0)
    })
    .catch(err => {
      console.error('[测试] 失败:', err.message)
      process.exit(1)
    })
}
