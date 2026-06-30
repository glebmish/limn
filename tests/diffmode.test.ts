import { describe, it, expect } from 'vitest'
import { effectiveDiffMode, globalDiffModeSelection } from '../src/renderer/store'

describe('effectiveDiffMode', () => {
  it('falls back to the global mode when a file has no override', () => {
    expect(effectiveDiffMode('a.ts', 'approved', {})).toBe('approved')
  })
  it('uses the per-file override when present', () => {
    expect(effectiveDiffMode('a.ts', 'branch', { 'a.ts': 'viewed' })).toBe('viewed')
  })
})

describe('globalDiffModeSelection', () => {
  it('selects the global mode when no file diverges', () => {
    expect(globalDiffModeSelection('branch', {})).toBe('branch')
  })
  it('stays selected when an override matches the global mode', () => {
    expect(globalDiffModeSelection('approved', { 'a.ts': 'approved' })).toBe('approved')
  })
  it('deselects (mixed) once any file diverges from the global mode', () => {
    expect(globalDiffModeSelection('branch', { 'a.ts': 'viewed' })).toBeNull()
  })
})
