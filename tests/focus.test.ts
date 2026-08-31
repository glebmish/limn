import { describe, it, expect } from 'vitest'
import { commentJumpTarget, jumpTarget, limnSelector } from '../src/renderer/lib/focus'
import type { Comment, FocusTarget } from '../src/shared/types'

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
