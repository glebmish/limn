import net from 'node:net'
import { execSync } from 'node:child_process'
import { startServer, DEFAULT_PORT, type RunningServer, type ServerOptions } from '../server/http.js'
import { defaultDbPath } from '../main/paths.js'
import { probeHealth } from './health.js'
import type { Io } from './main.js'

/** GUI/launchd launches don't inherit the login-shell PATH; engines need git/claude/codex. */
export function bootstrapPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // stderr is dropped: an interactive rc file's chatter isn't ours to print.
    const p = execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    if (p) process.env.PATH = p
  } catch { /* keep default PATH */ }
}

export function resolvePort(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const env = Number(process.env.LIMN_PORT)
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_PORT
}

export async function classifyBusyPort(port: number): Promise<'limn' | 'other' | 'free'> {
  if (await probeHealth(port)) return 'limn'
  const free = await new Promise<boolean>((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
  return free ? 'free' : 'other'
}

export function serverOptions(port: number, port80: boolean): ServerOptions {
  return {
    port,
    host: process.env.LIMN_WEB_HOST,
    token: process.env.LIMN_WEB_TOKEN,
    staticRoot: process.env.LIMN_WEB_STATIC,
    dbPath: defaultDbPath(),
    vanityPort80: port80
  }
}

/** Foreground server. Resolves with an exit code only on failure; on success it
 *  runs until SIGINT/SIGTERM. `onReady` lets `open` reuse this for the server role. */
export async function runServe(cmd: { port?: number; port80: boolean }, io: Io, onReady?: (s: RunningServer) => void): Promise<number> {
  const port = resolvePort(cmd.port)
  // Port 0 is "pick an ephemeral one" — nothing to check, and probing it is meaningless.
  if (port !== 0) {
    const state = await classifyBusyPort(port)
    if (state === 'limn') { io.err(`error: a Limn service is already running on ${port} (limn service status)`); return 1 }
    if (state === 'other') { io.err(`error: port ${port} is in use by another program; try --port N`); return 1 }
  }
  bootstrapPath()
  let server: RunningServer
  try {
    server = await startServer({ ...serverOptions(port, cmd.port80), log: io.out })
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  onReady?.(server)
  await new Promise<void>((resolve) => {
    // Guarded: a SIGTERM chasing a SIGINT would otherwise close the SQLite handle twice.
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      // Drop the other listener too: a second signal during a slow close must reach
      // Node's default handler (kill the process) rather than be swallowed here.
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      io.out('[limn] shutting down')
      void server.close().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}
