import fs from 'node:fs'
import path from 'node:path'
import type { ApprovalRequest, EngineId, ReviewAnnotations, Section } from '../../shared/types.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest, type ScopedUpdateRequest } from './types.js'
import type { ScopedReviewPatch, WireSection } from './schema.js'
import { awaitDecision } from './approvals.js'
import { EngineSessionLostError } from './errors.js'
import { execGit } from '../exec.js'

/** Top-level directory of a repo path — the ownership key FakeEngine sections by
 *  (mirrors `generateReview`'s by-dir grouping so a scoped patch lines up with it). */
function topDir(p: string): string {
  return p.includes('/') ? p.split('/')[0] : '(root)'
}

/** A revised/new section body in wire shape (nullable diagram/insight/plainNotes),
 *  byte-identical in shape to a fresh generation's section. */
function wireSection(id: string, name: string, files: string[], order: number, revised: boolean): WireSection {
  return {
    id, name,
    desc: revised ? `Changes under ${name} (updated for the drift).` : `New area ${name} introduced by the drift.`,
    what: `${revised ? 'Revised' : 'Added'} for ${files.length} changed file${files.length > 1 ? 's' : ''} in ${name}.`,
    files,
    order,
    diagram: null,
    insight: null,
    plainNotes: null
  }
}

/** Test affordance: a `[hold]` chat turn parks until `releaseFakeHolds()` fires, so a
 *  test can observe a concurrent op holding a lane (e.g. generation holds exclusive
 *  while a shared read-only chat runs). Module-level so it survives per-op FakeEngine
 *  instances. */
let fakeHoldResolvers: Array<() => void> = []
export function releaseFakeHolds(): void {
  const pending = fakeHoldResolvers
  fakeHoldResolvers = []
  for (const r of pending) r()
}

/** Test affordance: the most recent chat turn ANY FakeEngine instance received, so
 *  contract tests can assert the exact prompt a handler passed to engine.chat (a
 *  write-enabled turn's message is never echoed in the fake's reply). Module-level,
 *  like fakeHoldResolvers, so it survives per-op FakeEngine instances. */
let lastChatTurn: ChatTurn | null = null
export function lastFakeChatTurn(): ChatTurn | null { return lastChatTurn }

/** Deterministic engine for contract tests and demo mode (LIMN_DEMO=1). */
export class FakeEngine implements ReviewEngine {
  constructor(readonly id: EngineId = 'claude') {}

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    const q = new EventQueue()
    const result = (async () => {
      q.push({ type: 'status', text: 'Exploring the repository…' })
      q.push({ type: 'tool', call: { id: 'r1', verb: 'bash', name: 'git', arg: `git log ${req.base}..${req.branch}`, state: 'run' } })
      q.push({ type: 'tool', call: { id: 'r1', verb: 'bash', name: 'git', arg: `git log ${req.base}..${req.branch}`, state: 'ok', meta: '12 commits' } })
      const byDir = new Map<string, string[]>()
      for (const f of req.diff.files) {
        const dir = f.path.includes('/') ? f.path.split('/')[0] : '(root)'
        byDir.set(dir, [...(byDir.get(dir) ?? []), f.path])
      }
      const sections = [...byDir.entries()].map(([dir, files], i) => ({
        id: `s${i + 1}`,
        name: dir === '(root)' ? 'Top-level files' : dir,
        desc: `Changes under ${dir}.`,
        what: `Touches ${files.length} file${files.length > 1 ? 's' : ''} in ${dir}.`,
        files,
        order: i + 1
      }))
      q.push({ type: 'status', text: 'Writing the guided review…' })
      const value: ReviewAnnotations = {
        title: `Changes on ${req.branch}`,
        summary: `Demo review of ${req.diff.files.length} files grouped into ${sections.length} sections.`,
        sections,
        questions: [{
          id: 'q1',
          text: 'Demo question: should the config default stay as-is?',
          context: 'Top-level files',
          options: ['keep the current default', 'switch to the new default']
        }]
      }
      q.push({ type: 'done' })
      q.close()
      return { value, sessionId: `fake-${Date.now()}` }
    })()
    return { events: q.iterable(), result, cancel: () => q.close() }
  }

  /** Deterministic diff-scoped patch: for each since-diff file, revise the prior
   *  section owning that file's TOP-LEVEL DIR; mint `s<N+1>` for an unowned dir
   *  (one new section per new dir); keep every other prior section by id; resolve
   *  no questions; title/summary/planMap null (keep prior). Garbage env/message
   *  hooks (for T6's fallback-ladder tests) force intentionally bad shapes. */
  generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch> {
    const q = new EventQueue()
    const result = (async (): Promise<{ value: ScopedReviewPatch; sessionId: string }> => {
      const sessionId = req.priorEngineSessionId || `fake-scoped-${Date.now()}`
      const steer = req.steer ?? ''

      // ── garbage hooks (mirror LIMN_HOLD_STREAM / [approve] style) ──────────────
      // [scoped-fulldoc] / LIMN_SCOPED_FULLDOC=1 — the engine returned a full review
      // document, not a patch → the real adapters' parse rejects. Simulate by throwing.
      if (steer.includes('[scoped-fulldoc]') || process.env.LIMN_SCOPED_FULLDOC === '1') {
        q.push({ type: 'status', text: 'Updating the review…' })
        const message = 'scoped output parse failed: full review document, not a patch (fake)'
        q.push({ type: 'error', message })
        q.close()
        throw new Error(message)
      }
      // [scoped-resume-fail] / LIMN_SCOPED_RESUME_FAIL=1 — the engine session could
      // not be resumed (pruned/expired): throw the typed EngineSessionLostError, as
      // the real engine does when its session resume/load rejects — but ONLY when
      // resuming. Run fresh (no priorEngineSessionId) and it proceeds to the
      // well-formed patch below — this models ladder step 2 (resume-fail → same
      // scoped turn retried fresh).
      if ((steer.includes('[scoped-resume-fail]') || process.env.LIMN_SCOPED_RESUME_FAIL === '1') && req.priorEngineSessionId) {
        q.push({ type: 'status', text: 'Resuming the previous session…' })
        q.close()
        throw new EngineSessionLostError(req.priorEngineSessionId, new Error('session not found (fake)'))
      }
      q.push({ type: 'status', text: 'Reviewing the drift…' })
      q.push({ type: 'tool', call: { id: 'u1', verb: 'bash', name: 'git', arg: `git diff ${req.sinceSha}..${req.branch}`, state: 'run' } })
      q.push({ type: 'tool', call: { id: 'u1', verb: 'bash', name: 'git', arg: `git diff ${req.sinceSha}..${req.branch}`, state: 'ok', meta: `${req.since.length} files` } })

      const priorIds = req.prior.sections.map((s) => s.id)
      // [scoped-garbage] / LIMN_SCOPED_GARBAGE=1 — handshake-violating: kept lists an
      // id that never existed and omits the real prior ids, so the splice refuses.
      if (steer.includes('[scoped-garbage]') || process.env.LIMN_SCOPED_GARBAGE === '1') {
        const value: ScopedReviewPatch = {
          title: null, summary: null,
          revisedSections: [],
          deletedSectionIds: [],
          keptSectionIds: ['ghost-section-never-existed'],
          newQuestions: [], resolvedQuestionIds: [], planMap: null
        }
        q.push({ type: 'done' }); q.close()
        return { value, sessionId }
      }
      // [scoped-dup] / LIMN_SCOPED_DUP=1 — duplicate id within revisedSections, which
      // the splice rejects (a section can't be revised twice in one patch).
      if (steer.includes('[scoped-dup]') || process.env.LIMN_SCOPED_DUP === '1') {
        const first = req.prior.sections[0]
        const dupId = first?.id ?? 's1'
        const value: ScopedReviewPatch = {
          title: null, summary: null,
          revisedSections: [
            wireSection(dupId, first?.name ?? 'A', first?.files ?? [], first?.order ?? 1, true),
            wireSection(dupId, first?.name ?? 'A', first?.files ?? [], first?.order ?? 1, true)
          ],
          deletedSectionIds: [],
          keptSectionIds: priorIds.filter((id) => id !== dupId),
          newQuestions: [], resolvedQuestionIds: [], planMap: null
        }
        q.push({ type: 'done' }); q.close()
        return { value, sessionId }
      }

      // ── well-formed deterministic patch ───────────────────────────────────────
      const sectionForDir = (dir: string): Section | undefined =>
        req.prior.sections.find((s) => s.files.some((f) => topDir(f) === dir))

      // Accumulate revised owners (by id) and minted new sections (by unowned dir),
      // each collecting the since-file paths it claims (unioned onto the owner's files).
      const revisedFiles = new Map<string, { section: Section; files: Set<string> }>()
      const newByDir = new Map<string, { name: string; files: Set<string> }>()
      for (const f of req.since) {
        const dir = topDir(f.path)
        const owner = sectionForDir(dir)
        if (owner) {
          const entry = revisedFiles.get(owner.id) ?? { section: owner, files: new Set(owner.files) }
          entry.files.add(f.path)
          revisedFiles.set(owner.id, entry)
        } else {
          const entry = newByDir.get(dir) ?? { name: dir === '(root)' ? 'Top-level files' : dir, files: new Set<string>() }
          entry.files.add(f.path)
          newByDir.set(dir, entry)
        }
      }

      const revisedSections: WireSection[] = [...revisedFiles.values()].map((e) =>
        wireSection(e.section.id, e.section.name, [...e.files], e.section.order, true)
      )
      // mint `s<N+1>`, skipping any id a (possibly non-sequential) prior review holds.
      const priorIdSet = new Set(priorIds)
      let mintN = req.prior.sections.length
      const mintId = (): string => {
        do { mintN += 1 } while (priorIdSet.has(`s${mintN}`))
        return `s${mintN}`
      }
      // [scoped-miss] / LIMN_SCOPED_MISS=1 — the engine ignored a genuinely-new file:
      // suppress minting for unowned dirs so those since-added files are claimed by NO
      // section. The patch stays well-formed (splice succeeds); mergeAnnotations sweeps
      // the orphan into 'other-changes' and splice step-9 WARNs (Q5 — no fallback).
      const suppressMint = steer.includes('[scoped-miss]') || process.env.LIMN_SCOPED_MISS === '1'
      if (!suppressMint) {
        for (const [, e] of newByDir) {
          revisedSections.push(wireSection(mintId(), e.name, [...e.files], mintN, false))
        }
      }

      const revisedIds = new Set(revisedFiles.keys())
      const keptSectionIds = priorIds.filter((id) => !revisedIds.has(id))

      q.push({ type: 'status', text: 'Writing the scoped patch…' })
      const value: ScopedReviewPatch = {
        title: null,
        summary: null,
        revisedSections,
        deletedSectionIds: [],
        keptSectionIds,
        newQuestions: [],
        resolvedQuestionIds: [],
        planMap: null
      }
      q.push({ type: 'done' }); q.close()
      return { value, sessionId }
    })()
    return { events: q.iterable(), result, cancel: () => q.close() }
  }

  chat(turn: ChatTurn): EngineRun<string> {
    lastChatTurn = turn
    const q = new EventQueue()
    const refine = turn.message.includes('The reviewer answered')
    const batch = Boolean(turn.tools && (turn.writeEnabled || refine))
    const modelTag = turn.model ? ` using **${turn.model}**` : ''
    const chatText = [
      `Looking at your question${modelTag}:`,
      '',
      `> ${turn.message}`,
      '',
      `The change touches \`src/a.ts\` and adds the new branch you flagged. A few notes:`,
      '',
      '- The early return keeps the happy path readable.',
      '- `parseRefInput` is the only caller, so the blast radius is small.',
      '',
      '```ts',
      'if (!input) return null // guard added in this branch',
      '```',
      '',
      'Want me to check the tests next?'
    ].join('\n')
    const batchText = 'Handled your comments: made the edit, committed it on the branch, and resolved each one. See the rollup below.'
    const refineText = 'Recorded your decision, updated the guided review narration, and resolved the open question.'
    const text = refine ? refineText : batch ? batchText : chatText
    const result = (async () => {
      // test/demo affordances for the typed lost-session/cancel classification (item
      // 7): force a controlled failure of each class. A resume failure is the typed
      // EngineSessionLostError, exactly (and only) when there is a session to resume.
      if (turn.message.includes('[fail-immediately]')) {
        q.push({ type: 'status', text: 'Resuming the previous session…' })
        if (turn.engineSessionId) throw new EngineSessionLostError(turn.engineSessionId, new Error('session not found (fake)'))
        throw new Error('engine turn failed before any work (fake)')
      }
      if (turn.message.includes('[fail-after-tool]')) {
        q.push({ type: 'tool', call: { id: 't1', verb: 'grep', name: 'Grep', arg: 'x', state: 'ok', meta: '1 hit' } })
        throw new Error('engine crashed mid-turn (fake)')
      }
      if (turn.message.includes('[fail-abortish]')) {
        // a GENUINE failure whose message merely mentions "aborted": classification is
        // typed (CancelledError/AbortError), so this must surface as a failure, not
        // vanish as a quiet user cancel.
        throw new Error('request aborted by server (fake)')
      }
      if (turn.message.includes('[cancel]')) {
        throw new DOMException('cancelled', 'AbortError')
      }
      if (turn.message.includes('[hold]')) {
        // park holding this turn's lane until releaseFakeHolds() fires (concurrency tests)
        q.push({ type: 'status', text: turn.readOnly ? 'holding (read-only)…' : 'holding…' })
        await new Promise<void>((resolve) => { fakeHoldResolvers.push(resolve) })
        q.push({ type: 'done' })
        q.close()
        return { value: 'held then released', sessionId: turn.engineSessionId || 'fake-hold' }
      }
      q.push({ type: 'status', text: batch ? 'Applying your comments…' : 'Reading src/a.ts…' })
      // structured tool-call lifecycle for the activity log (wf-D): a settled grep,
      // an expandable read with a diff, and an errored grep.
      q.push({ type: 'tool', call: { id: 't1', verb: 'grep', name: 'Grep', arg: 'parseRefInput', state: 'run' } })
      q.push({ type: 'tool', call: { id: 't1', verb: 'grep', name: 'Grep', arg: 'parseRefInput', state: 'ok', meta: '3 hits', out: 'src/a.ts:12\nsrc/a.ts:48\nsrc/parse.ts:5' } })
      q.push({ type: 'tool', call: { id: 't2', verb: 'read', name: 'Read', arg: 'src/a.ts · L1–40', kv: [['path', 'src/a.ts'], ['range', 'L1-40']], state: 'run' } })
      q.push({ type: 'tool', call: { id: 't2', verb: 'read', name: 'Read', arg: 'src/a.ts · L1–40', kv: [['path', 'src/a.ts'], ['range', 'L1-40']], state: 'ok', meta: '40 lines', out: 'export function parseRefInput(input) {\n-  if (input == null) throw new Error()\n+  if (!input) return null // guard added in this branch\n  return resolve(input)\n}', outMore: 'show 31 more lines' } })
      q.push({ type: 'tool', call: { id: 't3', verb: 'grep', name: 'Grep', arg: "require('child_process')", kv: [['pattern', "require('child_process')"]], state: 'run' } })
      // dev-only: LIMN_HOLD_STREAM leaves t3 running + the stream open, for a static
      // capture of the live running state (electron is killed by LIMN_SHOT_QUIT).
      if (process.env.LIMN_HOLD_STREAM === '1') {
        q.push({ type: 'status', text: 'Reading reconcile.ts…' })
        return { value: '', sessionId: turn.engineSessionId || 'fake-chat-hold' }
      }
      q.push({ type: 'tool', call: { id: 't3', verb: 'grep', name: 'Grep', arg: "require('child_process')", state: 'err', out: 'Error: ripgrep exited 2 — invalid regex at offset 8 (unbalanced parenthesis)' } })
      if (batch && turn.tools) {
        // unified batch: resolve the sent comments + commit via the tools
        const listed = await turn.tools.call('list_comments', { status: 'sent' })
        let ids: string[] = []
        try { ids = (JSON.parse(listed.result) as { id: string }[]).map((c) => c.id) } catch { /* none */ }
        if (!refine) {
          try { fs.appendFileSync(path.join(turn.repo, 'src/a.ts'), '\n// addressed by agent\n') } catch { /* repo may be read-only in tests */ }
          // commit via git, as the real agent does through its own shell
          try {
            await execGit(turn.repo, ['add', '--', 'src/a.ts'])
            await execGit(turn.repo, ['commit', '-m', 'limn: batch fixes'])
          } catch { /* repo may be read-only in tests */ }
        } else {
          await turn.tools.call('edit_review', { field: 'summary', value: 'Demo review updated with the reviewer decision.' })
        }
        for (const id of ids) {
          await turn.tools.call('resolve_comment', { commentId: id, verdict: 'addressed', note: 'Done (demo).' })
        }
      } else if (turn.tools) {
        // tool-enabled read-only chat: exercise the focus + suggest action pipe
        await turn.tools.call('focus', { target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 } })
        await turn.tools.call('tour', {
          stops: [
            { target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 }, note: 'The guard introduced by this branch.' },
            { target: { kind: 'file', file: 'src/b.ts' }, note: 'The caller that consumes the guarded value.' }
          ],
          loop: true
        })
        await turn.tools.call('suggest_mark_viewed', { files: ['src/a.ts'], note: 'covered above' })
      }
      // interactive approval round-trip (demo via LIMN_FAKE_APPROVAL=1 / test via the
      // '[approve]' token): park on a command approval, reflect the decision.
      if (turn.opId && (process.env.LIMN_FAKE_APPROVAL === '1' || turn.message.includes('[approve]'))) {
        const request: ApprovalRequest = {
          id: 'fake-1', engine: this.id, kind: 'command',
          summary: 'Run `npm test`', detail: { command: 'npm test', cwd: turn.repo }, risk: 'low'
        }
        const decision = await awaitDecision(turn.opId, request, (e) => q.push(e))
        q.push({ type: 'status', text: decision === 'allow' ? 'note: approved — ran npm test' : 'note: denied npm test' })
      }
      // stream the answer in chunks so the panel shows live tokens
      for (const chunk of text.match(/[\s\S]{1,48}/g) ?? [text]) q.push({ type: 'text', text: chunk })
      q.push({ type: 'done' })
      q.close()
      return { value: text, sessionId: turn.engineSessionId || `fake-chat-${Date.now()}` }
    })()
    return { events: q.iterable(), result, cancel: () => q.close() }
  }
}
