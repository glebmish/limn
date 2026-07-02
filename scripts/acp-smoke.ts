/* Manual smoke for the real Claude ACP adapter (not CI, not vitest — needs live
   ~/.claude creds and network): npx tsx scripts/acp-smoke.ts
   Spawns the real `@agentclientprotocol/claude-agent-acp` adapter and runs one
   real `chat` turn against the Anthropic API, asserting a clean done + the
   expected text. This is the automated FakeAcpAgent e2e's real-adapter
   counterpart — a human/CI-free sanity check that AcpEngine talks to the real
   adapter correctly, not a substitute for the scripted e2e in
   tests/acp-engine.test.ts (which is the actual CI gate). */
import { AcpEngine } from '../src/main/engines/acp'
import { CLAUDE_ACP_CONFIG } from '../src/main/engines/adapters'
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'

const fx = makeFixtureRepo()
console.log('fixture repo:', fx.dir)

const engine = new AcpEngine(CLAUDE_ACP_CONFIG)
const run = engine.chat({
  repo: fx.dir,
  message: 'Reply with the single word READY',
  executionMode: 'ask'
})

const events: string[] = []
let sawDone = false
for await (const ev of run.events) {
  events.push(ev.type)
  console.log('[event]', ev.type, 'text' in ev ? ev.text.slice(0, 200) : 'message' in ev ? ev.message : '')
  if (ev.type === 'done') sawDone = true
}

const { value, sessionId } = await run.result
console.log('sessionId:', sessionId)
console.log('answer:', JSON.stringify(value))

if (!sawDone) throw new Error(`smoke FAILED: no clean {type:'done'} event (saw: ${events.join(', ')})`)
if (!value.trim().toUpperCase().includes('READY')) throw new Error(`smoke FAILED: expected the reply to contain READY, got: ${value}`)

console.log('\nsmoke PASSED: real Claude ACP adapter replied and closed cleanly.')
