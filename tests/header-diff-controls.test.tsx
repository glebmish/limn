import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HeaderDiffControls } from '../src/renderer/components/HeaderDiffControls'

const render = (over: Partial<Parameters<typeof HeaderDiffControls>[0]> = {}): string =>
  renderToStaticMarkup(
    <HeaderDiffControls
      globalMode="branch"
      anySinceReview={false}
      anySinceApproved={false}
      anySinceViewed={false}
      dirty={false}
      sinceBasis={null}
      setGlobalDiffMode={() => {}}
      {...over}
    />
  )

describe('the page-header diff controls', () => {
  it('always offers the marks key — a clean review draws drift rails too', () => {
    expect(render()).toContain('aria-label="What the diff marks mean"')
  })

  it('tells the key what this review can show', () => {
    expect(render({ dirty: false, sinceBasis: null })).not.toContain('rail-sw since')
    expect(render({ dirty: false, sinceBasis: 'generated' })).toContain('rail-sw since')
    expect(render({ dirty: true, sinceBasis: null })).toContain('rail-sw staged')
  })

  it('offers the review window and the approval window as separate options', () => {
    const html = render({ anySinceReview: true, anySinceApproved: true, sinceBasis: 'approved' })
    expect(html).toContain('Since the review ran')
    expect(html).toContain('Since approved')
  })

  it('still offers only the baselines some file actually has', () => {
    const html = render({ anySinceViewed: true, sinceBasis: 'approved' })
    expect(html).toContain('Since viewed')
    expect(html).not.toContain('Since approved')
    expect(html).not.toContain('Since the review ran')
  })

  it('lists the baselines oldest checkpoint first', () => {
    const html = render({ anySinceReview: true, anySinceApproved: true, anySinceViewed: true })
    const order = [...html.matchAll(/role="option"[^>]*>(?:<[^>]*>|\u2713)*([^<]+)</g)].map((m) => m[1])
    expect(order).toEqual(['Full diff', 'Since the review ran', 'Since approved', 'Since viewed'])
  })
})
