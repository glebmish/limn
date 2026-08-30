/* Manual smoke for a real ACP adapter (not CI, not vitest — needs live ~/.claude
   or ~/.codex creds and network): npx tsx scripts/acp-smoke.ts [--engine=claude|codex]
   Spawns the real adapter (`@agentclientprotocol/claude-agent-acp` or
   `@agentclientprotocol/codex-acp`) and runs one real `chat` turn against the
   live API, asserting a clean done + the expected text. This is the automated
   FakeAcpAgent e2e's real-adapter counterpart — a human/CI-free sanity check
   that AcpEngine talks to the real adapter correctly, not a substitute for the
   scripted e2e in tests/acp-engine.test.ts (which is the actual CI gate). */
import { AcpEngine } from '../src/server/engines/acp'
import { CLAUDE_ACP_CONFIG, CODEX_ACP_CONFIG } from '../src/server/engines/adapters'
import { resolveDecision } from '../src/server/engines/approvals'
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'

const ENGINES = { claude: CLAUDE_ACP_CONFIG, codex: CODEX_ACP_CONFIG } as const
type EngineKey = keyof typeof ENGINES

function parseEngine(argv: string[]): EngineKey {
  const arg = argv.find((a) => a.startsWith('--engine='))
  const raw = arg ? arg.slice('--engine='.length) : 'claude'
  if (raw in ENGINES) return raw as EngineKey
  throw new Error(`unknown --engine=${raw} (expected claude|codex)`)
}

const engineKey = parseEngine(process.argv.slice(2))
const config = ENGINES[engineKey]
console.log('engine:', engineKey)

const fx = makeFixtureRepo()
console.log('fixture repo:', fx.dir)

const engine = new AcpEngine(config)
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

console.log(`\nsmoke PASSED: real ${engineKey} ACP adapter replied and closed cleanly.`)

// ── command-approval round-trip (spike exit-criterion #1, end-to-end through
// AcpEngine): a second turn, same live session, writes enabled at the 'ask' tier
// so a shell command must park on an approval_request before running.
console.log('\nrunning command-approval smoke...')
const opId = 'acp-smoke-approval'
const approvalRun = engine.chat({
  repo: fx.dir,
  engineSessionId: sessionId,
  // A write (sandbox-escape for Codex's read-only mode) — a bare read-only command
  // like `echo` with no redirect is auto-allowed and never parks (spike §5), so this
  // writes a scratch file inside the (already-throwaway) fixture repo to force the
  // approval round-trip.
  message: 'Run the shell command `echo ACP_SMOKE_OK > acp_smoke_scratch.txt`, then reply with the single word DONE.',
  writeEnabled: true,
  executionMode: 'ask',
  opId
})

let sawApproval = false
let approvalSawDone = false
for await (const ev of approvalRun.events) {
  console.log('[approval-event]', ev.type, 'text' in ev ? ev.text.slice(0, 200) : 'message' in ev ? ev.message : '')
  if (ev.type === 'approval_request') {
    sawApproval = true
    console.log('  -> approving:', JSON.stringify(ev.request))
    resolveDecision(opId, ev.request.id, 'allow')
  }
  if (ev.type === 'done') approvalSawDone = true
}

const approvalResult = await approvalRun.result
console.log('approval turn answer:', JSON.stringify(approvalResult.value))

if (!sawApproval) console.log('NOTE: no approval_request seen (adapter may auto-allow this command shape — see spike §5) — round-trip not exercised, not a failure.')
else {
  if (!approvalSawDone) throw new Error('command-approval smoke FAILED: approval_request seen but turn did not close cleanly')
  console.log('smoke PASSED: command-approval round-trip parked and resolved through AcpEngine.')
}
