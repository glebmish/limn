import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff, Section, ViewMark } from '../src/shared/types'
import { SectionView } from '../src/renderer/components/SectionView'
import { useStore } from '../src/renderer/store'

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
const vm = (sha = 's'): ViewMark => ({ sha, hash: 'h' })
const section = (name: string): Section => ({ id: 's1', name, narration: [] } as unknown as Section)

// zustand v5's `useStore` server snapshot reads `getInitialState()` (react.mjs), so
// `renderToStaticMarkup` sees the INITIAL store state and ignores `setState`. Seed the
// state SectionView reads by mutating the initial `viewedAt`/`collapsed` objects (the
// same references SSR observes); `reset()` restores them between cases.
const initial = () => (useStore as unknown as { getInitialState: () => ReturnType<typeof useStore.getState> }).getInitialState()
function seedViewed(marks: Record<string, ViewMark>): void {
  Object.assign(initial().viewedAt, marks)
}
function seedCollapsed(id: string): void {
  initial().collapsed.add(id)
}
function reset(): void {
  const init = initial()
  for (const k of Object.keys(init.viewedAt)) delete init.viewedAt[k]
  init.collapsed.clear()
  init.expanded.clear()
}

function html(files: FileDiff[]): string {
  return renderToStaticMarkup(
    <SectionView s={section('Auth')} n={1} total={3} files={files} secRef={() => {}} />
  )
}

afterEach(reset)

describe('SectionView a11y', () => {
  it('collapsed header is a disclosure button with aria-expanded=false and a section label', () => {
    seedCollapsed('s1')
    const out = html([file('a.ts'), file('b.ts')])

    // the collapsed header (not the file rows) is the section disclosure trigger
    const head = out.slice(out.indexOf('class="gsec-head"'), out.indexOf('class="gsec-body"') >= 0 ? out.indexOf('class="gsec-body"') : out.length)
    expect(head).toContain('role="button"')
    expect(head).toContain('aria-expanded="false"')
    expect(head).toContain('aria-label="Review section: Auth"')
  })

  it('section checkbox carries the section-name aria-label', () => {
    // open section (default initial state): the tri-state checkbox is rendered
    const out = html([file('a.ts'), file('b.ts')])

    expect(out).toContain('aria-label="Mark all files in “Auth” viewed"')
  })

  it('renders the tri-state dash for the "some" view state', () => {
    seedViewed({ 'a.ts': vm() }) // one of two files viewed → viewState "some"
    const out = html([file('a.ts'), file('b.ts')])

    expect(out).toContain('fv-dash')
  })
})
