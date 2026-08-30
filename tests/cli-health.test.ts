import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { probeHealth } from '../src/cli/health'

function listen(handler: http.RequestListener): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }))
  })
}

describe('probeHealth', () => {
  it('returns the health body for a Limn server', async () => {
    const s = await listen((_req, res) => res.end(JSON.stringify({ app: 'limn', version: '0.4.0', pid: 1, startedAt: 'x', port: 1 })))
    expect(await probeHealth(s.port)).toMatchObject({ app: 'limn', version: '0.4.0' })
    s.close()
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
