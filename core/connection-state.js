'use strict'

// Process-wide "are we talking to the server right now" flag.
//
// It exists because the construction run store is created deep inside the
// build task (per task, without access to the bot or its connection), yet it
// must refuse to write verdicts to disk while the socket is dead: after a
// kick, the still-running build chain keeps failing chest opens on a dead
// bot and would otherwise persist a false BLOCKED_MATERIAL_SHORTAGE. bot.js
// flips this from the connection supervisor's online/offline events; nothing
// else writes it. Default is online so tests, CLI tools and acceptance
// scripts that never connect are unaffected.

const state = {
  online: true,
  reason: null,
  changedAt: null
}

function setOnline(online, reason = null) {
  state.online = online !== false
  state.reason = state.online ? null : (reason || 'offline')
  state.changedAt = Date.now()
  return getConnectionState()
}

function isOnline() {
  return state.online
}

function getConnectionState() {
  return { ...state }
}

module.exports = { setOnline, isOnline, getConnectionState }
