import type { Comment, Hotspot } from '../../shared/types.js'
import { REVIEW_ACTION_ID, isProposal, touched } from '../../shared/actions.js'

/** Mint anchored agent comments from a full generation's `hotspots` (A4). Mirrors
 *  `add_finding`'s Comment shape (tools.ts) — a hotspot IS a proposal from the review
 *  run (design board 14 v3: one concept, not two): `status:'proposed'` is an
 *  INVARIANT — hotspot comments are agent-authored and never enter the user's
 *  queued batch on their own; the reviewer's Accept is the only path in. A hotspot
 *  whose anchor file isn't in the diff is dropped (with a console warning) rather
 *  than producing a comment that resolves nowhere — same spirit as
 *  `mergeAnnotations`' unknown-file section/anchor gates. Anchors arrive already
 *  normalized (`hotspotsFromWire`); creation-time stamping happens at the ipc seam
 *  (`stampAnchor`), not here, mirroring `add_comment`. */
/** Prior-generation proposals a fresh full pass supersedes: the review run's own
 *  (`source.actionId === 'review'`), still a proposal (shown or dismissed), and never
 *  engaged (no replies). Anything the reviewer touched — accepted, kept, replied to —
 *  survives regeneration: deleting an engaged comment would drop reviewer work. A
 *  pre-v3 hotspot (stored `resolved`, no source) is an ordinary agent note now and is
 *  left alone. */
export function supersededHotspotIds(existing: readonly Comment[]): string[] {
  return existing
    .filter((c) => c.author === 'agent' && c.source?.actionId === REVIEW_ACTION_ID
      && isProposal(c) && !touched(c))
    .map((c) => c.id)
}

export function mintHotspotComments(
  hotspots: Hotspot[],
  opts: { knownFiles: ReadonlySet<string>; iteration: number }
): Comment[] {
  const comments: Comment[] = []
  hotspots.forEach((h, i) => {
    const file = h.anchor.kind === 'file' || h.anchor.kind === 'diff' ? h.anchor.file : undefined
    if (file === undefined || !opts.knownFiles.has(file)) {
      console.warn(`[hotspots] dropped — anchor file ${file ?? '(none)'} not in the diff`)
      return
    }
    comments.push({
      id: `hs-${Date.now()}-${i}`,
      anchor: h.anchor,
      author: 'agent',
      text: h.text,
      severity: h.severity,
      status: 'proposed', // INVARIANT: never queued — see file header
      source: { actionId: REVIEW_ACTION_ID, runId: `review-${opts.iteration}` },
      replies: [],
      createdAt: new Date().toISOString(),
      iteration: opts.iteration
    })
  })
  return comments
}
