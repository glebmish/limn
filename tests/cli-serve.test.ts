import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyBusyPort, runServe } from '../src/cli/serve'

function listen(handler: http.RequestListener): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }))
  })
}
const io = () => { const lines: string[] = []; return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), isTTY: false, ask: async () => false } } }

// runServe reads LIMN_DB (via defaultDbPath); leaking it would point every later test
// file in this worker at a stale temp database.
let savedDb: string | undefined
let tmpDirs: string[] = []
beforeEach(() => { savedDb = process.env.LIMN_DB; tmpDirs = [] })
afterEach(() => {
  if (savedDb === undefined) delete process.env.LIMN_DB
  else process.env.LIMN_DB = savedDb
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-serve-'))
  tmpDirs.push(dir)
  return path.join(dir, 'limn.db')
}

describe('serve', () => {
  it('classifies a Limn listener, a foreign listener, and a free port', async () => {
    const limn = await listen((_r, res) => res.end(JSON.stringify({ app: 'limn', version: '0', pid: 1, startedAt: '', port: 0 })))
    const other = await listen((_r, res) => res.end('nope'))
    expect(await classifyBusyPort(limn.port)).toBe('limn')
    expect(await classifyBusyPort(other.port)).toBe('other')
    const freePort = other.port; other.close(); await new Promise((r) => setTimeout(r, 50))
    expect(await classifyBusyPort(freePort)).toBe('free')
    limn.close()
  })
  it('exits 1 with the "already running" message when a Limn server holds the port', async () => {
    const limn = await listen((_r, res) => res.end(JSON.stringify({ app: 'limn', version: '0', pid: 1, startedAt: '', port: 0 })))
    const { lines, io: o } = io()
    process.env.LIMN_DB = tempDb()
    expect(await runServe({ port: limn.port, port80: false }, o)).toBe(1)
    expect(lines.join('\n')).toMatch(/already running .*limn service status/)
    limn.close()
  })
  it('exits 1 with the "another program" message for a foreign listener', async () => {
    const other = await listen((_r, res) => res.end('nope'))
    const { lines, io: o } = io()
    expect(await runServe({ port: other.port, port80: false }, o)).toBe(1)
    expect(lines.join('\n')).toMatch(/in use by another program.*--port/)
    other.close()
  })
})
