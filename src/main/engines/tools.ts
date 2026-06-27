import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentAction, AgentRef, Comment, CommentAnchor, CommentReply, EngineEvent, FocusTarget, ReviewAnnotations } from '../../shared/types.js'
import { loadReviewState, updateSessionMeta, upsertComment } from '../db/sessions.js'

// One engine-agnostic tool set, hosted two ways: Claude consumes the zod `input`
// shape directly via `tool(name, desc, shape, handler)`; Codex app-server reaches
// the same shape through a per-turn external MCP server. A handler runs in the
// Electron main process — it may touch the DB / git, emit a live `action` event,
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
    // hunkRange/lineContent matter for comment anchoring, not for focus — accept
    // them so a FocusTarget is well-formed, but the agent may omit them.
    hunkRange: z.string().optional(),
    lineContent: z.string().optional()
  })
])

const FOCUS_INPUT = { target: focusTarget } satisfies z.ZodRawShape
const TOUR_INPUT = {
  stops: z.array(z.object({
    target: focusTarget,
    note: z.string().optional()
  })).min(2).max(8),
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
const EDIT_REVIEW_INPUT = {
  field: z.enum(['title', 'summary', 'section.what', 'section.desc']),
  sectionId: z.string().optional(),
  value: z.string()
} satisfies z.ZodRawShape

let commentSeq = 0
function normalizeFocusTarget(a: z.infer<typeof focusTarget>): FocusTarget {
  return a.kind === 'diff'
    ? { kind: 'diff', file: a.file, side: a.side, line: a.line, hunkRange: a.hunkRange ?? '', lineContent: a.lineContent ?? '' }
    : a
}
function normalizeAnchor(a: z.infer<typeof focusTarget>): CommentAnchor {
  return normalizeFocusTarget(a)
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
    case 'diff': return `${a.file}:${a.line}`
  }
}

const TOOL_IMPLS: ToolImpl[] = [
  {
    name: 'focus',
    description:
      'Scroll the review to a spot and briefly highlight it: the summary, a section, ' +
      'a file, or a specific diff line. ALWAYS call this whenever your answer refers to a ' +
      'place in the code or review (a file, a function, a diff line) — call focus to jump ' +
      'the reviewer there instead of only naming the path in prose. Prefer the most specific ' +
      'target available (a diff line over a file). It leaves a clickable chip in the chat so ' +
      'the reviewer can re-focus later. Calling focus is the primary way you point at code; ' +
      'do it proactively, not only when asked.',
    input: FOCUS_INPUT,
    run: (_ctx, raw) => {
      const { target } = raw as z.infer<z.ZodObject<typeof FOCUS_INPUT>>
      const anchor = normalizeFocusTarget(target)
      return { result: `Focused ${describeFocus(anchor)}.`, action: { kind: 'focus', anchor } }
    }
  },
  {
    name: 'tour',
    description:
      'Create a multi-stop walkthrough across the review. Use this when your answer points ' +
      'at a sequence spanning multiple files, sections, or diff lines — for example a value ' +
      'flow, call chain, lifecycle path, or cross-file risk. Each stop is a focus target and ' +
      'an optional short note. It leaves an interactive walkthrough card in the chat; the ' +
      'reviewer can click stops or use Prev/Next to re-focus each location. Use loop=true ' +
      'when the sequence is cyclic or useful to repeat.',
    input: TOUR_INPUT,
    run: (_ctx, raw) => {
      const { stops, loop } = raw as z.infer<z.ZodObject<typeof TOUR_INPUT>>
      const action: AgentAction = {
        kind: 'tour',
        stops: stops.map((s) => ({
          target: normalizeFocusTarget(s.target),
          ...(s.note?.trim() ? { note: s.note.trim() } : {})
        })),
        ...(loop ? { loop: true } : {})
      }
      const labels = action.stops.map((s) => describeFocus(s.target)).join(' → ')
      return { result: `Created a ${action.stops.length}-stop walkthrough: ${labels}.`, action }
    }
  },
  {
    name: 'suggest_mark_viewed',
    description:
      'Propose that the reviewer mark file(s) and/or section(s) as viewed. Call this ' +
      'proactively whenever you have finished walking the reviewer through a file or section, ' +
      'or they signal they understand it — don\'t wait to be asked. It only proposes: it ' +
      'renders a confirm button in chat and nothing changes until the reviewer clicks it, so ' +
      'suggesting is low-risk. Provide at least one file or section, and a short note on what ' +
      'was covered.',
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
      'Anchor as specifically as possible.',
    input: ADD_COMMENT_INPUT,
    run: (ctx, raw) => {
      const { anchor: rawAnchor, text } = raw as z.infer<z.ZodObject<typeof ADD_COMMENT_INPUT>>
      const anchor = normalizeAnchor(rawAnchor)
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
    description: 'Get the current guided review (title, summary, and each section’s name/desc/what) so you can reference or edit it.',
    input: GET_REVIEW_INPUT,
    run: (ctx) => {
      const ann = loadReviewState(ctx.db, ctx.sessionId).annotations
      if (!ann) return { result: 'No review has been generated yet.' }
      const slim = {
        title: ann.title, summary: ann.summary,
        sections: ann.sections.map((s) => ({ id: s.id, name: s.name, desc: s.desc, what: s.what }))
      }
      return { result: JSON.stringify(slim) }
    }
  },
  {
    name: 'edit_review',
    description:
      'Amend the guided review in place — the title, the summary, or a section’s narration ' +
      '(section.what / section.desc, with sectionId) — e.g. to add detail a reviewer’s question ' +
      'surfaced. Does not regenerate the whole review.',
    input: EDIT_REVIEW_INPUT,
    run: (ctx, raw) => {
      const { field, sectionId, value } = raw as z.infer<z.ZodObject<typeof EDIT_REVIEW_INPUT>>
      const ann: ReviewAnnotations | undefined = loadReviewState(ctx.db, ctx.sessionId).annotations
      if (!ann) throw new Error('No review to edit yet — generate one first')
      if (field === 'title') {
        ann.title = value
        updateSessionMeta(ctx.db, ctx.sessionId, { annotations: ann, title: value })
      } else if (field === 'summary') {
        ann.summary = value
        updateSessionMeta(ctx.db, ctx.sessionId, { annotations: ann, summary: value })
      } else {
        const sec = ann.sections.find((s) => s.id === sectionId)
        if (!sec) throw new Error(`No section with id ${sectionId}`)
        if (field === 'section.what') sec.what = value
        else sec.desc = value
        updateSessionMeta(ctx.db, ctx.sessionId, { annotations: ann })
      }
      return {
        result: `Updated ${field}${sectionId ? ` of section ${sectionId}` : ''}.`,
        action: { kind: 'review_edited', field, ...(sectionId ? { sectionId } : {}) }
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

export function createToolHost(ctx: ToolHostCtx): AgentToolHost {
  const collected: AgentAction[] = []
  return {
    async call(name, args) {
      const impl = TOOL_IMPLS.find((t) => t.name === name)
      if (!impl) return { result: `Unknown tool: ${name}`, isError: true }
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
