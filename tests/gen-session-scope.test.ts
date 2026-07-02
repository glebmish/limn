import { describe, it, expect } from 'vitest'
import { chatsWithDraft, reviewOp } from '../src/renderer/store'
import type { GenState, OpState } from '../src/renderer/store'
import type { LoadedReview } from '../src/shared/ipc'

// reviewOp scopes the review-generation op to the review you're viewing so an op
// started on another session can't paint its progress/cancel state here.
function gen(over: Partial<GenState>): OpState {
  return { running: false, opId: 'op-1', kind: 'review', threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: true, ...over }
}
const opsOf = (op: OpState): Record<string, OpState> => ({ [op.opId ?? 'x']: op })
// minimal LoadedReview: reviewOp only reads state.chats[].id.
function loadedWithThreads(ids: number[]): LoadedReview {
  return { state: { chats: ids.map((id) => ({ id })) } } as unknown as LoadedReview
}

describe('reviewOp (scopes the review generation op to the review being viewed)', () => {
  it('returns the op when it streams into one of this review\'s threads', () => {
    const g = gen({ running: true, threadId: 7 })
    expect(reviewOp(opsOf(g), loadedWithThreads([7, 9]))).toBe(g)
  })

  it('hides an op whose thread belongs to a different session (the cross-session leak)', () => {
    const g = gen({ running: true, threadId: 42 })
    const scoped = reviewOp(opsOf(g), loadedWithThreads([7, 9]))
    expect(scoped.running).toBe(false)
    expect(scoped.opId).toBe(null)
  })

  it('also scopes a cancelled op — its cancelled block must not show on another session', () => {
    const g = gen({ outcome: 'cancelled', threadId: 42 })
    expect(reviewOp(opsOf(g), loadedWithThreads([7])).outcome).toBe(null)
  })

  it('keeps a cancelled op visible on its own session', () => {
    const g = gen({ outcome: 'cancelled', threadId: 7 })
    expect(reviewOp(opsOf(g), loadedWithThreads([7])).outcome).toBe('cancelled')
  })

  it('is idle for an op with no thread, or when no review is loaded', () => {
    expect(reviewOp(opsOf(gen({ running: true, threadId: null })), loadedWithThreads([7])).running).toBe(false)
    expect(reviewOp(opsOf(gen({ running: true, threadId: 7 })), null).running).toBe(false)
  })
})

describe('chat drafts', () => {
  it('are derived for presentation without entering persisted chat state', () => {
    const loaded = loadedWithThreads([7])
    const draft = { kind: 'user' as const, agent: { engine: 'claude' as const }, messages: [], createdAt: 'now', executionMode: 'ask' as const }
    const visible = chatsWithDraft(loaded, draft)
    expect(visible.map((c) => c.id)).toEqual([7, -1])
    expect(loaded.state.chats.map((c) => c.id)).toEqual([7])
  })
})
