import { BrowserWindow, Notification, app, dialog, ipcMain } from 'electron'
import { installCli, takeCliOpen } from './cli.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Api, DashboardData, OpEventMsg, OpResultMsg, PinData, RefOptions,
  RepoChangedMsg, UiStatePatch
} from '../shared/ipc.js'
import type { AgentRef, ApprovalDecision, Comment, CommentAnchor, EngineEvent, EngineId, ExecutionMode, RefPair, RefSide, RepoStatus, SessionMeta } from '../shared/types.js'
import { effectiveRef } from '../shared/types.js'
import {
  addWorktree, checkoutBranch, currentBranch, defaultBase, getDiff, headSha, isDirty,
  listBranches, recentCommits, repoState, resolveRefInput
} from './git.js'
import { execGit } from './exec.js'
import * as dao from './db/sessions.js'
import { buildLoadedReview, loadArtifactsFor, previewReview, resolveWorkdir } from './review.js'
import * as pins from './db/pins.js'
import { scanPin } from './scan.js'
import { importLegacyRepoFiles, seedFromConfig } from './db/import.js'
import { classify } from './artifacts.js'
import { makeEngine } from './engines/index.js'
import { createToolHost } from './engines/tools.js'
import { reduceToolCalls } from '../shared/toolcalls.js'
import { clearPending, resolveDecision } from './engines/approvals.js'
import { buildBatchPrompt } from './engines/prompts.js'
import { agentLabel } from '../shared/agents.js'
import { mergeAnnotations } from './engines/validate.js'
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

/** Forward engine events to the renderer and collect them, so the caller can fold
 *  the tool-call lifecycle into the persisted ChatMessage (wf-D). */
async function pumpEvents(opId: string, events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = []
  for await (const event of events) { collected.push(event); send('op:event', { opId, event }) }
  return collected
}

/** Add `pattern` to the repo's local `.git/info/exclude` (idempotent). Local-only —
 *  doesn't touch tracked `.gitignore` and never gets committed; shared across the
 *  repo's worktrees via the common git dir. Best-effort: never throws. */
function ignoreLocally(repo: string, pattern: string): void {
  try {
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (cur.split('\n').some((l) => l.trim() === pattern)) return
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n')
  } catch { /* excludes are a nicety; failing to write one shouldn't block the worktree */ }
}

function mustGetSession(db: DatabaseSync, id: number): SessionMeta {
  const s = dao.getSession(db, id)
  if (!s) throw new Error(`session ${id} not found`)
  return s
}

function repoCount(node: PinData['tree']): number {
  if (!node) return 0
  let n = node.kind === 'repo' ? 1 : 0
  for (const c of node.children) n += repoCount(c)
  return n
}

/** Blocking by design: scanPin is a sync depth-capped walk and results are
 *  cached — do not async-ify without preserving the cache contract. */
function buildDashboard(db: DatabaseSync, bootNotices: string[]): DashboardData {
  const pinRows = pins.listPins(db)
  const pinData: PinData[] = pinRows.map((p) => {
    let cached = pins.getScanCache(db, p.id)
    if (!cached) {
      pins.setScanCache(db, p.id, scanPin(p.path))
      cached = pins.getScanCache(db, p.id)
    }
    return { id: p.id, path: p.path, tree: cached?.tree ?? null, scannedAt: cached?.scannedAt ?? null,
      repoCount: repoCount(cached?.tree ?? null) }
  })
  const pinPaths = pinRows.map((p) => p.path)
  const recents = dao.recentRepoPaths(db, 8).filter((r) =>
    fs.existsSync(r) &&
    !pinPaths.some((pin) => r === pin || r.startsWith(pin + path.sep))
  )
  return { pins: pinData, recents, notices: bootNotices }
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

  handle('repoState', async (repo: string) => repoState(repo))

  handle('listRepoSessions', async (repo: string, includeArchived?: boolean) => dao.listRepoSessions(db, repo, includeArchived))

  handle('unarchiveSession', async (sessionId: number) => { dao.unarchiveSession(db, sessionId) })

  handle('switchBranch', async (repo: string, branch: string) => {
    await checkoutBranch(repo, branch) // throws "commit or stash first" on a dirty tree
    return repoState(repo)
  })

  // Check out the compare branch into a specific worktree (primary repo path or a
  // linked worktree path) so the review's agent edits land on the right branch.
  handle('checkoutInto', async (repo: string, worktreePath: string, branch: string) => {
    await checkoutBranch(worktreePath, branch) // throws "commit or stash first" on a dirty worktree
    return repoState(repo)
  })

  // Give `branch` its own linked worktree under the repo's `.worktrees/` dir. `name` is
  // the leaf folder (defaults to the branch name on the renderer side). git refuses if
  // the dir already exists or the branch is already checked out elsewhere.
  handle('addWorktreeFor', async (repo: string, branch: string, name: string) => {
    const leaf = name.trim() || branch
    const dir = path.join(repo, '.worktrees', leaf)
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    // a worktree nested in the repo would otherwise show as untracked `.worktrees/` and
    // dirty the primary tree (blocking checkouts there). Exclude it locally — via
    // `.git/info/exclude` so no tracked file changes and nothing gets committed.
    ignoreLocally(repo, '.worktrees/')
    await addWorktree(repo, branch, dir)
    return repoState(repo)
  })

  handle('startSession', async (repo: string, baseInput: string, compareInput: string, agent: AgentRef, fresh?: boolean) => {
    await importLegacyRepoFiles(db, repo) // repos can be entered without openRepo (CLI, plan B)
    const base = await resolveRefInput(repo, baseInput)
    const compare = await resolveRefInput(repo, compareInput)
    if (base.sha === compare.sha) throw new Error('base and compare point at the same commit')
    const pair: RefPair = {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    }
    const existing = fresh ? null : dao.findSession(db, repo, pair)
    const session = existing ?? dao.createSession(db, repo, pair, agent)
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

  // The default entry: build a review for a ref pair WITHOUT minting a session row.
  // The renderer holds it as a transient (sessionId null) and materializes via
  // startSession on the first write. Read-only — never touches the DB.
  handle('previewReview', async (repo: string, baseInput: string, compareInput: string, agent: AgentRef) =>
    previewReview(db, repo, baseInput, compareInput, agent))

  handle('archiveSession', async (sessionId: number) => {
    dao.archiveSession(db, sessionId)
    stopWatch()
  })

  handle('generate', async (sessionId: number, agent: AgentRef, opId: string) => {
    const session = mustGetSession(db, sessionId)
    const repo = session.repo
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      const baseEff = effectiveRef(session.pair.base)
      const compareEff = effectiveRef(session.pair.compare)
      const workdir = await resolveWorkdir(repo, session.pair)
      const skeleton = await getDiff(repo, baseEff, compareEff)
      const state = dao.loadReviewState(db, sessionId)
      const artifacts = await loadArtifactsFor(db, sessionId, workdir, compareEff, state.artifacts, skeleton.files.map((f) => f.path))
      const engine = makeEngine(agent.engine)
      const run = engine.generateReview({
        repo: workdir, branch: compareEff, base: baseEff, diff: skeleton, artifacts,
        model: agent.model, reasoningEffort: agent.reasoningEffort
      })
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value, sessionId: engineSession } = await run.result
      await pump
      const { annotations, warnings } = mergeAnnotations(skeleton, value)
      for (const w of warnings) send('op:event', { opId, event: { type: 'status', text: `note: ${w}` } })
      if (annotations.artifactPaths) {
        // accept agent-reported paths only when they match a recognized format —
        // the role comes from the convention, never a guess
        const refs = [...state.artifacts]
        for (const p of annotations.artifactPaths) {
          const hit = classify(p)
          if (hit && !refs.some((a) => a.path === p) && fs.existsSync(path.join(workdir, p))) {
            refs.push({ role: hit.role, path: p })
          }
        }
        dao.setArtifacts(db, sessionId, refs)
      }
      dao.updateSessionMeta(db, sessionId, {
        engine: agent.engine, model: agent.model ?? null, reasoningEffort: agent.reasoningEffort ?? null,
        annotations, title: annotations.title, summary: annotations.summary,
        reviewedAtSha: skeleton.headSha
      })
      dao.resetIterations(db, sessionId, { n: 1, engine: agent.engine, sessionId: engineSession, endSha: skeleton.headSha, at: new Date().toISOString() })
      dao.reconcileChats(db, sessionId) // create default chats / resync review chat to the new engine session
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
      clearPending(opId)   // settle any approvals still parked when the turn ends
    }
  })

  handle('cancel', async (opId: string) => {
    activeOps.get(opId)?.()
    activeOps.delete(opId)
    clearPending(opId)   // auto-deny any parked approvals so no promise leaks
  })

  handle('respondApproval', async (opId: string, requestId: string, decision: ApprovalDecision) => {
    resolveDecision(opId, requestId, decision)
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

  handle('sendChat', async (threadId: number, message: string, opId: string, anchor?: CommentAnchor) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    const thread = dao.getChatThread(db, threadId)
    if (sid == null || !thread) throw new Error('chat thread not found')
    const session = mustGetSession(db, sid)
    const repo = session.repo
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      const workdir = await resolveWorkdir(repo, session.pair)
      const state = dao.loadReviewState(db, sid)
      const engine = makeEngine(thread.agent.engine)
      // the localreview tool layer for this turn: focus/suggest run live (read-only
      // on code in interactive chat); actions emit straight to the renderer.
      const tools = createToolHost({
        db, sessionId: sid, threadId, opId, repo: workdir, agent: thread.agent, writeEnabled: false,
        emit: (event) => send('op:event', { opId, event })
      })
      // resume the thread's engine session if it has one; otherwise seed a fresh
      // session with review context (a chat agent that didn't write the review
      // has nothing to resume).
      const run = engine.chat({
        repo: workdir,
        engineSessionId: thread.engineSessionId,
        model: thread.agent.model,
        reasoningEffort: thread.agent.reasoningEffort,
        message,
        anchor,
        tools,
        opId,
        executionMode: thread.executionMode,
        context: thread.engineSessionId
          ? undefined
          : { base: state.base, branch: state.branch, summary: state.annotations?.summary }
      })
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value, sessionId: engineSession } = await run.result
      const events = await pump
      const at = new Date().toISOString()
      const actions = tools.collected()
      const toolCalls = reduceToolCalls(events)
      dao.addChatMessage(db, threadId, { role: 'user', text: message, at, anchor })
      dao.addChatMessage(db, threadId, { role: 'agent', text: value, at, ...(actions.length ? { actions } : {}), ...(toolCalls.length ? { tools: toolCalls } : {}) })
      if (engineSession) dao.setThreadEngineSession(db, threadId, engineSession)
      send('op:result', { opId, kind: 'chat', ok: true })
    } catch (err) {
      send('op:result', { opId, kind: 'chat', ok: false, error: String(err instanceof Error ? err.message : err) })
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
      clearPending(opId)   // settle any approvals still parked when the turn ends
    }
  })

  handle('createChat', async (sessionId: number, agent: AgentRef) => {
    dao.createChatThread(db, sessionId, { kind: 'user', agent, title: 'New chat' })
    return dao.listChatThreads(db, sessionId)
  })

  handle('setChatAgent', async (threadId: number, agent: AgentRef) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    if (sid == null) throw new Error('chat thread not found')
    dao.setThreadAgent(db, threadId, agent)
    return dao.listChatThreads(db, sid)
  })

  handle('setChatMode', async (threadId: number, mode: ExecutionMode) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    if (sid == null) throw new Error('chat thread not found')
    dao.setThreadMode(db, threadId, mode)
    return dao.listChatThreads(db, sid)
  })

  handle('deleteChat', async (threadId: number) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    if (sid == null) throw new Error('chat thread not found')
    dao.deleteChatThread(db, threadId)
    return dao.listChatThreads(db, sid)
  })

  // The unified batch turn: hand a thread's agent the queued comments; it edits &
  // commits code, resolves, or replies via its tools. Replaces the old fix flow.
  handle('sendBatch', async (threadId: number, commentIds: string[], steer, opId: string) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    const thread = dao.getChatThread(db, threadId)
    if (sid == null || !thread) throw new Error('chat thread not found')
    const session = mustGetSession(db, sid)
    const repo = session.repo
    if (repoLocks.has(repo)) throw new Error('Another agent operation is running for this repository')
    repoLocks.add(repo)
    try {
      // write guards (same preconditions the old fix flow enforced): the compare
      // side is a branch checked out (in primary OR a linked worktree) and that
      // worktree is clean. Edits + commits run in that worktree. When unmet, the
      // agent runs write-disabled (review/comment-only) rather than failing.
      const workdir = await resolveWorkdir(repo, session.pair)
      let writeEnabled = false
      if (session.pair.compare.kind === 'branch') {
        const branch = session.pair.compare.symbol
        writeEnabled = workdir !== repo
          ? !(await isDirty(workdir))                                   // linked worktree holds the branch by construction
          : !(await isDirty(repo)) && (await currentBranch(repo)) === branch
      }
      const state = dao.loadReviewState(db, sid)
      const comments = state.comments.filter((c) => commentIds.includes(c.id) && c.status !== 'resolved')
      if (comments.length === 0 && !steer) throw new Error('Nothing to send')
      for (const c of comments) { c.status = 'sent'; dao.upsertComment(db, sid, c) }

      const engine = makeEngine(thread.agent.engine)
      const tools = createToolHost({
        db, sessionId: sid, threadId, opId, repo: workdir, agent: thread.agent, writeEnabled,
        engineSessionId: thread.engineSessionId, emit: (event) => send('op:event', { opId, event })
      })
      const run = engine.chat({
        repo: workdir, engineSessionId: thread.engineSessionId, model: thread.agent.model, reasoningEffort: thread.agent.reasoningEffort,
        message: buildBatchPrompt(comments, steer, thread.engineSessionId ? undefined : { base: state.base, branch: state.branch, summary: state.annotations?.summary }),
        tools, writeEnabled, opId, executionMode: thread.executionMode
      })
      activeOps.set(opId, run.cancel)
      const pump = pumpEvents(opId, run.events)
      const { value, sessionId: engineSession } = await run.result
      const events = await pump

      // statuses now reflect the agent's resolve/commit tool calls; anything left
      // 'sent' (un-addressed) rolls back to 'queued' so it isn't lost.
      const after = dao.loadReviewState(db, sid)
      for (const c of after.comments) {
        if (commentIds.includes(c.id) && c.status === 'sent') { c.status = 'queued'; dao.upsertComment(db, sid, c) }
      }
      const at = new Date().toISOString()
      const actions = tools.collected()
      const toolCalls = reduceToolCalls(events)
      dao.addChatMessage(db, threadId, {
        role: 'user', at,
        text: steer?.trim() ? `Handle ${comments.length} comment(s) — ${steer.trim()}` : `Handle ${comments.length} comment(s).`
      })
      dao.addChatMessage(db, threadId, { role: 'agent', text: value, at, ...(actions.length ? { actions } : {}), ...(toolCalls.length ? { tools: toolCalls } : {}) })
      if (engineSession) dao.setThreadEngineSession(db, threadId, engineSession)
      send('op:result', { opId, kind: 'chat', ok: true, reload: true })
      const resolved = after.comments.filter((c) => commentIds.includes(c.id) && c.status === 'resolved').length
      notifyIfUnfocused('Agent handled your comments', `${resolved}/${commentIds.length} resolved — ${agentLabel(thread.agent)}`)
    } catch (err) {
      // roll back "sent" so comments aren't stuck
      const st = dao.loadReviewState(db, sid)
      for (const c of st.comments) {
        if (commentIds.includes(c.id) && c.status === 'sent') { c.status = 'queued'; dao.upsertComment(db, sid, c) }
      }
      send('op:result', { opId, kind: 'chat', ok: false, error: String(err instanceof Error ? err.message : err) })
      notifyIfUnfocused('Agent batch run failed', String(err instanceof Error ? err.message : err).slice(0, 120))
    } finally {
      repoLocks.delete(repo)
      activeOps.delete(opId)
      clearPending(opId)   // settle any approvals still parked when the turn ends
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

  handle('dashboard', async () => buildDashboard(db, bootNotices))

  handle('addPin', async (dirPath: string) => {
    const id = pins.addPin(db, dirPath)
    pins.setScanCache(db, id, scanPin(dirPath))
    return buildDashboard(db, bootNotices)
  })

  handle('removePin', async (id: number) => {
    pins.removePin(db, id)
    return buildDashboard(db, bootNotices)
  })

  handle('rescanPin', async (id: number) => {
    const pin = pins.listPins(db).find((p) => p.id === id)
    if (pin) pins.setScanCache(db, id, scanPin(pin.path))
    return buildDashboard(db, bootNotices)
  })

  handle('repoStatus', async (repoPaths: string[]) => {
    const out: Record<string, RepoStatus> = {}
    const results = await Promise.allSettled(repoPaths.map(async (p) => {
      const [branch, dirty] = await Promise.all([currentBranch(p), isDirty(p)])
      return { path: p, status: { branch, dirty } satisfies RepoStatus }
    }))
    for (const r of results) {
      if (r.status === 'fulfilled') out[r.value.path] = r.value.status
    }
    return out
  })

  handle('refOptions', async (repo: string, relativeTo: string) => {
    const branches = await listBranches(repo)
    const base = await defaultBase(repo)
    // recentCommits throws on an unresolvable ref — an in-flight typed ref is normal here
    const commits = await recentCommits(repo, relativeTo, 50).catch(() => [])
    return { branches, defaultBase: base, commits } satisfies RefOptions
  })

  handle('retargetSession', async (sessionId: number, side: 'base' | 'compare', refInput: string) => {
    const session = mustGetSession(db, sessionId)
    const resolved = await resolveRefInput(session.repo, refInput)
    const refSide: RefSide = { kind: resolved.kind, symbol: resolved.symbol, anchorSha: resolved.sha }
    try {
      dao.retargetSession(db, sessionId, side, refSide)
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new Error('A live session for that exact ref pair already exists — resume it instead')
      throw err
    }
  })

  handle('installCli', async () => installCli())
  handle('takeCliOpen', async () => takeCliOpen())
}
