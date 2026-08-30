import { describe, it, expect } from 'vitest'
import { runOpen, type OpenDeps } from '../src/cli/open'
import type { Io } from '../src/cli/main'

const health = { app: 'limn' as const, version: '0.4.0', pid: 7, startedAt: new Date().toISOString(), port: 5466 }
const cmd = { kind: 'open' as const, dir: '/repo', hub: false, fresh: false, noService: false }

function fakeIo(answer = true): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [], err_: string[] = []
  return { out_, err_, isTTY: true, out: (l) => { out_.push(l) }, err: (l) => { err_.push(l) }, ask: async () => answer }
}

/** Every dep is a fake: no fs, no network, no child processes. `calls` records order. */
function fakeDeps(over: Partial<OpenDeps> = {}): { deps: OpenDeps; calls: string[]; opened: string[] } {
  const calls: string[] = [], opened: string[] = []
  const deps: OpenDeps = {
    probe: async () => null,
    issueRemote: async () => { calls.push('issueRemote'); return 'tkt' },
    install: async () => { calls.push('install'); return 0 },
    installed: async () => false,
    openBrowser: (url) => { calls.push('openBrowser'); opened.push(url) },
    readState: () => ({}),
    writeState: () => { calls.push('writeState') },
    npx: () => false,
    serve: async () => { calls.push('serve'); return 0 },
    findShim: () => null,
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

  it('a failed install propagates its exit code and opens nothing', async () => {
    const io = fakeIo(true)
    const { deps, calls } = fakeDeps({ install: async () => { calls.push('install'); return 3 } })
    expect(await runOpen(cmd, io, deps)).toBe(3)
    expect(calls).toEqual(['install'])
  })
})
