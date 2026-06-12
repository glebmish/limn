import { Fragment, useMemo, useState } from 'react'
import type { DiffLine, FileDiff } from '../../shared/types'
import { I, Delta, ficonClass } from '../kit'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../lib/worddiff'
import { highlightLine, langForPath } from '../lib/highlight'

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

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

/** Read-only diff of a single file for the Compare preview. */
export function CompareDiff({ f }: { f: FileDiff }) {
  const { dir, name } = splitPath(f.path)
  const [open, setOpen] = useState(true)
  const lang = langForPath(f.path)
  const wordMarks = useMemo(() => f.hunks.map((h) => hunkWordMarks(h.lines)), [f])

  return (
    <div className="lr-cmp-file">
      <div className="cf-head" onClick={() => setOpen((o) => !o)}>
        <I.chevR style={{ width: 11, height: 11, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : undefined, transition: '.15s' }} />
        <span className="pth">
          <span className={'ficon ' + ficonClass(f.path)} />
          <span><span className="dim">{dir}</span>{name}</span>
          {f.status === 'renamed' && f.oldPath && <span className="dim" style={{ fontWeight: 400 }}>← {f.oldPath}</span>}
          {f.status === 'deleted' && <span className="pill pill-risk">deleted</span>}
        </span>
        <span className="grow" />
        <Delta add={f.add} del={f.del} />
      </div>
      {open && (
        <div className="gfile-diff">
          {f.binary && <div className="nodiff">Binary file — no diff to show.</div>}
          {!f.binary && f.hunks.length === 0 && <div className="nodiff">No textual changes.</div>}
          {f.hunks.map((h, i) => (
            <div key={i} className="hunk">
              <div className="hunk-head">
                <I.diff style={{ width: 12, height: 12, opacity: 0.6 }} />
                {h.range}
                {h.header && <span style={{ color: 'var(--muted-2)' }}>{h.header}</span>}
              </div>
              {h.lines.map((l, j) => (
                <Fragment key={j}>
                  <div className={'dline ' + (l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '')}>
                    <span className="gut"><span>{l.old ?? ''}</span><span>{l.new ?? ''}</span></span>
                    <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                    <CodeLine text={l.text} lang={lang} ranges={wordMarks[i]?.get(j)} />
                  </div>
                </Fragment>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
