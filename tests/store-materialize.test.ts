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

function reset(): void {
  useStore.setState({
    sessionId: null, loaded: null, transientFresh: false, error: null,
    viewedAt: {}, collapsed: new Set(), expanded: new Set(),
    repo: '/repo', agent: { engine: 'claude' } as never, ops: {},
  })
}

describe('materialize persist chain', () => {
  beforeEach(() => {
    // mockReset (not mockClear) so a queued *Once implementation can't leak forward
    startSession.mockReset(); loadSession.mockReset(); saveUiState.mockClear()
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

  it('a materialize that lands after the reviewer navigated away leaves the new review alone', async () => {
    const abandoned = makeLoaded({ compare: 'feat-a' })
    const opened = makeLoaded({ compare: 'feat-b' })
    useStore.setState({ loaded: abandoned })
    let release!: (v: { sessionId: number }) => void
    startSession.mockReturnValueOnce(new Promise<{ sessionId: number }>((r) => { release = r }))
    const pending = useStore.getState().materialize()
    // the reviewer opens a different review while startSession is still in flight
    useStore.setState({ loaded: opened, sessionId: null })
    // the shell the abandoned review would have swapped in carries a live op and a
    // load warning — neither may reach the review now on screen.
    const abandonedShell = makeLoaded({ compare: 'feat-a' })
    loadSession.mockResolvedValueOnce({
      ...abandonedShell,
      state: { ...abandonedShell.state, loadWarnings: ['a blob of the abandoned review'] },
      activeOps: [{ opId: 'op-abandoned', kind: 'chat', threadId: 7, exclusive: false, startedAt: new Date().toISOString(), events: [], nextSeq: 0 }]
    } as unknown as LoadedReview)
    release({ sessionId: 42 })
    // the caller still gets the id it needs to persist its write…
    await expect(pending).resolves.toBe(42)
    await flush()
    // …but nothing of the abandoned review reaches the one now on screen: not its
    // load warning, not its live ops, not its shell.
    expect(useStore.getState().error).toBeNull()
    expect(useStore.getState().ops).toEqual({})
    expect(useStore.getState().loaded).toBe(opened)
    expect(useStore.getState().sessionId).toBeNull()
  })

  it('keys the flight on the base anchor sha, not just the ref pair', async () => {
    // two sessions can share a (base, compare) pair — the server keys on the base's
    // resolved anchor sha (db/sessions.ts findSession), so a base branch that moved
    // gives the same pair two identities. The renderer must agree, or a stale
    // materialize yanks the reviewer onto the other session.
    const abandoned = makeLoaded({ compare: 'feat', baseAnchorSha: 'sha-old' })
    const opened = makeLoaded({ compare: 'feat', baseAnchorSha: 'sha-new' })
    useStore.setState({ loaded: abandoned })
    let release!: (v: { sessionId: number }) => void
    startSession.mockReturnValueOnce(new Promise<{ sessionId: number }>((r) => { release = r }))
    const pending = useStore.getState().materialize()
    useStore.setState({ loaded: opened, sessionId: null })
    release({ sessionId: 42 })
    await expect(pending).resolves.toBe(42)
    await flush()
    expect(useStore.getState().loaded).toBe(opened)
    expect(useStore.getState().sessionId).toBeNull()
  })

  it('a first write on a different review mints its own session instead of riding the abandoned flight', async () => {
    useStore.setState({ loaded: makeLoaded({ compare: 'feat-a' }) })
    let release!: (v: { sessionId: number }) => void
    startSession.mockReturnValueOnce(new Promise<{ sessionId: number }>((r) => { release = r }))
    const first = useStore.getState().materialize()
    useStore.setState({ loaded: makeLoaded({ compare: 'feat-b' }), sessionId: null })
    startSession.mockResolvedValueOnce({ sessionId: 43 })
    const second = useStore.getState().materialize()
    release({ sessionId: 42 })
    expect(await first).toBe(42)
    expect(await second).toBe(43)
    expect(startSession).toHaveBeenCalledTimes(2)
    expect(startSession).toHaveBeenNthCalledWith(1, '/repo', 'main', 'feat-a', { engine: 'claude' }, false)
    expect(startSession).toHaveBeenNthCalledWith(2, '/repo', 'main', 'feat-b', { engine: 'claude' }, false)
  })

  it('returns null on failure and surfaces the error message', async () => {
    useStore.setState({ loaded: makeLoaded() })
    startSession.mockRejectedValueOnce(new Error('startSession boom'))
    const id = await useStore.getState().materialize()
    expect(id).toBeNull()
    expect(useStore.getState().error).toBe('startSession boom')
  })
})
