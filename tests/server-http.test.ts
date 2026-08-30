import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startServer, type RunningServer, type ServerOptions } from '../src/server/http'
import { makeFixtureRepo } from './helpers/fixtureRepo'

let running: RunningServer | null = null
afterEach(async () => { await running?.close(); running = null })

async function boot(over: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
  running = await startServer({ port: 0, dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {}, ...over })
  return running
}

/** A well-formed same-origin RPC — what the SPA sends. */
function rpc(s: RunningServer, channel: string, args: unknown[] = [], init: RequestInit = {}): Promise<Response> {
  const { headers, ...rest } = init
  return fetch(`${s.url}/rpc/${channel}`, {
    method: 'POST',
    body: JSON.stringify(args),
    ...rest,
    headers: { 'Content-Type': 'application/json', Origin: s.url, ...(headers as Record<string, string> | undefined) }
  })
}

/** Status code only — for endpoints (SSE) whose response never ends. */
function statusOf(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      resolve(res.statusCode ?? 0)
      res.destroy()
    })
    req.on('error', reject)
    req.end()
  })
}

/** Raw request so a test can dictate headers fetch() forbids (Host) — and read the
 *  status without following any of fetch()'s rules. */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

describe('startServer', () => {
  it('serves /health with the package version and an ephemeral port', async () => {
    const s = await boot()
    expect(s.port).toBeGreaterThan(0)
    const res = await fetch(`${s.url}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ app: 'limn', pid: process.pid, port: s.port })
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof body.startedAt).toBe('string')
  })

  it('cli:open issues a ticket that takeCliOpen redeems once', async () => {
    const s = await boot()
    const fx = makeFixtureRepo()
    const issue = await fetch(`${s.url}/rpc/cli:open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url },
      body: JSON.stringify([{ dir: fx.dir, compare: 'feature' }])
    })
    const { value } = await issue.json()
    expect(value.ticket).toMatch(/^[0-9a-f]{32}$/)
    const take = async (): Promise<unknown> => (await (await fetch(`${s.url}/rpc/takeCliOpen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url },
      body: JSON.stringify([value.ticket])
    })).json()).value
    // repoRoot returns git's realpath (/private/var vs /var on macOS)
    expect(await take()).toEqual({ repo: fs.realpathSync(fx.dir), compareInput: 'feature' })
    expect(await take()).toBeNull()
  })

  it('falls back to index.html for unknown paths and 404s when there is no build', async () => {
    const s = await boot()
    const res = await fetch(`${s.url}/some/spa/route`)
    expect(res.status).toBe(404)
  })

  it('rejects rather than hangs when the port is already taken', async () => {
    const s = await boot()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
    await expect(startServer({ port: s.port, dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {} }))
      .rejects.toThrow(/EADDRINUSE/)
  })

  it('refuses a non-loopback bind without a token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
    await expect(startServer({ port: 0, host: '0.0.0.0', dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {} }))
      .rejects.toThrow(/LIMN_WEB_TOKEN/)
  })

  it('refuses a .localhost bind name without a token — the system resolver need not return loopback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
    await expect(startServer({ port: 0, host: 'x.localhost', dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {} }))
      .rejects.toThrow(/LIMN_WEB_TOKEN/)
  })

  it('answers 413 rather than buffering an oversized RPC body', async () => {
    const s = await boot()
    // one arg, just over the 8 MB cap
    const res = await rpc(s, 'dashboard', ['x'.repeat(8 * 1024 * 1024 + 16)])
    expect(res.status).toBe(413)
  })

  // Pins the SSE shutdown path: without ending the /events responses, close()
  // waits on the live stream and the first SIGINT never stops the server.
  // (closeAllConnections() in close() is belt-and-braces for browser sockets that
  // outlive our FIN, and for Node versions that keep idle keep-alive sockets.)
  it('close() finishes promptly with an open SSE connection', async () => {
    const s = await boot()
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/events' }, (res) => {
        expect(res.statusCode).toBe(200)
        res.once('data', () => resolve())
        res.on('error', () => {})
      })
      req.on('error', reject)
      req.end()
    })
    const closed = running!.close().then(() => 'closed' as const)
    running = null
    const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000).unref())
    expect(await Promise.race([closed, timer])).toBe('closed')
  })
})

describe('the protected surface (CSRF / token perimeter)', () => {
  it('requires the JSON content type on /rpc/* — an HTML form body is 415', async () => {
    const s = await boot()
    const form = await fetch(`${s.url}/rpc/dashboard`, {
      // exactly what `<form enctype="text/plain">` sends: no preflight, JSON-shaped body
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: s.url }, body: '[]'
    })
    expect(form.status).toBe(415)
    expect((await form.json()).error).toMatch(/application\/json/)
    expect((await rpc(s, 'dashboard')).status).toBe(200)
  })

  it('accepts application/json with a charset parameter', async () => {
    const s = await boot()
    expect((await rpc(s, 'dashboard', [], { headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status).toBe(200)
  })

  it('rejects an opaque `Origin: null` — the sandboxed-iframe CSRF vector', async () => {
    const s = await boot()
    const res = await raw(s.port, {
      method: 'POST', path: '/rpc/dashboard', body: '[]',
      headers: { 'Content-Type': 'application/json', Origin: 'null', Host: `127.0.0.1:${s.port}` }
    })
    expect(res.status).toBe(403)
  })

  it('rejects a cross-origin POST and a browser-declared cross-site fetch', async () => {
    const s = await boot()
    expect((await rpc(s, 'dashboard', [], { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await rpc(s, 'dashboard', [], { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
  })

  it('with a token: /rpc and /events need it, /health stays public', async () => {
    const s = await boot({ token: 't' })
    expect((await rpc(s, 'dashboard', [], { headers: { Authorization: '' } })).status).toBe(401)
    expect((await rpc(s, 'dashboard', [], { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await rpc(s, 'dashboard', [], { headers: { Authorization: 'Bearer t' } })).status).toBe(200)
    expect(await statusOf(s.port, '/events')).toBe(401)
    // the SSE stream can only carry the token in the query string (EventSource sets no headers)
    expect(await statusOf(s.port, '/events?token=t')).toBe(200)
  })

  it('/health answers 200 even for a foreign Host (it is the public probe)', async () => {
    const s = await boot()
    expect((await raw(s.port, { path: '/health', headers: { Host: 'evil.example' } })).status).toBe(200)
    // …while the protected surface refuses that Host (DNS rebinding)
    const rebound = await raw(s.port, {
      method: 'POST', path: '/rpc/dashboard', body: '[]',
      headers: { 'Content-Type': 'application/json', Host: 'evil.example' }
    })
    expect(rebound.status).toBe(403)
  })
})
