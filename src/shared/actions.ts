import type { ActionDef, Comment, EngineId } from './types.js'

/** Prefs key holding the reviewer's pinned actions (global — design board 14 S1). */
export const ACTIONS_PREF_KEY = 'actions'

/** `source.actionId` of the proposals a review generation mints (its hotspots). */
export const REVIEW_ACTION_ID = 'review'

/** The one paragraph Limn appends to every action prompt, skill or free text. It
 *  names the tool and nothing else — it never restricts edits (the thread's execution
 *  mode does that) and never asks for a follow-up turn. */
export const FINDING_HARNESS =
  'Limn: for each finding you report, also call the `add_finding` tool (file, line, severity, body) ' +
  'so it lands on the code as a proposed comment the reviewer can accept or dismiss. ' +
  'Anchor each one to the exact line in the repository file; use severity "risk" for bugs and ' +
  'security problems, "note" for everything else.'

function isActionDef(v: unknown): v is ActionDef {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && o.id.length > 0
    && (o.kind === 'skill' || o.kind === 'prompt')
    && typeof o.name === 'string' && typeof o.body === 'string'
}

/** Parse the stored list. Never throws: garbage yields `[]`, a malformed entry is
 *  dropped, and only the four known fields survive (a stale extra field can't ride
 *  along into the next save). */
export function parseActions(json: string | undefined): ActionDef[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.filter(isActionDef).map(({ id, kind, name, body }) => ({ id, kind, name, body }))
}

export function serializeActions(actions: ActionDef[]): string {
  return JSON.stringify(actions.map(({ id, kind, name, body }) => ({ id, kind, name, body })))
}

let seq = 0
export function newActionId(): string {
  return `act-${Date.now().toString(36)}-${(++seq).toString(36)}`
}

/** A skill name as stored: bare, no engine prefix. */
export function bareSkillName(name: string): string {
  return name.trim().replace(/^[/$]+/, '')
}

/** How the engine wants a skill invoked in prompt text: Claude Code slash commands,
 *  Codex `$skill` mentions (the probe confirmed both spellings, 2026-09-07). */
export function skillPrompt(engine: EngineId, name: string): string {
  return (engine === 'codex' ? '$' : '/') + bareSkillName(name)
}

/** The prompt an action run sends: the skill invocation or the verbatim text, then
 *  the finding harness. */
export function actionPrompt(action: ActionDef, engine: EngineId): string {
  const head = action.kind === 'skill' ? skillPrompt(engine, action.body) : action.body
  return `${head}\n\n${FINDING_HARNESS}`
}

/** A proposal = an agent finding the reviewer has not taken yet, whether still shown
 *  (`proposed`) or hidden (`dismissed`). */
export function isProposal(c: Comment): boolean {
  return c.status === 'proposed' || c.status === 'dismissed'
}

/** A proposal the reviewer engaged with (replied to). A re-run never sweeps it. */
export function touched(c: Comment): boolean {
  return c.replies.length > 0
}

export function runFindings(comments: readonly Comment[], runId: string): Comment[] {
  return comments.filter((c) => c.source?.runId === runId)
}
