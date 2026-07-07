import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mintHotspotComments, supersededHotspotIds } from '../src/main/engines/hotspots'
import { openDb } from '../src/main/db/db'
import { createSession, loadReviewState, upsertComment } from '../src/main/db/sessions'
import type { Hotspot, RefPair } from '../src/shared/types'

const riskHotspot: Hotspot = {
  anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 4, hunkRange: '', lineContent: '' },
  text: 'This branch is unreachable if input is empty.',
  severity: 'risk'
}
const noteHotspot: Hotspot = {
  anchor: { kind: 'file', file: 'src/b.ts' },
  text: 'Consider extracting this into a helper.',
  severity: 'note'
}
const offDiffHotspot: Hotspot = {
  anchor: { kind: 'diff', file: 'src/ghost.ts', side: 'new', line: 1, hunkRange: '', lineContent: '' },
  text: 'Hallucinated file.',
  severity: 'note'
}

describe('mintHotspotComments', () => {
  it('mints one resolved agent Comment per hotspot whose file is in the diff', () => {
    const knownFiles = new Set(['src/a.ts', 'src/b.ts'])
    const comments = mintHotspotComments([riskHotspot, noteHotspot], { knownFiles, iteration: 2 })

    expect(comments).toHaveLength(2)
    for (const c of comments) {
      expect(c.author).toBe('agent')
      expect(c.status).toBe('resolved') // INVARIANT: hotspots never enter the queue on their own
      expect(c.replies).toEqual([])
      expect(c.iteration).toBe(2)
    }
    expect(comments[0].severity).toBe('risk')
    expect(comments[0].anchor).toEqual(riskHotspot.anchor)
    expect(comments[1].severity).toBe('note')
    expect(comments[1].anchor).toEqual(noteHotspot.anchor)
    // unique ids
    expect(new Set(comments.map((c) => c.id)).size).toBe(comments.length)
  })

  it('drops a hotspot whose anchor file is not in the diff, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const knownFiles = new Set(['src/a.ts', 'src/b.ts'])
    const comments = mintHotspotComments([riskHotspot, offDiffHotspot], { knownFiles, iteration: 1 })

    expect(comments).toHaveLength(1)
    expect(comments[0].anchor).toEqual(riskHotspot.anchor)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('src/ghost.ts')
    warn.mockRestore()
  })

  it('returns nothing for an empty hotspot list', () => {
    expect(mintHotspotComments([], { knownFiles: new Set(), iteration: 0 })).toEqual([])
  })
})

describe('supersededHotspotIds', () => {
  it('selects only pristine agent hotspot comments — untouched since minting', () => {
    const [pristine] = mintHotspotComments([riskHotspot], { knownFiles: new Set(['src/a.ts']), iteration: 1 })
    const requeued = { ...pristine, id: 'hs-2-0', status: 'queued' as const }
    const replied = {
      ...pristine, id: 'hs-3-0',
      replies: [{ id: 'r1', author: 'user' as const, text: 'why?', createdAt: pristine.createdAt }]
    }
    const userComment = { ...pristine, id: 'c-user', author: 'user' as const }

    expect(supersededHotspotIds([pristine, requeued, replied, userComment])).toEqual([pristine.id])
  })

  it('returns nothing when there are no comments', () => {
    expect(supersededHotspotIds([])).toEqual([])
  })
})

describe('hotspot comments — persisted then re-queued (DB flow)', () => {
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
  }

  it('a minted (resolved) hotspot comment can be re-queued (status flips to queued)', () => {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-hotspot-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })

    const [minted] = mintHotspotComments([riskHotspot], { knownFiles: new Set(['src/a.ts']), iteration: 1 })
    upsertComment(db, s.id, minted)

    const before = loadReviewState(db, s.id).comments.find((c) => c.id === minted.id)!
    expect(before.status).toBe('resolved')
    expect(before.severity).toBe('risk')

    // the renderer's re-queue control persists the same comment with status
    // flipped to 'queued' via upsertComment — never auto-sent (spec Decision 19).
    upsertComment(db, s.id, { ...before, status: 'queued' })

    const after = loadReviewState(db, s.id).comments.find((c) => c.id === minted.id)!
    expect(after.status).toBe('queued')
    expect(after.author).toBe('agent') // identity/severity survive the re-queue
    expect(after.severity).toBe('risk')
  })
})
