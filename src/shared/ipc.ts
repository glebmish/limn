import type {
  Artifact, Comment, CommentAnchor, CommitInfo, DiffSkeleton, EngineEvent, EngineId,
  RepoInfo, ReviewState, SessionMeta
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
  /** set when a side's ref no longer resolves — renderer shows re-target banner */
  refMissing?: { side: 'base' | 'compare'; symbol: string }
}

export interface UiStatePatch {
  viewedAt?: Record<string, string>
  reviewedSections?: string[]
  engine?: EngineId
}

export interface Api {
  pickRepo(): Promise<string | null>
  recentRepos(): Promise<string[]>
  openRepo(path: string): Promise<RepoInfo>
  /** Resolve both refs, find-or-create the session for the pair, return its id. */
  startSession(repo: string, baseInput: string, compareInput: string, engine: EngineId): Promise<{ sessionId: number }>
  loadSession(sessionId: number): Promise<LoadedReview>
  archiveSession(sessionId: number): Promise<void>
  generate(sessionId: number, engine: EngineId, opId: string): Promise<void>
  cancel(opId: string): Promise<void>
  saveUiState(sessionId: number, patch: UiStatePatch): Promise<void>
  upsertComment(sessionId: number, comment: Comment): Promise<ReviewState>
  deleteComment(sessionId: number, id: string): Promise<ReviewState>
  chat(sessionId: number, message: string, opId: string, anchor?: CommentAnchor): Promise<void>
  sendFeedback(sessionId: number, commentIds: string[], steer: string | undefined, opId: string): Promise<void>
  approve(sessionId: number): Promise<ReviewState>
  approveArtifact(sessionId: number, artifactPath: string): Promise<ReviewState>
  authStatus(engine: EngineId): Promise<{ ok: boolean; hint: string }>
  getPrefs(): Promise<Record<string, string>>
  setPref(key: string, value: string): Promise<void>
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
}

export const API_CHANNELS: (keyof Api)[] = [
  'pickRepo', 'recentRepos', 'openRepo', 'startSession', 'loadSession', 'archiveSession',
  'generate', 'cancel', 'saveUiState', 'upsertComment', 'deleteComment', 'chat',
  'sendFeedback', 'approve', 'approveArtifact', 'authStatus', 'getPrefs', 'setPref'
]
