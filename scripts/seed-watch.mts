import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
import { getDiff, resolveRefInput } from '../src/main/git'
import { FakeEngine } from '../src/main/engines/fake'
import { mergeAnnotations } from '../src/main/engines/validate'
import { openDb } from '../src/main/db/db'
import { createSession, updateSessionMeta, addIteration } from '../src/main/db/sessions'
import type { RefPair } from '../src/shared/types'

const fx = makeFixtureRepo()
const sk = await getDiff(fx.dir, 'main', 'feature')
const run = new FakeEngine().generateReview({ repo: fx.dir, branch: 'feature', base: 'main', diff: sk, artifacts: [] })
for await (const _ of run.events) { /* drain */ }
const { value, sessionId: engineSession } = await run.result
const { annotations } = mergeAnnotations(sk, value)

const base = await resolveRefInput(fx.dir, 'main')
const compare = await resolveRefInput(fx.dir, 'feature')
const pair: RefPair = {
  base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
  compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
}

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-seed-')), 'limn.db')
const { db } = openDb(dbFile)
const session = createSession(db, fx.dir, pair, { engine: 'claude' })
updateSessionMeta(db, session.id, {
  engine: 'claude', annotations, title: annotations.title, summary: annotations.summary,
  reviewedAtSha: fx.shas.head, approvedSha: fx.shas.head // approved at current head — no drift yet
})
addIteration(db, session.id, { n: 1, engine: 'claude', sessionId: engineSession, endSha: fx.shas.head, at: 'now' })

console.log(JSON.stringify({ repo: fx.dir, db: dbFile, sessionId: session.id }))
