import type { ActionDef, EngineId } from '../../shared/types'
import type { CommandAvailability } from '../../shared/actions'
import { bareSkillName, hasSkill, skillPrompt } from '../../shared/actions'
import { engineLabel } from '../../shared/agents'

// Pure helpers behind the actions surfaces (design board 14): the launcher rows, the
// Settings list/editor and the run bar all derive from these, so the marks and the
// runnable/blocked decision cannot disagree between surfaces.

/** What a mark says for one action on one engine. `ok` reported it, `no` did not
 *  (an empty list included), `chk` a probe is in flight, `unk` never probed, `bad`
 *  the probe could not reach the engine. A prompt action is always `ok`. */
export type Mark = 'ok' | 'no' | 'chk' | 'unk' | 'bad'

export function markFor(action: ActionDef, avail: CommandAvailability | undefined): Mark {
  if (action.kind === 'prompt') return 'ok'
  if (!avail || avail.state === 'unknown') return 'unk'
  if (avail.state === 'checking') return 'chk'
  if (avail.state === 'failed') return 'bad'
  return hasSkill(avail, action.body) ? 'ok' : 'no'
}

/** The hover copy for a mark: what the engine said and when. */
export function markTitle(action: ActionDef, engine: EngineId, avail: CommandAvailability | undefined, mark: Mark): string {
  const name = skillPrompt(engine, action.body)
  const label = engineLabel(engine)
  switch (mark) {
    case 'ok': return action.kind === 'prompt' ? `${label} can run it` : `${label} has ${name} · checked ${when(avail?.checkedAt)}`
    case 'no': return `${label} did not report ${name} · checked ${when(avail?.checkedAt)}`
    case 'chk': return `Checking ${label}…`
    case 'bad': return `${label} could not be reached${avail?.error ? ` — ${avail.error}` : ''}`
    case 'unk': return `${label} not checked yet`
  }
}

function when(iso: string | undefined): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (Number.isNaN(s)) return 'never'
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

/** The engines whose marks are worth showing: those the server reports at all (it
 *  lists only spawnable ones). With one engine the column carries no information. */
export function markedEngines(avail: readonly CommandAvailability[]): EngineId[] {
  const engines = avail.map((a) => a.engine)
  return engines.length >= 2 ? engines : []
}

/** Move an action from index `from` to index `to` (drag reorder). Out-of-range or
 *  same-index moves return the list unchanged. */
export function moveAction(list: readonly ActionDef[], from: number, to: number): ActionDef[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list]
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/** The one-line sub-label a row shows under the name: the engine-neutral skill
 *  spelling (`/name` — the launcher re-spells it per engine at run time), or the
 *  prompt's first line, ellipsized. */
export function actionSub(action: ActionDef, max = 72): string {
  if (action.kind === 'skill') return `/${bareSkillName(action.body)}`
  const line = action.body.split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Editor validation: a skill needs a name-shaped body, a prompt needs text; both
 *  need a display name. Returns the reason the Add button is disabled, or null. */
export function actionDraftProblem(draft: { kind: ActionDef['kind']; name: string; body: string }): string | null {
  if (draft.kind === 'skill') {
    const bare = bareSkillName(draft.body)
    if (!bare) return 'Type the skill name'
    if (/\s/.test(bare)) return 'A skill name has no spaces'
  } else if (!draft.body.trim()) return 'Type the prompt'
  if (!draft.name.trim()) return 'Give it a name'
  return null
}

/** The "seen on <engine>" list for the editor: names matching the typed prefix
 *  (or all when empty), each flagged when it is already pinned. */
export function seenChoices(
  seen: readonly { engine: EngineId; names: string[] }[], typed: string, pinned: readonly ActionDef[]
): { engine: EngineId; names: { name: string; pinned: boolean }[] }[] {
  const q = bareSkillName(typed).toLowerCase()
  const pinnedNames = new Set(pinned.filter((a) => a.kind === 'skill').map((a) => bareSkillName(a.body)))
  return seen.map((s) => ({
    engine: s.engine,
    names: s.names.filter((n) => !q || n.toLowerCase().includes(q)).map((name) => ({ name, pinned: pinnedNames.has(name) }))
  })).filter((s) => s.names.length > 0)
}
