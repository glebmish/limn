import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
;(globalThis as unknown as { window: unknown }).window = { api: {} }
import { FileHeader } from '../src/renderer/components/FileHeader'

const f: FileDiff = { path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [] }
const render = (over: Partial<Parameters<typeof FileHeader>[0]> = {}): string =>
  renderToStaticMarkup(
    <FileHeader
      f={f}
      excluded={false}
      isViewed={false}
      changedSinceViewed={false}
      fileStatus="st-unrev"
      showBody
      effectiveOpen
      artifact={undefined}
      baselineMode="branch"
      onToggleOpen={() => {}}
      onToggleViewed={() => {}}
      onToggleExcluded={() => {}}
      onPickBaseline={() => {}}
      onToggleFolds={() => {}}
      {...over}
    />
  )

describe('file header folds and layout note', () => {
  it('offers Expand all, and Collapse once the folds are open', () => {
    expect(render()).toMatch(/aria-label="Expand all folds"[^>]*>Expand all</)
    expect(render({ foldsOpen: true })).toMatch(/aria-label="Collapse folds"[^>]*>Collapse</)
  })

  it('has nothing to fold on a binary file, or when no handler is wired', () => {
    expect(render({ f: { ...f, binary: true } })).not.toContain('file-folds')
    expect(render({ onToggleFolds: undefined })).not.toContain('file-folds')
  })

  it('shows the Multi fallback note only when told', () => {
    expect(render({ layoutNote: 'no checkpoint for this file' })).toContain('class="pill layout-note"')
    expect(render()).not.toContain('layout-note')
  })
})
