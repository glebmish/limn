/** The two resizable panels in the review shell: the guided-review rail (left) and
 *  the chat drawer (right). */
export type PanelKind = 'sidebar' | 'chat'

export interface PanelSpec { default: number; min: number; max: number }

export const PANELS: Record<PanelKind, PanelSpec> = {
  sidebar: { default: 286, min: 220, max: 520 },
  chat: { default: 320, min: 260, max: 640 }
}

/** The main pane (diff / editor) never shrinks below this width, regardless of how
 *  wide the sidebar and chat panels are dragged. */
export const MAIN_MIN = 480

/** Pixels moved per arrow-key resize step. */
export const KEY_STEP = 16

/** The viewport guard (see clampPanelWidth) can push a width below the panel's own
 *  `min`, but never below this — a panel narrower than this is unusable. */
export const HARD_FLOOR = 160

/** Clamp `value` into the panel's [min, max] range, then apply the viewport guard:
 *  the main pane must keep at least MAIN_MIN px, so the panel is further capped to
 *  `viewport - other - MAIN_MIN` (`other` is the other panel's current width, 0 when
 *  it's closed). The guard runs AFTER the range clamp, so it can push the result
 *  below the panel's `min` — but never below HARD_FLOOR. */
export function clampPanelWidth(kind: PanelKind, value: number, viewport: number, other: number): number {
  const spec = PANELS[kind]
  const ranged = Math.min(Math.max(value, spec.min), spec.max)
  const guard = viewport - other - MAIN_MIN
  return Math.max(Math.min(ranged, guard), HARD_FLOOR)
}

/** Parse a stored pref (a JSON string, or undefined when unset) into a clamped
 *  width. Falls back to the panel's default on missing/unparseable/non-finite
 *  input — no viewport is known here, so only the range clamp applies. */
export function parseStoredWidth(kind: PanelKind, raw: string | undefined): number {
  const spec = PANELS[kind]
  if (raw == null) return spec.default
  let value: unknown
  try { value = JSON.parse(raw) } catch { return spec.default }
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default
  return Math.min(Math.max(value, spec.min), spec.max)
}

/** The CSS custom properties the shell sets on its root element for the current
 *  sidebar / chat widths. */
export function panelVars(sidebarWidth: number, chatWidth: number): Record<string, string> {
  return { '--gside-w': `${sidebarWidth}px`, '--chat-w': `${chatWidth}px` }
}
