import { I, EngineGlyph } from '../kit'
import { usePopover } from '../lib/usePopover'
import { engineLabel } from '../../shared/agents'
import type { ChatThread } from '../../shared/types'
import { dev } from '../dev'

/** Chat selector as a dropdown listing every chat (replaces the tab strip so it
 *  doesn't crowd as chats pile up). Trigger shows the active chat; the menu lists
 *  all chats + a "New chat" row. */
export function ChatDropdown({ chats, activeId, onSwitch, onNew, onDelete }: {
  chats: ChatThread[]
  activeId: number | null
  onSwitch: (id: number) => void
  onNew: () => void
  onDelete?: (id: number) => void
}) {
  // full-width dropdown that scrolls (not overflows) once chats pile up
  const { open, toggle, close, anchorRef, floatingRef, popStyle: menuStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'bottom', align: 'start', gap: 5, matchWidth: true, defaultOpen: Boolean(dev.openChatList) })
  const active = chats.find((c) => c.id === activeId) ?? null

  const pick = (id: number): void => { onSwitch(id); close() }

  // reviews pinned to the top in chronological order (oldest up, current last),
  // user chats below — grouped under headers so the two are visually distinct.
  // Labels come from the full `chats` (id order), so display order can't skew them.
  // the unpersisted "New chat" draft (id < 0) is the active/trigger entry but is
  // never listed in the menu — it appears there only once it has its first message.
  const reviews = chats.filter((c) => c.kind === 'review')
  const userChats = chats.filter((c) => c.kind === 'user' && c.id >= 0)

  const Opt = (c: ChatThread) => (
    <div key={c.id} role="button" tabIndex={0} className={'chatdd-opt' + (c.kind === 'review' ? ' is-review' : '') + (c.id === activeId ? ' on' : '')} onClick={() => pick(c.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(c.id) } }}>
      <EngineGlyph engine={c.agent.engine} className="cd-glyph" style={{ width: 14, height: 14 }} />
      <span className="cd-name">{chatName(c, chats)}</span>
      <span className="cd-sub">{agentSub(c)}</span>
      {onDelete && c.kind === 'user' && (
        <button className="chatdd-del" title="Delete chat"
          onClick={(e) => { e.stopPropagation(); onDelete(c.id) }}>
          <I.trash style={{ width: 12, height: 12 }} />
        </button>
      )}
    </div>
  )

  return (
    <div className="chatdd">
      <button ref={anchorRef} className="chatdd-trig" aria-expanded={open} onClick={toggle}>
        <EngineGlyph engine={active?.agent.engine} className="cd-glyph" style={{ width: 14, height: 14 }} />
        <span className="cd-name">{active ? chatName(active, chats) : 'Chats'}</span>
        <span className="cd-sub">{active ? agentSub(active) : ''}</span>
        <span className="cd-car">{open ? <I.chevD style={{ width: 13, height: 13 }} /> : <I.chevR style={{ width: 13, height: 13 }} />}</span>
      </button>
      {open && (
        <div className="chatdd-menu" ref={floatingRef} style={menuStyle}>
          {reviews.length > 0 && <div className="chatdd-grp">Review{reviews.length > 1 ? ' sessions' : ''}</div>}
          {reviews.map(Opt)}
          {userChats.length > 0 && <div className="chatdd-grp">Chats</div>}
          {userChats.map(Opt)}
          <div role="button" tabIndex={0} className="chatdd-new" onClick={() => { onNew(); close() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNew(); close() } }}>
            <I.plus style={{ width: 12, height: 12 }} />New chat
          </div>
        </div>
      )}
    </div>
  )
}

function chatName(c: ChatThread, all: ChatThread[]): string {
  if (c.kind === 'review') {
    // each generation is its own review session; the latest is current, older ones
    // are kept as history and labelled so they read as past sessions
    const reviews = all.filter((x) => x.kind === 'review')
    if (c.id === reviews[reviews.length - 1]?.id) return reviews.length > 1 ? 'Review · current' : 'Review'
    return `Review · old ${reviews.findIndex((x) => x.id === c.id) + 1}`
  }
  if (c.title) return c.title
  // a draft or an as-yet-untitled empty chat shows the placeholder; a titled chat
  // shows its (auto-derived) title; the `Chat N` form is the remaining fallback.
  if (c.id < 0 || c.messages.length === 0) return 'New chat'
  // number across all threads: the review session(s) come first, then user chats.
  const reviews = all.filter((x) => x.kind === 'review')
  const userChats = all.filter((x) => x.kind === 'user' && x.id >= 0)
  const n = userChats.findIndex((x) => x.id === c.id)
  return `Chat ${reviews.length + n + 1}`
}

function agentSub(c: ChatThread): string {
  const model = c.agent.model ?? 'Auto'
  const effort = c.agent.reasoningEffort ? ` · ${c.agent.reasoningEffort}` : ''
  return `${engineLabel(c.agent.engine)} · ${model}${effort}`
}
