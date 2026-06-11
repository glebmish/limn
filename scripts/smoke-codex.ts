/* Manual smoke for the Codex adapter (not CI): npx tsx scripts/smoke-codex.ts
   Requires `codex login` or OPENAI_API_KEY. Builds a tmp repo, runs a real review. */
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
import { getDiff } from '../src/main/git'
import { CodexEngine } from '../src/main/engines/codex'

const fx = makeFixtureRepo()
console.log('fixture repo:', fx.dir)
const sk = await getDiff(fx.dir, 'main', 'feature')
const engine = new CodexEngine()
const run = engine.generateReview({ repo: fx.dir, branch: 'feature', base: 'main', diff: sk, artifacts: [] })
for await (const ev of run.events) console.log('[event]', ev.type, 'text' in ev ? ev.text.slice(0, 100) : 'message' in ev ? ev.message : '')
const { value, sessionId } = await run.result
console.log('threadId:', sessionId)
console.log(JSON.stringify(value, null, 2).slice(0, 3000))
