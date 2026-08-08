import { describe, expect, it } from 'vitest'
import type { DiffLine, FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { discardSpanAt, fileEditable, narrowEdit } from '../src/renderer/lib/edits'

describe('narrowEdit', () => {
  it('returns null when nothing changed', () => {
    expect(narrowEdit(10, ['a', 'b'], ['a', 'b'])).toBeNull()
    expect(narrowEdit(1, [], [])).toBeNull()
  })

  it('narrows a middle-line change to a single-line edit', () => {
    expect(narrowEdit(10, ['a', 'b', 'c'], ['a', 'B', 'c']))
      .toEqual({ start: 11, end: 11, snapshot: ['b'], newLines: ['B'] })
  })

  it('narrows an append at the end to an insertion', () => {
    expect(narrowEdit(10, ['a', 'b'], ['a', 'b', 'c']))
      .toEqual({ start: 12, end: 11, snapshot: [], newLines: ['c'] })
  })

  it('narrows a deletion in the middle', () => {
    expect(narrowEdit(10, ['a', 'b', 'c'], ['a', 'c']))
      .toEqual({ start: 11, end: 11, snapshot: ['b'], newLines: [] })
  })

  it('guards the repeated-line prefix/suffix overlap', () => {
    // typed grows by one identical line: must become a pure insertion, never a
    // negative span (prefix 2 + suffix 2 would double-count on ['a','a'])
    const e = narrowEdit(1, ['a', 'a'], ['a', 'a', 'a'])
    expect(e).toEqual({ start: 3, end: 2, snapshot: [], newLines: ['a'] })
  })
})

const wf = { enabled: true, reason: 'available', branch: 'feature', workdir: '/wt' } as const

function loadedWith(enabled: boolean): LoadedReview {
  return { writeCapability: { ...wf, enabled } } as unknown as LoadedReview
}

function fd(over: Partial<FileDiff>): FileDiff {
  return { path: 'x.ts', status: 'modified', binary: false, add: 1, del: 1, hunks: [], ...over }
}

describe('fileEditable', () => {
  it('requires write capability and refuses binary/conflicted files', () => {
    expect(fileEditable(loadedWith(true), fd({}))).toBe(true)
    expect(fileEditable(loadedWith(false), fd({}))).toBe(false)
    expect(fileEditable(null, fd({}))).toBe(false)
    expect(fileEditable(loadedWith(true), fd({ binary: true }))).toBe(false)
    expect(fileEditable(loadedWith(true), fd({ conflict: true }))).toBe(false)
  })
})

const ctx = (old: number, nw: number, text = 'ctx'): DiffLine => ({ old, new: nw, kind: '', text })
const add = (nw: number, text: string, origin?: 'staged' | 'unstaged'): DiffLine => ({ old: null, new: nw, kind: 'add', text, origin })
const del = (old: number, text: string, origin?: 'staged' | 'unstaged'): DiffLine => ({ old, new: null, kind: 'del', text, origin })

describe('discardSpanAt', () => {
  it('restores an unstaged −/+ pair from either index', () => {
    const lines = [ctx(9, 9), del(10, 'old text', 'unstaged'), add(10, 'new text', 'unstaged'), ctx(11, 11)]
    const want = { start: 10, end: 10, snapshot: ['new text'], restore: ['old text'] }
    expect(discardSpanAt(lines, 1)).toEqual(want)
    expect(discardSpanAt(lines, 2)).toEqual(want)
  })

  it('an unstaged add-only run restores to nothing (deletes the added lines)', () => {
    const lines = [ctx(9, 9), add(10, 'added a', 'unstaged'), add(11, 'added b', 'unstaged'), ctx(10, 12)]
    expect(discardSpanAt(lines, 1)).toEqual({ start: 10, end: 11, snapshot: ['added a', 'added b'], restore: [] })
  })

  it('refuses del-only runs (no working-tree anchor) and staged interleave', () => {
    expect(discardSpanAt([ctx(9, 9), del(10, 'gone', 'unstaged'), ctx(11, 10)], 1)).toBeNull()
    const mixed = [ctx(9, 9), add(10, 'stg', 'staged'), add(11, 'unstg', 'unstaged'), ctx(10, 12)]
    expect(discardSpanAt(mixed, 2)).toBeNull()
  })

  it('returns null on committed lines and bounds the run at context', () => {
    const lines = [add(5, 'committed add'), ctx(6, 6), add(7, 'mine', 'unstaged'), ctx(7, 8)]
    expect(discardSpanAt(lines, 0)).toBeNull()
    expect(discardSpanAt(lines, 2)).toEqual({ start: 7, end: 7, snapshot: ['mine'], restore: [] })
  })
})
