import { describe, expect, it } from 'vitest'
import { globalKeyBlocked, globalKeysSuspended } from '../src/renderer/lib/globalKeys'

// #8: the Dashboard/RepoHub window keydown handlers navigated on Enter/Backspace
// with no target check — Enter in the Settings › Actions prompt textarea opened a
// repo, Enter on a focused Save button navigated, Backspace on a button went back
// to the dashboard. No jsdom here: a fake target whose closest() matches by tag.

/** A stand-in element: `closest(sel)` matches when any selector alternative is
 *  one of the given tags/attribute strings (enough for the helper's selectors). */
function el(...matches: string[]): EventTarget {
  return {
    closest: (sel: string) => (sel.split(',').some((s) => matches.includes(s.trim())) ? {} : null)
  } as unknown as EventTarget
}
const ev = (key: string, target: EventTarget | null, defaultPrevented = false) => ({ key, target, defaultPrevented })

describe('globalKeyBlocked (#8)', () => {
  it('lets keys on the page body through', () => {
    expect(globalKeyBlocked(ev('Enter', el()), { dialogOpen: false })).toBe(false)
    expect(globalKeyBlocked(ev('Backspace', el()), { dialogOpen: false })).toBe(false)
  })

  it('blocks everything while a dialog is open or the key was already handled', () => {
    expect(globalKeyBlocked(ev('Enter', el()), { dialogOpen: true })).toBe(true)
    expect(globalKeyBlocked(ev('Enter', el(), true), { dialogOpen: false })).toBe(true)
    expect(globalKeysSuspended(ev('ArrowDown', el('[role=dialog]')), false)).toBe(true)
  })

  it('blocks Enter in a textarea (the Settings prompt field) and in other inputs', () => {
    expect(globalKeyBlocked(ev('Enter', el('textarea')), { dialogOpen: false })).toBe(true)
    expect(globalKeyBlocked(ev('ArrowDown', el('input')), { dialogOpen: false })).toBe(true)
    expect(globalKeyBlocked(ev('Enter', el('select')), { dialogOpen: false })).toBe(true)
  })

  it('blocks Enter/Space/Backspace on a focused button or link, but not arrows', () => {
    for (const t of [el('button'), el('a'), el('[role=button]')]) {
      expect(globalKeyBlocked(ev('Enter', t), { dialogOpen: false })).toBe(true)
      expect(globalKeyBlocked(ev(' ', t), { dialogOpen: false })).toBe(true)
      expect(globalKeyBlocked(ev('Backspace', t), { dialogOpen: false })).toBe(true)
      expect(globalKeyBlocked(ev('ArrowDown', t), { dialogOpen: false })).toBe(false)
    }
  })

  it('exempts the one element the screen drives (the Dashboard filter input)', () => {
    const filter = el('input') as unknown as Element
    expect(globalKeyBlocked(ev('Enter', filter), { dialogOpen: false, allow: filter })).toBe(false)
    expect(globalKeyBlocked(ev('Enter', filter), { dialogOpen: true, allow: filter })).toBe(true)
  })

  it('tolerates a non-element target', () => {
    expect(globalKeyBlocked(ev('Enter', null), { dialogOpen: false })).toBe(false)
  })
})
