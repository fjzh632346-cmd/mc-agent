const BLOCKED_FOODS = new Set(['golden_apple', 'enchanted_golden_apple', 'rotten_flesh', 'spider_eye', 'pufferfish'])

function createRules() {
  const state = {
    wheatCount: null,
    ordinaryFoodCount: 0,
    eatenCount: 0
  }

  return [
    {
      id: 'food-bread-missing-wheat-success',
      module: 'food',
      onLine(line, context) {
        if (line.includes('[FOOD_TASK_START]')) state.wheatCount = null
        if (line.includes('[CRAFT_BREAD_ATTEMPT]')) {
          const wheat = Number(field(line, 'wheat'))
          if (Number.isFinite(wheat)) state.wheatCount = wheat
          const count = Number(field(line, 'count'))
          if (Number.isFinite(wheat) && wheat >= 6 && count === 1) {
            context.addIssue({
              module: 'food',
              title: 'Bread crafting used only one craft despite enough wheat',
              evidence: context.recentLines(8),
              likelyCause: 'Bread crafting may still be using the old default count of one.',
              suggestedFix: 'Craft floor(wheat / 3) bread when no explicit count is requested.',
              key: `food:bread-under-crafted:${wheat}:${count}`
            })
          }
        }

        const badBreadSuccess = state.wheatCount != null && state.wheatCount < 3 &&
          (line.includes('[CRAFT_BREAD_SUCCESS]') || line.includes('[FOOD_TASK_SUCCESS]'))
        if (badBreadSuccess) {
          context.addIssue({
            module: 'food',
            title: 'Bread crafting reported success with fewer than 3 wheat',
            evidence: context.recentLines(8),
            likelyCause: 'Bread crafting did not fail after detecting insufficient wheat.',
            suggestedFix: 'Require wheat >= 3 before CRAFT_BREAD_SUCCESS or FOOD_TASK_SUCCESS.',
            key: `food:bread-success-with-wheat-${state.wheatCount}`
          })
        }
      }
    },
    {
      id: 'food-blocked-choice-with-ordinary-food',
      module: 'food',
      onLine(line, context) {
        if (line.includes('[FOOD_TASK_START]')) {
          state.ordinaryFoodCount = 0
          state.eatenCount = 0
        }
        if (line.includes('[FOOD_IN_INVENTORY]')) {
          const ordinary = Number(field(line, 'ordinaryCount'))
          if (Number.isFinite(ordinary)) state.ordinaryFoodCount = ordinary
        }
        if (line.includes('[FOOD_SELECTED]')) {
          const item = field(line, 'item')
          if (state.ordinaryFoodCount > 0 && BLOCKED_FOODS.has(item)) {
            context.addIssue({
              module: 'food',
              title: 'Risky or precious food selected while ordinary food exists',
              evidence: context.recentLines(8),
              likelyCause: 'Food priority allowed a blocked item before ordinary safe food.',
              suggestedFix: 'Filter golden apples, rotten flesh, spider eyes, and pufferfish out of ordinary food selection.',
              key: `food:blocked-selection:${item}`
            })
          }
        }
      }
    },
    {
      id: 'food-storage-default-too-low',
      module: 'food',
      onLine(line, context) {
        if (!line.includes('[FOOD_FROM_STORAGE_ATTEMPT]')) return
        const count = Number(field(line, 'count'))
        if (count === 1) {
          context.addIssue({
            module: 'food',
            title: 'Food Storage lookup requested only one item',
            evidence: context.recentLines(8),
            likelyCause: 'The Food task did not apply the ordinary-food Storage default.',
            suggestedFix: 'Request a small batch of ordinary food, currently 8, when no count is specified.',
            key: 'food:storage-count-one'
          })
        }
      }
    },
    {
      id: 'food-eat-loop-stopped-early',
      module: 'food',
      onLine(line, context) {
        if (line.includes('[FOOD_TASK_START]')) state.eatenCount = 0
        if (line.includes('[EAT_SUCCESS]')) state.eatenCount += 1
        if (!line.includes('[EAT_LOOP_DONE]')) return
        const food = Number(field(line, 'food'))
        if (Number.isFinite(food) && food < 18 && state.ordinaryFoodCount > state.eatenCount) {
          context.addIssue({
            module: 'food',
            title: 'Eating stopped before hunger was safe',
            evidence: context.recentLines(10),
            likelyCause: 'The Food task may still stop after one bite even when ordinary food remains.',
            suggestedFix: 'Keep eating while food < 18 and ordinary safe food remains.',
            key: `food:eat-loop-stopped-early:${food}:${state.ordinaryFoodCount}:${state.eatenCount}`
          })
        }
      }
    },
    {
      id: 'food-zero-action-success',
      module: 'food',
      onLine(line, context) {
        if (!line.includes('[FOOD_TASK_SUCCESS]')) return
        if (field(line, 'reason') === 'food_already_sufficient') return
        const actionCount = Number(field(line, 'actionCount'))
        const movedCount = Number(field(line, 'movedCount'))
        if (actionCount === 0 && (!Number.isFinite(movedCount) || movedCount === 0)) {
          context.addIssue({
            module: 'food',
            title: 'Food task succeeded without any action',
            evidence: context.recentLines(8),
            likelyCause: 'A no-op food result was marked successful.',
            suggestedFix: 'Fail or report a clear no-work reason instead of FOOD_TASK_SUCCESS with zero actions.',
            key: 'food:zero-action-success'
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
  module: 'food',
  createRules
}
