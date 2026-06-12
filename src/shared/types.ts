// ── git ground truth ──────────────────────────────────────────
export interface DiffLine { old: number | null; new: number | null; kind: '' | 'add' | 'del'; text: string; since?: boolean; sinceViewed?: boolean }
export interface Hunk { range: string; header: string; lines: DiffLine[]; since?: boolean; sinceViewed?: boolean }
export interface FileDiff { path: string; oldPath?: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; binary: boolean; add: number; del: number; hunks: Hunk[] }
export interface DiffSkeleton { base: string; branch: string; mergeBase: string; headSha: string; files: FileDiff[] }
export interface CommitInfo { sha: string; subject: string; author: string; date: string }

// ── annotations (engine output, validated) ───────────────────
export type DiagramNode = [label: string, kind: '' | 'hi' | 'new', sub: string]
export interface SectionFlag { file: string; hunkRange?: string; risk: boolean; label: string; text: string }
export interface Section {
  id: string; name: string; desc: string; what: string; files: string[]; order: number;
  diagram?: DiagramNode[]; insight?: { caption: string }; flags: SectionFlag[];
  plainNotes?: Record<string, string>;
}
export interface PlanMap {
  acceptance: { text: string; met: boolean | 'partial' }[];
  steps: { n: number; text: string; sectionId: string; status: 'done' | 'changed' | 'missing' }[];
  deviations: { text: string; sectionId: string }[];
}
export interface AgentQuestion { id: string; text: string; context?: string }
export interface ReviewAnnotations {
  title: string; summary: string; sections: Section[];
  planMap?: PlanMap; questions: AgentQuestion[]; artifactPaths?: string[];
}

// ── comments ──────────────────────────────────────────────────
export type CommentAnchor =
  | { kind: 'diff'; file: string; side: 'new' | 'old'; line: number; hunkRange: string; lineContent: string }
  | { kind: 'artifact'; path: string; line: number; lineContent: string }
  | { kind: 'plan-step'; stepN: number }
  | { kind: 'section'; sectionId: string }
  | { kind: 'summary' }
  | { kind: 'file'; file: string }
  | { kind: 'question'; questionId: string }
export interface CommentReply { author: 'user' | 'agent'; text: string; at: string }
export interface Comment {
  id: string; anchor: CommentAnchor; author: 'user'; text: string;
  status: 'queued' | 'sent' | 'resolved' | 'outdated';
  resolution?: { verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string };
  replies: CommentReply[]; createdAt: string; iteration: number;
}

// ── engines ───────────────────────────────────────────────────
export type EngineId = 'claude' | 'codex'
export type EngineEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; text: string }
  | { type: 'text'; text: string }            // streamed assistant text (chat)
  | { type: 'done' }
  | { type: 'error'; message: string }
export interface CommentResolution { commentId: string; verdict: 'addressed' | 'reworked' | 'skipped'; note: string }
export interface FixResult { summary: string; resolutions: CommentResolution[] }

// ── artifacts / chat / state ─────────────────────────────────
export interface Artifact { role: 'spec' | 'plan' | 'doc'; path: string; title: string; lines: string[] }
export interface ChatMessage { role: 'user' | 'agent'; text: string; at: string; anchor?: CommentAnchor }
export interface Iteration { n: number; engine: EngineId; sessionId: string; endSha: string; at: string; summary?: string }
export interface ReviewState {
  repo: string; branch: string; base: string;
  engine?: EngineId; annotations?: ReviewAnnotations;
  comments: Comment[]; chat: ChatMessage[];
  /** per-file: SHA of the branch head when the file was marked viewed */
  viewedAt: Record<string, string>;
  reviewedSections: string[];
  /** whole-branch approval baseline */
  approvedSha?: string; reviewedAtSha?: string;
  /** per-artifact plan/spec approval: path → SHA at approval time */
  artifactApprovals: Record<string, string>;
  iterations: Iteration[]; artifacts: { role: 'spec' | 'plan'; path: string }[];
}
export interface RepoInfo { path: string; branches: string[]; current: string; defaultBase: string }

// ── ref pairs (sessions) ──────────────────────────────────────
export type RefKind = 'branch' | 'commit'
/** One side of a review session. Branch sides follow the tip (anchorSha
 *  records where the tip was at session start, for drift display).
 *  Commit sides are frozen at anchorSha; symbol keeps what the user typed. */
export interface RefSide { kind: RefKind; symbol: string; anchorSha: string }
export interface RefPair { base: RefSide; compare: RefSide }

/** Stable identity for session keying: branches by name, commits by sha. */
export function refIdentity(side: RefSide): string {
  return side.kind === 'branch' ? `b:${side.symbol}` : `c:${side.anchorSha}`
}

/** The git rev to actually diff/log against right now. */
export function effectiveRef(side: RefSide): string {
  return side.kind === 'branch' ? side.symbol : side.anchorSha
}

export interface SessionMeta {
  id: number
  repo: string
  pair: RefPair
  engine?: EngineId
  createdAt: string
  updatedAt: string
}

// ── repo dashboard (pinned directory trees) ───────────────────
export interface RepoStatus { branch: string; dirty: boolean }
export interface PinNode {
  name: string            // basename
  relPath: string         // path relative to the pin root ('' for the root node)
  kind: 'repo' | 'dir'
  empty?: boolean         // dir whose subtree contains no repos (render dimmed, collapsed, childless)
  error?: boolean         // unreadable (permissions) — render dimmed warning row
  children: PinNode[]
}
