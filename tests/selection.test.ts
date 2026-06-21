import { describe, it, expect } from 'vitest'
import { sameScope } from '../src/renderer/lib/selection'

describe('sameScope', () => {
  it('matches identical region ids', () => {
    expect(sameScope({ region: 'summary' }, { region: 'summary' })).toBe(true)
    expect(sameScope({ region: 'section', sectionId: 's1' }, { region: 'section', sectionId: 's1' })).toBe(true)
    expect(sameScope({ region: 'artifact', path: 'a.md' }, { region: 'artifact', path: 'a.md' })).toBe(true)
    expect(sameScope({ region: 'file-note', file: 'a.ts' }, { region: 'file-note', file: 'a.ts' })).toBe(true)
  })

  it('distinguishes different regions and ids', () => {
    expect(sameScope({ region: 'summary' }, { region: 'section', sectionId: 's1' })).toBe(false)
    expect(sameScope({ region: 'section', sectionId: 's1' }, { region: 'section', sectionId: 's2' })).toBe(false)
    expect(sameScope({ region: 'artifact', path: 'a.md' }, { region: 'artifact', path: 'b.md' })).toBe(false)
    expect(sameScope({ region: 'file-note', file: 'a.ts' }, { region: 'file-note', file: 'b.ts' })).toBe(false)
  })
})
