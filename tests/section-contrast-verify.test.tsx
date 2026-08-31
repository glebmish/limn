import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { BehaviorContrast, FileDiff, Section } from '../src/shared/types'
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

function section(extra: Partial<Section>): Section {
  return {
    id: 's1', name: 'Auth',
    narration: [{ text: 'narration text goes here' }],
    files: ['a.ts'],
    ...extra
  } as unknown as Section
}

function initial() {
  return (useStore as unknown as { getInitialState: () => ReturnType<typeof useStore.getState> }).getInitialState()
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

describe('SectionView contrast + verify rendering', () => {
  it('a section with contrast renders a two-row was/now strip above the narration', () => {
    const contrast: BehaviorContrast = { was: 'threw on empty input', now: 'returns an empty array' }
    const out = html({ contrast })
    expect(out).toContain('threw on empty input')
    expect(out).toContain('returns an empty array')
    expect(out).toContain('gsec-contrast')
    // the strip renders before the narration block in document order
    expect(out.indexOf('threw on empty input')).toBeLessThan(out.indexOf('narration text goes here'))
  })

  it('a section with verify renders a copyable chip', () => {
    const out = html({ verify: 'npm test' })
    expect(out).toContain('npm test')
    expect(out).toContain('gsec-verify')
  })

  it('the verify chip label and command render as separate elements even for a glued fixture string', () => {
    // the generator emits `verify` as a bare command with no leading label text
    // of its own ("Run `npm test` ..."), so the "Verify" label butts directly
    // against the command in the markup — the gap has to come from CSS, not
    // from the two being merged into one text node.
    const out = html({ verify: 'Run `npm test — tests/db.test.ts`' })
    expect(out).toContain('<span class="gv-label">Verify</span>')
    expect(out).toContain('<code class="gv-cmd">Run `npm test — tests/db.test.ts`</code>')
  })

  it('.gsec-verify gets a flex gap in CSS so the label and command are never glued', () => {
    // regression guard for #3: unlike .gsec-contrast's .gc-label (fixed via
    // margin-right), VerifyChip's icon/label/command previously had no CSS at
    // all — a plain <button> renders them with zero gap. Assert the rule
    // exists rather than re-deriving pixel layout (jsdom/SSR here has no
    // layout engine to measure against).
    const css = readFileSync(path.join(__dirname, '../src/renderer/styles/review.css'), 'utf8')
    const rule = /\.gsec-verify\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/display:\s*inline-flex/)
    expect(rule).toMatch(/gap:\s*\d/)
  })

  it('a section with neither contrast nor verify renders no strip/chip', () => {
    const out = html({})
    expect(out).not.toContain('gsec-contrast')
    expect(out).not.toContain('gsec-verify')
  })
})
