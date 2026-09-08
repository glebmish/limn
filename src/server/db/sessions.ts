import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentAction, AgentRef, ChatMessage, ChatThread, Comment, CommentAnchor, EngineId, ExecutionMode, Iteration, IterationMeta,
  MergeRecord, MessageSegment, ReasoningEffort, RecentSession, RefPair, RefSide, ReviewAnnotations, ReviewCopyCandidate,
  ReviewState, SessionListItem, SessionMeta, ToolCall, ViewMark
} from '../../shared/types.js'
import { approvalFresh, effectiveRef, refIdentity } from '../../shared/types.js'
// the saveUiState patch shape is the IPC contract itself — this layer persists it,
// so it must never carry a second, silently divergent copy of the interface.
import type { UiStatePatch } from '../../shared/ipc.js'
import { normalizeStack, parseStack } from '../../shared/diffStack.js'
import { DEFAULT_EXECUTION_MODE, isExecutionMode, LEGACY_EXECUTION_MODE } from '../../shared/executionMode.js'
import { inTx } from './db.js'

function now(): string { return new Date().toISOString() }

type LoadWarningKind = 'annotations' | 'chat' | 'comment' | 'iteration' | 'merge'
type LoadWarningSink = { kind: LoadWarningKind; into: LoadWarningKind[] }

/** Parse a persisted JSON blob; on failure record a warning and return undefined
 *  (the caller drops the field or skips the row — never the whole session). */
function safeJson<T>(raw: string | null, loadWarning?: LoadWarningSink): T | undefined {
  if (raw === null) return undefined
  try { return JSON.parse(raw) as T } catch {
    if (loadWarning) loadWarning.into.push(loadWarning.kind)
    return undefined
  }
}

/** Fold the raw per-blob failure warnings collected during a load into human-readable
 *  summaries for the renderer's error strip. Returns [] when nothing degraded. */
function summarizeLoadWarnings(warnings: LoadWarningKind[]): string[] {
  const out: string[] = []
  const comments = warnings.filter((w) => w === 'comment').length
  if (comments) out.push(`${comments} comment(s) could not be loaded`)
  if (warnings.includes('annotations')) out.push('review annotations could not be loaded — regenerate to restore')
  const chat = warnings.filter((w) => w === 'chat').length
  if (chat) out.push(`${chat} chat message field(s) could not be loaded`)
  const iterations = warnings.filter((w) => w === 'iteration').length
  if (iterations) out.push(`${iterations} past review iteration(s) could not be loaded`)
  if (warnings.includes('merge')) out.push('merge record could not be loaded')
  return out
}

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

/** Drop a repo from the dashboard index without losing anything: archive its live
 *  sessions and clear `last_opened_at`, the two things `repoIndexRows` selects on.
 *  Returns how many sessions were archived. The repo row, its reviews and their
 *  history stay put — opening the repo again brings it back, with those reviews
 *  under the hub's "Show archived". */
export function forgetRepo(db: DatabaseSync, repoPath: string, at = now()): number {
  return inTx(db, () => {
    const archived = db.prepare(`UPDATE sessions SET archived_at = ?, updated_at = ?
      WHERE archived_at IS NULL AND repo_id = (SELECT id FROM repos WHERE path = ?)`)
      .run(at, at, repoPath)
    db.prepare('UPDATE repos SET last_opened_at = NULL WHERE path = ?').run(repoPath)
    return Number(archived.changes)
  })
}

/** Repos shown in the dashboard's Level-1 index. A repo enters the index either
 *  by being opened (last_opened_at) or by having at least one live session. The
 *  activity timestamp is whichever is newer: latest live-session update or latest
 *  repo open. */
export function repoIndexRows(db: DatabaseSync): { path: string; sessionCount: number; lastActivity: string }[] {
  return db.prepare(`WITH live AS (
      SELECT repo_id, COUNT(*) AS session_count, MAX(updated_at) AS session_activity
      FROM sessions
      WHERE archived_at IS NULL
      GROUP BY repo_id
    )
    SELECT r.path AS path,
      COALESCE(live.session_count, 0) AS sessionCount,
      CASE
        WHEN live.session_activity IS NULL THEN r.last_opened_at
        WHEN r.last_opened_at IS NULL THEN live.session_activity
        WHEN r.last_opened_at > live.session_activity THEN r.last_opened_at
        ELSE live.session_activity
      END AS lastActivity
    FROM repos r LEFT JOIN live ON live.repo_id = r.id
    WHERE r.last_opened_at IS NOT NULL OR COALESCE(live.session_count, 0) > 0
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
  merged_at: string | null; merge_json: string | null
  diff_stack: string | null
  created_at: string; updated_at: string
  repo_path: string
}

const SESSION_SELECT = `SELECT s.*, r.path AS repo_path FROM sessions s JOIN repos r ON r.id = s.repo_id`

function sessionApprovals(db: DatabaseSync, sessionId: number): { shas: string[]; hashes: string[] } {
  const rows = db.prepare('SELECT sha, hash FROM session_approvals WHERE session_id = ?').all(sessionId) as { sha: string; hash: string }[]
  return { shas: [...new Set(rows.map((r) => r.sha))], hashes: rows.map((r) => r.hash) }
}

function rowToMeta(row: SessionDbRow): SessionMeta {
  return {
    id: row.id,
    repo: row.repo_path,
    pair: {
      base: { kind: row.base_kind, symbol: row.base_symbol, anchorSha: row.base_anchor_sha },
      compare: { kind: row.compare_kind, symbol: row.compare_symbol, anchorSha: row.compare_anchor_sha }
    },
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
  // recently touched live one. Base identity is the resolved anchor SHA, even for
  // branch refs, because a session's base is immutable once generated.
  const row = db.prepare(`${SESSION_SELECT}
    WHERE r.path = ? AND s.base_anchor_sha = ? AND s.compare_ident = ? AND s.archived_at IS NULL
    ORDER BY s.updated_at DESC, s.id DESC LIMIT 1`)
    .get(repoPath, pair.base.anchorSha, refIdentity(pair.compare)) as SessionDbRow | undefined
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
  const approvals = sessionApprovals(db, row.id)
  // merged_at is authoritative for the badge; a corrupt blob degrades to sha ''
  const mergeRecord = row.merged_at ? safeJson<MergeRecord>(row.merge_json) : undefined
  return {
    id: row.id,
    baseSymbol: row.base_symbol,
    compareSymbol: row.compare_symbol,
    compareKind: row.compare_kind,
    title: row.title ?? undefined,
    hasReview: Boolean(row.annotations_json),
    ...(row.merged_at ? { merged: { sha: mergeRecord?.mergedSha ?? '' } } : {}),
    approved: approvalFresh(approvals.hashes, row.reviewed_at_sha ?? undefined),
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
  if (which === 'base') throw new Error('Session base cannot be changed')
  assertResolved(side)
  db.prepare(`UPDATE sessions SET ${which}_kind = ?, ${which}_symbol = ?, ${which}_anchor_sha = ?, updated_at = ?
    WHERE id = ?`).run(side.kind, side.symbol, side.anchorSha, now(), id)
}

/** Stamp the terminal merge record (spec merge-into-main §2). merged_at mirrors the
 *  record's own timestamp; the blob is the single source of truth. One UPDATE —
 *  atomic on its own and composable inside the merge op's wider transaction
 *  (markSessionMerged + compare retarget commit together, spec §4 step 3). */
export function markSessionMerged(db: DatabaseSync, sessionId: number, record: MergeRecord): void {
  db.prepare('UPDATE sessions SET merged_at = ?, merge_json = ?, updated_at = ? WHERE id = ?')
    .run(record.mergedAt, JSON.stringify(record), now(), sessionId)
}

/** The ONLY writer allowed to change a session base — the dependent-review retarget
 *  after its branch was rebased onto the new base head (spec §6b step 4). The public
 *  retargetSession keeps throwing for 'base'; base immutability stays the rule and
 *  this is its one audited exception. findSession pins base identity by
 *  base_anchor_sha, so after this the session resolves under the new anchor only. */
export function retargetSessionBase(db: DatabaseSync, sessionId: number, base: RefSide): void {
  assertResolved(base)
  db.prepare(`UPDATE sessions SET base_kind = ?, base_symbol = ?, base_anchor_sha = ?, updated_at = ?
    WHERE id = ?`).run(base.kind, base.symbol, base.anchorSha, now(), sessionId)
}

/** Live stacked reviews whose base is the branch about to be merged away: not
 *  archived, not merged, branch-kind base matching `branch`, branch-kind compare
 *  (a commit-kind compare has nothing to rebase). Feeds the merge sheet's
 *  "Retarget dependent review" rows (spec §3) and the §4 branch-delete guard. */
export function dependentSessions(db: DatabaseSync, repoPath: string, branch: string): { sessionId: number; branch: string }[] {
  return db.prepare(`SELECT s.id AS sessionId, s.compare_symbol AS branch
    FROM sessions s JOIN repos r ON r.id = s.repo_id
    WHERE r.path = ? AND s.archived_at IS NULL AND s.merged_at IS NULL
      AND s.base_kind = 'branch' AND s.base_symbol = ?
      AND s.compare_kind = 'branch'
    ORDER BY s.updated_at DESC, s.id DESC`).all(repoPath, branch) as { sessionId: number; branch: string }[]
}

/** Live sessions whose base is branch `branch` — ANY compare kind (unlike
 *  `dependentSessions`, commit-kind compares count too: they can't be retargeted,
 *  but they still depend on the branch ref existing). Feeds the merge sheet's §4
 *  branch-delete guard — deleting the branch out from under one of these would
 *  degrade it to refMissing. `branch` here is the compare_symbol, which for a
 *  commit-kind compare is a display symbol/sha, not necessarily a branch name. */
export function sessionsBasedOn(db: DatabaseSync, repoPath: string, branch: string): { sessionId: number; branch: string }[] {
  return db.prepare(`SELECT s.id AS sessionId, s.compare_symbol AS branch
    FROM sessions s JOIN repos r ON r.id = s.repo_id
    WHERE r.path = ? AND s.archived_at IS NULL AND s.merged_at IS NULL
      AND s.base_kind = 'branch' AND s.base_symbol = ?
    ORDER BY s.updated_at DESC, s.id DESC`).all(repoPath, branch) as { sessionId: number; branch: string }[]
}

export interface SessionMetaPatch {
  engine?: EngineId
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  annotations?: ReviewAnnotations
  approvedSha?: string | null
  reviewedAtSha?: string | null
}

export function updateSessionMeta(db: DatabaseSync, id: number, patch: SessionMetaPatch): void {
  const cols: string[] = []
  const vals: unknown[] = []
  if (patch.engine !== undefined) { cols.push('engine = ?'); vals.push(patch.engine) }
  if (patch.model !== undefined) { cols.push('model = ?'); vals.push(patch.model) }
  if (patch.reasoningEffort !== undefined) { cols.push('reasoning_effort = ?'); vals.push(patch.reasoningEffort) }
  // title/summary are denormalized mirrors of annotations_json — derived here so
  // they can never be written independently of the blob (the sole write path).
  if (patch.annotations !== undefined) {
    cols.push('annotations_json = ?'); vals.push(JSON.stringify(patch.annotations))
    cols.push('title = ?'); vals.push(patch.annotations.title)
    cols.push('summary = ?'); vals.push(patch.annotations.summary)
  }
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

function rowToThread(db: DatabaseSync, row: ChatThreadRow, warnings?: LoadWarningKind[]): ChatThread {
  const messages = (db.prepare('SELECT role, text, at, anchor_json, actions_json, tools_json, segments_json, comment_refs_json FROM chat_messages WHERE thread_id = ? ORDER BY id')
    .all(row.id) as { role: 'user' | 'agent'; text: string; at: string; anchor_json: string | null; actions_json: string | null; tools_json: string | null; segments_json: string | null; comment_refs_json: string | null }[])
    .map((r) => {
      // Chat payload is split: role/text/time are durable columns, while these JSON
      // blobs are optional enrichments. If one enrichment blob is corrupt, keep the
      // readable message and drop only that field so one bad decoration does not hide
      // the conversation or the rest of the session.
      const chatWarning = warnings ? { kind: 'chat' as const, into: warnings } : undefined
      const anchor = safeJson<CommentAnchor>(r.anchor_json, chatWarning)
      const actions = safeJson<AgentAction[]>(r.actions_json, chatWarning)
      const tools = safeJson<ToolCall[]>(r.tools_json, chatWarning)
      const segments = safeJson<MessageSegment[]>(r.segments_json, chatWarning)
      const commentRefs = safeJson<string[]>(r.comment_refs_json, chatWarning)
      return {
        role: r.role, text: r.text, at: r.at,
        ...(anchor !== undefined ? { anchor } : {}),
        ...(actions !== undefined ? { actions } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(segments !== undefined ? { segments } : {}),
        ...(commentRefs !== undefined ? { commentRefs } : {})
      }
    })
  return {
    id: row.id,
    kind: row.kind,
    agent: rowToAgent(row.engine, row.model, row.reasoning_effort)!,
    engineSessionId: row.engine_session_id ?? undefined,
    messages,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    executionMode: isExecutionMode(row.execution_mode) ? row.execution_mode : LEGACY_EXECUTION_MODE
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

export function listChatThreads(db: DatabaseSync, sessionId: number, warnings?: LoadWarningKind[]): ChatThread[] {
  const rows = db.prepare(`SELECT ${THREAD_COLS} FROM chat_threads WHERE session_id = ? ORDER BY id`).all(sessionId) as ChatThreadRow[]
  return rows.map((r) => rowToThread(db, r, warnings))
}

export function addChatMessage(db: DatabaseSync, threadId: number, m: ChatMessage): void {
  db.prepare('INSERT INTO chat_messages (thread_id, role, text, at, anchor_json, actions_json, tools_json, segments_json, comment_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(threadId, m.role, m.text, m.at, m.anchor ? JSON.stringify(m.anchor) : null,
      m.actions && m.actions.length ? JSON.stringify(m.actions) : null,
      m.tools && m.tools.length ? JSON.stringify(m.tools) : null,
      m.segments && m.segments.length ? JSON.stringify(m.segments) : null,
      m.commentRefs && m.commentRefs.length ? JSON.stringify(m.commentRefs) : null)
}

/** Persist a resolution onto a suggest_viewed action in a thread's message history.
 *  Finds the message row whose actions carry an action with `action.id === actionId`,
 *  stamps `resolution`, and rewrites only that row's actions_json (segments_json and
 *  the rest are left untouched). A non-matching id is a no-op. */
export function setActionResolution(
  db: DatabaseSync, threadId: number, actionId: string, resolution: 'dismissed'
): void {
  const rows = db.prepare('SELECT id, actions_json FROM chat_messages WHERE thread_id = ? ORDER BY id')
    .all(threadId) as { id: number; actions_json: string | null }[]
  for (const row of rows) {
    if (!row.actions_json) continue
    // best-effort mutation: a malformed row can't carry the target action, so skip it
    // (no warning channel here) rather than letting one bad blob throw the whole call.
    const actions = safeJson<AgentAction[]>(row.actions_json)
    if (!actions) continue
    const target = actions.find((a) => a.kind === 'suggest_viewed' && a.id === actionId)
    if (!target) continue
    if (target.kind === 'suggest_viewed') target.resolution = resolution
    db.prepare('UPDATE chat_messages SET actions_json = ? WHERE id = ?').run(JSON.stringify(actions), row.id)
    return
  }
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
  if (!it.title || !it.annotations) throw new Error('iteration requires title and annotations')
  db.prepare(`INSERT INTO iterations (session_id, n, engine, engine_session_id, end_sha, summary, at, title, annotations_json, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, it.n, it.engine, it.sessionId, it.endSha, it.summary ?? null, it.at, it.title, JSON.stringify(it.annotations), it.scope)
}

export function nextIterationNumber(db: DatabaseSync, sessionId: number): number {
  const row = db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM iterations WHERE session_id = ?').get(sessionId) as { n: number }
  return row.n
}

/** Number of most-recent consecutive iterations with `scope:'scoped'` (up to `cap`).
 *  Used to force a full re-grounding after a chain of scoped updates (spec §6/Q2).
 *  A 'full' scope (or no iterations) breaks the run. */
export function trailingScopedCount(db: DatabaseSync, sessionId: number, cap: number): number {
  const rows = db.prepare('SELECT scope FROM iterations WHERE session_id = ? ORDER BY n DESC LIMIT ?')
    .all(sessionId, cap) as { scope: string | null }[]
  let n = 0
  for (const r of rows) {
    if (r.scope === 'scoped') n++
    else break
  }
  return n
}

type IterationRow = { n: number; engine: EngineId; engine_session_id: string; end_sha: string; summary: string | null; at: string; title: string; annotations_json: string; scope?: string | null }

/** An iteration whose annotations blob is malformed is skipped (returns undefined):
 *  iterations are history, and `latestIteration` / the iterations list degrade to the
 *  last good row. */
function rowToIteration(r: IterationRow, warnings?: LoadWarningKind[]): Iteration | undefined {
  const annotations = safeJson<ReviewAnnotations>(
    r.annotations_json,
    warnings ? { kind: 'iteration', into: warnings } : undefined
  )
  if (!annotations) return undefined
  return {
    n: r.n,
    engine: r.engine,
    sessionId: r.engine_session_id,
    endSha: r.end_sha,
    at: r.at,
    ...(r.summary ? { summary: r.summary } : {}),
    title: r.title,
    annotations,
    scope: r.scope === 'scoped' ? 'scoped' : 'full'
  }
}

/** Drop the narration blob: `ReviewState` carries the current one once, in
 *  `annotations`, so the iteration history travels as metadata. */
function toIterationMeta({ annotations: _annotations, ...meta }: Iteration): IterationMeta {
  return meta
}

export function latestIteration(db: DatabaseSync, sessionId: number): Iteration | null {
  const row = db.prepare(
    'SELECT n, engine, engine_session_id, end_sha, summary, at, title, annotations_json, scope FROM iterations WHERE session_id = ? ORDER BY n DESC LIMIT 1'
  ).get(sessionId) as IterationRow | undefined
  return row ? rowToIteration(row) ?? null : null
}

export function reviewCopyCandidates(
  db: DatabaseSync, repoPath: string, currentSessionId: number, baseSha: string, positions: Map<string, number>
): ReviewCopyCandidate[] {
  // Only the columns this builds from: `s.*` also dragged in a second annotations_json
  // (the session's), which silently shadowed the iteration's in the row object.
  const rows = db.prepare(`SELECT s.id, s.base_symbol, s.compare_symbol,
      i.n, i.engine AS iteration_engine, i.end_sha,
      i.at AS iteration_at, i.title AS iteration_title, i.annotations_json
    FROM sessions s JOIN repos r ON r.id = s.repo_id
    JOIN iterations i ON i.session_id = s.id
    WHERE r.path = ? AND s.id != ? AND s.base_anchor_sha = ?
      AND s.archived_at IS NULL
    ORDER BY i.at DESC, s.updated_at DESC, s.id DESC`)
    .all(repoPath, currentSessionId, baseSha) as unknown as {
      id: number; base_symbol: string; compare_symbol: string
      n: number; iteration_engine: EngineId; end_sha: string
      iteration_at: string; iteration_title: string; annotations_json: string
    }[]
  const out: ReviewCopyCandidate[] = []
  for (const row of rows) {
    const pos = positions.get(row.end_sha)
    if (pos == null) continue
    // the agent that produced *this iteration* — the session's engine/model columns are
    // rewritten by every later generation, so pairing them with the iteration's engine
    // can describe an agent that never existed. A malformed blob degrades to the engine.
    const generatedBy = safeJson<ReviewAnnotations>(row.annotations_json)?.generatedBy
    out.push({
      sessionId: row.id,
      iteration: row.n,
      title: row.iteration_title,
      baseSha,
      endSha: row.end_sha,
      commitsOld: pos,
      at: row.iteration_at,
      agent: generatedBy ?? { engine: row.iteration_engine },
      baseSymbol: row.base_symbol,
      compareSymbol: row.compare_symbol
    })
  }
  return out.sort((a, b) => a.commitsOld - b.commitsOld || b.at.localeCompare(a.at))
}

export function copyGeneratedReview(db: DatabaseSync, sourceSessionId: number, sourceIteration: number, targetSessionId: number, targetEndSha: string): void {
  const source = getSession(db, sourceSessionId)
  const target = getSession(db, targetSessionId)
  if (!source || !target) throw new Error('review session not found')
  const itRow = db.prepare(
    'SELECT n, engine, engine_session_id, end_sha, summary, at, title, annotations_json, scope FROM iterations WHERE session_id = ? AND n = ?'
  ).get(sourceSessionId, sourceIteration) as IterationRow | undefined
  if (!itRow) throw new Error('source review has no generated content to copy')
  const it = rowToIteration(itRow)
  if (!it) throw new Error('source review content is corrupt and cannot be copied')
  const annotations = it.annotations
  const agent = annotations.generatedBy ?? source.agent ?? { engine: it.engine }

  inTx(db, () => {
    updateSessionMeta(db, targetSessionId, {
      engine: agent.engine,
      model: agent.model ?? null,
      reasoningEffort: agent.reasoningEffort ?? null,
      annotations,
      reviewedAtSha: targetEndSha
    })
    addIteration(db, targetSessionId, {
      n: nextIterationNumber(db, targetSessionId),
      engine: it.engine,
      sessionId: `copy:${sourceSessionId}:${sourceIteration}`,
      endSha: targetEndSha,
      at: now(),
      title: annotations.title,
      summary: annotations.summary,
      annotations,
      scope: 'full'
    })
    // the child table this copies, read directly: assembling the source's whole
    // ReviewState here re-parsed every comment, iteration and chat message of a
    // session only to reach one two-column table. It is read before the target's
    // rows are cleared, so a self-copy still sees its own rows.
    const sourceArtifacts = db.prepare('SELECT role, path FROM artifacts WHERE session_id = ?')
      .all(sourceSessionId) as { role: 'spec' | 'plan'; path: string }[]
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(targetSessionId)
    for (const artifact of sourceArtifacts) {
      db.prepare('INSERT INTO artifacts (session_id, role, path) VALUES (?, ?, ?)').run(targetSessionId, artifact.role, artifact.path)
    }

    // one read of the source's threads, not one per branch of the ??
    const reviewThreads = listChatThreads(db, sourceSessionId).filter((t) => t.kind === 'review')
    const sourceThread = reviewThreads.find((t) => t.engineSessionId === it.sessionId) ?? reviewThreads.at(-1)
    if (sourceThread) {
      const targetThread = createChatThread(db, targetSessionId, { kind: 'review', agent, title: `Copied review from ${source.pair.compare.symbol}` })
      for (const message of sourceThread.messages) addChatMessage(db, targetThread.id, message)
    }
  })
}

export function setArtifacts(db: DatabaseSync, sessionId: number, refs: { role: 'spec' | 'plan'; path: string }[]): void {
  inTx(db, () => {
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId)
    for (const r of refs) {
      db.prepare('INSERT INTO artifacts (session_id, role, path) VALUES (?, ?, ?)').run(sessionId, r.role, r.path)
    }
  })
}

export function approveArtifact(db: DatabaseSync, sessionId: number, path: string, sha: string): void {
  db.prepare(`INSERT INTO artifact_approvals (session_id, path, sha) VALUES (?, ?, ?)
    ON CONFLICT(session_id, path) DO UPDATE SET sha = excluded.sha`).run(sessionId, path, sha)
}

export function unapproveArtifact(db: DatabaseSync, sessionId: number, path: string): void {
  db.prepare('DELETE FROM artifact_approvals WHERE session_id = ? AND path = ?').run(sessionId, path)
}

export function approveSessionSurface(db: DatabaseSync, sessionId: number, sha: string, hash: string): void {
  inTx(db, () => {
    db.prepare(`INSERT INTO session_approvals (session_id, sha, hash, approved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, hash) DO UPDATE SET sha = excluded.sha, approved_at = excluded.approved_at`).run(sessionId, sha, hash, now())
    updateSessionMeta(db, sessionId, { approvedSha: sha })
  })
}

export function approveSessionSha(db: DatabaseSync, sessionId: number, sha: string): void {
  approveSessionSurface(db, sessionId, sha, sha)
}

export function unapproveSessionSurface(db: DatabaseSync, sessionId: number, hash: string): void {
  inTx(db, () => {
    db.prepare('DELETE FROM session_approvals WHERE session_id = ? AND hash = ?').run(sessionId, hash)
    const latest = db.prepare(`SELECT sha FROM session_approvals WHERE session_id = ?
      ORDER BY approved_at DESC LIMIT 1`).get(sessionId) as { sha: string } | undefined
    updateSessionMeta(db, sessionId, { approvedSha: latest?.sha ?? null })
  })
}

export function unapproveSessionSha(db: DatabaseSync, sessionId: number, sha: string): void {
  unapproveSessionSurface(db, sessionId, sha)
}

/** Replace-semantics for the renderer's saveUiState patch (matches the old
 *  whole-object JSON write, but transactional and targeted). */
export function replaceUiState(db: DatabaseSync, sessionId: number, patch: UiStatePatch): void {
  inTx(db, () => {
    if (patch.viewedAt !== undefined) {
      db.prepare('DELETE FROM viewed_files WHERE session_id = ?').run(sessionId)
      for (const [file, mark] of Object.entries(patch.viewedAt)) {
        db.prepare('INSERT INTO viewed_files (session_id, file, sha, hash) VALUES (?, ?, ?, ?)').run(sessionId, file, mark.sha, mark.hash)
      }
    }
    if (patch.fileExcluded !== undefined) {
      db.prepare('DELETE FROM excluded_files WHERE session_id = ?').run(sessionId)
      for (const [file, excluded] of Object.entries(patch.fileExcluded)) {
        db.prepare('INSERT INTO excluded_files (session_id, file, excluded) VALUES (?, ?, ?)').run(sessionId, file, excluded ? 1 : 0)
      }
    }
    if (patch.diffStack !== undefined) {
      db.prepare('UPDATE sessions SET diff_stack = ? WHERE id = ?').run(JSON.stringify(normalizeStack(patch.diffStack)), sessionId)
    }
  })
}

// ── assembly: DB → ReviewState (IPC shape the renderer already knows) ──
export function loadReviewState(db: DatabaseSync, sessionId: number): ReviewState {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(sessionId) as SessionDbRow | undefined
  if (!row) throw new Error(`session ${sessionId} not found`)
  const meta = rowToMeta(row)

  // One malformed persisted blob must never make the whole session unloadable: every
  // JSON.parse below is guarded, salvages per its kind, and records a warning surfaced
  // to the renderer via loadWarnings. Stored data is never mutated or deleted.
  const warnings: LoadWarningKind[] = []

  const comments = (db.prepare('SELECT id, json FROM comments WHERE session_id = ? ORDER BY created_at, id').all(sessionId) as
    { id: string; json: string }[])
    .map((r) => safeJson<Comment>(r.json, { kind: 'comment', into: warnings }))
    .filter((c): c is Comment => c !== undefined)

  const chats = listChatThreads(db, sessionId, warnings)

  const iterations = (db.prepare(
    'SELECT n, engine, engine_session_id, end_sha, summary, at, title, annotations_json, scope FROM iterations WHERE session_id = ? ORDER BY n'
  ).all(sessionId) as IterationRow[])
    .map((r) => rowToIteration(r, warnings))
    .filter((it): it is Iteration => it !== undefined)
  // derive latest from the salvaged list (ordered by n) so a corrupt newest row
  // degrades to the last loadable iteration rather than nulling latestIteration.
  const latest = iterations[iterations.length - 1]

  const viewedAt: Record<string, ViewMark> = {}
  for (const r of db.prepare('SELECT file, sha, hash FROM viewed_files WHERE session_id = ?').all(sessionId) as { file: string; sha: string; hash: string }[]) {
    viewedAt[r.file] = { sha: r.sha, hash: r.hash }
  }

  const fileExcluded: Record<string, boolean> = {}
  for (const r of db.prepare('SELECT file, excluded FROM excluded_files WHERE session_id = ?').all(sessionId) as { file: string; excluded: number }[]) {
    fileExcluded[r.file] = r.excluded === 1
  }

  const artifacts = db.prepare('SELECT role, path FROM artifacts WHERE session_id = ?')
    .all(sessionId) as { role: 'spec' | 'plan'; path: string }[]

  const artifactApprovals: Record<string, string> = {}
  for (const r of db.prepare('SELECT path, sha FROM artifact_approvals WHERE session_id = ?').all(sessionId) as { path: string; sha: string }[]) {
    artifactApprovals[r.path] = r.sha
  }
  const approvals = sessionApprovals(db, sessionId)
  const annotations = safeJson<ReviewAnnotations>(row.annotations_json, { kind: 'annotations', into: warnings })
  const merged = row.merged_at ? safeJson<MergeRecord>(row.merge_json, { kind: 'merge', into: warnings }) : undefined
  const loadWarnings = summarizeLoadWarnings(warnings)

  return {
    repo: meta.repo,
    branch: effectiveRef(meta.pair.compare),
    base: effectiveRef(meta.pair.base),
    agent: meta.agent,
    annotations,
    comments, chats, viewedAt, fileExcluded,
    approvedSha: row.approved_sha ?? undefined,
    approvedShas: approvals.shas,
    approvedHashes: approvals.hashes,
    reviewedAtSha: row.reviewed_at_sha ?? undefined,
    artifactApprovals,
    latestIteration: latest ? toIterationMeta(latest) : undefined,
    iterations: iterations.map(toIterationMeta), artifacts,
    // a malformed stored stack reads as Unified — parseStack never throws
    ...(row.diff_stack ? { diffStack: parseStack(row.diff_stack) } : {}),
    ...(merged ? { merged } : {}),
    ...(loadWarnings.length ? { loadWarnings } : {})
  }
}
