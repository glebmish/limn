import { describe, it, expect } from 'vitest'
import { genForLoaded } from '../src/renderer/store'
import type { GenState } from '../src/renderer/store'
import type { LoadedReview } from '../src/shared/ipc'

// gen state is global to the renderer; genForLoaded scopes it to the review you're
// viewing so an op started on another session can't paint its progress here.
function gen(over: Partial<GenState>): GenState {
  return { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, cancelled: false, ...over }
}
// minimal LoadedReview: genForLoaded only reads state.chats[].id.
function loadedWithThreads(ids: number[]): LoadedReview {
  return { state: { chats: ids.map((id) => ({ id })) } } as unknown as LoadedReview
}

describe('genForLoaded (scopes the global gen op to the review being viewed)', () => {
  it('returns the op when it streams into one of this review\'s threads', () => {
    const g = gen({ running: true, opId: 'op-1', kind: 'review', threadId: 7 })
    expect(genForLoaded(g, loadedWithThreads([7, 9]))).toBe(g)
  })

  it('hides an op whose thread belongs to a different session (the cross-session leak)', () => {
    const g = gen({ running: true, opId: 'op-1', kind: 'review', threadId: 42 })
    const scoped = genForLoaded(g, loadedWithThreads([7, 9]))
    expect(scoped.running).toBe(false)
    expect(scoped.opId).toBe(null)
  })

  it('also scopes a cancelled op — its cancelled block must not show on another session', () => {
    const g = gen({ cancelled: true, opId: 'op-1', kind: 'review', threadId: 42 })
    expect(genForLoaded(g, loadedWithThreads([7])).cancelled).toBe(false)
  })

  it('keeps a cancelled op visible on its own session', () => {
    const g = gen({ cancelled: true, opId: 'op-1', kind: 'review', threadId: 7 })
    expect(genForLoaded(g, loadedWithThreads([7])).cancelled).toBe(true)
  })

  it('is idle for an op with no thread, or when no review is loaded', () => {
    expect(genForLoaded(gen({ running: true, threadId: null }), loadedWithThreads([7])).running).toBe(false)
    expect(genForLoaded(gen({ running: true, threadId: 7 }), null).running).toBe(false)
  })
})
