import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import {
  issueCliOpen, takeCliOpen, setGenerationKicker, _resetTickets, _ticketCount
} from '../src/server/cliOpen'
import type { KickArgs } from '../src/server/cliOpen'
import { makeFixtureRepo } from './helpers/fixtureRepo'

afterEach(() => { vi.useRealTimers(); setGenerationKicker(null) })

describe('cli:open tickets', () => {
  it('issues a ticket whose message resolves the repo root and carries the refs', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir, base: 'main', compare: 'feature', hub: false, fresh: true })
    expect(ticket).toMatch(/^[0-9a-f]{32}$/)
    // repoRoot returns git's realpath (/private/var vs /var on macOS)
    expect(takeCliOpen(ticket)).toEqual({ repo: fs.realpathSync(fx.dir), baseInput: 'main', compareInput: 'feature', hub: false, fresh: true })
  })
  it('a ticket is single-use', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir })
    expect(takeCliOpen(ticket)).not.toBeNull()
    expect(takeCliOpen(ticket)).toBeNull()
  })
  it('a non-git dir yields an error message the UI can show', async () => {
    _resetTickets()
    const { ticket } = await issueCliOpen({ dir: '/' })
    expect(takeCliOpen(ticket)).toEqual({ error: '/ is not inside a git repository' })
  })
  it('unknown tickets are null', () => {
    _resetTickets()
    expect(takeCliOpen('nope')).toBeNull()
  })
  it('a ticket expires after its 60s TTL', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_001)
    expect(takeCliOpen(ticket)).toBeNull()
  })
  it('issuing a ticket sweeps out expired ones (an unredeemed backlog cannot grow)', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    await issueCliOpen({ dir: fx.dir })
    await issueCliOpen({ dir: fx.dir })
    expect(_ticketCount()).toBe(2)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_001)
    await issueCliOpen({ dir: fx.dir })
    expect(_ticketCount()).toBe(1)
  })
  it('a --print-url ticket outlives the 60s TTL (a scripted open redeems it much later)', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir, printUrl: true })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    expect(takeCliOpen(ticket)).not.toBeNull()

    const second = (await issueCliOpen({ dir: fx.dir, printUrl: true })).ticket
    vi.setSystemTime(Date.now() + 601_000)
    expect(takeCliOpen(second)).toBeNull()
  })
})

describe('cli:open --generate', () => {
  it('rejects when no generation kicker is installed', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    setGenerationKicker(null)
    await expect(issueCliOpen({ dir: fx.dir, generate: true }))
      .rejects.toThrow('generation is not available on this server')
  })

  it('hands the kicker the resolved repo + refs and answers with the durable path', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const seen: KickArgs[] = []
    setGenerationKicker(async (args) => { seen.push(args); return { sessionId: 7 } })

    const result = await issueCliOpen({
      dir: fx.dir, base: 'main', compare: 'feature', fresh: true,
      generate: true, agent: { engine: 'codex', model: 'gpt-5.5' }
    })

    expect(result.path).toBe('/review/7')
    expect(result.note).toBeUndefined()
    expect(result.ticket).toMatch(/^[0-9a-f]{32}$/)
    expect(seen).toEqual([{
      // repoRoot returns git's realpath (/private/var vs /var on macOS)
      repo: fs.realpathSync(fx.dir), base: 'main', compare: 'feature', fresh: true,
      agent: { engine: 'codex', model: 'gpt-5.5' }
    }])
  })

  it("passes the kicker's note through to the CLI", async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    setGenerationKicker(async () => ({ sessionId: 3, note: 'a review is already generating for this repository — opening this review' }))

    const result = await issueCliOpen({ dir: fx.dir, generate: true })
    expect(result).toMatchObject({
      path: '/review/3', note: 'a review is already generating for this repository — opening this review'
    })
  })

  it('propagates a kicker rejection verbatim', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    setGenerationKicker(async () => { throw new Error('reasoning effort needs a model (set a model first)') })

    await expect(issueCliOpen({ dir: fx.dir, generate: true }))
      .rejects.toThrow('reasoning effort needs a model (set a model first)')
  })

  it('refuses to generate outside a git repository (no ticket, a plain error)', async () => {
    _resetTickets()
    setGenerationKicker(async () => ({ sessionId: 1 }))
    await expect(issueCliOpen({ dir: '/', generate: true }))
      .rejects.toThrow('/ is not inside a git repository')
    expect(_ticketCount()).toBe(0)
  })

  it('a plain open never reaches the kicker', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    let calls = 0
    setGenerationKicker(async () => { calls++; return { sessionId: 1 } })
    const result = await issueCliOpen({ dir: fx.dir })
    expect(calls).toBe(0)
    expect(result.path).toBeUndefined()
  })
})
