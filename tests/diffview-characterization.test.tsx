import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Comment, FileDiff, ViewMark } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { DiffView } from '../src/renderer/components/DiffView'
import { useStore } from '../src/renderer/store'
import { makeLoaded, makeFile } from './helpers/loaded'
import { initialStateOf } from './helpers/store'

// DiffView reads `loaded`, `viewedAt`, `diffStack` — seed them by mutating the
// initial state object the render observes (see tests/helpers/store.ts);
// reset() restores it.
const initial = () => initialStateOf(useStore)

function seed(loaded: LoadedReview, opts: { viewedAt?: Record<string, ViewMark>; against?: 'base' | 'approved' | 'viewed' } = {}): void {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = loaded
  ;(init as { diffStack: unknown }).diffStack = { out: [], against: opts.against ?? 'base' }
  if (opts.viewedAt) Object.assign(init.viewedAt, opts.viewedAt)
}
function reset(): void {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffStack: unknown }).diffStack = { out: [], against: 'base' }
  for (const k of Object.keys(init.viewedAt)) delete init.viewedAt[k]
}
afterEach(reset)

function render(f: FileDiff): string {
  return renderToStaticMarkup(<DiffView f={f} />)
}

describe('DiffView file header', () => {
  it('splits the path into dim dir + name and renders the change delta', () => {
    seed(makeLoaded())
    const out = render(makeFile({ path: 'src/deep/thing.ts', add: 3, del: 2 }))
    expect(out).toContain('class="dim">src/deep/</span>thing.ts')
    expect(out).toContain('src/deep/thing.ts') // data-limn-file too
  })

  it('renders the renamed / deleted / conflict / mode pills', () => {
    seed(makeLoaded())
    const renamed = render(makeFile({ path: 'b.ts', status: 'renamed', oldPath: 'a.ts' }))
    expect(renamed).toContain('← a.ts')
    const deleted = render(makeFile({ path: 'b.ts', status: 'deleted' }))
    expect(deleted).toContain('pill pill-risk')
    expect(deleted).toContain('deleted')
    const conflict = render(makeFile({ path: 'b.ts', conflict: true } as never))
    expect(conflict).toContain('conflict')
    const mode = render(makeFile({ path: 'b.ts', modeChange: { from: '100644', to: '100755' } } as never))
    expect(mode).toContain('pill pill-amber')
    expect(mode).toContain('>mode</span>')
  })

  it('shows the Viewed checkbox unchecked for an unviewed file', () => {
    seed(makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'h' })] }))
    const out = render(makeFile({ path: 'a.ts', fileHash: 'h' }))
    // an unchecked React checkbox emits no `checked` attribute
    expect(out).toContain('aria-label="Viewed a.ts"')
    expect(out).not.toContain('checked=""')
  })

  it('shows the Viewed checkbox checked (and the file marked viewed) once it has a matching mark', () => {
    const f = makeFile({ path: 'a.ts', fileHash: 'h' })
    seed(makeLoaded({ headSha: 'HEAD', files: [f] }), { viewedAt: { 'a.ts': { sha: 'HEAD', hash: 'h' } } })
    const out = render(f)
    expect(out).toContain('checked=""')
    // viewed → body collapses and the wrapper carries the `viewed` class
    expect(out).toContain('class="gfile collapsed viewed"')
  })

  it('renders the exclude button for an untracked file', () => {
    seed(makeLoaded())
    const out = render(makeFile({ path: 'new.ts', untracked: true }))
    expect(out).toContain('class="file-exclude"')
    expect(out).toContain('aria-label="Exclude new.ts — back to Untracked"')
  })
})

describe('DiffView empty-state strings per diff mode', () => {
  it('branch mode with no hunks → "No textual changes."', () => {
    seed(makeLoaded(), { against: 'base' })
    expect(render(makeFile({ path: 'a.ts', hunks: [] }))).toContain('No textual changes.')
  })

  it('approved mode on a tracked file with no since-diff → "No changes since approval."', () => {
    seed(makeLoaded(), { against: 'approved' })
    // the file HAS the approval sheet (an empty slice); a file without it would show the full diff instead
    expect(render(makeFile({ path: 'a.ts', hunks: [{ range: '@@', header: '', lines: [] }], sinceHunks: [] } as never))).toContain('No changes since approval.')
  })

  it('viewed mode on a tracked file with no since-diff → "No changes since file view."', () => {
    seed(makeLoaded(), { against: 'viewed' })
    expect(render(makeFile({ path: 'a.ts', hunks: [{ range: '@@', header: '', lines: [] }], sinceViewedHunks: [] } as never))).toContain('No changes since file view.')
  })

  it('binary file → "Binary file — no diff to show."', () => {
    seed(makeLoaded(), { against: 'base' })
    expect(render(makeFile({ path: 'img.png', binary: true }))).toContain('Binary file — no diff to show.')
  })
})

describe('DiffView per-line composer trigger + anchor source fields', () => {
  // The composer only mounts after an interactive gutter-add click; renderToStaticMarkup
  // (node env, no jsdom) cannot drive that click, so the exact submit payload cannot be
  // exercised here. Instead pin the fields the submit anchor is built from that DO surface
  // in the static markup: file+side+line (data-limn-line). The submit produces exactly:
  //   addComment({ kind:'diff', file:f.path, side, line:lineNo, hunkRange:r.hunkRange, lineContent:l.text }, text)
  // (see DiffBody.tsx onSubmit). The two fields that are NOT DOM-verbatim are covered
  // elsewhere: `hunkRange` no longer renders at all (#11) and is pinned on the row model
  // in file-rows.test.ts; `lineContent` is the raw input line, which the DOM shows
  // syntax-highlighted into token spans.
  it('surfaces the anchor source fields for an added line', () => {
    const f = makeFile({
      path: 'src/a.ts',
      hunks: [{ range: '@@ -1,1 +1,1 @@', header: 'fn main', lines: [{ old: null, new: 42, kind: 'add', text: 'const x = 1' }] }],
    })
    seed(makeLoaded({ files: [f] }))
    const out = render(f)
    // composer trigger (the "+" gutter button) + its per-line label
    expect(out).toContain('limn-line-add')
    expect(out).toContain('aria-label="Comment on line 42"')
    // anchor identity: file:side:line  (side='new' because l.new != null)
    expect(out).toContain('data-limn-line="src/a.ts:new:42"')
    // the line content renders (syntax-highlighted, so not contiguous) — the raw
    // 'const x = 1' feeds the anchor's lineContent; the visible fragment confirms it rendered
    expect(out).toContain('x = ')
  })
})

// #11: the body must read as the file, not as a stack of git hunks. The `@@` range and
// the hunk box around each run are a low-level git concept; nothing about them survives
// into the rendered surface, and the anchor payload keeps `hunkRange` regardless.
describe('DiffView renders the file, not hunks', () => {
  const threeHunks = () => makeFile({
    path: 'src/a.ts',
    hunks: [
      { range: '@@ -5,1 +5,2 @@', header: 'export function alpha(a: number) {', lines: [{ old: 5, new: 5, kind: '', text: 'five' }, { old: null, new: 6, kind: 'add', text: 'six' }] },
      { range: '@@ -20,1 +21,1 @@', header: 'class Beta {', lines: [{ old: 20, new: 21, kind: '', text: 'twenty' }] },
      { range: '@@ -40,1 +41,1 @@', header: '', lines: [{ old: null, new: 41, kind: 'add', text: 'forty one' }] },
    ],
  })

  it('renders no `@@` text anywhere', () => {
    const f = threeHunks()
    seed(makeLoaded({ files: [f] }))
    expect(render(f)).not.toContain('@@')
  })

  it('renders N hunks as one continuous body — no per-hunk box or header', () => {
    const f = threeHunks()
    seed(makeLoaded({ files: [f] }))
    const out = render(f)
    expect(out).not.toContain('hunk-head')
    expect(out).not.toContain('class="hunk')
    // every changed line still renders, addressed by its file line
    for (const sel of ['src/a.ts:new:5', 'src/a.ts:new:6', 'src/a.ts:new:21', 'src/a.ts:new:41']) {
      expect(out).toContain(`data-limn-line="${sel}"`)
    }
    // and they are siblings of one another inside the single diff body
    const body = out.slice(out.indexOf('class="gfile-diff'))
    expect(body.indexOf('src/a.ts:new:6')).toBeLessThan(body.indexOf('src/a.ts:new:21'))
  })

  it('keeps the useful half of the hunk header as a plain function label on a collapsed run', () => {
    const f = threeHunks()
    const loaded = makeLoaded({ files: [f] })
    ;(loaded as { writeCapability?: unknown }).writeCapability = { enabled: true, reason: 'available', branch: 'feat', workdir: '/wt' }
    seed(loaded)
    const out = render(f)
    expect(out).toContain('in alpha')
    expect(out).toContain('in Beta')
    expect(out).not.toContain('@@')
  })
})

// Comment.notInDiff (Task 4's re-anchor pipeline): the anchor line is valid in the
// file but not present in any rendered hunk at the current baseline (reverted nearby
// change / -U3 eviction). DiffBody surfaces these in a "not shown in this diff"
// bucket, mirroring the existing "outdated" bucket — never inline (their line, by
// construction, matches no rendered `dline`).
function makeComment(over: Partial<Comment> & { id: string }): Comment {
  return {
    author: 'user', text: 'note', status: 'queued', replies: [], createdAt: '2026-01-01T00:00:00Z', iteration: 0,
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 99, hunkRange: '@@', lineContent: 'gone' },
    ...over,
  } as Comment
}

describe('DiffBody "not shown in this diff" bucket', () => {
  it('renders a notInDiff comment in the bucket, not inline', () => {
    const f = makeFile({
      path: 'src/a.ts',
      hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'const x = 1' }] }],
    })
    const c = makeComment({ id: 'c1', notInDiff: true, text: 'anchored off-screen', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 99, hunkRange: '@@ -80,1 +99,1 @@', lineContent: 'gone' } })
    seed(makeLoaded({ files: [f], comments: [c] }))
    const out = render(f)
    expect(out).toContain('1 comment anchored to lines not shown in this diff:')
    expect(out).toContain('anchored off-screen')
    expect(out).toContain('not shown here')
    // not inline: line 99 is not among the rendered lines, so no thread renders next
    // to the (only) rendered line 1 — the bucket text is the sole appearance.
    const occurrences = out.split('anchored off-screen').length - 1
    expect(occurrences).toBe(1)
  })

  it('is absent when no comment has notInDiff', () => {
    const f = makeFile({
      path: 'src/a.ts',
      hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'const x = 1' }] }],
    })
    const c = makeComment({ id: 'c1', text: 'plain comment', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 1, hunkRange: '@@ -1,1 +1,1 @@', lineContent: 'const x = 1' } })
    seed(makeLoaded({ files: [f], comments: [c] }))
    const out = render(f)
    expect(out).not.toContain('not shown in this diff')
  })

  it('coexists with the outdated bucket without cross-contaminating', () => {
    const f = makeFile({
      path: 'src/a.ts',
      hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'const x = 1' }] }],
    })
    const outdated = makeComment({ id: 'c1', status: 'outdated', text: 'stale note', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 5, hunkRange: '@@', lineContent: 'gone' } })
    const notShown = makeComment({ id: 'c2', notInDiff: true, text: 'off-screen note', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 99, hunkRange: '@@', lineContent: 'gone' } })
    seed(makeLoaded({ files: [f], comments: [outdated, notShown] }))
    const out = render(f)
    expect(out).toContain('1 outdated comment')
    expect(out).toContain('stale note')
    expect(out).toContain('1 comment anchored to lines not shown in this diff:')
    expect(out).toContain('off-screen note')
  })

  it('includes a resolved comment in the bucket (#18: the pipeline now maintains its notInDiff)', () => {
    const f = makeFile({
      path: 'src/a.ts',
      hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'const x = 1' }] }],
    })
    const resolved = makeComment({ id: 'c1', status: 'resolved', notInDiff: true, text: 'resolved off-screen note', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 99, hunkRange: '@@', lineContent: 'gone' } })
    seed(makeLoaded({ files: [f], comments: [resolved] }))
    const out = render(f)
    // a resolved comment whose anchor was lost is flagged notInDiff rather than
    // re-statused to 'outdated' — the bucket is where it stays visible
    expect(out).toContain('1 comment anchored to lines not shown in this diff:')
    expect(out).toContain('resolved off-screen note')
  })

  it('shows the "line edited since comment" marker when the anchored line was rewritten', () => {
    const f = makeFile({
      path: 'src/a.ts',
      hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'const x = 1' }] }],
    })
    const edited = makeComment({ id: 'c1', anchorEdited: true, text: 'why so many options?', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 1, hunkRange: '@@ -1,1 +1,1 @@', lineContent: 'const x = 1' } })
    seed(makeLoaded({ files: [f], comments: [edited] }))
    expect(render(f)).toContain('line edited since comment')
  })
})
