import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import { FileTree } from '../src/renderer/components/FileTree'

function file(path: string): FileDiff {
  return { path, status: 'modified', binary: false, add: 1, del: 0, hunks: [] }
}

function html(files: FileDiff[], order?: 'tree' | 'explicit' | 'grouped'): string {
  return renderToStaticMarkup(
    <FileTree files={files} viewedAt={{}} currentFile={null} onFileClick={() => {}} order={order} />
  )
}

describe('FileTree ordering', () => {
  it('uses directory-first tree order by default', () => {
    const out = html([file('HANDOFF.md'), file('src/main/git.ts')])

    expect(out.indexOf('title="src/main/git.ts')).toBeLessThan(out.indexOf('title="HANDOFF.md'))
  })

  it('uses the supplied file order for generated review sections', () => {
    const out = html([file('HANDOFF.md'), file('src/main/git.ts')], 'explicit')

    expect(out.indexOf('title="HANDOFF.md')).toBeLessThan(out.indexOf('title="src/main/git.ts'))
  })
})

describe('FileTree grouped order', () => {
  it('renders a header exactly once per dir, and both same-named files under distinct headers in order', () => {
    const out = html([file('src/renderer/ipc.ts'), file('src/main/ipc.ts')], 'grouped')

    const rendererHeadIdx = out.indexOf('<div class="gnav-dirhead">src/renderer/</div>')
    const mainHeadIdx = out.indexOf('<div class="gnav-dirhead">src/main/</div>')
    expect(rendererHeadIdx).toBeGreaterThanOrEqual(0)
    expect(mainHeadIdx).toBeGreaterThanOrEqual(0)
    expect((out.match(/gnav-dirhead/g) ?? []).length).toBe(2)

    const rendererFileIdx = out.indexOf('title="src/renderer/ipc.ts')
    const mainFileIdx = out.indexOf('title="src/main/ipc.ts')
    expect(rendererHeadIdx).toBeLessThan(rendererFileIdx)
    expect(rendererFileIdx).toBeLessThan(mainHeadIdx)
    expect(mainHeadIdx).toBeLessThan(mainFileIdx)
  })

  it('renders no header for a root-level file', () => {
    const out = html([file('README.md')], 'grouped')

    expect(out).not.toContain('gnav-dirhead')
    expect(out).toContain('title="README.md')
  })
})
