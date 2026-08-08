import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I } from '../kit'
import { diffHunksForMode, useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'
import { describeModeChange } from './FileHeader'
import { discardSpanAt, fileEditable } from '../lib/edits'
import { gapLines, hunkGaps, type Gap } from '../lib/expand'
import { api } from '../lib/api'
import { FlowFrame } from './FlowFrame'

/** tabs → spaces so ch-offset word marks align with the monospace text */
function disp(text: string): string {
  return text.replace(/\t/g, '  ')
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
  const notShown = fileComments.filter((c) => c.notInDiff && c.status !== 'outdated' && c.status !== 'resolved')

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
  let frameMounted = false
  const mountFrame = (key: string): React.ReactNode => {
    if (!frame || frameMounted) return null
    frameMounted = true
    return <FlowFrame key={key} f={f} frame={frame} />
  }
  const openFrameAt = (l: DiffLine): void => {
    if (!editable || l.new == null) return
    setEditFrame({ file: f.path, start: l.new, end: l.new })
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
  /** the expander row (or its revealed rows) for the gap starting at `from` */
  const gapBlock = (from: number, trailing: boolean, label: string): React.ReactNode => {
    const gap = trailing ? gaps.find((g) => g.to === null && g.from === from) : gapAt(from, undefined)
    if (!gap || (gap.to != null && gap.to < gap.from)) return null
    const rows = expandedGaps[gap.key]
    if (rows) {
      return rows.map((l) => (
        <Fragment key={`x${gap.key}-${l.new}`}>
          {coveredBy(l) ? mountFrame(`xf-${l.new}`) : (
            <div
              className="dline"
              data-limn-line={`${f.path}:new:${l.new}`}
              onDoubleClick={editable ? () => openFrameAt(l) : undefined}
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
          )}
        </Fragment>
      ))
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
          {hunks.map((h, i) => (
            <div key={i} className={h.since ? 'hunk since-hunk' : 'hunk'} style={{ position: 'relative' }}>
              {gapBlock(i === 0 ? 1 : gapStarts[i], false, i === 0 ? 'above' : '')}
              <div className="hunk-head">
                <I.diff style={{ width: 12, height: 12, opacity: 0.6 }} />
                {h.range}
                {h.header && <span style={{ color: 'var(--muted-2)' }}>{h.header}</span>}
                {h.since && <span style={{ color: 'var(--amber)' }}>· changed since approval</span>}
                {!h.since && h.sinceViewed && <span style={{ color: 'var(--amber)' }}>· changed since viewed</span>}
              </div>
              {h.lines.map((l, j) => {
                const side: 'new' | 'old' = l.new != null ? 'new' : 'old'
                const lineNo = l.new ?? l.old
                const threads = threadsFor(lineNo, side)
                const originCls = l.origin === 'staged' ? ' staged'
                  : l.origin === 'unstaged' ? ' unstaged'
                  : (l.since || l.sinceViewed) ? ' since' : ''
                // rows the open frame covers: the first mounts the editor, the rest
                // hide; a − row adjacent to covered rows stays as a grey sliver
                // (its text is what the edit may replace — scope marker, not input).
                if (frame && coveredBy(l)) {
                  return <Fragment key={`fr-${j}`}>{mountFrame(`frame-${i}-${j}`)}</Fragment>
                }
                const sliver = frame != null && l.new == null &&
                  (coveredBy(h.lines[j - 1] ?? {} as DiffLine) || coveredBy(h.lines[j + 1] ?? {} as DiffLine))
                return (
                  <Fragment key={j}>
                    <div
                      className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + originCls + (sliver ? ' frame-sliver' : '')}
                      data-limn-line={lineNo != null ? `${f.path}:${side}:${lineNo}` : undefined}
                      onDoubleClick={editable && l.new != null ? () => openFrameAt(l) : undefined}
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
              })}
            </div>
          ))}
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
