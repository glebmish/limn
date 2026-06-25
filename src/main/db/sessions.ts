import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentRef, ChatMessage, ChatThread, Comment, EngineId, ExecutionMode, Iteration, ReasoningEffort,
  RecentSession, RefPair, RefSide, ReviewAnnotations, ReviewState, SessionListItem, SessionMeta, ViewMark
} from '../../shared/types.js'
import { effectiveRef, refIdentity } from '../../shared/types.js'
import { DEFAULT_EXECUTION_MODE, isExecutionMode } from '../../shared/executionMode.js'

function now(): string { return new Date().toISOString() }

/** Build an AgentRef from the denormalized engine/model/effort columns. */
function rowToAgent(engine: EngineId | null, model: string | null, effort: string | null): AgentRef | undefined {
  if (!engine) return undefined
  return {
    engine,
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort as ReasoningEffort } : {})
  }
}

/** A commit side must always carry its resolved sha — '' would collapse all
 *  unresolved commit sides onto one identity ('c:'). */
function assertResolved(side: RefSide): void {
  if (side.kind === 'commit' && !side.anchorSha) {
    throw new Error(`commit side ${side.symbol || '(empty)'} has no resolved sha`)
  }
}

// ── repos ─────────────────────────────────────────────────────
export function ensureRepo(db: DatabaseSync, repoPath: string, firstCommitSha?: string): number {
  db.prepare(`INSERT INTO repos (path, first_commit_sha) VALUES (?, ?)
    ON CONFLICT(path) DO UPDATE SET first_commit_sha = COALESCE(repos.first_commit_sha, excluded.first_commit_sha)`)
    .run(repoPath, firstCommitSha ?? null)
  const row = db.prepare('SELECT id FROM repos WHERE path = ?').get(repoPath) as { id: number }
  return row.id
}

export function touchRepo(db: DatabaseSync, repoPath: string, at = now()): void {
  ensureRepo(db, repoPath)
  db.prepare('UPDATE repos SET last_opened_at = ? WHERE path = ?').run(at, repoPath)
}

export function recentRepoPaths(db: DatabaseSync, limit: number): string[] {
  return (db.prepare(
    'SELECT path FROM repos WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at DESC LIMIT ?'
  ).all(limit) as { path: string }[]).map((r) => r.path)
}

/** Repos that have ≥1 live (non-archived) session — the membership rule for the
 *  dashboard's Level-1 index. Each row carries its live-session count and the most
 *  recent session activity; ordered most-recent first (the index's default sort). */
export function reposWithSessions(db: DatabaseSync): { path: string; sessionCount: number; lastActivity: string }[] {
  return db.prepare(`SELECT r.path AS path, COUNT(*) AS sessionCount, MAX(s.updated_at) AS lastActivity
    FROM repos r JOIN sessions s ON s.repo_id = r.id
    WHERE s.archived_at IS NULL
    GROUP BY r.id
    ORDER BY lastActivity DESC`).all() as { path: string; sessionCount: number; lastActivity: string }[]
}

// ── sessions ──────────────────────────────────────────────────
interface SessionDbRow {
  id: number; repo_id: number
  base_kind: 'branch' | 'commit'; base_symbol: string; base_anchor_sha: string
  compare_kind: 'branch' | 'commit'; compare_symbol: string; compare_anchor_sha: string
  engine: EngineId | null; model: string | null; reasoning_effort: string | null
  title: string | null; summary: string | null
  annotations_json: string | null; approved_sha: string | null; reviewed_at_sha: string | null
  archived_at: string | null
  created_at: string; updated_at: string
  repo_path: string
}

const SESSION_SELECT = `SELECT s.*, r.path AS repo_path FROM sessions s JOIN repos r ON r.id = s.repo_id`

function rowToMeta(row: SessionDbRow): SessionMeta {
  return {
    id: row.id,
    repo: row.repo_path,
    pair: {
      base: { kind: row.base_kind, symbol: row.base_symbol, anchorSha: row.base_anchor_sha },
      compare: { kind: row.compare_kind, symbol: row.compare_symbol, anchorSha: row.compare_anchor_sha }
    },
    engine: row.engine ?? undefined,
    agent: rowToAgent(row.engine, row.model, row.reasoning_effort),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createSession(db: DatabaseSync, repoPath: string, pair: RefPair, agent?: AgentRef): SessionMeta {
  assertResolved(pair.base)
  assertResolved(pair.compare)
  const repoId = ensureRepo(db, repoPath)
  const t = now()
  const res = db.prepare(`INSERT INTO sessions
    (repo_id, base_kind, base_symbol, base_anchor_sha, compare_kind, compare_symbol, compare_anchor_sha,
     engine, model, reasoning_effort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(repoId, pair.base.kind, pair.base.symbol, pair.base.anchorSha,
      pair.compare.kind, pair.compare.symbol, pair.compare.anchorSha,
      agent?.engine ?? null, agent?.model ?? null, agent?.reasoningEffort ?? null, t, t)
  return getSession(db, Number(res.lastInsertRowid))!
}

export function getSession(db: DatabaseSync, id: number): SessionMeta | null {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionDbRow | undefined
  return row ? rowToMeta(row) : null
}

export function findSession(db: DatabaseSync, repoPath: string, pair: RefPair): SessionMeta | null {
  // Multiple sessions may now share a (base, compare) identity — return the most
  // recently touched live one (the "resume hint" for that exact pair).
  const row = db.prepare(`${SESSION_SELECT}
    WHERE r.path = ? AND s.base_ident = ? AND s.compare_ident = ? AND s.archived_at IS NULL
    ORDER BY s.updated_at DESC, s.id DESC LIMIT 1`)
    .get(repoPath, refIdentity(pair.base), refIdentity(pair.compare)) as SessionDbRow | undefined
  return row ? rowToMeta(row) : null
}

/** Sessions for a repo, most-recently-touched first (the repo hub list). Live
 *  only by default; `includeArchived` also returns soft-deleted ones (flagged). */
export function listRepoSessions(db: DatabaseSync, repoPath: string, includeArchived = false): SessionListItem[] {
  const rows = db.prepare(`${SESSION_SELECT}
    WHERE r.path = ?${includeArchived ? '' : ' AND s.archived_at IS NULL'}
    ORDER BY s.updated_at DESC, s.id DESC`)
    .all(repoPath) as unknown as SessionDbRow[]
  return rows.map((row) => toListItem(db, row))
}

/** Restore a soft-deleted session (clear archived_at). */
export function unarchiveSession(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
}

/** The latest live session whose compare side is branch `branch` (any base) —
 *  the auto-jump target when a repo opens on that branch. */
export function latestSessionForBranch(db: DatabaseSync, repoPath: string, branch: string): SessionMeta | null {
  const row = db.prepare(`${SESSION_SELECT}
    WHERE r.path = ? AND s.compare_kind = 'branch' AND s.compare_symbol = ? AND s.archived_at IS NULL
    ORDER BY s.updated_at DESC, s.id DESC LIMIT 1`)
    .get(repoPath, branch) as SessionDbRow | undefined
  return row ? rowToMeta(row) : null
}

/** The most recent live sessions across the given repos (newest first), each
 *  carrying its repo path — the dashboard's session-level "Recent" list. */
export function recentSessions(db: DatabaseSync, repoPaths: string[], limit: number): RecentSession[] {
  if (repoPaths.length === 0) return []
  const ph = repoPaths.map(() => '?').join(',')
  const rows = db.prepare(`${SESSION_SELECT}
    WHERE r.path IN (${ph}) AND s.archived_at IS NULL
    ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`)
    .all(...repoPaths, limit) as unknown as SessionDbRow[]
  return rows.map((row) => ({ ...toListItem(db, row), repo: row.repo_path }))
}

function toListItem(db: DatabaseSync, row: SessionDbRow): SessionListItem {
  const meta = rowToMeta(row)
  return {
    id: row.id,
    baseSymbol: row.base_symbol,
    compareSymbol: row.compare_symbol,
    compareKind: row.compare_kind,
    title: row.title ?? undefined,
    hasReview: Boolean(row.annotations_json),
    approved: Boolean(row.approved_sha) && row.approved_sha === row.reviewed_at_sha,
    archived: Boolean(row.archived_at),
    unresolved: unresolvedCount(db, row.id),
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    agent: meta.agent
  }
}

export function archiveSession(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

export function retargetSession(db: DatabaseSync, id: number, which: 'base' | 'compare', side: RefSide): void {
  assertResolved(side)
  db.prepare(`UPDATE sessions SET ${which}_kind = ?, ${which}_symbol = ?, ${which}_anchor_sha = ?, updated_at = ?
    WHERE id = ?`).run(side.kind, side.symbol, side.anchorSha, now(), id)
}

export interface SessionMetaPatch {
  engine?: EngineId
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  title?: string
  summary?: string
  annotations?: ReviewAnnotations
  approvedSha?: string
  reviewedAtSha?: string
}

export function updateSessionMeta(db: DatabaseSync, id: number, patch: SessionMetaPatch): void {
  const cols: string[] = []
  const vals: unknown[] = []
  if (patch.engine !== undefined) { cols.push('engine = ?'); vals.push(patch.engine) }
  if (patch.model !== undefined) { cols.push('model = ?'); vals.push(patch.model) }
  if (patch.reasoningEffort !== undefined) { cols.push('reasoning_effort = ?'); vals.push(patch.reasoningEffort) }
  if (patch.title !== undefined) { cols.push('title = ?'); vals.push(patch.title) }
  if (patch.summary !== undefined) { cols.push('summary = ?'); vals.push(patch.summary) }
  if (patch.annotations !== undefined) { cols.push('annotations_json = ?'); vals.push(JSON.stringify(patch.annotations)) }
  if (patch.approvedSha !== undefined) { cols.push('approved_sha = ?'); vals.push(patch.approvedSha) }
  if (patch.reviewedAtSha !== undefined) { cols.push('reviewed_at_sha = ?'); vals.push(patch.reviewedAtSha) }
  if (cols.length === 0) return
  cols.push('updated_at = ?'); vals.push(now())
  db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as never[]), id)
}

// ── children ──────────────────────────────────────────────────
export function upsertComment(db: DatabaseSync, sessionId: number, c: Comment): void {
  db.prepare(`INSERT INTO comments (id, session_id, status, json, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET status = excluded.status, json = excluded.json`)
    .run(c.id, sessionId, c.status, JSON.stringify(c), c.createdAt)
}

export function deleteComment(db: DatabaseSync, sessionId: number, id: string): void {
  db.prepare('DELETE FROM comments WHERE session_id = ? AND id = ?').run(sessionId, id)
}

export function unresolvedCount(db: DatabaseSync, sessionId: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM comments WHERE session_id = ? AND status IN ('queued','sent')`
  ).get(sessionId) as { n: number }
  return row.n
}

// ── chat threads ──────────────────────────────────────────────
// (object-type alias, not interface, so node:sqlite's Record row casts cleanly)
type ChatThreadRow = {
  id: number; kind: 'review' | 'user'; engine: EngineId
  model: string | null; reasoning_effort: string | null
  engine_session_id: string | null; title: string | null; created_at: string
  execution_mode: string | null
}

const THREAD_COLS = 'id, kind, engine, model, reasoning_effort, engine_session_id, title, created_at, execution_mode'

function rowToThread(db: DatabaseSync, row: ChatThreadRow): ChatThread {
  const messages = (db.prepare('SELECT role, text, at, anchor_json, actions_json, tools_json, segments_json FROM chat_messages WHERE thread_id = ? ORDER BY id')
    .all(row.id) as { role: 'user' | 'agent'; text: string; at: string; anchor_json: string | null; actions_json: string | null; tools_json: string | null; segments_json: string | null }[])
    .map((r) => ({
      role: r.role, text: r.text, at: r.at,
      ...(r.anchor_json ? { anchor: JSON.parse(r.anchor_json) } : {}),
      ...(r.actions_json ? { actions: JSON.parse(r.actions_json) } : {}),
      ...(r.tools_json ? { tools: JSON.parse(r.tools_json) } : {}),
      ...(r.segments_json ? { segments: JSON.parse(r.segments_json) } : {})
    }))
  return {
    id: row.id,
    kind: row.kind,
    agent: rowToAgent(row.engine, row.model, row.reasoning_effort)!,
    engineSessionId: row.engine_session_id ?? undefined,
    messages,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    executionMode: isExecutionMode(row.execution_mode) ? row.execution_mode : DEFAULT_EXECUTION_MODE
  }
}

export interface NewChatThread { kind: 'review' | 'user'; agent: AgentRef; engineSessionId?: string; title?: string; executionMode?: ExecutionMode }

export function createChatThread(db: DatabaseSync, sessionId: number, t: NewChatThread): ChatThread {
  const res = db.prepare(`INSERT INTO chat_threads
    (session_id, kind, engine, model, reasoning_effort, engine_session_id, title, created_at, execution_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, t.kind, t.agent.engine, t.agent.model ?? null, t.agent.reasoningEffort ?? null,
      t.engineSessionId ?? null, t.title ?? null, now(), t.executionMode ?? DEFAULT_EXECUTION_MODE)
  return getChatThread(db, Number(res.lastInsertRowid))!
}

export function getChatThread(db: DatabaseSync, threadId: number): ChatThread | null {
  const row = db.prepare(`SELECT ${THREAD_COLS} FROM chat_threads WHERE id = ?`).get(threadId) as ChatThreadRow | undefined
  return row ? rowToThread(db, row) : null
}

/** The session a chat thread belongs to (for IPC handlers that take a threadId). */
export function chatThreadSessionId(db: DatabaseSync, threadId: number): number | null {
  const row = db.prepare('SELECT session_id FROM chat_threads WHERE id = ?').get(threadId) as { session_id: number } | undefined
  return row ? row.session_id : null
}

export function listChatThreads(db: DatabaseSync, sessionId: number): ChatThread[] {
  const rows = db.prepare(`SELECT ${THREAD_COLS} FROM chat_threads WHERE session_id = ? ORDER BY id`).all(sessionId) as ChatThreadRow[]
  return rows.map((r) => rowToThread(db, r))
}

export function addChatMessage(db: DatabaseSync, threadId: number, m: ChatMessage): void {
  db.prepare('INSERT INTO chat_messages (thread_id, role, text, at, anchor_json, actions_json, tools_json, segments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(threadId, m.role, m.text, m.at, m.anchor ? JSON.stringify(m.anchor) : null,
      m.actions && m.actions.length ? JSON.stringify(m.actions) : null,
      m.tools && m.tools.length ? JSON.stringify(m.tools) : null,
      m.segments && m.segments.length ? JSON.stringify(m.segments) : null)
}

export function setThreadEngineSession(db: DatabaseSync, threadId: number, engineSessionId: string): void {
  db.prepare('UPDATE chat_threads SET engine_session_id = ? WHERE id = ?').run(engineSessionId, threadId)
}

export function setThreadAgent(db: DatabaseSync, threadId: number, agent: AgentRef): void {
  db.prepare('UPDATE chat_threads SET engine = ?, model = ?, reasoning_effort = ? WHERE id = ?')
    .run(agent.engine, agent.model ?? null, agent.reasoningEffort ?? null, threadId)
}

export function setThreadMode(db: DatabaseSync, threadId: number, mode: ExecutionMode): void {
  db.prepare('UPDATE chat_threads SET execution_mode = ? WHERE id = ?').run(mode, threadId)
}

export function setThreadTitle(db: DatabaseSync, threadId: number, title: string): void {
  db.prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run(title, threadId)
}

/** Derive a chat title from its first user message: the first non-empty line,
 *  trimmed to ~40 chars with an ellipsis when truncated. */
export function deriveChatTitle(message: string): string {
  const MAX = 40
  const firstLine = message.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? message.trim()
  return firstLine.length > MAX ? firstLine.slice(0, MAX).trimEnd() + '…' : firstLine
}

export function deleteChatThread(db: DatabaseSync, threadId: number): void {
  db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId)
}

/** A thread is "empty" when it has no messages and no bound engine session.
 *  The 'review' chat is never empty (it carries the review-generation session),
 *  so changing its agent always forks rather than orphaning the binding. */
export function threadIsEmpty(db: DatabaseSync, threadId: number): boolean {
  const t = getChatThread(db, threadId)
  return Boolean(t) && t!.messages.length === 0 && !t!.engineSessionId
}

/** Remove persisted user chats that never got a first turn (no messages, no bound
 *  engine session) — e.g. legacy "New chat" companions, or a draft whose creation
 *  raced a reload. Reuses `threadIsEmpty`, so a chat with ANY message or an engine
 *  session is always kept. Review threads are left to `pruneOrphanReviewThreads`. */
export function pruneEmptyUserChats(db: DatabaseSync, sessionId: number): void {
  const rows = db.prepare(`SELECT id FROM chat_threads WHERE session_id = ? AND kind = 'user'`)
    .all(sessionId) as { id: number }[]
  for (const r of rows) {
    if (threadIsEmpty(db, r.id)) deleteChatThread(db, r.id)
  }
}

/** Remove review threads orphaned by a hard crash mid-generation: a lone opening
 *  user turn, no bound engine session. A finished review has an agent turn + engine
 *  session; a cancelled/failed one has the outcome note — neither is pruned. Threads
 *  whose op is still in flight (`exempt`) are skipped so mid-op reloads don't drop
 *  the live review. */
export function pruneOrphanReviewThreads(db: DatabaseSync, sessionId: number, exempt: ReadonlySet<number>): void {
  const reviews = db.prepare(`SELECT id, engine_session_id FROM chat_threads WHERE session_id = ? AND kind = 'review' ORDER BY id`)
    .all(sessionId) as { id: number; engine_session_id: string | null }[]
  // never prune the latest review thread — it's the current/in-flight one, which a
  // mid-generation reload would otherwise race to delete. Only older orphans go.
  const latestId = reviews[reviews.length - 1]?.id
  for (const r of reviews) {
    if (r.id === latestId || r.engine_session_id || exempt.has(r.id)) continue
    const count = (db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?').get(r.id) as { n: number }).n
    if (count <= 1) deleteChatThread(db, r.id)
  }
}

export function addIteration(db: DatabaseSync, sessionId: number, it: Iteration): void {
  db.prepare(`INSERT INTO iterations (session_id, n, engine, engine_session_id, end_sha, summary, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, n) DO UPDATE SET engine = excluded.engine,
      engine_session_id = excluded.engine_session_id, end_sha = excluded.end_sha,
      summary = excluded.summary, at = excluded.at`)
    .run(sessionId, it.n, it.engine, it.sessionId, it.endSha, it.summary ?? null, it.at)
}

/** Reset iteration history to a single first iteration (regenerate semantics:
 *  a fresh review starts a fresh agent thread; stale n>1 rows must not survive
 *  or chat/fix would resume the wrong engine session). */
export function resetIterations(db: DatabaseSync, sessionId: number, it: Iteration): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM iterations WHERE session_id = ?').run(sessionId)
    db.prepare(`INSERT INTO iterations (session_id, n, engine, engine_session_id, end_sha, summary, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, it.n, it.engine, it.sessionId, it.endSha, it.summary ?? null, it.at)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no active txn — keep original error */ }
    throw err
  }
}

export function setArtifacts(db: DatabaseSync, sessionId: number, refs: { role: 'spec' | 'plan'; path: string }[]): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId)
    for (const r of refs) {
      db.prepare('INSERT INTO artifacts (session_id, role, path) VALUES (?, ?, ?)').run(sessionId, r.role, r.path)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no active txn — keep original error */ }
    throw err
  }
}

export function approveArtifact(db: DatabaseSync, sessionId: number, path: string, sha: string): void {
  db.prepare(`INSERT INTO artifact_approvals (session_id, path, sha) VALUES (?, ?, ?)
    ON CONFLICT(session_id, path) DO UPDATE SET sha = excluded.sha`).run(sessionId, path, sha)
}

export interface UiStatePatch {
  viewedAt?: Record<string, ViewMark>
  reviewedSections?: string[]
  engine?: EngineId
}

/** Replace-semantics for the renderer's saveUiState patch (matches the old
 *  whole-object JSON write, but transactional and targeted). */
export function replaceUiState(db: DatabaseSync, sessionId: number, patch: UiStatePatch): void {
  db.exec('BEGIN')
  try {
    if (patch.viewedAt !== undefined) {
      db.prepare('DELETE FROM viewed_files WHERE session_id = ?').run(sessionId)
      for (const [file, mark] of Object.entries(patch.viewedAt)) {
        db.prepare('INSERT INTO viewed_files (session_id, file, sha, hash) VALUES (?, ?, ?, ?)').run(sessionId, file, mark.sha, mark.hash)
      }
    }
    if (patch.reviewedSections !== undefined) {
      db.prepare('DELETE FROM reviewed_sections WHERE session_id = ?').run(sessionId)
      for (const s of patch.reviewedSections) {
        db.prepare('INSERT INTO reviewed_sections (session_id, section_id) VALUES (?, ?)').run(sessionId, s)
      }
    }
    if (patch.engine !== undefined) {
      db.prepare('UPDATE sessions SET engine = ? WHERE id = ?').run(patch.engine, sessionId)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no active txn — keep original error */ }
    throw err
  }
}

// ── assembly: DB → ReviewState (IPC shape the renderer already knows) ──
export function loadReviewState(db: DatabaseSync, sessionId: number): ReviewState {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(sessionId) as SessionDbRow | undefined
  if (!row) throw new Error(`session ${sessionId} not found`)
  const meta = rowToMeta(row)

  const comments = (db.prepare('SELECT json FROM comments WHERE session_id = ? ORDER BY created_at, id').all(sessionId) as
    { json: string }[]).map((r) => JSON.parse(r.json) as Comment)

  const chats = listChatThreads(db, sessionId)

  const iterations = (db.prepare(
    'SELECT n, engine, engine_session_id, end_sha, summary, at FROM iterations WHERE session_id = ? ORDER BY n'
  ).all(sessionId) as { n: number; engine: EngineId; engine_session_id: string; end_sha: string; summary: string | null; at: string }[])
    .map((r) => ({ n: r.n, engine: r.engine, sessionId: r.engine_session_id, endSha: r.end_sha, at: r.at, ...(r.summary ? { summary: r.summary } : {}) }))

  const viewedAt: Record<string, ViewMark> = {}
  for (const r of db.prepare('SELECT file, sha, hash FROM viewed_files WHERE session_id = ?').all(sessionId) as { file: string; sha: string; hash: string }[]) {
    viewedAt[r.file] = { sha: r.sha, hash: r.hash }
  }

  const reviewedSections = (db.prepare('SELECT section_id FROM reviewed_sections WHERE session_id = ?')
    .all(sessionId) as { section_id: string }[]).map((r) => r.section_id)

  const artifacts = db.prepare('SELECT role, path FROM artifacts WHERE session_id = ?')
    .all(sessionId) as { role: 'spec' | 'plan'; path: string }[]

  const artifactApprovals: Record<string, string> = {}
  for (const r of db.prepare('SELECT path, sha FROM artifact_approvals WHERE session_id = ?').all(sessionId) as { path: string; sha: string }[]) {
    artifactApprovals[r.path] = r.sha
  }

  return {
    repo: meta.repo,
    branch: effectiveRef(meta.pair.compare),
    base: effectiveRef(meta.pair.base),
    engine: meta.engine,
    agent: meta.agent,
    annotations: row.annotations_json ? (JSON.parse(row.annotations_json) as ReviewAnnotations) : undefined,
    comments, chats, viewedAt, reviewedSections,
    approvedSha: row.approved_sha ?? undefined,
    reviewedAtSha: row.reviewed_at_sha ?? undefined,
    artifactApprovals, iterations, artifacts
  }
}
