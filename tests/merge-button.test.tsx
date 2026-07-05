import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LoadedReview } from '../src/shared/ipc'
import { MergeButton } from '../src/renderer/components/MergeSheet'
import { makeLoaded } from './helpers/loaded'

function html(loaded: LoadedReview): string {
  return renderToStaticMarkup(<MergeButton loaded={loaded} />)
}

describe('MergeButton visibility (spec §3: never renders off branch↔branch; S9)', () => {
  it('renders "Merge into <base>…" for a branch↔branch, un-merged session', () => {
    const out = html(makeLoaded())
    expect(out).toContain('Merge into main…')
    expect(out).toContain('rv-land')
  })
  it('hidden when the compare side is not a branch', () => {
    expect(html(makeLoaded({ compareKind: 'commit' }))).toBe('')
  })
  it('hidden when the base side is not a branch (tag/SHA base — S9)', () => {
    const l = makeLoaded()
    ;(l.session.pair.base as { kind: string }).kind = 'tag'
    expect(html(l)).toBe('')
  })
  it('hidden once the session is merged (terminal record)', () => {
    const l = makeLoaded()
    ;(l.state as unknown as { merged?: unknown }).merged = { mergedSha: 'a'.repeat(40) }
    expect(html(l)).toBe('')
  })
  it('offers "Mark merged…" when the branch landed outside Limn (S12)', () => {
    const l = makeLoaded() as LoadedReview & { mergedExternally?: boolean }
    l.mergedExternally = true
    const out = html(l)
    expect(out).toContain('Mark merged…')
    expect(out).not.toContain('Merge into main…')
  })
  it('the closed sheet is not in the tree', () => {
    expect(html(makeLoaded())).not.toContain('msh-head')
  })
})
