import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import { FileTree } from '../src/renderer/components/FileTree'

function file(path: string): FileDiff {
  return { path, status: 'modified', binary: false, add: 1, del: 0, hunks: [] }
}

function html(files: FileDiff[], order?: 'tree' | 'explicit'): string {
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
