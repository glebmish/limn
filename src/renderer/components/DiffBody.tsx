import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I } from '../kit'
import { diffHunksForMode, useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'
import { describeModeChange } from './FileHeader'
import { discardSpanAt, fileEditable, rawOffsetFromDisplayColumn } from '../lib/edits'
import { gapLines, hunkGaps, type Gap } from '../lib/expand'
import { api } from '../lib/api'
import { FlowFrame } from './FlowFrame'

/** tabs → spaces so ch-offset word marks align with the monospace text */
function disp(text: string): string {
  return text.replace(/\t/g, '  ')
}

/** The raw-text column under a double-click, for placing the caret when a flow frame
 *  opens (#5). Best-effort and browser-only (no jsdom equivalent exists to test
 *  against, hence no unit test): `caretRangeFromPoint`
 *  (Chrome/Safari) or `caretPositionFromPoint` (Firefox) finds the exact text node
 *  under the pointer inside the row's `.code` span, a `TreeWalker` sums the text
 *  nodes before it to get a *display* column (the DOM here is tab-expanded — see
 *  `disp()` above), and `rawOffsetFromDisplayColumn` (lib/edits.ts, unit-tested) maps
 *  that back to the raw line. Returns undefined — FlowFrame's end-of-line fallback —
 *  when neither API exists, the point misses the code span, or it resolves outside
 *  it (e.g. the gutter or the comment-gutter button). */
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
  let displayCol = offset
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let cur = walker.nextNode(); cur && cur !== node; cur = walker.nextNode()) {
    displayCol += cur.textContent?.length ?? 0
  }
  return rawOffsetFromDisplayColumn(rawText, displayCol)
}

function hunkWordMarks(lines: DiffLine[]): Map<number, CharRange[]> {
  const marks = new Map<number, CharRange[]>()
  for (const [d, a] of pairHunkLines(lines)) {
    const r = wordDiffRanges(disp(lines[d].text), disp(lines[a].text))
    if (r.old.length) marks.set(d, r.old)
    if (r.new.length) marks.set(a, r.new)
  }
  return marks
}

function CodeLine({ text, lang, ranges }: { text: string; lang: string | null; ranges?: CharRange[] }) {
  const t = disp(text)
  return (
    <span className="code">
      {ranges?.map((r, i) => (
        <i key={i} className="wd" style={{ left: `${r.start}ch`, width: `${r.len}ch` }} />
      ))}
      <span className="code-syn" dangerouslySetInnerHTML={{ __html: highlightLine(t, lang) }} />
    </span>
  )
}

/** The file body: guidance note, hunks + word-marked code lines, per-line comment
 *  gutter/threads/composer, empty-state messaging and the outdated-comments footer.
 *  `composerAt` is owned by the DiffView shell; a line is identified unambiguously by
 *  its `{ hunkIdx, lineIdx }` so two identical lines can't open the composer together. */
export function DiffBody({ f, mode, showBody, fileComments, composerAt, setComposerAt }: {
  f: FileDiff
  mode: 'branch' | 'approved' | 'viewed'
  showBody: boolean
  fileComments: Comment[]
  composerAt: { hunkIdx: number; lineIdx: number } | null
  setComposerAt: (v: { hunkIdx: number; lineIdx: number } | null) => void
}) {
  // show exactly the selected baseline — if a tracked file has no diff at that baseline
  // it renders the empty state below, rather than silently falling back to the full diff
  // (which made the shown content contradict the selected "Since …" mode). Untracked
  // files are wholly new, so their since-diff equals the full diff (see diffHunksForMode).
  const hunks = diffHunksForMode(f, mode)
  const lang = langForPath(f.path)
  const wordMarks = useMemo(() => hunks.map((h) => hunkWordMarks(h.lines)), [hunks])
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
  const coveredBy = (l: DiffLine): boolean =>
    frame != null && l.new != null && l.new >= frame.start && l.new <= frame.end
  // The frame mounts exactly once, at the first covered row in document order
  // (hunk rows and expanded context rows alike) — a per-render flag, not state.
  // Its key is a single literal, not derived from that row's position (line number,
  // hunk/row index…): the ↑/↓ growth gesture (#6) can move which row is "first" from
  // one render to the next (extending upward admits a new, earlier row), and a
  // position-derived key would make React treat that as a different element —
  // unmounting the live FlowFrame (losing focus, the caret, and the fetched file
  // lines) and mounting a fresh one in its place. A stable key lets React match the
  // old and new elements across the move and reuse the same component instance —
  // and, since it's a DOM move rather than remove+insert, the browser keeps focus on
  // the textarea inside it for free. Returned bare (no wrapping element) so this
  // literal is the key React actually reconciles by — a wrapping <Fragment key=…>
  // would still pin the *inner* <FlowFrame> to whatever key mountFrame gave it, which
  // was exactly as position-derived as the outer key it replaced.
  let frameMounted = false
  const mountFrame = (): React.ReactNode => {
    if (!frame || frameMounted) return null
    frameMounted = true
    return <FlowFrame key="flow-frame" f={f} frame={frame} />
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

  // ── expand-context: reveal unchanged file lines around/between hunks. Revealed
  // rows are plain working-tree rows — same pencil, same frame. Component state,
  // reset when the file re-renders after a save (line numbers may have shifted).
  const [expandedGaps, setExpandedGaps] = useState<Record<string, DiffLine[]>>({})
  const fileLinesRef = useRef<string[] | null>(null)
  useEffect(() => { setExpandedGaps({}); fileLinesRef.current = null }, [f])
  // needs a worktree to read from — same availability as editing (v1)
  const gaps = useMemo(() => (editable && mode === 'branch' && !f.binary ? hunkGaps(hunks) : []), [editable, mode, f.binary, hunks])
  // where a gap would start at each hunk boundary: index i = before hunk i,
  // index hunks.length = the trailing to-EOF gap
  const gapStarts = useMemo(() => {
    const starts: number[] = [1]
    for (const h of hunks) {
      let end = 0
      for (const l of h.lines) if (l.new != null) end = l.new
      starts.push(end + 1)
    }
    return starts
  }, [hunks])
  const expand = async (gap: Gap): Promise<void> => {
    if (!loaded) return
    try {
      if (!fileLinesRef.current) {
        const wf = await api().readWorkingFile(loaded.state.repo, loaded.session.pair.compare, f.path)
        if (!wf.ok) return
        fileLinesRef.current = wf.lines
      }
      const rows = gapLines(fileLinesRef.current, gap)
      if (rows.length) setExpandedGaps((prev) => ({ ...prev, [gap.key]: rows }))
    } catch { /* worktree read failed — leave the fold closed */ }
  }
  const gapAt = (from: number, to?: number | null): Gap | undefined =>
    gaps.find((g) => g.from === from && (to === undefined || g.to === to || (to === null && g.to === null)))
  /** the fold (unrevealed gap) whose span contains working-tree line `n` */
  const hiddenGapContaining = (n: number): Gap | undefined =>
    gaps.find((g) => !expandedGaps[g.key] && n >= g.from && (g.to == null || n <= g.to))

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
  /** the expander row (or its revealed rows) for the gap starting at `from` */
  const gapBlock = (from: number, trailing: boolean, label: string): React.ReactNode => {
    const gap = trailing ? gaps.find((g) => g.to === null && g.from === from) : gapAt(from, undefined)
    if (!gap || (gap.to != null && gap.to < gap.from)) return null
    const rows = expandedGaps[gap.key]
    if (rows) {
      return rows.map((l) => {
        // covered rows return the mount slot directly (or null) — never wrapped in a
        // Fragment keyed by this row's own position; see the comment on mountFrame.
        if (coveredBy(l)) return mountFrame()
        return (
          <Fragment key={`x${gap.key}-${l.new}`}>
            <div
              className={'dline' + (selected && l.new === selected.line ? ' line-selected' : '')}
              data-limn-line={`${f.path}:new:${l.new}`}
              onDoubleClick={editable ? (e) => openFrameAt(l, e) : undefined}
            >
              <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
              <span className="sign"></span>
              <CodeLine text={l.text} lang={lang} />
              {editable && (
                <button
                  className="pencil-btn limn-line-edit"
                  title="Edit this line in place — saves as an uncommitted change"
                  aria-label={`Edit line ${l.new}`}
                  onClick={() => openFrameAt(l)}
                >
                  <I.edit style={{ width: 12, height: 12 }} />
                </button>
              )}
            </div>
          </Fragment>
        )
      })
    }
    const count = gap.to != null ? gap.to - gap.from + 1 : null
    return (
      <button className="expander-row" onClick={() => void expand(gap)} aria-label={`Expand hidden lines ${label}`}>
        <I.chevR style={{ width: 10, height: 10, transform: 'rotate(90deg)' }} />
        {count != null ? `expand ${count} unchanged line${count === 1 ? '' : 's'} ${label}` : `expand unchanged lines ${label}`}
      </button>
    )
  }

  const threadsFor = (line: number | null, side: 'new' | 'old'): Comment[] =>
    line == null
      ? []
      : fileComments.filter((c) =>
          c.anchor.kind === 'diff' && c.anchor.side === side && c.anchor.line === line && c.status !== 'outdated' && !c.notInDiff
        )

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
          {hunks.map((h, i) => {
            // The leading gap, the head, and the hunk's own lines are flattened into
            // one array (rather than three separate `{a}{b}{c}` JSX children) so a
            // growing frame that crosses from the gap into the hunk's own rows (or
            // back) reconciles as ONE flat, key-matched list. Three separate curly
            // children do NOT share a key-space with each other — verified live: with
            // them separate, a frame growing across exactly that boundary still lost
            // its FlowFrame instance (this file's own gap/hunk boundary reproduced
            // it), even though `mountFrame`'s key is the same constant literal on
            // both sides.
            const rows: React.ReactNode[] = [
              gapBlock(i === 0 ? 1 : gapStarts[i], false, i === 0 ? 'above' : ''),
              <div key="head" className="hunk-head">
                <I.diff style={{ width: 12, height: 12, opacity: 0.6 }} />
                {h.range}
                {h.header && <span style={{ color: 'var(--muted-2)' }}>{h.header}</span>}
                {h.since && <span style={{ color: 'var(--amber)' }}>· changed since approval</span>}
                {!h.since && h.sinceViewed && <span style={{ color: 'var(--amber)' }}>· changed since viewed</span>}
              </div>,
              h.lines.map((l, j) => {
                const side: 'new' | 'old' = l.new != null ? 'new' : 'old'
                const lineNo = l.new ?? l.old
                const threads = threadsFor(lineNo, side)
                const originCls = l.origin === 'staged' ? ' staged'
                  : l.origin === 'unstaged' ? ' unstaged'
                  : (l.since || l.sinceViewed) ? ' since' : ''
                // rows the open frame covers: the first mounts the editor, the rest
                // hide; a − row adjacent to covered rows stays as a grey sliver
                // (its text is what the edit may replace — scope marker, not input).
                if (frame && coveredBy(l)) return mountFrame()
                const sliver = frame != null && l.new == null &&
                  (coveredBy(h.lines[j - 1] ?? {} as DiffLine) || coveredBy(h.lines[j + 1] ?? {} as DiffLine))
                return (
                  <Fragment key={j}>
                    <div
                      className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + originCls + (sliver ? ' frame-sliver' : '') + (selected && l.new != null && l.new === selected.line ? ' line-selected' : '')}
                      data-limn-line={lineNo != null ? `${f.path}:${side}:${lineNo}` : undefined}
                      onDoubleClick={editable && l.new != null ? (e) => openFrameAt(l, e) : undefined}
                    >
                      <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
                      <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                      <CodeLine text={l.text} lang={lang} ranges={wordMarks[i]?.get(j)} />
                      <button
                        className="gutter-add limn-line-add"
                        title="Comment on this line"
                        aria-label={`Comment on line ${lineNo}`}
                        onClick={() => setComposerAt({ hunkIdx: i, lineIdx: j })}
                      >
                        <I.plus style={{ width: 12, height: 12 }} />
                      </button>
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
                      {editable && l.origin === 'unstaged' && discardSpanAt(h.lines, j) != null && (
                        <button
                          className="rail-undo limn-line-discard"
                          title="Discard — git checkout -- (reverts this uncommitted span)"
                          aria-label={`Discard uncommitted change at line ${lineNo}`}
                          onClick={() => void discardAt(h.lines, j)}
                        >
                          <I.undo style={{ width: 10, height: 10 }} />
                        </button>
                      )}
                    </div>
                    {threads.map((c) => (
                      <InlineThread key={c.id} c={c} locLabel={`on line ${lineNo}`} />
                    ))}
                    {composerAt && composerAt.hunkIdx === i && composerAt.lineIdx === j && (
                      <Composer
                        placeholder="Leave a comment for the agent…"
                        onCancel={() => setComposerAt(null)}
                        onSubmit={(text) => {
                          // derive the anchor from the identified line — byte-identical to the
                          // pre-split payload, but sourced from hunks[hunkIdx].lines[lineIdx]
                          // rather than a captured snapshot (the dup-line double-composer fix).
                          void useStore.getState().addComment(
                            { kind: 'diff', file: f.path, side, line: lineNo!, hunkRange: h.range, lineContent: l.text },
                            text
                          )
                          setComposerAt(null)
                        }}
                      />
                    )}
                  </Fragment>
                )
              })
            ].flat()
            return (
              <div key={i} className={h.since ? 'hunk since-hunk' : 'hunk'} style={{ position: 'relative' }}>
                {rows}
              </div>
            )
          })}
          {hunks.length > 0 && gapBlock(gapStarts[hunks.length], true, 'below')}
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
