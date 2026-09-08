import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Comment } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

// The seam: ArtifactDoc's own import of react-markdown. React compares element types
// by reference, so the `components` map ArtifactDoc hands to ReactMarkdown IS the
// identity of every block element in the doc — if it changes between renders React
// unmounts and rebuilds the whole markdown subtree, wiping the local state of the
// InlineThreads (editing/draft) and Composers mounted inside it. Capturing the map
// across renders is the only way to observe that without a DOM.
const { seen } = vi.hoisted(() => ({ seen: [] as Record<string, unknown>[] }))
vi.mock('react-markdown', () => ({
  default: (props: { components?: Record<string, unknown> }) => {
    if (props.components) seen.push(props.components)
    return null
  }
}))

const { ArtifactDoc } = await import('../src/renderer/components/ArtifactDoc')
const { useStore } = await import('../src/renderer/store')

type State = ReturnType<typeof useStore.getState>
const initialState = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()
function seedLoaded(loaded: LoadedReview | null): void {
  ;(initialState() as { loaded: LoadedReview | null }).loaded = loaded
}
afterEach(() => { seedLoaded(null); seen.length = 0 })

const DOC = ['# Spec', '', 'The service retries twice.', '', '- a list item']

const cmt = (over: Partial<Comment>): Partial<Comment> => ({
  id: 'c1', author: 'user', text: 'does it?', status: 'queued', replies: [], createdAt: 'now', iteration: 1,
  anchor: { kind: 'artifact', path: 'spec.md', line: 3, lineContent: 'The service retries twice.' },
  ...over
})

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

const render = (): string => renderToStaticMarkup(<ArtifactDoc path="spec.md" onClose={() => {}} />)

const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'li', 'pre', 'table', 'code', 'a']

describe('ArtifactDoc markdown element identity (finding 109)', () => {
  it('hands ReactMarkdown the same component functions on every render', () => {
    seed([cmt({})])
    render()
    render()
    expect(seen).toHaveLength(2)
    const [first, second] = seen
    for (const tag of BLOCK_TAGS) {
      expect(first[tag], `components.${tag} must exist`).toBeTypeOf('function')
      expect(second[tag], `components.${tag} changed identity between renders`).toBe(first[tag])
    }
    expect(second).toBe(first)
  })

  // The user-visible bug: any state ArtifactDoc holds (composerLine, approving) or any
  // store update flowing through it re-renders the doc. If that changes the element
  // types, every InlineThread remounts and a half-typed comment edit is gone.
  it('keeps the same component functions when the doc state changes underneath it', () => {
    seed([cmt({})])
    render()
    seed([cmt({}), cmt({ id: 'c2', text: 'and this?', anchor: { kind: 'artifact', path: 'spec.md', line: 5, lineContent: '- a list item' } })])
    render()
    expect(seen).toHaveLength(2)
    for (const tag of BLOCK_TAGS) {
      expect(seen[1][tag], `components.${tag} changed identity after a store update`).toBe(seen[0][tag])
    }
  })
})
