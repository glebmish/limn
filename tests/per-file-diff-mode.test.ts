import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FileDiff } from '../src/shared/types'

const dashboard = vi.fn(async () => ({ repos: [], recents: [], recentSessions: [], notices: [] }))
;(globalThis as unknown as { window: unknown }).window = { api: { dashboard } }

import { useStore, baselinesForFile, modeForFile, diffHunksForMode } from '../src/renderer/store'

const file = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path, status: 'modified', binary: false, add: 1, del: 0, hunks: [], ...extra
})

describe('baselinesForFile — a file only offers the baselines it actually has', () => {
  it('offers the full diff alone when the file was never viewed or approved', () => {
    expect(baselinesForFile(file('a.ts'))).toEqual(['branch'])
  })

  it('offers the since-baseline when the file has that slice', () => {
    expect(baselinesForFile(file('a.ts', { sinceHunks: [] }))).toEqual(['branch', 'approved'])
    expect(baselinesForFile(file('a.ts', { sinceViewedHunks: [] }))).toEqual(['branch', 'viewed'])
  })

  it('offers the review window as its own baseline', () => {
    expect(baselinesForFile(file('a.ts', { sinceReviewHunks: [] }))).toEqual(['branch', 'review'])
  })

  it('lists all four oldest-checkpoint-first when the file has them all', () => {
    expect(baselinesForFile(file('a.ts', { sinceReviewHunks: [], sinceHunks: [], sinceViewedHunks: [] })))
      .toEqual(['branch', 'review', 'approved', 'viewed'])
  })
})

describe('diffHunksForMode — each baseline renders its own slice', () => {
  const hunks = (t: string) => [{ range: '@@', header: '', lines: [{ old: null, new: 1, kind: 'add' as const, text: t }] }]
  const f = file('a.ts', {
    hunks: hunks('branch'), sinceReviewHunks: hunks('review'),
    sinceHunks: hunks('approved'), sinceViewedHunks: hunks('viewed')
  })

  it('reads the review window from its own slice, not the approval\'s', () => {
    expect(diffHunksForMode(f, 'review')[0].lines[0].text).toBe('review')
    expect(diffHunksForMode(f, 'approved')[0].lines[0].text).toBe('approved')
  })

  it('renders an honest empty when the file has no slice at that baseline', () => {
    expect(diffHunksForMode(file('a.ts'), 'review')).toEqual([])
  })
})

describe('per-file diff baseline', () => {
  beforeEach(() => {
    useStore.setState({ diffMode: 'branch', fileDiffMode: {} })
  })

  it('falls back to the global baseline for a file with no override', () => {
    useStore.setState({ diffMode: 'viewed' })
    expect(modeForFile(useStore.getState(), 'a.ts')).toBe('viewed')
  })

  it('overrides one file without touching its neighbours', () => {
    useStore.getState().setFileDiffMode('a.ts', 'viewed')

    expect(modeForFile(useStore.getState(), 'a.ts')).toBe('viewed')
    expect(modeForFile(useStore.getState(), 'b.ts')).toBe('branch')
  })

  it('clears every per-file override when the global baseline is set — it means "all files"', () => {
    useStore.getState().setFileDiffMode('a.ts', 'viewed')

    useStore.getState().setGlobalDiffMode('approved')

    expect(useStore.getState().fileDiffMode).toEqual({})
    expect(modeForFile(useStore.getState(), 'a.ts')).toBe('approved')
  })
})
