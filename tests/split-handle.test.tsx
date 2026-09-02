import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SplitHandle, keyDelta } from '../src/renderer/components/SplitHandle'

// Task 2: SplitHandle is the draggable/keyboard-resizable divider between the
// review shell's fixed-width side panels and the main pane. Pinning the a11y
// markup (role/orientation/value bounds/label) and the pure key-delta helper
// that the drag/keyboard handlers share.

const noop = (): void => {}

describe('SplitHandle — markup', () => {
  it('renders the separator role, orientation, value bounds, label and class', () => {
    const out = renderToStaticMarkup(
      <SplitHandle label="Resize sidebar" value={286} min={220} max={520} direction={1} onChange={noop} onCommit={noop} onReset={noop} />
    )
    expect(out).toContain('role="separator"')
    expect(out).toContain('aria-orientation="vertical"')
    expect(out).toContain('aria-valuenow="286"')
    expect(out).toContain('aria-valuemin="220"')
    expect(out).toContain('aria-valuemax="520"')
    expect(out).toContain('aria-label="Resize sidebar"')
    expect(out).toContain('tabindex="0"')
    expect(out).toContain('class="split-handle"')
  })
})

describe('keyDelta — pure key-to-value-delta helper', () => {
  const min = 220
  const max = 520

  it('ArrowRight with direction 1 grows the value by the step', () => {
    expect(keyDelta('ArrowRight', false, 1, 300, min, max)).toBe(316)
  })

  it('ArrowLeft with direction 1 shrinks the value by the step', () => {
    expect(keyDelta('ArrowLeft', false, 1, 300, min, max)).toBe(284)
  })

  it('ArrowRight with direction -1 shrinks the value by the step', () => {
    expect(keyDelta('ArrowRight', false, -1, 300, min, max)).toBe(284)
  })

  it('Shift+ArrowRight with direction 1 grows the value by 4x the step', () => {
    expect(keyDelta('ArrowRight', true, 1, 300, min, max)).toBe(364)
  })

  it('Home jumps to min', () => {
    expect(keyDelta('Home', false, 1, 300, min, max)).toBe(min)
  })

  it('End jumps to max', () => {
    expect(keyDelta('End', false, 1, 300, min, max)).toBe(max)
  })

  it('an unhandled key returns null', () => {
    expect(keyDelta('a', false, 1, 300, min, max)).toBeNull()
  })
})
