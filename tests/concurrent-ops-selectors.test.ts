import { describe, it, expect } from 'vitest'
import { opForThread, reviewOp, anyExclusiveRunning, anyRunning, anySharedRunning, chatSendBlocked } from '../src/renderer/store'
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

  it('reviewOp returns only a review-kind op whose thread belongs to the loaded review', () => {
    const gen = op({ opId: 'g', kind: 'review', threadId: 3 })
    const chat = op({ opId: 'c', kind: 'chat', threadId: 4, exclusive: false })
    const ops = opsOf(gen, chat)
    expect(reviewOp(ops, loaded([3, 4])).opId).toBe('g')   // the review op, not the chat op
    expect(reviewOp(ops, loaded([4])).running).toBe(false) // review thread not in this review
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
})
