import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'
import type { ViewMark } from '../src/shared/types'

// Viewed ticks vs. an in-flight reload, and the ordering of the full-map saves.
// The server replaces the whole viewed map on every save (delete-all-then-insert),
// so a reload that lands after a tick, or two saves that land out of order, silently
// un-tick files the reviewer just ticked.

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const saveUiState = vi.fn(async (_id: number, _patch: { viewedAt?: Record<string, ViewMark> }): Promise<void> => {})
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
const previewReview = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
;(globalThis as unknown as { window: unknown }).window = { api: { loadSession, saveUiState, repoState, listRepoSessions, previewReview } }

import { useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))
const files = ['x.ts', 'y.ts', 'z.ts'].map((path) => makeFile({ path }))
const mark: ViewMark = { sha: 'HEAD', hash: 'h' }
const viewed = () => Object.keys(useStore.getState().viewedAt).sort()

describe('viewed ticks during an in-flight reload', () => {
  beforeEach(() => {
    loadSession.mockReset(); saveUiState.mockReset()
    saveUiState.mockResolvedValue(undefined)
    useStore.setState({ sessionId: 1, loaded: makeLoaded({ files }), viewedAt: {}, error: null, ops: {} })
  })

  it('keeps a tick made while the reload was in flight', async () => {
    const d = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(d.promise)
    const p = useStore.getState().reload()
    useStore.getState().toggleViewed('x.ts', false)
    d.resolve(makeLoaded({ files, viewedAt: {} })) // the server snapshot predates the tick
    await p
    expect(viewed()).toEqual(['x.ts'])
  })

  it('keeps an un-tick made while the reload was in flight', async () => {
    useStore.setState({ viewedAt: { 'x.ts': mark } })
    const d = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(d.promise)
    const p = useStore.getState().reload()
    useStore.getState().toggleViewed('x.ts', true)
    d.resolve(makeLoaded({ files, viewedAt: { 'x.ts': mark } }))
    await p
    expect(viewed()).toEqual([])
  })

  it('still takes the server map for files the reviewer did not touch', async () => {
    const d = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(d.promise)
    const p = useStore.getState().reload()
    useStore.getState().toggleViewed('x.ts', false)
    d.resolve(makeLoaded({ files, viewedAt: { 'z.ts': mark } })) // another tab ticked z
    await p
    expect(viewed()).toEqual(['x.ts', 'z.ts'])
  })

  it('replaces wholesale when nothing was ticked during the reload', async () => {
    useStore.setState({ viewedAt: { 'x.ts': mark } })
    loadSession.mockResolvedValueOnce(makeLoaded({ files, viewedAt: { 'y.ts': mark } }))
    await useStore.getState().reload()
    expect(viewed()).toEqual(['y.ts'])
  })

  it('a later tick persists the in-flight one too', async () => {
    const d = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(d.promise)
    const p = useStore.getState().reload()
    useStore.getState().toggleViewed('x.ts', false)
    d.resolve(makeLoaded({ files, viewedAt: {} }))
    await p
    useStore.getState().toggleViewed('y.ts', false)
    await flush(); await flush()
    const last = saveUiState.mock.calls.at(-1)
    expect(Object.keys(last?.[1].viewedAt ?? {}).sort()).toEqual(['x.ts', 'y.ts'])
  })
})

describe('a reload that lands after the reviewer switched sessions', () => {
  beforeEach(() => {
    loadSession.mockReset(); saveUiState.mockReset()
    saveUiState.mockResolvedValue(undefined)
    useStore.setState({ sessionId: 1, loaded: makeLoaded({ files }), viewedAt: {}, error: null, ops: {} })
  })

  it('is dropped: no surface swap back to A, and B\'s tick is never written into A', async () => {
    const aReload = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(aReload.promise)
    const p = useStore.getState().reload()
    const bLoaded = makeLoaded({ files, viewedAt: {} })
    loadSession.mockResolvedValueOnce(bLoaded)
    await useStore.getState().resumeExisting(2)
    useStore.getState().toggleViewed('x.ts', false) // ticked on B
    await flush(); await flush()
    saveUiState.mockClear()
    aReload.resolve(makeLoaded({ files, viewedAt: { 'z.ts': mark } }))
    await expect(p).resolves.toBe(true)
    await flush(); await flush()
    expect(useStore.getState().sessionId).toBe(2)
    expect(useStore.getState().loaded).toBe(bLoaded)
    expect(viewed()).toEqual(['x.ts'])
    expect(saveUiState.mock.calls.filter(([id]) => id === 1)).toEqual([])
  })

  it('is dropped after A → B → A: the fresher A load stays', async () => {
    const stale = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(stale.promise)
    const p = useStore.getState().reload()
    loadSession.mockResolvedValueOnce(makeLoaded({ files }))
    await useStore.getState().resumeExisting(2)
    const fresh = makeLoaded({ files, viewedAt: { 'y.ts': mark } })
    loadSession.mockResolvedValueOnce(fresh)
    await useStore.getState().resumeExisting(1)
    stale.resolve(makeLoaded({ files, viewedAt: {} }))
    await p
    expect(useStore.getState().loaded).toBe(fresh)
    expect(viewed()).toEqual(['y.ts'])
  })

  it('a tick on another session never merges into this session\'s reload', async () => {
    // B was ticked earlier (stamped on session 2); back on A, a reload must take
    // A's server map wholesale — B's stamp is not "newer than" A's snapshot.
    useStore.setState({ sessionId: 2 })
    useStore.getState().toggleViewed('x.ts', false)
    await flush(); await flush()
    useStore.setState({ sessionId: 1, viewedAt: {} })
    const d = deferred<LoadedReview>()
    loadSession.mockReturnValueOnce(d.promise)
    const p = useStore.getState().reload()
    useStore.setState({ sessionId: 2 }); useStore.getState().toggleViewed('y.ts', false); useStore.setState({ sessionId: 1, viewedAt: {} })
    saveUiState.mockClear()
    d.resolve(makeLoaded({ files, viewedAt: { 'z.ts': mark } }))
    await p
    await flush(); await flush()
    expect(viewed()).toEqual(['z.ts'])
    expect(saveUiState.mock.calls.filter(([id]) => id === 1)).toEqual([]) // nothing to write back
  })
})

describe('a transient refresh that lands after the reviewer moved on', () => {
  it('is dropped when the review on screen changed', async () => {
    const shown = makeLoaded({ files })
    useStore.setState({ sessionId: null, repo: '/r', loaded: shown, error: null })
    const d = deferred<LoadedReview>()
    previewReview.mockReturnValueOnce(d.promise)
    const p = useStore.getState().refreshLoaded()
    const other = makeLoaded({ files, compare: 'other' })
    useStore.setState({ repo: '/elsewhere', loaded: other })
    d.resolve(makeLoaded({ files }))
    await expect(p).resolves.toBe(true)
    expect(useStore.getState().loaded).toBe(other)
  })
})

describe('viewed-map saves are serialized', () => {
  beforeEach(() => {
    loadSession.mockReset(); saveUiState.mockReset()
    useStore.setState({ sessionId: 1, loaded: makeLoaded({ files }), viewedAt: {}, error: null, ops: {} })
  })

  it('never has two saves in flight, and the last save carries the latest map', async () => {
    const first = deferred<void>()
    saveUiState.mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    useStore.getState().toggleViewed('x.ts', false)
    await flush()
    useStore.getState().toggleViewed('y.ts', false)
    useStore.getState().toggleViewed('z.ts', false)
    await flush()
    expect(saveUiState).toHaveBeenCalledTimes(1) // the second waits for the first
    first.resolve()
    await flush(); await flush()
    // the two queued ticks coalesce into ONE follow-up save with the newest map
    expect(saveUiState).toHaveBeenCalledTimes(2)
    expect(Object.keys(saveUiState.mock.calls[1][1].viewedAt ?? {}).sort()).toEqual(['x.ts', 'y.ts', 'z.ts'])
  })

  it('surfaces a failed save in the error strip', async () => {
    saveUiState.mockRejectedValueOnce(new Error('save failed'))
    useStore.getState().toggleViewed('x.ts', false)
    await flush(); await flush()
    expect(useStore.getState().error).toBe('save failed')
  })
})
