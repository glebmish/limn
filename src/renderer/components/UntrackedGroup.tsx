import { useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { I } from '../kit'
import { useStore } from '../store'
import { FileGlyph } from './FileGlyph'
import { highlightLine, langForPath } from '../lib/highlight'

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

/** staged → solid rail, unstaged → dotted rail (untracked files are always unstaged). */
function originCls(origin: string | undefined): string {
  return origin === 'staged' ? ' staged' : origin === 'unstaged' ? ' unstaged' : ''
}

/** One untracked file: a compact row (glyph + path + delta + Include) that expands to
 *  peek its diff. Open/closed is component-local and intentionally NOT persisted — the
 *  group resets to all-collapsed on every load (these files carry no review state). */
function UntrackedRow({ f }: { f: FileDiff }) {
  const { toggleExcluded } = useStore()
  const [open, setOpen] = useState(false)
  const { dir, name } = splitPath(f.path)
  const lang = langForPath(f.path)
  return (
    <div className={'utrack-item' + (open ? ' open' : '')}>
      <div className="utrack-file" onClick={() => setOpen((o) => !o)}>
        <I.chevR className="cv" />
        <FileGlyph status="st-unrev" />
        <span className="nm"><span className="dim">{dir}</span>{name}</span>
        <span className="delta">
          {f.add > 0 && <span className="add">+{f.add}</span>}
          {f.del > 0 && <> <span className="del">−{f.del}</span></>}
        </span>
        <button
          className="utrack-inc"
          title="Include in the review"
          aria-label={`Include ${f.path} in the review`}
          onClick={(e) => { e.stopPropagation(); toggleExcluded(f) }}
        >
          <I.plus style={{ width: 12, height: 12 }} />
        </button>
      </div>
      {open && (
        <div className="utrack-body">
          <div className="gfile-diff">
            {f.binary && <div className="nodiff">Binary file — no diff to show.</div>}
            {!f.binary && f.hunks.length === 0 && <div className="nodiff">No textual changes.</div>}
            {f.hunks.map((h, i) => (
              <div key={i} className="hunk">
                <div className="hunk-head"><I.diff style={{ width: 12, height: 12, opacity: 0.6 }} />{h.range}</div>
                {h.lines.map((l, j) => (
                  <div key={j} className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '') + originCls(l.origin)}>
                    <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
                    <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                    <span className="code"><span className="code-syn" dangerouslySetInnerHTML={{ __html: highlightLine(l.text.replace(/\t/g, '  '), lang) }} /></span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The "Untracked" group (design 07 `utrack`): a compact bordered box, narrower than the
 *  main diff column, listing untracked files kept out of the review. Each row is
 *  collapsed by default; Include lifts a file into the normal diff above. */
export function UntrackedGroup({ files }: { files: FileDiff[] }) {
  if (files.length === 0) return null
  return (
    <div className="utrack">
      <div className="utrack-head">
        <I.folder className="uh-ic" style={{ width: 13, height: 13 }} />
        <span>Untracked</span>
        <span className="utrack-n">{files.length}</span>
      </div>
      <div className="utrack-list">
        {files.map((f) => <UntrackedRow key={f.path} f={f} />)}
      </div>
    </div>
  )
}
