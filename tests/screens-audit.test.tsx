import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedReview } from '../src/shared/ipc'

// The header's two ref pickers are the seam under test: React props are the only
// place an onChange handler exists without a DOM, so the picker is replaced by a
// prop recorder and the recorded handler is called the way a click would call it.
const { pickers } = vi.hoisted(() => ({ pickers: [] as Record<string, unknown>[] }))
vi.mock('../src/renderer/components/RefPicker', () => ({
  RefPicker: (props: Record<string, unknown>) => { pickers.push(props); return null }
}))

;(globalThis as unknown as { window: unknown }).window = { api: {} }

const { useStore } = await import('../src/renderer/store')
const { default: Review } = await import('../src/renderer/screens/Review')
const { makeLoaded } = await import('./helpers/loaded')

type State = ReturnType<typeof useStore.getState>
// renderToStaticMarkup reads zustand through useSyncExternalStore's SERVER snapshot,
// which is the store's initial state — so seeding has to mutate that object.
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()

function seed(over: { base?: string; compare?: string } = {}): { openReview: ReturnType<typeof vi.fn> } {
  const loaded = makeLoaded({ base: over.base ?? 'main', compare: over.compare ?? 'feat' })
  Object.assign(loaded as unknown as Record<string, unknown>, { volatile: [], commits: [], branchHash: 'bh' })
  Object.assign(loaded.skeleton as unknown as Record<string, unknown>, { mergeBase: 'mb00000' })
  const openReview = vi.fn(async () => {})
  Object.assign(initial() as unknown as Record<string, unknown>, {
    loaded, branch: loaded.state.branch, base: loaded.state.base, repo: loaded.state.repo,
    screen: 'review', openReview
  })
  return { openReview }
}

const render = (): string => renderToStaticMarkup(<Review />)
const picker = (label: string): Record<string, unknown> =>
  pickers.find((p) => p.label === label) ?? {}

afterEach(() => {
  pickers.length = 0
  Object.assign(initial() as unknown as Record<string, unknown>, { loaded: null as LoadedReview | null })
})

describe('review header ref pickers (finding 112)', () => {
  it('carries the reviewer’s base through a compare switch', () => {
    const { openReview } = seed({ base: 'v1.2.0', compare: 'feat' })
    render()

    ;(picker('compare ref').onChange as (v: string) => void)('feat2')

    // NOT { compare: 'feat2' } alone: openReview falls back to the repo's default
    // base for a missing one, which silently moves the review off v1.2.0 — a
    // different diff, a different URL, possibly a different persisted session.
    expect(openReview).toHaveBeenCalledWith('/repo', { base: 'v1.2.0', compare: 'feat2' })
  })

  it('keeps the compare side when the base is switched', () => {
    seed({ base: 'v1.2.0', compare: 'feat' })
    const setSessionBase = vi.fn(async () => {})
    Object.assign(initial() as unknown as Record<string, unknown>, { setSessionBase })
    render()

    ;(picker('base ref').onChange as (v: string) => void)('main')

    // the base side already routes through the store action that keeps the pair whole
    expect(setSessionBase).toHaveBeenCalledWith('main')
  })
})
