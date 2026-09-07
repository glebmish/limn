import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/server/db/db'
import { createSession, createChatThread, getChatThread, loadReviewState, updateSessionMeta, upsertComment } from '../src/server/db/sessions'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { releaseFakeHolds } from '../src/server/engines/fake'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, RefPair, ReviewAnnotations } from '../src/shared/types'
import type { OpEventMsg, OpResultMsg } from '../src/shared/ipc'
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

describe('concurrent chat — two-lane routing', () => {
  it('runs a chat read-only on the shared lane while another op holds the exclusive lane', async () => {
    const h = await setup()
    const held = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    const asker = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    // op-1 takes the exclusive lane (repo idle) and parks holding it.
    const holding = h.handlers.get('sendChat')!(held, '[hold] keep the repo busy', 'op-1')
    // op-2, fired while op-1 holds the exclusive lane, must route to the shared lane
    // forced read-only — and complete without waiting for op-1.
    await h.handlers.get('sendChat')!(asker, 'what does this touch?', 'op-2')

    const res2 = h.results.find((r) => r.opId === 'op-2')!
    expect(res2.status).toBe('succeeded')
    const op2Events = h.events.filter((e) => e.opId === 'op-2').map((e) => e.event)
    expect(op2Events).toContainEqual({ type: 'status', text: 'Read-only turn — a review is generating' })

    // op-1 is still holding — it has not produced a result yet.
    expect(h.results.some((r) => r.opId === 'op-1')).toBe(false)

    releaseFakeHolds()
    await holding
    expect(h.results.find((r) => r.opId === 'op-1')!.status).toBe('succeeded')
  })

  it('a plain chat on an idle repo takes the exclusive lane at full tier (no read-only coercion)', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    await h.handlers.get('sendChat')!(t, 'ordinary question', 'op-solo')
    const res = h.results.find((r) => r.opId === 'op-solo')!
    expect(res.status).toBe('succeeded')
    const evs = h.events.filter((e) => e.opId === 'op-solo').map((e) => e.event)
    expect(evs).not.toContainEqual({ type: 'status', text: 'Read-only turn — a review is generating' })
  })

  it('announces the lane main actually chose on op:event envelopes and the op:result (OQ7)', async () => {
    const h = await setup()
    const held = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    const asker = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    const holding = h.handlers.get('sendChat')!(held, '[hold] keep the repo busy', 'op-x')
    await waitForHold(h, 'op-x')
    await h.handlers.get('sendChat')!(asker, 'what does this touch?', 'op-s')

    // the shared turn is announced exclusive:false on every event + the result…
    const sharedEvents = h.events.filter((e) => e.opId === 'op-s')
    expect(sharedEvents.length).toBeGreaterThan(0)
    expect(sharedEvents.every((e) => e.exclusive === false)).toBe(true)
    expect(h.results.find((r) => r.opId === 'op-s')!.exclusive).toBe(false)

    releaseFakeHolds()
    await holding
    // …and the exclusive-lane turn is announced exclusive:true.
    const heldEvents = h.events.filter((e) => e.opId === 'op-x')
    expect(heldEvents.length).toBeGreaterThan(0)
    expect(heldEvents.every((e) => e.exclusive === true)).toBe(true)
    expect(h.results.find((r) => r.opId === 'op-x')!.exclusive).toBe(true)
  })
})

describe('concurrent chat — the shared lane never rewrites the review', () => {
  const annotations: ReviewAnnotations = {
    title: 'Generated title', summary: 'Generated summary', sections: [], questions: []
  }

  it('withholds edit_review from a shared-lane turn while a generation holds the exclusive lane', async () => {
    const h = await setup()
    updateSessionMeta(h.db, h.sessionId, { annotations })
    const asker = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id

    // a generation takes the exclusive lane and parks mid-pass, holding the
    // annotations snapshot it will persist when it finishes.
    const reviewThread = await h.handlers.get('beginReview')!(h.sessionId, agent, false, '[hold]') as number
    const gen = h.handlers.get('generate')!(h.sessionId, agent, 'op-gen', reviewThread, '[hold]', false)
    await waitForHold(h, 'op-gen')

    // a chat turn routed to the shared lane asks the agent to amend the review
    await h.handlers.get('sendChat')!(asker, '[edit-review] tighten the summary', 'op-chat')
    expect(h.results.find((r) => r.opId === 'op-chat')!.status).toBe('succeeded')

    // the edit never reached the blob the generation is about to overwrite…
    expect(loadReviewState(h.db, h.sessionId).annotations!.summary).toBe('Generated summary')
    // …the agent was told why (refused with an explanation, not silently dropped)…
    const chatEvents = h.events.filter((e) => e.opId === 'op-chat').map((e) => e.event)
    expect(chatEvents.some((e) =>
      e.type === 'status' && e.text.includes('edit_review is unavailable on this turn: another review operation holds this repo')
    )).toBe(true)
    // …and the turn shows no "edited the review" chip for an edit that did not happen
    const turn = getChatThread(h.db, asker)!.messages.at(-1)!
    expect((turn.actions ?? []).some((a) => a.kind === 'review_edited')).toBe(false)

    releaseFakeHolds()
    await gen
    expect(h.results.find((r) => r.opId === 'op-gen')!.status).toBe('succeeded')
  })

  it('the same turn on the exclusive lane (idle repo) still edits the review', async () => {
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
