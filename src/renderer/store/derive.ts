import type { LoadedReview, OpErrorCode, OperationStatus } from '../../shared/ipc'
import type { ApprovalRequest, ChatThread, Comment, EngineEvent, FileDiff, Hunk, Section, ViewMark } from '../../shared/types'
import { fileEffectivelyExcluded } from '../../shared/types'
import { orderFilesForReview } from '../lib/fileOrder'
import { IDLE_GEN } from './ops'

/** Sentinel id for a local-only "New chat" draft: an empty composer that isn't
 *  persisted (and so doesn't appear in the picker) until its first message lands. */
export const DRAFT_CHAT_ID = -1
export type ChatDraft = Omit<ChatThread, 'id'>

export type Density = 'compact' | 'comfortable' | 'spacious'
export type Guidance = 'minimal' | 'guided' | 'narrated'

/** Fixed presentation settings — baked in, not user-tweakable (formerly the
 *  wireframe Tweaks panel). Typed as the unions so call-site comparisons like
 *  `GUIDANCE === 'narrated'` stay valid. */
export const DENSITY: Density = 'comfortable'
export const GUIDANCE: Guidance = 'guided'

/** Whether the review's compare branch is in a state where agent edits can safely
 *  land. `blocked` → branch checked out nowhere (submissions disabled, offer
 *  checkout). `dirtyWarn` → branch active but its worktree is dirty (allowed, warn).
 *  Non-branch compares are inherently review-only and never blocked. */
/** Non-fatal load degradations (blobs that failed to parse, salvaged in the DAO)
 *  surface in the same dismissible error strip as boot notices. null → no strip. */
export function loadWarningStrip(loaded: LoadedReview): string | null {
  const w = loaded.state.loadWarnings
  return w && w.length ? `Some saved review data could not be loaded: ${w.join('; ')}` : null
}

export function checkoutGate(loaded: LoadedReview | null): { blocked: boolean; dirtyWarn: boolean; writeEnabled: boolean; branch: string | null } {
  const capability = loaded?.writeCapability
  if (!loaded || !capability) return { blocked: false, dirtyWarn: false, writeEnabled: false, branch: null }
  return {
    blocked: capability.reason === 'not-checked-out',
    dirtyWarn: capability.reason === 'dirty',
    writeEnabled: capability.enabled,
    branch: capability.branch
  }
}

/** Fallback grouping before AI annotations exist: one section per top-level dir. */
export function synthesizeSections(files: FileDiff[]): Section[] {
  const byDir = new Map<string, string[]>()
  for (const f of orderFilesForReview(files)) {
    const dir = f.path.includes('/') ? f.path.split('/')[0] : 'top-level'
    byDir.set(dir, [...(byDir.get(dir) ?? []), f.path])
  }
  return [...byDir.entries()].map(([dir, paths], i) => ({
    id: `dir-${dir}`,
    name: dir === 'top-level' ? 'Top-level files' : dir + '/',
    desc: '',
    what: '',
    files: paths,
    order: i + 1,
    flags: []
  }))
}

export function effectiveSections(loaded: LoadedReview | null): Section[] {
  if (!loaded) return []
  return loaded.state.annotations?.sections ?? synthesizeSections(loaded.skeleton.files)
}

/** A file counts as "viewed" once it has a viewed mark AND hasn't changed since.
 *  Two drift signals clear the tick: a commit touched it since viewing (the hunk
 *  carries `sinceViewed`, set per-file by diffSince), or its on-disk content hash
 *  no longer matches the snapshot (an uncommitted edit). */
export function fileViewed(f: FileDiff, viewedAt: Record<string, ViewMark>, headSha?: string): boolean {
  const mark = viewedAt[f.path]
  if (!mark) return false
  // `sinceViewed` is server-computed against the file's PRIOR mark sha (review.ts skips
  // files already viewed at head). After the reviewer re-views a drifted file the mark
  // jumps to head, but the hunk flags stay stale until the next reload — so ignore them
  // once the mark sits at head and trust the content hash below instead.
  if (mark.sha !== headSha && f.hunks.some((h) => h.sinceViewed)) return false
  // compare against the same `?? ''` convention viewMarkFor stamps with, so a file
  // with no content hash (non-branch compare / hashing skipped) doesn't read back
  // as drifted and clear its own tick.
  return mark.hash === (f.fileHash ?? '')
}

/** The hunks a file renders under the active diff-baseline mode. "Since approved" /
 *  "Since viewed" show the real per-baseline slice (or empty — a genuine "No changes
 *  since…" — when there is none). Untracked files are the exception: a wholly-new file
 *  has no prior version, so its since-diff IS its full diff. Showing the full diff there
 *  doesn't contradict the mode the way a tracked-file fallback would, and it avoids the
 *  misleading "No changes since you viewed" on a brand-new file that was never (or only
 *  just) viewed. */
export function diffHunksForMode(f: FileDiff, mode: 'branch' | 'approved' | 'viewed'): Hunk[] {
  if (mode === 'approved') return f.untracked ? f.hunks : (f.sinceHunks ?? [])
  if (mode === 'viewed') return f.untracked ? f.hunks : (f.sinceViewedHunks ?? [])
  return f.hunks
}

/** The viewed snapshot to stamp for `path`: the compare head + the file's current
 *  content hash (from the rendered diff — merged while dirty, else the spine). */
export function viewMarkFor(loaded: LoadedReview | null, path: string): ViewMark {
  const files = renderedFiles(loaded)
  return { sha: loaded?.skeleton.headSha ?? '', hash: files.find((f) => f.path === path)?.fileHash ?? '' }
}

/** Section completion is derived from its files: a section is viewed when all of
 *  its files are viewed. Returns the tri-state for the section's checkbox. */
export function sectionViewState(files: FileDiff[], viewedAt: Record<string, ViewMark>, headSha?: string): 'none' | 'some' | 'all' {
  if (files.length === 0) return 'none'
  const n = files.filter((f) => fileViewed(f, viewedAt, headSha)).length
  return n === 0 ? 'none' : n === files.length ? 'all' : 'some'
}

export interface SectionDisclosureState {
  viewState: 'none' | 'some' | 'all'
  done: boolean
  /** any file was viewed then drifted — the section's changed-since-viewed (amber)
   *  middle ground, rolled up from the same signal as the file glyphs so the badge
   *  colour agrees with the files beneath it. */
  amber: boolean
  open: boolean
}

export function sectionDisclosureState(files: FileDiff[], viewedAt: Record<string, ViewMark>, opts: {
  id: string
  collapsed: Set<string>
  expanded: Set<string>
  forceOpen?: boolean
  /** a transient file/diff jump force-renders its holding section so the target
   *  node exists to scroll to; it returns to its natural state on the next jump.
   *  A section JUMP, by contrast, opens imperatively via openSection (so it stays
   *  collapsible) — it does NOT come through here. */
  focused?: boolean
}, headSha?: string): SectionDisclosureState {
  const viewState = sectionViewState(files, viewedAt, headSha)
  const done = viewState === 'all'
  // matches reviewStatusForFile's amber rule (mark present, no longer counts as
  // viewed) — so combineReviewStatuses over the files would return st-amber too.
  const amber = files.some((f) => Boolean(viewedAt[f.path]) && !fileViewed(f, viewedAt, headSha))
  const open = Boolean(opts.forceOpen || opts.focused || opts.expanded.has(opts.id) || (!done && !opts.collapsed.has(opts.id)))
  return { viewState, done, amber, open }
}

export type DiffMode = 'branch' | 'approved' | 'viewed'

function renderedFiles(loaded: LoadedReview | null): FileDiff[] {
  return loaded ? (loaded.dirty && loaded.merged ? loaded.merged : loaded.skeleton.files) : []
}

/** Paths the agent placed in a section — used to decide which untracked files are
 *  "orphan" (and so auto-excluded in a narrated review). */
function sectionedPathSet(loaded: LoadedReview | null): Set<string> {
  return new Set((loaded?.state.annotations?.sections ?? []).flatMap((s) => s.files))
}

/** Whether a file is currently excluded from the review (see `fileEffectivelyExcluded`). */
export function fileIsExcluded(loaded: LoadedReview | null, f: FileDiff): boolean {
  return fileEffectivelyExcluded(f, loaded?.state.fileExcluded, Boolean(loaded?.state.annotations), !sectionedPathSet(loaded).has(f.path))
}

function filesForSection(loaded: LoadedReview | null, section: Section): FileDiff[] {
  const byPath = new Map(renderedFiles(loaded).map((f) => [f.path, f]))
  return section.files.map((p) => byPath.get(p)).filter((f): f is FileDiff => Boolean(f))
}

export function collapseCompletedSections(loaded: LoadedReview | null, viewedAt: Record<string, ViewMark>, expanded: Set<string>): Set<string> {
  if (!loaded || expanded.size === 0) return expanded
  const next = new Set(expanded)
  for (const section of effectiveSections(loaded)) {
    if (sectionViewState(filesForSection(loaded, section), viewedAt, loaded.skeleton.headSha) === 'all') next.delete(section.id)
  }
  return next
}

export interface GenState {
  running: boolean
  opId: string | null
  kind: 'review' | 'chat' | null
  /** for chat ops: which thread the streamed tokens belong to */
  threadId: number | null
  log: EngineEvent[]
  error: string | null
  /** epoch ms the op started — drives the live "elapsed" counter. */
  startedAt: number | null
  /** Typed terminal result; null while idle/running. */
  outcome: OperationStatus | null
  /** Stable classification of a failed op (e.g. a lost engine session), so the chat
   *  surface can render a distinct, actionable state instead of the generic error. */
  errorCode: OpErrorCode | null
  /** Request-ids the reviewer has already answered this op — the single source of
   *  truth so every approval surface (drawer card, nudge, strip, badge) agrees.
   *  Reset per op in startOp; a request is "pending" until its id lands here. */
  answeredApprovals: Set<string>
  /** Whether this op holds/needs the EXCLUSIVE lane (generate, batch, or a chat that
   *  started on an idle repo). A read-only shared chat is `false`. Drives the "disable
   *  Generate/batch" gates and the watcher. Predicted at start from `anyExclusiveRunning`
   *  and corrected by the terminal result's `lane` (concurrent-chat §4 / OQ7). */
  exclusive: boolean
}

/** Alias: an entry in the per-op `ops` map. Same shape as a single op's state. */
export type OpState = GenState

/** Whether a finished op failed because the thread's engine session was pruned — the
 *  chat surface shows a distinct "start a new chat" prompt for this. */
export function genSessionLost(gen: GenState): boolean {
  return gen.errorCode === 'ENGINE_SESSION_LOST'
}

/** Whether a finished operation has the typed cancelled outcome. */
export function genCancelled(gen: GenState): boolean {
  return gen.outcome === 'cancelled'
}

/** The op (running or last-finished) streaming into a given thread, or an idle state.
 *  Per-thread there is at most one op (`startOp` evicts a prior op on the same thread),
 *  so this is unambiguous. Replaces the single-`gen` thread check. */
export function opForThread(ops: Record<string, OpState>, threadId: number | null | undefined): OpState {
  if (threadId == null) return IDLE_GEN
  for (const op of Object.values(ops)) if (op.threadId === threadId) return op
  return IDLE_GEN
}

/** The review-generation op for the loaded review: the `review`-kind op whose thread
 *  belongs to this review's chats. Scoped to `loaded` so an op on a *different* session
 *  can't paint its progress/cancel state onto the one you're viewing. */
export function reviewOp(ops: Record<string, OpState>, loaded: LoadedReview | null): OpState {
  for (const op of Object.values(ops)) {
    if (op.kind === 'review' && op.threadId != null && loaded?.state.chats?.some((c) => c.id === op.threadId)) return op
  }
  return IDLE_GEN
}

/** True while any EXCLUSIVE op is running (generate / batch / an exclusive chat) — the
 *  gate for "can a new generate/batch start" and the watcher-suppression meaning. A
 *  read-only shared chat does not count. */
export function anyExclusiveRunning(ops: Record<string, OpState>): boolean {
  return Object.values(ops).some((op) => op.running && op.exclusive)
}

/** True while any op at all is running (either lane). */
export function anyRunning(ops: Record<string, OpState>): boolean {
  return Object.values(ops).some((op) => op.running)
}

/** True while a read-only SHARED chat op is running (the shared lane, capacity one). */
export function anySharedRunning(ops: Record<string, OpState>): boolean {
  return Object.values(ops).some((op) => op.running && !op.exclusive)
}

/** Whether a chat turn to `threadId` can be sent right now (concurrent-chat guards):
 *  the target thread must be idle, and if the exclusive lane is busy the shared lane
 *  (capacity one) must be free. A send on an idle repo takes the exclusive lane. */
export function chatSendBlocked(ops: Record<string, OpState>, threadId: number | null | undefined): boolean {
  if (opForThread(ops, threadId).running) return true      // the target thread is already streaming
  if (!anyExclusiveRunning(ops)) return false              // exclusive lane free → this turn takes it
  return anySharedRunning(ops)                             // else it must fit the (single) shared lane
}

/** Approval requests still awaiting the reviewer: derived from the running op's log,
 *  minus any id already recorded in `answeredApprovals` (the single source of truth).
 *  Empty when no op is running. Requests park the engine, so the log can't advance
 *  past a pending request and evict it — this is safe against the 200-event cap. */
export function pendingApprovals(gen: GenState): ApprovalRequest[] {
  if (!gen.running) return []
  return gen.log
    .flatMap((e) => (e.type === 'approval_request' ? [e.request] : []))
    .filter((r) => !gen.answeredApprovals.has(r.id))
}

/** The active chat thread (or a sensible default) within the loaded review. */
export function activeChat(loaded: LoadedReview | null, activeChatId: number | null, draft?: ChatDraft | null): ChatThread | null {
  if (activeChatId === DRAFT_CHAT_ID && draft) return { id: DRAFT_CHAT_ID, ...draft }
  const chats = loaded?.state.chats ?? []
  return chats.find((c) => c.id === activeChatId) ?? null
}

export function chatsWithDraft(loaded: LoadedReview | null, draft: ChatDraft | null): ChatThread[] {
  const chats = loaded?.state.chats ?? []
  return draft ? [...chats, { id: DRAFT_CHAT_ID, ...draft }] : chats
}

/** Keep the current chat if still present; else default to the empty user chat
 *  (the second default chat), else the last chat, else none. */
export function pickActiveChat(chats: ChatThread[], current: number | null): number | null {
  if (current != null && chats.some((c) => c.id === current)) return current
  const emptyUser = [...chats].reverse().find((c) => c.kind === 'user' && c.messages.length === 0 && !c.engineSessionId)
  return (emptyUser ?? chats[chats.length - 1])?.id ?? null
}

export function batchUserPreview(comments: Comment[], loaded: LoadedReview | null, refine?: boolean, steer?: string): string {
  if (refine) {
    const byId = new Map((loaded?.state.annotations?.questions ?? []).map((q) => [q.id, q]))
    const lines = comments.map((c) => {
      const qid = c.anchor.kind === 'question' ? c.anchor.questionId : ''
      const q = byId.get(qid)
      const label = q?.text ?? q?.context ?? (qid || 'Open question')
      return `- ${label}\n  Answer: ${c.text}`
    })
    return `Answered ${comments.length} open question${comments.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
  }
  return steer?.trim() ? `Handle ${comments.length} comment(s) - ${steer.trim()}` : `Handle ${comments.length} comment(s).`
}
