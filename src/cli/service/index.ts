import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import type { CliCommand } from '../args.js'
import type { Io } from '../main.js'
import { probeHealth } from '../health.js'
import { serviceTarget, type ServiceTarget } from '../target.js'
import { APP_VERSION } from '../../server/http.js'
import { defaultDbPath, logPath } from '../../server/paths.js'
import { launchd } from './launchd.js'
import { systemd } from './systemd.js'
import { execAsync, type ServiceBackend, type UnitSpec } from './types.js'
import { renderStatus, type StatusModel } from './status.js'

/** Environment the installing shell can pin into the unit (an isolated port/db for a
 *  smoke run, or a Tailscale bind). Anything else the service reads from its own env. */
const FORWARDED_ENV = ['LIMN_PORT', 'LIMN_DB', 'LIMN_WEB_HOST', 'LIMN_WEB_TOKEN'] as const

export function serviceBackend(platform = process.platform): ServiceBackend | null {
  return platform === 'darwin' ? launchd : platform === 'linux' ? systemd : null
}

/** True when a launchd/systemd unit for Limn is on disk. */
export async function isServiceInstalled(): Promise<boolean> {
  const b = serviceBackend()
  return b ? fs.existsSync(b.unitPath()) : false
}

const PATH_START = '__LIMN_PATH_START__'
const PATH_END = '__LIMN_PATH_END__'

/** A sane PATH is a `path.delimiter`-joined list of absolute directories — login-shell
 *  startup chatter (nvm/oh-my-zsh/conda banners) fused onto the value would not. */
function looksLikePath(candidate: string): boolean {
  if (!candidate) return false
  const segments = candidate.split(path.delimiter).filter(Boolean)
  return segments.length > 0 && segments.every((s) => path.isAbsolute(s))
}

/** Extracts the PATH `loginShellPath` bracketed between sentinel markers, so any
 *  interactive-shell startup output that lands on stdout before them (nvm's "Now
 *  using node vX", conda/oh-my-zsh banners, …) can't fuse onto the value. Falls back
 *  to `fallback` when the markers are missing or the extracted text doesn't look like
 *  a real PATH. */
export function extractLoginPath(raw: string, fallback: string): string {
  const start = raw.indexOf(PATH_START)
  const end = raw.indexOf(PATH_END)
  if (start === -1 || end === -1 || end < start) return fallback
  const candidate = raw.slice(start + PATH_START.length, end).trim()
  return looksLikePath(candidate) ? candidate : fallback
}

/** launchd/systemd start the service with a bare PATH; engines need git/claude/codex. */
export function loginShellPath(): string {
  const fallback = process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
  try {
    const raw = execSync(
      `${process.env.SHELL || '/bin/sh'} -ilc 'echo ${PATH_START}; echo -n "$PATH"; echo; echo ${PATH_END}'`,
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return extractLoginPath(raw, fallback)
  } catch { return fallback }
}

/** The script the unit runs. `../index.js` next to this module covers both the
 *  installed package (dist/cli/service → dist/cli/index.js) and a source tree that
 *  has been built; under tsx there is no sibling .js, so fall back to the script
 *  this process was started with (bin/limn.js for a real install). */
function entryScript(): string {
  const sibling = path.join(import.meta.dirname, '..', 'index.js')
  if (fs.existsSync(sibling)) return fs.realpathSync(sibling)
  const argv1 = process.argv[1]
  if (argv1 && fs.existsSync(argv1) && fs.statSync(argv1).isFile()) {
    // A tsx dev run (`tsx src/cli/index.ts service install`) lands here; recording the
    // .ts would write a unit that plain node cannot start.
    if (/\.[cm]?tsx?$/.test(argv1)) throw new Error(`the entry script is TypeScript source (${argv1}); run \`npm run build\` and install from the built dist/ instead`)
    return fs.realpathSync(argv1)
  }
  throw new Error('cannot locate the limn entry script (run from an installed package or the built dist/)')
}

export function unitSpec(port80: boolean, opts: { loginPath?: string } = {}): UnitSpec {
  // realpath both so an nvm/Homebrew node and the global node_modules are recorded as
  // real files (symlink targets change on upgrade; the unit must keep working).
  const nodePath = fs.realpathSync(process.execPath)
  const entryPath = entryScript()
  const pathEnv = [path.dirname(nodePath), ...(opts.loginPath ?? loginShellPath()).split(path.delimiter)].filter((p, i, a) => p && a.indexOf(p) === i).join(path.delimiter)
  const extraEnv: Record<string, string> = {}
  for (const k of FORWARDED_ENV) { const v = process.env[k]; if (v) extraEnv[k] = v }
  return { nodePath, entryPath, port80, pathEnv, logFile: logPath(), home: os.homedir(), extraEnv }
}

async function waitHealthy(t: ServiceTarget, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  for (;;) {
    const left = until - Date.now()
    if (left <= 0) return false
    // t.host, not loopback: with LIMN_WEB_HOST set the unit binds only that address,
    // and a loopback probe would report a perfectly healthy service as dead. The probe
    // is capped at what is left so the deadline is the deadline.
    if (await probeHealth(t.port, t.host, Math.min(1500, left))) return true
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** Write the unit, load it, and wait for the service to answer /health. */
export async function installService(opts: { port80: boolean }, io: Io): Promise<number> {
  const b = serviceBackend()
  if (!b) { io.err('error: background service is not supported on this platform yet; run `limn service serve` instead'); return 2 }
  const t = serviceTarget()
  const fg = await probeHealth(t.port, t.host)
  // A foreground `limn service serve` holds the port; the unit would crash-loop on EADDRINUSE.
  if (fg && !(await isServiceInstalled())) { io.err(`error: a foreground Limn server (pid ${fg.pid}) holds port ${t.port}; stop it (Ctrl-C) and re-run`); return 1 }
  // unitSpec touches the filesystem (realpath, entry lookup): an ENOENT here is a
  // message the user can act on, not a stack trace.
  let spec: UnitSpec
  try {
    spec = unitSpec(opts.port80)
    await b.install(spec, execAsync)
  } catch (err) { io.err(`error: ${err instanceof Error ? err.message : String(err)}`); return 1 }
  if (!(await waitHealthy(t, 10_000))) { io.err(`service installed but not answering on ${t.host}:${t.port} after 10s — see ${spec.logFile}`); return 1 }
  const a = await b.activation(execAsync)
  io.out(`✓ Limn service installed and running → ${t.url}${opts.port80 ? ' (also http://limn.localhost)' : ''}`)
  io.out(`  unit:     ${b.unitPath()}`)
  if (a.loaded) io.out(`  restart after an upgrade:  ${a.restartCmd}`)
  return 0
}

async function statusModel(): Promise<StatusModel> {
  const b = serviceBackend()
  const t = serviceTarget()
  const health = await probeHealth(t.port, t.host)
  const activation = b ? await b.activation(execAsync) : null
  return { version: APP_VERSION, port: t.port, host: t.host, url: t.url, health, activation, manager: b?.name ?? null, unsupported: !b, dbPath: defaultDbPath(), logFile: logPath() }
}

function pipeThrough(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

/** install / uninstall / status / logs. */
export async function runServiceCommand(cmd: CliCommand, io: Io): Promise<number> {
  const b = serviceBackend()
  switch (cmd.kind) {
    case 'service-install': return installService({ port80: cmd.port80 }, io)
    case 'service-uninstall': {
      if (!b) { io.err('error: background service is not supported on this platform'); return 2 }
      if (!(await isServiceInstalled())) { io.out('no Limn service installed'); return 0 }
      try { await b.uninstall(execAsync) } catch (err) { io.err(`error: ${err instanceof Error ? err.message : String(err)}`); return 1 }
      io.out(`✓ removed ${b.unitPath()} (database kept at ${defaultDbPath()})`)
      return 0
    }
    case 'service-status': {
      const { lines, exitCode } = renderStatus(await statusModel())
      for (const l of lines) io.out(l)
      return exitCode
    }
    case 'service-logs': {
      if (!b) { io.err('error: background service is not supported on this platform; `limn service serve` logs to its own terminal'); return 2 }
      // systemd captures stdout in the journal even with StandardOutput=append:, and
      // journalctl is what a Linux user expects; launchd writes the plain log file.
      if (b.name === 'systemd') return pipeThrough('journalctl', ['--user', '-u', 'limn', ...(cmd.follow ? ['-f'] : ['-n', '200'])])
      const file = logPath()
      if (!fs.existsSync(file)) { io.out(`no log yet at ${file}`); return 0 }
      return pipeThrough('tail', cmd.follow ? ['-f', file] : ['-n', '200', file])
    }
    default: io.err(`limn: unhandled command ${cmd.kind}`); return 2
  }
}
