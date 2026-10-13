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
;(globalThis as unknown as { window: unknown }).window = { api: { loadSession, saveUiState, repoState, listRepoSessions } }

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
