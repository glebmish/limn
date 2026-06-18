import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Comment, CommentAnchor, FixResult, ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'

/** Deterministic engine for contract tests and demo mode (LR_DEMO=1). */
export class FakeEngine implements ReviewEngine {
  id = 'claude' as const

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    const q = new EventQueue()
    const result = (async () => {
      q.push({ type: 'status', text: 'Exploring the repository…' })
      q.push({ type: 'tool', text: `git log ${req.base}..${req.branch}` })
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
        order: i + 1,
        flags: [] as ReviewAnnotations['sections'][number]['flags']
      }))
      const firstWithHunks = req.diff.files.find((f) => f.hunks.length > 0)
      if (firstWithHunks && sections.length > 0) {
        const sec = sections.find((s) => s.files.includes(firstWithHunks.path))!
        sec.flags.push({
          file: firstWithHunks.path,
          hunkRange: firstWithHunks.hunks[0].range,
          risk: true,
          label: 'Flagged for you:',
          text: 'Demo flag — the first hunk of the change.'
        })
      }
      q.push({ type: 'status', text: 'Writing the guided review…' })
      const value: ReviewAnnotations = {
        title: `Changes on ${req.branch}`,
        summary: `Demo review of ${req.diff.files.length} files grouped into ${sections.length} sections.`,
        sections,
        questions: [{ id: 'q1', text: 'Demo question: should the config default stay as-is?' }]
      }
      q.push({ type: 'done' })
      q.close()
      return { value, sessionId: `fake-${Date.now()}` }
    })()
    return { events: q.iterable(), result, cancel: () => q.close() }
  }

  chat(turn: ChatTurn): EngineRun<string> {
    const q = new EventQueue()
    const modelTag = turn.model ? ` using **${turn.model}**` : ''
    const text = [
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
    const result = (async () => {
      q.push({ type: 'status', text: 'Reading src/a.ts…' })
      q.push({ type: 'tool', text: 'Grep parseRefInput' })
      // stream the answer in chunks so the panel shows live tokens
      for (const chunk of text.match(/[\s\S]{1,48}/g) ?? [text]) q.push({ type: 'text', text: chunk })
      q.push({ type: 'done' })
      q.close()
      return { value: text, sessionId: turn.engineSessionId || `fake-chat-${Date.now()}` }
    })()
    return { events: q.iterable(), result, cancel: () => q.close() }
  }

  applyFeedback(repo: string, sessionId: string, comments: Comment[]): EngineRun<FixResult> {
    const q = new EventQueue()
    const result = (async () => {
      q.push({ type: 'status', text: 'Applying comments…' })
      // touch the first diff-anchored file (or any file) and commit
      const target = comments.map((c) => c.anchor).find((a): a is Extract<CommentAnchor, { kind: 'diff' }> => a.kind === 'diff')
      const rel = target?.file ?? 'FAKE_ENGINE.md'
      const p = path.join(repo, rel)
      fs.appendFileSync(p, '\n// addressed by fake engine\n')
      execFileSync('git', ['add', '-A'], { cwd: repo })
      execFileSync('git', ['commit', '-m', 'local-review: fake engine fixes'], {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fake', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'Fake', GIT_COMMITTER_EMAIL: 'f@x' }
      })
      q.push({ type: 'done' })
      q.close()
      return {
        value: {
          summary: `Applied ${comments.length} comment(s).`,
          resolutions: comments.map((c) => ({ commentId: c.id, verdict: 'addressed' as const, note: 'Done (demo).' }))
        },
        sessionId
      }
    })()
    return { events: q.iterable(), result, cancel: () => q.close() }
  }
}
