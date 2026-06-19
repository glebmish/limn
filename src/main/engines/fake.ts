import fs from 'node:fs'
import path from 'node:path'
import type { ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'

/** Deterministic engine for contract tests and demo mode (LR_DEMO=1). */
export class FakeEngine implements ReviewEngine {
  id = 'claude' as const

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
    const batch = Boolean(turn.tools && turn.writeEnabled)
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
    const text = batch ? batchText : chatText
    const result = (async () => {
      q.push({ type: 'status', text: batch ? 'Applying your comments…' : 'Reading src/a.ts…' })
      // structured tool-call lifecycle for the activity log (wf-D): a settled grep,
      // an expandable read with a diff, and an errored grep.
      q.push({ type: 'tool', call: { id: 't1', verb: 'grep', name: 'Grep', arg: 'parseRefInput', state: 'run' } })
      q.push({ type: 'tool', call: { id: 't1', verb: 'grep', name: 'Grep', arg: 'parseRefInput', state: 'ok', meta: '3 hits', out: 'src/a.ts:12\nsrc/a.ts:48\nsrc/parse.ts:5' } })
      q.push({ type: 'tool', call: { id: 't2', verb: 'read', name: 'Read', arg: 'src/a.ts · L1–40', kv: [['path', 'src/a.ts'], ['range', 'L1-40']], state: 'run' } })
      q.push({ type: 'tool', call: { id: 't2', verb: 'read', name: 'Read', arg: 'src/a.ts · L1–40', kv: [['path', 'src/a.ts'], ['range', 'L1-40']], state: 'ok', meta: '40 lines', out: 'export function parseRefInput(input) {\n-  if (input == null) throw new Error()\n+  if (!input) return null // guard added in this branch\n  return resolve(input)\n}', outMore: 'show 31 more lines' } })
      q.push({ type: 'tool', call: { id: 't3', verb: 'grep', name: 'Grep', arg: "require('child_process')", kv: [['pattern', "require('child_process')"]], state: 'run' } })
      q.push({ type: 'tool', call: { id: 't3', verb: 'grep', name: 'Grep', arg: "require('child_process')", state: 'err', out: 'Error: ripgrep exited 2 — invalid regex at offset 8 (unbalanced parenthesis)' } })
      if (batch && turn.tools) {
        // unified batch: resolve the sent comments + commit via the tools
        const listed = await turn.tools.call('list_comments', { status: 'sent' })
        let ids: string[] = []
        try { ids = (JSON.parse(listed.result) as { id: string }[]).map((c) => c.id) } catch { /* none */ }
        try { fs.appendFileSync(path.join(turn.repo, 'src/a.ts'), '\n// addressed by agent\n') } catch { /* repo may be read-only in tests */ }
        await turn.tools.call('commit_changes', {
          message: 'local-review: batch fixes',
          resolutions: ids.map((id) => ({ commentId: id, verdict: 'addressed' as const, note: 'Done (demo).' }))
        })
      } else if (turn.tools) {
        // tool-enabled read-only chat: exercise the focus + suggest action pipe
        await turn.tools.call('focus', { target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 } })
        await turn.tools.call('suggest_mark_viewed', { files: ['src/a.ts'], note: 'covered above' })
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
