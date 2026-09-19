const { blockedRecord, environmentFields } = require('./minecraft-case-utils')

const START_COMMAND = '\u8ddf\u7740\u6211'
const STOP_COMMAND = '\u522b\u8ddf\u7740\u6211'

module.exports = {
  featureName: 'following',
  testName: 'follow and stop through natural language',
  commandOrInput: `${START_COMMAND} / ${STOP_COMMAND}`,

  async setup({ adapter }) {
    const cursor = adapter.createLogCursor()
    const setup = await adapter.prepareFixture('following', { logCursor: cursor })
    return { ...setup, cursor }
  },

  async execute({ adapter, projectConfig, setupData }) {
    if (setupData.setupStatus !== 'READY') return { skipped: true }
    const config = projectConfig.minecraft.follow
    const cursor = setupData.cursor
    const preState = setupData.snapshot || await adapter.snapshot({ logCursor: cursor, includeDebugStatus: true })

    await adapter.sendCommand(START_COMMAND)
    await adapter.wait(config.startWaitMs)
    const afterStart = await adapter.snapshot({ logCursor: cursor, includeDebugStatus: true })

    const movement = await adapter.moveTestPlayer({ distance: config.moveDistance })
    await adapter.wait(config.followObserveMs)
    const afterMove = await adapter.snapshot({ logCursor: cursor, includeDebugStatus: true })

    await adapter.sendCommand(STOP_COMMAND)
    await adapter.wait(config.stopWaitMs)
    const beforeStopMove = await adapter.snapshot({ logCursor: cursor, includeDebugStatus: true })
    const stopMovement = await adapter.moveTestPlayer({ distance: config.moveDistance })
    await adapter.wait(config.stopObserveMs)
    const postState = await adapter.snapshot({ logCursor: cursor, includeDebugStatus: true })

    return { config, preState, afterStart, movement, afterMove, beforeStopMove, stopMovement, postState }
  },

  async assert({ setupData, executionData }) {
    if (setupData.setupStatus !== 'READY') return { judgment: 'BLOCKED' }
    const { config, preState, afterStart, afterMove, beforeStopMove, postState } = executionData
    const aiVisible = Boolean(preState.companionPosition || afterStart.companionPosition || afterMove.companionPosition)
    const debugStatusAvailable = [preState, afterStart, afterMove, beforeStopMove, postState].some(snapshot => snapshot.debugStatusAvailable)
    const debugFollowingStarted = [afterStart, afterMove].some(debugIndicatesFollowing)
    const debugFollowingStopped = debugIndicatesStopped(postState)
    const followDistanceChanged = distanceDelta(preState, afterMove)
    const stopDistanceChanged = distanceDelta(beforeStopMove, postState)
    const followDistanceImproved = followDistanceChanged != null && followDistanceChanged > 0.75
    const withinFollowDistance = afterMove.distancePlayerToAi != null && afterMove.distancePlayerToAi <= config.maxFollowDistance
    const keptApproachingAfterStop = stopDistanceChanged != null && stopDistanceChanged > 0.75
    const farAfterStop = postState.distancePlayerToAi != null && postState.distancePlayerToAi >= config.minStoppedDistance
    const followed = aiVisible && (withinFollowDistance || followDistanceImproved)
    const stopped = aiVisible && !keptApproachingAfterStop && (farAfterStop || debugFollowingStopped)
    const taskStarted = postState.taskSignals.following.started || afterMove.taskSignals.following.started
    const taskStopped = postState.taskSignals.following.stopped || beforeStopMove.taskSignals.following.stopped
    const pass = aiVisible && followed && stopped
    return {
      judgment: pass ? 'PASS' : 'FAIL',
      aiVisible,
      followed,
      stopped,
      debugStatusAvailable,
      debugFollowingStarted,
      debugFollowingStopped,
      followDistanceChanged,
      stopDistanceChanged,
      withinFollowDistance,
      followDistanceImproved,
      keptApproachingAfterStop,
      farAfterStop,
      taskStarted,
      taskStopped,
      failureReason: pass ? null : failureReason({ aiVisible, followed, stopped, taskStarted, taskStopped })
    }
  },

  async report({ adapter, setupData, executionData, assertionData, createRecord }) {
    const expectedBehavior = 'The AI companion should follow the test player after the first command and stop following after the second command. Chat response alone is not sufficient.'
    const regressionRisk = 'Movement command routing, TaskManager preemption, and Action Lock movement ownership can regress together.'
    if (assertionData.judgment === 'BLOCKED') {
      return createRecord(blockedRecord({
        adapter,
        featureName: this.featureName,
        testName: this.testName,
        commandOrInput: this.commandOrInput,
        setup: setupData,
        expectedBehavior,
        regressionRisk,
        nextSuggestion: 'Use the online player and coordinate evidence to move the AI companion near the acceptance player, then rerun.'
      }))
    }

    const postState = executionData.postState
    return createRecord({
      projectName: adapter.displayProjectName(),
      featureName: this.featureName,
      testName: this.testName,
      commandOrInput: this.commandOrInput,
      preState: executionData.preState,
      postState,
      observedBehavior: `AI visible=${assertionData.aiVisible}; followed=${assertionData.followed}; stopped=${assertionData.stopped}; taskStarted=${assertionData.taskStarted}; taskStopped=${assertionData.taskStopped}.`,
      expectedBehavior,
      actualResult: assertionData.judgment === 'PASS' ? 'followed_and_stopped' : 'follow_acceptance_failed',
      judgment: assertionData.judgment,
      passOrFail: assertionData.judgment,
      failureReason: assertionData.failureReason,
      evidence: {
        movement: executionData.movement,
        stopMovement: executionData.stopMovement,
        judgmentSignals: {
          debugStatusAvailable: assertionData.debugStatusAvailable,
          debugFollowingStarted: assertionData.debugFollowingStarted,
          debugFollowingStopped: assertionData.debugFollowingStopped,
          followDistanceChanged: assertionData.followDistanceChanged,
          stopDistanceChanged: assertionData.stopDistanceChanged,
          withinFollowDistance: assertionData.withinFollowDistance,
          followDistanceImproved: assertionData.followDistanceImproved,
          keptApproachingAfterStop: assertionData.keptApproachingAfterStop,
          farAfterStop: assertionData.farAfterStop
        },
        afterStart: compactSnapshot(executionData.afterStart),
        afterMove: compactSnapshot(executionData.afterMove),
        beforeStopMove: compactSnapshot(executionData.beforeStopMove),
        final: compactSnapshot(postState)
      },
      relatedLogs: postState.taskSignals.taskStarts.concat(postState.taskSignals.intents).slice(-20),
      regressionRisk,
      nextSuggestion: assertionData.judgment === 'PASS' ? 'Add obstacle and distance-edge following cases.' : 'Inspect route -> intent-to-task -> FollowTask logs and configured player names.',
      ...environmentFields(adapter, postState, setupData)
    })
  }
}

function failureReason(state) {
  if (!state.aiVisible) return 'AI companion entity was not visible to the acceptance player.'
  if (!state.followed) return 'AI companion did not move within the configured follow distance.'
  if (!state.stopped) return 'AI companion did not remain stopped after the stop-follow command.'
  if (!state.taskStarted) return 'No follow task start evidence was found in logs.'
  return 'Following behavior did not satisfy all checks.'
}

function compactSnapshot(snapshot) {
  return {
    startupConfig: snapshot.startupConfig,
    configuredAiUsername: snapshot.configuredAiUsername,
    configuredTestUsername: snapshot.configuredTestUsername,
    acceptancePlayerUsername: snapshot.acceptancePlayerUsername,
    onlinePlayers: snapshot.onlinePlayers,
    playerPosition: snapshot.playerPosition,
    acceptancePlayerPosition: snapshot.acceptancePlayerPosition,
    companionPosition: snapshot.companionPosition,
    companionPositionSource: snapshot.companionPositionSource,
    companionPositionFromDebug: snapshot.companionPositionFromDebug,
    distancePlayerToAi: snapshot.distancePlayerToAi,
    recommendedTeleportCommand: snapshot.recommendedTeleportCommand,
    companionLookup: snapshot.companionLookup,
    debugStatusAvailable: snapshot.debugStatusAvailable,
    debugStatusPossibleReason: snapshot.debugStatusPossibleReason,
    debugStatus: snapshot.debugStatus,
    chatMessages: snapshot.chatMessages,
    taskSignals: snapshot.taskSignals
  }
}

function distanceDelta(before, after) {
  if (before?.distancePlayerToAi == null || after?.distancePlayerToAi == null) return null
  return Math.round((before.distancePlayerToAi - after.distancePlayerToAi) * 100) / 100
}

function debugIndicatesFollowing(snapshot) {
  const status = snapshot?.debugStatus?.status
  if (!status) return false
  if (status.isFollowing === true) return true
  return [status.currentTask, status.taskType, status.actionKey]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes('follow'))
}

function debugIndicatesStopped(snapshot) {
  const status = snapshot?.debugStatus?.status
  if (!status) return false
  if (status.isFollowing === false && !status.followTarget) return true
  return [status.currentTask, status.taskType, status.actionKey]
    .filter(Boolean)
    .every(value => !String(value).toLowerCase().includes('follow'))
}
