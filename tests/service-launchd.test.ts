import { describe, it, expect } from 'vitest'
import { launchd, parseLaunchctlPrint, LABEL } from '../src/cli/service/launchd'

const spec = { nodePath: '/opt/homebrew/bin/node', entryPath: '/opt/homebrew/lib/node_modules/@glebmish/limn/dist/cli/index.js', port80: false, pathEnv: '/opt/homebrew/bin:/usr/bin:/bin', logFile: '/Users/u/Library/Logs/limn.log', home: '/Users/u', extraEnv: {} }

describe('launchd unit', () => {
  it('renders a KeepAlive LaunchAgent that runs `service serve` with absolute paths', () => {
    const xml = launchd.renderUnit(spec)
    expect(xml).toContain(`<string>${LABEL}</string>`)
    expect(xml).toContain('<string>/opt/homebrew/bin/node</string>')
    expect(xml).toContain('<string>/opt/homebrew/lib/node_modules/@glebmish/limn/dist/cli/index.js</string>')
    expect(xml).toMatch(/<string>service<\/string>\s*<string>serve<\/string>/)
    expect(xml).not.toContain('--port-80')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>')
    expect(xml).toContain('<string>/Users/u/Library/Logs/limn.log</string>')
    expect(xml).toContain('launchctl kickstart -k')
  })
  it('adds --port-80 when requested', () => {
    expect(launchd.renderUnit({ ...spec, port80: true })).toMatch(/<string>--port-80<\/string>/)
  })
  it('unit path is the user LaunchAgents dir', () => {
    expect(launchd.unitPath()).toMatch(/\/Library\/LaunchAgents\/dev\.glebmish\.limn\.plist$/)
  })
  it('renders extraEnv entries, and none when empty', () => {
    const xml = launchd.renderUnit({ ...spec, extraEnv: { LIMN_PORT: '5477' } })
    expect(xml).toContain('<key>LIMN_PORT</key>')
    expect(xml).toContain('<string>5477</string>')
    expect(launchd.renderUnit(spec)).not.toContain('<key>LIMN_PORT</key>')
  })
})

describe('parseLaunchctlPrint', () => {
  it('extracts pid and running state', () => {
    expect(parseLaunchctlPrint('dev.glebmish.limn = {\n\tactive count = 1\n\tpath = /x\n\tstate = running\n\tpid = 4211\n}')).toEqual({ pid: 4211, running: true })
    expect(parseLaunchctlPrint('dev.glebmish.limn = {\n\tstate = not running\n\tlast exit code = 1\n}')).toEqual({ pid: null, running: false })
  })
})
