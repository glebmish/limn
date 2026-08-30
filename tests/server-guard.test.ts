import { describe, it, expect } from 'vitest'
import { CANONICAL_HOST, isLoopbackHost, isLoopbackName, isProtectedPath, sameSiteOk } from '../src/server/guard'

describe('isLoopbackName', () => {
  it('recognizes loopback hosts (with bracket/case variants)', () => {
    for (const n of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackName(n)).toBe(true)
    }
  })
  it('rejects non-loopback hosts', () => {
    for (const n of ['0.0.0.0', '192.168.1.5', 'evil.com', 'my-box.tailnet.ts.net', '10.0.0.1', 'localhost.evil.com']) {
      expect(isLoopbackName(n)).toBe(false)
    }
  })
  it('rejects .localhost names — a bind address must be a real loopback literal', () => {
    for (const n of [CANONICAL_HOST, 'limn.localhost', 'other.localhost', 'a.b.localhost']) {
      expect(isLoopbackName(n)).toBe(false)
    }
  })
})

describe('isLoopbackHost', () => {
  it('accepts what isLoopbackName accepts', () => {
    for (const n of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(n)).toBe(true)
    }
  })
  it('accepts the canonical vanity name the browser resolved for us', () => {
    expect(isLoopbackHost(CANONICAL_HOST)).toBe(true)
    expect(isLoopbackHost('limn.localhost')).toBe(true)
    expect(isLoopbackHost('LIMN.localhost')).toBe(true)
  })
  it('accepts no other .localhost name (a DNS resolver may point one anywhere)', () => {
    for (const n of ['other.localhost', 'a.b.localhost', 'attacker.localhost', 'localhost.evil.com', 'evil.com']) {
      expect(isLoopbackHost(n)).toBe(false)
    }
  })
})

describe('isProtectedPath', () => {
  it('protects repository APIs while allowing the static client to bootstrap', () => {
    expect(isProtectedPath('/events')).toBe(true)
    expect(isProtectedPath('/rpc/dashboard')).toBe(true)
    expect(isProtectedPath('/')).toBe(false)
    expect(isProtectedPath('/assets/index.js')).toBe(false)
  })
})

describe('sameSiteOk (CSRF / DNS-rebinding guard)', () => {
  it('allows a same-origin request (served SPA → its own host)', () => {
    expect(sameSiteOk({ host: 'localhost:8787', origin: 'http://localhost:8787' }, false)).toBe(true)
  })

  it('allows the canonical limn.localhost origin with no token', () => {
    expect(sameSiteOk({ host: 'limn.localhost:5466', origin: 'http://limn.localhost:5466' }, false)).toBe(true)
    expect(sameSiteOk({ host: 'limn.localhost:5466' }, false)).toBe(true)
  })

  it('blocks any other .localhost Host with no token (rebinding through a DNS resolver)', () => {
    expect(sameSiteOk({ host: 'other.localhost:5466' }, false)).toBe(false)
    expect(sameSiteOk({ host: 'attacker.localhost:5466', origin: 'http://attacker.localhost:5466' }, false)).toBe(false)
  })

  it('allows a no-Origin request on loopback (curl / native client)', () => {
    expect(sameSiteOk({ host: '127.0.0.1:8787' }, false)).toBe(true)
  })

  it('blocks a cross-origin drive-by POST (malicious site → 127.0.0.1)', () => {
    expect(sameSiteOk({ host: '127.0.0.1:8787', origin: 'https://evil.com' }, false)).toBe(false)
  })

  it('blocks DNS-rebinding (attacker Host, no token perimeter)', () => {
    expect(sameSiteOk({ host: 'evil.com' }, false)).toBe(false)
  })

  it('allows a non-loopback Host when a token perimeter is set (Tailscale)', () => {
    expect(sameSiteOk({ host: 'my-box.tailnet.ts.net' }, true)).toBe(true)
  })

  it('still blocks cross-origin even with a token set', () => {
    expect(sameSiteOk({ host: 'my-box.tailnet.ts.net', origin: 'https://evil.com' }, true)).toBe(false)
  })

  it('treats a malformed Origin as cross-site (rejected)', () => {
    expect(sameSiteOk({ host: '127.0.0.1:8787', origin: 'not a url' }, false)).toBe(false)
  })
})
