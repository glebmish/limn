import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanPin } from '../src/main/scan'
import type { PinNode } from '../src/shared/types'

let root: string
const chmodded: string[] = []

function mkrepo(rel: string): void {
  fs.mkdirSync(path.join(root, rel, '.git'), { recursive: true })
}
function mkdir(rel: string): void {
  fs.mkdirSync(path.join(root, rel), { recursive: true })
}

function find(node: PinNode, relPath: string): PinNode | null {
  if (node.relPath === relPath) return node
  for (const c of node.children) {
    const hit = find(c, relPath)
    if (hit) return hit
  }
  return null
}
function allRepoPaths(node: PinNode): string[] {
  const out: string[] = []
  const walk = (n: PinNode): void => {
    if (n.kind === 'repo' && n.relPath !== '') out.push(n.relPath)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-scan-'))
})
afterEach(() => {
  for (const p of chmodded.splice(0)) {
    try { fs.chmodSync(p, 0o755) } catch { /* already restored */ }
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('scanPin', () => {
  it('finds a repo nested at depth 3, sorts repos before dirs alphabetically', () => {
    mkrepo('clients/acme/web')
    mkdir('clients/acme/empty')        // no repos under here
    mkrepo('libs/util')
    const tree = scanPin(root)
    expect(tree.relPath).toBe('')
    expect(tree.name).toBe(path.basename(root))
    expect(allRepoPaths(tree).sort()).toEqual(['clients/acme/web', 'libs/util'])
    // top level: 'clients' and 'libs' are dirs, alphabetical
    expect(tree.children.map((c) => c.name)).toEqual(['clients', 'libs'])
  })

  it('does not descend into node_modules or other ignored dirs', () => {
    mkdir('node_modules')
    mkrepo('node_modules/sneaky')       // a repo inside node_modules — must NOT appear
    mkrepo('real')
    const tree = scanPin(root)
    expect(allRepoPaths(tree)).toEqual(['real'])
    expect(find(tree, 'node_modules')).toBeNull()
  })

  it('does not descend past a .git boundary (nested repos are not listed)', () => {
    mkrepo('outer')
    mkrepo('outer/inner')               // repo inside a repo — must NOT appear
    const tree = scanPin(root)
    expect(allRepoPaths(tree)).toEqual(['outer'])
    const outer = find(tree, 'outer')!
    expect(outer.kind).toBe('repo')
    expect(outer.children).toEqual([])
  })

  it('collapses a repo-less branch of dirs to a single empty node', () => {
    mkdir('docs/guides/internal')       // no repos anywhere under docs
    mkrepo('app')
    const tree = scanPin(root)
    const docs = find(tree, 'docs')!
    expect(docs.kind).toBe('dir')
    expect(docs.empty).toBe(true)
    expect(docs.children).toEqual([])
  })

  it('marks dirs at maxDepth with unscanned depths below as empty (approximation)', () => {
    mkrepo('a/b/c/d/deep')              // repo at depth 5, beyond default maxDepth 4
    const tree = scanPin(root, 4)
    // the deep repo is not discovered, so its whole branch collapses to empty
    expect(allRepoPaths(tree)).toEqual([])
    const a = find(tree, 'a')!
    expect(a.empty).toBe(true)
  })

  it('skips hidden dirs', () => {
    mkrepo('.hidden/repo')
    mkrepo('visible')
    const tree = scanPin(root)
    expect(allRepoPaths(tree)).toEqual(['visible'])
  })

  it('root that is itself a repo is a childless repo node', () => {
    fs.mkdirSync(path.join(root, '.git'))
    mkrepo('child')                     // ignored — scan stops at the root .git boundary
    const tree = scanPin(root)
    expect(tree.kind).toBe('repo')
    expect(tree.relPath).toBe('')
    expect(tree.children).toEqual([])
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'marks an unreadable dir with error:true', () => {
      mkdir('locked')
      const locked = path.join(root, 'locked')
      fs.chmodSync(locked, 0o000)
      chmodded.push(locked)
      const tree = scanPin(root)
      const node = find(tree, 'locked')!
      expect(node.error).toBe(true)
      expect(node.children).toEqual([])
    }
  )

  it('orders a repo before a dir sibling regardless of alphabet', () => {
    mkrepo('zebra-repo')
    mkrepo('apps/inner')
    const tree = scanPin(root)
    expect(tree.children.map((c) => `${c.kind}:${c.name}`)).toEqual(['repo:zebra-repo', 'dir:apps'])
  })

  it.runIf(process.platform !== 'win32')('follows symlinked directories to find repos', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-scan-target-'))
    fs.mkdirSync(path.join(target, 'linked-repo', '.git'), { recursive: true })
    fs.symlinkSync(target, path.join(root, 'link'))
    const tree = scanPin(root)
    expect(allRepoPaths(tree)).toEqual(['link/linked-repo'])
    fs.rmSync(target, { recursive: true, force: true })
  })
})
