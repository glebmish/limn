import { describe, expect, it } from 'vitest'
import { OperationCoordinator, RepoBusyError } from '../src/main/operations'

describe('OperationCoordinator', () => {
  it('serializes operations per repository and releases the lock', async () => {
    const ops = new OperationCoordinator()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = ops.run('one', '/repo', async () => { await held; return 1 })
    const busy = await ops.run('two', '/repo', async () => 2)
    expect(busy.status).toBe('failed')
    if (busy.status !== 'succeeded') expect(busy.error).toBeInstanceOf(RepoBusyError)
    release()
    expect(await first).toMatchObject({ status: 'succeeded', value: 1 })
    expect(await ops.run('three', '/repo', async () => 3)).toMatchObject({ status: 'succeeded', value: 3 })
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
})
