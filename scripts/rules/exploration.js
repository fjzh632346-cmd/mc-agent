function createRules() {
  let explorationFollow = null
  let explorationSafe = null
  let pendingClear = null
  let highDanger = null
  let rejectedByPos = new Map()
  let pendingDangerMemory = null
  let pendingPlaceMemory = null
  let lastSummary = null
  let lastFollowTaskId = null

  return [
    {
      id: 'exploration-follow-interference',
      module: 'exploration',
      onLine(line, context) {
        const followUpdate = line.match(/\[Task:follow_player#(\d+)\] update/)
        if (followUpdate) lastFollowTaskId = followUpdate[1]

        if (line.includes('[EXPLORATION_TASK_START]')) {
          explorationFollow = { line, remainingLines: 200 }
          return
        }
        if (!explorationFollow) return

        if (line.includes('[EXPLORATION_TASK_SUCCESS]') || line.includes('[EXPLORATION_TASK_FAILED]')) {
          explorationFollow = null
          return
        }
        explorationFollow.remainingLines -= 1
        if (explorationFollow.remainingLines <= 0) {
          explorationFollow = null
          return
        }

        const lockTaskId = extractTaskId(line)
        const followLock = line.includes('[ACTION_LOCK_ACQUIRE]') &&
          line.includes('lock=movement') &&
          lastFollowTaskId &&
          lockTaskId === lastFollowTaskId
        if (!followUpdate && !followLock) return

        context.addIssue({
          module: 'exploration',
          title: 'Exploration task was interrupted by follow movement',
          evidence: [explorationFollow.line, ...context.recentLines(6)],
          likelyCause: 'follow_player was not preempted or its movement lock/pathfinder goal remained active.',
          suggestedFix: 'Preempt follow_player for player exploration commands, release movement lock, and clear the pathfinder goal.',
          key: 'exploration:follow-interference'
        })
      }
    },
    {
      id: 'exploration-pathfinder-not-cleared',
      module: 'exploration',
      onLine(line, context) {
        if (line.includes('[RETURN_TASK_START]') || line.includes('actionKey=CANCEL_TASK')) {
          pendingClear = { line, remainingLines: 20 }
          return
        }
        if (!pendingClear) return
        if (line.includes('[PATHFINDER_GOAL_CLEAR]')) {
          pendingClear = null
          return
        }
        pendingClear.remainingLines -= 1
        if (pendingClear.remainingLines > 0) return

        context.addIssue({
          module: 'exploration',
          title: 'Return or cancel did not clear pathfinder goal',
          evidence: [pendingClear.line, ...context.recentLines(6)],
          likelyCause: 'A return/cancel path did not call pathfinder.setGoal(null), pathfinder.stop(), or clear control states.',
          suggestedFix: 'Clear pathfinder goal and bot controls when returning, cancelling, pausing, or interrupting exploration.',
          key: `exploration:pathfinder-not-cleared:${pendingClear.line}`
        })
        pendingClear = null
      }
    },
    {
      id: 'exploration-high-danger-continued',
      module: 'exploration',
      onLine(line, context) {
        const danger = parseDanger(line)
        if (danger && danger.severity >= 8) {
          highDanger = { line, remainingLines: 80 }
          pendingDangerMemory = { line, remainingLines: 20 }
          return
        }
        if (!highDanger) return
        if (line.includes('[EXPLORE_ABORT_DANGER]') || line.includes('[RETURN_TASK_START]') || line.includes('[EXPLORATION_TASK_FAILED]')) {
          highDanger = null
          return
        }
        if (line.includes('[PATH_TO_EXPLORE_START]')) {
          context.addIssue({
            module: 'exploration',
            title: 'Exploration continued after high danger',
            evidence: [highDanger.line, ...context.recentLines(6)],
            likelyCause: 'Danger handling did not abort or return before starting another path.',
            suggestedFix: 'Stop exploration and return/guard when high-severity danger is detected.',
            key: `exploration:high-danger-continued:${highDanger.line}`
          })
          highDanger = null
          return
        }
        highDanger.remainingLines -= 1
        if (highDanger.remainingLines <= 0) highDanger = null
      }
    },
    {
      id: 'exploration-success-without-safe-point',
      module: 'exploration',
      onLine(line, context) {
        if (line.includes('[EXPLORATION_TASK_START]')) {
          explorationSafe = { line, remainingLines: 200, safePointSelected: false }
          return
        }
        if (!explorationSafe) return
        if (line.includes('[SAFE_POINT_SELECTED]')) explorationSafe.safePointSelected = true
        if (!line.includes('[EXPLORATION_TASK_SUCCESS]')) return
        if (!explorationSafe.safePointSelected) {
          context.addIssue({
            module: 'exploration',
            title: 'Exploration succeeded without a selected safe point',
            evidence: [explorationSafe.line, ...context.recentLines(8)],
            likelyCause: 'Success condition did not require a reachable safe target or recorded exploration result.',
            suggestedFix: 'Require SAFE_POINT_SELECTED, explored area, discovery, or danger record before success.',
            key: `exploration:success-without-safe-point:${explorationSafe.line}`
          })
        }
        explorationSafe = null
      }
    },
    {
      id: 'exploration-selected-rejected-danger-point',
      module: 'exploration',
      onLine(line, context) {
        const reject = line.match(/\[EXPLORE_CANDIDATE_REJECT\].*pos=([^\s]+).*reason=(lava|cliff|water)/)
        if (reject) {
          rejectedByPos.set(reject[1], { line, reason: reject[2], remainingLines: 120 })
          return
        }

        for (const [pos, rejectInfo] of [...rejectedByPos.entries()]) {
          rejectInfo.remainingLines -= 1
          if (rejectInfo.remainingLines <= 0) rejectedByPos.delete(pos)
        }

        const selected = line.match(/\[SAFE_POINT_SELECTED\].*pos=([^\s]+)/)
        if (!selected) return
        const rejected = rejectedByPos.get(selected[1])
        if (!rejected) return

        context.addIssue({
          module: 'exploration',
          title: 'Exploration selected a previously rejected dangerous point',
          evidence: [rejected.line, ...context.recentLines(6)],
          likelyCause: 'Candidate rejection state was not honored when selecting the safe exploration target.',
          suggestedFix: 'Keep rejected positions out of the safe target selection set.',
          key: `exploration:selected-rejected:${selected[1]}`
        })
      }
    },
    {
      id: 'exploration-false-success',
      module: 'exploration',
      onLine(line, context) {
        if (line.includes('[EXPLORATION_SUMMARY]')) {
          lastSummary = parseSummary(line)
          return
        }
        if (!line.includes('[EXPLORATION_TASK_SUCCESS]') || !lastSummary) return
        if (lastSummary.visited === 0 && lastSummary.discovered === 0 && lastSummary.dangerZones === 0) {
          context.addIssue({
            module: 'exploration',
            title: 'Exploration reported success with no useful result',
            evidence: context.recentLines(8),
            likelyCause: 'Exploration success was not gated on movement, explored area, discovery, or danger record.',
            suggestedFix: 'Treat zero-visited/zero-discovery/zero-danger exploration as failed or inconclusive.',
            key: `exploration:false-success:${line}`
          })
        }
      }
    },
    {
      id: 'exploration-danger-memory-missing',
      module: 'exploration',
      onLine(line, context) {
        if (line.includes('[DANGER_DETECTED]')) {
          pendingDangerMemory = { line, remainingLines: 20 }
          return
        }
        if (!pendingDangerMemory) return
        if (line.includes('[DANGER_ZONE_RECORDED]') || line.includes('[MEMORY_WRITE] key=dangerZones')) {
          pendingDangerMemory = null
          return
        }
        pendingDangerMemory.remainingLines -= 1
        if (pendingDangerMemory.remainingLines > 0) return
        context.addIssue({
          module: 'exploration',
          title: 'Danger was detected but not written to memory',
          evidence: [pendingDangerMemory.line, ...context.recentLines(6)],
          likelyCause: 'Danger scan logged a hazard without recording dangerZones.',
          suggestedFix: 'Call world memory danger recording whenever a hazard is detected.',
          key: `exploration:danger-memory-missing:${pendingDangerMemory.line}`
        })
        pendingDangerMemory = null
      }
    },
    {
      id: 'exploration-place-memory-missing',
      module: 'exploration',
      onLine(line, context) {
        if (line.includes('[PLACE_DISCOVERED]')) {
          pendingPlaceMemory = { line, remainingLines: 20 }
          return
        }
        if (!pendingPlaceMemory) return
        if (line.includes('[MEMORY_WRITE] key=discoveredPlaces')) {
          pendingPlaceMemory = null
          return
        }
        pendingPlaceMemory.remainingLines -= 1
        if (pendingPlaceMemory.remainingLines > 0) return
        context.addIssue({
          module: 'exploration',
          title: 'Discovered place was not written to memory',
          evidence: [pendingPlaceMemory.line, ...context.recentLines(6)],
          likelyCause: 'Place discovery logging and world memory writes are not coupled.',
          suggestedFix: 'Write discoveredPlaces/world memory immediately after PLACE_DISCOVERED.',
          key: `exploration:place-memory-missing:${pendingPlaceMemory.line}`
        })
        pendingPlaceMemory = null
      }
    }
  ]
}

function parseDanger(line) {
  if (!line.includes('[DANGER_DETECTED]')) return null
  const severityMatch = line.match(/severity=(high|\d+)/)
  const raw = severityMatch ? severityMatch[1] : '0'
  return { severity: raw === 'high' ? 9 : Number(raw) || 0 }
}

function parseSummary(line) {
  return {
    visited: Number(line.match(/visited=(\d+)/)?.[1] || 0),
    discovered: Number(line.match(/discovered=(\d+)/)?.[1] || 0),
    dangerZones: Number(line.match(/dangerZones=(\d+)/)?.[1] || 0)
  }
}

function extractTaskId(line) {
  const match = String(line).match(/taskId=(\d+)/)
  return match ? match[1] : null
}

module.exports = {
  module: 'exploration',
  createRules
}
