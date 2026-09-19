// mic-recorder.js - resident microphone capture + push-to-talk PCM clipping.
// The microphone stays open locally, but ASR is only called by bot.js after a
// completed utterance is returned.
const { spawn } = require('child_process')
const iohook = require('iohook-raub')

const MOUSE_BUTTON_ALIASES = {
  Mouse4: [4, 5],
  XBUTTON1: [4, 5],
  Mouse5: [5, 4],
  XBUTTON2: [5, 4]
}

const DEFAULT_SAMPLE_RATE = 16000
const DEFAULT_CHANNELS = 1
const DEFAULT_BITS_PER_SAMPLE = 16

let _audioDevice = null
const _ffmpegPath = 'ffmpeg'

async function detectAudioDevice() {
  if (process.env.FFMPEG_AUDIO_DEVICE) {
    _audioDevice = process.env.FFMPEG_AUDIO_DEVICE
    console.log(`[Mic] Using .env audio device: "${_audioDevice}"`)
    return
  }

  return new Promise((resolve) => {
    const cp = spawn(_ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    cp.stderr.on('data', chunk => { stderr += chunk.toString() })
    cp.on('close', () => {
      const lines = stderr.split(/\r?\n/)
      let inAudioSection = false
      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) { inAudioSection = true; continue }
        if (inAudioSection && line.includes('DirectShow video devices')) break
        if (inAudioSection) {
          const m = line.match(/"(.+?)"/)
          if (m && !line.includes('Alternative name')) {
            _audioDevice = m[1]
            console.log(`[Mic] Detected audio device: "${_audioDevice}"`)
            break
          }
        }
      }
      if (!_audioDevice) {
        console.warn('[Mic] No audio device detected, falling back to ffmpeg default input')
      }
      resolve()
    })
    cp.on('error', () => {
      console.error('[Mic] ffmpeg not found. Please install ffmpeg and make it available in PATH.')
      resolve()
    })
  })
}

function bytesPerMs(sampleRate, channels, bitsPerSample) {
  return sampleRate * channels * (bitsPerSample / 8) / 1000
}

function appendBounded(chunks, state, chunk, maxBytes) {
  if (!chunk || chunk.length === 0) return
  chunks.push(Buffer.from(chunk))
  state.bytes += chunk.length

  while (state.bytes > maxBytes && chunks.length > 0) {
    const over = state.bytes - maxBytes
    const first = chunks[0]
    if (first.length <= over) {
      chunks.shift()
      state.bytes -= first.length
    } else {
      chunks[0] = first.subarray(over)
      state.bytes -= over
    }
  }
}

function cloneChunks(chunks) {
  return chunks.map(chunk => Buffer.from(chunk))
}

/**
 * Starts a resident microphone and uses the mouse button only to select PCM ranges.
 *
 * @param {object} opts
 * @param {string} opts.mouseButton
 * @param {number} opts.preRollMs
 * @param {number} opts.tailMs
 * @param {number} opts.maxRecordMs
 * @param {number} opts.sampleRate
 * @param {number} opts.channels
 * @param {number} opts.bitsPerSample
 * @param {function} opts.onPressStart
 * @param {function} opts.onPressEnd - receives ({ pcmBuffer, durationMs, pressDurationMs, sampleRate, channels, bitsPerSample })
 */
function startPushToTalk({
  mouseButton = 'Mouse4',
  preRollMs = 800,
  tailMs = 500,
  maxRecordMs = 15000,
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = DEFAULT_CHANNELS,
  bitsPerSample = DEFAULT_BITS_PER_SAMPLE,
  onPressStart,
  onPressEnd
} = {}) {
  const targetButtons = MOUSE_BUTTON_ALIASES[mouseButton]
  if (!targetButtons) {
    console.error(`[Mic] Unsupported mouse button: ${mouseButton}. Available: ${Object.keys(MOUSE_BUTTON_ALIASES).join(', ')}`)
    return { stop: () => {} }
  }
  const targetButtonSet = new Set(targetButtons)
  const debugMouse = process.env.MIC_MOUSE_DEBUG === 'true'

  const bytesMs = bytesPerMs(sampleRate, channels, bitsPerSample)
  const preRollBytes = Math.ceil(preRollMs * bytesMs)
  const maxRecordBytes = Math.ceil((maxRecordMs + preRollMs + tailMs) * bytesMs)

  const preRollChunks = []
  const preRollState = { bytes: 0 }
  let captureChunks = []
  let captureBytes = 0
  let captureActive = false
  let buttonDown = false
  let stopped = false
  let micReady = false
  let ffmpegProc = null
  let tailTimer = null
  let maxTimer = null
  let captureStartedAt = 0
  let pressStartedAt = 0
  let pressEndedAt = 0

  function startMic() {
    if (stopped || ffmpegProc) return
    const device = _audioDevice || 'default'

    try {
      ffmpegProc = spawn(_ffmpegPath, [
        '-f', 'dshow', '-i', `audio=${device}`,
        '-ac', String(channels),
        '-ar', String(sampleRate),
        '-sample_fmt', 's16',
        '-f', 's16le',
        'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      console.error('[Mic] Failed to start ffmpeg:', err.message)
      return
    }

    ffmpegProc.stdout.on('data', (chunk) => {
      appendBounded(preRollChunks, preRollState, chunk, preRollBytes)
      if (!captureActive) return

      captureChunks.push(Buffer.from(chunk))
      captureBytes += chunk.length
      if (captureBytes > maxRecordBytes) {
        finalizeCapture('max-bytes')
      }
    })

    ffmpegProc.stderr.on('data', () => {})

    ffmpegProc.on('error', err => {
      console.error('[Mic] ffmpeg error:', err.message)
    })

    ffmpegProc.on('close', (code) => {
      ffmpegProc = null
      micReady = false
      if (!stopped) {
        console.warn(`[Mic] ffmpeg exited (code=${code}); restarting microphone in 1s`)
        setTimeout(startMic, 1000)
      }
    })

    micReady = true
    console.log(`[Mic] Resident microphone is running (${sampleRate}Hz/${channels}ch/s16le)`)
  }

  function beginCapture() {
    if (captureActive) return

    const pre = cloneChunks(preRollChunks)
    captureChunks = pre
    captureBytes = pre.reduce((sum, chunk) => sum + chunk.length, 0)
    captureActive = true
    pressStartedAt = Date.now()
    pressEndedAt = 0
    captureStartedAt = Date.now() - Math.round(captureBytes / bytesMs)

    if (maxTimer) clearTimeout(maxTimer)
    maxTimer = setTimeout(() => {
      if (!captureActive) return
      console.log('[Mic] Max push-to-talk duration reached; finalizing current utterance')
      buttonDown = false
      pressEndedAt = Date.now()
      finalizeCapture('max-time')
    }, maxRecordMs)

    console.log(`[Mic] Capturing locally... pre-roll=${(captureBytes / bytesMs / 1000).toFixed(2)}s`)
    try { onPressStart?.({ micReady }) } catch (err) {
      console.error('[Mic] onPressStart callback failed:', err.message)
    }
  }

  function scheduleTailFinalize() {
    if (!captureActive) return
    if (tailTimer) clearTimeout(tailTimer)
    tailTimer = setTimeout(() => finalizeCapture('tail'), tailMs)
    console.log(`[Mic] Mouse button released; keeping ${tailMs}ms tail audio`)
  }

  function finalizeCapture(reason) {
    if (!captureActive) return
    captureActive = false

    if (tailTimer) {
      clearTimeout(tailTimer)
      tailTimer = null
    }
    if (maxTimer) {
      clearTimeout(maxTimer)
      maxTimer = null
    }

    const pcmBuffer = Buffer.concat(captureChunks, captureBytes)
    const durationMs = Math.round(pcmBuffer.length / bytesMs)
    captureChunks = []
    captureBytes = 0

    console.log(`[Mic] Capture complete (${reason}): ${(durationMs / 1000).toFixed(2)}s, ${pcmBuffer.length} bytes`)
    Promise.resolve(onPressEnd?.({
      pcmBuffer,
      durationMs,
      sampleRate,
      channels,
      bitsPerSample,
      pressDurationMs: Math.max(0, (pressEndedAt || Date.now()) - pressStartedAt),
      startedAt: captureStartedAt,
      endedAt: Date.now()
    })).catch(err => {
      console.error('[Mic] onPressEnd callback failed:', err.message)
    })
  }

  function isTargetMouseButton(e) {
    if (debugMouse) {
      console.log(`[Mic] Mouse event button=${e.button} rawcode=${e.rawcode}`)
    }
    return targetButtonSet.has(e.button) || targetButtonSet.has(e.rawcode)
  }

  iohook.on('mousedown', (e) => {
    if (!isTargetMouseButton(e)) return
    if (buttonDown) return
    buttonDown = true
    console.log('[Mic] Mouse button down')

    if (tailTimer && captureActive) {
      clearTimeout(tailTimer)
      tailTimer = null
      pressEndedAt = 0
      console.log('[Mic] Mouse button pressed during tail; continuing the same utterance')
      return
    }

    beginCapture()
  })

  iohook.on('mouseup', (e) => {
    if (!isTargetMouseButton(e)) return
    if (!buttonDown) return
    buttonDown = false
    console.log('[Mic] Mouse button up')
    pressEndedAt = Date.now()
    scheduleTailFinalize()
  })

  detectAudioDevice().then(startMic)
  iohook.start()
  console.log(`[Mic] Push-to-talk ready. Hold ${mouseButton} to speak; ASR runs after release only.`)

  return {
    stop: () => {
      stopped = true
      if (tailTimer) clearTimeout(tailTimer)
      if (maxTimer) clearTimeout(maxTimer)
      if (captureActive) finalizeCapture('stop')
      if (ffmpegProc) {
        try { ffmpegProc.kill() } catch (_) {}
        ffmpegProc = null
      }
      iohook.stop()
      console.log('[Mic] Mouse listener and resident microphone stopped')
    }
  }
}

module.exports = { startPushToTalk }
