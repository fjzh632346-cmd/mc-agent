// vad.js — Silero VAD 封装 (onnxruntime-node)
// 模型: silero_vad.onnx, 512 samples/frame @16kHz (32ms), 输出语音概率
const ort = require('onnxruntime-node')
const path = require('path')
const fs   = require('fs')
const https = require('https')

const MODEL_URL  = 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx'
const MODEL_FILE = path.join(__dirname, 'silero_vad.onnx')
const FRAME_SIZE = 512   // samples per VAD frame
const SR         = 16000
const THRESHOLD  = 0.5

class SileroVAD {
  constructor(session) {
    this._session = session
    this._h = new Float32Array(2 * 1 * 64)
    this._c = new Float32Array(2 * 1 * 64)
    this._sr = BigInt64Array.from([BigInt(SR)])

    // 从模型读取输入/输出名（兼容不同版本）
    this._inNames  = session.inputNames
    this._outNames = session.outputNames
    console.log('[VAD] 模型输入:', this._inNames, '输出:', this._outNames)
  }

  static async create() {
    if (!fs.existsSync(MODEL_FILE)) {
      await SileroVAD._download()
    }
    const session = await ort.InferenceSession.create(MODEL_FILE)
    console.log('[VAD] 模型加载完成')
    return new SileroVAD(session)
  }

  /**
   * 处理一帧 512 float32 采样点，返回语音概率
   * @param {Float32Array} frame — [-1, 1] 范围
   * @returns {Promise<{ prob: number, isSpeech: boolean }>}
   */
  async process(frame) {
    const feeds = {}
    feeds[this._inNames[0]] = new ort.Tensor('float32', frame, [1, FRAME_SIZE])
    feeds[this._inNames[1]] = new ort.Tensor('int64',   this._sr, [1])
    feeds[this._inNames[2]] = new ort.Tensor('float32', this._h,  [2, 1, 64])
    feeds[this._inNames[3]] = new ort.Tensor('float32', this._c,  [2, 1, 64])

    const results = await this._session.run(feeds)

    // 更新 LSTM 状态
    const hn = results[this._outNames[1]]
    const cn = results[this._outNames[2]]
    if (hn && cn) {
      this._h.set(hn.data)
      this._c.set(cn.data)
    }

    const prob = results[this._outNames[0]].data[0]
    return { prob, isSpeech: prob >= THRESHOLD }
  }

  reset() {
    this._h.fill(0)
    this._c.fill(0)
  }

  static _download() {
    return new Promise((resolve, reject) => {
      console.log('[VAD] 正在下载模型 (~1.7MB)...')
      const file = fs.createWriteStream(MODEL_FILE)
      https.get(MODEL_URL, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, (r2) => {
            r2.pipe(file)
            file.on('finish', () => { file.close(); resolve() })
            file.on('error', reject)
          }).on('error', reject)
          return
        }
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        file.on('error', reject)
      }).on('error', reject)
    })
  }
}

module.exports = { SileroVAD, FRAME_SIZE, SR, THRESHOLD }
