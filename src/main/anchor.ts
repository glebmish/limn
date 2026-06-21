import type { Artifact, Comment, DiffSkeleton } from '../shared/types.js'

/** Re-anchor positional comments after the branch changed (mutates comments).
 *  Exact-content match; nearest line wins on duplicates; no match → outdated. */
export function reanchorComments(comments: Comment[], skeleton: DiffSkeleton, artifacts: Artifact[]): void {
  const fileMap = new Map(skeleton.files.map((f) => [f.path, f]))
  const artMap = new Map(artifacts.map((a) => [a.path, a]))

  for (const c of comments) {
    if (c.status === 'resolved') continue

    if (c.anchor.kind === 'diff') {
      const file = fileMap.get(c.anchor.file)
      const side = c.anchor.side
      const candidates: { line: number; range: string }[] = []
      if (file) {
        for (const h of file.hunks) {
          for (const l of h.lines) {
            if (l.text !== c.anchor.lineContent) continue
            const no = side === 'new' ? l.new : l.old
            if (no == null) continue
            if (side === 'new' && l.kind === 'del') continue
            if (side === 'old' && l.kind === 'add') continue
            candidates.push({ line: no, range: h.range })
          }
        }
      }
      const best = pickNearest(candidates, c.anchor.line)
      if (best) {
        c.anchor = { ...c.anchor, line: best.line, hunkRange: best.range }
        if (c.status === 'outdated') c.status = 'queued'
      } else {
        c.status = 'outdated'
      }
    } else if (c.anchor.kind === 'artifact') {
      const art = artMap.get(c.anchor.path)
      const candidates: { line: number; range: string }[] = []
      if (art) {
        art.lines.forEach((text, idx) => {
          if (text === (c.anchor as { lineContent: string }).lineContent) candidates.push({ line: idx + 1, range: '' })
        })
      }
      const best = pickNearest(candidates, c.anchor.line)
      if (best) {
        c.anchor = { ...c.anchor, line: best.line }
        if (c.status === 'outdated') c.status = 'queued'
      } else {
        c.status = 'outdated'
      }
    }
    // all non-positional anchors are stable — untouched: section, summary, file,
    // question, plan-step, title, acceptance, deviation, hunk, and selection
    // (content-addressed via its own quote)
  }
}

function pickNearest(candidates: { line: number; range: string }[], target: number): { line: number; range: string } | null {
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (Math.abs(b.line - target) < Math.abs(a.line - target) ? b : a))
}
