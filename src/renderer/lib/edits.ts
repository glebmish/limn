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

/** Turn a (line index within the frame's own lines, raw-text column) pair into a
 *  caret offset in the `\n`-joined text FlowFrame's textarea holds (#5 — placing the
 *  caret at the double-clicked position when a frame opens). Both inputs are clamped,
 *  so an out-of-range line or column — including `Infinity`, the deliberate
 *  end-of-line fallback when no column was captured — still lands somewhere sane
 *  rather than throwing or producing a negative/overlong `selectionStart`. */
export function lineColToCaret(lines: string[], lineIdx: number, col: number): number {
  const li = Math.max(0, Math.min(lineIdx, lines.length - 1))
  let offset = 0
  for (let i = 0; i < li; i++) offset += lines[i].length + 1 // +1 for the '\n'
  const lineLen = lines[li]?.length ?? 0
  return offset + Math.max(0, Math.min(col, lineLen))
}

/** A flow frame's live draft (#6 fix-round-1): the typed text plus the caret, kept in
 *  the store under the edit session's `frameId` so it survives a forced remount that
 *  is still, conceptually, the same edit — the ↑/↓ growth gesture (#6) can cross a
 *  real git-hunk boundary that DiffBody's key-matched reconciliation can't reach
 *  (that reconciliation only spans one hunk's own flattened row array), forcing a
 *  fresh `FlowFrame` instance. Without the draft, that fresh instance would silently
 *  re-seed from disk and discard whatever the user had typed. */
export interface FrameDraft { frameId: number; text: string; caret: number | null }

/** Which text a (re)mounting frame should seed with: the draft, only when it belongs
 *  to this exact session (`frameId` matches) — a genuinely new edit (a different
 *  session) always starts from the on-disk region, never a stale leftover draft. */
export function seedFrameText(draft: FrameDraft | null, frameId: number, diskText: string): string {
  return draft && draft.frameId === frameId ? draft.text : diskText
}

/** Which caret offset a (re)mounting frame should place: the draft's, when it
 *  belongs to this session and actually recorded one — otherwise `fallback` (the
 *  double-click column, or end-of-line — see `lineColToCaret`). */
export function seedFrameCaret(draft: FrameDraft | null, frameId: number, fallback: number): number {
  return draft && draft.frameId === frameId && draft.caret != null ? draft.caret : fallback
}

/** Caret offset inside the frame's textarea text right after the ↑/↓ past-the-edge
 *  growth gesture (#6) admits a neighbouring file line. `joined` is the admitted
 *  line; `col` is the caret's column on the row it was on just before growth,
 *  clamped to `joined`'s own length (the admitted line may be shorter). `prefixLength`
 *  is how many characters of the *new* text come before `joined`: `0` when the line
 *  is prepended above the frame's first row (↑ — nothing precedes it), or the old
 *  text's length plus one (the joining `\n`) when it's appended below the last row
 *  (↓). Both directions reduce to the same shape — this is what makes the caret
 *  land in the newly admitted line, symmetrically, whichever edge grew. */
export function caretAfterGrowth(prefixLength: number, joined: string, col: number): number {
  return prefixLength + Math.max(0, Math.min(col, joined.length))
}

/** Map a column measured against a tab-expanded *display* string back to an offset
 *  in the corresponding *raw* line (#5). The diff view renders every line through
 *  `disp()` (tabs → two spaces, DiffBody.tsx) so word-diff marks line up in the
 *  monospace grid, but the frame edits the raw text — a caret column read off the
 *  rendered DOM via `caretRangeFromPoint` is in display units and would drift on any
 *  tabbed line if used verbatim. Greedily consumes raw characters (a tab costs 2
 *  display columns, everything else costs 1) until their display width reaches
 *  `displayCol`; a click inside a tab's two-column span snaps to just past the tab,
 *  since the raw text has no finer position to offer there. */
export function rawOffsetFromDisplayColumn(raw: string, displayCol: number): number {
  let disp = 0
  let i = 0
  while (i < raw.length && disp < displayCol) {
    disp += raw[i] === '\t' ? 2 : 1
    i++
  }
  return i
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
