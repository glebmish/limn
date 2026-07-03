import { describe, it, expect } from 'vitest'
import { opForThread, reviewOp, anyExclusiveRunning, anyRunning, anySharedRunning, chatSendBlocked, willRunReadOnly } from '../src/renderer/store'
import type { OpState } from '../src/renderer/store'
import type { LoadedReview } from '../src/shared/ipc'

const op = (over: Partial<OpState>): OpState => ({
  running: true, opId: 'op', kind: 'chat', threadId: 1, log: [], error: null,
  startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: true, ...over,
})
const opsOf = (...list: OpState[]): Record<string, OpState> => Object.fromEntries(list.map((o, i) => [o.opId ?? `op${i}`, o]))
const loaded = (ids: number[]): LoadedReview => ({ state: { chats: ids.map((id) => ({ id })) } } as unknown as LoadedReview)

describe('concurrent-chat selectors', () => {
  it('opForThread finds the op streaming into a thread, else IDLE', () => {
    const ops = opsOf(op({ opId: 'a', threadId: 7 }))
    expect(opForThread(ops, 7).opId).toBe('a')
    expect(opForThread(ops, 8).running).toBe(false)
    expect(opForThread(ops, null).running).toBe(false)
  })

  it('opForThread prefers the RUNNING op when a finished one lingers on the same thread', () => {
    // a running op survives a startOp on its thread (update-generation reusing the
    // review thread under a streaming chat) — the running one must win.
    const done = op({ opId: 'done', threadId: 7, running: false, outcome: 'succeeded', startedAt: 100 })
    const live = op({ opId: 'live', threadId: 7, running: true, startedAt: 50 })
    expect(opForThread(opsOf(done, live), 7).opId).toBe('live')
    expect(opForThread(opsOf(live, done), 7).opId).toBe('live') // insertion order irrelevant
  })

  it('opForThread falls back to the most recently started among finished ops', () => {
    const older = op({ opId: 'older', threadId: 7, running: false, outcome: 'succeeded', startedAt: 10 })
    const newer = op({ opId: 'newer', threadId: 7, running: false, outcome: 'failed', startedAt: 20 })
    expect(opForThread(opsOf(older, newer), 7).opId).toBe('newer')
    expect(opForThread(opsOf(newer, older), 7).opId).toBe('newer')
  })

  it('reviewOp returns only a review-kind op whose thread belongs to the loaded review', () => {
    const gen = op({ opId: 'g', kind: 'review', threadId: 3 })
    const chat = op({ opId: 'c', kind: 'chat', threadId: 4, exclusive: false })
    const ops = opsOf(gen, chat)
    expect(reviewOp(ops, loaded([3, 4])).opId).toBe('g')   // the review op, not the chat op
    expect(reviewOp(ops, loaded([4])).running).toBe(false) // review thread not in this review
  })

  it('reviewOp prefers a RUNNING generation over a stale finished one (regenerate case)', () => {
    // after a fresh regenerate, the old review thread persists and the finished op-A
    // is never pruned — it must not shadow the running op-B's progress/cancel state.
    const finished = op({ opId: 'A', kind: 'review', threadId: 3, running: false, outcome: 'succeeded', startedAt: 100 })
    const running = op({ opId: 'B', kind: 'review', threadId: 5, running: true, startedAt: 200 })
    expect(reviewOp(opsOf(finished, running), loaded([3, 5])).opId).toBe('B')
    expect(reviewOp(opsOf(running, finished), loaded([3, 5])).opId).toBe('B') // insertion order irrelevant
    // among finished generations, the most recently started wins
    const older = op({ opId: 'old', kind: 'review', threadId: 3, running: false, outcome: 'succeeded', startedAt: 10 })
    const newer = op({ opId: 'new', kind: 'review', threadId: 5, running: false, outcome: 'cancelled', startedAt: 20 })
    expect(reviewOp(opsOf(older, newer), loaded([3, 5])).opId).toBe('new')
  })

  it('anyExclusiveRunning / anySharedRunning / anyRunning split by lane', () => {
    const gen = op({ opId: 'g', kind: 'review', threadId: 3, exclusive: true })
    const shared = op({ opId: 's', threadId: 4, exclusive: false })
    expect(anyExclusiveRunning(opsOf(gen, shared))).toBe(true)
    expect(anySharedRunning(opsOf(gen, shared))).toBe(true)
    expect(anyExclusiveRunning(opsOf(shared))).toBe(false) // only a shared op runs
    expect(anySharedRunning(opsOf(gen))).toBe(false)
    expect(anyRunning({})).toBe(false)
    // finished ops don't count as running
    expect(anyExclusiveRunning(opsOf(op({ running: false })))).toBe(false)
  })

  it('chatSendBlocked: target-thread busy → blocked; idle repo → allowed; shared full → blocked', () => {
    // target thread already streaming
    expect(chatSendBlocked(opsOf(op({ opId: 'a', threadId: 5 })), 5)).toBe(true)
    // repo idle → a new chat takes the exclusive lane, allowed
    expect(chatSendBlocked({}, 9)).toBe(false)
    // exclusive op runs + shared lane free → the new chat routes shared, allowed
    expect(chatSendBlocked(opsOf(op({ opId: 'g', kind: 'review', threadId: 3, exclusive: true })), 9)).toBe(false)
    // exclusive op runs + shared lane already occupied → blocked (cap one)
    const full = opsOf(op({ opId: 'g', kind: 'review', threadId: 3, exclusive: true }), op({ opId: 's', threadId: 4, exclusive: false }))
    expect(chatSendBlocked(full, 9)).toBe(true)
  })

  it('willRunReadOnly: sendable turn under a running exclusive op → coerced read-only', () => {
    const gen = op({ opId: 'g', kind: 'review', threadId: 3, exclusive: true })
    // idle repo → the turn takes the exclusive lane with its own tier
    expect(willRunReadOnly({}, 9)).toBe(false)
    // exclusive op runs + shared lane free → the send would be coerced read-only
    expect(willRunReadOnly(opsOf(gen), 9)).toBe(true)
    // the target thread is itself streaming → blocked, not coerced
    expect(willRunReadOnly(opsOf(gen), 3)).toBe(false)
    // shared lane already occupied → blocked (sharedFull), not coerced
    const full = opsOf(gen, op({ opId: 's', threadId: 4, exclusive: false }))
    expect(willRunReadOnly(full, 9)).toBe(false)
    // only a shared chat runs (no exclusive) → a new send takes the exclusive lane
    expect(willRunReadOnly(opsOf(op({ opId: 's', threadId: 4, exclusive: false })), 9)).toBe(false)
  })
})
