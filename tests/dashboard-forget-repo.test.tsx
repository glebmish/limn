import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RepoIndexEntry } from '../src/shared/types'

// The store reads window.api lazily inside actions; fake it before importing the
// store (pattern from tests/store-enter-hub.test.ts).
const forgetRepoApi = vi.fn(async (_repo: string) => {})
const dashboard = vi.fn(async () => ({ repos: [] as RepoIndexEntry[], recents: [], recentSessions: [], notices: [] }))
;(globalThis as unknown as { window: unknown }).window = { api: { forgetRepo: forgetRepoApi, dashboard } }

import { useStore } from '../src/renderer/store'
import Dashboard, { forgetPrompt } from '../src/renderer/screens/Dashboard'
import { initialStateOf } from './helpers/store'

const entry = (path: string, sessionCount = 0): RepoIndexEntry => ({
  path, current: 'main', defaultBase: 'main', worktrees: [],
  sessionCount, lastActivity: '2026-06-12T10:00:00Z'
})

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)

describe('forgetting a repo from the dashboard', () => {
  beforeEach(() => {
    forgetRepoApi.mockReset().mockImplementation(async () => {})
    dashboard.mockReset().mockImplementation(async () => ({ repos: [], recents: [], recentSessions: [], notices: [] }))
    useStore.setState({ dashboard: { repos: [entry('/r1')], recents: [], recentSessions: [], notices: [] }, error: null })
  })

  it('calls the api and refreshes the index so the row disappears', async () => {
    await useStore.getState().forgetRepo('/r1')

    expect(forgetRepoApi).toHaveBeenCalledWith('/r1')
    expect(useStore.getState().dashboard?.repos).toEqual([])
  })

  it('surfaces a failure and leaves the index untouched', async () => {
    forgetRepoApi.mockRejectedValueOnce(new Error('database is locked'))

    await useStore.getState().forgetRepo('/r1')

    expect(useStore.getState().error).toBe('database is locked')
    expect(useStore.getState().dashboard?.repos.map((r) => r.path)).toEqual(['/r1'])
    expect(dashboard).not.toHaveBeenCalled()
  })

  it('offers a forget button on every repo row', () => {
    const state = initial() as unknown as { dashboard: unknown; booting: boolean }
    state.dashboard = { repos: [entry('/a/one'), entry('/a/two')], recents: [], recentSessions: [], notices: [] }
    state.booting = false

    const html = renderToStaticMarkup(<Dashboard />)

    expect(html.match(/class="rr-forget"/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Remove one from this list"')
  })

  it('warns in the confirm prompt about the reviews that get archived', () => {
    expect(forgetPrompt(entry('/a/one', 0)))
      .toBe('Remove one from this list? Opening it again brings it back.')
    expect(forgetPrompt(entry('/a/one', 1)))
      .toBe('Remove one from this list? Its 1 review is archived (recoverable), and opening it again brings it back.')
    expect(forgetPrompt(entry('/a/one', 3)))
      .toBe('Remove one from this list? Its 3 reviews are archived (recoverable), and opening it again brings it back.')
  })
})
