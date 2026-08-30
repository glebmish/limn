import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server/http'
import { makeFixtureRepo } from './helpers/fixtureRepo'

let running: RunningServer | null = null
afterEach(async () => { await running?.close(); running = null })

async function boot(): Promise<RunningServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
  running = await startServer({ port: 0, dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {} })
  return running
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
})
