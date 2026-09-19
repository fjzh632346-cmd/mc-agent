function createRules() {
  const state = {
    immaturePositions: new Set(),
    lastSkippedImmaturePos: null,
    maturePositions: new Set(),
    seedCount: null,
    plantSucceeded: false,
    activeTask: null
  }

  return [
    {
      id: 'farming-immature-harvest',
      module: 'farming',
      onLine(line, context) {
        if (line.includes('[CROP_SCAN_START]')) {
          state.immaturePositions.clear()
          state.lastSkippedImmaturePos = null
          state.maturePositions.clear()
        }

        if (line.includes('[CROP_FOUND]') && line.includes('crop=wheat')) {
          const mature = field(line, 'mature')
          const age = Number(field(line, 'age'))
          const pos = field(line, 'pos')
          if ((Number.isFinite(age) && age < 7) || mature === 'false') {
            if (pos) state.immaturePositions.add(pos)
          } else if (pos && ((Number.isFinite(age) && age >= 7) || mature === 'true')) {
            state.maturePositions.add(pos)
          }
        }

        if (line.includes('[CROP_SKIP_IMMATURE]')) {
          state.lastSkippedImmaturePos = field(line, 'pos')
        }

        if (line.includes('[CROP_HARVEST_ATTEMPT]')) {
          const age = Number(field(line, 'age'))
          const pos = field(line, 'pos')
          if ((Number.isFinite(age) && age < 7) || (pos && state.immaturePositions.has(pos)) || (pos && state.lastSkippedImmaturePos === pos)) {
            context.addIssue({
              module: 'farming',
              title: 'Immature wheat was targeted for harvest',
              evidence: context.recentLines(8),
              likelyCause: 'Harvest filtering did not re-check wheat age or reused a stale immature crop target.',
              suggestedFix: 'Require wheat age >= 7 immediately before harvest and skip immature crop positions.',
              key: `farming:immature-harvest:${pos || age || 'unknown'}`
            })
          }
        }

        if (line.includes('[CROP_HARVEST_SUMMARY]')) {
          const harvested = Number(field(line, 'harvested'))
          if (Number.isFinite(harvested) && state.maturePositions.size > harvested) {
            context.addIssue({
              module: 'farming',
              title: 'Harvest stopped before all mature wheat was handled',
              evidence: context.recentLines(10),
              likelyCause: 'Harvest logic may be processing only the first mature wheat from a scan.',
              suggestedFix: 'Continue scanning and harvesting until no reachable mature wheat remains, then emit the final summary.',
              key: `farming:partial-harvest:${state.maturePositions.size}:${harvested}`
            })
          }
        }
      }
    },
    {
      id: 'farming-missing-seeds-success',
      module: 'farming',
      onLine(line, context) {
        if (line.includes('[PLANT_SCAN_START]') || line.includes('[FARMING_TASK_START]')) state.seedCount = null
        if (line.includes('[SEED_CHECK]') && field(line, 'item') === 'wheat_seeds') {
          const count = Number(field(line, 'count'))
          if (Number.isFinite(count)) state.seedCount = count
        }
        if (line.includes('[FARMING_TASK_SUCCESS]') && state.seedCount === 0) {
          context.addIssue({
            module: 'farming',
            title: 'Farming reported success without wheat seeds',
            evidence: context.recentLines(8),
            likelyCause: 'Planting path treated a missing-seed condition as successful.',
            suggestedFix: 'Return a failed farming task when seed count remains zero after Storage lookup.',
            key: 'farming:seed-count-zero-success'
          })
        }
      }
    },
    {
      id: 'farming-plant-success-then-failed',
      module: 'farming',
      onLine(line, context) {
        if (line.includes('[FARMING_TASK_START]')) state.plantSucceeded = false
        if (line.includes('[PLANT_SUCCESS]')) state.plantSucceeded = true
        if (line.includes('[FARMING_TASK_FAILED]') && state.plantSucceeded) {
          context.addIssue({
            module: 'farming',
            title: 'Farming failed after planting succeeded',
            evidence: context.recentLines(12),
            likelyCause: 'A later optional step, such as bread crafting, may be overriding a successful planting action.',
            suggestedFix: 'Preserve FARMING_TASK_SUCCESS when planting completed and report optional follow-up failures separately.',
            key: 'farming:plant-success-then-failed'
          })
        }
      }
    },
    {
      id: 'farming-seed-withdraw-default-too-low',
      module: 'farming',
      onLine(line, context) {
        if (!line.includes('[CHEST_WITHDRAW_SUCCESS]') || field(line, 'item') !== 'wheat_seeds') return
        const count = Number(field(line, 'count'))
        if (count === 1) {
          context.addIssue({
            module: 'farming',
            title: 'Seed withdrawal defaulted to one item',
            evidence: context.recentLines(10),
            likelyCause: 'The seed Storage intent did not apply the wheat_seeds default count.',
            suggestedFix: 'Default wheat_seeds withdrawals to 16 when the player says "some seeds" without a count.',
            key: 'farming:seed-withdraw-count-one'
          })
        }
      }
    },
    {
      id: 'farming-zero-action-success',
      module: 'farming',
      onLine(line, context) {
        if (!line.includes('[FARMING_TASK_SUCCESS]')) return
        const mode = field(line, 'mode')
        const reason = field(line, 'reason')
        if (mode === 'CHECK_FARM' || mode === 'REMEMBER_FARM' || reason === 'no_empty_farmland') return
        const actionCount = Number(field(line, 'actionCount'))
        const movedCount = Number(field(line, 'movedCount'))
        if (actionCount === 0 && (!Number.isFinite(movedCount) || movedCount === 0)) {
          context.addIssue({
            module: 'farming',
            title: 'Farming task succeeded without any action',
            evidence: context.recentLines(8),
            likelyCause: 'A no-op farming result was marked successful.',
            suggestedFix: 'Fail or report a no-work reason instead of emitting FARMING_TASK_SUCCESS with zero actions.',
            key: 'farming:zero-action-success'
          })
        }
      }
    },
    {
      id: 'farming-food-follow-still-running',
      module: 'farming',
      onLine(line, context) {
        if (line.includes('[FARMING_TASK_START]') || line.includes('[FOOD_TASK_START]') || line.includes('[CRAFT_BREAD_TASK_START]')) {
          state.activeTask = 'farming_or_food'
        }
        if (line.includes('[FARMING_TASK_SUCCESS]') || line.includes('[FARMING_TASK_FAILED]') ||
          line.includes('[FOOD_TASK_SUCCESS]') || line.includes('[FOOD_TASK_FAILED]') ||
          line.includes('[CRAFT_BREAD_TASK_SUCCESS]') || line.includes('[CRAFT_BREAD_TASK_FAILED]')) {
          state.activeTask = null
        }
        if (state.activeTask && (line.includes('[FOLLOW_TASK_UPDATE]') || line.includes('[FOLLOW_TASK_START]'))) {
          context.addIssue({
            module: 'farming',
            title: 'Follow task kept running during Farming/Food',
            evidence: context.recentLines(12),
            likelyCause: 'Follow was paused at the task layer but its movement goal or lock was not cleared.',
            suggestedFix: 'Preempt follow before Farming/Food, clear pathfinder goals and controls, and require explicit resume.',
            key: 'farming:follow-active-during-farming-food'
          })
        }
      }
    }
  ]
}

function field(line, name) {
  const match = String(line).match(new RegExp(`${name}=([^\\s]+)`))
  return match ? match[1] : null
}

module.exports = {
  module: 'farming',
  createRules
}
