import type { FileDiff, ViewMark } from '../../shared/types'
import { fileViewed } from '../store'

export type ReviewGlyphStatus = 'st-unrev' | 'st-rev' | 'st-amber' | 'st-risk'

export function reviewStatusForFile(f: FileDiff, viewedAt: Record<string, ViewMark>, headSha?: string): ReviewGlyphStatus {
  if (fileViewed(f, viewedAt, headSha)) return 'st-rev'
  // a file that carries a viewed mark but no longer counts as viewed has changed
  // since you last looked — the amber `~` middle ground, not a plain unviewed file.
  if (viewedAt[f.path]) return 'st-amber'
  return 'st-unrev'
}

export function combineReviewStatuses(statuses: ReviewGlyphStatus[]): ReviewGlyphStatus {
  if (statuses.length > 0 && statuses.every((s) => s === 'st-rev')) return 'st-rev'
  // any changed-since-viewed child surfaces amber on the folder: there's reviewed
  // work that drifted and needs another look, which outranks merely-unviewed.
  if (statuses.some((s) => s === 'st-amber')) return 'st-amber'
  return 'st-unrev'
}

export function reviewStatusLabel(status: ReviewGlyphStatus): string {
  return status === 'st-risk' ? 'deleted'
    : status === 'st-amber' ? 'changed'
    : status === 'st-rev' ? 'viewed'
    : 'unviewed'
}
