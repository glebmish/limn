import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { BehaviorContrast, FileDiff, Section } from '../src/shared/types'
import { SectionView } from '../src/renderer/components/SectionView'
import { useStore } from '../src/renderer/store'
import { initialStateOf } from './helpers/store'

// minimal FileDiff: viewed-state derivation reads `path`/`fileHash`; DiffView needs a
// renderable hunk shape when the section body is open.
function file(path: string): FileDiff {
  return {
    path,
    fileHash: 'h',
    status: 'modified',
    binary: false,
    add: 1,
    del: 0,
    hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'x' }] }],
  } as unknown as FileDiff
}

function section(extra: Partial<Section>): Section {
  return {
    id: 's1', name: 'Auth',
    narration: [{ text: 'narration text goes here' }],
    files: ['a.ts'],
    ...extra
  } as unknown as Section
}

function initial() {
  return initialStateOf(useStore)
}
function reset(): void {
  const init = initial()
  for (const k of Object.keys(init.viewedAt)) delete init.viewedAt[k]
  init.collapsed.clear()
  init.expanded.clear()
}
afterEach(reset)

function html(extra: Partial<Section>): string {
  return renderToStaticMarkup(
    <SectionView s={section(extra)} n={1} total={1} files={[file('a.ts')]} secRef={() => {}} />
  )
}

describe('SectionView contrast rendering', () => {
  it('a section with contrast renders a two-row was/now strip above the narration', () => {
    const contrast: BehaviorContrast = { was: 'threw on empty input', now: 'returns an empty array' }
    const out = html({ contrast })
    expect(out).toContain('threw on empty input')
    expect(out).toContain('returns an empty array')
    expect(out).toContain('gsec-contrast')
    // the strip renders before the narration block in document order
    expect(out.indexOf('threw on empty input')).toBeLessThan(out.indexOf('narration text goes here'))
  })

  it('a section without contrast renders no strip', () => {
    const out = html({})
    expect(out).not.toContain('gsec-contrast')
  })
})
