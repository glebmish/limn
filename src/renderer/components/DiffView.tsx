import { Fragment, useMemo, useState } from 'react'
import type { Comment, DiffLine, FileDiff } from '../../shared/types'
import { I, Delta, ficonClass } from '../kit'
import { useStore } from '../store'
import { addComment, sendComments } from '../lib/comments'
import { Composer, InlineThread } from './Threads'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'

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
  const { viewedAt, toggleViewed, guidance, loaded, gen, focusTarget } = useStore()
  const comments = loaded?.state.comments ?? []
  const { dir, name } = splitPath(f.path)
  const focused = focusTarget?.file === f.path
  const [mode, setMode] = useState<DiffMode>('branch')
  const [composerAt, setComposerAt] = useState<{ line: number; side: 'new' | 'old'; hunkRange: string; content: string } | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)
  const [steer, setSteer] = useState('')

  const fileComments = comments.filter((c) => c.anchor.kind === 'diff' && c.anchor.file === f.path)
  const outdated = fileComments.filter((c) => c.status === 'outdated')
  const queuedHere = fileComments.filter((c) => c.status === 'queued')
  const hasSince = f.hunks.some((h) => h.since)
  const hasSinceViewed = f.hunks.some((h) => h.sinceViewed)
  const viewedSha = viewedAt[f.path]
  // a viewed file that changed afterwards is no longer "viewed" — the tick clears itself
  const isViewed = Boolean(viewedSha) && !hasSinceViewed
  // a focus on a viewed file force-shows its diff body without clearing the viewed tick
  const showBody = !isViewed || focused
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
    <div className={'gfile' + (isViewed && !focused ? ' viewed' : '')}>
      <div className="gfile-head" data-lr-file={f.path}>
        <span className="pth">
          <span className={'ficon ' + ficonClass(f.path)}></span>
          <span><span className="dim">{dir}</span>{name}</span>
          {f.status === 'renamed' && f.oldPath && <span className="dim" style={{ fontWeight: 400 }}>← {f.oldPath}</span>}
          {f.status === 'deleted' && <span className="pill pill-risk">deleted</span>}
        </span>
        <Delta add={f.add} del={f.del} />
        {!isViewed && hasSince && <span className="pill pill-amber"><I.changed />changed since approval</span>}
        {!isViewed && !hasSince && hasSinceViewed && <span className="pill pill-amber"><I.eye />changed since viewed</span>}
        <span className="grow"></span>
        {!isViewed && (hasSince || hasSinceViewed) && (
          <span className="seg seg-sm gfile-seg">
            <button className={effectiveMode === 'branch' ? 'on' : ''} onClick={() => setMode('branch')}>Full diff</button>
            {hasSince && <button className={effectiveMode === 'approved' ? 'on' : ''} onClick={() => setMode('approved')}>Since approved</button>}
            {hasSinceViewed && <button className={effectiveMode === 'viewed' ? 'on' : ''} onClick={() => setMode('viewed')}>Since viewed</button>}
          </span>
        )}
        {!isViewed && (
          <button
            className={'gfile-regen' + (regenOpen ? ' on' : '')}
            onClick={() => setRegenOpen((o) => !o)}
            title="Send this file's comments to the agent, optionally with a steer"
          >
            <I.changed style={{ width: 13, height: 13 }} />Regenerate
          </button>
        )}
        <label className="file-viewed">
          <input type="checkbox" checked={isViewed} onChange={() => toggleViewed(f.path, isViewed)} />
          <span className="fv-box">{isViewed && <I.check style={{ width: 10, height: 10 }} />}</span>
          Viewed
        </label>
      </div>

      {!isViewed && regenOpen && (
        <div className="regen-panel">
          <div className="rg-feed">
            <I.spark style={{ width: 12, height: 12, color: queuedHere.length ? 'var(--accent)' : 'var(--muted)', flex: '0 0 auto', marginTop: 2 }} />
            <span>
              {queuedHere.length > 0
                ? <>The agent will address your <b>{queuedHere.length} comment{queuedHere.length > 1 ? 's' : ''}</b> on this file. Add a steer to redirect the approach.</>
                : <>No comments on this file yet — add a steer to tell the agent what to change.</>}
            </span>
          </div>
          <textarea
            className="rg-steer"
            rows={2}
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            placeholder="Optional steer — e.g. “use a sliding window instead of a token bucket”"
          />
          <div className="rg-foot">
            <span className="rg-note">Creates a new iteration on this branch</span>
            <span className="grow"></span>
            <button className="btn btn-sm btn-ghost" onClick={() => setRegenOpen(false)}>Cancel</button>
            <button
              className="btn btn-sm btn-primary"
              disabled={gen.running || (queuedHere.length === 0 && !steer.trim())}
              onClick={() => {
                sendComments(queuedHere.map((c) => c.id), steer.trim() ? `${steer.trim()} (scope: ${f.path})` : `Only address the listed comments. Scope: ${f.path}`)
                setRegenOpen(false)
              }}
            >
              <I.changed style={{ width: 12, height: 12 }} />Regenerate file
            </button>
          </div>
        </div>
      )}

      {!isViewed && guidance === 'narrated' && plainNote && (
        <div className="plain-note">
          <I.spark style={{ width: 12, height: 12, color: 'var(--accent)', flex: '0 0 auto', marginTop: 2 }} />
          <span>{plainNote}</span>
        </div>
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
                return (
                  <Fragment key={j}>
                    <div
                      className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + (l.since || l.sinceViewed ? ' since' : '')}
                      data-lr-line={lineNo != null ? `${f.path}:${side}:${lineNo}` : undefined}
                    >
                      <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
                      <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                      <CodeLine text={l.text} lang={lang} ranges={wordMarks[i]?.get(j)} />
                      <button
                        className="gutter-add lr-line-add"
                        title="Comment on this line"
                        onClick={() => setComposerAt({ line: lineNo!, side, hunkRange: h.range, content: l.text })}
                      >
                        <I.plus style={{ width: 10, height: 10 }} />
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
  )
}
