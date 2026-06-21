import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentAction, AgentRef, Comment, CommentAnchor, CommentReply, EngineEvent, FocusTarget, ReviewAnnotations } from '../../shared/types.js'
import { addIteration, loadReviewState, updateSessionMeta, upsertComment } from '../db/sessions.js'
import { execGit } from '../exec.js'
import { headSha } from '../git.js'

// One engine-agnostic tool set, hosted two ways: Claude consumes the zod `input`
// shape directly via `tool(name, desc, shape, handler)`; Codex's external MCP
// server reflects the same shape into JSON Schema. A handler runs in the Electron
// main process — it may touch the DB / git, emit a live `action` event, and
// returns the text the model sees. Phase 1 ships the two no-persistence tools
// (`focus`, `suggest_mark_viewed`); comment/review/commit tools follow.

/** Engine-agnostic tool definition (the shape both engines reflect). */
export interface ToolDef { name: string; description: string; input: z.ZodRawShape }

/** Per-turn context a tool host is bound to. Phase 1 only needs `emit`; the rest
 *  are here so the comment/review/commit tools plug in without reshaping callers. */
export interface ToolHostCtx {
  db: DatabaseSync
  sessionId: number
  threadId: number
  opId: string
  repo: string
  agent: AgentRef
  writeEnabled: boolean
  /** the engine session backing this turn's thread, recorded on a commit's iteration. */
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
function normalizeAnchor(a: z.infer<typeof focusTarget>): CommentAnchor {
  return a.kind === 'diff'
    ? { kind: 'diff', file: a.file, side: a.side, line: a.line, hunkRange: a.hunkRange ?? '', lineContent: a.lineContent ?? '' }
    : a
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
    case 'hunk': return `hunk ${a.hunkRange} in ${a.file}`
    case 'selection': return `selected “${a.quote}”`
  }
}

const COMMIT_INPUT = {
  message: z.string().min(1),
  resolutions: z.array(z.object({
    commentId: z.string().min(1),
    verdict: z.enum(['addressed', 'reworked', 'skipped']),
    note: z.string()
  })).optional()
} satisfies z.ZodRawShape

// ── tool implementations ──────────────────────────────────────
interface ToolImpl extends ToolDef {
  /** a code-editing tool — withheld unless the turn is writeEnabled. */
  write?: boolean
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
      'a file, or a specific diff line. Use this to point the reviewer at what you are ' +
      'discussing. Leaves a clickable chip in the chat so they can re-focus later.',
    input: FOCUS_INPUT,
    run: (_ctx, raw) => {
      const { target } = raw as z.infer<z.ZodObject<typeof FOCUS_INPUT>>
      const anchor: FocusTarget = target.kind === 'diff'
        ? { kind: 'diff', file: target.file, side: target.side, line: target.line, hunkRange: target.hunkRange ?? '', lineContent: target.lineContent ?? '' }
        : target
      return { result: `Focused ${describeFocus(anchor)}.`, action: { kind: 'focus', anchor } }
    }
  },
  {
    name: 'suggest_mark_viewed',
    description:
      'Suggest the reviewer mark file(s) and/or section(s) as viewed — for when they ' +
      'signal they understand a part. This only proposes: it renders a button in chat ' +
      'and nothing changes until the reviewer confirms. Provide at least one file or section.',
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
      'by status. Use it to find the ids and text of the queued comments you are answering.',
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
      'file, section, or the summary. Use it to flag something you noticed while answering.',
    input: ADD_COMMENT_INPUT,
    run: (ctx, raw) => {
      const { anchor: rawAnchor, text } = raw as z.infer<z.ZodObject<typeof ADD_COMMENT_INPUT>>
      const anchor = normalizeAnchor(rawAnchor)
      const iteration = loadReviewState(ctx.db, ctx.sessionId).iterations.length
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
      'note. Use it after handling a reviewer comment.',
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
  },
  {
    name: 'commit_changes',
    description:
      'Commit the code edits you made on the branch and record an iteration. Pass a commit ' +
      'message and, optionally, the resolutions for the comments this commit addresses ' +
      '(each: commentId, verdict addressed/reworked/skipped, note). Only available on write-enabled turns.',
    input: COMMIT_INPUT,
    write: true,
    run: async (ctx, raw) => {
      if (!ctx.writeEnabled) throw new Error('Code edits are disabled this turn (dirty tree, wrong branch, or fixed-commit compare).')
      const { message, resolutions } = raw as z.infer<z.ZodObject<typeof COMMIT_INPUT>>
      await execGit(ctx.repo, ['add', '-A'])
      const staged = (await execGit(ctx.repo, ['status', '--porcelain'])).trim().length > 0
      let sha = await headSha(ctx.repo)
      const files: string[] = []
      if (staged) {
        files.push(...(await execGit(ctx.repo, ['diff', '--cached', '--name-only'])).trim().split('\n').filter(Boolean))
        await execGit(ctx.repo, ['commit', '-m', message])
        sha = await headSha(ctx.repo)
        const st = loadReviewState(ctx.db, ctx.sessionId)
        addIteration(ctx.db, ctx.sessionId, {
          n: st.iterations.length + 1, engine: ctx.agent.engine, sessionId: ctx.engineSessionId ?? '',
          endSha: sha, at: new Date().toISOString(), summary: message
        })
      }
      const short = sha.slice(0, 7)
      if (resolutions?.length) {
        const st = loadReviewState(ctx.db, ctx.sessionId)
        for (const r of resolutions) {
          const c = st.comments.find((x) => x.id === r.commentId)
          if (!c) continue
          c.status = 'resolved'
          c.resolution = { verdict: r.verdict, note: r.note, agentRef: ctx.agent, ...(staged ? { commit: short } : {}) }
          upsertComment(ctx.db, ctx.sessionId, c)
        }
      }
      // only a real commit yields a code_committed action — otherwise the chip
      // would mislabel the pre-existing HEAD as this turn's commit.
      return staged
        ? { result: `Committed ${short} (${files.length} file(s)).`, action: { kind: 'code_committed', sha: short, files, message } }
        : { result: 'No code changes to commit; recorded resolutions.' }
    }
  }
]

/** The tools as the model sees them, for Claude's `allowedTools` (the SDK prefixes
 *  in-process MCP tools with `mcp__<server>__`). */
export const LR_TOOLS: ToolDef[] = TOOL_IMPLS.map(({ name, description, input }) => ({ name, description, input }))

/** Tool names to allow this turn. Write tools (commit_changes) are withheld unless
 *  the turn is write-enabled, so the agent degrades to review/comment-only. */
export function lrAllowedToolNames(writeEnabled = false): string[] {
  return TOOL_IMPLS.filter((t) => writeEnabled || !t.write).map((t) => `mcp__localreview__${t.name}`)
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
