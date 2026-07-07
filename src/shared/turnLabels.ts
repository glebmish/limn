import type { AgentQuestion, Comment } from './types.js'

/** Turn labels persisted by main AND shown optimistically by the renderer.
 *  One definition per label: the optimistic bubble and the stored message are
 *  the same function by construction, so they can never drift apart (they used
 *  to be verbatim main/renderer copies — batchUserMessage/batchUserPreview). */

/** The user-turn label for a unified batch turn (the full prompt is engine-only). */
export function batchTurnLabel(comments: Comment[], questions: AgentQuestion[], refine?: boolean, steer?: string): string {
  if (refine) {
    const byId = new Map(questions.map((q) => [q.id, q]))
    const lines = comments.map((c) => {
      const qid = c.anchor.kind === 'question' ? c.anchor.questionId : ''
      const q = byId.get(qid)
      const label = q?.text ?? q?.context ?? (qid || 'Open question')
      return `- ${label}\n  Answer: ${c.text}`
    })
    return `Answered ${comments.length} open question${comments.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
  }
  return steer?.trim() ? `Handle ${comments.length} comment(s) - ${steer.trim()}` : `Handle ${comments.length} comment(s).`
}

/** The user-turn label for an agent rebase/resolve turn (spec §6). */
export function rebaseTurnLabel(base: string, branch: string, conflictFiles?: string[]): string {
  return conflictFiles?.length
    ? `Rebase ${branch} onto ${base} — resolve ${conflictFiles.length} conflicted file${conflictFiles.length === 1 ? '' : 's'}.`
    : `Rebase ${branch} onto ${base}.`
}
