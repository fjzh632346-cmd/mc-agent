const assert = require('assert')
const { EquipmentSystem } = require('../systems/EquipmentSystem')
const { ActionLock } = require('../core/action-lock')
const { Blackboard } = require('../core/blackboard')

function createContext(overrides = {}) {
  const items = overrides.items || [
    { name: 'stone_pickaxe', count: 1, durability: 100, maxDurability: 131 },
    { name: 'iron_pickaxe', count: 1, durability: 200, maxDurability: 250 },
    { name: 'iron_sword', count: 1, durability: 200, maxDurability: 250 },
    { name: 'iron_axe', count: 1, durability: 200, maxDurability: 250 },
    { name: 'iron_shovel', count: 1, durability: 200, maxDurability: 250 },
    { name: 'bread', count: 5 },
    { name: 'cooked_beef', count: 3 },
    { name: 'oak_planks', count: 64 },
    { name: 'wheat_seeds', count: 12 },
    { name: 'iron_hoe', count: 1, durability: 200, maxDurability: 250 },
    { name: 'diamond_pickaxe', count: 1, durability: 1500, maxDurability: 1561 },
    { name: 'stone_sword', count: 1, durability: 100, maxDurability: 131 }
  ]

  const bot = {
    username: 'Bot',
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    heldItem: overrides.heldItem || null,
    inventory: {
      items: () => items,
      slots: overrides.slots || Array(45).fill(null)
    },
    registry: {
      foodsByName: { bread: { name: 'bread' }, cooked_beef: { name: 'cooked_beef' }, apple: { name: 'apple' } },
      foodsArray: [{ name: 'bread' }, { name: 'cooked_beef' }, { name: 'apple' }],
      blocksByName: {
        stone: { id: 1, name: 'stone' },
        diamond_ore: { id: 56, name: 'diamond_ore', harvestTools: { '278': true } },
        oak_log: { id: 17, name: 'oak_log' },
        dirt: { id: 3, name: 'dirt' }
      },
      itemsArray: [
        { id: 278, name: 'diamond_pickaxe' }
      ]
    },
    equip: async (item, destination) => {
      bot._lastEquipped = item
      bot._lastDestination = destination
    },
    _lastEquipped: null,
    _lastDestination: null
  }

  const blackboard = new Blackboard({
    mobs: { dangerLevel: overrides.dangerLevel || 'none' },
    bot: { health: overrides.health ?? 20, food: overrides.food ?? 20 }
  })

  return {
    bot,
    blackboard,
    actionLock: new ActionLock(),
    equipmentSystem: new EquipmentSystem()
  }
}

async function testSelectBestToolForBlock() {
  let ctx = createContext()
  const eq = new EquipmentSystem()

  let result = eq.selectBestToolForBlock('stone', ctx)
  assert.strictEqual(result.success, true, 'should find tool for stone')
  assert.ok(result.itemName.endsWith('_pickaxe'), 'should select pickaxe for stone')
  assert.strictEqual(result.itemName, 'diamond_pickaxe', 'should prefer diamond over iron')
  console.log(`  ✓ stone → ${result.itemName} (${result.reason})`)

  result = eq.selectBestToolForBlock('oak_log', ctx)
  assert.strictEqual(result.success, true, 'should find axe for log')
  assert.strictEqual(result.itemName, 'iron_axe', 'should select iron_axe')
  console.log(`  ✓ oak_log → ${result.itemName}`)

  result = eq.selectBestToolForBlock('dirt', ctx)
  assert.strictEqual(result.success, true, 'should find shovel for dirt')
  assert.strictEqual(result.itemName, 'iron_shovel', 'should select iron_shovel')
  console.log(`  ✓ dirt → ${result.itemName}`)

  result = eq.selectBestToolForBlock('diamond_ore', ctx)
  assert.strictEqual(result.success, true, 'should find tool for diamond ore')
  assert.ok(result.itemName.includes('pickaxe'), 'diamond_ore needs pickaxe')
  console.log(`  ✓ diamond_ore → ${result.itemName} (min tier: iron+)`)

  console.log('  ✓ selectBestToolForBlock tests passed')
}

async function testMissingRequiredTool() {
  const ctx = createContext({
    items: [
      { name: 'wooden_pickaxe', count: 1, durability: 30, maxDurability: 59 },
      { name: 'bread', count: 3 }
    ]
  })
  const eq = new EquipmentSystem()

  const result = eq.selectBestToolForBlock('diamond_ore', ctx)
  assert.strictEqual(result.success, false, 'wood pickaxe cannot mine diamond ore')
  assert.strictEqual(result.reason, 'missing_required_tool')
  assert.strictEqual(result.allowHand, false)
  console.log(`  ✓ diamond_ore with wood pickaxe → ${result.reason} (expected: ${result.requiredTool})`)

  console.log('  ✓ missingRequiredTool tests passed')
}

async function testPreferredToolAllowsHand() {
  const ctx = createContext({
    items: [
      { name: 'bread', count: 3 }
    ]
  })
  const eq = new EquipmentSystem()

  let result = eq.selectBestToolForBlock('oak_log', ctx)
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.itemName, 'hand')
  assert.strictEqual(result.preferredTool, 'axe')
  assert.strictEqual(result.requiredTool, null)
  assert.strictEqual(result.allowHand, true)

  result = eq.selectBestToolForBlock('sand', ctx)
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.itemName, 'hand')
  assert.strictEqual(result.preferredTool, 'shovel')
  assert.strictEqual(result.requiredTool, null)
  assert.strictEqual(result.allowHand, true)

  result = eq.selectBestToolForBlock('stone', ctx)
  assert.strictEqual(result.success, false)
  assert.strictEqual(result.reason, 'missing_required_tool')
  assert.strictEqual(result.requiredTool, 'wooden_pickaxe_or_better')
  assert.strictEqual(result.allowHand, false)

  console.log('  preferred tools allow hand only when block drops allow it')
}

async function testWeaponSelection() {
  const ctx = createContext()
  const eq = new EquipmentSystem()

  const result = eq.selectBestWeaponForTarget(ctx)
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.itemName, 'iron_axe', 'should prefer highest melee damage')

  const sword = eq.selectBestWeaponForTarget(ctx, { preferredWeaponType: 'sword' })
  assert.strictEqual(sword.success, true)
  assert.strictEqual(sword.itemName, 'iron_sword', 'should honor sword preference when available')
  console.log(`  ✓ weapon → ${result.itemName} (${result.reason})`)

  const noWeaponCtx = createContext({
    items: [
      { name: 'bread', count: 3 },
      { name: 'oak_planks', count: 10 }
    ]
  })
  const noWep = eq.selectBestWeaponForTarget(noWeaponCtx)
  assert.strictEqual(noWep.success, false, 'should detect missing weapon')
  assert.strictEqual(noWep.reason, 'missing_weapon')
  console.log(`  ✓ no weapon → ${noWep.reason}`)

  console.log('  ✓ weaponSelection tests passed')
}

async function testFoodSelection() {
  const ctx = createContext()
  const eq = new EquipmentSystem()

  const result = eq.selectBestFood(ctx)
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.itemName, 'cooked_beef', 'should prefer cooked_beef over bread')
  console.log(`  ✓ food → ${result.itemName} (score: ${result.foodScore})`)

  const emergencyCtx = createContext({
    health: 4,
    dangerLevel: 'high',
    items: [
      { name: 'golden_apple', count: 1 },
      { name: 'bread', count: 3 }
    ]
  })
  const emergency = eq.selectBestFood(emergencyCtx, { survivalState: { health: 4, dangerLevel: 'high' } })
  assert.strictEqual(emergency.success, true)
  assert.strictEqual(emergency.itemName, 'golden_apple', 'should use golden_apple in emergency')
  console.log(`  ✓ emergency food → ${emergency.itemName}`)

  console.log('  ✓ foodSelection tests passed')
}

async function testBlockSelection() {
  const ctx = createContext()
  const eq = new EquipmentSystem()

  const result = eq.selectBlockForBuilding('oak_planks', ctx)
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.itemName, 'oak_planks')
  console.log(`  ✓ building block → ${result.itemName}`)

  const missing = eq.selectBlockForBuilding('cobblestone', ctx)
  assert.strictEqual(missing.success, false)
  assert.strictEqual(missing.reason, 'block_not_in_inventory')
  console.log(`  ✓ missing block → ${missing.reason}`)

  console.log('  ✓ blockSelection tests passed')
}

async function testSeedAndHoeSelection() {
  const ctx = createContext()
  const eq = new EquipmentSystem()

  const seeds = eq.selectSeeds(ctx)
  assert.strictEqual(seeds.success, true)
  assert.strictEqual(seeds.itemName, 'wheat_seeds')
  console.log(`  ✓ seeds → ${seeds.itemName}`)

  const hoe = eq.selectHoe(ctx)
  assert.strictEqual(hoe.success, true)
  assert.strictEqual(hoe.itemName, 'iron_hoe')
  console.log(`  ✓ hoe → ${hoe.itemName}`)

  const noTools = createContext({ items: [{ name: 'bread', count: 3 }] })
  const noHoe = eq.selectHoe(noTools)
  assert.strictEqual(noHoe.success, false)
  console.log(`  ✓ no hoe → ${noHoe.reason}`)

  console.log('  ✓ seed/hoe tests passed')
}

async function testDurabilityAwareness() {
  const ctx = createContext({
    items: [
      { name: 'iron_pickaxe', count: 1, durability: 10, maxDurability: 250 },
      { name: 'stone_pickaxe', count: 1, durability: 100, maxDurability: 131 }
    ]
  })
  const eq = new EquipmentSystem()

  const result = eq.selectBestToolForBlock('stone', ctx)
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.itemName, 'stone_pickaxe', 'should prefer stone over nearly-broken iron')
  console.log(`  ✓ durability check → ${result.itemName} (iron at ${(10/250*100).toFixed(1)}%, stone at ${(100/131*100).toFixed(1)}%)`)

  console.log('  ✓ durabilityAwareness tests passed')
}

async function testEquipBestToolForBlock() {
  const ctx = createContext()
  ctx.bot.heldItem = { name: 'iron_sword' }
  const eq = new EquipmentSystem()

  const result = await eq.equipBestToolForBlock('stone', ctx)
  assert.strictEqual(result.success, true)
  assert.ok(result.equipped, 'should have equipped pickaxe')
  assert.strictEqual(ctx.bot._lastEquipped.name, 'diamond_pickaxe')
  console.log(`  ✓ equip for stone → ${result.itemName}`)

  console.log('  ✓ equipBestToolForBlock tests passed')
}

async function testToolStatus() {
  const ctx = createContext()
  const eq = new EquipmentSystem()

  const status = eq.getToolStatus(ctx)
  assert.strictEqual(status.hasPickaxe, true)
  assert.strictEqual(status.hasAxe, true)
  assert.strictEqual(status.hasShovel, true)
  assert.strictEqual(status.hasSword, true)
  assert.strictEqual(status.hasHoe, true)
  assert.strictEqual(status.hasFood, true)
  assert.strictEqual(status.heldItem, null)
  assert.ok(status.availableTools.length >= 5)

  console.log('  ✓ toolStatus tests passed')
}

async function testArmorSelectionAndEquip() {
  const slots = Array(45).fill(null)
  const ctx = createContext({
    items: [
      { name: 'iron_chestplate', count: 1, durability: 200, maxDurability: 240 }
    ],
    slots
  })
  const eq = new EquipmentSystem()

  const selection = eq.selectBestArmorForSlot('chestplate', ctx)
  assert.strictEqual(selection.success, true)
  assert.strictEqual(selection.itemName, 'iron_chestplate')

  const equipped = await eq.equipBestArmor(ctx, { reason: 'test' })
  assert.strictEqual(equipped.success, true)
  assert.strictEqual(equipped.equippedCount, 1)
  assert.strictEqual(ctx.bot._lastEquipped.name, 'iron_chestplate')
  assert.strictEqual(ctx.bot._lastDestination, 'torso')
  console.log('  armor equip fills missing chestplate')
}

async function testArmorEquipReusesTaskInventoryLock() {
  const slots = Array(45).fill(null)
  const calls = []
  const ctx = createContext({
    items: [
      { name: 'iron_chestplate', count: 1, durability: 200, maxDurability: 240 },
      { name: 'iron_leggings', count: 1, durability: 200, maxDurability: 225 },
      { name: 'iron_boots', count: 1, durability: 180, maxDurability: 195 }
    ],
    slots
  })
  ctx.taskManager = { currentTask: { id: 77 } }
  ctx.actionLock.acquire('inventory', 77)
  ctx.bot.equip = async (item, destination) => {
    calls.push({ item: item.name, destination })
  }

  const eq = new EquipmentSystem()
  const equipped = await eq.equipBestArmor(ctx, { reason: 'test_reentrant_lock' })
  assert.strictEqual(equipped.success, true)
  assert.strictEqual(equipped.equippedCount, 3)
  assert.deepStrictEqual(calls, [
    { item: 'iron_chestplate', destination: 'torso' },
    { item: 'iron_leggings', destination: 'legs' },
    { item: 'iron_boots', destination: 'feet' }
  ])
  assert.strictEqual(ctx.actionLock.getOwner('inventory'), 77)
  console.log('  armor equip reuses task inventory lock and targets armor slots')
}

async function testArmorUpgradeAndNoDowngrade() {
  const slots = Array(45).fill(null)
  slots[6] = { name: 'leather_chestplate', count: 1, durability: 70, maxDurability: 80 }
  let ctx = createContext({
    items: [
      { name: 'iron_chestplate', count: 1, durability: 200, maxDurability: 240 }
    ],
    slots
  })
  let eq = new EquipmentSystem()
  let selection = eq.selectBestArmorForSlot('chestplate', ctx)
  assert.strictEqual(selection.success, true)
  assert.strictEqual(selection.itemName, 'iron_chestplate')
  await eq.equipBestArmor(ctx)
  assert.strictEqual(ctx.bot._lastEquipped.name, 'iron_chestplate')

  const ironSlots = Array(45).fill(null)
  ironSlots[6] = { name: 'iron_chestplate', count: 1, durability: 200, maxDurability: 240 }
  ctx = createContext({
    items: [
      { name: 'leather_chestplate', count: 1, durability: 70, maxDurability: 80 }
    ],
    slots: ironSlots
  })
  eq = new EquipmentSystem()
  selection = eq.selectBestArmorForSlot('chestplate', ctx)
  assert.strictEqual(selection.success, false)
  assert.strictEqual(selection.reason, 'no_upgrade_available')
  console.log('  armor upgrades leather to iron and refuses downgrade')
}

async function testArmorDurabilityAndStatus() {
  const slots = Array(45).fill(null)
  slots[5] = { name: 'iron_helmet', count: 1, durability: 150, maxDurability: 165 }
  const ctx = createContext({
    items: [
      { name: 'diamond_helmet', count: 1, durability: 1, maxDurability: 363 },
      { name: 'iron_helmet', count: 1, durability: 120, maxDurability: 165 },
      { name: 'iron_boots', count: 1, durability: 180, maxDurability: 195 }
    ],
    slots
  })
  const eq = new EquipmentSystem()
  const selection = eq.selectBestArmorForSlot('helmet', ctx)
  assert.strictEqual(selection.success, false, 'nearly broken diamond should not replace healthy iron')
  assert.strictEqual(selection.reason, 'no_upgrade_available')

  const status = eq.getArmorStatus(ctx)
  assert.strictEqual(status.helmet.name, 'iron_helmet')
  assert.ok(status.missingArmorSlots.includes('chestplate'))
  assert.ok(Object.prototype.hasOwnProperty.call(status, 'bestAvailableArmor'))
  console.log('  armor durability and armorState fields are reported')
}

async function run() {
  console.log('[EquipmentSystem Tests]')
  await testSelectBestToolForBlock()
  await testMissingRequiredTool()
  await testPreferredToolAllowsHand()
  await testWeaponSelection()
  await testFoodSelection()
  await testBlockSelection()
  await testSeedAndHoeSelection()
  await testDurabilityAwareness()
  await testEquipBestToolForBlock()
  await testToolStatus()
  await testArmorSelectionAndEquip()
  await testArmorEquipReusesTaskInventoryLock()
  await testArmorUpgradeAndNoDowngrade()
  await testArmorDurabilityAndStatus()
  console.log('equipment-system tests passed')
}

run().catch(err => {
  console.error('EquipmentSystem test failed:', err)
  process.exit(1)
})
