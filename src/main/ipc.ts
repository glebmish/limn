import { installCli, takeCliOpen } from './cli.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { Transport } from './transport.js'
import type {
  Api, DashboardData, OpEventMsg, OpResultMsg, OperationStatus, RefOptions,
  RepoChangedMsg, UiStatePatch
} from '../shared/ipc.js'
import type { AgentRef, ApprovalDecision, Comment, CommentAnchor, EngineEvent, EngineId, ExecutionMode, RefPair, RefSide, RepoIndexEntry, SessionMeta } from '../shared/types.js'
import { driftHasChanges, effectiveRef } from '../shared/types.js'
import {
  addWorktree, branchCheckedOutAt, checkoutBranch, currentBranch, defaultBase, driftSummary, getDiff, hashObjects, headSha,
  listBranches, recentCommits, repoState, resolveRefInput, untrackedDiffs
} from './git.js'
import { execGit } from './exec.js'
import * as dao from './db/sessions.js'
import { buildLoadedReview, loadArtifactsFor, previewReview, resolveWorkdir, writeCapabilityFor } from './review.js'
import { classify, loadArtifact, normalizeArtifactPath } from './artifacts.js'
import { makeEngine } from './engines/index.js'
import { createToolHost } from './engines/tools.js'
import { reduceToolCalls, reduceSegments } from '../shared/toolcalls.js'
import { resolveDecision } from './engines/approvals.js'
import { buildBatchPrompt, buildAnswerPrompt } from './engines/prompts.js'
import { agentLabel } from '../shared/agents.js'
import { mergeAnnotations } from './engines/validate.js'
import { engineBinaryStatus, setEngineBinaryPrefs } from './engines/binaries.js'
import { assertSafeWorktreeName, suggestedWorktreeName } from '../shared/worktrees.js'
import { OperationCoordinator } from './operations.js'
import { ENGINE_PATH_PREF_KEYS } from '../shared/prefs.js'

const operations = new OperationCoordinator()

/** Cap on untracked files offered to the narration as section candidates — past this
 *  the overflow stays orphan (auto-excluded), keeping a scratch-heavy tree from
 *  flooding the prompt. */
const MAX_UNTRACKED_OFFERED = 40

// Set once by registerIpc. All push/notify/dialog calls route through it, so this
// module is identical whether it's carried by Electron IPC or the web server.
let transport: Transport

// ── watch mode: poll the open review's branch; notify (don't auto-reload) when the
// branch head moves OR its working tree changes, carrying a drift summary "since the
// loaded snapshot" so the titlebar can show the fetch pill. The reviewer clicks to
// fold it in (reload); we never yank the surface out from under them.
let watcher: {
  timer: NodeJS.Timeout; repo: string; branch: string; workdir: string | null
  loadedSha: string; loadSig: string; lastSig: string
} | null = null

/** Change detector + current head. For dirty worktrees this hashes actual diff
 *  content, not just porcelain shape, so editing an already-dirty file emits a new
 *  pending update. */
async function watchState(repo: string, branch: string, workdir: string | null): Promise<{ head: string; sig: string }> {
  const head = await headSha(repo, branch)
  if (!workdir) return { head, sig: `${head}\n` }
  const porcelain = (await execGit(workdir, ['status', '--porcelain'])).trim()
  if (!porcelain) return { head, sig: `${head}\n` }
  const h = createHash('sha256')
  h.update(`head\0${head}\0status\0${porcelain}\0`)
  h.update(await execGit(workdir, ['diff', '--binary', 'HEAD']))
  const untracked = (await execGit(workdir, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0').filter(Boolean)
  const hashes = await hashObjects(workdir, untracked)
  for (const p of untracked.sort()) h.update(`untracked\0${p}\0${hashes.get(p) ?? ''}\0`)
  return { head, sig: `${head}\n${h.digest('hex')}` }
}

async function startWatch(repo: string, branch: string, loadedSha: string): Promise<void> {
  stopWatch()
  const workdir = await branchCheckedOutAt(repo, branch)
  const loadSig = await watchState(repo, branch, workdir).then((s) => s.sig).catch(() => `${loadedSha}\n`)
  const w = { repo, branch, workdir, loadedSha, loadSig, lastSig: loadSig, timer: setInterval(() => void poll(), 500) }
  watcher = w
  async function poll(): Promise<void> {
    if (operations.repoBusy(repo)) return // our own agent op — reload arrives via op:result
    try {
      const { head, sig } = await watchState(repo, branch, w.workdir)
      if (sig === w.lastSig) return
      w.lastSig = sig
      // drift is measured against the LOAD-time state: null when the tree returns
      // to it; dirty-only changes still broadcast so worktree indicators stay live.
      const d = sig === w.loadSig ? null : await driftSummary(repo, branch, w.loadedSha, w.workdir)
      const drift = driftHasChanges(d) ? d : null
      const writeCapability = await writeCapabilityFor(repo, { kind: 'branch', symbol: branch, anchorSha: head })
      send('repo:changed', { repo, branch, headSha: head, drift, writeCapability })
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
  transport.broadcast(channel, msg)
}

function sendOpResult(opId: string, kind: 'review' | 'chat', status: OperationStatus, error?: string, reload?: boolean): void {
  send('op:result', { opId, kind, status, ...(error ? { error } : {}), ...(reload ? { reload: true } : {}) })
}

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/** Notify that a long-running agent op finished. Whether this surfaces (and the
 *  "only when unfocused" gate) is the transport's call — desktop shows a native
 *  notification when the window is in the background; the web server no-ops. */
function notifyIfUnfocused(title: string, body: string): void {
  transport.notify(title, body)
}

function batchUserMessage(comments: Comment[], state: ReturnType<typeof dao.loadReviewState>, refine?: boolean, steer?: string): string {
  if (refine) {
    const byId = new Map((state.annotations?.questions ?? []).map((q) => [q.id, q]))
    const lines = comments.map((c) => {
      const qid = c.anchor.kind === 'question' ? c.anchor.questionId : ''
      const q = byId.get(qid)
      const label = q?.text ?? q?.context ?? (qid || 'Open question')
      return `- ${label}\n  Answer: ${c.text}`
    })
    return `Answered ${comments.length} open question${comments.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
  }
  return steer?.trim() ? `Handle ${comments.length} comment(s) - ${steer.trim()}` : `Handle ${comments.length} comment(s).`
}

/** Forward operation events to the renderer and collect them, so the caller can fold
 *  the tool-call/action lifecycle into the persisted ChatMessage. Tool-host actions
 *  use the same recorder as engine events so segments preserve true stream order. */
function opRecorder(opId: string): { events: EngineEvent[]; emit: (event: EngineEvent) => void } {
  const events: EngineEvent[] = []
  const emit = (event: EngineEvent): void => {
    events.push(event)
    send('op:event', { opId, event })
  }
  return { events, emit }
}

async function pumpEvents(events: AsyncIterable<EngineEvent>, emit: (event: EngineEvent) => void): Promise<void> {
  for await (const event of events) emit(event)
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

/** Run writes in one transaction. node:sqlite has no better-sqlite3 `db.transaction()`,
 *  so mirror the dao's BEGIN/COMMIT/ROLLBACK pattern. Not re-entrant — `fn` must not
 *  call a dao helper that opens its own transaction (e.g. setArtifacts). */
function inTx(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no active txn — keep original error */ }
    throw err
  }
}

function mustGetSession(db: DatabaseSync, id: number): SessionMeta {
  const s = dao.getSession(db, id)
  if (!s) throw new Error(`session ${id} not found`)
  return s
}

/** The repo index reads light git state per repo (repoState), so the whole builder
 *  is async; the only caller is the (already async) dashboard handler. */
async function buildDashboard(db: DatabaseSync, bootNotices: string[]): Promise<DashboardData> {
  const recents = dao.recentRepoPaths(db, 8).filter((r) => fs.existsSync(r))
  // session-level "Recent": the most recent sessions across these repos, each a
  // row you can resume directly (a repo with several sessions lists each one)
  const recentSessions = dao.recentSessions(db, recents, 25)
  // Level-1 index: every opened repo plus every repo with ≥1 live session,
  // newest-activity first, each carrying the light git state its row shows. Repos
  // whose path has vanished or no longer reads as a git repo are skipped.
  const repoRows = dao.repoIndexRows(db)
  const repos: RepoIndexEntry[] = []
  for (const row of repoRows) {
    if (!fs.existsSync(row.path)) continue
    try {
      const st = await repoState(row.path)
      repos.push({
        path: row.path, current: st.current, defaultBase: st.defaultBase,
        worktrees: st.worktrees,
        sessionCount: row.sessionCount, lastActivity: row.lastActivity
      })
    } catch { /* unreadable repo — leave it out of the index */ }
  }
  return { repos, recents, recentSessions, notices: bootNotices }
}

export function registerIpc(db: DatabaseSync, bootNotices: string[], t: Transport): void {
  transport = t
  const handle = <K extends keyof Api>(name: K, fn: Api[K]): void => {
    transport.handle(name, (...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  const readPrefs = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const r of db.prepare('SELECT key, value FROM prefs').all() as { key: string; value: string }[]) {
      out[r.key] = r.value
    }
    return out
  }
  setEngineBinaryPrefs(readPrefs())

  handle('pickRepo', async () => transport.pickDirectory())

  handle('recentRepos', async () => dao.recentRepoPaths(db, 8).filter((r) => fs.existsSync(r)))

  handle('openRepo', async (repo: string) => {
    if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a git repository`)
    dao.touchRepo(db, repo)
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
    const leaf = assertSafeWorktreeName(name.trim() || suggestedWorktreeName(branch))
    const root = path.resolve(repo, '.worktrees')
    const dir = path.resolve(root, leaf)
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new Error('Worktree path must stay under .worktrees')
    }
    fs.mkdirSync(root, { recursive: true })
    // a worktree nested in the repo would otherwise show as untracked `.worktrees/` and
    // dirty the primary tree (blocking checkouts there). Exclude it locally — via
    // `.git/info/exclude` so no tracked file changes and nothing gets committed.
    ignoreLocally(repo, '.worktrees/')
    await addWorktree(repo, branch, dir)
    return repoState(repo)
  })

  handle('startSession', async (repo: string, baseInput: string, compareInput: string, agent: AgentRef, fresh?: boolean) => {
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

  handle('findSession', async (repo: string, baseInput: string, compareInput: string) => {
    const base = await resolveRefInput(repo, baseInput)
    const compare = await resolveRefInput(repo, compareInput)
    if (base.sha === compare.sha) return null
    const pair: RefPair = {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    }
    const session = dao.findSession(db, repo, pair)
    return session ? { sessionId: session.id } : null
  })

  handle('loadSession', async (sessionId: number) => {
    const session = mustGetSession(db, sessionId)
    // clean up review threads orphaned by a hard crash mid-generation (a lone user
    // turn, no engine session); the in-flight op's thread is exempt.
    dao.pruneOrphanReviewThreads(db, sessionId, operations.activeReviewThreadIds())
    // drop empty user chats (no messages, no engine session) — legacy persisted
    // "New chat" companions and any orphaned draft. Never touches a chat with a
    // message or a bound engine session.
    dao.pruneEmptyUserChats(db, sessionId)
    const loaded = await buildLoadedReview(db, session)
    if (!loaded.refMissing && session.pair.compare.kind === 'branch') {
      void startWatch(session.repo, session.pair.compare.symbol, loaded.skeleton.headSha)
    } else {
      stopWatch()
    }
    return loaded
  })

  // The default entry: build a review for a ref pair WITHOUT minting a session row.
  // The renderer holds it as a transient (sessionId null) and materializes via
  // startSession on the first write. Read-only — never touches the DB.
  handle('previewReview', async (repo: string, baseInput: string, compareInput: string, agent: AgentRef) => {
    const loaded = await previewReview(db, repo, baseInput, compareInput, agent)
    if (!loaded.refMissing && loaded.session.pair.compare.kind === 'branch') {
      void startWatch(repo, loaded.session.pair.compare.symbol, loaded.skeleton.headSha)
    } else {
      stopWatch()
    }
    return loaded
  })

  handle('archiveSession', async (sessionId: number) => {
    dao.archiveSession(db, sessionId)
    stopWatch()
  })

  // Create the review thread up front so the review agent is a real, persisted
  // chat from the moment generation starts (the live stream renders through the
  // normal chat path). The matching `generate(...threadId...)` call finalizes it.
  handle('beginReview', async (sessionId: number, agent: AgentRef, update?: boolean, steer?: string) => {
    const session = mustGetSession(db, sessionId)
    const existing = update
      ? dao.listChatThreads(db, sessionId).filter((t) => t.kind === 'review').at(-1)
      : undefined
    const thread = existing ?? dao.createChatThread(db, sessionId, { kind: 'review', agent, title: 'Review agent' })
    operations.markReviewThread(thread.id)
    const action = existing ? 'Update' : 'Generate'
    const note = steer?.trim()
    dao.addChatMessage(db, thread.id, {
      role: 'user', at: new Date().toISOString(),
      text: `${action} a guided review of ${session.pair.compare.symbol} against ${session.pair.base.symbol}.${note ? `\n\nReviewer steer: ${note}` : ''}`
    })
    return thread.id
  })

  handle('generate', async (sessionId: number, agent: AgentRef, opId: string, reviewThreadId: number, steer?: string, update?: boolean) => {
    const session = mustGetSession(db, sessionId)
    const repo = session.repo
    const outcome = await operations.run(opId, repo, async () => {
      const baseEff = effectiveRef(session.pair.base)
      const compareEff = effectiveRef(session.pair.compare)
      const workdir = await resolveWorkdir(repo, session.pair)
      const skeleton = await getDiff(repo, baseEff, compareEff)
      // Offer untracked files as optional section candidates so the agent can fold the
      // relevant ones (a new test, a new module) into the narration. Capped so a tree
      // full of scratch/build files can't flood the prompt — the overflow stays orphan
      // and is auto-excluded, same as any unsectioned untracked file.
      const untracked = (await untrackedDiffs(workdir)).slice(0, MAX_UNTRACKED_OFFERED)
      const untrackedPaths = new Set(untracked.map((f) => f.path))
      const genDiff = untracked.length ? { ...skeleton, files: [...skeleton.files, ...untracked] } : skeleton
      const state = dao.loadReviewState(db, sessionId)
      const artifacts = await loadArtifactsFor(db, sessionId, workdir, compareEff, state.artifacts, skeleton.files.map((f) => f.path))
      // "Update review": fold the new drift commits into the existing narration
      // instead of re-narrating from scratch. Only meaningful if a review exists.
      const prior = update && state.annotations
        ? {
            title: state.annotations.title,
            summary: state.annotations.summary,
            sections: state.annotations.sections.map((s) => s.name),
            sinceSha: state.reviewedAtSha
          }
        : undefined
      // a cancel during the pre-engine async setup above lands before run.cancel is
      // registered, so it would otherwise be a no-op and the engine would launch
      // anyway. Check here (no await before activeOps.set, so the window is closed)
      // and bail via the catch, which writes the cancelled note + op:result.
      operations.throwIfCancelled(opId)
      const engine = makeEngine(agent.engine)
      const run = engine.generateReview({
        repo: workdir, branch: compareEff, base: baseEff, diff: genDiff, artifacts,
        model: agent.model, reasoningEffort: agent.reasoningEffort,
        steer: steer?.trim() || undefined, prior
      })
      operations.registerCancel(opId, run.cancel)
      const recorder = opRecorder(opId)
      const pump = pumpEvents(run.events, recorder.emit)
      const { value, sessionId: engineSession } = await run.result
      await pump
      const { annotations, warnings } = mergeAnnotations(skeleton, value, untrackedPaths)
      annotations.generatedBy = agent   // lock "Guided by" to the producing agent

      for (const w of warnings) send('op:event', { opId, event: { type: 'status', text: `note: ${w}` } })
      if (annotations.artifactPaths) {
        // accept agent-reported paths only when they match a recognized format —
        // the role comes from the convention, never a guess
        const refs = [...state.artifacts]
        for (const p of annotations.artifactPaths) {
          const rel = normalizeArtifactPath(p)
          if (!rel) continue
          const hit = classify(rel)
          if (hit && !refs.some((a) => a.path === rel)) {
            try {
              loadArtifact(workdir, rel, hit.role)
              refs.push({ role: hit.role, path: rel })
            } catch {
              // unsafe, missing, unreadable, or symlink-escaping artifact path
            }
          }
        }
        dao.setArtifacts(db, sessionId, refs)
      }
      const iterationN = dao.nextIterationNumber(db, sessionId)
      // the meta + review-thread finalization are one atomic group: a crash mid-way
      // must not leave annotations saved without the review thread bound to them.
      inTx(db, () => {
        dao.addIteration(db, sessionId, {
          n: iterationN,
          engine: agent.engine,
          sessionId: engineSession,
          endSha: skeleton.headSha,
          at: new Date().toISOString(),
          title: annotations.title,
          summary: annotations.summary,
          annotations
        })
        dao.updateSessionMeta(db, sessionId, {
          engine: agent.engine, model: agent.model ?? null, reasoningEffort: agent.reasoningEffort ?? null,
          annotations, title: annotations.title, summary: annotations.summary,
          reviewedAtSha: skeleton.headSha
        })
        // finalize the review thread created at op start: bind it to the engine
        // session that produced the review and persist the agent's turn (the user
        // turn was persisted by beginReview). The thread IS the review agent's
        // history — generation first, later comment/decision turns after.
        if (dao.getChatThread(db, reviewThreadId)) {
          const at = new Date().toISOString()
          const genTools = reduceToolCalls(recorder.events)
          dao.setThreadEngineSession(db, reviewThreadId, engineSession)
          dao.setThreadAgent(db, reviewThreadId, agent) // lock to the producing agent
          dao.addChatMessage(db, reviewThreadId, {
            role: 'agent', at,
            text: annotations.summary || `Produced a ${annotations.sections.length}-section guided review.`,
            ...(genTools.length ? { tools: genTools } : {})
          })
        }
      })
      return annotations.sections.length
    })

    if (outcome.status === 'succeeded') {
      sendOpResult(opId, 'review', 'succeeded', undefined, true)
      notifyIfUnfocused('Guided review ready', `${outcome.value} sections — ${session.pair.compare.symbol}`)
    } else {
      const err = outcome.error
      // off-schema/empty engine output surfaces as a raw ZodError from
      // parseReviewOutput — keep the dump in the log, show the user plain English.
      const msg = err instanceof Error && err.name === 'ZodError'
        ? 'The agent returned an unexpected or empty review format — try regenerating.'
        : errorMessage(err)
      const cancelled = outcome.status === 'cancelled'
      console.error('[generate] failed:', err)
      // keep the review thread, noting the outcome, so a cancelled/failed run stays
      // visible in chat history (the user turn is already persisted). reload:true so
      // the drawer picks up the note.
      if (dao.getChatThread(db, reviewThreadId)) {
        dao.addChatMessage(db, reviewThreadId, {
          role: 'agent', at: new Date().toISOString(),
          text: cancelled ? 'Generation cancelled.' : `Generation failed: ${msg}`
        })
      }
      sendOpResult(opId, 'review', outcome.status, cancelled ? undefined : msg, true)
      if (!cancelled) notifyIfUnfocused('Review generation failed', msg.slice(0, 120))
    }
    operations.unmarkReviewThread(reviewThreadId)
  })

  handle('copyReviewFrom', async (sourceSessionId: number, sourceIteration: number, targetSessionId: number) => {
    const target = mustGetSession(db, targetSessionId)
    const targetEndSha = await headSha(target.repo, effectiveRef(target.pair.compare))
    dao.copyGeneratedReview(db, sourceSessionId, sourceIteration, targetSessionId, targetEndSha)
    return dao.loadReviewState(db, targetSessionId)
  })

  handle('cancel', async (opId: string) => {
    operations.cancel(opId)
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
    const outcome = await operations.run(opId, repo, async () => {
      const workdir = await resolveWorkdir(repo, session.pair)
      const state = dao.loadReviewState(db, sid)
      const engine = makeEngine(thread.agent.engine)
      // the limn tool layer for this turn: focus/suggest run live (read-only
      // on code in interactive chat); actions emit straight to the renderer.
      const recorder = opRecorder(opId)
      const tools = createToolHost({
        db, sessionId: sid, threadId, opId, repo: workdir, agent: thread.agent,
        emit: recorder.emit
      })
      // a cancel during the async setup above lands before run.cancel is registered;
      // catch it here (no await before activeOps.set) so the engine never launches.
      operations.throwIfCancelled(opId)
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
      // persist the user turn up front so a failed/cancelled run doesn't silently
      // drop what the reviewer typed (mirrors the generate path).
      dao.addChatMessage(db, threadId, { role: 'user', text: message, at: new Date().toISOString(), anchor })
      operations.registerCancel(opId, run.cancel)
      const pump = pumpEvents(run.events, recorder.emit)
      const { value, sessionId: engineSession } = await run.result
      await pump
      const at = new Date().toISOString()
      const actions = tools.collected()
      const toolCalls = reduceToolCalls(recorder.events)
      const segments = reduceSegments(recorder.events)
      // auto-title a user chat from its first message (re-checked at persist time so
      // a concurrent turn can't double-title). The review thread keeps its own title.
      // The user turn is now persisted up front, so "first message" means exactly that
      // one message is present (== 1), not an empty thread.
      if (thread.kind === 'user' && !thread.title) {
        const current = dao.getChatThread(db, threadId)
        if (current && current.messages.length === 1) dao.setThreadTitle(db, threadId, dao.deriveChatTitle(message))
      }
      dao.addChatMessage(db, threadId, { role: 'agent', text: value, at, ...(actions.length ? { actions } : {}), ...(toolCalls.length ? { tools: toolCalls } : {}), ...(segments.length ? { segments } : {}) })
      if (engineSession) dao.setThreadEngineSession(db, threadId, engineSession)
    })
    if (outcome.status === 'succeeded') {
      sendOpResult(opId, 'chat', 'succeeded')
    } else {
      const cancelled = outcome.status === 'cancelled'
      const msg = errorMessage(outcome.error)
      // the user turn is already persisted; on a genuine failure record an agent note
      // so the thread shows what happened (a user cancel stays quiet), and reload so the
      // user message (and any note) surface in the drawer.
      if (!cancelled) dao.addChatMessage(db, threadId, { role: 'agent', text: `Turn failed: ${msg}`, at: new Date().toISOString() })
      sendOpResult(opId, 'chat', outcome.status, cancelled ? undefined : msg, true)
    }
  })

  handle('createChat', async (sessionId: number, agent: AgentRef, executionMode?: ExecutionMode) => {
    // title stays null — the renderer shows "New chat" for an untitled chat and the
    // first message auto-derives a real title (see sendChat).
    dao.createChatThread(db, sessionId, { kind: 'user', agent, executionMode })
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

  handle('dismissSuggestion', async (threadId: number, actionId: string) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    if (sid == null) throw new Error('chat thread not found')
    dao.setActionResolution(db, threadId, actionId, 'dismissed')
    return dao.listChatThreads(db, sid)
  })

  handle('deleteChat', async (threadId: number) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    if (sid == null) throw new Error('chat thread not found')
    dao.deleteChatThread(db, threadId)
    return dao.listChatThreads(db, sid)
  })

  // The unified batch turn: hand a thread's agent the queued comments; it edits &
  // commits code, resolves, or replies via its tools.
  handle('sendBatch', async (threadId: number, commentIds: string[], steer, opId: string, refine?: boolean) => {
    const sid = dao.chatThreadSessionId(db, threadId)
    const thread = dao.getChatThread(db, threadId)
    if (sid == null || !thread) throw new Error('chat thread not found')
    const session = mustGetSession(db, sid)
    const repo = session.repo
    const outcome = await operations.run(opId, repo, async () => {
      // Write guards are computed from the same capability object the renderer
      // consumes. A refine turn (answering an intent question) stays read-only.
      const capability = await writeCapabilityFor(repo, session.pair.compare)
      const workdir = capability.workdir ?? repo
      if (!refine && !capability.enabled) {
        const reason = capability.reason === 'dirty'
          ? 'the working tree has uncommitted changes'
          : capability.reason === 'not-checked-out'
            ? 'the compare branch is not checked out'
            : 'the compare side is not a writable branch'
        throw new Error(`Agent edits are unavailable because ${reason}`)
      }
      const writeEnabled = !refine
      const state = dao.loadReviewState(db, sid)
      const comments = state.comments.filter((c) => commentIds.includes(c.id) && c.status !== 'resolved')
      if (comments.length === 0 && !steer) throw new Error('Nothing to send')
      for (const c of comments) { c.status = 'sent'; dao.upsertComment(db, sid, c) }
      const userAt = new Date().toISOString()
      dao.addChatMessage(db, threadId, {
        role: 'user',
        at: userAt,
        text: batchUserMessage(comments, state, refine, steer),
        ...(comments.length ? { commentRefs: comments.map((c) => c.id) } : {})
      })

      const engine = makeEngine(thread.agent.engine)
      const recorder = opRecorder(opId)
      const tools = createToolHost({
        db, sessionId: sid, threadId, opId, repo: workdir, agent: thread.agent,
        engineSessionId: thread.engineSessionId, emit: recorder.emit
      })
      // cancel during setup → bail before the (write-enabled) engine launches, so a
      // stopped batch can't still edit/commit the worktree.
      operations.throwIfCancelled(opId)
      const run = engine.chat({
        repo: workdir, engineSessionId: thread.engineSessionId, model: thread.agent.model, reasoningEffort: thread.agent.reasoningEffort,
        message: refine
          ? buildAnswerPrompt(comments, thread.engineSessionId ? undefined : { base: state.base, branch: state.branch, summary: state.annotations?.summary })
          : buildBatchPrompt(comments, steer, thread.engineSessionId ? undefined : { base: state.base, branch: state.branch, summary: state.annotations?.summary }),
        tools, writeEnabled, opId, executionMode: thread.executionMode
      })
      operations.registerCancel(opId, run.cancel)
      const pump = pumpEvents(run.events, recorder.emit)
      const { value, sessionId: engineSession } = await run.result
      await pump

      // statuses now reflect the agent's resolve/commit tool calls; anything left
      // 'sent' (un-addressed) rolls back to 'queued' so it isn't lost.
      const after = dao.loadReviewState(db, sid)
      for (const c of after.comments) {
        if (commentIds.includes(c.id) && c.status === 'sent') { c.status = 'queued'; dao.upsertComment(db, sid, c) }
      }
      const at = new Date().toISOString()
      const actions = tools.collected()
      const toolCalls = reduceToolCalls(recorder.events)
      const segments = reduceSegments(recorder.events)
      dao.addChatMessage(db, threadId, { role: 'agent', text: value, at, ...(actions.length ? { actions } : {}), ...(toolCalls.length ? { tools: toolCalls } : {}), ...(segments.length ? { segments } : {}) })
      if (engineSession) dao.setThreadEngineSession(db, threadId, engineSession)
      const resolved = after.comments.filter((c) => commentIds.includes(c.id) && c.status === 'resolved').length
      return resolved
    })
    if (outcome.status === 'succeeded') {
      sendOpResult(opId, 'chat', 'succeeded', undefined, true)
      notifyIfUnfocused('Agent handled your comments', `${outcome.value}/${commentIds.length} resolved — ${agentLabel(thread.agent)}`)
    } else {
      // roll back "sent" so comments aren't stuck
      const st = dao.loadReviewState(db, sid)
      for (const c of st.comments) {
        if (commentIds.includes(c.id) && c.status === 'sent') { c.status = 'queued'; dao.upsertComment(db, sid, c) }
      }
      const cancelled = outcome.status === 'cancelled'
      const msg = errorMessage(outcome.error)
      // on a genuine failure record an agent note so the thread shows what happened (a
      // user cancel stays quiet), and reload so it surfaces — mirrors the sendChat path.
      if (!cancelled) dao.addChatMessage(db, threadId, { role: 'agent', text: `Batch failed: ${msg}`, at: new Date().toISOString() })
      sendOpResult(opId, 'chat', outcome.status, cancelled ? undefined : msg, true)
      if (!cancelled) notifyIfUnfocused('Agent batch run failed', msg.slice(0, 120))
    }
  })

  handle('approve', async (sessionId: number) => {
    const session = mustGetSession(db, sessionId)
    const loaded = await buildLoadedReview(db, session)
    dao.approveSessionSurface(db, sessionId, loaded.skeleton.headSha, loaded.branchHash)
    return dao.loadReviewState(db, sessionId)
  })

  handle('unapprove', async (sessionId: number) => {
    const session = mustGetSession(db, sessionId)
    const loaded = await buildLoadedReview(db, session)
    dao.unapproveSessionSurface(db, sessionId, loaded.branchHash)
    return dao.loadReviewState(db, sessionId)
  })

  handle('approveArtifact', async (sessionId: number, artifactPath: string) => {
    const session = mustGetSession(db, sessionId)
    const sha = await headSha(session.repo, effectiveRef(session.pair.compare))
    dao.approveArtifact(db, sessionId, artifactPath, sha)
    return dao.loadReviewState(db, sessionId)
  })

  handle('unapproveArtifact', async (sessionId: number, artifactPath: string) => {
    dao.unapproveArtifact(db, sessionId, artifactPath)
    return dao.loadReviewState(db, sessionId)
  })

  handle('authStatus', async (engine: EngineId) => {
    const home = os.homedir()
    if (engine === 'claude') {
      const bin = engineBinaryStatus('claude')
      if (!bin.ok) return { ok: false, hint: bin.configured ? `Claude path is invalid: ${bin.hint}` : 'Install Claude Code (`claude` not found on PATH)' }
      const ok = Boolean(process.env.ANTHROPIC_API_KEY) || fs.existsSync(path.join(home, '.claude'))
      return { ok, hint: ok ? `${bin.configured ? 'Configured Claude path' : 'Claude Code from PATH'} · login or API key found` : 'Run `claude` once to log in, or set ANTHROPIC_API_KEY' }
    }
    const bin = engineBinaryStatus('codex')
    if (!bin.ok) return { ok: false, hint: bin.configured ? `Codex path is invalid: ${bin.hint}` : 'Install Codex CLI (`codex` not found on PATH)' }
    const ok = Boolean(process.env.OPENAI_API_KEY) || fs.existsSync(path.join(home, '.codex', 'auth.json'))
    return { ok, hint: ok ? `${bin.configured ? 'Configured Codex path' : 'Codex from PATH'} · login or API key found` : 'Run `codex login`, or set OPENAI_API_KEY' }
  })

  handle('getPrefs', async () => {
    const out = readPrefs()
    if (bootNotices.length > 0) out['boot-notices'] = JSON.stringify(bootNotices)
    return out
  })

  handle('setPref', async (key: string, value: string) => {
    db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
    if (key === ENGINE_PATH_PREF_KEYS.claude || key === ENGINE_PATH_PREF_KEYS.codex) {
      setEngineBinaryPrefs(readPrefs())
    }
  })

  handle('dashboard', async () => await buildDashboard(db, bootNotices))

  handle('refOptions', async (repo: string, relativeTo: string) => {
    const branches = await listBranches(repo)
    const base = await defaultBase(repo)
    // recentCommits throws on an unresolvable ref — an in-flight typed ref is normal here
    const commits = await recentCommits(repo, relativeTo, 50).catch(() => [])
    return { branches, defaultBase: base, commits } satisfies RefOptions
  })

  handle('retargetSession', async (sessionId: number, side: 'base' | 'compare', refInput: string) => {
    if (side === 'base') throw new Error('Session base cannot be changed; open a new review for a different base')
    const session = mustGetSession(db, sessionId)
    const resolved = await resolveRefInput(session.repo, refInput)
    const refSide: RefSide = { kind: resolved.kind, symbol: resolved.symbol, anchorSha: resolved.sha }
    dao.retargetSession(db, sessionId, side, refSide)
  })

  handle('installCli', async () => installCli())
  handle('takeCliOpen', async () => takeCliOpen())
}
