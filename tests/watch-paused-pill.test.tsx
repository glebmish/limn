import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WatchPausedPill } from '../src/renderer/components/DriftFetchPill'

describe('WatchPausedPill (titlebar "live updates paused" pill)', () => {
  it('renders the fixed label with the reason as the tooltip', () => {
    const out = renderToStaticMarkup(<WatchPausedPill reason="index.lock exists" />)
    expect(out).toContain('Live updates paused — branch unavailable')
    expect(out).toContain('title="index.lock exists"')
    expect(out).toContain('class="cm-watch-paused"')
  })

  it('has no action button — a probe or reload clears it', () => {
    const out = renderToStaticMarkup(<WatchPausedPill reason="repo gone" />)
    expect(out).not.toContain('<button')
  })
})
