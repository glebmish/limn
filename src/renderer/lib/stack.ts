import type { FileDiff, Hunk } from '../../shared/types'
import { CHECKPOINTS, SHEET_ORDER, normalizeStack, type Sheet, type Stack } from '../../shared/diffStack'
import type { Layout } from './rows'

/** The stack's pure rules (design board 13, W1). Everything the strip, the captions
 *  and the keyboard do to a file's stack goes through here; the components only
 *  render the result. `out` is kept in PULL order so − knows what to put back. */

/** The sheets this file can show: base always; a checkpoint only where the server
 *  attached that slice for THIS file (a file never viewed has no file-view sheet). */
export function sheetsFor(f: FileDiff): Sheet[] {
  return [
    'base',
    ...(f.sinceReviewHunks ? (['review'] as const) : []),
    ...(f.sinceHunks ? (['approved'] as const) : []),
    ...(f.sinceViewedHunks ? (['viewed'] as const) : [])
  ]
}

/** The requested stack narrowed to what the file has. A default of base · approval on
 *  a file with no approval sheet is just base beside current; a Unified baseline the
 *  file lacks falls back to the full diff. */
export function effectiveStack(requested: Stack, f: FileDiff): Stack {
  const avail = sheetsFor(f)
  return normalizeStack({
    out: requested.out.filter((s) => avail.includes(s)),
    against: avail.includes(requested.against) ? requested.against : 'base'
  })
}

export function displayOrder(out: Sheet[]): Sheet[] {
  return [...out].sort((a, b) => SHEET_ORDER.indexOf(a) - SHEET_ORDER.indexOf(b))
}

/** The columns beside current, in display order. */
export function columnsFor(stack: Stack): Sheet[] {
  return displayOrder(stack.out)
}

export function layoutFor(stack: Stack): Layout {
  return stack.out.length === 0 ? 'unified' : stack.out.length === 1 ? 'split' : 'multi'
}

/** The checkpoint the drift rails are measured from — the one worth pulling first:
 *  the approval, else the sha the review was generated at, else the file's own view
 *  mark. Null for a file with no checkpoint at all. */
function basisCheckpoint(avail: Sheet[]): Sheet | null {
  for (const s of ['approved', 'review', 'viewed'] as const) if (avail.includes(s)) return s
  return null
}

/** What the tab pulls next: first whatever Unified is measured against, then a
 *  checkpoint if none is out, then the base, then the remaining checkpoints oldest
 *  first. Null once every available sheet is out. */
export function nextPull(stack: Stack, avail: Sheet[]): Sheet | null {
  const has = (s: Sheet): boolean => stack.out.includes(s)
  if (stack.out.length === 0) return avail.includes(stack.against) ? stack.against : 'base'
  const cps = stack.out.filter((s) => s !== 'base')
  if (cps.length === 0) {
    const b = basisCheckpoint(avail)
    if (b && !has(b)) return b
  }
  if (!has('base')) return 'base'
  for (const s of CHECKPOINTS) if (avail.includes(s) && !has(s)) return s
  return null
}

export function pull(stack: Stack, sheet: Sheet): Stack {
  if (stack.out.includes(sheet)) return stack
  return normalizeStack({ out: [...stack.out, sheet], against: stack.against })
}

/** Closing the last sheet folds it under: Unified is then measured against it
 *  (closing base leaves the baseline alone). */
function without(stack: Stack, sheet: Sheet): Stack {
  const out = stack.out.filter((s) => s !== sheet)
  const against = out.length === 0 && sheet !== 'base' ? sheet : stack.against
  return normalizeStack({ out, against })
}

/** − : put the last-pulled sheet back. */
export function pop(stack: Stack): Stack {
  if (stack.out.length === 0) return stack
  return without(stack, stack.out[stack.out.length - 1])
}

/** × on a column. */
export function close(stack: Stack, sheet: Sheet): Stack {
  return without(stack, sheet)
}

/** A caption picker: the sheet keeps its place in pull order. */
export function replace(stack: Stack, from: Sheet, to: Sheet): Stack {
  if (from === to || stack.out.includes(to)) return stack
  return normalizeStack({ out: stack.out.map((s) => (s === from ? to : s)), against: stack.against })
}

/** Unified's own picker. */
export function setAgainst(stack: Stack, sheet: Sheet): Stack {
  return { out: stack.out, against: sheet }
}

/** What a caption's picker offers. Unified and a single sheet offer everything the
 *  file has, base included — "Full diff" is just the sheet showing main. From two
 *  sheets on, base is fixed and the pickers offer checkpoints only; one already out
 *  as its own sheet is listed but disabled. */
export function pickerOptions(stack: Stack, avail: Sheet[], sheet: Sheet): { sheet: Sheet; disabled: boolean }[] {
  const single = stack.out.length <= 1
  return avail
    .filter((s) => single || s !== 'base')
    .map((s) => ({ sheet: s, disabled: s !== sheet && stack.out.includes(s) }))
}

/** Same sheets out (as a set); while none is out, the same baseline too. */
export function sameStack(a: Stack, b: Stack): boolean {
  const sa = displayOrder(a.out).join(), sb = displayOrder(b.out).join()
  if (sa !== sb) return false
  return a.out.length > 0 || a.against === b.against
}

/** The board's caption words. Unified's own picker reads just `main` for the base. */
export function sheetCaption(sheet: Sheet | 'current', opts: { unified?: boolean } = {}): string {
  switch (sheet) {
    case 'base': return opts.unified ? 'main' : 'base · main'
    case 'review': return 'agent review'
    case 'approved': return 'approval'
    case 'viewed': return 'file view'
    case 'current': return 'current'
  }
}

/** The board's picker words. */
export function sinceLabel(sheet: Sheet): string {
  switch (sheet) {
    case 'base': return 'Full diff'
    case 'review': return 'Since agent review'
    case 'approved': return 'Since approval'
    case 'viewed': return 'Since file view'
  }
}

/** One line naming what a stack shows — the ✓'s tooltip says what the other files
 *  show. */
export function describeStack(stack: Stack): string {
  const cols = columnsFor(stack)
  if (cols.length === 0) return `Unified · ${sheetCaption(stack.against, { unified: true })} · current`
  if (cols.length === 1) return cols[0] === 'base' ? 'Split · full diff' : `Split · since ${sheetCaption(cols[0])}`
  return `Multi · ${cols.map((c) => (c === 'base' ? 'base' : sheetCaption(c))).join(' · ')}`
}

/** The hunks a file shows measured since `sheet`: the full diff for base, else the
 *  server's slice from that checkpoint to current (or empty — a genuine "no changes
 *  since"). Untracked files are the exception: a wholly-new file has no prior
 *  version, so its since-diff IS its full diff. */
export function sliceFor(f: FileDiff, sheet: Sheet): Hunk[] {
  if (sheet === 'base') return f.hunks
  if (f.untracked) return f.hunks
  if (sheet === 'review') return f.sinceReviewHunks ?? []
  if (sheet === 'approved') return f.sinceHunks ?? []
  return f.sinceViewedHunks ?? []
}

/** A Multi middle column: base → the checkpoint. `[]` when the checkpoint exists but
 *  the file was untouched by it; the caller only asks for sheets the file has. */
export function midHunksFor(f: FileDiff, sheet: Sheet): Hunk[] {
  if (sheet === 'review') return f.baseToReviewHunks ?? []
  if (sheet === 'approved') return f.baseToApprovedHunks ?? []
  if (sheet === 'viewed') return f.baseToViewedHunks ?? []
  return []
}
