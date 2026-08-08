import type { DiffLine, FileDiff, FileEdit } from '../../shared/types'
import type { LoadedReview } from '../../shared/ipc'

/** Narrow a frame save to its changed core: the common prefix and suffix between the
 *  on-screen snapshot and the typed lines are dropped, so the CAS anchors to exactly
 *  the lines that changed. Returns null when nothing changed (a no-op save). */
export function narrowEdit(start: number, snapshot: string[], typed: string[]): FileEdit | null {
  let prefix = 0
  while (prefix < snapshot.length && prefix < typed.length && snapshot[prefix] === typed[prefix]) prefix++
  let suffix = 0
  while (
    suffix < snapshot.length - prefix &&
    suffix < typed.length - prefix &&
    snapshot[snapshot.length - 1 - suffix] === typed[typed.length - 1 - suffix]
  ) suffix++
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

/** Frame/pencil availability for a whole file. Rows additionally need working-tree
 *  text behind them (`l.new != null` — never a − row). */
export function fileEditable(loaded: LoadedReview | null, f: FileDiff): boolean {
  return Boolean(loaded?.writeCapability.enabled) && !f.binary && !f.conflict
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
