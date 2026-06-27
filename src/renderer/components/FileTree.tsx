import { useMemo, useState, type ReactNode } from 'react'
import type { FileDiff, ViewMark } from '../../shared/types'
import { clickable } from '../lib/clickable'
import { combineReviewStatuses, reviewStatusForFile, reviewStatusLabel, type ReviewGlyphStatus } from '../lib/fileStatus'
import { FileGlyph, FolderGlyph } from './FileGlyph'

interface TreeDir {
  name: string
  path: string
  dirs: Map<string, TreeDir>
  files: FileDiff[]
}

function emptyDir(name = '', path = ''): TreeDir {
  return { name, path, dirs: new Map(), files: [] }
}

function buildTree(files: FileDiff[]): TreeDir {
  const root = emptyDir()
  for (const f of files) {
    const parts = f.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}${part}/` : `${part}/`
      let child = dir.dirs.get(part)
      if (!child) {
        child = emptyDir(part, path)
        dir.dirs.set(part, child)
      }
      dir = child
    }
    dir.files.push(f)
  }
  return root
}

function countFiles(dir: TreeDir): number {
  let n = dir.files.length
  for (const child of dir.dirs.values()) n += countFiles(child)
  return n
}

function dirStatus(dir: TreeDir, viewedAt: Record<string, ViewMark>): ReviewGlyphStatus {
  const statuses = [
    ...dir.files.map((f) => reviewStatusForFile(f, viewedAt)),
    ...[...dir.dirs.values()].map((child) => dirStatus(child, viewedAt))
  ]
  return combineReviewStatuses(statuses)
}

function DirNode({ dir, collapsed, toggle, status, children }: {
  dir: TreeDir
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

export function FileTree({ files, viewedAt, currentFile, onFileClick, className }: {
  files: FileDiff[]
  viewedAt: Record<string, ViewMark>
  currentFile: string | null
  onFileClick: (path: string, file: FileDiff) => void
  className?: string
}) {
  const tree = useMemo(() => buildTree(files), [files])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderDir = (dir: TreeDir): ReactNode => (
    <>
      {[...dir.dirs.values()].map((child) => (
        <DirNode key={child.path} dir={child} collapsed={collapsed} toggle={toggle} status={dirStatus(child, viewedAt)}>
          {renderDir(child)}
        </DirNode>
      ))}
      {dir.files.map((f) => {
        const name = f.path.split('/').pop() ?? f.path
        const stat = reviewStatusForFile(f, viewedAt)
        // status as text too — the glyph is otherwise color-only (invisible to AT
        // and to colorblind users); this enriches the row's accessible name + tooltip.
        const label = reviewStatusLabel(stat)
        return (
          <div
            key={f.path}
            className={'gnav-file' + (currentFile === f.path ? ' cur' : '')}
            title={`${f.path} · ${label}`}
            {...clickable(() => onFileClick(f.path, f))}
          >
            <FileGlyph status={stat} />
            <span className="nm">{name}</span>
          </div>
        )
      })}
    </>
  )

  return <div className={'gnav-tree' + (className ? ' ' + className : '')}>{renderDir(tree)}</div>
}
