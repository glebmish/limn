import type {
  AgentRef, ApprovalDecision, Artifact, ChatThread, Comment, CommentAnchor, CommitInfo, DiffSkeleton, EngineEvent, EngineId,
  ExecutionMode, FileDiff, PinNode, RepoInfo, RepoState, RepoStatus, ReviewState, SessionListItem, SessionMeta
} from './types.js'

export interface LoadedReview {
  sessionId: number
  session: SessionMeta
  /** human context lines (describeSide) for the compare bar / review header */
  baseContext: string
  compareContext: string
  skeleton: DiffSkeleton
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
  /** the compare branch is checked out in some worktree (primary or linked), so
   *  agent edits have a safe place to land. False when checked out nowhere — the
   *  renderer blocks submissions and offers the checkout flow. Always false for a
   *  non-branch compare (a SHA/tag range is inherently review-only). */
  compareCheckedOut: boolean
  /** set when a side's ref no longer resolves — renderer shows re-target banner */
  refMissing?: { side: 'base' | 'compare'; symbol: string }
}

export interface PinData { id: number; path: string; tree: PinNode | null; scannedAt: string | null; repoCount: number }
export interface DashboardData { pins: PinData[]; recents: string[]; notices: string[] }
export interface RefOptions { branches: string[]; defaultBase: string; commits: CommitInfo[] }  // commits = last 50 reachable from relativeTo
export interface CliOpenMsg { repo?: string; baseInput?: string; compareInput?: string; hub?: boolean; fresh?: boolean; error?: string }

export interface UiStatePatch {
  viewedAt?: Record<string, string>
  reviewedSections?: string[]
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
  /** Build a review for a ref pair without minting a session (the default entry).
   *  The renderer holds it transiently and persists on first write. Throws on an
   *  unresolvable ref. */
  previewReview(repo: string, baseInput: string, compareInput: string, agent: AgentRef): Promise<LoadedReview>
  loadSession(sessionId: number): Promise<LoadedReview>
  archiveSession(sessionId: number): Promise<void>
  generate(sessionId: number, agent: AgentRef, opId: string): Promise<void>
  cancel(opId: string): Promise<void>
  /** Answer a pending approval request (routes to the parked engine-side promise). */
  respondApproval(opId: string, requestId: string, decision: ApprovalDecision): Promise<void>
  saveUiState(sessionId: number, patch: UiStatePatch): Promise<void>
  upsertComment(sessionId: number, comment: Comment): Promise<ReviewState>
  deleteComment(sessionId: number, id: string): Promise<ReviewState>
  // ── multi-chat ──
  /** Send a message in a chat thread; the thread carries its own agent. */
  sendChat(threadId: number, message: string, opId: string, anchor?: CommentAnchor): Promise<void>
  createChat(sessionId: number, agent: AgentRef): Promise<ChatThread[]>
  setChatAgent(threadId: number, agent: AgentRef): Promise<ChatThread[]>
  /** Set the per-chat execution mode (approvals ladder tier). */
  setChatMode(threadId: number, mode: ExecutionMode): Promise<ChatThread[]>
  deleteChat(threadId: number): Promise<ChatThread[]>
  /** The unified batch turn: send queued comments to a chat thread's agent, which
   *  handles them with its tools (edit+commit code, resolve, or reply). */
  sendBatch(threadId: number, commentIds: string[], steer: string | undefined, opId: string): Promise<void>
  approve(sessionId: number): Promise<ReviewState>
  approveArtifact(sessionId: number, artifactPath: string): Promise<ReviewState>
  authStatus(engine: EngineId): Promise<{ ok: boolean; hint: string }>
  getPrefs(): Promise<Record<string, string>>
  setPref(key: string, value: string): Promise<void>
  dashboard(): Promise<DashboardData>
  addPin(path: string): Promise<DashboardData>
  removePin(id: number): Promise<DashboardData>
  rescanPin(id: number): Promise<DashboardData>
  repoStatus(repoPaths: string[]): Promise<Record<string, RepoStatus>>
  refOptions(repo: string, relativeTo: string): Promise<RefOptions>
  retargetSession(sessionId: number, side: 'base' | 'compare', refInput: string): Promise<void>
  installCli(): Promise<{ ok: boolean; message: string }>
  takeCliOpen(): Promise<CliOpenMsg | null>
}

export interface OpEventMsg { opId: string; event: EngineEvent }
export interface OpResultMsg {
  opId: string
  kind: 'review' | 'chat' | 'fix'
  ok: boolean
  error?: string
  reload?: boolean
}

export interface RepoChangedMsg { repo: string; branch: string; headSha: string }

export interface RendererApi extends Api {
  onOpEvent(cb: (msg: OpEventMsg) => void): () => void
  onOpResult(cb: (msg: OpResultMsg) => void): () => void
  onRepoChanged(cb: (msg: RepoChangedMsg) => void): () => void
  onCliOpen(cb: (msg: CliOpenMsg) => void): () => void
}

export const API_CHANNELS: (keyof Api)[] = [
  'pickRepo', 'recentRepos', 'openRepo', 'repoState', 'listRepoSessions', 'unarchiveSession', 'switchBranch',
  'checkoutInto', 'addWorktreeFor',
  'startSession', 'previewReview', 'loadSession', 'archiveSession',
  'generate', 'cancel', 'respondApproval', 'saveUiState', 'upsertComment', 'deleteComment',
  'sendChat', 'createChat', 'setChatAgent', 'setChatMode', 'deleteChat',
  'sendBatch', 'approve', 'approveArtifact', 'authStatus', 'getPrefs', 'setPref',
  'dashboard', 'addPin', 'removePin', 'rescanPin', 'repoStatus',
  'refOptions', 'retargetSession', 'installCli', 'takeCliOpen'
]
