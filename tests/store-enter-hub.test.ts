import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads window.api lazily inside actions; fake it before importing the
// store (pattern from tests/store-routing.test.ts / tests/prefs-sidebar-view.test.ts).
const openRepoApi = vi.fn(async (repo: string) => ({ path: repo, branches: [] }))
const repoState = vi.fn(async () => ({ current: 'main', defaultBase: 'main', branches: [], worktrees: [] }))
const listRepoSessions = vi.fn(async () => [] as unknown[])
const dashboard = vi.fn(async () => ({ repos: [], recents: [], recentSessions: [], notices: [] }))
;(globalThis as unknown as { window: unknown }).window = {
  api: { openRepo: openRepoApi, repoState, listRepoSessions, dashboard }
}

import { useStore } from '../src/renderer/store'

describe('enterHub validates the repo path before landing on the hub', () => {
  beforeEach(() => {
    openRepoApi.mockReset().mockImplementation(async (repo: string) => ({ path: repo, branches: [] }))
    repoState.mockReset().mockImplementation(async () => ({ current: 'main', defaultBase: 'main', branches: [], worktrees: [] }))
    listRepoSessions.mockClear()
    dashboard.mockReset().mockImplementation(async () => ({ repos: [], recents: [], recentSessions: [], notices: [] }))
    useStore.setState({ screen: 'dashboard', repo: null, repoState: null, error: null })
  })

  it('a dead /hub?repo= link (no prior repo context) lands on the dashboard with the fixed error, checking with repoState — not openRepo', async () => {
    repoState.mockRejectedValueOnce(new Error('some low-level git error'))
    await useStore.getState().enterHub('/nope')
    expect(useStore.getState().screen).toBe('dashboard')
    expect(useStore.getState().error).toBe('/nope is not a git repository')
    expect(openRepoApi).not.toHaveBeenCalled()
  })

  it('a live repo still lands on the hub, unaffected', async () => {
    await useStore.getState().enterHub('/r')
    expect(useStore.getState().screen).toBe('hub')
    expect(useStore.getState().repo).toBe('/r')
    expect(useStore.getState().error).toBeNull()
  })

  it('the error toast survives loadDashboard settling afterwards (ticket-ordering)', async () => {
    dashboard.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { repos: [], recents: [], recentSessions: [], notices: [] }
    })
    repoState.mockRejectedValueOnce(new Error('some low-level git error'))
    await useStore.getState().enterHub('/nope')
    expect(useStore.getState().error).toBe('/nope is not a git repository')
    // give the delayed dashboard load a chance to run — it must not clobber the toast
    await new Promise((r) => setTimeout(r, 40))
    expect(useStore.getState().error).toBe('/nope is not a git repository')
  })

  it('skips validation entirely when the store already holds this repo\'s state (the openRepo→enterHub hot path)', async () => {
    useStore.setState({ repo: '/r', repoState: { current: 'main', defaultBase: 'main', branches: [], worktrees: [] } as never })
    await useStore.getState().enterHub('/r')
    expect(useStore.getState().screen).toBe('hub')
    expect(openRepoApi).not.toHaveBeenCalled()
    // repoState is still called once — by loadRepoContext's own refresh, not by
    // a separate validation call. The point is no EXTRA validation round trip.
    expect(repoState).toHaveBeenCalledTimes(1)
  })
})
