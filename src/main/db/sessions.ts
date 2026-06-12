import type { DatabaseSync } from 'node:sqlite'
import type {
  ChatMessage, Comment, EngineId, Iteration, RefPair, RefSide, ReviewAnnotations, ReviewState, SessionMeta
} from '../../shared/types.js'
import { effectiveRef, refIdentity } from '../../shared/types.js'

function now(): string { return new Date().toISOString() }

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

// ── sessions ──────────────────────────────────────────────────
interface SessionDbRow {
  id: number; repo_id: number
  base_kind: 'branch' | 'commit'; base_symbol: string; base_anchor_sha: string
  compare_kind: 'branch' | 'commit'; compare_symbol: string; compare_anchor_sha: string
  engine: EngineId | null; title: string | null; summary: string | null
  annotations_json: string | null; approved_sha: string | null; reviewed_at_sha: string | null
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createSession(db: DatabaseSync, repoPath: string, pair: RefPair, engine?: EngineId): SessionMeta {
  assertResolved(pair.base)
  assertResolved(pair.compare)
  const repoId = ensureRepo(db, repoPath)
  const t = now()
  const res = db.prepare(`INSERT INTO sessions
    (repo_id, base_kind, base_symbol, base_anchor_sha, compare_kind, compare_symbol, compare_anchor_sha,
     engine, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(repoId, pair.base.kind, pair.base.symbol, pair.base.anchorSha,
      pair.compare.kind, pair.compare.symbol, pair.compare.anchorSha, engine ?? null, t, t)
  return getSession(db, Number(res.lastInsertRowid))!
}

export function getSession(db: DatabaseSync, id: number): SessionMeta | null {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionDbRow | undefined
  return row ? rowToMeta(row) : null
}

export function findSession(db: DatabaseSync, repoPath: string, pair: RefPair): SessionMeta | null {
  const row = db.prepare(`${SESSION_SELECT}
    WHERE r.path = ? AND s.base_ident = ? AND s.compare_ident = ? AND s.archived_at IS NULL`)
    .get(repoPath, refIdentity(pair.base), refIdentity(pair.compare)) as SessionDbRow | undefined
  return row ? rowToMeta(row) : null
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

export function addChat(db: DatabaseSync, sessionId: number, m: ChatMessage): void {
  db.prepare('INSERT INTO chat_messages (session_id, role, text, at, anchor_json) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, m.role, m.text, m.at, m.anchor ? JSON.stringify(m.anchor) : null)
}

export function addIteration(db: DatabaseSync, sessionId: number, it: Iteration): void {
  db.prepare(`INSERT INTO iterations (session_id, n, engine, engine_session_id, end_sha, summary, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, n) DO UPDATE SET engine = excluded.engine,
      engine_session_id = excluded.engine_session_id, end_sha = excluded.end_sha,
      summary = excluded.summary, at = excluded.at`)
    .run(sessionId, it.n, it.engine, it.sessionId, it.endSha, it.summary ?? null, it.at)
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
  viewedAt?: Record<string, string>
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
      for (const [file, sha] of Object.entries(patch.viewedAt)) {
        db.prepare('INSERT INTO viewed_files (session_id, file, sha) VALUES (?, ?, ?)').run(sessionId, file, sha)
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

  const chat = (db.prepare('SELECT role, text, at, anchor_json FROM chat_messages WHERE session_id = ? ORDER BY id')
    .all(sessionId) as { role: 'user' | 'agent'; text: string; at: string; anchor_json: string | null }[])
    .map((r) => ({ role: r.role, text: r.text, at: r.at, ...(r.anchor_json ? { anchor: JSON.parse(r.anchor_json) } : {}) }))

  const iterations = (db.prepare(
    'SELECT n, engine, engine_session_id, end_sha, summary, at FROM iterations WHERE session_id = ? ORDER BY n'
  ).all(sessionId) as { n: number; engine: EngineId; engine_session_id: string; end_sha: string; summary: string | null; at: string }[])
    .map((r) => ({ n: r.n, engine: r.engine, sessionId: r.engine_session_id, endSha: r.end_sha, at: r.at, ...(r.summary ? { summary: r.summary } : {}) }))

  const viewedAt: Record<string, string> = {}
  for (const r of db.prepare('SELECT file, sha FROM viewed_files WHERE session_id = ?').all(sessionId) as { file: string; sha: string }[]) {
    viewedAt[r.file] = r.sha
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
    annotations: row.annotations_json ? (JSON.parse(row.annotations_json) as ReviewAnnotations) : undefined,
    comments, chat, viewedAt, reviewedSections,
    approvedSha: row.approved_sha ?? undefined,
    reviewedAtSha: row.reviewed_at_sha ?? undefined,
    artifactApprovals, iterations, artifacts
  }
}
