import type { LoadedReview } from '../../src/shared/ipc'
import type { ChatThread, Comment, FileDiff, Section, ViewMark } from '../../src/shared/types'

/** Minimal LoadedReview builder for renderer-store characterization tests. Only the
 *  fields the store reads are populated; everything else is cast away. Matches the
 *  inline-cast style of `comments-routing.test.ts` / `gen-session-scope.test.ts`. */
export function makeLoaded(over: {
  files?: FileDiff[]
  headSha?: string
  chats?: Partial<ChatThread>[]
  comments?: Partial<Comment>[]
  fileExcluded?: Record<string, boolean>
  viewedAt?: Record<string, ViewMark>
  sections?: Section[]
  repo?: string
  base?: string
  compare?: string
  compareKind?: string
  agent?: { engine: string }
  latestIteration?: { n?: number; sessionId?: string }
  dirty?: boolean
  merged?: FileDiff[]
  artifacts?: { path: string; role: string }[]
} = {}): LoadedReview {
  const base = over.base ?? 'main'
  const compare = over.compare ?? 'feat'
  return {
    session: {
      pair: {
        base: { symbol: base, kind: 'branch' },
        compare: { symbol: compare, kind: over.compareKind ?? 'branch' },
      },
      agent: over.agent ?? { engine: 'claude' },
    },
    skeleton: { headSha: over.headSha ?? 'HEAD', files: over.files ?? [] },
    state: {
      repo: over.repo ?? '/repo',
      branch: compare,
      base,
      chats: (over.chats ?? []) as ChatThread[],
      comments: (over.comments ?? []) as Comment[],
      fileExcluded: over.fileExcluded ?? {},
      viewedAt: over.viewedAt ?? {},
      annotations: over.sections ? { sections: over.sections } : null,
      agent: over.agent ?? { engine: 'claude' },
      latestIteration: over.latestIteration,
    },
    artifacts: over.artifacts ?? [],
    dirty: over.dirty ?? false,
    merged: over.merged,
  } as unknown as LoadedReview
}

/** A renderable FileDiff. viewed-state derivation reads `path`/`fileHash`; a hunk is
 *  needed when a diff body renders. */
export function makeFile(over: Partial<FileDiff> & { path: string }): FileDiff {
  return {
    fileHash: 'h',
    status: 'modified',
    binary: false,
    add: 1,
    del: 0,
    hunks: [],
    ...over,
  } as unknown as FileDiff
}
