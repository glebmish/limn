import { describe, expect, it } from 'vitest'
import { OperationCoordinator } from '../src/server/operations'
import { CancelledError } from '../src/server/engines/errors'

describe('OperationCoordinator', () => {
  it('serializes operations per repository through ONE FIFO queue — a second op waits, never fails busy', async () => {
    const ops = new OperationCoordinator()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = ops.run('one', '/repo', async () => { await held; order.push('one'); return 1 }, { label: 'Generating the review' })
    const second = ops.run('two', '/repo', async () => { order.push('two'); return 2 }, { label: 'Simplify' })
    const third = ops.run('three', '/repo', async () => { order.push('three'); return 3 }, { label: 'Chat' })
    await Promise.resolve()
    expect(ops.repoBusy('/repo')).toBe(true)
    expect(ops.holder('/repo')).toEqual({ opId: 'one', label: 'Generating the review' })
    expect(ops.queued('/repo')).toEqual([{ opId: 'two', label: 'Simplify' }, { opId: 'three', label: 'Chat' }])
    // another repo is its own queue
    expect(await ops.run('elsewhere', '/other', async () => 'x')).toMatchObject({ status: 'succeeded', value: 'x' })
    release()
    expect(await first).toMatchObject({ status: 'succeeded', value: 1 })
    expect(await second).toMatchObject({ status: 'succeeded', value: 2 })
    expect(await third).toMatchObject({ status: 'succeeded', value: 3 })
    expect(order).toEqual(['one', 'two', 'three'])
    expect(ops.repoBusy('/repo')).toBe(false)
    expect(ops.holder('/repo')).toBeNull()
    expect(ops.queued('/repo')).toEqual([])
  })

  it('cancelling a QUEUED op removes it from the queue without running it; the rest keep their order', async () => {
    const ops = new OperationCoordinator()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let ran = false
    const first = ops.run('one', '/repo', async () => { await held; return 1 })
    const second = ops.run('two', '/repo', async () => { ran = true; return 2 })
    const third = ops.run('three', '/repo', async () => 3)
    await Promise.resolve()
    ops.cancel('two')
    expect((await second).status).toBe('cancelled')
    expect(ops.queued('/repo')).toEqual([{ opId: 'three', label: 'three' }])
    release()
    await first
    expect(await third).toMatchObject({ status: 'succeeded', value: 3 })
    expect(ran).toBe(false)
  })

  it('notifies listeners on every queue change, with the repo', async () => {
    const ops = new OperationCoordinator()
    const seen: string[] = []
    const off = ops.onQueueChange((repo) => { seen.push(`${repo}:${ops.holder(repo)?.opId ?? '-'}:${ops.queued(repo).map((q) => q.opId).join(',')}`) })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = ops.run('one', '/repo', async () => { await held; return 1 })
    const second = ops.run('two', '/repo', async () => 2)
    await Promise.resolve()
    release()
    await first; await second
    expect(seen).toEqual(['/repo:one:', '/repo:one:two', '/repo:two:', '/repo:-:'])
    off()
    await ops.run('three', '/repo', async () => 3)
    expect(seen).toHaveLength(4)
  })

  it('a failed or cancelled op releases the lane to the next in line', async () => {
    const ops = new OperationCoordinator()
    const first = ops.run('one', '/repo', async () => { throw new Error('boom') })
    const second = ops.run('two', '/repo', async () => 2)
    expect((await first).status).toBe('failed')
    expect(await second).toMatchObject({ status: 'succeeded', value: 2 })
  })
})


  it('classifies pre-start and active cancellation without parsing in callers', async () => {
    const ops = new OperationCoordinator()
    ops.cancel('early')
    expect((await ops.run('early', '/a', async () => 1)).status).toBe('cancelled')

    let cancelled = false
    const running = ops.run('active', '/b', async () => {
      ops.registerCancel('active', () => { cancelled = true })
      await new Promise((resolve) => setTimeout(resolve, 5))
      ops.throwIfCancelled('active')
    })
    ops.cancel('active')
    expect((await running).status).toBe('cancelled')
    expect(cancelled).toBe(true)
  })

  it('classifies cancellation by TYPE, never by message text', async () => {
    const ops = new OperationCoordinator()
    // the typed engine cancel and a genuine AbortError both settle as cancelled…
    expect((await ops.run('c1', '/a', async () => { throw new CancelledError() })).status).toBe('cancelled')
    expect((await ops.run('c2', '/a', async () => { throw new DOMException('cancelled', 'AbortError') })).status).toBe('cancelled')
    // …but a genuine failure whose MESSAGE merely contains "aborted"/"cancelled"
    // (e.g. an adapter's stderr tail) stays a failure — no silent turn-vanishing.
    expect((await ops.run('f1', '/a', async () => { throw new Error('request aborted by server') })).status).toBe('failed')
    expect((await ops.run('f2', '/a', async () => { throw new Error('upstream job was cancelled by the scheduler') })).status).toBe('failed')
  })

