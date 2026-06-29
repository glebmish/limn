import type { FileDiff } from '../../shared/types'

export interface FileTreeDir {
  name: string
  path: string
  dirs: Map<string, FileTreeDir>
  files: FileDiff[]
}

export function emptyFileTreeDir(name = '', path = ''): FileTreeDir {
  return { name, path, dirs: new Map(), files: [] }
}

export function buildFileTree(files: readonly FileDiff[]): FileTreeDir {
  const root = emptyFileTreeDir()
  for (const f of files) {
    const parts = f.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}${part}/` : `${part}/`
      let child = dir.dirs.get(part)
      if (!child) {
        child = emptyFileTreeDir(part, path)
        dir.dirs.set(part, child)
      }
      dir = child
    }
    dir.files.push(f)
  }
  return root
}

export function flattenFileTree(dir: FileTreeDir): FileDiff[] {
  return [
    ...[...dir.dirs.values()].flatMap((child) => flattenFileTree(child)),
    ...dir.files
  ]
}

export function filesInPathOrder(files: readonly FileDiff[], paths: readonly string[]): FileDiff[] {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const seen = new Set<string>()
  const out: FileDiff[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    const file = byPath.get(path)
    if (!file) continue
    seen.add(path)
    out.push(file)
  }
  return out
}

export function orderFilesForReview(files: readonly FileDiff[], explicitPaths?: readonly string[]): FileDiff[] {
  return explicitPaths ? filesInPathOrder(files, explicitPaths) : flattenFileTree(buildFileTree(files))
}
