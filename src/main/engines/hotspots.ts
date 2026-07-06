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
