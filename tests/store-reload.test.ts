import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'
import type { DriftSummary } from '../src/shared/types'

const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { loadSession, repoState, listRepoSessions } }

import { useStore } from '../src/renderer/store'

const drift = { commits: 1 } as unknown as DriftSummary

describe('reload regenerated-review detection', () => {
  beforeEach(() => {
    loadSession.mockClear()
    useStore.setState({ sessionId: 1, pendingDrift: drift, activeChatId: null })
  })

  it('selects the newest review thread when a regenerate added one', async () => {
    useStore.setState({ loaded: makeLoaded({ chats: [{ id: 1, kind: 'review', messages: [] }] }) })
    loadSession.mockResolvedValueOnce(makeLoaded({
      chats: [
        { id: 1, kind: 'review', messages: [] },
        { id: 2, kind: 'review', messages: [] },
      ],
    }))
    await useStore.getState().reload()
    expect(useStore.getState().activeChatId).toBe(2)
  })

  it('keeps/re-picks the current chat when the review count is unchanged', async () => {
    useStore.setState({
      loaded: makeLoaded({ chats: [{ id: 1, kind: 'review', messages: [] }] }),
      activeChatId: 1,
    })
    loadSession.mockResolvedValueOnce(makeLoaded({ chats: [{ id: 1, kind: 'review', messages: [] }] }))
    await useStore.getState().reload()
    // no regenerate → pickActiveChat keeps the present current id
    expect(useStore.getState().activeChatId).toBe(1)
  })

  it('does NOT treat a first-ever review thread as a regenerate (prev review count was 0)', async () => {
    useStore.setState({ loaded: makeLoaded({ chats: [{ id: 9, kind: 'user', messages: [] }] }), activeChatId: null })
    loadSession.mockResolvedValueOnce(makeLoaded({ chats: [{ id: 10, kind: 'review', messages: [] }] }))
    await useStore.getState().reload()
    // regeneratedId requires prevReviews.length > 0 → null here → pickActiveChat runs
    // (current null, no empty user chat) → falls back to the last chat, id 10
    expect(useStore.getState().activeChatId).toBe(10)
  })

  it('clears pendingDrift (the reload folds any drift in)', async () => {
    useStore.setState({ loaded: makeLoaded({ chats: [] }), pendingDrift: drift })
    loadSession.mockResolvedValueOnce(makeLoaded({ chats: [] }))
    await useStore.getState().reload()
    expect(useStore.getState().pendingDrift).toBeNull()
  })

  it('is a no-op when there is no session id', async () => {
    useStore.setState({ sessionId: null })
    await useStore.getState().reload()
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('surfaces a failed refresh in the error strip instead of rejecting', async () => {
    const kept = makeLoaded({ chats: [{ id: 1, kind: 'review', messages: [] }] })
    useStore.setState({ loaded: kept, viewedAt: { 'a.ts': { sha: 'HEAD', hash: 'ha' } }, error: null })
    loadSession.mockRejectedValueOnce(new Error('fetch failed'))
    await expect(useStore.getState().reload()).resolves.toBe(false) // resolves, never rejects
    expect(useStore.getState().error).toBe('fetch failed')
    // the surface keeps what it had — a failed refresh must not blank the review
    expect(useStore.getState().loaded).toBe(kept)
    expect(useStore.getState().viewedAt).toEqual({ 'a.ts': { sha: 'HEAD', hash: 'ha' } })
  })
})
