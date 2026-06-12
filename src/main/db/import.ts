import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RefPair, ReviewState } from '../../shared/types.js'
import { headSha } from '../git.js'
import {
  addChat, addIteration, approveArtifact, createSession, findSession, replaceUiState,
  setArtifacts, touchRepo, updateSessionMeta, upsertComment
} from './sessions.js'

/** Import all v1 `.local-review/review-*.json` files for a repo into the db,
 *  renaming each source to `<file>.imported`. Unreadable files are skipped and
 *  left in place (logged, never deleted). Returns imported file names. */
export async function importLegacyRepoFiles(db: DatabaseSync, repoPath: string): Promise<string[]> {
  const dir = path.join(repoPath, '.local-review')
  if (!fs.existsSync(dir)) return []
  const imported: string[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!/^review-.+\.json$/.test(name)) continue
    const p = path.join(dir, name)
    try {
      const st = JSON.parse(fs.readFileSync(p, 'utf8')) as ReviewState
      if (!st.branch || !st.base) throw new Error('missing branch/base')
      await importLegacyState(db, repoPath, st)
      fs.renameSync(p, `${p}.imported`)
      imported.push(name)
    } catch (err) {
      console.error(`[import] skipped ${p}:`, err)
    }
  }
  return imported
}

async function importLegacyState(db: DatabaseSync, repoPath: string, st: ReviewState): Promise<void> {
  // v1 sessions are always branch-vs-branch. Anchors: spec says iteration
  // history where available, else current tips (best effort, '' if branch gone).
  const tipOf = async (branch: string): Promise<string> => {
    try { return await headSha(repoPath, branch) } catch { return '' }
  }
  const lastIter = st.iterations[st.iterations.length - 1]
  const pair: RefPair = {
    base: { kind: 'branch', symbol: st.base, anchorSha: await tipOf(st.base) },
    compare: { kind: 'branch', symbol: st.branch, anchorSha: lastIter?.endSha ?? st.reviewedAtSha ?? await tipOf(st.branch) }
  }
  if (findSession(db, repoPath, pair)) return // already imported (re-run edge)

  const s = createSession(db, repoPath, pair, st.engine)
  try {
    // title/summary are denormalized copies of annotations fields — kept as
    // dedicated columns for cheap list queries
    updateSessionMeta(db, s.id, {
      ...(st.engine !== undefined ? { engine: st.engine } : {}),
      ...(st.annotations !== undefined ? { annotations: st.annotations } : {}),
      ...(st.annotations?.title !== undefined ? { title: st.annotations.title } : {}),
      ...(st.annotations?.summary !== undefined ? { summary: st.annotations.summary } : {}),
      ...(st.approvedSha !== undefined ? { approvedSha: st.approvedSha } : {}),
      ...(st.reviewedAtSha !== undefined ? { reviewedAtSha: st.reviewedAtSha } : {})
    })
    for (const c of st.comments ?? []) upsertComment(db, s.id, c)
    for (const m of st.chat ?? []) addChat(db, s.id, m)
    for (const it of st.iterations ?? []) addIteration(db, s.id, it)
    setArtifacts(db, s.id, st.artifacts ?? [])
    for (const [p, sha] of Object.entries(st.artifactApprovals ?? {})) approveArtifact(db, s.id, p, sha)
    replaceUiState(db, s.id, { viewedAt: st.viewedAt ?? {}, reviewedSections: st.reviewedSections ?? [] })
  } catch (err) {
    // a half-imported session must not survive: a re-run's findSession would
    // treat it as complete and the source file's children would be lost
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id) // CASCADE drops children
    throw err
  }
}

/** One-time seed from the legacy Electron config.json ({recents, lastEngine}). */
export function seedFromConfig(db: DatabaseSync, configPath: string): void {
  if (!fs.existsSync(configPath)) return
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { recents?: string[]; lastEngine?: string }
    const base = Date.now()
    ;(cfg.recents ?? []).forEach((repo, i) => {
      // preserve order: first entry is most recent
      touchRepo(db, repo, new Date(base - i * 1000).toISOString())
    })
    if (cfg.lastEngine) {
      db.prepare(`INSERT INTO prefs (key, value) VALUES ('engine', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(cfg.lastEngine)
    }
    fs.renameSync(configPath, `${configPath}.imported`)
  } catch (err) {
    console.error(`[import] config seed failed (left in place):`, err)
  }
}
