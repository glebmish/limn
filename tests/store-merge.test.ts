import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import { makePreflight } from './helpers/merge'
import type { LoadedReview } from '../src/shared/ipc'

const sendRebase = vi.fn(async () => {})
const mergeExecute = vi.fn()
const markMerged = vi.fn()
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { sendRebase, mergeExecute, markMerged, loadSession, repoState, listRepoSessions },
}

import { useStore } from '../src/renderer/store'
import { runMergeExecute } from '../src/renderer/components/MergeSheet'
import type { MergeExecuteRequest } from '../src/shared/types'

const req: MergeExecuteRequest = {
  strategy: 'squash', message: 'msg', overrides: [],
  cleanup: { archiveSession: true, deleteBranch: true, removeWorktree: true, retarget: [] },
  expect: { baseHead: 'b'.repeat(40), tipSha: 'c'.repeat(40) },
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    sessionId: 3, ops: {}, chatOpen: false,
    loaded: makeLoaded({ chats: [{ id: 7, kind: 'review', messages: [] }] }),
  })
})

/* RECONCILED (assembly): store.sendRebase tests live in Task 12
   (store-chat-send.test.ts additions) — not duplicated here. */

describe('runMergeExecute (spec §4 / Seq C)', () => {
  it('preflight-changed: returns the fresh preflight, no reload', async () => {
    const fresh = makePreflight({ ok: false })
    mergeExecute.mockResolvedValueOnce({ status: 'preflight-changed', preflight: fresh })
    const out = await runMergeExecute(3, req, false)
    expect(out).toBe(fresh)
    expect(loadSession).not.toHaveBeenCalled()
  })
  it('merged: reloads the session and returns null', async () => {
    mergeExecute.mockResolvedValueOnce({ status: 'merged', record: { mergedSha: 'a'.repeat(40) } })
    const out = await runMergeExecute(3, req, false)
    expect(out).toBeNull()
    expect(loadSession).toHaveBeenCalledWith(3)
  })
  it('external (Mark merged): lands via markMerged with only the cleanup', async () => {
    markMerged.mockResolvedValueOnce({ status: 'merged', record: { external: true } })
    const out = await runMergeExecute(3, req, true)
    expect(out).toBeNull()
    expect(markMerged).toHaveBeenCalledWith(3, req.cleanup)
    expect(mergeExecute).not.toHaveBeenCalled()
  })
})
