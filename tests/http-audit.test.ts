import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { startServer, type RunningServer, type ServerOptions } from '../src/server/http'

/** A static root with a real index.html + one hashed asset, like a built SPA. */
function withIndex(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-static-audit-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n<html>\n  <head>\n    <title>Limn</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n')
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n')
  return dir
}

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

describe('malformed request input (audit findings 1 & 2)', () => {
  it('answers 400 for a Host header that is not a valid URL authority, and keeps the service alive', async () => {
    const s = await boot()
    const { raw, closedWithoutResponse } = await rawRequest(s.port, 'GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n')
    expect(closedWithoutResponse).toBe(false)
    expect(statusLine(raw)).toBe(400)
    // the service must still be able to answer afterward — nothing crashed
    expect((await fetch(`${s.url}/health`)).status).toBe(200)
  })

  it('answers with a non-crash status for an unparsable percent-escape in /rpc/<channel>', async () => {
    const s = await boot()
    const body = '[]'
    const req = `POST /rpc/%zz HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    const { raw, closedWithoutResponse } = await rawRequest(s.port, req)
    expect(closedWithoutResponse).toBe(false)
    // an undecodable channel segment is simply an unknown channel — 404, not a crash
    expect(statusLine(raw)).toBe(404)
    expect((await fetch(`${s.url}/health`)).status).toBe(200)
  })
})

describe('SPA fallback vs. a missing asset (audit finding 3)', () => {
  it('404s a missing hashed asset instead of serving the SPA document', async () => {
    const s = await boot({ staticRoot: withIndex() })
    const res = await fetch(`${s.url}/assets/index-OLDHASH.js`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('<div id="root">')
    // an extension-less client-side route still falls back to the SPA document
    const route = await fetch(`${s.url}/client/side/route`)
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('<div id="root">')
  })

  it('sends index.html with Cache-Control: no-store so a rebuild is picked up on reload', async () => {
    const s = await boot({ staticRoot: withIndex() })
    const res = await fetch(`${s.url}/`)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
