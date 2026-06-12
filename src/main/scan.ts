import fs from 'node:fs'
import path from 'node:path'
import type { PinNode } from '../shared/types.js'

/** Child names never descended into (hidden dirs handled separately). */
const IGNORED = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out'])

/** A directory is a repo iff it contains a `.git` entry (dir OR file — worktrees
 *  and submodules use a `.git` file). */
function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

/** Synchronous fs walk of a pinned directory into a PinNode tree.
 *  - repos are leaves (we never cross a .git boundary looking for more);
 *  - hidden ('.') and IGNORED child names are skipped;
 *  - a dir whose visible subtree contains no repos collapses to empty:true with
 *    no children; an unreadable dir becomes error:true with no children;
 *  - children sort repos-first then dirs, alphabetical within each group;
 *  - symlinked directories are followed (cycle-safe: recursion is bounded by maxDepth). */
export function scanPin(root: string, maxDepth = 4): PinNode {
  return scanDir(root, path.basename(root), '', 0, maxDepth)
}

function scanDir(abs: string, name: string, relPath: string, depth: number, maxDepth: number): PinNode {
  if (isRepo(abs)) return { name, relPath, kind: 'repo', children: [] }

  // Beyond maxDepth we stop recursing. We cannot know whether repos live below,
  // so we treat the branch as empty (acceptable approximation — spec fixes
  // depth at 4 for now). Marking empty keeps it collapsed and out of the way
  // rather than promising children we never scanned.
  if (depth >= maxDepth) return { name, relPath, kind: 'dir', empty: true, children: [] }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return { name, relPath, kind: 'dir', error: true, children: [] }
  }

  const children: PinNode[] = []
  for (const ent of entries) {
    let isDir = ent.isDirectory()
    if (!isDir && ent.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(abs, ent.name)).isDirectory() } catch { /* broken link — skip */ }
    }
    if (!isDir) continue
    if (ent.name.startsWith('.')) continue
    if (IGNORED.has(ent.name)) continue
    const childRel = relPath ? `${relPath}/${ent.name}` : ent.name
    children.push(scanDir(path.join(abs, ent.name), ent.name, childRel, depth + 1, maxDepth))
  }

  // A dir is marked empty when its entire subtree contains no repos or errors.
  // Empty non-root dirs collapse to children:[] (render dimmed/collapsed in UI).
  // The root (depth===0) always retains its direct children so the UI can show
  // them even when the whole pin contains no repos yet.
  const hasAny = children.some(hasRepoOrError)
  if (!hasAny && depth > 0) return { name, relPath, kind: 'dir', empty: true, children: [] }
  if (!hasAny) return { name, relPath, kind: 'dir', empty: true, children: children.sort(compareNodes) }
  return { name, relPath, kind: 'dir', children: children.sort(compareNodes) }
}

function hasRepoOrError(node: PinNode): boolean {
  if (node.kind === 'repo') return true
  if (node.error) return true
  if (node.empty) return false
  return node.children.some(hasRepoOrError)
}

/** repos before dirs; alphabetical (case-insensitive) within each group. */
function compareNodes(a: PinNode, b: PinNode): number {
  if (a.kind !== b.kind) return a.kind === 'repo' ? -1 : 1
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
}
