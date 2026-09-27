// Node on Windows terminates a child for child.kill('SIGTERM') instead of
// delivering the signal to its handler. Emit it inside the child so the CLI's
// normal quiescent shutdown path remains the behavior under test.
const originalLog = console.log
console.log = (...args) => {
  originalLog(...args)
  if (typeof args[0] === 'string' && args[0].startsWith('hydra web: ')) {
    setTimeout(() => process.emit('SIGTERM'), 0)
  }
}
