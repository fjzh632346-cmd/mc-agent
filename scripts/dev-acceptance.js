const { spawn } = require('child_process')

const children = [
  spawn(process.execPath, ['bot.js'], { stdio: 'inherit', shell: false }),
  spawn(process.execPath, ['scripts/watch-acceptance.js'], { stdio: 'inherit', shell: false })
]

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGINT')
  }
}

for (const child of children) {
  child.on('exit', code => {
    if (code && code !== 0) process.exitCode = code
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
