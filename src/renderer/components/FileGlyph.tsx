import type { ReviewGlyphStatus } from '../lib/fileStatus'

function classes(kind: 'file' | 'folder', status: ReviewGlyphStatus, className?: string): string {
  return ['ficon', 'review-glyph', `${kind}-glyph`, status, className].filter(Boolean).join(' ')
}

const folderPath = 'M1.8 11.4V4.6a.8.8 0 0 1 .8-.8h2.7l1.2 1.5h4.9a.8.8 0 0 1 .8.8v5.3a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z'

export function FileGlyph({ status, className }: { status: ReviewGlyphStatus; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={classes('file', status, className)} aria-hidden="true">
      <path d="M13.5 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7.5L13.5 2z" />
    </svg>
  )
}

export function FolderGlyph({ status, className }: { status: ReviewGlyphStatus; className?: string }) {
  if (status === 'st-rev') {
    return (
      <svg viewBox="0 0 14 14" fill="currentColor" className={classes('folder', status, className)} aria-hidden="true">
        <path d={folderPath} />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" className={classes('folder', status, className)} aria-hidden="true">
      <path d={folderPath} />
    </svg>
  )
}
