import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalCard } from '../src/renderer/components/ApprovalCard'
import type { ApprovalRequest } from '../src/shared/types'

// #15: the approval card gave no context beyond the tool kind — no path, no
// diff. These tests pin path visibility for a file_change request and the
// collapsed-by-default diff disclosure, plus the no-payload fallback that
// must keep rendering (never blank/crash) when detail is absent entirely.

const noop = (): void => {}

describe('ApprovalCard — file_change with a path and diff', () => {
  const request: ApprovalRequest = {
    id: 'r1',
    engine: 'codex',
    kind: 'file_change',
    summary: 'Edit src/a.ts',
    detail: {
      files: ['src/a.ts'],
      diffs: [{ path: 'src/a.ts', oldText: 'const x = 1', newText: 'const x = 2' }]
    }
  }

  it('always shows the file path', () => {
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('class="ac-detail ac-files"')
    expect(out).toContain('src/a.ts')
  })

  it('collapses the diff by default, behind a "Show diff" disclosure', () => {
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('Show diff')
    expect(out).toContain('aria-expanded="false"')
    // the diff body is not in the initial (collapsed) markup
    expect(out).not.toContain('const x = 1')
    expect(out).not.toContain('const x = 2')
  })

  it('omits the diff disclosure entirely when there is no diff, even with files present', () => {
    const noDiff: ApprovalRequest = { ...request, detail: { files: ['src/a.ts'] } }
    const out = renderToStaticMarkup(<ApprovalCard request={noDiff} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).not.toContain('Show diff')
    expect(out).toContain('src/a.ts')
  })

  it('a new-file diff (no oldText) still renders the disclosure', () => {
    const added: ApprovalRequest = {
      ...request,
      detail: { files: ['src/new.ts'], diffs: [{ path: 'src/new.ts', newText: 'export const y = 1' }] }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={added} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('Show diff')
  })
})

describe('ApprovalCard — expanded diff body (via the initialOpen test seam)', () => {
  it('a single-file diff omits the per-file path header, and shows before/after blocks', () => {
    const request: ApprovalRequest = {
      id: 'r1', engine: 'codex', kind: 'file_change', summary: 'Edit src/a.ts',
      detail: { files: ['src/a.ts'], diffs: [{ path: 'src/a.ts', oldText: 'const x = 1', newText: 'const x = 2' }] }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} initialOpen />)
    expect(out).toContain('aria-expanded="true"')
    expect(out).not.toContain('class="ac-diff-path"')
    expect(out).toContain('− before')
    expect(out).toContain('const x = 1')
    expect(out).toContain('+ after')
    expect(out).toContain('const x = 2')
  })

  it('a multi-file diff shows a per-file path header for each file', () => {
    const request: ApprovalRequest = {
      id: 'r6', engine: 'codex', kind: 'file_change', summary: 'Edit 2 files',
      detail: {
        files: ['src/a.ts', 'src/b.ts'],
        diffs: [
          { path: 'src/a.ts', oldText: 'old a', newText: 'new a' },
          { path: 'src/b.ts', oldText: 'old b', newText: 'new b' }
        ]
      }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} initialOpen />)
    expect(out).toContain('<div class="ac-diff-path">src/a.ts</div>')
    expect(out).toContain('<div class="ac-diff-path">src/b.ts</div>')
    expect(out).toContain('old a')
    expect(out).toContain('new a')
    expect(out).toContain('old b')
    expect(out).toContain('new b')
  })

  it('a new-file diff (no oldText / create case) omits the "before" block entirely', () => {
    const request: ApprovalRequest = {
      id: 'r7', engine: 'codex', kind: 'file_change', summary: 'Edit src/new.ts',
      detail: { files: ['src/new.ts'], diffs: [{ path: 'src/new.ts', newText: 'export const y = 1' }] }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} initialOpen />)
    expect(out).not.toContain('− before')
    expect(out).not.toContain('ac-diff-old')
    expect(out).toContain('+ after')
    expect(out).toContain('export const y = 1')
  })

  it('renders the "+N more files" marker when detail.moreFiles is set', () => {
    const request: ApprovalRequest = {
      id: 'r8', engine: 'codex', kind: 'file_change', summary: 'Edit 20 files',
      detail: { files: ['src/a.ts'], diffs: [{ path: 'src/a.ts', newText: 'x' }], moreFiles: 5 }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} initialOpen />)
    expect(out).toContain('+5 more files')
  })

  it('omits the "+N more files" marker when detail.moreFiles is absent', () => {
    const request: ApprovalRequest = {
      id: 'r9', engine: 'codex', kind: 'file_change', summary: 'Edit src/a.ts',
      detail: { files: ['src/a.ts'], diffs: [{ path: 'src/a.ts', newText: 'x' }] }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} initialOpen />)
    expect(out).not.toContain('more files')
  })
})

describe('ApprovalCard — command and tool_use requests', () => {
  it('shows the command for a command-kind request', () => {
    const request: ApprovalRequest = {
      id: 'r2', engine: 'claude', kind: 'command', summary: 'Run `npm test`', detail: { command: 'npm test' }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('npm test')
    expect(out).not.toContain('Show diff')
  })

  it('shows the tool name via the summary for a tool_use request', () => {
    const request: ApprovalRequest = {
      id: 'r3', engine: 'claude', kind: 'tool_use', summary: 'Use add_comment', detail: { toolName: 'add_comment' }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('Use add_comment')
  })
})

describe('ApprovalCard — agent-stated reason', () => {
  it('renders detail.reason as a quiet line when present', () => {
    const request: ApprovalRequest = {
      id: 'r10', engine: 'codex', kind: 'command', summary: 'Run `rm -rf build`',
      detail: { command: 'rm -rf build', reason: 'Need to clear the stale build dir before rebuilding.' }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('class="ac-reason"')
    expect(out).toContain('Need to clear the stale build dir before rebuilding.')
  })

  it('omits the reason line entirely when detail.reason is absent', () => {
    const request: ApprovalRequest = {
      id: 'r11', engine: 'claude', kind: 'command', summary: 'Run `npm test`', detail: { command: 'npm test' }
    }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).not.toContain('ac-reason')
  })
})

describe('ApprovalCard — the dead risk field is gone', () => {
  it('renders no risk markup even if a stale caller still sets it', () => {
    const request = {
      id: 'r12', engine: 'codex', kind: 'command', summary: 'Run `npm test`',
      detail: { command: 'npm test' }, risk: 'high'
    } as unknown as ApprovalRequest
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).not.toContain('ac-risk')
  })
})

describe('ApprovalCard — defensive no-payload fallback', () => {
  it('renders the kind and summary without crashing when detail is entirely absent', () => {
    const request: ApprovalRequest = { id: 'r4', engine: 'codex', kind: 'file_change', summary: 'Edit' }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('Edit')
    expect(out).not.toContain('Show diff')
    expect(out).not.toContain('class="ac-detail ac-files"')
  })

  it('renders with an empty files array (no path recovered) without crashing', () => {
    const request: ApprovalRequest = { id: 'r5', engine: 'codex', kind: 'file_change', summary: 'Edit', detail: { files: [] } }
    const out = renderToStaticMarkup(<ApprovalCard request={request} index={0} total={1} onDecide={noop} onStop={noop} />)
    expect(out).toContain('Edit')
    expect(out).not.toContain('Show diff')
  })
})
