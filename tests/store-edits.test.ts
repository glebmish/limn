import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'
import type { ApplyEditResult, FileDiff } from '../src/shared/types'

const applyEdit = vi.fn(async (): Promise<ApplyEditResult> => ({ ok: true, fileHash: 'newhash' }))
const saveUiState = vi.fn(async () => {})
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const previewReview = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const startSession = vi.fn(async () => ({ sessionId: 77 }))
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { applyEdit, saveUiState, loadSession, previewReview, startSession, repoState, listRepoSessions }
}

import { useStore } from '../src/renderer/store'

const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 1, hunks: [], fileHash: 'oldhash'
}
const edit = { start: 2, end: 2, snapshot: ['old'], newLines: ['new'] }

function seed(over: { sessionId: number | null; viewed: boolean }) {
  const loaded = makeLoaded({ files: [file], headSha: 'HEAD', repo: '/repo' })
  ;(loaded as { writeCapability?: unknown }).writeCapability = { enabled: true, reason: 'available', branch: 'feat', workdir: '/repo' }
  useStore.setState({
    loaded,
    repo: '/repo',
    sessionId: over.sessionId,
    viewedAt: over.viewed ? { 'src/a.ts': { sha: 'HEAD', hash: 'oldhash' } } : {},
    pendingDrift: null,
    editFrame: null
  })
}

beforeEach(() => {
  applyEdit.mockClear(); saveUiState.mockClear(); loadSession.mockClear(); previewReview.mockClear(); startSession.mockClear()
  applyEdit.mockResolvedValue({ ok: true, fileHash: 'newhash' })
})

describe('saveEdit', () => {
  it('re-stamps the viewed mark and reloads a persisted session', async () => {
    seed({ sessionId: 5, viewed: true })
    const res = await useStore.getState().saveEdit('src/a.ts', edit)
    expect(res).toMatchObject({ ok: true })
    expect(applyEdit).toHaveBeenCalledWith('/repo', expect.objectContaining({ symbol: 'feat' }), 'src/a.ts', edit)
    expect(saveUiState).toHaveBeenCalledWith(5, { viewedAt: { 'src/a.ts': { sha: 'HEAD', hash: 'newhash' } } })
    expect(loadSession).toHaveBeenCalled()
  })

  it('does not touch viewed marks for an unviewed file', async () => {
    seed({ sessionId: 5, viewed: false })
    await useStore.getState().saveEdit('src/a.ts', edit)
    expect(saveUiState).not.toHaveBeenCalled()
    expect(useStore.getState().viewedAt['src/a.ts']).toBeUndefined()
  })

  it('never materializes a transient review: refreshes via previewReview, keeps the re-stamp in memory', async () => {
    seed({ sessionId: null, viewed: true })
    await useStore.getState().saveEdit('src/a.ts', edit)
    expect(startSession).not.toHaveBeenCalled()
    expect(saveUiState).not.toHaveBeenCalled()
    expect(previewReview).toHaveBeenCalled()
    expect(useStore.getState().viewedAt['src/a.ts']).toEqual({ sha: 'HEAD', hash: 'newhash' })
  })

  it('forwards a line-count-growing edit verbatim (#10)', async () => {
    seed({ sessionId: 5, viewed: true })
    // ⏎ split line 2 in two: the CAS span is still one line, newLines is two
    const grow = { start: 2, end: 2, snapshot: ['old'], newLines: ['old-a', 'old-b'] }
    const res = await useStore.getState().saveEdit('src/a.ts', grow)
    expect(res).toMatchObject({ ok: true })
    expect(applyEdit).toHaveBeenCalledWith('/repo', expect.objectContaining({ symbol: 'feat' }), 'src/a.ts', grow)
    expect(loadSession).toHaveBeenCalled() // the fold-in re-renders the grown file
  })

  it('forwards a pure insertion (end = start − 1, empty snapshot)', async () => {
    seed({ sessionId: 5, viewed: false })
    const insert = { start: 3, end: 2, snapshot: [], newLines: ['brand new'] }
    const res = await useStore.getState().saveEdit('src/a.ts', insert)
    expect(res).toMatchObject({ ok: true })
    expect(applyEdit).toHaveBeenCalledWith('/repo', expect.anything(), 'src/a.ts', insert)
  })

  it('returns a conflict without refreshing (the frame reopens with kept text)', async () => {
    seed({ sessionId: 5, viewed: true })
    applyEdit.mockResolvedValueOnce({ ok: false, reason: 'conflict', current: ['x'] })
    const res = await useStore.getState().saveEdit('src/a.ts', edit)
    expect(res).toMatchObject({ ok: false, reason: 'conflict' })
    expect(loadSession).not.toHaveBeenCalled()
    expect(saveUiState).not.toHaveBeenCalled()
  })

  it('surfaces a transport error as the store error and returns null', async () => {
    seed({ sessionId: 5, viewed: false })
    applyEdit.mockRejectedValueOnce(new Error('gone'))
    const res = await useStore.getState().saveEdit('src/a.ts', edit)
    expect(res).toBeNull()
    expect(useStore.getState().error).toContain('gone')
  })
})
