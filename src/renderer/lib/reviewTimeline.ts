export type TimelineRole = 'generated' | 'approved' | 'head'

export interface TimelineCommitLike { sha: string }

export interface TimelineGroup {
  sha: string
  roles: TimelineRole[]
  pos: number
}

export interface ReviewTimelineInput {
  headSha: string
  commits: readonly TimelineCommitLike[]
  generatedSha?: string
  approvedSha?: string
  approvedShas?: readonly string[]
  commitApproved: boolean
}

export function commitTimelinePosition(headSha: string, commits: readonly TimelineCommitLike[], sha: string): number | null {
  if (sha === headSha) return 0
  const i = commits.findIndex((c) => c.sha === sha)
  return i >= 0 ? i : null
}

export function timelineShaInRange(headSha: string, commits: readonly TimelineCommitLike[], sha: string | undefined): sha is string {
  return Boolean(sha && commitTimelinePosition(headSha, commits, sha) !== null)
}

export function reviewTimelineGroups(input: ReviewTimelineInput): TimelineGroup[] {
  const grouped = new Map<string, TimelineGroup>()
  const add = (sha: string | undefined, role: TimelineRole): void => {
    if (!sha) return
    const pos = commitTimelinePosition(input.headSha, input.commits, sha)
    if (pos === null) return
    const group = grouped.get(sha) ?? { sha, roles: [], pos }
    if (!group.roles.includes(role)) group.roles.push(role)
    grouped.set(sha, group)
  }

  const approvedInRange = (input.approvedShas ?? (input.approvedSha ? [input.approvedSha] : []))
    .map((sha) => ({ sha, pos: commitTimelinePosition(input.headSha, input.commits, sha) }))
    .filter((item): item is { sha: string; pos: number } => item.pos !== null)
    .sort((a, b) => a.pos - b.pos)[0]?.sha

  add(input.generatedSha, 'generated')
  add(input.commitApproved ? input.headSha : approvedInRange, 'approved')
  add(input.headSha, 'head')

  return [...grouped.values()].sort((a, b) => b.pos - a.pos)
}
