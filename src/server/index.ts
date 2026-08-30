import { execSync } from 'node:child_process'
import { startServer, DEFAULT_PORT } from './http.js'
import { defaultDbPath } from '../main/paths.js'

// GUI/non-login launches don't inherit the shell PATH; engines need git/claude/codex
// from it. A terminal launch already has it — this is a best-effort top-up.
function bootstrapPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const p = execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 5000 }).toString()
    if (p) process.env.PATH = p
  } catch { /* keep default PATH */ }
}

bootstrapPath()
startServer({
  port: Number(process.env.LIMN_PORT || DEFAULT_PORT),
  host: process.env.LIMN_WEB_HOST,
  token: process.env.LIMN_WEB_TOKEN,
  staticRoot: process.env.LIMN_WEB_STATIC,
  dbPath: defaultDbPath()
}).catch((err: unknown) => {
  console.error(`[limn] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
