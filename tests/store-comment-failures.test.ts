import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { Comment, ReviewState } from '../src/shared/types'

// Comment writes are fired from composers that close on submit. A failed save used
// to reject unhandled — no banner, and the composer had already thrown the typed text
// away. Each action now reports through the error strip and returns whether it
// landed, so a composer can stay open (draft kept) on failure.

const upsertComment = vi.fn(async (): Promise<ReviewState> => ({ comments: [] }) as unknown as ReviewState)
const deleteComment = vi.fn(async (): Promise<ReviewState> => ({ comments: [] }) as unknown as ReviewState)
const saveUiState = vi.fn(async () => {})
const setPref = vi.fn(async () => {})
;(globalThis as unknown as { window: unknown }).window = { api: { upsertComment, deleteComment, saveUiState, setPref } }

import { useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))
const c = { id: 'c1', anchor: { kind: 'title' }, author: 'user', text: 'old', status: 'resolved', replies: [], createdAt: '', iteration: 0 } as unknown as Comment

describe('comment writes report failure', () => {
  beforeEach(() => {
    upsertComment.mockReset(); deleteComment.mockReset()
    useStore.setState({ sessionId: 1, loaded: makeLoaded(), error: null })
  })

  it('addComment: null + error strip on a failed save', async () => {
    upsertComment.mockRejectedValueOnce(new Error('offline'))
    await expect(useStore.getState().addComment({ kind: 'title' }, 'hi')).resolves.toBeNull()
    expect(useStore.getState().error).toBe('offline')
  })

  it('addComment: the new id on success', async () => {
    upsertComment.mockResolvedValueOnce({ comments: [c] } as unknown as ReviewState)
    expect(await useStore.getState().addComment({ kind: 'title' }, 'hi')).toMatch(/^c-/)
    expect(useStore.getState().error).toBeNull()
  })

  it.each([
    ['editComment', () => useStore.getState().editComment(c, 'new')],
    ['requeueComment', () => useStore.getState().requeueComment(c)],
    ['replyToComment', () => useStore.getState().replyToComment(c, 'reply')]
  ] as const)('%s: false + error strip on a failed save, true on success', async (_name, run) => {
    upsertComment.mockRejectedValueOnce(new Error('offline'))
    await expect(run()).resolves.toBe(false)
    expect(useStore.getState().error).toBe('offline')
    upsertComment.mockResolvedValueOnce({ comments: [c] } as unknown as ReviewState)
    await expect(run()).resolves.toBe(true)
  })

  it('deleteComment: false + error strip on a failed delete, true on success', async () => {
    deleteComment.mockRejectedValueOnce(new Error('offline'))
    await expect(useStore.getState().deleteComment('c1')).resolves.toBe(false)
    expect(useStore.getState().error).toBe('offline')
    deleteComment.mockResolvedValueOnce({ comments: [] } as unknown as ReviewState)
    await expect(useStore.getState().deleteComment('c1')).resolves.toBe(true)
  })

  it('every write is false when the session cannot be materialized', async () => {
    useStore.setState({ sessionId: null, loaded: null })
    expect(await useStore.getState().addComment({ kind: 'title' }, 'hi')).toBeNull()
    expect(await useStore.getState().editComment(c, 'x')).toBe(false)
    expect(await useStore.getState().deleteComment('c1')).toBe(false)
    expect(await useStore.getState().requeueComment(c)).toBe(false)
    expect(await useStore.getState().replyToComment(c, 'x')).toBe(false)
  })
})

describe('fire-and-forget saves surface their failures', () => {
  beforeEach(() => {
    saveUiState.mockReset(); setPref.mockReset()
    useStore.setState({ sessionId: 1, loaded: makeLoaded(), error: null })
  })

  it('the default diff stack', async () => {
    saveUiState.mockRejectedValueOnce(new Error('stack save failed'))
    useStore.getState().setDefaultStack(useStore.getState().diffStack)
    await flush(); await flush()
    expect(useStore.getState().error).toBe('stack save failed')
  })

  it('sidebar view and panel width prefs', async () => {
    setPref.mockRejectedValueOnce(new Error('pref failed'))
    useStore.getState().setSidebarView('tree')
    await flush()
    expect(useStore.getState().error).toBe('pref failed')
    useStore.setState({ error: null })
    setPref.mockRejectedValueOnce(new Error('width failed'))
    useStore.getState().setPanelWidth('chat', 400)
    await flush()
    expect(useStore.getState().error).toBe('width failed')
  })

  it('the action list', async () => {
    setPref.mockRejectedValueOnce(new Error('actions failed'))
    await useStore.getState().setActions([])
    expect(useStore.getState().error).toBe('actions failed')
  })
})
