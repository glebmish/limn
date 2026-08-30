import { describe, it, expect } from 'vitest'
import { decideOpen, isNpxInvocation, serviceQuestion } from '../src/cli/open'

const health = { app: 'limn' as const, version: '0.4.0', pid: 1, startedAt: '', port: 5466 }
const base = { health: null, noService: false, isTTY: true, serviceInstalled: false, declinedBefore: false, serviceSupported: true }

describe('decideOpen', () => {
  it('client role whenever a server answers', () => {
    expect(decideOpen({ ...base, health })).toEqual({ role: 'client' })
    expect(decideOpen({ ...base, health, noService: true })).toEqual({ role: 'client' })
  })
  it('server role offers the service only on a TTY, when not installed, not declined, not --no-service', () => {
    expect(decideOpen(base)).toEqual({ role: 'server', offerService: true })
    expect(decideOpen({ ...base, isTTY: false })).toEqual({ role: 'server', offerService: false })
    expect(decideOpen({ ...base, noService: true })).toEqual({ role: 'server', offerService: false })
    expect(decideOpen({ ...base, declinedBefore: true })).toEqual({ role: 'server', offerService: false })
    // installed but not answering → KeepAlive is respawning it, or node moved; don't re-offer, run foreground
    expect(decideOpen({ ...base, serviceInstalled: true })).toEqual({ role: 'server', offerService: false })
  })
  it('never offers the service where there is no backend for it (Windows)', () => {
    expect(decideOpen({ ...base, serviceSupported: false })).toEqual({ role: 'server', offerService: false })
  })
})

describe('serviceQuestion', () => {
  it('names the unit the platform would actually write', () => {
    const q = serviceQuestion({ url: 'http://limn.localhost:5466', npx: false, backend: 'launchd' })
    expect(q).toContain('a LaunchAgent in ~/Library/LaunchAgents')
    expect(q).toContain('http://limn.localhost:5466')
    expect(serviceQuestion({ url: 'http://limn.localhost:5466', npx: false, backend: 'systemd' }))
      .toContain('a systemd --user unit in ~/.config/systemd/user')
  })
  it('under npx it also offers the global install', () => {
    const q = serviceQuestion({ url: 'http://limn.localhost:5466', npx: true, backend: 'systemd' })
    expect(q).toContain('npm i -g @glebmish/limn')
    expect(q).toContain('~/.config/systemd/user')
  })
})

describe('isNpxInvocation', () => {
  it('detects the npx cache path', () => {
    expect(isNpxInvocation('/Users/x/.npm/_npx/abc123/node_modules/@glebmish/limn/dist/cli/index.js')).toBe(true)
    expect(isNpxInvocation('/opt/homebrew/lib/node_modules/@glebmish/limn/dist/cli/index.js')).toBe(false)
  })
})
