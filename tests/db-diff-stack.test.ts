import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/server/db/db'
import { createSession, loadReviewState, replaceUiState } from '../src/server/db/sessions'
import type { RefPair } from '../src/shared/types'
import { UNIFIED } from '../src/shared/diffStack'

let db: DatabaseSync
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-stack-')), 'db')).db
})
const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const mk = (): number => createSession(db, '/r', pair, { engine: 'claude' }).id

describe("the review's default diff stack", () => {
  it('is absent on a fresh session and round-trips through saveUiState', () => {
    const id = mk()
    expect(loadReviewState(db, id).diffStack).toBeUndefined()
    replaceUiState(db, id, { diffStack: { out: ['approved', 'base'], against: 'base' } })
    expect(loadReviewState(db, id).diffStack).toEqual({ out: ['approved', 'base'], against: 'base' })
    // Unified measured against a checkpoint is a stack too
    replaceUiState(db, id, { diffStack: { out: [], against: 'approved' } })
    expect(loadReviewState(db, id).diffStack).toEqual({ out: [], against: 'approved' })
  })

  it('normalises on write and reads a malformed stored value as Unified', () => {
    const id = mk()
    replaceUiState(db, id, { diffStack: { out: ['review', 'approved'], against: 'base' } })
    expect(loadReviewState(db, id).diffStack).toEqual({ out: ['review'], against: 'base' })
    db.prepare('UPDATE sessions SET diff_stack = ? WHERE id = ?').run('{not json', id)
    expect(loadReviewState(db, id).diffStack).toEqual(UNIFIED)
  })

  it('leaves the stack alone when the patch does not mention it', () => {
    const id = mk()
    replaceUiState(db, id, { diffStack: { out: ['base'], against: 'base' } })
    replaceUiState(db, id, { viewedAt: {} })
    expect(loadReviewState(db, id).diffStack).toEqual({ out: ['base'], against: 'base' })
  })
})
