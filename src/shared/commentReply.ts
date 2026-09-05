import type { Comment, CommentReply } from './types.js'

/** The reviewer continues a thread: their reply goes on the end and the comment goes
 *  back into the queue, so the agent's next batch gets the whole thread (the prompt
 *  serialises `replies` under the comment). A resolved thread's verdict + note are
 *  folded into the replies first, as the agent's turn, so a second resolution does
 *  not overwrite the first and the thread reads in order: comment, resolution,
 *  reply, resolution… — the way a GitHub review thread does. */
export function withUserReply(c: Comment, text: string, at: string): Comment {
  const replies: CommentReply[] = [...c.replies]
  if (c.status === 'resolved' && c.resolution) {
    replies.push({ author: 'agent', text: c.resolution.note, at, agentRef: c.resolution.agentRef, threadId: c.threadId, verdict: c.resolution.verdict })
  }
  replies.push({ author: 'user', text, at })
  const { resolution: _dropped, ...rest } = c
  return { ...rest, replies, status: 'queued' }
}
