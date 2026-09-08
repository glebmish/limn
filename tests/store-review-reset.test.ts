import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'

// The store reads window.api lazily inside actions, so a minimal stub is enough.
const previewReview = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const findSession = vi.fn(async () => null)
const openRepo = vi.fn(async () => ({ defaultBase: 'main', current: 'feat', branches: ['feat'] }))
const repoState = vi.fn(async () => ({ defaultBase: 'main', current: 'feat', branches: ['feat'] }))
const listRepoSessions = vi.fn(async () => [])
const dashboard = vi.fn(async () => ({ recents: [], notices: [] }))
;(globalThis as unknown as { window: unknown }).window = {
  api: { previewReview, findSession, openRepo, repoState, listRepoSessions, dashboard },
}

import { anyExclusiveRunning, useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))

/** A still-RUNNING exclusive op left over from the review the reviewer is leaving. */
function seedStaleOp(): void {
  useStore.setState({ ops: {}, queuedTurnByThread: {} })
  useStore.getState().startOp('review', 'op-previous', 4, true)
  useStore.getState().queueTurn(4, 'a follow-up parked behind the old turn')
}

describe('leaving a review drops the previous session’s op surface', () => {
  beforeEach(() => {
    previewReview.mockClear(); findSession.mockClear(); dashboard.mockClear()
    previewReview.mockResolvedValue(makeLoaded())
    useStore.setState({ repo: '/repo', repoState: null, sessionId: 3, loaded: makeLoaded(), error: null })
  })

  it('openReview’s transient path clears ops and queued turns', async () => {
    seedStaleOp()
    await useStore.getState().openReview('/repo', { base: 'main', compare: 'other' })
    await flush()
    expect(useStore.getState().ops).toEqual({})
    expect(anyExclusiveRunning(useStore.getState().ops)).toBe(false)
    expect(useStore.getState().queuedTurnByThread).toEqual({})
  })

  it('backToDashboard clears ops and queued turns', async () => {
    seedStaleOp()
    await useStore.getState().backToDashboard()
    expect(useStore.getState().ops).toEqual({})
    expect(useStore.getState().queuedTurnByThread).toEqual({})
  })
})
