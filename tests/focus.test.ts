import { describe, it, expect } from 'vitest'
import { jumpTarget, limnSelector } from '../src/renderer/lib/focus'
import type { FocusTarget } from '../src/shared/types'

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
