import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { createSession } from '../src/server/db/sessions'
import { registerIpc, shutdownIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { releaseFakeHolds } from '../src/server/engines/fake'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, RefPair } from '../src/shared/types'
import type { LoadedReview, OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
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
  return { handlers, results, events, sessionId }
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
afterEach(() => { releaseFakeHolds(); shutdownIpc(); delete process.env.LIMN_DEMO })

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
})
