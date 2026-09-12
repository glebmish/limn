import { useEffect, useRef, useState } from 'react'
import type { ActionDef, EngineId } from '../../shared/types'
import type { CommandAvailability } from '../../shared/actions'
import { bareSkillName, newActionId, skillPrompt } from '../../shared/actions'
import { engineLabel } from '../../shared/agents'
import { EngineGlyph, I } from '../kit'
import { useStore } from '../store'
import { actionDraftProblem, actionSub, defaultActionName, markFor, markTitle, markedEngines, moveAction, seenChoices, uncheckedEngines } from '../lib/actions'
import { ActionMarks, EngineMark, KindGlyph, checkedAgo } from './ActionMarks'

/** `nameAuto`: the Name field still follows the skill (`defaultActionName`) — it
 *  flips off the moment the reviewer types a name, and back on when they clear it. */
type Draft = { id: string | null; kind: ActionDef['kind']; name: string; body: string; nameAuto: boolean }

const EMPTY_DRAFT: Draft = { id: null, kind: 'skill', name: '', body: '', nameAuto: true }

/** A body edit, keeping the auto-name in step while it is still automatic. */
function withBody(draft: Draft, body: string): Draft {
  return { ...draft, body, name: draft.nameAuto ? defaultActionName(draft.kind, body) : draft.name }
}

/** Settings › Actions (design board 14 S1): the pinned list (drag to reorder — that
 *  order is the launcher's), each row's kind, sub-label and engine marks, the probe
 *  line with Refresh, and the two-shape editor (a skill name with the names Limn
 *  has SEEN on any engine as completions, or a prompt text area). Opening the skill
 *  editor probes any engine never checked for this repo, so the marks under the
 *  field answer without the reviewer finding Refresh. Edits persist as they land;
 *  there is nothing to Save. `repo` is the review's repo when Settings opens from a
 *  review — availability is per repo, so without one the marks are hidden. */
export function ActionsSettings({ repo }: { repo: string | null }) {
  const actions = useStore((s) => s.actions)
  const setActions = useStore((s) => s.setActions)
  const avail = useStore((s) => (repo ? s.commands[repo] : undefined) ?? NO_AVAIL)
  const seen = useStore((s) => s.seenCommands)
  const loadCommands = useStore((s) => s.loadCommands)
  const refreshCommands = useStore((s) => s.refreshCommands)
  const loadSeenCommands = useStore((s) => s.loadSeenCommands)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [skillFocus, setSkillFocus] = useState(false)

  useEffect(() => {
    void loadSeenCommands()
    if (repo) void loadCommands(repo)
  }, [repo, loadCommands, loadSeenCommands])

  const engines = markedEngines(avail)
  const checking = avail.some((a) => a.state === 'checking')

  // Auto-check once per skill-editor opening: the never-probed engines for this
  // repo. `refreshCommands` flips them to `checking` at once, so the effect cannot
  // re-fire on its own re-render; the ref keeps a failed probe from looping.
  const autoChecked = useRef(false)
  const skillEditing = draft?.kind === 'skill'
  useEffect(() => {
    if (!skillEditing) { autoChecked.current = false; return }
    if (autoChecked.current || !repo) return
    const targets = uncheckedEngines(avail)
    if (targets.length === 0) return
    autoChecked.current = true
    void refreshCommands(repo, targets)
  }, [skillEditing, repo, avail, refreshCommands])

  const save = (): void => {
    if (!draft || actionDraftProblem(draft)) return
    const next: ActionDef = {
      id: draft.id ?? newActionId(),
      kind: draft.kind,
      name: draft.name.trim(),
      body: draft.kind === 'skill' ? bareSkillName(draft.body) : draft.body.trim()
    }
    void setActions(draft.id ? actions.map((a) => (a.id === draft.id ? next : a)) : [...actions, next])
    setDraft(null)
  }

  const problem = draft ? actionDraftProblem(draft) : null

  return (
    <>
      <div className="settings-field">
        <label>Pinned actions</label>
        {actions.length === 0 ? (
          <div className="ax-empty">No actions yet.</div>
        ) : (
          <div className="ax-slist" role="list">
            {actions.map((a, i) => (
              <div
                key={a.id}
                role="listitem"
                className={'ax-srow' + (dragFrom === i ? ' dragging' : '')}
                draggable
                onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move' }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                onDrop={(e) => { e.preventDefault(); if (dragFrom != null) void setActions(moveAction(actions, dragFrom, i)); setDragFrom(null) }}
                onDragEnd={() => setDragFrom(null)}
              >
                <span className="grip" title="Drag to reorder — this is the launcher's order" aria-hidden>⋮⋮</span>
                <KindGlyph kind={a.kind} />
                <span className="ax-rn"><b>{a.name}</b><i>{actionSub(a)}</i></span>
                {a.kind === 'skill' && <span className="ax-avail"><ActionMarks action={a} engines={engines} avail={avail} /></span>}
                <span className="ax-acts">
                  {confirmDel === a.id ? (
                    <>
                      <button className="del-confirm" onClick={() => { void setActions(actions.filter((x) => x.id !== a.id)); setConfirmDel(null) }}>Delete</button>
                      <button onClick={() => setConfirmDel(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      <button title="Edit" aria-label={`Edit ${a.name}`} onClick={() => setDraft({ id: a.id, kind: a.kind, name: a.name, body: a.body, nameAuto: false })}><I.edit /></button>
                      <button title="Delete" aria-label={`Delete ${a.name}`} onClick={() => setConfirmDel(a.id)}><I.trash /></button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {repo && avail.length > 0 && (
          <div className="ax-probe">
            <span>Availability from each engine's last session in <span className="mono">{repo.split('/').pop()}</span> ·</span>
            {avail.map((a) => (
              <span key={a.engine}>
                <EngineMark engine={a.engine} mark={a.state === 'checking' ? 'chk' : a.state === 'failed' ? 'bad' : a.state === 'unknown' ? 'unk' : 'ok'} title={`${engineLabel(a.engine)} · ${checkedAgo(a)}`} />
                {checkedAgo(a)}
              </span>
            ))}
            <button className={checking ? 'spin' : undefined} disabled={checking} onClick={() => void refreshCommands(repo)}>
              <I.refresh />{checking ? 'Checking…' : 'Refresh'}
            </button>
          </div>
        )}
        {!draft && (
          <div>
            <button className="btn btn-sm btn-primary" onClick={() => setDraft(EMPTY_DRAFT)}><I.plus style={{ width: 12, height: 12 }} />New action</button>
          </div>
        )}
      </div>

      {draft && (
        <div className="settings-field">
          <label>{draft.id ? 'Edit action' : 'New action'}</label>
          <div className="ax-editor">
            <div className="seg" role="radiogroup" aria-label="Action kind">
              <button role="radio" aria-checked={draft.kind === 'skill'} className={draft.kind === 'skill' ? 'on' : undefined} onClick={() => setDraft(withBody({ ...draft, kind: 'skill' }, draft.body))}>Skill</button>
              <button role="radio" aria-checked={draft.kind === 'prompt'} className={draft.kind === 'prompt' ? 'on' : undefined} onClick={() => setDraft(withBody({ ...draft, kind: 'prompt' }, draft.body))}>Prompt</button>
            </div>
            {draft.kind === 'skill' ? (
              <div className="settings-field">
                <label htmlFor="ax-skill">Skill</label>
                <input id="ax-skill" type="text" value={draft.body} spellCheck={false} placeholder="simplify · pr-review-toolkit:review-pr" autoFocus
                  autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={skillFocus} aria-controls="ax-seen"
                  onFocus={() => setSkillFocus(true)} onBlur={() => setSkillFocus(false)}
                  onChange={(e) => setDraft(withBody(draft, e.target.value))}
                  onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
                {skillFocus && <SeenList seen={seen} typed={draft.body} pinned={actions} onPick={(name) => setDraft(withBody(draft, name))} />}
                <SkillStatus name={draft.body} avail={avail} onCheck={repo && !checking ? () => void refreshCommands(repo) : null} />
              </div>
            ) : (
              <div className="settings-field">
                <label htmlFor="ax-prompt">Prompt</label>
                <textarea id="ax-prompt" rows={3} value={draft.body} placeholder="Rebase this branch onto main and resolve conflicts…" autoFocus
                  onChange={(e) => setDraft(withBody(draft, e.target.value))} />
              </div>
            )}
            <div className="settings-field">
              <label htmlFor="ax-name">Name</label>
              <input id="ax-name" type="text" className="sans" value={draft.name} placeholder={draft.kind === 'skill' ? 'Simplify' : 'Rebase onto main'}
                onChange={(e) => setDraft(e.target.value === '' ? withBody({ ...draft, nameAuto: true }, draft.body) : { ...draft, name: e.target.value, nameAuto: false })}
                onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
            </div>
            <div className="ax-editor-foot">
              <span className="settings-note">{problem ?? (draft.kind === 'prompt' ? 'Sent verbatim, plus the add_finding note' : '')}</span>
              <span className="grow" />
              <button className="btn btn-sm btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn btn-sm btn-primary" disabled={Boolean(problem)} onClick={save}>{draft.id ? 'Save' : 'Add action'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** The completions under the skill field while it has focus: the names Limn has
 *  seen on any engine, grouped, filtered by what is typed. */
function SeenList({ seen, typed, pinned, onPick }: {
  seen: readonly { engine: EngineId; names: string[] }[]
  typed: string
  pinned: readonly ActionDef[]
  onPick: (name: string) => void
}) {
  const groups = seenChoices(seen, typed, pinned)
  if (groups.length === 0) return null
  const current = bareSkillName(typed)
  return (
    <div id="ax-seen" className="ax-seen" role="listbox" aria-label="Skills seen on your engines">
      {groups.map((g) => (
        <div key={g.engine}>
          <div className="g"><EngineGlyph engine={g.engine} style={{ width: 13, height: 13, color: 'var(--accent)' }} />seen on {engineLabel(g.engine)}</div>
          {g.names.slice(0, 12).map((n) => (
            <div key={n.name} role="option" aria-selected={n.name === current} className={'o' + (n.name === current ? ' on' : '')} onMouseDown={(e) => { e.preventDefault(); onPick(n.name) }}>
              {n.name}{n.pinned && <span className="d">already pinned</span>}
            </div>
          ))}
          {g.names.length > 12 && <div className="o d">{g.names.length - 12} more — keep typing</div>}
        </div>
      ))}
    </div>
  )
}

/** "Claude has it · checking Codex…" under the skill field, from the same marks the
 *  list uses, so the editor and the rows never disagree. An engine never checked or
 *  unreachable gets a Check button right here — the probe line's Refresh is the same
 *  probe, but nothing about "Refresh" says "check this skill". */
function SkillStatus({ name, avail, onCheck }: { name: string; avail: readonly CommandAvailability[]; onCheck: (() => void) | null }) {
  const bare = bareSkillName(name)
  if (!bare || avail.length === 0) return null
  const probe: ActionDef = { id: 'draft', kind: 'skill', name: bare, body: bare }
  const marks = avail.map((a) => markFor(probe, a))
  const askable = marks.some((m) => m === 'unk' || m === 'bad')
  return (
    <div className="settings-status ax-skill-status">
      {avail.map((a, i) => {
        const mark = marks[i]
        const text = mark === 'ok' ? `${engineLabel(a.engine)} has it` : mark === 'chk' ? `checking ${engineLabel(a.engine)}…` : mark === 'no' ? `${engineLabel(a.engine)} did not report ${skillPrompt(a.engine, bare)}` : mark === 'bad' ? `${engineLabel(a.engine)} unreachable` : `${engineLabel(a.engine)} not checked`
        return (
          <span key={a.engine}>
            {i > 0 && ' · '}
            <EngineMark engine={a.engine} mark={mark} title={markTitle(probe, a.engine, a, mark)} />{text}
          </span>
        )
      })}
      {askable && onCheck && <button type="button" className="ax-check" onClick={onCheck}>{marks.some((m) => m === 'bad') ? 'Try again' : 'Check'}</button>}
    </div>
  )
}

/** stable empty list — a selector must not mint a new array per render */
const NO_AVAIL: CommandAvailability[] = []
