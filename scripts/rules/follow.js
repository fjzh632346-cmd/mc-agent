function createRules() {
  let stopSeen = null

  return [
    {
      id: 'follow-did-not-stop',
      module: 'follow',
      onLine(line, context) {
        const stopIntent = line.match(/actionKey=(CANCEL_TASK|INTERRUPT_TASK|STOP_FOLLOW|PAUSE_TASK)/) ||
          line.includes('[TASK_INTERRUPT_ATTEMPT]') ||
          line.includes('[TASK_PAUSE_ATTEMPT]')
        if (stopIntent) {
          stopSeen = {
            line,
            taskId: extractTaskId(line),
            remainingLines: 120
          }
          return
        }

        if (!stopSeen) return

        if (line.includes('[TASK_RESUMED]') || line.includes('actionKey=RESUME_TASK')) {
          stopSeen = null
          return
        }

        stopSeen.remainingLines -= 1
        if (stopSeen.remainingLines <= 0) {
          stopSeen = null
          return
        }

        const followUpdate = line.match(/\[Task:follow_player#(\d+)\] update/)
        const movementAcquire = line.includes('[ACTION_LOCK_ACQUIRE]') &&
          line.includes('lock=movement') &&
          (!stopSeen.taskId || line.includes(`taskId=${stopSeen.taskId}`))

        if (!followUpdate && !movementAcquire) return
        if (followUpdate && stopSeen.taskId && followUpdate[1] !== stopSeen.taskId) return

        context.addIssue({
          module: 'follow',
          title: 'Follow task continued after stop or pause',
          evidence: [stopSeen.line, ...context.recentLines(6)],
          likelyCause: 'FollowTask was not paused/interrupted, or a stale pathfinder goal/action lock kept running.',
          suggestedFix: 'Verify TaskManager pause/interrupt, FollowTask cleanup, pathfinder.setGoal(null), and movement lock release.',
          key: `follow:did-not-stop:${stopSeen.taskId || 'unknown'}`
        })
      }
    }
  ]
}

function extractTaskId(line) {
  const match = String(line).match(/taskId=(\d+)|#(\d+)/)
  return match ? (match[1] || match[2]) : null
}

module.exports = {
  module: 'follow',
  createRules
}
