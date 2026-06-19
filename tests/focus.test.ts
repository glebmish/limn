import { describe, it, expect } from 'vitest'
import { lrSelector } from '../src/renderer/lib/focus'

describe('lrSelector', () => {
  it('maps each FocusTarget kind to its data-lr-* selector', () => {
    expect(lrSelector({ kind: 'summary' })).toBe('[data-lr-summary]')
    expect(lrSelector({ kind: 'section', sectionId: 's2' })).toBe('[data-lr-section="s2"]')
    expect(lrSelector({ kind: 'file', file: 'src/a.ts' })).toBe('[data-lr-file="src/a.ts"]')
    expect(lrSelector({ kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31, hunkRange: '', lineContent: '' }))
      .toBe('[data-lr-line="src/auth/jwt.ts:new:31"]')
  })

  it('escapes quotes in attribute values', () => {
    expect(lrSelector({ kind: 'file', file: 'a"b.ts' })).toBe('[data-lr-file="a\\"b.ts"]')
  })
})
