import type {
  AgentRef, AgentWriteCapability, ApprovalDecision, Artifact, ChatThread, Comment, CommentAnchor, CommitInfo, DiffSkeleton, DriftSummary, EngineEvent, EngineId,
  ExecutionMode, FileDiff, RecentSession, RefLoc, RepoIndexEntry, RepoInfo, RepoState, ReviewCopyCandidate, ReviewState, SessionListItem, SessionMeta, ViewMark
} from './types.js'

export interface LoadedReview {
  sessionId: number
  session: SessionMeta
  /** human context lines (describeSide) for the compare bar / review header */
  baseContext: string
  compareContext: string
  /** structured locators for the header ref chips ("branch ~n sha") */
  baseLoc: RefLoc
  compareLoc: RefLoc
  skeleton: DiffSkeleton
  /** Hash of the loaded branch surface. Clean tree: head SHA. Dirty tree: head SHA
   *  plus uncommitted working-tree content/status. Used for branch approval freshness. */
  branchHash: string
  state: ReviewState
  artifacts: Artifact[]
  commits: CommitInfo[]
  sinceTagged: boolean
  /** the working tree is dirty AND checked out on the compare branch — the
   *  volatile band (HEAD → working tree) below applies. */
  dirty: boolean
  /** uncommitted changes (HEAD → working tree), shown as the volatile band.
   *  Empty unless `dirty`. These lines carry no SHA; comments on them re-anchor
   *  by content and auto-pin once committed (they migrate into `skeleton`). */
  volatile: FileDiff[]
  /** base→working-tree diff with each line attributed to the committed delta or the
   *  uncommitted delta (`DiffLine.origin`). Present only when `dirty`. The renderer
   *  shows this in place of `skeleton.files` + the volatile band so committed and
   *  uncommitted changes interleave per file; `skeleton`/`volatile` stay canonical
   *  for anchoring, viewed, and approval (all of which pin to commits). */
  merged?: FileDiff[]
  /** Authoritative main-process verdict for agent edits on this review surface. */
  writeCapability: AgentWriteCapability
  /** set when a side's ref no longer resolves — renderer shows re-target banner */
  refMissing?: { side: 'base' | 'compare'; symbol: string }
  /** Generated reviews from other sessions whose endpoint pair can seed this review. */
  copyCandidates?: ReviewCopyCandidate[]
}

export interface DashboardData { repos: RepoIndexEntry[]; recents: string[]; recentSessions: RecentSession[]; notices: string[] }
export interface RefOptions { branches: string[]; defaultBase: string; commits: CommitInfo[] }  // commits = last 50 reachable from relativeTo
export interface CliOpenMsg { repo?: string; baseInput?: string; compareInput?: string; hub?: boolean; fresh?: boolean; error?: string }

export interface UiStatePatch {
  viewedAt?: Record<string, ViewMark>
  reviewedSections?: string[]
  fileExcluded?: Record<string, boolean>
  engine?: EngineId
}

export interface Api {
  pickRepo(): Promise<string | null>
  recentRepos(): Promise<string[]>
  openRepo(path: string): Promise<RepoInfo>
  /** Live git state (branches, current branch, worktrees, dirtiness). */
  repoState(repo: string): Promise<RepoState>
  /** Sessions for a repo, latest first. Live only unless `includeArchived`. */
  listRepoSessions(repo: string, includeArchived?: boolean): Promise<SessionListItem[]>
  /** Restore a soft-deleted (archived) session. */
  unarchiveSession(sessionId: number): Promise<void>
  /** Check out `branch` in the repo's primary worktree. Rejects on a dirty tree. */
  switchBranch(repo: string, branch: string): Promise<RepoState>
  /** Check out `branch` into a specific worktree dir (primary repo or a linked
   *  worktree). Rejects if that worktree is dirty. Returns fresh repo state. */
  checkoutInto(repo: string, worktreePath: string, branch: string): Promise<RepoState>
  /** Create a new linked worktree for `branch` at `<repo>/.worktrees/<name>` (name
   *  defaults to the branch name on the renderer side). Returns fresh repo state. */
  addWorktreeFor(repo: string, branch: string, name: string): Promise<RepoState>
  /** Resolve both refs, return the session id. `fresh` forces a new session even
   *  when one already exists for the exact pair (the hub's "New review"). */
  startSession(repo: string, baseInput: string, compareInput: string, agent: AgentRef, fresh?: boolean): Promise<{ sessionId: number }>
  /** Resolve both refs and return the live session for that exact identity, if any. */
  findSession(repo: string, baseInput: string, compareInput: string): Promise<{ sessionId: number } | null>
  /** Build a review for a ref pair without minting a session (the default entry).
   *  The renderer holds it transiently and persists on first write. Throws on an
   *  unresolvable ref. */
  previewReview(repo: string, baseInput: string, compareInput: string, agent: AgentRef): Promise<LoadedReview>
  loadSession(sessionId: number): Promise<LoadedReview>
  archiveSession(sessionId: number): Promise<void>
  /** `steer` is an optional reviewer note that focuses this generation pass
   *  (e.g. "go deeper on error handling"). One-shot — not persisted. */
  /** Generate (or, with `update`, fold new drift commits into) the review on this
   *  session in place. `update` passes the existing narration to the agent so it
   *  revises rather than re-narrates from scratch. */
  /** Create or reuse the review thread before generation runs, so the review agent
   *  is a persisted chat from the first moment. `update` appends to the latest
   *  review thread; fresh generation starts a new review thread. */
  beginReview(sessionId: number, agent: AgentRef, update?: boolean, steer?: string): Promise<number>
  generate(sessionId: number, agent: AgentRef, opId: string, reviewThreadId: number, steer?: string, update?: boolean): Promise<void>
  cancel(opId: string): Promise<void>
  copyReviewFrom(sourceSessionId: number, sourceIteration: number, targetSessionId: number): Promise<ReviewState>
  /** Answer a pending approval request (routes to the parked engine-side promise). */
  respondApproval(opId: string, requestId: string, decision: ApprovalDecision): Promise<void>
  saveUiState(sessionId: number, patch: UiStatePatch): Promise<void>
  upsertComment(sessionId: number, comment: Comment): Promise<ReviewState>
  deleteComment(sessionId: number, id: string): Promise<ReviewState>
  // ── multi-chat ──
  /** Send a message in a chat thread; the thread carries its own agent. */
  sendChat(threadId: number, message: string, opId: string, anchor?: CommentAnchor): Promise<void>
  createChat(sessionId: number, agent: AgentRef, executionMode?: ExecutionMode): Promise<ChatThread[]>
  setChatAgent(threadId: number, agent: AgentRef): Promise<ChatThread[]>
  /** Set the per-chat execution mode (approvals ladder tier). */
  setChatMode(threadId: number, mode: ExecutionMode): Promise<ChatThread[]>
  /** Persist a reviewer's dismissal of a suggest-mark-viewed card so it stays
   *  resolved across chat re-entry. Returns the refreshed thread list. */
  dismissSuggestion(threadId: number, actionId: string): Promise<ChatThread[]>
  deleteChat(threadId: number): Promise<ChatThread[]>
  /** The unified batch turn: send queued comments to a chat thread's agent, which
   *  handles them with its tools (edit+commit code, resolve, or reply). */
  sendBatch(threadId: number, commentIds: string[], steer: string | undefined, opId: string, refine?: boolean): Promise<void>
  approve(sessionId: number): Promise<ReviewState>
  unapprove(sessionId: number): Promise<ReviewState>
  approveArtifact(sessionId: number, artifactPath: string): Promise<ReviewState>
  unapproveArtifact(sessionId: number, artifactPath: string): Promise<ReviewState>
  authStatus(engine: EngineId): Promise<{ ok: boolean; hint: string }>
  getPrefs(): Promise<Record<string, string>>
  setPref(key: string, value: string): Promise<void>
  dashboard(): Promise<DashboardData>
  refOptions(repo: string, relativeTo: string): Promise<RefOptions>
  retargetSession(sessionId: number, side: 'base' | 'compare', refInput: string): Promise<void>
  installCli(): Promise<{ ok: boolean; message: string }>
  takeCliOpen(): Promise<CliOpenMsg | null>
}

export interface OpEventMsg { opId: string; event: EngineEvent }
export type OperationStatus = 'succeeded' | 'cancelled' | 'failed'
export interface OpResultMsg {
  opId: string
  kind: 'review' | 'chat'
  status: OperationStatus
  error?: string
  reload?: boolean
}

export interface RepoChangedMsg {
  repo: string
  branch: string
  headSha: string
  drift: DriftSummary | null
  writeCapability: AgentWriteCapability
}

export interface RendererApi extends Api {
  onOpEvent(cb: (msg: OpEventMsg) => void): () => void
  onOpResult(cb: (msg: OpResultMsg) => void): () => void
  onRepoChanged(cb: (msg: RepoChangedMsg) => void): () => void
  onCliOpen(cb: (msg: CliOpenMsg) => void): () => void
  onSettingsOpen(cb: () => void): () => void
}

export const API_CHANNELS: (keyof Api)[] = [
  'pickRepo', 'recentRepos', 'openRepo', 'repoState', 'listRepoSessions', 'unarchiveSession', 'switchBranch',
  'checkoutInto', 'addWorktreeFor',
  'startSession', 'findSession', 'previewReview', 'loadSession', 'archiveSession',
  'beginReview', 'generate', 'cancel', 'copyReviewFrom', 'respondApproval', 'saveUiState', 'upsertComment', 'deleteComment',
  'sendChat', 'createChat', 'setChatAgent', 'setChatMode', 'dismissSuggestion', 'deleteChat',
  'sendBatch', 'approve', 'unapprove', 'approveArtifact', 'unapproveArtifact', 'authStatus', 'getPrefs', 'setPref',
  'dashboard',
  'refOptions', 'retargetSession', 'installCli', 'takeCliOpen'
]
