import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Api, LoadedReview, OpEventMsg, OpResultMsg } from '../shared/ipc.js'
import type { Artifact, Comment, EngineEvent, EngineId, ReviewState } from '../shared/types.js'
import {
  currentBranch, defaultBase, diffSince, getDiff, headSha, isDirty, listBranches, log, markSince
} from './git.js'
import { defaultState, loadState, saveState } from './state.js'
import { detectArtifacts, loadArtifact } from './artifacts.js'
import { makeEngine } from './engines/index.js'
import { mergeAnnotations } from './engines/validate.js'
import { reanchorComments } from './anchor.js'
import { addRecent, loadConfig } from './config.js'

const activeOps = new Map<string, () => void>()
const repoLocks = new Set<string>()

function send(channel: 'op:event' | 'op:result', msg: OpEventMsg | OpResultMsg): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, msg)
}

async function pumpEvents(opId: string, events: AsyncIterable<EngineEvent>): Promise<void> {
  for await (const event of events) send('op:event', { opId, event })
}

async function loadArtifactsFor(repo: string, branch: string, state: ReviewState): Promise<Artifact[]> {
  let refs = state.artifacts
  if (refs.length === 0) {
    refs = await detectArtifacts(repo, branch)
    state.artifacts = refs
  }
  const out: Artifact[] = []
  for (const r of refs) {
    try {
      out.push(loadArtifact(repo, r.path, r.role))
    } catch {
      // artifact file gone — skip
    }
  }
  return out
}

async function buildLoadedReview(repo: string, branch: string, base: string): Promise<LoadedReview> {
  const skeleton = await getDiff(repo, base, branch)
  const state = loadState(repo, branch, base)
  const artifacts = await loadArtifactsFor(repo, branch, state)
  const commits = await log(repo, base, branch)
  let sinceTagged = false
  const baseline = state.approvedSha ?? state.reviewedAtSha
  if (baseline && baseline !== skeleton.headSha) {
    try {
      const since = await diffSince(repo, baseline, branch)
      markSince(skeleton, since)
      sinceTagged = true
    } catch {
      // baseline sha no longer reachable (rebase) — show full diff without drift
    }
  }
  reanchorComments(state.comments, skeleton, artifacts)
  saveState(state)
  return { skeleton, state, artifacts, commits, sinceTagged }
}

function lastSession(state: ReviewState): { engine: EngineId; sessionId: string } | null {
  const it = state.iterations[state.iterations.length - 1]
  return it ? { engine: it.engine, sessionId: it.sessionId } : null
}

export function registerIpc(): void {
  const handle = <K extends keyof Api>(name: K, fn: Api[K]): void => {
    ipcMain.handle(name, (_ev, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }

  handle('pickRepo', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  handle('recentRepos', async () => loadConfig().recents.filter((r) => fs.existsSync(r)))

  handle('openRepo', async (repo: string) => {
    if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a git repository`)
    addRecent(repo)
    const branches = await listBranches(repo)
    return { path: repo, branches, current: await currentBranch(repo), defaultBase: await defaultBase(repo) }
  })

  handle('loadReview', async (repo: string, branch: string, base: string) => buildLoadedReview(repo, branch, base))

  handle('generate', async (repo: string, branch: string, base: string, engineId: EngineId, opId: string) => {
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      const skeleton = await getDiff(repo, base, branch)
      const state = loadState(repo, branch, base)
      const artifacts = await loadArtifactsFor(repo, branch, state)
      const engine = makeEngine(engineId)
      const run = engine.generateReview({ repo, branch, base, diff: skeleton, artifacts })
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value, sessionId } = await run.result
      await pump
      const { annotations, warnings } = mergeAnnotations(skeleton, value)
      for (const w of warnings) send('op:event', { opId, event: { type: 'status', text: `note: ${w}` } })
      // agent may have identified artifacts we didn't detect
      if (annotations.artifactPaths) {
        for (const p of annotations.artifactPaths) {
          if (!state.artifacts.some((a) => a.path === p) && fs.existsSync(path.join(repo, p))) {
            state.artifacts.push({ role: state.artifacts.some((a) => a.role === 'spec') ? 'plan' : 'spec', path: p })
          }
        }
      }
      state.annotations = annotations
      state.engine = engineId
      state.reviewedAtSha = skeleton.headSha
      state.iterations = [{ n: 1, engine: engineId, sessionId, endSha: skeleton.headSha, at: new Date().toISOString() }]
      saveState(state)
      send('op:result', { opId, kind: 'review', ok: true, reload: true })
    } catch (err) {
      send('op:result', { opId, kind: 'review', ok: false, error: String(err instanceof Error ? err.message : err) })
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
    }
  })

  handle('cancel', async (opId: string) => {
    activeOps.get(opId)?.()
    activeOps.delete(opId)
  })

  handle('saveUiState', async (repo: string, branch: string, base: string, patch) => {
    const state = loadState(repo, branch, base)
    Object.assign(state, patch)
    saveState(state)
  })

  handle('upsertComment', async (repo: string, branch: string, base: string, comment: Comment) => {
    const state = loadState(repo, branch, base)
    const i = state.comments.findIndex((c) => c.id === comment.id)
    if (i >= 0) state.comments[i] = comment
    else state.comments.push(comment)
    saveState(state)
    return state
  })

  handle('deleteComment', async (repo: string, branch: string, base: string, id: string) => {
    const state = loadState(repo, branch, base)
    state.comments = state.comments.filter((c) => c.id !== id)
    saveState(state)
    return state
  })

  handle('chat', async (repo: string, branch: string, base: string, message: string, opId: string, anchor) => {
    const state = loadState(repo, branch, base)
    const sess = lastSession(state)
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
      const now = new Date().toISOString()
      state.chat.push({ role: 'user', text: message, at: now, anchor })
      state.chat.push({ role: 'agent', text: value, at: now })
      saveState(state)
      send('op:result', { opId, kind: 'chat', ok: true })
    } catch (err) {
      send('op:result', { opId, kind: 'chat', ok: false, error: String(err instanceof Error ? err.message : err) })
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
    }
  })

  handle('sendFeedback', async (repo: string, branch: string, base: string, commentIds: string[], steer, opId: string) => {
    const state = loadState(repo, branch, base)
    const sess = lastSession(state)
    if (!sess) throw new Error('Generate a review first')
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      if (await isDirty(repo)) throw new Error('Working tree is dirty — commit or stash before sending feedback')
      const cur = await currentBranch(repo)
      if (cur !== branch) throw new Error(`Repo is on ${cur}, not ${branch} — switch branches first`)
      const comments = state.comments.filter((c) => commentIds.includes(c.id) && c.status !== 'resolved')
      if (comments.length === 0 && !steer) throw new Error('Nothing to send')

      for (const c of comments) c.status = 'sent'
      saveState(state)

      const engine = makeEngine(sess.engine)
      const run = engine.applyFeedback(repo, sess.sessionId, comments, steer)
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value: fix, sessionId } = await run.result
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
      }
      state.iterations.push({
        n: state.iterations.length + 1,
        engine: sess.engine,
        sessionId,
        endSha: newHead,
        at: new Date().toISOString(),
        summary: fix.summary
      })
      saveState(state)
      send('op:result', { opId, kind: 'fix', ok: true, reload: true })
    } catch (err) {
      // roll back "sent" so comments aren't stuck
      const st = loadState(repo, branch, base)
      let changed = false
      for (const c of st.comments) {
        if (commentIds.includes(c.id) && c.status === 'sent') {
          c.status = 'queued'
          changed = true
        }
      }
      if (changed) saveState(st)
      send('op:result', { opId, kind: 'fix', ok: false, error: String(err instanceof Error ? err.message : err) })
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
    }
  })

  handle('approve', async (repo: string, branch: string, base: string) => {
    const state = loadState(repo, branch, base)
    const sha = await headSha(repo, branch)
    state.approvedSha = sha
    state.reviewedAtSha = sha
    saveState(state)
    return state
  })

  handle('authStatus', async (engine: EngineId) => {
    const home = os.homedir()
    if (engine === 'claude') {
      const ok = Boolean(process.env.ANTHROPIC_API_KEY) || fs.existsSync(path.join(home, '.claude'))
      return { ok, hint: ok ? 'Using Claude Code login or API key' : 'Run `claude` once to log in, or set ANTHROPIC_API_KEY' }
    }
    const ok = Boolean(process.env.OPENAI_API_KEY) || fs.existsSync(path.join(home, '.codex', 'auth.json'))
    return { ok, hint: ok ? 'Using codex login or API key' : 'Run `codex login`, or set OPENAI_API_KEY' }
  })
}
