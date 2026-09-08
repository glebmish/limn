import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/server/db/db'
import { createSession, createChatThread, getChatThread, loadReviewState, updateSessionMeta, upsertComment } from '../src/server/db/sessions'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { releaseFakeHolds } from '../src/server/engines/fake'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, RefPair, ReviewAnnotations } from '../src/shared/types'
import type { LoadedReview, OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-cc-')), 'db')).db
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

beforeEach(() => { process.env.LIMN_DEMO = '1' })
afterEach(() => { releaseFakeHolds(); delete process.env.LIMN_DEMO })

/** Wait until the `[hold]` turn has actually parked (its 'holding…' status event
 *  streamed), so releases/asserts can't race the turn's async setup. */
async function waitForHold(h: Harness, opId: string): Promise<void> {
  const start = Date.now()
  while (!h.events.some((e) => e.opId === opId && e.event.type === 'status' && e.event.text.startsWith('holding'))) {
    if (Date.now() - start > 10000) throw new Error(`op ${opId} never reached its hold`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('one task queue per repo — a turn behind a busy repo waits, then runs', () => {
  it('queues a chat while another op holds the lane, announces its place, and runs it after', async () => {
    const h = await setup()
    const held = createChatThread(h.db, h.sessionId, { kind: 'user', agent, title: 'First' }).id
    const asker = createChatThread(h.db, h.sessionId, { kind: 'user', agent, title: 'Second' }).id

    // op-1 takes the lane (repo idle) and parks holding it.
    const holding = h.handlers.get('sendChat')!(held, '[hold] keep the repo busy', 'op-1')
    await waitForHold(h, 'op-1')
    // op-2, fired while op-1 holds the lane, waits its turn — it must NOT complete
    // (or run read-only) while op-1 is still holding.
    const waiting = h.handlers.get('sendChat')!(asker, 'what does this touch?', 'op-2')
    await new Promise((r) => setTimeout(r, 50))
    expect(h.results.some((r) => r.opId === 'op-2')).toBe(false)
    const queuedEv = h.events.filter((e) => e.opId === 'op-2').map((e) => e.event)
    expect(queuedEv).toContainEqual({ type: 'lane', state: 'queued', position: 1, behind: 'First' })
    // …and it is visible as queued in a (re)joining tab's snapshot
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.activeOps.find((o) => o.opId === 'op-2')).toMatchObject({ label: 'Second', queued: { position: 1, behind: 'First' } })
    expect(loaded.activeOps.find((o) => o.opId === 'op-1')).toMatchObject({ label: 'First' })
    expect(loaded.activeOps.find((o) => o.opId === 'op-1')!.queued).toBeUndefined()

    releaseFakeHolds()
    await holding
    await waiting
    expect(h.results.find((r) => r.opId === 'op-1')!.status).toBe('succeeded')
    expect(h.results.find((r) => r.opId === 'op-2')!.status).toBe('succeeded')
    const op2 = h.events.filter((e) => e.opId === 'op-2').map((e) => e.event)
    expect(op2).toContainEqual({ type: 'lane', state: 'running' })
    // no read-only coercion anywhere — the turn ran at its own tier on the lane
    expect(op2.some((e) => e.type === 'status' && /read-only/i.test(e.text))).toBe(false)
    expect(h.events.filter((e) => e.opId === 'op-2').every((e) => e.exclusive === true)).toBe(true)
  })

  it('a plain chat on an idle repo takes the lane at once (no lane events, no waiting)', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    await h.handlers.get('sendChat')!(t, 'ordinary question', 'op-solo')
    const res = h.results.find((r) => r.opId === 'op-solo')!
    expect(res.status).toBe('succeeded')
    const evs = h.events.filter((e) => e.opId === 'op-solo').map((e) => e.event)
    expect(evs.some((e) => e.type === 'lane')).toBe(false)
  })

  it('cancelling a queued turn removes it from the queue; the turn behind it moves up', async () => {
    const h = await setup()
    const held = createChatThread(h.db, h.sessionId, { kind: 'user', agent, title: 'First' }).id
    const a = createChatThread(h.db, h.sessionId, { kind: 'user', agent, title: 'A' }).id
    const b = createChatThread(h.db, h.sessionId, { kind: 'user', agent, title: 'B' }).id
    const holding = h.handlers.get('sendChat')!(held, '[hold] keep the repo busy', 'op-1')
    await waitForHold(h, 'op-1')
    const pa = h.handlers.get('sendChat')!(a, 'a', 'op-a')
    const pb = h.handlers.get('sendChat')!(b, 'b', 'op-b')
    await new Promise((r) => setTimeout(r, 30))
    expect(h.events.filter((e) => e.opId === 'op-b').map((e) => e.event)).toContainEqual({ type: 'lane', state: 'queued', position: 2, behind: 'First' })
    await h.handlers.get('cancel')!('op-a')
    await pa
    expect(h.results.find((r) => r.opId === 'op-a')!.status).toBe('cancelled')
    expect(h.events.filter((e) => e.opId === 'op-b').map((e) => e.event)).toContainEqual({ type: 'lane', state: 'queued', position: 1, behind: 'First' })
    releaseFakeHolds()
    await holding
    await pb
    expect(h.results.find((r) => r.opId === 'op-b')!.status).toBe('succeeded')
  })
})

describe('one task queue per repo — a chat turn behind a generation edits the review only after it', () => {
  const annotations: ReviewAnnotations = {
    title: 'Generated title', summary: 'Generated summary', sections: [], questions: []
  }

  it('waits for the generation, then edits the review it produced (nothing is silently lost)', async () => {
    const h = await setup()
    updateSessionMeta(h.db, h.sessionId, { annotations })
    const asker = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    const reviewThread = await h.handlers.get('beginReview')!(h.sessionId, agent, false, '[hold]') as number
    const gen = h.handlers.get('generate')!(h.sessionId, agent, 'op-gen', reviewThread, '[hold]', false)
    await waitForHold(h, 'op-gen')

    const chat = h.handlers.get('sendChat')!(asker, '[edit-review] tighten the summary', 'op-chat')
    await new Promise((r) => setTimeout(r, 30))
    expect(h.results.some((r) => r.opId === 'op-chat')).toBe(false)
    expect(h.events.filter((e) => e.opId === 'op-chat').map((e) => e.event)).toContainEqual({ type: 'lane', state: 'queued', position: 1, behind: 'Generating the review' })

    releaseFakeHolds()
    await gen
    await chat
    expect(h.results.find((r) => r.opId === 'op-gen')!.status).toBe('succeeded')
    expect(h.results.find((r) => r.opId === 'op-chat')!.status).toBe('succeeded')
    // the edit landed on the generation's output, and the turn shows its chip
    expect(loadReviewState(h.db, h.sessionId).annotations!.summary).toBe('Edited by the chat turn.')
    const turn = getChatThread(h.db, asker)!.messages.at(-1)!
    expect((turn.actions ?? []).some((a) => a.kind === 'review_edited')).toBe(true)
  })

  it('the same turn on an idle repo edits the review at once', async () => {
    const h = await setup()
    updateSessionMeta(h.db, h.sessionId, { annotations })
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    await h.handlers.get('sendChat')!(t, '[edit-review] tighten the summary', 'op-solo')
    expect(h.results.find((r) => r.opId === 'op-solo')!.status).toBe('succeeded')
    expect(loadReviewState(h.db, h.sessionId).annotations!.summary).toBe('Edited by the chat turn.')
    const turn = getChatThread(h.db, t)!.messages.at(-1)!
    expect((turn.actions ?? []).some((a) => a.kind === 'review_edited')).toBe(true)
  })
})

describe('concurrent chat — per-thread guard', () => {
  it('a second concurrent send to the SAME thread fails fast; the first is unaffected', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    // op-1 parks holding the thread; op-2 targets the same thread concurrently.
    const holding = h.handlers.get('sendChat')!(t, '[hold] first turn', 'op-1')
    await waitForHold(h, 'op-1')
    await h.handlers.get('sendChat')!(t, 'second turn racing the first', 'op-2')

    const res2 = h.results.find((r) => r.opId === 'op-2')!
    expect(res2.status).toBe('failed')
    expect(res2.error).toContain('A turn is already running in this chat')
    expect(res2.errorCode).toBeUndefined()
    // the rejection is result-only: no agent note interleaved into the live thread,
    // and the second user message was never persisted.
    expect(getChatThread(h.db, t)!.messages).toHaveLength(1)
    // the first turn is unaffected — still holding, then completes normally.
    expect(h.results.some((r) => r.opId === 'op-1')).toBe(false)
    releaseFakeHolds()
    await holding
    expect(h.results.find((r) => r.opId === 'op-1')!.status).toBe('succeeded')
    expect(getChatThread(h.db, t)!.messages.map((m) => m.role)).toEqual(['user', 'agent'])
  })

  it('sendBatch to a thread with a chat turn in flight fails fast with the thread-busy copy', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    const holding = h.handlers.get('sendChat')!(t, '[hold] first turn', 'op-1')
    await waitForHold(h, 'op-1')
    await h.handlers.get('sendBatch')!(t, [], '[steer only]', 'op-b')

    const resB = h.results.find((r) => r.opId === 'op-b')!
    expect(resB.status).toBe('failed')
    expect(resB.error).toContain('A turn is already running in this chat')

    releaseFakeHolds()
    await holding
    expect(h.results.find((r) => r.opId === 'op-1')!.status).toBe('succeeded')
  })
})

describe('concurrent chat — sendBatch rollback', () => {
  it('a rejected batch does not un-send the comments the in-flight batch is working', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    upsertComment(h.db, h.sessionId, {
      id: 'c1', author: 'user', text: 'rename this', status: 'queued', replies: [], iteration: 1,
      createdAt: new Date().toISOString(),
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@ -1 +1 @@', lineContent: 'x' }
    })

    // op-1 takes the thread and parks mid-turn with c1 marked 'sent'
    const holding = h.handlers.get('sendBatch')!(t, ['c1'], '[hold] first batch', 'op-1')
    await waitForHold(h, 'op-1')
    expect(loadReviewState(h.db, h.sessionId).comments[0].status).toBe('sent')

    // a second client re-sends the same comment: rejected by the per-thread guard
    // BEFORE the body ran, so it must leave op-1's 'sent' marks alone.
    await h.handlers.get('sendBatch')!(t, ['c1'], 'racing batch', 'op-2')
    const res2 = h.results.find((r) => r.opId === 'op-2')!
    expect(res2.status).toBe('failed')
    expect(res2.error).toContain('A turn is already running in this chat') // the ThreadBusy path
    expect(loadReviewState(h.db, h.sessionId).comments[0].status).toBe('sent')

    releaseFakeHolds()
    await holding
    expect(h.results.find((r) => r.opId === 'op-1')!.status).toBe('succeeded')
  })
})
