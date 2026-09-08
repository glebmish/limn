import { useStore } from '../store'
import type { Comment } from '../../shared/types'

/** The current review session = the LATEST review thread (each generation makes a
 *  new one; older review threads stay as history). */
export function currentReviewChat(chats: { kind: string; id: number; engineSessionId?: string }[], engineSessionId?: string): { id: number } | undefined {
  return (engineSessionId ? chats.find((c) => c.kind === 'review' && c.engineSessionId === engineSessionId) : undefined)
    ?? [...chats].reverse().find((c) => c.kind === 'review')
    ?? chats[0]
}

/** Send queued comments to the *active* chat's agent as one unified batch turn. The
 *  agent edits & commits code, resolves, or replies via its tools; the chat drawer
 *  opens to show the rollup + commit chip (wf-H). The destination follows whichever
 *  chat is active (matching the drawer's "Send N → agent" CTA), not the review agent. */
export function sendComments(ids: string[], steer?: string): void {
  useStore.getState().sendQueuedComments(ids, steer)
}

/** Answer(s) to the agent's open intent questions: a read-only refine turn on the
 *  review agent that folds the decision into the narration — no code edits, no gate.
 *  Returns the thread the answers went to, so the card that sent them can link to
 *  that exact thread rather than re-deriving one. */
export function sendAnswers(ids: string[]): number | undefined {
  const { loaded } = useStore.getState()
  const target = currentReviewChat(loaded?.state.chats ?? [], loaded?.state.latestIteration?.sessionId)
  if (!target) return undefined
  useStore.getState().sendBatch(target.id, ids, undefined, true)
  return target.id
}

export function queuedComments(): Comment[] {
  return (useStore.getState().loaded?.state.comments ?? []).filter((c) => c.status === 'queued')
}

// ── proposals (design board 14 v3) ────────────────────────────
// A proposal is an agent finding the reviewer has not taken yet. It is kept apart
// from the reviewer's own comments everywhere a count shows, so these helpers are
// the one place the split is computed.

/** The reviewer's own comments: everything that is not a proposal (accepted and kept
 *  findings included — they are the reviewer's now). */
export function ownedComments(comments: readonly Comment[]): Comment[] {
  return comments.filter((c) => c.status !== 'proposed' && c.status !== 'dismissed')
}

/** Proposals still shown (not dismissed). */
export function openProposals(comments: readonly Comment[]): Comment[] {
  return comments.filter((c) => c.status === 'proposed')
}

/** The two headline counts: `N comments · M proposed`. */
export function commentCounts(comments: readonly Comment[]): { comments: number; proposed: number } {
  return { comments: ownedComments(comments).length, proposed: openProposals(comments).length }
}

/** A section's own / proposed counts: comments anchored on a line or file of one of
 *  its files. */
export function sectionCommentCounts(files: readonly string[], comments: readonly Comment[]): { owned: number; proposed: number } {
  const inSection = comments.filter((c) => (c.anchor.kind === 'diff' || c.anchor.kind === 'file') && files.includes(c.anchor.file))
  return { owned: ownedComments(inSection).length, proposed: openProposals(inSection).length }
}

/** Proposals grouped by the run that minted them, newest run first (runs are
 *  ordered by their first comment's creation time). */
export function proposalsByRun(comments: readonly Comment[]): { runId: string; actionId: string; open: Comment[]; dismissed: Comment[] }[] {
  const groups = new Map<string, { runId: string; actionId: string; open: Comment[]; dismissed: Comment[]; at: string }>()
  for (const c of comments) {
    if (!c.source || (c.status !== 'proposed' && c.status !== 'dismissed')) continue
    let g = groups.get(c.source.runId)
    if (!g) { g = { runId: c.source.runId, actionId: c.source.actionId, open: [], dismissed: [], at: c.createdAt }; groups.set(c.source.runId, g) }
    if (c.status === 'proposed') g.open.push(c); else g.dismissed.push(c)
    if (c.createdAt < g.at) g.at = c.createdAt
  }
  return [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(({ at: _at, ...g }) => g)
}
