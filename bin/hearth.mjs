#!/usr/bin/env node
// Hearth CLI launcher. Sources are TypeScript run directly through Node's
// built-in type stripping (Node >= 24), so there is no build step.
const [major] = process.versions.node.split('.').map(Number)
if (major < 24) {
  process.stderr.write(`Hearth needs Node.js >= 24.9 (found ${process.versions.node}).\n`)
  process.exit(2)
}
// A closed pipe (e.g. `hearth tasks | head`) is a normal end of output, not a crash.
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})
const { run } = await import('../src/cli/main.ts')
await run(process.argv.slice(2))
