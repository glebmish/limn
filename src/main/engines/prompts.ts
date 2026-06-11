import type { Comment, CommentAnchor } from '../../shared/types.js'
import type { ReviewRequest } from './types.js'

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
3. Flag risky or surprising hunks in "flags" (risk: true for correctness/security concerns; risk: false for "worth a look"). Reference the exact file path and hunk range from the list above.
4. Optionally add a "diagram" per section: 2-5 nodes [label, kind, sub] showing the mechanism (kind "hi" = the key node, "new" = newly introduced, "" = plain). Add "insight.caption" explaining the one thing the diagram shows.
5. "title": a one-line description of the whole change. "summary": 2-4 sentences a reviewer should read before anything else.
6. If a spec/plan artifact exists: fill "planMap" — acceptance criteria with met true/false/"partial", plan steps mapped to your section ids with status done/changed/missing, and "deviations" where the implementation diverged from the stated plan.
7. "questions": open questions where you genuinely need the human's decision (empty array if none). Give each a short stable id like "q1".

Be concrete and specific to this codebase. Do not invent files or content. Keep section count between 2 and 8.`
}

export function buildChatPrompt(message: string, anchor?: CommentAnchor): string {
  const ctx = anchor ? `\n\nContext — the user is asking about ${describeAnchor(anchor)}.` : ''
  return `${message}${ctx}

Answer the question conversationally and concisely (this is a chat panel next to the code review). You may read files and run read-only git commands to check your answer. Do NOT modify any files.`
}

export function buildFixPrompt(comments: Comment[], steer?: string): string {
  const list = comments
    .map((c, i) => `${i + 1}. [id: ${c.id}] on ${describeAnchor(c.anchor)}:\n   "${c.text}"${c.replies.length ? `\n   thread: ${c.replies.map((r) => `${r.author}: ${r.text}`).join(' | ')}` : ''}`)
    .join('\n')
  const steerBlock = steer ? `\nSteer from the reviewer (overall direction): ${steer}\n` : ''

  return `The reviewer finished a pass and is sending you their comments to address. Apply each one to the code on the current branch.
${steerBlock}
Comments:
${list}

Instructions:
- Address every comment, or explicitly skip it with a reason if it should not be done.
- Make the edits, keep the existing code style, and run a quick sanity check (typecheck/tests) if the repo has one configured.
- Commit your work on the current branch. Use one or more commits; message format: "local-review: <short description>".
- Answers to your earlier open questions (anchor "your open question …") are decisions, not code comments — apply what they decide.

Return the structured result: "summary" (2-3 sentences on what you did) and one resolution per comment id with verdict:
- "addressed" — done as asked
- "reworked" — done, but differently than suggested (explain in note)
- "skipped" — not done (explain why in note)`
}
