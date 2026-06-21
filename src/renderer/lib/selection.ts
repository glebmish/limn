import type { SelectionScope } from '../../shared/types'

/** Do two selection scopes refer to the same prose region? */
export function sameScope(a: SelectionScope, b: SelectionScope): boolean {
  if (a.region !== b.region) return false
  switch (a.region) {
    case 'summary': return true
    case 'section': return a.sectionId === (b as Extract<SelectionScope, { region: 'section' }>).sectionId
    case 'artifact': return a.path === (b as Extract<SelectionScope, { region: 'artifact' }>).path
    case 'file-note': return a.file === (b as Extract<SelectionScope, { region: 'file-note' }>).file
  }
}

/** Up to this many chars of surrounding text are stored for disambiguation. */
const CTX = 32

export interface CapturedSelection {
  quote: string
  prefix: string
  suffix: string
  /** position (relative to the container's top-left) for a floating control */
  x: number
  y: number
}

/** Capture the current window selection when it is non-empty and fully inside
 *  `container`; null otherwise. quote is the selected text; prefix/suffix are the
 *  surrounding context used to disambiguate the quote for the agent. */
export function captureSelection(container: HTMLElement): CapturedSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
  const quote = sel.toString().trim()
  if (!quote) return null

  const before = range.cloneRange()
  before.selectNodeContents(container)
  before.setEnd(range.startContainer, range.startOffset)
  const prefix = before.toString().slice(-CTX)

  const after = range.cloneRange()
  after.selectNodeContents(container)
  after.setStart(range.endContainer, range.endOffset)
  const suffix = after.toString().slice(0, CTX)

  const r = range.getBoundingClientRect()
  const box = container.getBoundingClientRect()
  return { quote, prefix, suffix, x: r.left - box.left + r.width / 2, y: r.bottom - box.top }
}
