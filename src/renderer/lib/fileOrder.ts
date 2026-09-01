import type { FileDiff, Section } from '../../shared/types'

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

export function groupByDir<T extends { path: string }>(files: readonly T[]): { dir: string; files: T[] }[] {
  const order: { dir: string; files: T[] }[] = []
  const groups = new Map<string, { dir: string; files: T[] }>()
  for (const f of files) {
    const slash = f.path.lastIndexOf('/')
    const dir = slash === -1 ? '' : f.path.slice(0, slash + 1)
    let group = groups.get(dir)
    if (!group) {
      group = { dir, files: [] }
      groups.set(dir, group)
      order.push(group)
    }
    group.files.push(f)
  }
  return order
}

/** path → id of the first section that lists it. Sections own disjoint file sets in
 *  practice, but a path listed twice belongs to the section the reviewer meets first,
 *  which is where a jump should land. Paths no section claims (working-tree extras)
 *  are simply absent. */
export function sectionIndex(sections: readonly Section[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const s of sections) {
    for (const path of s.files) if (!index.has(path)) index.set(path, s.id)
  }
  return index
}
