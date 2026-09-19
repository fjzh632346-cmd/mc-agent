function environmentFields(adapter, snapshot = {}, setup = {}) {
  return {
    setupStatus: setup.setupStatus || 'READY',
    setupFailureReason: setup.setupFailureReason || null,
    startupConfig: snapshot.startupConfig || adapter.startupConfig?.() || {},
    configuredAiUsername: snapshot.configuredAiUsername || adapter.aiUsername(),
    configuredTestUsername: snapshot.configuredTestUsername || adapter.testUsername?.() || null,
    acceptancePlayerUsername: snapshot.acceptancePlayerUsername || adapter.testUsername?.() || null,
    onlinePlayers: snapshot.onlinePlayers || adapter.onlinePlayers(),
    acceptancePlayerPosition: snapshot.acceptancePlayerPosition || snapshot.playerPosition || null,
    companionPosition: snapshot.companionPosition || snapshot.aiPosition || null,
    companionPositionSource: snapshot.companionPositionSource || 'none',
    companionPositionFromDebug: Boolean(snapshot.companionPositionFromDebug),
    configuredAiOnline: Boolean(snapshot.configuredAiOnline),
    configuredAiVisible: Boolean(snapshot.configuredAiVisible),
    distancePlayerToAi: snapshot.distancePlayerToAi ?? null,
    recommendedTeleportCommand: snapshot.recommendedTeleportCommand || null,
    companionLookup: snapshot.companionLookup || null,
    debugStatusAvailable: Boolean(snapshot.debugStatusAvailable),
    debugStatusPossibleReason: snapshot.debugStatusPossibleReason || [],
    nearbyBlocksSummary: snapshot.nearbyBlocksSummary || snapshot.nearbyBlocks || {},
    nearbyEntitiesSummary: snapshot.nearbyEntitiesSummary || snapshot.nearbyEntities || [],
    fixtureStatus: setup.fixtureStatus || {}
  }
}

function blockedRecord({ adapter, featureName, testName, commandOrInput, setup, expectedBehavior, regressionRisk, nextSuggestion }) {
  const snapshot = setup.snapshot || {}
  return {
    projectName: adapter.displayProjectName(),
    featureName,
    testName,
    commandOrInput,
    preState: snapshot,
    postState: snapshot,
    observedBehavior: `Fixture setup blocked: ${setup.setupFailureReason || 'unknown'}.`,
    expectedBehavior,
    actualResult: 'environment_blocked',
    judgment: 'BLOCKED',
    passOrFail: 'BLOCKED',
    failureReason: null,
    evidence: {
      setupFailureReason: setup.setupFailureReason || null,
      fixtureStatus: setup.fixtureStatus || {},
      companionLookup: snapshot.companionLookup || null,
      acceptancePlayerPosition: snapshot.acceptancePlayerPosition || snapshot.playerPosition || null,
      companionPosition: snapshot.companionPosition || snapshot.aiPosition || null,
      companionPositionSource: snapshot.companionPositionSource || 'none',
      companionPositionFromDebug: Boolean(snapshot.companionPositionFromDebug),
      distancePlayerToAi: snapshot.distancePlayerToAi ?? null,
      recommendedTeleportCommand: snapshot.recommendedTeleportCommand || null,
      debugStatusAvailable: Boolean(snapshot.debugStatusAvailable),
      debugStatusPossibleReason: snapshot.debugStatusPossibleReason || []
    },
    relatedLogs: [],
    regressionRisk,
    nextSuggestion,
    ...environmentFields(adapter, snapshot, setup)
  }
}

module.exports = {
  blockedRecord,
  environmentFields
}
