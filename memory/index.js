const { PlayerMemory } = require('./player-memory')
const { TaskMemory } = require('./task-memory')
const { WorldMemory } = require('./world-memory')

class GameMemory {
  constructor(options = {}) {
    this.world = options.world || new WorldMemory(options.worldPath, options)
    this.player = options.player || new PlayerMemory(options.playerPath, options)
    this.task = options.task || new TaskMemory(options.taskPath, options)
  }

  summary() {
    return {
      world: this.world.summary(),
      player: this.player.summary(),
      task: this.task.summary()
    }
  }
}

function createGameMemory(options = {}) {
  return new GameMemory(options)
}

module.exports = {
  GameMemory,
  PlayerMemory,
  TaskMemory,
  WorldMemory,
  createGameMemory
}
