import { newOpId, useStore } from '../store'
import type { Comment, CommentAnchor } from '../../shared/types'

export async function addComment(anchor: CommentAnchor, text: string): Promise<void> {
  const { sessionId, loaded, setComments } = useStore.getState()
  if (sessionId == null) return
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
  setComments(state.comments)
}

export async function editComment(comment: Comment, text: string): Promise<void> {
  const { sessionId } = useStore.getState()
  if (sessionId == null) return
  const state = await window.api.upsertComment(sessionId, { ...comment, text })
  useStore.getState().setComments(state.comments)
}

export async function deleteComment(id: string): Promise<void> {
  const { sessionId } = useStore.getState()
  if (sessionId == null) return
  const state = await window.api.deleteComment(sessionId, id)
  useStore.getState().setComments(state.comments)
}

export function sendComments(ids: string[], steer?: string): void {
  const { sessionId } = useStore.getState()
  if (sessionId == null) return
  const opId = newOpId()
  useStore.getState().startOp('fix', opId)
  void window.api.sendFeedback(sessionId, ids, steer, opId)
}

export function queuedComments(): Comment[] {
  return (useStore.getState().loaded?.state.comments ?? []).filter((c) => c.status === 'queued')
}
