import type { ChatThread, Comment } from '../../shared/types'
import { proposalsByRun } from './comments'
import { runsOf } from './runs'

// The stepper strip above the diff (design board 14 T1, v3) follows the newest run
// that still has proposals to triage — open ones to step through, or dismissed ones
// to restore.

export interface StripView {
  runId: string
  actionId: string
  threadId: number | null
  /** "Simplify" — the action's name (or the thread's) */
  name: string
  kind: 'skill' | 'prompt' | null
  /** the run's ordinal in its thread, when known */
  n: number | null
  open: Comment[]
  dismissed: Comment[]
}

export function stripView(comments: readonly Comment[], chats: readonly ChatThread[]): StripView | null {
  const g = proposalsByRun(comments).find((r) => r.open.length > 0 || r.dismissed.length > 0)
  if (!g) return null
  const threadId = (g.open[0] ?? g.dismissed[0]).source?.threadId ?? null
  const thread = threadId != null ? chats.find((c) => c.id === threadId) ?? null : null
  const run = thread ? runsOf(thread).find((r) => r.run.runId === g.runId) ?? null : null
  const review = g.actionId === 'review'
  return {
    runId: g.runId,
    actionId: g.actionId,
    threadId,
    name: run?.run.name ?? thread?.action?.name ?? thread?.title ?? (review ? 'Review' : 'Run'),
    kind: run?.run.kind ?? thread?.action?.kind ?? null,
    n: run?.run.n ?? null,
    open: g.open,
    dismissed: g.dismissed
  }
}

/** Clamp a stepper index into the open list (the list shrinks as proposals are
 *  triaged): -1 when empty. */
export function clampStep(idx: number, count: number): number {
  if (count === 0) return -1
  return Math.min(Math.max(idx, 0), count - 1)
}

/** After a jump lands, put keyboard focus on the proposal's box so a / k / d / r work
 *  from there. The jump reveals and scrolls the row over a few frames, so poll briefly. */
export function focusProposalBox(commentId: string, tries = 90): void {
  if (typeof document === 'undefined') return
  const tick = (left: number): void => {
    const box = document.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(commentId)}"] .box.proposed`)
    if (box) { box.focus({ preventScroll: true }); return }
    if (left > 0) requestAnimationFrame(() => tick(left - 1))
  }
  tick(tries)
}

/** The triage verdict a key stands for on a focused proposal, or null. */
export function triageKey(key: string): 'accept' | 'keep' | 'dismiss' | 'reply' | null {
  switch (key) {
    case 'a': return 'accept'
    case 'k': return 'keep'
    case 'd': return 'dismiss'
    case 'r': return 'reply'
    default: return null
  }
}
