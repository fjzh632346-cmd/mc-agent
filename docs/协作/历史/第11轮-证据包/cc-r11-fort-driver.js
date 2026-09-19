// Round 11: fort-wall-gate babysitter (adapted from round-9 watcher).
// Stops the runaway survival task, parks LinXia at the site, resumes the
// ACTIVE fort run, and applies the sanctioned fixture remedies on failure:
//  - BLOCKED_MATERIAL_SHORTAGE -> rcon give (recorded)
//  - path-class failure / runaway -> rescue tp back to the site (recorded)
//  - same place_failed target 3x in a row -> give up (resume checkpoint)
// Exits 0 on completion, 2 on repeated-target give-up, 3 on time budget.
const fs = require('fs')
const mineflayer = require('mineflayer')
const { spawnSync } = require('child_process')

const LOG = 'logs/bot-current.log'
const MAX_CYCLES = 40
const MAX_MS = Number(process.env.DRIVER_BUDGET_MS || 50 * 60 * 1000)
const SITE = { x: 597, y: 67, z: -22 } // staging strip just west of origin
const RESUME_CMD = 'build fort wall gate'

function rcon(cmd) {
  const r = spawnSync('node', ['scripts/mc-rcon.js', cmd], {
    encoding: 'utf8',
    env: { ...process.env, MC_RCON_PORT: '25575', MC_RCON_PASSWORD: process.env.MC_RCON_PASSWORD }
  })
  return ((r.stdout || '') + (r.stderr || '')).trim()
}
function linxiaPos() {
  const out = rcon('data get entity LinXia Pos')
  const m = out.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null
}
function log(...args) { console.log(new Date().toISOString(), ...args) }
const wait = ms => new Promise(r => setTimeout(r, ms))

let lastSize = fs.statSync(LOG).size
function newLogLines() {
  const size = fs.statSync(LOG).size
  if (size < lastSize) lastSize = 0
  if (size === lastSize) return []
  const fd = fs.openSync(LOG, 'r')
  const buf = Buffer.alloc(size - lastSize)
  fs.readSync(fd, buf, 0, buf.length, lastSize)
  fs.closeSync(fd)
  lastSize = size
  return buf.toString('utf8').split(/\r?\n/)
}

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'accept_tester', version: '1.21.8', auth: 'offline'
})

const failTargets = []
let lastPos = null

bot.once('spawn', async () => {
  log('DRIVER_SPAWNED')
  await wait(1500)
  if (process.env.DRIVER_ATTACH === '1') {
    newLogLines() // attach mode: build already running, just watch
    log('ATTACH_MODE no initial stop/resume')
  } else {
    bot.chat('停止任务')
    await wait(2500)
    rcon(`tp LinXia ${SITE.x} ${SITE.y + 1} ${SITE.z}`)
    log('ACTION initial_park_tp')
    await wait(1500)
    newLogLines() // drop backlog
    bot.chat(RESUME_CMD)
    log('ACTION initial_resume')
    await wait(6000)
  }

  const startedAt = Date.now()
  let cycles = 0
  while (Date.now() - startedAt < MAX_MS && cycles < MAX_CYCLES) {
    const lines = newLogLines()
    let terminal = null
    for (const line of lines) {
      if (/\[TaskManager\] completed #\d+ build_blueprint/.test(line)) { terminal = { done: true }; break }
      const m = line.match(/\[task-manager\] fail task=build_blueprint id=\d+ reason=(\S+)/)
      if (m) terminal = { reason: m[1] }
      const t = line.match(/REPAIR_TRIGGER\] reason=\S+ target=(\S+) block=(\S+)/)
      if (t) terminal = { ...(terminal || {}), target: t[1], block: t[2], reason: terminal?.reason }
    }

    if (terminal?.done) {
      log('FORT_COMPLETED')
      bot.quit('fort_completed')
      setTimeout(() => process.exit(0), 1500)
      return
    }

    if (terminal?.reason) {
      cycles += 1
      log(`CYCLE_${cycles} terminal=${terminal.reason} target=${terminal.target || '?'} block=${terminal.block || '?'}`)
      if (terminal.target) {
        failTargets.push(terminal.target)
        const recent = failTargets.slice(-3)
        if (recent.length === 3 && recent.every(t => t === terminal.target)) {
          log(`GIVE_UP repeated_target=${terminal.target} block=${terminal.block}`)
          bot.quit('repeated_target')
          setTimeout(() => process.exit(2), 1500)
          return
        }
      }
      if (/BLOCKED_MATERIAL_SHORTAGE/.test(terminal.reason)) {
        const items = [...terminal.reason.matchAll(/([a-z_0-9]+):(\d+)/g)]
        for (const [, name, count] of items.slice(0, 6)) {
          const give = Math.min(64, Math.max(8, Number(count)))
          log(`ACTION give ${name} x${give}: ${rcon(`give LinXia minecraft:${name} ${give}`).slice(0, 60)}`)
        }
      } else {
        const pos = linxiaPos()
        const far = pos && (Math.abs(pos.x - 604) > 30 || Math.abs(pos.z - (-8)) > 40)
        const pinned = pos && lastPos && Math.abs(pos.x - lastPos.x) < 0.01 && Math.abs(pos.z - lastPos.z) < 0.01
        log(`pos=${JSON.stringify(pos)} far=${far} pinned=${pinned}`)
        if (far || pinned) {
          bot.chat('停止任务')
          await wait(2000)
          rcon(`tp LinXia ${SITE.x} ${SITE.y + 1} ${SITE.z}`)
          log('ACTION rescue_tp_site')
        }
        lastPos = pos
      }
      await wait(3000)
      bot.chat(RESUME_CMD)
      log('ACTION resume_sent')
      await wait(8000)
      continue
    }

    // chest-unreachable loop while standing on the structure: tp down to chest
    const chestLoop = lines.filter(l => l.includes('CHEST_PATH_UNREACHABLE')).length
    if (chestLoop >= 2) {
      rcon(`tp LinXia ${SITE.x + 0.5} 68 ${SITE.z - 0.5}`)
      log(`ACTION chest_rescue_tp (loop x${chestLoop})`)
      await wait(5000)
      continue
    }

    // no terminal: watch for runaway survival tasks pulling her off-site
    const pos = linxiaPos()
    if (pos && (Math.abs(pos.x - 604) > 60 || Math.abs(pos.z - (-8)) > 60)) {
      log(`RUNAWAY pos=${JSON.stringify(pos)}`)
      bot.chat('停止任务')
      await wait(2000)
      rcon(`tp LinXia ${SITE.x} ${SITE.y + 1} ${SITE.z}`)
      await wait(1500)
      bot.chat(RESUME_CMD)
      log('ACTION runaway_rescue_and_resume')
      await wait(8000)
    }
    await wait(4000)
  }

  log(`TIME_BUDGET_OR_CYCLES cycles=${cycles}`)
  bot.quit('driver_budget')
  setTimeout(() => process.exit(3), 1500)
})
bot.on('kicked', r => { console.error('KICKED', JSON.stringify(r)); process.exit(1) })
bot.on('error', e => { console.error('BOT_ERROR', e.message) })
