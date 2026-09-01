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
import { getEditDraft, setEditDraft } from '../src/renderer/store/edits'

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

// ── #6 fix-round-1: `frameId` identifies the edit *session*, not the region, so
// DiffBody can tell "the same edit, grown" (reuse the live FlowFrame) apart from
// "a different edit" (a double-click/pencil re-open elsewhere while one is already
// open — the Critical regression: a bare constant key let that reuse a stale
// instance and silently CAS-write the old typed text under the new line numbers).
// fix-round-2: `editDraft` moved out of the reactive store entirely (a per-keystroke
// `set({ editDraft })` re-rendered every selector-less `useStore()` subscriber in
// the app for a value nothing reactively reads) — `getEditDraft`/`setEditDraft` are
// now plain module-level functions, exercised directly rather than through the store.
describe('setEditFrame — frameId + editDraft', () => {
  beforeEach(() => {
    useStore.setState({ editFrame: null })
    setEditDraft(null)
  })

  it('opening a frame without a frameId mints one', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    expect(useStore.getState().editFrame?.frameId).toEqual(expect.any(String))
  })

  it('two separate opens (no frameId passed) mint two DIFFERENT ids — an unrelated re-open is a new session', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    const first = useStore.getState().editFrame!.frameId
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 20, end: 20 })
    const second = useStore.getState().editFrame!.frameId
    expect(second).not.toBe(first)
  })

  it('spreading the current frame (as the ↑/↓ growth gesture does) preserves its frameId', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    const frame = useStore.getState().editFrame!
    useStore.getState().setEditFrame({ ...frame, start: frame.start - 1 })
    expect(useStore.getState().editFrame!.frameId).toBe(frame.frameId)
  })

  it('explicitly passing frameId through (the same-line-conflict reopen) preserves it too', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    const id = useStore.getState().editFrame!.frameId
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 6, frameId: id })
    expect(useStore.getState().editFrame!.frameId).toBe(id)
  })

  it('opening a genuinely NEW frame drops a leftover draft from the previous session', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    const id = useStore.getState().editFrame!.frameId
    setEditDraft({ frameId: id, text: 'typed but never saved', caret: 3 })
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 20, end: 20 }) // a different line, no frameId passed
    expect(getEditDraft()).toBeNull()
  })

  it('growth (frameId carried through) leaves the existing draft alone', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    const frame = useStore.getState().editFrame!
    const draft = { frameId: frame.frameId, text: 'typed', caret: 3 }
    setEditDraft(draft)
    useStore.getState().setEditFrame({ ...frame, end: frame.end + 1 })
    expect(getEditDraft()).toEqual(draft)
  })

  it('closing the frame (null) clears both editFrame and the draft — covers save success, cancel, and error paths, which all close via null', () => {
    useStore.getState().setEditFrame({ file: 'src/a.ts', start: 5, end: 5 })
    const id = useStore.getState().editFrame!.frameId
    setEditDraft({ frameId: id, text: 'typed', caret: 3 })
    useStore.getState().setEditFrame(null)
    expect(useStore.getState().editFrame).toBeNull()
    expect(getEditDraft()).toBeNull()
  })
})
