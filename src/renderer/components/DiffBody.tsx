import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I } from '../kit'
import { diffHunksForMode, useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import type { CharRange } from '../lib/worddiff'
import { disp, highlightLine, langForPath } from '../lib/highlight'
import { describeModeChange } from './FileHeader'
import { discardSpanAt, fileEditable, rawOffsetFromDisplayColumn } from '../lib/edits'
import { gapLines, hunkGaps, type Gap } from '../lib/expand'
import { buildFileRows, linesForRun, type FileRow, type LineRow } from '../lib/rows'
import { api } from '../lib/api'
import { FlowFrame } from './FlowFrame'

/** Which line the per-line comment composer is open on, in the file-line key space
 *  (`lib/rows.ts`): working-tree rows are addressed on the new side, deletions on the
 *  old side. Unambiguous, so two identical lines can't open the composer together —
 *  the property the old `{ hunkIdx, lineIdx }` pair bought, now expressed in terms
 *  the reader (and the anchor pipeline) actually think in. */
export interface ComposerAt { side: 'new' | 'old'; line: number }

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
  const t = disp(text)
  return (
    <span className="code">
      {ranges?.map((r, i) => (
        <i key={i} className="wd" style={{ left: `${r.start}ch`, width: `${r.len}ch` }} />
      ))}
      <span className="code-syn" dangerouslySetInnerHTML={{ __html: html ?? highlightLine(t, lang) }} />
    </span>
  )
}

/** The file body: guidance note, the file's continuous rows (changed lines plus the
 *  collapsed runs of unchanged lines between them — #11: this reads as the file, not
 *  as a stack of git hunks), per-line comment gutter/threads/composer, empty-state
 *  messaging and the outdated-comments footer.
 *
 *  Every row — hunk line, revealed context line, collapsed run — lives in ONE flat
 *  keyed array, keyed by its file line (`lib/rows.ts`). That single key space is what
 *  lets an edit frame grow across what used to be a hunk boundary without React
 *  tearing it down and remounting it. */
export function DiffBody({ f, mode, showBody, fileComments, composerAt, setComposerAt }: {
  f: FileDiff
  mode: 'branch' | 'approved' | 'viewed'
  showBody: boolean
  fileComments: Comment[]
  composerAt: ComposerAt | null
  setComposerAt: (v: ComposerAt | null) => void
}) {
  // show exactly the selected baseline — if a tracked file has no diff at that baseline
  // it renders the empty state below, rather than silently falling back to the full diff
  // (which made the shown content contradict the selected "Since …" mode). Untracked
  // files are wholly new, so their since-diff equals the full diff (see diffHunksForMode).
  const hunks = diffHunksForMode(f, mode)
  const lang = langForPath(f.path)
  const outdated = fileComments.filter((c) => c.status === 'outdated')
  // resolved comments are included: the re-anchor pipeline now maintains their
  // notInDiff too (#18), so the flag is current rather than a stale leftover — and a
  // resolved comment whose anchor was lost must stay visible somewhere in the file.
  const notShown = fileComments.filter((c) => c.notInDiff && c.status !== 'outdated')

  // ── in-place edits (specs/inplace-edits): the flow frame replaces the rows it
  // covers; a hover pencil / double-click on any working-tree row opens it.
  const loaded = useStore((s) => s.loaded)
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
  const discardAt = async (lines: DiffLine[], j: number): Promise<void> => {
    const span = discardSpanAt(lines, j)
    if (!span) return
    const res = await useStore.getState().saveEdit(f.path, {
      start: span.start, end: span.end, snapshot: span.snapshot, newLines: span.restore
    })
    if (res && !res.ok) await useStore.getState().refreshLoaded()
  }

  // ── collapsed runs: the unchanged file lines around/between the changes. Revealed
  // rows are plain working-tree rows — same pencil, same frame. Component state,
  // reset when the file re-renders after a save (line numbers may have shifted).
  const [expandedGaps, setExpandedGaps] = useState<Record<string, DiffLine[]>>({})
  const fileLinesRef = useRef<string[] | null>(null)
  useEffect(() => { setExpandedGaps({}); fileLinesRef.current = null }, [f])
  // The runs themselves are pure arithmetic over the hunks and are ALWAYS modelled:
  // they are the only thing marking a discontinuity now that the `@@` head is gone,
  // and a `.dline` has no top border, so leaving them out makes two distant hunks
  // read as one continuous block with the gutter quietly jumping. *Opening* one needs
  // a worktree to read from (same availability as editing, v1) — where that is
  // missing the run renders as an inert marker instead of a button.
  const gaps = useMemo(() => (f.binary ? [] : hunkGaps(hunks)), [f.binary, hunks])
  const canExpand = editable && mode === 'branch' && !f.binary
  /** the file's row model: changed rows and collapsed runs, in file order. `lang` in
   *  the deps: it's a pure function of `f.path`, so it never actually changes without
   *  `hunks`/`gaps` also changing, but exhaustive-deps wants it named since the
   *  highlight pass (#7) now depends on it directly. */
  const rows = useMemo(() => buildFileRows(hunks, gaps, lang), [hunks, gaps, lang])
  const expand = async (gap: Gap): Promise<void> => {
    if (!loaded || !canExpand) return
    try {
      if (!fileLinesRef.current) {
        const wf = await api().readWorkingFile(loaded.state.repo, loaded.session.pair.compare, f.path)
        if (!wf.ok) return
        fileLinesRef.current = wf.lines
      }
      const revealed = gapLines(fileLinesRef.current, gap)
      if (revealed.length) setExpandedGaps((prev) => ({ ...prev, [gap.key]: revealed }))
    } catch { /* worktree read failed — leave the fold closed */ }
  }
  /** the fold (unrevealed, openable run) whose span contains working-tree line `n` */
  const hiddenGapContaining = (n: number): Gap | undefined =>
    canExpand ? gaps.find((g) => !expandedGaps[g.key] && n >= g.from && (g.to == null || n <= g.to)) : undefined

  // Growth across a fold (board 01): when the frame's edge enters a fold, the
  // fold's lines reveal in one batch — only the adjacent line joined the frame.
  useEffect(() => {
    if (!frame) return
    for (const n of [frame.start - 1, frame.start, frame.end, frame.end + 1]) {
      const g = hiddenGapContaining(n)
      if (g) void expand(g)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.start, frame?.end])

  // ── post-save keyboard round trip (board 01): the save leaves a selection on the
  // line; ↑/↓ move it (folds reveal in batches as crossed), ⏎ re-enters edit on the
  // selected line, esc clears. Active only while no frame is open in this file.
  const lineSelect = useStore((s) => s.lineSelect)
  const setLineSelect = useStore((s) => s.setLineSelect)
  const selected = lineSelect && lineSelect.file === f.path && !frame && editable ? lineSelect : null
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('textarea,input,select,[contenteditable="true"]')) return
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
        const g = hiddenGapContaining(target)
        if (g) await expand(g) // crossing a fold reveals it in one batch
        const eof = fileLinesRef.current?.length
        if (eof != null && target > eof) return
        setLineSelect({ file: f.path, line: target })
      })()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, f.path])
  // keep the moving selection on screen
  useEffect(() => {
    if (!selected) return
    document.querySelector(`[data-limn-line="${CSS.escape(f.path)}:new:${selected.line}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected, f.path])

  const threadsFor = (line: number, side: 'new' | 'old'): Comment[] =>
    fileComments.filter((c) =>
      c.anchor.kind === 'diff' && c.anchor.side === side && c.anchor.line === line && c.status !== 'outdated' && !c.notInDiff
    )

  // The rows as they actually render: a revealed run replaces its collapsed-run row
  // with plain context rows, in the same file-line key space as everything else.
  const view: FileRow[] = []
  for (const r of rows) {
    if (r.type === 'gap') {
      const revealed = expandedGaps[r.gap.key]
      if (revealed) {
        // same cross-line highlight treatment as a hunk's own lines (#7) — a
        // revealed run is real, contiguous file content and can itself contain a
        // block comment or template literal spanning its lines
        view.push(...linesForRun(revealed, lang, { hunkRange: '', fromHunk: false }))
        continue
      }
    }
    view.push(r)
  }
  const lineAt = (i: number): DiffLine | null => {
    const r = view[i]
    return r && r.type === 'line' ? r.l : null
  }

  /** A collapsed run of unchanged file lines. Openable where there is a worktree to
   *  read the lines from; everywhere else (a read-only review, the "Since …" tabs)
   *  the same hairline renders as an inert marker — it still has to say the file
   *  jumps here, which is the job the `@@` head used to do by accident. */
  const gapNode = (r: Extract<FileRow, { type: 'gap' }>): React.ReactNode => {
    const count = r.gap.to != null ? r.gap.to - r.gap.from + 1 : null
    const lines = count != null ? `${count} unchanged line${count === 1 ? '' : 's'}` : 'unchanged lines'
    const text = r.where ? `${lines} ${r.where}` : lines
    // the one genuinely useful half of the old `@@ … @@ ctx` header, as plain prose:
    // where in the file this collapsed run leads
    const fn = r.fn ? <span className="gap-fn">in {r.fn}</span> : null
    if (!canExpand) {
      return <div key={r.key} className="expander-row gap-static">{text}{fn}</div>
    }
    return (
      <button
        key={r.key}
        className="expander-row"
        onClick={() => void expand(r.gap)}
        aria-label={r.where ? `Expand hidden lines ${r.where}` : 'Expand hidden lines'}
      >
        <I.chevR style={{ width: 10, height: 10, transform: 'rotate(90deg)' }} />
        {`expand ${text}`}
        {fn}
      </button>
    )
  }

  const lineNode = (r: LineRow, i: number): React.ReactNode => {
    const { l, side, lineNo, key } = r
    // rows the open frame covers: the first mounts the editor, the rest hide; a −
    // row adjacent to covered rows stays as a grey sliver (its text is what the edit
    // may replace — scope marker, not input). Returned bare (never wrapped in a
    // Fragment keyed by this row's own position) — see the comment on mountFrame.
    if (coveredBy(l)) return mountFrame()
    const sliver = frame != null && l.new == null && (coveredBy(lineAt(i - 1)) || coveredBy(lineAt(i + 1)))
    const originCls = l.origin === 'staged' ? ' staged'
      : l.origin === 'unstaged' ? ' unstaged'
      : (l.since || l.sinceViewed) ? ' since' : ''
    const kindCls = l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : ''
    const commentable = r.fromHunk
    const threads = commentable ? threadsFor(lineNo, side) : []
    return (
      <Fragment key={key}>
        <div
          className={'dline ' + kindCls + originCls + (sliver ? ' frame-sliver' : '') + (selected && l.new != null && l.new === selected.line ? ' line-selected' : '')}
          data-limn-line={`${f.path}:${side}:${lineNo}`}
          onDoubleClick={editable && l.new != null ? (e) => openFrameAt(l, e) : undefined}
        >
          <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
          <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
          <CodeLine text={l.text} lang={lang} ranges={r.marks} html={r.html} />
          {commentable && (
            <button
              className="gutter-add limn-line-add"
              title="Comment on this line"
              aria-label={`Comment on line ${lineNo}`}
              onClick={() => setComposerAt({ side, line: lineNo })}
            >
              <I.plus style={{ width: 12, height: 12 }} />
            </button>
          )}
          {editable && l.new != null && (
            <button
              className="pencil-btn limn-line-edit"
              title="Edit this line in place — saves as an uncommitted change"
              aria-label={`Edit line ${l.new}`}
              onClick={() => openFrameAt(l)}
            >
              <I.edit style={{ width: 12, height: 12 }} />
            </button>
          )}
          {editable && l.origin === 'unstaged' && discardSpanAt(r.run, r.runIdx) != null && (
            <button
              className="rail-undo limn-line-discard"
              title="Discard — git checkout -- (reverts this uncommitted span)"
              aria-label={`Discard uncommitted change at line ${lineNo}`}
              onClick={() => void discardAt(r.run, r.runIdx)}
            >
              <I.undo style={{ width: 10, height: 10 }} />
            </button>
          )}
        </div>
        {threads.map((c) => (
          <InlineThread key={c.id} c={c} locLabel={`on line ${lineNo}`} />
        ))}
        {commentable && composerAt && composerAt.side === side && composerAt.line === lineNo && (
          <Composer
            placeholder="Leave a comment for the agent…"
            onCancel={() => setComposerAt(null)}
            onSubmit={(text) => {
              // derive the anchor from the identified row — byte-identical to what
              // the hunk-indexed composer produced, `hunkRange` included: the row
              // model carries its hunk's range for exactly this field, even though
              // nothing renders it any more (#11).
              void useStore.getState().addComment(
                { kind: 'diff', file: f.path, side, line: lineNo, hunkRange: r.hunkRange, lineContent: l.text },
                text
              )
              setComposerAt(null)
            }}
          />
        )}
      </Fragment>
    )
  }

  return (
    <>
      {showBody && (
        <div className="gfile-diff">
          {f.binary && <div className="nodiff">Binary file — no diff to show.</div>}
          {!f.binary && hunks.length === 0 && (
            mode === 'approved' ? <div className="nodiff">No changes since you approved.</div>
            : mode === 'viewed' ? <div className="nodiff">No changes since you viewed.</div>
            : f.modeChange ? (
              // mode-only change: surface the bit transition explicitly rather than an
              // empty "no content" line (design 07, state 15)
              <div className="modechip">mode <code>{f.modeChange.from}</code> <span className="ar">→</span> <code>{f.modeChange.to}</code> · {describeModeChange(f.modeChange)}</div>
            )
            : <div className="nodiff">No textual changes.</div>
          )}
          {/* ONE flat array for the whole file — see the component doc comment */}
          {view.map((r, i) => (r.type === 'gap' ? gapNode(r) : lineNode(r, i)))}
          {notShown.length > 0 && (
            <div className="nodiff" style={{ borderTop: '1px solid var(--line)' }}>
              {notShown.length} comment{notShown.length > 1 ? 's' : ''} anchored to lines not shown in this diff:
              {notShown.map((c) => (
                <InlineThread key={c.id} c={c} locLabel="not shown here" />
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
