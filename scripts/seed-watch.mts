import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
import { getDiff } from '../src/main/git'
import { FakeEngine } from '../src/main/engines/fake'
import { mergeAnnotations } from '../src/main/engines/validate'
import { defaultState, saveState } from '../src/main/state'

const fx = makeFixtureRepo()
const sk = await getDiff(fx.dir, 'main', 'feature')
const run = new FakeEngine().generateReview({ repo: fx.dir, branch: 'feature', base: 'main', diff: sk, artifacts: [] })
for await (const _ of run.events) { /* drain */ }
const { value, sessionId } = await run.result
const { annotations } = mergeAnnotations(sk, value)
const st = defaultState(fx.dir, 'feature', 'main')
st.annotations = annotations
st.engine = 'claude'
st.reviewedAtSha = fx.shas.head
st.approvedSha = fx.shas.head     // approved at current head — no drift yet
st.iterations = [{ n: 1, engine: 'claude', sessionId, endSha: fx.shas.head, at: 'now' }]
saveState(st)
console.log(fx.dir)
