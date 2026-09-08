import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactDoc } from '../src/renderer/components/ArtifactDoc'
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

const DOC = ['# Spec', '', 'The service retries twice.', '', 'It then gives up.']

function seed(comments: Partial<Comment>[]): void {
  seedLoaded({
    session: { pair: { base: { symbol: 'main', kind: 'branch' }, compare: { symbol: 'feat', kind: 'branch' } } },
    skeleton: { headSha: 'HEAD', files: [] },
    state: {
      branch: 'feat', comments: comments as Comment[], chats: [], artifactApprovals: {}, annotations: null
    },
    artifacts: [{ role: 'spec', format: 'markdown', path: 'spec.md', title: 'Spec', lines: DOC }],
    dirty: false
  } as unknown as LoadedReview)
}

const cmt = (over: Partial<Comment>): Partial<Comment> => ({
  id: 'c1', author: 'user', text: 'does it?', status: 'queued', replies: [], createdAt: 'now', iteration: 1,
  anchor: { kind: 'artifact', path: 'spec.md', line: 3, lineContent: 'The service retries twice.' },
  ...over
})

const render = (): string => renderToStaticMarkup(<ArtifactDoc path="spec.md" onClose={() => {}} />)

describe('ArtifactDoc threads', () => {
  it('mounts a located comment inline under its block', () => {
    seed([cmt({})])
    const out = render()
    expect(out).toContain('on spec line 3')
    expect(out).not.toContain('not shown here')
  })

  // The re-anchor pass flags a comment whose quote it could not place on the doc as
  // notInDiff, leaving `line` where it was. Mounting it under whatever block now holds
  // that line would put the thread against unrelated prose.
  it('never mounts a notInDiff comment inline — it goes to the bottom list', () => {
    seed([cmt({ status: 'resolved', notInDiff: true })])
    const out = render()
    expect(out).not.toContain('on spec line 3')
    expect(out).toContain('not shown here')
    expect(out).toContain('does it?')
  })

  it('still lists outdated comments at the bottom', () => {
    seed([cmt({ status: 'outdated' })])
    const out = render()
    expect(out).not.toContain('on spec line 3')
    expect(out).toContain('outdated')
  })
})
