import type { HealthInfo } from '../health.js'
import type { Activation } from './types.js'

export interface StatusModel {
  version: string
  port: number
  health: HealthInfo | null
  activation: Activation | null
  unsupported: boolean
  dbPath: string
  logFile: string
  foregroundPid: number | null
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
  const svc = a && a.loaded ? a : null
  const running = Boolean(m.health)
  if (m.unsupported) {
    L.push('  activation:  background service not supported on this platform — run `limn service serve`')
  } else if (svc) {
    const unit = svc.restartCmd.startsWith('launchctl')
      ? 'launchd agent dev.glebmish.limn — loaded, RunAtLoad+KeepAlive'
      : 'systemd --user unit limn — enabled'
    L.push(`  activation:  ${unit}, ${svc.running ? 'running' : running ? 'respawning' : 'not running'}`)
  } else if (running) {
    L.push(`  activation:  foreground, pid ${m.foregroundPid ?? m.health!.pid}`)
  } else {
    L.push('  activation:  not running — `limn service install` (always-on) or `limn service serve` (foreground)')
  }
  if (m.health) L.push(`  server:      http://limn.localhost:${m.port}  (127.0.0.1:${m.port})  pid ${m.health.pid}  ${uptime(m.health.startedAt)}`.trimEnd())
  else L.push(`  server:      http://limn.localhost:${m.port} — not answering`)
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
