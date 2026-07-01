import { describe, it, expect } from 'vitest'
import { diffHunksForMode } from '../src/renderer/store'
import type { FileDiff, Hunk } from '../src/shared/types'

const hunk = (tag: string): Hunk => ({ range: '@@', header: tag, lines: [] })
const file = (over: Partial<FileDiff>): FileDiff => ({
  path: 'f.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [hunk('full')], ...over
})

describe('diffHunksForMode', () => {
  it('branch mode always shows the full diff', () => {
    const f = file({ sinceViewedHunks: [hunk('sv')], sinceHunks: [hunk('sa')] })
    expect(diffHunksForMode(f, 'branch').map((h) => h.header)).toEqual(['full'])
  })

  it('viewed mode shows the since-viewed slice for a tracked file', () => {
    const f = file({ sinceViewedHunks: [hunk('sv')] })
    expect(diffHunksForMode(f, 'viewed').map((h) => h.header)).toEqual(['sv'])
  })

  it('viewed mode is empty for a tracked file with no since-viewed baseline (genuine "No changes")', () => {
    const f = file({}) // no sinceViewedHunks
    expect(diffHunksForMode(f, 'viewed')).toEqual([])
  })

  it('viewed mode shows the FULL diff for an untracked file — a wholly-new file is not "No changes since you viewed"', () => {
    // viewed-at-head / never-viewed untracked file: no since-viewed baseline exists,
    // but the whole file is unseen content — show it rather than an empty message.
    const f = file({ untracked: true, status: 'added' })
    expect(diffHunksForMode(f, 'viewed').map((h) => h.header)).toEqual(['full'])
  })

  it('approved mode shows the since-approved slice for a tracked file', () => {
    const f = file({ sinceHunks: [hunk('sa')] })
    expect(diffHunksForMode(f, 'approved').map((h) => h.header)).toEqual(['sa'])
  })

  it('approved mode is empty for a tracked file unchanged since approval', () => {
    const f = file({})
    expect(diffHunksForMode(f, 'approved')).toEqual([])
  })

  it('approved mode shows the FULL diff for an untracked file', () => {
    const f = file({ untracked: true, status: 'added' })
    expect(diffHunksForMode(f, 'approved').map((h) => h.header)).toEqual(['full'])
  })
})
