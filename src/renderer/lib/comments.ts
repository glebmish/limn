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
 *  review agent that folds the decision into the narration — no code edits, no gate. */
export function sendAnswers(ids: string[]): void {
  const { loaded } = useStore.getState()
  const target = currentReviewChat(loaded?.state.chats ?? [], loaded?.state.latestIteration?.sessionId)
  if (!target) return
  useStore.getState().sendBatch(target.id, ids, undefined, true)
}

export function queuedComments(): Comment[] {
  return (useStore.getState().loaded?.state.comments ?? []).filter((c) => c.status === 'queued')
}
