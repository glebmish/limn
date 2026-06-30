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
  /** Real git-diff hunks from this file's viewed sha → current surface ("Since viewed"). */
  sinceViewedHunks?: Hunk[] }
/** A "viewed" snapshot: the compare head sha + the file's content hash at view time. */
export interface ViewMark { sha: string; hash: string }
export interface DiffSkeleton { base: string; branch: string; mergeBase: string; headSha: string; files: FileDiff[] }
export interface CommitInfo { sha: string; subject: string; author: string; date: string }
/** What landed on the compare branch since the loaded review snapshot: new commits
 *  plus the file/line delta (committed + uncommitted) since the loaded SHA, and
 *  whether the worktree currently carries uncommitted edits. Backs the titlebar
 *  "since you reviewed" fetch pill (commit chip + working-tree-edit chip). */
export interface DriftSummary { headSha: string; commits: number; files: number; add: number; del: number; dirty: boolean }

/** Main-process verdict on whether an agent may edit the compare branch. */
export interface AgentWriteCapability {
  enabled: boolean
  reason: 'available' | 'not-branch' | 'not-checked-out' | 'dirty'
  branch: string | null
  workdir: string | null
}

export function driftHasChanges(drift: DriftSummary | null | undefined): drift is DriftSummary {
  return Boolean(drift && (drift.commits > 0 || drift.files > 0 || drift.dirty))
}

// ── annotations (engine output, validated) ───────────────────
export type DiagramNode = [label: string, kind: '' | 'hi' | 'new', sub: string]
export interface Section {
  id: string; name: string; desc: string; what: string; files: string[]; order: number;
  diagram?: DiagramNode[]; insight?: { caption: string };
  plainNotes?: Record<string, string>;
}
export interface PlanMap {
  acceptance: { text: string; met: boolean | 'partial' }[];
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
export type CommentAnchor =
  | { kind: 'diff'; file: string; side: 'new' | 'old'; line: number; hunkRange: string; lineContent: string }
  | { kind: 'artifact'; path: string; line: number; lineContent: string }
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
export interface CommentReply { author: 'user' | 'agent'; text: string; at: string; agentRef?: AgentRef; threadId?: number }
export interface Comment {
  id: string; anchor: CommentAnchor; author: 'user' | 'agent'; text: string;
  /** agent-authored comments/replies carry which agent + which chat thread, for
   *  the identity chip + click-through (JSON blob — no column migration). */
  agentRef?: AgentRef; threadId?: number;
  status: 'queued' | 'sent' | 'resolved' | 'outdated';
  resolution?: { verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string; agentRef?: AgentRef };
  replies: CommentReply[]; createdAt: string; iteration: number;
}

// ── agent tool actions ────────────────────────────────────────
/** The reviewable spots a `focus` tool call can scroll+highlight. A subset of
 *  CommentAnchor (no parallel type) so a focus chip and a comment chip share the
 *  same `focusAnchor` renderer. */
export type FocusTarget = Extract<CommentAnchor, { kind: 'summary' } | { kind: 'section' } | { kind: 'file' } | { kind: 'diff' }>
export interface TourStop { target: FocusTarget; note?: string }
/** A side effect (or suggestion) an agent performed during a chat turn. Emitted
 *  live as an `EngineEvent` and persisted on the agent ChatMessage so chips rebuild
 *  on reload. */
export type AgentAction =
  | { kind: 'focus'; anchor: FocusTarget }
  | { kind: 'tour'; stops: TourStop[]; loop?: boolean }
  // `id` addresses this action for the dismiss-persist path; `resolution` records
  // only an explicit dismissal — the "marked" outcome is derived from real viewedAt
  // marks on reload, so it is never persisted here.
  | { kind: 'suggest_viewed'; id?: string; files?: string[]; sectionIds?: string[]; note?: string; resolution?: 'dismissed' }
  | { kind: 'comment_added'; comment: Comment }
  | { kind: 'comment_replied'; commentId: string; anchor: CommentAnchor; reply: CommentReply }
  | { kind: 'comment_resolved'; commentId: string; anchor: CommentAnchor; verdict: 'addressed' | 'reworked' | 'skipped'; note: string }
  | { kind: 'review_edited'; field: 'title' | 'summary' | 'section.what' | 'section.desc'; sectionId?: string }

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
 *  engines; `executionPolicy(mode)` maps it to each engine's permission mode +
 *  sandbox. Persisted on the chat thread; defaults to 'ask'. */
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
    toolName?: string
    reason?: string
    [k: string]: unknown
  }
  risk?: 'low' | 'medium' | 'high'   // engine-supplied hint (Codex guardian) if available
}
/** Per-operation only — no "approve for session". */
export type ApprovalDecision = 'allow' | 'deny'

export type EngineEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; call: ToolCall }          // structured tool-call lifecycle (wf-D)
  | { type: 'text'; text: string }            // streamed assistant text (chat)
  | { type: 'action'; action: AgentAction }   // agent tool call (focus, suggest, …)
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
 *  not grouped. Built by `reduceSegments`; `text`/`tools` stay for back-compat. */
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
export interface Iteration { n: number; engine: EngineId; sessionId: string; endSha: string; at: string; summary?: string; title: string; annotations: ReviewAnnotations }
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
}

/** A recent-sessions row on the dashboard: a session plus its repo path. */
export interface RecentSession extends SessionListItem { repo: string }
