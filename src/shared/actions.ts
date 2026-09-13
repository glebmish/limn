import type { ActionDef, Comment, EngineId } from './types.js'

/** Prefs key holding the reviewer's pinned actions (global — design board 14 S1). */
export const ACTIONS_PREF_KEY = 'actions'

/** One engine's command list for one repo, as the off-band probe last saw it (board
 *  14 N2). `unknown` = never probed; `checking` = a probe is in flight (in-memory
 *  only); `empty` = the engine answered with no skills; `failed` = it could not be
 *  reached (`error` says why). */
export type ProbeState = 'ok' | 'empty' | 'checking' | 'failed' | 'unknown'
export interface CommandAvailability {
  engine: EngineId
  repo: string
  /** the names exactly as the engine reported them */
  names: string[]
  /** ISO time of the probe that produced `names` ('' when never probed) */
  checkedAt: string
  state: ProbeState
  error?: string
}

/** The skill names in an engine's announcement, bare. Claude cannot tell a skill from
 *  a built-in, so every name counts; Codex marks skills with `$`. */
export function skillNames(engine: EngineId, names: readonly string[]): string[] {
  if (engine === 'codex') return names.filter((n) => n.startsWith('$')).map((n) => n.slice(1))
  return [...names]
}

/** True when the engine's last probe reported the skill. Anything but an `ok`/`empty`
 *  record answers no — a skill action is runnable only where its name appears. */
export function hasSkill(avail: CommandAvailability | undefined, name: string): boolean {
  if (!avail || (avail.state !== 'ok' && avail.state !== 'empty')) return false
  return skillNames(avail.engine, avail.names).includes(bareSkillName(name))
}

/** The follow-up turn "Attach findings" sends (board 14 N3): the run ended in prose
 *  and called nothing, so ask the agent to anchor what it already reported. */
export const ATTACH_FINDINGS_PROMPT =
  'Attach each finding from your report above with the `add_finding` tool — file, line, severity, ' +
  'a short body. Do not add new findings and do not edit files.'

/** `source.actionId` of the proposals a review generation mints (its hotspots). */
export const REVIEW_ACTION_ID = 'review'

/** Whether an action collects findings after its run: its own switch, else on for a
 *  skill (skills are how reviews are asked for) and off for a prompt. */
export function actionFindings(a: Pick<ActionDef, 'kind' | 'findings'>): boolean {
  return a.findings ?? a.kind === 'skill'
}

function isActionDef(v: unknown): v is ActionDef {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && o.id.length > 0
    && (o.kind === 'skill' || o.kind === 'prompt')
    && typeof o.name === 'string' && typeof o.body === 'string'
    && (o.findings === undefined || typeof o.findings === 'boolean')
}

/** Parse the stored list. Never throws: garbage yields `[]`, a malformed entry is
 *  dropped, and only the known fields survive (a stale extra field can't ride
 *  along into the next save). */
export function parseActions(json: string | undefined): ActionDef[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.filter(isActionDef).map(pickActionFields)
}

export function serializeActions(actions: ActionDef[]): string {
  return JSON.stringify(actions.map(pickActionFields))
}

function pickActionFields({ id, kind, name, body, findings }: ActionDef): ActionDef {
  return { id, kind, name, body, ...(findings === undefined ? {} : { findings }) }
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

/** The prompt an action run sends: the skill invocation or the verbatim text — and
 *  nothing else. The turn's framing (prompts.ts) is the engine's; findings, when the
 *  action collects them, come from a second structured pass after the run. */
export function actionPrompt(action: ActionDef, engine: EngineId): string {
  return action.kind === 'skill' ? skillPrompt(engine, action.body) : action.body
}

/** `source.actionId` of proposals a plain chat turn mints with `add_finding`. */
export const CHAT_ACTION_ID = 'chat'

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
