import type { Stack } from './diffStack.js'
// ── git ground truth ──────────────────────────────────────────
/** Per-line provenance in a base→working-tree diff. `committed` lines landed in a
 *  commit in range; `staged`/`unstaged` lines are uncommitted, split by whether the
 *  change sits in the index (staged) or only the working tree (unstaged). Absent on
 *  pure committed diffs (skeleton) where everything is committed by definition. */
export type LineOrigin = 'committed' | 'staged' | 'unstaged'
/** A line that is part of the uncommitted working tree (either index state). */
export function isUncommittedOrigin(origin: LineOrigin | undefined): boolean {
  return origin === 'staged' || origin === 'unstaged'
}

/** Whether a file is excluded from the review (no viewed/approved/drift state, shown
 *  in the collapsed Excluded group). Only untracked files can ever be excluded — a
 *  tracked file always returns false. An explicit per-file override wins; otherwise an
 *  untracked file is auto-excluded when the review is narrated (`annotated`) and the
 *  file is `orphan` (the agent placed it in no section). Flat (un-narrated) reviews
 *  never auto-exclude, so nothing disappears before a narration exists. */
export function fileEffectivelyExcluded(
  file: { path: string; untracked?: boolean },
  fileExcluded: Record<string, boolean> | undefined,
  annotated: boolean,
  orphan: boolean
): boolean {
  if (!file.untracked) return false
  const override = fileExcluded?.[file.path]
  if (override !== undefined) return override
  return annotated && orphan
}
export interface DiffLine { old: number | null; new: number | null; kind: '' | 'add' | 'del'; text: string; since?: boolean; sinceViewed?: boolean; origin?: LineOrigin }
export interface Hunk { range: string; header: string; lines: DiffLine[]; since?: boolean; sinceViewed?: boolean }
export interface FileDiff { path: string; oldPath?: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; binary: boolean; add: number; del: number; hunks: Hunk[]; /** content hash (git blob) of the file as it currently is on disk — the "did it change since viewed" key. Absent when there is no working tree to read (non-branch compare). */ fileHash?: string;
  /** True for a working-tree file git does not track yet (synthesized into an added
   *  diff). Only untracked files can be `excluded` from the review; tracked files
   *  never can. Absent (falsy) for every tracked/committed file. */
  untracked?: boolean;
  /** A mode-only change (e.g. chmod +x) carries the old→new file mode so the UI can
   *  surface the transition as a chip — such diffs have no line hunks to render. */
  modeChange?: { from: string; to: string };
  /** True for a working-tree file with unresolved merge conflicts (git reports it as
   *  unmerged). The diff body still renders normally — the conflict markers show
   *  inline; the UI adds a `conflict` status pill in the header. Absent (falsy) for
   *  every cleanly-merged file. */
  conflict?: boolean;
  /** Real git-diff hunks from the approved baseline → current surface (the "Since
   *  approved" tab). Absent when the file is unchanged since approval. NOT a filtered
   *  view of `hunks` — an independent `git diff` from a different base commit. */
  sinceHunks?: Hunk[];
  /** the file's diff measured from the sha the REVIEW was generated at — what the
   *  narration never saw. Independent of sinceHunks (the approval window). */
  sinceReviewHunks?: Hunk[];
  /** Real git-diff hunks from this file's viewed sha → current surface ("Since viewed"). */
  sinceViewedHunks?: Hunk[];
  /** git diff from the branch base to each checkpoint — the middle column of the
   *  Multi layout, base-relative like `hunks`. Present (possibly `[]`: the checkpoint
   *  exists, the file was unchanged there) only where that checkpoint exists for
   *  this file — so the renderer can tell "no change" from "no checkpoint". */
  baseToReviewHunks?: Hunk[];
  baseToApprovedHunks?: Hunk[];
  baseToViewedHunks?: Hunk[] }
/** A "viewed" snapshot: the compare head sha + the file's content hash at view time. */
export interface ViewMark { sha: string; hash: string }
export interface DiffSkeleton { base: string; branch: string; mergeBase: string; headSha: string; files: FileDiff[] }
export interface CommitInfo { sha: string; subject: string; author: string; date: string }
/** What landed on the compare branch since the loaded review snapshot: new commits
 *  plus the file/line delta (committed + uncommitted) since the loaded SHA, and
 *  whether the worktree currently carries uncommitted edits. Backs the titlebar
 *  "since you reviewed" fetch pill (commit chip + working-tree-edit chip). */
export interface DriftSummary { headSha: string; commits: number; files: number; add: number; del: number; dirty: boolean }

/** Main-process verdict on whether the compare branch's working tree is writable —
 *  gates agent edit runs AND reviewer in-place edits alike. A dirty tree is NOT a
 *  refusal: uncommitted edits share the tree with agent writes (spec inv 8). */
export interface AgentWriteCapability {
  enabled: boolean
  reason: 'available' | 'not-branch' | 'not-checked-out'
  branch: string | null
  workdir: string | null
}

// ── in-place edits (reviewer editing the working tree from the review) ────────
/** One in-place edit: replace working-tree lines start..end (1-based, inclusive)
 *  with `newLines`. `snapshot` must equal the file's current lines start..end or the
 *  write is refused (line-anchored compare-and-swap — writes elsewhere in the file
 *  never block). `end = start-1` with an empty snapshot inserts before `start`. */
export interface FileEdit { start: number; end: number; snapshot: string[]; newLines: string[] }
export type ApplyEditResult =
  | { ok: true; fileHash: string }
  /** the anchored lines changed on disk since render; `current` = the file's lines now */
  | { ok: false; reason: 'conflict'; current: string[] }
export type WorkingFile =
  | { ok: true; lines: string[]; trailingNewline: boolean }
  | { ok: false; reason: 'binary' | 'too-large' | 'missing' }

/** Where to read a file's text from for the diff body's folds: the tree as it is
 *  now (worktree when the branch is checked out, else the compare tip), or any
 *  commit the client already knows the sha of (base, a checkpoint). */
export type FileCheckpoint = { kind: 'now' } | { kind: 'sha'; sha: string }
export type FileAt =
  | { ok: true; lines: string[] }
  | { ok: false; reason: 'absent' | 'binary' | 'too-large' }

export function driftHasChanges(drift: DriftSummary | null | undefined): drift is DriftSummary {
  return Boolean(drift && (drift.commits > 0 || drift.files > 0 || drift.dirty))
}

// ── annotations (engine output, validated) ───────────────────
/** One block of section narration, read in order. `anchor` absent = a framing/
 *  cross-cutting block (no single line it points at); present = it points a
 *  reviewer at a specific spot while explaining it. */
export interface NarrationBlock { text: string; anchor?: FocusTarget }
export type DiagramKind = 'plain' | 'hi' | 'new'
export interface DiagramNode2 { id: string; label: string; kind: DiagramKind; sub?: string; anchor?: FocusTarget }
export interface DiagramEdge { from: string; to: string; label?: string }
export interface Diagram { why: string; caption: string; nodes: DiagramNode2[]; edges: DiagramEdge[] }
export interface BehaviorContrast { was: string; now: string }
export interface AcceptanceSource { path: string; line?: number }
export type HotspotSeverity = 'risk' | 'note'
export interface Section {
  id: string; name: string; files: string[];
  narration: NarrationBlock[];
  diagram?: Diagram;
  contrast?: BehaviorContrast;
}
/** First narration block's text — the collapsed sub-line / slim payload summary. */
export function narrationText(s: Section): string { return s.narration[0]?.text ?? '' }
export interface PlanMap {
  acceptance: { text: string; met: boolean | 'partial'; source?: AcceptanceSource }[];
  steps: { n: number; text: string; sectionId: string; status: 'done' | 'changed' | 'missing' }[];
  deviations: { text: string; sectionId: string }[];
}
export interface AgentQuestion {
  id: string
  text: string
  context?: string
  /** Short reviewer-selectable answers when the agent can name concrete choices. */
  options?: string[]
}
/** A full-generation agent-flagged risk/note, anchored at a diff spot. Becomes an
 *  anchored `Comment` (author:'agent', status:'resolved') at the ipc post-merge
 *  seam — never a persisted part of a review's narration. */
export interface Hotspot { anchor: FocusTarget; text: string; severity: HotspotSeverity }
export interface ReviewAnnotations {
  title: string; summary: string; sections: Section[];
  planMap?: PlanMap; questions: AgentQuestion[]; artifactPaths?: string[];
  /** The agent that produced this narration — stamped by the main process at
   *  generate time, so "Guided by" stays locked to it even if the regenerate
   *  picker is changed to a different agent. Not part of the engine's output. */
  generatedBy?: AgentRef;
}

// ── comments ──────────────────────────────────────────────────
/** A prose region a text selection can be anchored inside. */
export type SelectionScope =
  | { region: 'summary' }
  | { region: 'section'; sectionId: string }
  | { region: 'artifact'; path: string }
  | { region: 'file-note'; file: string }
/** Immutable record of the surface a positional comment was created against.
 *  Written once by the main process at upsert time; never mutated afterwards. */
export interface AnchorStamp {
  headSha: string          // compare tip at creation
  mergeBase: string        // merge-base at creation (blob source for side:'old')
  blobSha?: string         // git blob sha of the file content the line lives in;
                           // undefined only if blob resolution failed
  surface: 'committed' | 'dirty'  // line-number space of `line` at creation
  origLine: number         // immutable original line
  origPath: string         // immutable original path (rename tracking starts here)
}

/** ±CONTEXT_N exact context lines captured from the same content blobSha names.
 *  The durability floor: survives in SQLite even if the blob is GC'd. */
export interface AnchorContext {
  before: string[]         // up to CONTEXT_N lines above, in order
  after: string[]          // up to CONTEXT_N lines below, in order
}

/** Re-anchor verdict for a diff anchor that has no owning `Comment` — a narration
 *  block, a diagram node, or a `point` stop (`FocusTarget`). Comments record the same
 *  two outcomes on the comment itself (`outdated` / `notInDiff`); these anchors have
 *  nowhere else to put it, so it rides on the anchor. Recomputed on every load from
 *  the immutable stamp (never accumulated), and cleared the moment the line is placed
 *  on the rendered surface again.
 *   - `'lost'`        the line could not be found at all — `line` is a stale number
 *                     that now points at unrelated code, so the UI must not claim it.
 *   - `'off-surface'` `line` is correct in the file but is not rendered in this diff,
 *                     so there is nothing on screen to jump to. */
export type AnchorStale = 'lost' | 'off-surface'

export type CommentAnchor =
  | { kind: 'diff'; file: string; side: 'new' | 'old'; line: number; endLine?: number; hunkRange: string; lineContent: string; stamp?: AnchorStamp; context?: AnchorContext; stale?: AnchorStale }
  | { kind: 'artifact'; path: string; line: number; lineContent: string; stamp?: AnchorStamp; context?: AnchorContext }
  | { kind: 'plan-step'; stepN: number }
  | { kind: 'section'; sectionId: string; part?: 'narration' | 'diagram' }
  | { kind: 'summary' }
  | { kind: 'file'; file: string }
  | { kind: 'question'; questionId: string }
  | { kind: 'title' }
  | { kind: 'acceptance'; index: number }
  | { kind: 'deviation'; index: number }
  // content-addressed: carries the selected text + surrounding context so it needs
  // no positional re-anchoring (reanchorComments leaves it untouched).
  | { kind: 'selection'; scope: SelectionScope; quote: string; prefix: string; suffix: string }
export interface CommentReply {
  author: 'user' | 'agent'; text: string; at: string; agentRef?: AgentRef; threadId?: number;
  /** Set when this reply is an earlier resolution of the thread, folded into the
   *  thread when the reviewer replied and re-queued it (a thread can be resolved,
   *  answered, and resolved again — every verdict stays readable in order). */
  verdict?: 'addressed' | 'reworked' | 'skipped'
}
export interface Comment {
  id: string; anchor: CommentAnchor; author: 'user' | 'agent'; text: string;
  /** agent-authored comments/replies carry which agent + which chat thread, for
   *  the identity chip + click-through (JSON blob — no column migration). */
  agentRef?: AgentRef; threadId?: number;
  /** Set on hotspot cards (agent-flagged risk/note comments) — absent on ordinary
   *  comments. */
  severity?: HotspotSeverity;
  status: 'queued' | 'sent' | 'resolved' | 'outdated';
  /** Set by the re-anchor pipeline when a positional comment maps to a line that
   *  is valid in the file but not present in any rendered hunk at the current
   *  baseline (reverted nearby change / -U3 eviction / pure rename). The comment
   *  is anchored-but-not-visible: NOT outdated, shown in a per-file "not in this
   *  diff" bucket by the UI. Cleared on any load where it lands on a rendered line. */
  notInDiff?: boolean;
  /** Set by the re-anchor pipeline when the commented line ITSELF was rewritten
   *  since the comment was made (stage-1 `mapLine` → 'EDITED'): the text the
   *  reviewer wrote against no longer exists in the file. It says nothing about
   *  where the thread ended up — stage 2 may re-place it on the code that replaced
   *  the line, or nothing may match and it stays at its old line, flagged
   *  `notInDiff` (resolved) or `outdated`. Recomputed from the immutable stamp on
   *  every load: cleared whenever the line proves intact (identical content, a
   *  clean positional map, or a stage-3 exact-text hit) and left unset when stage 1
   *  can't run. The UI shows a "line edited since comment" marker. */
  anchorEdited?: boolean;
  resolution?: { verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string; agentRef?: AgentRef };
  replies: CommentReply[]; createdAt: string; iteration: number;
}

// ── agent tool actions ────────────────────────────────────────
/** The reviewable spots a `point` tool call can scroll+highlight. A subset of
 *  CommentAnchor (no parallel type) so a point chip and a comment chip share the
 *  same `focusAnchor` renderer. */
export type FocusTarget = Extract<CommentAnchor, { kind: 'summary' } | { kind: 'section' } | { kind: 'file' } | { kind: 'diff' }>
export interface PointStop { target: FocusTarget; note?: string }
/** A side effect (or suggestion) an agent performed during a chat turn. Emitted
 *  live as an `EngineEvent` and persisted on the agent ChatMessage so chips rebuild
 *  on reload. */
export type AgentAction =
  | { kind: 'point'; stops: PointStop[]; loop?: boolean }
  // `id` addresses this action for the dismiss-persist path; `resolution` records
  // only an explicit dismissal — the "marked" outcome is derived from real viewedAt
  // marks on reload, so it is never persisted here.
  | { kind: 'suggest_viewed'; id?: string; files?: string[]; sectionIds?: string[]; note?: string; resolution?: 'dismissed' }
  | { kind: 'comment_added'; comment: Comment }
  | { kind: 'comment_replied'; commentId: string; anchor: CommentAnchor; reply: CommentReply }
  | { kind: 'comment_resolved'; commentId: string; anchor: CommentAnchor; verdict: 'addressed' | 'reworked' | 'skipped'; note: string }
  | { kind: 'review_edited'; field: 'title' | 'summary' | 'section.block' | 'section.contrast'; sectionId?: string }
  | { kind: 'plan_status_updated'; index: number; met: boolean | 'partial' }

// ── tool-call log (wf-D) ──────────────────────────────────────
/** Verb drives the row icon + label; derived from the engine's raw tool name. */
export type ToolVerb = 'read' | 'grep' | 'edit' | 'bash' | 'list' | 'other'
/** A single tool invocation in the activity log. Emitted on the `tool` EngineEvent
 *  twice per call — `run` on start, `ok`/`err` on completion (same `id`) — folded by
 *  `reduceToolCalls`. Persisted (settled) on the agent ChatMessage. */
export interface ToolCall {
  id: string
  verb: ToolVerb
  name: string
  arg?: string
  kv?: [string, string][]
  state: 'run' | 'ok' | 'err'
  meta?: string
  out?: string
  outMore?: string
}

// ── execution mode (approvals ladder) ─────────────────────────
/** The per-chat autonomy tier the reviewer picks. One product vocabulary across
 *  engines; each `AcpEngineConfig.modeFor` maps it to the engine's session mode,
 *  and `ladderPolicy` maps it to per-request approval decisions. Persisted on the
 *  chat thread; defaults to 'ask'. */
export type ExecutionMode = 'ask' | 'edits' | 'auto' | 'full'
export interface ExecutionTier {
  key: ExecutionMode
  /** what the reviewer sees: 'Ask for approval' | 'Accept edits' | 'Auto mode' | 'Full access' */
  label: string
  desc: string
}

// ── engines ───────────────────────────────────────────────────
export type EngineId = 'claude' | 'codex'
/** Reasoning-effort knob. Both engines accept it now: Codex spans
 *  minimal→xhigh, Claude (Opus/Sonnet) spans low→max. Which values are offered
 *  per model is gated by the catalog's `reasoningEfforts`. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** A selectable agent = an engine + an optional model/effort. `model`
 *  undefined means "Auto" — let the CLI pick its default (today's behavior). */
export interface AgentRef { engine: EngineId; model?: string; reasoningEffort?: ReasoningEffort }
// ── interactive approvals ─────────────────────────────────────
export type ApprovalKind = 'command' | 'file_change' | 'tool_use'
/** A diff, as carried in `ApprovalRequest.detail.diffs` — one per changed file.
 *  Defined here (not in acpEvents.ts) so both the ACP mapper and the shared
 *  request shape reference the same type. */
export type ApprovalDiff = { path: string; oldText?: string; newText: string }
/** An agent wants to do something that needs the reviewer's go-ahead. Emitted as an
 *  EngineEvent and surfaced as a blocking card in chat; the decision routes back to
 *  the engine. Transient (per-turn) — not persisted as state. */
export interface ApprovalRequest {
  id: string                 // unique within the op; correlation key for respondApproval
  engine: EngineId
  kind: ApprovalKind
  summary: string            // one-line human summary, e.g. "Run `npm test`"
  detail?: {
    command?: string
    cwd?: string
    files?: string[]
    // Per-file before/after text for a file_change request, when the engine's
    // permission-request payload (or a prior tool_call update for the same
    // toolCallId) carried a diff — lets the card show an expandable preview
    // instead of just the path. Truncated (see acpEvents.ts) to keep the
    // approval payload small.
    diffs?: ApprovalDiff[]
    // Count of files omitted because `diffs` was capped (see acpEvents.ts's
    // `toApprovalDiffs`) — ApprovalCard renders this as a "+N more files" note
    // so a huge multi-file change doesn't silently look complete.
    moreFiles?: number
    toolName?: string
    // The agent's own stated reason for needing this escalation — e.g. codex-acp's
    // `_meta.codex.params.justification` on a `require_escalated` command (see
    // acpEvents.ts). Engine-supplied, never inferred by Limn.
    reason?: string
    [k: string]: unknown
  }
}
/** Per-operation only — no "approve for session". */
export type ApprovalDecision = 'allow' | 'deny'

export type EngineEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; call: ToolCall }          // structured tool-call lifecycle (wf-D)
  | { type: 'text'; text: string }            // streamed assistant text (chat)
  | { type: 'action'; action: AgentAction }   // agent tool call (point, suggest_mark_viewed, comment, …)
  | { type: 'approval_request'; request: ApprovalRequest }  // needs reviewer go-ahead
  | { type: 'done' }
  | { type: 'error'; message: string }

// ── artifacts / chat / state ─────────────────────────────────
/** A recognized spec/plan format. A markdown file is only treated as an
 *  artifact when its path matches one of these formats' conventions. The format
 *  drives discovery only — it is deliberately never surfaced as a per-row badge
 *  or label in the UI (retired: "No artifact format flag" design decision). */
export type ArtifactFormat = 'superpowers' | 'sdd'
export interface Artifact { role: 'spec' | 'plan' | 'doc'; format: ArtifactFormat; path: string; title: string; lines: string[] }
/** An ordered slice of an agent message: prose, a tool call reference, or an
 *  action reference by index into `ChatMessage.actions`. Preserves the
 *  interleaving the agent emitted so rows/cards render inline at their call site,
 *  not grouped. Built by `reduceSegments` for chat turns; review-generation turns
 *  persist `text` + `tools` with no `segments` and render via the tools-then-text path. */
export type MessageSegment = { kind: 'text'; text: string } | { kind: 'tool'; id: string } | { kind: 'action'; index: number }
export interface ChatMessage { role: 'user' | 'agent'; text: string; at: string; anchor?: CommentAnchor; actions?: AgentAction[]; tools?: ToolCall[]; segments?: MessageSegment[]; commentRefs?: string[] }
/** A conversation thread inside a review. 'review' is the auto-created thread
 *  bound to the engine session that produced the review; 'user' threads are
 *  started by the reviewer and may target any agent. */
export interface ChatThread {
  id: number
  kind: 'review' | 'user'
  agent: AgentRef
  /** engine session to resume; undefined until a 'user' thread's first turn */
  engineSessionId?: string
  messages: ChatMessage[]
  title?: string
  createdAt: string
  /** the autonomy tier for this chat's turns; defaults to 'ask'. */
  executionMode: ExecutionMode
}
export interface Iteration { n: number; engine: EngineId; sessionId: string; endSha: string; at: string; summary?: string; title: string; annotations: ReviewAnnotations; /** provenance of this iteration: 'full' = fresh/replacement generation, 'scoped' = diff-scoped update spliced onto the prior. */ scope: 'full' | 'scoped' }
export interface ReviewCopyCandidate {
  sessionId: number
  iteration: number
  title?: string
  baseSha: string
  endSha: string
  commitsOld: number
  at: string
  agent?: AgentRef
  baseSymbol: string
  compareSymbol: string
}
export interface ReviewState {
  repo: string; branch: string; base: string;
  engine?: EngineId; agent?: AgentRef; annotations?: ReviewAnnotations;
  comments: Comment[]; chats: ChatThread[];
  /** per-file snapshot taken when the file was marked viewed. `sha` is the compare
   *  head (drives per-file commit-drift via diffSince — catches new commits and
   *  dirty-becoming-commits); `hash` is the file's content hash at view time
   *  (catches uncommitted edits with no commit movement). */
  viewedAt: Record<string, ViewMark>;
  reviewedSections: string[];
  /** Per-file exclude override for untracked working-tree files (path → excluded?).
   *  An explicit entry wins; absent paths fall back to the auto default (an orphan
   *  untracked file in a narrated review is excluded). Tracked files are never here.
   *  See `fileEffectivelyExcluded`. */
  fileExcluded?: Record<string, boolean>;
  /** the review's default diff stack — which sheets are out beside current, and what
   *  Unified is measured against (design board 13). Absent = Unified, full diff. */
  diffStack?: Stack;
  /** whole-branch approval baseline */
  approvedSha?: string; reviewedAtSha?: string;
  /** every committed state explicitly approved in this session */
  approvedShas?: string[];
  /** every loaded branch surface explicitly approved; clean surfaces use hash=headSha */
  approvedHashes?: string[];
  /** per-artifact plan/spec approval: path → SHA at approval time */
  artifactApprovals: Record<string, string>;
  latestIteration?: Iteration;
  iterations: Iteration[]; artifacts: { role: 'spec' | 'plan'; path: string }[];
  /** Non-fatal load degradations: blobs that failed to parse and were skipped. */
  loadWarnings?: string[];
  /** Terminal merged record — set once the branch landed (or was marked merged).
   *  A merged session is read-only: no watcher, no drift, mutations blocked. */
  merged?: MergeRecord;
}
export interface RepoInfo { path: string; branches: string[]; current: string; defaultBase: string }

/** A git worktree (primary or linked). `branch` is null for a detached HEAD.
 *  `dirty` is populated by `repoState` (the UI path) and left undefined by the
 *  lean `listWorktrees` used in hot git paths. */
export interface WorktreeInfo { path: string; branch: string | null; head: string; primary: boolean; locked: boolean; dirty?: boolean }

/** Live git state for a repo — the source of truth the repo hub / review header
 *  switchers read. `current` is the branch checked out in the primary worktree
 *  ('HEAD' when detached). */
export interface RepoState {
  path: string
  branches: string[]
  current: string
  defaultBase: string
  dirty: boolean
  dirtyCount: number
  worktrees: WorktreeInfo[]
}

/** One row in the dashboard's repository index (Level 1). A repo enters the index
 *  when it is opened or has at least one live session. Carries the light git state
 *  the row renders plus the latest repo-open/session activity for sorting. */
export interface RepoIndexEntry {
  path: string
  current: string            // branch checked out in the primary worktree ('HEAD' if detached)
  defaultBase: string        // the base the branch chip opens against
  worktrees: WorktreeInfo[]
  sessionCount: number       // live (non-archived) sessions
  lastActivity: string       // ISO of the most recent repo open or session update
}

// ── ref pairs (sessions) ──────────────────────────────────────
export type RefKind = 'branch' | 'commit'
/** One side of a review session. Branch sides follow the tip (anchorSha
 *  records where the tip was at session start, for drift display).
 *  Commit sides are frozen at anchorSha; symbol keeps what the user typed. */
export interface RefSide { kind: RefKind; symbol: string; anchorSha: string }
export interface RefPair { base: RefSide; compare: RefSide }
/** Where a session side sits: the branch it lives on (null if none/detached),
 *  how many commits it is behind that branch's HEAD (0 for a branch tip), and
 *  its resolved sha. Drives the header ref-chip locator "branch ~n sha". */
export interface RefLoc { kind: RefKind; onBranch: string | null; behind: number; sha: string }

/** Stable identity for session keying: branches by name, commits by sha. */
export function refIdentity(side: RefSide): string {
  return side.kind === 'branch' ? `b:${side.symbol}` : `c:${side.anchorSha}`
}

/** The git rev to actually diff/log against right now. */
export function effectiveRef(side: RefSide): string {
  return side.kind === 'branch' ? side.symbol : side.anchorSha
}

/** A review approval covers a committed tree, not uncommitted working-tree edits.
 *  It is fresh only when the approved SHA is the loaded HEAD and the loaded
 *  working tree is clean. */
export function approvalFresh(approvedHashes: readonly string[] | string | undefined, branchHash: string | undefined): boolean {
  const hashes = Array.isArray(approvedHashes) ? approvedHashes : approvedHashes ? [approvedHashes] : []
  return Boolean(branchHash && hashes.includes(branchHash))
}

// ── merge (landing the branch) ────────────────────────────────
export type MergeStrategy = 'ff' | 'squash' | 'merge'

export type MergeGateId =
  | 'stale-approval'      // amber  (G1)  approval hash ∉ current surface
  | 'base-moved'          // amber  (G2)  base head ≠ merge-base(base, branch)
  | 'conflicts'           // red    (C1)  probe found conflicts (files listed)
  | 'base-site-dirty'     // red    (G3)  base checked out + that worktree dirty
  | 'branch-dirty'        // red          compare worktree has uncommitted changes
  | 'probe-unavailable'   // info         git < 2.38 — conflicts checked at confirm

export interface MergeGate {
  id: MergeGateId
  severity: 'amber' | 'red' | 'info'
  detail: string                  // human sentence for the gate band
  commits?: number                // stale-approval / base-moved
  add?: number; del?: number      // stale-approval
  files?: string[]                // conflicts
  workdir?: string                // base-site-dirty / branch-dirty
}

/** The CTA verdict, and the same rule the authoritative re-check at confirm applies:
 *  no red gates (never overridable), every amber explicitly overridden ("Merge
 *  anyway"), info gates never block. Lives here so the sheet and the server share ONE
 *  implementation of the blocking rule. */
export function mergeOk(gates: MergeGate[], overrides: readonly MergeGateId[]): boolean {
  return gates.every((g) =>
    g.severity === 'info' || (g.severity === 'amber' && overrides.includes(g.id)))
}

/** A live session stacked on the branch being merged (its base symbol IS that branch). */
export interface DependentReview {
  sessionId: number
  branch: string                  // its compare branch
  commits: number                 // aheadCount(mergedBranch..branch)
  rebasable: boolean              // checked out somewhere + that worktree clean
  blockedReason?: string          // when !rebasable: 'not checked out' | 'dirty worktree'
}

export interface MergePreflight {
  gates: MergeGate[]
  strategies: Record<MergeStrategy, boolean>
  commits: { sha: string; subject: string }[]    // base..tip, newest first
  draftMessage: string
  counts: { commits: number; files: number; add: number; del: number }
  /** the CAS expectations mergeExecute re-checks against */
  baseHead: string
  tipSha: string
  baseSymbol: string
  branch: string
  cleanup: { worktreePath?: string; dependents: DependentReview[] }
}

export interface MergeOverride { gate: MergeGateId; detail: string }

/** The durable record of a landed review (persisted as sessions.merge_json). */
export interface MergeRecord {
  strategy: MergeStrategy
  mergedSha: string               // new base head
  reviewedTipSha: string          // compare tip that landed
  baseSymbol: string
  baseShaBefore: string
  mergedAt: string                // ISO
  message?: string                // squash/merge commit message as landed
  overrides: MergeOverride[]
  cleanup: {
    archived: boolean
    branchDeleted: boolean
    worktreeRemoved: string | false
    retargeted: string[]          // dependent branches rebased + repointed
    failures: string[]            // partial cleanup failures, verbatim
  }
  dependents: string[]            // branch names of detected stacked reviews
  external?: boolean              // settled via "Mark merged" (S12)
}

export interface MergeCleanupRequest {
  archiveSession: boolean
  deleteBranch: boolean
  removeWorktree: boolean
  retarget: number[]              // dependent session ids
}

export interface MergeExecuteRequest {
  strategy: MergeStrategy
  message?: string
  overrides: MergeGateId[]
  cleanup: MergeCleanupRequest
  expect: { baseHead: string; tipSha: string }   // what the sheet showed
}

export type MergeExecuteResult =
  | { status: 'merged'; record: MergeRecord }
  | { status: 'preflight-changed'; preflight: MergePreflight }

export interface SessionMeta {
  id: number
  repo: string
  pair: RefPair
  engine?: EngineId
  /** review agent (engine + model/effort); engine mirrors agent.engine */
  agent?: AgentRef
  createdAt: string
  updatedAt: string
}

/** A row in the repo hub's session list — denormalized for display. */
export interface SessionListItem {
  id: number
  baseSymbol: string
  compareSymbol: string
  compareKind: RefKind
  title?: string
  hasReview: boolean       // an annotation/review has been generated
  approved: boolean        // committed review state is approved; live dirty state is evaluated on load
  archived: boolean        // soft-deleted (archived_at set) — shown only on demand
  unresolved: number       // queued + sent comments
  updatedAt: string
  createdAt: string
  agent?: AgentRef
  merged?: { sha: string }  // landed — first-checked status, green "Merged · sha7" badge
}

/** A recent-sessions row on the dashboard: a session plus its repo path. */
export interface RecentSession extends SessionListItem { repo: string }
