/* Screenshot seed (dev only): builds a fixture repo + a pre-seeded db with a
 * generated review and two populated chats (the review agent on Claude, plus a
 * second chat switched to Codex). Prints { repo, db, sessionId } as JSON so a
 * launcher can serve with `LIMN_DB=<db> node bin/limn.js service serve` and open
 * the URL from `scripts/dev-url.mts`. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, fixtureWrite, fixtureGit } from '../tests/helpers/fixtureRepo'
import { getDiff, resolveRefInput } from '../src/server/git'
import { FakeEngine } from '../src/server/engines/fake'
import { mergeAnnotations } from '../src/server/engines/validate'
import { openDb } from '../src/server/db/db'
import {
  createSession, updateSessionMeta, addIteration, createChatThread,
  addChatMessage, setThreadAgent, setThreadEngineSession, upsertComment, setArtifacts
} from '../src/server/db/sessions'
import type { RefPair } from '../src/shared/types'
import { narrationText } from '../src/shared/types'

const fx = makeFixtureRepo()
// recognized-format spec + plan written on the branch (Superpowers convention),
// so the review surfaces the format-flagged artifacts in the diff + sidebar
const SPEC = 'docs/superpowers/specs/2026-06-12-rate-limit-design.md'
const PLAN = 'docs/superpowers/plans/2026-06-12-rate-limit.md'
fixtureWrite(fx.dir, SPEC, '# Rate limiting spec\n\nGoal: protect the API on branch feature.\n\n- requests are capped per client\n- the cap is configurable\n')
fixtureWrite(fx.dir, PLAN, '# Rate limiting plan\n\n1. add a token-bucket limiter\n2. wire it into the request path\n3. expose the cap as config\n')
fixtureGit(fx.dir, 'add', '-A')
fixtureGit(fx.dir, 'commit', '-m', 'spec + plan for rate limiting')
// a long file with one small mid-file change — gives the diff real folds so the
// in-place-edit demos (expander batches, fold-crossing growth/navigation) have
// something to reveal. Added on main, merged into feature, then tweaked there.
// LIMN_SEED_CHECKPOINT=1: the diff-layout demo. long.ts is 60 lines so the run between
// two changes exceeds a fold step; the approval sits one commit behind the tip, and
// the review was generated a commit earlier still, so there are approval and agent-
// review sheets to pull and the drift rails have something to mark. The stack itself
// is review state (sessions.diff_stack), not a pref — pull sheets in the shot with
// `cdp-shot.mts --eval` (click `.stk-tab`). LIMN_SEED_PREFS='{"sidebarView":"\"tree\""}'
// pre-seeds the prefs table (values are the JSON strings the store writes).
const CHECKPOINT = process.env.LIMN_SEED_CHECKPOINT === '1'
const LONG = CHECKPOINT ? 60 : 34
const longLines = (v25: string, v58 = 'export const v58 = 58'): string =>
  Array.from({ length: LONG }, (_, i) => (i === 24 ? v25 : i === 57 ? v58 : `export const v${i + 1} = ${i + 1}`)).join('\n') + '\n'
// two files that share a basename in different sub-directories (src/main/ipc.ts and
// src/renderer/ipc.ts), both modified on the branch. The rail's grouped/tree file
// lists have to disambiguate them by directory — with a flat basename list they'd
// read as the same file twice. Same top-level dir (`src`), so FakeEngine's by-dir
// grouping puts them in one section spanning two directories.
const ipc = (side: string, n: number): string =>
  `export const channel = '${side}:ipc'\nexport function send(msg: string): number {\n  return msg.length + ${n}\n}\n`
fixtureGit(fx.dir, 'checkout', '-q', 'main')
fixtureWrite(fx.dir, 'src/long.ts', longLines('export const v25 = 25'))
fixtureWrite(fx.dir, 'src/main/ipc.ts', ipc('main', 1))
fixtureWrite(fx.dir, 'src/renderer/ipc.ts', ipc('renderer', 1))
fixtureGit(fx.dir, 'add', '-A')
fixtureGit(fx.dir, 'commit', '-m', 'add long.ts + the ipc pair')
fixtureGit(fx.dir, 'checkout', '-q', 'feature')
fixtureGit(fx.dir, 'merge', '-q', '--no-edit', 'main')
fixtureWrite(fx.dir, 'src/long.ts', longLines('export const v25 = 25 * FACTOR'))
fixtureWrite(fx.dir, 'src/main/ipc.ts', ipc('main', 2))
fixtureWrite(fx.dir, 'src/renderer/ipc.ts', ipc('renderer', 2))
fixtureGit(fx.dir, 'add', '-A')
fixtureGit(fx.dir, 'commit', '-m', 'scale v25 by FACTOR; bump both ipc channels')
const approvedAt = fixtureGit(fx.dir, 'rev-parse', 'HEAD')
if (CHECKPOINT) {
  // after the approval: the v25 line moves again and v58 changes for the first time
  fixtureWrite(fx.dir, 'src/long.ts', longLines('export const v25 = 25 * FACTOR // scaled', 'export const v58 = 58 + OFFSET'))
  fixtureGit(fx.dir, 'add', '-A')
  fixtureGit(fx.dir, 'commit', '-m', 'annotate v25; offset v58')
}
const sk = await getDiff(fx.dir, 'main', 'feature')
const run = new FakeEngine().generateReview({ repo: fx.dir, branch: 'feature', base: 'main', diff: sk, artifacts: [] })
for await (const _ of run.events) { /* drain */ }
const { value, sessionId: engineSession } = await run.result
const { annotations } = mergeAnnotations(sk, value.annotations)
// the FakeEngine doesn't emit a planMap; synthesize one so the spec acceptance
// list + plan steps (and the per-step comment affordance) render in the spine.
const firstSection = annotations.sections[0]?.id ?? 's1'
annotations.planMap = {
  acceptance: [
    { text: 'requests are capped per client', met: true },
    { text: 'the cap is configurable', met: 'partial' }
  ],
  steps: [
    { n: 1, text: 'add a token-bucket limiter', sectionId: firstSection, status: 'done' },
    { n: 2, text: 'wire it into the request path', sectionId: firstSection, status: 'changed' },
    { n: 3, text: 'expose the cap as config', sectionId: firstSection, status: 'missing' }
  ],
  deviations: [
    { text: 'the cap was hard-coded to 100 rather than read from config', sectionId: firstSection }
  ]
}

const base = await resolveRefInput(fx.dir, 'main')
const compare = await resolveRefInput(fx.dir, 'feature')
const pair: RefPair = {
  base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
  compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
}

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-shot-')), 'limn.db')
const { db } = openDb(dbFile)

// review generated by Claude · Opus
const session = createSession(db, fx.dir, pair, { engine: 'claude', model: 'opus' })
updateSessionMeta(db, session.id, {
  engine: 'claude', model: 'opus',
  annotations,
  reviewedAtSha: CHECKPOINT ? fx.shas.firstFeature : compare.sha,
  approvedSha: CHECKPOINT ? approvedAt : compare.sha
})
if (process.env.LIMN_SEED_PREFS) {
  for (const [k, v] of Object.entries(JSON.parse(process.env.LIMN_SEED_PREFS) as Record<string, string>)) {
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
  }
}
addIteration(db, session.id, { n: 1, engine: 'claude', sessionId: engineSession, endSha: compare.sha, at: 'now', title: annotations.title, summary: annotations.summary, annotations, scope: 'full' })
setArtifacts(db, session.id, [{ role: 'spec', path: SPEC }, { role: 'plan', path: PLAN }])

// default chats: review (claude/opus, bound to the gen session) + a companion user
// chat. Both are seeded explicitly — the review thread is created up front by
// beginReview, and the user chat (which gets messages below) stands in for one a
// user started; its title mirrors the auto-title derived from its first message.
const reviewChat = createChatThread(db, session.id, { kind: 'review', agent: { engine: 'claude', model: 'opus' }, engineSessionId: engineSession, title: 'Review agent' })
const userChat = createChatThread(db, session.id, { kind: 'user', agent: { engine: 'claude', model: 'opus' }, title: 'Do a quick security pass on the n…' })

// populate the review chat (resumes the review agent's session — full context)
addChatMessage(db, reviewChat.id, { role: 'user', text: 'Why did you flag the early return in `src/a.ts`?', at: 'now' })
addChatMessage(db, reviewChat.id, {
  role: 'agent', at: 'now', text: [
    'Good question — the flag is about **behavior on the empty input**, not style.',
    '',
    '- Before, the function always returned a number.',
    '- The new guard returns `null`, so callers must handle it.',
    '',
    '```ts',
    'if (!input) return null // new — callers now see null',
    '```',
    '',
    'Only `parseRefInput` calls it today, and it already null-checks, so this is safe.'
  ].join('\n'),
  // tool actions: point + suggest + a comment it left + a comment it resolved
  actions: [
    { kind: 'point', stops: [{ target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' } }] },
    { kind: 'comment_added', comment: {
      id: 'agent-c1', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' },
      author: 'agent', text: 'guard note', status: 'resolved', replies: [], createdAt: 'now', iteration: 1
    } },
    { kind: 'comment_resolved', commentId: 'user-c1', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 5, hunkRange: '', lineContent: '' }, verdict: 'addressed', note: 'Confirmed and wired a first use.' },
    { kind: 'review_edited', field: 'summary' },
    { kind: 'suggest_viewed', files: ['src/a.ts'], note: 'You seem to fully understand the guard now.' }
  ]
})

// second chat: switched to Codex · gpt-5.5 (high) and asked a security question
setThreadAgent(db, userChat.id, { engine: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' })
setThreadEngineSession(db, userChat.id, 'codex-thread-1')
addChatMessage(db, userChat.id, { role: 'user', text: 'Do a quick security pass on the new branch.', at: 'now' })
addChatMessage(db, userChat.id, {
  role: 'agent', at: 'now', text: [
    '## Security pass',
    '',
    'Nothing high-risk in this diff. Per-file read:',
    '',
    '| File | Surface | Verdict |',
    '| --- | --- | --- |',
    '| `src/a.ts` | guard + constant | ~~risky~~ *safe* |',
    '| `src/b.ts` | returns a constant | safe |',
    '| `src/old.ts` | **deleted** | no exported secrets |',
    '',
    'Steps I checked, in order:',
    '',
    '1. input handling on the new guard',
    '2. path / injection surfaces',
    '3. auth boundaries',
    '',
    'No injection, path, or auth surfaces changed — see the [OWASP cheatsheet](https://cheatsheetseries.owasp.org/) for the checklist I follow. Looks clean.'
  ].join('\n')
})

// agent-authored comment (identity → the review agent's chat) + a user comment
// the agent replied to and resolved (the round-trip with a verdict badge).
upsertComment(db, session.id, {
  id: 'agent-c1',
  anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@ -1,4 +1,5 @@', lineContent: '  return 2' },
  author: 'agent', agentRef: { engine: 'claude', model: 'opus' }, threadId: reviewChat.id,
  text: 'Heads up: this guard makes the return type `number | null`, so the two callers must null-check.',
  status: 'resolved', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-c1',
  anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 5, hunkRange: '@@ -1,4 +1,5 @@', lineContent: 'export const J = 20' },
  author: 'user', text: 'Is this constant actually used anywhere yet?',
  status: 'resolved',
  resolution: { verdict: 'addressed', note: 'Confirmed and wired a first use.', commit: 'a1b2c3d' },
  replies: [{
    author: 'agent', text: 'Good catch — it was dead. I referenced it from `b.ts` so it is exercised now.',
    at: 'now', agentRef: { engine: 'claude', model: 'opus' }, threadId: reviewChat.id
  }],
  createdAt: 'now', iteration: 1
})

// a still-queued comment, so the batch CTA shows and a real batch run has work
upsertComment(db, session.id, {
  id: 'user-q1',
  anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 4, hunkRange: '@@ -1,4 +1,5 @@', lineContent: 'export const K = 10' },
  author: 'user', text: 'Can you add a short test covering K?',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})

// comments on the non-diff agentic-review elements — these exercise the new
// per-element commenting (summary / section diagram / file / plan step / doc block).
upsertComment(db, session.id, {
  id: 'user-summary1', anchor: { kind: 'summary' },
  author: 'user', text: 'Please call out the rollout + runbook impact in this summary.',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-diagram1', anchor: { kind: 'section', sectionId: firstSection, part: 'diagram' },
  author: 'user', text: 'The diagram should show the limiter sitting before auth, not after it.',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-file1', anchor: { kind: 'file', file: 'src/a.ts' },
  author: 'user', text: 'Whole-file note: can we split the limiter from the request-path wiring?',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-step1', anchor: { kind: 'plan-step', stepN: 1 },
  author: 'user', text: 'Should step 1 use a sliding window instead of a token bucket?',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-art1', anchor: { kind: 'artifact', path: PLAN, line: 3, lineContent: '1. add a token-bucket limiter' },
  author: 'user', text: 'Note the default bucket size right here so reviewers see the chosen cap.',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})

// follow-up pass: comment on the title, an acceptance criterion, a deviation, a
// hunk, and text selections in the narration + the doc (proves "comment on
// everything" + text-selection commenting).
const narration = (annotations.sections[0] ? narrationText(annotations.sections[0]) : '') || 'the narration'
const narrationQuote = narration.split(' ').slice(0, 4).join(' ')
upsertComment(db, session.id, {
  id: 'user-title1', anchor: { kind: 'title' },
  author: 'user', text: 'Can the title say “per-client” so it’s unambiguous?',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-acc1', anchor: { kind: 'acceptance', index: 1 },
  author: 'user', text: 'How is “configurable” surfaced — env var or config file?',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-dev1', anchor: { kind: 'deviation', index: 0 },
  author: 'user', text: 'Please pull the cap from config before we merge, as the plan said.',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-sel-sec', anchor: { kind: 'selection', scope: { region: 'section', sectionId: firstSection }, quote: narrationQuote, prefix: '', suffix: '' },
  author: 'user', text: 'Selected the narration — is this the intended behavior on empty input?',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})
upsertComment(db, session.id, {
  id: 'user-sel-doc', anchor: { kind: 'selection', scope: { region: 'artifact', path: PLAN }, quote: 'token-bucket limiter', prefix: 'add a ', suffix: '' },
  author: 'user', text: 'Selected “token-bucket limiter” — consider a sliding window instead.',
  status: 'queued', replies: [], createdAt: 'now', iteration: 1
})

// LIMN_SEED_ACTIONS=1 (design board 14): pinned actions, each engine's last probe for
// this repo, and a "Simplify" action thread whose run 1 finished with two proposed
// findings — the launcher, the run bar / result card, the proposed boxes, the strip
// and the Chat pill all have something to show.
let simplifyChat: number | null = null
if (process.env.LIMN_SEED_ACTIONS === '1') {
  const prefs = (k: string, v: string): void => { db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v) }
  prefs('actions', JSON.stringify([
    { id: 'act-simplify', kind: 'skill', name: 'Simplify', body: 'simplify' },
    { id: 'act-security', kind: 'skill', name: 'Security review', body: 'security-review' },
    { id: 'act-prtk', kind: 'skill', name: 'PR review toolkit', body: 'pr-review-toolkit:review-pr' },
    { id: 'act-rebase', kind: 'prompt', name: 'Rebase onto main', body: 'Rebase this branch onto main and resolve conflicts. Keep both sides when in doubt.' },
    { id: 'act-churn', kind: 'prompt', name: 'Explain test churn', body: 'List every test whose assertions changed and say why.' }
  ]))
  const twoMin = new Date(Date.now() - 2 * 60_000).toISOString()
  prefs(`commands:claude:${fx.dir}`, JSON.stringify({ names: ['simplify', 'security-review', 'pr-review-toolkit:review-pr', 'compact', 'init'], checkedAt: twoMin, state: 'ok' }))
  prefs(`commands:codex:${fx.dir}`, JSON.stringify({ names: ['review', 'compact', '$security-review'], checkedAt: twoMin, state: 'ok' }))
  const t = createChatThread(db, session.id, { kind: 'user', agent: { engine: 'claude', model: 'opus' }, title: 'Simplify', action: { actionId: 'act-simplify', name: 'Simplify', kind: 'skill' } })
  simplifyChat = t.id
  const run = { actionId: 'act-simplify', runId: `run-${t.id}-1`, n: 1, name: 'Simplify', kind: 'skill' as const, findings: true }
  const startedAt = new Date(Date.now() - 4 * 60_000).toISOString()
  const endedAt = new Date(Date.now() - 3 * 60_000 + 48_000).toISOString()
  const f1 = {
    id: 'af-seed-1', anchor: { kind: 'diff' as const, file: 'src/a.ts', side: 'new' as const, line: 3, hunkRange: '@@ -1,4 +1,5 @@', lineContent: '' },
    author: 'agent' as const, agentRef: { engine: 'claude' as const, model: 'opus' }, threadId: t.id,
    text: '`rows.reduce((a, r) => a + r.total, 0)` is `gross()` from totals.ts. Call it once and drop the local.',
    severity: 'note' as const, status: 'proposed' as const, source: { actionId: 'act-simplify', runId: run.runId, threadId: t.id },
    replies: [], createdAt: endedAt, iteration: 1
  }
  const f2 = {
    ...f1, id: 'af-seed-2', anchor: { ...f1.anchor, line: 4 }, severity: 'risk' as const,
    text: '`round()` is no longer applied on this path — `applyProration` returns fractional cents. Either round here or inside it.'
  }
  upsertComment(db, session.id, f1)
  upsertComment(db, session.id, f2)
  addChatMessage(db, t.id, { role: 'user', text: '/simplify', at: startedAt, run })
  addChatMessage(db, t.id, {
    role: 'agent', at: endedAt,
    text: 'Two simplifications, none behavioural. The webhook dedupe key can also drop its `JSON.stringify`; I left that out as it changes the stored key.',
    actions: [{ kind: 'finding_added', comment: f1 }, { kind: 'finding_added', comment: f2 }],
    runResult: { runId: run.runId, outcome: 'finished', extraction: 'ok', delta: { commits: 0, files: 0, dirty: false } }
  })
  setThreadEngineSession(db, t.id, 'claude-simplify-1')
}

// extra sessions so the repo hub list + the review's session dropdown have content
// (multiple reviews of the same branch, latest on top)
const s2 = createSession(db, fx.dir, {
  base: { kind: 'commit', symbol: 'HEAD~1', anchorSha: fx.shas.firstFeature },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: compare.sha }
}, { engine: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' })
updateSessionMeta(db, s2.id, { annotations: { title: 'Incremental pass since last commit', summary: '', sections: [], questions: [] } })
const s3 = createSession(db, fx.dir, {
  base: { kind: 'branch', symbol: 'main', anchorSha: base.sha },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: compare.sha }
}, { engine: 'claude', model: 'sonnet' })
updateSessionMeta(db, s3.id, { annotations: { title: 'First look', summary: '', sections: [], questions: [] } })

console.log(JSON.stringify({ repo: fx.dir, db: dbFile, sessionId: session.id, reviewChat: reviewChat.id, userChat: userChat.id, ...(simplifyChat != null ? { simplifyChat } : {}) }))
