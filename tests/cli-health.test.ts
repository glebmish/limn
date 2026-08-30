import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { probeHealth } from '../src/cli/health'

function listen(handler: http.RequestListener, host = '127.0.0.1'): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, host, () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }))
  })
}

describe('probeHealth', () => {
  it('returns the health body for a Limn server', async () => {
    const s = await listen((_req, res) => res.end(JSON.stringify({ app: 'limn', version: '0.4.0', pid: 1, startedAt: 'x', port: 1 })))
    expect(await probeHealth(s.port)).toMatchObject({ app: 'limn', version: '0.4.0' })
    s.close()
  })
  // A LIMN_WEB_HOST deployment binds only that address; probing 127.0.0.1 there
  // reports a healthy service as dead (see serviceTarget).
  it('probes the host it is given, and brackets an IPv6 literal', async () => {
    const body = JSON.stringify({ app: 'limn', version: '0.4.0', pid: 1, startedAt: 'x', port: 1 })
    const v6 = await listen((_req, res) => res.end(body), '::1')
    expect(await probeHealth(v6.port, '::1')).toMatchObject({ app: 'limn' })
    // …and nothing answers on the v4 loopback that the old hardcoded probe used
    expect(await probeHealth(v6.port, '127.0.0.1')).toBeNull()
    v6.close()
  })
  it('returns null for a non-Limn listener and for a closed port', async () => {
    const s = await listen((_req, res) => res.end('<html>hi</html>'))
    expect(await probeHealth(s.port)).toBeNull()
    const port = s.port
    s.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(await probeHealth(port)).toBeNull()
  })
})
