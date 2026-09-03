import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'
import { UNIFIED, type Stack } from '../src/shared/diffStack'

const saveUiState = vi.fn(async () => {})
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const previewReview = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const startSession = vi.fn(async () => ({ sessionId: 77 }))
const findSession = vi.fn(async () => null)
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { saveUiState, loadSession, previewReview, startSession, findSession, repoState, listRepoSessions }
}

import { useStore } from '../src/renderer/store'

const split: Stack = { out: ['base'], against: 'base' }
const multi: Stack = { out: ['approved', 'base'], against: 'base' }

beforeEach(() => {
  saveUiState.mockClear(); loadSession.mockClear(); startSession.mockClear()
  useStore.setState({ loaded: makeLoaded({ repo: '/repo' }), repo: '/repo', sessionId: 5, diffStack: UNIFIED, fileStack: {} })
})

describe("a file's own stack", () => {
  it('is stored as an override and leaves the default alone', () => {
    useStore.getState().setFileStack('a.ts', split)
    expect(useStore.getState().fileStack).toEqual({ 'a.ts': split })
    expect(useStore.getState().diffStack).toEqual(UNIFIED)
  })
  it('is dropped, not stored, when it equals the default — the ✓ goes away by itself', () => {
    useStore.getState().setFileStack('a.ts', split)
    useStore.getState().setFileStack('a.ts', { out: [], against: 'base' })
    expect(useStore.getState().fileStack).toEqual({})
  })
})

describe('spreading a stack to every file', () => {
  it('makes it the default, clears every override and persists it with the session', async () => {
    useStore.getState().setFileStack('a.ts', multi)
    useStore.getState().setFileStack('b.ts', split)
    useStore.getState().spreadStack('a.ts')
    expect(useStore.getState().diffStack).toEqual(multi)
    expect(useStore.getState().fileStack).toEqual({})
    await Promise.resolve(); await Promise.resolve()
    expect(saveUiState).toHaveBeenCalledWith(5, { diffStack: multi })
  })
  it('mints the session first on a transient review, like the first viewed mark', async () => {
    useStore.setState({ sessionId: null })
    loadSession.mockResolvedValueOnce(makeLoaded({ repo: '/repo' }))
    useStore.getState().setDefaultStack({ out: [], against: 'approved' })
    await vi.waitFor(() => expect(saveUiState).toHaveBeenCalledWith(77, { diffStack: { out: [], against: 'approved' } }))
    expect(startSession).toHaveBeenCalled()
  })
})

describe('loading a review', () => {
  it('takes the default from the persisted state and starts with no overrides', async () => {
    useStore.setState({ fileStack: { 'a.ts': split } })
    const loaded = makeLoaded({ repo: '/repo' })
    loaded.state.diffStack = multi
    loadSession.mockResolvedValueOnce(loaded)
    await useStore.getState().resumeExisting(3)
    expect(useStore.getState().diffStack).toEqual(multi)
    expect(useStore.getState().fileStack).toEqual({})
  })
  it('opens Unified, full diff, when the review has never spread a stack', async () => {
    useStore.setState({ diffStack: multi })
    loadSession.mockResolvedValueOnce(makeLoaded({ repo: '/repo' }))
    await useStore.getState().resumeExisting(3)
    expect(useStore.getState().diffStack).toEqual(UNIFIED)
  })
})
