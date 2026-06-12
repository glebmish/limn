import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { importLegacyRepoFiles, seedFromConfig } from '../src/main/db/import'
import { findSession, loadReviewState, recentRepoPaths } from '../src/main/db/sessions'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { headSha } from '../src/main/git'

let db: DatabaseSync
let fx: FixtureRepo
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-imp-')), 'db')).db
  fx = makeFixtureRepo()
})

function writeLegacy(repo: string, name: string, state: object): string {
  const dir = path.join(repo, '.local-review')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(state))
  return p
}

describe('legacy import', () => {
  it('imports a v1 review file into a session and renames the source', async () => {
    const p = writeLegacy(fx.dir, 'review-feature.json', {
      repo: fx.dir, branch: 'feature', base: 'main',
      engine: 'claude',
      comments: [{
        id: 'c1', author: 'user', text: 'check this', status: 'queued', replies: [], iteration: 1,
        createdAt: '2026-06-01T00:00:00Z',
        anchor: { kind: 'summary' }
      }],
      chat: [{ role: 'user', text: 'hi', at: '2026-06-01T00:00:00Z' }],
      viewedAt: { 'a.ts': 'deadbee' }, reviewedSections: ['s1'],
      artifactApprovals: { 'docs/spec.md': 'deadbee' },
      iterations: [{ n: 1, engine: 'claude', sessionId: 'es1', endSha: 'deadbee', at: '2026-06-01T00:00:00Z' }],
      artifacts: [{ role: 'spec', path: 'docs/spec.md' }]
    })

    const imported = await importLegacyRepoFiles(db, fx.dir)
    expect(imported).toEqual(['review-feature.json'])
    expect(fs.existsSync(p)).toBe(false)
    expect(fs.existsSync(`${p}.imported`)).toBe(true)

    const baseTip = await headSha(fx.dir, 'main')
    const found = findSession(db, fx.dir, {
      base: { kind: 'branch', symbol: 'main', anchorSha: baseTip },
      compare: { kind: 'branch', symbol: 'feature', anchorSha: 'x'.repeat(40) } // anchors don't affect branch identity
    })
    expect(found).not.toBeNull()
    expect(found!.pair.compare.anchorSha).toBe('deadbee') // last iteration endSha wins as anchor
    const st = loadReviewState(db, found!.id)
    expect(st.comments).toHaveLength(1)
    expect(st.chat).toHaveLength(1)
    expect(st.iterations).toHaveLength(1)
    expect(st.viewedAt).toEqual({ 'a.ts': 'deadbee' })
    expect(st.reviewedSections).toEqual(['s1'])
    expect(st.artifactApprovals).toEqual({ 'docs/spec.md': 'deadbee' })
  })

  it('second import is a no-op (session exists, no file left to import)', async () => {
    writeLegacy(fx.dir, 'review-feature.json', {
      repo: fx.dir, branch: 'feature', base: 'main',
      comments: [], chat: [], viewedAt: {}, reviewedSections: [], artifactApprovals: {}, iterations: [], artifacts: []
    })
    await importLegacyRepoFiles(db, fx.dir)
    expect(await importLegacyRepoFiles(db, fx.dir)).toEqual([])
  })

  it('failed import cleans up the partial session so a repaired re-run imports fully', async () => {
    const p = writeLegacy(fx.dir, 'review-feature.json', {
      repo: fx.dir, branch: 'feature', base: 'main',
      comments: [{
        id: 'c1', author: 'user', text: 'x', status: 'BOGUS', replies: [], iteration: 1,
        createdAt: '2026-06-01T00:00:00Z', anchor: { kind: 'summary' }
      }],
      chat: [], viewedAt: {}, reviewedSections: [], artifactApprovals: {}, iterations: [], artifacts: []
    })
    const probe = {
      base: { kind: 'branch' as const, symbol: 'main', anchorSha: '' },
      compare: { kind: 'branch' as const, symbol: 'feature', anchorSha: '' }
    }
    expect(await importLegacyRepoFiles(db, fx.dir)).toEqual([]) // skipped (CHECK constraint threw)
    expect(fs.existsSync(p)).toBe(true)                          // source preserved
    expect(findSession(db, fx.dir, probe)).toBeNull()            // no orphaned partial session
    // repair the file and re-run — the full import now succeeds
    const st = JSON.parse(fs.readFileSync(p, 'utf8'))
    st.comments[0].status = 'queued'
    fs.writeFileSync(p, JSON.stringify(st))
    expect(await importLegacyRepoFiles(db, fx.dir)).toEqual(['review-feature.json'])
    const ok = findSession(db, fx.dir, probe)
    expect(loadReviewState(db, ok!.id).comments).toHaveLength(1)
  })

  it('unparseable file is left untouched and skipped', async () => {
    const p = writeLegacy(fx.dir, 'review-bad.json', {})
    fs.writeFileSync(p, '{ not json')
    expect(await importLegacyRepoFiles(db, fx.dir)).toEqual([])
    expect(fs.existsSync(p)).toBe(true)
  })

  it('seedFromConfig imports recents (order preserved) and lastEngine pref, renames config', () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cfg-'))
    const cfg = path.join(cfgDir, 'config.json')
    fs.writeFileSync(cfg, JSON.stringify({ recents: ['/r/newest', '/r/older'], lastEngine: 'codex' }))
    seedFromConfig(db, cfg)
    expect(recentRepoPaths(db, 8)).toEqual(['/r/newest', '/r/older'])
    const pref = db.prepare(`SELECT value FROM prefs WHERE key = 'engine'`).get() as { value: string }
    expect(pref.value).toBe('codex')
    expect(fs.existsSync(cfg)).toBe(false)
    expect(fs.existsSync(`${cfg}.imported`)).toBe(true)
    seedFromConfig(db, cfg) // second call: nothing to do, no throw
  })
})
