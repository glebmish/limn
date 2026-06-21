/* Screenshot seed (dev only) for the transient-review default entry: builds a
 * fixture repo (main..feature diff + a recognized spec/plan) and an EMPTY db (no
 * sessions). Launch Electron with LR_DB=<db> LR_OPEN_REPO=<repo> to land directly
 * on the transient review (no session row) — the default entry. Prints {repo, db}. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, fixtureWrite, fixtureGit } from '../tests/helpers/fixtureRepo'
import { openDb } from '../src/main/db/db'

const fx = makeFixtureRepo()
const SPEC = 'docs/superpowers/specs/2026-06-12-rate-limit-design.md'
const PLAN = 'docs/superpowers/plans/2026-06-12-rate-limit.md'
fixtureWrite(fx.dir, SPEC, '# Rate limiting spec\n\nGoal: protect the API on branch feature.\n\n- requests are capped per client\n- the cap is configurable\n')
fixtureWrite(fx.dir, PLAN, '# Rate limiting plan\n\n1. add a token-bucket limiter\n2. wire it into the request path\n3. expose the cap as config\n')
fixtureGit(fx.dir, 'add', '-A')
fixtureGit(fx.dir, 'commit', '-m', 'spec + plan for rate limiting')

// fresh, empty db — no sessions, so opening the repo lands on a transient review
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-transient-')), 'local-review.db')
openDb(dbFile)

console.log(JSON.stringify({ repo: fx.dir, db: dbFile }))
