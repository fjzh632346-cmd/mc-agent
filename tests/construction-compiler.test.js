const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { LegacyBlueprintAdapter } = require('../systems/blueprint-compatibility-adapter')
const { BlueprintValidator } = require('../systems/blueprint-validator')
const { ConstructionCompiler } = require('../systems/construction-compiler')
const {
  MineflayerConstructionExecutor,
  SchematicPrinterExecutor
} = require('../systems/construction-executor')
const { ProceduralBlueprintGenerator } = require('../systems/procedural-blueprint-generator')

function validatedIR(name) {
  const generated = new ProceduralBlueprintGenerator().generate(name)
  assert.strictEqual(generated.ok, true, name)
  const adapted = new LegacyBlueprintAdapter().fromLegacyBlueprint(generated.blueprint)
  assert.strictEqual(adapted.ok, true, name)
  const validation = new BlueprintValidator().validate(adapted.blueprint)
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics))
  return validation.blueprint
}

function validatedLegacyIR(blueprint) {
  const adapted = new LegacyBlueprintAdapter().fromLegacyBlueprint(blueprint)
  assert.strictEqual(adapted.ok, true, JSON.stringify(adapted.diagnostics))
  const validation = new BlueprintValidator().validate(adapted.blueprint)
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.diagnostics))
  return validation.blueprint
}

function compile(compiler, blueprint) {
  const result = compiler.compile({
    blueprint,
    placementContext: { origin: { x: 0, y: 64, z: 0 } },
    siteSnapshot: { blocks: [], inventoryCounts: richInventory() },
    inventoryPolicy: { counts: richInventory() },
    compilerOptions: { skipScaffolding: true }
  })
  assert.strictEqual(result.ok, true, JSON.stringify(result.diagnostics))
  return result.plan
}

function richInventory() {
  return {
    oak_planks: 1000,
    oak_log: 1000,
    dirt: 1000,
    glass: 1000,
    white_concrete: 1000,
    gray_concrete: 1000,
    stone_bricks: 1000,
    cobblestone: 1000,
    oak_fence: 1000,
    green_wool: 1000,
    blue_wool: 1000,
    white_wool: 1000,
    crafting_table: 1000,
    furnace: 1000,
    chest: 1000
  }
}

function testCompilerIsDeterministic() {
  const compiler = new ConstructionCompiler()
  const blueprint = validatedIR('fountain')
  const first = compile(compiler, blueprint)
  const second = compile(compiler, blueprint)
  assert.deepStrictEqual(second, first)
}

function testCompilerStepContract() {
  const plan = compile(new ConstructionCompiler(), validatedIR('fountain'))
  assert.strictEqual(plan.schemaVersion, 1)
  assert.ok(plan.planId.startsWith('construction_plan_'))
  assert.ok(plan.phases.length > 0)
  assert.ok(plan.steps.length > 0)
  const step = plan.steps.find(candidate => candidate.action === 'place_block')
  assert.ok(step)
  for (const field of ['id', 'sourceBlockKey', 'phase', 'action', 'target', 'block', 'dependencies', 'clearancePolicy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(step, field), field)
  }
  assert.ok(/^step_[a-f0-9]{16}$/.test(step.id), step.id)
  assert.ok(!/^step_0+$/.test(step.id), step.id)
  assert.ok(plan.blueprintHash)
  assert.ok(plan.blueprintRevision)
}

function testCompilerAnnotatesTerrainMaterialPolicy() {
  const plan = compile(new ConstructionCompiler(), validatedLegacyIR({
    name: 'terrain_policy',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'grass_block' },
      { x: 0, y: 1, z: 0, type: 'oak_planks', role: 'wall' }
    ]
  }))
  const step = plan.steps.find(candidate => candidate.block?.id === 'grass_block')
  assert.ok(step, 'missing grass step')
  assert.strictEqual(step.role, 'terrain_fill')
  assert.strictEqual(step.exactRequired, false)
  assert.ok(step.materialAlternatives.includes('dirt'), JSON.stringify(step.materialAlternatives))
}

function testCompilerKeepsStructuralGrassExact() {
  const plan = compile(new ConstructionCompiler(), validatedLegacyIR({
    name: 'structural_grass_policy',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      {
        x: 0,
        y: 0,
        z: 0,
        type: 'grass_block',
        role: 'wall',
        phase: 'wall',
        materialAlternatives: ['grass_block', 'dirt']
      }
    ]
  }))
  const step = plan.steps.find(candidate => candidate.block?.id === 'grass_block')
  assert.ok(step, 'missing structural grass step')
  assert.strictEqual(step.role, 'wall')
  assert.strictEqual(step.exactRequired, true)
  assert.ok(step.materialAlternatives.includes('dirt'), JSON.stringify(step.materialAlternatives))
}

function testWoodHouseAndFountainUseSameCompiler() {
  const compiler = new ConstructionCompiler()
  const woodPlan = compile(compiler, validatedIR('two_story_wood_house'))
  const fountainPlan = compile(compiler, validatedIR('fountain'))
  assert.strictEqual(compiler.constructor, ConstructionCompiler)
  assert.strictEqual(woodPlan.schemaVersion, fountainPlan.schemaVersion)
  assert.notStrictEqual(woodPlan.blueprintId, fountainPlan.blueprintId)
}

function testChangingBlueprintDoesNotChangeExecutorContract() {
  const executor = new MineflayerConstructionExecutor()
  const methods = ['executePlan', 'executeStep', 'pause', 'resume', 'cancel', 'getProgress']
  for (const method of methods) assert.strictEqual(typeof executor[method], 'function', method)
  compile(new ConstructionCompiler(), validatedIR('fountain'))
  compile(new ConstructionCompiler(), validatedIR('two_story_wood_house'))
  for (const method of methods) assert.strictEqual(typeof executor[method], 'function', method)
}

function testExecutorSourceDoesNotDependOnBuildingSystem() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'systems', 'construction-executor.js'), 'utf8')
  assert.ok(!/require\(['"].*building-system['"]\)/.test(source))
  assert.ok(!/options\.system|this\.system/.test(source))
}

function testBedPairRequiresSingleBedItem() {
  const blueprint = validatedLegacyIR({
    name: 'bed_pair_material_fixture',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks', phase: 'floor' },
      { x: 0, y: 0, z: 1, type: 'oak_planks', phase: 'floor' },
      { x: 0, y: 1, z: 0, type: 'white_bed', phase: 'functional_blocks', role: 'bed', states: { facing: 'south', part: 'foot' } },
      { x: 0, y: 1, z: 1, type: 'white_bed', phase: 'functional_blocks', role: 'bed', states: { facing: 'south', part: 'head' } }
    ]
  })
  const compiler = new ConstructionCompiler()
  const result = compiler.compile({
    blueprint,
    placementContext: { origin: { x: 0, y: 64, z: 0 } },
    siteSnapshot: { blocks: [], inventoryCounts: { oak_planks: 10, white_bed: 1, dirt: 10 } },
    inventoryPolicy: { counts: { oak_planks: 10, white_bed: 1, dirt: 10 } },
    compilerOptions: { skipScaffolding: true }
  })
  assert.strictEqual(result.ok, true, JSON.stringify(result.diagnostics))
  // One bed item creates both halves: the head block must not double-count.
  assert.strictEqual(result.plan.materials.formalRequired.white_bed, 1)
  assert.deepStrictEqual(result.plan.materials.missing, [])
}

function testDoorPairAndWallTorchUsePlaceableItemRequirements() {
  const blueprint = validatedLegacyIR({
    name: 'door_and_wall_torch_material_fixture',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks', phase: 'floor' },
      { x: 1, y: 0, z: 0, type: 'oak_planks', phase: 'floor' },
      { x: 1, y: 1, z: 0, type: 'oak_planks', phase: 'wall' },
      { x: 0, y: 1, z: 0, type: 'oak_door', phase: 'doors_windows', states: { facing: 'south', half: 'lower', hinge: 'left', open: 'false', powered: 'false' } },
      { x: 0, y: 2, z: 0, type: 'oak_door', phase: 'doors_windows', states: { facing: 'south', half: 'upper', hinge: 'left', open: 'false', powered: 'false' } },
      { x: 0, y: 1, z: 1, type: 'wall_torch', phase: 'functional_blocks', states: { facing: 'east' } }
    ]
  })
  const compiler = new ConstructionCompiler()
  const inventory = { oak_planks: 3, oak_door: 1, torch: 1, dirt: 10 }
  const result = compiler.compile({
    blueprint,
    placementContext: { origin: { x: 0, y: 64, z: 0 } },
    siteSnapshot: { blocks: [], inventoryCounts: inventory },
    inventoryPolicy: { counts: inventory },
    compilerOptions: { skipScaffolding: true }
  })
  assert.strictEqual(result.ok, true, JSON.stringify(result.diagnostics))
  assert.strictEqual(result.plan.materials.formalRequired.oak_door, 1)
  assert.strictEqual(result.plan.materials.formalRequired.torch, 1)
  assert.strictEqual(result.plan.materials.formalRequired.wall_torch, undefined)
  assert.deepStrictEqual(result.plan.materials.missing, [])
}

function testCompilerOrdersAttachedBlockAfterItsExplicitSupportDependency() {
  const blueprint = validatedLegacyIR({
    name: 'attached_support_dependency_fixture',
    origin: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, type: 'oak_planks', phase: 'floor' },
      { x: 1, y: 0, z: 0, type: 'oak_planks', phase: 'floor' },
      { x: 0, y: 1, z: 0, type: 'ladder', phase: 'stairs', states: { facing: 'west' } },
      { x: 1, y: 1, z: 0, type: 'oak_log', phase: 'frame', role: 'column', states: { axis: 'y' } }
    ]
  })
  const inventory = { oak_planks: 2, ladder: 1, oak_log: 1, dirt: 10 }
  const result = new ConstructionCompiler().compile({
    blueprint,
    placementContext: { origin: { x: 0, y: 64, z: 0 } },
    siteSnapshot: { blocks: [], inventoryCounts: inventory },
    inventoryPolicy: { counts: inventory },
    compilerOptions: { skipScaffolding: true }
  })
  assert.strictEqual(result.ok, true, JSON.stringify(result.diagnostics))
  const ladderIndex = result.plan.steps.findIndex(step => step.block?.id === 'ladder')
  const supportIndex = result.plan.steps.findIndex(step => step.block?.id === 'oak_log')
  assert.ok(supportIndex >= 0 && ladderIndex >= 0)
  assert.ok(supportIndex < ladderIndex, `support=${supportIndex} ladder=${ladderIndex}`)
  assert.deepStrictEqual(result.plan.steps[ladderIndex].dependencies, [result.plan.steps[supportIndex].id])
  assert.strictEqual(result.legacy.orderPlan.steps[supportIndex].id, result.plan.steps[supportIndex].id)
  assert.strictEqual(result.legacy.orderPlan.steps[ladderIndex].id, result.plan.steps[ladderIndex].id)
}

function testPrinterExecutorIsOnlySkeleton() {
  const printer = new SchematicPrinterExecutor()
  assert.throws(() => printer.getProgress(), /NOT_IMPLEMENTED/)
}

function testCompilerSourceHasNoRuntimeBackendDependency() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'systems', 'construction-compiler.js'), 'utf8')
  assert.ok(!/mineflayer/i.test(source))
  assert.ok(!/ActionLock/.test(source))
  assert.ok(!/clearBlockForBuilding|placeBlock/.test(source))
  assert.ok(!/storageSystem|takeItems/.test(source))
}

function testCompilerAndExecutorDoNotSpecialCaseSimpleCabinName() {
  const compilerSource = fs.readFileSync(path.join(__dirname, '..', 'systems', 'construction-compiler.js'), 'utf8')
  const executorSource = fs.readFileSync(path.join(__dirname, '..', 'systems', 'construction-executor.js'), 'utf8')
  assert.ok(!/simple_two_story_cabin|simple_wood_cabin/.test(compilerSource))
  assert.ok(!/simple_two_story_cabin|simple_wood_cabin/.test(executorSource))
}

function run() {
  testCompilerIsDeterministic()
  testCompilerStepContract()
  testCompilerAnnotatesTerrainMaterialPolicy()
  testCompilerKeepsStructuralGrassExact()
  testWoodHouseAndFountainUseSameCompiler()
  testChangingBlueprintDoesNotChangeExecutorContract()
  testExecutorSourceDoesNotDependOnBuildingSystem()
  testPrinterExecutorIsOnlySkeleton()
  testCompilerSourceHasNoRuntimeBackendDependency()
  testCompilerAndExecutorDoNotSpecialCaseSimpleCabinName()
  testBedPairRequiresSingleBedItem()
  testDoorPairAndWallTorchUsePlaceableItemRequirements()
  testCompilerOrdersAttachedBlockAfterItsExplicitSupportDependency()
  console.log('construction compiler tests passed')
}

run()
