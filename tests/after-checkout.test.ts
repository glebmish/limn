import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'

const enabledCap = { enabled: true, reason: 'available', branch: 'feat', workdir: '/wt' }
const blockedCap = { enabled: false, reason: 'not-checked-out', branch: 'feat', workdir: null }

const addWorktreeFor = vi.fn(async () => ({ path: '/repo', branches: [], current: 'main', defaultBase: 'main', dirty: false, dirtyCount: 0, worktrees: [] }))
const previewReview = vi.fn(async (): Promise<LoadedReview> => {
  const l = makeLoaded({ repo: '/repo' })
  ;(l as { writeCapability?: unknown }).writeCapability = enabledCap
  return l
})
const loadSession = vi.fn(async (): Promise<LoadedReview> => {
  const l = makeLoaded({ repo: '/repo' })
  ;(l as { writeCapability?: unknown }).writeCapability = enabledCap
  return l
})
const repoState = vi.fn(async () => ({ worktrees: [] }))
const listRepoSessions = vi.fn(async () => [])
const openRepo = vi.fn(async () => ({ worktrees: [] }))
;(globalThis as unknown as { window: unknown }).window = {
  api: { addWorktreeFor, previewReview, loadSession, repoState, listRepoSessions, openRepo }
}

import { useStore } from '../src/renderer/store'

function seedTransient() {
  const loaded = makeLoaded({ repo: '/repo', compare: 'feat' })
  ;(loaded as { writeCapability?: unknown }).writeCapability = blockedCap
  useStore.setState({ repo: '/repo', sessionId: null, loaded, error: null })
}

beforeEach(() => {
  addWorktreeFor.mockClear(); previewReview.mockClear(); loadSession.mockClear()
})

describe('addWorktreeFor on a transient review (the not-checked-out gate)', () => {
  it('refreshes the preview so writeCapability catches up with the new worktree', async () => {
    seedTransient()
    await useStore.getState().addWorktreeFor('feat', 'review-worktree')
    expect(addWorktreeFor).toHaveBeenCalledWith('/repo', 'feat', 'review-worktree')
    // the transient must be re-previewed — a bare reload() no-ops on sessionId null
    // and leaves the "isn't checked out" gate note up forever (bug 2026-08-08)
    expect(previewReview).toHaveBeenCalled()
    expect(useStore.getState().loaded?.writeCapability).toMatchObject({ enabled: true })
  })

  it('persisted sessions keep using reload', async () => {
    seedTransient()
    useStore.setState({ sessionId: 7 })
    await useStore.getState().addWorktreeFor('feat', 'review-worktree')
    expect(loadSession).toHaveBeenCalledWith(7)
    expect(useStore.getState().loaded?.writeCapability).toMatchObject({ enabled: true })
  })
})
