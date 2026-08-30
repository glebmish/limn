import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { CliCommand } from './args.js'
import type { HealthInfo } from './health.js'
import { probeHealth } from './health.js'
import { openBrowser } from './browser.js'
import { resolvePort, runServe } from './serve.js'
import { readCliState, writeCliState } from './state.js'
import { findOldShim } from './shim.js'
import { isServiceInstalled, installService } from './service/index.js'
import { issueCliOpen, type CliOpenArgs } from '../main/cliOpen.js'
import type { Io } from './main.js'

export type OpenCommand = Extract<CliCommand, { kind: 'open' }>
export type OpenRole = { role: 'client' } | { role: 'server'; offerService: boolean }

export function decideOpen(i: { health: HealthInfo | null; noService: boolean; isTTY: boolean; serviceInstalled: boolean; declinedBefore: boolean }): OpenRole {
  if (i.health) return { role: 'client' }
  return { role: 'server', offerService: i.isTTY && !i.noService && !i.serviceInstalled && !i.declinedBefore }
}

/** `npx @glebmish/limn` unpacks into a throwaway `_npx` cache — the path is not stable
 *  enough for a service unit, so that first run offers a global install too. */
export function isNpxInvocation(entryPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(entryPath)
}

function toArgs(cmd: OpenCommand): CliOpenArgs {
  return { dir: cmd.dir, base: cmd.base, compare: cmd.compare, hub: cmd.hub, fresh: cmd.fresh }
}

async function issueRemote(port: number, args: CliOpenArgs): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc/cli:open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([args])
  })
  const body = (await res.json()) as { value?: { ticket: string }; error?: string }
  if (!res.ok || !body.value) throw new Error(body.error || `cli:open failed (${res.status})`)
  return body.value.ticket
}

function pageUrl(port: number, ticket: string): string {
  return `http://limn.localhost:${port}/?open=${ticket}`
}

/** Ask a running server for a ticket and open the page. Exit code, never a stack trace. */
async function openViaServer(port: number, cmd: OpenCommand, io: Io): Promise<number> {
  let ticket: string
  try {
    ticket = await issueRemote(port, toArgs(cmd))
  } catch (err) {
    io.err(`error: could not reach the Limn server on port ${port}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const url = pageUrl(port, ticket)
  io.out(`opening ${url}`)
  openBrowser(url)
  return 0
}

async function offerShimRemoval(io: Io): Promise<void> {
  const shim = findOldShim()
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

/** Install the service the first time someone runs `limn` with no server up. 0 on success. */
async function installFromPrompt(port: number, io: Io): Promise<number> {
  if (!isNpxInvocation(process.argv[1] ?? '')) return installService({ port80: false }, io)
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
export async function runOpen(cmd: OpenCommand, io: Io): Promise<number> {
  const port = resolvePort()
  await offerShimRemoval(io)
  const health = await probeHealth(port)
  const decision = decideOpen({
    health,
    noService: cmd.noService,
    isTTY: io.isTTY,
    serviceInstalled: await isServiceInstalled(),
    declinedBefore: Boolean(readCliState().servicePromptDeclined)
  })

  if (decision.role === 'client') return openViaServer(port, cmd, io)

  if (decision.offerService) {
    const question = isNpxInvocation(process.argv[1] ?? '')
      ? `Install Limn globally (npm i -g @glebmish/limn) and as a background service so http://limn.localhost:${port} is always available?`
      : `Install Limn as a background service so http://limn.localhost:${port} is always available? (LaunchAgent in ~/Library/LaunchAgents)`
    if (await io.ask(question)) {
      const code = await installFromPrompt(port, io)
      if (code !== 0) return code
      return openViaServer(port, cmd, io)
    }
    writeCliState({ servicePromptDeclined: true })
    io.out('ok — running in the foreground (Ctrl-C to stop). Re-offer any time with `limn service install`.')
  }

  // Server role: run the server in this process and open the browser once it is up.
  // The ticket is issued in-process — no HTTP round trip to ourselves.
  return runServe({ port80: false }, io, (server) => {
    void issueCliOpen(toArgs(cmd)).then(({ ticket }) => {
      const url = pageUrl(server.port, ticket)
      io.out(`opening ${url}`)
      openBrowser(url)
    }, (err: unknown) => {
      io.err(`error: could not open the review: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
}
