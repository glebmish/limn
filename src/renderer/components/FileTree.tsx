import { useMemo, useState, type ReactNode } from 'react'
import { isUncommittedOrigin, type FileDiff, type ViewMark } from '../../shared/types'
import { clickable } from '../lib/clickable'
import { buildFileTree, type FileTreeDir } from '../lib/fileOrder'
import { combineReviewStatuses, reviewStatusForFile, reviewStatusLabel, type ReviewGlyphStatus } from '../lib/fileStatus'
import { FileGlyph, FolderGlyph } from './FileGlyph'

function countFiles(dir: FileTreeDir): number {
  let n = dir.files.length
  for (const child of dir.dirs.values()) n += countFiles(child)
  return n
}

function dirStatus(dir: FileTreeDir, viewedAt: Record<string, ViewMark>, headSha?: string): ReviewGlyphStatus {
  const statuses = [
    ...dir.files.map((f) => reviewStatusForFile(f, viewedAt, headSha)),
    ...[...dir.dirs.values()].map((child) => dirStatus(child, viewedAt, headSha))
  ]
  return combineReviewStatuses(statuses)
}

function DirNode({ dir, collapsed, toggle, status, children }: {
  dir: FileTreeDir
  collapsed: Set<string>
  toggle: (path: string) => void
  status: ReviewGlyphStatus
  children: ReactNode
}) {
  const isCollapsed = collapsed.has(dir.path)
  const label = reviewStatusLabel(status)
  return (
    <div className={'gnav-dir' + (isCollapsed ? ' collapsed' : '')}>
      <div className="gnav-folder" {...clickable(() => toggle(dir.path), { expanded: !isCollapsed })} title={`${dir.path} · ${label}`}>
        <span className="gnav-caret"></span>
        <FolderGlyph status={status} />
        <span className="fname">{dir.name}</span>
        <span className="fcount">{countFiles(dir)}</span>
      </div>
      <div className="gnav-kids">{children}</div>
    </div>
  )
}

export function FileTree({ files, viewedAt, headSha, currentFile, onFileClick, className, order = 'tree' }: {
  files: FileDiff[]
  viewedAt: Record<string, ViewMark>
  headSha?: string
  currentFile: string | null
  onFileClick: (path: string, file: FileDiff) => void
  className?: string
  order?: 'tree' | 'explicit'
}) {
  const tree = useMemo(() => buildFileTree(files), [files])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderFiles = (items: FileDiff[]): ReactNode => (
    <>
      {items.map((f) => {
        const name = f.path.split('/').pop() ?? f.path
        const stat = reviewStatusForFile(f, viewedAt, headSha)
        // status as text too — the glyph is otherwise color-only (invisible to AT
        // and to colorblind users); this enriches the row's accessible name + tooltip.
        const label = reviewStatusLabel(stat)
        const uncommitted = f.hunks.some((h) => h.lines.some((l) => isUncommittedOrigin(l.origin)))
        return (
          <div
            key={f.path}
            className={'gnav-file' + (currentFile === f.path ? ' cur' : '')}
            title={`${f.path} · ${label}${uncommitted ? ' · uncommitted edits' : ''}`}
            {...clickable(() => onFileClick(f.path, f))}
          >
            <FileGlyph status={stat} />
            <span className="nm">{name}</span>
            {uncommitted && <span className="gnav-dirty" title="uncommitted working-tree edits" />}
          </div>
        )
      })}
    </>
  )

  const renderDir = (dir: FileTreeDir): ReactNode => (
    <>
      {[...dir.dirs.values()].map((child) => (
        <DirNode key={child.path} dir={child} collapsed={collapsed} toggle={toggle} status={dirStatus(child, viewedAt, headSha)}>
          {renderDir(child)}
        </DirNode>
      ))}
      {renderFiles(dir.files)}
    </>
  )

  return <div className={'gnav-tree' + (className ? ' ' + className : '')}>{order === 'explicit' ? renderFiles(files) : renderDir(tree)}</div>
}
