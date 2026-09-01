import type { DiffLine, FileDiff, FileEdit } from '../../shared/types'
import type { LoadedReview } from '../../shared/ipc'

/** How many lines `a` and `b` share at each end, by exact text. The suffix scan is
 *  bounded by what the prefix already claimed, so a repeated line is never counted
 *  twice (['a','a'] vs ['a','a','a'] is prefix 2 + suffix 0, not 2 + 2). */
function commonEdges(a: string[], b: string[]): { prefix: number; suffix: number } {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++
  return { prefix, suffix }
}

/** Narrow a frame save to its changed core: the common prefix and suffix between the
 *  on-screen snapshot and the typed lines are dropped, so the CAS anchors to exactly
 *  the lines that changed. Returns null when nothing changed (a no-op save). */
export function narrowEdit(start: number, snapshot: string[], typed: string[]): FileEdit | null {
  const { prefix, suffix } = commonEdges(snapshot, typed)
  const core = snapshot.slice(prefix, snapshot.length - suffix)
  const newLines = typed.slice(prefix, typed.length - suffix)
  if (core.length === 0 && newLines.length === 0) return null
  return {
    start: start + prefix,
    end: start + prefix + core.length - 1, // end < start ⇒ pure insertion before `start`
    snapshot: core,
    newLines
  }
}

/** The flow frame's keymap (#10). ⏎ is a plain newline like in any editor, so the
 *  only keys the frame claims are the commit (⌘⏎ / ctrl+⏎ — both accepted on every
 *  platform) and the cancel (esc). Everything else, arrow-key region growth
 *  included, is left to the textarea / the caller. */
export function frameKeyAction(
  // shiftKey is accepted and deliberately ignored: shift is not a save modifier,
  // so shift+⏎ is a newline like a bare ⏎.
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }
): 'save' | 'cancel' | null {
  if (e.key === 'Escape') return 'cancel'
  if (e.key === 'Enter' && (e.metaKey === true || e.ctrlKey === true)) return 'save'
  return null
}

/** Gutter labels for the frame's rows, aligned against the region as it stands on
 *  disk (`original` = the frame's own working-tree lines, first one numbered
 *  `start`). A row that still *is* one of those lines keeps that line's number; a
 *  row the edit created or rewrote has no file line behind it yet and reads '+' —
 *  numbering it would collide with a real line still rendered below the frame.
 *
 *  Alignment is the same common-prefix/suffix narrowing the save uses, so the '+'
 *  rows are by construction exactly `narrowEdit`'s `newLines`: the gutter marks
 *  precisely what the CAS payload will rewrite, never more and never less. A pure
 *  LCS would additionally re-match an interior line that survived a rewrite around
 *  it; here such a row reads '+', which is the conservative direction — it claims
 *  no line number it cannot stand behind. */
export function frameGutter(start: number, original: string[], typed: string[]): string[] {
  const { prefix, suffix } = commonEdges(original, typed)
  return typed.map((_, i) => {
    if (i < prefix) return String(start + i)
    // a suffix row is the same distance from the end in both, so it maps back to
    // `original` by that distance — the rows below a growing edit keep their numbers
    if (i >= typed.length - suffix) return String(start + original.length - (typed.length - i))
    return '+'
  })
}

/** Frame/pencil availability for a whole file. Rows additionally need working-tree
 *  text behind them (`l.new != null` — never a − row). */
export function fileEditable(loaded: LoadedReview | null, f: FileDiff): boolean {
  return Boolean(loaded?.writeCapability?.enabled) && !f.binary && !f.conflict
}

export interface DiscardSpan {
  start: number
  end: number
  /** current working-tree lines of the span (the CAS anchor) */
  snapshot: string[]
  /** the pre-change text the span collapses back to */
  restore: string[]
}

/** The maximal contiguous run of unstaged-origin lines around `idx`, as a discard
 *  payload: replace the run's add lines with its del lines. Null when the line is
 *  not unstaged, when the run touches a staged-origin line (index surgery we do not
 *  do in v1), or when it contains no add row (a pure deletion has no working-tree
 *  anchor to replace — v1-out, see spec open question 3). */
export function discardSpanAt(lines: DiffLine[], idx: number): DiscardSpan | null {
  if (lines[idx]?.origin !== 'unstaged') return null
  let lo = idx
  while (lo > 0 && lines[lo - 1].origin === 'unstaged') lo--
  let hi = idx
  while (hi < lines.length - 1 && lines[hi + 1].origin === 'unstaged') hi++
  // a staged line adjacent to the run means the visual span mixes index states
  if (lines[lo - 1]?.origin === 'staged' || lines[hi + 1]?.origin === 'staged') return null
  const run = lines.slice(lo, hi + 1)
  const adds = run.filter((l) => l.new != null)
  if (adds.length === 0) return null
  return {
    start: adds[0].new!,
    end: adds[adds.length - 1].new!,
    snapshot: adds.map((l) => l.text),
    restore: run.filter((l) => l.kind === 'del').map((l) => l.text)
  }
}
