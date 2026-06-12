import { useStore } from '../store'
import type { PinNode, RepoStatus } from '../../shared/types'

export interface FlatRow { absPath: string; node: PinNode; pinPath: string }

/** Pure flatten of the repos visible under one pin, in the same DFS order
 *  RepoTree renders them. The Dashboard builds the keyboard-nav list from this
 *  (a pure function — safe under StrictMode double-rendering, unlike pushing
 *  into an array during render). */
export function visiblePinRepos(pinPath: string, node: PinNode, filter: string): FlatRow[] {
  const f = filter.toLowerCase()
  const out: FlatRow[] = []
  const walk = (n: PinNode): void => {
    if (n.kind === 'repo') {
      if (!f || n.name.toLowerCase().includes(f) || n.relPath.toLowerCase().includes(f)) {
        out.push({ absPath: n.relPath ? `${pinPath}/${n.relPath}` : pinPath, node: n, pinPath })
      }
      return
    }
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** Collapse single-child non-repo chains into one label like 'clients/acme/'. */
function chainLabel(node: PinNode): { label: string; tail: PinNode } {
  let label = node.name
  let tail = node
  while (
    tail.kind === 'dir' &&
    !tail.empty &&
    !tail.error &&
    tail.children.length === 1 &&
    tail.children[0].kind === 'dir' &&
    !tail.children[0].empty &&
    !tail.children[0].error
  ) {
    tail = tail.children[0]
    label += '/' + tail.name
  }
  return { label: label + '/', tail }
}

function matches(node: PinNode, filter: string): boolean {
  const f = filter.toLowerCase()
  if (node.kind === 'repo') return node.name.toLowerCase().includes(f) || node.relPath.toLowerCase().includes(f)
  return node.children.some((c) => matches(c, filter))
}

/** Renders one pin's tree. `indexOf` maps a repo's absolute path to its index
 *  in the Dashboard's flattened visible list (built with visiblePinRepos), so
 *  the `sel` highlight and click/⏎ stay consistent with keyboard order. */
export function RepoTree({ pinPath, node, filter, indexOf, statuses, depth = 0 }: {
  pinPath: string
  node: PinNode
  filter: string
  indexOf: (absPath: string) => number
  statuses: Record<string, RepoStatus>
  depth?: number
}) {
  const { sel, enterCompare } = useStore()

  // Root node (relPath === '' and kind === 'dir'): skip the root's own dir row
  // since the pin header already shows the path. Render children directly.
  if (node.relPath === '' && node.kind === 'dir') {
    if (node.empty) {
      return <div className="lr-row empty"><span className="r-name">no repos found in this directory</span></div>
    }
    return (
      <>
        {node.children.map((c, i) => (
          <RepoTree
            key={c.relPath || i}
            pinPath={pinPath}
            node={c}
            filter={filter}
            indexOf={indexOf}
            statuses={statuses}
            depth={0}
          />
        ))}
      </>
    )
  }

  if (filter && !matches(node, filter)) return null

  if (node.kind === 'repo') {
    const absPath = node.relPath ? `${pinPath}/${node.relPath}` : pinPath
    const myIndex = indexOf(absPath)
    const st = statuses[absPath]
    const slash = node.relPath.lastIndexOf('/')
    const parent = slash >= 0 ? node.relPath.slice(0, slash + 1) : ''
    return (
      <div
        className={'lr-row' + (sel === myIndex ? ' sel' : '')}
        style={{ marginLeft: depth * 14 }}
        onClick={() => void enterCompare(absPath)}
      >
        <span className="r-name">{node.name}</span>
        {parent && <span className="r-parent">{parent}</span>}
        <span className="grow" />
        <span className="lr-chip">{st ? st.branch : '…'}</span>
        <span className={'lr-dirty ' + (st ? (st.dirty ? 'on' : 'off') : 'off')} title={st?.dirty ? 'uncommitted changes' : 'clean'} />
      </div>
    )
  }

  if (node.error) {
    return (
      <div className="lr-row errrow" style={{ marginLeft: depth * 14 }} title="could not read this directory">
        <span className="r-name">{node.name}/</span>
        <span className="grow" />
        <span className="r-warn">⚠ unreadable</span>
      </div>
    )
  }

  if (node.empty) {
    return (
      <div className="lr-row empty" style={{ marginLeft: depth * 14 }} title="no repos inside">
        <span className="r-name">{node.name}/</span>
      </div>
    )
  }

  // collapse single-child dir chains into one structural label
  const { label, tail } = chainLabel(node)
  return (
    <>
      <div className="lr-row dir" style={{ marginLeft: depth * 14 }}>
        <span className="r-name">{label}</span>
      </div>
      {tail.children.map((c, i) => (
        <RepoTree
          key={c.relPath || i}
          pinPath={pinPath}
          node={c}
          filter={filter}
          indexOf={indexOf}
          statuses={statuses}
          depth={depth + 1}
        />
      ))}
    </>
  )
}
