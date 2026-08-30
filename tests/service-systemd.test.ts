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
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@glebmish/limn/dist/cli/index.js service serve')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment=PATH=/usr/bin:/bin')
    expect(unit).toContain('WantedBy=default.target')
    expect(systemd.renderUnit({ ...spec, port80: true })).toContain('service serve --port-80')
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
    expect(unit).toContain('Environment=LIMN_PORT=5477')
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
      await systemd.install({ ...spec, logFile, extraEnv: { LIMN_WEB_TOKEN: 's3cret' } }, run)
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
})
