function createRules() {
  let pendingAction = null
  let confirmationLine = null
  let linesSinceConfirmation = 0

  return [
    {
      id: 'tick-loop-update-failed',
      module: 'core',
      onLine(line, context) {
        if (!line.includes('[TickLoop] update failed') && !line.includes('pos.floored is not a function')) return
        context.addIssue({
          module: 'core',
          title: 'TickLoop update failed',
          evidence: context.recentLines(6),
          likelyCause: 'TickLoop or WorldState threw during update, which can destabilize task execution.',
          suggestedFix: 'Inspect the stack in bot-current.log and fix the underlying update path.',
          key: 'core:tick-loop-update-failed'
        })
      }
    },
    {
      id: 'pending-action-lost',
      module: 'core',
      onLine(line, context) {
        if (line.includes('PENDING_ACTION_SET')) {
          pendingAction = context.recentLines(3)
          confirmationLine = null
          linesSinceConfirmation = 0
          return
        }

        if (pendingAction && line.match(/好|可以|拿吧|继续|再试一次/)) {
          confirmationLine = line
          linesSinceConfirmation = 0
          return
        }

        if (!pendingAction) return

        if (line.includes('CONFIRMATION_MATCHED') || line.includes('PENDING_ACTION_EXECUTE')) {
          pendingAction = null
          confirmationLine = null
          return
        }

        if (confirmationLine) {
          linesSinceConfirmation += 1
          if (linesSinceConfirmation > 25) {
            context.addIssue({
              module: 'core',
              title: 'Pending action confirmation was not executed',
              evidence: [...pendingAction, confirmationLine, ...context.recentLines(4)],
              likelyCause: 'The second-step confirmation chain lost the pending action.',
              suggestedFix: 'Check pending action storage, confirmation matching, and command routing.',
              key: `core:pending-action-lost:${confirmationLine}`
            })
            pendingAction = null
            confirmationLine = null
          }
        }
      }
    }
  ]
}

module.exports = {
  module: 'core',
  createRules
}
