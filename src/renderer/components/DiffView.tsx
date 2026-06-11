import { Fragment, useState } from 'react'
import type { Comment, FileDiff } from '../../shared/types'
import { I, Delta, ficonClass } from '../kit'
import { useStore } from '../store'
import { addComment, sendComments } from '../lib/comments'
import { Composer, InlineThread } from './Threads'

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

export type DiffMode = 'parent' | 'approved'

export function DiffView({ f, reReview, mode, setMode, plainNote }: {
  f: FileDiff
  reReview: boolean
  mode: DiffMode
  setMode: (m: DiffMode) => void
  plainNote?: string
}) {
  const { viewed, toggleViewed, guidance, loaded, gen } = useStore()
  const comments = loaded?.state.comments ?? []
  const isViewed = viewed.has(f.path)
  const { dir, name } = splitPath(f.path)
  const [composerAt, setComposerAt] = useState<{ line: number; side: 'new' | 'old'; hunkRange: string; content: string } | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)
  const [steer, setSteer] = useState('')

  const fileComments = comments.filter((c) => c.anchor.kind === 'diff' && c.anchor.file === f.path)
  const outdated = fileComments.filter((c) => c.status === 'outdated')
  const queuedHere = fileComments.filter((c) => c.status === 'queued')
  const hasSince = f.hunks.some((h) => h.since)
  const hunks = mode === 'approved' ? f.hunks.filter((h) => h.since) : f.hunks

  const threadsFor = (line: number | null, side: 'new' | 'old'): Comment[] =>
    line == null
      ? []
      : fileComments.filter((c) =>
          c.anchor.kind === 'diff' && c.anchor.side === side && c.anchor.line === line && c.status !== 'outdated'
        )

  return (
    <div className={'gfile' + (isViewed ? ' viewed' : '')}>
      <div className="gfile-head">
        <span className="pth">
          <span className={'ficon ' + ficonClass(f.path)}></span>
          <span><span className="dim">{dir}</span>{name}</span>
          {f.status === 'renamed' && f.oldPath && <span className="dim" style={{ fontWeight: 400 }}>← {f.oldPath}</span>}
          {f.status === 'deleted' && <span className="pill pill-risk">deleted</span>}
        </span>
        <Delta add={f.add} del={f.del} />
        {!isViewed && hasSince && <span className="pill pill-amber"><I.changed />changed since approval</span>}
        <span className="grow"></span>
        {reReview && !isViewed && hasSince && (
          <span className="seg seg-sm gfile-seg">
            <button className={mode === 'parent' ? 'on' : ''} onClick={() => setMode('parent')}>Full diff</button>
            <button className={mode === 'approved' ? 'on' : ''} onClick={() => setMode('approved')}>Since approved</button>
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
          <input type="checkbox" checked={isViewed} onChange={() => toggleViewed(f.path)} />
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

      {!isViewed && (
        <div className="gfile-diff">
          {f.binary && <div className="nodiff">Binary file — no diff to show.</div>}
          {!f.binary && hunks.length === 0 && (
            <div className="nodiff">{mode === 'approved' ? 'No changes since you approved.' : 'No textual changes.'}</div>
          )}
          {hunks.map((h, i) => (
            <div key={i} className={h.since ? 'hunk since-hunk' : 'hunk'} style={{ position: 'relative' }}>
              <div className="hunk-head">
                <I.diff style={{ width: 12, height: 12, opacity: 0.6 }} />
                {h.range}
                {h.header && <span style={{ color: 'var(--muted-2)' }}>{h.header}</span>}
                {h.since && <span style={{ color: 'var(--amber)' }}>· changed since approval</span>}
              </div>
              {h.lines.map((l, j) => {
                const side: 'new' | 'old' = l.new != null ? 'new' : 'old'
                const lineNo = l.new ?? l.old
                const threads = threadsFor(lineNo, side)
                return (
                  <Fragment key={j}>
                    <div className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + (l.since ? ' since' : '')}>
                      <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
                      <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                      <span className="code">{l.text}</span>
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
