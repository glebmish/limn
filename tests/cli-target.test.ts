import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { serviceTarget } from '../src/cli/target'

const KEYS = ['LIMN_WEB_HOST', 'LIMN_WEB_TOKEN', 'LIMN_PORT'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('serviceTarget', () => {
  it('defaults to loopback on the default port, with the vanity URL and no token', () => {
    expect(serviceTarget()).toEqual({ host: '127.0.0.1', port: 5466, token: '', url: 'http://limn.localhost:5466' })
  })

  it('honours LIMN_PORT and an explicit port', () => {
    process.env.LIMN_PORT = '5477'
    expect(serviceTarget().port).toBe(5477)
    expect(serviceTarget(6000).port).toBe(6000)
    expect(serviceTarget(6000).url).toBe('http://limn.localhost:6000')
  })

  it('falls back to the default port when LIMN_PORT is out of the 0-65535 range, same as garbage input', () => {
    process.env.LIMN_PORT = '99999'
    expect(serviceTarget().port).toBe(5466)
    process.env.LIMN_PORT = '65536'
    expect(serviceTarget().port).toBe(5466)
    // the boundary itself is still honoured
    process.env.LIMN_PORT = '65535'
    expect(serviceTarget().port).toBe(65535)
  })

  it('uses the real host for a non-loopback bind (Tailscale) rather than limn.localhost', () => {
    process.env.LIMN_WEB_HOST = 'my-box.tailnet.ts.net'
    expect(serviceTarget()).toEqual({
      host: 'my-box.tailnet.ts.net', port: 5466, token: '', url: 'http://my-box.tailnet.ts.net:5466'
    })
  })

  it('brackets a bare IPv6 literal in the URL but not in the host', () => {
    process.env.LIMN_WEB_HOST = 'fd7a:115c:a1e0::1'
    const t = serviceTarget()
    expect(t.host).toBe('fd7a:115c:a1e0::1')
    expect(t.url).toBe('http://[fd7a:115c:a1e0::1]:5466')
    // a loopback literal still gets the vanity name
    process.env.LIMN_WEB_HOST = '::1'
    expect(serviceTarget().url).toBe('http://limn.localhost:5466')
  })

  it('carries LIMN_WEB_TOKEN through', () => {
    process.env.LIMN_WEB_TOKEN = 'sekrit'
    expect(serviceTarget().token).toBe('sekrit')
  })
})
