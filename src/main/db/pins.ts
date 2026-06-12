import type { DatabaseSync } from 'node:sqlite'
import type { PinNode } from '../../shared/types.js'

function now(): string { return new Date().toISOString() }

export interface PinRow { id: number; path: string; position: number; createdAt: string }

export function listPins(db: DatabaseSync): PinRow[] {
  return (db.prepare(
    'SELECT id, path, position, created_at FROM pinned_dirs ORDER BY position'
  ).all() as { id: number; path: string; position: number; created_at: string }[])
    .map((r) => ({ id: r.id, path: r.path, position: r.position, createdAt: r.created_at }))
}

/** Pin a directory at the end of the list. Rejects an already-pinned path
 *  (the UNIQUE constraint surfaces as a friendly error). Returns the new id. */
export function addPin(db: DatabaseSync, dirPath: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM pinned_dirs').get() as { m: number }
  try {
    const res = db.prepare('INSERT INTO pinned_dirs (path, position, created_at) VALUES (?, ?, ?)')
      .run(dirPath, row.m + 1, now())
    return Number(res.lastInsertRowid)
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new Error(`${dirPath} is already pinned`)
    throw err
  }
}

export function removePin(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM pinned_dirs WHERE id = ?').run(id)
}

export function getScanCache(db: DatabaseSync, pinId: number): { tree: PinNode; scannedAt: string } | null {
  const row = db.prepare('SELECT tree_json, scanned_at FROM scan_cache WHERE pin_id = ?')
    .get(pinId) as { tree_json: string; scanned_at: string } | undefined
  if (!row) return null
  try {
    return { tree: JSON.parse(row.tree_json) as PinNode, scannedAt: row.scanned_at }
  } catch (err) {
    // a corrupt cache row must degrade to a rescan, never crash the dashboard
    console.warn(`[pins] corrupt scan cache for pin ${pinId}, ignoring:`, err)
    return null
  }
}

export function setScanCache(db: DatabaseSync, pinId: number, tree: PinNode): void {
  db.prepare(`INSERT INTO scan_cache (pin_id, tree_json, scanned_at) VALUES (?, ?, ?)
    ON CONFLICT(pin_id) DO UPDATE SET tree_json = excluded.tree_json, scanned_at = excluded.scanned_at`)
    .run(pinId, JSON.stringify(tree), now())
}
