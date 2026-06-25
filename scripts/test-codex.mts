/* Live Codex tool-host test (needs an authed `codex` CLI + network). Drives a real
 * read-only chat turn through the localhost MCP server and checks the agent called
 * the `focus` tool. Run: npx tsx scripts/test-codex.mts */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread } from '../src/main/db/sessions'
import { createToolHost } from '../src/main/engines/tools'
import { CodexEngine } from '../src/main/engines/codex'
import type { AgentAction, EngineEvent, RefPair } from '../src/shared/types'

const fx = makeFixtureRepo()
const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-')), 'db')).db
const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const s = createSession(db, fx.dir, pair, { engine: 'codex' })
const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'codex' } })

const events: EngineEvent[] = []
const host = createToolHost({
  db, sessionId: s.id, threadId: t.id, opId: 'o', repo: fx.dir,
  agent: { engine: 'codex' }, emit: (e) => events.push(e)
})

const engine = new CodexEngine()
const run = engine.chat({
  repo: fx.dir,
  message: 'Call the limn "focus" tool with target {"kind":"diff","file":"src/a.ts","side":"new","line":2} to point the reviewer at the changed return. Then reply in one short sentence that you did it.',
  tools: host
})

const kill = setTimeout(() => { console.error('TIMEOUT after 180s'); run.cancel() }, 180_000)
try {
  for await (const ev of run.events) {
    if (ev.type === 'tool' || ev.type === 'status') console.error(`· ${ev.type}: ${'text' in ev ? ev.text : ''}`)
    if (ev.type === 'action') console.error(`★ action: ${JSON.stringify(ev.action)}`)
    if (ev.type === 'error') console.error(`✗ error: ${ev.message}`)
  }
  const res = await run.result
  console.error('\n--- RESULT TEXT ---\n' + res.value.slice(0, 400))
  const actions = host.collected() as AgentAction[]
  console.error('\n--- COLLECTED ACTIONS ---\n' + JSON.stringify(actions, null, 2))
  const focused = actions.some((a) => a.kind === 'focus')
  console.error(focused ? '\n✅ PASS: Codex called the focus tool' : '\n❌ FAIL: no focus action collected')
  process.exit(focused ? 0 : 1)
} catch (err) {
  console.error('\n❌ THREW: ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
} finally {
  clearTimeout(kill)
}
