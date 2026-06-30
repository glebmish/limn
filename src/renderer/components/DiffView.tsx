import { Fragment, useMemo, useState } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I, Delta, EngineGlyph, CmtPlus } from '../kit'
import { effectiveDiffMode, fileViewed, fileIsExcluded, GUIDANCE, useStore, type DiffMode } from '../store'
import { addComment } from '../lib/comments'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'
import { clickable } from '../lib/clickable'
import { reviewStatusForFile } from '../lib/fileStatus'
import { FileGlyph } from './FileGlyph'

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

/** Human label for a mode-only change. The overwhelmingly common case is the
 *  executable bit flipping; anything else (e.g. file ↔ symlink) falls back to the
 *  raw octal modes. */
function describeModeChange(m: { from: string; to: string }): string {
  const isExec = (mode: string): boolean => (parseInt(mode.slice(-3), 8) & 0o111) !== 0
  const fromX = isExec(m.from), toX = isExec(m.to)
  if (!fromX && toX) return 'executable bit set'
  if (fromX && !toX) return 'executable bit cleared'
  return `mode ${m.from} → ${m.to}`
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

export function DiffView({ f, plainNote }: {
  f: FileDiff
  plainNote?: string
}) {
  const { viewedAt, toggleViewed, toggleExcluded, loaded, focusTarget, openDoc, diffMode, fileDiffMode } = useStore()
  const excluded = fileIsExcluded(loaded, f)
  const comments = loaded?.state.comments ?? []
  const { dir, name } = splitPath(f.path)
  // recognized spec/plan: this same file is reviewable rendered at the top
  const artifact = loaded?.artifacts.find((a) => a.path === f.path)
  const focused = focusTarget?.file === f.path
  // baseline this file is shown at: its own override, else the global switch (set
  // from the list-header dropdown — there's no per-file mode control any more)
  const mode = effectiveDiffMode(f.path, diffMode, fileDiffMode)
  const [composerAt, setComposerAt] = useState<{ line: number; side: 'new' | 'old'; hunkRange: string; content: string } | null>(null)
  const [fileCommenting, setFileCommenting] = useState(false)
  // manual open/collapse override for this file's diff. null = follow the default
  // (open when unviewed, collapsed when viewed); true/false = explicitly toggled.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)

  const fileComments = comments.filter((c) => c.anchor.kind === 'diff' && c.anchor.file === f.path)
  const fileLevelComments = comments.filter((c) => c.anchor.kind === 'file' && c.anchor.file === f.path)
  const outdated = fileComments.filter((c) => c.status === 'outdated')
  const viewMark = viewedAt[f.path]
  // single source of truth (matches section counts); ignores stale `sinceViewed`
  // once the mark sits at head, so re-viewing a drifted file sticks immediately.
  const isViewed = fileViewed(f, viewedAt, loaded?.skeleton.headSha)
  // a file you ticked viewed that has since changed sits in the amber `~` middle
  // ground: not fully viewed, but distinct from one you never looked at. Clicking
  // its tick re-views it (stamps a fresh mark at head → green).
  const changedSinceViewed = !isViewed && Boolean(viewMark)
  const fileStatus = reviewStatusForFile(f, viewedAt, loaded?.skeleton.headSha)
  // open by default, collapsed once viewed — unless the header was clicked to
  // override it. A focus always force-shows the body (without clearing the tick).
  const effectiveOpen = manualOpen ?? !isViewed
  const showBody = focused || effectiveOpen
  // show exactly the selected baseline — if the file has no diff at that baseline it
  // renders the empty state below, rather than silently falling back to the full diff
  // (which made the shown content contradict the selected "Since …" mode).
  const effectiveMode: DiffMode = mode
  const hunks =
    mode === 'approved' ? (f.sinceHunks ?? [])
    : mode === 'viewed' ? (f.sinceViewedHunks ?? [])
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
      <div className={'gfile' + (showBody ? ' open' : ' collapsed') + (isViewed && !focused ? ' viewed' : '')}>
      <div
        className="gfile-head"
        data-limn-file={f.path}
        {...clickable(() => setManualOpen(!effectiveOpen), { expanded: showBody })}
        title={effectiveOpen ? 'Collapse this file' : 'Expand this file'}
        style={{ cursor: 'pointer' }}
      >
        <span className="pth">
          <I.chevR className="gfile-caret" style={{ width: 11, height: 11, transform: showBody ? 'rotate(90deg)' : '', transition: 'transform .12s' }} />
          <FileGlyph status={fileStatus} />
          <span><span className="dim">{dir}</span>{name}</span>
          {f.status === 'renamed' && f.oldPath && <span className="dim" style={{ fontWeight: 400 }}>← {f.oldPath}</span>}
          {f.status === 'deleted' && <span className="pill pill-risk">deleted</span>}
          {f.conflict && <span className="pill pill-risk" title="Unresolved merge conflict — conflict markers appear inline in the diff below">conflict</span>}
          {f.modeChange && (
            <span className="pill pill-ghost" title={`File mode changed from ${f.modeChange.from} to ${f.modeChange.to}`}>
              {describeModeChange(f.modeChange)}
            </span>
          )}
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
        <span className="grow"></span>
        {/* excluded files carry no review state, so they show no Viewed checkbox */}
        {!excluded && (
          <label className={'file-viewed' + (changedSinceViewed ? ' amber' : '')} onClick={(e) => e.stopPropagation()}>
            {/* viewed drives the default collapse, so clear any manual override and
                let it follow the new viewed state (tick → collapse, untick → open).
                The amber `~` middle ground reads as not-yet-viewed to the checkbox,
                so clicking it re-views. */}
            <input type="checkbox" checked={isViewed} onChange={() => { toggleViewed(f.path, isViewed); setManualOpen(null) }} />
            <span className="fv-box">{isViewed ? <I.check style={{ width: 10, height: 10 }} /> : changedSinceViewed ? '~' : null}</span>
            Viewed
          </label>
        )}
        {/* an included untracked file gets an icon-only × to send it back to Untracked */}
        {f.untracked && (
          <button
            className="file-exclude"
            onClick={(e) => { e.stopPropagation(); toggleExcluded(f) }}
            title={excluded ? 'Include in the review' : 'Exclude — back to Untracked'}
            aria-label={excluded ? `Include ${f.path}` : `Exclude ${f.path} — back to Untracked`}
          >
            {excluded ? <I.plus style={{ width: 13, height: 13 }} /> : <I.x style={{ width: 13, height: 13 }} />}
          </button>
        )}
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
                : f.modeChange ? `Mode-only change (${describeModeChange(f.modeChange)}, ${f.modeChange.from} → ${f.modeChange.to}) — no content change.`
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
