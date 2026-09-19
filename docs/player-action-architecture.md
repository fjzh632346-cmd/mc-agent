# Minecraft AI Partner Player Action Architecture

This project should evolve toward a layered player-action architecture. The goal is to let AI planning decide goals while concrete Mineflayer operations stay isolated in action modules.

## Recommended Structure

```text
core/
  app.js                  # future entrypoint: config, bot startup, lifecycle wiring
  config.js               # env/default config loading
  events.js               # shared event bus

ai/
  chat-agent.js           # DeepSeek conversation loop
  tools.js                # AI tool schemas
  tool-router.js          # maps AI tool calls to tasks or queries
  planner.js              # future high-level goal planner

voice/
  asr.js                  # current asr.js should move here later
  tts.js                  # current tts.js should move here later
  mic-recorder.js         # current mic-recorder.js should move here later

memory/
  memory-store.js         # player/world/task memory persistence
  locations.js            # home, cave, chest, death point, village, farm
  task-history.js         # successes, failures, cooldowns

perception/
  world-state.js          # nearby blocks/entities/danger/time/weather/inventory summary

tasks/
  task-manager.js         # queue, priority, status, retries, current task
  task-types.js           # future task definitions and validation

actions/
  move.js                 # pathfinder movement primitives
  mine.js                 # find ore, dig block
  build.js                # place blocks from templates
  craft.js                # recipes and crafting table use
  fight.js                # low-level combat primitives
  farm.js                 # crops and animals
  inventory.js            # equip, deposit, withdraw, sort
  explore.js              # scouting movement primitives

systems/
  survival-system.js      # food, health, night, emergency behavior
  mining-system.js        # mining workflows built from actions
  building-system.js      # template construction workflows
  combat-system.js        # tactical combat workflows
  farming-system.js       # farm harvest/replant workflows
  exploration-system.js   # exploration and waypoint discovery
```

## Module Responsibilities

`core` owns startup and wiring. It should create the bot, load plugins, load config, and connect events. It should not contain mining/building details.

`ai` owns chat, prompt context, tool schemas, and planning. It decides "mine iron" or "build hut", but does not directly call `bot.dig()` or `bot.placeBlock()`.

`voice` keeps ASR/TTS/microphone logic unchanged. Voice should only produce final user text and pass it into the same chat entrypoint.

`memory` records durable facts: home, chests, caves, farms, death points, player preferences, task history, and failures.

`perception` turns raw Mineflayer state into compact observations: danger, nearby mobs, blocks, inventory, weather, time, and player state.

`tasks` owns task queueing, priority, retries, cooldowns, current task state, and completion/failure history.

`actions` owns atomic operations. These are small, reusable primitives such as move near, dig block, place block, craft item, equip item, attack, harvest.

`systems` owns workflows that combine actions. Mining finds ore, moves there, checks danger, digs, and returns a task result.

## What bot.js Should Keep

For now, `bot.js` can remain the compatibility shell:

- Create Mineflayer bot and load plugins.
- Keep existing persona, chat, TTS, and voice entrypoints.
- Keep existing hard commands until they are migrated.
- Initialize `TaskManager` on spawn.
- Expose AI tools that enqueue tasks or read task status.

## What Should Move Out Of bot.js Later

- DeepSeek chat loop -> `ai/chat-agent.js`
- Tool schema and tool routing -> `ai/tools.js`, `ai/tool-router.js`
- Hard movement/dig/place/equip helpers -> `actions/*`
- Proactive behavior -> `ai/planner.js` or `systems/survival-system.js`
- Escape/guard/fight logic -> `systems/combat-system.js`
- Auto eat/pickup -> `systems/survival-system.js` and `actions/inventory.js`
- Voice block -> `voice/index.js`

## Implementation Order

1. Minimal foundation: `tasks`, `actions/move`, `actions/mine`, `systems/mining-system`.
2. Perception and memory: world state snapshots, home/chest/cave/death point memory.
3. Survival system: eat, flee danger, return home at night, collect drops.
4. Inventory/crafting: equip, chest deposit/withdraw, crafting recipes.
5. Mining system expansion: tools, torches, stairs, safe return, ore priorities.
6. Building system: templates, material planning, phased construction.
7. Farming/exploration/combat systems.
8. Move `bot.js` startup into `core` and chat/tool routing into `ai`.

## Current Minimal Version

Implemented now:

- `tasks/task-manager.js`
- `actions/move.js`
- `actions/mine.js`
- `perception/world-state.js`
- `systems/mining-system.js`

The AI can enqueue a `mine_ore` task through the `start_task` tool. The task manager runs queued tasks, delegates to `MiningSystem`, and uses `actions/move` plus `actions/mine` for Mineflayer operations.
