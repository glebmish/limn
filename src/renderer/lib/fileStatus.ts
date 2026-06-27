import type { FileDiff, ViewMark } from '../../shared/types'
import { fileViewed } from '../store'

export type ReviewGlyphStatus = 'st-unrev' | 'st-rev' | 'st-amber' | 'st-risk'

export function reviewStatusForFile(f: FileDiff, viewedAt: Record<string, ViewMark>): ReviewGlyphStatus {
  return fileViewed(f, viewedAt) ? 'st-rev' : 'st-unrev'
}

export function combineReviewStatuses(statuses: ReviewGlyphStatus[]): ReviewGlyphStatus {
  if (statuses.length > 0 && statuses.every((s) => s === 'st-rev')) return 'st-rev'
  return 'st-unrev'
}

export function reviewStatusLabel(status: ReviewGlyphStatus): string {
  return status === 'st-risk' ? 'deleted'
    : status === 'st-amber' ? 'changed'
    : status === 'st-rev' ? 'viewed'
    : 'unviewed'
}
