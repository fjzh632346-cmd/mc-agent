const assert = require('assert')
const { BuildingSystem, _test: buildingSystemTest } = require('../systems/building-system')
const { resolveMaterialSteps } = require('../systems/material-resolution')

function testStoredResumeOriginIsTheOnlyDistantOriginException() {
  const storedOrigin = { x: 80, y: 70, z: -40 }
  const system = new BuildingSystem({
    constructionRunStore: {
      findActiveForBlueprint(blueprintId) {
        if (blueprintId !== 'resume_house') return null
        return { placementContext: { origin: storedOrigin } }
      }
    }
  })
  const selected = { blueprint: { name: 'resume_house' } }

  assert.strictEqual(system.allowsDistantStoredResumeOrigin(selected, storedOrigin, { resumeOnly: true }), true)
  assert.strictEqual(system.allowsDistantStoredResumeOrigin(selected, storedOrigin, {}), false)
  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin(selected, storedOrigin, { resumeOnly: true, explicitOrigin: true }),
    false
  )
  assert.strictEqual(
    system.allowsDistantStoredResumeOrigin(selected, { ...storedOrigin, x: storedOrigin.x + 1 }, { resumeOnly: true }),
    false
  )
}

function testClassicSchematicProvenanceStatesDoNotTriggerRepair() {
  const origin = { x: 0, y: 64, z: 0 }
  const target = { ...origin }
  const context = {
    bot: {
      blockAt() {
        return { name: 'dirt', properties: {} }
      }
    }
  }
  const status = buildingSystemTest.reconciledStepStatus(context, {
    id: 'legacy-dirt-provenance',
    kind: 'place',
    phase: 'frame',
    position: target,
    blockName: 'dirt',
    states: { legacyId: '3', legacyData: '0', legacyVariant: 'dirt' }
  }, {}, { origin, steps: [], runSteps: {} })

  assert.strictEqual(status, 'verified')
}

function testTerrainAlternativesReserveOriginalMaterialDemand() {
  const steps = [
    { id: 'dirt-1', kind: 'place', blockName: 'dirt', role: 'terrain' },
    { id: 'dirt-2', kind: 'place', blockName: 'dirt', role: 'terrain' },
    { id: 'grass-1', kind: 'place', blockName: 'grass_block', role: 'terrain' },
    { id: 'grass-2', kind: 'place', blockName: 'grass_block', role: 'terrain' }
  ]
  const scarce = resolveMaterialSteps(steps, { dirt: 1, grass_block: 2 }, { skipVerified: false })
  assert.deepStrictEqual(scarce.resolvedRequired, { dirt: 2, grass_block: 2 })
  assert.strictEqual(scarce.steps[1].materialResolution.reason, 'no_available_terrain_alternative')

  const surplus = resolveMaterialSteps(steps, { dirt: 1, grass_block: 3 }, { skipVerified: false })
  assert.deepStrictEqual(surplus.resolvedRequired, { dirt: 1, grass_block: 3 })
  assert.strictEqual(surplus.steps[1].resolvedBlockName, 'grass_block')
}

testStoredResumeOriginIsTheOnlyDistantOriginException()
testClassicSchematicProvenanceStatesDoNotTriggerRepair()
testTerrainAlternativesReserveOriginalMaterialDemand()
console.log('formal construction resume regression tests passed')
