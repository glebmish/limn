import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import type { CliCommand } from '../args.js'
import type { Io } from '../main.js'
import { probeHealth } from '../health.js'
import { resolvePort } from '../serve.js'
import { APP_VERSION } from '../../server/http.js'
import { defaultDbPath, logPath } from '../../main/paths.js'
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

/** launchd/systemd start the service with a bare PATH; engines need git/claude/codex. */
function loginShellPath(): string {
  try {
    return execSync(`${process.env.SHELL || '/bin/sh'} -ilc 'echo -n "$PATH"'`, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      || process.env.PATH || ''
  } catch { return process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }
}

export function unitSpec(port80: boolean): UnitSpec {
  // realpath both so an nvm/Homebrew node and the global node_modules are recorded as
  // real files (symlink targets change on upgrade; the unit must keep working).
  const nodePath = fs.realpathSync(process.execPath)
  const entryPath = fs.realpathSync(path.join(import.meta.dirname, '..', 'index.js'))
  const pathEnv = [path.dirname(nodePath), ...loginShellPath().split(path.delimiter)].filter((p, i, a) => p && a.indexOf(p) === i).join(path.delimiter)
  const extraEnv: Record<string, string> = {}
  for (const k of FORWARDED_ENV) { const v = process.env[k]; if (v) extraEnv[k] = v }
  return { nodePath, entryPath, port80, pathEnv, logFile: logPath(), home: os.homedir(), extraEnv }
}

async function waitHealthy(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await probeHealth(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** Write the unit, load it, and wait for the service to answer /health. */
export async function installService(opts: { port80: boolean }, io: Io): Promise<number> {
  const b = serviceBackend()
  if (!b) { io.err('error: background service is not supported on this platform yet; run `limn service serve` instead'); return 2 }
  const port = resolvePort()
  const fg = await probeHealth(port)
  // A foreground `limn service serve` holds the port; the unit would crash-loop on EADDRINUSE.
  if (fg && !(await isServiceInstalled())) { io.err(`error: a foreground Limn server (pid ${fg.pid}) holds port ${port}; stop it (Ctrl-C) and re-run`); return 1 }
  const spec = unitSpec(opts.port80)
  try { await b.install(spec, execAsync) } catch (err) { io.err(`error: ${err instanceof Error ? err.message : String(err)}`); return 1 }
  if (!(await waitHealthy(port, 10_000))) { io.err(`service installed but not answering on ${port} after 10s — see ${spec.logFile}`); return 1 }
  const a = await b.activation(execAsync)
  io.out(`✓ Limn service installed and running → http://limn.localhost:${port}${opts.port80 ? '  (also http://limn.localhost)' : ''}`)
  io.out(`  unit:     ${b.unitPath()}`)
  if (a.loaded) io.out(`  restart after an upgrade:  ${a.restartCmd}`)
  return 0
}

async function statusModel(): Promise<StatusModel> {
  const b = serviceBackend()
  const port = resolvePort()
  const health = await probeHealth(port)
  const activation = b ? await b.activation(execAsync) : null
  return { version: APP_VERSION, port, health, activation, unsupported: !b, dbPath: defaultDbPath(), logFile: logPath(), foregroundPid: health?.pid ?? null }
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
      await b.uninstall(execAsync)
      io.out(`✓ removed ${b.unitPath()} (database kept at ${defaultDbPath()})`)
      return 0
    }
    case 'service-status': {
      const { lines, exitCode } = renderStatus(await statusModel())
      for (const l of lines) io.out(l)
      return exitCode
    }
    case 'service-logs': {
      // systemd captures stdout in the journal even with StandardOutput=append:, and
      // journalctl is what a Linux user expects; launchd writes the plain log file.
      if (b?.name === 'systemd') return pipeThrough('journalctl', ['--user', '-u', 'limn', ...(cmd.follow ? ['-f'] : ['-n', '200'])])
      const file = logPath()
      if (!fs.existsSync(file)) { io.out(`no log yet at ${file}`); return 0 }
      return pipeThrough('tail', cmd.follow ? ['-f', file] : ['-n', '200', file])
    }
    default: io.err(`limn: unhandled command ${cmd.kind}`); return 2
  }
}
