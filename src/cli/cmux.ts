import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Real PATH lookup for `hasExecutable`: split PATH on the platform delimiter, and on
 *  Windows also try each PATHEXT suffix (cmux ships no binary there today, but the
 *  check stays honest rather than hardcoding unix). */
export function isOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK)
        return true
      } catch { /* not here */ }
    }
  }
  return false
}

/** cmux embeds Limn's review page in a pane beside the coding agent's own — only worth
 *  trying when the CLI is running inside a cmux session (CMUX_SOCKET set) and the
 *  `cmux` binary is actually reachable. */
export function cmuxAvailable(env: NodeJS.ProcessEnv, hasExecutable: (name: string) => boolean): boolean {
  return Boolean(env.CMUX_SOCKET) && hasExecutable('cmux')
}

/** Ask cmux to open `url` in a new pane beside the current one. `run` is injected so
 *  tests never actually spawn `cmux`. */
export function openInCmux(
  url: string,
  run: (cmd: string, args: string[]) => { status: number | null; error?: Error }
): { ok: true } | { ok: false; reason: string } {
  const { status, error } = run('cmux', ['new-pane', '--type', 'browser', '--direction', 'right', '--url', url])
  if (error) return { ok: false, reason: error.message }
  if (status !== 0) return { ok: false, reason: `exit ${status}` }
  return { ok: true }
}

/** The real `run` for openInCmux — spawnSync mapped to its {status, error} shape. */
function spawnCmux(cmd: string, args: string[]): { status: number | null; error?: Error } {
  const r = spawnSync(cmd, args, { stdio: 'ignore' })
  return { status: r.status, error: r.error }
}

/** `OpenDeps.openInCmux`: null when cmux isn't available here at all, so callers can
 *  tell "didn't try" from "tried and failed". */
export function tryOpenInCmux(url: string): { ok: true } | { ok: false; reason: string } | null {
  return cmuxAvailable(process.env, (name) => isOnPath(name)) ? openInCmux(url, spawnCmux) : null
}
