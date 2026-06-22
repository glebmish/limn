import { describe, it, expect } from 'vitest'
import { limnSelector } from '../src/renderer/lib/focus'

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
