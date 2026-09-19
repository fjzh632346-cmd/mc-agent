# Full Manual Test Checklist

This checklist is for the first real Minecraft integration pass after the mock-tested Building, Storage, Farming, Exploration, and Survival stages.

## 1. Test Preparation

- Start a local or private Minecraft server with the supported Mineflayer version.
- Use a flat, low-risk overworld area near spawn.
- Keep logs visible for `TaskManager`, `GoalSystem`, `PlanningSystem`, and action failures.
- Prepare a small base marker, one chest, wheat seeds, wheat, bread, building blocks, and basic tools.
- Disable unrelated experimental features.
- Confirm voice, persona, TTS, and ASR still start normally before running task tests.

## 2. Base Memory

- Say: `记住这里是基地`.
- Ask: `基地在哪里`.
- Expected:
  - `baseLocation` is written once.
  - Repeating the command updates or keeps the same base, not duplicate places.
  - `get_task_status` shows memory summary with `hasBaseLocation: true`.

## 3. Building

- Prepare enough materials for `small_house`.
- Say: `建个小屋`.
- Expected:
  - A `build_blueprint` task is queued through TaskManager.
  - Building uses building/movement/inventory actions through locks.
  - Missing material failure reports clear missing materials.
  - On completion, `builtStructures` records the blueprint.
- Interrupt test:
  - Start building, then trigger danger or issue stop.
  - Expected locks release and no further block placement after pause/interrupt.

## 4. Storage

- Place a chest near the base.
- Say: `记住这个箱子`.
- Say: `把东西存起来`.
- Say: `从箱子里拿面包`.
- Say: `箱子里有什么`.
- Expected:
  - `chestLocations` records one nearby chest.
  - `bot.openChest` or `bot.openContainer` works.
  - `deposit`, `withdraw`, and `containerItems` work for single chest.
  - Double chest does not crash.
  - Missing chest returns `chest_not_found`.
  - Missing item returns a clear missing item error.
  - movement/inventory locks release on success, failure, pause, and interrupt.

## 5. Farming

- Create or use a small wheat farm.
- Say: `记住这里是农田`.
- Say: `整理一下农田`.
- Say: `做点面包`.
- Say: `吃点东西`.
- Expected:
  - `farmLocations` records one farm and dedupes nearby repeats.
  - Mature wheat is harvested; immature wheat is not broken.
  - Empty farmland is replanted only if enough seeds remain.
  - Missing seeds returns `missingSeeds`.
  - Missing wheat returns `missingWheat`.
  - Bread crafting uses existing crafting path.
  - Eating uses existing inventory/eat path.
  - Excess food can cooperate with Storage when a chest is known.

## 6. Exploration

- Say: `附近探索一下`.
- Say: `找个能挖矿的地方`.
- Say: `你探索过哪些地方`.
- Expected:
  - Exploration stays near base/player.
  - Without base, radius is limited.
  - Safe target avoids lava, water, fall risk, and hostile mobs.
  - Discovered resources write `mineLocations` or `importantPlaces`.
  - Dangerous places write `dangerZones`.
  - `exploredAreas` dedupes nearby records.
  - No digging or building happens during exploration.

## 7. Survival

- Low food:
  - Lower hunger or mock food state.
  - Expected: eat food first; if no food, take from Storage; if wheat is available, make bread; if farm exists, farm cycle; otherwise remind.
- Danger:
  - Spawn or approach a hostile mob.
  - Expected: low-priority tasks pause and `guard_player` is queued.
- Inventory full:
  - Fill inventory with non-essential items.
  - Expected: Storage task queues if chest is known; otherwise return/remind.
- Night and distance:
  - Move away from base at night.
  - Expected: return to base/player is suggested or queued.
- Multiple risks:
  - Combine low health, danger, low food, and inventory full.
  - Expected: only the highest priority survival decision runs.

## 8. Pause / Resume / Interrupt

- Start Building, Farming, Storage, and Exploration tasks one by one.
- Trigger higher-priority Survival events.
- Expected:
  - pause stops movement and bot actions.
  - resume continues only resumable work.
  - interrupt releases all locks and does not continue the old action.
  - TaskManager does not leave stale RUNNING tasks.

## 9. get_task_status

Ask:

- `你现在在干嘛`
- `为什么停了`
- `缺什么`
- `现在安全吗`
- `你记得哪些地方`
- `离基地远吗`
- `背包满了吗`
- `食物够吗`

Expected status fields:

- `currentTask`
- `currentBuildTask`
- `currentStorageTask`
- `currentFarmingTask`
- `currentExplorationTask`
- `survivalStatus`
- `activeLocks`
- `goalStatus`
- `planStatus`
- `memorySummary`
- `lastError`

## 10. Natural Language Misfire Tests

These must not enqueue tasks:

- `你喜欢建房子吗？`
- `箱子系统难不难？`
- `你喜欢种田吗？`
- `以后能不能自动跑图？`
- `安全模式是什么意思？`
- `我们以后要不要做个大农场？`
- `矿洞一般在哪里？`

Expected:

- Result is `CHAT`, `UNKNOWN`, or `needConfirm`.
- TaskManager queue stays unchanged.

## 11. Common Failure Reasons And Logs

- `task_manager_missing`: command path is not wired to TaskManager.
- `memory_missing` or `memory_write_failed`: memory object or disk write failed.
- `chest_not_found`: no remembered or nearby chest.
- `farm_not_found`: no remembered, built, or nearby farm.
- `missingSeeds`: wheat planting lacks spare seeds.
- `missingWheat`: bread crafting lacks wheat.
- `danger_too_high`: low-priority work correctly refused while unsafe.
- `safe_explore_point_not_found`: no safe nearby exploration target.
- `lock_already_held`: another task owns the action lock.

Check:

- task status output
- `messages.lastReminder`
- `messages.lastTaskFeedback`
- goal status / cooldowns
- planning status / failed step
- console logger output
