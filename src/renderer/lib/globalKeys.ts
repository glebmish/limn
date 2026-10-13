/** Guard for the screen-level `window` keydown handlers (Dashboard, RepoHub).
 *  Those handlers bind Enter/Backspace/arrows to navigation, and a window
 *  listener sees every key the page gets — including Enter in a textarea, Enter
 *  or Space on a focused button, and keys aimed at an open modal. */

const TEXT_ENTRY = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]'
const CONTROL = 'button,a,[role=button]'
const DIALOG = '[role=dialog],[role=alertdialog]'

/** Keys a focused control already acts on (activate, or delete-ish): the screen
 *  must not also navigate on them. Arrows pass through — a button has no use for
 *  them, so list navigation keeps working after clicking one. */
const CONTROL_KEYS = new Set(['Enter', ' ', 'Backspace'])

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'target'>

function closestOf(target: EventTarget | null, selector: string): boolean {
  const t = target as { closest?: (s: string) => unknown } | null
  return typeof t?.closest === 'function' && t.closest(selector) != null
}

/** True when no screen-level shortcut should run at all: something already
 *  handled the key, a modal is open, or the key came from inside a dialog. */
export function globalKeysSuspended(e: KeyEventLike, dialogOpen: boolean): boolean {
  return e.defaultPrevented || dialogOpen || closestOf(e.target, DIALOG)
}

/** True when a screen-level navigation key should be ignored. `allow` exempts
 *  one element the screen deliberately drives from the keyboard (the Dashboard
 *  filter input, whose ↑↓⏎ steer the repo list). */
export function globalKeyBlocked(
  e: KeyEventLike,
  opts: { dialogOpen: boolean; allow?: Element | null }
): boolean {
  if (globalKeysSuspended(e, opts.dialogOpen)) return true
  if (opts.allow && e.target === opts.allow) return false
  if (closestOf(e.target, TEXT_ENTRY)) return true
  if (closestOf(e.target, CONTROL)) return CONTROL_KEYS.has(e.key)
  return false
}
