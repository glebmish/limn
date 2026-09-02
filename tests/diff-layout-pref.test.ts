import { describe, it, expect, beforeEach, vi } from 'vitest'

const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const setPref = vi.fn(async () => {})
;(globalThis as unknown as { window: unknown }).window = { api: { getPrefs, setPref } }

import { useStore, multiHunksForMode, checkpointLabel, layoutLabel, DIFF_LAYOUTS } from '../src/renderer/store'
import type { FileDiff } from '../src/shared/types'

beforeEach(() => {
  getPrefs.mockReset(); getPrefs.mockResolvedValue({})
  setPref.mockClear()
  useStore.setState({ diffLayout: 'unified' })
})

describe('diffLayout pref', () => {
  it('defaults to unified and names the three layouts', () => {
    expect(useStore.getState().diffLayout).toBe('unified')
    expect(DIFF_LAYOUTS.map(layoutLabel)).toEqual(['Unified', 'Split', 'Multi'])
  })

  it('setDiffLayout writes through setPref and updates state', () => {
    useStore.getState().setDiffLayout('multi')
    expect(setPref).toHaveBeenCalledWith('diffLayout', '"multi"')
    expect(useStore.getState().diffLayout).toBe('multi')
  })

  it('loadPrefs hydrates it, and a garbage value falls back to unified', async () => {
    getPrefs.mockResolvedValueOnce({ diffLayout: '"split"' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().diffLayout).toBe('split')
    getPrefs.mockResolvedValueOnce({ diffLayout: '"sideways"' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().diffLayout).toBe('unified')
  })
})

describe('Multi helpers', () => {
  const f = { path: 'a', status: 'modified', binary: false, add: 0, del: 0, hunks: [], baseToApprovedHunks: [] } as FileDiff
  it('picks the base→checkpoint slice for the mode, none for the full diff', () => {
    expect(multiHunksForMode(f, 'approved')).toEqual([])
    expect(multiHunksForMode(f, 'review')).toBeUndefined()
    expect(multiHunksForMode(f, 'viewed')).toBeUndefined()
    expect(multiHunksForMode(f, 'branch')).toBeUndefined()
  })
  it('names the middle column', () => {
    expect(checkpointLabel('review')).toBe('At review')
    expect(checkpointLabel('approved')).toBe('Approved')
    expect(checkpointLabel('viewed')).toBe('Viewed')
    expect(checkpointLabel('branch')).toBe('Base')
  })
})
