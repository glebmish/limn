import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'

const openRepoApi = vi.fn(async () => ({ path: '/r', current: 'feat', defaultBase: 'main', branches: ['feat', 'main'], worktrees: [], dirty: false, dirtyCount: 0 }))
const repoState = vi.fn(async () => ({ current: 'feat', defaultBase: 'main', branches: ['feat', 'main'], worktrees: [] }))
const listRepoSessions = vi.fn(async () => [] as unknown[])
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
;(globalThis as unknown as { window: unknown }).window = {
  api: { openRepo: openRepoApi, repoState, listRepoSessions, loadSession },
}

import { useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))

// capture the REAL actions so tests that stub downstream actions can restore them.
const REAL = {
  enterHub: useStore.getState().enterHub,
  openReview: useStore.getState().openReview,
  openRepo: useStore.getState().openRepo,
  resumeExisting: useStore.getState().resumeExisting,
}
afterEach(() => { useStore.setState(REAL) })

describe('applyCliOpen dispatch table', () => {
  beforeEach(() => {
    useStore.setState({ error: null, repo: null })
    useStore.setState({
      enterHub: vi.fn(async () => {}) as never,
      openReview: vi.fn(async () => {}) as never,
      openRepo: vi.fn(async () => {}) as never,
    })
  })

  it('error → sets the error string and dispatches nothing', () => {
    useStore.getState().applyCliOpen({ error: 'not a git repo' })
    expect(useStore.getState().error).toBe('not a git repo')
    expect(useStore.getState().enterHub).not.toHaveBeenCalled()
    expect(useStore.getState().openReview).not.toHaveBeenCalled()
    expect(useStore.getState().openRepo).not.toHaveBeenCalled()
  })

  it('hub → enterHub(repo)', () => {
    useStore.getState().applyCliOpen({ repo: '/r', hub: true })
    expect(useStore.getState().enterHub).toHaveBeenCalledWith('/r')
  })

  it('fresh → openReview with the ref pair and { fresh: true }', () => {
    useStore.getState().applyCliOpen({ repo: '/r', fresh: true, baseInput: 'a', compareInput: 'b' })
    expect(useStore.getState().openReview).toHaveBeenCalledWith('/r', { base: 'a', compare: 'b' }, { fresh: true })
  })

  it('refs (no fresh) → openReview with the ref pair and no opts', () => {
    useStore.getState().applyCliOpen({ repo: '/r', baseInput: 'a' })
    expect(useStore.getState().openReview).toHaveBeenCalledWith('/r', { base: 'a', compare: undefined })
  })

  it('bare → openRepo(repo)', () => {
    useStore.getState().applyCliOpen({ repo: '/r' })
    expect(useStore.getState().openRepo).toHaveBeenCalledWith('/r')
  })

  it('no repo and no error → dispatches nothing', () => {
    useStore.getState().applyCliOpen({})
    expect(useStore.getState().enterHub).not.toHaveBeenCalled()
    expect(useStore.getState().openReview).not.toHaveBeenCalled()
    expect(useStore.getState().openRepo).not.toHaveBeenCalled()
  })
})

describe('openRepo hub-vs-transient choice', () => {
  beforeEach(() => {
    openRepoApi.mockClear(); repoState.mockClear(); listRepoSessions.mockClear()
    useStore.setState({ repo: null, repoState: null })
    useStore.setState({
      enterHub: vi.fn(async () => {}) as never,
      resumeExisting: vi.fn(async () => {}) as never,
      openReview: vi.fn(async () => {}) as never,
    })
  })

  it('opens the session hub when the repo has sessions, even off-branch ones', async () => {
    listRepoSessions.mockResolvedValueOnce([
      { id: 1, compareKind: 'branch', compareSymbol: 'other' },
    ])
    await useStore.getState().openRepo('/r')
    await flush()
    expect(useStore.getState().enterHub).toHaveBeenCalledWith('/r')
    expect(useStore.getState().resumeExisting).not.toHaveBeenCalled()
    expect(useStore.getState().openReview).not.toHaveBeenCalled()
  })

  it('opens the hub rather than resuming when a session matches the current branch', async () => {
    listRepoSessions.mockResolvedValueOnce([
      { id: 2, compareKind: 'branch', compareSymbol: 'feat' },
    ])
    await useStore.getState().openRepo('/r')
    await flush()
    expect(useStore.getState().enterHub).toHaveBeenCalledWith('/r')
    expect(useStore.getState().resumeExisting).not.toHaveBeenCalled()
  })

  it('opens a transient review when the repo has no sessions', async () => {
    listRepoSessions.mockResolvedValueOnce([])
    await useStore.getState().openRepo('/r')
    await flush()
    expect(useStore.getState().enterHub).not.toHaveBeenCalled()
    expect(useStore.getState().resumeExisting).not.toHaveBeenCalled()
    expect(useStore.getState().openReview).toHaveBeenCalledWith('/r')
  })

  // openRepo returns the repo's live state, so the store takes it from there —
  // asking repoState for the same three git reads in the same Promise.all was a
  // round trip whose answer was thrown away.
  it('takes the live repo state from openRepo itself, with no second repoState call', async () => {
    listRepoSessions.mockResolvedValueOnce([])
    await useStore.getState().openRepo('/r')
    await flush()
    expect(openRepoApi).toHaveBeenCalledWith('/r')
    expect(repoState).not.toHaveBeenCalled()
    expect(useStore.getState().repoState).toMatchObject({ current: 'feat', defaultBase: 'main' })
  })
})

describe('resumeExisting resets gen / collapsed / diffStack and picks the active chat', () => {
  beforeEach(() => {
    loadSession.mockClear()
    useStore.setState({
      ops: { 'op-x': { running: true, opId: 'op-x', kind: 'review', threadId: 9, log: [{ type: 'token' }], error: 'e', startedAt: 1, outcome: null, errorCode: null, answeredApprovals: new Set(['a']), exclusive: true } } as never,
      collapsed: new Set(['s1']) as never,
      expanded: new Set(['s2']) as never,
      diffStack: { out: [], against: 'viewed' }, fileStack: { 'a.ts': { out: ['base'], against: 'base' } }, activeChatId: 999,
    })
  })

  it('resets the transient/global bits and selects the empty user chat', async () => {
    loadSession.mockResolvedValueOnce(makeLoaded({
      chats: [
        { id: 3, kind: 'review', messages: [] },
        { id: 4, kind: 'user', messages: [] },
      ],
    }))
    await useStore.getState().resumeExisting(3)
    const s = useStore.getState()
    expect(Object.keys(s.ops)).toHaveLength(0) // the op map is cleared on session switch
    expect(s.collapsed.size).toBe(0)
    expect(s.expanded.size).toBe(0)
    expect(s.diffStack).toEqual({ out: [], against: 'base' })
    expect(s.fileStack).toEqual({})
    expect(s.screen).toBe('review')
    // pickActiveChat: current (999) absent → last empty user chat with no messages/session
    expect(s.activeChatId).toBe(4)
  })
})
