import type {
  Artifact, Comment, CommentAnchor, CommitInfo, DiffSkeleton, EngineEvent, EngineId, RepoInfo, ReviewState
} from './types.js'

export interface LoadedReview {
  skeleton: DiffSkeleton
  state: ReviewState
  artifacts: Artifact[]
  commits: CommitInfo[]
  sinceTagged: boolean
}

export interface Api {
  pickRepo(): Promise<string | null>
  recentRepos(): Promise<string[]>
  openRepo(path: string): Promise<RepoInfo>
  loadReview(repo: string, branch: string, base: string): Promise<LoadedReview>
  generate(repo: string, branch: string, base: string, engine: EngineId, opId: string): Promise<void>
  cancel(opId: string): Promise<void>
  saveUiState(repo: string, branch: string, base: string, patch: Partial<Pick<ReviewState, 'viewedAt' | 'reviewedSections' | 'engine'>>): Promise<void>
  upsertComment(repo: string, branch: string, base: string, comment: Comment): Promise<ReviewState>
  deleteComment(repo: string, branch: string, base: string, id: string): Promise<ReviewState>
  chat(repo: string, branch: string, base: string, message: string, opId: string, anchor?: CommentAnchor): Promise<void>
  sendFeedback(repo: string, branch: string, base: string, commentIds: string[], steer: string | undefined, opId: string): Promise<void>
  approve(repo: string, branch: string, base: string): Promise<ReviewState>
  approveArtifact(repo: string, branch: string, base: string, artifactPath: string): Promise<ReviewState>
  authStatus(engine: EngineId): Promise<{ ok: boolean; hint: string }>
}

export interface OpEventMsg { opId: string; event: EngineEvent }
export interface OpResultMsg {
  opId: string
  kind: 'review' | 'chat' | 'fix'
  ok: boolean
  error?: string
  reload?: boolean
}

export interface RendererApi extends Api {
  onOpEvent(cb: (msg: OpEventMsg) => void): () => void
  onOpResult(cb: (msg: OpResultMsg) => void): () => void
}

export const API_CHANNELS: (keyof Api)[] = [
  'pickRepo', 'recentRepos', 'openRepo', 'loadReview', 'generate', 'cancel', 'saveUiState',
  'upsertComment', 'deleteComment', 'chat', 'sendFeedback', 'approve', 'approveArtifact', 'authStatus'
]
