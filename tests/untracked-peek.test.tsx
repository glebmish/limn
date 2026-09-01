import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { UntrackedGroup } from '../src/renderer/components/UntrackedGroup'

const untracked: FileDiff = {
  path: 'src/new.ts', status: 'added', binary: false, untracked: true, add: 2, del: 0,
  hunks: [{
    range: '@@ -0,0 +1,2 @@', header: '', lines: [
      { old: null, new: 1, kind: 'add', text: 'const a = 1' },
      { old: null, new: 2, kind: 'add', text: 'const b = 2' }
    ]
  }]
} as unknown as FileDiff

describe('untracked file peek', () => {
  // The peek is collapsed by default, so the diff body only renders after a click —
  // which renderToStaticMarkup cannot drive. What it CAN pin is that the collapsed
  // row is clean, and (#11) that no `@@` range reaches the markup from anywhere.
  it('lists the file without any git hunk syntax', () => {
    const out = renderToStaticMarkup(<UntrackedGroup files={[untracked]} />)
    expect(out).toContain('src/')
    expect(out).toContain('new.ts')
    expect(out).toContain('aria-label="Include src/new.ts in the review"')
    expect(out).not.toContain('@@')
    expect(out).not.toContain('hunk-head')
  })

  it('renders nothing at all when there are no untracked files', () => {
    expect(renderToStaticMarkup(<UntrackedGroup files={[]} />)).toBe('')
  })
})
