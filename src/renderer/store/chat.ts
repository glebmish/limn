import type { StateCreator } from 'zustand'
import type { AgentRef, ChatThread, CommentAnchor, ExecutionMode } from '../../shared/types'
import { DEFAULT_EXECUTION_MODE } from '../../shared/executionMode'
import { api } from '../lib/api'
import { dev } from '../dev'
import type { AppStore } from './index'
import { useStore } from './index'
import { newOpId } from './ops'
import type { ChatDraft } from './derive'
import { activeChat, anyRunning, batchUserPreview, chatSendBlocked, DRAFT_CHAT_ID, pickActiveChat } from './derive'

// ── promoted stateful helpers ────────────────────────────────
// These were closures over set/get inside the store factory; they now reach the
// store via useStore.getState()/setState() (the step-4/6 pattern) so the send
// paths can funnel through them from module scope.

/** Splice an updated chat-thread list into the loaded review. */
function setChats(chats: ChatThread[]): void {
  const loaded = useStore.getState().loaded
  if (loaded) useStore.setState({ loaded: { ...loaded, state: { ...loaded.state, chats } } })
}

/** Resolve the active chat to a real, persisted thread id, minting the draft on
 *  first use (createChat). Returns null when there's nothing to send to. Shared
 *  by every "send to the active chat" path so they materialize drafts the same way. */
async function materializeActiveChat(): Promise<number | null> {
  const active = activeChat(useStore.getState().loaded, useStore.getState().activeChatId, useStore.getState().draftChat)
  if (!active) return null
  if (active.id !== DRAFT_CHAT_ID) return active.id
  const { sessionId } = useStore.getState()
  if (sessionId == null) return null
  try {
    const chats = await api().createChat(sessionId, active.agent, active.executionMode)
    setChats(chats)
    const id = chats[chats.length - 1]?.id ?? null
    if (id != null) useStore.setState({ activeChatId: id, draftChat: null })
    return id
  } catch (err) {
    useStore.setState({ error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Send a chat turn to an explicit thread id. This is the low-level path used by
 *  both the composer and the review Follow up CTA; it avoids relying on
 *  activeChatId having just been changed by another action. */
function sendChatToThread(threadId: number, body: string, anchor?: CommentAnchor): void {
  const text = body.trim()
  // block only if this exact thread is streaming or the shared lane is full — a turn
  // may run alongside a generation (it routes read-only in main). The composer is
  // also disabled in these cases (visible feedback), so this is defense-in-depth.
  if (!text || chatSendBlocked(useStore.getState().ops, threadId)) return
  const loaded = useStore.getState().loaded
  if (loaded) {
    setChats(loaded.state.chats.map((c) => c.id === threadId
      ? { ...c, messages: [...c.messages, { role: 'user' as const, text, at: new Date().toISOString(), ...(anchor ? { anchor } : {}) }] }
      : c))
  }
  const opId = newOpId()
  useStore.getState().startOp('chat', opId, threadId)
  void api().sendChat(threadId, text, opId, anchor)
}

/** The chat domain: the active chat selection + local draft composer state, the
 *  drawer open flag, and every action that mutates a chat thread or sends a turn
 *  to its agent (the three send paths funnel through the promoted helpers above). */
export interface ChatSlice {
  activeChatId: number | null
  /** Local-only composer state; never inserted into persisted ChatThread[]. */
  draftChat: ChatDraft | null
  /** whether the chat drawer is open (lifted here so an agent-identity click in
   *  the review can open a specific chat). */
  chatOpen: boolean

  switchChat(id: number): void
  openChat(threadId?: number): void
  closeChat(): void
  newChat(): Promise<void>
  setActiveChatAgent(a: AgentRef): Promise<void>
  setChatMode(threadId: number, mode: ExecutionMode): Promise<void>
  /** Persist a reviewer's dismissal of a suggest-mark-viewed card. */
  dismissSuggestion(threadId: number, actionId: string): Promise<void>
  sendChat(text: string, anchor?: CommentAnchor): void
  /** continue the review thread with a follow-up chat turn (opens the drawer). */
  followUp(text: string): void
  /** the unified batch turn: send comments to a thread's agent (edits+commits code). */
  sendBatch(threadId: number, commentIds: string[], steer?: string, refine?: boolean): void
  /** send queued comments to the *active* chat's agent (minting a draft chat if
   *  the active one hasn't persisted yet) — the destination shown in the UI. */
  sendQueuedComments(commentIds: string[], steer?: string): void
  deleteChat(id: number): Promise<void>
}

export const createChatSlice: StateCreator<AppStore, [], [], ChatSlice> = (set, get) => ({
  activeChatId: null,
  draftChat: null,
  chatOpen: dev.flow === 'chat',

  switchChat(id) {
    set({ activeChatId: id })
  },

  openChat(threadId) {
    set(threadId != null ? { chatOpen: true, activeChatId: threadId } : { chatOpen: true })
  },

  closeChat() {
    set({ chatOpen: false })
  },

  async newChat() {
    const { sessionId, loaded, agent } = get()
    if (sessionId == null || !loaded) return
    const active = activeChat(loaded, get().activeChatId, get().draftChat)
    const a = active?.agent ?? loaded.state.agent ?? agent
    // A new chat is a renderer-only draft (id DRAFT_CHAT_ID) — no DB write, so empty
    // chats never persist or pile up. It materializes on its first message (sendChat).
    if (get().draftChat) { set({ activeChatId: DRAFT_CHAT_ID }); return }
    const draft: ChatDraft = {
      kind: 'user', agent: a, messages: [],
      createdAt: new Date().toISOString(), executionMode: DEFAULT_EXECUTION_MODE
    }
    set({ draftChat: draft, activeChatId: DRAFT_CHAT_ID })
  },

  /** Change the active chat's agent. Draft/empty chat → retarget in place (draft
   *  stays local); a chat with messages or a bound session → fork a new chat. */
  async setActiveChatAgent(a) {
    const { sessionId, loaded } = get()
    const active = activeChat(loaded, get().activeChatId, get().draftChat)
    if (sessionId == null || !active) return
    if (active.id === DRAFT_CHAT_ID) {
      set((s) => ({ draftChat: s.draftChat ? { ...s.draftChat, agent: a } : null }))
      return
    }
    const isEmpty = active.messages.length === 0 && !active.engineSessionId
    try {
      if (isEmpty) {
        setChats(await api().setChatAgent(active.id, a))
      } else {
        const chats = await api().createChat(sessionId, a)
        setChats(chats)
        set({ activeChatId: chats[chats.length - 1]?.id ?? null })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  async setChatMode(threadId, mode) {
    // A draft chat (DRAFT_CHAT_ID) has no DB row yet — keep the choice on the
    // local draft so it survives until the chat materializes on its first turn
    // (mirrors setActiveChatAgent). Calling IPC here would 'chat thread not found'.
    if (threadId === DRAFT_CHAT_ID) {
      set((s) => ({ draftChat: s.draftChat ? { ...s.draftChat, executionMode: mode } : null }))
      return
    }
    try {
      setChats(await api().setChatMode(threadId, mode))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  async dismissSuggestion(threadId, actionId) {
    try {
      setChats(await api().dismissSuggestion(threadId, actionId))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  sendChat(text, anchor) {
    const body = text.trim()
    if (!body || chatSendBlocked(get().ops, get().activeChatId)) return
    // a draft chat persists lazily on its first turn — mint the real thread now,
    // then send into THAT id.
    void (async () => {
      const targetId = await materializeActiveChat()
      if (targetId == null) return
      sendChatToThread(targetId, body, anchor)
    })()
  },

  /** "Follow up" from the generate panel: continue the review thread (the agent
   *  that authored the review) with a chat turn, opening the drawer so it streams. */
  followUp(text) {
    const body = text.trim()
    if (!body) return
    const loaded = get().loaded
    if (!loaded) return
    void (async () => {
      const current = get().loaded
      const review = (current?.state.latestIteration?.sessionId
        ? current.state.chats.find((c) => c.kind === 'review' && c.engineSessionId === current.state.latestIteration?.sessionId)
        : undefined)
        ?? [...(current?.state.chats ?? [])].reverse().find((c) => c.kind === 'review')
      let targetId = review?.id
      // don't follow-up a thread that's already streaming (incl. its own generation,
      // OQ6) or when the shared lane is full — checked before any createChat side effect.
      if (targetId != null && chatSendBlocked(get().ops, targetId)) return
      if (targetId == null) {
        // Older/generated sessions can predate persisted review threads. Create a
        // normal chat with the review agent so Follow up still has somewhere real
        // to send instead of silently doing nothing.
        const sessionId = get().sessionId ?? await get().materialize()
        if (sessionId == null) return
        try {
          const chats = await api().createChat(sessionId, loaded.state.agent ?? get().agent)
          setChats(chats)
          targetId = chats[chats.length - 1]?.id
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) })
          return
        }
      }
      if (targetId == null) return
      get().openChat(targetId)
      sendChatToThread(targetId, body)
    })()
  },

  sendBatch(threadId, commentIds, steer, refine) {
    if (anyRunning(get().ops)) return // batch needs the exclusive lane; no queueing (spec §4)
    const trimmed = steer?.trim() || undefined
    if (commentIds.length === 0 && !trimmed) return
    const loaded = get().loaded
    if (loaded && commentIds.length > 0) {
      const comments = loaded.state.comments.filter((c) => commentIds.includes(c.id) && c.status !== 'resolved')
      setChats(loaded.state.chats.map((c) => c.id === threadId
        ? {
            ...c,
            messages: [...c.messages, {
              role: 'user' as const,
              text: batchUserPreview(comments, loaded, refine, trimmed),
              at: new Date().toISOString(),
              ...(comments.length ? { commentRefs: comments.map((comment) => comment.id) } : {})
            }]
          }
        : c))
    }
    const opId = newOpId()
    // sending to the agent (queued comments OR a decision answer) opens the chat
    // so the turn + its tool calls are visible as they run
    get().openChat(threadId)
    get().startOp('chat', opId, threadId, true) // batch is write-capable → exclusive lane
    void api().sendBatch(threadId, commentIds, trimmed, opId, refine)
  },

  sendQueuedComments(commentIds, steer) {
    if (anyRunning(get().ops)) return // batch path → exclusive lane, no queueing (spec §4)
    // queued comments go to whatever chat is active (its agent is the destination
    // shown in the UI), materializing a draft chat into a real thread first.
    void (async () => {
      const targetId = await materializeActiveChat()
      if (targetId == null) return
      get().sendBatch(targetId, commentIds, steer)
    })()
  },

  async deleteChat(id) {
    const { sessionId } = get()
    if (sessionId == null) return
    if (id === DRAFT_CHAT_ID) {
      const chats = get().loaded?.state.chats ?? []
      set({ draftChat: null, activeChatId: get().activeChatId === id ? pickActiveChat(chats, null) : get().activeChatId })
      return
    }
    try {
      const chats = await api().deleteChat(id)
      setChats(chats)
      if (get().activeChatId === id) set({ activeChatId: pickActiveChat(chats, null) })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  }
})
