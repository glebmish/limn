# Review-as-chat: streaming-persisted review thread + chat UI alignment

Date: 2026-06-25
Branch: `review-as-chat` (off `ux-improvements`)

## Problem

The review drawer treats the review agent as something that only *becomes* a chat
once generation finishes. The chat thread is created at the end of the `generate`
op (`reconcileChats`, called in the success path), so during the first in-flight
generation there is no persisted chat. The UI papers over this with indirect
gating (`iterations.length > 0`) and a `regenerating` special-case branch that
mirrors the live stream.

Two consequences:
- The drawer shows "Generate a guided review first" while a review is actively
  generating — the review agent isn't present in the chat until it completes.
- The gate is an indirect proxy; the drawer renders the chat list, so the honest
  measure is "does a chat exist", not "does an iteration exist".

Separately, the chat drawer layout has drifted from the design mockup.

## Goals

**A. Streaming-persisted review thread.** The review agent is a real, persisted
chat from the moment generation starts; its live stream renders through the same
path as any chat turn. No indirect gating, no in-progress special-case.

**B. Chat UI alignment.** Bring the drawer layout to the mockup exactly.

## A. Architecture

Make review generation a chat turn on a review thread created *before* the agent runs.

1. **Create the thread at op start** — in the `generate` handler, before running
   the engine, create a `kind:'review'` thread (no `engineSessionId` yet) and
   persist the `"Generate a guided review of <compare> against <base>"` user turn
   immediately. Return/emit the new thread id to the renderer.
2. **Renderer routes the op to the thread** — `startOp('review', opId, threadId)`
   carries the thread id (the store already has `gen.threadId`). Auto-select the
   new review thread so it streams live in the open drawer.
3. **Stream by thread, not by kind** — the drawer streaming guard becomes
   `gen.threadId != null && gen.threadId === active.id` (was `gen.kind === 'chat'
   && …`). The review's live tool calls + prose render through the existing chat
   streaming view.
4. **Finalize at completion** — attach `engineSessionId` to the thread, persist
   the agent message (summary text + reduced tool calls), write the iteration.
   `reconcileChats` shrinks to "ensure the default user chat exists"; it no longer
   creates the review thread.
5. **Cancel / fail keeps the thread** — append an agent note (`"Generation
   cancelled"` / `"Generation failed: <err>"`). No iteration is written, so
   freshness/drift logic (driven by `iterations`) is unaffected. A review thread
   may now exist without a matching iteration.
6. **Self-heal orphans** — on load, prune review threads that are truly empty
   orphans (no messages beyond a user turn and no iteration), to clean up after a
   hard crash mid-generation. The thread for a currently-running op is exempt.
7. **Gate on chats** — `hasChats = chats.length > 0`. The empty-state hint only
   shows when there are zero chats and nothing running. Delete the `regenerating`
   branch and the in-progress mirror.

### Edge cases
- **Regenerate** — each `generate` creates a *new* review thread (preserving the
  existing per-generation-session history), made active on completion as today.
- **Transient session** — `generate` receives a real `sessionId` (the session is
  minted before generate runs), so thread creation at op start is safe.
- **Failed thread as "latest review"** — `latestReview` (last review-kind chat)
  may point at a failed attempt; that is acceptable (it shows the failed run).
  Drift/freshness stays correct because it reads `iterations`, not chats.

## B. Chat UI (match Image #4)

1. **Header consolidation** — drop the `"Chats · tied to this review"` bar; the
   dropdown pill (`Review · current ›`) becomes the header, `✕` beside it.
2. **Agent + mode move to the bottom** — remove the top `chat-agentbar`; place the
   agent picker (`✳ Claude · Opus · high ›`) and mode selector (`🔒 Auto mode ▾`)
   as a footer bar below the textarea.
3. **Relocate delete-chat** — move per-chat delete from the (removed) agentbar into
   the dropdown rows.
4. **Reconcile styling** — message card, collapsed tool-call header, inline-code
   chips, "Jump to" file card, and the `RUN COMMAND / MEDIUM RISK` approval card
   already exist structurally; align spacing/labels and the input placeholder
   (`Ask Claude · Opus…`) to the mockup.

## Testing

- Unit: `reconcileChats` no longer creates the review thread; ensures default user
  chat. Orphan self-heal prunes empty review threads, exempts the running op's.
- Unit: DAO — thread created at op start has no `engineSessionId`; completion sets
  it; cancel/fail appends the note message.
- Integration of the `generate` handler is covered via the existing fake-engine
  test path where present; otherwise verified by build + manual run.
- Full `npm test`, `typecheck`, `lint`, `build` green before each themed commit.

## Out of scope
- Per-token DB persistence (turn-level only, matching the chat op).
- Changes to GenPanel's on-page progress strip (it keeps showing live progress).
