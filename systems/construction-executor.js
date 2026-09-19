class ConstructionExecutor {
  async executePlan() {
    throw notImplemented('executePlan')
  }

  async executeStep() {
    throw notImplemented('executeStep')
  }

  pause() {
    throw notImplemented('pause')
  }

  resume() {
    throw notImplemented('resume')
  }

  cancel() {
    throw notImplemented('cancel')
  }

  getProgress() {
    throw notImplemented('getProgress')
  }
}

class MineflayerConstructionExecutor extends ConstructionExecutor {
  constructor(options = {}) {
    super()
    this.executeStepAdapter = typeof options.executeStep === 'function' ? options.executeStep : null
    this.executePlanAdapter = typeof options.executePlan === 'function' ? options.executePlan : null
    this.getProgressAdapter = typeof options.getProgress === 'function' ? options.getProgress : null
    this.setStatusAdapter = typeof options.setStatus === 'function' ? options.setStatus : null
  }

  async executePlan(context, plan, options = {}) {
    if (this.executePlanAdapter) {
      return this.executePlanAdapter(context, plan, options)
    }
    return { ok: false, error: 'execute_plan_requires_orchestrator' }
  }

  async executeStep(context, step, options = {}) {
    if (!this.executeStepAdapter) {
      return { ok: false, error: 'execute_step_adapter_unavailable' }
    }
    return this.executeStepAdapter(context, step, options)
  }

  pause(reason = 'executor_pause') {
    this.setStatusAdapter?.('PAUSED', reason)
    return { ok: true, status: 'PAUSED', reason }
  }

  resume() {
    this.setStatusAdapter?.('RUNNING')
    return { ok: true, status: 'RUNNING' }
  }

  cancel(reason = 'executor_cancel') {
    this.setStatusAdapter?.('CANCELLED', reason)
    return { ok: true, status: 'CANCELLED', reason }
  }

  getProgress() {
    return this.getProgressAdapter?.() || null
  }
}

class SchematicPrinterExecutor extends ConstructionExecutor {
  async executePlan() {
    throw notImplemented('SchematicPrinterExecutor.executePlan')
  }

  async executeStep() {
    throw notImplemented('SchematicPrinterExecutor.executeStep')
  }

  pause() {
    throw notImplemented('SchematicPrinterExecutor.pause')
  }

  resume() {
    throw notImplemented('SchematicPrinterExecutor.resume')
  }

  cancel() {
    throw notImplemented('SchematicPrinterExecutor.cancel')
  }

  getProgress() {
    throw notImplemented('SchematicPrinterExecutor.getProgress')
  }
}

function notImplemented(method) {
  const err = new Error(`NOT_IMPLEMENTED:${method}`)
  err.code = 'NOT_IMPLEMENTED'
  return err
}

module.exports = {
  ConstructionExecutor,
  MineflayerConstructionExecutor,
  SchematicPrinterExecutor
}
