import { describe, it, expect } from 'vitest'
import { renderStatus } from '../src/cli/service/status'

const health = { app: 'limn' as const, version: '0.4.0', pid: 4211, startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), port: 5466 }
const base = { version: '0.4.0', port: 5466, host: '127.0.0.1', url: 'http://limn.localhost:5466', health: null, activation: null, manager: 'launchd' as const, unsupported: false, dbPath: '/Users/u/Library/Application Support/limn/limn.db', logFile: '/Users/u/Library/Logs/limn.log' }
const loaded = { kind: 'service' as const, loaded: true as const, running: true, pid: 4211, port: 5466, unitPath: '/Users/u/Library/LaunchAgents/dev.glebmish.limn.plist', nodePath: '/opt/homebrew/bin/node', nodeOk: true, restartCmd: 'launchctl kickstart -k gui/501/dev.glebmish.limn', stopCmd: 'launchctl bootout gui/501/dev.glebmish.limn' }

describe('renderStatus', () => {
  it('service activation: running', () => {
    const { lines, exitCode } = renderStatus({ ...base, health, activation: loaded })
    const text = lines.join('\n')
    expect(exitCode).toBe(0)
    expect(text).toMatch(/activation:\s+launchd agent dev\.glebmish\.limn — loaded, RunAtLoad\+KeepAlive, running/)
    expect(text).toMatch(/server:\s+http:\/\/limn\.localhost:5466 .*pid 4211 .*up 3h/)
    expect(text).toMatch(/node:\s+\/opt\/homebrew\/bin\/node — matches unit/)
    expect(text).toMatch(/restart:\s+launchctl kickstart -k/)
    expect(text).toMatch(/stop:\s+launchctl bootout .*limn service uninstall/)
  })
  it('names the unit by the backend, not by sniffing the restart command', () => {
    // a launchd-looking restartCmd under the systemd manager must still render as systemd
    const text = renderStatus({ ...base, manager: 'systemd', health, activation: loaded }).lines.join('\n')
    expect(text).toMatch(/activation:\s+systemd --user unit limn — enabled, running/)
  })
  it('service loaded but node missing → repair hint, exit 1', () => {
    const { lines, exitCode } = renderStatus({ ...base, activation: { ...loaded, running: false, pid: null, nodeOk: false } })
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toMatch(/node:\s+MISSING at \/opt\/homebrew\/bin\/node — run `limn service install` to repair/)
  })
  it('foreground activation reports the answering server\'s pid', () => {
    const { lines, exitCode } = renderStatus({ ...base, health, activation: { kind: 'service', loaded: false, unitPath: '/x' } })
    expect(exitCode).toBe(0)
    expect(lines.join('\n')).toMatch(/activation:\s+foreground, pid 4211/)
    expect(lines.join('\n')).toMatch(/stop:\s+Ctrl-C in its terminal/)
  })
  // `LIMN_PORT=5467 limn service status` next to a unit on 5466: the server answering
  // on 5467 is a foreground one, not the unit — never "loaded … running" with its pid
  it('a unit serving another port is not credited with this port\'s server', () => {
    const fg = { ...health, pid: 777, port: 5467 }
    const t = { ...base, port: 5467, url: 'http://limn.localhost:5467' }
    const { lines, exitCode } = renderStatus({ ...t, health: fg, activation: loaded })
    const text = lines.join('\n')
    expect(exitCode).toBe(0)
    expect(text).toMatch(/activation:\s+foreground, pid 777/)
    expect(text).toMatch(/service:\s+launchd agent dev\.glebmish\.limn serves port 5466, not 5467/)
    expect(text).not.toMatch(/RunAtLoad/)
    expect(text).not.toMatch(/node:/)
    expect(text).toMatch(/stop:\s+Ctrl-C in its terminal/)
    // nothing on 5467: not running, whatever the unit on 5466 is doing
    expect(renderStatus({ ...t, activation: loaded }).lines.join('\n')).toMatch(/activation:\s+not running/)
  })
  it('not running', () => {
    const { lines, exitCode } = renderStatus({ ...base, activation: { kind: 'service', loaded: false, unitPath: '/x' } })
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toMatch(/activation:\s+not running/)
    expect(lines.join('\n')).toMatch(/limn service install/)
  })
  it('shows the real host for a LIMN_WEB_HOST deployment, without a bogus loopback aside', () => {
    const t = { ...base, host: 'my-box.tailnet.ts.net', url: 'http://my-box.tailnet.ts.net:5466' }
    expect(renderStatus({ ...t, health, activation: loaded }).lines.join('\n'))
      .toMatch(/server:\s+http:\/\/my-box\.tailnet\.ts\.net:5466 {2}pid 4211/)
    expect(renderStatus(t).lines.join('\n')).not.toContain('127.0.0.1')
  })
  it('brackets an IPv6 bind in the dialable address', () => {
    const lines = renderStatus({ ...base, host: '::1', url: 'http://limn.localhost:5466', health }).lines.join('\n')
    expect(lines).toContain('http://limn.localhost:5466  ([::1]:5466)')
  })
  it('unsupported platform', () => {
    const { lines } = renderStatus({ ...base, manager: null, unsupported: true })
    expect(lines.join('\n')).toMatch(/background service not supported on this platform/)
  })
})
