import type { Comment, Hotspot } from '../../shared/types.js'

/** Mint anchored agent comments from a full generation's `hotspots` (A4). Mirrors
 *  `add_comment`'s Comment shape (tools.ts) — `status:'resolved'` is an INVARIANT:
 *  hotspot comments are agent-authored and must never enter the user's queued
 *  batch on their own; the only path in is the reviewer's explicit re-queue click
 *  (Threads.tsx). A hotspot whose anchor file isn't in the diff is dropped (with a
 *  console warning) rather than producing a comment that resolves nowhere — same
 *  spirit as `mergeAnnotations`' unknown-file section/anchor gates. Anchors arrive
 *  already normalized (`hotspotsFromWire`); creation-time stamping happens at the
 *  ipc seam (`stampAnchor`), not here, mirroring `add_comment`. */
/** Prior-generation hotspot comments a fresh full pass supersedes: agent-minted
 *  (`hs-` id), still `resolved`, and never engaged (no replies, never re-queued).
 *  Anything the reviewer touched survives regeneration — deleting an engaged
 *  comment would drop reviewer work, so engagement pins it. */
export function supersededHotspotIds(existing: readonly Comment[]): string[] {
  return existing
    .filter((c) => c.id.startsWith('hs-') && c.author === 'agent'
      && c.status === 'resolved' && c.replies.length === 0)
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
      status: 'resolved', // INVARIANT: never queued — see file header
      replies: [],
      createdAt: new Date().toISOString(),
      iteration: opts.iteration
    })
  })
  return comments
}
