import { useEffect, useState } from 'react'
import type { ActionDef, AgentRef, ChatThread, EngineId } from '../../shared/types'
import type { CommandAvailability } from '../../shared/actions'
import { actionFindings, skillPrompt } from '../../shared/actions'
import { agentLabel, engineLabel, modelOption } from '../../shared/agents'
import { EngineGlyph, I } from '../kit'
import { usePopover } from '../lib/usePopover'
import { dev } from '../dev'
import { checkoutGate, opForThread, useStore } from '../store'
import { actionSub, markFor, markedEngines, type Mark } from '../lib/actions'
import { ActionMarks, EngineMark, KindGlyph, checkedAgo } from './ActionMarks'
import { AgentPicker } from './AgentPicker'
import { WorkspacePicker } from './WorkspacePicker'

/** The launcher (design board 14 L1, v3): a bolt in the drawer head opens the pinned
 *  actions. A row click runs the action at once on a NEW thread with the reviewer's
 *  default agent (Settings), mode auto — the head names it. The › at a row's edge, or
 *  a row the default agent cannot run, opens the second pane: another engine/model,
 *  or an existing thread to run inside. Marks say which engines reported a skill;
 *  they show only when two engines resolve. */
export function ActionLauncher() {
  const actions = useStore((s) => s.actions)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const repo = useStore((s) => s.loaded?.state.repo ?? null)
  const loaded = useStore((s) => s.loaded)
  // derived outside the selector: checkoutGate mints a fresh object per call, and a
  // selector that never returns a stable reference re-renders without end
  const gate = checkoutGate(loaded)
  const avail = useStore((s) => (repo ? s.commands[repo] : undefined) ?? NO_AVAIL)
  const chats = useStore((s) => s.loaded?.state.chats ?? EMPTY_CHATS)
  const ops = useStore((s) => s.ops)
  const loadCommands = useStore((s) => s.loadCommands)
  const refreshCommands = useStore((s) => s.refreshCommands)
  const runAction = useStore((s) => s.runAction)
  const openSettings = useStore((s) => s.openSettings)

  const { open, toggle, close, anchorRef, floatingRef, popStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({
    side: 'bottom', align: 'end', gap: 6, defaultOpen: Boolean(dev.openLauncher)
  })
  const [pane, setPane] = useState<'list' | 'target'>(dev.openLauncher && dev.launcherPane === 'target' ? 'target' : 'list')
  const [cur, setCur] = useState<string | null>(dev.openLauncher && dev.launcherPane === 'target' ? (actions[0]?.id ?? null) : null)
  const [agent, setAgent] = useState<AgentRef>(defaultAgent)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [threadId, setThreadId] = useState<number | null>(null)
  const [launching, setLaunching] = useState(false)

  useEffect(() => { if (open && repo) void loadCommands(repo) }, [open, repo, loadCommands])
  useEffect(() => { if (!open) { setPane('list'); setCur(null); setAgent(defaultAgent); setMode('new'); setThreadId(null); setLaunching(false) } }, [open, defaultAgent])

  const engines = markedEngines(avail)
  const forEngine = (e: EngineId): CommandAvailability | undefined => avail.find((a) => a.engine === e)
  const markOn = (a: ActionDef, e: EngineId): Mark => markFor(a, forEngine(e))
  const action = cur ? actions.find((a) => a.id === cur) ?? null : null
  const busyThreadFor = (a: ActionDef): boolean => {
    const t = chats.find((c) => c.action?.actionId === a.id)
    return t != null && opForThread(ops, t.id).running
  }

  const launch = async (a: ActionDef, target: { kind: 'new'; agent: AgentRef } | { kind: 'thread'; threadId: number }): Promise<void> => {
    setLaunching(true)
    await runAction(a.id, target)
    close()
  }

  const openTarget = (a: ActionDef): void => { setCur(a.id); setAgent(defaultAgent); setMode('new'); setThreadId(null); setPane('target') }

  return (
    <>
      <button ref={anchorRef} className={'ax-bolt' + (open ? ' on' : '')} title="Run an action" aria-label="Run an action" aria-expanded={open} onClick={toggle}>
        <I.bolt />
      </button>
      {open && (
        <div ref={floatingRef} className="ax-pop" data-pane={pane} style={popStyle} role="dialog" aria-label="Actions">
          {pane === 'list' || !action ? (
            <div className="ax-pane ax-list">
              <div className="ax-ph">
                <b>Actions</b>
                <span className="with">runs with
                  <span className="ax-head-agent" title="The agent a click uses — your default agent from Settings, execution mode auto">
                    <EngineGlyph engine={defaultAgent.engine} className="eng" style={{ width: 12, height: 12, color: 'var(--accent)' }} />
                    {engineLabel(defaultAgent.engine)}<span className="ag-sub"> · {modelOption(defaultAgent)?.label ?? defaultAgent.model ?? 'Auto'}</span>
                  </span>
                </span>
              </div>
              {gate.blocked ? (
                <div className="ax-none ax-gate">Check out <b>{gate.branch}</b> to run actions.{gate.branch && <WorkspacePicker branch={gate.branch} />}</div>
              ) : actions.length === 0 ? (
                <div className="ax-none">No actions yet · <a onClick={() => { close(); openSettings('actions') }}>Add one in Settings</a></div>
              ) : (
                <div className="ax-rows">
                  {actions.map((a) => {
                    const mark = markOn(a, defaultAgent.engine)
                    const blocked = a.kind === 'skill' && mark !== 'ok'
                    const checking = a.kind === 'skill' && mark === 'chk'
                    const busy = busyThreadFor(a)
                    const title = busy ? `${a.name} is running — open its thread from the chat selector`
                      : blocked ? (mark === 'chk' ? `Checking ${engineLabel(defaultAgent.engine)}…` : `Not on ${engineLabel(defaultAgent.engine)} — click for options`)
                      : `Run now with ${engineLabel(defaultAgent.engine)}`
                    return (
                      <div key={a.id} className={'ax-row' + (busy ? ' busy' : checking ? ' checking' : blocked ? ' blocked' : '')} role="button" tabIndex={0} title={title} aria-disabled={busy || launching}
                        onClick={() => { if (busy || launching) return; if (blocked) openTarget(a); else void launch(a, { kind: 'new', agent: defaultAgent }) }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLDivElement).click() } }}>
                        <KindGlyph kind={a.kind} />
                        <span className="ax-rn"><b>{busy ? `${a.name} · running…` : a.name}</b><i data-cur={engineLabel(defaultAgent.engine)}>{actionSub(a)}</i></span>
                        {a.kind === 'skill' && <ActionMarks action={a} engines={engines} avail={avail} />}
                        <button className="ax-more" title="Choose engine, model or an existing thread" aria-label={`Options for ${a.name}`} onClick={(e) => { e.stopPropagation(); openTarget(a) }}>
                          <I.chevR />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="ax-pf">
                {repo && avail.map((a) => (
                  <span key={a.engine} className="ax-pf-eng">
                    <EngineMark engine={a.engine} mark={a.state === 'checking' ? 'chk' : a.state === 'failed' ? 'bad' : a.state === 'unknown' ? 'unk' : 'ok'} title={`${engineLabel(a.engine)} · ${checkedAgo(a)}`} />
                    {checkedAgo(a)}
                  </span>
                ))}
                {repo && avail.length > 0 && (
                  <button className={'lnk' + (avail.some((a) => a.state === 'checking') ? ' spin' : '')} onClick={() => void refreshCommands(repo)}><I.refresh />Refresh</button>
                )}
                <a className="ax-edit" onClick={() => { close(); openSettings('actions') }}>Edit…</a>
              </div>
            </div>
          ) : (
            <TargetPane
              action={action}
              agent={agent}
              setAgent={setAgent}
              mode={mode}
              setMode={setMode}
              threadId={threadId}
              setThreadId={setThreadId}
              chats={chats.filter((c) => c.id >= 0)}
              markOn={markOn}
              forEngine={forEngine}
              onBack={() => setPane('list')}
              onRefresh={() => { if (repo) void refreshCommands(repo, [agent.engine]) }}
              launching={launching}
              onRun={() => void launch(action, mode === 'new' ? { kind: 'new', agent } : { kind: 'thread', threadId: threadId! })}
            />
          )}
        </div>
      )}
    </>
  )
}

const EMPTY_CHATS: ChatThread[] = []

function TargetPane({ action, agent, setAgent, mode, setMode, threadId, setThreadId, chats, markOn, forEngine, onBack, onRefresh, launching, onRun }: {
  action: ActionDef
  agent: AgentRef
  setAgent: (a: AgentRef) => void
  mode: 'new' | 'existing'
  setMode: (m: 'new' | 'existing') => void
  threadId: number | null
  setThreadId: (id: number | null) => void
  chats: ChatThread[]
  markOn: (a: ActionDef, e: EngineId) => Mark
  forEngine: (e: EngineId) => CommandAvailability | undefined
  onBack: () => void
  onRefresh: () => void
  launching: boolean
  onRun: () => void
}) {
  const mark = markOn(action, agent.engine)
  const other: EngineId = agent.engine === 'codex' ? 'claude' : 'codex'
  const picked = threadId != null ? chats.find((c) => c.id === threadId) ?? null : null
  const runnable = !launching && (mode === 'new' ? mark === 'ok' : picked != null && markOn(action, picked.agent.engine) === 'ok')
  return (
    <div className="ax-pane ax-target">
      <div className="ax-ph">
        <button className="ax-back" title="Back" aria-label="Back" onClick={onBack}><I.back /></button>
        <KindGlyph kind={action.kind} small />
        <b>{action.name}</b>
        <i>{action.kind === 'skill' ? actionSub(action) : ''}</i>
      </div>
      <div className="ax-tsec">Run in</div>
      <div className={'ax-opt' + (mode === 'new' ? ' on' : '')} role="radio" aria-checked={mode === 'new'} tabIndex={0} onClick={() => setMode('new')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('new') } }}>
        <span className="ax-rad" />
        <div>
          <b>New thread</b>
          <div className="ax-agent" onClick={(e) => e.stopPropagation()}>
            <AgentPicker value={agent} onChange={setAgent} align="left" />
            <span className="ax-mode-note">mode auto</span>
          </div>
          {mode === 'new' && action.kind === 'skill' && mark !== 'ok' && (
            <Block action={action} engine={agent.engine} mark={mark} avail={forEngine(agent.engine)} onRefresh={onRefresh} onSwitch={() => setAgent({ engine: other })} />
          )}
        </div>
      </div>
      <div className={'ax-opt' + (mode === 'existing' ? ' on' : '')} role="radio" aria-checked={mode === 'existing'} tabIndex={0} onClick={() => setMode('existing')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('existing') } }}>
        <span className="ax-rad" />
        <div>
          <b>Existing thread</b>
          {mode === 'existing' ? (
            chats.length === 0 ? <div className="ax-dim">no threads yet</div> : (
              <div className="ax-threads">
                {chats.map((c) => {
                  const m = markOn(action, c.agent.engine)
                  const off = m !== 'ok'
                  return (
                    <div key={c.id} role="option" aria-selected={c.id === threadId} aria-disabled={off}
                      className={'chatdd-opt' + (c.kind === 'review' ? ' is-review' : '') + (off ? ' off' : '') + (c.id === threadId ? ' on' : '')}
                      onClick={(e) => { e.stopPropagation(); if (!off) setThreadId(c.id) }}>
                      <EngineGlyph engine={c.agent.engine} className="cd-glyph" style={{ width: 14, height: 14 }} />
                      <span className="cd-name">{threadDisplayName(c, chats)}</span>
                      <span className="cd-sub">{off ? (m === 'chk' ? 'checking…' : 'not installed') : agentLabel(c.agent)}</span>
                    </div>
                  )
                })}
              </div>
            )
          ) : <div className="ax-dim">keeps that thread’s context and agent</div>}
        </div>
      </div>
      <div className="ax-pf">
        <span className="ax-thennote">{actionFindings(action) ? 'findings attach as proposed comments' : 'the result stays in the thread'}</span>
        <button className="btn btn-sm btn-primary ax-run" disabled={!runnable} onClick={onRun}>{launching ? 'Opening thread…' : `Run ${action.name}`}</button>
      </div>
    </div>
  )
}

/** Why the chosen engine cannot run this skill, with the way out (board 14 L1/R3). */
function Block({ action, engine, mark, avail, onRefresh, onSwitch }: {
  action: ActionDef; engine: EngineId; mark: Mark; avail: CommandAvailability | undefined; onRefresh: () => void; onSwitch: () => void
}) {
  const label = engineLabel(engine)
  const other = engineLabel(engine === 'codex' ? 'claude' : 'codex')
  if (mark === 'chk') {
    return <div className="ax-block pend"><span className="limn-spin" /><span>Checking {label} — its session is opening. Skill runs wait for this; nothing is sent yet.</span></div>
  }
  if (mark === 'unk') {
    return <div className="ax-block pend"><I.info /><span>{label} has not been checked in this repo yet. <a onClick={onRefresh}>Check now</a><a onClick={onSwitch}>Use {other}</a></span></div>
  }
  if (mark === 'bad') {
    return <div className="ax-block err"><I.warn /><span><b>{label} could not be reached</b>{avail?.error ? ` — ${avail.error}` : ''}. <a onClick={onRefresh}>Retry</a><a onClick={onSwitch}>Use {other}</a></span></div>
  }
  return (
    <div className="ax-block"><I.warn /><span><b>{action.name} is not installed for {label}</b> in this repo — it did not report <span className="mono">{skillPrompt(engine, action.body)}</span>. <a onClick={onRefresh}>Refresh</a><a onClick={onSwitch}>Use {other}</a></span></div>
  )
}

/** The same name the chat selector shows for a thread. */
function threadDisplayName(c: ChatThread, all: ChatThread[]): string {
  if (c.action) return c.action.name
  if (c.kind === 'review') {
    const reviews = all.filter((x) => x.kind === 'review')
    return c.id === reviews[reviews.length - 1]?.id ? (reviews.length > 1 ? 'Review · current' : 'Review') : `Review · old ${reviews.findIndex((x) => x.id === c.id) + 1}`
  }
  return c.title ?? 'Chat'
}

/** stable empty list — a selector must not mint a new array per render */
const NO_AVAIL: CommandAvailability[] = []
