import { describe, it, expect } from 'vitest'
import { nextTrapTarget } from '../src/renderer/components/SettingsDialog'

// nextTrapTarget is pure reference logic, so fake "elements" (plain objects) are
// enough to exercise every branch without a DOM. Cast to HTMLElement for the call.
const el = (name: string) => ({ name }) as unknown as HTMLElement

describe('nextTrapTarget (SettingsDialog Tab-wrap trap)', () => {
  const a = el('a')
  const b = el('b')
  const c = el('c')
  const list = [a, b, c]

  it('wraps Tab off the last element back to the first', () => {
    expect(nextTrapTarget(list, c, false)).toBe(a)
  })

  it('wraps Shift+Tab off the first element to the last', () => {
    expect(nextTrapTarget(list, a, true)).toBe(c)
  })

  it('does nothing (null) for Tab in the middle — browser handles it', () => {
    expect(nextTrapTarget(list, b, false)).toBeNull()
  })

  it('does nothing for Shift+Tab in the middle', () => {
    expect(nextTrapTarget(list, b, true)).toBeNull()
  })

  it('does nothing for Tab on the first or Shift+Tab on the last (no wrap needed)', () => {
    expect(nextTrapTarget(list, a, false)).toBeNull()
    expect(nextTrapTarget(list, c, true)).toBeNull()
  })

  it('returns null when nothing is focused or the list is empty', () => {
    expect(nextTrapTarget(list, null, false)).toBeNull()
    expect(nextTrapTarget([], a, false)).toBeNull()
    expect(nextTrapTarget([], null, true)).toBeNull()
  })

  it('treats a single focusable as both first and last (wraps to itself)', () => {
    expect(nextTrapTarget([a], a, false)).toBe(a)
    expect(nextTrapTarget([a], a, true)).toBe(a)
  })
})
