import { useMemo } from 'react'
import { useStore } from '../store'
import { splitPath } from './FileHeader'
import { outsideDiffGroups, snippetLines } from '../lib/outsideDiff'
import type { Comment, CommentAnchor } from '../../shared/types'
import { InlineThread } from './Threads'

/** The trailing "outside this diff" band: comments (an action run's findings, above
 *  all) anchored to a file the review does not show. The diff has no panel to host
 *  them, so without this band they would count in "N proposed" and take part in
 *  Accept all while being visible nowhere. Each file header carries the same
 *  `data-limn-file` the diff headers do — a jump to the file lands here through the
 *  ordinary pipeline, so the proposal stepper needs no special case. The snippet is
 *  the stamped anchor context (±3 lines), not a fetch: a quote of the code, which is
 *  the option-B trade against synthesising a real file entry. */
export function OutsideDiffBand() {
  const loaded = useStore((s) => s.loaded)
  const comments = loaded?.state.comments
  const files = loaded?.skeleton.files
  const groups = useMemo(() => {
    if (!comments || !files) return []
    return outsideDiffGroups(comments, new Set(files.map((f) => f.path)))
  }, [comments, files])
  if (groups.length === 0) return null
  const total = groups.reduce((n, g) => n + g.comments.length, 0)
  return (
    <div className="vol-band odiff-band">
      <div className="vol-head">
        <span className="vol-title">Outside this diff</span>
        <span className="vol-count">{total}</span>
        <span className="vol-sub">{total} comment{total === 1 ? '' : 's'} outside this diff — on files the review does not change. Shown from the code as it was when the comment was made.</span>
      </div>
      {groups.map((g) => {
        const { dir, name } = splitPath(g.file)
        return (
          <div key={g.file} className="odiff-file">
            <div className="gfile-head odiff-head" data-limn-file={g.file}>
              <span className="pth"><span><span className="dim">{dir}</span>{name}</span></span>
            </div>
            {g.comments.map((c) => <OutsideEntry key={c.id} c={c} />)}
          </div>
        )
      })}
    </div>
  )
}

function OutsideEntry({ c }: { c: Comment }) {
  const a = c.anchor as Extract<CommentAnchor, { kind: 'diff' }>
  const lines = snippetLines(a)
  return (
    <div className="odiff-entry">
      <pre className="odiff-snip">
        {lines.map((l) => (
          <div key={l.n} className={l.hit ? 'odl hit' : 'odl'}>
            <span className="odn">{l.n}</span>
            <span className="odc">{l.text}</span>
          </div>
        ))}
      </pre>
      <InlineThread c={c} locLabel="outside this diff" />
    </div>
  )
}
