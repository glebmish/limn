import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import { writeCapabilityFor } from '../src/main/review'

describe('writeCapabilityFor', () => {
  it('distinguishes immutable refs, clean branches, and dirty branches', async () => {
    const fx = makeFixtureRepo()
    expect(await writeCapabilityFor(fx.dir, { kind: 'commit', symbol: 'HEAD', anchorSha: 'a'.repeat(40) }))
      .toMatchObject({ enabled: false, reason: 'not-branch' })

    expect(await writeCapabilityFor(fx.dir, { kind: 'branch', symbol: 'main', anchorSha: 'b'.repeat(40) }))
      .toMatchObject({ enabled: false, reason: 'not-checked-out' })

    expect(await writeCapabilityFor(fx.dir, { kind: 'branch', symbol: 'feature', anchorSha: 'a'.repeat(40) }))
      .toMatchObject({ enabled: true, reason: 'available', workdir: fs.realpathSync(fx.dir) })

    fs.appendFileSync(path.join(fx.dir, 'README.md'), '\ndirty\n')
    expect(await writeCapabilityFor(fx.dir, { kind: 'branch', symbol: 'feature', anchorSha: 'a'.repeat(40) }))
      .toMatchObject({ enabled: false, reason: 'dirty', workdir: fs.realpathSync(fx.dir) })
  })
})
