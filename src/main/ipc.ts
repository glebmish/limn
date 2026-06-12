import { BrowserWindow, Notification, app, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { Api, LoadedReview, OpEventMsg, OpResultMsg, RepoChangedMsg, UiStatePatch } from '../shared/ipc.js'
import type { Artifact, Comment, EngineEvent, EngineId, RefPair, SessionMeta } from '../shared/types.js'
import { effectiveRef } from '../shared/types.js'
import {
  currentBranch, defaultBase, describeSide, diffSince, getDiff, headSha, isDirty,
  listBranches, log, markSince, resolveRefInput
} from './git.js'
import { execGit } from './exec.js'
import * as dao from './db/sessions.js'
import { importLegacyRepoFiles, seedFromConfig } from './db/import.js'
import { detectArtifacts, loadArtifact } from './artifacts.js'
import { makeEngine } from './engines/index.js'
import { mergeAnnotations } from './engines/validate.js'
import { reanchorComments } from './anchor.js'
import { claudeBinaryPath, codexBinaryPath } from './engines/binaries.js'

const activeOps = new Map<string, () => void>()
const repoLocks = new Set<string>()

// ── watch mode: poll the open review's branch head; push when it moves ──
let watcher: { timer: NodeJS.Timeout; repo: string; branch: string; lastSha: string } | null = null

function startWatch(repo: string, branch: string, sha: string): void {
  if (watcher) clearInterval(watcher.timer)
  const w = { repo, branch, lastSha: sha, timer: setInterval(() => void poll(), 2000) }
  watcher = w
  async function poll(): Promise<void> {
    if (repoLocks.has(repo)) return // our own agent op — reload arrives via op:result
    try {
      const head = await headSha(repo, branch)
      if (head !== w.lastSha) {
        w.lastSha = head
        send('repo:changed', { repo, branch, headSha: head })
      }
    } catch {
      // branch deleted / repo gone — stop quietly
      clearInterval(w.timer)
      if (watcher === w) watcher = null
    }
  }
}

function stopWatch(): void {
  if (watcher) { clearInterval(watcher.timer); watcher = null }
}

function send(channel: 'op:event' | 'op:result' | 'repo:changed', msg: OpEventMsg | OpResultMsg | RepoChangedMsg): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, msg)
}

/** Notify when the user isn't looking at the app (agent runs take minutes). */
function notifyIfUnfocused(title: string, body: string): void {
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  if (!focused && Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) {
        w.show()
        w.focus()
      }
    })
    n.show()
  }
}

async function pumpEvents(opId: string, events: AsyncIterable<EngineEvent>): Promise<void> {
  for await (const event of events) send('op:event', { opId, event })
}

async function loadArtifactsFor(
  db: DatabaseSync, sessionId: number, repo: string, branch: string,
  refs: { role: 'spec' | 'plan'; path: string }[], changedPaths: string[]
): Promise<Artifact[]> {
  if (refs.length === 0) {
    refs = await detectArtifacts(repo, branch, changedPaths)
    if (refs.length > 0) dao.setArtifacts(db, sessionId, refs)
  }
  const out: Artifact[] = []
  for (const r of refs) {
    try { out.push(loadArtifact(repo, r.path, r.role)) } catch { /* artifact file gone — skip */ }
  }
  return out
}

async function buildLoadedReview(db: DatabaseSync, session: SessionMeta): Promise<LoadedReview> {
  const { repo, pair } = session
  const state = dao.loadReviewState(db, session.id)
  const baseEff = effectiveRef(pair.base)
  const compareEff = effectiveRef(pair.compare)

  // ref-missing guard: a deleted branch or GC'd sha must not crash the app
  for (const [side, eff, symbol] of [['base', baseEff, pair.base.symbol], ['compare', compareEff, pair.compare.symbol]] as const) {
    try {
      await headSha(repo, eff)
    } catch {
      return {
        sessionId: session.id, session, state,
        baseContext: await describeSide(repo, pair.base),
        compareContext: await describeSide(repo, pair.compare),
        skeleton: { base: baseEff, branch: compareEff, mergeBase: '', headSha: '', files: [] },
        artifacts: [], commits: [], sinceTagged: false,
        refMissing: { side, symbol }
      }
    }
  }

  const skeleton = await getDiff(repo, baseEff, compareEff)
  const artifacts = await loadArtifactsFor(db, session.id, repo, compareEff, state.artifacts, skeleton.files.map((f) => f.path))
  const commits = await log(repo, baseEff, compareEff)
  let sinceTagged = false
  const baseline = state.approvedSha ?? state.reviewedAtSha
  if (baseline && baseline !== skeleton.headSha) {
    try {
      const since = await diffSince(repo, baseline, compareEff)
      markSince(skeleton, since, 'since')
      sinceTagged = true
    } catch { /* baseline unreachable (rebase) — full diff without drift */ }
  }
  const byViewSha = new Map<string, Set<string>>()
  for (const [file, sha] of Object.entries(state.viewedAt)) {
    if (sha === skeleton.headSha) continue
    byViewSha.set(sha, (byViewSha.get(sha) ?? new Set()).add(file))
  }
  let viewedDropped = false
  for (const [sha, paths] of byViewSha) {
    try {
      const since = await diffSince(repo, sha, compareEff)
      markSince(skeleton, since, 'sinceViewed', paths)
    } catch {
      for (const p of paths) { delete state.viewedAt[p]; viewedDropped = true }
    }
  }
  if (viewedDropped) dao.replaceUiState(db, session.id, { viewedAt: state.viewedAt })
  reanchorComments(state.comments, skeleton, artifacts)
  for (const c of state.comments) dao.upsertComment(db, session.id, c) // persist re-anchoring
  return {
    sessionId: session.id, session,
    baseContext: await describeSide(repo, pair.base),
    compareContext: await describeSide(repo, pair.compare),
    skeleton, state, artifacts, commits, sinceTagged
  }
}

function lastEngineSession(db: DatabaseSync, sessionId: number): { engine: EngineId; sessionId: string } | null {
  const st = dao.loadReviewState(db, sessionId)
  const it = st.iterations[st.iterations.length - 1]
  return it ? { engine: it.engine, sessionId: it.sessionId } : null
}

function mustGetSession(db: DatabaseSync, id: number): SessionMeta {
  const s = dao.getSession(db, id)
  if (!s) throw new Error(`session ${id} not found`)
  return s
}

export function registerIpc(db: DatabaseSync, bootNotices: string[]): void {
  seedFromConfig(db, path.join(app.getPath('userData'), 'config.json'))

  const handle = <K extends keyof Api>(name: K, fn: Api[K]): void => {
    ipcMain.handle(name, (_ev, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }

  handle('pickRepo', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  handle('recentRepos', async () => dao.recentRepoPaths(db, 8).filter((r) => fs.existsSync(r)))

  handle('openRepo', async (repo: string) => {
    if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a git repository`)
    dao.touchRepo(db, repo)
    await importLegacyRepoFiles(db, repo)
    const branches = await listBranches(repo)
    return { path: repo, branches, current: await currentBranch(repo), defaultBase: await defaultBase(repo) }
  })

  handle('startSession', async (repo: string, baseInput: string, compareInput: string, engine: EngineId) => {
    await importLegacyRepoFiles(db, repo) // repos can be entered without openRepo (CLI, plan B)
    const base = await resolveRefInput(repo, baseInput)
    const compare = await resolveRefInput(repo, compareInput)
    if (base.sha === compare.sha) throw new Error('base and compare point at the same commit')
    const pair: RefPair = {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    }
    const existing = dao.findSession(db, repo, pair)
    const session = existing ?? dao.createSession(db, repo, pair, engine)
    if (!existing) {
      try {
        const sha = (await execGit(repo, ['rev-list', '--max-parents=0', '--max-count=1', 'HEAD'])).trim()
        dao.ensureRepo(db, repo, sha)
      } catch { /* identity hint is best-effort */ }
    }
    dao.touchRepo(db, repo)
    return { sessionId: session.id }
  })

  handle('loadSession', async (sessionId: number) => {
    const session = mustGetSession(db, sessionId)
    const loaded = await buildLoadedReview(db, session)
    if (!loaded.refMissing && session.pair.compare.kind === 'branch') {
      startWatch(session.repo, session.pair.compare.symbol, loaded.skeleton.headSha)
    } else {
      stopWatch()
    }
    return loaded
  })

  handle('archiveSession', async (sessionId: number) => dao.archiveSession(db, sessionId))

  handle('generate', async (sessionId: number, engineId: EngineId, opId: string) => {
    const session = mustGetSession(db, sessionId)
    const repo = session.repo
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      const baseEff = effectiveRef(session.pair.base)
      const compareEff = effectiveRef(session.pair.compare)
      const skeleton = await getDiff(repo, baseEff, compareEff)
      const state = dao.loadReviewState(db, sessionId)
      const artifacts = await loadArtifactsFor(db, sessionId, repo, compareEff, state.artifacts, skeleton.files.map((f) => f.path))
      const engine = makeEngine(engineId)
      const run = engine.generateReview({ repo, branch: compareEff, base: baseEff, diff: skeleton, artifacts })
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value, sessionId: engineSession } = await run.result
      await pump
      const { annotations, warnings } = mergeAnnotations(skeleton, value)
      for (const w of warnings) send('op:event', { opId, event: { type: 'status', text: `note: ${w}` } })
      if (annotations.artifactPaths) {
        const refs = [...state.artifacts]
        for (const p of annotations.artifactPaths) {
          if (!refs.some((a) => a.path === p) && fs.existsSync(path.join(repo, p))) {
            refs.push({ role: refs.some((a) => a.role === 'spec') ? 'plan' : 'spec', path: p })
          }
        }
        dao.setArtifacts(db, sessionId, refs)
      }
      dao.updateSessionMeta(db, sessionId, {
        engine: engineId, annotations, title: annotations.title, summary: annotations.summary,
        reviewedAtSha: skeleton.headSha
      })
      dao.resetIterations(db, sessionId, { n: 1, engine: engineId, sessionId: engineSession, endSha: skeleton.headSha, at: new Date().toISOString() })
      send('op:result', { opId, kind: 'review', ok: true, reload: true })
      const flagged = annotations.sections.reduce((n, s) => n + s.flags.filter((f) => f.risk).length, 0)
      notifyIfUnfocused('Guided review ready',
        `${annotations.sections.length} sections${flagged ? `, ${flagged} flagged` : ''} — ${session.pair.compare.symbol}`)
    } catch (err) {
      console.error('[generate] failed:', err)
      send('op:result', { opId, kind: 'review', ok: false, error: String(err instanceof Error ? err.message : err) })
      notifyIfUnfocused('Review generation failed', String(err instanceof Error ? err.message : err).slice(0, 120))
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
    }
  })

  handle('cancel', async (opId: string) => {
    activeOps.get(opId)?.()
    activeOps.delete(opId)
  })

  handle('saveUiState', async (sessionId: number, patch: UiStatePatch) => {
    dao.replaceUiState(db, sessionId, patch)
  })

  handle('upsertComment', async (sessionId: number, comment: Comment) => {
    dao.upsertComment(db, sessionId, comment)
    return dao.loadReviewState(db, sessionId)
  })

  handle('deleteComment', async (sessionId: number, id: string) => {
    dao.deleteComment(db, sessionId, id)
    return dao.loadReviewState(db, sessionId)
  })

  handle('chat', async (sessionId: number, message: string, opId: string, anchor) => {
    const session = mustGetSession(db, sessionId)
    const repo = session.repo
    const sess = lastEngineSession(db, sessionId)
    if (!sess) throw new Error('Generate a review first — chat shares its session')
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      const engine = makeEngine(sess.engine)
      const run = engine.chat(repo, sess.sessionId, message, anchor)
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value } = await run.result
      await pump
      const at = new Date().toISOString()
      dao.addChat(db, sessionId, { role: 'user', text: message, at, anchor })
      dao.addChat(db, sessionId, { role: 'agent', text: value, at })
      send('op:result', { opId, kind: 'chat', ok: true })
    } catch (err) {
      send('op:result', { opId, kind: 'chat', ok: false, error: String(err instanceof Error ? err.message : err) })
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
    }
  })

  handle('sendFeedback', async (sessionId: number, commentIds: string[], steer, opId: string) => {
    const session = mustGetSession(db, sessionId)
    const repo = session.repo
    const sess = lastEngineSession(db, sessionId)
    if (!sess) throw new Error('Generate a review first')
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      if (session.pair.compare.kind !== 'branch') throw new Error('This session reviews a fixed commit — the agent cannot push fixes to it')
      const branch = session.pair.compare.symbol
      if (await isDirty(repo)) throw new Error('Working tree is dirty — commit or stash before sending feedback')
      const cur = await currentBranch(repo)
      if (cur !== branch) throw new Error(`Repo is on ${cur}, not ${branch} — switch branches first`)
      const state = dao.loadReviewState(db, sessionId)
      const comments = state.comments.filter((c) => commentIds.includes(c.id) && c.status !== 'resolved')
      if (comments.length === 0 && !steer) throw new Error('Nothing to send')

      for (const c of comments) { c.status = 'sent'; dao.upsertComment(db, sessionId, c) }

      const engine = makeEngine(sess.engine)
      const run = engine.applyFeedback(repo, sess.sessionId, comments, steer)
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value: fix, sessionId: engineSession } = await run.result
      await pump

      const newHead = await headSha(repo, branch)
      const resolutionsById = new Map(fix.resolutions.map((r) => [r.commentId, r]))
      for (const c of comments) {
        const r = resolutionsById.get(c.id)
        if (r) {
          c.status = 'resolved'
          c.resolution = { verdict: r.verdict, note: r.note, commit: newHead.slice(0, 7) }
        } else {
          c.status = 'queued' // engine forgot it — keep queued so it isn't lost
        }
        dao.upsertComment(db, sessionId, c)
      }
      dao.addIteration(db, sessionId, {
        n: state.iterations.length + 1, engine: sess.engine, sessionId: engineSession,
        endSha: newHead, at: new Date().toISOString(), summary: fix.summary
      })
      send('op:result', { opId, kind: 'fix', ok: true, reload: true })
      const addressed = fix.resolutions.filter((r) => r.verdict !== 'skipped').length
      const skipped = fix.resolutions.length - addressed
      notifyIfUnfocused('Agent applied your comments',
        `${addressed} addressed${skipped ? `, ${skipped} skipped` : ''} — ${branch}`)
    } catch (err) {
      // roll back "sent" so comments aren't stuck
      const st = dao.loadReviewState(db, sessionId)
      for (const c of st.comments) {
        if (commentIds.includes(c.id) && c.status === 'sent') {
          c.status = 'queued'
          dao.upsertComment(db, sessionId, c)
        }
      }
      send('op:result', { opId, kind: 'fix', ok: false, error: String(err instanceof Error ? err.message : err) })
      notifyIfUnfocused('Agent fix run failed', String(err instanceof Error ? err.message : err).slice(0, 120))
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
    }
  })

  handle('approve', async (sessionId: number) => {
    const session = mustGetSession(db, sessionId)
    const sha = await headSha(session.repo, effectiveRef(session.pair.compare))
    dao.updateSessionMeta(db, sessionId, { approvedSha: sha, reviewedAtSha: sha })
    return dao.loadReviewState(db, sessionId)
  })

  handle('approveArtifact', async (sessionId: number, artifactPath: string) => {
    const session = mustGetSession(db, sessionId)
    const sha = await headSha(session.repo, effectiveRef(session.pair.compare))
    dao.approveArtifact(db, sessionId, artifactPath, sha)
    return dao.loadReviewState(db, sessionId)
  })

  handle('authStatus', async (engine: EngineId) => {
    const home = os.homedir()
    if (engine === 'claude') {
      const bin = claudeBinaryPath()
      if (!bin) return { ok: false, hint: 'Install Claude Code (`claude` not found on PATH)' }
      const ok = Boolean(process.env.ANTHROPIC_API_KEY) || fs.existsSync(path.join(home, '.claude'))
      return { ok, hint: ok ? 'Using Claude Code login or API key' : 'Run `claude` once to log in, or set ANTHROPIC_API_KEY' }
    }
    const bin = codexBinaryPath()
    if (!bin) return { ok: false, hint: 'Install Codex CLI (`codex` not found on PATH)' }
    const ok = Boolean(process.env.OPENAI_API_KEY) || fs.existsSync(path.join(home, '.codex', 'auth.json'))
    return { ok, hint: ok ? 'Using codex login or API key' : 'Run `codex login`, or set OPENAI_API_KEY' }
  })

  handle('getPrefs', async () => {
    const out: Record<string, string> = {}
    for (const r of db.prepare('SELECT key, value FROM prefs').all() as { key: string; value: string }[]) {
      out[r.key] = r.value
    }
    if (bootNotices.length > 0) out['boot-notices'] = JSON.stringify(bootNotices)
    return out
  })

  handle('setPref', async (key: string, value: string) => {
    db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  })
}
