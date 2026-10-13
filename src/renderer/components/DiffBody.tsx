import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Comment, DiffLine, FileAt, FileDiff } from '../../shared/types'
import { I } from '../kit'
import { useStore } from '../store'
import type { Sheet, Stack } from '../../shared/diffStack'
import { columnsFor, layoutFor, midHunksFor, sheetCaption, sliceFor } from '../lib/stack'
import { sinceBasis } from '../../shared/sinceBasis'
import { attributionExplanation, railExplanation } from '../lib/railExplanation'
import { Tooltip } from './Tooltip'
import { Composer, InlineThread } from './Threads'
import type { CharRange } from '../lib/worddiff'
import { disp, highlightLine, langForPath } from '../lib/highlight'
import { describeModeChange } from './FileHeader'
import { fileEditable, rawOffsetFromDisplayColumn, type DiscardSpan } from '../lib/edits'
import {
  STEP, foldControls, gapContaining, hunkGaps, revealLines, stepReveal, type Gap, type GapReveal
} from '../lib/expand'
import { asAligned, buildFileRows, buildSplitRows, commentAnchor, rowAnchors, viewAlignedRows, type AlignedRow, type Cell, type GapRow, type Layout, type ViewRow } from '../lib/rows'
import { estimateDiffHeight } from '../lib/diffHeight'
import { buildMultiRows, multiGaps } from '../lib/rowsMulti'
import { api } from '../lib/api'
import { FlowFrame } from './FlowFrame'
import { FoldRow } from './FoldRow'

/** Which line the per-line comment composer is open on, in the file-line key space
 *  (`lib/rows.ts`): working-tree rows are addressed on the new side, deletions on the
 *  old side. Unambiguous, so two identical lines can't open the composer together —
 *  the property the old `{ hunkIdx, lineIdx }` pair bought, now expressed in terms
 *  the reader (and the anchor pipeline) actually think in. */
export interface ComposerAt { side: 'new' | 'old'; line: number }

const NO_REVEAL: GapReveal = { top: 0, bottom: 0 }

/** The raw-text column under a double-click, for placing the caret when a flow frame
 *  opens (#5). Best-effort and browser-only (no jsdom equivalent exists to test
 *  against, hence no unit test): `caretRangeFromPoint`
 *  (Chrome/Safari) or `caretPositionFromPoint` (Firefox) finds the exact text node
 *  under the pointer inside the row's `.code` span, a `TreeWalker` sums the text
 *  nodes before it to get a *display* column (the DOM here is tab-expanded — see
 *  `disp()` in lib/highlight.ts), and `rawOffsetFromDisplayColumn` (lib/edits.ts,
 *  unit-tested) maps that back to the raw line. Returns undefined — FlowFrame's
 *  end-of-line fallback — when neither API exists, the point misses the code span, or
 *  it resolves outside it (e.g. the gutter or the comment-gutter button). */
function caretColumnFromEvent(e: React.MouseEvent<HTMLElement>, rawText: string): number | undefined {
  const root = e.currentTarget.querySelector('.code')
  if (!root) return undefined
  const doc = root.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null
  let offset: number
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(e.clientX, e.clientY)
    if (!range) return undefined
    node = range.startContainer
    offset = range.startOffset
  } else if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(e.clientX, e.clientY)
    if (!pos) return undefined
    node = pos.offsetNode
    offset = pos.offset
  } else {
    return undefined
  }
  if (!root.contains(node)) return undefined
  // A click on the row's padding can hit an *element* rather than a text node, and
  // there `offset` counts child nodes, not characters — summing it as a column would
  // put the caret at an arbitrary position. Degrade to the end-of-line fallback
  // (undefined) explicitly instead.
  if (node.nodeType !== Node.TEXT_NODE) return undefined
  let displayCol = offset
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let cur = walker.nextNode(); cur && cur !== node; cur = walker.nextNode()) {
    displayCol += cur.textContent?.length ?? 0
  }
  return rawOffsetFromDisplayColumn(rawText, displayCol)
}

/** `html` is the row's precomputed, cross-line-aware highlight (`lib/rows.ts`
 *  `linesForRun`, #7) — present whenever the row came through the row model with a
 *  language. Falls back to the old per-line highlighter only when it's absent (no
 *  language for this file), never re-deriving it from `text` when it is. */
function CodeLine({ text, lang, ranges, html }: { text: string; lang: string | null; ranges?: CharRange[]; html?: string }) {
  return (
    <span className="code">
      {ranges?.map((r, i) => (
        <i key={i} className="wd" style={{ left: `${r.start}ch`, width: `${r.len}ch` }} />
      ))}
      {/* `disp` only in the fallback: where `html` is present it already went through
          `disp` in the run pass, and re-deriving it here would be per-row work thrown
          away every render */}
      <span className="code-syn" dangerouslySetInnerHTML={{ __html: html ?? highlightLine(disp(text), lang) }} />
    </span>
  )
}

/** Latch one `readFileAt` into the body's fold state — but only while the read is
 *  still the one the body is waiting for. A read is issued for a given file object
 *  and stack; a save (or a pull, or a re-generate) mints new `FileDiff`s and resets
 *  the body's state under it, and a read issued *before* that lands *after* it, when
 *  its text belongs to line numbers that have since moved. Latching it then paints
 *  pre-refresh text under post-refresh numbers, or (on a failure) leaves every fold
 *  inert for content that would read fine. So `isCurrent` is asked once, at the
 *  moment the answer arrives, and a superseded read writes nothing and resolves null
 *  — which also drops the `reveal` that awaited it. */
export async function latchFileRead(
  read: Promise<FileAt>,
  isCurrent: () => boolean,
  sink: { lines: (lines: string[]) => void; failed: () => void }
): Promise<string[] | null> {
  let r: FileAt
  try { r = await read } catch { r = { ok: false, reason: 'absent' } }
  if (!isCurrent()) return null
  if (!r.ok) { sink.failed(); return null }
  sink.lines(r.lines)
  return r.lines
}

/** Where focus owns the key: a control (Enter on a focused button must press THAT
 *  button, not also open an edit frame on the selected line), a text field, a dialog. */
const KEY_OWNERS = 'button,a,input,textarea,select,[role=button],[role=dialog],[contenteditable="true"]'

/** Whether the post-save line-selection keys (↑/↓/⏎/esc, a document-level listener)
 *  should leave this keydown alone: someone already handled it, or it was pressed
 *  inside an element that owns its own keys. */
export function lineKeyIgnored(e: { defaultPrevented: boolean; target: unknown }): boolean {
  if (e.defaultPrevented) return true
  const t = e.target as { closest?: (sel: string) => unknown } | null
  return Boolean(t && typeof t.closest === 'function' && t.closest(KEY_OWNERS))
}

/** The origin / drift rail class for a line, shared by the unified row and a cell. */
function originCls(l: DiffLine | null, driftRails: boolean): string {
  if (!l) return ''
  if (l.origin === 'staged') return ' staged'
  if (l.origin === 'unstaged') return ' unstaged'
  return driftRails && (l.since || l.sinceViewed) ? ' since' : ''
}

/** The file body: guidance note, the file's continuous rows (changed lines plus the
 *  collapsed runs of unchanged lines between them — #11: this reads as the file, not
 *  as a stack of git hunks), per-line comment gutter/threads/composer, empty-state
 *  messaging and the outdated-comments footer.
 *
 *  Every row — hunk line, revealed context line, collapsed run — lives in ONE flat
 *  keyed array, keyed by its file line (`lib/rows.ts`). That single key space is what
 *  lets an edit frame grow across what used to be a hunk boundary without React
 *  tearing it down and remounting it. Since the layouts landed the rows are *aligned
 *  rows* — one cell per column: Unified renders its single cell in exactly the DOM it
 *  always had; Split and Multi render a `.dcell` per column inside the same `.dline`.
 *
 *  The collapsed runs fold the way GitHub's do (`FoldRow`, `lib/expand.ts`): STEP
 *  lines from either edge, in every baseline and in read-only reviews — the text
 *  comes from `readFileAt`, not the write capability. ONE reveal primitive
 *  (`reveal(gap, edge)`) serves the fold buttons, the post-save ↑/↓ walk and the
 *  FlowFrame growth gesture alike. */
export function DiffBody({ f, stack, showBody, fileComments, composerAt, setComposerAt, revealAllFlag = false }: {
  f: FileDiff
  /** the file's EFFECTIVE stack (design board 13): no sheet out → Unified measured
   *  since `against`; one → Split; two or more → Multi with one column per sheet */
  stack: Stack
  showBody: boolean
  fileComments: Comment[]
  composerAt: ComposerAt | null
  setComposerAt: (v: ComposerAt | null) => void
  /** the file header's Expand all / Collapse: true reveals every run, false folds them */
  revealAllFlag?: boolean
}) {
  // ── layout follows the sheet count; the columns are the sheets in display order
  const layout: Layout = layoutFor(stack)
  const cols = columnsFor(stack)
  const stackKey = JSON.stringify(stack)
  // what the diff is measured since: Unified's own baseline, the one sheet beside
  // current, or — in Multi — the nearest checkpoint, which current is attributed against
  const since: Sheet = layout === 'unified' ? stack.against : layout === 'split' ? stack.out[0] : cols[cols.length - 1]
  // show exactly the selected slice — if a tracked file has no diff since that sheet it
  // renders the empty state below, rather than silently falling back to the full diff
  // (which made the shown content contradict the caption). Untracked files are wholly
  // new, so their since-diff equals the full diff (see sliceFor). In Multi every side
  // column is measured from the base: current is the full diff, each checkpoint column
  // its own base→checkpoint slice.
  const mids = useMemo(() => (layout === 'multi' ? cols.slice(1).map((s) => midHunksFor(f, s)) : []), [layout, f, stackKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const hunks = layout === 'multi' ? f.hunks : sliceFor(f, since)
  // Whose line numbers the old side shows. Every stored side:'old' anchor is base
  // space (the server stamps it at the merge base); a since-checkpoint slice's old
  // side is the checkpoint's. There the old side is shown but never addressed — no
  // commenting, no thread matching, no jump target — or a base comment lands on
  // whichever checkpoint line shares its number. Multi's old column is the base, and
  // an untracked file has no old side at all.
  const oldIsBase = layout === 'multi' || since === 'base' || Boolean(f.untracked)
  const lang = langForPath(f.path)
  const outdated = fileComments.filter((c) => c.status === 'outdated')
  // a dismissed proposal is hidden everywhere until restored (board 14 v3)
  const shown = fileComments.filter((c) => c.status !== 'dismissed')
  // resolved comments are included: the re-anchor pipeline now maintains their
  // notInDiff too (#18), so the flag is current rather than a stale leftover — and a
  // resolved comment whose anchor was lost must stay visible somewhere in the file.
  const notShown = shown.filter((c) => c.notInDiff && c.status !== 'outdated')

  // ── in-place edits (specs/inplace-edits): the flow frame replaces the rows it
  // covers; a hover pencil / double-click on any working-tree row opens it.
  const loaded = useStore((s) => s.loaded)
  // what the single drift rail is measured from — the same helper the header's key
  // and the baseline labels read, so the rail's own tooltip can never disagree
  const driftBasis = (loaded ? sinceBasis(loaded.state, loaded.skeleton.headSha)?.basis : null) ?? 'approved'
  const editFrame = useStore((s) => s.editFrame)
  const setEditFrame = useStore((s) => s.setEditFrame)
  const editable = fileEditable(loaded, f)
  const frame = editable && editFrame && editFrame.file === f.path ? editFrame : null
  const coveredBy = (l: DiffLine | null | undefined): boolean =>
    frame != null && l != null && l.new != null && l.new >= frame.start && l.new <= frame.end
  // The frame mounts exactly once, at the first covered row in document order
  // (changed rows and revealed context rows alike) — a per-render flag, not state.
  //
  // Its key is `frame.frameId` — the edit *session*'s identity, not the row's
  // position (line number, row index…) and, just as deliberately, not a bare
  // constant either. Two competing needs, both real:
  //  - The ↑/↓ growth gesture (#6) can move which row is "first" from one render to
  //    the next (extending upward admits a new, earlier row). A position-derived key
  //    would make React treat that as a different element — unmounting the live
  //    FlowFrame (losing focus, the caret, the fetched file lines, and whatever was
  //    typed) and mounting a fresh one. Growth spreads the current frame
  //    (`{ ...frame, start: frame.start - 1 }`), so `frameId` rides along and the key
  //    stays put — React matches old and new across the move and reuses the same
  //    instance; being a DOM move rather than remove+insert, the browser keeps focus
  //    on the textarea inside it for free.
  //  - A single hardcoded literal key (this file's fix-round-1 Critical finding) goes
  //    too far the other way: `openFrameAt` can retarget `editFrame` to an unrelated
  //    line — a double-click or pencil click while a frame is already open, with no
  //    guard against it — and a constant key would let React reuse the *same live
  //    instance* for that unrelated line too, since old and new positions land in the
  //    same flattened row array. The reused instance's `fetched`/`focusedOnce`
  //    latches (FlowFrame.tsx) are keyed to *mount*, not to `frame.start`/`end`, so
  //    they'd never re-fire — the old line's typed text would sit in the textarea
  //    while `frame.start`/`end` quietly pointed at the new line, and ⌘⏎ would CAS-
  //    write that stale text under the new line numbers. Silent, wrong-line writes.
  //    `openFrameAt` mints a fresh `frameId` on every open (store/edits.ts,
  //    `setEditFrame`) precisely so an unrelated re-open is a different key — a full,
  //    safe remount, same as it always was.
  // Returned bare (no wrapping element) so `frameId` is the key React actually
  // reconciles by — a wrapping <Fragment key=…> would still pin the *inner*
  // <FlowFrame> to whatever key mountFrame gave it, one level removed from the key
  // that matters.
  let frameMounted = false
  const mountFrame = (): React.ReactNode => {
    if (!frame || frameMounted) return null
    frameMounted = true
    return <FlowFrame key={`flow-${frame.frameId}`} f={f} frame={frame} />
  }
  const openFrameAt = (l: DiffLine, e?: React.MouseEvent<HTMLElement>): void => {
    if (!editable || l.new == null) return
    setEditFrame({ file: f.path, start: l.new, end: l.new, caretCol: e ? caretColumnFromEvent(e, l.text) : undefined })
  }

  // ── rail ↺: discard a contiguous unstaged span — git checkout --, surfaced.
  // Runs the same CAS save pipeline with the span's pre-change text as payload;
  // a conflict (file moved since render) just refreshes the review.
  const discardAt = async (span: DiscardSpan): Promise<void> => {
    const res = await useStore.getState().saveEdit(f.path, {
      start: span.start, end: span.end, snapshot: span.snapshot, newLines: span.restore
    })
    if (res && !res.ok) await useStore.getState().refreshLoaded()
  }

  // ── collapsed runs: the unchanged file lines around/between the changes. Revealed
  // rows are plain working-tree rows — same pencil, same frame. Component state,
  // reset when the file re-renders after a save (line numbers may have shifted).
  // Reset on the STACK too, not just the file: it is independent store state, so `f`
  // keeps its identity across a pull or a caption pick — while the gap keys
  // (`g<from>`) do not change with it. A fold opened under one stack would otherwise
  // still be "open" over rows that start elsewhere.
  const [reveals, setReveals] = useState<Record<string, GapReveal>>({})
  const [fileLines, setFileLines] = useState<string[] | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const linesPromise = useRef<Promise<string[] | null> | null>(null)
  // identity of the read in flight: cleared by the reset below, so a read issued for
  // the previous file/stack knows not to latch its answer (`latchFileRead`)
  const readToken = useRef<object | null>(null)
  useEffect(() => {
    setReveals({}); setFileLines(null); setReadFailed(false)
    linesPromise.current = null
    readToken.current = null
  }, [f, stackKey])
  // The runs themselves are pure arithmetic over the hunks and are ALWAYS modelled:
  // they are the only thing marking a discontinuity now that the `@@` head is gone,
  // and a `.dline` has no top border, so leaving them out makes two distant hunks
  // read as one continuous block with the gutter quietly jumping. In Multi a run is
  // unchanged in every column, so it is measured once, in now coordinates, with the
  // offsets back to the other two (lib/rowsMulti.ts).
  const gaps = useMemo(
    () => (f.binary ? [] : layout === 'multi' ? multiGaps(mids, hunks) : hunkGaps(hunks)),
    [f.binary, layout, mids, hunks]
  )
  /** the file's row model: changed rows and collapsed runs, in file order. `lang` in
   *  the deps: it's a pure function of `f.path`, so it never actually changes without
   *  `hunks`/`gaps` also changing, but exhaustive-deps wants it named since the
   *  highlight pass (#7) now depends on it directly. */
  const rows = useMemo((): ViewRow[] => {
    if (f.binary) return []
    // an added file's hunks ARE the whole file, so there is no run trailing off below
    // its last line to offer (lib/rows.ts spots the wholly-deleted case itself)
    const trailing = f.status !== 'added'
    if (layout === 'multi') return buildMultiRows(mids, hunks, gaps, lang, { trailing })
    if (layout === 'split') return buildSplitRows(hunks, gaps, lang, { trailing })
    return buildFileRows(hunks, gaps, lang, { trailing }).map((r) => (r.type === 'line' ? asAligned(r) : r))
  }, [f.binary, f.status, layout, mids, hunks, gaps, lang])

  /** The file's text as it is now — fetched once per file/mode, shared by every
   *  reveal. `readFileAt` needs no write capability, so a read-only review and every
   *  since-baseline get their folds too. A failed read leaves them inert. */
  const ensureLines = (): Promise<string[] | null> => {
    if (fileLines) return Promise.resolve(fileLines)
    if (!loaded || readFailed) return Promise.resolve(null)
    if (!linesPromise.current) {
      const token = {}
      readToken.current = token
      linesPromise.current = latchFileRead(
        api().readFileAt(loaded.state.repo, loaded.session.pair.compare, f.path, { kind: 'now' }),
        () => readToken.current === token,
        { lines: setFileLines, failed: () => setReadFailed(true) }
      )
    }
    return linesPromise.current
  }
  const total = fileLines?.length ?? null
  /** THE reveal primitive: `n` more lines of `gap` from `edge`. Fold buttons, the
   *  ↑/↓ walk and frame growth all come through here — none of them fetches or keeps
   *  state of its own. */
  const reveal = async (gap: Gap, edge: 'top' | 'bottom', n = STEP): Promise<void> => {
    const lines = await ensureLines()
    if (!lines) return
    setReveals((prev) => ({ ...prev, [gap.key]: stepReveal(gap, prev[gap.key] ?? NO_REVEAL, edge, lines.length, n) }))
  }
  const revealAll = (gap: Gap): Promise<void> => reveal(gap, 'top', Infinity)
  /** the fold still hiding now-line `n`, and the edge to open it from */
  const revealPlan = (n: number): { gap: Gap; edge: 'top' | 'bottom' } | undefined => gapContaining(gaps, reveals, total, n)

  // the file header's Expand all / Collapse (the same primitive, every run at once)
  useEffect(() => {
    if (revealAllFlag) { for (const g of gaps) void revealAll(g) }
    else setReveals({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAllFlag])

  // Growth across a fold (board 01): when the frame's edge enters a fold, the fold
  // reveals STEP lines from that edge — only the adjacent line joined the frame.
  useEffect(() => {
    if (!frame) return
    for (const n of [frame.start - 1, frame.start, frame.end, frame.end + 1]) {
      const p = revealPlan(n)
      if (p) void reveal(p.gap, p.edge)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.start, frame?.end])

  // ── post-save keyboard round trip (board 01): the save leaves a selection on the
  // line; ↑/↓ move it (folds reveal in STEP-line batches as crossed), ⏎ re-enters
  // edit on the selected line, esc clears. Active only while no frame is open here.
  const lineSelect = useStore((s) => s.lineSelect)
  const setLineSelect = useStore((s) => s.setLineSelect)
  const selected = lineSelect && lineSelect.file === f.path && !frame && editable ? lineSelect : null
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      if (lineKeyIgnored(e)) return
      if (e.key === 'Escape') { e.preventDefault(); setLineSelect(null); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        setEditFrame({ file: f.path, start: selected.line, end: selected.line })
        return
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      void (async () => {
        const target = selected.line + (e.key === 'ArrowDown' ? 1 : -1)
        if (target < 1) return
        const p = revealPlan(target)
        if (p) await reveal(p.gap, p.edge) // crossing a fold reveals its next step
        const lines = await ensureLines()
        if (lines && target > lines.length) return
        setLineSelect({ file: f.path, line: target })
      })()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, f.path, reveals, total])
  // keep the moving selection on screen
  useEffect(() => {
    if (!selected) return
    document.querySelector(`[data-limn-line="${CSS.escape(f.path)}:new:${selected.line}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected, f.path])

  const threadsFor = (line: number, side: 'new' | 'old'): Comment[] =>
    shown.filter((c) =>
      c.anchor.kind === 'diff' && c.anchor.side === side && c.anchor.line === line && c.status !== 'outdated' && !c.notInDiff
    )
  /** Every thread on a row, across every (side, line) it holds (`rowAnchors`): a
   *  Split row pairing base line 2 with now line 2 hosts a comment made on either. */
  const rowThreads = (r: AlignedRow): Comment[] =>
    rowAnchors(r, oldIsBase).flatMap((a) => threadsFor(a.lineNo, a.side))
  /** The gutter mark for a line with threads (board 14 T1): a solid dot for the
   *  reviewer's own comments, a dashed ring when any proposal sits there. */
  const commentMark = (r: AlignedRow): React.ReactNode => {
    const ts = rowThreads(r)
    if (ts.length === 0) return null
    const prop = ts.some((c) => c.status === 'proposed')
    return <span className={'ax-cm' + (prop ? ' prop' : '')} title={prop ? 'A proposed finding on this line' : 'A comment on this line'} aria-hidden />
  }

  // The rows as they actually render — each fold's revealed edges spliced in around
  // it (lib/rows.ts `viewAlignedRows`). Memoized: it re-runs the per-run highlight
  // join for every revealed edge, which has no business happening on a render that
  // only moved the line selection.
  const revealed = useMemo(() => {
    const out: Record<string, { top: DiffLine[]; bottom: DiffLine[] }> = {}
    if (!fileLines) return out
    for (const g of gaps) {
      const r = reveals[g.key]
      if (r && (r.top || r.bottom)) out[g.key] = revealLines(fileLines, g, r)
    }
    return out
  }, [gaps, reveals, fileLines])
  const view = useMemo(() => viewAlignedRows(rows, revealed, layout, lang), [rows, revealed, layout, lang])
  /** every (side:line) some rendered row hosts threads for */
  const hosted = useMemo(() => {
    const at = new Set<string>()
    for (const r of view) if (r.type === 'aligned') for (const a of rowAnchors(r, oldIsBase)) at.add(`${a.side}:${a.lineNo}`)
    return at
  }, [view, oldIsBase])
  // Live comments no row here hosts: a since-checkpoint slice shows only part of the
  // diff (and never base old-side lines), so comments the full diff would show inline
  // are listed below rather than silently dropped.
  const outsideView = shown.filter((c) =>
    c.anchor.kind === 'diff' && c.status !== 'outdated' && !c.notInDiff && !hosted.has(`${c.anchor.side}:${c.anchor.line}`)
  )
  /** the now-side line of an aligned row, if it has one */
  const nowLine = (r: ViewRow | undefined): DiffLine | null => {
    if (!r || r.type !== 'aligned') return null
    const c = r.cells[r.cells.length - 1]
    return c.side === 'new' && c.l ? c.l : null
  }

  /** A collapsed run of unchanged file lines — see `FoldRow`. Inert (a marker, not a
   *  control) only when the text could not be read; the trailing run then has
   *  nothing true to say ("there is more file", forever) and is dropped. */
  const gapNode = (r: GapRow): React.ReactNode => {
    const inert = readFailed || f.binary
    if (inert && r.where === 'below') return null
    const controls = foldControls(r.gap, reveals[r.gap.key] ?? NO_REVEAL, total, r.where)
    if (!controls && !inert) return null // fully revealed
    return (
      <FoldRow
        key={r.key}
        row={r}
        controls={controls}
        inert={inert}
        onReveal={(edge) => void reveal(r.gap, edge)}
        onRevealAll={() => void revealAll(r.gap)}
      />
    )
  }

  // the rail is a 3px pseudo-element, so it cannot be hovered on its own: a wider
  // transparent strip sits over it carrying the explanation. Asking "what is this
  // mark?" where the mark is beats walking up to the header's key. In Multi the
  // attribution mark replaces the drift rail on the side columns.
  //
  // `drift` is the caller's copy of the gate `originCls` paints the drift rail
  // behind, and the tip is asked for under it: without that, a base column in Split
  // (and every column in Multi, where attribution replaces the rail) offered
  // "Changed since your approval" over a mark that was never drawn. The working-tree
  // rails are ungated in `originCls`, so their explanation is ungated here too.
  const railTipFor = (c: Cell, drift: boolean): string | null => {
    if (c.attribution) return attributionExplanation(c.attribution, since)
    if (!c.l) return null
    const painted = c.l.origin === 'staged' || c.l.origin === 'unstaged' || drift
    return painted ? railExplanation(c.l, driftBasis) : null
  }
  const driftRails = layout !== 'multi'

  const commentButton = (anchor: NonNullable<AlignedRow['anchor']>): React.ReactNode => (
    <button
      className="gutter-add limn-line-add"
      title="Comment on this line"
      aria-label={`Comment on line ${anchor.lineNo}`}
      onClick={() => setComposerAt({ side: anchor.side, line: anchor.lineNo })}
    >
      <I.plus style={{ width: 12, height: 12 }} />
    </button>
  )
  const pencil = (l: DiffLine): React.ReactNode => (
    <button
      className="pencil-btn limn-line-edit"
      title="Edit this line in place — saves as an uncommitted change"
      aria-label={`Edit line ${l.new}`}
      onClick={() => openFrameAt(l)}
    >
      <I.edit style={{ width: 12, height: 12 }} />
    </button>
  )
  /** The rail ↺, on every row of a discardable span (hover shows one at a time). The
   *  span itself comes precomputed off the row model — asking `discardSpanAt` here
   *  meant walking the run for each unstaged row of every open file, on every render,
   *  only to test it against null, and walking it once more to answer the click. */
  const discardButton = (r: AlignedRow, l: DiffLine): React.ReactNode => {
    const span = r.discard
    return span ? (
      <button
        className="rail-undo limn-line-discard"
        title="Discard — git checkout -- (reverts this uncommitted span)"
        aria-label={`Discard uncommitted change at line ${l.new ?? l.old}`}
        onClick={() => void discardAt(span)}
      >
        <I.undo style={{ width: 10, height: 10 }} />
      </button>
    ) : null
  }
  const afterRow = (r: AlignedRow): React.ReactNode => {
    const threads = rowThreads(r)
    const anchor = commentAnchor(r, oldIsBase)
    if (!anchor && threads.length === 0) return null
    const side = anchor?.side
    const lineNo = anchor?.lineNo
    const l = r.cells.find((c) => c.side === side)?.l
    return (
      <>
        {threads.map((c) => (
          <InlineThread key={c.id} c={c} locLabel={`on line ${c.anchor.kind === 'diff' ? c.anchor.line : lineNo}`} />
        ))}
        {side && lineNo != null && composerAt && composerAt.side === side && composerAt.line === lineNo && (
          <Composer
            placeholder="Leave a comment for the agent…"
            onCancel={() => setComposerAt(null)}
            onSubmit={(text) => {
              // derive the anchor from the identified row — byte-identical to what
              // the hunk-indexed composer produced, `hunkRange` included: the row
              // model carries its hunk's range for exactly this field, even though
              // nothing renders it any more (#11).
              void useStore.getState().addComment(
                { kind: 'diff', file: f.path, side, line: lineNo, hunkRange: r.hunkRange, lineContent: l?.text ?? '' },
                text
              )
              setComposerAt(null)
            }}
          />
        )}
      </>
    )
  }

  /** Unified: the one cell rendered as the `.dline` it has always been. */
  const unifiedNode = (r: AlignedRow, i: number): React.ReactNode => {
    const c = r.cells[0]
    const l = c.l!
    // rows the open frame covers: the first mounts the editor, the rest hide; a −
    // row adjacent to covered rows stays as a grey sliver (its text is what the edit
    // may replace — scope marker, not input). Returned bare (never wrapped in a
    // Fragment keyed by this row's own position) — see the comment on mountFrame.
    if (coveredBy(l)) return mountFrame()
    const sliver = frame != null && l.new == null && (coveredBy(nowLine(view[i - 1])) || coveredBy(nowLine(view[i + 1])))
    const railTip = railTipFor(c, driftRails)
    const anchor = commentAnchor(r, oldIsBase)
    const kindCls = l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : ''
    return (
      <Fragment key={r.key}>
        <div
          className={'dline ' + kindCls + originCls(l, driftRails) + (sliver ? ' frame-sliver' : '') + (selected && l.new != null && l.new === selected.line ? ' line-selected' : '')}
          data-limn-line={c.side === 'old' && !oldIsBase ? undefined : `${f.path}:${c.side}:${c.lineNo}`}
          // a context row shows its base number too: an old-side jump lands here
          // (lib/focusScroll.ts matches this alias for side 'old')
          data-limn-line-old={oldIsBase && c.side === 'new' && l.old != null ? `${f.path}:old:${l.old}` : undefined}
          onDoubleClick={editable && l.new != null ? (e) => openFrameAt(l, e) : undefined}
        >
          {railTip && (
            // the shared floating tooltip, not a native `title` — but held back a
            // beat: the strip is 9px wide and sits right beside the line's + button,
            // so an instant bubble fires on every pass toward it
            <Tooltip className="rail-hit" tipClassName="rail-tip" content={railTip} side="right" delay={450} />
          )}
          {commentMark(r)}
          <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
          <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
          <CodeLine text={l.text} lang={lang} ranges={c.marks} html={c.html} />
          {anchor && commentButton(anchor)}
          {editable && l.new != null && pencil(l)}
          {editable && discardButton(r, l)}
        </div>
        {afterRow(r)}
      </Fragment>
    )
  }

  /** Split / Multi: a `.dcell` per column. The frame lives in the now cell only —
   *  the rows it covers merge into one row whose other cells stack the lines they
   *  showed, so the columns stay aligned and base/checkpoint text stays readable
   *  beside the editor. */
  const columnsNode = (r: AlignedRow, i: number): React.ReactNode => {
    const nowL = nowLine(r)
    if (nowL && coveredBy(nowL)) {
      if (!frame || frameMounted) return null
      frameMounted = true
      const covered: AlignedRow[] = []
      for (let j = i; j < view.length; j++) {
        const cr = view[j]
        if (cr.type !== 'aligned' || !coveredBy(nowLine(cr))) break
        covered.push(cr)
      }
      return (
        <div key={`flow-${frame.frameId}`} className="dline dmerged">
          {r.cells.slice(0, -1).map((_, ci) => (
            <div key={ci} className="dcell dstack">
              {covered.map((cr) => {
                const c = cr.cells[ci]
                return (
                  <div key={cr.key} className="dstack-line">
                    <span className="gut"><span>{c.lineNo ?? ''}</span></span>
                    {c.l ? <CodeLine text={c.l.text} lang={lang} html={c.html} /> : <span className="code" />}
                  </div>
                )
              })}
            </div>
          ))}
          <div className="dcell dframe"><FlowFrame f={f} frame={frame} /></div>
        </div>
      )
    }
    const nowCell = r.cells[r.cells.length - 1]
    const anchor = commentAnchor(r, oldIsBase)
    return (
      <Fragment key={r.key}>
        <div className="dline split">
          {r.cells.map((c, ci) => {
            const isNow = c === nowCell && c.side === 'new'
            const railTip = railTipFor(c, driftRails && isNow)
            const kindCls = c.deleted ? 'del-slot' : c.kind
            const cls = 'dcell ' + kindCls + originCls(c.l, driftRails && isNow)
              + (c.attribution ? ' attr-' + c.attribution : '')
              + (isNow && nowL && selected && nowL.new === selected.line ? ' line-selected' : '')
            return (
              <div
                key={ci}
                className={cls}
                data-limn-line={c.l && c.lineNo != null && (c.side === 'new' || (c.side === 'old' && oldIsBase)) ? `${f.path}:${c.side}:${c.lineNo}` : undefined}
                onDoubleClick={isNow && editable && nowL ? (e) => openFrameAt(nowL, e) : undefined}
              >
                {railTip && <Tooltip className="rail-hit" tipClassName="rail-tip" content={railTip} side="right" delay={450} />}
                {(anchor ? c.side === anchor.side : ci === r.cells.length - 1) && commentMark(r)}
                <span className="gut"><span>{c.lineNo ?? ''}</span></span>
                <span className="sign">{c.kind === 'add' ? '+' : c.kind === 'del' || c.deleted ? '−' : ''}</span>
                {c.l ? <CodeLine text={c.l.text} lang={lang} ranges={c.marks} html={c.html} /> : <span className="code" />}
                {anchor && c.side === anchor.side && c.l && commentButton(anchor)}
                {isNow && editable && nowL && pencil(nowL)}
                {editable && r.anchor && c.side === r.anchor.side && c.l && discardButton(r, c.l)}
              </div>
            )
          })}
        </div>
        {afterRow(r)}
      </Fragment>
    )
  }

  // the captions live in the strip above (DiffStack) — the body is rows only
  const empty = !f.binary && hunks.length === 0 && (layout !== 'multi' || mids.every((m) => m.length === 0))

  return (
    <>
      {showBody && (
        <div
          className={'gfile-diff layout-' + layout}
          data-cols={layout === 'unified' ? undefined : cols.length + 1}
          // what the skipped body reserves until it first lays out (lib/diffHeight.ts)
          style={{ containIntrinsicHeight: `auto ${estimateDiffHeight(view, shown.length)}px` }}
        >
          {f.binary && <div className="nodiff">Binary file — no diff to show.</div>}
          {empty && (
            layout === 'multi' ? <div className="nodiff">No changes at any checkpoint.</div>
            : since !== 'base' ? <div className="nodiff">No changes since {sheetCaption(since)}.</div>
            : f.modeChange ? (
              // mode-only change: surface the bit transition explicitly rather than an
              // empty "no content" line (design 07, state 15)
              <div className="modechip">mode <code>{f.modeChange.from}</code> <span className="ar">→</span> <code>{f.modeChange.to}</code> · {describeModeChange(f.modeChange)}</div>
            )
            : <div className="nodiff">No textual changes.</div>
          )}
          {/* ONE flat array for the whole file — see the component doc comment */}
          {view.map((r, i) => (r.type === 'gap' ? gapNode(r) : layout === 'unified' ? unifiedNode(r, i) : columnsNode(r, i)))}
          {notShown.length > 0 && (
            <div className="nodiff" style={{ borderTop: '1px solid var(--line)' }}>
              {notShown.length} comment{notShown.length > 1 ? 's' : ''} anchored to lines not shown in this diff:
              {notShown.map((c) => (
                <InlineThread key={c.id} c={c} locLabel="not shown here" />
              ))}
            </div>
          )}
          {outsideView.length > 0 && (
            <div className="nodiff" style={{ borderTop: '1px solid var(--line)' }}>
              {outsideView.length} comment{outsideView.length > 1 ? 's' : ''} on lines outside this view:
              {outsideView.map((c) => (
                <InlineThread key={c.id} c={c} locLabel={c.anchor.kind === 'diff' ? `${c.anchor.side === 'old' ? 'base ' : ''}line ${c.anchor.line}` : 'outside this view'} />
              ))}
            </div>
          )}
          {outdated.length > 0 && (
            <div className="nodiff" style={{ borderTop: '1px solid var(--line)' }}>
              {outdated.length} outdated comment{outdated.length > 1 ? 's' : ''} (the lines they referenced changed):
              {outdated.map((c) => (
                <InlineThread key={c.id} c={c} locLabel="outdated" />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
