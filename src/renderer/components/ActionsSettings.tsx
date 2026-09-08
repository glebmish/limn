import { useEffect, useState } from 'react'
import type { ActionDef, EngineId } from '../../shared/types'
import type { CommandAvailability } from '../../shared/actions'
import { bareSkillName, newActionId, skillPrompt } from '../../shared/actions'
import { engineLabel } from '../../shared/agents'
import { EngineGlyph, I } from '../kit'
import { useStore } from '../store'
import { actionDraftProblem, actionSub, markFor, markTitle, markedEngines, moveAction, seenChoices } from '../lib/actions'
import { ActionMarks, EngineMark, KindGlyph, checkedAgo } from './ActionMarks'

type Draft = { id: string | null; kind: ActionDef['kind']; name: string; body: string }

const EMPTY_DRAFT: Draft = { id: null, kind: 'skill', name: '', body: '' }

/** Settings › Actions (design board 14 S1): the pinned list (drag to reorder — that
 *  order is the launcher's), each row's kind, sub-label and engine marks, the probe
 *  line with Refresh, and the two-shape editor (a skill name with the names Limn
 *  has SEEN on any engine, or a prompt text area). Edits persist as they land;
 *  there is nothing to Save. `repo` is the review's repo when Settings opens from a
 *  review — availability is per repo, so without one the marks are hidden. */
export function ActionsSettings({ repo }: { repo: string | null }) {
  const actions = useStore((s) => s.actions)
  const setActions = useStore((s) => s.setActions)
  const avail = useStore((s) => (repo ? s.commands[repo] : undefined) ?? [])
  const seen = useStore((s) => s.seenCommands)
  const loadCommands = useStore((s) => s.loadCommands)
  const refreshCommands = useStore((s) => s.refreshCommands)
  const loadSeenCommands = useStore((s) => s.loadSeenCommands)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  useEffect(() => {
    void loadSeenCommands()
    if (repo) void loadCommands(repo)
  }, [repo, loadCommands, loadSeenCommands])

  const engines = markedEngines(avail)
  const checking = avail.some((a) => a.state === 'checking')

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
          <div className="ax-empty">No actions yet — pin a skill the agent already has, or a prompt in your own words.</div>
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
                      <button title="Edit" aria-label={`Edit ${a.name}`} onClick={() => setDraft({ id: a.id, kind: a.kind, name: a.name, body: a.body })}><I.edit /></button>
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
              <button role="radio" aria-checked={draft.kind === 'skill'} className={draft.kind === 'skill' ? 'on' : undefined} onClick={() => setDraft({ ...draft, kind: 'skill' })}>Skill</button>
              <button role="radio" aria-checked={draft.kind === 'prompt'} className={draft.kind === 'prompt' ? 'on' : undefined} onClick={() => setDraft({ ...draft, kind: 'prompt' })}>Prompt</button>
            </div>
            {draft.kind === 'skill' ? (
              <div className="settings-field">
                <label htmlFor="ax-skill">Skill</label>
                <input id="ax-skill" type="text" value={draft.body} spellCheck={false} placeholder="simplify · pr-review-toolkit:review-pr" autoFocus
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
                <SeenList seen={seen} typed={draft.body} pinned={actions} onPick={(name) => setDraft({ ...draft, body: name, name: draft.name || titleCase(name) })} />
                <SkillStatus name={draft.body} avail={avail} />
              </div>
            ) : (
              <div className="settings-field">
                <label htmlFor="ax-prompt">Prompt</label>
                <textarea id="ax-prompt" rows={3} value={draft.body} placeholder="Rebase this branch onto main and resolve conflicts…" autoFocus
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </div>
            )}
            <div className="settings-field">
              <label htmlFor="ax-name">Name</label>
              <input id="ax-name" type="text" className="sans" value={draft.name} placeholder={draft.kind === 'skill' ? 'Simplify' : 'Rebase onto main'}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
            </div>
            <div className="ax-editor-foot">
              <span className="settings-note">{problem ?? (draft.kind === 'skill' ? 'A name Limn has not seen yet saves fine — Refresh after installing it' : 'Sent verbatim, plus the add_finding note')}</span>
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

function titleCase(name: string): string {
  const last = name.split(':').pop() ?? name
  return last.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** The names Limn has seen on any engine, grouped, filtered by what is typed. */
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
    <div className="ax-seen" role="listbox" aria-label="Skills seen on your engines">
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
 *  list uses, so the editor and the rows never disagree. */
function SkillStatus({ name, avail }: { name: string; avail: readonly CommandAvailability[] }) {
  const bare = bareSkillName(name)
  if (!bare || avail.length === 0) return null
  const probe: ActionDef = { id: 'draft', kind: 'skill', name: bare, body: bare }
  return (
    <div className="settings-status ax-skill-status">
      {avail.map((a, i) => {
        const mark = markFor(probe, a)
        const text = mark === 'ok' ? `${engineLabel(a.engine)} has it` : mark === 'chk' ? `checking ${engineLabel(a.engine)}…` : mark === 'no' ? `${engineLabel(a.engine)} did not report ${skillPrompt(a.engine, bare)}` : mark === 'bad' ? `${engineLabel(a.engine)} unreachable` : `${engineLabel(a.engine)} not checked`
        return (
          <span key={a.engine}>
            {i > 0 && ' · '}
            <EngineMark engine={a.engine} mark={mark} title={markTitle(probe, a.engine, a, mark)} />{text}
          </span>
        )
      })}
    </div>
  )
}
