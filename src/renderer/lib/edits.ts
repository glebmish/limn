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
 *  the lines that changed. Returns null when nothing changed (a no-op save).
 *
 *  `newLines` is free to be longer than `snapshot` (#10 — ⏎ grew the region), shorter
 *  (#8 — a joined row), or **empty** (#8 — the delete gesture passes `typed = []`,
 *  which no textarea value can produce on its own): an empty `newLines` with a
 *  non-empty `snapshot` is a pure deletion, spliced straight out by the server. */
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

/** Which working-tree line the post-save keyboard selection should land on, given the
 *  edit that was just written and how many lines the file held *before* it. Normally
 *  `edit.start` — the line the user just edited. A deletion has no such line, so the
 *  selection falls on whatever moved up into its place; when the deleted span ran to
 *  the end of the file there is nothing to move up, so it clamps to the new last line.
 *  `null` when the file has no lines left at all (everything was deleted) — there is
 *  nothing to select, and a selection past EOF would leave ⏎ reopening a frame on a
 *  line that does not exist. A no-op (returns `edit.start`) for every save that does
 *  not shrink the file. */
export function selectionAfterSave(edit: FileEdit, fileLineCount: number): number | null {
  const eof = fileLineCount - edit.snapshot.length + edit.newLines.length
  const line = Math.min(edit.start, eof)
  return line >= 1 ? line : null
}

/** Is the frame at the point where the next ⌫ removes its lines from the file
 *  (#8)? A textarea can never hold *zero* lines — `''.split('\n')` is `['']`, one
 *  empty row — so "typed away to nothing" is exactly `text === ''`, whether the
 *  region started as one line or as several backspaced together. From there the
 *  textarea itself has nothing left to delete, so ⌫ is free to mean the next thing
 *  a normal editor would do: take the line out.
 *
 *  `ready` is "the working file has arrived": a frame mounts empty and disabled
 *  while it fetches, and an empty *unloaded* frame must neither advertise nor
 *  accept a deletion — there is no snapshot yet to anchor the CAS on.
 *
 *  Deliberately strict about emptiness: a space or a stray blank row is content the
 *  user typed, and ⌫ there is an ordinary character delete. */
export function frameDeletesLines(text: string, ready: boolean): boolean {
  return ready && text === ''
}

/** The flow frame's keymap (#10, #8). ⏎ is a plain newline like in any editor, so
 *  the keys the frame claims are the commit (⌘⏎ / ctrl+⏎ — both accepted on every
 *  platform), the cancel (esc), and — only once `deletesLines` says the region is
 *  empty (#8) — ⌫, which removes the region's lines from the file instead of
 *  beeping at the start of an empty buffer. Everything else, arrow-key region
 *  growth included, is left to the textarea / the caller. */
export function frameKeyAction(
  // shiftKey is accepted and deliberately ignored: shift is not a save modifier,
  // so shift+⏎ is a newline like a bare ⏎ and shift+⌫ is a plain ⌫.
  e: {
    key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean
    /** the OS auto-repeat from a *held* key, not a fresh press */
    repeat?: boolean
  },
  deletesLines = false
): 'save' | 'cancel' | 'delete' | null {
  if (e.key === 'Escape') return 'cancel'
  if (e.key === 'Enter' && (e.metaKey === true || e.ctrlKey === true)) return 'save'
  // ⌘⌫/ctrl+⌫/⌥⌫ are the textarea's own delete-to-start / delete-word: no-ops on an
  // empty value, and not the single keystroke the ⌫ hint promises — left alone so
  // the cue and the gesture describe exactly the same thing.
  //
  // `repeat` is the load-bearing one: a held ⌫ clearing the last character arms the
  // frame synchronously (React flushes the onChange setText before the next browser
  // event), and the next auto-repeat keydown lands 15–90 ms later — an order of
  // magnitude faster than anyone can read the cue, so holding ⌫ to clear a line
  // would run straight through into a working-tree write nobody was warned about.
  // Requiring a *fresh* press means the cue is always on screen, and the release is
  // the user's own acknowledgement of it. Repeats are a no-op, not a fall-through:
  // the textarea has nothing left to delete anyway.
  if (e.key === 'Backspace' && deletesLines && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return e.repeat === true ? null : 'delete'
  }
  return null
}

/** The frame's keymap hint. Normally the whole keymap; once ⌫ would take the lines
 *  out (#8) it names *what* is about to go and what ⌘⏎ would do instead — the
 *  distinction the empty frame otherwise hides, since saving empty text writes a
 *  blank line where deleting writes no line at all. `chip` is the region label the
 *  head already shows ("line 11" / "lines 11–13"), so the cue points at the same
 *  lines the user is looking at. */
export function frameHint(deletesLines: boolean, chip: string): string {
  return deletesLines
    ? `⌫ deletes ${chip} · ⌘⏎ leaves a blank line · esc cancel`
    : '⌘⏎ save · ⏎ new line · esc cancel · ↑/↓ past the edge extends'
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
export interface FrameDraft { frameId: string; text: string; caret: number | null }

/** Which text a (re)mounting frame should seed with: the draft, only when it belongs
 *  to this exact session (`frameId` matches) — a genuinely new edit (a different
 *  session) always starts from the on-disk region, never a stale leftover draft. */
export function seedFrameText(draft: FrameDraft | null, frameId: string, diskText: string): string {
  return draft && draft.frameId === frameId ? draft.text : diskText
}

/** Which caret offset a (re)mounting frame should place: the draft's, when it
 *  belongs to this session and actually recorded one — otherwise `fallback` (the
 *  double-click column, or end-of-line — see `lineColToCaret`). */
export function seedFrameCaret(draft: FrameDraft | null, frameId: string, fallback: number): number {
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
