import type { CommentAnchor, ReviewAnnotations, SessionMeta } from '../../shared/types.js'
import { stampAnchor } from '../anchorStamp.js'

/** Post-merge stamping pass (mirrors `add_comment`, tools.ts): enrich every
 *  diff-kind narration block anchor (and, as of A3, diagram node anchor) with
 *  its creation-time AnchorStamp + git context, the same way user/agent
 *  comments are stamped, so a block/node anchor survives later drift instead
 *  of going stale silently. Mutates `ann` in place — call it after
 *  merge/splice, before the annotations are persisted. `stampAnchor` never
 *  throws (degrades to unstamped on any git failure), so this pass can never
 *  turn a successful generation into a failed one. A4 may extend this further
 *  to hotspot anchors — keep new anchor kinds as additional loops here rather
 *  than growing these. */
export async function stampAnnotationAnchors(workdir: string, session: SessionMeta, ann: ReviewAnnotations): Promise<void> {
  for (const section of ann.sections) {
    for (const block of section.narration) {
      if (block.anchor?.kind === 'diff') {
        block.anchor = await stampAnchor(workdir, session, block.anchor) as Extract<CommentAnchor, { kind: 'diff' }>
      }
    }
    if (section.diagram) {
      for (const node of section.diagram.nodes) {
        if (node.anchor?.kind === 'diff') {
          node.anchor = await stampAnchor(workdir, session, node.anchor) as Extract<CommentAnchor, { kind: 'diff' }>
        }
      }
    }
  }
}
