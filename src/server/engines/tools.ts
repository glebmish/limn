import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { effectiveRef, type AgentAction, type AgentRef, type Comment, type CommentAnchor, type CommentReply, type CommentStatus, type EngineEvent, type FocusTarget, type ReviewAnnotations, type SessionMeta } from '../../shared/types.js'
import { getSession, loadReviewState, updateSessionMeta, upsertComment } from '../db/sessions.js'
import { resolveStampTree, stampAnchor, type StampTree } from '../anchorStamp.js'
import { headSha } from '../git.js'

// One engine-agnostic tool set, hosted two ways: Claude consumes the zod `input`
// shape directly via `tool(name, desc, shape, handler)`; Codex app-server reaches
// the same shape through a per-turn external MCP server. A handler runs in the
// server process — it may touch the DB / git, emit a live `action` event,
// and returns the text the model sees. Code edits + commits go through the
// engine's own shell/edit tools (git via bash); limn hosts no write tool.

/** Engine-agnostic tool definition (the shape both engines reflect). */
export interface ToolDef { name: string; description: string; input: z.ZodRawShape }

/** Per-turn context a tool host is bound to. */
export interface ToolHostCtx {
  db: DatabaseSync
  sessionId: number
  threadId: number
  opId: string
  repo: string
  agent: AgentRef
  /** the engine session backing this turn's thread. */
  engineSessionId?: string
  /** Restrict this turn to a subset of the tool set (SHARED_LANE_TOOL_NAMES for a
   *  read-only turn sharing the repo with a generation). A tool outside it answers
   *  with an error the agent can act on — never a silent no-op. Omitted: all tools. */
  allowedTools?: ReadonlySet<string>
  /** push a live engine event to the renderer (an `action` event, here). */
  emit: (event: EngineEvent) => void
}

export interface ToolCallResult { result: string; isError?: boolean; action?: AgentAction }

/** One per turn, bound to its context. `call` performs the side effect and emits
 *  the live action; `collected` returns the ordered actions for persistence. */
export interface AgentToolHost {
  call(name: string, args: unknown): Promise<ToolCallResult>
  collected(): AgentAction[]
}

// ── tool input shapes ─────────────────────────────────────────
const focusTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('summary') }),
  z.object({ kind: z.literal('section'), sectionId: z.string().min(1) }),
  z.object({ kind: z.literal('file'), file: z.string().min(1) }),
  z.object({
    kind: z.literal('diff'),
    file: z.string().min(1),
    side: z.enum(['new', 'old']),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    // hunkRange/lineContent matter for comment anchoring, not for pointing — accept
    // them so a FocusTarget is well-formed, but the agent may omit them.
    hunkRange: z.string().optional(),
    lineContent: z.string().optional()
  })
])

const POINT_INPUT = {
  stops: z.array(z.object({
    target: focusTarget,
    note: z.string().optional()
  })).min(1).max(8),
  loop: z.boolean().optional()
} satisfies z.ZodRawShape
const SUGGEST_INPUT = {
  files: z.array(z.string()).optional(),
  sectionIds: z.array(z.string()).optional(),
  note: z.string().optional()
} satisfies z.ZodRawShape

// An agent comment can anchor anywhere a focus can (diff / file / section /
// summary) — the same subset, reused so there's no second anchor schema.
const ADD_COMMENT_INPUT = { anchor: focusTarget, text: z.string().min(1) } satisfies z.ZodRawShape
const REPLY_INPUT = { commentId: z.string().min(1), text: z.string().min(1) } satisfies z.ZodRawShape
const RESOLVE_INPUT = {
  commentId: z.string().min(1),
  verdict: z.enum(['addressed', 'reworked', 'skipped']),
  note: z.string()
} satisfies z.ZodRawShape
const LIST_COMMENTS_INPUT = { status: z.enum(['queued', 'sent', 'resolved', 'outdated']).optional() } satisfies z.ZodRawShape
const GET_REVIEW_INPUT = {} satisfies z.ZodRawShape
const GET_PROGRESS_INPUT = {} satisfies z.ZodRawShape
const EDIT_REVIEW_INPUT = {
  field: z.enum(['title', 'summary', 'section.block', 'section.contrast']),
  sectionId: z.string().optional(),
  blockIndex: z.number().int().optional(),
  op: z.enum(['replace', 'insert', 'delete']).optional(),
  // title / summary / section.block all read `value`; section.contrast
  // reads `was`/`now` instead (deliberately not overloaded onto value). All optional at
  // the schema level (cheap omission, no repair turn) — per-field presence is validated
  // in the handler, where the error can name exactly what's missing.
  value: z.string().optional(),
  was: z.string().optional(),
  now: z.string().optional()
} satisfies z.ZodRawShape
const UPDATE_PLAN_STATUS_INPUT = {
  index: z.number().int(),
  met: z.union([z.boolean(), z.literal('partial')]),
  note: z.string()
} satisfies z.ZodRawShape

let commentSeq = 0
function normalizeFocusTarget(a: z.infer<typeof focusTarget>): FocusTarget {
  return a.kind === 'diff'
    ? {
        kind: 'diff', file: a.file, side: a.side, line: a.line,
        ...(a.endLine ? { endLine: a.endLine } : {}),
        hunkRange: a.hunkRange ?? '', lineContent: a.lineContent ?? ''
      }
    : a
}
function normalizeAnchor(a: z.infer<typeof focusTarget>): CommentAnchor {
  return normalizeFocusTarget(a)
}
/** The per-call stamping context a `point` needs: the session (ctx has no pair →
 *  reload it) and the tree facts every stop of one call shares. Resolved once for
 *  the whole call — head/mergeBase cannot differ between stops of the same call, so
 *  paying for the triple per stop is up to 8 identical session loads and ~8 extra
 *  git spawns on the interactive path. `undefined` (no session, a DB/git failure)
 *  simply leaves every stop unstamped, exactly as before. */
type StampCtx = { session: SessionMeta; tree?: StampTree }
async function resolveStampCtx(ctx: ToolHostCtx): Promise<StampCtx | undefined> {
  try {
    const session = getSession(ctx.db, ctx.sessionId)
    if (!session) return undefined
    return { session, tree: await resolveStampTree(ctx.repo, session) }
  } catch { return undefined }
}

/** The compare side's head right now — what a per-file view mark's sha is measured
 *  against. Best-effort by design: a session that has gone (a deleted branch, a
 *  workdir that is no longer a repo) reports null rather than failing the tool call,
 *  since the rest of the progress snapshot is still worth having. */
async function compareHead(ctx: ToolHostCtx): Promise<string | null> {
  try {
    const session = getSession(ctx.db, ctx.sessionId)
    if (!session) return null
    return await headSha(ctx.repo, effectiveRef(session.pair.compare))
  } catch { return null }
}

/** Stamp a diff FocusTarget against the current surface, exactly as `add_comment`
 *  stamps a comment anchor. Without this a `point` stop is frozen in the message's
 *  actions with no blob/context and (models never pass one) an empty `lineContent`,
 *  so the re-anchor pass has nothing to work with and the stop keeps naming a line
 *  number whose code has since moved (#18). Never throws and never rejects a point:
 *  an unstampable target degrades to today's bare target. */
async function stampFocusTarget(ctx: ToolHostCtx, stamp: StampCtx | undefined, target: FocusTarget): Promise<FocusTarget> {
  if (target.kind !== 'diff' || !stamp) return target
  try {
    return await stampAnchor(ctx.repo, stamp.session, target, stamp.tree) as FocusTarget
  } catch { return target }
}
function anchorLabel(a: CommentAnchor): string {
  switch (a.kind) {
    case 'diff': return `${a.file}:${a.line}`
    case 'file': return a.file
    case 'section': return `section ${a.sectionId}`
    case 'summary': return 'the summary'
    case 'artifact': return `${a.path}:${a.line}`
    case 'plan-step': return `plan step ${a.stepN}`
    case 'question': return `question ${a.questionId}`
    case 'title': return 'the title'
    case 'acceptance': return `acceptance criterion ${a.index + 1}`
    case 'deviation': return `plan deviation ${a.index + 1}`
    case 'selection': return `selected “${a.quote}”`
  }
}


// ── tool implementations ──────────────────────────────────────
interface ToolImpl extends ToolDef {
  run: (ctx: ToolHostCtx, args: unknown) => ToolCallResult | Promise<ToolCallResult>
}

function describeFocus(a: FocusTarget): string {
  switch (a.kind) {
    case 'summary': return 'the review summary'
    case 'section': return `section ${a.sectionId}`
    case 'file': return a.file
    case 'diff': return a.endLine ? `${a.file}:${a.line}-${a.endLine}` : `${a.file}:${a.line}`
  }
}

const TOOL_IMPLS: ToolImpl[] = [
  {
    name: 'point',
    description:
      'Point the reviewer at one or more spots in the review — the summary, a section, ' +
      'a file, or a specific diff line (optionally a range via endLine) — and briefly ' +
      'highlight them. Use a single stop when your answer refers to one spot; use 2-8 stops ' +
      'for an interactive walkthrough across a sequence — for example a value flow, call ' +
      'chain, lifecycle path, or cross-file risk — with an optional short note per stop. ' +
      'Whenever your answer refers to a place in the code or review (a file, a function, a ' +
      'diff line), call point to jump the reviewer there instead of only naming the path in ' +
      'prose. Prefer the most specific target available (a diff line/range over a file). It ' +
      'leaves a clickable chip (or, for multiple stops, an interactive walkthrough card with ' +
      'Prev/Next) in the chat so the reviewer can re-focus later; use loop=true when a ' +
      'multi-stop sequence is cyclic or useful to repeat. It is the primary way to point at ' +
      'code — but when one call covers the locations, don\'t also point at them individually.',
    input: POINT_INPUT,
    run: async (ctx, raw) => {
      const { stops, loop } = raw as z.infer<z.ZodObject<typeof POINT_INPUT>>
      // one session load + one tree resolve for the whole walkthrough; skipped
      // entirely when no stop is a diff (nothing to stamp).
      const stamp = stops.some((s) => s.target.kind === 'diff') ? await resolveStampCtx(ctx) : undefined
      const action: AgentAction = {
        kind: 'point',
        stops: await Promise.all(stops.map(async (s) => ({
          target: await stampFocusTarget(ctx, stamp, normalizeFocusTarget(s.target)),
          ...(s.note?.trim() ? { note: s.note.trim() } : {})
        }))),
        ...(loop ? { loop: true } : {})
      }
      const labels = action.stops.map((s) => describeFocus(s.target)).join(' → ')
      const result = action.stops.length === 1
        ? `Pointed at ${labels}.`
        : `Created a ${action.stops.length}-stop walkthrough: ${labels}.`
      return { result, action }
    }
  },
  {
    name: 'suggest_mark_viewed',
    description:
      'Propose that the reviewer mark file(s) and/or section(s) as viewed, once you have ' +
      'finished walking them through it or they signal they understand it. It only proposes: it ' +
      'renders a confirm button in chat and nothing changes until the reviewer clicks it, so ' +
      'suggesting is low-risk. Provide at least one file or section, and a short note on what ' +
      'was covered. At most once per turn, only after the reviewer signals understanding.',
    input: SUGGEST_INPUT,
    run: (_ctx, raw) => {
      const { files, sectionIds, note } = raw as z.infer<z.ZodObject<typeof SUGGEST_INPUT>>
      const fileCount = files?.length ?? 0
      const sectionCount = sectionIds?.length ?? 0
      if (fileCount === 0 && sectionCount === 0) {
        throw new Error('suggest_mark_viewed needs at least one file or section')
      }
      const action: AgentAction = {
        kind: 'suggest_viewed',
        id: randomUUID(),  // stable handle for the dismiss-persist path
        ...(fileCount ? { files } : {}),
        ...(sectionCount ? { sectionIds } : {}),
        ...(note ? { note } : {})
      }
      return { result: `Suggested marking ${fileCount + sectionCount} item(s) viewed; awaiting reviewer confirmation.`, action }
    }
  },
  {
    name: 'list_comments',
    description:
      'List the review comments (id, anchor, author, status, text), optionally filtered ' +
      'by status. Call this first whenever you are about to answer, reply to, or resolve ' +
      'queued comments, so you have their exact ids and text.',
    input: LIST_COMMENTS_INPUT,
    run: (ctx, raw) => {
      const { status } = raw as z.infer<z.ZodObject<typeof LIST_COMMENTS_INPUT>>
      const comments = loadReviewState(ctx.db, ctx.sessionId).comments
        .filter((c) => !status || c.status === status)
        .map((c) => ({ id: c.id, anchor: anchorLabel(c.anchor), author: c.author, status: c.status, text: c.text }))
      return { result: JSON.stringify(comments) }
    }
  },
  {
    name: 'add_comment',
    description:
      'Leave a new review comment, authored by you (the agent), anchored to a diff line, ' +
      'file, section, or the summary. Whenever you notice a bug, risk, or noteworthy detail ' +
      'while answering, record it with add_comment anchored to the exact spot rather than only ' +
      'mentioning it in chat — anchored comments persist in the review; chat prose does not. ' +
      'Anchor as specifically as possible. For findings, not for restating your chat answer.',
    input: ADD_COMMENT_INPUT,
    run: async (ctx, raw) => {
      const { anchor: rawAnchor, text } = raw as z.infer<z.ZodObject<typeof ADD_COMMENT_INPUT>>
      let anchor = normalizeAnchor(rawAnchor)
      // ctx.repo is already the resolved workdir; ctx has no pair → reload the session.
      const session = getSession(ctx.db, ctx.sessionId)
      if (session) anchor = await stampAnchor(ctx.repo, session, anchor)
      const iteration = loadReviewState(ctx.db, ctx.sessionId).latestIteration?.n ?? 0
      const comment: Comment = {
        id: `ac-${Date.now()}-${commentSeq++}`,
        anchor, author: 'agent', agentRef: ctx.agent, threadId: ctx.threadId,
        text, status: 'resolved', // agent notes are inert: never queued into the user's batch
        replies: [], createdAt: new Date().toISOString(), iteration
      }
      upsertComment(ctx.db, ctx.sessionId, comment)
      return { result: `Added a comment on ${anchorLabel(anchor)}.`, action: { kind: 'comment_added', comment } }
    }
  },
  {
    name: 'reply_to_comment',
    description: "Reply to an existing comment (by id), as the agent. Use it to answer a reviewer's comment in place.",
    input: REPLY_INPUT,
    run: (ctx, raw) => {
      const { commentId, text } = raw as z.infer<z.ZodObject<typeof REPLY_INPUT>>
      const comment = loadReviewState(ctx.db, ctx.sessionId).comments.find((c) => c.id === commentId)
      if (!comment) throw new Error(`No comment with id ${commentId}`)
      const reply: CommentReply = { author: 'agent', text, at: new Date().toISOString(), agentRef: ctx.agent, threadId: ctx.threadId }
      comment.replies = [...comment.replies, reply]
      upsertComment(ctx.db, ctx.sessionId, comment)
      return { result: `Replied to the comment on ${anchorLabel(comment.anchor)}.`, action: { kind: 'comment_replied', commentId, anchor: comment.anchor, reply } }
    }
  },
  {
    name: 'resolve_comment',
    description:
      'Resolve a comment (by id) with a verdict — addressed, reworked, or skipped — and a short ' +
      'note. Always call this once you have handled a reviewer comment, whether or not it ' +
      'required a code change, so the review\'s state stays accurate.',
    input: RESOLVE_INPUT,
    run: (ctx, raw) => {
      const { commentId, verdict, note } = raw as z.infer<z.ZodObject<typeof RESOLVE_INPUT>>
      const comment = loadReviewState(ctx.db, ctx.sessionId).comments.find((c) => c.id === commentId)
      if (!comment) throw new Error(`No comment with id ${commentId}`)
      comment.status = 'resolved'
      comment.resolution = { verdict, note, agentRef: ctx.agent }
      upsertComment(ctx.db, ctx.sessionId, comment)
      return { result: `Resolved the comment on ${anchorLabel(comment.anchor)} as ${verdict}.`, action: { kind: 'comment_resolved', commentId, anchor: comment.anchor, verdict, note } }
    }
  },
  {
    name: 'get_review',
    description:
      'Get the current guided review (title, summary, and each section’s name/narration/' +
      'contrast) so you can reference or edit it. A section’s `narration` array is ' +
      'indexed — array position is the `blockIndex` edit_review expects.',
    input: GET_REVIEW_INPUT,
    run: (ctx) => {
      const ann = loadReviewState(ctx.db, ctx.sessionId).annotations
      if (!ann) return { result: 'No review has been generated yet.' }
      const slim = {
        title: ann.title, summary: ann.summary,
        sections: ann.sections.map((s) => ({
          id: s.id, name: s.name,
          narration: s.narration.map((b) => b.text), // index === blockIndex
          ...(s.contrast ? { contrast: s.contrast } : {})
        }))
      }
      return { result: JSON.stringify(slim) }
    }
  },
  {
    name: 'get_review_progress',
    description:
      'Get a compact snapshot of review progress: which files the reviewer has marked ' +
      'viewed, and comment counts by status (queued/sent/resolved/outdated). Call this ' +
      'to calibrate what to suggest next — e.g. don\'t re-suggest a file already viewed, and ' +
      'check for queued comments before wrapping up. Each `viewed_files` entry names the ' +
      'commit sha the tick was taken at; `compare_head_sha` is the branch head those ticks ' +
      'are measured against, so a mark whose sha is not the head is a file the branch has ' +
      'moved past — it reads as changed-since-viewed to the reviewer and may be worth ' +
      'walking again. `compare_head_sha` is null when the ref cannot be read.',
    input: GET_PROGRESS_INPUT,
    run: async (ctx) => {
      const state = loadReviewState(ctx.db, ctx.sessionId)
      const comments: Record<CommentStatus, number> = { queued: 0, sent: 0, resolved: 0, outdated: 0, proposed: 0, dismissed: 0 }
      for (const c of state.comments) comments[c.status]++
      const slim = {
        // A tick is only live while the file still matches the sha AND content hash it
        // was taken at (fileViewed, renderer/store/derive.ts) — a drifted file reads as
        // changed-since-viewed in the UI. That check needs the loaded diff, which this
        // read-only tool doesn't have, so report the mark's own sha rather than a bare
        // key that would imply every entry is currently viewed.
        viewed_files: Object.entries(state.viewedAt).map(([file, m]) => ({ file, sha: m.sha })),
        // …and the head those per-mark shas mean something against. Without it the
        // marks are unanchored: the agent can read "ticked at c0ffee" and still not
        // tell a live tick from one the branch has since moved past. One `rev-parse`,
        // best-effort — an unreadable ref reports null rather than failing the call.
        compare_head_sha: await compareHead(ctx),
        comments,
        // Computing real file drift means diffing every viewed file against the working
        // tree; this read-only tool affords one `rev-parse` (compare_head_sha above) and
        // otherwise surfaces only the already-loaded anchor, not a computed delta.
        // Callers wanting the real drift use the fetch-pill path.
        drift: { since_sha: state.reviewedAtSha ?? null, note: 'counts only — live git drift not computed here' }
      }
      return { result: JSON.stringify(slim) }
    }
  },
  {
    name: 'edit_review',
    description:
      'Amend the guided review in place — the title, the summary, or (with sectionId) a ' +
      'section\'s narration block (insert/replace/delete at blockIndex — see get_review\'s ' +
      'indexed narration array), or its behavior contrast (was/now) — e.g. ' +
      'to add detail a reviewer\'s question surfaced. Does not regenerate the whole review.',
    input: EDIT_REVIEW_INPUT,
    run: (ctx, raw) => {
      const { field, sectionId, blockIndex, op, value, was, now } = raw as z.infer<z.ZodObject<typeof EDIT_REVIEW_INPUT>>
      const ann: ReviewAnnotations | undefined = loadReviewState(ctx.db, ctx.sessionId).annotations
      if (!ann) throw new Error('No review to edit yet — generate one first')

      function requireValue(): string {
        if (value === undefined) throw new Error(`edit_review field ${field} requires a value`)
        return value
      }
      function findSection() {
        if (!sectionId) throw new Error(`edit_review field ${field} requires a sectionId`)
        const s = ann!.sections.find((sec) => sec.id === sectionId)
        if (!s) throw new Error(`No section with id ${sectionId}`)
        return s
      }

      if (field === 'title') ann.title = requireValue()
      else if (field === 'summary') ann.summary = requireValue()
      else if (field === 'section.block') {
        const s = findSection()
        if (!op) throw new Error('edit_review field section.block requires an op')
        if (blockIndex === undefined) throw new Error('edit_review field section.block requires a blockIndex')
        const maxIndex = op === 'insert' ? s.narration.length : s.narration.length - 1
        if (blockIndex < 0 || blockIndex > maxIndex) {
          throw new Error(`blockIndex ${blockIndex} out of range for section ${sectionId} (${s.narration.length} block(s))`)
        }
        if (op === 'replace') {
          const anchor = s.narration[blockIndex].anchor
          s.narration[blockIndex] = { text: requireValue(), ...(anchor ? { anchor } : {}) }
        } else if (op === 'insert') {
          s.narration.splice(blockIndex, 0, { text: requireValue() })
        } else {
          s.narration.splice(blockIndex, 1) // delete needs no value
        }
      } else {
        const s = findSection()
        if (was === undefined || now === undefined) throw new Error('edit_review field section.contrast requires was and now')
        s.contrast = { was, now }
      }

      updateSessionMeta(ctx.db, ctx.sessionId, { annotations: ann })
      return {
        result: `Updated ${field}${sectionId ? ` of section ${sectionId}` : ''}.`,
        action: { kind: 'review_edited', field, ...(sectionId ? { sectionId } : {}) }
      }
    }
  },
  {
    name: 'update_plan_status',
    description:
      'Flip an acceptance criterion\'s met status (true, false, or "partial") with a short ' +
      'note explaining why — e.g. once you\'ve verified it against the code or the reviewer ' +
      'has confirmed it. Addresses the planMap acceptance list by index (see get_review or the ' +
      'plan artifact for indices).',
    input: UPDATE_PLAN_STATUS_INPUT,
    run: (ctx, raw) => {
      const { index, met, note } = raw as z.infer<z.ZodObject<typeof UPDATE_PLAN_STATUS_INPUT>>
      const ann: ReviewAnnotations | undefined = loadReviewState(ctx.db, ctx.sessionId).annotations
      if (!ann) throw new Error('No review to edit yet — generate one first')
      if (!ann.planMap) throw new Error('This review has no planMap to update')
      if (index < 0 || index >= ann.planMap.acceptance.length) {
        throw new Error(`index ${index} out of range (${ann.planMap.acceptance.length} acceptance criteria)`)
      }
      ann.planMap.acceptance[index].met = met
      updateSessionMeta(ctx.db, ctx.sessionId, { annotations: ann })
      return {
        result: `Marked acceptance criterion ${index + 1} as ${met} (${note}).`,
        action: { kind: 'plan_status_updated', index, met, note }
      }
    }
  }
]

/** The tools as the model sees them, for Claude's `allowedTools` (the SDK prefixes
 *  in-process MCP tools with `mcp__<server>__`). */
export const LIMN_TOOLS: ToolDef[] = TOOL_IMPLS.map(({ name, description, input }) => ({ name, description, input }))

/** Tool names to allow this turn. limn hosts no write tool — code edits + commits
 *  go through the engine's own shell/edit tools, gated by the execution mode. */
export function limnAllowedToolNames(): string[] {
  return TOOL_IMPLS.map((t) => `mcp__limn__${t.name}`)
}

/** Tools safe to auto-accept without a reviewer approval: they mutate review
 *  metadata (comments, annotations, view marks) or renderer focus — NEVER
 *  repo files, git state, or anything outside the Limn DB. Adding a tool to
 *  LIMN_TOOLS without listing it here (or consciously excluding it) fails
 *  loudly at turn setup (assertAutoAcceptCoverage) and in tests. Hand-maintained
 *  on purpose — do NOT derive it from LIMN_TOOLS, so a new tool can't ride in. */
export const AUTO_ACCEPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'point', 'suggest_mark_viewed', 'list_comments', 'add_comment',
  'reply_to_comment', 'resolve_comment', 'get_review', 'get_review_progress', 'edit_review',
  'update_plan_status'
])

/** The tools a SHARED-lane (read-only) turn may call — everything except the two
 *  that read the whole `annotations` blob, mutate it, and write it back. The shared
 *  lane is taken while ANOTHER op holds the repo exclusively; when that op is a
 *  generation it persists the annotations snapshot it took BEFORE this turn started,
 *  so such an edit is silently overwritten and the reviewer is left with an "edited
 *  the review" chip and no edit. Withheld rather than raced: a refine turn that
 *  genuinely needs them runs on the exclusive lane. Hand-maintained, like
 *  AUTO_ACCEPT_TOOL_NAMES — a new tool must be classified (tests/tools.test.ts pins
 *  the complement), so it can't ride onto the shared lane unexamined. */
export const SHARED_LANE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'point', 'suggest_mark_viewed', 'list_comments', 'add_comment',
  'reply_to_comment', 'resolve_comment', 'get_review', 'get_review_progress'
])

/** Fail loudly if any tool isn't cleared for the engines' blanket auto-accept
 *  (Codex elicitations auto-ACCEPT every registered tool; Claude auto-allows
 *  allowlist members). Called at turn registration; unit-tested directly. */
export function assertAutoAcceptCoverage(tools: ToolDef[]): void {
  const unlisted = tools.filter((t) => !AUTO_ACCEPT_TOOL_NAMES.has(t.name))
  if (unlisted.length) throw new Error(`limn tools not cleared for auto-accept: ${unlisted.map((t) => t.name).join(', ')} — every ACP engine auto-allows registered limn tools via the ladder policy; add them to AUTO_ACCEPT_TOOL_NAMES only if they cannot write files/git, otherwise wire them through the approval ladder first.`)
}

export function createToolHost(ctx: ToolHostCtx): AgentToolHost {
  const collected: AgentAction[] = []
  return {
    async call(name, args) {
      const impl = TOOL_IMPLS.find((t) => t.name === name)
      if (!impl) return { result: `Unknown tool: ${name}`, isError: true }
      if (ctx.allowedTools && !ctx.allowedTools.has(name)) {
        return {
          result: `${name} is unavailable on this turn: another review operation holds this repo and may overwrite the review it started from, so an edit made now could be lost. Say so, and let the reviewer re-ask once that operation has finished.`,
          isError: true
        }
      }
      const parsed = z.object(impl.input).safeParse(args)
      if (!parsed.success) return { result: `Invalid arguments for ${name}: ${parsed.error.message}`, isError: true }
      try {
        const out = await impl.run(ctx, parsed.data)
        if (out.action) {
          ctx.emit({ type: 'action', action: out.action })
          collected.push(out.action)
        }
        return out
      } catch (err) {
        return { result: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
    collected() {
      return collected
    }
  }
}
