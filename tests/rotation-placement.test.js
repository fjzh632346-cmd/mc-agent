const assert = require('assert')
const { isRotationPlacedBlockName, placementLookDirection } = require('../actions/build')

// Pins the round-9 skull/rotation placement fix (boss ruling: REPAIR, not
// exempt). Standing skulls, heads, banners, and signs take their 16-direction
// `rotation` state from the player's yaw at placement, so the bot must face
// the blueprint's direction before placing. Vanilla is asymmetric:
//   signs/banners: rotation = floor((180 + playerYaw) * 16 / 360 + 0.5) & 15
//   skulls/heads:  rotation = floor(playerYaw * 16 / 360 + 0.5) & 15
// (live round 9: facing east placed skull rotation 12 where the sign formula
// predicted 4). The look direction here must round-trip through the matching
// formula, and every path without a rotation state must stay byte-identical
// to before.

function notchianYawDegrees(direction) {
  // direction: x = -sin(yaw), z = cos(yaw)  =>  yaw = atan2(-x, z)
  return Math.atan2(-direction.x, direction.z) * 180 / Math.PI
}

function vanillaSignRotationFromYaw(yawDegrees) {
  return Math.floor(((180 + yawDegrees) * 16) / 360 + 0.5) & 15
}

function vanillaSkullRotationFromYaw(yawDegrees) {
  return Math.floor((yawDegrees * 16) / 360 + 0.5) & 15
}

function testRotationBlockNameClassification() {
  for (const name of [
    'skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head',
    'creeper_head', 'dragon_head', 'piglin_head', 'white_banner', 'red_banner',
    'oak_sign', 'spruce_sign'
  ]) {
    assert.strictEqual(isRotationPlacedBlockName(name), true, `${name} must be rotation-placed`)
  }
  for (const name of [
    'skeleton_wall_skull', 'zombie_wall_head', 'white_wall_banner',
    'oak_wall_sign', 'piston_head', 'stone', 'oak_stairs', 'quartz_stairs',
    'red_bed', ''
  ]) {
    assert.strictEqual(isRotationPlacedBlockName(name), false, `${name || '(empty)'} must NOT be rotation-placed`)
  }
}

function testAllSixteenRotationsRoundTrip() {
  for (let rotation = 0; rotation < 16; rotation++) {
    const skull = placementLookDirection('skeleton_skull', { rotation: String(rotation) })
    assert.ok(skull, `skull rotation ${rotation}: no look direction produced`)
    assert.strictEqual(skull.source, 'rotation_state')
    const skullRecovered = vanillaSkullRotationFromYaw((notchianYawDegrees(skull) + 360) % 360)
    assert.strictEqual(skullRecovered, rotation,
      `skull rotation ${rotation}: looking along (${skull.x.toFixed(3)}, ${skull.z.toFixed(3)}) places rotation ${skullRecovered}`)

    const banner = placementLookDirection('white_banner', { rotation: String(rotation) })
    assert.ok(banner, `banner rotation ${rotation}: no look direction produced`)
    const bannerRecovered = vanillaSignRotationFromYaw(notchianYawDegrees(banner))
    assert.strictEqual(bannerRecovered, rotation,
      `banner rotation ${rotation}: looking along (${banner.x.toFixed(3)}, ${banner.z.toFixed(3)}) places rotation ${bannerRecovered}`)
  }
}

function testCardinalRotationsPointTheRightWay() {
  // Banner/sign: rotation 0 = block faces south = placer faces north (-z).
  const north = placementLookDirection('white_banner', { rotation: '0' })
  assert.ok(Math.abs(north.x) < 1e-9 && north.z < -0.99, `banner rotation 0 placer direction: ${north.x},${north.z}`)
  const east = placementLookDirection('white_banner', { rotation: '4' })
  assert.ok(east.x > 0.99 && Math.abs(east.z) < 1e-9, `banner rotation 4 placer direction: ${east.x},${east.z}`)
  // Skull/head: no 180 offset — rotation 0 = placer faces south (+z),
  // rotation 4 = placer faces west (-x). Live-proven on the villa skull.
  const skullSouth = placementLookDirection('skeleton_skull', { rotation: '0' })
  assert.ok(Math.abs(skullSouth.x) < 1e-9 && skullSouth.z > 0.99, `skull rotation 0 placer direction: ${skullSouth.x},${skullSouth.z}`)
  const skullWest = placementLookDirection('skeleton_skull', { rotation: '4' })
  assert.ok(skullWest.x < -0.99 && Math.abs(skullWest.z) < 1e-9, `skull rotation 4 placer direction: ${skullWest.x},${skullWest.z}`)
}

function testRoundSevenFailureCaseNowOrients() {
  // Live round-7/9 failure position wants skull rotation 4.
  const direction = placementLookDirection('skeleton_skull', { rotation: '4' })
  assert.strictEqual(vanillaSkullRotationFromYaw((notchianYawDegrees(direction) + 360) % 360), 4)
}

function testLegacySkullStatesAreModernizedBeforeOrienting() {
  // Live round-9 failure: the villa skull is a LEGACY skull — its states are
  // { legacyId: 144, legacyData } with no `rotation` key; the expected
  // rotation (4) only exists after modernizeLegacyBlock. The orientation
  // branch must read the modernized states or it silently never fires.
  const direction = placementLookDirection('skeleton_skull', { legacyId: '144', legacyData: '1' })
  assert.ok(direction, 'legacy standing skull produced no look direction')
  assert.strictEqual(direction.source, 'rotation_state')
  assert.strictEqual(vanillaSkullRotationFromYaw((notchianYawDegrees(direction) + 360) % 360), 4,
    'legacy skull (legacyData=1) must orient for rotation 4')
  // Legacy WALL skulls modernize to a facing-based wall variant: no yaw step.
  assert.strictEqual(placementLookDirection('skeleton_skull', { legacyId: '144', legacyData: '3' }), null,
    'legacy wall skull must not take the rotation path')
}

function testNoRotationStateMeansNoOrientationStep() {
  // Without a rotation state the placement path must be exactly as before:
  // no orientation requirement is introduced.
  assert.strictEqual(placementLookDirection('skeleton_skull', null), null)
  assert.strictEqual(placementLookDirection('skeleton_skull', {}), null)
  assert.strictEqual(placementLookDirection('white_banner', { rotation: 'not-a-number' }), null)
}

function testOtherBlockFamiliesUnchanged() {
  // Stairs still orient by facing, plain blocks still need no orientation.
  const stair = placementLookDirection('oak_stairs', { facing: 'north', half: 'bottom' })
  assert.strictEqual(stair.source, 'stair_facing')
  assert.strictEqual(placementLookDirection('stone', { rotation: '4' }), null,
    'rotation state on a non-rotation block must not trigger orientation')
  const bed = placementLookDirection('red_bed', { facing: 'south', part: 'foot' })
  assert.strictEqual(bed.source, 'bed_foot_facing_head')
}

function run() {
  testRotationBlockNameClassification()
  testAllSixteenRotationsRoundTrip()
  testCardinalRotationsPointTheRightWay()
  testRoundSevenFailureCaseNowOrients()
  testLegacySkullStatesAreModernizedBeforeOrienting()
  testNoRotationStateMeansNoOrientationStep()
  testOtherBlockFamiliesUnchanged()
  console.log('rotation placement tests passed')
}

run()
