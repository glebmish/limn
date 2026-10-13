import type { LoadedReview, OpErrorCode, OperationStatus } from '../../shared/ipc'
import type { ApprovalRequest, ChatThread, EngineEvent, FileDiff, Section, ViewMark } from '../../shared/types'
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

/** Non-fatal load degradations (blobs that failed to parse, salvaged in the DAO)
 *  surface in the same dismissible error strip as boot notices. null → no strip. */
export function loadWarningStrip(loaded: LoadedReview): string | null {
  const w = loaded.state.loadWarnings
  return w && w.length ? `Some saved review data could not be loaded: ${w.join('; ')}` : null
}

/** Whether the review's compare branch is in a state where writes (agent edits and
 *  reviewer in-place edits) can land. `blocked` → branch checked out nowhere
 *  (submissions disabled, offer checkout). `dirtyWarn` → writable but the worktree
 *  carries uncommitted changes, so agent edits will mix with them (warn, never a
 *  block). Non-branch compares are inherently review-only and never blocked. */
export function checkoutGate(loaded: LoadedReview | null): { blocked: boolean; dirtyWarn: boolean; writeEnabled: boolean; branch: string | null } {
  const capability = loaded?.writeCapability
  if (!loaded || !capability) return { blocked: false, dirtyWarn: false, writeEnabled: false, branch: null }
  return {
    blocked: capability.reason === 'not-checked-out',
    dirtyWarn: capability.enabled && Boolean(loaded.dirty),
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
  return [...byDir.entries()].map(([dir, paths]) => ({
    id: `dir-${dir}`,
    name: dir === 'top-level' ? 'Top-level files' : dir + '/',
    files: paths,
    narration: []
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

export function renderedFiles(loaded: LoadedReview | null): FileDiff[] {
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

/** The files the review actually shows a diff for — exactly the list Review.tsx
 *  renders: `renderedFiles` (the merged base→working-tree list while the tree is
 *  dirty, the committed spine otherwise) minus excluded files, whose group renders no
 *  comments. Reading the committed list here instead put a worktree-only file's
 *  comments in the band AND in its own diff (two copies of one `data-comment-id`, a
 *  jump landing on the band's), and left a committed file the worktree reverted with
 *  comments shown nowhere. Anything that asks "is this file in the diff?" for
 *  rendering or jumping asks this. */
export function diffFilePaths(loaded: LoadedReview | null): Set<string> {
  // `fileIsExcluded`'s rule, with the sectioned-path set built once for the whole list
  const sectioned = sectionedPathSet(loaded)
  const annotated = Boolean(loaded?.state.annotations)
  return new Set(renderedFiles(loaded)
    .filter((f) => !fileEffectivelyExcluded(f, loaded?.state.fileExcluded, annotated, !sectioned.has(f.path)))
    .map((f) => f.path))
}

/** Whether an acceptance criterion's `source` path is one of the review's changed
 *  files (jump to its diff) rather than a detected artifact (open the rendered doc).
 *  Unlike `diffFilePaths` this keeps excluded files: excluding an untracked file
 *  moves it to the Untracked group, it does not turn a code file into a document. */
export function sourceIsDiffFile(loaded: LoadedReview | null, path: string): boolean {
  return renderedFiles(loaded).some((f) => f.path === path)
}

function filesForSection(loaded: LoadedReview | null, section: Section): FileDiff[] {
  const byPath = new Map(renderedFiles(loaded).map((f) => [f.path, f]))
  return section.files.map((p) => byPath.get(p)).filter((f): f is FileDiff => Boolean(f))
}

/** Every section whose files are all viewed, as a Set of ids — the same predicate
 *  `sectionViewState` owns, computed once over the whole review instead of recomputed
 *  per section per caller (Review.tsx's `isSectionDone`/`reviewedCount` and
 *  `useReviewScroll`'s scroll-sync handler both read the resulting Set). Takes
 *  `loaded`/`sections`/`viewedAt` directly — the same inputs Review.tsx's own
 *  `filesFor` reads (`renderedFiles` + `fileIsExcluded`) — rather than a `filesFor`
 *  closure, so it stays a pure function of its declared arguments with nothing hidden
 *  for a caller's memo to under-declare in its deps. Unlike `filesForSection` above
 *  (used by `collapseCompletedSections`, a different rule), this excludes files the
 *  review currently excludes — an excluded file can still be listed in a section. */
export function doneSectionIds(loaded: LoadedReview | null, sections: readonly Section[], viewedAt: Record<string, ViewMark>): Set<string> {
  const files = renderedFiles(loaded).filter((f) => !fileIsExcluded(loaded, f))
  const headSha = loaded?.skeleton.headSha
  const done = new Set<string>()
  for (const s of sections) {
    if (sectionViewState(orderFilesForReview(files, s.files), viewedAt, headSha) === 'all') done.add(s.id)
  }
  return done
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
  /** Whether this op holds/needs the repo's lane. Every agent-shaped task does (one
   *  task queue per repo — design board 14 v3), so this is `true` for any op main
   *  runs; the field survives as the wire contract main announces on op:event /
   *  op:result envelopes (`setOpLane`). */
  exclusive: boolean
  /** Set while the op waits its turn in the repo's task queue (from the `lane`
   *  events main streams): its 1-based place and what it is behind. Null once it
   *  holds the lane — or for an op that never had to wait. */
  queued: { position: number; behind: string } | null
  /** The seq the next accepted `op:event` for this op must carry (see OpEventMsg.seq).
   *  Set when the op is ADOPTED from a load snapshot — the snapshot replays events the
   *  live subscription may also deliver, so anything below this was already logged and
   *  is dropped. Undefined for an op this tab started itself (it saw the whole stream);
   *  the first seq-carrying event still starts the tracking. */
  nextSeq?: number
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

/** Op preference for the per-thread / per-review selectors below: a RUNNING op always
 *  beats a finished one (a live stream must never be shadowed by a stale entry — finished
 *  ops linger in `ops` until the next startOp on their thread or a session switch); among
 *  equals, the most recently started wins. */
function betterOp(op: OpState, best: OpState | null): boolean {
  if (!best) return true
  if (op.running !== best.running) return op.running
  return (op.startedAt ?? 0) > (best.startedAt ?? 0)
}

/** The op (running or last-finished) streaming into a given thread, or an idle state.
 *  A thread normally holds one op (`startOp` evicts a prior finished op on the same
 *  thread), but a still-running op survives a new startOp there (e.g. an update-
 *  generation reusing the review thread under a streaming shared chat) — so prefer the
 *  RUNNING op, falling back to the most recently started. */
export function opForThread(ops: Record<string, OpState>, threadId: number | null | undefined): OpState {
  if (threadId == null) return IDLE_GEN
  let best: OpState | null = null
  for (const op of Object.values(ops)) if (op.threadId === threadId && betterOp(op, best)) best = op
  return best ?? IDLE_GEN
}

/** The review-generation op for the loaded review: the `review`-kind op whose thread
 *  belongs to this review's chats. Scoped to `loaded` so an op on a *different* session
 *  can't paint its progress/cancel state onto the one you're viewing. Old review threads
 *  persist and finished ops are never pruned, so prefer the RUNNING op (then the most
 *  recently started) — a stale finished generation must not shadow a fresh regenerate. */
export function reviewOp(ops: Record<string, OpState>, loaded: LoadedReview | null): OpState {
  let best: OpState | null = null
  for (const op of Object.values(ops)) {
    if (op.kind !== 'review' || op.threadId == null || !loaded?.state.chats?.some((c) => c.id === op.threadId)) continue
    if (betterOp(op, best)) best = op
  }
  return best ?? IDLE_GEN
}

/** True while any op holds or waits for the repo's lane (generate / batch / a chat
 *  turn / an action run) — the gate for "is something running" and the
 *  watcher-suppression meaning. Kept under its historical name: every op is
 *  exclusive now (one task queue per repo). */
export function anyExclusiveRunning(ops: Record<string, OpState>): boolean {
  return Object.values(ops).some((op) => op.running && op.exclusive)
}

/** True while any op at all is running. */
export function anyRunning(ops: Record<string, OpState>): boolean {
  return Object.values(ops).some((op) => op.running)
}

/** The running ops that are actually WAITING in the repo's task queue, in queue order. */
export function queuedOps(ops: Record<string, OpState>): OpState[] {
  return Object.values(ops).filter((op) => op.running && op.queued).sort((a, b) => a.queued!.position - b.queued!.position)
}

/** Whether a chat turn to `threadId` can be sent right now: only the target thread
 *  being mid-turn blocks it. Anything else running on the repo just means the turn
 *  queues behind it server-side (one task queue per repo). */
export function chatSendBlocked(ops: Record<string, OpState>, threadId: number | null | undefined): boolean {
  return opForThread(ops, threadId).running
}

/** Approval requests still awaiting the reviewer: derived from the running op's log,
 *  minus any id already recorded in `answeredApprovals` (the single source of truth).
 *  Empty when no op is running. Safe against the log cap: status events keep streaming
 *  while a request is parked, so the log DOES advance past it — but `pushOpEvent`'s cap
 *  carries every unanswered approval_request forward when it trims the window. */
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

