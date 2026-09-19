'use strict'

// She died and nobody noticed (repair round 16, item 2).
//
// mineflayer says it twice: 'death' when health hits zero, 'respawn' once the
// server has put her back at the spawn point. Before this module nothing in
// the repo listened to either, so a death looked like "health suddenly full,
// position suddenly a thousand blocks off" and every system carried on as if
// she were still standing on the worksite: the running task, its locks, the
// paused stack, the worksite anchor, the survival cooldowns. The only thing
// that reacted was TOO_FAR_FROM_BASE, which walked her into a hole.
//
// On 'death' everything that assumed "she is still there" is torn down, in
// one place, through the paths that already exist for external termination:
//   - the current task and the whole paused stack are interrupted with
//     reason=bot_died (BaseTask.interrupt: terminal state, locks released,
//     owner sealed — round 15's rule), and no task feedback is spoken for
//     them; the respawn line covers it
//   - the survival system goes back to freshly-online (cooldowns, last
//     decision, survival pause references, sleep state, worksite anchor)
//   - the goal-system cooldowns follow
//   - the host's legacy flags (escape/fight/eat) are reset via onDeath
// On 'respawn' one line is logged with the distances and one sentence is
// said to the player through the message generator. No new automatic
// behaviour is added afterwards: whether she walks home is still the
// survival system's call.
//
// Everything is injectable (clock, timers, systems getter, say) so the whole
// chain can be driven by a fake bot in a unit test.

const { createReminderEvent, generateReminderMessage, REMINDER_TYPES } = require('../ai/message-generator')

const DEFAULT_RESPAWN_SETTLE_MS = 800
const DEFAULT_RESPAWN_TIMEOUT_MS = 4000
// The server empties the pack before the death packet lands (real machine:
// items=0 at [BOT_DEATH] with 393 items given a minute earlier), so "what
// did she have" is read from the last inventory sample older than this.
const INVENTORY_SETTLE_MS = 750
const INVENTORY_SAMPLE_WINDOW_MS = 60000

function createDeathHandler(options = {}) {
  const logger = options.logger || console
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimeoutFn = options.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = options.clearTimeout || (timer => clearTimeout(timer))
  const settleMs = options.respawnSettleMs ?? DEFAULT_RESPAWN_SETTLE_MS
  const timeoutMs = options.respawnTimeoutMs ?? DEFAULT_RESPAWN_TIMEOUT_MS
  const getSystems = typeof options.systems === 'function' ? options.systems : () => (options.systems || {})
  const say = typeof options.say === 'function' ? options.say : null
  const onDeath = typeof options.onDeath === 'function' ? options.onDeath : null
  const onRespawn = typeof options.onRespawn === 'function' ? options.onRespawn : null

  const state = {
    bot: null,
    lastHealth: null,
    lastDamage: null,
    death: null,
    deaths: 0,
    respawns: 0,
    pending: null,
    inventorySamples: []
  }

  function log(line) {
    logger.log?.(line)
  }

  // Attach to one bot. The supervisor hands out a fresh bot on every
  // reconnect, so the host calls this from the same place it wires the
  // other bot events.
  function attach(bot) {
    if (!bot || typeof bot.on !== 'function') return null
    state.bot = bot
    state.lastHealth = Number.isFinite(bot.health) ? bot.health : null
    const handlers = {
      health: () => trackHealth(bot),
      death: () => { handleDeath(bot).catch(err => log(`[BOT_DEATH_ERROR] ${err.message}`)) },
      respawn: () => { handleRespawn(bot).catch(err => log(`[BOT_RESPAWN_ERROR] ${err.message}`)) }
    }
    // bot.inventory does not exist yet when the host wires its handlers
    // (mineflayer injects plugins after version negotiation, 'inject_allowed'),
    // so the slot listener is bound lazily and idempotently.
    const bound = { inventory: null, onSlot: null }
    const bindInventory = () => {
      const inventory = bot.inventory
      if (!inventory?.on || bound.inventory === inventory) return
      if (bound.inventory) bound.inventory.removeListener?.('updateSlot', bound.onSlot)
      bound.inventory = inventory
      bound.onSlot = () => sampleInventory(bot)
      inventory.on('updateSlot', bound.onSlot)
      sampleInventory(bot)
    }
    handlers.inject_allowed = bindInventory
    handlers.spawn = bindInventory
    const trackHealthAndBind = handlers.health
    handlers.health = () => { bindInventory(); trackHealthAndBind() }
    for (const [name, handler] of Object.entries(handlers)) bot.on(name, handler)
    bindInventory()
    return () => {
      for (const [name, handler] of Object.entries(handlers)) bot.removeListener?.(name, handler)
      bound.inventory?.removeListener?.('updateSlot', bound.onSlot)
    }
  }

  function sampleInventory(bot) {
    const count = countInventory(bot)
    if (count == null) return
    const at = now()
    const samples = state.inventorySamples
    samples.push({ at, count })
    while (samples.length && at - samples[0].at > INVENTORY_SAMPLE_WINDOW_MS && samples.length > 1) samples.shift()
    if (samples.length > 256) samples.splice(0, samples.length - 256)
  }

  // The pack as it was before the death-tick burst of slot clears.
  function inventoryCountBeforeDeath(bot, deathAt) {
    const settled = state.inventorySamples.filter(sample => sample.at <= deathAt - INVENTORY_SETTLE_MS)
    if (settled.length) return settled[settled.length - 1].count
    return countInventory(bot)
  }

  // Remember the last drop in health so the death line can say what hit her.
  // mineflayer has no "damage source" event; the nearest hostile at the time
  // of the drop is the best available witness.
  function trackHealth(bot) {
    const health = Number(bot.health)
    if (!Number.isFinite(health)) return
    const previous = state.lastHealth
    state.lastHealth = health
    if (previous == null || health >= previous) return
    state.lastDamage = {
      amount: round(previous - health),
      healthAfter: round(health),
      at: now(),
      nearestHostile: nearestHostileName(bot)
    }
  }

  async function handleDeath(bot) {
    const systems = getSystems() || {}
    const taskManager = systems.taskManager || null
    const position = clonePosition(bot.entity?.position)
    const current = taskManager?.currentTask || null
    const paused = Array.isArray(taskManager?.pausedStack) ? taskManager.pausedStack.slice() : []
    const deathAt = now()
    const itemsBefore = inventoryCountBeforeDeath(bot, deathAt)
    state.deaths += 1
    state.death = {
      at: deathAt,
      position,
      itemsBefore,
      currentTask: current ? taskLabel(current) : null,
      pausedTasks: paused.map(taskLabel),
      droppedTaskTypes: [current, ...paused].filter(Boolean).map(task => task.type)
    }

    log(`[BOT_DEATH] pos=${formatPosition(position)} health=${formatNumber(bot.health)} lastDamage=${describeDamage(state.lastDamage)} currentTask=${state.death.currentTask || 'none'} paused=[${state.death.pausedTasks.join(',') || ''}] items=${itemsBefore ?? 'UNKNOWN'}`)

    let dropped = []
    if (taskManager?.abortAllForDeath) {
      dropped = await taskManager.abortAllForDeath('bot_died')
    } else if (taskManager) {
      log('[BOT_DEATH] taskManager has no abortAllForDeath; tasks left untouched')
    }

    const goalSystem = systems.goalSystem || null
    const survivalSystem = systems.survivalSystem || goalSystem?.survivalSystem || null
    let survivalReset = null
    if (goalSystem?.resetAfterDeath) survivalReset = goalSystem.resetAfterDeath('bot_died')
    else if (survivalSystem?.resetAfterDeath) survivalReset = survivalSystem.resetAfterDeath('bot_died')

    const anchorAfter = survivalSystem?.worksite?.current?.() ?? survivalSystem?.worksite?.anchor ?? null

    log(`[BOT_DEATH_RESET] droppedTasks=${dropped.map(taskLabel).join(',') || 'none'} pausedCleared=${paused.length} survivalReset=${survivalReset ? 'ok' : 'skipped'} worksiteAnchor=${anchorAfter ? 'still_set' : 'cleared'}`)

    if (onDeath) {
      try {
        onDeath({ ...state.death, dropped })
      } catch (err) {
        log(`[BOT_DEATH_HOOK_ERROR] ${err.message}`)
      }
    }
    return state.death
  }

  // The 'respawn' packet arrives before the server has moved her; wait for
  // the first position sync (forcedMove) or the health-restored spawn, then a
  // short settle, before reading where she is. A timeout keeps a silent
  // server from hanging the announcement forever.
  async function handleRespawn(bot) {
    state.respawns += 1
    await waitForRespawnPosition(bot)
    const systems = getSystems() || {}
    const position = clonePosition(bot.entity?.position)
    const death = state.death
    const base = basePosition(systems.memory)
    const distanceToBase = base && position ? round(distance(base, position)) : null
    const distanceToDeath = death?.position && position ? round(distance(death.position, position)) : null
    const itemsAfter = countInventory(bot)
    const inventoryLost = death?.itemsBefore > 0 ? itemsAfter === 0 : (itemsAfter === 0 ? null : false)
    sampleInventory(bot)

    log(`[BOT_RESPAWN] pos=${formatPosition(position)} distanceToBase=${distanceToBase ?? 'UNKNOWN'} distanceToDeath=${distanceToDeath ?? 'UNKNOWN'} items=${itemsAfter ?? 'UNKNOWN'} inventoryLost=${inventoryLost ?? 'UNKNOWN'} droppedTasks=${death?.droppedTaskTypes?.join(',') || 'none'}`)

    const facts = {
      statusOwner: 'bot',
      deathPosition: death?.position || null,
      respawnPosition: position,
      distanceToBase,
      distanceToDeath,
      inventoryLost,
      droppedTaskTypes: death?.droppedTaskTypes || []
    }
    const event = createReminderEvent(REMINDER_TYPES.BOT_RESPAWN, { facts, source: 'death_handler' })
    let text = event.fallbackText
    try {
      const generated = await generateReminderMessage(event, {
        messageGenerator: systems.messageGenerator || null,
        persona: systems.persona || null,
        logger
      })
      if (generated?.text) text = generated.text
    } catch (err) {
      log(`[BOT_RESPAWN] message generation failed: ${err.message}`)
    }
    if (say && text) {
      try {
        say(text, event)
      } catch (err) {
        log(`[BOT_RESPAWN] say failed: ${err.message}`)
      }
    }
    log(`[BOT_RESPAWN_SAY] text=${text}`)

    const record = { at: now(), position, distanceToBase, distanceToDeath, inventoryLost, text, death }
    state.pending = null
    if (onRespawn) {
      try {
        onRespawn(record)
      } catch (err) {
        log(`[BOT_RESPAWN_HOOK_ERROR] ${err.message}`)
      }
    }
    return record
  }

  function waitForRespawnPosition(bot) {
    return new Promise(resolve => {
      let done = false
      let timer = null
      const finish = () => {
        if (done) return
        done = true
        if (timer) clearTimeoutFn(timer)
        bot.removeListener?.('forcedMove', finish)
        bot.removeListener?.('spawn', finish)
        if (settleMs > 0) setTimeoutFn(resolve, settleMs)
        else resolve()
      }
      bot.once?.('forcedMove', finish)
      bot.once?.('spawn', finish)
      timer = setTimeoutFn(finish, timeoutMs)
    })
  }

  return {
    attach,
    handleDeath,
    handleRespawn,
    state
  }
}

function taskLabel(task) {
  if (!task) return 'none'
  return `${task.type || 'unknown'}#${task.id ?? '?'}`
}

function nearestHostileName(bot) {
  try {
    const entity = bot.nearestEntity?.(candidate => candidate?.type === 'hostile' || candidate?.kind === 'Hostile mobs')
    return entity?.name || entity?.displayName || null
  } catch {
    return null
  }
}

function countInventory(bot) {
  try {
    const items = bot.inventory?.items?.()
    if (!Array.isArray(items)) return null
    return items.reduce((sum, item) => sum + Number(item?.count || 0), 0)
  } catch {
    return null
  }
}

function basePosition(memory) {
  const base = memory?.world?.baseLocation
  if (!base) return null
  return clonePosition(base.position || base)
}

function clonePosition(position) {
  if (!position || !Number.isFinite(Number(position.x))) return null
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function round(value) {
  return Math.round(Number(value) * 10) / 10
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? String(round(value)) : 'UNKNOWN'
}

function formatPosition(position) {
  if (!position) return 'UNKNOWN'
  return `${round(position.x)},${round(position.y)},${round(position.z)}`
}

function describeDamage(damage) {
  if (!damage) return 'UNKNOWN'
  return `${damage.amount}hp->${damage.healthAfter}${damage.nearestHostile ? `(nearest=${damage.nearestHostile})` : ''}`
}

module.exports = { createDeathHandler }
