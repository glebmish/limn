import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

describe('launchd install', () => {
  // The unit carries LIMN_WEB_TOKEN, so it must not be world-readable. A temp HOME
  // keeps this out of the developer's real ~/Library/LaunchAgents.
  it('activation() reports the port the unit pins, else the default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-home-'))
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      const run = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 0, stdout: '\tstate = running\n\tpid = 9\n', stderr: '' })
      const logFile = path.join(home, 'Library', 'Logs', 'limn.log')
      await launchd.install({ ...spec, home, logFile, extraEnv: { LIMN_PORT: '5477' } }, run)
      let a = await launchd.activation(run)
      expect(a.loaded && a.port).toBe(5477)
      await launchd.install({ ...spec, home, logFile }, run)
      a = await launchd.activation(run)
      expect(a.loaded && a.port).toBe(5466)
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('writes the unit 0600, and repairs the mode of an existing 0644 one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-home-'))
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      const file = launchd.unitPath()
      const runs: string[][] = []
      const run = async (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
        runs.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }
      }
      const logFile = path.join(home, 'Library', 'Logs', 'limn.log')
      // destructured on purpose: the backend must not lean on `this`
      const { install } = launchd
      await install({ ...spec, home, logFile, extraEnv: { LIMN_WEB_TOKEN: 's3cret' } }, run)
      expect(fs.readFileSync(file, 'utf8')).toContain('s3cret')
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(runs.map((r) => r[1])).toContain('bootstrap')

      fs.chmodSync(file, 0o644)
      await launchd.install({ ...spec, home, logFile }, run)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
