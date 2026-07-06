import { Fragment, useMemo } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I } from '../kit'
import { diffHunksForMode, useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'
import { describeModeChange } from './FileHeader'

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
                return (
                  <Fragment key={j}>
                    <div
                      className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + originCls}
                      data-limn-line={lineNo != null ? `${f.path}:${side}:${lineNo}` : undefined}
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
