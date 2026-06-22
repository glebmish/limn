import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db.js'
import { listPins, addPin, removePin, getScanCache, setScanCache } from '../src/main/db/pins.js'
import type { PinNode } from '../src/shared/types.js'

let db: DatabaseSync
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-pins-')), 'db')).db
})

const tree: PinNode = { name: 'work', relPath: '', kind: 'dir', children: [
  { name: 'app', relPath: 'app', kind: 'repo', children: [] }
] }

describe('pins DAO', () => {
  it('adds pins with incrementing positions, lists them in order', () => {
    addPin(db, '/work/a')
    addPin(db, '/work/b')
    const pins = listPins(db)
    expect(pins.map((p) => p.path)).toEqual(['/work/a', '/work/b'])
    expect(pins[0].position).toBeLessThan(pins[1].position)
    expect(pins[0].id).toBeGreaterThan(0)
    expect(typeof pins[0].createdAt).toBe('string')
  })

  it('rejects a duplicate pin path with a friendly error', () => {
    addPin(db, '/work/a')
    expect(() => addPin(db, '/work/a')).toThrow(/already pinned/)
  })

  it('removePin deletes the pin (scan_cache cascades)', () => {
    const id = addPin(db, '/work/a')
    setScanCache(db, id, tree)
    removePin(db, id)
    expect(listPins(db)).toEqual([])
    expect(getScanCache(db, id)).toBeNull()
  })

  it('scan cache round-trips the tree and a scannedAt timestamp', () => {
    const id = addPin(db, '/work/a')
    expect(getScanCache(db, id)).toBeNull()
    setScanCache(db, id, tree)
    const cached = getScanCache(db, id)!
    expect(cached.tree).toEqual(tree)
    expect(typeof cached.scannedAt).toBe('string')
  })

  it('setScanCache replaces an existing cache for the same pin', () => {
    const id = addPin(db, '/work/a')
    setScanCache(db, id, tree)
    const tree2: PinNode = { name: 'work', relPath: '', kind: 'dir', children: [] }
    setScanCache(db, id, tree2)
    expect(getScanCache(db, id)!.tree).toEqual(tree2)
  })

  it('corrupt cache JSON degrades to null instead of throwing', () => {
    const id = addPin(db, '/work/a')
    db.prepare('INSERT INTO scan_cache (pin_id, tree_json, scanned_at) VALUES (?, ?, ?)')
      .run(id, '{ not json', new Date().toISOString())
    expect(getScanCache(db, id)).toBeNull()
  })
})
