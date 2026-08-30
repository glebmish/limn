import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyBusyPort, runServe, startFailureMessage } from '../src/cli/serve'

function listen(handler: http.RequestListener): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }))
  })
}
const io = () => { const lines: string[] = []; return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), isTTY: false, ask: async () => false } } }

// runServe reads LIMN_DB (via defaultDbPath) and the LIMN_* web vars; leaking any of
// them would misdirect every later test file in this worker.
const ENV = ['LIMN_DB', 'LIMN_WEB_HOST', 'LIMN_WEB_PORT', 'LIMN_PORT'] as const
const saved: Record<string, string | undefined> = {}
let tmpDirs: string[] = []
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] } tmpDirs = [] })
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
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

  // 203.0.113.0/24 is TEST-NET-3: never assigned to a local interface, so binding it
  // fails EADDRNOTAVAIL — which is "this address isn't yours", not "port taken".
  it('classifies an unassigned LIMN_WEB_HOST as unavailable, not "in use"', async () => {
    process.env.LIMN_WEB_HOST = '203.0.113.7'
    expect(await classifyBusyPort(45999)).toBe('unavailable')
    const { lines, io: o } = io()
    expect(await runServe({ port: 45999, port80: false }, o)).toBe(1)
    expect(lines.join('\n')).toMatch(/LIMN_WEB_HOST/)
    expect(lines.join('\n')).not.toMatch(/another program/)
  })

  it('turns a raw bind failure into the same friendly message the pre-check gives', () => {
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:5466'), { code: 'EADDRINUSE' })
    expect(startFailureMessage(err, 5466)).toMatch(/port 5466 is in use by another program.*--port/)
    const noAddr = Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })
    expect(startFailureMessage(noAddr, 5466)).toMatch(/LIMN_WEB_HOST/)
    expect(startFailureMessage(new Error('boom'), 5466)).toBe('boom')
  })

  it('warns when LIMN_WEB_PORT is set — the variable Limn reads is LIMN_PORT', async () => {
    process.env.LIMN_WEB_PORT = '5999'
    const limn = await listen((_r, res) => res.end(JSON.stringify({ app: 'limn', version: '0', pid: 1, startedAt: '', port: 0 })))
    const { lines, io: o } = io()
    expect(await runServe({ port: limn.port, port80: false }, o)).toBe(1)
    expect(lines.join('\n')).toMatch(/LIMN_WEB_PORT is not read.*LIMN_PORT/)
    limn.close()
  })
})
