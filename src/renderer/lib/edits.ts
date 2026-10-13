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
 *  non-empty `snapshot` is a pure deletion, spliced straight out by the server.
 *
 *  A pure insertion (empty core) never goes out with an empty snapshot (#5): that
 *  matches the empty slice at ANY position, so the server's CAS could not fail — a
 *  double submit would duplicate the lines, and an agent's insertion above would
 *  silently shift where these land. Unchanged neighbours ride along in both
 *  `snapshot` and `newLines` instead: the line above (when the region has one), and
 *  lines below — from the region, then from `after` (the file's lines past the
 *  region) — until the carried lines differ from what the insertion would put in
 *  their place. Only the BELOW lines can make a repeat of the save fail its CAS: the
 *  lines above sit where they were after the insertion, so an above-only snapshot
 *  still matches once the save has landed. That is the one case left without a
 *  double-submit guard — an append at the very end of the file, where nothing
 *  follows — and the case where the lines below repeat the inserted text all the way
 *  down. An empty snapshot (an empty file) has no neighbour to carry at all; the
 *  server accepts that only for a file that is still empty. */
export function narrowEdit(start: number, snapshot: string[], typed: string[], after: string[] = []): FileEdit | null {
  const { prefix, suffix } = commonEdges(snapshot, typed)
  const core = snapshot.slice(prefix, snapshot.length - suffix)
  const newLines = typed.slice(prefix, typed.length - suffix)
  if (core.length === 0 && newLines.length === 0) return null
  if (core.length === 0 && snapshot.length > 0) {
    const above = prefix > 0 ? [snapshot[prefix - 1]] : []
    const below = [...snapshot.slice(prefix), ...after]
    // grow the carried lines below until a repeat of this save would see different
    // lines there (the inserted ones pushed them down) — or the file runs out
    const shifted = [...newLines, ...below]
    let b = 0
    while (b < below.length) {
      b++
      if (shifted.slice(0, b).some((l, i) => l !== below[i])) break
    }
    const carried = below.slice(0, b)
    const from = start + prefix - above.length
    return { start: from, end: from + above.length + b - 1, snapshot: [...above, ...carried], newLines: [...above, ...newLines, ...carried] }
  }
  return {
    start: start + prefix,
    end: start + prefix + core.length - 1, // end < start ⇒ pure insertion before `start` (empty file only)
    snapshot: core,
    newLines
  }
}

/** The first line a save changes — where the post-save selection belongs: the
 *  first edited or inserted line, never a context line `narrowEdit` carried. */
export function firstChangedLine(start: number, snapshot: string[], typed: string[]): number {
  return start + commonEdges(snapshot, typed).prefix
}

/** Which working-tree line the post-save keyboard selection should land on, given the
 *  edit that was just written, how many lines the file held *before* it, and the
 *  line the save changed first (`firstChangedLine`; defaults to `edit.start`, right
 *  for any edit that carries no context). A deletion has no edited line, so the
 *  selection falls on whatever moved up into its place; when the deleted span ran to
 *  the end of the file there is nothing to move up, so it clamps to the new last
 *  line. `null` when the file has no lines left at all (everything was deleted) —
 *  there is nothing to select, and a selection past EOF would leave ⏎ reopening a
 *  frame on a line that does not exist. */
export function selectionAfterSave(edit: FileEdit, fileLineCount: number, changedLine: number = edit.start): number | null {
  const eof = fileLineCount - edit.snapshot.length + edit.newLines.length
  const line = Math.min(changedLine, eof)
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
 *  out (#8) it names *what* is about to go and what the save chord would do instead
 *  — the distinction the empty frame otherwise hides, since saving empty text writes
 *  a blank line where deleting writes no line at all. `chip` is the region label the
 *  head already shows ("line 11" / "lines 11–13"), so the cue points at the same
 *  lines the user is looking at. `chord` is the platform's save chord label (see
 *  `saveChordLabel`) — passed in rather than derived here so this stays a pure
 *  function of its inputs. */
export function frameHint(deletesLines: boolean, chip: string, chord: string): string {
  return deletesLines
    ? `⌫ deletes ${chip} · ${chord} leaves a blank line · esc cancel`
    : `${chord} save · ⏎ new line · esc cancel · ↑/↓ past the edge extends`
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

/** The save held across a CAS conflict, offered back via Re-apply. `removes` carries
 *  the #8 delete intent alongside the text — the line numbers the held save deletes,
 *  empty for an ordinary text save: an emptied frame's typed text is `''` either way,
 *  so without it a Re-apply after a conflicted deletion would write a blank line
 *  instead of removing the lines — a different edit than the one asked for. Also
 *  drives Re-apply's danger cue (see `reapplyCue`). */
export interface FrameYours { text: string; removes: number[] }

/** Re-apply's danger cue: a non-empty `removes` means the held save deletes lines
 *  from the file rather than merely changing their text, so Re-apply gets a red cue
 *  and a title naming exactly how many lines are about to go. */
export function reapplyCue(removes: number[]): { danger: boolean; title: string } {
  const n = removes.length
  return n > 0
    ? { danger: true, title: `Re-apply — deletes ${n} line${n === 1 ? '' : 's'}` }
    : { danger: false, title: 'Re-apply' }
}

/** A flow frame's live draft (#6 fix-round-1): everything about an in-progress edit
 *  that must outlive the component instance, kept in the store under the edit
 *  session's `frameId` so it survives a forced remount that is still, conceptually,
 *  the same edit. The headline case was the ↑/↓ growth gesture (#6) crossing a git
 *  hunk boundary, which DiffBody's key-matched reconciliation could not reach while
 *  each hunk rendered its own flattened row array; #11's continuous per-file row
 *  model closed that particular hole. The remaining one is `refreshLoaded()` —
 *  the conflict path calls it, and a reshuffled diff can still tear the frame down.
 *
 *  `fileLines` and `yours` are here for the same reason the text is (final review,
 *  findings 2 + 3) — one durability mechanism, not three:
 *
 *  - **`fileLines`** is the working-tree snapshot the text was typed *against*, i.e.
 *    the CAS anchor. Restoring the text while re-reading the file from disk was a
 *    correctness hole: if the file changed externally between the first fetch and the
 *    remount, the save would anchor to the fresh content and succeed with no
 *    conflict, dropping typed text over lines the user never saw. Carrying it makes
 *    the remounted frame keep its original anchor, so such a save conflicts naturally.
 *  - **`yours`** is the post-conflict banner. It has to survive a remount precisely
 *    on the path it exists for: the conflict branch itself calls `refreshLoaded()`,
 *    which can reshuffle hunks and remount the frame — component-local state would
 *    take the banner (and the kept text behind Re-apply) with it, breaking "never a
 *    retype" (spec inv 6) on its own headline case.
 *
 *  Both are nullable: a draft written before the working file arrived has no anchor,
 *  and most drafts have no conflict behind them. */
export interface FrameDraft {
  frameId: string
  text: string
  caret: number | null
  fileLines: string[] | null
  yours: FrameYours | null
}

/** What a (re)mounting frame restores wholesale from the live draft: the typed text,
 *  the working-tree snapshot it was typed against, and any conflict banner. Non-null
 *  only when the draft belongs to this exact session *and* carries an anchor — in
 *  which case the frame must skip its disk re-read entirely (see `FrameDraft`).
 *  Null ⇒ fetch from disk as usual (`seedFrameText` still honours an anchor-less
 *  draft's text there, the pre-anchor behaviour). */
export function seedFrameRestore(
  draft: FrameDraft | null,
  frameId: string
): { text: string; fileLines: string[]; yours: FrameYours | null } | null {
  if (!draft || draft.frameId !== frameId || !draft.fileLines) return null
  return { text: draft.text, fileLines: draft.fileLines, yours: draft.yours }
}

/** A fresh edit-session id. `crypto.randomUUID` is **SecureContext-only**: it is
 *  `undefined` on plain HTTP to a non-loopback host — exactly the Tailscale setup
 *  `docs/using-limn.md` documents (`http://<tailnet-ip>:5466/?token=…`), where a bare
 *  `crypto.randomUUID()` threw inside `setEditFrame` on every pencil click, every
 *  double-click and every post-save ⏎, taking in-place editing out entirely.
 *  `crypto.getRandomValues` *is* available in insecure contexts, so it carries the
 *  common fallback; the last resort covers a context with no Web Crypto at all
 *  (an old browser, a non-DOM test env). Uniqueness is all that's required — these
 *  ids are compared for equality within one page's lifetime and never persisted. */
export function newFrameId(): string {
  const c: Crypto | undefined = typeof crypto === 'undefined' ? undefined : crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

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

/** The "nothing in this run is discardable" result: shared, frozen, and SHORT — a
 *  run with no unstaged line reads as no-span at every index because every index is
 *  past its end. Callers must therefore read it as `spans[i] ?? null`. */
const NO_DISCARDS: readonly (DiscardSpan | null)[] = Object.freeze([])

/** `discardSpanAt` for every index of a run, in one pass: each maximal unstaged
 *  block is resolved once and the resulting span (or null) is shared by every row
 *  in it. The row model hangs this on its rows (`lib/rows.ts`) so the body can ask
 *  "is this row discardable?" by reading a field instead of re-walking the run —
 *  which it did per unstaged row, per render, purely as a `!= null` test.
 *
 *  A run with no unstaged line at all — the common case, since most hunks are
 *  committed — short-circuits to the shared `NO_DISCARDS` instead of allocating a
 *  full array of nulls per run, per render, to say nothing. Read the result with
 *  `?? null`, never by length. */
export function discardSpansForRun(lines: DiffLine[]): readonly (DiscardSpan | null)[] {
  if (!lines.some((l) => l.origin === 'unstaged')) return NO_DISCARDS
  const out: (DiscardSpan | null)[] = lines.map(() => null)
  let i = 0
  while (i < lines.length) {
    if (lines[i].origin !== 'unstaged') { i++; continue }
    let hi = i
    while (hi < lines.length - 1 && lines[hi + 1].origin === 'unstaged') hi++
    const span = discardSpanAt(lines, i)
    for (let j = i; j <= hi; j++) out[j] = span
    i = hi + 1
  }
  return out
}
