import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { createChatThread, createSession } from '../src/server/db/sessions'
import { registerIpc, shutdownIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { releaseFakeHolds } from '../src/server/engines/fake'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, RefPair } from '../src/shared/types'
import type { LoadedReview, OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'

// Injection seam for "a post-outcome DB write throws": the sessions dao is mocked as a
// passthrough with one switchable landmine on addChatMessage, which every handler calls
// AFTER its operation outcome (generate's failure note, reportTurnFailure's agent note).
const daoHooks = vi.hoisted(() => ({ throwOnAddChatMessage: false }))
vi.mock('../src/server/db/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/db/sessions')>()
  return {
    ...actual,
    addChatMessage: (...args: Parameters<typeof actual.addChatMessage>) => {
      if (daoHooks.throwOnAddChatMessage) throw new Error('boom: post-outcome write failed')
      return actual.addChatMessage(...args)
    }
  }
})

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  results: OpResultMsg[]
  events: OpEventMsg[]
  sessionId: number
}

async function setup(): Promise<Harness> {
  const { dir } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ops-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const results: OpResultMsg[] = []
  const events: OpEventMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) {
      if (channel === 'op:result') results.push(msg as OpResultMsg)
      if (channel === 'op:event') events.push(msg as OpEventMsg)
    },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, results, events, sessionId }
}

/** Wait until the held generation has actually parked (its 'holding…' status
 *  streamed), so the load can't race the op's async setup. */
async function waitForHold(h: Harness, opId: string): Promise<void> {
  const start = Date.now()
  while (!h.events.some((e) => e.opId === opId && e.event.type === 'status' && e.event.text.startsWith('holding'))) {
    if (Date.now() - start > 10000) throw new Error(`op ${opId} never reached its hold`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => { process.env.LIMN_DEMO = '1' })
afterEach(() => { daoHooks.throwOnAddChatMessage = false; releaseFakeHolds(); shutdownIpc(); delete process.env.LIMN_DEMO })

describe('loadSession — activeOps', () => {
  it('reports an in-flight generation and clears it once the op finishes', async () => {
    const h = await setup()
    const loadSession = h.handlers.get('loadSession')!
    const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, false, '[hold]') as number

    const idle = await loadSession(h.sessionId) as LoadedReview
    expect(idle.activeOps).toEqual([])

    const gen = h.handlers.get('generate')!(h.sessionId, agent, 'op-gen', threadId, '[hold]', false)
    await waitForHold(h, 'op-gen')

    const during = await loadSession(h.sessionId) as LoadedReview
    expect(during.activeOps).toHaveLength(1)
    const [snap] = during.activeOps
    expect(snap.opId).toBe('op-gen')
    expect(snap.kind).toBe('review')
    expect(snap.threadId).toBe(threadId)
    expect(snap.exclusive).toBe(true)
    expect(snap.events.length).toBeGreaterThan(0)
    expect(snap.nextSeq).toBe(snap.events.length)
    expect(snap.events.at(-1)).toEqual({ type: 'status', text: 'holding…' })

    releaseFakeHolds()
    await gen
    expect(h.results.find((r) => r.opId === 'op-gen')!.status).toBe('succeeded')

    const after = await loadSession(h.sessionId) as LoadedReview
    expect(after.activeOps).toEqual([])
  })

  it('stamps every op:event of the generation with an increasing seq from 0', async () => {
    const h = await setup()
    const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, false, undefined) as number
    await h.handlers.get('generate')!(h.sessionId, agent, 'op-seq', threadId, undefined, false)

    const seqs = h.events.filter((e) => e.opId === 'op-seq').map((e) => e.seq)
    expect(seqs.length).toBeGreaterThan(1)
    expect(seqs).toEqual(seqs.map((_, i) => i))
  })

  it('retires the op even when a post-outcome DB write throws', async () => {
    const h = await setup()
    const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, false, '[hold]') as number
    const gen = h.handlers.get('generate')!(h.sessionId, agent, 'op-boom', threadId, '[hold]', false)
    await waitForHold(h, 'op-boom')

    // arm the landmine while the op is parked: the persist write inside the operation
    // fails it, then the failure branch's agent-note write throws OUT of the handler —
    // past sendOpResult, which is the only place liveOps.end used to live.
    daoHooks.throwOnAddChatMessage = true
    releaseFakeHolds()
    await expect(gen).rejects.toThrow(/boom/)
    expect(h.results.find((r) => r.opId === 'op-boom')).toBeUndefined() // no op:result went out
    daoHooks.throwOnAddChatMessage = false

    const after = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(after.activeOps).toEqual([]) // no phantom running op
  })

  it('cancel releases a parked generation so the op is retired', async () => {
    const h = await setup()
    const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, false, '[hold]') as number
    const gen = h.handlers.get('generate')!(h.sessionId, agent, 'op-cancel', threadId, '[hold]', false)
    await waitForHold(h, 'op-cancel')

    // without cancel releasing the park this await never settles (the test times out).
    await h.handlers.get('cancel')!('op-cancel')
    await gen

    expect(h.results.find((r) => r.opId === 'op-cancel')).toBeDefined()
    expect((await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview).activeOps).toEqual([])
  })

  it('a timed [hold:<ms>] generation ends by itself', async () => {
    const h = await setup()
    const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, false, '[hold:30]') as number
    // no releaseFakeHolds() anywhere: a served demo has no reach into the fake's holds.
    await h.handlers.get('generate')!(h.sessionId, agent, 'op-timed', threadId, '[hold:30]', false)

    expect(h.results.find((r) => r.opId === 'op-timed')!.status).toBe('succeeded')
    expect((await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview).activeOps).toEqual([])
  })
})

describe('loadSession — activeOps for chat turns', () => {
  it('reports each chat turn with its thread and the lane main actually chose', async () => {
    const h = await setup()
    const held = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    const asker = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    // op-excl takes the exclusive lane (repo idle) and parks holding it.
    const first = h.handlers.get('sendChat')!(held, '[hold] keep the repo busy', 'op-excl')
    await waitForHold(h, 'op-excl')
    // op-shared, fired while the exclusive lane is held, is coerced read-only onto the
    // shared lane — recorder.exclusive = false, which must reach the snapshot.
    const second = h.handlers.get('sendChat')!(asker, '[hold] me too', 'op-shared')
    await waitForHold(h, 'op-shared')

    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.activeOps.map((o) => o.opId).sort()).toEqual(['op-excl', 'op-shared'])
    expect(loaded.activeOps.find((o) => o.opId === 'op-excl')).toMatchObject({
      kind: 'chat', threadId: held, exclusive: true
    })
    expect(loaded.activeOps.find((o) => o.opId === 'op-shared')).toMatchObject({
      kind: 'chat', threadId: asker, exclusive: false
    })
    // the same lane the coerced turn's own event envelopes announce (recorder.exclusive)
    expect(h.events.filter((e) => e.opId === 'op-shared').map((e) => e.exclusive)).not.toContain(true)

    releaseFakeHolds()
    await Promise.all([first, second])
    expect((await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview).activeOps).toEqual([])
  })

  it('does not publish a live op for a turn rejected by the per-thread guard', async () => {
    const h = await setup()
    const thread = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    const first = h.handlers.get('sendChat')!(thread, '[hold] keep this thread busy', 'op-1')
    await waitForHold(h, 'op-1')
    await h.handlers.get('sendChat')!(thread, 'second client racing in', 'op-2')

    expect(h.results.find((r) => r.opId === 'op-2')!.status).toBe('failed')
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.activeOps.map((o) => o.opId)).toEqual(['op-1'])

    releaseFakeHolds()
    await first
  })
})
