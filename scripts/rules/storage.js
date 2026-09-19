const COMMON_ITEM_WORDS = [
  '牛排', '猪排', '面包', '苹果', '金苹果', '熟牛肉', '熟猪排',
  '鸡肉', '羊肉', '兔肉', '鳕鱼', '鲑鱼', '三文鱼', '土豆',
  '胡萝卜', '甜菜', '蘑菇', '南瓜派', '曲奇', '饼干', '西瓜片',
  '腐肉', '蜘蛛眼', '河豚'
]

function createRules() {
  let storageActive = null
  let memoryChestFailure = null
  let withdrawMissing = null
  let recentFoodQuery = null
  let recentSpecificItemQuery = null
  let recentZeroMove = null
  let lastFollowTaskId = null

  return [
    {
      id: 'storage-follow-interference',
      module: 'storage',
      onLine(line, context) {
        const followUpdateMatch = line.match(/\[Task:follow_player#(\d+)\] update/)
        if (followUpdateMatch) lastFollowTaskId = followUpdateMatch[1]

        if (line.includes('[STORAGE_TASK_START]') || line.includes('[STORAGE_TRANSFER_START]')) {
          storageActive = { line, remainingLines: 200 }
          return
        }
        if (!storageActive) return

        storageActive.remainingLines -= 1
        if (line.includes('[STORAGE_TASK_SUCCESS]') || line.includes('[STORAGE_TASK_FAILED]') || line.includes('[STORAGE_TRANSFER_SUCCESS]') || line.includes('[STORAGE_TRANSFER_FAILED]')) {
          storageActive = null
          return
        }
        if (storageActive.remainingLines <= 0) {
          storageActive = null
          return
        }

        const followUpdate = followUpdateMatch
        const lockTaskId = extractTaskId(line)
        const followLock = line.includes('[ACTION_LOCK_ACQUIRE]') &&
          line.includes('lock=movement') &&
          lastFollowTaskId &&
          lockTaskId === lastFollowTaskId
        if (!followUpdate && !followLock) return

        context.addIssue({
          module: 'storage',
          title: 'Storage task was interrupted by follow movement',
          evidence: [storageActive.line, ...context.recentLines(6)],
          likelyCause: 'Storage did not preempt/pause follow_player before opening or moving to a chest.',
          suggestedFix: 'Ensure player Storage commands pause low-priority follow tasks and release movement locks.',
          key: 'storage:follow-interference'
        })
      }
    },
    {
      id: 'storage-open-container-wrong-type',
      module: 'storage',
      onLine(line, context) {
        if (!line.includes('containerToOpen is neither a block nor an entity')) return
        context.addIssue({
          module: 'storage',
          title: 'Chest open received non-live container object',
          evidence: context.recentLines(8),
          likelyCause: 'openContainer/openChest was called with a plain position object instead of a live Block or Entity.',
          suggestedFix: 'Look up bot.blockAt(Vec3) immediately before opening and pass the returned Block.',
          key: 'storage:open-container-wrong-type'
        })
      }
    },
    {
      id: 'storage-cache-no-rescan',
      module: 'storage',
      onLine(line, context) {
        if (line.includes('[CHEST_SELECTED]') && line.includes('reason=memory')) {
          memoryChestFailure = { selected: line, failed: null, remainingLines: 20 }
          return
        }

        if (!memoryChestFailure) return
        memoryChestFailure.remainingLines -= 1

        if (line.includes('[CHEST_RESCAN]') || line.includes('[CHEST_CACHE_INVALIDATE]')) {
          memoryChestFailure = null
          return
        }

        if (line.includes('[CHEST_OPEN_FAILED]') || line.includes('block_changed') || line.includes('not_found')) {
          memoryChestFailure.failed = line
        }

        if (memoryChestFailure.failed && (line.includes('[STORAGE_TASK_FAILED]') || memoryChestFailure.remainingLines <= 0)) {
          context.addIssue({
            module: 'storage',
            title: 'Memory chest failed without invalidate/rescan',
            evidence: [memoryChestFailure.selected, memoryChestFailure.failed, ...context.recentLines(4)],
            likelyCause: 'A stale chest cache entry was trusted after the block changed.',
            suggestedFix: 'Validate memory chest with bot.blockAt, invalidate changed blocks, then rescan candidates.',
            key: `storage:cache-no-rescan:${memoryChestFailure.selected}`
          })
          memoryChestFailure = null
        }
      }
    },
    {
      id: 'storage-withdraw-single-chest-only',
      module: 'storage',
      onLine(line, context) {
        if (line.includes('[WITHDRAW_SEARCH_CHEST]')) {
          withdrawMissing = null
          return
        }
        if (line.includes('[ITEM_NOT_IN_CHEST]')) {
          withdrawMissing = { line, remainingLines: 12 }
          return
        }
        if (!withdrawMissing) return

        withdrawMissing.remainingLines -= 1
        if (line.includes('[WITHDRAW_SEARCH_NEXT_CHEST]') || line.includes('[WITHDRAW_FOUND_ITEM]')) {
          withdrawMissing = null
          return
        }
        if (line.includes('[STORAGE_TASK_FAILED]') || withdrawMissing.remainingLines <= 0) {
          context.addIssue({
            module: 'storage',
            title: 'Withdraw stopped after first missing chest',
            evidence: [withdrawMissing.line, ...context.recentLines(6)],
            likelyCause: 'Withdraw failed after one chest instead of continuing through remaining candidates.',
            suggestedFix: 'Keep searching sorted chest candidates until the item is found or all candidates are checked.',
            key: `storage:withdraw-single-chest-only:${withdrawMissing.line}`
          })
          withdrawMissing = null
        }
      }
    },
    {
      id: 'storage-food-withdraw-count-too-low',
      module: 'storage',
      onLine(line, context) {
        if (line.match(/食物|吃的|口粮/)) {
          recentFoodQuery = { line, remainingLines: 80 }
        }
        if (!recentFoodQuery) return
        recentFoodQuery.remainingLines -= 1
        if (recentFoodQuery.remainingLines <= 0) {
          recentFoodQuery = null
          return
        }
        if (!line.includes('[CHEST_WITHDRAW_SUCCESS]') || !line.includes('count=1')) return
        context.addIssue({
          module: 'storage',
          title: 'Generic food withdraw only took one item',
          evidence: [recentFoodQuery.line, ...context.recentLines(6)],
          likelyCause: 'Default generic food withdraw count is too small.',
          suggestedFix: 'Use a practical default such as 8 ordinary food items and avoid precious/risky items unless explicit.',
          key: 'storage:food-count-too-low'
        })
      }
    },
    {
      id: 'storage-item-alias-failed',
      module: 'storage',
      onLine(line, context) {
        if (containsCommonItem(line)) recentSpecificItemQuery = { line, remainingLines: 100 }
        if (!recentSpecificItemQuery) return
        recentSpecificItemQuery.remainingLines -= 1
        if (recentSpecificItemQuery.remainingLines <= 0) {
          recentSpecificItemQuery = null
          return
        }

        const failed = line.includes('[ITEM_ALIAS_FAILED]') ||
          line.includes('itemName=null') ||
          line.includes('missing_item_name') ||
          line.includes('item_name_unrecognized') ||
          line.includes('缺少物品名')
        if (!failed) return

        context.addIssue({
          module: 'storage',
          title: 'Chinese item alias failed',
          evidence: [recentSpecificItemQuery.line, ...context.recentLines(6)],
          likelyCause: 'A concrete Chinese item name was present, but the alias resolver did not produce an itemName.',
          suggestedFix: 'Add or fix the alias in utils/item-aliases.js and add a parser regression test.',
          key: `storage:item-alias-failed:${recentSpecificItemQuery.line}`
        })
      }
    },
    {
      id: 'storage-false-success',
      module: 'storage',
      onLine(line, context) {
        if (line.match(/movedCount=0|withdrawnItems=\[\]|storedItems=\[\]|depositCount=0|count=0/)) {
          recentZeroMove = { line, remainingLines: 20 }
        }
        if (!recentZeroMove) return
        recentZeroMove.remainingLines -= 1
        if (recentZeroMove.remainingLines <= 0) {
          recentZeroMove = null
          return
        }
        if (!line.includes('[STORAGE_TASK_SUCCESS]') && !line.includes('[STORAGE_TRANSFER_SUCCESS]')) return
        context.addIssue({
          module: 'storage',
          title: 'Storage reported success with zero moved items',
          evidence: [recentZeroMove.line, ...context.recentLines(6)],
          likelyCause: 'Storage success condition did not require actual deposit/withdraw/transfer count > 0.',
          suggestedFix: 'Gate success on movedCount/depositCount/withdrawnItems and fail when no target item moved.',
          key: `storage:false-success:${recentZeroMove.line}`
        })
      }
    }
  ]
}

function containsCommonItem(line) {
  return COMMON_ITEM_WORDS.some(word => line.includes(word))
}

function extractTaskId(line) {
  const match = String(line).match(/taskId=(\d+)/)
  return match ? match[1] : null
}

module.exports = {
  module: 'storage',
  createRules
}
