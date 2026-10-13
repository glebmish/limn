import { hostForUrl } from '../../server/guard.js'
import type { HealthInfo } from '../health.js'
import type { Activation } from './types.js'

export interface StatusModel {
  version: string
  port: number
  /** the configured bind address (LIMN_WEB_HOST, else 127.0.0.1) */
  host: string
  /** the address to open in a browser — the vanity name on loopback, the real host otherwise */
  url: string
  health: HealthInfo | null
  activation: Activation | null
  /** which service manager the activation came from (null: no backend on this platform) */
  manager: 'launchd' | 'systemd' | null
  unsupported: boolean
  dbPath: string
  logFile: string
}

function uptime(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const h = Math.floor(ms / 3600_000), d = Math.floor(h / 24), m = Math.floor((ms % 3600_000) / 60_000)
  return d > 0 ? `up ${d}d ${h % 24}h` : h > 0 ? `up ${h}h ${m}m` : `up ${m}m`
}

/** The whole `limn service status` report: pure text + the process exit code
 *  (0 only when the server answers and, if it is a unit, its node still exists). */
export function renderStatus(m: StatusModel): { lines: string[]; exitCode: number } {
  const L: string[] = [`Limn ${m.version}`]
  const a = m.activation
  // a unit serving another port is not what answers here (LIMN_PORT points this shell
  // elsewhere): report this port on its own, and name the unit's port below
  const svc = a && a.loaded && a.port === m.port ? a : null
  const elsewhere = a && a.loaded && a.port !== m.port ? a : null
  const running = Boolean(m.health)
  if (m.unsupported) {
    L.push('  activation:  background service not supported on this platform — run `limn service serve`')
  } else if (svc) {
    const unit = m.manager === 'systemd'
      ? 'systemd --user unit limn — enabled'
      : 'launchd agent dev.glebmish.limn — loaded, RunAtLoad+KeepAlive'
    L.push(`  activation:  ${unit}, ${svc.running ? 'running' : running ? 'respawning' : 'not running'}`)
  } else if (running) {
    L.push(`  activation:  foreground, pid ${m.health!.pid}`)
  } else {
    L.push('  activation:  not running — `limn service install` (always-on) or `limn service serve` (foreground)')
  }
  if (elsewhere) {
    const unit = m.manager === 'systemd' ? 'systemd --user unit limn' : 'launchd agent dev.glebmish.limn'
    L.push(`  service:     ${unit} serves port ${elsewhere.port}, not ${m.port}`)
  }
  // On loopback the browser address (limn.localhost) and the dialable one differ, so
  // show both; under LIMN_WEB_HOST they are the same host and one is enough.
  const address = `${hostForUrl(m.host)}:${m.port}`
  const where = m.url === `http://${address}` ? m.url : `${m.url}  (${address})`
  if (m.health) L.push(`  server:      ${where}  pid ${m.health.pid}  ${uptime(m.health.startedAt)}`.trimEnd())
  else L.push(`  server:      ${where} — not answering`)
  if (svc) L.push(svc.nodeOk ? `  node:        ${svc.nodePath} — matches unit` : `  node:        MISSING at ${svc.nodePath} — run \`limn service install\` to repair`)
  L.push(`  database:    ${m.dbPath}`)
  L.push(`  logs:        ${m.logFile}`)
  if (svc) {
    L.push(`  restart:     ${svc.restartCmd}`)
    L.push(`  stop:        ${svc.stopCmd}   (or: limn service uninstall)`)
  } else if (running) {
    L.push('  stop:        Ctrl-C in its terminal')
  }
  return { lines: L, exitCode: running && (!svc || svc.nodeOk) ? 0 : 1 }
}
