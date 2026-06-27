import { describe, it, expect } from 'vitest'
import { isLoopbackName, isProtectedPath, sameSiteOk } from '../src/server/guard'

describe('isLoopbackName', () => {
  it('recognizes loopback hosts (with bracket/case variants)', () => {
    for (const n of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackName(n)).toBe(true)
    }
  })
  it('rejects non-loopback hosts', () => {
    for (const n of ['0.0.0.0', '192.168.1.5', 'evil.com', 'my-box.tailnet.ts.net', '10.0.0.1']) {
      expect(isLoopbackName(n)).toBe(false)
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
