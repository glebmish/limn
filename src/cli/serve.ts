import net from 'node:net'
import { startServer, type RunningServer, type ServerOptions } from '../server/http.js'
import { defaultDbPath } from '../server/paths.js'
import { probeHealth } from './health.js'
import { resolvePort, serviceTarget } from './target.js'
import { loginShellPath } from './service/index.js'
import type { Io } from './main.js'

/** GUI/launchd launches don't inherit the login-shell PATH; engines need git/claude/codex. */
export function bootstrapPath(): void {
  // Sentinel-bracketed and validated, so rc-file chatter on stdout (nvm's "Now using
  // node …") can't fuse onto the first segment; falls back to the current PATH.
  process.env.PATH = loginShellPath()
}

export async function classifyBusyPort(port: number): Promise<'limn' | 'other' | 'unavailable' | 'free'> {
  // Ask about the address we are actually going to bind, not a hardcoded loopback:
  // under LIMN_WEB_HOST the service lives somewhere else entirely.
  const { host } = serviceTarget(port)
  if (await probeHealth(port, host)) return 'limn'
  const state = await new Promise<'free' | 'other' | 'unavailable'>((resolve) => {
    const s = net.createServer()
    // EADDRNOTAVAIL is "this machine doesn't have that address" (a downed tailnet, a
    // typo'd LIMN_WEB_HOST) — nothing to do with the port being taken.
    s.once('error', (err) => resolve((err as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL' ? 'unavailable' : 'other'))
    s.listen(port, host, () => s.close(() => resolve('free')))
  })
  return state
}

/** One message per bind-failure shape, shared by the pre-check and the raw startServer
 *  error (the pre-check can lose the race for the port — TOCTOU). */
export function startFailureMessage(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EADDRINUSE') return `port ${port} is in use by another program; try --port N`
  if (code === 'EADDRNOTAVAIL') return addressUnavailableMessage()
  return err instanceof Error ? err.message : String(err)
}

function addressUnavailableMessage(): string {
  const { host } = serviceTarget()
  return `cannot bind ${host} — the address is not assigned on this machine (check LIMN_WEB_HOST, or your tailnet)`
}

export function serverOptions(port: number, port80: boolean): ServerOptions {
  return {
    port,
    host: process.env.LIMN_WEB_HOST,
    token: process.env.LIMN_WEB_TOKEN,
    staticRoot: process.env.LIMN_WEB_STATIC,
    // Dev/screenshot hooks (?dev=…) run agent prompts and file edits: opt-in per
    // server process, never per link. scripts/shot.sh & friends set it.
    devHooks: process.env.LIMN_DEV_HOOKS === '1',
    dbPath: defaultDbPath(),
    vanityPort80: port80
  }
}

/** Foreground server. Resolves with an exit code only on failure; on success it
 *  runs until SIGINT/SIGTERM. `onReady` lets `open` reuse this for the server role. */
export async function runServe(cmd: { port?: number; port80: boolean }, io: Io, onReady?: (s: RunningServer) => void): Promise<number> {
  // LIMN_WEB_HOST / LIMN_WEB_TOKEN exist, so LIMN_WEB_PORT is a plausible guess that
  // silently does nothing; say so once. (Plain PORT is too common in shells to nag about.)
  if (process.env.LIMN_WEB_PORT && !process.env.LIMN_PORT) io.err('warning: LIMN_WEB_PORT is not read; set LIMN_PORT (or pass --port)')
  const port = resolvePort(cmd.port)
  // Port 0 is "pick an ephemeral one" — nothing to check, and probing it is meaningless.
  if (port !== 0) {
    const state = await classifyBusyPort(port)
    if (state === 'limn') { io.err(`error: a Limn service is already running on ${port} (limn service status)`); return 1 }
    if (state === 'other') { io.err(`error: ${startFailureMessage({ code: 'EADDRINUSE' }, port)}`); return 1 }
    if (state === 'unavailable') { io.err(`error: ${addressUnavailableMessage()}`); return 1 }
  }
  bootstrapPath()
  let server: RunningServer
  try {
    server = await startServer({ ...serverOptions(port, cmd.port80), log: (l) => io.out(l) })
  } catch (err) {
    io.err(`error: ${startFailureMessage(err, port)}`)
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
