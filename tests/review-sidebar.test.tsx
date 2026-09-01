import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import type { FileDiff, ReviewAnnotations, Section } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { ReviewSidebar } from '../src/renderer/components/ReviewSidebar'
import { useStore } from '../src/renderer/store'

// zustand v5's bare `useStore()` reads getInitialState() for the SSR snapshot (see
// section-viewed-a11y.test.tsx) — seed `sidebarView` by mutating that object directly,
// the same way action-chips.test.tsx seeds `loaded`.
type State = ReturnType<typeof useStore.getState>
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()
function seedSidebarView(v: 'sections' | 'tree'): void {
  ;(initial() as unknown as { sidebarView: 'sections' | 'tree' }).sidebarView = v
}
afterEach(() => seedSidebarView('sections'))

function file(path: string): FileDiff {
  return { path, status: 'modified', binary: false, add: 1, del: 0, hunks: [] }
}

function section(id: string, name: string, files: string[]): Section {
  return { id, name, files, narration: [] }
}

const loaded = { skeleton: { headSha: 'abc', files: [] } } as unknown as LoadedReview
const sections: Section[] = [section('s1', 'Auth', ['src/auth/a.ts'])]
const filesFor = (s: Section) => s.files.map(file)
const flatDisplayFiles = [file('src/auth/a.ts'), file('src/other/b.ts')]
const looseFiles = [file('README.md')]
const annotations: ReviewAnnotations = { title: 't', summary: '', sections, questions: [] }

type Props = ComponentProps<typeof ReviewSidebar>

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    loaded,
    annotations,
    sections,
    comments: [],
    artifacts: [],
    artifactApprovals: {},
    peek: null,
    setPeek: () => {},
    docPath: null,
    viewedAt: {},
    curFile: null,
    cur: null,
    flatDisplayFiles,
    looseFiles,
    filesFor,
    reviewedCount: 0,
    viewedCount: 0,
    fileCount: flatDisplayFiles.length,
    collapsed: new Set<string>(),
    expanded: new Set<string>(),
    focusSectionId: undefined,
    onToggleSection: () => {},
    jumpTo: () => {},
    jumpToFile: () => {},
    jumpToRawFile: () => {},
    toggleDoc: () => {},
    closeDocBack: () => {},
    ...overrides
  }
}

function html(overrides: Partial<Props> = {}): string {
  return renderToStaticMarkup(<ReviewSidebar {...baseProps(overrides)} />)
}

function radioAriaChecked(out: string, label: string): string | null {
  const m = out.match(new RegExp(`<button[^>]*>${label}</button>`))
  const checked = m?.[0].match(/aria-checked="(true|false)"/)
  return checked ? checked[1] : null
}

describe('ReviewSidebar — Sections/Tree toggle', () => {
  it('renders a radiogroup of two radios with correct aria-checked, in sections mode', () => {
    seedSidebarView('sections')
    const out = html()

    expect(out).toContain('role="radiogroup"')
    expect((out.match(/role="radio"/g) ?? []).length).toBe(2)
    expect(radioAriaChecked(out, 'Sections')).toBe('true')
    expect(radioAriaChecked(out, 'Tree')).toBe('false')
  })

  it('reflects tree mode in aria-checked', () => {
    seedSidebarView('tree')
    const out = html()

    expect(radioAriaChecked(out, 'Sections')).toBe('false')
    expect(radioAriaChecked(out, 'Tree')).toBe('true')
  })

  it('tree mode renders folder rows and no section rows', () => {
    seedSidebarView('tree')
    const out = html()

    expect(out).toContain('gnav-folder')
    expect(out).not.toContain('gnav-sec')
  })

  it('sections mode renders section rows and grouped directory headers', () => {
    seedSidebarView('sections')
    const out = html()

    expect(out).toContain('gnav-sec')
    expect(out).toContain('gnav-dirhead')
  })

  it('unannotated rail renders no toggle', () => {
    const out = renderToStaticMarkup(<ReviewSidebar {...baseProps({ annotations: undefined })} />)

    expect(out).not.toContain('role="radiogroup"')
  })
})
