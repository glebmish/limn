import { newOpId, useStore } from '../store'
import type { Comment, CommentAnchor } from '../../shared/types'

function ctx(): { repo: string; branch: string; base: string } {
  const { repo, branch, base } = useStore.getState()
  if (!repo) throw new Error('no repo')
  return { repo, branch, base }
}

export async function addComment(anchor: CommentAnchor, text: string): Promise<void> {
  const { repo, branch, base } = ctx()
  const { loaded, setComments } = useStore.getState()
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
  const state = await window.api.upsertComment(repo, branch, base, comment)
  setComments(state.comments)
}

export async function editComment(comment: Comment, text: string): Promise<void> {
  const { repo, branch, base } = ctx()
  const state = await window.api.upsertComment(repo, branch, base, { ...comment, text })
  useStore.getState().setComments(state.comments)
}

export async function deleteComment(id: string): Promise<void> {
  const { repo, branch, base } = ctx()
  const state = await window.api.deleteComment(repo, branch, base, id)
  useStore.getState().setComments(state.comments)
}

export function sendComments(ids: string[], steer?: string): void {
  const { repo, branch, base } = ctx()
  const opId = newOpId()
  useStore.getState().startOp('fix', opId)
  void window.api.sendFeedback(repo, branch, base, ids, steer, opId)
}

export function queuedComments(): Comment[] {
  return (useStore.getState().loaded?.state.comments ?? []).filter((c) => c.status === 'queued')
}
