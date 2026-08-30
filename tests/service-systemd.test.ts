import { describe, it, expect } from 'vitest'
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
