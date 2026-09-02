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
import { issueCliOpen, type CliOpenArgs, type CliOpenResult } from '../server/cliOpen.js'
import { rpc, RpcError } from './rpc.js'
import { tryOpenInCmux } from './cmux.js'
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
  return {
    dir: cmd.dir, base: cmd.base, compare: cmd.compare, hub: cmd.hub, fresh: cmd.fresh,
    generate: cmd.generate, agent: cmd.agent, printUrl: cmd.printUrl
  }
}

/** POST cli:open to a running service and return the full result — the one-time page
 *  ticket, plus (for a `--generate` open) the durable path and any note. */
export async function issueRemote(t: ServiceTarget, args: CliOpenArgs): Promise<CliOpenResult> {
  const { value, status } = await rpc<CliOpenResult>(t, 'cli:open', [args])
  if (!value?.ticket) throw new Error(`cli:open failed (${status})`)
  return value
}

/** Everything `runOpen` reaches outside its own process, injectable for tests. */
export interface OpenDeps {
  target: () => ServiceTarget
  /** null on a platform with no background-service backend (Windows) */
  backend: () => 'launchd' | 'systemd' | null
  probe: (port: number, host: string) => Promise<HealthInfo | null>
  issueRemote: (target: ServiceTarget, args: CliOpenArgs) => Promise<CliOpenResult>
  install: (opts: { port80: boolean }, io: Io) => Promise<number>
  installed: () => Promise<boolean>
  openBrowser: (url: string) => void
  readState: () => CliState
  writeState: (patch: Partial<CliState>) => void
  npx: () => boolean
  serve: (cmd: { port?: number; port80: boolean }, io: Io, onReady?: (s: RunningServer) => void) => Promise<number>
  findShim: () => string | null
  /** Open a URL in a cmux pane. null when cmux isn't available at all (no CMUX_SOCKET,
   *  or no `cmux` on PATH) — distinct from a tried-and-failed attempt. */
  openInCmux: (url: string) => { ok: true } | { ok: false; reason: string } | null
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
  findShim: findOldShim,
  openInCmux: tryOpenInCmux
}

/** Build a page URL: `base` plus a path (or `/?open=<ticket>`) plus `?token=`/`&token=`
 *  when there is a perimeter — the tab stashes it in sessionStorage, and without it
 *  every RPC it makes would 401. */
function pageUrl(base: string, pathAndQuery: string, token: string): string {
  if (!token) return `${base}${pathAndQuery}`
  const sep = pathAndQuery.includes('?') ? '&' : '?'
  return `${base}${pathAndQuery}${sep}token=${encodeURIComponent(token)}`
}

/** The URL a CliOpenResult resolves to: the durable `/review/<id>` path once
 *  `--generate` has somewhere worth pointing at, else the one-time ticket URL. */
function resultUrl(base: string, result: CliOpenResult, token: string): string {
  return pageUrl(base, result.path ?? `/?open=${result.ticket}`, token)
}

/** Turn a CliOpenResult into the actual "open a page" side effect — shared by the
 *  client role (issueRemote over HTTP) and the server role (issueCliOpen in-process).
 *  `--print-url` wins over cmux: it never launches anything, only prints the URL. */
function openResolved(result: CliOpenResult, target: ServiceTarget, cmd: OpenCommand, io: Io, deps: OpenDeps): void {
  const url = resultUrl(target.url, result, target.token)
  if (result.note) io.err(`note: ${result.note}`)
  if (cmd.printUrl) { io.out(url); return }
  const cmuxResult = deps.openInCmux(url)
  if (cmuxResult) {
    if (cmuxResult.ok) { io.out(`opened in cmux: ${url}`); return }
    io.err(`note: cmux pane failed (${cmuxResult.reason}) — opened in the browser`)
  }
  io.out(`opening ${url}`)
  deps.openBrowser(url)
}

/** Ask a running server for a ticket (or a --generate answer) and open the page.
 *  Exit code, never a stack trace. An `RpcError` is the server rejecting the request
 *  (bad ref, `--effort` with no model, merged session, …) — that message is already
 *  meant for the user, verbatim; anything else is the fetch itself failing, which
 *  means the server we just health-probed is no longer reachable. */
async function openViaServer(t: ServiceTarget, cmd: OpenCommand, io: Io, deps: OpenDeps): Promise<number> {
  let result: CliOpenResult
  try {
    result = await deps.issueRemote(t, toArgs(cmd))
  } catch (err) {
    if (err instanceof RpcError) {
      io.err(`limn: ${err.message}`)
    } else {
      io.err(`error: could not reach the Limn server on ${t.host}:${t.port}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return 1
  }
  openResolved(result, t, cmd, io, deps)
  return 0
}

async function offerShimRemoval(io: Io, deps: OpenDeps): Promise<void> {
  const shim = deps.findShim()
  if (!shim) return
  // defaultYes: false — this deletes a file the user may still want; a bare Enter keeps it.
  if (await io.ask(`Found the old desktop-app shim at ${shim}; it conflicts with this command. Delete it?`, { defaultYes: false })) {
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
async function installFromPrompt(port: number, io: Io, deps: OpenDeps, npx: boolean): Promise<number> {
  if (!npx) return deps.install({ port80: false }, io)
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

  // A Stop-hook (or any non-interactive caller) that reaches for --generate/--print-url
  // with no service running would otherwise fall through to a foreground server —
  // fine for a human at a terminal, but a hook process has no terminal to Ctrl-C out
  // of, so it would just hang. Fail fast instead: the recipe needs the service.
  if ((cmd.generate || cmd.printUrl) && !io.isTTY) {
    io.err('limn: no Limn service is running — run `limn service install`')
    return 1
  }

  if (decision.offerService && backend) {
    const npx = deps.npx()
    const question = serviceQuestion({ url: target.url, npx, backend })
    if (await io.ask(question)) {
      const code = await installFromPrompt(target.port, io, deps, npx)
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
  // The ticket/--generate answer is issued in-process — no HTTP round trip to ourselves.
  // A plain open's failure keeps the server serving (the user asked to review a
  // directory in a browser; the server is still useful for a retry). A --generate or
  // --print-url rejection is different: nothing was started for the caller to watch,
  // so the freshly-started server has no reason to stay up — stop it and fail the
  // whole `limn` invocation. `servePromise` alone won't reflect that in production
  // (it only resolves on SIGINT/SIGTERM), so a failFast race lets the close() side
  // effect decide the exit code without waiting on a signal.
  let failFast: ((code: number) => void) | null = null
  const failFastPromise = new Promise<number>((resolve) => { failFast = resolve })
  const servePromise = deps.serve({ port80: false }, io, (server) => {
    void issueCliOpen(toArgs(cmd)).then((result) => {
      openResolved(result, { ...target, url: server.url }, cmd, io, deps)
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (cmd.generate || cmd.printUrl) {
        io.err(`limn: ${message}`)
        void server.close().then(() => failFast?.(1))
      } else {
        io.err(`error: could not open the review: ${message}`)
      }
    })
  })
  return Promise.race([servePromise, failFastPromise])
}
