import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'

// The store reads window.api lazily inside actions, so a minimal stub is enough
// (same trick as comments-routing.test.ts). startSession mints; loadSession returns
// the persisted shell that materialize swaps in.
const startSession = vi.fn(async () => ({ sessionId: 42 }))
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const saveUiState = vi.fn(async () => {})
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { startSession, loadSession, saveUiState, repoState, listRepoSessions },
}

import { useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))
const IDLE_GEN = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set() }

function reset(): void {
  useStore.setState({
    sessionId: null, loaded: null, transientFresh: false, error: null,
    viewedAt: {}, collapsed: new Set(), expanded: new Set(),
    repo: '/repo', agent: { engine: 'claude' } as never, gen: IDLE_GEN as never,
  })
}

describe('materialize persist chain', () => {
  beforeEach(() => {
    startSession.mockClear(); loadSession.mockClear(); saveUiState.mockClear()
    startSession.mockResolvedValue({ sessionId: 42 })
    loadSession.mockResolvedValue(makeLoaded())
    reset()
  })

  it('toggleViewed on a transient review mints the session exactly once even when two toggles race', async () => {
    useStore.setState({ loaded: makeLoaded({ files: [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })] }) })
    // two synchronous toggles, both firing persistUi() → materialize() before the
    // first startSession resolves: the single-flight `materializing` guard collapses them.
    useStore.getState().toggleViewed('a.ts', false)
    useStore.getState().toggleViewed('b.ts', false)
    await flush()
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(useStore.getState().sessionId).toBe(42)
  })

  it('calls saveUiState with the minted id and the post-toggle viewedAt', async () => {
    useStore.setState({ loaded: makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'ha' })] }) })
    useStore.getState().toggleViewed('a.ts', false)
    await flush()
    expect(saveUiState).toHaveBeenCalledWith(42, { viewedAt: { 'a.ts': { sha: 'HEAD', hash: 'ha' } } })
  })

  it('the loaded swap carries over in-memory fileExcluded and keeps top-level viewedAt', async () => {
    // in-memory exclude set on the transient (not yet in the persisted shell)…
    useStore.setState({
      loaded: makeLoaded({ fileExcluded: { 'x.ts': true } }),
      viewedAt: { 'a.ts': { sha: 'HEAD', hash: 'ha' } as never },
    })
    // …and loadSession returns a shell WITHOUT that exclude.
    loadSession.mockResolvedValue(makeLoaded({ fileExcluded: {} }))
    const id = await useStore.getState().materialize()
    expect(id).toBe(42)
    expect(useStore.getState().loaded?.state.fileExcluded).toEqual({ 'x.ts': true })
    // viewedAt lives at the top level → survives the wholesale `loaded` swap
    expect(useStore.getState().viewedAt).toEqual({ 'a.ts': { sha: 'HEAD', hash: 'ha' } })
  })

  it('returns the existing id when already persisted (no re-mint)', async () => {
    useStore.setState({ sessionId: 99, loaded: makeLoaded() })
    const id = await useStore.getState().materialize()
    expect(id).toBe(99)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('returns null on failure and surfaces the error message', async () => {
    useStore.setState({ loaded: makeLoaded() })
    startSession.mockRejectedValueOnce(new Error('startSession boom'))
    const id = await useStore.getState().materialize()
    expect(id).toBeNull()
    expect(useStore.getState().error).toBe('startSession boom')
  })
})
