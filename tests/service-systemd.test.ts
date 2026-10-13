import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { systemd, parseShow } from '../src/cli/service/systemd'

const spec = { nodePath: '/usr/bin/node', entryPath: '/usr/lib/node_modules/@glebmish/limn/dist/cli/index.js', port80: false, pathEnv: '/usr/bin:/bin', logFile: '/home/u/.local/state/limn/limn.log', home: '/home/u', extraEnv: {} }

describe('systemd unit', () => {
  it('renders a user unit with Restart=always and the absolute ExecStart', () => {
    const unit = systemd.renderUnit(spec)
    expect(unit).toContain('[Service]')
    expect(unit).toContain('ExecStart="/usr/bin/node" "/usr/lib/node_modules/@glebmish/limn/dist/cli/index.js" service serve')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"')
    expect(unit).toContain('WantedBy=default.target')
    expect(systemd.renderUnit({ ...spec, port80: true })).toContain('service serve --port-80')
  })
  // systemd splits an unquoted Environment= on whitespace and expands %-specifiers;
  // a DB path with a space or a token with a % would otherwise be silently mangled.
  it('quotes Environment= values so spaces and % survive systemd parsing', () => {
    const unit = systemd.renderUnit({ ...spec, home: '/home/u', extraEnv: { LIMN_DB: '/home/u/My Files/limn.db', LIMN_WEB_TOKEN: 'a%b"c\\d' } })
    expect(unit).toContain('Environment="LIMN_DB=/home/u/My Files/limn.db"')
    expect(unit).toContain('Environment="LIMN_WEB_TOKEN=a%%b\\"c\\\\d"')
    expect(unit).toContain('Environment="HOME=/home/u"')
  })
  // systemd splits an unquoted ExecStart= on whitespace (each token becomes its own
  // argv entry) and expands %-specifiers, exactly like Environment= above — but
  // ExecStart never got the same quoting treatment.
  it('quotes ExecStart nodePath/entryPath so a path with a space is not split into extra argv tokens', () => {
    const spaced = { ...spec, nodePath: '/Users/gleb mish/.nvm/versions/node/v20/bin/node', entryPath: '/Users/gleb mish/lib/node_modules/@glebmish/limn/dist/cli/index.js' }
    const unit = systemd.renderUnit(spaced)
    expect(unit).toContain(`ExecStart="${spaced.nodePath}" "${spaced.entryPath}" service serve`)
  })
  it('doubles a literal % in nodePath/entryPath so systemd does not expand it as a specifier', () => {
    const pct = { ...spec, nodePath: '/opt/100%/bin/node', entryPath: '/opt/100%/index.js' }
    const unit = systemd.renderUnit(pct)
    expect(unit).toContain('ExecStart="/opt/100%%/bin/node" "/opt/100%%/index.js" service serve')
  })
  it('methods do not depend on `this` (destructured use works)', () => {
    const { renderUnit, unitPath } = systemd
    expect(renderUnit(spec)).toContain('[Service]')
    expect(unitPath()).toMatch(/limn\.service$/)
  })
  it('unit path is ~/.config/systemd/user/limn.service', () => {
    expect(systemd.unitPath()).toMatch(/\/\.config\/systemd\/user\/limn\.service$/)
  })
  it('parseShow reads ActiveState/MainPID', () => {
    expect(parseShow('ActiveState=active\nMainPID=123\n')).toEqual({ active: true, pid: 123 })
    expect(parseShow('ActiveState=inactive\nMainPID=0\n')).toEqual({ active: false, pid: null })
  })
  it('renders extraEnv entries, and none when empty', () => {
    const unit = systemd.renderUnit({ ...spec, extraEnv: { LIMN_PORT: '5477' } })
    expect(unit).toContain('Environment="LIMN_PORT=5477"')
    expect(systemd.renderUnit(spec)).not.toContain('LIMN_PORT')
  })
})

describe('systemd install', () => {
  // Same reasoning as launchd: the unit holds LIMN_WEB_TOKEN. XDG_CONFIG_HOME keeps
  // this out of the developer's real ~/.config.
  it('writes the unit 0600, and repairs the mode of an existing 0644 one', async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-xdg-'))
    const saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = cfg
    try {
      const file = systemd.unitPath()
      const runs: string[][] = []
      const run = async (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
        runs.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }
      }
      const logFile = path.join(cfg, 'limn.log')
      // destructured on purpose: the backend must not lean on `this`
      const { install } = systemd
      await install({ ...spec, logFile, extraEnv: { LIMN_WEB_TOKEN: 's3cret' } }, run)
      expect(fs.readFileSync(file, 'utf8')).toContain('s3cret')
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(runs.map((r) => r.join(' '))).toContain('systemctl --user daemon-reload')

      fs.chmodSync(file, 0o644)
      await systemd.install({ ...spec, logFile }, run)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
      fs.rmSync(cfg, { recursive: true, force: true })
    }
  })

  it('activation() recovers nodePath from a quoted ExecStart even with a space in the path', async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-xdg-'))
    const saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = cfg
    try {
      const nodePath = path.join(cfg, 'node bin', 'node')
      fs.mkdirSync(path.dirname(nodePath), { recursive: true })
      fs.writeFileSync(nodePath, '', { mode: 0o755 })
      const installRun = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 0, stdout: '', stderr: '' })
      await systemd.install({ ...spec, nodePath, logFile: path.join(cfg, 'limn.log') }, installRun)
      const showRun = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 0, stdout: 'ActiveState=active\nMainPID=123\n', stderr: '' })
      const a = await systemd.activation(showRun)
      expect(a.loaded).toBe(true)
      if (a.loaded) { expect(a.nodePath).toBe(nodePath); expect(a.nodeOk).toBe(true); expect(a.port).toBe(5466) }
      // a unit pinning LIMN_PORT reports that port
      await systemd.install({ ...spec, nodePath, logFile: path.join(cfg, 'limn.log'), extraEnv: { LIMN_PORT: '5477' } }, installRun)
      const pinned = await systemd.activation(showRun)
      expect(pinned.loaded && pinned.port).toBe(5477)
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
      fs.rmSync(cfg, { recursive: true, force: true })
    }
  })
})
