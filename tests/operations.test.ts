import { describe, expect, it } from 'vitest'
import { OperationCoordinator, RepoBusyError } from '../src/main/operations'
import { CancelledError } from '../src/main/engines/errors'

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

  it('runs a shared op alongside an exclusive one, but caps the shared lane at one', async () => {
    const ops = new OperationCoordinator()
    let releaseExcl!: () => void
    const exclHeld = new Promise<void>((r) => { releaseExcl = r })
    let releaseShared!: () => void
    const sharedHeld = new Promise<void>((r) => { releaseShared = r })

    const excl = ops.run('gen', '/repo', async () => { await exclHeld; return 'gen' })
    // shared coexists with the running exclusive op
    const shared = ops.runShared('chat', '/repo', async () => { await sharedHeld; return 'chat' })
    // a second shared op is rejected as a shared-lane busy
    const shared2 = await ops.runShared('chat2', '/repo', async () => 'chat2')
    expect(shared2.status).toBe('failed')
    if (shared2.status !== 'succeeded') {
      expect(shared2.error).toBeInstanceOf(RepoBusyError)
      expect((shared2.error as RepoBusyError).lane).toBe('shared')
    }

    releaseShared(); releaseExcl()
    expect(await shared).toMatchObject({ status: 'succeeded', value: 'chat' })
    expect(await excl).toMatchObject({ status: 'succeeded', value: 'gen' })
  })

  it('lets an exclusive op start while only a shared op is running (OQ3)', async () => {
    const ops = new OperationCoordinator()
    let releaseShared!: () => void
    const sharedHeld = new Promise<void>((r) => { releaseShared = r })
    const shared = ops.runShared('chat', '/repo', async () => { await sharedHeld; return 'chat' })
    // exclusive lane is free even though a shared op holds the repo
    const excl = await ops.run('gen', '/repo', async () => 'gen')
    expect(excl).toMatchObject({ status: 'succeeded', value: 'gen' })
    releaseShared()
    expect(await shared).toMatchObject({ status: 'succeeded', value: 'chat' })
  })

  it('repoBusy tracks the exclusive lane only; lanes release independently', async () => {
    const ops = new OperationCoordinator()
    let releaseShared!: () => void
    const sharedHeld = new Promise<void>((r) => { releaseShared = r })
    const shared = ops.runShared('chat', '/repo', async () => { await sharedHeld; return 'chat' })
    await Promise.resolve()
    expect(ops.repoBusy('/repo')).toBe(false) // shared op does not mark the repo busy

    let releaseExcl!: () => void
    const exclHeld = new Promise<void>((r) => { releaseExcl = r })
    const excl = ops.run('gen', '/repo', async () => { await exclHeld; return 'gen' })
    await Promise.resolve()
    expect(ops.repoBusy('/repo')).toBe(true)

    releaseExcl()
    await excl
    expect(ops.repoBusy('/repo')).toBe(false) // exclusive released; shared still running
    releaseShared()
    await shared
  })

  it('cancels one lane without touching the other', async () => {
    const ops = new OperationCoordinator()
    let exclCancelled = false
    let sharedCancelled = false
    const excl = ops.run('gen', '/repo', async () => {
      ops.registerCancel('gen', () => { exclCancelled = true })
      await new Promise((r) => setTimeout(r, 20))
      ops.throwIfCancelled('gen')
      return 'gen'
    })
    const shared = ops.runShared('chat', '/repo', async () => {
      ops.registerCancel('chat', () => { sharedCancelled = true })
      await new Promise((r) => setTimeout(r, 20))
      ops.throwIfCancelled('chat')
      return 'chat'
    })
    await Promise.resolve()
    ops.cancel('chat')
    expect((await shared).status).toBe('cancelled')
    expect(sharedCancelled).toBe(true)
    expect(exclCancelled).toBe(false)
    expect((await excl).status).toBe('succeeded')
  })
})
