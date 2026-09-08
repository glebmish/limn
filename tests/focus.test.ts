import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { Comment, FocusTarget, Section } from '../src/shared/types'
import { makeLoaded } from './helpers/loaded'

// the seam: focusAnchor's own jump-execution step, irrelevant to the section-
// resolution rule this file pins below — stubbed so it never touches `document`
// (this suite runs without a DOM).
vi.mock('../src/renderer/lib/focusScroll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/lib/focusScroll')>()),
  startFocusJump: vi.fn()
}))

const { commentJumpTarget, jumpTarget, limnSelector, focusAnchor } = await import('../src/renderer/lib/focus')
const { useStore } = await import('../src/renderer/store')

describe('limnSelector', () => {
  it('maps each FocusTarget kind to its data-limn-* selector', () => {
    expect(limnSelector({ kind: 'summary' })).toBe('[data-limn-summary]')
    expect(limnSelector({ kind: 'section', sectionId: 's2' })).toBe('[data-limn-section="s2"]')
    expect(limnSelector({ kind: 'file', file: 'src/a.ts' })).toBe('[data-limn-file="src/a.ts"]')
    expect(limnSelector({ kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31, hunkRange: '', lineContent: '' }))
      .toBe('[data-limn-line="src/auth/jwt.ts:new:31"]')
  })

  it('escapes quotes in attribute values', () => {
    expect(limnSelector({ kind: 'file', file: 'a"b.ts' })).toBe('[data-limn-file="a\\"b.ts"]')
  })
})

// #18: the re-anchor pass flags a stop/narration anchor it could not place. Jumping
// by its line number would flash whatever code now occupies that line.
describe('jumpTarget', () => {
  const diff = (stale?: 'lost' | 'off-surface'): FocusTarget =>
    ({ kind: 'diff', file: 'src/a.ts', side: 'new', line: 14, hunkRange: '', lineContent: 'x', ...(stale ? { stale } : {}) })

  it('degrades a stale diff anchor to its file', () => {
    expect(jumpTarget(diff('lost'))).toEqual({ kind: 'file', file: 'src/a.ts' })
    expect(jumpTarget(diff('off-surface'))).toEqual({ kind: 'file', file: 'src/a.ts' })
  })

  it('passes an unflagged anchor (and every non-diff kind) straight through', () => {
    expect(jumpTarget(diff())).toEqual(diff())
    expect(jumpTarget({ kind: 'summary' })).toEqual({ kind: 'summary' })
    expect(jumpTarget({ kind: 'file', file: 'src/a.ts' })).toEqual({ kind: 'file', file: 'src/a.ts' })
  })
})

// A comment records the same "could not place it" verdict as `stale`, only under
// different names (`notInDiff` / status 'outdated'). Its jumps must degrade the same
// way, or a lost comment still flashes whatever code now holds its old line.
describe('commentJumpTarget', () => {
  const cmt = (over: Partial<Comment> = {}): Comment => ({
    id: 'c1', author: 'user', text: 't', status: 'queued', replies: [], createdAt: 'now', iteration: 1,
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 14, hunkRange: '', lineContent: 'x' },
    ...over
  })

  it('degrades a notInDiff or outdated diff comment to its file', () => {
    expect(commentJumpTarget(cmt({ notInDiff: true }))).toEqual({ kind: 'file', file: 'src/a.ts' })
    expect(commentJumpTarget(cmt({ status: 'outdated' }))).toEqual({ kind: 'file', file: 'src/a.ts' })
  })

  it('passes a located diff comment and the other focusable kinds through', () => {
    expect(commentJumpTarget(cmt())).toEqual(cmt().anchor)
    expect(commentJumpTarget(cmt({ anchor: { kind: 'summary' } }))).toEqual({ kind: 'summary' })
    expect(commentJumpTarget(cmt({ anchor: { kind: 'file', file: 'src/a.ts' } }))).toEqual({ kind: 'file', file: 'src/a.ts' })
    expect(commentJumpTarget(cmt({ anchor: { kind: 'section', sectionId: 's1' } }))).toEqual({ kind: 'section', sectionId: 's1' })
  })

  it('returns null for anchors no jump can land on (artifact, plan-step, …)', () => {
    expect(commentJumpTarget(cmt({ anchor: { kind: 'artifact', path: 'spec.md', line: 3, lineContent: 'x' } }))).toBeNull()
    expect(commentJumpTarget(cmt({ anchor: { kind: 'question', questionId: 'q1' } }))).toBeNull()
  })
})

// #90: focusAnchor stamps the target's owning section onto focusTarget so a file/
// line jump force-opens the section that holds it. That rule is `sectionIndex`'s
// path→first-section tie-break (fileOrder.ts) — pinned here so a jump keeps using
// the ONE implementation of it rather than growing a second one that can drift.
describe('focusAnchor: section resolution', () => {
  const section = (id: string, files: string[]): Section => ({ id, name: id, files, narration: [] })

  beforeEach(() => {
    useStore.setState({
      loaded: makeLoaded({ sections: [section('s1', ['a.ts', 'shared.ts']), section('s2', ['b.ts', 'shared.ts'])] }),
      docPath: null,
      focusTarget: null
    })
  })

  it('stamps a file anchor with the section that lists it', () => {
    focusAnchor({ kind: 'file', file: 'b.ts' })
    expect(useStore.getState().focusTarget).toEqual({ file: 'b.ts', sectionId: 's2' })
  })

  it('stamps a diff anchor the same way', () => {
    focusAnchor({ kind: 'diff', file: 'b.ts', side: 'new', line: 3, hunkRange: '', lineContent: '' })
    expect(useStore.getState().focusTarget).toEqual({ file: 'b.ts', sectionId: 's2' })
  })

  it('a path two sections list lands on the first one (sectionIndex tie-break)', () => {
    focusAnchor({ kind: 'file', file: 'shared.ts' })
    expect(useStore.getState().focusTarget).toEqual({ file: 'shared.ts', sectionId: 's1' })
  })

  it('a path no section claims gets no sectionId', () => {
    focusAnchor({ kind: 'file', file: 'loose.ts' })
    expect(useStore.getState().focusTarget).toEqual({ file: 'loose.ts' })
  })

  it('a summary anchor clears the focus target instead', () => {
    useStore.setState({ focusTarget: { file: 'a.ts', sectionId: 's1' } })
    focusAnchor({ kind: 'summary' })
    expect(useStore.getState().focusTarget).toBeNull()
  })
})
