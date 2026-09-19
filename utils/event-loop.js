'use strict'

// Give the event loop a turn. `await` on an already-settled promise only
// queues a microtask, which never lets the poll phase run: a chain of
// CPU-heavy steps joined by such awaits starves socket reads for as long as
// the chain lasts, and the Minecraft server kicks the client once its
// keep-alive goes unanswered. setImmediate resolves in the check phase, i.e.
// strictly after pending I/O callbacks have had their turn.
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve))
}

module.exports = { yieldToEventLoop }
