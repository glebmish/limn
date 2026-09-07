import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { startServer, type RunningServer, type ServerOptions } from '../src/server/http'

let running: RunningServer | null = null
afterEach(async () => { await running?.close(); running = null })

async function boot(over: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-audit-'))
  running = await startServer({ port: 0, dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {}, ...over })
  return running
}

/** A literal HTTP request over a raw socket — bypasses Node's http.request header
 *  validation, which would refuse to even send a malformed Host itself. Resolves
 *  with whatever bytes came back (empty if the connection closed/timed out with no
 *  response at all — the pre-fix, crash-the-process outcome). */
function rawRequest(port: number, requestText: string, timeoutMs = 2000): Promise<{ raw: string; closedWithoutResponse: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => { socket.write(requestText) })
    let data = ''
    let settled = false
    const timer = setTimeout(() => finish(), timeoutMs)
    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ raw: data, closedWithoutResponse: data.length === 0 })
    }
    socket.on('data', (c) => { data += (c as Buffer).toString('utf8') })
    socket.on('close', finish)
    socket.on('error', (err) => { settled = true; clearTimeout(timer); reject(err) })
  })
}

function statusLine(raw: string): number | null {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw)
  return m ? Number(m[1]) : null
}

describe('malformed request input (audit finding 1)', () => {
  it('answers 400 for a Host header that is not a valid URL authority, and keeps the service alive', async () => {
    const s = await boot()
    const { raw, closedWithoutResponse } = await rawRequest(s.port, 'GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n')
    expect(closedWithoutResponse).toBe(false)
    expect(statusLine(raw)).toBe(400)
    // the service must still be able to answer afterward — nothing crashed
    expect((await fetch(`${s.url}/health`)).status).toBe(200)
  })
})
