import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import { UNIFIED, type Stack } from '../src/shared/diffStack'
import { stackKeyAction } from '../src/renderer/lib/useStackKeys'

const hunk = { range: '@@', header: '', lines: [] }
const files: FileDiff[] = [
  { path: 'a.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [hunk], sinceHunks: [hunk] },
  { path: 'b.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [hunk] }
]
const state = (diffStack: Stack = UNIFIED, fileStack: Record<string, Stack> = {}) => ({ diffStack, fileStack })

describe('[ and ] on the current file', () => {
  it('[ pulls the next sheet, ] puts the last one back', () => {
    expect(stackKeyAction({ key: '[' }, 'a.ts', files, state())).toEqual({ path: 'a.ts', next: { out: ['base'], against: 'base' }, spread: false })
    expect(stackKeyAction({ key: '[' }, 'a.ts', files, state(UNIFIED, { 'a.ts': { out: ['base'], against: 'base' } })))
      .toEqual({ path: 'a.ts', next: { out: ['base', 'approved'], against: 'base' }, spread: false })
    expect(stackKeyAction({ key: ']' }, 'a.ts', files, state({ out: ['approved', 'base'], against: 'base' })))
      .toEqual({ path: 'a.ts', next: { out: ['approved'], against: 'base' }, spread: false })
  })
  it('⇧ spreads, and the shifted glyphs / physical keys count too', () => {
    expect(stackKeyAction({ key: '{', shiftKey: true }, 'a.ts', files, state())?.spread).toBe(true)
    expect(stackKeyAction({ key: 'Dead', code: 'BracketRight', shiftKey: true }, 'a.ts', files, state({ out: ['base'], against: 'base' }))?.spread).toBe(true)
  })
  it('does nothing with nothing to pull or put back', () => {
    expect(stackKeyAction({ key: ']' }, 'a.ts', files, state())).toBeNull()
    expect(stackKeyAction({ key: '[' }, 'b.ts', files, state({ out: ['base'], against: 'base' }))).toBeNull() // b.ts has only the base sheet
  })
  it('stays out of text fields, chords, other keys and unknown files', () => {
    expect(stackKeyAction({ key: '[', inField: true }, 'a.ts', files, state())).toBeNull()
    expect(stackKeyAction({ key: '[', metaKey: true }, 'a.ts', files, state())).toBeNull()
    expect(stackKeyAction({ key: 'j' }, 'a.ts', files, state())).toBeNull()
    expect(stackKeyAction({ key: '[' }, null, files, state())).toBeNull()
    expect(stackKeyAction({ key: '[' }, 'zzz.ts', files, state())).toBeNull()
  })
})
