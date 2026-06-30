import { describe, expect, it } from 'vitest'
import type { FileDiff, ViewMark } from '../src/shared/types'
import { combineReviewStatuses, reviewStatusForFile } from '../src/renderer/lib/fileStatus'

function file(path: string, opts: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: opts.status ?? 'modified',
    binary: false,
    add: 1,
    del: 0,
    fileHash: opts.fileHash ?? 'h',
    hunks: opts.hunks ?? [{ range: '@@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'x' }] }]
  }
}

const mark = (hash = 'h'): ViewMark => ({ sha: 'HEAD', hash })

describe('reviewStatusForFile', () => {
  it('marks viewed unchanged files green', () => {
    expect(reviewStatusForFile(file('a.ts'), { 'a.ts': mark() })).toBe('st-rev')
  })

  it('marks never-viewed files unviewed', () => {
    expect(reviewStatusForFile(file('a.ts'), {})).toBe('st-unrev')
  })

  it('marks a file changed by a commit since viewing amber (the ~ middle ground)', () => {
    expect(reviewStatusForFile(file('a.ts', { hunks: [{ range: '@@', header: '', sinceViewed: true, lines: [] }] }), { 'a.ts': mark() })).toBe('st-amber')
  })

  it('marks content-hash drift since viewing amber', () => {
    expect(reviewStatusForFile(file('a.ts', { fileHash: 'h2' }), { 'a.ts': mark('h1') })).toBe('st-amber')
  })

  it('marks deleted files by viewed state, not file status', () => {
    expect(reviewStatusForFile(file('a.ts', { status: 'deleted' }), {})).toBe('st-unrev')
    expect(reviewStatusForFile(file('a.ts', { status: 'deleted' }), { 'a.ts': mark() })).toBe('st-rev')
  })
})

describe('combineReviewStatuses', () => {
  it('rolls a folder amber when any child changed since it was viewed', () => {
    expect(combineReviewStatuses(['st-rev', 'st-amber'])).toBe('st-amber')
    expect(combineReviewStatuses(['st-unrev', 'st-amber'])).toBe('st-amber')
  })

  it('rolls a folder unviewed for unviewed children with no amber drift', () => {
    expect(combineReviewStatuses(['st-rev', 'st-unrev'])).toBe('st-unrev')
    expect(combineReviewStatuses(['st-rev', 'st-risk'])).toBe('st-unrev')
  })

  it('shows a folder green only when every child is viewed', () => {
    expect(combineReviewStatuses(['st-rev', 'st-rev'])).toBe('st-rev')
  })
})
