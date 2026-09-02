import { describe, expect, it } from 'vitest'
import { saveChordLabel } from '../src/renderer/lib/platform'

describe('saveChordLabel', () => {
  it('names the Apple chord on Mac/iPhone/iPad platform strings', () => {
    expect(saveChordLabel('MacIntel')).toBe('⌘⏎')
    expect(saveChordLabel('iPhone')).toBe('⌘⏎')
    expect(saveChordLabel('iPad')).toBe('⌘⏎')
  })

  it('names Ctrl+Enter everywhere else', () => {
    expect(saveChordLabel('Win32')).toBe('Ctrl+⏎')
    expect(saveChordLabel('Linux x86_64')).toBe('Ctrl+⏎')
    expect(saveChordLabel('')).toBe('Ctrl+⏎')
  })
})
