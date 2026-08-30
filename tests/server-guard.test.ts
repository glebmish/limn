import { describe, it, expect } from 'vitest'
import { CANONICAL_HOST, hostForUrl, isJsonContentType, isLoopbackHost, isLoopbackName, isProtectedPath, sameSiteOk } from '../src/server/guard'

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

  // An opaque origin — a sandboxed iframe, a data: URL, some redirect chains. It is
  // never our own page (the SPA is served from a real loopback origin), so on the
  // protected surface it is exactly the drive-by we are guarding against.
  it('treats an opaque `Origin: null` as cross-site (rejected), token or not', () => {
    expect(sameSiteOk({ host: '127.0.0.1:8787', origin: 'null' }, false)).toBe(false)
    expect(sameSiteOk({ host: 'limn.localhost:5466', origin: 'null' }, false)).toBe(false)
    expect(sameSiteOk({ host: 'my-box.tailnet.ts.net', origin: 'null' }, true)).toBe(false)
  })

  it('rejects a browser-declared cross-site fetch even when the Origin is absent', () => {
    expect(sameSiteOk({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }, false)).toBe(false)
    // the values our own page sends
    expect(sameSiteOk({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }, false)).toBe(true)
    expect(sameSiteOk({ host: '127.0.0.1:8787', 'sec-fetch-site': 'none' }, false)).toBe(true)
  })

  it('parses an IPv6 Host literal rather than splitting on the first colon', () => {
    expect(sameSiteOk({ host: '[::1]:5466' }, false)).toBe(true)
    expect(sameSiteOk({ host: '[::1]:5466', origin: 'http://[::1]:5466' }, false)).toBe(true)
    expect(sameSiteOk({ host: '[2001:db8::1]:5466' }, false)).toBe(false)
  })

  it('rejects an unparseable Host with no token perimeter', () => {
    expect(sameSiteOk({ host: 'a b c' }, false)).toBe(false)
    expect(sameSiteOk({ host: '' }, false)).toBe(false)
  })
})

describe('isJsonContentType', () => {
  it('accepts the JSON media type with any casing or parameters', () => {
    for (const v of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', ' application/json ']) {
      expect(isJsonContentType(v)).toBe(true)
    }
  })
  it('rejects the form/plain types an HTML form can send without a preflight', () => {
    for (const v of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json-seq', undefined, '']) {
      expect(isJsonContentType(v)).toBe(false)
    }
  })
  it('reads the first value when the header was sent twice', () => {
    expect(isJsonContentType(['application/json', 'text/plain'])).toBe(true)
    expect(isJsonContentType(['text/plain'])).toBe(false)
  })
})

describe('hostForUrl', () => {
  it('brackets a bare IPv6 literal and leaves everything else alone', () => {
    expect(hostForUrl('::1')).toBe('[::1]')
    expect(hostForUrl('fd7a:115c:a1e0::1')).toBe('[fd7a:115c:a1e0::1]')
    expect(hostForUrl('[::1]')).toBe('[::1]')
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1')
    expect(hostForUrl('my-box.tailnet.ts.net')).toBe('my-box.tailnet.ts.net')
  })
})
