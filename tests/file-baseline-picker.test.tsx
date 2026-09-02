import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileBaselinePicker } from '../src/renderer/components/FileBaselinePicker'
import type { FileDiff } from '../src/shared/types'

const file = (extra: Partial<FileDiff> = {}): FileDiff => ({
  path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [], ...extra
})
const render = (f: FileDiff, mode: 'branch' | 'approved' | 'viewed', basis: 'approved' | 'generated' = 'approved'): string =>
  renderToStaticMarkup(<FileBaselinePicker f={f} mode={mode} basis={basis} onPick={() => {}} />)

describe('per-file baseline picker', () => {
  it('stays out of the way on a file with nothing to switch to', () => {
    expect(render(file(), 'branch')).toBe('')
  })

  it('offers only the baselines this file actually has', () => {
    const html = render(file({ sinceViewedHunks: [] }), 'branch')
    expect(html).toContain('Full diff')
    expect(html).toContain('Since viewed')
    expect(html).not.toContain('Since approved')
  })

  it('never calls a generation baseline "approved"', () => {
    const html = render(file({ sinceHunks: [] }), 'branch', 'generated')
    expect(html).toContain('Since the review ran')
    expect(html).not.toContain('Since approved')
  })

  it('names the file\'s own current baseline on the trigger, and marks it selected', () => {
    const html = render(file({ sinceViewedHunks: [] }), 'viewed')
    expect(html).toMatch(/class="fb-label">Since viewed</)
    expect(html).toMatch(/aria-selected="true"[^>]*><span[^>]*>\u2713<\/span>Since viewed/)
  })

  it('says which file it switches, so the control is not a bare caret in a row of 38', () => {
    const html = render(file({ sinceViewedHunks: [] }), 'branch')
    expect(html).toContain('aria-label="Diff baseline for src/a.ts"')
  })
})
