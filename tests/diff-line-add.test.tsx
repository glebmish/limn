import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import { DiffView } from '../src/renderer/components/DiffView'

function fileWithLine(lineNo: number): FileDiff {
  return {
    path: 'src/a.ts',
    status: 'modified',
    binary: false,
    add: 1,
    del: 0,
    hunks: [
      {
        range: '@@ -1,1 +1,1 @@',
        header: '',
        lines: [{ old: null, new: lineNo, kind: 'add', text: 'const x = 1' }],
      },
    ],
  }
}

describe('DiffView per-line comment "+"', () => {
  it('renders a focusable comment button with a per-line aria-label', () => {
    const out = renderToStaticMarkup(<DiffView f={fileWithLine(42)} />)

    expect(out).toContain('limn-line-add')
    expect(out).toContain('aria-label="Comment on line 42"')
  })
})
