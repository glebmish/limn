/* Manual smoke for the Claude adapter (not CI): npx tsx scripts/smoke-claude.ts
   Requires Claude Code login or ANTHROPIC_API_KEY. Builds a tmp repo, runs a real review. */
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
import { getDiff } from '../src/main/git'
import { ClaudeEngine } from '../src/main/engines/claude'

const fx = makeFixtureRepo()
console.log('fixture repo:', fx.dir)
const sk = await getDiff(fx.dir, 'main', 'feature')
const engine = new ClaudeEngine()
const run = engine.generateReview({ repo: fx.dir, branch: 'feature', base: 'main', diff: sk, artifacts: [] })
for await (const ev of run.events) console.log('[event]', ev.type, 'text' in ev ? ev.text.slice(0, 100) : 'message' in ev ? ev.message : '')
const { value, sessionId } = await run.result
console.log('sessionId:', sessionId)
console.log(JSON.stringify(value, null, 2).slice(0, 3000))

console.log('\n--- chat follow-up ---')
const chat = engine.chat({ repo: fx.dir, engineSessionId: sessionId, message: 'In one sentence: what is the riskiest change?' })
for await (const ev of chat.events) if (ev.type === 'text') console.log('[chat]', ev.text)
const { value: answer } = await chat.result
console.log('answer:', answer)
