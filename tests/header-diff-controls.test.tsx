import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HeaderDiffControls } from '../src/renderer/components/HeaderDiffControls'

const render = (over: Partial<Parameters<typeof HeaderDiffControls>[0]> = {}): string =>
  renderToStaticMarkup(
    <HeaderDiffControls
      globalMode="branch"
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

  it('names the bulk since-baseline for what it is', () => {
    const generated = render({ anySinceApproved: true, sinceBasis: 'generated' })
    expect(generated).toContain('Since the review ran')
    expect(generated).not.toContain('Since approved')

    expect(render({ anySinceApproved: true, sinceBasis: 'approved' })).toContain('Since approved')
  })

  it('still offers only the baselines some file actually has', () => {
    const html = render({ anySinceViewed: true, sinceBasis: 'approved' })
    expect(html).toContain('Since viewed')
    expect(html).not.toContain('Since approved')
  })
})
