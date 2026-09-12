import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded, makeFile } from './helpers/loaded'

const saveUiState = vi.fn(async () => {})
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { saveUiState, repoState, listRepoSessions } }

import { useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))

function reset(): void {
  useStore.setState({ sessionId: 1, loaded: null, viewedAt: {}, error: null })
}

describe('toggleExcluded', () => {
  beforeEach(() => { saveUiState.mockClear(); reset() })

  it('is a no-op for a tracked file (only untracked files can be excluded)', async () => {
    useStore.setState({ loaded: makeLoaded({ files: [makeFile({ path: 'a.ts' })] }) })
    const before = useStore.getState().loaded
    useStore.getState().toggleExcluded(makeFile({ path: 'a.ts' })) // untracked falsy
    await flush()
    expect(useStore.getState().loaded).toBe(before) // no set()
    expect(saveUiState).not.toHaveBeenCalled()
  })

  it('excluding an untracked file drops its viewed mark and issues BOTH the exclusion and the viewedAt save', async () => {
    const f = makeFile({ path: 'new.ts', untracked: true })
    useStore.setState({
      loaded: makeLoaded({ files: [f], fileExcluded: {} }),
      viewedAt: { 'new.ts': { sha: 'HEAD', hash: 'h' } as never },
    })
    useStore.getState().toggleExcluded(f)
    await flush()
    // exclusion persisted…
    expect(useStore.getState().loaded?.state.fileExcluded).toEqual({ 'new.ts': true })
    expect(saveUiState).toHaveBeenCalledWith(1, { fileExcluded: { 'new.ts': true } })
    // …and the dropped viewed mark persisted via persistUi()
    expect(useStore.getState().viewedAt).toEqual({})
    expect(saveUiState).toHaveBeenCalledWith(1, { viewedAt: {} })
    expect(saveUiState).toHaveBeenCalledTimes(2)
  })

  it('including a file back issues only the exclusion save (no viewedAt save)', async () => {
    const f = makeFile({ path: 'new.ts', untracked: true })
    useStore.setState({
      loaded: makeLoaded({ files: [f], fileExcluded: { 'new.ts': true } }),
      viewedAt: {},
    })
    useStore.getState().toggleExcluded(f) // currently excluded → include back (next=false)
    await flush()
    expect(useStore.getState().loaded?.state.fileExcluded).toEqual({ 'new.ts': false })
    expect(saveUiState).toHaveBeenCalledTimes(1)
    expect(saveUiState).toHaveBeenCalledWith(1, { fileExcluded: { 'new.ts': false } })
  })
})
