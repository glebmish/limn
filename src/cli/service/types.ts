import { execFile } from 'node:child_process'
import { DEFAULT_PORT } from '../../server/http.js'

export interface UnitSpec {
  nodePath: string
  entryPath: string
  port80: boolean
  pathEnv: string
  logFile: string
  home: string
  extraEnv: Record<string, string>
}

export type Activation =
  /** `port`: the port the unit serves — the LIMN_PORT it pins, else the default. */
  | { kind: 'service'; loaded: true; running: boolean; pid: number | null; port: number; unitPath: string; nodePath: string; nodeOk: boolean; restartCmd: string; stopCmd: string }
  | { kind: 'service'; loaded: false; unitPath: string }

export interface ServiceBackend {
  readonly name: 'launchd' | 'systemd'
  unitPath(): string
  renderUnit(spec: UnitSpec): string
  install(spec: UnitSpec, run: Exec): Promise<void>      // write + (re)load + start
  uninstall(run: Exec): Promise<void>
  activation(run: Exec): Promise<Activation>
}

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const execAsync: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
    const errCode = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code
    const code = typeof errCode === 'number' ? errCode : err ? 1 : 0
    resolve({ code, stdout: String(stdout), stderr: String(stderr) })
  })
})

/** The port a unit serves, from the LIMN_PORT value its env pins (`pinned` — the
 *  captured value, or undefined when the unit pins none): the default port then. */
export function unitPort(pinned: string | undefined): number {
  const n = pinned === undefined ? NaN : Number(pinned)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT
}
