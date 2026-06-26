import { Fragment, useMemo, useState } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I, Delta, EngineGlyph, CmtPlus } from '../kit'
import { GUIDANCE, useStore } from '../store'
import { addComment } from '../lib/comments'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'
import { clickable } from '../lib/clickable'

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

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

export type DiffMode = 'branch' | 'approved' | 'viewed'

export function DiffView({ f, plainNote }: {
  f: FileDiff
  plainNote?: string
}) {
  const { viewedAt, toggleViewed, loaded, focusTarget, openDoc } = useStore()
  const comments = loaded?.state.comments ?? []
  const { dir, name } = splitPath(f.path)
  // recognized spec/plan: this same file is reviewable rendered at the top
  const artifact = loaded?.artifacts.find((a) => a.path === f.path)
  const focused = focusTarget?.file === f.path
  const [mode, setMode] = useState<DiffMode>('branch')
  const [composerAt, setComposerAt] = useState<{ line: number; side: 'new' | 'old'; hunkRange: string; content: string } | null>(null)
  const [fileCommenting, setFileCommenting] = useState(false)
  // manual open/collapse override for this file's diff. null = follow the default
  // (open when unviewed, collapsed when viewed); true/false = explicitly toggled.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)

  const fileComments = comments.filter((c) => c.anchor.kind === 'diff' && c.anchor.file === f.path)
  const fileLevelComments = comments.filter((c) => c.anchor.kind === 'file' && c.anchor.file === f.path)
  const outdated = fileComments.filter((c) => c.status === 'outdated')
  const hasSince = f.hunks.some((h) => h.since)
  const hasSinceViewed = f.hunks.some((h) => h.sinceViewed)
  const hasUncommitted = f.hunks.some((h) => h.lines.some((l) => l.origin === 'uncommitted'))
  const viewMark = viewedAt[f.path]
  // a viewed file that changed afterwards is no longer "viewed" — the tick clears itself,
  // whether the change came from a commit (hasSinceViewed) or an uncommitted edit
  // (content hash drifted from the snapshot).
  const contentDrift = Boolean(viewMark) && viewMark.hash !== (f.fileHash ?? '')
  const isViewed = Boolean(viewMark) && !hasSinceViewed && !contentDrift
  // uncommitted-only drift: content changed since viewing with no commit-level marks
  const dirtyDrift = contentDrift && !hasSinceViewed
  const fileStatus = f.status === 'deleted' ? 'st-risk' : (hasSince || hasSinceViewed || dirtyDrift) ? 'st-amber' : isViewed ? 'st-rev' : 'st-unrev'
  // open by default, collapsed once viewed — unless the header was clicked to
  // override it. A focus always force-shows the body (without clearing the tick).
  const effectiveOpen = manualOpen ?? !isViewed
  const showBody = focused || effectiveOpen
  const effectiveMode: DiffMode =
    (mode === 'approved' && !hasSince) || (mode === 'viewed' && !hasSinceViewed) ? 'branch' : mode
  const hunks =
    effectiveMode === 'approved' ? f.hunks.filter((h) => h.since)
    : effectiveMode === 'viewed' ? f.hunks.filter((h) => h.sinceViewed)
    : f.hunks
  const lang = langForPath(f.path)
  const wordMarks = useMemo(() => hunks.map((h) => hunkWordMarks(h.lines)), [hunks])

  const threadsFor = (line: number | null, side: 'new' | 'old'): Comment[] =>
    line == null
      ? []
      : fileComments.filter((c) =>
          c.anchor.kind === 'diff' && c.anchor.side === side && c.anchor.line === line && c.status !== 'outdated'
        )

  return (
    <div className="gfile-wrap">
      <span className="gfile-cmt-zone" />
      <CmtPlus extra="gfile-plus" onClick={() => setFileCommenting(true)} />
      <div className={'gfile' + (isViewed && !focused ? ' viewed' : '')}>
      <div
        className="gfile-head"
        data-limn-file={f.path}
        {...clickable(() => setManualOpen(!effectiveOpen), { expanded: showBody })}
        title={effectiveOpen ? 'Collapse this file' : 'Expand this file'}
        style={{ cursor: 'pointer' }}
      >
        <span className="pth">
          <I.chevR className="gfile-caret" style={{ width: 11, height: 11, transform: showBody ? 'rotate(90deg)' : '', transition: 'transform .12s' }} />
          <span className={'ficon ' + fileStatus}></span>
          <span><span className="dim">{dir}</span>{name}</span>
          {f.status === 'renamed' && f.oldPath && <span className="dim" style={{ fontWeight: 400 }}>← {f.oldPath}</span>}
          {f.status === 'deleted' && <span className="pill pill-risk">deleted</span>}
          {artifact && (
            <button
              className="art-badge"
              title={`Recognized ${artifact.role} — open the rendered document`}
              onClick={(e) => { e.stopPropagation(); openDoc(f.path) }}
            >
              {artifact.role === 'plan' ? <I.plan style={{ width: 10, height: 10 }} /> : <I.doc style={{ width: 10, height: 10 }} />}
              {artifact.role === 'plan' ? 'Plan' : 'Spec'}
              <I.arrow style={{ width: 9, height: 9, transform: 'rotate(-90deg)' }} />
            </button>
          )}
        </span>
        <Delta add={f.add} del={f.del} />
        {!isViewed && hasSince && <span className="pill pill-amber"><I.changed />changed since approval</span>}
        {!isViewed && !hasSince && hasSinceViewed && <span className="pill pill-amber"><I.eye />changed since viewed</span>}
        {!isViewed && !hasSince && !hasSinceViewed && dirtyDrift && <span className="pill pill-amber"><I.eye />changed since viewed · uncommitted</span>}
        <span className="grow"></span>
        {hasUncommitted && (
          <span
            className="diff-legend"
            title="Lines on the dotted rail are uncommitted working-tree changes, shown for context. Approving and marking Viewed record the committed state only."
          >
            <span className="lg-rail" />uncommitted
          </span>
        )}
        {!isViewed && (hasSince || hasSinceViewed) && (
          <span className="seg seg-sm gfile-seg" onClick={(e) => e.stopPropagation()}>
            <button className={effectiveMode === 'branch' ? 'on' : ''} aria-pressed={effectiveMode === 'branch'} onClick={() => setMode('branch')}>Full diff</button>
            {hasSince && <button className={effectiveMode === 'approved' ? 'on' : ''} aria-pressed={effectiveMode === 'approved'} onClick={() => setMode('approved')}>Since approved</button>}
            {hasSinceViewed && <button className={effectiveMode === 'viewed' ? 'on' : ''} aria-pressed={effectiveMode === 'viewed'} onClick={() => setMode('viewed')}>Since viewed</button>}
          </span>
        )}
        <label className="file-viewed" onClick={(e) => e.stopPropagation()}>
          {/* viewed drives the default collapse, so clear any manual override and
              let it follow the new viewed state (tick → collapse, untick → open) */}
          <input type="checkbox" checked={isViewed} onChange={() => { toggleViewed(f.path, isViewed); setManualOpen(null) }} />
          <span className="fv-box">{isViewed && <I.check style={{ width: 10, height: 10 }} />}</span>
          Viewed
        </label>
      </div>

      {(fileLevelComments.length > 0 || fileCommenting) && (
        <div className="gfile-filecmt">
          {fileLevelComments.map((c) => (
            <InlineThread key={c.id} c={c} locLabel={`on ${name}`} />
          ))}
          {fileCommenting && (
            <Composer
              placeholder={`Comment on ${name} as a whole — the agent gets it with your next batch…`}
              onCancel={() => setFileCommenting(false)}
              onSubmit={(text) => {
                void addComment({ kind: 'file', file: f.path }, text)
                setFileCommenting(false)
              }}
            />
          )}
        </div>
      )}

      {!isViewed && GUIDANCE === 'narrated' && plainNote && (
        <Commentable scope={{ region: 'file-note', file: f.path }}>
          <div className="plain-note">
            <EngineGlyph engine={loaded?.state.annotations?.generatedBy?.engine ?? loaded?.state.agent?.engine} style={{ width: 12, height: 12, color: 'var(--accent)', flex: '0 0 auto', marginTop: 2 }} />
            <span>{plainNote}</span>
          </div>
          <SelectionThreads scope={{ region: 'file-note', file: f.path }} />
        </Commentable>
      )}

      {showBody && (
        <div className="gfile-diff">
          {f.binary && <div className="nodiff">Binary file — no diff to show.</div>}
          {!f.binary && hunks.length === 0 && (
            <div className="nodiff">
              {effectiveMode === 'approved' ? 'No changes since you approved.'
                : effectiveMode === 'viewed' ? 'No changes since you viewed.'
                : 'No textual changes.'}
            </div>
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
                const uncommitted = l.origin === 'uncommitted'
                return (
                  <Fragment key={j}>
                    <div
                      className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + (uncommitted ? ' uncommitted' : (l.since || l.sinceViewed) ? ' since' : '')}
                      data-limn-line={lineNo != null ? `${f.path}:${side}:${lineNo}` : undefined}
                    >
                      <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
                      <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                      <CodeLine text={l.text} lang={lang} ranges={wordMarks[i]?.get(j)} />
                      <button
                        className="gutter-add limn-line-add"
                        title="Comment on this line"
                        onClick={() => setComposerAt({ line: lineNo!, side, hunkRange: h.range, content: l.text })}
                      >
                        <I.plus style={{ width: 12, height: 12 }} />
                      </button>
                    </div>
                    {threads.map((c) => (
                      <InlineThread key={c.id} c={c} locLabel={`on line ${lineNo}`} />
                    ))}
                    {composerAt && composerAt.line === lineNo && composerAt.side === side && composerAt.content === l.text && (
                      <Composer
                        placeholder="Leave a comment for the agent…"
                        onCancel={() => setComposerAt(null)}
                        onSubmit={(text) => {
                          void addComment(
                            { kind: 'diff', file: f.path, side, line: composerAt.line, hunkRange: composerAt.hunkRange, lineContent: composerAt.content },
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
      </div>
    </div>
  )
}
