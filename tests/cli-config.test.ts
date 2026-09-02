import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { runConfig, remoteStore, localStore, type ConfigDeps, type PrefsStore } from '../src/cli/config'
import type { ServiceTarget } from '../src/cli/target'
import type { Io } from '../src/cli/main'

const claude: ServiceTarget = { host: '127.0.0.1', port: 5466, token: '', url: 'http://limn.localhost:5466' }
const health = { app: 'limn' as const, version: '0.4.0', pid: 7, startedAt: new Date().toISOString(), port: 5466 }

function fakeIo(): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [], err_: string[] = []
  return { out_, err_, isTTY: false, out: (l) => { out_.push(l) }, err: (l) => { err_.push(l) }, ask: async () => false }
}

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-cli-config-'))
  return path.join(dir, 'limn.db')
}

function fakeStore(initial: Record<string, string> = {}): PrefsStore & { calls: string[]; data: Record<string, string> } {
  const data = { ...initial }
  const calls: string[] = []
  return {
    data, calls,
    get: async () => { calls.push('get'); return { ...data } },
    set: async (key, value) => { calls.push(`set:${key}`); data[key] = value }
  }
}

describe('runConfig', () => {
  function deps(over: Partial<ConfigDeps> = {}): ConfigDeps {
    return {
      target: () => claude,
      probe: async () => null,
      remote: () => { throw new Error('remote store should not be used') },
      local: () => fakeStore(),
      ...over
    }
  }

  it('probe healthy uses the remote store and never local', async () => {
    const remote = fakeStore()
    let localCalled = false
    const io = fakeIo()
    const code = await runConfig({ kind: 'config-list' }, io, deps({
      probe: async () => health,
      remote: () => remote,
      local: () => { localCalled = true; return fakeStore() }
    }))
    expect(code).toBe(0)
    expect(remote.calls).toEqual(['get'])
    expect(localCalled).toBe(false)
  })

  it('probe null uses the local store', async () => {
    const local = fakeStore()
    const io = fakeIo()
    const code = await runConfig({ kind: 'config-list' }, io, deps({ probe: async () => null, local: () => local }))
    expect(code).toBe(0)
    expect(local.calls).toEqual(['get'])
  })

  it('list prints three aligned lines', async () => {
    const io = fakeIo()
    const store = fakeStore({ defaultAgent: JSON.stringify({ engine: 'codex', model: 'gpt-5.5' }) })
    await runConfig({ kind: 'config-list' }, io, deps({ local: () => store }))
    expect(io.out_).toEqual(['agent   codex\nmodel   gpt-5.5\neffort  auto'])
  })

  it('get prints the bare value', async () => {
    const io = fakeIo()
    const store = fakeStore({ defaultAgent: JSON.stringify({ engine: 'codex', model: 'gpt-5.5' }) })
    await runConfig({ kind: 'config-get', key: 'model' }, io, deps({ local: () => store }))
    expect(io.out_).toEqual(['gpt-5.5'])
  })

  it('set writes the normalised JSON pref and re-prints the list', async () => {
    const io = fakeIo()
    const store = fakeStore()
    const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ local: () => store }))
    expect(code).toBe(0)
    expect(store.calls).toEqual(['get', 'set:defaultAgent'])
    expect(store.data.defaultAgent).toBe(JSON.stringify({ engine: 'codex' }))
    expect(io.out_).toEqual(['agent   codex\nmodel   auto\neffort  auto'])
  })

  it('set prints a note ahead of the list when the change drops a value', async () => {
    const io = fakeIo()
    const store = fakeStore({ defaultAgent: JSON.stringify({ engine: 'claude', model: 'opus', reasoningEffort: 'high' }) })
    await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ local: () => store }))
    expect(io.out_).toEqual([
      'note: model and effort reset to auto (not available for codex)',
      'agent   codex\nmodel   auto\neffort  auto'
    ])
  })

  it('an invalid set is rejected locally without writing', async () => {
    const io = fakeIo()
    const store = fakeStore()
    const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'nope' }, io, deps({ local: () => store }))
    expect(code).toBe(1)
    expect(store.calls).toEqual(['get'])
    expect(io.err_).toEqual(['limn: unknown engine "nope" (claude, codex)'])
  })

  it('a remote set rejection prints the error and returns 1', async () => {
    const io = fakeIo()
    const remote = fakeStore()
    remote.set = async () => { throw new Error('unknown model "bogus" for codex (gpt-5.5, gpt-5.4, gpt-5.4-mini)') }
    const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ probe: async () => health, remote: () => remote }))
    expect(code).toBe(1)
    expect(io.err_).toEqual(['limn: unknown model "bogus" for codex (gpt-5.5, gpt-5.4, gpt-5.4-mini)'])
  })

  describe('against a corrupt local db (real localStore, no service running)', () => {
    function corruptDb(): string {
      const dbPath = tmpDbPath()
      fs.writeFileSync(dbPath, 'not a sqlite file — garbage bytes to trip the integrity check')
      return dbPath
    }

    it('`config get` (read-only) rejects and leaves the corrupt file untouched', async () => {
      const io = fakeIo()
      const dbPath = corruptDb()
      const code = await runConfig({ kind: 'config-get', key: 'agent' }, io, deps({ local: () => localStore(io, dbPath) }))
      expect(code).toBe(1)
      expect(io.err_).toEqual(['limn: database at ' + dbPath + ' is corrupt; starting the Limn service will recover it (a backup of the corrupt file will be kept)'])
      expect(fs.existsSync(dbPath)).toBe(true)
      expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.corrupt-'))).toEqual([])
    })

    it('`config` (list, also read-only) rejects the same way', async () => {
      const io = fakeIo()
      const dbPath = corruptDb()
      const code = await runConfig({ kind: 'config-list' }, io, deps({ local: () => localStore(io, dbPath) }))
      expect(code).toBe(1)
      expect(io.err_[0]).toMatch(/is corrupt; starting the Limn service will recover it/)
      expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.corrupt-'))).toEqual([])
    })

    it('`config set` recovers the corrupt db (backup kept, note printed) and writes', async () => {
      const io = fakeIo()
      const dbPath = corruptDb()
      const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ local: () => localStore(io, dbPath) }))
      expect(code).toBe(0)
      expect(io.err_).toHaveLength(1)
      expect(io.err_[0]).toMatch(/^note: database was corrupt; a backup was kept at .*\.corrupt-\d+$/)
      expect(io.out_).toEqual(['agent   codex\nmodel   auto\neffort  auto'])
      expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.corrupt-'))).toHaveLength(1)
      // the write landed on the (fresh, recovered) db
      const reread = await localStore(io, dbPath).get()
      expect(JSON.parse(reread.defaultAgent)).toEqual({ engine: 'codex' })
    })
  })
})

describe('remoteStore', () => {
  /** A bare `/rpc/<channel>` server whose response is driven by `handler`, recording
   *  every request's channel, auth header and raw body (mirrors the pattern in
   *  tests/cli-open-run.test.ts's `issueRemote` suite). */
  async function listen(handler: (channel: string, args: unknown[]) => { status: number; body: unknown }): Promise<{ port: number; close(): void; seen: { auth?: string; channel: string; body: string }[] }> {
    const seen: { auth?: string; channel: string; body: string }[] = []
    const s = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += String(c) })
      req.on('end', () => {
        const channel = decodeURIComponent((req.url ?? '').slice('/rpc/'.length))
        seen.push({ auth: req.headers.authorization, channel, body: raw })
        const args = raw ? JSON.parse(raw) as unknown[] : []
        const { status, body } = handler(channel, args)
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    return { port: (s.address() as { port: number }).port, close: () => s.close(), seen }
  }
  const targetOn = (port: number, token = ''): ServiceTarget => ({ host: '127.0.0.1', port, token, url: `http://limn.localhost:${port}` })

  it('get calls getPrefs with [] and unwraps { value }', async () => {
    const srv = await listen(() => ({ status: 200, body: { value: { defaultAgent: '{"engine":"codex"}' } } }))
    expect(await remoteStore(targetOn(srv.port)).get()).toEqual({ defaultAgent: '{"engine":"codex"}' })
    expect(srv.seen[0]).toMatchObject({ channel: 'getPrefs', body: '[]' })
    srv.close()
  })

  it('get on a { value: null } answer (an empty prefs table) falls back to {}', async () => {
    const srv = await listen(() => ({ status: 200, body: { value: null } }))
    expect(await remoteStore(targetOn(srv.port)).get()).toEqual({})
    srv.close()
  })

  it('set calls setPref with [key, value] and sends the bearer token when the target has one', async () => {
    const srv = await listen((channel, args) => {
      expect(channel).toBe('setPref')
      expect(args).toEqual(['defaultAgent', '{"engine":"codex"}'])
      return { status: 200, body: { value: null } }
    })
    await remoteStore(targetOn(srv.port, 's3cret')).set('defaultAgent', '{"engine":"codex"}')
    expect(srv.seen[0].auth).toBe('Bearer s3cret')
    srv.close()
  })

  it('sends no Authorization header when there is no token perimeter', async () => {
    const srv = await listen(() => ({ status: 200, body: { value: null } }))
    await remoteStore(targetOn(srv.port)).set('a', 'b')
    expect(srv.seen[0].auth).toBeUndefined()
    srv.close()
  })

  it('a server-side rejection (a thrown setPref validation error) surfaces as that message', async () => {
    const srv = await listen(() => ({ status: 500, body: { error: 'unknown engine "nope" (claude, codex)' } }))
    await expect(remoteStore(targetOn(srv.port)).set('defaultAgent', '{"engine":"nope"}')).rejects.toThrow('unknown engine "nope" (claude, codex)')
    srv.close()
  })

  it('a non-JSON error body (a proxy 401 page) falls back to the channel + status', async () => {
    const s = http.createServer((_req, res) => { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized') })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as { port: number }).port
    await expect(remoteStore(targetOn(port)).get()).rejects.toThrow('getPrefs failed (401)')
    s.close()
  })
})

describe('localStore', () => {
  it('get on a fresh db is {}; set then get round-trips the normalised JSON', async () => {
    const io = fakeIo()
    const store = localStore(io, tmpDbPath())
    expect(await store.get()).toEqual({})
    await store.set('defaultAgent', JSON.stringify({ engine: 'claude', model: 'opus' }))
    expect(await store.get()).toEqual({ defaultAgent: JSON.stringify({ engine: 'claude', model: 'opus' }) })
    expect(io.err_).toEqual([])
  })

  it('normalises the written defaultAgent value through validateAgentRef (drops unknown extras)', async () => {
    const io = fakeIo()
    const store = localStore(io, tmpDbPath())
    await store.set('defaultAgent', JSON.stringify({ engine: 'claude', model: 'opus', bogusExtra: 1 }))
    expect(await store.get()).toEqual({ defaultAgent: JSON.stringify({ engine: 'claude', model: 'opus' }) })
  })

  it('rejects an invalid defaultAgent value with the validator message and writes nothing', async () => {
    const io = fakeIo()
    const store = localStore(io, tmpDbPath())
    await expect(store.set('defaultAgent', JSON.stringify({ engine: 'nope' }))).rejects.toThrow('unknown engine "nope" (claude, codex)')
    expect(await store.get()).toEqual({})
  })

  it('rejects invalid JSON for defaultAgent and writes nothing', async () => {
    const io = fakeIo()
    const store = localStore(io, tmpDbPath())
    await expect(store.set('defaultAgent', 'not json')).rejects.toThrow('invalid JSON for defaultAgent')
    expect(await store.get()).toEqual({})
  })

  it('a non-defaultAgent key is written as-is, no validation', async () => {
    const io = fakeIo()
    const store = localStore(io, tmpDbPath())
    await store.set('engine.claude.path', '/usr/local/bin/claude')
    expect(await store.get()).toEqual({ 'engine.claude.path': '/usr/local/bin/claude' })
  })

  it('reuses one handle across calls on the same store — a second call still works', async () => {
    const io = fakeIo()
    const dbPath = tmpDbPath()
    const store = localStore(io, dbPath)
    await store.set('a', '1')
    await store.set('b', '2')
    expect(await store.get()).toEqual({ a: '1', b: '2' })
  })

  it('a `config set` flow (get then write) opens the db only once', async () => {
    const io = fakeIo()
    const dbPath = tmpDbPath()
    const store = localStore(io, dbPath)
    // openDb() calls fs.mkdirSync exactly once per open — a reliable proxy for
    // "how many times was the db actually opened" without reaching into internals.
    const spy = vi.spyOn(fs, 'mkdirSync')
    const before = spy.mock.calls.length
    expect(await store.get()).toEqual({})
    await store.set('a', '1')
    expect(spy.mock.calls.length - before).toBe(1)
    spy.mockRestore()
  })

  it('get() defaults to recover: false — rejects with a message that does not promise a bogus remedy', async () => {
    const io = fakeIo()
    const dbPath = tmpDbPath()
    fs.writeFileSync(dbPath, 'not a sqlite file — garbage bytes to trip the integrity check')
    const store = localStore(io, dbPath)
    await expect(store.get()).rejects.toThrow(/corrupt.*starting the Limn service will recover it/)
    expect(fs.existsSync(dbPath)).toBe(true)
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('not a sqlite file — garbage bytes to trip the integrity check')
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.corrupt-'))).toEqual([])
    expect(io.err_).toEqual([])
  })

  it('get({ recover: true }) recovers a corrupt db (moves it aside) and reports it', async () => {
    const io = fakeIo()
    const dbPath = tmpDbPath()
    fs.writeFileSync(dbPath, 'not a sqlite file — garbage bytes to trip the integrity check')
    const store = localStore(io, dbPath)
    expect(await store.get({ recover: true })).toEqual({})
    expect(io.err_).toHaveLength(1)
    expect(io.err_[0]).toMatch(/^note: database was corrupt; a backup was kept at .*\.corrupt-\d+$/)
  })

  it('a write still recovers a corrupt db (moves it aside) and reports it', async () => {
    const io = fakeIo()
    const dbPath = tmpDbPath()
    fs.writeFileSync(dbPath, 'not a sqlite file — garbage bytes to trip the integrity check')
    const store = localStore(io, dbPath)
    await store.set('a', '1')
    expect(await store.get({ recover: true })).toEqual({ a: '1' })
    expect(io.err_).toHaveLength(1)
    expect(io.err_[0]).toMatch(/^note: database was corrupt; a backup was kept at .*\.corrupt-\d+$/)
  })
})
