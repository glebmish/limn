import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffLine, FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import type { FrameDraft } from '../src/renderer/lib/edits'
import {
  caretAfterGrowth, discardSpanAt, discardSpansForRun, fileEditable, frameDeletesLines, frameGutter, frameHint,
  frameKeyAction, lineColToCaret, narrowEdit, newFrameId, rawOffsetFromDisplayColumn, reapplyCue,
  seedFrameCaret, seedFrameRestore, seedFrameText, selectionAfterSave
} from '../src/renderer/lib/edits'

/** a draft literal with the two durability fields defaulted — most cases only care
 *  about text/caret, and spelling `fileLines: null, yours: null` out every time buries
 *  what each case is actually about. */
const mkDraft = (over: Partial<FrameDraft> & { frameId: string }): FrameDraft =>
  ({ text: '', caret: null, fileLines: null, yours: null, ...over })

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

  // ── #8: a region that *shrinks*. Backspacing a newline joins two rows, so the
  // typed text routinely has fewer lines than the snapshot it replaces.
  it('shrinks a 3-line region to 2 by joining its last two rows', () => {
    expect(narrowEdit(11, ['a', 'b', 'c'], ['a', 'bc']))
      .toEqual({ start: 12, end: 13, snapshot: ['b', 'c'], newLines: ['bc'] })
  })

  it('shrinks a 3-line region to 2 by emptying its middle row', () => {
    expect(narrowEdit(11, ['a', 'b', 'c'], ['a', 'c']))
      .toEqual({ start: 12, end: 12, snapshot: ['b'], newLines: [] })
  })

  // ── #8: zero lines. A textarea can never *hold* zero lines ('' splits to ['']),
  // so the delete gesture hands narrowEdit an explicit empty `typed`; the result is
  // a pure deletion — the region's lines leave the file entirely.
  it('a zero-line result deletes the whole one-line region', () => {
    expect(narrowEdit(11, ['  return 2'], []))
      .toEqual({ start: 11, end: 11, snapshot: ['  return 2'], newLines: [] })
  })

  it('a zero-line result deletes every line of a multi-line region', () => {
    expect(narrowEdit(11, ['a', 'b', 'c'], []))
      .toEqual({ start: 11, end: 13, snapshot: ['a', 'b', 'c'], newLines: [] })
  })

  it('an emptied region is NOT a deletion — it leaves one blank line', () => {
    // the distinction the ⌫ cue exists to make: ⌘⏎ on empty text writes a blank
    // line, ⌫ removes the line
    expect(narrowEdit(11, ['  return 2'], ['']))
      .toEqual({ start: 11, end: 11, snapshot: ['  return 2'], newLines: [''] })
  })
})

describe('selectionAfterSave', () => {
  // a 20-line file throughout
  it('an ordinary or growing save selects the line just edited', () => {
    expect(selectionAfterSave({ start: 5, end: 5, snapshot: ['a'], newLines: ['b'] }, 20)).toBe(5)
    expect(selectionAfterSave({ start: 5, end: 5, snapshot: ['a'], newLines: ['b', 'c'] }, 20)).toBe(5)
    // pure insertion (end = start − 1, empty snapshot)
    expect(selectionAfterSave({ start: 6, end: 5, snapshot: [], newLines: ['new'] }, 20)).toBe(6)
  })

  it('a deletion mid-file selects the line that moved up into its place (#8)', () => {
    expect(selectionAfterSave({ start: 5, end: 5, snapshot: ['a'], newLines: [] }, 20)).toBe(5)
    expect(selectionAfterSave({ start: 5, end: 7, snapshot: ['a', 'b', 'c'], newLines: [] }, 20)).toBe(5)
  })

  it('a deletion running to EOF clamps to the file’s new last line (#8)', () => {
    // deleting line 20 of 20: nothing moves up, so the selection falls back to 19
    expect(selectionAfterSave({ start: 20, end: 20, snapshot: ['a'], newLines: [] }, 20)).toBe(19)
    // deleting 18–20: new EOF is 17
    expect(selectionAfterSave({ start: 18, end: 20, snapshot: ['a', 'b', 'c'], newLines: [] }, 20)).toBe(17)
  })

  it('deleting every line leaves nothing to select', () => {
    expect(selectionAfterSave({ start: 1, end: 3, snapshot: ['a', 'b', 'c'], newLines: [] }, 3)).toBeNull()
  })
})

describe('frameDeletesLines', () => {
  it('is true only once the whole region is typed away to nothing (#8)', () => {
    expect(frameDeletesLines('', true)).toBe(true)
    expect(frameDeletesLines('x', true)).toBe(false)
    expect(frameDeletesLines(' ', true)).toBe(false) // whitespace is content
    expect(frameDeletesLines('\n', true)).toBe(false) // two blank lines, still rows
  })

  it('never arms while the frame is still loading its file', () => {
    // a frame mounts with text '' and no file yet — the disabled textarea must not
    // advertise (or accept) a deletion it has no snapshot to anchor
    expect(frameDeletesLines('', false)).toBe(false)
  })
})

describe('frameHint', () => {
  it('the ordinary keymap hint, chord named explicitly', () => {
    expect(frameHint(false, 'line 11', '⌘⏎')).toBe('⌘⏎ save · ⏎ new line · esc cancel · ↑/↓ past the edge extends')
    expect(frameHint(false, 'line 11', 'Ctrl+⏎')).toBe('Ctrl+⏎ save · ⏎ new line · esc cancel · ↑/↓ past the edge extends')
  })

  it('names what ⌫ is about to remove, and what the given chord would do instead (#8)', () => {
    expect(frameHint(true, 'line 11', '⌘⏎')).toBe('⌫ deletes line 11 · ⌘⏎ leaves a blank line · esc cancel')
    expect(frameHint(true, 'lines 11–13', '⌘⏎')).toBe('⌫ deletes lines 11–13 · ⌘⏎ leaves a blank line · esc cancel')
    expect(frameHint(true, 'line 11', 'Ctrl+⏎')).toBe('⌫ deletes line 11 · Ctrl+⏎ leaves a blank line · esc cancel')
  })
})

describe('reapplyCue', () => {
  it('an ordinary re-apply (no deletion) carries no danger cue', () => {
    expect(reapplyCue([])).toEqual({ danger: false, title: 'Re-apply' })
  })

  it('re-applying a single-line deletion names the count, singular', () => {
    expect(reapplyCue([11])).toEqual({ danger: true, title: 'Re-apply — deletes 1 line' })
  })

  it('re-applying a multi-line deletion names the count, plural', () => {
    expect(reapplyCue([11, 12, 13])).toEqual({ danger: true, title: 'Re-apply — deletes 3 lines' })
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

  // ── #8: ⌫ on an already-empty region removes its lines from the file
  it('⌫ deletes only once the region is empty', () => {
    expect(frameKeyAction({ key: 'Backspace' }, true)).toBe('delete')
    expect(frameKeyAction({ key: 'Backspace' }, false)).toBeNull()
    expect(frameKeyAction({ key: 'Backspace' })).toBeNull() // default: never
  })

  it('shift+⌫ still deletes; a modified ⌫ is left to the textarea', () => {
    expect(frameKeyAction({ key: 'Backspace', shiftKey: true }, true)).toBe('delete')
    // ⌘⌫ / ⌥⌫ are the textarea's own delete-to-start / delete-word — no-ops on an
    // empty value, and not the gesture the ⌫ cue advertises
    expect(frameKeyAction({ key: 'Backspace', metaKey: true }, true)).toBeNull()
    expect(frameKeyAction({ key: 'Backspace', ctrlKey: true }, true)).toBeNull()
    expect(frameKeyAction({ key: 'Backspace', altKey: true }, true)).toBeNull()
  })

  // The cue is only a cue if a human can see it: a held ⌫ arms the frame on the
  // keystroke that clears the last character (React flushes onChange's setText before
  // the next browser event) and auto-repeats 15–90 ms later — far below reaction time.
  // Only a fresh press deletes, so the cue is always on screen first.
  it('a held ⌫ never deletes — the repeat is a no-op, a fresh press deletes', () => {
    expect(frameKeyAction({ key: 'Backspace', repeat: true }, true)).toBeNull()
    expect(frameKeyAction({ key: 'Backspace', repeat: false }, true)).toBe('delete')
    expect(frameKeyAction({ key: 'Backspace' }, true)).toBe('delete') // absent ⇒ fresh
  })

  it('key repeat gates only the delete — a held esc still cancels', () => {
    expect(frameKeyAction({ key: 'Escape', repeat: true }, true)).toBe('cancel')
    expect(frameKeyAction({ key: 'Enter', metaKey: true, repeat: true }, true)).toBe('save')
  })

  it('esc and ⌘⏎ still win over the delete state', () => {
    expect(frameKeyAction({ key: 'Escape' }, true)).toBe('cancel')
    expect(frameKeyAction({ key: 'Enter', metaKey: true }, true)).toBe('save')
    expect(frameKeyAction({ key: 'Delete' }, true)).toBeNull() // ⌦ is not the gesture
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

// ── #6 fix-round-1: the live draft that lets a forced remount (growth crossing a
// real git-hunk boundary) restore what the user typed instead of silently
// re-seeding from disk.
describe('seedFrameText', () => {
  it('no draft at all — falls back to disk', () => {
    expect(seedFrameText(null, 'a', 'disk content')).toBe('disk content')
  })

  it('a draft for this exact session wins over disk', () => {
    expect(seedFrameText(mkDraft({ frameId: 'a', text: 'typed content', caret: 3 }), 'a', 'disk content'))
      .toBe('typed content')
  })

  it('a draft for a DIFFERENT session is ignored — never leaks into a new edit', () => {
    expect(seedFrameText(mkDraft({ frameId: 'a', text: 'stale from another edit', caret: 3 }), 'b', 'disk content'))
      .toBe('disk content')
  })
})

describe('seedFrameCaret', () => {
  it('no draft — falls back', () => {
    expect(seedFrameCaret(null, 'a', 7)).toBe(7)
  })

  it('a draft for this session with a recorded caret wins over the fallback', () => {
    expect(seedFrameCaret(mkDraft({ frameId: 'a', text: 'x', caret: 4 }), 'a', 7)).toBe(4)
  })

  it('a draft for this session with no recorded caret (null) still falls back', () => {
    expect(seedFrameCaret(mkDraft({ frameId: 'a', text: 'x', caret: null }), 'a', 7)).toBe(7)
  })

  it('a draft for a different session is ignored', () => {
    expect(seedFrameCaret(mkDraft({ frameId: 'a', text: 'x', caret: 4 }), 'b', 7)).toBe(7)
  })
})

// ── final review, findings 2+3: the draft carries the *snapshot the text was typed
// against* and the conflict banner, so a remount restores the whole edit — not just
// the characters. Re-fetching `fileLines` while keeping the text would re-anchor the
// CAS to content the user never saw (an external write between the first fetch and
// the remount would then save silently instead of conflicting).
describe('seedFrameRestore', () => {
  it('no draft — nothing to restore, the frame fetches from disk', () => {
    expect(seedFrameRestore(null, 'a')).toBeNull()
  })

  it('a draft for a DIFFERENT session restores nothing', () => {
    expect(seedFrameRestore(mkDraft({ frameId: 'a', text: 'typed', fileLines: ['x'] }), 'b')).toBeNull()
  })

  it('a draft with no snapshot restores nothing — there is no CAS anchor to keep', () => {
    expect(seedFrameRestore(mkDraft({ frameId: 'a', text: 'typed', fileLines: null }), 'a')).toBeNull()
  })

  it('a matching draft restores the text AND the fileLines it was typed against', () => {
    const d = mkDraft({ frameId: 'a', text: 'typed', caret: 2, fileLines: ['one', 'two'] })
    expect(seedFrameRestore(d, 'a')).toEqual({ text: 'typed', fileLines: ['one', 'two'], yours: null })
  })

  it('carries the conflict banner (kept text / delete intent) across the remount', () => {
    const yours = { text: 'my version', removes: [] }
    const d = mkDraft({ frameId: 'a', text: 'fresh', fileLines: ['fresh'], yours })
    expect(seedFrameRestore(d, 'a')).toEqual({ text: 'fresh', fileLines: ['fresh'], yours })
  })

  it('carries a delete intent, not just text — the banner must not degrade to a blank line', () => {
    const yours = { text: '', removes: [11, 12] }
    const d = mkDraft({ frameId: 'a', text: 'fresh', fileLines: ['fresh'], yours })
    expect(seedFrameRestore(d, 'a')?.yours).toEqual(yours)
  })
})

// ── final review, finding 1: `crypto.randomUUID` is SecureContext-only, and
// docs/using-limn.md tells Tailscale users to open plain `http://<tailnet-ip>:5466`.
// A frame id has to be mintable there too, or in-place editing throws on every open.
describe('newFrameId', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('uses crypto.randomUUID where it exists', () => {
    expect(newFrameId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('falls back to getRandomValues in an insecure context (no randomUUID)', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
    const a = newFrameId()
    const b = newFrameId()
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
  })

  it('falls back again when the whole Web Crypto API is missing', () => {
    vi.stubGlobal('crypto', undefined)
    const ids = new Set(Array.from({ length: 50 }, () => newFrameId()))
    expect(ids.size).toBe(50)
    expect([...ids].every((id) => id.length > 0)).toBe(true)
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

describe('discardSpansForRun', () => {
  it('gives every row of a span the same span object, and one walk per span', () => {
    const lines = [ctx(9, 9), del(10, 'old text', 'unstaged'), add(10, 'new text', 'unstaged'), ctx(11, 11)]
    const spans = discardSpansForRun(lines)
    expect(spans.length).toBe(lines.length)
    expect(spans[0]).toBeNull()
    expect(spans[3]).toBeNull()
    expect(spans[1]).toEqual({ start: 10, end: 10, snapshot: ['new text'], restore: ['old text'] })
    expect(spans[2]).toBe(spans[1]) // one span, shared — not one walk per row
  })

  it('keeps two spans in one run apart', () => {
    const lines = [add(5, 'a', 'unstaged'), ctx(6, 6), add(7, 'b', 'unstaged')]
    const spans = discardSpansForRun(lines)
    expect(spans[0]).toEqual({ start: 5, end: 5, snapshot: ['a'], restore: [] })
    expect(spans[2]).toEqual({ start: 7, end: 7, snapshot: ['b'], restore: [] })
    expect(spans[1]).toBeNull()
  })

  it('marks a refused span null on every one of its rows, as discardSpanAt does', () => {
    const mixed = [ctx(9, 9), add(10, 'stg', 'staged'), add(11, 'unstg', 'unstaged'), ctx(10, 12)]
    expect(discardSpansForRun(mixed)).toEqual([null, null, null, null])
    const delOnly = [ctx(9, 9), del(10, 'gone', 'unstaged'), ctx(11, 10)]
    expect(discardSpansForRun(delOnly)).toEqual([null, null, null])
  })

  it('agrees with discardSpanAt at every index', () => {
    const lines = [
      ctx(9, 9), add(10, 'stg', 'staged'), ctx(10, 11),
      del(11, 'old', 'unstaged'), add(12, 'new', 'unstaged'), ctx(12, 13)
    ]
    expect(discardSpansForRun(lines)).toEqual(lines.map((_, i) => discardSpanAt(lines, i)))
  })
})
