import { describe, expect, it } from 'vitest'
import type { DiffLine, FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import {
  caretAfterGrowth, discardSpanAt, fileEditable, frameGutter, frameKeyAction, lineColToCaret,
  narrowEdit, rawOffsetFromDisplayColumn
} from '../src/renderer/lib/edits'

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

  // ── #10: a one-line region that grows. ⏎ inserts a newline now, so the typed
  // text routinely has more lines than the snapshot it replaces.
  it('splits one line into two (⏎ mid-line)', () => {
    expect(narrowEdit(11, ['foo(bar)'], ['foo(', 'bar)']))
      .toEqual({ start: 11, end: 11, snapshot: ['foo(bar)'], newLines: ['foo(', 'bar)'] })
  })

  it('⏎ at the head of a one-line region is a pure insertion above it', () => {
    expect(narrowEdit(11, ['  return 2'], ['', '  return 2']))
      .toEqual({ start: 11, end: 10, snapshot: [], newLines: [''] })
  })

  it('⏎ at the tail of a one-line region is a pure insertion below it', () => {
    expect(narrowEdit(11, ['  return 2'], ['  return 2', '  // note']))
      .toEqual({ start: 12, end: 11, snapshot: [], newLines: ['  // note'] })
  })

  it('grows a one-line region by several lines at once', () => {
    expect(narrowEdit(11, ['a'], ['a1', 'a2', 'a3']))
      .toEqual({ start: 11, end: 11, snapshot: ['a'], newLines: ['a1', 'a2', 'a3'] })
  })
})

describe('frameKeyAction', () => {
  it('⌘⏎ and ctrl+⏎ save; esc cancels', () => {
    expect(frameKeyAction({ key: 'Enter', metaKey: true })).toBe('save')
    expect(frameKeyAction({ key: 'Enter', ctrlKey: true })).toBe('save')
    expect(frameKeyAction({ key: 'Escape' })).toBe('cancel')
  })

  it('plain ⏎ is not a save — the textarea inserts a newline (#10)', () => {
    expect(frameKeyAction({ key: 'Enter' })).toBeNull()
    expect(frameKeyAction({ key: 'Enter', shiftKey: true })).toBeNull()
  })

  it('leaves every other key to the textarea', () => {
    expect(frameKeyAction({ key: 'a' })).toBeNull()
    expect(frameKeyAction({ key: 'ArrowDown' })).toBeNull()
    expect(frameKeyAction({ key: 'Tab', metaKey: true })).toBeNull()
  })
})

describe('frameGutter', () => {
  // a 3-line region (11–13) reached by the ↑/↓ growth gesture
  const region = ['l11', 'l12', 'l13']

  it('an untouched region is just its own line numbers', () => {
    expect(frameGutter(11, region, region)).toEqual(['11', '12', '13'])
  })

  it('a mid-region ⏎ keeps the lines below numbered, not shifted', () => {
    // caret mid "l12", ⏎ → l12 becomes two rows; l13 is still the real line 13
    expect(frameGutter(11, region, ['l11', 'l12a', 'l12b', 'l13']))
      .toEqual(['11', '+', '+', '13'])
  })

  it('a ⏎ on the last row marks only the rows it created', () => {
    expect(frameGutter(11, region, ['l11', 'l12', 'l13a', 'l13b']))
      .toEqual(['11', '12', '+', '+'])
  })

  it('an interior insertion keeps both sides numbered', () => {
    expect(frameGutter(11, region, ['l11', 'new', 'l12', 'l13']))
      .toEqual(['11', '+', '12', '13'])
  })

  it('joining two lines shrinks the gutter and marks the join', () => {
    expect(frameGutter(11, region, ['l11', 'l12l13'])).toEqual(['11', '+'])
  })

  it('a one-line region grown at the tail keeps its number', () => {
    expect(frameGutter(11, ['x'], ['x', 'added'])).toEqual(['11', '+'])
  })

  it('a ⏎ at the head of a one-line region pushes the number down', () => {
    expect(frameGutter(11, ['x'], ['', 'x'])).toEqual(['+', '11'])
  })

  it("marks exactly the rows the save will rewrite — nothing more", () => {
    // the '+' rows are narrowEdit's newLines by construction: the gutter and the
    // CAS payload agree on what changed, because they share the same narrowing
    const typed = ['l11', 'l12a', 'l12b', 'l13']
    const marked = typed.filter((_, i) => frameGutter(11, region, typed)[i] === '+')
    expect(narrowEdit(11, region, typed)?.newLines).toEqual(marked)
  })
})

// ── #5: double-click focus + caret placement
describe('lineColToCaret', () => {
  it('a single-line frame is just the (clamped) column', () => {
    expect(lineColToCaret(['hello'], 0, 2)).toBe(2)
    expect(lineColToCaret(['hello'], 0, 0)).toBe(0)
  })

  it('clamps a column past the end of the line', () => {
    expect(lineColToCaret(['hello'], 0, 99)).toBe(5)
    expect(lineColToCaret(['hello'], 0, Infinity)).toBe(5) // the end-of-line fallback
  })

  it('clamps a negative column to the start of the line', () => {
    expect(lineColToCaret(['hello'], 0, -3)).toBe(0)
  })

  it('adds a newline for every line before the target', () => {
    // 'ab\ncd\nef' — line 2 ("ef"), column 1 → offset 6 ('a','b','\n','c','d','\n') + 1
    expect(lineColToCaret(['ab', 'cd', 'ef'], 2, 1)).toBe(7)
  })

  it('clamps an out-of-range line index to the last line', () => {
    expect(lineColToCaret(['ab', 'cd'], 5, 0)).toBe(3) // start of "cd"
    expect(lineColToCaret(['ab', 'cd'], -1, 0)).toBe(0) // start of "ab"
  })
})

// ── #6: caret placement after the ↑/↓ past-the-edge growth gesture
describe('caretAfterGrowth', () => {
  it('↑: prepended at the very start of the new text — offset is just the column', () => {
    // caret was at column 3 on the old first row; ↑ admits "hello" above it
    expect(caretAfterGrowth(0, 'hello', 3)).toBe(3)
    expect(caretAfterGrowth(0, 'hello', 0)).toBe(0)
  })

  it('↓: appended after the old text and its joining newline', () => {
    // old text was "ab\ncd" (length 5); ↓ admits "efg" below at column 1
    expect(caretAfterGrowth(6, 'efg', 1)).toBe(7) // 6 = "ab\ncd".length + 1
  })

  it('clamps the column to the admitted line\'s own length', () => {
    expect(caretAfterGrowth(0, 'hi', 99)).toBe(2)
    expect(caretAfterGrowth(0, 'hi', Infinity)).toBe(2)
    expect(caretAfterGrowth(6, 'hi', 99)).toBe(8)
  })

  it('clamps a negative column to the start of the admitted line', () => {
    expect(caretAfterGrowth(0, 'hi', -3)).toBe(0)
    expect(caretAfterGrowth(6, 'hi', -3)).toBe(6)
  })

  it('an empty admitted line always lands at its own (zero-width) position', () => {
    expect(caretAfterGrowth(0, '', 5)).toBe(0)
    expect(caretAfterGrowth(4, '', 5)).toBe(4)
  })
})

describe('rawOffsetFromDisplayColumn', () => {
  it('is the identity when the line has no tabs', () => {
    expect(rawOffsetFromDisplayColumn('hello world', 5)).toBe(5)
    expect(rawOffsetFromDisplayColumn('hello world', 0)).toBe(0)
  })

  it('a tab costs two display columns but one raw character', () => {
    // raw "\tfoo" displays as "  foo" (disp() in DiffBody.tsx)
    expect(rawOffsetFromDisplayColumn('\tfoo', 2)).toBe(1) // click right after the tab
    expect(rawOffsetFromDisplayColumn('\tfoo', 4)).toBe(3) // click after "  fo"
  })

  it('a click inside a tab expansion snaps to just past the tab', () => {
    expect(rawOffsetFromDisplayColumn('\tfoo', 1)).toBe(1)
  })

  it('clamps a display column past the end of the line', () => {
    expect(rawOffsetFromDisplayColumn('abc', 99)).toBe(3)
  })

  it('handles several leading tabs', () => {
    // "\t\tx" displays as "    x" (4 spaces + x)
    expect(rawOffsetFromDisplayColumn('\t\tx', 4)).toBe(2)
    expect(rawOffsetFromDisplayColumn('\t\tx', 5)).toBe(3)
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
