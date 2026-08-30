import os from 'node:os'
import path from 'node:path'

/** Mirrors Electron's app.getPath('userData') for app name 'limn' so the service
 *  keeps using the database the desktop app created. */
export function userDataDir(): string {
  const home = os.homedir()
  const base = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'))
  return path.join(base, 'limn')
}

export function defaultDbPath(): string {
  return process.env.LIMN_DB || path.join(userDataDir(), 'limn.db')
}

/** CLI-only state (first-run prompt answer). Kept out of the DB so the CLI never
 *  opens SQLite while the service holds it. */
export function cliStatePath(): string {
  return path.join(userDataDir(), 'cli.json')
}

export function logPath(): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'limn.log')
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'limn', 'limn.log')
}
