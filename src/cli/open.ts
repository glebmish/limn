import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { CliCommand } from './args.js'
import type { HealthInfo } from './health.js'
import { probeHealth } from './health.js'
import { openBrowser } from './browser.js'
import { runServe } from './serve.js'
import { serviceTarget, type ServiceTarget } from './target.js'
import { readCliState, writeCliState, type CliState } from './state.js'
import { findOldShim } from './shim.js'
import { isServiceInstalled, installService, serviceBackend } from './service/index.js'
import { issueCliOpen, type CliOpenArgs } from '../server/cliOpen.js'
import { hostForUrl } from '../server/guard.js'
import type { RunningServer } from '../server/http.js'
import type { Io } from './main.js'

export type OpenCommand = Extract<CliCommand, { kind: 'open' }>
export type OpenRole = { role: 'client' } | { role: 'server'; offerService: boolean }

export function decideOpen(i: { health: HealthInfo | null; noService: boolean; isTTY: boolean; serviceInstalled: boolean; declinedBefore: boolean; serviceSupported: boolean }): OpenRole {
  if (i.health) return { role: 'client' }
  // serviceSupported: on Windows `service install` only ever prints "not supported yet"
  // and exits 2, so offering it is a dead end — go straight to the foreground server.
  return { role: 'server', offerService: i.serviceSupported && i.isTTY && !i.noService && !i.serviceInstalled && !i.declinedBefore }
}

/** `npx @glebmish/limn` unpacks into a throwaway `_npx` cache — the path is not stable
 *  enough for a service unit, so that first run offers a global install too. */
export function isNpxInvocation(entryPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(entryPath)
}

function toArgs(cmd: OpenCommand): CliOpenArgs {
  return { dir: cmd.dir, base: cmd.base, compare: cmd.compare, hub: cmd.hub, fresh: cmd.fresh }
}

/** POST cli:open to a running service and return the one-time page ticket. */
export async function issueRemote(t: ServiceTarget, args: CliOpenArgs): Promise<string> {
  const res = await fetch(`http://${hostForUrl(t.host)}:${t.port}/rpc/cli:open`, {
    method: 'POST',
    // the header form, not ?token= — a token in a URL lands in logs and shell history
    headers: { 'Content-Type': 'application/json', ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}) },
    body: JSON.stringify([args])
  })
  const fallback = `cli:open failed (${res.status})`
  // Status first: an error page (a proxy's HTML, say) must not blow up in JSON.parse.
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || fallback)
  }
  const body = (await res.json()) as { value?: { ticket: string } }
  if (!body.value) throw new Error(fallback)
  return body.value.ticket
}

/** Everything `runOpen` reaches outside its own process, injectable for tests. */
export interface OpenDeps {
  target: () => ServiceTarget
  /** null on a platform with no background-service backend (Windows) */
  backend: () => 'launchd' | 'systemd' | null
  probe: (port: number, host: string) => Promise<HealthInfo | null>
  issueRemote: (target: ServiceTarget, args: CliOpenArgs) => Promise<string>
  install: (opts: { port80: boolean }, io: Io) => Promise<number>
  installed: () => Promise<boolean>
  openBrowser: (url: string) => void
  readState: () => CliState
  writeState: (patch: Partial<CliState>) => void
  npx: () => boolean
  serve: (cmd: { port?: number; port80: boolean }, io: Io, onReady?: (s: RunningServer) => void) => Promise<number>
  findShim: () => string | null
}

export const defaultOpenDeps: OpenDeps = {
  target: serviceTarget,
  backend: () => serviceBackend()?.name ?? null,
  probe: probeHealth,
  issueRemote,
  install: installService,
  installed: isServiceInstalled,
  openBrowser,
  readState: readCliState,
  writeState: writeCliState,
  npx: () => isNpxInvocation(process.argv[1] ?? ''),
  serve: runServe,
  findShim: findOldShim
}

/** The page to open: the ticket, plus the token when there is a perimeter — the tab
 *  stashes it in sessionStorage, and without it every RPC it makes would 401. */
function pageUrl(base: string, ticket: string, token: string): string {
  return `${base}/?open=${ticket}${token ? `&token=${encodeURIComponent(token)}` : ''}`
}

/** Ask a running server for a ticket and open the page. Exit code, never a stack trace. */
async function openViaServer(t: ServiceTarget, cmd: OpenCommand, io: Io, deps: OpenDeps): Promise<number> {
  let ticket: string
  try {
    ticket = await deps.issueRemote(t, toArgs(cmd))
  } catch (err) {
    io.err(`error: could not reach the Limn server on ${t.host}:${t.port}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const url = pageUrl(t.url, ticket, t.token)
  io.out(`opening ${url}`)
  deps.openBrowser(url)
  return 0
}

async function offerShimRemoval(io: Io, deps: OpenDeps): Promise<void> {
  const shim = deps.findShim()
  if (!shim) return
  if (await io.ask(`Found the old desktop-app shim at ${shim}; it conflicts with this command. Delete it?`)) {
    try {
      fs.rmSync(shim, { force: true })
      io.out(`removed ${shim}`)
    } catch (err) {
      io.err(`could not remove ${shim}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The service prompt, in the words of the backend that would actually be used. */
export function serviceQuestion(i: { url: string; npx: boolean; backend: 'launchd' | 'systemd' }): string {
  const where = i.backend === 'launchd'
    ? 'a LaunchAgent in ~/Library/LaunchAgents'
    : 'a systemd --user unit in ~/.config/systemd/user'
  return i.npx
    ? `Install Limn globally (npm i -g @glebmish/limn) and as a background service (${where}) so ${i.url} is always available?`
    : `Install Limn as a background service (${where}) so ${i.url} is always available?`
}

/** Install the service the first time someone runs `limn` with no server up. 0 on success. */
async function installFromPrompt(port: number, io: Io, deps: OpenDeps): Promise<number> {
  if (!deps.npx()) return deps.install({ port80: false }, io)
  io.out('installing @glebmish/limn globally…')
  try {
    execFileSync('npm', ['i', '-g', '@glebmish/limn'], { stdio: 'inherit' })
  } catch {
    io.err('npm i -g failed; run it manually, then `limn service install`')
    return 1
  }
  // Hand off to the freshly installed global binary so the unit records its stable path
  // rather than this run's `_npx` cache directory.
  try {
    execFileSync('limn', ['service', 'install'], { stdio: 'inherit' })
  } catch {
    io.err(`could not run \`limn service install\` — make sure the npm global bin is on your PATH, then re-run it (port ${port})`)
    return 1
  }
  return 0
}

/** Review a directory: hand it to a running service, or start one. */
export async function runOpen(cmd: OpenCommand, io: Io, deps: OpenDeps = defaultOpenDeps): Promise<number> {
  const target = deps.target()
  await offerShimRemoval(io, deps)
  const health = await deps.probe(target.port, target.host)
  const backend = deps.backend()
  const decision = decideOpen({
    health,
    noService: cmd.noService,
    isTTY: io.isTTY,
    serviceInstalled: await deps.installed(),
    declinedBefore: Boolean(deps.readState().servicePromptDeclined),
    serviceSupported: backend != null
  })

  if (decision.role === 'client') return openViaServer(target, cmd, io, deps)

  if (decision.offerService) {
    const question = serviceQuestion({ url: target.url, npx: deps.npx(), backend: backend! })
    if (await io.ask(question)) {
      const code = await installFromPrompt(target.port, io, deps)
      // The install already printed why it failed. Don't strand the user at a dead end:
      // they asked to review a directory, so fall through to the foreground server.
      if (code === 0) return openViaServer(target, cmd, io, deps)
      io.err('continuing in the foreground (Ctrl-C to stop); retry with `limn service install`.')
    } else {
      deps.writeState({ servicePromptDeclined: true })
      io.out('ok — running in the foreground (Ctrl-C to stop). Re-offer any time with `limn service install`.')
    }
  }

  // Server role: run the server in this process and open the browser once it is up.
  // The ticket is issued in-process — no HTTP round trip to ourselves.
  return deps.serve({ port80: false }, io, (server) => {
    void issueCliOpen(toArgs(cmd)).then(({ ticket }) => {
      const url = pageUrl(server.url, ticket, target.token)
      io.out(`opening ${url}`)
      deps.openBrowser(url)
    }, (err: unknown) => {
      io.err(`error: could not open the review: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
}
