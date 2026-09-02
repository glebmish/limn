import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { issueRemote, runOpen, type OpenDeps } from '../src/cli/open'
import { RpcError } from '../src/cli/rpc'
import type { ServiceTarget } from '../src/cli/target'
import type { Io } from '../src/cli/main'

const loopback: ServiceTarget = { host: '127.0.0.1', port: 5466, token: '', url: 'http://limn.localhost:5466' }

const health = { app: 'limn' as const, version: '0.4.0', pid: 7, startedAt: new Date().toISOString(), port: 5466 }
const cmd = { kind: 'open' as const, dir: '/repo', hub: false, fresh: false, noService: false, generate: false, printUrl: false }
const printCmd = { ...cmd, printUrl: true }

function fakeIo(answer = true): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [], err_: string[] = []
  return { out_, err_, isTTY: true, out: (l) => { out_.push(l) }, err: (l) => { err_.push(l) }, ask: async () => answer }
}

/** Every dep is a fake: no fs, no network, no child processes. `calls` records order. */
function fakeDeps(over: Partial<OpenDeps> = {}): { deps: OpenDeps; calls: string[]; opened: string[] } {
  const calls: string[] = [], opened: string[] = []
  const deps: OpenDeps = {
    target: () => loopback,
    backend: () => 'launchd',
    probe: async () => null,
    issueRemote: async () => { calls.push('issueRemote'); return { ticket: 'tkt' } },
    install: async () => { calls.push('install'); return 0 },
    installed: async () => false,
    openBrowser: (url) => { calls.push('openBrowser'); opened.push(url) },
    readState: () => ({}),
    writeState: () => { calls.push('writeState') },
    npx: () => false,
    serve: async () => { calls.push('serve'); return 0 },
    findShim: () => null,
    openInCmux: () => null,
    ...over
  }
  return { deps, calls, opened }
}

describe('runOpen', () => {
  it('client role: asks the running server for a ticket and opens the page', async () => {
    const io = fakeIo()
    const { deps, calls, opened } = fakeDeps({ probe: async () => health })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).toEqual(['issueRemote', 'openBrowser'])
    expect(opened[0]).toBe('http://limn.localhost:5466/?open=tkt')
  })

  it('prompt accepted: installs the service, then hops to the client role', async () => {
    const io = fakeIo(true)
    const { deps, calls, opened } = fakeDeps()
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).toEqual(['install', 'issueRemote', 'openBrowser'])
    expect(opened[0]).toMatch(/\/\?open=tkt$/)
    expect(calls).not.toContain('serve')
  })

  it('prompt declined: records the decline before starting the server role', async () => {
    const io = fakeIo(false)
    const { deps, calls } = fakeDeps()
    let patch: unknown = null
    deps.writeState = (p) => { calls.push('writeState'); patch = p }
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).toEqual(['writeState', 'serve'])
    expect(patch).toEqual({ servicePromptDeclined: true })
  })

  it('a failed install falls back to the foreground server rather than dead-ending', async () => {
    const io = fakeIo(true)
    const { deps, calls } = fakeDeps({ install: async () => { calls.push('install'); return 3 } })
    // the user asked to review a directory; a service they can't install must not cost them that
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).toEqual(['install', 'serve'])
    expect(io.err_.join('\n')).toMatch(/continuing in the foreground/)
  })

  it('never offers the service on a platform with no backend', async () => {
    const io = fakeIo(true)
    const { deps, calls } = fakeDeps({ backend: () => null })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).toEqual(['serve'])
  })

  it('a LIMN_WEB_HOST + token target: the bearer goes to the service, the token to the tab', async () => {
    const io = fakeIo()
    const target: ServiceTarget = { host: 'my-box.tailnet.ts.net', port: 5466, token: 's3cret', url: 'http://my-box.tailnet.ts.net:5466' }
    let seen: ServiceTarget | null = null
    const { deps, opened } = fakeDeps({
      target: () => target,
      probe: async (port, host) => (host === 'my-box.tailnet.ts.net' && port === 5466 ? health : null),
      issueRemote: async (t) => { seen = t; return { ticket: 'tkt' } }
    })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(seen).toEqual(target)
    expect(opened[0]).toBe('http://my-box.tailnet.ts.net:5466/?open=tkt&token=s3cret')
  })

  it('a --generate result carrying a durable path opens that path, and its note goes to stderr', async () => {
    const io = fakeIo()
    const { deps, opened } = fakeDeps({
      probe: async () => health,
      issueRemote: async () => ({ ticket: 'tkt', path: '/review/7', note: 'busy…' })
    })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(opened[0]).toBe('http://limn.localhost:5466/review/7')
    expect(io.err_).toEqual(['note: busy…'])
  })

  it('a durable path picks up the token when there is a perimeter', async () => {
    const io = fakeIo()
    const target: ServiceTarget = { host: 'my-box.tailnet.ts.net', port: 5466, token: 's3cret', url: 'http://my-box.tailnet.ts.net:5466' }
    const { deps, opened } = fakeDeps({
      target: () => target,
      probe: async (port, host) => (host === 'my-box.tailnet.ts.net' && port === 5466 ? health : null),
      issueRemote: async () => ({ ticket: 'tkt', path: '/review/7' })
    })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(opened[0]).toBe('http://my-box.tailnet.ts.net:5466/review/7?token=s3cret')
  })

  it('--print-url: stdout is exactly the URL, no browser or cmux call', async () => {
    const io = fakeIo()
    const cmuxCalls: string[] = []
    const { deps, calls } = fakeDeps({
      probe: async () => health,
      openInCmux: (url) => { cmuxCalls.push(url); return { ok: true } }
    })
    expect(await runOpen(printCmd, io, deps)).toBe(0)
    expect(io.out_).toEqual(['http://limn.localhost:5466/?open=tkt'])
    expect(calls).not.toContain('openBrowser')
    expect(cmuxCalls).toEqual([])
  })

  it('cmux available and succeeding: no browser call, stdout says opened in cmux', async () => {
    const io = fakeIo()
    const { deps, calls, opened } = fakeDeps({
      probe: async () => health,
      openInCmux: () => ({ ok: true })
    })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).not.toContain('openBrowser')
    expect(opened).toEqual([])
    expect(io.out_).toEqual(['opened in cmux: http://limn.localhost:5466/?open=tkt'])
  })

  it('cmux failing: falls back to the browser and notes the failure on stderr', async () => {
    const io = fakeIo()
    const { deps, calls, opened } = fakeDeps({
      probe: async () => health,
      openInCmux: () => ({ ok: false, reason: 'exit 1' })
    })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    expect(calls).toContain('openBrowser')
    expect(opened[0]).toBe('http://limn.localhost:5466/?open=tkt')
    expect(io.err_).toEqual(['note: cmux pane failed (exit 1) — opened in the browser'])
  })

  it('the server role handles a --generate result the same way as the client role', async () => {
    const io = fakeIo(true)
    const { deps, opened } = fakeDeps({
      backend: () => null,
      serve: async (_c, _io, onReady) => { onReady?.({ port: 5466, url: 'http://limn.localhost:5466', vanity: false, aliasPort: null, close: async () => {} }); return 0 }
    })
    expect(await runOpen(cmd, io, deps)).toBe(0)
    // in-process server role calls the real issueCliOpen, not the fake issueRemote —
    // a plain open (no --generate) yields no durable path, just the ticket URL. It runs
    // fire-and-forget off `onReady`, so give its promise chain a tick to settle.
    await vi.waitFor(() => { expect(opened[0]).toBeDefined() })
    expect(opened[0]).toMatch(/^http:\/\/limn\.localhost:5466\/\?open=[0-9a-f]{32}$/)
  })

  it('client role: an RpcError from issueRemote reaches the user verbatim, exit 1', async () => {
    const io = fakeIo()
    const { deps, calls } = fakeDeps({
      probe: async () => health,
      issueRemote: async () => { throw new RpcError('reasoning effort needs a model (set a model first)', 400) }
    })
    expect(await runOpen(cmd, io, deps)).toBe(1)
    expect(io.out_).toEqual([])
    expect(io.err_).toEqual(['limn: reasoning effort needs a model (set a model first)'])
    expect(calls).not.toContain('openBrowser')
  })

  it('client role: a bare Error from issueRemote is a transport failure, exit 1', async () => {
    const io = fakeIo()
    const { deps } = fakeDeps({
      probe: async () => health,
      issueRemote: async () => { throw new Error('fetch failed') }
    })
    expect(await runOpen(cmd, io, deps)).toBe(1)
    expect(io.out_).toEqual([])
    expect(io.err_).toEqual(['error: could not reach the Limn server on 127.0.0.1:5466: fetch failed'])
  })

  it('non-TTY --generate/--print-url with no service running fails fast instead of hanging in a foreground server', async () => {
    const out_: string[] = [], err_: string[] = []
    const io: Io = { out: (l) => { out_.push(l) }, err: (l) => { err_.push(l) }, ask: async () => true, isTTY: false }
    const { deps, calls } = fakeDeps({ backend: () => null })
    const generateCmd = { ...cmd, generate: true }
    expect(await runOpen(generateCmd, io, deps)).toBe(1)
    expect(out_).toEqual([])
    expect(err_).toEqual(['limn: no Limn service is running — run `limn service install`'])
    expect(calls).not.toContain('serve')
  })

  it('server role: a --generate rejection stops the server it just started and returns 1', async () => {
    const io = fakeIo(true)
    let closed = false
    const { deps, opened } = fakeDeps({
      backend: () => null,
      // Mirrors production `runServe`: the outer promise only resolves on
      // SIGINT/SIGTERM, never merely because `close()` was called — the fix under
      // test must not depend on `serve`'s own promise settling.
      serve: async (_c, _io, onReady) => new Promise<number>(() => {
        onReady?.({
          port: 5466, url: 'http://limn.localhost:5466', vanity: false, aliasPort: null,
          close: async () => { closed = true }
        })
      })
    })
    const generateCmd = { ...cmd, generate: true }
    expect(await runOpen(generateCmd, io, deps)).toBe(1)
    expect(closed).toBe(true)
    expect(io.err_).toEqual(['limn: generation is not available on this server'])
    expect(opened).toEqual([])
  })
})

describe('issueRemote', () => {
  async function listen(): Promise<{ port: number; close(): void; seen: { auth?: string; type?: string; body: string }[] }> {
    const seen: { auth?: string; type?: string; body: string }[] = []
    const s = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += String(c) })
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, type: req.headers['content-type'], body })
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: { ticket: 'tkt' } }))
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    return { port: (s.address() as { port: number }).port, close: () => s.close(), seen }
  }

  it('sends the token as an Authorization header, not in the URL', async () => {
    const srv = await listen()
    const t: ServiceTarget = { host: '127.0.0.1', port: srv.port, token: 's3cret', url: `http://limn.localhost:${srv.port}` }
    expect(await issueRemote(t, { dir: '/repo' })).toEqual({ ticket: 'tkt' })
    expect(srv.seen[0]).toMatchObject({ auth: 'Bearer s3cret', type: 'application/json' })
    srv.close()
  })

  it('sends no Authorization header when there is no token perimeter', async () => {
    const srv = await listen()
    const t: ServiceTarget = { host: '127.0.0.1', port: srv.port, token: '', url: `http://limn.localhost:${srv.port}` }
    expect(await issueRemote(t, { dir: '/repo' })).toEqual({ ticket: 'tkt' })
    expect(srv.seen[0].auth).toBeUndefined()
    srv.close()
  })

  it('carries a --generate answer\'s path and note through', async () => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ value: { ticket: 'tkt', path: '/review/7', note: 'busy…' } }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as { port: number }).port
    const t: ServiceTarget = { host: '127.0.0.1', port, token: '', url: `http://limn.localhost:${port}` }
    expect(await issueRemote(t, { dir: '/repo' })).toEqual({ ticket: 'tkt', path: '/review/7', note: 'busy…' })
    s.close()
  })

  async function answering(status: number, type: string, body: string): Promise<{ port: number; close(): void }> {
    const s = http.createServer((_req, res) => { res.writeHead(status, { 'Content-Type': type }).end(body) })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    return { port: (s.address() as { port: number }).port, close: () => s.close() }
  }
  const targetOn = (port: number): ServiceTarget => ({ host: '127.0.0.1', port, token: '', url: `http://limn.localhost:${port}` })

  it('relays the server\'s JSON error message on a non-2xx answer', async () => {
    const srv = await answering(500, 'application/json', JSON.stringify({ error: '/repo is not inside a git repository' }))
    await expect(issueRemote(targetOn(srv.port), { dir: '/repo' })).rejects.toThrow('/repo is not inside a git repository')
    srv.close()
  })

  it('falls back to the status code when a non-2xx body is not JSON (a proxy page, a 401 text)', async () => {
    const srv = await answering(401, 'text/plain', 'unauthorized')
    await expect(issueRemote(targetOn(srv.port), { dir: '/repo' })).rejects.toThrow('cli:open failed (401)')
    srv.close()
  })

  it('rejects a 2xx answer that carries no ticket', async () => {
    const srv = await answering(200, 'application/json', JSON.stringify({ value: null }))
    await expect(issueRemote(targetOn(srv.port), { dir: '/repo' })).rejects.toThrow('cli:open failed (200)')
    srv.close()
  })
})
