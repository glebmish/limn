import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { OutsideDiffBand } from '../src/renderer/components/OutsideDiffBand'
import { useStore } from '../src/renderer/store'
import type { Comment } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { initialStateOf } from './helpers/store'

type State = ReturnType<typeof useStore.getState>
const initialState = (): State => initialStateOf(useStore)
function seedLoaded(loaded: LoadedReview | null): void {
  ;(initialState() as { loaded: LoadedReview | null }).loaded = loaded
}
afterEach(() => seedLoaded(null))

function seed(comments: Partial<Comment>[]): void {
  seedLoaded({
    session: { pair: { base: { symbol: 'main', kind: 'branch' }, compare: { symbol: 'feat', kind: 'branch' } } },
    skeleton: { headSha: 'HEAD', files: [{ path: 'src/main/ipc.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [] }] },
    state: { branch: 'feat', comments: comments as Comment[], chats: [], artifactApprovals: {}, annotations: null },
    artifacts: [],
    dirty: false
  } as unknown as LoadedReview)
}

const finding = (over: Partial<Comment> = {}): Partial<Comment> => ({
  id: 'af-1', author: 'agent', text: 'Unchecked-out branches read the wrong working tree.', status: 'proposed',
  severity: 'risk', source: { actionId: 'act-1', runId: 'run-1', threadId: 11 },
  replies: [], createdAt: 'now', iteration: 1, notInDiff: true,
  anchor: {
    kind: 'diff', file: 'src/main/review.ts', side: 'new', line: 35, endLine: 38, hunkRange: '',
    lineContent: 'export async function resolveWorkdir(repo: string, pair: RefPair): Promise<string> {',
    context: { before: ['/** The working directory', ' *  worktree', ' *  path */'], after: ["  if (pair.compare.kind !== 'branch') return repo", '  return (await branchCheckedOutAt(repo, pair.compare.symbol)) ?? repo', '}'] }
  },
  ...over
})

const render = (): string => renderToStaticMarkup(<OutsideDiffBand />)

describe('OutsideDiffBand', () => {
  it('renders nothing when every comment sits on a file the diff shows', () => {
    seed([finding({ anchor: { kind: 'diff', file: 'src/main/ipc.ts', side: 'new', line: 3, hunkRange: '', lineContent: 'x' } })])
    expect(render()).toBe('')
  })

  it('lists an off-diff proposal under its file, with the file jump attribute the stepper lands on', () => {
    seed([finding()])
    const out = render()
    expect(out).toContain('1 comment outside this diff')
    expect(out).toContain('data-limn-file="src/main/review.ts"')
    expect(out).toContain('data-comment-id="af-1"')
    expect(out).toContain('outside this diff')
  })

  it('shows the stamped context as a numbered snippet with the anchored lines marked', () => {
    seed([finding()])
    const out = render()
    for (const n of [32, 33, 34, 35, 36, 37, 38]) expect(out).toContain(`>${n}<`)
    expect(out).toContain('export async function resolveWorkdir')
    // 35..38 hit, 32..34 not
    expect(out.match(/class="odl hit"/g)?.length).toBe(4)
  })

  it('pluralises and groups by file', () => {
    seed([finding(), finding({ id: 'af-2', anchor: { kind: 'diff', file: 'src/main/git.ts', side: 'new', line: 5, hunkRange: '', lineContent: 'five' } })])
    const out = render()
    expect(out).toContain('2 comments outside this diff')
    expect(out.indexOf('src/main/git.ts')).toBeLessThan(out.indexOf('src/main/review.ts'))
  })
})
