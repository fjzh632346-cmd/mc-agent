const assert = require('assert')

function requireBotWithoutPersonaEnv() {
  const originalPersona = process.env.PERSONA
  delete process.env.PERSONA
  const botModulePath = require.resolve('../bot')
  delete require.cache[botModulePath]
  const loaded = require('../bot')
  if (originalPersona === undefined) delete process.env.PERSONA
  else process.env.PERSONA = originalPersona
  return loaded
}

function testDefaultPersonaIsAndy() {
  const bot = requireBotWithoutPersonaEnv()

  assert.strictEqual(bot.DEFAULT_PERSONA_ID, 'andy')
  assert.strictEqual(bot.DEFAULT_PERSONA.name, '安迪')
  assert.strictEqual(bot.DEFAULT_PERSONA.username, 'Andy')
  assert.strictEqual(bot.activePersona.name, '安迪')
  assert.strictEqual(bot.activePersona.username, 'Andy')
  assert.notStrictEqual(bot.activePersona.username, 'LinXia')
}

function run() {
  testDefaultPersonaIsAndy()
  console.log('default persona tests passed')
}

run()
