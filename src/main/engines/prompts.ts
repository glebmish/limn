import type { Comment, CommentAnchor } from '../../shared/types.js'
import type { ChatContext, ReviewRequest } from './types.js'

function describeAnchor(a: CommentAnchor): string {
  switch (a.kind) {
    case 'diff': return `${a.file} line ${a.line} (${a.side} side, hunk ${a.hunkRange}): \`${a.lineContent}\``
    case 'artifact': return `${a.path} line ${a.line}: \`${a.lineContent}\``
    case 'plan-step': return `plan step ${a.stepN}`
    case 'section': return `review section "${a.sectionId}"`
    case 'summary': return 'the overall review summary'
    case 'file': return `file ${a.file}`
    case 'question': return `your open question ${a.questionId}`
  }
}

export function buildReviewPrompt(req: ReviewRequest): string {
  const fileList = req.diff.files
    .map((f) => {
      const ranges = f.hunks.map((h) => h.range).join(', ')
      const tag = f.status === 'renamed' ? `renamed from ${f.oldPath}` : f.status
      return `- ${f.path} (${tag}, +${f.add}/−${f.del}${f.binary ? ', binary' : ''})${ranges ? ` hunks: ${ranges}` : ''}`
    })
    .join('\n')

  const artifactBlock = req.artifacts.length
    ? `\nProject artifacts to read (the intent this change is judged against):\n${req.artifacts.map((a) => `- ${a.path} (${a.role})`).join('\n')}\n`
    : '\nNo spec/plan artifacts were detected. If you find one in the repo (docs/, .claude/), list its path in artifactPaths.\n'

  return `You are the review guide for a local branch. Your job is to help a human review the branch \`${req.branch}\` against \`${req.base}\` in the repository at your working directory.

EXPLORE FIRST — you have full read access to the repo:
- Read the changed files in full, not just the diff hunks listed below.
- Find callers/usages of changed functions (grep), related tests, and read them.
- Use \`git log ${req.base}..${req.branch} --oneline\` and \`git show\` to understand the change history.
- Read the artifacts listed below if any.
${artifactBlock}
Changed files (${req.diff.files.length}) between merge-base ${req.diff.mergeBase.slice(0, 7)} and ${req.diff.headSha.slice(0, 7)}:
${fileList}

Then produce the structured review:
1. Group ALL changed files into logical sections (by what they accomplish together, not by directory). Every file in the list above must appear in exactly one section's "files" array, using the exact paths shown. Order sections by where the reviewer's attention pays off most (core logic first, tests/config later).
2. For each section write: "desc" — one sentence on why this section matters to the reviewer; "what" — plain-language explanation of what changed and why (this is your narration, the heart of the review).
3. Optionally add a "diagram" per section: 2-5 nodes [label, kind, sub] showing the mechanism (kind "hi" = the key node, "new" = newly introduced, "" = plain). Add "insight.caption" explaining the one thing the diagram shows.
4. "title": a one-line description of the whole change. "summary": 2-4 sentences a reviewer should read before anything else.
5. If a spec/plan artifact exists: fill "planMap" — acceptance criteria with met true/false/"partial", plan steps mapped to your section ids with status done/changed/missing, and "deviations" where the implementation diverged from the stated plan.
6. "questions": open questions where you genuinely need the human's decision (empty array if none). Give each a short stable id like "q1".

Be concrete and specific to this codebase. Do not invent files or content. Keep section count between 2 and 8.`
}

export function buildChatPrompt(message: string, anchor?: CommentAnchor): string {
  const ctx = anchor ? `\n\nContext — the user is asking about ${describeAnchor(anchor)}.` : ''
  return `${message}${ctx}

Answer the question conversationally and concisely (this is a chat panel next to the code review). You may read files and run read-only git commands to check your answer. Do NOT modify any files.`
}

/** First turn of a fresh chat whose agent did NOT produce the review, so there's
 *  no engine session to resume — orient it from scratch with read access. */
export function buildSeededChatPrompt(ctx: ChatContext, message: string, anchor?: CommentAnchor): string {
  const summary = ctx.summary ? `\nReview summary so far:\n${ctx.summary}\n` : ''
  const aCtx = anchor ? `\n\nContext — the user is asking about ${describeAnchor(anchor)}.` : ''
  return `You are joining as a fresh assistant to discuss an in-progress local code review of branch \`${ctx.branch}\` against \`${ctx.base}\` in the repository at your working directory.
${summary}
You have full read access: read the changed files, grep for callers/tests, and use \`git log ${ctx.base}..${ctx.branch}\` / \`git show\` to ground your answer. Do NOT modify any files.

The reviewer asks:
${message}${aCtx}

Answer conversationally and concisely.`
}

/** The unified batch turn: the agent handles queued comments with its tools —
 *  editing & committing code, resolving, or replying — rather than returning a
 *  structured FixResult. When the thread has no engine session to resume,
 *  `context` seeds the review framing. */
export function buildBatchPrompt(comments: Comment[], steer?: string, context?: ChatContext): string {
  const list = comments
    .map((c, i) => `${i + 1}. [id: ${c.id}] on ${describeAnchor(c.anchor)}:\n   "${c.text}"${c.replies.length ? `\n   thread: ${c.replies.map((r) => `${r.author}: ${r.text}`).join(' | ')}` : ''}`)
    .join('\n')
  const steerBlock = steer ? `\nSteer from the reviewer (overall direction): ${steer}\n` : ''
  const seed = context
    ? `You are reviewing branch ${context.branch} against ${context.base}.${context.summary ? ` Review summary: ${context.summary}` : ''}\n\n`
    : ''

  return `${seed}The reviewer is sending you ${comments.length} comment(s) to handle on the current branch.
${steerBlock}
Comments:
${list}

Handle them using your tools:
- Address each comment by editing the code, or answer it with reply_to_comment if no change is needed.
- When you edit code, commit it with commit_changes — pass a short message ("local-review: …") and the resolutions for the comments that commit addresses (each: commentId, verdict, note). Verdicts: "addressed" (done as asked), "reworked" (done differently — explain), "skipped" (not done — explain). commit_changes records the iteration.
- For comments handled without a code change, call resolve_comment with the verdict and note.
- Keep the existing code style. Answers to your earlier open questions are decisions, not code comments.
- Finish with a 2-3 sentence summary of what you did.`
}
