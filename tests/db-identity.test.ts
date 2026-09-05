import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { createSession, findSession } from '../src/main/db/sessions'
import { refIdentity } from '../src/shared/types'
import type { RefSide } from '../src/shared/types'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ident-')), 'limn.db')
}

// Every RefSide shape whose identity must agree between the TS refIdentity() rule
// and the SQL `base_ident`/`compare_ident` GENERATED columns. Exercises quoting
// hazards, prefix collisions, non-ASCII, and the branch/commit distinction.
const CASES: RefSide[] = [
  { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  { kind: 'branch', symbol: 'feat/x.y-z_1', anchorSha: 'b'.repeat(40) },      // path-ish symbol
  { kind: 'branch', symbol: "wip'quote", anchorSha: 'c'.repeat(40) },         // SQL-quoting hazard
  { kind: 'branch', symbol: 'b:decoy', anchorSha: 'd'.repeat(40) },           // prefix collision
  { kind: 'branch', symbol: 'ünïcode-枝', anchorSha: 'e'.repeat(40) },        // non-ASCII
  { kind: 'commit', symbol: 'v1.2.3', anchorSha: 'f'.repeat(40) },
  { kind: 'commit', symbol: '', anchorSha: '0123abc'.padEnd(40, '0') }        // empty symbol, resolved sha
]

// A plain, valid opposite side for whichever side is under test.
const FIXED_BASE: RefSide = { kind: 'branch', symbol: 'trunk', anchorSha: '1'.repeat(40) }
const FIXED_COMPARE: RefSide = { kind: 'branch', symbol: 'trunk', anchorSha: '2'.repeat(40) }

let db: DatabaseSync
beforeEach(() => {
  db = openDb(tmpFile()).db
})

function identOf(id: number): { base_ident: string; compare_ident: string } {
  return db.prepare('SELECT base_ident, compare_ident FROM sessions WHERE id = ?')
    .get(id) as { base_ident: string; compare_ident: string }
}

describe('session identity: TS refIdentity() agrees with the SQL generated columns', () => {
  // Each case in the compare slot → covers the compare_ident generated column.
  it.each(CASES)('compare_ident matches refIdentity() for %o', (compare) => {
    const s = createSession(db, '/repo', { base: FIXED_BASE, compare })
    const row = identOf(s.id)
    expect(row.base_ident).toBe(refIdentity(FIXED_BASE))
    expect(row.compare_ident).toBe(refIdentity(compare))
  })

  // Each case in the base slot → covers the base_ident generated column.
  it.each(CASES)('base_ident matches refIdentity() for %o', (base) => {
    const s = createSession(db, '/repo', { base, compare: FIXED_COMPARE })
    const row = identOf(s.id)
    expect(row.base_ident).toBe(refIdentity(base))
    expect(row.compare_ident).toBe(refIdentity(FIXED_COMPARE))
  })

  // findSession consequence — a branch side keys on its name, so anchor-SHA drift
  // still resolves the same session.
  it('findSession round-trips a branch pair by identity (branch follows its name)', () => {
    const pair = { base: FIXED_BASE, compare: { kind: 'branch' as const, symbol: 'feature', anchorSha: 'b'.repeat(40) } }
    const s = createSession(db, '/repo', pair)
    const drifted = { ...pair, compare: { ...pair.compare, anchorSha: 'e'.repeat(40) } }
    expect(findSession(db, '/repo', drifted)?.id).toBe(s.id)
  })

  // findSession consequence — a commit side keys on its frozen sha, so a different
  // sha is a different identity.
  it('findSession round-trips a commit pair by identity (frozen sha)', () => {
    const pair = { base: { kind: 'commit' as const, symbol: 'v1', anchorSha: 'c'.repeat(40) }, compare: FIXED_COMPARE }
    const s = createSession(db, '/repo', pair)
    expect(findSession(db, '/repo', pair)?.id).toBe(s.id)
    const otherSha = { ...pair, base: { ...pair.base, anchorSha: 'f'.repeat(40) } }
    expect(findSession(db, '/repo', otherSha)).toBeNull()
  })
})
