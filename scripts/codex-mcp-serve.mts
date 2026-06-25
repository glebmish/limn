/* Stand up ONLY the limn MCP server (no Codex), print its URL, and log
 * every tool invocation. Lets us drive `codex exec` manually to isolate the
 * guardian/approval behavior from the SDK. Run: npx tsx scripts/codex-mcp-serve.mts */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread } from '../src/main/db/sessions'
import { createToolHost } from '../src/main/engines/tools'
import { registerCodexTurn } from '../src/main/engines/codexMcp'
import type { EngineEvent, RefPair } from '../src/shared/types'

const fx = makeFixtureRepo()
const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-serve-')), 'db')).db
const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const s = createSession(db, fx.dir, pair, { engine: 'codex' })
const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'codex' } })
const events: EngineEvent[] = []
const host = createToolHost({
  db, sessionId: s.id, threadId: t.id, opId: 'o', repo: fx.dir,
  agent: { engine: 'codex' }, emit: (e) => { events.push(e); if (e.type === 'action') console.error('★ HOST RAN:', JSON.stringify(e.action)) }
})
const mcp = await registerCodexTurn(host)
console.log(JSON.stringify({ url: mcp.url, repo: fx.dir }))
process.stdin.resume() // keep alive
