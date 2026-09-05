import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads window.api lazily inside actions, so a minimal stub is enough.
const loadSession = vi.fn(async () => ({
  state: { chats: [], viewedAt: {}, repo: '/repo', loadWarnings: [] }
}))
const dashboard = vi.fn(async () => ({ repos: [], recents: [], recentSessions: [], notices: [] }))
const repoState = vi.fn(async () => ({ current: 'main', defaultBase: 'main', worktrees: [] }))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { loadSession, dashboard, repoState, listRepoSessions }
}

import { useStore } from '../src/renderer/store'

const stopped = { reason: 'index.lock exists' }

describe('watchStopped store flag', () => {
  beforeEach(() => {
    useStore.setState({ watchStopped: null, pendingDrift: null })
  })

  it('starts null (watch live)', () => {
    expect(useStore.getState().watchStopped).toBeNull()
  })

  it('setWatchStopped sets and clears the flag (carrying the reason)', () => {
    useStore.getState().setWatchStopped(stopped)
    expect(useStore.getState().watchStopped).toEqual(stopped)
    useStore.getState().setWatchStopped(null)
    expect(useStore.getState().watchStopped).toBeNull()
  })

  it('backToDashboard resets watchStopped alongside pendingDrift', () => {
    useStore.setState({ watchStopped: stopped })
    useStore.getState().backToDashboard()
    expect(useStore.getState().watchStopped).toBeNull()
  })

  it('reload resets watchStopped (the reload re-baselines the watch)', async () => {
    useStore.setState({ watchStopped: stopped, sessionId: 1 })
    await useStore.getState().reload()
    expect(useStore.getState().watchStopped).toBeNull()
  })
})
