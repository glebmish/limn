import type { Artifact, FileDiff } from '../../shared/types'
import { I, Delta } from '../kit'
import { useStore } from '../store'
import { clickable } from '../lib/clickable'
import type { ReviewGlyphStatus } from '../lib/fileStatus'
import { FileGlyph } from './FileGlyph'

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

/** Human label for a mode-only change. The overwhelmingly common case is the
 *  executable bit flipping; anything else (e.g. file ↔ symlink) falls back to the
 *  raw octal modes. */
export function describeModeChange(m: { from: string; to: string }): string {
  const isExec = (mode: string): boolean => (parseInt(mode.slice(-3), 8) & 0o111) !== 0
  const fromX = isExec(m.from), toX = isExec(m.to)
  if (!fromX && toX) return 'executable bit set'
  if (fromX && !toX) return 'executable bit cleared'
  return `mode ${m.from} → ${m.to}`
}

/** Presentational file header (the `gfile-head` block). Every value it renders is
 *  computed by the DiffView shell and handed down; it owns no state. */
export function FileHeader({ f, excluded, isViewed, changedSinceViewed, fileStatus, showBody, effectiveOpen, artifact, onToggleOpen, onToggleViewed, onToggleExcluded }: {
  f: FileDiff
  excluded: boolean
  isViewed: boolean
  changedSinceViewed: boolean
  fileStatus: ReviewGlyphStatus
  showBody: boolean
  effectiveOpen: boolean
  artifact: Artifact | undefined
  onToggleOpen: () => void
  onToggleViewed: () => void
  onToggleExcluded: () => void
}) {
  const { dir, name } = splitPath(f.path)
  return (
    <div
      className="gfile-head"
      data-limn-file={f.path}
      {...clickable(onToggleOpen, { expanded: showBody })}
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
          <span className="pill pill-amber" title={`File mode changed from ${f.modeChange.from} to ${f.modeChange.to} — ${describeModeChange(f.modeChange)}`}>mode</span>
        )}
        {artifact && (
          <button
            className="art-badge"
            title={`Recognized ${artifact.role} — open the rendered document`}
            onClick={(e) => { e.stopPropagation(); useStore.getState().openDoc(f.path) }}
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
          <input
            type="checkbox"
            checked={isViewed}
            // two-state by design — clicking always re-views. The amber `~` is drift,
            // not partial selection, so it's surfaced in the label, NOT as indeterminate.
            aria-label={`Viewed ${f.path}${changedSinceViewed ? ' — changed since you viewed it' : ''}`}
            onChange={onToggleViewed}
          />
          <span className="fv-box">{isViewed ? <I.check style={{ width: 10, height: 10 }} /> : changedSinceViewed ? '~' : null}</span>
          Viewed
        </label>
      )}
      {/* an included untracked file gets an icon-only × to send it back to Untracked */}
      {f.untracked && (
        <button
          className="file-exclude"
          onClick={(e) => { e.stopPropagation(); onToggleExcluded() }}
          title={excluded ? 'Include in the review' : 'Exclude — back to Untracked'}
          aria-label={excluded ? `Include ${f.path}` : `Exclude ${f.path} — back to Untracked`}
        >
          {excluded ? <I.plus style={{ width: 13, height: 13 }} /> : <I.x style={{ width: 13, height: 13 }} />}
        </button>
      )}
    </div>
  )
}
