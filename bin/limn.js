#!/usr/bin/env node
// Node-version gate before anything that touches node:sqlite is imported.
const [maj, min] = process.versions.node.split('.').map(Number)
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`Limn needs Node >= 22.5 (found ${process.versions.node}). Install a newer Node and re-run.`)
  process.exit(1)
}
import('../dist/cli/index.js').catch((err) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1) })
