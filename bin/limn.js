#!/usr/bin/env node
// Node-version gate before anything that touches node:sqlite is imported.
const [maj, min] = process.versions.node.split('.').map(Number)
// node:sqlite loads without --experimental-sqlite from 22.13 / 23.4.
if (maj < 22 || (maj === 22 && min < 13) || (maj === 23 && min < 4)) {
  console.error(`Limn needs Node >= 22.13 (found ${process.versions.node}). Install a newer Node and re-run.`)
  process.exit(1)
}
import('../dist/cli/index.js').catch((err) => {
  // The one failure a user can act on without a stack trace: bin/ exists but dist/
  // was never built (a source checkout) or is gone (a broken install).
  if (err && err.code === 'ERR_MODULE_NOT_FOUND' && /dist[\\/]cli[\\/]index\.js/.test(String(err.message))) {
    console.error('Limn: dist/ is missing next to bin/. In a source checkout run `npm run build`; for an installed package, reinstall it (npm i -g @glebmish/limn).')
    process.exit(1)
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
