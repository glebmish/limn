import { useStore } from '../store'
import type { Comment, CommentAnchor } from '../../shared/types'

export async function addComment(anchor: CommentAnchor, text: string): Promise<string | null> {
  const sessionId = await useStore.getState().materialize()  // first comment mints the session
  if (sessionId == null) return null
  const loaded = useStore.getState().loaded
  const comment: Comment = {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    anchor,
    author: 'user',
    text,
    status: 'queued',
    replies: [],
    createdAt: new Date().toISOString(),
    iteration: loaded?.state.iterations.length ?? 0
  }
  const state = await window.api.upsertComment(sessionId, comment)
  useStore.getState().setComments(state.comments)
  return comment.id
}

export async function editComment(comment: Comment, text: string): Promise<void> {
  const sessionId = await useStore.getState().materialize()
  if (sessionId == null) return
  const state = await window.api.upsertComment(sessionId, { ...comment, text })
  useStore.getState().setComments(state.comments)
}

export async function deleteComment(id: string): Promise<void> {
  const sessionId = await useStore.getState().materialize()
  if (sessionId == null) return
  const state = await window.api.deleteComment(sessionId, id)
  useStore.getState().setComments(state.comments)
}

/** The current review session = the LATEST review thread (each generation makes a
 *  new one; older review threads stay as history). */
export function currentReviewChat(chats: { kind: string; id: number }[]): { id: number } | undefined {
  return [...chats].reverse().find((c) => c.kind === 'review') ?? chats[0]
}

/** Send queued comments to the review agent's chat as one unified batch turn. The
 *  agent edits & commits code, resolves, or replies via its tools; the chat drawer
 *  opens to show the rollup + commit chip (wf-H). */
export function sendComments(ids: string[], steer?: string): void {
  const { loaded } = useStore.getState()
  const target = currentReviewChat(loaded?.state.chats ?? [])
  if (!target) return
  useStore.getState().sendBatch(target.id, ids, steer)
}

/** Answer(s) to the agent's open intent questions: a read-only refine turn on the
 *  review agent that folds the decision into the narration — no code edits, no gate. */
export function sendAnswers(ids: string[]): void {
  const { loaded } = useStore.getState()
  const target = currentReviewChat(loaded?.state.chats ?? [])
  if (!target) return
  useStore.getState().sendBatch(target.id, ids, undefined, true)
}

export function queuedComments(): Comment[] {
  return (useStore.getState().loaded?.state.comments ?? []).filter((c) => c.status === 'queued')
}
